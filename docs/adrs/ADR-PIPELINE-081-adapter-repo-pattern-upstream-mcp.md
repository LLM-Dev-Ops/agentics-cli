# ADR-PIPELINE-081: Adapter Repo Pattern for Upstream MCP Capabilities

**Status:** Proposed
**Date:** 2026-04-18
**Priority:** HIGH — Establishes integration pattern for AQE and future upstream MCP products
**Originating Review:** AQE Integration Planning (plans/AQE_INTEGRATION.md §2.2)
**Builds on:** ADR-PIPELINE-080 (Quality Engineering Domain Registration), ADR-030 (Ecosystem Capability Graph)

## Context

The upstream Agentic QE project exposes its capabilities through a Model Context Protocol (MCP) server. Other strategically valuable upstream products (Claude SDK agents, community MCP tools, vendor-supplied QE/security/testing products) are also increasingly MCP-native.

Our ecosystem's dispatch layer (`src/agents/repo-agent-runner.ts:160-257`) expects each domain to be a repo that either:
- Runs locally via a Claude Code subprocess (`AGENTICS_LOCAL_AGENTS=true`), or
- Deploys as a GCP Cloud Function invokable over HTTPS with auth.

These two contracts do not accept MCP-native upstreams directly. We have three options:

1. **Teach the CLI to consume MCP servers** — rejected in ADR-PIPELINE-080 (§6). Forks the integration architecture.
2. **Rewrite every upstream MCP product as a native agentics repo** — infeasible; we don't own them.
3. **Adapter repo pattern** — a thin repo in our ecosystem that wraps the upstream MCP server and presents the standard agentics agent-runner contract.

Option 3 is the right trade. It isolates MCP knowledge to a single layer, preserves the CLI's clean one-directional MCP surface, and works for any MCP upstream — not just AQE.

## Decision

### 1. The Adapter Repo Contract

An adapter repo for an upstream MCP product MUST:

1. Expose one HTTP handler per exposed upstream tool/agent, matching the agentics agent-runner contract:
   ```
   POST /agents/{agentName}
   Body:    { query: string, correlation_id: string, context?: object }
   Returns: { status: 200 | 502, data: object, execution_metadata: object, timing: number }
   ```
2. Start and manage the upstream MCP server as a subprocess (or consume it as a library if published as npm).
3. Translate each HTTP request into an MCP `tools/call` method against the upstream.
4. Translate the MCP response back into the agentics JSON envelope.
5. Emit structured JSON only. No narrative, no streaming text outside the `data` field. (Satisfies Output Format Gate, `src/gates/index.ts`.)
6. Propagate `correlation_id` through MCP call metadata where possible; otherwise re-emit it in the response so downstream ruvector lineage can stitch spans.
7. Enforce timeout caps per tier (specified in ADR-PIPELINE-083):
   - Observational: 60s hard cap
   - Advisory: 120s hard cap
   - Gating: 300s hard cap
8. On timeout, return `{ status: 502, data: { error: "TIMEOUT_CAP_EXCEEDED", tier, cap_ms }, ... }`. Do not return partial results.
9. On upstream MCP error, return `{ status: 502, data: { error: <mcp_error_code>, details: <mcp_error_message> }, ... }`. Preserve upstream error codes in a `details.upstream_code` field.

### 2. Repo Layout

```
<adapter-repo>/
├── package.json                 # name: "<domain>-agents" (e.g., "agentic-qe-agents")
├── src/
│   ├── handlers/                # One file per exposed agent/tool
│   │   └── <agent-name>.ts
│   ├── mcp-bridge.ts            # Manages upstream MCP subprocess + tools/call dispatch
│   ├── system-prompts/          # Agent role definitions (agentics convention)
│   ├── envelope.ts              # JSON envelope construction + validation
│   ├── timeout.ts               # AbortController wrappers per tier
│   └── index.ts                 # Cloud Function entry + local-mode shim
├── bundle.json                  # Manifest consumed by scripts/bundle-agents.sh
├── tests/
│   ├── unit/                    # Handler-level tests with mocked MCP
│   └── integration/             # End-to-end against real upstream
└── README.md
```

### 3. MCP Subprocess Lifecycle

The `mcp-bridge.ts` module owns:
- Spawning the upstream MCP server (via `npx <upstream-pkg>` or equivalent).
- Handshake negotiation (`initialize` method).
- Tool listing at startup; fail-fast if expected tools are missing.
- Connection keepalive; restart on unexpected subprocess exit.
- Graceful shutdown on adapter process exit.

For Cloud Function deployments, the MCP server runs as a **sidecar within the same container** (not a separate service) to eliminate cold-start-on-cold-start latency. Handler warm-up during function init spawns the subprocess before the first request.

### 4. Dual Deployment Modes

Every adapter repo MUST support both:

