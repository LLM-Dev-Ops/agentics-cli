/**
 * Artifact Writer — ADR-008 Implementation
 *
 * Enterprise-grade synthesis artifact persistence to ~/.agentics/runs/<run-id>/.
 * Provides a local audit trail for offline inspection via `agentics inspect run`.
 *
 * INVARIANTS:
 * - Every write produces exactly four artifact files in the run directory
 * - All file content is serialized BEFORE any I/O begins (fail-fast)
 * - File writes use atomic temp-then-rename to prevent partial artifacts
 * - Files are written with mode 0o600 (owner read/write only)
 * - Directories are created with mode 0o700 (owner read/write/execute only)
 * - All run-id values are validated for path traversal and format safety
 * - SHA-256 checksums are computed for every artifact file
 * - All I/O errors are wrapped with CLIError for structured diagnostics
 *
 * FORBIDDEN:
 * - Validating artifact content semantics (already validated by runner/router)
 * - Calling external APIs
 * - Modifying artifact data (write-through only)
 * - Following symlinks outside the base directory
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import { CLIError } from '../errors/index.js';
import type {
  RunManifest,
  PlatformReceipt,
  ArtifactWriterInput,
  IArtifactWriter,
  ArtifactWriteResult,
  RunSummary,
  ListRunsOptions,
} from '../contracts/adr-008-synthesis-artifact-persistence.js';

// ============================================================================
// Constants
// ============================================================================

/** File permission: owner read/write only (matches credentials.ts pattern) */
const FILE_MODE = 0o600;

/** Directory permission: owner read/write/execute only */
const DIR_MODE = 0o700;

/** Artifact filenames — the canonical set for every run directory */
const MANIFEST_FILE = 'manifest.json';
const CLAUDE_OUTPUT_FILE = 'claude_output.json';
const PLATFORM_RECEIPT_FILE = 'platform_receipt.json';
const PROMPT_FILE = 'prompt.txt';

/** Maximum allowed run-id length to prevent filesystem path issues */
const MAX_RUN_ID_LENGTH = 200;

/** Maximum claude_output.json serialized size: 10 MiB */
const MAX_JSON_BYTES = 10 * 1024 * 1024;

/** Warning threshold for prompt.txt: 1 MiB */
const MAX_PROMPT_WARN_BYTES = 1 * 1024 * 1024;

/**
 * Pattern for valid run-id characters.
 * Must start with alphanumeric, followed by alphanumeric, hyphens, dots, or underscores.
 * This prevents path traversal and shell metacharacter injection.
 */
const SAFE_RUN_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

// ============================================================================
// Validation Helpers
// ============================================================================

/**
 * Type guard: check if a value is a non-empty string.
 */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/**
 * Validate a run-id for format safety and path traversal prevention.
 *
 * @throws CLIError (ECLI-ART-001) on format/length violations
 * @throws CLIError (ECLI-ART-002) on path traversal characters
 */
function validateRunId(runId: string): void {
  if (!runId || typeof runId !== 'string') {
    throw new CLIError({
      code: 'ECLI-ART-001',
      category: 'INTERNAL_ERROR',
      message: 'Run ID is empty or not a string',
      details: { run_id: String(runId) },
      module: 'artifact-writer',
      recoverable: false,
      exitCode: 70,
    });
  }

  if (runId.length > MAX_RUN_ID_LENGTH) {
    throw new CLIError({
      code: 'ECLI-ART-001',
      category: 'INTERNAL_ERROR',
      message: `Run ID exceeds maximum length (${runId.length} > ${MAX_RUN_ID_LENGTH})`,
      details: { run_id_length: runId.length, max_length: MAX_RUN_ID_LENGTH },
      module: 'artifact-writer',
      recoverable: false,
      exitCode: 70,
    });
  }

  // Path traversal prevention (defense-in-depth)
  if (runId.includes('..') || runId.includes('/') || runId.includes('\\') || runId.includes('\0')) {
    throw new CLIError({
      code: 'ECLI-ART-002',
      category: 'INTERNAL_ERROR',
      message: 'Run ID contains path traversal or null byte characters',
      details: { run_id_preview: runId.slice(0, 50) },
      module: 'artifact-writer',
      recoverable: false,
      exitCode: 70,
    });
  }

  if (!SAFE_RUN_ID_PATTERN.test(runId)) {
    throw new CLIError({
      code: 'ECLI-ART-001',
      category: 'INTERNAL_ERROR',
      message: `Run ID contains invalid characters: must match ${SAFE_RUN_ID_PATTERN.source}`,
      details: { run_id_preview: runId.slice(0, 50) },
      module: 'artifact-writer',
      recoverable: false,
      exitCode: 70,
    });
  }
}

