# ADR-PIPELINE-087: Restore `agentics ask` Pipeline — AQE Agent-Name Resolver Gaps and Silent-Drop Regression

**Status:** Proposed
**Date:** 2026-04-20
**Priority:** CRITICAL — `agentics ask` produces incomplete pipeline artifacts; Claude Code MCP clients report the call as failed
**Originating Review:** Field report — MCP call against a blank test repo with a sustainability/water-cooling prompt that has worked in the field for a month silently stopped producing usable output after 2.5.0 shipped
**Builds on:** ADR-030 (Ecosystem Capability Graph), ADR-PIPELINE-080 (Quality Engineering Domain Registration), ADR-PIPELINE-082 (AQE Agent Scope Boundary), ADR-PIPELINE-083 (Phase Capability Binding for QE)
**Supersedes:** None

## Context

ADR-PIPELINE-080..086 introduced the `quality_engineering` domain and wired 14 AQE agent display names into `docs/ecosystem.graph.json`, including as `mandatory_agents` on phase 8 (validation) and as optional/mandatory on phases 3, 5, 6, 7, 9, 10. The integration was meant to be a drop-in registered-domain addition. In practice, the 2.5.0 pipeline run regressed on every query that the classifier maps onto the affected phases — including queries that worked unchanged for a month before the integration landed.

A probe of the exact prompt in the field report against the post-2.5.0 graph produced:

```
matched: true
totalAgents (pre-resolve): 12
agents resolved for dispatch: 7
UNRESOLVED (silently dropped):
  - ADR Generation Agent
  - Coverage Gap Detection Agent      (AQE)
  - SPARC Merge Agent
  - SPARC Specification Agent
  - Webhook Listener Agent
```

Five of twelve classifier-selected agents never dispatch. The pipeline proceeds with the remaining seven, `executeAutoChain` runs against partial phase output, and the MCP response from `agentics-ask` is emitted with `isError:false` but includes inline warnings (`WARNING: ADRs were not generated`, `WARNING: DDD model was not generated`). Claude Code surfaces no protocol-level error — it just reports "the call failed" when the operator asks after the fact, because the returned content references planning artifacts that the warnings say don't exist.

Five concrete defects are responsible:

1. **Missing AQE entries in the agent-name resolver.** `docs/ecosystem.graph.json` references 14 AQE agent display names, but `AGENT_NAME_TO_DOMAIN` at `src/routing/graph-router.ts:402` has zero AQE rows. Every AQE selection falls through `resolveAgentRef()` → `undefined` → silently skipped in `toDomainAgentList`.

2. **Pre-existing resolver gaps exposed by the new graph wiring.** `SPARC Specification Agent`, `SPARC Merge Agent`, `ADR Generation Agent`, and `Webhook Listener Agent` are referenced by several capabilities in the graph but were never added to `AGENT_NAME_TO_DOMAIN`. ADR-PIPELINE-083's phase bindings cause the classifier to select these capabilities more often, turning a latent drop into a routine one.

3. **Silent drop, not logged.** `toDomainAgentList` at `src/routing/graph-router.ts:547` has a comment claiming unresolved agents are "logged and skipped," but no log statement exists. There is no on-disk or on-console signal that an agent name failed to resolve.

4. **Domain-name inconsistency between graph and runner.** `docs/ecosystem.graph.json` uses `quality_engineering` (underscore). `src/agents/repo-agent-runner.ts` `FUNCTION_NAMES` / `BUNDLE_NAMES` and `src/agents/system-prompts.ts` use `quality-engineering` (hyphen). `src/routing/domain-boundary.ts` `TIE_BREAK_RULES` use the underscored form. The boundary module's own comment at lines 122–125 acknowledges this mismatch but never translates. Even with resolver entries in place, downstream dispatch through `FUNCTION_NAMES` would require a second translation layer that does not exist.

5. **Display-name collision on `Root Cause Analysis Agent`.** `AGENT_NAME_TO_DOMAIN` already maps this name to `{ domain: 'sentinel', agent: 'rca' }`. ADR-PIPELINE-080 reused the same display name in the `quality_engineering` domain agent list. Any future fix that adds AQE entries by display name alone will either shadow the sentinel entry or be shadowed by it, depending on insertion order.

Three secondary defects compound the user-visible symptom and are in scope for this fix:

