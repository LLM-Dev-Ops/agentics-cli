# ADR-040: Implementation Prompts Must Be Unique Per Phase With Scoped References

**Status**: Proposed
**Date**: 2026-03-26
**Severity**: P0 — Prompts are the primary artifact driving code generation

## Context

The pipeline audit (2026-03-26) on a carbon strategy simulation platform revealed that implementation prompts (impl-002 through impl-007) are structurally identical — the only difference is the service name substituted into the same template. ~85% of content is copy-paste across prompts.

Specific failures:
1. Every prompt dumps the FULL domain model for ALL 12 bounded contexts, not just the one relevant to that phase
2. The "What to Build" section is the same SPARC dump repeated in every prompt
3. The Overview paragraph is a template: "In this phase, you are building the {service-name} component..."
4. Implementation Requirements section is identical boilerplate in every prompt
5. Prompts target `frontend/` as output folder even when building backend services

A developer (or coding swarm) executing these prompts sequentially would build 6 identical CRUD stubs because the prompts give no phase-specific guidance.

## Decision

Each implementation prompt MUST contain:

### 1. Phase-Specific Narrative (not a template)
The Overview must describe in 2-3 sentences WHAT this specific phase builds, WHY it matters to the overall solution, and HOW it connects to prior phases. This narrative must reference the user's actual business problem — not generic "CRUD operations."

Example for a carbon strategy platform, Phase 4 (Market Simulation):
> "In this phase, you build the carbon market simulation engine. This is the core analytical component that projects carbon credit prices under different regulatory scenarios using geometric Brownian motion and Monte Carlo methods. It consumes emissions baseline data from Phase 2 and feeds projected costs into the strategy comparison engine in Phase 5. This phase is governed by ADR-P2-004 (Stochastic Simulation in Rust) and ADR-P2-007 (Simulation Audit Trail)."

### 2. Scoped References
- **ADRs**: Only include the 1-3 ADRs that govern THIS phase, with their decision text summarized inline
- **DDD**: Only include the bounded context(s) relevant to this phase — not the full model
- **SPARC**: Only include the SPARC section that describes this component — not the entire architecture document
- **Prior phases**: List what was built and what interfaces are available for import

### 3. Concrete Implementation Guidance
Each prompt must specify:
- What files/modules to create
- What business logic to implement (specific to the domain, not "implement domain logic")
- What interfaces to expose for downstream phases
- What tests to write (specific scenarios, not "write unit tests")

### 4. Correct Target Folder
The target folder must match what the phase actually builds:
- `backend/` for API and service code
- `frontend/` for UI components
- `erp/` for ERP integration
- `integrations/` for external system connectors
- `src/` for shared core types and utilities
- `tests/` for test suites

## Consequences

### Positive
- Each prompt becomes an actionable developer brief
- Coding swarm produces unique, domain-specific code per phase
- Build order reflects actual dependency chain

### Negative
- Prompt generation requires deeper analysis of SPARC/ADR/DDD content per phase
- Larger implementation effort in the prompt generator

## Implementation Notes

The prompt generator in `auto-chain.ts` (Phase 4.5) must:
1. Parse SPARC architecture to extract per-component descriptions
2. Match ADRs to phases by analyzing ADR context/decision text against phase content
3. Filter DDD contexts to only those relevant to each phase
4. Generate a unique narrative paragraph per phase using the matched references
5. Assign correct target folders based on phase content analysis
