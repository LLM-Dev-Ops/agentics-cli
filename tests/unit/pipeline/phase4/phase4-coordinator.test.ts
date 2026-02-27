/**
 * Phase 4 Pipeline Coordinator — Unit / Integration Tests
 *
 * Tests the end-to-end Phase 4 pipeline coordinator which runs 9 sequential
 * stages: phase3-validation, erp-target-resolution, schema-generation,
 * infra-adapter-generation, http-server-generation, erp-client-generation,
 * deployment-generation, metadata-augmentation, manifest-writing.
 *
 * Uses real fixture data from tests/fixtures/phase4/run-fixture-001/.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { executePhase4Pipeline } from '../../../../src/pipeline/phase4/index.js';
import type {
  Phase4Context,
  Phase4PipelineResult,
  Phase4Manifest,
  Phase3Artifacts,
  ERPResolution,
  SchemaGenOutput,
  InfraAdapterOutput,
  HttpServerOutput,
  ERPClientOutput,
  DeploymentOutput,
  MetadataAugmentOutput,
} from '../../../../src/pipeline/phase4/index.js';
import type { TelemetrySpan } from '../../../../src/pipeline/phase2/types.js';

jest.setTimeout(60000);

// ============================================================================
// Helpers
// ============================================================================

const FIXTURE_DIR = path.resolve(
  __dirname,
  '../../../fixtures/phase4/run-fixture-001',
);

const PHASE2_DIR = path.join(FIXTURE_DIR, 'phase2');
const PHASE3_DIR = path.join(FIXTURE_DIR, 'phase3');

function buildContext(phase2Dir: string, phase3Dir: string, phase4Dir: string): Phase4Context {
  const emptyPhase3Artifacts = {
    manifest: {},
    implementationLanguage: 'typescript',
    projectDir: '',
    phase2Artifacts: {
      manifest: {},
      sparc: {},
      adrs: [],
      domainModel: { contexts: [], contextMap: [] },
      tddPlan: { approach: '', testPyramid: {}, testSuites: [], mockContracts: [], seamDefinitions: [], executionOrder: [] },
    },
  } as unknown as Phase3Artifacts;

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
    traceId: 'test-trace-p4-001',
    phase2Dir,
    phase3Dir,
    phase4Dir,
    scenarioQuery,
    phase3Artifacts: emptyPhase3Artifacts,
    platformRepoPaths: {
      'agentics-contracts': '/tmp/fake-repo/agentics-contracts',
      'infra': '/tmp/fake-repo/infra',
      'integrations': '/tmp/fake-repo/integrations',
      'erp-surface': '/tmp/fake-repo/erp-surface',
    },
    stageOutputs: new Map(),
    telemetrySpans: [] as TelemetrySpan[],
  };
}

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'phase4-test-'));
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

describe('executePhase4Pipeline', () => {

  // ==========================================================================
  // 1. Full pipeline integration test (SAP S/4HANA scenario)
  // ==========================================================================

  describe('full pipeline integration (SAP S/4HANA)', () => {
    let result: Phase4PipelineResult;
    let phase4Dir: string;

    beforeAll(async () => {
      phase4Dir = createTempDir();
      const context = buildContext(PHASE2_DIR, PHASE3_DIR, phase4Dir);
      result = await executePhase4Pipeline(context);
    });

    afterAll(() => {
      removeTempDir(phase4Dir);
    });

    it('should produce 9 stage results', () => {
      expect(result.stageResults).toHaveLength(9);
    });

    it('should complete all 9 stages successfully', () => {
      const stages = result.stageResults.map((s) => ({
        stage: s.stage,
        status: s.status,
      }));

      for (const stage of stages) {
        expect(stage.status).toBe('completed');
      }
    });

    it('should execute stages in correct order', () => {
      const stageNames = result.stageResults.map((s) => s.stage);
      expect(stageNames).toEqual([
        'phase3-validation',
        'erp-target-resolution',
        'schema-generation',
        'infra-adapter-generation',
        'http-server-generation',
        'erp-client-generation',
        'deployment-generation',
        'metadata-augmentation',
        'manifest-writing',
      ]);
    });

    it('should write manifest with schema_version 4.0.0', () => {
      expect(result.manifest.schema_version).toBe('4.0.0');
    });

    it('should report success in manifest', () => {
      expect(result.manifest.success).toBe(true);
    });

    it('should detect SAP S/4HANA as ERP system', () => {
      expect(result.manifest.erp_system).toBe('sap-s4hana');
    });

    it('should resolve SAP HANA as database engine', () => {
      expect(result.manifest.database_engine).toBe('sap-hana');
    });

    it('should not be API-only', () => {
      expect(result.manifest.api_only).toBe(false);
    });

    it('should set implementation language to typescript', () => {
      expect(result.manifest.implementation_language).toBe('typescript');
    });

    it('should include artifacts in manifest', () => {
      expect(result.manifest.artifacts.length).toBeGreaterThan(0);
    });

    it('should include timing', () => {
      expect(result.totalTiming).toBeGreaterThanOrEqual(0);
      expect(result.manifest.total_timing_ms).toBeGreaterThanOrEqual(0);
    });

    it('should set correct trace ID', () => {
      expect(result.traceId).toBe('test-trace-p4-001');
      expect(result.manifest.trace_id).toBe('test-trace-p4-001');
    });

    it('should write phase4-manifest.json to disk', () => {
      const manifestPath = path.join(phase4Dir, 'phase4-manifest.json');
      expect(fs.existsSync(manifestPath)).toBe(true);

      const raw = fs.readFileSync(manifestPath, 'utf-8');
      const manifest = JSON.parse(raw) as Phase4Manifest;
      expect(manifest.schema_version).toBe('4.0.0');
      expect(manifest.success).toBe(true);
    });

    it('should write telemetry.jsonl to disk', () => {
      const telemetryPath = path.join(phase4Dir, 'telemetry.jsonl');
      expect(fs.existsSync(telemetryPath)).toBe(true);
    });
  });

  // ==========================================================================
  // 2. Stage-specific output verification
  // ==========================================================================

  describe('stage output verification', () => {
    let result: Phase4PipelineResult;
    let phase4Dir: string;

    beforeAll(async () => {
      phase4Dir = createTempDir();
      const context = buildContext(PHASE2_DIR, PHASE3_DIR, phase4Dir);
      result = await executePhase4Pipeline(context);
    });

    afterAll(() => {
      removeTempDir(phase4Dir);
    });

    it('Stage 1: phase3-validation should load Phase 3 artifacts', () => {
      const stage = result.stageResults.find(s => s.stage === 'phase3-validation');
      expect(stage).toBeDefined();
      expect(stage!.status).toBe('completed');
      const data = stage!.data as Phase3Artifacts;
      expect(data.implementationLanguage).toBe('typescript');
    });

    it('Stage 2: erp-target-resolution should resolve SAP S/4HANA', () => {
      const stage = result.stageResults.find(s => s.stage === 'erp-target-resolution');
      expect(stage).toBeDefined();
      expect(stage!.status).toBe('completed');
      const data = stage!.data as ERPResolution;
      expect(data.erpSystem).toBe('sap-s4hana');
      expect(data.databaseEngine).toBe('sap-hana');
      expect(data.sqlDialect).toBe('hana-sql');
      expect(data.apiOnly).toBe(false);
      expect(data.confidence).toBeGreaterThanOrEqual(0.9);
    });

    it('Stage 3: schema-generation should generate SQL files', () => {
      const stage = result.stageResults.find(s => s.stage === 'schema-generation');
      expect(stage).toBeDefined();
      expect(stage!.status).toBe('completed');
      const data = stage!.data as SchemaGenOutput;
      expect(data.dialect).toBe('hana-sql');
      expect(data.skipped).toBe(false);
      expect(data.tableCount).toBeGreaterThan(0);
      expect(data.files.length).toBeGreaterThan(0);
    });

    it('Stage 4: infra-adapter-generation should complete (adapters depend on port files)', () => {
      const stage = result.stageResults.find(s => s.stage === 'infra-adapter-generation');
      expect(stage).toBeDefined();
      expect(stage!.status).toBe('completed');
      const data = stage!.data as InfraAdapterOutput;
      // totalAdapters may be 0 if no port files exist in the Phase 3 project fixture
      expect(data.totalAdapters).toBeGreaterThanOrEqual(0);
      // Shared infra files (connection-pool, iam-helper, telemetry-wrapper) are always generated
      expect(data.connectionPoolConfig).toBeDefined();
    });

    it('Stage 5: http-server-generation should generate Hono server', () => {
      const stage = result.stageResults.find(s => s.stage === 'http-server-generation');
      expect(stage).toBeDefined();
      expect(stage!.status).toBe('completed');
      const data = stage!.data as HttpServerOutput;
      expect(data.framework).toBe('hono');
      expect(data.routeCount).toBeGreaterThan(0);
      expect(data.files.length).toBeGreaterThan(0);
    });

    it('Stage 6: erp-client-generation should generate client files', () => {
      const stage = result.stageResults.find(s => s.stage === 'erp-client-generation');
      expect(stage).toBeDefined();
      expect(stage!.status).toBe('completed');
      const data = stage!.data as ERPClientOutput;
      expect(data.endpointCount).toBeGreaterThan(0);
      expect(data.files.length).toBeGreaterThan(0);
    });

    it('Stage 7: deployment-generation should generate Cloud Run config', () => {
      const stage = result.stageResults.find(s => s.stage === 'deployment-generation');
      expect(stage).toBeDefined();
      expect(stage!.status).toBe('completed');
      const data = stage!.data as DeploymentOutput;
      expect(data.cloudRunService).toBeDefined();
      expect(data.files.length).toBeGreaterThanOrEqual(4);
    });

    it('Stage 8: metadata-augmentation should generate runtime decisions', () => {
      const stage = result.stageResults.find(s => s.stage === 'metadata-augmentation');
      expect(stage).toBeDefined();
      expect(stage!.status).toBe('completed');
      const data = stage!.data as MetadataAugmentOutput;
      expect(data.runtimeDecisions.length).toBeGreaterThanOrEqual(4);
      expect(data.augmentedADRCount).toBeGreaterThanOrEqual(0);
    });
  });

  // ==========================================================================
  // 3. Fail-fast behavior
  // ==========================================================================

  describe('fail-fast on Phase 3 validation failure', () => {
    let result: Phase4PipelineResult;
    let phase4Dir: string;

    beforeAll(async () => {
      phase4Dir = createTempDir();
      // Point at a non-existent phase3 dir to trigger validation failure
      const context = buildContext(PHASE2_DIR, '/tmp/nonexistent-phase3', phase4Dir);
      result = await executePhase4Pipeline(context);
    });

    afterAll(() => {
      removeTempDir(phase4Dir);
    });

    it('should fail at phase3-validation stage', () => {
      const firstStage = result.stageResults[0]!;
      expect(firstStage.stage).toBe('phase3-validation');
      expect(firstStage.status).toBe('failed');
    });

    it('should halt pipeline after first failure', () => {
      // Only 1 stage should have run before the pipeline halted
      expect(result.stageResults.length).toBe(1);
    });

    it('should report success=false in manifest', () => {
      expect(result.manifest.success).toBe(false);
    });
  });

  // ==========================================================================
  // 4. Phase 3 manifest validation (success=false)
  // ==========================================================================

  describe('gate on Phase 3 manifest success=false', () => {
    let result: Phase4PipelineResult;
    let phase4Dir: string;
    let failedPhase3Dir: string;

    beforeAll(async () => {
      phase4Dir = createTempDir();
      failedPhase3Dir = createTempDir();

      // Write a Phase 3 manifest with success=false
      fs.writeFileSync(
        path.join(failedPhase3Dir, 'phase3-manifest.json'),
        JSON.stringify({
          schema_version: '3.0.0',
          trace_id: 'test-failed',
          implementation_language: 'typescript',
          mixed_mode: false,
          ruflo_version: '0.1.0',
          artifacts: [],
          total_timing_ms: 100,
          success: false,
        }),
        'utf-8',
      );

      const context = buildContext(PHASE2_DIR, failedPhase3Dir, phase4Dir);
      result = await executePhase4Pipeline(context);
    });

    afterAll(() => {
      removeTempDir(phase4Dir);
      removeTempDir(failedPhase3Dir);
    });

    it('should fail at phase3-validation stage', () => {
      expect(result.stageResults[0]!.stage).toBe('phase3-validation');
      expect(result.stageResults[0]!.status).toBe('failed');
    });

    it('should include ECLI-P4-001 in error message', () => {
      const data = result.stageResults[0]!.data as { error: string };
      expect(data.error).toContain('ECLI-P4-001');
    });

    it('should halt after first stage', () => {
      expect(result.stageResults.length).toBe(1);
    });
  });

  // ==========================================================================
  // 5. On-disk output structure verification
  // ==========================================================================

  describe('on-disk output structure', () => {
    let phase4Dir: string;

    beforeAll(async () => {
      phase4Dir = createTempDir();
      const context = buildContext(PHASE2_DIR, PHASE3_DIR, phase4Dir);
      await executePhase4Pipeline(context);
    });

    afterAll(() => {
      removeTempDir(phase4Dir);
    });

    it('should create database/ directory with SQL schema files', () => {
      const dbDir = path.join(phase4Dir, 'database');
      expect(fs.existsSync(dbDir)).toBe(true);

      // Should have at least one context subdirectory
      const entries = fs.readdirSync(dbDir, { withFileTypes: true });
      const dirs = entries.filter(e => e.isDirectory());
      expect(dirs.length).toBeGreaterThan(0);
    });

    it('should create project/src/server/ directory', () => {
      const serverDir = path.join(phase4Dir, 'project', 'src', 'server');
      expect(fs.existsSync(serverDir)).toBe(true);
    });

    it('should create project/src/erp-client/ directory', () => {
      const clientDir = path.join(phase4Dir, 'project', 'src', 'erp-client');
      expect(fs.existsSync(clientDir)).toBe(true);
    });

    it('should create deployment/ directory with Dockerfile', () => {
      const deployDir = path.join(phase4Dir, 'deployment');
      expect(fs.existsSync(deployDir)).toBe(true);
      expect(fs.existsSync(path.join(deployDir, 'Dockerfile'))).toBe(true);
    });

    it('should create deployment/cloud-run-service.yaml', () => {
      expect(fs.existsSync(path.join(phase4Dir, 'deployment', 'cloud-run-service.yaml'))).toBe(true);
    });

    it('should create deployment/cloudbuild.yaml', () => {
      expect(fs.existsSync(path.join(phase4Dir, 'deployment', 'cloudbuild.yaml'))).toBe(true);
    });

    it('should create deployment/.env.example', () => {
      expect(fs.existsSync(path.join(phase4Dir, 'deployment', '.env.example'))).toBe(true);
    });

    it('should create metadata/ directory', () => {
      const metadataDir = path.join(phase4Dir, 'metadata');
      expect(fs.existsSync(metadataDir)).toBe(true);
      expect(fs.existsSync(path.join(metadataDir, 'runtime-decisions.json'))).toBe(true);
      expect(fs.existsSync(path.join(metadataDir, 'augmented-adrs.json'))).toBe(true);
    });

    it('should generate HANA SQL dialect for SAP S/4HANA', () => {
      const dbDir = path.join(phase4Dir, 'database');
      const contextDirs = fs.readdirSync(dbDir, { withFileTypes: true })
        .filter(e => e.isDirectory());

      // Find a .sql file and verify it contains HANA-specific syntax
      let foundHanaSQL = false;
      for (const ctxDir of contextDirs) {
        const files = fs.readdirSync(path.join(dbDir, ctxDir.name));
        for (const file of files) {
          if (file.endsWith('.sql')) {
            const content = fs.readFileSync(path.join(dbDir, ctxDir.name, file), 'utf-8');
            if (content.includes('COLUMN TABLE') || content.includes('NVARCHAR') || content.includes('CURRENT_UTCTIMESTAMP')) {
              foundHanaSQL = true;
            }
          }
        }
      }
      expect(foundHanaSQL).toBe(true);
    });
  });

  // ==========================================================================
  // 6. ERP manifest fields
  // ==========================================================================

  describe('ERP fields in manifest', () => {
    let result: Phase4PipelineResult;
    let phase4Dir: string;

    beforeAll(async () => {
      phase4Dir = createTempDir();
      const context = buildContext(PHASE2_DIR, PHASE3_DIR, phase4Dir);
      result = await executePhase4Pipeline(context);
    });

    afterAll(() => {
      removeTempDir(phase4Dir);
    });

    it('should include erp_system in manifest', () => {
      expect(result.manifest.erp_system).toBeDefined();
      expect(typeof result.manifest.erp_system).toBe('string');
      expect(result.manifest.erp_system).not.toBe('unknown');
    });

    it('should include database_engine in manifest', () => {
      expect(result.manifest.database_engine).toBeDefined();
    });

    it('should include api_only in manifest', () => {
      expect(typeof result.manifest.api_only).toBe('boolean');
    });

    it('should have SHA-256 hashes for all artifacts', () => {
      for (const artifact of result.manifest.artifacts) {
        expect(artifact.sha256).toMatch(/^[a-f0-9]{64}$/);
        expect(artifact.size_bytes).toBeGreaterThan(0);
        expect(artifact.path).toBeDefined();
      }
    });
  });
});
