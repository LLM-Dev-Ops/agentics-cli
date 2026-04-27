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
} from '../phase2/types.js';
import { buildLoudFailureADR } from '../phase2/phases/adr-generator.js';
import { createSpan, endSpan, emitSpan, writeSpans } from '../phase2/telemetry.js';
import { writePhase4ADRManifest } from './manifest-writer.js';
import { checkRufloAvailable } from '../ruflo-phase-executor.js';
import { writeAdrIndex } from './adr-index-extractor.js';

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
/**
 * ADR-PIPELINE-093 — Phase 1 loader with strict-mode input surfacing.
 *
 * Mirrors the phase3-sparc-coordinator contract. Default (permissive) mode
 * preserves the silent-empty-default behaviour that existing integration
 * callers depend on. When `strict: true`, the loader instead returns a typed
 * `{ ok: false, reason, missing }` result so the orchestrator can surface
 * the blocked state via the ADR-093 dependency gate instead of proceeding
 * with empty defaults.
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
// ADR-091 Primary: Refine Ruflo's engineering/architecture-decisions.md
// ============================================================================

/**
 * A structured ADR parsed from a Ruflo-produced markdown document.
 * Compatible with the `Phase2ADRRecord` shape used by downstream consumers,
 * but populated from Ruflo's text rather than a structured LLM response.
 */
interface ParsedRufloADR {
  readonly id: string;
  readonly title: string;
  readonly status: 'proposed' | 'accepted' | 'deprecated';
  readonly date: string;
  readonly context: string;
  readonly decision: string;
  readonly consequences: string;
  readonly rawMarkdown: string;
}

/**
 * Parse Ruflo's `architecture-decisions.md` into structured ADR entries.
 *
 * Splitting strategy: we scan for either `# ADR-<id>` or top-level `## ` headers
 * and treat each hit as the start of a new ADR. Per-ADR sub-sections (Status,
 * Context, Decision, Consequences) are extracted by looking for level-3
 * `### <label>` headers inside each ADR block; missing sub-sections are left
 * empty but the full markdown body is always preserved in `rawMarkdown`.
 *
 * Returns an empty array when no recognizable ADR headers are found so the
 * caller can fall through to the template path.
 */
