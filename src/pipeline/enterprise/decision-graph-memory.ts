/**
 * DecisionGraph Memory Backend — AgentDB Integration (ADR-033)
 *
 * Syncs DecisionGraph nodes to the AgentDB memory system using the
 * claude-flow CLI. Each node is stored as a memory entry with:
 *   - Key: decisiongraph:{execution_id}:{node_id}
 *   - Namespace: decisiongraph
 *   - Tags: node type, pass number, agent name
 *
 * This module provides:
 *   - Push: sync graph nodes to AgentDB
 *   - Pull: retrieve nodes from AgentDB into a graph
 *   - Search: semantic vector search via AgentDB HNSW
 *   - CLI query bridge: format queries for npx @claude-flow/cli
 *
 * Per ADR-033: "The DecisionGraph is stored in the existing AgentDB
 * memory system with HNSW indexing."
 */

import { execSync } from 'node:child_process';
import type {
  DecisionGraphNode,
  DecisionNodeType,
  PassNumber,
} from './types.js';
import { DecisionGraph } from './decision-graph.js';

// ============================================================================
// Constants
// ============================================================================

const NAMESPACE = 'decisiongraph';
const CLI_CMD = 'npx @claude-flow/cli@latest';

// ============================================================================
// Key Format
// ============================================================================

/**
 * Generate the canonical AgentDB memory key for a node.
 * Format: decisiongraph:{execution_id}:{node_id}
 */
export function memoryKey(executionId: string, nodeId: string): string {
  return `${NAMESPACE}:${executionId}:${nodeId}`;
}

/**
 * Generate tags for a node's memory entry.
 * Includes: type, pass, agent domain, agent name, execution.
 */
export function memoryTags(node: DecisionGraphNode, executionId: string): readonly string[] {
  return [
    `type:${node.type}`,
    `pass:${node.pass}`,
    `domain:${node.producedBy.domain}`,
    `agent:${node.producedBy.agent}`,
    `execution:${executionId}`,
    `status:${node.status}`,
  ];
}

// ============================================================================
// Push — Sync Graph to AgentDB
// ============================================================================

/** Result of a push operation. */
export interface PushResult {
  readonly nodesStored: number;
  readonly nodesFailed: number;
  readonly errors: readonly string[];
}

/**
 * Push all nodes from a DecisionGraph to AgentDB memory.
 * Uses the claude-flow CLI `memory store` command.
 *
 * @param graph - The graph to push.
 * @param options - Push options.
 * @returns Push result with counts and any errors.
 */
export function pushToMemory(
  graph: DecisionGraph,
  options?: { readonly verbose?: boolean; readonly timeoutMs?: number },
): PushResult {
  const executionId = graph.getExecutionId();
  const nodes = graph.getAllNodes();
  let stored = 0;
  let failed = 0;
  const errors: string[] = [];
  const timeout = options?.timeoutMs ?? 10_000;

  for (const node of nodes) {
    const key = memoryKey(executionId, node.id);
    const tags = memoryTags(node, executionId);
    const value = JSON.stringify({
      ...node,
      _memoryKey: key,
      _namespace: NAMESPACE,
    });

    try {
      const tagsArg = tags.join(',');
      execSync(
        `${CLI_CMD} memory store --key "${key}" --value '${escapeSingleQuotes(value)}' --namespace ${NAMESPACE} --tags "${tagsArg}"`,
        { encoding: 'utf-8', timeout, stdio: 'pipe' },
      );
      stored++;
      if (options?.verbose) {
        console.error(`  [AgentDB] Stored: ${key}`);
      }
    } catch (err) {
      failed++;
      const message = err instanceof Error ? err.message : String(err);
      errors.push(`Failed to store ${key}: ${message}`);
      if (options?.verbose) {
        console.error(`  [AgentDB] Failed: ${key} — ${message}`);
      }
    }
  }

  return { nodesStored: stored, nodesFailed: failed, errors };
}

// ============================================================================
// Pull — Retrieve Nodes from AgentDB
// ============================================================================

/** Result of a pull operation. */
export interface PullResult {
  readonly nodesRetrieved: number;
  readonly nodesFailed: number;
  readonly errors: readonly string[];
}

/**
 * Pull nodes from AgentDB memory into a DecisionGraph.
 * Lists all entries in the decisiongraph namespace for the execution ID.
 *
 * @param executionId - The execution ID to pull nodes for.
 * @param outputDir - Output directory for the graph.
 * @param options - Pull options.
 * @returns A new DecisionGraph populated from AgentDB.
 */
