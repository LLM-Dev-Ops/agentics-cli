# ADR-059: Stub Database/ERP Clients Must Fail Fast, Not Return Empty Data

## Status: ACCEPTED

## Date: 2026-03-27

## Context

Audit (CQ-CRITICAL): "Stub database client returns empty arrays silently. The entire system appears functional while doing nothing. Every API endpoint returns empty results with 200 status. This is worse than crashing — it's silent data loss."

ADR-056 added a `console.warn` when `DATABASE_URL` is unset, but the stub still returns `[]` for queries and `void` for executes. The generated code LOOKS healthy — health checks pass, routes respond, audit appears to log — but everything is a no-op.

The stub pattern was: "return empty so the app boots even without a database." This is wrong for production code. A system that boots without its database and silently drops all data is more dangerous than one that crashes on startup.

## Decision

### 1. Stub clients must THROW, not return empty

Phase 4 `tsRoutes()` must generate clients that crash immediately when called without configuration:

```typescript
const dbClient: DbClient = {
  async query(): Promise<unknown[]> {
    throw new Error('DATABASE_URL not configured — cannot execute queries. Set DATABASE_URL to connect to PostgreSQL.');
  },
  async execute(): Promise<void> {
    throw new Error('DATABASE_URL not configured — cannot execute writes. Set DATABASE_URL to connect to PostgreSQL.');
  },
};
```

### 2. Health check must report database as DOWN when using stub

The health check currently calls `db.query('SELECT 1', [])` against the stub which returns `[]` — reporting "database: ok". Instead:

```typescript
// In health.ts readiness check:
if (!process.env.DATABASE_URL) {
  checks.database = 'not_configured';
  // Return 503 — the system is NOT ready to handle requests
}
```

### 3. Startup must log a prominent warning

```typescript
if (!process.env.DATABASE_URL) {
  console.error('╔══════════════════════════════════════════════════════════╗');
  console.error('║  WARNING: DATABASE_URL not set. All operations will     ║');
  console.error('║  throw errors. Set DATABASE_URL for real persistence.   ║');
  console.error('╚══════════════════════════════════════════════════════════╝');
}
```

### 4. Same treatment for ERP client stub

```typescript
const erpClient: ErpClient = {
  async invoke(): Promise<unknown> {
    throw new Error('ERP_BASE_URL not configured — cannot invoke ERP operations.');
  },
};
```

## Consequences

- (+) No more silent data loss — errors are immediate and obvious
- (+) Health check correctly reports 503 when DB not configured
- (+) Integration tests with real SQLite still work (they provide their own DbClient)
- (-) App won't boot into a "demo mode" without DATABASE_URL (this is intentional)

## Audit References

- CQ-CRITICAL: Stub DB client returns empty arrays silently
- CQ-CRITICAL: Stub ERP client returns empty objects silently
- OB-HIGH: Health check misleading — reports ok with no database
