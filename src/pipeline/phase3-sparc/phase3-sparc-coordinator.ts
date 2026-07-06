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
import { checkRufloAvailable } from '../ruflo-phase-executor.js';
import { carryForwardPhase2Sparc } from './carry-forward-sparc.js';
// createClaudeCodeRunner and isClaudeCodeRunnerAvailable retained for future incremental refinement
import type {} from '../../runtime/claude-code-runner.js';

// ============================================================================
// ADR-091: Ruflo-primary engineering artifacts
// ============================================================================

/** Minimum byte size for an engineering/ artifact to be considered usable. */
const MIN_ENGINEERING_BYTES = 256;

/** Execution tier for stage output tagging per ADR-091 §5. */
type ExecutionTier = 'ruflo-local' | 'template';

/**
 * Read an artifact from `runDir/engineering/` (produced by Ruflo swarm per
 * ADR-091). Returns null when the file is missing, unreadable, or below the
 * usable-size threshold. Never throws.
 */
function readEngineeringArtifact(
  runDir: string,
  filename: string,
): { content: string; size: number } | null {
  const filePath = path.join(runDir, 'engineering', filename);
  try {
    if (!fs.existsSync(filePath)) return null;
    const content = fs.readFileSync(filePath, 'utf-8');
    const size = Buffer.byteLength(content, 'utf-8');
    if (size < MIN_ENGINEERING_BYTES) return null;
    return { content, size };
  } catch {
    // ENOENT / EACCES / other — treat as "not usable"
    return null;
  }
}

/**
 * Attach an executionTier tag to a stage output without changing its type
 * surface. Consumers that know about ADR-091 read `(output as any).executionTier`;
 * consumers that don't see a normal Phase2StageOutput.
 */
function tagStageOutput<T extends Phase2StageOutput>(out: T, tier: ExecutionTier): T {
  (out as unknown as { executionTier: ExecutionTier }).executionTier = tier;
  return out;
}

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

/**
 * ADR-PIPELINE-093 — Phase 1 loader with strict-mode input surfacing.
 *
 * In the default (permissive) mode, missing JSON files return `{}` and
 * missing markdown files return `''` so existing callers (phase3/phase4
 * coordinators called through their own command paths) do not regress.
 *
 * When `strict: true` is passed, the loader instead returns a typed
 * `{ ok: false, reason, missing }` result describing which required
 * Phase 1 inputs were absent. Auto-chain passes `strict: true` so the
 * orchestrator can mark the phase `blocked` and surface the miss via the
 * ADR-093 dependency gate rather than degrading silently.
 */
interface Phase1LoadMissing {
  readonly ok: false;
  readonly reason: 'missing-phase1-inputs';
  readonly missing: string[];
}

/** Phase 1 required inputs for strict-mode enforcement (Rule 3 coordinator surface change). */
const PHASE1_STRICT_REQUIRED: readonly string[] = ['manifest.json', 'executive-summary.md'];

