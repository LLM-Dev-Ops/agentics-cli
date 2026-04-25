# ADR-PIPELINE-099: Coherent Multi-Prompt Phase 5a + Continuous Pipeline Heartbeat

**Status:** Proposed
**Date:** 2026-04-25
**Priority:** CRITICAL — User-facing regression on two axes simultaneously: (1) the implementation-prompt output of a real run is unusable (one generic prompt instead of an ADR/DDD-grounded multi-prompt build plan), and (2) long stretches of the pipeline produce zero terminal output, leaving the user unable to distinguish progress from a hang.
**Builds on:** ADR-PIPELINE-094 (degraded-mode completion — D2 introduced the Phase-1-fallback path that this ADR replaces with a multi-prompt fallback), ADR-PIPELINE-091 (Ruflo as primary engineering executor — Phase 5a still tries Ruflo first), ADR-PIPELINE-097 (live status panel — extended here to a process-wide persistent status line), ADR-PIPELINE-098 (Phase 7 visibility — its per-row pattern generalises to phase boundaries).

## Context

### Defect 1 — Single garbage prompt

Real run trace (water-usage / ServiceNow / 83k employees, 2026-04-25):

```
prompts/
  impl-001-phase1-consensus.md
```

Exactly one file, frontmatter:

```yaml
---
id: impl-001-phase1-consensus
title: Phase-1 Consensus Implementation
order: 1
degraded_mode: phase1-fallback
source: phase1/decision-memo.md, phase1/scenario.json, phase1/executive-summary.md
quality: degraded
generator: local-fallback
---
```

The body is the executive summary + decision memo concatenated, capped with a generic "build a 5-file service" implementation directive that asks for `src/{index,config,errors,analysis,decisions,integration}.ts` regardless of what the project actually requires. The user's response: *"It's just grabbing some non-sense ... it needs to be a coherent set of implementation prompts based on the ADRs, DDDs, SPARC, and what needs to be completed."*

What went wrong: Phase 5a tried Ruflo (per ADR-091) and Ruflo produced no usable output (`[RUFLO-P4] Result: 0 files`). Phase 5a then took the ADR-094 D2 fallback path (`phase1-fallback`), which collapses ALL upstream context into a single prompt regardless of how rich the upstream is. In this run the upstream had:

- 109 agentics-fleet agents returning structured output, including:
  - `copilot/decomposer` returned **8 sub-objectives** with complexity scores and acceptance criteria — exactly the shape a multi-prompt build plan should consume
  - `copilot/planner` returned **7 ordered phases** with effort estimates and success criteria
  - `copilot/clarifier` returned 8 open questions and 6 explicit assumptions — useful as guardrails inside each prompt
- A complete executive-summary, decision-memo, financial-analysis, risk-assessment, scenario, roadmap
- ServiceNow systems list, success criteria, constraints, domain entities (Report, Opportunity, ERPTransaction)

None of this depth landed in the prompt. The fallback produces a deterministic skeleton that says nothing about ServiceNow integration, water-usage analytics, the 8 sub-objectives, or the 7 sequenced phases.

### Defect 2 — Silent background stretches

User's report from the same session: *"It went back to 'background processes' but this way I have no visibility into anything that's happening in the process which creates uncertainty in the user experience which is bad ... It needs to show blinking light processing in the output area to show the end-users that something is still happening."*

Existing visibility:

- `[FLEET]`, `[RUVECTOR]`, `[AGENTICS]`, `[RUFLO-P*]` line emissions per phase boundary
- ADR-097 live status panel (Phase 7 only)
- ADR-098 per-row Phase 7 progress + 15s LLM heartbeat
- 2.7.26 added a 10-second `[agentics] ⏳ still working` heartbeat in `executeNaturalLanguageRoute`

What's still missing:

- Heartbeat **only fires from inside `executeNaturalLanguageRoute`** (Phase 1). Once Phase 1 returns and auto-chain takes over (Phases 2–7), the heartbeat is gone. Phases 2–6 each have long quiet stretches where Ruflo runs synchronously with `stdio: 'pipe'` — anywhere from 30 seconds to 10 minutes of zero output.
- No animation. Even in TTY mode the user sees plain log lines with no indication of *current* activity.
- No persistent indicator. The user can't tell at a glance "what phase am I in, and how long has it been running?"

