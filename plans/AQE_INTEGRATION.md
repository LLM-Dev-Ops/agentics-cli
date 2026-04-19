# AQE Integration Plan — Ecosystem-Level Implementation

| Field | Value |
|-------|-------|
| **Version** | 0.2.0 (supersedes 0.1.0 CLI-centric draft) |
| **Date** | 2026-04-18 |
| **Status** | Proposal — pending ADR and review |
| **Classification** | Internal — Architecture |
| **Upstream** | https://github.com/proffesor-for-testing/agentic-qe |
| **Scope** | Integrate AQE across the 12-phase pipeline at **ecosystem** level, not CLI-embedded |

---

## 0. Correction from v0.1.0

The previous draft proposed AQE as an external MCP server consumed directly by `agentics-cli`. **That is wrong for this ecosystem.** `agentics-cli` is a pure orchestration shell that **exposes** MCP (51 tools, `src/mcp/mcp-server.ts`) and **consumes** capabilities via a registered-domain model:

1. Domains are declared in `docs/ecosystem.graph.json`.
2. Each domain is its own repo, bundled into the CLI via `scripts/bundle-agents.sh` into a `*-agents` npm package.
3. Invocation flows through `src/agents/repo-agent-runner.ts` → either local Claude subprocess (`AGENTICS_LOCAL_AGENTS=true`) or GCP Cloud Function.
4. Every invocation is gated by the 8-gate pipeline (`src/gates/index.ts`), terminating in **Ruvector Acceptance Gate** (exit code 141, blocking, no fallback — `src/gates/ruvector-acceptance-gate.ts:47`).

AQE must conform to this pattern. The CLI does not grow an MCP-consumer surface for this.

---

## 1. Decision: AQE as a New Dedicated Domain

### 1.1 Options Considered

| Option | Description | Verdict |
|--------|-------------|---------|
| **A. New domain `agentic-qe`** | Register AQE as its own infrastructure domain alongside `test-bench`. Expose only AQE's QE-specific agents; exclude agents that overlap with existing domains. | ✅ **Recommended** |
| **B. Extend `test-bench`** | Add AQE as a secondary repo under the existing `test-bench` domain. | ❌ Conflates two products; constrains AQE scope to test-bench's narrower remit |
| **C. Replace `test-bench`** | Deprecate `test-bench` and route all QE through AQE. | ❌ Migration risk + loses existing test-bench functionality we haven't audited |
| **D. MCP-consumer in CLI** | Teach CLI to consume external MCP servers directly. | ❌ New integration pattern that breaks the current clean architecture (ADR-030) |

### 1.2 Domain Boundary Clarifications

AQE's upstream has 60 agents across 13 internal domains. Several overlap with **existing** agentics domains and must NOT be duplicated:

| AQE internal domain | Existing agentics domain | AQE agents to expose? |
|---------------------|--------------------------|----------------------|
| Security (SAST/DAST) | `shield` | ❌ No — Shield owns security |
| Performance profiling | `latency-lens` | ❌ No — Latency-Lens owns perf |
| Enterprise integration (SAP/SOAP) | `connector-hub` + ERP surface | ❌ No — existing boundary must hold (ADR-074) |
| Data privacy/anonymization | `data-vault` | ❌ No |
| Learning system | `memory-graph` | ❌ No |
| **Test generation (unit/integration/property/BDD)** | — | ✅ Yes |
| **Defect intelligence (bug prediction, flaky detection, RCA)** | — | ✅ Yes |
| **Coverage analysis & gap detection** | — | ✅ Yes |
| **Chaos engineering** | — | ✅ Yes (new capability) |
| **Test design & requirements traceability** | — | ✅ Yes |
| **Test execution orchestration** | — | ✅ Yes |
| **Test reporting & observability** | — | ✅ Yes (scoped to QE results) |

**Outcome: AQE exposes ~25-30 QE-specific agents, not all 60.** The Queen Coordinator in AQE's upstream still orchestrates internally, but our domain registration only surfaces the non-overlapping ones.

