# ADR-PIPELINE-033: Simulation-to-Execution Traceability — Every Decision Must Trace to Its Origin

**Status:** Accepted
**Date:** 2026-04-09
**Priority:** MEDIUM — Simulation Alignment scores 4.5-5.5/10 across all runs

## Context

The simulation layer generates structural metadata (trace IDs, execution proofs, SHA-256 hashes) but this metadata is not referenced in the implementation. No code validates that its logic traces back to a specific simulation. The evaluation consistently notes:

- "Simulation proof hashes exist but are not referenced anywhere in the implementation"
- "No code validates that its logic traces back to a specific simulation"
- "The lineage from simulation to execution is nominal, not substantive"

Additionally, the simulation itself runs in <10ms with zero meaningful state transitions — it generates metadata without modeling the actual problem domain. While improving simulation depth is a larger effort, we can immediately close the traceability gap.

## Decision

### 1. Embed Trace IDs in Domain Types

All pipeline-generated domain types must include optional traceability fields:

```typescript
interface Opportunity {
  // ... existing fields ...
  simulationId?: string;   // sim-632831f6-...
  traceId?: string;        // 762e262e-fa44-...
  pipelineVersion?: string; // 1.7.2
}

interface ERPTransaction {
  // ... existing fields ...
  simulationId?: string;
  traceId?: string;
}
```

### 2. Code Generation Must Populate Trace Fields

The codegen phase must inject the simulation ID and trace ID into:
- Opportunity creation functions
- Decision creation functions
- ERP transaction payloads
- Audit trail entries

### 3. Implementation Prompts Must Reference Simulation Lineage

Every implementation prompt must include a "Simulation Lineage" section:
```markdown
## Simulation Lineage
Originating simulation: `sim-632831f6-021c-4b02-ab08-baaf908e8cc1`
Trace ID: `762e262e-fa44-49ba-9cbc-39cf99e563cb`
```

### 4. Executive Documents Must Cite Simulation Evidence

The executive summary and decision memo must reference the simulation ID when citing confidence scores, risk assessments, or financial projections. This creates an auditable chain from recommendation back to the analysis that generated it.

## Consequences

### Positive
- Simulation Alignment score should increase from 4.5-5.5 to 7.0+
- Regulatory/compliance reviewers can trace any decision back to its analytical origin
- Audit trail becomes end-to-end: query → simulation → analysis → decision → ERP action

### Negative
- Trace fields add minor complexity to type definitions
- Simulation itself remains shallow (metadata-only) — deeper simulation is a separate effort

## Implementation

Files to modify:
- `src/pipeline/phase2/phases/prompt-generator.ts` — Already includes simulation lineage in prompts
- Code generation templates — Populate trace fields in generated types
- `src/synthesis/simulation-renderers.ts` — Reference simulation ID in executive documents
