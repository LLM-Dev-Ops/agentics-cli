/**
 * Phase2 Pipeline Coordinator
 *
 * Orchestrates the Phase 2 pipeline:
 *   1. Artifact Loading — Load + validate phase1 artifacts
 *   2. Research Dossier — Pure extraction / cross-referencing from Phase 1 docs
 *   3. Agentics + Ruflo Swarm — 109 agentics.dev agents analyze the domain,
 *      then ruflo swarm agents use those results to produce SPARC, ADR, DDD,
 *      TDD artifacts. Falls back to deterministic generators only if both
 *      agentics AND ruflo are unavailable.
 *
 * The cooperation flow:
 *   a) Agentics agents fire in parallel (copilot/planner, copilot/decomposer,
 *      copilot/meta-reasoner, test-bench/quality, schema-registry/validate,
 *      research-lab/hypothesis, + contextual agents triggered by query keywords)
 *   b) Results written to agentics-agents-report.json
 *   c) Ruflo swarm reads Phase 1 artifacts + dossier + agentics results
 *   d) Ruflo agents write SPARC/ADR/DDD/TDD to phase2Dir
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
// Agentics Agent Dispatch
// ============================================================================

/**
 * Dispatch agentics.dev platform agents for Phase 2 domain analysis.
 * Returns the path to the written report file (or null if no agents responded).
 */
async function dispatchAgenticsForPhase2(
  context: Phase2Context,
): Promise<string | null> {
  const phase2Dir = context.phase2Dir;
  const query = context.phase1Artifacts?.scenario?.query
    ?? context.phase1Artifacts?.manifest?.query
    ?? '';

  // Import the swarm orchestrator's dispatch function
  let dispatchPhaseAgents: typeof import('../swarm-orchestrator.js').dispatchPhaseAgents;
  let PHASE_AGENTS: typeof import('../swarm-orchestrator.js').PHASE_AGENTS;
  try {
    const swarmMod = await import('../swarm-orchestrator.js');
    dispatchPhaseAgents = swarmMod.dispatchPhaseAgents;
    PHASE_AGENTS = swarmMod.PHASE_AGENTS;
  } catch {
    console.error('     [AGENTICS] Swarm orchestrator not available');
    return null;
  }

  // Phase 2 agent config dispatches copilot, research-lab, memory-graph + contextual agents
  const phaseConfig = PHASE_AGENTS[2];
  if (!phaseConfig) return null;

  const runDir = path.dirname(phase2Dir); // runDir is parent of phase2Dir
  try {
    console.error('     [AGENTICS] Dispatching platform agents for domain analysis...');
    const results = await dispatchPhaseAgents(phaseConfig, context.traceId, runDir, query);

    if (results.length > 0) {
      // Write results to disk so ruflo can read them
      const reportPath = path.join(phase2Dir, 'agentics-agents-report.json');
      const report = {
        timestamp: new Date().toISOString(),
        phase: 2,
        query,
        agentsInvoked: results.length,
        results: results.map(r => ({
          domain: r.domain,
          agent: r.agent,
          role: r.role,
          status: r.status,
          timing: r.timing,
          response: r.response,
        })),
      };
      fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), { encoding: 'utf-8', mode: 0o600 });
      console.error(`     [AGENTICS] ${results.length} agents responded — report written`);
      return reportPath;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`     [AGENTICS] Agent dispatch failed (non-fatal): ${msg.slice(0, 100)}`);
  }

  return null;
}

// ============================================================================
// Phase 1 Context Collector
// ============================================================================

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

  return contextParts;
}

// ============================================================================
// Ruflo + Agentics Cooperative Swarm
// ============================================================================

/**
 * Invoke ruflo agent swarm IN COOPERATION with agentics.dev agent results
 * to generate SPARC + ADR + DDD + TDD architecture artifacts.
 *
 * Flow:
 *   1. Collect Phase 1 artifacts + research dossier + agentics agent report
 *   2. Feed ALL context into ruflo swarm tasks
 *   3. Ruflo agents reason about the domain using agentics analysis
 *   4. Write SPARC/ADR/DDD/TDD to phase2Dir
 */
