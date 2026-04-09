# ADR-PIPELINE-037: Codegen Service Boundary — Generated Projects Must Include a User-Facing Entry Point

**Status:** Accepted
**Date:** 2026-04-09
**Priority:** MEDIUM — Architecture scores 6.0-6.5/10; "No service boundary" cited in every evaluation

## Context

Every generated prototype is a TypeScript library — it has types, services, tests, and a barrel export in `src/index.ts`. But it has no user-facing entry point:
- No CLI runner
- No HTTP API
- No demo script that shows the full pipeline

The evaluation consistently notes: "There is no HTTP handler, CLI entry point, or API surface. For a 3-7 day pilot, add a thin CLI runner."

The SPARC architecture documents prescribe 12 microservices with event buses, but the generated code is (correctly) a monolithic library. This gap between planned and delivered architecture is never documented, causing confusion for stakeholders who read both.

## Decision

### 1. Generate `src/demo.ts` — Full Pipeline Demo

Every generated project must include a demo script that:
1. Loads seed data
2. Runs the full analysis pipeline
3. Prints formatted results to stdout (table format, not raw JSON)
4. Demonstrates the decision/approval workflow
5. Shows the ERP sync payload

Runnable via: `npx tsx src/demo.ts`

### 2. Generate `src/cli.ts` — Minimal CLI Interface

For projects that will be demonstrated to stakeholders, generate a CLI that:
1. Accepts `--analyze`, `--scenarios`, `--decide`, `--sync` subcommands
2. Outputs structured JSON or formatted tables
3. Includes `--help` with usage examples

### 3. Document Architecture Divergence

When the SPARC architecture describes microservices but the generated code is a monolith, emit an ADR in the project:

```markdown
# ADR-001: Monolithic Library for Prototype Phase

## Context
The SPARC architecture prescribes N services. For the prototype evaluation period, 
a monolithic library is appropriate because [reasons].

## Decision
Build as a single TypeScript library with clean module boundaries that can be 
decomposed into services if the pilot succeeds.
```

This preempts stakeholder confusion about the plan-vs-code gap.

## Consequences

### Positive
- Architecture score should increase from 6.0-6.5 to 7.5+
- Pilot teams have something to interact with on day 1
- Plan-to-code divergence is documented, not hidden

### Negative
- CLI/demo adds ~100-150 lines to generated output
- Architecture divergence ADR is generated boilerplate (but better than nothing)

## Implementation

Files to modify:
- Code generation templates — Emit `src/demo.ts` and optional `src/cli.ts`
- Implementation prompts — Include demo/CLI generation as a build step
