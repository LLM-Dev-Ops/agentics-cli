# ADR-PIPELINE-073: Authoritative fcv HTML Tags Preserved Through LLM Synthesis

**Status:** Accepted
**Date:** 2026-04-12
**Priority:** CRITICAL — FCR-003 is silently missed on LLM-synthesized documents
**Originating Review:** Ramco Aviation Catering Readiness Review (2026-04-12), Executive Output 5/10
**Builds on:** ADR-PIPELINE-067 (Cross-Document Consistency), ADR-PIPELINE-040 (LLM Executive Synthesis)

## Context

ADR-PIPELINE-067 introduced FCR-001..009 to catch cross-document financial contradictions. The OPERA review (2026-04-11) confirmed FCR-003 caught the exact contradiction it was designed for: a range labeled `pilot` in one document and `full-program` in another.

**The Ramco review surfaced the identical class of defect — and FCR-003 missed it.** The executive summary's recommendation line said:

> "Authorize a 12-week scoped pilot at $2.1M–$3.1M"

while the decision memo said:

> "$630K–$945K pilot / $2.1M–$3.1M full deployment"

Two different documents, same range, different scope labels. FCR-003 should have fired. It didn't.

### Why FCR-003 Missed It

The extractor in `src/synthesis/financial-claim-extractor.ts` uses `detectScopeNearIndex(line, matchStart, matchEnd)` to scan a ±60-char window around each money match for scope words. That works when the renderer emits predictable scope-adjacent prose.

But **ADR-PIPELINE-040 introduced an LLM synthesis pass** that rewrites the skeleton exec summary / decision memo / financial analysis into "consulting-grade" prose. The LLM rewrite moves words around, changes phrasing, and occasionally drops scope words entirely. The Ramco case: the LLM-rewritten exec summary put `12-week scoped pilot at $2.1M–$3.1M` on one line where the word `pilot` is 20 characters from the range — technically within the 60-char window, so the extractor tags it correctly. But the LLM-rewritten decision memo had `$2.1M–$3.1M full deployment` on one line AND a different line with `The pilot (Phase 1) targets $630K–$945K`. The extractor happily tagged the $630K range as `pilot` and the $2.1M range as `full-program` — giving it the correct labels *within the decision memo*.

**FCR-003 fired on the wrong pair**: it compared the exec summary's `pilot: $2.1M–$3.1M` against the decision memo's `pilot: $630K–$945K`. Same scope, but the ranges don't overlap → FCR-001 (not FCR-003) was the rule that should have fired. But FCR-001 requires the ranges to be tagged with the same kind; the $2.1M range in the exec summary was inferred as `investment` (from "scoped pilot at") while the $630K in the decision memo was tagged `investment`. So FCR-001 *should* have fired for non-overlapping pilot investment ranges across documents.

Investigation revealed FCR-001 also missed it, because `canonicalScope` maps `phase-1` → `pilot` but the decision memo's `$630K–$945K` was tagged `pilot` while the exec summary's `$2.1M–$3.1M` was tagged `pilot` — so they were in the same bucket, and the ranges didn't overlap, so FCR-001 should have flagged it. Something in the ordering / byDoc grouping silently dropped the pair, most likely because the decision memo's `$2.1M–$3.1M full deployment` was ALSO pulled in and the widest-range aggregation `Math.min(...lows)` / `Math.max(...highs)` collapsed them into `[$630K, $4.1M]` — which *does* overlap with the exec summary's `[$2.1M, $3.1M]`.

**Root cause:** proximity-based scope detection is fundamentally unreliable after an LLM rewrite. The fix is to stop relying on proximity entirely — have the renderer emit authoritative HTML-comment tags that survive the LLM pass, and have the LLM synthesis prompt explicitly preserve them.

## Decision

### 1. Renderers Emit fcv Tags on Every Money Figure

Every money figure in `renderExecutiveSummary`, `renderDecisionMemo`, `renderFinancialAnalysis`, and `buildRoadmapArtifact` must be preceded by an authoritative HTML comment:

