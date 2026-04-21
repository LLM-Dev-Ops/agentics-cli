# ADR-PIPELINE-088: MCP Fast-Return Mode for `agentics ask` — Detach Auto-Chain so Claude Code Sees a Response Before Its Client Timeout Fires

**Status:** Proposed
**Date:** 2026-04-21
**Priority:** CRITICAL — every `agentics-ask` MCP invocation from Claude Code now reports "Tool result missing due to internal error"; the CLI direct path still works, but the MCP path — which is the primary end-user surface — does not.
**Originating Review:** Field report — user with a sustainability/water-cooling prompt that had been working for months via Claude Code MCP could no longer get any output after AQE (ADR-PIPELINE-080..086) landed; the `.swarm/` directory and `ruvector.db` appear in the test repo but no artifacts are produced before Claude Code surfaces a generic "internal error."
**Builds on:** ADR-PIPELINE-080..086 (AQE integration), ADR-PIPELINE-087 (resolver coverage + silent-drop fix).
**Supersedes:** None

## Context

`agentics ask "<prompt>"` runs a six-phase pipeline:

1. Graph routing + capability classification (fast — <5s)
2. Enterprise simulation via ruvector-service (medium — 15-60s)
3. Graph-routed agent dispatch (parallel — 30-120s)
4. **Auto-chain Phases 2-6** (`src/pipeline/auto-chain.ts:executeAutoChain`) — invoked inline when the ruvector simulation succeeds. Each phase coordinator (`phase2-coordinator.ts`, `ruflo-phase-executor.ts`, `frontend-generator.ts`) shells out to `ruflo swarm start` with a **15-minute per-phase timeout** (`src/pipeline/phase2/phase2-coordinator.ts:290`). Total pipeline wall time: 30-60 minutes in the happy case.

Until ADR-PIPELINE-080..086 landed, the ruvector simulation was failing often enough in the field that Step 4 was silently skipped (`simSucceeded === false` branch at `src/cli/index.ts:2261`), so the tool call returned in under a minute with Phase 1 output only. Users reported this as "working for months" because the plans-on-disk flow they cared about was never the thing being exercised.

After AQE integration, three things conspired to break this:

1. AQE added 14 mandatory agents to the phase-8 validation capability, expanding the graph-selected agent set on almost every prompt.
2. Graph routing is now reliable enough that simulation succeeds more often, which actually triggers auto-chain.
3. ADR-PIPELINE-087 landing 1 closed the silent-drop resolver gap, so classifier selections that used to be dropped now actually dispatch or short-circuit. Net effect: the pipeline reaches auto-chain much more often than it used to.

Auto-chain's 30-60-minute wall time has always been incompatible with Claude Code's MCP client-side tool-call timeout (~60s in the current release, previously ~5min). The mismatch was hidden by the simulation-failure quick-exit path. Now that simulation succeeds, every MCP invocation enters auto-chain, Claude Code gives up at the client-side timeout, and the user sees:

```
[Tool result missing due to internal error]
```

The subprocess continues running on the host, eventually writes artifacts to `.agentics/plans/`, and exits 0 — but Claude Code has already stopped listening. No amount of MCP-server heartbeats (shipped in 2.5.3) can extend a client-side hard timeout.

Three concrete defects are responsible:

1. **Inline auto-chain under MCP.** `src/cli/index.ts` calls `executeAutoChain` and awaits it before the ask command returns. Under MCP this blocks the response past the client's timeout.

2. **No background execution path.** `executeAutoChain` has no detached-process entry point; there is no way to start it and release the parent.

3. **No polling surface for phase completion.** Even if we detached auto-chain, the MCP client has no way to learn when phases 2-6 finish. The closest existing signal is artifact presence on disk, which is indirect and race-prone.

## Decision

Add a **fast-return mode** to `agentics ask` that activates when the CLI detects it is running as an MCP-spawned subprocess, plus a companion status surface so Claude Code can observe phase completion in subsequent turns.

