/**
 * Claude Code Runner — ADR-006 Implementation
 *
 * Enterprise-grade subprocess invocation of the Claude Code CLI binary.
 * Single synchronous invocation per decision-grade command.
 * Contract-validated output against agentics-contracts response schemas.
 *
 * INVARIANTS:
 * - Exactly one subprocess invocation per call to invoke()
 * - Output is ALWAYS validated against the contract schema before return
 * - SYNTHESIS_FORBIDDEN commands NEVER reach this module
 * - Binary resolution is cached for the lifetime of the singleton
 * - All errors are structured CLIError instances with correlation IDs
 * - No user input reaches the subprocess without sanitization
 *
 * FORBIDDEN:
 * - Async/streaming invocation (one call, one result)
 * - Bypassing contract validation
 * - Invoking for SYNTHESIS_FORBIDDEN commands
 * - Swallowing stderr diagnostics
 */

import { execFileSync, spawn } from 'node:child_process';
import { existsSync, createWriteStream, mkdirSync, type WriteStream } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CLIError } from '../errors/index.js';
import { resolverChildEnv } from '../pipeline/ruflo-resolver.js';
import { safeValidateResponse } from '../contracts/validator.js';
import type {
  ClaudeCodeRunnerOptions,
  ClaudeCodeRunnerResult,
  IClaudeCodeRunner,
} from '../contracts/adr-006-claude-code-synthesis-runner.js';
import { SYNTHESIS_SCHEMA_MAP } from '../contracts/adr-006-claude-code-synthesis-runner.js';

// ============================================================================
// Constants
// ============================================================================

/** Default model when neither options nor env var specifies one */
const DEFAULT_MODEL = 'sonnet'; // version-proof alias; AGENTICS_CLAUDE_MODEL overrides

/** Default subprocess timeout: 10 minutes (simulations and complex synthesis need time) */
const DEFAULT_TIMEOUT_MS = 600_000;

/** Maximum stdout capture: 10 MiB (prevents OOM on runaway output) */
const MAX_BUFFER_BYTES = 10 * 1024 * 1024;

/** Maximum raw output stored in result (truncated beyond this) */
const MAX_RAW_OUTPUT_STORED = 1_024_000; // ~1 MiB

/** Minimum timeout to accept (prevents accidental zero-timeout) */
const MIN_TIMEOUT_MS = 5_000;

/** Maximum timeout to accept (prevents unbounded hangs) */
const MAX_TIMEOUT_MS = 600_000; // 10 minutes

// ============================================================================
// Synthesis Error Class
// ============================================================================

/**
 * Structured error for synthesis-specific failures.
 * Carries the run-id, model, duration, and raw output preview
 * for comprehensive diagnostics without leaking full prompt content.
 */
export class SynthesisError extends CLIError {
  readonly synthesisRunId: string;
  readonly synthesisModel: string;
  readonly synthesisDurationMs: number;

  constructor(options: {
    code: string;
    message: string;
    runId: string;
    model: string;
    durationMs: number;
    category: 'CONFIG_ERROR' | 'DOWNSTREAM_ERROR' | 'NETWORK_ERROR' | 'INTERNAL_ERROR';
    exitCode: 1 | 69 | 70 | 78 | 120 | 140 | 150;
    recoverable: boolean;
    details?: Record<string, unknown>;
    correlationId?: string;
    cause?: Error;
  }) {
    super({
      code: options.code,
      category: options.category,
      message: options.message,
      details: {
        ...options.details,
        synthesis_run_id: options.runId,
        synthesis_model: options.model,
        synthesis_duration_ms: options.durationMs,
      },
      module: 'claude-code-runner',
      correlationId: options.correlationId,
      recoverable: options.recoverable,
      exitCode: options.exitCode,
      cause: options.cause,
    });
    this.name = 'SynthesisError';
    this.synthesisRunId = options.runId;
    this.synthesisModel = options.model;
    this.synthesisDurationMs = options.durationMs;
  }
}

// ============================================================================
// Canonical `claude` Binary Resolution — ADR-PIPELINE-114 §D5
// ============================================================================
//
// ONE resolver for the `claude` binary across the entire codebase, mirroring
// `ruflo-resolver.ts` (ADR-113) for `ruflo`. The four previously-divergent
// detectors (adr-generator, backend-resolver, auto-chain, this runner) now all
// read this module's memoised result. PATH augmentation under Claude Code /
// VS Code stripped-PATH conditions is shared with the ruflo resolver via the
// exported `resolverChildEnv()` helper, so both binaries follow one PATH policy.

const CLAUDE_PROBE_TIMEOUT_MS = 5_000;

export interface ClaudeResolution {
  available: boolean;
  binaryPath: string | null;
  resolvedBy: 'env-override' | 'local-bin' | 'hoisted-bin' | 'which' | 'absolute-path' | 'none';
  version: string | null;
  reason: string;
}

/** Module-scoped memo. Resolution runs once per process; subsequent callers
 * (the runner's `resolve()`, backend-resolver's claude-print tier, the ADR
 * generator) read a single stable decision (ADR-114 §D5: "result is cached"). */
let cachedClaudeResolution: ClaudeResolution | null = null;

/** Parse a semver (e.g. "1.2.3") from arbitrary `--version` output such as
 * "claude 1.2.3 (Claude Code)". Returns null when no semver is present. */
