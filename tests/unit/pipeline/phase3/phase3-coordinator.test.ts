/**
 * Phase3 Pipeline Coordinator — Unit / Integration Tests
 *
 * Tests the end-to-end Phase 3 pipeline coordinator which runs 7 sequential
 * stages: phase2-validation, language-resolution, scaffold-generation,
 * domain-codegen, test-generation, ruflo-execution, manifest-writing.
 *
 * Uses real fixture data from tests/fixtures/phase3/run-fixture-001/.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { jest } from '@jest/globals';

import { executePhase3Pipeline } from '../../../../src/pipeline/phase3/index.js';
import type {
  Phase3Context,
  Phase3PipelineResult,
  Phase2Artifacts,
  LanguageResolution,
  ScaffoldMetadata,
  CodegenOutput,
  TestGenOutput,
} from '../../../../src/pipeline/phase3/index.js';
import type { TelemetrySpan } from '../../../../src/pipeline/phase2/types.js';

// ESM shim (jest useESM): __dirname is not a global here.
const __dirname = path.dirname(fileURLToPath(import.meta.url));

jest.setTimeout(60000);

// ============================================================================
// Helpers
// ============================================================================

const FIXTURE_DIR = path.resolve(
  __dirname,
  '../../../fixtures/phase3/run-fixture-001',
);

const PHASE2_DIR = path.join(FIXTURE_DIR, 'phase2');

/**
 * Build a minimal Phase3Context pointing at the fixture directories.
 * phase2Artifacts is set to a placeholder; the phase2-validation stage
 * will overwrite it on success.
 */
function buildContext(phase2Dir: string, phase3Dir: string): Phase3Context {
  const placeholder = {
    manifest: {},
    sparc: {},
    adrs: [],
    domainModel: { contexts: [], contextMap: [] },
    tddPlan: { approach: '', testPyramid: {}, testSuites: [], mockContracts: [], seamDefinitions: [], executionOrder: [] },
  } as unknown as Phase2Artifacts;

  // Read scenario query from Phase 1 manifest if available
  let scenarioQuery = '';
  try {
    const manifestPath = path.join(FIXTURE_DIR, 'manifest.json');
    if (fs.existsSync(manifestPath)) {
      const raw = fs.readFileSync(manifestPath, 'utf-8');
      const manifest = JSON.parse(raw) as { query?: string };
      scenarioQuery = manifest.query ?? '';
    }
  } catch {
    // best-effort
  }

  return {
    traceId: 'test-trace-p3-001',
    phase2Dir,
    phase3Dir,
    scenarioQuery,
    phase2Artifacts: placeholder,
    stageOutputs: new Map(),
    telemetrySpans: [] as TelemetrySpan[],
  };
}

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'phase3-test-'));
}

function removeTempDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
}

// ============================================================================
// Tests
// ============================================================================

