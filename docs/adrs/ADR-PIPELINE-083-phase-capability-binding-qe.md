# ADR-PIPELINE-083: Phase Capability Binding for Quality Engineering

**Status:** Proposed
**Date:** 2026-04-18
**Priority:** HIGH — Wires QE into the 12-phase pipeline
**Originating Review:** AQE Integration Planning (plans/AQE_INTEGRATION.md §4)
**Builds on:** ADR-PIPELINE-080 (QE Domain Registration), ADR-PIPELINE-082 (Agent Scope Boundary), ADR-PIPELINE-061 (Domain-Adaptive Phase Gates)

## Context

`ADR-PIPELINE-080` registers the `quality_engineering` domain but does not specify where its 14 agents plug into the 12-phase mandatory execution pipeline (`docs/AGENT_CAPABILITY_REGISTRY.md`). Without explicit phase bindings, QE agents would only be invokable ad-hoc via `agentics agents invoke`, defeating the shift-left integration goal.

The 12 phases from `docs/ecosystem.graph.json` (lines 200-426) each declare `mandatory_agents[]` (always run) and `optional_agents[]` (matched to problem context via tags). We need to:

1. Decide which phases QE binds to.
2. Decide the binding mode per phase (mandatory vs. optional).
3. Realize the advisory/gating tiers from the integration plan via the existing `mandatory_agents`/`optional_agents` mechanism — without inventing a parallel tiering system inside the CLI.

The advisory/gating distinction maps cleanly to optional/mandatory:
- **Optional** agents run if the problem context matches their tags; failures are logged but non-blocking. = Advisory mode.
- **Mandatory** agents always run; failures halt phase completion and fail the pipeline with exit 141 (via Ruvector Acceptance Gate). = Gating mode.
- **Observational** is expressed as "not bound to any phase; invokable only on-demand" — the default for a registered domain.

## Decision

### 1. Phase Binding Table

| Phase | QE binding mode | QE agents bound | Rationale |
|-------|-----------------|-----------------|-----------|
| 0 Prompt Structuring | None | — | Document generation; nothing to test |
| 1 Simulation | None | — | Scenario-level; nothing to test |
| 2 Research | None | — | Document generation; nothing to test |
| 3 SPARC Generation | `optional_agents` (advisory) | Test Design Agent, Requirements Traceability Agent | Review specs for testability and trace to requirements as SPARC docs emerge |
| 4 SPARC Handoff | None | — | Deterministic merge; nothing to test |
| 5 ADR / DDD Architecture | `optional_agents` (advisory) | Defect Prediction Agent, Test Design Agent | Predict risk hotspots from architectural decisions; propose test strategies for each bounded context |
| 6 Implementation Planning | `optional_agents` (advisory) | Coverage Gap Detection Agent | Identify planned work with no test coverage path before code generation |
| 7 Build | `optional_agents` (advisory) | Unit Test Gen, Integration Test Gen, Property-Based Test Gen, BDD Test Gen, Coverage Analysis Agent | Generate tests alongside code; report coverage as build proceeds |
| 8 Validation | **`mandatory_agents` (gating)** | All 14 QE agents | Home turf — this phase is defined as quality validation |
| 9 Integration Mapping | `optional_agents` (advisory→gating) | Integration Test Gen, Chaos Engineering Agent | Integration tests and fault injection for connector wiring |
| 10 Governance / FinOps | `optional_agents` (advisory) | QE Reporting Agent | Emit QE metrics (test count, coverage %, flaky rate) for governance review |
| 11 Decision Packaging | None | — | Executive packaging; QE metrics already surfaced in phase 10 |

### 2. Phase 8 (Validation) Is the Anchor

Phase 8 gets all 14 QE agents as `mandatory_agents`. This is the single gating anchor. Rationale:
- Phase 8 is already declared as the validation phase in `AGENT_CAPABILITY_REGISTRY.md`.
- Centralizing gating simplifies the kill-switch semantics (ADR-PIPELINE-086): disabling gating means bypassing phase 8's mandatory QE, not editing seven phase entries.
- Upstream phases (3, 5, 6, 7) surface problems early as advisory; downstream gating at 8 enforces.

