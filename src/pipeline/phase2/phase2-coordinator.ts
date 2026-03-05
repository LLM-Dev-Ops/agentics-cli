/**
 * Phase2 Pipeline Coordinator
 *
 * Orchestrates the Phase 2 pipeline:
 *   1. Artifact Loading — Load + validate phase1 artifacts
 *   2. Research Dossier — Pure extraction / cross-referencing from Phase 1 docs
 *   3. Ruflo Swarm — Produces SPARC, ADR, DDD, TDD artifacts from Phase 1
 *      artifacts + research dossier. Ruflo agents reason about the domain
 *      and produce architecture artifacts. Falls back to deterministic
 *      generators only if ruflo is unavailable.
 *
 * The ruflo agents receive ALL Phase 1 artifacts (109 agentics.dev agent
 * outputs, executive summary, decision memo, risk assessment, scenario,
 * roadmap) plus the research dossier as context.
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
// Ruflo Binary Resolution
// ============================================================================

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

// ============================================================================
// Phase 1 Context Collector
// ============================================================================

/** Collect all Phase 1 artifact paths that exist on disk. */
function collectPhase1Context(phase1Dir: string): string[] {
  const contextParts: string[] = [];
  const files = [
    ['manifest', 'manifest.json'],
    ['executive-summary', 'executive-summary.md'],
    ['decision-memo', 'decision-memo.md'],
    ['scenario', 'scenario.json'],
    ['roadmap', 'roadmap.json'],
    ['risk-assessment', 'risk-assessment.json'],
  ] as const;

  for (const [label, filename] of files) {
    const filePath = path.join(phase1Dir, filename);
    if (fs.existsSync(filePath)) contextParts.push(`${label}=${filePath}`);
  }

  // Agentics fleet report if available
  const agentReport = path.join(phase1Dir, 'agentics-agents-report.json');
  if (fs.existsSync(agentReport)) contextParts.push(`fleet-report=${agentReport}`);

  return contextParts;
}

// ============================================================================
// Ruflo Swarm: Generate SPARC + ADR + DDD + TDD
// ============================================================================

/**
 * Invoke ruflo agent swarm to generate all Phase 2 architecture artifacts.
 *
 * The ruflo agents receive:
 *   - All Phase 1 artifacts (scenario, executive summary, risk assessment, etc.)
 *   - Research dossier (structured extraction from Phase 1)
 *   - Clear objectives for each artifact type
 *
 * Ruflo writes directly to phase2Dir/sparc/, phase2Dir/adrs/, phase2Dir/ddd/, phase2Dir/tdd/.
 *
 * Returns true if ruflo ran successfully (artifacts exist on disk).
 */
