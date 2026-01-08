/**
 * Export Command
 *
 * SPARC Pseudocode Reference: §2.4
 *
 * FLOW:
 * 1. Parse arguments → CommandObject
 * 2. VALIDATE request against contract (MUST pass before network call)
 * 3. Generate exports via agentics-deployment-exporters
 * 4. VALIDATE response has execution_metadata (reject if missing)
 * 5. Record audit entry
 * 6. Return ExportReference
 *
 * CONTRACT ENFORCEMENT:
 * - Request validation happens BEFORE any network call
 * - Response validation requires execution_metadata
 * - No bypass flags or soft-fail behavior
 */

import type {
  CommandOptions,
  ExportReference,
  IntentReference,
  ExportFormat,
  FlexibleInput,
  NaturalLanguageInput,
} from '../types/index.js';
import { isNaturalLanguage } from '../types/index.js';
import { ExportersAdapter } from '../adapters/base-adapter.js';
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
import type { ExportRequestContract } from '../contracts/validator.js';

// ============================================================================
// Command Interface
// ============================================================================

export interface ExportCommandInput {
  intentRef: FlexibleInput<IntentReference>;
  format: ExportFormat;
  outputPath?: string;
}

export interface ExportCommandResult {
  reference: ExportReference;
  timing: number;
}

// ============================================================================
// Export Command Implementation
// ============================================================================

export async function executeExportCommand(
  input: ExportCommandInput,
  options: CommandOptions
): Promise<ExportCommandResult> {
  const correlationId = options.trace_id ?? crypto.randomUUID();
  const startTime = Date.now();

  // Initialize components
  const engine = createOrchestrationEngine(correlationId);
  const handoff = createArtifactHandoff();
  const audit = createAuditTrail();

  // Create adapter
  const exportersConfig = loadEndpointConfig('agentics-deployment-exporters');
  const exportersAdapter = new ExportersAdapter(exportersConfig, correlationId);

  // Define orchestration stages
  const stages: OrchestrationStage[] = [
    {
      name: 'generate-export',
      adapter: exportersAdapter,
      request: {
        endpoint: '/v1/exporters',
        method: 'POST',
        buildBody: () => {
          let requestBody: ExportRequestContract;

          if (isNaturalLanguage(input.intentRef)) {
            // ============================================================================
            // CONTRACT VALIDATION - Natural language format
            // ============================================================================
            requestBody = {
              intent_ref: {
                natural_language: (input.intentRef as NaturalLanguageInput).description,
              },
              format_spec: {
                format: input.format,
                output_path: input.outputPath,
              },
            };
          } else {
            // ============================================================================
            // CONTRACT VALIDATION - Structured reference format
            // ============================================================================
            const intentRef = input.intentRef as IntentReference;
            requestBody = {
              intent_ref: {
                id: intentRef.id,
                type: 'IntentReference',
                repository: intentRef.repository,
                created_at: intentRef.created_at,
                checksum: intentRef.checksum,
              },
              format_spec: {
                format: input.format,
                output_path: input.outputPath,
              },
            };
          }

          // Validate request against contract BEFORE sending
          validateRequest<ExportRequestContract>(
            RequestSchemas.EXPORT,
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
      throw new Error(failedStage?.error?.message ?? 'Export generation failed');
    }

    // ============================================================================
    // RESPONSE VALIDATION - execution_metadata REQUIRED
    // ============================================================================

    const exportStage = result.stages.find(s => s.name === 'generate-export');
    const validatedExport = validateResponse(
      ResponseSchemas.EXPORT,
      exportStage?.response,
      correlationId
    );

    const exportRef = handoff.extractReference(validatedExport) as ExportReference;

    // Record audit entry
    const intentRefId = isNaturalLanguage(input.intentRef)
      ? `nl:${(input.intentRef as NaturalLanguageInput).description.slice(0, 50)}`
      : (input.intentRef as IntentReference).id;
    audit.record({
      command: 'export',
      inputs: { intentRef: intentRefId, format: input.format, outputPath: input.outputPath },
      outputs: exportRef,
      dependencies: [
        { service: 'agentics-deployment-exporters', method: 'generate', timestamp: new Date().toISOString(), duration_ms: result.timing.total, success: true },
      ],
      duration_ms: result.timing.total,
      status: 'SUCCESS',
      trace_id: correlationId,
    });

    return {
      reference: exportRef,
      timing: Date.now() - startTime,
    };
  } catch (error) {
    // Record failure in audit
    const failedIntentRefId = isNaturalLanguage(input.intentRef)
      ? `nl:${(input.intentRef as NaturalLanguageInput).description.slice(0, 50)}`
      : (input.intentRef as IntentReference).id;
    audit.record({
      command: 'export',
      inputs: { intentRef: failedIntentRefId, format: input.format },
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
      command: 'export',
      phase: 'generation',
      upstreamError: error instanceof Error ? error : new Error(String(error)),
      inputs: input,
      correlationId,
    });
  }
}
