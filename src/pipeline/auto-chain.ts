/**
 * Auto-Chain Pipeline Orchestrator
 *
 * Automatically chains Phases 2-6 after enterprise simulation (Phase 1).
 * Each phase reads artifacts from prior phases in ~/.agentics/runs/<traceId>/.
 *
 * This replaces the old executePipeline() which used weak generic stages.
 * The auto-chain calls the actual phase coordinators (phase2 through phase6)
 * that produce high-fidelity artifacts:
 *   Phase 2: Deep Research (research dossier from Phase 1 documents)
 *   Phase 3: SPARC + London TDD (specification, pseudocode, architecture, refinement, completion + test plan)
 *   Phase 4: ADRs + DDDs (architecture decision records + domain-driven design models)
 *   Phase 5: Build (code generation + deployable service from ADRs/DDDs)
 *   Phase 6: ERP Surface Push (registration + project materialization)
 */

import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { executePhase2Command, formatPhase2ForDisplay } from '../commands/phase2.js';
import { executePhase3Command, formatPhase3ForDisplay } from '../commands/phase3.js';
import { executePhase4Command, formatPhase4ForDisplay } from '../commands/phase4.js';
import { executePhase5Command, formatPhase5ForDisplay } from '../commands/phase5.js';
import { executePhase6Command, formatPhase6ForDisplay, copyTreeForOutput } from '../commands/phase6.js';
import {
  detectExecutionMode,
  commitScenarioFiles,
  type ExecutionMode,
  type ExecutionContext,
} from './execution-context.js';
import {
  initSwarm,
  dispatchPhaseAgents,
  storePhaseArtifacts,
  reviewPhaseOutput,
  recordPhaseFailure,
  shutdownSwarm,
  invokeRufloCodingSwarm,
  PHASE_AGENTS,
  type AgenticsServiceResult,
} from './swarm-orchestrator.js';
import {
  executeRufloPhaseSwarm,
  buildPhase2Tasks,
  buildPhase3Tasks,
  buildPhase4Tasks,
  buildPhase5Tasks,
  buildPhase6Tasks,
  collectPhase2Artifacts,
  collectPhase3Artifacts,
  collectPhase4Artifacts,
  collectPhase5Artifacts,
  collectPhase6Artifacts,
  extractPhase1AgentCode,
  runPrimaryPhaseExecution,
  type Phase1Dossier,
  type RufloExecutionContext,
  type PrimaryPhaseExecutionResult,
  type PrimaryPhaseId,
} from './ruflo-phase-executor.js';
import {
  gatePhaseInputs,
  determineBlockedPhases,
  type PhaseId as GatePhaseId,
  type GateResult,
  type BlockedPhase,
} from './gate/phase-dependency-gate.js';
import {
  validateSparc,
  validateAdrDir,
  validateImplementationPrompts,
  logStructuralFailures,
} from './output-validator.js';

// ============================================================================
// Types
// ============================================================================

export interface AutoChainOptions {
  readonly verbose?: boolean;
  readonly outputDir?: string;
  readonly executionMode?: ExecutionMode;
}

/**
 * ADR-094 Decision 4 — `skipped-due-to-upstream` is a distinct phase-result
 * state from `skipped` (which means "phase opted out") and `failed` (which
 * means "phase ran and errored"). It signals "this phase did not run because
 * an upstream phase was failed/blocked and we propagated", and ensures the
 * `chainResult.phases[]` trace contract holds even when Phase 5 fails before
 * Phase 6 runs. Pre-094 Phase 6 was invisible in the trace on upstream
 * failure; under 094 it is always present with this status.
 */
export type PhaseStatus = 'completed' | 'failed' | 'skipped' | 'skipped-due-to-upstream';

export interface PhaseResult {
  phase: number;
  label: string;
  status: PhaseStatus;
  timing: number;
  artifacts: string[];
  outputDir: string;
  error?: string;
  agenticsAgents?: { total: number; responded: number; domains: string[] };
}

export interface AutoChainResult {
  traceId: string;
  runDir: string;
  phases: PhaseResult[];
  totalTiming: number;
  success: boolean;
  executionMode: ExecutionMode;
  scenarioBranch?: string;
  commitHash?: string;
  githubUrl?: string;
  /**
   * ADR-PIPELINE-093 §Rule 3 — phases whose prerequisites were unreachable
   * after Ruflo retry. Surfaces to `formatAutoChainForDisplay` as a final
   * banner warning. Mirrors `manifest.json.blocked_phases` and
   * `status.json.blocked_phases`; present (possibly `[]`) on every result
   * so downstream consumers treat the shape as stable.
   */
  blockedPhases?: Array<{ phase: string; missing: ReadonlyArray<string> }>;
}

/** Extract path strings from any manifest artifact array (objects with .path or plain strings). */
function extractArtifactPaths(artifacts: ReadonlyArray<string | { path: string }>): string[] {
  return artifacts.map(a => typeof a === 'string' ? a : a.path);
}

// ============================================================================
// Progressive Artifact Copy — runs after EVERY phase so .agentics/plans/ is
// always up to date even if later phases fail or timeout.
// ============================================================================

/** Check whether src and dest files have identical content (by size + bytes). */
function filesAreIdentical(src: string, dest: string): boolean {
  try {
    const srcStat = fs.statSync(src);
    const destStat = fs.statSync(dest);
    if (srcStat.size !== destStat.size) return false;
    // For small files compare content directly; for large files size match is sufficient
    if (srcStat.size > 1024 * 1024) return true;
    const srcBuf = fs.readFileSync(src);
    const destBuf = fs.readFileSync(dest);
    return srcBuf.equals(destBuf);
  } catch {
    return false;
  }
}

function copyDirRecursive(src: string, dest: string): { copied: number; skipped: number } {
  if (!fs.existsSync(src)) return { copied: 0, skipped: 0 };
  fs.mkdirSync(dest, { recursive: true });
  let copied = 0;
  let skipped = 0;
  for (const entry of fs.readdirSync(src)) {
    const srcPath = path.join(src, entry);
    const destPath = path.join(dest, entry);
    const stat = fs.statSync(srcPath);
    if (stat.isFile()) {
      if (fs.existsSync(destPath) && filesAreIdentical(srcPath, destPath)) {
        skipped++;
      } else {
        fs.copyFileSync(srcPath, destPath);
        copied++;
      }
    } else if (stat.isDirectory()) {
      const sub = copyDirRecursive(srcPath, destPath);
      copied += sub.copied;
      skipped += sub.skipped;
    }
  }
  return { copied, skipped };
}

// ============================================================================
// ADR-PIPELINE-092 — Runs-to-plans promotion completeness
// ----------------------------------------------------------------------------
// Table-driven candidate-source discovery + engineering/ (Ruflo primary
// output) → plans/ mapping. Shared between the progressive per-phase copy
// and the final safety-net call so both use the exact same inventory.
// ============================================================================

/** Canonical slot names in `.agentics/plans/`. */
export type PlanSlot = 'sparc' | 'adrs' | 'ddd' | 'tdd' | 'prompts' | 'implementation';

/** Describes one candidate source for a plan slot. */
interface CandidateSource {
  /** Path relative to `runDir`. */
  readonly relPath: string;
  /** Directory of files or a single file. */
  readonly kind: 'dir' | 'file';
  /**
   * When `kind === 'file'`, the destination filename inside the slot. When
   * `kind === 'dir'`, merge additively (every file inside keeps its name).
   */
  readonly destFilename?: string;
  /**
   * When set, only promote this source if the slot's destination directory
   * is currently empty. Phase-refined sources leave this undefined so they
   * always take precedence.
   */
  readonly requireSlotEmpty?: boolean;
  /**
   * When true, promotion is additive — files are merged into the slot even
   * if it already has content from a higher-priority source. Used for the
   * `engineering/implementation-roadmap.md` single-file promotion.
   */
  readonly additive?: boolean;
  /**
   * When set, the engineering-primary-output contract applies: size threshold
   * + hash allow-listed placeholders are rejected before promotion fires.
   */
  readonly engineeringPrimary?: boolean;
  /**
   * Optional header line prepended when promoting an `engineering/*.md`
   * single-file source. Identifies Ruflo primary output so later phase-4
   * refinement passes overwrite cleanly.
   */
  readonly rufloHeader?: string;
}

/**
 * Ordered candidate-source table (Rule 1). First non-empty source wins for
 * each slot; later sources only fill a slot that is still empty, unless the
 * source is marked `additive`.
 */
const PLAN_SLOT_SOURCES: Readonly<Record<PlanSlot, ReadonlyArray<CandidateSource>>> = {
  sparc: [
    { relPath: 'phase3/sparc', kind: 'dir' },
    { relPath: 'phase2/sparc', kind: 'dir' },
    {
      relPath: 'engineering/sparc-specification.md',
      kind: 'file',
      destFilename: 'specification.md',
      requireSlotEmpty: true,
      engineeringPrimary: true,
      rufloHeader:
        '<!-- Ruflo primary output (ADR-PIPELINE-092) — will be overwritten when Phase 3 produces structured SPARC artifacts -->',
    },
  ],
  adrs: [
    { relPath: 'phase4/adrs', kind: 'dir' },
    { relPath: 'phase2/adrs', kind: 'dir' },
    {
      relPath: 'engineering/architecture-decisions.md',
      kind: 'file',
      destFilename: 'ADR-ENG-001-architecture-decisions.md',
      requireSlotEmpty: true,
      engineeringPrimary: true,
      rufloHeader:
        '<!-- Ruflo primary output (ADR-PIPELINE-092) — will be overwritten when Phase 4 produces structured ADRs -->',
    },
    { relPath: 'adrs', kind: 'dir' },
  ],
  ddd: [
    { relPath: 'phase4/ddd', kind: 'dir' },
    { relPath: 'phase2/ddd', kind: 'dir' },
    {
      relPath: 'engineering/domain-model.md',
      kind: 'file',
      destFilename: 'domain-model.md',
      requireSlotEmpty: true,
      engineeringPrimary: true,
      rufloHeader:
        '<!-- Ruflo primary output (ADR-PIPELINE-092) — will be overwritten when Phase 4 produces a structured domain model -->',
    },
  ],
  tdd: [
    { relPath: 'phase3/tdd', kind: 'dir' },
    { relPath: 'phase2/tdd', kind: 'dir' },
    {
      relPath: 'engineering/tdd-test-plan.md',
      kind: 'file',
      destFilename: 'test-plan.md',
      requireSlotEmpty: true,
      engineeringPrimary: true,
      rufloHeader:
        '<!-- Ruflo primary output (ADR-PIPELINE-092) — will be overwritten when Phase 3 produces a structured TDD plan -->',
    },
  ],
  prompts: [
    { relPath: 'prompts', kind: 'dir' },
    { relPath: 'phase4/prompts', kind: 'dir' },
    {
      relPath: 'phase3/implementation-prompt.md',
      kind: 'file',
      destFilename: 'phase3-implementation-prompt.md',
    },
  ],
  implementation: [
    { relPath: 'phase1/roadmap.json', kind: 'file', destFilename: 'roadmap.json' },
    { relPath: 'roadmap.json', kind: 'file', destFilename: 'roadmap.json' },
    { relPath: 'scenario.json', kind: 'file', destFilename: 'scenario.json' },
    {
      relPath: 'engineering/implementation-roadmap.md',
      kind: 'file',
      destFilename: 'roadmap.md',
      additive: true,
      engineeringPrimary: true,
      rufloHeader:
        '<!-- Ruflo primary output (ADR-PIPELINE-092) — promoted alongside Phase 1 roadmap.json -->',
    },
  ],
};

/**
 * Engineering (Ruflo primary-output) placeholder threshold — any single-file
 * engineering source whose size is at or below this value is rejected as a
 * stub and never promoted.
 */
const ENGINEERING_MIN_SIZE_BYTES = 256;

/**
 * sha256 hashes of known placeholder templates that Ruflo may emit before it
 * has real content. Any engineering/*.md file whose content hash matches is
 * rejected even if its size is above the threshold. Starts empty but the
 * `has()` lookup is O(1) and additions here propagate automatically.
 */
const ENGINEERING_PLACEHOLDER_HASHES: ReadonlySet<string> = new Set<string>([]);

/** Per-slot promotion counts + MISSING detection. */
export interface PlanPromotionSummary {
  readonly counts: Record<PlanSlot, number>;
  readonly missing_slots: PlanSlot[];
  readonly total_copied: number;
  readonly total_skipped: number;
}

/**
 * Pick the single best candidate source for a slot given which slot files
 * are already present. Phase-refined sources (no `requireSlotEmpty`) win
 * over `engineering/*` (which sets `requireSlotEmpty: true`). Returns `null`
 * when nothing qualifies.
 */
function pickBestSourceForSlot(
  runDir: string,
  _slot: PlanSlot,
  slotHasContent: boolean,
  candidateSources: ReadonlyArray<CandidateSource>,
): CandidateSource | null {
  for (const source of candidateSources) {
    if (source.requireSlotEmpty && slotHasContent) continue;
    const abs = path.join(runDir, source.relPath);
    if (!fs.existsSync(abs)) continue;
    if (source.kind === 'dir') {
      try {
        const entries = fs.readdirSync(abs);
        if (entries.length === 0) continue;
      } catch { continue; }
    } else {
      try {
        const st = fs.statSync(abs);
        if (!st.isFile() || st.size === 0) continue;
      } catch { continue; }
    }
    return source;
  }
  return null;
}

