# ADR-PIPELINE-109: Restore Repo-Backed Agent Execution

**Status:** Proposed
**Date:** 2026-06-02
**Priority:** HIGH — The user requirement is explicit: *"make sure the deployed agents will use the code from their respective repos in the process."* Today they do not. Every agent either hits a Cloud Run endpoint or returns a hand-written synthetic stub; the mechanism that runs each agent's *actual repo source* exists but is disconnected and its cache is empty.
**Builds on:** ADR-066 (run agent reasoning via `claude --print` / Claude Max — the repo runner uses exactly this as the AI backbone), ADR-PIPELINE-108 (bounded, non-blocking fleet — repo execution removes most cloud-timeout exposure that ADR-108 bounds; the two are complementary).
**Reverses (conditionally):** commit `00fa108` ("remove repo-local fallback chain — go directly to Cloud Run"), which removed the repo-execution wiring because the cache was empty. This ADR re-introduces it *with* the cache-population fix that was missing.

---

## Context

`src/agents/repo-agent-runner.ts` is purpose-built for this requirement. It:
- downloads each agent domain's Cloud Function source from the org GCS bucket into `~/.agentics/repo-cache/<repo>/`,
- replaces the function's `callClaude()` with a local shim backed by `claude --print` (Claude Max — no Anthropic key needed),
- and invokes the **repo's real handler** — so the repo's actual system prompts, validation, and domain logic run.

It exports `executeRepoAgent()`, `isRepoAgentMode()`, `hasRepoAgent()`, and `warmRepoCache()`. **None of these are called anywhere in `src/`.** Only the constant `REPO_CACHE_ROOT` is imported (by `platform-repo-resolver.ts`, `phase5.ts`, `phase6.ts`). Verified by grep across the tree.

### How it got disconnected

Git history is unambiguous:
- `f804c51` — *"execute 25/26 Cloud Function agents locally via child process isolation"* — wired `executeRepoAgent` into the dispatch path.
- `00fa108` — *"remove repo-local fallback chain — go directly to Cloud Run"* — removed it. Commit message: *"Removed the repo-local execution path that tried to run agents from **empty cached source**, failed, printed [FALLBACK] messages, then fell through to Cloud Run anyway."*

So the path was removed because the **repo cache was empty** — `warmRepoCache()` was never being run, so `executeRepoAgent` had no source to execute and failed every time. The dispatch path now (`src/commands/agents.ts:500`) carries the comment *"Go directly to Cloud Run services — no repo-local fallback chain."*

### Live confirmation (2026-06-02, run `bd63314c`)

- `~/.agentics/repo-cache/` exists but contains **0 repos**.
- All Phase 1 agents resolved to Cloud Run (which 404s on agent paths) or synthetic `_fallback` stubs. Phase 2 preflight: "9/14 backends healthy … skipping 10 agents bound to unhealthy backends." No agent ran from repo code.

The capability is therefore not "missing" — it is **built, then disabled because its prerequisite (a populated cache) was never wired.** This ADR fixes the prerequisite and re-enables the path, with the failure-mode that justified `00fa108` properly handled.

## Decision

Six rules. D1–D2 fix the prerequisite; D3–D4 re-wire execution with correct precedence; D5–D6 cover observability and the kill-switch.

### D1. Cache warming runs (and must succeed) before repo execution is claimed

`warmRepoCache()` is invoked as a one-time, idempotent step before the first fleet dispatch (and on demand via a CLI command, e.g. `agentics agents warm-cache`). It downloads each domain's source per `FUNCTION_NAMES` / `BUNDLE_NAMES`. The result (`{warmed, failed, skipped}`) is recorded. A domain is **repo-eligible only if its source is actually present and validated** — never assumed.

### D2. `isSourceCached` is the gate, checked per domain

Before routing an agent to repo execution, verify its cached source exists and has a resolvable handler export (the check `c2c3f9b` added). The empty-cache → silent-failure → fallthrough loop that caused `00fa108` cannot recur: no source ⇒ the domain is not repo-eligible and the dispatcher chooses the next tier deterministically (D3), without burning a failed `executeRepoAgent` attempt.

### D3. Three-tier dispatch with explicit, logged precedence

