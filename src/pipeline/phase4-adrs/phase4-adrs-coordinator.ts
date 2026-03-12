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
  Phase2ADRRecord,
  Phase2DomainModel,
} from '../phase2/types.js';
import { generateADRs } from '../phase2/phases/adr-generator.js';
import { generateDDDModel } from '../phase2/phases/ddd-generator.js';
import { createSpan, endSpan, emitSpan, writeSpans } from '../phase2/telemetry.js';
import { writePhase4ADRManifest } from './manifest-writer.js';
import { createClaudeCodeRunner } from '../../runtime/claude-code-runner.js';

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
// Phase 2 ADR Refinement
// ============================================================================

/**
 * Load Phase 2's ADRs and Phase 3's refined SPARC, then ask Claude to improve
 * the ADRs based on the refined architecture. Falls back to regeneration on
 * any failure.
 */
async function refineADRsFromPhase2(
  phase2Dir: string,
  phase3Dir: string,
  phase4Dir: string,
  phase2Ctx: Phase2Context,
): Promise<Phase2StageOutput> {
  const adrIndexPath = path.join(phase2Dir, 'adrs', 'adr-index.json');
  const sparcPath = path.join(phase3Dir, 'sparc', 'sparc-combined.json');

  if (!fs.existsSync(adrIndexPath)) {
    process.stderr.write('[phase4-adrs] Phase 2 ADR index not found, regenerating from scratch\n');
    return generateADRs(phase2Ctx);
  }

  const refineStart = Date.now();
  let phase2ADRs: Phase2ADRRecord[];
  try {
    phase2ADRs = JSON.parse(fs.readFileSync(adrIndexPath, 'utf-8')) as Phase2ADRRecord[];
  } catch {
    process.stderr.write('[phase4-adrs] Failed to parse Phase 2 ADR JSON, regenerating\n');
    return generateADRs(phase2Ctx);
  }

  let refinedSparc: Phase2SPARCOutput | null = null;
  if (fs.existsSync(sparcPath)) {
    try {
      refinedSparc = JSON.parse(fs.readFileSync(sparcPath, 'utf-8')) as Phase2SPARCOutput;
    } catch { /* use ADRs alone */ }
  }

  try {
    const runner = createClaudeCodeRunner();
    const prompt =
      `You are a senior architect refining Architecture Decision Records. ` +
      `Here are the current ADRs and the refined SPARC specification. ` +
      `Improve the ADRs: ensure each decision cites specific SPARC architecture elements, ` +
      `add concrete technology choices with rationale, remove duplicate decisions, ` +
      `strengthen consequences sections with real tradeoffs. ` +
      `Return as a JSON array of ADR objects. Each object must have: ` +
      `id, title, status, date, context, decision, alternatives (array), consequences (array), ` +
      `sparcSectionRefs (array), researchDossierItemRefs (array).\n\n` +
      `Current ADRs:\n${JSON.stringify(phase2ADRs, null, 2)}\n\n` +
      (refinedSparc ? `Refined SPARC specification:\n${JSON.stringify(refinedSparc, null, 2)}` : '');

    const result = runner.invoke<Record<string, unknown>>(prompt, {
      runId: `refine-adrs-${Date.now()}`,
      timeoutMs: 300_000,
    });

    const data = result.data as Record<string, unknown>;
    const content = typeof data.content === 'string' ? data.content : '';

    let refined: Phase2ADRRecord[] | null = null;

    // Direct array on data
    if (Array.isArray(data)) {
      refined = data as unknown as Phase2ADRRecord[];
    }

    // Nested in a wrapper
    if (!refined && Array.isArray((data as Record<string, unknown>).adrs)) {
      refined = (data as Record<string, unknown>).adrs as Phase2ADRRecord[];
    }

    // Parse from content string
    if (!refined && content) {
      try {
        const jsonStr = content.replace(/^```(?:json)?\s*/m, '').replace(/\s*```\s*$/m, '');
        const parsed = JSON.parse(jsonStr);
        if (Array.isArray(parsed)) {
          refined = parsed as Phase2ADRRecord[];
        } else if (Array.isArray(parsed.adrs)) {
          refined = parsed.adrs as Phase2ADRRecord[];
        }
      } catch { /* not valid JSON */ }
    }

    if (!refined || refined.length === 0) {
      process.stderr.write('[phase4-adrs] LLM refinement did not return valid ADR array, regenerating\n');
      return generateADRs(phase2Ctx);
    }

    // Write refined ADRs to Phase 4 output directory
    const adrDir = path.join(phase4Dir, 'adrs');
    fs.mkdirSync(adrDir, { recursive: true });
    const FILE_MODE = 0o644;
    const writtenPaths: string[] = [];

    for (const adr of refined) {
      const slug = (adr.title || 'untitled').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 60);
      const filename = `${adr.id}-${slug}.md`;
      const filePath = path.join(adrDir, filename);
      // Write a simple markdown representation
      const md = [
        `# ${adr.id}: ${adr.title}`,
        `\n**Status:** ${adr.status}`,
        `**Date:** ${adr.date}`,
        `\n## Context\n${adr.context}`,
        `\n## Decision\n${adr.decision}`,
        `\n## Consequences`,
        ...(adr.consequences || []).map(c => `- [${c.type}] ${c.description}`),
      ].join('\n');
      fs.writeFileSync(filePath, md + '\n', { encoding: 'utf-8', mode: FILE_MODE });
      writtenPaths.push(filePath);
    }

    const indexPath = path.join(adrDir, 'adr-index.json');
    fs.writeFileSync(indexPath, JSON.stringify(refined, null, 2) + '\n', { encoding: 'utf-8', mode: FILE_MODE });
    writtenPaths.push(indexPath);

    const timing = Date.now() - refineStart;
    process.stderr.write(`[phase4-adrs] Refined ${refined.length} ADRs from Phase 2 in ${timing}ms\n`);

    return {
      stage: 'adr-generation',
      status: 'completed',
      data: refined,
      artifacts: writtenPaths,
      timing,
      summary: `     ADRs (refined): ${refined.length} decisions (${writtenPaths.length - 1} markdown + 1 JSON index)`,
    };
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[phase4-adrs] ADR refinement failed (${errMsg}), falling back to regeneration\n`);
    return generateADRs(phase2Ctx);
  }
}

// ============================================================================
// Phase 2 DDD Refinement
// ============================================================================

/**
 * Load Phase 2's DDD model and the refined ADRs, then ask Claude to improve
 * the domain model. Falls back to regeneration on any failure.
 */
async function refineDDDFromPhase2(
  phase2Dir: string,
  phase4Dir: string,
  refinedADRs: Phase2StageOutput,
  phase2Ctx: Phase2Context,
): Promise<Phase2StageOutput> {
  const dddPath = path.join(phase2Dir, 'ddd', 'domain-model.json');

  if (!fs.existsSync(dddPath)) {
    process.stderr.write('[phase4-ddd] Phase 2 DDD model not found, regenerating from scratch\n');
    return generateDDDModel(phase2Ctx);
  }

  const refineStart = Date.now();
  let phase2DDD: Phase2DomainModel;
  try {
    phase2DDD = JSON.parse(fs.readFileSync(dddPath, 'utf-8')) as Phase2DomainModel;
  } catch {
    process.stderr.write('[phase4-ddd] Failed to parse Phase 2 DDD JSON, regenerating\n');
    return generateDDDModel(phase2Ctx);
  }

  try {
    const runner = createClaudeCodeRunner();
    const adrs = refinedADRs.data;
    const prompt =
      `You are a DDD expert refining a domain model. ` +
      `Here is the current model and the architectural decisions. ` +
      `Improve: add typed fields to empty aggregates, strengthen the context map ` +
      `with real upstream/downstream relationships, add domain events that cross boundaries, ` +
      `ensure commands have meaningful preconditions and postconditions. ` +
      `Return as JSON with keys: "contexts" (array), "contextMap" (array), ` +
      `"ubiquitousLanguageGlossary" (array).\n\n` +
      `Current DDD domain model:\n${JSON.stringify(phase2DDD, null, 2)}\n\n` +
      `Architectural decisions:\n${JSON.stringify(adrs, null, 2)}`;

    const result = runner.invoke<Record<string, unknown>>(prompt, {
      runId: `refine-ddd-${Date.now()}`,
      timeoutMs: 300_000,
    });

    const data = result.data as Record<string, unknown>;
    const content = typeof data.content === 'string' ? data.content : '';

    let refined: Phase2DomainModel | null = null;

    // Direct fields on data
    if (Array.isArray(data.contexts)) {
      refined = data as unknown as Phase2DomainModel;
    }

    // Parse from content string
    if (!refined && content) {
      try {
        const jsonStr = content.replace(/^```(?:json)?\s*/m, '').replace(/\s*```\s*$/m, '');
        const parsed = JSON.parse(jsonStr);
        if (Array.isArray(parsed.contexts)) {
          refined = parsed as Phase2DomainModel;
        }
      } catch { /* not valid JSON */ }
    }

    if (!refined || refined.contexts.length === 0) {
      process.stderr.write('[phase4-ddd] LLM refinement did not return valid DDD model, regenerating\n');
      return generateDDDModel(phase2Ctx);
    }

    // Write refined DDD to Phase 4 output directory
    const dddDir = path.join(phase4Dir, 'ddd');
    fs.mkdirSync(dddDir, { recursive: true });
    const FILE_MODE = 0o644;
    const JSON_INDENT = 2;
    const artifactPaths: string[] = [];

    const domainModelPath = path.join(dddDir, 'domain-model.json');
    fs.writeFileSync(domainModelPath, JSON.stringify(refined, null, JSON_INDENT) + '\n', { encoding: 'utf-8', mode: FILE_MODE });
    artifactPaths.push(domainModelPath);

    const contextMapPath = path.join(dddDir, 'context-map.json');
    fs.writeFileSync(contextMapPath, JSON.stringify(refined.contextMap, null, JSON_INDENT) + '\n', { encoding: 'utf-8', mode: FILE_MODE });
    artifactPaths.push(contextMapPath);

    const timing = Date.now() - refineStart;
    process.stderr.write(
      `[phase4-ddd] Refined DDD model from Phase 2 in ${timing}ms ` +
      `(${refined.contexts.length} contexts, ${refined.contextMap.length} relations)\n`,
    );

    return {
      stage: 'ddd-generation',
      status: 'completed',
      data: refined,
      artifacts: artifactPaths,
      timing,
      summary: `     DDD (refined): ${refined.contexts.length} bounded contexts, ${refined.contextMap.length} relations, ${refined.ubiquitousLanguageGlossary?.length ?? 0} glossary terms`,
    };
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[phase4-ddd] DDD refinement failed (${errMsg}), falling back to regeneration\n`);
    return generateDDDModel(phase2Ctx);
  }
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
    adrOutput = await refineADRsFromPhase2(context.phase2Dir, context.phase3Dir, context.phase4Dir, phase2Ctx);
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
    dddOutput = await refineDDDFromPhase2(context.phase2Dir, context.phase4Dir, adrOutput, phase2Ctx);
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
