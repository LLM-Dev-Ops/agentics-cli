# ADR-PIPELINE-093: Phase Dependency Gates — Explicit DAG, Ruflo-Verified Inputs, Mandatory Prompt Emission

**Status:** Proposed
**Date:** 2026-04-23
**Priority:** HIGH — Capstone phase-graph policy that ties ADR-091 (Ruflo as primary engineering executor) and ADR-092 (promotion completeness) into a single dependency-aware contract. Each phase gate verifies its required inputs exist before the coordinator runs; if Ruflo has not yet deposited a required upstream artifact, the gate invokes Ruflo (the primary executor, per ADR-091) to produce it. Missing inputs are never silently degraded.
**Originating Trace:** `dacf7975-1e80-413d-88d8-2fcba9a758be`.
**Builds on:** ADR-PIPELINE-091 (Ruflo as primary engineering executor — upstream dep), ADR-PIPELINE-092 (promotion completeness — downstream dep), ADR-PIPELINE-089 (Phase 1 health gate), ADR-PIPELINE-088 (auto-chain MCP status schema), ADR-PIPELINE-083 (phase capability binding), ADR-PIPELINE-060 (10-of-10 readiness scorecard).

## Context

The autochain pipeline executes six phases with implicit dependencies. Each coordinator reads the predecessor's artifacts from disk; when those artifacts are missing or empty, today's code silently substitutes defaults and produces degraded output. No coordinator refuses to proceed on missing inputs.

### The six phases

```
Phase 1 (dossier + consensus, ruvector-service)
    → Phase 2 (deep research + dossier enrichment)
        → Phase 3 SPARC            (Ruflo-primary: specification, pseudocode,
                                     architecture, refinement, completion + London TDD)
            → Phase 4 ADRs + DDD   (Ruflo-primary: architectural decisions,
                                     bounded contexts)
                → Phase 5a Implementation Prompts
                                   (execution-plan.json + impl-NNN-*.md)
                → Phase 5b Scaffold emission
                                   (concrete source files per project.language)
```

Under ADR-091, Phases 3, 4, and 5a are executed **primarily** by the local Ruflo swarm. Remote diligence agents feed in as optional enrichment. This ADR governs the dependency relationships between these phases, independent of which executor tier produced any given input.

### What went wrong in run `dacf7975`

1. **Phase 1 partially failed.** Four of sixteen agents returned 503; ADR-089's health gate classified the run `degraded` and auto-chain proceeded.
2. **Phases 3 and 4 ran without invoking Ruflo.** The current coordinator code at `phase3-sparc-coordinator.ts:56` and `phase4-adrs-coordinator.ts:56` calls `loadPhase1ArtifactsFromDisk` and silently returns `{}` for missing JSON, `''` for missing markdown, then produces near-empty output. Ruflo (the primary executor under ADR-091) was never invoked — because today's code still treats remote diligence agents as primary and has no gate that checks whether Ruflo-output exists before running the refinement path.
3. **Phase 5a prompt generation was NEVER invoked.** `.agentics/plans/prompts/execution-plan.json` and `impl-NNN-*.md` were not written at all. The prompt-generator at `phases/prompt-generator.ts:452` has an "ADR-Only Prompt Generation (fallback when no DDD bounded contexts exist)" branch — proving it can degrade gracefully when DDD is missing — but no branch at all for missing ADRs, so it was skipped upstream rather than invoked with empty inputs.
4. **Phase 5b scaffold wrote Python files into a TypeScript project.** Scaffold emission at `auto-chain.ts:1582+` ran independently of prompt-generator and did not consult Phase 1's `project.language`.

### The common defect

There is no explicit dependency contract between phases. Each phase reads whatever it finds on disk and treats absence as empty. ADR-089 gave us a Phase 1 verdict. ADR-091 makes Ruflo the primary executor for engineering phases. ADR-092 ensures artifacts reach `.agentics/plans/`. What is missing is the glue: per-phase declarations of required inputs, a shared gate that verifies them before the coordinator runs, and a hard guard on the mandatory Phase 5a emission.

