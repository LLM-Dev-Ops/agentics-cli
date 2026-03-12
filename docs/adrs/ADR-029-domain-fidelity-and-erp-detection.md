# ADR-029: Domain Fidelity Failures — Wrong ERP, Empty Models, No Tests

**Status**: Proposed
**Date**: 2026-03-12
**Decision Makers**: Engineering Lead, Product Lead
**Severity**: P0 — Generated prototypes are non-functional

## Context

Independent evaluation of the latest pipeline run (fcbbbd03) revealed 6 systemic failures that produce non-functional prototypes. These are distinct from the architectural issues in ADR-028 (Phase 1 under-utilization, over-engineered prompts) — these are content fidelity bugs in the generators themselves.

### Failure 1: Wrong ERP System

User specified "Oracle Fusion ERP". Generated code contains:
- NetSuite-style endpoints: `/services/rest/record/v1/transferOrder`
- NetSuite audit log references: `"netsuite_call"` in audit strings
- Undefined variable: `names.displayName` (would crash at runtime)

Oracle Fusion uses completely different REST APIs: `/fscmRestApi/resources/v1/...`

**Root cause**: `src/pipeline/phase2/phases/adr-generator.ts` and the ERP client template in Phase 5 don't propagate the detected ERP system. The tech detection in `tryGenerateLLMADRs()` scans for keywords but the actual ERP client code generation ignores the detection result and uses a hardcoded template.

### Failure 2: Empty Domain Models

Every bounded context has identical pattern:
```typescript
export interface BudgetManagementInput {
  readonly [key: string]: unknown;  // completely untyped
}
```

12 bounded contexts, all with `Record<string, unknown>` interfaces, generic CRUD operations, and zero domain-specific fields or logic.

**Root cause**: The DDD generator produces contexts with aggregate NAMES but no FIELDS. When Phase 5 Ruflo receives `"Aggregates: BudgetOrder"` with no typed fields, invariants, or domain events, it generates a generic interface. ADR-027's `enrichDDDWithLLM()` was supposed to fix this, but it runs AFTER the mechanical model — and when the mechanical model has empty aggregates, the LLM enrichment prompt has nothing concrete to build on.

### Failure 3: No AI/ML Component

The user's core ask was "use AI to detect budget drift patterns from historical data." The generated prototype has:
- No model inference code
- No statistical analysis
- No anomaly detection logic
- No BigQuery analytical queries
- No data pipeline for historical data

The `patterns-suggesting-project` bounded context — which should be the intelligence engine — is another CRUD stub.

**Root cause**: The SPARC specification and DDD model don't distinguish between "data management" contexts (CRUD) and "intelligence" contexts (ML/analytics). The pipeline treats every bounded context identically, with no concept of a context that should contain algorithms, models, or analytical logic.

### Failure 4: Cookie-Cutter DDD

12 bounded contexts with:
- Identical invariants: `"events must be idempotent"` (copied to every context)
- Identical command/query patterns: `Create*`, `Update*`, `Get*`, `List*`
- Only 1 relationship between 12 contexts in the context map
- No domain events that cross context boundaries

Real DDD for this domain would show rich relationships: budget-management depends on financial-ops for actuals, monitoring-alerts subscribes to budget-management events for threshold breaches, production-management publishes cost events that budget-management consumes.

**Root cause**: `buildPhase2DDD()` in `ddd-generator.ts` derives one context per SPARC service with mechanical name matching. It doesn't analyze how contexts interact — the context map is built by comparing service dependency lists, which are themselves mechanically derived from keyword co-occurrence.

### Failure 5: Interface Naming Bugs

Generated code has `IIbudgetManagementPort`, `IIoracleIntegrationPort` — double "I" prefix. Methods named `id()` with no clear purpose.

