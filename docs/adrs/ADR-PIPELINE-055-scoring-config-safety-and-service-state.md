# ADR-PIPELINE-055: Scoring Configuration Safety — Weight Validation and Service State Isolation

**Status:** Accepted
**Date:** 2026-04-10
**Priority:** MEDIUM — Prevents silent misconfiguration and test fragility
**Originating Review:** Production Readiness Review (2026-04-10), Code Quality 7.5/10

## Context

Two related configuration/state issues were identified:

### 1. Scoring Weights Can Silently Drift from 1.0

The scoring config defines three weights (`avgOccupancyWeight`, `peakVarianceWeight`, `flexibilityWeight`) with defaults of 0.60, 0.25, 0.15 (sum = 1.0). These are individually validated as numbers between 0 and 1, but nothing enforces that they sum to 1.0.

If an operator sets `SCORING_AVG_OCCUPANCY_WEIGHT=0.7` without adjusting the others, the weights sum to 1.1 and all zone scores are inflated. This is a silent misconfiguration that produces plausible-looking but incorrect results — the worst kind of bug.

### 2. In-Memory Service State Accumulates Across Tests

`DecisionService` stores decisions in a `Map` instance field. `AuditService` stores the chain in an `Array`. The `container.ts` module creates these as singletons. When Vitest imports the demo module across multiple tests, module caching causes state from earlier tests to leak into later tests (e.g., the audit chain grows to 20 entries by the 5th test run).

This isn't a production bug — production runs once — but it's a test fragility that will cause false positives/negatives as test coverage grows.

## Decision

### 1. Zod Refinement for Weight Sum Validation

```
RULE: The scoring config schema MUST include a refinement that
validates weights sum to 1.0 (within floating-point tolerance):

ScoringConfigSchema.refine(
  (cfg) => Math.abs(
    cfg.avgOccupancyWeight + cfg.peakVarianceWeight + cfg.flexibilityWeight - 1.0
  ) < 0.001,
  { message: 'Scoring weights must sum to 1.0' }
);

This triggers at startup. A misconfigured weight set produces a
clear error: "Scoring weights must sum to 1.0 (got 1.1)"
instead of silently generating wrong scores.
```

### 2. Unused Parameters Must Be Wired or Removed

```
RULE: The private methods in ScenarioService —
createConsolidationScenario, createScheduleScenario,
createSpaceReductionScenario — accept a correlationId parameter
that is never logged or used.

Either:
(a) Wire correlationId into logger calls within those methods, OR
(b) Remove the parameter entirely

Option (a) is preferred because scenario generation is the most
complex business logic and correlation tracing through it aids
debugging during pilot.
```

### 3. Service State Reset for Test Isolation

```
RULE: Stateful services (DecisionService, AuditService, ERPAdapter)
MUST expose a reset() method:

  reset(): void {
    this.decisions.clear();  // or this.chain = [];
  }

Alternatively, the container module SHOULD export a factory function:

  export function createContainer(): Container { ... }

Tests call createContainer() per test suite to get a fresh
dependency graph. This is the preferred approach as it avoids
exposing test-only methods on production classes.
```

## Implementation

### In `src/config.ts`

Add `.refine()` to the scoring weights section of AppConfigSchema.

### In `src/services/scenarios.ts`

Wire `correlationId` into `this.logger.info()` calls in the three private scenario creation methods.

### In `tests/*.test.ts`

Refactor demo tests to use a factory container or call `beforeEach(() => container.audit.reset())` to prevent cross-test state leakage.

## Validation

- [ ] Setting weights that sum to 1.1 causes startup failure with clear message
- [ ] Setting weights that sum to 1.0 passes validation
- [ ] Running full test suite twice in succession produces identical results
- [ ] `correlationId` appears in scenario generation log entries

## Consequences

- Prevents the most dangerous class of configuration error (plausible wrong output)
- Eliminates intermittent test failures as coverage increases
- Improves debuggability of the most complex business logic path
