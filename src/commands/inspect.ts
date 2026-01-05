/**
 * Inspect Command
 *
 * SPARC Pseudocode Reference: §2.6
 *
 * FLOW:
 * 1. Parse arguments → CommandObject
 * 2. Retrieve simulation output via agentics-simulation-engine
 * 3. Record audit entry
 * 4. Return SimulationOutputReference
 *
 * PURPOSE: Retrieve deterministic simulation outputs from completed simulations
 * The CLI does NOT interpret or transform outputs - passthrough only
 */

import type {
  CommandOptions,
  SimulationOutputReference,
  SimulationReference,
  SimulationOutputType,
} from '../types/index.js';
import { SimulationEngineAdapter } from '../adapters/base-adapter.js';
import {
  createOrchestrationEngine,
  type OrchestrationStage,
} from '../modules/orchestration-engine.js';
import { createArtifactHandoff } from '../modules/artifact-handoff.js';
import { createAuditTrail } from '../audit/audit-trail.js';
import { failFast } from '../errors/index.js';
import { loadEndpointConfig } from '../config/endpoints.js';

// ============================================================================
// Command Interface
// ============================================================================

export interface InspectCommandInput {
  simRef: SimulationReference;
  outputType?: SimulationOutputType;
}

export interface InspectCommandResult {
  reference: SimulationOutputReference;
  timing: number;
}

// ============================================================================
// Inspect Command Implementation
// ============================================================================

export async function executeInspectCommand(
  input: InspectCommandInput,
  options: CommandOptions
): Promise<InspectCommandResult> {
  const correlationId = options.trace_id ?? crypto.randomUUID();
  const startTime = Date.now();

  // Initialize components
  const engine = createOrchestrationEngine(correlationId);
  const handoff = createArtifactHandoff();
  const audit = createAuditTrail();

  // Create adapter
  const engineConfig = loadEndpointConfig('agentics-simulation-engine');
  const engineAdapter = new SimulationEngineAdapter(engineConfig, correlationId);

  // Default output type
  const outputType = input.outputType ?? 'summary';

  // Define orchestration stages
  const stages: OrchestrationStage[] = [
    {
      name: 'retrieve-output',
      adapter: engineAdapter,
      request: {
        endpoint: '/api/v1/outputs/retrieve',
        method: 'POST',
        buildBody: () => ({
          sim_ref: handoff.passthrough(input.simRef),
          output_type: outputType,
        }),
      },
    },
  ];

  try {
    // Execute orchestration
    const result = await engine.execute(stages, options);

    if (!result.success) {
      const failedStage = result.stages.find(s => s.status === 'failed');
      throw new Error(failedStage?.error?.message ?? 'Output retrieval failed');
    }

    // Extract output reference
    const outputStage = result.stages.find(s => s.name === 'retrieve-output');
    const outputRef = handoff.extractReference(outputStage?.response) as SimulationOutputReference;

    // Record audit entry
    audit.record({
      command: 'inspect',
      inputs: { simRef: input.simRef.id, outputType },
      outputs: outputRef,
      dependencies: [
        { service: 'agentics-simulation-engine', method: 'retrieve', timestamp: new Date().toISOString(), duration_ms: result.timing.total, success: true },
      ],
      duration_ms: result.timing.total,
      status: 'SUCCESS',
      trace_id: correlationId,
    });

    return {
      reference: outputRef,
      timing: Date.now() - startTime,
    };
  } catch (error) {
    // Record failure in audit
    audit.record({
      command: 'inspect',
      inputs: { simRef: input.simRef.id, outputType },
      outputs: null,
      dependencies: [],
      duration_ms: Date.now() - startTime,
      status: 'FAILED',
      error_code: error instanceof Error ? error.name : 'UNKNOWN',
      error_message: error instanceof Error ? error.message : 'Unknown error',
      trace_id: correlationId,
    });

    // Fail fast
    failFast({
      command: 'inspect',
      phase: 'retrieval',
      upstreamError: error instanceof Error ? error : new Error(String(error)),
      inputs: input,
      correlationId,
    });
  }
}
