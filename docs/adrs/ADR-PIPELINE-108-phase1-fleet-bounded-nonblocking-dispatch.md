# ADR-PIPELINE-108: Phase 1 Full-Fleet Dispatch — Bounded, Non-Blocking, Breaker Parity

**Status:** Proposed
**Date:** 2026-06-02
**Priority:** CRITICAL — This is the pipeline "choking" the user reported. Measured live on 2026-06-02 (run `bd63314c`, manufacturing/SAP prompt): **Phase 1 alone took ~6 minutes** and the supposedly-parallel 109-agent fleet ran effectively serially. Every `agentics ask` pays this tax before any real work begins.
**Builds on:** ADR-PIPELINE-089 (Phase 2 preflight + per-fanout health probing — this ADR brings the same discipline to the Phase 1 fleet, which currently has none), ADR-PIPELINE-094 D7 (cloud circuit breaker for Phase 2–6 fanouts — this ADR extends the breaker to Phase 1), ADR-066 (copilot/inference run via `claude --print` — this ADR keeps that but makes the call non-blocking).
**Related:** ADR-PIPELINE-109 (repo-backed execution — once agents run from local repo code, the cloud-timeout exposure this ADR bounds largely disappears; the two together are the full fix).

---

## Context

Phase 1 dispatches all 109 agents across 27 domains as a "full fleet" (`src/commands/agents.ts:4607`). The intent is parallelism. The reality, measured:

- All 8 waves are *supposed* to be announced within ~15s (the loop only `await`s a 2s stagger between waves of 15). In the live run, **"Wave 8/8" was not announced until +316s** — proof the dispatch loop itself was blocked.
- **Phase 1 completed at ~+357s (~6 min)** before the auto-chain (Phase 2–7) even started.

### Two compounding root causes

#### Cause 1 — No bound on the fleet (no per-agent timeout, no breaker)

The Phase 1 loop pushes `executeAgentsInvokeCommand(...)` for every agent into a `Promise.allSettled` (`agents.ts:4641`) with **no per-agent timeout and no circuit breaker**. Each call blocks up to its per-service adapter timeout, which ranges **15s to 300s** (`src/config/endpoints.ts`). The cloud agent paths return 404 and no GCP identity token is available (`gcloud` absent), so calls fail — but only after their full timeout, and `allSettled` waits for the *slowest of 109*.

The Phase 2–6 path already solved this and Phase 1 simply doesn't use it:

| Mechanism | Phase 2–6 (`swarm-orchestrator.ts`) | Phase 1 fleet (`agents.ts:4607`) |
|---|---|---|
| Per-agent timeout | `AGENT_INVOKE_TIMEOUT_MS = 30_000` (race) | **none** |
| Fleet-wide cap | `DISPATCH_ALL_TIMEOUT_MS = 45_000` | **none** |
| Cloud circuit breaker | `CloudCircuitBreaker` (ADR-094 D7) | **none** |
| Health preflight | Phase 2 preflight (ADR-089) | **none** |

#### Cause 2 — Synchronous `claude --print` blocks the event loop

The 7 `copilot/*` agents (and `inference-gateway/route`) run via `runCopilotViaClaudeMax`, which calls **`execFileSync(claudeBin, ['--print', …])`** (`agents.ts:68`, and `:163` for routing). `execFileSync` is **synchronous** — it freezes Node's single-threaded event loop for the entire duration of each `claude` generation (tens of seconds each). While blocked, none of the other agents' async `fetch`es can progress and the wave loop's `setTimeout` can't fire. This is why "parallel" Phase 1 serializes and why Wave 8 stalled to +316s.

Per-agent timeout alone would not fix Cause 2: a synchronous call cannot be raced against a `setTimeout` — the timer never fires while the thread is blocked.

## Decision

Five rules. D1–D2 bound the fleet; D3 fixes the blocking call; D4–D5 cover preflight and config.

### D1. Per-agent timeout on the Phase 1 fleet

Wrap every Phase 1 agent invocation in the same race used by the Phase 2–6 path — a per-agent timeout (default 30s, env-tunable). A timed-out agent resolves to a recorded failure (not a throw), so `allSettled` is unaffected and the fleet never waits past the cap for any single agent.

