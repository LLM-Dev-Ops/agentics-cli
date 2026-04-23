# ADR-PIPELINE-091: Ruflo Local-Swarm as PRIMARY Execution Path for Engineering Artifacts

**Status:** Proposed
**Date:** 2026-04-23
**Priority:** HIGH — Remote `agentics.dev` diligence agents are not, and should never have been, the load-bearing path for SPARC specifications, ADRs, DDD bounded contexts, TDD plans, coverage-gap lists, or implementation prompts. Those artifacts belong to a local execution path whose dependencies are the user's own Claude Code session plus the `ruflo` binary — not a third-party Cloud Run fleet that can return HTTP 503 at any time for reasons unrelated to the engineering task. This ADR inverts the autochain's execution policy: the local Ruflo swarm is the **primary** producer of engineering artifacts, and remote diligence agents are **optional enrichment**.
**Originating Trace:** `dacf7975-1e80-413d-88d8-2fcba9a758be` — four remote agents returned 503, the user's `.agentics/plans/{sparc,adrs,ddd,prompts}/` tree was left effectively empty, and the executive summary reported "precision: 50%" — a number that conflated remote fleet availability with pipeline engineering quality and misled a board-level reviewer into concluding the pipeline was broken when the only actual problem was an architecturally misplaced dependency.
**Supersedes:** The implicit policy in `phase3-sparc-coordinator.ts` and `phase4-adrs-coordinator.ts` that treats remote `diligence-artifacts/*` agents as required inputs.
**Builds on:** ADR-PIPELINE-089 (Phase 1 health gate), ADR-PIPELINE-088 (MCP fast-return), ADR-PIPELINE-081 (adapter/repo pattern), ADR-PIPELINE-028 (guaranteed ADR generation).

## Context

The agentics-cli autochain mixes two fundamentally different kinds of agent invocation, and the project has been treating them as if they were the same:

1. **Query-answering multi-agent combos.** The 33 combos documented in `CLAUDE.md` — `cost-analysis`, `security-scan`, `red-team`, `latency-debug`, `compliance-review`, etc. — dispatch 2-5 remote agents in parallel to produce advisory answers to user questions. They are inherently remote-dependent. The remote agents ARE the product.

2. **Engineering-artifact generation.** The pipeline's SPARC specs, ADRs, DDD bounded contexts, TDD plans, coverage-gap lists, and implementation prompts. These produce concrete files the autochain writes into the user's `.agentics/plans/` tree. Until this ADR, the autochain has treated these as remote-dependent too — relying on `diligence-artifacts/sparc-specification`, `diligence-artifacts/sparc-merge`, `diligence-artifacts/adr-generation`, and `quality-engineering/coverage-gap-detect` as the primary source of content.

That conflation is the root defect. Engineering artifacts do not belong to a remote fleet's availability. The project **already ships** a local executor purpose-built for this path: `src/pipeline/ruflo-phase-executor.ts` (1915 lines). It exposes `checkRufloAvailable()`, `resolveRufloBinary()`, `buildPhase3SparcTasks`, and `buildPhase4AdrDddTasks`. It runs local Ruflo agent swarms against the user's own Claude Code session. Today that executor sits mostly idle — invoked only on explicit operator request — while 503s from the remote fleet cascade into empty plans directories and misleading executive summaries.

In the `dacf7975` trace, four 503s from remote agents ran through a policy that assumed they were load-bearing. The executive summary then reported "precision: 50%" — describing the remote fleet's response rate as if it were the pipeline's engineering quality. A reviewer reading the summary concluded the pipeline itself was broken, when in fact nothing was wrong except an architecturally misplaced dependency.

## Decision

**Ruflo local-swarm is the PRIMARY execution path for engineering artifacts.** Remote `agentics.dev` diligence agents are demoted to **optional enrichment**. Remote 503s affect enrichment depth only; they do not gate artifact production.

### 1. Primary path — Ruflo always runs for engineering slots

Phase 3 (SPARC), Phase 4 (ADRs + DDD), and Phase 5a (coverage gaps + implementation prompts) ALWAYS invoke the local Ruflo swarm as their primary executor. The coordinators at `phase3-sparc-coordinator.ts:341` and `phase4-adrs-coordinator.ts:294` call `runPrimaryPhaseExecution(phaseId, dossier, context)` on `ruflo-phase-executor.ts` before they do anything else. Ruflo output lands in the canonical run-dir paths:

