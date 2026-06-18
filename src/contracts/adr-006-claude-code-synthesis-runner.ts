/**
 * ADR-006: Claude Code Synthesis Runner — Subprocess Invocation & Contract Binding
 *
 * STATUS: Proposed
 * DATE: 2026-02-07
 * AUTHORS: Platform Engineering
 * DEPENDS-ON: ADR-001 (Command Semantics), ADR-002 (Operational Enforcement)
 *
 * ============================================================================
 * CONTEXT
 * ============================================================================
 *
 * The Agentics CLI needs to invoke Claude Code (the locally-installed Claude
 * CLI binary) for decision-grade subcommands. This is modeled after how
 * Claude Flow performs a single synthesis+plan step per command invocation.
 *
 * Currently, the CLI has an "executive synthesis" tool that runs as a detached
 * fire-and-forget process (src/cli/index.ts:42-67). This is insufficient:
 *
 * - It does not capture Claude Code's output synchronously
 * - It does not validate output against contract schemas
 * - It is not subcommand-aware (fires on all commands that produce output)
 * - It cannot feed structured JSON into the platform pipeline
 *
 * We need a focused module that:
 * 1. Detects the Claude Code binary (claude, claude-code, or env-configured)
 * 2. Invokes it synchronously via child_process.execFileSync or spawn+await
 * 3. Sends a structured prompt via --print flag (non-interactive, JSON output)
 * 4. Captures stdout, strips code fences, parses JSON
 * 5. Validates against the agentics-contracts schema for that subcommand
 * 6. Returns the typed object for downstream pipeline consumption
 *
 * ============================================================================
 * DECISION
 * ============================================================================
 *
 * 1. A new module `src/runtime/claude-code-runner.ts` will be created.
 *
 * 2. It will use Node.js `child_process.execFileSync` for synchronous
 *    single-invocation semantics (one call per decision command).
 *
 * 3. The binary is resolved in order:
 *    a. AGENTICS_CLAUDE_BIN environment variable (explicit path)
 *    b. `claude` on PATH (standard Claude Code CLI)
 *    c. `claude-code` on PATH (alternate binary name)
 *    If none found, throw a CLIError with code ECLI-SYNTH-001.
 *
 * 4. Invocation uses the `--print` flag for non-interactive JSON output:
 *    ```
 *    claude --print --output-format json --model <model> "<prompt>"
 *    ```
 *    The prompt is a single string constructed by the synthesis router.
 *
 * 5. Environment variables supported:
 *    - AGENTICS_CLAUDE_BIN: Override binary path
 *    - AGENTICS_CLAUDE_MODEL: Override model (default: sonnet)
 *    - AGENTICS_CLAUDE_TIMEOUT_MS: Timeout (default: 120000)
 *    - AGENTICS_DEV: When set, enables verbose debug output to stderr
 *
 * 6. Output processing:
 *    a. Capture stdout as string
 *    b. Strip markdown code fences if present (```json ... ```)
 *    c. JSON.parse the result
 *    d. Validate against the contract schema for the given subcommand
 *    e. Return typed object or throw ContractValidationError
 *
 * 7. Each invocation includes a run-id and seed in the prompt for
 *    determinism and traceability.
 *
 * ============================================================================
 * INTERFACE CONTRACT
 * ============================================================================
 *
 * ```typescript
 * interface ClaudeCodeRunnerOptions {
 *   model?: string;
 *   timeoutMs?: number;
 *   runId: string;
 *   seed?: number;
 *   verbose?: boolean;
 * }
 *
 * interface ClaudeCodeRunnerResult<T> {
 *   data: T;
 *   runId: string;
 *   model: string;
 *   durationMs: number;
 *   rawOutput: string;
 * }
 *
 * interface IClaudeCodeRunner {
 *   resolve(): string;  // Returns binary path or throws
 *   invoke<T>(prompt: string, options: ClaudeCodeRunnerOptions): ClaudeCodeRunnerResult<T>;
 * }
 * ```
 *
 * ============================================================================
 * ERROR CODES
 * ============================================================================
 *
 * | Code              | Meaning                                     | Exit |
 * |-------------------|---------------------------------------------|------|
 * | ECLI-SYNTH-001    | Claude Code binary not found                | 127  |
 * | ECLI-SYNTH-002    | Claude Code invocation failed (non-zero)    | 1    |
 * | ECLI-SYNTH-003    | Output is not valid JSON                    | 140  |
 * | ECLI-SYNTH-004    | Output failed contract validation           | 140  |
 * | ECLI-SYNTH-005    | Invocation timed out                        | 124  |
 *
 * ============================================================================
 * ALTERNATIVES CONSIDERED
 * ============================================================================
 *
 * A. Use the Anthropic API directly (HTTP client):
 *    Rejected — the requirement is to use the locally-installed Claude Code
 *    binary, matching Claude Flow's execution model. This also avoids
 *    managing API keys in the CLI when Claude Code already handles auth.
 *
 * B. Use the existing executive-synthesis detached process:
 *    Rejected — fire-and-forget cannot feed results into the platform
 *    pipeline. Synchronous capture is required.
 *
 * C. Use stdin piping instead of --print flag:
 *    Rejected — --print is the Claude Code standard for non-interactive
 *    programmatic use. Stdin piping is for interactive sessions.
 *
 * ============================================================================
 * CONSEQUENCES
 * ============================================================================
 *
 * - Claude Code must be installed locally for decision-grade commands
 * - Commands that are SYNTHESIS_FORBIDDEN never invoke this module
 * - Each decision-grade invocation has exactly one Claude Code call
 * - All outputs are contract-validated before reaching the platform
 * - Binary resolution is deterministic and debuggable via AGENTICS_DEV
 *
 * ============================================================================
 * SECURITY CONSIDERATIONS
 * ============================================================================
 *
 * - The prompt is constructed entirely from CLI arguments and templates;
 *   no user input is interpolated without sanitization.
 * - The Claude Code binary inherits the user's environment but no
 *   additional secrets are passed beyond what's already in the shell.
 * - Output is validated against a strict schema; malformed output is
 *   rejected with ECLI-SYNTH-003/004.
 * - Timeout prevents runaway processes.
 */

