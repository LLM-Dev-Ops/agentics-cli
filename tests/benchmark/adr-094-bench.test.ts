/**
 * ADR-PIPELINE-094 — performance regression benchmarks.
 *
 * The originating run wasted ~3 minutes timing out a 76-agent fanout
 * because Phase 5b ran without prompts. The 094 fixes target three
 * measurable wins:
 *
 *  1. Gate decision is cheap — verdict ms < 50 even with the new path-
 *     resolution and gate-decision-log emission overhead.
 *  2. Local fallback completes quickly — under 250ms for the full
 *     phase3 + phase4 + phase5a chain on a typical Phase-1 consensus.
 *  3. Repeated gate calls (the same fanout calls the gate per dispatch)
 *     don't quadratically slow down — N gate calls scale linearly with N.
 *
 * These benchmarks gate the merge: a regression on any metric fails CI.
 * Targets are lenient enough to absorb CI-runner noise (~3x dev-machine
 * variance) while still catching meaningful regressions.
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { gatePhaseInputs } from '../../src/pipeline/gate/phase-dependency-gate.js';
import { runPhase3LocalFallback } from '../../src/pipeline/local-fallback/phase3-local-fallback.js';
import { runPhase4LocalFallback } from '../../src/pipeline/local-fallback/phase4-local-fallback.js';
import { runPhase5aLocalFallback } from '../../src/pipeline/local-fallback/phase5a-local-fallback.js';

let tmpDir: string;

function writePhase1Consensus(runDir: string): void {
  const manifest = {
    project: { language: 'typescript' },
    traceId: 'bench-094',
    scenario: 'water-usage analytics',
    timestamp: '2026-04-25T00:00:00Z',
  };
  fs.writeFileSync(path.join(runDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  fs.writeFileSync(path.join(runDir, 'decision-memo.md'), '# Decision Memo\n\n' + 'x'.repeat(2000));
  fs.writeFileSync(path.join(runDir, 'executive-summary.md'), '# Executive Summary\n\n' + 'y'.repeat(2000));
  fs.writeFileSync(path.join(runDir, 'scenario.json'), JSON.stringify({ summary: 'z'.repeat(500) }, null, 2));
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-094-'));
});

afterEach(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

const dossier = (runDir: string) => ({ scenarioQuery: 'q', traceId: 't', runDir });
const ctx = (runDir: string) => ({ outputDir: path.join(runDir, '.cache'), language: 'typescript' });

describe('ADR-094 benchmark — gate decision latency', () => {
  it('phase2 gate verdict completes in < 50ms with happy-path inputs', async () => {
    writePhase1Consensus(tmpDir);
    const start = Date.now();
    await gatePhaseInputs('phase2', { runDir: tmpDir, dossier: dossier(tmpDir), context: ctx(tmpDir) });
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(50);
  });

  it('phase5a-prompts gate verdict completes in < 100ms even with 5 fallback any-of clauses', async () => {
    writePhase1Consensus(tmpDir);
    const start = Date.now();
    await gatePhaseInputs('phase5a-prompts', { runDir: tmpDir, dossier: dossier(tmpDir), context: ctx(tmpDir) });
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(100);
  });

  it('100 sequential gate calls scale linearly (< 5s total)', async () => {
    writePhase1Consensus(tmpDir);
    const start = Date.now();
    for (let i = 0; i < 100; i++) {
      await gatePhaseInputs('phase2', { runDir: tmpDir, dossier: dossier(tmpDir), context: ctx(tmpDir) });
    }
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(5000);
    // Average per-call should be in the same order of magnitude as a single call.
    expect(elapsed / 100).toBeLessThan(50);
  });
});

describe('ADR-094 benchmark — local-fallback artifact production', () => {
  it('phase3 + phase4 + phase5a fallback chain completes in < 250ms', () => {
    writePhase1Consensus(tmpDir);
    const start = Date.now();
    const r3 = runPhase3LocalFallback(tmpDir);
    const r4 = runPhase4LocalFallback(tmpDir);
    const r5a = runPhase5aLocalFallback(tmpDir);
    const elapsed = Date.now() - start;

    expect(r3.success).toBe(true);
    expect(r4.success).toBe(true);
    expect(r5a.success).toBe(true);
    expect(elapsed).toBeLessThan(250);
  });

  it('phase5a fallback alone completes in < 100ms (the most-common degraded path)', () => {
    writePhase1Consensus(tmpDir);
    const start = Date.now();
    runPhase5aLocalFallback(tmpDir);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(100);
  });

  it('the full degraded run (phase3+4+5a fallback + 4 gate verdicts) completes in < 2s', async () => {
    writePhase1Consensus(tmpDir);
    const start = Date.now();
    runPhase3LocalFallback(tmpDir);
    runPhase4LocalFallback(tmpDir);
    runPhase5aLocalFallback(tmpDir);
    const dossierObj = dossier(tmpDir);
    const ctxObj = ctx(tmpDir);
    await gatePhaseInputs('phase3-sparc', { runDir: tmpDir, dossier: dossierObj, context: ctxObj });
    await gatePhaseInputs('phase4-adrs-ddd', { runDir: tmpDir, dossier: dossierObj, context: ctxObj });
    await gatePhaseInputs('phase5a-prompts', { runDir: tmpDir, dossier: dossierObj, context: ctxObj });
    await gatePhaseInputs('phase5b-scaffold', { runDir: tmpDir, dossier: dossierObj, context: ctxObj });
    const elapsed = Date.now() - start;
    // Pre-094 baseline for the same run was ~3 minutes (180000ms = 180s) due
    // to the 76-agent timeout cascade. 094 brings this to ≤2s on a CI runner
    // — a >90× improvement. Most of the remaining time is the phase3-sparc
    // gate's Ruflo-binary probe (no local fallback for phase2, so the gate
    // walks through the unavailable path). Acceptable: the user-visible
    // outcome is correct and no code path waits on a real network anymore.
    expect(elapsed).toBeLessThan(2000);
  });
});