---

## 2. Integration Architecture

### 2.1 Three-Layer Integration

```
┌───────────────────────────────────────────────────────────────┐
│ Layer 1 — Domain registration                                  │
│   docs/ecosystem.graph.json  (+1 infrastructure entry)        │
│   docs/AGENT_CAPABILITY_REGISTRY.md (bind to phases 3,5,6,8,9,10) │
└───────────────────────────────────────────────────────────────┘
                               │
                               ▼
┌───────────────────────────────────────────────────────────────┐
│ Layer 2 — Adapter repo `agentic-qe`                            │
│   New repo in llm-dev-ops org                                  │
│   Wraps upstream AQE MCP server                                │
│   Exposes agents via agentics HTTP/handler contract            │
│   Bundled as `agentic-qe-agents` npm package                   │
└───────────────────────────────────────────────────────────────┘
                               │
                               ▼
┌───────────────────────────────────────────────────────────────┐
│ Layer 3 — CLI wiring                                           │
│   src/agents/repo-agent-runner.ts   (+2 map entries)          │
│   src/agents/system-prompts.ts      (register ~25 prompts)    │
│   scripts/bundle-agents.sh          (include agentic-qe)      │
└───────────────────────────────────────────────────────────────┘
```

No CLI gate changes. No new pipeline coordinator logic. **Gate pipeline, ruvector lineage, and cost/timing envelopes all work via the existing dispatch path.**

### 2.2 Adapter Repo Design (`agentic-qe`)

**Responsibilities:**
1. Start upstream AQE MCP server as a subprocess (or import if published as npm lib).
2. For each exposed agent, provide an HTTP handler matching the agentics contract:
   ```
   POST /agents/{agentName}
   Body: { query: string, correlation_id: string, context?: object }
   Returns: { status: 200|502, data: object, execution_metadata: object, timing: number }
   ```
3. Translate HTTP request → MCP `tools/call` against upstream AQE → collect response → wrap in agentics envelope.
4. Enforce per-agent timeout caps (default 300s gating, 120s advisory, 60s observational).
5. Emit structured JSON ONLY (satisfies Output Format Gate, `src/gates/index.ts`).
6. Return `correlation_id` in response so downstream Ruvector lineage can stitch spans.

**Repo layout (conventional):**
```
agentic-qe/
├── package.json                 # name: "agentic-qe-agents"
├── src/
│   ├── handlers/                # One file per exposed agent
│   │   ├── test-generation.ts
│   │   ├── coverage-analysis.ts
│   │   ├── defect-intelligence.ts
│   │   ├── flaky-detection.ts
│   │   ├── chaos-engineering.ts
│   │   └── ...
│   ├── mcp-bridge.ts            # Upstream AQE MCP client
│   ├── system-prompts/          # Agent role definitions (agentics convention)
│   └── index.ts                 # Cloud Function entry
├── bundle.json                  # Bundle manifest for agentics-cli
└── README.md
```

**Deployment modes (both required):**
- **Local mode** (`AGENTICS_LOCAL_AGENTS=true`): CLI calls handlers in-process via Claude Code subprocess, same as other domains.
- **Cloud Function mode** (default): Deployed to GCP, CLI calls via HTTPS with auth token.

---

## 3. Concrete File Changes

### 3.1 `docs/ecosystem.graph.json`

Add one infrastructure entry (after line 196, before phase-specific capabilities section):

