/**
 * DecisionGraphClient — Unit Tests (ADR-033)
 *
 * Tests the agent-facing typed wrapper including:
 *   - Write protocol (auto-populates producedBy/pass)
 *   - Batch write
 *   - Update protocol (append-only history)
 *   - Read protocol (by ID, type, pass, tag, agent)
 *   - Compound queries with pagination
 *   - Semantic search
 *   - Derivation chain traversal
 *   - Prior pass summaries
 *   - Multi-selector reads
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { DecisionGraph } from '../../../../src/pipeline/enterprise/decision-graph.js';
import {
  DecisionGraphClient,
  createDecisionGraphClient,
} from '../../../../src/pipeline/enterprise/decision-graph-client.js';

describe('DecisionGraphClient (ADR-033)', () => {
  let graph: DecisionGraph;
  let client: DecisionGraphClient;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dgc-test-'));
    graph = new DecisionGraph('client-test-001', tmpDir);
    client = createDecisionGraphClient(
      graph,
      { domain: 'costops', agent: 'roi', role: 'ROI Estimator' },
      4,
    );
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ==========================================================================
  // Write Protocol
  // ==========================================================================

  describe('Write Protocol', () => {
    test('write auto-populates producedBy from client context', () => {
      const node = client.write({
        type: 'cost_model',
        name: 'TCO Model',
        content: { year1: 100000 },
        summary: 'Year 1 TCO projection',
      });

      expect(node.producedBy.domain).toBe('costops');
      expect(node.producedBy.agent).toBe('roi');
      expect(node.producedBy.role).toBe('ROI Estimator');
    });

    test('write auto-populates pass from client context', () => {
      const node = client.write({
        type: 'cost_model',
        name: 'TCO Model',
        content: {},
        summary: '',
      });

      expect(node.pass).toBe(4);
    });

    test('write allows overriding producedBy and pass', () => {
      const node = client.write({
        type: 'scenario',
        name: 'Override Test',
        content: {},
        summary: '',
        producedBy: { domain: 'simulator', agent: 'what-if', role: 'Sim' },
        pass: 2,
      });

      expect(node.producedBy.domain).toBe('simulator');
      expect(node.pass).toBe(2);
    });

    test('write with derivedFrom creates edges', () => {
      const parent = client.write({
        type: 'cost_model',
        name: 'Parent',
        content: {},
        summary: '',
      });
      const child = client.write({
        type: 'cost_model',
        name: 'Child',
        content: {},
        summary: '',
        derivedFrom: [parent.id],
      });

      const edges = graph.getEdgesTo(child.id);
      expect(edges).toHaveLength(1);
      expect(edges[0]!.from).toBe(parent.id);
    });

    test('write with custom tags merges with auto-tags', () => {
      const node = client.write({
        type: 'cost_model',
        name: 'Tagged',
        content: {},
        summary: '',
        tags: ['high-priority', 'reviewed'],
      });

      expect(node.tags).toContain('high-priority');
      expect(node.tags).toContain('reviewed');
      expect(node.tags).toContain('pass:4');
      expect(node.tags).toContain('type:cost_model');
      expect(node.tags).toContain('domain:costops');
    });
  });

  describe('Batch Write', () => {
    test('writeBatch creates multiple nodes', () => {
      const nodes = client.writeBatch([
        { type: 'cost_model', name: 'Model A', content: { cost: 100 }, summary: 'A' },
        { type: 'cost_model', name: 'Model B', content: { cost: 200 }, summary: 'B' },
        { type: 'cost_model', name: 'Model C', content: { cost: 300 }, summary: 'C' },
      ]);

      expect(nodes).toHaveLength(3);
      expect(graph.nodeCount).toBe(3);
      // All should have the client's agent context
      for (const node of nodes) {
        expect(node.producedBy.domain).toBe('costops');
        expect(node.pass).toBe(4);
      }
    });
  });

  // ==========================================================================
  // Update Protocol
  // ==========================================================================

  describe('Update Protocol', () => {
    test('update changes content and preserves history', () => {
      const node = client.write({
        type: 'cost_model', name: 'Cost', content: { tco: 100 }, summary: 'V1',
      });

      const updated = client.update(node.id, { content: { tco: 200 }, summary: 'V2' });
      expect(updated.version).toBe(2);
      expect(updated.content).toEqual({ tco: 200 });

      // History preserved
      const history = client.getHistory(node.id);
      expect(history).toHaveLength(2);
      expect(history[0]!.content).toEqual({ tco: 100 });
      expect(history[1]!.content).toEqual({ tco: 200 });
    });

    test('getAtVersion retrieves historical content', () => {
      const node = client.write({
        type: 'cost_model', name: 'Cost', content: { v: 1 }, summary: 'V1',
      });
      client.update(node.id, { content: { v: 2 } });
      client.update(node.id, { content: { v: 3 } });

      expect(client.getAtVersion(node.id, 1)!.content).toEqual({ v: 1 });
      expect(client.getAtVersion(node.id, 2)!.content).toEqual({ v: 2 });
      expect(client.getAtVersion(node.id, 3)!.content).toEqual({ v: 3 });
    });
  });

  // ==========================================================================
  // Read Protocol
  // ==========================================================================

  describe('Read Protocol', () => {
    test('read returns found:true with node for existing ID', () => {
      const node = client.write({
        type: 'cost_model', name: 'Cost', content: {}, summary: '',
      });
      const result = client.read(node.id);
      expect(result.found).toBe(true);
      expect(result.node!.name).toBe('Cost');
    });

    test('read returns found:false for unknown ID', () => {
      const result = client.read('nonexistent');
      expect(result.found).toBe(false);
      expect(result.node).toBeUndefined();
    });

    test('readByType returns nodes of specified type', () => {
      client.write({ type: 'cost_model', name: 'A', content: {}, summary: '' });
      client.write({ type: 'cost_model', name: 'B', content: {}, summary: '' });
      client.write({ type: 'governance_report', name: 'C', content: {}, summary: '' });

      expect(client.readByType('cost_model')).toHaveLength(2);
      expect(client.readByType('governance_report')).toHaveLength(1);
    });

    test('readByPass returns nodes from specified pass', () => {
      client.write({ type: 'cost_model', name: 'A', content: {}, summary: '' });
      // This one is in pass 4 (client default)

      // Create a client for pass 2
      const pass2Client = createDecisionGraphClient(
        graph,
        { domain: 'simulator', agent: 'what-if', role: 'Sim' },
        2,
      );
      pass2Client.write({ type: 'scenario', name: 'S', content: {}, summary: '' });

      expect(client.readByPass(4)).toHaveLength(1);
      expect(client.readByPass(2)).toHaveLength(1);
    });

    test('readByAgent filters by domain/agent', () => {
      client.write({ type: 'cost_model', name: 'A', content: {}, summary: '' });

      expect(client.readByAgent('costops', 'roi')).toHaveLength(1);
      expect(client.readByAgent('costops', 'other')).toHaveLength(0);
    });

    test('readByTag returns matching nodes', () => {
      client.write({
        type: 'cost_model', name: 'A', content: {}, summary: '',
        tags: ['critical'],
      });
      client.write({
        type: 'cost_model', name: 'B', content: {}, summary: '',
      });

      expect(client.readByTag('critical')).toHaveLength(1);
    });
  });

  // ==========================================================================
  // Prior Pass Reads
  // ==========================================================================

  describe('Prior Pass Reads', () => {
    test('readPriorPasses returns nodes from passes < current', () => {
      // Client is in pass 4
      const pass1Client = createDecisionGraphClient(
        graph, { domain: 'copilot', agent: 'planner', role: 'P' }, 1,
      );
      const pass2Client = createDecisionGraphClient(
        graph, { domain: 'sim', agent: 'what-if', role: 'S' }, 2,
      );
      const pass5Client = createDecisionGraphClient(
        graph, { domain: 'platform', agent: 'decision', role: 'D' }, 5,
      );

      pass1Client.write({ type: 'problem_definition', name: 'P1', content: {}, summary: '' });
      pass2Client.write({ type: 'scenario', name: 'S1', content: {}, summary: '' });
      client.write({ type: 'cost_model', name: 'C1', content: {}, summary: '' });
      pass5Client.write({ type: 'executive_memo', name: 'E1', content: {}, summary: '' });

      const prior = client.readPriorPasses();
      expect(prior).toHaveLength(2); // Pass 1 and 2 only (not 4 or 5)
    });

    test('getPriorPassSummaries returns compact summaries', () => {
      const pass1Client = createDecisionGraphClient(
        graph, { domain: 'copilot', agent: 'planner', role: 'P' }, 1,
      );
      pass1Client.write({
        type: 'problem_definition', name: 'Problem', content: {},
        summary: 'The main problem', confidence: 0.95,
      });

      const summaries = client.getPriorPassSummaries();
      expect(summaries).toHaveLength(1);
      expect(summaries[0]!.type).toBe('problem_definition');
      expect(summaries[0]!.summary).toBe('The main problem');
      expect(summaries[0]!.confidence).toBe(0.95);
    });
  });

  // ==========================================================================
  // Compound Queries
  // ==========================================================================

  describe('Compound Queries', () => {
    beforeEach(() => {
      client.write({ type: 'cost_model', name: 'A', content: {}, summary: '', confidence: 0.9 });
      client.write({ type: 'cost_model', name: 'B', content: {}, summary: '', confidence: 0.5, status: 'degraded' });
      client.write({ type: 'governance_report', name: 'C', content: {}, summary: '', confidence: 0.8 });
    });

    test('query with type filter', () => {
      const result = client.query({ type: 'cost_model' });
      expect(result.total).toBe(2);
    });

    test('query with minConfidence', () => {
      const result = client.query({ minConfidence: 0.8 });
      expect(result.total).toBe(2);
    });

    test('query with pagination', () => {
      const result = client.query({}, { offset: 0, limit: 2 });
      expect(result.nodes).toHaveLength(2);
      expect(result.total).toBe(3);
      expect(result.hasMore).toBe(true);
    });
  });

  // ==========================================================================
  // Semantic Search
  // ==========================================================================

  describe('Semantic Search', () => {
    test('search finds matching nodes', () => {
      client.write({
        type: 'cost_model', name: 'Cloud Cost',
        content: {}, summary: 'Annual cloud infrastructure cost projection',
      });
      client.write({
        type: 'governance_report', name: 'Compliance',
        content: {}, summary: 'GDPR compliance assessment for data handling',
      });

      const results = client.search('cloud infrastructure costs');
      expect(results.length).toBeGreaterThan(0);
      expect(results[0]!.name).toBe('Cloud Cost');
    });
  });

  // ==========================================================================
  // Multi-Selector Reads
  // ==========================================================================

  describe('readMultiple', () => {
    test('reads nodes of multiple types', () => {
      const pass2Client = createDecisionGraphClient(
        graph, { domain: 'sim', agent: 'what-if', role: 'S' }, 2,
      );
      pass2Client.write({ type: 'scenario', name: 'S1', content: {}, summary: '' });
      pass2Client.write({ type: 'risk_signal', name: 'R1', content: {}, summary: '' });
      client.write({ type: 'cost_model', name: 'C1', content: {}, summary: '' });

      const results = client.readMultiple(
        { type: 'scenario', pass: 2 },
        { type: 'cost_model', pass: 4 },
      );
      expect(results).toHaveLength(2);
    });

    test('filters by pass within selector', () => {
      const pass2Client = createDecisionGraphClient(
        graph, { domain: 'sim', agent: 'what-if', role: 'S' }, 2,
      );
      pass2Client.write({ type: 'scenario', name: 'S1', content: {}, summary: '' });

      const results = client.readMultiple(
        { type: 'scenario', pass: 3 }, // Wrong pass — should not match
      );
      expect(results).toHaveLength(0);
    });
  });

  // ==========================================================================
  // Edge Operations
  // ==========================================================================

  describe('Edge Operations', () => {
    test('addEdge creates relationship', () => {
      const a = client.write({ type: 'cost_model', name: 'A', content: {}, summary: '' });
      const b = client.write({ type: 'governance_report', name: 'B', content: {}, summary: '' });

      client.addEdge(a.id, b.id, 'informs');

      const from = client.getEdgesFrom(a.id);
      expect(from).toHaveLength(1);
      expect(from[0]!.relation).toBe('informs');

      const to = client.getEdgesTo(b.id);
      expect(to).toHaveLength(1);
    });
  });

  // ==========================================================================
  // Graph Information
  // ==========================================================================

  describe('Graph Information', () => {
    test('getStatistics returns aggregate stats', () => {
      client.write({ type: 'cost_model', name: 'A', content: {}, summary: '' });
      client.write({ type: 'cost_model', name: 'B', content: {}, summary: '' });

      const stats = client.getStatistics();
      expect(stats.nodeCount).toBe(2);
    });

    test('getLifecycle returns current state', () => {
      expect(client.getLifecycle()).toBe('created');
      client.write({ type: 'cost_model', name: 'A', content: {}, summary: '' });
      client.write({ type: 'cost_model', name: 'B', content: {}, summary: '' });
      expect(client.getLifecycle()).toBe('accumulated');
    });

    test('getNodeCount matches graph', () => {
      client.write({ type: 'cost_model', name: 'A', content: {}, summary: '' });
      expect(client.getNodeCount()).toBe(1);
    });

    test('getExecutionId returns correct ID', () => {
      expect(client.getExecutionId()).toBe('client-test-001');
    });
  });

  // ==========================================================================
  // Factory
  // ==========================================================================

  describe('createDecisionGraphClient', () => {
    test('creates a client bound to agent and pass', () => {
      const c = createDecisionGraphClient(
        graph,
        { domain: 'shield', agent: 'pii', role: 'PII Detector' },
        4,
      );
      const node = c.write({
        type: 'security_analysis', name: 'PII Scan', content: {}, summary: '',
      });

      expect(node.producedBy.domain).toBe('shield');
      expect(node.producedBy.agent).toBe('pii');
      expect(node.pass).toBe(4);
    });
  });
});
