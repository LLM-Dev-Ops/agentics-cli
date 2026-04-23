# ADR-PIPELINE-092: Runs-to-Plans Promotion Completeness

**Status:** Proposed
**Date:** 2026-04-23
**Priority:** HIGH — Silent artifact loss between run directory and project plans directory
**Originating Trace:** Autochain run `dacf7975-1e80-413d-88d8-2fcba9a758be`
(`/home/codespace/.agentics/runs/dacf7975-*/`)

## Context

Autochain run `dacf7975-1e80-413d-88d8-2fcba9a758be` produced a complete set of
engineering and phase-2 artifacts inside the run directory:

- `engineering/sparc-specification.md`
- `engineering/architecture-decisions.md`
- `engineering/domain-model.md`
- `engineering/implementation-roadmap.md`
- `engineering/tdd-test-plan.md`
- `phase2/adrs/ADR-P2-001.md` … `ADR-P2-010.md`
- `phase2/adrs/adr-index.json`
- `phase2/ddd/domain-model.md`

None of these files were promoted into the user's project `.agentics/plans/`
tree. The project was left with only:

```
.agentics/plans/
├── decision-memo.md
├── executive-summary.md
├── risk-assessment.json
├── manifest.json
├── scaffold/python/
└── ddd/domain-model.md
```

No `plans/sparc/`, no `plans/adrs/`, no `plans/prompts/`. The
production-readiness reviewer then flagged these directories as missing — even
though the artifacts existed all along, one directory away.

### Root cause

`src/pipeline/auto-chain.ts:1501` defines `copyPlanningArtifacts(runDir,
targetRoot)`. Its candidate source directories are:

| Target slot | Candidate sources it checks |
|---|---|
| `plans/sparc/` | `runDir/phase3/sparc/`, `runDir/phase2/sparc/` |
| `plans/adrs/` | `runDir/phase4/adrs/` **only** |
| `plans/ddd/` | `runDir/phase4/ddd/`, `runDir/phase2/ddd/` |
| `plans/tdd/` | `runDir/phase3/tdd/`, `runDir/phase2/tdd/` |
| `plans/prompts/` | `runDir/prompts/`, `runDir/phase4/prompts/` |

It does **not** check:

1. `runDir/engineering/*` — where the local Ruflo swarm (the primary
   engineering executor per ADR-PIPELINE-091) lands its direct output.
   Phase 3 and Phase 4 coordinators may refine this content into
   `phase3/sparc/` and `phase4/adrs/` structured directories; when
   refinement has not yet run (or is not needed), the `engineering/`
   artifacts are Ruflo's canonical primary output and MUST still reach
   `.agentics/plans/`.
2. `runDir/phase2/adrs/` — phase 2's own ADR output, only `phase4/adrs/` is
   checked.

