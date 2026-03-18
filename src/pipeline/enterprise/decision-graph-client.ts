/**
 * DecisionGraphClient — Agent-Facing Typed Wrapper (ADR-033)
 *
 * Thin wrapper that provides the Read/Write/Update protocol for agents.
 * Agents import this client rather than interacting with raw DecisionGraph
 * or AgentDB memory APIs.
 *
 * The client:
 *   - Enforces schema compliance (producedBy, derivedFrom mandatory)
 *   - Auto-populates tags, timestamps, versions
 *   - Provides typed query builders for common patterns
 *   - Bridges to AgentDB memory sync when available
 *
 * Per ADR-033: "A thin DecisionGraphClient wrapper provides typed
 * read/write methods — agents import the client, not raw memory APIs."
 */

import type {
  DecisionGraphNode,
  DecisionNodeType,
  EdgeRelation,
  PassNumber,
  AgentRef,
} from './types.js';
import { DecisionGraph } from './decision-graph.js';
import type {
  NodeQuery,
  PaginationOptions,
  NodeVersionEntry,
  GraphStatistics,
  GraphLifecycle,
} from './decision-graph.js';

// ============================================================================
// Write Request Types
// ============================================================================

/** Parameters for writing a new node via the client. */
export interface WriteNodeParams {
  /** The node type (from DecisionNodeType enum). */
  readonly type: DecisionNodeType;
  /** Human-readable label. */
  readonly name: string;
  /** Structured payload (type-specific). */
  readonly content: Record<string, unknown>;
  /** One-paragraph summary for executive consumption. */
  readonly summary: string;
  /** Which agent created this node (MANDATORY per ADR-033). */
  readonly producedBy: AgentRef;
  /** Which pipeline pass (1-7). */
  readonly pass: PassNumber;
  /** IDs of parent nodes this was derived from (MANDATORY, can be []). */
  readonly derivedFrom?: readonly string[];
  /** Agent-reported confidence (0.0-1.0, default 1.0). */
  readonly confidence?: number;
  /** Node status (default 'complete'). */
  readonly status?: DecisionGraphNode['status'];
  /** Additional searchable tags (auto-tags are always added). */
  readonly tags?: readonly string[];
}

/** Parameters for updating an existing node. */
export interface UpdateNodeParams {
  /** Updated structured payload. */
  readonly content?: Record<string, unknown>;
  /** Updated summary. */
  readonly summary?: string;
  /** Updated status. */
  readonly status?: DecisionGraphNode['status'];
  /** Updated confidence. */
  readonly confidence?: number;
  /** Updated tags (replaces existing user tags; auto-tags are preserved). */
  readonly tags?: readonly string[];
}

// ============================================================================
// Read Result Types
// ============================================================================

/** Result from a node read operation. */
export interface ReadResult {
  readonly found: boolean;
  readonly node?: DecisionGraphNode;
}

/** Result from a multi-node query. */
export interface QueryResult {
  readonly nodes: readonly DecisionGraphNode[];
  readonly total: number;
  readonly hasMore: boolean;
}

// ============================================================================
// DecisionGraphClient
// ============================================================================

export class DecisionGraphClient {
  private readonly graph: DecisionGraph;
  private readonly agentRef: AgentRef;
  private readonly pass: PassNumber;

  /**
   * Create a client bound to a specific agent and pass.
   *
   * All writes through this client will automatically set producedBy
   * and pass fields. Agents don't need to repeat themselves.
   *
   * @param graph - The underlying DecisionGraph instance.
   * @param agentRef - The calling agent's identity.
   * @param pass - The pipeline pass this agent is executing in.
   */
  constructor(graph: DecisionGraph, agentRef: AgentRef, pass: PassNumber) {
    this.graph = graph;
    this.agentRef = agentRef;
    this.pass = pass;
  }

  // --------------------------------------------------------------------------
  // Write Protocol (ADR-033)
  // --------------------------------------------------------------------------

  /**
   * Write a new node to the graph.
   * Auto-populates producedBy, pass, and standard tags.
   */
  write(params: Omit<WriteNodeParams, 'producedBy' | 'pass'> & {
    producedBy?: AgentRef;
    pass?: PassNumber;
  }): DecisionGraphNode {
    return this.graph.createNode({
      ...params,
      producedBy: params.producedBy ?? this.agentRef,
      pass: params.pass ?? this.pass,
    });
  }

  /**
   * Write multiple nodes in a batch. All nodes use the same agent/pass context.
   * Returns all created nodes.
   */
  writeBatch(
    paramsList: readonly Omit<WriteNodeParams, 'producedBy' | 'pass'>[],
  ): readonly DecisionGraphNode[] {
    return paramsList.map(params => this.write(params));
  }

  // --------------------------------------------------------------------------
  // Update Protocol (ADR-033 — append-only history)
  // --------------------------------------------------------------------------

  /**
   * Update an existing node.
   * Original content is preserved in version history.
   * Increments version automatically.
   */
  update(nodeId: string, updates: UpdateNodeParams): DecisionGraphNode {
    return this.graph.updateNode(nodeId, updates);
  }

  // --------------------------------------------------------------------------
  // Read Protocol (ADR-033)
  // --------------------------------------------------------------------------

  /** Read a single node by ID. */
  read(nodeId: string): ReadResult {
    const node = this.graph.getNode(nodeId);
    return node ? { found: true, node } : { found: false };
  }

