# {{title}}

{{consensusBanner}}

**Date:** {{date}}
**Trace ID:** `{{traceId}}`
**Plan type:** **{{plan_kind}}**

---

## 1. Plan Frame

{{planFrame}}

### Time Horizon

{{timeHorizon}}

### Granularity

{{granularity}}

## 2. Milestones

{{milestones}}

| # | Milestone | Date | Workstream | Owner | Exit Criteria | Predecessors |
|---|-----------|------|-----------|-------|---------------|---------------|
{{milestonesTable}}

## 3. Critical Path

{{criticalPath}}

### Critical-Path Activities

{{cpActivities}}

### Float / Slack on Non-Critical Paths

{{floatSlack}}

## 4. Dependency Map

{{dependencyMap}}

### Internal Dependencies

| # | Predecessor | Successor | Type | Lead/Lag | Risk |
|---|-------------|-----------|------|----------|------|
{{internalDependenciesTable}}

### External Dependencies

| # | Dependency | External Owner | Required By | Confidence |
|---|------------|----------------|-------------|------------|
{{externalDependenciesTable}}

## 5. Resource Plan

{{resourcePlan}}

| Role | FTE Q1 | FTE Q2 | FTE Q3 | FTE Q4 | Source |
|------|--------|--------|--------|--------|--------|
{{resourcePlanTable}}

### Capacity Constraints

{{capacityConstraints}}

## 6. Budget Plan

{{fcvBlock}}

| Category | Q1 | Q2 | Q3 | Q4 | Year Total |
|----------|----|----|----|----|------------|
{{budgetTable}}

### Budget Reserves

{{budgetReserves}}

## 7. Schedule Buffers

{{scheduleBuffers}}

## 8. Re-Plan Triggers

{{rePlanTriggers}}

## 9. Schedule Risks

{{scheduleRisks}}

## 10. Confidence & Caveats

{{confidenceCommentary}}

{{dissentingAgents}}

---

{{agentAttributionFooter}}
