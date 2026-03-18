/**
 * DecisionGraph — Unified Data Model (ADR-033)
 *
 * Canonical shared data model for every pipeline execution.
 * A directed acyclic graph (DAG) where nodes are data artifacts
 * and edges represent derivation relationships.
 *
 * Features:
 *   - Typed node/edge CRUD with schema validation
 *   - Append-only version history (originals preserved)
 *   - Automatic edge creation from derivedFrom references
 *   - Graph lifecycle management (created → accumulated → sealed)
 *   - Compound querying with pagination
 *   - Semantic search on summary fields
 *   - JSON file persistence + AgentDB memory sync
 *   - Concurrent-safe writes via monotonic timestamps
 *   - Statistics and metrics aggregation
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import type {
  DecisionGraphNode,
  DecisionGraphEdge,
  DecisionNodeType,
  EdgeRelation,
  PassNumber,
  AgentRef,
} from './types.js';

// ============================================================================
// Runtime Node Type Enum (ADR-033 specifies enum, not just type union)
// ============================================================================

/** All valid DecisionNodeType values as a runtime-accessible object. */
export const DECISION_NODE_TYPES = {
  // Pass 1 — Problem Intelligence
  PROBLEM_DEFINITION: 'problem_definition' as const,
  BUSINESS_CONTEXT: 'business_context' as const,
  TECHNICAL_SCOPE: 'technical_scope' as const,
  ARCHITECTURE_HYPOTHESIS: 'architecture_hypothesis' as const,
  EXECUTION_PLAN: 'execution_plan' as const,
  DECISION_LINEAGE: 'decision_lineage' as const,
  // Pass 2 — Simulation
  SCENARIO: 'scenario' as const,
  RISK_SIGNAL: 'risk_signal' as const,
  RELIABILITY_REPORT: 'reliability_report' as const,
  // Pass 3 — Architecture
  SYSTEM_ARCHITECTURE: 'system_architecture' as const,
  INTEGRATION_MAP: 'integration_map' as const,
  DATA_FLOW: 'data_flow' as const,
  SERVICE_BOUNDARY: 'service_boundary' as const,
  PROTOTYPE: 'prototype' as const,
  API_CONTRACT: 'api_contract' as const,
  SDK_INTERFACE: 'sdk_interface' as const,
  // Pass 4 — Governance
  SECURITY_ANALYSIS: 'security_analysis' as const,
  COMPLIANCE_REPORT: 'compliance_report' as const,
  COST_MODEL: 'cost_model' as const,
  GOVERNANCE_REPORT: 'governance_report' as const,
  POLICY_ANALYSIS: 'policy_analysis' as const,
  // Pass 5 — Decision Artifacts
  EXECUTIVE_MEMO: 'executive_memo' as const,
  EXECUTIVE_SUMMARY: 'executive_summary' as const,
  RISK_ASSESSMENT: 'risk_assessment' as const,
  IMPLEMENTATION_ROADMAP: 'implementation_roadmap' as const,
  ORG_IMPACT: 'org_impact' as const,
  STAKEHOLDER_MAP: 'stakeholder_map' as const,
  KPI_DEFINITION: 'kpi_definition' as const,
  OKR_ALIGNMENT: 'okr_alignment' as const,
  RAID_LOG: 'raid_log' as const,
  CONFIDENCE_SCORE: 'confidence_score' as const,
  // Pass 6 — Deployment
  DEPLOYMENT_ENDPOINT: 'deployment_endpoint' as const,
  INTEGRATION_RESULT: 'integration_result' as const,
  // Pass 7 — Observability
  TELEMETRY_CONFIG: 'telemetry_config' as const,
  HEALTH_CHECK: 'health_check' as const,
  LEARNED_PATTERN: 'learned_pattern' as const,
  // Cross-cutting
  PROVENANCE_MANIFEST: 'provenance_manifest' as const,
} as const;

/** Set of all valid node type values for runtime validation. */
export const VALID_NODE_TYPES: ReadonlySet<string> = new Set(
  Object.values(DECISION_NODE_TYPES),
);

