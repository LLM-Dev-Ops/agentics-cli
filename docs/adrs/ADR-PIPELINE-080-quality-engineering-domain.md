# ADR-PIPELINE-080: Quality Engineering Domain Registration (AQE)

**Status:** Proposed
**Date:** 2026-04-18
**Priority:** HIGH — Pipeline quality foundation
**Originating Review:** AQE Integration Planning (plans/AQE_INTEGRATION.md)
**Builds on:** ADR-030 (Ecosystem Capability Graph), ADR-031 (Capability Graph Evolution), ADR-074 (Pipeline Must Use Platform Services)
**Supersedes:** None

## Context

We need to integrate the Agentic QE (AQE) platform — an upstream open-source QE fleet with 60 agents across 13 internal domains (github.com/proffesor-for-testing/agentic-qe) — into the Agentics pipeline. An initial CLI-centric integration proposal was rejected because it violated the ecosystem's registered-domain architecture:

1. `agentics-cli` is a pure orchestration shell that **exposes** MCP via `src/mcp/mcp-server.ts` (51 tools) but **does not consume** external MCP servers.
2. All pipeline capabilities flow through the registered-domain dispatch in `src/agents/repo-agent-runner.ts`, backed by `docs/ecosystem.graph.json`.
3. Every invocation must satisfy the 8-gate pipeline (`src/gates/index.ts`), terminating in the blocking Ruvector Acceptance Gate (`src/gates/ruvector-acceptance-gate.ts:47`, exit 141).

Teaching the CLI to consume external MCP servers would fork the integration architecture for a single upstream product. That is the wrong trade.

The alternative — embedding AQE-specific logic in the CLI — violates the architectural boundary in `docs/AGENT_CAPABILITY_REGISTRY.md:32` (Agentics Platform → Implementation Build → Integration Connectors → ERP Surface → Enterprise ERPs). The CLI owns orchestration; domain repos own capability.

AQE must therefore be registered as a domain the same way `shield`, `observatory`, `sentinel`, etc. are registered.

## Decision

### 1. Register AQE as a New Global Infrastructure Domain

Add a new entry to the `infrastructure[]` array in `docs/ecosystem.graph.json`, positioned with the other global domains (scope: `"global"`, available to all 12 phases):

```json
{
  "name": "quality_engineering",
  "description": "Comprehensive QE fleet — test generation (unit/integration/property/BDD), coverage analysis, defect intelligence, flaky detection, test design, chaos engineering, and root-cause analysis. Wraps AQE upstream via adapter repo.",
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

The domain name `quality_engineering` (with underscore) matches the existing graph convention. The runner key `quality-engineering` (with hyphen) matches the existing runner convention in `src/agents/repo-agent-runner.ts:35-76`.

The exposed agent set is intentionally **a strict subset of AQE upstream's 60 agents**. The scope boundary and exclusion list are specified in ADR-PIPELINE-082.

### 2. Wire the CLI Dispatch Layer

`src/agents/repo-agent-runner.ts` gets two map entries:

```typescript
// FUNCTION_NAMES (after line 63)
'quality-engineering': 'agentic-qe',

