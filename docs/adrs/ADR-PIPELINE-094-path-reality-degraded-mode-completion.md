# ADR-PIPELINE-094: Closing the Phase-Skip Cascade — Path-Reality Resolution, Phase-1 Fallback Inputs, Hard Phase-5b Gate, Always-Emit Phase 6, and Machine-Readable Gate Decisions

**Status:** Accepted — Implemented (2026-04-25)
**Date:** 2026-04-25
**Implementation summary:** All 8 decisions landed in a single PR. 87 unit + benchmark tests pass; 71 existing auto-chain tests continue to pass with zero regressions. Full-degraded run completes in ~850 ms (down from ~3 min pre-094, a >200× improvement). Default-on; opt-out via `AGENTICS_DISABLE_094=1`. See "Implementation locations" at the bottom of this ADR for file-level pointers.
**Priority:** CRITICAL — A path-resolution false-negative in the ADR-093 gate causes Phase 2 to block on a Phase-1 input that exists on disk but is looked up at the wrong physical path. The block cascades to Phases 3, 4, and 5a (all skipped with "Ruflo unavailable" because Ruflo never had inputs to run on). Phase 5b runs anyway with no spec, fanning out ~76 agents that mostly time out. Phase 6 is invisible in `chainResult.phases`. End-to-end the pipeline produces planning artifacts but zero implementation prompts and no ERP surface call, regardless of what the user asked for.
**Originating Trace:** `4ed715bf-bfb5-45b5-8733-53e8d4ac571e` (water-usage / ServiceNow brief, 2026-04-25, wall time ~3m30s, exit code 0, success false).
**Builds on:** ADR-PIPELINE-093 (phase dependency self-healing gates — direct upstream; this ADR fixes its path-resolution and degraded-mode behaviour), ADR-PIPELINE-092 (runs-to-plans promotion completeness), ADR-PIPELINE-091 (Ruflo as primary engineering executor), ADR-PIPELINE-089 (Phase 1 health gate), ADR-PIPELINE-088 (auto-chain MCP status schema).

## Context

ADR-093 introduced the phase dependency gate that checks each phase's required inputs before its coordinator runs. The gate was intended to eliminate silent skips. In practice, the first end-to-end run of a non-fixture brief (`4ed715bf-...`) revealed that the gate produces a different silent failure mode: **a logical-vs-physical path mismatch causes the gate to declare inputs missing that exist on disk**, and the cascade that follows takes a different — but equally bad — shape than the silent-empty-output pattern ADR-093 set out to fix.

### What went wrong in run `4ed715bf-bfb5-45b5-8733-53e8d4ac571e`

1. **Phase 1 ran `degraded`.** Eight of twelve agents succeeded; four diligence-artifacts agents (`sparc-specification`, `sparc-merge`, `adr-generation`, `coverage-gap-detect`) errored. ADR-089's verdict allowed the chain to proceed. The four agents' actual error messages were never captured — `autochain.log` records only "errored", which prevents RCA.
2. **Phase 2 gate produced a false negative.** The gate's `PHASE_DEPENDENCIES.phase2` declares `phase1/manifest.json` as a required input (`phase-dependency-gate.ts:98`). The gate's `pathSatisfies()` joins the relative path to `runDir` literally (`phase-dependency-gate.ts:390`: `path.join(runDir, 'phase1/manifest.json')`). The actual physical layout writes Phase 1's manifest flat to `<runDir>/manifest.json` — see `swarm-orchestrator.ts:1831,2222,2229,2249,2252` where Phase 1 outputs are listed without a `phase1/` prefix. Result: the file exists, but the gate looks at the wrong absolute path, declares it missing, and blocks.
3. **The cascade.** The gate's "invoke Ruflo for the missing upstream" recovery path triggers, but the upstream owner is `phase2` (per `INPUT_OWNER_MAP['phase1/']`) which auto-chain wires through its own coordinator — and that coordinator hits the same path miss. After the 1-retry cap, Phase 2 stays blocked. Phase 3, Phase 4, and Phase 5a then each fail their own gate on the same `phase1/manifest.json` check (lines 110, 122, 159 of the dependency table), each emit `[GATE] phaseN: Ruflo unavailable`, and skip.
4. **Phase 5a produced zero prompts.** `[PLANS] MISSING prompts — no source artifacts found in any candidate directory` is logged. `prompts/impl-*.md` and `prompts/execution-plan.json` are never written. ADR-093's "mandatory Phase 5a emission" rule (Decision 4) does not fire because the gate's own predicate said the inputs were unrecoverable.
5. **Phase 5b ran anyway.** ADR-093's `phase5b-scaffold` dependency declaration (line 159) requires only `phase1/manifest.json` and lists `phase5a/execution-plan.json` as *optional*. Because the gate uses the same broken path resolution, it actually fails the `phase1/manifest.json` check too — but Phase 5b's coordinator does not honour the block in the same way Phase 5a's does. It fans out ~76 cloud agents (forge, connector-hub, edge, observatory, sentinel, shield, test-bench, schema-registry, config-manager, governance-dashboard, data-vault). Most time out at 30s; local fallbacks also time out at 30–120s. Final phase status: `failed` with "Phase 4 output not found".
6. **Phase 6 (ERP surface) never executes.** `auto-chain.ts` returns early after Phase 5 failure without pushing a Phase 6 entry to `chainResult.phases`. The trace is silent about what Phase 6 was supposed to do.
7. **End-of-run `[PLANS]` promotion runs too late.** The promotion step copies Phase-1 simulator consensus into `.agentics/plans/{adrs,ddd}/` *after* all gates have already evaluated. The artifacts exist on the filesystem but were not visible to the gates that needed them.

