/**
 * ADR-PIPELINE-093 — Phase Dependency Gate.
 *
 * Shared helper that verifies a phase's required inputs exist, are non-stub,
 * and meet a minimum size before the phase coordinator runs. On a miss the
 * gate invokes the ADR-091 primary executor (`runPrimaryPhaseExecution`)
 * once per missing upstream phase (capped by `maxRetriesPerInput`, default 1)
 * and re-checks.
 *
 * The gate is side-effect-minimal: it only reads `runDir`, logs to stderr
 * with the `[GATE]` prefix, and forwards Ruflo invocations to the injected
 * executor. Mapping of required-input → owning upstream phase is static
 * (`INPUT_OWNER_MAP`) and colocated with the dependency table
 * (`PHASE_DEPENDENCIES`).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  runPrimaryPhaseExecution as runPrimaryPhaseExecutionImpl,
  checkRufloAvailable as checkRufloAvailableImpl,
  type Phase1Dossier,
  type RufloExecutionContext,
  type PrimaryPhaseExecutionResult,
} from '../ruflo-phase-executor.js';

// ============================================================================
// Types
// ============================================================================

/** Phase ids accepted by the dependency gate. */
export type PhaseId =
  | 'phase2'
  | 'phase3-sparc'
  | 'phase4-adrs-ddd'
  | 'phase5a-prompts'
  | 'phase5b-scaffold';

/** A single required-input clause. Either a single file or an "any-of" set. */
export interface RequiredInput {
  readonly kind: 'file' | 'any-of';
  /** Paths relative to runDir. Supports trailing `/*` for glob (ADR-093). */
  readonly paths: ReadonlyArray<string>;
  /** Minimum file size in bytes. Defaults to 100 per ADR-093 Rule 2. */
  readonly minBytes?: number;
}

/** Per-phase static dependency declaration. */
export interface PhaseDependency {
  readonly phaseId: PhaseId;
  readonly required: ReadonlyArray<RequiredInput>;
  /** Path patterns relative to runDir; informational only (not gated). */
  readonly optional: ReadonlyArray<string>;
}

/** Gate invocation result. */
export interface GateResult {
  readonly ok: boolean;
  /** Paths that failed the initial check. */
  readonly missing: ReadonlyArray<string>;
  /** Upstream phase ids whose Ruflo primary executor was invoked. */
  readonly ruflo_invoked: ReadonlyArray<string>;
  /** Paths still failing after the retry pass. Empty when `ok` is true. */
  readonly stillMissing: ReadonlyArray<string>;
}

/** Gate options. `runPrimaryPhaseExecution` is injectable for unit tests. */
export interface GateOptions {
  readonly runDir: string;
  readonly dossier: Phase1Dossier;
  readonly context: RufloExecutionContext;
  /** Max Ruflo invocations per missing input per run. Defaults to 1 (ADR-093 Rule 2). */
  readonly maxRetriesPerInput?: number;
  /** Injectable for tests. Defaults to the real `runPrimaryPhaseExecution`. */
  readonly runPrimaryPhaseExecution?: typeof runPrimaryPhaseExecutionImpl;
  /** Injectable for tests. Defaults to the real `checkRufloAvailable`. */
  readonly checkRufloAvailable?: typeof checkRufloAvailableImpl;
}

/** Entry describing a phase that could not run because inputs were unreachable. */
export interface BlockedPhase {
  readonly phase: PhaseId;
  readonly missing: ReadonlyArray<string>;
}

// ============================================================================
// Static dependency table (ADR-PIPELINE-093 Decision Rule 1)
// ============================================================================

const MIN_BYTES_DEFAULT = 100;

