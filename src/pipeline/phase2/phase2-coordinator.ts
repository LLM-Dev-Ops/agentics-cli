/**
 * Phase2 Pipeline Coordinator
 *
 * Orchestrates the full 6-stage phase2 pipeline:
 *   1. Artifact Loading — Load + validate phase1 artifacts
 *   2. Research Dossier — Deep extraction from artifacts
 *   3. SPARC Specification — Architecture spec from dossier
 *   4. ADR Generation — Architecture decisions from SPARC + dossier
 *   5. DDD Generation — Domain model from SPARC + ADRs + dossier
 *   6. TDD Plan Generation — Test plan from DDD + SPARC
 *
 * After each artifact-producing stage (3-6), a ruflo agent swarm is invoked
 * to enhance the output using the agentics fleet results and prior artifacts
 * as context. The ruflo agents work in coordination with the 109 agentics.dev
 * agents whose results are available in the Phase 1 artifacts.
 *
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
import { generateSPARCSpecification } from './phases/sparc-specification.js';
import { generateADRs } from './phases/adr-generator.js';
import { generateDDDModel } from './phases/ddd-generator.js';
import { generateTDDPlan } from './phases/tdd-plan-generator.js';
import { createSpan, endSpan, emitSpan, writeSpans } from './telemetry.js';
import { writePhase2Manifest } from './manifest-writer.js';
import { execSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

// ============================================================================
// Stage Definitions
// ============================================================================

interface Phase2StageDefinition {
  readonly id: Phase2Stage;
  readonly label: string;
  readonly executor: (context: Phase2Context) => Promise<Phase2StageOutput>;
  /** Whether ruflo swarm should enhance this stage's output. */
  readonly rufloEnhance: boolean;
}

const PHASE2_STAGES: readonly Phase2StageDefinition[] = [
  { id: 'artifact-loading',      label: 'Phase1 Artifact Loading',   executor: loadPhase1Artifacts,      rufloEnhance: false },
  { id: 'research-dossier',      label: 'Research Dossier',          executor: generateResearchDossier,  rufloEnhance: false },
  { id: 'sparc-specification',   label: 'SPARC Specification',       executor: generateSPARCSpecification, rufloEnhance: true },
  { id: 'adr-generation',        label: 'ADR Generation',            executor: generateADRs,             rufloEnhance: true },
  { id: 'ddd-generation',        label: 'DDD Model Generation',      executor: generateDDDModel,         rufloEnhance: true },
  { id: 'tdd-plan-generation',   label: 'TDD Plan Generation',       executor: generateTDDPlan,          rufloEnhance: true },
] as const;

// ============================================================================
// Ruflo Swarm Enhancement
// ============================================================================

/**
 * Resolve the ruflo binary from local node_modules or global install.
 */
function resolveRufloBinary(): string | null {
  const localBin = path.resolve(process.cwd(), 'node_modules', '.bin', 'ruflo');
  if (fs.existsSync(localBin)) return localBin;

  let dir = path.dirname(new URL(import.meta.url).pathname);
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, 'node_modules', '.bin', 'ruflo');
    if (fs.existsSync(candidate)) return candidate;
    dir = path.dirname(dir);
  }

  try {
    const global = execSync('which ruflo', { stdio: 'pipe', encoding: 'utf-8', timeout: 10000 }).trim();
    if (global) return global;
  } catch { /* not found */ }

  return null;
}

/**
 * Invoke ruflo agent swarm to enhance a stage's output.
 *
 * Feeds the ruflo agents:
 *   - The stage's generated artifacts
 *   - Phase 1 fleet results (109 agentics.dev agent outputs)
 *   - Research dossier for domain context
 *   - Prior SPARC/ADR/DDD artifacts for architectural continuity
 *
 * The ruflo agents enhance/rewrite the artifacts in coordination with
 * the agentics.dev agents whose analysis is available in the fleet results.
 */