```markdown
<!-- fcv:kind=investment scope=pilot doc=executive-summary -->
Authorize a 12-week scoped pilot at **$2.1M–$3.1M**.

<!-- fcv:kind=investment scope=full-program doc=decision-memo -->
Full deployment across all hubs: **$2.1M–$3.1M**.
```

The `doc=` field is new — it lets the consistency runner cross-check that every tag lands in the right document (a safety net against copy-paste contamination during LLM rewrites).

New helper in `src/synthesis/simulation-renderers.ts`:

```typescript
function fcvTag(
  kind: FinancialClaimKind,
  scope: FinancialClaimScope,
  docKind: FinancialClaimDocument,
): string {
  return `<!-- fcv:kind=${kind} scope=${scope} doc=${docKind} -->`;
}
```

Renderer call sites are refactored to emit `fcvTag(...)` immediately before each money-bearing line. Approximately 40 call sites across the four rendering functions.

### 2. Extractor Prefers Tags Over Proximity (Hard)

The existing extractor already supports tags but treats them as a short-circuit *optimization*. Promote them to the authoritative source:

- When a tag precedes a money match, its `kind` / `scope` are **never** overridden by proximity inference.
- When **no** tag is found within a 3-line lookback window AND the renderer is known (via a new `EXPECTS_TAGS` document set), emit a hard extractor warning that surfaces as a new `FCR-011` violation: `"Untagged money figure in a document that should carry authoritative tags — LLM synthesis may have stripped the tag"`.
- Proximity-based scope detection remains the fallback ONLY for documents not in `EXPECTS_TAGS` (e.g., agent-generated narrative, external memos).

### 3. LLM Synthesis Prompt Mandates Tag Preservation

`src/synthesis/llm-synth/executive-synthesis-prompt.ts` (or wherever the synthesis prompt lives) must include a verbatim preservation block:

```
🛑 CRITICAL — PRESERVE HTML COMMENT TAGS

The skeleton document you are rewriting contains HTML comment tags like
`<!-- fcv:kind=investment scope=pilot doc=executive-summary -->`. These are
financial consistency tags. You MUST:

1. NEVER remove or modify any <!-- fcv:... --> tag
2. NEVER move a tag away from the money figure it precedes
3. NEVER introduce a money figure without a preceding tag
4. If you rewrite a section, keep the tag attached to the rewritten figure
5. If you split a figure into two, duplicate the tag so each resulting line
   has its own tag

These tags drive a downstream validator. If you remove or misplace them,
the pipeline will fail the build.
```

This block is injected into every prompt call that targets an executive document.

### 4. Post-Synthesis Tag Survival Check

A new runner stage in `src/synthesis/llm-synth/tag-survival-checker.ts` compares the pre-synthesis skeleton against the post-synthesis output. It counts tags in both and fails the synthesis if:

- Post-synthesis tag count < pre-synthesis tag count (tags dropped)
- Post-synthesis contains a money figure with no preceding tag (untagged new figure)
- A tag lands on a line that doesn't contain a money figure (orphaned tag)

When the check fails, the runner **discards the LLM output** and falls back to the renderer's skeleton — the skeleton is worse prose but it has correct tags, and correct-but-ugly is always better than pretty-but-wrong.

### 5. FCR-011 — Untagged Money in Tag-Expected Documents

Add a new rule to `src/synthesis/financial-consistency-rules.ts`:

```
FCR-011: Every money figure in executive-summary, decision-memo,
financial-analysis, and roadmap MUST have a preceding fcv tag.
```

The rule is `error` severity. It fires on untagged money figures in the four tag-expected documents. The suggested fix points the reviewer at the LLM synthesis prompt + the tag-survival checker.

### 6. Per-Document Tag Identity

