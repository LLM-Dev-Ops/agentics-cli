/**
 * Phase 4 Pipeline Coordinator
 *
 * Orchestrates the 9-stage Phase 4 pipeline:
 *   1. Phase 3 Artifact Validation  — Load + validate Phase 3 artifacts
 *   2. ERP Target Resolution        — Deterministic ERP system detection
 *   3. Schema Generation            — SQL schema files per bounded context
 *   4. Infrastructure Adapter Generation — DDD port adapters for ERP
 *   5. HTTP Server Generation       — Hono or Axum HTTP server files
 *   6. ERP Client Generation        — ERP API client files
 *   7. Deployment Descriptor Generation — Cloud Run / Dockerfile configs
 *   8. Phase 2 Metadata Augmentation — ADR augmentation + runtime decisions
 *   9. Manifest Writing             — SHA-256 checksums, atomic write
 *
 * Follows the pattern of src/pipeline/phase3/phase3-coordinator.ts.
 * Emits structured telemetry spans and writes phase4-manifest.json on completion.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
  Phase4Context,
  Phase4Stage,
  Phase4StageOutput,
  Phase4PipelineResult,
  Phase3Artifacts,
  ERPResolution,
  SimulationContext,
} from './types.js';
import { validatePhase3Artifacts } from './phases/phase3-validator.js';
import { resolveERPTarget } from './phases/erp-target-resolver.js';
import { generateSchemas } from './phases/schema-generator.js';
import { generateInfraAdapters } from './phases/infra-adapter-generator.js';
import { generateHttpServer } from './phases/http-server-generator.js';
import { generateErpClient } from './phases/erp-client-generator.js';
import { generateRustOptimizer } from './phases/rust-optimizer-generator.js';
import { generateDeployment } from './phases/deployment-generator.js';
import { augmentMetadata } from './phases/metadata-augmentor.js';
import { writePhase4Manifest } from './manifest-writer.js';
import { createSpan, endSpan, emitSpan, writeSpans } from '../phase2/telemetry.js';

// ============================================================================
// Stage Definitions
// ============================================================================

interface Phase4StageDefinition {
  readonly id: Phase4Stage;
  readonly label: string;
  readonly executor: (context: Phase4Context) => Promise<Phase4StageOutput> | Phase4StageOutput;
}

const PHASE4_STAGES: readonly Phase4StageDefinition[] = [
  { id: 'phase3-validation',        label: 'Phase 3 Artifact Validation',       executor: validatePhase3Artifacts },
  { id: 'erp-target-resolution',    label: 'ERP Target Resolution',             executor: resolveERPTarget },
  { id: 'schema-generation',        label: 'Schema Generation',                 executor: generateSchemas },
  { id: 'infra-adapter-generation', label: 'Infrastructure Adapter Generation', executor: generateInfraAdapters },
  { id: 'http-server-generation',   label: 'HTTP Server Generation',            executor: generateHttpServer },
  { id: 'erp-client-generation',    label: 'ERP Client Generation',             executor: generateErpClient },
  { id: 'rust-optimizer-generation', label: 'Rust Optimizer Engine (ADR-057)',  executor: generateRustOptimizer },
  { id: 'deployment-generation',    label: 'Deployment Descriptor Generation',  executor: generateDeployment },
  { id: 'metadata-augmentation',    label: 'Phase 2 Metadata Augmentation',     executor: augmentMetadata },
  { id: 'manifest-writing',         label: 'Manifest Writing',                  executor: executeManifestStage },
] as const;

// ============================================================================
// Manifest Writing Stage (wraps writePhase4Manifest as a pipeline stage)
// ============================================================================

function executeManifestStage(context: Phase4Context): Phase4StageOutput {
  const startTime = Date.now();
  const span = createSpan('manifest-writing', 'write-manifest');

  try {
    // Extract language from phase3-validation stage data
    const validationStage = context.stageOutputs.get('phase3-validation');
    const language = validationStage?.status === 'completed'
      ? (validationStage.data as Phase3Artifacts).implementationLanguage
      : 'typescript';

    // Extract ERP details from erp-target-resolution stage data
    const erpStage = context.stageOutputs.get('erp-target-resolution');
    let erpSystem = 'unknown';
    let databaseEngine: string | null = null;
    let apiOnly = false;
    if (erpStage?.status === 'completed') {
      const erpData = erpStage.data as ERPResolution;
      erpSystem = erpData.erpSystem;
      databaseEngine = erpData.databaseEngine ?? null;
      apiOnly = erpData.apiOnly;
    }

    // Collect all stage results so far (excluding manifest-writing itself)
    const priorStages: Phase4StageOutput[] = [];
    for (const stageDef of PHASE4_STAGES) {
      if (stageDef.id === 'manifest-writing') continue;
      const stageOutput = context.stageOutputs.get(stageDef.id);
      if (stageOutput) priorStages.push(stageOutput);
    }

    const totalTiming = Date.now() - startTime;

    const manifest = writePhase4Manifest(
      context.phase4Dir,
      context.traceId,
      language,
      erpSystem,
      databaseEngine,
      apiOnly,
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
      artifacts: ['phase4-manifest.json'],
      timing,
      summary: `  [OK] Wrote phase4-manifest.json (${manifest.artifacts.length} artifacts, success=${manifest.success})`,
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
// ADR-052: Simulation Context Loader
// ============================================================================

/**
 * Load simulation results from the pipeline run directory.
 * Reads scenario.json, manifest.json, and any decision-graph artifacts
 * to extract simulation scenarios, cost models, and risk signals.
 */
