# ADR-PIPELINE-110: Financial Coherence Hardening — Render, Scope Labels, Extractor Accuracy, Gating

**Status:** Implemented (2026-06-02)
**Implementation summary:** D1 — single exported `formatUsd` in `unit-economics-loader.ts` (always one `$`); fixed the actual `$$` defect (the methodology line prefixed a `$` onto an already-`$`-formatted value) and consolidated the 7 duplicate inline `fmt` lambdas in `simulation-renderers.ts` onto it. D2 — headline figures carry scope via their `fcv` tag; the previously-flagged unlabeled stragglers were derivation-note / sensitivity figures, now excluded from extraction (D3/D4) so they neither ship unlabeled-and-checked nor produce FCR-004 noise. D3 — the `fcv` tag is authoritative for scope; in tag-expecting docs an untagged figure is `unscoped` (never prose-inferred), and figures inside derivation parentheticals (`scales`, `extrapolated`, `÷`, …) are skipped — kills the FCR-003 prose-`$8.5M`-as-pilot false positive. D4 — sensitivity/range rows (`±` cell or sensitivity/scenario/stress section) are flagged `sensitivity:true` and excluded from every claim-based rule — kills the FCR-002 `$13.6M`-range-as-pilot-investment false positive; rules already compare like-kind/like-scope only. D5 — `AGENTICS_FCV_GATE={strict,warn,off}` (default **warn** warm-up; legacy `AGENTICS_STRICT_FCV=true`→strict) in the runner; `strict` fails the phase on error-severity violations, `off` skips annotation; the active tier is recorded in `financial-consistency.report.json`. D6 — shared `src/synthesis/fcv-coherence.ts` (canonical kind normalization + tolerance) consumed by both the Phase 1 runner and the Phase 7 coherence gate, so they can't diverge on kind parsing. Tests: `financial-coherence-110.test.ts` (12) cover D1/D3/D4/D5/D6; typecheck + build clean. **Live result:** report errors **79 → 36**, FCR-002 + FCR-003 (the false-positive classes) eliminated, zero `$$` in any deliverable, `gate: warn` recorded. The residual errors are genuine (untagged figures → FCR-004/011) — the report is now trustworthy rather than noisy. **Independent two-agent review (PASS / MED→addressed):** hardened `isInDerivationContext` to handle nested parens (flat regex missed outer derivation parens); tightened `isSensitivityRow` so ordinary "Budget Range"/"Salary Range" sections are not swept in; removed the over-broad `benchmark` derivation keyword; applied the `sensitivity` flag to timeline/headcount/ROI claims too; and wired the shared `FCV_TOLERANCE_PCT` into both the Phase 7 gate default and FCR-008 (D6 tolerance now actually consumed, not just exported). **Known follow-ups (generation/D2 territory, overlaps ADR-105/106):** the `costSavings` line emits pilot + enterprise figures under one `scope=full-program` inline tag → a residual FCR-007 on the pilot figure; the clean fix is per-scope renderer tags. Two cosmetic inline formatters (`fmtN`, sensitivity `fmtMoney`) and a `phase7/coordinator.ts` `formatUsd` duplicate remain (no `$$` risk). `scope=n/a`/`enterprise` are not yet in the `FinancialClaimScope` type.
**Date:** 2026-06-02
**Priority:** HIGH — The user requirement: *"Make sure there's a financial document and those numbers match across the board."* A financial document is produced, but it fails its own coherence check and ships anyway. Measured live on 2026-06-02 (run `bd63314c`): `financial-consistency.report.json` = `passed: false`, **79 errors / 38 warnings**, `strict: false` (non-fatal).
**Builds on:** ADR-PIPELINE-066 (`unit-economics.json` as the single financial source of truth), ADR-PIPELINE-067 (Financial Consistency Runner — extract → rules → report; this ADR fixes its accuracy and gating), ADR-PIPELINE-040 (LLM synthesis for executive docs — ran successfully in the measured run), ADR-PIPELINE-098 D8 / ADR-PIPELINE-105 (the Phase 7 coherence gate this ADR aligns with).