6. **`src/routing/domain-boundary.ts` is dead-wired.** The module exports `resolveDomainBoundary`, `isDomainSuppressed`, and `routeKeyword`, but no command or pipeline stage imports them. ADR-PIPELINE-082's disambiguation and tie-break invariants (e.g., `security` → shield, not QE; `sap`/`oracle` → connector-hub, not QE) are therefore not enforced at routing time.

7. **`src/config/qe-gating.ts` and `src/pipeline/phase5-build/qe-gating-executor.ts` are unreferenced.** Neither file is imported from `src/pipeline/` or `src/commands/`. ADR-PIPELINE-086's kill-switch surface exists as code but has no call site, so `AGENTICS_QE_GATING=off` cannot actually disable phase 8 QE gating today — which is itself a blocker for a quick operational bypass while the resolver fix rolls out.

8. **`agentics-ask` MCP response design masks pipeline failures.** `src/mcp/mcp-server.ts:1094` hard-codes `isError: false` for `agentics-ask` regardless of subprocess exit code; pipeline output is truncated to 3000 characters at line 1084. When auto-chain phases fail, Claude Code sees a successful-looking tool response whose content contradicts itself (artifact instructions reference directories the warnings say don't exist). The protocol layer provides no signal the client can act on.

## Decision

Restore the pipeline in two landings: a minimal unblock landing that is safe to ship as a patch release, and a structural landing that closes the underlying defects surfaced by the integration.

### 1. Restore `AGENT_NAME_TO_DOMAIN` coverage (unblock landing)

Add resolver entries for every agent display name referenced in `docs/ecosystem.graph.json`. At minimum:

**AQE (`quality-engineering`):**

| Display name | Domain / agent |
|--------------|----------------|
| Test Design Agent | `quality-engineering` / `test-design` |
| Unit Test Generation Agent | `quality-engineering` / `unit-test-gen` |
| Integration Test Generation Agent | `quality-engineering` / `integration-test-gen` |
| Property-Based Test Agent | `quality-engineering` / `property-test-gen` |
| BDD Test Generation Agent | `quality-engineering` / `bdd-test-gen` |
| Coverage Analysis Agent | `quality-engineering` / `coverage-analysis` |
| Coverage Gap Detection Agent | `quality-engineering` / `coverage-gap-detect` |
| Defect Prediction Agent | `quality-engineering` / `defect-prediction` |
| Flaky Test Detection Agent | `quality-engineering` / `flaky-detection` |
| Requirements Traceability Agent | `quality-engineering` / `traceability` |
| Chaos Engineering Agent | `quality-engineering` / `chaos` |
| Test Execution Orchestrator Agent | `quality-engineering` / `test-execution` |
| QE Reporting Agent | `quality-engineering` / `qe-reporting` |

**Pre-existing graph references missing from the resolver** (audit and add):

- `SPARC Specification Agent`
- `SPARC Pseudocode Agent`
- `SPARC Architecture Agent`
- `SPARC Refinement Agent`
- `SPARC Completion Agent`
- `SPARC Merge Agent`
- `ADR Generation Agent`
- `Webhook Listener Agent`
- Any other agent name that appears in `capabilities[].mandatory_agents` or `capabilities[].optional_agents` in `ecosystem.graph.json` but is absent from the map.

Source of truth for the audit: `grep -oE '"[A-Z][A-Za-z0-9 /-]+ Agent"' docs/ecosystem.graph.json | sort -u` diffed against the keys of `AGENT_NAME_TO_DOMAIN`. CI must run this diff and fail on any gap (see §5).

### 2. Resolve the `Root Cause Analysis Agent` name collision

Two display names are in the graph today for the same visible string. Per ADR-PIPELINE-082 tie-break semantics (sentinel owns RCA at the platform/observability layer; QE owns test-failure RCA), rename the QE entry in `docs/ecosystem.graph.json` from `Root Cause Analysis Agent` to `QE Root Cause Analysis Agent`. Add the renamed entry to `AGENT_NAME_TO_DOMAIN` mapping to `quality-engineering` / `rca`. Leave the existing sentinel mapping untouched.

### 3. Normalize domain identifiers across graph, router, and runner

Standardize on the hyphenated runner form (`quality-engineering`) everywhere. The graph, boundary rules, and phase bindings all adopt hyphenated domain names. Concretely:

- Rename `quality_engineering` → `quality-engineering` in `docs/ecosystem.graph.json` (domain name and any capability `repos`/tag references).
- Update `TIE_BREAK_RULES` in `src/routing/domain-boundary.ts` to use the hyphenated form. Remove the "graph uses underscores, runner uses hyphens" comment at lines 122–125.
- Audit existing domain names in the graph for other underscore/hyphen mismatches (`test_bench` vs `test-bench`, `data_security` vs `data-vault`, `memory_context` vs `memory-graph`, `performance_profiling` vs `latency-lens`, `connector_hub` vs `connector-hub`, `safety` vs `shield`). For each, pick the runner form as canonical and rename the graph.

ADR-PIPELINE-082's boundary-resolution tests and any phase-binding fixtures must be updated in the same PR.

### 4. Log unresolved agents at `WARN` and surface them in the run manifest

Modify `toDomainAgentList` in `src/routing/graph-router.ts`:

```ts
for (const agent of group.agents) {
  const ref = resolveAgentRef(agent.agentName);
  if (ref) { /* push */ }
  else {
    console.error(`[routing] unresolved agent name "${agent.agentName}" in stage "${group.stage}" — skipping`);
    unresolvedAgents.push({ stage: group.stage, agentName: agent.agentName });
  }
}
```

Return `unresolvedAgents` on the `RouteQueryResult` so `executeNaturalLanguageRoute` can include it in the JSON envelope under `routing.unresolved`. The MCP `agentics-ask` response appends a distinct content block when `unresolved.length > 0`:

```
⚠️ Routing gaps — <N> classifier-selected agents were not dispatched:
   - <stage>: <agent name>
```

This gives field operators and Claude Code a visible, protocol-level signal that the graph references agents the resolver doesn't know about.

### 5. Wire `src/routing/domain-boundary.ts` into `executeNaturalLanguageRoute`

Apply `resolveDomainBoundary(query)` before dispatch in `src/commands/agents.ts:executeNaturalLanguageRoute`. Drop suppressed domains from `graphResult.agents` and log the applied rules to stderr in verbose mode. This makes ADR-PIPELINE-082's invariants actually enforced. The test coverage already exists in `tests/unit/routing/domain-boundary-082.test.ts` — add one integration test proving suppression reaches the dispatch list.

### 6. Wire `qe-gating-executor` into the phase 8 executor

Call `resolveQeGating()` at the top of phase 8 and branch on mode (`on` / `advisory` / `off`) per ADR-PIPELINE-086. This is required by this ADR — without it, there is no operational safety valve if §1–§4 miss an AQE agent and phase 8 starts halting pipelines again. Pipeline 086's bypass logging and `VALIDATION_REPORT.md` header stamping must fire on every non-`on` run.

### 7. MCP response: surface pipeline failure to Claude Code

`src/mcp/mcp-server.ts:1094` hard-codes `isError: false` for `agentics-ask`. Replace with:

```ts
const isError = toolName === 'agentics-ask'
  ? (hasRoutingGaps || autoChainFailed || missingMandatoryArtifacts)
  : result.code !== 0;
```

Where:
- `hasRoutingGaps` — `routing.unresolved.length > 0` on the CLI's JSON envelope.
- `autoChainFailed` — CLI stderr contains `Auto-chain pipeline error:` or the envelope's `pipeline` field is absent despite a successful simulation.
- `missingMandatoryArtifacts` — the existing on-disk checks for `adrs/` and `ddd/` return empty.

Also raise the 3000-character pipeline-summary truncation at line 1084. Either (a) emit the full envelope and rely on MCP client-side handling, or (b) keep a truncation limit but make it a tail slice rather than a head slice so the final exit status is always visible.

### 8. CI guard against future regressions

Add `scripts/check-graph-resolver-coverage.ts` that:
- Parses every agent display name from `docs/ecosystem.graph.json` (`domains[].agents[]`, `capabilities[].mandatory_agents[]`, `capabilities[].optional_agents[]`).
- Diffs against keys of `AGENT_NAME_TO_DOMAIN`.
- Exits non-zero on any gap, with a line-numbered report.

Wire into `.github/workflows/` alongside the existing `check-promotion-guard.ts` invocation. This prevents the class of regression that ADR-PIPELINE-080 introduced — graph additions without resolver updates — from ever reaching `main` again.

## Consequences

**Positive:**
- `agentics ask` against the field-report prompt resolves 12/12 classified agents instead of 7/12; auto-chain runs with complete phase input; ADR and DDD artifacts generate; MCP response is internally consistent.
- Silent routing failures become visible both to CI (via §8) and to end users (via §4's `routing.unresolved` block).
- ADR-PIPELINE-082's boundary rules become enforced instead of aspirational.
- ADR-PIPELINE-086's kill-switch gains a live call site — operators can actually bypass QE gating when upstream AQE is down.
- Claude Code MCP clients see a real failure signal when the pipeline degrades, instead of a silent `isError:false` that contradicts its own content.

**Negative / risks:**
- Renaming `quality_engineering` → `quality-engineering` in the graph is a breaking change for any external consumer of `ecosystem.graph.json`. Mitigation: keep a compat alias map in the graph loader for one release (reads the old form, warns, maps to new).
- Section 7's stricter `isError` gate will make previously-passing `agentics-ask` invocations visibly fail in Claude Code when the pipeline is genuinely partial. This is the intended behavior, but it will generate more "my pipeline failed" reports from fields that were silently getting degraded output before. Runbook update required.
- Wiring §6 (`qe-gating-executor`) expands the phase 8 code path. Mitigation: ADR-086 already ships the unit test suite (`tests/unit/config/qe-gating-086.test.ts`); phase 8 integration test coverage needs one additional case per gating mode.

**Neutral:**
- The `QE Root Cause Analysis Agent` rename (§2) is visible in any graph-rendering tool and in the MCP `routing.unresolved` block when the agent fails to resolve pre-fix. Document the rename in a single-line CHANGELOG entry.

## Validation

Before merge:

1. `scripts/check-graph-resolver-coverage.ts` exits zero on `main` HEAD.
2. Re-run the field-report prompt through `node /tmp/probe.mjs` (or equivalent) and assert `agents resolved for dispatch === totalAgents (pre-resolve)` — i.e., zero silent drops.
3. `npm test -- tests/unit/routing/` passes, including the new boundary-module integration test in §5.
4. End-to-end smoke: `agentics ask "<field-report prompt>"` in a blank repo produces non-empty `.agentics/plans/adrs/` and `.agentics/plans/ddd/` directories.
5. MCP smoke: inject a deliberate resolver gap, run `agentics-ask` via the MCP stdio harness, and confirm the returned `isError: true` plus a `routing.unresolved` content block.

## Rollout

Landing 1 (patch release, same day as this ADR's approval):
- §1 (resolver coverage) + §2 (name collision) + §4 (log unresolved) + §8 (CI guard).
- Minimum needed to unblock field runs. Does not change graph identifiers, does not flip MCP `isError` semantics.

Landing 2 (next minor):
- §3 (domain identifier normalization), §5 (boundary wiring), §6 (gating executor wiring), §7 (MCP response semantics).
- Includes the graph-loader compat alias, runbook updates, and integration test coverage.

Rollback plan: both landings are self-contained and revert cleanly. Landing 1's only breaking surface is the new `routing.unresolved` field on the JSON envelope — clients that ignore unknown fields are unaffected. Landing 2's graph-rename is the only customer-visible break; the compat alias guarantees one release of overlap.

## References

- `src/routing/graph-router.ts:402` — `AGENT_NAME_TO_DOMAIN` declaration
- `src/routing/graph-router.ts:547` — `toDomainAgentList` silent-drop site
- `src/routing/domain-boundary.ts:122-125` — acknowledged-but-untranslated naming mismatch
- `src/agents/repo-agent-runner.ts:64,106` — `FUNCTION_NAMES` and `BUNDLE_NAMES` entries for `quality-engineering` / `agentic-qe`
- `src/mcp/mcp-server.ts:1094` — hard-coded `isError: false` for `agentics-ask`
- `src/mcp/mcp-server.ts:1084` — 3000-char pipeline-summary truncation
- `docs/ecosystem.graph.json:198` — `quality_engineering` domain declaration
- `docs/adrs/ADR-PIPELINE-080-quality-engineering-domain.md` — original AQE registration
- `docs/adrs/ADR-PIPELINE-082-aqe-agent-scope-boundary.md` — boundary rules (currently dead-wired)
- `docs/adrs/ADR-PIPELINE-083-phase-capability-binding-qe.md` — phase bindings that surfaced the defects
- `docs/adrs/ADR-PIPELINE-086-qe-kill-switch-gating-regression.md` — kill-switch surface (currently not called)
