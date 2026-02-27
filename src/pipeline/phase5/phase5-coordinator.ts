/**
 * Phase 5 Pipeline Coordinator
 *
 * Orchestrates the 5-stage Phase 5 pipeline:
 *   1. Phase 4 Artifact Validation  — Load + validate Phase 4 artifacts
 *   2. Service Registration         — Register service on ERP surface
 *   3. Project Materialization      — Copy project to phase5/project/
 *   4. Deployment Finalization      — Generate deployment scripts
 *   5. Manifest Writing             — SHA-256 checksums, atomic write
 *
 * Follows the pattern of src/pipeline/phase4/phase4-coordinator.ts.
 * Emits structured telemetry spans and writes phase5-manifest.json on completion.
 */

import type {
  Phase5Context,
  Phase5Stage,
  Phase5StageOutput,
  Phase5PipelineResult,
  Phase4Artifacts,
  ERPSurfaceRegistration,
} from './types.js';
import { validatePhase4Artifacts } from './phases/phase4-validator.js';
import { registerERPSurface } from './phases/service-registrar.js';
import { materializeProject } from './phases/project-materializer.js';
import { finalizeDeployment } from './phases/deployment-finalizer.js';
import { writePhase5Manifest } from './manifest-writer.js';
import { createSpan, endSpan, emitSpan, writeSpans } from '../phase2/telemetry.js';

// ============================================================================
// Stage Definitions
// ============================================================================

interface Phase5StageDefinition {
  readonly id: Phase5Stage;
  readonly label: string;
  readonly executor: (context: Phase5Context) => Promise<Phase5StageOutput> | Phase5StageOutput;
}

const PHASE5_STAGES: readonly Phase5StageDefinition[] = [
  { id: 'phase4-validation',       label: 'Phase 4 Artifact Validation',  executor: validatePhase4Artifacts },
  { id: 'service-registration',    label: 'ERP Surface Registration',     executor: registerERPSurface },
  { id: 'project-materialization', label: 'Project Materialization',      executor: materializeProject },
  { id: 'deployment-finalization', label: 'Deployment Finalization',      executor: finalizeDeployment },
  { id: 'manifest-writing',        label: 'Manifest Writing',             executor: executeManifestStage },
] as const;

// ============================================================================
// Manifest Writing Stage (wraps writePhase5Manifest as a pipeline stage)
// ============================================================================

function executeManifestStage(context: Phase5Context): Phase5StageOutput {
  const startTime = Date.now();
  const span = createSpan('manifest-writing', 'write-manifest');

  try {
    // Extract ERP system from phase4-validation stage data
    const validationStage = context.stageOutputs.get('phase4-validation');
    const erpSystem = validationStage?.status === 'completed'
      ? (validationStage.data as Phase4Artifacts).erpSystem
      : 'unknown';

    // Extract registration info from service-registration stage data
    const registrationStage = context.stageOutputs.get('service-registration');
    let registration: ERPSurfaceRegistration | null = null;
    if (registrationStage?.status === 'completed') {
      const regData = registrationStage.data as { registration?: ERPSurfaceRegistration } | ERPSurfaceRegistration;
      registration = 'registration' in regData && regData.registration
        ? regData.registration
        : regData as ERPSurfaceRegistration;
    }

    // Collect all stage results so far (excluding manifest-writing itself)
    const priorStages: Phase5StageOutput[] = [];
    for (const stageDef of PHASE5_STAGES) {
      if (stageDef.id === 'manifest-writing') continue;
      const stageOutput = context.stageOutputs.get(stageDef.id);
      if (stageOutput) priorStages.push(stageOutput);
    }

    const totalTiming = Date.now() - startTime;

    const manifest = writePhase5Manifest(
      context.phase5Dir,
      context.traceId,
      erpSystem,
      registration,
      priorStages,
      totalTiming,
    );

    const finalSpan = endSpan(span, 'ok', {
      artifactCount: manifest.artifacts.length,
      success: manifest.success,
    });
    emitSpan(finalSpan);
    context.telemetrySpans.push(finalSpan);

    const timing = Date.now() - startTime;

    return {
      stage: 'manifest-writing',
      status: 'completed',
      data: manifest,
      artifacts: ['phase5-manifest.json'],
      timing,
      summary: `  [OK] Wrote phase5-manifest.json (${manifest.artifacts.length} artifacts, success=${manifest.success})`,
    };
  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : String(err);

    const finalSpan = endSpan(span, 'error', { error: errorMessage });
    emitSpan(finalSpan);
    context.telemetrySpans.push(finalSpan);

    const timing = Date.now() - startTime;

    return {
      stage: 'manifest-writing',
      status: 'failed',
      data: { error: errorMessage },
      artifacts: [],
      timing,
      summary: `  [FAIL] Manifest writing failed: ${errorMessage}`,
    };
  }
}

// ============================================================================
// Pipeline Executor
// ============================================================================

/**
 * Execute the full Phase 5 pipeline.
 *
 * Runs all 5 stages sequentially. Each stage receives the full context
 * with outputs from prior stages available via context.stageOutputs.
 * Fails fast on the first stage failure.
 */
