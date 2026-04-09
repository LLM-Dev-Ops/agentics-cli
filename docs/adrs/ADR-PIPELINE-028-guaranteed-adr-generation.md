# ADR-PIPELINE-028: Guaranteed ADR Generation — Phase 4 Must Never Produce Empty Output

**Status:** Accepted
**Date:** 2026-04-09
**Priority:** CRITICAL — ADRs missing in 3 consecutive test runs (water utility, sustainability, packaging)

## Context

Phase 4 (ADRs + DDDs) has failed to produce output in every test run evaluated. The failure chain:

1. `executePhase4Command()` requires Claude binary or Anthropic API key for LLM-based ADR generation
2. In CI/automated environments, neither is reliably available
3. The template fallback in `phase4-adrs-coordinator.ts` calls `buildPhase2ADRs(sparc, dossier)` **without the query parameter**, producing generic or empty ADRs
4. When Phase 4 fails, the auto-chain recovery path looks for `phase2/adrs/adr-index.json` which doesn't exist in the `agentics ask` flow
5. Phase 4.5 (prompt generation) reads from empty `phase4/adrs/` → all prompts get `"relatedADRs": []`
6. Phase 5 fails: "Phase 4 manifest not found"
7. The evaluation scores Governance at 5.5-7.0 and notes "zero ADRs written"

This is the single most-cited deficiency across all three evaluations. It undermines governance, traceability, and executive confidence.

## Decision

### 1. Three-Tier ADR Generation with Guaranteed Output

ADR generation MUST succeed in every pipeline run. Implement three tiers with automatic fallthrough:

| Tier | Method | Requires | Quality | Latency |
|------|--------|----------|---------|---------|
| 1 | LLM via Claude binary | `claude` on PATH | Highest — domain-specific reasoning | 30-120s |
| 2 | LLM via Anthropic API | `ANTHROPIC_API_KEY` env var | High — same model, direct API | 15-60s |
| 3 | Template from SPARC + dossier | Nothing — always available | Good — pattern-matched, deterministic | <1s |

**Tier 3 MUST always produce ≥8 ADRs.** The `buildPhase2ADRs()` function must receive the query parameter and generate domain-specific decisions from:
- SPARC architecture services → one ADR per major service boundary decision
- Research dossier constraints → one ADR per compliance/regulatory constraint
- Detected ERP system → integration strategy ADR
- Query-detected patterns (human-in-loop, audit trail, data model) → governance ADRs

### 2. Auto-Chain Recovery MUST Generate ADRs, Not Just Copy

When `executePhase4Command()` throws in auto-chain.ts, the catch block must:

```
1. Try: Copy Phase 2 ADRs to phase4/ (existing behavior)
2. If Phase 2 has no ADRs: Import buildPhase2ADRs + buildPhase2DDD
3. Load SPARC from phase3/ or phase2/ (whichever exists)
4. Load research dossier from phase2/
5. Generate ADRs with query parameter
6. Write adr-index.json + individual markdown files to phase4/adrs/
7. Generate DDD model and write to phase4/ddd/
```

This path requires zero LLM calls and always succeeds if SPARC exists.

### 3. ask-artifact-writer MUST Seed Phase 2 ADRs

When `persistAskResults()` runs (before auto-chain), it must write ADRs to `phase2/adrs/adr-index.json` in addition to `engineering/architecture-decisions.md`. This ensures the auto-chain recovery path always has a source to copy from.

### 4. Minimum ADR Set for Any Domain

Regardless of tier, the following ADRs must be generated for every pipeline run:

| # | ADR Topic | Source Signal |
|---|-----------|--------------|
| 1 | Recommendation-only pattern (no auto-execution) | "not looking for the system to automatically" |
| 2 | ERP integration strategy (OSLC/REST/API specific to detected system) | Detected ERP system name |
| 3 | Data model and domain entity design | SPARC specification services |
| 4 | Scoring/ranking algorithm and weight selection | Domain analysis requirements |
| 5 | Audit trail and decision traceability | Governance/compliance constraints |
| 6 | Monolithic prototype vs. microservice architecture | Phase-appropriate architecture |
| 7 | Human-in-the-loop approval workflow | Approval process requirements |
| 8 | Synthetic data model for prototype validation | Prototype scope |

## Consequences

### Positive
- ADRs will be present in every pipeline run, closing the #1 evaluation gap
- Governance score should increase from 5.5-7.0 to 8.0+
- Simulation → Execution alignment improves (ADRs create traceability)
- Phase 5 (Build) can proceed because phase4-manifest.json will exist
- Implementation prompts will have `relatedADRs` populated

### Negative
- Tier 3 ADRs are template-quality, not LLM-quality — but present beats absent
- Additional code paths increase maintenance surface

## Implementation

Files to modify:
- `src/pipeline/phase4-adrs/phase4-adrs-coordinator.ts` — Pass query to buildPhase2ADRs
- `src/pipeline/auto-chain.ts` — Add Path B recovery with ADR + DDD generation
- `src/synthesis/ask-artifact-writer.ts` — Write ADRs to phase2/adrs/
- `src/pipeline/phase2/phases/adr-generator.ts` — Ensure buildPhase2ADRs always returns ≥8 records
