# ADR-PIPELINE-067: Cross-Document Financial Consistency Validator

**Status:** Accepted
**Date:** 2026-04-11
**Priority:** HIGH — Boardroom-credibility blocker
**Originating Review:** OPERA Sustainability Prototype Readiness Review (2026-04-11), Executive Output 6/10
**Builds on:** ADR-PIPELINE-053 (scope labels), ADR-PIPELINE-066 (unit economics manifest)

## Context

The OPERA review flagged a second boardroom-fatal defect:

> "Internal contradiction on investment size. Executive summary says $2.7M–$4.1M, 12-week pilot. Decision memo says $1.0M pilot, $2.7M–$4.1M full deployment. Same 12-week window, different scope definition. A board member reading both will flag this in 30 seconds."

ADR-PIPELINE-053 required scope labels on every dollar figure, but it did not require *cross-document* validation. Each renderer runs in isolation. When the executive summary says `$2.7M–$4.1M (12-week pilot)` and the decision memo says `$1.0M pilot / $2.7M–$4.1M full program`, both pass their individual templates. Nobody checks that they agree with each other.

This ADR adds a post-rendering validator that compares every dollar figure and every time-bound commitment across all executive documents emitted in a single run, and fails the run on contradiction.

## Decision

### 1. Extract Financial Claims from Rendered Documents

Add `src/synthesis/financial-claim-extractor.ts` with:

```typescript
export interface FinancialClaim {
  document: 'executive-summary' | 'decision-memo' | 'roadmap' | 'business-case' | 'risk-register';
  section: string;
  kind: 'investment' | 'savings' | 'timeline' | 'headcount' | 'roi' | 'npv';
  scope: 'pilot' | 'phase-1' | 'phase-2' | 'phase-3' | 'full-program' | 'unscoped';
  rangeLow?: number;
  rangeHigh?: number;
  pointValue?: number;
  unit: 'USD' | 'weeks' | 'months' | 'years' | 'count' | 'percent';
  rawText: string;
  line: number;
}

export function extractClaims(markdown: string, document: FinancialClaim['document']): FinancialClaim[];
```

Extraction uses anchored regexes against markdown, not LLM calls. Patterns:
- `\$[\d.]+[KMB](?:\s*[-–]\s*\$[\d.]+[KMB])?` for currency ranges
- `(\d+)[-–\s]*weeks?` / `(\d+)[-–\s]*months?` for timelines
- Paren-adjacent scope labels (`(pilot)`, `(Phase 1)`, `(full program)`) drive the `scope` field
- Line numbers retained for error reporting

### 2. Consistency Rules

New module `src/synthesis/financial-consistency-rules.ts` encodes:

| ID | Rule | Action on Violation |
|---|---|---|
| FCR-001 | Same `scope` + same `kind` across documents ⇒ numeric ranges must overlap | Error |
| FCR-002 | `pilot` investment MUST be ≤ `full-program` investment | Error |
| FCR-003 | `phase-1` range MUST be a subset of `full-program` range | Error |
| FCR-004 | Every currency claim MUST have a non-`unsourced` scope | Error |
| FCR-005 | Timeline claims for the same scope MUST match within ±1 week | Error |
| FCR-006 | Savings + investment for the same scope MUST yield the ROI stated in the same document | Warn |
| FCR-007 | When `unit-economics.json` exists, top-line figures MUST match it (±1%) | Error — ADR-066 §5 |
| FCR-008 | Pilot savings × (enterprise_units / pilot_units) MUST equal enterprise savings within ±5% | Error |
| FCR-009 | At most one "headline" figure per document (prevents "$30M/yr" in one paragraph and "$4.1M/yr" in the next without a bridge) | Warn |

Rules are pure functions `(claims: FinancialClaim[], manifest?: UnitEconomics) => Violation[]`.

### 3. Validator Stage in the Enterprise Pipeline

`src/pipeline/enterprise/pipeline-orchestrator.ts` runs the validator after `artifact-assembler.ts` emits all documents:

