# ADR-050: ERP Client Reliability — Persistent Sync Queue, Token Caching, Real Health Checks

## Status: ACCEPTED

## Date: 2026-03-27

## Context

Production audit found critical reliability issues in the ERP client and infrastructure layer:

- **CQ-4**: Sync queue is in-memory (`private readonly syncQueue: SyncQueueEntry[] = []`). Process restart permanently loses all queued ERP write operations.
- **CQ-5**: `getIdentityToken()` hits GCP metadata server on every HTTP call. Under load, this saturates the metadata endpoint and causes cascading failures.
- **CQ-6**: Retry backoff is deterministic (1s/2s/4s) — causes thundering herd when ERP recovers.
- **AR-3**: Health checks return `{status: 'ok'}` without checking database, ERP, or JWKS availability. Kubernetes routes traffic to broken instances.
- **AR-6**: 30s hardcoded timeout for all ERP operations — Oracle bulk operations exceed this.
- **ER-1**: Oracle API endpoints in generated mapper are fictional paths.
- **ER-2**: No idempotency keys on ERP writes.
- **ER-4**: Hardcoded example URLs for ERP base URL and service account.

## Decision

### 1. Persistent sync queue with transactional guarantees

Replace in-memory array with database-backed queue:

```typescript
// Phase 5 must generate this table
CREATE TABLE erp_sync_queue (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  operation TEXT NOT NULL,           -- 'create_supplier' | 'update_contract' | etc.
  resource_path TEXT NOT NULL,       -- Oracle API path
  payload JSONB NOT NULL,
  idempotency_key TEXT UNIQUE NOT NULL,  -- prevents duplicate operations
  status TEXT NOT NULL DEFAULT 'pending', -- pending | processing | completed | failed
  attempts INT NOT NULL DEFAULT 0,
  max_attempts INT NOT NULL DEFAULT 5,
  correlation_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at TIMESTAMPTZ,
  error_detail TEXT
);

CREATE INDEX idx_sync_queue_status ON erp_sync_queue(status) WHERE status = 'pending';
```

**Drain implementation**:
```typescript
async drainSyncQueue(): Promise<void> {
  this.assertWriteAllowed();  // governance check

  const pending = await this.db.query(
    `SELECT * FROM erp_sync_queue WHERE status = 'pending' AND attempts < max_attempts
     ORDER BY created_at LIMIT 10 FOR UPDATE SKIP LOCKED`,
    []
  );

  for (const entry of pending.rows) {
    await this.db.execute(
      `UPDATE erp_sync_queue SET status = 'processing', attempts = attempts + 1 WHERE id = $1`,
      [entry.id]
    );
    try {
      await this.post(entry.resource_path, entry.payload, {
        'Idempotency-Key': entry.idempotency_key,
      });
      await this.db.execute(
        `UPDATE erp_sync_queue SET status = 'completed', processed_at = NOW() WHERE id = $1`,
        [entry.id]
      );
    } catch (err) {
      await this.db.execute(
        `UPDATE erp_sync_queue SET status = 'failed', error_detail = $2 WHERE id = $1`,
        [entry.id, String(err)]
      );
    }
  }
}
```

### 2. Token caching with TTL

```typescript
// Add to ERP client
private cachedToken: { token: string; expiresAt: number } | null = null;

async getIdentityToken(): Promise<string> {
  if (this.cachedToken && Date.now() < this.cachedToken.expiresAt) {
    return this.cachedToken.token;
  }

  const token = await this.fetchTokenFromMetadata();
  // GCP tokens have 1-hour TTL; cache for 55 minutes
  this.cachedToken = { token, expiresAt: Date.now() + 55 * 60 * 1000 };
  return token;
}
```

**Codegen rule**: Phase 5 must generate token caching for any cloud IAM integration.

### 3. Jittered exponential backoff

```typescript
// Replace deterministic backoff
function backoffWithJitter(attempt: number, baseMs = 1000, maxMs = 30000): number {
  const exponential = Math.min(baseMs * Math.pow(2, attempt), maxMs);
  const jitter = exponential * (0.5 + Math.random() * 0.5);
  return Math.floor(jitter);
}
```

### 4. Real health checks

```typescript
app.get('/readyz', async (c) => {
  const checks: Record<string, 'ok' | 'fail'> = {};

  // Database connectivity
  try {
    await deps.db.query('SELECT 1', []);
    checks.database = 'ok';
  } catch { checks.database = 'fail'; }

  // ERP client (circuit breaker status)
  checks.erp = deps.erp.circuitBreaker.isOpen ? 'fail' : 'ok';

  // JWKS key availability
  try {
    await deps.jwks.getSigningKey();
    checks.jwks = 'ok';
  } catch { checks.jwks = 'fail'; }

  const allOk = Object.values(checks).every(v => v === 'ok');
  return c.json({ status: allOk ? 'ready' : 'degraded', checks }, allOk ? 200 : 503);
});
```

### 5. Configurable ERP timeouts

```typescript
// Replace hardcoded 30s with operation-type-based timeouts
const ERP_TIMEOUTS: Record<string, number> = {
  read: 10_000,       // 10s for single reads
  list: 30_000,       // 30s for list/search
  write: 45_000,      // 45s for single writes
  bulk: 120_000,      // 2min for bulk operations
  report: 300_000,    // 5min for report generation
};
```

### 6. Correct Oracle Fusion Cloud API paths

Phase 5 codegen must use real Oracle REST API paths:

```typescript
// REAL Oracle Fusion Cloud REST endpoints
const ORACLE_FUSION_ENDPOINTS = {
  suppliers: '/fscmRestApi/resources/latest/suppliers',
  purchaseOrders: '/fscmRestApi/resources/latest/purchaseOrders',
  transferOrders: '/fscmRestApi/resources/latest/inventoryTransferOrders',
  projects: '/fscmRestApi/resources/latest/projects',
  // NOT fictional: /supplierNetworksDependencies (doesn't exist)
};
```

**Codegen rule**: The ERP-specific API endpoint mapping must come from the `tech-stack-detector.ts` ERP context, which already contains correct paths per vendor.

## Consequences

- (+) ERP write operations survive process restarts
- (+) Duplicate writes prevented via idempotency keys
- (+) GCP metadata server no longer saturated under load
- (+) Kubernetes correctly routes traffic away from unhealthy instances
- (+) No thundering herd on ERP recovery
- (-) Sync queue adds database dependency to ERP client
- (-) Requires PostgreSQL setup even for development (use docker-compose)

## Audit References

- CQ-4: In-memory sync queue = data loss
- CQ-5: No token caching
- CQ-6: Retry has no jitter
- AR-3: Static health checks
- AR-6: Hardcoded 30s timeout
- ER-1: Fictional Oracle API paths
- ER-2: No idempotency keys
- ER-4: Hardcoded example URLs
