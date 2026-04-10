# ADR-PRR-006: Add Health Check Endpoints for Container Deployment

## Status: IMPLEMENTED

## Date: 2026-04-10

## Priority: MEDIUM — Address during pilot

## Effort: 30 minutes

## Context

Production readiness review (2026-04-10) found no `/healthz` (liveness) or `/readyz` (readiness) endpoints. These are required for:
- Kubernetes liveness probes (restart unhealthy pods)
- Kubernetes readiness probes (remove from load balancer during startup or degradation)
- Load balancer health checks (ALB, NLB, Envoy)
- Monitoring dashboards and uptime tracking

The system already has a `/metrics` endpoint and circuit breaker state tracking — health checks can leverage both.

## Decision

### 1. Add `/healthz` liveness probe

Returns 200 if the process is alive and can handle requests. This should never fail unless the process is deadlocked.

```typescript
// In src/routes.ts
router.get('/healthz', (_req, res) => {
  res.status(200).json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    version: container.pipelineVersion,
  });
});
```

### 2. Add `/readyz` readiness probe

Returns 200 if the service is ready to accept traffic. Checks critical dependencies.

```typescript
router.get('/readyz', (_req, res) => {
  const checks: Record<string, 'pass' | 'fail'> = {};

  // Check ERP adapter circuit breaker state
  checks.erp_circuit_breaker = container.erpAdapter.isCircuitOpen()
    ? 'fail'  // Circuit is open — ERP integration degraded
    : 'pass';

  // Check audit trail integrity
  try {
    const isValid = container.audit.verifyChain();
    checks.audit_chain = isValid ? 'pass' : 'fail';
  } catch {
    checks.audit_chain = 'fail';
  }

  // Check memory (basic — flags if heap exceeds 90% of limit)
  const heapUsed = process.memoryUsage().heapUsed;
  const heapTotal = process.memoryUsage().heapTotal;
  checks.memory = (heapUsed / heapTotal) < 0.9 ? 'pass' : 'fail';

  const allPass = Object.values(checks).every(v => v === 'pass');
  const status = allPass ? 200 : 503;

  res.status(status).json({
    status: allPass ? 'ready' : 'degraded',
    timestamp: new Date().toISOString(),
    checks,
  });
});
```

### 3. Expose circuit breaker state

Add `isCircuitOpen(): boolean` method to `ERPAdapter` (or expose existing state field):

```typescript
// In src/erp/adapter.ts
isCircuitOpen(): boolean {
  return this.circuitBreaker.getState() === 'open';
}
```

### 4. Kubernetes deployment configuration

```yaml
# In deployment manifest
livenessProbe:
  httpGet:
    path: /healthz
    port: 3000
  initialDelaySeconds: 5
  periodSeconds: 10
readinessProbe:
  httpGet:
    path: /readyz
    port: 3000
  initialDelaySeconds: 10
  periodSeconds: 15
  failureThreshold: 3
```

## Consequences

### Positive
- Standard Kubernetes deployment support
- Automatic traffic removal during ERP circuit breaker events
- Audit chain integrity continuously monitored
- Memory pressure detected before OOM kill

### Negative
- Readiness check calls `verifyChain()` which iterates the audit log — for large logs, add a cached validity flag updated on each append
- Health endpoints should be excluded from access logging to reduce noise

## Related ADRs
- ADR-056: Metrics Endpoint, Health Check Logging
- ADR-085: Observability Metrics Endpoint and Tracing
- ADR-PRR-010: Replace Global Correlation ID with AsyncLocalStorage
