# ADR-PIPELINE-038: Fleet & Transportation Domain Support — Per-Vehicle Financial Models, Fleetio ERP, Regulatory Context

**Status:** Accepted
**Date:** 2026-04-09
**Priority:** HIGH — Fleet electrification run scored 5/10 on Executive Output and ERP Readiness

## Context

The fleet electrification evaluation exposed 3 domain-specific gaps:

1. **Financial model uses per-employee heuristics for a per-vehicle domain.** "$5.8M annual efficiency = 97,000 employees × $60/employee" is nonsensical for fleet electrification. The model should calculate fuel savings per vehicle class, maintenance reduction per EV, and charging infrastructure cost per depot.

2. **Fleetio is not in the ERP registry.** The erp_surface tool has no Fleetio definition, so it can't generate system-specific touchpoints, risks, or API schema.

3. **Executive documents lack regulatory and competitive context.** No mention of EU CO2 fleet standards, US EPA regulations, or competitor EV commitments (Amazon 100K vans, DHL 60% last-mile EVs). A consulting firm would frame "do nothing" as competitive disadvantage and regulatory risk.

## Decision

### 1. Fleet/Transportation Financial Model

Add to `tryDomainSpecificFinancials()`:
- Detect: fleet, vehicle, electrification, EV, delivery, logistics, truck, van
- Unit economics: vehicles × avg fuel cost/yr × fuel savings rate + maintenance reduction - charging infra cost
- Include: diesel-to-electric fuel differential per vehicle class, maintenance reduction (EVs have 30-40% lower maintenance), charging infrastructure per depot

### 2. Fleetio ERP in Registry

Add `fleetio` to `ErpSystemId` and `ERP_SYSTEMS` with modules: Fleet Management, Fuel Management, Maintenance, Parts Inventory, Inspections. Add system-specific touchpoints and detection pattern.

### 3. Regulatory & Competitive Context in Executive Documents

When the domain is fleet/transportation/logistics, the executive summary and decision memo must include:
- EU CO2 emission standards for heavy-duty vehicles (2025+)
- US EPA GHG standards
- Competitor EV fleet commitments as "do nothing" risk
- Government incentive programs for fleet electrification

### 4. Consensus Signal Disclosure

When the consensus agent reports <60% confidence, the executive summary must disclose this as a risk factor rather than hiding it.

## Implementation

Files to modify:
- `src/synthesis/simulation-renderers.ts` — Fleet financial model, regulatory context
- `src/commands/erp.ts` — Fleetio ERP definition
