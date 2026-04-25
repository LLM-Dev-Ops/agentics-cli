# {{title}}

{{consensusBanner}}

**Date:** {{date}}
**Trace ID:** `{{traceId}}`

---

## 1. Model Frame

{{modelFrame}}

### Model Purpose

{{modelPurpose}}

### Decision Supported

{{decisionSupported}}

### Model Type

{{modelType}}

## 2. Evaluation Methodology

{{evalMethodology}}

### Datasets

{{datasets}}

| Dataset | Size | Period | Source | Purpose |
|---------|------|--------|--------|---------|
{{datasetsTable}}

### Train / Validation / Test Split

{{trainValTestSplit}}

### Holdout / Production Comparison

{{holdoutProdComparison}}

## 3. Performance Metrics

{{performanceMetrics}}

| Metric | Train | Validation | Test | Production | Target |
|--------|-------|------------|------|-------------|--------|
{{metricsTable}}

### Confusion Matrix (Where Applicable)

{{confusionMatrix}}

### Calibration

{{calibration}}

## 4. Robustness Evaluation

{{robustnessEval}}

### Perturbation Tests

{{perturbationTests}}

### Adversarial Tests

{{adversarialTests}}

### Out-of-Distribution Tests

{{oodTests}}

## 5. Fairness & Bias Evaluation

{{fairnessBiasEval}}

| Protected Attribute | Disparity Metric | Result | Threshold | Status |
|--------------------|-------------------|--------|-----------|--------|
{{fairnessTable}}

## 6. Hallucination / Faithfulness (LLM-Based Models)

{{hallucinationFaithfulness}}

### Hallucination Rate

{{hallucinationRate}}

### Faithfulness Score

{{faithfulnessScore}}

### Citation Coverage

{{citationCoverage}}

## 7. Drift Evaluation

{{driftEval}}

### Data Drift

{{dataDrift}}

### Concept Drift

{{conceptDrift}}

### Drift Monitoring Plan

{{driftMonitoringPlan}}

## 8. Explainability

{{explainability}}

### Global Explanations

{{globalExplanations}}

### Local Explanations

{{localExplanations}}

## 9. Cost & Latency

{{costLatency}}

| Metric | Value |
|--------|-------|
| Inference latency p50 | {{latP50}} |
| Inference latency p99 | {{latP99}} |
| Cost per 1k inferences | {{costPer1k}} |
| Throughput | {{throughput}} |

## 10. Production Readiness

{{productionReadiness}}

### Recommended Posture

{{recommendedPosture}}

### Pre-Deploy Conditions

{{preDeployConditions}}

## 11. Model Risks

{{modelRisks}}

## 12. Confidence & Caveats

{{confidenceCommentary}}

{{dissentingAgents}}

---

{{agentAttributionFooter}}
