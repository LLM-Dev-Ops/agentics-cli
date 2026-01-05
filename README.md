# @llm-dev-ops/agentics-cli

[![npm version](https://img.shields.io/npm/v/@llm-dev-ops/agentics-cli.svg)](https://www.npmjs.com/package/@llm-dev-ops/agentics-cli)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

CLI for the Agentics Platform - orchestrate simulations, analyze ROI, and deploy AI agent infrastructure.

## Installation

```bash
npm install -g @llm-dev-ops/agentics-cli
```

Or run directly with npx:

```bash
npx @llm-dev-ops/agentics-cli --help
```

## Quick Start

```bash
# Create a simulation plan
agentics plan "production-deployment"

# Run simulation
agentics simulate '{"id":"plan-123"}' --iterations 10

# Inspect results
agentics inspect '{"id":"sim-456"}' --output-type metrics

# Generate ROI report
agentics quantify '{"id":"sim-456"}' --report-type cfo-grade

# Deploy
agentics deploy '{"id":"sim-456"}' --environment staging

# Export infrastructure
agentics export '{"id":"intent-789"}' --export-format terraform
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

Execute a simulation from a plan reference.

```bash
agentics simulate <plan-ref> [--config <json>] [--iterations <n>]
```

### inspect

Retrieve deterministic outputs from a simulation.

```bash
agentics inspect <sim-ref> [--output-type <type>]
```

Output types: `metrics`, `logs`, `state`, `events`, `summary`, `full`

### quantify

Generate financial impact and ROI analysis.

```bash
agentics quantify <sim-ref> [--report-type <type>] [--params <json>]
```

Report types: `executive-summary`, `detailed-analysis`, `cfo-grade`, `custom`

### deploy

Resolve deployment intent from simulation results.

```bash
agentics deploy <sim-ref> [--spec <json>] [--environment <env>]
```

### export

Generate infrastructure-as-code deployment artifacts.

```bash
agentics export <intent-ref> [--export-format <format>] [--output <path>]
```

Export formats: `terraform`, `kubernetes`, `cloudformation`, `pulumi`, `ansible`, `custom`

### diligence

Package compliance and audit artifacts.

```bash
agentics diligence <refs> [--frameworks <list>] [--requirements <json>]
```

Frameworks: `SOC2`, `HIPAA`, `GDPR`, `PCI-DSS`, `custom`

## Global Options

| Option | Description |
|--------|-------------|
| `--timeout <ms>` | Request timeout in milliseconds |
| `--trace-id <id>` | Correlation ID for distributed tracing |
| `--format <fmt>` | Output format: `json`, `yaml`, `table`, `text`, `csv` |
| `--verbose, -v` | Enable verbose output |
| `--pretty` | Pretty-print output |
| `--help, -h` | Show help |
| `--version` | Show version |

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
**https://platform.agentics.org**

## Requirements

- Node.js >= 18.0.0

## License

MIT
