# ADR-PIPELINE-065: Post-Generation Code Validator — Implementation of ADR-PIPELINE-042

**Status:** Accepted
**Date:** 2026-04-10
**Priority:** CRITICAL — Closes feedback loop for all future 10/10 work
**Implements:** ADR-PIPELINE-042 (Accepted 2026-04-09, unimplemented as of 2026-04-10)

## Context

ADR-PIPELINE-042 specified a post-generation validation step after the coding agent finishes, checking that prompt requirements (structured logging, config, typed errors, observability, etc.) were actually implemented. **It was never built.**

Hand-verified 2026-04-10:
- `ls src/pipeline/phase5-build/phases/` returns only `frontend-generator.ts`, `implementation-quality-gate.ts`, `integration-inferrer.ts`, `integration-injector.ts`.
- The existing `implementation-quality-gate.ts` is a **pre-generation** prompt-quality gate — it scans phase2 artifacts (DDD model, SPARC spec, ADRs) BEFORE code generation to confirm the prompts contain enough domain signal. It does not inspect generated output. See line 469: `const mergedPhase2Dir = path.join(context.phase5Dir, '.phase2-merged')`.
- There is no other validator that touches the generated project tree.

Without post-generation validation, every 10/10 improvement is an open loop. The pipeline can generate the right patterns today and regress tomorrow with nobody noticing until the next manual review.

## Decision

### 1. Create `post-generation-validator.ts`

New file at `src/pipeline/phase5-build/phases/post-generation-validator.ts` with the following shape:

```typescript
export interface GeneratedCodeValidationRule {
  id: string;                    // "PGV-001"
  title: string;                 // "No `as string` casts on context reads"
  severity: 'error' | 'warn';
  appliesTo: RegExp;             // which generated files to scan
  check: (content: string, filePath: string) => ValidationFinding[];
}

export interface ValidationFinding {
  ruleId: string;
  filePath: string;
  line: number;
  message: string;
  severity: 'error' | 'warn';
}

export interface PostGenerationReport {
  readonly passed: boolean;
  readonly score: number; // 0-100
  readonly findings: ValidationFinding[];
  readonly filesScanned: number;
  readonly rulesApplied: number;
}

export async function executePostGenerationValidator(
  context: Phase5BuildContext,
): Promise<ImplementationStageOutput>;
```

### 2. Initial Rule Set (10 Rules)

These are **verified against the current generator output** and correspond to real gaps:

| ID | Rule | File Pattern | Check |
|---|---|---|---|
| PGV-001 | No `as string` casts on Hono context reads | `src/server/**/*.ts` | Match `c\.get\(['"]\w+['"]\)\s*as\s+string` |
| PGV-002 | `new Hono()` must be typed | `src/server/**/*.ts` | Match `new Hono\(\)` without `<{`; flag (ADR-PIPELINE-064) |
| PGV-003 | No hardcoded magic numbers in service files | `src/*/domain/services/**/*.ts` | Match numeric literals ≥3 digits NOT inside `z.literal()`, `z.coerce.number().default(...)`, or import/version lines |
| PGV-004 | Every state-mutating service method writes an audit entry | `src/*/application/**/*.ts` | For each `async` method containing `await repo.save`, require a nearby `audit.append(` call |
| PGV-005 | `createLogger(` must be used instead of `console.` in production code | `src/**/*.ts` (excl. `test`, `scripts`, `demo`) | Match `console\.(log\|error\|warn\|info)` |
| PGV-006 | All Express/Hono routes must be covered by a test file | `src/server/routes/**/*.ts` | For each route file, require a sibling `*.test.ts` |
| PGV-007 | Zod schemas must validate seed data at load | `src/data/seed.ts` | If file exists, require `.parse(` or `.safeParse(` call on exported arrays |
| PGV-008 | No `Record<string, unknown>` in public DTO types | `src/*/domain/types/**/*.ts` | Match `Record\s*<\s*string\s*,\s*(unknown\|any)\s*>` |
| PGV-009 | Circuit breaker implementation has state-transition tests | `src/**/circuit-breaker.ts` | If file exists, require a sibling `circuit-breaker.test.ts` with `'open'`, `'half-open'`, `'closed'` strings |
| PGV-010 | All repository interfaces have corresponding in-memory and production impls | `src/**/repositories/*.ts` | For each `Repository` interface, require ≥1 file implementing it |

