# ADR-027: Content Quality Crisis — Why 110 Agents Produce Empty Prototypes

**Status**: Accepted (P0 changes implemented)
**Date**: 2026-03-12
**Decision Makers**: Engineering Lead, Product Lead
**Severity**: P0 — Blocks go-to-market

## Context

The agentics pipeline dispatches 110 agents across 27 domains in 6 phases, completing in ~7 minutes. The orchestration infrastructure (tracing, telemetry, phase chaining, artifact management) is production-grade. **But every prototype evaluation returns the same verdict: "impressive orchestration, shallow substance."**

Three independent evaluations on different domains (semiconductor manufacturing, airline fleet maintenance, generic ERP integration) all produce:
- SPARC specification: user prompt pasted verbatim, no requirements derived
- Pseudocode: `PROGRAM main / END PROGRAM` or identical validate→execute→persist template for every function
- Domain model: empty ubiquitous language, zero aggregate fields, cookie-cutter entities
- Generated code: structurally identical classes with `Record<string, unknown>` data bags
- Tests: import non-existent handlers, cannot compile
- ADRs: generic microservices prose, wrong ERP/cloud references from templates

## Root Cause Analysis

### The pipeline has NO LLM involvement in Phases 2-4

This is the fundamental architectural flaw. The pipeline has two LLM touchpoints:
1. **Phase 1**: Simulation agents (110 agents) — produce JSON analysis/recommendations
2. **Phase 5**: Ruflo swarm — receives prompts and generates code with Claude

**Phases 2-4 are pure deterministic string concatenation.** They take Phase 1 JSON and reformat it into markdown. No LLM synthesizes, reasons about, or enriches the content.

Evidence:

| File | What it does | What it should do |
|------|-------------|-------------------|
| `sparc-specification.ts:141-226` | Lists dossier items as bullet points | Synthesize requirements into functional specs with acceptance criteria |
| `sparc-specification.ts:256-269` | Every function gets identical `validate→load→execute→emit→persist` | Write domain-specific algorithms (telemetry ingestion, anomaly detection, threshold evaluation) |
| `ddd-generator.ts` | Derives bounded contexts from service names | Define aggregates with typed fields, invariants, and domain events from research |
| `adr-generator.ts` | Fills ADR template with generic decisions | Make domain-specific technology decisions based on research findings |
| `tdd-plan-generator.ts` | Creates structural test skeletons | Write test cases with domain-specific assertions and realistic test data |

### The 110 agents produce JSON analysis, not content

Agent responses are structured JSON with scores, recommendations, and risk assessments. They're **analytical** — they tell you what to think about. They don't **write** the specification, pseudocode, or domain model. The pipeline treats them as data sources, not as authors.

### Phase 5 (Ruflo) receives prompts built from empty artifacts

When Ruflo agents finally get to write code, their prompts contain:
- An empty pseudocode section (no algorithms to implement)
- An empty domain model (no typed fields to use)
- Generic ADRs (no specific technology decisions)
- A truncated TDD plan (no test cases to implement)

Ruflo does its best, but `"Write REAL business logic — not stubs"` is useless when the prompt contains zero domain knowledge to work from.

### Quality gates exist but aren't wired in

ADR-027a: We built 4 quality gates (research, SPARC, DDD, implementation) in commit `f45eded`, but they're not yet wired into the phase coordinators. Even when wired, they would only REJECT empty output — they can't FILL IT IN. The pipeline would just fail earlier instead of producing garbage.

## Decision

### Phase 2-4 must use LLM (Claude) to generate content, not string templates

The core generators must be rewritten to send prompts to Claude via the ruflo swarm (or direct `claude --print` calls) and receive synthesized content back. The current deterministic string concatenation is replaced with LLM-driven generation at each phase.

### Implementation: 5 Critical Changes

#### Change 1: SPARC Pseudocode Must Be LLM-Generated

**File**: `src/pipeline/phase2/phases/sparc-specification.ts`

**Current** (line 256-269): Every function gets identical template:
```
function funcName(input):
    validate_preconditions(input)
    aggregate = load_or_create_aggregate(input.id)
    result = aggregate.execute(input)
    emit_event(...)
    persist(aggregate)
```

