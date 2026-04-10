# ADR-PIPELINE-060: Pipeline 10/10 Readiness Scorecard — Audit of Unimplemented Accepted ADRs

**Status:** Accepted
**Date:** 2026-04-10
**Priority:** CRITICAL — Meta-ADR that drives every other 10/10 push

## Context

The pipeline has accumulated a tail of **Accepted but unimplemented ADRs** that describe the right fixes but never landed in code. Customers now want to use the pipeline and the current output is still scoring 7.8/10, not 10/10. Before writing more design ADRs, we need a single scorecard that ties each "you said you'd fix it" ADR to the exact unchanged file+line that proves it wasn't fixed.

Hand-verified against `src/pipeline/` and `src/synthesis/` on 2026-04-10.

## Decision

Treat the following Accepted ADRs as **active open work items** until the listed code evidence disappears. No new review should lower any category score while any row below is red.

### ADR-PIPELINE-042 — Post-Generation Code Validation

**Status:** ACCEPTED 2026-04-09. **Implementation:** NONE.

- The accepted design specifies `post-generation-validator.ts` in `src/pipeline/phase5-build/phases/`.
- That file does not exist. `ls src/pipeline/phase5-build/phases/` returns only `frontend-generator.ts`, `implementation-quality-gate.ts`, `integration-inferrer.ts`, `integration-injector.ts`.
- `implementation-quality-gate.ts` is a **prompt** quality gate (scans `phase2Dir` artifacts before generation, not the generated output). See `implementation-quality-gate.ts:469` where it loads `.phase2-merged` or `phase2Dir`, not the generated project.
- Consequence: no feedback loop catches when the coding agent ignores prompt requirements. This is why regressions in observability/config/typed fields keep slipping through.

**Completes with:** ADR-PIPELINE-065 (this series).

### ADR-PIPELINE-057 — Executive Sensitivity + Confidence + Competitive

**Status:** ACCEPTED 2026-04-10. **Implementation:** PARTIAL (renderer shape only, content still wrong).

- §1 (multi-variable sensitivity tornado): `simulation-renderers.ts:2766–2792` still emits a **single-variable** loop — `for (const pct of [0.5, 0.75, 1.0, 1.25])` — which varies only "the primary improvement target". It is not a tornado across 5–6 assumptions.
- §3 (quantitative competitive positioning): `grep -rn "competitive_analysis\|capability_maturity\|peer_comparison" src/synthesis/` returns exactly one match — a comment-level LLM instruction at `simulation-renderers.ts:1293`. Neither `simulate_create` in `src/synthesis/prompts/index.ts:103–178` nor `renderExecutiveSummary` in `simulation-renderers.ts:1424–1592` emits a structured competitive section.
- §2 (directional vs precision confidence): not verified; may be landed.

**Completes with:** ADR-PIPELINE-062 (competitive), ADR-PIPELINE-063 (sensitivity).

### ADR-067 — Replace Template Code Generators with LLM-Driven Codegen

**Status:** ACCEPTED 2026-03-27. **Implementation:** PARTIAL (infrastructure exists, callers don't use it).

- `src/pipeline/phase4/phases/llm-codegen.ts` exists (197 lines) and correctly invokes `claude --print` with a prompt, falling back to `null` when the binary is unavailable.
- But `src/pipeline/phase4/phases/http-server-generator.ts` is still a **4073-line string template**. It contains verified emissions like `'const app = new Hono();'` (line 1289) and hardcoded `'  c.set(\'correlationId\', correlationId);'` (line 2190). It does not consult `generateCodeViaLLM()`.
- Consequence: the generator cannot adapt to domain signal; it emits the same shape regardless of the scenario.

**Completes with:** future ADR (not in this batch — scope larger than one week).

### Newly Identified Gaps (Not Covered by Any Existing ADR)

| Gap | Evidence | Fix ADR |
|---|---|---|
| Phase gates are 3 hardcoded generic strings | `simulation-renderers.ts:2514–2518` literal block, unquantified criteria | ADR-PIPELINE-061 |
| Generated Hono apps are untyped | `http-server-generator.ts:1289` emits `new Hono()` without `<{ Variables }>`; forces `c.get('correlationId') as string` casts at 1386, 1191, 1309, 1317, 2190 | ADR-PIPELINE-064 |

## Ongoing Rule

Any pipeline ADR with **Status: Accepted** MUST also have one of:
1. **Implementation commit** linked in a new "Implementation" section at the bottom, OR
2. **Status downgraded to Proposed** with a note explaining why it's blocked.

Without this rule, the backlog grows silently and reviewers score against stale prose instead of actual code.

## Consequences

### Positive
- Single dashboard for "what still needs to ship for 10/10"
- Every row is falsifiable against the current tree
- Prevents future ADRs from being written against problems that are already designed-for-but-unbuilt

### Negative
- Requires a one-time audit sweep whenever a new review lands
- Creates a lightweight discipline burden on anyone writing an ADR

## Related
- ADR-PIPELINE-042 (Post-Generation Code Validation — Accepted)
- ADR-PIPELINE-052 (Executive Output 9/10 — Accepted)
- ADR-PIPELINE-057 (Sensitivity + Confidence + Competitive — Accepted)
- ADR-067 (LLM Codegen Replacement — Accepted)
- ADR-PIPELINE-061–065 (this batch — the fixes)
