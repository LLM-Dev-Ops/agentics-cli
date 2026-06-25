# ADR-PIPELINE-112: Model Backend Policy — Claude Code / Codex Only, No Anthropic API-Key Fallback

**Status:** Proposed
**Date:** 2026-06-25
**Authors:** Nick Ruest
**Priority:** CRITICAL — The pipeline contains a direct Anthropic API transport (`tryGenerateADRsViaAPI`, `src/pipeline/phase2/phases/adr-generator.ts:990`) that requires `ANTHROPIC_API_KEY` to be set in the environment. In the reference run this key was absent, the transport silently failed, and generation cascaded to embedded templates. Beyond the reference run, keeping a raw-API-key path creates key sprawl, bypasses the user's Claude Code / Codex subscription, and introduces model-version drift independent of what the user has configured in their coding-agent session. This ADR removes the raw-API path entirely and formalises the backend resolution order.
**Builds on:** ADR-PIPELINE-100 (markdown-direct ADRs and the Claude Code Max-only principle for Phase 4 generation), ADR-PIPELINE-091 (Ruflo as primary engineering executor — this ADR defines what Ruflo's local backend must be), ADR-PIPELINE-116 (loud failure when no real engine is available — this ADR defines which engines are legitimate before 116 can decide what a failure looks like).

---

## Context

### Three generation engines, one missing policy document

The reference run's `.agentics/plans/manifest.json` records:

```
execution.engineering_tier: "template"
tier_counts: { "ruflo-local": 0, "template": 3 }
planPromotion: { sparc: 0, adrs: 0, ddd: 0, tdd: 0, prompts: 2, implementation: 0 }
```

The pipeline completed in ~47.5 seconds — far too fast for real LLM synthesis — and emitted canned templates across every engineering phase. Three distinct generation engines exist in the codebase; all three were unavailable:

| Engine | Entry point | Why it failed in the reference run |
|--------|------------|-------------------------------------|
| ruflo | `src/pipeline/auto-chain.ts:2760` — `execSync('ruflo --version')` | `runtime.ruflo.available: false, reason: "binary-not-found"` — naive PATH check failed despite `ruflo` v3.14.1 being installed (see ADR-113) |
| `claude --print` | `src/pipeline/phase2/phases/adr-generator.ts:367` — `runStreamedClaudePrint` | Prompt passed via argv (≈100 KB) — likely ARG_MAX truncation or delimiter drop (see ADR-114) |
| Anthropic API | `src/pipeline/phase2/phases/adr-generator.ts:990` — `tryGenerateADRsViaAPI` | `ANTHROPIC_API_KEY` unset; function returned immediately with no parseable ADRs (`ADR-FAIL-001`) |

The third engine is the focus of this ADR. Its failure was silent and inevitable: the environment had no API key, it had never had one, and the pipeline never said so.

### Why the raw API key path exists and why it must be removed

`tryGenerateADRsViaAPI` was added as a fallback when the `claude --print` subprocess approach was not yet reliable. It calls `https://api.anthropic.com/v1/messages` directly with `ANTHROPIC_API_KEY`. In a fresh "npm + Claude Code only" install the key is absent; the function logs a debug-level warning and returns an empty array. The pipeline then silently falls through to templates.

Four structural problems with keeping this path:

1. **Key sprawl.** A raw `ANTHROPIC_API_KEY` is a long-lived credential separate from the user's Claude Code session token. Managing, rotating, and auditing it is additional operational overhead the user should not bear.

2. **Cost outside the subscription.** Calls made directly to the Anthropic API bill against the raw API account, not the user's Claude Code / Claude Max subscription. The user has a subscription precisely to avoid per-token billing.

3. **Model version drift.** `tryGenerateADRsViaAPI` hardcodes or reads a model string (e.g. `claude-3-5-sonnet-20241022`) that is independent of what Claude Code is currently configured to use. This has already caused one model-migration incident (commit `2ffb26b`, `fix(llm): migrate dead model id claude-sonnet-4-20250514`). A dead model ID in the raw-API path produces an HTTP 400 that is equally silent.

4. **Dead branch in the reference environment.** Empirically: no `ANTHROPIC_API_KEY`, no output. The branch is a failure path masquerading as a fallback.

### The Agentics auth gate compounds the problem

A fresh install of `@llm-dev-ops/agentics-cli` is blocked before the pipeline by an Agentics-platform auth gate (`agentics login` / `AGENTICS_API_KEY`). A user who has not authenticated to the Agentics platform cannot reach any generation engine. The raw API path gives the illusion that bypassing this gate with a direct key is a supported path. It is not — it bypasses the gate only to hit the empty-key failure immediately after.

---

## Decision

### D1. Remove `tryGenerateADRsViaAPI` and every `ANTHROPIC_API_KEY`-driven path from the synthesis chain

`src/pipeline/phase2/phases/adr-generator.ts:990` (`tryGenerateADRsViaAPI`) is deleted. All callers that test for `ANTHROPIC_API_KEY` before deciding which engine to invoke are updated to remove the API-key branch. No new synthesis path may read `ANTHROPIC_API_KEY` from the environment for the purpose of generating pipeline artifacts.

The deletion is unconditional. There is no `AGENTICS_ALLOW_RAW_API_KEY` escape hatch — adding one re-introduces the cost, drift, and sprawl problems immediately.

### D2. Formalise the backend resolution order for ALL synthesis phases

Every phase that invokes an LLM to generate engineering artifacts (SPARC, ADRs, DDD, TDD, implementation prompts, Phase 7 deliverables) MUST resolve its backend through the following ordered chain. The first available backend wins; the chain is evaluated once per pipeline run and the result is cached in the run manifest.

| Priority | Backend | Availability test | Notes |
|----------|---------|------------------|-------|
| 1 | **ruflo** (local swarm bound to Claude Code / Codex) | Robust resolution per ADR-113; runs `ruflo --version` via the resolved binary path after PATH fixup | Primary per ADR-091; runs `--local-only` so it never opens a raw provider connection |
| 2 | **`claude --print`** (hardened per ADR-114) | Resolved binary path from the shared resolver; hardened transport (stdin, JSON envelope) | Same session as the user's Claude Code subscription |
| 3 | **Codex CLI** (`codex`) | `which codex` via the same resolver module | Permits OpenAI Codex subscription users as an alternative |
| 4 | **Loud failure** | — | Emits a per-phase failure artifact and non-zero verdict (ADR-116); does NOT fall back to embedded templates |

Ruflo's local backend is bound to Claude Code / Codex by running with `--local-only` (or equivalent flag), preventing it from opening any independent API connection. If ruflo is available but its local backend is unavailable (e.g. `claude` binary absent), ruflo itself reports an error and the chain advances to Priority 2.

### D3. One shared backend-resolver module, used by every phase

A new module `src/pipeline/backend-resolver.ts` implements D2. It is the single place where backend detection logic lives. All phases (`phase3-sparc-coordinator.ts`, `phase4-adrs-coordinator.ts`, `prompt-generator.ts`, `phase7/coordinator.ts`, etc.) import from this module rather than each implementing their own availability check. This prevents the divergent-resolver problem that ADR-114 also addresses for `claude` specifically.

The resolver exports:

```typescript
export interface BackendResolution {
  tier: 'ruflo' | 'claude-print' | 'codex' | 'none';
  binaryPath: string | null;
  reason: string;                 // logged in manifest; surfaced in loud-failure artifact
}

export async function resolveBackend(): Promise<BackendResolution>;
```

`resolveBackend()` is called once during pipeline initialisation and its result stored as `runtime.backend` in the run manifest. All subsequent phase coordinators read from this cached result — they do not re-detect.

### D4. Document the Agentics auth gate as a prerequisite

`ANTHROPIC_API_KEY` must not appear in any onboarding documentation as an alternative to `agentics login`. The `why-execution-is-gated.md` document is updated to state explicitly that:

- The Agentics platform auth gate (`AGENTICS_API_KEY` / `agentics login`) is a prerequisite to running the pipeline.
- The only LLM backends used inside the pipeline are the user's Claude Code / Codex subscription (via ruflo `--local-only`, or the `claude --print` / `codex` CLIs).
- Raw Anthropic API keys are not used and are not a supported configuration.

---

## Alternatives Considered

### Alternative 1: Keep `tryGenerateADRsViaAPI` but require `ANTHROPIC_API_KEY` to be set loudly

Gate the function on an explicit `AGENTICS_RAW_API_ENABLED=true` env flag and error loudly if the key is absent when the flag is set.

**Rejected because:**
- Preserves all four structural problems (key sprawl, out-of-subscription cost, model drift, dead branch in the reference environment).
- Adds an env flag that users will set out of confusion when generation fails, then incur unexpected API charges.
- The hardened `claude --print` transport (ADR-114) already provides a more reliable secondary engine that uses the subscription.

### Alternative 2: Auto-populate `ANTHROPIC_API_KEY` from the Claude Code session token

Extract the session credential from the Claude Code auth store and use it for direct API calls.

**Rejected because:**
- Claude Code's session token is not a valid `ANTHROPIC_API_KEY`; they are different credential types with different scopes and lifetimes. The extraction would fail or produce an invalid key.
- Even if it worked, it would bypass subscription rate-limit controls that the Claude Code session enforces.
- It is an undocumented use of an internal credential store — a security boundary violation.

### Alternative 3: Add a fourth tier using the Anthropic SDK with key optional

Keep `tryGenerateADRsViaAPI` but silently skip it when the key is absent (the current behaviour), treating it as a no-op tier.

**Rejected because:**
- This is exactly the current behaviour and exactly the cause of the silent template cascade. A no-op tier that fails silently provides no value and obscures real failures.
- The `ADR-FAIL-001` failure mode in the reference run was partly attributable to this tier being evaluated, finding no key, returning an empty array, and allowing the chain to continue to templates without any user-visible signal.

### Alternative 4: Expose a `--model-api-key` CLI flag for explicit opt-in

Allow users who genuinely want direct API access to pass a key at runtime.

**Rejected because:**
- Introduces a CLI surface for a configuration that should not exist.
- Users with Claude Code / Codex subscriptions should not need to manage a separate key.
- Users without subscriptions who need raw API access are not the target audience; the Agentics platform auth gate already establishes the required account model.

---

## Consequences

### Benefits

1. **Eliminates the silent empty-array failure.** The reference run's `ADR-FAIL-001` cascade is prevented at source: there is no API-key path to fail silently.
2. **Cost stays inside the subscription.** All LLM synthesis runs through the user's Claude Code / Codex session.
3. **Model version is determined by the user's session.** No hardcoded model string that can become stale and produce HTTP 400 errors.
4. **Single resolver module ends per-phase availability drift.** Every phase uses the same `resolveBackend()` result; a fix to the resolver propagates everywhere.
5. **Credential surface reduced.** No raw API key in the process environment means no key to leak in logs, crash dumps, or environment exports.

### Risks and Mitigations

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| Some users deliberately set `ANTHROPIC_API_KEY` and rely on the raw path | Low | Medium | `docs/why-execution-is-gated.md` update (D4) explains the supported model; the migration is a clean break with a clear rationale |
| `resolveBackend()` adds startup latency | Low | Low | Resolution is a one-time `execFile --version` call per binary candidate; cached for the run lifetime; expected latency under 200ms |
| Codex CLI tier not installed in most environments (tier 3 rarely reaches) | High | Low | Codex is an optional enhancement; tiers 1 and 2 cover the primary use case |
| Ruflo `--local-only` flag name differs across ruflo versions | Low | Medium | The resolver module checks the ruflo version and selects the correct flag; falls through to tier 2 if ruflo refuses `--local-only` |
| Removing the raw-API path breaks a CI environment that used it | Low | Medium | CI environments without a Claude Code session should set `AGENTICS_DISABLE_PIPELINE=1` or use the loud-failure path (ADR-116) rather than attempting LLM synthesis |

### Implementation Targets

| Target | Measure |
|--------|---------|
| Lines removed from `adr-generator.ts` | ≥ 120 (`tryGenerateADRsViaAPI` + callers + `ANTHROPIC_API_KEY` env reads) |
| Phases sharing `resolveBackend()` | All: phase3, phase4, phase5a, phase7 |
| `ANTHROPIC_API_KEY` occurrences remaining in `src/` | 0 (enforced by a new lint rule `no-raw-anthropic-key`) |
| Backend resolution latency (p95) | < 200ms |
| `runtime.backend` presence in manifest | Required field; missing manifest entry fails validation |

---

## Related Decisions

- **ADR-PIPELINE-100** — Established the Claude Code Max-only principle for Phase 4 ADR generation. This ADR extends that principle to every generation phase and removes the escape hatch that contradicted it.
- **ADR-PIPELINE-091** — Ruflo as primary engineering executor. This ADR defines what ruflo's local backend must be (Claude Code / Codex, `--local-only`), tightening ADR-091's implicit assumption.
- **ADR-006** — Claude Code synthesis runner. The hardened runner (`src/runtime/claude-code-runner.ts`) is the preferred `claude --print` transport (tier 2); this ADR designates it as such.
- **ADR-PIPELINE-113** — Robust ruflo resolution. The tier-1 backend resolution depends on the PATH-independent resolver defined there.
- **ADR-PIPELINE-114** — Hardened `claude --print` transport. The tier-2 backend depends on the stdin/JSON-envelope transport defined there.
- **ADR-PIPELINE-116** — Loud failure across all phases. This ADR defines what happens when `resolveBackend()` returns `tier: 'none'`.

---

## Revision History

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 0.1 | 2026-06-25 | Nick Ruest | Initial proposal — remove raw API key path, formalise backend resolution order, introduce shared resolver module |