function parseSemver(output: string): string | null {
  const m = output.match(/(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/);
  return m ? m[1]! : null;
}

/** Validate a candidate by running `<path> --version` and parsing a semver.
 * Returns the parsed version, or null when the binary is absent, non-runnable,
 * or prints no recognisable version. PATH-augmented for stripped-PATH spawns. */
function validateClaudeVersion(binaryPath: string): string | null {
  try {
    const out = execFileSync(binaryPath, ['--version'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: CLAUDE_PROBE_TIMEOUT_MS,
      encoding: 'utf-8',
      env: resolverChildEnv(),
    });
    return parseSemver(out);
  } catch {
    return null;
  }
}

/** Filesystem candidate: validate with `--version` only when it exists. */
function tryClaudeCandidate(candidate: string): string | null {
  if (!candidate || !existsSync(candidate)) return null;
  return validateClaudeVersion(candidate) !== null ? candidate : null;
}

/** Raw `which <name>` (PATH-augmented). Returns the first resolved line,
 * unvalidated — the caller validates with `--version`. */
function whichBinaryRaw(name: string): string | null {
  const lookup = process.platform === 'win32' ? 'where' : 'which';
  try {
    const out = execFileSync(lookup, [name], {
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: CLAUDE_PROBE_TIMEOUT_MS,
      encoding: 'utf-8',
      env: resolverChildEnv(),
    });
    const first = out.trim().split(/\r?\n/)[0]?.trim();
    return first && first.length > 0 ? first : null;
  } catch {
    return null;
  }
}

function makeClaudeResolution(
  available: boolean,
  binaryPath: string | null,
  resolvedBy: ClaudeResolution['resolvedBy'],
  version: string | null,
  reason: string,
): ClaudeResolution {
  return { available, binaryPath, resolvedBy, version, reason };
}

/**
 * Compute the `claude` resolution synchronously (the runner's `invoke()` and
 * `resolve()` are synchronous; `resolveClaudeBinary()` wraps this in a Promise
 * for the async callers). Resolution order per ADR-114 §D5:
 *
 *   0. CLAUDE_CODE_BIN / AGENTICS_CLAUDE_BIN env override → 'env-override'
 *   1. ./node_modules/.bin/claude                         → 'local-bin'
 *   2. walk parent dirs for node_modules/.bin/claude      → 'hoisted-bin'
 *   3. which claude (PATH-augmented)                       → 'which'
 *   4. absolute fallbacks                                  → 'absolute-path'
 *
 * Every candidate is validated by `<bin> --version` semver parse; invalid
 * candidates are skipped. AGENTICS_CLAUDE_BIN is honoured after CLAUDE_CODE_BIN
 * for backward compatibility with the pre-114 resolvers (ADR-114 risk row:
 * "Step 0 preserves the env-var override — existing behaviour retained").
 */
function computeClaudeResolution(): ClaudeResolution {
  const home = os.homedir();

  // Step 0: explicit env overrides (CLAUDE_CODE_BIN preferred; AGENTICS_CLAUDE_BIN for back-compat)
  for (const varName of ['CLAUDE_CODE_BIN', 'AGENTICS_CLAUDE_BIN']) {
    const val = process.env[varName];
    if (val && val.length > 0) {
      const candidate = existsSync(val) ? val : whichBinaryRaw(val);
      const version = candidate ? validateClaudeVersion(candidate) : null;
      if (candidate && version !== null) {
        return makeClaudeResolution(true, candidate, 'env-override', version,
          `resolved via ${varName} override at ${candidate} (v${version})`);
      }
      return makeClaudeResolution(false, null, 'none', null,
        `${varName}="${val}" was set but is not a runnable claude binary (--version failed or not found on disk/PATH)`);
    }
  }

  // Step 1: local node_modules/.bin/claude
  {
    const candidate = path.resolve(process.cwd(), 'node_modules', '.bin', 'claude');
    const version = tryClaudeCandidate(candidate) ? validateClaudeVersion(candidate) : null;
    if (version !== null) {
      return makeClaudeResolution(true, candidate, 'local-bin', version,
        `resolved via local node_modules/.bin at ${candidate} (v${version})`);
    }
  }

  // Step 2: walk parent dirs for hoisted node_modules/.bin/claude
  {
    let dir = process.cwd();
    for (let i = 0; i < 6; i++) {
      const candidate = path.join(dir, 'node_modules', '.bin', 'claude');
      if (tryClaudeCandidate(candidate)) {
        const version = validateClaudeVersion(candidate);
        return makeClaudeResolution(true, candidate, 'hoisted-bin', version,
          `resolved via hoisted node_modules/.bin at ${candidate} (v${version})`);
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }

  // Step 3: which claude (PATH-augmented)
  {
    const found = whichBinaryRaw('claude');
    const version = found ? validateClaudeVersion(found) : null;
    if (found && version !== null) {
      return makeClaudeResolution(true, found, 'which', version,
        `resolved via PATH (which claude) at ${found} (v${version})`);
    }
  }

  // Step 4: absolute fallbacks
  const absoluteFallbacks = [
    '/usr/local/bin/claude',
    path.join(home, '.claude', 'bin', 'claude'),
    path.join(home, '.local', 'bin', 'claude'),
    '/opt/homebrew/bin/claude',
  ];
  for (const candidate of absoluteFallbacks) {
    if (tryClaudeCandidate(candidate)) {
      const version = validateClaudeVersion(candidate);
      return makeClaudeResolution(true, candidate, 'absolute-path', version,
        `resolved via absolute fallback at ${candidate} (v${version})`);
    }
  }

  return makeClaudeResolution(false, null, 'none', null,
    `claude binary not found after the five-step PATH-independent search ` +
    `(env-override, local-bin, hoisted-bin, which, absolute-path). ` +
    `Searched cwd=${process.cwd()} home=${home}. ` +
    `Set CLAUDE_CODE_BIN to an absolute claude path to override, or install Claude Code ` +
    `(npm install -g @anthropic-ai/claude-code).`);
}

/**
 * Canonical async resolver for the `claude` binary (ADR-PIPELINE-114 §D5).
 * Memoised at module scope. Shared by every claude call site in the codebase.
 */
export async function resolveClaudeBinary(): Promise<ClaudeResolution> {
  if (cachedClaudeResolution) return cachedClaudeResolution;
  cachedClaudeResolution = computeClaudeResolution();
  return cachedClaudeResolution;
}

/**
 * Reset the memoised claude resolution. Test-only seam — production code
 * resolves once per process. Mirrors `__resetRufloResolutionCache()`.
 */
export function __resetClaudeResolutionCacheForTesting(): void {
  cachedClaudeResolution = null;
}

// ============================================================================
// Output Processing
// ============================================================================

/**
 * Strip markdown code fences from Claude Code output.
 *
 * Handles:
 * - ```json\n...\n```
 * - ```\n...\n```
 * - Leading/trailing whitespace and \r\n line endings
 * - Multiple code fence blocks (takes the first one)
 * - Nested or indented fences (outer only)
 */
function stripCodeFences(raw: string): string {
  // Normalize line endings
  const normalized = raw.replace(/\r\n/g, '\n').trim();

  // Attempt 1: Full string is a single fenced block
  const fullFencePattern = /^```(?:json|JSON)?\s*\n([\s\S]*?)\n\s*```\s*$/;
  const fullMatch = fullFencePattern.exec(normalized);
  if (fullMatch?.[1]) {
    return fullMatch[1].trim();
  }

  // Attempt 2: Fenced block embedded in surrounding text (take first)
  const embeddedFencePattern = /```(?:json|JSON)?\s*\n([\s\S]*?)\n\s*```/;
  const embeddedMatch = embeddedFencePattern.exec(normalized);
  if (embeddedMatch?.[1]) {
    return embeddedMatch[1].trim();
  }

  return normalized;
}

/**
 * Sanitize a prompt string for safe subprocess invocation.
 *
 * Removes or escapes characters that could cause shell injection
 * when passed as a CLI argument to execFileSync (which does NOT
 * use a shell, but we sanitize defensively).
 *
 * Strips:
 * - Null bytes (could truncate strings in C-backed binaries)
 * - Control characters except \n and \t (which are valid in prompts)
 */
function sanitizePrompt(prompt: string): string {
  // Remove null bytes
  let sanitized = prompt.replace(/\0/g, '');

  // Remove control characters except newline (\n=0x0A) and tab (\t=0x09)
  // eslint-disable-next-line no-control-regex
  sanitized = sanitized.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');

  return sanitized;
}

/**
 * Clamp a timeout value to the safe range [MIN_TIMEOUT_MS, MAX_TIMEOUT_MS].
 */
function clampTimeout(timeoutMs: number): number {
  if (!Number.isFinite(timeoutMs) || timeoutMs < MIN_TIMEOUT_MS) {
    return MIN_TIMEOUT_MS;
  }
  if (timeoutMs > MAX_TIMEOUT_MS) {
    return MAX_TIMEOUT_MS;
  }
  return Math.floor(timeoutMs);
}

// ============================================================================
// Claude Code Envelope Unwrapping
// ============================================================================

/**
 * Claude Code `--output-format json` wraps LLM output in a metadata envelope:
 *
 *   {
 *     "type": "result",
 *     "subtype": "success",
 *     "result": "{ ...actual LLM JSON as a string... }",
 *     "session_id": "...",
 *     "usage": { ... }
 *   }
 *
 * The actual synthesis content is in the `result` field as a string.
 * This function extracts and parses it, preserving envelope metadata
 * (usage, timing, session) as `_claude_envelope` for audit purposes.
 */
function unwrapClaudeCodeEnvelope(
  parsed: Record<string, unknown>,
  verbose: boolean,
): Record<string, unknown> {
  // Detect the Claude Code envelope pattern:
  // has `result` as a string + has `session_id` or `usage` or `num_turns`
  const resultField = parsed['result'];
  const isEnvelope = (
    typeof resultField === 'string' &&
    resultField.length > 0 &&
    (
      'session_id' in parsed ||
      'usage' in parsed ||
      'num_turns' in parsed ||
      ('type' in parsed && parsed['type'] === 'result')
    )
  );

  if (!isEnvelope) {
    return parsed; // Not an envelope, return as-is
  }

  // Try to parse the `result` string as JSON (strip code fences first)
  let innerContent: unknown;
  try {
    const cleaned = stripCodeFences(resultField as string);
    innerContent = JSON.parse(cleaned);
  } catch {
    // result is not JSON — could be plain text. Wrap it.
    if (verbose) {
      process.stderr.write(
        '[claude-code-runner] envelope.result is not JSON, wrapping as text content\n',
      );
    }
    return {
      content: resultField,
      _claude_envelope: extractEnvelopeMetadata(parsed),
    };
  }

  // Validate inner content is an object
  if (innerContent === null || typeof innerContent !== 'object' || Array.isArray(innerContent)) {
    return {
      content: innerContent,
      _claude_envelope: extractEnvelopeMetadata(parsed),
    };
  }

  if (verbose) {
    process.stderr.write(
      '[claude-code-runner] unwrapped Claude Code envelope → extracted inner result\n',
    );
  }

  // Merge envelope metadata into inner content for audit trail
  const inner = innerContent as Record<string, unknown>;
  inner['_claude_envelope'] = extractEnvelopeMetadata(parsed);

  return inner;
}

/**
 * Extract non-content metadata from the Claude Code envelope
 * for audit/traceability without polluting the synthesis output.
 */
function extractEnvelopeMetadata(envelope: Record<string, unknown>): Record<string, unknown> {
  const meta: Record<string, unknown> = {};
  const metaKeys = [
    'session_id', 'usage', 'modelUsage', 'num_turns',
    'duration_ms', 'duration_api_ms', 'total_cost_usd',
    'is_error', 'stop_reason', 'permission_denials', 'uuid',
  ];
  for (const key of metaKeys) {
    if (key in envelope) {
      meta[key] = envelope[key];
    }
  }
  return meta;
}

// ============================================================================
// Execution Metadata Injection
// ============================================================================

/** Maps response schema names to required `type` constant values */
const SCHEMA_TYPE_CONSTANTS: Record<string, string> = {
  simulation: 'SimulationReference',
  plan: 'PlanReference',
  intent: 'IntentReference',
  export: 'ExportReference',
  roiReport: 'ROIReport',
  diligencePackage: 'DiligencePackage',
};

/**
 * Inject execution_metadata, layers_executed, type, and id into parsed
 * LLM output so it satisfies the contract response schema.
 *
 * The LLM does not reliably produce these fields, but they represent
 * CLI execution provenance — not content — so the runner injects them
 * deterministically from known execution context.
 *
 * If a field already exists with a valid value, it is NOT overwritten.
 */
function injectExecutionMetadata(
  parsed: Record<string, unknown>,
  runId: string,
  model: string,
  durationMs: number,
  schemaKey?: string,
): void {
  const now = new Date().toISOString();
  const defaultLayers = ['synthesis', 'validation', 'artifact-generation'];

  // 1. Inject execution_metadata
  if (!parsed['execution_metadata'] || typeof parsed['execution_metadata'] !== 'object') {
    parsed['execution_metadata'] = {
      execution_id: runId,
      timestamp: now,
      service: 'claude-code-synthesis',
      model,
      duration_ms: durationMs,
      layers_executed: defaultLayers,
    };
  } else {
    const meta = parsed['execution_metadata'] as Record<string, unknown>;
    if (!meta['execution_id'] && !meta['simulation_id'] && !meta['request_id']) {
      meta['execution_id'] = runId;
    }
    if (!meta['timestamp']) {
      meta['timestamp'] = now;
    }
    if (!meta['service']) {
      meta['service'] = 'claude-code-synthesis';
    }
    if (!Array.isArray(meta['layers_executed']) || meta['layers_executed'].length === 0) {
      meta['layers_executed'] = defaultLayers;
    }
  }

  // 2. Ensure top-level layers_executed exists for multi-layer execution proof
  if (!Array.isArray(parsed['layers_executed']) || parsed['layers_executed'].length === 0) {
    parsed['layers_executed'] = defaultLayers;
  }

  // 3. Inject schema-required `type` constant if missing or wrong
  if (schemaKey) {
    const schemaName = SYNTHESIS_SCHEMA_MAP[schemaKey];
    if (schemaName) {
      const requiredType = SCHEMA_TYPE_CONSTANTS[schemaName];
      if (requiredType && parsed['type'] !== requiredType) {
        parsed['type'] = requiredType;
      }
    }
  }

  // 4. Ensure `id` field exists
  if (typeof parsed['id'] !== 'string' || parsed['id'].length === 0) {
    parsed['id'] = runId;
  }
}

// ============================================================================
// Implementation
// ============================================================================

export class ClaudeCodeRunner implements IClaudeCodeRunner {
  /** Cached binary path after first successful resolution */
  private resolvedBinary: string | null = null;
  /** Cached "not found" so we don't re-scan PATH on every call */
  private resolutionFailed = false;

  /**
   * Resolve the Claude Code binary path.
   *
   * ADR-PIPELINE-114 §D5: delegates to the single canonical resolver
   * (`computeClaudeResolution()` / `resolveClaudeBinary()`) so there is exactly
   * ONE `claude` resolution implementation in the codebase. Caches the result
   * for the lifetime of this instance on top of the module-scoped memo.
   *
   * @throws CLIError (ECLI-SYNTH-001) if no usable binary is found.
   */
  resolve(): string {
    if (this.resolvedBinary !== null) {
      return this.resolvedBinary;
    }
    if (this.resolutionFailed) {
      throw new CLIError({
        code: 'ECLI-SYNTH-001',
        category: 'CONFIG_ERROR',
        message: 'Claude Code CLI binary not found (cached from prior check).',
        module: 'claude-code-runner',
        recoverable: false,
        exitCode: 78,
      });
    }

    const resolution = cachedClaudeResolution ?? (cachedClaudeResolution = computeClaudeResolution());
    if (resolution.available && resolution.binaryPath) {
      this.resolvedBinary = resolution.binaryPath;
      return resolution.binaryPath;
    }

    this.resolutionFailed = true;
    throw new CLIError({
      code: 'ECLI-SYNTH-001',
      category: 'CONFIG_ERROR',
      message: resolution.reason,
      details: {
        resolved_by: resolution.resolvedBy,
        platform: process.platform,
        hint: 'Install Claude Code: npm install -g @anthropic-ai/claude-code, or set CLAUDE_CODE_BIN',
      },
      module: 'claude-code-runner',
      recoverable: false,
      exitCode: 78,
    });
  }

  /**
   * Invoke Claude Code with a prompt and return contract-validated output.
   *
   * Flow:
   * 1. Resolve binary (cached)
   * 2. Resolve model and timeout from options → env → defaults
   * 3. Sanitize prompt
   * 4. Spawn subprocess: `<binary> --print --output-format json --model <model> <prompt>`
   * 5. Capture stdout + stderr
   * 6. Strip code fences from stdout
   * 7. Parse as JSON (throw ECLI-SYNTH-003 on failure)
   * 8. Validate against contract response schema (throw ECLI-SYNTH-004 on failure)
   * 9. Return validated result
   *
   * @throws SynthesisError on any failure (see ADR-006 error code table)
   */
  invoke<T>(prompt: string, options: ClaudeCodeRunnerOptions): ClaudeCodeRunnerResult<T> {
    // Resolve binary (cached after first call)
    const binary = this.resolve();

    // Resolve configuration: options → env → defaults
    const model = resolveModel(options.model);
    const timeoutMs = resolveTimeout(options.timeoutMs);
    const verbose = options.verbose ?? (process.env['AGENTICS_DEV'] === '1' || process.env['AGENTICS_DEV'] === 'true');
    const correlationId = options.correlationId;

    // Sanitize prompt
    const sanitizedPrompt = sanitizePrompt(prompt);
    if (sanitizedPrompt.length === 0) {
      throw new SynthesisError({
        code: 'ECLI-SYNTH-006',
        message: 'Prompt is empty after sanitization',
        runId: options.runId,
        model,
        durationMs: 0,
        category: 'INTERNAL_ERROR',
        exitCode: 70,
        recoverable: false,
        correlationId,
      });
    }

    if (verbose) {
      process.stderr.write(
        `[claude-code-runner] resolve=${binary} model=${model} timeout=${timeoutMs}ms ` +
        `runId=${options.runId} promptLen=${sanitizedPrompt.length}\n`
      );
    }

    // Build subprocess arguments — prompt goes via stdin to avoid
    // ARG_MAX limits and CLI argument parsing issues with large prompts
    const subprocessArgs: string[] = [
      '--print',
      '--output-format', 'json',
      '--model', model,
    ];

    // Execute subprocess
    const startTime = Date.now();
    let rawStdout: string;
    let rawStderr = '';

    if (verbose) {
      process.stderr.write(
        `[claude-code-runner] Piping ${sanitizedPrompt.length} bytes via stdin\n`
      );
    }

    try {
      // Build clean env: must actually DELETE keys (setting undefined doesn't remove them)
      const childEnv: Record<string, string | undefined> = { ...process.env, CI: '1' };
      delete childEnv['CLAUDECODE'];
      delete childEnv['AGENTICS_DEV'];

      rawStdout = execFileSync(binary, subprocessArgs, {
        input: sanitizedPrompt,
        encoding: 'utf-8',
        timeout: timeoutMs,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: childEnv,
        maxBuffer: MAX_BUFFER_BYTES,
      });
    } catch (error: unknown) {
      const durationMs = Date.now() - startTime;
      handleSubprocessError(error, options.runId, model, timeoutMs, durationMs, correlationId);
      // handleSubprocessError always throws; this is unreachable but satisfies TS
      throw error;
    }

    const durationMs = Date.now() - startTime;

    if (verbose) {
      process.stderr.write(
        `[claude-code-runner] completed in ${durationMs}ms stdout=${rawStdout.length}B\n`
      );
    }

    // Process output: strip fences → parse JSON → validate contract
    const cleanedOutput = stripCodeFences(rawStdout);

    // Parse JSON
    let parsed: unknown;
    try {
      parsed = JSON.parse(cleanedOutput);
    } catch (parseError: unknown) {
      throw new SynthesisError({
        code: 'ECLI-SYNTH-003',
        message: 'Claude Code output is not valid JSON after code-fence stripping',
        runId: options.runId,
        model,
        durationMs,
        category: 'DOWNSTREAM_ERROR',
        exitCode: 140,
        recoverable: false,
        correlationId,
        details: {
          raw_output_length: rawStdout.length,
          cleaned_output_preview: cleanedOutput.slice(0, 300),
          stderr_preview: rawStderr.slice(0, 300),
          parse_error: parseError instanceof Error ? parseError.message : String(parseError),
        },
        cause: parseError instanceof Error ? parseError : undefined,
      });
    }

    // Validate parsed output is an object (not array, string, null, etc.)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new SynthesisError({
        code: 'ECLI-SYNTH-003',
        message: `Claude Code output parsed as ${parsed === null ? 'null' : Array.isArray(parsed) ? 'array' : typeof parsed}, expected object`,
        runId: options.runId,
        model,
        durationMs,
        category: 'DOWNSTREAM_ERROR',
        exitCode: 140,
        recoverable: false,
        correlationId,
        details: {
          parsed_type: parsed === null ? 'null' : Array.isArray(parsed) ? 'array' : typeof parsed,
        },
      });
    }

    // ========================================================================
    // Unwrap Claude Code --output-format json envelope.
    //
    // Claude Code wraps LLM output in: { type: "result", result: "...", ... }
    // The actual synthesis content is in the `result` field as a string.
    // Extract it so downstream consumers get the real data.
    // ========================================================================
    parsed = unwrapClaudeCodeEnvelope(parsed as Record<string, unknown>, verbose);

    // Inject execution_metadata and schema-required fields if the LLM
    // did not produce them. These are CLI execution provenance — not
    // content — so the runner injects them deterministically.
    injectExecutionMetadata(
      parsed as Record<string, unknown>,
      options.runId,
      model,
      durationMs,
      options.schemaKey,
    );

    // Contract validation against the response schema for this subcommand
    if (options.schemaKey) {
      const schemaName = SYNTHESIS_SCHEMA_MAP[options.schemaKey];
      if (schemaName) {
        const validationResult = safeValidateResponse(
          schemaName as 'base' | 'manifest' | 'plan' | 'simulation' | 'simulationOutput' | 'roiReport' | 'intent' | 'export' | 'diligencePackage',
          parsed,
          correlationId,
        );

        if (!validationResult.valid) {
          throw new SynthesisError({
            code: 'ECLI-SYNTH-004',
            message: `Claude Code output failed contract validation against schema "${schemaName}"`,
            runId: options.runId,
            model,
            durationMs,
            category: 'DOWNSTREAM_ERROR',
            exitCode: 140,
            recoverable: false,
            correlationId,
            details: {
              schema_name: schemaName,
              schema_key: options.schemaKey,
              validation_errors: validationResult.error.validationErrors.slice(0, 5),
            },
            cause: validationResult.error,
          });
        }
      }
    }

    // Truncate rawOutput for storage safety
    const truncatedRawOutput = rawStdout.length > MAX_RAW_OUTPUT_STORED
      ? rawStdout.slice(0, MAX_RAW_OUTPUT_STORED) + `\n...[truncated from ${rawStdout.length} bytes]`
      : rawStdout;

    return {
      data: parsed as T,
      runId: options.runId,
      model,
      durationMs,
      rawOutput: truncatedRawOutput,
    };
  }

  /**
   * Hardened free-form text synthesis — ADR-PIPELINE-114 §D1–D3.
   *
   * Runs `claude --print --output-format json` with the prompt delivered via
   * STDIN (never argv → no ARG_MAX / E2BIG truncation), unwraps the JSON
   * envelope, and returns the inner `result` markdown string. Unlike `invoke()`
   * this performs NO contract-schema validation — the ADR generator emits plain
   * markdown, not schema-validated JSON.
   *
   * Hardening invariants (all three non-negotiable per ADR-114):
   *   - prompt via stdin, not argv
   *   - `--output-format json` with envelope unwrap
   *   - `MCP_SERVER_MODE` deleted from the child env (CLAUDECODE left as-is)
   *
   * Preserves the ADR-100 §D3 streaming behaviour: live stderr forwarding,
   * a heartbeat, a 60s idle bound, and a hard timeout (default 30 min).
   *
   * @throws SynthesisError on spawn error, non-zero exit, timeout, or empty output.
   */
  async generateText(prompt: string, options: GenerateTextOptions = {}): Promise<string> {
    const binary = this.resolve();
    const model = resolveModel(options.model);
    const timeoutMs = clampGenerateTimeout(options.timeoutMs);
    const runId = options.runId ?? 'generate-text';

    const sanitizedPrompt = sanitizePrompt(prompt);
    if (sanitizedPrompt.length === 0) {
      throw new SynthesisError({
        code: 'ECLI-SYNTH-006',
        message: 'Prompt is empty after sanitization',
        runId,
        model,
        durationMs: 0,
        category: 'INTERNAL_ERROR',
        exitCode: 70,
        recoverable: false,
      });
    }

    const result = await runHardenedClaudePrint(binary, sanitizedPrompt, model, timeoutMs, options);

    if (!result.ok) {
      // A killed subprocess (timeout / idle bound) marks claude unavailable so
      // remaining phases skip instantly — same policy as invoke()'s handler.
      if (result.killed) {
        markClaudeCodeUnavailable(`generateText subprocess killed after ${result.elapsedMs}ms: ${result.reason ?? 'unknown'}`);
      }
      throw new SynthesisError({
        code: result.killed ? 'ECLI-SYNTH-005' : 'ECLI-SYNTH-002',
        message: `claude --print synthesis failed: ${result.reason ?? `exit code ${result.exitCode}`}`,
        runId,
        model,
        durationMs: result.elapsedMs,
        category: result.killed ? 'NETWORK_ERROR' : 'DOWNSTREAM_ERROR',
        exitCode: result.killed ? 120 : 140,
        recoverable: result.killed,
        details: {
          timeout_ms: timeoutMs,
          exit_code: result.exitCode,
          stdout_bytes: result.stdout.length,
          stderr_preview: result.stderr.slice(0, 500),
        },
      });
    }

    const text = unwrapClaudeCodeResultString(result.stdout);
    if (!text || text.trim().length === 0) {
      throw new SynthesisError({
        code: 'ECLI-SYNTH-003',
        message: 'claude --print returned an empty result after envelope unwrap',
        runId,
        model,
        durationMs: result.elapsedMs,
        category: 'DOWNSTREAM_ERROR',
        exitCode: 140,
        recoverable: false,
        details: { stdout_preview: result.stdout.slice(0, 300) },
      });
    }
    return text;
  }
}

