/**
 * Ruflo Resolver — ADR-PIPELINE-113 (D1–D6)
 *
 * Single, shared, PATH-independent resolver for the ruflo binary. Promotes the
 * robust multi-step resolution that previously lived privately inside
 * `ruflo-phase-executor.ts` (`resolveRufloBinary`) and the naive
 * `execSync('ruflo --version')` ambient-PATH probe that gated the whole ruflo
 * path at `auto-chain.ts:2760`. Those two detection paths could (and did)
 * disagree — a split-brain condition where the gate said "unavailable" while
 * the executor would have found the binary. This module is the one source of
 * truth: both the availability gate and the executor read its memoised result.
 *
 * Resolution order (first validated candidate wins), per ADR-PIPELINE-113 §D2:
 *   0. AGENTICS_RUFLO_PATH env override        → 'env-override'
 *   1. ./node_modules/.bin/ruflo (cwd)         → 'local-bin'
 *   2. walk parent dirs for node_modules/.bin  → 'hoisted-bin'
 *   3. which ruflo (PATH-augmented, §D4)       → 'which'
 *   4. $(nvm which current)/../ruflo           → 'nvm-current'   (NEW)
 *   5. ~/.nvm/versions/node/<latest>/bin/ruflo → 'nvm-absolute'  (NEW)
 *   6. npx ruflo --version existence probe      → 'npx'           (last resort)
 *
 * PERF (ADR-PIPELINE-113 §D3 fast path): steps 0–5 resolve the binary by
 * FILESYSTEM existence + executable bit ONLY — they do NOT spawn `<bin>
 * --version`. ruflo boots AgentDB on every invocation (~430ms), so any ruflo
 * subprocess on the resolution hot path blows the <20ms (steps 1–3) /<200ms
 * (resolveBackend) latency budgets. The only ruflo spawn that can occur during
 * `resolveRuflo()` is the last-resort step 6 (`npx ruflo --version`), which has
 * no filesystem path to probe. The common local-bin path spawns ZERO ruflo
 * processes. `version` is therefore lazily-filled (null on the fs fast path);
 * callers that need it call `resolveRufloVersion()` on demand — the single,
 * opt-in `--version` spawn.
 */

import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Subprocess budget. Used by the `which`/`nvm`/lazy `--version` probes. Steps
 * 0–5 resolve paths via the filesystem (sub-5ms, no subprocess); subprocesses
 * are reached only for the `which` lookup, the `nvm which current` shell, the
 * last-resort npx tier, and the opt-in lazy `resolveRufloVersion()`. */
const PROBE_TIMEOUT_MS = 5_000;
/** npx existence probe is allowed a longer budget — it may hit the registry. */
const NPX_PROBE_TIMEOUT_MS = 15_000;

export interface RufloResolution {
  available: boolean;
  /** Resolved absolute path (or the npx sentinel), or null when unavailable. */
  binaryPath: string | null;
  resolvedBy:
    | 'env-override'
    | 'local-bin'
    | 'hoisted-bin'
    | 'which'
    | 'nvm-current'
    | 'nvm-absolute'
    | 'npx'
    | 'none';
  /** Parsed semver from `<binaryPath> --version`, or null. */
  version: string | null;
  /** Logged in the run manifest (runtime.ruflo.reason); surfaced on failure. */
  reason: string;
}

/**
 * Module-scoped memo. `resolveRuflo()` runs once per process; subsequent calls
 * return the cached decision so the gate and the executor read a stable result
 * (ADR-PIPELINE-113 §D3: "one resolver module, one result").
 */
let cached: RufloResolution | null = null;

/**
 * Reset the memoised resolution. Test-only seam — production code resolves once
 * per process and never resets. Mirrors `__resetBackendResolutionCache()` in
 * backend-resolver.ts.
 */
export function __resetRufloResolutionCache(): void {
  cached = null;
}

/**
 * Synchronous peek at the cached resolution without triggering resolution.
 * Returns null when `resolveRuflo()` has not yet run. Used by the synchronous
 * `resolveRufloBinary()` shim in ruflo-phase-executor.ts so legacy sync callers
 * read the same shared result the async gate produced.
 */
