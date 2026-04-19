# ADR-PIPELINE-082: AQE Agent Scope Boundary and Overlap Resolution

**Status:** Proposed
**Date:** 2026-04-18
**Priority:** HIGH — Prevents duplicate capability and architectural boundary violations
**Originating Review:** AQE Integration Planning (plans/AQE_INTEGRATION.md §1.2)
**Builds on:** ADR-PIPELINE-080 (QE Domain Registration), ADR-PIPELINE-081 (Adapter Repo Pattern), ADR-074 (Pipeline Must Use Platform Services)

## Context

Upstream AQE ships 60 agents organized into 13 internal domains. If we naively expose all 60 through our `quality_engineering` domain, we create three problems:

1. **Capability duplication.** AQE has agents for security scanning (SAST/DAST), performance profiling, enterprise integration (SAP/SOAP), data anonymization, and cross-session learning. Our ecosystem already has dedicated domains for each: `shield`, `latency-lens`, `connector-hub`/ERP-Surface, `data-vault`, `memory-graph`. Two competing implementations for the same capability lead to inconsistent results, duplicate cost, and routing ambiguity.

2. **ERP boundary violation.** AQE's enterprise-integration agents talk directly to SAP/SOAP/middleware. ADR-074 mandates that **only** ERP-Surface communicates with enterprise systems. Exposing AQE's enterprise agents would route around the only-sanctioned path.

3. **Security-policy divergence.** `shield` is the ecosystem's security single source of truth (prompt injection, PII, secrets, credential exposure). AQE's security agents use different rules, different thresholds, and different taxonomies. Two security verdicts for the same artifact is an audit nightmare.

We need an explicit, enforced scope boundary.

## Decision

### 1. Domain Ownership Map

| Capability area | Owner domain | AQE agents EXCLUDED |
|-----------------|-------------|---------------------|
| Security (SAST/DAST, vulnerability scanning, compliance) | `shield` | `Security-SAST`, `Security-DAST`, `Security-Compliance`, `Security-Vulnerability-Scanner` |
| Performance profiling, latency analysis, cold-start | `latency-lens` | `Performance-Profiler`, `Latency-Analyzer`, `Cold-Start-Monitor` |
| Enterprise integration (SAP, SOAP, middleware, OData) | `connector-hub` + ERP-Surface | `SAP-Integration-Tester`, `SOAP-Validator`, `Middleware-Tester`, `OData-Validator` |
| Data privacy, anonymization, PII handling | `data-vault` | `Data-Anonymizer`, `PII-Redactor`, `Privacy-Auditor` |
| Cross-session / cross-project learning | `memory-graph` | `AQE-Learning-Orchestrator`, `Pattern-Memory-Agent` |
| Test generation (unit/integration/property/BDD) | **`quality_engineering`** | — (exposed) |
| Coverage analysis and gap detection | **`quality_engineering`** | — (exposed) |
| Defect prediction, flaky detection, RCA | **`quality_engineering`** | — (exposed) |
| Requirements traceability | **`quality_engineering`** | — (exposed) |
| Chaos engineering | **`quality_engineering`** | — (exposed) |
| Test execution orchestration (running generated tests) | **`quality_engineering`** | — (exposed) |
| QE reporting (test results, coverage deltas, flake trends) | **`quality_engineering`** | — (exposed) |
| Test design and testability review | **`quality_engineering`** | — (exposed) |

### 2. Exposed Agent Set (14)

The `quality_engineering` domain exposes exactly these 14 agents via the `agentic-qe` adapter repo:

1. Test Design Agent
2. Unit Test Generation Agent
3. Integration Test Generation Agent
4. Property-Based Test Agent
5. BDD Test Generation Agent
6. Coverage Analysis Agent
7. Coverage Gap Detection Agent
8. Defect Prediction Agent
9. Flaky Test Detection Agent
10. Root Cause Analysis Agent
11. Requirements Traceability Agent
12. Chaos Engineering Agent
13. Test Execution Orchestrator Agent
14. QE Reporting Agent

Upstream AQE internally has ~60 agents. The other ~46 either (a) are covered by the exclusion table in §1, or (b) are upstream-only utility agents not worth surfacing (e.g., internal schedulers, queue managers, result caches).

### 3. Exclusion Enforcement

The exclusion list is a first-class artifact in the `agentic-qe` adapter repo:

```typescript
// agentic-qe/src/excluded-agents.ts
export const EXCLUDED_UPSTREAM_AGENTS: ReadonlyArray<string> = [
  'Security-SAST',
  'Security-DAST',
  'Security-Compliance',
  'Security-Vulnerability-Scanner',
  'Performance-Profiler',
  'Latency-Analyzer',
  'Cold-Start-Monitor',
  'SAP-Integration-Tester',
  'SOAP-Validator',
  'Middleware-Tester',
  'OData-Validator',
  'Data-Anonymizer',
  'PII-Redactor',
  'Privacy-Auditor',
  'AQE-Learning-Orchestrator',
  'Pattern-Memory-Agent',
  // ... any future additions
] as const;
```

