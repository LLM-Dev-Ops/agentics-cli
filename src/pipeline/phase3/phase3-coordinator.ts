/**
 * Phase 3 Pipeline Coordinator
 *
 * Orchestrates the 7-stage Phase 3 pipeline:
 *   1. Phase 2 Validation — Load + validate Phase 2 artifacts
 *   2. Language Resolution — Deterministic language scoring
 *   3. Scaffold Generation — Project structure (TS or Rust)
 *   4. Domain Codegen — Aggregate/VO/event/command/query/seam code
 *   5. Test Generation — London School TDD test files
 *   6. Ruflo Execution — Invoke ruflo via child_process (graceful skip)
 *   7. Manifest Writing — SHA-256 checksums, atomic write
 *
 * Follows the pattern of src/pipeline/phase2/phase2-coordinator.ts.
 * Emits structured telemetry spans and writes phase3-manifest.json on completion.
 */

import type {
  Phase3Context,
  Phase3Stage,
  Phase3StageOutput,
  Phase3PipelineResult,
  LanguageResolution,
  RufloResult,
} from './types.js';
import { validatePhase2Artifacts } from './phases/phase2-validator.js';
import { resolveImplementationLanguage } from './phases/language-resolver.js';
import { generateScaffold } from './phases/scaffold-generator.js';
import { generateDomainCode } from './phases/domain-codegen.js';
import { generateTests } from './phases/test-generator.js';
import { executeRuflo } from './phases/ruflo-executor.js';
import { writePhase3Manifest } from './manifest-writer.js';
import { createSpan, endSpan, emitSpan, writeSpans } from '../phase2/telemetry.js';

// ============================================================================
// Stage Definitions
// ============================================================================

interface Phase3StageDefinition {
  readonly id: Phase3Stage;
  readonly label: string;
  readonly executor: (context: Phase3Context) => Promise<Phase3StageOutput> | Phase3StageOutput;
}

const PHASE3_STAGES: readonly Phase3StageDefinition[] = [
  { id: 'phase2-validation',   label: 'Phase 2 Artifact Validation', executor: validatePhase2Artifacts },
  { id: 'language-resolution', label: 'Language Resolution',         executor: resolveImplementationLanguage },
  { id: 'scaffold-generation', label: 'Scaffold Generation',         executor: generateScaffold },
  { id: 'domain-codegen',      label: 'Domain Code Generation',      executor: generateDomainCode },
  { id: 'test-generation',     label: 'Test Generation',             executor: generateTests },
  { id: 'ruflo-execution',     label: 'Ruflo Execution',             executor: executeRuflo },
  { id: 'manifest-writing',    label: 'Manifest Writing',            executor: executeManifestStage },
] as const;

// ============================================================================
// Manifest Writing Stage (wraps writePhase3Manifest as a pipeline stage)
// ============================================================================

