# AGENT_CAPABILITY_REGISTRY.md

# Agentics Dev Platform — Agent Capability Registry & Execution Pipeline

This document defines the **mandatory 12-phase execution pipeline** that the Agentics CLI follows when solving any business problem.

Every phase specifies its **mandatory agents** (run on every execution, unconditionally) and **optional agents** (activated based on problem domain and complexity). Mandatory agents are never optional or fallback — they execute on every run.

---

# End-to-End Execution Pipeline

```
Phase 0   Prompt Structuring
Phase 1   Simulation
Phase 2   Research
Phase 3   SPARC Generation
Phase 4   SPARC Handoff
Phase 5   ADR / DDD Architecture
Phase 6   Implementation Planning
Phase 7   Build (Integration-Aware)
Phase 8   Validation
Phase 9   Integration Mapping
Phase 10  Governance / FinOps
Phase 11  Decision Packaging
```

Phases execute in strict order. Each phase must complete before the next begins.

---

# Architecture Boundary

The platform enforces a strict layered boundary. Agentics never directly integrates with ERP vendors.

```
Agentics Platform
      |
      v
Implementation Build
      |
      v
Integration Connectors
      |
      v
ERP Surface
      |
      v
Enterprise ERP Systems
```

- **Agentics Platform** — orchestration, reasoning, and agent execution.
- **Implementation Build** — generated code, SDKs, and APIs.
- **Integration Connectors** — adapters for LLM providers, cloud services, databases, OAuth/SSO, messaging, DevOps, vector DBs, observability, payments, and automation APIs.
- **ERP Surface** — the only interface between the platform and enterprise systems. All ERP communication goes through surface endpoints.
- **Enterprise ERP Systems** — SAP, Oracle, Workday, NetSuite, etc. Never accessed directly.

---

# Phase 0 — Prompt Structuring

**Purpose:** Convert a raw problem statement into structured execution context for downstream phases.

| Attribute | Value |
|-----------|-------|
| Mandatory repo | `LLM-CoPilot-Agent` |
| Execution model | Sequential |
| Output | `PROMPT_CONTEXT.md` |

### Mandatory Agents

| Agent | Role |
|-------|------|
| Planner Agent | Breaks the problem into an execution plan |
| Objective Clarifier Agent | Resolves ambiguity in the user's intent |
| Intent Classifier Agent | Classifies the problem domain |
| Decomposer Agent | Decomposes the problem into sub-tasks |

### Optional Agents

| Agent | When Used |
|-------|-----------|
| Reflection Agent | When the prompt requires self-evaluation of reasoning |
| Meta-Reasoner Agent | When multi-step reasoning strategies must be selected |
| Config Validation Agent | When existing configuration must be validated before execution |

---

# Phase 1 — Simulation

**Purpose:** Evaluate viability of the proposed solution before committing to architecture.

| Attribute | Value |
|-----------|-------|
| Mandatory repo | `LLM-Simulator` |
| Execution model | Sequential |
| Output | `SIMULATION_ANALYSIS.md` |

### Mandatory Agents

| Agent | Role |
|-------|------|
| What-If Simulation Agent | Runs hypothetical execution scenarios |
| Scenario Generator Agent | Generates alternative scenarios for comparison |

### Optional Agents

| Agent | When Used |
|-------|-----------|
| Consensus Agent | When multiple competing scenarios require agreement |
| Strategic Recommendation Agent | When business-level recommendations are needed from simulation results |

---

# Phase 2 — Research

**Purpose:** Establish technical feasibility and analytical grounding before architecture begins.

| Attribute | Value |
|-----------|-------|
| Mandatory repo | `LLM-Research-Lab` |
| Execution model | Sequential |
| Output | `RESEARCH_NOTES.md` |

### Mandatory Agents

| Agent | Role |
|-------|------|
| Hypothesis Agent | Formulates and tests technical hypotheses |
| Experimental Metric Agent | Defines and evaluates success metrics |

### Optional Agents