/** Per-phase required/optional inputs, hard-coded from the ADR DAG table. */
export const PHASE_DEPENDENCIES: Readonly<Record<PhaseId, PhaseDependency>> = {
  phase2: {
    phaseId: 'phase2',
    required: [
      { kind: 'file', paths: ['phase1/manifest.json'] },
      { kind: 'file', paths: ['phase1/executive-summary.md'] },
    ],
    optional: [
      'phase1/scenario.json',
      'phase1/decision-memo.md',
      'phase1/risk-assessment.json',
    ],
  },
  'phase3-sparc': {
    phaseId: 'phase3-sparc',
    required: [
      { kind: 'file', paths: ['phase1/manifest.json'] },
      { kind: 'file', paths: ['phase2/research-dossier.json'] },
    ],
    optional: [
      'phase1/roadmap.json',
      'phase2/hypotheses.json',
      'diligence-artifacts/sparc-*',
    ],
  },
  'phase4-adrs-ddd': {
    phaseId: 'phase4-adrs-ddd',
    required: [
      { kind: 'file', paths: ['phase1/manifest.json'] },
      {
        kind: 'any-of',
        paths: [
          'phase3/sparc/specification.md',
          'engineering/sparc-specification.md',
        ],
      },
    ],
    optional: [
      'phase2/research-dossier.json',
      'diligence-artifacts/adr-generation',
    ],
  },
  'phase5a-prompts': {
    phaseId: 'phase5a-prompts',
    required: [
      {
        kind: 'any-of',
        paths: [
          'phase3/sparc/specification.md',
          'engineering/sparc-specification.md',
        ],
      },
      {
        kind: 'any-of',
        paths: [
          'phase4/adrs/*.md',
          'phase4/ddd/bounded-contexts.json',
          'engineering/architecture-decisions.md',
        ],
      },
    ],
    optional: [],
  },
  'phase5b-scaffold': {
    phaseId: 'phase5b-scaffold',
    required: [{ kind: 'file', paths: ['phase1/manifest.json'] }],
    optional: ['phase4/adrs/*.md', 'phase5a/execution-plan.json'],
  },
};

// ============================================================================
// Input → owning-upstream-phase map (ADR-PIPELINE-093)
// ============================================================================

/**
 * Maps a required-input path (relative to runDir) onto the upstream phase
 * that produces it. Used by the gate to decide which phase's Ruflo primary
 * executor to invoke when an input is missing. Keyed by path prefix; the
 * longest matching prefix wins.
 */
export const INPUT_OWNER_MAP: Readonly<Record<string, PhaseId>> = {
  'phase1/': 'phase2', // phase1 is the entry; phase2 is the earliest "producable" upstream we can invoke
  'phase2/': 'phase2',
  'phase3/sparc/': 'phase3-sparc',
  'engineering/sparc-specification.md': 'phase3-sparc',
  'phase4/adrs/': 'phase4-adrs-ddd',
  'phase4/ddd/': 'phase4-adrs-ddd',
  'phase4/': 'phase4-adrs-ddd',
  'engineering/architecture-decisions.md': 'phase4-adrs-ddd',
  'engineering/domain-model.md': 'phase4-adrs-ddd',
  'phase4/prompts/': 'phase5a-prompts',
  'phase5a/': 'phase5a-prompts',
};

/**
 * Upstream phases supported by `runPrimaryPhaseExecution`. Phase 1 is the
 * pipeline entry and is never re-invoked by the gate — a missing phase1 file
 * is surfaced as a hard block. Phase 2 maps to the phase2 coordinator, which
 * is wired separately by auto-chain; the gate passes the string through.
 */
const INVOKABLE_UPSTREAM: ReadonlySet<PhaseId> = new Set<PhaseId>([
  'phase2',
  'phase3-sparc',
  'phase4-adrs-ddd',
  'phase5a-prompts',
]);

// ============================================================================
// Public helpers
// ============================================================================

/**
 * Returns `false` iff the content is a JSON error-stub sentinel — a JSON
 * object whose only top-level keys are `error` and/or `message`. Non-JSON
 * content always returns `true`. Empty strings also return `true`
 * (size-gating is the caller's job; the stub check is purely about shape).
 */
export function isNotErrorStub(content: string): boolean {
  const trimmed = content.trim();
  if (trimmed.length === 0) return true;
  if (!trimmed.startsWith('{')) return true;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return true;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return true;
  }
  const keys = Object.keys(parsed as Record<string, unknown>);
  if (keys.length === 0) return true;
  const onlyErrorOrMessage = keys.every((k) => k === 'error' || k === 'message');
  return !onlyErrorOrMessage;
}

