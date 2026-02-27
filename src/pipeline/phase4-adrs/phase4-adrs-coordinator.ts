/**
 * Phase 4 Pipeline Coordinator (ADRs + DDDs)
 *
 * Orchestrates the 3-stage Phase 4 pipeline:
 *   1. Prior Phase Loading — Load research dossier + SPARC + TDD from disk
 *   2. ADR Generation — Architecture Decision Records citing SPARC + dossier
 *   3. DDD Model Generation — Bounded contexts, aggregates, ubiquitous language
 *
 * Reuses the existing ADR and DDD generators from the Phase 2 pipeline by
 * constructing a Phase2Context with phase2Dir pointing to the phase4/ output
 * directory and pre-populating stageOutputs with data loaded from prior phases.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import type { Phase4ADRContext, Phase4ADRPipelineResult, Phase4ADRStage } from './types.js';
import type {
  Phase2Context,
  Phase2StageOutput,
  Phase1Artifacts,
  ResearchDossier,
  Phase2SPARCOutput,
} from '../phase2/types.js';
import { generateADRs } from '../phase2/phases/adr-generator.js';
import { generateDDDModel } from '../phase2/phases/ddd-generator.js';
import { createSpan, endSpan, emitSpan, writeSpans } from '../phase2/telemetry.js';
import { writePhase4ADRManifest } from './manifest-writer.js';

// ============================================================================
// Stage Definitions
// ============================================================================

interface StageDefinition {
  readonly id: Phase4ADRStage;
  readonly label: string;
}

const STAGES: readonly StageDefinition[] = [
  { id: 'prior-phase-loading', label: 'Prior Phase Loading' },
  { id: 'adr-generation',      label: 'ADR Generation' },
  { id: 'ddd-generation',      label: 'DDD Model Generation' },
] as const;

// ============================================================================
// Artifact Loaders
// ============================================================================

/**
 * Load Phase 1 artifacts from the run directory root.
 * Reads manifest.json, scenario.json, roadmap.json, executive-summary.md,
 * risk-assessment.json, and decision-memo.md. Missing files produce empty
 * defaults rather than errors.
 */
function loadPhase1ArtifactsFromDisk(runDir: string): Phase1Artifacts {
  const readJSON = (name: string): unknown => {
    const filePath = path.join(runDir, name);
    if (!fs.existsSync(filePath)) return {};
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  };

  const readText = (name: string): string => {
    const filePath = path.join(runDir, name);
    if (!fs.existsSync(filePath)) return '';
    return fs.readFileSync(filePath, 'utf-8');
  };

  return {
    manifest: readJSON('manifest.json') as Phase1Artifacts['manifest'],
    scenario: readJSON('scenario.json') as Phase1Artifacts['scenario'],
    roadmap: readJSON('roadmap.json') as Phase1Artifacts['roadmap'],
    executiveSummary: readText('executive-summary.md'),
    riskAssessment: readJSON('risk-assessment.json') as Phase1Artifacts['riskAssessment'],
    decisionMemo: readText('decision-memo.md'),
  };
}

// ============================================================================
// Pipeline Executor
// ============================================================================

/**
 * Execute the Phase 4 ADR + DDD pipeline.
 *
 * Loads prior-phase artifacts from disk, then delegates to the existing
 * ADR and DDD generators from the Phase 2 pipeline. All output is written
 * to the phase4/ directory.
 *
 * @param context - Phase 4 pipeline context with directory paths and trace ID
 * @returns Pipeline result with manifest, stage outputs, and timing
 */
