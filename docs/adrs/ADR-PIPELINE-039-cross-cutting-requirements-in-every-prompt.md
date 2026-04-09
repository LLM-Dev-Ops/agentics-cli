# ADR-PIPELINE-039: Cross-Cutting Requirements in Every Domain Prompt — Not Just Dedicated Prompts

**Status:** Accepted
**Date:** 2026-04-09
**Priority:** CRITICAL — Observability scores 3/10 despite ADR-034 specifying it; coding agent skips standalone cross-cutting prompts

## Context

ADR-034 added a detailed observability prompt with logger patterns, correlation IDs, and error handling. The coding agent still produces code with zero logging. The same pattern repeats for configuration (ADR-034), input validation, and error types.

Root cause: cross-cutting requirements are in **separate prompts** (e.g., "Build: Observability & Structured Logging"). The coding agent prioritizes domain logic prompts and deprioritizes or skips the cross-cutting ones. This is an inherent limitation of multi-prompt sequential execution — later prompts have less budget/priority.

## Decision

### 1. Embed Cross-Cutting Requirements in Every Domain Prompt

Every implementation prompt that says "Build: [Domain Module]" must include a mandatory footer section:

```markdown
## Mandatory Cross-Cutting Requirements (every module)

1. **Logging**: Import and use `createLogger(moduleName)` from `src/logger.ts`.
   Log: function entry with parameters, completion with duration, errors with stack.
   Every log entry must include `correlationId` when available.

2. **Configuration**: Import config from `src/config.ts`. Never hardcode:
   URLs, ports, thresholds, weights, API keys, timeouts.

3. **Input Validation**: Validate all public function parameters at entry.
   Use Zod schemas or manual checks. Return typed errors, never throw untyped.

4. **Error Types**: Define module-specific error types extending a base AppError.
   Never `catch (e: any)`. Always narrow error types.

5. **Traceability**: All domain types that represent decisions or actions must
   include optional `simulationId` and `traceId` fields.
```

### 2. Generate Logger and Config as Foundation Dependencies

The "Project Foundation & Core Types" prompt (always prompt 001) must emit `src/logger.ts` and `src/config.ts` as its **first deliverables**, before any domain types. This ensures they exist when domain prompts reference them.

### 3. Post-Generation Validation Checklist

After all prompts are executed, the pipeline should verify:
- [ ] `src/logger.ts` exists and exports `createLogger`
- [ ] `src/config.ts` exists and exports typed config
- [ ] Every `src/**/*.ts` file imports from logger or has `// no-logging-required` comment
- [ ] No `catch (e: any)` patterns in generated code
- [ ] No hardcoded ports, URLs, or API keys

## Implementation

Files to modify:
- `src/pipeline/auto-chain.ts` — Append cross-cutting footer to every prompt
- `src/pipeline/phase2/phases/prompt-generator.ts` — Same for Phase 2 path
- Foundation prompt template — Require logger.ts + config.ts as first outputs
