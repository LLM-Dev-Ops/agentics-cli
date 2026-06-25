/**
 * Codex Runner — ADR-PIPELINE-112 (D2 priority 3)
 *
 * Thin, hardened transport for the OpenAI Codex CLI, the tier-3 synthesis
 * fallback. The user requirement is that the pipeline works with "Claude Code
 * OR Codex": `resolveBackend()` can already return `tier:'codex'`, but until now
 * NO synthesis path actually invoked codex, so a codex-only environment silently
 * fell through to a loud failure. This module closes that gap.
 *
 * It mirrors the hardened `claude --print` transport in `claude-code-runner.ts`:
 *   - prompt delivered via STDIN (never argv → no ARG_MAX / E2BIG truncation)
 *   - stdout captured incrementally (partial output preserved on kill)
 *   - stderr forwarded live for diagnostics
 *   - idle bound + hard timeout with SIGTERM→SIGKILL escalation
 *
 * Codex is STRICTLY an additional fallback: it is reached only when ruflo and
 * `claude --print` are both unavailable. The ruflo/claude happy paths never call
 * into this module.
 *
 * NOTE: codex transport not live-validated in this env (no codex CLI installed).
 * We invoke the documented non-interactive `codex exec` subcommand reading the
 * prompt from STDIN. If the installed codex does not recognise this interface
 * the subprocess errors and we return a CLEAR error rather than guessing a
 * different flag and corrupting output.
 */

import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolverChildEnv } from '../pipeline/ruflo-resolver.js';

const CODEX_PROBE_TIMEOUT_MS = 5_000;
/** Default hard timeout for codex synthesis: 30 minutes (matches claude). */
const CODEX_DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
/** Upper bound for codex synthesis timeout: 60 minutes. */
const CODEX_MAX_TIMEOUT_MS = 60 * 60 * 1000;
const CODEX_MIN_TIMEOUT_MS = 5_000;

export interface CodexResolution {
  available: boolean;
  binaryPath: string | null;
  resolvedBy: 'env-override' | 'local-bin' | 'hoisted-bin' | 'which' | 'absolute-path' | 'none';
  reason: string;
}

/** Module-scoped memo — resolution runs once per process. */
let cachedCodexResolution: CodexResolution | null = null;

/** Reset the memoised codex resolution (test-only seam). */
export function __resetCodexResolutionCacheForTesting(): void {
  cachedCodexResolution = null;
}

function makeCodexResolution(
  available: boolean,
  binaryPath: string | null,
  resolvedBy: CodexResolution['resolvedBy'],
  reason: string,
): CodexResolution {
  return { available, binaryPath, resolvedBy, reason };
}

/** Confirm a candidate binary is runnable via `<bin> --version`. */
function validateCodexVersion(binaryPath: string): boolean {
  try {
    execFileSync(binaryPath, ['--version'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: CODEX_PROBE_TIMEOUT_MS,
      encoding: 'utf-8',
      env: resolverChildEnv(),
    });
    return true;
  } catch {
    return false;
  }
}

/** Raw `which codex` (PATH-augmented for stripped-PATH Claude Code spawns). */
function whichCodexRaw(name: string): string | null {
  const lookup = process.platform === 'win32' ? 'where' : 'which';
  try {
    const out = execFileSync(lookup, [name], {
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: CODEX_PROBE_TIMEOUT_MS,
      encoding: 'utf-8',
      env: resolverChildEnv(),
    });
    const first = out.trim().split(/\r?\n/)[0]?.trim();
    return first && first.length > 0 ? first : null;
  } catch {
    return null;
  }
}

/**
 * Resolve the `codex` binary. Mirrors `resolveClaudeBinary()`'s search order:
 * env override → local node_modules/.bin → hoisted node_modules/.bin → which →
 * absolute fallbacks. Each candidate is confirmed with `--version`. Memoised.
 */