// ============================================================================
// Configuration Resolution Helpers
// ============================================================================

/**
 * Resolve the model to use: explicit option → env var → default.
 * Validates the model string is non-empty.
 */
function resolveModel(optionModel: string | undefined): string {
  const envModel = process.env['AGENTICS_CLAUDE_MODEL'];
  const model = optionModel ?? (envModel && envModel.length > 0 ? envModel : undefined) ?? DEFAULT_MODEL;
  // Defensive: model must be a non-empty alphanumeric-ish string
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(model)) {
    throw new CLIError({
      code: 'ECLI-SYNTH-006',
      category: 'CONFIG_ERROR',
      message: `Invalid model name: "${model}". Must be alphanumeric with dots, hyphens, or underscores.`,
      details: { model },
      module: 'claude-code-runner',
      recoverable: false,
      exitCode: 78,
    });
  }
  return model;
}

/**
 * Resolve and clamp the timeout: explicit option → env var → default.
 */
function resolveTimeout(optionTimeout: number | undefined): number {
  if (optionTimeout !== undefined) {
    return clampTimeout(optionTimeout);
  }
  const envTimeout = process.env['AGENTICS_CLAUDE_TIMEOUT_MS'];
  if (envTimeout !== undefined && envTimeout.length > 0) {
    const parsed = parseInt(envTimeout, 10);
    if (Number.isFinite(parsed)) {
      return clampTimeout(parsed);
    }
  }
  return DEFAULT_TIMEOUT_MS;
}

