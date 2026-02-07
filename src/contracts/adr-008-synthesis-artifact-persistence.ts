/**
 * ADR-008: Synthesis Artifact Persistence & Platform Handoff
 *
 * STATUS: Proposed
 * DATE: 2026-02-07
 * AUTHORS: Platform Engineering
 * DEPENDS-ON: ADR-006 (Runner), ADR-007 (Router), ADR-004 (Enterprise Integration)
 *
 * ============================================================================
 * CONTEXT
 * ============================================================================
 *
 * After Claude Code synthesis produces a contract-validated JSON object
 * (ADR-006 + ADR-007), two things must happen:
 *
 * 1. The result must be handed off to the platform (agentics-dev-platform)
 *    for execution, persistence, and governance tracking.
 *
 * 2. Local artifacts must be written for `agentics inspect` to read,
 *    providing an offline audit trail.
 *
 * Currently, artifacts are stored by the Ruvector-backed platform adapters
 * (src/adapters/base-adapter.ts:643-1089) and local CRUD files live in
 * .agentics/{command}s/ (e.g., .agentics/simulations/). The executive
 * synthesis tool writes a decision-summary.md but nothing else.
 *
 * This ADR defines the persistence contract for synthesis runs.
 *
 * ============================================================================
 * DECISION
 * ============================================================================
 *
 * 1. A new module `src/synthesis/artifact-writer.ts` handles local persistence.
 *
 * 2. After every successful synthesis + platform handoff, the following
 *    artifacts are written:
 *
 *    ```
 *    ~/.agentics/runs/<run-id>/
 *    ├── manifest.json         # Run metadata (IDs, timing, command, schema)
 *    ├── claude_output.json    # Raw Claude Code output (validated JSON)
 *    ├── platform_receipt.json # Platform API response (IDs, status)
 *    └── prompt.txt            # The exact prompt sent to Claude Code
 *    ```
 *
 * 3. The manifest.json structure:
 *    ```typescript
 *    interface RunManifest {
 *      run_id: string;
 *      plan_id?: string;        // If a plan was created
 *      deploy_id?: string;      // If a deployment was created
 *      command: string;
 *      subcommand: string;
 *      synthesis_class: SynthesisClass;
 *      contract_schema: string;
 *      model: string;
 *      duration_ms: number;
 *      created_at: string;
 *      seed: number;
 *      user_id: string;
 *      org_id: string;
 *      trace_id: string;
 *      artifacts: string[];     // Relative paths to sibling files
 *    }
 *    ```
 *
 * 4. Platform handoff flow:
 *    a. Synthesis router returns SynthesisResult<T>
 *    b. The command handler passes the data to the existing platform adapter
 *       (PlannerAdapter, RunnerAdapter, etc.)
 *    c. The platform responds with IDs and status
 *    d. Artifact writer persists all three files atomically
 *    e. IDs are printed to stdout
 *
 * 5. The artifact writer is idempotent: writing the same run-id twice
 *    overwrites the previous artifacts (latest wins).
 *
 * 6. `agentics inspect run <run-id>` will be enhanced to read from
 *    `~/.agentics/runs/<run-id>/manifest.json` when the run is not
 *    found in the platform (offline inspection).
 *
 * ============================================================================
 * ID GENERATION
 * ============================================================================
 *
 * Every synthesis run produces:
 * - run_id: `run-{uuid}` — unique per invocation
 * - plan_id: `plan-{uuid}` — if the command creates a plan
 * - deploy_id: `deploy-{uuid}` — if the command creates a deployment
 *
 * These are generated BEFORE calling Claude Code (so they can be embedded
 * in the prompt for determinism) and then used as the canonical identifiers
 * throughout the pipeline.
 *
 * ============================================================================
 * STORAGE PATH
 * ============================================================================
 *
 * Base directory: `~/.agentics/runs/`
 * Override: `AGENTICS_RUNS_DIR` environment variable
 *
 * This is separate from the existing `.agentics/simulations/` and
 * `.agentics/plans/` directories, which store CRUD records. The `runs/`
 * directory stores synthesis-specific artifacts.
 *
 * ============================================================================
 * FILE PERMISSIONS
 * ============================================================================
 *
 * All files written with mode 0o600 (owner read/write only), matching
 * the existing credentials.ts pattern (src/utils/credentials.ts:38-39).
 *
 * ============================================================================
 * PLATFORM RECEIPT
 * ============================================================================
 *
 * The platform_receipt.json captures the downstream response:
 *
 * ```typescript
 * interface PlatformReceipt {
 *   success: boolean;
 *   platform_id: string;       // ID assigned by platform
 *   platform_type: string;     // e.g., "PlanReference", "SimulationReference"
 *   status: string;            // e.g., "created", "queued", "completed"
 *   timestamp: string;
 *   trace_id: string;
 *   error?: string;            // If platform call failed
 * }
 * ```
 *
 * ============================================================================
 * WIRING INTO CLI DISPATCH
 * ============================================================================
 *
 * The integration modifies the command handlers in src/cli/index.ts.
 * For each decision-grade subcommand:
 *
 * ```
 * BEFORE (current):
 *   parse args → validate gates → call command executor → print output
 *                                                       → fire-and-forget synthesis
 *
 * AFTER (ADR-008):
 *   parse args → validate gates → synthesis router (Claude Code)
 *                                → call command executor (with synthesis data)
 *                                → persist artifacts
 *                                → print IDs to stdout
 * ```
 *
 * The key change: synthesis happens BEFORE the platform call, not after.
 * Claude Code produces the structured plan/intent/config, which is then
 * sent to the platform for execution.
 *
 * ============================================================================
 * ALTERNATIVES CONSIDERED
 * ============================================================================
 *
 * A. Store artifacts in the platform only (no local files):
 *    Rejected — offline inspection is a hard requirement. Users must be
 *    able to audit synthesis results without platform connectivity.
 *
 * B. Store artifacts in the existing .agentics/{command}s/ directories:
 *    Rejected — synthesis artifacts are cross-cutting (a simulation run
 *    may reference a plan). A dedicated `runs/` directory with run-id
 *    as the organizing key is cleaner.
 *
 * C. Use a SQLite database for local storage:
 *    Rejected — JSON files are simpler, greppable, and don't require
 *    additional dependencies. The volume is low (one run per command).
 *
 * ============================================================================
 * CONSEQUENCES
 * ============================================================================
 *
 * - Every synthesis run is fully auditable locally
 * - The prompt sent to Claude Code is preserved for debugging
 * - Platform receipts provide end-to-end traceability
 * - `agentics inspect run <run-id>` works offline
 * - The runs/ directory grows linearly; no automatic cleanup (user manages)
 * - New decision-grade subcommands automatically get artifact persistence
 *   if they follow the synthesis router integration pattern
 */

