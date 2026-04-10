# ADR-PRR-011: Implement Database Persistence Adapter (Repository Pattern)

## Status: PROPOSED

## Date: 2026-04-10

## Priority: LOW — Address before full deployment

## Effort: 1-2 days

## Context

Production readiness review (2026-04-10) confirmed that all state is stored in in-memory `Map` instances: opportunities, audit entries, ERP transactions, and metrics counters. This is appropriate for the CLI demo and acceptable for a short-duration pilot where the API runs as a single process.

For any multi-user, multi-instance deployment, persistence is required. The codebase is well-positioned for this migration because:
- Services use constructor injection (swap implementation, not interface)
- Audit entries are append-only (natural fit for immutable storage)
- Opportunities have a clear state machine (fits relational or document storage)
- The container pattern (`src/container.ts`) is the single wiring point

## Decision

### 1. Define repository interfaces

```typescript
// In src/repositories/types.ts
export interface OpportunityRepository {
  save(opportunity: Opportunity): Promise<void>;
  findById(id: string): Promise<Opportunity | null>;
  findByStatus(status: OpportunityStatus): Promise<Opportunity[]>;
  findByDevice(deviceId: string): Promise<Opportunity[]>;
  listAll(): Promise<Opportunity[]>;
}

export interface AuditRepository {
  append(entry: AuditEntry): Promise<void>;
  findByEntity(entityType: string, entityId: string): Promise<AuditEntry[]>;
  getChain(): Promise<AuditEntry[]>;
  getLastEntry(): Promise<AuditEntry | null>;
}

export interface ERPTransactionRepository {
  save(transaction: ERPTransaction): Promise<void>;
  findByIdempotencyKey(key: string): Promise<ERPTransaction | null>;
  findByOpportunity(opportunityId: string): Promise<ERPTransaction[]>;
}
```

### 2. Create in-memory implementations (current behavior, refactored)

```typescript
// In src/repositories/in-memory.ts
export class InMemoryOpportunityRepository implements OpportunityRepository {
  private readonly store = new Map<string, Opportunity>();
  // ... wrap existing Map operations with async interface
}
```

### 3. Create PostgreSQL implementations

```typescript
// In src/repositories/postgres.ts
export class PostgresOpportunityRepository implements OpportunityRepository {
  constructor(private readonly pool: Pool) {}

  async save(opportunity: Opportunity): Promise<void> {
    await this.pool.query(
      `INSERT INTO opportunities (id, device_id, status, ...) 
       VALUES ($1, $2, $3, ...)
       ON CONFLICT (id) DO UPDATE SET status = $3, ...`,
      [opportunity.id, opportunity.deviceId, opportunity.status, ...]
    );
  }
  // ...
}
```

### 4. Wire via container based on environment

```typescript
// In src/container.ts
function createRepositories(config: AppConfig) {
  if (config.databaseUrl) {
    const pool = new Pool({ connectionString: config.databaseUrl });
    return {
      opportunities: new PostgresOpportunityRepository(pool),
      audit: new PostgresAuditRepository(pool),
      erpTransactions: new PostgresERPTransactionRepository(pool),
    };
  }
  return {
    opportunities: new InMemoryOpportunityRepository(),
    audit: new InMemoryAuditRepository(),
    erpTransactions: new InMemoryERPTransactionRepository(),
  };
}
```

### 5. Database schema

```sql
-- Audit entries: append-only, write-once
CREATE TABLE audit_entries (
  id UUID PRIMARY KEY,
  sequence_number BIGSERIAL UNIQUE,
  hash VARCHAR(64) NOT NULL,
  previous_hash VARCHAR(64) NOT NULL,
  user_id VARCHAR(255) NOT NULL,
  action VARCHAR(100) NOT NULL,
  entity_type VARCHAR(100) NOT NULL,
  entity_id VARCHAR(255) NOT NULL,
  from_state VARCHAR(50),
  to_state VARCHAR(50),
  rationale TEXT,
  correlation_id UUID NOT NULL,
  simulation_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Write-once constraint: no updates or deletes
REVOKE UPDATE, DELETE ON audit_entries FROM app_user;

CREATE TABLE opportunities (
  id UUID PRIMARY KEY,
  device_id VARCHAR(255) NOT NULL,
  status VARCHAR(50) NOT NULL,
  action VARCHAR(50) NOT NULL,
  created_by VARCHAR(255) NOT NULL,
  approved_by VARCHAR(255),
  rationale TEXT,
  approval_rationale TEXT,
  simulation_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

## Consequences

### Positive
- State survives process restarts
- Multi-instance deployment possible (with shared database)
- Audit trail is tamper-evident at the database level (write-once)
- In-memory fallback preserved for CLI demo and tests
- Repository pattern enables future migration to other stores (DynamoDB, CosmosDB)

### Negative
- Adds PostgreSQL as an operational dependency
- Connection pooling, migrations, and backup need operational setup
- Async repository interface requires updating service methods to `async/await`

## Related ADRs
- ADR-050: ERP Client Persistence and Reliability
- ADR-PRR-010: AsyncLocalStorage (request context also needs to flow through async repository calls)
