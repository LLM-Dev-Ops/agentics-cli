/**
 * ADR-PIPELINE-098 — Phase 7 performance benchmarks.
 *
 * Exercises the deterministic, no-Ruflo paths that run on every Phase 7
 * invocation regardless of cloud availability:
 *   - registry walk (87 rows)
 *   - template-renderer placeholder substitution
 *   - coherence gate fcv-tag scan over a populated deliverables/ tree
 *
 * Targets (validated on a 4-vCPU developer VM, single-thread):
 *   - registry filter+map over 87 rows: <2ms
 *   - 87 template renders × ~3KB body × 12 placeholders: <60ms total
 *   - coherence gate over 87 markdown files (≈260KB total) with 4 fcv tags
 *     each: <250ms total
 */

import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { DELIVERABLES_REGISTRY } from '../../src/pipeline/phase7/deliverables-registry.js';
import { renderTemplate } from '../../src/pipeline/phase7/template-renderer.js';
import { runCoherenceGate } from '../../src/pipeline/phase7/coherence-gate.js';

let benchDir: string;

beforeAll(() => {
  benchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase7-bench-'));

  // Seed a unit-economics.json the gate can compare against.
  fs.writeFileSync(
    path.join(benchDir, 'unit-economics.json'),
    JSON.stringify({
      annual_measured_savings_usd: 2_200_000,
      annual_extrapolated_savings_usd: 55_300_000,
      payback_months: 5,
      npv_5yr: 171_300_000,
      roi_pct: 250,
    }),
  );

  // Lay out 87 fixture deliverables in the 12-section tree (matching the
  // section-prefix layout the coherence gate expects from D2).
  const sectionDirs = new Map<number, string>();
  for (let s = 1; s <= 12; s++) {
    const dirName = `${String(s).padStart(2, '0')}-section`;
    const full = path.join(benchDir, 'deliverables', dirName);
    fs.mkdirSync(full, { recursive: true });
    sectionDirs.set(s, full);
  }

  for (const row of DELIVERABLES_REGISTRY) {
    const dir = sectionDirs.get(row.section)!;
    const file = path.join(dir, `${row.slug}.${row.format === 'md' ? 'md' : 'json'}`);
    if (row.format === 'json') {
      fs.writeFileSync(file, JSON.stringify({ slug: row.slug, status: 'ok' }));
      continue;
    }
    // 4 fcv tags per md doc, all within ±5% of canonical so the gate emits
    // zero violations on the happy-path benchmark.
    const body = [
      `# ${row.title}`,
      '',
      `<!-- fcv:kind=savings scope=enterprise doc=${row.slug} src=unit-economics:bench --> $55.3M`,
      `<!-- fcv:kind=npv scope=full doc=${row.slug} src=unit-economics:bench --> $171.3M`,
      `<!-- fcv:kind=payback scope=full doc=${row.slug} src=unit-economics:bench --> 5 months`,
      `<!-- fcv:kind=roi scope=full doc=${row.slug} src=unit-economics:bench --> 250%`,
      '',
      'Lorem ipsum dolor sit amet, consectetur adipiscing elit. '.repeat(40),
    ].join('\n');
    fs.writeFileSync(file, body);
  }
});

afterAll(() => {
  if (benchDir) fs.rmSync(benchDir, { recursive: true, force: true });
});

describe('ADR-098 — registry hot path', () => {
  it('filter + map over 87 rows runs in <2ms', () => {
    const start = process.hrtime.bigint();
    let total = 0;
    for (let i = 0; i < 100; i++) {
      const sec5 = DELIVERABLES_REGISTRY.filter((r) => r.section === 5).map((r) => r.slug);
      total += sec5.length;
    }
    const elapsed = Number(process.hrtime.bigint() - start) / 1e6;
    expect(total).toBeGreaterThan(0);
    expect(elapsed / 100).toBeLessThan(2);
  });
});

describe('ADR-098 — template render hot path', () => {
  it('87 template renders × ~3KB body × 12 placeholders: <60ms total', () => {
    const body = [
      '# {{title}}',
      '> {{consensusBanner}}',
      '',
      '**Date:** {{date}}',
      '**Trace:** {{traceId}}',
      '',
      '## Recommendation',
      '{{recommendation}}',
      '',
      '## Findings',
      '{{keyFindings}}',
      '',
      '## Financial Impact',
      '{{fcvBlock}}',
      '',
      '## Risk',
      '{{riskProfile}}',
      '',
      '## Sources',
      '{{agentAttributionFooter}}',
      '',
      'Lorem '.repeat(400),
    ].join('\n');

    const fields = {
      title: 'Phase 7 Bench Doc',
      date: '2026-04-25',
      traceId: 'bench-' + 'x'.repeat(36),
      consensusBanner: 'Consensus 83% — directional',
      recommendation: 'Approve.',
      keyFindings: '- A\n- B\n- C',
      fcvBlock: '$22.1M – $30.9M',
      riskProfile: 'Medium',
      agentAttributionFooter: 'platform/executive-summary, costops/forecast',
    };

    const start = process.hrtime.bigint();
    let chars = 0;
    for (const _row of DELIVERABLES_REGISTRY) {
      chars += renderTemplate(body, fields).length;
    }
    const elapsed = Number(process.hrtime.bigint() - start) / 1e6;
    expect(chars).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(60);
  });
});

describe('ADR-098 — coherence gate hot path', () => {
  it('scans 87 deliverables (≈260KB, 4 fcv tags each) in <250ms', async () => {
    const start = process.hrtime.bigint();
    const report = await runCoherenceGate(
      path.join(benchDir, 'deliverables'),
      path.join(benchDir, 'unit-economics.json'),
    );
    const elapsed = Number(process.hrtime.bigint() - start) / 1e6;
    expect(report.files_scanned).toBeGreaterThanOrEqual(70);
    expect(elapsed).toBeLessThan(250);
  });

  it('emits zero violations when every fcv value is within ±5% of canonical', async () => {
    const report = await runCoherenceGate(
      path.join(benchDir, 'deliverables'),
      path.join(benchDir, 'unit-economics.json'),
    );
    expect(report.violations.length).toBe(0);
  });

  it('emits one violation per offending file when values are off by 20%', async () => {
    const offDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase7-bench-off-'));
    fs.mkdirSync(path.join(offDir, 'deliverables', '01-executive'), { recursive: true });
    fs.writeFileSync(
      path.join(offDir, 'deliverables', '01-executive', 'off.md'),
      '# off\n<!-- fcv:kind=savings doc=off src=u --> $80.0M',
    );
    fs.writeFileSync(
      path.join(offDir, 'unit-economics.json'),
      JSON.stringify({ enterprise_savings_per_year: 55_300_000 }),
    );
    try {
      const report = await runCoherenceGate(
        path.join(offDir, 'deliverables'),
        path.join(offDir, 'unit-economics.json'),
      );
      expect(report.violations.length).toBe(1);
      expect(report.violations[0]!.kind).toBe('savings');
    } finally {
      fs.rmSync(offDir, { recursive: true, force: true });
    }
  });
});
