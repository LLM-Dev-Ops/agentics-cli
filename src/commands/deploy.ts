/**
 * Deploy Command
 *
 * SPARC Pseudocode Reference: §2.3
 *
 * FLOW:
 * 1. Parse arguments → CommandObject
 * 2. VALIDATE request against contract (MUST pass before network call)
 * 3. Resolve intent via agentics-deployment-intent
 * 4. VALIDATE response has execution_metadata (reject if missing)
 * 5. Record audit entry
 * 6. Return IntentReference
 *
 * CONTRACT ENFORCEMENT:
 * - Request validation happens BEFORE any network call
 * - Response validation requires execution_metadata
 * - No bypass flags or soft-fail behavior
 */

import type {
  CommandOptions,
  IntentReference,
  SimulationReference,
  FlexibleInput,
  NaturalLanguageInput,
} from '../types/index.js';
import { isNaturalLanguage } from '../types/index.js';
import { IntentAdapter } from '../adapters/base-adapter.js';
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
import type { DeployRequestContract } from '../contracts/validator.js';

// ============================================================================
// Command Interface
// ============================================================================

export interface DeployCommandInput {
  simRef: FlexibleInput<SimulationReference>;
  environment?: 'development' | 'staging' | 'production';
  approvalRequired?: boolean;
  dryRun?: boolean;
  rollbackOnFailure?: boolean;
}

export interface DeployCommandResult {
  reference: IntentReference;
  timing: number;
}

// ============================================================================
// Deploy Command Implementation
// ============================================================================

export async function executeDeployCommand(
  input: DeployCommandInput,
  options: CommandOptions
): Promise<DeployCommandResult> {
  const correlationId = options.trace_id ?? crypto.randomUUID();
  const startTime = Date.now();

  // Initialize components
  const engine = createOrchestrationEngine(correlationId);
  const handoff = createArtifactHandoff();
  const audit = createAuditTrail();

  // Create adapter
  const intentConfig = loadEndpointConfig('agentics-deployment-intent');
  const intentAdapter = new IntentAdapter(intentConfig, correlationId);

  // Define orchestration stages
  const stages: OrchestrationStage[] = [
    {
      name: 'resolve-intent',
      adapter: intentAdapter,
      request: {
        endpoint: '/v1/intent',
        method: 'POST',
        buildBody: () => {
          let requestBody: DeployRequestContract;

          if (isNaturalLanguage(input.simRef)) {
            // ============================================================================
            // CONTRACT VALIDATION - Natural language format
            // ============================================================================
            requestBody = {
              sim_ref: {
                natural_language: (input.simRef as NaturalLanguageInput).description,
              },
              environment: input.environment,
              approval_required: input.approvalRequired,
              dry_run: input.dryRun,
              rollback_on_failure: input.rollbackOnFailure,
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
              environment: input.environment,
              approval_required: input.approvalRequired,
              dry_run: input.dryRun,
              rollback_on_failure: input.rollbackOnFailure,
            };
          }

          // Validate request against contract BEFORE sending
          validateRequest<DeployRequestContract>(
            RequestSchemas.DEPLOY,
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
      throw new Error(failedStage?.error?.message ?? 'Deployment intent resolution failed');
    }

    // ============================================================================
    // RESPONSE VALIDATION - execution_metadata REQUIRED
    // ============================================================================

    const intentStage = result.stages.find(s => s.name === 'resolve-intent');
    const validatedIntent = validateResponse(
      ResponseSchemas.INTENT,
      intentStage?.response,
      correlationId
    );

    const intentRef = handoff.extractReference(validatedIntent) as IntentReference;

    // Record audit entry
    const simRefId = isNaturalLanguage(input.simRef)
      ? `nl:${(input.simRef as NaturalLanguageInput).description.slice(0, 50)}`
      : (input.simRef as SimulationReference).id;
    audit.record({
      command: 'deploy',
      inputs: { simRef: simRefId, environment: input.environment },
      outputs: intentRef,
      dependencies: [
        { service: 'agentics-deployment-intent', method: 'resolve', timestamp: new Date().toISOString(), duration_ms: result.timing.total, success: true },
      ],
      duration_ms: result.timing.total,
      status: 'SUCCESS',
      trace_id: correlationId,
    });

    return {
      reference: intentRef,
      timing: Date.now() - startTime,
    };
  } catch (error) {
    // Record failure in audit
    const failedSimRefId = isNaturalLanguage(input.simRef)
      ? `nl:${(input.simRef as NaturalLanguageInput).description.slice(0, 50)}`
      : (input.simRef as SimulationReference).id;
    audit.record({
      command: 'deploy',
      inputs: { simRef: failedSimRefId },
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
      command: 'deploy',
      phase: 'intent-resolution',
      upstreamError: toError(error),
      inputs: input,
      correlationId,
    });
  }
}