// ============================================================================
// Type Exports
// ============================================================================

export interface RunManifest {
  readonly run_id: string;
  readonly plan_id?: string;
  readonly deploy_id?: string;
  readonly simulation_id?: string;
  readonly command: string;
  readonly subcommand: string;
  readonly synthesis_class: 'SYNTHESIS_REQUIRED' | 'COMMITMENT_GRADE';
  readonly contract_schema: string;
  readonly model: string;
  readonly duration_ms: number;
  readonly created_at: string;
  readonly seed: number;
  readonly user_id: string;
  readonly org_id: string;
  readonly trace_id: string;
  readonly artifacts: readonly string[];
}

export interface PlatformReceipt {
  readonly success: boolean;
  readonly platform_id: string;
  readonly platform_type: string;
  readonly status: string;
  readonly timestamp: string;
  readonly trace_id: string;
  readonly error?: string;
}

export interface ArtifactWriterInput {
  readonly manifest: RunManifest;
  readonly claudeOutput: unknown;
  readonly platformReceipt: PlatformReceipt;
  readonly prompt: string;
}

/**
 * Result of a successful artifact write operation.
 * Contains the run directory path, file list, checksums, and byte count
 * for verification and diagnostics.
 */
export interface ArtifactWriteResult {
  /** Absolute path to the run directory */
  readonly runDir: string;
  /** List of artifact filenames written (relative to runDir) */
  readonly filesWritten: readonly string[];
  /** SHA-256 checksums keyed by filename for integrity verification */
  readonly checksums: Readonly<Record<string, string>>;
  /** Total bytes written across all artifact files */
  readonly bytesWritten: number;
}

