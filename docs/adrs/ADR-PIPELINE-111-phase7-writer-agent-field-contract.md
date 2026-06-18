# ADR-PIPELINE-111: Phase 7 — Writer-Agent Field Contract & Agent-Sourced Deliverable Generation

**Status:** Implemented (2026-06-18)
**Implementation summary:** Three new modules under `src/pipeline/phase7/` close the ADR-098 *Q-future* hole. **D1** `writer-agent.ts` — `WriterResult { slug, templateId, fields, field_provenance, unfilled, agents_called }`, keys drawn from `extractPlaceholders(templateBody)`. **D3** `generateDeliverableFields` dispatches each row's `sourceAgents` via a lazy-imported `executeAgentsInvokeCommand` (cycle-safe), cached per run in a shared `AgentOutputCache` — benchmark confirms 60 unique agents across 76 non-mirror rows dispatch exactly 60 times (e.g. `costops/roi`, in 10 rows, invoked once); failures isolated as `status:502`, never thrown. **D4** `field-mappers.ts` registers exactly one `FamilySpec` per registry `templateId` (33); `field-writer.ts` `writeFieldsViaLLM` builds a family-scoped, JSON-returning prompt over the Claude-Max-only `claude --print` channel and validates output (placeholder allow-list + a money guard that drops any value introducing a `$` figure absent from the canonical set). **D2** the coordinator merge replaced `void rufloResult`: the family LLM (grounded on agent evidence) is primary for narrative fields, artifact > slug is the deterministic backstop, and `reservedFields` (financial fcv + structural) override last so they can never be displaced. **D5** every dollar figure traces to `unit-economics.json`; `financialSource` reserved unconditionally; the post-render coherence gate (ADR-098 D8 / 110) is untouched and still authoritative. **D7** the manifest records `field_provenance` tier counts, `agents_invoked` (ref+status), `source_agents_called` as `ref:status`, and an all-`_TBD_` row is recorded `skeleton` (not `emitted`) so it cannot inflate the emitted count. **D8** `AGENTICS_PHASE7_NO_AGENTS=1` bypasses dispatch; `NO_LLM`/`NO_RUFLO`/`noop`/`DISABLE_PHASE7` intact; per-row try→skeleton isolation preserved. The renderer is unchanged (determinism preserved). **Tests:** 39 new (`tests/unit/pipeline/phase7/{writer-agent,field-writer,field-mappers,coordinator-writer-merge}.test.ts`) + 1 benchmark (`tests/benchmark/adr-111-bench.test.ts`); full phase7 suite 66/66 green, typecheck + build clean. **Independent adversarial review (5 defects, all fixed):** all-`_TBD_`-counted-emitted (D7), misleading `'agent'` provenance → `'llm'`, `financialSource` reserve made real, money guard widened to the full reserved financial set with trailing-punctuation normalization, and the D2 precedence wording corrected below to match the implemented (differentiation-first) design.
**Date:** 2026-06-18
**Priority:** HIGH — Phase 7 is contractually required to emit the 85-document decision pack (ADR-098), but the field-population step that turns templates into real content is unimplemented. The Ruflo writer fan-out runs and its result is **discarded** (`void rufloResult` in `phase7/coordinator.ts`), so most of the 87 deliverables fall back to local extraction over a handful of shared artifacts and ship as `_TBD_` skeletons or near-duplicate prose. This ADR specifies the fix and explicitly rejects the "one Cloud SQL-wrapper Cloud Function per report" alternative.
**Builds on:** ADR-PIPELINE-098 (Phase 7 consulting deliverables — registry, templates, coherence invariants; this ADR fills its D5/D7 "writer-agent contract" follow-up, tagged there as *Q-future*), ADR-PIPELINE-109 (restore repo-backed agent execution — the `sourceAgents` on every deliverable row are now executable Tier-1 repo handlers), the per-agent sub-prompt wiring (`agents/<domain>/<agent>/<agent>.md` + `src/agents/agent-prompts.ts` — each agent already instructed to execute its repo code, review the use case, and review prior pipeline outputs), ADR-PIPELINE-105 (deliverable output guarantee + acceptance gate), ADR-PIPELINE-106 (exemplar-driven LLM-direct deliverable generation), ADR-PIPELINE-066 (`unit-economics.json` as the single financial source of truth), ADR-PIPELINE-110 (financial coherence hardening — the gate this ADR must not regress).

---

## Context

`src/pipeline/phase7/` renders the 87-row `DELIVERABLES_REGISTRY` (the "80+ executive reports") through ~32 `templateId` families using **deterministic placeholder substitution** (`template-renderer.ts`). The design (ADR-098) was: an LLM/Ruflo *writer* runs first and returns structured fields; the renderer then composes them into Markdown; a coherence gate (ADR-098 D8 / 105 / 110) validates financial consistency.

