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

/**
 * ADR-PIPELINE-094 Decision 5 — per-input check entry in `gate-decision-log.json`.
 * Captures both the logical path declared in `PHASE_DEPENDENCIES` and the
 * physical path the gate actually inspected (after `resolvePhasePath`). The
 * pair is the smoking gun for path-resolution defects like the originating
 * `4ed715bf` cascade.
 */
export interface CheckedInput {
  /** Path as declared in PHASE_DEPENDENCIES (logical/relative). */
  readonly logical_path: string;
  /** Absolute path the gate inspected on disk. */
  readonly resolved_path: string;
  readonly exists: boolean;
  readonly size_bytes: number;
  readonly is_error_stub: boolean;
  readonly satisfies: boolean;
}

/**
 * ADR-PIPELINE-094 Decision 5 — Ruflo-invocation entry in
 * `gate-decision-log.json`. Mirrors the executor's tier and reason fields
 * so downstream RCA tools can read provenance without parsing log lines.
 */
export interface RufloInvocationLog {
  readonly phase: PhaseId;
  readonly tier: string;
  readonly reason: string;
}

/**
 * ADR-PIPELINE-094 Decision 5 — machine-readable per-phase gate decision.
 * Written to `<runDir>/<phaseDirname>/gate-decision-log.json` for every
 * gate invocation. Replaces text-only `[GATE]` log lines as the source of
 * truth for the `agentics-status` MCP tool and post-run RCA.
 */
export interface GateDecisionLog {
  readonly phaseId: PhaseId;
  readonly trace_id: string;
  readonly timestamp: string;
  readonly checked_inputs: ReadonlyArray<CheckedInput>;
  readonly ruflo_invoked: ReadonlyArray<RufloInvocationLog>;
  readonly verdict: 'ok' | 'blocked';
  readonly still_missing: ReadonlyArray<string>;
  readonly decision_ms: number;
}

/**
 * ADR-PIPELINE-094 Decision 5 — maps gate `PhaseId` to the per-phase output
 * directory under `runDir`. Used to write `gate-decision-log.json` to the
 * canonical location the auto-chain coordinator writes its other artifacts
 * to. Phase 5a/5b compose into the parent `phase5/` tree but get their own
 * subdir so the log file does not collide.
 */