/** Returns true if the directory exists and has at least one file inside it (recursively). */
function slotDirHasFiles(slotDir: string): boolean {
  if (!fs.existsSync(slotDir)) return false;
  try {
    const entries = fs.readdirSync(slotDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile()) return true;
      if (entry.isDirectory()) {
        if (slotDirHasFiles(path.join(slotDir, entry.name))) return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Gate an engineering/*.md source through the placeholder threshold: size
 * must exceed ENGINEERING_MIN_SIZE_BYTES and its sha256 must not be in the
 * ENGINEERING_PLACEHOLDER_HASHES allow-list. Returns the file buffer on
 * pass, or `null` on reject.
 */
function readEngineeringPrimaryOrReject(absPath: string): Buffer | null {
  try {
    const stat = fs.statSync(absPath);
    if (stat.size <= ENGINEERING_MIN_SIZE_BYTES) return null;
    const buf = fs.readFileSync(absPath);
    const hash = createHash('sha256').update(buf).digest('hex');
    if (ENGINEERING_PLACEHOLDER_HASHES.has(hash)) return null;
    return buf;
  } catch {
    return null;
  }
}

/**
 * Promote a single source into a slot. Returns `{copied, skipped}` counts.
 * For `kind === 'dir'` sources this performs an additive file-level merge
 * (dedup by destination filename, byte-identical skips). For `kind === 'file'`
 * sources it writes a single file, optionally prepending the Ruflo header.
 */
function promoteSourceIntoSlot(
  runDir: string,
  slotDir: string,
  source: CandidateSource,
): { copied: number; skipped: number } {
  const absSrc = path.join(runDir, source.relPath);
  if (!fs.existsSync(absSrc)) return { copied: 0, skipped: 0 };

  if (source.kind === 'dir') {
    return copyDirRecursive(absSrc, slotDir);
  }

  // kind === 'file'
  const destName = source.destFilename ?? path.basename(source.relPath);
  const destPath = path.join(slotDir, destName);
  let buf: Buffer | null;
  if (source.engineeringPrimary) {
    buf = readEngineeringPrimaryOrReject(absSrc);
    if (buf === null) return { copied: 0, skipped: 0 };
  } else {
    try { buf = fs.readFileSync(absSrc); } catch { return { copied: 0, skipped: 0 }; }
  }

  // Prepend Ruflo header when applicable.
  let outBuf: Buffer = buf;
  if (source.rufloHeader) {
    const needsHeader = !buf.toString('utf-8').startsWith(source.rufloHeader);
    if (needsHeader) {
      outBuf = Buffer.from(`${source.rufloHeader}\n\n${buf.toString('utf-8')}`, 'utf-8');
    }
  }

  // Dedup: if destination already exists and matches byte-for-byte, skip.
  if (fs.existsSync(destPath)) {
    try {
      const existing = fs.readFileSync(destPath);
      if (existing.equals(outBuf)) return { copied: 0, skipped: 1 };
    } catch { /* fall through to overwrite */ }
  }

  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  fs.writeFileSync(destPath, outBuf);
  return { copied: 1, skipped: 0 };
}

/**
 * Shared table-driven promotion routine (ADR-PIPELINE-092, Rules 1–5).
 *
 * Walks `PLAN_SLOT_SOURCES` for every slot, picks the best source via
 * `pickBestSourceForSlot`, promotes the source into the slot, then runs
 * any additive sources on top. Emits the `[PLANS] promoted ...` stderr
 * summary and one `[PLANS] MISSING <slot>` line per empty-and-unrecoverable
 * slot. Returns the summary so callers (final safety-net call) can merge
 * `planPromotion` into `manifest.json`.
 */
export function promotePlanningArtifacts(runDir: string, projectRoot: string): PlanPromotionSummary {
  const plansDir = path.join(projectRoot, '.agentics', 'plans');
  const counts: Record<PlanSlot, number> = {
    sparc: 0, adrs: 0, ddd: 0, tdd: 0, prompts: 0, implementation: 0,
  };
  const missing_slots: PlanSlot[] = [];
  let total_copied = 0;
  let total_skipped = 0;

  const slots: PlanSlot[] = ['sparc', 'adrs', 'ddd', 'tdd', 'prompts', 'implementation'];

  for (const slot of slots) {
    const slotDir = path.join(plansDir, slot);
    const sources = PLAN_SLOT_SOURCES[slot];

    // Step 1: pick-best — the first qualifying non-additive source.
    let slotHasContent = slotDirHasFiles(slotDir);
    const best = pickBestSourceForSlot(runDir, slot, slotHasContent, sources.filter(s => !s.additive));
    if (best) {
      const r = promoteSourceIntoSlot(runDir, slotDir, best);
      counts[slot] += r.copied;
      total_copied += r.copied;
      total_skipped += r.skipped;
      if (r.copied > 0 || r.skipped > 0) slotHasContent = true;
    }

    // Step 2: additive sources always run (currently only
    // engineering/implementation-roadmap.md → plans/implementation/roadmap.md).
    for (const source of sources) {
      if (!source.additive) continue;
      const abs = path.join(runDir, source.relPath);
      if (!fs.existsSync(abs)) continue;
      const r = promoteSourceIntoSlot(runDir, slotDir, source);
      counts[slot] += r.copied;
      total_copied += r.copied;
      total_skipped += r.skipped;
      if (r.copied > 0 || r.skipped > 0) slotHasContent = true;
    }

    // Step 3: MISSING escalation — only when every candidate source genuinely
    // had zero promotable content. For engineering-primary sources, "promotable"
    // also means passing the placeholder threshold; a rejected stub counts as
    // empty so the MISSING line still fires. This keeps the warning honest.
    if (!slotHasContent) {
      const anyCandidateExists = sources.some(s => {
        const abs = path.join(runDir, s.relPath);
        if (!fs.existsSync(abs)) return false;
        if (s.kind === 'dir') {
          try { return fs.readdirSync(abs).length > 0; } catch { return false; }
        }
        try {
          if (fs.statSync(abs).size === 0) return false;
        } catch { return false; }
        if (s.engineeringPrimary) {
          return readEngineeringPrimaryOrReject(abs) !== null;
        }
        return true;
      });
      if (!anyCandidateExists) {
        missing_slots.push(slot);
      }
    }
  }

  // Rule 5 — one-line stderr summary with per-slot counts.
  const summaryLine = `[PLANS] promoted ${total_copied} files across {sparc:${counts.sparc}, adrs:${counts.adrs}, ddd:${counts.ddd}, tdd:${counts.tdd}, prompts:${counts.prompts}, implementation:${counts.implementation}}`;
  process.stderr.write(`  ${summaryLine}\n`);
  for (const slot of missing_slots) {
    process.stderr.write(`  [PLANS] MISSING ${slot} — no source artifacts found in any candidate directory\n`);
  }

  return { counts, missing_slots, total_copied, total_skipped };
}

/**
 * Merge the ADR-PIPELINE-092 `planPromotion` block into `runDir/manifest.json`.
 * Read-modify-write pattern mirrors `writeExecutionBlockToManifest`.
 */
export function writePlanPromotionToManifest(
  runDir: string,
  summary: PlanPromotionSummary,
): void {
  const manifestPath = path.join(runDir, 'manifest.json');
  try {
    let manifest: Record<string, unknown> = {};
    if (fs.existsSync(manifestPath)) {
      try {
        manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as Record<string, unknown>;
      } catch {
        manifest = {};
      }
    }
    manifest['planPromotion'] = {
      sparc: summary.counts.sparc,
      adrs: summary.counts.adrs,
      ddd: summary.counts.ddd,
      tdd: summary.counts.tdd,
      prompts: summary.counts.prompts,
      implementation: summary.counts.implementation,
      missing_slots: summary.missing_slots,
    };
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), { mode: 0o600, encoding: 'utf-8' });
  } catch (err) {
    process.stderr.write(`  [PLANS] Failed to merge planPromotion into manifest.json: ${err instanceof Error ? err.message : String(err)}\n`);
  }
}

/**
 * Copy whatever planning artifacts exist from ~/.agentics/runs/<traceId>/
 * to .agentics/plans/ in the current working directory. Uses .agentics/plans/
 * instead of plans/ to avoid colliding with any existing plans/ folder in the
 * project (e.g., SPARC artifacts checked into the repo). Skips files that
 * already exist with identical content to avoid unnecessary duplication.
 *
 * Called after every phase so even if later phases fail, earlier artifacts
 * are still available.
 */
/**
 * ADR-PIPELINE-074: scaffold body for `src/logger.ts`.
 *
 * Uses `node:async_hooks` AsyncLocalStorage so concurrent Express/Hono
 * requests NEVER cross-contaminate log lines. The legacy
 * `let currentCorrelationId` module-level mutable has been removed; any
 * generator that reintroduces it is caught by PGV-016.
 *
 * Exports:
 *   - `Logger` interface with info/warn/error/child
 *   - `createLogger(service)` factory
 *   - `runWithCorrelation(id, fn)` — wraps an async scope with the ID
 *   - `getCorrelationId()` — returns the ID for the current async scope
 *   - `setCorrelationId(id)` — legacy shim; mutates the current store
 */
export const LOGGER_SCAFFOLD = `// Auto-generated by Agentics pipeline (ADR-PIPELINE-074)
// Correlation IDs flow through an AsyncLocalStorage so concurrent requests
// never cross-contaminate log lines. Import runWithCorrelation + createLogger
// from here; NEVER reach for a module-level mutable to store the ID.
import { AsyncLocalStorage } from 'node:async_hooks';

export interface Logger {
  info(event: string, data?: Record<string, unknown>): void;
  warn(event: string, data?: Record<string, unknown>): void;
  error(event: string, error: Error, data?: Record<string, unknown>): void;
  child(bindings: Record<string, unknown>): Logger;
}

interface LoggerContext {
  correlationId?: string;
  bindings: Record<string, unknown>;
}

const storage = new AsyncLocalStorage<LoggerContext>();

/**
 * Run \`fn\` with \`correlationId\` installed in the current async scope.
 * Every log line emitted inside \`fn\` and its async descendants will carry
 * this ID, and it will NOT leak to other concurrent requests.
 */
export function runWithCorrelation<T>(correlationId: string, fn: () => T): T {
  const parent = storage.getStore();
  const ctx: LoggerContext = {
    correlationId,
    bindings: parent?.bindings ?? {},
  };
  return storage.run(ctx, fn);
}

/** Returns the correlation ID for the current async scope, if any. */
export function getCorrelationId(): string | undefined {
  return storage.getStore()?.correlationId;
}

/**
 * Back-compat shim — deprecated. Retained for legacy callers, but
 * SHOULD NOT be used inside request handlers. Use runWithCorrelation.
 * Under AsyncLocalStorage, this mutates the current store in place;
 * outside an async scope it is a silent no-op.
 */
export function setCorrelationId(id: string | undefined): void {
  const ctx = storage.getStore();
  if (ctx) ctx.correlationId = id;
}

export function createLogger(service: string): Logger {
  const build = (bindings: Record<string, unknown>): Logger => {
    const emit = (level: string, event: string, extra?: Record<string, unknown>): void => {
      const ctx = storage.getStore();
      const entry = {
        timestamp: new Date().toISOString(),
        level,
        service,
        event,
        ...(ctx?.correlationId ? { correlationId: ctx.correlationId } : {}),
        ...bindings,
        ...(ctx?.bindings ?? {}),
        ...extra,
      };
      process.stderr.write(JSON.stringify(entry) + '\\n');
    };
    return {
      info: (event, data) => emit('info', event, data),
      warn: (event, data) => emit('warn', event, data),
      error: (event, err, data) => emit('error', event, {
        error: err.message,
        stack: err.stack,
        ...data,
      }),
      child: (childBindings) => build({ ...bindings, ...childBindings }),
    };
  };
  return build({});
}
`;

/**
 * ADR-PIPELINE-074: concurrency-correctness test emitted alongside
 * `src/logger.ts` in every generated project. Fails loudly if
 * AsyncLocalStorage wiring regresses.
 */
export const LOGGER_CONCURRENCY_TEST_SCAFFOLD = `// Auto-generated by Agentics pipeline (ADR-PIPELINE-074)
// Proves correlation IDs do NOT leak across concurrent async tasks.
// Works with vitest and jest — both expose describe/it/expect as globals.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect } from 'vitest';
import { runWithCorrelation, getCorrelationId } from './logger.js';

describe('logger correlation-id async scoping (ADR-PIPELINE-074)', () => {
  it('does not leak correlation IDs across concurrent async tasks', async () => {
    const results: Array<{ requested: string; observed: string | undefined }> = [];
    const tasks: Promise<void>[] = [];
    for (let i = 0; i < 50; i++) {
      const id = \`req-\${i}\`;
      tasks.push(
        runWithCorrelation(id, async () => {
          await new Promise((r) => setTimeout(r, Math.random() * 10));
          results.push({ requested: id, observed: getCorrelationId() });
        }),
      );
    }
    await Promise.all(tasks);
    for (const r of results) {
      expect(r.observed).toBe(r.requested);
    }
  });
});
`;

/**
 * ADR-PIPELINE-068: scaffold body for `src/simulation-lineage.ts`.
 *
 * Exported so unit tests can write the file to a temp directory and
 * exercise the runtime behavior (env override, manifest walk, fallback)
 * without having to spin up the full pipeline.
 *
 * Invariants enforced by tests:
 * - Uses `readFileSync` + `fileURLToPath` (NEVER `require(`)
 * - Exports `loadSimulationLineage`, `requireSimulationLineage`,
 *   `formatLineageBanner`, and the legacy `loadSimulationId` alias
 * - Walks up at most 6 directories from the module location and from cwd
 */
export const SIMULATION_LINEAGE_SCAFFOLD = `// Auto-generated by Agentics pipeline (ADR-PIPELINE-068)
// ESM-safe simulation lineage loader. Reads .agentics/plans/manifest.json
// (or .agentics/runs/latest/manifest.json) using readFileSync — never
// CommonJS require(). Do NOT reimplement this helper; import from it.
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export type SimulationLineageSource = 'env' | 'manifest' | 'fallback';

export interface SimulationLineage {
  readonly simulationId: string;
  readonly traceId: string;
  readonly runId: string;
  readonly source: SimulationLineageSource;
  readonly manifestPath?: string;
}

const MANIFEST_CANDIDATES: readonly string[] = [
  '.agentics/plans/manifest.json',
  '.agentics/runs/latest/manifest.json',
];

const WALK_DEPTH = 6;

/** Walk up from startDir looking for any manifest candidate path. */
function findManifest(startDir: string): string | null {
  let dir = startDir;
  for (let i = 0; i < WALK_DEPTH; i++) {
    for (const rel of MANIFEST_CANDIDATES) {
      const candidate = resolve(dir, rel);
      if (existsSync(candidate)) return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function moduleDir(): string {
  try {
    return dirname(fileURLToPath(import.meta.url));
  } catch {
    return process.cwd();
  }
}

/**
 * Load the simulation lineage. Permissive — returns a fallback record when
 * nothing is available. Callers who need strict behavior should use
 * requireSimulationLineage() instead.
 *
 * Resolution order:
 *   1. AGENTICS_SIMULATION_ID / AGENTICS_TRACE_ID environment variables
 *   2. First manifest.json found walking up from this module (then cwd)
 *   3. Fallback record with source='fallback'
 */
export function loadSimulationLineage(): SimulationLineage {
  const envSim = process.env['AGENTICS_SIMULATION_ID'];
  const envTrace = process.env['AGENTICS_TRACE_ID'];
  if (envSim) {
    return {
      simulationId: envSim,
      traceId: envTrace ?? envSim,
      runId: envSim,
      source: 'env',
    };
  }

  const startDirs = [moduleDir(), process.cwd()];
  for (const start of startDirs) {
    try {
      const manifestPath = findManifest(start);
      if (!manifestPath) continue;
      const raw = JSON.parse(readFileSync(manifestPath, 'utf-8')) as Record<string, unknown>;
      const runId = String(raw['run_id'] ?? raw['runId'] ?? '');
      const simulationId = String(
        raw['simulation_id'] ?? raw['simulationId'] ?? raw['execution_id'] ?? runId,
      );
      const traceId = String(raw['trace_id'] ?? raw['traceId'] ?? simulationId);
      if (simulationId) {
        return { simulationId, traceId, runId: runId || simulationId, source: 'manifest', manifestPath };
      }
    } catch {
      // Try the next start dir. Never throw from the permissive loader.
    }
  }

  return {
    simulationId: 'sim-unknown',
    traceId: 'trace-unknown',
    runId: 'run-unknown',
    source: 'fallback',
  };
}

/**
 * Strict variant — throws ECLI-LIN-068 when no simulation lineage is
 * available. Use this at startup when the service MUST carry a real
 * simulation id (audit logs, ERP posts, etc.).
 */
export function requireSimulationLineage(): SimulationLineage {
  const lineage = loadSimulationLineage();
  if (lineage.source === 'fallback') {
    throw new Error(
      'ECLI-LIN-068: simulation lineage unavailable — set AGENTICS_SIMULATION_ID or place .agentics/plans/manifest.json in the project tree',
    );
  }
  return lineage;
}

/**
 * Human-readable banner printed by the demo script when the loader falls
 * back. Makes the break visible instead of letting sim-unknown leak into
 * downstream audit logs and ERP posts.
 */
export function formatLineageBanner(lineage: SimulationLineage): string {
  if (lineage.source !== 'fallback') {
    return \`simulation lineage: \${lineage.simulationId} (source: \${lineage.source})\`;
  }
  return [
    '',
    '⚠️  Simulation lineage unavailable (source: fallback)',
    '    All audit entries and ERP posts will carry sim-unknown.',
    '    Fix: place .agentics/plans/manifest.json in the project tree,',
    '    or set AGENTICS_SIMULATION_ID=<run-id> before running the demo.',
    '',
  ].join('\\n');
}

/** Also exported under the legacy alias some older prompts referenced. */
export const loadSimulationId = (): string => loadSimulationLineage().simulationId;
`;

/**
 * ADR-PIPELINE-069: scaffold body for `src/circuit-breaker.ts`.
 *
 * Extracted from the legacy middleware.ts scaffold so generators can
 * `import { CircuitBreaker } from './circuit-breaker.js'` without pulling
 * the entire middleware module. middleware.ts now re-exports this symbol
 * so existing imports keep working.
 */
export const CIRCUIT_BREAKER_SCAFFOLD = `// Auto-generated by Agentics pipeline (ADR-PIPELINE-069)
// Owned by the scaffold — do NOT redeclare CircuitBreaker in generated code.
import { createLogger } from './logger.js';

/** Simple circuit breaker for external service calls. */
export class CircuitBreaker {
  private failures = 0;
  private state: 'closed' | 'open' | 'half-open' = 'closed';
  private nextAttempt = 0;

  constructor(
    private readonly name: string,
    private readonly threshold = 5,
    private readonly cooldownMs = 30000,
    private readonly logger = createLogger('circuit-breaker'),
  ) {}

  async call<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === 'open') {
      if (Date.now() < this.nextAttempt) {
        throw new Error(\`Circuit breaker '\${this.name}' is OPEN — retry after \${new Date(this.nextAttempt).toISOString()}\`);
      }
      this.state = 'half-open';
      this.logger.info('circuit.half-open', { name: this.name });
    }
    try {
      const result = await fn();
      if (this.state === 'half-open') {
        this.state = 'closed';
        this.failures = 0;
        this.logger.info('circuit.closed', { name: this.name });
      }
      return result;
    } catch (err) {
      this.failures++;
      if (this.failures >= this.threshold) {
        this.state = 'open';
        this.nextAttempt = Date.now() + this.cooldownMs;
        this.logger.warn('circuit.open', { name: this.name, failures: this.failures, retryAt: new Date(this.nextAttempt).toISOString() });
      }
      throw err;
    }
  }

  getState(): string { return this.state; }
}
`;

/**
 * ADR-PIPELINE-075: scaffold body for `src/persistence/repository.ts`.
 *
 * Defines the `Repository<T>` interface every stateful service should
 * depend on. Each entity is identified by `idOf(entity)`, validated by a
 * Zod schema on read, and bound to a table name for the SQLite backend.
 */
export const REPOSITORY_SCAFFOLD = `// Auto-generated by Agentics pipeline (ADR-PIPELINE-075)
// Repository interface every stateful service should depend on.
// Generators: use this instead of storing state in a Map<string, T>.
import type { ZodType } from 'zod';

export interface Repository<T> {
  save(entity: T): Promise<void>;
  get(id: string): Promise<T | null>;
  list(filter?: Partial<T>): Promise<readonly T[]>;
  delete(id: string): Promise<void>;
}

export interface RepositoryOptions<T> {
  /** How to extract the primary key from an entity. */
  readonly idOf: (entity: T) => string;
  /** Zod schema used to re-validate rows on load (SQLite JSON columns are untrusted). */
  readonly schema: ZodType<T>;
  /** Table name for SQLite backend. Must match /^[a-zA-Z_][a-zA-Z0-9_]*$/. */
  readonly tableName: string;
}

/** Errors thrown by all Repository implementations. */
export class RepositoryError extends Error {
  constructor(message: string, public readonly code: string) {
    super(\`\${code}: \${message}\`);
    this.name = 'RepositoryError';
  }
}
`;

/**
 * ADR-PIPELINE-075: scaffold body for `src/persistence/in-memory-repository.ts`.
 *
 * Test-friendly `Repository<T>` implementation backed by a Map. Validates
 * on write AND read so test fixtures catch schema drift. Production
 * services should swap in SqliteRepository via the composition root.
 */
export const IN_MEMORY_REPO_SCAFFOLD = `// Auto-generated by Agentics pipeline (ADR-PIPELINE-075)
// In-memory Repository<T> for tests. Not for production use.
import type { Repository, RepositoryOptions } from './repository.js';

export class InMemoryRepository<T> implements Repository<T> {
  private readonly rows = new Map<string, T>();
  constructor(private readonly options: RepositoryOptions<T>) {}

  async save(entity: T): Promise<void> {
    const validated = this.options.schema.parse(entity);
    this.rows.set(this.options.idOf(validated), validated);
  }

  async get(id: string): Promise<T | null> {
    const row = this.rows.get(id);
    return row === undefined ? null : row;
  }

  async list(filter?: Partial<T>): Promise<readonly T[]> {
    const all = Array.from(this.rows.values());
    if (!filter) return all;
    return all.filter(row =>
      Object.entries(filter).every(
        ([k, v]) => (row as Record<string, unknown>)[k] === v,
      ),
    );
  }

  async delete(id: string): Promise<void> {
    this.rows.delete(id);
  }

  /** Test helper — never call from production code. */
  clear(): void {
    this.rows.clear();
  }

  /** Test helper — returns the current row count. */
  get size(): number {
    return this.rows.size;
  }
}
`;

/**
 * ADR-PIPELINE-075: scaffold body for `src/persistence/sqlite-repository.ts`.
 *
 * Production `Repository<T>` backed by better-sqlite3. Stores each entity
 * as a JSON column keyed by its primary key. Zod re-validates on read
 * because the JSON column is untrusted at runtime.
 *
 * Generated projects must add better-sqlite3 + @types/better-sqlite3 to
 * their package.json — the cross-cutting prompt footer reminds the coding
 * agent to include these deps.
 */
export const SQLITE_REPO_SCAFFOLD = `// Auto-generated by Agentics pipeline (ADR-PIPELINE-075)
// SQLite-backed Repository<T> using better-sqlite3.
// Requires: better-sqlite3 in dependencies, @types/better-sqlite3 in devDependencies.
/* eslint-disable @typescript-eslint/no-explicit-any */
import type { Repository, RepositoryOptions } from './repository.js';
import { RepositoryError } from './repository.js';

// Minimal structural type — works with better-sqlite3 without importing it
// into the scaffold (so the scaffold compiles even when the dependency
// isn't installed in the pipeline's own test environment).
export interface BetterSqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): {
    run(...params: any[]): { changes: number; lastInsertRowid: number | bigint };
    get(...params: any[]): any;
    all(...params: any[]): any[];
  };
}

export interface SqliteRepositoryDeps {
  readonly db: BetterSqliteDatabase;
}

export class SqliteRepository<T> implements Repository<T> {
  constructor(
    private readonly deps: SqliteRepositoryDeps,
    private readonly options: RepositoryOptions<T>,
  ) {
    this.assertSafeTableName();
    this.deps.db.exec(\`
      CREATE TABLE IF NOT EXISTS \${this.options.tableName} (
        id TEXT PRIMARY KEY,
        data TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
    \`);
  }

  private assertSafeTableName(): void {
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(this.options.tableName)) {
      throw new RepositoryError(\`unsafe table name: \${this.options.tableName}\`, 'ECLI-REPO-001');
    }
  }

  async save(entity: T): Promise<void> {
    const validated = this.options.schema.parse(entity);
    const id = this.options.idOf(validated);
    const data = JSON.stringify(validated);
    this.deps.db
      .prepare(
        \`INSERT INTO \${this.options.tableName} (id, data) VALUES (?, ?)
         ON CONFLICT(id) DO UPDATE SET data = excluded.data,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')\`,
      )
      .run(id, data);
  }

  async get(id: string): Promise<T | null> {
    const row = this.deps.db
      .prepare(\`SELECT data FROM \${this.options.tableName} WHERE id = ?\`)
      .get(id) as { data: string } | undefined;
    if (!row) return null;
    return this.options.schema.parse(JSON.parse(row.data));
  }

  async list(filter?: Partial<T>): Promise<readonly T[]> {
    const rows = this.deps.db
      .prepare(\`SELECT data FROM \${this.options.tableName}\`)
      .all() as Array<{ data: string }>;
    const parsed = rows.map(r => this.options.schema.parse(JSON.parse(r.data)));
    if (!filter) return parsed;
    return parsed.filter(row =>
      Object.entries(filter).every(
        ([k, v]) => (row as Record<string, unknown>)[k] === v,
      ),
    );
  }

  async delete(id: string): Promise<void> {
    this.deps.db.prepare(\`DELETE FROM \${this.options.tableName} WHERE id = ?\`).run(id);
  }
}
`;

/**
 * ADR-PIPELINE-075: scaffold body for `src/persistence/audit-repository.ts`.
 *
 * Append-only audit repository. NO update, NO delete — an audit entry is
 * committed and lives forever. Services that need to mutate a past entry
 * have to bypass the repository and talk raw SQL, which PGV and code
 * review will catch.
 */
export const AUDIT_REPO_SCAFFOLD = `// Auto-generated by Agentics pipeline (ADR-PIPELINE-075)
// Append-only audit repository. No update, no delete by design.
/* eslint-disable @typescript-eslint/no-explicit-any */
import type { BetterSqliteDatabase } from './sqlite-repository.js';

export interface AuditEntry {
  readonly entryId: string;
  readonly prevHash: string;
  readonly hash: string;
  readonly payload: Record<string, unknown>;
  readonly actor: string;
  readonly action: string;
  readonly entityType: string;
  readonly entityId: string;
  readonly createdAt: string;
}

export interface AuditRepositoryDeps {
  readonly db: BetterSqliteDatabase;
}

export class AppendOnlyAuditRepository {
  constructor(private readonly deps: AuditRepositoryDeps) {
    this.deps.db.exec(\`
      CREATE TABLE IF NOT EXISTS audit_log (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        entry_id TEXT NOT NULL UNIQUE,
        prev_hash TEXT NOT NULL,
        hash TEXT NOT NULL,
        payload TEXT NOT NULL,
        actor TEXT NOT NULL,
        action TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
      CREATE INDEX IF NOT EXISTS idx_audit_log_entity
        ON audit_log(entity_type, entity_id);
    \`);
  }

  append(entry: AuditEntry): void {
    this.deps.db
      .prepare(
        \`INSERT INTO audit_log
         (entry_id, prev_hash, hash, payload, actor, action, entity_type, entity_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)\`,
      )
      .run(
        entry.entryId,
        entry.prevHash,
        entry.hash,
        JSON.stringify(entry.payload),
        entry.actor,
        entry.action,
        entry.entityType,
        entry.entityId,
        entry.createdAt,
      );
  }

  list(): readonly AuditEntry[] {
    const rows = this.deps.db
      .prepare(\`SELECT * FROM audit_log ORDER BY sequence ASC\`)
      .all() as Array<{
      entry_id: string;
      prev_hash: string;
      hash: string;
      payload: string;
      actor: string;
      action: string;
      entity_type: string;
      entity_id: string;
      created_at: string;
    }>;
    return rows.map(r => ({
      entryId: r.entry_id,
      prevHash: r.prev_hash,
      hash: r.hash,
      payload: JSON.parse(r.payload),
      actor: r.actor,
      action: r.action,
      entityType: r.entity_type,
      entityId: r.entity_id,
      createdAt: r.created_at,
    }));
  }

  listByEntity(entityType: string, entityId: string): readonly AuditEntry[] {
    const rows = this.deps.db
      .prepare(
        \`SELECT * FROM audit_log
         WHERE entity_type = ? AND entity_id = ?
         ORDER BY sequence ASC\`,
      )
      .all(entityType, entityId) as Array<{
      entry_id: string;
      prev_hash: string;
      hash: string;
      payload: string;
      actor: string;
      action: string;
      entity_type: string;
      entity_id: string;
      created_at: string;
    }>;
    return rows.map(r => ({
      entryId: r.entry_id,
      prevHash: r.prev_hash,
      hash: r.hash,
      payload: JSON.parse(r.payload),
      actor: r.actor,
      action: r.action,
      entityType: r.entity_type,
      entityId: r.entity_id,
      createdAt: r.created_at,
    }));
  }

  /** Total row count — used by verify() and reconciliation jobs. */
  size(): number {
    const row = this.deps.db
      .prepare('SELECT COUNT(*) AS n FROM audit_log')
      .get() as { n: number };
    return row.n;
  }
}
`;

/**
 * ADR-PIPELINE-078: scaffold body for `src/persistence/canonical-json.ts`.
 *
 * Deterministic JSON serialization for audit hash chains and idempotency
 * keys. Follows JCS (RFC 8785) closely enough for the pipeline's needs:
 * object keys are sorted lexicographically at every depth; arrays preserve
 * order; strings, numbers, booleans, and null use standard JSON encoding.
 *
 * Rejects undefined, BigInt, and circular references. Date objects should
 * be serialized as ISO strings at the boundary BEFORE passing to this
 * function.
 */
export const CANONICAL_JSON_SCAFFOLD = `// Auto-generated by Agentics pipeline (ADR-PIPELINE-078)
// Deterministic JSON for audit hash chains. Keys sorted at every depth.

export class CanonicalJsonError extends Error {
  constructor(message: string) {
    super(\`ECLI-CJ-078: \${message}\`);
    this.name = 'CanonicalJsonError';
  }
}

/**
 * Canonicalize \`value\` into a deterministic JSON string. Keys are sorted
 * at every level; arrays preserve order; primitives use standard encoding.
 */
export function canonicalJson(value: unknown): string {
  const visited = new WeakSet<object>();
  return serialize(value, visited);
}

function serialize(value: unknown, visited: WeakSet<object>): string {
  if (value === undefined) {
    throw new CanonicalJsonError('undefined is not canonicalizable — pass null instead');
  }
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new CanonicalJsonError(\`non-finite number: \${String(value)}\`);
    }
    return JSON.stringify(value);
  }
  if (typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'bigint') {
    throw new CanonicalJsonError('BigInt is not canonicalizable — convert to string at the boundary');
  }
  if (Array.isArray(value)) {
    if (visited.has(value)) throw new CanonicalJsonError('circular reference in array');
    visited.add(value);
    const parts = value.map(item => serialize(item, visited));
    visited.delete(value);
    return '[' + parts.join(',') + ']';
  }
  if (typeof value === 'object') {
    if (visited.has(value as object)) throw new CanonicalJsonError('circular reference in object');
    visited.add(value as object);
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    const pairs: string[] = [];
    for (const key of keys) {
      const v = record[key];
      if (v === undefined) continue;
      pairs.push(JSON.stringify(key) + ':' + serialize(v, visited));
    }
    visited.delete(value as object);
    return '{' + pairs.join(',') + '}';
  }
  throw new CanonicalJsonError(\`unsupported value type: \${typeof value}\`);
}
`;

/**
 * ADR-PIPELINE-078: scaffold body for `src/persistence/audit-hash.ts`.
 *
 * Wraps `canonicalJson` with audit-log-specific conventions. Every
 * generated `AuditService.append()` method should call `hashAuditEntry`
 * rather than rolling its own `JSON.stringify + createHash` chain.
 */
export const AUDIT_HASH_SCAFFOLD = `// Auto-generated by Agentics pipeline (ADR-PIPELINE-078)
// Audit hash-chain helper. Import hashAuditEntry instead of hand-rolling
// createHash('sha256').update(JSON.stringify(...)).
import { createHash } from 'node:crypto';
import { canonicalJson } from './canonical-json.js';

export interface HashChainInput {
  readonly prevHash: string;
  readonly entryId: string;
  readonly actor: string;
  readonly action: string;
  readonly entityType: string;
  readonly entityId: string;
  readonly payload: unknown;
  readonly createdAt: string;
}

/**
 * Deterministically hash an audit entry's content + its link to the
 * previous entry. Payload keys are sorted at every depth so mutations
 * at any nesting level change the hash.
 */
export function hashAuditEntry(input: HashChainInput): string {
  const body = canonicalJson({
    prevHash: input.prevHash,
    entryId: input.entryId,
    actor: input.actor,
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId,
    payload: input.payload,
    createdAt: input.createdAt,
  });
  return createHash('sha256').update(body).digest('hex');
}
`;

/**
 * ADR-PIPELINE-077: scaffold body for `src/erp/schema-provenance.ts`.
 *
 * Every generated ERP adapter file (schema.ts, <system>-adapter.ts, etc.)
 * must export an `ERP_SCHEMA_PROVENANCE` constant of type
 * `ErpSchemaProvenance` declaring whether the schema was invented,
 * pulled from a catalog, or validated by an SME. Under
 * `AGENTICS_ERP_STRICT=true`, `assertErpProvenanceOrFail` refuses to
 * start when source='invented'. PGV-020 enforces presence, PGV-021
 * enforces reviewer + catalog_version on validated entries.
 */
export const ERP_SCHEMA_PROVENANCE_SCAFFOLD = `// Auto-generated by Agentics pipeline (ADR-PIPELINE-077)
// Provenance tag for generated ERP schemas. MANDATORY on every file
// under src/erp/ that exports Zod schemas targeting an external ERP.

export type ErpProvenanceSource = 'invented' | 'catalog' | 'validated';

export interface ErpSchemaProvenance {
  /** Target ERP system — e.g. 'Ramco Aviation', 'Oracle OPERA', 'SAP S/4HANA'. */
  readonly erp_system: string;
  /** Specific module the schema targets — 'Flight Catering Order'. */
  readonly module: string;
  /** Validation stage: invented (no review), catalog (fields match), validated (SME-reviewed). */
  readonly source: ErpProvenanceSource;
  /** Version identifier of the catalog source, when known. */
  readonly catalog_version: string | null;
  /** ISO timestamp of SME review when source='validated'. */
  readonly validated_at: string | null;
  /** Reviewer name + role when source='validated'. */
  readonly reviewer: { name: string; role: string } | null;
  /** Free-text notes visible in startup logs and generated README. */
  readonly notes: string;
}

/**
 * Assert an ERP adapter is allowed to run in the current environment.
 * Under AGENTICS_ERP_STRICT=true, source='invented' throws ECLI-ERP-077
 * and the process exits with code 77.
 */
export function assertErpProvenanceOrFail(
  provenance: ErpSchemaProvenance,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const strict = env['AGENTICS_ERP_STRICT'] === 'true';
  if (strict && provenance.source === 'invented') {
    throw new Error(
      \`ECLI-ERP-077: ERP adapter for \${provenance.erp_system}/\${provenance.module} has source='invented' \` +
      \`and AGENTICS_ERP_STRICT=true. Pilot deployment requires an SME review — set source='validated' \` +
      \`and provide reviewer + catalog_version before enabling strict mode.\`,
    );
  }
}

/** Console-friendly banner for startup logs + demo output. */
export function formatProvenanceBanner(provenance: ErpSchemaProvenance): string {
  const icon = provenance.source === 'validated' ? '✅' :
               provenance.source === 'catalog'   ? '🟡' :
                                                    '⚠️ ';
  const lines: string[] = [
    \`\${icon} ERP SCHEMA PROVENANCE — \${provenance.erp_system} / \${provenance.module}\`,
    \`   source: \${provenance.source}\`,
  ];
  if (provenance.catalog_version) lines.push(\`   catalog: \${provenance.catalog_version}\`);
  if (provenance.validated_at) lines.push(\`   validated: \${provenance.validated_at}\`);
  if (provenance.reviewer) lines.push(\`   reviewer: \${provenance.reviewer.name} (\${provenance.reviewer.role})\`);
  if (provenance.source === 'invented') {
    lines.push(
      '   ',
      '   WARNING: This schema has not been validated against a real ERP document catalog.',
      '   Pilot deployment requires an SME review before the first live call.',
      "   Set AGENTICS_ERP_STRICT=true in production to block runs until source='validated'.",
    );
  }
  return lines.join('\\n');
}

/** Convenience wrapper — prints the banner to stderr. */
export function printProvenanceBanner(provenance: ErpSchemaProvenance): void {
  process.stderr.write(formatProvenanceBanner(provenance) + '\\n');
}
`;

/**
 * ADR-PIPELINE-076: scaffold body for `src/api/base-app.ts` (Hono variant).
 *
 * Ships a wire-complete base app so the coding agent never writes
 * middleware/metrics/health plumbing from scratch. Generators extend
 * via `createBaseApp({...}).route('/api/<domain>', yourRouter)` instead
 * of rebuilding.
 *
 * Every generated project that imports `createBaseApp` gets:
 *   - correlation middleware (AsyncLocalStorage-scoped, ADR-074)
 *   - request logging with duration histogram
 *   - GET /health/live       (process up check)
 *   - GET /health/ready      (every readiness check passes)
 *   - GET /metrics           (Prometheus text, ADR-051)
 *   - structured error handler (last)
 */
export const BASE_APP_SCAFFOLD_HONO = `// Auto-generated by Agentics pipeline (ADR-PIPELINE-076)
// Wire-complete Hono app base. DO NOT rewrite — extend via
// \`createBaseApp(deps).route('/api/...', yourRouter)\` from your routes module.
import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import { runWithCorrelation, createLogger } from '../logger.js';
import { incrementCounter, recordHistogram, metricsHandler } from '../middleware.js';

export interface HealthCheck {
  readonly name: string;
  readonly check: () => Promise<{ ok: boolean; detail?: string }>;
}

export interface BaseAppDeps {
  readonly serviceName: string;
  readonly version: string;
  readonly readiness: readonly HealthCheck[];
}

export interface BaseAppContextVariables {
  correlationId: string;
  startedAt: number;
}

const baseLogger = createLogger('base-app');

/**
 * Build the wire-complete base app.
 *
 * Returned Hono instance already has:
 *   - correlation ID middleware (AsyncLocalStorage-scoped)
 *   - request logging with duration histogram
 *   - GET /health/live       process-up check
 *   - GET /health/ready      runs every registered check
 *   - GET /metrics           Prometheus text format
 *   - structured error handler
 *
 * Add domain routes with \`.route('/api/<domain>', yourRouter)\`.
 */
export function createBaseApp(
  deps: BaseAppDeps,
): Hono<{ Variables: BaseAppContextVariables }> {
  const app = new Hono<{ Variables: BaseAppContextVariables }>();

  // Correlation ID — MUST be first so every downstream log carries it
  app.use('*', async (c, next) => {
    const id = c.req.header('x-correlation-id') ?? randomUUID();
    c.set('correlationId', id);
    c.set('startedAt', Date.now());
    c.header('X-Correlation-Id', id);
    await runWithCorrelation(id, async () => {
      await next();
    });
  });

  // Request logging + metrics
  app.use('*', async (c, next) => {
    await next();
    const durationMs = Date.now() - c.get('startedAt');
    const status = c.res.status;
    baseLogger.info('http.request', {
      method: c.req.method,
      path: c.req.path,
      status,
      durationMs,
    });
    incrementCounter('http_requests_total', {
      method: c.req.method,
      status: String(status),
    });
    recordHistogram('http_request_duration_ms', durationMs, {
      method: c.req.method,
    });
  });

  // Liveness — always returns OK if the process is running
  app.get('/health/live', (c) => {
    return c.json({
      status: 'ok',
      service: deps.serviceName,
      version: deps.version,
      uptime_sec: Math.round(process.uptime()),
    });
  });

  // Readiness — runs every registered check
  app.get('/health/ready', async (c) => {
    const results: Array<{ name: string; ok: boolean; detail?: string }> = [];
    for (const check of deps.readiness) {
      try {
        const r = await check.check();
        results.push({ name: check.name, ok: r.ok, ...(r.detail ? { detail: r.detail } : {}) });
      } catch (err) {
        results.push({
          name: check.name,
          ok: false,
          detail: err instanceof Error ? err.message : String(err),
        });
      }
    }
    const allOk = results.every((r) => r.ok);
    return c.json(
      { status: allOk ? 'ready' : 'not-ready', checks: results },
      allOk ? 200 : 503,
    );
  });

  // Metrics — Prometheus text format
  app.get('/metrics', (c) => {
    return c.text(metricsHandler(), 200, {
      'Content-Type': 'text/plain; version=0.0.4',
    });
  });

  // Error handler — last, so it catches everything above
  app.onError((err, c) => {
    baseLogger.error('http.error', err as Error, {
      method: c.req.method,
      path: c.req.path,
    });
    const status = (err as { httpStatus?: number }).httpStatus ?? 500;
    return c.json(
      {
        error: {
          message: err.message,
          code: (err as { code?: string }).code ?? 'INTERNAL_ERROR',
        },
      },
      status as 500,
    );
  });

  return app;
}
`;

/**
 * ADR-PIPELINE-076: scaffold body for `src/api/base-app.ts` (Express variant).
 *
 * Used when the generator detects Express in Phase 4. Same guarantees as
 * the Hono variant — wires correlation / logging / liveness / readiness
 * / metrics / error handler in the correct order.
 */
export const BASE_APP_SCAFFOLD_EXPRESS = `// Auto-generated by Agentics pipeline (ADR-PIPELINE-076)
// Wire-complete Express app base. DO NOT rewrite — mount your routes
// onto the returned \`app\` instance instead.
/* eslint-disable @typescript-eslint/no-explicit-any */
import express from 'express';
import { randomUUID } from 'node:crypto';
import { runWithCorrelation, createLogger } from '../logger.js';
import { incrementCounter, recordHistogram, metricsHandlerExpress } from '../middleware.js';

export interface HealthCheck {
  readonly name: string;
  readonly check: () => Promise<{ ok: boolean; detail?: string }>;
}

export interface BaseAppDeps {
  readonly serviceName: string;
  readonly version: string;
  readonly readiness: readonly HealthCheck[];
}

const baseLogger = createLogger('base-app');

export function createBaseApp(deps: BaseAppDeps): express.Express {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  // Correlation ID — AsyncLocalStorage-scoped for the request's
  // entire async continuation.
  app.use((req: any, res: any, next: () => void) => {
    const id = (req.headers['x-correlation-id'] as string) || randomUUID();
    req.correlationId = id;
    res.setHeader('X-Correlation-Id', id);
    runWithCorrelation(id, next);
  });

  // Request logging + metrics
  app.use((req: any, res: any, next: () => void) => {
    const started = Date.now();
    res.on('finish', () => {
      const durationMs = Date.now() - started;
      baseLogger.info('http.request', {
        method: req.method,
        path: req.path,
        status: res.statusCode,
        durationMs,
      });
      incrementCounter('http_requests_total', {
        method: req.method,
        status: String(res.statusCode),
      });
      recordHistogram('http_request_duration_ms', durationMs, {
        method: req.method,
      });
    });
    next();
  });

  app.get('/health/live', (_req, res) => {
    res.json({
      status: 'ok',
      service: deps.serviceName,
      version: deps.version,
      uptime_sec: Math.round(process.uptime()),
    });
  });

  app.get('/health/ready', async (_req, res) => {
    const results: Array<{ name: string; ok: boolean; detail?: string }> = [];
    for (const check of deps.readiness) {
      try {
        const r = await check.check();
        results.push({ name: check.name, ok: r.ok, ...(r.detail ? { detail: r.detail } : {}) });
      } catch (err) {
        results.push({
          name: check.name,
          ok: false,
          detail: err instanceof Error ? err.message : String(err),
        });
      }
    }
    const allOk = results.every((r) => r.ok);
    res.status(allOk ? 200 : 503).json({
      status: allOk ? 'ready' : 'not-ready',
      checks: results,
    });
  });

  app.get('/metrics', metricsHandlerExpress);

  app.use((err: any, req: any, res: any, _next: () => void) => {
    baseLogger.error('http.error', err as Error, {
      method: req.method,
      path: req.path,
    });
    const status = err?.httpStatus ?? 500;
    res.status(status).json({
      error: {
        message: err?.message ?? 'Internal error',
        code: err?.code ?? 'INTERNAL_ERROR',
      },
    });
  });

  return app;
}
`;

/**
 * ADR-PIPELINE-069: Single source of truth for scaffold-owned modules.
 *
 * Every module the pipeline emits into `.agentics/plans/scaffold/src/` is
 * listed here with its public exports. The list is consumed by:
 *   - `copyPlanningArtifacts()`     — writes OWNED_MODULES.json sidecar
 *   - `prompt-generator.ts`         — injects "do not reimplement" block
 *   - `post-generation-validator.ts` PGV-012 — bans duplicate declarations
 *
 * When you add a new scaffold file, add it here in the same change.
 */
export interface OwnedScaffoldModule {
  readonly path: string;
  readonly exports: readonly string[];
}

export const OWNED_SCAFFOLD_MODULES: readonly OwnedScaffoldModule[] = [
  {
    path: 'src/logger.ts',
    // ADR-PIPELINE-074: runWithCorrelation is now the authoritative
    // way to scope a correlation ID; setCorrelationId is retained as a
    // legacy shim but must not be used inside request handlers.
    exports: [
      'Logger',
      'createLogger',
      'runWithCorrelation',
      'getCorrelationId',
      'setCorrelationId',
    ],
  },
  {
    path: 'src/config.ts',
    exports: ['AppConfig', 'config'],
  },
  {
    path: 'src/errors.ts',
    exports: ['AppError', 'ValidationError', 'NotFoundError', 'ERPError'],
  },
  {
    path: 'src/middleware.ts',
    // ADR-PIPELINE-076: metricsHandler is now a pure renderer; the
    // Express-compat wrapper is metricsHandlerExpress. The Hono wrapper
    // lives in the base-app scaffold.
    exports: [
      'correlationId',
      'requestLogger',
      'incrementCounter',
      'recordHistogram',
      'metricsHandler',
      'metricsHandlerExpress',
    ],
  },
  {
    path: 'src/circuit-breaker.ts',
    exports: ['CircuitBreaker'],
  },
  {
    path: 'src/unit-economics.ts',
    exports: [
      'DomainUnit',
      'UnitEconomicsScope',
      'UnitEconomics',
      'writeUnitEconomics',
      'readUnitEconomics',
    ],
  },
  {
    path: 'src/simulation-lineage.ts',
    exports: [
      'SimulationLineage',
      'SimulationLineageSource',
      'loadSimulationLineage',
      'requireSimulationLineage',
      'formatLineageBanner',
      'loadSimulationId',
    ],
  },
  // ADR-PIPELINE-075: scaffolded persistence layer
  {
    path: 'src/persistence/repository.ts',
    exports: ['Repository', 'RepositoryOptions', 'RepositoryError'],
  },
  {
    path: 'src/persistence/in-memory-repository.ts',
    exports: ['InMemoryRepository'],
  },
  {
    path: 'src/persistence/sqlite-repository.ts',
    exports: ['SqliteRepository', 'SqliteRepositoryDeps', 'BetterSqliteDatabase'],
  },
  {
    path: 'src/persistence/audit-repository.ts',
    exports: ['AppendOnlyAuditRepository', 'AuditRepositoryDeps', 'AuditEntry'],
  },
  // ADR-PIPELINE-076: wire-complete server scaffold
  {
    path: 'src/api/base-app.ts',
    exports: [
      'createBaseApp',
      'BaseAppDeps',
      'BaseAppContextVariables',
      'HealthCheck',
    ],
  },
  // ADR-PIPELINE-077: ERP schema provenance tag
  {
    path: 'src/erp/schema-provenance.ts',
    exports: [
      'ErpProvenanceSource',
      'ErpSchemaProvenance',
      'assertErpProvenanceOrFail',
      'formatProvenanceBanner',
      'printProvenanceBanner',
    ],
  },
  // ADR-PIPELINE-078: deep canonical JSON for audit hash chains
  {
    path: 'src/persistence/canonical-json.ts',
    exports: ['CanonicalJsonError', 'canonicalJson'],
  },
  {
    path: 'src/persistence/audit-hash.ts',
    exports: ['HashChainInput', 'hashAuditEntry'],
  },
];

export interface OwnedModulesManifest {
  readonly version: '1.0';
  readonly generated_at: string;
  readonly owned: readonly OwnedScaffoldModule[];
}

export function buildOwnedModulesManifest(now: Date = new Date()): OwnedModulesManifest {
  return {
    version: '1.0',
    generated_at: now.toISOString(),
    owned: OWNED_SCAFFOLD_MODULES,
  };
}

export interface ScaffoldDuplicateFinding {
  /** Absolute path of the file that redeclares an owned export. */
  readonly path: string;
  /** The export name that collides. */
  readonly exportName: string;
  /** Scaffold path that owns the export. */
  readonly ownedPath: string;
}

const SCAFFOLD_SCAN_SKIP_DIRS = new Set([
  'node_modules', 'dist', 'build', '.git', 'coverage', '.next', '.agentics',
]);

/**
 * ADR-PIPELINE-069: Walk a project tree looking for generator-emitted files
 * that redeclare an export listed in OWNED_SCAFFOLD_MODULES. Skips:
 *   - the scaffold-owned files themselves (matched by basename)
 *   - test files
 *   - node_modules / dist / .agentics
 *
 * Returns one finding per (file, export) pair.
 */
export function detectScaffoldDuplicates(
  projectRoot: string,
  owned: readonly OwnedScaffoldModule[] = OWNED_SCAFFOLD_MODULES,
): ScaffoldDuplicateFinding[] {
  if (!fs.existsSync(projectRoot)) return [];

  // Build (exportName -> ownedPath) lookup once.
  const exportToOwned = new Map<string, string>();
  const ownedBasenames = new Set<string>();
  for (const mod of owned) {
    ownedBasenames.add(path.basename(mod.path));
    for (const ex of mod.exports) {
      if (!exportToOwned.has(ex)) exportToOwned.set(ex, mod.path);
    }
  }

  const findings: ScaffoldDuplicateFinding[] = [];
  const walk = (currentDir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (SCAFFOLD_SCAN_SKIP_DIRS.has(entry.name)) continue;
        walk(path.join(currentDir, entry.name));
        continue;
      }
      if (!entry.name.endsWith('.ts')) continue;
      // Skip the scaffolded files themselves — they're allowed to declare
      // their own exports. Match by basename so any project layout works.
      if (ownedBasenames.has(entry.name)) continue;
      // Skip tests + scripts + demos
      const lower = entry.name.toLowerCase();
      if (lower.endsWith('.test.ts') || lower.endsWith('.spec.ts') || lower.endsWith('.d.ts')) continue;
      const fullPath = path.join(currentDir, entry.name);
      const lowerFull = fullPath.toLowerCase();
      if (lowerFull.includes('/tests/') || lowerFull.includes('/__tests__/') || lowerFull.includes('/scripts/')) continue;

      let content: string;
      try {
        const stat = fs.statSync(fullPath);
        if (stat.size > 1_000_000) continue;
        content = fs.readFileSync(fullPath, 'utf-8');
      } catch {
        continue;
      }

      for (const [exportName, ownedPath] of exportToOwned) {
        // Match `export class Foo`, `export function Foo`, `export const Foo`,
        // `export interface Foo`, `export type Foo`, or `export { Foo }`.
        const declRe = new RegExp(
          `\\bexport\\s+(?:class|function|const|let|interface|type|enum)\\s+${exportName}\\b`,
        );
        const reExportRe = new RegExp(`\\bexport\\s*\\{[^}]*\\b${exportName}\\b[^}]*\\}`);
        if (declRe.test(content) || reExportRe.test(content)) {
          findings.push({ path: fullPath, exportName, ownedPath });
        }
      }
    }
  };

  walk(projectRoot);
  return findings;
}

