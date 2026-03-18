/**
 * Enterprise Pipeline Orchestrator — Unit Tests
 *
 * Tests the pipeline orchestrator's structural behavior.
 * Agent invocations will fail (no real services), but the orchestrator
 * should handle failures gracefully and still produce outputs.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import { executeEnterprisePipeline } from '../../../../src/pipeline/enterprise/pipeline-orchestrator.js';
import type { EnterprisePipelineOptions } from '../../../../src/pipeline/enterprise/types.js';

describe('Enterprise Pipeline Orchestrator', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function createOptions(overrides: Partial<EnterprisePipelineOptions> = {}): EnterprisePipelineOptions {
    return {
      mode: 'autonomous',
      prompt: 'Test enterprise decision',
      traceId: 'test-exec-001',
      outputDir: tmpDir,
      verbose: false,
      passTimeoutMs: 10_000,
      ...overrides,
    };
  }

  describe('Single pass execution', () => {
    test('executes one pass and returns valid result', async () => {
      const result = await executeEnterprisePipeline(createOptions({
        singlePass: 1,
      }));

      expect(result.executionId).toBe('test-exec-001');
      expect(result.prompt).toBe('Test enterprise decision');
      expect(result.mode).toBe('autonomous');
      expect(result.passOutputs).toHaveLength(1);
      expect(result.passOutputs[0]!.passNumber).toBe(1);
      expect(typeof result.totalDurationMs).toBe('number');
      expect(result.timestamp).toBeTruthy();
    }, 30_000);

    test('creates output directory', async () => {
      const result = await executeEnterprisePipeline(createOptions({
        singlePass: 1,
      }));

      expect(fs.existsSync(result.outputDir)).toBe(true);
    }, 30_000);

    test('writes DECISION_PACKAGE.md', async () => {
      const result = await executeEnterprisePipeline(createOptions({
        singlePass: 1,
      }));

      const packagePath = path.join(result.outputDir, 'DECISION_PACKAGE.md');
      expect(fs.existsSync(packagePath)).toBe(true);
    }, 30_000);

    test('writes decision graph', async () => {
      await executeEnterprisePipeline(createOptions({
        singlePass: 1,
      }));

      const graphPath = path.join(tmpDir, 'decision-graph', 'decision-graph.json');
      expect(fs.existsSync(graphPath)).toBe(true);
    }, 30_000);

    test('writes provenance traces', async () => {
      const result = await executeEnterprisePipeline(createOptions({
        singlePass: 1,
      }));

      const tracePath = path.join(result.outputDir, 'provenance', 'trace-records.json');
      expect(fs.existsSync(tracePath)).toBe(true);

      const traces = JSON.parse(fs.readFileSync(tracePath, 'utf-8'));
      expect(Array.isArray(traces)).toBe(true);
      expect(traces.length).toBeGreaterThan(0);
    }, 30_000);
  });

  describe('Partial pipeline execution', () => {
    test('runs only specified passes', async () => {
      const result = await executeEnterprisePipeline(createOptions({
        passes: [1, 2],
      }));

      expect(result.passOutputs).toHaveLength(2);
      expect(result.passOutputs[0]!.passNumber).toBe(1);
      expect(result.passOutputs[1]!.passNumber).toBe(2);
    }, 60_000);
  });

  describe('Result structure', () => {
    test('passOutputs have expected fields', async () => {
      const result = await executeEnterprisePipeline(createOptions({
        singlePass: 1,
      }));

      const output = result.passOutputs[0]!;
      expect(output.pass).toBe('problem-intelligence');
      expect(output.passNumber).toBe(1);
      expect(['completed', 'degraded', 'failed']).toContain(output.status);
      expect(typeof output.durationMs).toBe('number');
      expect(output.summary).toBeTruthy();
      expect(Array.isArray(output.agentResults)).toBe(true);
      expect(output.agentResults.length).toBeGreaterThan(0);
    }, 30_000);

    test('agent results have domain and agent info', async () => {
      const result = await executeEnterprisePipeline(createOptions({
        singlePass: 1,
      }));

      const agentResults = result.passOutputs[0]!.agentResults;
      for (const ar of agentResults) {
        expect(ar.agent.domain).toBeTruthy();
        expect(ar.agent.agent).toBeTruthy();
        expect(ar.agent.role).toBeTruthy();
        expect(typeof ar.status).toBe('number');
        expect(typeof ar.durationMs).toBe('number');
      }
    }, 30_000);

    test('finalStatus reflects pass outcomes', async () => {
      const result = await executeEnterprisePipeline(createOptions({
        singlePass: 1,
      }));

      // Without real services, agents will fail, resulting in degraded or failed
      expect(['completed', 'completed-degraded', 'failed']).toContain(result.finalStatus);
    }, 30_000);
  });

  describe('Decision Package output', () => {
    test('DECISION_PACKAGE.md contains execution metadata', async () => {
      const result = await executeEnterprisePipeline(createOptions({
        singlePass: 1,
      }));

      const content = fs.readFileSync(
        path.join(result.outputDir, 'DECISION_PACKAGE.md'),
        'utf-8',
      );

      expect(content).toContain('Agentics Decision Package');
      expect(content).toContain('test-exec-001');
      expect(content).toContain('Test enterprise decision');
    }, 30_000);

    test('writes all 15 artifact files', async () => {
      const result = await executeEnterprisePipeline(createOptions({
        singlePass: 1,
      }));

      const files = fs.readdirSync(result.outputDir).filter(f => f.endsWith('.md'));
      // 15 artifact files + DECISION_PACKAGE.md = 16
      expect(files.length).toBe(16);
    }, 30_000);
  });

  describe('Error resilience', () => {
    test('handles agent failures gracefully (no uncaught exceptions)', async () => {
      // This test verifies the pipeline doesn't throw even when all agents fail
      const result = await executeEnterprisePipeline(createOptions({
        passes: [1, 2],
      }));

      // Pipeline should still return a result
      expect(result).toBeDefined();
      expect(result.passOutputs.length).toBe(2);
    }, 60_000);

    test('generates execution ID when none provided', async () => {
      const result = await executeEnterprisePipeline(createOptions({
        traceId: '',
        singlePass: 1,
      }));

      expect(result.executionId).toBeTruthy();
    }, 30_000);
  });
});
