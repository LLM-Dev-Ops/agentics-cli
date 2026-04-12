# ADR-PIPELINE-072: Pre-Render Prototype Analysis Pass — Compute Unit Economics Before Rendering

**Status:** Accepted
**Date:** 2026-04-12
**Priority:** CRITICAL — Single biggest cause of repeated Simulation Alignment / Executive Output score drops
**Originating Review:** Ramco Aviation Catering Readiness Review (2026-04-12), Simulation Alignment 4/10, Executive Output 5/10
**Builds on:** ADR-PIPELINE-066 (Domain-Adaptive Unit Economics), ADR-PIPELINE-067 (Cross-Document Consistency)

## Context

ADR-PIPELINE-066 introduced `unit-economics.json` as the machine-readable contract between the generated prototype and the executive renderer. The three-tier precedence (manifest → agent → heuristic) was supposed to eliminate per-employee heuristics from the executive summary whenever the prototype produced real unit economics.

**The fix has been repeatedly defeated by a pipeline ordering bug.** In the current phase sequence:

1. Phase 4 (ADR / DDD generation) completes
2. Phase 5 renderers emit `executive-summary.md`, `decision-memo.md`, `financial-analysis.md` → **no `unit-economics.json` exists yet**
3. Phase 5 coding agent generates the prototype project
4. Demo runs, calls `writeUnitEconomics()`, **finally** produces the manifest

Because step 2 happens before step 4, the renderers always hit the ADR-066 tier-3 heuristic fallback. The executive summary then prints `69,000 employees × $60/employee = $4.14M`, the prototype's demo script independently computes a different number (the Ramco review caught `~$445M/year` naive extrapolation vs. `$4.1M` in the memo), and FCR-007/008 from ADR-067 have nothing to compare against because the manifest doesn't exist at validation time.

The Ramco review's `Simulation Alignment 4/10` and `Executive Output 5/10` both point at this exact failure. The OPERA review two days earlier caught the same class of defect.

**The fix is not another rule — it is a phase reordering.** The pipeline needs a lightweight financial-model computation *before* the executive renderers run, so `unit-economics.json` is on disk when ADR-066's tier-1 path checks for it.

## Decision

### 1. New Phase 4.5 — Pre-Render Analysis

Insert a new phase `phase4-5-pre-render` that runs after Phase 4 (ADRs/DDD) and before Phase 5 (executive rendering + codegen). Its single job is to produce `.agentics/runs/<run-id>/unit-economics.json` from the scenario + domain analysis, using the same sector registry the executive renderer already consumes.

New file: `src/pipeline/phase4-5-pre-render/pre-render-coordinator.ts`

```typescript
export interface PreRenderInput {
  readonly runDir: string;
  readonly runId: string;
  readonly query: string;
  readonly scenarioArtifact: Record<string, unknown>;   // scenario.json
  readonly domainAnalysis: DomainAnalysis | null;        // from Phase 4
}

export interface PreRenderOutput {
  readonly unitEconomicsPath: string;
  readonly manifest: UnitEconomics;
  readonly preRenderMetrics: {
    readonly sector: Sector;
    readonly operationalUnits: number;
    readonly usdPerUnit: number;
    readonly confidence: number;
  };
}

export async function executePreRender(input: PreRenderInput): Promise<PreRenderOutput>;
```

### 2. Bottom-Up Financial Model — No Per-Employee Math

The pre-render pass uses the ADR-066 sector registry to pick a domain unit and compute savings bottom-up:

```
1. Classify sector from the query + domain_analysis hint
2. Extract operational unit count (rooms, sqft, vehicles, flights, meals/day, ...)
   from the query text; fall back to sector-appropriate ratio × employees when unknown
3. Look up baseline waste rate for the sector (from a new
   src/pipeline/phase4-5-pre-render/sector-baselines.ts table)
4. Compute:
     pilot_savings_usd  = operational_units × unit_cost × waste_rate × achievable_reduction
     enterprise_savings_usd = pilot_savings_usd × scope_ratio
5. Write unit-economics.json with confidence = 0.70
   (scope='prototype-preview', to be overwritten when the real prototype runs)
```

The **ban on per-employee heuristics is absolute** inside the pre-render module. The module MUST NOT reference `employees * ratio` for any savings computation. Contextual headcount is allowed; savings math is not.

### 3. Phase Wiring

`src/pipeline/auto-chain.ts` is the current phase orchestrator. Add a new phase between Phase 4 and Phase 5 executive rendering:

```typescript
// In autoChain phase ordering:
// ... existing phase4 (ADRs / DDD) ...
const preRenderResult = await executePreRender({
  runDir,
  runId,
  query,
  scenarioArtifact: scenario,
  domainAnalysis: phase4Output.domainAnalysis,
});

// Now Phase 5 renderers see unit-economics.json on disk.
// ADR-PIPELINE-066 tier-1 path fires. The heuristic fallback banner does not.
```

### 4. Prototype Demo Overwrites the Preview Manifest

The pre-render manifest is marked `source: 'prototype-preview'` (new enum value). When the coding agent generates the prototype and its demo runs, `writeUnitEconomics()` overwrites it with `source: 'prototype'` carrying the same shape but measured (not predicted) numbers.

Both writes are valid against `UnitEconomicsSchema` — the `source` field discriminates. The executive renderer treats them identically for display; the renderer's ADR-066 consistency check uses whichever is present at render time.

The precedence becomes:

