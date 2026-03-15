# Agentics CLI

```
┌─────────────────────────────────────────────────────────────────┐
│                                                                 │
│      █████╗  ██████╗ ███████╗███╗   ██╗████████╗██╗ ██████╗    │
│     ██╔══██╗██╔════╝ ██╔════╝████╗  ██║╚══██╔══╝██║██╔════╝    │
│     ███████║██║  ███╗█████╗  ██╔██╗ ██║   ██║   ██║██║         │
│     ██╔══██║██║   ██║██╔══╝  ██║╚██╗██║   ██║   ██║██║         │
│     ██║  ██║╚██████╔╝███████╗██║ ╚████║   ██║   ██║╚██████╗   │
│     ╚═╝  ╚═╝ ╚═════╝ ╚══════╝╚═╝  ╚═══╝   ╚═╝   ╚═╝ ╚═════╝   │
│                                                                 │
│          Enterprise AI Agent Orchestration Platform              │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

[![npm version](https://img.shields.io/npm/v/@llm-dev-ops/agentics-cli.svg)](https://www.npmjs.com/package/@llm-dev-ops/agentics-cli)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen.svg)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue.svg)](https://www.typescriptlang.org/)
[![License](https://img.shields.io/badge/license-Paid%20Usage-red.svg)](https://globalbusinessadvisors.com)
[![Build Status](https://img.shields.io/github/actions/workflow/status/llm-dev-ops/agentics-cli/ci.yml?branch=main)](https://github.com/llm-dev-ops/agentics-cli/actions)
[![Platform](https://img.shields.io/badge/platform-agentics.dev-blueviolet.svg)](https://platform.agentics.dev)

---

## Overview

**Agentics CLI** is an enterprise-grade AI agent orchestration platform that enables organizations to plan, simulate, deploy, and govern AI agent infrastructure at scale. It provides a unified command-line interface for managing the full lifecycle of AI agent deployments -- from initial simulation planning through compliance packaging and infrastructure export.

The platform orchestrates **27 deployed agent domains** comprising **109 specialized agents** that cover security, cost optimization, observability, governance, ERP integration, and more. Agents are dispatched in parallel through **33 auto-dispatched multi-agent combinations**, enabling complex enterprise workflows to be resolved through a single natural language command.

Agentics CLI integrates directly with enterprise ERP systems including SAP S/4HANA, Oracle ERP Cloud, and Microsoft Dynamics 365, and exports production-ready infrastructure-as-code for Terraform, Kubernetes, CloudFormation, Pulumi, and Ansible. All operations produce auditable artifacts suitable for SOC2, HIPAA, GDPR, and PCI-DSS compliance reviews.

---

## Key Features

- **6-Phase Enterprise Pipeline** -- Structured workflow from simulation through deployment with full traceability
- **27 Agent Domains, 109 Agents** -- Specialized agents for security, cost analysis, observability, governance, and more
- **Multi-Agent Orchestration** -- 33 pre-configured agent combinations dispatched in parallel via `agentics ask`
- **Natural Language Interface** -- Describe tasks in plain English; the CLI classifies intent and routes automatically
- **10 ERP System Integrations** -- Native connectors for SAP, Oracle, NetSuite, Dynamics 365, and more
- **Infrastructure-as-Code Export** -- Generate Terraform, Kubernetes, CloudFormation, Pulumi, and Ansible artifacts
- **Compliance Packaging** -- Automated SOC2, HIPAA, GDPR, and PCI-DSS artifact generation
- **CFO-Grade Financial Analysis** -- ROI quantification with executive-summary and detailed reporting
- **MCP Server Integration** -- Operates as a Model Context Protocol server for AI-native toolchains
- **Deterministic Simulation** -- Reproducible simulation runs with configurable iteration counts and parallelism

---

## Architecture

### 6-Phase Enterprise Pipeline

```
┌───────────┐    ┌───────────┐    ┌───────────┐    ┌───────────┐    ┌───────────┐    ┌───────────┐
│           │    │           │    │           │    │           │    │           │    │           │
│   PLAN    │───>│ SIMULATE  │───>│  INSPECT  │───>│ QUANTIFY  │───>│  DEPLOY   │───>│  EXPORT   │
│           │    │           │    │           │    │           │    │           │    │           │
└───────────┘    └───────────┘    └───────────┘    └───────────┘    └───────────┘    └───────────┘
      │                │                │                │                │                │
      v                v                v                v                v                v
  Simulation       Iteration        Metrics &        Financial       Deployment       IaC Artifacts
   Planner          Runner           Outputs        ROI Engine         Intent         & Compliance
