# ADR-049: RBAC Enforcement, Governance Gating, and Immutable Audit Trail

## Status: ACCEPTED

## Date: 2026-03-27

## Context

Production audit (GV-1 through GV-6) found that **governance is documented but not enforced**:

- **GV-1**: JWT is validated but `iamClaims` are never checked. Any authenticated user has full access to all 24 endpoints.
- **GV-2**: `deps.audit.log()` is wired in the DI container but never called from route handlers.
- **GV-3**: `drainSyncQueue()` bypasses `assertWriteAllowed()`, executing queued ERP writes even when `read_only=true`.
- **GV-4**: Failed operations are not audit-logged — only successes are recorded.
- **GV-5**: Audit records stored via regular SQL INSERT — no immutability guarantee.
- **GV-6**: No approval workflow exists — ERP writeback has no governance gate.

For a system that "must maintain strict auditability, full decision lineage, and human-in-the-loop governance," this is a compliance disqualifier.

## Decision

### 1. RBAC middleware — Phase 5 must generate role checks

Every route must check `iamClaims` against required permissions:

```typescript
// Generated middleware pattern
function requireRole(...roles: string[]) {
  return async (c: Context, next: Next) => {
    const claims = c.get('iamClaims') as JWTClaims | undefined;
    if (!claims) return c.json({ error: 'Unauthorized' }, 401);

    const userRoles = claims.roles ?? claims['custom:roles'] ?? [];
    const hasRole = roles.some(r => userRoles.includes(r));
    if (!hasRole) {
      await deps.audit.log({
        action: 'ACCESS_DENIED',
        actor: claims.sub,
        resource: c.req.path,
        requiredRoles: roles,
        correlationId: c.get('correlationId'),
      });
      return c.json({ error: 'Forbidden', required: roles }, 403);
    }
    await next();
  };
}

// Route registration with RBAC
app.get('/api/v1/scenarios', requireRole('analyst', 'admin'), listScenarios);
app.post('/api/v1/scenarios/:id/approve', requireRole('approver', 'admin'), approveScenario);
app.post('/api/v1/erp/writeback', requireRole('erp_writer', 'admin'), erpWriteback);
```

**Codegen rule for Phase 5**:
```
Every route handler must be wrapped with requireRole() middleware.
Read endpoints require 'viewer' role minimum.
Write endpoints require domain-specific roles.
Approval endpoints require 'approver' role.
ERP writeback requires 'erp_writer' role.
Access denials must be audit-logged.
```

### 2. Audit logging on every operation

Phase 5 must generate audit calls in every route handler:

```typescript
// Pattern: audit before and after every state-changing operation
app.post('/api/v1/transitions', requireRole('analyst'), async (c) => {
  const correlationId = c.get('correlationId');
  const actor = (c.get('iamClaims') as JWTClaims).sub;

  await deps.audit.log({ action: 'TRANSITION_CREATE_STARTED', actor, correlationId });

  try {
    const result = await deps.transitions.execute(input);
    await deps.audit.log({ action: 'TRANSITION_CREATED', actor, correlationId, resourceId: result.id });
    return c.json(result, 201);
  } catch (err) {
    await deps.audit.log({ action: 'TRANSITION_CREATE_FAILED', actor, correlationId, error: String(err) });
    throw err;
  }
});
```

### 3. Governance-gated ERP writeback

No ERP write without an approved simulation-backed decision:

```typescript
// Approval state machine
type ApprovalStatus = 'draft' | 'submitted' | 'approved' | 'rejected' | 'executed';

// Valid transitions only
const VALID_TRANSITIONS: Record<ApprovalStatus, ApprovalStatus[]> = {
  draft: ['submitted'],
  submitted: ['approved', 'rejected'],
  approved: ['executed'],
  rejected: ['draft'],
  executed: [],
};

// ERP writeback gate
app.post('/api/v1/erp/writeback', requireRole('erp_writer'), async (c) => {
  const { decisionId } = await c.req.json();
  const decision = await deps.decisions.getById(decisionId);

  if (decision.status !== 'approved') {
    return c.json({ error: 'Decision must be APPROVED before ERP writeback' }, 422);
  }
  if (!decision.simulationId) {
    return c.json({ error: 'Decision must trace to a simulation run' }, 422);
  }
  // ... proceed with writeback
});
```

### 4. Fix drainSyncQueue governance bypass

```typescript
// drainSyncQueue MUST check governance before executing
async drainSyncQueue(): Promise<void> {
  for (const entry of this.syncQueue) {
    this.assertWriteAllowed();  // <-- ADD THIS CHECK
    await this.post(entry.path, entry.body);
  }
}
```

### 5. Immutable audit log

Audit records must be append-only with content hash:

```typescript
// Audit table DDL (include in Phase 5 migration output)
CREATE TABLE audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  action TEXT NOT NULL,
  actor TEXT NOT NULL,
  resource_id TEXT,
  correlation_id TEXT NOT NULL,
  payload JSONB,
  content_hash TEXT NOT NULL,  -- SHA-256 of action+actor+payload+timestamp
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Prevent updates/deletes on audit records
REVOKE UPDATE, DELETE ON audit_log FROM app_role;
```

## Consequences

- (+) Every operation is access-controlled with domain-specific roles
- (+) Full audit trail — successes, failures, and access denials all logged
- (+) ERP writeback gated behind approved, simulation-backed decisions
- (+) Audit records are immutable — tamper-evident via content hash
- (-) Every route handler becomes longer (audit + RBAC boilerplate)
- (-) Requires role definitions in IAM provider (Workday/Oracle/GCP IAM)

## Audit References

- GV-1: No RBAC enforcement
- GV-2: Audit port never invoked from routes
- GV-3: drainSyncQueue bypasses governance
- GV-4: Failed operations not audit-logged
- GV-5: No immutable audit store
- GV-6: No decision approval workflow
