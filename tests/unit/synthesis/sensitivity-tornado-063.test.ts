/**
 * ADR-PIPELINE-063 tests: multi-variable sensitivity tornado.
 *
 * Implements ADR-PIPELINE-057 §1. Verifies:
 *  - buildSensitivityTable() returns 5-7 rows ranked by absolute impact
 *  - domain-specific variables are selected based on scenario_type
 *  - ranks are unique and sequential (1..N)
 *  - the old single-variable loop (`for (const pct of [0.5, 0.75, 1.0, 1.25])`)
 *    no longer exists in the generator source
 *  - renderFinancialAnalysis emits the new Rank column and an ASCII tornado
 *    chart, and references top-2 drivers in a dynamic key takeaway
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  buildSensitivityTable,
  renderFinancialAnalysis,
} from '../../../src/synthesis/simulation-renderers.js';

// ============================================================================
// buildSensitivityTable — unit tests
// ============================================================================

describe('ADR-PIPELINE-063 — buildSensitivityTable()', () => {
  it('returns [] for a zero baseline', () => {
    expect(buildSensitivityTable(0, 'sustainability-esg')).toEqual([]);
  });

  it('returns [] for a non-finite baseline', () => {
    expect(buildSensitivityTable(NaN, 'supply-chain-management')).toEqual([]);
    expect(buildSensitivityTable(Infinity, 'supply-chain-management')).toEqual([]);
  });

  it('returns at least 5 rows for a valid baseline (domain-neutral base + 2 domain-specific)', () => {
    const rows = buildSensitivityTable(5_000_000, 'sustainability-esg');
    expect(rows.length).toBeGreaterThanOrEqual(5);
    expect(rows.length).toBeLessThanOrEqual(7);
  });

  it('assigns unique, sequential 1-based ranks', () => {
    const rows = buildSensitivityTable(5_000_000, 'sustainability-esg');
    const ranks = rows.map(r => r.rank);
    expect(ranks).toEqual([...Array(rows.length)].map((_, i) => i + 1));
    // unique
    expect(new Set(ranks).size).toBe(ranks.length);
  });

  it('rank 1 has the largest absolute impact', () => {
    const rows = buildSensitivityTable(5_000_000, 'sustainability-esg');
    const byRank = rows.slice().sort((a, b) => a.rank - b.rank);
    const byImpact = rows.slice().sort((a, b) => b.impactUsd - a.impactUsd);
    expect(byRank.map(r => r.variable)).toEqual(byImpact.map(r => r.variable));
  });

  it('is deterministic for the same inputs', () => {
    const a = buildSensitivityTable(3_000_000, 'supply-chain-management');
    const b = buildSensitivityTable(3_000_000, 'supply-chain-management');
    expect(a).toEqual(b);
  });

  it('sustainability scenario includes Data coverage and Carbon price variables', () => {
    const rows = buildSensitivityTable(5_000_000, 'sustainability-esg');
    const names = rows.map(r => r.variable);
    expect(names).toContain('Data coverage');
    expect(names).toContain('Carbon price');
  });

  it('supply-chain scenario includes Supplier reliability and Lead-time variance', () => {
    const rows = buildSensitivityTable(5_000_000, 'supply-chain-management');
    const names = rows.map(r => r.variable);
    expect(names).toContain('Supplier reliability');
    expect(names).toContain('Lead-time variance');
  });

  it('compliance scenario includes Audit cost multiplier', () => {
    const rows = buildSensitivityTable(5_000_000, 'compliance-governance');
    const names = rows.map(r => r.variable);
    expect(names).toContain('Audit cost multiplier');
  });

  it('HR workforce scenario includes Attrition rate', () => {
    const rows = buildSensitivityTable(5_000_000, 'hr-workforce-analytics');
    const names = rows.map(r => r.variable);
    expect(names).toContain('Attrition rate');
  });

  it('manufacturing scenario includes Equipment uptime', () => {
    const rows = buildSensitivityTable(5_000_000, 'manufacturing-operations');
    const names = rows.map(r => r.variable);
    expect(names).toContain('Equipment uptime');
  });

  it('unknown scenario_type falls through to generic Market conditions + Organizational readiness', () => {
    const rows = buildSensitivityTable(5_000_000, 'some-unrecognized-type');
    const names = rows.map(r => r.variable);
    expect(names).toContain('Market conditions');
    expect(names).toContain('Organizational readiness');
  });

  it('every row has the 4 domain-neutral base variables', () => {
    const rows = buildSensitivityTable(5_000_000, 'healthcare-operations');
    const names = rows.map(r => r.variable);
    expect(names).toContain('Input price variance');
    expect(names).toContain('Adoption rate');
    expect(names).toContain('Implementation timeline');
    expect(names).toContain('Scope expansion');
  });

  it('pessimistic case is at or below baseline; optimistic is at or above', () => {
    const rows = buildSensitivityTable(5_000_000, 'sustainability-esg');
    for (const row of rows) {
      expect(row.lowCaseUsd).toBeLessThanOrEqual(row.baselineUsd);
      expect(row.highCaseUsd).toBeGreaterThanOrEqual(row.baselineUsd);
    }
  });

  it('downside_only variables have baseline as high case', () => {
    const rows = buildSensitivityTable(5_000_000, 'sustainability-esg');
    const timeline = rows.find(r => r.variable === 'Implementation timeline');
    expect(timeline).toBeDefined();
    expect(timeline!.direction).toBe('downside_only');
    expect(timeline!.highCaseUsd).toBe(timeline!.baselineUsd);
    expect(timeline!.lowCaseUsd).toBeLessThan(timeline!.baselineUsd);
  });

  it('upside_only variables have baseline as low case', () => {
    const rows = buildSensitivityTable(5_000_000, 'sustainability-esg');
    const scope = rows.find(r => r.variable === 'Scope expansion');
    expect(scope).toBeDefined();
    expect(scope!.direction).toBe('upside_only');
    expect(scope!.lowCaseUsd).toBe(scope!.baselineUsd);
    expect(scope!.highCaseUsd).toBeGreaterThan(scope!.baselineUsd);
  });

  it('impactUsd is always non-negative (magnitude), impactPercent carries the sign', () => {
    const rows = buildSensitivityTable(5_000_000, 'sustainability-esg');
    for (const row of rows) {
      expect(row.impactUsd).toBeGreaterThanOrEqual(0);
    }
  });
});

// ============================================================================
// renderFinancialAnalysis — integration tests
// ============================================================================

describe('ADR-PIPELINE-063 — renderFinancialAnalysis sensitivity block', () => {
  it('emits the new Rank column header, not the old "Reduction Target"', () => {
    const output = renderFinancialAnalysis(
      'We need to optimize our sustainability program to reduce carbon emissions across our enterprise.',
      null,
      [],
    );
    expect(output).toContain('## Sensitivity Analysis');
    expect(output).toContain('| Rank |');
    expect(output).not.toContain('| Reduction Target |');
  });

  it('emits the ASCII tornado chart code fence', () => {
    const output = renderFinancialAnalysis(
      'We need to improve supply chain resilience across 50 suppliers and reduce lead-time variance.',
      null,
      [],
    );
    expect(output).toContain('### Tornado Chart');
    expect(output).toMatch(/█+/);
  });

  it('emits a dynamically computed key takeaway referencing the top driver', () => {
    const output = renderFinancialAnalysis(
      'Improve energy efficiency across 200 manufacturing sites to reduce carbon emissions and costs.',
      null,
      [],
    );
    expect(output).toContain('**Key takeaway:**');
    // The top driver (Scope expansion has 0.60 impact fraction, highest in base set)
    // should be mentioned explicitly when no domain-specific variable exceeds it
    expect(output).toMatch(/most sensitive to \*\*[A-Z]/);
  });

  it('does not contain the legacy single-variable loop labels', () => {
    const output = renderFinancialAnalysis(
      'Reduce supplier concentration risk across procurement.',
      null,
      [],
    );
    expect(output).not.toContain('Conservative (50%)');
    expect(output).not.toContain('Aggressive (125%)');
    expect(output).not.toContain('Impact of varying the primary improvement target');
  });
});

// ============================================================================
// Generator source regression check — ensures old pattern is fully removed
// ============================================================================

describe('ADR-PIPELINE-063 — source code regression', () => {
  it('simulation-renderers.ts no longer contains the single-variable loop', () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), 'src/synthesis/simulation-renderers.ts'),
      'utf-8',
    );
    // The old loop
    expect(source).not.toMatch(/for \(const pct of \[0\.5, 0\.75, 1\.0, 1\.25\]\)/);
    // The old table header
    expect(source).not.toContain('| Reduction Target | Projected Savings | ROI | Payback |');
  });

  it('simulation-renderers.ts exports buildSensitivityTable', () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), 'src/synthesis/simulation-renderers.ts'),
      'utf-8',
    );
    expect(source).toContain('export function buildSensitivityTable');
    expect(source).toContain('export interface SensitivityRow');
  });
});
