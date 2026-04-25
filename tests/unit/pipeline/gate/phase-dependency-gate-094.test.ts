/**
 * ADR-PIPELINE-094 — Phase Dependency Gate unit tests for the path-reality
 * resolver, the Phase-1 fallback inputs, the Phase 5b hard-block, and the
 * machine-readable gate-decision-log emitter.
 *
 * These tests cover scenarios 1, 2 (gate part), 3, and 5 of the ADR's
 * Verification section. End-to-end scenarios (4, 6–10) live in their own
 * test files near the components they exercise.
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  PHASE_DEPENDENCIES,
  PHASE_DIRNAME,
  gatePhaseInputs,
  resolvePhasePath,
  writeGateDecisionLog,
  type GateDecisionLog,
  type PhaseId,
} from '../../../../src/pipeline/gate/phase-dependency-gate.js';
import type {
  Phase1Dossier,
  RufloExecutionContext,
  PrimaryPhaseExecutionResult,
} from '../../../../src/pipeline/ruflo-phase-executor.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let tmpDir: string;

function makeDossier(runDir: string, traceId = 'trace-094'): Phase1Dossier {
  return {
    scenarioQuery: 'water usage scenario',
    traceId,
    runDir,
  };
}

function makeContext(runDir: string): RufloExecutionContext {
  return { outputDir: path.join(runDir, '.ruflo-cache'), language: 'typescript' };
}

function writeFile(runDir: string, rel: string, content: string): void {
  const abs = path.join(runDir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf8');
}

function bigBody(tag: string): string {
  return `# ${tag}\n\n${'x'.repeat(200)}\n`;
}

function makeUnavailableResult(phaseId: string): PrimaryPhaseExecutionResult {
  return {
    phaseId: phaseId as PrimaryPhaseExecutionResult['phaseId'],
    success: false,
    executionTier: 'unavailable',
    reason: 'ruflo-not-available',
    filesModified: 0,
    timing: 0,
    message: 'ruflo unavailable',
  };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-094-'));
});

afterEach(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ---------------------------------------------------------------------------
// Decision 1 — Path-reality resolution
// ---------------------------------------------------------------------------

describe('ADR-094 D1 — resolvePhasePath', () => {
  it('returns flat-layout candidate first for phase1/ paths (production layout)', () => {
    const out = resolvePhasePath('/run', 'phase1/manifest.json');
    expect(out[0]).toBe(path.join('/run', 'manifest.json'));
    expect(out[1]).toBe(path.join('/run', 'phase1', 'manifest.json'));
    expect(out).toHaveLength(2);
  });

  it('returns single candidate for non-phase1 paths', () => {
    expect(resolvePhasePath('/run', 'phase2/research-dossier.json')).toEqual([
      path.join('/run', 'phase2', 'research-dossier.json'),
    ]);
    expect(resolvePhasePath('/run', 'engineering/architecture-decisions.md')).toEqual([
      path.join('/run', 'engineering', 'architecture-decisions.md'),
    ]);
  });

  it('handles phase1/ paths with nested tail components', () => {
    const out = resolvePhasePath('/run', 'phase1/sub/dir/file.json');
    expect(out[0]).toBe(path.join('/run', 'sub/dir/file.json'));
    expect(out[1]).toBe(path.join('/run', 'phase1', 'sub/dir/file.json'));
  });
});

describe('ADR-094 D1 — gate accepts production flat Phase-1 layout', () => {
  it('phase2 gate passes when phase1 outputs live flat at <runDir>/manifest.json (the originating defect)', async () => {
    // Production layout: Phase 1 writes flat. No phase1/ subdir.
    writeFile(tmpDir, 'manifest.json', bigBody('phase1 manifest'));
    writeFile(tmpDir, 'executive-summary.md', bigBody('phase1 exec summary'));

    const result = await gatePhaseInputs('phase2', {
      runDir: tmpDir,
      dossier: makeDossier(tmpDir),
      context: makeContext(tmpDir),
    });

    expect(result.ok).toBe(true);
    expect(result.missing).toEqual([]);
    expect(result.ruflo_invoked).toEqual([]);
  });

  it('phase2 gate also accepts subdir Phase-1 layout for backwards compatibility', async () => {
    // Legacy/test-fixture layout: phase1/ subdir.
    writeFile(tmpDir, 'phase1/manifest.json', bigBody('phase1 manifest'));
    writeFile(tmpDir, 'phase1/executive-summary.md', bigBody('phase1 exec summary'));

    const result = await gatePhaseInputs('phase2', {
      runDir: tmpDir,
      dossier: makeDossier(tmpDir),
      context: makeContext(tmpDir),
    });

    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Decision 2 — Phase-1 fallback inputs for phase5a-prompts (gate part)
// ---------------------------------------------------------------------------

describe('ADR-094 D2 — Phase 5a accepts Phase-1 fallback inputs', () => {
  it('phase5a-prompts is satisfied by Phase-1 decision-memo.md when no SPARC/ADR/DDD chain exists', async () => {
    // ONLY Phase-1 outputs — no phase3, no phase4, no engineering.
    writeFile(tmpDir, 'manifest.json', bigBody('phase1 manifest'));
    writeFile(tmpDir, 'decision-memo.md', bigBody('phase1 decision memo with detailed architecture rationale'));

    const result = await gatePhaseInputs('phase5a-prompts', {
      runDir: tmpDir,
      dossier: makeDossier(tmpDir),
      context: makeContext(tmpDir),
    });

    expect(result.ok).toBe(true);
    expect(result.ruflo_invoked).toEqual([]);
  });

  it('phase5a-prompts is satisfied by Phase-1 scenario.json on the second any-of clause when decision-memo is short', async () => {
    writeFile(tmpDir, 'manifest.json', bigBody('phase1 manifest'));
    // For the FIRST clause (sparc spec), decision-memo.md is the only Phase-1 fallback;
    // for the SECOND clause (architecture decisions), both decision-memo.md and scenario.json work.
    writeFile(tmpDir, 'decision-memo.md', bigBody('phase1 decision memo'));
    writeFile(tmpDir, 'scenario.json', JSON.stringify({ summary: 'a'.repeat(200) }));

    const result = await gatePhaseInputs('phase5a-prompts', {
      runDir: tmpDir,
      dossier: makeDossier(tmpDir),
      context: makeContext(tmpDir),
    });

    expect(result.ok).toBe(true);
  });

  it('phase5a-prompts still blocks when no Phase-1 fallback inputs exist either', async () => {
    writeFile(tmpDir, 'manifest.json', bigBody('phase1 manifest'));
    // No decision-memo.md, no scenario.json, no SPARC, no ADRs/DDD/engineering.

    const result = await gatePhaseInputs('phase5a-prompts', {
      runDir: tmpDir,
      dossier: makeDossier(tmpDir),
      context: makeContext(tmpDir),
      runPrimaryPhaseExecution: async (phaseId) => makeUnavailableResult(phaseId),
    });

    expect(result.ok).toBe(false);
    expect(result.stillMissing.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Decision 3 — Phase 5b hard-block on phase5a/execution-plan.json
// ---------------------------------------------------------------------------

describe('ADR-094 D3 — Phase 5b hard-blocks on phase5a/execution-plan.json', () => {
  it('phase5b-scaffold is blocked when phase5a/execution-plan.json is absent', async () => {
    writeFile(tmpDir, 'manifest.json', bigBody('phase1 manifest'));
    // No phase5a/execution-plan.json.

    const result = await gatePhaseInputs('phase5b-scaffold', {
      runDir: tmpDir,
      dossier: makeDossier(tmpDir),
      context: makeContext(tmpDir),
      runPrimaryPhaseExecution: async (phaseId) => makeUnavailableResult(phaseId),
    });

    expect(result.ok).toBe(false);
    expect(result.stillMissing).toContain('phase5a/execution-plan.json');
  });

  it('phase5b-scaffold passes when both manifest.json and execution-plan.json exist (>=50B)', async () => {
    writeFile(tmpDir, 'manifest.json', bigBody('phase1 manifest'));
    writeFile(
      tmpDir,
      'phase5a/execution-plan.json',
      JSON.stringify({ implementations: [{ id: 'impl-001', name: 'demo', source: 'phase1' }] }, null, 2),
    );

    const result = await gatePhaseInputs('phase5b-scaffold', {
      runDir: tmpDir,
      dossier: makeDossier(tmpDir),
      context: makeContext(tmpDir),
    });

    expect(result.ok).toBe(true);
  });

  it('phase5b-scaffold rejects an under-50B execution-plan.json as a stub', async () => {
    writeFile(tmpDir, 'manifest.json', bigBody('phase1 manifest'));
    writeFile(tmpDir, 'phase5a/execution-plan.json', '{}');

    const result = await gatePhaseInputs('phase5b-scaffold', {
      runDir: tmpDir,
      dossier: makeDossier(tmpDir),
      context: makeContext(tmpDir),
      runPrimaryPhaseExecution: async (phaseId) => makeUnavailableResult(phaseId),
    });

    expect(result.ok).toBe(false);
    expect(result.stillMissing).toContain('phase5a/execution-plan.json');
  });
});

// ---------------------------------------------------------------------------
// Decision 5 — gate-decision-log.json
// ---------------------------------------------------------------------------

describe('ADR-094 D5 — writeGateDecisionLog', () => {
  it('writes a parseable JSON log to <runDir>/<phaseDirname>/gate-decision-log.json', () => {
    const log: GateDecisionLog = {
      phaseId: 'phase2',
      trace_id: 'trace-test',
      timestamp: '2026-04-25T00:00:00.000Z',
      checked_inputs: [{
        logical_path: 'phase1/manifest.json',
        resolved_path: path.join(tmpDir, 'manifest.json'),
        exists: true,
        size_bytes: 256,
        is_error_stub: false,
        satisfies: true,
      }],
      ruflo_invoked: [],
      verdict: 'ok',
      still_missing: [],
      decision_ms: 12,
    };

    writeGateDecisionLog(tmpDir, log);

    const target = path.join(tmpDir, PHASE_DIRNAME['phase2'], 'gate-decision-log.json');
    expect(fs.existsSync(target)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(target, 'utf8')) as GateDecisionLog;
    expect(parsed.phaseId).toBe('phase2');
    expect(parsed.verdict).toBe('ok');
    expect(parsed.checked_inputs).toHaveLength(1);
    expect(parsed.checked_inputs[0]!.logical_path).toBe('phase1/manifest.json');
  });

  it('every phase id maps to a directory name', () => {
    const phaseIds: PhaseId[] = ['phase2', 'phase3-sparc', 'phase4-adrs-ddd', 'phase5a-prompts', 'phase5b-scaffold'];
    for (const id of phaseIds) {
      expect(PHASE_DIRNAME[id]).toBeTruthy();
    }
  });
});

describe('ADR-094 D5 — gatePhaseInputs emits gate-decision-log.json', () => {
  it('emits a log with verdict=ok and resolved_path for the production flat layout', async () => {
    writeFile(tmpDir, 'manifest.json', bigBody('phase1 manifest'));
    writeFile(tmpDir, 'executive-summary.md', bigBody('phase1 exec summary'));

    await gatePhaseInputs('phase2', {
      runDir: tmpDir,
      dossier: makeDossier(tmpDir, 'trace-emit-ok'),
      context: makeContext(tmpDir),
    });

    const logPath = path.join(tmpDir, 'phase2', 'gate-decision-log.json');
    expect(fs.existsSync(logPath)).toBe(true);
    const log = JSON.parse(fs.readFileSync(logPath, 'utf8')) as GateDecisionLog;
    expect(log.verdict).toBe('ok');
    expect(log.trace_id).toBe('trace-emit-ok');
    expect(log.still_missing).toEqual([]);
    expect(log.checked_inputs.some((c) =>
      c.logical_path === 'phase1/manifest.json' &&
      c.resolved_path === path.join(tmpDir, 'manifest.json') &&
      c.satisfies === true
    )).toBe(true);
    expect(typeof log.decision_ms).toBe('number');
  });

  it('emits a log with verdict=blocked, still_missing, and ruflo_invoked when Ruflo is unavailable', async () => {
    // Phase 1 outputs exist (so the gate gets past the phase1 check), but
    // phase2/research-dossier.json is missing — phase3-sparc will invoke
    // Ruflo for upstream `phase2` and the (mocked) executor returns unavailable.
    writeFile(tmpDir, 'manifest.json', bigBody('phase1 manifest'));

    await gatePhaseInputs('phase3-sparc', {
      runDir: tmpDir,
      dossier: makeDossier(tmpDir, 'trace-emit-blocked'),
      context: makeContext(tmpDir),
      runPrimaryPhaseExecution: async (phaseId) => makeUnavailableResult(phaseId),
    });

    const logPath = path.join(tmpDir, 'phase3', 'gate-decision-log.json');
    expect(fs.existsSync(logPath)).toBe(true);
    const log = JSON.parse(fs.readFileSync(logPath, 'utf8')) as GateDecisionLog;
    expect(log.verdict).toBe('blocked');
    expect(log.still_missing).toContain('phase2/research-dossier.json');
    expect(log.ruflo_invoked.length).toBeGreaterThan(0);
    expect(log.ruflo_invoked[0]!.tier).toBe('unavailable');
    expect(log.ruflo_invoked[0]!.reason).toBe('ruflo-not-available');
  });

  it('emits ruflo_invoked entries for phase2 when its own phase1 inputs are missing (phase1 is not invokable upstream, so empty)', async () => {
    // Documenting the Phase-1-as-entry behaviour: phase1 paths map to phase2
    // in INPUT_OWNER_MAP, but the gate refuses to invoke its own phase as
    // upstream — so ruflo_invoked stays empty. The blocked verdict is still
    // recorded with full still_missing detail.
    await gatePhaseInputs('phase2', {
      runDir: tmpDir,
      dossier: makeDossier(tmpDir, 'trace-phase1-entry'),
      context: makeContext(tmpDir),
      runPrimaryPhaseExecution: async (phaseId) => makeUnavailableResult(phaseId),
    });

    const logPath = path.join(tmpDir, 'phase2', 'gate-decision-log.json');
    expect(fs.existsSync(logPath)).toBe(true);
    const log = JSON.parse(fs.readFileSync(logPath, 'utf8')) as GateDecisionLog;
    expect(log.verdict).toBe('blocked');
    expect(log.still_missing).toContain('phase1/manifest.json');
    expect(log.ruflo_invoked).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// PHASE_DEPENDENCIES regression — D2 and D3 declared correctly
// ---------------------------------------------------------------------------

describe('ADR-094 — PHASE_DEPENDENCIES declarations', () => {
  it('phase5a-prompts includes Phase-1 fallback paths in both any-of clauses', () => {
    const dep = PHASE_DEPENDENCIES['phase5a-prompts'];
    expect(dep.required).toHaveLength(2);
    const firstClause = dep.required[0]!;
    const secondClause = dep.required[1]!;
    expect(firstClause.kind).toBe('any-of');
    expect(firstClause.paths).toContain('phase1/decision-memo.md');
    expect(secondClause.kind).toBe('any-of');
    expect(secondClause.paths).toContain('phase1/decision-memo.md');
    expect(secondClause.paths).toContain('phase1/scenario.json');
  });

  it('phase5b-scaffold requires phase5a/execution-plan.json (not optional)', () => {
    const dep = PHASE_DEPENDENCIES['phase5b-scaffold'];
    expect(dep.required.length).toBeGreaterThanOrEqual(2);
    const planClause = dep.required.find((r) =>
      r.paths.some((p) => p === 'phase5a/execution-plan.json')
    );
    expect(planClause).toBeDefined();
    expect(planClause!.minBytes).toBe(50);
    expect(dep.optional).not.toContain('phase5a/execution-plan.json');
  });
});
