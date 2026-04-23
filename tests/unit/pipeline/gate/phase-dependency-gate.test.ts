/**
 * ADR-PIPELINE-093 — Phase Dependency Gate unit tests.
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  PHASE_DEPENDENCIES,
  INPUT_OWNER_MAP,
  gatePhaseInputs,
  isNotErrorStub,
  determineBlockedPhases,
  type GateResult,
  type PhaseId,
} from '../../../../src/pipeline/gate/phase-dependency-gate.js';
import type {
  Phase1Dossier,
  RufloExecutionContext,
  PrimaryPhaseExecutionResult,
  runPrimaryPhaseExecution as RunPrimaryPhaseExecutionFn,
  checkRufloAvailable as CheckRufloAvailableFn,
} from '../../../../src/pipeline/ruflo-phase-executor.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let tmpDir: string;

function makeDossier(runDir: string): Phase1Dossier {
  return {
    scenarioQuery: 'test scenario',
    traceId: 'test-trace',
    runDir,
  };
}

function makeContext(runDir: string): RufloExecutionContext {
  return {
    outputDir: path.join(runDir, '.ruflo-cache'),
    language: 'typescript',
  };
}

function writeFile(runDir: string, rel: string, content: string): void {
  const abs = path.join(runDir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf8');
}

/** Creates content guaranteed to exceed the 100-byte minimum and pass the stub check. */
function bigBody(tag: string): string {
  return `# ${tag}\n\n${'x'.repeat(200)}\n`;
}

function makeSuccessResult(
  phaseId: string,
): PrimaryPhaseExecutionResult {
  return {
    phaseId: phaseId as PrimaryPhaseExecutionResult['phaseId'],
    success: true,
    executionTier: 'ruflo-local',
    filesModified: 1,
    timing: 10,
    message: 'ok',
  };
}

function makeUnavailableResult(
  phaseId: string,
): PrimaryPhaseExecutionResult {
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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase-dep-gate-'));
});