export function copyPlanningArtifacts(runDir: string, targetRoot?: string): void {
  try {
    // ADR-051: Use git repo root (or explicit target) instead of process.cwd()
    // When running as MCP server, process.cwd() may not be the user's project directory
    const projectRoot = targetRoot ?? process.cwd();
    const plansDir = path.join(projectRoot, '.agentics', 'plans');
    let totalCopied = 0;
    let totalSkipped = 0;

    /** Copy a single file with dedup check. */
    function copySingleFile(src: string, dest: string): void {
      if (!fs.existsSync(src)) return;
      if (fs.existsSync(dest) && filesAreIdentical(src, dest)) {
        totalSkipped++;
        return;
      }
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(src, dest);
      totalCopied++;
    }

    // ADR-PIPELINE-092: table-driven plan-slot promotion. The shared
    // `promotePlanningArtifacts` helper handles candidate-source discovery
    // (Rule 1), engineering/ → plans/ mapping with placeholder rejection
    // (Rule 2 + 2.5), conflict resolution (Rule 4), and `[PLANS]` stderr
    // observability (Rule 5). Returns per-slot counts used to merge the
    // `planPromotion` block into `manifest.json` at the end of this call.
    const promotionSummary = promotePlanningArtifacts(runDir, projectRoot);
    totalCopied += promotionSummary.total_copied;
    totalSkipped += promotionSummary.total_skipped;

    // Phase 1 artifacts (always available after Phase 1)
    for (const file of ['executive-summary.md', 'decision-memo.md', 'risk-assessment.json', 'manifest.json']) {
      copySingleFile(path.join(runDir, file), path.join(plansDir, file));
    }

    // Research dossier from Phase 2
    copySingleFile(path.join(runDir, 'phase2', 'research-dossier.json'), path.join(plansDir, 'research-dossier.json'));
    copySingleFile(path.join(runDir, 'phase2', 'research-dossier.md'), path.join(plansDir, 'research-dossier.md'));

    // Phase 5 integration inference results
    copySingleFile(
      path.join(runDir, 'phase5', 'integration-inference.json'),
      path.join(plansDir, 'integration-inference.json'),
    );

    // ADR-PIPELINE-093 Rule 5 — Scaffold-language gate. Detect the project
    // language ONCE and let `decideScaffoldEmission` pick which template
    // blocks to emit. TS project → only TS block runs. Python project →
    // only Python block runs. Go/Rust/unknown → both blocks skip and the
    // mismatch is persisted into `manifest.json`.
    let emitTsScaffold = true;
    let emitPyScaffold = true;
    try {
      const phase1ManifestPath = path.join(runDir, 'manifest.json');
      let phase1Manifest: Record<string, unknown> | undefined;
      if (fs.existsSync(phase1ManifestPath)) {
        try {
          phase1Manifest = JSON.parse(fs.readFileSync(phase1ManifestPath, 'utf-8')) as Record<string, unknown>;
        } catch {
          phase1Manifest = undefined;
        }
      }
      const detected = detectProjectLanguage(projectRoot, phase1Manifest);
      const decision = decideScaffoldEmission(detected);
      emitTsScaffold = decision.emitTs;
      emitPyScaffold = decision.emitPy;
      if (decision.skipped) {
        process.stderr.write(`  [SCAFFOLD] skipped — language mismatch (detected: ${decision.skipped.detected}, templates: ${decision.skipped.template})\n`);
        // Persist the skip into manifest.json so `writeGateBlockToManifest`
        // (later in the pipeline) can merge it into the gate block without
        // losing it. Read-modify-write matches the pattern used by sibling
        // writers in this file.
        try {
          let mf: Record<string, unknown> = {};
          if (fs.existsSync(phase1ManifestPath)) {
            try { mf = JSON.parse(fs.readFileSync(phase1ManifestPath, 'utf-8')) as Record<string, unknown>; } catch { mf = {}; }
          }
          mf['phase5b_skipped'] = decision.skipped;
          fs.writeFileSync(phase1ManifestPath, JSON.stringify(mf, null, 2), { mode: 0o600, encoding: 'utf-8' });
        } catch { /* best-effort */ }
      }
    } catch { /* language detection is best-effort; default to emit both (prev behaviour) */ }

    if (!emitTsScaffold && !emitPyScaffold) {
      // Rule 5 — no matching scaffold templates for this language. Plan
      // promotion (sparc/adrs/ddd/tdd/prompts slots) already ran above and
      // is language-agnostic, so it stays.
      if (totalCopied > 0 || totalSkipped > 0) {
        const parts: string[] = [];
        if (totalCopied > 0) parts.push(`${totalCopied} copied`);
        if (totalSkipped > 0) parts.push(`${totalSkipped} unchanged (skipped)`);
        console.error(`  [PLANS] ${parts.join(', ')} → .agentics/plans/`);
      }
      writePlanPromotionToManifest(runDir, promotionSummary);
      return;
    }

    // The TS-scaffold block below is fenced by this flag. Everything from
    // the scaffoldDir creation through the OWNED_MODULES + duplicate-scan
    // pass is TS-only — when the detected language is Python, skip it.
    if (emitTsScaffold) {

    // ADR-PIPELINE-039: Write actual scaffold files that Claude Code can include directly.
    // These are the cross-cutting infrastructure modules that every project needs.
    // Instead of hoping the coding agent reads the prompts, we deliver the files.
    const scaffoldDir = path.join(plansDir, 'scaffold', 'src');
    fs.mkdirSync(scaffoldDir, { recursive: true });

    // ADR-PIPELINE-074: logger scaffold now uses AsyncLocalStorage for
    // concurrent-request correctness. Body lives in LOGGER_SCAFFOLD at
    // module scope so it can be unit-tested independently.
    const loggerCode = LOGGER_SCAFFOLD;

    // ADR-PIPELINE-039 + ADR-PIPELINE-075: AppConfig now includes a `db`
    // block so the composition root can pick sqlite (production) vs
    // in-memory (tests) without code changes.
    const configCode = `// Auto-generated by Agentics pipeline (ADR-039 + ADR-PIPELINE-075)
export interface AppConfig {
  env: 'development' | 'staging' | 'production' | 'test';
  port: number;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  erp: {
    baseUrl: string;
    apiVersion: string;
    timeoutMs: number;
    maxRetries: number;
  };
  db: {
    driver: 'sqlite' | 'in-memory';
    path: string;
  };
}

export const config: AppConfig = {
  env: (process.env['NODE_ENV'] ?? 'development') as AppConfig['env'],
  port: parseInt(process.env['PORT'] ?? '3000', 10),
  logLevel: (process.env['LOG_LEVEL'] ?? 'info') as AppConfig['logLevel'],
  erp: {
    baseUrl: process.env['ERP_BASE_URL'] ?? 'https://api.example.com',
    apiVersion: process.env['ERP_API_VERSION'] ?? 'v1',
    timeoutMs: parseInt(process.env['ERP_TIMEOUT_MS'] ?? '30000', 10),
    maxRetries: parseInt(process.env['ERP_MAX_RETRIES'] ?? '3', 10),
  },
  db: {
    driver: (process.env['DB_DRIVER'] ?? 'sqlite') as AppConfig['db']['driver'],
    path: process.env['DB_PATH'] ?? './data/app.db',
  },
};
`;

    const errorsCode = `// Auto-generated by Agentics pipeline (ADR-039)
export class AppError extends Error {
  constructor(message: string, public readonly code: string, public readonly statusCode = 500) {
    super(message);
    this.name = 'AppError';
  }
}

export class ValidationError extends AppError {
  constructor(message: string) {
    super(message, 'VALIDATION_ERROR', 400);
  }
}

export class NotFoundError extends AppError {
  constructor(entity: string, id: string) {
    super(\`\${entity} \${id} not found\`, 'NOT_FOUND', 404);
  }
}

export class ERPError extends AppError {
  constructor(message: string, public readonly retryable: boolean) {
    super(message, 'ERP_ERROR', 502);
  }
}
`;

    // TypeScript scaffold (default)
    fs.writeFileSync(path.join(scaffoldDir, 'logger.ts'), loggerCode, 'utf-8');
    // ADR-PIPELINE-074: ship a concurrency regression test next to the
    // logger so generated projects fail loudly if someone reintroduces
    // a module-level correlation-ID store.
    fs.writeFileSync(
      path.join(scaffoldDir, 'logger.concurrency.test.ts'),
      LOGGER_CONCURRENCY_TEST_SCAFFOLD,
      'utf-8',
    );
    fs.writeFileSync(path.join(scaffoldDir, 'config.ts'), configCode, 'utf-8');
    fs.writeFileSync(path.join(scaffoldDir, 'errors.ts'), errorsCode, 'utf-8');

    // ADR-PIPELINE-075: Scaffolded persistence layer — Repository<T> +
    // InMemoryRepository + SqliteRepository + AppendOnlyAuditRepository.
    // Every stateful service should import these instead of rolling a
    // Map<string, T> store. PGV-017 flags the anti-pattern at post-gen time.
    const persistenceDir = path.join(scaffoldDir, 'persistence');
    fs.mkdirSync(persistenceDir, { recursive: true });
    fs.writeFileSync(path.join(persistenceDir, 'repository.ts'), REPOSITORY_SCAFFOLD, 'utf-8');
    fs.writeFileSync(path.join(persistenceDir, 'in-memory-repository.ts'), IN_MEMORY_REPO_SCAFFOLD, 'utf-8');
    fs.writeFileSync(path.join(persistenceDir, 'sqlite-repository.ts'), SQLITE_REPO_SCAFFOLD, 'utf-8');
    fs.writeFileSync(path.join(persistenceDir, 'audit-repository.ts'), AUDIT_REPO_SCAFFOLD, 'utf-8');

    // ADR-PIPELINE-078: deep canonical JSON + audit hash helper.
    // Every generated AuditService should import hashAuditEntry from this
    // helper instead of hand-rolling JSON.stringify + createHash chains.
    // PGV-022 flags the anti-pattern at post-gen time.
    fs.writeFileSync(path.join(persistenceDir, 'canonical-json.ts'), CANONICAL_JSON_SCAFFOLD, 'utf-8');
    fs.writeFileSync(path.join(persistenceDir, 'audit-hash.ts'), AUDIT_HASH_SCAFFOLD, 'utf-8');

    // ADR-051 + ADR-PIPELINE-074: Correlation ID middleware now wraps next()
    // in runWithCorrelation so the ID lives in AsyncLocalStorage for the
    // request's entire async continuation. Concurrent requests cannot
    // cross-contaminate log lines.
    const middlewareCode = `// Auto-generated by Agentics pipeline (ADR-051 + ADR-PIPELINE-074)
import { randomUUID } from 'node:crypto';
import { createLogger, runWithCorrelation } from './logger.js';

const logger = createLogger('middleware');

/**
 * Correlation ID middleware — attaches to every request, threads through
 * logs via AsyncLocalStorage. The request handler + all its async
 * descendants run inside runWithCorrelation so getCorrelationId() returns
 * this request's ID, not a sibling's.
 */
export function correlationId(req: any, res: any, next: () => void): void {
  const id = (req.headers['x-correlation-id'] as string) || randomUUID();
  req.correlationId = id;
  res.setHeader('X-Correlation-Id', id);
  runWithCorrelation(id, next);
}

/** Request logging middleware — logs every request with timing */
export function requestLogger(req: any, res: any, next: () => void): void {
  const start = Date.now();
  res.on('finish', () => {
    logger.info('http.request', {
      method: req.method, path: req.path, status: res.statusCode,
      durationMs: Date.now() - start, correlationId: req.correlationId,
    });
  });
  next();
}

/** Simple in-memory metrics — GET /metrics returns Prometheus-compatible text */
const counters: Record<string, number> = {};
const histograms: Record<string, number[]> = {};

export function incrementCounter(name: string, labels: Record<string, string> = {}): void {
  const key = name + JSON.stringify(labels);
  counters[key] = (counters[key] ?? 0) + 1;
}

export function recordHistogram(name: string, value: number, labels: Record<string, string> = {}): void {
  const key = name + JSON.stringify(labels);
  if (!histograms[key]) histograms[key] = [];
  histograms[key]!.push(value);
}

/**
 * ADR-PIPELINE-076: Pure metrics renderer — returns Prometheus text.
 * Framework-specific wrappers (metricsHandlerExpress, metricsHandlerHono)
 * delegate here. Call this directly from any framework that isn't
 * Express or Hono.
 */
export function metricsHandler(): string {
  const lines: string[] = [];
  for (const [key, val] of Object.entries(counters)) {
    lines.push(\`# TYPE \${key.split('{')[0]} counter\`);
    lines.push(\`\${key} \${val}\`);
  }
  for (const [key, vals] of Object.entries(histograms)) {
    const sum = vals.reduce((a, b) => a + b, 0);
    const count = vals.length;
    lines.push(\`# TYPE \${key.split('{')[0]} histogram\`);
    lines.push(\`\${key}_sum \${sum}\`);
    lines.push(\`\${key}_count \${count}\`);
  }
  return lines.join('\\n');
}

/** Express-compatible metrics handler — wraps metricsHandler(). */
export function metricsHandlerExpress(_req: any, res: any): void {
  res.setHeader('Content-Type', 'text/plain; version=0.0.4');
  res.end(metricsHandler());
}

// ADR-PIPELINE-069: CircuitBreaker now lives in its own scaffold module.
// This re-export keeps existing imports (from './middleware.js') working
// while making the canonical class importable from a dedicated file.
export { CircuitBreaker } from './circuit-breaker.js';
`;
    fs.writeFileSync(path.join(scaffoldDir, 'middleware.ts'), middlewareCode, 'utf-8');
    totalCopied += 1;

    // ADR-PIPELINE-069: standalone scaffolded circuit-breaker module so
    // generators can import CircuitBreaker without pulling all of
    // middleware.ts. Owned by the scaffold (see OWNED_SCAFFOLD_MODULES).
    fs.writeFileSync(path.join(scaffoldDir, 'circuit-breaker.ts'), CIRCUIT_BREAKER_SCAFFOLD, 'utf-8');
    totalCopied += 1;

    // ADR-PIPELINE-076: wire-complete Hono base app. Generators extend
    // via createBaseApp(deps).route('/api/<domain>', router) instead of
    // rebuilding the middleware/metrics/health plumbing from scratch.
    // PGV-018 will fail the build if /metrics, /health/live, /health/ready
    // are missing from the final project tree.
    const apiDir = path.join(scaffoldDir, 'api');
    fs.mkdirSync(apiDir, { recursive: true });
    fs.writeFileSync(path.join(apiDir, 'base-app.ts'), BASE_APP_SCAFFOLD_HONO, 'utf-8');
    totalCopied += 1;

    // ADR-PIPELINE-077: ERP schema provenance helper. Every generated
    // ERP adapter MUST export an ERP_SCHEMA_PROVENANCE constant and call
    // assertErpProvenanceOrFail at construction so strict-mode deployments
    // block on unreviewed schemas. PGV-020 enforces presence, PGV-021
    // enforces reviewer + catalog_version on validated entries.
    const erpDir = path.join(scaffoldDir, 'erp');
    fs.mkdirSync(erpDir, { recursive: true });
    fs.writeFileSync(
      path.join(erpDir, 'schema-provenance.ts'),
      ERP_SCHEMA_PROVENANCE_SCAFFOLD,
      'utf-8',
    );
    totalCopied += 1;

    // ADR-PIPELINE-066: unit-economics helper. The demo script calls
    // writeUnitEconomics() to emit a machine-readable manifest that the
    // executive renderer prefers over per-employee heuristics.
    const unitEconomicsCode = `// Auto-generated by Agentics pipeline (ADR-PIPELINE-066)
// Writes .agentics/runs/<run-id>/unit-economics.json so the executive
// renderer can use bottom-up unit economics instead of heuristics.
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface DomainUnit {
  label: string;   // e.g. "occupied room night"
  abbrev: string;  // e.g. "orn"
}

export interface UnitEconomicsScope {
  properties?: number;
  rooms?: number;
  sqft?: number;
  vehicles?: number;
  beds?: number;
  agents?: number;
  units?: number;
  employees?: number;
  region_mix?: Array<'NA' | 'EMEA' | 'APAC' | 'LATAM' | 'MEA'>;
}

export interface UnitEconomics {
  run_id: string;
  sector: string;
  domain_unit: DomainUnit;
  measured_scope: UnitEconomicsScope;
  enterprise_scope: UnitEconomicsScope;
  unit_savings: Record<string, number>;
  annual_measured_savings_usd: number;
  annual_extrapolated_savings_usd: number;
  extrapolation_method: string;
  confidence: { directional: number; precision: number };
  generated_at?: string;
  source?: 'prototype';
}

function findRunDir(): string | null {
  // 1. Explicit override
  const override = process.env['AGENTICS_RUN_DIR'];
  if (override && existsSync(override)) return override;

  // 2. Walk upward looking for .agentics/runs/latest
  let dir: string;
  try {
    dir = dirname(fileURLToPath(import.meta.url));
  } catch {
    dir = process.cwd();
  }
  for (let i = 0; i < 6; i++) {
    const candidate = join(dir, '.agentics', 'runs', 'latest');
    if (existsSync(candidate)) return resolve(candidate);
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  // 3. Build from run id if we can find one
  const simId = process.env['AGENTICS_SIMULATION_ID'];
  if (simId) {
    const dest = join(process.cwd(), '.agentics', 'runs', simId);
    return dest;
  }

  return join(process.cwd(), '.agentics', 'runs', 'local-run');
}

export function writeUnitEconomics(manifest: UnitEconomics): string {
  const runDir = findRunDir();
  if (!runDir) throw new Error('ECLI-UE-066: unable to resolve run directory');
  mkdirSync(runDir, { recursive: true });
  const out = {
    source: 'prototype' as const,
    generated_at: new Date().toISOString(),
    ...manifest,
  };
  const filePath = join(runDir, 'unit-economics.json');
  writeFileSync(filePath, JSON.stringify(out, null, 2) + '\\n', 'utf-8');
  return filePath;
}

export function readUnitEconomics(runDir: string): UnitEconomics | null {
  const filePath = join(runDir, 'unit-economics.json');
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, 'utf-8')) as UnitEconomics;
  } catch {
    return null;
  }
}
`;
    fs.writeFileSync(path.join(scaffoldDir, 'unit-economics.ts'), unitEconomicsCode, 'utf-8');
    totalCopied += 1;

    // ADR-PIPELINE-068: ESM-safe simulation-lineage helper. Every generated
    // project gets a loader that reads .agentics/plans/manifest.json using
    // readFileSync + fileURLToPath. NEVER use CommonJS require() in the
    // generated project — it is "type": "module" and require() throws at
    // runtime, producing a silent sim-unknown fallback that severs lineage.
    // The string body lives at module scope (SIMULATION_LINEAGE_SCAFFOLD)
    // so it can be unit-tested without invoking copyPlanningArtifacts.
    fs.writeFileSync(path.join(scaffoldDir, 'simulation-lineage.ts'), SIMULATION_LINEAGE_SCAFFOLD, 'utf-8');
    totalCopied += 1;

    // ADR-PIPELINE-069: Sidecar manifest listing every scaffold-owned
    // module + its public exports. Consumed by:
    //   - prompt-generator.ts (injects "do not reimplement" block)
    //   - post-generation-validator PGV-012 (bans duplicate declarations)
    // The manifest is the single source of truth — generators MUST NOT
    // re-emit any export listed here.
    const ownedManifestPath = path.join(plansDir, 'scaffold', 'OWNED_MODULES.json');
    fs.writeFileSync(
      ownedManifestPath,
      JSON.stringify(buildOwnedModulesManifest(), null, 2) + '\n',
      'utf-8',
    );
    totalCopied += 1;

    // ADR-PIPELINE-069: Cleanup pass — scan the project tree for files
    // that redeclare an export listed in OWNED_MODULES.json. Logs the
    // count; under AGENTICS_AUTO_DEDUPE=true, deletes the duplicates.
    try {
      const projectRootForScan = projectRoot;
      const dupes = detectScaffoldDuplicates(projectRootForScan, OWNED_SCAFFOLD_MODULES);
      const autoDedupe = process.env['AGENTICS_AUTO_DEDUPE'] === 'true';
      if (dupes.length > 0) {
        console.error(
          `  [SCAFFOLD] scaffold.duplicate.detected count=${dupes.length}` +
          (autoDedupe ? ' (auto-deduping)' : ' (set AGENTICS_AUTO_DEDUPE=true to delete)'),
        );
        for (const d of dupes) {
          console.error(`    - ${d.path} redeclares ${d.exportName} (owned by ${d.ownedPath})`);
          if (autoDedupe) {
            try { fs.unlinkSync(d.path); } catch { /* best-effort */ }
          }
        }
      } else {
        console.error('  [SCAFFOLD] scaffold.duplicate.detected: 0');
      }
    } catch {
      // Cleanup is best-effort — never block scaffold emission on a scan failure.
    }

    totalCopied += 3; // 3 TS files (logger, config, errors) — PY counted below if emitted
    } // end if (emitTsScaffold)

    // ADR-PIPELINE-093 §Rule 5 — Python scaffold block is gated on
    // `emitPyScaffold`. TypeScript projects no longer get a stray `python/`
    // directory full of `.py` files (the originating contamination bug).
    if (emitPyScaffold) {
    const pyDir = path.join(plansDir, 'scaffold', 'python');
    fs.mkdirSync(pyDir, { recursive: true });
    fs.writeFileSync(path.join(pyDir, 'logger.py'), `"""Structured JSON logger — auto-generated by Agentics pipeline."""
import json, sys, time
from typing import Any, Optional

_correlation_id: Optional[str] = None

def set_correlation_id(cid: str) -> None:
    global _correlation_id
    _correlation_id = cid

def get_correlation_id() -> Optional[str]:
    return _correlation_id

def _emit(level: str, service: str, event: str, **data: Any) -> None:
    entry = {"timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "level": level, "service": service, "event": event}
    if _correlation_id:
        entry["correlationId"] = _correlation_id
    entry.update(data)
    print(json.dumps(entry), file=sys.stderr)

class Logger:
    def __init__(self, service: str):
        self._service = service
    def info(self, event: str, **data: Any) -> None: _emit("info", self._service, event, **data)
    def warn(self, event: str, **data: Any) -> None: _emit("warn", self._service, event, **data)
    def error(self, event: str, error: Exception, **data: Any) -> None: _emit("error", self._service, event, error=str(error), **data)

def create_logger(service: str) -> Logger:
    return Logger(service)
`, 'utf-8');
    fs.writeFileSync(path.join(pyDir, 'config.py'), `"""Environment-based configuration — auto-generated by Agentics pipeline."""
import os

class AppConfig:
    env: str = os.getenv("APP_ENV", "development")
    port: int = int(os.getenv("PORT", "8000"))
    log_level: str = os.getenv("LOG_LEVEL", "info")
    erp_base_url: str = os.getenv("ERP_BASE_URL", "https://api.example.com")
    erp_api_version: str = os.getenv("ERP_API_VERSION", "v1")
    erp_timeout_ms: int = int(os.getenv("ERP_TIMEOUT_MS", "30000"))
    erp_max_retries: int = int(os.getenv("ERP_MAX_RETRIES", "3"))

config = AppConfig()
`, 'utf-8');
    fs.writeFileSync(path.join(pyDir, 'errors.py'), `"""Typed error hierarchy — auto-generated by Agentics pipeline."""

class AppError(Exception):
    def __init__(self, message: str, code: str, status_code: int = 500):
        super().__init__(message)
        self.code = code
        self.status_code = status_code

class ValidationError(AppError):
    def __init__(self, message: str):
        super().__init__(message, "VALIDATION_ERROR", 400)

class NotFoundError(AppError):
    def __init__(self, entity: str, entity_id: str):
        super().__init__(f"{entity} {entity_id} not found", "NOT_FOUND", 404)

class ERPError(AppError):
    def __init__(self, message: str, retryable: bool = False):
        super().__init__(message, "ERP_ERROR", 502)
        self.retryable = retryable
`, 'utf-8');

    totalCopied += 3; // 3 Python files (logger, config, errors)
    } // end if (emitPyScaffold)

    if (totalCopied > 0 || totalSkipped > 0) {
      const parts: string[] = [];
      if (totalCopied > 0) parts.push(`${totalCopied} copied`);
      if (totalSkipped > 0) parts.push(`${totalSkipped} unchanged (skipped)`);
      console.error(`  [PLANS] ${parts.join(', ')} → .agentics/plans/`);
    }

    // ADR-PIPELINE-092, Rule 5 + `planPromotion` manifest block:
    // merge per-slot counts + missing_slots into runDir/manifest.json so CI
    // can assert on plan-promotion completeness without parsing stderr.
    writePlanPromotionToManifest(runDir, promotionSummary);
  } catch {
    // Non-fatal — never block the pipeline for artifact copy
  }
}

