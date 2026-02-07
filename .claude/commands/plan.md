---
name: plan
description: Create and manage deployment plans
---

# Plan

Create, review, approve, and manage deployment plans from natural-language descriptions.

## Subcommands

| Subcommand | Description | Synthesis |
|------------|-------------|-----------|
| `create` | Create a new deployment plan | [synth] |
| `list` | List all plans | read-only |
| `inspect` | Inspect a plan by ID | read-only |
| `approve` | Approve a plan (commitment decision) | [synth] |
| `delete` | Delete a plan by ID | admin |

## Usage

- **Create**: `mcp__agentics-cli__agentics_plan_create` with a `description`
- **List**: `mcp__agentics-cli__agentics_plan_list`
- **Inspect**: `mcp__agentics-cli__agentics_plan_inspect` with an `id`
- **Approve**: `mcp__agentics-cli__agentics_plan_approve` with an `id`
- **Delete**: `mcp__agentics-cli__agentics_plan_delete` with an `id`

## Examples

Create a plan:
> Plan a blue-green deployment for our payment service to AWS ECS

Approve a plan:
> Approve plan plan-abc-123

List plans:
> Show all my deployment plans