### The defects

The originating run exposes five composable defects, all of which must be fixed together to restore end-to-end completion under realistic degraded conditions:

- **D1 — Path-reality mismatch.** The gate's logical paths (`phase1/X`) do not match the physical layout (`<runDir>/X`). Every downstream gate inherits the false negative.
- **D2 — Phase 5a has no Phase-1 fallback.** When Phases 3 and 4 are skipped, Phase 5a's inputs are unrecoverable, even though Phase-1 simulator consensus contains enough material (executive-summary.md, decision-memo.md, scenario.json, and the consensus engineering/architecture-decisions.md that the `[PLANS]` step salvages later) to produce useful implementation prompts.
- **D3 — Phase 5b runs on weak preconditions.** It only requires `phase1/manifest.json`. When Phase 5a is skipped, Phase 5b has no concrete unit-of-work and burns ~3 minutes timing out a 76-agent fanout that produces nothing usable.
- **D4 — Phase 6 is invisible on upstream failure.** No phase-result entry is emitted, breaking the `chainResult.phases` trace contract.
- **D5 — Failures are not machine-readable.** Phase-1 diligence agent errors are dropped on the floor. Gate decisions are text-only in `autochain.log`. There is no `gate-decision-log.json` per phase. RCA requires reading log lines and pattern-matching against the dependency table.

## Decision

Eight rules. The first three close the cascade; the remaining five make failure modes legible and break Ruflo as a single point of failure.

### 1. Path-reality resolution layer in the gate

The gate MUST resolve logical phase paths against physical run-directory layout before checking existence. Introduce a single helper:

```ts
function resolvePhasePath(runDir: string, relPath: string): string
```

Resolution rules, in order:

- A leading `phase1/` prefix is stripped and the basename is resolved against `runDir` directly (Phase 1 always writes flat: `manifest.json`, `executive-summary.md`, `scenario.json`, `decision-memo.md`, `risk-assessment.json`).
- All other prefixes (`phase2/`, `phase3/`, `phase4/`, `phase5a/`, `engineering/`, `diligence-artifacts/`) resolve unchanged: `path.join(runDir, relPath)`.
- The helper is the **single** place these mappings are encoded. `pathSatisfies()` and `dirGlobSatisfies()` in `phase-dependency-gate.ts` route through it; no other code in the gate constructs absolute paths from relative ones.

Phase 1's flat layout is treated as ground truth for this ADR. We do **not** relocate Phase 1 outputs into a `phase1/` subdir — that change touches every Phase 1 consumer (research-dossier loader, artifact-loader, ruflo-phase-executor's source map, and the swarm orchestrator's manifest writer) and is rejected here on blast-radius grounds. The aliasing is the smaller, safer change.

### 2. Phase 5a accepts Phase-1 fallback inputs

`PHASE_DEPENDENCIES['phase5a-prompts']` (`phase-dependency-gate.ts:136`) gains a third tier of any-of paths consumed only when neither Phase 4 outputs nor Ruflo's `engineering/` consensus exist:

```
required:
  - any-of: phase3/sparc/specification.md
            OR engineering/sparc-specification.md
            OR phase1/decision-memo.md          # NEW: Phase-1 fallback
  - any-of: phase4/adrs/*.md
            OR phase4/ddd/bounded-contexts.json
            OR engineering/architecture-decisions.md
            OR phase1/decision-memo.md          # NEW: Phase-1 fallback
            OR phase1/scenario.json             # NEW: Phase-1 fallback
```

The prompt generator at `src/pipeline/phases/prompt-generator.ts` gains a third branch — parallel to the existing ADR-only and DDD-only branches — that consumes Phase-1 simulator consensus directly. The generator MUST produce, at a minimum:

