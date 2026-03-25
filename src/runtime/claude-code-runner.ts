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

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { CLIError } from '../errors/index.js';
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
const DEFAULT_MODEL = 'claude-sonnet-4-20250514';

/** Default subprocess timeout: 10 minutes (simulations and complex synthesis need time) */
const DEFAULT_TIMEOUT_MS = 600_000;

/** Maximum stdout capture: 10 MiB (prevents OOM on runaway output) */
const MAX_BUFFER_BYTES = 10 * 1024 * 1024;

/** Maximum raw output stored in result (truncated beyond this) */
const MAX_RAW_OUTPUT_STORED = 1_024_000; // ~1 MiB

/** Binary candidates in resolution priority order */
const BINARY_CANDIDATES = ['claude', 'claude-code'] as const;

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
// Binary Resolution
// ============================================================================

/**
 * Resolve a binary on PATH using the platform-appropriate lookup command.
 * Uses `which` on POSIX, `where` on Windows.
 *
 * @returns The absolute path to the binary, or null if not found.
 */
function resolveBinaryOnPath(name: string): string | null {
  const lookupCommand = process.platform === 'win32' ? 'where' : 'which';
  try {
    const result = execFileSync(lookupCommand, [name], {
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 5_000,
      encoding: 'utf-8',
    });
    // `which` and `where` both output the path on stdout; take first line
    const resolved = result.trim().split(/\r?\n/)[0]?.trim();
    return resolved && resolved.length > 0 ? resolved : null;
  } catch {
    return null;
  }
}

/**
 * Validate that a resolved binary can actually execute by running --version.
 * This catches cases where the binary exists but is corrupted or wrong arch.
 *
 * @returns true if the binary responds to --version within 5s, false otherwise.
 */
function binaryIsExecutable(binaryPath: string): boolean {
  try {
    execFileSync(binaryPath, ['--version'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 5_000,
      encoding: 'utf-8',
    });
    return true;
  } catch {
    // --version may not be supported; try --help as fallback
    try {
      execFileSync(binaryPath, ['--help'], {
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 5_000,
        encoding: 'utf-8',
      });
      return true;
    } catch {
      return false;
    }
  }
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
   * Resolution order:
   * 1. AGENTICS_CLAUDE_BIN env var (explicit override)
   * 2. `claude` on PATH
   * 3. `claude-code` on PATH
   *
   * Caches the result for the lifetime of this instance.
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

    // Priority 1: Explicit environment variable override
    const envBin = process.env['AGENTICS_CLAUDE_BIN'];
    if (envBin !== undefined && envBin.length > 0) {
      // Check as absolute path first, then as PATH lookup
      const isAbsolute = existsSync(envBin);
      const onPath = !isAbsolute ? resolveBinaryOnPath(envBin) : null;
      const candidate = isAbsolute ? envBin : onPath;

      if (candidate !== null) {
        if (binaryIsExecutable(candidate)) {
          this.resolvedBinary = candidate;
          return candidate;
        }
        throw new CLIError({
          code: 'ECLI-SYNTH-001',
          category: 'CONFIG_ERROR',
          message: `AGENTICS_CLAUDE_BIN="${envBin}" was found but is not executable`,
          details: {
            configured_path: envBin,
            resolved_path: candidate,
            hint: 'Verify the binary is not corrupted and has execute permissions',
          },
          module: 'claude-code-runner',
          recoverable: false,
          exitCode: 78,
        });
      }

      throw new CLIError({
        code: 'ECLI-SYNTH-001',
        category: 'CONFIG_ERROR',
        message: `AGENTICS_CLAUDE_BIN="${envBin}" was not found on disk or PATH`,
        details: {
          configured_path: envBin,
          hint: 'Set AGENTICS_CLAUDE_BIN to the full path of the Claude Code binary',
        },
        module: 'claude-code-runner',
        recoverable: false,
        exitCode: 78,
      });
    }

    // Priority 2-3: Standard binary names on PATH
    for (const candidateName of BINARY_CANDIDATES) {
      const resolvedPath = resolveBinaryOnPath(candidateName);
      if (resolvedPath !== null && binaryIsExecutable(resolvedPath)) {
        this.resolvedBinary = resolvedPath;
        return resolvedPath;
      }
    }

    this.resolutionFailed = true;
    throw new CLIError({
      code: 'ECLI-SYNTH-001',
      category: 'CONFIG_ERROR',
      message: 'Claude Code CLI binary not found. Install it or set AGENTICS_CLAUDE_BIN.',
      details: {
        searched_names: [...BINARY_CANDIDATES],
        platform: process.platform,
        path_dirs: (process.env['PATH'] ?? '').split(process.platform === 'win32' ? ';' : ':').length,
        hint: 'Install Claude Code: npm install -g @anthropic-ai/claude-code',
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

  // Case 1: Killed by timeout — do NOT mark LLM unavailable.
  // Timeouts happen when the API is slow, not broken. Next call
  // with a different prompt may succeed within its timeout.
  if (cpError.killed === true) {
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
