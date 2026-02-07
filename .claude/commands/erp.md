---
name: erp
description: ERP integration and mapping
---

# ERP

Surface, map, and export ERP integration points for your deployment plans.

## Subcommands

| Subcommand | Description | Synthesis |
|------------|-------------|-----------|
| `list` | List all connected ERP systems | read-only |
| `inspect` | Inspect a specific ERP system | read-only |
| `surface` | Surface ERP integration points for a scenario | [synth] |
| `map` | Map a plan to ERP integration points | [synth] |
| `export` | Export ERP integration artifacts | [synth] |

## Usage

- **List**: `mcp__agentics-cli__agentics_erp_list`
- **Inspect**: `mcp__agentics-cli__agentics_erp_inspect` with `system` name/ID
- **Surface**: `mcp__agentics-cli__agentics_erp_surface` with a `description`
- **Map**: `mcp__agentics-cli__agentics_erp_map` with a plan `id`
- **Export**: `mcp__agentics-cli__agentics_erp_export` with a plan `id`

## Examples

Surface integration points:
> Surface ERP integration points for migrating our order processing to cloud

Map a plan to ERP:
> Map plan plan-abc-123 to our ERP systems

List connected systems:
> Show all connected ERP systems