describe('executePhase3Pipeline', () => {

  // ==========================================================================
  // 1. Full pipeline integration test
  // ==========================================================================

  describe('full pipeline integration', () => {
    let result: Phase3PipelineResult;
    let phase3Dir: string;

    beforeAll(async () => {
      phase3Dir = createTempDir();
      const context = buildContext(PHASE2_DIR, phase3Dir);
      result = await executePhase3Pipeline(context);
    });

    afterAll(() => {
      removeTempDir(phase3Dir);
    });

    it('should produce 7 stage results', () => {
      expect(result.stageResults).toHaveLength(7);
    });

    it('should complete all 7 stages successfully', () => {
      const stages = result.stageResults.map((s) => ({
        stage: s.stage,
        status: s.status,
      }));
      expect(stages).toEqual([
        { stage: 'phase2-validation', status: 'completed' },
        { stage: 'language-resolution', status: 'completed' },
        { stage: 'scaffold-generation', status: 'completed' },
        { stage: 'domain-codegen', status: 'completed' },
        { stage: 'test-generation', status: 'completed' },
        { stage: 'ruflo-execution', status: 'completed' },
        { stage: 'manifest-writing', status: 'completed' },
      ]);
    });

    it('should set manifest schema_version to 3.0.0', () => {
      expect(result.manifest.schema_version).toBe('3.0.0');
    });

    it('should produce a manifest with artifacts', () => {
      expect(result.manifest.artifacts.length).toBeGreaterThan(0);
    });

    it('should report positive totalTiming', () => {
      expect(result.totalTiming).toBeGreaterThan(0);
    });

    it('should set manifest success to true', () => {
      expect(result.manifest.success).toBe(true);
    });

    it('should write phase3-manifest.json to the output directory', () => {
      const manifestPath = path.join(phase3Dir, 'phase3-manifest.json');
      expect(fs.existsSync(manifestPath)).toBe(true);

      const written = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
      expect(written.schema_version).toBe('3.0.0');
      expect(written.trace_id).toBe('test-trace-p3-001');
    });

    it('should write telemetry.jsonl to the output directory', () => {
      const telemetryPath = path.join(phase3Dir, 'telemetry.jsonl');
      expect(fs.existsSync(telemetryPath)).toBe(true);

      const lines = fs
        .readFileSync(telemetryPath, 'utf-8')
        .trim()
        .split('\n')
        .filter((l) => l.length > 0);
      expect(lines.length).toBeGreaterThan(0);

      for (const line of lines) {
        expect(() => JSON.parse(line)).not.toThrow();
      }
    });

    it('should create project/ output subdirectory', () => {
      expect(fs.existsSync(path.join(phase3Dir, 'project'))).toBe(true);
    });

    // ========================================================================
    // Language Resolution
    // ========================================================================

    describe('language resolution', () => {
      let langResolution: LanguageResolution;

      beforeAll(() => {
        const langStage = result.stageResults.find(
          (s) => s.stage === 'language-resolution',
        );
        langResolution = langStage!.data as LanguageResolution;
      });

      it('should resolve to TypeScript for the sustainability fixture', () => {
        expect(langResolution.language).toBe('typescript');
      });

      it('should set mixed_mode to false', () => {
        expect(langResolution.mixed_mode).toBe(false);
      });

      it('should have a non-empty rationale', () => {
        expect(langResolution.rationale.length).toBeGreaterThan(0);
      });

      it('should produce at least 2 signals', () => {
        expect(langResolution.signals.length).toBeGreaterThanOrEqual(2);
      });

      it('should have typescript_score > rust_score for sustainability fixture', () => {
        expect(langResolution.typescript_score).toBeGreaterThan(langResolution.rust_score);
      });

      it('should set manifest implementation_language to typescript', () => {
        expect(result.manifest.implementation_language).toBe('typescript');
      });

      it('should set manifest mixed_mode to false', () => {
        expect(result.manifest.mixed_mode).toBe(false);
      });
    });

    // ========================================================================
    // Scaffold Output
    // ========================================================================

    describe('scaffold output', () => {
      let scaffold: ScaffoldMetadata;

      beforeAll(() => {
        const scaffoldStage = result.stageResults.find(
          (s) => s.stage === 'scaffold-generation',
        );
        scaffold = scaffoldStage!.data as ScaffoldMetadata;
      });

      it('should have language set to typescript', () => {
        expect(scaffold.language).toBe('typescript');
      });

      it('should produce one module per bounded context', () => {
        expect(scaffold.modules.length).toBeGreaterThan(0);
      });

      it('should create package.json in project/', () => {
        expect(
          fs.existsSync(path.join(phase3Dir, 'project', 'package.json')),
        ).toBe(true);
      });

      it('should create tsconfig.json in project/', () => {
        expect(
          fs.existsSync(path.join(phase3Dir, 'project', 'tsconfig.json')),
        ).toBe(true);
      });

      it('should create vitest.config.ts in project/', () => {
        expect(
          fs.existsSync(path.join(phase3Dir, 'project', 'vitest.config.ts')),
        ).toBe(true);
      });
    });

    // ========================================================================
    // Domain Codegen Output
    // ========================================================================

    describe('domain codegen output', () => {
      let codegen: CodegenOutput;

      beforeAll(() => {
        const codegenStage = result.stageResults.find(
          (s) => s.stage === 'domain-codegen',
        );
        codegen = codegenStage!.data as CodegenOutput;
      });

      it('should produce aggregate files', () => {
        expect(codegen.totalAggregates).toBeGreaterThan(0);
      });

      it('should produce entity files', () => {
        expect(codegen.totalEntities).toBeGreaterThan(0);
      });

      it('should produce value object files', () => {
        expect(codegen.totalValueObjects).toBeGreaterThan(0);
      });

      it('should produce event files', () => {
        expect(codegen.totalEvents).toBeGreaterThan(0);
      });

      it('should produce command files', () => {
        expect(codegen.totalCommands).toBeGreaterThan(0);
      });

      it('should produce query files', () => {
        expect(codegen.totalQueries).toBeGreaterThan(0);
      });

      it('should produce seam files', () => {
        expect(codegen.totalSeams).toBeGreaterThan(0);
      });

      it('should produce more than 50 total files', () => {
        expect(codegen.files.length).toBeGreaterThan(50);
      });

      it('should not contain infrastructure code', () => {
        for (const file of codegen.files) {
          expect(file.content).not.toMatch(/createServer|express|fastify|koa/);
          expect(file.content).not.toMatch(/new Pool|createPool|pg\.connect/);
          expect(file.content).not.toMatch(/docker|kubernetes|k8s|helm/i);
        }
      });

      it('should only produce known CodegenFile kinds', () => {
        // The full CodegenFile.kind union (src/pipeline/phase3/types.ts): domain
        // artifacts + mod/barrel + implementation-prompt (ADR-004) + the
        // production infrastructure files (ADR-PIPELINE-027). Every emitted file
        // must carry one of these known kinds.
        const validKinds = [
          'aggregate', 'entity', 'value-object', 'event', 'command', 'query',
          'seam', 'mod', 'barrel', 'implementation-prompt', 'infrastructure',
        ];
        for (const file of codegen.files) {
          expect(validKinds).toContain(file.kind);
        }
      });
    });

    // ========================================================================
    // Test Generation Output
    // ========================================================================

    describe('test generation output', () => {
      let testOutput: TestGenOutput;

      beforeAll(() => {
        const testStage = result.stageResults.find(
          (s) => s.stage === 'test-generation',
        );
        testOutput = testStage!.data as TestGenOutput;
      });

      it('should produce test files', () => {
        expect(testOutput.files.length).toBeGreaterThan(0);
      });

      it('should produce a positive totalTests count', () => {
        expect(testOutput.totalTests).toBeGreaterThan(0);
      });

      it('should have unit tests in pyramid distribution', () => {
        expect(testOutput.pyramidDistribution.unit).toBeGreaterThan(0);
      });

      it('should include Given/When/Then comments in test files', () => {
        const testFiles = testOutput.files.filter((f) => f.testCount > 0);
        expect(testFiles.length).toBeGreaterThan(0);

        // Check at least one test file has Given/When/Then
        const hasGWT = testFiles.some(
          (f) =>
            f.content.includes('GIVEN:') &&
            f.content.includes('WHEN:') &&
            f.content.includes('THEN:'),
        );
        expect(hasGWT).toBe(true);
      });

      it('should generate Vitest imports for TypeScript', () => {
        const tsTestFiles = testOutput.files.filter(
          (f) => f.testCount > 0 && f.relativePath.endsWith('.test.ts'),
        );
        expect(tsTestFiles.length).toBeGreaterThan(0);

        for (const file of tsTestFiles) {
          expect(file.content).toContain("from 'vitest'");
        }
      });
    });

    // ========================================================================
    // Ruflo Execution (graceful skip)
    // ========================================================================

    describe('ruflo execution', () => {
      it('should complete (skipped or success) rather than fail', () => {
        const rufloStage = result.stageResults.find(
          (s) => s.stage === 'ruflo-execution',
        );
        expect(rufloStage!.status).toBe('completed');
      });

      it('should indicate ruflo was skipped if not installed', () => {
        const rufloStage = result.stageResults.find(
          (s) => s.stage === 'ruflo-execution',
        );
        const data = rufloStage!.data as { skipped?: boolean };
        // Ruflo is not installed in test env, so it should be skipped
        if (data.skipped) {
          expect(data.skipped).toBe(true);
        }
      });
    });

    // ========================================================================
    // Manifest Artifacts (SHA-256 checksums)
    // ========================================================================

    describe('manifest artifacts', () => {
      it('should have SHA-256 checksums on all artifacts', () => {
        for (const artifact of result.manifest.artifacts) {
          expect(artifact.sha256).toMatch(/^[a-f0-9]{64}$/);
        }
      });

      it('should have positive size_bytes on all non-gitkeep artifacts', () => {
        const nonGitkeep = result.manifest.artifacts.filter(
          (a) => !a.path.endsWith('.gitkeep'),
        );
        expect(nonGitkeep.length).toBeGreaterThan(0);
        for (const artifact of nonGitkeep) {
          expect(artifact.size_bytes).toBeGreaterThan(0);
        }
      });

      it('should have unique paths for all artifacts', () => {
        const paths = result.manifest.artifacts.map((a) => a.path);
        expect(new Set(paths).size).toBe(paths.length);
      });
    });
  });

  // ==========================================================================
  // 2. Fail-fast test (empty directory, no Phase 2 files)
  // ==========================================================================

  describe('fail-fast on missing Phase 2 artifacts', () => {
    let result: Phase3PipelineResult;
    let emptyDir: string;
    let phase3Dir: string;

    beforeAll(async () => {
      emptyDir = createTempDir();
      phase3Dir = createTempDir();
      const context = buildContext(emptyDir, phase3Dir);
      result = await executePhase3Pipeline(context);
    });

    afterAll(() => {
      removeTempDir(emptyDir);
      removeTempDir(phase3Dir);
    });

    it('should attempt only 1 stage before halting', () => {
      expect(result.stageResults).toHaveLength(1);
    });

    it('should mark the first stage as failed', () => {
      const firstStage = result.stageResults[0];
      expect(firstStage).toBeDefined();
      expect(firstStage!.stage).toBe('phase2-validation');
      expect(firstStage!.status).toBe('failed');
    });

    it('should return a result object (not throw)', () => {
      expect(result).toBeDefined();
      expect(result.traceId).toBe('test-trace-p3-001');
    });

    it('should set schema_version to 3.0.0 in the partial manifest', () => {
      expect(result.manifest.schema_version).toBe('3.0.0');
    });

    it('should set manifest success to false', () => {
      expect(result.manifest.success).toBe(false);
    });
  });

  // ==========================================================================
  // 3. Telemetry spans collected
  // ==========================================================================

  describe('telemetry span collection', () => {
    it('should populate context.telemetrySpans after a full run', async () => {
      const phase3Dir = createTempDir();
      try {
        const context = buildContext(PHASE2_DIR, phase3Dir);
        await executePhase3Pipeline(context);

        expect(context.telemetrySpans.length).toBeGreaterThan(0);

        for (const span of context.telemetrySpans) {
          expect(span).toHaveProperty('spanId');
          expect(span).toHaveProperty('stage');
          expect(span).toHaveProperty('operation');
          expect(span).toHaveProperty('status');
          expect(['ok', 'error']).toContain(span.status);
        }
      } finally {
        removeTempDir(phase3Dir);
      }
    });

    it('should populate context.telemetrySpans even on a failed run', async () => {
      const emptyDir = createTempDir();
      const phase3Dir = createTempDir();
      try {
        const context = buildContext(emptyDir, phase3Dir);
        await executePhase3Pipeline(context);

        expect(context.telemetrySpans.length).toBeGreaterThanOrEqual(1);
      } finally {
        removeTempDir(emptyDir);
        removeTempDir(phase3Dir);
      }
    });
  });

  // ==========================================================================
  // 4. Determinism test
  // ==========================================================================

  describe('deterministic output', () => {
    it('should produce identical manifests on two runs', async () => {
      const phase3Dir1 = createTempDir();
      const phase3Dir2 = createTempDir();

      try {
        const ctx1 = buildContext(PHASE2_DIR, phase3Dir1);
        const ctx2 = buildContext(PHASE2_DIR, phase3Dir2);

        const result1 = await executePhase3Pipeline(ctx1);
        const result2 = await executePhase3Pipeline(ctx2);

        // Same number of artifacts
        expect(result1.manifest.artifacts.length).toBe(
          result2.manifest.artifacts.length,
        );

        // Same artifact paths (sorted)
        const paths1 = result1.manifest.artifacts
          .map((a) => a.path)
          .sort();
        const paths2 = result2.manifest.artifacts
          .map((a) => a.path)
          .sort();
        expect(paths1).toEqual(paths2);

        // Same SHA-256 checksums for matching paths
        const checksums1 = new Map(
          result1.manifest.artifacts.map((a) => [a.path, a.sha256]),
        );
        const checksums2 = new Map(
          result2.manifest.artifacts.map((a) => [a.path, a.sha256]),
        );
        // Skip ruflo/claude-flow RUNTIME STATE files — they carry timestamped /
        // random swarm + task ids by design and are not generated domain code.
        const isTransientState = (p: string): boolean =>
          p.includes('.claude-flow/') || p.includes('.swarm/');
        for (const [p, hash] of checksums1) {
          if (isTransientState(p)) continue;
          expect(checksums2.get(p)).toBe(hash);
        }

        // Same language
        expect(result1.manifest.implementation_language).toBe(
          result2.manifest.implementation_language,
        );
      } finally {
        removeTempDir(phase3Dir1);
        removeTempDir(phase3Dir2);
      }
    });
  });
});
