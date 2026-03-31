# ADR-074: Pipeline-Generated Code Must Use the Full Agentics Platform

## Status: IMPLEMENTED

## Date: 2026-03-31

## Context

The Agentics platform has ~50 deployed services housing 109 agents across 9 phases, organized into foundational tooling (Phase 1-3), governance and FinOps (Phase 4), ecosystem (Phase 5-6), intelligence (Phase 7), integration bundles (Phase 8), unified platform (Phase 9), and Layer 4 infrastructure. These are not external systems — they are the platform's infrastructure. Generated applications run on top of them the same way they run on PostgreSQL or Cloud Run.

**The critical gap:** The pipeline calls agents during generation (via `agentics ask`) for planning and architecture. But the generated codebase operates as a standalone application that never uses a single platform service at runtime. It reimplements telemetry, audit logging, and circuit breakers locally — and skips cost tracking, security scanning, anomaly detection, workflow orchestration, lineage persistence, and everything else entirely.

This means the platform's value proposition — 109 agents handling cross-cutting concerns so domain code stays clean — is not delivered. The generated application is an island.

### Root Cause

The codegen phases have no awareness of the platform service catalog. They produce self-contained applications. The generators don't know these services exist, so they build local replacements for some capabilities and skip the rest entirely.

## Decision

### The Complete Platform Service Catalog

Every service below is deployed on GCP. The table maps each service to **when** it should be used (build-time during pipeline execution, runtime in the generated application, or both) and **what** it does for the generated application.

---

#### Phase 1 — Foundational Tooling

| # | Service | Agents | Used At | Role in Generated Application |
|---|---------|--------|---------|-------------------------------|
| 1 | **LLM-Test-Bench** | Benchmark Runner, Model Comparator, Regression Detection, Quality Scoring, Hallucination Detection, Faithfulness Verification, Bias Detection, Prompt Sensitivity, Output Consistency, Stress Test, Red Team, Adversarial Prompt, Golden Dataset Validator, Synthetic Data Generator (14) | **Build-time + Runtime** | Build: validate generated code quality, benchmark simulation engine, red-team the API before deployment. Runtime: regression-test simulation outputs against golden datasets, detect output quality drift over time. |
| 2 | **LLM-Observatory** | Telemetry Collector, Usage Pattern, Failure Classification, Health Check, SLO/SLA Enforcement, Post-Mortem Generator, Visualization Spec (7) | **Runtime** | Replace `ConsoleTelemetry` and `ConsoleEventBus`. All telemetry spans, domain events, and performance metrics flow here. SLO enforcement monitors latency and error rate commitments. See ADR-077. |
| 3 | **LLM-Shield** | Prompt Injection Detection, PII Detection, Secrets Leakage, Toxicity Detection, Content Moderation, Model Abuse Detection, Credential Exposure, Safety Boundary, Data Redaction (9) | **Runtime** | Scan all inbound mutations and outbound ERP payloads. Blocking dependency. See ADR-076. |

#### Phase 2 — Operational Intelligence

| # | Service | Agents | Used At | Role in Generated Application |
|---|---------|--------|---------|-------------------------------|
| 4 | **LLM-Sentinel** | Anomaly Detection, Drift Detection, Alerting, Incident Correlation, Root Cause Analysis (5) | **Runtime** | Detect anomalies in simulation outputs, alert on ERP circuit breaker events, correlate failures across services, perform RCA when things go wrong. See ADR-077. |
| 5 | **LLM-Memory-Graph** | Conversation Memory, Prompt Lineage, Decision Memory, Knowledge Graph Builder, Memory Retrieval, Long-Term Pattern (6) | **Runtime** | Persist simulation lineage (replaces in-process SHA-256 hashing). Store decision history across scenario comparisons. Build knowledge graph of supplier-risk-insurance relationships over time. Enable retrieval of past decisions for audit and learning. See ADR-079. |
| 6 | **LLM-Latency-Lens** | Latency Analysis, Cold Start Mitigation (2) | **Build-time + Runtime** | Build: profile simulation engine latency, identify cold start bottlenecks in Cloud Run. Runtime: continuous latency profiling on API endpoints, track p50/p95/p99 per operation type. |
| 7 | **LLM-Forge** | SDK Generator, CLI Command Generator, API Translation, Version Compatibility (4) | **Build-time** | Generate typed TypeScript and Rust clients for external APIs (Oracle Fusion Cloud, BigQuery). Generate CLI commands for the generated application. Ensure version compatibility when Oracle API versions change. See ADR-078. |

