/**
 * Tests for the Outcome Recorder (ADR-031 Phase 2)
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  recordOutcome,
  buildOutcomeRecord,
  loadOutcomes,
  loadRecentOutcomes,
  rotateOutcomes,
  getOutcomesFilePath,
} from '../../../src/routing/outcome-recorder.js';

// ============================================================================
// Helpers
// ============================================================================

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'outcome-test-'));
}

function cleanupTempDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // Best effort
  }
}

// ============================================================================
// Tests
// ============================================================================

describe('Outcome Recorder', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = createTempDir();
  });

  afterEach(() => {
    cleanupTempDir(tmpDir);
  });

  describe('buildOutcomeRecord', () => {
    it('creates a valid outcome record', () => {
      const record = buildOutcomeRecord({
        prompt: 'Check for injection attacks',
        capabilities: ['security_validation'],
        agents: ['Prompt Injection Detection Agent'],
        outcome: 'success',
        executionTimeMs: 1234,
      });

      expect(record.timestamp).toBeTruthy();
      expect(record.prompt_hash).toMatch(/^sha256:/);
      expect(record.capabilities_used).toContain('security_validation');
      expect(record.agents_selected).toContain('Prompt Injection Detection Agent');
      expect(record.outcome).toBe('success');
      expect(record.execution_time_ms).toBe(1234);
      expect(record.user_rating).toBeNull();
    });

    it('includes user rating when provided', () => {
      const record = buildOutcomeRecord({
        prompt: 'Test',
        capabilities: ['test'],
        agents: ['Agent A'],
        outcome: 'success',
        executionTimeMs: 100,
        userRating: 4,
      });

      expect(record.user_rating).toBe(4);
    });

    it('builds default contributions', () => {
      const record = buildOutcomeRecord({
        prompt: 'Test',
        capabilities: ['test'],
        agents: ['Agent A', 'Agent B'],
        outcome: 'success',
        executionTimeMs: 100,
      });

      expect(record.agent_contributions['Agent A']).toEqual({
        produced_output: true,
        output_used: true,
      });
    });

    it('marks contributions as not used on failure', () => {
      const record = buildOutcomeRecord({
        prompt: 'Test',
        capabilities: ['test'],
        agents: ['Agent A'],
        outcome: 'failure',
        executionTimeMs: 100,
      });

      expect(record.agent_contributions['Agent A']!.produced_output).toBe(false);
      expect(record.agent_contributions['Agent A']!.output_used).toBe(false);
    });
  });

  describe('recordOutcome / loadOutcomes', () => {
    it('records and loads outcomes', () => {
      const record = buildOutcomeRecord({
        prompt: 'Test prompt',
        capabilities: ['cap_a'],
        agents: ['Agent 1'],
        outcome: 'success',
        executionTimeMs: 500,
      });

      recordOutcome(record, { basePath: tmpDir });

      const loaded = loadOutcomes({ basePath: tmpDir });
      expect(loaded).toHaveLength(1);
      expect(loaded[0]!.capabilities_used).toContain('cap_a');
    });

    it('appends multiple records', () => {
      for (let i = 0; i < 3; i++) {
        const record = buildOutcomeRecord({
          prompt: `Prompt ${i}`,
          capabilities: ['cap'],
          agents: ['Agent'],
          outcome: 'success',
          executionTimeMs: 100 * i,
        });
        recordOutcome(record, { basePath: tmpDir });
      }

      const loaded = loadOutcomes({ basePath: tmpDir });
      expect(loaded).toHaveLength(3);
    });

    it('creates telemetry directory if missing', () => {
      const record = buildOutcomeRecord({
        prompt: 'Test',
        capabilities: ['cap'],
        agents: ['Agent'],
        outcome: 'success',
        executionTimeMs: 100,
      });

      const newDir = path.join(tmpDir, 'nested', 'subdir');
      recordOutcome(record, { basePath: newDir });

      const filePath = getOutcomesFilePath(newDir);
      expect(fs.existsSync(filePath)).toBe(true);
    });

    it('returns empty array when file does not exist', () => {
      const loaded = loadOutcomes({ basePath: tmpDir });
      expect(loaded).toHaveLength(0);
    });
  });

  describe('loadRecentOutcomes', () => {
    it('returns only the most recent N records', () => {
      for (let i = 0; i < 5; i++) {
        const record = buildOutcomeRecord({
          prompt: `Prompt ${i}`,
          capabilities: [`cap_${i}`],
          agents: ['Agent'],
          outcome: 'success',
          executionTimeMs: 100,
        });
        recordOutcome(record, { basePath: tmpDir });
      }

      const recent = loadRecentOutcomes(2, { basePath: tmpDir });
      expect(recent).toHaveLength(2);
      expect(recent[0]!.capabilities_used[0]).toBe('cap_3');
      expect(recent[1]!.capabilities_used[0]).toBe('cap_4');
    });
  });

  describe('rotateOutcomes', () => {
    it('keeps only maxRecords', () => {
      for (let i = 0; i < 10; i++) {
        const record = buildOutcomeRecord({
          prompt: `P${i}`,
          capabilities: [`c${i}`],
          agents: ['A'],
          outcome: 'success',
          executionTimeMs: 100,
        });
        recordOutcome(record, { basePath: tmpDir });
      }

      const result = rotateOutcomes(5, { basePath: tmpDir });
      expect(result.kept).toBe(5);
      expect(result.removed).toBe(5);

      const remaining = loadOutcomes({ basePath: tmpDir });
      expect(remaining).toHaveLength(5);
    });

    it('no-ops when under limit', () => {
      const record = buildOutcomeRecord({
        prompt: 'Test',
        capabilities: ['cap'],
        agents: ['A'],
        outcome: 'success',
        executionTimeMs: 100,
      });
      recordOutcome(record, { basePath: tmpDir });

      const result = rotateOutcomes(100, { basePath: tmpDir });
      expect(result.kept).toBe(1);
      expect(result.removed).toBe(0);
    });

    it('handles missing file', () => {
      const result = rotateOutcomes(100, { basePath: tmpDir });
      expect(result.kept).toBe(0);
      expect(result.removed).toBe(0);
    });
  });
});