| Agent | When Used |
|-------|-----------|
| Benchmark Publication Agent | When research results should be published as benchmarks |
| Knowledge Graph Builder Agent | When domain knowledge must be structured as a graph |
| Long-Term Pattern Agent | When historical patterns inform the current problem |

---

# Phase 3 — SPARC Generation

**Purpose:** Generate the engineering architecture using the SPARC methodology (Specification, Pseudocode, Architecture, Refinement, Completion).

| Attribute | Value |
|-----------|-------|
| Mandatory repo | `agentics-diligence-artifacts` |
| Execution model | Ruflo swarm |
| Output | `SPECIFICATION.md`, `PSEUDOCODE.md`, `ARCHITECTURE.md`, `REFINEMENT.md`, `COMPLETION.md` |

### Mandatory Agents

| Agent | Role |
|-------|------|
| SPARC Specification Agent | Generates formal specification |
| SPARC Pseudocode Agent | Produces pseudocode from specification |
| SPARC Architecture Agent | Designs system architecture |
| SPARC Refinement Agent | Iteratively refines architecture and pseudocode |
| SPARC Completion Agent | Validates completeness of SPARC outputs |

### Optional Agents

| Agent | When Used |
|-------|-----------|
| Template Bootstrap Agent | When starting from a known template |
| Version Compatibility Agent | When cross-version constraints must be checked |
| Test Design Agent | When QE is requested — reviews specs for testability (ADR-083) |
| Requirements Traceability Agent | When QE is requested — traces specs to test anchors (ADR-083) |

---

# Phase 4 — SPARC Handoff

**Purpose:** Combine all SPARC outputs into a single handoff document without reinterpretation. The merge is deterministic — no reasoning or transformation is applied.

| Attribute | Value |
|-----------|-------|
| Mandatory repo | `agentics-diligence-artifacts` |
| Execution model | Deterministic sequential |
| Output | `SPARC_HANDOFF.md` |

### Mandatory Agents

| Agent | Role |
|-------|------|
| SPARC Merge Agent | Concatenates SPARC outputs into a unified handoff document |

### Optional Agents

None. This phase is deterministic and requires no optional agents.

---

# Phase 5 — ADR / DDD Architecture

**Purpose:** Generate Architecture Decision Records and Domain-Driven Design artifacts from the SPARC handoff.

| Attribute | Value |
|-----------|-------|
| Mandatory repo | `agentics-diligence-artifacts` |
| Execution model | Ruflo swarm |
| Output | `ADR-001.md` through `ADR-007.md`, `domain-model.md`, `context-map.md` |

### Mandatory Agents

| Agent | Role |
|-------|------|
| ADR Generation Agent | Produces architecture decision records |
| DDD Domain Model Agent | Generates the domain model |
| Context Map Agent | Maps bounded contexts and their relationships |

### Optional Agents

| Agent | When Used |
|-------|-----------|
| Architecture Decision Validator Agent | When ADRs require formal validation against constraints |
| Constraint Solver Agent | When conflicting architectural constraints must be resolved |
| Schema Validation Agent | When data schemas must be validated against the domain model |
| Defect Prediction Agent | When QE is requested — predicts risk hotspots from architecture (ADR-083) |
| Test Design Agent | When QE is requested — proposes test strategy per bounded context (ADR-083) |

---

# Phase 6 — Implementation Planning

**Purpose:** Generate an ordered sequence of build prompts that will drive Phase 7.

| Attribute | Value |
|-----------|-------|
| Mandatory repo | `LLM-CoPilot-Agent` |
| Execution model | Sequential |
| Output | `IMPLEMENTATION_PLAN.md`, `implementation_prompts.json` (10-30 build prompts) |

### Mandatory Agents

| Agent | Role |
|-------|------|
| Planner Agent | Creates the ordered implementation plan |
| Decomposer Agent | Breaks the plan into discrete build steps |
| Reflection Agent | Validates the plan for completeness and correctness |

### Optional Agents

| Agent | When Used |
|-------|-----------|
| Meta-Reasoner Agent | When build ordering requires multi-strategy reasoning |
| Strategic Recommendation Agent | When business priorities should influence build order |
| Coverage Gap Detection Agent | When QE is requested — flags planned work lacking a test path (ADR-083) |

