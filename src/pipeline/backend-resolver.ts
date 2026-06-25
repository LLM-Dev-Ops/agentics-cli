/**
 * Backend Resolver — ADR-PIPELINE-112 (D2 + D3)
 *
 * Single source of truth for which LLM backend the pipeline's synthesis phases
 * use. Every phase that invokes an LLM to generate engineering artifacts
 * (SPARC, ADRs, DDD, TDD, implementation prompts, Phase 7 deliverables) MUST
 * resolve its backend through `resolveBackend()` rather than re-implementing
 * its own availability probe. This ends the per-phase divergent-resolver
 * problem and guarantees one cached decision per pipeline run.
 *
 * Resolution order (first available wins), per ADR-PIPELINE-112 §D2:
 *   1. ruflo        — local swarm bound to Claude Code / Codex (`--local-only`)
 *   2. claude-print — `claude --print`, same Claude Code subscription session
 *   3. codex        — OpenAI Codex CLI alternative
 *   4. none         — loud failure (ADR-PIPELINE-116); NO template fallback
 *
 * There is deliberately NO raw `ANTHROPIC_API_KEY` tier. ADR-PIPELINE-112 §D1
 * removed the raw-API transport entirely: cost stays inside the user's
 * subscription, the model version follows the user's session, and there is no
 * long-lived credential to leak.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { resolveRuflo } from './ruflo-resolver.js';
import { resolveClaudeBinary } from '../runtime/claude-code-runner.js';

const execFileAsync = promisify(execFile);

/** Per-binary `--version` probe budget. Keeps total resolution well under the
 * ADR-PIPELINE-112 p95 < 200ms target even when every tier is probed. */
const PROBE_TIMEOUT_MS = 5_000;

export interface BackendResolution {
  tier: 'ruflo' | 'claude-print' | 'codex' | 'none';
  binaryPath: string | null;
  /** Logged in the manifest; surfaced in the ADR-PIPELINE-116 loud-failure artifact. */
  reason: string;
}

/**
 * Module-scoped memo. `resolveBackend()` is intended to run once per pipeline
 * process; subsequent calls return the cached decision so downstream phase
 * coordinators read a stable result instead of re-detecting (ADR-PIPELINE-112
 * §D2: "the chain is evaluated once per pipeline run and the result is cached").
 */
let cached: BackendResolution | null = null;

/** Locate an executable on PATH, honouring platform lookup tooling. Returns the
 * resolved absolute path or null when the binary is not found. */
async function whichBinary(candidate: string): Promise<string | null> {
  const lookup = process.platform === 'win32' ? 'where' : 'which';
  try {
    const { stdout } = await execFileAsync(lookup, [candidate], {
      timeout: PROBE_TIMEOUT_MS,
      encoding: 'utf-8',
    });
    const first = stdout.trim().split(/\r?\n/)[0]?.trim();
    return first || null;
  } catch {
    return null;
  }
}

/** Validate a candidate by running `<bin> --version`. Returns true only when the
 * subprocess exits cleanly, confirming the binary is real and runnable (not a
 * dangling symlink or a name collision). */
async function validateVersion(binaryPath: string): Promise<boolean> {
  try {
    await execFileAsync(binaryPath, ['--version'], {
      timeout: PROBE_TIMEOUT_MS,
      encoding: 'utf-8',
    });
    return true;
  } catch {
    return false;
  }
}

/** Resolve a candidate binary: PATH probe + `--version` validation. */
async function resolveCandidate(candidate: string): Promise<string | null> {
  const found = await whichBinary(candidate);
  if (!found) return null;
  return (await validateVersion(found)) ? found : null;
}

// ADR-113: tier-1 (ruflo) detection delegates to the shared, PATH-independent
// `ruflo-resolver.ts` module — the single source of truth shared with the
// auto-chain availability gate and the phase executor. It hardens detection for
// the Claude Code stripped-PATH case (nvm-current / nvm-absolute fallbacks) and
// records `--local-only` support in its `reason`. Returns the resolved binary
// path (or null) so this resolver's tier model is unchanged.
async function resolveRufloTier(): Promise<string | null> {
  const resolution = await resolveRuflo();
  return resolution.available ? resolution.binaryPath : null;
}

// ADR-114 §D5: tier-2 (claude --print) detection delegates to the canonical
// `resolveClaudeBinary()` in the hardened transport module — the single source
// of truth shared with the runner's `resolve()` and the ADR generator. It owns
// env-override handling (CLAUDE_CODE_BIN / AGENTICS_CLAUDE_BIN), the
// PATH-independent search, and `--version` validation. Returns the resolved
// binary path (or null) so this resolver's tier model is unchanged.
async function resolveClaudePrint(): Promise<string | null> {
  const resolution = await resolveClaudeBinary();
  return resolution.available ? resolution.binaryPath : null;
}

/** Codex CLI tier (ADR-PIPELINE-112 §D2 priority 3). Optional enhancement;
 * most environments fall through to `none`. */
async function resolveCodex(): Promise<string | null> {
  return resolveCandidate('codex');
}

/**
 * Resolve the active synthesis backend, evaluating tiers in priority order and
 * returning the first available. The result is memoised at module scope so the
 * chain is evaluated once per process (ADR-PIPELINE-112 §D2).
 */
export async function resolveBackend(): Promise<BackendResolution> {
  if (cached) return cached;

  const ruflo = await resolveRufloTier();
  if (ruflo) {
    cached = { tier: 'ruflo', binaryPath: ruflo, reason: `ruflo resolved at ${ruflo} (--version ok)` };
    return cached;
  }

  const claude = await resolveClaudePrint();
  if (claude) {
    cached = { tier: 'claude-print', binaryPath: claude, reason: `claude --print resolved at ${claude} (--version ok)` };
    return cached;
  }

  const codex = await resolveCodex();
  if (codex) {
    cached = { tier: 'codex', binaryPath: codex, reason: `codex resolved at ${codex} (--version ok)` };
    return cached;
  }

  cached = {
    tier: 'none',
    binaryPath: null,
    reason:
      'No subscription backend available: ruflo, claude --print, and codex all failed ' +
      'PATH/--version probes. Raw ANTHROPIC_API_KEY is not a supported fallback (ADR-PIPELINE-112 §D1).',
  };
  return cached;
}

/**
 * Reset the memoised resolution. Test-only seam — production code resolves once
 * per process and never resets. Exported so unit tests can exercise the chain
 * without leaking state between cases.
 */
export function __resetBackendResolutionCache(): void {
  cached = null;
}
