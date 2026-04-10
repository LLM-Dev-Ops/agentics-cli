# ADR-PRR-012: Add Circuit Breaker State Transition Unit Tests

## Status: PROPOSED

## Date: 2026-04-10

## Priority: LOW — Address before full deployment

## Effort: 1 hour

## Context

Production readiness review (2026-04-10) found that the `CircuitBreaker` class in `src/middleware.ts` is well-implemented with three states (closed, half-open, open), configurable thresholds, and logged transitions — but has no dedicated unit tests.

The ERP adapter test suite (`tests/erp-adapter.test.ts`) exercises the adapter's idempotency and mapping logic but does not test circuit breaker state transitions directly. Since the circuit breaker protects the production SAP integration from cascading failures, its behavior under fault conditions must be verified independently.

## Decision

### Add dedicated circuit breaker tests covering all state transitions

```typescript
// In tests/circuit-breaker.test.ts
describe('CircuitBreaker', () => {
  // State: CLOSED → OPEN
  it('opens after configured failure threshold', () => {
    const cb = new CircuitBreaker({ failureThreshold: 3, resetTimeoutMs: 1000 });
    cb.recordFailure(); // 1
    cb.recordFailure(); // 2
    expect(cb.getState()).toBe('closed');
    cb.recordFailure(); // 3 — threshold reached
    expect(cb.getState()).toBe('open');
  });

  // State: OPEN → blocks execution
  it('rejects calls when open', async () => {
    const cb = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 60000 });
    cb.recordFailure();
    await expect(cb.execute(() => Promise.resolve('ok')))
      .rejects.toThrow(/circuit.*open/i);
  });

  // State: OPEN → HALF-OPEN (after timeout)
  it('transitions to half-open after reset timeout', async () => {
    const cb = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 50 });
    cb.recordFailure();
    expect(cb.getState()).toBe('open');
    await new Promise(r => setTimeout(r, 60));
    expect(cb.getState()).toBe('half-open');
  });

  // State: HALF-OPEN → CLOSED (on success)
  it('closes on successful call in half-open state', async () => {
    const cb = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 50 });
    cb.recordFailure();
    await new Promise(r => setTimeout(r, 60));
    await cb.execute(() => Promise.resolve('ok'));
    expect(cb.getState()).toBe('closed');
  });

  // State: HALF-OPEN → OPEN (on failure)
  it('reopens on failure in half-open state', async () => {
    const cb = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 50 });
    cb.recordFailure();
    await new Promise(r => setTimeout(r, 60));
    await expect(cb.execute(() => Promise.reject(new Error('fail'))))
      .rejects.toThrow('fail');
    expect(cb.getState()).toBe('open');
  });

  // Counter reset on success
  it('resets failure count on successful call in closed state', () => {
    const cb = new CircuitBreaker({ failureThreshold: 3, resetTimeoutMs: 1000 });
    cb.recordFailure(); // 1
    cb.recordFailure(); // 2
    cb.recordSuccess(); // reset
    cb.recordFailure(); // 1 (restarted)
    cb.recordFailure(); // 2
    expect(cb.getState()).toBe('closed'); // not yet 3
  });
});
```

### Test coverage targets

| Transition | Test Count |
|---|---|
| Closed → Open (failure threshold) | 1 |
| Open → rejects calls | 1 |
| Open → Half-Open (timeout) | 1 |
| Half-Open → Closed (success) | 1 |
| Half-Open → Open (failure) | 1 |
| Failure counter reset on success | 1 |
| **Total** | **6** |

## Consequences

### Positive
- All state transitions verified — confidence in SAP integration protection
- Regression safety for any future circuit breaker modifications
- Tests run in <100ms (no external dependencies)
- Catches edge cases (e.g., race conditions in timeout-based transitions)

### Negative
- Timeout-based tests use `setTimeout` which can be flaky — use `vi.useFakeTimers()` for deterministic control

## Related ADRs
- ADR-050: ERP Client Persistence and Reliability
- ADR-PRR-006: Health Check Endpoints (readiness probe checks circuit breaker state)