export function resolveCodexBinary(): CodexResolution {
  if (cachedCodexResolution) return cachedCodexResolution;
  const home = os.homedir();

  // Step 0: explicit env override.
  const envVal = process.env['CODEX_BIN'] ?? process.env['AGENTICS_CODEX_BIN'];
  if (envVal && envVal.length > 0) {
    const candidate = existsSync(envVal) ? envVal : whichCodexRaw(envVal);
    if (candidate && validateCodexVersion(candidate)) {
      cachedCodexResolution = makeCodexResolution(true, candidate, 'env-override',
        `resolved via env override at ${candidate} (--version ok)`);
      return cachedCodexResolution;
    }
    cachedCodexResolution = makeCodexResolution(false, null, 'none',
      `codex env override "${envVal}" is not a runnable codex binary`);
    return cachedCodexResolution;
  }

  // Step 1: local node_modules/.bin/codex.
  {
    const candidate = path.resolve(process.cwd(), 'node_modules', '.bin', 'codex');
    if (existsSync(candidate) && validateCodexVersion(candidate)) {
      cachedCodexResolution = makeCodexResolution(true, candidate, 'local-bin',
        `resolved via local node_modules/.bin at ${candidate}`);
      return cachedCodexResolution;
    }
  }

  // Step 2: walk parent dirs for hoisted node_modules/.bin/codex.
  {
    let dir = process.cwd();
    for (let i = 0; i < 6; i++) {
      const candidate = path.join(dir, 'node_modules', '.bin', 'codex');
      if (existsSync(candidate) && validateCodexVersion(candidate)) {
        cachedCodexResolution = makeCodexResolution(true, candidate, 'hoisted-bin',
          `resolved via hoisted node_modules/.bin at ${candidate}`);
        return cachedCodexResolution;
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }

  // Step 3: which codex (PATH-augmented).
  {
    const found = whichCodexRaw('codex');
    if (found && validateCodexVersion(found)) {
      cachedCodexResolution = makeCodexResolution(true, found, 'which',
        `resolved via PATH (which codex) at ${found}`);
      return cachedCodexResolution;
    }
  }

  // Step 4: absolute fallbacks.
  const absoluteFallbacks = [
    '/usr/local/bin/codex',
    path.join(home, '.local', 'bin', 'codex'),
    '/opt/homebrew/bin/codex',
  ];
  for (const candidate of absoluteFallbacks) {
    if (existsSync(candidate) && validateCodexVersion(candidate)) {
      cachedCodexResolution = makeCodexResolution(true, candidate, 'absolute-path',
        `resolved via absolute fallback at ${candidate}`);
      return cachedCodexResolution;
    }
  }

  cachedCodexResolution = makeCodexResolution(false, null, 'none',
    `codex binary not found (env-override, local-bin, hoisted-bin, which, absolute-path). ` +
    `Set CODEX_BIN to an absolute codex path to override, or install the OpenAI Codex CLI.`);
  return cachedCodexResolution;
}

export interface GenerateCodexTextOptions {
  /** Hard timeout in ms (default 30 min, clamped to [5s, 60min]). */
  timeoutMs?: number;
  /** Correlation id for diagnostics. */
  runId?: string;
  /** Idle bound in ms — kill if no output for this long (default 60s). */
  idleBoundMs?: number;
  /** Heartbeat interval in ms for the progress line (default 10s). */
  heartbeatMs?: number;
  /** Label used in heartbeat / log lines. */
  label?: string;
}

function clampCodexTimeout(timeoutMs: number | undefined): number {
  if (timeoutMs === undefined || !Number.isFinite(timeoutMs)) return CODEX_DEFAULT_TIMEOUT_MS;
  return Math.max(CODEX_MIN_TIMEOUT_MS, Math.min(CODEX_MAX_TIMEOUT_MS, Math.floor(timeoutMs)));
}

interface CodexStreamResult {
  ok: boolean;
  killed: boolean;
  reason?: string;
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

/**
 * Spawn `codex exec -` with the prompt on STDIN, mirroring the hardened claude
 * transport (stdin delivery, live stderr, idle + hard timeout). `codex exec` is
 * the documented non-interactive mode; `-` requests the prompt from stdin.
 */
function runCodexExec(
  binary: string,
  prompt: string,
  timeoutMs: number,
  options: GenerateCodexTextOptions,
): Promise<CodexStreamResult> {
  const startMs = Date.now();
  const idleBoundMs = options.idleBoundMs ?? 60_000;
  const heartbeatMs = options.heartbeatMs ?? 10_000;
  const label = options.label ?? 'codex exec synthesis';

  return new Promise<CodexStreamResult>((resolve) => {
    let stdout = '';
    let stderr = '';
    let lastDataMs = Date.now();
    let killed = false;
    let killReason: string | undefined;

    // NOTE: codex transport not live-validated in this env (no codex CLI
    // installed). `codex exec -` is the documented non-interactive entry point
    // reading the prompt from stdin; an unrecognised interface surfaces as a
    // non-zero exit which we report verbatim (no flag-guessing fallback).
    const child = spawn(binary, ['exec', '-'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    process.stderr.write(
      `[codex-runner] Streaming ${label} (timeout=${Math.floor(timeoutMs / 1000)}s, ` +
      `idle=${Math.floor(idleBoundMs / 1000)}s, transport=stdin, prompt=${prompt.length}B)\n`,
    );

    try {
      child.stdin?.write(prompt, 'utf8');
      child.stdin?.end();
    } catch { /* stdin may already be closed on a spawn error */ }

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf-8');
      lastDataMs = Date.now();
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf-8');
      stderr += text;
      process.stderr.write(`[codex] ${text}`);
    });

    const heartbeat = setInterval(() => {
      const elapsedSec = Math.floor((Date.now() - startMs) / 1000);
      const idleSec = Math.floor((Date.now() - lastDataMs) / 1000);
      process.stderr.write(
        `[agentics] ⏳ ${label} — ${elapsedSec}s elapsed, ${stdout.length} bytes received, ${idleSec}s since last byte\n`,
      );
    }, heartbeatMs);

    const idleCheck = setInterval(() => {
      if (Date.now() - lastDataMs > idleBoundMs && !killed) {
        killed = true;
        killReason = `idle bound exceeded (no output for ${Math.floor((Date.now() - lastDataMs) / 1000)}s)`;
        process.stderr.write(`[codex-runner] Killing ${label}: ${killReason}\n`);
        try { child.kill('SIGTERM'); } catch { /* already dead */ }
      }
    }, Math.min(heartbeatMs, 5000));

    const hardTimeout = setTimeout(() => {
      if (!killed) {
        killed = true;
        killReason = `hard timeout exceeded (${Math.floor(timeoutMs / 1000)}s)`;
        process.stderr.write(`[codex-runner] Killing ${label}: ${killReason}\n`);
        try { child.kill('SIGTERM'); } catch { /* already dead */ }
        setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* already dead */ } }, 5000);
      }
    }, timeoutMs);

    const cleanup = () => {
      clearInterval(heartbeat);
      clearInterval(idleCheck);
      clearTimeout(hardTimeout);
    };

    child.on('error', (err: Error) => {
      cleanup();
      resolve({ ok: false, killed, reason: `spawn error: ${err.message}`, stdout, stderr, exitCode: null });
    });

    child.on('close', (code: number | null) => {
      cleanup();
      const ok = !killed && code === 0;
      resolve({
        ok,
        killed,
        reason: ok ? undefined : (killReason ?? `codex exec exited with code ${code}`),
        stdout,
        stderr,
        exitCode: code,
      });
    });
  });
}