- `prompts/execution-plan.json` — valid JSON, `implementations[]` non-empty, with each entry traced to the Phase-1 input it derived from (`source: "phase1/decision-memo.md"` etc.),
- one or more `prompts/impl-001-phase1-*.md` files — each tagged in its frontmatter with `degraded_mode: phase1-fallback` so consumers know the prompt was generated without SPARC/ADR/DDD refinement.

Quality is lower than the SPARC→ADR→DDD chain. The chain is degraded but **complete**.

### 3. Phase 5b hard-blocks on `phase5a/execution-plan.json`

`PHASE_DEPENDENCIES['phase5b-scaffold']` (`phase-dependency-gate.ts:157`) is changed from:

```ts
required: [{ kind: 'file', paths: ['phase1/manifest.json'] }],
optional: ['phase4/adrs/*.md', 'phase5a/execution-plan.json'],
```

to:

```ts
required: [
  { kind: 'file', paths: ['phase1/manifest.json'] },
  { kind: 'file', paths: ['phase5a/execution-plan.json'], minBytes: 50 },
],
optional: ['phase4/adrs/*.md'],
```

When Phase 5a is blocked or skipped, Phase 5b is also blocked — surfaced as `blocked` in `status.json`, never silently fanned-out. This is a strict regression on the previous "always-attempt-build" behaviour, but the previous behaviour produced no useful build output (only generic scaffold templates) and burned ~3 minutes per run timing out 76 agents serially. Replacing a 3-minute timeout cascade with a fast `blocked` decision is a net improvement.

### 4. Phase 6 always emits a phase-result entry

`auto-chain.ts` MUST push a `chainResult.phases[]` entry for Phase 6 in every run, regardless of upstream success/failure. When upstream fails, the entry takes the form:

```json
{
  "phaseId": "phase6",
  "status": "skipped-due-to-upstream",
  "reason": "Phase 5 (build) failed: <upstream error excerpt, max 200 chars>",
  "blocked_by": ["phase5b-scaffold"],
  "started_at": "...",
  "completed_at": "...",
  "duration_ms": 0
}
```

`status: "skipped-due-to-upstream"` is added to the ADR-088 status schema as a valid phase-result state alongside the existing `completed | failed | skipped | blocked`. Distinguished from `skipped` (which means "phase opted out") and `blocked` (which means "gate refused to run because of unrecoverable inputs from this phase's perspective"); `skipped-due-to-upstream` means "this phase did not run because an upstream phase ended in `failed` or `blocked` and we propagated".

The same rule applies to any phase that would be propagation-skipped on upstream failure. Phase 6 is the canonical example because today it is *invisible* in the trace; the rule generalizes to any future phase added after Phase 6.

### 5. Per-phase machine-readable `gate-decision-log.json`

The gate MUST write a structured per-phase log to `<runDir>/<phaseId>/gate-decision-log.json` for every gate invocation:

```json
{
  "phaseId": "phase2",
  "trace_id": "4ed715bf-...",
  "timestamp": "2026-04-25T02:56:09.123Z",
  "checked_inputs": [
    {
      "logical_path": "phase1/manifest.json",
      "resolved_path": "/home/codespace/.agentics/runs/4ed715bf-.../manifest.json",
      "exists": true,
      "size_bytes": 2456,
      "is_error_stub": false,
      "satisfies": true
    }
  ],
  "ruflo_invoked": [
    { "phase": "phase2", "tier": "unavailable", "reason": "binary-not-found" }
  ],
  "verdict": "ok",
  "still_missing": [],
  "decision_ms": 12
}
```

The text `[GATE]` log lines in `autochain.log` continue for human readability; the JSON is the source of truth for the `agentics-status` MCP tool, the `agentics ask` post-run banner, and any future RCA tooling. The schema is appended to ADR-088's status documentation. The file is small (typically <2 KB per phase) and is included in the `[PLANS]` promotion under `.agentics/plans/<phase>/gate-decision-log.json` so it survives run cleanup.

### 6. Phase 1 diligence-agent error capture

`swarm-orchestrator.ts` MUST capture each Phase-1 agent's failure with full message and stack and persist to `<runDir>/phase1/agent-errors.json`:

```json
{
  "trace_id": "...",
  "phase1_verdict": "degraded",
  "agents": [
    {
      "domain": "diligence-artifacts",
      "agent": "sparc-specification",
      "status": "errored",
      "error": {
        "type": "TimeoutError",
        "message": "agent invocation exceeded 30000ms",
        "stack_excerpt": "...",
        "first_byte_ms": 28150,
        "tier": "cloud"
      }
    }
  ]
}
```

`status.json` extends the existing ADR-089 health-gate output with `phase1.failed_agents[].error_excerpt` (first 200 chars of the message). Surfaced in the MCP `agentics-status` tool. Today these errors are dropped on the floor, which makes "4 of 12 errored" untriageable.

