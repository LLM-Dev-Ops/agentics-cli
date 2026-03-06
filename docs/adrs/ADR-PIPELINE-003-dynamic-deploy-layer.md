# ADR-PIPELINE-003: Dynamic Deploy Layer from DDD Model

## Status
Implemented

## Context
The deploy layer (`phase5/deploy/project/src/server/routes.ts`, `schemas.ts`, `dependencies.ts`) is a **static template** that always generates the same supply-chain endpoints regardless of the user's scenario:

- `/api/v1/inventory/levels` (inventory management)
- `/api/v1/forecasts/run` (demand forecasting)
- `/api/v1/transfers/create` (facility transfers)
- `/api/v1/procurement/create`
- `/api/v1/risk/alerts`
- `/api/v1/dashboard/facility-summary`

A user asking about "project budget drift detection for an engineering consultancy" gets inventory management routes. A user asking about "insurance claims processing" also gets inventory management routes.

The deploy layer has the highest code quality in the pipeline (Hono + Zod + DI + audit trail + risk engine), but it's the same code every time.

## Decision
Generate `routes.ts`, `schemas.ts`, and `dependencies.ts` dynamically from the DDD model's bounded contexts, commands, and queries:

1. **routes.ts**: One route group per bounded context. Each command → POST endpoint, each query → GET endpoint. Pattern: `/api/v1/{context}/{command-kebab}`
2. **schemas.ts**: One Zod schema per command (from command input fields) and one per query (from query parameters)
3. **dependencies.ts**: One repository interface per aggregate, one service per bounded context

The risk engine, audit trail, ERP client, and middleware patterns are kept — they're good patterns. But the domain-specific routes, schemas, and DI registrations must come from the DDD model.

## Files to Change
- `src/pipeline/phase4/phases/http-server-generator.ts` — currently has hardcoded supply-chain routes; rewrite to iterate DDD contexts/commands/queries
- `src/pipeline/phase4/phases/schema-generator.ts` — generate Zod schemas from DDD command inputs
- Keep the risk-engine, middleware, health, and deployment scaffolding as reusable patterns

## Consequences
- Every scenario gets domain-specific API routes matching its bounded contexts
- Zod schemas match the actual command/query inputs from the DDD model
- DI container wires repositories for the detected aggregates, not hardcoded ones
- The deploy layer becomes the pipeline's strongest output instead of a static template
