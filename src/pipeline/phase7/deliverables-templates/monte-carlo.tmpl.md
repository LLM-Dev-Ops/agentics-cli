# {{title}}

{{consensusBanner}}

**Date:** {{date}}
**Trace ID:** `{{traceId}}`
**Iterations:** {{iterations}}
**RNG seed:** `{{rngSeed}}`

---

## 1. Simulation Frame

{{simulationFrame}}

### Why Monte Carlo (vs. Single-Point Estimate)

{{whyMonteCarlo}}

### Variables Modeled as Distributions

| Variable | Distribution | Parameters | Source |
|----------|-------------|-----------|--------|
{{distributionsTable}}

### Variables Held Fixed (Sensitivities Tested Separately)

{{fixedVariables}}

## 2. Output Distributions

{{fcvBlock}}

### 5-Year NPV Distribution

| Percentile | NPV |
|-----------|-----|
| P10 | {{npvP10}} |
| P25 | {{npvP25}} |
| P50 (median) | {{npvP50}} |
| P75 | {{npvP75}} |
| P90 | {{npvP90}} |
| Mean | {{npvMean}} |
| StdDev | {{npvStd}} |

### Payback Distribution

| Percentile | Payback (months) |
|-----------|------------------|
| P10 | {{paybackP10}} |
| P50 | {{paybackP50}} |
| P90 | {{paybackP90}} |
| Mean | {{paybackMean}} |

### Annual Run-Rate Savings Distribution

| Percentile | Savings |
|-----------|---------|
| P10 | {{savP10}} |
| P50 | {{savP50}} |
| P90 | {{savP90}} |

## 3. Probability of Key Outcomes

{{probabilityKey}}

| Outcome | Probability |
|---------|-------------|
| NPV > 0 | {{probNpvPos}} |
| NPV > {{npvFcv}} (base-case headline) | {{probNpvAboveBase}} |
| Payback ≤ {{paybackTarget}} | {{probPaybackTarget}} |
| Run-rate ≥ {{runrateTarget}} | {{probRunRateTarget}} |
| Worst-case NPV (P10) — investment safe | {{probSafe}} |

## 4. Tornado — Drivers of Variance

{{tornadoDrivers}}

| Variable | Variance Contribution | Direction |
|----------|------------------------|-----------|
{{tornadoTable}}

## 5. Tail-Risk Analysis

{{tailRisk}}

### What Has To Happen for NPV in the Bottom 10%

{{bottomTenScenario}}

### What Has To Happen for NPV in the Top 10%

{{topTenScenario}}

## 6. Correlation Effects

{{correlationEffects}}

## 7. Comparison to Deterministic Base Case

| Metric | Deterministic Base | MC Median | MC Mean | Spread (P10–P90) |
|--------|--------------------|-----------|---------|--------------------|
{{deterministicVsMcTable}}

## 8. Implications for the Decision

{{decisionImplications}}

## 9. Caveats — Where Monte Carlo Misleads

{{mcCaveats}}

## 10. Confidence & Caveats

{{confidenceCommentary}}

{{dissentingAgents}}

---

{{agentAttributionFooter}}