## Decision

Make phase dependencies explicit and Ruflo-verified via five rules.

### 1. Dependency DAG declaration

Each phase declares required and optional inputs as paths under `runDir/`. The declaration is static, colocated with the coordinator, and consumed by a single shared gate helper.

| Phase | Required inputs | Optional inputs (enrichment) |
|-------|-----------------|------------------------------|
| 1 dossier + consensus | (entry) | — |
| 2 deep research | `phase1/manifest.json`, `phase1/executive-summary.md` | `phase1/scenario.json`, `phase1/decision-memo.md`, `phase1/risk-assessment.json` |
| 3 SPARC (Ruflo-primary) | `phase1/manifest.json`, `phase2/research-dossier.json` | `phase1/roadmap.json`, `phase2/hypotheses.json`, remote `diligence-artifacts/sparc-*` (enrichment) |
| 4 ADRs + DDD (Ruflo-primary) | `phase1/manifest.json`, **`phase3/sparc/specification.md` OR `engineering/sparc-specification.md`** | `phase2/research-dossier.json`, remote `diligence-artifacts/adr-generation` (enrichment) |
| 5a prompt-generator | sparc spec (refined or engineering-dir) **AND (`phase4/adrs/*.md` OR `phase4/ddd/bounded-contexts.json` OR `engineering/architecture-decisions.md`)** | — |
| 5b scaffold emission | `phase1/manifest.json` (for `project.language`) | `phase4/adrs/*.md`, `phase5a/execution-plan.json` |

The `OR` forms accept either the structured per-phase refined output OR Ruflo's direct `engineering/` output (the ADR-092 candidate-source tables) — either satisfies the gate.

### 2. Gate verifies Ruflo ran; if not, invoke Ruflo

Before each phase coordinator runs, the auto-chain orchestrator invokes the shared gate:

```ts
gatePhaseInputs(phaseId, runDir):
  | { ok: true }
  | { ok: false, missing: string[], ruflo_invoked: string[], stillMissing: string[] }
```

The gate:

1. Reads declared required inputs for `phaseId`.
2. For each required input, checks existence AND size > 100 bytes AND content is not an error-stub sentinel (e.g., a JSON object whose only top-level keys are `error` and/or `message`).
3. For each missing required input, invokes the primary executor — `runPrimaryPhaseExecution(upstreamPhaseId, ...)` on `ruflo-phase-executor.ts` (per ADR-091). This is **not** a special regeneration path — it is the same entry point the preceding phase's gate should have already triggered. Whether Ruflo runs "on time" in its own phase or "late" to fill a gap another phase missed is irrelevant at the gate level; both cases call the same entry point with the same semantics.
4. Re-checks. Returns `{ ok: true }` when all required inputs are present.

Ruflo invocation is **capped at 1 attempt per missing-input per run** so a consistently degraded Ruflo session can't spiral into an infinite re-invocation loop.

### 3. No silent skip

Possible outcomes after the gate runs:

- **Gate passes (all inputs already present)** → phase executes normally.
- **Gate invoked Ruflo and inputs are now present** → phase executes normally; manifest records `phase{N}_inputs_produced_by_gate: [paths]`.
- **Gate could not produce required inputs** → phase is marked `blocked` in `manifest.json` with its missing-input list. Its coordinator does NOT run. The pipeline proceeds to the next phase **only if** that next phase's own required inputs are independently satisfied.

`blocked` is a distinct state from `failed`:

- **failed** = phase ran and errored;
- **blocked** = phase never ran because its prerequisites are unreachable.

Both are surfaced in:

- `status.json` under `blocked_phases: [{phase, missing}]` (extends the ADR-088 schema),
- the MCP `agentics-status` tool output,
- the final `agentics ask` banner as a warning line.