/** All valid EdgeRelation values as a runtime-accessible object. */
export const EDGE_RELATIONS = {
  DERIVED_FROM: 'derived_from' as const,
  INFORMS: 'informs' as const,
  VALIDATES: 'validates' as const,
  SUPERSEDES: 'supersedes' as const,
  AGGREGATES: 'aggregates' as const,
} as const;

/** Set of all valid edge relation values for runtime validation. */
export const VALID_EDGE_RELATIONS: ReadonlySet<string> = new Set(
  Object.values(EDGE_RELATIONS),
);

// ============================================================================
// Graph Lifecycle
// ============================================================================

/** Lifecycle states for the DecisionGraph. */
export type GraphLifecycle =
  | 'created'       // Pipeline started; root node placed
  | 'accumulated'   // Passes 2-7 adding nodes
  | 'sealed'        // Pipeline complete; no more writes
  | 'queryable';    // Sealed + available for external queries

// ============================================================================
// Version History Entry
// ============================================================================

/** A snapshot of a node at a specific version. */
export interface NodeVersionEntry {
  readonly version: number;
  readonly timestamp: string;
  readonly content: Record<string, unknown>;
  readonly summary: string;
  readonly status: DecisionGraphNode['status'];
  readonly confidence: number;
}

// ============================================================================
// Query Types
// ============================================================================

/** Compound query filter for nodes. */
export interface NodeQuery {
  readonly type?: DecisionNodeType;
  readonly pass?: PassNumber;
  readonly tag?: string;
  readonly status?: DecisionGraphNode['status'];
  readonly domain?: string;
  readonly agent?: string;
  readonly minConfidence?: number;
}

/** Pagination options for query results. */
export interface PaginationOptions {
  readonly offset?: number;
  readonly limit?: number;
}

/** Paginated query result. */
export interface PaginatedResult<T> {
  readonly items: readonly T[];
  readonly total: number;
  readonly offset: number;
  readonly limit: number;
  readonly hasMore: boolean;
}

// ============================================================================
// Graph Statistics
// ============================================================================

/** Aggregate statistics for the graph. */
export interface GraphStatistics {
  readonly executionId: string;
  readonly lifecycle: GraphLifecycle;
  readonly nodeCount: number;
  readonly edgeCount: number;
  readonly nodesByPass: Readonly<Record<number, number>>;
  readonly nodesByType: Readonly<Record<string, number>>;
  readonly nodesByStatus: Readonly<Record<string, number>>;
  readonly averageConfidence: number;
  readonly completenessRatio: number;
}

// ============================================================================
// Validation Error
// ============================================================================

/** Structured node validation error. */
export interface NodeValidationError {
  readonly field: string;
  readonly message: string;
}

// ============================================================================
// DecisionGraph
// ============================================================================

export class DecisionGraph {
  private readonly nodes: Map<string, DecisionGraphNode> = new Map();
  private readonly edges: DecisionGraphEdge[] = [];
  private readonly versionHistory: Map<string, NodeVersionEntry[]> = new Map();
  private readonly executionId: string;
  private readonly outputDir: string;
  private lifecycle: GraphLifecycle;
  private writeSequence: number = 0;

  constructor(executionId: string, outputDir: string) {
    this.executionId = executionId;
    this.outputDir = outputDir;
    this.lifecycle = 'created';
  }

  // --------------------------------------------------------------------------
  // Identity & Lifecycle
  // --------------------------------------------------------------------------

  /** Get the execution ID. */
  getExecutionId(): string {
    return this.executionId;
  }

  /** Get the current lifecycle state. */
  getLifecycle(): GraphLifecycle {
    return this.lifecycle;
  }

  /** Transition to accumulated state (called after first node beyond root). */
  markAccumulated(): void {
    if (this.lifecycle === 'created') {
      this.lifecycle = 'accumulated';
    }
  }

  /** Seal the graph — no further writes allowed. */
  seal(): void {
    this.lifecycle = 'sealed';
  }

  /** Mark as queryable — sealed + available for external queries. */
  markQueryable(): void {
    if (this.lifecycle === 'sealed') {
      this.lifecycle = 'queryable';
    }
  }