```typescript
const claims = documents.flatMap(d => extractClaims(d.content, d.kind));
const violations = runConsistencyRules(claims, unitEconomics);
if (violations.some(v => v.severity === 'error')) {
  if (process.env.AGENTICS_STRICT_FCV === 'true') {
    throw new PipelineError('ECLI-SYN-067', formatViolations(violations));
  }
  writeViolationsReport(runDir, violations);
  appendWarningHeaderToDocuments(documents, violations);
}
```

Default behavior: write a `financial-consistency.report.json` and prepend a `> ⚠️ Financial consistency: N warnings — see financial-consistency.report.json` header to every affected document. Strict mode (for CI and enterprise pilots) turns violations into a hard fail.

### 4. Machine-Readable Violations Report

`financial-consistency.report.json` schema:

```json
{
  "run_id": "sim-20260411-a1b2",
  "generated_at": "2026-04-11T13:02:17Z",
  "passed": false,
  "violations": [
    {
      "rule_id": "FCR-003",
      "severity": "error",
      "message": "executive-summary declares $2.7M–$4.1M (12-week pilot) but decision-memo declares $1.0M (pilot)",
      "claims": [
        { "document": "executive-summary", "line": 42, "rawText": "$2.7M–$4.1M total investment (12-week pilot)" },
        { "document": "decision-memo", "line": 31, "rawText": "$1.0M pilot, $2.7M–$4.1M full deployment" }
      ],
      "suggested_fix": "Relabel executive-summary figure to '(full program)' or split into pilot + full-program lines."
    }
  ]
}
```

The report is consumed by (a) the CI gate, (b) the `/api/runs/:id/consistency` endpoint added to the mgmt server, and (c) future LLM self-repair loops.

### 5. Renderer-Side Tagging

Renderers can pre-annotate figures with HTML comments that the extractor prefers over regex inference:

```markdown
<!-- fcv:kind=investment scope=pilot -->
**Pilot investment:** $1.0M–$1.4M
```

Tagging is optional but short-circuits pattern matching and eliminates false positives. Ship tags in `executive-summary`, `decision-memo`, and `roadmap` renderers first; others follow.

## Implementation

1. `src/synthesis/financial-claim-extractor.ts` (new)
2. `src/synthesis/financial-consistency-rules.ts` (new)
3. `src/synthesis/financial-consistency-runner.ts` (new) — orchestrates extract → rules → report
4. Wire into `src/pipeline/enterprise/pipeline-orchestrator.ts` after `artifact-assembler.ts`
5. Add annotations in `src/pipeline/enterprise/artifact-renderers.ts` for the 5 document types in scope
6. CLI: `agentics validate consistency <run-id>` surfaces the report for ad-hoc inspection
7. Tests: fixture pairs (pass/fail) for each rule in `tests/synthesis/financial-consistency/`

## Acceptance Criteria

1. Running the pipeline on any query produces `financial-consistency.report.json` in the run directory.
2. The OPERA review's exact failure — $2.7M–$4.1M pilot vs. $1.0M pilot — is detected as FCR-003.
3. Every rule has at least one positive and one negative unit test.
4. `AGENTICS_STRICT_FCV=true` converts any error-severity violation into a pipeline failure with exit code 67.
5. Extractor handles `$1.2M`, `$1.2M–$1.4M`, `$1,200,000`, `USD 1.2M`, and `1.2 million dollars` forms.

## Consequences

### Positive
- Contradictions surface at rendering time, not at the boardroom table
- Creates a forcing function for renderers to use explicit scope labels (ADR-053)
- Enables enterprise pilots to adopt strict mode with confidence
- The violations report becomes the evidence log for "how do we know the numbers agree"

### Negative
- Regex-based extraction has false-positive risk on prose that mentions dollars without intending a claim — mitigated by HTML-comment tags in renderers
- Strict mode will initially block runs that previously passed — roll out behind the env flag for the first two weeks
- Adds ~80ms to pipeline runtime for a typical 6-document run (measured on the OPERA fixture)

## Related
- ADR-PIPELINE-053 (scope labels — this ADR enforces them)
- ADR-PIPELINE-066 (unit economics manifest — FCR-007, FCR-008 depend on it)
- ADR-PIPELINE-042 / ADR-PIPELINE-065 (post-generation validator pattern — same philosophy applied to financial prose)
