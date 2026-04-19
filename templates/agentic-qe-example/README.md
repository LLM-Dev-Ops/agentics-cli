# agentic-qe Adapter — Staged Content

This directory contains **AQE-specific artifacts** that belong in the eventual
`agentic-qe` adapter repo (per ADR-PIPELINE-082). These files are staged here
because that repo does not yet exist; they are designed to be dropped into the
new repo after it is provisioned.

## Bootstrapping the agentic-qe repo

```bash
# 1. Create the repo from the generic adapter template (ADR-PIPELINE-081)
cp -r templates/adapter-repo ~/work/agentic-qe
cd ~/work/agentic-qe

# 2. Overlay the AQE-specific artifacts from this directory
cp -r ../path/to/agentics-cli/templates/agentic-qe-example/src/* src/
cp -r ../path/to/agentics-cli/templates/agentic-qe-example/docs docs

# 3. Customize the manifest
sed -i 's|REPLACE-ME-agents|agentic-qe-agents|g' package.json
cat > bundle.json <<'EOF'
{
  "type": "adapter",
  "name": "agentic-qe-agents",
  "agentics_domain": "quality-engineering",
  "upstream": {
    "product": "agentic-qe",
    "mcp_command": "npx -y agentic-qe mcp start",
    "version_pin": "<PIN-EXACT-VERSION>"
  },
  "exposed_agents": [
    "test-design", "unit-test-gen", "integration-test-gen",
    "property-test-gen", "bdd-test-gen", "coverage-analysis",
    "coverage-gap-detect", "defect-prediction", "flaky-detection",
    "rca", "traceability", "chaos", "test-execution", "qe-reporting"
  ],
  "excluded_upstream_agents": [
    "Security-SAST", "Security-DAST", "Security-Compliance", "Security-Vulnerability-Scanner",
    "Performance-Profiler", "Latency-Analyzer", "Cold-Start-Monitor",
    "SAP-Integration-Tester", "SOAP-Validator", "Middleware-Tester", "OData-Validator",
    "Data-Anonymizer", "PII-Redactor", "Privacy-Auditor",
    "AQE-Learning-Orchestrator", "Pattern-Memory-Agent"
  ],
  "excluded_patterns": [
    "^(Security-|SAP-|SOAP-|Privacy-)"
  ]
}
EOF

# 4. Create handler files (one per exposed agent, following the template's
#    _example-handler.ts shape)
# ...

# 5. Validate and push
npx tsx ../path/to/agentics-cli/scripts/validate-adapter-bundle.ts .
gh repo create llm-dev-ops/agentic-qe --private --source=. --push
```

## What this directory contains

- `src/excluded-agents.ts` — the canonical 16-entry AQE exclusion list from
  ADR-082 §3, including regex patterns for defense against newly-added upstream
  tools.
- `docs/overlap-reviews/template.md` — weekly overlap-review template (used
  when upstream AQE adds a new agent; see ADR-082 §5).
- `docs/overlap-reviews/README.md` — overlap-review process notes.

## What this directory does NOT contain

- Generic adapter scaffolding (envelope, timeout, mcp-bridge, handlers) — those
  come from `templates/adapter-repo/`. Do not duplicate.
- `bundle.json` — construct it when bootstrapping the repo (see step 3 above).
- Unit tests — the generic template's conformance suite already covers the
  adapter contract; AQE-specific exclusion tests are embedded in the template's
  validator via the `excluded_upstream_agents` list.
