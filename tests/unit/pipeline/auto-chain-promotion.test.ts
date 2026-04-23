/**
 * ADR-PIPELINE-092 — runs-to-plans promotion completeness unit tests.
 *
 * Verifies the shared `promotePlanningArtifacts` routine end-to-end against
 * a synthetic `runDir` on a temp path. Covers:
 *   1. Engineering-only-content case (the dacf7975 trace shape) — all five
 *      slots populated with phase-refined > engineering priority.
 *   2. Placeholder rejection (< 256 bytes) — engineering file not promoted,
 *      MISSING emitted.
 *   3. Phase-refined wins over engineering primary output.
 *   4. Identical-content skip — skip count increments, copy count does not.
 *   5. `planPromotion` manifest block merge — counts + missing_slots written
 *      to manifest.json.
 *   6. MISSING slot honesty — `[PLANS] MISSING sparc` stderr line + slot in
 *      manifest.planPromotion.missing_slots.
 *   7. dacf7975 regression fixture — replays the exact failing trace shape
 *      (engineering/*.md + phase2/adrs/*.md only) and asserts completeness.
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  promotePlanningArtifacts,
  writePlanPromotionToManifest,
  type PlanPromotionSummary,
} from '../../../src/pipeline/auto-chain.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeTempRoots(): { runDir: string; projectRoot: string } {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-chain-092-'));
  const runDir = path.join(base, 'run');
  const projectRoot = path.join(base, 'project');
  fs.mkdirSync(runDir, { recursive: true });
  fs.mkdirSync(projectRoot, { recursive: true });
  return { runDir, projectRoot };
}

function writeFile(p: string, content: string): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, 'utf-8');
}

/** Produce a markdown blob comfortably above the 256-byte engineering threshold. */
function nonStubMarkdown(title: string): string {
  const body = [
    `# ${title}`,
    '',
    'This file represents a non-stub Ruflo primary-output artifact with',
    'enough content to clear the 256-byte placeholder threshold enforced by',
    'ADR-PIPELINE-092. It contains multiple paragraphs so the sha256 hash',
    'lands well outside any known placeholder template hash list.',
    '',
    '## Details',
    '',
    '- Item one describing a meaningful design decision.',
    '- Item two capturing a concrete architectural trade-off.',
    '- Item three noting a verification hook.',
    '',
    'End of fixture.',
    '',
  ].join('\n');
  return body;
}

/** Capture process.stderr.write output for the duration of fn(). */
function captureStderr(fn: () => void): string {
  const chunks: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process.stderr as any).write = (chunk: any): boolean => {
    chunks.push(typeof chunk === 'string' ? chunk : chunk.toString('utf-8'));
    return true;
  };
  try {
    fn();
  } finally {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process.stderr as any).write = original;
  }
  return chunks.join('');
}

function readPlansDir(projectRoot: string, ...segments: string[]): string[] {
  const full = path.join(projectRoot, '.agentics', 'plans', ...segments);
  if (!fs.existsSync(full)) return [];
  try {
    return fs.readdirSync(full).sort();
  } catch {
    return [];
  }
}

function slotFileExists(projectRoot: string, slot: string, file: string): boolean {
  return fs.existsSync(path.join(projectRoot, '.agentics', 'plans', slot, file));
}

