---
name: quantify
description: ROI analysis and cost quantification
---

# Quantify

Create ROI reports, compare scenarios, and quantify the business impact of decisions.

## Subcommands

| Subcommand | Description | Synthesis |
|------------|-------------|-----------|
| `create` | Create an ROI report from a scenario | [synth] |
| `inspect` | Inspect an ROI report by ID | read-only |
| `list` | List all ROI reports | read-only |
| `compare` | Compare two ROI reports (tradeoff decision) | [synth] |

## Usage

- **Create**: `mcp__agentics-cli__agentics_quantify_create` with a `description`
- **Inspect**: `mcp__agentics-cli__agentics_quantify_inspect` with an `id`
- **List**: `mcp__agentics-cli__agentics_quantify_list`
- **Compare**: `mcp__agentics-cli__agentics_quantify_compare` with `id_a` and `id_b`

## Examples

Create an ROI report:
> Quantify the ROI of migrating from on-prem to AWS over 3 years

Compare two reports:
> Compare ROI report roi-001 vs roi-002

List all reports:
> Show all my ROI analyses