**Required**: Send a prompt to Ruflo/Claude per domain service:
```
"Given these research findings about [domain]:
[dossier items for this service]

Write pseudocode for the [service-name] service that implements:
[capabilities list]

The pseudocode must include:
1. Domain-specific data structures with typed fields (not generic Record<string, unknown>)
2. Actual algorithm steps (not validate→execute→persist)
3. Error handling specific to this domain
4. Integration points with [detected ERP/systems]

Example of GOOD pseudocode for a telemetry ingestion service:
  function ingest_telemetry_reading(reading: TelemetryReading):
    validate_sensor_id_exists(reading.sensor_id)
    validate_reading_within_bounds(reading.value, reading.sensor_type)
    current_baseline = load_baseline(reading.sensor_id, reading.parameter)
    deviation = calculate_deviation(reading.value, current_baseline.mean, current_baseline.std_dev)
    if deviation > ANOMALY_THRESHOLD:
      alert = create_anomaly_alert(reading, deviation, current_baseline)
      emit_event('telemetry.anomaly.detected', alert)
      if deviation > CRITICAL_THRESHOLD:
        trigger_maintenance_workflow(reading.equipment_id, alert)
    update_rolling_baseline(current_baseline, reading.value)
    persist_reading(reading)
    return { status: 'ingested', deviation, alert_triggered: deviation > ANOMALY_THRESHOLD }
"
```

**Implementation approach**: Use `buildImplementationPrompt()` from `ruflo-phase-executor.ts` to construct the prompt, then call `executeRufloPhaseSwarm()` to get Claude-generated pseudocode. If ruflo is unavailable, fall back to `claude --print` via the existing `createClaudeCodeRunner()` in `src/runtime/claude-code-runner.ts`.

#### Change 2: DDD Domain Model Must Be LLM-Generated

**File**: `src/pipeline/phase2/phases/ddd-generator.ts`

**Current**: Derives bounded contexts mechanically from SPARC service names. Aggregates have no fields. Ubiquitous language is empty.

**Required**: After mechanical derivation, send each bounded context to Claude for enrichment:
```
"Given this bounded context: [context-name]
With these services: [service list]
From this research dossier: [relevant dossier items]
In the domain of: [user's original query]

Define the complete DDD model:
1. Aggregate roots with typed fields (string, number, boolean, Date, enums — NO Record<string, unknown>)
2. Entity definitions with identity fields and business-relevant attributes
3. Value objects (immutable, no identity)
4. Domain events with payload types
5. Commands with input validation rules
6. Queries with return types
7. Ubiquitous language terms with definitions

Example for an aircraft maintenance domain:
  Aggregate: MaintenanceOrder
    Fields: order_id (string), aircraft_registration (string), ata_chapter (string),
            task_type (enum: scheduled|unscheduled|deferred), priority (enum: AOG|urgent|routine),
            estimated_labor_hours (number), parts_required (PartRequirement[]),
            status (enum: open|in_progress|completed|deferred)
    Invariant: Cannot defer AOG priority orders
    Invariant: estimated_labor_hours must be > 0
"
```

#### Change 3: ADRs Must Reference Actual Research Findings

**File**: `src/pipeline/phase2/phases/adr-generator.ts`

**Current**: Fills in a template with generic microservices decisions. Mentions "Dynamics 365 / SAP" even when user specified SAP-only.

**Required**: Each ADR must be generated by Claude with:
- The user's stated technology constraints (from `askTechStackQuestions()` in deep-research.ts)
- The detected ERP system (from research dossier)
- The detected cloud provider (from user context)
- Domain-specific alternatives considered (not generic "monolith vs microservices")

#### Change 4: TDD Test Plan Must Include Domain-Specific Assertions

**File**: `src/pipeline/phase2/phases/tdd-plan-generator.ts`

**Current**: Generates structural test skeletons that import non-existent handlers.

**Required**: Claude generates test cases with:
- Realistic domain test data (not empty objects)
- Domain-specific assertions (yield percentage > 0, not just `result.id exists`)
- Edge cases derived from research (what if sensor reading is negative? what if ERP is offline?)
- Integration test seams that match the actual port interfaces generated

#### Change 5: Implementation Prompts Must Embed Rich Artifacts

**File**: `src/pipeline/ruflo-phase-executor.ts` (buildPhase5Tasks)

**Current** (line 864-868): When no implementation prompt file exists, falls back to:
```
Aggregates: ${ctx.aggregates.join(', ')}.
Commands: ${ctx.commands.join(', ')}.
Queries: ${ctx.queries.join(', ')}.
```
This is just a name list — no types, no logic, no constraints.

**Required**: Embed the FULL enriched DDD model (from Change 2) including typed fields, invariants, and domain events. Embed the FULL pseudocode (from Change 1) with actual algorithms. Embed domain-specific test data from the TDD plan (from Change 4).

### Execution Strategy

**Option A: Ruflo swarm at each phase** (recommended)
- Phase 2 already calls `executeRufloPhaseSwarm()` with tasks
- Extend Phases 3-4 to also call ruflo for content generation
- Ruflo uses Claude Code session (Claude Max) — no API key needed
- Pro: Consistent execution model, swarm coordination built-in
- Con: Slower (each phase waits for swarm)

