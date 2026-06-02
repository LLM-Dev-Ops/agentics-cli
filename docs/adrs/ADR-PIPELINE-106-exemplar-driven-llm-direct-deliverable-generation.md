# ADR-PIPELINE-106: Exemplar-Driven, LLM-Direct Deliverable Generation

**Status:** Proposed
**Date:** 2026-06-02
**Priority:** CRITICAL — This is the generator that must satisfy the acceptance gate of ADR-PIPELINE-105. The repeated user rejection of Phase 7 output ("canned garbage", ADR-PIPELINE-100) has one root cause: the deliverable templates are the *ceiling* on quality, and the LLM enrichment is a fragile, silently-skippable *option*. To produce ~80 McKinsey/Accenture-grade documents, generation must invert that — the LLM is primary and the bar is a worked exemplar, exactly as ADR-PIPELINE-100 did for ADRs.
**Builds on:** ADR-PIPELINE-100 (exemplar + LLM-direct for ADRs — this ADR generalises the same model from ADRs to all ~25 deliverable families and explains *why* the template path is a floor not a ceiling), ADR-PIPELINE-098 (Phase 7 registry, templates, Ruflo dispatch, 4 coherence invariants — this ADR changes what Ruflo's writer tasks consume), ADR-PIPELINE-040 (two-pass template+LLM synthesis for executive docs — this ADR supersedes the "skeleton-then-rewrite" pattern with "exemplar-then-generate" for the full pack), ADR-PIPELINE-091 (Ruflo as primary executor), ADR-PIPELINE-066 (unit-economics single financial source).
**Companion:** ADR-PIPELINE-105 (Deliverable Output Guarantee) is the gate this generator feeds. Read 105 for the pass/fail contract; this ADR is how documents clear it.

---

## Context

ADR-PIPELINE-100 diagnosed the ADR-quality defect precisely and the same diagnosis applies verbatim to deliverables:

> "The JSON schema is the ceiling." A five-field template can only ever produce a five-field document; the good exemplar has ~20 structural elements.

Phase 7 deliverables are generated from `src/pipeline/phase7/deliverables-templates/*.tmpl.md` — ~25 families of `{{handlebars}}` templates (ADR-098 D4). The path is:

1. Load template → 2. Fill placeholders from run artifacts → 3. *(optionally)* LLM-enrich (ADR-040 two-pass) → 4. write.

Two structural problems:

- **The template is the quality ceiling.** Placeholder-filling rearranges existing fragments; it cannot produce a *Pyramid-Principle Investment Thesis* or a *Monte Carlo write-up with a real distribution narrative*. A McKinsey deliverable takes raw data, applies domain judgment, and produces novel narrative — the template engine has no judgment.
- **The LLM pass is optional and silently skippable.** When the `claude --print` call times out (the exact trace in ADR-100: 120s buffered call, fell through to skeleton), the run keeps the bare template and reports success. ADR-104 made the fallback *visible*; ADR-105 makes it *fail the gate*; this ADR makes it *rare* by making LLM-direct generation the primary path with a real quality target.

The fix that worked for ADRs (ADR-100): give the generator a **worked exemplar** ("here is a great one, in a different domain, match its structure and depth") and generate **directly** with the LLM, using the template only as a structural hint, not a fill-in form. This ADR applies that to all deliverable families.

---

## Decision

Seven rules. D1–D2 establish the exemplar model; D3–D4 the generation contract; D5 dispatch; D6 coherence-by-construction; D7 fallback.

### D1. One worked exemplar per template family

For each of the ~25 template families (ADR-098 D4), add a worked, full-length exemplar under `docs/templates/deliverables/<family>.example.md` — the deliverable analogue of `docs/templates/ADR-Good-Example.md`. Each exemplar:
- Is a *real, complete* document (an Investment Thesis, a TCO model, a Risk Register…), not a skeleton.
- Is drawn from a domain **deliberately different** from any test prompt, to make the point — as ADR-100 did with vector-DB and drug-discovery exemplars — that the bar is **structural and analytical**, not subject-matter copying.
- Carries the structural elements the ADR-105 quality scorer measures (headed sections, data tables, a decision/recommendation block, a sources footer, grounded figures).

These exemplars are the canonical quality bar. ADR-105's structural-coverage signal (D3) is computed against them.

### D2. The template becomes a structural hint, not the content ceiling

`*.tmpl.md` files are retained but demoted: they define the *required section skeleton and the fcv/coherence scaffolding* (D6), not the prose. The generator is explicitly instructed that the template is a minimum structure to satisfy and the exemplar is the depth/quality to reach — never to emit the template's placeholder text as content.

### D3. Generation is LLM-direct, exemplar-anchored (Claude Code Max)

Each deliverable is produced by a single LLM-direct generation (matching ADR-100's Phase-4 model and ADR-098's Ruflo dispatch), prompted with:

```
SYSTEM: You are a senior partner at McKinsey/Accenture writing a board-ready
        {{deliverable.title}}. Match the structure and analytical depth of the
        EXEMPLAR. Use ONLY the RUN DATA for facts and figures. Do not emit
        template placeholder text.

EXEMPLAR (the quality bar — different domain, do not copy its subject):
  {{exemplar}}

REQUIRED STRUCTURE (minimum sections + coherence scaffolding):
  {{template}}

RUN DATA (the only source of facts):
  - unit-economics.json           (the single financial source — ADR-066)
  - agent-responses.json          (109-agent fleet output)
  - phase1..6 artifacts relevant to this deliverable (registry.inputArtifacts)
  - consensus banner + run verdict (must appear verbatim)

RULES:
  - Lead with the recommendation/decision (Pyramid Principle).
  - Every dollar figure traces to unit-economics.json via an fcv tag (D6).
  - Name concrete roles, systems, dates, agents — never "the team"/"the system".
  - No forbidden spin phrases; no sentence fragments; no prompt echo;
    no {{placeholders}}; no generic benchmarks.
```

Tier model (consistent with ADR-040/100): Tier 1 Claude Code Max via `--print`; Tier 2 Anthropic API direct. There is **no Tier-3 "template-only as a normal output"** — see D7.

### D4. Anti-canned is a generation requirement, not just a gate check

The generator is bound to the same anti-canned rules the ADR-105 gate measures: forbidden-spin-phrase avoidance (`src/synthesis/forbidden-spin-phrases.ts`), zero placeholder residue, and concrete run-data grounding. Generating *to* the gate's rubric (rather than discovering failures only at the gate) is what raises pass rate. The gate (105) remains the independent backstop.

### D5. Ruflo fan-out, one task per deliverable

Unchanged dispatch model from ADR-091/098: Phase 7 fans out one Ruflo writer task per registry row. This ADR changes only each task's *payload* — it now carries `{template, exemplar, registryRow, resolvedInputArtifacts}` instead of `{template, resolvedInputArtifacts}`. Per-task isolation, retries, and concurrency are Ruflo's, as before. "Delaying completion in terms of total time is not the issue" (user directive, ADR-098) — exemplar-anchored generation is slower per doc and that is accepted.

### D6. Coherence by construction, verified by the gate

The four ADR-098 invariants are injected into every generation, not bolted on after:
1. **Single financial source** — `unit-economics.json` is the only numeric input; the prompt forbids inventing figures; each figure is emitted with an `<!-- fcv:kind=... scope=... doc=... src=... -->` tag.
2. **Single consensus banner** — the run's agreement/precision/verdict header is passed in and must appear verbatim; DEGRADED runs propagate `DEGRADED [reason]` to every doc.
3. **Single provenance scheme** — the fcv tag format above, greppable across `deliverables/`.
4. **Single agent-attribution footer** — `Sources: domain/agent, … + N more`, citing 4xx/5xx agent failures where relevant.

ADR-105 D7 verifies these per document. Generating them in (here) and checking them (there) is deliberate separation of concerns.

### D7. No silent template fallback — a failed generation is a visible FAIL

If both LLM tiers fail for a deliverable, the writer task:
- emits the bare template skeleton **only so the file is non-empty**, and
- marks it `cannedFallback: true` in `phase7-manifest.json`.

Per ADR-105 D4 that is a gate `FAIL`, surfaced in the scorecard and capping run status if it lands in the executive section. The skeleton is a tombstone, never a delivered document. This closes the ADR-100 trace where a timeout silently produced "canned garbage" reported as success.

---

## Consequences

### Positive
- Deliverables can finally exceed their template — novel, judgment-bearing narrative at McKinsey/Accenture depth, because the exemplar (not the form) is the bar.
- One root-cause fix for the whole pack: the same inversion that fixed ADRs (ADR-100) now covers all ~25 families.
- Coherence-by-construction raises the ADR-105 pass rate instead of fighting the gate after the fact.

### Negative / Risks
- Authoring ~25 high-quality exemplars is real up-front work (the same cost ADR-100 paid for ADRs — and it paid off there).
- Per-doc latency rises substantially (~80 LLM-direct generations). Accepted per user directive; Ruflo concurrency (D5) bounds wall-clock.
- LLM output still varies; the exemplar + template scaffolding + ADR-105 gate are the three guardrails against drift.

### Neutral
- The registry (ADR-098 D3) is unchanged; only the writer-task payload and the template's *role* change.

---

## Alternatives Considered

1. **Keep ADR-040 two-pass (template → LLM rewrite).** Rejected as primary: rewriting a skeleton anchors the model to the skeleton's shallowness; ADR-100 already found exemplar-anchored *generation* beats skeleton *rewriting* for ADRs. Same applies here.
2. **One mega-prompt that writes all 80 docs in one call.** Rejected: blows context, no per-doc isolation/retry, and one failure poisons the pack. Per-doc fan-out (D5) is the right granularity.
3. **No exemplars; just a stronger instruction.** Rejected: ADR-100's entire finding is that a worked exemplar, not exhortation, is what moves quality. Prose instructions without a concrete bar regress to canned output.
4. **Drop low-value deliverables to hit quality faster.** Rejected: the 85-document contract is a user requirement (ADR-098); the answer is to generate them well, not to cut the pack.

---

## Implementation (not yet built — ADR is Proposed)

- `docs/templates/deliverables/*.example.md` — new: ~25 worked exemplars (D1), one per template family.
- `src/pipeline/phase7/template-renderer.ts` — demote template to structural hint; build the exemplar-anchored prompt (D2–D3).
- `src/pipeline/phase7/coordinator.ts` — load the family exemplar per registry row; extend the Ruflo writer-task payload (D5).
- `src/pipeline/phase7/deliverables-registry.ts` — (no row changes) confirm each `templateId` maps to an exemplar; add a test asserting every family has an exemplar.
- `src/synthesis/forbidden-spin-phrases.ts` — reused by the generation prompt (D4).
- Coherence scaffolding (fcv tags, consensus banner, sources footer) injected at generation (D6), verified by ADR-105 D7.
- Tests: every `templateId` has a `*.example.md` (D1); writer-task payload carries exemplar + registry row (D5); failed-tier path sets `cannedFallback` and never emits placeholder text as content (D7).
