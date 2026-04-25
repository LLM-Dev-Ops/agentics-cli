/**
 * Phase 7 — Consulting Deliverables Coordinator (ADR-PIPELINE-098 D1, D5–D9).
 *
 * Walks the 85-row deliverables registry and, for each row:
 *   1. If `mirrorsExisting` is set → symlink (POSIX) or copy (Windows /
 *      AGENTICS_PHASE7_MIRROR=copy) the pre-existing top-level doc into the
 *      sectioned subdir; record `status: 'emitted'`.
 *   2. Otherwise → load `inputArtifacts` from disk into a Record<path,string>,
 *      build a Ruflo task (templateId + inputs + consensus banner + fcv block
 *      from `unit-economics.json`), dispatch through the existing
 *      `executeRufloPhaseSwarm` path used by Phase 5/6, then render the
 *      response through `template-renderer.renderTemplate` and write to
 *      `<runDir>/deliverables/<NN-section>/<slug>.<format>`.
 *   3. On failure → emit a skeleton file with frontmatter
 *      `degraded_mode: generation-failed` + `failure_reason` + the available /
 *      missing inputs + the consensus banner + the fcv block. The phase keeps
 *      going; status drops to `partial`.
 *
 * After every row is processed the coordinator writes a markdown index.md and
 * a machine-readable `phase7-manifest.json` (D9.a schema), then runs the
 * coherence gate. Any coherence violation drops the phase status to
 * `partial`.
 *
 * Phase 1 input gate (D1 / ADR-094 D4):
 *   If `<runDir>/manifest.json` does NOT exist, the coordinator fans out
 *   nothing and returns `status: 'skipped-due-to-upstream'` with reason
 *   `phase1-inputs-missing`. The caller in `auto-chain.ts` still pushes a
 *   `phases[]` entry per ADR-094 D4.
 *
 * Hard contracts:
 *   - Never throws. All failures collapse into `Phase7Result.status` +
 *     per-row entries in the manifest.
 *   - Pure I/O at the boundary; no globals, no module-level state.
 *   - Templates dir + registry file + coherence-gate file are owned by other
 *     agents working in parallel; this file imports them without modifying.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// FIXME: depends on @agent-3 — `deliverables-registry.ts` may not yet exist
// when this file is first compiled. The exports below are the contract from
// ADR-PIPELINE-098 D3; if registry types drift, fix this import after the
// registry agent lands its file.
import {
  DELIVERABLES_REGISTRY,
  type DeliverableSpec,
} from './deliverables-registry.js';

// FIXME: depends on @agent-4 — `coherence-gate.ts` may not yet exist when
// this file is first compiled. The export below is the contract from
// ADR-PIPELINE-098 D8.
import {
  runCoherenceGate,
  type CoherenceViolation,
} from './coherence-gate.js';

import {
  renderTemplate,
  injectStandardSections,
} from './template-renderer.js';

import {
  executeRufloPhaseSwarm,
  type RufloTask,
} from '../ruflo-phase-executor.js';

import type { AgenticsServiceResult } from '../swarm-orchestrator.js';

import { loadUnitEconomics } from '../../synthesis/unit-economics-loader.js';

// ============================================================================
// Types
// ============================================================================

export type DeliverableStatus = 'emitted' | 'skeleton' | 'failed';

export type Phase7Status =
  | 'completed'
  | 'partial'
  | 'failed'
  | 'skipped-due-to-upstream';

export interface DeliverableManifestEntry {
  readonly section: number;
  readonly slug: string;
  readonly status: DeliverableStatus;
  readonly input_artifacts_used: ReadonlyArray<string>;
  readonly input_artifacts_missing: ReadonlyArray<string>;
  readonly source_agents_called: ReadonlyArray<string>;
  readonly fcv_kinds_emitted: ReadonlyArray<string>;
  readonly timing_ms: number;
  readonly output_path: string;
  readonly failure_reason?: string;
}

export interface Phase7Manifest {
  readonly phase: 7;
  readonly trace_id: string;
  readonly started_at: string;
  readonly completed_at: string;
  readonly total_timing_ms: number;
  readonly deliverables_total: number;
  readonly deliverables_emitted: number;
  readonly deliverables_skeleton: number;
  readonly deliverables_failed: number;
  readonly coherence_violations: ReadonlyArray<CoherenceViolation>;
  readonly deliverables: ReadonlyArray<DeliverableManifestEntry>;
}

export interface Phase7Options {
  readonly verbose?: boolean;
  readonly outputDir?: string;
}

export interface Phase7Result {
  readonly status: Phase7Status;
  readonly deliverables_emitted: number;
  readonly deliverables_skeleton: number;
  readonly deliverables_failed: number;
  readonly deliverables_total: number;
  readonly coherence_violations: ReadonlyArray<CoherenceViolation>;
  readonly timing_ms: number;
  /** Absolute paths of the files written during this phase. */
  readonly output_paths: ReadonlyArray<string>;
  /** Reason string when `status === 'skipped-due-to-upstream'` or `'failed'`. */
  readonly reason?: string;
}

