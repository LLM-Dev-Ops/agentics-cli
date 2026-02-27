/**
 * Phase 4 Pipeline -- Stage 8: Metadata Augmentor
 *
 * Augments existing Phase 2 Architecture Decision Records (ADRs) with
 * Phase 4 runtime decisions covering database engine selection, IAM
 * strategy, deployment target, and ERP integration pattern.
 *
 * Reads the Phase 2 ADR index from disk, appends runtime ADRs, and
 * writes two output files:
 *   - augmented-adrs.json  (all ADRs: Phase 2 originals + Phase 4 runtime)
 *   - runtime-decisions.json  (Phase 4 runtime decisions only)
 *
 * Exports:
 *   - augmentMetadata(context) -- pipeline entry point
 *
 * Error codes:
 *   ECLI-P4-080  Missing prerequisite stage output (erp-target-resolution)
 *   ECLI-P4-081  ADR index load failure
 *   ECLI-P4-082  Metadata file write failure
 */

import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  Phase4Context,
  Phase4StageOutput,
  MetadataAugmentOutput,
  RuntimeDecision,
  ERPResolution,
} from '../types.js';
import { createSpan, endSpan, emitSpan } from '../../phase2/telemetry.js';

// ============================================================================
// Constants
// ============================================================================

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

// ============================================================================
// Runtime Decision Builders
// ============================================================================

/**
 * Build RT-001: Database engine selection.
 */
function buildRT001(erpResolution: ERPResolution): RuntimeDecision {
  const engine = erpResolution.databaseEngine ?? 'none (api-only)';
  const dialect = erpResolution.sqlDialect ?? 'N/A';
  return {
    id: 'RT-001',
    title: 'Database engine selection',
    context:
      `ERP system "${erpResolution.erpSystem}" was detected as the integration target ` +
      `(confidence ${(erpResolution.confidence * 100).toFixed(0)}%, ` +
      `source: ${erpResolution.detectionSource}). ` +
      `The database engine must be authoritative for the ERP vendor's preferred storage layer.`,
    decision:
      `Use ${engine} (SQL dialect: ${dialect}) as the primary persistence engine ` +
      `for all bounded-context repositories.`,
    rationale:
      `Authoritative ERP-to-database mapping: ${erpResolution.erpSystem} → ${engine}. ` +
      `Direct vendor database access avoids additional sync layers and reduces latency. ` +
      `Constraints imposed by ERP system: ${erpResolution.constraints.join('; ') || 'none recorded'}.`,
  };
}

/**
 * Build RT-002: IAM strategy.
 */
function buildRT002(): RuntimeDecision {
  return {
    id: 'RT-002',
    title: 'IAM strategy',
    context:
      'Cloud Run services need a secure, auditable identity mechanism for ' +
      'service-to-service calls and ERP surface access.',
    decision:
      'Use GCP service account identity tokens (OIDC) acquired from the instance ' +
      'metadata server for all outbound service calls.',
    rationale:
      'Cloud Run natively supports Workload Identity Federation and service account ' +
      'impersonation without storing long-lived credentials in environment variables. ' +
      'Identity tokens are short-lived (1 hour), automatically rotated, and fully ' +
      'auditable via Cloud Audit Logs.',
  };
}

/**
 * Build RT-003: Deployment target.
 */
function buildRT003(): RuntimeDecision {
  return {
    id: 'RT-003',
    title: 'Deployment target',
    context:
      'The MVP must be deployable with minimal infrastructure overhead while ' +
      'supporting autoscaling to zero and per-request IAM scoping.',
    decision:
      'Deploy as a stateless Cloud Run service (Knative Serving) with ' +
      'minScale=0 and maxScale=10, bound to an IAM service account.',
    rationale:
      'Cloud Run scales to zero when idle (eliminates idle compute cost), ' +
      'supports Cloud Build native CI/CD, and isolates each service revision ' +
      'under its own service account identity. Stateless design aligns with ' +
      'the DDD command/query separation implemented in the domain layer.',
  };
}

/**
 * Build RT-004: ERP integration pattern.
 */
function buildRT004(erpResolution: ERPResolution): RuntimeDecision {
  const integrationPoints = erpResolution.integrationPoints.join(', ') || 'general ERP surface';
  return {
    id: 'RT-004',
    title: 'ERP integration pattern',
    context:
      `The domain layer must communicate with ${erpResolution.erpSystem} ` +
      `for the following integration points: ${integrationPoints}. ` +
      `Direct ERP calls from domain code would violate the hexagonal architecture boundary.`,
    decision:
      'Use an adapter chain: domain → infrastructure adapter → erp-client → ' +
      'ERP surface Cloud Function → ERP system. ' +
      'No direct ERP SDK imports in domain or application layers.',
    rationale:
      'The adapter chain enforces the hexagonal architecture principle: domain code ' +
      'depends only on port interfaces, infrastructure adapters implement those ports, ' +
      'and the erp-client encapsulates all ERP surface HTTP calls with retry and circuit ' +
      'breaker resilience. This isolates ERP vendor lock-in to the erp-client module and ' +
      'enables independent testing of each layer via mock substitution.',
  };
}

// ============================================================================
// ADR Index Loading
// ============================================================================

/**
 * Attempt to load the Phase 2 ADR index from disk.
 * Returns an empty array if the file does not exist or cannot be parsed.
 */
