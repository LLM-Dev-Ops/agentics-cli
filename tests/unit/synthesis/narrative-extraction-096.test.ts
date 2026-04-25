/**
 * ADR-PIPELINE-096 D3+ (2.7.13) — narrative extraction tests.
 *
 * Verifies that extractFinancialClaimsFromNarrative pulls $X investment,
 * Y% ROI, $Z NPV, N month payback patterns from agent narrative responses.
 */

import { describe, it, expect } from '@jest/globals';

import {
  extractFinancialClaimsFromNarrative,
  type NarrativeAgent,
} from '../../../src/synthesis/agent-claim-registry.js';

function memo(narrative: string): NarrativeAgent {
  return { domain: 'platform', agent: 'decision-memo', narrative };
}

describe('ADR-096 D3+ — extractFinancialClaimsFromNarrative', () => {
  it('extracts an investment figure when narrative mentions "$X investment"', () => {
    const claims = extractFinancialClaimsFromNarrative([memo(
      'We recommend a total investment of $2.4M to deliver this initiative over 18 months.',
    )]);
    const inv = claims.find(c => c.source.endsWith(':extracted'));
    expect(inv).toBeDefined();
    expect(inv!.value).toMatch(/\$\s*2\.4\s*M/i);
  });

  it('extracts an ROI percentage when narrative mentions "ROI of X%"', () => {
    const claims = extractFinancialClaimsFromNarrative([memo(
      'The expected ROI of 167% is achievable within 18 months.',
    )]);
    const roi = claims.find(c => c.source.endsWith(':extracted-roi'));
    expect(roi).toBeDefined();
    expect(roi!.value).toMatch(/167\s*%/);
  });

  it('extracts an NPV figure when narrative mentions "NPV of $X"', () => {
    const claims = extractFinancialClaimsFromNarrative([memo(
      'The 5-year NPV of $11.9M reflects a 10% discount rate.',
    )]);
    const npv = claims.find(c => c.source.endsWith(':extracted-npv'));
    expect(npv).toBeDefined();
    expect(npv!.value).toMatch(/\$\s*11\.9\s*M/i);
  });

  it('extracts a payback period when narrative mentions "X-month payback"', () => {
    const claims = extractFinancialClaimsFromNarrative([memo(
      'A 9-month payback is forecast given the operational savings curve.',
    )]);
    const pb = claims.find(c => c.source.endsWith(':extracted-payback'));
    expect(pb).toBeDefined();
    expect(pb!.value).toMatch(/9[\s-]*months?/i);
  });

  it('returns empty when narrative has no financial mentions', () => {
    const claims = extractFinancialClaimsFromNarrative([memo(
      'This memo addresses the proposed initiative. Standard governance applies.',
    )]);
    expect(claims).toEqual([]);
  });

  it('returns empty for very short narratives (<5 chars)', () => {
    expect(extractFinancialClaimsFromNarrative([memo('OK')])).toEqual([]);
  });

  it('does NOT extract dollar amounts that appear far from anchor words', () => {
    // The dollar amount is far from "investment" — should NOT extract.
    const claims = extractFinancialClaimsFromNarrative([memo(
      'The total investment for this initiative is significant. ' + 'x'.repeat(500) + ' Some other context mentioning $100M.',
    )]);
    expect(claims.find(c => c.source.endsWith(':extracted'))).toBeUndefined();
  });

  it('extracts all 4 metrics when all are present in one narrative', () => {
    const claims = extractFinancialClaimsFromNarrative([memo(
      'Recommendation: a total investment of $2.4M targeting an ROI of 167%. ' +
      'NPV is $11.9M over 5 years, and we expect a 9-month payback.',
    )]);
    expect(claims.length).toBeGreaterThanOrEqual(4);
    const sources = claims.map(c => c.source);
    expect(sources.some(s => s.endsWith(':extracted'))).toBe(true);
    expect(sources.some(s => s.endsWith(':extracted-roi'))).toBe(true);
    expect(sources.some(s => s.endsWith(':extracted-npv'))).toBe(true);
    expect(sources.some(s => s.endsWith(':extracted-payback'))).toBe(true);
  });

  it('attributes extracted claims to the originating agent', () => {
    const claims = extractFinancialClaimsFromNarrative([
      { domain: 'platform', agent: 'decision-memo', narrative: 'investment of $2.4M' },
      { domain: 'platform', agent: 'executive-summary', narrative: 'ROI of 200%' },
    ]);
    const inv = claims.find(c => c.source.endsWith(':extracted'));
    const roi = claims.find(c => c.source.endsWith(':extracted-roi'));
    expect(inv?.agent).toBe('decision-memo');
    expect(roi?.agent).toBe('executive-summary');
  });
});