  /** Check if the graph accepts writes. */
  isWritable(): boolean {
    return this.lifecycle === 'created' || this.lifecycle === 'accumulated';
  }

  // --------------------------------------------------------------------------
  // Node ID Generation
  // --------------------------------------------------------------------------

  /** Generate a new unique node ID. */
  generateNodeId(): string {
    return crypto.randomUUID();
  }

  /**
   * Generate the canonical AgentDB memory key for a node.
   * Format: decisiongraph:{execution_id}:{node_id}
   */
  memoryKey(nodeId: string): string {
    return `decisiongraph:${this.executionId}:${nodeId}`;
  }

  // --------------------------------------------------------------------------
  // Node Validation
  // --------------------------------------------------------------------------

  /** Validate a node against the schema. Returns errors (empty = valid). */
  validateNode(node: DecisionGraphNode): readonly NodeValidationError[] {
    const errors: NodeValidationError[] = [];

    if (!node.id || typeof node.id !== 'string') {
      errors.push({ field: 'id', message: 'Node ID is required and must be a non-empty string' });
    }
    if (!VALID_NODE_TYPES.has(node.type)) {
      errors.push({ field: 'type', message: `Invalid node type "${node.type}". Must be one of: ${Array.from(VALID_NODE_TYPES).join(', ')}` });
    }
    if (!node.name || typeof node.name !== 'string') {
      errors.push({ field: 'name', message: 'Node name is required and must be a non-empty string' });
    }
    if (node.content === null || node.content === undefined || typeof node.content !== 'object') {
      errors.push({ field: 'content', message: 'Content is required and must be an object' });
    }
    if (typeof node.summary !== 'string') {
      errors.push({ field: 'summary', message: 'Summary is required and must be a string' });
    }
    // producedBy is MANDATORY per ADR-033
    if (!node.producedBy || !node.producedBy.domain || !node.producedBy.agent) {
      errors.push({ field: 'producedBy', message: 'producedBy is required with domain and agent fields' });
    }
    if (typeof node.pass !== 'number' || node.pass < 1 || node.pass > 7) {
      errors.push({ field: 'pass', message: 'Pass must be a number between 1 and 7' });
    }
    // derivedFrom is MANDATORY (can be empty array for root nodes)
    if (!Array.isArray(node.derivedFrom)) {
      errors.push({ field: 'derivedFrom', message: 'derivedFrom is required and must be an array of node IDs' });
    }
    if (typeof node.confidence !== 'number' || node.confidence < 0 || node.confidence > 1) {
      errors.push({ field: 'confidence', message: 'Confidence must be a number between 0.0 and 1.0' });
    }
    const validStatuses = ['complete', 'partial', 'degraded', 'failed'];
    if (!validStatuses.includes(node.status)) {
      errors.push({ field: 'status', message: `Status must be one of: ${validStatuses.join(', ')}` });
    }
    if (!Array.isArray(node.tags)) {
      errors.push({ field: 'tags', message: 'Tags must be an array of strings' });
    }
    if (typeof node.version !== 'number' || node.version < 1) {
      errors.push({ field: 'version', message: 'Version must be a positive integer' });
    }
    if (!node.timestamp || typeof node.timestamp !== 'string') {
      errors.push({ field: 'timestamp', message: 'Timestamp is required and must be an ISO 8601 string' });
    }

    return errors;
  }

  // --------------------------------------------------------------------------
  // Node Operations — Write
  // --------------------------------------------------------------------------

  /** Add a validated node to the graph. Throws on validation failure. */
  addNode(node: DecisionGraphNode): void {
    if (!this.isWritable()) {
      throw new Error(`DecisionGraph: cannot write to graph in "${this.lifecycle}" state`);
    }
    if (this.nodes.has(node.id)) {
      throw new Error(`DecisionGraph: duplicate node ID "${node.id}"`);
    }

    // Validate
    const errors = this.validateNode(node);
    if (errors.length > 0) {
      throw new Error(`DecisionGraph: node validation failed:\n${errors.map(e => `  ${e.field}: ${e.message}`).join('\n')}`);
    }

    this.nodes.set(node.id, node);
    this.writeSequence++;

    // Store initial version in history
    this.versionHistory.set(node.id, [{
      version: node.version,
      timestamp: node.timestamp,
      content: node.content,
      summary: node.summary,
      status: node.status,
      confidence: node.confidence,
    }]);

    // Auto-create derived_from edges from derivedFrom references
    for (const parentId of node.derivedFrom) {
      this.edges.push({ from: parentId, to: node.id, relation: 'derived_from' });
    }

    // Transition lifecycle
    if (this.lifecycle === 'created' && this.nodes.size > 1) {
      this.lifecycle = 'accumulated';
    }
  }