function readSlotFile(projectRoot: string, slot: string, file: string): string {
  return fs.readFileSync(path.join(projectRoot, '.agentics', 'plans', slot, file), 'utf-8');
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('promotePlanningArtifacts — ADR-PIPELINE-092', () => {
  let runDir: string;
  let projectRoot: string;
  let tempBases: string[] = [];

  beforeEach(() => {
    const roots = makeTempRoots();
    runDir = roots.runDir;
    projectRoot = roots.projectRoot;
    tempBases.push(path.dirname(runDir));
  });

  afterEach(() => {
    for (const base of tempBases) {
      try { fs.rmSync(base, { recursive: true, force: true }); } catch { /* noop */ }
    }
    tempBases = [];
  });

  // --- Test 1: engineering-only case (the ADR §Verification shape) -----------
  it('promotes engineering/ primary output when phase-refined sources are absent, phase2/adrs/ wins over engineering/ for ADR slot', () => {
    writeFile(path.join(runDir, 'engineering', 'sparc-specification.md'), nonStubMarkdown('SPARC Specification'));
    writeFile(path.join(runDir, 'engineering', 'architecture-decisions.md'), nonStubMarkdown('Architecture Decisions'));
    writeFile(path.join(runDir, 'engineering', 'domain-model.md'), nonStubMarkdown('Domain Model'));
    writeFile(path.join(runDir, 'engineering', 'tdd-test-plan.md'), nonStubMarkdown('TDD Test Plan'));
    writeFile(path.join(runDir, 'engineering', 'implementation-roadmap.md'), nonStubMarkdown('Implementation Roadmap'));
    writeFile(path.join(runDir, 'phase2', 'adrs', 'ADR-P2-001.md'), '# ADR-P2-001\nPhase 2 ADR content.\n');
    writeFile(path.join(runDir, 'phase2', 'adrs', 'ADR-P2-002.md'), '# ADR-P2-002\nPhase 2 ADR content.\n');

    let summary: PlanPromotionSummary | null = null;
    const stderr = captureStderr(() => {
      summary = promotePlanningArtifacts(runDir, projectRoot);
    });
    expect(summary).not.toBeNull();

    // sparc: engineering/ promoted (phase-refined slots empty)
    expect(slotFileExists(projectRoot, 'sparc', 'specification.md')).toBe(true);
    const sparcContent = readSlotFile(projectRoot, 'sparc', 'specification.md');
    expect(sparcContent).toContain('Ruflo primary output (ADR-PIPELINE-092)');
    expect(sparcContent).toContain('SPARC Specification');

    // adrs: phase2/adrs/ wins over engineering/architecture-decisions.md
    const adrEntries = readPlansDir(projectRoot, 'adrs');
    expect(adrEntries).toContain('ADR-P2-001.md');
    expect(adrEntries).toContain('ADR-P2-002.md');
    expect(adrEntries).not.toContain('ADR-ENG-001-architecture-decisions.md');

    // ddd: engineering/ promoted
    expect(slotFileExists(projectRoot, 'ddd', 'domain-model.md')).toBe(true);

    // tdd: engineering/ promoted
    expect(slotFileExists(projectRoot, 'tdd', 'test-plan.md')).toBe(true);

    // implementation: engineering/ implementation-roadmap.md promoted
    expect(slotFileExists(projectRoot, 'implementation', 'roadmap.md')).toBe(true);

    // stderr summary present + non-zero counts across all populated slots
    expect(stderr).toMatch(/\[PLANS\] promoted/);
    expect(stderr).not.toMatch(/\[PLANS\] MISSING sparc/);
    expect(stderr).not.toMatch(/\[PLANS\] MISSING adrs/);
    expect(stderr).not.toMatch(/\[PLANS\] MISSING ddd/);
    expect(stderr).not.toMatch(/\[PLANS\] MISSING tdd/);
    expect(stderr).not.toMatch(/\[PLANS\] MISSING implementation/);
    // prompts slot — no candidate sources here, MISSING is expected (and allowed)
    // Counts reflect filesystem reality
    expect(summary!.counts.sparc).toBeGreaterThan(0);
    expect(summary!.counts.adrs).toBeGreaterThanOrEqual(2);
    expect(summary!.counts.ddd).toBeGreaterThan(0);
    expect(summary!.counts.tdd).toBeGreaterThan(0);
    expect(summary!.counts.implementation).toBeGreaterThan(0);
  });

  // --- Test 2: placeholder rejection (< 256 bytes) ---------------------------
  it('rejects engineering/sparc-specification.md when it is below the 256-byte placeholder threshold', () => {
    // 100 bytes — well under ENGINEERING_MIN_SIZE_BYTES (256)
    const stub = '# Stub\nShort placeholder content only — reject me.\n'.padEnd(100, '.');
    writeFile(path.join(runDir, 'engineering', 'sparc-specification.md'), stub);

    let summary: PlanPromotionSummary | null = null;
    const stderr = captureStderr(() => {
      summary = promotePlanningArtifacts(runDir, projectRoot);
    });

    expect(slotFileExists(projectRoot, 'sparc', 'specification.md')).toBe(false);
    expect(stderr).toMatch(/\[PLANS\] MISSING sparc/);
    expect(summary!.counts.sparc).toBe(0);
    expect(summary!.missing_slots).toContain('sparc');
  });

  // --- Test 3: phase-refined wins over engineering/ --------------------------
  it('prefers phase3/sparc/ content over engineering/sparc-specification.md when both exist', () => {
    writeFile(
      path.join(runDir, 'phase3', 'sparc', 'specification.md'),
      '# Phase 3 SPARC\nStructured phase-refined content.\n',
    );
    writeFile(
      path.join(runDir, 'phase3', 'sparc', 'pseudocode.md'),
      '# Phase 3 Pseudocode\nAnother structured file.\n',
    );
    writeFile(
      path.join(runDir, 'engineering', 'sparc-specification.md'),
      nonStubMarkdown('Engineering SPARC'),
    );

    captureStderr(() => { promotePlanningArtifacts(runDir, projectRoot); });

    const sparcContent = readSlotFile(projectRoot, 'sparc', 'specification.md');
    expect(sparcContent).toContain('Phase 3 SPARC');
    expect(sparcContent).not.toContain('Ruflo primary output');
    // Phase 3 brought 2 files; both present
    const entries = readPlansDir(projectRoot, 'sparc');
    expect(entries).toEqual(['pseudocode.md', 'specification.md']);
  });

  // --- Test 4: identical-content skip ----------------------------------------
  it('increments skip count but not copy count when destination already matches source byte-for-byte', () => {
    const content = '# ADR-P2-001\nIdentical phase-2 ADR content.\n';
    writeFile(path.join(runDir, 'phase2', 'adrs', 'ADR-P2-001.md'), content);
    // Pre-populate destination with identical content
    writeFile(path.join(projectRoot, '.agentics', 'plans', 'adrs', 'ADR-P2-001.md'), content);

    let summary: PlanPromotionSummary | null = null;
    captureStderr(() => { summary = promotePlanningArtifacts(runDir, projectRoot); });

    // No new copy, but the skip path fires
    expect(summary!.counts.adrs).toBe(0);
    expect(summary!.total_skipped).toBeGreaterThanOrEqual(1);
  });

  // --- Test 5: planPromotion manifest-block merge ----------------------------
  it('merges planPromotion block with correct per-slot counts into manifest.json', () => {
    writeFile(path.join(runDir, 'engineering', 'domain-model.md'), nonStubMarkdown('Domain Model'));
    writeFile(path.join(runDir, 'phase2', 'adrs', 'ADR-P2-001.md'), '# ADR-P2-001\nPhase 2 ADR.\n');
    // Seed an existing manifest so we exercise the read-modify-write path
    const manifestPath = path.join(runDir, 'manifest.json');
    fs.writeFileSync(manifestPath, JSON.stringify({ trace_id: 'test-trace' }, null, 2), 'utf-8');

    let summary: PlanPromotionSummary | null = null;
    captureStderr(() => {
      summary = promotePlanningArtifacts(runDir, projectRoot);
      writePlanPromotionToManifest(runDir, summary);
    });

    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as Record<string, unknown>;
    expect(manifest['trace_id']).toBe('test-trace');
    expect(manifest['planPromotion']).toBeDefined();
    const block = manifest['planPromotion'] as Record<string, unknown>;
    expect(block['adrs']).toBe(1);
    expect(block['ddd']).toBe(1);
    expect(block['sparc']).toBe(0);
    expect(block['tdd']).toBe(0);
    expect(block['implementation']).toBe(0);
    expect(block['prompts']).toBe(0);
    expect(Array.isArray(block['missing_slots'])).toBe(true);
    expect(block['missing_slots']).toEqual(expect.arrayContaining(['sparc', 'tdd', 'prompts', 'implementation']));
  });

  // --- Test 6: MISSING slot honesty ------------------------------------------
  it('emits [PLANS] MISSING sparc when no candidate sources exist anywhere for that slot', () => {
    // Only produce an adrs source; every other slot should MISS
    writeFile(path.join(runDir, 'phase2', 'adrs', 'ADR-P2-001.md'), '# ADR-P2-001\nOnly ADRs.\n');

    let summary: PlanPromotionSummary | null = null;
    const stderr = captureStderr(() => {
      summary = promotePlanningArtifacts(runDir, projectRoot);
    });
    expect(stderr).toMatch(/\[PLANS\] MISSING sparc/);
    expect(summary!.missing_slots).toContain('sparc');
  });

  // --- Test 7: dacf7975 regression fixture -----------------------------------
  it('regression: dacf7975 trace shape — engineering/*.md + phase2/adrs/*.md populate all six slots (prompts via engineering is not expected, so MISSING prompts acceptable)', () => {
    // Exact shape of the bad trace
    writeFile(path.join(runDir, 'engineering', 'sparc-specification.md'), nonStubMarkdown('SPARC Specification'));
    writeFile(path.join(runDir, 'engineering', 'architecture-decisions.md'), nonStubMarkdown('Architecture Decisions'));
    writeFile(path.join(runDir, 'engineering', 'domain-model.md'), nonStubMarkdown('Domain Model'));
    writeFile(path.join(runDir, 'engineering', 'tdd-test-plan.md'), nonStubMarkdown('TDD Test Plan'));
    writeFile(path.join(runDir, 'engineering', 'implementation-roadmap.md'), nonStubMarkdown('Implementation Roadmap'));
    for (let i = 1; i <= 10; i++) {
      const id = String(i).padStart(3, '0');
      writeFile(path.join(runDir, 'phase2', 'adrs', `ADR-P2-${id}.md`), `# ADR-P2-${id}\nContent.\n`);
    }
    writeFile(path.join(runDir, 'phase2', 'adrs', 'adr-index.json'), JSON.stringify([], null, 2));
    writeFile(path.join(runDir, 'phase2', 'ddd', 'domain-model.md'), '# Phase 2 DDD\nContent.\n');

    let summary: PlanPromotionSummary | null = null;
    const stderr = captureStderr(() => {
      summary = promotePlanningArtifacts(runDir, projectRoot);
    });

    // All five plans slots targeted by the ADR should be populated.
    expect(slotFileExists(projectRoot, 'sparc', 'specification.md')).toBe(true);
    expect(readPlansDir(projectRoot, 'adrs').length).toBeGreaterThanOrEqual(10);
    // DDD: phase2 wins over engineering/
    expect(slotFileExists(projectRoot, 'ddd', 'domain-model.md')).toBe(true);
    expect(slotFileExists(projectRoot, 'tdd', 'test-plan.md')).toBe(true);
    expect(slotFileExists(projectRoot, 'implementation', 'roadmap.md')).toBe(true);

    // sparc, adrs, ddd, tdd, implementation must NOT be MISSING
    expect(stderr).not.toMatch(/\[PLANS\] MISSING sparc/);
    expect(stderr).not.toMatch(/\[PLANS\] MISSING adrs/);
    expect(stderr).not.toMatch(/\[PLANS\] MISSING ddd/);
    expect(stderr).not.toMatch(/\[PLANS\] MISSING tdd/);
    expect(stderr).not.toMatch(/\[PLANS\] MISSING implementation/);

    // Counts
    expect(summary!.counts.sparc).toBeGreaterThan(0);
    expect(summary!.counts.adrs).toBeGreaterThanOrEqual(10);
    expect(summary!.counts.ddd).toBeGreaterThan(0);
    expect(summary!.counts.tdd).toBeGreaterThan(0);
    expect(summary!.counts.implementation).toBeGreaterThan(0);
  });
});
