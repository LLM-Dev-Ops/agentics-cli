# ADR-028: Phase 1 Agent Under-Utilization and Over-Engineered Implementation Prompts

**Status**: Proposed
**Date**: 2026-03-12
**Decision Makers**: Engineering Lead, Product Lead
**Severity**: P0 — Root cause of hollow prototype output

## Context

### The Problem

The pipeline dispatches 109 agentics.dev agents across 27 domains and 54 repos, but the actual agent responses **do not meaningfully drive code generation**. Three independent evaluations produce the same verdict: well-organized scaffolding with zero domain logic. The latest evaluation scored 3/10.

### Root Cause 1: Phase 1 Simulation Produces Generic Artifacts

Phase 1 fires up to 109 agents, but most hit `computeLocal*` fallbacks in `src/commands/agents.ts` when cloud endpoints are unavailable. These fallbacks produce **structurally valid but content-empty responses** — generic JSON with correct field names but no domain knowledge:

```typescript
// agents.ts — every computeLocal* follows this pattern
function computeLocalRoi(payload, correlationId) {
  return {
    data: {
      roi: { percentage: 0, confidence: 0.5, ... },  // ← hardcoded zeros
      recommendations: [{ recommendation: "Evaluate...", priority: "medium" }]  // ← generic
    }
  };
}
```

The `simulation-renderers.ts` then extracts from these empty responses to build `scenario.json`, `executive-summary.md`, etc. Since the agent responses contain no domain knowledge (just structural placeholders), the Phase 1 artifacts are hollow from the start.

**The 54 agent repos each have real domain logic** — but that logic runs in cloud functions. When those aren't reachable, `computeLocal*` fallbacks produce cookie-cutter JSON that looks structurally correct but carries zero domain intelligence.

### Root Cause 2: Phase 2 Tries to Compensate with LLM Calls

Because Phase 1 artifacts are hollow, we added `claude --print` LLM enrichment calls in Phase 2 (ADR-027) to generate real content. But this creates a fundamental architecture problem:

- Phase 2 LLM calls receive **hollow dossier items** (extracted from hollow Phase 1 artifacts)
- The LLM generates content from the user's query alone — it doesn't have the agent fleet's domain analysis
- The `agentics-agents-report.json` from `dispatchAgenticsForPhase2()` contains the same `computeLocal*` fallback data
- **Result**: LLM enrichment is just "Claude generating from the user prompt" — no different from a single `claude --print` call with no pipeline at all

The pipeline's value proposition — 109 specialized agents providing domain expertise — is completely bypassed.

### Root Cause 3: Implementation Prompts Are Over-Engineered Templates

Phase 5's `buildImplementationPrompt()` assembles a massive structured prompt with:
- Full DDD model (all contexts, all aggregates, all commands, all queries, all events)
- All ADR decisions
- Complete TDD plan with suite counts
- SPARC architecture guidance
- 8 implementation rules
- Artifact file paths

This prompt is **structurally impressive but informationally empty** because all the data it references (DDD, ADRs, TDD, SPARC) was generated from hollow Phase 1 artifacts. You get a perfectly structured prompt telling Ruflo to "implement BudgetManagementPort" with `Record<string, unknown>` fields.

**What it should be instead**: Simple, iterative prompts like:

```
Implement ADR-001 (PostgreSQL for budget data) and ADR-003 (Oracle Fusion
REST API integration) first, because all other bounded contexts depend on
the data layer and ERP connection.

Build:
1. Database schema for budget_items, cost_centers, fiscal_periods
2. Oracle Fusion client using /fscmRestApi/resources/v1/budgets endpoint
3. BudgetRepository port + PostgreSQL adapter

This is the foundation — production-management and financial-ops
contexts will build on these in the next iteration.
```

Then the NEXT prompt:

```
Now implement the budget-management bounded context. It depends on the
data layer from step 1.

Build:
1. BudgetAggregate with fields: budget_id, cost_center_id, fiscal_year,
   allocated_amount, spent_amount, committed_amount
2. Commands: AllocateBudget, RecordExpenditure, TransferFunds
3. Invariant: spent + committed cannot exceed allocated
4. Query: GetBudgetVariance (actual vs planned by cost center)

Use the Oracle Fusion adapter from step 1 for pulling actual spend data.
```

This iterative, dependency-ordered approach produces real code because each prompt is **focused, concrete, and builds on prior output**.

## Decision

### Change 1: Phase 1 Must Produce LLM-Enriched Artifacts (Not Just Agent Fallbacks)

**File**: `src/synthesis/simulation-artifact-generator.ts`

When `computeLocal*` fallbacks are used (cloud functions unavailable), the simulation artifact generator must call Claude to enrich the artifacts before writing them to disk.

**Current flow**:
```
User query → 109 agents (most hit computeLocal* fallbacks) → generic JSON →
simulation-renderers.ts → hollow scenario.json / executive-summary.md
```

**Required flow**:
```
User query → 109 agents (computeLocal* fallbacks produce structure) →
Claude enrichment (fills structure with real domain knowledge) →
simulation-renderers.ts → rich scenario.json / executive-summary.md
```

Specifically, after all agent responses are collected but before `renderExecutiveSummary()` and `buildScenarioArtifact()`:

1. Detect which responses came from `computeLocal*` (they have characteristic empty/zero fields)
2. For each hollow response, call Claude with: "You are a {domain}/{agent} specialist. The user's scenario is: {query}. Generate a realistic agent response with domain-specific findings."
3. Replace the hollow response with the LLM-generated one
4. Continue with normal rendering

