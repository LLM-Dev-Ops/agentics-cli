# ADR-PIPELINE-089: Phase 1 Health Gate + Broadened Transient-Failure Retry — End the "Ran But Produced Nothing" Cliff

**Status:** Proposed
**Date:** 2026-04-22
**Priority:** HIGH — after ADR-PIPELINE-087 + 088 restored the pipeline's *ability* to reach auto-chain, users now hit a second failure mode: Phase 1 nominally "succeeds" but with enough silent local fallbacks, discarded LLM output, and cold-backend timeouts that Phase 2 produces zero artifacts. The user-visible symptom is identical to the pre-087 silent-drop regression: "I ran `agentics ask` and nothing happened." Users will continue to report this as "phase 1 simulation failed" even when Phase 1 technically returned.
**Originating Review:** Field report 2026-04-22 — user with a working prompt on 2.5.4 saw "phase 1 simulation failed, pipeline won't run." Reproduction on `main` (commit 27a8754) with prompt `analyze our AI spend and suggest optimizations` and an active API key showed Phase 1 returning `[RUVECTOR] Simulation succeeded` and writing all six Phase 1 artifacts, while Phase 2 emitted `0 files (swarm: 0, agents: 0)` after five Cloud Run domains timed out (`research-lab-agents` 120s, `memory-graph-agents` 60s, `auto-optimizer-agents` 60s, `costops-agents` 120s) and the ADR-073 tag-survival check discarded the LLM-synthesized `executive-summary`.
**Builds on:** ADR-PIPELINE-087 (resolver coverage), ADR-PIPELINE-088 (MCP fast-return).
**Supersedes:** None. Amends the retry classifier introduced in `src/commands/agents.ts:4154-4161`.

## Context

Three independent failure modes conspire to produce the same user-visible outcome — an `agentics ask` invocation that completes but yields no usable artifacts. Each failure mode exists because the pipeline treats its own partial-success states as success:

### 1. The retry classifier is too narrow

`src/commands/agents.ts:4154-4161` wraps every simulator/enterprise invocation in a three-attempt retry loop with 10s/20s/40s exponential backoff. The "retryable" set is an allowlist of lowercase substrings of `Error.message`:

```ts
const isRetryable = msg.includes('unavailable')
  || msg.includes('timeout')
  || msg.includes('rate exceeded')
  || msg.includes('econnreset')
  || msg.includes('econnrefused')
  || msg.includes('network error')
  || msg.includes('aborterror');
```

Several transient-failure shapes that actually occur in production are *not* on this list and so bail on attempt 1 as "non-retryable":

- `unreachable` — emitted by multiple adapter paths (`src/pipeline/phase5/phases/service-registrar.ts:270`, `src/cli/index.ts:2438`, human-readable cloud-run failures)
- `503 Service Unavailable` — Cloud Run cold-start surface; the numeric code survives but the word "unavailable" appears only when the upstream proxies normalize the response; raw 503 messages do not.
- `504 Gateway Timeout` — same, word "timeout" does not appear when the upstream surfaces just `HTTP 504` with a tiny body.
- `ETIMEDOUT` (uppercase) and `read ETIMEDOUT` — `msg.includes('timeout')` is *lowercase* and works for most variants but brittle.

When the classifier mis-labels a transient failure as terminal, `ask` prints `[RUVECTOR] Non-retryable error: …` and flips to the "RUVECTOR SIMULATION FAILED — Phases 2-6 skipped" banner at `src/cli/index.ts:2270`. This is the literal path the user's "phase 1 simulation failed" report matches.

### 2. Phase 1 reports success even when half the fleet fell back to local stubs

Observed during reproduction on `main`:

```
[local] copilot/planner missing API key
[pipeline-017] WARNING: Consensus agent returned 0% agreement (below 60% threshold)
[pipeline-072] Pre-render skipped: unknown-sector (classifySector returned "unknown")
[exec-docs] ADR-073 tag survival check FAILED for executive-summary
             (skeleton=8 tags, synthesized=5) — discarding LLM output, using skeleton
```

Every one of these is a degradation. Together they mean the Phase 1 artifacts on disk are mostly skeletons, not synthesized content. But the `ask` command at `src/cli/index.ts:2254-2281` gates solely on `simSucceeded` — was the `simulator/enterprise` invocation without an `error` field. All of the degradations above can be present and `simSucceeded` still returns `true`. Auto-chain then dutifully runs against empty skeletons.

