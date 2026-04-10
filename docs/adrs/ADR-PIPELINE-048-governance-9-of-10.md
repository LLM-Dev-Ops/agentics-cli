# ADR-PIPELINE-048: Governance 9/10 — RBAC Enforcement, Immutable Audit, Separation of Duties

**Status:** Accepted
**Date:** 2026-04-10
**Priority:** HIGH — Governance at 8/10, needs RBAC and true immutability

## Gap Analysis (8 → 9)

| Issue | Impact | Fix |
|-------|--------|-----|
| No RBAC — callers self-identify via request body | Anyone can approve anything | Role-based middleware with JWT/header |
| Audit table allows UPDATE/DELETE | Audit trail tamperable | Append-only constraint + hash chain |
| No separation of duties | Creator can approve own recommendation | Enforce creator ≠ approver |

## Decision

### 1. Role-Based Access Control
```
RULE: The approval workflow MUST enforce roles:
- role: 'analyst' — can create recommendations
- role: 'approver' — can approve/reject
- role: 'admin' — can view audit trail

For prototype: read role from X-User-Role header or JWT claim.
For production: integrate with IdP (Okta, Azure AD, etc.)

The approval endpoint MUST verify:
1. Caller has 'approver' role
2. Caller is NOT the recommendation creator (separation of duties)
```

### 2. Immutable Audit Trail
```
RULE: Audit entries MUST be append-only:
- Database: REVOKE UPDATE, DELETE on audit_entries table
- OR: SHA-256 hash chain — each entry hashes the previous entry's hash
- Verification endpoint: GET /api/audit/verify checks chain integrity
- Any broken link = tamper detected = alert
```

### 3. Approval Chain Completeness
```
RULE: Every state transition MUST record:
- Who (authenticated user ID + role)
- What (from-state → to-state)
- When (ISO timestamp from server, not client)
- Why (rationale string, min 10 chars)
- Correlation ID linking to originating analysis
```

## Implementation

Add to governance prompt and approval workflow prompt.