Build-time enforcement (in `agentic-qe/scripts/validate-bundle.ts`, run pre-publish and in CI):
1. Enumerate all handlers in `src/handlers/`.
2. For each handler, read the declared upstream MCP tool name.
3. Fail the build if any handler references a tool in `EXCLUDED_UPSTREAM_AGENTS`.
4. Additionally, cross-check against the upstream AQE tool list: if the upstream adds a new tool that pattern-matches an excluded category (regex: `/^(Security-|SAP-|SOAP-|Privacy-)/`), the bundle fails with a prompt to update the exclusion list.

Runtime enforcement: the adapter's `mcp-bridge.ts` refuses `tools/call` requests against excluded tool names, returning `status: 502, data.error: "EXCLUDED_AGENT"`.

### 4. Domain Routing Rules

Capability classifier updates (`agentics ask` matcher):
- A query containing "security test", "SAST", "DAST", "vulnerability" routes to `shield` — not to `quality_engineering`.
- A query containing "performance test" or "load test" routes to `latency-lens` (for profiling) and optionally `quality_engineering` (for chaos-driven perf testing). The two are complementary — perf profiling measures; chaos stresses.
- A query containing "SAP test", "integration test with Oracle", etc., routes to `connector-hub` for the surface, and `quality_engineering` for test generation *of* the connector — never directly to AQE's SAP agent.

Tag ordering in the ecosystem graph is how we break ties: `shield` wins security keywords; `latency-lens` wins performance keywords; `quality_engineering` wins testing keywords.

### 5. Future Overlap Reviews

Whenever AQE upstream adds a new agent, the adapter owner performs an **overlap review**:
1. List the new agent's declared capability.
2. Identify any existing ecosystem domain that covers the capability.
3. If overlap exists: add to exclusion list; document rationale in `agentic-qe/docs/overlap-reviews/`.
4. If no overlap: add to exposed set; update `ecosystem.graph.json` and ADR-PIPELINE-080's agent list.

The weekly rebase automation (ADR-PIPELINE-081 §5) triggers this review when upstream tool list changes.

## Implementation

1. Create `agentic-qe/src/excluded-agents.ts` with the 16-entry initial list from §3.
2. Create `agentic-qe/scripts/validate-bundle.ts` implementing build-time enforcement.
3. Add validation invocation to `agentic-qe/package.json` under the `prepublishOnly` script.
4. Implement runtime guard in `agentic-qe/src/mcp-bridge.ts` per §3.
5. Update `docs/AGENT_CAPABILITY_REGISTRY.md` with the capability ownership map from §1.
6. Update the capability classifier in `src/commands/ask.ts` (or equivalent) with routing rules from §4.
7. Unit tests:
   - `agentic-qe/tests/unit/excluded-agents.test.ts` — asserts every excluded agent is rejected by the runtime guard
   - `agentic-qe/tests/unit/overlap-review.test.ts` — asserts the regex auto-flag triggers on synthetic new tools matching excluded patterns
8. Create `agentic-qe/docs/overlap-reviews/template.md` for future reviews.

## Acceptance Criteria

1. `agentic-qe` adapter repo has an `EXCLUDED_UPSTREAM_AGENTS` array with at least 16 entries covering the 5 domain categories in §1.
2. A deliberately-introduced handler referencing `Security-SAST` fails `npm run build` with a clear error message pointing to the overlap with `shield`.
3. `agentics agents invoke quality-engineering security-sast '{"text":"..."}'` returns `status: 502 EXCLUDED_AGENT` (or equivalent `404`-style rejection).
4. A query "scan for security vulnerabilities" routes to `shield`, not `quality_engineering`, per the capability classifier.
5. A query "generate unit tests" routes to `quality_engineering`.
6. A query "test our SAP integration" routes to `connector-hub` first (integration surface), with `quality_engineering` contributing only the test-generation portion.
7. `docs/AGENT_CAPABILITY_REGISTRY.md` contains the capability ownership map and is referenced by the capability classifier code.

## Consequences

### Positive

- Single source of truth per capability area. No conflicting security verdicts. No two answers to "how fast is this?"
- ERP boundary (ADR-074) remains inviolable — AQE's enterprise agents are hard-blocked from registration.
- Exclusion is enforced at build AND runtime; accidental exposure is caught early and defenses are layered.
- Overlap review process ensures the boundary stays principled as upstream evolves.

### Negative

- We leave ~46 of AQE's 60 agents unexposed. Some have legitimate QE value we forgo (e.g., AQE's own learning system — but `memory-graph` serves that role ecosystem-wide).
- Overlap review is human work. Weekly rebase surfaces candidates but final judgment is manual.
- Users familiar with AQE upstream will notice the exposed set is narrower and may request re-exposure. Requires clear documentation of the rationale.

### Neutral

- AQE upstream's internal Queen Coordinator can still use the full 60-agent set internally during tool execution — but only through the 14 exposed entry points. We do not mandate upstream refactoring.

## Related

- **ADR-PIPELINE-080** (QE Domain Registration) — declares the exposed agent list this ADR governs
- **ADR-PIPELINE-081** (Adapter Repo Pattern) — defines the exclusion-list enforcement mechanism
- **ADR-PIPELINE-085** (test-bench and quality_engineering Coexistence) — handles a related overlap inside our own ecosystem
- **ADR-074** (Pipeline Must Use Platform Services) — the ERP boundary this ADR enforces for AQE
- **ADR-030** (Ecosystem Capability Graph) — the domain routing model
- **plans/AQE_INTEGRATION.md** §1.2 — source analysis
