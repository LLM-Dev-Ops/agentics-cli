# ADR-045: Code Generation Must Produce Domain-Specific Logic, Not Generic CRUD Stubs

**Status**: Proposed
**Date**: 2026-03-26
**Severity**: P0 — The entire value proposition depends on generated code being useful

## Context

The pipeline audit on a carbon strategy platform revealed that ALL pipeline-generated code is generic CRUD:

```typescript
// Every generated adapter looks like this:
class EmissionsTrackingAdapter {
  async create(input: { id: string; emissions_tracking_id: string }) {
    return this.db.query(`INSERT INTO emissions_tracking_records ...`);
  }
  async update(id: string, input: Record<string, unknown>) { ... }
  async query(params: Record<string, unknown>) { ... }
}
```

Meanwhile, the hand-written code (added after pipeline ran) contained:
- GBM price projection with seeded PRNG and percentile calculations
- Year-by-year strategy simulation with abatement costs and credit budgets
- NPV calculation with strategy ranking by risk and cost
- Emissions baseline aggregation with facility/scope/region breakdown

The pipeline produced **zero** simulation logic, optimization algorithms, or decision-matrix code despite the user explicitly describing these as core requirements.

### Why This Happens

1. **DDD commands are generic**: Create{X}, Update{X}, Query{X} — so code generators produce generic handlers
2. **SPARC pseudocode is empty**: The pseudocode phase produces `PROGRAM main / END PROGRAM` templates
3. **Phase 5 task descriptions are generic**: "Build a complete backend service" with the scenario query truncated to 300 chars
4. **The coding swarm receives no domain context**: It gets generic SPARC + generic DDD + generic ADRs → produces generic code

## Decision

### A. Pseudocode Must Contain Actual Algorithms
The SPARC pseudocode phase must use an LLM call to generate pseudocode for the domain-specific algorithms described in the user's prompt. For a carbon strategy platform, this means:
- Monte Carlo simulation loop pseudocode
- Strategy comparison scoring algorithm
- Emissions aggregation logic
- NPV/ROI calculation

### B. Code Generation Tasks Must Include Business Logic Descriptions
Each Phase 5 ruflo task must include:
1. The specific business logic to implement (from SPARC pseudocode)
2. The domain types and their fields (from DDD, not generic `Record<string, unknown>`)
3. Example inputs/outputs for the key operations
4. The algorithm or calculation to implement (not just "implement domain logic")

### C. DDD Aggregate Fields Must Be Domain-Typed
Instead of:
```typescript
interface EmissionsRecord { id: string; emissions_tracking_id: string }
```

Generate:
```typescript
interface EmissionsRecord {
  facilityId: string;
  reportingYear: number;
  scope1Tonnes: number;
  scope2Tonnes: number;
  scope3Tonnes: number;
  businessUnit: string;
  region: string;
  verificationStatus: 'unverified' | 'third-party-verified' | 'self-declared';
}
```

This requires the DDD enrichment LLM prompt to produce real fields (addressed in ADR-042).

### D. Generated Adapters Must Implement Real Operations
Instead of generic CRUD methods, generate methods that match the DDD commands:
- `RecordFacilityEmissions(input: EmissionsRecord): Promise<void>`
- `AggregateByBusinessUnit(year: number): Promise<BusinessUnitSummary[]>`
- `RunPriceSimulation(params: SimulationConfig): Promise<SimulationResult>`

## Consequences

### Positive
- Generated code contains real business logic specific to the user's domain
- The prototype actually demonstrates value to the end-user's executive team
- The gap between pipeline output and hand-written code narrows significantly

### Negative
- Requires LLM involvement in pseudocode generation (additional cost/time)
- DDD model must be domain-specific (dependency on ADR-042)
- Code generation prompts become much larger

## Implementation

1. `sparc-specification.ts` — LLM call to generate pseudocode from user requirements
2. `ddd-generator.ts` — LLM enrichment must produce typed fields (ADR-042)
3. `ruflo-phase-executor.ts` — Phase 5 tasks must include pseudocode + typed DDD fields
4. `domain-codegen.ts` — Generate methods matching DDD commands, not generic CRUD
5. `http-server-generator.ts` — Routes must map to domain commands, not generic endpoints