function parseRufloArchitectureDecisions(markdown: string): ParsedRufloADR[] {
  const adrs: ParsedRufloADR[] = [];

  // Primary split: `# ADR-...` or `## ADR-...` style headers.
  // Secondary split: top-level `## ` headers (each section becomes one ADR).
  const explicitAdrRe = /^#{1,3}\s+ADR[-\s:]?\s*(\S+?)[:\s]+(.+?)$/gm;
  const explicitMatches: Array<{ start: number; headerEnd: number; id: string; title: string }> = [];
  let m: RegExpExecArray | null;
  while ((m = explicitAdrRe.exec(markdown)) !== null) {
    explicitMatches.push({
      start: m.index,
      headerEnd: m.index + m[0].length,
      id: `ADR-ENG-${String(explicitMatches.length + 1).padStart(3, '0')}`,
      title: (m[2] ?? '').trim(),
    });
  }

  let boundaries: Array<{ start: number; headerEnd: number; id: string; title: string }>;
  if (explicitMatches.length > 0) {
    boundaries = explicitMatches;
  } else {
    // Fall back: split on `## ` top-level headers.
    const h2Re = /^##\s+(.+?)$/gm;
    boundaries = [];
    let idx = 1;
    while ((m = h2Re.exec(markdown)) !== null) {
      boundaries.push({
        start: m.index,
        headerEnd: m.index + m[0].length,
        id: `ADR-ENG-${String(idx).padStart(3, '0')}`,
        title: (m[1] ?? `Architecture Decision ${idx}`).trim(),
      });
      idx += 1;
    }
  }

  if (boundaries.length === 0) return [];

  const today = new Date().toISOString().slice(0, 10);

  for (let i = 0; i < boundaries.length; i++) {
    const cur = boundaries[i]!;
    const nextStart = i + 1 < boundaries.length ? boundaries[i + 1]!.start : markdown.length;
    const rawMarkdown = markdown.slice(cur.headerEnd, nextStart).trim();

    // Extract sub-sections via `### <label>` headers.
    const extractSection = (label: string): string => {
      const re = new RegExp(`^###\\s+${label}\\s*$`, 'im');
      const match = re.exec(rawMarkdown);
      if (!match) return '';
      const sectionStart = match.index + match[0].length;
      // Next `###` or end of ADR body
      const nextSection = rawMarkdown.slice(sectionStart).search(/^###\s+/m);
      const sectionEnd = nextSection >= 0 ? sectionStart + nextSection : rawMarkdown.length;
      return rawMarkdown.slice(sectionStart, sectionEnd).trim();
    };

    const statusText = extractSection('Status').toLowerCase();
    const status: 'proposed' | 'accepted' | 'deprecated' =
      statusText.includes('deprecated') ? 'deprecated' :
      statusText.includes('accepted') ? 'accepted' :
      'proposed';

    adrs.push({
      id: cur.id,
      title: cur.title || `Architecture Decision ${i + 1}`,
      status,
      date: today,
      context: extractSection('Context'),
      decision: extractSection('Decision'),
      consequences: extractSection('Consequences'),
      rawMarkdown,
    });
  }

  return adrs;
}

/**
 * Render a parsed Ruflo ADR as a structured markdown file following the
 * canonical Status / Context / Decision / Consequences layout. Ruflo's
 * authored content is preserved verbatim in each section body; empty
 * sections fall back to `rawMarkdown` so no Ruflo prose is ever dropped.
 */
function renderRefinedAdrMarkdown(adr: ParsedRufloADR): string {
  const hasStructured = adr.context || adr.decision || adr.consequences;
  const lines: string[] = [];
  lines.push(`# ${adr.id}: ${adr.title}`);
  lines.push('');
  lines.push(`**Status:** ${adr.status}`);
  lines.push(`**Date:** ${adr.date}`);
  lines.push(`**Source:** Ruflo local-swarm (ADR-091)`);
  lines.push('');

  if (hasStructured) {
    lines.push('## Context');
    lines.push('');
    lines.push(adr.context || '_No context section in Ruflo output._');
    lines.push('');
    lines.push('## Decision');
    lines.push('');
    lines.push(adr.decision || '_No decision section in Ruflo output._');
    lines.push('');
    lines.push('## Consequences');
    lines.push('');
    lines.push(adr.consequences || '_No consequences section in Ruflo output._');
    lines.push('');
  } else {
    // No sub-section headers found — preserve Ruflo's body verbatim.
    lines.push(adr.rawMarkdown);
    lines.push('');
  }

  return lines.join('\n') + '\n';
}

/**
 * ADR-091 primary path for ADRs: read Ruflo's
 * `runDir/engineering/architecture-decisions.md`, parse into structured
 * entries, and write one markdown file per ADR plus an index JSON.
 * Returns null when Ruflo content is unavailable or parses to zero ADRs.
 */
function refineADRsFromRufloEngineering(
  runDir: string,
  phase4Dir: string,
): Phase2StageOutput | null {
  const start = Date.now();
  const rufloOut = readEngineeringArtifact(runDir, 'architecture-decisions.md');
  if (!rufloOut) return null;

  const parsed = parseRufloArchitectureDecisions(rufloOut.content);
  if (parsed.length === 0) {
    process.stderr.write(
      '[phase4-adrs] ADR-091: engineering/architecture-decisions.md present but parsed to 0 ADRs; ' +
        'falling through\n',
    );
    return null;
  }

  process.stderr.write(
    `[phase4-adrs] ADR-091: refining Ruflo engineering/architecture-decisions.md ` +
      `(${rufloOut.size} bytes → ${parsed.length} ADRs)\n`,
  );

  const adrDir = path.join(phase4Dir, 'adrs');
  fs.mkdirSync(adrDir, { recursive: true });
  const writtenPaths: string[] = [];

  for (const adr of parsed) {
    const filename = `${adr.id}.md`;
    const filePath = path.join(adrDir, filename);
    fs.writeFileSync(filePath, renderRefinedAdrMarkdown(adr), {
      encoding: 'utf-8',
      mode: 0o644,
    });
    writtenPaths.push(filePath);
  }

  // ADR-PIPELINE-100 §D2: derive the flat adr-index.json from the markdown
  // files we just wrote. The markdown is canonical; the index is navigational.
  writeAdrIndex(adrDir);
  writtenPaths.push(path.join(adrDir, 'adr-index.json'));

  // Phase4-internal data shape kept Phase2ADRRecord-compatible so consensus /
  // exec-summary readers that haven't been migrated yet still work. The
  // canonical artifacts on disk are the .md files + the flat index.
  const indexRecords: Phase2ADRRecord[] = parsed.map((adr) => ({
    id: adr.id,
    title: adr.title,
    status: adr.status,
    date: adr.date,
    context: adr.context || adr.rawMarkdown.slice(0, 2000),
    decision: adr.decision,
    alternatives: [],
    consequences: [],
    sparcSectionRefs: [],
    researchDossierItemRefs: [],
    rawMarkdown: adr.rawMarkdown,
  }));

  return tagStageOutput(
    {
      stage: 'adr-generation',
      status: 'completed',
      data: indexRecords,
      artifacts: writtenPaths,
      timing: Date.now() - start,
      summary: `     ADRs (ruflo-local): ${parsed.length} decisions refined from engineering/architecture-decisions.md`,
    },
    'ruflo-local',
  );
}

// ============================================================================
// ADR-091 Primary: Refine Ruflo's engineering/domain-model.md
// ============================================================================

/**
 * Extract bounded-context names from a Ruflo-produced domain model.
 * Scans for level-2 `## ` headers whose text looks like a bounded context
 * (e.g. `## Payments Context`, `## Order Management`). Used to populate a
 * lightweight `bounded-contexts.json` index so consensus/exec-summary readers
 * that expect a structured summary still see one.
 */
function extractBoundedContextSummaries(markdown: string): Array<{ name: string; description: string }> {
  const contexts: Array<{ name: string; description: string }> = [];
  const h2Re = /^##\s+(.+?)$/gm;
  let m: RegExpExecArray | null;
  const boundaries: Array<{ name: string; start: number; headerEnd: number }> = [];
  while ((m = h2Re.exec(markdown)) !== null) {
    boundaries.push({
      name: (m[1] ?? '').trim(),
      start: m.index,
      headerEnd: m.index + m[0].length,
    });
  }
  for (let i = 0; i < boundaries.length; i++) {
    const cur = boundaries[i]!;
    const nextStart = i + 1 < boundaries.length ? boundaries[i + 1]!.start : markdown.length;
    const body = markdown.slice(cur.headerEnd, nextStart).trim();
    // First non-empty paragraph becomes the description
    const firstParagraph = body.split(/\n\s*\n/)[0]?.trim() ?? '';
    contexts.push({ name: cur.name, description: firstParagraph.slice(0, 500) });
  }
  return contexts;
}

/**
 * ADR-091 primary path for DDD: read Ruflo's `runDir/engineering/domain-model.md`
 * and write it to `phase4Dir/ddd/domain-model.md` alongside a best-effort
 * `bounded-contexts.json` index. Returns null when Ruflo content is unavailable.
 */
function refineDDDFromRufloEngineering(
  runDir: string,
  phase4Dir: string,
): Phase2StageOutput | null {
  const start = Date.now();
  const rufloOut = readEngineeringArtifact(runDir, 'domain-model.md');
  if (!rufloOut) return null;

  process.stderr.write(
    `[phase4-ddd] ADR-091: refining Ruflo engineering/domain-model.md (${rufloOut.size} bytes)\n`,
  );

  const dddDir = path.join(phase4Dir, 'ddd');
  fs.mkdirSync(dddDir, { recursive: true });
  const writtenPaths: string[] = [];

  // Write Ruflo's markdown verbatim into the structured output location.
  const modelMdPath = path.join(dddDir, 'domain-model.md');
  const header = [
    '# Domain-Driven Design Model',
    '',
    `**Source:** Ruflo local-swarm (ADR-091)`,
    '',
    '',
  ].join('\n');
  fs.writeFileSync(modelMdPath, header + rufloOut.content, {
    encoding: 'utf-8',
    mode: 0o644,
  });
  writtenPaths.push(modelMdPath);

  // Write a best-effort structured bounded-context summary.
  const contexts = extractBoundedContextSummaries(rufloOut.content);
  if (contexts.length > 0) {
    const indexPath = path.join(dddDir, 'bounded-contexts.json');
    fs.writeFileSync(indexPath, JSON.stringify({ contexts }, null, 2) + '\n', {
      encoding: 'utf-8',
      mode: 0o644,
    });
    writtenPaths.push(indexPath);
  }

  return tagStageOutput(
    {
      stage: 'ddd-generation',
      status: 'completed',
      data: { contexts, rawMarkdown: rufloOut.content },
      artifacts: writtenPaths,
      timing: Date.now() - start,
      summary: `     DDD (ruflo-local): refined ${rufloOut.size}B engineering/domain-model.md (${contexts.length} bounded contexts)`,
    },
    'ruflo-local',
  );
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
  // ADR-091: Ruflo local-swarm is the PRIMARY producer of ADR content.
  // Remote / LLM generation paths are removed. The deterministic template
  // path below is retained as the last-resort (checkRufloAvailable() === false).
  // `phase2Ctx` is kept for compatibility; template code reads from it below.
  void phase2Ctx;
  console.error(`  >> [2/${STAGES.length}] ${STAGES[1]!.label}`);
  const adrSpan = createSpan('phase4-adrs-pipeline', 'adr-generation', {}, rootSpan.spanId);
  const phase4RunDir = path.dirname(context.phase2Dir);

  // Primary: refine Ruflo's engineering/architecture-decisions.md
  let adrOutput: Phase2StageOutput =
    refineADRsFromRufloEngineering(phase4RunDir, context.phase4Dir) ?? {
      stage: 'adr-generation',
      status: 'failed',
      data: { error: 'No usable engineering/architecture-decisions.md (Ruflo primary path)' },
      artifacts: [],
      timing: 0,
      summary: '',
    };

  // ADR-PIPELINE-100 §D5: Loud-failure replaces silent template fallback.
  // Fires when the Ruflo primary path produced no usable
  // engineering/architecture-decisions.md (regardless of whether Ruflo is
  // "available" as a binary). The previous behavior (call buildADRsFromSPARC
  // when Ruflo was reported unavailable) emitted template-substituted ADRs
  // that the user has classified as canned garbage. Loud failure surfaces
  // the regression at the artifact level instead.
  if (adrOutput.status === 'failed' || adrOutput.artifacts.length === 0) {
    const rufloAvailable = checkRufloAvailable().available;
    process.stderr.write(
      `[phase4-adrs] ADR-PIPELINE-100 §D5: emitting loud-failure ADR ` +
        `(ruflo ${rufloAvailable ? 'available but' : 'unavailable;'} produced no usable architecture-decisions.md)\n`,
    );

    try {
      const dossierStage = context.stageOutputs.get('research-dossier');
      const sparcStage = context.stageOutputs.get('sparc-specification');
      const dossier = (dossierStage?.data as ResearchDossier | undefined);
      const sparc = (sparcStage?.data as Phase2SPARCOutput | undefined);

      const failureAdr = buildLoudFailureADR({
        reason: 'Ruflo writer-agent path produced no usable engineering/architecture-decisions.md and Phase 2 LLM pass also did not yield content for refinement.',
        rufloFailureReason: rufloAvailable
          ? 'Ruflo available but emitted no usable architecture-decisions.md (writer task likely produced 0 files; see Ruflo logs)'
          : 'Ruflo binary unavailable in this execution context (checkRufloAvailable() returned available=false)',
        claudeFailureReason: 'Phase 2 generateADRs did not surface markdown ADRs into engineering/architecture-decisions.md before phase4-adrs ran',
        phase1Status: 'present',
        dossierItemCount: dossier?.items.length ?? 0,
        sparcStatus: (sparc?.architecture?.services?.length ?? 0) > 0 ? 'present' : 'missing-services',
        query: phase1Artifacts?.scenario?.query ?? phase1Artifacts?.manifest?.query ?? '',
      });

      const adrDir = path.join(context.phase4Dir, 'adrs');
      fs.mkdirSync(adrDir, { recursive: true });
      const writtenPaths: string[] = [];

      const failureFilePath = path.join(adrDir, `${failureAdr.id}.md`);
      fs.writeFileSync(failureFilePath, failureAdr.rawMarkdown ?? '', {
        encoding: 'utf-8',
        mode: 0o644,
      });
      writtenPaths.push(failureFilePath);

      // ADR-PIPELINE-100 §D2: derive the index from the markdown file we just
      // wrote so the loud-failure ADR appears in the index too.
      writeAdrIndex(adrDir);
      writtenPaths.push(path.join(adrDir, 'adr-index.json'));

      process.stderr.write(
        `[phase4-adrs] Loud-failure ADR written to ${path.relative(context.phase4Dir, failureFilePath)}\n`,
      );

      adrOutput = tagStageOutput(
        {
          stage: 'adr-generation',
          // Status remains 'failed' so downstream gates can distinguish a
          // real-success path from a loud-failure path. The stage still emits
          // artifacts (the failure ADR + index).
          status: 'failed',
          data: [failureAdr],
          artifacts: writtenPaths,
          timing: 0,
          summary: `     ADRs (loud-failure): 1 failure ADR written (ADR-PIPELINE-100 §D5; ${writtenPaths.length - 1} markdown + 1 JSON index)`,
        },
        'template',
      );
    } catch (failureErr: unknown) {
      process.stderr.write(
        `[phase4-adrs] Failed to emit loud-failure ADR: ${failureErr instanceof Error ? failureErr.message : String(failureErr)}\n`,
      );
    }
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
  // ADR-091: Ruflo local-swarm is the PRIMARY producer of DDD content.
  // The template path below remains only for the Ruflo-unavailable branch.
  console.error(`  >> [3/${STAGES.length}] ${STAGES[2]!.label}`);
  const dddSpan = createSpan('phase4-adrs-pipeline', 'ddd-generation', {}, rootSpan.spanId);

  // Primary: refine Ruflo's engineering/domain-model.md
  let dddOutput: Phase2StageOutput =
    refineDDDFromRufloEngineering(phase4RunDir, context.phase4Dir) ?? {
      stage: 'ddd-generation',
      status: 'failed',
      data: { error: 'No usable engineering/domain-model.md (Ruflo primary path)' },
      artifacts: [],
      timing: 0,
      summary: '',
    };

  // Last-resort template fallback (ADR-091 §3): fires ONLY when both
  //   (a) Ruflo engineering/domain-model.md is missing/empty, AND
  //   (b) checkRufloAvailable() reports no local Ruflo swarm capability.
  const dddRufloAvailable = checkRufloAvailable().available;
  if (
    (dddOutput.status === 'failed' || dddOutput.artifacts.length === 0) &&
    !dddRufloAvailable
  ) {
    process.stderr.write(
      '[phase4-ddd] ADR-091 template fallback: no engineering/domain-model.md ' +
        'AND ruflo unavailable — generating DDD from SPARC template\n',
    );
    try {
      const sparcStage = context.stageOutputs.get('sparc-specification');
      const dossierStage = context.stageOutputs.get('research-dossier');
      const sparc = sparcStage?.data as Phase2SPARCOutput;
      const dossier = dossierStage?.data as ResearchDossier;
      const adrsData = (adrOutput.data ?? []) as Phase2ADRRecord[];

      if (sparc && dossier) {
        const { buildPhase2DDD } = await import('../phase2/phases/ddd-generator.js');
        const dddModel = buildPhase2DDD(sparc, Array.isArray(adrsData) ? adrsData : [], dossier);

        // Write DDD files to phase4 output directory
        const dddDir = path.join(context.phase4Dir, 'ddd');
        const contextsDir = path.join(dddDir, 'contexts');
        fs.mkdirSync(contextsDir, { recursive: true });
        const writtenPaths: string[] = [];

        // Write domain model
        const modelPath = path.join(dddDir, 'domain-model.json');
        fs.writeFileSync(modelPath, JSON.stringify(dddModel, null, 2) + '\n', { encoding: 'utf-8', mode: 0o644 });
        writtenPaths.push(modelPath);

        // Write context map
        if (dddModel.contextMap) {
          const mapPath = path.join(dddDir, 'context-map.json');
          fs.writeFileSync(mapPath, JSON.stringify(dddModel.contextMap, null, 2) + '\n', { encoding: 'utf-8', mode: 0o644 });
          writtenPaths.push(mapPath);
        }

        // Write per-context files
        for (const ctx of dddModel.contexts ?? []) {
          const slug = ctx.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 60);
          const ctxPath = path.join(contextsDir, `${slug}.json`);
          fs.writeFileSync(ctxPath, JSON.stringify(ctx, null, 2) + '\n', { encoding: 'utf-8', mode: 0o644 });
          writtenPaths.push(ctxPath);
        }

        // Write markdown summary
        const mdPath = path.join(dddDir, 'DDD-Model.md');
        const mdLines = [
          '# Domain-Driven Design Model',
          '',
          `**Bounded Contexts:** ${(dddModel.contexts ?? []).length}`,
          '',
        ];
        for (const ctx of dddModel.contexts ?? []) {
          mdLines.push(`## ${ctx.name}`, '', ctx.description, '');
          for (const agg of ctx.aggregates ?? []) {
            mdLines.push(`### Aggregate: ${agg.root}`, '', `Name: ${agg.name}`, '');
          }
        }
        fs.writeFileSync(mdPath, mdLines.join('\n') + '\n', { encoding: 'utf-8', mode: 0o644 });
        writtenPaths.push(mdPath);

        process.stderr.write(`[phase4-ddd] Template fallback produced DDD model (${(dddModel.contexts ?? []).length} contexts, ${writtenPaths.length} files)\n`);

        dddOutput = tagStageOutput(
          {
            stage: 'ddd-generation',
            status: 'completed',
            data: dddModel,
            artifacts: writtenPaths,
            timing: 0,
            summary: `     DDD (template): ${(dddModel.contexts ?? []).length} bounded contexts (${writtenPaths.length} files)`,
          },
          'template',
        );
      }
    } catch (fallbackErr: unknown) {
      process.stderr.write(`[phase4-ddd] Template fallback also failed: ${fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr)}\n`);
    }
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
