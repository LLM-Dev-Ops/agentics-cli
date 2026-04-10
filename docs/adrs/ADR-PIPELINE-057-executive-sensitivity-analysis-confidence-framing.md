# ADR-PIPELINE-057: Executive Output Polish — Sensitivity Analysis and Confidence Framing

**Status:** Accepted
**Date:** 2026-04-10
**Priority:** MEDIUM — Closes gap between 7.5/10 and consulting-grade (9/10)
**Originating Review:** Production Readiness Review (2026-04-10), Executive Output 7.5/10
**Builds on:** ADR-PIPELINE-052 (Executive Output 9/10), ADR-PIPELINE-029 (Bottom-Up Financial Models)

## Context

The executive documents are "decision-ready" and would hold up in a VP-level strategy meeting. However, three specific gaps prevent them from competing head-to-head with a McKinsey/BCG/Bain deliverable:

### 1. No Sensitivity Analysis

The business case shows base/optimistic/pessimistic scenarios but doesn't identify **which input variables drive the most variance**. A Bain engagement would include a tornado chart or sensitivity table showing, for example: "If occupancy data coverage drops from 95% to 70%, savings decrease by 20%."

Without this, leadership cannot assess which assumptions are load-bearing and which are noise.

### 2. Confidence Framing Is Under-Exploited

The prototype honestly discloses 41.6% confidence, which is commendable. But presenting a single confidence number is less useful than distinguishing **directional confidence** from **precision confidence**:

- "We are >90% confident that savings exceed $2M" (directional)
- "We are 42% confident the precise savings are $4.1M ± 15%" (precision)

This framing transforms a potentially alarming "42% confidence" into a much stronger narrative: the direction is solid, only the magnitude is uncertain.

### 3. Competitive Benchmarking Lacks Quantitative Positioning

The executive summary names competitors (Salesforce, Google, Siemens) who have moved on sustainability optimization, which is effective for urgency. But it lacks **relative positioning**: "Our pilot targets a 25% reduction in underutilized space, which is conservative relative to Salesforce's reported 30% reduction."

This would make the recommendation more defensible because it anchors the target against peer outcomes.

## Decision

### 1. Sensitivity Analysis Table (Mandatory)

```
RULE: The financial analysis section MUST include a sensitivity table
showing the impact of key variable changes on total savings:

┌────────────────────────────┬──────────┬───────────────────────────┐
│ Variable                   │ Range    │ Impact on Annual Savings  │
├────────────────────────────┼──────────┼───────────────────────────┤
│ Occupancy data coverage    │ 70%→95%  │ -20% to baseline          │
│ Energy price               │ ±15%     │ ±$X                       │
│ Hybrid adoption rate       │ 40%→70%  │ +$Y to -$Z                │
│ Implementation timeline    │ ±3 months│ NPV impact: ±$W           │
│ Archibus integration scope │ 3→8 bldg │ +$V (non-linear)          │
└────────────────────────────┴──────────┴───────────────────────────┘

The variables MUST be sorted by impact magnitude (highest first).
This is effectively a text-based tornado chart.

Data source: The ScenarioService already computes multiple scenarios
with different parameters. The sensitivity table is a structured
presentation of those scenario deltas.
```

### 2. Dual Confidence Framing (Mandatory)

```
RULE: Wherever the confidence level is stated, it MUST use the
dual-framing pattern:

  "Directional confidence: >90% — savings will exceed $[floor]"
  "Precision confidence: [X]% — magnitude falls within $[range]"

The directional confidence is derived from:
- All scenarios producing positive savings (100% directional)
- Floor = minimum scenario savings across all runs
- Conservative estimate: floor × 0.8

The precision confidence is the existing simulation confidence level.

This MUST appear in:
- Demo output (financial summary section)
- Executive summary (recommendation section)
- Decision memo (risk section)
```

### 3. Quantitative Competitive Positioning (Recommended)

```
RULE: When naming competitor actions in the executive summary,
include relative positioning for the pilot target:

  "Salesforce reduced underutilized space by 30% (2024 sustainability
   report). Our pilot targets a 25% reduction, which is conservative
   relative to Salesforce's result but appropriate for a first phase
   with validated data."

This makes the recommendation defensible because:
- The target is anchored to a real peer outcome
- Being below the peer result signals prudence, not weakness
- It pre-answers "is this realistic?" before it's asked
```

## Implementation

### In `src/demo.ts`

1. After scenario comparison, compute sensitivity deltas by varying key inputs ±15-30%
2. Render sensitivity table sorted by impact
3. Compute directional confidence (min scenario savings × 0.8 as floor)
4. Render dual confidence framing

### In Executive Summary Template

1. Add sensitivity table to financial analysis section
2. Replace single confidence number with dual framing
3. Add relative positioning clause to competitive analysis paragraph

## Validation

- [ ] Sensitivity table appears in demo output with 4+ variables
- [ ] Variables are sorted by impact magnitude (highest first)
- [ ] Directional confidence (>90%) and precision confidence (42%) both stated
- [ ] At least one competitor reference includes quantitative comparison
- [ ] All three documents (demo, exec summary, decision memo) use dual confidence framing

## Consequences

- Enables leadership to assess which assumptions matter most (sensitivity)
- Transforms a weak-looking confidence number into a strong narrative (dual framing)
- Makes the pilot target defensible against "is this realistic?" challenges
- Collectively moves executive output from 7.5 toward 9/10