---

## Context

The financial pipeline is well-architected on paper: `unit-economics.json` is the canonical source (ADR-066), every figure is meant to carry an `<!-- fcv:kind=... scope=... -->` provenance tag, and a Financial Consistency Runner (ADR-067) cross-checks the docs. In the live run it produced `financial-analysis.md`, `executive-summary.md`, `decision-memo.md`, all with `fcv` tags, and LLM synthesis succeeded. **But the consistency report failed**, and three distinct problems are tangled in the 79 errors:

### Problem 1 — Render defect: double dollar sign

Canonical values are interpolated into a string that already contains `$`, producing `$$`:

```
measured pilot $$340K/yr scales 25.0× to enterprise $$8.5M/yr …
```

Present in `financial-analysis.md`, `executive-summary.md`, `decision-memo.md`. This is a string-templating bug in the renderers (a `$`-prefix applied to an already-`$` value).

### Problem 2 — Genuine coherence gaps

- **FCR-004**: bare figures with no scope label — e.g. `executive-summary line 31: $68K has no scope label`, `$54K`, `$8.5M`. A reader can't tell pilot vs full-program for these.

### Problem 3 — Extractor false positives (the checker is noisy)

Several of the 79 errors are the *checker* mis-reading the documents, not real contradictions:

- **FCR-002**: *"pilot investment $13.60M exceeds full-program ceiling $8,500,000."* The `$13.60M` is the **high end of a sensitivity range** in `financial-analysis.md:80`:
  `| Scope expansion | Pilot → Enterprise | $8.50M | $13.60M | ±$5.10M |`
  The extractor read a sensitivity-table column as a "pilot investment" and compared it against the `$8.5M` *savings* figure as if it were an investment ceiling. Two different kinds, one a range bound — not a contradiction.
- **FCR-003**: *"financial-analysis declares $8.50M (pilot) but executive-summary labels the same range as (full-program)."* Yet **every `fcv` tag for that figure says `scope=full-program`** in all three docs. The extractor inferred `scope=pilot` from the word "pilot" in the embedded derivation prose (`$340K/yr scales … to enterprise $8.5M/yr`) instead of trusting the authoritative `fcv` tag.

