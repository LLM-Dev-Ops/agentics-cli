/**
 * Plan Command
 *
 * SPARC Pseudocode Reference: §2.1
 *
 * FLOW:
 * 1. Parse arguments → CommandObject
 * 2. VALIDATE request against contract (MUST pass before network call)
 * 3. Select manifest via agentics-org-manifests
 * 4. Create plan via agentics-simulation-planner
 * 5. VALIDATE response has execution_metadata (reject if missing)
 * 6. Record audit entry
 * 7. Return PlanReference
 *
 * CONTRACT ENFORCEMENT:
 * - Request validation happens BEFORE any network call
 * - Response validation requires execution_metadata
 * - No bypass flags or soft-fail behavior
 */

import type {
  CommandOptions,
  PlanReference,
} from '../types/index.js';
import {
  ManifestsAdapter,
  PlannerAdapter,
} from '../adapters/base-adapter.js';
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
import type { PlanRequestContract, ManifestsRequestContract } from '../contracts/validator.js';

// ============================================================================
// Command Interface
// ============================================================================

export interface PlanCommandInput {
  manifestQuery: string;
  params?: Record<string, unknown>;
}

export interface PlanCommandResult {
  reference: PlanReference;
  timing: number;
}

// ============================================================================
// Plan Command Implementation
// ============================================================================

export async function executePlanCommand(
  input: PlanCommandInput,
  options: CommandOptions
): Promise<PlanCommandResult> {
  const correlationId = options.trace_id ?? crypto.randomUUID();
  const startTime = Date.now();

  // ============================================================================
  // CONTRACT VALIDATION - BEFORE ANY NETWORK CALL
  // ============================================================================

  // Validate the top-level plan request
  const validatedInput = validateRequest<PlanRequestContract>(
    RequestSchemas.PLAN,
    { query: input.manifestQuery, params: input.params },
    correlationId
  );

  // Initialize components
  const engine = createOrchestrationEngine(correlationId);
  const handoff = createArtifactHandoff();
  const audit = createAuditTrail();

  // Create adapters
  const manifestsConfig = loadEndpointConfig('agentics-org-manifests');
  const plannerConfig = loadEndpointConfig('agentics-simulation-planner');

  const manifestsAdapter = new ManifestsAdapter(manifestsConfig, correlationId);
  const plannerAdapter = new PlannerAdapter(plannerConfig, correlationId);

  // Define orchestration stages
  const stages: OrchestrationStage[] = [
    {
      name: 'select-manifest',
      adapter: manifestsAdapter,
      request: {
        endpoint: '/v1/manifests',
        method: 'POST',
        buildBody: () => {
          // Validate manifests request body before sending
          const manifestsRequest: ManifestsRequestContract = {
            query: validatedInput.query,
          };
          validateRequest<ManifestsRequestContract>(
            RequestSchemas.MANIFESTS,
            manifestsRequest,
            correlationId
          );
          return manifestsRequest;
        },
      },
    },
    {
      name: 'create-plan',
      adapter: plannerAdapter,
      request: {
        endpoint: '/v1/plans',
        method: 'POST',
        buildBody: (previousResults) => {
          const manifestResult = previousResults.get('select-manifest');

          // Validate manifest response has execution_metadata
          const validatedManifest = validateResponse(
            ResponseSchemas.MANIFEST,
            manifestResult,
            correlationId
          );

          const manifestRef = handoff.extractReference(validatedManifest);

          // Build and validate plans request
          // Include intent from user's input string
          const plansRequest = {
            manifest_ref: manifestRef,
            params: validatedInput.params ?? {},
            intent: validatedInput.query,
          };

          return plansRequest;
        },
      },
      dependsOn: ['select-manifest'],
    },
  ];

  try {
    // Execute orchestration
    const result = await engine.execute(stages, options);

    if (!result.success) {
      const failedStage = result.stages.find(s => s.status === 'failed');
      throw new Error(failedStage?.error?.message ?? 'Orchestration failed');
    }

    // ============================================================================
    // RESPONSE VALIDATION - execution_metadata REQUIRED
    // ============================================================================

    const planStage = result.stages.find(s => s.name === 'create-plan');
    const validatedPlan = validateResponse(
      ResponseSchemas.PLAN,
      planStage?.response,
      correlationId
    );

    const planRef = handoff.extractReference(validatedPlan) as PlanReference;

    // Record audit entry
    audit.record({
      command: 'plan',
      inputs: { manifestQuery: input.manifestQuery, params: input.params },
      outputs: planRef,
      dependencies: [
        { service: 'agentics-org-manifests', method: 'select', timestamp: new Date().toISOString(), duration_ms: result.timing.breakdown['select-manifest'] ?? 0, success: true },
        { service: 'agentics-simulation-planner', method: 'create', timestamp: new Date().toISOString(), duration_ms: result.timing.breakdown['create-plan'] ?? 0, success: true },
      ],
      duration_ms: result.timing.total,
      status: 'SUCCESS',
      trace_id: correlationId,
    });

    return {
      reference: planRef,
      timing: Date.now() - startTime,
    };
  } catch (error) {
    // Record failure in audit
    audit.record({
      command: 'plan',
      inputs: { manifestQuery: input.manifestQuery, params: input.params },
      outputs: null,
      dependencies: [],
      duration_ms: Date.now() - startTime,
      status: 'FAILED',
      error_code: error instanceof Error ? error.name : 'UNKNOWN',
      error_message: error instanceof Error ? error.message : 'Unknown error',
      trace_id: correlationId,
    });

    // Fail fast - propagate error
    failFast({
      command: 'plan',
      phase: 'orchestration',
      upstreamError: toError(error),
      inputs: input,
      correlationId,
    });
  }
}
