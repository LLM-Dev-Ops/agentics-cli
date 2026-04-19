# Adapter Repo Template

Reference scaffold for integrating an external MCP-based product into the Agentics ecosystem, per ADR-PIPELINE-081.

## Quick start

```bash
cp -r path/to/agentics-cli/templates/adapter-repo ./<domain>-agents
cd ./<domain>-agents

# 1. Update manifest + metadata
vim bundle.json       # set agentics_domain, upstream.*, exposed_agents
vim package.json      # set name to "<domain>-agents"

# 2. Populate exclusion list
vim src/excluded-agents.ts

# 3. Replace _example-handler with real handlers (one per exposed agent)
mv src/handlers/_example-handler.ts src/handlers/<agent-id>.ts

# 4. Wire upstream MCP subprocess
vim src/mcp-bridge.ts  # set UPSTREAM_COMMAND if different from bundle.json default

# 5. Validate locally (runs same check as CI)
npx tsx ../agentics-cli/scripts/validate-adapter-bundle.ts .

# 6. Commit and push
git init && git add -A && git commit -m "initial adapter scaffold"
gh repo create llm-dev-ops/<domain>-agents --private --source=. --push
```

## CI

Add `.github/workflows/conformance.yml` in the new repo:

```yaml
name: Adapter Conformance
on: [push, pull_request]
jobs:
  conformance:
    uses: llm-dev-ops/agentics-cli/.github/workflows/adapter-repo-contract.yml@main
    with:
      run_integration: true
```

## Register with agentics-cli

After the new repo is created, follow ADR-PIPELINE-080 pattern:

1. Add entry to `agentics-cli/docs/ecosystem.graph.json` infrastructure[]
2. Add `FUNCTION_NAMES['<domain>'] = '<repo-name>'` and `BUNDLE_NAMES['<repo-name>'] = '<repo-name>-agents'` in `agentics-cli/src/agents/repo-agent-runner.ts`
3. Add agent system prompts in `agentics-cli/src/agents/system-prompts.ts`
4. Add `[<repo-name>]="<repo-name>-agents"` entry to `agentics-cli/scripts/bundle-agents.sh`

## What the template provides

- `bundle.json` — adapter manifest (type: "adapter")
- `src/envelope.ts` — JSON envelope builder with correlation ID + timing
- `src/timeout.ts` — tier-specific AbortController wrappers (observational/advisory/gating)
- `src/mcp-bridge.ts` — upstream MCP subprocess lifecycle (spawn, handshake, tools/call, recovery)
- `src/excluded-agents.ts` — runtime exclusion enforcement (defense-in-depth with build-time check)
- `src/handlers/_example-handler.ts` — template for per-agent HTTP handlers
- `src/index.ts` — Cloud Function + local-mode dual entry point

## What to change per adapter

Per the contract (`docs/patterns/adapter-repo.md` §11):
- `bundle.json` fields (required)
- `src/excluded-agents.ts` content (required — see ADR-082 for AQE)
- `src/handlers/` files (one per `exposed_agents[]`)
- `package.json` name + upstream dependency pin
