# Adapter Repo Pattern — Specification

**Source ADR:** ADR-PIPELINE-081 (Adapter Repo Pattern for Upstream MCP Capabilities)
**Status:** Active
**Audience:** Repo owners integrating an external MCP-based product into the Agentics ecosystem

An **adapter repo** wraps an upstream Model Context Protocol (MCP) server and presents it to the Agentics ecosystem through the standard registered-domain dispatch contract. The CLI (`agentics-cli`) never consumes MCP directly; adapter repos are the single translation layer.

This document is the authoritative contract. CI enforces it via `adapter-repo-contract.yml`; the bundler enforces it via `scripts/validate-adapter-bundle.ts`. Deviations will be caught automatically.

---

## 1. Repo Shape

```
<adapter-repo>/
├── package.json                 # name: "<domain>-agents" (e.g., "agentic-qe-agents")
├── bundle.json                  # adapter manifest (see §2)
├── tsconfig.json
├── src/
│   ├── handlers/                # One file per exposed agent
│   │   └── <agent-id>.ts
│   ├── mcp-bridge.ts            # Upstream MCP subprocess + tools/call dispatch
│   ├── envelope.ts              # JSON envelope construction + validation
│   ├── timeout.ts               # AbortController wrappers per tier
│   ├── excluded-agents.ts       # Hard-blocked upstream agents (see §6)
│   ├── system-prompts/          # Agent role definitions (agentics convention)
│   └── index.ts                 # Cloud Function entry + local-mode shim
├── tests/
│   ├── unit/
│   └── integration/
└── README.md
```

The `templates/adapter-repo/` directory in `agentics-cli` is the reference scaffold. Adopters clone or copy it as the starting point.

---

## 2. `bundle.json` Manifest

Every adapter repo MUST have a `bundle.json` at the repo root with at least these fields:

```json
{
  "type": "adapter",
  "name": "<domain>-agents",
  "agentics_domain": "<kebab-domain-name>",
  "upstream": {
    "product": "<upstream-name>",
    "mcp_command": "<command-to-start-mcp-server>",
    "version_pin": "<exact-version-or-sha>"
  },
  "exposed_agents": ["<agent-id>", "<agent-id>", "..."],
  "excluded_upstream_agents": ["<tool-name>", "..."],
  "excluded_patterns": ["<regex>", "..."]
}
```

**Field rules:**
- `type`: MUST equal `"adapter"`. This is how the bundler detects adapters.
- `name`: MUST end in `-agents` (matching the ecosystem bundle convention).
- `agentics_domain`: the domain key under which this adapter registers in `agentics-cli`'s `repo-agent-runner.ts` FUNCTION_NAMES map.
- `upstream.mcp_command`: the shell command that starts the upstream MCP server as a subprocess (e.g., `"npx -y agentic-qe mcp start"`).
- `upstream.version_pin`: exact version or git SHA; `"latest"` is forbidden.
- `exposed_agents`: list of agent IDs (kebab-case) that this adapter exposes. Each MUST have a matching file in `src/handlers/`.
- `excluded_upstream_agents`: explicit list of upstream tool names the adapter must never call (see §6).
- `excluded_patterns`: regex strings that match upstream tool names that must not be exposed (catches newly-added upstream tools).

---

## 3. HTTP Handler Contract

Each exposed agent has a handler file at `src/handlers/<agent-id>.ts`. The handler matches the Agentics agent-runner contract:

```
POST /agents/{agentName}
Body:    { query: string, correlation_id: string, context?: object }
Returns: { status: 200 | 502, data: object, execution_metadata: object, timing: number }
```

Handlers MUST:
1. Validate the incoming request body (Zod/Ajv).
2. Call `mcpBridge.toolsCall(upstreamToolName, query, correlationId)`.
3. Wrap the response in the standard envelope via `buildEnvelope(...)`.
4. Return JSON ONLY. No narrative text. No streaming prose outside the `data` field.

