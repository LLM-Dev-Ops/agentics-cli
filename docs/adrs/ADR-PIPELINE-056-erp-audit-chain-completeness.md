# ADR-PIPELINE-056: ERP Audit Chain Completeness — Sync Operations Must Be Audited

**Status:** Accepted
**Date:** 2026-04-10
**Priority:** HIGH — Governance gap in the strongest category (8.5/10)
**Originating Review:** Production Readiness Review (2026-04-10), Governance 8.5/10

## Context

The audit trail is the prototype's strongest governance feature — SHA-256 hash-chained, immutable, with genesis anchoring and per-entry verification. Every decision state transition (created → pending_review → approved/rejected) is recorded with who, what, when, why, and correlationId.

However, there is one gap: **ERP sync operations are not added to the audit chain.**

When `ERPAdapter.syncDecision()` executes:
- Success: logged via `this.logger.info('erp.sync.success', ...)` but not appended to the audit chain
- Failure: logged and retried, but retry attempts are also not in the audit chain
- Retry exhaustion: logged as `erp.sync.failed` but not audited

This means an auditor can trace a decision from creation through approval but loses visibility at the point where it crosses the system boundary into Archibus. For regulated environments (EU CSRD, SEC climate disclosure), the ERP write is often the most scrutinized step.

## Decision

### 1. ERP Sync Events Must Enter the Audit Chain

```
RULE: The ERPAdapter (or the orchestrating service that calls it)
MUST append an audit entry for every ERP sync attempt:

On sync start:
  auditService.append({
    action: 'erp_sync_initiated',
    actor: 'system',
    entityType: 'erp_transaction',
    entityId: transactionId,
    details: {
      decisionId,
      targetSystem: 'archibus',
      idempotencyKey,
      attempt: 1
    }
  });

On sync success:
  auditService.append({
    action: 'erp_sync_completed',
    actor: 'system',
    entityType: 'erp_transaction',
    entityId: transactionId,
    details: {
      decisionId,
      responseStatus: 200,
      durationMs,
      dryRun: true|false
    }
  });

On sync failure (after all retries exhausted):
  auditService.append({
    action: 'erp_sync_failed',
    actor: 'system',
    entityType: 'erp_transaction',
    entityId: transactionId,
    details: {
      decisionId,
      attempts: 3,
      lastError: error.message,
      circuitBreakerState: 'open'|'closed'
    }
  });
```

### 2. Audit Chain Must Cover Full Decision Lifecycle

```
RULE: The complete auditable lifecycle of a decision is:

  decision_created      → who proposed it
  decision_submitted    → who submitted for review
  approval_granted (×N) → who approved at each gate
  erp_sync_initiated    → system started ERP write  ← NEW
  erp_sync_completed    → ERP confirmed receipt     ← NEW
  erp_sync_failed       → ERP write failed          ← NEW

An auditor querying the chain for a decision ID MUST see every
state transition including the ERP boundary crossing.
```

### 3. Implementation Approach

```
RULE: The ERPAdapter should NOT depend on AuditService directly
(this would create a circular dependency risk).

Instead, the orchestrating layer (e.g., the API handler or a
DecisionLifecycleService) should:
1. Call erpAdapter.syncDecision(decision)
2. Based on the result, call auditService.append(...)

This keeps the adapter focused on ERP communication and the
audit service focused on chain management.
```

## Implementation

### In `src/api.ts` (or new `src/services/lifecycle.ts`)

Wrap the ERP sync call with audit entries:

```typescript
// Before sync
await container.audit.append({ action: 'erp_sync_initiated', ... });

try {
  const result = await container.erp.syncDecision(decision);
  await container.audit.append({ action: 'erp_sync_completed', ... });
} catch (error) {
  await container.audit.append({ action: 'erp_sync_failed', ... });
  throw error;
}
```

### In `tests/audit.test.ts`

Add test cases verifying:
- Successful sync produces `erp_sync_initiated` + `erp_sync_completed` entries
- Failed sync produces `erp_sync_initiated` + `erp_sync_failed` entries
- Chain integrity holds after ERP audit entries are appended

## Validation

- [ ] `GET /api/audit?entityId=<decisionId>` returns ERP sync entries
- [ ] `GET /api/audit/verify` passes with ERP sync entries in the chain
- [ ] Failed ERP sync is visible in audit trail (not just in logs)
- [ ] Audit chain hash integrity holds across all entry types

## Consequences

- Closes the last governance gap — full decision lifecycle is now auditable
- Meets regulated environment requirements where ERP writes are the scrutinized boundary
- Maintains clean service boundaries (adapter doesn't depend on audit service)