### 7. Cloud-agent circuit breaker for Phase 5 fanout

When the Phase 5 fanout dispatcher records N consecutive cloud-tier timeouts within the same fanout (default `N=3`, configurable per project via `agentics.config.json:pipeline.cloud_breaker_threshold`), the breaker MUST trip for the remainder of that fanout. Tripped behaviour:

- All not-yet-dispatched cloud calls in the fanout are skipped.
- All in-flight cloud calls are allowed to settle but their results are not awaited beyond their existing per-call timeout.
- Fanout proceeds with local-tier execution only.
- A single `[BREAKER] phase5: cloud breaker tripped after N timeouts (<agent classes>)` line is logged.
- The breaker state is recorded in `gate-decision-log.json` for Phase 5 and in `status.json` under `phase5.cloud_breaker: { tripped: true, after_n_timeouts: N, agents: [...] }`.

The breaker resets per phase; Phase 6 starts with cloud calls re-enabled if any Phase 6 logic uses cloud tier. The breaker does **not** trip on local-tier timeouts (which already have their own handling and are not the failure mode this rule targets).

### 8. Deterministic local fallback when Ruflo is unavailable

`runPrimaryPhaseExecution()` in `ruflo-phase-executor.ts` MUST NOT return `{ executionTier: 'unavailable' }` for Phases 3, 4, and 5a. When `checkRufloAvailable()` returns false, the executor delegates to a deterministic local generator under `src/pipeline/local-fallback/`:

- `phase3-local-fallback.ts` consumes Phase-1 `executive-summary.md`, `decision-memo.md`, `scenario.json`, and the consensus `engineering/architecture-decisions.md` (when present from Phase 1's diligence agents) and produces a minimal `phase3/sparc/specification.md` — Functional Requirements section populated from the Phase-1 brief, no pseudocode or refinement (those remain Ruflo's strengths).
- `phase4-local-fallback.ts` reads the same inputs plus the Phase-3 fallback output and produces minimal `phase4/adrs/ADR-001..N.md` (one per architecture-decision in the consensus) and `phase4/ddd/domain-model.md`.
- `phase5a-local-fallback.ts` produces the prompts described in Decision 2.

Local-fallback outputs are tagged with `_meta: { generator: "local-fallback", quality: "degraded" }` in their JSON forms and `> Generated by local fallback (Ruflo unavailable). Quality: degraded.` in their markdown forms. Consumers downstream MUST NOT distinguish on quality — degraded outputs satisfy the same gate predicates as Ruflo-produced outputs — but the tag makes the provenance explicit for auditing.

The chain proceeds end-to-end on every run, regardless of Ruflo availability. Ruflo is no longer a single point of failure for the engineering phases.

## The dependency DAG (post-094)

```
        Phase 1 (entry, flat layout — manifest.json at <runDir>/)
            │
            ▼
        Phase 2  ── requires: phase1/{manifest.json, executive-summary.md}
            │      (path-resolved via resolvePhasePath → flat at <runDir>/)
            ▼
        Phase 3  ── requires: phase1/manifest.json, phase2/research-dossier.json
   (Ruflo OR             on Ruflo-unavailable: phase3-local-fallback
    local-fallback)
            │
            ▼
        Phase 4  ── requires: phase1/manifest.json,
   (Ruflo OR             phase3/sparc/specification.md
    local-fallback)      OR engineering/sparc-specification.md
            │
            ▼
    ┌───────┴────────┐
    ▼                ▼
Phase 5a          Phase 5b
(prompts,         (scaffold,
 mandatory)        hard-blocks on phase5a/execution-plan.json)

Phase 5a requires: sparc spec
                   AND (phase4 ADRs OR DDD OR engineering decisions
                        OR phase1/decision-memo.md OR phase1/scenario.json)
                   on missing-everything: phase5a-local-fallback
                                          (Phase-1 consensus prompts)

Phase 5b requires: phase1/manifest.json AND phase5a/execution-plan.json (>=50B)
            │
            ▼
        Phase 6  ── always emits a phase-result entry
                   (status: completed | failed | skipped-due-to-upstream)
```

## Consequences

### Positive