// BUNDLE_NAMES (after line 107)
'agentic-qe': 'agentic-qe-agents',
```

`src/agents/system-prompts.ts` registers one system prompt per exposed agent (14 total), following the existing pattern. Each prompt:
- Declares the agent's role
- Specifies the JSON output schema
- Names the upstream AQE agent being wrapped

### 3. Bundling

`scripts/bundle-agents.sh` adds `agentic-qe` to its domain list. The bundle output is the npm package `@llm-dev-ops/agentic-qe-agents`, matching the `*-agents` suffix convention.

### 4. The Domain Repo Itself

The `agentic-qe` repo is a thin adapter that wraps the upstream AQE MCP server. Its design is the subject of ADR-PIPELINE-081; this ADR only declares that such a repo exists and satisfies the agentics agent-runner contract.

### 5. No New CLI Gates

The existing 8-gate pipeline applies unchanged. QE invocations:
- Participate in Ruvector acceptance via the standard dispatch (spans become children of the ruvector root per `src/gates/ruvector-acceptance-gate.ts:180`)
- Return JSON envelopes satisfying the Output Format Gate
- Emit correlation IDs for lineage stitching

No new gate files are introduced. No `src/pipeline/pipeline-coordinator.ts` changes.

### 6. No MCP-Consumer Surface in the CLI

The CLI's decision to *expose* MCP and not *consume* it is reaffirmed. External MCP-based products are wrapped by adapter repos per ADR-PIPELINE-081. This keeps `src/mcp/mcp-server.ts` as a one-directional surface.

## Implementation

1. Edit `docs/ecosystem.graph.json` — insert the `quality_engineering` entry in `infrastructure[]` after `data_security` (line 187, before the phase-specific capabilities block).
2. Edit `src/agents/repo-agent-runner.ts` — add the two map entries per decision §2.
3. Create `src/agents/system-prompts.ts` entries for the 14 exposed agents.
4. Edit `scripts/bundle-agents.sh` — add `agentic-qe` to the bundle list.
5. Update `docs/AGENT_CAPABILITY_REGISTRY.md` — add a Global Infrastructure Domains reference row for QE; phase-specific bindings are updated per ADR-PIPELINE-083.
6. The `agentic-qe` adapter repo is created per ADR-PIPELINE-081 (separate work item).
7. Unit test `tests/unit/agents/repo-agent-runner-qe-080.test.ts` asserts:
   - `hasRepoAgent('quality-engineering')` returns `true`
   - `FUNCTION_NAMES['quality-engineering']` resolves to `'agentic-qe'`
   - `BUNDLE_NAMES['agentic-qe']` resolves to `'agentic-qe-agents'`

## Acceptance Criteria

1. `jq '.infrastructure[] | select(.name=="quality_engineering")' docs/ecosystem.graph.json` returns the declared domain entry.
2. `agentics agents list` surfaces the 14 QE agents under domain `quality-engineering`.
3. `agentics agents invoke quality-engineering test-design '{"text":"..."}'` round-trips through the 8-gate pipeline with Ruvector acceptance.
4. `grep -n "quality-engineering" src/agents/repo-agent-runner.ts` returns at least one match in FUNCTION_NAMES.
5. `npm run bundle-agents` produces `node_modules/@llm-dev-ops/agentic-qe-agents` (or the pre-publish equivalent).
6. No changes to `src/pipeline/pipeline-coordinator.ts`, `src/gates/*.ts`, or `src/mcp/mcp-server.ts` are required for this ADR.

## Consequences

### Positive

- AQE integrates as a first-class domain, identical in shape to `shield`, `observatory`, etc. — predictable to operate, maintain, and extend.
- Zero coupling between CLI internals and upstream AQE's MCP surface. Upstream API changes are absorbed in the adapter repo.
- The 8-gate pipeline, Ruvector lineage, correlation IDs, cost tracking, and local-vs-cloud dispatch all work automatically.
- Establishes the precedent for integrating other external MCP-based products in the future (see ADR-PIPELINE-081).

### Negative

- Introduces a new repo (`agentic-qe`) to maintain and pin upstream SHAs against.
- Expands the ecosystem's global infrastructure domain count from 14 to 15; capability classifier must tokenize new tags.
- The 14-agent exposed set is smaller than AQE's 60-agent internal capacity; we forego some functionality (justified in ADR-PIPELINE-082).

### Neutral

- AQE upstream's "Queen Coordinator" still operates inside the adapter; we enumerate leaf handlers on our side. Cost trade: decouples us from AQE orchestration changes, at the cost of losing the Queen's task decomposition heuristics.

## Related

- **ADR-PIPELINE-081** (Adapter Repo Pattern for Upstream MCP Capabilities) — specifies the adapter repo shape
- **ADR-PIPELINE-082** (AQE Agent Scope Boundary) — specifies the exposed-vs-excluded agent list
- **ADR-PIPELINE-083** (Phase Capability Binding for QE) — specifies where QE agents bind into the 12-phase pipeline
- **ADR-PIPELINE-084** (Observational-First Rollout Policy) — specifies the promotion path from observational to gating
- **ADR-PIPELINE-085** (test-bench and quality_engineering Coexistence) — resolves ecosystem graph inconsistency
- **ADR-PIPELINE-086** (QE Kill-Switch and Gating Regression) — operational policy for mandatory QE failures
- **ADR-030** (Ecosystem Capability Graph) — the registration schema this ADR extends
- **ADR-074** (Pipeline Must Use Platform Services) — architectural layering this ADR preserves
- **plans/AQE_INTEGRATION.md** (v0.2.0) — source plan document
