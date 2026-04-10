# ADR-PIPELINE-050: ERP Readiness 9/10 — Correct System Detection, Retry/Idempotency, Schema Documentation

**Status:** Accepted
**Date:** 2026-04-10
**Priority:** HIGH — ERP Readiness at 5-6/10

## Gap Analysis (6 → 9)

| Issue | Impact | Fix |
|-------|--------|-----|
| ERP surface detects SAP when user specified ServiceNow | Credibility destroyer | Correct system detection (ADR-032 partial) |
| No retry/idempotency on ERP writes | State divergence on transient failure | Exponential backoff + idempotency key |
| Custom table schema not documented | ERP admin can't create the table | Schema definition in code |
| No circuit breaker | Cascading failure when ERP is down | Circuit breaker with health check |

## Decision

### 1. ERP Adapter Must Include Resilience
```
RULE: Every ERP adapter MUST implement:
- Retry with exponential backoff (1s, 2s, 4s, max 3 attempts)
- Idempotency key per write operation (hash of decision ID + timestamp)
- Check-before-write: query for existing record before creating
- Circuit breaker: after 5 consecutive failures, open circuit for 30s
- All operations logged with correlation ID and response time
```

### 2. ERP Schema as Code
```
RULE: The custom ERP table/object schema MUST be documented in code:
- TypeScript interface matching the ERP record structure
- Field-by-field mapping from domain type to ERP field
- Example: ServiceNow Update Set XML, SAP CDS view, Coupa custom form definition
```

### 3. Correct System Detection
```
RULE: The ERP surface MUST match the user's specified system:
- ServiceNow → ServiceNow CMDB, Incident, Custom Table patterns
- SAP → OData, BAPI, RFC patterns
- Workday → RaaS, Custom Object patterns
- Never return SAP analysis for a ServiceNow query
```

## Implementation

Add to ERP integration prompt. Fix detectErpFromQuery for ServiceNow/Blue Yonder/Descartes.