```

### Agent Routing

```
  agentics ask "<query>"
        │
        ├── Combo Dispatch (33 multi-agent sets, parallel)
        ├── Single Agent Match (95 keyword rules)
        └── Direct Invoke (agentics agents invoke <domain> <agent>)
        │
        v
  27 Agent Domains ── 109 Specialized Agents
```

---

## Quick Start

### Installation

```bash
npm install -g @llm-dev-ops/agentics-cli
```

Or run directly without installation:

```bash
npx @llm-dev-ops/agentics-cli help
```

### Authentication

```bash
agentics login
```

### First Command

```bash
agentics ask "What is the cost breakdown for our AI agent infrastructure?"
```

> **Note:** All workflow commands accept natural language input in quotes. Structured JSON references are also supported for programmatic use.

---

## Core Workflow

The CLI follows a structured 6-phase pipeline for AI agent deployment. Each phase produces artifacts that feed into the next.

| Phase | Command | Description | Upstream Service |
|-------|---------|-------------|------------------|
| 1 | `agentics plan` | Create a simulation plan from an organization manifest | agentics-simulation-planner |
| 2 | `agentics simulate` | Execute simulation iterations against the plan | agentics-simulation-runner |
| 3 | `agentics inspect` | Retrieve deterministic outputs and metrics | agentics-simulation-engine |
| 4 | `agentics quantify` | Generate CFO-grade ROI and financial analysis | enterprise-roi-engine |
| 5 | `agentics deploy` | Resolve deployment intent from simulation results | agentics-deployment-intent |
| 6 | `agentics export` | Generate infrastructure-as-code artifacts | agentics-deployment-exporters |

An additional `diligence` command packages compliance artifacts across all phases.

### Example: End-to-End Workflow

```bash
# 1. Create a deployment plan
agentics plan "prod-cluster-v2" --params '{"region":"us-east-1"}'

# 2. Run 10 simulation iterations
agentics simulate '{"id":"plan-abc123"}' --iterations 10 --config '{"parallelism":4}'

# 3. Retrieve simulation metrics
agentics inspect '{"id":"sim-xyz789"}' --output-type metrics --format table

# 4. Generate financial analysis
agentics quantify '{"id":"sim-xyz789"}' --report-type cfo-grade \
  --params '{"currency":"USD","timeframe":"annual"}'

# 5. Deploy to staging
agentics deploy '{"id":"sim-xyz789"}' --environment staging

# 6. Export Terraform configurations
agentics export '{"id":"intent-456"}' --export-format terraform --output ./infrastructure/

