# ADR-032: 7-Pass Enterprise Pipeline Architecture

**Status:** Accepted
**Date:** 2026-03-17
**Deciders:** Platform Architecture Team
**Supersedes:** None
**Related:** ADR-028 (agent utilization), ADR-030 (capability graph), ADR-033 (DecisionGraph), ADR-034 (artifact package)

## Context

The Agentics platform currently executes agents in a loosely coordinated manner — agents are dispatched based on keyword matching and capability graph routing, but there is no enforced pipeline structure that guarantees deterministic, ordered execution across the full analysis lifecycle.

Enterprise buyers (CIOs, CTOs, governance committees) expect a predictable, repeatable process — not a variable AI response. Consulting firms like McKinsey, Accenture, and Capgemini deliver structured engagement phases. Our platform must do the same, automatically.

The ACTION_ITEMS document defines a 7-pass pipeline that transforms every user prompt into a complete enterprise decision package. This ADR formalizes that pipeline as the primary execution model.

## Decision

We adopt a **7-pass sequential pipeline** as the canonical execution model for all enterprise decision analyses. Each pass has defined inputs, agents, outputs, and exit criteria. Passes execute in order, though agents within a pass execute concurrently.

### Pass Definitions

#### Pass 1 — Problem Intelligence
**Purpose:** Understand the problem, decompose it, build a structured execution plan.

| Component | Agents |
|-----------|--------|
| LLM-CoPilot | Planner, Decomposer, Objective Clarifier, Intent Classifier, Meta-Reasoner |
| LLM-Memory-Graph | Conversation Memory, Prompt Lineage, Decision Memory, Knowledge Graph Builder |

**Inputs:** User prompt, organizational context, prior decision lineage.
**Outputs:** Problem definition, business context, technical scope, initial architecture hypotheses, execution plan.
**Exit Criteria:** Problem definition is non-empty, at least one architecture hypothesis exists, execution plan has ≥1 phase.

#### Pass 2 — Simulation & Scenario Modeling
**Purpose:** Generate deployment, failure, scaling, and integration scenarios; assess operational risk and model/prompt reliability.

| Component | Agents |
|-----------|--------|
| LLM-Simulator | What-If Simulation, Scenario Generator |
| LLM-Sentinel | Anomaly Detection, Drift Detection, Incident Correlation, Root Cause Analysis |
| LLM-Test-Bench | Hallucination Detection, Faithfulness Verification, Bias Detection, Stress Test, Red Team, Adversarial Prompt |

**Inputs:** Problem definition and execution plan from Pass 1.
**Outputs:** Scenario matrix, risk signal map, model reliability report.
**Exit Criteria:** ≥3 scenarios generated, risk signals classified, reliability score computed.

**See also:** ADR-035 (Simulation & Scenario Modeling detail).

#### Pass 3 — Architecture & Prototype Generation
**Purpose:** Produce SPARC specifications, ADRs, DDD artifacts, TDD outputs, executable prototypes, SDK interfaces, and integration layers.

| Component | Agents |
|-----------|--------|
| LLM-Orchestrator | Workflow Orchestrator, Task Scheduler, Dependency Resolver, Retry & Recovery, Parallelization, State Machine, Swarm Coordinator |
| LLM-Forge | SDK Generator, CLI Command Generator, API Translation, Version Compatibility |
| LLM-Connector-Hub | ERP Surface, Database Query, Webhook Listener, Event Normalization, Auth/Identity |

**Inputs:** Problem definition, scenario matrix, architecture hypotheses from Passes 1-2.
**Outputs:** System architecture, integration map, data flows, service boundaries, generated prototype, ERP integration endpoints, API contracts, SDK interfaces.
**Exit Criteria:** Architecture document is non-empty, at least one prototype endpoint exists, integration map covers all detected external systems.

**Note:** Existing ADRs 027, 028, 029, and PIPELINE 001-015 govern the content quality and fidelity of this pass.

#### Pass 4 — Governance, Compliance & CostOps
**Purpose:** Produce enterprise governance artifacts — security analysis, policy compliance, financial modeling, governance readiness.

| Component | Agents |
|-----------|--------|
| LLM-Shield | Prompt Injection Detection, PII Detection, Data Redaction, Secrets Leakage, Toxicity Detection, Safety Boundary, Content Moderation, Model Abuse Detection, Credential Exposure |
| LLM-Policy-Engine | Policy Enforcement, Constraint Solver, Approval Routing |
| LLM-CostOps | Cost Attribution, Cost Forecasting, Budget Enforcement, ROI Estimation, Cost-Performance Tradeoff |
| LLM-Governance-Dashboard | Governance Audit, Change Impact, Usage Oversight |