  /**
   * Update an existing node (ADR-033: append-only history).
   * Original content is preserved in version history.
   * Increments version and updates timestamp.
   */
  updateNode(
    nodeId: string,
    updates: Partial<Pick<DecisionGraphNode, 'content' | 'summary' | 'status' | 'confidence' | 'tags'>>,
  ): DecisionGraphNode {
    if (!this.isWritable()) {
      throw new Error(`DecisionGraph: cannot write to graph in "${this.lifecycle}" state`);
    }
    const existing = this.nodes.get(nodeId);
    if (!existing) {
      throw new Error(`DecisionGraph: node "${nodeId}" not found`);
    }

    const newVersion = existing.version + 1;
    const newTimestamp = new Date().toISOString();

    const updated: DecisionGraphNode = {
      ...existing,
      ...updates,
      version: newVersion,
      timestamp: newTimestamp,
    };

    // Validate the updated node
    const errors = this.validateNode(updated);
    if (errors.length > 0) {
      throw new Error(`DecisionGraph: update validation failed:\n${errors.map(e => `  ${e.field}: ${e.message}`).join('\n')}`);
    }

    this.nodes.set(nodeId, updated);
    this.writeSequence++;

    // Append to version history (original preserved)
    const history = this.versionHistory.get(nodeId);
    if (history) {
      history.push({
        version: newVersion,
        timestamp: newTimestamp,
        content: updated.content,
        summary: updated.summary,
        status: updated.status,
        confidence: updated.confidence,
      });
    }

    return updated;
  }

  // --------------------------------------------------------------------------
  // Node Operations — Read
  // --------------------------------------------------------------------------

  /** Get a node by ID. Returns undefined if not found. */
  getNode(nodeId: string): DecisionGraphNode | undefined {
    return this.nodes.get(nodeId);
  }

  /** Get all nodes of a specific type. */
  getNodesByType(type: DecisionNodeType): readonly DecisionGraphNode[] {
    const result: DecisionGraphNode[] = [];
    for (const node of this.nodes.values()) {
      if (node.type === type) {
        result.push(node);
      }
    }
    return result;
  }

  /** Get all nodes from a specific pass. */
  getNodesByPass(pass: PassNumber): readonly DecisionGraphNode[] {
    const result: DecisionGraphNode[] = [];
    for (const node of this.nodes.values()) {
      if (node.pass === pass) {
        result.push(node);
      }
    }
    return result;
  }

  /** Get all nodes produced by a specific agent. */
  getNodesByAgent(domain: string, agent: string): readonly DecisionGraphNode[] {
    const result: DecisionGraphNode[] = [];
    for (const node of this.nodes.values()) {
      if (node.producedBy.domain === domain && node.producedBy.agent === agent) {
        result.push(node);
      }
    }
    return result;
  }

  /** Get all nodes matching a tag. */
  getNodesByTag(tag: string): readonly DecisionGraphNode[] {
    const result: DecisionGraphNode[] = [];
    for (const node of this.nodes.values()) {
      if (node.tags.includes(tag)) {
        result.push(node);
      }
    }
    return result;
  }

  /** Get total node count. */
  get nodeCount(): number {
    return this.nodes.size;
  }

  /** Get total edge count. */
  get edgeCount(): number {
    return this.edges.length;
  }

  /** Get all nodes as an array. */
  getAllNodes(): readonly DecisionGraphNode[] {
    return Array.from(this.nodes.values());
  }

  /** Get all edges as an array. */
  getAllEdges(): readonly DecisionGraphEdge[] {
    return [...this.edges];
  }

