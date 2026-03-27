# ADR-053: CostOps Financial Model Rendering and Cost Tracking in Generated Code

## Status: ACCEPTED

## Date: 2026-03-27

## Context

CostOps agents (costops/attribution, forecast, roi, tradeoff) run in Pass 4 and produce a `CostModel` with `scenarioVariants[]`. However:

- `pass4-governance.ts:587-695` — ScenarioVariants are built but never rendered into narrative or code
- Artifact #6 (CostOps Financial Model) contains bare data, not actionable analysis
- Generated project code has zero cost tracking or budget enforcement
- Decision Confidence Score (Artifact #12) doesn't validate cost assumptions against simulation probabilities
- `quantify.ts` command exists but results don't flow back into code generation

The user's prompt explicitly requires "quantify tradeoffs across carbon reduction, supply chain resilience, cost, and operational complexity" — cost analysis is a first-class requirement, not optional.

## Decision

### 1. CostOps artifact must render scenario variants as narrative

The artifact assembler must convert raw `CostModel` data into a readable cost analysis document:

```markdown
## Cost Impact Analysis

### Baseline
- Annual procurement cost: $X (from CostOps/attribution)
- Projected change: +Y% / -Z% depending on scenario

### Scenario Comparison
| Scenario | Cost Delta | Carbon Impact | Risk Level | ROI |
|----------|-----------|---------------|------------|-----|
| Upgrade Supplier A | +$2.1M/yr | -15% emissions | LOW | 3.2x |
| Replace with Green Alt | -$0.5M/yr | -40% emissions | HIGH | 1.8x |
| Dual Source | +$1.2M/yr | -8% emissions | LOW | 2.5x |

### Budget Constraints
- Maximum allowable cost increase: $X (from governance)
- Scenarios exceeding budget: [list]
```

### 2. Generated code must include cost tracking service

Phase 4 must generate a cost tracking port and adapter:

```typescript
export interface ICostTrackingPort {
  getBaseline(): Promise<CostBaseline>;
  getScenarioCostImpact(scenarioId: string): Promise<ScenarioCostImpact>;
  compareScenarioCosts(ids: string[]): Promise<CostComparison>;
  checkBudgetCompliance(proposedCost: number): Promise<{ compliant: boolean; threshold: number }>;
}
```

### 3. CostOps results must be embedded as seed data

Phase 5 materialization must write CostOps results as seed/reference data in the generated project:

```
src/data/cost-baseline.json     — baseline cost attribution
src/data/scenario-costs.json    — per-scenario cost impacts
src/data/budget-thresholds.json — governance cost limits
```

### 4. Decision confidence must validate cost-scenario alignment

`pass5-decision.ts:439-455` must check that:
- Every scenario with cost > budget threshold has a mitigation strategy
- ROI calculation uses simulation reliability scores, not just raw numbers
- Financial confidence is weighted by simulation confidence (not independent)

### 5. Tradeoff visualization data must be generated

Phase 4 must generate structured data for tradeoff analysis:

```typescript
// Generated in src/data/tradeoff-matrix.json
{
  "dimensions": ["cost", "emissions", "resilience", "complexity"],
  "scenarios": [
    {
      "id": "scenario-1",
      "name": "Upgrade Supplier A",
      "scores": { "cost": 0.7, "emissions": 0.85, "resilience": 0.9, "complexity": 0.6 },
      "paretoOptimal": true
    }
  ]
}
```

## Consequences

- (+) Cost analysis is visible and actionable in generated projects
- (+) Budget compliance can be checked programmatically
- (+) Decision-makers see tradeoff matrices, not just raw numbers
- (-) Requires CostOps agents to return structured data (currently varies)
- (-) Adds data files to generated project that need updating if scenarios change

## Audit References

- "No cost analysis happening anymore" — CostOps runs but results not rendered
- Pass 4 CostOps scenario variants never converted to narrative
- Artifact #6 is bare data, not story
- Decision confidence doesn't validate cost-scenario alignment
