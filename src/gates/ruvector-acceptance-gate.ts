/**
 * Ruvector Acceptance Gate — Gate 8 (Mandatory Blocking Persistence)
 *
 * PURPOSE: Ensure every enterprise simulation blocks until ruvector-service
 * accepts the execution. No fallback, no best-effort.
 *
 * INVARIANTS ENFORCED:
 * - ADR-004 Invariant 1: Every simulation has a memory footprint
 * - Ruvector acceptance is BLOCKING, not best-effort
 * - Failure to persist to ruvector is a COMMAND FAILURE, not a warning
 *
 * EXIT CODE: 141 (RUVECTOR_ACCEPTANCE_FAILED)
 *
 * FORBIDDEN:
 * - try/catch swallowing of ruvector errors
 * - Fallback to local-only persistence
 * - Warning-level logging for persistence failures
 * - Proceeding without ruvector acceptance
 */

import { RuvectorAdapter } from '../adapters/base-adapter.js';
import { loadEndpointConfig } from '../config/endpoints.js';
import { CLIError } from '../errors/index.js';
import type {
  RuvectorRootedGraph,
  RuvectorAcceptanceResult,
  ExecutionSpan,
  DownstreamSpanDescriptor,
} from '../types/index.js';

// ============================================================================
// Constants
// ============================================================================

export const RUVECTOR_ACCEPTANCE_EXIT_CODE = 141;

// ============================================================================
// Blocking Acceptance Functions
// ============================================================================

/**
 * Block until ruvector-service accepts the simulation memory record.
 * NO fallback. NO best-effort. Failure throws CLIError.
 *
 * @throws CLIError (ECLI-RUVECTOR-001) if ruvector rejects or is unavailable
 */
export async function blockUntilRuvectorAccepts(
  simulationId: string,
  memoryRecord: {
    id: string;
    type: 'simulation';
    intent: string;
    intent_description: string;
    status: string;
    result?: unknown;
    attribution: { created_by: string; org_id: string };
    artifact_ids: string[];
    created_at: string;
    updated_at: string;
    checksum: string;
  },
  correlationId: string,
): Promise<RuvectorAcceptanceResult> {
  const startTime = Date.now();
  const ruvectorSpanId = `ruvector-span-${crypto.randomUUID()}`;

  const ruvectorConfig = loadEndpointConfig('ruvector-service');
  const adapter = new RuvectorAdapter(ruvectorConfig, correlationId);

  try {
    await adapter.storeSimulation(memoryRecord);
  } catch (error) {
    // Diagnostic: log full error + payload shape for ruvector debugging
    const errMsg = error instanceof Error ? error.message : String(error);
    console.error(`  [RUVECTOR-GATE] Acceptance failed: ${errMsg}`);
    console.error(`  [RUVECTOR-GATE] Payload keys: ${Object.keys(memoryRecord).join(', ')}`);
    console.error(`  [RUVECTOR-GATE] Intent length: ${memoryRecord.intent?.length ?? 0}, attribution: ${JSON.stringify(memoryRecord.attribution)}`);

    // NO swallowing. Wrap with gate-specific context and re-throw.
    throw new CLIError({
      code: 'ECLI-RUVECTOR-001',
      category: 'DOWNSTREAM_ERROR',
      message: `Ruvector acceptance failed for simulation ${simulationId}: ${error instanceof Error ? error.message : String(error)}`,
      details: {
        simulation_id: simulationId,
        gate: 'ruvector-acceptance',
        invariant: 'ADR-004 Invariant 1',
      },
      module: 'ruvector-gate',
      correlationId,
      recoverable: false,
      exitCode: RUVECTOR_ACCEPTANCE_EXIT_CODE,
      cause: error instanceof Error ? error : undefined,
    });
  }

  const timing = Date.now() - startTime;
  const now = new Date().toISOString();

  const rootSpan: ExecutionSpan = {
    span_id: ruvectorSpanId,
    parent_span_id: null,
    service: 'ruvector-service',
    operation: 'accept-simulation',
    status: 'completed',
    started_at: new Date(startTime).toISOString(),
    completed_at: now,
    duration_ms: timing,
    children: [],
  };

  const graph: RuvectorRootedGraph = {
    graph_id: `graph-${crypto.randomUUID()}`,
    root: rootSpan,
    total_spans: 1,
    created_at: now,
  };

  return {
    accepted: true,
    ruvector_span_id: ruvectorSpanId,
    graph,
    timing_ms: timing,
  };
}