function loadPhase2Adrs(phase2Dir: string): unknown[] {
  const adrIndexPath = join(phase2Dir, 'adrs', 'adr-index.json');
  try {
    const raw = readFileSync(adrIndexPath, { encoding: 'utf-8' });
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed;
    }
    // Some implementations wrap the array in an object
    if (typeof parsed === 'object' && parsed !== null && 'adrs' in parsed) {
      const wrapped = parsed as { adrs: unknown };
      if (Array.isArray(wrapped.adrs)) {
        return wrapped.adrs;
      }
    }
    return [];
  } catch {
    // ADR index may not exist in all pipeline runs; treat as empty
    return [];
  }
}

// ============================================================================
// File Writing
// ============================================================================

/**
 * Write a metadata file as formatted JSON to disk.
 */
function writeMetadataFile(absPath: string, data: unknown): void {
  const dir = absPath.substring(0, absPath.lastIndexOf('/'));
  mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  const content = JSON.stringify(data, null, 2) + '\n';
  try {
    writeFileSync(absPath, content, { encoding: 'utf-8', mode: FILE_MODE });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`ECLI-P4-082: Failed to write metadata file ${absPath}: ${message}`);
  }
}

// ============================================================================
// Public: Pipeline Entry Point
// ============================================================================

/**
 * Stage 8 entry point: augment Phase 2 ADRs with Phase 4 runtime decisions.
 *
 * Reads ERPResolution from context.stageOutputs.get('erp-target-resolution'),
 * loads the Phase 2 ADR index from context.phase2Dir/adrs/adr-index.json,
 * appends four runtime decisions, and writes two JSON files to
 * phase4/metadata/.
 *
 * @param context - The Phase 4 pipeline context
 * @returns Stage output describing success or failure
 */
export function augmentMetadata(context: Phase4Context): Phase4StageOutput {
  const startTime = Date.now();
  const rootSpan = createSpan('metadata-augmentation', 'augment-metadata', {
    phase4Dir: context.phase4Dir,
    phase2Dir: context.phase2Dir,
    traceId: context.traceId,
  });

  try {
    // Verify ERP target resolution completed
    const erpStage = context.stageOutputs.get('erp-target-resolution');
    if (!erpStage || erpStage.status !== 'completed') {
      throw new Error(
        'ECLI-P4-080: ERP target resolution not available on context. ' +
        'Ensure the erp-target-resolution stage completed successfully before running metadata-augmentation.',
      );
    }
    const erpResolution = erpStage.data as ERPResolution;

    // Build four runtime decisions
    const runtimeDecisions: RuntimeDecision[] = [
      buildRT001(erpResolution),
      buildRT002(),
      buildRT003(),
      buildRT004(erpResolution),
    ];

    // Load Phase 2 ADR index from disk
    const loadSpan = createSpan(
      'metadata-augmentation',
      'load-phase2-adrs',
      { phase2Dir: context.phase2Dir },
      rootSpan.spanId,
    );

    const phase2Adrs = loadPhase2Adrs(context.phase2Dir);

    const finalLoadSpan = endSpan(loadSpan, 'ok', { adrCount: phase2Adrs.length });
    emitSpan(finalLoadSpan);

    // Merge: original Phase 2 ADRs + runtime decisions
    const augmentedAdrs = [...phase2Adrs, ...runtimeDecisions];

    // Output directory: phase4/metadata/
    const metadataDir = join(context.phase4Dir, 'metadata');
    mkdirSync(metadataDir, { recursive: true, mode: DIR_MODE });

    const writtenPaths: string[] = [];

    const writeSpan = createSpan(
      'metadata-augmentation',
      'write-metadata-files',
      { metadataDir },
      rootSpan.spanId,
    );

    // augmented-adrs.json
    const augmentedAdrsPath = join(metadataDir, 'augmented-adrs.json');
    writeMetadataFile(augmentedAdrsPath, augmentedAdrs);
    writtenPaths.push(augmentedAdrsPath);

    // runtime-decisions.json
    const runtimeDecisionsPath = join(metadataDir, 'runtime-decisions.json');
    writeMetadataFile(runtimeDecisionsPath, runtimeDecisions);
    writtenPaths.push(runtimeDecisionsPath);

    const finalWriteSpan = endSpan(writeSpan, 'ok', { filesWritten: writtenPaths.length });
    emitSpan(finalWriteSpan);

    const finalRootSpan = endSpan(rootSpan, 'ok', {
      phase2AdrCount: phase2Adrs.length,
      runtimeDecisionCount: runtimeDecisions.length,
      augmentedADRCount: augmentedAdrs.length,
      filesWritten: writtenPaths.length,
    });
    emitSpan(finalRootSpan);

    const timing = Date.now() - startTime;
    const output: Phase4StageOutput = {
      stage: 'metadata-augmentation',
      status: 'completed',
      data: {
        augmentedADRCount: augmentedAdrs.length,
        runtimeDecisions,
      } satisfies MetadataAugmentOutput,
      artifacts: writtenPaths,
      timing,
      summary:
        `Augmented metadata: ${phase2Adrs.length} Phase 2 ADRs + ` +
        `${runtimeDecisions.length} runtime decisions = ${augmentedAdrs.length} total ` +
        `(${writtenPaths.length} files written in ${timing}ms)`,
    };

    context.stageOutputs.set('metadata-augmentation', output);
    return output;
  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : String(err);

    const finalRootSpan = endSpan(rootSpan, 'error', { error: errorMessage });
    emitSpan(finalRootSpan);

    const timing = Date.now() - startTime;
    const output: Phase4StageOutput = {
      stage: 'metadata-augmentation',
      status: 'failed',
      data: { error: errorMessage },
      artifacts: [],
      timing,
      summary: `Metadata augmentation failed: ${errorMessage}`,
    };

    context.stageOutputs.set('metadata-augmentation', output);
    return output;
  }
}
