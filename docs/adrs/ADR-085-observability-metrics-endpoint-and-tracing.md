# ADR-085: Observability — Metrics Endpoint, Database Error Logging, Distributed Tracing

## Status: IMPLEMENTED

## Date: 2026-04-01

## Context

Production readiness audit (2026-04-01) scored Observability 7/10 with four gaps:

1. **No /metrics endpoint exposed** (-1.5): `ConsoleTelemetry` collects requestCount, errorCount, latencySumMs, spanCount, and per-operation breakdowns — but there's no endpoint to expose them. Prometheus, Cloud Monitoring, and ops dashboards can't scrape metrics.

2. **Database errors not in structured logs** (-0.5): When PostgreSQL queries fail, the error is caught and rethrown but not logged with structured JSON including correlationId, query context, and timing.

3. **Audit entries missing compliance fields** (-0.5): Audit records lack `actor_role`, `source_ip`, and `request_id` — required for SOX/GDPR forensic analysis.

4. **No distributed tracing** (-0.5): Correlation IDs propagate within the service, but there's no OpenTelemetry trace context propagation to external services (ERP, platform services).

### Target: 10/10 Observability

## Decision

### 1. Expose /metrics endpoint (Prometheus-compatible)

The generated `routes.ts` template already has a metrics endpoint in the template (it was implemented in ADR-051). The codegen prompt must ensure it's generated:

```typescript
app.get('/metrics', (c) => {
  const metrics = deps.telemetry.metrics;
  const lines: string[] = [];
  lines.push('# HELP http_requests_total Total HTTP requests');
  lines.push('# TYPE http_requests_total counter');
  lines.push(`http_requests_total ${metrics.requestCount}`);
  lines.push('# HELP http_errors_total Total HTTP errors');
  lines.push('# TYPE http_errors_total counter');
  lines.push(`http_errors_total ${metrics.errorCount}`);
  lines.push('# HELP http_latency_sum_ms Total latency in ms');
  lines.push('# TYPE http_latency_sum_ms counter');
  lines.push(`http_latency_sum_ms ${metrics.latencySumMs}`);
  // Per-operation breakdown
  for (const [op, data] of Object.entries(metrics.byOperation)) {
    lines.push(`http_operation_count{operation="${op}"} ${data.count}`);
    lines.push(`http_operation_errors{operation="${op}"} ${data.errors}`);
    lines.push(`http_operation_latency_ms{operation="${op}"} ${data.totalMs}`);
  }
  return c.text(lines.join('\n'), 200, { 'Content-Type': 'text/plain; version=0.0.4' });
});
```

This endpoint must bypass auth (already handled — health and metrics are excluded from IAM middleware).

### 2. Structured database error logging

Adapter classes must log database errors with context before rethrowing:

```typescript
try {
  await this.db.execute(sql, params);
} catch (err) {
  console.error(JSON.stringify({
    level: 'error',
    type: 'DATABASE_ERROR',
    correlationId,
    operation,
    sql: sql.slice(0, 100), // truncate to avoid logging sensitive data
    error: err instanceof Error ? err.message : String(err),
    durationMs: Date.now() - start,
  }));
  throw err;
}
```

### 3. Audit entry enrichment

The `IAuditPort.log()` method must accept optional context with compliance fields:

```typescript
interface AuditContext {
  actorRole?: string;
  sourceIp?: string;
  requestId?: string;
}

// Route handlers pass context from request:
await deps.audit.log('decisions', id, 'approved', actor, payload, {
  actorRole: roles.join(','),
  sourceIp: c.req.header('x-forwarded-for') ?? c.req.header('x-real-ip') ?? 'unknown',
  requestId: correlationId,
});
```

The audit_log table schema adds `actor_role TEXT`, `source_ip TEXT`, `request_id TEXT` columns.

### 4. OpenTelemetry trace context propagation

The generated code should propagate `traceparent` headers to external services:

```typescript
// In platform service calls and ERP calls:
headers['traceparent'] = `00-${traceId}-${spanId}-01`;
```

For the pilot, the `ObservatoryTelemetry` adapter (ADR-077) already sends spans to the platform. Adding `traceparent` propagation to outbound calls enables end-to-end distributed tracing.

## Consequences

### Positive
- Prometheus can scrape /metrics for dashboards and alerting
- Database errors are visible in structured logs with context
- Audit entries meet SOX/GDPR forensic requirements
- Distributed tracing enables cross-service debugging

### Negative
- /metrics endpoint is unauthenticated (standard for Prometheus) — ensure it's not exposed to public internet
- Additional columns in audit_log table

## Implementation Priority

**HIGH — Day 1-2.** Estimated effort: 4-6 hours.

## Related ADRs
- ADR-077: Observatory and Sentinel Usage for Operations
- ADR-070: Secure ID Generation and ACL Hardening (audit enrichment)