```json
{
  "name": "quality_engineering",
  "description": "Comprehensive QE fleet — test generation (unit/integration/property/BDD), coverage analysis, defect intelligence, flaky detection, test design, chaos engineering, and root-cause analysis. Wraps AQE upstream.",
  "repos": ["agentic-qe"],
  "agents": [
    "Test Design Agent",
    "Unit Test Generation Agent",
    "Integration Test Generation Agent",
    "Property-Based Test Agent",
    "BDD Test Generation Agent",
    "Coverage Analysis Agent",
    "Coverage Gap Detection Agent",
    "Defect Prediction Agent",
    "Flaky Test Detection Agent",
    "Root Cause Analysis Agent",
    "Requirements Traceability Agent",
    "Chaos Engineering Agent",
    "Test Execution Orchestrator Agent",
    "QE Reporting Agent"
  ],
  "scope": "global",
  "tags": ["qe", "testing", "test-generation", "coverage", "defect-intelligence", "flaky-detection", "chaos", "rca", "traceability", "quality"]
}
```

Then bind to phase capabilities where applicable. Edit phase entries:

- **phase 3 `sparc_generation`** (line 255): add `"Requirements Traceability Agent"`, `"Test Design Agent"` to `optional_agents[]`.
- **phase 5 `adr_ddd_architecture`** (line 290): add `"Defect Prediction Agent"`, `"Test Design Agent"` to `optional_agents[]`.
- **phase 6 `implementation_planning`** (line 310): add `"Coverage Gap Detection Agent"` to `optional_agents[]`.
- **phase 7 `build`** (line 328): add all 4 test generation agents + `"Coverage Analysis Agent"` to `optional_agents[]`.
- **phase 8 `validation`** (line 355): add **all 14 QE agents** to `mandatory_agents[]` — this is the gating phase.
- **phase 9 `integration_mapping`** (line 382): add `"Integration Test Generation Agent"`, `"Chaos Engineering Agent"` to `optional_agents[]`.
- **phase 10 `governance_finops`** (line 403): add `"QE Reporting Agent"` to `optional_agents[]`.

### 3.2 `src/agents/repo-agent-runner.ts`

Add to `FUNCTION_NAMES` (after line 63):
```typescript
'quality-engineering': 'agentic-qe',
```

Add to `BUNDLE_NAMES` (after line 107):
```typescript
'agentic-qe': 'agentic-qe-agents',
```

### 3.3 `src/agents/system-prompts.ts`

Register ~14 agent system prompts following the existing pattern. Each prompt must:
- Declare the agent's role
- Specify the JSON output schema
- Reference the upstream AQE agent being wrapped

### 3.4 `scripts/bundle-agents.sh`

Add `agentic-qe` to the bundle list. Verify the bundle output is `node_modules/@llm-dev-ops/agentic-qe-agents`.

### 3.5 `docs/AGENT_CAPABILITY_REGISTRY.md`

Update Phase 8 (Validation) section to list the QE mandatory agents. Add note: "QE is provided by the `quality_engineering` domain; see `ecosystem.graph.json`."

### 3.6 New ADR

Create `docs/adrs/ADR-PIPELINE-080-quality-engineering-domain.md` documenting:
- Why AQE is a new domain vs. extending test-bench
- The agent-scope boundary (what AQE provides vs. what existing domains own)
- The adapter-repo pattern
- Deferred deprecation of overlapping functions

---

## 4. Phase Integration Modes (per-phase behavior)

The advisory / gating / observational model from v0.1.0 still applies, but is realized via **phase capability registration**, not a new coordinator wrapper.

| Phase | Mode | Mechanism | QE agents invoked |
|-------|------|-----------|-------------------|
| 0 Prompt Structuring | — | Not bound | None |
| 1 Simulation | — | Not bound | None |
| 2 Research | — | Not bound | None |
| 3 SPARC Generation | Advisory | `optional_agents` on phase 3 | Test Design, Requirements Traceability |
| 4 SPARC Handoff | — | Not bound | None |
| 5 ADR/DDD | Advisory | `optional_agents` on phase 5 | Defect Prediction, Test Design |
| 6 Implementation Planning | Advisory | `optional_agents` on phase 6 | Coverage Gap Detection |
| 7 Build | Advisory→Gating | `optional_agents` on phase 7 | 4 test-gen agents, Coverage Analysis |
| 8 Validation | **Gating (mandatory)** | `mandatory_agents` on phase 8 | All 14 QE agents |
| 9 Integration Mapping | Gating | `optional_agents` on phase 9 | Integration Test Gen, Chaos |
| 10 Governance / FinOps | Advisory | `optional_agents` on phase 10 | QE Reporting |
| 11 Decision Packaging | — | Not bound | None |