/**
 * Validate that a RunManifest has all required fields with correct types.
 *
 * @throws CLIError (ECLI-ART-003) on missing or invalid manifest fields
 */
function validateManifestFields(manifest: RunManifest): void {
  // Validate required string fields
  const requiredChecks: [string, unknown][] = [
    ['run_id', manifest.run_id],
    ['command', manifest.command],
    ['subcommand', manifest.subcommand],
    ['synthesis_class', manifest.synthesis_class],
    ['contract_schema', manifest.contract_schema],
    ['model', manifest.model],
    ['created_at', manifest.created_at],
    ['user_id', manifest.user_id],
    ['org_id', manifest.org_id],
    ['trace_id', manifest.trace_id],
  ];

  for (const [fieldName, value] of requiredChecks) {
    if (!isNonEmptyString(value)) {
      throw new CLIError({
        code: 'ECLI-ART-003',
        category: 'INTERNAL_ERROR',
        message: `RunManifest.${fieldName} is missing or empty`,
        details: { field: fieldName, run_id: manifest.run_id },
        module: 'artifact-writer',
        recoverable: false,
        exitCode: 70,
      });
    }
  }

  // Validate synthesis_class enum
  if (manifest.synthesis_class !== 'SYNTHESIS_REQUIRED' && manifest.synthesis_class !== 'COMMITMENT_GRADE') {
    throw new CLIError({
      code: 'ECLI-ART-003',
      category: 'INTERNAL_ERROR',
      message: `RunManifest.synthesis_class must be 'SYNTHESIS_REQUIRED' or 'COMMITMENT_GRADE', got: "${String(manifest.synthesis_class)}"`,
      details: { synthesis_class: manifest.synthesis_class },
      module: 'artifact-writer',
      recoverable: false,
      exitCode: 70,
    });
  }

  // Validate numeric fields
  if (typeof manifest.duration_ms !== 'number' || manifest.duration_ms < 0) {
    throw new CLIError({
      code: 'ECLI-ART-003',
      category: 'INTERNAL_ERROR',
      message: 'RunManifest.duration_ms must be a non-negative number',
      details: { duration_ms: manifest.duration_ms },
      module: 'artifact-writer',
      recoverable: false,
      exitCode: 70,
    });
  }

  if (typeof manifest.seed !== 'number') {
    throw new CLIError({
      code: 'ECLI-ART-003',
      category: 'INTERNAL_ERROR',
      message: 'RunManifest.seed must be a number',
      details: { seed: manifest.seed },
      module: 'artifact-writer',
      recoverable: false,
      exitCode: 70,
    });
  }
}

/**
 * Validate all fields of an ArtifactWriterInput before any I/O.
 *
 * @throws CLIError (ECLI-ART-003) on missing or invalid input fields
 */
function validateWriteInput(input: ArtifactWriterInput): void {
  if (!input || typeof input !== 'object') {
    throw new CLIError({
      code: 'ECLI-ART-003',
      category: 'INTERNAL_ERROR',
      message: 'ArtifactWriterInput is null or not an object',
      module: 'artifact-writer',
      recoverable: false,
      exitCode: 70,
    });
  }

  validateManifestFields(input.manifest);
  validateRunId(input.manifest.run_id);

  if (typeof input.prompt !== 'string') {
    throw new CLIError({
      code: 'ECLI-ART-003',
      category: 'INTERNAL_ERROR',
      message: 'ArtifactWriterInput.prompt must be a string',
      details: { prompt_type: typeof input.prompt },
      module: 'artifact-writer',
      recoverable: false,
      exitCode: 70,
    });
  }

  if (!input.platformReceipt || typeof input.platformReceipt !== 'object') {
    throw new CLIError({
      code: 'ECLI-ART-003',
      category: 'INTERNAL_ERROR',
      message: 'ArtifactWriterInput.platformReceipt is missing or not an object',
      module: 'artifact-writer',
      recoverable: false,
      exitCode: 70,
    });
  }
}

// ============================================================================
// Safe I/O Helpers
// ============================================================================

/**
 * Safely serialize data to JSON with structured error handling.
 * Catches circular reference errors and other serialization issues.
 *
 * @throws CLIError (ECLI-ART-010) on serialization failure
 */