/**
 * Merge ruflo swarm output from .ruflo-cache/phaseN/ into the phase directory.
 * Ruflo-produced files supplement the template generator output. Markdown files
 * from ruflo are written alongside (not overwriting) template-generated files
 * to ensure agent-produced research and SPARC content is preserved.
 */
function mergeRufloCacheIntoPhase(runDir: string, phaseNum: number): number {
  const cacheDir = path.join(runDir, '.ruflo-cache', `phase${phaseNum}`);
  const phaseDir = path.join(runDir, `phase${phaseNum}`);

  if (!fs.existsSync(cacheDir)) return 0;
  if (!fs.existsSync(phaseDir)) fs.mkdirSync(phaseDir, { recursive: true });

  let merged = 0;

  function copyRecursive(src: string, dest: string): void {
    const entries = fs.readdirSync(src, { withFileTypes: true });
    for (const entry of entries) {
      const srcPath = path.join(src, entry.name);
      const destPath = path.join(dest, entry.name);

      if (entry.isDirectory()) {
        if (!fs.existsSync(destPath)) fs.mkdirSync(destPath, { recursive: true });
        copyRecursive(srcPath, destPath);
      } else {
        // Skip swarm metadata files — they're coordination artifacts, not content
        if (entry.name === 'state.json' && srcPath.includes('.swarm')) continue;
        if (entry.name === 'store.json' && srcPath.includes('.claude-flow')) continue;
        // Ruflo swarm output is PRIMARY when it produces real content.
        // Always overwrite template-generated files so agent output takes priority.
        fs.copyFileSync(srcPath, destPath);
        merged++;
      }
    }
  }

  try {
    copyRecursive(cacheDir, phaseDir);
    if (merged > 0) {
      console.error(`  [MERGE] Copied ${merged} ruflo swarm files into phase${phaseNum}/`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`  [MERGE] Warning: ${msg}`);
  }

  return merged;
}

// ============================================================================
// Main Orchestrator
// ============================================================================

/**
 * Execute the full auto-chain pipeline (Phases 2-6) for a given trace ID.
 *
 * Phase 1 artifacts must already exist at ~/.agentics/runs/<traceId>/.
 * Each subsequent phase reads the prior phase's output from the same run directory.
 */
/**
 * ADR-PIPELINE-028: Nuclear ADR guarantee. Call before returning from executeAutoChain.
 * Checks if ADRs exist anywhere in the run directory. If not, generates them from
 * the scenario query using the template builder (no LLM required).
 */
async function ensureAdrsExist(runDir: string, traceId: string, scenarioQuery: string): Promise<void> {
  if (!scenarioQuery) return;

  const adrLocations = [
    path.join(runDir, 'phase4', 'adrs', 'adr-index.json'),
    path.join(runDir, 'phase2', 'adrs', 'adr-index.json'),
  ];
  const hasAdrs = adrLocations.some(p => {
    try {
      if (!fs.existsSync(p)) return false;
      const content = JSON.parse(fs.readFileSync(p, 'utf-8'));
      return Array.isArray(content) && content.length > 0;
    } catch { return false; }
  });

  if (hasAdrs) return;

  console.error('');
  console.error('  [ADR-028] No ADRs found — generating guaranteed set');

  try {
    const { buildLoudFailureADR } = await import('./phase2/phases/adr-generator.js');
    const { buildPhase2DDD } = await import('./phase2/phases/ddd-generator.js');

    // Load SPARC/dossier from any available location, or use empty defaults
    let sparc: Record<string, unknown> = { architecture: { services: [] }, specification: { requirements: [], constraints: [] } };
    let dossier: Record<string, unknown> = { items: [], crossReferences: [], summary: { totalItems: 0, bySource: {}, byCategory: {}, keyRisks: [], criticalConstraints: [] }, id: 'fallback', traceId, generatedFrom: 'adr-028-guarantee' };

    for (const sub of ['phase3/sparc/sparc-combined.json', 'phase2/sparc/sparc-combined.json', 'phase2/sparc-specification.json']) {
      const p = path.join(runDir, sub);
      if (fs.existsSync(p)) { try { sparc = JSON.parse(fs.readFileSync(p, 'utf-8')); break; } catch { /* skip */ } }
    }
    for (const sub of ['phase2/research-dossier.json', 'research-dossier.json']) {
      const p = path.join(runDir, sub);
      if (fs.existsSync(p)) { try { dossier = JSON.parse(fs.readFileSync(p, 'utf-8')); break; } catch { /* skip */ } }
    }

    // ADR-PIPELINE-100 §D5: ADR-028 guarantee path emits a loud-failure ADR
    // directly rather than calling the LLM. By the time we reach this branch
    // Phase 4 has already run (or been skipped); the LLM pass would either
    // duplicate Phase 4's work or block the guarantee path on a 30-min cap.
    const adrs = [buildLoudFailureADR({
      reason: 'ADR-028 guarantee path: no usable ADRs found anywhere in the run after Phase 4 completed/skipped. This failure ADR is written to satisfy the "always emit something" contract without re-running the LLM.',
      claudeFailureReason: 'guarantee path skipped LLM call — see Phase 4 logs for the original failure',
      dossierItemCount: (dossier as { items?: unknown[] }).items?.length ?? 0,
      sparcStatus: 'unknown',
      query: scenarioQuery,
    })];

    // Write to BOTH phase4 and phase2 so downstream consumers find them regardless of which path they check
    for (const targetDir of [path.join(runDir, 'phase4'), path.join(runDir, 'phase2')]) {
      const adrDir = path.join(targetDir, 'adrs');
      try {
        fs.mkdirSync(adrDir, { recursive: true });
      } catch (mkdirErr) {
        console.error(`  [ADR WRITE FAILED] mkdir ${adrDir}: ${mkdirErr instanceof Error ? mkdirErr.message : String(mkdirErr)}`);
        throw mkdirErr;
      }
      const indexPath = path.join(adrDir, 'adr-index.json');
      try {
        fs.writeFileSync(indexPath, JSON.stringify(adrs, null, 2) + '\n', 'utf-8');
      } catch (writeErr) {
        console.error(`  [ADR WRITE FAILED] index ${indexPath}: ${writeErr instanceof Error ? writeErr.message : String(writeErr)}`);
        throw writeErr;
      }
      for (const adr of adrs) {
        const slug = (adr.title || 'untitled').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 60);
        const md = [
          `# ${adr.id}: ${adr.title}`,
          `\n**Status:** ${adr.status}`,
          `**Date:** ${adr.date}`,
          `\n## Context\n${adr.context}`,
          `\n## Decision\n${adr.decision}`,
          adr.alternatives?.length > 0 ? `\n## Alternatives Considered\n${adr.alternatives.map((a: any) => `- **${a.option}** ${a.rejected ? '(rejected)' : '(selected)'}: ${a.rationale}`).join('\n')}` : '',
          adr.consequences?.length > 0 ? `\n## Consequences\n${adr.consequences.map((c: any) => `- [${c.type === 'positive' ? '+' : c.type === 'negative' ? '-' : '~'}] ${c.description}`).join('\n')}` : '',
        ].filter(Boolean).join('\n');
        const adrPath = path.join(adrDir, `${adr.id}-${slug}.md`);
        try {
          fs.writeFileSync(adrPath, md + '\n', 'utf-8');
        } catch (writeErr) {
          console.error(`  [ADR WRITE FAILED] ${adrPath}: ${writeErr instanceof Error ? writeErr.message : String(writeErr)}`);
          throw writeErr;
        }
      }
    }
    console.error(`  [ADR-028] Generated ${adrs.length} ADRs (phase4/adrs/ + phase2/adrs/)`);

    // Also generate DDD model
    try {
      const dddModel = buildPhase2DDD(sparc as any, adrs as any, dossier as any, scenarioQuery);
      if (dddModel?.contexts?.length > 0) {
        for (const targetDir of [path.join(runDir, 'phase4'), path.join(runDir, 'phase2')]) {
          const dddDir = path.join(targetDir, 'ddd');
          fs.mkdirSync(dddDir, { recursive: true });
          fs.writeFileSync(path.join(dddDir, 'domain-model.json'), JSON.stringify(dddModel, null, 2) + '\n', 'utf-8');
        }
        console.error(`  [ADR-028] Generated DDD model (${dddModel.contexts.length} bounded contexts)`);
      }
    } catch {
      // DDD is best-effort
    }

    // Write phase4-manifest.json so Phase 5 can proceed
    const phase4Dir = path.join(runDir, 'phase4');
    const manifestPath = path.join(phase4Dir, 'phase4-manifest.json');
    if (!fs.existsSync(manifestPath)) {
      const manifest = {
        schema_version: '4.0.0',
        trace_id: traceId,
        generated_at: new Date().toISOString(),
        pipeline_version: '1.9.5',
        stages: [
          { stage: 'prior-phase-loading', status: 'completed', timing_ms: 0, artifact_count: 0 },
          { stage: 'adr-generation', status: 'completed', timing_ms: 0, artifact_count: adrs.length },
          { stage: 'ddd-generation', status: 'completed', timing_ms: 0, artifact_count: 1 },
        ],
        artifacts: adrs.map(a => ({
          path: `adrs/${a.id}-${(a.title || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40)}.md`,
          sha256: 'generated-by-adr-028-guarantee',
          size_bytes: 0,
        })),
        success: true,
        implementation_language: 'typescript',
        erp_system: adrs.find(a => /integration/i.test(a.title))?.title.match(/(\w+)\s+Integration/)?.[1] ?? 'generic',
      };
      fs.mkdirSync(phase4Dir, { recursive: true });
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf-8');
      console.error(`  [ADR-028] Wrote phase4-manifest.json (enables Phase 5)`);
    }
  } catch (err) {
    console.error(`  [ADR-028] ADR guarantee failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export async function executeAutoChain(
  traceId: string,
  options: AutoChainOptions = {},
): Promise<AutoChainResult> {
  const pipelineStart = Date.now();
  const homeDir = process.env['HOME'] ?? '/tmp';
  const runDir = path.join(homeDir, '.agentics', 'runs', traceId);
  const phases: PhaseResult[] = [];

  // ADR-PIPELINE-091: per-phase Ruflo primary-executor results. Filled in by
  // `runRufloPrimaryForPhase` before each downstream coordinator runs; read
  // at the end of this function to build the manifest `execution` block.
  const rufloPrimaryResults: {
    phase3?: PrimaryPhaseExecutionResult;
    phase4?: PrimaryPhaseExecutionResult;
    phase5a?: PrimaryPhaseExecutionResult;
  } = {};

  // ADR-PIPELINE-093: per-phase gate outcomes. Fed by `runPhaseGate` before
  // each coordinator runs; flushed to `manifest.json` by
  // `writeGateBlockToManifest` at pipeline completion.
  const gateAcc: GateAccumulator = newGateAccumulator();
  // Per-phase block flags — set by the gate and consulted by downstream
  // phases to decide whether to attempt their coordinator at all.
  const phaseBlocked: Record<GatePhaseId, boolean> = {
    phase2: false,
    'phase3-sparc': false,
    'phase4-adrs-ddd': false,
    'phase5a-prompts': false,
    'phase5b-scaffold': false,
  };

  // ── Detect execution mode ──
  const execCtx: ExecutionContext = detectExecutionMode();
  const mode = options.executionMode ?? execCtx.mode;
  // ADR-051: Use git repo root for artifact placement — process.cwd() is unreliable in MCP mode
  const projectRoot = execCtx.repoRoot ?? process.cwd();
  let scenarioBranch: string | undefined;
  let originalBranch: string | undefined;
  let scenarioQuery = '';

  // Read scenario query and simulation ID from Phase 1 manifest
  let simulationId = '';
  try {
    const manifestPath = path.join(runDir, 'manifest.json');
    if (fs.existsSync(manifestPath)) {
      const raw = fs.readFileSync(manifestPath, 'utf-8');
      const manifest = JSON.parse(raw) as { query?: string; simulation_id?: string; execution_id?: string };
      scenarioQuery = manifest.query ?? '';
      simulationId = manifest.simulation_id ?? manifest.execution_id ?? '';
    }
  } catch {
    // Best-effort
  }

  console.error('');
  console.error('='.repeat(72));
  console.error('  ENTERPRISE PROTOTYPE PIPELINE');
  console.error(`  Mode: ${mode === 'development' ? 'DEVELOPMENT (sandbox — no repo mutation)' : 'PROJECT (current branch)'}`);
  console.error('  Auto-chaining Phases 2-6 from simulation artifacts');
  console.error('='.repeat(72));
  console.error('');

  // ── Check ruflo availability (optional — pipeline works without it) ──
  {
    try {
      execSync('ruflo --version', { stdio: 'pipe', timeout: 5000 });
    } catch {
      // ruflo not installed — pipeline continues without coding swarm
      // This is normal when running via MCP or in environments without ruflo
    }
  }

  // ── Initialize Ruflo swarm orchestration ──
  const swarmActive = initSwarm({
    topology: 'hierarchical',
    maxAgents: 8,
    strategy: 'specialized',
    traceId,
    runDir,
  });
  if (swarmActive) {
    console.error('  Ruflo swarm active — agents will coordinate each phase');
    console.error('');
  }

  // ── Project mode: stay on current branch, output to project subdirectory ──
  if (mode === 'project') {
    originalBranch = execCtx.currentBranch ?? 'main';
    console.error(`  Branch: ${originalBranch} (no branch switching — files written directly)`);
    console.error('');
  }

  // ── Print Phase 1 artifact summary ──
  printPhase1Summary(runDir, traceId);

  // ── Phase 2: Deep Research ──
  {
    const phaseStart = Date.now();
    const phaseDir = path.join(runDir, 'phase2');
    console.error('');
    console.error('-'.repeat(72));
    console.error('  >> Phase 2: Deep Research');
    console.error('-'.repeat(72));

    const phase2HasContent = fs.existsSync(phaseDir)
      && fs.existsSync(path.join(phaseDir, 'research-dossier.json'))
      && fs.existsSync(path.join(phaseDir, 'sparc', 'sparc-combined.json'));
    if (phase2HasContent) {
      console.error('  [SKIP] Phase 2 already exists — using existing artifacts');
      phases.push({ phase: 2, label: 'Deep Research', status: 'skipped', timing: 0, artifacts: [], outputDir: phaseDir });
    } else {
      // ADR-PIPELINE-093 — Phase 2 gate. Verifies Phase 1 required inputs
      // (manifest.json + executive-summary.md) are present before dispatch.
      const gate = await runPhaseGate('phase2', scenarioQuery, traceId, runDir, gateAcc);
      if (!gate.ok && gate.stillMissing.length > 0) {
        phaseBlocked['phase2'] = true;
        console.error('  [SKIP] Phase 2 blocked by gate — required Phase 1 inputs missing');
        phases.push({ phase: 2, label: 'Deep Research', status: 'skipped', timing: Date.now() - phaseStart, artifacts: [], outputDir: phaseDir, error: `blocked: ${gate.stillMissing.join(', ')}` });
        // Fall through to downstream phases; each has its own gate.
      } else {
      // Clean up incomplete phase2 directory from a prior failed run
      if (fs.existsSync(phaseDir) && !fs.existsSync(path.join(phaseDir, 'sparc', 'sparc-combined.json'))) {
        console.error('  [CLEANUP] Removing incomplete phase2 directory from prior run');
        fs.rmSync(phaseDir, { recursive: true, force: true });
      }
      const agentResults = await dispatchPhaseAgents(PHASE_AGENTS[2]!, traceId, runDir, scenarioQuery);

      // Ruflo swarm + agentics agents: write deep research cooperatively
      // Output to .ruflo-cache/ so we don't pre-create phaseDir (append-only guard in executePhaseNCommand)
      const rufloOutputDir = path.join(runDir, '.ruflo-cache', 'phase2');
      const rufloResult = executeRufloPhaseSwarm({
        phase: 2, label: 'Deep Research', scenarioQuery,
        runDir, traceId, outputDir: rufloOutputDir,
        tasks: buildPhase2Tasks(scenarioQuery, collectPhase2Artifacts(runDir)),
        agenticsResults: agentResults,
        priorArtifacts: collectPhase2Artifacts(runDir),
      });
      if (rufloResult.filesModified > 0) {
        console.error(`  [RUFLO-P2] ${rufloResult.filesModified} files generated (swarm+agents) in ${rufloResult.timing}ms`);
      }

      // Persist agent results BEFORE phase command so the SPARC generator,
      // research dossier, ADR generator, and DDD generator can read agent findings.
      // Write to .pre-phase2 — generators check this location if phase2Dir doesn't have the report yet.
      // CANNOT write to phase2Dir directly — the phase command has an append-only guard that
      // throws ECLI-P2-003 if the directory already exists.
      persistAgenticsResults(path.join(runDir, '.pre-phase2'), agentResults);

      try {
        const result = await executePhase2Command({ trace: traceId });
        mergeRufloCacheIntoPhase(runDir, 2);
        const timing = Date.now() - phaseStart;
        const artifactPaths = extractArtifactPaths(result.manifest.artifacts);
        console.error(formatPhase2ForDisplay(result));
        printArtifactLinks(phaseDir, artifactPaths);
        storePhaseArtifacts(PHASE_AGENTS[2]!, traceId, runDir, artifactPaths, timing);
        await reviewPhaseOutput(PHASE_AGENTS[2]!, traceId, runDir);
        persistAgenticsResults(phaseDir, agentResults);
        phases.push({ phase: 2, label: 'Deep Research', status: 'completed', timing, artifacts: artifactPaths, outputDir: phaseDir, agenticsAgents: buildAgentSummary(agentResults, PHASE_AGENTS[2]!.agenticsServices.length) });
        copyPlanningArtifacts(runDir, projectRoot);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.error(`  [FAIL] Phase 2 failed: ${errMsg}`);
        recordPhaseFailure(PHASE_AGENTS[2]!, traceId, errMsg);
        phases.push({ phase: 2, label: 'Deep Research', status: 'failed', timing: Date.now() - phaseStart, artifacts: [], outputDir: phaseDir, error: errMsg });
        copyPlanningArtifacts(runDir, projectRoot);
        await ensureAdrsExist(runDir, traceId, scenarioQuery);
        // ADR-094 Decision 4: emit skipped-due-to-upstream entries for phases 3..6.
        pushSkippedDueToUpstream(phases, { phase: 2, label: 'Deep Research', reason: errMsg }, runDir);
        return buildResult(traceId, runDir, phases, pipelineStart, mode);
      }
      } // close ADR-PIPELINE-093 phase2 gate-else
    }
  }

  // ── Phase 3: SPARC + London TDD ──
  {
    const phaseStart = Date.now();
    const phaseDir = path.join(runDir, 'phase3');
    console.error('');
    console.error('-'.repeat(72));
    console.error('  >> Phase 3: SPARC + London School TDD');
    console.error('-'.repeat(72));

    const phase3HasContent = fs.existsSync(phaseDir)
      && fs.existsSync(path.join(phaseDir, 'sparc', 'sparc-combined.json'));
    if (phase3HasContent) {
      console.error('  [SKIP] Phase 3 already exists — using existing artifacts');
      phases.push({ phase: 3, label: 'SPARC + London TDD', status: 'skipped', timing: 0, artifacts: [], outputDir: phaseDir });
    } else {
      // Clean up incomplete phase3 directory from a prior failed run
      if (fs.existsSync(phaseDir) && !phase3HasContent) {
        console.error('  [CLEANUP] Removing incomplete phase3 directory from prior run');
        fs.rmSync(phaseDir, { recursive: true, force: true });
      }

      // ADR-PIPELINE-093 — Phase 3 gate runs BEFORE the ADR-091 Ruflo-primary
      // call so the gate verifies (and, if necessary, regenerates) upstream
      // inputs before the phase's own Ruflo pass executes.
      const phase3Gate = await runPhaseGate('phase3-sparc', scenarioQuery, traceId, runDir, gateAcc);
      if (!phase3Gate.ok && phase3Gate.stillMissing.length > 0) {
        phaseBlocked['phase3-sparc'] = true;
        console.error('  [SKIP] Phase 3 blocked by gate — upstream inputs unrecoverable');
        phases.push({ phase: 3, label: 'SPARC + London TDD', status: 'skipped', timing: Date.now() - phaseStart, artifacts: [], outputDir: phaseDir, error: `blocked: ${phase3Gate.stillMissing.join(', ')}` });
        // Continue to Phase 4 — its own gate decides whether it can run.
      } else {

      // ADR-PIPELINE-091: Ruflo runs FIRST as the primary engineering-artifact
      // producer. Its output lands in runDir/engineering/*.md; the downstream
      // phase3 coordinator picks it up as its primary input. Remote diligence
      // agents that DID return from Phase 1 are attached as enrichment only.
      rufloPrimaryResults.phase3 = await runRufloPrimaryForPhase(
        'phase3-sparc',
        scenarioQuery,
        traceId,
        runDir,
        collectPhase3Artifacts(runDir),
        readRemoteEnrichmentSnapshot(runDir),
        path.join(runDir, '.ruflo-cache', 'phase3-primary'),
      );

      const agentResults = await dispatchPhaseAgents(PHASE_AGENTS[3]!, traceId, runDir, scenarioQuery);

      // Ruflo swarm + agentics agents: write SPARC specs + TDD plans cooperatively
      const rufloP3Dir = path.join(runDir, '.ruflo-cache', 'phase3');
      const rufloResult = executeRufloPhaseSwarm({
        phase: 3, label: 'SPARC + London TDD', scenarioQuery,
        runDir, traceId, outputDir: rufloP3Dir,
        tasks: buildPhase3Tasks(scenarioQuery, collectPhase3Artifacts(runDir)),
        agenticsResults: agentResults,
        priorArtifacts: collectPhase3Artifacts(runDir),
      });
      if (rufloResult.filesModified > 0) {
        console.error(`  [RUFLO-P3] ${rufloResult.filesModified} files generated (swarm+agents) in ${rufloResult.timing}ms`);
      }

      // Persist agent results to .pre-phase3 so generators can find them.
      // CANNOT write to phase3Dir — append-only guard throws if it exists.
      persistAgenticsResults(path.join(runDir, '.pre-phase3'), agentResults);

      try {
        const result = await executePhase3Command({ trace: traceId });
        mergeRufloCacheIntoPhase(runDir, 3);
        const timing = Date.now() - phaseStart;
        const artifactPaths = extractArtifactPaths(result.manifest.artifacts);
        console.error(formatPhase3ForDisplay(result));
        printArtifactLinks(phaseDir, artifactPaths);
        storePhaseArtifacts(PHASE_AGENTS[3]!, traceId, runDir, artifactPaths, timing);
        await reviewPhaseOutput(PHASE_AGENTS[3]!, traceId, runDir);
        persistAgenticsResults(phaseDir, agentResults);
        phases.push({ phase: 3, label: 'SPARC + London TDD', status: 'completed', timing, artifacts: artifactPaths, outputDir: phaseDir, agenticsAgents: buildAgentSummary(agentResults, PHASE_AGENTS[3]!.agenticsServices.length) });
        // ADR-PIPELINE-101 §harness — structural check on SPARC output.
        {
          const sparcCandidates = [
            path.join(runDir, 'engineering', 'sparc-specification.md'),
            path.join(runDir, 'plans', 'SPARC_SPECIFICATION.md'),
            path.join(phaseDir, 'sparc-combined.md'),
          ];
          const sparcPath = sparcCandidates.find((p) => fs.existsSync(p));
          if (sparcPath) {
            logStructuralFailures([validateSparc(sparcPath)], 'Phase 3 (SPARC)');
          } else {
            process.stderr.write(`  [STRUCTURE FAIL] Phase 3 (SPARC): no SPARC file found at any of ${sparcCandidates.join(' | ')}\n`);
          }
        }
        copyPlanningArtifacts(runDir, projectRoot);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.error(`  [FAIL] Phase 3 failed: ${errMsg}`);
        recordPhaseFailure(PHASE_AGENTS[3]!, traceId, errMsg);

        // Phase 3 refines Phase 2 SPARC via LLM. If it fails (timeout, no LLM),
        // carry Phase 2 artifacts forward so Phases 4-6 can still proceed.
        const phase2SparcDir = path.join(runDir, 'phase2', 'sparc');
        const phase2SparcCombined = path.join(phase2SparcDir, 'sparc-combined.json');
        if (fs.existsSync(phase2SparcCombined)) {
          console.error('  [RECOVER] Phase 2 SPARC artifacts exist — copying to phase3/ so pipeline can continue');
          const phase3SparcDir = path.join(phaseDir, 'sparc');
          fs.mkdirSync(phase3SparcDir, { recursive: true });
          // Copy all Phase 2 SPARC files to Phase 3 directory
          const phase2SparcFiles = fs.readdirSync(phase2SparcDir);
          for (const file of phase2SparcFiles) {
            const src = path.join(phase2SparcDir, file);
            const dest = path.join(phase3SparcDir, file);
            if (fs.statSync(src).isFile()) {
              fs.copyFileSync(src, dest);
            }
          }
          // Also copy TDD if available from Phase 2
          const phase2TddDir = path.join(runDir, 'phase2', 'tdd');
          if (fs.existsSync(phase2TddDir)) {
            const phase3TddDir = path.join(phaseDir, 'tdd');
            fs.mkdirSync(phase3TddDir, { recursive: true });
            const phase2TddFiles = fs.readdirSync(phase2TddDir);
            for (const file of phase2TddFiles) {
              const src = path.join(phase2TddDir, file);
              const dest = path.join(phase3TddDir, file);
              if (fs.statSync(src).isFile()) {
                fs.copyFileSync(src, dest);
              }
            }
          }
          console.error('  [RECOVER] Phase 2 artifacts carried forward — continuing to Phase 4');
          phases.push({ phase: 3, label: 'SPARC + London TDD', status: 'completed', timing: Date.now() - phaseStart, artifacts: [], outputDir: phaseDir, error: `Recovered from Phase 2: ${errMsg}` });
          copyPlanningArtifacts(runDir, projectRoot);
        } else {
          console.error('  [ABORT] No Phase 2 SPARC artifacts to recover from — pipeline cannot continue');
          phases.push({ phase: 3, label: 'SPARC + London TDD', status: 'failed', timing: Date.now() - phaseStart, artifacts: [], outputDir: phaseDir, error: errMsg });
          copyPlanningArtifacts(runDir, projectRoot);
          await ensureAdrsExist(runDir, traceId, scenarioQuery);
          // ADR-094 Decision 4: emit skipped-due-to-upstream entries for phases 4..6.
          pushSkippedDueToUpstream(phases, { phase: 3, label: 'SPARC + London TDD', reason: errMsg }, runDir);
        return buildResult(traceId, runDir, phases, pipelineStart, mode);
        }
      }
      } // close ADR-PIPELINE-093 phase3-sparc gate-else
    }
  }

  // ── Phase 4: ADRs + DDDs ──
  {
    const phaseStart = Date.now();
    const phaseDir = path.join(runDir, 'phase4');
    console.error('');
    console.error('-'.repeat(72));
    console.error('  >> Phase 4: Architecture Decision Records + Domain-Driven Design');
    console.error('-'.repeat(72));

    // Only skip if phase4 has actual ADR + DDD content (not just an empty dir from a failed prior run)
    const phase4HasContent = fs.existsSync(phaseDir)
      && fs.existsSync(path.join(phaseDir, 'adrs', 'adr-index.json'))
      && fs.existsSync(path.join(phaseDir, 'ddd', 'domain-model.json'));
    if (phase4HasContent) {
      console.error('  [SKIP] Phase 4 already exists — using existing artifacts');
      phases.push({ phase: 4, label: 'ADRs + DDDs', status: 'skipped', timing: 0, artifacts: [], outputDir: phaseDir });
    } else {
      // Clean up incomplete phase4 directory from a prior failed run
      if (fs.existsSync(phaseDir) && !phase4HasContent) {
        console.error('  [CLEANUP] Removing incomplete phase4 directory from prior run');
        fs.rmSync(phaseDir, { recursive: true, force: true });
      }

      // ADR-PIPELINE-093 — Phase 4 gate runs BEFORE the ADR-091 Ruflo-primary
      // call so the gate verifies (and regenerates) the SPARC spec upstream
      // requirement before the phase's own Ruflo pass runs.
      const phase4Gate = await runPhaseGate('phase4-adrs-ddd', scenarioQuery, traceId, runDir, gateAcc);
      if (!phase4Gate.ok && phase4Gate.stillMissing.length > 0) {
        phaseBlocked['phase4-adrs-ddd'] = true;
        console.error('  [SKIP] Phase 4 blocked by gate — upstream inputs unrecoverable');
        phases.push({ phase: 4, label: 'ADRs + DDDs', status: 'skipped', timing: Date.now() - phaseStart, artifacts: [], outputDir: phaseDir, error: `blocked: ${phase4Gate.stillMissing.join(', ')}` });
        // Continue to Phase 5a — its own gate decides reachability.
      } else {

      // ADR-PIPELINE-091: Ruflo runs FIRST for ADR + DDD generation. Its output
      // lands in runDir/engineering/architecture-decisions.md + domain-model.md
      // and the phase4 coordinator refines it. Remote diligence agents feed in
      // as optional enrichment only.
      rufloPrimaryResults.phase4 = await runRufloPrimaryForPhase(
        'phase4-adrs-ddd',
        scenarioQuery,
        traceId,
        runDir,
        collectPhase4Artifacts(runDir),
        readRemoteEnrichmentSnapshot(runDir),
        path.join(runDir, '.ruflo-cache', 'phase4-primary'),
      );

      const agentResults = await dispatchPhaseAgents(PHASE_AGENTS[4]!, traceId, runDir, scenarioQuery);

      // Ruflo swarm + agentics agents: write ADRs + DDDs cooperatively
      const rufloP4Dir = path.join(runDir, '.ruflo-cache', 'phase4');
      const rufloResult = executeRufloPhaseSwarm({
        phase: 4, label: 'ADRs + DDDs', scenarioQuery,
        runDir, traceId, outputDir: rufloP4Dir,
        tasks: buildPhase4Tasks(scenarioQuery, collectPhase4Artifacts(runDir)),
        agenticsResults: agentResults,
        priorArtifacts: collectPhase4Artifacts(runDir),
      });
      if (rufloResult.filesModified > 0) {
        console.error(`  [RUFLO-P4] ${rufloResult.filesModified} files generated (swarm+agents) in ${rufloResult.timing}ms`);
      }

      // Persist agent results to .pre-phase4 so ADR/DDD generators can find them.
      // CANNOT write to phase4Dir — append-only guard throws if it exists.
      persistAgenticsResults(path.join(runDir, '.pre-phase4'), agentResults);

      try {
        const result = await executePhase4Command({ trace: traceId });
        mergeRufloCacheIntoPhase(runDir, 4);
        const timing = Date.now() - phaseStart;
        const artifactPaths = extractArtifactPaths(result.manifest.artifacts);
        console.error(formatPhase4ForDisplay(result));
        printArtifactLinks(phaseDir, artifactPaths);
        storePhaseArtifacts(PHASE_AGENTS[4]!, traceId, runDir, artifactPaths, timing);
        await reviewPhaseOutput(PHASE_AGENTS[4]!, traceId, runDir);
        persistAgenticsResults(phaseDir, agentResults);
        phases.push({ phase: 4, label: 'ADRs + DDDs', status: 'completed', timing, artifacts: artifactPaths, outputDir: phaseDir, agenticsAgents: buildAgentSummary(agentResults, PHASE_AGENTS[4]!.agenticsServices.length) });
        // ADR-PIPELINE-101 §harness — structural check on every emitted ADR.
        {
          const adrDirCandidates = [
            path.join(phaseDir, 'adrs'),
            path.join(runDir, 'phase4', 'adrs'),
            path.join(runDir, 'phase2', 'adrs'),
            path.join(runDir, 'plans', 'adrs'),
          ];
          const adrDir = adrDirCandidates.find((d) => fs.existsSync(d));
          if (adrDir) {
            logStructuralFailures(validateAdrDir(adrDir), 'Phase 4 (ADRs)');
          } else {
            process.stderr.write(`  [STRUCTURE FAIL] Phase 4 (ADRs): no adrs/ directory found at any of ${adrDirCandidates.join(' | ')}\n`);
          }
        }
        copyPlanningArtifacts(runDir, projectRoot);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.error(`  [FAIL] Phase 4 failed: ${errMsg}`);
        recordPhaseFailure(PHASE_AGENTS[4]!, traceId, errMsg);

        // Phase 4 refines Phase 2 ADRs/DDD. If it fails, try recovery paths.
        const phase2AdrIndex = path.join(runDir, 'phase2', 'adrs', 'adr-index.json');
        let recovered = false;

        if (fs.existsSync(phase2AdrIndex)) {
          // Path A: Phase 2 has ADRs — copy them to phase4/
          console.error('  [RECOVER] Phase 2 ADRs/DDD exist — copying to phase4/ so pipeline can continue');
          for (const sub of ['adrs', 'ddd']) {
            const src = path.join(runDir, 'phase2', sub);
            const dest = path.join(phaseDir, sub);
            if (fs.existsSync(src)) {
              fs.mkdirSync(dest, { recursive: true });
              for (const file of fs.readdirSync(src)) {
                const srcFile = path.join(src, file);
                if (fs.statSync(srcFile).isFile()) {
                  fs.copyFileSync(srcFile, path.join(dest, file));
                }
              }
            }
          }
          console.error('  [RECOVER] Phase 2 ADRs/DDD carried forward — continuing to Phase 5');
          recovered = true;
        }

        // Path B: No Phase 2 ADRs — generate them from SPARC + dossier directly
        if (!recovered) {
          console.error('  [RECOVER] No Phase 2 ADRs — generating ADRs from SPARC + dossier (no LLM required)');
          try {
            const { buildLoudFailureADR } = await import('../pipeline/phase2/phases/adr-generator.js');
            const { buildPhase2DDD } = await import('../pipeline/phase2/phases/ddd-generator.js');

            // Load SPARC and dossier from wherever they exist
            let sparc = null as Record<string, unknown> | null;
            let dossier = null as Record<string, unknown> | null;
            for (const sub of ['phase3/sparc/sparc-combined.json', 'phase2/sparc/sparc-combined.json']) {
              const p = path.join(runDir, sub);
              if (fs.existsSync(p)) { try { sparc = JSON.parse(fs.readFileSync(p, 'utf-8')); break; } catch { /* skip */ } }
            }
            for (const sub of ['phase2/research-dossier.json']) {
              const p = path.join(runDir, sub);
              if (fs.existsSync(p)) { try { dossier = JSON.parse(fs.readFileSync(p, 'utf-8')); break; } catch { /* skip */ } }
            }

            if (sparc && dossier) {
              // ADR-PIPELINE-100 §D5: recovery path emits a loud-failure ADR
              // directly rather than re-running the LLM. The Phase 4 path
              // has already completed/skipped; we just need a present-but-honest
              // marker in `phase4/adrs/` so downstream consumers can see that
              // ADR generation didn't yield real content.
              const adrs = [buildLoudFailureADR({
                reason: 'Recovery path: no Phase 2 ADRs found; Phase 4 also did not produce content. This failure ADR is written so downstream phases can see the regression without rerunning the LLM.',
                claudeFailureReason: 'recovery path skipped LLM call — see Phase 4 logs for the original failure',
                dossierItemCount: (dossier as { items?: unknown[] }).items?.length ?? 0,
                sparcStatus: 'present',
                query: scenarioQuery,
              })];
              if (adrs.length > 0) {
                const adrDir = path.join(phaseDir, 'adrs');
                try {
                  fs.mkdirSync(adrDir, { recursive: true });
                } catch (mkdirErr) {
                  console.error(`  [ADR WRITE FAILED] mkdir ${adrDir}: ${mkdirErr instanceof Error ? mkdirErr.message : String(mkdirErr)}`);
                  throw mkdirErr;
                }
                for (const adr of adrs) {
                  const slug = (adr.title || 'untitled').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 60);
                  const filename = `${adr.id}-${slug}.md`;
                  const md = [
                    `# ${adr.id}: ${adr.title}`,
                    `\n**Status:** ${adr.status}`,
                    `**Date:** ${adr.date}`,
                    `\n## Context\n${adr.context}`,
                    `\n## Decision\n${adr.decision}`,
                    adr.alternatives?.length > 0 ? `\n## Alternatives Considered\n${adr.alternatives.map((a: any) => `- **${a.option}** ${a.rejected ? '(rejected)' : '(selected)'}: ${a.rationale}`).join('\n')}` : '',
                    adr.consequences?.length > 0 ? `\n## Consequences\n${adr.consequences.map((c: any) => `- [${c.type === 'positive' ? '+' : c.type === 'negative' ? '-' : '~'}] ${c.description}`).join('\n')}` : '',
                  ].filter(Boolean).join('\n');
                  const adrPath = path.join(adrDir, filename);
                  try {
                    fs.writeFileSync(adrPath, md + '\n', 'utf-8');
                  } catch (writeErr) {
                    console.error(`  [ADR WRITE FAILED] ${adrPath}: ${writeErr instanceof Error ? writeErr.message : String(writeErr)}`);
                    throw writeErr;
                  }
                }
                const indexPath = path.join(adrDir, 'adr-index.json');
                try {
                  fs.writeFileSync(indexPath, JSON.stringify(adrs, null, 2) + '\n', 'utf-8');
                } catch (writeErr) {
                  console.error(`  [ADR WRITE FAILED] index ${indexPath}: ${writeErr instanceof Error ? writeErr.message : String(writeErr)}`);
                  throw writeErr;
                }
                console.error(`  [RECOVER] Generated ${adrs.length} ADRs from SPARC template`);
              }

              // Generate DDD
              try {
                const dddModel = buildPhase2DDD(sparc as any, adrs as any, dossier as any);
                if (dddModel?.contexts?.length > 0) {
                  const dddDir = path.join(phaseDir, 'ddd');
                  const contextsDir = path.join(dddDir, 'contexts');
                  fs.mkdirSync(contextsDir, { recursive: true });
                  fs.writeFileSync(path.join(dddDir, 'domain-model.json'), JSON.stringify(dddModel, null, 2) + '\n', 'utf-8');
                  if (dddModel.contextMap) {
                    fs.writeFileSync(path.join(dddDir, 'context-map.json'), JSON.stringify(dddModel.contextMap, null, 2) + '\n', 'utf-8');
                  }
                  for (const ctx of dddModel.contexts) {
                    const ctxSlug = ctx.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 60);
                    fs.writeFileSync(path.join(contextsDir, `${ctxSlug}.json`), JSON.stringify(ctx, null, 2) + '\n', 'utf-8');
                  }
                  console.error(`  [RECOVER] Generated DDD model with ${dddModel.contexts.length} bounded contexts`);
                }
              } catch (dddErr) {
                console.error(`  [WARN] DDD generation failed: ${dddErr instanceof Error ? dddErr.message : String(dddErr)}`);
              }

              recovered = true;
            } else {
              console.error('  [WARN] SPARC or dossier not found — cannot generate ADRs');
            }
          } catch (recoverErr) {
            console.error(`  [WARN] ADR recovery failed: ${recoverErr instanceof Error ? recoverErr.message : String(recoverErr)}`);
          }
        }

        if (recovered) {
          phases.push({ phase: 4, label: 'ADRs + DDDs', status: 'completed', timing: Date.now() - phaseStart, artifacts: [], outputDir: phaseDir, error: `Recovered: ${errMsg}` });
        } else {
          console.error('  [WARN] No recovery possible — continuing without ADRs');
          phases.push({ phase: 4, label: 'ADRs + DDDs', status: 'failed', timing: Date.now() - phaseStart, artifacts: [], outputDir: phaseDir, error: errMsg });
        }
        copyPlanningArtifacts(runDir, projectRoot);
      }
      } // close ADR-PIPELINE-093 phase4-adrs-ddd gate-else
    }
  }

  // ── Phase 4.5: Generate implementation prompts by reading ADR + DDD files ──
  // Simple approach: gather all ADR/DDD/SPARC files, hand them to ruflo swarm,
  // let the LLM read them and produce coherent implementation prompts.
  {
    const promptsDir = path.join(runDir, 'prompts');
    // Check if prompts already exist from a prior run
    const promptsExist = fs.existsSync(promptsDir)
      && fs.readdirSync(promptsDir).some(f => f.startsWith('impl-'));
    if (promptsExist) {
      console.error('  [PROMPTS] Implementation prompts already exist — skipping');
    } else {
      // ADR-PIPELINE-093 — Phase 5a gate. Verifies SPARC + (ADRs OR DDD OR
      // engineering/architecture-decisions.md) are present. Missing upstream
      // triggers the gate's single-shot Ruflo invocation of the owning phase.
      const phase5aGate = await runPhaseGate('phase5a-prompts', scenarioQuery, traceId, runDir, gateAcc);
      if (!phase5aGate.ok && phase5aGate.stillMissing.length > 0) {
        phaseBlocked['phase5a-prompts'] = true;
        console.error('  [SKIP] Phase 5a (prompts) blocked by gate — upstream unrecoverable');
        // Fall through: the FATAL-path check later will decide whether
        // to exit loudly or continue degraded.
      } else {
      // ADR-PIPELINE-091: Ruflo runs FIRST as the primary implementation-prompt
      // producer. Its output lands in runDir/engineering/implementation-roadmap.md
      // (and impl-NNN-*.md). The template-derivation path below only fires as
      // the last-resort when Ruflo was unavailable or produced no output.
      rufloPrimaryResults.phase5a = await runRufloPrimaryForPhase(
        'phase5a-prompts',
        scenarioQuery,
        traceId,
        runDir,
        collectPhase4Artifacts(runDir),
        readRemoteEnrichmentSnapshot(runDir),
        path.join(runDir, '.ruflo-cache', 'phase5a-primary'),
      );

      // Gather all ADR and DDD files (prefer phase4, fall back to phase2)
      const adrDir = fs.existsSync(path.join(runDir, 'phase4', 'adrs'))
        ? path.join(runDir, 'phase4', 'adrs')
        : fs.existsSync(path.join(runDir, 'phase2', 'adrs'))
          ? path.join(runDir, 'phase2', 'adrs')
          : null;
      const dddDir = fs.existsSync(path.join(runDir, 'phase4', 'ddd'))
        ? path.join(runDir, 'phase4', 'ddd')
        : fs.existsSync(path.join(runDir, 'phase2', 'ddd'))
          ? path.join(runDir, 'phase2', 'ddd')
          : null;
      const sparcDir = fs.existsSync(path.join(runDir, 'phase3', 'sparc'))
        ? path.join(runDir, 'phase3', 'sparc')
        : fs.existsSync(path.join(runDir, 'phase2', 'sparc'))
          ? path.join(runDir, 'phase2', 'sparc')
          : null;

      if (adrDir) {
        try {
          // Read all ADR markdown files
          const adrFiles = fs.readdirSync(adrDir).filter(f => f.endsWith('.md'));
          const adrContent = adrFiles.map(f => {
            try { return `### ${f}\n\n${fs.readFileSync(path.join(adrDir, f), 'utf-8')}`; }
            catch { return ''; }
          }).filter(Boolean).join('\n\n---\n\n');

          // Read DDD model files
          let dddContent = '';
          if (dddDir) {
            const dddFiles = fs.readdirSync(dddDir).filter(f => f.endsWith('.md') || f.endsWith('.json'));
            dddContent = dddFiles.map(f => {
              try { return `### ${f}\n\n${fs.readFileSync(path.join(dddDir, f), 'utf-8')}`; }
              catch { return ''; }
            }).filter(Boolean).join('\n\n---\n\n');
          }

          // Read SPARC specification summary
          let sparcContent = '';
          if (sparcDir) {
            for (const candidate of ['specification.md', 'architecture.md', 'sparc-combined.json']) {
              const p = path.join(sparcDir, candidate);
              if (fs.existsSync(p)) {
                try { sparcContent += `### ${candidate}\n\n${fs.readFileSync(p, 'utf-8').slice(0, 5000)}\n\n`; }
                catch { /* skip */ }
              }
            }
          }

          // Build the ruflo swarm task: read the files, write implementation prompts
          fs.mkdirSync(promptsDir, { recursive: true, mode: 0o700 });

          const rufloPromptDir = path.join(runDir, '.ruflo-cache', 'prompts');
          const promptTask = `You are an implementation prompt writer. You have been given the complete Architecture Decision Records (ADRs), Domain-Driven Design (DDD) model, and SPARC specification for this project.

Your job: Read ALL of these documents carefully, then write a series of ordered implementation prompts. Each prompt should be a self-contained build step that a developer (or coding agent) can execute to build one piece of the platform.

## Project Objective

${scenarioQuery}

## Architecture Decision Records (ADRs)

${adrContent || 'No ADR files found.'}

## Domain-Driven Design Model

${dddContent || 'No DDD model files found.'}

## SPARC Specification

${sparcContent || 'No SPARC specification found.'}

## Instructions

1. Analyze the ADRs and DDDs to understand the platform's bounded contexts, dependencies, and architectural decisions.
2. Determine the correct build order based on dependencies between bounded contexts (foundation layers first, dependent layers later).
3. For each build step, write a complete implementation prompt file named impl-NNN-<context-slug>.md where NNN is the order (001, 002, etc.).
4. Each implementation prompt MUST:
   - Reference the specific ADRs that govern that build step (by ID and title)
   - Include the relevant DDD bounded context details (aggregates, entities, commands, queries, events)
   - Specify what to import from previously built steps
   - Include concrete implementation requirements (not vague instructions)
   - Specify the technology stack decisions from the ADRs
5. Write an execution-plan.json that lists all prompts in order with their dependencies.
6. Write ALL files to the current working directory.

The prompts must be production-grade — they will be given directly to a coding swarm to implement.`;

          const promptSwarmResult = executeRufloPhaseSwarm({
            phase: 4,
            label: 'Implementation Prompts',
            scenarioQuery,
            runDir,
            traceId,
            outputDir: rufloPromptDir,
            tasks: [{
              label: 'Implementation Prompt Generation',
              description: promptTask,
              targetDir: '.',
            }],
            agenticsResults: [],
            priorArtifacts: collectPhase4Artifacts(runDir),
            timeoutMs: 600_000, // 10 min
          });

          // Copy ruflo output to prompts dir
          if (fs.existsSync(rufloPromptDir)) {
            const rufloFiles = fs.readdirSync(rufloPromptDir);
            let promptsCopied = 0;
            for (const f of rufloFiles) {
              const src = path.join(rufloPromptDir, f);
              if (fs.statSync(src).isFile()) {
                fs.copyFileSync(src, path.join(promptsDir, f));
                promptsCopied++;
              }
            }
            if (promptsCopied > 0) {
              console.error(`  [PROMPTS] Ruflo swarm generated ${promptsCopied} implementation prompt files in ${promptSwarmResult.timing}ms`);
            }
          }

          // Check if ruflo produced prompts; if not, write them directly from the gathered content
          const generatedPrompts = fs.existsSync(promptsDir)
            ? fs.readdirSync(promptsDir).filter(f => f.startsWith('impl-'))
            : [];

          if (generatedPrompts.length === 0) {
            // ── Read all source material for prompt generation ──
            const adrMarkdownByFile = new Map<string, string>();
            for (const f of adrFiles) {
              try { adrMarkdownByFile.set(f, fs.readFileSync(path.join(adrDir, f), 'utf-8')); }
              catch { /* skip */ }
            }

            const adrIndexPath = path.join(adrDir, 'adr-index.json');
            let adrs: Array<{ id: string; title: string; context: string; decision: string; consequences: string[]; alternatives: string[] }> = [];
            if (fs.existsSync(adrIndexPath)) {
              try { adrs = JSON.parse(fs.readFileSync(adrIndexPath, 'utf-8')); } catch { /* empty */ }
            }
            if (!Array.isArray(adrs) || adrs.length === 0) {
              for (const f of adrFiles) {
                const content = adrMarkdownByFile.get(f) ?? '';
                const titleMatch = content.match(/^#\s+(.+)/m);
                adrs.push({ id: f.replace(/\.md$/, ''), title: titleMatch?.[1] ?? f, context: content.slice(0, 500), decision: '', consequences: [], alternatives: [] });
              }
            }

            function getAdrMarkdown(adr: { id: string }): string {
              for (const [filename, content] of adrMarkdownByFile) {
                if (filename.startsWith(adr.id)) return content;
              }
              return '';
            }

            // Read DDD as reference material (not as driver)
            let dddContent = '';
            const dddModelPath = dddDir ? path.join(dddDir, 'domain-model.json') : '';
            if (dddModelPath && fs.existsSync(dddModelPath)) {
              try { dddContent = fs.readFileSync(dddModelPath, 'utf-8'); } catch { /* skip */ }
            }
            // Also read DDD markdown if available
            if (dddDir) {
              for (const f of ['domain-model.md', 'ddd-model.md']) {
                const p = path.join(dddDir, f);
                if (fs.existsSync(p)) {
                  try { dddContent += '\n\n' + fs.readFileSync(p, 'utf-8'); break; } catch { /* skip */ }
                }
              }
            }

            // Read SPARC documents
            let sparcSpec = '';
            let sparcArch = '';
            if (sparcDir) {
              for (const [file, setter] of [
                ['specification.md', 'spec'], ['architecture.md', 'arch'],
              ] as const) {
                const p = path.join(sparcDir, file);
                if (fs.existsSync(p)) {
                  try {
                    const content = fs.readFileSync(p, 'utf-8');
                    if (setter === 'spec') sparcSpec = content;
                    else if (setter === 'arch') sparcArch = content;
                  } catch { /* skip */ }
                }
              }
            }

            console.error('  [PROMPTS] Ruflo swarm did not produce prompts — deriving from SPARC + ADRs');

            // ── Extract build phases from SPARC architecture ──
            // The SPARC architecture section lists actual services/components for THIS project.
            // Each service becomes a build phase. ADRs are matched per phase.

            interface DerivedPhase {
              title: string;
              slug: string;
              content: string; // the full SPARC section for this component
              folder: string;
              adrIds: string[];
            }

            const derivedPhases: DerivedPhase[] = [];

            // Parse SPARC architecture for service/component sections
            if (sparcArch) {
              // Look for ## or ### headings that describe components/services
              const sections = sparcArch.split(/^(?=#{2,3}\s)/m).filter(s => s.trim().length > 20);
              for (const section of sections) {
                const headingMatch = section.match(/^#{2,3}\s+(.+)/);
                if (!headingMatch) continue;
                const heading = headingMatch[1]!.trim();
                // Skip meta-sections
                if (/^(overview|introduction|summary|table of contents|references|constraints|non-functional)/i.test(heading)) continue;

                const slug = heading.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50);
                // Determine target folder based on content
                const sectionLower = section.toLowerCase();
                let folder = 'backend';
                if (/\bfrontend\b|\bui\b|\bdashboard\b|\breact\b|\bvue\b|\bangular\b/.test(sectionLower)) folder = 'frontend';
                else if (/erp|netsuite|sap|dynamics|oracle/.test(sectionLower)) folder = 'erp';
                else if (/integration|connector|webhook|external|third.party/.test(sectionLower)) folder = 'integrations';
                else if (/api|service|backend|server|handler/.test(sectionLower)) folder = 'backend';
                else if (/test|quality|coverage/.test(sectionLower)) folder = 'tests';
                else if (/deploy|infra|docker|cloud|ci.cd/.test(sectionLower)) folder = 'src';
                else if (/doc|guide|reference/.test(sectionLower)) folder = 'docs';

                // Match ADRs to this section by keyword overlap
                const sectionWords = new Set(sectionLower.split(/\W+/).filter(w => w.length > 3));
                const matchedAdrIds = adrs.filter(adr => {
                  const adrWords = `${adr.title} ${adr.context} ${adr.decision}`.toLowerCase().split(/\W+/).filter(w => w.length > 3);
                  const overlap = adrWords.filter(w => sectionWords.has(w)).length;
                  return overlap >= 2;
                }).map(a => a.id);

                derivedPhases.push({ title: heading, slug, content: section, folder, adrIds: matchedAdrIds });
              }
            }

            // ADR-PIPELINE-031: Enrich with ADR-derived phases when SPARC sections alone are insufficient.
            // Each ADR that isn't already covered by a SPARC-derived phase becomes its own build step.
            if (derivedPhases.length < 8 && adrs.length > 0) {
              const existingSlugs = new Set(derivedPhases.map(p => p.slug));
              const existingTitleWords = new Set(derivedPhases.flatMap(p => p.title.toLowerCase().split(/\W+/).filter(w => w.length > 3)));

              for (const adr of adrs) {
                const slug = adr.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50);
                // Skip if a phase with similar slug or overlapping title already exists
                if (existingSlugs.has(slug)) continue;
                const adrKeywords = adr.title.toLowerCase().split(/\W+/).filter(w => w.length > 3);
                const overlap = adrKeywords.filter(w => existingTitleWords.has(w)).length;
                if (overlap >= 2) continue; // sufficiently covered by an existing phase

                const adrLower = `${adr.title} ${adr.context} ${adr.decision}`.toLowerCase();
                let folder = 'backend';
                if (/frontend|ui|dashboard/.test(adrLower)) folder = 'frontend';
                else if (/erp|netsuite|sap|dynamics|coupa|workday|maximo|oracle/.test(adrLower)) folder = 'erp';
                else if (/integration|connector|webhook/.test(adrLower)) folder = 'integrations';
                else if (/deploy|infra|docker/.test(adrLower)) folder = 'src';
                else if (/test|quality/.test(adrLower)) folder = 'tests';
                else if (/audit|governance|approval/.test(adrLower)) folder = 'backend';

                derivedPhases.push({
                  title: adr.title,
                  slug,
                  content: getAdrMarkdown(adr) || `**Context:** ${adr.context}\n\n**Decision:** ${adr.decision}`,
                  folder,
                  adrIds: [adr.id],
                });
                existingSlugs.add(slug);
                for (const w of adrKeywords) existingTitleWords.add(w);
              }
            }

            // Always add foundation (first) and testing/deployment (last) if not present
            const hasTesting = derivedPhases.some(p => /test/i.test(p.title));
            const hasDeployment = derivedPhases.some(p => /deploy|infra/i.test(p.title));

            // Detect multi-language requirements (e.g., TypeScript + Rust)
            const queryLower = scenarioQuery.toLowerCase();
            const hasRust = /\brust\b/.test(queryLower);
            const hasTypeScript = /\btypescript\b/.test(queryLower);
            const rustPurpose = scenarioQuery.match(/rust\s+(?:used\s+)?(?:for\s+)?(.{10,100}?)(?:\.|,|$)/i)?.[1]?.trim() ?? '';
            const languageNote = hasRust && hasTypeScript
              ? `\n\nThis is a HYBRID TypeScript + Rust project. TypeScript handles orchestration and service layers. Rust handles ${rustPurpose || 'compute-intensive components'}. Set up both package.json and Cargo.toml. Create a rust/ directory for Rust crates with WASM or FFI bindings to TypeScript.`
              : hasRust
                ? `\n\nThis project uses Rust. Set up Cargo.toml workspace.`
                : '';

            // Insert foundation at the beginning — ADR-039: logger + config are FIRST outputs
            // Detect language from query to make scaffold language-appropriate
            const detectedLang = hasRust ? 'Rust' : hasTypeScript ? 'TypeScript' : /\bpython\b/i.test(queryLower) ? 'Python' : /\bgo\b|\bgolang\b/i.test(queryLower) ? 'Go' : /\bjava\b/i.test(queryLower) ? 'Java' : 'TypeScript';
            derivedPhases.unshift({
              title: 'Project Foundation & Core Types',
              slug: 'foundation',
              content: `Set up project structure, build tooling, and shared infrastructure using **${detectedLang}**. All subsequent phases import from this.${languageNote}

## FIRST: Create these shared modules (before domain types)

### src/logger.ts
\`\`\`typescript
export interface Logger {
  info(event: string, data?: Record<string, unknown>): void;
  warn(event: string, data?: Record<string, unknown>): void;
  error(event: string, error: Error, data?: Record<string, unknown>): void;
}
export function createLogger(service: string): Logger {
  return {
    info: (event, data) => console.error(JSON.stringify({ timestamp: new Date().toISOString(), level: 'info', service, event, ...data })),
    warn: (event, data) => console.error(JSON.stringify({ timestamp: new Date().toISOString(), level: 'warn', service, event, ...data })),
    error: (event, err, data) => console.error(JSON.stringify({ timestamp: new Date().toISOString(), level: 'error', service, event, error: err.message, stack: err.stack, ...data })),
  };
}
\`\`\`

### src/config.ts
\`\`\`typescript
export interface AppConfig {
  env: 'development' | 'staging' | 'production';
  port: number;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  erp: { baseUrl: string; apiVersion: string; timeoutMs: number; maxRetries: number };
}
export const config: AppConfig = {
  env: (process.env.NODE_ENV ?? 'development') as AppConfig['env'],
  port: parseInt(process.env.PORT ?? '3000', 10),
  logLevel: (process.env.LOG_LEVEL ?? 'info') as AppConfig['logLevel'],
  erp: {
    baseUrl: process.env.ERP_BASE_URL ?? 'https://api.example.com',
    apiVersion: process.env.ERP_API_VERSION ?? 'v1',
    timeoutMs: parseInt(process.env.ERP_TIMEOUT_MS ?? '30000', 10),
    maxRetries: parseInt(process.env.ERP_MAX_RETRIES ?? '3', 10),
  },
};
\`\`\`

### src/errors.ts
\`\`\`typescript
export class AppError extends Error {
  constructor(message: string, public readonly code: string, public readonly statusCode = 500) {
    super(message);
    this.name = 'AppError';
  }
}
export class ValidationError extends AppError {
  constructor(message: string) { super(message, 'VALIDATION_ERROR', 400); }
}
export class NotFoundError extends AppError {
  constructor(entity: string, id: string) { super(\`\${entity} \${id} not found\`, 'NOT_FOUND', 404); }
}
\`\`\`

## THEN: Create the composition root (ADR-047)

Create \`src/container.ts\` that wires all services via constructor injection:
- Every service receives dependencies (config, logger, eventBus, repository) via constructor
- No module-level singletons except config
- The composition root is the ONLY place services are instantiated
- Route handlers receive pre-wired services and do ONLY: validate → call service → respond

## THEN: Create domain types and project structure

Base folder structure: src/, tests/, docs/. Create package.json, tsconfig.json, vitest.config.ts.
Define all shared domain types in src/types.ts.`,
              folder: 'src',
              adrIds: adrs.map(a => a.id),
            });

            if (!hasTesting) {
              derivedPhases.push({
                title: 'Testing & Quality Assurance',
                slug: 'testing',
                content: 'Write comprehensive tests for all components built in prior phases.',
                folder: 'tests',
                adrIds: [],
              });
            }
            if (!hasDeployment) {
              derivedPhases.push({
                title: 'Deployment & Infrastructure',
                slug: 'deployment',
                content: 'Create deployment configs, Dockerfiles, CI/CD, and infrastructure-as-code for the target cloud platform.',
                folder: 'src',
                adrIds: [],
              });
            }

            // ADR-PIPELINE-031: Guarantee ≥10 prompts by adding standard cross-cutting phases
            // when domain-specific + ADR-derived phases don't reach the minimum.
            const crossCutting: Array<{ title: string; slug: string; content: string; folder: string }> = [
              { title: 'Observability & Structured Logging', slug: 'observability', folder: 'backend',
                content: `ADR-PIPELINE-034: Implement complete observability infrastructure.

## 1. Structured Logger (src/logger.ts)

Create a logger factory that outputs JSON to stderr:

\`\`\`typescript
export interface Logger {
  info(event: string, data?: Record<string, unknown>): void;
  warn(event: string, data?: Record<string, unknown>): void;
  error(event: string, error: Error, data?: Record<string, unknown>): void;
}

export function createLogger(service: string): Logger {
  // Each log entry: { timestamp, level, service, event, correlationId?, ...data }
  // Output to stderr as single-line JSON
}

// Correlation ID context — thread through entire request lifecycle
export function withCorrelationId<T>(correlationId: string, fn: () => T): T;
export function getCorrelationId(): string | undefined;
\`\`\`

## 2. Correlation ID Threading

Every analysis run generates a correlationId (UUID). This ID flows through:
- analysis.started → analysis.excess_detected → analysis.completed
- decision.created → erp.sync.attempted → erp.sync.succeeded/failed

Pass correlationId as a parameter through service functions or use AsyncLocalStorage.

## 3. Instrumentation Points (minimum)

| Event | When | Data |
|-------|------|------|
| analysis.started | Analysis begins | { correlationId, supplierCount, recordCount } |
| analysis.completed | Analysis finishes | { correlationId, durationMs, flagCount, opportunityCount } |
| decision.created | Decision recorded | { correlationId, decisionId, opportunityId, status } |
| erp.sync.attempted | ERP write starts | { correlationId, transactionId, supplierId, action } |
| erp.sync.succeeded | ERP write succeeds | { correlationId, transactionId, responseTime } |
| erp.sync.failed | ERP write fails | { correlationId, transactionId, error, retryCount } |

## 4. ERP Error Handling

The ERP connector must handle:
- Network timeout: configurable (default 30s), log erp.sync.failed with timeout error
- Rate limiting (429): exponential backoff (1s, 2s, 4s, max 3 retries), log each retry
- Schema validation: log and quarantine invalid records, don't crash the pipeline
- Idempotency: generate idempotency key per transaction to prevent duplicate writes on retry

## 5. Health Check

If the project includes an API layer, add GET /health returning:
\`\`\`json
{ "status": "ok", "service": "packaging-waste-optimizer", "version": "0.1.0", "uptime": 12345, "lastAnalysisRun": "2026-04-09T..." }
\`\`\`

## 6. Tests

- Test that logger outputs valid JSON to stderr
- Test that correlationId flows through analysis → decision → ERP sync
- Test that ERP error handling retries on 429 and logs failures` },
              { title: 'Configuration & Environment Management', slug: 'configuration', folder: 'src',
                content: `ADR-PIPELINE-034: Configuration module for environment-based settings.

Create src/config.ts with a typed configuration object:

\`\`\`typescript
export interface AppConfig {
  env: 'development' | 'staging' | 'production';
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  erp: {
    baseUrl: string;
    apiVersion: string;
    clientId: string;
    timeoutMs: number;     // default 30000
    maxRetries: number;    // default 3
  };
  analysis: {
    // Domain-specific thresholds — externalized, not hardcoded
    [key: string]: number | string | boolean;
  };
}
\`\`\`

Requirements:
- Read all values from environment variables (never hardcode secrets)
- Validate at startup — fail fast with clear error messages for missing required vars
- Provide sensible defaults for optional values (timeoutMs, maxRetries, logLevel)
- Export a singleton config object used by all services
- Include tests that verify validation catches missing required vars` },
              { title: 'API Layer & Request Handling', slug: 'api-layer', folder: 'backend',
                content: `ADR-PIPELINE-043: Thin route handlers with Zod validation.

ARCHITECTURE: Route handlers MUST be thin:
- Route: parse request → validate with Zod schema → call service function → format response
- NEVER put business logic, database queries, or orchestration in route handlers
- Create a separate src/services/workflow.ts for multi-step orchestration

VALIDATION: Define Zod schemas for EVERY request body and query parameter:
\`\`\`typescript
import { z } from 'zod';
const CreateScenarioSchema = z.object({
  name: z.string().min(1),
  parameters: z.record(z.number()),
});
// In route handler:
const parsed = CreateScenarioSchema.safeParse(req.body);
if (!parsed.success) return res.status(400).json({ error: parsed.error.format() });
\`\`\`

REQUIRED ENDPOINTS:
- GET /health → { status, version, uptime }
- GET /api/metrics → Prometheus-format metrics (request count, latency histogram, error rate)
- All domain endpoints with proper HTTP status codes and structured error responses
- Every response includes X-Correlation-Id header` },
              { title: 'Persistence & Data Access Layer', slug: 'persistence', folder: 'backend',
                content: 'Implement repository interfaces per aggregate (ports pattern). Database adapter implementations. Audit trail persistence (append-only, tamper-evident). Transaction management for multi-aggregate operations.' },
              { title: 'Demo Script & CLI Entry Point', slug: 'demo', folder: 'src',
                content: `ADR-PIPELINE-037: User-facing entry points for the prototype.

## 1. Demo Script (src/demo.ts) — REQUIRED

Create a runnable demo (\`npx tsx src/demo.ts\`) that:
1. Loads all seed data
2. Runs the complete analysis pipeline end-to-end
3. Prints formatted results to stdout using tables (not raw JSON):
   - Summary table: key metrics, top findings
   - Per-entity breakdown (e.g., per-supplier, per-zone, per-employee)
   - Scenario comparison table with tradeoff columns
4. Demonstrates the decision/approval workflow:
   - Create a draft decision for the top opportunity
   - Approve it with a test approver
5. Shows the ERP sync payload:
   - Print the structured payload that would be sent to the ERP
   - Mark as "dry run" — do not actually sync

The demo must run without any external dependencies (no database, no API keys, no network).

## 1b. Business Case Section in Demo Output (ADR-052) — REQUIRED

The demo MUST print a "Business Case" section after the analysis results:
\`\`\`
═══ BUSINESS CASE (derived from prototype analysis) ═══
Total Addressable Value: $X (from seed data analysis)
Projected Annual Savings: $Y
Implementation Cost:      $Z (pilot scope)
ROI:                      N% ($Y ÷ $Z)
Payback Period:           M months
Confidence:               Base $Y | Optimistic $Y×1.3 | Pessimistic $Y×0.6
\`\`\`

These numbers MUST come from the actual scoring/analysis results on seed data,
not from generic heuristics. The evaluator checks that the business case
references specific prototype findings.

## 1c. Unit Economics Manifest (ADR-PIPELINE-066) — REQUIRED

Copy \`src/unit-economics.ts\` from scaffold and call \`writeUnitEconomics(...)\`
at the end of the demo run. This emits \`.agentics/runs/<run-id>/unit-economics.json\`,
the machine-readable contract the executive renderer prefers over per-employee
heuristics.

Required fields (derive every number from the prototype's actual computations,
NOT from employee headcount):

\`\`\`typescript
import { writeUnitEconomics } from './unit-economics.js';

writeUnitEconomics({
  run_id: process.env.AGENTICS_SIMULATION_ID ?? 'local-run',
  sector: 'hospitality',                          // or the detected sector
  domain_unit: { label: 'occupied room night', abbrev: 'orn' },
  measured_scope: { properties: 4, rooms: 1450, region_mix: ['NA','EMEA','APAC'] },
  enterprise_scope: { properties: 100, rooms: 36250, employees: 91000 },
  unit_savings: {
    usd_per_orn: 0.82,          // or usd_per_sqft_year / usd_per_vehicle_mile / ...
    water_liters_per_orn: 14.5,
    co2_kg_per_orn: 0.62,
  },
  annual_measured_savings_usd: measuredSavings,   // from the pilot scenario
  annual_extrapolated_savings_usd: enterpriseSavings,
  extrapolation_method: 'linear_by_rooms_weighted_by_regional_cost',
  confidence: { directional: 0.92, precision: 0.42 },
});
\`\`\`

IMPORTANT:
- **Do NOT multiply employees × $/employee anywhere** to derive the savings figures.
- \`measured_scope\` must reflect the real pilot data the prototype analyzed.
- \`enterprise_scope\` and \`annual_extrapolated_savings_usd\` must use a clearly
  named extrapolation method (linear by rooms, weighted by region, etc.).
- The executive renderer will refuse to emit a financial analysis if the printed
  figures drift more than ±1% from the manifest or the scope ratio deviates by
  more than ±5% (ECLI-SYN-066).

Also print an "Analysis Confidence" section:
\`\`\`
═══ ANALYSIS CONFIDENCE ═══
Confidence Level: [High/Medium/Low]
[If Medium/Low: "The pilot resolves remaining uncertainty with real operational data"]
[If High: "High confidence — proceed to pilot with standard monitoring"]
\`\`\`

## 2. CLI Interface (src/cli.ts) — OPTIONAL

If time permits, create a minimal CLI:
\`\`\`
npx tsx src/cli.ts --analyze          # Run analysis, print results
npx tsx src/cli.ts --scenarios        # Show scenario comparison
npx tsx src/cli.ts --decide <id>      # Create decision for opportunity
npx tsx src/cli.ts --sync <id>        # Dry-run ERP sync for decision
npx tsx src/cli.ts --help             # Usage examples
\`\`\`

## 3. Architecture Divergence ADR — REQUIRED

Create \`docs/ADR-001-monolithic-prototype.md\` in the generated project:

\`\`\`markdown
# ADR-001: Monolithic Library for Prototype Phase

## Status
Accepted

## Context
The SPARC architecture specification describes multiple microservices with event-driven
communication. For the prototype evaluation period (3-7 days), deploying and operating
microservices adds unnecessary complexity without delivering proportional value.

## Decision
Build as a single TypeScript library with clean module boundaries:
- analysis/ — Pure computation, no side effects
- decisions/ — State management with audit trail
- erp/ — External system integration (adapter pattern)
- data/ — Seed data and data access

Each module exports a barrel (index.ts) and communicates via typed interfaces,
not shared mutable state. This structure enables decomposition into independent
services when the pilot validates the approach.

## Consequences
- Prototype can be built, tested, and demonstrated in days, not weeks
- Module boundaries enforce separation of concerns without deployment overhead
- Migration to microservices requires extracting modules into packages — not rewriting
\`\`\`

## Tests
- Test that demo.ts runs without errors (import and execute main function)
- Test that it produces non-empty stdout output` },
            ];
            const existingSlugSet = new Set(derivedPhases.map(p => p.slug));
            for (const cc of crossCutting) {
              if (derivedPhases.length >= 12) break;
              if (existingSlugSet.has(cc.slug)) continue;
              // Don't add if a phase already covers this topic
              if (derivedPhases.some(p => p.title.toLowerCase().includes(cc.slug.split('-')[0]!))) continue;
              derivedPhases.push({ ...cc, adrIds: [] });
              existingSlugSet.add(cc.slug);
            }

            console.error(`  [PROMPTS] ${derivedPhases.length} phases derived (SPARC + ADRs + cross-cutting, minimum 10 per ADR-PIPELINE-031)`);

            // ── Helper: extract DDD context names and summaries relevant to a phase ──
            function getDddSummaryForPhase(phaseTitle: string, phaseContent: string): string {
              if (!dddContent) return '';
              try {
                const model = JSON.parse(dddContent);
                const contexts = model.contexts ?? [];
                if (contexts.length === 0) return '';
                // Exclude common words that would match everything
                const excludeWords = new Set(['domain', 'logic', 'crud', 'operations', 'manage', 'business', 'rules', 'event', 'handling', 'service', 'system', 'data', 'component', 'module', 'implementation', 'integration']);
                const phaseWords = new Set(`${phaseTitle} ${phaseContent}`.toLowerCase().split(/\W+/).filter((w: string) => w.length > 3 && !excludeWords.has(w)));
                const relevant = contexts.filter((c: Record<string, unknown>) => {
                  const ctxText = `${c['name']}`.toLowerCase().split(/[-_\s]+/).filter((w: string) => w.length > 3 && !excludeWords.has(w));
                  // Must match on context NAME keywords, not generic description words
                  const matches = ctxText.filter((w: string) => phaseWords.has(w)).length;
                  return matches >= 1;
                });
                if (relevant.length === 0) return '';
                const parts: string[] = [];
                for (const c of relevant as Array<Record<string, unknown>>) {
                  const name = String(c['name'] ?? '');
                  const desc = String(c['description'] ?? '');
                  const aggs = (c['aggregates'] as Array<Record<string, unknown>> ?? []).map((a: Record<string, unknown>) => String(a['name'] ?? '')).filter(Boolean);
                  const cmds = (c['commands'] as Array<Record<string, unknown> | string> ?? []).map((cmd: Record<string, unknown> | string) => typeof cmd === 'string' ? cmd : String(cmd['name'] ?? '')).filter(Boolean);
                  const queries = (c['queries'] as Array<Record<string, unknown> | string> ?? []).map((q: Record<string, unknown> | string) => typeof q === 'string' ? q : String(q['name'] ?? '')).filter(Boolean);
                  let summary = `**${name}**: ${desc}`;
                  if (aggs.length > 0) summary += ` (aggregates: ${aggs.join(', ')})`;
                  if (cmds.length > 0) summary += ` (commands: ${cmds.join(', ')})`;
                  if (queries.length > 0) summary += ` (queries: ${queries.join(', ')})`;
                  parts.push(summary);
                }
                return parts.join('\n\n');
              } catch {
                return '';
              }
            }

            // ── Helper: build a narrative description paragraph for a phase ──
            function buildPhaseNarrative(
              phase: DerivedPhase,
              phaseAdrs: typeof adrs,
              dddSummary: string,
              completedList: string[],
            ): string {
              const parts: string[] = [];

              // Opening: what this phase builds
              parts.push(`In this phase, you are building the **${phase.title}** component of the platform.`);

              // What prior phases provide
              if (completedList.length > 0) {
                parts.push(`This builds on ${completedList.length} previously completed phase(s) — import shared types, interfaces, and services from those modules.`);
              }

              // ADR narrative: which decisions govern this phase and what they decided
              if (phaseAdrs.length > 0) {
                const adrSentences = phaseAdrs.map(a => {
                  const decision = a.decision?.split('.')[0] ?? a.title;
                  return `${a.id} ("${a.title}") which decided: ${decision}`;
                });
                if (adrSentences.length === 1) {
                  parts.push(`This phase is governed by architecture decision ${adrSentences[0]}.`);
                } else {
                  parts.push(`This phase is governed by ${adrSentences.length} architecture decisions: ${adrSentences.join('; ')}.`);
                }
              }

              // DDD narrative: which domain concepts are relevant
              if (dddSummary) {
                parts.push(`The domain model defines the following relevant contexts and entities for this phase:\n\n${dddSummary}`);
              }

              return parts.join(' ');
            }

            const totalSteps = derivedPhases.length;
            const completedPhases: string[] = [];

            for (let i = 0; i < totalSteps; i++) {
              const phase = derivedPhases[i]!;
              const order = i + 1;
              const filename = `impl-${String(order).padStart(3, '0')}-${phase.slug}.md`;

              // Resolve ADRs for this phase
              const phaseAdrs = phase.adrIds.length > 0
                ? adrs.filter(a => phase.adrIds.includes(a.id))
                : (order === 1 ? adrs : []);

              // Resolve DDD summary for this phase
              const dddSummary = getDddSummaryForPhase(phase.title, phase.content);

              // Build the narrative paragraph
              const narrative = buildPhaseNarrative(phase, phaseAdrs, dddSummary, completedPhases);

              const lines: string[] = [
                `# Implementation Prompt ${order} of ${totalSteps}: ${phase.title}`,
                '',
                `**Target folder:** \`${phase.folder}/\``,
                '',
              ];

              // ADR-PIPELINE-033: Simulation lineage in every prompt
              if (simulationId || traceId) {
                lines.push('## Simulation Lineage', '');
                if (simulationId) lines.push(`Originating simulation: \`${simulationId}\``);
                lines.push(`Trace ID: \`${traceId}\``);
                lines.push('');
              }

              // ── Narrative description — the core of each prompt ──
              lines.push('## Overview', '', narrative, '');

              // Previously completed phases (brief list)
              if (completedPhases.length > 0) {
                lines.push('## Previously Completed (available for import)', '');
                for (const prev of completedPhases) lines.push(`- ${prev}`);
                lines.push('');
              }

              // Full project requirements on first prompt only
              if (order === 1) {
                lines.push('## Project Requirements', '', scenarioQuery, '');
              }

              // SPARC-derived content for this phase (the actual architecture section)
              if (phase.content && phase.content.length > 50) {
                lines.push('## SPARC Architecture for This Phase', '', phase.content, '');
              }

              // SPARC spec + architecture on first two prompts for full context
              if (order === 1 && sparcSpec) {
                lines.push('## Full SPARC Specification', '', sparcSpec, '');
              }
              if (order <= 2 && sparcArch && phase.content !== sparcArch) {
                lines.push('## Full SPARC Architecture', '', sparcArch, '');
              }

              // ADR details — full markdown with file paths for each relevant ADR
              if (phaseAdrs.length > 0) {
                lines.push(`## Architecture Decisions (${phaseAdrs.length} ADRs)`, '');
                lines.push('ADR files are in `.agentics/plans/adrs/` — read them for full context:', '');
                for (const adr of phaseAdrs) {
                  const slug = (adr.title || 'untitled').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 60);
                  const adrFilename = `${adr.id}-${slug}.md`;
                  lines.push(`**File:** \`.agentics/plans/adrs/${adrFilename}\``, '');
                  const fullMarkdown = getAdrMarkdown(adr);
                  if (fullMarkdown) {
                    lines.push(fullMarkdown, '', '---', '');
                  } else {
                    lines.push(`### ${adr.id}: ${adr.title}`, '');
                    if (adr.context) lines.push(`**Context:** ${adr.context}`, '');
                    if (adr.decision) lines.push(`**Decision:** ${adr.decision}`, '');
                    if (adr.consequences?.length) { lines.push('**Consequences:**'); for (const c of adr.consequences) lines.push(`- ${c}`); }
                    lines.push('');
                  }
                }
              }

              // List ALL ADR files for reference even if not directly linked to this phase
              if (adrDir && order === 1) {
                try {
                  const allAdrFiles = fs.readdirSync(adrDir).filter(f => f.endsWith('.md')).sort();
                  if (allAdrFiles.length > 0) {
                    lines.push('## All Architecture Decision Records', '');
                    lines.push('Read these files in `.agentics/plans/adrs/` for complete design rationale:', '');
                    for (const f of allAdrFiles) {
                      lines.push(`- \`.agentics/plans/adrs/${f}\``);
                    }
                    lines.push('');
                  }
                } catch { /* non-fatal */ }
              }

              // DDD reference — structured summary, not raw JSON dump
              if (dddSummary) {
                lines.push('## Domain Model Reference', '', dddSummary, '');
              }

              // Implementation instructions — ADR-PIPELINE-033: include traceability requirements
              lines.push(
                '## Implementation Requirements', '',
                '- All code must be CUSTOM to this project — implement the specific business logic described above',
                '- Follow the technology decisions from the ADRs referenced in the overview',
                '- Write production-quality code with proper error handling',
                '- Include unit tests (London School TDD — mock at module boundaries)',
                '- Export public interfaces so later build phases can import them',
                `- Place all files in the \`${phase.folder}/\` directory`,
                '',
                '## Traceability & Simulation Alignment (ADR-033 + ADR-049)', '',
                '### Domain Type Fields (REQUIRED on Decision, Recommendation, ERPTransaction):',
                '```',
                'interface Recommendation {',
                '  // ... domain fields ...',
                '  simulationId?: string;    // Pipeline simulation that produced the analysis',
                '  traceId?: string;         // Correlation ID for end-to-end tracing',
                '  pipelineVersion?: string;  // Version of the pipeline that generated this',
                '}',
                '```',
                '',
                `${simulationId ? `### Simulation ID: \`${simulationId}\`\nUse this as the default simulationId when creating records.` : '### Simulation ID: load from .agentics/plans/manifest.json at startup.'}`,
                '',
                '### Simulation Config Integration:',
                '- Load .agentics/plans/manifest.json at startup (if it exists)',
                '- Read simulationId and traceId from it',
                '- Pass to all service constructors so every record carries lineage',
                '- Log simulationId in every analysis run: `logger.info("analysis.start", { simulationId })`',
                '',
                '### Confidence Disclosure in Demo Output:',
                '- The demo script MUST print an "Analysis Confidence" section',
                '- State the confidence level and what it means',
                '- If confidence < 60%: "The pilot resolves remaining uncertainty with real data"',
                '- If confidence >= 80%: "High confidence — proceed to pilot with standard monitoring"',
                '',
              );

              // ADR-PIPELINE-039: Mandatory cross-cutting requirements in EVERY prompt
              lines.push(
                '## Mandatory Cross-Cutting Requirements (EVERY module must implement these)', '',
                '### Logging',
                '- Create `src/logger.ts` (if it does not exist) with `createLogger(service: string)` that outputs JSON to stderr',
                '- Every log entry: `{ timestamp, level, service, event, correlationId?, ...data }`',
                '- Import and use the logger in THIS module. Log: function entry with key params, completion with duration, errors with context',
                '',
                '### Configuration',
                '- Create `src/config.ts` (if it does not exist) with typed `AppConfig` read from environment variables',
                '- NEVER hardcode: ports, URLs, thresholds, weights, API keys, timeouts',
                '- Import config in THIS module for any configurable value',
                '',
                '### Input Validation (ADR-046: Zod at EVERY boundary)',
                '- EVERY function receiving external data MUST Zod-parse it:',
                '  API request bodies: `const parsed = Schema.safeParse(req.body); if (!parsed.success) return res.status(400).json({ error: parsed.error.format() });`',
                '  Database rows: `const row = RowSchema.parse(rawDbRow);` — NEVER `as SomeType`',
                '  ERP/API responses: `const data = ResponseSchema.parse(response.data);`',
                '  Config values: validate ALL config with Zod at startup; refuse to start if invalid',
                '- NEVER use `as SomeType` to cast external data — always Zod-parse first',
                '',
                '### Error Handling',
                '- Define error classes extending `AppError` (create in `src/errors.ts` if needed)',
                '- Never `catch (e: any)` — always narrow error types',
                '- Log errors with logger.error() including stack trace and context',
                '- Event bus/emitter: wrap EACH handler in try/catch — one failure must NOT block others',
                '',
                '### Config-Driven (ADR-046: zero hardcoded magic numbers)',
                '- EVERY threshold, weight, factor, timeout MUST come from config (not hardcoded constants)',
                '- Config module validates ALL values with Zod at startup',
                '- If config invalid, service refuses to start with clear error',
                '',
                '### Deterministic Code (ADR-046)',
                '- No Math.random() in production code — use crypto.randomUUID() for IDs',
                '- Seed data generators may use seeded random; service code must be deterministic',
                '',
                '### Architecture (ADR-047: constructor injection, thin handlers)',
                '- Every service class receives dependencies via constructor — no module-level singletons',
                '- Route handlers: (1) Zod-validate request (2) call service (3) format response — NO business logic',
                '- Multi-step workflows → application service layer (src/services/workflow.ts or similar)',
                '- Periodic sync/ingestion: setInterval or cron, interval from config, log every run',
                '- Composition root (src/container.ts) wires everything — the ONLY place services are instantiated',
                '',
                '### ERP Integration (ADR-050: resilience, idempotency, schema as code)',
                '- Retry with exponential backoff: 1s → 2s → 4s, max 3 attempts, on 429/503/timeout',
                '- Idempotency key per write: hash(decisionId + timestamp) — prevents duplicate records on retry',
                '- Check-before-write: query for existing record before creating',
                '- Circuit breaker: open after 5 consecutive failures, half-open after 30s, log every state change',
                '- All operations logged with correlationId and responseTimeMs',
                '- ERP schema as code: define a TypeScript interface mapping domain fields → ERP fields, include as src/erp/schema.ts',
                '',
                '### Governance (ADR-048: RBAC, immutable audit, separation of duties)',
                '- Approval endpoints enforce roles via middleware: read X-User-Role header, reject if insufficient',
                '- Separation of duties: approver MUST NOT be the recommendation creator — check and reject with 403',
                '- Audit trail: SHA-256 hash chain — each entry hashes previous entry\'s hash, genesis entry uses \'genesis\'',
                '- Verification endpoint: GET /api/audit/verify — walks the chain, reports any broken links',
                '- Every state transition records: who (userId + role), what (from → to), when (server timestamp), why (rationale min 10 chars), correlationId',
                '',
                '## Anti-Patterns to AVOID (evaluation checks — violations REDUCE score)', '',
                '- Do NOT use console.log — use createLogger()',
                '- Do NOT use `as SomeType` to cast DB rows, API responses, or request bodies — Zod-parse instead',
                '- Do NOT put business logic in route handlers — extract to service layer',
                '- Do NOT hardcode thresholds, weights, or magic numbers — read from config',
                '- Do NOT use Math.random() in production code — use crypto.randomUUID()',
                '- Do NOT list unused deps in package.json — if listed, USE them',
                '- Do NOT let event handlers fail silently — wrap each in try/catch with logging',
                '- Do NOT initialize required fields to empty string \'\'',
                '',
                '## Observability Enforcement (ADR-051)', '',
                '### Logger — EVERY module:',
                '- Import createLogger from ../logger.js. Include correlationId in every log entry.',
                '- Entry: `logger.info(\'fn.start\', { correlationId, params })`',
                '- Exit: `logger.info(\'fn.complete\', { correlationId, durationMs })`',
                '- Error: `logger.error(\'fn.failed\', err, { correlationId, context })` — NEVER `{ error: err }`',
                '',
                '### Correlation IDs — NON-NEGOTIABLE:',
                '- Copy src/middleware.ts from scaffold (correlationId + requestLogger + metricsHandler + CircuitBreaker)',
                '- Wire: `app.use(correlationId); app.use(requestLogger); app.get(\'/metrics\', metricsHandler);`',
                '- Pass correlationId through all service calls, audit entries, and ERP headers',
                '',
                '### Metrics: `GET /metrics` via metricsHandler from middleware.ts',
                '### Circuit breaker: `new CircuitBreaker(\'erp\')` wraps all external calls',
                '',
              );

              fs.writeFileSync(path.join(promptsDir, filename), lines.join('\n'), { mode: 0o600, encoding: 'utf-8' });
              completedPhases.push(`${order}. ${phase.title}`);
            }

            const planItems = derivedPhases.map((phase, i) => ({
              order: i + 1,
              file: `impl-${String(i + 1).padStart(3, '0')}-${phase.slug}.md`,
              title: phase.title,
              folder: phase.folder,
              adrs: phase.adrIds,
            }));
            // ADR-PIPELINE-033: Include simulation lineage in execution plan
            const plan = {
              totalSteps,
              prompts: planItems,
              lineage: {
                simulationId: simulationId || undefined,
                traceId: traceId || undefined,
                pipelineVersion: '1.7.3',
              },
            };
            fs.writeFileSync(path.join(promptsDir, 'execution-plan.json'), JSON.stringify(plan, null, 2), { mode: 0o600, encoding: 'utf-8' });

            console.error(`  [PROMPTS] Wrote ${totalSteps} implementation prompts derived from SPARC architecture + ADRs`);
          }

          // ADR-PIPELINE-091 §5: record the execution block on manifest.json
          // BEFORE copyPlanningArtifacts propagates the manifest into the
          // project tree, so downstream readers see the engineering tier +
          // enrichment depth in the copied artifact.
          try {
            const execBlock = computeExecutionBlock(
              [rufloPrimaryResults.phase3, rufloPrimaryResults.phase4, rufloPrimaryResults.phase5a],
              readRemoteEnrichmentSnapshot(runDir),
            );
            writeExecutionBlockToManifest(runDir, execBlock);
            process.stderr.write(
              `  [ADR-091] engineering_tier=${execBlock.engineering_tier} ` +
              `tier_counts=ruflo-local:${execBlock.tier_counts['ruflo-local']}/template:${execBlock.tier_counts.template} ` +
              `enrichment_depth_pct=${execBlock.enrichment.enrichment_depth_pct ?? 'null'}\n`,
            );
          } catch (err) {
            process.stderr.write(`  [ADR-091] execution block write failed: ${err instanceof Error ? err.message : String(err)}\n`);
          }

          copyPlanningArtifacts(runDir, projectRoot);
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          console.error(`  [PROMPTS] Implementation prompt generation failed: ${errMsg}`);
        }
      } else {
        console.error('  [PROMPTS] Skipped — no ADR directory found');
        console.error(`    Checked: ${path.join(runDir, 'phase4', 'adrs')} (${fs.existsSync(path.join(runDir, 'phase4', 'adrs')) ? 'exists' : 'MISSING'})`);
        console.error(`    Checked: ${path.join(runDir, 'phase2', 'adrs')} (${fs.existsSync(path.join(runDir, 'phase2', 'adrs')) ? 'exists' : 'MISSING'})`);
      }
      } // close ADR-PIPELINE-093 phase5a-prompts gate-else
    }
  }

  // ── Pre-Phase 5: Detect implementation language from prior artifacts ──
  let detectedLanguage = 'typescript';
  try {
    const phase3ManifestPath = path.join(runDir, 'phase3', 'phase3-manifest.json');
    const sparc3Path = path.join(runDir, 'phase3', 'sparc', 'sparc-combined.json');
    if (fs.existsSync(phase3ManifestPath)) {
      const m = JSON.parse(fs.readFileSync(phase3ManifestPath, 'utf-8'));
      if (m.implementation_language) detectedLanguage = m.implementation_language;
    } else if (fs.existsSync(sparc3Path)) {
      const sparc = JSON.parse(fs.readFileSync(sparc3Path, 'utf-8'));
      if (sparc?.architecture?.language) detectedLanguage = sparc.architecture.language;
    }
    // Also check if the user mentioned a language in the scenario query
    const langPatterns: Array<[RegExp, string]> = [
      [/\bpython\b/i, 'python'], [/\bjava\b(?!\s*script)/i, 'java'],
      [/\bc\s*#\b|\bcsharp\b|\b\.net\b/i, 'csharp'], [/\bc\+\+\b|\bcpp\b/i, 'cpp'],
      [/\bgolang\b|\bgo\s+(?:lang|service)\b/i, 'go'], [/\brust\b/i, 'rust'],
      [/\bswift\b/i, 'swift'], [/\bkotlin\b/i, 'kotlin'],
      [/\btypescript\b/i, 'typescript'], [/\bjavascript\b/i, 'javascript'],
      [/\bterraform\b|\bhcl\b/i, 'terraform'], [/\bbash\b|\bshell\s*script\b/i, 'bash'],
    ];
    for (const [re, lang] of langPatterns) {
      if (re.test(scenarioQuery)) { detectedLanguage = lang; break; }
    }
  } catch { /* best-effort language detection */ }

  // ── Phase 5: Build (Code Gen + Deployable Service) ──
  {
    const phaseStart = Date.now();
    const phaseDir = path.join(runDir, 'phase5');
    console.error('');
    console.error('-'.repeat(72));
    console.error(`  >> Phase 5: Build (Code Generation + Deployable Service) [${detectedLanguage}]`);
    console.error('-'.repeat(72));

    const phase5HasContent = fs.existsSync(phaseDir)
      && fs.existsSync(path.join(phaseDir, 'phase5-manifest.json'));
    if (phase5HasContent) {
      console.error('  [SKIP] Phase 5 already exists — using existing artifacts');
      phases.push({ phase: 5, label: 'Build', status: 'skipped', timing: 0, artifacts: [], outputDir: phaseDir });
    } else {
      // Clean up incomplete phase5 directory from a prior failed run
      if (fs.existsSync(phaseDir) && !phase5HasContent) {
        console.error('  [CLEANUP] Removing incomplete phase5 directory from prior run');
        fs.rmSync(phaseDir, { recursive: true, force: true });
      }
      const agentResults = await dispatchPhaseAgents(PHASE_AGENTS[5]!, traceId, runDir, scenarioQuery);

      // Ruflo swarm: build production-ready application in cooperation with agentics agents
      const rufloP5Dir = path.join(runDir, '.ruflo-cache', 'phase5');
      const rufloResult = executeRufloPhaseSwarm({
        phase: 5, label: 'Build (Production Code)', scenarioQuery,
        runDir, traceId, outputDir: rufloP5Dir,
        tasks: buildPhase5Tasks(scenarioQuery, detectedLanguage, collectPhase5Artifacts(runDir)),
        agenticsResults: agentResults,
        priorArtifacts: collectPhase5Artifacts(runDir),
      });
      if (rufloResult.invoked) {
        console.error(`  [RUFLO-P5] ${rufloResult.filesModified} files generated in ${rufloResult.timing}ms`);
      }

      try {
        // Domain code generation — template generators produce the domain-specific structure
        // (bounded contexts, aggregates, events, commands, queries) from SPARC/TDD/ADR/DDD artifacts.
        // Ruflo swarm enhances them when it has an LLM backend.
        const result = await executePhase5Command({ trace: traceId });
        mergeRufloCacheIntoPhase(runDir, 5);
        const timing = Date.now() - phaseStart;
        const artifactPaths = extractArtifactPaths(result.manifest.artifacts);
        console.error(formatPhase5ForDisplay(result));
        printArtifactLinks(phaseDir, artifactPaths);
        storePhaseArtifacts(PHASE_AGENTS[5]!, traceId, runDir, artifactPaths, timing);

        // Ruflo coding swarm: enhance generated code with real business logic
        console.error('');
        console.error('  >> Ruflo Coding Swarm: Enhancing generated MVP...');
        const codingSwarm = invokeRufloCodingSwarm(traceId, runDir);
        if (codingSwarm.invoked) {
          console.error(`  [RUFLO-SWARM] ${codingSwarm.filesModified} files enhanced in ${codingSwarm.timing}ms`);
        }

        // Write agent-produced SDK/CLI code as supplementary artifacts alongside the domain code
        const phase1Code = extractPhase1AgentCode(runDir);
        if (phase1Code.length > 0) {
          const sdkDir = path.join(phaseDir, 'sdk');
          fs.mkdirSync(sdkDir, { recursive: true });
          let written = 0;
          for (const cf of phase1Code) {
            const fullPath = path.join(sdkDir, cf.filePath);
            fs.mkdirSync(path.dirname(fullPath), { recursive: true });
            fs.writeFileSync(fullPath, cf.content, 'utf-8');
            written++;
          }
          if (written > 0) {
            console.error(`  [P5] Wrote ${written} supplementary SDK/CLI files from agentics agents`);
          }
        }

        await reviewPhaseOutput(PHASE_AGENTS[5]!, traceId, runDir);
        persistAgenticsResults(phaseDir, agentResults);
        phases.push({ phase: 5, label: 'Build', status: 'completed', timing, artifacts: artifactPaths, outputDir: phaseDir, agenticsAgents: buildAgentSummary(agentResults, PHASE_AGENTS[5]!.agenticsServices.length) });
        copyPlanningArtifacts(runDir, projectRoot);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.error(`  [FAIL] Phase 5 failed: ${errMsg}`);
        recordPhaseFailure(PHASE_AGENTS[5]!, traceId, errMsg);
        phases.push({ phase: 5, label: 'Build', status: 'failed', timing: Date.now() - phaseStart, artifacts: [], outputDir: phaseDir, error: errMsg });
        copyPlanningArtifacts(runDir, projectRoot);
        // Check if phase5-manifest.json exists on disk — if so, allow Phase 6 to attempt degraded mode
        const phase5ManifestPath = path.join(phaseDir, 'phase5-manifest.json');
        if (!fs.existsSync(phase5ManifestPath)) {
          await ensureAdrsExist(runDir, traceId, scenarioQuery);
          // ADR-094 Decision 4: when Phase 6 cannot attempt degraded mode,
          // emit skipped-due-to-upstream entry so Phase 6 stays visible in
          // chainResult.phases — the trace contract that pre-094 dropped.
          pushSkippedDueToUpstream(phases, { phase: 5, label: 'Build', reason: errMsg }, runDir);
        return buildResult(traceId, runDir, phases, pipelineStart, mode);
        }
        console.error('  [INFO] Phase 5 manifest written — Phase 6 will attempt degraded mode.');
      }
    }
  }

  // ── Phase 6: ERP Surface Push ──
  {
    const phaseStart = Date.now();
    const phaseDir = path.join(runDir, 'phase6');
    console.error('');
    console.error('-'.repeat(72));
    console.error('  >> Phase 6: ERP Surface Push + Project Materialization');
    console.error('-'.repeat(72));

    // Only skip if phase6 has actual registration content (not just an empty dir from a failed prior run)
    const phase6HasContent = fs.existsSync(phaseDir)
      && fs.existsSync(path.join(phaseDir, 'registration.json'));
    if (phase6HasContent) {
      console.error('  [SKIP] Phase 6 already exists — using existing artifacts');
      phases.push({ phase: 6, label: 'ERP Surface Push', status: 'skipped', timing: 0, artifacts: [], outputDir: phaseDir });
    } else {
      // Clean up incomplete phase6 directory from a prior failed run
      if (fs.existsSync(phaseDir) && !phase6HasContent) {
        console.error('  [CLEANUP] Removing incomplete phase6 directory from prior run');
        fs.rmSync(phaseDir, { recursive: true, force: true });
      }
      const agentResults = await dispatchPhaseAgents(PHASE_AGENTS[6]!, traceId, runDir, scenarioQuery);

      // Ruflo swarm + agentics agents: ERP surface push cooperatively
      const rufloP6Dir = path.join(runDir, '.ruflo-cache', 'phase6');
      const rufloResult = executeRufloPhaseSwarm({
        phase: 6, label: 'ERP Surface Push', scenarioQuery,
        runDir, traceId, outputDir: rufloP6Dir,
        tasks: buildPhase6Tasks(scenarioQuery, collectPhase6Artifacts(runDir)),
        agenticsResults: agentResults,
        priorArtifacts: collectPhase6Artifacts(runDir),
      });
      if (rufloResult.filesModified > 0) {
        console.error(`  [RUFLO-P6] ${rufloResult.filesModified} files generated (swarm+agents) in ${rufloResult.timing}ms`);
      }

      try {
        const result = await executePhase6Command({ trace: traceId, outputDir: options.outputDir });
        mergeRufloCacheIntoPhase(runDir, 6);
        const timing = Date.now() - phaseStart;
        const artifactPaths = extractArtifactPaths(result.manifest.artifacts);
        console.error(formatPhase6ForDisplay(result, options.outputDir));
        printArtifactLinks(phaseDir, artifactPaths);
        storePhaseArtifacts(PHASE_AGENTS[6]!, traceId, runDir, artifactPaths, timing);
        persistAgenticsResults(phaseDir, agentResults);
        phases.push({ phase: 6, label: 'ERP Surface Push', status: 'completed', timing, artifacts: artifactPaths, outputDir: phaseDir, agenticsAgents: buildAgentSummary(agentResults, PHASE_AGENTS[6]!.agenticsServices.length) });
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.error(`  [FAIL] Phase 6 failed: ${errMsg}`);
        recordPhaseFailure(PHASE_AGENTS[6]!, traceId, errMsg);
        phases.push({ phase: 6, label: 'ERP Surface Push', status: 'failed', timing: Date.now() - phaseStart, artifacts: [], outputDir: phaseDir, error: errMsg });
        await ensureAdrsExist(runDir, traceId, scenarioQuery);
        // ADR-PIPELINE-098 D1 — Phase 7 still runs after a Phase 6 failure
        // (only Phase 1 input loss skips it). Fall through to the Phase 7
        // block instead of returning here.
      }
    }
  }

  // ── Phase 7: Consulting Deliverables (ADR-PIPELINE-098) ──
  {
    const phaseStart = Date.now();
    const phaseDir = path.join(runDir, 'deliverables');
    console.error('');
    console.error('-'.repeat(72));
    console.error('  >> Phase 7: Consulting Deliverables (85-document enterprise decision pack)');
    console.error('-'.repeat(72));

    try {
      const { executePhase7 } = await import('./phase7/coordinator.js');
      const p7 = await executePhase7({ runDir, traceId, scenarioQuery, options });
      const timing = Date.now() - phaseStart;

      if (p7.status === 'skipped-due-to-upstream') {
        console.error(`  [P7] skipped-due-to-upstream — reason: ${p7.reason ?? 'unknown'}`);
        // ADR-094 D4 — always-emit a phases[] entry.
        phases.push({
          phase: 7,
          label: 'Consulting Deliverables',
          status: 'skipped-due-to-upstream',
          timing,
          artifacts: [],
          outputDir: phaseDir,
          error: `Upstream phase 1 inputs missing: ${p7.reason ?? 'phase1-inputs-missing'}`,
        });
      } else {
        console.error(
          `  [P7] ${p7.deliverables_emitted}/${p7.deliverables_total} emitted, ` +
          `${p7.deliverables_skeleton} skeleton, ${p7.deliverables_failed} failed, ` +
          `${p7.coherence_violations.length} coherence violations in ${timing}ms`,
        );
        const phaseStatus: PhaseStatus =
          p7.status === 'completed' ? 'completed'
          : p7.status === 'failed' ? 'failed'
          : 'completed';
        // 'partial' from the coordinator is still a successful phase from
        // the chain's POV — it produced 85 files (mix of full + skeleton).
        // We emit `completed` so `success` calc holds, but record the
        // skeleton/violation counts in error for visibility.
        const errorDetail =
          p7.status === 'partial'
            ? `partial: skeleton=${p7.deliverables_skeleton} failed=${p7.deliverables_failed} coherence_violations=${p7.coherence_violations.length}`
            : p7.status === 'failed'
              ? (p7.reason ?? 'phase7-failed')
              : undefined;
        phases.push({
          phase: 7,
          label: 'Consulting Deliverables',
          status: phaseStatus,
          timing,
          artifacts: [...p7.output_paths],
          outputDir: phaseDir,
          ...(errorDetail ? { error: errorDetail } : {}),
        });
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`  [FAIL] Phase 7 failed: ${errMsg}`);
      // ADR-094 D4 — always emit the phases[] entry, even on hard error.
      phases.push({
        phase: 7,
        label: 'Consulting Deliverables',
        status: 'failed',
        timing: Date.now() - phaseStart,
        artifacts: [],
        outputDir: phaseDir,
        error: errMsg,
      });
    }
  }

  // Progressive copy already happened after each phase via copyPlanningArtifacts()

  // ── Project mode: materialize to repo root and commit on current branch ──
  let commitHash: string | undefined;
  if (mode === 'project') {
    console.error('');
    console.error('-'.repeat(72));
    console.error('  >> Materializing MVP to current branch');
    console.error('-'.repeat(72));

    try {
      // Locate the Phase 6 project output (or Phase 5 fallback)
      const phase6ProjectDir = path.join(runDir, 'phase6', 'project');
      const phase5ProjectDir = path.join(runDir, 'phase5', 'deploy', 'project');
      const sourceDir = fs.existsSync(phase6ProjectDir) ? phase6ProjectDir : phase5ProjectDir;

      if (fs.existsSync(sourceDir) && execCtx.repoRoot) {
        copyTreeForOutput(sourceDir, execCtx.repoRoot);
        console.error(`  Copied project files to: ${execCtx.repoRoot}`);

        commitHash = commitScenarioFiles(scenarioQuery);
        console.error(`  Committed: ${commitHash.slice(0, 8)}`);
      } else {
        console.error('  [WARN] No project directory found to materialize');
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`  [WARN] Materialization failed: ${errMsg}`);
    }
  }

  // ADR-028: Final ADR guarantee before returning
  await ensureAdrsExist(runDir, traceId, scenarioQuery);

  // ADR-PIPELINE-093 — Rule 5 scaffold-skip carry-over.
  // `copyPlanningArtifacts` may have persisted a `phase5b_skipped` block
  // into manifest.json. Re-read it so `writeGateBlockToManifest` below
  // preserves it when it merges in blocked_phases + inputs_produced_by_gate.
  try {
    const phase1ManifestPath = path.join(runDir, 'manifest.json');
    if (fs.existsSync(phase1ManifestPath)) {
      try {
        const mf = JSON.parse(fs.readFileSync(phase1ManifestPath, 'utf-8')) as Record<string, unknown>;
        const skip = mf['phase5b_skipped'];
        if (skip && typeof skip === 'object') {
          const s = skip as Record<string, unknown>;
          if (typeof s['reason'] === 'string' && typeof s['detected'] === 'string' && typeof s['template'] === 'string') {
            gateAcc.phase5bSkipped = { reason: s['reason'], detected: s['detected'], template: s['template'] };
          }
        }
      } catch { /* best-effort */ }
    }
  } catch { /* best-effort */ }

  // ADR-PIPELINE-093 — Flush gate block into manifest.json BEFORE the
  // FATAL-path decision so the preserved run directory carries the
  // blocked_phases / inputs_produced_by_gate / phase5b_skipped diagnostics.
  try {
    // refresh blocked list from accumulator (determineBlockedPhases mirrors
    // what recordGateResult did; we use it as a sanity check)
    const blockedFromAcc = determineBlockedPhases(
      gateAcc.blocked.map(b => ({ phaseId: b.phase, gateResult: { ok: false, missing: [], ruflo_invoked: [], stillMissing: [...b.missing] } })),
    );
    void blockedFromAcc; // type-guard: same shape used by determineBlockedPhases
    writeGateBlockToManifest(runDir, gateAcc);
    // ADR-PIPELINE-093 §Rule 3 surface (a): same payload into status.json
    // so the CLI `status` command / MCP `agentics-status` tool expose
    // `blocked_phases` + per-phase `inputs_produced_by_gate` arrays.
    writeGateBlockToStatusJson(runDir, gateAcc);
  } catch { /* best-effort */ }

  // ADR-PIPELINE-093 Rule 4 — Mandatory Phase 5a emission. The prompt-generator
  // MUST produce a valid `execution-plan.json` with ≥1 implementations[] entry
  // and at least one impl-NNN-*.md. If either is missing at this point — even
  // after all gate-triggered Ruflo invocations — the pipeline exits FATAL
  // rather than silently returning degraded output.
  {
    const promotedPromptsDir = path.join(projectRoot, '.agentics', 'plans', 'prompts');
    const executionPlanPath = path.join(promotedPromptsDir, 'execution-plan.json');

    let hasValidPlan = false;
    try {
      if (fs.existsSync(executionPlanPath)) {
        const parsed = JSON.parse(fs.readFileSync(executionPlanPath, 'utf-8')) as { implementations?: unknown[]; prompts?: unknown[] };
        const implCount = Array.isArray(parsed.implementations)
          ? parsed.implementations.length
          : Array.isArray(parsed.prompts)
            ? parsed.prompts.length
            : 0;
        hasValidPlan = implCount >= 1;
      }
    } catch { hasValidPlan = false; }

    // ADR-PIPELINE-104: accept EITHER the consolidated implementation-prompts.md
    // (preferred — one file with `## Implement ADR-NN` sections) OR the legacy
    // impl-NNN-*.md multi-file pattern (still produced by some local fallback
    // paths). Count "implementation prompts" against whichever format is present.
    const consolidatedPromptsPath = path.join(promotedPromptsDir, 'implementation-prompts.md');
    let implFileCount = 0;
    let consolidatedSectionCount = 0;
    try {
      if (fs.existsSync(consolidatedPromptsPath)) {
        const content = fs.readFileSync(consolidatedPromptsPath, 'utf-8');
        consolidatedSectionCount = (content.match(/^##\s+Implement\s+ADR-(?!FAIL)/gim) ?? []).length;
      }
      if (fs.existsSync(promotedPromptsDir)) {
        implFileCount = fs.readdirSync(promotedPromptsDir)
          .filter(f => /^impl-\d+-.+\.md$/.test(f) && !/adr-failed|adr-fail/i.test(f))
          .length;
      }
    } catch { /* counts stay at 0 */ }

    const totalImplPrompts = consolidatedSectionCount + implFileCount;

    // ADR-PIPELINE-101 §harness — structural check on implementation prompts.
    // Logged BEFORE the FATAL gate below so operators see the failure detail
    // even if the gate then aborts the run.
    logStructuralFailures(
      [validateImplementationPrompts(promotedPromptsDir, 10)],
      'Phase 5a (Implementation Prompts)',
    );

    if (!hasValidPlan || totalImplPrompts < 1) {
      const missingList: string[] = [];
      if (!hasValidPlan) missingList.push('execution-plan.json');
      if (totalImplPrompts < 1) missingList.push('implementation-prompts.md OR impl-NNN-*.md');

      // Final banner — the one place ADR-093 allows a loud exit.
      process.stderr.write(`[PIPELINE-093] FATAL: prompt-generator blocked — upstream artifacts unrecoverable\n`);
      process.stderr.write(`  missing: ${missingList.join(', ')}\n`);
      process.stderr.write(`  attempted: Ruflo invocation for phase 4 (failed or timed out)\n`);
      process.stderr.write(`  run directory preserved: ${runDir}\n`);

      // Best-effort shutdown so file handles + metrics flush before exit.
      try {
        const totalTiming = Date.now() - pipelineStart;
        shutdownSwarm(traceId, false, totalTiming);
      } catch { /* best-effort */ }
      process.exit(1);
    }
  }

  // ── Shutdown swarm and persist metrics ──
  const totalTiming = Date.now() - pipelineStart;
  // ADR-094 Decision 4: skipped-due-to-upstream is non-failure for success calc.
  const pipelineSuccess = phases.every(
    p => p.status === 'completed' || p.status === 'skipped' || p.status === 'skipped-due-to-upstream',
  );
  shutdownSwarm(traceId, pipelineSuccess, totalTiming);

  // ── Final Summary ──
  const result = buildResult(
    traceId,
    runDir,
    phases,
    pipelineStart,
    mode,
    scenarioBranch,
    commitHash,
    execCtx.remoteUrl,
    // ADR-PIPELINE-093 §Rule 3 (c): blocked phases threaded into the
    // result so the final `agentics ask` banner can warn the user.
    gateAcc.blocked.map(b => ({ phase: b.phase, missing: [...b.missing] })),
  );
  printFinalSummary(result);
  return result;
}

// ============================================================================
// Phase 1 Summary
// ============================================================================

function printPhase1Summary(runDir: string, traceId: string): void {
  console.error('  Phase 1: Simulation (completed)');
  console.error(`  Trace ID: ${traceId}`);
  console.error(`  Run dir:  ${runDir}`);
  console.error('');

  const manifestPath = path.join(runDir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    console.error('  [WARN] Phase 1 manifest not found — pipeline may fail');
    return;
  }

  try {
    const raw = fs.readFileSync(manifestPath, 'utf-8');
    const manifest = JSON.parse(raw) as { query?: string; artifacts?: string[]; agents_invoked?: Array<{ domain: string; agent: string; status: string }> };

    if (manifest.query) {
      console.error(`  Query: ${manifest.query}`);
      console.error('');
    }

    console.error('  Phase 1 Artifacts:');
    const phase1Files = manifest.artifacts ?? [];
    for (const f of phase1Files) {
      const fullPath = path.join(runDir, f);
      const exists = fs.existsSync(fullPath);
      const icon = exists ? '[OK]' : '[--]';
      console.error(`    ${icon} ${fullPath}`);
    }

    if (manifest.agents_invoked && manifest.agents_invoked.length > 0) {
      console.error('');
      console.error('  Agents invoked:');
      for (const agent of manifest.agents_invoked) {
        const icon = agent.status === 'success' || agent.status === 'invoked' ? '[OK]' : '[!!]';
        console.error(`    ${icon} ${agent.domain}/${agent.agent}`);
      }
    }
  } catch {
    console.error('  [WARN] Could not parse Phase 1 manifest');
  }
}

// ============================================================================
// Artifact Link Printing
// ============================================================================

function printArtifactLinks(phaseDir: string, artifacts: string[]): void {
  if (artifacts.length === 0) return;

  console.error('');
  console.error('  Artifacts:');
  for (const artifact of artifacts) {
    const fullPath = path.join(phaseDir, artifact);
    if (fs.existsSync(fullPath)) {
      console.error(`    ${fullPath}`);
    } else {
      const nested = findArtifact(phaseDir, artifact);
      if (nested) {
        console.error(`    ${nested}`);
      } else {
        console.error(`    ${fullPath} (not found)`);
      }
    }
  }
}

function findArtifact(baseDir: string, filename: string): string | null {
  if (!fs.existsSync(baseDir)) return null;

  const directPath = path.join(baseDir, filename);
  if (fs.existsSync(directPath)) return directPath;

  try {
    for (const entry of fs.readdirSync(baseDir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        const nested = path.join(baseDir, entry.name, filename);
        if (fs.existsSync(nested)) return nested;

        const subDir = path.join(baseDir, entry.name);
        for (const sub of fs.readdirSync(subDir, { withFileTypes: true })) {
          if (sub.isDirectory()) {
            const deep = path.join(subDir, sub.name, filename);
            if (fs.existsSync(deep)) return deep;
          }
        }
      }
    }
  } catch {
    // Best-effort search
  }

  return null;
}

// ============================================================================
// Final Summary
// ============================================================================

function printFinalSummary(result: AutoChainResult): void {
  console.error('');
  console.error('='.repeat(72));
  console.error('  PIPELINE COMPLETE');
  console.error('='.repeat(72));
  console.error('');
  console.error(`  Trace ID:    ${result.traceId}`);
  console.error(`  Run dir:     ${result.runDir}`);
  console.error(`  Mode:        ${result.executionMode === 'development' ? 'Development (sandbox)' : 'Project'}`);
  console.error(`  Orchestration: Ruflo swarm + Agentics platform agents (hierarchical, specialized)`);
  console.error(`  Duration:    ${(result.totalTiming / 1000).toFixed(1)}s`);
  console.error(`  Success:     ${result.success}`);

  // Project mode: show commit info
  if (result.executionMode === 'project') {
    if (result.commitHash) {
      console.error('');
      console.error(`  Commit:    ${result.commitHash}`);
    }
  }
  console.error('');

  console.error('  Phase Summary:');
  console.error('  ' + '-'.repeat(60));
  for (const phase of result.phases) {
    // ADR-094 Decision 4: distinct icon for skipped-due-to-upstream so the
    // user can see which phases were propagation-skipped vs. opted-out.
    const icon = phase.status === 'completed' ? '[OK]'
      : phase.status === 'skipped' ? '[--]'
      : phase.status === 'skipped-due-to-upstream' ? '[<-]'
      : '[!!]';
    const timingStr = phase.timing > 0 ? `${(phase.timing / 1000).toFixed(1)}s` : 'cached';
    const agentStr = phase.agenticsAgents
      ? `  agents: ${phase.agenticsAgents.responded}/${phase.agenticsAgents.total}`
      : '';
    console.error(`    ${icon} Phase ${phase.phase}: ${phase.label.padEnd(25)} ${timingStr.padStart(8)}  (${phase.artifacts.length} artifacts${agentStr})`);
  }
  console.error('');

  // Show agentics agent domain coverage
  const allDomains = new Set<string>();
  let totalAgentsResponded = 0;
  let totalAgentsDispatched = 0;
  for (const phase of result.phases) {
    if (phase.agenticsAgents) {
      totalAgentsResponded += phase.agenticsAgents.responded;
      totalAgentsDispatched += phase.agenticsAgents.total;
      for (const d of phase.agenticsAgents.domains) allDomains.add(d);
    }
  }
  if (totalAgentsDispatched > 0) {
    console.error(`  Agentics Agents: ${totalAgentsResponded}/${totalAgentsDispatched} responded across ${allDomains.size} domains`);
    if (allDomains.size > 0) {
      console.error(`  Domains: ${[...allDomains].sort().join(', ')}`);
    }
    if (totalAgentsResponded < totalAgentsDispatched) {
      const missing = totalAgentsDispatched - totalAgentsResponded;
      console.error(`  WARNING: ${missing} agent(s) failed or timed out — some analysis may be incomplete`);
    }
    console.error('');
  }

  console.error('  Key Artifact Locations:');
  console.error(`    Phase 1 (Simulation):    ${result.runDir}/`);
  console.error(`      - manifest.json        ${result.runDir}/manifest.json`);
  console.error(`      - executive-summary    ${result.runDir}/executive-summary.md`);
  console.error(`      - decision-memo        ${result.runDir}/decision-memo.md`);
  console.error(`      - roadmap              ${result.runDir}/roadmap.json`);
  console.error(`      - risk-assessment      ${result.runDir}/risk-assessment.json`);
  console.error(`      - scenario             ${result.runDir}/scenario.json`);
  console.error(`    Phase 2 (Deep Research): ${result.runDir}/phase2/`);
  console.error(`    Phase 3 (SPARC + TDD):   ${result.runDir}/phase3/`);
  console.error(`    Phase 4 (ADRs + DDDs):   ${result.runDir}/phase4/`);
  console.error(`    Phase 5 (Build):         ${result.runDir}/phase5/`);
  console.error(`    Phase 6 (ERP Push):      ${result.runDir}/phase6/`);
  console.error('');

  // Mode-specific next steps
  if (result.executionMode === 'project') {
    console.error('  Next steps (Project Mode):');
    console.error('    npm install');
    console.error('    npm run dev');
    console.error('');
    console.error('  To inspect the generated code:');
    console.error(`    git log --oneline -5`);
    console.error(`    git diff HEAD~1 --stat`);
  } else {
    console.error('  ════════════════════════════════════════════════════════════');
    console.error('  IMPORTANT: Read the implementation prompts before building!');
    console.error('  ════════════════════════════════════════════════════════════');
    console.error('');
    console.error('  Implementation prompts (READ THESE FIRST — in order):');
    console.error(`    ls ${result.runDir}/prompts/impl-*.md`);
    console.error(`    cat ${result.runDir}/prompts/execution-plan.json`);
    console.error('');
    console.error('  The FIRST prompt (impl-001) contains src/logger.ts, src/config.ts,');
    console.error('  and src/errors.ts code that ALL subsequent modules must import.');
    console.error('  Every prompt has mandatory cross-cutting requirements at the bottom.');
    console.error('');
    console.error('  Architecture Decision Records:');
    console.error(`    ls ${result.runDir}/phase4/adrs/`);
    console.error('');
    console.error('  Executive documents:');
    console.error(`    cat ${result.runDir}/executive-summary.md`);
    console.error(`    cat ${result.runDir}/decision-memo.md`);
  }
  console.error('');

  console.error('  To re-run individual phases:');
  console.error(`    agentics phase2 --trace ${result.traceId}`);
  console.error(`    agentics phase3 --trace ${result.traceId}`);
  console.error(`    agentics phase4 --trace ${result.traceId}`);
  console.error(`    agentics phase5 --trace ${result.traceId}`);
  console.error(`    agentics phase6 --trace ${result.traceId}`);
  console.error('');
}

// ============================================================================
// Helpers
// ============================================================================

/** Build agent summary metadata for PhaseResult tracking. */
function buildAgentSummary(
  allServices: AgenticsServiceResult[],
  totalDispatched: number,
): PhaseResult['agenticsAgents'] {
  const domains = [...new Set(allServices.map(r => r.domain))];
  return { total: totalDispatched, responded: allServices.length, domains };
}

/**
 * Persist agentics agent results alongside phase artifacts.
 * Writes a JSON file with all agent responses for auditability.
 */
function persistAgenticsResults(phaseDir: string, results: AgenticsServiceResult[]): void {
  if (results.length === 0) return;

  try {
    if (!fs.existsSync(phaseDir)) fs.mkdirSync(phaseDir, { recursive: true });

    const report = {
      timestamp: new Date().toISOString(),
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

    fs.writeFileSync(
      path.join(phaseDir, 'agentics-agents-report.json'),
      JSON.stringify(report, null, 2),
    );
  } catch {
    // Non-fatal — agent result persistence should never block the pipeline
  }
}

// ============================================================================
// ADR-PIPELINE-091 — Ruflo primary executor helpers
// ============================================================================

/**
 * Shape of a remote agent entry as recorded in the Phase 1 `manifest.json`.
 * `status` is typically `"success" | "invoked"` for ok and anything else for
 * errored (e.g., `"503"`, `"timeout"`, `"error"`). Mirrors the inline type in
 * `printPhase1Summary`.
 */
export interface RemoteAgentInvocation {
  readonly domain: string;
  readonly agent: string;
  readonly status: string;
}

/** Snapshot of the remote enrichment fleet taken from `manifest.agents_invoked`. */
export interface RemoteEnrichmentSnapshot {
  readonly available: string[];
  readonly errored: string[];
  /** Raw entries from the manifest, kept for dossier context plumbing. */
  readonly entries: RemoteAgentInvocation[];
}

/**
 * Read `manifest.agents_invoked` from the run dir and partition into
 * successful vs errored remote enrichment agents. ADR-PIPELINE-091 §5.
 *
 * Treats `status === "success"` and `status === "invoked"` as available; any
 * other status (including HTTP error codes, `"timeout"`, `"error"`) is
 * counted as errored. Missing / unreadable manifest => empty lists.
 */
export function readRemoteEnrichmentSnapshot(runDir: string): RemoteEnrichmentSnapshot {
  const manifestPath = path.join(runDir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    return { available: [], errored: [], entries: [] };
  }
  let entries: RemoteAgentInvocation[] = [];
  try {
    const raw = fs.readFileSync(manifestPath, 'utf-8');
    const manifest = JSON.parse(raw) as { agents_invoked?: RemoteAgentInvocation[] };
    entries = Array.isArray(manifest.agents_invoked) ? manifest.agents_invoked : [];
  } catch {
    return { available: [], errored: [], entries: [] };
  }
  const available: string[] = [];
  const errored: string[] = [];
  for (const entry of entries) {
    if (!entry || typeof entry.agent !== 'string') continue;
    const isOk = entry.status === 'success' || entry.status === 'invoked';
    (isOk ? available : errored).push(entry.agent);
  }
  return { available, errored, entries };
}

/**
 * Resolve a per-phase execution tier from a Ruflo primary-executor result.
 * A phase is tagged `"ruflo-local"` iff Ruflo actually succeeded. Anything
 * else (unavailable, timeout, swarm error, missing result) => `"template"`.
 */
function phaseTierFromRufloResult(
  result: PrimaryPhaseExecutionResult | null | undefined,
): 'ruflo-local' | 'template' {
  if (!result) return 'template';
  if (result.executionTier === 'ruflo-local' && result.success) return 'ruflo-local';
  return 'template';
}

/**
 * Build the `execution` block that ADR-PIPELINE-091 §5 writes back into
 * `runDir/manifest.json`. Pure function so it can be unit-tested without
 * spinning up the actual pipeline.
 */
export function computeExecutionBlock(
  rufloResults: ReadonlyArray<PrimaryPhaseExecutionResult | null | undefined>,
  enrichment: RemoteEnrichmentSnapshot,
): {
  engineering_tier: 'ruflo-local' | 'template';
  tier_counts: { 'ruflo-local': number; template: number };
  enrichment: {
    remote_agents_available: string[];
    remote_agents_errored: string[];
    enrichment_depth_pct: number | null;
  };
} {
  const perPhaseTiers = rufloResults.map(phaseTierFromRufloResult);
  const rufloCount = perPhaseTiers.filter(t => t === 'ruflo-local').length;
  const templateCount = perPhaseTiers.filter(t => t === 'template').length;
  const engineering_tier = rufloCount > 0 ? 'ruflo-local' : 'template';

  const totalRemote = enrichment.available.length + enrichment.errored.length;
  const enrichment_depth_pct = totalRemote === 0
    ? null
    : Math.round((enrichment.available.length / totalRemote) * 100);

  return {
    engineering_tier,
    tier_counts: { 'ruflo-local': rufloCount, template: templateCount },
    enrichment: {
      remote_agents_available: [...enrichment.available],
      remote_agents_errored: [...enrichment.errored],
      enrichment_depth_pct,
    },
  };
}

/**
 * Merge the ADR-091 `execution` block into `runDir/manifest.json` in-place.
 * Reads the existing manifest, sets `execution`, writes it back with the
 * same mode/encoding convention used elsewhere in this file. Non-fatal on
 * I/O or JSON errors — the pipeline continues if manifest merge fails.
 */
export function writeExecutionBlockToManifest(
  runDir: string,
  block: ReturnType<typeof computeExecutionBlock>,
): void {
  const manifestPath = path.join(runDir, 'manifest.json');
  try {
    let manifest: Record<string, unknown> = {};
    if (fs.existsSync(manifestPath)) {
      try {
        manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as Record<string, unknown>;
      } catch {
        manifest = {};
      }
    }
    manifest['execution'] = block;
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), { mode: 0o600, encoding: 'utf-8' });
  } catch (err) {
    process.stderr.write(`  [ADR-091] Failed to merge execution block into manifest.json: ${err instanceof Error ? err.message : String(err)}\n`);
  }
}

// ============================================================================
// ADR-PIPELINE-093 — Phase-dependency gate wiring (auto-chain side)
// ============================================================================

/**
 * Per-phase gate outcomes accumulated across the auto-chain execution.
 * Populated as each phase's gate runs, then flushed to `manifest.json`
 * at pipeline completion so downstream consumers (MCP `agentics-status`
 * tool, final banner) see a stable schema.
 */
interface GateAccumulator {
  readonly blocked: BlockedPhase[];
  /** per-phase list of input paths that the gate produced via Ruflo */
  readonly producedByGate: Record<GatePhaseId, string[]>;
  /** optional scaffold-language skip record (Rule 5) */
  phase5bSkipped: { reason: string; detected: string; template: string } | null;
}

function newGateAccumulator(): GateAccumulator {
  return {
    blocked: [],
    producedByGate: {
      phase2: [],
      'phase3-sparc': [],
      'phase4-adrs-ddd': [],
      'phase5a-prompts': [],
      'phase5b-scaffold': [],
    },
    phase5bSkipped: null,
  };
}

/**
 * Record a gate result into the accumulator. `inputs_produced_by_gate`
 * reflects the initially-missing paths that became present after Ruflo
 * ran (i.e. `missing` minus `stillMissing`). A stable shape is important
 * for downstream readers even when the gate passed on first check.
 */
function recordGateResult(
  acc: GateAccumulator,
  phaseId: GatePhaseId,
  result: GateResult,
): void {
  if (!result.ok && result.stillMissing.length > 0) {
    acc.blocked.push({ phase: phaseId, missing: result.stillMissing });
  }
  if (result.ruflo_invoked.length > 0) {
    const stillMissingSet = new Set(result.stillMissing);
    const produced = result.missing.filter(p => !stillMissingSet.has(p));
    if (produced.length > 0) {
      acc.producedByGate[phaseId] = [...acc.producedByGate[phaseId], ...produced];
    }
  }
}

/**
 * ADR-PIPELINE-093 — merge `blocked_phases`, per-phase
 * `phase{N}_inputs_produced_by_gate`, and `phase5b_skipped` into
 * `runDir/manifest.json`. Read-modify-write pattern mirrors
 * `writeExecutionBlockToManifest` / `writePlanPromotionToManifest`.
 *
 * `blocked_phases` is always present (empty array when no phase blocked).
 * The per-phase `inputs_produced_by_gate` keys are always present so
 * downstream readers can treat them as a stable schema.
 */
export function writeGateBlockToManifest(runDir: string, acc: GateAccumulator): void {
  const manifestPath = path.join(runDir, 'manifest.json');
  try {
    let manifest: Record<string, unknown> = {};
    if (fs.existsSync(manifestPath)) {
      try {
        manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as Record<string, unknown>;
      } catch {
        manifest = {};
      }
    }
    manifest['blocked_phases'] = acc.blocked.map(b => ({ phase: b.phase, missing: [...b.missing] }));
    manifest['phase2_inputs_produced_by_gate'] = [...acc.producedByGate['phase2']];
    manifest['phase3_inputs_produced_by_gate'] = [...acc.producedByGate['phase3-sparc']];
    manifest['phase4_inputs_produced_by_gate'] = [...acc.producedByGate['phase4-adrs-ddd']];
    manifest['phase5a_inputs_produced_by_gate'] = [...acc.producedByGate['phase5a-prompts']];
    if (acc.phase5bSkipped) {
      manifest['phase5b_skipped'] = { ...acc.phase5bSkipped };
    }
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), { mode: 0o600, encoding: 'utf-8' });
  } catch (err) {
    process.stderr.write(`  [PIPELINE-093] Failed to merge gate block into manifest.json: ${err instanceof Error ? err.message : String(err)}\n`);
  }
}