This means Phase 1 artifacts carry real domain knowledge even without cloud functions.

### Change 2: Implementation Prompts Must Be Iterative and Dependency-Ordered

**File**: `src/pipeline/ruflo-phase-executor.ts`

Replace the monolithic `buildImplementationPrompt()` with iterative, dependency-ordered prompts.

**Current**: One massive prompt dumping all DDD contexts, all ADRs, all TDD suites, all SPARC services at once → Ruflo tries to implement everything simultaneously → produces 579 files of scaffolding.

**Required**: Generate a sequence of focused implementation prompts, each building on the previous:

```typescript
function buildIterativeImplementationPrompts(
  ddd: DDDModel,
  adrs: ADR[],
  scenarioQuery: string,
): ImplementationStep[] {
  // Step 1: Analyze dependencies between bounded contexts
  const depGraph = buildContextDependencyGraph(ddd);

  // Step 2: Topological sort — implement foundations first
  const order = topologicalSort(depGraph);

  // Step 3: Group into implementation waves
  const waves = groupIntoWaves(order, adrs);

  // Step 4: Generate focused prompt per wave
  return waves.map((wave, idx) => ({
    prompt: buildWavePrompt(wave, idx, waves.length, scenarioQuery),
    contexts: wave.contexts,
    adrs: wave.relevantAdrs,
    dependsOn: wave.priorWaves,
  }));
}
```

Each wave prompt should be 20-40 lines — not 200. It should say:
- **What** to implement (specific contexts, specific ADRs)
- **Why** this order (dependency rationale)
- **What's already built** (reference prior wave output)
- **Concrete fields and types** (not `Record<string, unknown>`)

### Change 3: Stop Duplicating Phase 2 Work in Phases 3-4

**Files**: `src/pipeline/phase3-sparc/phase3-sparc-coordinator.ts`, `src/pipeline/phase4-adrs/phase4-adrs-coordinator.ts`

Phase 3 re-runs `generateSPARCSpecification()` and Phase 4 re-runs `generateADRs()` and `generateDDDModel()` — the same functions from Phase 2. This means Phases 3-4 are duplicating Phase 2's work, not refining it.

**Required**: Phases 3-4 should REFINE existing artifacts, not regenerate them:
- Phase 3: Take Phase 2's SPARC output and send it to Claude for quality review and iterative improvement
- Phase 4: Take Phase 2's ADRs + DDD and refine them based on Phase 3's improved SPARC

### Change 4: Ruflo Swarm Tasks Must Be Sequential Waves, Not Parallel Blast

**File**: `src/pipeline/ruflo-phase-executor.ts` (`buildPhase5Tasks`)

Currently, `buildPhase5Tasks()` creates one task per DDD bounded context PLUS 5 cross-cutting tasks (frontend, infra, database, tests, deploy) — all dispatched simultaneously to Ruflo. This means:
- The database task doesn't know what the domain tasks produce
- The test task imports handlers that don't exist yet
- The infra task builds adapters for ports that haven't been defined

**Required**: Execute in dependency order:
1. **Wave 1**: Foundation (database schemas, ERP client, shared infrastructure)
2. **Wave 2**: Core bounded contexts (the ones with no inter-context dependencies)
3. **Wave 3**: Dependent bounded contexts (that reference Wave 2 contexts)
4. **Wave 4**: Cross-cutting (frontend, tests, deployment) — built AFTER domain code exists

Each wave's prompt references the ACTUAL output from prior waves, not empty artifact summaries.

## Acceptance Criteria

| Criterion | Validation |
|-----------|-----------|
| Phase 1 artifacts contain domain-specific entities, real API names, real stakeholder roles | Manual review of scenario.json |
| Implementation prompts are <50 lines each, focused on 1-3 contexts | Inspect generated prompts |
| Implementation order follows dependency graph | Check that foundation (DB, ERP) is built before domain contexts |
| No `Record<string, unknown>` in domain layer of generated code | grep output |
| Generated code references correct ERP system (matches user query) | Manual review |
| Tests import handlers that actually exist | TypeScript compilation passes |

## Consequences

### Positive
- Phase 1 artifacts carry real domain knowledge even without cloud functions
- Implementation prompts are focused and concrete — Claude can actually follow them
- Dependency ordering means each implementation step has real foundations to build on
- Smaller prompts = less drift, more specific output

### Negative
- Phase 1 takes longer (LLM enrichment of hollow agent responses)
- Phase 5 takes longer (sequential waves instead of parallel blast)
- More complex orchestration logic for dependency ordering

## Implementation Priority

1. **P0**: Iterative implementation prompts with dependency ordering (Change 2 + Change 4) — this is the highest-leverage fix
2. **P0**: Phase 1 LLM enrichment of hollow agent responses (Change 1) — fixes the root data quality issue
3. **P1**: Phase 3-4 refinement instead of regeneration (Change 3) — eliminates wasted work

## References

- ADR-027: Content Quality Crisis (prior attempt — added LLM to Phase 2, didn't fix root cause)
- Evaluation: 3/10 — "Good scaffolding, fails to deliver on core ask"
- Pipeline coordinator: `src/pipeline/pipeline-coordinator.ts`
- Simulation artifacts: `src/synthesis/simulation-artifact-generator.ts`
- Ruflo executor: `src/pipeline/ruflo-phase-executor.ts`
- Agent fallbacks: `src/commands/agents.ts` (computeLocal* functions)
- SPARC reference: `docs/SPARC-reference.md`
