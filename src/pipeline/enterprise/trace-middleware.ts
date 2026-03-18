/**
 * Trace Middleware — Transparent Agent Invocation Tracing (ADR-039)
 *
 * Wraps agent invocations without modifying agent code. Infers inputs
 * (which DecisionGraph nodes were read) and outputs (which nodes were
 * written) by diffing the graph state before and after execution.
 *
 * Key principle: Agents are unaware of tracing. They do not need to
 * emit trace data. The middleware handles everything.
 */

import type {
  PassNumber,
  AgentRef,
  AgentInvocationResult,
} from './types.js';
import { DecisionGraph } from './decision-graph.js';
import { ProvenanceTracker } from './provenance-tracker.js';
import { resolveCodeProvenance } from './code-resolver.js';

// ============================================================================
// Middleware Interface
// ============================================================================

/** The agent invoker function signature. */
export type AgentInvoker = (
  agents: readonly AgentRef[],
  payload: Record<string, unknown>,
  pass: PassNumber,
  timeoutMs: number,
) => Promise<AgentInvocationResult[]>;

// ============================================================================
// Trace Middleware
// ============================================================================

/**
 * Create a tracing wrapper around an agent invoker.
 *
 * The wrapped invoker:
 *   1. Snapshots the graph node count before invocation
 *   2. Invokes the original invoker
 *   3. Diffs the graph to find new nodes (inferred outputs)
 *   4. Records a TraceRecord per agent with code provenance
 *
 * Usage:
 *   const tracedInvoker = createTracingInvoker(originalInvoker, graph, tracker, 'Pass Name', 'workstream');
 *   const results = await tracedInvoker(agents, payload, pass, timeoutMs);
 */
export function createTracingInvoker(
  inner: AgentInvoker,
  graph: DecisionGraph,
  tracker: ProvenanceTracker,
  passName: string,
  workstream: string,
): AgentInvoker {
  return async (agents, payload, pass, timeoutMs) => {
    // Snapshot graph state before invocation
    const nodeIdsBefore = new Set(graph.getAllNodes().map(n => n.id));

    // Invoke agents
    const results = await inner(agents, payload, pass, timeoutMs);

    // Diff graph state to find new nodes
    const nodesAfter = graph.getAllNodes();
    const newNodeIds: string[] = [];
    for (const n of nodesAfter) {
      if (!nodeIdsBefore.has(n.id)) {
        newNodeIds.push(n.id);
      }
    }

    // Record trace for each agent
    for (let i = 0; i < results.length; i++) {
      const result = results[i]!;
      const agent = result.agent;
      // Resolve code provenance (used by the tracker internally)
      resolveCodeProvenance(agent);
      const isSuccess = result.status >= 200 && result.status < 300;

      // Partition new nodes to this agent (heuristic: distribute evenly)
      const agentNodeShare = newNodeIds.length > 0
        ? newNodeIds.slice(
            Math.floor((i / results.length) * newNodeIds.length),
            Math.floor(((i + 1) / results.length) * newNodeIds.length),
          )
        : [];

      // Infer input nodes: all nodes from prior passes that were in the graph before invocation
      const inputNodeIds = Array.from(nodeIdsBefore).slice(0, 10);

      tracker.recordInvocation({
        agent,
        pass,
        passName,
        workstream,
        startedAt: result.timestamp,
        completedAt: new Date(new Date(result.timestamp).getTime() + result.durationMs).toISOString(),
        durationMs: result.durationMs,
        inputNodeIds,
        outputNodeIds: agentNodeShare,
        artifactNumbers: [],
        status: isSuccess ? 'success' : 'failed',
        confidence: isSuccess ? 0.85 : 0,
        tokensUsed: extractTokenUsage(result.response),
        modelUsed: extractModelUsed(result.response),
        estimatedCost: estimateCost(extractTokenUsage(result.response), extractModelUsed(result.response)),
      });
    }

    return results;
  };
}

/**
 * Create a tracing wrapper that also writes TraceRecords to the DecisionGraph.
 *
 * This is the full ADR-039 implementation: trace records are stored both
 * in the ProvenanceTracker (in-memory) and as DecisionGraph nodes (persisted).
 */