/**
 * Inspects per-phase gate results and returns a BlockedPhase entry for
 * every phase whose gate failed and still has missing inputs after retry.
 * Used by auto-chain to populate `status.json.blocked_phases`.
 */
export function determineBlockedPhases(
  results: ReadonlyArray<{ phaseId: PhaseId; gateResult: GateResult }>,
): ReadonlyArray<BlockedPhase> {
  const blocked: BlockedPhase[] = [];
  for (const r of results) {
    if (!r.gateResult.ok && r.gateResult.stillMissing.length > 0) {
      blocked.push({ phase: r.phaseId, missing: r.gateResult.stillMissing });
    }
  }
  return blocked;
}

// ============================================================================
// Core gate algorithm
// ============================================================================

/**
 * Verifies `phaseId`'s declared required inputs on disk. On a miss, invokes
 * the ADR-091 primary executor for each owning upstream phase (capped at
 * `maxRetriesPerInput`) and re-checks. Returns a `GateResult` describing the
 * outcome. Never throws.
 */
export async function gatePhaseInputs(
  phaseId: PhaseId,
  opts: GateOptions,
): Promise<GateResult> {
  const dep = PHASE_DEPENDENCIES[phaseId];
  const maxRetries = opts.maxRetriesPerInput ?? 1;
  const runPrimary = opts.runPrimaryPhaseExecution ?? runPrimaryPhaseExecutionImpl;

  // First pass — collect failures.
  const initialFailures = collectMissingPaths(opts.runDir, dep.required);
  if (initialFailures.length === 0) {
    return { ok: true, missing: [], ruflo_invoked: [], stillMissing: [] };
  }

  // Determine which upstream phases own the failed inputs.
  const upstreamPhases = new Set<PhaseId>();
  for (const failedPath of initialFailures) {
    const owner = resolveOwner(failedPath);
    if (owner !== null && INVOKABLE_UPSTREAM.has(owner) && owner !== phaseId) {
      upstreamPhases.add(owner);
    }
  }

  const invoked: PhaseId[] = [];
  const invocationCounts = new Map<PhaseId, number>();

  // Invoke the primary executor for each upstream phase (capped).
  for (const upstream of upstreamPhases) {
    const count = invocationCounts.get(upstream) ?? 0;
    if (count >= maxRetries) continue;
    invocationCounts.set(upstream, count + 1);
    invoked.push(upstream);

    const missingForOwner = initialFailures.filter(
      (p) => resolveOwner(p) === upstream,
    );
    for (const p of missingForOwner) {
      process.stderr.write(
        `[GATE] ${phaseId}: missing ${p} — invoking Ruflo (${upstream})\n`,
      );
    }

    try {
      // `runPrimaryPhaseExecution` accepts `PrimaryPhaseId` which differs
      // from `PhaseId` (no phase2, no phase5b). Tests inject their own
      // executor; the production call will be a no-op for phase2 because
      // auto-chain wires phase2 through its own path — the gate preserves
      // the call for parity.
      const result: PrimaryPhaseExecutionResult = await runPrimary(
        upstream as unknown as Parameters<typeof runPrimaryPhaseExecutionImpl>[0],
        opts.dossier,
        opts.context,
      );
      if (result.executionTier === 'unavailable') {
        process.stderr.write(
          `[GATE] ${phaseId}: Ruflo unavailable (${upstream}) — reason=${result.reason ?? 'unknown'}\n`,
        );
      }
    } catch (err) {
      process.stderr.write(
        `[GATE] ${phaseId}: Ruflo threw for ${upstream} — ${(err as Error).message}\n`,
      );
    }
  }

  // Re-check after all Ruflo invocations have (had a chance to) run.
  const stillMissing = collectMissingPaths(opts.runDir, dep.required);

  if (stillMissing.length === 0) {
    process.stderr.write(`[GATE] ${phaseId}: recovered via Ruflo\n`);
    return {
      ok: true,
      missing: initialFailures,
      ruflo_invoked: invoked,
      stillMissing: [],
    };
  }

  process.stderr.write(
    `[GATE] ${phaseId}: still blocked — ${stillMissing.join(', ')}\n`,
  );
  return {
    ok: false,
    missing: initialFailures,
    ruflo_invoked: invoked,
    stillMissing,
  };
}

