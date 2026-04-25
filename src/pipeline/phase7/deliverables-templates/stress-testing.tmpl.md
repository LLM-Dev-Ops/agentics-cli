# {{title}}

{{consensusBanner}}

**Date:** {{date}}
**Trace ID:** `{{traceId}}`

---

## 1. Stress-Test Frame

{{stressFrame}}

### Why Stress (vs. Sensitivity)

{{whyStress}}

Sensitivity asks "what happens at ±X%?". Stress asks "what happens when several plausible bad things happen at once?".

### Threshold of Concern

{{concernThreshold}}

## 2. Stress Scenarios Modeled

{{stressScenarios}}

| # | Scenario | Combined Shocks | Plausibility | Severity |
|---|----------|------------------|--------------|----------|
{{stressScenariosTable}}

## 3. Severe-but-Plausible Scenario

{{severePlausible}}

### Compounding Shocks

{{compoundingShocks}}

### Outcome Under Severe-but-Plausible

{{fcvBlock}}

| Metric | Base Case | Stress Case | Delta |
|--------|-----------|-------------|-------|
| 5-Year NPV | {{npvBase}} | {{npvStress}} | {{npvDelta}} |
| Payback | {{paybackBase}} | {{paybackStress}} | {{paybackDelta}} |
| Run-rate Y3 | {{rrBase}} | {{rrStress}} | {{rrDelta}} |
| ROI | {{roiBase}} | {{roiStress}} | {{roiDelta}} |

## 4. Tail / Catastrophic Scenarios

{{tailScenarios}}

### Catastrophic Outcomes — What Has To Be True

{{catastrophicConditions}}

### Catastrophic Outcomes — Probability Range

{{catastrophicProbability}}

## 5. Stress Heat Map

{{stressHeatMap}}

| Variable A ↓ / Variable B → | -50% | -25% | Base | +25% | +50% |
|------------------------------|------|------|------|------|------|
{{heatMapTable}}

## 6. Decision Rules Triggered by Stress

{{stressDecisionRules}}

### Stop Triggers

{{stopTriggers}}

### De-Risk Triggers

{{deRiskTriggers}}

### Re-Plan Triggers

{{rePlanTriggers}}

## 7. Hedges & Optionality

{{hedgesOptionality}}

| Hedge | Cost | Trigger | Protection Bought |
|-------|------|---------|---------------------|
{{hedgesTable}}

## 8. Reverse Stress Test

{{reverseStressTest}}

### What Has To Go Wrong for the Decision To Fail Outright

{{whatHasToGoWrong}}

### How Plausibly Could That Happen

{{howPlausible}}

## 9. Implications for the Decision

{{decisionImplications}}

## 10. Confidence & Caveats

{{confidenceCommentary}}

{{dissentingAgents}}

---

{{agentAttributionFooter}}