**Option B: Direct `claude --print` calls**
- Use `createClaudeCodeRunner()` from `src/runtime/claude-code-runner.ts`
- Each generator calls Claude directly for content
- Pro: Faster (no swarm overhead), simpler
- Con: No swarm coordination, sequential

**Option C: Hybrid — ruflo for code, `claude --print` for docs**
- Use ruflo swarm for Phase 5 (code generation) as today
- Use `claude --print` for Phase 2-4 document generation (faster)
- Pro: Best of both, fast doc generation + coordinated code generation
- Con: Two execution models to maintain

**Recommendation**: Option C (Hybrid). Document generation (SPARC, ADR, DDD, TDD) needs fast turnaround — `claude --print` takes 5-15 seconds per call vs. 60+ seconds for swarm init. Code generation (Phase 5) needs coordination — ruflo swarm is appropriate there.

## Quality Gate Integration

Wire the 4 quality gates from commit `f45eded` into the phase coordinators:

| Gate | Location | Blocks | Threshold |
|------|----------|--------|-----------|
| Research Quality Gate | After Phase 2 deep-research | Phase 2 SPARC | Score >= 60/100 |
| SPARC Quality Gate | After Phase 2 sparc-specification | Phase 2 DDD | Score >= 60/100 |
| DDD Quality Gate | After Phase 2 ddd-generator | Phase 3 scaffold | Score >= 60/100 |
| Implementation Quality Gate | Before Phase 5 ruflo swarm | Phase 5 code gen | Score >= 60/100 |

When a gate fails:
1. Log the specific issues (e.g., "0 ubiquitous language terms", "pseudocode has no typed data structures")
2. Re-run the preceding generator with the issues as feedback (retry loop, max 2 retries)
3. If still failing after retries, halt pipeline with actionable error message

## Acceptance Criteria

A prototype is "go-to-market ready" when an independent evaluation scores:

| Dimension | Minimum Score | Validation |
|-----------|--------------|------------|
| SPARC Specification | 7/10 | Has derived requirements, not prompt echo; has acceptance criteria |
| Pseudocode | 7/10 | Domain-specific algorithms, not generic validate→execute→persist |
| Domain Model | 7/10 | Typed aggregate fields, non-empty ubiquitous language, real context map |
| Generated Code | 6/10 | Typed entities, domain logic, no `Record<string, unknown>` in domain layer |
| Tests | 6/10 | Compile, import real handlers, have domain-specific assertions |
| Deployment | 7/10 | Correct cloud provider, USER directive, real config values |
| Domain Specificity | 6/10 | Uses industry terminology, implements domain algorithms |

## Consequences

### Positive
- Prototypes contain actual domain logic, not templates
- Tests compile and have meaningful assertions
- ADRs reference the correct technology stack
- Domain model drives typed code generation
- Pipeline failures are caught early with actionable feedback

### Negative
- Pipeline execution time increases from ~7 minutes to ~15-20 minutes (LLM calls in Phases 2-4)
- Requires Claude Code session (Claude Max) or API key for content generation
- More complex error handling (LLM calls can fail/timeout)
- Need to handle LLM output validation (ensure Claude returns structured content, not prose)

### Risks
- LLM-generated pseudocode may still be generic if prompts aren't specific enough — mitigated by quality gates with retry loops
- Cost per prototype increases — mitigated by using `claude --print` (included in Claude Max subscription) instead of API calls
- Output format inconsistency — mitigated by structured output parsing with Zod schemas

## Implementation Priority

1. **P0**: ~~SPARC pseudocode LLM generation (Change 1)~~ — **IMPLEMENTED** in `sparc-specification.ts:tryGenerateLLMPseudocode()` using `ClaudeCodeRunner`
2. **P0**: ~~DDD model LLM enrichment (Change 2)~~ — **IMPLEMENTED** in `ddd-generator.ts:enrichDDDWithLLM()` using `ClaudeCodeRunner`
3. **P1**: Wire quality gates into coordinators — catch failures before they cascade
4. **P1**: ADR domain-specific generation (Change 3) — wrong tech references
5. **P2**: TDD domain-specific tests (Change 4) — tests that compile
6. **P2**: Rich implementation prompts (Change 5) — better Phase 5 input

## References

- Evaluation: "Impressive orchestration, shallow substance" (2026-03-12)
- Evaluation: "Solid scaffolding, shallow implementation" (2026-03-11)
- Commit f45eded: Quality gates + multi-provider deployment + typed DTOs
- SPARC reference: `/workspaces/agentics-cli/docs/SPARC-reference.md`
- Pipeline coordinator: `src/pipeline/pipeline-coordinator.ts`
- Ruflo executor: `src/pipeline/ruflo-phase-executor.ts`
- Claude runner: `src/runtime/claude-code-runner.ts`
