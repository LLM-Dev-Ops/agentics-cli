# ADR-PIPELINE-035: DDD Model Generation — Phase 4 Must Produce Complete Domain Models

**Status:** Accepted
**Date:** 2026-04-09
**Priority:** MEDIUM — DDD directories empty in all 3 test runs

## Context

Phase 4 is responsible for generating Domain-Driven Design artifacts alongside ADRs. In all three evaluation runs, the `ddd/` directory was empty:
- No `domain-model.json`
- No `context-map.json`
- No per-context files in `ddd/contexts/`
- No `DDD-Model.md` summary

The DDD model feeds directly into the prompt generator — without it, prompts are generated from ADR clusters only (which caps at 3 prompts) instead of from bounded contexts (which produces per-aggregate prompts).

## Decision

### 1. DDD Fallback in Phase 4 Coordinator

When LLM-based DDD generation fails, `phase4-adrs-coordinator.ts` must import `buildPhase2DDD()` and generate a template-based domain model from:
- SPARC architecture services → one bounded context per service
- ADR records → aggregate and entity extraction
- Research dossier → domain vocabulary and constraint mapping

### 2. DDD Fallback in Auto-Chain Recovery

When Phase 4 fails entirely and the auto-chain catch block generates ADRs, it must also generate the DDD model in the same recovery path. Write to:
- `phase4/ddd/domain-model.json` — Full model with contexts, aggregates, context map
- `phase4/ddd/contexts/{slug}.json` — Per-context files
- `phase4/ddd/DDD-Model.md` — Human-readable summary

### 3. Minimum DDD Model Structure

Every generated DDD model must include:

| Artifact | Content |
|----------|---------|
| Bounded Contexts | ≥3 contexts with name, description, subdomain classification |
| Aggregates | ≥1 aggregate per context with root entity, entities, value objects |
| Context Map | Relationships between contexts (customer-supplier, anti-corruption layer, etc.) |
| Domain Events | ≥1 event per context |
| Commands | ≥1 command per aggregate |
| Ubiquitous Language | Domain term glossary |

### 4. ask-artifact-writer Must Seed Phase 2 DDD

When the ask flow generates engineering artifacts, it must also write the DDD model to `phase2/ddd/domain-model.md` so the auto-chain recovery can find it.

## Consequences

### Positive
- Prompt generator can use DDD path (per-aggregate decomposition) instead of ADR-only fallback
- Implementation prompts get bounded context details, not just ADR clusters
- Domain model documentation exists for stakeholder review

### Negative
- Template-generated DDD models are less nuanced than LLM-generated ones
- Additional file I/O in recovery paths

## Implementation

Files to modify:
- `src/pipeline/phase4-adrs/phase4-adrs-coordinator.ts` — DDD fallback path
- `src/pipeline/auto-chain.ts` — DDD generation in Phase 4 catch block
- `src/synthesis/ask-artifact-writer.ts` — Write DDD to phase2/ddd/
- `src/pipeline/phase2/phases/ddd-generator.ts` — Ensure `buildPhase2DDD` always returns valid model
