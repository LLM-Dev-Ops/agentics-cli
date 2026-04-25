# {{title}} — {{case}} Case

{{consensusBanner}}

**Date:** {{date}}
**Scenario:** **{{case}}** ({{caseDescription}})
**Trace ID:** `{{traceId}}`

---

## 1. Scenario Definition

**Case:** {{case}}
**Probability weighting:** {{caseProbability}}
**Defining assumptions:** {{caseAssumptions}}

{{caseNarrative}}

## 2. Inputs to This Case

{{caseInputs}}

| Input | {{case}} Case Value | Source |
|-------|---------------------|--------|
| Pilot annual savings | {{pilotSavings}} | unit-economics:pilot |
| Enterprise annual savings | {{enterpriseSavings}} | unit-economics:enterprise |
| Investment envelope | {{investmentEnvelope}} | unit-economics |
| Discount rate | {{discountRate}} | financial-model |
| Scaling factor (pilot → enterprise) | {{scalingFactor}} | unit-economics |
| Time horizon | {{timeHorizon}} | financial-model |

## 3. Financial Outcomes ({{case}} Case)

{{fcvBlock}}

| Metric | {{case}} Case Value |
|--------|---------------------|
| Year-1 cumulative savings | {{year1Savings}} |
| Year-3 cumulative savings | {{year3Savings}} |
| Year-5 cumulative savings | {{year5Savings}} |
| Investment | {{investmentFcv}} |
| Payback | {{paybackFcv}} |
| 5-Year NPV | {{npvFcv}} |
| ROI | {{roiFcv}} |
| IRR | {{irr}} |

## 4. Year-by-Year Cash Flow

{{cashFlowTable}}

## 5. What Has To Be True for This Case to Hold

{{loadBearingAssumptions}}

## 6. Indicators That Reality Has Drifted Off This Case

{{driftIndicators}}

## 7. Decision Implications

**If reality tracks {{case}}-case:** {{implicationsIfHolds}}

**If reality drifts toward {{driftDirection}}:** {{implicationsIfDrifts}}

## 8. Comparison vs. Other Cases

{{caseComparison}}

## 9. Confidence & Caveats

{{confidenceCommentary}}

{{dissentingAgents}}

---

{{agentAttributionFooter}}
