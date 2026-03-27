# ADR-051: Simulation Lineage, Decision Traceability, and Production Observability

## Status: ACCEPTED

## Date: 2026-03-27

## Context

Production audit (SI-1 through SI-5, OB-1 through OB-5) found two major capability gaps:

**Simulation lineage is broken:**
- SI-1: No simulation engine exists — the "simulation" is an external API call, not embedded logic
- SI-2: No lineage chain — decision memo has no `simulation_id`, scenario JSON has no back-reference
- SI-3: Risk assessment is empty (`risk_factors: []`) for a 112K-employee manufacturer
- SI-4: No immutability proof — inputs can be modified after the fact
- SI-5: No execution gating — ERP writeback has no simulation validation

**Observability is incomplete:**
- OB-1: Error messages leak internal details (database schema, stack traces) to API clients
- OB-2: Catch blocks return error responses but never log the error
- OB-3: Auth errors missing correlation ID
- OB-4: Telemetry spans don't carry request correlation ID — orphaned traces
- OB-5: No metrics (request count, latency, error rate, circuit breaker state)

## Decision

### 1. Simulation lineage chain — every decision traces to a simulation

Phase 5 must generate a lineage model:

```typescript
// Lineage types — generated in domain layer
interface SimulationRun {
  id: string;
  inputHash: string;            // SHA-256 of serialized inputs
  parameters: SimulationParams; // immutable snapshot
  results: SimulationResults;
  createdAt: string;
  createdBy: string;            // authenticated user
}

interface DecisionScenario {
  id: string;
  simulationRunId: string;      // REQUIRED — traces to simulation
  strategy: string;
  metrics: TradeoffMetrics;
  approvalStatus: ApprovalStatus;
  approvedBy: string | null;
  approvedAt: string | null;
}

interface ERPWriteback {
  id: string;
  decisionId: string;           // REQUIRED — traces to decision
  simulationRunId: string;      // REQUIRED — traces to simulation
  oracleTransactionId: string;
  status: 'pending' | 'completed' | 'failed';
}
```

**Lineage query** (must be answerable):
```sql
-- "Which simulation produced this ERP writeback?"
SELECT s.id, s.input_hash, s.parameters, s.created_by
FROM erp_writebacks w
JOIN decisions d ON w.decision_id = d.id
JOIN simulation_runs s ON d.simulation_run_id = s.id
WHERE w.id = $1;
```

### 2. Input immutability with content hash

```typescript
// Before running simulation, hash inputs
import { createHash } from 'node:crypto';

function hashSimulationInputs(params: SimulationParams): string {
  const canonical = JSON.stringify(params, Object.keys(params).sort());
  return createHash('sha256').update(canonical).digest('hex');
}

// Store hash with simulation run
const run: SimulationRun = {
  id: randomUUID(),
  inputHash: hashSimulationInputs(params),
  parameters: Object.freeze(structuredClone(params)), // deep freeze
  // ...
};

// Before ERP writeback, verify hash matches
const storedRun = await deps.simulations.getById(decision.simulationRunId);
const currentHash = hashSimulationInputs(storedRun.parameters);
if (currentHash !== storedRun.inputHash) {
  throw new Error('LINEAGE_TAMPERED: Simulation inputs modified after execution');
}
```

### 3. Execution gating on ERP writeback

```typescript
// Phase 5 must generate this validation in the writeback route
async function validateWritebackLineage(decisionId: string, deps: Dependencies): Promise<void> {
  const decision = await deps.decisions.getById(decisionId);
  if (!decision) throw new Error('Decision not found');
  if (decision.approvalStatus !== 'approved') throw new Error('Decision not approved');
  if (!decision.simulationRunId) throw new Error('Decision has no simulation lineage');

  const simulation = await deps.simulations.getById(decision.simulationRunId);
  if (!simulation) throw new Error('Linked simulation not found');

  // Verify simulation integrity
  const hash = hashSimulationInputs(simulation.parameters);
  if (hash !== simulation.inputHash) throw new Error('Simulation inputs tampered');
}
```

### 4. Error sanitization — never leak internals

```typescript
// Phase 5 must generate error middleware
app.onError((err, c) => {
  const correlationId = c.get('correlationId') ?? 'unknown';

  // LOG the full error (for operators)
  console.error(JSON.stringify({
    level: 'error',
    correlationId,
    error: err.message,
    stack: err.stack,
    path: c.req.path,
    method: c.req.method,
  }));

  // RETURN sanitized error (for clients)
  const status = err instanceof HttpError ? err.status : 500;
  return c.json({
    error: status >= 500 ? 'Internal server error' : err.message,
    correlationId,
  }, status);
});
```

### 5. Telemetry spans with correlation ID

```typescript
// Phase 5 must wire correlation ID into telemetry
function withSpan<T>(name: string, correlationId: string, fn: () => T): T {
  const start = performance.now();
  try {
    const result = fn();
    console.log(JSON.stringify({
      level: 'info',
      span: name,
      correlationId,
      durationMs: Math.round(performance.now() - start),
      status: 'ok',
    }));
    return result;
  } catch (err) {
    console.error(JSON.stringify({
      level: 'error',
      span: name,
      correlationId,
      durationMs: Math.round(performance.now() - start),
      status: 'error',
      error: err instanceof Error ? err.message : String(err),
    }));
    throw err;
  }
}
```

### 6. Basic metrics endpoint

```typescript
// Phase 5 must generate a /metrics endpoint for Prometheus
const metrics = {
  requestCount: 0,
  errorCount: 0,
  latencySum: 0,
  circuitBreakerTrips: 0,
};

app.get('/metrics', (c) => {
  return c.text([
    `# HELP http_requests_total Total HTTP requests`,
    `# TYPE http_requests_total counter`,
    `http_requests_total ${metrics.requestCount}`,
    `# HELP http_errors_total Total HTTP errors`,
    `# TYPE http_errors_total counter`,
    `http_errors_total ${metrics.errorCount}`,
    `# HELP circuit_breaker_trips_total Circuit breaker trips`,
    `# TYPE circuit_breaker_trips_total counter`,
    `circuit_breaker_trips_total ${metrics.circuitBreakerTrips}`,
  ].join('\n'));
});
```

## Consequences

- (+) Every ERP write traces back to simulation inputs — full decision lineage
- (+) Tampered simulation inputs detected before writeback
- (+) Operators see full errors; clients see sanitized messages
- (+) Distributed tracing via correlation ID in all spans
- (+) Prometheus metrics enable alerting and dashboards
- (-) Lineage chain requires 3 JOINs for full trace — index carefully
- (-) Content hashing adds ~1ms per simulation run (negligible)

## Audit References

- SI-1: No simulation engine exists
- SI-2: No lineage chain from decision to simulation
- SI-3: Risk assessment empty
- SI-4: No immutability proof
- SI-5: No execution gating on writeback
- OB-1: Error messages leak internals
- OB-2: Errors not logged
- OB-3: Auth errors missing correlation ID
- OB-4: Telemetry spans orphaned
- OB-5: No metrics
