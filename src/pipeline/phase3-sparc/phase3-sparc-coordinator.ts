/**
 * Phase 3 Pipeline Coordinator (SPARC + London School TDD)
 *
 * Orchestrates the 3-stage Phase 3 pipeline:
 *   1. Phase 2 Loading -- Load research dossier + Phase 1 artifacts from disk
 *   2. SPARC Specification -- Spec, pseudocode, architecture, refinement, completion
 *   3. TDD Plan Generation -- London School outside-in test plan
 *
 * Reuses existing stage executors from Phase 2 by constructing a Phase2Context
 * with phase2Dir pointing to the Phase 3 output directory.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import type { Phase3SPARCContext, Phase3SPARCPipelineResult, Phase3SPARCStage } from './types.js';
import type {
  Phase2Context,
  Phase2StageOutput,
  Phase1Artifacts,
  ResearchDossier,
  Phase2SPARCOutput,
  Phase2DomainModel,
  Phase2DDDBoundedContext,
  Phase2AggregateDefinition,
  Phase2DomainEvent,
  Phase2Command,
  Phase2Query,
} from '../phase2/types.js';
import { generateSPARCSpecification } from '../phase2/phases/sparc-specification.js';
import { generateTDDPlan } from '../phase2/phases/tdd-plan-generator.js';
import { createSpan, endSpan, emitSpan, writeSpans } from '../phase2/telemetry.js';
import { writePhase3SPARCManifest } from './manifest-writer.js';
import { createClaudeCodeRunner } from '../../runtime/claude-code-runner.js';

// ============================================================================
// Stage Definitions
// ============================================================================

interface StageDefinition {
  readonly id: Phase3SPARCStage;
  readonly label: string;
}

const STAGES: readonly StageDefinition[] = [
  { id: 'phase2-loading',       label: 'Phase 2 Research Loading' },
  { id: 'sparc-specification',  label: 'SPARC Specification' },
  { id: 'tdd-plan-generation',  label: 'London School TDD Plan' },
] as const;

// ============================================================================
// Phase 1 Artifact Loader
// ============================================================================

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
// SPARC -> Minimal DDD Adapter
// ============================================================================

/**
 * Converts SPARC architecture services into a minimal DDD model.
 * This allows the TDD generator (which requires DDD bounded contexts)
 * to run in Phase 3 before the full DDD model is generated in Phase 4.
 */
function buildMinimalDDDFromSPARC(sparc: Phase2SPARCOutput): Phase2DomainModel {
  const contexts: Phase2DDDBoundedContext[] = sparc.architecture.services.map((svc) => {
    // Derive commands from non-GET API methods
    const commands: Phase2Command[] = svc.api
      .filter((a) => !a.toLowerCase().startsWith('get'))
      .map((apiMethod) => ({
        name: apiMethod.replace(/\s+/g, ''),
        description: `${apiMethod} for ${svc.name}`,
        input: ['requestPayload'],
        preconditions: [`${svc.name} is accessible`],
        postconditions: [`${apiMethod} completes successfully`],
      }));

    // Derive queries from GET API methods
    const queries: Phase2Query[] = svc.api
      .filter((a) => a.toLowerCase().startsWith('get'))
      .map((apiMethod) => ({
        name: apiMethod.replace(/\s+/g, ''),
        description: `${apiMethod} for ${svc.name}`,
        parameters: ['filters'],
        returns: `${svc.name}Response`,
      }));

    // Build minimal aggregates from service responsibility
    const aggregates: Phase2AggregateDefinition[] = [{
      name: `${svc.name}Aggregate`,
      root: svc.name,
      entities: [{ name: svc.name, description: svc.responsibility }],
      valueObjects: [],
      invariants: [`${svc.name} must be valid`],
    }];

    // Build domain events from commands
    const domainEvents: Phase2DomainEvent[] = commands.flatMap((cmd) => [
      {
        name: `${cmd.name}Succeeded`,
        description: `Emitted when ${cmd.name} completes successfully`,
        payload: ['result'],
        triggeredBy: cmd.name,
      },
      {
        name: `${cmd.name}Failed`,
        description: `Emitted when ${cmd.name} fails`,
        payload: ['error'],
        triggeredBy: cmd.name,
      },
    ]);

    return {
      name: svc.name,
      description: svc.responsibility,
      aggregates,
      domainEvents,
      commands,
      queries,
      ubiquitousLanguage: [],
      adrRefs: [],
    };
  });

  // Build context map from service dependencies
  const contextMap = sparc.architecture.services.flatMap((svc) =>
    svc.dependencies
      .filter((dep) => sparc.architecture.services.some((s) => s.name === dep))
      .map((dep) => ({
        upstream: dep,
        downstream: svc.name,
        type: 'customer-supplier' as const,
        description: `${svc.name} depends on ${dep}`,
      })),
  );

  return {
    contexts,
    contextMap,
    ubiquitousLanguageGlossary: [],
  };
}