export const PHASE_DIRNAME: Readonly<Record<PhaseId, string>> = {
  phase2: 'phase2',
  'phase3-sparc': 'phase3',
  'phase4-adrs-ddd': 'phase4',
  'phase5a-prompts': 'phase5a',
  'phase5b-scaffold': 'phase5b',
};

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
          // ADR-PIPELINE-094 Decision 2 — Phase-1 fallback: when no SPARC chain
          // exists, the prompt generator runs off Phase-1 simulator consensus.
          'phase1/decision-memo.md',
        ],
      },
      {
        kind: 'any-of',
        paths: [
          'phase4/adrs/*.md',
          'phase4/ddd/bounded-contexts.json',
          'engineering/architecture-decisions.md',
          // ADR-PIPELINE-094 Decision 2 — Phase-1 fallback: scenario.json and
          // decision-memo.md from Phase 1 are the always-present consensus
          // outputs we can always degrade to.
          'phase1/decision-memo.md',
          'phase1/scenario.json',
        ],
      },
    ],
    optional: [],
  },
  'phase5b-scaffold': {
    phaseId: 'phase5b-scaffold',
    required: [
      { kind: 'file', paths: ['phase1/manifest.json'] },
      // ADR-PIPELINE-094 Decision 3 — Phase 5b hard-blocks on the Phase 5a
      // execution plan. Without a concrete unit-of-work the build phase has
      // nothing to do and previously fanned out ~76 cloud agents that all
      // timed out. minBytes:50 keeps the threshold below MIN_BYTES_DEFAULT
      // because a minimal valid execution-plan.json with one entry is small.
      { kind: 'file', paths: ['phase5a/execution-plan.json'], minBytes: 50 },
    ],
    optional: ['phase4/adrs/*.md'],
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
  const tStart = Date.now();
  const dep = PHASE_DEPENDENCIES[phaseId];
  const maxRetries = opts.maxRetriesPerInput ?? 1;
  const runPrimary = opts.runPrimaryPhaseExecution ?? runPrimaryPhaseExecutionImpl;
  const traceId = opts.dossier.traceId ?? 'unknown';

  // ADR-094 Decision 5 — accumulate the rich invocation log for
  // gate-decision-log.json. Ruflo invocations get one entry per attempt with
  // tier and reason, even when the attempt succeeded.
  const rufloLog: RufloInvocationLog[] = [];
  const finalize = (
    verdict: 'ok' | 'blocked',
    initialChecks: CheckedInput[],
    finalChecks: CheckedInput[],
    stillMissing: string[],
  ): void => {
    // Prefer the second pass when Ruflo was invoked — it reflects the gate's
    // final decision. Otherwise the first pass is the only check we did.
    const checked = finalChecks.length > 0 ? finalChecks : initialChecks;
    writeGateDecisionLog(opts.runDir, {
      phaseId,
      trace_id: traceId,
      timestamp: new Date().toISOString(),
      checked_inputs: checked,
      ruflo_invoked: rufloLog,
      verdict,
      still_missing: stillMissing,
      decision_ms: Date.now() - tStart,
    });
  };

  // First pass — collect failures and per-input details.
  const firstPass = collectMissingPathsWithDetail(opts.runDir, dep.required);
  if (firstPass.missing.length === 0) {
    finalize('ok', firstPass.checked, [], []);
    return { ok: true, missing: [], ruflo_invoked: [], stillMissing: [] };
  }

  // Determine which upstream phases own the failed inputs.
  const upstreamPhases = new Set<PhaseId>();
  for (const failedPath of firstPass.missing) {
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

    const missingForOwner = firstPass.missing.filter(
      (p) => resolveOwner(p) === upstream,
    );
    for (const p of missingForOwner) {
      process.stderr.write(
        `[GATE] ${phaseId}: missing ${p} — invoking Ruflo (${upstream})\n`,
      );
    }

    try {
      const result: PrimaryPhaseExecutionResult = await runPrimary(
        upstream as unknown as Parameters<typeof runPrimaryPhaseExecutionImpl>[0],
        opts.dossier,
        opts.context,
      );
      rufloLog.push({
        phase: upstream,
        tier: String(result.executionTier ?? 'unknown'),
        reason: String(result.reason ?? (result.success ? 'ok' : 'unknown')),
      });
      if (result.executionTier === 'unavailable') {
        process.stderr.write(
          `[GATE] ${phaseId}: Ruflo unavailable (${upstream}) — reason=${result.reason ?? 'unknown'}\n`,
        );
      }
    } catch (err) {
      const msg = (err as Error).message;
      rufloLog.push({ phase: upstream, tier: 'error', reason: msg });
      process.stderr.write(
        `[GATE] ${phaseId}: Ruflo threw for ${upstream} — ${msg}\n`,
      );
    }
  }

  // Re-check after all Ruflo invocations have (had a chance to) run.
  const secondPass = collectMissingPathsWithDetail(opts.runDir, dep.required);

  if (secondPass.missing.length === 0) {
    process.stderr.write(`[GATE] ${phaseId}: recovered via Ruflo\n`);
    finalize('ok', firstPass.checked, secondPass.checked, []);
    return {
      ok: true,
      missing: firstPass.missing,
      ruflo_invoked: invoked,
      stillMissing: [],
    };
  }

  process.stderr.write(
    `[GATE] ${phaseId}: still blocked — ${secondPass.missing.join(', ')}\n`,
  );
  finalize('blocked', firstPass.checked, secondPass.checked, secondPass.missing);
  return {
    ok: false,
    missing: firstPass.missing,
    ruflo_invoked: invoked,
    stillMissing: secondPass.missing,
  };
}