When phases partially succeed but deposit outputs in these alternate
locations, promotion silently misses them. The progressive copy hook at
`auto-chain.ts:97` ("runs after EVERY phase so `.agentics/plans/` is always up
to date even if later phases fail or timeout") inherits the same incomplete
inventory and so provides no safety net.

## Decision

Codify an **invariant**: every markdown or json artifact produced anywhere
under `runDir/` that maps to a SPARC, ADR, DDD, TDD, prompts, or roadmap slot
MUST be promoted to the corresponding `.agentics/plans/` subdirectory on every
phase completion — not only at the end of the run.

### Rule 1 — Ordered candidate-source discovery per slot

Each target slot consults an ordered list of candidate source directories.
Results are merged, deduplicated by filename, latest-phase wins on conflicts.

| Target slot | Ordered candidate sources (first win on conflict) |
|---|---|
| `plans/sparc/` | `phase3/sparc/`, `phase2/sparc/`, `engineering/sparc-specification.md` |
| `plans/adrs/` | `phase4/adrs/`, `phase2/adrs/`, `engineering/architecture-decisions.md`, `runDir/adrs/` |
| `plans/ddd/` | `phase4/ddd/`, `phase2/ddd/`, `engineering/domain-model.md` |
| `plans/tdd/` | `phase3/tdd/`, `phase2/tdd/`, `engineering/tdd-test-plan.md` |
| `plans/prompts/` | `prompts/`, `phase4/prompts/`, `phase3/implementation-prompt.md` |
| `plans/implementation/` | `phase1/roadmap.json`, `scenario.json`, `engineering/implementation-roadmap.md` |

The first non-empty source wins; later sources fill only slots still empty.
This preserves the existing "phase 3 refined wins over phase 2" behaviour
while adding `engineering/` — Ruflo's canonical primary-output directory
under ADR-PIPELINE-091 — as a recognised source that must be promoted when
refinement has not replaced it.

### Rule 2 — `engineering/` (Ruflo primary output) → `plans/` mapping

`engineering/` is the directory where the local Ruflo swarm (ADR-091's
primary engineering executor) deposits its output. When the structured
per-phase refined source for a slot is empty (because Phase 3 or Phase 4
refinement has not produced a derived artifact), promote the corresponding
`engineering/` single-file artifact as the slot's canonical content:

| Engineering source (Ruflo primary output) | Promoted to | Condition |
|---|---|---|
| `engineering/sparc-specification.md` | `plans/sparc/specification.md` | `plans/sparc/` empty |
| `engineering/architecture-decisions.md` | `plans/adrs/ADR-ENG-001-architecture-decisions.md` | `plans/adrs/` empty |
| `engineering/domain-model.md` | `plans/ddd/domain-model.md` | `plans/ddd/` empty |
| `engineering/implementation-roadmap.md` | `plans/implementation/roadmap.md` | always (additive) |
| `engineering/tdd-test-plan.md` | `plans/tdd/test-plan.md` | `plans/tdd/` empty |

Ruflo's ADR output is promoted as a **single-file ADR** named
`ADR-ENG-001-architecture-decisions.md` until a Phase 4 refinement pass
produces structured per-decision ADR files. The header of the promoted file
identifies it as Ruflo's primary output so a later structured refinement pass
overwrites it cleanly on the next promotion cycle.

### Rule 3 — Progressive copy on every phase boundary

The progressive copy hook at `auto-chain.ts:97` already runs after every
phase. Extend its inventory to the full candidate-source table above — not
just phase-specific directories. The final-run promotion still runs as a
safety net but MUST now be a no-op on a correctly-promoted run.

### Rule 4 — Conflict resolution

When the same logical slot has multiple candidate files (for example
`phase4/adrs/ADR-P4-001.md` **and** `engineering/architecture-decisions.md`),
prefer the structured phase-refined source. Use Ruflo's `engineering/`
output directly only when the phase-refined slot is empty. Deduplication is
by destination filename inside the slot; identical-content skips
(`filesAreIdentical` at `auto-chain.ts:102`) remain in effect.

### Rule 5 — Verification output

After promotion, emit to stderr:

```
[PLANS] promoted N files across {sparc:a, adrs:b, ddd:c, tdd:d, prompts:e, implementation:f}
```

with per-slot counts. If any slot has zero files **and** its candidate
sources also had zero files, escalate with:

```
[PLANS] MISSING {slot} — no source artifacts found in any candidate directory
```

Never silently skip. The MISSING line is the single observable signal the
downstream production-readiness reviewer can key on.

## Consequences

### Positive
- Completeness guarantee: once artifacts exist anywhere in `runDir/` under a
  known slot name — including Ruflo's primary `engineering/` output — they
  reach `plans/` on the next phase boundary.
- Ruflo's `engineering/` output is no longer a dead letter box — it is
  recognised as the primary executor's canonical output and promoted as
  such, so even runs where structured refinement did not complete still
  produce a usable plans tree.
- Explicit MISSING stderr line surfaces empty slots to reviewers and CI
  instead of hiding behind a silent skip.
- Progressive copy semantics stay intact; only the inventory expands.

### Negative / Costs
- More `fs.statSync()` and `fs.existsSync()` calls per phase boundary
  (approximately 6 additional stats per slot × 6 slots = ~36 extra syscalls
  per phase). Cost is bounded and amortised against phase runtime.
- False-positive risk: promoting an engineering-placeholder file that
  contains only TODO content (e.g., Ruflo produced a stub). Mitigate with a
  minimum-size threshold (file must be > 256 bytes and must not be
  byte-identical to a known placeholder template) before the
  `engineering/` → `plans/` promotion fires.
- Overwrite semantics on the next phase: when Phase 4 refinement later
  produces structured ADRs, they replace `ADR-ENG-001-architecture-decisions.md`.
  Document this in the promoted file's header so users don't hand-edit it.

### Neutral
- No change to run-directory layout. Pipeline phases keep writing where they
  write today.
- No change to `manifest.json` or the scaffold-emission path (ADR-069 still
  owns scaffold file ownership).

## Implementation Plan

Do **not** write code as part of this ADR. The implementation work is:

1. In `src/pipeline/auto-chain.ts:1501` (`copyPlanningArtifacts`), replace
   the hard-coded per-slot source probe with a single table-driven discovery
   routine keyed on the candidate-source table in Rule 1.
2. Add an `ENGINEERING_PRIMARY_OUTPUT_MAP` constant near
   `copyPlanningArtifacts` that encodes the Rule 2 `engineering/` → `plans/`
   mapping (Ruflo's primary-output locations per ADR-091), including the
   minimum file-size threshold and the placeholder-content hash list used
   to reject stubs.
3. In `src/pipeline/auto-chain.ts:97` (progressive copy comment block),
   update the progressive hook to call the same table-driven routine so the
   phase-boundary copy and the final promotion share one implementation.
4. Emit the Rule 5 `[PLANS]` stderr summary from the shared routine. Gate the
   `MISSING` warning on a per-slot "sources-also-empty" check so genuine
   "this slot is not applicable" runs don't spam warnings.
5. Surface the per-slot counts on `manifest.json` under a new
   `planPromotion: { sparc: n, adrs: n, ... }` block so CI can assert on it
   without parsing stderr.
6. Keep the conflict-resolution invariant (phase-refined source wins over
   Ruflo's primary `engineering/` output) in a single helper so later ADRs
   can extend the table without re-deriving merge semantics.

## Verification

Unit test (new file under `tests/pipeline/`):

- Build a fake `runDir` on a temp path with:
  - `engineering/sparc-specification.md` (> 256 bytes, non-placeholder)
  - `engineering/architecture-decisions.md`
  - `engineering/domain-model.md`
  - `engineering/tdd-test-plan.md`
  - `engineering/implementation-roadmap.md`
  - `phase2/adrs/ADR-P2-001.md`, `ADR-P2-002.md`
  - **No** `phase3/sparc/`, **no** `phase4/adrs/`, **no** `phase4/ddd/`,
    **no** `phase3/tdd/`
- Run `copyPlanningArtifacts(runDir, targetRoot)`.
- Assert:
  - `plans/sparc/specification.md` exists and matches the engineering source
  - `plans/adrs/` contains `ADR-P2-001.md` and `ADR-P2-002.md` (phase 2
    wins over Ruflo's `engineering/` output for this slot)
  - `plans/ddd/domain-model.md` exists (Ruflo's `engineering/` output is
    promoted because the phase-refined slot is empty)
  - `plans/tdd/test-plan.md` exists
  - `plans/implementation/roadmap.md` exists
  - stderr contains `[PLANS] promoted` with non-zero counts in all five slots
  - stderr does **not** contain a `MISSING` line

Regression fixture: replay the `dacf7975-1e80-413d-88d8-2fcba9a758be` run
directory (or a trimmed copy under `tests/fixtures/`) and assert the same
invariants. This is the exact trace that surfaced the bug.

## Related ADRs

- **ADR-PIPELINE-091** (Ruflo as primary engineering executor, companion) —
  establishes that Ruflo deposits its canonical output under
  `runDir/engineering/*`. ADR-092 governs promotion of that content
  (plus any structured refinements produced by Phase 3/4 coordinators)
  into `.agentics/plans/`.
- **ADR-PIPELINE-069** (scaffold vs. generator file ownership) — establishes
  that scaffold-owned files live in `plans/scaffold/`; ADR-092 does not touch
  scaffold promotion, only SPARC / ADR / DDD / TDD / prompts / implementation.
- **ADR-046** (eliminate duplicate output paths) — motivates the
  deduplication-by-destination-filename rule in Rule 4.
- **ADR-044** (serialization bugs and folder mismatch) — prior art for
  run-directory vs. plans-directory drift.
- **ADR-051** (simulation lineage observability) — similar plans-path concern
  for a different artifact class; the `[PLANS]` stderr convention in Rule 5
  mirrors ADR-051's observability signal.