# 7. Package compliance documentation
agentics diligence '[{"id":"sim-xyz789"},{"id":"intent-456"}]' --frameworks SOC2,HIPAA
```

---

## Commands Reference

### Workflow Commands

#### `agentics plan`

Create a simulation plan from an organization manifest.

```bash
agentics plan <manifest-query> [--params <json>]
```

#### `agentics simulate`

Execute a simulation from a plan reference or natural language description.

```bash
agentics simulate <plan-ref|description> [--config <json>] [--iterations <n>]
```

#### `agentics inspect`

Retrieve deterministic outputs from a simulation.

```bash
agentics inspect <sim-ref|description> [--output-type <type>]
```

Output types: `metrics`, `logs`, `state`, `events`, `summary`, `full`

#### `agentics quantify`

Generate financial impact and ROI analysis.

```bash
agentics quantify <sim-ref|description> [--report-type <type>] [--params <json>]
```

Report types: `executive-summary`, `detailed-analysis`, `cfo-grade`, `custom`

#### `agentics deploy`

Resolve deployment intent from simulation results.

```bash
agentics deploy <sim-ref|description> [--spec <json>] [--environment <env>]
```

#### `agentics export`

Generate infrastructure-as-code deployment artifacts.

```bash
agentics export <intent-ref|description> [--export-format <format>] [--output <path>]
```

Export formats: `terraform`, `kubernetes`, `cloudformation`, `pulumi`, `ansible`, `custom`

#### `agentics diligence`

Package compliance and audit artifacts.

```bash
agentics diligence <refs|description> [--frameworks <list>] [--requirements <json>]
```

Frameworks: `SOC2`, `HIPAA`, `GDPR`, `PCI-DSS`, `custom`

---

### Agent Commands

#### `agentics ask`

Route a natural language query to the appropriate agent(s). Automatically dispatches multi-agent combinations when applicable.

```bash
agentics ask "<natural language query>"
```

#### `agentics agents list`

List all available agents across all domains.

```bash
agentics agents list
```

#### `agentics agents invoke`

Invoke a specific agent directly by domain and agent name.

```bash
agentics agents invoke <domain> <agent> '{"text":"<prompt>"}'
```

---

### ERP Integration Commands

| Command | Description |
|---------|-------------|
| `agentics erp list` | List all supported ERP systems and connection status |
| `agentics erp surface <system>` | Surface available modules and data structures |
| `agentics erp map <system> [--modules <list>]` | Map ERP fields to the Agentics data model |
| `agentics erp inspect <system>` | Inspect connection details and data availability |
| `agentics erp export <system> [--format <fmt>]` | Export data mappings for infrastructure generation |

### Governance Commands

| Command | Description |
|---------|-------------|
| `agentics policy create <name> [--rules <json>]` | Create a governance policy |
| `agentics policy list` | List all policies |
| `agentics policy inspect <id>` | View policy details |
| `agentics policy enable <id>` | Enable a policy |
| `agentics policy disable <id>` | Disable a policy |
| `agentics policy delete <id>` | Delete a policy |
| `agentics audit [--from <date>] [--to <date>]` | Generate audit trails |

### Observability Commands

| Command | Description |
|---------|-------------|
| `agentics inspect run <run-id>` | Inspect a specific simulation or deployment run |
| `agentics inspect artifacts <run-id>` | List artifacts produced by a run |
| `agentics inspect query [--status <s>]` | Query across runs with filters |
| `agentics usage [--period <period>]` | View usage statistics and quota information |

### Account Commands

| Command | Description |
|---------|-------------|
| `agentics login` | Authenticate with the Agentics platform |
| `agentics logout` | Clear stored credentials |
| `agentics whoami` | Display current authenticated identity |
| `agentics version` | Display CLI and platform version |

---

### Global Options

| Option | Description |
|--------|-------------|
| `--timeout <ms>` | Request timeout in milliseconds |
| `--trace-id <id>` | Correlation ID for distributed tracing |
| `--format <fmt>` | Output format: `json`, `yaml`, `table`, `text`, `csv` |
| `--verbose, -v` | Enable verbose output |
| `--pretty` | Pretty-print output |
| `--version` | Show CLI version |
| `--help` | Display command help |

---

## Multi-Agent Orchestration

The Agentics platform organizes 109 specialized agents across 27 domains. The `agentics ask` command automatically classifies user intent and dispatches the optimal set of agents in parallel.

### Agent Domains

| Domain | Agent Count | Capability |
|--------|-------------|------------|
| **shield** | 9 | Security scanning, PII detection, content safety, credential exposure |
| **test-bench** | 14 | Benchmarking, regression testing, red-teaming, bias and hallucination detection |
| **costops** | 5 | Cost attribution, forecasting, budgeting, ROI analysis |
| **observatory** | 7 | Telemetry, usage patterns, health checks, SLO monitoring |
| **orchestrator** | 7 | Workflow scheduling, dependency management, parallel execution |
| **sentinel** | 5 | Anomaly detection, drift monitoring, root cause analysis |
| **copilot** | 7 | Task planning, intent classification, decomposition |
| **memory-graph** | 6 | Conversation history, decision lineage, knowledge graphs |
| **connector-hub** | 5 | ERP integration, database queries, webhooks, SSO/OAuth |
| **auto-optimizer** | 3 | Token optimization, model selection, self-optimization |
| **edge** | 5 | Circuit breakers, failover, execution guards, caching |
| **forge** | 4 | SDK generation, CLI tooling, API translation |
| **platform** | 4 | Executive summaries, decision memos, risk scoring |
| **governance-dashboard** | 3 | Audit trails, impact analysis, oversight |
| **policy-engine** | 3 | Policy enforcement, constraints, approval workflows |
| **incident-manager** | 3 | Escalation, post-mortems, human-in-the-loop |
| **data-vault** | 2 | Access control, data anonymization |
| **simulator** | 2 | What-if analysis, scenario simulation |
| **latency-lens** | 2 | Latency profiling, cold-start analysis |
| **research-lab** | 2 | Hypothesis testing, metrics analysis |
| **analytics-hub** | 2 | Consensus building, recommendation reports |
| **registry** | 3 | Agent indexing, reputation scoring, bootstrapping |
| **marketplace** | 2 | Agent packaging, deprecation management |
| **config-manager** | 1 | Configuration validation |
| **schema-registry** | 1 | Schema validation |
| **benchmark-exchange** | 1 | Benchmark publishing |
| **inference-gateway** | 1 | Inference routing and load balancing |

### Multi-Agent Combinations

When a query matches a known pattern, `agentics ask` dispatches multiple agents in parallel. Selected examples:

| Combination | Trigger Patterns | Agents Dispatched |
|-------------|-----------------|-------------------|
| cost-analysis | "cost analysis", "spending report" | costops/attribution + forecast + roi |
| security-scan | "security scan", "safety scan" | shield/prompt-injection + pii + secrets + toxicity + credential-exposure |
| model-evaluation | "evaluate model", "model quality" | test-bench/benchmark + quality + hallucination + faithfulness |
| incident-response | "service down", "outage" | incident-manager/escalation + post-mortem + sentinel/rca + observatory/failures |
| executive-brief | "executive summary", "board report" | platform/executive-summary + costops/attribution + observatory/slo + research-lab/metrics |
| compliance-review | "compliance check", "GDPR", "HIPAA" | governance-dashboard/audit + oversight + policy-engine/enforce + data-vault/access-control |
| decision-package | "go/no-go", "decision package" | platform/decision + decision-memo + risk-score + costops/roi |
| latency-debug | "why is it slow", "latency issue" | latency-lens/latency + cold-start + sentinel/anomaly + rca |
| resilience-check | "handle failures", "make resilient" | edge/circuit-breaker + failover + execution-guard + orchestrator/retry |
| enterprise-data | "query SAP", "ERP data" | connector-hub/database-query + erp-surface + auth-identity |

> **Note:** 33 multi-agent combinations are available in total. Run `agentics agents list` for the complete catalog.

---

## ERP Integration

The platform provides native connectors for 10 enterprise ERP systems through the `connector-hub` agent domain.

| ERP System | API Type | Key Modules |
|------------|----------|-------------|
| **SAP S/4HANA** | OData / RFC | Finance, Materials Management, Sales, HR, Plant Maintenance |
| **Oracle ERP Cloud** | REST | General Ledger, Procurement, Project Management, Fixed Assets |
| **NetSuite** | SuiteTalk / REST | Financial Management, CRM, Inventory, E-commerce |
| **Microsoft Dynamics 365** | Dataverse / OData | Finance, Supply Chain, Commerce, Human Resources |
| **Infor CloudSuite** | ION API | Manufacturing, Distribution, Finance, HCM |
| **Epicor Kinetic** | REST | Manufacturing, Distribution, Financial Management |
| **Sage X3** | REST / SOAP | Finance, Distribution, Manufacturing |
| **IFS Cloud** | REST | Asset Management, Field Service, Manufacturing, Projects |
| **Workday** | REST / SOAP | HCM, Financial Management, Planning, Payroll |
| **PeopleSoft** | Component Interface | HCM, Finance, Supply Chain, Campus Solutions |

```bash
# List available ERP systems
agentics erp list

