# {{title}}

{{consensusBanner}}

**Date:** {{date}}
**Trace ID:** `{{traceId}}`
**Document type:** **{{document_kind}}**

---

## 1. Dashboard Frame

{{dashboardFrame}}

### Audience-Specific Views

{{audienceViews}}

| Audience | View | Cadence | Decision Supported |
|----------|------|---------|---------------------|
| Executive | {{execView}} | {{execCadence}} | {{execDecision}} |
| Program / PMO | {{pmoView}} | {{pmoCadence}} | {{pmoDecision}} |
| Workstream | {{wsView}} | {{wsCadence}} | {{wsDecision}} |
| Operations | {{opsView}} | {{opsCadence}} | {{opsDecision}} |
| Finance | {{finView}} | {{finCadence}} | {{finDecision}} |

## 2. KPI Tree

{{kpiTree}}

### Tier 1 — Outcome KPIs (Lagging)

{{tier1Kpis}}

### Tier 2 — Driver KPIs (Leading)

{{tier2Kpis}}

### Tier 3 — Operational Indicators

{{tier3Kpis}}

## 3. Scorecards

{{scorecards}}

### Strategic Scorecard

{{strategicScorecard}}

| Objective | KPI | Baseline | Target | Today | Trend | Status |
|-----------|-----|----------|--------|-------|-------|--------|
{{strategicScorecardTable}}

### Operational Scorecard

{{operationalScorecard}}

| Metric | Baseline | Target | Today | Trend | Status |
|--------|----------|--------|-------|-------|--------|
{{operationalScorecardTable}}

### Financial Scorecard

{{financialScorecard}}

| Metric | Baseline | Target | Today | Variance | Status |
|--------|----------|--------|-------|----------|--------|
{{financialScorecardTable}}

## 4. Data Sources & Pipelines

{{dataSourcesPipelines}}

| Metric | Source System | Calculation | Refresh | Owner |
|--------|---------------|-------------|---------|-------|
{{dataSourcesTable}}

## 5. RAG Conventions

{{ragConventions}}

| Color | Threshold | Action Required |
|-------|-----------|------------------|
| Green | {{greenThresh}} | {{greenAction}} |
| Amber | {{amberThresh}} | {{amberAction}} |
| Red | {{redThresh}} | {{redAction}} |

## 6. Alerting & Triggers

{{alertingTriggers}}

## 7. Drill-Down Architecture

{{drillDownArch}}

## 8. Visual Design Principles

{{visualPrinciples}}

## 9. Operating Cadence

{{operatingCadence}}

## 10. Dashboard Investment

{{fcvBlock}}

{{dashboardInvestment}}

## 11. Confidence & Caveats

{{confidenceCommentary}}

{{dissentingAgents}}

---

{{agentAttributionFooter}}