function loadPhase1ArtifactsFromDisk(
  runDir: string,
  opts: { strict?: boolean } = {},
): Phase1Artifacts | Phase1LoadMissing {
  if (opts.strict) {
    const missing: string[] = [];
    for (const rel of PHASE1_STRICT_REQUIRED) {
      const abs = path.join(runDir, rel);
      let ok = false;
      try {
        const stat = fs.statSync(abs);
        ok = stat.isFile() && stat.size > 0;
      } catch {
        ok = false;
      }
      if (!ok) missing.push(rel);
    }
    if (missing.length > 0) {
      return { ok: false, reason: 'missing-phase1-inputs', missing };
    }
  }

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

/** Type guard: distinguish `Phase1Artifacts` from the strict-mode miss result. */
function isPhase1LoadMissing(v: Phase1Artifacts | Phase1LoadMissing): v is Phase1LoadMissing {
  return (v as Phase1LoadMissing).ok === false;
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
// SPARC Refinement (ADR-091: Ruflo-primary, Phase 2 fallback)
// ============================================================================

/** Required SPARC sections per the ruvnet/sparc methodology. */
const SPARC_SECTIONS = [
  'Specification',
  'Pseudocode',
  'Architecture',
  'Refinement',
  'Completion',
] as const;

/**
 * Split a Ruflo-produced SPARC markdown document into its five canonical
 * sections by scanning top-level `#`/`##` headers. Any section missing from
 * the source is filled with a `_No content provided by Ruflo._` placeholder
 * (never empty — preserves the section-anchor invariant).
 */
function splitSparcMarkdownIntoSections(markdown: string): Record<string, string> {
  const sections: Record<string, string> = {};
  for (const s of SPARC_SECTIONS) sections[s] = '';

  // Match `#` or `##` headers (optionally with SPARC numbering like "## 1. Specification").
  const headerRe = /^(#{1,3})\s+(?:\d+\.?\s+)?([A-Za-z][A-Za-z\s/-]+?)\s*$/gm;
  type Match = { name: string; start: number; headerEnd: number };
  const matches: Match[] = [];
  let m: RegExpExecArray | null;
  while ((m = headerRe.exec(markdown)) !== null) {
    const rawName = m[2]!.trim();
    const canonical = SPARC_SECTIONS.find((s) => s.toLowerCase() === rawName.toLowerCase());
    if (canonical) {
      matches.push({ name: canonical, start: m.index, headerEnd: m.index + m[0].length });
    }
  }

  for (let i = 0; i < matches.length; i++) {
    const cur = matches[i]!;
    const nextStart = i + 1 < matches.length ? matches[i + 1]!.start : markdown.length;
    const body = markdown.slice(cur.headerEnd, nextStart).trim();
    sections[cur.name] = body;
  }

  // If NO canonical headers were found, treat the whole document as the
  // Specification section — Ruflo's content is still preserved verbatim.
  if (matches.length === 0) {
    sections.Specification = markdown.trim();
  }

  return sections;
}

/**
 * Render a refined SPARC markdown document with normalized section structure
 * and section anchors. Ruflo's authored content is preserved verbatim in each
 * section body.
 */
function renderRefinedSparcMarkdown(sections: Record<string, string>, traceId: string): string {
  const lines: string[] = [];
  lines.push('# SPARC Specification');
  lines.push('');
  lines.push(`**Trace ID:** ${traceId}`);
  lines.push(`**Source:** Ruflo local-swarm (ADR-091)`);
  lines.push('');
  lines.push('## Table of Contents');
  lines.push('');
  for (const s of SPARC_SECTIONS) {
    lines.push(`- [${s}](#${s.toLowerCase()})`);
  }
  lines.push('');
  for (const s of SPARC_SECTIONS) {
    lines.push(`<a id="${s.toLowerCase()}"></a>`);
    lines.push(`## ${s}`);
    lines.push('');
    const body = sections[s]?.trim();
    lines.push(body && body.length > 0 ? body : '_No content provided by Ruflo._');
    lines.push('');
  }
  return lines.join('\n') + '\n';
}

/**
 * Build a Phase2SPARCOutput JSON shim from a refined-section bundle. Downstream
 * Phase 4 consumers (ADR generator, DDD generator) expect structured SPARC
 * JSON; we fabricate a minimal shim carrying the markdown content in each
 * phase's narrative field so they have something to cite. Structural arrays
 * (services, modules, requirements) are left empty — Phase 4 coordinator now
 * reads Ruflo's own domain-model.md for that content per ADR-091.
 */
function buildSparcJsonShim(sections: Record<string, string>): Phase2SPARCOutput {
  // Carry Ruflo's markdown into narrative-style fields on the structured shim
  // so downstream consumers that peek at e.g. architecture.dataFlow or
  // completion.integrationPlan still get meaningful text content. Structural
  // arrays (services, modules, requirements) are left empty — Phase 4 reads
  // Ruflo's own domain-model.md for structured content per ADR-091.
  const shim = {
    specification: {
      requirements: [],
      constraints: [],
      successCriteria: [],
      scope: sections.Specification ?? '',
      dossierCoverage: 0,
    },
    pseudocode: {
      modules: [],
    },
    architecture: {
      services: [],
      boundaries: [],
      dataFlow: sections.Architecture ?? '',
      apiContracts: [],
      securityBoundaries: [],
    },
    refinement: {
      securityConsiderations: [],
      performanceTargets: [],
      testStrategy: sections.Refinement ?? '',
    },
    completion: {
      integrationPlan: sections.Completion ?? '',
      documentation: [],
      monitoringSetup: [],
    },
  };
  return shim as unknown as Phase2SPARCOutput;
}

/**
 * ADR-091 primary path: refine Ruflo's `engineering/sparc-specification.md`
 * into `phase3Dir/sparc/specification.md` with normalized section structure,
 * anchors, and a JSON shim for downstream Phase 4 consumers. Returns null
 * when Ruflo content is unavailable so the caller can fall back.
 */
function refineSPARCFromRufloEngineering(
  runDir: string,
  phase3Dir: string,
  traceId: string,
): Phase2StageOutput | null {
  const refineStart = Date.now();
  const rufloOut = readEngineeringArtifact(runDir, 'sparc-specification.md');
  if (!rufloOut) return null;

  process.stderr.write(
    `[phase3-sparc] ADR-091: refining Ruflo engineering/sparc-specification.md ` +
      `(${rufloOut.size} bytes)\n`,
  );

  const sections = splitSparcMarkdownIntoSections(rufloOut.content);
  const refinedMd = renderRefinedSparcMarkdown(sections, traceId);
  const jsonShim = buildSparcJsonShim(sections);

  const sparcDir = path.join(phase3Dir, 'sparc');
  fs.mkdirSync(sparcDir, { recursive: true });
  const writtenPaths: string[] = [];

  const specMdPath = path.join(sparcDir, 'specification.md');
  fs.writeFileSync(specMdPath, refinedMd, { encoding: 'utf-8', mode: 0o644 });
  writtenPaths.push(specMdPath);

  const combinedPath = path.join(sparcDir, 'sparc-combined.json');
  fs.writeFileSync(combinedPath, JSON.stringify(jsonShim, null, 2) + '\n', {
    encoding: 'utf-8',
    mode: 0o644,
  });
  writtenPaths.push(combinedPath);

  return tagStageOutput(
    {
      stage: 'sparc-specification',
      status: 'completed',
      data: jsonShim,
      artifacts: writtenPaths,
      timing: Date.now() - refineStart,
      summary: `     SPARC (ruflo-local): refined ${rufloOut.size}B engineering/sparc-specification.md into ${writtenPaths.length} files`,
    },
    'ruflo-local',
  );
}

/**
 * Phase 2 carry-forward (fallback): copy the Phase 2 SPARC output directly
 * to Phase 3. Per ADR-091, Phase 2 SPARC is itself Ruflo-produced, so this
 * is still the `ruflo-local` tier. When Phase 2 SPARC is also missing and
 * Ruflo is unavailable, returns a template-tier stub.
 */
async function carryForwardPhase2SPARC(
  phase2Dir: string,
  phase3Dir: string,
  phase2Ctx: Phase2Context,
): Promise<Phase2StageOutput> {
  const sparcPath = path.join(phase2Dir, 'sparc', 'sparc-combined.json');
  const refineStart = Date.now();

  if (!fs.existsSync(sparcPath)) {
    // No Ruflo engineering/, no Phase 2 SPARC.
    // Template last-resort fires only when Ruflo is unavailable (ADR-091 §3).
    const ruflo = checkRufloAvailable();
    if (!ruflo.available) {
      process.stderr.write(
        '[phase3-sparc] ADR-091 template fallback: no engineering/sparc + no phase2 + no ruflo\n',
      );
      return tagStageOutput(await generateSPARCSpecification(phase2Ctx), 'template');
    }
    // Ruflo available but hasn't produced yet — let auto-chain / dependency
    // gate re-invoke Ruflo to fill the gap (ADR-093).
    process.stderr.write(
      '[phase3-sparc] ADR-091: no engineering/sparc-specification.md and no Phase 2 SPARC; ' +
        'returning failed stage for dependency-gate handling\n',
    );
    return tagStageOutput(
      {
        stage: 'sparc-specification',
        status: 'failed',
        data: { error: 'No Ruflo engineering SPARC artifact and no Phase 2 SPARC carry-forward available' },
        artifacts: [],
        timing: Date.now() - refineStart,
        summary: '  ERROR: No SPARC input (expected runDir/engineering/sparc-specification.md from Ruflo)',
      },
      'ruflo-local',
    );
  }

  let phase2Sparc: Phase2SPARCOutput;
  try {
    phase2Sparc = JSON.parse(fs.readFileSync(sparcPath, 'utf-8')) as Phase2SPARCOutput;
  } catch {
    process.stderr.write(
      '[phase3-sparc] Failed to parse Phase 2 SPARC JSON — returning failed stage for dependency-gate handling\n',
    );
    return tagStageOutput(
      {
        stage: 'sparc-specification',
        status: 'failed',
        data: { error: 'Phase 2 SPARC JSON is corrupted' },
        artifacts: [],
        timing: Date.now() - refineStart,
        summary: '  ERROR: Phase 2 SPARC JSON could not be parsed',
      },
      'ruflo-local',
    );
  }

  process.stderr.write(
    '[phase3-sparc] ADR-091 fallback: carrying Phase 2 SPARC forward (no engineering/sparc-specification.md)\n',
  );

  // Copy Phase 2 SPARC files to Phase 3, normalising markdown filenames to the
  // lower-cased canonical names the phase4/phase5a dependency gate requires
  // (`phase3/sparc/specification.md`) plus the `engineering/` mirror. A verbatim
  // copy here left the Phase 2 title-cased `Specification.md` in place, which the
  // gate could not see on a case-sensitive filesystem, cascade-skipping Phases 4–6.
  const phase3SparcDir = path.join(phase3Dir, 'sparc');
  carryForwardPhase2Sparc(phase2Dir, phase3Dir);

  return tagStageOutput(
    {
      stage: 'sparc-specification',
      status: 'completed',
      data: phase2Sparc,
      artifacts: [path.join(phase3SparcDir, 'sparc-combined.json')],
      timing: Date.now() - refineStart,
      summary: `     SPARC (carried from Phase 2): ${phase2Sparc.architecture?.services?.length ?? 0} services`,
    },
    'ruflo-local',
  );
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
    // ADR-PIPELINE-093: default permissive load keeps legacy callers working.
    // Strict-mode gating happens in auto-chain BEFORE this coordinator runs.
    const loaded = loadPhase1ArtifactsFromDisk(runDir);
    if (isPhase1LoadMissing(loaded)) {
      throw new Error(
        `Phase 1 required inputs missing: ${loaded.missing.join(', ')}`,
      );
    }
    phase1Artifacts = loaded;

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
    // ADR-091 primary path: refine Ruflo's engineering/sparc-specification.md.
    // When Ruflo hasn't produced it (or the file is below the usability
    // threshold), fall back to Phase 2 carry-forward.
    const runDir = path.dirname(context.phase2Dir);
    const rufloRefined = refineSPARCFromRufloEngineering(runDir, context.phase3Dir, context.traceId);
    sparcOutput = rufloRefined ?? (await carryForwardPhase2SPARC(context.phase2Dir, context.phase3Dir, phase2Ctx));
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    process.stderr.write('[phase3-sparc] Using Phase 2 SPARC output directly\n');

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