  // --------------------------------------------------------------------------
  // Compound Querying with Pagination (ADR-033)
  // --------------------------------------------------------------------------

  /**
   * Query nodes with compound filters and optional pagination.
   * All filter fields are ANDed together.
   */
  queryNodes(
    filter: NodeQuery,
    pagination?: PaginationOptions,
  ): PaginatedResult<DecisionGraphNode> {
    let results: DecisionGraphNode[] = [];

    for (const node of this.nodes.values()) {
      if (filter.type !== undefined && node.type !== filter.type) continue;
      if (filter.pass !== undefined && node.pass !== filter.pass) continue;
      if (filter.tag !== undefined && !node.tags.includes(filter.tag)) continue;
      if (filter.status !== undefined && node.status !== filter.status) continue;
      if (filter.domain !== undefined && node.producedBy.domain !== filter.domain) continue;
      if (filter.agent !== undefined && node.producedBy.agent !== filter.agent) continue;
      if (filter.minConfidence !== undefined && node.confidence < filter.minConfidence) continue;
      results.push(node);
    }

    const total = results.length;
    const offset = pagination?.offset ?? 0;
    const limit = pagination?.limit ?? total;

    results = results.slice(offset, offset + limit);

    return {
      items: results,
      total,
      offset,
      limit,
      hasMore: offset + limit < total,
    };
  }

  // --------------------------------------------------------------------------
  // Semantic Search (ADR-033 — text similarity on summary fields)
  // --------------------------------------------------------------------------

  /**
   * Search nodes by text similarity on the summary field.
   * Uses simple token overlap scoring (production systems would use
   * vector embeddings via AgentDB HNSW — this provides the interface).
   */
  searchBySummary(query: string, topK: number = 10): readonly DecisionGraphNode[] {
    if (!query.trim()) return [];

    const queryTokens = tokenize(query);
    if (queryTokens.size === 0) return [];

    const scored: { node: DecisionGraphNode; score: number }[] = [];

    for (const node of this.nodes.values()) {
      if (!node.summary) continue;
      const nodeTokens = tokenize(node.summary);
      if (nodeTokens.size === 0) continue;

      // Jaccard similarity
      let intersection = 0;
      for (const t of queryTokens) {
        if (nodeTokens.has(t)) intersection++;
      }
      const union = queryTokens.size + nodeTokens.size - intersection;
      const score = union > 0 ? intersection / union : 0;

      if (score > 0) {
        scored.push({ node, score });
      }
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK).map(s => s.node);
  }

  // --------------------------------------------------------------------------
  // Edge Operations
  // --------------------------------------------------------------------------

  /** Add an edge to the graph with validation. */
  addEdge(from: string, to: string, relation: EdgeRelation): void {
    if (!VALID_EDGE_RELATIONS.has(relation)) {
      throw new Error(`DecisionGraph: invalid edge relation "${relation}"`);
    }
    // Check for duplicate edges
    const exists = this.edges.some(
      e => e.from === from && e.to === to && e.relation === relation,
    );
    if (!exists) {
      this.edges.push({ from, to, relation });
    }
  }

  /** Get all edges from a specific node. */
  getEdgesFrom(nodeId: string): readonly DecisionGraphEdge[] {
    return this.edges.filter(e => e.from === nodeId);
  }

  /** Get all edges to a specific node. */
  getEdgesTo(nodeId: string): readonly DecisionGraphEdge[] {
    return this.edges.filter(e => e.to === nodeId);
  }

  /** Get all edges with a specific relation. */
  getEdgesByRelation(relation: EdgeRelation): readonly DecisionGraphEdge[] {
    return this.edges.filter(e => e.relation === relation);
  }

  /** Get the full derivation chain for a node (all ancestors, depth-first). */
  getDerivationChain(nodeId: string): readonly DecisionGraphNode[] {
    const visited = new Set<string>();
    const chain: DecisionGraphNode[] = [];

    const walk = (id: string): void => {
      if (visited.has(id)) return;
      visited.add(id);

      const node = this.nodes.get(id);
      if (!node) return;

      for (const parentId of node.derivedFrom) {
        walk(parentId);
      }
      chain.push(node);
    };

    walk(nodeId);
    return chain;
  }

