---
name: policy
description: Create and manage governance policies
---

# Policy

Create, manage, and enforce governance policies for your infrastructure.

## Subcommands

| Subcommand | Description | Synthesis |
|------------|-------------|-----------|
| `create` | Create a new governance policy | [synth] |
| `list` | List all policies | read-only |
| `inspect` | Inspect a specific policy | read-only |
| `edit` | Edit an existing policy | [synth] |
| `enable` | Enable a policy (critical decision) | [synth] |
| `disable` | Disable a policy | [synth] |
| `dry_run` | Dry-run a policy to evaluate impact | [synth] |
| `scope` | Show the scope of a policy | read-only |
| `delete` | Delete a policy | admin |

## Usage

- **Create**: `mcp__agentics-cli__agentics_policy_create` with `description` and optional `name`
- **List**: `mcp__agentics-cli__agentics_policy_list`
- **Inspect**: `mcp__agentics-cli__agentics_policy_inspect` with `policy` name/ID
- **Enable**: `mcp__agentics-cli__agentics_policy_enable` with `policy` name/ID
- **Disable**: `mcp__agentics-cli__agentics_policy_disable` with `policy` name/ID
- **Dry-run**: `mcp__agentics-cli__agentics_policy_dry_run` with `policy` name/ID
- **Scope**: `mcp__agentics-cli__agentics_policy_scope` with `policy` name/ID

## Examples

Create a policy:
> Create a cost-cap policy that limits production spend to $500/month

Dry-run a policy:
> Dry-run the cost-cap-prod policy to see what it would affect

Enable a policy:
> Enable policy cost-cap-prod