function safeSerialize(data: unknown, label: string, correlationId?: string): string {
  try {
    return JSON.stringify(data, null, 2);
  } catch (error: unknown) {
    throw new CLIError({
      code: 'ECLI-ART-010',
      category: 'INTERNAL_ERROR',
      message: `Failed to serialize ${label}: ${error instanceof Error ? error.message : String(error)}`,
      details: { label, data_type: typeof data },
      module: 'artifact-writer',
      correlationId,
      recoverable: false,
      exitCode: 70,
      cause: error instanceof Error ? error : undefined,
    });
  }
}

/**
 * Compute a SHA-256 checksum of UTF-8 content.
 * Returns the full 64-character hex digest.
 */
function computeChecksum(content: string): string {
  return crypto.createHash('sha256').update(content, 'utf-8').digest('hex');
}

/**
 * Write a file atomically by writing to a temp file then renaming.
 * This prevents partially-written files if the process crashes mid-write.
 *
 * The temp file is created in the same directory as the target (ensuring
 * same-filesystem rename, which is atomic on POSIX systems).
 *
 * @throws Error on I/O failure (caller wraps with CLIError)
 */
function atomicWriteFile(filePath: string, content: string, mode: number): void {
  const tmpPath = `${filePath}.tmp.${process.pid}`;
  try {
    fs.writeFileSync(tmpPath, content, { encoding: 'utf-8', mode });
    fs.renameSync(tmpPath, filePath);
  } catch (error: unknown) {
    // Best-effort cleanup of temp file on failure
    try { fs.unlinkSync(tmpPath); } catch { /* ignore cleanup error */ }
    throw error;
  }
}

/**
 * Safely read a file, returning null on any error.
 * Handles ENOENT, EACCES, and other I/O errors gracefully.
 * Used for read operations where absence is a valid state.
 */
function safeReadFile(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
}

/**
 * Safely read and parse a JSON file, returning null on any error.
 * Handles missing files, permission errors, and malformed JSON.
 */
function safeReadJsonFile<T>(filePath: string): T | null {
  const content = safeReadFile(filePath);
  if (content === null) return null;
  try {
    return JSON.parse(content) as T;
  } catch {
    return null;
  }
}

// ============================================================================
// Path Resolution
// ============================================================================

/**
 * Resolve a run directory path and verify it stays within the base directory.
 *
 * Defense-in-depth: even though validateRunId blocks traversal characters,
 * this absolute path check prevents edge cases where path.join produces
 * a path outside the base directory.
 *
 * @throws CLIError (ECLI-ART-001, ECLI-ART-002) on invalid run-id
 * @throws CLIError (ECLI-ART-002) if resolved path escapes base directory
 */
function resolveRunDir(baseDir: string, runId: string): string {
  validateRunId(runId);

  const runDir = path.join(baseDir, runId);
  const resolvedRunDir = path.resolve(runDir);
  const resolvedBase = path.resolve(baseDir);

  // Ensure resolved path is strictly inside the base directory
  if (!resolvedRunDir.startsWith(resolvedBase + path.sep) && resolvedRunDir !== resolvedBase) {
    throw new CLIError({
      code: 'ECLI-ART-002',
      category: 'INTERNAL_ERROR',
      message: 'Resolved run directory escapes base directory (path traversal prevented)',
      details: {
        run_id: runId,
        resolved_run_dir: resolvedRunDir,
        base_dir: resolvedBase,
      },
      module: 'artifact-writer',
      recoverable: false,
      exitCode: 70,
    });
  }

  return resolvedRunDir;
}

// ============================================================================
// Implementation
// ============================================================================

/**
 * Enterprise-grade artifact writer implementing the IArtifactWriter contract.
 *
 * Persists synthesis run artifacts to the local filesystem with:
 * - Atomic writes (temp-then-rename per file)
 * - SHA-256 integrity checksums
 * - Owner-only file permissions (0o600 files, 0o700 directories)
 * - Path traversal prevention
 * - Structured error handling with correlation IDs
 * - Size guards for claude_output and prompt
 * - Read-back methods for offline inspection
 * - Listing and filtering for run discovery
 */
export class ArtifactWriter implements IArtifactWriter {
  private readonly baseDir: string;

  constructor(baseDir?: string) {
    this.baseDir = baseDir
      ?? process.env['AGENTICS_RUNS_DIR']
      ?? path.join(os.homedir(), '.agentics', 'runs');
  }

  // --------------------------------------------------------------------------
  // Directory Accessors
  // --------------------------------------------------------------------------

  getRunsDir(): string {
    return this.baseDir;
  }