#### Phase 3 — Automation & Resilience

| # | Service | Agents | Used At | Role in Generated Application |
|---|---------|--------|---------|-------------------------------|
| 8 | **LLM-Edge-Agent** | Tool Invocation, Circuit Breaker, Failover, Execution Guard, Caching Strategy (5) | **Runtime** | Replace the hand-built circuit breaker in `erp-client/client.ts`. Provide caching for repeated simulation queries. Manage failover when Oracle Fusion Cloud is unavailable. Execution Guard validates operations before they run. See ADR-079. |
| 9 | **LLM-Auto-Optimizer** | Self-Optimizing, Token Optimization, Model Selection (3) | **Runtime** | Optimize any LLM calls in the generated system (e.g., executive summary generation, scenario narrative). Select optimal model for each operation type. Reduce token consumption over time through feedback loops. See ADR-079. |
| 10 | **LLM-Incident-Manager** | Incident Escalation, Post-Mortem Generator, Human-in-the-Loop (3) | **Runtime** | Escalate ERP failures, simulation anomalies, and security events through proper channels. Generate post-mortems automatically. Gate critical operations for human review (extends the existing governance model). See ADR-079. |
| 11 | **LLM-Orchestrator** | Workflow Orchestrator, Task Scheduler, Dependency Resolver, Retry & Recovery, Parallelization, State Machine, Swarm Coordinator (7) | **Runtime** | Orchestrate multi-step simulation pipelines. Manage the approval workflow state machine (replaces hand-coded state transitions in Oracle ACL). Schedule recurring risk re-assessments. Coordinate parallel scenario execution. See ADR-079. |

#### Phase 4 — Governance & FinOps

| # | Service | Agents | Used At | Role in Generated Application |
|---|---------|--------|---------|-------------------------------|
| 12 | **LLM-CostOps** | Cost Attribution, Cost Forecasting, Budget Enforcement, ROI Estimation, Cost-Performance Tradeoff (5) | **Runtime** | Track every operation's cost. Produce attribution reports, forecasts, and ROI analysis. Enforce budget limits. This is how the business case gets made. See ADR-075. |
| 13 | **LLM-Governance-Dashboard** | Governance Audit, Change Impact, Usage Oversight (3) | **Runtime** | Replace in-memory audit arrays in Oracle ACL. Provide compliance views for audit teams. Track change impact across simulations and ERP writebacks. Monitor usage patterns per team/role. See ADR-080. |
| 14 | **LLM-Policy-Engine** | Policy Enforcement, Constraint Solver, Approval Routing (3) | **Runtime** | Replace hand-coded `requireRole()` middleware with declarative policies. Solve complex constraint combinations (e.g., "this writeback requires approval from someone in risk AND finance"). Route approvals to the right person based on domain, amount, and risk level. See ADR-080. |

#### Phase 5 — Ecosystem & Collaboration

| # | Service | Agents | Used At | Role in Generated Application |
|---|---------|--------|---------|-------------------------------|
| 15 | **LLM-Registry** | Registry Indexing, Agent Reputation, Template Bootstrap (3) | **Build-time + Runtime** | Build: bootstrap agent configurations from registry templates. Runtime: register the generated application's agents/models. Track reputation scores for external data sources used in simulation. See ADR-080. |
| 16 | **LLM-Marketplace** | Marketplace Packaging, Deprecation (2) | **Build-time** | Package generated application components for reuse. Manage deprecation notices when simulation models or risk methodologies are superseded. |
| 17 | **LLM-Analytics-Hub** | Consensus, Strategic Recommendation (2) | **Runtime** | Cross-system analytics combining simulation results, cost data, observability metrics, and governance events. Produce strategic recommendations (e.g., "based on 50 simulation runs, Scenario B consistently outperforms on cost-adjusted resilience"). Build consensus views across multiple stakeholders' scenario preferences. See ADR-080. |

#### Phase 6 — Core Infrastructure

