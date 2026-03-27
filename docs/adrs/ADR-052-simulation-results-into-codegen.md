# ADR-052: Wire RuVector Simulation Results and CostOps into Phase 4/5 Code Generation

## Status: ACCEPTED

## Date: 2026-03-27

## Context

Production audit (SI-1 through SI-5) found "no simulation engine exists." This is incorrect — the RuVector simulation engine runs in Pass 2, produces scenarios, risk signals, and reliability reports, and stores them in the DecisionGraph. CostOps agents run in Pass 4 and produce financial models with scenario variants.

**The problem is not missing simulation — it's a broken data bridge.** Simulation and cost results are stored in the DecisionGraph but never flow into Phase 4/5 code generators:

- `pass2-simulation.ts:192-296` — scenarios written to DecisionGraph, never consumed by Phase 4
- `pass4-governance.ts:587-695` — CostOps ScenarioVariants built, never injected into Phase 4 output
- `phase4-coordinator.ts:48-58` — 9 code generation stages run with NO cross-reference to Pass 2/4 results
- `project-materializer.ts:228-280` — copies project without CostOps/SLA instrumentation

Generated projects have zero awareness of the simulation that justified their creation.

## Decision

### 1. Pass simulation context into Phase 4 code generation

The Phase 4 coordinator must load simulation results from the DecisionGraph and make them available to all code generation stages.

**In `phase4-coordinator.ts`**, before the stage pipeline runs:

```typescript
// Load Pass 2 simulation scenarios and Pass 4 cost model from DecisionGraph
const simulationContext = loadSimulationContext(context);

interface SimulationContext {
  scenarios: Array<{
    id: string;
    name: string;
    costDelta: number;
    riskLevel: string;
    mitigationStrategy: string;
    reliability: number;
  }>;
  costModel: {
    baselineCost: number;
    scenarioVariants: Array<{ scenarioId: string; costDelta: number; explanation: string }>;
    budgetThreshold: number;
    roi: number;
  } | null;
  riskSignals: Array<{ signal: string; severity: string; source: string }>;
}
```

### 2. Phase 4 schema generator must embed simulation-derived constraints

`tsSchemas()` should generate Zod schemas with constraints derived from simulation:

```typescript
// If cost model exists, embed budget validation in schemas
if (simulationContext.costModel) {
  lines.push(`// Budget constraint from CostOps (Pass 4)`);
  lines.push(`export const BudgetThreshold = ${simulationContext.costModel.budgetThreshold};`);
}

// If risk signals exist, embed risk levels as enums
if (simulationContext.riskSignals.length > 0) {
  lines.push(`export const KnownRiskSignals = [`);
  for (const rs of simulationContext.riskSignals) {
    lines.push(`  { signal: '${rs.signal}', severity: '${rs.severity}' },`);
  }
  lines.push(`] as const;`);
}
```

### 3. Phase 4 dependencies must include simulation service port

`tsDependencies()` should generate a simulation port that wraps the stored scenarios:

```typescript
export interface ISimulationPort {
  getScenarios(): Promise<SimulationScenario[]>;
  getScenarioById(id: string): Promise<SimulationScenario | null>;
  compareScenarios(ids: string[]): Promise<ScenarioComparison>;
  getCostModel(): Promise<CostModel | null>;
}
```

With an adapter that reads from the simulation results stored during pipeline execution.

### 4. Phase 4 routes must expose simulation endpoints

`tsRoutes()` should generate read-only simulation endpoints:

```typescript
// GET /api/v1/simulation/scenarios — list all simulated scenarios
// GET /api/v1/simulation/scenarios/:id — single scenario detail
// GET /api/v1/simulation/compare?ids=a,b,c — side-by-side comparison
// GET /api/v1/simulation/cost-model — CostOps financial model
// GET /api/v1/simulation/risk-signals — risk signals from Pass 2
```

### 5. Phase 5 must embed simulation metadata in the materialized project

`project-materializer.ts` should write a `simulation-context.json` file into the generated project:

```json
{
  "simulationId": "ruvector-span-...",
  "generatedAt": "2026-03-27T...",
  "scenarios": [...],
  "costModel": {...},
  "riskSignals": [...],
  "confidenceScore": 0.88
}
```

This allows the generated project to reference its simulation lineage at runtime.

## Consequences

- (+) Generated projects contain the simulation results that justified their creation
- (+) Decision-makers can query scenarios and cost models via API
- (+) Simulation lineage is embedded in the project, not just in ~/.agentics/runs/
- (-) Phase 4 coordinator becomes more complex (loads DecisionGraph context)
- (-) Requires DecisionGraph to be populated (fails gracefully if empty)

## Audit References

- SI-1: "No simulation engine exists" — engine exists (RuVector), results not wired
- SI-2: No lineage chain — simulation context now embedded in project
- SI-4: No immutability proof — simulation-context.json is write-once at generation time
