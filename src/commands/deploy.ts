/**
 * Deploy Command
 *
 * SPARC Pseudocode Reference: §2.3
 *
 * FLOW:
 * 1. Parse arguments → CommandObject
 * 2. Resolve intent via agentics-deployment-intent
 * 3. Record audit entry
 * 4. Return IntentReference
 */

import type {
  CommandOptions,
  IntentReference,
  SimulationReference,
} from '../types/index.js';
import { IntentAdapter } from '../adapters/base-adapter.js';
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

export interface DeployCommandInput {
  simRef: SimulationReference;
  spec?: Record<string, unknown>;
  environment?: string;
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
        endpoint: '/api/v1/intents/resolve',
        method: 'POST',
        buildBody: () => ({
          sim_ref: handoff.passthrough(input.simRef),
          spec: input.spec ?? {},
          environment: input.environment ?? 'default',
        }),
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

    // Extract intent reference
    const intentStage = result.stages.find(s => s.name === 'resolve-intent');
    const intentRef = handoff.extractReference(intentStage?.response) as IntentReference;

    // Record audit entry
    audit.record({
      command: 'deploy',
      inputs: { simRef: input.simRef.id, spec: input.spec, environment: input.environment },
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
    audit.record({
      command: 'deploy',
      inputs: { simRef: input.simRef.id, spec: input.spec },
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
      upstreamError: error instanceof Error ? error : new Error(String(error)),
      inputs: input,
      correlationId,
    });
  }
}