function executeManifestStage(context: Phase3Context): Phase3StageOutput {
  const startTime = Date.now();
  const span = createSpan('manifest-writing', 'write-manifest');

  try {
    // Extract language from language-resolution stage
    const langStage = context.stageOutputs.get('language-resolution');
    const language = langStage?.status === 'completed'
      ? (langStage.data as LanguageResolution).language
      : 'typescript';

    // Extract ruflo version from ruflo-execution stage
    const rufloStage = context.stageOutputs.get('ruflo-execution');
    let rufloVersion = 'N/A';
    if (rufloStage?.status === 'completed') {
      const rufloData = rufloStage.data as RufloResult | { skipped?: boolean };
      if ('version' in rufloData && typeof rufloData.version === 'string') {
        rufloVersion = rufloData.version;
      }
    }

    // Collect all stage results so far (excluding manifest-writing itself)
    const priorStages: Phase3StageOutput[] = [];
    for (const stageDef of PHASE3_STAGES) {
      if (stageDef.id === 'manifest-writing') continue;
      const stageOutput = context.stageOutputs.get(stageDef.id);
      if (stageOutput) priorStages.push(stageOutput);
    }

    const totalTiming = Date.now() - startTime;

    const manifest = writePhase3Manifest(
      context.phase3Dir,
      context.traceId,
      language,
      rufloVersion,
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
      artifacts: ['phase3-manifest.json'],
      timing,
      summary: `  [OK] Wrote phase3-manifest.json (${manifest.artifacts.length} artifacts, success=${manifest.success})`,
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
 * Execute the full Phase 3 pipeline.
 *
 * Runs all 7 stages sequentially. Each stage receives the full context
 * with outputs from prior stages available via context.stageOutputs.
 * Fails fast on the first stage failure.
 */
export async function executePhase3Pipeline(
  context: Phase3Context,
): Promise<Phase3PipelineResult> {
  const pipelineStart = Date.now();
  const completedStages: Phase3StageOutput[] = [];

  const rootSpan = createSpan('phase3-pipeline', 'execute-all', {
    traceId: context.traceId,
    phase2Dir: context.phase2Dir,
    phase3Dir: context.phase3Dir,
  });

  console.error('');
  console.error('='.repeat(72));
  console.error('  PHASE 3: ENGINEERING PACKAGE → DOMAIN-CORE IMPLEMENTATION');
  console.error('='.repeat(72));
  console.error('');
  console.error(`  Trace ID:   ${context.traceId}`);
  console.error(`  Phase2 Dir: ${context.phase2Dir}`);
  console.error(`  Phase3 Dir: ${context.phase3Dir}`);
  console.error('');

  for (const stage of PHASE3_STAGES) {
    console.error(`  >> [${completedStages.length + 1}/${PHASE3_STAGES.length}] ${stage.label}`);

    const stageSpan = createSpan('phase3-pipeline', stage.id, {}, rootSpan.spanId);
    let output: Phase3StageOutput;

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

    // Fail fast — except for ruflo-execution which is optional (non-blocking)
    if (output.status === 'failed') {
      if (stage.id === 'ruflo-execution') {
        console.error(`  Stage "${stage.label}" failed (non-blocking). Continuing pipeline.`);
        console.error('');
        continue;
      }

      console.error(`  Stage "${stage.label}" failed. Pipeline halted.`);
      console.error('');

      const finalRootSpan = endSpan(rootSpan, 'error', { failedStage: stage.id });
      context.telemetrySpans.push(finalRootSpan);
      writeSpans(context.telemetrySpans, context.phase3Dir);

      return buildResult(context, completedStages, pipelineStart);
    }
  }

  // All stages complete — write telemetry
  const finalRootSpan = endSpan(rootSpan, 'ok', {
    totalStages: completedStages.length,
  });
  context.telemetrySpans.push(finalRootSpan);
  writeSpans(context.telemetrySpans, context.phase3Dir);

  console.error('');
  console.error('='.repeat(72));
  console.error('  PHASE 3 COMPLETE');
  console.error('='.repeat(72));
  console.error('');
  console.error(`  Output:     ${context.phase3Dir}`);
  console.error(`  Stages:     ${completedStages.length}/${PHASE3_STAGES.length} completed`);
  console.error(`  Duration:   ${Date.now() - pipelineStart}ms`);
  console.error('');

  // Get the manifest from the manifest-writing stage
  const manifestStage = context.stageOutputs.get('manifest-writing');
  const manifest = manifestStage?.status === 'completed'
    ? manifestStage.data as import('./types.js').Phase3Manifest
    : buildFallbackManifest(context, completedStages, pipelineStart);

  return {
    traceId: context.traceId,
    phase3Dir: context.phase3Dir,
    manifest,
    stageResults: completedStages,
    totalTiming: Date.now() - pipelineStart,
  };
}

// ============================================================================
// Result Builder
// ============================================================================

function buildResult(
  context: Phase3Context,
  stages: Phase3StageOutput[],
  startTime: number,
): Phase3PipelineResult {
  return {
    traceId: context.traceId,
    phase3Dir: context.phase3Dir,
    manifest: buildFallbackManifest(context, stages, startTime),
    stageResults: stages,
    totalTiming: Date.now() - startTime,
  };
}

function buildFallbackManifest(
  context: Phase3Context,
  stages: Phase3StageOutput[],
  startTime: number,
): import('./types.js').Phase3Manifest {
  // Extract language from language-resolution stage if available
  const langStage = stages.find(s => s.stage === 'language-resolution' && s.status === 'completed');
  const language = langStage
    ? (langStage.data as LanguageResolution).language
    : 'typescript';

  return {
    schema_version: '3.0.0',
    trace_id: context.traceId,
    implementation_language: language,
    mixed_mode: false,
    ruflo_version: 'N/A',
    artifacts: [],
    total_timing_ms: Date.now() - startTime,
    success: false,
  };
}