/**
 * Block until ruvector-service accepts a lineage record.
 * NO fallback. NO best-effort. Failure throws CLIError.
 *
 * @throws CLIError (ECLI-RUVECTOR-002) if ruvector rejects or is unavailable
 */
export async function blockUntilLineageAccepted(
  lineageRecord: {
    id: string;
    artifact_id: string;
    artifact_category: string;
    simulation_id: string;
    plan_id?: string;
    decision_context: string;
    attribution: { created_by: string; org_id: string };
    governance: { gate_pipeline_version: string; synthesis_classification: string };
    created_at: string;
  },
  correlationId: string,
): Promise<void> {
  const ruvectorConfig = loadEndpointConfig('ruvector-service');
  const adapter = new RuvectorAdapter(ruvectorConfig, correlationId);

  try {
    await adapter.storeLineage(lineageRecord);
  } catch (error) {
    throw new CLIError({
      code: 'ECLI-RUVECTOR-002',
      category: 'DOWNSTREAM_ERROR',
      message: `Ruvector acceptance failed for lineage ${lineageRecord.id}: ${error instanceof Error ? error.message : String(error)}`,
      details: {
        lineage_id: lineageRecord.id,
        simulation_id: lineageRecord.simulation_id,
        gate: 'ruvector-acceptance',
        invariant: 'ADR-004 Invariant 2',
      },
      module: 'ruvector-gate',
      correlationId,
      recoverable: false,
      exitCode: RUVECTOR_ACCEPTANCE_EXIT_CODE,
      cause: error instanceof Error ? error : undefined,
    });
  }
}

// ============================================================================
// Graph Construction
// ============================================================================

/**
 * Build a ruvector-rooted execution graph from downstream span descriptors.
 * ruvector-service is ALWAYS the root node.
 */
export function buildRuvectorRootedGraph(
  ruvectorSpanId: string,
  downstreamSpans: DownstreamSpanDescriptor[],
): RuvectorRootedGraph {
  const now = new Date().toISOString();

  function descriptorToSpan(
    descriptor: DownstreamSpanDescriptor,
    parentSpanId: string,
  ): ExecutionSpan {
    const spanId = `span-${crypto.randomUUID()}`;
    const children = (descriptor.children ?? []).map(child =>
      descriptorToSpan(child, spanId),
    );
    return {
      span_id: spanId,
      parent_span_id: parentSpanId,
      service: descriptor.service,
      operation: descriptor.operation,
      status: descriptor.status,
      started_at: descriptor.started_at,
      completed_at: descriptor.completed_at,
      duration_ms: descriptor.duration_ms,
      children,
    };
  }

  const childSpans = downstreamSpans.map(d => descriptorToSpan(d, ruvectorSpanId));

  const root: ExecutionSpan = {
    span_id: ruvectorSpanId,
    parent_span_id: null,
    service: 'ruvector-service',
    operation: 'accept-simulation',
    status: 'completed',
    started_at: now,
    completed_at: now,
    duration_ms: 0,
    children: childSpans,
  };

  function countSpans(span: ExecutionSpan): number {
    return 1 + span.children.reduce((sum, child) => sum + countSpans(child), 0);
  }

  return {
    graph_id: `graph-${crypto.randomUUID()}`,
    root,
    total_spans: countSpans(root),
    created_at: now,
  };
}

// ============================================================================
// Graph Validation
// ============================================================================

/**
 * Validate that an execution graph has ruvector-service as its root.
 * Throws CLIError if the root is not ruvector-service.
 *
 * @throws CLIError (ECLI-RUVECTOR-003) if root is not ruvector-service
 */
export function validateRuvectorRootedGraph(graph: RuvectorRootedGraph): void {
  if (graph.root.service !== 'ruvector-service') {
    throw new CLIError({
      code: 'ECLI-RUVECTOR-003',
      category: 'INTERNAL_ERROR',
      message: `Execution graph root is not ruvector-service (actual: ${graph.root.service})`,
      details: {
        graph_id: graph.graph_id,
        actual_root: graph.root.service,
        expected_root: 'ruvector-service',
      },
      module: 'ruvector-gate',
      recoverable: false,
      exitCode: RUVECTOR_ACCEPTANCE_EXIT_CODE,
    });
  }
}