// ============================================================================
// Internal helpers
// ============================================================================

/** First 512 bytes is enough to spot JSON error-stub shape. */
const STUB_SCAN_BYTES = 512;

/** Returns the list of required-input paths that FAIL the existence/size/stub check. */
function collectMissingPaths(
  runDir: string,
  required: ReadonlyArray<RequiredInput>,
): string[] {
  const missing: string[] = [];
  for (const req of required) {
    const minBytes = req.minBytes ?? MIN_BYTES_DEFAULT;
    if (req.kind === 'file') {
      // ALL paths must satisfy the criteria.
      for (const p of req.paths) {
        if (!pathSatisfies(runDir, p, minBytes)) missing.push(p);
      }
    } else {
      // any-of: at least ONE path must satisfy.
      const anyOk = req.paths.some((p) => pathSatisfies(runDir, p, minBytes));
      if (!anyOk) {
        // Report the full any-of set (first path is the "preferred" one,
        // but the caller needs to see every candidate for the owner map).
        for (const p of req.paths) missing.push(p);
      }
    }
  }
  return missing;
}

/**
 * Returns true when the given relative path (under runDir) exists, is non-empty
 * by the size threshold, and is not a JSON error-stub. Supports trailing `/*`
 * glob (e.g. `phase4/adrs/*.md`) — the directory must exist and contain at
 * least one matching file that passes the criteria.
 */
function pathSatisfies(runDir: string, relPath: string, minBytes: number): boolean {
  if (relPath.endsWith('/*.md') || relPath.endsWith('/*')) {
    return dirGlobSatisfies(runDir, relPath, minBytes);
  }
  const abs = path.join(runDir, relPath);
  return fileSatisfies(abs, minBytes);
}

function fileSatisfies(abs: string, minBytes: number): boolean {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(abs);
  } catch {
    return false;
  }
  if (!stat.isFile()) return false;
  if (stat.size < minBytes) return false;

  // Read up to the stub-scan window for the error-stub shape check.
  let contentSlice = '';
  try {
    const fd = fs.openSync(abs, 'r');
    try {
      const buf = Buffer.alloc(Math.min(STUB_SCAN_BYTES, stat.size));
      fs.readSync(fd, buf, 0, buf.length, 0);
      contentSlice = buf.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
  return isNotErrorStub(contentSlice);
}

function dirGlobSatisfies(runDir: string, relPath: string, minBytes: number): boolean {
  // Support `<dir>/*.ext` and `<dir>/*`. Anything more exotic is rejected.
  const dirRel = relPath.replace(/\/\*(\.[a-zA-Z0-9]+)?$/, '');
  const extMatch = relPath.match(/\/\*(\.[a-zA-Z0-9]+)$/);
  const ext = extMatch?.[1];
  const dirAbs = path.join(runDir, dirRel);

  let entries: string[];
  try {
    entries = fs.readdirSync(dirAbs);
  } catch {
    return false;
  }
  const candidates = ext ? entries.filter((e) => e.endsWith(ext)) : entries;
  return candidates.some((e) => fileSatisfies(path.join(dirAbs, e), minBytes));
}

/** Returns the owning PhaseId for the given relative path, or null. */
function resolveOwner(relPath: string): PhaseId | null {
  // Longest matching prefix wins.
  let bestKey = '';
  let bestOwner: PhaseId | null = null;
  for (const [key, owner] of Object.entries(INPUT_OWNER_MAP)) {
    if (relPath === key || relPath.startsWith(key)) {
      if (key.length > bestKey.length) {
        bestKey = key;
        bestOwner = owner;
      }
    }
  }
  return bestOwner;
}