### 4. Phase 5a prompt generation is mandatory

The prompt-generator (Phase 5a) is **not optional**. If it cannot run because neither ADRs nor DDD are present, the Phase 5a gate invokes Ruflo to produce Phase 4 outputs first, then re-checks Phase 5a's own inputs. Only if Ruflo cannot produce Phase 4 either does the pipeline exit loudly.

The pipeline MUST always emit:

- `.agentics/plans/prompts/execution-plan.json` — valid JSON, at least one entry in the `implementations[]` array,
- at least one `impl-001-*.md` file in `.agentics/plans/prompts/`.

If both cannot be produced even with Ruflo-late-invocation, the pipeline prints:

```
[PIPELINE-093] FATAL: prompt-generator blocked — upstream artifacts unrecoverable
  missing: phase4/adrs/*.md, phase4/ddd/bounded-contexts.json, engineering/architecture-decisions.md
  attempted: Ruflo invocation for phase 4 (failed or timed out)
  run directory preserved: ~/.agentics/runs/<traceId>/
```

and exits non-zero. This is the one place the pipeline is allowed to fail loudly rather than degrade silently.

### 5. Scaffold-language gate

Phase 5b reads the target project's language before writing any scaffold file, consulting sources in order:

1. `phase1/manifest.json` `project.language` if present,
2. project root's `package.json` (TS/JS) vs `pyproject.toml` / `setup.py` (Python) vs `go.mod` (Go) vs `Cargo.toml` (Rust),
3. language inference from files already in `src/`.

If the detected language does not match the scaffold templates being emitted (the TypeScript scaffold block at `auto-chain.ts:1582+` is TS-only), the emitter either (a) re-runs with a matching-language template set if one exists, or (b) skips with a printed line:

```
[SCAFFOLD] skipped — language mismatch (detected: python, templates: typescript)
```

The skip is recorded in `manifest.json` under `phase5b_skipped: { reason, detected, template }`. Stops the `dacf7975`-class Python-into-TypeScript contamination.

## The dependency DAG

```
        Phase 1 (entry)
            │
            ▼
        Phase 2  ── requires: phase1/{manifest.json, executive-summary.md}
            │
            ▼
        Phase 3  ── requires: phase1/manifest.json, phase2/research-dossier.json
  (Ruflo-primary)              (Ruflo produces engineering/sparc-specification.md;
                                coordinator may refine into phase3/sparc/specification.md)
            │
            ▼
        Phase 4  ── requires: phase1/manifest.json,
  (Ruflo-primary)              phase3/sparc/specification.md OR engineering/sparc-specification.md
            │
            ▼
    ┌───────┴────────┐
    ▼                ▼
Phase 5a          Phase 5b
(prompts)         (scaffold)

Phase 5a requires: sparc spec (refined or engineering)
                   AND (phase4/adrs/*.md OR phase4/ddd/bounded-contexts.json
                        OR engineering/architecture-decisions.md)

Phase 5b requires: phase1/manifest.json (for project.language)
         optional: phase4/adrs/*.md, phase5a/execution-plan.json
```

5a and 5b are siblings, not sequential. 5b has a weaker dependency set (just the language signal), which is why the `dacf7975` run wrote scaffold files even though 5a was skipped — a behaviour this ADR formalizes by making 5b independent but language-correct.

## Consequences

### Positive