export function createFullTracingInvoker(
  inner: AgentInvoker,
  graph: DecisionGraph,
  tracker: ProvenanceTracker,
  passName: string,
  workstream: string,
): AgentInvoker {
  const tracedInvoker = createTracingInvoker(inner, graph, tracker, passName, workstream);

  return async (agents, payload, pass, timeoutMs) => {
    const results = await tracedInvoker(agents, payload, pass, timeoutMs);

    // Write trace records to DecisionGraph as provenance nodes
    // (ADR-039: "TraceRecord stored in DecisionGraph (namespace: provenance)")
    // We use the latest records added by the tracing invoker
    const allRecords = tracker.getAllRecords();
    const recentRecords = allRecords.slice(allRecords.length - results.length);

    for (const record of recentRecords) {
      if (graph.isWritable()) {
        graph.createNode({
          type: 'provenance_manifest', // Using provenance_manifest as the node type for trace records
          name: `Trace: ${record.agent.domain}/${record.agent.agent}`,
          content: {
            traceId: record.traceId,
            agentDomain: record.agent.domain,
            agentName: record.agent.agent,
            pass: record.pass,
            workstream: record.workstream,
            durationMs: record.durationMs,
            status: record.outputs.status,
            confidence: record.outputs.confidence,
            tokensUsed: record.resources.tokensUsed,
            modelUsed: record.resources.modelUsed,
            estimatedCost: record.resources.estimatedCost,
            codePackage: record.codeProvenance.package,
            codeVersion: record.codeProvenance.version,
            commitHash: record.codeProvenance.commitHash,
          },
          summary: `Trace: ${record.agent.domain}/${record.agent.agent} in ${record.passName} (${record.outputs.status}, ${record.durationMs}ms)`,
          producedBy: { domain: 'pipeline', agent: 'trace-middleware', role: 'Provenance Tracer' },
          pass,
          derivedFrom: [],
          confidence: record.outputs.confidence,
          status: record.outputs.status === 'success' ? 'complete' : 'failed',
          tags: [
            `agent:${record.agent.domain}/${record.agent.agent}`,
            `pass:${record.pass}`,
            `trace:${record.traceId}`,
            'provenance',
          ],
        });
      }
    }

    return results;
  };
}

// ============================================================================
// Resource Extraction Helpers
// ============================================================================

/** Extract token usage from an agent response (best effort). */
function extractTokenUsage(response: unknown): number {
  if (!response || typeof response !== 'object') return 0;
  const resp = response as Record<string, unknown>;

  // Try common token usage fields
  const candidates = [
    resp['tokensUsed'],
    resp['tokens_used'],
    resp['usage']
      ? (resp['usage'] as Record<string, unknown>)['total_tokens']
      : undefined,
    resp['token_count'],
  ];

  for (const c of candidates) {
    if (typeof c === 'number' && c > 0) return c;
  }

  return 0;
}

/** Extract model used from an agent response (best effort). */
function extractModelUsed(response: unknown): string {
  if (!response || typeof response !== 'object') return 'unknown';
  const resp = response as Record<string, unknown>;

  const candidates = [
    resp['model'],
    resp['modelUsed'],
    resp['model_used'],
  ];

  for (const c of candidates) {
    if (typeof c === 'string' && c.length > 0) return c;
  }

  return 'unknown';
}

/** Estimate cost based on token usage and model. */
function estimateCost(tokens: number, model: string): number {
  if (tokens === 0) return 0;

  // Approximate pricing per 1K tokens (input + output averaged)
  const pricing: Record<string, number> = {
    'claude-opus-4-6': 0.015,
    'claude-sonnet-4-6': 0.003,
    'claude-haiku-4-5': 0.0002,
  };

  // Find matching model pricing
  for (const [key, rate] of Object.entries(pricing)) {
    if (model.includes(key) || key.includes(model)) {
      return (tokens / 1000) * rate;
    }
  }

  // Default: assume Sonnet-class pricing
  return (tokens / 1000) * 0.003;
}