The ADR-073 tag-survival check is itself over-strict. Requiring `synthesized.tags.length >= skeleton.tags.length` penalizes LLMs for legitimate tag deduplication during synthesis. In the observed case the synthesized `executive-summary` (8→5 tags) was discarded while `decision-memo` (10 fcv tags preserved, 9659 chars) and `financial-analysis` (8 fcv tags preserved, 10687 chars) sailed through. A tag-set containment check (every *required* tag is present) would have kept all three.

### 3. Phase 2 dispatches to backends that are already failing

Phase 2's `auto-chain.ts` dispatches seven platform agents in parallel: `copilot/{planner,decomposer}`, `research-lab/{hypothesis,metrics}`, `memory-graph/knowledge-graph`, `auto-optimizer/self-optimize`, `costops/tradeoff`. On reproduction, five of those Cloud Run services timed out (120s, 60s, 60s, 120s, 120s = ~7 minutes of wall clock waiting for failures we could have detected up front) before falling back to local compute that emitted zero artifacts. The net Phase 2 output: `0 files (swarm: 0, agents: 0), 1 tasks, 3116ms` after ~10 minutes of wall time.

No preflight check exists. No circuit-breaker exists. Each individual agent fails its own way while the pipeline remains "in progress."

### The user's symptom

All three failure modes surface identically from the user's seat: `agentics ask` returns, `.agentics/plans/` is empty or skeleton-only, and the MCP response says "Phases 2-6 running in background" with a trace id that will eventually report "completed" despite producing nothing. Whether the user says "phase 1 failed" (matching failure mode 1) or "pipeline won't run" (matching failure modes 2-3), the root cause is the same: the pipeline does not distinguish its healthy, degraded, and failed states, and it does not surface that distinction to the caller.

## Decision

Introduce a **Phase 1 Health Gate** that classifies Phase 1's completion state into `healthy | degraded | failed`, widen the retry classifier so transient failures actually retry, relax the ADR-073 tag check from count-based to set-based, and add a Phase 2 preflight that short-circuits when dependencies are already unhealthy. Surface the verdict to the user and to `agentics-status`.

### 1. Centralize and broaden the transient-failure classifier

Replace the inline substring list at `src/commands/agents.ts:4154-4161` with a single helper `isTransientFailure(error: unknown): boolean` in `src/errors/transient.ts`. The helper inspects:

- `error.message` (lowercased) for an expanded keyword set:
  `unavailable`, `unreachable`, `timeout`, `timed out`, `etimedout`, `rate exceeded`, `rate limit`, `econnreset`, `econnrefused`, `enotfound`, `eai_again`, `network error`, `aborterror`, `socket hang up`, `service_unavailable`
- `error.code` for Node/fetch error codes: `ECONNRESET`, `ECONNREFUSED`, `ETIMEDOUT`, `ENOTFOUND`, `EAI_AGAIN`, `UND_ERR_SOCKET`
- HTTP status (when wrapped with `status` or `response.status`): `408`, `425`, `429`, `500`, `502`, `503`, `504`, `522`, `524`
- `cause` chain — walk up to three levels for the same properties

Every retry site in the codebase (`src/commands/agents.ts` at 4154, 4505, and any future sites) imports the helper. Adding a new transient-failure signal becomes a one-file change.

**Not retryable** (explicit terminal list): `contract_violation` (400 with `error: 'contract_violation'` in body), `unauthorized` (401), `forbidden` (403), `not_found` (404) when path was canonical, `payload_too_large` (413). These indicate the payload or credentials are wrong and will not self-heal on retry.

### 2. Phase 1 Health Gate in `executeNaturalLanguageRoute`

At the end of `src/commands/agents.ts:executeNaturalLanguageRoute` (before returning the `multi` result), compute a verdict:

```ts
type Phase1Verdict = 'healthy' | 'degraded' | 'failed';
```

**`failed`** — auto-chain will be skipped, error surfaced to user:
- `simulator/enterprise` errored *and* the error was non-retryable (confirmed via `isTransientFailure`), OR
- > 50% of graph-selected non-simulator agents errored, OR
- No Phase 1 artifact files were produced (hard invariant).

**`degraded`** — auto-chain proceeds but records a warning set:
- Any `[local] … using local compute` fallback triggered
- Any LLM synthesis discarded by a tag-survival check (mode 2 above)
- Consensus agreement <60% (existing `[pipeline-017]` warning)
- `classifySector` returned `unknown` (existing `[pipeline-072]` warning)
- Any graph-selected agent errored non-fatally

**`healthy`** — all agents returned 2xx, no local fallbacks, all synthesis retained, consensus ≥60%.