export async function executePhase5Pipeline(
  context: Phase5Context,
): Promise<Phase5PipelineResult> {
  const pipelineStart = Date.now();
  const completedStages: Phase5StageOutput[] = [];

  const rootSpan = createSpan('phase5-pipeline', 'execute-all', {
    traceId: context.traceId,
    phase4Dir: context.phase4Dir,
    phase5Dir: context.phase5Dir,
  });

  console.error('');
  console.error('='.repeat(72));
  console.error('  PHASE 5: DEPLOYABLE SERVICE \u2192 ERP SURFACE PUSH');
  console.error('='.repeat(72));
  console.error('');
  console.error(`  Trace ID:   ${context.traceId}`);
  console.error(`  Phase4 Dir: ${context.phase4Dir}`);
  console.error(`  Phase5 Dir: ${context.phase5Dir}`);
  console.error('');

  for (const stage of PHASE5_STAGES) {
    console.error(`  >> [${completedStages.length + 1}/${PHASE5_STAGES.length}] ${stage.label}`);

    const stageSpan = createSpan('phase5-pipeline', stage.id, {}, rootSpan.spanId);
    let output: Phase5StageOutput;

    try {
      output = await stage.executor(context);
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      output = {
        stage: stage.id,
        status: 'failed',
        data: { error: errMsg },
        artifacts: [],
        timing: 0,
        summary: `  ERROR: ${errMsg}`,
      };
    }

    // Record timing in span
    const finalSpan = endSpan(stageSpan, output.status === 'completed' ? 'ok' : 'error', {
      artifactCount: output.artifacts.length,
      timing: output.timing,
    });
    emitSpan(finalSpan);
    context.telemetrySpans.push(finalSpan);

    // Store stage output
    completedStages.push(output);
    context.stageOutputs.set(stage.id, output);

    // Show summary
    if (output.summary) {
      console.error(output.summary);
    }
    console.error('');

    // Fail fast
    if (output.status === 'failed') {
      console.error(`  Stage "${stage.label}" failed. Pipeline halted.`);
      console.error('');

      const finalRootSpan = endSpan(rootSpan, 'error', { failedStage: stage.id });
      context.telemetrySpans.push(finalRootSpan);
      writeSpans(context.telemetrySpans, context.phase5Dir);

      return buildResult(context, completedStages, pipelineStart);
    }
  }

  // All stages complete — write telemetry
  const finalRootSpan = endSpan(rootSpan, 'ok', {
    totalStages: completedStages.length,
  });
  context.telemetrySpans.push(finalRootSpan);
  writeSpans(context.telemetrySpans, context.phase5Dir);

  console.error('');
  console.error('='.repeat(72));
  console.error('  PHASE 5 COMPLETE');
  console.error('='.repeat(72));
  console.error('');
  console.error(`  Output:     ${context.phase5Dir}`);
  console.error(`  Stages:     ${completedStages.length}/${PHASE5_STAGES.length} completed`);
  console.error(`  Duration:   ${Date.now() - pipelineStart}ms`);
  console.error('');

  // Get the manifest from the manifest-writing stage
  const manifestStage = context.stageOutputs.get('manifest-writing');
  const manifest = manifestStage?.status === 'completed'
    ? manifestStage.data as import('./types.js').Phase5Manifest
    : buildFallbackManifest(context, completedStages, pipelineStart);

  return {
    traceId: context.traceId,
    phase5Dir: context.phase5Dir,
    manifest,
    stageResults: completedStages,
    totalTiming: Date.now() - pipelineStart,
  };
}

// ============================================================================
// Result Builder
// ============================================================================

function buildResult(
  context: Phase5Context,
  stages: Phase5StageOutput[],
  startTime: number,
): Phase5PipelineResult {
  return {
    traceId: context.traceId,
    phase5Dir: context.phase5Dir,
    manifest: buildFallbackManifest(context, stages, startTime),
    stageResults: stages,
    totalTiming: Date.now() - startTime,
  };
}

function buildFallbackManifest(
  context: Phase5Context,
  stages: Phase5StageOutput[],
  startTime: number,
): import('./types.js').Phase5Manifest {
  // Extract ERP system from phase4-validation stage if available
  const validationStage = stages.find(s => s.stage === 'phase4-validation' && s.status === 'completed');
  const erpSystem = validationStage
    ? (validationStage.data as Phase4Artifacts).erpSystem
    : 'unknown';

  // Extract registration info from service-registration stage if available
  const registrationStage = stages.find(s => s.stage === 'service-registration' && s.status === 'completed');
  let registration: ERPSurfaceRegistration | null = null;
  if (registrationStage) {
    const regData = registrationStage.data as { registration?: ERPSurfaceRegistration } | ERPSurfaceRegistration;
    registration = 'registration' in regData && regData.registration
      ? regData.registration
      : regData as ERPSurfaceRegistration;
  }

  return {
    schema_version: '5.0.0',
    trace_id: context.traceId,
    erp_system: erpSystem,
    service_name: registration?.service_name ?? 'unknown',
    registration_id: registration?.registration_id ?? 'none',
    endpoints: registration?.endpoints.map(e => ({ method: e.method, path: e.path, sap_service: e.sap_service })) ?? [],
    artifacts: [],
    total_timing_ms: Date.now() - startTime,
    success: false,
  };
}