// ============================================================================
// Subprocess Error Handler
// ============================================================================

/**
 * Handle execFileSync errors and convert to structured SynthesisError.
 *
 * Node.js child_process errors have these relevant fields:
 * - killed: boolean (true if process was killed by timeout signal)
 * - status: number | null (exit code, null if killed)
 * - stderr: Buffer | string (captured stderr output)
 * - message: string (Node.js error message)
 *
 * @throws SynthesisError always
 */
function handleSubprocessError(
  error: unknown,
  runId: string,
  model: string,
  timeoutMs: number,
  durationMs: number,
  correlationId?: string,
): never {
  // Type-narrow the child_process error
  const cpError = error as {
    status?: number | null;
    killed?: boolean;
    stderr?: Buffer | string;
    stdout?: Buffer | string;
    message?: string;
    code?: string;
    signal?: string;
  };

  // Extract stderr for diagnostics (may be Buffer or string)
  let stderrStr = '';
  if (typeof cpError.stderr === 'string') {
    stderrStr = cpError.stderr;
  } else if (Buffer.isBuffer(cpError.stderr)) {
    stderrStr = cpError.stderr.toString('utf-8');
  }
  const stderrPreview = stderrStr.slice(0, 1_000);

  // Case 1: Killed by timeout or SIGTERM (code 143).
  // Mark LLM unavailable so remaining phases skip instantly.
  // In MCP mode, subprocess calls ALWAYS get SIGTERM'd — no point retrying.
  // In standalone mode, if one call times out the rest likely will too.
  if (cpError.killed === true) {
    markClaudeCodeUnavailable(`subprocess killed (${cpError.signal ?? 'SIGTERM'}) after ${durationMs}ms`);
    throw new SynthesisError({
      code: 'ECLI-SYNTH-005',
      message: `Claude Code subprocess timed out after ${timeoutMs}ms (wall-clock: ${durationMs}ms)`,
      runId,
      model,
      durationMs,
      category: 'NETWORK_ERROR',
      exitCode: 120,
      recoverable: true,
      correlationId,
      details: {
        timeout_ms: timeoutMs,
        signal: cpError.signal,
        stderr_preview: stderrPreview,
        hint: 'Increase AGENTICS_CLAUDE_TIMEOUT_MS or simplify the prompt',
      },
    });
  }

  // Case 2: ENOENT — binary vanished between resolve() and invoke()
  if (cpError.code === 'ENOENT') {
    throw new SynthesisError({
      code: 'ECLI-SYNTH-001',
      message: 'Claude Code binary not found at execution time (may have been uninstalled)',
      runId,
      model,
      durationMs,
      category: 'CONFIG_ERROR',
      exitCode: 78,
      recoverable: false,
      correlationId,
      details: {
        error_code: cpError.code,
      },
    });
  }

  // Case 3: Non-zero exit code — disable LLM only for auth/binary errors,
  // NOT for exit code 143 (SIGTERM from timeout, already handled above)
  const exitCode = cpError.status ?? 0;
  if (exitCode !== 143 && exitCode !== 0) {
    markClaudeCodeUnavailable(`subprocess exited with code ${exitCode}`);
  }
  throw new SynthesisError({
    code: 'ECLI-SYNTH-002',
    message: `Claude Code exited with code ${cpError.status ?? 'unknown'}: ${stderrPreview.split('\n')[0] || cpError.message || 'no details'}`,
    runId,
    model,
    durationMs,
    category: 'DOWNSTREAM_ERROR',
    exitCode: 140,
    recoverable: false,
    correlationId,
    details: {
      exit_code: cpError.status,
      signal: cpError.signal,
      stderr_preview: stderrPreview,
      node_error_code: cpError.code,
    },
    cause: error instanceof Error ? error : undefined,
  });
}