/**
 * ADR-PIPELINE-093 §Rule 3 (surface b) — same gate-block payload, written
 * into `runDir/status.json` so the CLI `status` command + MCP
 * `agentics-status` tool carry `blocked_phases` and the per-phase
 * `phase{N}_inputs_produced_by_gate` arrays alongside the ADR-088 keys.
 *
 * Read-modify-write pattern matches the CLI's local `updateStatus` helper
 * (`src/cli/index.ts`:~2501). Best-effort: if `status.json` does not exist
 * (e.g. running outside the MCP fast-return path), the file is created so
 * the gate block is always observable regardless of entry point.
 *
 * Both `writeGateBlockToManifest` and this function should be called from
 * the same accumulator snapshot so manifest.json and status.json stay in
 * sync. The CLI-surfaced `status.json` is the source of truth for the MCP
 * `agentics-status` tool (which shells out to `agentics status`).
 */
export function writeGateBlockToStatusJson(runDir: string, acc: GateAccumulator): void {
  const statusPath = path.join(runDir, 'status.json');
  try {
    let status: Record<string, unknown> = {};
    if (fs.existsSync(statusPath)) {
      try {
        status = JSON.parse(fs.readFileSync(statusPath, 'utf-8')) as Record<string, unknown>;
      } catch {
        status = {};
      }
    }
    status['blocked_phases'] = acc.blocked.map(b => ({ phase: b.phase, missing: [...b.missing] }));
    status['phase2_inputs_produced_by_gate'] = [...acc.producedByGate['phase2']];
    status['phase3_inputs_produced_by_gate'] = [...acc.producedByGate['phase3-sparc']];
    status['phase4_inputs_produced_by_gate'] = [...acc.producedByGate['phase4-adrs-ddd']];
    status['phase5a_inputs_produced_by_gate'] = [...acc.producedByGate['phase5a-prompts']];
    if (acc.phase5bSkipped) {
      status['phase5b_skipped'] = { ...acc.phase5bSkipped };
    }
    status['updatedAt'] = new Date().toISOString();
    const tmp = statusPath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(status, null, 2), { mode: 0o600, encoding: 'utf-8' });
    fs.renameSync(tmp, statusPath);
  } catch (err) {
    process.stderr.write(`  [PIPELINE-093] Failed to merge gate block into status.json: ${err instanceof Error ? err.message : String(err)}\n`);
  }
}