The verdict, plus a `degradations: Array<{code, message}>` list, is:
- printed as a one-line Phase 1 banner before the auto-chain section (`src/cli/index.ts:2281`)
- written into `~/.agentics/runs/<traceId>/manifest.json` as a `phase1_verdict` field
- returned in the `routeResult.result` object so callers downstream can key off it

### 3. Gate auto-chain on the verdict, not just `simSucceeded`

Amend the auto-chain gate at `src/cli/index.ts:2261-2281`:

```ts
if (verdict === 'failed') {
  // existing "RUVECTOR SIMULATION FAILED" banner, but now carries the
  // actual failure list from Phase 1 verdict.degradations
  // skip auto-chain
} else if (verdict === 'degraded') {
  // print "Phase 1 DEGRADED — proceeding with: <list>" banner
  // proceed to auto-chain (user may still want partial output)
} else {
  // proceed silently
}
```

The banner text must surface the specific degradation list — not a generic "partial failure." Users fix what they can see.

### 4. Relax the ADR-073 tag-survival check

Change `src/renderers/executive-docs/tag-survival.ts` (the `exec-docs` module logging `ADR-073 tag survival check`) from:

```ts
if (synthesized.tags.length < skeleton.tags.length) reject(synthesized);
```

to:

```ts
const required = skeleton.tags.filter(isMandatory);
const missing = required.filter(t => !synthesized.tags.includes(t));
if (missing.length > 0) reject(synthesized, { missing });
```

A "mandatory" tag is one the downstream renderer will dereference (Phase 4/5 code generation explicitly reads). Non-mandatory tags are deduplicable without harm. The reject path logs `missing` so the field can diagnose which specific tags the LLM dropped, instead of the opaque `skeleton=8 tags, synthesized=5`.

### 5. Phase 2 preflight

Before dispatching the seven platform agents in `src/pipeline/auto-chain.ts:executeAutoChain`, issue a lightweight parallel `HEAD`/`/v1/health` probe to each agent's Cloud Run base URL with a 3-second timeout. Use the results to:

- Mark agents with failed probes as `skipped-unhealthy` in the Phase 2 dispatch plan. Do not attempt the full call (saves 60-120s per agent).
- If ≥ 4 of 7 agents fail probes, set Phase 2 verdict to `skipped-deps-unhealthy` and skip to Phase 3 with a status.json entry so `agentics status` can surface it.
- Cache probe results for 60 seconds keyed by trace id to avoid probe amplification when multiple phases call the same agent.

The probe is additive; it does not replace the existing per-call timeout. It only prevents us from burning 60-120s of wall time on a known-dead backend.

### 6. Enrich `status.json` and `agentics-status` tool output

Extend the `status.json` schema written by ADR-PIPELINE-088's `_autochain` helper:

```json
{
  "traceId": "...",
  "phase": 2,
  "phase1_verdict": "degraded",
  "phase1_degradations": [
    { "code": "local-fallback", "message": "copilot/planner missing API key" },
    { "code": "consensus-low", "message": "0% agreement (threshold: 60%)" }
  ],
  "phase2_preflight": {
    "probed": 7,
    "healthy": 2,
    "unhealthy": ["research-lab-agents", "memory-graph-agents", "auto-optimizer-agents", "costops-agents", "shield-agents"],
    "skipped": ["research-lab/hypothesis", "research-lab/metrics", "memory-graph/knowledge-graph", "auto-optimizer/self-optimize", "costops/tradeoff"]
  },
  "inProgress": true
}
```

The `agentics-status` MCP tool surfaces these fields verbatim so Claude Code can show the user "Phase 1 DEGRADED — 5 backends unhealthy, 2 agents local-fell-back" instead of "Phase 2 running."

## Consequences

**Positive:**
- Users who hit a transient ruvector failure now actually get the three retries they thought they were getting. Reduces the "phase 1 failed" report rate for network-flakey environments.
- Users who hit a degraded Phase 1 see a verdict line naming exactly what degraded. No more "it ran but there's nothing in `.agentics/plans/`" mystery.
- Phase 2 doesn't burn 7-10 minutes waiting on already-dead Cloud Run backends; preflight catches them in <3s.
- The tag-survival check stops discarding valid LLM output, recovering ~30-40% of executive-summary synthesis success rate (based on observed-vs-total in the reproduction).