// ============================================================================
// Hardened Free-Form Synthesis (generateText) — ADR-PIPELINE-114 §D1–D3
// ============================================================================

/** Default hard timeout for free-form synthesis: 30 minutes (ADR-100 §D3). */
const GENERATE_DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
/** Upper bound for free-form synthesis timeout: 60 minutes. */
const GENERATE_MAX_TIMEOUT_MS = 60 * 60 * 1000;

export interface GenerateTextOptions {
  /** Model alias/id (default: 'sonnet' via resolveModel). */
  model?: string;
  /** Hard timeout in ms (default 30 min, clamped to [5s, 60min]). */
  timeoutMs?: number;
  /** Correlation id for diagnostics. */
  runId?: string;
  /** Idle bound in ms — kill if no output for this long (default 60s). */
  idleBoundMs?: number;
  /** Heartbeat interval in ms for the progress line (default 10s). */
  heartbeatMs?: number;
  /** Optional file path to append the child's stderr to (debug log). */
  debugLogPath?: string;
  /** Label used in heartbeat / log lines. */
  label?: string;
}

/** Clamp the free-form synthesis timeout, preserving the ADR-100 30-min default
 * and a 60-min ceiling (wider than invoke()'s 10-min cap — deep ADR synthesis
 * legitimately runs long). */