# Surface modules from SAP
agentics erp surface sap-s4hana

# Map ERP fields to Agentics data model
agentics erp map dynamics-365 --modules finance,supply-chain

# Export mappings as Terraform
agentics erp export oracle-erp-cloud --format terraform
```

---

## Compliance and Governance

Agentics CLI supports automated compliance artifact generation for major regulatory frameworks.

| Framework | Coverage |
|-----------|----------|
| **SOC2** | Trust Services Criteria (Security, Availability, Processing Integrity, Confidentiality, Privacy) |
| **HIPAA** | Administrative, Physical, and Technical Safeguards; Breach Notification |
| **GDPR** | Data Processing Records, DPIA, Data Subject Rights, Cross-Border Transfer |
| **PCI-DSS** | Cardholder Data Protection, Access Control, Network Security, Monitoring |

```bash
# Generate compliance package
agentics diligence "package compliance artifacts for SOC2 and HIPAA audit"

# Run governance audit
agentics audit --from 2025-01-01 --to 2025-12-31 --format json

# Create and enforce policies
agentics policy create data-retention --rules '{"max_days":90,"pii_handling":"encrypt"}'
agentics policy enable data-retention
```

> **Important:** Compliance artifacts are generated based on platform telemetry and simulation data. They should be reviewed by qualified compliance personnel before submission to auditors.

---

## Infrastructure Export

The `export` command generates production-ready infrastructure-as-code from deployment intents.

| Format | Output | Use Case |
|--------|--------|----------|
| **Terraform** | `.tf` files with provider configurations | Multi-cloud infrastructure provisioning |
| **Kubernetes** | YAML manifests (Deployments, Services, ConfigMaps) | Container orchestration |
| **CloudFormation** | JSON/YAML templates | AWS-native infrastructure |
| **Pulumi** | TypeScript/Python programs | Programmatic infrastructure |
| **Ansible** | Playbooks and role definitions | Configuration management |

```bash
# Export Terraform for a deployment intent
agentics export '{"id":"intent-456"}' --export-format terraform --output ./infra/terraform/

