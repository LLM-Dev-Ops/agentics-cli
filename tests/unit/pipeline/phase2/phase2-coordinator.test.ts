/**
 * Phase2 Pipeline Coordinator — Unit / Integration Tests
 *
 * Tests the end-to-end Phase 2 pipeline coordinator which runs 6 sequential
 * stages: artifact-loading, research-dossier, sparc-specification,
 * adr-generation, ddd-generation, tdd-plan-generation.
 *
 * Uses real fixture data from tests/fixtures/phase2/run-fixture-001/.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { executePhase2Pipeline } from '../../../../src/pipeline/phase2/index.js';
import type {
  Phase2Context,
  Phase2PipelineResult,
  Phase1Artifacts,
} from '../../../../src/pipeline/phase2/index.js';

jest.setTimeout(30000);

// ============================================================================
// Helpers
// ============================================================================

const FIXTURE_DIR = path.resolve(
  __dirname,
  '../../../fixtures/phase2/run-fixture-001',
);

/**
 * Build a minimal Phase2Context pointing at the given phase1Dir.
 * phase1Artifacts is set to a placeholder; the artifact-loading stage
 * will overwrite it on success.
 */
function buildContext(phase1Dir: string, phase2Dir: string): Phase2Context {
  const placeholder = {
    manifest: { run_id: 'placeholder' },
  } as unknown as Phase1Artifacts;

  return {
    traceId: 'test-trace-001',
    phase1Dir,
    phase2Dir,
    phase1Artifacts: placeholder,
    stageOutputs: new Map(),
    telemetrySpans: [],
  };
}

/**
 * Create a fresh temp directory and return its absolute path.
 */
function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'phase2-test-'));
}

/**
 * Best-effort removal of a directory tree.
 */
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