---

# Phase 7 — Build (Integration-Aware)

**Purpose:** Execute the build prompts from Phase 6. Each build step runs as a Ruflo swarm internally; the steps themselves execute sequentially.

| Attribute | Value |
|-----------|-------|
| Mandatory repos | `LLM-Forge`, `integrations`, `LLM-Connector-Hub`, `erp-surface` |
| Execution model | Sequential build steps, each step uses Ruflo swarm internally |
| Output | Generated source code, SDKs, APIs, and integration bindings |

### Mandatory Agents

| Agent | Role |
|-------|------|
| SDK Generator Agent | Generates typed SDK bindings |
| API Translation Agent | Translates between API formats |
| Version Compatibility Agent | Ensures cross-version compatibility |
| Database Query Agent | Generates database integration code |
| Auth / Identity Agent | Implements OAuth/SSO and identity flows |
| Event Normalization Agent | Normalizes events across platforms |
| ERP Surface Agent | Produces ERP Surface endpoint bindings |
| ERP Integration Agent | Generates ERP-compatible output formats |

### Optional Agents

| Agent | When Used |
|-------|-----------|
| CLI Command Generator Agent | When CLI tooling must be generated |
| Tool Invocation Agent | When external tool calls must be orchestrated |
| Execution Guard Agent | When build steps require runtime safety guards |
| Caching Strategy Agent | When caching layers must be generated |
| Inference Routing Agent | When model routing logic must be built |
| Unit Test Generation Agent | When QE is requested — generates unit tests alongside code (ADR-083) |
| Integration Test Generation Agent | When QE is requested — generates integration tests across seams (ADR-083) |
| Property-Based Test Agent | When QE is requested — generates property-based tests with generators (ADR-083) |
| BDD Test Generation Agent | When QE is requested — generates Gherkin scenarios (ADR-083) |
| Coverage Analysis Agent | When QE is requested — reports coverage as build proceeds (ADR-083) |

### Build Responsibilities

During this phase the system must use connectors from the `integrations` repo for:

- LLM / inference providers
- Cloud services (AWS, GCP, Azure)
- Databases (SQL, NoSQL, graph)
- OAuth / SSO identity providers
- Messaging platforms (Slack, Teams, email)
- DevOps platforms (GitHub, GitLab, Jenkins)
- Vector databases
- Observability backends
- Payment processors
- Automation APIs

ERP systems are never directly integrated. All ERP output goes through ERP Surface endpoints.

---

# Phase 8 — Validation

**Purpose:** Evaluate the correctness, consistency, and safety of the built system.

| Attribute | Value |
|-----------|-------|
| Mandatory repo | `LLM-Test-Bench` |
| Execution model | Sequential |
| Output | Validation reports and test results. Per ADR-083, includes QE-sourced findings (test generation, coverage deltas, defect predictions, flaky detection, chaos results, traceability matrices) — all 14 `quality_engineering` agents are mandatory at this phase. |

### Mandatory Agents

| Agent | Role |
|-------|------|
| Quality Scoring Agent | Scores overall output quality |
| Output Consistency Agent | Verifies consistency across outputs |
| Hallucination Detection Agent | Detects fabricated or unsupported claims |
| Faithfulness Verification Agent | Verifies outputs are faithful to inputs |
| Test Design Agent | Designs the phase-8 test strategy (ADR-083) |
| Unit Test Generation Agent | Generates unit tests (ADR-083) |
| Integration Test Generation Agent | Generates integration tests (ADR-083) |
| Property-Based Test Agent | Generates property-based tests (ADR-083) |
| BDD Test Generation Agent | Generates Gherkin scenarios (ADR-083) |
| Coverage Analysis Agent | Analyzes line/branch/path/mutation coverage (ADR-083) |
| Coverage Gap Detection Agent | Flags uncovered paths weighted by risk (ADR-083) |
| Defect Prediction Agent | Predicts defect-prone areas (ADR-083) |
| Flaky Test Detection Agent | Detects flaky tests and recommends remediation (ADR-083) |
| Root Cause Analysis Agent | Traces causal chains for failures (ADR-083) |
| Requirements Traceability Agent | Builds requirements→tests→code traceability (ADR-083) |
| Chaos Engineering Agent | Runs fault-injection scenarios (ADR-083) |
| Test Execution Orchestrator Agent | Plans sharded test execution (ADR-083) |
| QE Reporting Agent | Produces QE status reports (ADR-083) |

