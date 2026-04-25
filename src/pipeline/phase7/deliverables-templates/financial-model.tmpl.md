# {{title}}

{{consensusBanner}}

**Date:** {{date}}
**Trace ID:** `{{traceId}}`
**Model horizon:** {{modelHorizon}}
**Discount rate:** {{discountRate}}
**Currency:** {{currency}}
**Source of truth:** `unit-economics.json` (ADR-PIPELINE-066)

---

## 1. Model Frame

{{modelFrame}}

### Methodology

{{modelMethodology}}

### Inputs

| Input | Value | Source |
|-------|-------|--------|
| Pilot annual savings | {{pilotSavings}} | unit-economics:pilot |
| Enterprise annual savings | {{enterpriseSavings}} | unit-economics:enterprise |
| Investment envelope | {{investmentEnvelope}} | unit-economics:investment |
| Discount rate | {{discountRate}} | financial-model |
| Tax rate | {{taxRate}} | financial-model |
| Scaling factor | {{scalingFactor}} | unit-economics:scaling |
| Pilot units | {{pilotUnits}} | unit-economics:pilot |
| Enterprise units | {{enterpriseUnits}} | unit-economics:enterprise |

## 2. Headline Outputs

{{fcvBlock}}

| Metric | Value |
|--------|-------|
| Investment | {{investmentFcv}} |
| Annual Savings (run-rate) | {{savingsFcv}} |
| Payback | {{paybackFcv}} |
| 5-Year NPV | {{npvFcv}} |
| ROI | {{roiFcv}} |
| IRR | {{irr}} |

## 3. Year-by-Year Cash Flow

| Year | Investment | Operating Cost | Savings | Net Cash Flow | Cumulative | Discounted CF |
|------|-----------|----------------|---------|---------------|------------|---------------|
{{yearByYearTable}}

## 4. Cost Structure

### Capital Expenditure (One-Time)

{{capexBreakdown}}

### Operating Expenditure (Recurring)

{{opexBreakdown}}

## 5. Revenue / Savings Build

{{savingsBuild}}

### Driver Tree

{{driverTree}}

## 6. Sensitivity (±{{sensRange}} on Top Three Drivers)

{{sensitivityTable}}

## 7. Comparison to Alternatives

{{alternativesComparison}}

## 8. Limitations & Caveats

{{modelLimitations}}

## 9. Validation Notes

{{validationNotes}}

## 10. Why We Are Not More Confident

{{confidenceCommentary}}

{{dissentingAgents}}

---

{{agentAttributionFooter}}