export function loadSimulationContext(runDir: string): SimulationContext {
  const empty: SimulationContext = {
    scenarios: [],
    costModel: null,
    riskSignals: [],
    simulationId: null,
  };

  try {
    // Read scenario.json — contains simulation scenarios from Phase 1
    const scenarioPath = path.join(runDir, 'scenario.json');
    if (fs.existsSync(scenarioPath)) {
      const raw = JSON.parse(fs.readFileSync(scenarioPath, 'utf-8')) as Record<string, unknown>;
      const simId = raw['simulation_id'] as string ?? raw['simulationId'] as string ?? null;
      empty.simulationId !== undefined; // typescript narrowing
      const ctx: SimulationContext = { ...empty, simulationId: simId ?? null };

      // Extract scenarios if available
      const rawScenarios = (raw['scenarios'] ?? raw['what_if_scenarios'] ?? []) as Array<Record<string, unknown>>;
      if (Array.isArray(rawScenarios) && rawScenarios.length > 0) {
        const scenarios = rawScenarios.map((s, i) => ({
          id: String(s['id'] ?? `scenario-${i + 1}`),
          name: String(s['name'] ?? s['title'] ?? `Scenario ${i + 1}`),
          costDelta: Number(s['costDelta'] ?? s['cost_delta'] ?? s['cost_impact'] ?? 0),
          riskLevel: String(s['riskLevel'] ?? s['risk_level'] ?? s['risk'] ?? 'medium'),
          mitigationStrategy: String(s['mitigationStrategy'] ?? s['mitigation'] ?? s['description'] ?? ''),
          reliability: Number(s['reliability'] ?? s['confidence'] ?? 0.5),
        }));
        return { ...ctx, scenarios };
      }
      return ctx;
    }

    // Try manifest.json for simulation ID
    const manifestPath = path.join(runDir, 'manifest.json');
    if (fs.existsSync(manifestPath)) {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as Record<string, unknown>;
      const simId = manifest['simulation_id'] as string ?? null;
      return { ...empty, simulationId: simId };
    }
  } catch (err) {
    console.error(`[phase4] ADR-052: Could not load simulation context: ${err instanceof Error ? err.message : String(err)}`);
  }

  // ADR-053: Try to load cost model from decision-graph nodes
  try {
    const graphPath = path.join(runDir, 'decision-graph.json');
    if (fs.existsSync(graphPath)) {
      const graph = JSON.parse(fs.readFileSync(graphPath, 'utf-8')) as { nodes?: Array<Record<string, unknown>> };
      if (Array.isArray(graph.nodes)) {
        const costNode = graph.nodes.find(n => n['type'] === 'cost_model');
        if (costNode) {
          const content = costNode['content'] as Record<string, unknown> ?? {};
          const tco = content['tco'] as Record<string, unknown> ?? {};
          const roi = content['roi'] as Record<string, unknown> ?? {};
          const budgetRisk = content['budgetRisk'] as Record<string, unknown> ?? {};
          const variants = (content['scenarioVariants'] ?? []) as Array<Record<string, unknown>>;

          empty.costModel !== undefined; // narrowing
          const costModel: SimulationContext['costModel'] = {
            baselineCost: Number(tco['year1'] ?? 0),
            scenarioVariants: variants.map(v => ({
              scenarioId: String(v['scenarioId'] ?? ''),
              costDelta: Number(v['costDelta'] ?? 0),
              explanation: String(v['explanation'] ?? v['scenarioName'] ?? ''),
            })),
            budgetThreshold: Number(budgetRisk['contingencyRequired'] ?? 0),
            roi: Number(roi['expectedReturn'] ?? 0),
            confidence: Number(costNode['confidence'] ?? 0.5),
          };

          console.error(`[phase4] ADR-053: Loaded cost model from decision graph (${variants.length} scenario variants, ROI=${costModel.roi})`);
          return { ...empty, costModel };
        }
      }
    }
  } catch (err) {
    console.error(`[phase4] ADR-053: Could not load cost model: ${err instanceof Error ? err.message : String(err)}`);
  }

  return empty;
}