`executeAgentsInvokeCommand` resolves each agent in this order, recording which tier served it:

| Tier | Condition | Source of truth |
|---|---|---|
| **1. Repo** | `isRepoAgentMode()` AND `hasRepoAgent(domain)` AND `isSourceCached(domain)` | the repo's real handler via `claude --print` |
| **2. Cloud Run** | repo not eligible AND backend healthy | deployed Cloud Function |
| **3. Synthetic fallback** | neither available | the existing `_fallback` local compute |

This restores the `f804c51` behaviour with the cache guarantee of D1–D2. Tier 1 is the default when `claude` is available (`isRepoAgentMode()` auto-detects it) and the source is cached — i.e. the user requirement ("agents use repo code") becomes the normal path, not an opt-in.

### D4. Repo tier is preferred over Cloud Run by default

When a domain is repo-eligible, repo execution is chosen **even if Cloud Run is reachable**, because the requirement is that agents run *their repo code*. `AGENTICS_AGENT_TIER={repo,cloud,auto}` (default `auto` = the D3 ladder) lets an operator force cloud (e.g. to test deployed services) or force repo.

### D5. Provenance: every agent result records its execution tier

Each agent result and `agent-responses.json` entry carries `execution_tier: 'repo' | 'cloud' | 'synthetic'` and, for repo, the resolved source commit/path. The fleet summary reports the split (e.g. "98 repo, 7 cloud, 4 synthetic"), so "are agents using repo code?" is answerable from one line instead of code archaeology. This also feeds the Phase 1/Phase 2 preflight (ADR-108 D4): repo-eligible agents skip the cloud health probe.

### D6. Kill-switch and offline behaviour

- `AGENTICS_LOCAL_AGENTS={1,true|0,false}` continues to force/disable repo mode (already read by `isRepoAgentMode()`); default auto-detect on `claude` presence.
- If GCS is unreachable at warm time, `warmRepoCache` reports `failed` per domain and those domains fall to Tier 2/3 — degraded, but visible (D5), never a silent stub presented as repo output.

## Consequences

### Positive
- Satisfies the explicit requirement: agents run their respective repos' real code.
- Removes most Cloud-Run-timeout exposure (the ADR-108 choke) — repo execution is local, no 404/cold-start/identity-token cost.
- No Anthropic API key required anywhere (Claude Max shim, per ADR-066).
- The `00fa108` failure mode (empty cache) is structurally prevented by D1–D2, not just re-introduced.

### Negative / Risks
- First run pays a one-time cache-warm download from GCS (bounded, cached thereafter). Mitigation: `warm-cache` CLI + idempotent skip when present.
- Requires GCS read access to the source bucket; without it, domains degrade to cloud/synthetic (visible via D5).
- Running repo handlers locally must preserve the child-process isolation `f804c51` used (untrusted-ish code execution); keep that isolation.

### Neutral
- Cloud Run remains the Tier-2 path and a valid `AGENTICS_AGENT_TIER=cloud` target for testing deployed services.

## Alternatives Considered

1. **Leave it cloud-only; just fix Cloud Run.** Rejected: contradicts the explicit requirement and keeps the pipeline hostage to backend health and cold starts.
2. **Re-enable `executeRepoAgent` without fixing the cache.** Rejected: reproduces exactly the empty-cache failure that motivated `00fa108`.
3. **Bundle agent source into the npm package instead of GCS download.** Reasonable future option (offline-first, no GCS dependency) — noted as a follow-up; out of scope here to keep the change to re-wiring + cache warming.

## Implementation (not yet built — Proposed)

- `src/commands/agents.ts:450–566` — restore the Tier-1 repo branch ahead of the Cloud Run call (D3–D4); record `execution_tier` (D5).
- `src/agents/repo-agent-runner.ts` — call sites for `warmRepoCache` (D1) and `isSourceCached` gate (D2); add `agents warm-cache` CLI subcommand.
- `src/commands/agents.ts:4607` (fleet) — repo-eligible agents skip cloud preflight (D5 ↔ ADR-108 D4).
- `agent-responses.json` / fleet summary writers — tier split (D5).
- Honour `AGENTICS_AGENT_TIER` and `AGENTICS_LOCAL_AGENTS` (D4, D6).
