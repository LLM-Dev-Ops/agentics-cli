/**
 * DecisionGraph Memory Backend — Unit Tests (ADR-033)
 *
 * Tests the AgentDB integration layer including:
 *   - Memory key format
 *   - Memory tags generation
 *   - CLI query bridge (buildMemoryQuery)
 *
 * Note: pushToMemory/pullFromMemory/searchMemory require the claude-flow
 * CLI to be installed, so they are tested as integration tests. The unit
 * tests focus on the pure functions that don't require external tools.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  memoryKey,
  memoryTags,
  buildMemoryQuery,
} from '../../../../src/pipeline/enterprise/decision-graph-memory.js';
import { DecisionGraph } from '../../../../src/pipeline/enterprise/decision-graph.js';
import type { DecisionGraphNode } from '../../../../src/pipeline/enterprise/types.js';

describe('DecisionGraph Memory Backend (ADR-033)', () => {

  // ==========================================================================
  // Memory Key Format
  // ==========================================================================

  describe('memoryKey', () => {
    test('generates correct format: decisiongraph:{executionId}:{nodeId}', () => {
      const key = memoryKey('exec-001', 'node-abc');
      expect(key).toBe('decisiongraph:exec-001:node-abc');
    });

    test('handles UUID-style IDs', () => {
      const key = memoryKey('a1b2c3d4-e5f6-7890-abcd-ef1234567890', '12345678-1234-1234-1234-123456789abc');
      expect(key).toBe('decisiongraph:a1b2c3d4-e5f6-7890-abcd-ef1234567890:12345678-1234-1234-1234-123456789abc');
    });

    test('handles empty strings gracefully', () => {
      const key = memoryKey('', '');
      expect(key).toBe('decisiongraph::');
    });
  });

  // ==========================================================================
  // Memory Tags
  // ==========================================================================

  describe('memoryTags', () => {
    const sampleNode: DecisionGraphNode = {
      id: 'test-node-001',
      type: 'cost_model',
      name: 'TCO Model',
      content: { year1: 100000 },
      summary: 'Year 1 TCO projection',
      producedBy: { domain: 'costops', agent: 'attribution', role: 'Cost Attribution' },
      pass: 4,
      derivedFrom: [],
      timestamp: '2026-03-17T10:00:00Z',
      confidence: 0.92,
      status: 'complete',
      tags: ['custom'],
      version: 1,
    };

    test('generates all required tags', () => {
      const tags = memoryTags(sampleNode, 'exec-001');
      expect(tags).toContain('type:cost_model');
      expect(tags).toContain('pass:4');
      expect(tags).toContain('domain:costops');
      expect(tags).toContain('agent:attribution');
      expect(tags).toContain('execution:exec-001');
      expect(tags).toContain('status:complete');
    });

    test('includes status tag', () => {
      const degradedNode = { ...sampleNode, status: 'degraded' as const };
      const tags = memoryTags(degradedNode, 'exec-001');
      expect(tags).toContain('status:degraded');
    });

    test('returns 6 tags', () => {
      const tags = memoryTags(sampleNode, 'exec-001');
      expect(tags).toHaveLength(6);
    });
  });

  // ==========================================================================
  // CLI Query Bridge
  // ==========================================================================

  describe('buildMemoryQuery', () => {

    describe('list action', () => {
      test('basic list command', () => {
        const cmd = buildMemoryQuery({ action: 'list' });
        expect(cmd).toBe('npx @claude-flow/cli@latest memory list --namespace decisiongraph');
      });

      test('list with execution ID filter', () => {
        const cmd = buildMemoryQuery({ action: 'list', executionId: 'exec-001' });
        expect(cmd).toContain('--tags "execution:exec-001"');
      });

      test('list with type filter', () => {
        const cmd = buildMemoryQuery({ action: 'list', type: 'cost_model' });
        expect(cmd).toContain('--tags "type:cost_model"');
      });

      test('list with pass filter', () => {
        const cmd = buildMemoryQuery({ action: 'list', pass: 4 });
        expect(cmd).toContain('--tags "pass:4"');
      });

      test('list with multiple filters', () => {
        const cmd = buildMemoryQuery({
          action: 'list',
          executionId: 'exec-001',
          type: 'scenario',
          pass: 2,
        });
        expect(cmd).toContain('execution:exec-001');
        expect(cmd).toContain('type:scenario');
        expect(cmd).toContain('pass:2');
      });

      test('list with limit', () => {
        const cmd = buildMemoryQuery({ action: 'list', limit: 50 });
        expect(cmd).toContain('--limit 50');
      });
    });

    describe('search action', () => {
      test('basic search command', () => {
        const cmd = buildMemoryQuery({ action: 'search', query: 'cost model' });
        expect(cmd).toContain('memory search');
        expect(cmd).toContain('--query "cost model"');
        expect(cmd).toContain('--namespace decisiongraph');
      });

      test('search with execution scope', () => {
        const cmd = buildMemoryQuery({
          action: 'search',
          query: 'authentication',
          executionId: 'exec-001',
        });
        expect(cmd).toContain('--query "authentication"');
        expect(cmd).toContain('--tags "execution:exec-001"');
      });

      test('search with type filter', () => {
        const cmd = buildMemoryQuery({
          action: 'search',
          query: 'security',
          type: 'security_analysis',
        });
        expect(cmd).toContain('--tags "type:security_analysis"');
      });

      test('search with limit', () => {
        const cmd = buildMemoryQuery({
          action: 'search',
          query: 'test',
          limit: 5,
        });
        expect(cmd).toContain('--limit 5');
      });

      test('search throws without query', () => {
        expect(() => buildMemoryQuery({ action: 'search' })).toThrow('Query parameter is required');
      });
    });

    describe('retrieve action', () => {
      test('basic retrieve command', () => {
        const cmd = buildMemoryQuery({
          action: 'retrieve',
          executionId: 'exec-001',
          nodeId: 'node-abc',
        });
        expect(cmd).toContain('memory retrieve');
        expect(cmd).toContain('--key "decisiongraph:exec-001:node-abc"');
        expect(cmd).toContain('--namespace decisiongraph');
      });

      test('retrieve throws without executionId', () => {
        expect(() => buildMemoryQuery({
          action: 'retrieve',
          nodeId: 'node-abc',
        })).toThrow('Both executionId and nodeId are required');
      });

      test('retrieve throws without nodeId', () => {
        expect(() => buildMemoryQuery({
          action: 'retrieve',
          executionId: 'exec-001',
        })).toThrow('Both executionId and nodeId are required');
      });
    });
  });

  // ==========================================================================
  // Integration with DecisionGraph.memoryKey
  // ==========================================================================

  describe('Integration with DecisionGraph', () => {
    test('graph.memoryKey matches standalone memoryKey function', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dgm-test-'));
      const graph = new DecisionGraph('exec-001', tmpDir);

      const graphKey = graph.memoryKey('node-123');
      const standaloneKey = memoryKey('exec-001', 'node-123');
      expect(graphKey).toBe(standaloneKey);

      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    test('memoryTags match graph auto-tags', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dgm-test-'));
      const graph = new DecisionGraph('exec-001', tmpDir);

      const node = graph.createNode({
        type: 'cost_model',
        name: 'Cost',
        content: {},
        summary: '',
        producedBy: { domain: 'costops', agent: 'roi', role: 'ROI' },
        pass: 4,
      });

      const memTags = memoryTags(node, 'exec-001');
      // All memory tags should be present in node's auto-generated tags
      for (const tag of memTags) {
        expect(node.tags).toContain(tag);
      }

      fs.rmSync(tmpDir, { recursive: true, force: true });
    });
  });
});