Add a `doc=` field to every tag. The runner cross-checks that every tag's `doc` field matches the document it was extracted from. A tag with `doc=decision-memo` appearing inside `executive-summary.md` is a new `FCR-012` violation (`"fcv tag copied from wrong document — synthesis pass contaminated cross-doc content"`). Cheap safety net with zero false positives.

## Implementation

1. `src/synthesis/simulation-renderers.ts`:
   - New `fcvTag(kind, scope, doc)` helper
   - Refactor all renderers to emit tags on every money-bearing line (~40 call sites)
2. `src/synthesis/financial-claim-extractor.ts`:
   - Add `EXPECTS_TAGS` document set
   - Tagged matches are authoritative — skip proximity inference when a tag is found
   - Emit untagged-money findings for documents in `EXPECTS_TAGS`
3. `src/synthesis/financial-consistency-rules.ts`:
   - `FCR-011` — untagged money figure in tag-expected doc
   - `FCR-012` — tag's `doc=` field disagrees with the document it was extracted from
4. `src/synthesis/llm-synth/executive-synthesis-prompt.ts`:
   - Inject the preservation block into every executive-document prompt
5. New `src/synthesis/llm-synth/tag-survival-checker.ts`:
   - Pre-synthesis skeleton tag count vs. post-synthesis count
   - Discard LLM output and return the skeleton on any check failure
6. Tests:
   - `tests/unit/synthesis/fcv-tag-survival.test.ts` — simulated LLM drops/moves tags, checker rejects
   - Extractor test: tagged figure wins over contradictory proximity hint
   - Renderer test: every money figure in the Ramco-catering fixture has a preceding tag
   - Integration test: the exact Ramco contradiction (`$2.1M–$3.1M` pilot vs. full-program) is caught by FCR-001 via the authoritative tags

## Acceptance Criteria

1. Every executive document emitted by the pipeline has a `<!-- fcv:... -->` tag on every money figure — zero untagged money figures in `executive-summary.md`, `decision-memo.md`, `financial-analysis.md`, or `roadmap`-sourced markdown.
2. The LLM synthesis prompt contains the preservation block verbatim.
3. The tag-survival checker rejects a synthesized document that drops a tag and falls back to the skeleton.
4. FCR-011 fires against a synthetic fixture with untagged money in executive-summary.md.
5. FCR-012 fires against a synthetic fixture with a `doc=decision-memo` tag in `executive-summary.md`.
6. Re-running the Ramco-catering query produces a pipeline failure via FCR-001 (authoritative pilot-vs-pilot range mismatch) BEFORE any boardroom review.
7. All existing ADR-067 tests still pass — the tag path is additive, the proximity path still works for non-tag-expected documents.

## Consequences

### Positive

- The single biggest executive-output defect class — LLM rewrites introducing contradictions the validator can't catch — is closed at the transport layer, not with more rules.
- The pipeline becomes resistant to prompt-drift in the LLM synthesis pass. Future prompt improvements can't accidentally bypass consistency checks because the tags are mandatory.
- The `doc=` field turns cross-document contamination from a silent failure into a loud one.

### Negative

- ~40 call-site refactors in the renderers — mechanical but tedious. The `fcvTag()` helper keeps each call small.
- LLM outputs with stripped tags are discarded wholesale — the skeleton's prose quality is objectively worse. Acceptable because correct-but-ugly beats pretty-but-wrong, and the skeleton can be re-synthesized once the LLM is instructed to preserve tags.
- Tag-survival checking adds ~50ms to the synthesis pass.

## Related

- **ADR-PIPELINE-067** (Cross-Document Consistency — this ADR makes FCR-001 / FCR-003 actually fire on LLM-synthesized documents)
- **ADR-PIPELINE-040** (LLM Executive Synthesis — this ADR adds the tag-preservation contract)
- **ADR-PIPELINE-066** (Unit Economics — the manifest values drive the tagged figures)
- **ADR-PIPELINE-072** (Pre-Render Analysis — ensures the tags reflect real numbers, not heuristics)
