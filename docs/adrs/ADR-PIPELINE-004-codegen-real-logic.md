# ADR-PIPELINE-004: Codegen Layer — Real Aggregate Logic via Swarm Prompt

## Status
Implemented

## Context
The codegen layer (`phase5/codegen/project/src/{context}/domain/`) produces correctly structured DDD files (aggregates, commands, queries, events, ports) but every file is a stub:

- Aggregates: invariant check is `this.entity != null`
- Commands: merge input with empty object and save
- Queries: `findById` with no filtering logic
- Events: type alias only, no payload validation

The template generators produce structure, but the Ruflo swarm + 110 agentics agents should fill in business logic. Currently the implementation prompt tells them to "write REAL business logic" but the templates they receive are already committed stubs — the swarm has no mechanism to overwrite them.

## Decision
Instead of generating stub TypeScript files, generate **implementation task prompts** per bounded context that tell the Ruflo swarm exactly what to implement:

1. For each bounded context, generate a `{context}-implementation.md` file containing:
   - The aggregate with its invariants (from DDD model)
   - The commands with their pre/post conditions
   - The queries with expected return shapes
   - The domain events with their payloads
   - The ports/adapters needed
   - The ADR constraints that apply to this context
   - The test cases from the TDD plan for this context

2. The Ruflo swarm receives these per-context prompts as task descriptions and generates the actual TypeScript files.

3. If Ruflo has no LLM backend (current env), the template generators still produce the structural stubs as a fallback — but the per-context prompts are preserved for future use.

## Files to Change
- `src/pipeline/phase5-build/phases/domain-codegen.ts` — generate per-context implementation prompts alongside (or instead of) stubs
- `src/pipeline/ruflo-phase-executor.ts` — create one Ruflo task per bounded context (not one task per layer)

## Consequences
- Each bounded context gets a focused implementation prompt with all relevant constraints
- Ruflo swarm tasks are scoped per context, not per layer (backend/frontend/middleware)
- When Ruflo has an LLM backend, it produces real implementations instead of overwriting stubs
- Fallback stubs still exist for environments without LLM access