### Optional Agents

| Agent | When Used |
|-------|-----------|
| Regression Detection Agent | When comparing against a previous baseline |
| Prompt Sensitivity Agent | When evaluating robustness to prompt variations |
| Stress Test Agent | When testing under load or adversarial conditions |
| Red Team Agent | When adversarial security testing is required |
| Adversarial Prompt Agent | When testing against prompt attacks |
| Bias Detection Agent | When evaluating for demographic or statistical bias |
| Golden Dataset Validator Agent | When validating against a known-good dataset |
| Synthetic Data Generator Agent | When test data must be generated |
| Model Comparator Agent | When comparing outputs across models |
| Benchmark Runner Agent | When running standardized benchmarks |

---

# Phase 9 — Integration Mapping

**Purpose:** Connect the built system to external platforms using integration connectors. This phase maps generated code to real-world service endpoints.

| Attribute | Value |
|-----------|-------|
| Mandatory repos | `integrations`, `LLM-Connector-Hub`, `erp-surface` |
| Execution model | Sequential |
| Output | Integration configuration and connector bindings |

### Mandatory Agents

| Agent | Role |
|-------|------|
| Database Query Agent | Maps database connectors to the built system |
| Auth / Identity Agent | Configures authentication and identity flows |
| Event Normalization Agent | Normalizes event formats for target platforms |
| Webhook Listener Agent | Configures inbound webhook endpoints |
| ERP Surface Agent | Maps outputs to ERP Surface endpoints |

### Optional Agents

| Agent | When Used |
|-------|-----------|
| Schema Validation Agent | When integration schemas must be validated |
| Config Validation Agent | When connector configuration must be verified |
| API Translation Agent | When API format translation is needed |
| Integration Test Generation Agent | When QE is requested — integration tests for connector wiring (ADR-083) |
| Chaos Engineering Agent | When QE is requested — fault injection on integration seams (ADR-083) |

---

# Phase 10 — Governance / FinOps

**Purpose:** Evaluate risk, cost, compliance, and return on investment for the generated solution.

| Attribute | Value |
|-----------|-------|
| Mandatory repos | `LLM-Policy-Engine`, `LLM-CostOps`, `enterprise-roi-engine` |
| Execution model | Sequential |
| Output | Governance reports, cost analysis, ROI projections |

### Mandatory Agents

| Agent | Role |
|-------|------|
| Policy Enforcement Agent | Enforces organizational and regulatory policies |
| Cost Attribution Agent | Attributes costs to components and services |
| ROI Estimation Agent | Projects return on investment |
| Enterprise Strategy Agent | Evaluates strategic alignment with enterprise goals |

### Optional Agents

| Agent | When Used |
|-------|-----------|
| Budget Enforcement Agent | When hard budget constraints exist |
| Cost Forecasting Agent | When forward-looking cost projections are needed |
| Constraint Solver Agent | When competing policy constraints must be resolved |
| Usage Oversight Agent | When usage patterns must be audited |
| Change Impact Agent | When evaluating the blast radius of changes |
| Governance Audit Agent | When a formal audit trail is required |
| QE Reporting Agent | When QE is requested — emits QE metrics (coverage %, flake rate, defects) for governance review (ADR-083) |

---

# Phase 11 — Decision Packaging

**Purpose:** Create board-level and executive outputs that summarize the entire pipeline execution.

| Attribute | Value |
|-----------|-------|
| Mandatory repos | `Agentics-Dev-Platform`, `agentics-diligence-artifacts` |
| Execution model | Sequential |
| Output | Executive decision package |

