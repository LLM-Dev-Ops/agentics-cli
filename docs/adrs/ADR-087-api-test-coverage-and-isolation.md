# ADR-087: API Route Test Coverage and Test Isolation

## Status: IMPLEMENTED

## Date: 2026-04-01

## Context

Production readiness audit (2026-04-01) scored Test Quality 6/10 — the lowest category — with four gaps:

1. **Zero API endpoint tests** (-2.0): 129 tests exist for domain logic (scenario calculations, approval workflows, hash chains) but no tests exercise the HTTP route layer. RBAC enforcement (401/403), Zod validation errors (422), correlation ID propagation, and error response format are all untested at the API level.

2. **Shared mutable state between tests** (-1.0): Tests share an in-memory database without per-test cleanup. Test execution order affects results — a test that creates data can cause a subsequent test to pass or fail depending on execution order.

3. **In-memory DB mock doesn't enforce constraints** (-0.5): The test database mock allows duplicate primary keys and NULL values in NOT NULL columns. Tests pass even when the code would fail against a real database.

4. **No concurrency tests** (-0.5): The system handles concurrent simulation requests and approval workflows but no tests verify behavior under concurrent access (race conditions on approval, duplicate decision creation).

### Target: 10/10 Test Quality

## Decision

### 1. Generate API route test suite

The pipeline must generate an API test file (`__tests__/api/routes.test.ts`) that tests every route:

```typescript
import { app } from '../../server/routes.js';

describe('API Routes', () => {
  // Helper: make request with JWT claims
  function request(method: string, path: string, body?: unknown, claims?: Record<string, unknown>) {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (claims) headers['Authorization'] = `Bearer ${createTestJWT(claims)}`;
    return app.request(new Request(`http://localhost${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined }));
  }

  describe('RBAC enforcement', () => {
    it('returns 401 without JWT', async () => {
      const res = await request('GET', '/api/v1/facilities');
      expect(res.status).toBe(401);
    });

    it('returns 403 for viewer on POST endpoint', async () => {
      const res = await request('POST', '/api/v1/decisions', {}, { sub: 'user1', roles: ['viewer'] });
      expect(res.status).toBe(403);
    });

    it('returns 200 for writer on POST endpoint', async () => {
      const res = await request('POST', '/api/v1/decisions', validDecisionBody, { sub: 'user1', roles: ['writer'] });
      expect(res.status).toBe(201);
    });
  });

  describe('Zod validation', () => {
    it('returns 422 for malformed body', async () => {
      const res = await request('POST', '/api/v1/decisions', { invalid: true }, { sub: 'user1', roles: ['writer'] });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.code).toBe('VALIDATION_ERROR');
    });
  });

  describe('correlation ID', () => {
    it('returns X-Correlation-ID in response', async () => {
      const res = await request('GET', '/health/healthz');
      expect(res.headers.get('X-Correlation-ID')).toBeTruthy();
    });
  });
});
```

### 2. Per-test database isolation

Every `describe` block gets a fresh database:

```typescript
let db: TestDatabase;

beforeEach(async () => {
  db = createFreshTestDatabase();
  await db.migrate(); // Create tables
});

afterEach(async () => {
  await db.destroy();
});
```

For SQLite (used in tests), this means creating a new `:memory:` database per test block.

### 3. Constraint-enforcing test database

The test database mock must enforce:
- PRIMARY KEY uniqueness (reject duplicate inserts)
- NOT NULL constraints (reject null values in required columns)
- UNIQUE constraints (reject duplicate idempotency keys)

```typescript
class ConstraintEnforcingTestDb implements DbClient {
  private data = new Map<string, Map<string, Record<string, unknown>>>();

  async execute(sql: string, params: unknown[]): Promise<void> {
    // Parse INSERT — check PRIMARY KEY uniqueness
    // Parse values — check NOT NULL constraints
    // Throw on violation (same as real PostgreSQL)
  }
}
```

### 4. Basic concurrency test

Test that concurrent approval attempts are handled correctly:

```typescript
it('handles concurrent approval attempts without double-approve', async () => {
  const decisionId = await createTestDecision();
  const [result1, result2] = await Promise.all([
    request('POST', `/api/v1/decisions/${decisionId}/approve`, {}, { sub: 'approver1', roles: ['approver'] }),
    request('POST', `/api/v1/decisions/${decisionId}/approve`, {}, { sub: 'approver2', roles: ['approver'] }),
  ]);
  // Exactly one should succeed, one should fail with invalid transition
  const statuses = [result1.status, result2.status].sort();
  expect(statuses).toEqual([200, 422]);
});
```

## Consequences

### Positive
- RBAC enforcement verified by tests — regressions caught automatically
- Test results are deterministic and order-independent
- Database constraint violations caught in tests, not in production
- Concurrency edge cases verified

### Negative
- Per-test database creation adds ~10ms per test (acceptable for correctness)
- API tests require Hono test request infrastructure (built-in via `app.request()`)

## Implementation Priority

**HIGH — Day 2-3.** Estimated effort: 8-10 hours for comprehensive route tests + isolation fixes.

## Related ADRs
- ADR-068: Domain Route RBAC and Telemetry Parity
- ADR-055: Integration Tests Not Mocks