function invokeRufloArchitectureSwarm(
  context: Phase2Context,
  agenticsReportPath: string | null,
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

  // Agentics agent results — THIS IS THE COOPERATION POINT
  if (agenticsReportPath && fs.existsSync(agenticsReportPath)) {
    phase1Context.push(`agentics-fleet-report=${agenticsReportPath}`);
  }

  // Also check for Phase 1 fleet report
  const phase1FleetReport = path.join(context.phase1Dir, 'agentics-agents-report.json');
  if (fs.existsSync(phase1FleetReport)) {
    phase1Context.push(`phase1-fleet-report=${phase1FleetReport}`);
  }

  const artifactContext = phase1Context.join(', ');
  const query = context.phase1Artifacts?.scenario?.query
    ?? context.phase1Artifacts?.manifest?.query
    ?? '';

  // Ensure output directories exist
  for (const sub of ['sparc', 'adrs', 'ddd', 'tdd']) {
    fs.mkdirSync(path.join(phase2Dir, sub), { recursive: true, mode: 0o700 });
  }

  // Initialize swarm
  try {
    spawnSync(rufloBin, [
      'swarm', 'init',
      '--topology', 'hierarchical',
      '--max-agents', '6',
      '--strategy', 'specialized',
    ], { cwd: phase2Dir, timeout: 30000, encoding: 'utf-8', stdio: 'pipe' });
  } catch { /* non-fatal */ }

  // Cooperation note: every task explicitly references the agentics fleet report
  const agenticsNote = agenticsReportPath
    ? `Use the agentics fleet analysis at ${agenticsReportPath} — it contains domain analysis from copilot/planner, copilot/decomposer, copilot/meta-reasoner, research-lab, and contextual agents (security, ERP, compliance, etc.) that analyzed this query.`
    : 'Use the Phase 1 simulation artifacts from 109 agentics.dev agents.';

  // Task 1: SPARC Specification
  const sparcObjective = [
    `Generate a complete SPARC specification (Specification, Pseudocode, Architecture, Refinement, Completion) for: "${query}".`,
    agenticsNote,
    `Analyze the domain from scenario.json domain_entities, capabilities, and systems — NOT from roadmap phases.`,
    `Each SPARC service must be a DOMAIN bounded context (e.g. inventory-management, demand-forecasting, sap-integration).`,
    `Write 5 markdown files + sparc-combined.json to ${phase2Dir}/sparc/.`,
    `Context: ${artifactContext}`,
  ].join(' ');

  // Task 2: ADRs
  const adrObjective = [
    `Generate Architecture Decision Records based on SPARC in ${phase2Dir}/sparc/.`,
    agenticsNote,
    `Create ADRs for: service boundaries, data persistence, security, integration patterns, deployment, inter-service comms.`,
    `Write ADR markdown + adr-index.json to ${phase2Dir}/adrs/.`,
    `Context: ${artifactContext}`,
  ].join(' ');

  // Task 3: DDD
  const dddObjective = [
    `Generate a Domain-Driven Design model based on SPARC services in ${phase2Dir}/sparc/.`,
    agenticsNote,
    `One bounded context per SPARC service. Aggregates, entities, value objects, domain events, commands, queries.`,
    `Context map with relationships. Ubiquitous language glossary.`,
    `Write domain-model.json, context-map.json, DDD markdown to ${phase2Dir}/ddd/.`,
    `Context: ${artifactContext}`,
  ].join(' ');

  // Task 4: TDD
  const tddObjective = [
    `Generate a London School TDD test plan from DDD in ${phase2Dir}/ddd/ and SPARC in ${phase2Dir}/sparc/.`,
    agenticsNote,
    `Unit tests for aggregates/commands, integration tests for service boundaries, e2e scenarios.`,
    `Mock contracts per seam/port. Test pyramid: unit 70%, integration 20%, e2e 10%.`,
    `Write tdd-plan.json and TDD markdown to ${phase2Dir}/tdd/.`,
    `Context: ${artifactContext}`,
  ].join(' ');

  const tasks = [
    { name: 'SPARC', desc: sparcObjective },
    { name: 'ADRs', desc: adrObjective },
    { name: 'DDD', desc: dddObjective },
    { name: 'TDD', desc: tddObjective },
  ];

  for (const task of tasks) {
    try {
      spawnSync(rufloBin, [
        'task', 'create',
        '--type', 'implementation',
        '--description', task.desc,
      ], { cwd: phase2Dir, timeout: 30000, encoding: 'utf-8', stdio: 'pipe' });
    } catch { /* non-fatal */ }
  }

  // Start the swarm — agents use agentics results + Phase 1 artifacts to write architecture
  const fullObjective = [
    `Generate SPARC + ADR + DDD + TDD architecture artifacts for: "${query}".`,
    `Work IN COOPERATION with the 109 agentics.dev agents whose analysis is available at: ${agenticsReportPath ?? 'Phase 1 artifacts'}.`,
    `Domain services from scenario entities/capabilities, NOT roadmap phases.`,
    `Target: ${phase2Dir}. Context: ${artifactContext.slice(0, 500)}`,
  ].join(' ');

  try {
    const swarmResult = spawnSync(rufloBin, [
      'swarm', 'start',
      '--objective', fullObjective,
      '-s', 'development',
    ], { cwd: phase2Dir, timeout: 900000, encoding: 'utf-8', stdio: 'pipe' }); // 15 min — SPARC takes ~10 min
    if (swarmResult.status !== 0 || swarmResult.signal === 'SIGTERM') {
      console.error('     [RUFLO] Architecture swarm timed out — using deterministic generators');
      return { success: false, timing: Date.now() - start, artifacts: [] };
    }
    console.error('     [RUFLO] Architecture swarm completed (with agentics cooperation)');
  } catch {
    console.error('     [RUFLO] Using deterministic generators');
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
 * 3. Dispatch agentics.dev agents for domain analysis
 * 4. Invoke ruflo swarm with agentics results to produce SPARC + ADR + DDD + TDD
 *    Falls back to deterministic generators only if ruflo unavailable.
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
  console.error('  (Ruflo swarm + 109 agentics.dev agents in cooperation)');
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

  // ── Stage 2: Research Dossier (pure extraction) ──
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

  // ── Stage 3: Agentics Agents + Ruflo Swarm (cooperative) ──
  {
    console.error('  >> [3/3] Agentics + Ruflo Architecture Swarm');
    const stageSpan = createSpan('phase2-pipeline', 'sparc-specification', {}, rootSpan.spanId);

    // Step A: Dispatch agentics.dev agents for domain analysis
    const agenticsReportPath = await dispatchAgenticsForPhase2(context);

    // Step B: Feed agentics results into ruflo swarm
    const rufloResult = invokeRufloArchitectureSwarm(context, agenticsReportPath);

    if (rufloResult.success && rufloResult.artifacts.length > 0) {
      console.error(`     [COOPERATIVE] ${rufloResult.artifacts.length} artifacts from ruflo + agentics cooperation (${rufloResult.timing}ms)`);
    }

    // ALWAYS run deterministic generators to ensure structured JSON artifacts
    // (sparc-combined.json, adr-index.json, domain-model.json, tdd-plan.json)
    // exist on disk. Ruflo may produce markdown but not the structured JSON
    // that Phases 3-6 depend on. The deterministic generators are fast (<5s)
    // and idempotent — they won't overwrite Ruflo's richer content.
    {
      // Deterministic generators — produce structured JSON artifacts
      console.error('     [RUFLO] Running deterministic generators');
      console.error('');

      const fallbackSpan = endSpan(stageSpan, 'ok', { fallback: 'deterministic' });
      emitSpan(fallbackSpan);
      context.telemetrySpans.push(fallbackSpan);

      const generators: Array<{
        id: Phase2Stage;
        label: string;
        fn: (ctx: Phase2Context) => Promise<Phase2StageOutput>;
      }> = [
        { id: 'sparc-specification', label: 'SPARC Specification', fn: generateSPARCSpecification },
        { id: 'adr-generation', label: 'ADR Generation', fn: generateADRs },
        { id: 'ddd-generation', label: 'DDD Model', fn: generateDDDModel },
        { id: 'tdd-plan-generation', label: 'TDD Plan', fn: generateTDDPlan },
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
  console.error('  PHASE 2 COMPLETE (ruflo swarm + agentics cooperation)');
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