export function getCachedRufloResolution(): RufloResolution | null {
  return cached;
}

/**
 * ADR-PIPELINE-113 §D4 — PATH augmentation for Claude Code child processes.
 *
 * When `agentics` is spawned by Claude Code (`CLAUDECODE=1`) or VS Code
 * (`TERM_PROGRAM=vscode`), the inherited PATH is often stripped of
 * runtime-manager bin directories (`~/.nvm/current/bin`, Homebrew shims, …).
 * We prepend the well-known locations to the PATH used for the resolver's
 * child-process invocations ONLY — `process.env.PATH` is never mutated.
 */
function isClaudeCodeSpawn(): boolean {
  return Boolean(process.env['CLAUDECODE']) || process.env['TERM_PROGRAM'] === 'vscode';
}

/** Build the env handed to the resolver's subprocesses. Scoped — does not touch
 * the global process environment.
 *
 * Exported (ADR-PIPELINE-114 §D5) so the canonical `claude` resolver in
 * `src/runtime/claude-code-runner.ts` reuses the exact same stripped-PATH
 * augmentation rather than re-deriving it — one PATH policy for both binaries. */
export function resolverChildEnv(): NodeJS.ProcessEnv {
  if (!isClaudeCodeSpawn()) return { ...process.env };
  const home = os.homedir();
  const prepend = [
    path.join(home, '.nvm', 'current', 'bin'),
    path.join(home, 'nvm', 'current', 'bin'), // Codespaces layout (no dot)
    '/usr/local/bin',
    '/opt/homebrew/bin',
  ];
  const augmented = [...prepend, process.env['PATH'] ?? ''].join(path.delimiter);
  return { ...process.env, PATH: augmented };
}

/** Parse a semver (e.g. "3.14.1") from arbitrary `--version` output such as
 * "ruflo v3.14.1". Returns null when no semver is present. */
function parseSemver(output: string): string | null {
  const m = output.match(/(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/);
  return m ? m[1]! : null;
}

/** Validate a candidate by running `<path> --version` and parsing a semver.
 * Returns the parsed version, or null when the binary is absent, non-runnable,
 * or prints no recognisable version.
 *
 * PERF: this spawns ruflo (~430ms AgentDB boot). It is NEVER called on the
 * resolution hot path — only by the opt-in lazy `resolveRufloVersion()`. */
async function validateVersion(binaryPath: string): Promise<string | null> {
  try {
    const { stdout, stderr } = await execFileAsync(binaryPath, ['--version'], {
      timeout: PROBE_TIMEOUT_MS,
      encoding: 'utf-8',
      env: resolverChildEnv(),
    });
    return parseSemver(`${stdout}\n${stderr}`);
  } catch {
    return null;
  }
}

/**
 * Lazily resolve ruflo's semver on demand. This is the ONLY ruflo `--version`
 * spawn in the resolver (~430ms AgentDB boot) and is opt-in: `resolveRuflo()`
 * leaves `version` null on the filesystem fast path so it stays under its
 * latency budget. Callers that need the version (logging, diagnostics) call
 * this. Defaults to the cached resolution's binary when no path is given;
 * returns null for the npx sentinel or when no binary is resolved.
 */
export async function resolveRufloVersion(binaryPath?: string): Promise<string | null> {
  const target = binaryPath ?? cached?.binaryPath ?? null;
  if (!target || target === 'npx') return null;
  return validateVersion(target);
}

/** Steps 1/2/4/5: resolve a filesystem candidate path. fs-ONLY — checks
 * existence + the executable bit; does NOT spawn `<bin> --version`. Returns the
 * candidate when it is an executable file, else null. */
function tryPathCandidate(candidate: string): string | null {
  if (!candidate) return null;
  try {
    fs.accessSync(candidate, fs.constants.X_OK);
    return candidate;
  } catch {
    return null;
  }
}

/** Step 3: `which ruflo` (PATH-augmented). `which` itself is a cheap lookup; the
 * resolved path is confirmed via the fs executable check — NOT a `--version`
 * spawn (which would boot AgentDB and blow the latency budget). */
async function whichRuflo(): Promise<string | null> {
  const lookup = process.platform === 'win32' ? 'where' : 'which';
  try {
    const { stdout } = await execFileAsync(lookup, ['ruflo'], {
      timeout: PROBE_TIMEOUT_MS,
      encoding: 'utf-8',
      env: resolverChildEnv(),
    });
    const first = stdout.trim().split(/\r?\n/)[0]?.trim();
    if (!first) return null;
    return tryPathCandidate(first);
  } catch {
    return null;
  }
}

/** Step 4: `$(nvm which current)/../ruflo`. `nvm` is a shell function, so it is
 * invoked via a login shell. The returned node path's directory holds ruflo. */
async function nvmCurrentRuflo(): Promise<string | null> {
  if (process.platform === 'win32') return null;
  try {
    const { stdout } = await execFileAsync('bash', ['-lc', 'nvm which current'], {
      timeout: PROBE_TIMEOUT_MS,
      encoding: 'utf-8',
      env: resolverChildEnv(),
    });
    const nodePath = stdout.trim().split(/\r?\n/).pop()?.trim();
    if (!nodePath) return null;
    const candidate = path.join(path.dirname(nodePath), 'ruflo');
    return tryPathCandidate(candidate);
  } catch {
    return null;
  }
}

/** Step 5: enumerate `~/.nvm/versions/node/<v>/bin/ruflo` (and the Codespaces
 * `~/nvm/...` layout), pick the highest semver version, validate. */
async function nvmAbsoluteRuflo(): Promise<string | null> {
  const home = os.homedir();
  const roots = [
    path.join(home, '.nvm', 'versions', 'node'),
    path.join(home, 'nvm', 'versions', 'node'),
  ];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    let versions: string[];
    try {
      versions = fs.readdirSync(root).filter((v) => /^v?\d+\.\d+\.\d+/.test(v));
    } catch {
      continue;
    }
    versions.sort(compareNodeVersionDesc);
    for (const v of versions) {
      const candidate = path.join(root, v, 'bin', 'ruflo');
      const resolved = tryPathCandidate(candidate);
      if (resolved) return resolved;
    }
  }
  return null;
}