### 3. Phase 9 Promotion Path

Phase 9 (Integration Mapping) starts with `optional_agents` binding for Integration Test Gen and Chaos Engineering. After 30 days of measured <5% false-positive rate (per ADR-PIPELINE-084), these are promoted to `mandatory_agents`.

The promotion is a schema-only change to `ecosystem.graph.json` — no CLI code changes, no gate additions.

### 4. Tag-Based Activation for Optional Bindings

Optional QE agents are activated by the capability classifier matching problem tags against domain tags declared in `ecosystem.graph.json`. The relevant tag set is declared in ADR-PIPELINE-080 §1:

```
["qe", "testing", "test-generation", "coverage", "defect-intelligence", "flaky-detection", "chaos", "rca", "traceability", "quality"]
```

For optional QE agents to activate on phases 3, 5, 6, 7, 9, 10, the user's problem must surface at least one matching tag during Phase 0 Prompt Structuring (Intent Classifier Agent). If no tags match, optional QE agents do not invoke — this is intentional; not every pipeline run needs QE advice at every phase.

### 5. Mandatory Phase 8 Runs Regardless of Tags

Phase 8 `mandatory_agents` invoke on every pipeline run, tag matching notwithstanding. The pipeline by definition produces artifacts that need validation; skipping phase 8 QE is not an option available to the user during normal operation. The only way to bypass is the kill-switch (ADR-PIPELINE-086).

### 6. Concrete ecosystem.graph.json Edits

Edits to existing phase-specific capability entries (line references are to the current file):

- **Line 255 (phase 3 sparc_generation)** — append to `optional_agents[]`:
  ```json
  "Test Design Agent",
  "Requirements Traceability Agent"
  ```
- **Line 290 (phase 5 adr_ddd_architecture)** — append to `optional_agents[]`:
  ```json
  "Defect Prediction Agent",
  "Test Design Agent"
  ```
- **Line 310 (phase 6 implementation_planning)** — append to `optional_agents[]`:
  ```json
  "Coverage Gap Detection Agent"
  ```
- **Line 328 (phase 7 build)** — append to `optional_agents[]`:
  ```json
  "Unit Test Generation Agent",
  "Integration Test Generation Agent",
  "Property-Based Test Agent",
  "BDD Test Generation Agent",
  "Coverage Analysis Agent"
  ```
- **Line 355 (phase 8 validation)** — append to `mandatory_agents[]`:
  ```json
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
  ```
- **Line 382 (phase 9 integration_mapping)** — append to `optional_agents[]`:
  ```json
  "Integration Test Generation Agent",
  "Chaos Engineering Agent"
  ```
- **Line 403 (phase 10 governance_finops)** — append to `optional_agents[]`:
  ```json
  "QE Reporting Agent"
  ```

### 7. Phase 7 Generated Test Artifacts

Phase 7 (Build) generated tests are persisted to the `tests/` directory alongside generated code. The adapter's Unit Test Gen handler writes directly to the correct path via the existing file-writing convention in `src/pipeline/phase5-build/`. Ruvector lineage captures the write as a downstream span under the ruvector-service root.

### 8. Phase 8 Failure Semantics

If any mandatory QE agent returns `status: 502` at phase 8:
1. Phase 8 completes with status `failed`.
2. Pipeline coordinator (`src/pipeline/pipeline-coordinator.ts:94`) halts.
3. Exit code 141 via Ruvector Acceptance Gate.
4. `VALIDATION_REPORT.md` is still produced, populated with whichever QE agents succeeded plus a failure summary for those that did not.
5. Incident triggers per ADR-PIPELINE-086.

## Implementation

