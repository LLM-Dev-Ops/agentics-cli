/**
 * ADR-PIPELINE-098 D8 — coherence-gate financial validator tests.
 *
 * The gate scans every emitted deliverable for `<!-- fcv:kind=... -->` blocks,
 * extracts the dollar value or duration, compares to unit-economics.json, and
 * flags anything outside ±5% as a coherence violation.
 *
 * The gate module (`src/pipeline/phase7/coherence-gate.ts`) is being authored
 * in parallel — until it lands, these tests fail at import (the correct
 * signal). The expected entry-point shape is `runCoherenceGate({ deliverableDir
 * | filePath, unitEconomicsPath })` returning a report `{ violations: [...] }`.
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { runCoherenceGate } from '../../../../src/pipeline/phase7/coherence-gate.js';

let tmpDir: string;

/**
 * Mirrors the keys the production `loadCanonical()` actually reads
 * (ADR-PIPELINE-066 unit-economics manifest, surfaced through the gate's
 * `loadCanonical`). Notably savings is keyed off
 * `pilot_savings_per_year` / `enterprise_savings_per_year` and NPV off
 * `npv_5yr` (not `npv_3yr`).
 */
interface UnitEconomicsFixture {
  readonly pilot_savings_per_year?: number;
  readonly enterprise_savings_per_year?: number;
  readonly investment_total?: number;
  readonly enterprise_investment?: number;
  readonly pilot_investment?: number;
  readonly npv_5yr?: number;
  readonly roi_pct?: number;
  readonly payback_months?: number;
  readonly timeline_months?: number;
}

function writeUnitEconomics(dir: string, ue: UnitEconomicsFixture): string {
  const p = path.join(dir, 'unit-economics.json');
  fs.writeFileSync(p, JSON.stringify(ue, null, 2));
  return p;
}

function writeDeliverable(dir: string, slug: string, body: string): string {
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, `${slug}.md`);
  fs.writeFileSync(p, body);
  return p;
}

/**
 * Build a minimal Phase-7-shaped deliverables tree
 * (`<root>/01-executive/<slug>.md`) so the production gate's slug+section
 * derivation (which keys off the `NN-` prefix on the parent dir) works the
 * same way it does in production.
 */
function makeDeliverablesRoot(parent: string): string {
  const root = path.join(parent, 'deliverables');
  fs.mkdirSync(path.join(root, '01-executive'), { recursive: true });
  return root;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase7-cohere-'));
});