function clampGenerateTimeout(timeoutMs: number | undefined): number {
  if (timeoutMs === undefined || !Number.isFinite(timeoutMs)) return GENERATE_DEFAULT_TIMEOUT_MS;
  return Math.max(MIN_TIMEOUT_MS, Math.min(GENERATE_MAX_TIMEOUT_MS, Math.floor(timeoutMs)));
}

interface HardenedStreamResult {
  ok: boolean;
  killed: boolean;
  reason?: string;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  elapsedMs: number;
}

/**
 * Spawn `claude --print --output-format json` with the prompt on STDIN.
 *
 * This is the single hardened transport (ADR-114 §D2–D3). Output is buffered
 * incrementally so partial output is preserved on kill; stderr is forwarded
 * live. The child env deletes `MCP_SERVER_MODE` (which would force JSON-RPC
 * framing) and leaves `CLAUDECODE` untouched.
 */
/**
 * System prompt appended to every hardened synthesis call. Counteracts the
 * project CLAUDE.md's "route everything to agents / output nothing yourself"
 * directives, which otherwise make `claude --print` refuse to synthesize.
 */
const SYNTHESIS_SYSTEM_PROMPT =
  'You are a document synthesis engine. Output ONLY the requested document text as ' +
  'markdown. Do not use tools, do not write or read files, do not ask for approval, ' +
  'and do not add any commentary, preamble, or explanation before or after the document.';

