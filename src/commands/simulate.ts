/**
 * Simulate Command
 *
 * SPARC Pseudocode Reference: §2.2
 *
 * FLOW:
 * 1. Parse arguments → CommandObject
 * 2. VALIDATE request against contract (MUST pass before network call)
 * 3. Execute simulation via agentics-simulation-runner
 * 4. VALIDATE response has execution_metadata (reject if missing)
 * 5. Record audit entry
 * 6. Return SimulationReference
 *
 * CONTRACT ENFORCEMENT:
 * - Request validation happens BEFORE any network call
 * - Response validation requires execution_metadata
 * - No bypass flags or soft-fail behavior
 */

import type {
  CommandOptions,
  SimulationReference,
  PlanReference,
  FlexibleInput,
  NaturalLanguageInput,
} from '../types/index.js';
import { isNaturalLanguage } from '../types/index.js';
import { RunnerAdapter, SimulationEngineAdapter } from '../adapters/base-adapter.js';
import {
  createOrchestrationEngine,
  type OrchestrationStage,
} from '../modules/orchestration-engine.js';
import { createArtifactHandoff } from '../modules/artifact-handoff.js';
import { createAuditTrail } from '../audit/audit-trail.js';
import { failFast } from '../errors/index.js';
import { loadEndpointConfig } from '../config/endpoints.js';
import {
  validateRequest,
  validateResponse,
  RequestSchemas,
  ResponseSchemas,
} from '../contracts/validator.js';
import type { SimulateRequestContract } from '../contracts/validator.js';

// ============================================================================
// Command Interface
// ============================================================================

export interface SimulateCommandInput {
  planRef: FlexibleInput<PlanReference>;
  config?: Record<string, unknown>;
  iterations?: number;
}

export interface SimulateCommandResult {
  reference: SimulationReference;
  timing: number;
}

// ============================================================================
// Simulate Command Implementation
// ============================================================================

export async function executeSimulateCommand(
  input: SimulateCommandInput,
  options: CommandOptions
): Promise<SimulateCommandResult> {
  const correlationId = options.trace_id ?? crypto.randomUUID();
  const startTime = Date.now();

  // Initialize components
  const engine = createOrchestrationEngine(correlationId);
  const handoff = createArtifactHandoff();
  const audit = createAuditTrail();

  // Create adapter - use simulation engine for natural language, runner for structured refs
  const simulationConfig = loadEndpointConfig('agentics-simulation-engine');
  const runnerConfig = loadEndpointConfig('agentics-simulation-runner');

  // Choose adapter based on input type
  const useSimulationEngine = isNaturalLanguage(input.planRef);
  const adapter = useSimulationEngine
    ? new SimulationEngineAdapter(simulationConfig, correlationId)
    : new RunnerAdapter(runnerConfig, correlationId);

  // Select endpoint based on adapter type:
  // - SimulationEngine uses /v1/simulate for natural language scenarios
  // - Runner uses /v1/runner for structured plan references
  const endpoint = useSimulationEngine ? '/v1/simulate' : '/v1/runner';

  // Define orchestration stages
  const stages: OrchestrationStage[] = [
    {
      name: 'execute-simulation',
      adapter: adapter,
      request: {
        endpoint,
        method: 'POST',
        buildBody: () => {
          let requestBody: SimulateRequestContract;

          if (isNaturalLanguage(input.planRef)) {
            // ============================================================================
            // CONTRACT VALIDATION - Natural language scenario format
            // ============================================================================
            const scenarioId = `sim-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`;
            requestBody = {
              scenario: {
                id: scenarioId,
                name: 'CLI Simulation',
                description: (input.planRef as NaturalLanguageInput).description,
                tags: ['cli', 'enterprise'],
              },
              config: input.config ?? {},
              iterations: input.iterations ?? 1,
            };
          } else {
            // ============================================================================
            // CONTRACT VALIDATION - Structured plan reference format
            // ============================================================================
            const planRef = input.planRef as PlanReference;
            requestBody = {
              plan_ref: {
                id: planRef.id,
                type: 'PlanReference',
                repository: planRef.repository,
                created_at: planRef.created_at,
                checksum: planRef.checksum,
              },
              config: input.config ?? {},
              iterations: input.iterations ?? 1,
            };
          }

          // Validate request against contract BEFORE sending
          validateRequest<SimulateRequestContract>(
            RequestSchemas.SIMULATE,
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
      throw new Error(failedStage?.error?.message ?? 'Simulation failed');
    }

    // ============================================================================
    // RESPONSE VALIDATION - execution_metadata REQUIRED
    // ============================================================================

    const simStage = result.stages.find(s => s.name === 'execute-simulation');
    const validatedSimulation = validateResponse(
      ResponseSchemas.SIMULATION,
      simStage?.response,
      correlationId
    );

    const simRef = handoff.extractReference(validatedSimulation) as SimulationReference;

    // Record audit entry
    const planRefId = isNaturalLanguage(input.planRef)
      ? `nl:${(input.planRef as NaturalLanguageInput).description.slice(0, 50)}`
      : (input.planRef as PlanReference).id;
    audit.record({
      command: 'simulate',
      inputs: { planRef: planRefId, config: input.config, iterations: input.iterations },
      outputs: simRef,
      dependencies: [
        { service: 'agentics-simulation-runner', method: 'execute', timestamp: new Date().toISOString(), duration_ms: result.timing.total, success: true },
      ],
      duration_ms: result.timing.total,
      status: 'SUCCESS',
      trace_id: correlationId,
    });

    return {
      reference: simRef,
      timing: Date.now() - startTime,
    };
  } catch (error) {
    // Record failure in audit
    const failedPlanRefId = isNaturalLanguage(input.planRef)
      ? `nl:${(input.planRef as NaturalLanguageInput).description.slice(0, 50)}`
      : (input.planRef as PlanReference).id;
    audit.record({
      command: 'simulate',
      inputs: { planRef: failedPlanRefId, config: input.config },
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
      command: 'simulate',
      phase: 'execution',
      upstreamError: error instanceof Error ? error : new Error(String(error)),
      inputs: input,
      correlationId,
    });
  }
}