/**
 * Free-form text synthesis via the Codex CLI (tier-3 fallback). Resolves the
 * codex binary, runs the hardened `codex exec` transport, and returns the
 * captured stdout. On any failure returns a CLEAR error string prefixed with
 * `CODEX-ERROR:` rather than throwing or returning a misleading partial — the
 * caller treats a `CODEX-ERROR:`-prefixed return as "codex did not produce
 * usable output" and falls through to its loud-failure path.
 *
 * NOTE: codex transport not live-validated in this env (no codex CLI installed).
 */
export async function generateCodexText(
  prompt: string,
  options: GenerateCodexTextOptions = {},
): Promise<string> {
  const resolution = resolveCodexBinary();
  if (!resolution.available || !resolution.binaryPath) {
    return `CODEX-ERROR: ${resolution.reason}`;
  }
  const timeoutMs = clampCodexTimeout(options.timeoutMs);
  const result = await runCodexExec(resolution.binaryPath, prompt, timeoutMs, options);
  if (!result.ok) {
    return `CODEX-ERROR: ${result.reason ?? `exit code ${result.exitCode}`}${
      result.stderr ? ` — ${result.stderr.slice(0, 300)}` : ''
    }`;
  }
  const text = result.stdout.trim();
  if (text.length === 0) {
    return 'CODEX-ERROR: codex exec returned empty output';
  }
  return text;
}

/** True when a return value from `generateCodexText` is the error sentinel. */
export function isCodexError(text: string): boolean {
  return text.startsWith('CODEX-ERROR:');
}