1. Edit `docs/ecosystem.graph.json` per §6 (8 phase-entry updates).
2. Update `docs/AGENT_CAPABILITY_REGISTRY.md`:
   - Phase 3, 5, 6, 7, 9, 10 — add QE agents to their optional agent tables
   - Phase 8 — add all 14 QE agents to the mandatory agent table; update the "Output" attribute to note QE-sourced findings
3. Ensure the capability classifier in `src/commands/ask.ts` tokenizes QE tags from the graph; validate via smoke test.
4. Update `src/pipeline/phase5-build/` test-artifact writer to accept QE-generated tests from phase 7 bindings (if a new writer path is needed; otherwise reuse existing).
5. Integration test `tests/integration/pipeline/phase-bindings-qe-083.test.ts` asserts:
   - Phase 8 mandatory QE failure halts pipeline with exit 141
   - Phase 3/5/6/7/9/10 optional QE agents invoke only when problem tags match
   - Generated tests from phase 7 appear in `tests/` under the right directory
6. Update `docs/pipeline.phases.md` with a one-line note per affected phase: "QE optional/mandatory via quality_engineering domain".

## Acceptance Criteria

1. `jq '.capabilities[] | select(.name=="validation").mandatory_agents' docs/ecosystem.graph.json` returns all 14 QE agents.
2. A pipeline run with a query containing "coverage" (tag match) activates `Coverage Gap Detection Agent` at phase 6 and `Coverage Analysis Agent` at phase 7.
3. A pipeline run with a query containing no QE tags still invokes all 14 mandatory QE agents at phase 8.
4. Deliberately failing a mandatory QE agent at phase 8 halts the pipeline with exit 141 and produces a partial `VALIDATION_REPORT.md`.
5. Phase 7-generated tests appear in the expected `tests/` subdirectories with correct naming.
6. `docs/AGENT_CAPABILITY_REGISTRY.md` Phase 8 section lists all 14 mandatory QE agents with their roles.
7. No phase other than 8 has QE agents in `mandatory_agents[]` at initial rollout.

## Consequences

### Positive

- Shift-left integration achieved via four advisory bindings (phases 3, 5, 6, 7) that surface problems before code exists.
- Single gating anchor (phase 8) keeps kill-switch semantics simple.
- The existing `mandatory_agents`/`optional_agents` mechanism absorbs the advisory/gating tiering — no parallel tiering system, no new coordinator code.
- Tag-based activation keeps upstream advisory from firing on every run, controlling cost.

### Negative

- Adds ~14 optional invocations across phases 3-10 for QE-tagged runs. Cost envelope ≤$8 per run (target in ADR-PIPELINE-080); measured in rollout.
- Phase 8 now has a significantly larger mandatory agent set. If any of the 14 has stability issues, phase 8 becomes the pipeline's weakest link. Mitigated by ADR-PIPELINE-086 kill-switch and ADR-PIPELINE-084 rollout policy.
- Phase 7 generated tests compete for filesystem namespace with pre-existing tests. Requires test-writer to handle conflicts gracefully (overwrite? append? skip?). Decision deferred to phase-7 implementation; current default is "skip if file exists, log warning".

### Neutral

- Phases 0, 1, 2, 4, 11 get no QE binding. Intentional — nothing to test, or metrics already surfaced upstream.

## Related

- **ADR-PIPELINE-080** (QE Domain Registration) — the domain this ADR binds
- **ADR-PIPELINE-082** (Agent Scope Boundary) — the 14-agent exposed set this ADR distributes across phases
- **ADR-PIPELINE-084** (Observational-First Rollout) — the promotion path from advisory to gating
- **ADR-PIPELINE-086** (Kill-Switch and Gating Regression) — what happens when phase 8 QE fails at scale
- **ADR-PIPELINE-061** (Domain-Adaptive Phase Gates) — sister ADR on per-phase criteria customization
- **ADR-030** (Ecosystem Capability Graph) — the schema this ADR edits
- **plans/AQE_INTEGRATION.md** §4 — source design
