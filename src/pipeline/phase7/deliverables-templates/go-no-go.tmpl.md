# {{title}}

{{consensusBanner}}

**Date:** {{date}}
**Trace ID:** `{{traceId}}`
**Decision body:** {{decisionBody}}
**Decision deadline:** {{decisionDeadline}}

---

## 1. The Decision

**Recommendation: {{recommendation}}**

{{recommendationNarrative}}

## 2. Pre-Conditions Checklist

| # | Pre-condition | Status | Owner | Notes |
|---|--------------|--------|-------|-------|
{{preconditionsTable}}

## 3. Risk-Adjusted Decision Score

{{fcvBlock}}

| Dimension | Weight | Score (0-100) | Weighted |
|-----------|--------|---------------|----------|
| Strategic alignment | {{wStrategic}} | {{sStrategic}} | {{wsStrategic}} |
| Financial return | {{wFinancial}} | {{sFinancial}} | {{wsFinancial}} |
| Execution feasibility | {{wExecution}} | {{sExecution}} | {{wsExecution}} |
| Risk profile (inverted) | {{wRisk}} | {{sRisk}} | {{wsRisk}} |
| Organizational readiness | {{wOrg}} | {{sOrg}} | {{wsOrg}} |
| **Composite score** | **100** | — | **{{compositeScore}}** |

**Threshold for Go:** {{goThreshold}}
**Score:** {{compositeScore}} → **{{thresholdVerdict}}**

## 4. Decision Tree

{{decisionTree}}

## 5. Go Decision — What It Authorizes

{{goAuthorizes}}

## 6. No-Go Decision — What It Avoids

{{noGoAvoids}}

## 7. Defer Decision — What Has To Change

{{deferConditions}}

## 8. Stage-Gates Built Into the Go Path

{{stageGates}}

## 9. Reversibility Map

{{reversibilityMap}}

## 10. Why We Are Not More Confident

{{confidenceCommentary}}

{{dissentingAgents}}

---

{{agentAttributionFooter}}