// ============================================================================
// Phase 2 SPARC Refinement
// ============================================================================

/** Strip markdown code fences from a string. */
function stripFences(raw: string): string {
  const fenceMatch = raw.trim().match(/```(?:json)?\s*\n([\s\S]*?)\n\s*```/);
  return fenceMatch?.[1]?.trim() ?? raw.trim();
}

/** Try to parse a string as JSON and extract a SPARC output with all required keys. */
function tryParseSPARCFromString(
  val: unknown,
  requiredKeys: readonly string[],
): Phase2SPARCOutput | null {
  if (typeof val !== 'string' || val.length === 0) return null;
  try {
    const parsed = JSON.parse(stripFences(val));
    if (parsed && typeof parsed === 'object' && requiredKeys.every(k => k in parsed)) {
      return parsed as Phase2SPARCOutput;
    }
  } catch { /* not valid JSON */ }
  return null;
}

/**
 * Load Phase 2's SPARC output and refine it via Claude, returning an improved
 * version. Falls back to regeneration if Phase 2 output is missing or the
 * LLM refinement fails.
 */
async function refineSPARCFromPhase2(
  phase2Dir: string,
  phase3Dir: string,
  phase2Ctx: Phase2Context,
): Promise<Phase2StageOutput> {
  const sparcPath = path.join(phase2Dir, 'sparc', 'sparc-combined.json');

  if (!fs.existsSync(sparcPath)) {
    process.stderr.write('[phase3-sparc] Phase 2 SPARC not found, regenerating from scratch\n');
    return generateSPARCSpecification(phase2Ctx);
  }

  const refineStart = Date.now();
  let phase2Sparc: Phase2SPARCOutput;
  try {
    phase2Sparc = JSON.parse(fs.readFileSync(sparcPath, 'utf-8')) as Phase2SPARCOutput;
  } catch {
    process.stderr.write('[phase3-sparc] Failed to parse Phase 2 SPARC JSON, regenerating\n');
    return generateSPARCSpecification(phase2Ctx);
  }

  try {
    const runner = createClaudeCodeRunner();
    const prompt =
      `You are a senior enterprise architect reviewing a SPARC specification. ` +
      `Improve it: add domain-specific detail to any generic sections, strengthen the pseudocode ` +
      `with typed structs and real algorithms, deepen the architecture with concrete component ` +
      `interactions, add specific performance targets to Refinement. ` +
      `Return the COMPLETE improved document as valid JSON with these top-level keys: ` +
      `"specification", "pseudocode", "architecture", "refinement", "completion". ` +
      `Each key must retain the same nested structure as the original.\n\n` +
      `Original SPARC specification:\n${JSON.stringify(phase2Sparc, null, 2)}`;

    const result = runner.invoke<Record<string, unknown>>(prompt, {
      runId: `refine-sparc-${Date.now()}`,
      timeoutMs: 300_000,
    });

    const data = result.data as Record<string, unknown>;
    const SPARC_KEYS = ['specification', 'pseudocode', 'architecture', 'refinement', 'completion'] as const;

    // Try to parse the refined SPARC from the LLM response
    let refined: Phase2SPARCOutput | null = null;

    // Strategy 1: direct JSON fields on data
    if (SPARC_KEYS.every(k => k in data)) {
      refined = data as unknown as Phase2SPARCOutput;
    }

    // Strategy 2: content field as JSON string
    if (!refined) {
      refined = tryParseSPARCFromString(data.content, SPARC_KEYS);
    }

    // Strategy 3: result field as JSON string (Claude Code envelope)
    if (!refined) {
      refined = tryParseSPARCFromString(data.result, SPARC_KEYS);
    }

    // Strategy 4: scan all string values for JSON containing SPARC keys
    if (!refined) {
      for (const val of Object.values(data)) {
        if (typeof val === 'string' && val.includes('specification')) {
          refined = tryParseSPARCFromString(val, SPARC_KEYS);
          if (refined) break;
        }
        // Strategy 5: check nested objects
        if (val && typeof val === 'object' && !Array.isArray(val)) {
          const nested = val as Record<string, unknown>;
          if (SPARC_KEYS.every(k => k in nested)) {
            refined = nested as unknown as Phase2SPARCOutput;
            break;
          }
        }
      }
    }

    if (!refined) {
      process.stderr.write(
        `[phase3-sparc] LLM refinement did not return valid SPARC structure (keys: ${Object.keys(data).join(', ')}), regenerating\n`
      );
      return generateSPARCSpecification(phase2Ctx);
    }

    // Write refined SPARC to Phase 3 output directory
    const sparcDir = path.join(phase3Dir, 'sparc');
    fs.mkdirSync(sparcDir, { recursive: true });
    const FILE_MODE = 0o644;

    const writeJSON = (name: string, jsonData: unknown) => {
      const filePath = path.join(sparcDir, name);
      fs.writeFileSync(filePath, JSON.stringify(jsonData, null, 2) + '\n', { encoding: 'utf-8', mode: FILE_MODE });
      return filePath;
    };

    const writtenPaths: string[] = [];
    writtenPaths.push(writeJSON('specification.json', refined.specification));
    writtenPaths.push(writeJSON('pseudocode.json', refined.pseudocode));
    writtenPaths.push(writeJSON('architecture.json', refined.architecture));
    writtenPaths.push(writeJSON('refinement.json', refined.refinement));
    writtenPaths.push(writeJSON('completion.json', refined.completion));
    writtenPaths.push(writeJSON('sparc-combined.json', refined));

    const timing = Date.now() - refineStart;
    process.stderr.write(
      `[phase3-sparc] Refined SPARC from Phase 2 in ${timing}ms ` +
      `(${refined.architecture?.services?.length ?? 0} services)\n`,
    );

    return {
      stage: 'sparc-specification',
      status: 'completed',
      data: refined,
      artifacts: writtenPaths,
      timing,
      summary:
        `     SPARC (refined): ${refined.specification?.requirements?.length ?? 0} requirements, ` +
        `${refined.specification?.constraints?.length ?? 0} constraints, ` +
        `${refined.architecture?.services?.length ?? 0} services`,
    };
  } catch (err: unknown) {
    process.stderr.write(`[phase3-sparc] Using regeneration path\n`);
    return generateSPARCSpecification(phase2Ctx);
  }
}