  /** Get the immediate children of a node (nodes that derive from it). */
  getChildren(nodeId: string): readonly DecisionGraphNode[] {
    const children: DecisionGraphNode[] = [];
    for (const node of this.nodes.values()) {
      if (node.derivedFrom.includes(nodeId)) {
        children.push(node);
      }
    }
    return children;
  }

  // --------------------------------------------------------------------------
  // Version History (ADR-033 — append-only, originals preserved)
  // --------------------------------------------------------------------------

  /** Get the full version history for a node. */
  getVersionHistory(nodeId: string): readonly NodeVersionEntry[] {
    return this.versionHistory.get(nodeId) ?? [];
  }

  /** Get a specific version of a node's content. */
  getNodeAtVersion(nodeId: string, version: number): NodeVersionEntry | undefined {
    const history = this.versionHistory.get(nodeId);
    if (!history) return undefined;
    return history.find(h => h.version === version);
  }

  // --------------------------------------------------------------------------
  // Convenience Node Factory
  // --------------------------------------------------------------------------

  /** Create and add a node with minimal boilerplate. Auto-tags with pass/type/agent. */
  createNode(params: {
    type: DecisionNodeType;
    name: string;
    content: Record<string, unknown>;
    summary: string;
    producedBy: AgentRef;
    pass: PassNumber;
    derivedFrom?: readonly string[];
    confidence?: number;
    status?: DecisionGraphNode['status'];
    tags?: readonly string[];
  }): DecisionGraphNode {
    // Auto-generate tags from pass, type, agent, and status
    const status = params.status ?? 'complete';
    const autoTags: string[] = [
      `pass:${params.pass}`,
      `type:${params.type}`,
      `domain:${params.producedBy.domain}`,
      `agent:${params.producedBy.agent}`,
      `execution:${this.executionId}`,
      `status:${status}`,
    ];
    const userTags = params.tags ? [...params.tags] : [];
    // Merge without duplicates
    const allTags = [...new Set([...autoTags, ...userTags])];

    const node: DecisionGraphNode = {
      id: this.generateNodeId(),
      type: params.type,
      name: params.name,
      content: params.content,
      summary: params.summary,
      producedBy: params.producedBy,
      pass: params.pass,
      derivedFrom: params.derivedFrom ?? [],
      timestamp: new Date().toISOString(),
      confidence: params.confidence ?? 1.0,
      status: params.status ?? 'complete',
      tags: allTags,
      version: 1,
    };
    this.addNode(node);
    return node;
  }

  // --------------------------------------------------------------------------
  // Statistics (ADR-033 — graph metrics)
  // --------------------------------------------------------------------------

  /** Compute aggregate statistics for the graph. */
  getStatistics(): GraphStatistics {
    const nodesByPass: Record<number, number> = {};
    const nodesByType: Record<string, number> = {};
    const nodesByStatus: Record<string, number> = {};
    let totalConfidence = 0;
    let completeCount = 0;

    for (const node of this.nodes.values()) {
      nodesByPass[node.pass] = (nodesByPass[node.pass] ?? 0) + 1;
      nodesByType[node.type] = (nodesByType[node.type] ?? 0) + 1;
      nodesByStatus[node.status] = (nodesByStatus[node.status] ?? 0) + 1;
      totalConfidence += node.confidence;
      if (node.status === 'complete') completeCount++;
    }

    const nodeCount = this.nodes.size;
    return {
      executionId: this.executionId,
      lifecycle: this.lifecycle,
      nodeCount,
      edgeCount: this.edges.length,
      nodesByPass,
      nodesByType,
      nodesByStatus,
      averageConfidence: nodeCount > 0 ? totalConfidence / nodeCount : 0,
      completenessRatio: nodeCount > 0 ? completeCount / nodeCount : 0,
    };
  }

  // --------------------------------------------------------------------------
  // Serialization
  // --------------------------------------------------------------------------

