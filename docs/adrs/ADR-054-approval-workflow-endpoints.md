# ADR-054: Approval Workflow Endpoints — Human-in-the-Loop Governance

## Status: ACCEPTED

## Date: 2026-03-27

## Context

Production audit (GV-1, SI-5) found: "No approval workflow endpoints. ADR-P2-009 requires human-in-the-loop governance for supplier transition decisions. No POST/PUT endpoints exist for approvals."

The user's requirement is explicit: "The system should not automatically change supplier relationships. It should produce structured, decision-grade outputs that can be reviewed and approved by procurement and executive teams."

Currently generated routes are read-only (GET for queries) plus generic POST for commands. There are no dedicated endpoints for:
- Submitting a decision for review
- Approving or rejecting a decision
- Validating simulation lineage before approval
- Triggering ERP writeback after approval

The `validateLineage()` function exists in `dependencies.ts` but has no API endpoint.

## Decision

### 1. Phase 4 route generator must produce approval workflow endpoints

`tsRoutes()` must generate these endpoints for every project:

```typescript
// POST /api/v1/decisions — submit a decision based on simulation results
app.post('/api/v1/decisions', requireRole('analyst', 'admin'), async (c) => {
  // Requires: simulationRunId, strategyId, recommendedAction
  // Validates: simulation exists, strategy traces to simulation
  // Creates: decision record with status='submitted'
});

// POST /api/v1/decisions/:id/approve — approve a submitted decision
app.post('/api/v1/decisions/:id/approve', requireRole('approver', 'admin'), async (c) => {
  // Validates: decision exists, status='submitted', lineage is valid
  // Updates: status='approved', approvedBy=actor, approvedAt=now
  // Audit logs: approval with full lineage trace
});

// POST /api/v1/decisions/:id/reject — reject a submitted decision
app.post('/api/v1/decisions/:id/reject', requireRole('approver', 'admin'), async (c) => {
  // Validates: decision exists, status='submitted'
  // Updates: status='rejected', rejectedBy=actor, reason=body.reason
  // Audit logs: rejection with reason
});

// POST /api/v1/decisions/:id/execute — trigger ERP writeback for approved decision
app.post('/api/v1/decisions/:id/execute', requireRole('erp_writer', 'admin'), async (c) => {
  // Validates: decision exists, status='approved', lineage valid (hash check)
  // Calls: validateLineage(decisionId, db) — returns { valid, reason }
  // If invalid: return 422 with reason
  // If valid: trigger ERP writeback, update status='executed'
  // Audit logs: execution with ERP transaction reference
});

// GET /api/v1/decisions/:id/lineage — trace full lineage chain
app.get('/api/v1/decisions/:id/lineage', requireRole('viewer', 'admin'), async (c) => {
  // Returns: decision → simulation → inputs (with hash verification)
});
```

### 2. Phase 4 dependencies must include decision state machine

`tsDependencies()` must generate:

```typescript
type DecisionStatus = 'draft' | 'submitted' | 'approved' | 'rejected' | 'executed';

const VALID_TRANSITIONS: Record<DecisionStatus, DecisionStatus[]> = {
  draft: ['submitted'],
  submitted: ['approved', 'rejected'],
  approved: ['executed'],
  rejected: ['draft'],  // can resubmit after revision
  executed: [],          // terminal state
};

export interface IDecisionPort {
  submit(simulationRunId: string, strategyId: string, payload: Record<string, unknown>): Promise<DecisionRecord>;
  approve(id: string, approvedBy: string): Promise<DecisionRecord>;
  reject(id: string, rejectedBy: string, reason: string): Promise<DecisionRecord>;
  execute(id: string, executedBy: string): Promise<DecisionRecord>;
  getById(id: string): Promise<DecisionRecord | null>;
  listByStatus(status: DecisionStatus): Promise<DecisionRecord[]>;
}
```

### 3. Phase 4 schema generator must produce decision schemas

```typescript
export const SubmitDecisionSchema = z.object({
  simulationRunId: z.string().min(1),
  strategyId: z.string().min(1),
  recommendedAction: z.string().min(1),
  justification: z.string().min(10),
});

export const ApproveDecisionSchema = z.object({
  approvalNote: z.string().optional(),
});

export const RejectDecisionSchema = z.object({
  reason: z.string().min(10),
});
```

### 4. ERP writeback must be gated behind decision execution

The existing ERP client's writeback methods must check decision status:

```typescript
// In ERP writeback endpoint handler
const lineageResult = await validateLineage(decisionId, db);
if (!lineageResult.valid) {
  return c.json({ error: 'LINEAGE_INVALID', reason: lineageResult.reason, correlationId }, 422);
}
```

## Consequences

- (+) Human-in-the-loop governance is enforced at the API level
- (+) Every ERP writeback traces to an approved, simulation-backed decision
- (+) State machine prevents invalid transitions (can't skip approval)
- (+) Full lineage query available for compliance auditors
- (-) Adds 5 new endpoints to every generated project
- (-) Requires decisions table in the database schema

## Audit References

- GV: "No approval workflow endpoints" — now generated with state machine
- SI-5: "No execution gating" — ERP writeback requires approved decision with valid lineage
- "validateLineage() exists but no API endpoint" — now exposed via /decisions/:id/lineage
