/**
 * Quantify Command
 *
 * SPARC Pseudocode Reference: §2.7
 *
 * FLOW:
 * 1. Parse arguments → CommandObject
 * 2. VALIDATE request against contract (MUST pass before network call)
 * 3. Generate ROI report via enterprise-roi-engine
 * 4. VALIDATE response has execution_metadata (reject if missing)
 * 5. Record audit entry
 * 6. Return RoiReportReference
 *
 * CONTRACT ENFORCEMENT:
 * - Request validation happens BEFORE any network call
 * - Response validation requires execution_metadata
 * - No bypass flags or soft-fail behavior
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
import { failFast, toError } from '../errors/index.js';
import { loadEndpointConfig } from '../config/endpoints.js';
import {
  validateRequest,
  validateResponse,
  RequestSchemas,
  ResponseSchemas,
} from '../contracts/validator.js';
import type { QuantifyRequestContract } from '../contracts/validator.js';

// ============================================================================
// Command Interface
// ============================================================================

export interface QuantifyCommandInput {
  simRef: FlexibleInput<SimulationReference>;
  reportType?: RoiReportType;
  timeHorizon?: 'quarterly' | 'annual' | '3-year' | '5-year';
  currency?: string;
  discountRate?: number;
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
        buildBody: () => {
          let requestBody: QuantifyRequestContract;

          if (isNaturalLanguage(input.simRef)) {
            // ============================================================================
            // CONTRACT VALIDATION - Natural language format
            // ============================================================================
            requestBody = {
              sim_ref: {
                natural_language: (input.simRef as NaturalLanguageInput).description,
              },
              report_type: reportType,
              time_horizon: input.timeHorizon,
              currency: input.currency,
              discount_rate: input.discountRate,
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
              report_type: reportType,
              time_horizon: input.timeHorizon,
              currency: input.currency,
              discount_rate: input.discountRate,
            };
          }

          // Validate request against contract BEFORE sending
          validateRequest<QuantifyRequestContract>(
            RequestSchemas.QUANTIFY,
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
      throw new Error(failedStage?.error?.message ?? 'ROI report generation failed');
    }

    // ============================================================================
    // RESPONSE VALIDATION - execution_metadata REQUIRED
    // ============================================================================

    const roiStage = result.stages.find(s => s.name === 'generate-roi-report');
    const validatedRoi = validateResponse(
      ResponseSchemas.ROI_REPORT,
      roiStage?.response,
      correlationId
    );

    const roiRef = handoff.extractReference(validatedRoi) as RoiReportReference;

    // Record audit entry
    const simRefId = isNaturalLanguage(input.simRef)
      ? `nl:${(input.simRef as NaturalLanguageInput).description.slice(0, 50)}`
      : (input.simRef as SimulationReference).id;
    audit.record({
      command: 'quantify',
      inputs: { simRef: simRefId, reportType },
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
      upstreamError: toError(error),
      inputs: input,
      correlationId,
    });
  }
}