  /** Serialize the graph to JSON (includes version history). */
  toJSON(): {
    executionId: string;
    lifecycle: GraphLifecycle;
    nodes: DecisionGraphNode[];
    edges: DecisionGraphEdge[];
    versionHistory: Record<string, NodeVersionEntry[]>;
    writeSequence: number;
  } {
    const historyObj: Record<string, NodeVersionEntry[]> = {};
    for (const [nodeId, entries] of this.versionHistory.entries()) {
      historyObj[nodeId] = entries;
    }
    return {
      executionId: this.executionId,
      lifecycle: this.lifecycle,
      nodes: Array.from(this.nodes.values()),
      edges: [...this.edges],
      versionHistory: historyObj,
      writeSequence: this.writeSequence,
    };
  }

  /** Persist the graph to the output directory. */
  persist(): string {
    const graphDir = path.join(this.outputDir, 'decision-graph');
    fs.mkdirSync(graphDir, { recursive: true });

    const filePath = path.join(graphDir, 'decision-graph.json');
    fs.writeFileSync(filePath, JSON.stringify(this.toJSON(), null, 2), 'utf-8');
    return filePath;
  }

  /** Load a previously persisted graph (rehydrates lifecycle, history, sequence). */
  static load(executionId: string, outputDir: string): DecisionGraph {
    const filePath = path.join(outputDir, 'decision-graph', 'decision-graph.json');
    if (!fs.existsSync(filePath)) {
      return new DecisionGraph(executionId, outputDir);
    }

    const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as {
      executionId: string;
      lifecycle?: GraphLifecycle;
      nodes: DecisionGraphNode[];
      edges: DecisionGraphEdge[];
      versionHistory?: Record<string, NodeVersionEntry[]>;
      writeSequence?: number;
    };

    const graph = new DecisionGraph(raw.executionId, outputDir);
    graph.lifecycle = raw.lifecycle ?? (raw.nodes.length > 0 ? 'accumulated' : 'created');
    graph.writeSequence = raw.writeSequence ?? raw.nodes.length;

    // Load nodes directly (skip validation for persisted data)
    for (const node of raw.nodes) {
      graph.nodes.set(node.id, node);
    }
    for (const edge of raw.edges) {
      graph.edges.push(edge);
    }

    // Load version history
    if (raw.versionHistory) {
      for (const [nodeId, entries] of Object.entries(raw.versionHistory)) {
        graph.versionHistory.set(nodeId, entries);
      }
    } else {
      // Reconstruct minimal history from current nodes
      for (const node of raw.nodes) {
        graph.versionHistory.set(node.id, [{
          version: node.version,
          timestamp: node.timestamp,
          content: node.content,
          summary: node.summary,
          status: node.status,
          confidence: node.confidence,
        }]);
      }
    }

    return graph;
  }

  // --------------------------------------------------------------------------
  // Summary
  // --------------------------------------------------------------------------

  /** Generate a human-readable summary of the graph. */
  summarize(): string {
    const stats = this.getStatistics();
    const lines: string[] = [
      `DecisionGraph: ${this.executionId}`,
      `  Lifecycle: ${stats.lifecycle}`,
      `  Nodes: ${stats.nodeCount}`,
      `  Edges: ${stats.edgeCount}`,
      `  Avg Confidence: ${(stats.averageConfidence * 100).toFixed(0)}%`,
      `  Completeness: ${(stats.completenessRatio * 100).toFixed(0)}%`,
      '',
    ];

    lines.push('  By Pass:');
    for (const [pass, count] of Object.entries(stats.nodesByPass).sort(([a], [b]) => Number(a) - Number(b))) {
      lines.push(`    Pass ${pass}: ${count} nodes`);
    }

    lines.push('  By Type:');
    for (const [type, count] of Object.entries(stats.nodesByType).sort()) {
      lines.push(`    ${type}: ${count}`);
    }

    if (Object.keys(stats.nodesByStatus).length > 0) {
      lines.push('  By Status:');
      for (const [status, count] of Object.entries(stats.nodesByStatus).sort()) {
        lines.push(`    ${status}: ${count}`);
      }
    }

    return lines.join('\n');
  }
}

// ============================================================================
// Helpers
// ============================================================================

/** Tokenize a string for simple text similarity. */
function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(t => t.length > 2),
  );
}