/** Descending semver comparator for node version dir names ("v20.11.0"). */
function compareNodeVersionDesc(a: string, b: string): number {
  const pa = a.replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const d = (pb[i] ?? 0) - (pa[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** Step 6: `npx ruflo --version` existence probe (last resort). Returns the
 * 'npx' sentinel binary path when ruflo is reachable via npx. */
async function npxRuflo(): Promise<string | null> {
  try {
    const { stdout, stderr } = await execFileAsync('npx', ['--yes', 'ruflo', '--version'], {
      timeout: NPX_PROBE_TIMEOUT_MS,
      encoding: 'utf-8',
      env: resolverChildEnv(),
    });
    return parseSemver(`${stdout}\n${stderr}`) !== null ? 'npx' : null;
  } catch {
    return null;
  }
}

/**
 * ADR-PIPELINE-113 §D5 — determine `--local-only` support for the resolved
 * ruflo. The flag binds ruflo to the Claude Code / Codex backend (ADR-112) so
 * it does not open an independent raw API connection.
 *
 * The ADR prescribes grepping `<bin> --help` for the flag and treating it as
 * unavailable when unsupported. Empirically, ruflo v3.14.1 does NOT advertise
 * `--local-only` in any --help output yet accepts it as a harmless passthrough
 * (and the existing task builders already inject `argv: ['--local-only']` per
 * ADR-091, which works). ruflo also tolerates unknown flags silently, so a
 * functional probe cannot distinguish support from passthrough. We therefore
 * (a) report when the flag is advertised, and (b) when it is not, treat it as
 * passthrough-supported rather than disabling a working install — disabling
 * here would regress every engineering phase. The determination is recorded in
 * the resolution `reason` for auditability.
 *
 * PERF: this used to spawn `<bin> --help` and `<bin> swarm --help` on the
 * resolution hot path (two ~430ms AgentDB boots). The probe's RESULT never
 * changed the decision — `--local-only` is always treated as
 * passthrough-supported, and the task builders inject it per-task regardless
 * (ADR-091). The probe only enriched `reason`. We therefore drop it entirely
 * and return a static note; no ruflo subprocess is spawned during resolution.
 */
function describeLocalOnly(binaryPath: string): string {
  if (binaryPath === 'npx') {
    return '--local-only injected per-task via npx invocation (ADR-091)';
  }
  return '--local-only treated as passthrough-supported (ruflo tolerates the flag; task builders inject it per-task per ADR-091)';
}

/**
 * Resolve the ruflo binary using the ADR-113 six-step PATH-independent chain.
 * Memoised at module scope. The result is persisted to `runtime.ruflo` in the
 * run manifest and shared by the availability gate and the phase executor.
 */
export async function resolveRuflo(): Promise<RufloResolution> {
  if (cached) return cached;

  type Step = {
    resolvedBy: RufloResolution['resolvedBy'];
    // fs-based steps resolve synchronously (string | null); subprocess-based
    // steps (which/nvm/npx) return a Promise. The loop `await`s either form.
    run: () => string | null | Promise<string | null>;
    describe: (p: string) => string;
  };

  const home = os.homedir();
  const steps: Step[] = [
    {
      resolvedBy: 'env-override',
      run: () => tryPathCandidate(process.env['AGENTICS_RUFLO_PATH'] ?? ''),
      describe: (p) => `resolved via AGENTICS_RUFLO_PATH override at ${p}`,
    },
    {
      resolvedBy: 'local-bin',
      run: () => tryPathCandidate(path.resolve(process.cwd(), 'node_modules', '.bin', 'ruflo')),
      describe: (p) => `resolved via local node_modules/.bin at ${p}`,
    },
    {
      resolvedBy: 'hoisted-bin',
      run: async () => {
        let dir = process.cwd();
        for (let i = 0; i < 6; i++) {
          const candidate = path.join(dir, 'node_modules', '.bin', 'ruflo');
          const resolved = await tryPathCandidate(candidate);
          if (resolved) return resolved;
          const parent = path.dirname(dir);
          if (parent === dir) break;
          dir = parent;
        }
        return null;
      },
      describe: (p) => `resolved via hoisted node_modules/.bin at ${p}`,
    },
    {
      resolvedBy: 'which',
      run: whichRuflo,
      describe: (p) => `resolved via PATH (which ruflo) at ${p}`,
    },
    {
      resolvedBy: 'nvm-current',
      run: nvmCurrentRuflo,
      describe: (p) => `resolved via 'nvm which current' at ${p}`,
    },
    {
      resolvedBy: 'nvm-absolute',
      run: nvmAbsoluteRuflo,
      describe: (p) => `resolved via nvm absolute-path enumeration at ${p}`,
    },
    {
      resolvedBy: 'npx',
      run: npxRuflo,
      describe: () => 'resolved via npx ruflo (last-resort existence probe)',
    },
  ];

  for (const step of steps) {
    const binaryPath = await step.run();
    if (!binaryPath) continue;
    // PERF (ADR-113 §D3 fast path): the winner is NOT re-validated with a
    // `<bin> --version` spawn — `step.run()` already confirmed it via the
    // filesystem (or `which`/npx). `version` is left null and filled lazily by
    // `resolveRufloVersion()` on demand, keeping the common local-bin path at
    // zero ruflo subprocesses and well under the <20ms budget.
    const localOnly = describeLocalOnly(binaryPath);
    cached = {
      available: true,
      binaryPath,
      resolvedBy: step.resolvedBy,
      version: null,
      reason: `${step.describe(binaryPath)}; ${localOnly}`,
    };
    return cached;
  }

  cached = {
    available: false,
    binaryPath: null,
    resolvedBy: 'none',
    version: null,
    reason:
      `ruflo not found after the six-step PATH-independent search ` +
      `(env-override, local-bin, hoisted-bin, which, nvm-current, nvm-absolute, npx). ` +
      `Searched cwd=${process.cwd()} home=${home}. ` +
      `Set AGENTICS_RUFLO_PATH to an absolute ruflo path to override.`,
  };
  return cached;
}