### Together

These are independent defects, but they compound: the user sees nothing for several minutes, and when output finally arrives it's a single nonsense prompt. The combined experience is *"the tool is broken and I can't tell why."* This ADR addresses both because they share the same fix layer (the auto-chain coordinator), and the user reported them together as one regression.

## Decision

Four rules. D1 and D2 fix the prompts. D3 and D4 fix the visibility.

### D1. Phase 5a MUST produce ≥ 6 coherent prompts in every code path

Replace the current fallback contract ("one prompt or the SPARC→ADR→DDD chain") with a single contract that fires in **every** code path:

> Phase 5a emits N coherent implementation prompts where 6 ≤ N ≤ 14, plus a `prompts/execution-plan.json` that lists their dependency edges.

The N prompts are sourced from a precedence chain. The first source that yields ≥ 6 distinct buildable units wins; the others feed in as enrichment:

1. **Ruflo writer-agent** (ADR-091 primary): if Ruflo's task succeeds and writes ≥ 6 `prompts/impl-NNN-*.md` files, use them. (Today's reality: this almost never happens — the Ruflo writer task usually produces 0 files.)
2. **ADR + DDD chain**: when `phase4/adrs/` has ≥ 6 ADR files OR `phase4/ddd/bounded-contexts.json` enumerates ≥ 6 contexts, generate one prompt per ADR-cluster / per bounded-context. Each prompt:
   - Quotes its governing ADR by ID and decision-text.
   - Quotes its DDD bounded-context's aggregates, entities, commands, queries, events.
   - Quotes the SPARC specification section that overlaps with this slice.
   - Lists imports from previously built prompts (the dependency edge).
   - Frontmatter: `degraded_mode: false`, `quality: full`, `generator: adr-ddd-sparc`.
3. **Agent-fleet decomposition** (NEW — fills the gap when 1 and 2 both fail): combine `copilot/decomposer.sub_objectives`, `copilot/planner.steps`, and the scenario's `domain_entities`/`success_criteria`/`constraints` into N prompts. Each prompt:
   - Maps 1-to-1 to a `decomposer.sub_objective` (preferred) or a `planner.step`.
   - Carries the sub-objective's `complexity` score in frontmatter.
   - Inlines the relevant `acceptance_criteria` as the Definition of Done.
   - Names its dependencies by reading the sub-objective's `dependencies[]` field.
   - Inlines `clarifier.assumptions[]` as a "Load-Bearing Assumptions" callout so the implementer doesn't unknowingly violate them.
   - Inlines the system constraints (`scenario.constraints`) as guardrails at the top.
   - Frontmatter: `degraded_mode: agent-fleet-decomposition`, `quality: directional`, `generator: agent-fleet`.
4. **Last-resort phase-1 skeleton** (current ADR-094 D2 path, kept as a safety net for runs where even the agent fleet failed): one prompt per scenario success-criterion (NOT a single concatenated dump). Frontmatter `degraded_mode: phase1-fallback`, `quality: degraded`. This path emits ≥ 4 prompts, never just one.

In every path the prompts MUST be **coherent across the set**:

- Foundation prompts (data layer, domain model, persistence) come before integration prompts (ERP, webhooks, auth) come before presentation prompts (dashboard, reports) come before validation prompts (tests, smoke, hypercare).
- Every prompt has at least one named dependency (or is explicitly tagged `dependency_root: true` for the foundation tier).
- The `execution-plan.json` is a valid topological sort of the prompt set.

Concretely in the current fail-fast path that triggered the user's report: with the agent fleet returning 8 sub-objectives + 7 planner steps, this rule would have produced **8 prompts** for the water-usage scenario:

- `impl-001-data-integration-foundation.md` (decomposer §1, complexity 3)
- `impl-002-water-usage-anomaly-detection.md` (decomposer §2, complexity 4, depends on 001)
- `impl-003-cooling-optimization-engine.md` (decomposer §3, complexity 5, depends on 001 + 002)
- `impl-004-scenario-tradeoff-analysis.md` (decomposer §4, complexity 3, depends on 003)
- `impl-005-servicenow-integration.md` (decomposer §5, complexity 4, depends on 001)
- `impl-006-decision-audit-governance.md` (decomposer §6, complexity 2, depends on 005)
- `impl-007-prototype-ui-reporting.md` (decomposer §8, complexity 3, depends on 003 + 004)
- `impl-008-pilot-validation-deployment.md` (decomposer §7 + planner steps 5–7, complexity 3, depends on all)