Handlers MUST NOT:
- Import or consume `excluded_upstream_agents` by name (build fails if detected).
- Return partial results on timeout (return `status: 502` with `data.error: "TIMEOUT_CAP_EXCEEDED"`).
- Swallow MCP errors silently (always propagate `upstream_code` in `data.details`).

---

## 4. MCP Subprocess Lifecycle (`mcp-bridge.ts`)

The MCP bridge owns:

| Responsibility | Requirement |
|----------------|-------------|
| Subprocess spawn | On handler module load (Cloud Function init) or adapter boot (local mode) |
| Handshake | `initialize` method → verify protocol version |
| Tool discovery | `tools/list` at startup; fail-fast if `exposed_agents` contains a tool missing from upstream |
| Dispatch | `tools/call` with `correlation_id` propagated in metadata |
| Crash recovery | Subprocess exit triggers restart within 2s; one in-flight request fails, subsequent succeed |
| Graceful shutdown | `SIGTERM` to subprocess on adapter shutdown; wait up to 5s before SIGKILL |

Cloud Function mode: the MCP server runs as a **sidecar in the same container**, not as a separate service. Warm-up during function init spawns it before the first request.

---

## 5. Timeout Tiers (`timeout.ts`)

Every MCP call is wrapped in an `AbortController` with a tier-specific cap:

| Tier | Cap | Used for |
|------|-----|----------|
| `observational` | 60_000 ms | Ad-hoc invocations, learning-bus only |
| `advisory` | 120_000 ms | Phase bindings as `optional_agents` |
| `gating` | 300_000 ms | Phase bindings as `mandatory_agents` |

Tier is selected by the handler based on invocation context (typically the `tier` field in `context` or derived from the phase). If no tier is provided, default is `advisory`.

Timeout exceeded → return `{ status: 502, data: { error: "TIMEOUT_CAP_EXCEEDED", tier, cap_ms }, ... }`. **Do not return partial results.**

---

## 6. Exclusion List (`excluded-agents.ts`)

Upstream tools that must not be exposed — either because they overlap with an existing Agentics domain (ADR-PIPELINE-082) or because they violate the ERP boundary (ADR-074).

Enforcement happens at two layers:

### 6.1 Build-time (pre-publish)

`scripts/validate-adapter-bundle.ts` (in agentics-cli, invoked by the bundler):
1. Parses `bundle.json`.
2. Enumerates handlers in `src/handlers/`.
3. For each handler, extracts the declared `upstreamTool` (exported constant or JSDoc tag).
4. Fails the build if any handler's `upstreamTool` matches `excluded_upstream_agents` or `excluded_patterns`.
5. Additionally, calls `mcp-bridge` tool-list (if the upstream is spawnable in CI) and checks for new upstream tools that match `excluded_patterns` — prompting an exclusion-list update.

### 6.2 Runtime

`mcp-bridge.toolsCall` checks the requested tool against the exclusion list before dispatch. If matched:
```json
{ "status": 502, "data": { "error": "EXCLUDED_AGENT", "upstream_tool": "<name>" }, ... }
```

This is a defense-in-depth check; build-time should already have caught accidental exposure.

---

## 7. Dual Deployment Modes

Adapters MUST support both:

### 7.1 Local mode

- Invoked when `AGENTICS_LOCAL_AGENTS=true` (or when `claude` binary is detected).
- Handlers are importable ESM modules called in-process from `agentics-cli/src/agents/local-agent-runner.ts`.
- The MCP subprocess runs on-demand per handler invocation (not kept warm).
- Claude Code subprocess serves as the LLM backend for MCP calls that need LLM reasoning.

### 7.2 Cloud Function mode

- Default deployment. GCP Cloud Function with auth.
- Handlers expose HTTP POST endpoints at `/agents/<agent-id>`.
- MCP subprocess is kept warm via function init + keepalive ping.
- Standard agentics Cloud Function auth token validates requests.

### 7.3 Envelope byte-identity

For the same input, local mode and Cloud Function mode MUST return byte-identical JSON envelopes (excluding `timing` and timestamps, which are expected to vary). Integration tests validate this per §9.