- `runDir/engineering/sparc-specification.md`
- `runDir/engineering/architecture-decisions.md`
- `runDir/engineering/domain-model.md`
- `runDir/engineering/tdd-test-plan.md`
- `runDir/engineering/implementation-roadmap.md`

Per ADR-092, these are Ruflo's canonical engineering-output directory. Phase 3 and Phase 4 coordinators refine this content into structured per-phase directories (`runDir/phase3/sparc/`, `runDir/phase4/adrs/`, `runDir/phase4/ddd/`) when refinement improves it; when refinement is unnecessary, the engineering-dir artifacts stand on their own and ADR-092's promotion contract lifts them into `.agentics/plans/` unchanged.

Ruflo receives as input:
- the Phase 1 dossier (whatever content arrived),
- the Phase 2 research dossier if available,
- the user's project context (workspace tree, prior ADRs, CLAUDE.md).

It runs against the user's own LLM session (Claude Code's logged-in Anthropic session). It does NOT depend on the remote fleet.

### 2. Remote diligence agents become optional enrichment

The remote agents `diligence-artifacts/sparc-specification`, `diligence-artifacts/sparc-merge`, `diligence-artifacts/adr-generation`, and `quality-engineering/coverage-gap-detect` continue to run IN PARALLEL with Ruflo, but their output is now fed to Ruflo as **additional dossier context** rather than consumed as the primary artifact source. When they succeed, they enrich Ruflo's generation with industry data, regulatory citations, benchmark references, and cross-domain patterns. When they 503, Ruflo proceeds without the enrichment; the artifacts are still produced.

The distinction matters for reporting:

- **Engineering tier** = which executor produced the artifacts. Under this ADR, `ruflo-local` on the normal path, `template` on the last-resort path (§3).
- **Enrichment depth** = fraction of remote enrichment agents that succeeded. When 12/16 remote agents succeed, enrichment depth is 75%. When 0/16 succeed, enrichment depth is 0%. Neither affects the engineering tier.

Reporting these as two independent signals ends the conflation the `dacf7975` executive summary fell into.

### 3. Deterministic templates remain — but as last-resort only

The existing deterministic template generators at `phase4-adrs-coordinator.ts:301-376` (ADRs) and `:394-475` (DDD), plus a parallel template path for SPARC and for coverage-gap lists, are retained. Their invocation trigger changes: they fire **only** when `checkRufloAvailable()` returns false — i.e., no Ruflo binary, no LLM session, no local execution capability at all. Tagged as `execution_tier: "template"` in the manifest.

Under normal operation in a user's development environment, Ruflo is available and templates never fire. In CI environments without LLM sessions (or when `AGENTICS_DISABLE_RUFLO=true` is explicitly set), templates fire as a degraded-but-deterministic last resort so the pipeline never produces empty output.

### 4. Invariant — non-empty engineering artifacts

Regardless of which executor produced the output (Ruflo-primary or template-last-resort), the invariant is unchanged: downstream phases always see non-empty SPARC + ADR + DDD + coverage + prompts content. An `assertDownstreamInputs()` check between Phase 4 and Phase 5a enforces this. Violation is a loud failure (see ADR-093), not a silent skip.

### 5. Manifest reporting — execution tier and enrichment depth as separate signals

`manifest.json` gains an `execution` block:

```json
{
  "traceId": "dacf7975-...",
  "execution": {
    "engineering_tier": "ruflo-local",
    "tier_counts": { "ruflo-local": 5, "template": 0 },
    "enrichment": {
      "remote_agents_available": ["competitive-analysis", "regulatory-citations", "industry-benchmarks", "market-sizing"],
      "remote_agents_errored":  ["sparc-specification", "sparc-merge", "adr-generation", "coverage-gap-detect"],
      "enrichment_depth_pct":    75
    }
  }
}
```

Consensus and executive-summary rendering consume this block:

- Executive summary reports `engineering_tier` (e.g., "All engineering artifacts produced via local Ruflo swarm") as a first-class quality signal.
- Executive summary reports `enrichment_depth_pct` as a separate, secondary signal ("4 of 16 remote enrichment agents were unavailable; artifacts produced without their supplementary context").
- No more conflating "75% remote availability" with "50% pipeline precision".

### 6. Edge cases