- **Local mode**: When invoked via `AGENTICS_LOCAL_AGENTS=true`, handlers are importable Node modules callable in-process from `src/agents/local-agent-runner.ts`. The local runner supplies the Claude Code subprocess as the LLM backend for the MCP server where needed.
- **Cloud Function mode**: Default. Deployed to GCP as a standard agentics Cloud Function with auth and health endpoints.

The two modes MUST return byte-identical JSON envelopes for the same input. Integration tests validate this.

### 5. Upstream Version Pinning

The adapter `package.json` pins the upstream MCP product by exact SHA or version. CI runs a weekly rebase job:
1. Check latest upstream release.
2. If newer, branch, bump, run adapter tests, open PR.
3. Adapter owner reviews; auto-merge if adapter tests pass.
4. On merge, deploy adapter to dev; run smoke tests; promote to staging/prod per release procedure.

This keeps the adapter current without manual toil while preserving a review gate.

### 6. Excluded Tools

Each adapter repo maintains an explicit **exclusion list** for upstream tools that MUST NOT be exposed through agentics. Reasons for exclusion include:
- Overlap with existing domains (per ADR-PIPELINE-082 for AQE).
- ERP boundary violations (ADR-074 — only ERP-Surface talks to enterprise systems).
- Licensing constraints.
- Security-policy violations.

The exclusion list is enforced at **bundle build time**: if an excluded tool is referenced by any `system-prompts/` file or `handlers/` file, the bundle fails. This prevents accidental exposure.

### 7. Observability Contract

Every adapter request MUST emit a log entry with:
- `correlation_id`
- `upstream_mcp_tool`
- `tier` (observational/advisory/gating)
- `started_at`, `completed_at`, `duration_ms`
- `status`
- `upstream_cost` (token counts if available)

These feed the standard agentics observability pipeline via the existing `LLM-Observatory` domain — no new telemetry path.

## Implementation

1. Create a template repo `agentics-adapter-template` with the skeleton layout from §2.
2. Document the contract in `docs/patterns/adapter-repo.md`.
3. First adopter: `agentic-qe` (per ADR-PIPELINE-080). Completion of `agentic-qe` validates the template.
4. Add a CI workflow `.github/workflows/adapter-repo-contract.yml` that runs a conformance test suite against any repo declaring itself an adapter (via `bundle.json.type === "adapter"`).
5. Update `scripts/bundle-agents.sh` to detect `bundle.json.type === "adapter"` and enforce the exclusion-list check before bundling.

## Acceptance Criteria

1. The `agentic-qe` adapter repo exists, conforms to the contract in §1-§7, and passes the conformance test suite.
2. A second adapter repo can be scaffolded from the template with less than 1 hour of work (measured on the next MCP upstream we integrate).
3. Exclusion-list enforcement catches a deliberately-introduced forbidden tool during `npm run bundle-agents`.
4. Local mode and Cloud Function mode produce byte-identical envelopes for 10+ test cases across 3+ agents.
5. Upstream subprocess failure (killed PID) triggers automatic restart within 2 seconds; one in-flight request fails with `status: 502` but subsequent requests succeed.
6. Timeout cap enforcement: a deliberately slow upstream tool returns `status: 502 TIMEOUT_CAP_EXCEEDED` at the configured tier cap, not longer.

## Consequences

### Positive

- Insulates our ecosystem from upstream MCP API changes. Upstream breaks → adapter breaks → fix in one place.
- Any MCP-native product becomes integrable with a day of adapter work, not weeks of CLI refactoring.
- Preserves the CLI's one-directional MCP surface (expose-only), matching our architectural principles.
- Exclusion-list enforcement is a first-class part of the pattern, preventing accidental boundary violations at build time.

### Negative

- Adds a layer (HTTP → MCP translation) to the critical path. Measured overhead is typically 5-15ms per call; tolerable for agentics workloads.
- Creates a repo-per-upstream overhead. Managed by the template + weekly rebase automation.
- Subprocess lifecycle management is non-trivial — adapter owners must handle MCP handshake, tool discovery, crash recovery, and graceful shutdown correctly.

### Neutral

- Reuse of this pattern across domains means adapter-specific bugs could propagate via the template. Mitigated by the conformance test suite and adapter-owner review.

## Related

- **ADR-PIPELINE-080** (Quality Engineering Domain Registration) — first consumer of this pattern
- **ADR-PIPELINE-082** (AQE Agent Scope Boundary) — primary example of the exclusion-list mechanism
- **ADR-PIPELINE-086** (QE Kill-Switch and Gating Regression) — runtime safety that complements build-time exclusion
- **ADR-030** (Ecosystem Capability Graph) — the registration model adapters plug into
- **ADR-074** (Pipeline Must Use Platform Services) — architectural boundary exclusion lists enforce
- **plans/AQE_INTEGRATION.md** §2.2 — source design for the adapter shape
