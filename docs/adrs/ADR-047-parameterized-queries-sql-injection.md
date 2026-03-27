# ADR-047: Parameterized Queries — Eliminate SQL Injection in Generated Code

## Status: ACCEPTED

## Date: 2026-03-27

## Context

Production audit (CQ-2) found SQL injection vulnerabilities in **all 12 generated query methods** in `dependencies.ts`. The pattern:

```typescript
// VULNERABLE — string interpolation into SQL
const result = await db.query(
  `SELECT * FROM suppliers WHERE 1=1 LIMIT ${limit} OFFSET ${offset}`,
  []  // empty params array!
);
```

This exists because the Phase 5 code generator (`ruflo-phase-executor.ts`) emits LIMIT/OFFSET via template literals instead of parameterized bindings. Zod coercion provides partial protection (coerces to number), but this is defense-in-depth failure — SQL injection must be prevented at the query layer, not the validation layer.

Additionally, `filters` parameters are explicitly discarded (`void filters;`) on all 12 query methods, making filtering non-functional.

## Decision

### 1. Fix the codegen template in Phase 5

The Phase 5 prompt that generates `dependencies.ts` must emit parameterized queries:

```typescript
// CORRECT — parameterized bindings
const result = await db.query(
  `SELECT * FROM suppliers WHERE 1=1 LIMIT $1 OFFSET $2`,
  [limit, offset]
);
```

**Implementation**: Update the Phase 5 SPARC completion prompt to include this rule:
- All SQL queries MUST use parameterized bindings ($1, $2, etc.)
- The params array MUST contain all dynamic values
- Template literal interpolation into SQL strings is FORBIDDEN
- `void filters` is FORBIDDEN — filters must be applied as WHERE clauses

### 2. Add a post-generation lint check

After Phase 5 generates code, scan for the pattern `${` inside SQL strings:

```typescript
// In phase5 post-processing
const sqlInjectionPattern = /(?:query|execute)\s*\(\s*`[^`]*\$\{/;
if (sqlInjectionPattern.test(generatedCode)) {
  throw new Error('ECLI-SEC-001: SQL injection detected in generated code');
}
```

### 3. Fix the `filters` parameter

Generated query methods must translate filters into WHERE clauses:

```typescript
// Generated pattern for filters
const whereClauses: string[] = ['1=1'];
const params: unknown[] = [];
let paramIdx = 1;

if (filters?.region) {
  whereClauses.push(`region = $${paramIdx++}`);
  params.push(filters.region);
}
// ... per-entity filter fields from DDD model

params.push(limit, offset);
const result = await db.query(
  `SELECT * FROM ${table} WHERE ${whereClauses.join(' AND ')} LIMIT $${paramIdx++} OFFSET $${paramIdx++}`,
  params
);
```

## Consequences

- (+) Eliminates SQL injection across all generated codebases
- (+) Filters actually work, enabling real query functionality
- (+) Post-generation lint prevents regression
- (-) Phase 5 prompt becomes longer (but correctness > brevity)
- (-) Existing generated projects need manual fix or re-generation

## Audit References

- CQ-2: SQL injection in all 12 query methods
- CQ-8: filters parameter explicitly discarded
- CQ-9: "By ID" routes don't filter by ID
