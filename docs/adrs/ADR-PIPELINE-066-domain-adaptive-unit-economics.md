# ADR-PIPELINE-066: Domain-Adaptive Unit Economics — Ban Per-Employee Heuristics When the Prototype Has Real Unit Economics

**Status:** Accepted
**Date:** 2026-04-11
**Priority:** CRITICAL — Single largest credibility gap in executive output
**Originating Review:** OPERA Sustainability Prototype Readiness Review (2026-04-11), Executive Output 6/10
**Builds on:** ADR-PIPELINE-053 (Prototype→Enterprise Reconciliation), ADR-PIPELINE-029 (Bottom-Up Financial Models)

## Context

The OPERA hotel readiness review identified this as the top blocker:

> "The financial model rests on a per-employee heuristic that doesn't fit the domain. Housekeeping savings scale with rooms × occupancy × linen-kg, not employee headcount. The $60/employee × 91,000 = $5.5M derivation is presentation-grade math, not bottom-up. Meanwhile, the code already computes the right number the right way — the demo output shows $1.2M/yr from 4 sampled properties with clear unit economics."

The defect is in the pipeline, not the generated project. `src/synthesis/simulation-renderers.ts` contains:

```typescript
// Lines 601-602
const pilotCost = Math.round(employees * costPerEmployee / 1000) * 1000;
const annualSavings = Math.round(employees * savingsMultiplier / 1000) * 1000;
```

Plus `extractEmployeeCount(query, lower)` is invoked across fleet sizing (L252), customer count (L290), traveler count (L308), fleet ratio (L861). The renderer has no awareness that the generated prototype computes *real* unit economics (kg/occupied-room-night, kWh/sqft, miles/vehicle/day). It falls back to headcount even when the prototype emits better numbers.

The consequence: the coding agent produces a defensible bottom-up model, then the executive summary renderer overwrites it with a heuristic that a BCG partner would reject in 30 seconds.

## Decision

### 1. Prototype Must Emit a `unit-economics.json` Artifact

After the coding agent finishes, the prototype's demo run MUST write a machine-readable unit-economics manifest to `.agentics/runs/<run-id>/unit-economics.json`:

```json
{
  "run_id": "sim-20260411-a1b2",
  "domain_unit": { "label": "occupied room night", "abbrev": "orn" },
  "measured_scope": { "properties": 4, "rooms": 1450, "region_mix": ["NA","EMEA","APAC"] },
  "enterprise_scope": { "properties": 100, "rooms": 36250, "employees": 91000 },
  "unit_savings": {
    "usd_per_orn": 0.82,
    "water_liters_per_orn": 14.5,
    "co2_kg_per_orn": 0.62
  },
  "annual_measured_savings_usd": 1203400,
  "annual_extrapolated_savings_usd": 30100000,
  "extrapolation_method": "linear_by_rooms_weighted_by_regional_cost",
  "confidence": { "directional": 0.92, "precision": 0.42 }
}
```

The schema is a new Zod type `UnitEconomicsSchema` in `src/pipeline/types.ts`. The demo template in `src/pipeline/auto-chain.ts` must include a `writeUnitEconomics()` call at the end of the demo script.

### 2. Financial Renderer Prefers `unit-economics.json` Over Heuristics

`src/synthesis/simulation-renderers.ts` MUST follow this order:

1. Look for `<run-dir>/unit-economics.json`. If present and schema-valid, use those numbers verbatim.
2. Otherwise look for structured financial output in the agent results (`costops`, `platform/executive-summary`).
3. Only if both are missing, fall back to the current per-employee heuristic — AND emit a warning header in the rendered document: `> ⚠️ Financial model: heuristic fallback (no prototype unit economics found)`.

The fallback warning is mandatory. It makes the credibility gap visible instead of hiding it.

### 3. Ban Per-Employee Math When a Domain Unit Exists

Add a domain-unit registry keyed on the `domain_analysis.sector` field already produced by ADR-PIPELINE-041:

