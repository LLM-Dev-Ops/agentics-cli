/**
 * Phase2 Pipeline Coordinator
 *
 * Orchestrates the 2-stage phase2 pipeline (Deep Research):
 *   1. Artifact Loading — Load + validate phase1 artifacts
 *   2. Research Dossier — Deep extraction from artifacts
 *
 * SPARC, ADR, DDD, and TDD are now in separate phases (3, 4).
 * Emits structured telemetry spans and writes phase2-manifest.json on completion.
 */

import type {
  Phase2Context,
  Phase2Stage,
  Phase2StageOutput,
  Phase2PipelineResult,
} from './types.js';
import { loadPhase1Artifacts } from './phases/artifact-loader.js';
import { generateResearchDossier } from './phases/research-dossier.js';
import { createSpan, endSpan, emitSpan, writeSpans } from './telemetry.js';
import { writePhase2Manifest } from './manifest-writer.js';

// ============================================================================
// Stage Definitions
// ============================================================================

interface Phase2StageDefinition {
  readonly id: Phase2Stage;
  readonly label: string;
  readonly executor: (context: Phase2Context) => Promise<Phase2StageOutput>;
}

const PHASE2_STAGES: readonly Phase2StageDefinition[] = [
  { id: 'artifact-loading',     label: 'Phase1 Artifact Loading',  executor: loadPhase1Artifacts },
  { id: 'research-dossier',     label: 'Research Dossier',         executor: generateResearchDossier },
] as const;

// ============================================================================
// Pipeline Executor
// ============================================================================

/**
 * Execute the full Phase2 pipeline.
 *
 * Runs all 6 stages sequentially. Each stage receives the full context
 * with outputs from prior stages available via context.stageOutputs.
 * Fails fast on the first stage failure.
 */
export async function executePhase2Pipeline(
  context: Phase2Context,
): Promise<Phase2PipelineResult> {
  const pipelineStart = Date.now();
  const completedStages: Phase2StageOutput[] = [];

  const rootSpan = createSpan('phase2-pipeline', 'execute-all', {
    traceId: context.traceId,
    phase1Dir: context.phase1Dir,
    phase2Dir: context.phase2Dir,
  });

  console.error('');
  console.error('='.repeat(72));
  console.error('  PHASE 2: SIMULATION ARTIFACT → DEEP RESEARCH');
  console.error('='.repeat(72));
  console.error('');
  console.error(`  Trace ID:   ${context.traceId}`);
  console.error(`  Phase1 Dir: ${context.phase1Dir}`);
  console.error(`  Phase2 Dir: ${context.phase2Dir}`);
  console.error('');

  for (const stage of PHASE2_STAGES) {
    console.error(`  >> [${completedStages.length + 1}/${PHASE2_STAGES.length}] ${stage.label}`);

    const stageSpan = createSpan('phase2-pipeline', stage.id, {}, rootSpan.spanId);
    let output: Phase2StageOutput;

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
      writeSpans(context.telemetrySpans, context.phase2Dir);

      return buildResult(context, completedStages, pipelineStart);
    }
  }

  // All stages complete — write manifest and telemetry
  console.error('  Writing phase2-manifest.json...');

  const phase1RunId = context.phase1Artifacts.manifest.run_id;
  const manifest = writePhase2Manifest(
    context.phase2Dir,
    context.traceId,
    phase1RunId,
    completedStages,
    Date.now() - pipelineStart,
  );

  const finalRootSpan = endSpan(rootSpan, 'ok', {
    totalStages: completedStages.length,
    totalArtifacts: manifest.artifacts.length,
  });
  context.telemetrySpans.push(finalRootSpan);
  writeSpans(context.telemetrySpans, context.phase2Dir);

  console.error('');
  console.error('='.repeat(72));
  console.error('  PHASE 2 COMPLETE');
  console.error('='.repeat(72));
  console.error('');
  console.error(`  Output:     ${context.phase2Dir}`);
  console.error(`  Stages:     ${completedStages.length}/${PHASE2_STAGES.length} completed`);
  console.error(`  Artifacts:  ${manifest.artifacts.length} files`);
  console.error(`  Duration:   ${Date.now() - pipelineStart}ms`);
  console.error('');

  return {
    traceId: context.traceId,
    phase2Dir: context.phase2Dir,
    manifest,
    stageResults: completedStages,
    totalTiming: Date.now() - pipelineStart,
  };
}

// ============================================================================
// Result Builder
// ============================================================================

function buildResult(
  context: Phase2Context,
  stages: Phase2StageOutput[],
  startTime: number,
): Phase2PipelineResult {
  const failed = stages.find(s => s.status === 'failed');
  return {
    traceId: context.traceId,
    phase2Dir: context.phase2Dir,
    manifest: {
      schema_version: '2.0.0',
      trace_id: context.traceId,
      phase1_run_id: context.phase1Artifacts.manifest.run_id,
      generated_at: new Date().toISOString(),
      pipeline_version: '1.0.0',
      stages: stages.map(s => ({
        stage: s.stage,
        status: s.status,
        timing_ms: s.timing,
        artifact_count: s.artifacts.length,
      })),
      artifacts: [],
      total_timing_ms: Date.now() - startTime,
      deterministic: false,
    },
    stageResults: stages,
    totalTiming: Date.now() - startTime,
    ...(failed ? { error: `Pipeline failed at stage: ${failed.stage}` } : {}),
  };
}
