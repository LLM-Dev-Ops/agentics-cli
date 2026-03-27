# ADR-064: Runtime Schema Validation on DB Results and Proper Filter Parsing

## Status: ACCEPTED

## Date: 2026-03-27

## Context

Audit found:

- **CQ-HIGH**: ~100+ unsafe `as unknown as TYPE` casts on database rows. No runtime validation. Schema drift produces silent data corruption.
- **CQ-HIGH**: `filters` parameter in schemas is `z.string().optional()` — a raw string that is never parsed, validated, or used. Dead parameter across all endpoints.
- **CQ-HIGH**: Domain invariants exist as comments only (e.g., "price must be positive"). No runtime enforcement.
- **CQ-MEDIUM**: No JSON schema validation on optimizer output — `JSON.parse(stdout)` with no schema check.

## Decision

### 1. Phase 4 schemas must generate proper filter schemas

Replace:
```typescript
export const ListSuppliersSchema = z.object({
  filters: z.string().optional(),  // DEAD — never parsed
  limit: z.coerce.number().default(50),
  offset: z.coerce.number().default(0),
});
```

With:
```typescript
export const ListSuppliersSchema = z.object({
  status: z.string().optional(),
  region: z.string().optional(),
  limit: z.coerce.number().min(1).max(100).default(50),
  offset: z.coerce.number().min(0).default(0),
});
```

Each query schema gets entity-specific filter fields from the DDD model.

### 2. Phase 4 adapters must validate DB results with Zod

Replace:
```typescript
return rows as unknown as SupplierRecord[];
```

With:
```typescript
const RecordSchema = z.object({
  id: z.string(),
  status: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
  data: z.unknown(),
});
return rows.map(row => {
  const parsed = RecordSchema.safeParse(row);
  if (!parsed.success) {
    console.error(JSON.stringify({ level: 'error', context: 'supplier', message: 'Schema validation failed', issues: parsed.error.issues }));
    return null;
  }
  return parsed.data as SupplierRecord;
}).filter(Boolean) as SupplierRecord[];
```

### 3. Optimizer bridge must validate output schema

```typescript
const OptimizerOutputSchema = z.object({
  scenarios: z.array(z.object({
    strategy_id: z.string(),
    strategy_name: z.string(),
    emissions_reduction_pct: z.number(),
    cost_delta: z.number(),
    risk_level: z.string(),
    lead_time_impact_days: z.number(),
    reliability_score: z.number(),
  })),
  pareto_frontier: z.array(z.string()),
  recommended: z.string().nullable(),
  weights_used: z.object({ cost: z.number(), emissions: z.number(), resilience: z.number(), complexity: z.number() }),
});

// In optimizer-bridge.ts:
const parsed = OptimizerOutputSchema.safeParse(JSON.parse(stdout));
if (!parsed.success) throw new Error(`Optimizer output validation failed: ${parsed.error.message}`);
return parsed.data;
```

### 4. Domain invariants must be runtime assertions

Phase 4 `tsDependencies()` must generate invariant checks in the execute() method:

```typescript
// From DDD model invariant: "price must be positive"
if (typeof payload['price'] === 'number' && payload['price'] <= 0) {
  throw new Error('Invariant violation: price must be a positive value');
}
```

## Consequences

- (+) Schema drift caught at query time, not in production data
- (+) Filters actually work with typed parameters
- (+) Optimizer output validated before downstream processing
- (+) Domain invariants enforced at runtime, not just documented
- (-) Adds ~1ms per query for validation (negligible)
- (-) Strict validation may reject data from older schema versions (need migration)

## Audit References

- CQ-HIGH: ~100+ unsafe casts
- CQ-HIGH: filters is z.string().optional() — dead parameter
- CQ-HIGH: Domain invariants are comments only
- CQ-MEDIUM: No schema validation on optimizer output
