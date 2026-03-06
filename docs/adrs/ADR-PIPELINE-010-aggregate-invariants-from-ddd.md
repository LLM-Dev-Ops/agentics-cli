# ADR-PIPELINE-010: Real Aggregate Invariants from DDD Model

## Status
Implemented

## Context
The domain codegen (`phase3/phases/domain-codegen.ts`) generates aggregate classes with an invariant check method per invariant, but every check is the same trivial null guard:

```typescript
private _checkInvariant1(): boolean {
  return this.turnaroundDelay != null;
}
```

The DDD model provides descriptive invariant strings like "TurnaroundDelay must be in a valid state", "Flight must have a valid gate assignment", etc. These are human-readable specifications that should drive the invariant implementation, but the codegen ignores the content and emits a null check for every invariant.

In the `081f90a2` run, the `TurnaroundDelayAggregate` has invariant "TurnaroundDelay must be in a valid state" but the check is just `this.turnaroundDelay != null` — this validates nothing meaningful.

## Decision
Generate invariant checks that reflect the DDD model's invariant descriptions:

1. **Parse invariant strings** for common patterns:
   - "must not be negative" → `this.value >= 0`
   - "must not be empty" → `this.field.length > 0`
   - "must have a valid X" → `this.x != null && this.x !== ''`
   - "must be in a valid state" → `this.status !== undefined && VALID_STATES.includes(this.status)`
   - "must not exceed X" → `this.field <= MAX_VALUE`
2. **Include entity and VO fields** in the aggregate constructor so invariants can reference them
3. **Generate typed fields** from `agg.entities` and `agg.valueObjects` instead of a single untyped root reference
4. **Emit the invariant description as a comment** above each check for traceability

## Files to Change
- `src/pipeline/phase3/phases/domain-codegen.ts` — update `tsAggregate()` and `rustAggregate()` to generate typed fields from entities/VOs and parse invariant strings into meaningful checks

## Consequences
- Aggregate invariant checks enforce real domain rules, not just null checks
- Entity and VO fields are typed properties on the aggregate
- Invariant descriptions from the DDD model are preserved as code comments
- When Ruflo swarm has an LLM backend, the implementation prompts (ADR-004) provide even richer context for full invariant logic