export function pullFromMemory(
  executionId: string,
  outputDir: string,
  options?: { readonly verbose?: boolean; readonly timeoutMs?: number },
): { graph: DecisionGraph; result: PullResult } {
  const graph = new DecisionGraph(executionId, outputDir);
  const timeout = options?.timeoutMs ?? 10_000;
  let retrieved = 0;
  let failed = 0;
  const errors: string[] = [];

  try {
    const raw = execSync(
      `${CLI_CMD} memory list --namespace ${NAMESPACE} --limit 1000`,
      { encoding: 'utf-8', timeout, stdio: 'pipe' },
    );

    // Parse the output (may be JSON or newline-delimited)
    const entries = parseMemoryListOutput(raw, executionId);

    for (const entry of entries) {
      try {
        const nodeData = JSON.parse(entry.value) as DecisionGraphNode;
        graph.addNode(nodeData);
        retrieved++;
      } catch (err) {
        failed++;
        errors.push(`Failed to parse node: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    errors.push(`Failed to list memory entries: ${message}`);
  }

  return { graph, result: { nodesRetrieved: retrieved, nodesFailed: failed, errors } };
}

// ============================================================================
// Search — Semantic Search via AgentDB HNSW
// ============================================================================

/** Result of a semantic search. */
export interface SearchResult {
  readonly nodes: readonly DecisionGraphNode[];
  readonly query: string;
  readonly errors: readonly string[];
}

/**
 * Search for nodes by semantic similarity using AgentDB HNSW indexing.
 * The query is matched against node summaries.
 *
 * @param query - Natural language search query.
 * @param executionId - Scope search to a specific execution (optional).
 * @param options - Search options.
 */
export function searchMemory(
  query: string,
  executionId?: string,
  options?: { readonly limit?: number; readonly timeoutMs?: number },
): SearchResult {
  const limit = options?.limit ?? 10;
  const timeout = options?.timeoutMs ?? 10_000;
  const errors: string[] = [];
  const nodes: DecisionGraphNode[] = [];

  try {
    let cmd = `${CLI_CMD} memory search --query "${escapeDQ(query)}" --namespace ${NAMESPACE} --limit ${limit}`;
    if (executionId) {
      cmd += ` --tags "execution:${executionId}"`;
    }

    const raw = execSync(cmd, { encoding: 'utf-8', timeout, stdio: 'pipe' });
    const entries = parseMemorySearchOutput(raw);

    for (const entry of entries) {
      try {
        const nodeData = JSON.parse(entry) as DecisionGraphNode;
        nodes.push(nodeData);
      } catch {
        // Skip unparseable entries
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    errors.push(`Search failed: ${message}`);
  }

  return { nodes, query, errors };
}

// ============================================================================
// CLI Query Bridge — Format Queries for claude-flow CLI
// ============================================================================

/**
 * Generate a CLI command string for querying the DecisionGraph via
 * the claude-flow memory system. Does NOT execute — returns the command.
 *
 * Per ADR-033's querying section.
 */
export function buildMemoryQuery(params: {
  action: 'list' | 'search' | 'retrieve';
  executionId?: string;
  nodeId?: string;
  type?: DecisionNodeType;
  pass?: PassNumber;
  query?: string;
  limit?: number;
}): string {
  switch (params.action) {
    case 'list': {
      let cmd = `${CLI_CMD} memory list --namespace ${NAMESPACE}`;
      const tags: string[] = [];
      if (params.executionId) tags.push(`execution:${params.executionId}`);
      if (params.type) tags.push(`type:${params.type}`);
      if (params.pass !== undefined) tags.push(`pass:${params.pass}`);
      if (tags.length > 0) cmd += ` --tags "${tags.join(',')}"`;
      if (params.limit) cmd += ` --limit ${params.limit}`;
      return cmd;
    }

    case 'search': {
      if (!params.query) throw new Error('Query parameter is required for search');
      let cmd = `${CLI_CMD} memory search --query "${escapeDQ(params.query)}" --namespace ${NAMESPACE}`;
      if (params.executionId) cmd += ` --tags "execution:${params.executionId}"`;
      if (params.type) cmd += ` --tags "type:${params.type}"`;
      if (params.limit) cmd += ` --limit ${params.limit}`;
      return cmd;
    }

    case 'retrieve': {
      if (!params.executionId || !params.nodeId) {
        throw new Error('Both executionId and nodeId are required for retrieve');
      }
      const key = memoryKey(params.executionId, params.nodeId);
      return `${CLI_CMD} memory retrieve --key "${key}" --namespace ${NAMESPACE}`;
    }

    default:
      throw new Error(`Unknown action: ${params.action as string}`);
  }
}

// ============================================================================
// Output Parsers (best-effort for CLI output)
// ============================================================================

interface MemoryEntry {
  key: string;
  value: string;
}

/** Parse `memory list` CLI output into key-value entries. */
function parseMemoryListOutput(raw: string, executionId: string): MemoryEntry[] {
  const entries: MemoryEntry[] = [];
  const prefix = `${NAMESPACE}:${executionId}:`;

  // Try JSON array first
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      for (const item of parsed) {
        if (typeof item === 'object' && item !== null) {
          const key = String(item.key ?? '');
          const value = typeof item.value === 'string' ? item.value : JSON.stringify(item.value ?? item);
          if (key.startsWith(prefix) || !executionId) {
            entries.push({ key, value });
          }
        }
      }
      return entries;
    }
  } catch {
    // Not JSON — try line-based parsing
  }

  // Line-based: each line might be a key or JSON object
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith(prefix) || trimmed.startsWith('{')) {
      try {
        const parsed = JSON.parse(trimmed);
        entries.push({
          key: String(parsed.key ?? ''),
          value: typeof parsed.value === 'string' ? parsed.value : JSON.stringify(parsed),
        });
      } catch {
        // Skip non-parseable lines
      }
    }
  }

  return entries;
}

/** Parse `memory search` CLI output into value strings. */
function parseMemorySearchOutput(raw: string): string[] {
  const results: string[] = [];

  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      for (const item of parsed) {
        const value = typeof item === 'string' ? item
          : typeof item.value === 'string' ? item.value
          : JSON.stringify(item);
        results.push(value);
      }
      return results;
    }
  } catch {
    // Not JSON
  }

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed && trimmed.startsWith('{')) {
      results.push(trimmed);
    }
  }

  return results;
}

// ============================================================================
// String Helpers
// ============================================================================

function escapeSingleQuotes(s: string): string {
  return s.replace(/'/g, "'\\''");
}

function escapeDQ(s: string): string {
  return s.replace(/"/g, '\\"');
}
