# ADR-082: Governance Enforcement Wiring — Cost Thresholds, Lineage at Creation, Persistent Audit

## Status: IMPLEMENTED

## Date: 2026-04-01

## Context

Production readiness audit (2026-04-01) of an energy emissions pipeline run scored Governance 6/10 with three specific gaps:

1. **Cost threshold enforcement not wired** (-2.0): ADR documents a CFO approval gate for cost increases >5%, but the POST /decisions endpoint doesn't check `costImpact_pct` or enforce the threshold. Any writer can create a decision regardless of cost impact.

2. **Lineage validation only at execution, not creation** (-1.0): `validateLineage()` is called when a decision is executed (ERP writeback) but not when it's created. A decision can be created with an invalid or tampered simulation reference — the problem is only caught at execution time, after approval.

3. **Audit trail uses in-memory store** (-1.0): Audit entries are stored in an in-memory array. Cloud Run instance restart loses all audit history. The hash-chain integrity is sound, but it's computed over data that doesn't survive a restart.

### Target: 10/10 Governance

These three fixes close the 4-point gap.

## Decision

### 1. Cost threshold validation at decision creation

The generated `POST /decisions` handler must validate cost impact before persisting:

```typescript
app.post('/api/v1/decisions', requireRole('writer', 'admin'), async (c) => {
  // ... existing validation ...

  // ADR-082: Enforce cost threshold from governance rules
  const costImpactPct = parsed.data.costImpactPct ?? 0;
  const costThreshold = parseFloat(process.env.GOVERNANCE_COST_THRESHOLD_PCT ?? '5');
  const actorRoles = ((c.get('iamClaims') as Record<string, unknown>) ?? {})['roles'] as string[] ?? [];

  if (Math.abs(costImpactPct) > costThreshold && !actorRoles.includes('cfo') && !actorRoles.includes('admin')) {
    return c.json({
      error: {
        code: 'COST_THRESHOLD_EXCEEDED',
        message: `Cost impact ${costImpactPct}% exceeds ${costThreshold}% threshold — requires CFO approval`,
      },
      correlationId,
    }, 422);
  }

  // ... proceed with creation ...
});
```

The codegen template and LLM prompt must include this check. The threshold is parameterized via `GOVERNANCE_COST_THRESHOLD_PCT` (ADR-071 pattern).

### 2. Lineage validation at decision creation (not just execution)

Move the `validateLineage()` call from the execute endpoint to BOTH creation and execution:

```typescript
// In POST /decisions (creation):
const lineageResult = await validateLineage(simulationRunId, deps);
if (!lineageResult.valid) {
  return c.json({
    error: { code: 'LINEAGE_INVALID', message: lineageResult.reason },
    correlationId,
  }, 422);
}
```

This ensures a decision cannot be created if the referenced simulation doesn't exist or its hash has been tampered with. The execution endpoint retains its lineage check as defense-in-depth.

### 3. Audit trail must persist to database

The generated `AuditAdapter` must INSERT into the `audit_log` table, not push to an in-memory array. The current template code already does this — but the codegen prompt must enforce it, and the template must verify the `audit_log` table is created at startup:

```typescript
class AuditAdapter implements IAuditPort {
  constructor(private readonly db: DbClient) {}

  async log(...): Promise<AuditEntry> {
    // ... existing DB INSERT (already present in template) ...
    // ADR-082: Also store previous_entry_hash for hash chain integrity
    await this.db.execute(
      'INSERT INTO audit_log (id, entity_type, entity_id, action, actor, payload, previous_hash, created_at) ...',
      [id, entityType, entityId, action, actor, JSON.stringify(payload), this.lastHash, now],
    );
    this.lastHash = computeHash(id, action, actor, this.lastHash);
    // ... existing Governance-Dashboard forwarding (ADR-080) ...
  }
}
```

Add `previous_hash` column to the audit_log schema in the schema generator.

### 4. Add audit enrichment fields

Every audit entry must include `actor_role`, `source_ip`, and `request_id` for compliance forensics:

```typescript
async log(entityType, entityId, action, actor, payload, context?: { roles?: string[]; sourceIp?: string; requestId?: string }): Promise<AuditEntry> {
  // ... INSERT with additional columns ...
}
```

Route handlers pass `{ roles: actorRoles, sourceIp: c.req.header('x-forwarded-for'), requestId: correlationId }`.

## Consequences

### Positive
- Cost threshold enforcement prevents unauthorized high-impact decisions
- Invalid simulation references caught at creation, not deferred to execution
- Audit trail survives instance restarts — compliance-ready
- Audit entries include forensic fields for SOX/GDPR compliance

### Negative
- Cost threshold adds a new env var to configure
- Lineage validation at creation adds ~1 query per decision creation (negligible)

## Implementation Priority

**CRITICAL — Day 1.** Estimated effort: 6-8 hours total. Governance is the lowest-scoring category.

## Related ADRs
- ADR-049: RBAC Enforcement, Governance Gating, and Immutable Audit Trail
- ADR-070: Secure ID Generation and ACL Hardening
- ADR-071: Parameterize Domain Constants