// ============================================================================
// Path-reality resolution (ADR-PIPELINE-094 Decision 1)
// ============================================================================

/**
 * Resolves a logical phase path (as declared in `PHASE_DEPENDENCIES`) to one
 * or more absolute candidate paths under `runDir`, in priority order.
 *
 * Phase 1 writes its outputs flat to `<runDir>/<file>` (see
 * `swarm-orchestrator.ts:1831,2222,2229,2249,2252`), but the gate's
 * dependency table refers to them with a `phase1/` prefix for dependency-DAG
 * clarity. Pre-094 the gate joined the relative path to `runDir` literally
 * and looked at `<runDir>/phase1/<file>`, which never exists in production —
 * the false-negative cascade documented in the originating run.
 *
 * Resolution rules:
 *   - `phase1/X` → first try `<runDir>/X` (production, flat layout); if the
 *     caller's existence check fails there, fall through to
 *     `<runDir>/phase1/X` (test fixtures and any future subdir layout).
 *   - All other prefixes resolve unchanged: `<runDir>/<relPath>`.
 *
 * Returns at least one candidate. Callers iterate in order and accept the
 * first candidate that satisfies their predicate.
 *
 * Exported for unit tests and for any future code that needs to resolve a
 * declared dependency path to its physical location. This is the SINGLE place
 * the logical→physical mapping lives.
 */
export function resolvePhasePath(runDir: string, relPath: string): string[] {
  const phase1Match = /^phase1\/(.+)$/.exec(relPath);
  if (phase1Match) {
    const tail = phase1Match[1]!;
    return [
      path.join(runDir, tail),            // flat layout (production default)
      path.join(runDir, 'phase1', tail),  // subdir layout (legacy / fixtures)
    ];
  }
  return [path.join(runDir, relPath)];
}

// ============================================================================
// Internal helpers
// ============================================================================

/** First 512 bytes is enough to spot JSON error-stub shape. */
const STUB_SCAN_BYTES = 512;

/**
 * Returns both the list of missing logical paths AND a per-input check log
 * suitable for `gate-decision-log.json` (ADR-094 Decision 5). Callers that
 * only need the verdict use `result.missing`; callers that emit the
 * decision log consume `result.checked`.
 */
function collectMissingPathsWithDetail(
  runDir: string,
  required: ReadonlyArray<RequiredInput>,
): { missing: string[]; checked: CheckedInput[] } {
  const missing: string[] = [];
  const checked: CheckedInput[] = [];
  for (const req of required) {
    const minBytes = req.minBytes ?? MIN_BYTES_DEFAULT;
    if (req.kind === 'file') {
      // ALL paths must satisfy the criteria.
      for (const p of req.paths) {
        const detail = inspectPath(runDir, p, minBytes);
        checked.push(detail);
        if (!detail.satisfies) missing.push(p);
      }
    } else {
      // any-of: at least ONE path must satisfy.
      const details = req.paths.map((p) => inspectPath(runDir, p, minBytes));
      checked.push(...details);
      const anyOk = details.some((d) => d.satisfies);
      if (!anyOk) {
        // Report the full any-of set so the caller can map each candidate
        // back to its owning upstream phase via `INPUT_OWNER_MAP`.
        for (const p of req.paths) missing.push(p);
      }
    }
  }
  return { missing, checked };
}

/**
 * ADR-PIPELINE-094 Decision 5 — populated single-path inspection for the log.
 * Returns the FIRST satisfying candidate's metadata; if none satisfy, returns
 * the metadata of the first candidate (the production-default path) so the
 * log surfaces the resolved path the user expects to see in their layout.
 */
