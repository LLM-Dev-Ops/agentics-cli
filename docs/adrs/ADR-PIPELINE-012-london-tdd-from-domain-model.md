# ADR-PIPELINE-012: London School TDD Tests Wired to Domain Model

## Status
Implemented

## Context
ADR-005 implemented London School TDD test generation in `test-generator.ts`. The new generator produces mock factories, command handler interaction tests, and seam integration tests. However, in the `081f90a2` run, the test files still contain the old trivial pattern:

```typescript
describe('turnaround-delay-likely-unit', () => {
  it('turnaround-delay-likelyAggregate creation', () => {
    const existing = { id: 'agg-1', status: 'active', createdAt: new Date().toISOString() };
    const result = existing;
    expect(result.id ?? result.aggregateId).toBeDefined();
  });
});
```

This means the new London School test generator is either not being invoked for this run, or the bounded context lookup from `domainModel` is failing to match context names to TDD test suite `boundedContext` fields. The ADR-005 implementation matches on `s.boundedContext.toLowerCase() === ctx.name.toLowerCase()` but the TDD plan may use different naming (e.g., `turnaround-delay` vs `turnaround-delay-likely`).

## Decision
Fix the London School test generator to reliably wire TDD plan suites to DDD bounded contexts:

1. **Fuzzy context matching**: Match TDD suite `boundedContext` to DDD context using slug normalization, substring matching, and Levenshtein distance
2. **Fallback generation**: When no TDD suite matches a context, generate tests directly from the context's commands/queries/events (mock repo + event publisher, verify save/publish calls)
3. **Test naming**: Use command/query names from the DDD model as `describe/it` block names, not slugified aggregate names
4. **Assert real values**: Tests should verify command handler return values, event payloads, and query result shapes — not just `toBeDefined()`

## Files to Change
- `src/pipeline/phase3/phases/test-generator.ts` — fix context matching logic; add fallback test generation from DDD commands/queries when no TDD suite matches; improve test assertion specificity

## Consequences
- Every bounded context gets London School TDD tests even if the TDD plan naming doesn't match exactly
- Test names correspond to actual DDD command/query names
- Tests verify real interaction patterns (mock.save called with correct state, mock.publish called with correct event type)
- No more single-assertion `toBeDefined()` stub tests