/**
 * ADR-PIPELINE-093 — thin wrapper around `gatePhaseInputs` that surfaces
 * a consistent `[GATE]` log line and records the result into the
 * pipeline-wide accumulator. Returns the raw `GateResult` so the caller
 * can branch on `ok`.
 */
async function runPhaseGate(
  phaseId: GatePhaseId,
  scenarioQuery: string,
  traceId: string,
  runDir: string,
  acc: GateAccumulator,
): Promise<GateResult> {
  const dossier: Phase1Dossier = {
    scenarioQuery,
    traceId,
    runDir,
    artifacts: {},
  };
  const context: RufloExecutionContext = {
    outputDir: path.join(runDir, '.ruflo-cache', `gate-${phaseId}`),
  };
  let result: GateResult;
  try {
    result = await gatePhaseInputs(phaseId, { runDir, dossier, context });
  } catch (err) {
    // gatePhaseInputs never throws, but defensive fallback keeps the
    // pipeline running if the gate's own internals crash.
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`  [GATE] ${phaseId} threw unexpectedly: ${msg}\n`);
    result = { ok: false, missing: [], ruflo_invoked: [], stillMissing: [] };
  }
  recordGateResult(acc, phaseId, result);
  if (!result.ok && result.stillMissing.length > 0) {
    process.stderr.write(`  [GATE] phase ${phaseId} blocked — stillMissing: ${result.stillMissing.join(', ')}\n`);
  }
  return result;
}

