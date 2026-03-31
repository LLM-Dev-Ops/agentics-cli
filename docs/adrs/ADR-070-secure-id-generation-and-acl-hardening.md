# ADR-070: Secure ID Generation and Oracle ACL Hardening

## Status: IMPLEMENTED

## Date: 2026-03-31

## Context

Production readiness audit (2026-03-31) found three issues in `src/domain/oracle-acl.ts`:

1. **Predictable ID generation**: Writeback request IDs are generated using `Math.random().toString(36).substring(2, 15)`. This produces ~62 bits of entropy from a non-cryptographic PRNG. In a system where writeback request IDs are used in governance approval workflows, predictable IDs could allow an attacker to pre-compute valid request IDs and submit approvals for requests that haven't been created yet. The rest of the codebase already uses `crypto.randomUUID()` (in middleware for correlation IDs), making this an inconsistency.

2. **Missing inputHash cross-validation**: `approveWriteback()` accepts an `inputHash` parameter from the simulation run but does not validate it against the actual simulation's computed hash. An attacker who can call the approval endpoint could supply an arbitrary `inputHash`, breaking the simulation lineage guarantee.

3. **Inconsistent rejection reason validation**: `routes.ts` enforces a 10-character minimum for rejection reasons (`z.string().min(10)`), but `oracle-acl.ts` accepts any non-empty string. A reviewer could reject a writeback with reason "no" which is useless for audit trail purposes.

4. **Read operations not audited**: `readSupplierScores()` and `readContractRiskData()` do not generate audit entries. For financial services and insurance compliance (SOX, GDPR Article 30), data access events must be logged.

## Decision

### 1. Replace Math.random() with crypto.randomUUID()

```typescript
// BEFORE
const requestId = Math.random().toString(36).substring(2, 15);

// AFTER
import { randomUUID } from 'node:crypto';
const requestId = randomUUID();
```

This produces 122 bits of cryptographic randomness in the standard UUID v4 format, consistent with the rest of the codebase.

### 2. Validate inputHash against simulation store

```typescript
async approveWriteback(
  requestId: string,
  approverId: string,
  simulationStore: SimulationStore  // New dependency
): Promise<GovernanceResult> {
  const request = this.pendingRequests.get(requestId);
  if (!request) return { success: false, reason: 'Request not found' };

  // Cross-validate inputHash against the actual simulation run
  const simulation = await simulationStore.getByHash(request.inputHash);
  if (!simulation) {
    this.auditLog.push({
      action: 'APPROVAL_REJECTED',
      reason: 'Simulation lineage validation failed — inputHash not found in simulation store',
      requestId,
      approverId,
      timestamp: new Date().toISOString()
    });
    return { success: false, reason: 'Simulation lineage validation failed' };
  }

  // ... existing approval logic
}
```

### 3. Enforce minimum rejection reason length in ACL

```typescript
rejectWriteback(requestId: string, rejecterId: string, reason: string): GovernanceResult {
  if (!reason || reason.trim().length < 10) {
    return {
      success: false,
      reason: 'Rejection reason must be at least 10 characters for audit trail compliance'
    };
  }
  // ... existing rejection logic
}
```

### 4. Add audit logging for read operations

```typescript
async readSupplierScores(actorId: string, filters?: SupplierScoreFilters): Promise<SupplierScore[]> {
  this.auditLog.push({
    action: 'READ_SUPPLIER_SCORES',
    actor: actorId,
    filters: filters ? JSON.stringify(filters) : 'all',
    timestamp: new Date().toISOString()
  });
  // ... existing read logic
}

async readContractRiskData(actorId: string, contractId: string): Promise<ContractRiskData> {
  this.auditLog.push({
    action: 'READ_CONTRACT_RISK_DATA',
    actor: actorId,
    contractId,
    timestamp: new Date().toISOString()
  });
  // ... existing read logic
}
```

## Consequences

### Positive
- Eliminates ID predictability attack vector
- Ensures simulation lineage cannot be spoofed at approval time
- Audit trail meets SOX and GDPR Article 30 data access logging requirements
- Consistent validation rules between route layer and domain layer

### Negative
- `approveWriteback()` now requires a `SimulationStore` dependency — adjust DI container
- Read audit logging increases audit log volume — consider sampling or log level for high-frequency reads in production

## Implementation Priority

**HIGH — Day 1-2 of pilot preparation.** Estimated effort: 2-3 hours.

## Related ADRs
- ADR-049: RBAC Enforcement, Governance Gating, and Immutable Audit Trail
- ADR-051: Simulation Lineage and Observability
