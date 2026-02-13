/**
 * Canonical Contract Bridge
 *
 * AUTHORITY: agentics-contracts is the SOLE schema authority.
 * CLI MUST NOT define its own schema copies.
 *
 * This module re-exports canonical types and provides runtime
 * validation functions using the contract schemas.
 */

// ============================================================================
// Canonical Type Imports from agentics-contracts
// ============================================================================

// Import canonical schemas — agentics-contracts is the single source of truth.
// If this import fails, the CLI cannot operate. This is intentional.
import type {
  ExecutionContext,
  SimulationRequest,
  ResultPacket,
  ExecutionGraph,
} from 'agentics-contracts';

export type { ExecutionContext, SimulationRequest, ResultPacket, ExecutionGraph };

// ============================================================================
// Canonical JSON Schemas for AJV Runtime Validation
// ============================================================================

/**
 * execution_context schema — every request to downstream services
 * MUST include a valid execution context.
 */
export const executionContextSchema = {
  type: 'object',
  properties: {
    execution_id: { type: 'string', minLength: 1 },
    parent_span_id: { type: 'string', minLength: 1 },
    simulation_resolution: { type: 'string', minLength: 1 },
    repo_name: { type: 'string', minLength: 1 },
  },
  required: ['execution_id', 'parent_span_id', 'simulation_resolution', 'repo_name'],
  additionalProperties: true,
} as const;

/**
 * result_packet schema — every response from results-index
 * MUST conform to this shape.
 */
export const resultPacketSchema = {
  type: 'object',
  properties: {
    execution_id: { type: 'string' },
    status: { type: 'string' },
    environment: { type: 'string' },
    created_at: { type: 'string' },
    completed_at: { type: 'string' },
    duration_ms: { type: 'number' },
    execution_metadata: {
      type: 'object',
      properties: {
        trace_id: { type: 'string' },
        timestamp: { type: 'string' },
        service: { type: 'string' },
      },
      required: ['trace_id', 'timestamp', 'service'],
    },
    execution_graph: { type: 'object' },
  },
  required: ['execution_id', 'status', 'created_at', 'execution_metadata'],
  additionalProperties: true,
} as const;

/**
 * execution_graph schema — validates graph structure in responses.
 */
export const executionGraphSchema = {
  type: 'object',
  properties: {
    graph_id: { type: 'string' },
    root_node: { type: 'string', const: 'ruvector-service' },
    nodes: { type: 'array', minItems: 1 },
    edges: { type: 'array' },
    created_at: { type: 'string' },
  },
  required: ['graph_id', 'root_node', 'nodes', 'created_at'],
  additionalProperties: true,
} as const;

/**
 * simulation_request schema — validates outbound simulation payloads.
 */
export const simulationRequestSchema = {
  type: 'object',
  properties: {
    execution_context: executionContextSchema,
    scenario: { type: 'object' },
    plan_ref: { type: 'object' },
    config: { type: 'object' },
    iterations: { type: 'integer', minimum: 1 },
  },
  required: ['execution_context'],
  additionalProperties: true,
} as const;

// ============================================================================
// Runtime Validation Functions
// ============================================================================

import { CLIError } from '../errors/index.js';

/**
 * Validate that an execution context contains all required fields.
 * Throws immediately if any required field is missing.
 * Do NOT create implicit defaults for simulation_resolution.
 */
export function validateExecutionContext(
  ctx: Record<string, unknown>,
  correlationId?: string,
): void {
  const required = ['execution_id', 'parent_span_id', 'simulation_resolution', 'repo_name'] as const;
  const missing: string[] = [];

  for (const field of required) {
    const value = ctx[field];
    if (value === undefined || value === null || (typeof value === 'string' && value.trim() === '')) {
      missing.push(field);
    }
  }

  if (missing.length > 0) {
    throw new CLIError({
      code: 'ECLI-CONTRACT-CTX-001',
      category: 'INPUT_ERROR',
      message: `Execution context missing required fields: ${missing.join(', ')}`,
      details: {
        missing_fields: missing,
        provided: Object.keys(ctx),
      },
      module: 'contracts',
      correlationId,
      recoverable: false,
      exitCode: 100,
    });
  }
}

/**
 * Validate that a result packet from results-index conforms to the canonical schema.
 * Throws if required contract fields are missing.
 */
export function validateResultPacket(
  data: unknown,
  correlationId?: string,
): void {
  if (!data || typeof data !== 'object') {
    throw new CLIError({
      code: 'ECLI-CONTRACT-RES-002',
      category: 'DOWNSTREAM_ERROR',
      message: 'Result packet is not an object',
      details: { received_type: typeof data },
      module: 'contracts',
      correlationId,
      recoverable: false,
      exitCode: 140,
    });
  }

  const obj = data as Record<string, unknown>;
  const required = ['execution_id', 'status', 'created_at', 'execution_metadata'] as const;
  const missing: string[] = [];

  for (const field of required) {
    if (obj[field] === undefined || obj[field] === null) {
      missing.push(field);
    }
  }

  if (missing.length > 0) {
    throw new CLIError({
      code: 'ECLI-CONTRACT-RES-003',
      category: 'DOWNSTREAM_ERROR',
      message: `Result packet missing required contract fields: ${missing.join(', ')}`,
      details: {
        missing_fields: missing,
        received_fields: Object.keys(obj),
      },
      module: 'contracts',
      correlationId,
      recoverable: false,
      exitCode: 140,
    });
  }

  // Validate execution_metadata sub-fields
  const meta = obj['execution_metadata'];
  if (typeof meta !== 'object' || meta === null) {
    throw new CLIError({
      code: 'ECLI-CONTRACT-RES-004',
      category: 'DOWNSTREAM_ERROR',
      message: 'Result packet execution_metadata is not an object',
      details: { received_type: typeof meta },
      module: 'contracts',
      correlationId,
      recoverable: false,
      exitCode: 140,
    });
  }

  const metaObj = meta as Record<string, unknown>;
  const metaRequired = ['trace_id', 'timestamp', 'service'] as const;
  const metaMissing: string[] = [];

  for (const field of metaRequired) {
    if (typeof metaObj[field] !== 'string') {
      metaMissing.push(field);
    }
  }

  if (metaMissing.length > 0) {
    throw new CLIError({
      code: 'ECLI-CONTRACT-RES-005',
      category: 'DOWNSTREAM_ERROR',
      message: `Result packet execution_metadata missing required fields: ${metaMissing.join(', ')}`,
      details: {
        missing_fields: metaMissing,
        received_fields: Object.keys(metaObj),
      },
      module: 'contracts',
      correlationId,
      recoverable: false,
      exitCode: 140,
    });
  }
}
