/**
 * ADR-PIPELINE-094 Decision 8 — local fallback generators.
 *
 * Validates the three deterministic local fallbacks (phase3-sparc,
 * phase4-adrs-ddd, phase5a-prompts) produce on-disk artifacts that satisfy
 * the gate predicates for downstream phases. Cross-cuts ADR Verification
 * scenarios 8 and 9 (Ruflo-unavailable end-to-end and originating-run regression).
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { runPhase3LocalFallback } from '../../../../src/pipeline/local-fallback/phase3-local-fallback.js';
import { runPhase4LocalFallback } from '../../../../src/pipeline/local-fallback/phase4-local-fallback.js';
import { runPhase5aLocalFallback } from '../../../../src/pipeline/local-fallback/phase5a-local-fallback.js';
import { readPhase1Consensus } from '../../../../src/pipeline/local-fallback/phase1-consensus-reader.js';
import { gatePhaseInputs } from '../../../../src/pipeline/gate/phase-dependency-gate.js';

let tmpDir: string;

function writePhase1Consensus(runDir: string, opts: {
  decisionMemo?: string;
  executiveSummary?: string;
  scenario?: Record<string, unknown>;
  manifest?: Record<string, unknown>;
} = {}): void {
  // Manifest must be > 100 bytes to pass the gate's MIN_BYTES_DEFAULT.
  const manifest = opts.manifest ?? {
    project: { language: 'typescript' },
    traceId: 'test-094-trace',
    scenario: 'water-usage analytics for ServiceNow',
    timestamp: '2026-04-25T00:00:00Z',
    status: 'completed',
  };
  fs.writeFileSync(
    path.join(runDir, 'manifest.json'),
    JSON.stringify(manifest, null, 2),
  );
  fs.writeFileSync(
    path.join(runDir, 'decision-memo.md'),
    opts.decisionMemo ?? ('# Decision Memo\n\n' + 'x'.repeat(200)),
  );
  fs.writeFileSync(
    path.join(runDir, 'executive-summary.md'),
    opts.executiveSummary ?? ('# Executive Summary\n\n' + 'y'.repeat(200)),
  );
  fs.writeFileSync(
    path.join(runDir, 'scenario.json'),
    JSON.stringify(opts.scenario ?? { summary: 'water-usage analytics for ServiceNow' }, null, 2),
  );
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'local-fallback-094-'));
});

afterEach(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ---------------------------------------------------------------------------
// phase1-consensus-reader
// ---------------------------------------------------------------------------

describe('ADR-094 D8 — readPhase1Consensus', () => {
  it('returns undefined when no Phase-1 outputs exist', () => {
    expect(readPhase1Consensus(tmpDir)).toBeUndefined();
  });

  it('reads flat-layout Phase-1 outputs', () => {
    writePhase1Consensus(tmpDir);
    const c = readPhase1Consensus(tmpDir)!;
    expect(c).toBeDefined();
    expect(c.manifest).toBeDefined();
    expect(c.decisionMemo).toBeDefined();
    expect(c.executiveSummary).toBeDefined();
    expect(c.scenario).toBeDefined();
    expect(c.projectLanguage).toBe('typescript');
  });

  it('reads subdir-layout Phase-1 outputs as a fallback', () => {
    fs.mkdirSync(path.join(tmpDir, 'phase1'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'phase1', 'decision-memo.md'), '# Decision Memo\n\n' + 'x'.repeat(200));
    const c = readPhase1Consensus(tmpDir);
    expect(c).toBeDefined();
    expect(c!.decisionMemo).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// phase3-local-fallback
// ---------------------------------------------------------------------------

describe('ADR-094 D8 — runPhase3LocalFallback', () => {
  it('returns success=false when Phase-1 consensus is missing', () => {
    const result = runPhase3LocalFallback(tmpDir);
    expect(result.success).toBe(false);
    expect(result.reason).toBe('no-phase1-consensus');
  });

  it('writes both phase3/sparc/specification.md and engineering/sparc-specification.md', () => {
    writePhase1Consensus(tmpDir);
    const result = runPhase3LocalFallback(tmpDir);
    expect(result.success).toBe(true);
    expect(result.filesWritten).toEqual([
      'phase3/sparc/specification.md',
      'engineering/sparc-specification.md',
    ]);
    for (const f of result.filesWritten) {
      const stat = fs.statSync(path.join(tmpDir, f));
      expect(stat.size).toBeGreaterThan(100);
    }
  });

  it('output is tagged quality:degraded and generator:local-fallback', () => {
    writePhase1Consensus(tmpDir);
    runPhase3LocalFallback(tmpDir);
    const sparc = fs.readFileSync(path.join(tmpDir, 'phase3', 'sparc', 'specification.md'), 'utf8');
    expect(sparc).toMatch(/quality:\s*degraded/);
    expect(sparc).toMatch(/generator:\s*local-fallback/);
  });

  it('output satisfies the phase4-adrs-ddd gate (downstream uses its sparc spec)', async () => {
    writePhase1Consensus(tmpDir);
    runPhase3LocalFallback(tmpDir);
    const result = await gatePhaseInputs('phase4-adrs-ddd', {
      runDir: tmpDir,
      dossier: { scenarioQuery: 'test', traceId: 't1', runDir: tmpDir },
      context: { outputDir: path.join(tmpDir, '.cache'), language: 'typescript' },
    });
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// phase4-local-fallback
// ---------------------------------------------------------------------------

describe('ADR-094 D8 — runPhase4LocalFallback', () => {
  it('writes ADRs, DDD bounded-contexts, domain-model, and engineering consensus', () => {
    writePhase1Consensus(tmpDir);
    const result = runPhase4LocalFallback(tmpDir);
    expect(result.success).toBe(true);

    // ADR files exist and pass gate (size > 100B).
    expect(fs.existsSync(path.join(tmpDir, 'phase4', 'adrs', 'ADR-001-system-decomposition.md'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 'phase4', 'adrs', 'ADR-002-integration-surface.md'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 'phase4', 'adrs', 'adr-index.json'))).toBe(true);

    // DDD bounded contexts.
    expect(fs.existsSync(path.join(tmpDir, 'phase4', 'ddd', 'bounded-contexts.json'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 'phase4', 'ddd', 'domain-model.md'))).toBe(true);

    // Engineering consensus.
    expect(fs.existsSync(path.join(tmpDir, 'engineering', 'architecture-decisions.md'))).toBe(true);
  });

  it('bounded-contexts.json is valid JSON with degraded marker', () => {
    writePhase1Consensus(tmpDir);
    runPhase4LocalFallback(tmpDir);
    const raw = fs.readFileSync(path.join(tmpDir, 'phase4', 'ddd', 'bounded-contexts.json'), 'utf8');
    const parsed = JSON.parse(raw);
    expect(parsed.quality).toBe('degraded');
    expect(parsed.generator).toBe('local-fallback');
    expect(Array.isArray(parsed.contexts)).toBe(true);
    expect(parsed.contexts.length).toBeGreaterThan(0);
  });

  it('output satisfies the phase5a-prompts gate', async () => {
    writePhase1Consensus(tmpDir);
    runPhase3LocalFallback(tmpDir);
    runPhase4LocalFallback(tmpDir);
    const result = await gatePhaseInputs('phase5a-prompts', {
      runDir: tmpDir,
      dossier: { scenarioQuery: 'test', traceId: 't1', runDir: tmpDir },
      context: { outputDir: path.join(tmpDir, '.cache'), language: 'typescript' },
    });
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// phase5a-local-fallback
// ---------------------------------------------------------------------------

describe('ADR-094 D8 — runPhase5aLocalFallback', () => {
  it('writes phase5a/execution-plan.json and prompts/impl-001-*.md', () => {
    writePhase1Consensus(tmpDir);
    const result = runPhase5aLocalFallback(tmpDir);
    expect(result.success).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 'phase5a', 'execution-plan.json'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 'prompts', 'impl-001-phase1-consensus.md'))).toBe(true);
  });

  it('execution-plan.json is valid JSON with at least 1 implementations entry', () => {
    writePhase1Consensus(tmpDir);
    runPhase5aLocalFallback(tmpDir);
    const planRaw = fs.readFileSync(path.join(tmpDir, 'phase5a', 'execution-plan.json'), 'utf8');
    const plan = JSON.parse(planRaw);
    expect(plan.quality).toBe('degraded');
    expect(plan.generator).toBe('local-fallback');
    expect(Array.isArray(plan.implementations)).toBe(true);
    expect(plan.implementations.length).toBeGreaterThanOrEqual(1);
    // Size > 50 bytes for the Phase 5b gate.
    expect(planRaw.length).toBeGreaterThan(50);
  });

  it('produced prompt is tagged degraded_mode:phase1-fallback', () => {
    writePhase1Consensus(tmpDir);
    runPhase5aLocalFallback(tmpDir);
    const promptBody = fs.readFileSync(path.join(tmpDir, 'prompts', 'impl-001-phase1-consensus.md'), 'utf8');
    expect(promptBody).toMatch(/degraded_mode:\s*phase1-fallback/);
    expect(promptBody).toMatch(/quality:\s*degraded/);
  });

  it('is a no-op when phase5a/execution-plan.json already exists', () => {
    writePhase1Consensus(tmpDir);
    fs.mkdirSync(path.join(tmpDir, 'phase5a'), { recursive: true });
    const richPlan = JSON.stringify({ generator: 'ruflo', quality: 'full', implementations: [{ id: 'impl-existing' }] }, null, 2);
    fs.writeFileSync(path.join(tmpDir, 'phase5a', 'execution-plan.json'), richPlan);

    const result = runPhase5aLocalFallback(tmpDir);
    expect(result.success).toBe(true);
    expect(result.filesWritten).toEqual([]); // no-op

    const after = fs.readFileSync(path.join(tmpDir, 'phase5a', 'execution-plan.json'), 'utf8');
    expect(after).toBe(richPlan); // unchanged
  });

  it('output satisfies the phase5b-scaffold gate', async () => {
    writePhase1Consensus(tmpDir);
    runPhase5aLocalFallback(tmpDir);
    const result = await gatePhaseInputs('phase5b-scaffold', {
      runDir: tmpDir,
      dossier: { scenarioQuery: 'test', traceId: 't1', runDir: tmpDir },
      context: { outputDir: path.join(tmpDir, '.cache'), language: 'typescript' },
    });
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// End-to-end Ruflo-unavailable simulation (ADR Verification scenario 8)
// ---------------------------------------------------------------------------

describe('ADR-094 D8 — end-to-end Ruflo-unavailable chain', () => {
  it('the full p3→p4→p5a fallback chain produces gate-satisfying outputs end-to-end', async () => {
    writePhase1Consensus(tmpDir);

    // Run all three fallbacks in order.
    const r3 = runPhase3LocalFallback(tmpDir);
    const r4 = runPhase4LocalFallback(tmpDir);
    const r5a = runPhase5aLocalFallback(tmpDir);
    expect(r3.success).toBe(true);
    expect(r4.success).toBe(true);
    expect(r5a.success).toBe(true);

    // All four downstream gates must pass.
    const dossier = { scenarioQuery: 'test', traceId: 't1', runDir: tmpDir };
    const context = { outputDir: path.join(tmpDir, '.cache'), language: 'typescript' };
    const phase4Gate = await gatePhaseInputs('phase4-adrs-ddd', { runDir: tmpDir, dossier, context });
    const phase5aGate = await gatePhaseInputs('phase5a-prompts', { runDir: tmpDir, dossier, context });
    const phase5bGate = await gatePhaseInputs('phase5b-scaffold', { runDir: tmpDir, dossier, context });
    expect(phase4Gate.ok).toBe(true);
    expect(phase5aGate.ok).toBe(true);
    expect(phase5bGate.ok).toBe(true);
  });
});