---

## 8. Observability (`envelope.ts`)

Every invocation emits a structured log entry AND a metric:

**Log (WARN-or-INFO level, JSON):**
```json
{
  "correlation_id": "...",
  "adapter": "agentic-qe",
  "upstream_mcp_tool": "...",
  "tier": "gating|advisory|observational",
  "started_at": "ISO8601",
  "completed_at": "ISO8601",
  "duration_ms": 1234,
  "status": 200,
  "upstream_cost_tokens": { "input": 1200, "output": 450 }
}
```

**Metrics (Observatory-ingested):**
- `adapter_invocations_total{adapter, agent, status}`
- `adapter_invocation_duration_ms{adapter, agent}` (histogram)
- `adapter_findings_total{adapter, agent, severity}`
- `adapter_timeout_total{adapter, agent, tier}`
- `adapter_excluded_block_total{adapter, tool}`

Metrics flow through the standard envelope metadata — no new telemetry pipeline.

---

## 9. Conformance Test Suite

Adapter repos MUST pass the reusable conformance workflow at `llm-dev-ops/agentics-cli/.github/workflows/adapter-repo-contract.yml`. The suite covers:

1. **Bundle validation** — `bundle.json` schema + exclusion check.
2. **Type check** — `tsc --noEmit`.
3. **Unit tests** — adapter-local unit tests (envelope, timeout, bridge).
4. **Handler inventory match** — every `exposed_agents[]` entry has a handler file; no orphan handlers.
5. **Exclusion enforcement** — deliberately-planted forbidden tool must fail validation.
6. **Envelope byte-identity** — local vs. cloud for a fixed input set.
7. **Subprocess recovery** — killing the MCP subprocess allows one failure then recovers.
8. **Timeout cap** — a deliberately slow tool returns 502 at the tier cap.

Items 6-8 can run in integration-test mode only; the reusable workflow marks them as `continue-on-error: true` during pre-release and `required` for merges to `main`.

---

## 10. Upstream Version Pinning & Rebase

`bundle.json.upstream.version_pin` is the exact pin. CI runs a weekly rebase job:

1. Check latest upstream release/tag.
2. If newer than `version_pin`, open a PR bumping the pin.
3. Run the full conformance suite against the new upstream.
4. Adapter owner reviews; auto-merge if conformance is green.
5. On merge, deploy to dev; promote per release procedure.

This keeps adapters current without manual toil while preserving a review gate. Implementation of the rebase job is a separate work item per adapter; a reference workflow lives in `templates/adapter-repo/.github/workflows/weekly-rebase.yml`.

---

## 11. Promotion From Template

Adopting the template for a new upstream:

```bash
# From agentics-cli
cp -r templates/adapter-repo ~/work/<domain>-agents
cd ~/work/<domain>-agents
git init && gh repo create llm-dev-ops/<domain>-agents --private --source=. --push
```

Then edit:
1. `package.json` — set name to `<domain>-agents`.
2. `bundle.json` — set `agentics_domain`, `upstream.*`, `exposed_agents`, exclusion list.
3. `src/handlers/` — one file per exposed agent (rename/duplicate `_example-handler.ts`).
4. `src/excluded-agents.ts` — populate the hard-blocked list per ADR-082 or equivalent.
5. Update `agentics-cli`'s `ecosystem.graph.json`, `repo-agent-runner.ts`, `bundle-agents.sh`, and `system-prompts.ts` per ADR-PIPELINE-080's pattern.

Target effort for a new adapter: **< 1 hour** from `cp -r` to green conformance run (ADR-081 acceptance criterion 2).

---

## 12. Non-Goals

- The CLI does not grow an MCP-consumer surface. Adapters are the only translation layer.
- The template does not ship upstream dependencies. Each adapter pins its own upstream.
- No "fail-open to upstream" semantics. Adapter failures are adapter failures; let the caller decide whether to tolerate per the phase-binding mode.