**How gating works without new coordinator code:**
- `mandatory_agents` must succeed for phase to complete (existing pipeline behavior).
- If any mandatory QE agent returns `status: 502` or fails Ruvector acceptance → phase fails, pipeline halts, exit 141.
- Advisory phases use `optional_agents`, which are invoked but do not block on failure.

**How per-run agent selection works:**
- The existing capability classifier matches user query tags (`qe`, `testing`, `coverage`, etc.) against domain tags in `ecosystem.graph.json`.
- Phase 8 invokes all mandatory QE agents regardless of match (by definition).
- Phases 3, 5, 6, 7, 9, 10 invoke their optional QE agents only if tags match the problem context.

---

## 5. Lineage, Gates, and Cost

### 5.1 Ruvector Lineage (unchanged)

Every QE agent invocation flows through `blockUntilRuvectorAccepts` via the standard dispatch. No special handling needed. Downstream spans from AQE's Queen Coordinator become children of the ruvector root (`src/gates/ruvector-acceptance-gate.ts:112`).

### 5.2 Gate Pipeline (unchanged)

All 8 gates apply: Execution → Auth Session → Service Health → Output Format → Argument Guard → Lineage → Readiness → Ruvector Acceptance. The adapter's JSON-only responses satisfy Output Format Gate. Service Health Gate monitors the AQE cloud function's health endpoint.

### 5.3 Cost Envelope

No per-phase budget wrapper in the CLI. Budget is enforced at the adapter level:
- Per-agent timeout (AbortController at the MCP bridge)
- Token caps passed via AQE's TinyDancer routing (Haiku for simple, Sonnet for moderate, Opus for critical)
- Cost attribution via `correlation_id` → ruvector span → existing cost tracking

**Target:** ≤$8 added per pipeline run, ≤15 min added wall-clock (same targets as v0.1.0, just realized differently).

---

## 6. Rollout Plan

### Week 1 — Adapter Scaffold
- Create `agentic-qe` repo in llm-dev-ops org.
- Scaffold Cloud Function + HTTP handler skeleton matching connector-hub repo shape.
- Integrate upstream AQE as MCP subprocess; verify manual handler → MCP call → JSON response path.
- Deploy to GCP dev environment.

### Week 2 — Domain Registration (Observational)
- Add `quality_engineering` entry to `ecosystem.graph.json` with all 14 agents.
- Wire `repo-agent-runner.ts` + `system-prompts.ts`.
- **No phase bindings yet** — observational only. Agents are invokable via `agentics agents invoke quality-engineering <agent>` but not auto-invoked.
- Run 20+ smoke tests through the full gate pipeline to verify lineage, timing, cost attribution.

### Week 3 — Advisory Upstream
- Bind QE agents to phases 3, 5, 6 as `optional_agents`.
- Monitor FP rate and advisory output signal quality for 7 days.
- Shadow mode: log what QE would flag at phase 8, don't gate yet.

### Week 4 — Gating at Validation
- Promote phase 8 bindings to `mandatory_agents`.
- Enable gating: phase 8 failure halts pipeline.
- **Kill-switch:** `AGENTICS_QE_GATING=off` env var reverts to advisory for the run.

### Week 5 — Gating at Integration
- Bind QE agents to phase 9 (Integration Test Gen, Chaos) as `optional_agents`.
- Promote to `mandatory_agents` after 7-day observation.

### Week 6 — Phase 7 Build Integration
- Bind test generation agents to phase 7 as `optional_agents`.
- Monitor generated test quality and re-run rate.

### Week 7 — ADR and Documentation
- Finalize `ADR-PIPELINE-080`.
- Update `AGENT_CAPABILITY_REGISTRY.md` with Phase 8 mandatory QE agents.
- Deprecation review: which existing test-bench agents are subsumed by AQE?