The writer half was never wired. Concretely, in `phase7/coordinator.ts`:

1. Each row dispatches `executeRufloPhaseSwarm(...)` — **but the return value is discarded**: `void rufloResult`, with an inline comment that "the writer-agent contract that returns structured fields per template is a follow-up (ADR-098 Q-future)."
2. `fieldsForRender` is built from `extractedFieldsCache` (local extraction over existing run artifacts — **primarily `executive-summary.md`**) plus `deriveSlugFields(slug)`. Across the 87 rows the top input artifacts are `unit-economics.json` (×38), `scenario.json` (×33), `roadmap.json` (×24) — a small shared pool, so most reports are drawn from the *same* inputs.
3. `renderTemplate` fills `{{placeholders}}`; anything unfilled becomes `_TBD_`.
4. An optional enrichment pass calls `synthesizeExecutiveDocument(...)` — **one generic exec-summary synthesizer reused for all 87 doc types** — gated on the local `claude` binary (ADR-110/Max-only).
5. On any gap → a skeleton file with frontmatter.

The `sourceAgents` array on each row (e.g. `roi-irr-npv-analysis` → `costops/roi`, `platform/risk-score`) is recorded for the attribution footer but **the agents are never invoked to produce the report**.

### Net effect (why this portion "doesn't work entirely")

- **Shallow / duplicate content.** 87 distinct consulting documents are populated from ~5 shared artifacts and one generic synthesizer. A Risk Register, a Monte Carlo simulation, and a Vendor Scorecard cannot be distinguished by content because nothing report-type-specific produces their fields.
- **Skeletons / `_TBD_`.** Placeholders the shared extraction can't fill stay unfilled.
- **Unused capability.** As of ADR-109 the 109 platform agents run their real repo handlers; each carries a hand-authored sub-prompt. The deliverables registry already names which agents source which report — that linkage is dead.

### The data-source reality (relevant to the rejected alternative)

The reports' inputs are the **per-run artifact tree** (`<runDir>/...json|md`), not rows in a shared database. A repo grep finds **no Cloud SQL / Postgres / MySQL warehouse** backing deliverables; the only SQL in the system is the unrelated `connector-hub/database-query` agent and local SQLite for cost projections. A "SQL-wrapper Cloud Function per report" therefore has nothing meaningful to query for the documents it would render.

## Decision

Eight rules. D1–D2 define the writer-agent field contract and merge point. D3–D4 source fields from the repo-backed agents and collapse synthesis to template families. D5 preserves coherence. D6 records the rejected per-report Cloud Function design and the bounded cloud option that is permitted. D7–D8 cover observability and failure semantics. **None of this is implemented by this ADR.**

### D1. Define the writer-agent field contract

A Phase 7 writer MUST return a structured field map for a deliverable:

```
WriterResult = {
  slug: string,                       // deliverable slug
  templateId: string,                 // template family
  fields: Record<string, string>,     // placeholder key → rendered value
  field_provenance: Record<string, 'agent' | 'artifact' | 'slug' | 'llm'>,
  unfilled: string[],                 // placeholders the writer could not fill
  fcv_figures?: Array<{ key: string; kind: string; scope: string; src: string }>
}
```

The keys in `fields` MUST be drawn from `extractPlaceholders(templateBody)` (already exported by `template-renderer.ts`) — the writer is told *exactly* which fields the template needs and returns those. The renderer (`renderTemplate` / `injectStandardSections`) stays **byte-deterministic and unchanged**: given the same `fields`, output is identical across runs/machines (the ADR-098 D8 / D4 determinism contract is preserved).

### D2. Merge writer fields at the existing `void rufloResult` site — with a defined precedence

`coordinator.ts` MUST consume `WriterResult.fields` where it currently discards `rufloResult`. The merged `fieldsForRender` resolves each placeholder by precedence, highest first:

1. **reserved (financial + structural)** — `fcvBlock`, `title`, `date`, `consensusBanner`, `agentAttributionFooter`, `financialSource`, and the per-kind fcv values (`investmentFcv`/`savingsFcv`/`measuredSavingsFcv`/`paybackFcv`/`npvFcv`/`roiFcv`) derived from `unit-economics.json`. These are **locked**: excluded from the writer's fillable set and re-applied last in the merge (`{...writer.fields, ...reservedFields}`), so no agent/LLM output can ever displace a dollar figure or the coherence banner (D5).
2. **family LLM, grounded on agents** — for narrative placeholders the family-scoped writer (D4), grounded on the row's `sourceAgents` evidence (D3), is the **primary** source. This is the decision that *differentiates* the 87 reports: deferring to the generic artifact extraction here would copy the same `executive-summary.md`-derived `recommendation`/`keyFindings` into every document — the exact duplication this ADR exists to remove. (Provenance tier `llm`; agent involvement recorded separately in `agents_invoked`.)
3. **artifact** — local extraction from the row's `inputArtifacts` (`extractedFieldsCache`); deterministic backstop for any fillable placeholder the writer did not produce.
4. **slug** — `deriveSlugFields(slug)` deterministic metadata; backstop after artifact.
5. **`_TBD_`** — last resort, recorded in the manifest.

