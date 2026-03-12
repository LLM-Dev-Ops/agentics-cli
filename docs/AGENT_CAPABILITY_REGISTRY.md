# AGENT_CAPABILITY_REGISTRY.md

# Agentics Dev Platform — Ecosystem Capability Registry

This document describes the **core repositories, capabilities, and agents** that make up the Agentics Dev platform.

The purpose of this registry is to help the **Agentics CLI and orchestration system select the correct agents and repositories** when solving a business problem.

The platform is organized into **nine architectural layers**.

Agents **should not all be used simultaneously**.  
Instead, the CLI selects agents based on the **stage of execution and the problem domain**.

---

# Core Execution Pipeline

For most business problems the platform follows this high-level flow:


### Primary Stages

- Simulation  
- Research  
- Specification  
- Architecture  
- Build  
- Validation  
- Deployment  
- Governance  

---

# Layer 1 — Foundational Tooling

These repositories provide the **core operational infrastructure for LLM systems**.

They are primarily used for:

- evaluation
- observability
- security
- performance diagnostics

---

## LLM-Test-Bench

Deterministic benchmarking and evaluation framework for LLM systems.

### Purpose

Evaluate model quality, detect regressions, and validate prompt behaviors.

### Key Capabilities

- Evaluation scoring
- Adversarial testing
- Regression detection
- Benchmark comparison

### Agents

- Benchmark Runner Agent
- Model Comparator Agent
- Regression Detection Agent
- Quality Scoring Agent
- Hallucination Detection Agent
- Faithfulness Verification Agent
- Bias Detection Agent
- Prompt Sensitivity Agent
- Output Consistency Agent
- Stress Test Agent
- Red Team Agent
- Adversarial Prompt Agent
- Golden Dataset Validator Agent
- Synthetic Data Generator Agent

### Use When

- Evaluating model quality
- Comparing model outputs
- Testing prompt robustness

---

## LLM-Observatory

Telemetry ingestion and performance visualization platform.

### Purpose

Track system health, usage patterns, and failure trends across the platform.

### Key Capabilities

- Telemetry ingestion
- Usage analytics
- Failure classification
- Visualization dashboards

### Agents

- Telemetry Collector Agent
- Usage Pattern Agent
- Failure Classification Agent
- Health Check Agent
- SLO / SLA Enforcement Agent
- Post-Mortem Generator Agent (read-only)
- Visualization Spec Agent

### Use When

- Monitoring production workloads
- Analyzing system performance

---

## LLM-Shield

Security and compliance layer for LLM systems.

### Purpose

Protect against prompt injection, data leakage, and unsafe outputs.

### Key Capabilities

- Prompt injection defense
- PII detection
- Content moderation
- Secrets detection

### Agents

- Prompt Injection Detection Agent
- PII Detection Agent
- Data Redaction Agent
- Secrets Leakage Agent
- Toxicity Detection Agent
- Safety Boundary Agent
- Content Moderation Agent
- Model Abuse Detection Agent
- Credential Exposure Agent

### Use When

- Validating outputs
- Scanning prompts and responses
- Securing integrations

---

# Layer 1 — Operational Intelligence

---

## LLM-Sentinel

Runtime anomaly detection and monitoring system.

### Purpose

Detect abnormal behavior in LLM pipelines.

### Agents

- Anomaly Detection Agent
- Drift Detection Agent
- Alerting Agent
- Incident Correlation Agent
- Root Cause Analysis Agent

### Use When

- Detecting performance anomalies
- Identifying behavioral drift

---

## LLM-Memory-Graph

Graph-based context and lineage tracking system.

### Purpose

Maintain persistent memory and decision lineage.

### Agents

- Conversation Memory Agent
- Prompt Lineage Agent
- Decision Memory Agent
- Knowledge Graph Builder Agent
- Memory Retrieval Agent
- Long-Term Pattern Agent

### Use When

- Tracking context across runs
- Persisting long-term knowledge

---

## LLM-Latency-Lens

Performance profiling and cost analysis CLI.

### Purpose

Measure token throughput, latency, and cost.

### Agents

- Latency Analysis Agent
- Cold Start Mitigation Agent (measurement)

### Use When

- Analyzing performance bottlenecks
- Optimizing model response time

---

## LLM-Forge

Cross-provider SDK generation toolkit.

### Purpose

Generate typed Rust and TypeScript bindings for APIs and models.

### Agents

- SDK Generator Agent
- CLI Command Generator Agent
- API Translation Agent
- Version Compatibility Agent

### Use When

- Creating integrations or SDK layers

---

# Layer 1 — Automation & Resilience

---

## LLM-Edge-Agent

Interception proxy for model APIs.

### Purpose

Provide routing, caching, and execution guards.

### Agents

- Tool Invocation Agent
- Circuit Breaker Agent
- Failover Agent
- Execution Guard Agent
- Caching Strategy Agent

### Use When

- Managing model routing and caching

---

## LLM-Auto-Optimizer

Adaptive feedback loop for performance optimization.

