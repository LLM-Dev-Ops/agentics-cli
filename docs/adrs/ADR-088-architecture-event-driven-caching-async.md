# ADR-088: Architecture Gaps — Cross-Context Events, Caching, Async Processing

## Status: IMPLEMENTED

## Date: 2026-04-01

## Context

Production readiness audit (2026-04-01) scored Architecture 7/10 with four gaps:

1. **Direct type imports across bounded contexts** (-1.0): The scenario-engine context imports `Region` directly from facility-energy context. In DDD, bounded contexts communicate via events or published language, not direct imports. While acceptable for a prototype, this creates coupling that prevents independent deployment.

2. **Rust optimizer referenced but not present** (-1.0): ADR-009 specifies a Rust compute engine, but only TypeScript implementation exists. The pipeline's Rust optimizer generator (ADR-057/073) should produce this when detected.

3. **Caching tiers not implemented** (-0.5): The Refinement phase documents Redis/CDN caching for simulation results and facility data, but no caching exists in the generated code.

4. **No async job processing** (-0.5): Long-running simulations run synchronously in the request handler. For production, they should be queued and processed asynchronously.

### Target: 10/10 Architecture

## Decision

### 1. Published Language for cross-context types

Instead of direct imports, shared types go into a `shared/published-language.ts` module:

```typescript
// src/shared/published-language.ts
// Types published by facility-energy context for consumption by other contexts
export interface PublishedRegion {
  readonly id: string;
  readonly name: string;
  readonly emissionFactor: number;
}
```

Other contexts import from `shared/published-language.ts`, not from each other's internal types. The codegen template must generate this shared module when multiple bounded contexts exist.

### 2. Rust optimizer detection and generation

The pipeline already has a Rust optimizer generator (ADR-057/073). The codegen prompt must:
- Detect when the scenario query mentions "Rust", "compute engine", "optimization", "graph analysis"
- Generate the Rust optimizer engine alongside the TypeScript code
- Wire the TypeScript bridge (`optimizer-bridge.ts`) to the Rust subprocess

This is already implemented in the pipeline — the issue is that the energy emissions prompt didn't trigger Rust detection. The detection heuristic should be broadened to include "multi-objective optimization", "Pareto", "large-scale simulation".

### 3. In-memory caching for simulation results

Add a simple TTL cache for expensive computations:

```typescript
class SimpleCache<T> {
  private cache = new Map<string, { value: T; expiresAt: number }>();

  get(key: string): T | undefined {
    const entry = this.cache.get(key);
    if (!entry || Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: T, ttlMs: number = 300_000): void {
    this.cache.set(key, { value, expiresAt: Date.now() + ttlMs });
  }
}
```

Cache simulation results and facility data lookups. Invalidate on write operations. For Cloud Run (stateless instances), this is per-instance caching — adequate for the pilot.

### 4. Async simulation processing

For simulations taking >5 seconds, return 202 Accepted with a job ID:

```typescript
app.post('/api/v1/simulate', requireRole('writer', 'admin'), async (c) => {
  const parsed = SimulateInputSchema.safeParse(await c.req.json());
  // ... validation ...

  // For large simulations, queue async
  if (parsed.data.scenarios.length > 10 || parsed.data.facilities.length > 20) {
    const jobId = randomUUID();
    // Queue for async processing
    queueSimulation(jobId, parsed.data, actor);
    return c.json({ correlationId, status: 'accepted', jobId, message: 'Simulation queued for processing' }, 202);
  }

  // Small simulations run synchronously
  const result = await runSimulation(parsed.data);
  return c.json({ correlationId, status: 'completed', data: result }, 200);
});

// Poll for results
app.get('/api/v1/simulate/:jobId/status', requireRole('viewer', 'writer', 'admin'), async (c) => {
  const job = await getJob(c.req.param('jobId'));
  if (!job) return c.json({ error: 'NOT_FOUND' }, 404);
  return c.json({ status: job.status, result: job.result });
});
```

## Consequences

### Positive
- Bounded contexts can evolve independently via published language
- Rust optimizer available for compute-heavy domains
- Repeated queries served from cache, reducing database load
- Long simulations don't block the HTTP request

### Negative
- Published language module adds a coordination point for shared types
- Async processing adds polling complexity for clients
- In-memory cache doesn't share state across Cloud Run instances

## Implementation Priority

**MEDIUM — Day 3-5.** The architecture score is already 7/10 and these are scaling concerns.

## Related ADRs
- ADR-057: Rust Compute Layer Generation
- ADR-058: DDD Context Map and Domain Events