That is what "coherent set of implementation prompts" means in this ADR. Not one dump. N grounded units.

### D2. The fallback emitter is renamed and the prompt-generator is one entry point with N strategies

`src/pipeline/phases/prompt-generator.ts` is restructured around the precedence chain in D1:

```ts
export async function generateImplementationPrompts(
  ctx: PromptGeneratorContext,
): Promise<{ prompts: ImplementationPrompt[]; executionPlan: ExecutionPlan; generator: GeneratorTier }> {
  const tiers: PromptStrategy[] = [
    rufloWriterAgentStrategy,    // ADR-091 primary
    adrDddSparcStrategy,         // when phase4 + phase3 succeeded
    agentFleetDecompositionStrategy, // NEW — D1.3
    phase1FallbackMultiStrategy, // ADR-094 D2 reshaped to N prompts — D1.4
  ];
  for (const tier of tiers) {
    const result = await tier(ctx);
    if (result.prompts.length >= 6) return result;
  }
  // If even the last tier produced < 6, emit whatever we have AND a
  // top-level FATAL marker that surfaces in chainResult.phases[5a].error.
  ...
}
```

The current `generateFallbackPromptFromPhase1Consensus` function is the only function whose contract changes externally — it MUST now return ≥ 4 prompts (one per scenario success-criterion) instead of one. All callers continue to pass through `generateImplementationPrompts`, so no caller is broken.

`src/synthesis/agent-fleet-decomposer.ts` is a new module that walks `agent-responses.json` to extract:

- `copilot/decomposer.outputs.sub_objectives[]`
- `copilot/planner.outputs.steps[]`
- `copilot/clarifier.outputs.assumptions[]`
- `copilot/clarifier.outputs.clarifications[]`
- `scenario.json.success_criteria[]`, `domain_entities[]`, `constraints[]`, `systems[]`
- `risk-assessment.json.risk_register[]`

and produces a `BuildableUnit[]` shape that `agentFleetDecompositionStrategy` consumes.

### D3. Process-wide persistent heartbeat with TTY animation

A new module `src/cli/ui/heartbeat.ts` exports a singleton `pipelineHeartbeat` with three operations:

```ts
pipelineHeartbeat.start(label: string): void;          // begin emitting ticks
pipelineHeartbeat.setPhase(phase: string): void;       // update the "what" line
pipelineHeartbeat.setActivity(activity: string): void; // update the latest sub-step
pipelineHeartbeat.stop(): void;                        // flush + clear
```

Behavior:

- **TTY mode (the default for `agentics ask`):** renders a single-line status at the BOTTOM of the terminal that updates **every 250ms in place** using ANSI cursor save/restore (`\x1b[s` / `\x1b[u`) and clear-line (`\x1b[2K`). The format is:

  ```
  ◓ [agentics 2.7.X] Phase 4 — ADRs + DDDs · 02:14 elapsed · ruflo: creating task adr-007
  ```

  - Frame char cycles through `◐ ◓ ◑ ◒` at 250ms — that's the "blinking light" the user asked for.
  - Phase + elapsed-in-phase + total-elapsed + activity all pulled from `setPhase` / `setActivity` calls upstream.
  - Other log lines (`console.error` / `process.stderr.write`) print ABOVE the status line by writing a `\n` first, then the status line repaints.

- **Non-TTY mode (`CI=1`, piped output, `AGENTICS_NO_HEARTBEAT=1`):** every 10 seconds emit one plain line:

  ```
  [agentics] ⏳ still working — Phase 4 (02:14) — ruflo: creating task adr-007
  ```

  Same content, no animation, no in-place repaint.

- **Auto-suppression of duplicate ticks:** if `setActivity` was called within the last 750ms, the next 250ms tick is skipped. Prevents visual flicker on phases that emit their own progress lines (Phase 7).

