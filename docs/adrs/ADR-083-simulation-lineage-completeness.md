# ADR-083: Simulation Lineage Completeness — Seed Data, Creation Validation, Parameter API

## Status: IMPLEMENTED

## Date: 2026-04-01

## Context

Production readiness audit (2026-04-01) scored Simulation Alignment 7/10 with three gaps:

1. **validateLineage() not called on decision creation** (-1.5): Decisions can reference non-existent or tampered simulations. Only caught at execution time. (Overlaps with ADR-082 — this ADR covers the simulation-specific aspects.)

2. **No simulation run seed data in database** (-1.0): The generated code includes seed data for domain entities (facilities, emission factors) but no seed simulation runs. This means `validateLineage()` always fails for the first decision created because there are no simulation records to validate against.

3. **No API endpoint to view original simulation parameters** (-0.5): Users can see simulation results but cannot retrieve the exact input parameters that produced them. For audit/reproducibility, the original inputs must be queryable.

### Target: 10/10 Simulation Alignment

## Decision

### 1. Seed simulation runs in the database

The generated seed data must include at least one complete simulation run with:
- A simulation record in the database (id, inputHash, parameters, createdAt)
- Results linked to the simulation (scenarios, Pareto frontier, recommended strategy)

```typescript
// In seed.ts or dependencies.ts initialization
const seedSimulationId = 'seed-simulation-001';
const seedInputHash = hashSimulationInputs({ scenarios: ['baseline'], facilities: seedFacilityIds });
await db.execute(
  'INSERT INTO simulation_runs (id, input_hash, parameters, status, created_at) VALUES (:1, :2, :3, :4, :5)',
  [seedSimulationId, seedInputHash, JSON.stringify(seedParameters), 'completed', new Date().toISOString()],
);
```

This ensures `validateLineage()` can succeed for decisions referencing the seed simulation.

### 2. Simulation parameter retrieval endpoint

Add `GET /api/v1/simulation/runs/:id/parameters` that returns the original input parameters:

```typescript
app.get('/api/v1/simulation/runs/:id/parameters', requireRole('viewer', 'writer', 'admin'), async (c) => {
  const id = c.req.param('id');
  const run = await deps.simulation.getRunById(id);
  if (!run) return c.json({ error: { code: 'NOT_FOUND' }, correlationId }, 404);
  return c.json({ correlationId, status: 'ok', data: { id: run.id, inputHash: run.inputHash, parameters: run.parameters, createdAt: run.createdAt } });
});
```

### 3. Ensure simulation_runs table exists in schema generator

The schema generator must create a `simulation_runs` table:

```sql
CREATE TABLE IF NOT EXISTS simulation_runs (
  id TEXT PRIMARY KEY,
  input_hash TEXT NOT NULL,
  parameters TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'completed',
  created_at TEXT NOT NULL,
  result_summary TEXT
);
CREATE INDEX idx_simulation_runs_hash ON simulation_runs(input_hash);
```

The `validateLineage()` function queries this table, so it must exist at startup.

## Consequences

### Positive
- Lineage validation succeeds from the first request (seed data exists)
- Simulation parameters are auditable and reproducible
- Database schema explicitly supports simulation lineage

### Negative
- Seed data adds ~20 lines to the generated initialization code
- One additional GET endpoint to maintain

## Implementation Priority

**HIGH — Day 1-2.** Estimated effort: 4-6 hours.

## Related ADRs
- ADR-082: Governance Enforcement Wiring (lineage at creation)
- ADR-051: Simulation Lineage and Observability