**Root cause**: The port interface naming in the code generation template prepends "I" to a name that already starts with "I" (from the DDD model's `Interface` prefix convention).

### Failure 6: No Actual Tests

Pipeline claims "24 TDD suites, 47 tests" but only JSON test plan files exist — zero actual test code (`*.test.ts`, `*.spec.ts`). The TDD plan references handlers that don't exist (`import { handleCreateBudget } from '...'`).

**Root cause**: `tdd-plan-generator.ts` creates test METADATA (suite names, test counts, strategies) but no test CODE. Phase 5's "Test Suite" Ruflo task says "Implement ALL tests from the TDD plan" but the TDD plan has no actual test bodies — just names and counts. Ruflo generates test files that import non-existent modules because the domain code was generated in a different Ruflo task with no coordination.

## Decision

### Fix 1: ERP Detection Must Flow End-to-End

**Files**: `src/pipeline/phase2/phases/adr-generator.ts`, `src/pipeline/ruflo-phase-executor.ts`

The tech detection in `tryGenerateLLMADRs()` already identifies ERP systems from the query. This detection must:

1. Be extracted into a shared utility: `detectTechnologyStack(query, dossier) → TechStack`
2. Be written to disk as `phase2/tech-stack.json` with: `{ erp: "oracle-fusion", cloud: "gcp", database: "postgresql", ... }`
3. Be read by Phase 5 task generation and embedded in EVERY implementation prompt
4. Include ERP-specific API details:
   - Oracle Fusion: `/fscmRestApi/resources/v1/{resource}`, OAuth2 JWT bearer
   - SAP S/4HANA: `/sap/opu/odata4/sap/{service}`, SAP OAuth/SAML
   - NetSuite: `/services/rest/record/v1/{record}`, TBA auth
   - Workday: `/ccx/api/v1/{tenant}/{resource}`, OAuth2

### Fix 2: DDD Aggregates Must Have Typed Fields From The Start

**File**: `src/pipeline/phase2/phases/ddd-generator.ts`

The mechanical `buildPhase2DDD()` currently creates aggregates with names only. Fix:

1. When creating each aggregate, derive fields from the SPARC pseudocode (if LLM-generated, it has typed structs) and the dossier requirements
2. If the SPARC pseudocode contains `struct BudgetOrder { budget_id: string, ... }`, parse those fields into the aggregate definition
3. If no pseudocode struct exists, the LLM enrichment must generate fields as a REQUIRED step (not optional enrichment)
4. Quality gate: reject any DDD model where >50% of aggregates have zero typed fields

### Fix 3: Context Map Must Show Real Domain Relationships

**File**: `src/pipeline/phase2/phases/ddd-generator.ts`

The current context map builder uses keyword co-occurrence between service names. Replace with LLM-generated relationships:

Send Claude the list of bounded contexts with their aggregates and domain events, and ask: "Which contexts publish events that other contexts consume? Which contexts need data from other contexts? What are the upstream/downstream relationships?"

This produces real relationships like:
- budget-management PUBLISHES `BudgetExhausted` → monitoring-alerts SUBSCRIBES
- financial-ops PUBLISHES `ActualCostRecorded` → budget-management CONSUMES (for variance calculation)
- production-management PUBLISHES `ProductionCostIncurred` → financial-ops CONSUMES

### Fix 4: Distinguish Intelligence Contexts from CRUD Contexts

**File**: `src/pipeline/phase2/phases/sparc-specification.ts`

When the user's query mentions AI, ML, analytics, prediction, anomaly detection, pattern recognition, forecasting, or similar terms, the SPARC specification must create at least one bounded context explicitly tagged as an "intelligence context" with:
- Model inference logic (not CRUD)
- Data pipeline / ETL operations
- Statistical or ML algorithms
- Feature engineering
- Training data management

The DDD model for intelligence contexts should have commands like `TrainModel`, `RunInference`, `DetectAnomalies` — not `Create*`, `Update*`, `Delete*`.

### Fix 5: Port Interface Naming Convention

**File**: `src/pipeline/ruflo-phase-executor.ts` or template generation

Establish naming convention for generated interfaces:
- Port interfaces: `{ContextName}Port` (no "I" prefix)
- Adapters: `{Implementation}{ContextName}Adapter` (e.g., `PostgresBudgetAdapter`)
- Never double-prefix

### Fix 6: TDD Plan Must Include Test Bodies (or Phase 5 Must Generate Tests After Domain Code)

**File**: `src/pipeline/phase2/phases/tdd-plan-generator.ts`, `src/pipeline/ruflo-phase-executor.ts`

Two options (implement Option B, it's simpler):

**Option A**: TDD plan generates actual test code with domain-specific assertions

**Option B** (recommended): Phase 5 generates tests AFTER domain code, in a later wave (per ADR-028 Change 4). The test generation Ruflo task receives the ACTUAL generated domain code as input — not just test plan metadata — so it can write tests that import real modules and make real assertions.

## Acceptance Criteria

| Issue | Criterion | Validation |
|-------|-----------|-----------|
| Wrong ERP | Generated ERP client uses correct API paths for user's stated system | grep for API paths |
| Empty models | Every aggregate has ≥3 typed fields (no `Record<string, unknown>` in domain layer) | grep + manual review |
| No AI/ML | Intelligence contexts exist when user mentions AI/ML/analytics | Check for non-CRUD commands |
| Cookie-cutter DDD | Context map has ≥3 relationships for ≥5 contexts | Count relationships |
| Naming bugs | No double-prefix interfaces (`II*`) | grep |
| No tests | Test files exist and import modules that exist | TypeScript compilation |

## Consequences

### Positive
- Generated ERP integration actually works with the correct system
- Domain models have real typed fields — downstream code generation has something to implement
- AI/ML requirements get dedicated bounded contexts with appropriate logic
- Tests compile and import real modules

### Negative
- More LLM calls in DDD generation (context map, field generation)
- Tech stack detection needs maintenance as new ERP systems are added
- Intelligence context detection heuristics may produce false positives

## Implementation Priority

1. **P0**: ERP detection end-to-end (Fix 1) — wrong ERP = completely broken prototype
2. **P0**: DDD typed fields (Fix 2) — empty fields = empty generated code
3. **P1**: Context map relationships (Fix 3) — affects integration quality
4. **P1**: Intelligence context distinction (Fix 4) — affects AI/ML prototypes
5. **P2**: Naming convention (Fix 5) — cosmetic but affects developer trust
6. **P1**: Test generation after domain code (Fix 6) — tests that don't compile are worse than no tests

## References

- ADR-027: Content Quality Crisis (Phase 2-4 LLM enrichment)
- ADR-028: Phase 1 Agent Under-Utilization and Iterative Implementation
- Evaluation: 3/10 — "Good scaffolding, fails to deliver on core ask"
- ERP client code: Phase 5 `erp-client/` directory
- DDD generator: `src/pipeline/phase2/phases/ddd-generator.ts`
- TDD plan generator: `src/pipeline/phase2/phases/tdd-plan-generator.ts`
- SPARC reference: `docs/SPARC-reference.md`