- **Ruflo timeout.** Wall-clock budget per phase defaults to 600s, overridable via `AGENTICS_RUFLO_PHASE_TIMEOUT`. Exceeding the budget demotes that phase to template-tier with `reason: "ruflo-timeout"`.
- **Ruflo self-dispatch avoidance.** Ruflo tasks are built with `--local-only` so the local swarm does not re-call the same remote backends it is supposed to be independent of. The task-builder functions enforce this.
- **Partial remote enrichment.** When some remote enrichment agents succeed and others 503, Ruflo consumes the successful ones as dossier context and ignores the missing ones. `enrichment_depth_pct` reflects the partial coverage.
- **User LLM session unavailable (CI).** When `checkRufloAvailable()` returns false, templates fire and manifest records `engineering_tier: "template"`. Accepted degraded mode for CI; loud-failure path (ADR-093) catches the case where templates also fail.

## Consequences

### Positive

- **503s on remote agents stop blocking the pipeline.** The user's `.agentics/plans/` tree is always populated with Ruflo-generated engineering artifacts regardless of remote fleet availability. The `dacf7975` class of failure stops existing.
- **Artifact quality is decoupled from remote fleet availability.** Executive summary reports pipeline quality based on what Ruflo produced, not what the remote fleet returned. Board-level readers get an honest signal.
- **The Ruflo investment (1915 lines of `ruflo-phase-executor.ts`) is used on its intended path.** Today it's dormant except on explicit operator request; under this ADR it's the default engineering executor.
- **Cleaner separation of concerns.** Remote agents → advisory / query-answering. Ruflo → engineering-artifact generation. Two different mechanisms for two different kinds of work, each with dependencies that match what it is.
- **Deterministic baseline.** When Ruflo unavailable (CI), templates still produce artifacts. The pipeline never silently produces empty output.

### Negative / accepted tradeoffs

