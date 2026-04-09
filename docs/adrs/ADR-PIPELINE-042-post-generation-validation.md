# ADR-PIPELINE-042: Post-Generation Code Validation — Verify Generated Code Meets Prompt Requirements

**Status:** Accepted
**Date:** 2026-04-09
**Priority:** HIGH — Prompts specify observability/config/validation but generated code doesn't implement them

## Context

The pipeline generates detailed implementation prompts specifying:
- Structured logging with createLogger() (ADR-034)
- Configuration via environment variables (ADR-034)
- Input validation with Zod (ADR-039)
- Typed error handling (ADR-039)
- Traceability fields in domain types (ADR-033)
- Demo script and architecture ADR (ADR-037)

But the coding agent doesn't always implement these. The evaluation consistently shows 3/10 observability despite the prompts specifying it in detail. There is no feedback loop — the pipeline generates prompts, the agent writes code, and nobody checks if the requirements were met.

## Decision

### 1. Post-Generation Validation Step

After the coding agent finishes, the pipeline runs a validation checklist against the generated code:

```typescript
interface ValidationResult {
  passed: boolean;
  checks: Array<{
    name: string;
    status: 'pass' | 'fail' | 'warn';
    details: string;
  }>;
}

async function validateGeneratedCode(projectDir: string): Promise<ValidationResult>
```

### 2. Validation Checks

| # | Check | How | Severity |
|---|-------|-----|----------|
| 1 | Logger exists | `src/logger.ts` or `src/lib/logger.ts` exists | FAIL |
| 2 | Config exists | `src/config.ts` or `src/lib/config.ts` exists | FAIL |
| 3 | Logger used | ≥50% of `src/**/*.ts` files import logger | WARN |
| 4 | No `any` catches | No `catch (e: any)` or `catch (e)` without type | WARN |
| 5 | No hardcoded ports | No `listen(3000)` or `listen(8080)` without config | WARN |
| 6 | Health endpoint | `/health` route exists if Express/Fastify present | WARN |
| 7 | Demo exists | `src/demo.ts` or `src/cli.ts` exists | WARN |
| 8 | Tests pass | `npm test` exits 0 | FAIL |
| 9 | TypeScript compiles | `tsc --noEmit` exits 0 | FAIL |
| 10 | Traceability fields | Domain types include `simulationId` or `traceId` | WARN |

### 3. Remediation Prompts

When a check fails, the pipeline generates a **remediation prompt** — a targeted instruction to fix the specific gap:

```markdown
# Remediation: Missing Logger Module

The generated project is missing `src/logger.ts`. This was specified in the
implementation requirements.

Create `src/logger.ts` with:
- createLogger(service: string) → Logger
- JSON output to stderr
- Fields: timestamp, level, service, event, correlationId, data

Then update all service modules to import and use it.
```

### 4. Validation Report in Run Output

Write `validation-report.json` to the run directory:

```json
{
  "timestamp": "2026-04-09T...",
  "projectDir": "/path/to/generated",
  "passed": false,
  "checks": [...],
  "remediationPrompts": ["remediation-001-logger.md", ...]
}
```

## Consequences

### Positive
- Creates a feedback loop between prompts and generated code
- Specific gaps (observability, config, validation) get caught and remediated
- Validation report gives evaluators confidence in code completeness
- Remediation prompts are targeted fixes, not full rewrites

### Negative
- Adds validation latency after code generation
- Remediation prompts require another coding agent execution
- Some checks may produce false positives for unconventional project structures

## Implementation

Files to modify:
- New file: `src/pipeline/post-generation-validator.ts`
- `src/pipeline/auto-chain.ts` — Run validation after Phase 5
- Remediation prompt templates — One per check type