function invokeRufloArchitectureSwarm(
  context: Phase2Context,
): { success: boolean; timing: number; artifacts: string[] } {
  const start = Date.now();
  const rufloBin = resolveRufloBinary();
  if (!rufloBin) {
    return { success: false, timing: Date.now() - start, artifacts: [] };
  }

  const phase2Dir = context.phase2Dir;
  const phase1Context = collectPhase1Context(context.phase1Dir);

  // Research dossier
  const dossierPath = path.join(phase2Dir, 'research-dossier.json');
  if (fs.existsSync(dossierPath)) phase1Context.push(`dossier=${dossierPath}`);

  const artifactContext = phase1Context.join(', ');
  const query = context.phase1Artifacts?.scenario?.query
    ?? context.phase1Artifacts?.manifest?.query
    ?? '';

  // Ensure output directories exist
  for (const sub of ['sparc', 'adrs', 'ddd', 'tdd']) {
    fs.mkdirSync(path.join(phase2Dir, sub), { recursive: true, mode: 0o700 });
  }

  // Initialize swarm — hierarchical, specialized for architecture work
  try {
    spawnSync(rufloBin, [
      'swarm', 'init',
      '--topology', 'hierarchical',
      '--max-agents', '6',
      '--strategy', 'specialized',
    ], { cwd: phase2Dir, timeout: 30000, encoding: 'utf-8', stdio: 'pipe' });
  } catch { /* non-fatal */ }

  // Task 1: SPARC Specification
  const sparcObjective = [
    `Generate a complete SPARC specification (Specification, Pseudocode, Architecture, Refinement, Completion) for: "${query}".`,
    `Analyze the domain from scenario.json domain_entities, capabilities, and systems — NOT from roadmap phases.`,
    `Each SPARC service must be a DOMAIN bounded context (e.g. inventory-management, demand-forecasting, sap-integration).`,
    `Write 5 markdown files (Specification.md, Pseudocode.md, Architecture.md, Refinement.md, Completion.md) to ${phase2Dir}/sparc/.`,
    `Also write sparc-combined.json with structured services, requirements, pseudocode modules.`,
    `Context artifacts: ${artifactContext}`,
  ].join(' ');

  // Task 2: Architecture Decision Records
  const adrObjective = [
    `Generate Architecture Decision Records (ADRs) based on the SPARC specification in ${phase2Dir}/sparc/.`,
    `Create ADRs for: service boundaries, data persistence, security, integration patterns, deployment strategy, inter-service communication.`,
    `Each ADR: title, status (accepted), context, decision, consequences, alternatives considered.`,
    `Write markdown ADR files + adr-index.json to ${phase2Dir}/adrs/.`,
    `Context artifacts: ${artifactContext}`,
  ].join(' ');

  // Task 3: DDD Domain Model
  const dddObjective = [
    `Generate a Domain-Driven Design model based on the SPARC services in ${phase2Dir}/sparc/.`,
    `Create one bounded context per SPARC service. Each context has: aggregates, entities, value objects, domain events, commands, queries.`,
    `Build a context map showing relationships (upstream/downstream, shared-kernel, anti-corruption-layer).`,
    `Build a ubiquitous language glossary from the domain.`,
    `Write domain-model.json, context-map.json, and DDD markdown to ${phase2Dir}/ddd/.`,
    `Context artifacts: ${artifactContext}`,
  ].join(' ');

  // Task 4: TDD Test Plan
  const tddObjective = [
    `Generate a London School TDD test plan based on the DDD model in ${phase2Dir}/ddd/ and SPARC in ${phase2Dir}/sparc/.`,
    `For each bounded context: unit test cases for aggregates/commands, integration tests for service boundaries, e2e scenarios.`,
    `Include mock contracts for each seam/port, test fixtures, and acceptance criteria.`,
    `Test pyramid: unit 70%, integration 20%, e2e 10%.`,
    `Write tdd-plan.json and TDD markdown to ${phase2Dir}/tdd/.`,
    `Context artifacts: ${artifactContext}`,
  ].join(' ');

  // Create all 4 tasks
  const tasks = [
    { name: 'SPARC Specification', desc: sparcObjective },
    { name: 'ADR Generation', desc: adrObjective },
    { name: 'DDD Domain Model', desc: dddObjective },
    { name: 'TDD Test Plan', desc: tddObjective },
  ];

  for (const task of tasks) {
    try {
      spawnSync(rufloBin, [
        'task', 'create',
        '--type', 'implementation',
        '--description', task.desc,
      ], { cwd: phase2Dir, timeout: 30000, encoding: 'utf-8', stdio: 'pipe' });
    } catch { /* non-fatal — task creation is best-effort */ }
  }

  // Start the swarm — agents pick up tasks and write artifacts
  const fullObjective = [
    `Generate complete architecture artifacts (SPARC, ADRs, DDD, TDD) for: "${query}".`,
    `Domain services must come from scenario entities and capabilities, NOT roadmap phases.`,
    `All artifacts reference Phase 1 simulation results from 109 agentics.dev agents.`,
    `Target: ${phase2Dir}. Context: ${artifactContext.slice(0, 500)}`,
  ].join(' ');

  try {
    spawnSync(rufloBin, [
      'swarm', 'start',
      '-o', fullObjective,
      '-s', 'development',
    ], { cwd: phase2Dir, timeout: 300000, encoding: 'utf-8', stdio: 'pipe' });

    console.error('     [RUFLO] Architecture swarm completed');
  } catch {
    console.error('     [RUFLO] Architecture swarm failed');
    return { success: false, timing: Date.now() - start, artifacts: [] };
  }

  // Collect written artifacts
  const writtenArtifacts: string[] = [];
  for (const sub of ['sparc', 'adrs', 'ddd', 'tdd']) {
    const subDir = path.join(phase2Dir, sub);
    if (fs.existsSync(subDir)) {
      try {
        for (const entry of fs.readdirSync(subDir)) {
          writtenArtifacts.push(path.join(subDir, entry));
        }
      } catch { /* ignore */ }
    }
  }

  return {
    success: writtenArtifacts.length > 0,
    timing: Date.now() - start,
    artifacts: writtenArtifacts,
  };
}