---

## 7. Open Questions

1. **`test-bench` status.** The `test-bench` domain exists in `src/agents/repo-agent-runner.ts:37` but is NOT in `docs/ecosystem.graph.json` infrastructure list. This inconsistency needs resolution before AQE integration. **Action:** audit test-bench's current capabilities; decide overlap with AQE.

2. **AQE upstream license compatibility.** Check AQE's license (MIT, Apache, proprietary?) against the llm-dev-ops licensing model (`UNLICENSED` per `package.json:42`).

3. **Vendoring vs. live MCP subprocess.** Does AQE publish an npm package, or must we vendor it? Affects adapter complexity and update cadence.

4. **Queen Coordinator surface.** AQE's upstream has a Queen that orchestrates its 60 internal agents. Do we call the Queen once per phase (Queen picks sub-agents), or do we enumerate ~14 leaf handlers? **Recommendation:** enumerate leaf handlers — keeps us decoupled from AQE's orchestration changes and matches the "one repo agent = one CLI agent" convention.

5. **Cloud Function cold-start budget.** AQE MCP server may be heavy; GCP cold start + MCP init could exceed 30s. Needs performance validation before phase 8 gating.

6. **ERP boundary enforcement.** AQE's "Enterprise Integration" agents (SAP/SOAP) must NOT be exposed — ADR-074 says only ERP-Surface talks to enterprise systems. Need a hard check in the adapter that these agents are unregisterable.

7. **Cross-phase learning persistence.** AQE's upstream has a learning system across runs. Our ecosystem already has `memory-graph` for this. Does AQE's learning write to memory-graph, or maintain its own store? **Recommendation:** route through memory-graph; the adapter discards AQE's internal persistence.

---

## 8. Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| Adapter becomes stale relative to AQE upstream | Medium | CI job pins upstream SHA; weekly rebase automation |
| AQE false positives halt pipeline at phase 8 | **High** | Week 2 observational phase measures FP rate; gating only after <5% FP measured; kill-switch env var |
| Cost overrun from 14 agents on every phase-8 run | Medium | Per-agent timeout + TinyDancer model routing; weekly cost review |
| Ruvector acceptance fails for AQE spans (payload shape mismatch) | **High** | Adapter test suite must include ruvector round-trip tests before week 2 promotion |
| ERP surface boundary violation via AQE enterprise agents | **High** | Hard-coded blocklist in adapter; reject registration at bundle build time |
| AQE upstream abandons project | Low-Medium | Adapter repo owns the interface; we can fork upstream if needed |
| Test-bench and AQE overlap creates user confusion | Medium | ADR-080 declares scope; deprecation schedule for overlapping test-bench agents |

---

## 9. Success Criteria (Day 90)

- `quality_engineering` domain live in production `ecosystem.graph.json`.
- Phase 8 (Validation) gates on AQE mandatory agents with measured <5% FP rate.
- Phases 3, 5, 6, 7, 9 have advisory QE integration.
- Ruvector lineage covers 100% of QE invocations (verified via graph inspection).
- Zero ERP-surface boundary violations (verified via policy audit).
- Per-run added cost ≤$8 and wall-clock ≤15 min.
- ADR-PIPELINE-080 approved and merged.

If criteria miss: regress phase 8 to advisory, preserve phase 3/5/6/7/9 bindings, investigate via incident-manager workflow.

---

## 10. What Does NOT Change

- `src/pipeline/pipeline-coordinator.ts` — zero changes.
- `src/gates/*.ts` — zero changes.
- `src/mcp/mcp-server.ts` — zero changes (CLI remains MCP-exposer, not MCP-consumer).
- Existing domain agents — zero changes.
- Gate pipeline order or exit codes — unchanged.
- Ruvector acceptance contract — unchanged.

This integration is **purely additive at the ecosystem layer**. The CLI's architecture stays clean.
