/**
 * ADR-PIPELINE-096 D3 part 2 — FCR-013 provenance rule tests.
 *
 * Verifies that tagged headline-metric figures (investment/roi/npv/savings)
 * carrying no src= attribution surface a warning. Covers Verification
 * scenario 7 (FCR-012-regression in the ADR text — landed as FCR-013 since
 * FCR-012 was already taken).
 */

import { describe, it, expect } from '@jest/globals';

import { __internal } from '../../../src/synthesis/financial-consistency-rules.js';
import type { FinancialClaim } from '../../../src/synthesis/financial-claim-extractor.js';

const { ruleFcr013 } = __internal;

function claim(over: Partial<FinancialClaim>): FinancialClaim {
  return {
    document: 'executive-summary',
    section: 'Financial Impact',
    kind: 'investment',
    scope: 'full-program',
    pointValue: 2_000_000,
    unit: 'USD',
    rawText: '$2.0M',
    line: 1,
    tagged: true,
    ...over,
  };
}

describe('ADR-096 D3 — FCR-013 provenance', () => {
  it('warns on a tagged investment claim without src= attribution', () => {
    const violations = ruleFcr013([claim({ kind: 'investment' })]);
    expect(violations).toHaveLength(1);
    expect(violations[0]!.ruleId).toBe('FCR-013');
    expect(violations[0]!.severity).toBe('warn');
    expect(violations[0]!.message).toContain('no src= attribution');
  });

  it('warns on tagged ROI / NPV / savings without src=', () => {
    expect(ruleFcr013([claim({ kind: 'roi', rawText: '167%' })])).toHaveLength(1);
    expect(ruleFcr013([claim({ kind: 'npv', rawText: '$11.9M' })])).toHaveLength(1);
    expect(ruleFcr013([claim({ kind: 'savings', rawText: '$3.4M' })])).toHaveLength(1);
  });

  it('does NOT warn when src= is present (canonical attribution)', () => {
    const v = ruleFcr013([claim({ kind: 'investment', srcTag: 'costops/forecast' })]);
    expect(v).toEqual([]);
  });

  it('does NOT warn on untagged claims (FCR-011 catches those separately)', () => {
    expect(ruleFcr013([claim({ tagged: false })])).toEqual([]);
  });

  it('does NOT warn on non-headline kinds (timeline, payback are scoped to other rules)', () => {
    // `payback` is in PROVENANCE_KINDS; let's test other kinds explicitly.
    expect(ruleFcr013([claim({ kind: 'timeline', rawText: '6-12 months' })])).toEqual([]);
  });

  it('does NOT warn on documents not in EXPECTS_TAGS', () => {
    expect(ruleFcr013([claim({ document: 'security-assessment' })])).toEqual([]);
  });

  it('warns on every untagged-source claim across multiple docs', () => {
    const claims: FinancialClaim[] = [
      claim({ document: 'executive-summary', kind: 'investment' }),
      claim({ document: 'decision-memo', kind: 'investment' }),
      claim({ document: 'financial-analysis', kind: 'roi', rawText: '167%' }),
      claim({ document: 'financial-analysis', kind: 'npv', rawText: '$11.9M', srcTag: 'simulator/scenario' }),
    ];
    const violations = ruleFcr013(claims);
    expect(violations).toHaveLength(3);  // first three warn; npv has src=, doesn't.
  });
});