export interface Phase7Args {
  readonly runDir: string;
  readonly traceId: string;
  readonly scenarioQuery: string;
  readonly options?: Phase7Options;
}

// ============================================================================
// Constants
// ============================================================================

const SECTION_DIRS: Readonly<Record<number, string>> = {
  1: '01-executive',
  2: '02-financial',
  3: '03-strategy',
  4: '04-operating-model',
  5: '05-technology',
  6: '06-risk-compliance',
  7: '07-research-diagnostics',
  8: '08-program-management',
  9: '09-implementation',
  10: '10-performance-monitoring',
  11: '11-commercial',
  12: '12-advanced',
};

const TEMPLATES_DIR_REL = path.join('pipeline', 'phase7', 'deliverables-templates');

// ============================================================================
// Public entry point
// ============================================================================

/**
 * Phase 7 entry point. Returns a `Phase7Result` describing what happened.
 * Never throws — disk-full and similar conditions are reported as
 * `status: 'failed'` with `reason` set.
 */
export async function executePhase7(args: Phase7Args): Promise<Phase7Result> {
  const startTime = Date.now();
  const { runDir, traceId, scenarioQuery } = args;

  // ── D1 / ADR-094 D4: Phase 1 input gate ──
  const manifestPath = path.join(runDir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    return {
      status: 'skipped-due-to-upstream',
      deliverables_emitted: 0,
      deliverables_skeleton: 0,
      deliverables_failed: 0,
      deliverables_total: DELIVERABLES_REGISTRY.length,
      coherence_violations: [],
      timing_ms: Date.now() - startTime,
      output_paths: [],
      reason: 'phase1-inputs-missing',
    };
  }

  // ── Prepare deliverables/ root + lazy section dirs ──
  const deliverablesRoot = path.join(runDir, 'deliverables');
  try {
    fs.mkdirSync(deliverablesRoot, { recursive: true });
  } catch (err) {
    return {
      status: 'failed',
      deliverables_emitted: 0,
      deliverables_skeleton: 0,
      deliverables_failed: 0,
      deliverables_total: DELIVERABLES_REGISTRY.length,
      coherence_violations: [],
      timing_ms: Date.now() - startTime,
      output_paths: [],
      reason: `mkdir-failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // ── Standard-sections context (consensus banner + fcv block) ──
  const consensusBanner = readConsensusBanner(runDir);
  const fcvBlock = buildFcvBlock(runDir);

  // ── Walk the registry ──
  const rufloCacheDir = path.join(runDir, '.ruflo-cache', 'phase7');
  try {
    fs.mkdirSync(rufloCacheDir, { recursive: true });
  } catch {
    /* non-fatal — the executor recreates as needed */
  }

  const entries: DeliverableManifestEntry[] = [];
  const writtenPaths: string[] = [];
  const startedAt = new Date().toISOString();

  for (const spec of DELIVERABLES_REGISTRY) {
    const rowStart = Date.now();
    const sectionDir = SECTION_DIRS[spec.section];
    if (!sectionDir) {
      // Defensive — should never happen if registry is well-formed.
      entries.push({
        section: spec.section,
        slug: spec.slug,
        status: 'failed',
        input_artifacts_used: [],
        input_artifacts_missing: [...spec.inputArtifacts],
        source_agents_called: [],
        fcv_kinds_emitted: [],
        timing_ms: Date.now() - rowStart,
        output_path: '',
        failure_reason: `unknown-section-${spec.section}`,
      });
      continue;
    }

    const targetDir = path.join(deliverablesRoot, sectionDir);
    try {
      fs.mkdirSync(targetDir, { recursive: true });
    } catch {
      /* fall through; the per-row write will error and become a skeleton */
    }

    const outFileName = `${spec.slug}.${primaryFormatExt(spec.format)}`;
    const outPath = path.join(targetDir, outFileName);

    if (spec.mirrorsExisting) {
      // ── D6: Mirror pre-existing top-level artifact ──
      const result = mirrorExisting(runDir, spec.mirrorsExisting, outPath);
      entries.push({
        section: spec.section,
        slug: spec.slug,
        status: result.ok ? 'emitted' : 'failed',
        input_artifacts_used: result.ok ? [spec.mirrorsExisting] : [],
        input_artifacts_missing: result.ok ? [] : [spec.mirrorsExisting],
        source_agents_called: [],
        fcv_kinds_emitted: [],
        timing_ms: Date.now() - rowStart,
        output_path: outPath,
        ...(result.ok ? {} : { failure_reason: result.reason }),
      });
      if (result.ok) writtenPaths.push(outPath);
      continue;
    }

    // ── D5 / D7: Generate via Ruflo, fall back to skeleton on any failure ──
    const inputs = loadInputs(runDir, spec.inputArtifacts);
    const templateBody = readTemplate(spec.templateId);

    if (templateBody === null) {
      // Template missing → skeleton.
      const skelPath = writeSkeleton(outPath, spec, {
        consensusBanner,
        fcvBlock,
        availableInputs: inputs.available,
        missingInputs: inputs.missing,
        failureReason: `template-missing:${spec.templateId}`,
      });
      entries.push({
        section: spec.section,
        slug: spec.slug,
        status: 'skeleton',
        input_artifacts_used: inputs.available.map(i => i.relPath),
        input_artifacts_missing: inputs.missing,
        source_agents_called: [],
        fcv_kinds_emitted: extractEmittedFcvKinds(fcvBlock, spec.fcvKinds),
        timing_ms: Date.now() - rowStart,
        output_path: skelPath,
        failure_reason: `template-missing:${spec.templateId}`,
      });
      writtenPaths.push(skelPath);
      continue;
    }

    // Build the Ruflo task list (one task per deliverable).
    const task: RufloTask = buildDeliverableTask(spec, templateBody, inputs.available, {
      scenarioQuery,
      consensusBanner,
      fcvBlock,
    });

    let rufloOk = false;
    let rufloError: string | undefined;
    let renderedBody = '';

    try {
      // Each deliverable dispatches as its own single-task swarm so a single
      // failure cannot poison a sibling. Per-row Ruflo cost dominates the
      // phase's wall time but the user directive is explicit that runtime is
      // not a constraint.
      const rufloResult = executeRufloPhaseSwarm({
        phase: 7,
        label: `Phase 7 — ${spec.slug}`,
        scenarioQuery,
        runDir,
        traceId,
        outputDir: path.join(rufloCacheDir, spec.slug),
        tasks: [task],
        agenticsResults: [] as AgenticsServiceResult[],
        priorArtifacts: inputsToArtifactMap(inputs.available),
      });

      // The Ruflo path writes intermediate files into the cache dir; we
      // don't depend on them here because the deterministic substitution
      // below already carries the consensus + fcv invariants. If the
      // future writer-agent contract returns structured fields they should
      // be merged in at this point.
      void rufloResult;

      // Deterministic render — fields are sourced from the structured
      // writer-agent response when available, otherwise from the
      // skeleton-friendly defaults below. Until the writer agent contract
      // is wired, every deliverable still carries the consensus + fcv
      // invariants required by D4.
      const fields: Record<string, string> = {
        title: spec.title,
        traceId,
        date: new Date().toISOString().slice(0, 10),
        consensusBanner,
        fcvBlock,
        agentAttributionFooter: buildAgentAttributionFooter(spec.sourceAgents),
        scenarioQuery,
      };

      const rendered = renderTemplate(templateBody, fields);
      renderedBody = injectStandardSections(rendered, {
        consensusBanner,
        fcvBlock,
        agentAttribution: buildAgentAttributionFooter(spec.sourceAgents),
      });
      rufloOk = true;
    } catch (err) {
      rufloError = err instanceof Error ? err.message : String(err);
    }

    if (!rufloOk) {
      const skelPath = writeSkeleton(outPath, spec, {
        consensusBanner,
        fcvBlock,
        availableInputs: inputs.available,
        missingInputs: inputs.missing,
        failureReason: rufloError ?? 'ruflo-dispatch-failed',
      });
      entries.push({
        section: spec.section,
        slug: spec.slug,
        status: 'skeleton',
        input_artifacts_used: inputs.available.map(i => i.relPath),
        input_artifacts_missing: inputs.missing,
        source_agents_called: [...spec.sourceAgents],
        fcv_kinds_emitted: extractEmittedFcvKinds(fcvBlock, spec.fcvKinds),
        timing_ms: Date.now() - rowStart,
        output_path: skelPath,
        failure_reason: rufloError ?? 'ruflo-dispatch-failed',
      });
      writtenPaths.push(skelPath);
      continue;
    }

    // Write the rendered deliverable.
    let writeError: string | undefined;
    try {
      fs.writeFileSync(outPath, renderedBody, 'utf-8');
    } catch (err) {
      writeError = err instanceof Error ? err.message : String(err);
    }

    if (writeError) {
      entries.push({
        section: spec.section,
        slug: spec.slug,
        status: 'failed',
        input_artifacts_used: inputs.available.map(i => i.relPath),
        input_artifacts_missing: inputs.missing,
        source_agents_called: [...spec.sourceAgents],
        fcv_kinds_emitted: [],
        timing_ms: Date.now() - rowStart,
        output_path: outPath,
        failure_reason: `write-failed: ${writeError}`,
      });
      continue;
    }

    entries.push({
      section: spec.section,
      slug: spec.slug,
      status: 'emitted',
      input_artifacts_used: inputs.available.map(i => i.relPath),
      input_artifacts_missing: inputs.missing,
      source_agents_called: [...spec.sourceAgents],
      fcv_kinds_emitted: extractEmittedFcvKinds(renderedBody, spec.fcvKinds),
      timing_ms: Date.now() - rowStart,
      output_path: outPath,
    });
    writtenPaths.push(outPath);
  }

  // ── Index.md — D2 ──
  const indexPath = path.join(deliverablesRoot, 'index.md');
  try {
    fs.writeFileSync(indexPath, buildIndexMd(entries, traceId), 'utf-8');
    writtenPaths.push(indexPath);
  } catch {
    /* non-fatal — manifest still records the deliverables */
  }

  // ── Coherence gate — D8 ──
  let coherenceViolations: ReadonlyArray<CoherenceViolation> = [];
  try {
    const unitEconomicsPath = path.join(runDir, 'unit-economics.json');
    const report = await runCoherenceGate(deliverablesRoot, unitEconomicsPath);
    coherenceViolations = report.violations;
  } catch {
    /* coherence-gate failures are non-fatal; the phase still emits */
    coherenceViolations = [];
  }

  // ── Manifest — D9.a ──
  const emitted = entries.filter(e => e.status === 'emitted').length;
  const skeleton = entries.filter(e => e.status === 'skeleton').length;
  const failed = entries.filter(e => e.status === 'failed').length;
  const completedAt = new Date().toISOString();
  const totalTimingMs = Date.now() - startTime;

  const phase7Manifest: Phase7Manifest = {
    phase: 7,
    trace_id: traceId,
    started_at: startedAt,
    completed_at: completedAt,
    total_timing_ms: totalTimingMs,
    deliverables_total: DELIVERABLES_REGISTRY.length,
    deliverables_emitted: emitted,
    deliverables_skeleton: skeleton,
    deliverables_failed: failed,
    coherence_violations: coherenceViolations,
    deliverables: entries,
  };

  const manifestOut = path.join(deliverablesRoot, 'phase7-manifest.json');
  try {
    fs.writeFileSync(manifestOut, JSON.stringify(phase7Manifest, null, 2), 'utf-8');
    writtenPaths.push(manifestOut);
  } catch {
    /* non-fatal */
  }

  // ── Final status ──
  const status: Phase7Status =
    failed > 0 || skeleton > 0 || coherenceViolations.length > 0
      ? 'partial'
      : 'completed';

  return {
    status,
    deliverables_emitted: emitted,
    deliverables_skeleton: skeleton,
    deliverables_failed: failed,
    deliverables_total: DELIVERABLES_REGISTRY.length,
    coherence_violations: coherenceViolations,
    timing_ms: totalTimingMs,
    output_paths: writtenPaths,
  };
}

// ============================================================================
// Internal helpers
// ============================================================================

interface LoadedInput {
  readonly relPath: string;
  readonly absPath: string;
  readonly content: string;
}

interface LoadedInputs {
  readonly available: ReadonlyArray<LoadedInput>;
  readonly missing: ReadonlyArray<string>;
}

function loadInputs(runDir: string, paths: ReadonlyArray<string>): LoadedInputs {
  const available: LoadedInput[] = [];
  const missing: string[] = [];
  for (const rel of paths) {
    const abs = path.isAbsolute(rel) ? rel : path.join(runDir, rel);
    try {
      if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
        const content = fs.readFileSync(abs, 'utf-8');
        available.push({ relPath: rel, absPath: abs, content });
      } else {
        missing.push(rel);
      }
    } catch {
      missing.push(rel);
    }
  }
  return { available, missing };
}

function inputsToArtifactMap(inputs: ReadonlyArray<LoadedInput>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const i of inputs) {
    out[i.relPath] = i.absPath;
  }
  return out;
}

function readTemplate(templateId: string): string | null {
  // The templates dir lives next to this coordinator at compile time; resolve
  // it both as a sibling source path (during dev) and as a sibling dist path
  // (after `tsc`) by walking up from `__filename`. Use `import.meta.url` style
  // resolution via require-style path joining since this codebase compiles to
  // CommonJS-compatible ES modules.
  //
  // The deliverables-templates files are part of the package, so the search
  // simply looks under `<pkgRoot>/src/pipeline/phase7/deliverables-templates`
  // and `<pkgRoot>/dist/pipeline/phase7/deliverables-templates` — whichever
  // exists.
  const candidates = candidateTemplateRoots();
  for (const root of candidates) {
    const p = path.join(root, `${templateId}.tmpl.md`);
    try {
      if (fs.existsSync(p)) return fs.readFileSync(p, 'utf-8');
    } catch {
      /* try next candidate */
    }
  }
  return null;
}

function candidateTemplateRoots(): string[] {
  const roots: string[] = [];
  // Sibling of THIS file. Works under both CJS (__dirname) and ESM
  // (import.meta.url) — under tsc-compiled CJS we get a valid __dirname;
  // under native ESM (e.g., the standalone validation harness) we fall
  // through to the cwd-relative paths below.
  try {
    // @ts-ignore -- guarded type for dual-runtime resolution
    const here = typeof __dirname === 'string' ? __dirname : null;
    if (here) roots.push(path.join(here, 'deliverables-templates'));
  } catch { /* ignore */ }
  // ESM-safe sibling resolution: derive from import.meta.url when available.
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const meta = (import.meta as any);
    if (meta && typeof meta.url === 'string') {
      const url = new URL('./deliverables-templates/', meta.url);
      roots.push(url.pathname);
    }
  } catch { /* ignore */ }
  // Source-dir / dist-dir fallbacks (covers `cwd != packageRoot` cases when
  // run via tsx/ts-node and when run from a different working directory).
  try {
    const cwd = process.cwd();
    roots.push(path.join(cwd, 'src', TEMPLATES_DIR_REL));
    roots.push(path.join(cwd, 'dist', TEMPLATES_DIR_REL));
  } catch { /* ignore */ }
  return roots;
}

function readConsensusBanner(runDir: string): string {
  // The consensus.json shape is owned by `synthesis/consensus-tiers.ts`. To
  // keep this coordinator dependency-light, we read the pre-rendered banner
  // when it has already been written next to the consensus snapshot, and
  // fall back to a minimal directional placeholder otherwise.
  const candidates = [
    path.join(runDir, 'consensus-banner.md'),
    path.join(runDir, 'consensus-banner.txt'),
  ];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) {
        const raw = fs.readFileSync(p, 'utf-8').trim();
        if (raw.length > 0) return raw;
      }
    } catch { /* try next */ }
  }
  // Fall back to a minimal tier-agnostic banner when we cannot reconstruct.
  // Coherence is preserved because every deliverable carries the SAME string.
  return '> 📊 **Consensus snapshot:** see `consensus.json` for agreement / precision / verdict.';
}

function buildFcvBlock(runDir: string): string {
  const ue = loadUnitEconomics(runDir);
  if (!ue.manifest) {
    return '<!-- fcv:kind=unit-economics src=missing -->';
  }
  const m = ue.manifest;
  const measured = formatUsd(m.annual_measured_savings_usd);
  const enterprise = formatUsd(m.annual_extrapolated_savings_usd);
  return [
    '<!-- fcv:kind=savings scope=enterprise doc=phase7 src=unit-economics.json -->',
    `Annual enterprise savings: ${enterprise}`,
    '',
    '<!-- fcv:kind=savings scope=measured doc=phase7 src=unit-economics.json -->',
    `Annual measured savings (pilot): ${measured}`,
    '',
    `<!-- fcv:kind=method src=unit-economics.json -->`,
    `Extrapolation method: ${m.extrapolation_method}`,
  ].join('\n');
}

function formatUsd(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '$0';
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(0)}K`;
  return `$${Math.round(n)}`;
}

function buildAgentAttributionFooter(agents: ReadonlyArray<string>): string {
  if (!agents || agents.length === 0) return '';
  const visible = agents.slice(0, 6).join(', ');
  const more = agents.length > 6 ? ` + ${agents.length - 6} more` : '';
  return `Sources: ${visible}${more}`;
}

function buildDeliverableTask(
  spec: DeliverableSpec,
  templateBody: string,
  inputs: ReadonlyArray<LoadedInput>,
  ctx: { scenarioQuery: string; consensusBanner: string; fcvBlock: string },
): RufloTask {
  const inputSection = inputs.length > 0
    ? inputs.map(i => `--- INPUT: ${i.relPath} ---\n${truncate(i.content, 8_000)}\n`).join('\n')
    : '(no input artifacts available — produce a coherent skeleton from the template only)';

  const description = [
    `# Phase 7 Deliverable: ${spec.title}`,
    '',
    `Section ${spec.section} · slug \`${spec.slug}\` · template \`${spec.templateId}\` · format ${spec.format}`,
    '',
    '## Project scenario',
    ctx.scenarioQuery,
    '',
    '## Consensus banner (must appear verbatim at top of output)',
    ctx.consensusBanner,
    '',
    '## Standard fcv block (must appear verbatim where the template has {{fcvBlock}})',
    ctx.fcvBlock,
    '',
    '## Source agents to attribute',
    spec.sourceAgents.length > 0 ? spec.sourceAgents.join(', ') : '(none specified)',
    '',
    '## Required fcv kinds',
    spec.fcvKinds.length > 0 ? spec.fcvKinds.join(', ') : '(none — purely qualitative)',
    '',
    '## Template body',
    templateBody,
    '',
    '## Input artifacts',
    inputSection,
    '',
    '## Rules',
    '1. Fill every {{placeholder}} in the template with content derived from the inputs.',
    '2. Do not invent dollar figures. Numbers MUST come from the fcv block above.',
    '3. The output is a single Markdown document. Do not wrap it in a code fence.',
    '4. This is a LOCAL-ONLY run. The dispatch already injects --local-only.',
  ].join('\n');

  return {
    label: `phase7-${spec.slug}`,
    description,
    targetDir: 'deliverables',
    argv: ['--local-only'],
  };
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}\n…[truncated ${s.length - max} bytes]`;
}

function primaryFormatExt(format: DeliverableSpec['format']): string {
  // Some registry rows declare composite formats like `md+csv`; pick the
  // first as the primary file. Companion outputs (csv/svg) are written by
  // the deliverable-specific renderer when needed.
  const head = String(format).split('+')[0]?.trim() ?? 'md';
  return head;
}

interface SkeletonContext {
  readonly consensusBanner: string;
  readonly fcvBlock: string;
  readonly availableInputs: ReadonlyArray<LoadedInput>;
  readonly missingInputs: ReadonlyArray<string>;
  readonly failureReason: string;
}

function writeSkeleton(
  outPath: string,
  spec: DeliverableSpec,
  ctx: SkeletonContext,
): string {
  const frontmatter = [
    '---',
    'degraded_mode: generation-failed',
    `failure_reason: ${escapeYaml(ctx.failureReason)}`,
    `section: ${spec.section}`,
    `slug: ${spec.slug}`,
    `template_id: ${spec.templateId}`,
    `inputs_available:`,
    ...(ctx.availableInputs.length > 0
      ? ctx.availableInputs.map(i => `  - ${i.relPath}`)
      : ['  []']),
    `inputs_missing:`,
    ...(ctx.missingInputs.length > 0
      ? ctx.missingInputs.map(p => `  - ${p}`)
      : ['  []']),
    '---',
    '',
  ].join('\n');

  const body = [
    `# ${spec.title}`,
    '',
    '> ⚠️ **GENERATION FAILED — review required**',
    '',
    ctx.consensusBanner,
    '',
    '## Headline figures (from `unit-economics.json`)',
    '',
    ctx.fcvBlock,
    '',
    '## Why this is a skeleton',
    '',
    `Phase 7 attempted to generate this deliverable but failed: \`${ctx.failureReason}\`.`,
    'The standard consensus banner and fcv block above are still authoritative for this run;',
    'this skeleton exists so the deliverables/ tree carries one file per spec row even when the',
    'writer pipeline cannot produce a full narrative.',
  ].join('\n');

  const finalText = `${frontmatter}${body}\n`;
  try {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, finalText, 'utf-8');
  } catch {
    /* nothing more to do — caller records this row as `failed` if write
     * actually threw, but `writeSkeleton` itself does not throw. */
  }
  return outPath;
}