### Agents

- Self-Optimizing Agent
- Token Optimization Agent
- Model Selection Agent

### Use When

- Automatically tuning model selection

---

## LLM-Incident-Manager

Incident escalation and recovery workflows.

### Agents

- Incident Escalation Agent
- Post-Mortem Generator Agent
- Human-in-the-Loop Agent

### Use When

- Handling failures or security events

---

## LLM-Orchestrator

Workflow engine coordinating multi-model pipelines.

### Agents

- Workflow Orchestrator Agent
- Task Scheduler Agent
- Dependency Resolver Agent
- Retry & Recovery Agent
- Parallelization Agent
- State Machine Agent
- Swarm Coordinator Agent

### Use When

- Running multi-step workflows

---

# Layer 1 — Governance & FinOps

---

## LLM-CostOps

Cost tracking and ROI analytics.

### Agents

- Cost Attribution Agent
- Cost Forecasting Agent
- Budget Enforcement Agent
- ROI Estimation Agent
- Cost-Performance Tradeoff Agent

### Use When

- Analyzing platform costs

---

## LLM-Governance-Dashboard

Human governance interface.

### Agents

- Governance Audit Agent
- Change Impact Agent
- Usage Oversight Agent

---

## LLM-Policy-Engine

Policy enforcement system.

### Agents

- Policy Enforcement Agent
- Constraint Solver Agent
- Approval Routing Agent

---

# Layer 1 — Ecosystem & Collaboration

---

## LLM-Registry

Metadata and identity registry for models, tests, and pipelines.

### Agents

- Registry Indexing Agent
- Agent Reputation Agent
- Template Bootstrap Agent

---

## LLM-Marketplace

Distribution platform for templates and modules.

### Agents

- Marketplace Packaging Agent
- Deprecation Agent

---

## LLM-Analytics-Hub

Cross-system analytics engine.

### Agents

- Consensus Agent
- Strategic Recommendation Agent

---

# Layer 2 — Intelligence & Expansion

These systems enable **advanced reasoning and experimentation**.

---

## LLM-CoPilot-Agent

Developer-facing reasoning assistant.

### Agents

- Planner Agent
- Decomposer Agent
- Objective Clarifier Agent
- Intent Classifier Agent
- Reflection Agent
- Meta-Reasoner Agent

---

## LLM-Simulator

Offline scenario simulation system.

### Agents

- What-If Simulation Agent
- Scenario Generator Agent

### Use When

Running hypothetical execution scenarios.

---

## LLM-Benchmark-Exchange

Public benchmark publishing platform.

### Agents

- Benchmark Publication Agent

---

## LLM-Inference-Gateway

Unified inference routing layer.

### Agents

- Inference Routing Agent

---

## LLM-Data-Vault

Secure dataset storage and anonymization system.

### Agents

- Data Access Control Agent
- Dataset Anonymization Agent

---

## LLM-Research-Lab

Experimental research and evaluation framework.

### Agents

- Hypothesis Agent
- Experimental Metric Agent

---

# Layer 3 — Core Integration Bundles

These repositories **compose lower-layer capabilities into unified workflows**.

They do **not define new agents**.

### Examples

- LLM-Intelligence-Core
- LLM-Security-Core
- LLM-Automation-Core
- LLM-Governance-Core
- LLM-Data-Core
- LLM-Ecosystem-Core
- LLM-Research-Core
- LLM-Interface-Core

---

# Layer 4 — Infrastructure & Execution

These repositories support **execution, persistence, and enterprise workflows**.

### Key Systems

- agentics-cli
- agentics-orchestration-engine
- agentics-execution-engine
- agentics-enforcement
- ruvector-service
- agentics-results-index
- agentics-usage-ledger
- agentics-contracts
- agentics-diligence-artifacts
- agentics-simulation-planner
- agentics-simulator-runner
- agentics-deployment-exporters
- agentics-org-manifests

---

# Enterprise Systems

These systems connect the platform to **real-world operations**.

## enterprise-roi-engine

Calculates ROI projections for generated solutions.

## erp-surface

Pushes generated implementations to enterprise systems.

### Agents

- Enterprise Strategy Agent
- ERP Integration Agent

---

# Apex Layer — Agentics Dev Platform

The unified control plane integrating every module.

### Capabilities

- Central API gateway
- Service registry
- RBAC and authentication
- Multi-tenant management
- Deployment orchestration
- Platform analytics

### Agents

- Decision Agent
- Executive Summary Agent
- Decision Memo Agent
- Risk Scoring Agent

---

# Routing Guidelines for the CLI

When solving a business problem:

1. Identify required capabilities
2. Select the minimal set of agents that satisfy those capabilities
3. Avoid loading unnecessary agents or repositories
4. Execute the pipeline in stage order

Typical agent set per run should be **5–10 agents**, not the entire ecosystem.

---

# Design Principle

The Agentics ecosystem is a **capability platform**, not a linear pipeline.

Agents are **tools**.

They should be selected based on:

- the problem domain
- the execution stage