function runHardenedClaudePrint(
  binary: string,
  prompt: string,
  model: string,
  timeoutMs: number,
  options: GenerateTextOptions,
): Promise<HardenedStreamResult> {
  const startMs = Date.now();
  // 120s floor: even with partial-message streaming, a large synthesis can pause
  // between the init burst and the first token while the model reads the prompt.
  const idleBoundMs = options.idleBoundMs ?? 120_000;
  const heartbeatMs = options.heartbeatMs ?? 10_000;
  const label = options.label ?? 'claude --print synthesis';

  return new Promise<HardenedStreamResult>((resolve) => {
    let stdout = '';
    let stderr = '';
    let lastDataMs = Date.now();
    let killed = false;
    let killReason: string | undefined;

    // ADR-114 §D3: delete MCP_SERVER_MODE (forces JSON-RPC framing, breaks the
    // envelope parser); leave CLAUDECODE as-is (harmless with --output-format json).
    const childEnv: NodeJS.ProcessEnv = { ...process.env };
    delete childEnv['MCP_SERVER_MODE'];

    // ADR-114 §D2: prompt via stdin — NEVER as an argv positional argument.
    //
    // Transport = `--output-format stream-json --verbose` (newline-delimited
    // event stream) rather than the buffered `--output-format json`. Buffered
    // json emits ZERO bytes until the entire completion is ready, so a large
    // synthesis (e.g. a 30KB ADR prompt) stayed silent past the 60s idle bound
    // and was killed mid-generation ("0 bytes received"). stream-json emits an
    // event per message/token, keeping the idle timer fed so it once again only
    // fires on a genuinely hung process. `--verbose` is required by the CLI when
    // combining `--print` with `--output-format stream-json`.
    // Synthesis is a pure text task. With tools + the default permission mode,
    // the agent interprets "generate ADRs" as a file-write request, invokes the
    // Write tool, and returns an approval prompt ("The write needs your approval
    // …") instead of the markdown — and the project CLAUDE.md's agent-routing
    // directives nudge it further off-task. Three flags pin it to direct text:
    //   --allowedTools ''          deny every tool
    //   --permission-mode dontAsk  never block waiting on an approval prompt
    //   --append-system-prompt …   steer to emit only the document, no preamble
    // `--include-partial-messages` streams partial assistant/thinking deltas as
    // they are produced. Without it, a large prompt (e.g. a 30KB ADR request)
    // emits the init/system events in a burst and then goes silent for the whole
    // think+generate window — tripping the idle bound mid-generation. Partial
    // messages keep the idle timer fed so it only fires on a genuinely hung run.
    const child = spawn(binary, [
      '--print',
      '--output-format', 'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--allowedTools', '',
      '--permission-mode', 'dontAsk',
      '--append-system-prompt', SYNTHESIS_SYSTEM_PROMPT,
      '--model', model,
    ], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: childEnv,
    });

    process.stderr.write(
      `[claude-code-runner] Streaming ${label} (model=${model}, timeout=${Math.floor(timeoutMs / 1000)}s, ` +
      `idle=${Math.floor(idleBoundMs / 1000)}s, transport=stdin/stream-json, prompt=${prompt.length}B)\n`,
    );

    let debugStream: WriteStream | null = null;
    if (options.debugLogPath) {
      try {
        mkdirSync(path.dirname(options.debugLogPath), { recursive: true });
        debugStream = createWriteStream(options.debugLogPath, { flags: 'a' });
      } catch { /* best-effort */ }
    }

    // Deliver the prompt via stdin, then close the stream.
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
      process.stderr.write(`[claude] ${text}`);
      debugStream?.write(text);
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
        process.stderr.write(`[claude-code-runner] Killing ${label}: ${killReason}\n`);
        try { child.kill('SIGTERM'); } catch { /* already dead */ }
      }
    }, Math.min(heartbeatMs, 5000));

    const hardTimeout = setTimeout(() => {
      if (!killed) {
        killed = true;
        killReason = `hard timeout exceeded (${Math.floor(timeoutMs / 1000)}s)`;
        process.stderr.write(`[claude-code-runner] Killing ${label}: ${killReason}\n`);
        try { child.kill('SIGTERM'); } catch { /* already dead */ }
        setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* already dead */ } }, 5000);
      }
    }, timeoutMs);

    const cleanup = () => {
      clearInterval(heartbeat);
      clearInterval(idleCheck);
      clearTimeout(hardTimeout);
      debugStream?.end();
    };

    child.on('error', (err: Error) => {
      cleanup();
      resolve({
        ok: false,
        killed,
        reason: `spawn error: ${err.message}`,
        stdout,
        stderr,
        exitCode: null,
        elapsedMs: Date.now() - startMs,
      });
    });

    child.on('close', (code: number | null) => {
      cleanup();
      const ok = !killed && code === 0;
      resolve({
        ok,
        killed,
        reason: ok ? undefined : (killReason ?? `claude --print exited with code ${code}`),
        stdout,
        stderr,
        exitCode: code,
        elapsedMs: Date.now() - startMs,
      });
    });
  });
}