  /** Read all nodes of a specific type. */
  readByType(type: DecisionNodeType): readonly DecisionGraphNode[] {
    return this.graph.getNodesByType(type);
  }

  /** Read all nodes from a specific pass. */
  readByPass(pass: PassNumber): readonly DecisionGraphNode[] {
    return this.graph.getNodesByPass(pass);
  }

  /** Read all nodes from prior passes (useful for building context). */
  readPriorPasses(): readonly DecisionGraphNode[] {
    const results: DecisionGraphNode[] = [];
    for (let p = 1; p < this.pass; p++) {
      const nodes = this.graph.getNodesByPass(p as PassNumber);
      for (const node of nodes) {
        results.push(node);
      }
    }
    return results;
  }

  /** Read all nodes produced by a specific agent. */
  readByAgent(domain: string, agent: string): readonly DecisionGraphNode[] {
    return this.graph.getNodesByAgent(domain, agent);
  }

  /** Read nodes matching a tag. */
  readByTag(tag: string): readonly DecisionGraphNode[] {
    return this.graph.getNodesByTag(tag);
  }

  // --------------------------------------------------------------------------
  // Advanced Querying
  // --------------------------------------------------------------------------

  /**
   * Run a compound query with optional pagination.
   * All filter fields are ANDed together.
   */
  query(filter: NodeQuery, pagination?: PaginationOptions): QueryResult {
    const result = this.graph.queryNodes(filter, pagination);
    return {
      nodes: result.items,
      total: result.total,
      hasMore: result.hasMore,
    };
  }

  /**
   * Search nodes by text similarity on summary fields.
   * Returns top-K most similar nodes.
   */
  search(query: string, topK?: number): readonly DecisionGraphNode[] {
    return this.graph.searchBySummary(query, topK);
  }

  /** Get the full derivation chain (all ancestors) for a node. */
  getDerivationChain(nodeId: string): readonly DecisionGraphNode[] {
    return this.graph.getDerivationChain(nodeId);
  }

  /** Get the immediate children of a node. */
  getChildren(nodeId: string): readonly DecisionGraphNode[] {
    return this.graph.getChildren(nodeId);
  }

  /** Get the version history for a node. */
  getHistory(nodeId: string): readonly NodeVersionEntry[] {
    return this.graph.getVersionHistory(nodeId);
  }

  /** Get a specific historical version of a node's content. */
  getAtVersion(nodeId: string, version: number): NodeVersionEntry | undefined {
    return this.graph.getNodeAtVersion(nodeId, version);
  }

  // --------------------------------------------------------------------------
  // Edge Operations
  // --------------------------------------------------------------------------

  /** Add a relationship edge between two nodes. */
  addEdge(from: string, to: string, relation: EdgeRelation): void {
    this.graph.addEdge(from, to, relation);
  }

  /** Get all edges originating from a node. */
  getEdgesFrom(nodeId: string): readonly import('./types.js').DecisionGraphEdge[] {
    return this.graph.getEdgesFrom(nodeId);
  }

  /** Get all edges pointing to a node. */
  getEdgesTo(nodeId: string): readonly import('./types.js').DecisionGraphEdge[] {
    return this.graph.getEdgesTo(nodeId);
  }

  // --------------------------------------------------------------------------
  // Graph Information
  // --------------------------------------------------------------------------

  /** Get aggregate statistics for the graph. */
  getStatistics(): GraphStatistics {
    return this.graph.getStatistics();
  }

  /** Get the current lifecycle state. */
  getLifecycle(): GraphLifecycle {
    return this.graph.getLifecycle();
  }

  /** Get total node count. */
  getNodeCount(): number {
    return this.graph.nodeCount;
  }

  /** Get the execution ID. */
  getExecutionId(): string {
    return this.graph.getExecutionId();
  }

  // --------------------------------------------------------------------------
  // Convenience: Context Summaries for Downstream Agents
  // --------------------------------------------------------------------------

  /**
   * Get a compact summary of all prior pass outputs.
   * Useful for building the context payload sent to agents.
   */
  getPriorPassSummaries(): readonly {
    type: DecisionNodeType;
    name: string;
    summary: string;
    pass: PassNumber;
    confidence: number;
    status: string;
  }[] {
    return this.readPriorPasses().map(node => ({
      type: node.type,
      name: node.name,
      summary: node.summary,
      pass: node.pass,
      confidence: node.confidence,
      status: node.status,
    }));
  }

  /**
   * Get all nodes of specific types from specific passes.
   * Common pattern: "give me all scenarios from Pass 2 and all architectures from Pass 3".
   */
  readMultiple(
    ...selectors: readonly { type: DecisionNodeType; pass?: PassNumber }[]
  ): readonly DecisionGraphNode[] {
    const results: DecisionGraphNode[] = [];
    for (const sel of selectors) {
      const nodes = this.graph.getNodesByType(sel.type);
      for (const node of nodes) {
        if (sel.pass === undefined || node.pass === sel.pass) {
          results.push(node);
        }
      }
    }
    return results;
  }
}

// ============================================================================
// Factory
// ============================================================================

/**
 * Create a DecisionGraphClient for a specific agent in a specific pass.
 * This is the recommended entry point for agents.
 */
export function createDecisionGraphClient(
  graph: DecisionGraph,
  agentRef: AgentRef,
  pass: PassNumber,
): DecisionGraphClient {
  return new DecisionGraphClient(graph, agentRef, pass);
}