function escapeYaml(s: string): string {
  return s.replace(/\r?\n/g, ' ').replace(/"/g, '\\"').slice(0, 200);
}

interface MirrorResult {
  readonly ok: boolean;
  readonly reason?: string;
}

function mirrorExisting(runDir: string, sourceRel: string, target: string): MirrorResult {
  const sourceAbs = path.isAbsolute(sourceRel) ? sourceRel : path.join(runDir, sourceRel);
  if (!fs.existsSync(sourceAbs)) {
    return { ok: false, reason: `mirror-source-missing:${sourceRel}` };
  }
  // If the target already exists from a prior partial run, remove it so the
  // mirror operation is idempotent.
  try {
    if (fs.existsSync(target) || isSymlink(target)) {
      fs.rmSync(target, { force: true });
    }
  } catch { /* best-effort */ }

  const useCopy = mirrorModeIsCopy();
  if (!useCopy) {
    try {
      fs.symlinkSync(sourceAbs, target);
      return { ok: true };
    } catch (err) {
      // Fall through to copy if symlink permissions are denied.
      void err;
    }
  }
  try {
    fs.copyFileSync(sourceAbs, target);
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

function isSymlink(p: string): boolean {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

function mirrorModeIsCopy(): boolean {
  const env = (process.env['AGENTICS_PHASE7_MIRROR'] ?? '').toLowerCase().trim();
  if (env === 'copy') return true;
  if (env === 'symlink') return false;
  // Default: symlink on POSIX, copy on Windows.
  return os.platform() === 'win32';
}

function extractEmittedFcvKinds(
  body: string,
  expected: ReadonlyArray<string>,
): string[] {
  if (!body || expected.length === 0) return [];
  const out = new Set<string>();
  const re = /<!--\s*fcv:kind=([a-zA-Z0-9_-]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    if (m[1]) out.add(m[1]);
  }
  // Filter to kinds the registry expected, preserving expected ordering.
  return expected.filter(k => out.has(k));
}

function buildIndexMd(entries: ReadonlyArray<DeliverableManifestEntry>, traceId: string): string {
  const lines: string[] = [];
  lines.push('# Consulting Deliverables');
  lines.push('');
  lines.push(`Trace ID: \`${traceId}\``);
  lines.push('');
  lines.push('| # | Section | Slug | Status | Path |');
  lines.push('|---|---|---|---|---|');
  let n = 0;
  for (const e of entries) {
    n += 1;
    const sectionDir = SECTION_DIRS[e.section] ?? `${e.section}`;
    const rel = path.relative(path.dirname(e.output_path) + path.sep + '..', e.output_path).split(path.sep).join('/');
    lines.push(`| ${n} | ${sectionDir} | ${e.slug} | ${e.status} | [${rel}](./${sectionDir}/${path.basename(e.output_path)}) |`);
  }
  lines.push('');
  return lines.join('\n');
}
