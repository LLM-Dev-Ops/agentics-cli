# ADR-077: Observatory and Sentinel Usage for Operational Intelligence

## Status: IMPLEMENTED

## Date: 2026-03-31

## Context

Two platform services handle operational intelligence:

**LLM-Observatory** (Phase 1) — 7 agents:
- Telemetry Collector, Usage Pattern, Failure Classification, Health Check, SLO/SLA Enforcement, Post-Mortem Generator, Visualization Spec

**LLM-Sentinel** (Phase 2) — 5 agents:
- Anomaly Detection, Drift Detection, Alerting, Incident Correlation, Root Cause Analysis

The generated application currently implements its own telemetry and event system:
- `ConsoleTelemetry` — wraps handler logic in "spans" that log to stdout
- `ConsoleEventBus` — publishes domain events to `console.log()`
- `PrometheusMetrics` — in-process counters that reset on restart

These local implementations work for development but are useless in production:
- Console logs disappear when Cloud Run recycles instances
- In-process metrics reset on every cold start
- No anomaly detection — nobody is watching for simulation outputs that drift from historical baselines
- No alerting — failures are logged but never escalated
- No cross-instance correlation — each Cloud Run instance has its own isolated view

Observatory and Sentinel are deployed and provide all of this. The generated code should use them.

## Decision

### 1. Replace ConsoleTelemetry with Observatory calls

Every place the generated code currently calls `deps.telemetry.withSpan()` should send the span to Observatory:

```typescript
// The telemetry adapter calls Observatory instead of console.log
class ObservatoryTelemetry implements Telemetry {
  constructor(private observatoryUrl: string) {}

  async withSpan<T>(name: string, fn: (span: Span) => Promise<T>): Promise<T> {
    const span = { name, startTime: Date.now(), attributes: {} };
    try {
      const result = await fn(span);
      span.endTime = Date.now();
      span.status = 'ok';
      // Fire-and-forget to Observatory
      this.send(span).catch(() => {});
      return result;
    } catch (error) {
      span.endTime = Date.now();
      span.status = 'error';
      span.errorMessage = error.message;
      this.send(span).catch(() => {});
      throw error;
    }
  }

  private async send(span: unknown): Promise<void> {
    await callPlatformService(
      this.observatoryUrl,
      '/api/v1/telemetry/spans',
      span
    );
  }
}
```

The interface stays the same (`Telemetry`), so existing handler code doesn't change. Only the adapter implementation changes — swap `ConsoleTelemetry` for `ObservatoryTelemetry` in the DI container.

### 2. Replace ConsoleEventBus with Observatory event ingestion

Domain events (simulation completed, ERP writeback approved, scenario comparison generated) should flow to Observatory for pattern analysis:

```typescript
class ObservatoryEventBus implements EventBus {
  async publish(event: DomainEvent): Promise<void> {
    await callPlatformService(
      this.observatoryUrl,
      '/api/v1/telemetry/events',
      {
        type: event.type,
        payload: event.payload,
        timestamp: event.timestamp,
        correlationId: event.correlationId,
      }
    ).catch(() => {
      // Operational tier — log locally if Observatory is down
      console.warn(`[observatory-unavailable] ${event.type}`);
    });
  }
}
```

### 3. Use Sentinel for simulation output anomaly detection

This is new functionality that doesn't exist in the generated code at all. After every simulation run, send the results to Sentinel for anomaly checking:

```typescript
// After scenario orchestrator produces results
const comparison = orchestrator.compareScenarios(scenarios, suppliers, sites, contracts, insurance);

// Ask Sentinel: does this look normal?
const anomalyCheck = await callPlatformService(
  process.env.AGENTICS_SENTINEL_URL,
  '/api/v1/check',
  {
    type: 'simulation_output',
    data: {
      expectedLossRange: comparison.scenarios.map(s => s.tradeoffs.expectedLoss),
      premiumRange: comparison.scenarios.map(s => s.tradeoffs.insurancePremium),
      resilienceScores: comparison.scenarios.map(s => s.tradeoffs.supplyChainResilience),
    },
    context: {
      domain: comparison.domain,
      scenarioCount: comparison.scenarios.length,
      runId: comparison.runId,
    },
  }
).catch(() => null); // Nice-to-have tier

if (anomalyCheck?.anomalies?.length > 0) {
  // Flag in the response — don't block, but surface it
  comparison.warnings = anomalyCheck.anomalies.map(a => ({
    type: 'anomaly_detected',
    message: a.description,
    severity: a.severity,
  }));
}
```

Sentinel's Drift Detection agent compares current outputs against historical baselines. If a supplier's risk score suddenly jumps 3x compared to the last 10 runs, that's worth flagging — it might be a data issue, not a real risk change.

### 4. Use Sentinel for alerting on ERP failures

When the circuit breaker opens on Oracle Fusion Cloud, tell Sentinel:

```typescript
// In ERP client, when circuit breaker trips
onCircuitOpen() {
  callPlatformService(
    process.env.AGENTICS_SENTINEL_URL,
    '/api/v1/alert',
    {
      type: 'circuit_breaker_open',
      service: 'oracle_fusion_cloud',
      threshold: this.config.failureThreshold,
      recentFailures: this.recentErrors.slice(-5).map(e => e.message),
    }
  ).catch(() => {});
}
```

Sentinel's Alerting agent and Incident Correlation agent handle escalation from there.

### 5. Observatory and Sentinel are non-blocking

Both are "nice to have" tier (ADR-074). If unavailable:
- Log locally (the existing `ConsoleTelemetry` becomes the fallback, not the primary)
- Continue processing
- No retry needed

```typescript
// DI container factory
function createTelemetry(): Telemetry {
  const observatoryUrl = process.env.AGENTICS_OBSERVATORY_URL;
  if (observatoryUrl) {
    return new ObservatoryTelemetry(observatoryUrl);
  }
  // Fallback for local dev or when Observatory is unavailable
  return new ConsoleTelemetry();
}
```

## Consequences

### Positive
- Telemetry survives instance restarts — Observatory persists it
- Anomaly detection catches data issues and output drift automatically
- Alerting on ERP failures gets escalated through proper channels
- Usage patterns and SLO compliance are tracked across all instances
- Post-mortem generation is automatic when failures occur

### Negative
- Slightly higher telemetry latency (HTTP call vs console.log) — mitigated by fire-and-forget
- Observatory becomes the source of truth for observability — need to ensure it's reliable
- Sentinel anomaly baselines need time to build — initial runs will have no historical comparison

## Implementation Priority

**HIGH — Days 2-4.** The DI container already abstracts telemetry behind an interface, so swapping `ConsoleTelemetry` for `ObservatoryTelemetry` is a clean adapter swap. Sentinel integration for simulation outputs is new code but follows established patterns. Estimated effort: 4-6 hours total.

## Related ADRs
- ADR-074: Pipeline Must Use Platform Services
- ADR-068: Domain Route RBAC and Telemetry Parity (telemetry spans now go to Observatory)
- ADR-038: Observability and Continuous Learning
