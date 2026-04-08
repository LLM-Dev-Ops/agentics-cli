# ADR-PIPELINE-019: Phase 2 Implementation Prompt Generation

**Status:** Accepted
**Date:** 2026-04-08
**Supersedes:** None

## Context

The Phase 2 pipeline runs 4 deterministic generators in sequence:
1. SPARC Specification
2. ADR Generation
3. DDD Model Generation
4. TDD Plan Generation

Implementation prompt generation existed only in the Phase 1 pipeline (`src/pipeline/phases/prompt-generator.ts`), which uses different stage keys (`sparc-development`, `adr-ddd-generation`). The Phase 2 pipeline uses `sparc-specification`, `adr-generation`, `ddd-generation` — incompatible stage keys.

As a result, the Phase 2 pipeline produced ADRs and DDD models but zero implementation prompts. The code was written entirely outside the pipeline's artifact chain, breaking the simulation → ADR → prompt → execution lineage. In the production readiness review, this was identified as a "pipeline execution failure" — the generated artifacts stopped at ADRs/DDD without actionable build instructions.

## Decision

1. Create `src/pipeline/phase2/phases/prompt-generator.ts` — a Phase 2-native prompt generator that:
   - Reads ADRs from `adr-generation` stage output
   - Reads DDD model from `ddd-generation` stage output (if available)
   - Reads SPARC services from `sparc-specification` stage output
   - Threads simulation ID from Phase 1 manifest for lineage

2. Two generation paths:
   - **DDD-based (preferred)**: Topologically sorts bounded contexts, assigns ADRs to contexts by keyword matching, generates one prompt per context with its governing ADRs
   - **ADR-only fallback**: When DDD model is empty, clusters ADRs into logical groups (domain, algorithm, infrastructure) and generates one prompt per cluster

3. Each prompt includes:
   - Project objective (from query)
   - Simulation lineage (when available)
   - Previously built contexts (for import dependency)
   - Bounded context definition with aggregates, events, commands
   - Governing ADRs with full context/decision/consequences
   - Implementation requirements (London School TDD, no stubs, real logic)

4. Add `prompt-generation` to the `Phase2Stage` union type.

5. Add prompt generation as the 5th generator in the Phase 2 coordinator's stage list.

## Alternatives Considered

- **Reuse Phase 1 prompt generator** (rejected): Phase 1 uses different stage keys and type shapes (`ADRRecord` vs `Phase2ADRRecord`, `DomainModel` vs `Phase2DomainModel`). Adapting it would require brittle type coercion.
- **Generate prompts in Phase 4** (rejected): Phase 4 already has ADR refinement. Prompt generation belongs where ADRs and DDD are freshly generated — Phase 2.
- **Skip prompts entirely** (rejected): Without prompts, developers must manually read ADRs and DDD models to understand what to build. Prompts provide structured, actionable build instructions.

## Consequences

- [+] Phase 2 pipeline produces complete implementation prompts alongside ADRs and DDD models
- [+] Full lineage chain: simulation → ADR → prompt → execution
- [+] Prompts include simulation ID for traceability
- [+] ADR-only fallback ensures prompts are generated even when DDD model is empty
- [-] Additional pipeline stage adds ~1-3 seconds to Phase 2 execution
- [-] Prompt quality depends on ADR quality — if ADRs are sparse, prompts are sparse

## Files Changed

- `src/pipeline/phase2/types.ts` — Added `'prompt-generation'` to `Phase2Stage` union
- `src/pipeline/phase2/phases/prompt-generator.ts` — New file: Phase 2 prompt generator
- `src/pipeline/phase2/phase2-coordinator.ts` — Added prompt generation to generator list and import
