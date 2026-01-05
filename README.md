# Agentics-CLI

[![npm version](https://img.shields.io/npm/v/@llm-dev-ops/agentics-cli.svg)](https://www.npmjs.com/package/@llm-dev-ops/agentics-cli)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

CLI for the Agentics Platform - orchestrate simulations, analyze ROI, and deploy AI agent infrastructure.

**Supports natural language input:** Use plain English in quotes after any workflow command.

```bash
agentics simulate "run an enterprise ERP cost optimization simulation"
agentics quantify "calculate ROI for the Q4 infrastructure upgrade"
```

## Installation

```bash
npm install -g @llm-dev-ops/agentics-cli
```

Or run directly with npx:

```bash
npx @llm-dev-ops/agentics-cli help
```

## Quick Start

Commands accept either natural language in quotes or structured JSON references:

```bash
# Using natural language (just describe what you want in quotes)
agentics plan "production-deployment"
agentics simulate "run an enterprise ERP cost optimization simulation"
agentics inspect "show me the results from the last production test"
agentics quantify "calculate ROI for the Q4 infrastructure upgrade"
agentics deploy "deploy the microservices update to staging"
agentics export "generate terraform for the new kubernetes cluster"

# Using JSON references (for programmatic workflows)
agentics simulate '{"id":"plan-123"}' --iterations 10
agentics inspect '{"id":"sim-456"}' --output-type metrics
agentics quantify '{"id":"sim-456"}' --report-type cfo-grade
```

## Workflow

The CLI follows a structured pipeline for AI agent deployment:

```
plan → simulate → inspect → quantify → deploy → export
```

| Stage | Description | Service |
|-------|-------------|---------|
| `plan` | Create simulation plan from org manifest | agentics-simulation-planner |
| `simulate` | Execute simulation iterations | agentics-simulation-runner |
| `inspect` | Retrieve simulation outputs | agentics-simulation-engine |
| `quantify` | Generate CFO-grade ROI analysis | enterprise-roi-engine |
| `deploy` | Resolve deployment intent | agentics-deployment-intent |
| `export` | Generate IaC artifacts | agentics-deployment-exporters |
| `diligence` | Package compliance artifacts | diligence-artifacts |

## Commands

### plan

Create a simulation plan from an organization manifest.

```bash
agentics plan <manifest-query> [--params <json>]
```

### simulate

Execute a simulation from a plan reference or natural language description.

```bash
# With JSON reference
agentics simulate <plan-ref> [--config <json>] [--iterations <n>]

# With natural language
agentics simulate "run an enterprise ERP cost optimization simulation"
```

### inspect

Retrieve deterministic outputs from a simulation.

```bash
# With JSON reference
agentics inspect <sim-ref> [--output-type <type>]

# With natural language
agentics inspect "show me the results from the last production test"
```

Output types: `metrics`, `logs`, `state`, `events`, `summary`, `full`

### quantify

Generate financial impact and ROI analysis.

```bash
# With JSON reference
agentics quantify <sim-ref> [--report-type <type>] [--params <json>]

# With natural language
agentics quantify "calculate ROI for the Q4 infrastructure upgrade"
```

Report types: `executive-summary`, `detailed-analysis`, `cfo-grade`, `custom`

### deploy

Resolve deployment intent from simulation results.

```bash
# With JSON reference
agentics deploy <sim-ref> [--spec <json>] [--environment <env>]

# With natural language
agentics deploy "deploy the microservices update to staging"
```

### export

Generate infrastructure-as-code deployment artifacts.

```bash
# With JSON reference
agentics export <intent-ref> [--export-format <format>] [--output <path>]

# With natural language
agentics export "generate terraform for the new kubernetes cluster"
```

Export formats: `terraform`, `kubernetes`, `cloudformation`, `pulumi`, `ansible`, `custom`

### diligence

Package compliance and audit artifacts.

```bash
# With JSON reference
agentics diligence <refs> [--frameworks <list>] [--requirements <json>]

# With natural language
agentics diligence "package compliance docs for the SOC2 audit"
```

Frameworks: `SOC2`, `HIPAA`, `GDPR`, `PCI-DSS`, `custom`

## Natural Language Input

The CLI supports Claude-style natural language invocation for workflow commands. Instead of passing structured JSON references, you can describe what you want in plain English:

```bash
# Natural language examples
agentics simulate "run an enterprise ERP cost optimization simulation"
agentics inspect "show me the results from the last production test"
agentics quantify "calculate ROI for the Q4 infrastructure upgrade"
agentics deploy "deploy the microservices update to staging"
agentics export "generate terraform for the new kubernetes cluster"
agentics diligence "package compliance docs for the SOC2 audit"
```

Natural language input is automatically detected and forwarded to downstream services unchanged. Structured JSON input continues to work as before for backward compatibility.

**Input Detection Rules:**
- Input starting with `{` or `[` is parsed as JSON
- All other input is treated as natural language description
- Invalid JSON syntax is treated as natural language

## Global Options

| Option | Description |
|--------|-------------|
| `--timeout <ms>` | Request timeout in milliseconds |
| `--trace-id <id>` | Correlation ID for distributed tracing |
| `--format <fmt>` | Output format: `json`, `yaml`, `table`, `text`, `csv` |
| `--verbose, -v` | Enable verbose output |
| `--pretty` | Pretty-print output |
| `--version` | Show version |

Use `agentics help` to display full usage information.

## Environment Variables

Override default service endpoints:

| Variable | Service |
|----------|---------|
| `AGENTICS_MANIFESTS_URL` | Organization manifests |
| `AGENTICS_PLANNER_URL` | Simulation planner |
| `AGENTICS_RUNNER_URL` | Simulation runner |
| `AGENTICS_SIMULATION_ENGINE_URL` | Simulation engine |
| `ENTERPRISE_ROI_ENGINE_URL` | ROI engine |
| `AGENTICS_INTENT_URL` | Deployment intent |
| `AGENTICS_EXPORTERS_URL` | Deployment exporters |
| `DILIGENCE_URL` | Diligence artifacts |

## Exit Codes

| Code | Description |
|------|-------------|
| 0 | Success |
| 1 | General error |
| 64 | Usage error |
| 65 | Data format error |
| 69 | Service unavailable |
| 70 | Internal error |
| 100 | Argument validation error |
| 120 | Network error |
| 130 | Authentication error |
| 140 | Service error |

## Examples

### Full Workflow

```bash
# 1. Create plan for production deployment
agentics plan "prod-cluster-v2" --params '{"region":"us-east-1"}'

# 2. Run 10 simulation iterations
agentics simulate '{"id":"plan-abc123","type":"PlanReference"}' \
  --iterations 10 \
  --config '{"parallelism":4}'

# 3. Get simulation metrics
agentics inspect '{"id":"sim-xyz789"}' --output-type metrics --format table

# 4. Generate CFO report
agentics quantify '{"id":"sim-xyz789"}' \
  --report-type cfo-grade \
  --params '{"currency":"USD","timeframe":"annual"}'

# 5. Deploy to staging
agentics deploy '{"id":"sim-xyz789"}' --environment staging

# 6. Export Terraform configs
agentics export '{"id":"intent-456"}' \
  --export-format terraform \
  --output ./infrastructure/

# 7. Package compliance docs
agentics diligence '[{"id":"sim-xyz789"},{"id":"intent-456"}]' \
  --frameworks SOC2,HIPAA
```

### JSON Output for Scripting

```bash
# Get simulation ID from plan
PLAN_REF=$(agentics plan "my-deployment" --format json)
SIM_REF=$(agentics simulate "$PLAN_REF" --format json)
agentics quantify "$SIM_REF" --report-type executive-summary
```

## Platform

For API key management and interactive workflows, visit:
**https://platform.agentics.dev**

## Requirements

- Node.js >= 18.0.0

## License

MIT
