# ADR-PIPELINE-051: Observability 9/10 — Correlation IDs, Metrics Endpoint, Circuit Breaker, Consistent Error Logging

**Status:** Accepted
**Date:** 2026-04-10
**Priority:** HIGH — Observability stuck at 3-6/10 across all runs

## Gap Analysis (6 → 9)

| Issue | Impact | Fix |
|-------|--------|-----|
| No correlation/trace IDs | Can't trace request across services | UUID per request, threaded through all calls |
| No metrics endpoint | No alerting, no scaling data | Prometheus /metrics with counters + histograms |
| Inconsistent error logging | Some log stack, some log message string | Standardized error logging function |
| No circuit breaker on ERP | 30s hang per request when ERP down | Circuit breaker with configurable thresholds |
| Logger exists but unused in many modules | Scaffold disconnected from implementation | Enforce import in every file |

## Decision

### 1. Correlation ID Threading (NON-NEGOTIABLE)
```
RULE: Every incoming request gets a UUID correlation ID:
- Set from X-Correlation-Id header if present, else generate
- Attach to request context (req.correlationId or AsyncLocalStorage)
- Include in EVERY log entry
- Include in EVERY audit entry
- Include in EVERY ERP API call header
- Return in response header
```

### 2. Metrics Endpoint
```
RULE: GET /metrics returns Prometheus-compatible metrics:
- http_requests_total{method, path, status} — counter
- http_request_duration_seconds{method, path} — histogram
- domain_recommendations_total{status} — counter
- domain_scoring_duration_seconds — histogram
- erp_sync_total{status} — counter
- erp_sync_duration_seconds — histogram
```

### 3. Standardized Error Logging
```
RULE: All errors logged via logger.error() with:
- error.message
- error.stack (for 5xx only)
- error.code (if AppError)
- correlationId
- operation context (what was being attempted)

NEVER: logger.error({ error: err }) — this logs [object Object]
ALWAYS: logger.error('operation.failed', err, { context })
```

### 4. Circuit Breaker
```
RULE: External service calls (ERP, APIs) MUST use circuit breaker:
- Closed → Open after 5 consecutive failures
- Open → Half-Open after 30s cooldown
- Half-Open → Closed after 1 successful call
- Log every state transition
```

## Implementation

Add to observability prompt (already detailed in ADR-034). The issue is enforcement — ADR-043's anti-pattern warnings need to be even more explicit.