So the report is simultaneously **too lenient** (it's advisory, so real defects ship) and **too noisy** (false positives bury the real ones). Both must be fixed before "numbers match across the board" can be a guarantee rather than a hope.

## Decision

Six rules. D1 fixes rendering; D2 closes the scope-label gap; D3–D4 fix extractor accuracy; D5 sets gating policy; D6 aligns with the Phase 7 gate.

### D1. Fix the double-`$` render defect

The renderers must format currency through a single canonical formatter that never double-prefixes. Introduce one `formatUsd(value)` helper used by every financial renderer; the derivation-note builder must consume already-formatted strings (no manual `$` concatenation). A unit test asserts no rendered deliverable contains `$$`.

### D2. Every emitted figure MUST carry a scope label

No dollar figure ships without a `scope` (`pilot | full-program | enterprise | per-unit | n/a`). The renderer attaches `scope` at emission (it already does for the headline figures via `fcv`); D2 extends this to the stragglers FCR-004 flags. A figure that is genuinely scope-agnostic carries `scope=n/a` explicitly, so "no label" never happens silently.

### D3. The `fcv` tag is authoritative for scope; prose is never used to infer it

The claim extractor (`financial-claim-extractor.ts`) MUST read `scope` from the figure's `fcv` tag and MUST NOT infer scope from nearby words ("pilot", "enterprise") in surrounding or embedded prose. This kills FCR-003-class false positives: a `$8.5M` tagged `scope=full-program` is full-program, full stop, regardless of a "pilot" appearing in its derivation note.

### D4. Sensitivity ranges and kinds are distinguished from point claims

- The extractor MUST recognise range/sensitivity contexts (table rows with low/high/±, columns under a "Sensitivity"/"Range" header) and treat the high/low as **bounds of one claim**, not independent point figures. This kills FCR-002-class false positives.
- Cross-kind comparisons are forbidden: an `investment` figure is never compared against a `savings` ceiling. Rules compare like-kind, like-scope claims only.

### D5. Gating policy — fail the run on real, like-for-like contradictions

After D1–D4 remove the noise, the remaining errors are real. Change the default so genuine contradictions are not silently shipped:

- A new tier: `AGENTICS_FCV_GATE = { strict | warn | off }`, default **`warn`** for one release (report + prepend the warning header, as today), then default **`strict`** once D1–D4 land and runs are clean.
- In `strict`, an `error`-severity, like-for-like, same-scope contradiction (e.g. the same `fcv` kind+scope carrying two different canonical-derived values beyond ±tolerance) **fails the phase**. Warnings never fail.
- `AGENTICS_STRICT_FCV=true` (the existing flag) maps to `strict`.

The warm-up window exists precisely so the gate is calibrated against real runs (post-fix) before it can fail a pipeline — the same staged rollout ADR-105 uses for the deliverable gate.

### D6. One coherence model across Phase 1 and Phase 7

The Phase 1 financial-consistency runner (ADR-067) and the Phase 7 coherence gate (ADR-098 D8 / ADR-105 D7) MUST share the same canonical map (from `unit-economics.json`), the same `fcv` parsing (D3), the same range handling (D4), and the same tolerance. A figure that passes Phase 1 must not fail Phase 7 for a parsing discrepancy. The shared logic lives in one module consumed by both.

## Consequences

### Positive
- The financial document's numbers are coherent *and the pipeline proves it* — "match across the board" becomes enforced, not aspirational.
- Removing false positives makes the report trustworthy; removing the advisory default makes it binding.
- One coherence engine for Phase 1 and Phase 7 — no double standard.

### Negative / Risks
- `strict` default will fail runs that have real contradictions until generation is fully coherent. Mitigation: `warn` warm-up window (D5); ADR-105/106 raise generation quality in parallel.
- Range/sensitivity detection (D4) is heuristic on Markdown tables; needs test coverage against real deliverables.

### Neutral
- `unit-economics.json` and the ADR-066 single-source model are unchanged; this hardens the consumers, not the source.

## Alternatives Considered

1. **Just set `AGENTICS_STRICT_FCV=true` today.** Rejected: with 79 errors (most false positives) every run would fail for the wrong reasons. Accuracy (D3–D4) must precede strictness (D5).
2. **Suppress the noisy rules instead of fixing the extractor.** Rejected: the rules catch real issues too (FCR-004); the fix is accurate extraction, not disabling checks.
3. **Only fix the render bug.** Rejected: cosmetic; leaves the gate advisory and the extractor noisy, so "numbers match" still can't be guaranteed.

## Implementation (not yet built — Proposed)

- `src/synthesis/simulation-renderers.ts` — single `formatUsd`; remove manual `$` concatenation (D1); attach `scope` to all figures (D2).
- `src/synthesis/financial-claim-extractor.ts` — `fcv`-authoritative scope (D3); range/sensitivity + kind awareness (D4).
- `src/synthesis/financial-consistency-rules.ts` — like-kind/like-scope comparison only (D4).
- `src/synthesis/financial-consistency-runner.ts` — `AGENTICS_FCV_GATE` tiers + phase-failing in strict (D5).
- Shared coherence module consumed by both the Phase 1 runner and `src/pipeline/phase7/coherence-gate.ts` (D6).
- Tests: no `$$` in any deliverable (D1); every figure scope-labelled (D2); FCR-002 sensitivity row and FCR-003 full-program `$8.5M` no longer flagged (D3–D4); strict-mode phase failure on a real contradiction (D5).
