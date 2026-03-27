# ADR-056: Metrics Endpoint, Health Check Logging, ERP Idempotency, and Filter Allowlists

## Status: ACCEPTED

## Date: 2026-03-27

## Context

Production audit found several medium-severity issues across observability, ERP reliability, and query safety:

- **OB-5**: No /metrics endpoint in generated code (telemetry collects data but doesn't expose it)
- **OB**: Health readiness checks swallow errors silently — ops see "unhealthy" with no diagnosis
- **ERP**: No idempotency keys on ERP write operations — circuit breaker retry can cause duplicates
- **ERP**: Sync queue drain has no deduplication — replayed entries produce duplicates
- **CQ**: Filters accept arbitrary column names — no allowlist per entity prevents querying internal columns
- **CQ**: `mapper.ts:75,94` has undefined `${wp}` variable producing malformed type casts
- **CQ**: `routes.ts:107-122` has stub DbClient/ErpClient hardcoded, not gated by environment
- **ARCH**: Duplicate DI patterns — `dependencies.ts` AND `src/*/infra/` both implement adapters

## Decision

### 1. Generate /metrics endpoint in every project

Phase 4 `tsRoutes()` must generate a Prometheus-compatible metrics endpoint:

```typescript
app.get('/metrics', (c) => {
  const telemetry = deps._telemetry as ConsoleTelemetry;
  const m = telemetry.metrics;
  const lines = [
    `# HELP http_requests_total Total requests`,
    `# TYPE http_requests_total counter`,
    `http_requests_total ${m.requestCount}`,
    `http_errors_total ${m.errorCount}`,
    `http_spans_total ${m.spanCount}`,
    `http_latency_sum_ms ${m.latencySumMs}`,
  ];
  for (const [op, d] of Object.entries(m.byOperation)) {
    lines.push(`http_op_count{op="${op}"} ${d.count}`);
    lines.push(`http_op_errors{op="${op}"} ${d.errors}`);
  }
  return c.text(lines.join('\n'));
});
```

### 2. Health check error logging

Phase 4 `tsHealth()` must log health check failures:

```typescript
// In readiness check catch blocks:
} catch (err) {
  console.error(JSON.stringify({
    level: 'error',
    check: 'database',
    error: err instanceof Error ? err.message : String(err),
  }));
  checks.database = 'fail';
}
```

### 3. ERP idempotency keys

Phase 4 ERP client generator must add idempotency keys to write operations:

```typescript
// In createTransferOrder, createPurchaseOrder, etc.
const idempotencyKey = `${operation}-${entityId}-${correlationId}`;
headers['Idempotency-Key'] = idempotencyKey;

// In drainSyncQueue, use stored entry ID as idempotency key:
headers['Idempotency-Key'] = `drain-${entry.id}-${entry.retry_count}`;
```

### 4. Sync queue deduplication

Before adding to sync queue, check for existing entry:

```typescript
// In executeWithFallback catch block:
const isDuplicate = this.syncQueue.some(
  e => e.operation === operation && e.id === correlationId
);
if (!isDuplicate) {
  this.syncQueue.push({ ... });
}
```

### 5. Filter column allowlists per entity

Phase 4 `tsDependencies()` must generate per-entity filter allowlists:

```typescript
// Generated per context from DDD entity fields
const SUPPLIER_FILTERABLE_COLUMNS = new Set(['status', 'region', 'created_at', 'updated_at']);

// In query() method:
for (const [key, value] of Object.entries(filters)) {
  if (value !== undefined && FILTERABLE_COLUMNS.has(key)) {
    whereClauses.push(`${key} = :${paramIdx}`);
    params.push(value);
    paramIdx++;
  }
  // Keys not in allowlist are silently ignored — no error, no SQL injection
}
```

The allowlist is derived from the DDD entity definition at generation time.

### 6. Fix mapper.ts ${wp} undefined variable

Phase 4 ERP mapper generator must use resolved ERP class prefix:

```typescript
// Instead of: as unknown as ${wp}TransferOrder
// Generate:   as unknown as OracleERPTransferOrder
// The variable name must be resolved at generation time, not left as template literal
```

### 7. Remove stub clients from routes.ts

Phase 4 routes generator must NOT embed stub DbClient/ErpClient. Instead:

```typescript
// routes.ts should import from DI, not define stubs
// If no real client available, fail fast at startup:
if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL required — set it in environment');
}
```

### 8. Resolve duplicate DI patterns

Phase 4 must generate ONE DI pattern, not two competing ones:
- `src/server/dependencies.ts` is the DI container (port interfaces + adapters + factory)
- `src/*/infra/*-adapter.ts` files are the domain-specific adapters imported by dependencies.ts
- dependencies.ts should IMPORT adapters, not re-implement them

## Consequences

- (+) /metrics enables Prometheus alerting and Grafana dashboards
- (+) Health check failures are diagnosable from logs
- (+) ERP operations are idempotent — safe to retry
- (+) Query filters can't access internal/sensitive columns
- (-) Filter allowlists need updating when entity schema changes
- (-) Idempotency keys add header overhead to every ERP request

## Audit References

- OB-5: No /metrics endpoint
- OB: Health checks swallow errors
- ERP: No idempotency keys / sync queue deduplication
- CQ: Filters accept arbitrary columns
- CQ: mapper.ts ${wp} undefined
- CQ: Stub clients in routes.ts
- ARCH: Duplicate DI patterns