| # | Service | Agents | Used At | Role in Generated Application |
|---|---------|--------|---------|-------------------------------|
| 18 | **LLM-Config-Manager** | Config Validation (1) | **Build-time + Runtime** | Build: validate generated configuration files. Runtime: validate config changes at startup, manage secrets rotation. |
| 19 | **LLM-Schema-Registry** | Schema Validation (1) | **Build-time + Runtime** | Build: validate generated API schemas and event contracts. Runtime: validate telemetry event schemas before sending to Observatory, validate ERP wire format schemas before sending to Oracle. |
| 20 | **LLM-Connector-Hub** | ERP Surface, Database Query, Webhook Listener, Event Normalization, Auth/Identity (5) | **Runtime** | Replace the custom `erp-client/client.ts` with the platform's standardized ERP adapter. Manage database queries through the platform's query layer. Receive webhooks from Oracle Fusion Cloud for change notifications. Normalize events from heterogeneous sources. Handle auth/identity for external system connections. See ADR-079. |

#### Phase 7 — Intelligence & Expansion

| # | Service | Agents | Used At | Role in Generated Application |
|---|---------|--------|---------|-------------------------------|
| 21 | **LLM-CoPilot-Agent** | Planner, Config Validation, Decomposer, Objective Clarifier, Intent Classifier, Reflection, Meta-Reasoner (7) | **Build-time + Runtime** | Build: plan implementation approach, decompose complex requirements, clarify ambiguous objectives. Runtime: classify user intent on API requests (is this a simulation request or a data query?). Reflect on simulation quality. Meta-reason about whether additional scenarios should be recommended. See ADR-078. |
| 22 | **LLM-Simulator** | What-If Simulation, Scenario Generator (2) | **Build-time + Runtime** | Build: stress-test the generated system without incurring API costs. Runtime: generate additional what-if scenarios dynamically. Allow users to ask "what if we add a supplier in Southeast Asia?" without manually defining the full scenario. See ADR-078. |
| 23 | **LLM-Benchmark-Exchange** | Benchmark Publication (1) | **Build-time** | Publish simulation engine benchmarks to the platform leaderboard. Compare against community baselines for similar domain workloads. |
| 24 | **LLM-Inference-Gateway** | Inference Routing (1) | **Runtime** | Route LLM inference requests to the optimal backend (Anthropic, OpenAI, Ollama, vLLM) based on latency, cost, and capability requirements. Used whenever the generated application makes LLM calls (narrative generation, executive summaries, etc.). |
| 25 | **LLM-Data-Vault** | Data Access Control, Dataset Anonymization (2) | **Runtime** | Enforce access control on sensitive datasets (supplier financials, contract terms, insurance pricing). Anonymize data for non-privileged users or external reporting. Required for GDPR, SOX compliance on data access. See ADR-080. |
| 26 | **LLM-Research-Lab** | Hypothesis, Experimental Metric (2) | **Build-time + Runtime** | Build: validate domain hypotheses (e.g., "does dual-sourcing reduce risk by >20%?"). Runtime: track experimental metrics on new simulation methodologies. A/B test different risk scoring algorithms. |

#### Phase 8 — Core Integration Bundles

These compose agents from lower layers into opinionated workflows. Generated applications can call the bundle instead of wiring individual services.

| # | Bundle | Composes | Role in Generated Application |
|---|--------|----------|-------------------------------|
| 27 | **LLM-Intelligence-Core** | Test-Bench + Observatory + Sentinel + Latency-Lens + Analytics-Hub + Schema-Registry | Unified analytics and drift engine. Single call for "give me full operational intelligence on this simulation run." |
| 28 | **LLM-Security-Core** | Shield + Edge-Agent + Incident-Manager + Policy-Engine + Config-Manager | Unified security stack. Single call for "scan this request, enforce policy, and escalate if needed." |
| 29 | **LLM-Automation-Core** | Forge + Auto-Optimizer + Orchestrator + Connector-Hub | Unified automation. Single call for "optimize this workflow, manage retries, connect to external systems." |
| 30 | **LLM-Governance-Core** | CostOps + Governance-Dashboard + Policy-Engine + Analytics-Hub + Config-Manager + Schema-Registry | Unified governance. Single call for "audit this operation, track cost, enforce policy, validate schema." |
| 31 | **LLM-Data-Core** | Memory-Graph + Registry + Data-Vault + Config-Manager + Schema-Registry | Unified data layer. Single call for "persist this decision, control access, validate schema." |
| 32 | **LLM-Ecosystem-Core** | Marketplace + Analytics-Hub + Benchmark-Exchange | Community and sharing layer. |
| 33 | **LLM-Research-Core** | Schema-Registry + Simulator + Research-Lab | Experimentation and hypothesis testing. |
| 34 | **LLM-Interface-Core** | Forge + Config-Manager + Connector-Hub + CoPilot-Agent + Inference-Gateway | Developer-facing tooling. SDK generation, config management, inference routing. |

