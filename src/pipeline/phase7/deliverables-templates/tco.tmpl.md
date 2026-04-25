# {{title}}

{{consensusBanner}}

**Date:** {{date}}
**Trace ID:** `{{traceId}}`
**Horizon:** {{tcoHorizon}}
**Source of truth:** `unit-economics.json` (ADR-PIPELINE-066)

---

## 1. Scope

{{tcoScope}}

### What's In

{{tcoInScope}}

### What's Out

{{tcoOutOfScope}}

## 2. TCO Summary

{{fcvBlock}}

| Period | Capex | Opex | Total TCO |
|--------|-------|------|-----------|
| Year 1 | {{capexY1}} | {{opexY1}} | {{tcoY1}} |
| Year 3 (cumulative) | {{capexY3}} | {{opexY3}} | {{tcoY3}} |
| Year 5 (cumulative) | {{capexY5}} | {{opexY5}} | {{tcoY5}} |

## 3. Cost Breakdown by Category

| Category | Year 1 | Year 3 (cum.) | Year 5 (cum.) | % of TCO |
|----------|--------|---------------|---------------|----------|
| Software licensing | {{licY1}} | {{licY3}} | {{licY5}} | {{licPct}} |
| Cloud infrastructure | {{cloudY1}} | {{cloudY3}} | {{cloudY5}} | {{cloudPct}} |
| Integration & data | {{intY1}} | {{intY3}} | {{intY5}} | {{intPct}} |
| Professional services | {{psY1}} | {{psY3}} | {{psY5}} | {{psPct}} |
| Internal labor | {{laborY1}} | {{laborY3}} | {{laborY5}} | {{laborPct}} |
| Training & change mgmt | {{trainY1}} | {{trainY3}} | {{trainY5}} | {{trainPct}} |
| Maintenance & support | {{maintY1}} | {{maintY3}} | {{maintY5}} | {{maintPct}} |
| Compliance & audit | {{compY1}} | {{compY3}} | {{compY5}} | {{compPct}} |
| Contingency | {{contY1}} | {{contY3}} | {{contY5}} | {{contPct}} |

## 4. Hidden / Often-Forgotten Costs

{{hiddenCosts}}

## 5. TCO vs. Alternatives

{{tcoVsAlternatives}}

## 6. Cost-Benefit Reconciliation

| Period | TCO | Cumulative Savings | Net |
|--------|-----|--------------------|-----|
| Year 1 | {{tcoY1}} | {{savY1}} | {{netY1}} |
| Year 3 | {{tcoY3}} | {{savY3}} | {{netY3}} |
| Year 5 | {{tcoY5}} | {{savY5}} | {{netY5}} |

**Crossover (savings exceed TCO):** {{crossoverPoint}}

## 7. Cost Drivers — Sensitivity

{{costDriverSensitivity}}

## 8. Confidence & Caveats

{{confidenceCommentary}}

{{dissentingAgents}}

---

{{agentAttributionFooter}}
