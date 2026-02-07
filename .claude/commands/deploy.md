---
name: deploy
description: Preview, execute, and manage deployments
---

# Deploy

Preview, execute, monitor, and rollback deployments from approved plans.

## Subcommands

| Subcommand | Description | Synthesis |
|------------|-------------|-----------|
| `preview` | Preview a deployment with risk analysis | [synth] |
| `run` | Execute a deployment (irreversible) | [synth] |
| `status` | Check deployment status by ID | read-only |
| `rollback` | Rollback a deployment (incident-grade) | [synth] |

## Usage

- **Preview**: `mcp__agentics-cli__agentics_deploy_preview` with a plan `id`
- **Run**: `mcp__agentics-cli__agentics_deploy_run` with a plan `id`
- **Status**: `mcp__agentics-cli__agentics_deploy_status` with a deployment `id`
- **Rollback**: `mcp__agentics-cli__agentics_deploy_rollback` with a deployment `id`

## Examples

Preview a deployment:
> Preview deployment for plan plan-abc-123

Execute a deployment:
> Deploy plan plan-abc-123

Check status:
> What's the status of deployment deploy-xyz-789?

Rollback:
> Rollback deployment deploy-xyz-789