- **Crash-safe cleanup:** `process.on('exit')` and `process.on('SIGINT')` both call `stop()` to clear the status line. Prevents leaving a stale `◓ Phase 4 …` permanently rendered after a Ctrl-C.

`auto-chain.ts` calls `pipelineHeartbeat.setPhase()` at every phase entry (Phase 2, 3, 4, 5a, 5b, 6, 7) and `pipelineHeartbeat.setActivity()` at every interesting sub-step (Ruflo dispatch, agent fan-out start, Phase 7 deliverable row).

### D4. Phase boundaries are bracketed by `[BEGIN]` / `[END]` lines with timing

Replace the current ad-hoc `>> Phase N: <label>` log lines with a uniform pair:

```
============================================================
  ▶ Phase 4: ADRs + DDDs                       [BEGIN]  T+02:14
============================================================
  ... phase-specific output ...
============================================================
  ▼ Phase 4: ADRs + DDDs   ✓ completed (00:43)  [END]    T+02:57
============================================================
```

The `[BEGIN]` / `[END]` markers are greppable, and the `T+MM:SS` timestamps are absolute (since pipeline start), making it possible to align the trace to the user's wall clock when they say "it stalled around 3 minutes in."

## Implementation locations

- `src/pipeline/phases/prompt-generator.ts` (edit) — restructure around the 4-tier precedence chain (D2). The current `generateFallbackPromptFromPhase1Consensus` is renamed `generatePhase1FallbackPrompts` and its return type changes from `ImplementationPrompt` to `ImplementationPrompt[]`.
- `src/synthesis/agent-fleet-decomposer.ts` (new) — extracts `BuildableUnit[]` from `agent-responses.json` per D1.3.
- `src/pipeline/phases/strategies/ruflo-writer-strategy.ts` (new) — wraps the existing Ruflo invocation as the tier-1 strategy.
- `src/pipeline/phases/strategies/adr-ddd-sparc-strategy.ts` (new) — extracts the existing ADR/DDD/SPARC consumption into the tier-2 strategy.
- `src/pipeline/phases/strategies/agent-fleet-strategy.ts` (new) — D1.3.
- `src/pipeline/phases/strategies/phase1-fallback-strategy.ts` (new) — D1.4, replaces the single-prompt fallback.
- `src/cli/ui/heartbeat.ts` (new) — D3.
- `src/pipeline/auto-chain.ts` (edit) — call `pipelineHeartbeat.start()` at the very top, `setPhase()` at every phase entry, `setActivity()` at every interesting sub-step (look for the existing `console.error('  >> Phase N:`  call sites — same locations).
- `src/commands/agents.ts` (edit) — `executeNaturalLanguageRoute` calls `pipelineHeartbeat.setActivity()` at every `[FLEET]`, `[RUVECTOR]`, `[AGENTICS]` log point so the heartbeat reflects fan-out progress.
- `tests/unit/pipeline/phase5a/prompt-generator.test.ts` (new) — fixture-based tests for each of the 4 tiers; assert the ≥ 6 contract; assert dependency edges form a valid topological sort.
- `tests/unit/pipeline/phase5a/agent-fleet-decomposer.test.ts` (new) — feed it a real `agent-responses.json` fixture and assert it extracts ≥ 6 buildable units.
- `tests/unit/cli/ui/heartbeat.test.ts` (new) — TTY vs non-TTY mode contract; auto-suppression on recent `setActivity`; crash cleanup.

## Failure modes (explicit)

- **Tier-3 agent-fleet has fewer than 6 buildable units.** This happens when the scenario is genuinely small. Promote tier-3 partial output and back-fill with tier-4 success-criterion prompts to reach 6. Mark back-filled prompts with `generator: agent-fleet+phase1-fallback`.
- **All four tiers fail.** Phase 5a emits exactly 0 prompts AND a top-level error in `chainResult.phases[5a].error`. Phase 5b's gate (per ADR-094 D3) blocks the build. Auto-chain still continues to Phase 6 / 7 per ADR-094 D4.
- **Heartbeat repaints corrupt user input.** The TTY mode uses `\x1b[s` / `\x1b[u` which DOES interact with the user's cursor. If `agentics ask` is ever called from an interactive prompt context (it isn't today), this would clobber input. Mitigation: detect `process.stdin.isTTY && !process.stdout.isTTY` and disable the in-place repaint, falling through to the plain heartbeat.
- **Heartbeat doesn't clear on crash.** `process.on('exit')` / `SIGINT` / `SIGTERM` all wired to `stop()`. The shell may still have the cursor parked — that's a 1-line redraw, not a corrupted terminal.

