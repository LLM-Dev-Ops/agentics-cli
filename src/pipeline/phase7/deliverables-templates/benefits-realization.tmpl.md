# {{title}}

{{consensusBanner}}

**Date:** {{date}}
**Trace ID:** `{{traceId}}`

---

## 1. Benefits Frame

{{benefitsFrame}}

### Why a Benefits-Realization Tracker (Not Just a Status Report)

{{whyBenefitsTracker}}

### Source-of-Truth Note

All target dollar values trace to `unit-economics.json` per ADR-PIPELINE-066. Realized values are reconciled monthly to finance.

## 2. Benefits Catalog

{{fcvBlock}}

| # | Benefit | Type (Hard/Soft) | Annual Target | Realized to Date | % Realized | Owner |
|---|---------|-------------------|---------------|------------------|------------|-------|
{{benefitsCatalogTable}}

**Total target run-rate:** {{savingsFcv}}
**Total realized to date:** {{realizedToDate}}

## 3. Realization Curve

{{realizationCurve}}

| Period | Forecast Cumulative | Actual Cumulative | Variance |
|--------|---------------------|---------------------|----------|
| Q1 | {{q1Forecast}} | {{q1Actual}} | {{q1Var}} |
| Q2 | {{q2Forecast}} | {{q2Actual}} | {{q2Var}} |
| Q3 | {{q3Forecast}} | {{q3Actual}} | {{q3Var}} |
| Q4 | {{q4Forecast}} | {{q4Actual}} | {{q4Var}} |
| Y2 | {{y2Forecast}} | {{y2Actual}} | {{y2Var}} |
| Y3 | {{y3Forecast}} | {{y3Actual}} | {{y3Var}} |

## 4. Benefit-by-Benefit Detail

{{benefitDetails}}

## 5. Leading Indicators

{{leadingIndicators}}

## 6. Lagging Indicators

{{laggingIndicators}}

## 7. Reconciliation to P&L / Finance

{{plReconciliation}}

## 8. Leakage Analysis

{{leakageAnalysis}}

## 9. Re-Forecasting Cadence

{{reForecastingCadence}}

## 10. Governance

{{benefitsGovernance}}

## 11. Confidence & Caveats

{{confidenceCommentary}}

{{dissentingAgents}}

---

{{agentAttributionFooter}}
