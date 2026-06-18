/**
 * Unit tests for Phase 2 Pipeline — Stage 1: Artifact Loader
 *
 * Validates that loadPhase1Artifacts correctly loads all 6 Phase 1 artifacts
 * from disk, validates JSON files against their Zod schemas, reads markdown
 * files as plain strings, and surfaces appropriate error codes on failure.
 *
 * Fixture directory: tests/fixtures/phase2/run-fixture-001/
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { jest } from '@jest/globals';
import * as crypto from 'node:crypto';

import { loadPhase1Artifacts } from '../../../../src/pipeline/phase2/phases/artifact-loader.js';
import type {
  Phase1Artifacts,
  Phase2Context,
  Phase2Stage,
  Phase2StageOutput,
} from '../../../../src/pipeline/phase2/types.js';

// ESM shim (jest useESM): __dirname is not a global here.
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FIXTURE_DIR = path.resolve(
  __dirname,
  '../../../../tests/fixtures/phase2/run-fixture-001',
);

const REQUIRED_FILES = [
  'manifest.json',
  'scenario.json',
  'roadmap.json',
  'risk-assessment.json',
  'executive-summary.md',
  'decision-memo.md',
] as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal Phase2Context pointing at the given phase1Dir. */
function buildContext(phase1Dir: string): Phase2Context {
  const phase2Dir = path.join(
    os.tmpdir(),
    `artifact-loader-test-${crypto.randomUUID()}`,
  );
  fs.mkdirSync(phase2Dir, { recursive: true });

  return {
    traceId: 'test-trace',
    phase1Dir,
    phase2Dir,
    phase1Artifacts: {} as Phase1Artifacts,
    stageOutputs: new Map<Phase2Stage, Phase2StageOutput>(),
    telemetrySpans: [],
  };
}

/** Create a temporary directory with a subset of fixture files copied in. */
function createTempFixtureDir(filesToCopy: readonly string[]): string {
  const tmpDir = path.join(
    os.tmpdir(),
    `artifact-loader-partial-${crypto.randomUUID()}`,
  );
  fs.mkdirSync(tmpDir, { recursive: true });

  for (const filename of filesToCopy) {
    const src = path.join(FIXTURE_DIR, filename);
    const dest = path.join(tmpDir, filename);
    fs.copyFileSync(src, dest);
  }

  return tmpDir;
}

// ---------------------------------------------------------------------------
// Suppress stderr noise from telemetry emitSpan during tests
// ---------------------------------------------------------------------------

let stderrSpy: jest.SpiedFunction<typeof console.error>;