#### Phase 9 — Unified Platform (Apex Layer)

| # | Service | Agents | Role in Generated Application |
|---|---------|--------|-------------------------------|
| 35 | **Agentics Dev Platform** | Decision Agent, Executive Summary Agent, Decision Memo Agent, Risk Scoring Agent (4) | The apex decision layer. Produces go/no-go decisions, executive summaries, decision memos, and risk scores by synthesizing outputs from all lower layers. Every generated application should use this for its final decision-grade outputs. |

#### Layer 4 — Infrastructure & Specialized Services

| # | Service | Role in Generated Application |
|---|---------|-------------------------------|
| 36 | **agentics-diligence-artifacts** | Generate due diligence documentation for enterprise deployments |
| 37 | **agentics-deployment-intent** | Capture and validate deployment intentions before execution |
| 39 | **agentics-simulation-planner** | Plan simulation strategies — which scenarios, which parameters, which suppliers to include |
| 40 | **agentics-simulator-runner** | Execute simulation runs in isolated environments |
| 41 | **agentics-deployment-exporters** | Export deployment artifacts as IaC (Terraform, Pulumi) |
| 42 | **agentics-org-manifests** | Manage organizational configuration — teams, roles, permissions |
| 43 | **agentics-cli** | CLI interface to the full platform |
| 44 | **agentics-orchestration-engine** | Core workflow execution engine underlying LLM-Orchestrator |
| 44b | **infra** | Infrastructure provisioning and management |
| 45 | **integrations** | External system integration adapters |
| 46 | **ruvector-service** | Vector operations, approval learning, feedback assimilation |
| 47 | **enterprise-roi-engine** | Enterprise-grade ROI calculations — goes deeper than CostOps ROI agent, models business impact across departments |
| 48 | **erp-surface** | Standardized ERP adapter layer — replaces hand-built Oracle client with platform-managed adapter |
| 49 | **agentics-contracts** | Contract management and validation for inter-service agreements |
| 50 | **agentics-results-index** | Index and search across all simulation results, decisions, and outputs |
| 51 | **agentics-usage-ledger** | Immutable usage ledger for metering and billing |
| 52 | **agentics-execution-engine** | Actual execution of approved operations (writeback, deployment, etc.) |
| 53 | **agentics-enforcement** | Runtime policy enforcement — the execution layer for Policy-Engine decisions |
| 54 | **platform-agents** | Platform-level agents for cross-cutting operations |

---

### Usage Lifecycle

The platform services participate at every stage of the application lifecycle:

