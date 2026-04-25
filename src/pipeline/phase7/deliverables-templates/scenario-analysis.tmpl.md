# {{title}}

{{consensusBanner}}

**Date:** {{date}}
**Trace ID:** `{{traceId}}`

---

## 1. Scenario Frame

{{scenarioFrame}}

### Scope of Sensitivity

{{sensitivityScope}}

## 2. Scenarios Modeled

| Scenario | Probability | Defining Assumption | Year-1 Run-Rate | 5-Year NPV |
|----------|-------------|---------------------|-----------------|------------|
| Best | {{probBest}} | {{assumptBest}} | {{runRateBest}} | {{npvBest}} |
| Base | {{probBase}} | {{assumptBase}} | {{runRateBase}} | {{npvBase}} |
| Worst | {{probWorst}} | {{assumptWorst}} | {{runRateWorst}} | {{npvWorst}} |
| **Probability-weighted** | — | — | — | **{{npvWeighted}}** |

{{scenariosNarrative}}

## 3. Sensitivity Analysis — Single-Variable

{{fcvBlock}}

The headline 5-year NPV is **{{npvFcv}}**. Holding all other inputs at base-case values, the variance in NPV under ±{{sensRange}} swings is:

| Variable | Base | -{{sensRange}} → NPV | +{{sensRange}} → NPV | Sensitivity |
|----------|------|---------------------|---------------------|-------------|
{{sensitivityTable}}

### Tornado Chart Ranking

{{tornadoRanking}}

## 4. Two-Variable Sensitivity (Stress Heat Map)

{{twoVarSensitivity}}

## 5. Break-Even Analysis

{{breakEvenAnalysis}}

| Variable | Break-even threshold | Margin to base case |
|----------|---------------------|---------------------|
{{breakEvenTable}}

## 6. Tail Risk — What Has to Go Wrong for NPV < 0

{{tailRisk}}

## 7. Hedges & Optionality

{{hedgesAndOptionality}}

## 8. Implications for the Decision

{{decisionImplications}}

## 9. Why We Are Not More Confident

{{confidenceCommentary}}

{{dissentingAgents}}

---

{{agentAttributionFooter}}