describe('executePhase2Pipeline', () => {

  // ==========================================================================
  // 1. Full pipeline integration test
  // ==========================================================================

  describe('full pipeline integration', () => {
    let result: Phase2PipelineResult;
    let phase2Dir: string;
    let context: Phase2Context;

    beforeAll(async () => {
      phase2Dir = createTempDir();
      context = buildContext(FIXTURE_DIR, phase2Dir);
      result = await executePhase2Pipeline(context);
    });

    afterAll(() => {
      removeTempDir(phase2Dir);
    });

    it('should produce 6 stage results', () => {
      expect(result.stageResults).toHaveLength(6);
    });

    it('should complete all 6 stages successfully', () => {
      const stages = result.stageResults.map((s) => ({
        stage: s.stage,
        status: s.status,
      }));
      expect(stages).toEqual([
        { stage: 'artifact-loading', status: 'completed' },
        { stage: 'research-dossier', status: 'completed' },
        { stage: 'sparc-specification', status: 'completed' },
        { stage: 'adr-generation', status: 'completed' },
        { stage: 'ddd-generation', status: 'completed' },
        { stage: 'tdd-plan-generation', status: 'completed' },
      ]);
    });

    it('should produce a manifest with artifacts', () => {
      expect(result.manifest.artifacts.length).toBeGreaterThan(0);
    });

    it('should set manifest schema_version to 2.0.0', () => {
      expect(result.manifest.schema_version).toBe('2.0.0');
    });

    it('should report positive totalTiming', () => {
      expect(result.totalTiming).toBeGreaterThan(0);
    });

    it('should create sparc/ output subdirectory', () => {
      expect(fs.existsSync(path.join(phase2Dir, 'sparc'))).toBe(true);
    });

    it('should create adrs/ output subdirectory', () => {
      expect(fs.existsSync(path.join(phase2Dir, 'adrs'))).toBe(true);
    });

    it('should create ddd/ output subdirectory', () => {
      expect(fs.existsSync(path.join(phase2Dir, 'ddd'))).toBe(true);
    });

    it('should create tdd/ output subdirectory', () => {
      expect(fs.existsSync(path.join(phase2Dir, 'tdd'))).toBe(true);
    });

    it('should write phase2-manifest.json to the output directory', () => {
      const manifestPath = path.join(phase2Dir, 'phase2-manifest.json');
      expect(fs.existsSync(manifestPath)).toBe(true);

      const written = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
      expect(written.schema_version).toBe('2.0.0');
      expect(written.trace_id).toBe('test-trace-001');
    });

    it('should write telemetry.jsonl to the output directory', () => {
      const telemetryPath = path.join(phase2Dir, 'telemetry.jsonl');
      expect(fs.existsSync(telemetryPath)).toBe(true);

      const lines = fs
        .readFileSync(telemetryPath, 'utf-8')
        .trim()
        .split('\n')
        .filter((l) => l.length > 0);
      expect(lines.length).toBeGreaterThan(0);

      // Each line should be valid JSON
      for (const line of lines) {
        expect(() => JSON.parse(line)).not.toThrow();
      }
    });

    // ========================================================================
    // Dynamic output count assertions
    // ========================================================================

    describe('dynamic SPARC output', () => {
      let sparc: Record<string, any>;

      beforeAll(() => {
        sparc = JSON.parse(
          fs.readFileSync(path.join(phase2Dir, 'sparc', 'sparc-combined.json'), 'utf-8'),
        );
      });

      it('should produce more services than the old hardcoded 6', () => {
        expect(sparc.architecture.services.length).toBeGreaterThan(6);
      });

      it('should include a gateway service', () => {
        const hasGateway = sparc.architecture.services.some(
          (s: any) => s.name.includes('gateway'),
        );
        expect(hasGateway).toBe(true);
      });

      it('should include a monitoring service', () => {
        const hasMonitoring = sparc.architecture.services.some(
          (s: any) => s.name.includes('monitor'),
        );
        expect(hasMonitoring).toBe(true);
      });

      it('should not contain the old hardcoded service names', () => {
        const oldNames = ['core-engine', 'integration-adapter', 'governance-engine'];
        const serviceNames = sparc.architecture.services.map((s: any) => s.name);
        for (const old of oldNames) {
          expect(serviceNames).not.toContain(old);
        }
      });

      it('should produce security boundaries from high-severity risk items', () => {
        expect(sparc.architecture.securityBoundaries.length).toBeGreaterThanOrEqual(1);
      });

      it('should produce API contracts from inter-service dependencies', () => {
        expect(sparc.architecture.apiContracts.length).toBeGreaterThanOrEqual(1);
      });

      it('should produce performance targets from success criteria', () => {
        expect(sparc.refinement.performanceTargets.length).toBeGreaterThanOrEqual(1);
      });

      it('should include all 5 SPARC phases', () => {
        expect(sparc).toHaveProperty('specification');
        expect(sparc).toHaveProperty('pseudocode');
        expect(sparc).toHaveProperty('architecture');
        expect(sparc).toHaveProperty('refinement');
        expect(sparc).toHaveProperty('completion');
      });
    });

    describe('dynamic ADR output', () => {
      let adrs: any[];
      let sparc: Record<string, any>;

      beforeAll(() => {
        adrs = JSON.parse(
          fs.readFileSync(path.join(phase2Dir, 'adrs', 'adr-index.json'), 'utf-8'),
        );
        sparc = JSON.parse(
          fs.readFileSync(path.join(phase2Dir, 'sparc', 'sparc-combined.json'), 'utf-8'),
        );
      });

      it('should produce more ADRs than the old hardcoded 7', () => {
        expect(adrs.length).toBeGreaterThan(7);
      });

      it('should produce at least as many ADRs as SPARC services', () => {
        expect(adrs.length).toBeGreaterThanOrEqual(sparc.architecture.services.length);
      });

      it('should assign sequential ADR IDs', () => {
        for (let i = 0; i < adrs.length; i++) {
          const expected = `ADR-P2-${String(i + 1).padStart(3, '0')}`;
          expect(adrs[i].id).toBe(expected);
        }
      });

      it('should have non-empty sparcSectionRefs on every ADR', () => {
        for (const adr of adrs) {
          expect(adr.sparcSectionRefs.length).toBeGreaterThan(0);
        }
      });

      it('should have non-empty researchDossierItemRefs on every ADR', () => {
        for (const adr of adrs) {
          expect(adr.researchDossierItemRefs.length).toBeGreaterThan(0);
        }
      });

      it('should have at least 2 alternatives on every ADR', () => {
        for (const adr of adrs) {
          expect(adr.alternatives.length).toBeGreaterThanOrEqual(2);
        }
      });

      it('should have at least 1 consequence on every ADR', () => {
        for (const adr of adrs) {
          expect(adr.consequences.length).toBeGreaterThanOrEqual(1);
        }
      });

      it('should write individual ADR markdown files', () => {
        const adrFiles = fs.readdirSync(path.join(phase2Dir, 'adrs'))
          .filter((f: string) => f.endsWith('.md'));
        // At least one markdown file per ADR
        expect(adrFiles.length).toBe(adrs.length);
        for (const file of adrFiles) {
          const content = fs.readFileSync(path.join(phase2Dir, 'adrs', file), 'utf-8');
          expect(content.length).toBeGreaterThan(0);
        }
      });
    });

    describe('dynamic DDD output', () => {
      let ddd: Record<string, any>;
      let sparc: Record<string, any>;

      beforeAll(() => {
        ddd = JSON.parse(
          fs.readFileSync(path.join(phase2Dir, 'ddd', 'domain-model.json'), 'utf-8'),
        );
        sparc = JSON.parse(
          fs.readFileSync(path.join(phase2Dir, 'sparc', 'sparc-combined.json'), 'utf-8'),
        );
      });

      it('should produce one bounded context per SPARC service', () => {
        expect(ddd.contexts.length).toBe(sparc.architecture.services.length);
      });

      it('should produce at least 1 aggregate per context', () => {
        for (const ctx of ddd.contexts) {
          expect(ctx.aggregates.length).toBeGreaterThanOrEqual(1);
        }
      });

      it('should produce at least 1 entity per aggregate', () => {
        for (const ctx of ddd.contexts) {
          for (const agg of ctx.aggregates) {
            expect(agg.entities.length).toBeGreaterThanOrEqual(1);
          }
        }
      });

      it('should produce at least 1 value object per aggregate', () => {
        for (const ctx of ddd.contexts) {
          for (const agg of ctx.aggregates) {
            expect(agg.valueObjects.length).toBeGreaterThanOrEqual(1);
          }
        }
      });

      it('should produce at least 1 command per context', () => {
        for (const ctx of ddd.contexts) {
          expect(ctx.commands.length).toBeGreaterThanOrEqual(1);
        }
      });

      it('should produce at least 1 query per context', () => {
        for (const ctx of ddd.contexts) {
          expect(ctx.queries.length).toBeGreaterThanOrEqual(1);
        }
      });

      it('should produce at least as many events as commands per context', () => {
        for (const ctx of ddd.contexts) {
          expect(ctx.domainEvents.length).toBeGreaterThanOrEqual(ctx.commands.length);
        }
      });

      it('should not contain bare generic event names (Created/Updated/Completed/Failed)', () => {
        for (const ctx of ddd.contexts) {
          const eventNames = ctx.domainEvents.map((e: any) => e.name);
          // No events should be just the bare generic names
          const genericOnly = eventNames.filter((n: string) =>
            /^(Created|Updated|Completed|Failed)$/.test(n),
          );
          expect(genericOnly).toHaveLength(0);
        }
      });

      it('should produce ubiquitous language terms per context', () => {
        for (const ctx of ddd.contexts) {
          expect(ctx.ubiquitousLanguage.length).toBeGreaterThanOrEqual(1);
        }
      });

      it('should produce a context map with relationships', () => {
        expect(ddd.contextMap).toBeDefined();
        expect(ddd.contextMap.length).toBeGreaterThanOrEqual(1);
      });
    });
  });

  // ==========================================================================
  // 2. Fail-fast test (empty directory, no fixture files)
  // ==========================================================================

  describe('fail-fast on missing artifacts', () => {
    let result: Phase2PipelineResult;
    let emptyDir: string;
    let phase2Dir: string;

    beforeAll(async () => {
      emptyDir = createTempDir();
      phase2Dir = createTempDir();
      const context = buildContext(emptyDir, phase2Dir);
      result = await executePhase2Pipeline(context);
    });

    afterAll(() => {
      removeTempDir(emptyDir);
      removeTempDir(phase2Dir);
    });

    it('should attempt only 1 stage before halting', () => {
      expect(result.stageResults).toHaveLength(1);
    });

    it('should mark the first stage as failed', () => {
      const firstStage = result.stageResults[0];
      expect(firstStage).toBeDefined();
      expect(firstStage!.stage).toBe('artifact-loading');
      expect(firstStage!.status).toBe('failed');
    });

    it('should return a result object (not throw)', () => {
      expect(result).toBeDefined();
      expect(result.traceId).toBe('test-trace-001');
    });

    it('should set schema_version to 2.0.0 in the partial manifest', () => {
      expect(result.manifest.schema_version).toBe('2.0.0');
    });
  });

  // ==========================================================================
  // 3. Telemetry spans collected
  // ==========================================================================

  describe('telemetry span collection', () => {
    it('should populate context.telemetrySpans after a full run', async () => {
      const phase2Dir = createTempDir();
      try {
        const context = buildContext(FIXTURE_DIR, phase2Dir);
        await executePhase2Pipeline(context);

        expect(context.telemetrySpans.length).toBeGreaterThan(0);

        // Each span should have the expected shape
        for (const span of context.telemetrySpans) {
          expect(span).toHaveProperty('spanId');
          expect(span).toHaveProperty('stage');
          expect(span).toHaveProperty('operation');
          expect(span).toHaveProperty('status');
          expect(['ok', 'error']).toContain(span.status);
        }
      } finally {
        removeTempDir(phase2Dir);
      }
    });

    it('should populate context.telemetrySpans even on a failed run', async () => {
      const emptyDir = createTempDir();
      const phase2Dir = createTempDir();
      try {
        const context = buildContext(emptyDir, phase2Dir);
        await executePhase2Pipeline(context);

        // At minimum: the failed artifact-loading stage span + the root pipeline span
        expect(context.telemetrySpans.length).toBeGreaterThanOrEqual(1);
      } finally {
        removeTempDir(emptyDir);
        removeTempDir(phase2Dir);
      }
    });
  });
});
