/**
 * Diligence Command
 *
 * SPARC Pseudocode Reference: §2.5
 *
 * FLOW:
 * 1. Parse arguments → CommandObject
 * 2. Package artifacts via diligence-artifacts
 * 3. Record audit entry
 * 4. Return DiligencePackageReference
 */

import type {
  CommandOptions,
  DiligencePackageReference,
  BaseReference,
  ComplianceFramework,
  FlexibleInput,
  NaturalLanguageInput,
} from '../types/index.js';
import { isNaturalLanguage } from '../types/index.js';
import { DiligenceAdapter } from '../adapters/base-adapter.js';
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

export interface DiligenceCommandInput {
  refs: FlexibleInput<BaseReference[]>;
  frameworks: ComplianceFramework[];
  requirements?: Record<string, unknown>;
}

export interface DiligenceCommandResult {
  reference: DiligencePackageReference;
  timing: number;
}

// ============================================================================
// Diligence Command Implementation
// ============================================================================

export async function executeDiligenceCommand(
  input: DiligenceCommandInput,
  options: CommandOptions
): Promise<DiligenceCommandResult> {
  const correlationId = options.trace_id ?? crypto.randomUUID();
  const startTime = Date.now();

  // Initialize components
  const engine = createOrchestrationEngine(correlationId);
  const handoff = createArtifactHandoff();
  const audit = createAuditTrail();

  // Create adapter
  const diligenceConfig = loadEndpointConfig('diligence-artifacts');
  const diligenceAdapter = new DiligenceAdapter(diligenceConfig, correlationId);

  // Define orchestration stages
  const stages: OrchestrationStage[] = [
    {
      name: 'package-diligence',
      adapter: diligenceAdapter,
      request: {
        endpoint: '/api/v1/diligence/package',
        method: 'POST',
        buildBody: () => ({
          // Pass natural language input or structured references unchanged
          refs: isNaturalLanguage(input.refs)
            ? { natural_language: (input.refs as NaturalLanguageInput).description }
            : (input.refs as BaseReference[]).map(ref => handoff.passthrough(ref)),
          frameworks: input.frameworks,
          requirements: input.requirements ?? {},
        }),
      },
    },
  ];

  try {
    // Execute orchestration
    const result = await engine.execute(stages, options);

    if (!result.success) {
      const failedStage = result.stages.find(s => s.status === 'failed');
      throw new Error(failedStage?.error?.message ?? 'Diligence packaging failed');
    }

    // Extract diligence package reference
    const diligenceStage = result.stages.find(s => s.name === 'package-diligence');
    const diligenceRef = handoff.extractReference(diligenceStage?.response) as DiligencePackageReference;

    // Record audit entry
    const refsId = isNaturalLanguage(input.refs)
      ? `nl:${(input.refs as NaturalLanguageInput).description.slice(0, 50)}`
      : (input.refs as BaseReference[]).map(r => r.id);
    audit.record({
      command: 'diligence',
      inputs: { refs: refsId, frameworks: input.frameworks },
      outputs: diligenceRef,
      dependencies: [
        { service: 'diligence-artifacts', method: 'package', timestamp: new Date().toISOString(), duration_ms: result.timing.total, success: true },
      ],
      duration_ms: result.timing.total,
      status: 'SUCCESS',
      trace_id: correlationId,
    });

    return {
      reference: diligenceRef,
      timing: Date.now() - startTime,
    };
  } catch (error) {
    // Record failure in audit
    const failedRefsId = isNaturalLanguage(input.refs)
      ? `nl:${(input.refs as NaturalLanguageInput).description.slice(0, 50)}`
      : (input.refs as BaseReference[]).map(r => r.id);
    audit.record({
      command: 'diligence',
      inputs: { refs: failedRefsId, frameworks: input.frameworks },
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
      command: 'diligence',
      phase: 'packaging',
      upstreamError: error instanceof Error ? error : new Error(String(error)),
      inputs: input,
      correlationId,
    });
  }
}