// ============================================================================
// ADR-PIPELINE-093 Rule 5 — Scaffold language gate
// ============================================================================

type ScaffoldLanguage = 'typescript' | 'python' | 'go' | 'rust' | 'unknown';

/**
 * Detect the target project language from Phase 1 manifest.json
 * (`project.language`) first, then falls back to common project root
 * marker files. Returns `'unknown'` when no signal is available — the
 * caller decides whether to skip or proceed in that case.
 */
/**
 * ADR-PIPELINE-093 §Rule 5 — single arbiter for which scaffold template set
 * `copyPlanningArtifacts` should emit. Called ONCE per invocation so the TS
 * block and the Python block gate on the same decision.
 *
 * - `typescript`            → emit TS, skip Python, no manifest record.
 * - `python`                → skip TS, emit Python, no manifest record.
 * - `go`|`rust`|`unknown`   → skip both, record `phase5b_skipped` with the
 *                             detected language and `template: 'typescript'`
 *                             (kept for Scenario-5 compatibility — the
 *                             skip block's shape is the ADR-093 schema).
 *
 * The detected-language + template-name pair in `skipped` matches what the
 * pre-093-fix gate wrote to `manifest.json`, so downstream status.json /
 * MCP consumers don't see a shape change on the mismatch path.
 */