/**
 * Lightweight summary of a synthesis run for listing and filtering.
 * Contains only the fields needed for discovery; use readManifest()
 * to get the full RunManifest.
 */
export interface RunSummary {
  readonly run_id: string;
  readonly command: string;
  readonly subcommand: string;
  readonly synthesis_class: 'SYNTHESIS_REQUIRED' | 'COMMITMENT_GRADE';
  readonly created_at: string;
  readonly model: string;
}

/**
 * Options for listing synthesis runs with filtering and pagination.
 */
export interface ListRunsOptions {
  /** Maximum number of runs to return */
  readonly limit?: number;
  /** Number of runs to skip (for pagination) */
  readonly offset?: number;
  /** Filter to runs for this command */
  readonly command?: string;
  /** Filter to runs for this subcommand */
  readonly subcommand?: string;
  /** Sort order: true = newest first (default), false = oldest first */
  readonly newestFirst?: boolean;
}

/** The four canonical artifact file types in every run directory */
export type ArtifactFileType = 'manifest' | 'claude_output' | 'platform_receipt' | 'prompt';

export interface IArtifactWriter {
  /**
   * Write all synthesis artifacts for a run.
   * Creates the run directory and writes all four files atomically
   * (temp-then-rename per file). Idempotent: re-writing the same
   * run-id overwrites previous artifacts.
   *
   * @returns Write result with run directory path, checksums, and byte count
   * @throws CLIError (ECLI-ART-001..003) on invalid input
   * @throws CLIError (ECLI-ART-010..011) on serialization/size errors
   * @throws CLIError (ECLI-ART-020..021) on I/O failures
   */
  write(input: ArtifactWriterInput): ArtifactWriteResult;

  /**
   * Read a run manifest by run-id.
   * @returns The manifest or null if not found or unreadable
   */
  readManifest(runId: string): RunManifest | null;

  /**
   * Read the platform receipt for a run.
   * @returns The receipt or null if not found or unreadable
   */
  readReceipt(runId: string): PlatformReceipt | null;

  /**
   * Read the raw Claude Code output for a run.
   * @returns The parsed JSON output or null if not found or unreadable
   */
  readClaudeOutput(runId: string): unknown;

  /**
   * Read the prompt text that was sent to Claude Code for a run.
   * @returns The prompt string or null if not found or unreadable
   */
  readPrompt(runId: string): string | null;

  /**
   * List synthesis runs with optional filtering and pagination.
   * Reads manifest files from the runs directory, sorted by created_at.
   * @returns Array of run summaries (may be empty if no runs or directory missing)
   */
  listRuns(options?: ListRunsOptions): RunSummary[];

  /**
   * Check if a run exists (has a readable manifest file).
   * Fast stat-based check without reading the full manifest.
   */
  runExists(runId: string): boolean;

  /**
   * Get the base directory for all runs.
   */
  getRunsDir(): string;

  /**
   * Get the absolute path to a specific run's directory.
   * Validates the run-id format and prevents path traversal.
   * @throws CLIError (ECLI-ART-001..002) on invalid run-id
   */
  getRunDir(runId: string): string;

  /**
   * Delete a run and all its artifacts.
   * Removes the entire run directory recursively.
   * @returns true if the run was deleted, false if not found
   * @throws CLIError (ECLI-ART-001..002) on invalid run-id
   */
  deleteRun(runId: string): boolean;
}