| Sector | Domain Unit | Savings Formula Base |
|---|---|---|
| hospitality / hotels | occupied room night | rooms × occupancy × $/orn |
| commercial real estate | sqft-year | sqft × $/sqft-year |
| fleet / logistics | vehicle-mile | fleet × miles × $/mile |
| retail | transaction | daily_txns × 365 × $/txn |
| manufacturing | unit produced | throughput × $/unit |
| healthcare | patient-day | census × $/patient-day |
| data center | kWh | load × 8760 × $/kWh |
| call center / BPO | contact minute | agents × minutes × $/contact-min |

When the detected sector is in the registry, `renderFinancialAnalysis()` MUST use the domain unit. Employee count may appear as *context* ("91,000 employees across 100 properties") but MUST NOT be the multiplicand for savings or cost.

### 4. `extractEmployeeCount` Becomes `extractDomainScale`

Rename and reshape the helper so it returns a richer structure:

```typescript
interface DomainScale {
  employees: number;          // still available for context
  operationalUnits: number;   // rooms, sqft, vehicles, etc.
  unitLabel: string;          // "occupied room night"
  source: 'prototype' | 'query-regex' | 'default';
}
```

Fleet/customer/traveler estimations currently derived from `employees * ratio` must switch to `operationalUnits * ratio` when `source !== 'default'`.

### 5. Consistency Checks in Executive Renderer

After assembling the financial section, the renderer MUST verify:

- If `unit-economics.json` was used, the dollar figures printed in the exec summary match the manifest within ±1% rounding tolerance.
- If a pilot figure and an enterprise figure both appear, their ratio must equal `measured_scope.rooms / enterprise_scope.rooms` (or analogous unit) within ±5%.

Mismatches throw a rendering error with code `ECLI-SYN-066` and block document emission.

## Implementation

1. **Schema:** add `UnitEconomicsSchema` to `src/pipeline/types.ts`.
2. **Demo template:** update `src/pipeline/auto-chain.ts` scaffold emitter to include a `writeUnitEconomics()` helper in the generated `src/demo.ts`.
3. **Renderer:** modify `src/synthesis/simulation-renderers.ts`:
   - New `loadUnitEconomics(runDir): UnitEconomics | null`
   - `renderFinancialAnalysis()` uses the 3-tier precedence from §2
   - `extractEmployeeCount` → `extractDomainScale` with the registry from §3
4. **Fallback warning:** mandatory warning header when tier 3 is used.
5. **Tests:** new fixtures under `tests/synthesis/unit-economics/` covering hospitality, CRE, and fleet sectors with and without a unit-economics manifest.

## Acceptance Criteria

1. Running a fresh pipeline end-to-end on a hospitality query produces `unit-economics.json` with `domain_unit.label === "occupied room night"`.
2. The rendered executive summary for that run contains a dollar figure derived from `usd_per_orn × rooms × occupancy`, not from `employees × $/employee`.
3. Rendering with the manifest removed falls back cleanly and prints the `⚠️ heuristic fallback` warning header.
4. The renderer refuses to emit a document where pilot/enterprise dollar figures violate the scope ratio.
5. Grep over generated executive output for `per employee` returns 0 occurrences when a unit economics manifest exists.

## Consequences

### Positive
- Executive output finally matches what the prototype actually computes
- Eliminates the "presentation-grade math" credibility gap flagged in reviews
- Cross-domain: same pattern applies to healthcare, CRE, fleet, retail, manufacturing
- The fallback warning makes regression visible instead of silent

### Negative
- Existing fixtures relying on per-employee heuristics will need regeneration
- The domain-unit registry must be maintained as new sectors are onboarded
- Renderer failure on scope-ratio mismatch may be noisy during rollout — gate behind `AGENTICS_STRICT_UNIT_ECONOMICS=true` for the first two weeks

## Related
- ADR-PIPELINE-053 (Prototype→Enterprise reconciliation — this ADR specifies the data contract)
- ADR-PIPELINE-029 (Bottom-Up Financial Models)
- ADR-PIPELINE-041 (Domain-aware simulation — provides `domain_analysis.sector`)
- ADR-PIPELINE-067 (Cross-document consistency — consumes the manifest)
