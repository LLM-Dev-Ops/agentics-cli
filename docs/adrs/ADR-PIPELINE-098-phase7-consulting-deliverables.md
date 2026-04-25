# ADR-PIPELINE-098: Phase 7 — Consulting Deliverables (85-Document Enterprise Decision Pack)

**Status:** Accepted — Implemented (2026-04-25)
**Implementation summary:** Phase 7 lands as 5 new modules + a 5-row edit to `auto-chain.ts`. Registry contains **87 rows** (the spec's 85 headline docs + two cross-section bullets — "Internal Diagnostic Assessment" §7 and "Transformation Blueprint" §8 — that need their own canonical-section row to pass the spec-vs-registry sync test in D9.b). 31 distinct templateIds reference 31 of the 63 templates the template author wrote (the surplus 32 templates remain on disk as more-specific options for follow-up registry refinement). 19 unit tests + 5 benchmark tests pass. Typecheck clean. The single skipped test (`coordinator.test.ts:T1` happy-path) needs a Ruflo-dispatch DI hook before it can run without a live Ruflo daemon — tracked as a follow-up. Default-on; opt-out via `AGENTICS_DISABLE_PHASE7=1`. See "Implementation locations" at the bottom of this ADR for file-level pointers.
**Date:** 2026-04-25
**Priority:** HIGH — `docs/consulting_doc_deliverables.md` defines the 85-document deliverable spec the pipeline is contractually required to satisfy. The current pipeline emits ~12 of the 85 documents (executive-summary, decision-memo, financial-analysis, risk-assessment, roadmap, scenario, security-assessment, integration-assessment, agent-fleet-report, consensus, manifest, unit-economics) plus ADR/DDD/SPARC/prompt artifacts in the Phase 2–5 subdirs. The remaining ~70 documents (Board Deck, Investment Thesis, Business Case Base/Best/Worst, TCO, TOM, Architecture Blueprint, RACI, Risk Register, Program Charter, KPI/OKR, Monte Carlo, Stress Tests, Executive Narrative, …) are not produced. Without this phase the pipeline cannot satisfy the deliverable contract.
**Builds on:** ADR-PIPELINE-096 (fleet-wide dispatch + ruvector lineage + agent-driven docs — Phase 7 consumes the 109-agent `agent-responses.json` and the `unit-economics.json` it standardised), ADR-PIPELINE-094 (always-emit phase-result entries — Phase 7 inherits the same trace contract), ADR-PIPELINE-091 (Ruflo as primary engineering executor — Phase 7 dispatches generation through Ruflo), ADR-PIPELINE-066 (unit-economics manifest as the single financial source of truth).

## Context

`docs/consulting_doc_deliverables.md` enumerates 85 enterprise decision documents across 12 sections that the pipeline is required to produce for a complete consulting-grade decision pack. As of run `43178ee5-6b42-45d2-a20f-1ef80864c186` (manufacturing / NetSuite, full-fleet dispatch, 109 agents):

- Section 1 (Core Executive Decision — 9 docs): emits 2 (executive-summary, decision-memo). Missing: Board Deck, Strategic Options Assessment, Recommendation Paper, Business Case (Base/Best/Worst), Investment Thesis, Go/No-Go Decision Pack, Scenario Analysis & Sensitivity, Risk-Adjusted Decision Framework.
- Section 2 (Financial — 9): emits 2 (financial-analysis, unit-economics). Missing: 3–5yr Detailed Financial Model, IRR breakout, TCO, Value Capture Plan, Benefits Tracking Framework, Pricing Strategy, Cost Reduction / Optimization Plan.
- Section 3 (Strategy — 9): emits 1 (roadmap.json). Missing: Corporate / BU Strategy, Growth Strategy, Market Entry Strategy, Product / Platform Strategy, Digital Transformation Roadmap, Operating Model Design, Target State Architecture, Capability Maturity Assessment, Now/Next/Later Roadmap.
- Section 4 (Operating Model — 9): RACI is injected per-renderer but no standalone artifact. Missing: TOM, Org Structure & Role Definitions, RACI Matrix, Process Maps L2–L5, Service Delivery Model, Governance Model, KPI & OKR Framework, Vendor / Partner Strategy, Workforce & Talent Plan.
- Section 5 (Tech & Architecture — 9): emits 2 (integration-assessment, security-assessment). Missing: Tech Strategy, Architecture Blueprint (Current vs Target), System Landscape Diagram, Platform Selection Evaluation, Build vs Buy vs Partner, Data Strategy & Data Model, AI / Automation Strategy.
- Section 6 (Risk, Compliance, Governance — 8): emits 1 (risk-assessment). Missing: Risk Register, Risk Mitigation Plan, Regulatory Impact Assessment, Compliance Framework, Internal Controls Design, Cybersecurity Risk Assessment, Audit Readiness Pack, Ethical / Responsible AI Assessment.
- Section 7 (Research & Diagnostics — 9): emits 1 (phase2/research-dossier). Missing: Market Research Report, Customer Segmentation, VoC Analysis, Competitive Benchmarking (partly inlined in exec-summary, no standalone), Industry Landscape Scan, Trend & Disruption Analysis, Internal Diagnostic Assessment, SWOT, RCA.
- Section 8 (Program Management — 9): emits 0. Missing: Program Charter, Transformation Blueprint, PMO Framework, Milestone Plan, Dependency Mapping, Resource Plan, Budget Plan, Change Management Strategy, Communication Plan.
- Section 9 (Implementation — 8): emits 2 (phase4/adrs, phase5a/prompts). Missing: Implementation Roadmap, Initiative Backlog / WBS, Delivery Plan, Release Plan, Pilot / MVP Definition, Testing Strategy, Deployment Plan, Hypercare Plan.
- Section 10 (Performance & Monitoring — 6): emits 0. Missing: Performance Dashboard Design, KPI Tracking Model, Benefits Realization Tracker, Operational Scorecards, Continuous Improvement Framework, Post-Implementation Review.
- Section 11 (Commercial & Deal — 6): emits 0. Missing: RFP/RFQ/RFI Responses, Vendor Evaluation Scorecards, Contracting Strategy, Commercial Model Design, SLA / KPI Definitions, Negotiation Strategy.
- Section 12 (Advanced — 7): emits 1 (consensus.svg sensitivity proxy). Missing: Decision Trees & Decision Logic Models, Monte Carlo Simulation, Digital Twins, AI/ML Model Evaluation Reports, Experimentation Frameworks, Sensitivity & Stress Testing Models, Executive Narrative Documents.

The user directive that triggered this ADR is explicit: *"the way this MUST work is producing all of these documents (use ruflo to write them) they must be coherent with the rest of the project … delaying completion in terms of total time is not the issue, I just need the full pipeline to run."* No tier flag, no opt-in. Phase 7 emits all 85 documents on every run.

### Why a separate phase

The existing phases each have a different role: Phase 1 (simulation, fleet dispatch), Phase 2 (deep research), Phase 3 (SPARC + TDD), Phase 4 (ADRs + DDD), Phase 5 (Ruflo build), Phase 6 (ERP surface push). None of them owns the synthesis-into-consulting-grade-narrative step. Folding 70+ writer-tasks into Phase 5 conflates engineering build with deliverable writing and breaks ADR-091's contract that Phase 5 is the engineering executor. Folding into Phase 6 conflates ERP surfacing with consulting output. A new Phase 7 is the right boundary.

### Why ruflo

Per the user directive and ADR-091, Ruflo is the primary engineering / writing executor in this stack. Phase 7 generation is a fan-out of independent writer tasks (one per deliverable) — exactly the workload Ruflo is designed for. Each task is parameterised on (a) a template, (b) the run's input artifacts (Phase 1–6 outputs + 109-agent responses), and (c) the unit-economics manifest. Ruflo handles the dispatch, retries, and per-task isolation; this ADR owns the registry and the coherence rules.

### Coherence requirement

The user directive is also explicit on coherence: *"they must be coherent with the rest of the project."* Concretely this means:

1. **Single financial source.** Every dollar figure across all 85 documents traces back to `unit-economics.json` (per ADR-PIPELINE-066). No deliverable invents its own savings/investment/NPV/payback. Per-deliverable numbers are derived views (3yr vs 5yr vs base-case-only), never new origins.
2. **Single consensus banner.** Every deliverable carries the same agreement/precision/verdict header that exec-summary carries. If the run is DEGRADED, every doc says DEGRADED with the same `[reason]`.
3. **Single provenance scheme.** Every deliverable uses the same `<!-- fcv:kind=... scope=... doc=... src=... -->` tags introduced for the exec-summary, so a single grep across `<runDir>/deliverables/` can audit any figure to its origin.
4. **Single agent-attribution scheme.** Every deliverable lists its sourcing agents in a uniform footer (`Sources: domain/agent, domain/agent, … + N more`). When an agent returned a 4xx/5xx, the deliverable cites the failure (matching exec-summary's "Why we are not more confident" pattern).

These four invariants are what makes 85 docs *coherent* rather than *85 isolated mini-reports*.

## Decision

Nine rules. D1–D3 establish the phase contract; D4–D6 establish the registry and template model; D7–D9 establish failure / coherence / observability semantics.

### D1. New Phase 7 — runs unconditionally after Phase 6

`auto-chain.ts` MUST emit a Phase 7 block after the Phase 6 block. Phase 7 runs whether Phase 6 succeeded, failed, or was skipped-due-to-upstream. The only inputs Phase 7 strictly requires are the Phase 1 artifacts (`manifest.json`, `executive-summary.md`, `scenario.json`, `unit-economics.json`, `agent-responses.json`) — every realistic run has these per ADR-094. A Phase 1 failure that prevents these from existing is the only condition under which Phase 7 emits a `skipped-due-to-upstream` entry; in all other cases Phase 7 runs.

Phase 7 ALWAYS pushes a `chainResult.phases[]` entry, per ADR-094 D4. The entry carries `phase: 7, label: 'Consulting Deliverables', status: 'completed' | 'partial' | 'failed' | 'skipped-due-to-upstream'`, `deliverables_emitted: N`, `deliverables_failed: M`, `deliverables_total: 85`.

### D2. Output layout — 12 sectioned subdirectories under `deliverables/`

Phase 7 writes to `<runDir>/deliverables/`. The 12 subdirectories match the spec sections exactly and are zero-padded so they sort in spec order:

```
<runDir>/deliverables/
  01-executive/                  # 9 docs
  02-financial/                  # 9 docs
  03-strategy/                   # 9 docs
  04-operating-model/            # 9 docs
  05-technology/                 # 9 docs
  06-risk-compliance/            # 8 docs
  07-research-diagnostics/       # 9 docs
  08-program-management/         # 9 docs
  09-implementation/             # 8 docs
  10-performance-monitoring/     # 6 docs
  11-commercial/                 # 6 docs
  12-advanced/                   # 7 docs
  index.md                       # generated table of contents linking all 85 docs
  phase7-manifest.json           # machine-readable: per-doc status, source artifacts, fcv tags emitted, generation timing, failure detail
```

Pre-existing top-level docs (`executive-summary.md`, `decision-memo.md`, `financial-analysis.md`, `risk-assessment.json`, `roadmap.json`) are NOT moved. Phase 7 instead **mirrors** them into `01-executive/` / `02-financial/` / etc. via symlinks (or copies on filesystems that don't support symlinks) so `deliverables/` is self-contained without breaking the existing top-level paths consumers already depend on.

### D3. Single registry — `src/pipeline/phase7/deliverables-registry.ts`

The 85 documents are encoded in a single registry. One row per deliverable. The registry IS the spec — `consulting_doc_deliverables.md` is a human-readable view of it, kept in sync via a generator (D9.b).

```ts
export interface DeliverableSpec {
  readonly section: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12;
  readonly slug: string;                          // kebab-case, used as filename
  readonly title: string;                         // human title
  readonly format: 'md' | 'json' | 'csv' | 'svg';
  readonly inputArtifacts: ReadonlyArray<string>; // paths under <runDir>, missing inputs trigger fallback skeleton
  readonly sourceAgents: ReadonlyArray<string>;   // domain/agent identifiers expected to feed this doc
  readonly templateId: string;                    // points at deliverables-templates/<templateId>.tmpl.md
  readonly fcvKinds: ReadonlyArray<string>;       // fcv kinds this doc MUST emit (validated post-render)
  readonly mirrorsExisting?: string;              // if set, this entry symlinks to an existing top-level artifact
}
```

Example entries (full registry: 85 rows):

| section | slug | title | format | inputArtifacts | sourceAgents | templateId | fcvKinds | mirrors |
|---|---|---|---|---|---|---|---|---|
| 1 | executive-summary | Executive Summary | md | (mirror) | — | — | investment, savings, npv, roi, timeline | `executive-summary.md` |
| 1 | board-deck | Board Deck | md | exec-summary, scenario, consensus | platform/executive-summary, platform/decision-memo | `board-deck` | investment, savings, roi | — |
| 1 | business-case-base | Business Case — Base Case | md | unit-economics, financial-analysis | costops/forecast, costops/roi | `business-case-scenario` | investment, savings, npv, payback | — |
| 1 | business-case-best | Business Case — Best Case | md | unit-economics, financial-analysis, scenario | costops/forecast, costops/roi, simulator/what-if | `business-case-scenario` | investment, savings, npv, payback | — |
| 1 | business-case-worst | Business Case — Worst Case | md | unit-economics, risk-assessment | costops/forecast, costops/roi, platform/risk-score | `business-case-scenario` | investment, savings, npv, payback | — |
| 2 | financial-model-3to5yr | Detailed Financial Model (3–5 yr) | md+csv | unit-economics, scenario | costops/forecast, costops/attribution, costops/roi | `financial-model` | investment, savings, npv, roi | — |
| 2 | tco-analysis | Total Cost of Ownership | md | unit-economics, integration-assessment | costops/attribution, costops/forecast | `tco` | investment, savings | — |
| 4 | raci-matrix | RACI Matrix | md | scenario, manifest | copilot/decomposer | `raci` | — | — |
| 5 | architecture-blueprint | Architecture Blueprint (Current vs Target) | md | phase2/tech-stack.json, phase4/adrs, integration-assessment | system-architect, connector-hub/erp-surface | `architecture-blueprint` | — | — |
| 6 | risk-register | Risk Register | md+json | risk-assessment, scenario | platform/risk-score, sentinel/anomaly | `risk-register` | — | — |
| 12 | monte-carlo-simulation | Monte Carlo Simulation | md+json+svg | unit-economics, scenario | simulator/scenario, simulator/what-if | `monte-carlo` | savings, npv, roi | — |

The registry MUST contain 87 rows (85 spec headline docs + 2 cross-section coverage rows). A unit test enforces this length and enforces unique `(section, slug)` pairs.

### D4. Templates — `src/pipeline/phase7/deliverables-templates/`

Each `templateId` maps to a Markdown template with `{{handlebars-style}}` placeholders. Templates are reusable: `business-case-scenario` is one template parameterised on `case=base|best|worst`. Total template count is meaningfully smaller than 85 (~25 templates cover all 85 docs).

Every template MUST include:

- The standard consensus banner (auto-injected from `consensus.json`).
- The standard fcv-tagged figure block where applicable (auto-injected from `unit-economics.json`).
- The standard agent-attribution footer.
- A standard "Why we are not more confident" section where consensus is below 0.85 — copied from the exec-summary pattern so all 85 docs say the same thing about uncertainty.

Templates are pure-text + placeholder substitution; no LLM calls inside the template engine. The LLM call (when used) happens *before* template substitution — Ruflo invokes a writer agent with the input artifacts, the agent returns structured fields, and the template renders the fields. Template substitution is deterministic.

### D5. Ruflo executes the fan-out — one task per deliverable

Phase 7's executor builds a Ruflo task list (excluding mirror-entries) and dispatches it through the existing `executeRufloPhaseSwarm` path used by Phase 5. Each task gets:

- `description`: deliverable slug + section + title
- `inputs`: the file contents of every path in `inputArtifacts` (read once at task creation, passed by value)
- `template`: the template body
- `fcvSeed`: the rendered fcv block from `unit-economics.json`
- `consensusBanner`: the rendered banner from `consensus.json`

Ruflo returns a structured response per task. Phase 7's reducer writes the rendered Markdown to disk under `<runDir>/deliverables/<NN-section>/<slug>.<format>`.

Concurrency: Ruflo's existing topology config (`hierarchical`, `max-agents=8`, `specialized` strategy from Phase 5) is reused unchanged. Total wall time scales as `ceil(85 / 8) × per-task-time`. Per the user directive, runtime is not a constraint; the phase is allowed to take 15–30 minutes on a default run.

### D6. Pre-existing top-level artifacts mirror in, do not move

Phase 7 MUST NOT delete or relocate the top-level docs (`executive-summary.md`, `decision-memo.md`, `financial-analysis.md`, `risk-assessment.json`, `roadmap.json`, `security-assessment.md`, `integration-assessment.md`, `agent-fleet-report.md`, `consensus.json`, `consensus.svg`, `manifest.json`, `unit-economics.json`). These are consumed by ADR-PIPELINE-094 (path-reality), ADR-PIPELINE-066 (unit-economics loader), and the existing `[PLANS]` promotion step.

Phase 7 instead creates a symlink (or, on Windows, a copy) from `deliverables/<NN-section>/<slug>.<format>` to the original file. The registry's `mirrorsExisting` field marks these. Total mirror entries: 12 (the 12 pre-existing top-level docs that map into the spec).

### D7. Failure modes — never block, always emit a skeleton

When a deliverable's generation fails (Ruflo task error, missing input artifact, LLM unavailable, template render error), Phase 7 MUST still write a skeleton file at the target path. The skeleton:

- Carries frontmatter `degraded_mode: generation-failed` and `failure_reason: <short string>`.
- Lists the input artifacts that were available and the ones that were missing.
- Includes the consensus banner and the fcv-tagged figure block if `unit-economics.json` is present (so even a failed deliverable carries the run's headline financials).
- Emits the standard section title and a "GENERATION FAILED — review required" header so the failure is unmissable to a human reviewer.

Skeleton emission is what makes Phase 7's status `partial` rather than `failed`. `phase7-manifest.json` records every skeleton. Phase 7 is `failed` only when the Phase 1 inputs themselves are missing (which under ADR-094 is already a `skipped-due-to-upstream` condition).

### D8. Coherence gate — post-render financial validator

After Phase 7 finishes writing all 85 deliverables, a coherence gate runs:

- Greps every emitted file for `<!-- fcv:kind=... -->` blocks.
- For each `kind` (investment, savings, npv, roi, payback), extracts the dollar value or duration.
- Compares against the corresponding canonical value in `unit-economics.json`.
- Flags any deliverable whose value differs by more than ±5% (rounding tolerance) — recorded in `phase7-manifest.json` under `coherence_violations[]`.

A coherence violation is non-fatal but visible. The phase status drops from `completed` to `partial` when violations exist; the user sees the count in the Phase 7 summary line. This is the test that the user's coherence requirement actually holds at runtime, not just by template construction.

### D9. Observability — phase7-manifest.json and registry-vs-spec sync

a. **`phase7-manifest.json`** is written at the end of Phase 7 and contains:

```json
{
  "phase": 7,
  "trace_id": "<uuid>",
  "started_at": "<iso>",
  "completed_at": "<iso>",
  "total_timing_ms": <int>,
  "deliverables_total": 85,
  "deliverables_emitted": <int>,
  "deliverables_skeleton": <int>,
  "deliverables_failed": <int>,
  "coherence_violations": [{ "slug": "...", "kind": "savings", "expected": "...", "got": "...", "delta_pct": <float> }],
  "deliverables": [
    {
      "section": <1-12>,
      "slug": "...",
      "status": "emitted" | "skeleton" | "failed",
      "input_artifacts_used": [...],
      "input_artifacts_missing": [...],
      "source_agents_called": [...],
      "fcv_kinds_emitted": [...],
      "timing_ms": <int>,
      "output_path": "<runDir>/deliverables/01-executive/board-deck.md"
    },
    ... 84 more
  ]
}
```

b. **Registry-vs-spec sync test.** A unit test (`tests/unit/pipeline/phase7/registry-vs-spec.test.ts`) parses `docs/consulting_doc_deliverables.md`, extracts all `- ` bullet items under each `## N. ...` heading, and asserts a 1-to-1 mapping with the 85-row registry. Any drift between the human-readable spec and the registry is a test failure. This is the mechanism that keeps `consulting_doc_deliverables.md` and the registry in sync without manual coordination.

## Implementation locations

- `src/pipeline/phase7/deliverables-registry.ts` (new) — the 85-row registry.
- `src/pipeline/phase7/deliverables-templates/` (new) — template files (~25 templates, plain Markdown with placeholders).
- `src/pipeline/phase7/coordinator.ts` (new) — phase entry point, builds Ruflo task list, reduces results, writes manifest, runs coherence gate.
- `src/pipeline/phase7/coherence-gate.ts` (new) — fcv-tag scanner + unit-economics validator.
- `src/pipeline/phase7/template-renderer.ts` (new) — deterministic placeholder substitution + standard banner injection.
- `src/pipeline/auto-chain.ts` (edit) — add the Phase 7 block after Phase 6, mirroring the Phase 6 shape (always-emit phase-result entry, per ADR-094 D4).
- `src/pipeline/phase-dependency-gate.ts` (edit) — add `'phase7-deliverables'` to `PHASE_DEPENDENCIES`, with `required: phase1/manifest.json + phase1/unit-economics.json + phase1/agent-responses.json`. Per D1, anything else missing is a degraded-mode fallback, not a block.
- `tests/unit/pipeline/phase7/registry-vs-spec.test.ts` (new) — enforces 1-to-1 between the spec doc and the registry.
- `tests/unit/pipeline/phase7/coordinator.test.ts` (new) — exercises the registry walk, the skeleton-on-failure path, the mirror-symlink path, and the coherence gate.
- `tests/unit/pipeline/phase7/coherence-gate.test.ts` (new) — verifies that a deliverable with a value ±5% of unit-economics passes and a value off by 20% fails.

## Failure modes (explicit)

- **Phase 1 inputs missing.** Phase 7 emits `skipped-due-to-upstream` with `reason: 'phase1-inputs-missing'`. Per ADR-094 D4 the phase-result entry is still pushed.
- **Ruflo unavailable / cloud breaker tripped.** Phase 7 falls through to template-only rendering (no LLM enrichment). Every deliverable is a skeleton populated from input artifacts via deterministic substitution. Status: `partial`. Coherence gate still runs.
- **Template render error.** Single deliverable is a skeleton; phase continues. `phase7-manifest.deliverables[].status = 'failed'` for that row.
- **Coherence violation.** Non-fatal. Phase status `partial`. User sees `[Phase 7] N coherence violations — see phase7-manifest.json` in the summary.
- **Disk full / write error.** Phase 7 fails as a unit. `chainResult.phases[]` records `failed` with `error: <fs error>`. Per ADR-094 the trace stays visible.

## Test plan

1. **Registry shape (offline).** `registry.length === 85`, `unique((row.section, row.slug))`, every `templateId` resolves to a file, every `inputArtifacts` path is a string under one of the known phase prefixes, every `fcvKind` is in the canonical fcv-kind set.
2. **Spec sync.** `consulting_doc_deliverables.md` parsed bullets === registry titles per section.
3. **Coordinator happy path.** Synthetic runDir with all expected inputs → 85 deliverables emitted, 0 skeletons, 0 violations, manifest written.
4. **Coordinator skeleton path.** Synthetic runDir missing `agent-responses.json` → all deliverables that depend on it emit skeletons; the rest emit normally.
5. **Coordinator mirror path.** Synthetic runDir with pre-existing top-level docs → mirror entries resolve to symlinks (or copies); reading through the mirror returns identical content.
6. **Coherence gate.** Deliverable with `<!-- fcv:kind=savings -->` value off by 20% from `unit-economics.json` → flagged in `coherence_violations`. Same value within ±5% → not flagged.
7. **Phase-result entry on Phase 1 failure.** Synthetic runDir missing `manifest.json` → Phase 7 emits a `skipped-due-to-upstream` entry, no deliverables on disk, no exception thrown.
8. **End-to-end smoke.** Re-run a known fixture brief with Phase 7 enabled → 85 files exist under `deliverables/`, manifest is valid JSON, coherence violations < 5.

## Open questions

- **Q1.** Should the spec doc (`consulting_doc_deliverables.md`) become *generated from* the registry rather than the other way around? D9.b currently makes the registry the source of truth and treats the spec as a view; an inversion (spec is canonical, registry is built from it at startup) is also workable. Picking the registry-as-truth direction in this ADR because the registry needs richer metadata (templateId, inputArtifacts, fcvKinds) than a bullet list can carry.
- **Q2.** Should mirror entries be symlinks or copies? Symlinks are cheaper and keep one source of truth on disk; copies are more portable for archival and cross-host transfer. Default chosen: symlinks on POSIX, copies on Windows. Override via `AGENTICS_PHASE7_MIRROR=copy|symlink`.
- **Q3.** Coherence-gate tolerance. Default ±5%. The exec-summary shows ranges like "$22.1M – $30.9M" so a deliverable rendering "$25M" is within tolerance. If the headline figure is itself a range, the gate compares to the midpoint. Open: should the tolerance be tighter for `payback` (months) than for `npv` (multi-million)?
- **Q4.** Should Phase 7 be runnable standalone (`agentics phase7 <runDir>`) for re-rendering deliverables after a registry change without re-running Phases 1–6? Likely yes — same shape as `agentics phase6` today. Out of scope for this ADR; tracked as a follow-up.

## Related ADRs

- ADR-PIPELINE-066 — Unit-economics manifest as the single financial source of truth. Phase 7's coherence gate is built on this.
- ADR-PIPELINE-091 — Ruflo is the primary engineering executor. Phase 7 uses the same execution path.
- ADR-PIPELINE-094 — Always-emit phase-result entries on upstream failure. Phase 7 inherits the contract.
- ADR-PIPELINE-096 — Fleet-wide dispatch + agent-driven docs. Phase 7's registry is the next step on the same trajectory: the 109-agent fleet feeds 85 documents, not 12.
