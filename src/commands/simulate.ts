/**
 * Simulate Command
 *
 * SPARC Pseudocode Reference: §2.2
 *
 * FLOW:
 * 1. Parse arguments → CommandObject
 * 2. Execute simulation via agentics-simulation-runner
 * 3. Record audit entry
 * 4. Return SimulationReference
 */

import type {
  CommandOptions,
  SimulationReference,
  PlanReference,
} from '../types/index.js';
import { RunnerAdapter } from '../adapters/base-adapter.js';
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

export interface SimulateCommandInput {
  planRef: PlanReference;
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

  // Create adapter
  const runnerConfig = loadEndpointConfig('agentics-simulation-runner');
  const runnerAdapter = new RunnerAdapter(runnerConfig, correlationId);

  // Define orchestration stages
  const stages: OrchestrationStage[] = [
    {
      name: 'execute-simulation',
      adapter: runnerAdapter,
      request: {
        endpoint: '/api/v1/simulations/execute',
        method: 'POST',
        buildBody: () => ({
          plan_ref: handoff.passthrough(input.planRef),
          config: input.config ?? {},
          iterations: input.iterations ?? 1,
        }),
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

    // Extract simulation reference
    const simStage = result.stages.find(s => s.name === 'execute-simulation');
    const simRef = handoff.extractReference(simStage?.response) as SimulationReference;

    // Record audit entry
    audit.record({
      command: 'simulate',
      inputs: { planRef: input.planRef.id, config: input.config, iterations: input.iterations },
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
    audit.record({
      command: 'simulate',
      inputs: { planRef: input.planRef.id, config: input.config },
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
