/**
 * Inspect Command
 *
 * SPARC Pseudocode Reference: §2.6
 *
 * FLOW:
 * 1. Parse arguments → CommandObject
 * 2. VALIDATE request against contract (MUST pass before network call)
 * 3. Retrieve simulation output via agentics-simulation-engine
 * 4. VALIDATE response has execution_metadata (reject if missing)
 * 5. Record audit entry
 * 6. Return SimulationOutputReference
 *
 * CONTRACT ENFORCEMENT:
 * - Request validation happens BEFORE any network call
 * - Response validation requires execution_metadata
 * - No bypass flags or soft-fail behavior
 */

import type {
  CommandOptions,
  SimulationOutputReference,
  SimulationReference,
  FlexibleInput,
  NaturalLanguageInput,
} from '../types/index.js';
import { isNaturalLanguage } from '../types/index.js';
import { SimulationEngineAdapter } from '../adapters/base-adapter.js';
import {
  createOrchestrationEngine,
  type OrchestrationStage,
} from '../modules/orchestration-engine.js';
import { createArtifactHandoff } from '../modules/artifact-handoff.js';
import { createAuditTrail } from '../audit/audit-trail.js';
import { failFast, toError } from '../errors/index.js';
import { loadEndpointConfig } from '../config/endpoints.js';
import {
  validateRequest,
  validateResponse,
  RequestSchemas,
  ResponseSchemas,
} from '../contracts/validator.js';
import type { InspectRequestContract } from '../contracts/validator.js';

// ============================================================================
// Command Interface
// ============================================================================

export interface InspectCommandInput {
  simRef: FlexibleInput<SimulationReference>;
  depth?: 'summary' | 'detailed' | 'full';
  includeMetrics?: boolean;
  includeTraces?: boolean;
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

  // Default depth
  const depth = input.depth ?? 'summary';

  // Define orchestration stages
  const stages: OrchestrationStage[] = [
    {
      name: 'retrieve-output',
      adapter: engineAdapter,
      request: {
        endpoint: '/v1/simulate',
        method: 'POST',
        buildBody: () => {
          let requestBody: InspectRequestContract;

          if (isNaturalLanguage(input.simRef)) {
            // ============================================================================
            // CONTRACT VALIDATION - Natural language format
            // ============================================================================
            requestBody = {
              sim_ref: {
                natural_language: (input.simRef as NaturalLanguageInput).description,
              },
              depth,
              include_metrics: input.includeMetrics,
              include_traces: input.includeTraces,
            };
          } else {
            // ============================================================================
            // CONTRACT VALIDATION - Structured reference format
            // ============================================================================
            const simRef = input.simRef as SimulationReference;
            requestBody = {
              sim_ref: {
                id: simRef.id,
                type: 'SimulationReference',
                repository: simRef.repository,
                created_at: simRef.created_at,
                checksum: simRef.checksum,
              },
              depth,
              include_metrics: input.includeMetrics,
              include_traces: input.includeTraces,
            };
          }

          // Validate request against contract BEFORE sending
          validateRequest<InspectRequestContract>(
            RequestSchemas.INSPECT,
            requestBody,
            correlationId
          );

          return requestBody;
        },
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

    // ============================================================================
    // RESPONSE VALIDATION - execution_metadata REQUIRED
    // ============================================================================

    const outputStage = result.stages.find(s => s.name === 'retrieve-output');
    const validatedOutput = validateResponse(
      ResponseSchemas.SIMULATION_OUTPUT,
      outputStage?.response,
      correlationId
    );

    const outputRef = handoff.extractReference(validatedOutput) as SimulationOutputReference;

    // Record audit entry
    const simRefId = isNaturalLanguage(input.simRef)
      ? `nl:${(input.simRef as NaturalLanguageInput).description.slice(0, 50)}`
      : (input.simRef as SimulationReference).id;
    audit.record({
      command: 'inspect',
      inputs: { simRef: simRefId, depth },
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
    const failedSimRefId = isNaturalLanguage(input.simRef)
      ? `nl:${(input.simRef as NaturalLanguageInput).description.slice(0, 50)}`
      : (input.simRef as SimulationReference).id;
    audit.record({
      command: 'inspect',
      inputs: { simRef: failedSimRefId, depth },
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
      upstreamError: toError(error),
      inputs: input,
      correlationId,
    });
  }
}