### D2. Fleet-wide cap + circuit-breaker parity

- Apply a **fleet-wide deadline** (default 60s; the fleet is larger than a phase fanout so the cap is higher than Phase 2–6's 45s). When it elapses, collect whatever has completed and mark the rest `pending`/`skipped` — exactly the `DISPATCH_ALL_TIMEOUT_MS` pattern.
- Reuse `CloudCircuitBreaker` (ADR-094 D7): after N consecutive cloud failures the breaker trips and remaining cloud calls short-circuit instead of each eating 30s. Given the cloud paths are currently all failing, the breaker turns a 6-minute stall into seconds.

### D3. `claude --print` MUST be asynchronous (non-blocking)

Replace `execFileSync` in `runCopilotViaClaudeMax` and `runInferenceRoutingViaClaudeMax` with the **async** runner (`execFile`/`spawn` via the existing `createClaudeCodeRunner`, awaited). This frees the event loop so the rest of the fleet truly runs in parallel and so D1's per-agent timeout can actually fire against these calls. No synchronous `exec*Sync` may be used inside an agent invocation on the fleet path.

### D4. Phase 1 fleet preflight (extend ADR-089)

Before dispatch, probe each unique backend's health (the ADR-089 Phase 2 preflight, generalised to the Phase 1 fleet). Agents bound to unhealthy backends are skipped up front rather than dispatched-then-timed-out. (The live run showed Phase 2 already does this — "9/14 backends healthy … skipping 10 agents"; Phase 1 must do the same.) When repo-backed execution (ADR-109) is active, agents with a local repo skip the health probe entirely — they don't need the cloud.

### D5. All bounds are config, logged for reproducibility

`AGENTICS_FLEET_AGENT_TIMEOUT_MS` (default 30000), `AGENTICS_FLEET_TIMEOUT_MS` (default 60000), `AGENTICS_CLOUD_BREAKER_THRESHOLD` (existing). The effective values are written into `manifest.json` so a run's timing envelope is reproducible.

## Consequences

### Positive
- Phase 1 drops from ~6 min to bounded seconds when the cloud is unreachable (breaker + caps), and is genuinely parallel when it is reachable (async claude).
- Brings Phase 1 to parity with the already-hardened Phase 2–6 dispatch — one consistent dispatch discipline across the pipeline.

### Negative / Risks
- Tighter timeouts could cut off a slow-but-healthy backend. Mitigation: env-tunable caps (D5); the 30s/agent default matches the Phase 2–6 value already in production.
- Async claude changes ordering of interleaved log lines (cosmetic).

### Neutral
- No change to *which* agents run or to their payloads — only to how the fleet is bounded and how the claude subprocess is spawned.

## Alternatives Considered

1. **Just lower the per-service adapter timeouts in `endpoints.ts`.** Rejected: those timeouts are correct for legitimately long operations (5-min simulations); the bug is the *fleet* lacking an envelope, not the per-service values.
2. **Keep `execFileSync` but move copilot agents off the fleet path.** Rejected: the blocking call is the defect; hiding it elsewhere just relocates the freeze.
3. **Worker threads for the sync claude calls.** Rejected as over-engineered when an async spawn already exists (`createClaudeCodeRunner`).

## Implementation (not yet built — Proposed)

- `src/commands/agents.ts:4607` — wrap fleet invocations with per-agent timeout + breaker (D1–D2); add fleet preflight (D4).
- `src/commands/agents.ts` `runCopilotViaClaudeMax` / `runInferenceRoutingViaClaudeMax` (~:68, :163) — async claude (D3).
- Reuse `CloudCircuitBreaker`, `AGENT_INVOKE_TIMEOUT_MS`, `DISPATCH_ALL_TIMEOUT_MS` from `src/pipeline/swarm-orchestrator.ts` (D1–D2).
- `src/pipeline/phase2-preflight.ts` — generalise to the Phase 1 fleet (D4).
- `manifest.json` writer — record effective timeout/breaker config (D5).