  getRunDir(runId: string): string {
    return resolveRunDir(this.baseDir, runId);
  }

  // --------------------------------------------------------------------------
  // Existence Check
  // --------------------------------------------------------------------------

  runExists(runId: string): boolean {
    const runDir = resolveRunDir(this.baseDir, runId);
    const manifestPath = path.join(runDir, MANIFEST_FILE);
    try {
      fs.accessSync(manifestPath, fs.constants.R_OK);
      return true;
    } catch {
      return false;
    }
  }

  // --------------------------------------------------------------------------
  // Write (ADR-008 Core Operation)
  // --------------------------------------------------------------------------

  write(input: ArtifactWriterInput): ArtifactWriteResult {
    // Phase 1: Validate all inputs (fail-fast, zero I/O)
    validateWriteInput(input);

    const correlationId = input.manifest.trace_id;
    const runDir = resolveRunDir(this.baseDir, input.manifest.run_id);
    const verbose = process.env['AGENTICS_DEV'] === '1' || process.env['AGENTICS_DEV'] === 'true';

    // Phase 2: Serialize all content BEFORE any I/O (fail-fast on circular refs)
    const manifestJson = safeSerialize(input.manifest, 'manifest', correlationId);
    const claudeOutputJson = safeSerialize(input.claudeOutput, 'claude_output', correlationId);
    const receiptJson = safeSerialize(input.platformReceipt, 'platform_receipt', correlationId);
    const promptContent = input.prompt;

    // Phase 3: Size guards
    if (claudeOutputJson.length > MAX_JSON_BYTES) {
      throw new CLIError({
        code: 'ECLI-ART-011',
        category: 'INTERNAL_ERROR',
        message: `Claude output JSON exceeds size limit (${claudeOutputJson.length} bytes > ${MAX_JSON_BYTES} bytes)`,
        details: {
          actual_bytes: claudeOutputJson.length,
          limit_bytes: MAX_JSON_BYTES,
          run_id: input.manifest.run_id,
        },
        module: 'artifact-writer',
        correlationId,
        recoverable: false,
        exitCode: 70,
      });
    }

    if (promptContent.length > MAX_PROMPT_WARN_BYTES) {
      process.stderr.write(
        `[artifact-writer] WARNING: Prompt is ${promptContent.length} bytes ` +
        `(recommended max: ${MAX_PROMPT_WARN_BYTES}). Large prompts may indicate an issue.\n`
      );
    }

    // Phase 4: Compute SHA-256 checksums for integrity verification
    const checksums: Record<string, string> = {
      [MANIFEST_FILE]: computeChecksum(manifestJson),
      [CLAUDE_OUTPUT_FILE]: computeChecksum(claudeOutputJson),
      [PLATFORM_RECEIPT_FILE]: computeChecksum(receiptJson),
      [PROMPT_FILE]: computeChecksum(promptContent),
    };

    if (verbose) {
      process.stderr.write(
        `[artifact-writer] writing run=${input.manifest.run_id} dir=${runDir} ` +
        `files=4 correlationId=${correlationId}\n`
      );
    }

    // Phase 5: Create run directory with restricted permissions
    try {
      fs.mkdirSync(runDir, { recursive: true, mode: DIR_MODE });
    } catch (error: unknown) {
      throw new CLIError({
        code: 'ECLI-ART-020',
        category: 'INTERNAL_ERROR',
        message: `Failed to create run directory: ${error instanceof Error ? error.message : String(error)}`,
        details: {
          run_dir: runDir,
          run_id: input.manifest.run_id,
          error_code: (error as { code?: string }).code,
        },
        module: 'artifact-writer',
        correlationId,
        recoverable: false,
        exitCode: 74,
        cause: error instanceof Error ? error : undefined,
      });
    }

    // Phase 6: Write artifact files (atomic temp-then-rename per file)
    const filePairs: readonly [string, string][] = [
      [MANIFEST_FILE, manifestJson],
      [CLAUDE_OUTPUT_FILE, claudeOutputJson],
      [PLATFORM_RECEIPT_FILE, receiptJson],
      [PROMPT_FILE, promptContent],
    ];

    let bytesWritten = 0;
    const filesWritten: string[] = [];

    for (const [filename, content] of filePairs) {
      const filePath = path.join(runDir, filename);
      try {
        atomicWriteFile(filePath, content, FILE_MODE);
        bytesWritten += Buffer.byteLength(content, 'utf-8');
        filesWritten.push(filename);
      } catch (error: unknown) {
        throw new CLIError({
          code: 'ECLI-ART-021',
          category: 'INTERNAL_ERROR',
          message: `Failed to write artifact "${filename}": ${error instanceof Error ? error.message : String(error)}`,
          details: {
            file: filename,
            file_path: filePath,
            run_id: input.manifest.run_id,
            files_written_before_failure: filesWritten,
            error_code: (error as { code?: string }).code,
          },
          module: 'artifact-writer',
          correlationId,
          recoverable: false,
          exitCode: 74,
          cause: error instanceof Error ? error : undefined,
        });
      }
    }

    if (verbose) {
      process.stderr.write(
        `[artifact-writer] complete: ${filesWritten.length} files, ${bytesWritten} bytes, ` +
        `checksums=[${Object.values(checksums).map(c => c.slice(0, 8)).join(',')}]\n`
      );
    }

    return {
      runDir,
      filesWritten,
      checksums,
      bytesWritten,
    };
  }