// ============================================================================
// Pipeline Executor
// ============================================================================

export async function executePhase3SPARCPipeline(
  context: Phase3SPARCContext,
): Promise<Phase3SPARCPipelineResult> {
  const pipelineStart = Date.now();
  const completedStages: Phase2StageOutput[] = [];

  const rootSpan = createSpan('phase3-sparc-pipeline', 'execute-all', {
    traceId: context.traceId,
    phase2Dir: context.phase2Dir,
    phase3Dir: context.phase3Dir,
  });

  console.error('');
  console.error('='.repeat(72));
  console.error('  PHASE 3: RESEARCH -> SPARC + LONDON SCHOOL TDD');
  console.error('='.repeat(72));
  console.error('');
  console.error(`  Trace ID:   ${context.traceId}`);
  console.error(`  Phase2 Dir: ${context.phase2Dir}`);
  console.error(`  Phase3 Dir: ${context.phase3Dir}`);
  console.error('');

  // -- Stage 1: Load Phase 2 Research --
  console.error(`  >> [1/${STAGES.length}] ${STAGES[0]!.label}`);
  const loadSpan = createSpan('phase3-sparc-pipeline', 'phase2-loading', {}, rootSpan.spanId);
  const loadStart = Date.now();

  let phase1Artifacts: Phase1Artifacts;
  let researchDossier: ResearchDossier;

  try {
    // Derive run directory (parent of phase2Dir)
    const runDir = path.dirname(context.phase2Dir);
    phase1Artifacts = loadPhase1ArtifactsFromDisk(runDir);

    // Load research dossier from Phase 2
    const dossierPath = path.join(context.phase2Dir, 'research-dossier.json');
    if (!fs.existsSync(dossierPath)) {
      throw new Error(`Research dossier not found: ${dossierPath}`);
    }
    researchDossier = JSON.parse(fs.readFileSync(dossierPath, 'utf-8')) as ResearchDossier;

    const loadOutput: Phase2StageOutput = {
      stage: 'artifact-loading',
      status: 'completed',
      data: { phase1Artifacts, researchDossier },
      artifacts: [],
      timing: Date.now() - loadStart,
      summary: `     Loaded research dossier: ${researchDossier.items.length} items, ${researchDossier.crossReferences.length} cross-refs`,
    };

    completedStages.push(loadOutput);
    context.stageOutputs.set('phase2-loading', loadOutput);

    // Pre-populate stageOutputs with research dossier for downstream generators
    context.stageOutputs.set('research-dossier', {
      stage: 'research-dossier',
      status: 'completed',
      data: researchDossier,
      artifacts: [],
      timing: 0,
      summary: '',
    });
    // Also set artifact-loading for generators that check it
    context.stageOutputs.set('artifact-loading', {
      stage: 'artifact-loading',
      status: 'completed',
      data: phase1Artifacts,
      artifacts: [],
      timing: 0,
      summary: '',
    });

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
    writeSpans(context.telemetrySpans, context.phase3Dir);
    console.error(failOutput.summary);
    return buildFailResult(context, completedStages, pipelineStart);
  }

  // -- Build Phase2Context for reuse of existing generators --
  const phase2Ctx: Phase2Context = {
    traceId: context.traceId,
    phase1Dir: path.dirname(context.phase2Dir),
    phase2Dir: context.phase3Dir,  // Generators write to this dir
    phase1Artifacts,
    stageOutputs: context.stageOutputs as Map<any, Phase2StageOutput>,
    telemetrySpans: context.telemetrySpans,
  };

  // -- Stage 2: SPARC Specification --
  console.error(`  >> [2/${STAGES.length}] ${STAGES[1]!.label}`);
  const sparcSpan = createSpan('phase3-sparc-pipeline', 'sparc-specification', {}, rootSpan.spanId);
  let sparcOutput: Phase2StageOutput = {
    stage: 'sparc-specification',
    status: 'failed',
    data: { error: 'Not yet executed' },
    artifacts: [],
    timing: 0,
    summary: '',
  };

  try {
    sparcOutput = await refineSPARCFromPhase2(context.phase2Dir, context.phase3Dir, phase2Ctx);
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[phase3-sparc] SPARC refinement + regeneration both failed: ${errMsg.slice(0, 200)}\n`);

    // ADR-028: Instead of failing the entire pipeline, attempt to carry
    // forward the Phase 2 SPARC output as-is. The downstream phases can
    // still generate meaningful artifacts from unrefined SPARC.
    const phase2SparcPath = path.join(context.phase2Dir, 'sparc', 'sparc-combined.json');
    let recovered = false;
    if (fs.existsSync(phase2SparcPath)) {
      try {
        const phase2Sparc = JSON.parse(fs.readFileSync(phase2SparcPath, 'utf-8'));
        // Copy Phase 2 SPARC directly to Phase 3 output
        const sparcDir = path.join(context.phase3Dir, 'sparc');
        fs.mkdirSync(sparcDir, { recursive: true });
        const writtenPaths: string[] = [];
        for (const key of ['specification', 'pseudocode', 'architecture', 'refinement', 'completion']) {
          if (phase2Sparc[key]) {
            const filePath = path.join(sparcDir, `${key}.json`);
            fs.writeFileSync(filePath, JSON.stringify(phase2Sparc[key], null, 2) + '\n', 'utf-8');
            writtenPaths.push(filePath);
          }
        }
        const combinedPath = path.join(sparcDir, 'sparc-combined.json');
        fs.writeFileSync(combinedPath, JSON.stringify(phase2Sparc, null, 2) + '\n', 'utf-8');
        writtenPaths.push(combinedPath);

        sparcOutput = {
          stage: 'sparc-specification',
          status: 'completed',
          data: phase2Sparc,
          artifacts: writtenPaths,
          timing: 0,
          summary: `     SPARC (carried forward from Phase 2 — LLM refinement unavailable)`,
        };
        recovered = true;
        process.stderr.write('[phase3-sparc] Recovered: using Phase 2 SPARC output directly\n');
      } catch {
        // Phase 2 SPARC is corrupted — fall through to failure
      }
    }

    if (!recovered) {
      sparcOutput = {
        stage: 'sparc-specification',
        status: 'failed',
        data: { error: errMsg },
        artifacts: [],
        timing: 0,
        summary: `  ERROR: ${errMsg}`,
      };
    }
  }

  const finalSparcSpan = endSpan(sparcSpan, sparcOutput.status === 'completed' ? 'ok' : 'error', {
    artifactCount: sparcOutput.artifacts.length,
  });
  emitSpan(finalSparcSpan);
  context.telemetrySpans.push(finalSparcSpan);
  completedStages.push(sparcOutput);
  context.stageOutputs.set('sparc-specification', sparcOutput);
  if (sparcOutput.summary) console.error(sparcOutput.summary);
  console.error('');

  if (sparcOutput.status === 'failed') {
    writeSpans(context.telemetrySpans, context.phase3Dir);
    return buildFailResult(context, completedStages, pipelineStart);
  }

  // -- Stage 3: TDD Plan (London School) --
  // Build minimal DDD model from SPARC architecture for TDD generator compatibility
  console.error(`  >> [3/${STAGES.length}] ${STAGES[2]!.label}`);
  const tddSpan = createSpan('phase3-sparc-pipeline', 'tdd-plan-generation', {}, rootSpan.spanId);

  const sparc = sparcOutput.data as Phase2SPARCOutput;
  const minimalDDD = buildMinimalDDDFromSPARC(sparc);

  // Inject minimal DDD as a stage output so TDD generator can read it
  context.stageOutputs.set('ddd-generation', {
    stage: 'ddd-generation',
    status: 'completed',
    data: minimalDDD,
    artifacts: [],
    timing: 0,
    summary: '',
  });

  let tddOutput: Phase2StageOutput;
  try {
    tddOutput = await generateTDDPlan(phase2Ctx);
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    tddOutput = {
      stage: 'tdd-plan-generation',
      status: 'failed',
      data: { error: errMsg },
      artifacts: [],
      timing: 0,
      summary: `  ERROR: ${errMsg}`,
    };
  }

  const finalTddSpan = endSpan(tddSpan, tddOutput.status === 'completed' ? 'ok' : 'error', {
    artifactCount: tddOutput.artifacts.length,
  });
  emitSpan(finalTddSpan);
  context.telemetrySpans.push(finalTddSpan);
  completedStages.push(tddOutput);
  context.stageOutputs.set('tdd-plan-generation', tddOutput);
  if (tddOutput.summary) console.error(tddOutput.summary);
  console.error('');

  if (tddOutput.status === 'failed') {
    writeSpans(context.telemetrySpans, context.phase3Dir);
    return buildFailResult(context, completedStages, pipelineStart);
  }

  // -- Write manifest and telemetry --
  console.error('  Writing phase3-manifest.json...');

  const manifest = writePhase3SPARCManifest(
    context.phase3Dir,
    context.traceId,
    completedStages,
    Date.now() - pipelineStart,
  );

  const finalRootSpan = endSpan(rootSpan, 'ok', {
    totalStages: completedStages.length,
    totalArtifacts: manifest.artifacts.length,
  });
  context.telemetrySpans.push(finalRootSpan);
  writeSpans(context.telemetrySpans, context.phase3Dir);

  console.error('');
  console.error('='.repeat(72));
  console.error('  PHASE 3 COMPLETE (SPARC + London TDD)');
  console.error('='.repeat(72));
  console.error('');
  console.error(`  Output:     ${context.phase3Dir}`);
  console.error(`  Stages:     ${completedStages.length}/${STAGES.length} completed`);
  console.error(`  Artifacts:  ${manifest.artifacts.length} files`);
  console.error(`  Duration:   ${Date.now() - pipelineStart}ms`);
  console.error('');

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

function buildFailResult(
  context: Phase3SPARCContext,
  stages: Phase2StageOutput[],
  startTime: number,
): Phase3SPARCPipelineResult {
  return {
    traceId: context.traceId,
    phase3Dir: context.phase3Dir,
    manifest: {
      schema_version: '3.0.0',
      trace_id: context.traceId,
      generated_at: new Date().toISOString(),
      pipeline_version: '1.0.0',
      stages: stages.map((s) => ({
        stage: s.stage as Phase3SPARCStage,
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
