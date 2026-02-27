/**
 * Phase 6 Pipeline Coordinator
 *
 * Orchestrates the 5-stage Phase 6 pipeline:
 *   1. Phase 5 Build Artifact Validation  — Load + validate Phase 4 artifacts
 *   2. Service Registration         — Register service on ERP surface
 *   3. Project Materialization      — Copy project to phase6/project/
 *   4. Deployment Finalization      — Generate deployment scripts
 *   5. Manifest Writing             — SHA-256 checksums, atomic write
 *
 * Follows the pattern of src/pipeline/phase4/phase4-coordinator.ts.
 * Emits structured telemetry spans and writes phase6-manifest.json on completion.
 */

import type {
  Phase6Context,
  Phase6Stage,
  Phase6StageOutput,
  Phase6PipelineResult,
  Phase5Artifacts,
  ERPSurfaceRegistration,
} from './types.js';
import { validatePhase5Artifacts } from './phases/phase5-validator.js';
import { registerERPSurface } from './phases/service-registrar.js';
import { materializeProject } from './phases/project-materializer.js';
import { finalizeDeployment } from './phases/deployment-finalizer.js';
import { writePhase6Manifest } from './manifest-writer.js';
import { createSpan, endSpan, emitSpan, writeSpans } from '../phase2/telemetry.js';

// ============================================================================
// Stage Definitions
// ============================================================================

interface Phase6StageDefinition {
  readonly id: Phase6Stage;
  readonly label: string;
  readonly executor: (context: Phase6Context) => Promise<Phase6StageOutput> | Phase6StageOutput;
}

const PHASE6_STAGES: readonly Phase6StageDefinition[] = [
  { id: 'phase5-validation',       label: 'Phase 5 Build Artifact Validation',  executor: validatePhase5Artifacts },
  { id: 'service-registration',    label: 'ERP Surface Registration',     executor: registerERPSurface },
  { id: 'project-materialization', label: 'Project Materialization',      executor: materializeProject },
  { id: 'deployment-finalization', label: 'Deployment Finalization',      executor: finalizeDeployment },
  { id: 'manifest-writing',        label: 'Manifest Writing',             executor: executeManifestStage },
] as const;

// ============================================================================
// Manifest Writing Stage (wraps writePhase6Manifest as a pipeline stage)
// ============================================================================

function executeManifestStage(context: Phase6Context): Phase6StageOutput {
  const startTime = Date.now();
  const span = createSpan('manifest-writing', 'write-manifest');

  try {
    // Extract ERP system from phase5-validation stage data
    const validationStage = context.stageOutputs.get('phase5-validation');
    const erpSystem = validationStage?.status === 'completed'
      ? (validationStage.data as Phase5Artifacts).erpSystem
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
    const priorStages: Phase6StageOutput[] = [];
    for (const stageDef of PHASE6_STAGES) {
      if (stageDef.id === 'manifest-writing') continue;
      const stageOutput = context.stageOutputs.get(stageDef.id);
      if (stageOutput) priorStages.push(stageOutput);
    }

    const totalTiming = Date.now() - startTime;

    const manifest = writePhase6Manifest(
      context.phase6Dir,
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
      artifacts: ['phase6-manifest.json'],
      timing,
      summary: `  [OK] Wrote phase6-manifest.json (${manifest.artifacts.length} artifacts, success=${manifest.success})`,
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
 * Execute the full Phase 6 pipeline.
 *
 * Runs all 5 stages sequentially. Each stage receives the full context
 * with outputs from prior stages available via context.stageOutputs.
 * Fails fast on the first stage failure.
 */
export async function executePhase6Pipeline(
  context: Phase6Context,
): Promise<Phase6PipelineResult> {
  const pipelineStart = Date.now();
  const completedStages: Phase6StageOutput[] = [];

  const rootSpan = createSpan('phase6-pipeline', 'execute-all', {
    traceId: context.traceId,
    phase5Dir: context.phase5Dir,
    phase6Dir: context.phase6Dir,
  });

  console.error('');
  console.error('='.repeat(72));
  console.error('  PHASE 6: ERP SURFACE PUSH');
  console.error('='.repeat(72));
  console.error('');
  console.error(`  Trace ID:   ${context.traceId}`);
  console.error(`  Phase5 Dir: ${context.phase5Dir}`);
  console.error(`  Phase6 Dir: ${context.phase6Dir}`);
  console.error('');

  for (const stage of PHASE6_STAGES) {
    console.error(`  >> [${completedStages.length + 1}/${PHASE6_STAGES.length}] ${stage.label}`);

    const stageSpan = createSpan('phase6-pipeline', stage.id, {}, rootSpan.spanId);
    let output: Phase6StageOutput;

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
      writeSpans(context.telemetrySpans, context.phase6Dir);

      return buildResult(context, completedStages, pipelineStart);
    }
  }

  // All stages complete — write telemetry
  const finalRootSpan = endSpan(rootSpan, 'ok', {
    totalStages: completedStages.length,
  });
  context.telemetrySpans.push(finalRootSpan);
  writeSpans(context.telemetrySpans, context.phase6Dir);

  console.error('');
  console.error('='.repeat(72));
  console.error('  PHASE 6 COMPLETE');
  console.error('='.repeat(72));
  console.error('');
  console.error(`  Output:     ${context.phase6Dir}`);
  console.error(`  Stages:     ${completedStages.length}/${PHASE6_STAGES.length} completed`);
  console.error(`  Duration:   ${Date.now() - pipelineStart}ms`);
  console.error('');

  // Get the manifest from the manifest-writing stage
  const manifestStage = context.stageOutputs.get('manifest-writing');
  const manifest = manifestStage?.status === 'completed'
    ? manifestStage.data as import('./types.js').Phase6Manifest
    : buildFallbackManifest(context, completedStages, pipelineStart);

  return {
    traceId: context.traceId,
    phase6Dir: context.phase6Dir,
    manifest,
    stageResults: completedStages,
    totalTiming: Date.now() - pipelineStart,
  };
}

// ============================================================================
// Result Builder
// ============================================================================

function buildResult(
  context: Phase6Context,
  stages: Phase6StageOutput[],
  startTime: number,
): Phase6PipelineResult {
  return {
    traceId: context.traceId,
    phase6Dir: context.phase6Dir,
    manifest: buildFallbackManifest(context, stages, startTime),
    stageResults: stages,
    totalTiming: Date.now() - startTime,
  };
}

function buildFallbackManifest(
  context: Phase6Context,
  stages: Phase6StageOutput[],
  startTime: number,
): import('./types.js').Phase6Manifest {
  // Extract ERP system from phase5-validation stage if available
  const validationStage = stages.find(s => s.stage === 'phase5-validation' && s.status === 'completed');
  const erpSystem = validationStage
    ? (validationStage.data as Phase5Artifacts).erpSystem
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
    schema_version: '6.0.0',
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
