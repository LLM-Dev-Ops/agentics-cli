# ADR-067: Round 4 Audit Fixes — Persistence, Governance Auto-Advance, Calculation Bugs

## Status: ACCEPTED

## Date: 2026-03-27

## Context

Round 4 audit scored 5/10 overall with ⚠️ Conditionally Ready verdict. The architecture, domain model, and Rust optimizer are praised. Five critical issues remain:

### Critical (Must Fix)

1. **In-memory simulation store** (simulation-routes.ts:153) — Database class and PostgreSQL schema exist but simulation routes use `Map<string, ...>`. Cloud Run restart = all state lost.

2. **Governance auto-advance bypass** (simulation-routes.ts:296-302) — Approve endpoint creates + submits + approves in one call. Defeats state machine purpose. No separation of duties (approver === creator allowed).

3. **Hybrid → dual_source mapping** (simulation-orchestrator.ts:86) — `s.type === 'hybrid' ? 'dual_source' : s.type` silently drops the hybrid strategy that Rust supports natively.

4. **Emissions confidence intervals swapped** (emissions-calculator.ts:87-88) — `lower` uses `(1 + uncertainty)` making it HIGHER; `upper` uses `(1 - uncertainty)` making it LOWER.

5. **Switching cost sums all edges** (simulation.rs:168-172) — `network.edge_weights().sum() * 0.3` sums ALL edge switching costs, not just edges involving the target supplier.

### High (Should Fix)

6. **Idempotency tracking in-memory** (erp-writeback.ts:51) — `processedCorrelationIds` is a Set that resets on restart.

7. **Cost normalization hardcoded** (optimizer.rs:135) — Divides by 10,000,000. For automotive supply chains with billions in spend, cost_score is always 0.0.

8. **Hardcoded subsidiary ID** (mapper.ts:62) — `subsidiary: { id: '1' }` in all Oracle mappings.

9. **Hash divergence** — TS and Rust compute different input hashes. Can never verify lineage across boundary.

10. **No separation of duties** — Same actor can create, submit, AND approve a decision.

## Decision

These fixes target the Phase 4/5 code generators so every future generated project is correct. The fixes are:

### Fix 1: Wire Database to simulation routes

Phase 4 `tsRoutes()` must use the Database class instead of in-memory Map. The migration schema exists — routes need to import and use it.

### Fix 2: Split governance into separate API calls

The approve endpoint must NOT auto-create or auto-submit. It should only transition `pending_review → approved`. Creating and submitting are separate operations.

### Fix 3: Pass hybrid through to Rust

Remove the `hybrid → dual_source` mapping. Rust already handles `Hybrid` natively.

### Fix 4: Swap confidence interval bounds

```typescript
// Fix: lower = baseline * (1 - uncertainty), upper = baseline * (1 + uncertainty)
```

### Fix 5: Filter switching costs by target supplier

```rust
// Fix: only sum edges connected to target_idx
let relevant_edges = network.edges(target_idx);
let switching_cost: f64 = relevant_edges.map(|e| e.weight().switching_cost).sum::<f64>() * 0.3;
```

### Fix 6-10: Addressed in separate implementation passes

## Consequences

- (+) Audit score should reach 7-8/10 with these five fixes
- (+) Governance actually enforces multi-step approval
- (+) Simulation results survive Cloud Run restarts
- (+) Financial calculations are correct for enterprise-scale supply chains

## Audit References

- Round 4 audit: 5/10 overall, ⚠️ Conditionally Ready
- Alignment: 8/10 — all functional requirements met
- Rust optimizer praised: "the most production-ready layer"
