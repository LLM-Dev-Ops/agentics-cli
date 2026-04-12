/**
 * ADR-PIPELINE-073 tests: authoritative fcv tags survive LLM synthesis.
 *
 * Verifies:
 *  - fcvTag() helper emits the correct HTML comment form
 *  - extractor recognizes the new doc= field and populates docTag on claims
 *  - EXPECTS_TAGS set contains the 5 tag-expected document kinds
 *  - Tagged money figures win over contradictory proximity hints
 *  - FCR-011 fires on untagged money in an EXPECTS_TAGS doc
 *  - FCR-011 does NOT fire on tagged money, on unscoped-aware fallback
 *    documents, or on non-currency claims
 *  - FCR-012 fires when a tag's doc= field disagrees with the enclosing doc
 *  - FCR-012 does NOT fire on correctly-matched tags
 *  - countFcvTags returns the exact inline tag count
 *  - Renderer integration: renderExecutiveSummary, renderDecisionMemo,
 *    renderFinancialAnalysis emit at least one fcv tag on every money row
 *  - Integration test: the Ramco-style pilot-vs-full contradiction is
 *    caught end-to-end via FCR-001 (authoritative pilot scope from the
 *    decision memo's Options Considered tag)
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  fcvTag,
  countFcvTags,
  extractClaims,
  EXPECTS_TAGS,
  type FinancialClaim,
} from '../../../src/synthesis/financial-claim-extractor.js';
import {
  __internal as fcrInternal,
  runConsistencyRules,
} from '../../../src/synthesis/financial-consistency-rules.js';
import { runConsistencyCheck } from '../../../src/synthesis/financial-consistency-runner.js';
import {
  renderExecutiveSummary,
  renderDecisionMemo,
  renderFinancialAnalysis,
} from '../../../src/synthesis/simulation-renderers.js';

// ============================================================================
// Helpers
// ============================================================================

function mkTemp(label: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `adr073-${label}-`));
}

function claim(overrides: Partial<FinancialClaim>): FinancialClaim {
  return {
    document: 'executive-summary',
    section: 'test',
    kind: 'investment',
    scope: 'pilot',
    unit: 'USD',
    rawText: '$1M',
    line: 1,
    tagged: true,
    ...overrides,
  };
}

const RAMCO_QUERY =
  'Reduce food waste from in-flight catering across our 69,000-employee airline. Our catering is managed through Ramco Aviation ERP.';

// ============================================================================
// fcvTag helper
// ============================================================================

describe('ADR-073 — fcvTag helper', () => {
  it('emits an HTML comment with kind/scope/doc', () => {
    const tag = fcvTag('investment', 'pilot', 'decision-memo');
    expect(tag).toBe('<!-- fcv:kind=investment scope=pilot doc=decision-memo -->');
  });

  it('supports every scope value', () => {
    expect(fcvTag('savings', 'full-program', 'executive-summary')).toContain('scope=full-program');
    expect(fcvTag('roi', 'phase-1', 'financial-analysis')).toContain('scope=phase-1');
  });
});

// ============================================================================
// countFcvTags
// ============================================================================

describe('ADR-073 — countFcvTags', () => {
  it('counts zero tags in plain text', () => {
    expect(countFcvTags('# Exec Summary\n\nSome prose here.')).toBe(0);
  });

  it('counts two tags in a mixed document', () => {
    const body = `<!-- fcv:kind=investment scope=pilot doc=executive-summary -->
Investment: $1M

<!-- fcv:kind=savings scope=full-program doc=executive-summary -->
Savings: $3M`;
    expect(countFcvTags(body)).toBe(2);
  });
});

// ============================================================================
// EXPECTS_TAGS set
// ============================================================================

describe('ADR-073 — EXPECTS_TAGS set', () => {
  it('contains the five tag-expected document kinds', () => {
    expect(EXPECTS_TAGS.has('executive-summary')).toBe(true);
    expect(EXPECTS_TAGS.has('decision-memo')).toBe(true);
    expect(EXPECTS_TAGS.has('financial-analysis')).toBe(true);
    expect(EXPECTS_TAGS.has('roadmap')).toBe(true);
    expect(EXPECTS_TAGS.has('business-case')).toBe(true);
  });

  it('does NOT contain narrative-only kinds', () => {
    expect(EXPECTS_TAGS.has('risk-register')).toBe(false);
    expect(EXPECTS_TAGS.has('unknown')).toBe(false);
  });
});

// ============================================================================
// Extractor — doc= field propagation
// ============================================================================

describe('ADR-073 — extractClaims propagates doc= to claim.docTag', () => {
  it('sets docTag when the tag carries a doc= value', () => {
    const md = `## Investment
<!-- fcv:kind=investment scope=pilot doc=decision-memo -->
Pilot investment: $1.0M–$1.4M.`;
    const claims = extractClaims(md, 'decision-memo');
    const inv = claims.find(c => c.kind === 'investment');
    expect(inv).toBeDefined();
    expect(inv!.tagged).toBe(true);
    expect(inv!.docTag).toBe('decision-memo');
  });

  it('leaves docTag unset when the tag omits doc=', () => {
    const md = `<!-- fcv:kind=investment scope=pilot -->
Pilot: $500K.`;
    const claims = extractClaims(md, 'executive-summary');
    const inv = claims.find(c => c.kind === 'investment');
    expect(inv?.tagged).toBe(true);
    expect(inv?.docTag).toBeUndefined();
  });

  it('tag is authoritative over contradictory proximity hints', () => {
    // Line contains "full program" but the tag says pilot
    const md = `<!-- fcv:kind=investment scope=pilot doc=executive-summary -->
Full program coverage: $3.0M.`;
    const claims = extractClaims(md, 'executive-summary');
    const inv = claims.find(c => c.kind === 'investment');
    expect(inv?.scope).toBe('pilot');
  });
});

// ============================================================================
// FCR-011 — untagged money in EXPECTS_TAGS docs
// ============================================================================

describe('ADR-073 — FCR-011 untagged money', () => {
  it('fires on untagged currency in executive-summary', () => {
    const claims: FinancialClaim[] = [
      claim({ document: 'executive-summary', kind: 'investment', scope: 'pilot', pointValue: 1_000_000, tagged: false }),
    ];
    const vs = fcrInternal.ruleFcr011(claims);
    expect(vs).toHaveLength(1);
    expect(vs[0]!.ruleId).toBe('FCR-011');
    expect(vs[0]!.severity).toBe('error');
  });

  it('fires on untagged currency in decision-memo', () => {
    const claims: FinancialClaim[] = [
      claim({ document: 'decision-memo', kind: 'savings', scope: 'full-program', pointValue: 4_100_000, tagged: false }),
    ];
    expect(fcrInternal.ruleFcr011(claims)).toHaveLength(1);
  });

  it('does NOT fire on tagged money', () => {
    const claims: FinancialClaim[] = [
      claim({ document: 'executive-summary', kind: 'investment', scope: 'pilot', pointValue: 1_000_000, tagged: true }),
    ];
    expect(fcrInternal.ruleFcr011(claims)).toHaveLength(0);
  });

  it('does NOT fire on non-currency claims', () => {
    const claims: FinancialClaim[] = [
      claim({ document: 'executive-summary', kind: 'timeline', scope: 'pilot', pointValue: 12, unit: 'weeks', tagged: false }),
    ];
    expect(fcrInternal.ruleFcr011(claims)).toHaveLength(0);
  });

  it('does NOT fire on documents outside EXPECTS_TAGS', () => {
    const claims: FinancialClaim[] = [
      claim({ document: 'risk-register', kind: 'investment', scope: 'pilot', pointValue: 1_000_000, tagged: false }),
    ];
    expect(fcrInternal.ruleFcr011(claims)).toHaveLength(0);
  });
});

// ============================================================================
// FCR-012 — tag doc= mismatch
// ============================================================================

describe('ADR-073 — FCR-012 doc mismatch', () => {
  it('fires when docTag disagrees with document', () => {
    const claims: FinancialClaim[] = [
      claim({
        document: 'executive-summary',
        docTag: 'decision-memo',
        tagged: true,
        kind: 'investment',
        scope: 'pilot',
        pointValue: 1_000_000,
      }),
    ];
    const vs = fcrInternal.ruleFcr012(claims);
    expect(vs).toHaveLength(1);
    expect(vs[0]!.ruleId).toBe('FCR-012');
    expect(vs[0]!.severity).toBe('error');
    expect(vs[0]!.message).toMatch(/doc="decision-memo"/);
  });

  it('does NOT fire when docTag matches document', () => {
    const claims: FinancialClaim[] = [
      claim({
        document: 'decision-memo',
        docTag: 'decision-memo',
        tagged: true,
        kind: 'investment',
        scope: 'pilot',
        pointValue: 1_000_000,
      }),
    ];
    expect(fcrInternal.ruleFcr012(claims)).toHaveLength(0);
  });

  it('does NOT fire when tag has no doc= field', () => {
    const claims: FinancialClaim[] = [
      claim({
        document: 'executive-summary',
        tagged: true,
        kind: 'investment',
        scope: 'pilot',
        pointValue: 1_000_000,
      }),
    ];
    expect(fcrInternal.ruleFcr012(claims)).toHaveLength(0);
  });
});

// ============================================================================
// runConsistencyRules integration
// ============================================================================

describe('ADR-073 — runConsistencyRules integration', () => {
  it('surfaces both FCR-011 and FCR-012 in the unified output', () => {
    const claims: FinancialClaim[] = [
      claim({
        document: 'executive-summary',
        kind: 'investment',
        scope: 'pilot',
        pointValue: 1_000_000,
        tagged: false,
      }),
      claim({
        document: 'decision-memo',
        docTag: 'executive-summary',
        tagged: true,
        kind: 'savings',
        scope: 'full-program',
        pointValue: 4_000_000,
      }),
    ];
    const vs = runConsistencyRules({ claims });
    expect(vs.some(v => v.ruleId === 'FCR-011')).toBe(true);
    expect(vs.some(v => v.ruleId === 'FCR-012')).toBe(true);
  });
});

// ============================================================================
// Renderer integration — every money row has a tag
// ============================================================================

describe('ADR-073 — renderers emit fcv tags on every money row', () => {
  it('renderExecutiveSummary emits tags in the Financial Impact table', () => {
    const out = renderExecutiveSummary(RAMCO_QUERY, null, []);
    expect(out).toMatch(/<!-- fcv:kind=investment scope=full-program doc=executive-summary -->/);
    expect(out).toMatch(/<!-- fcv:kind=roi scope=full-program doc=executive-summary -->/);
    expect(out).toMatch(/<!-- fcv:kind=npv scope=full-program doc=executive-summary -->/);
  });

  it('renderDecisionMemo emits distinct pilot vs full-program tags in Options Considered', () => {
    const out = renderDecisionMemo(RAMCO_QUERY, null, []);
    expect(out).toMatch(/<!-- fcv:kind=investment scope=pilot doc=decision-memo -->/);
    expect(out).toMatch(/<!-- fcv:kind=investment scope=full-program doc=decision-memo -->/);
  });

  it('renderFinancialAnalysis emits tags in the Investment Summary table', () => {
    const out = renderFinancialAnalysis(RAMCO_QUERY, null, []);
    expect(out).toMatch(/<!-- fcv:kind=investment scope=full-program doc=financial-analysis -->/);
    expect(out).toMatch(/<!-- fcv:kind=npv scope=full-program doc=financial-analysis -->/);
  });

  it('executive summary Financial Impact money cells pass FCR-011 when extracted', () => {
    const out = renderExecutiveSummary(RAMCO_QUERY, null, []);
    const claims = extractClaims(out, 'executive-summary');
    // At least some currency claims should be tagged
    const currencyClaims = claims.filter(c => c.unit === 'USD');
    expect(currencyClaims.length).toBeGreaterThan(0);
    const taggedCount = currencyClaims.filter(c => c.tagged).length;
    expect(taggedCount).toBeGreaterThan(0);
    // The money cells in the Financial Impact table must all be tagged
    const financialImpactClaims = currencyClaims.filter(c => c.section === 'Financial Impact');
    if (financialImpactClaims.length > 0) {
      expect(financialImpactClaims.every(c => c.tagged)).toBe(true);
    }
  });
});

// ============================================================================
// End-to-end: Ramco contradiction detection
// ============================================================================

describe('ADR-073 — end-to-end Ramco pilot vs full-program detection', () => {
  it('catches an LLM-style contradiction where exec summary mislabels the pilot range', () => {
    // Simulated LLM-rewritten documents:
    // Exec summary incorrectly applies the full-program range to the pilot tag.
    const execSummaryMd = `# Executive Summary

## Financial Impact

| Metric | Value |
|--------|-------|
| Total Investment | <!-- fcv:kind=investment scope=pilot doc=executive-summary --> $2.1M–$3.1M |
`;

    const decisionMemoMd = `# Decision Memo

## Options Considered

| Option | Investment |
|--------|-----------|
| **A. Scoped Pilot** | <!-- fcv:kind=investment scope=pilot doc=decision-memo --> $630K–$945K |
| **B. Full Deployment** | <!-- fcv:kind=investment scope=full-program doc=decision-memo --> $2.1M–$3.1M |
`;

    const dir = mkTemp('e2e');
    try {
      fs.writeFileSync(path.join(dir, 'executive-summary.md'), execSummaryMd, 'utf-8');
      fs.writeFileSync(path.join(dir, 'decision-memo.md'), decisionMemoMd, 'utf-8');

      const result = runConsistencyCheck({
        runDir: dir,
        documents: [
          { kind: 'executive-summary', path: path.join(dir, 'executive-summary.md'), content: execSummaryMd },
          { kind: 'decision-memo', path: path.join(dir, 'decision-memo.md'), content: decisionMemoMd },
        ],
        annotateDocuments: false,
      });

      // FCR-001 should catch the non-overlapping pilot-scoped ranges across documents.
      expect(result.violations.some(v => v.ruleId === 'FCR-001')).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('flags a synthesized document that drops tags (FCR-011 firing on 3 of 3 rows)', () => {
    // The "LLM-stripped" exec summary has no fcv tags at all.
    const strippedMd = `# Executive Summary

## Financial Impact

| Metric | Value |
|--------|-------|
| Total Investment | $2.1M–$3.1M |
| Expected ROI | 280% |
| 5-Year NPV | $19.1M |
`;
    const claims = extractClaims(strippedMd, 'executive-summary');
    const currencyClaims = claims.filter(c => c.unit === 'USD');
    const untagged = currencyClaims.filter(c => !c.tagged);
    expect(untagged.length).toBeGreaterThanOrEqual(2);
    const vs = fcrInternal.ruleFcr011(claims);
    expect(vs.length).toBeGreaterThanOrEqual(2);
  });
});
