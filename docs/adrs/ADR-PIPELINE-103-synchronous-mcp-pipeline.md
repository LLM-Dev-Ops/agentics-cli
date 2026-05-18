# ADR-PIPELINE-103: Synchronous MCP Pipeline — End the Fast-Return Pattern

**Status:** Implemented in v2.7.41
**Date:** 2026-05-18
**Priority:** HIGH — UX-critical; exposes the pipeline's internal architecture to end users
**Supersedes:** ADR-PIPELINE-088 (MCP fast-return auto-chain) — its detached-spawn mechanism is removed

---

## Context

ADR-PIPELINE-088 (v2.5.4) added "fast-return" semantics to `agentics-ask` over MCP. The mechanism:

1. Run Phase 1 inline.
2. Spawn a detached child subprocess (`agentics _autochain <traceId>`, `detached: true`, `stdio: ignore-stream-stream`, `child.unref()`) that runs Phases 2-6 in the background.
3. Return immediately to the MCP server with a structured `AGENTICS_TRACE_ID=...` + `AGENTICS_AUTOCHAIN_STATUS=background` marker block.
4. Consumer Claude was expected to poll `agentics-status` with the trace id to observe completion.

The original justification: Claude Code's MCP client-side tool-call timeout was shorter than the 30-60 minute pipeline. Fast-return prevented "Tool result missing due to internal error."

### Why this fails the end user

A 2026-05-18 field run with the new harness prompts (ADR-PIPELINE-101) produced this consumer Claude response:

> Phase 1 completed successfully — the enterprise simulator agent has produced an initial concept assessment. Phases 2-6 (SPARC specs, ADRs, DDD model, implementation prompts) are running in the background and typically take 30-60 minutes; planning artifacts under `.agentics/plans/` are not yet written. Trace ID: f2ef3d0a-... Background log: ~/.agentics/runs/f2ef3d0a-.../autochain.log
>
> How would you like to proceed?
> 1. Poll until planning artifacts land, then build (~30-60 min wait)
> 2. Start scaffolding now in parallel
> 3. Just show the Phase 1 result
> 4. Poll status once, then decide

User verdict, verbatim: *"This should never be asked ... End-users need this to just 'work'."*

The defect is structural. The MCP tool description at `mcp-server.ts:144` literally tells consumer Claudes that "Phases 2-6 run in the background and typically complete in 30-60 minutes — poll `agentics-status` with the returned trace id." So the consumer Claude is doing exactly what the tool told it to do: surface the background state to the user and offer choices about whether to wait, scaffold, or stop.

This breaks the contract end users expect. They run a planning command, they want a planning result. Not a trace id, not a polling instruction, not a decision tree about background work.

### Why fast-return is no longer needed

Two changes since ADR-088 made fast-return obsolete:

1. **`runCLI` in `mcp-server.ts:705-773`** already has a 2-hour child timeout and emits per-event progress notifications (`processLine` at line 718-728) plus a 5s heartbeat (`setInterval` at line 937). Claude Code's MCP client extends its idle timeout on progress notifications. The infrastructure to hold a long-running call is in place; fast-return is no longer the only way to keep the connection alive.

2. **The harness (ADR-PIPELINE-101)** now requires the consumer Claude to BUILD a working prototype from the planning artifacts. Without synchronous completion, the consumer Claude sees empty artifact directories at MCP-return time and either presents the menu above or starts building blind. Both outcomes contradict the harness contract.

## Decision

Remove the MCP fast-return path. Run the auto-chain synchronously in all modes.

### 1. Delete the `if (mcpMode)` branch in `cli/index.ts:2337-2428`

The branch that conditionally spawned a detached child (`spawn(process.execPath, [selfPath, '_autochain', traceId], { detached: true, ... }); child.unref();`) is removed. Both MCP and shell invocations now go through the same inline path: `await executeAutoChain(traceId, { verbose })`.

Side-effect markers no longer emitted:
- `AGENTICS_AUTOCHAIN_STATUS=background`
- `AGENTICS_AUTOCHAIN_PID=<pid>`
- `AGENTICS_AUTOCHAIN_LOG=<path>`
- `AGENTICS_AUTOCHAIN_STATUS_FILE=<path>`
- `AGENTICS_PLANS_DIR=<path>`
- `AGENTICS_PHASE1_VERDICT=<verdict>`
- `AGENTICS_PHASE1_DEGRADATIONS=<count>`

`AGENTICS_TRACE_ID=<id>` is preserved — the MCP tool wrapper at `mcp-server.ts:1133` still parses it for inclusion in the response payload.

### 2. Rewrite the `agentics-ask` tool description in `mcp-server.ts:144`

Remove all "background" / "poll" / "trace id" instructions. New description tells consumer Claudes explicitly:

> This call BLOCKS until all phases complete (typically 5-60 minutes depending on scope). Progress notifications stream every 5 seconds and on each phase boundary; do NOT poll, do NOT ask the user how to proceed, do NOT spawn background work — hold the connection and wait. When this returns, all planning artifacts are present in `.agentics/plans/`.

The "BUILD a working prototype from these artifacts" instructions in the response body (lines 1016-1124) already serve their purpose; they're now valid because the artifacts ARE present when the response is constructed.

### 3. Reframe missing-artifact warnings

The current warnings at `mcp-server.ts:1006-1011` say things like "WARNING: ADRs were not generated — Phase 4 may have failed." Under the synchronous model, "may have failed" becomes "failed." Updated to direct the consumer at the `[ADR WRITE FAILED]` and `[STRUCTURE FAIL]` markers from ADR-PIPELINE-101's harness:

> WARNING: ADRs are missing — Phase 4 failed. Grep the pipeline output above for "[ADR WRITE FAILED]" or "[STRUCTURE FAIL]" to find the cause.

### 4. Repurpose `agentics-status`

`agentics-status` is no longer used as a polling tool during in-flight runs (there are no in-flight runs that an MCP call hasn't already waited for). It's still useful as a diagnostic for inspecting a prior run's manifest, artifact counts, and error log. Tool description updated accordingly.

The status-file emission machinery in the CLI is kept intact for the shell-invocation path and for the `_autochain` subprocess subcommand (still callable directly for testing).

## Implementation

Single commit on `main`. ~120 lines deleted (the `if (mcpMode)` branch and its detached-spawn fallback), ~25 lines added (the unified inline path with a single `console.log('AGENTICS_TRACE_ID=...')` marker preserved for the MCP wrapper).

Tool description edits at `mcp-server.ts:144` and `:157`. Warning-message edits at `mcp-server.ts:1006-1011`.

Published as `@llm-dev-ops/agentics-cli@2.7.41`.

## Validation

- `tsc --noEmit`: clean
- `npm run build`: clean
- Manual smoke test from this repo: `process.env.MCP_SERVER_MODE='1'; ... await executeAgentsCommand(...)` runs Phases 1-6 synchronously and returns only after Phase 6 completes
- The MCP server's 5s heartbeat (mcp-server.ts:937) and per-event progress notifications (mcp-server.ts:718-728) keep the connection alive across the full pipeline duration
- runCLI's 2-hour timeout (mcp-server.ts:756-759) covers the worst-case pipeline length

## Consequences

### Positive

- **End users see a planning result, not a polling instruction.** The MCP call completes when the pipeline completes. The consumer Claude has artifacts to build from on first response.
- **No more "How would you like to proceed?" menus.** Consumer Claudes have unambiguous instructions in the tool description ("do NOT poll, do NOT ask the user, hold the connection").
- **`.agentics/plans/` is guaranteed populated** when the MCP call returns. The "BUILD a prototype" instructions in the response body are now actionable on first read.
- **One fewer race condition.** The fast-return path could return before the auto-chain wrote its first file; consumer Claudes would race to read what wasn't there yet. Gone.
- **Simpler control flow.** One code path for MCP and shell modes. ~120 lines deleted.

### Negative

- **MCP clients that don't honor progress-notification timeout extension may disconnect.** Claude Code does (the 5s heartbeat has been working for the 5-15s cold-start window since 2.5.3). Other MCP clients may or may not. If a client times out mid-pipeline, the server still completes the run and artifacts land on disk; the client loses the response payload but a follow-up `agentics-status <trace-id>` (or just reading `.agentics/plans/`) recovers the result.
- **The `_autochain` CLI subcommand** that was the target of the detached spawn is now only invoked by the shell-invocation path for testing. It remains as dead-ish code; not removed in this ADR's scope.
- **No more "instant feedback after Phase 1"** that some users relied on to inspect the simulator output before letting the rest of the pipeline run. If that pattern is genuinely needed, a future `agentics-ask-phase1-only` tool can be added explicitly. Don't shoehorn it back into `agentics-ask` by reintroducing fast-return.

### Neutral

- `AGENTICS_TRACE_ID=<id>` marker is preserved on stdout — the MCP wrapper still parses it.
- `agentics-status` remains in the toolset as a diagnostic surface for old runs.

## Related

- **ADR-PIPELINE-088** (MCP fast-return auto-chain) — superseded; its detached-spawn mechanism is removed
- **ADR-PIPELINE-101** (Remove AQE + lock-down prompts + harness validators) — the harness this ADR makes deliverable end-to-end
- **ADR-PIPELINE-102** (ESM-safe require + consensus 0% fix) — prerequisite; without the ruflo probe fix, the synchronous path would still emit `ADR-FAIL-001` stubs
- **ADR-PIPELINE-089** (Phase 1 health gate + retry-widening) — Phase 1 verdict computation is unchanged; only the response timing changes
