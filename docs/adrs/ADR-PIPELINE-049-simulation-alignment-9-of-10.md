# ADR-PIPELINE-049: Simulation Alignment 9/10 — Consume Sim Outputs at Runtime, Explain Confidence

**Status:** Accepted
**Date:** 2026-04-10
**Priority:** MEDIUM — Simulation Alignment at 6-7/10

## Gap Analysis (6.5 → 9)

| Issue | Impact | Fix |
|-------|--------|-----|
| Simulation outputs not consumed by code | Lineage is structural only, not substantive | Feed sim params into scoring config |
| Low consensus (41.6%) not explained | Evaluator flags unexplained divergence | Document what would increase confidence |
| Simulation IDs not in domain types | Can't trace decision → simulation | Add simulationId field to key types |

## Decision

### 1. Simulation Parameters Feed Runtime Config
```
RULE: The generated code MUST read simulation parameters:
- Load simulation ID from environment or .agentics/plans/manifest.json
- Reference simulation-derived thresholds in scoring config comments
- Log simulation ID in every analysis run for traceability
```

### 2. Confidence Disclosure in Reports
```
RULE: When the consensus agent reports <60% confidence:
- The demo output MUST include an "Analysis Confidence" section
- Explain what the divergence means (e.g., "cost signals positive, organizational readiness uncertain")
- Frame the pilot as the mechanism to resolve uncertainty
```

### 3. Simulation Lineage in Domain Types
```
RULE: Key domain types MUST include optional traceability:
- simulationId?: string on Decision, Recommendation, ERPTransaction
- traceId?: string for pipeline correlation
- pipelineVersion?: string for reproducibility
```

## Implementation

Add to traceability requirements section of every prompt. Already partially done in ADR-033, needs enforcement in generated code.