/**
 * Extract the assistant's final markdown from the transport's stdout.
 *
 * The hardened transport uses `--output-format stream-json --verbose`, whose
 * stdout is newline-delimited JSON events. The terminal `{"type":"result",
 * "result":"…"}` event carries the full completion text; failing that we
 * concatenate the text blocks of every `assistant` message event. For backward
 * compatibility (and any caller still on buffered `--output-format json`) we
 * also handle a single JSON envelope object with a `result` field, and finally
 * fall back to the raw output so the caller can still attempt to parse it.
 */
function unwrapClaudeCodeResultString(raw: string): string {
  // 1. stream-json: scan newline-delimited events.
  const lines = raw.split('\n').map((l) => l.trim()).filter(Boolean);
  let resultText: string | null = null;
  const assistantText: string[] = [];
  for (const line of lines) {
    if (!line.startsWith('{')) continue;
    let evt: Record<string, unknown>;
    try {
      evt = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const type = evt['type'];
    if (type === 'result' && typeof evt['result'] === 'string') {
      resultText = evt['result'] as string;
    } else if (type === 'assistant' && evt['message'] && typeof evt['message'] === 'object') {
      const content = (evt['message'] as Record<string, unknown>)['content'];
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block && typeof block === 'object'
            && (block as Record<string, unknown>)['type'] === 'text'
            && typeof (block as Record<string, unknown>)['text'] === 'string') {
            assistantText.push((block as Record<string, unknown>)['text'] as string);
          }
        }
      }
    }
  }
  if (resultText && resultText.trim().length > 0) return resultText;
  if (assistantText.length > 0) return assistantText.join('');

  // 2. Buffered single-object envelope (legacy `--output-format json`).
  const cleaned = stripCodeFences(raw);
  try {
    const parsed = JSON.parse(cleaned) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const resultField = (parsed as Record<string, unknown>)['result'];
      if (typeof resultField === 'string') return resultField;
    }
    if (typeof parsed === 'string') return parsed;
  } catch {
    // Not a single JSON envelope — fall through to raw.
  }

  // 3. Raw passthrough.
  return raw.trim();
}

/**
 * Module-level convenience for free-form synthesis via the shared singleton.
 * Used by the ADR generator (ADR-114 §D1) so all `claude --print` synthesis
 * flows through the one hardened transport.
 */
export async function generateClaudeText(prompt: string, options: GenerateTextOptions = {}): Promise<string> {
  if (singletonRunner === null) {
    singletonRunner = new ClaudeCodeRunner();
  }
  return singletonRunner.generateText(prompt, options);
}

// ============================================================================
// Singleton & Factory
// ============================================================================

/** Module-level singleton. Binary resolution is cached here. */
let singletonRunner: ClaudeCodeRunner | null = null;

/**
 * Get or create the singleton ClaudeCodeRunner.
 *
 * Uses a singleton so binary resolution (which spawns `which`/`where`)
 * only happens once per process lifetime.
 */
export function createClaudeCodeRunner(): IClaudeCodeRunner {
  if (singletonRunner === null) {
    singletonRunner = new ClaudeCodeRunner();
  }
  return singletonRunner;
}

/**
 * Reset the singleton (for testing only).
 * Clears cached binary resolution so the next call re-resolves.
 */
export function resetClaudeCodeRunnerForTesting(): void {
  singletonRunner = null;
  _availabilityChecked = false;
  _isAvailable = false;
  cachedClaudeResolution = null;
}

// ============================================================================
// Fast Availability Check
// ============================================================================

/** Cached result of availability check — resolved once per process. */
let _availabilityChecked = false;
let _isAvailable = false;

/**
 * Check if the Claude Code runner binary is available for subprocess calls.
 *
 * Returns FALSE when running inside an MCP server context — spawning
 * Claude Code subprocesses from within an MCP tool that's already running
 * inside Claude Code causes recursive process kills (SIGTERM code 143).
 * The outer Claude Code session is already the LLM — the pipeline uses
 * fast templates for structured JSON and lets Claude Code handle refinement.
 *
 * Caches the result for the lifetime of the process.
 */
export function isClaudeCodeRunnerAvailable(): boolean {
  if (_availabilityChecked) return _isAvailable;
  _availabilityChecked = true;

  // When running as an MCP server (stdin piped from Claude Code),
  // do NOT spawn Claude Code subprocesses — it causes recursive kills.
  if (!process.stdin.isTTY && process.env['MCP_SERVER_MODE'] === '1') {
    _isAvailable = false;
    process.stderr.write('[claude-code-runner] Running inside MCP server — skipping subprocess LLM calls (outer Claude Code is the LLM)\n');
    return _isAvailable;
  }

  try {
    const runner = createClaudeCodeRunner();
    runner.resolve();
    _isAvailable = true;
  } catch {
    _isAvailable = false;
    process.stderr.write('[claude-code-runner] Binary not found — LLM refinement calls will be skipped (using templates)\n');
  }
  return _isAvailable;
}

/**
 * Mark Claude Code as unavailable for the rest of this process.
 * Called after the first timeout/failure so subsequent phases skip LLM
 * calls instantly instead of burning another 45-90s per timeout.
 */
export function markClaudeCodeUnavailable(reason: string): void {
  if (_isAvailable) {
    _isAvailable = false;
    _availabilityChecked = true;
    process.stderr.write(`[claude-code-runner] LLM disabled for remaining phases: ${reason}\n`);
  }
}
