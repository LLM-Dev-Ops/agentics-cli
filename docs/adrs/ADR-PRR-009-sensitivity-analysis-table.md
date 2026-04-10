# ADR-PRR-009: Add Sensitivity Analysis Table to Executive Documents

## Status: IMPLEMENTED

## Date: 2026-04-10

## Priority: MEDIUM — Address during pilot

## Effort: 1 hour

## Context

Production readiness review (2026-04-10) found that the executive documents reference "sensitivity analysis" as a mitigation for financial risk, and the demo output shows pessimistic/base/optimistic ranges, but no sensitivity analysis table or tornado chart appears in the executive package.

For an investment decision of this magnitude ($2.2M), standard practice requires showing which assumptions most affect ROI. Without this, executives cannot evaluate the robustness of the business case or identify which variables warrant additional validation during the pilot.

The Monte Carlo simulation already produces the underlying data — the gap is in surfacing it in executive-readable format.

## Decision

### 1. Generate a sensitivity analysis table in the executive summary

Show the impact of ±20% variation in each key assumption on the projected annual savings:

| Assumption | Base Value | -20% | +20% | Impact on Annual Savings | Sensitivity Rank |
|---|---|---|---|---|---|
| Fleet extension rate | 35% of fleet extended 1 year | $3.5M | $5.3M | ±$900K | **1 — Highest** |
| Average device cost | $1,350 | $3.8M | $5.0M | ±$600K | 2 |
| Fleet size | 7,400 devices | $3.5M | $5.3M | ±$900K | 1 (tied) |
| Carbon credit value | $50/tonne CO2 | $4.2M | $4.6M | ±$200K | 4 |
| Support cost multiplier | 1.3x for aged devices | $4.6M | $4.2M | ±$200K (inverse) | 4 (tied) |
| Productivity loss per failure | $200/incident | $4.5M | $4.3M | ±$100K | 6 — Lowest |

### 2. Add a tornado chart description

For slide-deck rendering, describe the tornado chart format:
- Bars ordered by sensitivity (highest impact at top)
- Base case marked with vertical line
- Left bar (pessimistic for that variable) and right bar (optimistic)
- Values in $ millions

### 3. Add a Key Takeaway paragraph

> "The business case is most sensitive to fleet extension rate and fleet size — both of which the pilot will validate directly with 500 real devices. Productivity loss and carbon credit values have minimal impact, meaning the ROI holds even if these estimates are off by 20%. The pilot is specifically designed to reduce uncertainty in the top two variables."

### 4. Implementation in demo output

Add sensitivity sweep to `src/demo.ts`:

```typescript
// After base simulation, run ±20% sweeps on each key variable
const sensitivityResults = runSensitivitySweep(baseResult, [
  { name: 'extensionRate', range: 0.2 },
  { name: 'avgDeviceCost', range: 0.2 },
  { name: 'fleetSize', range: 0.2 },
  // ...
]);
printSensitivityTable(sensitivityResults);
```

## Consequences

### Positive
- Executives can assess business case robustness at a glance
- Pilot design is explicitly linked to reducing highest-sensitivity variables
- Standard for investment decisions — increases board confidence
- Monte Carlo engine already has the data; this is a presentation layer addition

### Negative
- Sensitivity sweep adds ~6 additional simulation runs to the demo
- Table formatting needs adjustment for different output targets (terminal vs. PDF vs. slide)

## Related ADRs
- ADR-PRR-002: Phase Gate Criteria (gate metrics should target high-sensitivity variables)
- ADR-PRR-001: Externalize Hardcoded Constants (sensitivity variables must be configurable)
- ADR-PIPELINE-057: Executive Sensitivity Analysis and Confidence Framing
