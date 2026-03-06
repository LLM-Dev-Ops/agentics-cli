# ADR-PIPELINE-009: Dynamic Zod Schemas from DDD Commands/Queries

## Status
Implemented

## Context
Phase 4 `http-server-generator.ts` has a `tsSchemas(contexts)` function (line 127) that generates Zod schemas from DDD bounded context commands and queries. However, the generated `schemas.ts` in the `081f90a2` run still contains hardcoded supply-chain schemas (`UpsertInventoryLevelSchema`, `RunForecastSchema`, `CreateTransferSchema`, `CreateProcurementSchema`) instead of airline-domain schemas.

The `tsSchemas()` function receives `DDDContext[]` but the output doesn't reflect the actual commands from the DDD model. The `routes.ts` imports these hardcoded schema names, creating a mismatch with the dynamically generated routes.

## Decision
The `tsSchemas()` function must generate Zod schemas directly from DDD command inputs and query parameters:

1. **Per command**: Create a Zod schema named `${PascalCase(cmd.name)}Schema` with fields from `cmd.input[]`
2. **Per query**: Create a Zod schema named `${PascalCase(query.name)}Schema` with fields from `query.parameters[]`
3. **Field type inference**: Map DDD field names to Zod types (`id` → `z.string().min(1)`, `quantity` → `z.number().int()`, `date` → `z.string().datetime()`, etc.)
4. **Route imports**: `tsRoutes()` must import the schema names matching the DDD commands/queries, not hardcoded names

## Files to Change
- `src/pipeline/phase4/phases/http-server-generator.ts` — rewrite `tsSchemas()` to generate one Zod schema per command/query from DDD inputs; update `tsRoutes()` schema imports to match

## Consequences
- Generated `schemas.ts` contains Zod schemas matching the actual DDD commands and queries
- Schema names correspond to domain concepts (e.g., `CreateAlertSchema`, `QueryFlightDelaySchema`)
- Route handlers import and use the correct schemas for validation
- No more supply-chain schemas appearing in airline-domain projects
