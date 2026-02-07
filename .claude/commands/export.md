---
name: export
description: Export deployment artifacts as IaC
---

# Export

Export deployment plans as infrastructure-as-code artifacts.

## Subcommands

| Subcommand | Description | Synthesis |
|------------|-------------|-----------|
| `terraform` | Export as Terraform IaC | [synth] |
| `kubernetes` | Export as Kubernetes manifests | [synth] |
| `erp` | Export ERP integration artifacts | [synth] |

## Usage

- **Terraform**: `mcp__agentics-cli__agentics_export_terraform` with a plan `id`
- **Kubernetes**: `mcp__agentics-cli__agentics_export_kubernetes` with a plan `id`
- **ERP**: `mcp__agentics-cli__agentics_export_erp` with a plan `id`

## Examples

Export as Terraform:
> Export plan plan-abc-123 as Terraform

Export as Kubernetes:
> Export plan plan-abc-123 as Kubernetes manifests

Export ERP artifacts:
> Export ERP integration artifacts for plan plan-abc-123