export function decideScaffoldEmission(
  detected: ScaffoldLanguage,
): {
  emitTs: boolean;
  emitPy: boolean;
  skipped: null | { reason: 'language-mismatch'; detected: string; template: string };
} {
  if (detected === 'typescript') return { emitTs: true, emitPy: false, skipped: null };
  if (detected === 'python') return { emitTs: false, emitPy: true, skipped: null };
  // go / rust / unknown — no matching template set, record mismatch.
  return {
    emitTs: false,
    emitPy: false,
    skipped: { reason: 'language-mismatch', detected, template: 'typescript' },
  };
}

export function detectProjectLanguage(
  projectRoot: string,
  phase1Manifest?: Record<string, unknown>,
): ScaffoldLanguage {
  // 1. Explicit signal from Phase 1 manifest.
  const projBlock = phase1Manifest?.['project'];
  if (projBlock && typeof projBlock === 'object') {
    const lang = (projBlock as Record<string, unknown>)['language'];
    if (typeof lang === 'string') {
      const normalized = lang.toLowerCase();
      if (normalized === 'typescript' || normalized === 'javascript') return 'typescript';
      if (normalized === 'python') return 'python';
      if (normalized === 'go' || normalized === 'golang') return 'go';
      if (normalized === 'rust') return 'rust';
    }
  }
  // 2. Project-root marker files.
  const fileExists = (p: string): boolean => {
    try { return fs.statSync(p).isFile(); } catch { return false; }
  };
  if (fileExists(path.join(projectRoot, 'package.json'))) return 'typescript';
  if (
    fileExists(path.join(projectRoot, 'pyproject.toml')) ||
    fileExists(path.join(projectRoot, 'setup.py'))
  ) return 'python';
  if (fileExists(path.join(projectRoot, 'go.mod'))) return 'go';
  if (fileExists(path.join(projectRoot, 'Cargo.toml'))) return 'rust';
  return 'unknown';
}

/**
 * Build the `extras` payload attached to a `Phase1Dossier` for the Ruflo
 * primary executor. Successful remote enrichment agents are surfaced so
 * Ruflo can weave their output into task descriptions. ADR-091 §2.
 *
 * When no remote enrichment exists for this run, `remote_enrichment` is
 * still present but its arrays are empty — Ruflo task builders tolerate
 * either shape.
 */
function buildRufloDossierExtras(
  runDir: string,
  enrichment: RemoteEnrichmentSnapshot,
): Record<string, unknown> {
  const successfulEntries = enrichment.entries.filter(e => e.status === 'success' || e.status === 'invoked');
  const erroredEntries = enrichment.entries.filter(e => !(e.status === 'success' || e.status === 'invoked'));
  return {
    remote_enrichment: {
      runDir,
      available: successfulEntries.map(e => ({ domain: e.domain, agent: e.agent })),
      errored: erroredEntries.map(e => ({ domain: e.domain, agent: e.agent, status: e.status })),
    },
  };
}

/**
 * Invoke the Ruflo primary executor for a given engineering phase. Returns
 * the result (or a synthesized unavailable result on unexpected throw) so
 * auto-chain can always tag the phase for the ADR-091 execution block.
 *
 * This is a thin wrapper around `runPrimaryPhaseExecution` that:
 *  1. Ensures the dossier carries `scenarioQuery`, `traceId`, `runDir`,
 *     plus Phase 1 artifacts + remote enrichment extras.
 *  2. Surfaces a `[ADR-091]` log line so operators can see which phases
 *     actually executed via the local swarm.
 *  3. Never throws.
 */
async function runRufloPrimaryForPhase(
  phaseId: PrimaryPhaseId,
  scenarioQuery: string,
  traceId: string,
  runDir: string,
  priorArtifacts: Record<string, string>,
  enrichment: RemoteEnrichmentSnapshot,
  outputDir: string,
  language?: string,
): Promise<PrimaryPhaseExecutionResult> {
  const dossier: Phase1Dossier = {
    scenarioQuery,
    traceId,
    runDir,
    artifacts: priorArtifacts,
    extras: buildRufloDossierExtras(runDir, enrichment),
  };
  const context: RufloExecutionContext = {
    outputDir,
    ...(language ? { language } : {}),
  };
  try {
    const result = await runPrimaryPhaseExecution(phaseId, dossier, context);
    if (result.executionTier === 'ruflo-local' && result.success) {
      process.stderr.write(`  [ADR-091] Ruflo primary executor produced ${result.filesModified} file(s) for ${phaseId} in ${result.timing}ms\n`);
    } else if (result.executionTier === 'unavailable') {
      process.stderr.write(`  [ADR-091] Ruflo unavailable for ${phaseId} (${result.reason ?? 'no-reason'}) — falling through to template coordinator\n`);
    } else {
      process.stderr.write(`  [ADR-091] Ruflo primary executor did not produce output for ${phaseId} (${result.reason ?? 'no-reason'}) — falling through\n`);
    }
    return result;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`  [ADR-091] Ruflo primary executor threw for ${phaseId}: ${msg.slice(0, 200)}\n`);
    return {
      phaseId,
      success: false,
      executionTier: 'unavailable',
      reason: 'swarm-error',
      filesModified: 0,
      timing: 0,
      message: `Ruflo primary executor threw for ${phaseId}: ${msg.slice(0, 200)}`,
    };
  }
}

// ============================================================================
// Stdout Display Formatter
// ============================================================================

/**
 * Format the auto-chain result for stdout display.
 * This is the consolidated pipeline summary that surfaces Phase 2-6 details
 * to callers who only see stdout (e.g., Claude Code rendering `agentics ask`).
 */
export function formatAutoChainForDisplay(result: AutoChainResult): string {
  const lines: string[] = [];

  lines.push('');
  lines.push('='.repeat(72));
  lines.push('  ENTERPRISE PROTOTYPE PIPELINE — PHASES 2-6');
  lines.push('='.repeat(72));
  lines.push('');
  lines.push(`  Trace ID:       ${result.traceId}`);
  lines.push(`  Run Directory:  ${result.runDir}`);
  lines.push(`  Mode:           ${result.executionMode === 'development' ? 'Development (sandbox)' : 'Project'}`);
  lines.push(`  Duration:       ${(result.totalTiming / 1000).toFixed(1)}s`);
  lines.push(`  Overall:        ${result.success ? 'SUCCESS' : 'FAILED'}`);
  lines.push('');

  // ADR-PIPELINE-093 §Rule 3 surface (c) — blocked-phases warning banner.
  // Emits only when one or more phases could not run because their
  // prerequisites were unreachable after Ruflo retry. Zero-blocked runs
  // render no warning section.
  const blocked = result.blockedPhases ?? [];
  if (blocked.length > 0) {
    lines.push('  WARNING — BLOCKED PHASES:');
    for (const b of blocked) {
      const missingList = b.missing.length > 0 ? b.missing.join(', ') : '(unspecified)';
      lines.push(`    - ${b.phase}: missing ${missingList}`);
    }
    lines.push('  Consider running the pipeline again, or check');
    lines.push(`    ~/.agentics/runs/${result.traceId}/ for partial output.`);
    lines.push('');
  }

  // Phase-by-phase summary
  lines.push('  Phase Results:');
  lines.push('  ' + '-'.repeat(68));
  for (const phase of result.phases) {
    // ADR-094 Decision 4: same icon set as printFinalSummary.
    const icon = phase.status === 'completed' ? '[OK]'
      : phase.status === 'skipped' ? '[--]'
      : phase.status === 'skipped-due-to-upstream' ? '[<-]'
      : '[!!]';
    const timingStr = phase.timing > 0 ? `${(phase.timing / 1000).toFixed(1)}s` : 'cached';
    lines.push(`    ${icon} Phase ${phase.phase}: ${phase.label.padEnd(30)} ${timingStr.padStart(8)}  (${phase.artifacts.length} artifacts)`);
    if (phase.error) {
      lines.push(`         Error: ${phase.error}`);
    }
  }
  lines.push('');

  // Artifact locations
  const totalArtifacts = result.phases.reduce((sum, p) => sum + p.artifacts.length, 0);
  lines.push(`  Total Artifacts: ${totalArtifacts} files across ${result.phases.length} phases`);
  lines.push('');
  lines.push('  Key Locations:');
  for (const phase of result.phases) {
    if (phase.status !== 'skipped') {
      lines.push(`    Phase ${phase.phase} (${phase.label}): ${phase.outputDir}`);
    }
  }
  lines.push('');

  // Project mode branch info
  if (result.executionMode === 'project' && result.scenarioBranch) {
    lines.push(`  Scenario Branch: ${result.scenarioBranch}`);
    if (result.commitHash) {
      lines.push(`  Commit:          ${result.commitHash}`);
    }
    if (result.githubUrl) {
      lines.push(`  GitHub:          ${result.githubUrl}`);
    }
    lines.push('');
  }

  // ADR-PIPELINE-039: Tell Claude Code exactly what to read and follow
  lines.push('  ══════════════════════════════════════════════════════════════════');
  lines.push('  IMPLEMENTATION INSTRUCTIONS (Claude Code: READ THESE FILES)');
  lines.push('  ══════════════════════════════════════════════════════════════════');
  lines.push('');
  lines.push('  The pipeline generated implementation prompts in .agentics/plans/prompts/');
  lines.push('  These are ORDERED build steps. Read them sequentially and follow each one.');
  lines.push('');
  lines.push('  CRITICAL FILES TO READ BEFORE BUILDING:');
  lines.push('    1. .agentics/plans/prompts/execution-plan.json  — Build order and dependencies');
  lines.push('    2. .agentics/plans/prompts/impl-001-*.md        — First: create logger.ts, config.ts, errors.ts, then domain types');
  lines.push('    3. .agentics/plans/prompts/impl-002-*.md        — Second build step');
  lines.push('    4. .agentics/plans/prompts/impl-003-*.md        — Third build step (continue for all impl-*.md files)');
  lines.push('    5. .agentics/plans/adrs/                        — Architecture Decision Records (design rationale)');
  lines.push('');
  lines.push('  EVERY MODULE MUST INCLUDE (from each prompt\'s cross-cutting section):');
  lines.push('    - src/logger.ts with createLogger() — structured JSON logging to stderr');
  lines.push('    - src/config.ts with AppConfig — environment-based configuration');
  lines.push('    - src/errors.ts with AppError classes — typed error handling');
  lines.push('    - Input validation on all public functions');
  lines.push('    - Correlation ID threading through analysis → decision → ERP sync');
  lines.push('');
  lines.push('  DO NOT skip the implementation prompts and build from scratch.');
  lines.push('  The prompts contain specific code patterns that the evaluation checks for.');
  lines.push('');

  // Legacy next steps
  lines.push('  To inspect all artifacts:');
  lines.push(`    agentics inspect run ${result.traceId}`);
  lines.push('');

  return lines.join('\n');
}

/**
 * ADR-094 Decision 4 — Phase 6 always emits a phase-result entry. When an
 * upstream phase ends in `failed` or `blocked`, every downstream phase that
 * has not already been pushed gets a `skipped-due-to-upstream` entry. This
 * preserves the `chainResult.phases[]` trace contract: every run produces
 * an entry per phase, regardless of where the chain ended.
 *
 * Mutates `phases` in place. Idempotent — phases already present on the list
 * are not re-pushed. Exported for unit tests; production callers go through
 * the early-return sites in `executeAutoChain`.
 */
export function pushSkippedDueToUpstream(
  phases: PhaseResult[],
  upstream: { phase: number; label: string; reason: string },
  runDir: string,
): void {
  // Phase labels mirror the dispatch sites. Output dirs follow the existing
  // <runDir>/phaseN convention from auto-chain. Keep the table in this one
  // place so future phases land here too.
  const REMAINING: ReadonlyArray<{ phase: number; label: string; dir: string }> = [
    { phase: 2, label: 'Deep Research',          dir: 'phase2' },
    { phase: 3, label: 'SPARC + London TDD',     dir: 'phase3' },
    { phase: 4, label: 'ADRs + DDDs',            dir: 'phase4' },
    { phase: 5, label: 'Build',                  dir: 'phase5' },
    { phase: 6, label: 'ERP Surface Push',       dir: 'phase6' },
  ];
  const reasonExcerpt = upstream.reason.length > 200
    ? upstream.reason.slice(0, 200) + '…'
    : upstream.reason;
  for (const r of REMAINING) {
    if (r.phase <= upstream.phase) continue;
    if (phases.some((ph) => ph.phase === r.phase)) continue;
    phases.push({
      phase: r.phase,
      label: r.label,
      status: 'skipped-due-to-upstream',
      timing: 0,
      artifacts: [],
      outputDir: path.join(runDir, r.dir),
      error: `Upstream phase ${upstream.phase} (${upstream.label}) failed: ${reasonExcerpt}`,
    });
  }
}

function buildResult(
  traceId: string,
  runDir: string,
  phases: PhaseResult[],
  startTime: number,
  executionMode: ExecutionMode = 'development',
  scenarioBranch?: string,
  commitHash?: string,
  remoteUrl?: string | null,
  blockedPhases?: ReadonlyArray<{ phase: string; missing: ReadonlyArray<string> }>,
): AutoChainResult {
  // ADR-094 Decision 4: `skipped-due-to-upstream` is treated like `skipped`
  // for the success check — it is not a failure of THIS phase, just a
  // propagation marker. `failed` remains the only status that flips success.
  const success = phases.every(
    (p) => p.status === 'completed' || p.status === 'skipped' || p.status === 'skipped-due-to-upstream',
  );

  // Build GitHub URL if we have a remote and a branch
  let githubUrl: string | undefined;
  if (remoteUrl && scenarioBranch) {
    const match = remoteUrl.match(/github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?$/);
    if (match) {
      githubUrl = `https://github.com/${match[1]}/${match[2]}/tree/${scenarioBranch}`;
    }
  }

  return {
    traceId,
    runDir,
    phases,
    totalTiming: Date.now() - startTime,
    success,
    executionMode,
    scenarioBranch,
    commitHash,
    githubUrl,
    // ADR-PIPELINE-093 §Rule 3 surface (c): carry blocked phases into the
    // result so `formatAutoChainForDisplay` can emit the banner warning.
    blockedPhases: blockedPhases ? blockedPhases.map(b => ({ phase: b.phase, missing: [...b.missing] })) : [],
  };
}