```
prototype-preview (phase 4.5) → prototype (phase 5 demo) → prototype (final publish)
```

### 5. Financial Reconciliation Invariant

After the prototype demo runs, a new `post-render-reconciler.ts` stage compares the preview manifest against the final manifest. If the two differ by more than ±25% on headline savings, the pipeline emits a `preview_vs_prototype_drift` warning header on the executive documents and a `reconciliation.report.json` artifact. The 25% tolerance is chosen because a pre-render prediction is inherently coarser than bottom-up measured unit economics.

### 6. Sector Baselines Table

New file `src/pipeline/phase4-5-pre-render/sector-baselines.ts`:

| Sector | Baseline waste rate | Unit cost basis | Achievable reduction |
|---|---|---|---|
| hospitality | 0.32 kg linen/occupied-room-night × $2.10/kg laundry | rooms × occupancy | 18% |
| airline-catering | 0.18 kg/meal × $4.20/meal loaded | meals × flights × 365 | 22% |
| commercial-real-estate | 12 kWh/sqft-year × $0.14/kWh | sqft | 15% |
| fleet | 0.65 gal/vehicle-mile × $3.80/gal | vehicles × miles | 12% |
| retail | $95K/store/yr energy × 15% reduction ceiling | stores | 15% |
| manufacturing | 2.3% scrap rate × $/unit | units produced | 25% |
| healthcare | 0.8 kg waste/patient-day × $1.40/kg disposal | beds × occupancy | 20% |
| data-center | PUE 1.6 → 1.3 opportunity × $0.08/kWh | kW load | 18% |
| call-center | 12% overstaffing × $38/hr loaded | agents × shifts | 14% |

The table mirrors the ADR-066 registry so the two stay in lockstep.

## Implementation

1. New module `src/pipeline/phase4-5-pre-render/` containing:
   - `pre-render-coordinator.ts` — orchestrator
   - `sector-baselines.ts` — the table above
   - `financial-model.ts` — `computePreRenderUnitEconomics(scenario, domainAnalysis, query)`
   - `post-render-reconciler.ts` — compares preview vs. prototype manifests
2. `UnitEconomicsSchema` in `src/pipeline/types.ts` gains `source: z.enum(['prototype-preview', 'prototype']).default('prototype')`.
3. `src/pipeline/auto-chain.ts` inserts the pre-render stage between Phase 4 and Phase 5.
4. `src/synthesis/simulation-renderers.ts::renderFinancialAnalysis` already checks for `unit-economics.json` at the passed `runDir` — no renderer change needed.
5. `src/pipeline/auto-chain.ts::executeAutoChain` emits a new `phase4-5` entry in the phase results array so telemetry + status reporting show the pre-render pass.
6. Tests:
   - `tests/unit/pipeline/pre-render/financial-model.test.ts` — 8 sector fixtures including airline-catering, hospitality, CRE
   - `tests/unit/pipeline/pre-render/reconciler.test.ts` — drift detection at 25% tolerance
   - Integration test: a synthetic query + seed data produces a `unit-economics.json` with the right sector and `source='prototype-preview'` BEFORE any renderer runs

## Acceptance Criteria

1. Running the pipeline against any query produces `<runDir>/unit-economics.json` before `executive-summary.md` is written.
2. The executive summary's financial section uses the ADR-066 tier-1 manifest path on every run — zero occurrences of the `heuristic fallback` banner in a fresh pipeline run.
3. The Ramco catering fixture produces a preview manifest with `sector: 'airline-catering'`, `domain_unit.label: 'meal loaded'`, and a savings figure that matches the decision memo within ±5%.
4. When the prototype demo runs later, it overwrites the preview with `source: 'prototype'` and the reconciler emits `reconciliation.report.json`.
5. Drift ≥25% between preview and prototype triggers a warning header on the rendered documents.
6. Grep across rendered executive documents for `69,000 employees × $60/employee` (or any `<number> × $<number>/employee` form) returns 0 hits.

## Consequences

### Positive

- The single biggest recurring gap — `Simulation Alignment 4/10` in Ramco, `Executive Output 6/10` in OPERA, identical class — closes at the pipeline level, not per-query.
- ADR-066 / ADR-067 / ADR-071 all start working as designed because the manifest they depend on is now present at render time.
- The executive summary's headline figures become defensible on the first run, not after a follow-up prototype pass.
- The reconciler's drift warning becomes a forcing function: if the prototype discovers the preview was wildly off, the executive documents say so loudly instead of hiding it.

### Negative

- Adds ~300ms to the pipeline critical path for a typical run (measured against the Ramco fixture).
- The pre-render financial model is inherently coarser than the prototype's measured output — this is the point, but reviewers may conflate the two. The `source: 'prototype-preview'` discriminator and the reconciliation report must stay prominent.
- The sector-baselines table becomes a maintenance point: new sectors need both an ADR-066 registry entry and a baseline row. Add a test that asserts the two stay in lockstep.

## Related

- ADR-PIPELINE-066 (Domain-Adaptive Unit Economics — this ADR finally makes its tier-1 path fire on every run)
- ADR-PIPELINE-067 (Cross-Document Consistency — FCR-007 / FCR-008 now have a manifest to validate against)
- ADR-PIPELINE-071 (Consensus Transparency — headline figures the contested banner references are now derived, not heuristic)
- ADR-PIPELINE-029 (Bottom-Up Financial Models)
- ADR-PIPELINE-041 (Domain-Aware Simulation)
