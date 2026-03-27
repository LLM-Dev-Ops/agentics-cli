# ADR-060: Fix Missing Imports and Unit Tests That Test Real Code

## Status: ACCEPTED

## Date: 2026-03-27

## Context

Audit found two related build-breaking issues:

1. **CQ-CRITICAL**: `routes.ts:68` — `requireRole()` calls `createMiddleware()` which is never imported from `hono/factory`. The server cannot start.
2. **CQ-CRITICAL**: All 13 unit test files reference `randomUUID()` without importing it — they crash at runtime with `ReferenceError`.
3. **CQ-HIGH**: Unit tests define inline `Mock*Adapter` classes. Zero imports of real implementation. 100% of tests pass even if every adapter is deleted.

These are all Phase 4 code generator bugs — the generated output has missing imports.

## Decision

### 1. Phase 4 routes generator must import createMiddleware

`tsRoutes()` generates `requireRole()` which uses `createMiddleware`. The routes file must include:

```typescript
import { createMiddleware } from 'hono/factory';
```

This import must appear in the routes.ts generated output alongside the Hono import.

### 2. Phase 4 test generator must import randomUUID

`tsContextTest()` generates mock adapters that call `randomUUID()` but never import it. Add:

```typescript
import { randomUUID } from 'node:crypto';
```

### 3. Unit tests must import and test real adapters

Replace the pattern:
```typescript
// BAD: inline mock that tests nothing
class MockSupplierAdapter implements ISupplierPort {
  private store = new Map();
  async execute() { /* reimplements adapter logic */ }
}
```

With:
```typescript
// GOOD: imports real adapter and tests it with a test DbClient
import { createDependencies } from '../server/dependencies.js';
const testDb = createInMemoryDb(); // SQLite
const deps = createDependencies(testDb, mockErp);
const adapter = deps.supplier; // real adapter, real SQL
```

### 4. Post-generation import validation

After Phase 4 generates files, scan for common missing imports:
- `createMiddleware` used without import from `hono/factory`
- `randomUUID` used without import from `node:crypto`
- `createHash` used without import from `node:crypto`

## Consequences

- (+) Generated code compiles and runs without import errors
- (+) Unit tests verify real adapter behavior
- (-) Requires updating `tsRoutes()` and `tsContextTest()` in http-server-generator.ts

## Audit References

- CQ-CRITICAL: Missing import breaks compilation (createMiddleware)
- CQ-CRITICAL: Unit tests crash at runtime (randomUUID not imported)
- CQ: Unit tests test mocks, not code
