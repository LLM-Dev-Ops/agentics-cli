# ADR-084: ERP Fail-Fast Startup, Rate Limiter, and Error Translator

## Status: IMPLEMENTED

## Date: 2026-04-01

## Context

Production readiness audit (2026-04-01) scored ERP Readiness 7/10 with three gaps:

1. **Hardcoded fallback URLs** (-1.0): When `NETSUITE_BASE_URL` is not set, the client falls back to `netsuite.example.com` instead of failing fast. In production, this silently sends requests to a non-existent host, producing confusing timeout errors instead of a clear startup failure.

2. **Rate limiter not implemented** (-1.0): The pipeline documentation references a token bucket rate limiter for ERP API calls, but the generated `retry.ts` only implements retry with backoff and circuit breaker — no rate limiting. Without it, burst traffic can exhaust ERP API quotas.

3. **NetSuite error translator missing** (-0.5): The ERP client throws generic `Error` with the HTTP response body. NetSuite returns structured error codes (e.g., `INVALID_SEARCH_FILTER`, `INSUFFICIENT_PERMISSION`, `RECORD_LOCKED`) that should be translated to domain-specific exceptions.

4. **Energy-specific write operations missing governance gate** (-0.5): `createEnergyContract()` exists but doesn't pass through the governance approval workflow.

### Target: 10/10 ERP Readiness

## Decision

### 1. Fail-fast on missing required env vars

The generated main.ts or routes.ts must validate required environment variables at startup:

```typescript
const REQUIRED_ENV_VARS = ['DATABASE_URL'] as const;
const ERP_ENV_VARS = ['NETSUITE_BASE_URL', 'NETSUITE_SA_EMAIL'] as const;

for (const v of REQUIRED_ENV_VARS) {
  if (!process.env[v]) {
    console.error(JSON.stringify({ severity: 'CRITICAL', message: `Missing required env var: ${v}. Exiting.` }));
    process.exit(1);
  }
}
for (const v of ERP_ENV_VARS) {
  if (!process.env[v]) {
    console.warn(JSON.stringify({ severity: 'WARN', message: `Missing ERP env var: ${v}. ERP operations will fail.` }));
  }
}
```

The ERP client constructor must throw on missing base URL — no fallback to example.com:

```typescript
constructor(config: { baseUrl: string; ... }) {
  if (!config.baseUrl || config.baseUrl.includes('example.com')) {
    throw new Error('ERP base URL not configured. Set NETSUITE_BASE_URL (or equivalent) to a valid endpoint.');
  }
  // ...
}
```

### 2. Token bucket rate limiter

Add a `TokenBucketRateLimiter` to the generated `retry.ts`:

```typescript
export class TokenBucketRateLimiter {
  private tokens: number;
  private lastRefill: number;

  constructor(
    private readonly maxTokens: number = 10,
    private readonly refillRate: number = 2, // tokens per second
  ) {
    this.tokens = maxTokens;
    this.lastRefill = Date.now();
  }

  async acquire(): Promise<void> {
    this.refill();
    if (this.tokens < 1) {
      const waitMs = (1 / this.refillRate) * 1000;
      await new Promise(resolve => setTimeout(resolve, waitMs));
      this.refill();
    }
    this.tokens--;
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = (now - this.lastRefill) / 1000;
    this.tokens = Math.min(this.maxTokens, this.tokens + elapsed * this.refillRate);
    this.lastRefill = now;
  }
}
```

The ERP client wraps every external call with `await this.rateLimiter.acquire()` before the circuit breaker.

### 3. ERP error translator

Map ERP-specific error codes to domain exceptions:

```typescript
function translateErpError(status: number, body: string, operation: string): Error {
  try {
    const parsed = JSON.parse(body);
    const code = parsed?.error?.code ?? parsed?.code ?? '';
    const message = parsed?.error?.message ?? parsed?.message ?? body;

    const knownErrors: Record<string, { status: number; domain: string }> = {
      'INVALID_SEARCH_FILTER': { status: 400, domain: 'Invalid query parameters' },
      'INSUFFICIENT_PERMISSION': { status: 403, domain: 'ERP permission denied' },
      'RECORD_LOCKED': { status: 409, domain: 'Record locked by another user' },
      'RECORD_NOT_FOUND': { status: 404, domain: 'ERP record not found' },
      'RATE_LIMIT_EXCEEDED': { status: 429, domain: 'ERP rate limit exceeded — retry later' },
    };

    const known = knownErrors[code];
    if (known) return new Error(`[ERP-${known.status}] ${known.domain}: ${message}`);
    return new Error(`[ERP-${status}] ${operation} failed: ${message}`);
  } catch {
    return new Error(`[ERP-${status}] ${operation} failed: ${body.slice(0, 200)}`);
  }
}
```

### 4. Governance gate on domain-specific write operations

All write operations (including domain-specific ones like `createEnergyContract`) must go through the governance approval workflow — not just the generic transfer/purchase order operations.

## Consequences

### Positive
- Misconfigurations caught at startup, not at first request
- ERP API quotas protected by rate limiter
- Error messages are actionable (domain-specific, not raw HTTP responses)
- All write operations governed consistently

### Negative
- Rate limiter adds slight latency to burst requests (by design)
- Error translator needs maintenance when ERP adds new error codes

## Implementation Priority

**HIGH — Day 1-2.** Estimated effort: 6-8 hours.

## Related ADRs
- ADR-072: ERP Sync Queue Persistence and Schema Validation
- ADR-073: Rust Engine Error Handling and Cleanup
