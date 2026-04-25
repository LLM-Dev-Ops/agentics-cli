# {{title}}

{{consensusBanner}}

**Date:** {{date}}
**Trace ID:** `{{traceId}}`
**Source of truth:** `unit-economics.json` (ADR-PIPELINE-066)

---

## 1. Unit Definition

{{unitDefinition}}

| Attribute | Value |
|-----------|-------|
| Unit type | {{unitType}} |
| Unit basis | {{unitBasis}} |
| Pilot scope (units) | {{pilotUnits}} |
| Enterprise scope (units) | {{enterpriseUnits}} |
| Scaling model | {{scalingModel}} |
| Scaling factor | {{scalingFactor}} |

## 2. Per-Unit Economics

{{fcvBlock}}

| Metric | Per-Unit | Pilot ({{pilotUnits}} units) | Enterprise ({{enterpriseUnits}} units) |
|--------|----------|-----------------------------|---------------------------------------|
| Savings $/unit | {{savingsPerUnit}} | {{pilotSavings}} | {{enterpriseSavings}} |
| Cost $/unit | {{costPerUnit}} | {{pilotCost}} | {{enterpriseCost}} |
| Margin $/unit | {{marginPerUnit}} | {{pilotMargin}} | {{enterpriseMargin}} |
| Throughput (units/period) | {{throughputPerPeriod}} | — | — |

## 3. Cost-to-Serve Decomposition

{{costToServe}}

## 4. Unit-Level Drivers

{{unitDrivers}}

### Driver Sensitivity

{{driverSensitivity}}

## 5. Scaling Methodology — Pilot to Enterprise

{{scalingMethodology}}

### Why we use {{scalingModel}} extrapolation

{{scalingRationale}}

### What would invalidate {{scalingModel}} extrapolation

{{scalingInvalidators}}

## 6. Sector Baseline / Peer Comparison

{{sectorBaseline}}

## 7. Reconciliation to Headline Numbers

The {{savingsFcv}} headline savings figure decomposes into:

{{reconciliation}}

## 8. Caveats — Where Per-Unit Becomes Misleading

{{perUnitCaveats}}

## 9. Confidence & Caveats

{{confidenceCommentary}}

{{dissentingAgents}}

---

{{agentAttributionFooter}}
