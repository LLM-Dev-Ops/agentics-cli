# ADR-048: Generated Bounded Contexts Must Contain Domain Logic, Not CRUD Shells

## Status: ACCEPTED

## Date: 2026-03-27

## Context

Production audit (CQ-7, SI-1, AR-4, AR-5) found that **all 12 generated bounded contexts are identical CRUD passthrough shells** with zero business logic. Every adapter is:

```typescript
// What was generated — identical across all 12 contexts
async query(filters, pagination) {
  void filters;
  return db.query(`SELECT * FROM x WHERE 1=1 LIMIT ${limit} OFFSET ${offset}`, []);
}
async execute(input) {
  const id = crypto.randomUUID();
  return db.execute(`INSERT INTO x ...`, [id, JSON.stringify(input)]);
}
```

The system's stated purpose — model supplier networks, simulate transitions, quantify tradeoffs — **does not exist in the codebase**. The domain layer is scaffolding.

Additionally:
- No domain events exist between bounded contexts (AR-5)
- No Rust optimization component was generated despite being specified (AR-4)
- No simulation engine, graph algorithms, or multi-objective optimizer exists (SI-1)
- `crypto` is never imported, causing runtime crashes on every write (CQ-1, top critical risk #2)

## Decision

### 1. Phase 5 codegen must generate domain-specific operations

The SPARC pseudocode (Phase 3) defines algorithms for each bounded context. Phase 5 must translate these into **real implementations**, not CRUD shells.

**Codegen prompt rule** (add to Phase 5 SPARC completion):
```
CRITICAL: Each bounded context adapter must implement the DOMAIN OPERATIONS
described in the SPARC pseudocode, not generic CRUD. If the pseudocode says
"calculate multi-objective tradeoff score across cost, emissions, and risk",
the adapter must contain that calculation — not SELECT * FROM tradeoffs.

Check: If every adapter has the same code structure, you have generated CRUD
shells, not domain logic. Each adapter MUST be different because each bounded
context has different business rules.
```

### 2. Phase 5 must generate the specified language components

If the user specifies "Rust for graph modeling and optimization", Phase 5 must:
- Generate a `optimizer-engine/` directory with Rust source
- Include `Cargo.toml` with appropriate dependencies (petgraph, rayon, serde)
- Generate TypeScript subprocess invocation (JSON over stdin/stdout)
- Include a Makefile or build script for the Rust component

**Codegen prompt rule**:
```
If the requirements specify a non-TypeScript language (Rust, Python, Go),
you MUST generate source files in that language for the specified components.
Do NOT substitute with TypeScript. Generate the FFI/subprocess bridge.
```

### 3. Phase 5 must generate domain events

Each bounded context must emit domain events for cross-context communication:

```typescript
// Pattern: domain event emission after state change
interface DomainEvent {
  eventId: string;
  aggregateId: string;
  eventType: string;
  payload: Record<string, unknown>;
  timestamp: string;
  correlationId: string;
}

// In each adapter's execute method:
await this.eventBus.publish({
  eventType: 'SupplierTransitionApproved',
  aggregateId: transitionId,
  payload: { supplierId, strategy, approvedBy },
  correlationId,
});
```

### 4. Fix the crypto import

Phase 5 codegen prompt must include:
```
Every file that uses crypto.randomUUID() MUST import it:
import { randomUUID } from 'node:crypto';
```

**Post-generation check**: Scan for `randomUUID` usage without matching import.

## Consequences

- (+) Generated code actually implements the user's business requirements
- (+) Each bounded context is unique, reflecting its domain role
- (+) Multi-language projects get actual multi-language code
- (+) Domain events enable the event-driven architecture described in ADRs
- (-) Phase 5 generation takes longer (more complex prompts, more output)
- (-) Requires SPARC pseudocode (Phase 3) to be high quality — garbage in, garbage out

## Audit References

- CQ-1: crypto.randomUUID() called without import — runtime crash
- CQ-7: All 12 adapters are identical CRUD passthrough
- AR-4: No Rust component generated despite being specified
- AR-5: No domain events or cross-context communication
- SI-1: No simulation engine, graph algorithms, or optimizer exists