- **No silent skips.** Every missing required artifact is either produced by Ruflo (per ADR-091) or visibly recorded as `blocked`. The user always knows what the pipeline did and did not do.
- **Ruflo-verified dependencies.** Because Ruflo is the primary engineering executor (ADR-091), the gate's "produce the missing input" step is not a special regeneration path — it is the same code path Ruflo would have run in the preceding phase. Simpler mental model, no dead-letter fallback code.
- **Deterministic output floor.** `.agentics/plans/{sparc,adrs,ddd,prompts}/` are always populated — either by Ruflo running on time in its own phase, or by Ruflo running late when a downstream gate catches the miss.
- **Scaffold correctness.** TypeScript projects stop receiving Python scaffold and vice versa. The language gate is cheap (a manifest + package.json read) and catches the most common cross-language bug.
- **Composable with 091 and 092.** 091 makes Ruflo the primary executor; 093 enforces that every phase has access to Ruflo's outputs before it runs; 092 promotes those outputs into `.agentics/plans/`.

### Negative

- **Gate-invoked Ruflo runs cost user LLM tokens and wall-clock time.** Each invocation spends 30k-100k tokens and 30-120s. Capped at 1 attempt per missing-input per run to bound worst case.
- **Loop risk if Ruflo is consistently degraded.** The cap prevents infinite loops, but a run where Ruflo fails on every attempt produces more `blocked` phases than before. In exchange, the user sees a clearer failure mode than the previous silent-empty-output mode.
- **Schema surface grows.** `status.json` gains `blocked_phases[]`, `phase{N}_inputs_produced_by_gate[]`, `phase5b_skipped`. All backwards compatible.
- **Edge case: blocked Phase 3 with satisfied Phase 4 inputs.** The rule that Phase 4 runs independently of Phase 3's block state is pragmatic but can surface weird intermediate states — Phase 4 generating ADRs from SPARC content that Ruflo produced late without a full refinement pass. Accepted as the lesser evil vs. blocking the whole downstream chain.

### Neutral

- Existing ADR-only fallback at `prompt-generator.ts:452` remains unchanged; a symmetric DDD-only arm is added to cover the other disjunct in the "ADRs OR DDD" required-input clause.
- Phase coordinators keep their current signatures; the gate is a preamble, not a refactor.

## Implementation plan

No code in this ADR. The landing PR touches:

- **`src/pipeline/auto-chain.ts`** — orchestration. Add `gatePhaseInputs(phaseId, runDir)` invocations before each phase coordinator call. Wire `blocked_phases` and `phase{N}_inputs_produced_by_gate` into the status-json writer from ADR-088. Add the scaffold-language gate around the scaffold block near line 1582.
- **`src/pipeline/phase3-sparc/phase3-sparc-coordinator.ts:56`** — replace `loadPhase1ArtifactsFromDisk`'s silent-empty-default behaviour with a required-input check that surfaces missing inputs to the gate (instead of masking them).
- **`src/pipeline/phase4-adrs/phase4-adrs-coordinator.ts:56`** — same pattern.
- **`src/pipeline/phases/prompt-generator.ts`** — add a hard guard at entry: if neither ADRs nor DDD bounded contexts are present (and `engineering/architecture-decisions.md` is also absent), refuse to run and return a typed `blocked` result to the orchestrator. Add a symmetric DDD-only branch parallel to the existing ADR-only branch at line 452.
- **`src/pipeline/ruflo-phase-executor.ts`** — expose `runPrimaryPhaseExecution(phaseId, dossier, context, timeout)` per ADR-091. The gate calls this when a required input is missing — **same entry point** the preceding phase would have called.
- **`src/pipeline/gate/phase-dependency-gate.ts`** (new file) — the single gate helper. Static dependency table lives here; all coordinators consume it; unit tests cover the quality-threshold and error-stub detection rules.
- **Manifest / status schema** — extend `status.json` with `blocked_phases: [{phase, missing: string[]}]`, per-phase `phase{N}_inputs_produced_by_gate: string[]`, and `phase5b_skipped`. Extend MCP `agentics-status` tool output to surface all three.

## Verification

Before merge, an end-to-end test simulates partial remote-fleet failure and asserts dependency self-healing:

