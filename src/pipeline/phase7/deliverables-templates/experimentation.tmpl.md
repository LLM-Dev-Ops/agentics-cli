# {{title}}

{{consensusBanner}}

**Date:** {{date}}
**Trace ID:** `{{traceId}}`

---

## 1. Experimentation Frame

{{experimentationFrame}}

### Why a Formal Framework

{{whyFramework}}

### Experiment Types Supported

{{experimentTypes}}

| Type | Use-Case | Method | Time-to-Read |
|------|----------|--------|---------------|
| A/B test | {{abUseCase}} | {{abMethod}} | {{abTtr}} |
| Multi-armed bandit | {{mabUseCase}} | {{mabMethod}} | {{mabTtr}} |
| Holdout / quasi-experiment | {{hoUseCase}} | {{hoMethod}} | {{hoTtr}} |
| Switchback / interleaved | {{swUseCase}} | {{swMethod}} | {{swTtr}} |
| Synthetic control | {{scUseCase}} | {{scMethod}} | {{scTtr}} |

## 2. Experiment Lifecycle

{{experimentLifecycle}}

1. Hypothesis & primary metric
2. Pre-registration (sample size, power, MDE)
3. Randomization & assignment
4. Run window
5. Analysis & decision
6. Post-decision review

## 3. Hypothesis Standard

{{hypothesisStandard}}

### Hypothesis Template

{{hypothesisTemplate}}

### Primary vs. Guardrail Metrics

{{primaryGuardrails}}

## 4. Power, Sample-Size, MDE

{{powerSampleSize}}

| Concept | Definition | Default |
|---------|-----------|---------|
| Statistical power | {{powerDef}} | {{powerDefault}} |
| Significance (α) | {{alphaDef}} | {{alphaDefault}} |
| Minimum detectable effect | {{mdeDef}} | {{mdeDefault}} |

### Sample-Size Calculator Inputs

{{sampleSizeInputs}}

## 5. Randomization & Assignment

{{randomization}}

## 6. Guardrail Metrics

{{guardrailMetrics}}

| Guardrail | Why | Stop Threshold |
|-----------|-----|----------------|
{{guardrailTable}}

## 7. Analysis Standards

{{analysisStandards}}

### Pre-Registered Analysis

{{preregAnalysis}}

### Multiple-Comparison Correction

{{multipleComparison}}

### Heterogeneous Treatment Effects

{{heteroEffects}}

## 8. Decision Rules

{{decisionRules}}

### Ship / Hold / Iterate Rules

{{shipHoldIterate}}

### Auto-Stop Rules

{{autoStopRules}}

## 9. Experimentation Operations

{{experimentationOps}}

### Tooling

{{experimentTooling}}

### Review Cadence

{{reviewCadence}}

### Experiment Catalog

{{experimentCatalog}}

## 10. Anti-Patterns to Avoid

{{antiPatterns}}

## 11. Investment

{{fcvBlock}}

{{experimentationInvestment}}

## 12. Confidence & Caveats

{{confidenceCommentary}}

{{dissentingAgents}}

---

{{agentAttributionFooter}}
