# ADR-PRR-010: Replace Global Correlation ID with AsyncLocalStorage

## Status: PROPOSED

## Date: 2026-04-10

## Priority: LOW — Address before full deployment

## Effort: 2 hours

## Context

Production readiness review (2026-04-10) found that `src/logger.ts` uses a module-level `let currentCorrelationId` variable set by `setCorrelationId()`. This works for the single-threaded CLI demo but breaks under concurrent HTTP requests — each request would overwrite the global, causing correlation IDs to leak across requests.

Most service methods already accept `correlationId` as a parameter (the correct pattern). The global is used as a fallback in the logger's `createLogEntry()` function when no explicit ID is provided.

## Decision

### 1. Use Node.js `AsyncLocalStorage` for request-scoped context

```typescript
// In src/context.ts (new)
import { AsyncLocalStorage } from 'node:async_hooks';

export interface RequestContext {
  correlationId: string;
  userId?: string;
  userRole?: string;
}

export const requestContext = new AsyncLocalStorage<RequestContext>();

export function getCorrelationId(): string {
  return requestContext.getStore()?.correlationId ?? 'no-context';
}
```

### 2. Set context in middleware

```typescript
// In src/middleware.ts or app setup
import { requestContext } from './context.js';

app.use((req, res, next) => {
  const ctx: RequestContext = {
    correlationId: randomUUID(),
    userId: req.headers['x-user-id'] as string | undefined,
    userRole: req.headers['x-user-role'] as string | undefined,
  };
  requestContext.run(ctx, () => next());
});
```

### 3. Update logger to read from AsyncLocalStorage

```typescript
// In src/logger.ts
import { getCorrelationId } from './context.js';

// Remove: let currentCorrelationId: string | undefined;
// Remove: export function setCorrelationId(id: string) { ... }

function createLogEntry(level: string, service: string, event: string, data?: Record<string, unknown>) {
  return {
    timestamp: new Date().toISOString(),
    level,
    service,
    event,
    correlationId: getCorrelationId(),  // ← from AsyncLocalStorage
    ...data,
  };
}
```

### 4. Demo script compatibility

For CLI execution (no Express middleware), wrap the demo in a context:

```typescript
requestContext.run({ correlationId: randomUUID() }, async () => {
  await runDemo();
});
```

## Consequences

### Positive
- Correlation IDs are request-scoped — correct under concurrent requests
- No global mutable state
- Eliminates need to pass `correlationId` through every function signature (though explicit passing remains valid and preferred for clarity)
- AsyncLocalStorage is stable in Node.js 16+ (no experimental flag)

### Negative
- Small performance overhead (~2-5% for async operations, negligible in practice)
- Adds a dependency on `node:async_hooks`
- Developers must ensure `requestContext.run()` wraps all request entry points
- Tests must wrap test execution in context or provide a test helper

## Related ADRs
- ADR-051: Simulation Lineage and Observability
- ADR-PRR-005: Type Express Request Objects (can share the RequestContext type)
- ADR-PRR-006: Health Check Endpoints
