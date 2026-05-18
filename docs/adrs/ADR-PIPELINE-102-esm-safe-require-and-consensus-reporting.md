# ADR-PIPELINE-102: ESM-Safe `require` for Ruflo Probe + Consensus Reporting Fix

**Status:** Implemented in v2.7.40 (commit `7a42d27`)
**Date:** 2026-05-18
**Priority:** CRITICAL — Root cause of "no ADRs, canned SPARC, no implementation prompts" across every install since the package became ESM
**Builds on:** ADR-PIPELINE-101 (harness prompts) — which were correct but never reached Ruflo because of this bug

---

## Context

Field diagnostic from a 2.7.39 run in the consumer repo (`agentics-cli-test`) surfaced two distinct bugs that combined produced the user-visible "pipeline ran but produced garbage" symptom.

### Bug 1: Ruflo probe lied "unavailable" on every install

Three runtime sites used bare `require()` to dynamically load modules:

- `src/synthesis/ask-artifact-writer.ts:134` — loads `ruflo-phase-executor.js` to probe ruflo availability for the runtime lineage block
- `src/synthesis/simulation-artifact-generator.ts:909` — mirror of the above for the full-fleet path
- `src/mcp/mcp-server.ts:972` — loads `node:child_process` to call `git rev-parse --show-toplevel` for project root detection

The package is `"type": "module"` in `package.json`. Under ESM, bare `require` is **not defined** as a global; calling it throws `ReferenceError: require is not defined`. All three sites had the call inside a `try { ... } catch { ... }` block that swallowed the error and fell back to a "probe failed" return value.

Concrete consequence: `manifest.json.runtime.ruflo` showed `{ available: false, reason: "probe-threw" }` on every install — even when `ruflo --version` worked perfectly on PATH. The pipeline thought ruflo was missing → ADR generation took the loud-failure path and emitted `ADR-FAIL-001-adr-generation-failed.md` stubs → no implementation prompts were generated → Phase 7 deliverables had no upstream input.

The new harness prompts (ADR-PIPELINE-101) were correct and shipped in 2.7.39. They never reached Ruflo because the probe lied that Ruflo wasn't there.

### Bug 2: "Consensus at 0%" inline summary contradicted `consensus.json` at 81%

`validateConsensusResults` in `simulation-artifact-generator.ts:982` extracts an agreement level from the `analytics-hub/consensus` agent's response. It tries three response-shape paths in order:

1. `response.confidence_aggregation.overall_confidence` × 100
2. `response.overall_confidence` × 100
3. `response.consensus_result.agreement_areas.length / (agreement_areas.length + disagreement_areas.length)`

If none of the three schemas match (which happens when the consensus agent returns a response in an unrecognised shape), the code fell through with `agreementLevel: 0` and `hasConsensus: true`. The `consensus-low` degradation then fired with "Consensus at 0%" — even though the fleet-wide consensus computed elsewhere (by `consensus-tiers.ts`, persisted to `consensus.json`) showed 81% directional agreement.

Two different metrics, same name. The misleading degradation was the only thing the user saw in the inline summary — they were told "Phase 1 verdict: degraded — consensus-low — Consensus at 0%" while the persisted artifact said 81%. Both numbers were on disk; they just disagreed.

## Decision

### 1. ESM-safe `require` via `createRequire(import.meta.url)`

Each affected file gets a static import + module-level shim:

```typescript
import { createRequire } from 'node:module';
const esmRequire = createRequire(import.meta.url);
```

All in-function call sites change from `require('...')` to `esmRequire('...')`. This works in ESM because `createRequire` is the documented ESM-compatible bridge to CommonJS-style dynamic require.

Affected files (all in v2.7.40):
- `src/synthesis/ask-artifact-writer.ts`
- `src/synthesis/simulation-artifact-generator.ts`
- `src/mcp/mcp-server.ts`

The runtime probe catch blocks also now **log the actual error message** to stderr instead of silently swallowing it. The `reason` field in the returned probe shape includes the error message verbatim (e.g., `probe-threw: ENOENT: no such file or directory`) so future probe failures surface immediately.

### 2. `validateConsensusResults` returns `hasConsensus: false` when schema is unrecognised

Track an `extracted` flag inside the three-path schema check. When none of the paths produced a number, return `{ hasConsensus: false, agreementLevel: 0, ... }` — same shape as when the consensus agent didn't run at all. This prevents the misleading `consensus-low` degradation from firing.

The fleet-wide consensus computed by `consensus-tiers.ts` and persisted to `consensus.json` remains the only source of truth for the user-facing summary.

## Implementation

Single commit on `main`: `7a42d27` — `fix: ESM-safe require for ruflo probe + consensus 0% reporting bug — 2.7.40`.

4 files changed, 46 insertions, 14 deletions.

Published as `@llm-dev-ops/agentics-cli@2.7.40`.

## Validation

- `tsc --noEmit`: clean
- `npm run build`: clean
- In-repo smoke test after the fix:
  ```
  Ruflo probe: {"available":true,"version":"ruflo v3.5.2",
                "binary":"/.../node_modules/.bin/ruflo"}
  ```
  Before the fix: `{ available: false, reason: "version-probe-failed" }` — silent ReferenceError at the call site, ruflo never invoked.
- Dynamic-load test: both `ask-artifact-writer.js` and `simulation-artifact-generator.js` import cleanly via `import()` — previously threw `ReferenceError: require is not defined` at the bare `require('...')` line.

## Consequences

### Positive

- **Ruflo is actually available again.** All install environments report `available: true` instead of `probe-threw`. The harness prompts from ADR-PIPELINE-101 reach Ruflo and produce real planning artifacts.
- **No more `ADR-FAIL-001` stubs from a phantom "ruflo unavailable" state.** ADR generation runs the real Phase 4 path.
- **Probe failures are loud, not silent.** Future probe issues print to stderr immediately; the `reason` field carries the error message.
- **Consensus summary matches `consensus.json`.** The misleading 0% / 81% contradiction is gone.

### Negative

- **The error-logging in the probe catch may produce noisy stderr** in environments where ruflo really isn't installed (e.g., CI runners without the ruflo binary). This is the intended trade-off: silent failure was the original bug. Operators who want to suppress the log can filter `[ruflo-probe]` from stderr.

### Neutral

- The third site in `mcp-server.ts:972` (git-root detection) was fixed for completeness even though it wasn't directly related to the user-reported symptom. It was the same ESM-broken bug class; leaving it would have surfaced as silent "can't find repo root" failures elsewhere.

## Related

- **ADR-PIPELINE-101** (Remove AQE + lock-down prompts + harness validators) — the harness this fix unblocks
- **ADR-PIPELINE-100** (Markdown-direct ADRs) — the ADR pipeline that was emitting failure stubs because of Bug 1
- **ADR-PIPELINE-098** (Phase 7 Consulting Deliverables) — downstream consumer of the planning artifacts that were missing
- **ADR-PIPELINE-091** (Ruflo as primary engineering executor) — the dispatch path that was being short-circuited
