# ADR-PIPELINE-053: Prototype-to-Enterprise Savings Reconciliation — Bridge the $1.08M vs $4.1M Gap

**Status:** Accepted
**Date:** 2026-04-10
**Priority:** CRITICAL — Single most visible inconsistency between prototype and executive documents
**Originating Review:** Production Readiness Review (2026-04-10), Simulation Alignment 7.5/10

## Context

The prototype analysis computes $1,080,453 in annual savings across 3 pilot buildings (San Francisco, London, Singapore). The executive summary projects $4.1M in annual savings for enterprise-wide rollout across ~68,000 employees. This 3.8x gap is not explained anywhere in the demo output or the business case section.

Both numbers are defensible — the prototype analyzes a pilot subset while the executive summary models full enterprise rollout — but without an explicit bridge, a reviewer reading both documents will see a contradiction that destroys credibility.

This was flagged as **Improvement #1 (Days 1-2)** in the production readiness review.

### Additionally Affected

- The executive summary states "$2.0M–$3.1M total investment" while the decision memo recommends a "$600K–$900K pilot." Both are correct (pilot Phase 1 vs. full program) but the relationship is never stated.
- No bottoms-up savings waterfall exists. The $1.08M is presented as an aggregate with no visible derivation by component (energy, maintenance, HVAC, lease).

## Decision

### 1. Demo Output Must Bridge Pilot → Enterprise

```
RULE: The demo script MUST include an explicit extrapolation section:

"Pilot scope (3 buildings, ~X employees): $1,080,453/yr savings"
"Enterprise extrapolation (68,000 employees, proportional): $4.1M/yr"
"Extrapolation method: [linear/weighted by region]"
"Confidence: Pilot data = measured; enterprise = projected"

This is NOT optional. The bridge must appear in demo output AND
in the executive summary's financial section.
```

### 2. Bottoms-Up Savings Waterfall in Demo Output

```
RULE: The demo MUST break aggregate savings into component categories:

┌─────────────────────┬────────────────┬────────────────┐
│ Category            │ Pilot (3 bldg) │ Enterprise     │
├─────────────────────┼────────────────┼────────────────┤
│ Energy reduction    │ $X             │ $X × factor    │
│ HVAC optimization   │ $Y             │ $Y × factor    │
│ Maintenance savings │ $Z             │ $Z × factor    │
│ Lease optimization  │ $W             │ $W × factor    │
├─────────────────────┼────────────────┼────────────────┤
│ TOTAL               │ $1,080,453     │ $4,100,000     │
└─────────────────────┴────────────────┴────────────────┘

The data is already computed per-scenario in ScenarioService —
it just needs to be surfaced. This is aggregation, not new modeling.
```

### 3. Cross-Document Investment Consistency

```
RULE: Every executive document that references an investment figure
MUST state which scope it refers to:

- "$600K–$900K" → always followed by "(Phase 1 pilot, 3 buildings)"
- "$2.0M–$3.1M" → always followed by "(full enterprise program, 3 phases)"
- "The $600K–$900K pilot is Phase 1 of the $2.0M–$3.1M full program."

This sentence MUST appear in both the executive summary and the
decision memo to prevent scope confusion.
```

## Implementation

### In `src/demo.ts`

Add a "Financial Bridge" section after scenario analysis that:
1. Aggregates savings by category (energy, maintenance, HVAC, lease) across all scenarios
2. Computes per-employee or per-sqft multiplier from pilot data
3. Extrapolates to enterprise scale using the multiplier
4. Renders the waterfall table

### In Executive Summary Generation

The executive summary template must include:
- Savings waterfall table (same as demo)
- Explicit scope labels on every dollar figure
- Bridge sentence connecting pilot to full program investment

## Validation

- [ ] Demo output includes "Pilot scope: $X / Enterprise projection: $Y" with method
- [ ] Savings waterfall table appears in demo output
- [ ] No dollar figure in executive documents appears without scope label
- [ ] Decision memo includes Phase 1 → full program bridge sentence

## Consequences

- Eliminates the single most visible credibility gap in the prototype
- Makes the financial model auditable (a reader can verify each component)
- Enables leadership to see both the measured result and the projected upside