  // --------------------------------------------------------------------------
  // Read Methods (Offline Inspection)
  // --------------------------------------------------------------------------

  readManifest(runId: string): RunManifest | null {
    const runDir = resolveRunDir(this.baseDir, runId);
    return safeReadJsonFile<RunManifest>(path.join(runDir, MANIFEST_FILE));
  }

  readReceipt(runId: string): PlatformReceipt | null {
    const runDir = resolveRunDir(this.baseDir, runId);
    return safeReadJsonFile<PlatformReceipt>(path.join(runDir, PLATFORM_RECEIPT_FILE));
  }

  readClaudeOutput(runId: string): unknown {
    const runDir = resolveRunDir(this.baseDir, runId);
    return safeReadJsonFile<unknown>(path.join(runDir, CLAUDE_OUTPUT_FILE));
  }

  readPrompt(runId: string): string | null {
    const runDir = resolveRunDir(this.baseDir, runId);
    return safeReadFile(path.join(runDir, PROMPT_FILE));
  }

  // --------------------------------------------------------------------------
  // Discovery (Run Listing)
  // --------------------------------------------------------------------------

  listRuns(options?: ListRunsOptions): RunSummary[] {
    // Enumerate directories in the base runs directory
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(this.baseDir, { withFileTypes: true });
    } catch {
      // Directory doesn't exist or is unreadable → empty list
      return [];
    }

    // Filter to directories with valid run-id-like names
    const dirs = entries.filter(
      e => e.isDirectory() && SAFE_RUN_ID_PATTERN.test(e.name)
    );

    // Read manifests and apply filters
    const summaries: RunSummary[] = [];
    for (const dir of dirs) {
      const manifest = this.readManifest(dir.name);
      if (manifest === null) continue;

      // Apply command filter
      if (options?.command !== undefined && manifest.command !== options.command) continue;
      // Apply subcommand filter
      if (options?.subcommand !== undefined && manifest.subcommand !== options.subcommand) continue;

      summaries.push({
        run_id: manifest.run_id,
        command: manifest.command,
        subcommand: manifest.subcommand,
        synthesis_class: manifest.synthesis_class,
        created_at: manifest.created_at,
        model: manifest.model,
      });
    }

    // Sort by created_at (newest first by default)
    const newestFirst = options?.newestFirst !== false;
    summaries.sort((a, b) =>
      newestFirst
        ? b.created_at.localeCompare(a.created_at)
        : a.created_at.localeCompare(b.created_at)
    );

    // Apply pagination (offset + limit)
    const offset = options?.offset ?? 0;
    const limit = options?.limit ?? summaries.length;

    return summaries.slice(offset, offset + limit);
  }

  // --------------------------------------------------------------------------
  // Deletion (Cleanup)
  // --------------------------------------------------------------------------

  deleteRun(runId: string): boolean {
    const runDir = resolveRunDir(this.baseDir, runId);

    try {
      // Verify directory exists and is a directory before deletion
      const stat = fs.statSync(runDir);
      if (!stat.isDirectory()) return false;

      fs.rmSync(runDir, { recursive: true, force: true });
      return true;
    } catch {
      return false;
    }
  }
}

// ============================================================================
// Factory
// ============================================================================

/**
 * Create an IArtifactWriter instance.
 *
 * Base directory resolution order:
 * 1. Explicit `baseDir` parameter
 * 2. AGENTICS_RUNS_DIR environment variable
 * 3. ~/.agentics/runs/ (default)
 *
 * @param baseDir Optional base directory override for artifact storage
 */
export function createArtifactWriter(baseDir?: string): IArtifactWriter {
  return new ArtifactWriter(baseDir);
}