### Mandatory Agents

| Agent | Role |
|-------|------|
| Decision Agent | Produces go/no-go recommendations |
| Executive Summary Agent | Generates executive-level summaries |
| Decision Memo Agent | Creates structured decision memos |
| Risk Scoring Agent | Scores risk across dimensions |
| Documentation Generator Agent | Produces final documentation artifacts |

### Optional Agents

| Agent | When Used |
|-------|-----------|
| Consensus Agent | When multi-stakeholder agreement is needed |
| Strategic Recommendation Agent | When strategic recommendations accompany the decision package |

---

# Infrastructure Agents (Available to All Phases)

Infrastructure agents are global. They are not bound to any single phase and are available to every phase on demand.

---

## Orchestration — `LLM-Orchestrator`

| Agent | Role |
|-------|------|
| Workflow Orchestrator Agent | Coordinates multi-step workflows |
| Task Scheduler Agent | Schedules and prioritizes tasks |
| Dependency Resolver Agent | Resolves execution dependencies between tasks |
| Retry & Recovery Agent | Handles retries and failure recovery |
| State Machine Agent | Manages state transitions across pipeline phases |
| Swarm Coordinator Agent | Coordinates Ruflo swarm execution within phases |

---

## Safety — `LLM-Shield`

| Agent | Role |
|-------|------|
| Prompt Injection Detection Agent | Detects and blocks prompt injection attacks |
| PII Detection Agent | Identifies personally identifiable information |
| Data Redaction Agent | Redacts sensitive data from outputs |
| Content Moderation Agent | Moderates content for policy compliance |
| Safety Boundary Agent | Enforces safety boundaries on agent behavior |
| Secrets Leakage Agent | Detects leaked secrets and credentials |
| Credential Exposure Agent | Identifies exposed credentials in outputs |

---

## Observability — `LLM-Observatory`

| Agent | Role |
|-------|------|
| Telemetry Collector Agent | Collects execution telemetry across all phases |
| Usage Pattern Agent | Tracks and analyzes usage patterns |
| Failure Classification Agent | Classifies failures by type and severity |
| Health Check Agent | Monitors system health during execution |
| SLO / SLA Enforcement Agent | Enforces service-level objectives and agreements |

---

## Capability Ownership Map — QE vs. Adjacent Domains (ADR-PIPELINE-082)

The `quality_engineering` domain surfaces a scoped subset of AQE upstream's 60 agents. Capabilities that overlap with existing domains remain owned by those domains; AQE's versions are excluded at build time and rejected at runtime.

| Capability area | Owner domain | AQE exposed? |
|-----------------|-------------|--------------|
| Security (SAST/DAST, vulnerability scanning, compliance) | `safety` (Shield) | ❌ Excluded |
| Performance profiling, latency, cold-start | `performance_profiling` (Latency-Lens) | ❌ Excluded (complementary chaos via QE remains) |
| Enterprise integration (SAP, SOAP, middleware, OData) | `connector_hub` + ERP-Surface | ❌ Excluded (ADR-074 boundary) |
| Data privacy, anonymization, PII | `data_security` (Data-Vault) + `safety` (Shield) | ❌ Excluded |
| Cross-session / cross-project learning | `memory_context` (Memory-Graph) | ❌ Excluded |
| Test design and testability review | `quality_engineering` | ✅ |
| Unit / integration / property / BDD test generation | `quality_engineering` | ✅ |
| Coverage analysis, coverage gap detection | `quality_engineering` | ✅ |
| Defect prediction, flaky test detection, RCA | `quality_engineering` | ✅ |
| Requirements traceability | `quality_engineering` | ✅ |
| Chaos engineering (fault injection) | `quality_engineering` | ✅ |
| Test execution orchestration | `quality_engineering` | ✅ |
| QE reporting (coverage deltas, flake trends) | `quality_engineering` | ✅ |

Disambiguation rules for overlapping keywords (e.g., "regression test" vs. "model regression") are declared in `src/routing/domain-boundary.ts` (ADR-PIPELINE-082 §3). Tie-break rules for cross-domain priority are in the same module (§4).

