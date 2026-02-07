---
name: help
description: Show all Agentics CLI commands
---

# Agentics CLI Commands

Enterprise orchestration platform for simulation, planning, deployment, and governance.

## Core Workflows

| Command | Description | Type |
|---------|-------------|------|
| `/simulate` | Create and run simulation scenarios | [synth] |
| `/plan` | Create and manage deployment plans | [synth] |
| `/deploy` | Preview, execute, and rollback deployments | [synth] |
| `/export` | Export as Terraform, Kubernetes, or ERP artifacts | [synth] |

## Governance

| Command | Description | Type |
|---------|-------------|------|
| `/policy` | Create and enforce governance policies | [synth] |
| `/erp` | ERP integration surfacing and mapping | [synth] |
| `/quantify` | ROI analysis and cost quantification | [synth] |

## Analysis

| Command | Description | Type |
|---------|-------------|------|
| `/inspect` | Inspect resources, runs, and artifacts | read-only |
| `/audit` | Run audit analysis on the project | [synth] |
| `/diligence` | Due diligence on vendors and references | [synth] |

## Account

| Command | Description | Type |
|---------|-------------|------|
| `/login` | Authenticate the CLI | |
| `/whoami` | Show identity, org, and role | read-only |
| `/usage` | View usage, costs, and rate limits | read-only |

## Quick Start

1. `/login` - Authenticate
2. `/plan` - Create a deployment plan
3. `/simulate` - Simulate the plan
4. `/deploy` - Deploy when ready