function inspectPath(runDir: string, relPath: string, minBytes: number): CheckedInput {
  if (relPath.endsWith('/*.md') || relPath.endsWith('/*')) {
    // Glob form: detail collapses to "did the glob match anything".
    return {
      logical_path: relPath,
      resolved_path: path.join(runDir, relPath),
      exists: false,  // not strictly meaningful for globs; we only report satisfies
      size_bytes: 0,
      is_error_stub: false,
      satisfies: dirGlobSatisfies(runDir, relPath, minBytes),
    };
  }
  const candidates = resolvePhasePath(runDir, relPath);
  // Prefer the first candidate that satisfies; otherwise return detail for
  // the first candidate (the production-default location).
  let firstFound: CheckedInput | null = null;
  for (const abs of candidates) {
    const detail = inspectFile(abs, minBytes, relPath);
    if (detail.satisfies) return detail;
    if (firstFound === null) firstFound = detail;
  }
  return firstFound!;
}

function inspectFile(abs: string, minBytes: number, logicalPath: string): CheckedInput {
  let stat: fs.Stats | null = null;
  try {
    stat = fs.statSync(abs);
  } catch {
    return {
      logical_path: logicalPath,
      resolved_path: abs,
      exists: false,
      size_bytes: 0,
      is_error_stub: false,
      satisfies: false,
    };
  }
  if (!stat.isFile()) {
    return {
      logical_path: logicalPath,
      resolved_path: abs,
      exists: true,
      size_bytes: stat.size,
      is_error_stub: false,
      satisfies: false,
    };
  }
  if (stat.size < minBytes) {
    return {
      logical_path: logicalPath,
      resolved_path: abs,
      exists: true,
      size_bytes: stat.size,
      is_error_stub: false,
      satisfies: false,
    };
  }
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
    return {
      logical_path: logicalPath,
      resolved_path: abs,
      exists: true,
      size_bytes: stat.size,
      is_error_stub: false,
      satisfies: false,
    };
  }
  const stub = !isNotErrorStub(contentSlice);
  return {
    logical_path: logicalPath,
    resolved_path: abs,
    exists: true,
    size_bytes: stat.size,
    is_error_stub: stub,
    satisfies: !stub,
  };
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

  // ADR-094 Decision 1: route directory resolution through resolvePhasePath
  // so any phase-prefix layout aliasing applies to globs too. For phase1/*
  // patterns the candidates are `<runDir>/<tail>` and `<runDir>/phase1/<tail>`;
  // for other prefixes there's only one candidate.
  for (const dirAbs of resolvePhasePath(runDir, dirRel)) {
    let entries: string[];
    try {
      entries = fs.readdirSync(dirAbs);
    } catch {
      continue;
    }
    const candidates = ext ? entries.filter((e) => e.endsWith(ext)) : entries;
    if (candidates.some((e) => fileSatisfies(path.join(dirAbs, e), minBytes))) {
      return true;
    }
  }
  return false;
}

// ============================================================================
// Gate decision log writer (ADR-PIPELINE-094 Decision 5)
// ============================================================================

/**
 * Writes `<runDir>/<phaseDirname>/gate-decision-log.json` for the given
 * decision. Best-effort: never throws; on filesystem error, logs to stderr
 * and returns. The text `[GATE]` log lines continue alongside this for
 * human readability — the JSON is the machine-readable surface.
 *
 * Exported for unit tests. Production callers go through `gatePhaseInputs`
 * which invokes this internally after computing its verdict.
 */
export function writeGateDecisionLog(
  runDir: string,
  log: GateDecisionLog,
): void {
  try {
    const dirname = PHASE_DIRNAME[log.phaseId];
    const phaseDir = path.join(runDir, dirname);
    fs.mkdirSync(phaseDir, { recursive: true });
    const target = path.join(phaseDir, 'gate-decision-log.json');
    // Pretty-print for human grep-ability in log dumps; the file is small.
    fs.writeFileSync(target, JSON.stringify(log, null, 2) + '\n', 'utf8');
  } catch (err) {
    process.stderr.write(
      `[GATE] ${log.phaseId}: failed to write gate-decision-log.json — ${(err as Error).message}\n`,
    );
  }
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