- **End-to-end completion under degraded conditions.** A run with Ruflo unavailable AND remote diligence partially failed AND four of twelve Phase-1 agents erroring still completes Phases 1–6 and produces non-zero artifacts in `.agentics/plans/{sparc, adrs, ddd, prompts}/`. The originating run `4ed715bf-...` would emit ≥1 implementation prompt under the new rules.
- **The path-reality mismatch is eliminated.** A single `resolvePhasePath()` helper centralises the logical-vs-physical mapping. Future phases that adopt their own physical layouts add one entry to the helper; the dependency table stays declarative.
- **Failures are observable.** Every gate decision is machine-readable; every Phase-1 agent failure carries its error message; every breaker trip is logged with a state record. RCA tools can read JSON instead of grepping logs.
- **Phase 6 is no longer invisible.** The trace contract holds even when Phase 5 fails.
- **Ruflo is no longer a single point of failure.** Local fallback generators consume Phase-1 consensus deterministically; the chain's success criterion no longer depends on Ruflo availability.
- **Cloud-tier failures are bounded.** The circuit breaker caps Phase 5 wall time at `N × cloud_timeout` seconds + local fallback time, instead of `(76 × cloud_timeout)` seconds at the worst case.

### Negative

- **Phase 5b hard-block is a behaviour regression.** Runs that previously appeared to proceed through Phase 5b (even though the output was useless) now block. Visible failure replaces silent waste. The change is intentional but will produce more `blocked` verdicts in the short term while users adapt their expectations.
- **Local fallback artifacts are lower-quality than Ruflo's.** Pipelines that complete via local fallback emit "good enough to chain through" outputs, not "production-grade SPARC/ADR/DDD". Tagged `quality: degraded` so consumers know.
- **Schema growth.** `status.json` gains `phase1.failed_agents[]`, `phase5.cloud_breaker`, `phase6` always-present entry, `gate-decision-log.json` per-phase paths, and the new `skipped-due-to-upstream` state. All additive; ADR-088 schema rev bumped from `1.x` to `1.{x+1}` (minor; backwards compatible).
- **Local fallback adds maintenance surface.** Three new generators live in `src/pipeline/local-fallback/` and must stay in lockstep with Ruflo's outputs (same gate predicates, same artifact filenames). Tests assert the predicate parity.

### Neutral

- The `[PLANS]` promotion step (ADR-092) keeps its end-of-run salvage behaviour. Under 094, salvage rarely has anything to salvage because the gates now succeed on the first pass — but the salvage remains as defence-in-depth for unforeseen layout drift.
- The "Ruflo cap of 1 retry per missing-input" rule from ADR-093 carries over unchanged. The local fallback runs *after* the Ruflo cap, in the same gate invocation; together they produce at most one Ruflo attempt + one local-fallback attempt per missing input.
- ADR-093's mandatory Phase 5a emission rule (its Decision 4) is **strengthened**, not relaxed: 094 closes the loophole where the gate's predicate could declare Phase 5a unrecoverable.

## Implementation plan

No code in this ADR. The landing PR touches:

- **`src/pipeline/gate/phase-dependency-gate.ts`**:
  - Add `resolvePhasePath(runDir, relPath)` helper at module scope; export for unit tests.
  - Update `pathSatisfies()` (line 386) and `dirGlobSatisfies()` (referenced from line 388) to route through `resolvePhasePath()`. No other code in the file constructs absolute paths.
  - Extend `PHASE_DEPENDENCIES['phase5a-prompts']` with the Phase-1 fallback any-of paths (Decision 2).
  - Update `PHASE_DEPENDENCIES['phase5b-scaffold']` to require `phase5a/execution-plan.json` (Decision 3).
  - Add `writeGateDecisionLog(runDir, phaseId, log)` helper and call it from `gatePhaseInputs()` after the verdict is computed (Decision 5).
- **`src/pipeline/auto-chain.ts`**:
  - Always emit a Phase 6 phase-result entry. Push `{ phaseId: 'phase6', status: 'skipped-due-to-upstream', ... }` at the top of the Phase 6 dispatcher when any upstream phase has status `failed` or `blocked` (Decision 4).
  - Add the `skipped-due-to-upstream` state to the phase-result type union and to the status-json writer.
- **`src/pipeline/phases/prompt-generator.ts`**:
  - Accept `phase1/decision-memo.md` and `phase1/scenario.json` as input candidates.
  - Add a third branch parallel to the existing ADR-only and DDD-only branches that produces prompts from Phase-1 consensus only (Decision 2).
  - Tag generated prompts with `degraded_mode: phase1-fallback` in frontmatter when this branch fires.
- **`src/pipeline/swarm-orchestrator.ts`**:
  - In the Phase 1 dispatch loop, capture each agent's `result.error.message` and `result.error.stack` (Decision 6).
  - Persist `<runDir>/phase1/agent-errors.json`.
  - Surface a 200-char excerpt in `status.json` under `phase1.failed_agents[].error_excerpt`.
  - In the Phase 5 fanout, add a `CloudCircuitBreaker` class (Decision 7). Trip after N consecutive cloud timeouts; route remaining dispatches to local-tier; record state.
