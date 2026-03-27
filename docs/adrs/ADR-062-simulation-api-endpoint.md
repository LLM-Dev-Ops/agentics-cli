# ADR-062: Generate /api/v1/simulate Endpoint That Invokes Rust Optimizer

## Status: ACCEPTED

## Date: 2026-03-27

## Context

Audit (SI-CRITICAL): "Optimizer is disconnected from API. A client cannot trigger a simulation through the API. The Rust engine and TypeScript server are two independent programs that do not communicate."

ADR-052 added simulation read endpoints (GET /simulation/scenarios, /cost-model) that read pre-computed results from simulation-context.json. ADR-057 generated the Rust optimizer with a TypeScript bridge (optimizer-bridge.ts). But NO route endpoint calls the bridge. The Rust engine is unreachable from the API.

## Decision

### 1. Generate POST /api/v1/simulate endpoint

Phase 4 `tsRoutes()` must generate a simulation execution endpoint when Rust optimizer is present:

```typescript
app.post('/api/v1/simulate', requireRole('writer', 'admin'), async (c) => {
  const correlationId = c.get('correlationId') as string;
  const actor = claims['sub'];
  try {
    const body = await c.req.json();
    // Validate input against OptimizerInput schema
    const input = SimulateInputSchema.safeParse(body);
    if (!input.success) return c.json(validationError(correlationId, input.error.issues), 400);

    // Invoke Rust optimizer via subprocess bridge
    const result = await runOptimizer(input.data);

    // Store result with input hash for lineage
    const inputHash = hashSimulationInputs(input.data);
    await deps.audit.log('simulation', correlationId, 'simulate:completed', actor, {
      inputHash,
      scenarioCount: result.scenarios.length,
      recommended: result.recommended,
    });

    return c.json({
      correlationId,
      status: 'completed',
      data: result,
      lineage: { inputHash, simulationId: correlationId },
    }, 200);
  } catch (err) {
    await deps.audit.log('simulation', correlationId, 'simulate:failed', actor, { error: String(err) });
    return c.json(serverError(correlationId, err.message), 500);
  }
});
```

### 2. Generate Zod schema for simulation input

Phase 4 `tsSchemas()` must generate `SimulateInputSchema`:

```typescript
export const SimulateInputSchema = z.object({
  suppliers: z.array(z.object({
    id: z.string(),
    name: z.string(),
    region: z.string(),
    carbon_maturity: z.enum(['LOW', 'MEDIUM', 'HIGH']),
    annual_emissions_tonnes: z.number(),
    reliability_score: z.number().min(0).max(1),
    annual_cost: z.number(),
  })),
  edges: z.array(z.tuple([z.number(), z.number(), z.object({
    material: z.string(),
    volume_pct: z.number(),
    lead_time_days: z.number(),
    switching_cost: z.number(),
  })])),
  strategies: z.array(z.object({
    id: z.string(),
    name: z.string(),
    strategy_type: z.enum(['upgrade', 'replacement', 'dual_source']),
    target_supplier_id: z.string(),
    replacement_supplier_id: z.string().nullable(),
    description: z.string(),
  })),
  weights: z.object({
    cost: z.number(),
    emissions: z.number(),
    resilience: z.number(),
    complexity: z.number(),
  }).optional(),
});
```

### 3. Import optimizer-bridge in routes.ts

```typescript
import { runOptimizer } from '../services/optimizer-bridge.js';
```

### 4. Only generate when Rust optimizer exists

Detection: `requiresRustOptimizer(scenarioQuery)` — same check as ADR-057.

## Consequences

- (+) The Rust optimizer is now reachable through the API
- (+) Simulation results carry lineage (input hash) from the moment of execution
- (+) Audit trail captures every simulation run with actor identity
- (-) Requires Rust binary to be built (`cargo build --release`) before endpoint works
- (-) Subprocess invocation adds ~100ms latency per simulation call

## Audit References

- SI-CRITICAL: Optimizer disconnected from API
- SI-CRITICAL: No simulation execution endpoint
- ARCH-HIGH: Rust/TS integration exists but not connected
