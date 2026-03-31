# ADR-072: ERP Sync Queue Persistence and Wire Schema Validation

## Status: IMPLEMENTED

## Date: 2026-03-31

## Context

Production readiness audit (2026-03-31) found two reliability issues in the ERP integration layer:

### 1. In-memory sync queue (HIGH)

`erp-client/client.ts` implements a sync queue for eventual consistency during Oracle Fusion Cloud outages. When the circuit breaker is open, write operations are queued in an in-memory array. When the circuit closes, queued operations are replayed.

**Problem**: If the Cloud Run instance is terminated (scale-to-zero, OOM, deployment), all queued operations are lost. In the worst case, a governance-approved writeback is acknowledged to the user but never delivered to Oracle.

The system already has PostgreSQL (Cloud SQL) available for persistence, and the `audit_log` table already records all governance actions. The sync queue should be backed by the same persistence layer.

### 2. No schema validation on mapper output (MEDIUM)

`mapper.ts` transforms domain types into Oracle Fusion Cloud wire formats (`toTransferOrder()`, `toPurchaseOrder()`, `toSupplierScoreUpdate()`, etc.). These functions produce JSON objects but do not validate them against Oracle's expected schema before transmission.

**Problem**: A malformed payload (missing required field, wrong type, invalid enum value) would only fail at the Oracle API level, producing a generic 400/422 error. This makes debugging difficult and wastes API rate limit budget on invalid requests.

## Decision

### 1. Persist sync queue to PostgreSQL

Replace the in-memory sync queue with a database-backed queue:

```typescript
interface SyncQueueEntry {
  id: string;          // crypto.randomUUID()
  operation: string;   // 'supplier_score_update' | 'transfer_order' | etc.
  payload: string;     // JSON-serialized wire format
  idempotencyKey: string;
  status: 'pending' | 'in_flight' | 'completed' | 'failed';
  retryCount: number;
  createdAt: string;   // ISO 8601
  lastAttemptAt: string | null;
  errorMessage: string | null;
  correlationId: string;
}
```

SQL schema:
```sql
CREATE TABLE IF NOT EXISTS sync_queue (
  id TEXT PRIMARY KEY,
  operation TEXT NOT NULL,
  payload TEXT NOT NULL,
  idempotency_key TEXT UNIQUE NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  retry_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_attempt_at TEXT,
  error_message TEXT,
  correlation_id TEXT NOT NULL
);

CREATE INDEX idx_sync_queue_status ON sync_queue(status);
CREATE INDEX idx_sync_queue_created ON sync_queue(created_at);
```

On startup, the ERP client checks for `pending` or `in_flight` entries and replays them (with idempotency key deduplication on the Oracle side).

### 2. Add drain lifecycle hook

```typescript
// In server shutdown handler
process.on('SIGTERM', async () => {
  // Cloud Run sends SIGTERM before termination
  logger.info('SIGTERM received — draining sync queue to database');
  await erpClient.flushQueueToDatabase();
  process.exit(0);
});
```

### 3. Add Zod schemas for Oracle wire formats

```typescript
// src/erp-client/oracle-schemas.ts
import { z } from 'zod';

export const SupplierScoreUpdateSchema = z.object({
  SupplierId: z.string().min(1),
  SubsidiaryId: z.string().min(1),
  ClimateRiskScore: z.number().min(0).max(100),
  ResilienceIndex: z.number().min(0).max(1),
  LastAssessmentDate: z.string().datetime(),
  AssessmentSource: z.literal('CLIMATE_RISK_PLATFORM'),
  IdempotencyKey: z.string().uuid(),
});

export const TransferOrderSchema = z.object({
  OrderType: z.enum(['STANDARD', 'EMERGENCY', 'CLIMATE_MITIGATION']),
  SourceOrganization: z.string().min(1),
  DestinationOrganization: z.string().min(1),
  // ... remaining fields per Oracle Fusion Cloud Transfer Order API
});
```

Validate before queueing:

```typescript
async queueOperation(operation: string, payload: unknown): Promise<void> {
  const schema = this.getSchemaForOperation(operation);
  const validated = schema.parse(payload); // Throws ZodError on invalid
  await this.db.run(
    'INSERT INTO sync_queue (id, operation, payload, idempotency_key, status, correlation_id) VALUES (?, ?, ?, ?, ?, ?)',
    [randomUUID(), operation, JSON.stringify(validated), validated.IdempotencyKey, 'pending', this.correlationId]
  );
}
```

## Consequences

### Positive
- Zero data loss on instance termination — all queued operations survive restarts
- Invalid payloads caught before Oracle API call — faster debugging, no wasted rate limit
- Sync queue is queryable — operations teams can inspect pending/failed writebacks via SQL
- SIGTERM handler ensures graceful shutdown on Cloud Run scale-down

### Negative
- Adds database dependency to the ERP client — acceptable since PostgreSQL is already a dependency
- Schema maintenance — Oracle wire format schemas must be updated when Oracle API versions change
- Slightly higher write latency (database INSERT vs in-memory push) — negligible for governance-gated operations

## Implementation Priority

**MEDIUM — Days 3-4 of pilot preparation.** Estimated effort: 4-5 hours. The in-memory queue is acceptable for the pilot if the team is aware of the data loss risk during instance restarts. Must be completed before production deployment.

## Related ADRs
- ADR-050: ERP Client Persistence and Reliability
- ADR-064: Schema Validation and Filter Parsing