- **`src/pipeline/ruflo-phase-executor.ts`**:
  - In `runPrimaryPhaseExecution()`, when `checkRufloAvailable()` returns false, delegate to the local-fallback generator for the requested phase instead of returning `{ executionTier: 'unavailable' }` (Decision 8).
  - The `executionTier` field gains a new value `'local-fallback'`; consumers (status writer, plans promotion) propagate it transparently.
- **`src/pipeline/local-fallback/` (new directory)**:
  - `phase3-local-fallback.ts` — consumes Phase-1 consensus, produces minimal SPARC specification.
  - `phase4-local-fallback.ts` — produces minimal ADRs and domain model.
  - `phase5a-local-fallback.ts` — produces minimal implementation prompts.
  - All three share a `phase1ConsensusReader.ts` that loads Phase-1 outputs (with `resolvePhasePath`) and exposes a typed `Phase1Consensus` shape.
- **Tests** (new, under `tests/pipeline/`):
  - `gate-path-resolution.test.ts` — covers `resolvePhasePath` mappings.
  - `phase5a-phase1-fallback.test.ts` — synthesizes a run with only Phase-1 outputs; asserts prompt generator produces ≥1 impl prompt and a valid execution-plan.json.
  - `phase5b-hard-block.test.ts` — synthesizes a run without `phase5a/execution-plan.json`; asserts Phase 5b is `blocked`, fanout never starts.
  - `phase6-always-emit.test.ts` — forces Phase 5 failure; asserts `chainResult.phases` contains a Phase 6 entry with status `skipped-due-to-upstream`.
  - `gate-decision-log.test.ts` — asserts log file exists with documented schema for every gate invocation.
  - `phase1-error-capture.test.ts` — forces a diligence agent to throw; asserts message/stack persisted.
  - `cloud-circuit-breaker.test.ts` — mocks 3 cloud timeouts; asserts breaker trips and remaining dispatches are local.
  - `ruflo-unavailable-end-to-end.test.ts` — runs full pipeline with `RUFLO_DISABLED=1`; asserts end-to-end completion with degraded outputs.
  - `originating-run-regression.test.ts` — replays `4ed715bf-...` scenario (4/12 Phase-1 agents errored, Ruflo unavailable, ServiceNow brief); asserts end-to-end completion with non-zero `prompts/` and a Phase 6 entry.
- **Documentation**:
  - Append the new `gate-decision-log.json` schema and the `skipped-due-to-upstream` state to ADR-088's documented MCP status schema.
  - No README changes (per project convention).

## Verification

Before merge, the following scenarios MUST pass:

1. **Path-reality regression.** Phase 1 manifest at `<runDir>/manifest.json`. `gatePhaseInputs('phase2', { runDir })` returns `ok=true`. Pre-094 returned `ok=false`. The single test that catches the originating defect.
2. **Phase 5a Phase-1 fallback.** Synthesize a run directory with `manifest.json`, `executive-summary.md`, `decision-memo.md`, `scenario.json` only — no `phase2/`, `phase3/`, `phase4/`, `engineering/`. Run Phase 5a's gate. Assert `ok=true` (the new any-of branch). Run the prompt generator. Assert `prompts/execution-plan.json` is valid JSON, `implementations[].length >= 1`, at least one `prompts/impl-001-phase1-*.md` exists, frontmatter contains `degraded_mode: phase1-fallback`.
3. **Phase 5b hard-block.** Synthesize a run with `manifest.json` but no `phase5a/execution-plan.json`. Run the gate. Assert `ok=false`, `stillMissing` contains `phase5a/execution-plan.json`. Run the Phase 5b coordinator wired to the gate. Assert it does NOT dispatch any cloud agents and emits `blocked` in `status.json`.
4. **Phase 6 always-emits.** Force Phase 5 to return `failed`. Run end-to-end. Assert `chainResult.phases.find(p => p.phaseId === 'phase6')` exists with `status === 'skipped-due-to-upstream'` and a non-empty `reason`.
5. **Gate-decision-log schema.** Run any phase. Assert `<runDir>/<phase>/gate-decision-log.json` exists, parses as JSON, conforms to the documented schema (every documented field present, types correct, `verdict` ∈ `{ok, blocked}`).
6. **Phase 1 agent error capture.** Mock one Phase-1 diligence agent to throw `new Error("synthetic test failure")`. Run Phase 1. Assert `<runDir>/phase1/agent-errors.json` exists, contains the agent's name, the message `"synthetic test failure"`, and a non-empty `stack_excerpt`. Assert `status.json.phase1.failed_agents[0].error_excerpt` starts with `"synthetic test failure"`.
7. **Cloud circuit breaker.** Mock 3 cloud agents to timeout. Run Phase 5 fanout. Assert breaker trips after the third timeout. Assert subsequent dispatches in the same fanout use local tier. Assert `status.json.phase5.cloud_breaker.tripped === true` and `after_n_timeouts === 3`.
8. **Ruflo unavailable end-to-end.** Run with `RUFLO_DISABLED=1` (or equivalent forcing of `checkRufloAvailable() === false`). Run a complete pipeline. Assert all six phases produce a phase-result entry in `chainResult.phases`. Assert `.agentics/plans/{sparc, adrs, ddd, prompts}/` are all populated. Assert at least one artifact in each tagged `quality: degraded`.
9. **Originating-run regression.** Replay the `4ed715bf-...` scenario: Ruflo unavailable, 4/12 Phase-1 agents forced to error (sparc-specification, sparc-merge, adr-generation, coverage-gap-detect), water-usage / ServiceNow brief. Run end-to-end. Assert: success=true, exitCode=0, `prompts/impl-*.md` count >= 1, `prompts/execution-plan.json` valid, Phase 6 entry present (status either `completed` or `skipped-due-to-upstream` depending on Phase 5 outcome).
10. **Backwards compatibility.** All ADR-091, 092, 093 tests pass unchanged. ADR-089 health-gate tests pass. ADR-088 MCP fast-return tests pass.

