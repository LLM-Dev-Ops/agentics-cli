# ADR-PIPELINE-005: London School TDD Test Generation

## Status
Implemented

## Context
The generated test files are trivial 1-assertion stubs:

```typescript
describe('inventory-management-unit', () => {
  it('inventory-managementAggregate creation', () => {
    const existing = { id: 'agg-1', status: 'active', createdAt: new Date().toISOString() };
    const result = existing;
    expect(result.id ?? result.aggregateId).toBeDefined();
  });
});
```

This tests nothing. The TDD plan has 24 test suites with specific test cases, but the test generator ignores them and emits a single assertion per context.

## Decision
Generate tests that follow London School TDD from the TDD plan artifacts:

1. **Unit tests per command handler**: Mock the repository and event publisher. Verify the handler calls `repository.save()` with the correct aggregate state and `eventPublisher.publish()` with the correct event type.

2. **Unit tests per query handler**: Provide an in-memory adapter. Verify the query returns the expected shape.

3. **Integration tests per seam**: Test that the adapter contract (port interface) is satisfied by the real adapter implementation.

4. **Test structure**: Use `describe/it` blocks named after the actual commands and queries from the DDD model. Use `vi.fn()` for mocks.

5. **Read the TDD plan**: The `tdd-plan.json` contains test suite names, test case descriptions, and mock contract definitions. Use them.

## Files to Change
- `src/pipeline/phase5-build/phases/domain-codegen.ts` (or the test generation section) — rewrite test file generation to produce London School TDD tests from tdd-plan.json
- Read `tdd/test-suites/{context}.json` for per-context test cases
- Read `tdd/mock-contracts.json` for mock definitions
- Read `tdd/seam-definitions.json` for integration test boundaries

## Consequences
- Tests verify actual behavior (command handler interactions, query return shapes)
- Tests use mocks at aggregate boundaries (London School)
- Test file names and describe blocks match the DDD model
- Tests are runnable with vitest out of the box
