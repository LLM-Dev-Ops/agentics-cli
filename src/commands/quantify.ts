/**
 * Quantify Command
 *
 * SPARC Pseudocode Reference: §2.7
 *
 * FLOW:
 * 1. Parse arguments → CommandObject
 * 2. Generate ROI report via enterprise-roi-engine
 * 3. Record audit entry
 * 4. Return RoiReportReference
 *
 * PURPOSE: Generate CFO-grade financial impact summaries from completed simulations
 * The CLI does NOT perform financial calculations - delegates entirely to enterprise-roi-engine
 */

import type {
  CommandOptions,
  RoiReportReference,
  SimulationReference,
  RoiReportType,
  FlexibleInput,
  NaturalLanguageInput,
} from '../types/index.js';
import { isNaturalLanguage } from '../types/index.js';
import { RoiEngineAdapter } from '../adapters/base-adapter.js';
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

export interface QuantifyCommandInput {
  simRef: FlexibleInput<SimulationReference>;
  reportType?: RoiReportType;
  params?: Record<string, unknown>;
}

export interface QuantifyCommandResult {
  reference: RoiReportReference;
  timing: number;
}

// ============================================================================
// Quantify Command Implementation
// ============================================================================

export async function executeQuantifyCommand(
  input: QuantifyCommandInput,
  options: CommandOptions
): Promise<QuantifyCommandResult> {
  const correlationId = options.trace_id ?? crypto.randomUUID();
  const startTime = Date.now();

  // Initialize components
  const engine = createOrchestrationEngine(correlationId);
  const handoff = createArtifactHandoff();
  const audit = createAuditTrail();

  // Create adapter
  const roiConfig = loadEndpointConfig('enterprise-roi-engine');
  const roiAdapter = new RoiEngineAdapter(roiConfig, correlationId);

  // Default report type
  const reportType = input.reportType ?? 'cfo-grade';

  // Define orchestration stages
  const stages: OrchestrationStage[] = [
    {
      name: 'generate-roi-report',
      adapter: roiAdapter,
      request: {
        endpoint: '/v1/roi',
        method: 'POST',
        buildBody: () => ({
          // Pass natural language input or structured reference unchanged
          sim_ref: isNaturalLanguage(input.simRef)
            ? { natural_language: (input.simRef as NaturalLanguageInput).description }
            : handoff.passthrough(input.simRef as SimulationReference),
          report_type: reportType,
          params: input.params ?? {},
        }),
      },
    },
  ];

  try {
    // Execute orchestration
    const result = await engine.execute(stages, options);

    if (!result.success) {
      const failedStage = result.stages.find(s => s.status === 'failed');
      throw new Error(failedStage?.error?.message ?? 'ROI report generation failed');
    }

    // Extract ROI report reference
    const roiStage = result.stages.find(s => s.name === 'generate-roi-report');
    const roiRef = handoff.extractReference(roiStage?.response) as RoiReportReference;

    // Record audit entry
    const simRefId = isNaturalLanguage(input.simRef)
      ? `nl:${(input.simRef as NaturalLanguageInput).description.slice(0, 50)}`
      : (input.simRef as SimulationReference).id;
    audit.record({
      command: 'quantify',
      inputs: { simRef: simRefId, reportType, params: input.params },
      outputs: roiRef,
      dependencies: [
        { service: 'enterprise-roi-engine', method: 'generate', timestamp: new Date().toISOString(), duration_ms: result.timing.total, success: true },
      ],
      duration_ms: result.timing.total,
      status: 'SUCCESS',
      trace_id: correlationId,
    });

    return {
      reference: roiRef,
      timing: Date.now() - startTime,
    };
  } catch (error) {
    // Record failure in audit
    const failedSimRefId = isNaturalLanguage(input.simRef)
      ? `nl:${(input.simRef as NaturalLanguageInput).description.slice(0, 50)}`
      : (input.simRef as SimulationReference).id;
    audit.record({
      command: 'quantify',
      inputs: { simRef: failedSimRefId, reportType },
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
      command: 'quantify',
      phase: 'generation',
      upstreamError: error instanceof Error ? error : new Error(String(error)),
      inputs: input,
      correlationId,
    });
  }
}