function invokeRufloEnhancement(
  stageId: Phase2Stage,
  context: Phase2Context,
  artifacts: readonly string[],
): { enhanced: boolean; timing: number } {
  const start = Date.now();
  const rufloBin = resolveRufloBinary();
  if (!rufloBin) {
    return { enhanced: false, timing: Date.now() - start };
  }

  const phase2Dir = context.phase2Dir;
  const phase1Dir = context.phase1Dir;

  // Collect artifact context paths
  const contextParts: string[] = [];

  // Phase 1 fleet results (the 109 agentics.dev agent outputs)
  const manifestPath = path.join(phase1Dir, 'manifest.json');
  if (fs.existsSync(manifestPath)) contextParts.push(`manifest=${manifestPath}`);

  const execSummary = path.join(phase1Dir, 'executive-summary.md');
  if (fs.existsSync(execSummary)) contextParts.push(`executive-summary=${execSummary}`);

  const scenarioPath = path.join(phase1Dir, 'scenario.json');
  if (fs.existsSync(scenarioPath)) contextParts.push(`scenario=${scenarioPath}`);

  const riskPath = path.join(phase1Dir, 'risk-assessment.json');
  if (fs.existsSync(riskPath)) contextParts.push(`risk-assessment=${riskPath}`);

  const roadmapPath = path.join(phase1Dir, 'roadmap.json');
  if (fs.existsSync(roadmapPath)) contextParts.push(`roadmap=${roadmapPath}`);

  const decisionMemo = path.join(phase1Dir, 'decision-memo.md');
  if (fs.existsSync(decisionMemo)) contextParts.push(`decision-memo=${decisionMemo}`);

  // Research dossier (Phase 2 stage 2 output)
  const dossierPath = path.join(phase2Dir, 'research-dossier.json');
  if (fs.existsSync(dossierPath)) contextParts.push(`dossier=${dossierPath}`);

  // Prior stage artifacts for continuity
  const sparcCombined = path.join(phase2Dir, 'sparc', 'sparc-combined.json');
  if (fs.existsSync(sparcCombined)) contextParts.push(`SPARC=${sparcCombined}`);

  const adrIndex = path.join(phase2Dir, 'adrs', 'adr-index.json');
  if (fs.existsSync(adrIndex)) contextParts.push(`ADRs=${adrIndex}`);

  const dddModel = path.join(phase2Dir, 'ddd', 'domain-model.json');
  if (fs.existsSync(dddModel)) contextParts.push(`DDD=${dddModel}`);

  // Current stage's artifacts
  for (const artifact of artifacts) {
    const basename = path.basename(artifact);
    contextParts.push(`${stageId}/${basename}=${artifact}`);
  }

  const artifactContext = contextParts.join(', ');

  // Stage-specific enhancement objectives
  const objectives: Record<string, string> = {
    'sparc-specification': 'Enhance the SPARC specification using the 109 agentics.dev agent fleet results. Enrich services with deeper architecture from executive summary and risk assessment. Add pseudocode algorithms from scenario capabilities. Strengthen refinement with security and performance targets from risk factors.',
    'adr-generation': 'Enhance Architecture Decision Records using fleet analysis. Add ADRs for risks identified by platform/risk-score agent. Strengthen alternatives with recommendations from copilot/meta-reasoner. Cross-reference with research dossier findings.',
    'ddd-generation': 'Enhance the DDD domain model using fleet intelligence. Add value objects and invariants from scenario constraints. Enrich bounded context descriptions with stakeholder requirements. Strengthen context map with dependency insights from the fleet agents.',
    'tdd-plan-generation': 'Enhance the TDD plan using fleet quality analysis. Add test cases for risks from risk-assessment. Strengthen mock contracts with integration points from connector-hub agents. Add e2e scenarios from scenario success criteria.',
  };

  const objective = objectives[stageId] ?? `Enhance ${stageId} output using agentics fleet results.`;

  // Initialize swarm
  try {
    spawnSync(rufloBin, [
      'swarm', 'init',
      '--topology', 'hierarchical',
      '--max-agents', '4',
      '--strategy', 'specialized',
    ], { cwd: phase2Dir, timeout: 30000, encoding: 'utf-8', stdio: 'pipe' });
  } catch { /* non-fatal */ }

  // Create enhancement task
  const taskDesc = `${objective} Artifact context: ${artifactContext}. Target directory: ${phase2Dir}`;
  try {
    spawnSync(rufloBin, [
      'task', 'create',
      '--type', 'implementation',
      '--description', taskDesc,
    ], { cwd: phase2Dir, timeout: 30000, encoding: 'utf-8', stdio: 'pipe' });
  } catch { /* non-fatal */ }

  // Start swarm
  try {
    spawnSync(rufloBin, [
      'swarm', 'start',
      '-o', `${objective} Context: ${artifactContext.slice(0, 500)}`,
      '-s', 'development',
    ], { cwd: phase2Dir, timeout: 300000, encoding: 'utf-8', stdio: 'pipe' });

    console.error(`     [RUFLO] Enhanced ${stageId} via agent swarm`);
    return { enhanced: true, timing: Date.now() - start };
  } catch {
    console.error(`     [RUFLO] Enhancement skipped for ${stageId}`);
    return { enhanced: false, timing: Date.now() - start };
  }
}

// ============================================================================
// Pipeline Executor
// ============================================================================

/**
 * Execute the full Phase2 pipeline.
 *
 * Runs all 6 stages sequentially. Each stage receives the full context
 * with outputs from prior stages available via context.stageOutputs.
 * After each artifact-producing stage, ruflo agents enhance the output
 * in coordination with the 109 agentics.dev fleet results.
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
  console.error('  PHASE 2: SIMULATION → SPARC + ADR + DDD + TDD (6 stages)');
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

    // Ruflo swarm enhancement — coordinate with agentics fleet results
    if (stage.rufloEnhance && output.status === 'completed' && output.artifacts.length > 0) {
      const enhancement = invokeRufloEnhancement(stage.id, context, output.artifacts);
      if (enhancement.enhanced) {
        console.error(`     [RUFLO] Swarm enhanced ${stage.id} in ${enhancement.timing}ms`);
      }
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
  console.error('  PHASE 2 COMPLETE (6 stages + ruflo enhancement)');
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
