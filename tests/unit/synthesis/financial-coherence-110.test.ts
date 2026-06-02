/**
 * ADR-PIPELINE-110 — financial coherence hardening.
 *
 * Covers: D1 (no double-$$ / single formatUsd), D3/D4 (extractor accuracy:
 * fcv-authoritative scope, sensitivity-range + derivation-prose exclusion),
 * and D5 (gate tier resolution).
 */

import { describe, it, expect, afterEach } from '@jest/globals';

import { formatUsd, buildFinancialModelFromUnitEconomics } from '../../../src/synthesis/unit-economics-loader.js';
import { extractClaims } from '../../../src/synthesis/financial-claim-extractor.js';
import { runConsistencyRules } from '../../../src/synthesis/financial-consistency-rules.js';
import { resolveFcvGate } from '../../../src/synthesis/financial-consistency-runner.js';
import { normalizeFcvKind, FCV_TOLERANCE_PCT } from '../../../src/synthesis/fcv-coherence.js';
import type { UnitEconomics } from '../../../src/pipeline/types.js';

const MANIFEST: UnitEconomics = {
  run_id: 'test',
  sector: 'manufacturing',
  domain_unit: { label: 'unit produced', abbrev: 'unit' },
  measured_scope: { units: 400_000, region_mix: ['NA'] },
  enterprise_scope: { units: 10_000_000, employees: 10_000, region_mix: ['NA'] },
  unit_savings: { usd_per_unit_produced: 0.85 },
  annual_measured_savings_usd: 340_000,
  annual_extrapolated_savings_usd: 8_500_000,
  extrapolation_method: 'linear_by_units',
  confidence: { directional: 0.88, precision: 0.42 },
  generated_at: '2026-06-02T00:00:00Z',
  source: 'test',
} as unknown as UnitEconomics;

describe('ADR-110 D1 — single formatUsd, no double-$$', () => {
  it('formatUsd includes exactly one leading $', () => {
    expect(formatUsd(340_000)).toBe('$340K');
    expect(formatUsd(8_500_000)).toBe('$8.5M');
    expect(formatUsd(0)).toBe('$0');
    expect(formatUsd(500)).toBe('$500');
  });

  it('buildFinancialModelFromUnitEconomics produces no double-$ anywhere', () => {
    const m = buildFinancialModelFromUnitEconomics(MANIFEST);
    const allText = [m.budget, m.roi, m.npv, m.payback, m.revenue, m.costSavings, m.methodology].join('\n');
    expect(allText).not.toMatch(/\$\$/);
    // the previously-buggy methodology line must be clean
    expect(m.methodology).toContain('$340K');
    expect(m.methodology).toContain('$8.5M');
    expect(m.methodology).not.toContain('$$');
  });
});

describe('ADR-110 D3/D4 — extractor accuracy', () => {
  it('D4: sensitivity-table rows are flagged and excluded from FCR-002', () => {
    // A sensitivity row whose HIGH column ($13.6M) previously got read as a
    // "pilot investment" exceeding the $8.5M savings ceiling (FCR-002 false +).
    const md = [
      '## Sensitivity Analysis',
      '',
      '| Driver | Scope | Low | High | Delta |',
      '| --- | --- | --- | --- | --- |',
      '| Scope expansion | Pilot → Enterprise | $8.50M | $13.60M | ±$5.10M |',
      '',
      '<!-- fcv:kind=investment scope=full-program doc=financial-analysis --> $3.4M – $4.8M',
    ].join('\n');
    const claims = extractClaims(md, 'financial-analysis');
    const sensitivity = claims.filter(c => c.sensitivity);
    expect(sensitivity.length).toBeGreaterThan(0);

    const violations = runConsistencyRules({ claims, manifest: MANIFEST });
    expect(violations.find(v => v.ruleId === 'FCR-002')).toBeUndefined();
  });

  it('D3: a $8.5M inside a derivation note near "pilot" does NOT become a pilot claim', () => {
    const md = [
      '<!-- fcv:kind=investment scope=full-program doc=financial-analysis --> $3.4M – $4.8M (Bottom-up unit economics; measured pilot $340K/yr scales 25× to enterprise $8.5M/yr via linear)',
    ].join('\n');
    const claims = extractClaims(md, 'financial-analysis');
    // The derivation-note $340K / $8.5M must NOT be extracted as separate claims.
    const pilotClaims = claims.filter(c => c.scope === 'pilot');
    expect(pilotClaims.length).toBe(0);
    // Only the tagged headline investment remains.
    const headline = claims.filter(c => c.kind === 'investment' && c.scope === 'full-program');
    expect(headline.length).toBe(1);
  });

  it('D3: untagged figures in tag-expecting docs are unscoped, not prose-inferred', () => {
    const md = 'The pilot will cost about $1.2M to run.'; // "pilot" nearby, but untagged
    const claims = extractClaims(md, 'financial-analysis');
    const c = claims.find(x => x.unit === 'USD');
    expect(c).toBeDefined();
    expect(c!.scope).toBe('unscoped'); // NOT 'pilot' — no prose inference in EXPECTS_TAGS docs
  });

  it('narrative (non-tag-expecting) docs still use proximity scope detection', () => {
    const md = 'The pilot will cost about $1.2M to run.';
    const claims = extractClaims(md, 'unknown');
    const c = claims.find(x => x.unit === 'USD');
    expect(c!.scope).toBe('pilot');
  });
});

describe('ADR-110 D5 — gate tier resolution', () => {
  const saved = { gate: process.env['AGENTICS_FCV_GATE'], strict: process.env['AGENTICS_STRICT_FCV'] };
  afterEach(() => {
    for (const [k, v] of [['AGENTICS_FCV_GATE', saved.gate], ['AGENTICS_STRICT_FCV', saved.strict]] as const) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  });

  it('defaults to warn (warm-up window)', () => {
    delete process.env['AGENTICS_FCV_GATE'];
    delete process.env['AGENTICS_STRICT_FCV'];
    expect(resolveFcvGate()).toBe('warn');
  });

  it('honors AGENTICS_FCV_GATE values', () => {
    process.env['AGENTICS_FCV_GATE'] = 'strict';
    expect(resolveFcvGate()).toBe('strict');
    process.env['AGENTICS_FCV_GATE'] = 'off';
    expect(resolveFcvGate()).toBe('off');
  });

  it('legacy AGENTICS_STRICT_FCV=true maps to strict', () => {
    delete process.env['AGENTICS_FCV_GATE'];
    process.env['AGENTICS_STRICT_FCV'] = 'true';
    expect(resolveFcvGate()).toBe('strict');
  });

  it('explicit option overrides env', () => {
    process.env['AGENTICS_FCV_GATE'] = 'off';
    expect(resolveFcvGate(true)).toBe('strict');
    expect(resolveFcvGate(false)).toBe('warn');
  });
});

describe('ADR-110 D6 — shared fcv primitives', () => {
  it('normalizeFcvKind canonicalizes synonyms', () => {
    expect(normalizeFcvKind('revenueImpact')).toBe('savings');
    expect(normalizeFcvKind('cost-savings')).toBe('savings');
    expect(normalizeFcvKind('paybackPeriod')).toBe('payback');
    expect(normalizeFcvKind('INVESTMENT')).toBe('investment');
    expect(normalizeFcvKind('bogus')).toBeNull();
    expect(normalizeFcvKind(undefined)).toBeNull();
  });

  it('exposes a single tolerance constant', () => {
    expect(FCV_TOLERANCE_PCT).toBeGreaterThan(0);
    expect(FCV_TOLERANCE_PCT).toBeLessThan(1);
  });
});