**Rationale for LLM-primary (revised from the original draft, which listed artifact above llm):** implementation showed that an artifact-primary order reperpetuates the cross-report duplication the ADR targets, because the shared narrative placeholders are populated identically from `executive-summary.md`. The family LLM, grounded on the row's own `sourceAgents`, is what makes each document report-type-specific. Determinism and coherence are preserved by other means: financials are locked (rule 1), and when the LLM is off or unavailable (`AGENTICS_PHASE7_NO_LLM=1`, `dispatchMode='noop'`, or no `claude` binary) the merge degrades cleanly to the deterministic artifact > slug backstop — i.e. the prior behaviour. Per-field provenance is recorded (D7).

### D3. Source report fields from the row's `sourceAgents` (repo-backed, ADR-109)

For each deliverable, Phase 7 MUST invoke that row's `sourceAgents` through the existing repo-backed dispatch (`executeAgentsInvokeCommand` → Tier-1 repo handler / Tier-2 Cloud Run; lazy-imported so the pipeline never load-cycles with `commands/agents.ts`), passing the run use case. Because of the per-agent sub-prompt wiring, each agent already (a) executes its real repo code, (b) reviews the use case, and (c) reviews prior pipeline outputs — exactly the inputs a report writer needs. The agents return their domain-specific structured JSON (their existing output contracts), which is fed as **grounding evidence** to the family field-writer (D4) — agent JSON keys rarely match placeholder names, so the writer composes the evidence into the template's fields rather than projecting it 1:1. Agent results MUST be cached per run (a shared `AgentOutputCache` keyed by `domain/agent`) so a report shared by several rows does not re-invoke the same agent; the benchmark confirms each unique agent is dispatched at most once per run.

### D4. Synthesize by template family (33), never one engine per report

The writer/field-mapper layer is organized by `templateId` — **exactly one `FamilySpec` per distinct registry templateId (33 families**: `executive-summary`, `financial-model`, `risk-register`, `transformation-blueprint`, `performance-dashboard`, `research-report`, …), with a `GENERIC_FAMILY_SPEC` fallback for any future templateId — NOT per slug. Each `FamilySpec` carries (a) a one-paragraph `focus` describing what that document type must deliver and (b) the `emphasizeAgents` whose output is most relevant; the family field-writer builds a single focused, JSON-returning prompt from these plus the agent evidence and the canonical figures. This bounds the new reasoning surface at 33 units reused across all 87 rows, matching ADR-098 D4's "~25 templates cover all docs" principle. The generic `synthesizeExecutiveDocument` reuse is replaced by this family-scoped writer.

### D5. Coherence is non-negotiable and stays centralized

All four ADR-098 invariants survive unchanged: single financial source (`unit-economics.json`, ADR-066/110), single consensus banner, single `fcv` provenance scheme, single agent-attribution footer. Agents and LLM enrichment MAY supply qualitative/structural fields but MUST NOT originate dollar figures — every monetary placeholder is a derived view of `unit-economics.json`. The post-render coherence gate (ADR-098 D8 / 105 / 110, `AGENTICS_FCV_GATE`) remains authoritative and runs after the merge. This is the structural reason field derivation must be centralized rather than scattered across independent per-report renderers (see D6).

### D6. Rejected: one Cloud SQL-wrapper Cloud Function per report. Permitted: a single consolidated cloud service

Deploying ~87 per-report Cloud Functions is **rejected**:

- **No data to wrap.** Report inputs are the per-run artifact tree, not a Cloud SQL warehouse (see Context). A SQL wrapper has nothing to query for the documents.
- **Coherence regression.** 87 functions each computing their own numbers re-introduces the divergence the coherence gate (D5) exists to prevent.
- **Surface/cost.** 87 deploy/auth/version/cold-start/monitoring footprints to serve ~32 template families is large duplication for what is text synthesis over local artifacts.

What IS permitted, if a cloud-side option is wanted (e.g. to offload synthesis from the client or centralize against a real warehouse):

