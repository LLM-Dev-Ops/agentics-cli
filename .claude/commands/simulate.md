---
name: simulate
description: Create and manage simulation scenarios
---

# Simulate

Create, run, and manage simulation scenarios from natural-language descriptions.

## Subcommands

| Subcommand | Description | Synthesis |
|------------|-------------|-----------|
| `create` | Create a new simulation from a description | [synth] |
| `run` | Execute an existing simulation scenario | [synth] |
| `list` | List all simulations | read-only |
| `inspect` | Inspect a simulation run by ID | read-only |
| `delete` | Delete a simulation scenario | admin |

## Usage

Use the MCP tools directly:

- **Create**: `mcp__agentics-cli__agentics_simulate_create` with a `description` parameter
- **Run**: `mcp__agentics-cli__agentics_simulate_run` with a `scenario` ID
- **List**: `mcp__agentics-cli__agentics_simulate_list`
- **Inspect**: `mcp__agentics-cli__agentics_simulate_inspect` with an `id`
- **Delete**: `mcp__agentics-cli__agentics_simulate_delete` with a `scenario` ID

## Examples

Create a simulation:
> Simulate migrating our monolith to microservices with 3 teams over 6 months

Run an existing scenario:
> Run simulation scenario "microservices-migration"

List all simulations:
> Show me all my simulations

Inspect results:
> Inspect simulation run abc-123