// ============================================================================
// Pipeline Executor
// ============================================================================

/**
 * Execute the full Phase 4 pipeline.
 *
 * Runs all 9 stages sequentially. Each stage receives the full context
 * with outputs from prior stages available via context.stageOutputs.
 * Fails fast on the first stage failure.
 */
export async function executePhase4Pipeline(
  context: Phase4Context,
): Promise<Phase4PipelineResult> {
  const pipelineStart = Date.now();
  const completedStages: Phase4StageOutput[] = [];

  // ADR-052: Load simulation context if not already present
  if (!context.simulationContext) {
    const runDir = path.dirname(context.phase2Dir); // phase2Dir is <runDir>/phase2
    const simCtx = loadSimulationContext(runDir);
    if (simCtx.scenarios.length > 0 || simCtx.simulationId) {
      console.error(`  [ADR-052] Loaded simulation context: ${simCtx.scenarios.length} scenarios, simulationId=${simCtx.simulationId ?? 'none'}`);
    }
    // Attach to context (mutable cast — context is readonly but we own it here)
    (context as { simulationContext?: SimulationContext }).simulationContext = simCtx;
  }

  const rootSpan = createSpan('phase4-pipeline', 'execute-all', {
    traceId: context.traceId,
    phase3Dir: context.phase3Dir,
    phase4Dir: context.phase4Dir,
  });

  console.error('');
  console.error('='.repeat(72));
  console.error('  PHASE 4: DOMAIN-CORE → DEPLOYABLE CLOUD RUN SERVICE');
  console.error('='.repeat(72));
  console.error('');
  console.error(`  Trace ID:   ${context.traceId}`);
  console.error(`  Phase3 Dir: ${context.phase3Dir}`);
  console.error(`  Phase4 Dir: ${context.phase4Dir}`);
  console.error('');

  for (const stage of PHASE4_STAGES) {
    console.error(`  >> [${completedStages.length + 1}/${PHASE4_STAGES.length}] ${stage.label}`);

    const stageSpan = createSpan('phase4-pipeline', stage.id, {}, rootSpan.spanId);
    let output: Phase4StageOutput;

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
      writeSpans(context.telemetrySpans, context.phase4Dir);

      return buildResult(context, completedStages, pipelineStart);
    }
  }

  // All stages complete — write telemetry
  const finalRootSpan = endSpan(rootSpan, 'ok', {
    totalStages: completedStages.length,
  });
  context.telemetrySpans.push(finalRootSpan);
  writeSpans(context.telemetrySpans, context.phase4Dir);

  console.error('');
  console.error('='.repeat(72));
  console.error('  PHASE 4 COMPLETE');
  console.error('='.repeat(72));
  console.error('');
  console.error(`  Output:     ${context.phase4Dir}`);
  console.error(`  Stages:     ${completedStages.length}/${PHASE4_STAGES.length} completed`);
  console.error(`  Duration:   ${Date.now() - pipelineStart}ms`);
  console.error('');

  // Get the manifest from the manifest-writing stage
  const manifestStage = context.stageOutputs.get('manifest-writing');
  const manifest = manifestStage?.status === 'completed'
    ? manifestStage.data as import('./types.js').Phase4Manifest
    : buildFallbackManifest(context, completedStages, pipelineStart);

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

function buildResult(
  context: Phase4Context,
  stages: Phase4StageOutput[],
  startTime: number,
): Phase4PipelineResult {
  return {
    traceId: context.traceId,
    phase4Dir: context.phase4Dir,
    manifest: buildFallbackManifest(context, stages, startTime),
    stageResults: stages,
    totalTiming: Date.now() - startTime,
  };
}

function buildFallbackManifest(
  context: Phase4Context,
  stages: Phase4StageOutput[],
  startTime: number,
): import('./types.js').Phase4Manifest {
  // Extract language from phase3-validation stage if available
  const validationStage = stages.find(s => s.stage === 'phase3-validation' && s.status === 'completed');
  const language = validationStage
    ? (validationStage.data as Phase3Artifacts).implementationLanguage
    : 'typescript';

  // Extract ERP details from erp-target-resolution stage if available
  const erpStage = stages.find(s => s.stage === 'erp-target-resolution' && s.status === 'completed');
  const erpSystem = erpStage ? (erpStage.data as ERPResolution).erpSystem : 'unknown';
  const databaseEngine = erpStage ? ((erpStage.data as ERPResolution).databaseEngine ?? null) : null;
  const apiOnly = erpStage ? (erpStage.data as ERPResolution).apiOnly : false;

  return {
    schema_version: '4.0.0',
    trace_id: context.traceId,
    implementation_language: language,
    erp_system: erpSystem,
    database_engine: databaseEngine,
    api_only: apiOnly,
    artifacts: [],
    total_timing_ms: Date.now() - startTime,
    success: false,
  };
}
