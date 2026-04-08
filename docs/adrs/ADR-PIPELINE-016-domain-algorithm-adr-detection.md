# ADR-PIPELINE-016: Domain-Specific Algorithm ADR Detection

**Status:** Accepted
**Date:** 2026-04-08
**Supersedes:** None

## Context

The Phase 2 ADR generator has a 3-tier strategy: LLM via `claude --print`, Anthropic API, and a SPARC-derived template fallback. When both LLM tiers fail (no API key, no Claude binary), the template fallback generates ADRs based on service-level patterns (isDataIngestion, isAnalysis, isOrchestration, etc.) but does NOT analyze the query text for domain-specific algorithmic decisions.

In a production readiness review of a logistics optimizer, the pipeline produced 1 ADR instead of the expected 7. The missing ADRs covered:
- Weighted multi-objective scoring algorithm selection
- Intermodal routing strategy and modal split model
- Emissions factor sourcing and regional variation
- SLA tolerance thresholds and priority-based viability
- Distance estimation strategy and fallback handling
- Scenario comparison immutability and audit chain

These are algorithmic design choices embedded in the business logic — not service-level patterns. The template fallback lacked detection for these patterns.

Additionally, the per-service ADR cap was hardcoded at `services.slice(0, 4)`, limiting the number of service-level ADRs even when more services existed.

## Decision

1. Add a `detectAlgorithmicDecisions(query, domain)` function that scans the query text for 6 categories of algorithmic patterns:
   - **Scoring/ranking algorithms** — weighted, multi-objective, normalization
   - **Routing/modal strategies** — intermodal, modal splits, distance thresholds
   - **Factor sourcing** — emissions factors, regional variations, customization
   - **Threshold models** — SLA tolerances, priority levels, constraint buffers
   - **Estimation fallbacks** — distance estimation, unknown route handling
   - **Immutability/audit patterns** — comparison persistence, content hashing

2. Each detected pattern generates a dedicated ADR with specific alternatives and consequences — not a generic "Analysis Architecture" ADR.

3. Raise the per-service ADR cap from 4 to 6.

4. Update the LLM prompt to explicitly request algorithmic decision ADRs.

## Alternatives Considered

- **Rely entirely on LLM generation** (rejected): LLM tiers are unavailable when API keys aren't set. The template fallback must be comprehensive enough to produce useful ADRs independently.
- **Single "Core Algorithm" ADR** (rejected): Combining all algorithmic decisions into one ADR loses the "one decision, one record" principle. Future engineers can't trace back to individual choices.

## Consequences

- [+] Template fallback produces 5-8 additional domain-specific ADRs for systems with algorithmic complexity
- [+] Each non-obvious design choice (normalization method, threshold values, fallback strategy) is documented independently
- [+] LLM prompt improvements lead to better ADR output even when LLM tiers succeed
- [-] Keyword-based detection may produce false positives for queries that mention scoring/routing in passing
- [-] New patterns must be added to `detectAlgorithmicDecisions` as new domain types are encountered

## Files Changed

- `src/pipeline/phase2/phases/adr-generator.ts` — Added `detectAlgorithmicDecisions()`, raised service cap to 6, updated LLM prompt