**Inputs:** Architecture from Pass 3, simulation data from Pass 2, problem context from Pass 1.
**Outputs:** Security exposure analysis, policy compliance report, TCO/ROI projections, governance readiness report, audit trail.
**Exit Criteria:** Security scan complete, compliance analysis covers detected regulatory domains, cost model has ≥1 year projection.

**See also:** ADR-036 (Governance, Compliance & CostOps detail).

#### Pass 5 — Decision Artifacts
**Purpose:** Generate the executive decision package from all prior pass outputs.

| Component | Agents |
|-----------|--------|
| Apex Decision Layer | Decision Agent, Executive Summary Agent, Decision Memo Agent, Risk Scoring Agent |
| Diligence Artifacts | Documentation Generator |

**Inputs:** All outputs from Passes 1-4.
**Outputs:** The 15 deterministic enterprise artifacts defined in ADR-034.
**Exit Criteria:** All 15 artifacts generated, Decision Confidence Score computed, Provenance Manifest complete.

**See also:** ADR-037 (Apex Decision Layer detail), ADR-034 (artifact package).

#### Pass 6 — ERP Prototype Deployment
**Purpose:** Deploy the generated prototype to the target ERP/infrastructure environment.

| Component | Agents |
|-----------|--------|
| ERP-Surface | ERP Integration Agent |

**Inputs:** Prototype from Pass 3, deployment plan from Pass 5.
**Outputs:** Deployed service endpoints, integration verification results.
**Exit Criteria:** At least one endpoint responds successfully, integration test passes.

**Note:** Existing ADRs 029 and PIPELINE 001/007/008 govern ERP detection and deployment fidelity.

#### Pass 7 — Observability & Continuous Learning
**Purpose:** Monitor deployed prototype, collect telemetry, learn from outcomes.

| Component | Agents |
|-----------|--------|
| LLM-Observatory | Telemetry Collector, Usage Pattern, Failure Classification, Health Check, SLA Enforcement, Visualization Spec |
| LLM-Latency-Lens | Latency Analysis, Cold Start Mitigation |
| LLM-Incident-Manager | Incident Escalation, Post-Mortem Generator, Human-in-the-Loop |
| RuVector-Service | Approval Learning, Feedback Assimilation |

**Inputs:** Deployed endpoints from Pass 6, decision artifacts from Pass 5.
**Outputs:** Telemetry dashboards, performance diagnostics, incident reports, learned patterns fed back to Memory-Graph.
**Exit Criteria:** Telemetry collection active, at least one health check passes, learning loop registered.

**See also:** ADR-038 (Observability & Continuous Learning detail).

### Pipeline Orchestration Rules

1. **Passes execute sequentially** (1 → 2 → 3 → 4 → 5 → 6 → 7). A pass cannot begin until the prior pass's exit criteria are met.
2. **Agents within a pass execute concurrently** via the existing swarm orchestration (hierarchical topology, max 8 agents per pass).
3. **All agent outputs write to the DecisionGraph** (ADR-033) — never to isolated local state.
4. **Pass failures are non-fatal.** If a pass cannot meet exit criteria, it records a degraded status in the DecisionGraph and the pipeline continues. The Decision Confidence Score (Pass 5) reflects any degradation.
5. **The pipeline is idempotent.** Re-running a pass with the same inputs produces the same outputs.
6. **Provenance tracing is active throughout** (ADR-039). Every agent invocation is recorded.

### Pipeline Entry Points

- **Full pipeline:** `agentics ask "<prompt>"` — runs all 7 passes.
- **Partial pipeline:** `agentics ask "<prompt>" --passes 1-5` — runs passes 1 through 5 only (e.g., skip deployment and observability for analysis-only runs).
- **Single pass:** `agentics ask "<prompt>" --pass 4` — runs only the specified pass (requires prior pass outputs in DecisionGraph).

## Consequences

### Positive
- Every execution follows the same deterministic structure — enterprise buyers get predictable output.
- Pipeline phases map 1:1 to consulting engagement phases — familiar to enterprise procurement.
- Concurrent agent execution within passes keeps wall-clock time manageable.
- Partial pipeline support enables lightweight analysis runs without deployment overhead.

### Negative
- Sequential pass ordering adds latency compared to fully parallel dispatch.
- Exit criteria enforcement may block the pipeline on slow or failing agents.
- Pipeline model is opinionated — some use cases may not need all 7 passes.

### Mitigations
- Pass skipping (`--passes`, `--pass`) addresses unnecessary pass overhead.
- Degraded-status passthrough prevents hard blocks from non-critical failures.
- Per-pass timeout configuration prevents indefinite hangs.