## Rollout

Single minor release, gated behind a feature flag for one release cycle, then on by default.

- **Phase A (this PR)**: ship behind `agentics.config.json:pipeline.use_094_gates` (default `false`). All eight rules gated. Tests run with the flag ON.
- **Phase B (next minor release)**: flip the default to `true`. Existing users on the previous default stay on legacy behaviour by setting the flag to `false` in their config.
- **Phase C (release after that)**: remove the flag. Legacy code paths deleted.

The Phase 5b hard-block and the path-reality fix are technically behaviour changes for runs in flight; the flag protects users mid-migration. All other changes (Phase-6 always-emit, gate-decision-log, error capture, breaker, local fallback) are strictly additive on the healthy path and need no flag — but they ship together for cohesion.

Rollback plan: flip the flag to `false`. Code paths revert to ADR-093's behaviour. No on-disk data is lost; `gate-decision-log.json` files written under the new behaviour remain as historical record but are not consumed by the legacy path.

## Related ADRs

- **ADR-PIPELINE-093** (phase dependency self-healing gates) — direct upstream. 094 closes 093's path-resolution defect, adds the Phase-1 fallback branch 093 mandates but did not make recoverable, makes Phase 5b's gate honour 093's intent (block, not silently proceed), and replaces 093's text-only `[GATE]` log with machine-readable `gate-decision-log.json`.
- **ADR-PIPELINE-092** (runs-to-plans promotion completeness) — downstream. 094's local-fallback artifacts and `gate-decision-log.json` are promoted under the same rules.
- **ADR-PIPELINE-091** (Ruflo as primary engineering executor) — 094 makes Ruflo no-longer-a-single-point-of-failure by adding deterministic local fallbacks. 091's "primary" status is preserved on the healthy path; local fallback fires only when Ruflo is unavailable.
- **ADR-PIPELINE-089** (Phase 1 health gate + retry widening) — 094's Decision 6 (Phase 1 agent error capture) extends 089's verdict mechanism with per-agent error detail.
- **ADR-PIPELINE-088** (auto-chain MCP status schema) — 094 extends the schema with `skipped-due-to-upstream`, `gate-decision-log.json` paths, `phase1.failed_agents[]`, and `phase5.cloud_breaker`. Schema rev bumped (minor; backwards compatible).
- **ADR-PIPELINE-083** (phase capability binding for QE) — unaffected; 094 operates above the binding layer.
- **ADR-PIPELINE-060** (10-of-10 pipeline readiness scorecard) — 094 closes the readiness gaps that the originating run exposed: end-to-end completion under degraded conditions, observable failures, no silent skips, no single point of failure.

## References

- **Run `4ed715bf-bfb5-45b5-8733-53e8d4ac571e`** — the originating failure (water-usage / ServiceNow brief, 2026-04-25). Wall time 3m30s, exit code 0, success=false. Phase 1 verdict `degraded` (8/12 agents OK), Phases 2–5a all skipped on path-resolution false negative, Phase 5b failed after 76-agent fanout timeout cascade, Phase 6 never recorded. Implementation-prompts produced: 0. ERP-surface calls attempted: 0. Under 094, the same run produces ≥1 implementation prompt via Phase-1 fallback and an emitted Phase 6 entry.
- `src/pipeline/gate/phase-dependency-gate.ts:98,110,122,159` — the hard-coded `phase1/manifest.json` references that drive the false-negative cascade.
- `src/pipeline/gate/phase-dependency-gate.ts:386` — `pathSatisfies()` site for the resolution layer.
- `src/pipeline/swarm-orchestrator.ts:1831,2222,2229,2249,2252` — Phase 1's flat physical layout (manifest.json, executive-summary.md, scenario.json, decision-memo.md, risk-assessment.json all written without a `phase1/` prefix).
- `src/pipeline/phases/prompt-generator.ts` — site of the new Phase-1 fallback branch (parallel to existing ADR-only and DDD-only branches per ADR-093).
- `src/pipeline/ruflo-phase-executor.ts:288` — `checkRufloAvailable()` site; new local-fallback delegation point.
- `src/pipeline/auto-chain.ts` — Phase 6 dispatcher site for the always-emit rule.

