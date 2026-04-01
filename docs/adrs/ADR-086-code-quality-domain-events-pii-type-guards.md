# ADR-086: Code Quality — Domain Event Emission, PII Enforcement, Type Guards

## Status: IMPLEMENTED

## Date: 2026-04-01

## Context

Production readiness audit (2026-04-01) scored Code Quality 8/10 with three gaps:

1. **Domain events defined but not emitted** (-1.0): `FacilityRegistered`, `ScenarioComputed`, `TradeoffAnalyzed` and other domain events are properly defined in port interfaces but adapters never call `eventBus.publish()`. The event infrastructure exists (ConsoleEventBus, ObservatoryEventBus from ADR-077) but is unused.

2. **PII redaction flag not enforced in logging** (-0.5): `GovernanceConfig.pii_redaction` exists and the mapper checks it before wire transformations, but structured log output (`console.error`, `console.info`) can still contain PII from request bodies, error messages, and audit payloads.

3. **Type assertions on c.get() without guards** (-0.5): Route handlers use `c.get('iamClaims') as Record<string, unknown>` without runtime type checking. If middleware fails to set claims (race condition, misconfiguration), this silently produces `undefined` instead of a clear error.

### Target: 10/10 Code Quality

## Decision

### 1. Emit domain events from adapters

Every adapter that modifies state must emit the corresponding domain event after successful persistence:

```typescript
// In FacilityAdapter.execute():
async execute(command: string, input: unknown, actor: string): Promise<FacilityRecord> {
  // ... existing command dispatch, DB persist ...

  // ADR-086: Emit domain event
  await this.eventBus.publish(createEvent(
    `${context}.${command}`,
    'Facility',
    record.id,
    { command, input },
    correlationId,
    record.id,
  ));

  return record;
}
```

The codegen template must wire `eventBus` into every adapter constructor and emit after every successful state change.

### 2. PII-safe logging utility

Add a utility that redacts sensitive fields before logging:

```typescript
function safeLog(level: 'info' | 'warn' | 'error', data: Record<string, unknown>): void {
  const piiFields = ['email', 'phone', 'ssn', 'address', 'name', 'password', 'token', 'secret'];
  const redacted = { ...data };
  for (const key of Object.keys(redacted)) {
    if (piiFields.some(f => key.toLowerCase().includes(f))) {
      redacted[key] = '[REDACTED]';
    }
    if (typeof redacted[key] === 'string' && (redacted[key] as string).length > 500) {
      redacted[key] = (redacted[key] as string).slice(0, 200) + '...[truncated]';
    }
  }
  const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.info;
  fn(JSON.stringify(redacted));
}
```

All generated `console.error(JSON.stringify(...))` calls should use `safeLog` instead.

### 3. Runtime type guards for middleware values

Replace unsafe type assertions with guarded access:

```typescript
function getIamClaims(c: Context): Record<string, unknown> {
  const claims = c.get('iamClaims');
  if (!claims || typeof claims !== 'object') {
    throw new Error('IAM claims not available — middleware may not have executed');
  }
  return claims as Record<string, unknown>;
}

function getCorrelationId(c: Context): string {
  const id = c.get('correlationId');
  if (typeof id !== 'string' || !id) return 'unknown';
  return id;
}
```

Route handlers use these instead of direct `c.get()` with `as` casts.

## Consequences

### Positive
- Domain events flow to ObservatoryEventBus for pattern analysis
- PII cannot leak through log output
- Type errors surface immediately with clear messages instead of undefined behavior

### Negative
- Event emission adds ~1ms per state change (negligible, async)
- PII redaction may over-redact some field names (acceptable for safety)

## Implementation Priority

**MEDIUM — Day 2-3.** Estimated effort: 4-6 hours.

## Related ADRs
- ADR-077: Observatory and Sentinel (ObservatoryEventBus receives the events)
- ADR-068: Domain Route RBAC and Telemetry Parity
