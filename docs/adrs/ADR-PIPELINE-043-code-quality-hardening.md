# ADR-PIPELINE-043: Code Quality Hardening — Close the 7.0→10 Gap in Generated Code

**Status:** Accepted
**Date:** 2026-04-09
**Priority:** HIGH — Code Quality stuck at 7.0-7.5, Observability at 6.5

## Context

The pipeline now produces excellent planning artifacts (ADRs 8.5, Executive 9.0) but the generated code still has recurring quality issues that cap scores at 7-7.5:

1. **Observability gap**: Winston/pino listed as dependency but never used. All logging is console.log. No correlation IDs, no structured JSON, no metrics endpoint.
2. **Approval workflow bugs**: Approval matching logic searches by approverId but generators initialize it to ''. No approval ever matches.
3. **Unsafe casts**: Scenario engines use `as` casts without runtime validation. Zod is in package.json but unused.
4. **Routes too fat**: API routes combine validation, orchestration, and state management in one file.
5. **Dead code**: Condition ordering bugs where broader checks shadow more specific ones.
6. **Terminology drift**: Domain model uses different names than code (SPIKE vs overconsumption).

These are all **prompt quality issues** — the implementation prompts need to be more specific about what NOT to do.

## Decision

### 1. Anti-Pattern Warnings in Every Prompt

Add to the cross-cutting footer:

```markdown
## Anti-Patterns to AVOID (evaluation checks for these):
- Do NOT use console.log for logging — use the logger from src/logger.ts
- Do NOT use `as` type casts without runtime validation
- Do NOT put business logic in route handlers — extract to service layer
- Do NOT initialize required fields to empty string '' — use proper defaults or make optional
- Do NOT list dependencies in package.json without using them
- Do NOT use catch(e: any) — narrow error types
- Do NOT shadow variables in nested callbacks
```

### 2. Structured Logging Enforcement

The foundation prompt already emits logger.ts code. Add to EVERY service prompt:

```markdown
LOGGING REQUIREMENT: This module MUST import createLogger from '../logger.js'
and log at minimum:
- Function entry: logger.info('functionName.start', { key params })
- Function exit: logger.info('functionName.complete', { durationMs, result count })
- Errors: logger.error('functionName.failed', error, { context })
```

### 3. Validation Enforcement

Add to every prompt that handles external input:

```markdown
VALIDATION REQUIREMENT: Use Zod schemas for all external input.
Define schemas adjacent to route handlers. Never pass unvalidated
input to service functions.
```

### 4. Service Layer Extraction

The API/routes prompt must specify:

```markdown
ARCHITECTURE REQUIREMENT: Route handlers must be thin.
- Route: parse request → validate with Zod → call service → format response
- Service: orchestrate domain logic → audit → return result
- Never put business logic in route handlers
```

## Implementation

Files to modify:
- `src/pipeline/auto-chain.ts` — Anti-pattern warnings in cross-cutting footer
- `src/pipeline/phase2/phases/prompt-generator.ts` — Same for Phase 2 path
