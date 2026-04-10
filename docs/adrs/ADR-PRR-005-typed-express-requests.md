# ADR-PRR-005: Type Express Request Objects to Eliminate `as any` Casts

## Status: IMPLEMENTED

## Date: 2026-04-10

## Priority: MEDIUM — Address during pilot

## Effort: 1 hour

## Context

Production readiness review (2026-04-10) found `(req as any)` type assertions in `src/routes.ts` for accessing `correlationId` and role headers. These casts bypass TypeScript's type safety at the API boundary — the exact place where type safety matters most.

The correlation ID is set by middleware (`requestLogger`) and the user role comes from the `X-User-Role` header. Both are accessed via `as any` because Express's `Request` type doesn't know about these custom properties.

## Decision

### 1. Declare a typed request interface

```typescript
// In src/types.ts or src/routes.ts
import type { Request } from 'express';

export interface TypedRequest extends Request {
  correlationId: string;
  userRole?: string;
  userId?: string;
}
```

### 2. Set properties in middleware with proper typing

```typescript
// In requestLogger middleware
app.use((req: TypedRequest, _res, next) => {
  req.correlationId = randomUUID();
  req.userRole = req.headers['x-user-role'] as string | undefined;
  req.userId = req.headers['x-user-id'] as string | undefined;
  next();
});
```

### 3. Use typed request in route handlers

```typescript
// Replace: (req as any).correlationId
// With:    (req as TypedRequest).correlationId
// Or use TypedRequest directly in handler signature:
router.get('/api/devices/scores', (req: TypedRequest, res) => {
  const scores = container.lifecycleScoring.scoreFleet(
    seedDevices, telemetryMap, req.correlationId
  );
  res.json({ scores, count: scores.length });
});
```

### 4. Alternatively, use Express module augmentation

```typescript
// In src/express.d.ts
declare global {
  namespace Express {
    interface Request {
      correlationId: string;
      userRole?: string;
      userId?: string;
    }
  }
}
```

This approach requires no changes to route handler signatures.

## Consequences

### Positive
- Compile-time detection of missing middleware properties
- No more `as any` casts at the API boundary
- IDE autocomplete for custom request properties
- TypeScript catches typos in property names

### Negative
- Module augmentation affects global Express types (minor concern for a focused application)
- Requires updating all route handler signatures or adding declaration file

## Related ADRs
- ADR-048: Domain Logic Not CRUD Shells
- ADR-PRR-004: Rejection Workflow (uses typed request in new endpoint)
