/**
 * DecisionGraph — Full ADR-033 Unit Tests
 *
 * Tests the enhanced DecisionGraph including:
 *   - Node CRUD with validation
 *   - Append-only version history
 *   - Automatic edge creation from derivedFrom
 *   - Graph lifecycle states
 *   - Compound querying with pagination
 *   - Semantic search
 *   - Statistics
 *   - Serialization round-trip (with history + lifecycle)
 *   - Runtime node type enum
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  DecisionGraph,
  DECISION_NODE_TYPES,
  VALID_NODE_TYPES,
  EDGE_RELATIONS,
  VALID_EDGE_RELATIONS,
} from '../../../../src/pipeline/enterprise/decision-graph.js';
// GraphLifecycle type used implicitly in lifecycle tests

describe('DecisionGraph (ADR-033)', () => {
  let graph: DecisionGraph;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dg-test-'));
    graph = new DecisionGraph('test-exec-001', tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ==========================================================================
  // Runtime Enums
  // ==========================================================================

  describe('Runtime Node Type Enum', () => {
    test('DECISION_NODE_TYPES contains all 37 types', () => {
      expect(Object.keys(DECISION_NODE_TYPES).length).toBe(37);
    });

    test('VALID_NODE_TYPES is a Set of all values', () => {
      expect(VALID_NODE_TYPES.size).toBe(37);
      expect(VALID_NODE_TYPES.has('problem_definition')).toBe(true);
      expect(VALID_NODE_TYPES.has('provenance_manifest')).toBe(true);
      expect(VALID_NODE_TYPES.has('invalid_type')).toBe(false);
    });

    test('DECISION_NODE_TYPES values match the TypeScript type', () => {
      expect(DECISION_NODE_TYPES.PROBLEM_DEFINITION).toBe('problem_definition');
      expect(DECISION_NODE_TYPES.SCENARIO).toBe('scenario');
      expect(DECISION_NODE_TYPES.COST_MODEL).toBe('cost_model');
      expect(DECISION_NODE_TYPES.CONFIDENCE_SCORE).toBe('confidence_score');
      expect(DECISION_NODE_TYPES.PROVENANCE_MANIFEST).toBe('provenance_manifest');
    });
  });

  describe('Runtime Edge Relation Enum', () => {
    test('EDGE_RELATIONS contains all 5 relations', () => {
      expect(Object.keys(EDGE_RELATIONS).length).toBe(5);
    });

    test('VALID_EDGE_RELATIONS validates correctly', () => {
      expect(VALID_EDGE_RELATIONS.has('derived_from')).toBe(true);
      expect(VALID_EDGE_RELATIONS.has('informs')).toBe(true);
      expect(VALID_EDGE_RELATIONS.has('validates')).toBe(true);
      expect(VALID_EDGE_RELATIONS.has('supersedes')).toBe(true);
      expect(VALID_EDGE_RELATIONS.has('aggregates')).toBe(true);
      expect(VALID_EDGE_RELATIONS.has('invalid')).toBe(false);
    });
  });

  // ==========================================================================
  // Identity & Lifecycle
  // ==========================================================================

  describe('Identity & Lifecycle', () => {
    test('getExecutionId returns the execution ID', () => {
      expect(graph.getExecutionId()).toBe('test-exec-001');
    });

    test('initial lifecycle is created', () => {
      expect(graph.getLifecycle()).toBe('created');
    });

    test('lifecycle transitions to accumulated after second node', () => {
      graph.createNode({
        type: 'problem_definition', name: 'A', content: {}, summary: '',
        producedBy: { domain: 'test', agent: 'test', role: 'test' }, pass: 1,
      });
      expect(graph.getLifecycle()).toBe('created');

      graph.createNode({
        type: 'business_context', name: 'B', content: {}, summary: '',
        producedBy: { domain: 'test', agent: 'test', role: 'test' }, pass: 1,
      });
      expect(graph.getLifecycle()).toBe('accumulated');
    });

    test('seal prevents further writes', () => {
      graph.createNode({
        type: 'problem_definition', name: 'A', content: {}, summary: '',
        producedBy: { domain: 'test', agent: 'test', role: 'test' }, pass: 1,
      });
      graph.seal();
      expect(graph.getLifecycle()).toBe('sealed');
      expect(graph.isWritable()).toBe(false);

      expect(() => graph.createNode({
        type: 'scenario', name: 'B', content: {}, summary: '',
        producedBy: { domain: 'test', agent: 'test', role: 'test' }, pass: 2,
      })).toThrow('cannot write');
    });

    test('sealed graph cannot be updated', () => {
      const node = graph.createNode({
        type: 'problem_definition', name: 'A', content: {}, summary: '',
        producedBy: { domain: 'test', agent: 'test', role: 'test' }, pass: 1,
      });
      graph.seal();

      expect(() => graph.updateNode(node.id, { summary: 'updated' })).toThrow('cannot write');
    });

    test('markQueryable transitions from sealed', () => {
      graph.seal();
      graph.markQueryable();
      expect(graph.getLifecycle()).toBe('queryable');
    });

    test('markQueryable does nothing if not sealed', () => {
      graph.markQueryable();
      expect(graph.getLifecycle()).toBe('created');
    });
  });

  // ==========================================================================
  // Node Validation
  // ==========================================================================

  describe('Node Validation', () => {
    test('validates valid node with no errors', () => {
      const node = graph.createNode({
        type: 'problem_definition', name: 'Test', content: { x: 1 }, summary: 'test',
        producedBy: { domain: 'copilot', agent: 'planner', role: 'Planner' }, pass: 1,
      });
      const errors = graph.validateNode(node);
      expect(errors).toHaveLength(0);
    });

    test('rejects node with invalid type', () => {
      const fakeNode = {
        id: 'fake', type: 'invalid_type' as never, name: 'Test', content: {}, summary: '',
        producedBy: { domain: 'test', agent: 'test', role: 'test' }, pass: 1 as const,
        derivedFrom: [] as string[], timestamp: new Date().toISOString(),
        confidence: 0.5, status: 'complete' as const, tags: [] as string[], version: 1,
      };
      const errors = graph.validateNode(fakeNode);
      expect(errors.some(e => e.field === 'type')).toBe(true);
    });

    test('rejects node with missing producedBy', () => {
      const fakeNode = {
        id: 'fake', type: 'scenario' as const, name: 'Test', content: {}, summary: '',
        producedBy: { domain: '', agent: '', role: '' }, pass: 2 as const,
        derivedFrom: [] as string[], timestamp: new Date().toISOString(),
        confidence: 0.5, status: 'complete' as const, tags: [] as string[], version: 1,
      };
      const errors = graph.validateNode(fakeNode);
      expect(errors.some(e => e.field === 'producedBy')).toBe(true);
    });

    test('rejects node with confidence out of range', () => {
      const fakeNode = {
        id: 'fake', type: 'scenario' as const, name: 'Test', content: {}, summary: '',
        producedBy: { domain: 'test', agent: 'test', role: 'test' }, pass: 2 as const,
        derivedFrom: [] as string[], timestamp: new Date().toISOString(),
        confidence: 1.5, status: 'complete' as const, tags: [] as string[], version: 1,
      };
      const errors = graph.validateNode(fakeNode);
      expect(errors.some(e => e.field === 'confidence')).toBe(true);
    });

    test('rejects node with invalid pass number', () => {
      const fakeNode = {
        id: 'fake', type: 'scenario' as const, name: 'Test', content: {}, summary: '',
        producedBy: { domain: 'test', agent: 'test', role: 'test' }, pass: 9 as never,
        derivedFrom: [] as string[], timestamp: new Date().toISOString(),
        confidence: 0.5, status: 'complete' as const, tags: [] as string[], version: 1,
      };
      const errors = graph.validateNode(fakeNode);
      expect(errors.some(e => e.field === 'pass')).toBe(true);
    });
  });

  // ==========================================================================
  // Node CRUD
  // ==========================================================================

  describe('Node Operations', () => {
    test('createNode adds a node with generated ID', () => {
      const node = graph.createNode({
        type: 'problem_definition', name: 'Test Problem',
        content: { description: 'A test problem' }, summary: 'Test problem summary',
        producedBy: { domain: 'copilot', agent: 'planner', role: 'Planner' }, pass: 1,
      });

      expect(node.id).toBeTruthy();
      expect(node.type).toBe('problem_definition');
      expect(node.name).toBe('Test Problem');
      expect(node.version).toBe(1);
      expect(node.confidence).toBe(1.0);
      expect(node.status).toBe('complete');
    });

    test('createNode auto-generates tags', () => {
      const node = graph.createNode({
        type: 'scenario', name: 'S1', content: {}, summary: '',
        producedBy: { domain: 'simulator', agent: 'what-if', role: 'Sim' }, pass: 2,
        tags: ['custom-tag'],
      });

      expect(node.tags).toContain('pass:2');
      expect(node.tags).toContain('type:scenario');
      expect(node.tags).toContain('domain:simulator');
      expect(node.tags).toContain('agent:what-if');
      expect(node.tags).toContain('execution:test-exec-001');
      expect(node.tags).toContain('custom-tag');
    });

    test('getNode retrieves by ID', () => {
      const created = graph.createNode({
        type: 'scenario', name: 'Scenario A', content: {}, summary: 'Scenario A summary',
        producedBy: { domain: 'simulator', agent: 'what-if', role: 'Simulator' }, pass: 2,
      });
      const retrieved = graph.getNode(created.id);
      expect(retrieved).toBeDefined();
      expect(retrieved!.name).toBe('Scenario A');
    });

    test('getNode returns undefined for unknown ID', () => {
      expect(graph.getNode('nonexistent')).toBeUndefined();
    });

    test('addNode rejects duplicate IDs', () => {
      const node = graph.createNode({
        type: 'problem_definition', name: 'Dup Test', content: {}, summary: '',
        producedBy: { domain: 'test', agent: 'test', role: 'test' }, pass: 1,
      });
      expect(() => graph.addNode(node)).toThrow('duplicate node ID');
    });

    test('updateNode increments version', () => {
      const node = graph.createNode({
        type: 'cost_model', name: 'Cost Model V1', content: { tco: 1000 }, summary: 'V1',
        producedBy: { domain: 'costops', agent: 'attribution', role: 'Cost' }, pass: 4,
      });
      const updated = graph.updateNode(node.id, { content: { tco: 1500 }, summary: 'V2' });
      expect(updated.version).toBe(2);
      expect(updated.content).toEqual({ tco: 1500 });
      expect(updated.summary).toBe('V2');
    });

    test('updateNode throws for unknown ID', () => {
      expect(() => graph.updateNode('nonexistent', {})).toThrow('not found');
    });

    test('memoryKey generates correct format', () => {
      const key = graph.memoryKey('node-123');
      expect(key).toBe('decisiongraph:test-exec-001:node-123');
    });
  });

  // ==========================================================================
  // Version History (ADR-033 — append-only)
  // ==========================================================================

  describe('Version History', () => {
    test('initial node has one version entry', () => {
      const node = graph.createNode({
        type: 'cost_model', name: 'Cost', content: { tco: 100 }, summary: 'V1',
        producedBy: { domain: 'costops', agent: 'roi', role: 'Cost' }, pass: 4,
      });
      const history = graph.getVersionHistory(node.id);
      expect(history).toHaveLength(1);
      expect(history[0]!.version).toBe(1);
      expect(history[0]!.content).toEqual({ tco: 100 });
    });

    test('update appends to history (originals preserved)', () => {
      const node = graph.createNode({
        type: 'cost_model', name: 'Cost', content: { tco: 100 }, summary: 'V1',
        producedBy: { domain: 'costops', agent: 'roi', role: 'Cost' }, pass: 4,
      });
      graph.updateNode(node.id, { content: { tco: 200 }, summary: 'V2' });
      graph.updateNode(node.id, { content: { tco: 300 }, summary: 'V3' });

      const history = graph.getVersionHistory(node.id);
      expect(history).toHaveLength(3);
      expect(history[0]!.content).toEqual({ tco: 100 });
      expect(history[0]!.summary).toBe('V1');
      expect(history[1]!.content).toEqual({ tco: 200 });
      expect(history[1]!.summary).toBe('V2');
      expect(history[2]!.content).toEqual({ tco: 300 });
      expect(history[2]!.summary).toBe('V3');
    });

    test('getNodeAtVersion retrieves specific version', () => {
      const node = graph.createNode({
        type: 'cost_model', name: 'Cost', content: { tco: 100 }, summary: 'V1',
        producedBy: { domain: 'costops', agent: 'roi', role: 'Cost' }, pass: 4,
      });
      graph.updateNode(node.id, { content: { tco: 200 }, summary: 'V2' });

      const v1 = graph.getNodeAtVersion(node.id, 1);
      expect(v1).toBeDefined();
      expect(v1!.content).toEqual({ tco: 100 });

      const v2 = graph.getNodeAtVersion(node.id, 2);
      expect(v2).toBeDefined();
      expect(v2!.content).toEqual({ tco: 200 });

      const v3 = graph.getNodeAtVersion(node.id, 3);
      expect(v3).toBeUndefined();
    });

    test('getVersionHistory returns empty for unknown node', () => {
      expect(graph.getVersionHistory('nonexistent')).toHaveLength(0);
    });
  });

  // ==========================================================================
  // Automatic Edge Creation
  // ==========================================================================

  describe('Automatic Edge Creation', () => {
    test('derivedFrom auto-creates derived_from edges', () => {
      const a = graph.createNode({
        type: 'problem_definition', name: 'A', content: {}, summary: '',
        producedBy: { domain: 'test', agent: 'test', role: 'test' }, pass: 1,
      });
      const b = graph.createNode({
        type: 'scenario', name: 'B', content: {}, summary: '',
        producedBy: { domain: 'test', agent: 'test', role: 'test' }, pass: 2,
        derivedFrom: [a.id],
      });

      const edges = graph.getEdgesTo(b.id);
      expect(edges).toHaveLength(1);
      expect(edges[0]!.from).toBe(a.id);
      expect(edges[0]!.relation).toBe('derived_from');
    });

    test('multiple derivedFrom creates multiple edges', () => {
      const a = graph.createNode({
        type: 'problem_definition', name: 'A', content: {}, summary: '',
        producedBy: { domain: 'test', agent: 'test', role: 'test' }, pass: 1,
      });
      const b = graph.createNode({
        type: 'business_context', name: 'B', content: {}, summary: '',
        producedBy: { domain: 'test', agent: 'test', role: 'test' }, pass: 1,
      });
      const c = graph.createNode({
        type: 'scenario', name: 'C', content: {}, summary: '',
        producedBy: { domain: 'test', agent: 'test', role: 'test' }, pass: 2,
        derivedFrom: [a.id, b.id],
      });

      const edges = graph.getEdgesTo(c.id);
      expect(edges).toHaveLength(2);
    });

    test('addEdge deduplicates', () => {
      graph.addEdge('a', 'b', 'informs');
      graph.addEdge('a', 'b', 'informs');  // duplicate
      graph.addEdge('a', 'b', 'validates'); // different relation, not duplicate

      const edges = graph.getEdgesFrom('a');
      expect(edges).toHaveLength(2);
    });

    test('getEdgesByRelation filters correctly', () => {
      graph.addEdge('a', 'b', 'informs');
      graph.addEdge('b', 'c', 'derived_from');
      graph.addEdge('a', 'c', 'validates');

      expect(graph.getEdgesByRelation('informs')).toHaveLength(1);
      expect(graph.getEdgesByRelation('derived_from')).toHaveLength(1);
      expect(graph.getEdgesByRelation('validates')).toHaveLength(1);
    });

    test('getChildren returns immediate descendants', () => {
      const a = graph.createNode({
        type: 'problem_definition', name: 'A', content: {}, summary: '',
        producedBy: { domain: 'test', agent: 'test', role: 'test' }, pass: 1,
      });
      graph.createNode({
        type: 'scenario', name: 'B', content: {}, summary: '',
        producedBy: { domain: 'test', agent: 'test', role: 'test' }, pass: 2,
        derivedFrom: [a.id],
      });
      graph.createNode({
        type: 'risk_signal', name: 'C', content: {}, summary: '',
        producedBy: { domain: 'test', agent: 'test', role: 'test' }, pass: 2,
        derivedFrom: [a.id],
      });

      const children = graph.getChildren(a.id);
      expect(children).toHaveLength(2);
    });
  });

  // ==========================================================================
  // Querying
  // ==========================================================================

  describe('Basic Querying', () => {
    beforeEach(() => {
      graph.createNode({
        type: 'problem_definition', name: 'Problem 1', content: {}, summary: '',
        producedBy: { domain: 'copilot', agent: 'planner', role: 'P' }, pass: 1,
        tags: ['critical'],
      });
      graph.createNode({
        type: 'scenario', name: 'Scenario 1', content: {}, summary: '',
        producedBy: { domain: 'simulator', agent: 'what-if', role: 'S' }, pass: 2,
        tags: ['deployment'],
      });
      graph.createNode({
        type: 'scenario', name: 'Scenario 2', content: {}, summary: '',
        producedBy: { domain: 'simulator', agent: 'scenario', role: 'S' }, pass: 2,
        tags: ['failure'],
      });
      graph.createNode({
        type: 'cost_model', name: 'Cost Model', content: {}, summary: '',
        producedBy: { domain: 'costops', agent: 'attribution', role: 'C' }, pass: 4,
        tags: ['critical'],
      });
    });

    test('getNodesByType returns correct nodes', () => {
      expect(graph.getNodesByType('scenario')).toHaveLength(2);
    });

    test('getNodesByPass returns correct nodes', () => {
      expect(graph.getNodesByPass(2)).toHaveLength(2);
    });

    test('getNodesByAgent filters by domain and agent', () => {
      const nodes = graph.getNodesByAgent('simulator', 'what-if');
      expect(nodes).toHaveLength(1);
      expect(nodes[0]!.name).toBe('Scenario 1');
    });

    test('getNodesByTag returns matching nodes', () => {
      const critical = graph.getNodesByTag('critical');
      expect(critical).toHaveLength(2);
    });

    test('nodeCount is accurate', () => {
      expect(graph.nodeCount).toBe(4);
    });

    test('edgeCount is accurate', () => {
      expect(graph.edgeCount).toBe(0);
    });

    test('getAllNodes returns all nodes', () => {
      expect(graph.getAllNodes()).toHaveLength(4);
    });

    test('getAllEdges returns all edges', () => {
      graph.addEdge('a', 'b', 'informs');
      expect(graph.getAllEdges()).toHaveLength(1);
    });
  });

  // ==========================================================================
  // Compound Querying with Pagination
  // ==========================================================================

  describe('Compound Querying', () => {
    beforeEach(() => {
      graph.createNode({
        type: 'scenario', name: 'S1', content: {}, summary: '',
        producedBy: { domain: 'simulator', agent: 'what-if', role: 'S' }, pass: 2,
        confidence: 0.9, status: 'complete',
      });
      graph.createNode({
        type: 'scenario', name: 'S2', content: {}, summary: '',
        producedBy: { domain: 'simulator', agent: 'scenario', role: 'S' }, pass: 2,
        confidence: 0.6, status: 'degraded',
      });
      graph.createNode({
        type: 'risk_signal', name: 'R1', content: {}, summary: '',
        producedBy: { domain: 'sentinel', agent: 'anomaly', role: 'R' }, pass: 2,
        confidence: 0.8, status: 'complete',
      });
      graph.createNode({
        type: 'cost_model', name: 'C1', content: {}, summary: '',
        producedBy: { domain: 'costops', agent: 'roi', role: 'C' }, pass: 4,
        confidence: 0.95, status: 'complete',
      });
    });

    test('filter by type', () => {
      const result = graph.queryNodes({ type: 'scenario' });
      expect(result.total).toBe(2);
    });

    test('filter by type + pass', () => {
      const result = graph.queryNodes({ type: 'scenario', pass: 2 });
      expect(result.total).toBe(2);
    });

    test('filter by type + status', () => {
      const result = graph.queryNodes({ type: 'scenario', status: 'complete' });
      expect(result.total).toBe(1);
    });

    test('filter by minConfidence', () => {
      const result = graph.queryNodes({ minConfidence: 0.8 });
      expect(result.total).toBe(3);
    });

    test('filter by domain', () => {
      const result = graph.queryNodes({ domain: 'simulator' });
      expect(result.total).toBe(2);
    });

    test('filter by agent', () => {
      const result = graph.queryNodes({ agent: 'anomaly' });
      expect(result.total).toBe(1);
    });

    test('pagination with offset and limit', () => {
      const result = graph.queryNodes({}, { offset: 1, limit: 2 });
      expect(result.items).toHaveLength(2);
      expect(result.total).toBe(4);
      expect(result.offset).toBe(1);
      expect(result.limit).toBe(2);
      expect(result.hasMore).toBe(true);
    });

    test('pagination past end', () => {
      const result = graph.queryNodes({}, { offset: 10, limit: 5 });
      expect(result.items).toHaveLength(0);
      expect(result.total).toBe(4);
      expect(result.hasMore).toBe(false);
    });

    test('empty filter returns all nodes', () => {
      const result = graph.queryNodes({});
      expect(result.total).toBe(4);
    });
  });

  // ==========================================================================
  // Semantic Search
  // ==========================================================================

  describe('Semantic Search', () => {
    beforeEach(() => {
      graph.createNode({
        type: 'scenario', name: 'Deploy', content: {}, summary: 'Cloud deployment scenario for AWS infrastructure',
        producedBy: { domain: 'sim', agent: 'what-if', role: 'S' }, pass: 2,
      });
      graph.createNode({
        type: 'scenario', name: 'Failure', content: {}, summary: 'Database failure recovery with automated failover',
        producedBy: { domain: 'sim', agent: 'scenario', role: 'S' }, pass: 2,
      });
      graph.createNode({
        type: 'cost_model', name: 'Cost', content: {}, summary: 'Infrastructure cost model with cloud pricing',
        producedBy: { domain: 'costops', agent: 'roi', role: 'C' }, pass: 4,
      });
      graph.createNode({
        type: 'security_analysis', name: 'Security', content: {}, summary: 'Security analysis for API endpoints',
        producedBy: { domain: 'shield', agent: 'pii', role: 'S' }, pass: 4,
      });
    });

    test('finds nodes matching query terms', () => {
      const results = graph.searchBySummary('cloud infrastructure');
      expect(results.length).toBeGreaterThan(0);
      // Both deployment and cost nodes mention cloud/infrastructure
      const names = results.map(r => r.name);
      expect(names).toContain('Deploy');
    });

    test('respects topK limit', () => {
      const results = graph.searchBySummary('cloud', 1);
      expect(results).toHaveLength(1);
    });

    test('returns empty for unrelated query', () => {
      const results = graph.searchBySummary('quantum computing blockchain');
      expect(results).toHaveLength(0);
    });

    test('returns empty for empty query', () => {
      expect(graph.searchBySummary('')).toHaveLength(0);
    });

    test('ranks more relevant results higher', () => {
      const results = graph.searchBySummary('database failure recovery');
      expect(results.length).toBeGreaterThan(0);
      expect(results[0]!.name).toBe('Failure');
    });
  });

  // ==========================================================================
  // Derivation Chain
  // ==========================================================================

  describe('Derivation Chain', () => {
    test('getDerivationChain traverses ancestors', () => {
      const a = graph.createNode({
        type: 'problem_definition', name: 'A', content: {}, summary: '',
        producedBy: { domain: 'test', agent: 'test', role: 'test' }, pass: 1,
      });
      const b = graph.createNode({
        type: 'scenario', name: 'B', content: {}, summary: '',
        producedBy: { domain: 'test', agent: 'test', role: 'test' }, pass: 2,
        derivedFrom: [a.id],
      });
      const c = graph.createNode({
        type: 'cost_model', name: 'C', content: {}, summary: '',
        producedBy: { domain: 'test', agent: 'test', role: 'test' }, pass: 4,
        derivedFrom: [b.id],
      });

      const chain = graph.getDerivationChain(c.id);
      expect(chain).toHaveLength(3);
      expect(chain[0]!.name).toBe('A');
      expect(chain[1]!.name).toBe('B');
      expect(chain[2]!.name).toBe('C');
    });

    test('handles diamond derivation', () => {
      const root = graph.createNode({
        type: 'problem_definition', name: 'Root', content: {}, summary: '',
        producedBy: { domain: 'test', agent: 'test', role: 'test' }, pass: 1,
      });
      const left = graph.createNode({
        type: 'scenario', name: 'Left', content: {}, summary: '',
        producedBy: { domain: 'test', agent: 'test', role: 'test' }, pass: 2,
        derivedFrom: [root.id],
      });
      const right = graph.createNode({
        type: 'risk_signal', name: 'Right', content: {}, summary: '',
        producedBy: { domain: 'test', agent: 'test', role: 'test' }, pass: 2,
        derivedFrom: [root.id],
      });
      const merge = graph.createNode({
        type: 'cost_model', name: 'Merge', content: {}, summary: '',
        producedBy: { domain: 'test', agent: 'test', role: 'test' }, pass: 4,
        derivedFrom: [left.id, right.id],
      });

      const chain = graph.getDerivationChain(merge.id);
      // Root, Left, Right, Merge — Root only appears once despite diamond
      expect(chain).toHaveLength(4);
      const names = chain.map(n => n.name);
      expect(names.filter(n => n === 'Root')).toHaveLength(1);
    });
  });

  // ==========================================================================
  // Statistics
  // ==========================================================================

  describe('Statistics', () => {
    test('computes correct statistics', () => {
      graph.createNode({
        type: 'problem_definition', name: 'P', content: {}, summary: '',
        producedBy: { domain: 'test', agent: 'test', role: 'test' }, pass: 1,
        confidence: 0.9, status: 'complete',
      });
      graph.createNode({
        type: 'scenario', name: 'S', content: {}, summary: '',
        producedBy: { domain: 'test', agent: 'test', role: 'test' }, pass: 2,
        confidence: 0.7, status: 'degraded',
      });

      const stats = graph.getStatistics();
      expect(stats.executionId).toBe('test-exec-001');
      expect(stats.nodeCount).toBe(2);
      expect(stats.nodesByPass).toEqual({ 1: 1, 2: 1 });
      expect(stats.nodesByType).toEqual({ problem_definition: 1, scenario: 1 });
      expect(stats.nodesByStatus).toEqual({ complete: 1, degraded: 1 });
      expect(stats.averageConfidence).toBeCloseTo(0.8, 1);
      expect(stats.completenessRatio).toBe(0.5);
    });

    test('empty graph statistics', () => {
      const stats = graph.getStatistics();
      expect(stats.nodeCount).toBe(0);
      expect(stats.averageConfidence).toBe(0);
      expect(stats.completenessRatio).toBe(0);
    });
  });

  // ==========================================================================
  // Serialization (enhanced: lifecycle, history, sequence)
  // ==========================================================================

  describe('Serialization', () => {
    test('toJSON includes lifecycle and version history', () => {
      graph.createNode({
        type: 'problem_definition', name: 'Test', content: { key: 'value' }, summary: 'Test summary',
        producedBy: { domain: 'test', agent: 'test', role: 'test' }, pass: 1,
      });

      const json = graph.toJSON();
      expect(json.executionId).toBe('test-exec-001');
      expect(json.lifecycle).toBe('created');
      expect(json.nodes).toHaveLength(1);
      expect(json.edges).toHaveLength(0);
      expect(json.writeSequence).toBe(1);
      expect(Object.keys(json.versionHistory)).toHaveLength(1);
    });

    test('persist and load round-trips with lifecycle and history', () => {
      const node = graph.createNode({
        type: 'scenario', name: 'Scenario', content: { data: 42 }, summary: 'A scenario',
        producedBy: { domain: 'sim', agent: 'what-if', role: 'sim' }, pass: 2,
      });
      graph.createNode({
        type: 'risk_signal', name: 'Risk', content: {}, summary: 'A risk',
        producedBy: { domain: 'sentinel', agent: 'anomaly', role: 'detect' }, pass: 2,
      });
      graph.updateNode(node.id, { content: { data: 99 }, summary: 'Updated' });

      graph.persist();

      const loaded = DecisionGraph.load('test-exec-001', tmpDir);
      expect(loaded.nodeCount).toBe(2);
      expect(loaded.getLifecycle()).toBe('accumulated');

      // Version history preserved
      const history = loaded.getVersionHistory(node.id);
      expect(history).toHaveLength(2);
      expect(history[0]!.content).toEqual({ data: 42 });
      expect(history[1]!.content).toEqual({ data: 99 });
    });

    test('load returns empty graph when no file exists', () => {
      const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dg-empty-'));
      const loaded = DecisionGraph.load('no-file', emptyDir);
      expect(loaded.nodeCount).toBe(0);
      expect(loaded.getLifecycle()).toBe('created');
      fs.rmSync(emptyDir, { recursive: true, force: true });
    });

    test('load backward-compatible with old format (no lifecycle/history)', () => {
      // Simulate old format without lifecycle/history
      const graphDir = path.join(tmpDir, 'decision-graph');
      fs.mkdirSync(graphDir, { recursive: true });
      fs.writeFileSync(path.join(graphDir, 'decision-graph.json'), JSON.stringify({
        executionId: 'old-exec',
        nodes: [{
          id: 'old-node', type: 'problem_definition', name: 'Old',
          content: {}, summary: '', producedBy: { domain: 't', agent: 't', role: 't' },
          pass: 1, derivedFrom: [], timestamp: '2026-01-01T00:00:00Z',
          confidence: 1.0, status: 'complete', tags: [], version: 1,
        }],
        edges: [],
        // No lifecycle, versionHistory, or writeSequence
      }));

      const loaded = DecisionGraph.load('old-exec', tmpDir);
      expect(loaded.nodeCount).toBe(1);
      expect(loaded.getLifecycle()).toBe('accumulated'); // Inferred from having nodes
      // History reconstructed from current node
      const history = loaded.getVersionHistory('old-node');
      expect(history).toHaveLength(1);
    });
  });

  // ==========================================================================
  // Summary
  // ==========================================================================

  describe('summarize', () => {
    test('produces readable summary with lifecycle and stats', () => {
      graph.createNode({
        type: 'problem_definition', name: 'Problem', content: {}, summary: '',
        producedBy: { domain: 'test', agent: 'test', role: 'test' }, pass: 1,
      });
      graph.createNode({
        type: 'scenario', name: 'Scenario', content: {}, summary: '',
        producedBy: { domain: 'test', agent: 'test', role: 'test' }, pass: 2,
      });

      const summary = graph.summarize();
      expect(summary).toContain('Nodes: 2');
      expect(summary).toContain('Lifecycle:');
      expect(summary).toContain('Pass 1: 1 nodes');
      expect(summary).toContain('Pass 2: 1 nodes');
      expect(summary).toContain('problem_definition: 1');
      expect(summary).toContain('scenario: 1');
    });
  });
});