## Test plan

1. **Tier-3 fixture test.** Feed the real `agent-responses.json` from the user's water-usage run (decomposer 8 sub-objectives + planner 7 steps) into `agentFleetDecompositionStrategy` → assert ≥ 6 prompts emitted, dependency edges form a DAG, every prompt cites at least one source agent in its frontmatter.
2. **Tier-4 fixture test.** Empty `phase4/`, empty `phase2/sparc/`, real Phase-1 outputs → assert tier-4 fires AND emits ≥ 4 prompts (one per `success_criteria`), NOT a single concatenated dump.
3. **Tier precedence test.** Provide all four tier inputs simultaneously → assert tier-1 wins. Provide only tiers 2–4 → assert tier-2 wins. Etc.
4. **Coherence test.** Every emitted set is checked for: (a) topological-sort-able dependency graph, (b) at least one `dependency_root: true`, (c) every named dependency exists in the set.
5. **Heartbeat TTY test.** Mock `process.stderr.isTTY = true`, drive `pipelineHeartbeat.setPhase()` + `setActivity()`, capture written bytes, assert ANSI cursor save/restore + clear-line + frame char appears every 250ms.
6. **Heartbeat non-TTY test.** Mock `isTTY = false`, drive same calls over 35 seconds, assert exactly 3 `[agentics] ⏳ still working` lines emitted (one per 10s tick).
7. **Heartbeat suppression test.** Call `setActivity` 5 times within 1 second → assert at most 2 ticks fire (the auto-suppress window collapses the rest).
8. **End-to-end on the real run-dir.** Re-run Phase 5a standalone against `/home/codespace/.agentics/runs/<water-usage-trace>` and confirm it emits ≥ 6 named prompts whose union references the ADRs / DDDs / sub-objectives that exist in that run-dir.

## Open questions

- **Q1.** Should the 4-tier strategy be configurable via env var (`AGENTICS_PHASE5A_FORCE_TIER=fleet`) for testing, or hardcoded? Default chosen: env var override exists for testing, otherwise hardcoded precedence. The user's directive ("I need this fixed") implies they want a single deterministic path in production — the override is a developer affordance, not a user-facing flag.
- **Q2.** Heartbeat refresh rate. 250ms feels right for a "blinking light" — too fast (e.g., 100ms) eats CPU on slow VMs; too slow (e.g., 1s) doesn't read as motion. Tracked here in case the user wants a different cadence.
- **Q3.** Should the heartbeat status line also show the current phase's elapsed-without-output (i.e., "12s since last activity") so the user can spot a sub-phase hang even when the overall heartbeat is alive? Adds value, adds complexity. Likely yes in a follow-up; not in this ADR.
- **Q4.** When tier-3 fires, how aggressively should it inline `clarifier.assumptions` and `clarifier.clarifications`? Too much → prompts get bloated. Too little → implementer ships code that violates a load-bearing assumption. Default chosen: top 5 assumptions + top 3 clarifications per prompt, plus a "see clarifier output for full set" link.

## Related ADRs

- ADR-PIPELINE-094 — Path-reality + degraded-mode completion. D2's single-prompt fallback is what this ADR replaces. D4's always-emit phase-result entry is preserved.
- ADR-PIPELINE-091 — Ruflo as primary engineering executor. The 4-tier chain keeps Ruflo as tier 1; tiers 2–4 are explicit fallbacks rather than the implicit ones we have today.
- ADR-PIPELINE-097 — Live status panel. The new persistent heartbeat is a strict superset of the panel, applied process-wide instead of phase-7-only.
- ADR-PIPELINE-098 — Phase 7 visibility. The per-row pattern there generalises here to per-phase + per-activity. Phase 7's row markers continue to fire as `setActivity()` calls into the new heartbeat layer.
