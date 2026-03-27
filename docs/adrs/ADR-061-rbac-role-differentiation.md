# ADR-061: RBAC Must Differentiate Roles Per Operation Type

## Status: ACCEPTED

## Date: 2026-03-27

## Context

Audit (GV-CRITICAL): "Every endpoint calls `requireRole('viewer', 'writer', 'admin')`. This means any authenticated user with any role gets access to every operation. A viewer can trigger ERP writeback."

ADR-049 added `requireRole()` middleware but the generated routes use the same role set for GET and POST endpoints. The role differentiation logic (isApproval, isErpWrite) exists in the generator but GET endpoints all get `requireRole('viewer', 'writer', 'admin')` which is equivalent to "any role."

## Decision

### 1. Strict role separation by HTTP method and operation type

| Operation | Required Role | Rationale |
|-----------|--------------|-----------|
| GET (queries/reads) | `viewer` | Read-only access to data |
| POST (commands/writes) | `writer` | Create/modify domain records |
| POST (approvals) | `approver` | Approve/reject decisions — separate from write |
| POST (ERP writeback) | `erp_writer` | Write to external ERP system |
| POST (execute decision) | `erp_writer` | Triggers ERP writeback after lineage validation |
| DELETE | `admin` | Destructive operations |
| GET /metrics | (no auth) | Monitoring endpoint, no RBAC |
| GET /health/* | (no auth) | Health endpoints, no RBAC |

### 2. Phase 4 route generator must NOT use OR for different privilege levels

**Wrong** (current):
```typescript
app.get('/api/v1/suppliers/list', requireRole('viewer', 'writer', 'admin'), ...)
app.post('/api/v1/suppliers/create', requireRole('writer', 'admin'), ...)
```

**Right** (fixed):
```typescript
app.get('/api/v1/suppliers/list', requireRole('viewer'), ...)   // viewers only need viewer
app.post('/api/v1/suppliers/create', requireRole('writer'), ...) // writers can write
```

The `requireRole` function should check if the user has the MINIMUM required role, not any-of. But since RBAC is role-based (not hierarchical), we keep the OR pattern but with CORRECT role assignments:

```typescript
// GET endpoints: viewer OR writer OR admin (all can read)
app.get(..., requireRole('viewer', 'writer', 'admin'), ...)

// POST command endpoints: writer OR admin (viewers cannot write)
app.post(..., requireRole('writer', 'admin'), ...)

// Approval endpoints: approver OR admin ONLY (writers cannot approve their own submissions)
app.post('.../approve', requireRole('approver', 'admin'), ...)

// ERP writeback: erp_writer OR admin ONLY
app.post('.../execute', requireRole('erp_writer', 'admin'), ...)
```

### 3. The real fix: POST command routes must NOT include 'viewer'

The generator currently adds `'viewer'` to POST routes. Remove it:

```typescript
// In tsRoutes() POST handler generation:
const requiredRole = isApproval ? "'approver', 'admin'"
  : isErpWrite ? "'erp_writer', 'admin'"
  : "'writer', 'admin'";  // NOT "'viewer', 'writer', 'admin'"
```

This is already correct in the generator (ADR-049) but the generated output still includes viewer on POST routes. Verify and fix the codegen output.

## Consequences

- (+) Viewers cannot modify data or trigger ERP operations
- (+) Writers cannot approve decisions (separation of duties)
- (+) ERP writeback requires dedicated erp_writer role
- (-) Requires role provisioning in IAM (GCP IAM, Okta, etc.)

## Audit References

- GV-CRITICAL: RBAC grants all roles full access
- ADR-049: Added requireRole but didn't differentiate correctly
