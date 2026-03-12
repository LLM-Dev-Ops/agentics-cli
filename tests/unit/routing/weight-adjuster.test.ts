/**
 * Tests for the Weight Adjuster (ADR-031 Phase 2)
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  calculateAdjustedWeights,
  writeWeightOverlay,
  loadWeightOverlay,
  applyWeightOverlay,
  formatAdjustmentReport,
} from '../../../src/routing/weight-adjuster.js';
import type { WeightAdjustment, WeightOverlay } from '../../../src/routing/weight-adjuster.js';
import type { OutcomeRecord } from '../../../src/routing/outcome-recorder.js';
import type { WeightedAgent } from '../../../src/routing/weighted-resolver.js';

// ============================================================================
// Helpers
// ============================================================================

function createTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'weight-test-'));
  fs.mkdirSync(path.join(dir, 'docs'), { recursive: true });
  return dir;
}

function cleanupTempDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // Best effort
  }
}

function makeOutcome(overrides: Partial<OutcomeRecord> = {}): OutcomeRecord {
  return {
    timestamp: new Date().toISOString(),
    prompt_hash: 'sha256:abc',
    capabilities_used: ['test_cap'],
    agents_selected: ['Agent A'],
    outcome: 'success',
    user_rating: null,
    execution_time_ms: 1000,
    agent_contributions: {
      'Agent A': { produced_output: true, output_used: true },
    },
    ...overrides,
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('Weight Adjuster', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = createTempDir();
  });

  afterEach(() => {
    cleanupTempDir(tmpDir);
  });

  describe('calculateAdjustedWeights', () => {
    const agents: WeightedAgent[] = [
      { name: 'Agent A', weight: 0.8, role: 'primary' },
      { name: 'Agent B', weight: 0.5, role: 'secondary' },
    ];

    it('returns empty when insufficient samples', () => {
      const outcomes = Array.from({ length: 10 }, () => makeOutcome());
      const result = calculateAdjustedWeights('test_cap', agents, outcomes);
      expect(result).toHaveLength(0); // Need 20 minimum
    });

    it('calculates adjustments with sufficient data', () => {
      const outcomes = Array.from({ length: 25 }, () =>
        makeOutcome({
          capabilities_used: ['test_cap'],
          agents_selected: ['Agent A', 'Agent B'],
          outcome: 'success',
          agent_contributions: {
            'Agent A': { produced_output: true, output_used: true },
            'Agent B': { produced_output: true, output_used: false },
          },
        }),
      );

      const result = calculateAdjustedWeights('test_cap', agents, outcomes);
      expect(result.length).toBeGreaterThan(0);

      const agentA = result.find(r => r.agent === 'Agent A');
      const agentB = result.find(r => r.agent === 'Agent B');

      expect(agentA).toBeDefined();
      expect(agentB).toBeDefined();
      // Agent A has higher usage rate so should get relatively higher weight
      expect(agentA!.success_rate).toBe(1);
      expect(agentA!.usage_rate).toBe(1);
      expect(agentB!.usage_rate).toBe(0);
    });

    it('clamps weights to [0.05, 1.0]', () => {
      const outcomes = Array.from({ length: 25 }, () =>
        makeOutcome({
          capabilities_used: ['test_cap'],
          agents_selected: ['Agent B'],
          outcome: 'failure',
          agent_contributions: {
            'Agent B': { produced_output: false, output_used: false },
          },
        }),
      );

      const result = calculateAdjustedWeights('test_cap', agents, outcomes);
      const agentB = result.find(r => r.agent === 'Agent B');
      if (agentB) {
        expect(agentB.adjusted_weight).toBeGreaterThanOrEqual(0.05);
        expect(agentB.adjusted_weight).toBeLessThanOrEqual(1.0);
      }
    });

    it('filters outcomes by capability', () => {
      const outcomes = Array.from({ length: 25 }, () =>
        makeOutcome({ capabilities_used: ['other_cap'] }),
      );

      const result = calculateAdjustedWeights('test_cap', agents, outcomes);
      expect(result).toHaveLength(0); // None match test_cap
    });
  });

  describe('writeWeightOverlay / loadWeightOverlay', () => {
    it('writes and reads overlay file', () => {
      const adjustments: WeightAdjustment[] = [
        {
          capability: 'test_cap',
          agent: 'Agent A',
          original_weight: 0.8,
          adjusted_weight: 0.85,
          success_rate: 0.9,
          usage_rate: 0.8,
          sample_count: 30,
        },
      ];

      const filePath = writeWeightOverlay(adjustments, 100, { basePath: tmpDir });
      expect(fs.existsSync(filePath)).toBe(true);

      const overlay = loadWeightOverlay({ basePath: tmpDir });
      expect(overlay).not.toBeNull();
      expect(overlay!.total_outcomes).toBe(100);
      expect(overlay!.adjustments).toHaveLength(1);
      expect(overlay!.adjustments[0]!.adjusted_weight).toBe(0.85);
    });

    it('returns null when overlay does not exist', () => {
      const overlay = loadWeightOverlay({ basePath: tmpDir });
      expect(overlay).toBeNull();
    });
  });

  describe('applyWeightOverlay', () => {
    it('updates agent weights from overlay', () => {
      const agents: WeightedAgent[] = [
        { name: 'Agent A', weight: 0.8, role: 'primary' },
        { name: 'Agent B', weight: 0.5, role: 'secondary' },
      ];

      const overlay: WeightOverlay = {
        generated_at: new Date().toISOString(),
        total_outcomes: 50,
        adjustments: [
          {
            capability: 'test_cap',
            agent: 'Agent A',
            original_weight: 0.8,
            adjusted_weight: 0.9,
            success_rate: 0.95,
            usage_rate: 0.9,
            sample_count: 40,
          },
        ],
      };

      const result = applyWeightOverlay('test_cap', agents, overlay);
      expect(result[0]!.weight).toBe(0.9);
      expect(result[1]!.weight).toBe(0.5); // Unchanged
    });

    it('returns original agents when no adjustments match', () => {
      const agents: WeightedAgent[] = [
        { name: 'Agent A', weight: 0.8, role: 'primary' },
      ];

      const overlay: WeightOverlay = {
        generated_at: new Date().toISOString(),
        total_outcomes: 50,
        adjustments: [],
      };

      const result = applyWeightOverlay('test_cap', agents, overlay);
      expect(result[0]!.weight).toBe(0.8);
    });
  });

  describe('formatAdjustmentReport', () => {
    it('formats adjustments as readable report', () => {
      const adjustments: WeightAdjustment[] = [
        {
          capability: 'test_cap',
          agent: 'Agent A',
          original_weight: 0.8,
          adjusted_weight: 0.85,
          success_rate: 0.9,
          usage_rate: 0.8,
          sample_count: 30,
        },
      ];

      const report = formatAdjustmentReport(adjustments);
      expect(report).toContain('Weight Adjustment Report');
      expect(report).toContain('Agent A');
      expect(report).toContain('test_cap');
    });

    it('handles empty adjustments', () => {
      const report = formatAdjustmentReport([]);
      expect(report).toContain('No weight adjustments');
    });
  });
});
