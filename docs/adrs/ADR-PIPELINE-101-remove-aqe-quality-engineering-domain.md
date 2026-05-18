# ADR-PIPELINE-101: Remove AQE (quality-engineering) Domain From Runtime

**Status:** Implemented in v2.7.38 (commit `d701bbc`)
**Date:** 2026-05-18
**Priority:** HIGH — User-perceived pipeline hang attributed to AQE; full domain removal performed at user direction
**Supersedes:** ADR-PIPELINE-080, ADR-PIPELINE-082, ADR-PIPELINE-083, ADR-PIPELINE-085, ADR-PIPELINE-086, ADR-PIPELINE-087 (left in `docs/adrs/` as historical record; their runtime artifacts are now gone)
**Builds on / replaces:** the resolution-only short-circuit added in `b55a33d` (v2.5.2) and the resolver-coverage CI guard from `dea2031` (v2.5.1) — those were band-aids that this ADR makes unnecessary by removing the domain entirely

---

## Context

### What AQE was

ADR-PIPELINE-080 (2026-04-?) registered a `quality_engineering` (AQE) domain with 14 agents — `test-design`, `unit-test-gen`, `integration-test-gen`, `property-test-gen`, `bdd-test-gen`, `coverage-analysis`, `coverage-gap-detect`, `defect-prediction`, `flaky-detection`, `traceability`, `chaos`, `test-execution`, `qe-reporting`, and `rca` (renamed to `QE Root Cause Analysis Agent` in ADR-087 §2 to disambiguate from sentinel's `Root Cause Analysis Agent`). The intent was a comprehensive code-quality fleet wrapping an upstream AQE service. ADR-PIPELINE-083 bound all 14 agents to phase 8 (validation) as `mandatory_agents` — failing AQE invocation would halt the pipeline with exit 141. ADR-PIPELINE-086 added a `AGENTICS_QE_GATING` env-var kill-switch (`on`/`advisory`/`off`) for emergency bypass.

### How AQE was already broken before this ADR

1. **AQE was never deployed.** Commit `b55a33d` (v2.5.2, 2026-04-21) documents that the AQE adapter pointed at a guessed Cloud Run URL (`AGENTIC_QE_URL`) that returned nothing. Every classifier-selected AQE agent stacked a per-invocation network timeout, blowing Claude Code's MCP client tool-call budget.
2. **The kill-switch was dead code.** ADR-087 §6 documents that `src/pipeline/phase5-build/qe-gating-executor.ts` had zero callers. Setting `AGENTICS_QE_GATING=off` had no effect on runtime.
3. **Phase 8 was never wired.** `PHASE_AGENTS` in `src/pipeline/swarm-orchestrator.ts` only defines phases 2–6. The auto-chain has phases 1–7 (Phase 7 = Consulting Deliverables per ADR-098). There is no phase 8 dispatch loop. ADR-083's "phase 8 mandatory_agents" binding referenced a phase that does not exist as a code path.
4. **Resolution-only band-aid.** v2.5.2 added `RESOLUTION_ONLY_DOMAINS` in `src/commands/agents.ts` that short-circuited AQE invocations with a structured 503 in ~0ms. This meant AQE could be classifier-selected but never actually network-dispatched.

Net runtime impact of AQE prior to this ADR: each `agentics ask` classified 14 AQE agents, each returned `{ status: 503, reason: "resolution-only" }` in microseconds, and the pipeline ignored them.

### The trigger

`agentics ask` stopped running end-to-end after AQE was introduced (ADRs 080–087). The pipeline hung — "keeps running, nothing happens." Multiple attempts produced no progress. AQE was the only material runtime addition over that window. User identified AQE as the cause and directed full removal.

After removal + rebuild + republish (v2.7.38), the pipeline ran again. **AQE was the cause.**

## Decision

Remove the `quality-engineering` domain from every runtime artifact. Preserve the historical record in ADRs 080/082/083/085/086/087 but ensure no code references the domain after this change.

Specifically:

### 1. Strip the domain from `docs/ecosystem.graph.json`

- Delete the entire `quality_engineering` domain block (lines 197–219 of the pre-change file)
- Remove all 14 AQE agents from phase 8 (`validation` capability) `mandatory_agents` — only the original four (`Quality Scoring Agent`, `Output Consistency Agent`, `Hallucination Detection Agent`, `Faithfulness Verification Agent`) remain
- Remove AQE agents from `optional_agents` lists on phases 3 (`sparc_generation`), 5 (`adr_ddd_architecture`), 6 (`implementation_planning`), 7 (`build`), 9 (`integration_mapping`), and 10 (`governance_finops`)
- Remove QE-related tags (`qe`, `quality-engineering`, `defect`, `flaky`, `traceability`, `chaos`, `qe-reporting`, `test-metrics`, etc.) from the affected capabilities
- Reword the `test_bench` description to drop the "Complement to quality_engineering per ADR-085" reference

### 2. Strip resolver and routing references

- `src/routing/graph-router.ts:545–560`: delete the 14 AQE entries from `AGENT_NAME_TO_DOMAIN`. CI guard (`scripts/check-graph-resolver-coverage.ts`) still passes — 122/122 graph-referenced names resolve (down from 136 before; -14 graph entries match -14 resolver entries).
- `src/commands/agents.ts:378`: remove `quality-engineering` from `RESOLUTION_ONLY_DOMAINS`. The set retains `diligence-artifacts` (still routed through phase coordinators, not direct dispatch).
- `src/routing/domain-boundary.ts`: empty `DISAMBIGUATION_RULES` and `TIE_BREAK_RULES` — every entry in both lists referenced `quality_engineering`. The module remains as a no-op extension point; it was never wired into the runtime path (ADR-087 §5 documents this).

### 3. Delete dead modules

- `src/config/qe-gating.ts` (197 lines) — env-var/persisted-config resolver for the `AGENTICS_QE_GATING` kill-switch. Zero importers outside its own file.
- `src/pipeline/phase5-build/qe-gating-executor.ts` (195 lines) — phase 8 decision tree (on/advisory/off). Zero importers. Function `executePhase8Qe` never called.

### 4. Strip AQE from agent runners and prompts

- `src/agents/system-prompts.ts`: remove the entire `'quality-engineering'` block (14 system prompts, ~32 lines).
- `src/agents/repo-agent-runner.ts`: remove `'quality-engineering': 'agentic-qe'` from `FUNCTION_NAMES` and `'agentic-qe': 'agentic-qe-agents'` from `BUNDLE_NAMES`.
- `src/pipeline/ruflo-phase-executor.ts`: strip historical AQE references from the coverage-gap fallback Ruflo task. The function (`buildCoverageGapTasks`) is preserved — it produces the same `coverage-gaps.json` output without referencing AQE.
- `src/pipeline/phase7/deliverables-registry.ts:978`: substitute QE `sourceAgents` on the `testing-strategy` deliverable with `['test-bench/quality', 'test-bench/regression']`. The deliverable's input artifacts (`phase3/tdd`, `phase4/adrs`, `phase2/tdd`) are unaffected; the deliverable still renders.
- `src/adapters/base-adapter.ts`: remove the dead AQE adapter comment block.

### 5. Delete QE-only tests

- `tests/unit/config/qe-gating-086.test.ts`
- `tests/unit/agents/repo-agent-runner-qe-080.test.ts`
- `tests/unit/routing/qe-phase-bindings-083.test.ts`
- `tests/unit/routing/test-bench-qe-boundary-085.test.ts`
- `tests/unit/routing/domain-boundary-082.test.ts` (every assertion in this file referenced the now-empty `DISAMBIGUATION_RULES` and `TIE_BREAK_RULES`)

Three tests use `quality-engineering/coverage-gap-detect` as a fixture for failure-aggregation behavior (not actual QE behavior). Those fixtures are substituted with `test-bench/regression`:
- `tests/unit/pipeline/enterprise/agent-error-capture-094.test.ts:133`
- `tests/unit/pipeline/auto-chain-ruflo-primary.test.ts:298,321,414,423`
- `tests/unit/pipeline/adr-093-e2e.test.ts:317,376,856`

### 6. Strip docs

- `CLAUDE.md`: remove the `quality-engineering` row from the Domain Matching Table.
- `scripts/check-graph-resolver-coverage.ts`: update the header (the ADR-087 §8 framing is preserved; the script is general-purpose, not AQE-specific).

### 7. Leave the historical ADRs intact

ADR-PIPELINE-080, 082, 083, 085, 086, 087 remain in `docs/adrs/`. They document why AQE was added and what it was supposed to do. This ADR (101) is the canonical record of why it was removed and what was deleted. Anyone considering re-adding a quality-engineering domain should read this ADR first, then those six, then justify what's different this time.

## Implementation

Single commit on `main`: `d701bbc` — `feat!: remove AQE (quality-engineering) fleet — 2.7.38`.

23 files changed: **1812 deletions, 46 insertions.**

Published to npm as `@llm-dev-ops/agentics-cli@2.7.38`.

## Validation

- `tsc --noEmit`: clean
- `scripts/check-graph-resolver-coverage.ts`: 122/122 graph-referenced names resolve
- Jest on touched files + `tests/unit/routing/`: 194 passed, 4 failed. All 4 failures are in `tests/unit/routing/graph-loader.test.ts` and assert stale hardcoded values (`version: '1.1'` when graph is `'2.0'`; `stages.length: 8` when there are 11; expects `'governance'` stage when it's `'governance_finops'`). Confirmed pre-existing via `git stash` — identical 4 failures on `main` before this commit.

## Consequences

### Positive

- **Codebase mass reduced by ~1.8k lines.** Easier to read, fewer places for bugs to hide.
- **No more dead-code kill-switch.** `AGENTICS_QE_GATING` no longer documented or readable in source; users won't try to set it expecting it to do something.
- **No more silent 503s on classifier-selected agents.** Pre-removal, 14 AQE agents were classifier-selected on most queries and each returned a structured 503. Post-removal, they are not selected at all.
- **Routing table simpler.** `CLAUDE.md` Domain Matching Table goes from 28 to 27 rows; one less domain for the routing layer to consider.
- **No future "is AQE working yet?" question.** The answer is now structurally "no, and there's no path to yes without a new ADR."

### Negative

- **The domain-boundary module is now empty.** `DISAMBIGUATION_RULES` and `TIE_BREAK_RULES` are empty arrays. Several ADR-082-era invariants (e.g., "`security` always routes to shield, never QE"; "`sap`/`oracle` routes to connector-hub, never QE") are no longer enforced, but they're also no longer relevant — QE is not a routing target. If a future domain needs the same invariants (a new `quality_assurance` domain, say), the rule structure is intact and ready to populate.
- **Three test fixtures changed without semantic equivalence verification.** The `quality-engineering/coverage-gap-detect` → `test-bench/regression` substitution preserves the test's behavior (it's testing failure-aggregation, not the agent itself), but a future reader of `agent-error-capture-094.test.ts` may not realize the original fixture was AQE.

### Neutral

- **ADRs 080–087 stay in place.** Anyone reading the ADR log chronologically sees the rise and fall of AQE in order.
- **`templates/agentic-qe-example/` and `plans/AQE_INTEGRATION.md` were not touched.** They live outside the runtime path. Left as historical references; can be deleted in a follow-up if they cause confusion.
- **The CI guard script (`check-graph-resolver-coverage.ts`) is unchanged in its enforcement.** It still requires every graph-referenced name to resolve. The only edit was rewording the header comment.

## Open Questions / Follow-ups

1. **ADR cleanup pass.** Consider marking ADRs 080/082/083/085/086/087 with a `Status: Superseded by ADR-101` header so the chronological log makes the supersession explicit at-a-glance.
2. **`templates/agentic-qe-example/` decision.** Decide whether this template is still useful as a generic "wrapped third-party MCP service" example or should also be removed. Out of scope for this ADR.

## Related

- **ADR-PIPELINE-080** (Quality Engineering Domain Registration) — original AQE introduction
- **ADR-PIPELINE-082** (AQE Agent Scope Boundary) — disambiguation/tie-break rules now empty
- **ADR-PIPELINE-083** (Phase Capability Binding for QE) — bound 14 agents as phase-8 mandatory; now gone
- **ADR-PIPELINE-085** (Test-Bench / Quality-Engineering Coexistence) — the coexistence is no longer needed
- **ADR-PIPELINE-086** (QE Kill-Switch and Gating Regression Policy) — kill-switch is gone
- **ADR-PIPELINE-087** (Restore `agentics ask` Pipeline — AQE Agent-Name Resolver Gaps) — Landing 1 (resolver coverage, CI guard) survives; Landing 2 (domain identifier normalization, boundary wiring, gating executor wiring, MCP response semantics) is partly OBE since the boundary rules are now empty and the gating executor is deleted
