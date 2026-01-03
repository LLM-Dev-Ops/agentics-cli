/**
 * Export Command
 *
 * SPARC Pseudocode Reference: §2.4
 *
 * FLOW:
 * 1. Parse arguments → CommandObject
 * 2. Generate exports via agentics-deployment-exporters
 * 3. Record audit entry
 * 4. Return ExportReference
 */

import type {
  CommandOptions,
  ExportReference,
  IntentReference,
  ExportFormat,
} from '../types/index.js';
import { ExportersAdapter } from '../adapters/base-adapter.js';
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

export interface ExportCommandInput {
  intentRef: IntentReference;
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
        endpoint: '/api/v1/exports/generate',
        method: 'POST',
        buildBody: () => ({
          intent_ref: handoff.passthrough(input.intentRef),
          format_spec: {
            format: input.format,
            output_path: input.outputPath,
          },
        }),
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

    // Extract export reference
    const exportStage = result.stages.find(s => s.name === 'generate-export');
    const exportRef = handoff.extractReference(exportStage?.response) as ExportReference;

    // Record audit entry
    audit.record({
      command: 'export',
      inputs: { intentRef: input.intentRef.id, format: input.format, outputPath: input.outputPath },
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
    audit.record({
      command: 'export',
      inputs: { intentRef: input.intentRef.id, format: input.format },
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
