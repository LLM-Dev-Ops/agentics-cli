/**
 * MetaHarness Resolver — ADR-PIPELINE-117 (D1)
 *
 * Single, cached source of truth for how the pipeline reaches MetaHarness
 * capabilities (`score`, `genome`, `mcp-scan`, `threat-model`, `sbom`, …).
 * Structurally mirrors `backend-resolver.ts` (ADR-112/113): resolve once per
 * process, memoise the decision, and expose a `reason` string that downstream
 * gates surface on ADR-116 loud failure.
 *
 * Resolution order (first available wins), per ADR-117 §D1:
 *   1. mcp  — the ruflo / claude-flow MCP server exposes `metaharness_*` tools.
 *             The CLI process cannot introspect the host's MCP session, so this
 *             tier is selected only when explicitly signalled via
 *             AGENTICS_METAHARNESS_MCP (the host/orchestrator sets it when the
 *             MCP tools are available). Preferred: no subprocess spawn.
 *   2. cli  — `metaharness` binary (AGENTICS_METAHARNESS_BIN override or on PATH)
 *             or `npx metaharness`. Used headless / when MCP is absent.
 *   3. none — neither available. The dependent gate emits a loud-failure
 *             artifact (ADR-116); it never fabricates a score.
 *
 * PERF (ADR-117 §D5 / ADR-113 budget): resolution is filesystem/PATH probes
 * only — it NEVER spawns `metaharness <sub>` (which boots a heavy analysis) on
 * the hot path. A binary override is validated by fs existence + executable bit;
 * the npx tier is confirmed by the presence of `npx`, not by running it.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export interface MetaHarnessResolution {
  /** How MetaHarness capabilities are reached. */
  tier: 'mcp' | 'cli' | 'none';
  /** tier=cli: the executable to spawn (binary path or `npx`). Otherwise null. */
  command: string | null;
  /** tier=cli: argv prefix inserted before the subcommand (e.g. ['--yes','metaharness']). */
  argvPrefix: readonly string[];
  /** Logged in the run manifest (`metaharness.reason`); surfaced on loud failure. */
  reason: string;
}

/**
 * Module-scoped memo. `resolveMetaHarness()` runs once per process; subsequent
 * calls return the cached decision (ADR-117 §D1: "resolve once per run").
 */
let cached: MetaHarnessResolution | null = null;

/** Truthy-env helper — accepts 1/true/yes (case-insensitive). */
function envEnabled(name: string): boolean {
  const v = (process.env[name] ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

/** Whether a path exists and is a regular file (executable bit not required on
 * all platforms; presence + file is the fast-path signal). */
function isFile(p: string): boolean {
  try {
    const st = fs.statSync(p);
    return st.isFile() || st.isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Locate an executable on PATH via a pure filesystem scan — NO subprocess.
 * Mirrors `ruflo-resolver.ts`'s fast path so resolution stays sub-millisecond
 * (ADR-117 §D5 / ADR-113 budget): spawning `which` cost ~120ms per call on some
 * hosts, blowing the <200ms target that `resolveBackend` (fs-based) meets in
 * <1ms. Checks local `node_modules/.bin` first, then each `PATH` entry, honouring
 * Windows executable extensions.
 */
function findOnPath(candidate: string): string | null {
  const exts = process.platform === 'win32'
    ? (process.env['PATHEXT'] ?? '.EXE;.CMD;.BAT').split(';').filter(Boolean)
    : [''];
  const dirs: string[] = [
    path.join(process.cwd(), 'node_modules', '.bin'),
    ...(process.env['PATH'] ?? '').split(path.delimiter).filter(Boolean),
  ];
  for (const dir of dirs) {
    for (const ext of exts) {
      const p = path.join(dir, candidate + ext);
      if (isFile(p)) return p;
    }
  }
  return null;
}

/**
 * Resolve how MetaHarness is reached. Evaluated once per process; the result is
 * memoised. Static probes only — no MetaHarness subprocess is spawned here.
 */
export async function resolveMetaHarness(): Promise<MetaHarnessResolution> {
  if (cached) return cached;

  // Tier 1 — MCP (explicitly signalled; preferred, no subprocess).
  if (envEnabled('AGENTICS_METAHARNESS_MCP')) {
    cached = {
      tier: 'mcp',
      command: null,
      argvPrefix: [],
      reason: 'AGENTICS_METAHARNESS_MCP set — using the ruflo/claude-flow MCP metaharness_* tools',
    };
    return cached;
  }

  // Tier 2 — CLI: env override → PATH binary → npx.
  const override = process.env['AGENTICS_METAHARNESS_BIN']?.trim();
  if (override && isFile(override)) {
    cached = {
      tier: 'cli',
      command: override,
      argvPrefix: [],
      reason: `metaharness binary via AGENTICS_METAHARNESS_BIN at ${override}`,
    };
    return cached;
  }

  // Locate `metaharness` (preferred) then the `npx` shim via a pure fs PATH scan
  // — no subprocess, staying well within the ADR-117 §D5 <200ms budget.
  const onPath = findOnPath('metaharness');
  const npx = findOnPath('npx');
  if (onPath) {
    cached = {
      tier: 'cli',
      command: onPath,
      argvPrefix: [],
      reason: `metaharness resolved on PATH at ${onPath}`,
    };
    return cached;
  }
  if (npx) {
    cached = {
      tier: 'cli',
      command: npx,
      argvPrefix: ['--yes', 'metaharness'],
      reason: `metaharness reachable via ${npx} --yes metaharness`,
    };
    return cached;
  }

  // Tier 3 — none. Loud-failure territory (ADR-116) where a gate requires it.
  cached = {
    tier: 'none',
    command: null,
    argvPrefix: [],
    reason:
      'MetaHarness unavailable: no MCP signal (AGENTICS_METAHARNESS_MCP), no metaharness ' +
      'binary (AGENTICS_METAHARNESS_BIN / PATH), and no npx. Install metaharness or connect the ' +
      'ruflo MCP server (ADR-PIPELINE-117).',
  };
  return cached;
}

/**
 * Build the argv for a MetaHarness CLI subcommand from a resolution.
 * Returns null for non-CLI tiers. E.g. for `score`:
 *   { command: 'npx', args: ['--yes','metaharness','score', ...sub] }
 */
export function metaHarnessArgv(
  resolution: MetaHarnessResolution,
  sub: readonly string[],
): { command: string; args: string[] } | null {
  if (resolution.tier !== 'cli' || !resolution.command) return null;
  return { command: resolution.command, args: [...resolution.argvPrefix, ...sub] };
}

/**
 * Reset the memoised resolution. Test-only seam — production resolves once per
 * process and never resets. Mirrors `__resetBackendResolutionCache()`.
 */
export function __resetMetaHarnessResolutionCache(): void {
  cached = null;
}