### 3. Wire into Phase 5 Build Coordinator

`src/pipeline/phase5-build/phase5-build-coordinator.ts` must run the validator after `integration-injection` succeeds:

```typescript
// New stage after integration-injection
const validation = await executePostGenerationValidator(context);
stageOutputs.push(validation);
if (validation.status === 'failed') {
  // Either block the build, or emit findings as remediation prompts (see §4)
  if (process.env.AGENTICS_STRICT_POSTGEN === 'true') {
    throw new Error(`ECLI-P5-040: Post-generation validation failed: ${validation.summary}`);
  }
}
```

### 4. Remediation Prompts (Phase 2 of ADR-042)

When `severity === 'error'` findings exist AND `AGENTICS_STRICT_POSTGEN` is not set, emit a **remediation prompt** to stderr containing:
- The rule ID and message
- The file:line of each violation
- A targeted fix instruction

The remediation prompt is consumed by `ruflo-phase-executor.ts` in a follow-up pass. The phase 2 implementation is out of scope for this ADR; shipping the validator WITHOUT auto-remediation is acceptable for the first cut.

### 5. Score Calculation

```
baseScore = 100
- 10 per error finding (max deduction 70)
- 2 per warn finding (max deduction 20)
- 10 per file that fails to parse (lexer error)
score = max(0, baseScore)
passed = score >= 70
```

Matches the existing `implementation-quality-gate.ts` style (60 threshold; 70 for post-generation because errors should be rarer).

### 6. Logging

All findings are logged to stderr using the existing `console.error` pattern in `implementation-quality-gate.ts:501–519`. The structured report is attached to `ImplementationStageOutput.data`.

## Acceptance Criteria

1. File `src/pipeline/phase5-build/phases/post-generation-validator.ts` exists and exports `executePostGenerationValidator`.
2. Running Phase 5 build on a fresh generated project produces a validation report with `rulesApplied === 10` and `filesScanned > 0`.
3. All 10 rules in the initial set have a unit test covering one passing and one failing case.
4. `phase5-build-coordinator.ts` imports and invokes the validator after `integration-injection`.
5. When `AGENTICS_STRICT_POSTGEN=true`, a failing validation blocks the build with exit code set accordingly.
6. Running against the current `workspace-optimizer/` snapshot flags at least one finding from PGV-001 (`as string` casts in routes) — proves the validator catches real issues, not just greenfield output.

## Consequences

### Positive
- Closes the feedback loop that has been open since 2026-04-09
- Future 10/10 work can add rules incrementally and automatically enforce them
- Customers get a hard guarantee about what's in the generated code
- Foundational for ADR-067 (LLM codegen) — once LLM generation is wired in, the validator catches LLM regressions

### Negative
- 10 initial rules is a starting point, not a ceiling — reviewers will want to add more
- Rules scan with regexes, not AST parsing — some false positives inevitable. An AST-based validator is v2 work.
- `AGENTICS_STRICT_POSTGEN` gating means by default errors are advisory. This is intentional for initial rollout; flip to strict once rules are stable.

## Related
- **ADR-PIPELINE-042** (original post-generation validation design — this ADR is its implementation spec)
- ADR-PIPELINE-060 (10/10 Scorecard)
- ADR-PIPELINE-064 (Typed Hono — PGV-001 and PGV-002 enforce it)
- ADR-067 (LLM Codegen — validator will catch LLM regressions once wired)