- **Ruflo costs the user's LLM tokens.** Every run now spends 150k-400k tokens on the user's Claude Code session to generate SPARC + ADRs + DDD + prompts. Previously these tokens were spent on the remote fleet (agentics.dev's quota). This is a cost-shift from SaaS quota to user session. Acceptable because (a) the remote quota doesn't belong to the user, (b) Ruflo-quality output is more tightly tied to the user's project context than the remote fleet's generic dataset, (c) the user can cap spend via `AGENTICS_RUFLO_PHASE_TIMEOUT`.
- **Wall-clock runtime increases.** Ruflo-primary runs take 4-12 minutes vs 2-4 for a healthy remote-primary run. Mitigated by parallelizing Ruflo tasks across phases where the DAG allows.
- **Loss of agentics.dev's curated knowledge base** unless it flows in as enrichment. Remote agents have cross-domain training and regulatory datasets; Ruflo has only the user's session. Enrichment-when-available bridges this — a healthy remote fleet still improves outputs, it just no longer gates them.
- **Users on weaker LLM models get weaker Ruflo output.** A user on Haiku gets different quality than Opus. `engineering_tier` + session model are both surfaced in the manifest so reviewers can weight.

### Neutral

- `manifest.json` gains an `execution` block. Backwards compatible — readers that don't know about it ignore it; `agentics status` treats missing as pre-091 behaviour.
- **No change to the 33 query-answering multi-agent combos documented in CLAUDE.md.** Those remain remote-primary because that is their design. This ADR touches only the engineering-artifact path.
- No change to Phase 1 consensus / Phase 2 deep research; those legitimately depend on the remote fleet and keep their current execution model.

## Implementation plan

No code in this ADR. The landing PR touches:

- **`src/pipeline/auto-chain.ts`** — invert the Phase 3/4/5a execution order so Ruflo runs first and remote enrichment (when available) feeds into it rather than the other way around. Add the `execution` block writer to the manifest.
- **`src/pipeline/ruflo-phase-executor.ts`** — expose `runPrimaryPhaseExecution(phaseId, dossier, context, timeout)` as the canonical entry point used by both auto-chain and the dependency gate (ADR-093). Ensure all task-builders pass `--local-only`. Add `buildCoverageGapTasks` and `buildImplPromptsTasks` alongside the existing Phase 2/3/4 builders.
- **`src/pipeline/phase3-sparc/phase3-sparc-coordinator.ts`** — the coordinator becomes a Ruflo-output refiner rather than a primary generator. Accepts Ruflo output at `runDir/engineering/sparc-specification.md`, refines into `runDir/phase3/sparc/`. Its own LLM path is removed as duplicate work.
- **`src/pipeline/phase4-adrs/phase4-adrs-coordinator.ts`** — same pattern. Refines Ruflo's `runDir/engineering/architecture-decisions.md` into structured `runDir/phase4/adrs/ADR-*.md`. The existing template paths at `:301-376` and `:394-475` remain as the `checkRufloAvailable() === false` branch only.
- **`src/renderers/executive-docs/*`** — consume the `execution` block. Report `engineering_tier` and `enrichment_depth_pct` separately. No more unified "precision" number that conflates the two.
- **Config / env surface:**
  - `AGENTICS_RUFLO_PHASE_TIMEOUT` (default 600000 ms) — per-phase wall-clock budget.
  - `AGENTICS_DISABLE_RUFLO` (default false) — operator escape hatch for CI. When true, skip Ruflo entirely and use templates. When false but Ruflo unavailable, fall through naturally to templates.

## Verification

1. **Force 503s on all four diligence agents — assert Ruflo still produced everything.** Run `agentics ask` end-to-end with the four remote agents mocked to 503. Assert `.agentics/plans/sparc/`, `plans/adrs/`, `plans/ddd/`, `plans/prompts/` all contain content. Assert `manifest.execution.engineering_tier === "ruflo-local"`. Assert executive summary does NOT mention "precision: 50%" — reporting instead `engineering_tier: "ruflo-local"` and `enrichment_depth_pct: 0`.

2. **Healthy remote fleet — Ruflo still primary, enrichment is 100%.** Run with all remote agents healthy. Assert `manifest.execution.engineering_tier === "ruflo-local"` (remote output was consumed as enrichment, not as primary). Assert `enrichment_depth_pct === 100`. Assert Ruflo received the remote content as additional dossier context.

3. **Ruflo unavailable.** Disable Ruflo via `AGENTICS_DISABLE_RUFLO=true`. Rerun. Assert `engineering_tier === "template"`. Assert artifacts still produced via deterministic templates. Assert no executive-summary quality degradation beyond the template-tier tag.

4. **Mixed: some remote enrichment agents succeed, others 503.** Assert `enrichment_depth_pct` correctly reflects e.g. 12/16 → 75%. Assert Ruflo received the 12 that arrived and ignored the 4 that didn't.

5. **Honest executive reporting.** Assert a run that lost all 16 remote enrichment agents but completed via Ruflo-local reports `engineering_tier: "ruflo-local"` without a precision penalty. The reviewer's board-level signal is not corrupted by remote fleet flakes.

6. **No regression on the 33 query-answering combos.** The `agentics ask "how much am I spending"` path must still dispatch remote agents per the CLAUDE.md multi-agent combo table. This ADR changes only the engineering-artifact path.

7. **No regression on ADR-089 / 088 / 087.** Phase 1 health gate still classifies, MCP fast-return still works, agent name resolver still 12/12.

## Related decisions

- **ADR-PIPELINE-092** — promotion completeness (companion). Promotes Ruflo's primary output (in `runDir/engineering/`) into `.agentics/plans/` alongside any structured phase-refined outputs.
- **ADR-PIPELINE-093** — phase-dependency gates (companion). Gates verify that the primary executor (Ruflo) has produced its outputs before downstream phases run; on miss, they invoke the same Ruflo entry point to fill the gap.
- **ADR-PIPELINE-089** — Phase 1 health gate + retry widening. The `degraded` verdict it defines no longer cascades into empty engineering output, because engineering output is no longer gated on remote fleet health.
- **ADR-PIPELINE-088** — MCP fast-return status.json. Extended with the `execution` block.
- **ADR-PIPELINE-081** — adapter/repo pattern. Ruflo executor follows this pattern so alternative local-swarm providers can slot in.
- **ADR-PIPELINE-028** — guaranteed ADR generation. Honored via a dependency chain that does not require remote agents.

## References

- Trace `dacf7975-1e80-413d-88d8-2fcba9a758be` — the originating failure. Under this ADR, the same trace would produce complete engineering artifacts with `engineering_tier: "ruflo-local"` and `enrichment_depth_pct: 75` (12/16 remote enrichment agents succeeded) — not a "precision: 50%" executive summary.
- `src/pipeline/ruflo-phase-executor.ts` (1915 lines) — primary-executor surface.
- `src/pipeline/phase3-sparc/phase3-sparc-coordinator.ts` (537 lines) — refactored as a Ruflo-output refiner.
- `src/pipeline/phase4-adrs/phase4-adrs-coordinator.ts` (564 lines) — same; existing templates retained as the Ruflo-unavailable branch.
- `CLAUDE.md` multi-agent combos — unchanged. Query-answering remains remote-primary.