afterEach(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

// --------------------------------------------------------------------------
// Test 1 — savings within ±5% -> no violation.
// --------------------------------------------------------------------------

describe('ADR-098 D8 — savings within tolerance', () => {
  it('Test 1: $2.3M vs canonical $2.2M -> within ±5% -> no violation', async () => {
    const ue = writeUnitEconomics(tmpDir, { pilot_savings_per_year: 2_200_000 });
    const root = makeDeliverablesRoot(tmpDir);
    // Tag-then-figure convention (financial-claim-extractor.ts): the dollar
    // token follows the closing `-->` directly, optional whitespace only.
    writeDeliverable(
      path.join(root, '01-executive'),
      'business-case-base',
      [
        '# Business Case — Base',
        '',
        '<!-- fcv:kind=savings scope=pilot --> $2.3M',
        '',
      ].join('\n')
    );

    const report = await runCoherenceGate(root, ue);

    expect(report.violations).toEqual([]);
  });
});

// --------------------------------------------------------------------------
// Test 2 — savings off by >5% -> exactly one violation, kind=savings,
// delta_pct ≈ +22.7.
// --------------------------------------------------------------------------

describe('ADR-098 D8 — savings outside tolerance', () => {
  it('Test 2: $2.7M vs canonical $2.2M -> ONE violation, kind=savings, delta_pct ≈ +22.7', async () => {
    const ue = writeUnitEconomics(tmpDir, { pilot_savings_per_year: 2_200_000 });
    const root = makeDeliverablesRoot(tmpDir);
    writeDeliverable(
      path.join(root, '01-executive'),
      'business-case-best',
      [
        '# Business Case — Best',
        '',
        '<!-- fcv:kind=savings scope=pilot --> $2.7M',
        '',
      ].join('\n')
    );

    const report = await runCoherenceGate(root, ue);

    expect(report.violations).toHaveLength(1);
    const v = report.violations[0]!;
    expect(v.kind).toBe('savings');
    // (2.7 - 2.2) / 2.2 * 100 ≈ 22.727...
    expect(typeof v.delta_pct).toBe('number');
    expect(v.delta_pct).toBeGreaterThan(22);
    expect(v.delta_pct).toBeLessThan(24);
  });
});

// --------------------------------------------------------------------------
// Test 3 — range value containing the canonical -> no violation.
// --------------------------------------------------------------------------

describe('ADR-098 D8 — range covers canonical', () => {
  it('Test 3: "$22.1M – $30.9M" with canonical $25M -> within range -> no violation', async () => {
    // Canonical npv_3yr = $25M.
    const ue = writeUnitEconomics(tmpDir, { npv_5yr: 25_000_000 });
    const root = makeDeliverablesRoot(tmpDir);
    writeDeliverable(
      path.join(root, '01-executive'),
      'financial-model-3to5yr',
      [
        '# Financial Model',
        '',
        '<!-- fcv:kind=npv scope=3yr --> $22.1M – $30.9M',
        '',
      ].join('\n')
    );

    const report = await runCoherenceGate(root, ue);

    expect(report.violations).toEqual([]);
  });
});

// --------------------------------------------------------------------------
// Test 4 — range value missing the canonical -> ONE violation.
// --------------------------------------------------------------------------

describe('ADR-098 D8 — range misses canonical', () => {
  it('Test 4: "$5M – $7M" with canonical $25M -> out-of-range -> ONE violation', async () => {
    const ue = writeUnitEconomics(tmpDir, { npv_5yr: 25_000_000 });
    const root = makeDeliverablesRoot(tmpDir);
    writeDeliverable(
      path.join(root, '01-executive'),
      'financial-model-worst',
      [
        '# Financial Model — Worst',
        '',
        '<!-- fcv:kind=npv scope=3yr --> $5M – $7M',
        '',
      ].join('\n')
    );

    const report = await runCoherenceGate(root, ue);

    expect(report.violations).toHaveLength(1);
    expect(report.violations[0]!.kind).toBe('npv');
  });
});

// --------------------------------------------------------------------------
// Test 5 — payback duration matches -> no violation.
// --------------------------------------------------------------------------

describe('ADR-098 D8 — payback within tolerance', () => {
  it('Test 5: "5 months" with canonical payback_months=5 -> no violation', async () => {
    const ue = writeUnitEconomics(tmpDir, { payback_months: 5 });
    const root = makeDeliverablesRoot(tmpDir);
    writeDeliverable(
      path.join(root, '01-executive'),
      'business-case-base',
      [
        '# Business Case',
        '',
        '<!-- fcv:kind=payback scope=pilot --> 5 months',
        '',
      ].join('\n')
    );

    const report = await runCoherenceGate(root, ue);

    expect(report.violations).toEqual([]);
  });
});

// --------------------------------------------------------------------------
// Test 6 — payback duration off by >5% -> ONE violation.
// --------------------------------------------------------------------------

describe('ADR-098 D8 — payback outside tolerance', () => {
  it('Test 6: "12 months" with canonical 5 -> outside 5% -> ONE violation', async () => {
    const ue = writeUnitEconomics(tmpDir, { payback_months: 5 });
    const root = makeDeliverablesRoot(tmpDir);
    writeDeliverable(
      path.join(root, '01-executive'),
      'business-case-worst',
      [
        '# Business Case — Worst',
        '',
        '<!-- fcv:kind=payback scope=pilot --> 12 months',
        '',
      ].join('\n')
    );

    const report = await runCoherenceGate(root, ue);

    expect(report.violations).toHaveLength(1);
    expect(report.violations[0]!.kind).toBe('payback');
  });
});

// --------------------------------------------------------------------------
// Test 7 — markdown without fcv tags is scanned without error and produces
// zero violations.
// --------------------------------------------------------------------------

describe('ADR-098 D8 — no fcv tags', () => {
  it('Test 7: a markdown file without fcv tags produces zero violations and no error', async () => {
    const ue = writeUnitEconomics(tmpDir, {
      pilot_savings_per_year: 2_200_000,
      npv_5yr: 25_000_000,
      payback_months: 5,
    });
    const root = makeDeliverablesRoot(tmpDir);
    writeDeliverable(
      path.join(root, '01-executive'),
      'process-maps',
      [
        '# Process Maps',
        '',
        'Pure narrative content. No fcv tags here.',
        '',
        'Multiple paragraphs, no embedded financials.',
        '',
      ].join('\n')
    );

    let report: Awaited<ReturnType<typeof runCoherenceGate>>;
    try {
      report = await runCoherenceGate(root, ue);
    } catch (err) {
      throw new Error(
        `Gate must not throw on tagless files; threw: ${(err as Error).message}`
      );
    }

    expect(report.violations).toEqual([]);
  });
});

// --------------------------------------------------------------------------
// Test 8 — directory with multiple files, exactly 2 with violations -> 2
// violations whose slugs map back to the offending filenames.
// --------------------------------------------------------------------------

describe('ADR-098 D8 — directory scan', () => {
  it('Test 8: directory with exactly 2 violating files -> violations.length === 2 with correct slugs', async () => {
    const ue = writeUnitEconomics(tmpDir, {
      pilot_savings_per_year: 2_200_000,
      payback_months: 5,
    });

    const root = makeDeliverablesRoot(tmpDir);
    const sectionDir = path.join(root, '01-executive');

    // CLEAN — savings within tolerance
    fs.writeFileSync(
      path.join(sectionDir, 'clean-one.md'),
      [
        '# Clean One',
        '<!-- fcv:kind=savings scope=pilot --> $2.25M',
        '',
      ].join('\n')
    );
    // CLEAN — no fcv tags at all
    fs.writeFileSync(
      path.join(sectionDir, 'clean-two.md'),
      '# Clean Two\n\nnarrative only.\n'
    );

    // VIOLATION — savings far off
    fs.writeFileSync(
      path.join(sectionDir, 'bad-savings.md'),
      [
        '# Bad Savings',
        '<!-- fcv:kind=savings scope=pilot --> $5.0M',
        '',
      ].join('\n')
    );
    // VIOLATION — payback far off
    fs.writeFileSync(
      path.join(sectionDir, 'bad-payback.md'),
      [
        '# Bad Payback',
        '<!-- fcv:kind=payback scope=pilot --> 15 months',
        '',
      ].join('\n')
    );

    const report = await runCoherenceGate(root, ue);

    expect(report.violations).toHaveLength(2);

    const slugs = report.violations.map((v) => v.slug).sort();
    expect(slugs).toEqual(['bad-payback', 'bad-savings']);
  });
});
