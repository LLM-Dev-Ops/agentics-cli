/**
 * ADR-PIPELINE-067 tests: cross-document financial consistency validator.
 *
 * Verifies:
 *  - parseCurrency handles $K/$M/$B, $1,200,000, USD X M, "1.2 million dollars"
 *  - extractClaims picks up investment/savings/timeline/headcount/roi kinds,
 *    scopes them correctly, and respects HTML fcv: tags
 *  - Each FCR-001..009 rule has a positive and a negative case
 *  - The OPERA-style contradiction is detected as FCR-003
 *  - runConsistencyCheck writes financial-consistency.report.json with the
 *    expected shape and prepends a warning header under non-strict mode
 *  - Strict mode (AGENTICS_STRICT_FCV=true) throws FinancialConsistencyError
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  parseCurrency,
  extractClaims,
  type FinancialClaim,
  type FinancialClaimDocument,
} from '../../../src/synthesis/financial-claim-extractor.js';
import {
  runConsistencyRules,
  __internal,
} from '../../../src/synthesis/financial-consistency-rules.js';
import {
  runConsistencyCheck,
  FinancialConsistencyError,
} from '../../../src/synthesis/financial-consistency-runner.js';
import type { UnitEconomics } from '../../../src/pipeline/types.js';

// ============================================================================
// Fixtures
// ============================================================================

function mkTempDir(label: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `adr067-${label}-`));
}

function claim(overrides: Partial<FinancialClaim>): FinancialClaim {
  return {
    document: 'executive-summary',
    section: 'test',
    kind: 'investment',
    scope: 'unscoped',
    unit: 'USD',
    rawText: '$1M',
    line: 1,
    tagged: false,
    ...overrides,
  };
}

function hospitalityManifest(): UnitEconomics {
  return {
    run_id: 'sim-test-067',
    sector: 'hospitality',
    domain_unit: { label: 'occupied room night', abbrev: 'orn' },
    measured_scope: { properties: 4, rooms: 1450, region_mix: ['NA', 'EMEA', 'APAC'] },
    enterprise_scope: { properties: 100, rooms: 36250, employees: 91000, region_mix: ['NA', 'EMEA', 'APAC'] },
    unit_savings: { usd_per_orn: 0.82 },
    annual_measured_savings_usd: 1_200_000,
    annual_extrapolated_savings_usd: 30_000_000,
    extrapolation_method: 'linear_by_rooms',
    confidence: { directional: 0.9, precision: 0.4 },
    source: 'prototype',
  };
}

// ============================================================================
// parseCurrency
// ============================================================================

describe('ADR-067 — parseCurrency', () => {
  it('parses suffix notation', () => {
    expect(parseCurrency('$1.2M')).toBe(1_200_000);
    expect(parseCurrency('$600K')).toBe(600_000);
    expect(parseCurrency('$2.5B')).toBe(2_500_000_000);
  });

  it('parses comma notation', () => {
    expect(parseCurrency('$1,200,000')).toBe(1_200_000);
    expect(parseCurrency('$600,000')).toBe(600_000);
  });

  it('parses USD prefix', () => {
    expect(parseCurrency('USD 1.2M')).toBe(1_200_000);
  });

  it('parses spelled magnitudes', () => {
    expect(parseCurrency('1.2 million dollars')).toBe(1_200_000);
    expect(parseCurrency('600 thousand dollars')).toBe(600_000);
  });

  it('returns NaN for non-currency', () => {
    expect(Number.isNaN(parseCurrency('not money'))).toBe(true);
  });
});

// ============================================================================
// extractClaims — basic shape + tags
// ============================================================================

describe('ADR-067 — extractClaims', () => {
  it('extracts a simple investment claim with a scope label', () => {
    const md = `## Investment
The **pilot investment** is $1.0M–$1.4M over 12 weeks.
`;
    const claims = extractClaims(md, 'executive-summary');
    const investment = claims.find(c => c.kind === 'investment');
    expect(investment).toBeDefined();
    expect(investment!.rangeLow).toBe(1_000_000);
    expect(investment!.rangeHigh).toBe(1_400_000);
    expect(investment!.scope).toBe('pilot');
  });

  it('respects fcv: HTML tag on the preceding line', () => {
    const md = `## Investment
<!-- fcv:kind=investment scope=full-program -->
$2.7M–$4.1M for the full program rollout.
`;
    const claims = extractClaims(md, 'decision-memo');
    const tagged = claims.find(c => c.tagged);
    expect(tagged).toBeDefined();
    expect(tagged!.scope).toBe('full-program');
    expect(tagged!.rangeLow).toBe(2_700_000);
  });

  it('picks up headcount mentions', () => {
    const md = `Our group has 91,000 employees across three regions.`;
    const claims = extractClaims(md, 'executive-summary');
    const hc = claims.find(c => c.kind === 'headcount');
    expect(hc?.pointValue).toBe(91000);
  });

  it('picks up timeline mentions but ignores history references', () => {
    const md = `This 12-week pilot follows our work over the past 3 years.`;
    const claims = extractClaims(md, 'executive-summary');
    const timelines = claims.filter(c => c.kind === 'timeline');
    // "12 weeks" → included; "3 years" → filtered out by history heuristic
    expect(timelines.some(c => c.pointValue === 12 && c.unit === 'weeks')).toBe(true);
    expect(timelines.some(c => c.pointValue === 3 && c.unit === 'years')).toBe(false);
  });

  it('ignores $/unit unit-price mentions', () => {
    const md = `Unit price is $0.82 per occupied room night.`;
    const claims = extractClaims(md, 'executive-summary');
    expect(claims).toHaveLength(0);
  });

  it('tracks the current section heading', () => {
    const md = `# Title

## Investment Summary
Pilot investment: $1.0M (pilot).

## Savings
Annual savings: $30M (full program).
`;
    const claims = extractClaims(md, 'executive-summary');
    const investment = claims.find(c => c.kind === 'investment');
    const savings = claims.find(c => c.kind === 'savings');
    expect(investment?.section).toBe('Investment Summary');
    expect(savings?.section).toBe('Savings');
  });
});

// ============================================================================
// Individual rules — pass and fail cases
// ============================================================================

describe('ADR-067 — FCR-001 range overlap across documents', () => {
  it('passes when ranges overlap', () => {
    const claims: FinancialClaim[] = [
      claim({ document: 'executive-summary', kind: 'investment', scope: 'pilot', rangeLow: 1_000_000, rangeHigh: 1_400_000 }),
      claim({ document: 'decision-memo', kind: 'investment', scope: 'pilot', rangeLow: 1_200_000, rangeHigh: 1_600_000 }),
    ];
    expect(__internal.ruleFcr001(claims)).toHaveLength(0);
  });

  it('fails when ranges disjoint', () => {
    const claims: FinancialClaim[] = [
      claim({ document: 'executive-summary', kind: 'investment', scope: 'pilot', rangeLow: 1_000_000, rangeHigh: 1_400_000 }),
      claim({ document: 'decision-memo', kind: 'investment', scope: 'pilot', rangeLow: 2_700_000, rangeHigh: 4_100_000 }),
    ];
    const violations = __internal.ruleFcr001(claims);
    expect(violations).toHaveLength(1);
    expect(violations[0]!.ruleId).toBe('FCR-001');
  });
});

describe('ADR-067 — FCR-002 pilot ≤ full-program', () => {
  it('passes when pilot is inside full-program', () => {
    const claims: FinancialClaim[] = [
      claim({ document: 'executive-summary', kind: 'investment', scope: 'pilot', pointValue: 1_000_000 }),
      claim({ document: 'executive-summary', kind: 'investment', scope: 'full-program', rangeLow: 2_700_000, rangeHigh: 4_100_000 }),
    ];
    const vs = __internal.ruleFcr002and003(claims);
    expect(vs.filter(v => v.ruleId === 'FCR-002')).toHaveLength(0);
  });

  it('fails when pilot exceeds the full-program ceiling', () => {
    const claims: FinancialClaim[] = [
      claim({ document: 'executive-summary', kind: 'investment', scope: 'pilot', pointValue: 6_000_000 }),
      claim({ document: 'executive-summary', kind: 'investment', scope: 'full-program', rangeLow: 2_700_000, rangeHigh: 4_100_000 }),
    ];
    const vs = __internal.ruleFcr002and003(claims);
    expect(vs.some(v => v.ruleId === 'FCR-002')).toBe(true);
  });
});

describe('ADR-067 — FCR-003 phase-1 subset of full-program (OPERA regression)', () => {
  it('detects the OPERA-style contradiction', () => {
    // Exec summary says $2.7M–$4.1M labeled as pilot; decision memo says $1.0M pilot, $2.7M–$4.1M full.
    const claims: FinancialClaim[] = [
      claim({
        document: 'executive-summary', section: 'Investment', kind: 'investment', scope: 'pilot',
        rangeLow: 2_700_000, rangeHigh: 4_100_000, rawText: '$2.7M–$4.1M',
      }),
      claim({
        document: 'decision-memo', section: 'Investment', kind: 'investment', scope: 'pilot',
        pointValue: 1_000_000, rawText: '$1.0M',
      }),
      claim({
        document: 'decision-memo', section: 'Investment', kind: 'investment', scope: 'full-program',
        rangeLow: 2_700_000, rangeHigh: 4_100_000, rawText: '$2.7M–$4.1M',
      }),
    ];
    const vs = __internal.ruleFcr002and003(claims);
    expect(vs.some(v => v.ruleId === 'FCR-003')).toBe(true);
  });

  it('passes when pilot and full-program ranges are distinct', () => {
    const claims: FinancialClaim[] = [
      claim({ document: 'executive-summary', kind: 'investment', scope: 'pilot', rangeLow: 800_000, rangeHigh: 1_200_000 }),
      claim({ document: 'decision-memo', kind: 'investment', scope: 'full-program', rangeLow: 2_700_000, rangeHigh: 4_100_000 }),
    ];
    const vs = __internal.ruleFcr002and003(claims);
    expect(vs.filter(v => v.ruleId === 'FCR-003')).toHaveLength(0);
  });
});

describe('ADR-067 — FCR-004 every currency claim must be scoped', () => {
  it('fails on unscoped currency claim', () => {
    const claims: FinancialClaim[] = [
      claim({ rawText: '$1M', pointValue: 1_000_000, scope: 'unscoped' }),
    ];
    const vs = __internal.ruleFcr004(claims);
    expect(vs).toHaveLength(1);
    expect(vs[0]!.ruleId).toBe('FCR-004');
  });

  it('passes when an fcv: tag is present', () => {
    const claims: FinancialClaim[] = [
      claim({ rawText: '$1M', pointValue: 1_000_000, scope: 'unscoped', tagged: true }),
    ];
    expect(__internal.ruleFcr004(claims)).toHaveLength(0);
  });
});

describe('ADR-067 — FCR-005 timeline consistency', () => {
  it('passes when both docs agree within ±1 week', () => {
    const claims: FinancialClaim[] = [
      claim({ document: 'executive-summary', kind: 'timeline', scope: 'pilot', pointValue: 12, unit: 'weeks' }),
      claim({ document: 'decision-memo', kind: 'timeline', scope: 'pilot', pointValue: 12, unit: 'weeks' }),
    ];
    expect(__internal.ruleFcr005(claims)).toHaveLength(0);
  });

  it('fails when docs disagree on pilot timeline', () => {
    const claims: FinancialClaim[] = [
      claim({ document: 'executive-summary', kind: 'timeline', scope: 'pilot', pointValue: 12, unit: 'weeks' }),
      claim({ document: 'decision-memo', kind: 'timeline', scope: 'pilot', pointValue: 20, unit: 'weeks' }),
    ];
    const vs = __internal.ruleFcr005(claims);
    expect(vs).toHaveLength(1);
    expect(vs[0]!.ruleId).toBe('FCR-005');
  });
});

describe('ADR-067 — FCR-006 ROI sanity (warn)', () => {
  it('warns when savings÷investment does not match stated ROI', () => {
    const claims: FinancialClaim[] = [
      claim({ document: 'executive-summary', kind: 'investment', scope: 'pilot', pointValue: 1_000_000, rawText: '$1M' }),
      claim({ document: 'executive-summary', kind: 'savings', scope: 'pilot', pointValue: 2_000_000, rawText: '$2M' }),
      claim({ document: 'executive-summary', kind: 'roi', scope: 'pilot', pointValue: 1200, unit: 'percent', rawText: '1200%' }),
    ];
    const vs = __internal.ruleFcr006(claims);
    expect(vs.some(v => v.ruleId === 'FCR-006')).toBe(true);
  });

  it('passes when savings÷investment matches stated ROI', () => {
    const claims: FinancialClaim[] = [
      claim({ document: 'executive-summary', kind: 'investment', scope: 'pilot', pointValue: 1_000_000, rawText: '$1M' }),
      claim({ document: 'executive-summary', kind: 'savings', scope: 'pilot', pointValue: 2_000_000, rawText: '$2M' }),
      claim({ document: 'executive-summary', kind: 'roi', scope: 'pilot', pointValue: 200, unit: 'percent', rawText: '200%' }),
    ];
    expect(__internal.ruleFcr006(claims)).toHaveLength(0);
  });
});

describe('ADR-067 — FCR-007 matches unit-economics manifest ±1%', () => {
  it('passes when enterprise savings match the manifest', () => {
    const manifest = hospitalityManifest();
    const claims: FinancialClaim[] = [
      claim({ document: 'executive-summary', kind: 'savings', scope: 'full-program', pointValue: 30_000_000 }),
    ];
    expect(__internal.ruleFcr007(claims, manifest)).toHaveLength(0);
  });

  it('fails when enterprise savings drift past 1%', () => {
    const manifest = hospitalityManifest();
    const claims: FinancialClaim[] = [
      claim({ document: 'executive-summary', kind: 'savings', scope: 'full-program', pointValue: 35_000_000 }),
    ];
    const vs = __internal.ruleFcr007(claims, manifest);
    expect(vs.some(v => v.ruleId === 'FCR-007')).toBe(true);
  });
});

describe('ADR-067 — FCR-008 scope ratio matches manifest ±5%', () => {
  it('passes when printed ratio matches manifest', () => {
    const manifest = hospitalityManifest();
    const claims: FinancialClaim[] = [
      claim({ document: 'decision-memo', kind: 'savings', scope: 'pilot', pointValue: 1_200_000 }),
      claim({ document: 'decision-memo', kind: 'savings', scope: 'full-program', pointValue: 30_000_000 }),
    ];
    expect(__internal.ruleFcr008(claims, manifest)).toHaveLength(0);
  });

  it('fails when printed ratio deviates past 5%', () => {
    const manifest = hospitalityManifest();
    // Manifest ratio is 25x; try 10x.
    const claims: FinancialClaim[] = [
      claim({ document: 'decision-memo', kind: 'savings', scope: 'pilot', pointValue: 1_200_000 }),
      claim({ document: 'decision-memo', kind: 'savings', scope: 'full-program', pointValue: 12_000_000 }),
    ];
    const vs = __internal.ruleFcr008(claims, manifest);
    expect(vs.some(v => v.ruleId === 'FCR-008')).toBe(true);
  });
});

describe('ADR-067 — FCR-009 single headline figure per document', () => {
  it('warns when a document has two distinct full-program headline figures', () => {
    const claims: FinancialClaim[] = [
      claim({ document: 'executive-summary', kind: 'savings', scope: 'full-program', pointValue: 30_000_000, rawText: '$30M' }),
      claim({ document: 'executive-summary', kind: 'savings', scope: 'full-program', pointValue: 4_100_000, rawText: '$4.1M' }),
    ];
    const vs = __internal.ruleFcr009(claims);
    expect(vs.some(v => v.ruleId === 'FCR-009')).toBe(true);
  });

  it('passes when the same figure is repeated', () => {
    const claims: FinancialClaim[] = [
      claim({ document: 'executive-summary', kind: 'savings', scope: 'full-program', pointValue: 30_000_000, rawText: '$30M' }),
      claim({ document: 'executive-summary', kind: 'savings', scope: 'full-program', pointValue: 30_000_000, rawText: '$30M' }),
    ];
    expect(__internal.ruleFcr009(claims)).toHaveLength(0);
  });
});

// ============================================================================
// runConsistencyRules — aggregate
// ============================================================================

describe('ADR-067 — runConsistencyRules', () => {
  it('returns an empty list for a self-consistent single-doc fixture', () => {
    // ADR-PIPELINE-096 D3 (2.7.12): tagged headline-metric claims need a
    // src= attribution to clear FCR-013. Adding `srcTag` here matches what
    // the renderer now emits on every healthy run (canonical agent OR
    // heuristic).
    const claims: FinancialClaim[] = [
      claim({ document: 'executive-summary', kind: 'investment', scope: 'pilot', pointValue: 1_000_000, tagged: true, srcTag: 'heuristic:per-employee-test' }),
      claim({ document: 'executive-summary', kind: 'savings', scope: 'pilot', pointValue: 2_000_000, tagged: true, srcTag: 'heuristic:per-employee-test' }),
    ];
    expect(runConsistencyRules({ claims })).toHaveLength(0);
  });
});

// ============================================================================
// Runner — report file + annotation + strict mode
// ============================================================================

describe('ADR-067 — runConsistencyCheck runner', () => {
  const CLEAN_EXEC = `# Executive Summary

## Investment
<!-- fcv:kind=investment scope=pilot -->
Pilot investment: $1.0M–$1.4M.

## Savings
<!-- fcv:kind=savings scope=full-program -->
Enterprise savings: $30M annually.
`;

  const CLEAN_MEMO = `# Decision Memo

## Investment
<!-- fcv:kind=investment scope=pilot -->
$1.0M–$1.4M pilot investment.

<!-- fcv:kind=investment scope=full-program -->
$2.7M–$4.1M full program investment.

## Savings
<!-- fcv:kind=savings scope=full-program -->
$30M enterprise annual savings.
`;

  const BROKEN_EXEC = `# Executive Summary

## Investment
Pilot investment: $2.7M–$4.1M (12-week pilot).
`;

  const BROKEN_MEMO = `# Decision Memo

## Investment
$1.0M pilot, $2.7M–$4.1M full deployment.
`;

  it('writes financial-consistency.report.json with the expected shape', () => {
    const dir = mkTempDir('runner-clean');
    try {
      const execPath = path.join(dir, 'executive-summary.md');
      const memoPath = path.join(dir, 'decision-memo.md');
      fs.writeFileSync(execPath, CLEAN_EXEC, 'utf-8');
      fs.writeFileSync(memoPath, CLEAN_MEMO, 'utf-8');

      const result = runConsistencyCheck({
        runDir: dir,
        documents: [
          { kind: 'executive-summary', path: execPath, content: CLEAN_EXEC },
          { kind: 'decision-memo', path: memoPath, content: CLEAN_MEMO },
        ],
        annotateDocuments: false,
      });

      expect(fs.existsSync(result.reportPath)).toBe(true);
      const report = JSON.parse(fs.readFileSync(result.reportPath, 'utf-8')) as Record<string, unknown>;
      expect(report['passed']).toBe(true);
      expect(report['documents_scanned']).toBe(2);
      expect(typeof report['run_id']).toBe('string');
      expect(Array.isArray(report['violations'])).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('detects the OPERA contradiction end-to-end', () => {
    const dir = mkTempDir('runner-opera');
    try {
      const execPath = path.join(dir, 'executive-summary.md');
      const memoPath = path.join(dir, 'decision-memo.md');
      fs.writeFileSync(execPath, BROKEN_EXEC, 'utf-8');
      fs.writeFileSync(memoPath, BROKEN_MEMO, 'utf-8');

      const result = runConsistencyCheck({
        runDir: dir,
        documents: [
          { kind: 'executive-summary', path: execPath, content: BROKEN_EXEC },
          { kind: 'decision-memo', path: memoPath, content: BROKEN_MEMO },
        ],
        annotateDocuments: false,
        strict: false,
      });

      expect(result.report.passed).toBe(false);
      expect(result.violations.some(v => v.ruleId === 'FCR-003')).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('prepends a warning header to affected documents under annotate mode', () => {
    const dir = mkTempDir('runner-annotate');
    try {
      const execPath = path.join(dir, 'executive-summary.md');
      const memoPath = path.join(dir, 'decision-memo.md');
      fs.writeFileSync(execPath, BROKEN_EXEC, 'utf-8');
      fs.writeFileSync(memoPath, BROKEN_MEMO, 'utf-8');

      runConsistencyCheck({
        runDir: dir,
        documents: [
          { kind: 'executive-summary', path: execPath, content: BROKEN_EXEC },
          { kind: 'decision-memo', path: memoPath, content: BROKEN_MEMO },
        ],
        annotateDocuments: true,
        strict: false,
      });

      const annotated = fs.readFileSync(memoPath, 'utf-8');
      expect(annotated).toMatch(/Financial consistency/);
      expect(annotated).toMatch(/FCR-/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('throws FinancialConsistencyError under strict mode on errors', () => {
    const dir = mkTempDir('runner-strict');
    try {
      const execPath = path.join(dir, 'executive-summary.md');
      const memoPath = path.join(dir, 'decision-memo.md');
      fs.writeFileSync(execPath, BROKEN_EXEC, 'utf-8');
      fs.writeFileSync(memoPath, BROKEN_MEMO, 'utf-8');

      expect(() =>
        runConsistencyCheck({
          runDir: dir,
          documents: [
            { kind: 'executive-summary', path: execPath, content: BROKEN_EXEC },
            { kind: 'decision-memo', path: memoPath, content: BROKEN_MEMO },
          ],
          annotateDocuments: false,
          strict: true,
        }),
      ).toThrow(FinancialConsistencyError);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('passes through a unit-economics manifest to FCR-007/008', () => {
    const dir = mkTempDir('runner-manifest');
    try {
      const manifest = hospitalityManifest();
      fs.writeFileSync(path.join(dir, 'unit-economics.json'), JSON.stringify(manifest), 'utf-8');

      const doc = `# Executive Summary

## Savings
<!-- fcv:kind=savings scope=full-program -->
Enterprise annual savings: $35M.

<!-- fcv:kind=savings scope=pilot -->
Pilot annual savings: $1.2M.
`;
      const docPath = path.join(dir, 'executive-summary.md');
      fs.writeFileSync(docPath, doc, 'utf-8');

      const result = runConsistencyCheck({
        runDir: dir,
        documents: [{ kind: 'executive-summary', path: docPath, content: doc }],
        annotateDocuments: false,
      });

      expect(result.violations.some(v => v.ruleId === 'FCR-007')).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ============================================================================
// Sanity: document type coverage
// ============================================================================

describe('ADR-067 — document type labels', () => {
  it('supports the five core document kinds', () => {
    const kinds: FinancialClaimDocument[] = [
      'executive-summary',
      'decision-memo',
      'roadmap',
      'business-case',
      'risk-register',
    ];
    for (const k of kinds) {
      const claims = extractClaims(`Pilot investment: $1M.`, k);
      expect(claims[0]?.document).toBe(k);
    }
  });
});
