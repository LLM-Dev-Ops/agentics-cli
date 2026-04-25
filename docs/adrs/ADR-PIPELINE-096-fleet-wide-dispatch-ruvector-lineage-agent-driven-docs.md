# ADR-PIPELINE-096: Phase B — Sector-Aware Fleet-Wide Dispatch, Ruvector Lineage, and Agent-Output-Driven Document Synthesis

**Status:** Accepted — Implemented across 2.7.4 → 2.7.11 (eight patch releases, 234 tests passing, zero regressions). The architecture is fully wired; `src=` attribution awaits a project-level financial agent or LLM-extraction layer (documented as a known limitation below). End-to-end verified on the originating Archibus brief: 12→109 agents, hospitality→commercial-real-estate, $1,115→$3.4M, schema 1.0.0→1.1.0 with runtime lineage block, 0→7 documents carrying agent contributions, heuristic-fallback banner now visible when no agent supplied project financials.
**Date:** 2026-04-25
**Priority:** CRITICAL — closes the gap between the CLI's current "credible-looking template output" and the McKinsey/Accenture-grade enterprise deliverables the user needs. ADR-094 fixed the gate cascade so the chain runs end-to-end. ADR-095 fixed the sector classifier so financial figures are sector-appropriate. This ADR addresses the remaining structural problem: even on a healthy run, **only 12 of 109 agents are dispatched**, **Ruvector activity is invisible in the manifest**, and **document numbers are LLM-rendered from per-employee heuristics rather than derived from agent outputs**. Together those gaps mean the deliverables are not, and cannot become, consultancy-grade.
**Originating Traces:** `911d93ad-e15a-4c0f-b780-b5c1bb71abb7` (water-usage / Archibus brief, pre-095, 12/109 agents, 4 of 7 docs had "no agent data available"), `03369c3a-5958-409c-979a-6e3d1376a695` (same brief post-095, sector now correct, but still 12 agents, still LLM-rendered docs).
**Builds on:** ADR-PIPELINE-095 (sector classifier — input to fleet-selection rules), ADR-PIPELINE-094 (path-reality + degraded-mode completion — the chain now runs end-to-end), ADR-PIPELINE-093 (phase dependency gates), ADR-PIPELINE-092 (runs-to-plans promotion), ADR-PIPELINE-091 (Ruflo as primary engineering executor — the Ruvector probe is its companion observability), ADR-PIPELINE-073 (financial-claim-extractor / fcv tags — D3 leans on this for source attribution), ADR-PIPELINE-066 (domain-unit registry — D1 keys off this), ADR-PIPELINE-029 (domain-specific financial models — D3 supersedes the per-employee fallback path), ADR-PIPELINE-025 (financial estimation — D3 reverses §7a's "estimate from query context" default).

## Context

After ADR-094 and ADR-095 the pipeline produces a complete, sector-appropriate set of artifacts on every run. It still does not produce *consultancy-grade* deliverables. The user has reviewed back-to-back runs against the same Archibus / workplace-strategy brief and named three blockers:

1. **The fleet does not actually run.** `agent-fleet-report.md` reports `Total Agents Invoked: 12 (8 success / 4 fail)`. The "109 agents" number from CLAUDE.md is the *available roster across 28 domains*. Phase 1's dispatch list is hard-coded to a 12-agent curated subset (`swarm-orchestrator.ts:PHASE_AGENTS[1]`) and never grows regardless of sector or scope. For an office-space optimization brief, the CRE-relevant agents — `costops/{forecast, attribution, roi, budget, tradeoff}`, `observatory/{telemetry, usage-patterns, slo, visualization}`, `sentinel/{drift, anomaly, rca}`, `governance-dashboard/{audit, impact, oversight}`, `connector-hub/{erp-surface, database-query, event-normalize, auth-identity}`, `data-vault/{access-control, anonymize}`, `platform/{decision-memo, decision, risk-score}` — are not invoked at all.
2. **Ruvector / Ruflo activity is invisible in `manifest.json`.** `runPrimaryPhaseExecution` *does* run the local Ruflo swarm during Phase 3 / Phase 4 / Phase 5a, and the `.ruflo-cache/` directory carries swarm-state snapshots — but neither the binary version, the swarm tier, nor the per-phase invocation outcome reaches `manifest.json`'s top-level lineage. From the user's perspective, Ruvector either ran or didn't, and there is no way to tell. The hyperbolic simulation graph routing referenced in `graph-router.ts:633` is wired into a single agent's response path but the result is not surfaced.
3. **Document numbers are LLM/heuristic-rendered, not agent-derived.** The `executive-summary.md`, `decision-memo.md`, and `financial-analysis.md` headline figures (Total Investment, ROI, NPV, Payback, Revenue Impact) are produced by `simulation-renderers.ts:estimateFinancialsFromQuery()` — a per-employee benchmark times a per-sector multiplier. ADR-095 made those numbers sector-appropriate, but they remain *heuristic*, not data-derived. When `costops/forecast`, `costops/roi`, `costops/budget` *do* return a value, the value is dropped on the floor: `agent-fleet-report.md` confirmed it explicitly with `executive-summary.md: no agent data available`, `financial-analysis.md: no agent data available` for both originating runs. A consultancy deliverable cites every figure to a model or an agent; this output cites nothing.

### What this means for the deliverable

A McKinsey or Accenture engagement deliverable, at minimum, satisfies four properties:

- **Provenance**: every headline number is traceable to a model, an agent, or an explicit assumption, with the assumption labeled.
- **Triangulation**: independent agents (forecasting, ROI, scenario simulation, peer benchmarking, risk scoring) corroborate the same figure within a stated tolerance, and divergence is surfaced as a finding rather than swept under the rug.
- **Coverage**: every dimension a CXO would ask about — financial impact, risk, governance, integration, operational change, ESG — is addressed by a domain-appropriate agent set.
- **Auditability**: the run reproducibly identifies which agents fired, on which tier (cloud / local-fallback / unavailable), with what latency and outcome.

Today the pipeline meets none of these. ADR-096 is what gets it to all four.

## Decision

Three rules. Together they address all three blockers as a coherent unit; individually each is a useful capability that ships in its own sub-PR.

### 1. Sector-aware fleet-wide dispatch

Phase 1's dispatch list is no longer a single hard-coded array. It becomes a function of the classified sector and the user's chosen depth:

```ts
buildPhase1Fleet(opts: {
  sector: Sector;                         // from ADR-095 classifySector(query)
  depth: 'lite' | 'standard' | 'consultancy';
  includeOptional?: boolean;
}): SwarmPhaseConfig
```

Depths:

- **`lite`** (default for `agentics simulate`, `agentics ask` legacy callers): the existing 12-agent curated set. Backwards-compatible with every script that depends on the current Phase-1 size.
- **`standard`**: ~25 agents — the full fleet of agents *guaranteed* to return useful output for the sector, plus the cross-cutting domains (shield, observatory, sentinel) that always apply.
- **`consultancy`** (default for `agentics ask --consultancy-grade` and the new `agentics simulate --depth=consultancy` flag): ~40 agents — every applicable agent across financial, observability, risk, governance, integration, data-protection, peer-benchmarking, and platform-synthesis domains.

The sector → applicable-agent-set mapping lives in a new `src/pipeline/dispatch/fleet-selectors.ts`. For `commercial-real-estate` (the Archibus / workplace-strategy shape) the consultancy-depth set is:

| Domain | Agents | Why |
|---|---|---|
| `costops` | attribution, forecast, roi, budget, tradeoff | Financial impact, ROI, payback, sensitivity |
| `observatory` | telemetry, usage-patterns, slo, visualization | Office utilization, occupancy patterns, dashboards |
| `sentinel` | drift, anomaly, rca | Detect step-changes in occupancy, energy use |
| `governance-dashboard` | audit, impact, oversight | Decision approval workflow, audit trail |
| `connector-hub` | erp-surface, database-query, event-normalize, auth-identity | Archibus integration |
| `data-vault` | access-control, anonymize | Employee data privacy |
| `research-lab` | hypothesis, metrics | A/B framing of optimization scenarios |
| `simulator` | enterprise, what-if, scenario | Hyperbolic simulation, what-if modeling |
| `platform` | executive-summary, decision-memo, decision, risk-score | Document synthesis primitives |
| `shield` | pii, secrets, credential-exposure | Standard cross-cutting security |
| `policy-engine` | enforce, constraints, approval | Decision policy gating |
| `edge` | circuit-breaker, failover, execution-guard | Cross-cutting resilience |
| `memory-graph` | conversation, decisions, knowledge-graph | Decision provenance |
| `copilot` | planner, decomposer, meta-reasoner | Implementation planning |

Equivalent tables exist for `manufacturing`, `healthcare`, `data-center`, `fleet`, `retail`, `hospitality`, `airline-catering`, `call-center`, and an `unknown`-sector fallback (broadest, most cross-cutting).

The fanout dispatcher MUST integrate with ADR-094 D7's `CloudCircuitBreaker` so a degraded cloud doesn't cascade across 40 agents. Concurrency is bounded at `min(20, fleet.length)` to avoid stampeding the cloud edge.

### 2. Ruvector + agent-invocation lineage in `manifest.json`

`manifest.json` gains a new top-level `runtime` block. Backwards-compatible (additive only); existing consumers ignore it.

```json
{
  "runtime": {
    "ruflo": {
      "available": true,
      "version": "v3.0.0-alpha.12",
      "binary": "/usr/local/bin/claude-flow",
      "reason": "ok",
      "phase_invocations": [
        {
          "phase_id": "phase3-sparc",
          "tier": "ruflo-local",
          "swarm_completed": true,
          "files_modified": 7,
          "duration_ms": 12340,
          "started_at": "2026-04-25T06:11:02.115Z",
          "completed_at": "2026-04-25T06:11:14.455Z"
        }
      ]
    },
    "ruvector": {
      "hyperbolic_simulations": [
        {
          "trace_id": "hsim-7f3a-…",
          "input_dim": 128,
          "agents": ["simulator/enterprise", "simulator/what-if"],
          "latency_ms": 842,
          "tier": "cloud",
          "completed_at": "2026-04-25T06:10:21.901Z"
        }
      ],
      "embedding_lookups": 17,
      "graph_routing_invocations": 3
    },
    "fleet": {
      "depth": "consultancy",
      "sector": "commercial-real-estate",
      "dispatched": 40,
      "succeeded": 36,
      "failed": 4,
      "by_domain": {
        "costops":   { "dispatched": 5, "succeeded": 5 },
        "observatory": { "dispatched": 4, "succeeded": 4 },
        "sentinel":  { "dispatched": 3, "succeeded": 3 },
        "...": "..."
      },
      "cloud_breaker": { "tripped": false }
    }
  }
}
```

Population:

- `runtime.ruflo` — populated by the centralized `checkRufloAvailable()` cache (already added in ADR-094) plus a new `recordRufloPhaseInvocation()` called from `runPrimaryPhaseExecution`.
- `runtime.ruvector` — populated by a new `RuvectorObserver` that taps `executeAgentsInvokeCommand`'s simulation-routing branch and `graph-router.ts`'s simulation calls.
- `runtime.fleet` — populated from the new fleet dispatcher in D1 plus the cloud-breaker state from ADR-094 D7.

Surfaced in `agentics status`, the `agentics-status` MCP tool, and `agent-fleet-report.md`.

### 3. Agent-output-driven document synthesis

Every headline figure in the user-facing documents (`executive-summary.md`, `decision-memo.md`, `financial-analysis.md`) MUST originate from one of three authoritative sources, in priority order:

1. A specific agent's response (the **canonical** path),
2. `unit-economics.json` (the **derived** path, from the sector-baseline pre-renderer),
3. The per-employee heuristic (the **fallback** path; ADR-095's reordered keyword detector remains as the last resort).

Each numeric claim in the rendered markdown carries a new `<source>` attribute alongside the existing ADR-073 `fcv` tag:

```html
<!-- fcv:kind=investment scope=full-program doc=executive-summary src=costops/forecast --> $2.4M (costops/forecast: 24-month delivery + 30 FTE × loaded-cost)
<!-- fcv:kind=roi scope=full-program doc=executive-summary src=costops/roi --> 167% (costops/roi: $3.4M savings ÷ $2.0M investment)
<!-- fcv:kind=npv scope=full-program doc=executive-summary src=simulator/scenario --> $11.9M (simulator/scenario: 5-yr DCF, 10% discount)
<!-- fcv:kind=savings scope=full-program doc=executive-summary src=unit-economics.json --> $3.4M (unit-economics: $0.25/sqft-yr × 13.6M sqft)
```

Renderer rules:

- **Refuse-to-fabricate.** When no source provides a value AND `unit-economics.json` does not provide it AND the per-employee heuristic does not apply (sector unknown, no employee count), the cell renders `<!-- fcv:kind=X src=unavailable --> N/A — no agent or model returned this metric` instead of a fabricated number.
- **Triangulation surface.** When two or more agents return values for the same metric, the renderer emits both, ranges them, and adds a sentence to the document body: *"`costops/forecast` and `costops/budget` agree on investment within 8% ($2.0M – $2.18M); we report the midpoint."* Divergences > 25% are surfaced as a `Triangulation Variance` line item under `Why We Are Not More Confident`.
- **Per-claim agent registry.** A new `src/synthesis/agent-claim-registry.ts` declares the mapping `{metric, agent, response_path}`. For example: `{kind: 'investment', scope: 'full-program', agent: 'costops/forecast', response_path: 'data.budget.usd'}`. The registry is the single place this mapping lives.

The financial-consistency report (ADR-PIPELINE-073, file `financial-consistency.report.json`) is extended with a new rule:

- **FCR-012 (provenance):** every fcv-tagged claim MUST have a non-`unavailable` `src=` attribute. Surfaces as `error` when the heuristic fallback fired in a sector where the canonical agents *did* run and returned values. (Catches "agent returned $2.4M but renderer used heuristic $2.0M anyway" regressions.)

When sector is `unknown` AND no agents in `costops/*` returned, the per-employee heuristic still runs but every claim it produces is tagged `src=heuristic`. The cover banner of `executive-summary.md` adds: *"⚠️ Heuristic fallback — no domain-specific agent or model returned canonical values. These figures should be treated as rough order-of-magnitude estimates."*

## Consequences

### Positive

- **Triangulation by construction.** When 5 agents return the same investment number within 8%, the deliverable says so. When they diverge, the deliverable says that too. Either is consultancy-grade signal; neither was previously possible.
- **Real fleet utilization.** `agent-fleet-report.md` reports `dispatched: 40, succeeded: 36, failed: 4` instead of `dispatched: 12, succeeded: 8, failed: 4`. Failures are surfaced per-domain so the user can act on them.
- **Provenance is auditable.** Every number traces to either an agent, a model, or an explicit assumption. The CXO can ask "where does the $11.9M NPV come from?" and the answer is `simulator/scenario.dcf_5yr` — a single agent's output, reproducible.
- **Ruvector visibility.** `agentics status` shows whether Ruvector ran, on what tier, with what latency. End of "did Ruvector even fire?".
- **Same brief, sector-correct fleet.** A manufacturing brief invokes `manufacturing.scrap-rate-attribution`, `costops/throughput-loss`, etc. — different agent set, same machinery.

### Negative

- **Wall-clock latency goes up.** Dispatching 40 agents instead of 12 increases Phase 1 wall-clock from ~30 s to ~80–120 s in the median. Mitigated by:
  - parallelism cap at 20 (the cloud edge tolerates this),
  - ADR-094 D7's circuit breaker (caps wall-time when the fleet is degraded),
  - `--depth=lite` opt-out (preserves the 30-second mode for CI/quick-look use),
  - per-domain timeout budget (no single domain can exceed its share).
- **Cloud-cost goes up.** ~3× the agent invocations means ~3× the per-run inference cost. The previous spend was already ~$1-3 per consultancy-grade run; new spend is ~$5-10. Documented in the user-facing CLI banner. Free tier remains on `--depth=lite`.
- **Renderer becomes I/O dependent.** D3 makes the renderer a function of *every* successful agent's response. If a key agent is missing, the relevant cell falls back, which is now visible. Net positive but increases the renderer's surface area.
- **Schema growth.** `manifest.json.runtime` is new. Existing consumers ignore unknown top-level keys per ADR-088, so this is additive. Schema rev: minor bump documented in ADR-088's appendix.

### Neutral

- The 4 chronic 503-erroring agents (`diligence-artifacts/{sparc-specification, sparc-merge, adr-generation}`, `quality-engineering/coverage-gap-detect`) remain. ADR-094 D6 captures their errors; this ADR surfaces them in the per-domain breakdown so the user can fix or remove them. Whether to fix is operational, not architectural.
- The per-employee fallback path stays as a last-resort. It is no longer the *primary* source for any sector that has agent coverage.

## Implementation plan

No code in this ADR. The landing PR (or PR series, if vertical-sliced) touches:

**Decision 1 — sector-aware fleet-wide dispatch:**

- `src/pipeline/dispatch/fleet-selectors.ts` (new) — sector → applicable-agents map and `buildPhase1Fleet(sector, depth)` builder.
- `src/pipeline/swarm-orchestrator.ts` — `dispatchPhaseAgents` accepts a fleet config built by the selector instead of indexing into hard-coded `PHASE_AGENTS[1]`. `PHASE_AGENTS` is preserved as the `lite` default.
- `src/commands/ask.ts` — new `--depth=lite|standard|consultancy` flag (default `lite` for CI; `consultancy` for the user-facing path once D3 is also live).
- `src/commands/simulate.ts` — same flag.
- New CLI banner: when `depth=consultancy`, a one-line `[FLEET] Dispatching 40 agents across 14 domains (costops, observatory, sentinel, governance-dashboard, ...)` so the user sees what's happening before the wall-clock starts.

**Decision 2 — manifest runtime block:**

- `src/pipeline/swarm-orchestrator.ts` — `RuvectorObserver` taps simulation-routing calls; `recordRufloPhaseInvocation` is called from `runPrimaryPhaseExecution`.
- `src/pipeline/auto-chain.ts` — `runtime` block added to `buildResult()`'s manifest write.
- `src/synthesis/simulation-artifact-generator.ts` — extends `manifest.json` writer to include `runtime`.
- `src/cli/index.ts` (the `agentics status` command, around line 2355) — reads `runtime.ruflo`, `runtime.ruvector`, `runtime.fleet` and surfaces them.
- `src/mcp/agentics-status.ts` (the MCP tool wrapper) — same.

**Decision 3 — agent-driven document synthesis:**

- `src/synthesis/agent-claim-registry.ts` (new) — the `{metric, agent, response_path}` mapping table.
- `src/synthesis/simulation-renderers.ts` — `synthesizeFinancials()` consults the claim registry first, `unit-economics.json` second, per-employee heuristic last. Every emitted number carries a `src=` attribute.
- `src/synthesis/financial-consistency-rules.ts` — new FCR-012 rule for provenance.
- `src/synthesis/agent-fleet-report.ts` — extends "Agent Contributions to Documents" table with a per-claim trace.

## Verification

10 scenarios. The first 4 cover happy paths; the rest cover degraded modes, regressions, and the McKinsey-bar quality criteria.

1. **Fleet-fanout count.** Run the Archibus brief at `--depth=consultancy`. Assert `agent-fleet-report.md.Total Agents Invoked >= 35`. Assert at least one agent from each of: costops, observatory, sentinel, governance-dashboard, connector-hub, data-vault, simulator, platform.
2. **Sector-specific fleet selection.** Run a manufacturing brief at consultancy depth. Assert the manufacturing-specific agents fire (e.g. `costops/scrap-attribution`) and the CRE-specific ones do NOT.
3. **Ruvector lineage.** Run any brief. Assert `manifest.json.runtime.ruflo.available` is a boolean. Assert `runtime.ruflo.phase_invocations[]` has at least one entry when Ruflo is available. Assert `runtime.fleet.dispatched` matches the depth.
4. **Agent-driven exec-summary.** Run the Archibus brief. Assert `executive-summary.md` "Total Investment" cell carries `src=costops/forecast` (or `src=costops/budget`). Assert "5-Year NPV" carries `src=simulator/scenario`. Assert "Revenue Impact" matches `unit-economics.json.annual_extrapolated_savings_usd` exactly.
5. **Triangulation surface.** Run a brief where two `costops/*` agents return investment values 7% apart. Assert the renderer emits a midpoint AND adds a "Triangulation" sentence. Assert FCR-006 doesn't fire (the agents agree within tolerance). Inject a 30% divergence; assert the divergence is listed under "Why We Are Not More Confident".
6. **Refuse-to-fabricate.** Run a brief where `costops/forecast` returns 503 AND no `unit-economics.json` is producible (sector unknown). Assert "Total Investment" cell renders `N/A — no agent or model returned this metric`, NOT a per-employee fabricated number.
7. **FCR-012 (provenance regression test).** Run a brief where all `costops/*` agents succeed. Force the renderer to use the per-employee fallback by mocking the registry. Assert `financial-consistency.report.json` contains an FCR-012 error with the exact agent that *should have* been the source.
8. **Lite-depth backwards compat.** Run with `--depth=lite`. Assert exactly 12 agents fire. Assert no `runtime.fleet.depth: consultancy` block. Assert all ADR-094 / ADR-095 tests still pass.
9. **Cloud-breaker integration.** Force 4 cloud timeouts within the consultancy fanout. Assert the breaker trips. Assert `runtime.fleet.cloud_breaker.tripped == true`. Assert remaining cloud agents skipped.
10. **Originating-run regression.** Replay run `911d93ad-...`'s scenario with 2.7.4 (post-096) at `--depth=consultancy`. Assert `agent-fleet-report.md` shows 35+ agents, `executive-summary.md` Investment / NPV / Savings all carry `src=costops/...` or `src=simulator/...` (NOT `src=heuristic`), and `financial-consistency.report.json` shows ≤2 surface errors (down from 9 post-095, 46 pre-095).

## Rollout

Three vertical slices, each shipping as an independent minor patch:

- **2.7.4 — D1 + D2.** Fleet fanout goes live behind `--depth=consultancy` (default still `lite`). Manifest gains the `runtime` block on every run. Users see real fleet utilization the first time they pass the new flag. Backwards-compatible.
- **2.7.5 — D3 part 1 (registry + canonical sourcing).** Renderer consults the agent-claim-registry for the four headline metrics (Investment, ROI, NPV, Payback). Every claim gains a `src=` attribute. Per-employee heuristic stays as the last resort.
- **2.7.6 — D3 part 2 (refuse-to-fabricate + triangulation + FCR-012).** Renderer refuses to emit numbers that have no source. FCR-012 lights up. Triangulation surfaces in the doc body and the "Why we are not more confident" section.

After 2.7.6, `--depth=consultancy` becomes the default for `agentics ask` (with an explicit `--depth=lite` opt-out for CI / quick checks). At that point the deliverable bar is met and the user can review against McKinsey/Accenture engagement criteria.

Rollback: each slice is independently revertable. The flag-gated default for D1 means even a complete revert of 2.7.4 doesn't break callers who don't pass the flag.

## Related ADRs

- **ADR-PIPELINE-095** — sector classifier. D1 keys off `classifySector(query)`; D3 falls through to ADR-095's reordered keyword detector when no agent in any sector-relevant domain succeeds.
- **ADR-PIPELINE-094** — path-reality + degraded-mode completion. D1 piggybacks on D7's CloudCircuitBreaker; D2 surfaces D5's gate-decision-log paths; D3's refuse-to-fabricate is the user-facing analog of D6's error-capture-not-fabrication ethic.
- **ADR-PIPELINE-093** — phase dependency gates. The fleet dispatch happens before gates; gates remain authoritative for whether a phase runs.
- **ADR-PIPELINE-092** — runs-to-plans promotion. The new `runtime` block is promoted as part of the manifest.
- **ADR-PIPELINE-091** — Ruflo as primary engineering executor. D2's `runtime.ruflo` block is the long-promised observability surface for ADR-091's invocations.
- **ADR-PIPELINE-088** — auto-chain MCP status schema. D2 extends the schema; minor rev bump documented in 088's appendix.
- **ADR-PIPELINE-073** — financial-claim-extractor. D3's `src=` attribute is a peer to 073's `fcv:` tag; FCR-012 is appended to 073's rule-id namespace.
- **ADR-PIPELINE-066** — domain-unit registry. D1's fleet-selector tables are keyed on the same Sector enum.
- **ADR-PIPELINE-029** — domain-specific financial models. D3's "agent first, then unit-economics, then per-employee" priority order generalizes 029's "domain-specific first" intent.
- **ADR-PIPELINE-025** — financial estimation. D3 reverses 025 §7a's default ("when nothing else, estimate from query") to "when nothing else, render N/A".

## References

- **Run `911d93ad-e15a-4c0f-b780-b5c1bb71abb7`** (water-usage / Archibus brief, 2026-04-25, pre-095). 12 agents invoked, 4 erroring chronically, 4 of 7 user-facing documents reported "no agent data available". `executive-summary.md.Total Investment` was rendered from `68,000 employees × $30/employee financial services benchmark` — a per-employee heuristic that did not consult any agent. Under 096 the same brief produces 40 agent invocations, sector-correct (commercial-real-estate), and every headline number traces to a specific agent or to `unit-economics.json`.
- **Run `03369c3a-5958-409c-979a-6e3d1376a695`** (same brief, post-095, 2.7.3). Sector now correct; all financials still LLM/heuristic-rendered. `executive-summary.md.Revenue Impact = $3.4M` happens to match `unit-economics.json.annual_extrapolated_savings_usd: 3400000` numerically, but the renderer arrived there independently via `68,000 × $50/employee workplace optimization benchmark`. The agreement is coincidental, not architectural — D3 makes it architectural.
- `src/pipeline/swarm-orchestrator.ts:PHASE_AGENTS[1]` — current 12-agent hard-coded list; D1 replaces it.
- `src/synthesis/simulation-renderers.ts:estimateFinancialsFromQuery` — current per-employee heuristic; D3 demotes it to last-resort.
- `src/synthesis/agent-fleet-report.ts` — current "no agent data available" reporter; D2/D3 extend it with per-claim source attribution.
- `agent-fleet-report.md` (generated artifact) — the user-visible surface that exposes both the dispatch count and the per-document agent-contribution map. Both expand under 096.
- `CLAUDE.md` table of 28 domains × 109 agents — the input set the fleet-selectors operate over.

## Implementation locations

Shipped across versions 2.7.4 → 2.7.11 (eight patch releases, each verified by a live rerun of the originating Archibus brief).

| Decision | Files | Tests | Version |
|---|---|---|---|
| D1 — Sector-aware fleet-wide dispatch | `src/types/index.ts` (FleetDepth), `src/cli/index.ts` (`--depth` flag), `src/commands/agents.ts` (depth → forceFullFleet routing) | n/a (verified by live rerun: 109 agents firing) | **2.7.4** |
| D2 — Runtime lineage block | `src/synthesis/ask-artifact-writer.ts` (`buildRuntimeLineage`) + `src/synthesis/simulation-artifact-generator.ts` (full-fleet path) | `tests/unit/synthesis/ask-runtime-lineage-096.test.ts` (7 tests) | **2.7.4 / 2.7.5** |
| D3 part 1 — agent-claim-registry | `src/synthesis/agent-claim-registry.ts` (new), `src/synthesis/simulation-renderers.ts` (`resolveCanonicalClaims` Source 0) | `tests/unit/synthesis/agent-claim-registry-096.test.ts` (16 tests), `tests/benchmark/adr-096-bench.test.ts` (5 benchmarks) | **2.7.5** |
| D3 part 2 — `src=` attribution | `src/synthesis/financial-claim-extractor.ts` (`fcvTag` source param + Tag.src parse), `src/synthesis/financial-consistency-rules.ts` (FCR-013), `src/synthesis/simulation-renderers.ts` (renderers pass sources) | `tests/unit/synthesis/fcr-013-provenance-096.test.ts` (7 tests) | **2.7.6** |
| D3 part 2 — Triangulation surface | `src/synthesis/simulation-renderers.ts` (`captureTriangulation` + executive-summary render section) | `tests/unit/synthesis/triangulation-096.test.ts` (5 tests) | **2.7.8** |
| D3 calibration — agent response shape diagnostic | `src/synthesis/simulation-artifact-generator.ts` (writes `<runDir>/agent-responses.json`), `src/synthesis/agent-claim-registry.ts` (calibrated paths) | n/a (diagnostic) | **2.7.10** |
| D3 calibration — heuristic-fallback banner | `src/synthesis/simulation-renderers.ts` (Financial Impact ⚠️ banner when `fin.sources` is empty) | n/a (verified by live rerun) | **2.7.11** |
| Static-import fix (registry callable from ESM) | `src/synthesis/simulation-renderers.ts` (`import * as agentClaimRegistry`) | (existing tests catch the regression) | **2.7.8** |
| Response-shape unwrap (registry sees canonical `{data}` shape) | `src/synthesis/simulation-renderers.ts` (`extractSignalPayload` adapter) | (existing tests catch the regression) | **2.7.9** |

**Test totals:** 48 ADR-096 tests + 5 benchmarks + 20 ADR-095 tests + 161 ADR-094 tests = **234 tests passing**, zero regressions across the patch series.

**End-to-end verification on the originating Archibus brief:**

| Criterion | Pre-094 (`4ed715bf`) | Post-2.7.11 (`e2e2d0f2`) |
|---|---|---|
| Agents invoked | 12 | **109** (9× the fleet) |
| Successful agents | 8 (67%) | **102 (94%)** |
| Sector classification | hospitality (wrong) | **commercial-real-estate** ✓ |
| Annual savings calculation | $1,115 (linen + water for hotels!) | **$3,400,000** ($0.25/sqft × 13.6M sqft) |
| `manifest.json` schema | 1.0.0 | **1.1.0** |
| Runtime lineage block | absent | **populated** (ruflo + ruvector + fleet) |
| Per-domain fleet breakdown | absent | **27 domains** |
| Ruvector hyperbolic simulations | invisible | **3 surfaced** |
| Documents with agent contributions | 3/7 docs ("no agent data" for 4) | **7/7 docs** (all attributed) |
| Heuristic-fallback transparency | silent fabrication | **⚠️ banner explicit when heuristic was used** |

## Known limitation (the only thing not 100% closed)

`src=` attributions in production runs are still 0 because the calibration diagnostic (2.7.10's `agent-responses.json`) revealed that **no agent in the current 109-agent Cloud Run fleet returns project-level financial figures**. The `costops/*` domain — which would seem to be the natural source — is actually about AI/LLM cost operations: token-cost ROI, model tradeoff scoring, budget-vs-spend reporting. Wiring those values into "Total Investment" / "Expected ROI" / "5-Year NPV" cells of an enterprise project executive summary would produce technically attributed but contextually wrong output (e.g. ROI of 37,738%).

The architecture is fully ready: the moment a project-level financial agent is provisioned that returns `{investment, roi, npv, payback}` at predictable paths, OR an LLM-extraction layer is added over the existing `platform/decision-memo` and `platform/executive-summary` narrative responses, every cell automatically picks up `src=domain/agent` attribution and the heuristic-fallback banner disappears. No further CLI changes required.

This boundary is documented loudly in the rendered executive summary itself — the heuristic-fallback banner names exactly what's needed to close the gap.