---

## Test Bench — `test-bench`

Registered in `ecosystem.graph.json` infrastructure per ADR-PIPELINE-085. Complements `quality_engineering` — test-bench owns model-level evaluation (benchmarking, quality scoring, hallucination/faithfulness, prompt sensitivity), QE owns code-level testing (test generation, coverage, defect intelligence). Disambiguation rules in `src/routing/domain-boundary.ts`.

| Agent | Role |
|-------|------|
| Benchmark Agent | Runs standardized benchmarks for model/agent comparison |
| Compare Agent | Compares multiple models or agents head-to-head |
| Regression Detection Agent | Detects **model quality** regression vs. baseline (vs. test regression → QE) |
| Quality Scoring Agent | Scores **model output** quality (vs. code/test quality → QE) |
| Hallucination Detection Agent | Detects fabricated or unsupported claims in LLM outputs |
| Faithfulness Agent | Verifies outputs faithful to source material |
| Bias Evaluation Agent | Measures demographic/statistical bias in outputs |
| Prompt Sensitivity Agent | Assesses robustness to input phrasing variations |
| Consistency Agent | Measures output consistency across repeated runs |
| Stress Test Agent | Subjects the system to load/adversarial conditions |
| Red Team Agent | Coordinates adversarial testing exercises |
| Adversarial Agent | Generates adversarial inputs and attack patterns |
| Golden Dataset Agent | Validates against a known-good dataset (benchmark fixtures) |
| Synthetic Data Agent | Generates **benchmark** datasets (vs. **test fixtures** → QE) |

---

## Quality Engineering — `agentic-qe`

Wraps upstream AQE via the `agentic-qe` adapter repo (see ADR-PIPELINE-080, ADR-PIPELINE-081). Agents overlapping with existing domains (Shield, Latency-Lens, Connector-Hub, Data-Vault, Memory-Graph) are excluded per ADR-PIPELINE-082.

| Agent | Role |
|-------|------|
| Test Design Agent | Designs test strategy from specs, architecture, or code surfaces |
| Unit Test Generation Agent | Generates unit tests covering happy paths, edges, and error paths |
| Integration Test Generation Agent | Generates integration tests across component boundaries |
| Property-Based Test Agent | Generates property-based tests with generators and shrinkers |
| BDD Test Generation Agent | Generates Gherkin feature files from user stories and acceptance criteria |
| Coverage Analysis Agent | Analyzes line/branch/path/mutation coverage and trends |
| Coverage Gap Detection Agent | Identifies untested paths weighted by risk |
| Defect Prediction Agent | Predicts defect-prone areas from code, churn, and complexity signals |
| Flaky Test Detection Agent | Detects flaky tests and recommends remediation |
| Root Cause Analysis Agent | Traces causal chains for failures and identifies root causes |
| Requirements Traceability Agent | Builds traceability matrices from requirements to tests to code |
| Chaos Engineering Agent | Designs fault-injection scenarios to probe resilience |
| Test Execution Orchestrator Agent | Plans sharded test execution with retry and aggregation |
| QE Reporting Agent | Produces executive QE status reports with trends and recommendations |

Phase bindings are specified in ADR-PIPELINE-083. Phase 8 (Validation) binds all 14 agents as mandatory; phases 3, 5, 6, 7, 9, 10 bind subsets as optional.

---

# Routing Guidelines

1. **Mandatory agents execute on EVERY run.** They are not optional, not fallback, and not conditional. If a phase runs, its mandatory agents run.
2. **Optional agents are activated based on problem domain and complexity.** The CLI evaluates the problem context to determine which optional agents to include.
3. **Infrastructure agents are always available but invoked on demand.** Any phase can call orchestration, safety, or observability agents as needed.
4. **Execute the pipeline in phase order (0 through 11).** No phase may be skipped or reordered.
5. **Each phase must complete before the next begins.** There is no parallel execution across phases; parallelism occurs within phases (Ruflo swarm).
