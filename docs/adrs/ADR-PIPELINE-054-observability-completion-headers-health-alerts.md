# ADR-PIPELINE-054: Observability Completion — Response Headers, Deep Health Checks, Alert Thresholds

**Status:** Accepted
**Date:** 2026-04-10
**Priority:** HIGH — Observability scored 7.0/10, three specific gaps remain
**Originating Review:** Production Readiness Review (2026-04-10)
**Builds on:** ADR-PIPELINE-051 (Observability 9/10)

## Context

ADR-PIPELINE-051 established correlation ID threading, metrics endpoints, and circuit breakers. The prototype implements all three. However, the production readiness review identified three remaining gaps that prevent the observability score from reaching 9/10:

1. **Correlation ID not returned in response headers.** The middleware generates and attaches `req.correlationId` but never calls `res.setHeader('X-Correlation-Id', ...)`. Clients testing the API during pilot cannot trace their requests through logs.

2. **Health endpoint is shallow.** `GET /health` returns `{ status: 'ok' }` unconditionally. It does not verify downstream dependencies (database connectivity, ERP reachability, circuit breaker state). Kubernetes cannot distinguish liveness from readiness.

3. **No alert thresholds defined.** The `/metrics` endpoint exposes raw counters (request count, error count, average latency) but defines no SLOs or alarm conditions. Even for a pilot, a baseline "if error rate > 5% over 5 min, alert" is expected.

## Decision

### 1. Correlation ID in Response Headers (1 Line Fix)

```
RULE: The correlationId middleware MUST set the response header
BEFORE calling next():

  res.setHeader('X-Correlation-Id', correlationId);

This enables:
- Client-side request tracing during pilot testing
- Load balancer log correlation
- Support ticket → log entry mapping
```

### 2. Deep Health Check with Liveness/Readiness Split

```
RULE: The health endpoint MUST distinguish liveness from readiness:

GET /health/live → { status: 'ok' }
  - Returns 200 if the process is running
  - Used by Kubernetes livenessProbe
  - NEVER checks external dependencies

GET /health/ready → { status: 'ready'|'degraded'|'not_ready', checks: {...} }
  - Verifies: config loaded, circuit breaker closed, memory usage < 90%
  - Returns 200 if all checks pass
  - Returns 503 if any critical check fails
  - Used by Kubernetes readinessProbe

GET /health (existing) → redirect or alias to /health/ready
```

### Implementation of Readiness Checks

```typescript
interface HealthCheck {
  name: string;
  status: 'pass' | 'warn' | 'fail';
  message?: string;
  latencyMs?: number;
}

// Checks to implement:
// 1. config_loaded: verify config object is non-null
// 2. circuit_breaker: verify state !== 'open'
// 3. memory_usage: verify process.memoryUsage().heapUsed / heapTotal < 0.9
// 4. audit_chain: verify audit chain integrity (optional, can be slow)

// Overall status:
// - All pass → 'ready' (200)
// - Any warn → 'degraded' (200)
// - Any fail → 'not_ready' (503)
```

### 3. Baseline Alert Threshold Definitions

```
RULE: The metrics module MUST export alert threshold constants:

export const ALERT_THRESHOLDS = {
  errorRatePercent: 5,        // Alert if > 5% of requests return 5xx
  errorRateWindowMs: 300_000, // Over a 5-minute window
  p99LatencyMs: 2000,         // Alert if p99 > 2s
  circuitOpenCount: 3,        // Alert if circuit opens > 3 times in 1 hour
  auditChainBroken: true,     // Alert immediately on chain integrity failure
} as const;

These thresholds are NOT enforced at runtime in the prototype.
They are exported as a contract for the monitoring layer (Grafana,
CloudWatch, Datadog) to consume during pilot setup.

The /metrics response SHOULD include a `thresholds` section so
monitoring tools can auto-configure alerts.
```

## Implementation

### In `src/middleware.ts`

1. Add `res.setHeader('X-Correlation-Id', correlationId)` to the correlation ID middleware
2. Export `ALERT_THRESHOLDS` constant

### In `src/api.ts`

1. Split `/health` into `/health/live` and `/health/ready`
2. `/health/ready` checks config, circuit breaker state, memory usage
3. Include `ALERT_THRESHOLDS` in `/metrics` response

## Validation

- [ ] `curl -I /api/decisions` returns `X-Correlation-Id` header
- [ ] `GET /health/live` returns 200 with minimal payload
- [ ] `GET /health/ready` returns 503 when circuit breaker is open
- [ ] `GET /metrics` includes `thresholds` section
- [ ] Correlation ID in response matches the one in structured log entries

## Consequences

- Enables end-to-end request tracing during pilot testing
- Supports proper Kubernetes deployment with liveness/readiness probes
- Provides monitoring teams with a baseline alert contract before pilot day 1