```
PIPELINE EXECUTION (build-time)
│
├─ Planning ──────── CoPilot (planner, decomposer, clarifier)
├─ Architecture ──── CoPilot (meta-reasoner), Registry (template bootstrap)
├─ Codegen ───────── Forge (SDK generation), Config-Manager (config validation)
├─ Testing ───────── Test-Bench (benchmark, red-team, quality), Simulator (stress-test)
├─ Validation ────── Schema-Registry (contract validation), Latency-Lens (profiling)
├─ Benchmarking ──── Benchmark-Exchange (publish), Research-Lab (hypothesis validation)
│
DEPLOYMENT
│
├─ Artifacts ─────── diligence-artifacts, deployment-intent, deployment-exporters
├─ Config ────────── Config-Manager, org-manifests
├─ Infrastructure ── infra, execution-engine
│
RUNTIME (every request in the generated application)
│
├─ Inbound ───────── Shield (scan) → Policy-Engine (authorize) → CoPilot (classify intent)
├─ Processing ────── Domain logic (generated) + Orchestrator (workflow) + Edge-Agent (resilience)
├─ External calls ── Connector-Hub / erp-surface (ERP) + Inference-Gateway (LLM) + Auto-Optimizer (tuning)
├─ Outbound ──────── Shield (scan outbound) → Data-Vault (anonymize if needed)
├─ Observability ─── Observatory (telemetry) + Sentinel (anomaly) + Latency-Lens (profiling)
├─ Governance ────── Governance-Dashboard (audit) + CostOps (cost) + Memory-Graph (lineage)
├─ Incidents ─────── Incident-Manager (escalation) + Sentinel (RCA)
├─ Analytics ─────── Analytics-Hub (cross-system) + Results-Index (search) + Usage-Ledger (metering)
│
DECISION OUTPUT
│
├─ Synthesis ─────── Agentics Dev Platform (executive summary, decision memo, risk score)
├─ ROI ───────────── enterprise-roi-engine + CostOps
├─ Approval ──────── Policy-Engine (routing) + enforcement (execution) + Governance-Dashboard (audit)
└─ Writeback ─────── erp-surface (standardized) + execution-engine (approved ops)
```

### What the Codegen Prompt Must Include

The LLM codegen prompt (ADR-067) must include the full service catalog. The prompt should specify which services are available, how to call them (uniform HTTP + GCP identity token), and the constraint: **do not reimplement what the platform provides.**

### Availability Tiers

| Tier | Services | If Unavailable |
|---|---|---|
| **Must have** | Shield, Policy-Engine, enforcement | Block the request. |
| **Should have** | CostOps, Governance-Dashboard, Memory-Graph, erp-surface, Data-Vault | Queue locally, retry. |
| **Operational** | Observatory, Sentinel, Latency-Lens, Analytics-Hub, Results-Index | Log locally, continue. |
| **Build-only** | Test-Bench, Forge, Simulator, CoPilot, Benchmark-Exchange, Research-Lab, Marketplace | N/A at runtime. |

### What Stays in Generated Code

Only domain-specific logic that is unique to the prompt:
- Domain types and models
- Business logic (risk assessment, pricing, scenario orchestration)
- Domain-specific API endpoints and seed data
- Rust/WASM compute engines for domain math

Everything else — security, cost, observability, governance, lineage, resilience, orchestration, ERP access, inference routing, data anonymization, incident management, analytics, decision synthesis — is platform infrastructure.

## Consequences

### Positive
- Generated applications use the full platform — all 50 services, 109 agents
- Every capability the platform provides is available without reimplementation
- Platform services improve once, all generated applications benefit
- Generated code is dramatically smaller — just domain logic
- Business case data (CostOps + enterprise-roi-engine) is produced automatically
- Security posture (Shield + Policy-Engine + enforcement) is comprehensive
- Operational intelligence (Observatory + Sentinel + Analytics-Hub) is centralized

### Negative
- Platform services must be deployed and reachable at runtime
- Local development needs staging endpoints or mock mode
- Codegen prompt becomes significantly longer with the full catalog
- Service-to-service authentication must be configured per deployment

## Implementation Priority

**CRITICAL.** Detailed ADRs for each service group:
- ADR-075: CostOps (business case)
- ADR-076: Shield (runtime security)
- ADR-077: Observatory + Sentinel (operational intelligence)
- ADR-078: Build-time services (Test-Bench, Forge, CoPilot, Simulator, Latency-Lens, Research-Lab)
- ADR-079: Runtime resilience + orchestration (Edge-Agent, Auto-Optimizer, Incident-Manager, Orchestrator, Connector-Hub, Memory-Graph)
- ADR-080: Governance + ecosystem (Governance-Dashboard, Policy-Engine, Registry, Analytics-Hub, Data-Vault, Marketplace)
- ADR-081: Layer 4 infrastructure + Apex (enterprise-roi-engine, erp-surface, execution-engine, enforcement, results-index, usage-ledger, Agentics Dev Platform)

## Related ADRs
- ADR-067: LLM-Driven Code Generation
- ADR-068: Domain Route RBAC and Telemetry Parity
- ADR-075 through ADR-081: Service group implementation details