afterEach(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('isNotErrorStub', () => {
  it('returns false for JSON error-stub sentinels', () => {
    expect(isNotErrorStub('{"error":"x"}')).toBe(false);
    expect(isNotErrorStub('{"message":"y"}')).toBe(false);
    expect(isNotErrorStub('{"error":"x","message":"y"}')).toBe(false);
  });

  it('returns true for real content and non-JSON', () => {
    expect(isNotErrorStub('{"content":"real"}')).toBe(true);
    expect(isNotErrorStub('plain markdown')).toBe(true);
    expect(isNotErrorStub('')).toBe(true);
  });
});

describe('determineBlockedPhases', () => {
  it('returns entries only for phases with ok=false and stillMissing', () => {
    const ok: GateResult = { ok: true, missing: [], ruflo_invoked: [], stillMissing: [] };
    const blocked: GateResult = {
      ok: false,
      missing: ['x'],
      ruflo_invoked: ['phase3-sparc'],
      stillMissing: ['x'],
    };
    const results: Array<{ phaseId: PhaseId; gateResult: GateResult }> = [
      { phaseId: 'phase2', gateResult: ok },
      { phaseId: 'phase3-sparc', gateResult: ok },
      { phaseId: 'phase4-adrs-ddd', gateResult: blocked },
    ];
    const out = determineBlockedPhases(results);
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({ phase: 'phase4-adrs-ddd', missing: ['x'] });
  });

  it('skips ok=false results that have no stillMissing', () => {
    const weird: GateResult = { ok: false, missing: ['x'], ruflo_invoked: [], stillMissing: [] };
    expect(determineBlockedPhases([{ phaseId: 'phase2', gateResult: weird }])).toHaveLength(0);
  });
});

describe('gatePhaseInputs — happy path', () => {
  it('returns ok with no invocations when all inputs exist', async () => {
    writeFile(tmpDir, 'phase1/manifest.json', bigBody('manifest'));
    writeFile(tmpDir, 'phase2/research-dossier.json', bigBody('dossier'));
    const runPrimary = jest.fn<typeof RunPrimaryPhaseExecutionFn>();
    const result = await gatePhaseInputs('phase3-sparc', {
      runDir: tmpDir,
      dossier: makeDossier(tmpDir),
      context: makeContext(tmpDir),
      runPrimaryPhaseExecution: runPrimary,
    });
    expect(result).toEqual({ ok: true, missing: [], ruflo_invoked: [], stillMissing: [] });
    expect(runPrimary).not.toHaveBeenCalled();
  });
});

describe('gatePhaseInputs — Ruflo recovery', () => {
  it('invokes Ruflo for a missing phase2 input and re-checks', async () => {
    // phase1 exists; phase2 dossier missing. phase3-sparc's gate should invoke phase2.
    writeFile(tmpDir, 'phase1/manifest.json', bigBody('manifest'));
    const runPrimary = jest.fn<typeof RunPrimaryPhaseExecutionFn>(async (phaseId) => {
      if (phaseId === ('phase2' as unknown as Parameters<typeof RunPrimaryPhaseExecutionFn>[0])) {
        writeFile(tmpDir, 'phase2/research-dossier.json', bigBody('dossier'));
      }
      return makeSuccessResult(String(phaseId));
    });
    const result = await gatePhaseInputs('phase3-sparc', {
      runDir: tmpDir,
      dossier: makeDossier(tmpDir),
      context: makeContext(tmpDir),
      runPrimaryPhaseExecution: runPrimary,
    });
    expect(result.ok).toBe(true);
    expect(result.ruflo_invoked).toEqual(['phase2']);
    expect(result.stillMissing).toEqual([]);
    expect(runPrimary).toHaveBeenCalledTimes(1);
  });
});

describe('gatePhaseInputs — any-of satisfaction', () => {
  it('accepts engineering/ fallback for phase4-adrs-ddd without invoking Ruflo', async () => {
    writeFile(tmpDir, 'phase1/manifest.json', bigBody('manifest'));
    // phase3/sparc/specification.md absent; engineering variant present.
    writeFile(tmpDir, 'engineering/sparc-specification.md', bigBody('spec'));
    const runPrimary = jest.fn<typeof RunPrimaryPhaseExecutionFn>();
    const result = await gatePhaseInputs('phase4-adrs-ddd', {
      runDir: tmpDir,
      dossier: makeDossier(tmpDir),
      context: makeContext(tmpDir),
      runPrimaryPhaseExecution: runPrimary,
    });
    expect(result.ok).toBe(true);
    expect(runPrimary).not.toHaveBeenCalled();
  });
});

describe('gatePhaseInputs — error-stub rejection', () => {
  it('treats a JSON error-stub as missing and invokes Ruflo', async () => {
    writeFile(tmpDir, 'phase1/manifest.json', bigBody('manifest'));
    // Pad the stub above 100 bytes so we hit the STUB check and not the size check.
    const stub = JSON.stringify({ error: 'timeout because of a long reason '.repeat(10) });
    writeFile(tmpDir, 'phase2/research-dossier.json', stub);
    expect(stub.length).toBeGreaterThan(100);

    const runPrimary = jest.fn<typeof RunPrimaryPhaseExecutionFn>(async (phaseId) => {
      if (phaseId === ('phase2' as unknown as Parameters<typeof RunPrimaryPhaseExecutionFn>[0])) {
        writeFile(tmpDir, 'phase2/research-dossier.json', bigBody('real dossier'));
      }
      return makeSuccessResult(String(phaseId));
    });
    const result = await gatePhaseInputs('phase3-sparc', {
      runDir: tmpDir,
      dossier: makeDossier(tmpDir),
      context: makeContext(tmpDir),
      runPrimaryPhaseExecution: runPrimary,
    });
    expect(result.ok).toBe(true);
    expect(result.ruflo_invoked).toEqual(['phase2']);
    expect(runPrimary).toHaveBeenCalledTimes(1);
  });
});

describe('gatePhaseInputs — 1-retry cap', () => {
  it('calls Ruflo at most once per upstream phase and returns still-missing on failure', async () => {
    writeFile(tmpDir, 'phase1/manifest.json', bigBody('manifest'));
    // phase2 dossier never appears. Ruflo mock always fails (no file written).
    const runPrimary = jest.fn<typeof RunPrimaryPhaseExecutionFn>(async (phaseId) => {
      return {
        ...makeSuccessResult(String(phaseId)),
        success: false,
        reason: 'ruflo-timeout' as const,
      };
    });
    const result = await gatePhaseInputs('phase3-sparc', {
      runDir: tmpDir,
      dossier: makeDossier(tmpDir),
      context: makeContext(tmpDir),
      runPrimaryPhaseExecution: runPrimary,
    });
    expect(result.ok).toBe(false);
    expect(result.stillMissing).toContain('phase2/research-dossier.json');
    expect(runPrimary).toHaveBeenCalledTimes(1);
  });
});

describe('gatePhaseInputs — size threshold', () => {
  it('treats a sub-100-byte file as missing', async () => {
    writeFile(tmpDir, 'phase1/manifest.json', bigBody('manifest'));
    writeFile(tmpDir, 'phase2/research-dossier.json', 'tiny'); // 4 bytes
    const runPrimary = jest.fn<typeof RunPrimaryPhaseExecutionFn>(async (phaseId) => {
      return {
        ...makeSuccessResult(String(phaseId)),
        success: false,
        reason: 'ruflo-timeout' as const,
      };
    });
    const result = await gatePhaseInputs('phase3-sparc', {
      runDir: tmpDir,
      dossier: makeDossier(tmpDir),
      context: makeContext(tmpDir),
      runPrimaryPhaseExecution: runPrimary,
    });
    expect(result.ok).toBe(false);
    expect(result.stillMissing).toContain('phase2/research-dossier.json');
  });
});

describe('gatePhaseInputs — glob support', () => {
  it('is satisfied by a non-empty phase4/adrs directory for phase5a', async () => {
    // phase5a-prompts needs: sparc spec (any-of) AND (phase4/adrs/*.md OR ddd OR engineering).
    writeFile(tmpDir, 'engineering/sparc-specification.md', bigBody('spec'));
    writeFile(tmpDir, 'phase4/adrs/ADR-001.md', bigBody('adr-001'));
    const runPrimary = jest.fn<typeof RunPrimaryPhaseExecutionFn>();
    const result = await gatePhaseInputs('phase5a-prompts', {
      runDir: tmpDir,
      dossier: makeDossier(tmpDir),
      context: makeContext(tmpDir),
      runPrimaryPhaseExecution: runPrimary,
    });
    expect(result.ok).toBe(true);
    expect(runPrimary).not.toHaveBeenCalled();
  });

  it('treats an empty phase4/adrs directory as missing', async () => {
    writeFile(tmpDir, 'engineering/sparc-specification.md', bigBody('spec'));
    fs.mkdirSync(path.join(tmpDir, 'phase4/adrs'), { recursive: true });
    const runPrimary = jest.fn<typeof RunPrimaryPhaseExecutionFn>(async (phaseId) => {
      return {
        ...makeSuccessResult(String(phaseId)),
        success: false,
        reason: 'ruflo-timeout' as const,
      };
    });
    const result = await gatePhaseInputs('phase5a-prompts', {
      runDir: tmpDir,
      dossier: makeDossier(tmpDir),
      context: makeContext(tmpDir),
      runPrimaryPhaseExecution: runPrimary,
    });
    expect(result.ok).toBe(false);
    // any-of set should include phase4/adrs/*.md as one of the unsatisfied candidates.
    expect(result.missing).toContain('phase4/adrs/*.md');
  });
});

describe('gatePhaseInputs — Ruflo unavailable', () => {
  it('records invocation but does not retry beyond the cap', async () => {
    writeFile(tmpDir, 'phase1/manifest.json', bigBody('manifest'));
    const checkRufloAvailable = jest.fn<typeof CheckRufloAvailableFn>(() => ({
      available: false,
      version: 'N/A',
      binary: '',
      reason: 'binary-not-found' as const,
    }));
    const runPrimary = jest.fn<typeof RunPrimaryPhaseExecutionFn>(async (phaseId) => {
      return makeUnavailableResult(String(phaseId));
    });
    const result = await gatePhaseInputs('phase3-sparc', {
      runDir: tmpDir,
      dossier: makeDossier(tmpDir),
      context: makeContext(tmpDir),
      runPrimaryPhaseExecution: runPrimary,
      checkRufloAvailable,
    });
    expect(result.ok).toBe(false);
    expect(result.ruflo_invoked).toEqual(['phase2']);
    expect(result.stillMissing).toContain('phase2/research-dossier.json');
    expect(runPrimary).toHaveBeenCalledTimes(1);
  });
});

// Sanity: the static tables we exported line up with the ADR.
describe('static tables', () => {
  it('covers all five dependency-gated phases', () => {
    expect(Object.keys(PHASE_DEPENDENCIES).sort()).toEqual(
      ['phase2', 'phase3-sparc', 'phase4-adrs-ddd', 'phase5a-prompts', 'phase5b-scaffold'].sort(),
    );
  });

  it('maps phase4/adrs/ and engineering/architecture-decisions.md to phase4-adrs-ddd', () => {
    expect(INPUT_OWNER_MAP['phase4/adrs/']).toBe('phase4-adrs-ddd');
    expect(INPUT_OWNER_MAP['engineering/architecture-decisions.md']).toBe('phase4-adrs-ddd');
  });
});
