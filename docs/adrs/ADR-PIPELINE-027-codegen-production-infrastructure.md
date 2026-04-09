# ADR-PIPELINE-027: Codegen Production Infrastructure — Every Generated Project Must Be Production-Ready

**Status:** Accepted
**Date:** 2026-04-09
**Priority:** HIGH — Code quality and observability scores stuck at 5-7.5/10

## Context

The code generation pipeline (Phase 3-6) produces TypeScript prototypes that:
- Compile and pass tests (good)
- Have domain-specific business logic (good)
- Have governance/audit patterns (good)

But lack production infrastructure:
- No structured logging (console.log only)
- No health check endpoints
- No retry logic or circuit breakers in ERP clients
- No metrics collection
- No central config module (magic numbers scattered)
- No typed error classes
- Hardcoded URLs and thresholds
- Test assertions are too lenient
- Architecture docs don't match implementation

These gaps cause Code Quality (7.5), Architecture (7.0), and Observability (5.0) scores to plateau.

## Decision

### 1. Generated `src/config.ts` — Single Source of Truth

Every generated project must include a config module. The codegen must scan the DDD model for:
- Scoring dimensions → weight environment variables
- Thresholds → threshold environment variables
- ERP URLs → connection environment variables
- Feature flags → boolean environment variables

Template:
```typescript
export const config = {
  // Scoring weights (must sum to 1.0)
  weights: {
    dimension1: parseFloat(process.env.WEIGHT_DIMENSION1 ?? '0.4'),
    dimension2: parseFloat(process.env.WEIGHT_DIMENSION2 ?? '0.35'),
    dimension3: parseFloat(process.env.WEIGHT_DIMENSION3 ?? '0.25'),
  },
  // Thresholds
  thresholds: { ... },
  // ERP
  erp: {
    baseUrl: process.env.ERP_BASE_URL ?? '',
    timeout: parseInt(process.env.ERP_TIMEOUT_MS ?? '30000'),
    maxRetries: parseInt(process.env.ERP_MAX_RETRIES ?? '3'),
  },
  // Logging
  logLevel: process.env.LOG_LEVEL ?? 'info',
  // Governance
  governance: {
    approvalExpirationHours: parseInt(process.env.APPROVAL_EXPIRATION_HOURS ?? '72'),
    maxPendingApprovals: parseInt(process.env.MAX_PENDING_APPROVALS ?? '10'),
  },
} as const;

// Validate weights sum to 1.0
const weightSum = Object.values(config.weights).reduce((a, b) => a + b, 0);
if (Math.abs(weightSum - 1.0) > 0.01) {
  throw new Error(`Scoring weights must sum to 1.0, got ${weightSum}`);
}
```

### 2. Generated `src/logger.ts` — Structured Logging

```typescript
type LogLevel = 'debug' | 'info' | 'warn' | 'error';
const LEVELS: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

export function createLogger(component: string) {
  const minLevel = LEVELS[config.logLevel as LogLevel] ?? 1;
  
  return {
    debug: (msg: string, data?: Record<string, unknown>) => log('debug', component, msg, data, minLevel),
    info: (msg: string, data?: Record<string, unknown>) => log('info', component, msg, data, minLevel),
    warn: (msg: string, data?: Record<string, unknown>) => log('warn', component, msg, data, minLevel),
    error: (msg: string, data?: Record<string, unknown>) => log('error', component, msg, data, minLevel),
  };
}

function log(level: LogLevel, component: string, msg: string, data: Record<string, unknown> | undefined, minLevel: number) {
  if (LEVELS[level] < minLevel) return;
  const entry = { level, timestamp: new Date().toISOString(), component, message: msg, ...data };
  process.stdout.write(JSON.stringify(entry) + '\n');
}
```

### 3. Generated `src/errors.ts` — Typed Error Classes

```typescript
export class DomainValidationError extends Error {
  constructor(message: string, public readonly field: string, public readonly value: unknown) {
    super(`Validation failed: ${message} (field: ${field})`);
    this.name = 'DomainValidationError';
  }
}

export class ERPIntegrationError extends Error {
  constructor(message: string, public readonly system: string, public readonly statusCode?: number) {
    super(`ERP integration failed: ${message} (system: ${system})`);
    this.name = 'ERPIntegrationError';
  }
}

export class GovernanceViolationError extends Error {
  constructor(message: string, public readonly requiredRole: string) {
    super(`Governance violation: ${message} (required: ${requiredRole})`);
    this.name = 'GovernanceViolationError';
  }
}
```

### 4. ERP Client with Retry + Circuit Breaker

Generated ERP client adapters must include:
```typescript
async function withRetry<T>(fn: () => Promise<T>, maxRetries = config.erp.maxRetries): Promise<T> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt === maxRetries || !isRetryable(err)) throw err;
      const delay = Math.min(1000 * Math.pow(2, attempt) + Math.random() * 500, 10000);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  throw new Error('Unreachable');
}
```

### 5. Health Check Endpoints

When HTTP API is generated:
```typescript
app.get('/health', (req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString(), uptime: process.uptime() }));
app.get('/health/ready', async (req, res) => {
  const checks = { database: await checkDb(), erp: await checkErp() };
  const allOk = Object.values(checks).every(c => c === 'ok');
  res.status(allOk ? 200 : 503).json({ status: allOk ? 'ready' : 'degraded', checks });
});
```

### 6. Stronger Test Generation

Test template must produce:
- Exact assertions: `expect(results).toHaveLength(8)` not `toBeGreaterThanOrEqual(2)`
- Boundary tests: score of exactly 0, exactly 100, weights summing to >1.0
- Error path tests: invalid input, unknown region, expired approval
- Integration test: full pipeline from sample data → recommendations → governance → audit trail

### 7. `.env.example` Generation

Every project gets a `.env.example`:
```
# ERP Configuration
ERP_BASE_URL=https://your-erp-instance.example.com/api/v2
ERP_TIMEOUT_MS=30000
ERP_MAX_RETRIES=3

# Scoring Weights (must sum to 1.0)
WEIGHT_ENERGY=0.40
WEIGHT_SAFETY=0.35
WEIGHT_DELIVERY=0.25

# Governance
APPROVAL_EXPIRATION_HOURS=72
MAX_PENDING_APPROVALS=10

# Logging
LOG_LEVEL=info

# Feature Flags
MOCK_MODE=true
```

## Files to Change

- `src/pipeline/phase3/phases/domain-codegen.ts` — Add generators for config.ts, logger.ts, errors.ts, .env.example
- `src/pipeline/phase4/phases/http-server-generator.ts` — Add health endpoints, structured logging middleware
- `src/pipeline/phase3/phases/test-codegen.ts` — Exact assertions, boundary tests, error path tests
- ERP client generator — Add retry logic, circuit breaker, timeout config

## Consequences

- [+] Every generated project includes production infrastructure out of the box
- [+] Observability score improves from 5 → 8+ (logging, health, metrics)
- [+] Code quality score improves from 7.5 → 9+ (config, errors, validation)
- [+] Architecture score improves from 7 → 9+ (env config, documented integration stubs)
- [-] Generated code is ~30% larger (infrastructure boilerplate)
- [-] Config validation on startup may cause failures in misconfigured environments (by design)
