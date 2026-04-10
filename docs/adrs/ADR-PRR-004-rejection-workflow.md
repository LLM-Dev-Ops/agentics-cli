# ADR-PRR-004: Add Rejection Workflow to Opportunity Management

## Status: IMPLEMENTED

## Date: 2026-04-10

## Priority: HIGH — Address before pilot

## Effort: 1 hour

## Context

Production readiness review (2026-04-10) found that the opportunity lifecycle supports creation and approval but has no explicit rejection path. The current `OpportunityService` allows:
- `createOpportunity()` → status: `pending_review`
- `approveOpportunity()` → status: `approved`

Missing:
- `rejectOpportunity()` → status: `rejected` (with mandatory rationale)

Enterprise governance requires both approval AND rejection to be auditable decisions. Without a rejection workflow:
- Rejected opportunities remain in `pending_review` forever
- No audit record of why a recommendation was not acted on
- Regulators and internal audit cannot verify that the approval process includes proper challenge

The existing approval implementation (separation of duties, minimum rationale, audit trail entry) provides the pattern to follow.

## Decision

### 1. Add `rejected` to the Opportunity status enum

```typescript
// In src/types.ts
export const OpportunityStatusSchema = z.enum([
  'pending_review',
  'approved',
  'rejected',    // ← NEW
  'submitted_to_erp',
  'erp_confirmed',
  'erp_failed'
]);
```

### 2. Implement `rejectOpportunity()` mirroring approval pattern

```typescript
// In src/services/opportunity.ts
async rejectOpportunity(
  opportunityId: string,
  rejectedBy: string,
  rejectorRole: string,
  rationale: string,
  correlationId: string
): Promise<Opportunity> {
  // 1. Validate role — only 'approver' or 'admin' can reject
  if (!['approver', 'admin'].includes(rejectorRole)) {
    throw new AuthorizationError('Only approver or admin can reject opportunities');
  }

  // 2. Retrieve opportunity
  const opportunity = this.opportunities.get(opportunityId);
  if (!opportunity) throw new NotFoundError(`Opportunity ${opportunityId} not found`);

  // 3. Validate current status — can only reject from pending_review
  if (opportunity.status !== 'pending_review') {
    throw new ValidationError(`Cannot reject opportunity in status: ${opportunity.status}`);
  }

  // 4. Separation of duties — creator cannot reject their own
  if (opportunity.createdBy === rejectedBy) {
    throw new AuthorizationError('Creator cannot reject their own opportunity');
  }

  // 5. Require meaningful rationale
  if (rationale.length < 10) {
    throw new ValidationError('Rejection rationale must be at least 10 characters');
  }

  // 6. Create immutable rejected record
  const rejected: Opportunity = {
    ...opportunity,
    status: 'rejected',
    approvedBy: rejectedBy,  // reuse field as "decided by"
    approvedAt: new Date().toISOString(),
    approvalRationale: rationale,
  };

  // 7. Store and audit
  this.opportunities.set(opportunityId, rejected);
  this.audit.record({
    userId: rejectedBy,
    userRole: rejectorRole,
    action: 'REJECT_OPPORTUNITY',
    entityType: 'opportunity',
    entityId: opportunityId,
    fromState: 'pending_review',
    toState: 'rejected',
    rationale,
    correlationId,
    simulationId: this.simulationId,
  });

  return rejected;
}
```

### 3. Add rejection API endpoint

```typescript
// In src/routes.ts
router.post('/api/opportunities/:id/reject', requireRole('approver', 'admin'), (req, res) => {
  const { rationale } = req.body;
  const result = container.opportunities.rejectOpportunity(
    req.params.id,
    req.headers['x-user-id'] as string,
    req.headers['x-user-role'] as string,
    rationale,
    (req as any).correlationId
  );
  res.json(result);
});
```

### 4. Add tests

- Rejection with valid rationale → status `rejected` + audit entry
- Creator cannot reject own opportunity → `AuthorizationError`
- Rejection requires `pending_review` status → `ValidationError`
- Rationale minimum length enforced → `ValidationError`
- Approved opportunity cannot be rejected → `ValidationError`

## Consequences

### Positive
- Complete governance loop — every opportunity has a documented decision
- Audit trail captures rejection rationale for compliance
- Separation of duties applies to rejection (same as approval)
- Dashboard can show rejection rate as a quality signal

### Negative
- Additional API endpoint to test and document
- `approvedBy`/`approvedAt` field naming is misleading when used for rejection — consider renaming to `decidedBy`/`decidedAt` in a future refactor

## Related ADRs
- ADR-049: RBAC, Governance, and Audit Trail
- ADR-PRR-005: Type Express Request Objects
- ADR-054: Approval Workflow Endpoints