### 1. Detect MCP mode

The MCP server already sets `MCP_SERVER_MODE=1` on every subprocess it spawns (`src/mcp/mcp-server.ts:682`). Reuse that signal — no new flag, no new argument.

### 2. Fast-return flow in `src/cli/index.ts:case 'ask'`

When `MCP_SERVER_MODE === '1'`:

- Run Phases 1a-1c inline (graph routing, simulation, graph-routed dispatch). Budget: ~60s. Already well within Claude Code's timeout in the success case.
- **Do not** call `executeAutoChain` inline. Instead, spawn a detached helper subprocess:
  ```ts
  const child = spawn(process.execPath, [CLI_ENTRY, '_autochain', traceId], {
    detached: true,
    stdio: ['ignore', fs.openSync(logPath, 'a'), fs.openSync(logPath, 'a')],
    env: { ...process.env, MCP_SERVER_MODE: '' },  // prevent recursion
  });
  child.unref();
  ```
  where `logPath` is `.agentics/runs/<traceId>/autochain.log`. The parent returns immediately; the child runs auto-chain to completion on its own.
- Emit a clear stdout block the MCP tool handler in `src/mcp/mcp-server.ts:910` can pattern-match:
  ```
  AGENTICS_TRACE_ID=<traceId>
  AGENTICS_AUTOCHAIN_STATUS=background
  AGENTICS_AUTOCHAIN_LOG=<logPath>
  AGENTICS_PLANS_DIR=<plansDir>
  ```
  These become structured fields in the MCP tool's content so Claude Code can surface them to the user verbatim.

When `MCP_SERVER_MODE !== '1'` (shell invocation): existing behaviour unchanged. Auto-chain runs inline, interactive terminal sees all progress.

### 3. Hidden `_autochain` subcommand

Add an undocumented `agentics _autochain <traceId>` command whose entire body is an import-and-call of `executeAutoChain`. Single argument: the trace id produced by Phase 1. It reads `.agentics/runs/<traceId>/phase1/` artifacts and drives phases 2-6. Stdout and stderr go to the log file opened by the parent.

Leading underscore keeps it out of `agentics help` listings. Users do not call this directly.

### 4. `agentics status <traceId>` command + MCP tool

New public subcommand. Reads `.agentics/runs/<traceId>/` and reports:

- Which phases have completed (based on the presence of `phase{N}/complete.marker` sentinel files that the phase coordinators will now write).
- Which phase is currently in progress (from the last-modified marker in the log, or a `current_phase` field in a status.json the auto-chain helper updates).
- Final exit status once `autochain.log` ends with the completion line.
- Paths to produced artifacts (`.agentics/plans/adrs/`, `ddd/`, etc.).

Expose as MCP tool `agentics-status`:

```json
{
  "name": "agentics-status",
  "description": "Check phase completion of a running or completed agentics-ask pipeline. Takes the AGENTICS_TRACE_ID returned by agentics-ask.",
  "inputSchema": { "type": "object", "properties": { "trace_id": { "type": "string" } }, "required": ["trace_id"] }
}
```

The MCP tool response includes the artifact paths as structured content so Claude Code can read them with its built-in `Read` tool — the exact pattern the existing `agentics-ask` response already uses for its "read these artifacts" instruction block.

### 5. Phase-completion markers

Each phase coordinator writes `.agentics/runs/<traceId>/phase{N}/complete.marker` (empty file, atomic rename from tmp) when its final artifact set is on disk. Coordinators that currently write their artifacts with no sentinel (phase2, phase3, phase4, phase5, phase6) get a single-line addition at the end of their success path. No behavioural change otherwise.

This is the authoritative completion signal for the status tool. File existence is atomic; file absence is also atomic; no parsing of in-flight logs required.

### 6. Update MCP tool description for `agentics-ask`