**Negative / risks:**
- False-positive preflight — a Cloud Run cold-start can serve `/v1/health` in 4s when the actual call would succeed in 8s. Mitigation: probe timeout of 3s is aggressive; we can tune up to 5s. Skipped agents are marked `skipped-unhealthy` in status.json, not silently dropped, so the user can retry.
- Broadened retry classifier could retry a truly terminal failure three times (30s+ extra wall clock) before giving up. Mitigation: the explicit terminal list (contract_violation, unauthorized, forbidden) short-circuits the retry loop.
- Degraded verdicts that still proceed to auto-chain could produce lower-quality artifacts than a clean abort. Mitigation: the verdict is surfaced prominently; users can re-run or abort.

**Neutral:**
- `manifest.json` gains a `phase1_verdict` field. Backwards compatible — downstream readers that don't know about it ignore it.
- `status.json` schema grows three fields. Consumer is a single MCP tool we ship alongside this ADR.

## Validation

Before merge:

1. **Retry classifier coverage.** New unit tests in `tests/unit/errors/transient.test.ts` assert `isTransientFailure` returns `true` for each of: `new Error('service unreachable')`, `{ code: 'ECONNRESET' }`, `{ response: { status: 503 } }`, `{ message: 'HTTP 504 Gateway Timeout' }`, `{ message: 'socket hang up' }`. And `false` for: `{ message: 'contract_violation: intent_description required' }`, `{ response: { status: 401 } }`, `{ response: { status: 400 } }`.

2. **Phase 1 verdict classification.** Integration test with a mock ruvector-service that returns success and a mock memory-graph that returns 500; assert `phase1_verdict === 'degraded'` and `degradations` includes the memory-graph entry. Second test with mock ruvector 500 non-transient (contract_violation); assert `phase1_verdict === 'failed'` and auto-chain is skipped.

3. **Tag-survival relaxation.** Construct a synthesized doc with 5 tags that is a strict subset of the 8-tag mandatory set; assert the survival check rejects with a specific `missing` list. Construct a synthesized doc that deduplicates 8 tags to 5 but retains all mandatory tags; assert the check passes.

4. **Phase 2 preflight.** Mock four of seven backends to fail `HEAD /v1/health`; assert `phase2_preflight.skipped` contains exactly the four agents keyed to those backends and that no HTTP request to `/v1/invoke` on those backends is issued.

5. **User-visible banner.** End-to-end with a real ruvector but mocked downstream health; assert stdout contains `Phase 1 verdict: DEGRADED` and the degradation list before the auto-chain section.

6. **No regression on 087 + 088.** `scripts/check-graph-resolver-coverage.ts` still exits zero. Field-report probe still 12/12. MCP fast-return banner still emitted. Shell-mode inline auto-chain still prints `formatAutoChainForDisplay`.

## Rollout

Single minor release (2.6.0 — the verdict field in `manifest.json` and the new `phase1_verdict`/`phase2_preflight` keys in `status.json` are additive schema changes, so a patch release is defensible, but the retry classifier change is behavioural enough that a minor bump signals attention).

All changes are additive or strictly-more-lenient (retry classifier, tag-survival). No in-flight pipelines will break. Existing `.agentics/runs/<traceId>/` directories without the new fields remain readable by `agentics status` — missing fields default to `healthy` with an empty degradations list.

Rollback plan: revert the commit. No on-disk data is lost; consumers tolerant of missing fields (by design) continue to work.

## References

- `src/commands/agents.ts:4139-4170` — current narrow retry classifier (Phase 1 graph-routed path)
- `src/commands/agents.ts:4489-4511` — same classifier duplicated in the full-fleet path; both sites consume the new helper
- `src/cli/index.ts:2254-2281` — current `simSucceeded` gate; replaced by verdict gate
- `src/cli/index.ts:2270` — `RUVECTOR SIMULATION FAILED` banner; repurposed to carry verdict.degradations
- `src/pipeline/auto-chain.ts:executeAutoChain` — Phase 2 dispatch site where preflight is inserted
- `src/renderers/executive-docs/tag-survival.ts` (target location; currently inline in the renderer — factor out as part of this ADR) — ADR-073 tag-survival check
- `docs/adrs/ADR-PIPELINE-087-aqe-agent-name-resolver-and-pipeline-regression.md` — preceding landing that made Phase 1 succeed often enough to expose these latent UX issues
- `docs/adrs/ADR-PIPELINE-088-mcp-fast-return-auto-chain.md` — defines the status.json schema this ADR extends
- Field reproduction 2026-04-22: prompt `analyze our AI spend and suggest optimizations` on commit 27a8754 produced `[RUVECTOR] Simulation succeeded` but `Phase 2: 0 files (swarm: 0, agents: 0)` after 5/7 Cloud Run timeouts and one `ADR-073 tag survival FAILED`