// ============================================================================
// Pipeline Executor
// ============================================================================

/**
 * Execute the Phase 2 pipeline.
 *
 * 1. Load Phase 1 artifacts
 * 2. Generate research dossier (pure extraction)
 * 3. Invoke ruflo swarm to produce SPARC + ADR + DDD + TDD
 *    Falls back to deterministic generators if ruflo unavailable.
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
  console.error('  PHASE 2: SIMULATION → SPARC + ADR + DDD + TDD');
  console.error('='.repeat(72));
  console.error('');
  console.error(`  Trace ID:   ${context.traceId}`);
  console.error(`  Phase1 Dir: ${context.phase1Dir}`);
  console.error(`  Phase2 Dir: ${context.phase2Dir}`);
  console.error('');

  // ── Stage 1: Artifact Loading ──
  {
    console.error('  >> [1/3] Phase 1 Artifact Loading');
    const stageSpan = createSpan('phase2-pipeline', 'artifact-loading', {}, rootSpan.spanId);
    let output: Phase2StageOutput;
    try {
      output = await loadPhase1Artifacts(context);
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      output = { stage: 'artifact-loading', status: 'failed', data: { error: errMsg }, artifacts: [], timing: 0, summary: `  ERROR: ${errMsg}` };
    }
    const finalSpan = endSpan(stageSpan, output.status === 'completed' ? 'ok' : 'error', { timing: output.timing });
    emitSpan(finalSpan);
    context.telemetrySpans.push(finalSpan);
    completedStages.push(output);
    context.stageOutputs.set('artifact-loading', output);
    if (output.summary) console.error(output.summary);
    console.error('');
    if (output.status === 'failed') {
      return finishPipeline(context, completedStages, rootSpan, pipelineStart, output.stage);
    }
  }

  // ── Stage 2: Research Dossier (pure extraction — keep this) ──
  {
    console.error('  >> [2/3] Research Dossier');
    const stageSpan = createSpan('phase2-pipeline', 'research-dossier', {}, rootSpan.spanId);
    let output: Phase2StageOutput;
    try {
      output = await generateResearchDossier(context);
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      output = { stage: 'research-dossier', status: 'failed', data: { error: errMsg }, artifacts: [], timing: 0, summary: `  ERROR: ${errMsg}` };
    }
    const finalSpan = endSpan(stageSpan, output.status === 'completed' ? 'ok' : 'error', { timing: output.timing });
    emitSpan(finalSpan);
    context.telemetrySpans.push(finalSpan);
    completedStages.push(output);
    context.stageOutputs.set('research-dossier', output);
    if (output.summary) console.error(output.summary);
    console.error('');
    if (output.status === 'failed') {
      return finishPipeline(context, completedStages, rootSpan, pipelineStart, output.stage);
    }
  }

  // ── Stage 3: Ruflo Architecture Swarm (SPARC + ADR + DDD + TDD) ──
  {
    console.error('  >> [3/3] Ruflo Architecture Swarm (SPARC + ADR + DDD + TDD)');
    const stageSpan = createSpan('phase2-pipeline', 'sparc-specification', {}, rootSpan.spanId);

    const rufloResult = invokeRufloArchitectureSwarm(context);

    if (rufloResult.success && rufloResult.artifacts.length > 0) {
      console.error(`     [RUFLO] Produced ${rufloResult.artifacts.length} artifacts in ${rufloResult.timing}ms`);

      // Record as SPARC stage (downstream expects this stage ID for type resolution)
      const output: Phase2StageOutput = {
        stage: 'sparc-specification',
        status: 'completed',
        data: { rufloGenerated: true, artifactCount: rufloResult.artifacts.length },
        artifacts: rufloResult.artifacts,
        timing: rufloResult.timing,
        summary: `     RUFLO: ${rufloResult.artifacts.length} architecture artifacts generated by agent swarm`,
      };
      const finalSpan = endSpan(stageSpan, 'ok', { artifactCount: rufloResult.artifacts.length, timing: rufloResult.timing });
      emitSpan(finalSpan);
      context.telemetrySpans.push(finalSpan);
      completedStages.push(output);
      context.stageOutputs.set('sparc-specification', output);
      console.error(output.summary);
      console.error('');
    } else {
      // Fallback: run deterministic generators
      console.error('     [RUFLO] Not available — falling back to deterministic generators');
      console.error('');

      const fallbackSpan = endSpan(stageSpan, 'ok', { fallback: 'deterministic' });
      emitSpan(fallbackSpan);
      context.telemetrySpans.push(fallbackSpan);

      // Run each generator in sequence: SPARC → ADR → DDD → TDD
      const generators: Array<{
        id: Phase2Stage;
        label: string;
        fn: (ctx: Phase2Context) => Promise<Phase2StageOutput>;
      }> = [
        { id: 'sparc-specification', label: 'SPARC Specification (fallback)', fn: generateSPARCSpecification },
        { id: 'adr-generation', label: 'ADR Generation (fallback)', fn: generateADRs },
        { id: 'ddd-generation', label: 'DDD Model (fallback)', fn: generateDDDModel },
        { id: 'tdd-plan-generation', label: 'TDD Plan (fallback)', fn: generateTDDPlan },
      ];

      for (const gen of generators) {
        console.error(`     >> ${gen.label}`);
        const genSpan = createSpan('phase2-pipeline', gen.id, {}, rootSpan.spanId);
        let output: Phase2StageOutput;
        try {
          output = await gen.fn(context);
        } catch (err: unknown) {
          const errMsg = err instanceof Error ? err.message : String(err);
          output = { stage: gen.id, status: 'failed', data: { error: errMsg }, artifacts: [], timing: 0, summary: `  ERROR: ${errMsg}` };
        }
        const genFinalSpan = endSpan(genSpan, output.status === 'completed' ? 'ok' : 'error', { timing: output.timing });
        emitSpan(genFinalSpan);
        context.telemetrySpans.push(genFinalSpan);
        completedStages.push(output);
        context.stageOutputs.set(gen.id, output);
        if (output.summary) console.error(output.summary);
        console.error('');

        if (output.status === 'failed') {
          return finishPipeline(context, completedStages, rootSpan, pipelineStart, output.stage);
        }
      }
    }
  }

  // ── Write manifest and telemetry ──
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
  console.error(`  Stages:     ${completedStages.length} completed`);
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
// Helpers
// ============================================================================

function finishPipeline(
  context: Phase2Context,
  stages: Phase2StageOutput[],
  rootSpan: ReturnType<typeof createSpan>,
  startTime: number,
  failedStage: Phase2Stage,
): Phase2PipelineResult {
  console.error(`  Stage "${failedStage}" failed. Pipeline halted.`);
  console.error('');

  const finalRootSpan = endSpan(rootSpan, 'error', { failedStage });
  context.telemetrySpans.push(finalRootSpan);
  writeSpans(context.telemetrySpans, context.phase2Dir);

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
