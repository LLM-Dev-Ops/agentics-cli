# ADR-PIPELINE-059: API Integration Test Coverage — Decision Workflow and RBAC End-to-End

**Status:** Accepted
**Date:** 2026-04-10
**Priority:** MEDIUM — Highest-risk untested surface for pilot deployment
**Originating Review:** Production Readiness Review (2026-04-10), Code Quality 7.5/10

## Context

The prototype has 23 unit tests covering scoring, scenario generation, decision service, and audit chain — all passing. However, the **API layer** (Express routes, middleware chain, RBAC enforcement, error handling) has **zero integration tests**.

This is the highest-risk untested surface because:
- RBAC enforcement via `requireRole()` middleware is only tested implicitly through the demo script
- The Express error handler's 4-arity signature `(err, req, res, _next)` has a known Express 4 edge case where incorrect registration order silently bypasses it
- The `/api/decisions` workflow (create → submit → approve → sync) involves multiple middleware layers and service interactions that unit tests don't exercise together
- Request validation via `safeParse` in route handlers is untested at the HTTP boundary

For a 3-7 day pilot where external users will hit the API, this gap must be closed.

## Decision

### 1. Integration Tests with Supertest

```
RULE: The API MUST have integration tests using supertest that
exercise the full middleware chain → route handler → service → response:

Required test cases:

GET /api/buildings
  - Returns 200 with building array
  - Response matches Building[] schema

POST /api/decisions
  - With valid payload: returns 201 with decision ID
  - With invalid payload: returns 400 with validation errors
  - Without X-User-Role header: returns 403

POST /api/decisions/:id/submit
  - Returns 200 on valid submission
  - Returns 404 for non-existent decision
  - Returns 403 if role insufficient

POST /api/decisions/:id/approve
  - Returns 200 with valid approver role
  - Returns 403 if approver is the creator (separation of duties)
  - Returns 403 if role level insufficient for threshold

GET /api/audit/verify
  - Returns { valid: true } for intact chain
  - Response includes chain length

GET /health
  - Returns 200 with status

GET /metrics
  - Returns 200 with request counts
```

### 2. RBAC Enforcement Tests (Critical)

```
RULE: RBAC tests MUST verify the role hierarchy at the HTTP level:

- analyst role: can read, cannot create decisions
- facility_manager role: can create and submit
- vp_operations role: can approve up to threshold
- cfo role: can approve any amount
- admin role: can do everything

Each role MUST be tested with at least one allowed and one
denied operation to verify the middleware chain works end-to-end.
```

### 3. Test Isolation

```
RULE: Integration tests MUST create a fresh Express app per test
suite (not per test) using a factory function:

  function createTestApp(): Express {
    // Creates new container with fresh service instances
    // Registers all routes and middleware
    // Returns the app (not started, no listen())
  }

This prevents state leakage between test suites while keeping
individual tests fast (they share the app within a suite).
```

## Implementation

### New file: `tests/api.test.ts`

```typescript
import request from 'supertest';
import { describe, it, expect, beforeAll } from 'vitest';
// Import or create app factory

describe('API Integration', () => {
  describe('GET /api/buildings', () => { ... });
  describe('POST /api/decisions', () => { ... });
  describe('RBAC enforcement', () => { ... });
  describe('GET /api/audit/verify', () => { ... });
  describe('Error handling', () => {
    it('returns 400 JSON for invalid request body', ...);
    it('returns 404 JSON for unknown routes', ...);
    it('returns 500 JSON with correlation ID for unhandled errors', ...);
  });
});
```

### Dependencies

Add `supertest` as a dev dependency:
```json
"devDependencies": {
  "supertest": "^7.0.0",
  "@types/supertest": "^6.0.0"
}
```

## Validation

- [ ] `npm test` runs API integration tests alongside existing unit tests
- [ ] Every API route has at least one happy-path and one error-path test
- [ ] RBAC is tested at HTTP level for each role
- [ ] Correlation ID appears in error response headers
- [ ] Test suite creates fresh app instances (no cross-suite state leakage)

## Consequences

- Covers the highest-risk untested surface before pilot
- Validates the middleware chain works end-to-end (not just individual services)
- Catches Express error handler registration bugs before they hit production
- Raises test coverage from 23 to ~40 tests without increasing test maintenance burden