- **At most ONE** "deliverables-synthesis" service (or ~32 family endpoints), taking `(templateId, run-artifact handles)` → field map — never one-per-report.
- **At most ONE** Cloud SQL-backed **reference-data** service for genuine cross-run/enterprise data (sector baselines, historical ROI, benchmarks), consumed by reports as **shared read-only context**, not as per-report renderers.
- Per-report functions are reserved for the rare deliverable that genuinely needs isolated, heavy, DB-backed access — expected to be a handful, not 87.

### D7. Observability — record where every field came from

`phase7-manifest.json` MUST, per row, record: `field_provenance` counts (`agent`/`artifact`/`slug`/`llm`/`tbd`), `unfilled_fields`, and `source_agents_called` reflecting **agents actually invoked and their status** (not merely the registry's static list). The acceptance gate (ADR-105) SHOULD treat a row that is all-`_TBD_`/skeleton as not-emitted, and the phase status (`completed`/`partial`) reflects the real emitted count.

### D8. Failure semantics — per-row isolation, graceful degradation

Each row's agent dispatch is isolated: a `sourceAgents` failure falls through to artifact extraction → family LLM enrichment → skeleton, and never poisons a sibling (preserves the current per-row try/skeleton behavior). The escape hatches stay: `AGENTICS_PHASE7_NO_LLM=1`, `dispatchMode='noop'`, `AGENTICS_DISABLE_PHASE7=1`. A new `AGENTICS_PHASE7_NO_AGENTS=1` SHOULD bypass D3 (artifact + LLM only) for fast/offline runs.

## Consequences

**Positive**
- The 87 reports become real, differentiated documents sourced from the agents the registry already names — closing the ADR-098 Q-future gap with no new per-report infrastructure.
- Reuses ADR-109 repo-backed execution + the per-agent sub-prompts already in place; the dead `sourceAgents` linkage becomes load-bearing.
- Coherence is preserved by construction (centralized financial derivation + unchanged gate).
- New reasoning surface bounded at ~32 template families.

**Negative / costs**
- Wall-clock increases: up to `sourceAgents` invocations per row (mitigated by per-run agent caching and family grouping; ADR-098 already accepts that Phase 7 runtime is not a constraint).
- A per-`templateId` field-mapper (~32) must be authored and maintained — real work, but bounded and the correct altitude.
- LLM/agent variance in qualitative fields; mitigated by determinism of the renderer and the coherence gate on financials.

**Neutral**
- The deterministic renderer, the registry, and the templates are unchanged. The change is concentrated at the writer→fields boundary in `coordinator.ts` plus the new family field-mappers.

## Alternatives considered

1. **One Cloud SQL-wrapper Cloud Function per report (the prompt's proposal).** Rejected — D6. Wrong data model (no warehouse behind the docs), coherence regression, 87× ops surface for ~32 template families.
2. **Do nothing / rely on generic LLM enrichment only.** Rejected — produces near-duplicate prose and skeletons; the documents are not differentiated and the registry's `sourceAgents` stay unused.
3. **One writer per slug (87 in-process writers).** Rejected — same duplication as D6 without the deploy cost; collapses to D4's ~32 families anyway.
4. **Family endpoints as cloud services now.** Deferred — permitted by D6 but only if there is a reason to leave the client (offload synthesis, or a real reference warehouse). Start in-process (D1–D4); promote to a single consolidated service later if warranted.

## Implementation locations (for the future implementing ADR — not changed here)

- `src/pipeline/phase7/coordinator.ts` — replace `void rufloResult` with the D1/D2 merge; add the D3 `sourceAgents` dispatch + per-run cache; route D4 enrichment by `templateId`.
- `src/pipeline/phase7/` (new) — per-`templateId` field-mapper module (agent-JSON → placeholders) and family enrichment prompts.
- `src/pipeline/phase7/template-renderer.ts` — unchanged (already exports `extractPlaceholders` / `unfilledFields`).
- `src/agents/agent-prompts.ts` + `src/commands/agents.ts` — reuse as-is for D3 dispatch (no change required).
- `phase7-manifest.json` writer — extend per-row records per D7.
- Tests: `tests/unit/pipeline/phase7/` — writer-contract merge, family field-mapper, provenance recording, coherence-gate-still-green, `NO_AGENTS` escape hatch.

## Test plan (for the implementing ADR)

- Unit: D1 contract validation; D2 precedence (agent > artifact > slug > llm > TBD; financial fields exempt); D4 mapper per family; D7 manifest provenance.
- Integration: a run where `sourceAgents` populate fields end-to-end; a run with agents disabled (`AGENTICS_PHASE7_NO_AGENTS=1`) degrading to artifact+LLM; coherence gate (ADR-110) stays green (no new `$$`, financials trace to `unit-economics.json`).
- Acceptance (ADR-105): emitted-vs-skeleton count improves materially over the current baseline; no all-`_TBD_` row counts as emitted.
