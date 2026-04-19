# ADR-PIPELINE-085: test-bench and quality_engineering Domain Coexistence

**Status:** Proposed
**Date:** 2026-04-18
**Priority:** MEDIUM — Resolves ecosystem graph inconsistency and prevents capability duplication
**Originating Review:** AQE Integration Planning (plans/AQE_INTEGRATION.md §7, open question 1)
**Builds on:** ADR-PIPELINE-080 (QE Domain Registration), ADR-PIPELINE-082 (Agent Scope Boundary), ADR-030 (Ecosystem Capability Graph)

## Context

During the AQE integration design, two problems with the existing `test-bench` domain surfaced:

### Problem 1: Ecosystem Graph Inconsistency

`src/agents/repo-agent-runner.ts:37` registers `'test-bench': 'test-bench'` as a valid domain. The bundle map (`src/agents/repo-agent-runner.ts:81`) similarly registers `'test-bench': 'test-bench-agents'`. But `docs/ecosystem.graph.json` does NOT contain a `test-bench` entry in either `infrastructure[]` or the phase-specific `capabilities[]` section.

Consequences of this split:
- The capability classifier cannot discover test-bench capabilities (graph is the source of truth).
- Phase bindings cannot reference test-bench agents.
- Agents can only be invoked directly via `agentics agents invoke test-bench <agent>`, never auto-activated.
- Any documentation pointing at the ecosystem graph as the catalog of capabilities is incomplete.

### Problem 2: Capability Overlap with quality_engineering

AQE's exposed agent set (ADR-PIPELINE-082) covers test generation, coverage analysis, defect intelligence, flaky detection, chaos engineering, and test execution orchestration. `test-bench` — to the extent we have documentation — covers benchmarking, quality scoring, regression detection, hallucination/faithfulness evaluation, and model comparison.

The two domains are adjacent but not identical. There is genuine non-overlap (benchmarking ≠ test generation), but there is also a risk zone: both domains could claim "quality eval" or "regression" territory. Without an explicit boundary, the capability classifier picks arbitrarily.

## Decision

### 1. Register test-bench in ecosystem.graph.json

Add a missing entry to `infrastructure[]` in `docs/ecosystem.graph.json`:

```json
{
  "name": "test_bench",
  "description": "Model and agent evaluation benchmarking — quality scoring, regression detection, hallucination/faithfulness measurement, prompt sensitivity, consistency, bias, stress, red-team, golden-dataset curation, and synthetic-data generation for benchmarks.",
  "repos": ["test-bench"],
  "agents": [
    "Benchmark Agent",
    "Compare Agent",
    "Regression Detection Agent",
    "Quality Scoring Agent",
    "Hallucination Detection Agent",
    "Faithfulness Agent",
    "Bias Evaluation Agent",
    "Prompt Sensitivity Agent",
    "Consistency Agent",
    "Stress Test Agent",
    "Red Team Agent",
    "Adversarial Agent",
    "Golden Dataset Agent",
    "Synthetic Data Agent"
  ],
  "scope": "global",
  "tags": ["benchmark", "compare", "regression", "quality", "hallucination", "faithfulness", "bias", "prompt-sensitivity", "consistency", "stress", "red-team", "adversarial", "golden-dataset", "synthetic-data"]
}
```

The domain name `test_bench` (underscore) matches graph convention; runner key `test-bench` (hyphen) matches the existing entry. Agent list is taken from the `test-bench` domain referenced in `CLAUDE.md` routing table.

### 2. Explicit Boundary Between test_bench and quality_engineering

| Capability area | Owner domain | Rationale |
|-----------------|-------------|-----------|
| Generate tests (unit/integration/property/BDD) | `quality_engineering` | Test synthesis is AQE's specialty |
| Execute generated tests | `quality_engineering` | Test execution orchestrator lives in AQE |
| Measure test coverage | `quality_engineering` | Coverage analysis is AQE-specific |
| Detect flaky tests | `quality_engineering` | Flaky detection is AQE-specific |
| Predict defect hotspots | `quality_engineering` | Defect intelligence is AQE-specific |
| Root-cause test failures | `quality_engineering` | RCA agent in AQE |
| Chaos engineering | `quality_engineering` | Fault injection in AQE |
| Requirements traceability | `quality_engineering` | Traceability matrices in AQE |
| Benchmark a model or agent | `test_bench` | Model/agent comparison and scoring |
| Regression detection **on model quality** | `test_bench` | Benchmark-driven regression |
| Hallucination/faithfulness evaluation | `test_bench` | LLM-specific quality eval |
| Bias evaluation | `test_bench` | LLM bias measurement |
| Prompt sensitivity and consistency | `test_bench` | Prompt-level evaluation |
| Stress test / red-team / adversarial | `test_bench` | Robustness and security-through-provocation |
| Golden dataset curation | `test_bench` | Benchmark infrastructure |
| Synthetic data generation **for benchmarks** | `test_bench` | Benchmark infrastructure |