Add one sentence to `src/mcp/mcp-server.ts:140` telling the client to expect a trace id and use `agentics-status` to track phase completion. Claude Code's tool-routing model reads this description; the behavioural instruction goes there.

## Consequences

**Positive:**
- MCP `agentics-ask` invocations return in <90s on the happy path (Phase 1 only) instead of timing out after ~60s with zero output. Users see Phase 1 agent output plus a trace id plus instructions to poll with `agentics-status`.
- Artifacts still land on disk 30-60 minutes later; the user's "I want ADRs/DDDs/SPARC on disk" workflow is preserved.
- The shell path (`agentics ask` without MCP) is completely untouched — every existing interactive use keeps the same progress-streaming behaviour.
- The status tool gives Claude Code a first-class surface for observing long-running work instead of the current "stare at a tool call for an hour" pattern.

**Negative / risks:**
- Orphan processes: if the detached child crashes without writing artifacts AND without updating `status.json`, a `agentics-status` call returns "in progress" forever. Mitigation: the status command also checks child pid liveness (from a `pid` written at startup) and reports `crashed` when the pid is dead without a completion marker.
- Resource usage: detached auto-chain runs to completion even if the user abandons it. This matches the current behaviour (the subprocess already runs past the MCP timeout today) but makes it visible instead of a ghost process. Acceptable trade.
- `MCP_SERVER_MODE` false-positive: any other caller that sets this env var would also fast-return. Risk low — the variable is internal and undocumented for external use.

**Neutral:**
- `.agentics/runs/<traceId>/status.json` is a new small file (updated atomically). Fits the existing artifact-directory convention.

## Validation

Before merge:

1. **MCP happy path.** Run `agentics-ask` via a loopback MCP harness with a populated API key. Assert:
   - Tool response returned in <90s.
   - Response content contains `AGENTICS_TRACE_ID=...`, `AGENTICS_AUTOCHAIN_STATUS=background`, `AGENTICS_PLANS_DIR=...`.
   - A detached child process matching `agentics _autochain <id>` is running.
   - Within 30 minutes, `.agentics/plans/adrs/` and `.agentics/plans/ddd/` under the trace's run dir become non-empty.

2. **Shell path unchanged.** `agentics ask "<prompt>"` from a terminal still runs auto-chain inline and prints the combined pipeline + auto-chain display.

3. **Status polling.** `agentics status <traceId>` and the `agentics-status` MCP tool each return `{ phase: N, in_progress: true/false, artifacts: [...] }` matching the on-disk state. Test the crash path by `kill -9` on the detached child — status should report `crashed`.

4. **No regression on ADR-PIPELINE-087.** `scripts/check-graph-resolver-coverage.ts` still exits zero. `tests/unit/routing/` still green. The field-report probe still shows 12/12 resolved, 0 unresolved.

## Rollout

Single patch release (2.5.4). Entire change is gated on `MCP_SERVER_MODE === '1'`, so the shell path is untouched and no migration is needed for CLI users.

Rollback plan: revert the patch. The fast-return path has no on-disk schema that anything else depends on — the trace ids, markers, and status.json all live under `.agentics/runs/<traceId>/` which is already treated as ephemeral.

## References

- `src/cli/index.ts:2234-2305` — existing inline auto-chain call site on the `ask` command
- `src/mcp/mcp-server.ts:682` — `MCP_SERVER_MODE=1` spawn env
- `src/mcp/mcp-server.ts:905` — `await runCLI(...)` that blocks the MCP tool response on auto-chain completion
- `src/pipeline/auto-chain.ts:executeAutoChain` — the coordinator being detached
- `src/pipeline/phase2/phase2-coordinator.ts:290` — the 15-minute `ruflo swarm start` that dominates wall time
- `docs/adrs/ADR-PIPELINE-087-aqe-agent-name-resolver-and-pipeline-regression.md` — the prior landing that exposed this latent failure by raising Phase 1's success rate
