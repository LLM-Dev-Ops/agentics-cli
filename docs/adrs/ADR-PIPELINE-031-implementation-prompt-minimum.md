# ADR-PIPELINE-031: Implementation Prompt Minimum — Every Run Must Produce ≥10 Domain-Specific Prompts

**Status:** Accepted
**Date:** 2026-04-09
**Priority:** HIGH — Only 3 prompts generated in test runs (foundation, testing, deployment)

## Context

The prompt generator produces only 3 implementation prompts in every observed run:
1. `impl-001-foundation.md` — Project Foundation & Core Types
2. `impl-002-testing.md` — Testing & Quality Assurance
3. `impl-003-deployment.md` — Deployment & Infrastructure

These are generic phase labels, not domain-specific implementation guidance. A developer receiving these cannot build a packaging analysis engine, water loss advisor, or sustainability insights system from them alone.

Root causes:
- **DDD path** (`generateFromDDDContexts`): Produces one prompt per bounded context. If the DDD model has 3 contexts, you get 3 prompts.
- **ADR-only fallback** (`generateFromADRsOnly`): Clusters ADRs into 3 hardcoded categories (Domain Model, Core Algorithms, Infrastructure) and produces one prompt per cluster.

## Decision

### 1. DDD Path: Decompose Per-Aggregate

Each bounded context gets a foundation prompt, plus one additional prompt per aggregate when a context has multiple aggregates. Then add cross-cutting prompts:

```
Context prompts:     1 per bounded context (types + core logic)
Aggregate prompts:   1 per aggregate (when context has >1 aggregate)
Cross-cutting:       Integration Layer, Observability, Configuration
Infrastructure:      API Layer, Persistence, Deployment (added if <10 total)
```

### 2. ADR-Only Path: Expand to 10 Topic Clusters

Replace the 3 hardcoded clusters with 10 fine-grained categories:

| # | Cluster | Pattern |
|---|---------|---------|
| 1 | Domain Model & Types | domain, model, entity, aggregate, schema |
| 2 | Core Algorithms & Scoring | scoring, algorithm, optimization, weight, threshold |
| 3 | Data Ingestion & Processing | ingest, pipeline, transform, normalize, parse |
| 4 | ERP & External Integration | erp, maximo, sap, oslc, api, gateway, adapter |
| 5 | Governance & Audit Trail | governance, audit, approval, compliance, regulatory |
| 6 | Security & Access Control | security, auth, rbac, role, permission |
| 7 | Persistence & Storage | persist, storage, database, repository, cache |
| 8 | Simulation & Scenario Engine | simulation, scenario, what-if, forecast |
| 9 | Observability & Monitoring | observability, monitor, log, metric, health |
| 10 | Deployment & Infrastructure | deploy, infra, docker, ci-cd, environment |

Split large clusters to ensure minimum 5 clusters. Add standard cross-cutting prompts to guarantee ≥10 total.

### 3. Every Prompt Must Reference ADRs

Each implementation prompt must include:
- The specific ADRs that govern that build step (by ID and title)
- The relevant DDD bounded context details (if available)
- What to import from previously built steps
- Concrete implementation requirements (not vague instructions)
- London School TDD requirement

### 4. Renumber Sequentially

After all prompts are generated, renumber them `prompt-001` through `prompt-N` and update the execution-plan.json.

## Consequences

### Positive
- Developers/agents receive actionable, domain-specific implementation guidance
- Each prompt is self-contained and can be executed independently
- ADR traceability flows through to implementation

### Negative
- More prompts = more files to manage
- Cross-cutting prompts may overlap with context-specific ones

## Implementation

Files to modify:
- `src/pipeline/phase2/phases/prompt-generator.ts` — `generateFromDDDContexts()`, `generateFromADRsOnly()`, `clusterADRs()`, new `buildAggregatePrompt()`, `buildCrossCuttingPrompts()`, `buildInfrastructurePrompts()`