### 3. Disambiguation Rules for Overlap Cases

Some keywords could route to either. Explicit tie-breaks:

- **"regression"**: If modifier is "test" (regression test) → `quality_engineering`. If modifier is "model", "quality", or absent → `test_bench`.
- **"quality"**: If context is "code quality" or "test quality" → `quality_engineering`. If context is "model quality" or "output quality" → `test_bench`.
- **"evaluation"**: If artifact is code/tests → `quality_engineering`. If artifact is a model/prompt → `test_bench`.
- **"synthetic data"**: If for test fixtures → `quality_engineering`. If for benchmark datasets → `test_bench`.

These rules are encoded in the capability classifier tag-matching logic.

### 4. No Agent Migration

Zero agents move between `test_bench` and `quality_engineering`. The boundary is on **capability ownership**, not **agent relocation**. Both domains stay in their respective repos. If a genuinely duplicate capability exists (e.g., both domains can generate synthetic data), the boundary rule decides which is invoked for a given user query; the other remains available for direct invocation but is not auto-activated.

### 5. Phase Bindings for test_bench

`test_bench` does not get new phase bindings in this ADR. Its current bindings (if any — none documented) are preserved. Future `test_bench` phase bindings follow ADR-PIPELINE-084 promotion policy.

Note specifically that Phase 1 (Simulation) and Phase 2 (Research) may eventually bind `test_bench` agents for scenario-generation benchmarking, but those decisions belong to separate ADRs.

### 6. Long-Term Consolidation Review

In 180 days (targeting 2026-10-15), an ADR review assesses whether `test_bench` and `quality_engineering` should remain separate or consolidate. Review inputs:
- Actual usage patterns by domain
- Measured overlap in user queries (how often both domains activate on the same query)
- Adapter maintenance burden
- User-facing clarity (do users know which domain to ask?)

No consolidation is assumed. This ADR explicitly leaves both domains as peers; the review is a forcing function to revisit, not a deprecation plan.

## Implementation

1. Edit `docs/ecosystem.graph.json` — add the `test_bench` entry from §1 to `infrastructure[]` (alongside other global domains).
2. Update `docs/AGENT_CAPABILITY_REGISTRY.md` — add test_bench to the Global Infrastructure Domains reference list.
3. Implement disambiguation rules from §3 in the capability classifier (`src/commands/ask.ts` or equivalent routing module).
4. Unit test `tests/unit/routing/test-bench-qe-boundary-085.test.ts` — asserts the 15+ disambiguation cases route to the correct domain.
5. Update `CLAUDE.md` routing table to reflect the new boundary (test_bench and quality_engineering rows separated with precise query patterns).
6. Schedule the 180-day review: open a tracking issue with the review ADR placeholder.

## Acceptance Criteria

1. `jq '.infrastructure[] | select(.name=="test_bench")' docs/ecosystem.graph.json` returns a non-empty object.
2. The capability classifier routes "benchmark our model" to `test_bench`, not `quality_engineering`.
3. The capability classifier routes "generate unit tests" to `quality_engineering`, not `test_bench`.
4. The capability classifier routes "regression test for our API" to `quality_engineering` (modifier: test); "model quality regression" to `test_bench` (modifier: model).
5. `docs/AGENT_CAPABILITY_REGISTRY.md` lists both domains in the Global Infrastructure Domains section with clear role descriptions.
6. A tracking issue exists for the 180-day review dated 2026-10-15.

## Consequences

### Positive

- Ecosystem graph becomes consistent with the runner — single source of truth restored.
- Explicit capability boundary prevents routing ambiguity. Users and code both know which domain to call for what.
- Consolidation review in 180 days prevents long-term fragmentation if the boundary proves artificial in practice.
- No agent migration means zero risk to existing `test_bench` users.

### Negative

- Two domains for "quality-related" capabilities is conceptually heavier than one. Users may reasonably ask "why two?" — documentation must answer clearly.
- Disambiguation rules are regex/keyword-based and will have edge cases. Initial coverage is 15+ cases; we will expand as we observe misroutings.

### Neutral

- `test_bench` itself is untouched (no code changes in that repo). This ADR is a graph + routing edit only.

## Related

- **ADR-PIPELINE-080** (QE Domain Registration) — the peer domain this ADR disambiguates against
- **ADR-PIPELINE-082** (Agent Scope Boundary) — governs AQE's exclusion list; this ADR governs the adjacent domain boundary
- **ADR-PIPELINE-084** (Observational-First Rollout) — any future `test_bench` phase bindings follow this policy
- **ADR-030** (Ecosystem Capability Graph) — the schema this ADR corrects
- **plans/AQE_INTEGRATION.md** §7 open question 1 — flagged this issue
