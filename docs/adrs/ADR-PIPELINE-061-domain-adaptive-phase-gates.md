# ADR-PIPELINE-061: Domain-Adaptive Phase Gate Criteria in Roadmap Renderer

**Status:** Accepted
**Date:** 2026-04-10
**Priority:** HIGH — Executive Output 7.5 → 10/10
**Originating Review:** Production Readiness Review (2026-04-10), Executive Output category

## Context

The roadmap renderer currently emits **three hardcoded generic phase gates** regardless of the scenario:

```typescript
// src/synthesis/simulation-renderers.ts:2514–2518
phase_gates: [
  { after_phase: 'phase-1', gate: 'Discovery Complete',
    criteria: `${primarySystem} API validated, requirements signed off, team resourced`,
    decision: 'Proceed to build or pivot' },
  { after_phase: 'phase-2', gate: 'Prototype Validated',
    criteria: 'Core functionality demonstrated, integration tested, stakeholder approval',
    decision: 'Proceed to validation or iterate' },
  { after_phase: 'phase-3', gate: 'Pilot Ready',
    criteria: 'All tests passing, security review complete, operations runbook approved',
    decision: 'Deploy to production or address gaps' },
],
```

The `criteria` strings are unquantified ("requirements signed off", "Core functionality demonstrated") and `decision` strings are ambiguous ("Proceed to build or pivot"). Consulting-grade output requires each gate to specify:

1. **Metric** — what is measured
2. **Threshold** — the numeric/boolean pass value
3. **Data source** — where the metric comes from
4. **Decision authority** — who makes the go/no-go call

None of these are in the current output. Executives cannot use the roadmap as a pilot contract because there's no objective way to evaluate whether a gate has been passed.

## Decision

### 1. Replace the Hardcoded Block with a Builder

Introduce `buildPhaseGates()` in `src/synthesis/simulation-renderers.ts` that returns an array of structured gates. Each gate has `criteria: GateCriterion[]` where:

```typescript
interface GateCriterion {
  metric: string;          // "ERP API field coverage"
  threshold: string;       // ">=80% of required fields"
  dataSource: string;      // "integration test results"
  decisionAuthority: string; // "CTO + VP Operations"
}

interface PhaseGate {
  afterPhase: string;
  gate: string;
  criteria: GateCriterion[];
  overallDecision: string;
}
```

### 2. Derive Criteria from Scenario Context

The builder receives the already-extracted scenario context (`extracted` from `extractScenarioFromQuery`, `primarySystem`, `regulations` from `detectApplicableRegulations`). It uses domain rules to emit appropriate criteria:

- **Gate 1 (technical validation):** always emit ERP field coverage + system uptime + audit integrity. If `regulations` contains CSRD/SOX/HIPAA, also emit compliance-mapping check.
- **Gate 2 (business validation):** derive from `fin` (synthesized financials). If `fin.roi` is present, emit "realized savings within ±30% of projected". If `fin.payback` is present, emit "payback trajectory on track". Always emit user adoption and false-positive rate.
- **Gate 3 (scale readiness):** derive from `successProb` and `risks`. Always emit "zero critical security findings" and "load test p95 below SLA" (SLA value configurable).

### 3. Thresholds Come from a Config Table, Not Code

Create `src/synthesis/phase-gate-thresholds.ts` exporting:

```typescript
export const PHASE_GATE_THRESHOLDS = {
  erpFieldCoveragePct: 0.80,
  scoringAccuracyPct: 0.75,
  systemUptimePct: 0.99,
  savingsVariancePct: 0.30,
  userAdoptionPct: 0.60,
  falsePositiveRatePct: 0.10,
  erpTransactionSuccessPct: 0.95,
  projectedRoiMultiplier: 1.50,
  securityCriticalFindings: 0,
  dbLatencyP95Ms: 200,
} as const;
```

These are the values a reviewer can tune without editing business logic. They are NOT environment variables — they are consulting defaults compiled into the pipeline.

### 4. Decision Authority Is Domain-Derived

The `decisionAuthority` string is generated from the stakeholder set extracted from the query. Examples:

- Default: `"CTO + VP ${primaryDept}"`
- If query mentions CFO or budget: `"CFO + CTO"`
- If query mentions board, steering committee: `"Steering Committee"`
- Gate 3 always escalates one level above Gate 2.

### 5. Render as a Table, Not a Flat String

The `renderRoadmap` renderer (or whichever function consumes `phase_gates`) renders each gate as a markdown table with rows `Metric | Threshold | Data Source | Status`, and a footer `Decision: {overallDecision} — Authority: {decisionAuthority}`.

## Acceptance Criteria

1. `grep "Discovery Complete\|Prototype Validated\|Pilot Ready" src/synthesis/simulation-renderers.ts` returns zero matches.
2. A rendered roadmap for a sustainability scenario contains ≥4 criteria per gate, each with a numeric threshold and a named data source.
3. A rendered roadmap for a finance scenario has `decisionAuthority` mentioning CFO at Gate 2 or 3.
4. Unit test `tests/synthesis/phase-gates.test.ts` verifies the builder emits valid `PhaseGate[]` for at least 3 distinct query shapes (sustainability, supply chain, compliance).

## Consequences

### Positive
- Phase gates become pilot contracts instead of motivational posters
- Reviewers can verify "is this consulting-grade?" with one glance at the table
- Tunable thresholds stay in one file, not scattered string literals

### Negative
- New `buildPhaseGates()` adds ~150 lines to `simulation-renderers.ts` (already 3134 lines — consider extracting)
- Phase gate table increases roadmap doc length by ~30 lines

## Related
- ADR-PIPELINE-052 (Executive Output 9/10 — roadmap scope)
- ADR-PIPELINE-057 (Executive Polish — sister ADR for sensitivity/competitive)
- ADR-PIPELINE-060 (10/10 Scorecard — this is one of the gaps)