# Export Kubernetes manifests
agentics export "generate kubernetes manifests for the production cluster" --output ./infra/k8s/

# Export CloudFormation template
agentics export '{"id":"intent-456"}' --export-format cloudformation --output ./infra/cfn/
```

---

## Natural Language Interface

All workflow commands accept natural language descriptions in place of structured JSON references. The CLI automatically detects input type and routes accordingly.

```bash
# Simulation planning
agentics plan "production deployment for the payments microservice"

# Simulation execution
agentics simulate "run an enterprise ERP cost optimization simulation"

# Results inspection
agentics inspect "show me the results from the last production test"

# Financial analysis
agentics quantify "calculate ROI for the Q4 infrastructure upgrade"

# Deployment
agentics deploy "deploy the microservices update to staging"

# IaC generation
agentics export "generate terraform for the new kubernetes cluster"

# Compliance packaging
agentics diligence "package compliance docs for the SOC2 audit"

# Multi-agent queries
agentics ask "what is the cost vs quality tradeoff for switching to a smaller model?"
```

**Input Detection Rules:**

- Input beginning with `{` or `[` is parsed as structured JSON
- All other input is treated as a natural language description
- Malformed JSON is treated as natural language

---

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `AGENTICS_API_KEY` | Platform API key for authentication | -- |
| `AGENTICS_PLATFORM_URL` | Base URL for the Agentics platform | `https://platform.agentics.dev` |
| `AGENTICS_MANIFESTS_URL` | Organization manifests service endpoint | Platform default |
| `AGENTICS_PLANNER_URL` | Simulation planner service endpoint | Platform default |
| `AGENTICS_RUNNER_URL` | Simulation runner service endpoint | Platform default |
| `AGENTICS_SIMULATION_ENGINE_URL` | Simulation engine service endpoint | Platform default |
| `ENTERPRISE_ROI_ENGINE_URL` | ROI engine service endpoint | Platform default |
| `AGENTICS_INTENT_URL` | Deployment intent service endpoint | Platform default |
| `AGENTICS_EXPORTERS_URL` | Deployment exporters service endpoint | Platform default |
| `DILIGENCE_URL` | Diligence artifacts service endpoint | Platform default |
| `ANTHROPIC_API_KEY` | Anthropic API key (for NL classification) | -- |
| `OPENAI_API_KEY` | OpenAI API key (alternative NL provider) | -- |

---

## Exit Codes

| Code | Name | Description |
|------|------|-------------|
| `0` | Success | Command completed successfully |
| `1` | General Error | Unspecified error |
| `64` | Usage Error | Invalid command syntax or arguments |
| `65` | Data Format Error | Invalid input data format |
| `69` | Service Unavailable | Upstream service is unreachable |
| `70` | Internal Error | Unexpected internal error |
| `100` | Validation Error | Argument or schema validation failed |
| `120` | Network Error | Network connectivity failure |
| `130` | Authentication Error | Invalid or expired credentials |
| `140` | Service Error | Upstream service returned an error |

---

## API Reference

Complete API documentation is available on the Agentics platform:

- **Platform Console:** [https://platform.agentics.dev](https://platform.agentics.dev)
- **API Documentation:** [https://platform.agentics.dev/docs](https://platform.agentics.dev/docs)
- **CLI Help:** Run `agentics help` or `agentics <command> --help`

The CLI also operates as a **Model Context Protocol (MCP) server**, enabling integration with AI-native development environments and agent toolchains.

---

## Security

The Agentics CLI implements the following security measures:

- **Authentication** -- API key and token-based authentication with the platform
- **Transport Security** -- All communications use TLS 1.2+
- **Credential Storage** -- Credentials are stored in the user's OS keychain or local configuration with restricted file permissions
- **Input Validation** -- All inputs are validated using Zod schemas before processing
- **Audit Logging** -- All agent invocations and data access operations are logged for audit
- **Policy Enforcement** -- Configurable policies govern agent execution boundaries and data access

To report security vulnerabilities, contact [security@globalbusinessadvisors.com](mailto:security@globalbusinessadvisors.com).

---

## Contributing

Contributions are welcome. To contribute:

1. Fork the repository at [https://github.com/llm-dev-ops/agentics-cli](https://github.com/llm-dev-ops/agentics-cli)
2. Create a feature branch from `main`
3. Ensure all tests pass: `npm test`
4. Ensure type checking passes: `npm run typecheck`
5. Ensure linting passes: `npm run lint`
6. Submit a pull request with a clear description of the changes

### Development Setup

```bash
git clone https://github.com/llm-dev-ops/agentics-cli.git
cd agentics-cli
npm install
npm run build
npm test
```

---

## Support

| Channel | Link |
|---------|------|
| Platform | [https://platform.agentics.dev](https://platform.agentics.dev) |
| GitHub Issues | [https://github.com/llm-dev-ops/agentics-cli/issues](https://github.com/llm-dev-ops/agentics-cli/issues) |
| Repository | [https://github.com/llm-dev-ops/agentics-cli](https://github.com/llm-dev-ops/agentics-cli) |
| npm | [https://www.npmjs.com/package/@llm-dev-ops/agentics-cli](https://www.npmjs.com/package/@llm-dev-ops/agentics-cli) |

---

## Requirements

- **Node.js** >= 18.0.0
- **npm** >= 9.0.0 (included with Node.js 18+)
- **Operating Systems:** macOS, Linux, Windows (WSL2 recommended)

---

## License

This software requires a paid usage license from **Global Business Advisors**. All rights reserved. Unauthorized use, reproduction, or distribution is prohibited.

For licensing inquiries, contact [Global Business Advisors](https://globalbusinessadvisors.com).

Copyright (c) 2025 Global Business Advisors. All rights reserved.
