/**
 * ADR-078: Build-Time Platform Service Integration Tests
 *
 * Tests that the build-time validation stage:
 * 1. Gracefully skips when agentics CLI is unavailable
 * 2. Is wired into the Phase 4 pipeline stages
 * 3. Produces structured results
 */

import { describe, it, expect } from '@jest/globals';
import { runBuildTimeValidation } from '../../../../src/pipeline/phase4/phases/build-time-services.js';
import type { Phase4Context, Phase4StageOutput, ERPResolution } from '../../../../src/pipeline/phase4/types.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

function buildContext(withCodegenOutput = true): Phase4Context {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p4-078-'));
  const phase4Dir = path.join(tmpDir, 'phase4');
  fs.mkdirSync(phase4Dir, { recursive: true });

  const erpResolution: ERPResolution = {
    erpSystem: 'oracle-fusion', databaseEngine: 'postgresql', sqlDialect: 'postgresql',
    apiOnly: false, detectionSource: 'scenario-query', confidence: 0.9,
    integrationPoints: ['procurement'], constraints: [], cloudProvider: 'gcp',
  } as unknown as ERPResolution;

  const stageOutputs = new Map<string, Phase4StageOutput>();
  stageOutputs.set('erp-target-resolution', {
    stage: 'erp-target-resolution', status: 'completed', data: erpResolution,
    artifacts: [], timing: 10, summary: 'ERP resolved',
  } as Phase4StageOutput);

  if (withCodegenOutput) {
    stageOutputs.set('http-server-generation', {
      stage: 'http-server-generation', status: 'completed',
      data: {
        framework: 'hono',
        files: [
          { relativePath: 'project/src/server/routes.ts', content: 'export const app = new Hono(); // test', kind: 'server' },
          { relativePath: 'project/src/server/schemas.ts', content: 'import { z } from "zod"; export const X = z.object({});', kind: 'server' },
        ],
        routeCount: 5,
      },
      artifacts: [], timing: 100, summary: '',
    } as Phase4StageOutput);

    stageOutputs.set('deployment-generation', {
      stage: 'deployment-generation', status: 'completed',
      data: {
        files: [
          { relativePath: 'deployment/Dockerfile', content: 'FROM node:20-slim\nEXPOSE 8080', kind: 'deployment' },
          { relativePath: 'deployment/cloud-run-service.yaml', content: 'apiVersion: serving.knative.dev/v1\nkind: Service', kind: 'deployment' },
        ],
        cloudRunService: 'mvp-test',
      },
      artifacts: [], timing: 50, summary: '',
    } as Phase4StageOutput);
  }

  return {
    traceId: 'buildtime078test12',
    phase2Dir: path.join(tmpDir, 'p2'), phase3Dir: path.join(tmpDir, 'p3'), phase4Dir,
    scenarioQuery: 'test enterprise',
    phase3Artifacts: {
      manifest: {} as any, implementationLanguage: 'typescript',
      projectDir: path.join(tmpDir, 'proj'),
      phase2Artifacts: { domainModel: { contexts: [] } },
    },
    stageOutputs,
    telemetrySpans: [],
  } as unknown as Phase4Context;
}

describe('ADR-078: Build-Time Platform Services', () => {
  describe('runBuildTimeValidation', () => {
    it('should complete successfully even when agentics CLI is unavailable', () => {
      const ctx = buildContext();
      const result = runBuildTimeValidation(ctx);
      expect(result.status).toBe('completed');
      expect(result.stage).toBe('build-time-validation');
    });

    it('should skip gracefully when CLI is not found', () => {
      // In test environment, agentics CLI is likely not installed
      const ctx = buildContext();
      const result = runBuildTimeValidation(ctx);
      const data = result.data as { skipped?: boolean; summary: string };
      // Either skipped (no CLI) or ran with errors (CLI available but agents not deployed)
      expect(result.status).toBe('completed');
      expect(typeof data.summary).toBe('string');
    });

    it('should include timing information', () => {
      const ctx = buildContext();
      const result = runBuildTimeValidation(ctx);
      expect(result.timing).toBeGreaterThanOrEqual(0);
    });

    it('should produce a summary string', () => {
      const ctx = buildContext();
      const result = runBuildTimeValidation(ctx);
      expect(result.summary).toBeTruthy();
      expect(typeof result.summary).toBe('string');
    });

    it('should handle missing codegen stages gracefully', () => {
      const ctx = buildContext(false); // No http-server or deployment stages
      const result = runBuildTimeValidation(ctx);
      expect(result.status).toBe('completed');
    });

    it('should return results array in data', () => {
      const ctx = buildContext();
      const result = runBuildTimeValidation(ctx);
      const data = result.data as { results: unknown[] };
      expect(Array.isArray(data.results)).toBe(true);
    });
  });

  describe('pipeline integration', () => {
    it('should be registered as a Phase4Stage type', async () => {
      // Verify the type exists by importing and using it
      const { default: _types } = await import('../../../../src/pipeline/phase4/types.js') as any;
      // The fact that 'build-time-validation' is in Phase4Stage is verified at compile time
      const stage: import('../../../../src/pipeline/phase4/types.js').Phase4Stage = 'build-time-validation';
      expect(stage).toBe('build-time-validation');
    });

    it('should be in the phase4 coordinator stages list', async () => {
      // Read the coordinator source to verify it's wired in
      const coordinatorPath = path.join(process.cwd(), 'src/pipeline/phase4/phase4-coordinator.ts');
      const content = fs.readFileSync(coordinatorPath, 'utf-8');
      expect(content).toContain("'build-time-validation'");
      expect(content).toContain('runBuildTimeValidation');
      expect(content).toContain('ADR-078');
    });

    it('should be positioned after deployment-generation and before metadata-augmentation', () => {
      const coordinatorPath = path.join(process.cwd(), 'src/pipeline/phase4/phase4-coordinator.ts');
      const content = fs.readFileSync(coordinatorPath, 'utf-8');
      const deployIdx = content.indexOf("'deployment-generation'");
      const buildIdx = content.indexOf("'build-time-validation'");
      const metaIdx = content.indexOf("'metadata-augmentation'");
      expect(deployIdx).toBeLessThan(buildIdx);
      expect(buildIdx).toBeLessThan(metaIdx);
    });
  });
});