beforeAll(() => {
  stderrSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterAll(() => {
  stderrSpy.mockRestore();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('loadPhase1Artifacts', () => {
  // -----------------------------------------------------------------------
  // Happy path: all 6 fixture files present and valid
  // -----------------------------------------------------------------------

  describe('when all 6 fixture files are present and valid', () => {
    let ctx: Phase2Context;
    let result: Phase2StageOutput;

    beforeAll(async () => {
      ctx = buildContext(FIXTURE_DIR);
      result = await loadPhase1Artifacts(ctx);
    });

    it('returns status "completed"', () => {
      expect(result.status).toBe('completed');
    });

    it('returns stage name "artifact-loading"', () => {
      expect(result.stage).toBe('artifact-loading');
    });

    it('lists all 6 artifact filenames in the artifacts array', () => {
      expect(result.artifacts).toHaveLength(6);
      for (const filename of REQUIRED_FILES) {
        expect(result.artifacts).toContain(filename);
      }
    });

    it('sets context.phase1Artifacts with all loaded data', () => {
      const arts = ctx.phase1Artifacts;

      // JSON artifacts are objects
      expect(arts.manifest).toBeDefined();
      expect(typeof arts.manifest).toBe('object');
      expect(arts.manifest.run_id).toBe('run-fixture-001');

      expect(arts.scenario).toBeDefined();
      expect(typeof arts.scenario).toBe('object');

      expect(arts.roadmap).toBeDefined();
      expect(typeof arts.roadmap).toBe('object');
      expect(Array.isArray(arts.roadmap.phases)).toBe(true);

      expect(arts.riskAssessment).toBeDefined();
      expect(typeof arts.riskAssessment).toBe('object');
      expect(arts.riskAssessment.overall_risk_level).toBe('medium-high');

      // Markdown artifacts are strings
      expect(typeof arts.executiveSummary).toBe('string');
      expect(arts.executiveSummary.length).toBeGreaterThan(0);

      expect(typeof arts.decisionMemo).toBe('string');
      expect(arts.decisionMemo.length).toBeGreaterThan(0);
    });

    it('stores the output on context.stageOutputs', () => {
      const stored = ctx.stageOutputs.get('artifact-loading');
      expect(stored).toBeDefined();
      expect(stored!.status).toBe('completed');
    });

    it('timing field is a non-negative number', () => {
      expect(typeof result.timing).toBe('number');
      expect(result.timing).toBeGreaterThanOrEqual(0);
    });

    it('summary string is non-empty', () => {
      expect(typeof result.summary).toBe('string');
      expect(result.summary.length).toBeGreaterThan(0);
    });

    it('summary contains artifact count and directory path', () => {
      expect(result.summary).toContain('6');
      expect(result.summary).toContain(FIXTURE_DIR);
    });

    it('data property contains the loaded Phase1Artifacts object', () => {
      expect(result.data).toBeDefined();
      expect((result.data as Phase1Artifacts).manifest).toBeDefined();
      expect((result.data as Phase1Artifacts).manifest.run_id).toBe(
        'run-fixture-001',
      );
    });
  });

  // -----------------------------------------------------------------------
  // Error: required file missing (ECLI-P2-001)
  // -----------------------------------------------------------------------

  describe('when a required file is missing', () => {
    let result: Phase2StageOutput;
    let tmpDir: string;

    beforeAll(async () => {
      // Copy only 5 of the 6 files -- omit manifest.json (first file loaded)
      const filesWithoutManifest = REQUIRED_FILES.filter(
        (f) => f !== 'manifest.json',
      );
      tmpDir = createTempFixtureDir(filesWithoutManifest);
      const ctx = buildContext(tmpDir);
      result = await loadPhase1Artifacts(ctx);
    });

    afterAll(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('returns status "failed"', () => {
      expect(result.status).toBe('failed');
    });

    it('summary contains ECLI-P2-001 error code', () => {
      expect(result.summary).toContain('ECLI-P2-001');
    });

    it('summary mentions the missing filename', () => {
      expect(result.summary).toContain('manifest.json');
    });

    it('artifacts array is empty on failure', () => {
      expect(result.artifacts).toEqual([]);
    });

    it('data contains the error message', () => {
      expect(result.data).toBeDefined();
      expect((result.data as { error: string }).error).toContain(
        'ECLI-P2-001',
      );
    });
  });

  describe('when a non-first required file is missing', () => {
    let result: Phase2StageOutput;
    let tmpDir: string;

    beforeAll(async () => {
      // Copy all except risk-assessment.json (loaded 5th)
      const filesWithoutRisk = REQUIRED_FILES.filter(
        (f) => f !== 'risk-assessment.json',
      );
      tmpDir = createTempFixtureDir(filesWithoutRisk);
      const ctx = buildContext(tmpDir);
      result = await loadPhase1Artifacts(ctx);
    });

    afterAll(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('returns status "failed"', () => {
      expect(result.status).toBe('failed');
    });

    it('summary contains ECLI-P2-001 and the missing filename', () => {
      expect(result.summary).toContain('ECLI-P2-001');
      expect(result.summary).toContain('risk-assessment.json');
    });
  });

  // -----------------------------------------------------------------------
  // Error: invalid JSON structure (ECLI-P2-002)
  // -----------------------------------------------------------------------

  describe('when a JSON file has invalid structure', () => {
    let result: Phase2StageOutput;
    let tmpDir: string;

    beforeAll(async () => {
      // Copy all fixture files, then overwrite manifest.json with invalid JSON
      tmpDir = createTempFixtureDir(REQUIRED_FILES);
      fs.writeFileSync(
        path.join(tmpDir, 'manifest.json'),
        '{ not valid json !!!',
        'utf-8',
      );
      const ctx = buildContext(tmpDir);
      result = await loadPhase1Artifacts(ctx);
    });

    afterAll(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('returns status "failed"', () => {
      expect(result.status).toBe('failed');
    });

    it('summary contains ECLI-P2-002 error code', () => {
      expect(result.summary).toContain('ECLI-P2-002');
    });

    it('summary mentions the problematic filename', () => {
      expect(result.summary).toContain('manifest.json');
    });

    it('artifacts array is empty on failure', () => {
      expect(result.artifacts).toEqual([]);
    });
  });

  describe('when a JSON file has valid JSON but fails Zod validation', () => {
    let result: Phase2StageOutput;
    let tmpDir: string;

    beforeAll(async () => {
      // Copy all fixture files, then overwrite manifest.json with
      // syntactically valid JSON that does not match Phase1ManifestSchema
      tmpDir = createTempFixtureDir(REQUIRED_FILES);
      fs.writeFileSync(
        path.join(tmpDir, 'manifest.json'),
        JSON.stringify({ unexpected: true }),
        'utf-8',
      );
      const ctx = buildContext(tmpDir);
      result = await loadPhase1Artifacts(ctx);
    });

    afterAll(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('returns status "failed"', () => {
      expect(result.status).toBe('failed');
    });

    it('summary contains ECLI-P2-002 error code', () => {
      expect(result.summary).toContain('ECLI-P2-002');
    });

    it('summary mentions the problematic filename', () => {
      expect(result.summary).toContain('manifest.json');
    });
  });

  // -----------------------------------------------------------------------
  // Edge: completely empty directory
  // -----------------------------------------------------------------------

  describe('when the phase1Dir is an empty directory', () => {
    let result: Phase2StageOutput;
    let tmpDir: string;

    beforeAll(async () => {
      tmpDir = path.join(
        os.tmpdir(),
        `artifact-loader-empty-${crypto.randomUUID()}`,
      );
      fs.mkdirSync(tmpDir, { recursive: true });
      const ctx = buildContext(tmpDir);
      result = await loadPhase1Artifacts(ctx);
    });

    afterAll(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('returns status "failed"', () => {
      expect(result.status).toBe('failed');
    });

    it('summary contains ECLI-P2-001', () => {
      expect(result.summary).toContain('ECLI-P2-001');
    });

    it('fails on the first expected file (manifest.json)', () => {
      expect(result.summary).toContain('manifest.json');
    });
  });

  // -----------------------------------------------------------------------
  // Output shape assertions
  // -----------------------------------------------------------------------

  describe('output shape', () => {
    let result: Phase2StageOutput;

    beforeAll(async () => {
      const ctx = buildContext(FIXTURE_DIR);
      result = await loadPhase1Artifacts(ctx);
    });

    it('has all required Phase2StageOutput fields', () => {
      expect(result).toHaveProperty('stage');
      expect(result).toHaveProperty('status');
      expect(result).toHaveProperty('data');
      expect(result).toHaveProperty('artifacts');
      expect(result).toHaveProperty('timing');
      expect(result).toHaveProperty('summary');
    });

    it('stage is "artifact-loading"', () => {
      expect(result.stage).toBe('artifact-loading');
    });

    it('artifacts is an array of strings', () => {
      expect(Array.isArray(result.artifacts)).toBe(true);
      for (const item of result.artifacts) {
        expect(typeof item).toBe('string');
      }
    });

    it('timing is a number >= 0', () => {
      expect(typeof result.timing).toBe('number');
      expect(result.timing).toBeGreaterThanOrEqual(0);
    });

    it('summary is a non-empty string', () => {
      expect(typeof result.summary).toBe('string');
      expect(result.summary.length).toBeGreaterThan(0);
    });
  });
});
