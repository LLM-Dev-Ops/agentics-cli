# ADR-PIPELINE-063: Multi-Variable Sensitivity Tornado in Financial Analysis Renderer

**Status:** Accepted
**Date:** 2026-04-10
**Priority:** HIGH — Executive Output 7.5 → 10/10
**Implements:** ADR-PIPELINE-057 §1 (which was Accepted but unimplemented)

## Context

ADR-PIPELINE-057 §1 accepted a multi-variable sensitivity table with a tornado chart. The current implementation is **single-variable** and has nothing in common with a real sensitivity analysis.

### Current Code (Verified 2026-04-10)

`src/synthesis/simulation-renderers.ts:2766–2792` emits:

```typescript
lines.push('## Sensitivity Analysis', '');
lines.push('Impact of varying the primary improvement target on projected savings:', '');
lines.push('| Reduction Target | Projected Savings | ROI | Payback |');
lines.push('|-----------------|-------------------|-----|---------|');
if (fin.revenue) {
  // parses base from fin.revenue ...
  for (const pct of [0.5, 0.75, 1.0, 1.25]) {
    const savings = baseSavings * pct;
    const roi = Math.round((savings / baseInvest) * 100);
    // ...
    lines.push(`| ${label} | ${fmtS(savings)} | ${roi}% | ${payback} months |`);
  }
}
```

This varies **exactly one variable** (the "primary improvement target") across four scalar multipliers. It is not a sensitivity analysis — it is four points along one axis.

A consulting-grade sensitivity analysis varies multiple independent assumptions each by ±X%, ranks them by absolute impact on the output, and presents them as a tornado chart where the biggest driver is at the top.

### What ADR-PIPELINE-057 §1 Specified

```
| Variable                   | Range    | Impact on Annual Savings  |
| Occupancy data coverage    | 70%→95%  | -20% to baseline          |
| Energy price               | ±15%     | ±$X                       |
| Hybrid adoption rate       | 40%→70%  | +$Y to -$Z                |
| Implementation timeline    | ±3 months| NPV impact: ±$W           |
| Archibus integration scope | 3→8 bldg | +$V (non-linear)          |
```

Five variables, ranked, each with its own range and impact magnitude. This is what the renderer should emit. It does not.

## Decision

### 1. Replace the Single-Variable Loop with a Multi-Variable Builder

Introduce `buildSensitivityTable(fin, extracted, domainAnalysis)` in `simulation-renderers.ts` that returns:

```typescript
interface SensitivityRow {
  variable: string;         // "Energy price"
  range: string;            // "±15%"
  baselineUsd: number;
  lowCaseUsd: number;       // pessimistic scenario total
  highCaseUsd: number;      // optimistic scenario total
  impactUsd: number;        // absolute magnitude
  impactPercent: number;
  rank: number;             // 1 = highest absolute impact
  direction: 'bidirectional' | 'upside_only' | 'downside_only';
}
```

### 2. Variable Selection Is Domain-Driven

The builder picks 5–7 variables based on the scenario:

- **Always included** (when applicable): `input_price_variance` (±15%), `implementation_timeline` (±3 months), `adoption_rate` (bidirectional 20–40 percentage points).
- **Domain-triggered by `extracted.scenario_type`**:
  - `sustainability-esg`: + `data_coverage` (70%→95%), + `carbon_price` ($30→$100/t).
  - `supply-chain`: + `supplier_reliability` (90%→99.9%), + `lead_time_variance` (±2 weeks).
  - `finance-compliance`: + `audit_cost_multiplier` (1×→2.5×).
- **Scope variables** (non-linear): building count, supplier count, or fleet size going from pilot to enterprise (derived from `config.pilotBuildingCount` or equivalent).

### 3. Ranking and Tornado Ordering

After computing all impacts, sort by `Math.abs(impactUsd)` descending and assign `rank = index + 1`. This produces tornado ordering (largest bar at top).

### 4. Render the Table + ASCII Tornado

```markdown
## Sensitivity Analysis

Base case: $X.XM/yr

| Rank | Variable | Range | Pessimistic | Optimistic | Impact |
|---|---|---|---|---|---|
| 1 | Building scope | 3→8 | $1.2M | $4.1M | ±$1.4M |
| 2 | Hybrid adoption | 40%→70% | ... | ... | ±$X |

### Tornado Chart

    Building scope    ████████████████████ $1.4M
    Hybrid adoption   ██████████           $700K
    Energy price      ████                 $280K
    ...

**Key takeaway:** The business case is most sensitive to {top1} and {top2}. The pilot
validates these directly. {bottomN} has minimal impact, meaning the ROI holds even
with ±X% variation in that assumption.
```

The key takeaway is **computed** from the sorted list, not hardcoded.

### 5. Keep the Old Scenario Table (Don't Delete)

The existing `scenario_analysis` table (`simulation-renderers.ts:2760–2763`) shows Base/Optimistic/Pessimistic. Leave it. The new sensitivity table complements it — scenarios show aggregated outcome distributions; sensitivity shows which inputs drive the distribution.

### 6. Do Not Add New Zod Fields to `fin`

The existing `fin` (`synthesizeFinancials`) has `budget`, `roi`, `npv`, `payback`, `revenue`, `costSavings`. The builder uses `baseSavings` parsed from `fin.revenue` (same parse path as today) and applies impact multipliers. No new fields required.

## Acceptance Criteria

1. `grep "for (const pct of \[0.5, 0.75, 1.0, 1.25\])" src/synthesis/simulation-renderers.ts` returns zero matches.
2. For a sustainability scenario, the rendered financial analysis contains a sensitivity table with ≥5 distinct variable rows.
3. Variables in the table are sorted by `|impactUsd|` descending (rank 1 has the largest impact).
4. Rendered output contains an ASCII tornado chart with one bar per variable.
5. The "Key takeaway" paragraph references the top-1 and top-2 variable names dynamically.
6. Unit test verifies rank assignment is unique and matches absolute-impact ordering.

## Consequences

### Positive
- Executive sensitivity section becomes a real risk communication tool, not a decorative table
- Completes ADR-PIPELINE-057 §1 which has been open since 2026-04-10
- Deterministic output (no LLM involvement) means it's reproducible across runs

### Negative
- `buildSensitivityTable` adds ~100 lines to `simulation-renderers.ts`
- Variable selection rules require maintenance as new scenario types are added — acceptable, they're centralized

## Related
- ADR-PIPELINE-057 §1 (original sensitivity design — unimplemented)
- ADR-PIPELINE-062 (sister ADR for competitive analysis)
- ADR-PIPELINE-060 (10/10 Scorecard)