// ============================================================================
// Type Exports (for use by other modules)
// ============================================================================

export interface ClaudeCodeRunnerOptions {
  /** Model override (default: from env or claude-sonnet-4-20250514) */
  readonly model?: string;
  /** Timeout in milliseconds (default: 120000) */
  readonly timeoutMs?: number;
  /** Unique run identifier for traceability */
  readonly runId: string;
  /** Seed for deterministic output (optional) */
  readonly seed?: number;
  /** Enable verbose debug output */
  readonly verbose?: boolean;
  /** Schema key (command.subcommand) for contract validation of output */
  readonly schemaKey?: string;
  /** Correlation ID for distributed tracing across the platform pipeline */
  readonly correlationId?: string;
}

export interface ClaudeCodeRunnerResult<T> {
  /** Validated, typed output data */
  readonly data: T;
  /** Run identifier */
  readonly runId: string;
  /** Model used */
  readonly model: string;
  /** Duration of Claude Code invocation in ms */
  readonly durationMs: number;
  /** Raw stdout captured from Claude Code */
  readonly rawOutput: string;
}

export interface IClaudeCodeRunner {
  /**
   * Resolve the Claude Code binary path.
   * @throws CLIError with ECLI-SYNTH-001 if not found
   */
  resolve(): string;

  /**
   * Invoke Claude Code with a prompt and return validated output.
   * @throws CLIError with ECLI-SYNTH-002 through ECLI-SYNTH-005 on failure
   */
  invoke<T>(prompt: string, options: ClaudeCodeRunnerOptions): ClaudeCodeRunnerResult<T>;
}

/**
 * Schema mapping: maps (command, subcommand) to the response schema name
 * used for validating Claude Code output.
 *
 * This is the bridge between ADR-001 command semantics and the contract
 * validator. Each decision-grade subcommand maps to exactly one schema.
 */
export const SYNTHESIS_SCHEMA_MAP: Readonly<Record<string, string>> = {
  'simulate.create': 'simulation',
  'simulate.run': 'simulation',
  'plan.create': 'plan',
  'plan.approve': 'plan',
  'deploy.preview': 'intent',
  'deploy.run': 'intent',
  'deploy.rollback': 'intent',
  'export.terraform': 'export',
  'export.kubernetes': 'export',
  'export.erp': 'export',
  'policy.create': 'base',
  'policy.edit': 'base',
  'policy.enable': 'base',
  'policy.disable': 'base',
  'policy.dry-run': 'base',
  'quantify.create': 'roiReport',
  'quantify.compare': 'roiReport',
  'erp.surface': 'base',
  'erp.map': 'base',
  'erp.export': 'export',
} as const;
