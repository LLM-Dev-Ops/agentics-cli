/**
 * Diligence Command
 *
 * SPARC Pseudocode Reference: §2.5
 *
 * FLOW:
 * 1. Parse arguments → CommandObject
 * 2. VALIDATE request against contract (MUST pass before network call)
 * 3. Package artifacts via diligence-artifacts
 * 4. VALIDATE response has execution_metadata (reject if missing)
 * 5. Record audit entry
 * 6. Return DiligencePackageReference
 *
 * CONTRACT ENFORCEMENT:
 * - Request validation happens BEFORE any network call
 * - Response validation requires execution_metadata
 * - No bypass flags or soft-fail behavior
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
import { failFast, toError } from '../errors/index.js';
import { loadEndpointConfig } from '../config/endpoints.js';
import {
  validateRequest,
  validateResponse,
  RequestSchemas,
  ResponseSchemas,
} from '../contracts/validator.js';
import type { DiligenceRequestContract } from '../contracts/validator.js';

// ============================================================================
// Command Interface
// ============================================================================

export interface DiligenceCommandInput {
  refs: FlexibleInput<BaseReference[]>;
  frameworks: ComplianceFramework[];
  includeEvidence?: boolean;
  certifyingAuthority?: string;
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
        endpoint: '/v1/diligence',
        method: 'POST',
        buildBody: () => {
          let requestBody: DiligenceRequestContract;

          if (isNaturalLanguage(input.refs)) {
            // ============================================================================
            // CONTRACT: Natural language → construct refs from description
            // Service expects refs[].type in: simulation, plan, report, assessment
            // Service expects frameworks in: soc2, gdpr, hipaa, iso27001, pci_dss, nist, fedramp
            // ============================================================================
            const desc = (input.refs as NaturalLanguageInput).description;
            requestBody = {
              refs: [{ id: desc, type: 'assessment' }],
              frameworks: input.frameworks.map(f => f.toLowerCase()),
            };
          } else {
            // ============================================================================
            // CONTRACT: Structured reference format
            // Service expects refs[].type in: simulation, plan, report, assessment
            // ============================================================================
            const refs = input.refs as BaseReference[];
            requestBody = {
              refs: refs.map(ref => ({
                id: ref.id,
                type: (ref.type ?? 'simulation').toLowerCase(),
              })),
              frameworks: input.frameworks.map(f => f.toLowerCase()),
            };
          }

          // Validate request against contract BEFORE sending
          validateRequest<DiligenceRequestContract>(
            RequestSchemas.DILIGENCE,
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
      throw new Error(failedStage?.error?.message ?? 'Diligence packaging failed');
    }

    // ============================================================================
    // RESPONSE VALIDATION - execution_metadata REQUIRED
    // ============================================================================

    const diligenceStage = result.stages.find(s => s.name === 'package-diligence');
    const validatedDiligence = validateResponse(
      ResponseSchemas.DILIGENCE_PACKAGE,
      diligenceStage?.response,
      correlationId
    );

    const diligenceRef = handoff.extractReference(validatedDiligence) as DiligencePackageReference;

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
      upstreamError: toError(error),
      inputs: input,
      correlationId,
    });
  }
}