export async function executePhase4ADRPipeline(
  context: Phase4ADRContext,
): Promise<Phase4ADRPipelineResult> {
  const pipelineStart = Date.now();
  const completedStages: Phase2StageOutput[] = [];

  const rootSpan = createSpan('phase4-adrs-pipeline', 'execute-all', {
    traceId: context.traceId,
    phase3Dir: context.phase3Dir,
    phase4Dir: context.phase4Dir,
  });

  console.error('');
  console.error('='.repeat(72));
  console.error('  PHASE 4: SPARC -> ARCHITECTURE DECISION RECORDS + DDD');
  console.error('='.repeat(72));
  console.error('');
  console.error(`  Trace ID:   ${context.traceId}`);
  console.error(`  Phase3 Dir: ${context.phase3Dir}`);
  console.error(`  Phase4 Dir: ${context.phase4Dir}`);
  console.error('');

  // ── Stage 1: Load Prior Phase Artifacts ──────────────────────────────────
  console.error(`  >> [1/${STAGES.length}] ${STAGES[0]!.label}`);
  const loadSpan = createSpan('phase4-adrs-pipeline', 'prior-phase-loading', {}, rootSpan.spanId);
  const loadStart = Date.now();

  let phase1Artifacts: Phase1Artifacts;

  try {
    const runDir = path.dirname(context.phase2Dir);
    phase1Artifacts = loadPhase1ArtifactsFromDisk(runDir);

    // Load research dossier from Phase 2
    const dossierPath = path.join(context.phase2Dir, 'research-dossier.json');
    if (!fs.existsSync(dossierPath)) {
      throw new Error(`Research dossier not found: ${dossierPath}`);
    }
    const researchDossier = JSON.parse(fs.readFileSync(dossierPath, 'utf-8')) as ResearchDossier;

    // Load SPARC from Phase 3
    const sparcPath = path.join(context.phase3Dir, 'sparc', 'sparc-combined.json');
    if (!fs.existsSync(sparcPath)) {
      throw new Error(`SPARC combined output not found: ${sparcPath}`);
    }
    const sparc = JSON.parse(fs.readFileSync(sparcPath, 'utf-8')) as Phase2SPARCOutput;

    // Load TDD plan from Phase 3 (optional, for cross-reference)
    let tddPlan: unknown = null;
    const tddPath = path.join(context.phase3Dir, 'tdd', 'tdd-plan.json');
    if (fs.existsSync(tddPath)) {
      tddPlan = JSON.parse(fs.readFileSync(tddPath, 'utf-8'));
    }

    // Pre-populate stageOutputs for downstream generators
    context.stageOutputs.set('artifact-loading', {
      stage: 'artifact-loading',
      status: 'completed',
      data: phase1Artifacts,
      artifacts: [],
      timing: 0,
      summary: '',
    });
    context.stageOutputs.set('research-dossier', {
      stage: 'research-dossier',
      status: 'completed',
      data: researchDossier,
      artifacts: [],
      timing: 0,
      summary: '',
    });
    context.stageOutputs.set('sparc-specification', {
      stage: 'sparc-specification',
      status: 'completed',
      data: sparc,
      artifacts: [],
      timing: 0,
      summary: '',
    });
    if (tddPlan) {
      context.stageOutputs.set('tdd-plan-generation', {
        stage: 'tdd-plan-generation',
        status: 'completed',
        data: tddPlan,
        artifacts: [],
        timing: 0,
        summary: '',
      });
    }

    const loadOutput: Phase2StageOutput = {
      stage: 'artifact-loading',
      status: 'completed',
      data: { researchDossier, sparc, tddPlan },
      artifacts: [],
      timing: Date.now() - loadStart,
      summary:
        `     Loaded: ${researchDossier.items.length} dossier items, ` +
        `SPARC (${sparc.architecture?.services?.length ?? 0} services)`,
    };

    completedStages.push(loadOutput);
    context.stageOutputs.set('prior-phase-loading', loadOutput);

    const finalLoadSpan = endSpan(loadSpan, 'ok', { dossierItems: researchDossier.items.length });
    emitSpan(finalLoadSpan);
    context.telemetrySpans.push(finalLoadSpan);
    console.error(loadOutput.summary);
    console.error('');
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    const failOutput: Phase2StageOutput = {
      stage: 'artifact-loading',
      status: 'failed',
      data: { error: errMsg },
      artifacts: [],
      timing: Date.now() - loadStart,
      summary: `  ERROR: ${errMsg}`,
    };
    completedStages.push(failOutput);
    const finalLoadSpan = endSpan(loadSpan, 'error');
    context.telemetrySpans.push(finalLoadSpan);
    writeSpans(context.telemetrySpans, context.phase4Dir);
    console.error(failOutput.summary);
    return buildFailResult(context, completedStages, pipelineStart);
  }

  // ── Build Phase2Context for reuse of existing generators ─────────────────
  // The ADR and DDD generators expect a Phase2Context. We construct one with
  // phase2Dir pointing to phase4Dir so that file output lands in the right
  // place, and with stageOutputs pre-populated from the loading stage above.
  const phase2Ctx: Phase2Context = {
    traceId: context.traceId,
    phase1Dir: path.dirname(context.phase2Dir),
    phase2Dir: context.phase4Dir,  // Generators write to this dir
    phase1Artifacts: phase1Artifacts!,
    stageOutputs: context.stageOutputs as Map<any, Phase2StageOutput>,
    telemetrySpans: context.telemetrySpans,
  };

  // ── Stage 2: ADR Generation ──────────────────────────────────────────────
  console.error(`  >> [2/${STAGES.length}] ${STAGES[1]!.label}`);
  const adrSpan = createSpan('phase4-adrs-pipeline', 'adr-generation', {}, rootSpan.spanId);
  let adrOutput: Phase2StageOutput;

  try {
    adrOutput = await generateADRs(phase2Ctx);
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    adrOutput = {
      stage: 'adr-generation',
      status: 'failed',
      data: { error: errMsg },
      artifacts: [],
      timing: 0,
      summary: `  ERROR: ${errMsg}`,
    };
  }

  const finalAdrSpan = endSpan(adrSpan, adrOutput.status === 'completed' ? 'ok' : 'error', {
    artifactCount: adrOutput.artifacts.length,
  });
  emitSpan(finalAdrSpan);
  context.telemetrySpans.push(finalAdrSpan);
  completedStages.push(adrOutput);
  context.stageOutputs.set('adr-generation', adrOutput);
  if (adrOutput.summary) console.error(adrOutput.summary);
  console.error('');

  if (adrOutput.status === 'failed') {
    writeSpans(context.telemetrySpans, context.phase4Dir);
    return buildFailResult(context, completedStages, pipelineStart);
  }

  // ── Stage 3: DDD Model Generation ───────────────────────────────────────
  console.error(`  >> [3/${STAGES.length}] ${STAGES[2]!.label}`);
  const dddSpan = createSpan('phase4-adrs-pipeline', 'ddd-generation', {}, rootSpan.spanId);
  let dddOutput: Phase2StageOutput;

  try {
    dddOutput = await generateDDDModel(phase2Ctx);
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    dddOutput = {
      stage: 'ddd-generation',
      status: 'failed',
      data: { error: errMsg },
      artifacts: [],
      timing: 0,
      summary: `  ERROR: ${errMsg}`,
    };
  }

  const finalDddSpan = endSpan(dddSpan, dddOutput.status === 'completed' ? 'ok' : 'error', {
    artifactCount: dddOutput.artifacts.length,
  });
  emitSpan(finalDddSpan);
  context.telemetrySpans.push(finalDddSpan);
  completedStages.push(dddOutput);
  context.stageOutputs.set('ddd-generation', dddOutput);
  if (dddOutput.summary) console.error(dddOutput.summary);
  console.error('');

  if (dddOutput.status === 'failed') {
    writeSpans(context.telemetrySpans, context.phase4Dir);
    return buildFailResult(context, completedStages, pipelineStart);
  }

  // ── Write manifest and telemetry ─────────────────────────────────────────
  console.error('  Writing phase4-manifest.json...');

  const manifest = writePhase4ADRManifest(
    context.phase4Dir,
    context.traceId,
    completedStages,
    Date.now() - pipelineStart,
  );

  const finalRootSpan = endSpan(rootSpan, 'ok', {
    totalStages: completedStages.length,
    totalArtifacts: manifest.artifacts.length,
  });
  context.telemetrySpans.push(finalRootSpan);
  writeSpans(context.telemetrySpans, context.phase4Dir);

  console.error('');
  console.error('='.repeat(72));
  console.error('  PHASE 4 COMPLETE (ADRs + DDDs)');
  console.error('='.repeat(72));
  console.error('');
  console.error(`  Output:     ${context.phase4Dir}`);
  console.error(`  Stages:     ${completedStages.length}/${STAGES.length} completed`);
  console.error(`  Artifacts:  ${manifest.artifacts.length} files`);
  console.error(`  Duration:   ${Date.now() - pipelineStart}ms`);
  console.error('');

  return {
    traceId: context.traceId,
    phase4Dir: context.phase4Dir,
    manifest,
    stageResults: completedStages,
    totalTiming: Date.now() - pipelineStart,
  };
}

// ============================================================================
// Result Builder
// ============================================================================

/**
 * Build a failure result when the pipeline cannot continue past a failed stage.
 */
function buildFailResult(
  context: Phase4ADRContext,
  stages: Phase2StageOutput[],
  startTime: number,
): Phase4ADRPipelineResult {
  return {
    traceId: context.traceId,
    phase4Dir: context.phase4Dir,
    manifest: {
      schema_version: '4.0.0',
      trace_id: context.traceId,
      generated_at: new Date().toISOString(),
      pipeline_version: '1.0.0',
      stages: stages.map(s => ({
        stage: s.stage as Phase4ADRStage,
        status: s.status,
        timing_ms: s.timing,
        artifact_count: s.artifacts.length,
      })),
      artifacts: [],
      total_timing_ms: Date.now() - startTime,
      success: false,
    },
    stageResults: stages,
    totalTiming: Date.now() - startTime,
  };
}