## Implementation locations

| Decision | Files touched | Tests |
|----------|--------------|-------|
| D1 — path resolution | `src/pipeline/gate/phase-dependency-gate.ts` (`resolvePhasePath`, `pathSatisfies`, `dirGlobSatisfies`) | `tests/unit/pipeline/gate/phase-dependency-gate-094.test.ts` |
| D2 — Phase-1 fallback inputs | `src/pipeline/gate/phase-dependency-gate.ts` (PHASE_DEPENDENCIES.phase5a-prompts), `src/pipeline/phases/prompt-generator.ts` (`executePhase1FallbackPromptGeneration`, `buildPhase1FallbackPromptMarkdown`) | `tests/unit/pipeline/phases/prompt-generator-094.test.ts` |
| D3 — Phase 5b hard-block | `src/pipeline/gate/phase-dependency-gate.ts` (PHASE_DEPENDENCIES.phase5b-scaffold) | `tests/unit/pipeline/gate/phase-dependency-gate-094.test.ts` |
| D4 — Phase 6 always-emit | `src/pipeline/auto-chain.ts` (`PhaseStatus`, `pushSkippedDueToUpstream`, 3 early-return wirings, icon renderers) | `tests/unit/pipeline/auto-chain-094.test.ts` |
| D5 — gate-decision-log.json | `src/pipeline/gate/phase-dependency-gate.ts` (`CheckedInput`, `RufloInvocationLog`, `GateDecisionLog`, `PHASE_DIRNAME`, `writeGateDecisionLog`, `inspectPath`, `inspectFile`) | `tests/unit/pipeline/gate/phase-dependency-gate-094.test.ts` |
| D6 — Phase 1 error capture | `src/pipeline/enterprise/types.ts` (`AgentInvocationError`), `src/pipeline/enterprise/pass-executor.ts` (`invokeAgent`), `src/pipeline/enterprise/agent-error-capture.ts` (new), `src/pipeline/enterprise/pipeline-orchestrator.ts` (`persistAgentErrors` wiring) | `tests/unit/pipeline/enterprise/agent-error-capture-094.test.ts` |
| D7 — cloud circuit breaker | `src/pipeline/swarm-orchestrator.ts` (`CloudCircuitBreaker`, `resolveCloudBreakerThreshold`, `getCloudBreakerState`, `dispatchAgenticsServices` wiring) | `tests/unit/pipeline/swarm-orchestrator-094.test.ts` |
| D8 — local fallback | `src/pipeline/local-fallback/phase1-consensus-reader.ts`, `phase3-local-fallback.ts`, `phase4-local-fallback.ts`, `phase5a-local-fallback.ts` (all new), `src/pipeline/ruflo-phase-executor.ts` (`tryLocalFallback`, executionTier extension) | `tests/unit/pipeline/local-fallback/local-fallback-094.test.ts` |
| Feature flag | `src/pipeline/gate/feature-flags.ts` (new) | `tests/unit/pipeline/gate/feature-flags-094.test.ts` |
| Benchmarks | n/a | `tests/benchmark/adr-094-bench.test.ts` |
| Test infra fix | `jest.config.js` (ts-jest tsconfig override unblocks pre-existing `import.meta` compile errors) | n/a |

**Test totals:** 90 ADR-094 tests pass; 71 existing auto-chain tests pass unchanged. End-to-end full-degraded run completes in ~850 ms vs ~180 s pre-094 (>200× improvement). Per-gate decision: <50 ms. Local-fallback chain (phase3+4+5a): <10 ms.

**D6 status-writer integration:** `writeFailedAgentsToStatus` patches `<runDir>/status.json` with `phase1.failed_agents[]` (200-char excerpts), `phase1.failed_agents_count`, and `phase1.failed_agents_captured_at`. Wired into the enterprise pipeline orchestrator alongside `persistAgentErrors`; existing `phase1` fields (verdict, reason, stats) are preserved. Atomic write via temp+rename; no-op when status.json doesn't exist.
