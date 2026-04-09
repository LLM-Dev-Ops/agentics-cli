# ADR-PIPELINE-034: Observability Requirements — Generated Code Must Include Structured Logging, Correlation IDs, and Health Checks

**Status:** Accepted
**Date:** 2026-04-09
**Priority:** HIGH — Observability scores 3.5-4.0/10 in every evaluation

## Context

Every generated prototype lacks observability infrastructure:
- No structured logging (only `console.log` or silent operation)
- No correlation IDs threading through the pipeline
- No health check endpoints
- No error classification or retry logic
- No metrics collection

The evaluations consistently score Observability at 3.5/10 and note: "Absent. Expected at prototype, required for pilot."

This is a codegen problem — the pipeline should emit observability code, not leave it for the team to add manually.

## Decision

### 1. Generated `src/logger.ts` — Structured JSON Logger

Every generated project must include a structured logger:

```typescript
export function createLogger(service: string) {
  return {
    info(event: string, data?: Record<string, unknown>) { /* JSON to stderr */ },
    warn(event: string, data?: Record<string, unknown>) { /* JSON to stderr */ },
    error(event: string, error: Error, data?: Record<string, unknown>) { /* JSON to stderr */ },
  };
}
```

All log entries must include: `timestamp`, `level`, `service`, `event`, `correlationId`, and optional `data`.

### 2. Correlation ID Must Flow End-to-End

Every analysis run, decision, and ERP transaction must carry a `correlationId` (UUID) that traces from the initial analysis trigger through to the ERP write. The pattern:

```
Analysis started (correlationId: abc-123)
  → Excess detected for supplier X (correlationId: abc-123)
  → Recommendation generated (correlationId: abc-123)
  → Decision created (correlationId: abc-123)
  → ERP sync attempted (correlationId: abc-123)
  → ERP sync succeeded (correlationId: abc-123)
```

### 3. Error Handling in ERP Connectors

Generated ERP connectors must handle:
- Network timeout (configurable, default 30s)
- Rate limiting (429 response → exponential backoff)
- Schema validation errors (log and quarantine, don't crash)
- Idempotency keys (prevent duplicate ERP writes on retry)

### 4. Health Check for Service Deployments

When the generated project includes an API/HTTP layer, include a `/health` endpoint that reports:
- Service name and version
- Uptime
- Database/ERP connectivity status
- Last analysis run timestamp

### 5. Instrumentation Points

At minimum, the following events must be logged:
- `analysis.started` — supplier count, shipment count
- `analysis.excess_detected` — flag count, top supplier
- `analysis.completed` — duration, opportunity count
- `decision.created` — decision ID, opportunity ID, status
- `erp.sync.attempted` — transaction ID, supplier ID
- `erp.sync.succeeded` / `erp.sync.failed` — transaction ID, error if failed

## Consequences

### Positive
- Observability score should increase from 3.5 to 7.0+
- Pilot teams can trace issues without reading source code
- ERP integration failures become visible before they cascade

### Negative
- Logger adds ~50 lines to generated output
- Correlation ID threading requires passing context through function calls

## Implementation

Files to modify:
- Code generation templates — Emit `src/logger.ts` and `src/config.ts`
- `src/pipeline/phase2/phases/prompt-generator.ts` — Cross-cutting observability prompt
- ADR-PIPELINE-027 (codegen infrastructure) — Already specifies these, needs enforcement in templates