1. **Force 503s on all four remote diligence agents.** Run end-to-end. Assert `.agentics/plans/{sparc,adrs,ddd,prompts}/` all populated — Ruflo produced everything as the primary executor (ADR-091). Assert **no** `blocked_phases` entries. Assert `manifest.execution.engineering_tier === "ruflo-local"` throughout.
2. **Force Ruflo to fail on Phase 4.** Mock Ruflo to timeout on its Phase 4 invocation. Assert Phase 5a's gate detects missing Phase 4 outputs, re-invokes Ruflo (the 1-retry allowance), and on second failure marks Phase 5a as `blocked`. Assert `[PIPELINE-093] FATAL: prompt-generator blocked` is printed and pipeline exits non-zero. Assert the run directory is preserved.
3. **Healthy run — all phases pass their gates on first check.** Assert no `inputs_produced_by_gate` entries (gate was a no-op). Assert runtime unchanged (±5%) vs pre-093 baseline.
4. **Scaffold-language gate — TypeScript project.** Assert no `.py` files appear under `.agentics/plans/scaffold/`.
5. **Scaffold-language gate — Python project.** Assert either Python scaffold is written OR `[SCAFFOLD] skipped — language mismatch` is logged and no TypeScript files are written.
6. **Regression:** ADR-089 health-gate tests all pass. ADR-088 MCP fast-return tests all pass.
7. **`execution-plan.json` mandatory emission.** Assert it exists, is valid JSON, and has at least one `implementations[]` entry in every healthy-run and every Ruflo-late-invocation scenario.

## Rollout

Single minor release. The gate is strictly additive — a phase that previously ran with degraded inputs now either runs with Ruflo-produced inputs (same or better artifacts) or is marked `blocked` (more informative failure). No behaviour regresses on the healthy path.

The scaffold-language gate is technically a behaviour change for misconfigured projects, but those projects were producing invalid output already.

Rollback plan: revert the commit that adds `gatePhaseInputs`. Coordinators return to their current silent-default behaviour; no on-disk data is lost.

## Related ADRs

- **ADR-PIPELINE-091** (Ruflo as primary engineering executor) — upstream dep. Gates invoke the same Ruflo entry point (`runPrimaryPhaseExecution`) that a phase's own coordinator invokes; there is no separate "regeneration" code path.
- **ADR-PIPELINE-092** (promotion completeness) — downstream dep. Promotes phase outputs (gate-produced or coordinator-refined) into the user-visible `.agentics/plans/` tree.
- **ADR-PIPELINE-089** (Phase 1 health gate + retry widening) — precedent for per-phase verdict classification. This ADR generalizes the verdict idea into a per-phase dependency gate for phases 2 through 5.
- **ADR-PIPELINE-088** (MCP fast-return auto-chain) — defines the `status.json` schema this ADR extends.
- **ADR-PIPELINE-083** (phase capability binding for QE) — the phase-binding mechanism whose dependency-awareness this ADR makes explicit at the graph level.
- **ADR-PIPELINE-060** (10-of-10 pipeline readiness scorecard) — the overall readiness criteria this ADR helps satisfy by eliminating silent-skip failure modes.

## References

- Run `dacf7975-1e80-413d-88d8-2fcba9a758be` — the originating failure. Under 091+093, the same run produces complete engineering artifacts (Ruflo-primary), no silent skips, no Python-into-TypeScript scaffold contamination.
- `src/pipeline/auto-chain.ts:1582+` — current unconditional TypeScript scaffold emission block; gets the language gate.
- `src/pipeline/phases/prompt-generator.ts:452` — existing "ADR-Only Prompt Generation (fallback when no DDD bounded contexts exist)" branch; parallel DDD-only branch added.
- `src/pipeline/phase3-sparc/phase3-sparc-coordinator.ts:56` — current silent-empty-default site; becomes gate-surfaced.
- `src/pipeline/phase4-adrs/phase4-adrs-coordinator.ts:56` — same.
- `src/pipeline/ruflo-phase-executor.ts` — primary executor entry (ADR-091).
