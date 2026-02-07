/**
 * ADR-007: Subcommand-Aware Synthesis Router
 *
 * STATUS: Proposed
 * DATE: 2026-02-07
 * AUTHORS: Platform Engineering
 * DEPENDS-ON: ADR-001 (Command Semantics), ADR-006 (Claude Code Runner)
 *
 * ============================================================================
 * CONTEXT
 * ============================================================================
 *
 * ADR-001 defines a COMMAND_REGISTRY with synthesis governance classifications:
 * - SYNTHESIS_REQUIRED: LLM invocation expected
 * - SYNTHESIS_FORBIDDEN: Must NEVER trigger synthesis
 * - COMMITMENT_GRADE: Requires ID + confirmation + synthesis
 *
 * The current CLI dispatches commands via a monolithic switch statement in
 * src/cli/index.ts. Decision-grade subcommands call their respective
 * command executors (executePlanCreateCommand, executeSimulateRunCommand, etc.)
 * which talk to the platform API. The executive synthesis tool fires as an
 * afterthought (fire-and-forget detached process).
 *
 * What's missing is a routing layer that sits BETWEEN argument parsing and
 * command execution, intercepting decision-grade subcommands to:
 * 1. Construct a subcommand-specific prompt
 * 2. Call Claude Code Runner (ADR-006)
 * 3. Validate the output
 * 4. Feed it into the platform pipeline
 *
 * ============================================================================
 * DECISION
 * ============================================================================
 *
 * 1. A new module `src/synthesis/router.ts` will implement the synthesis
 *    routing layer.
 *
 * 2. The router takes a SynthesisRequest:
 *    ```typescript
 *    interface SynthesisRequest {
 *      command: string;          // e.g. "simulate"
 *      subcommand: string;       // e.g. "create"
 *      positionalArgs: string[]; // from parsed CLI args
 *      options: Record<string, string>;
 *      flags: Record<string, boolean>;
 *      userContext: {
 *        userId: string;
 *        orgId: string;
 *        traceId: string;
 *      };
 *    }
 *    ```
 *
 * 3. Routing logic:
 *    a. Look up (command, subcommand) in ADR-001 COMMAND_REGISTRY
 *    b. If synthesis === 'SYNTHESIS_FORBIDDEN', return null immediately
 *    c. If synthesis === 'SYNTHESIS_REQUIRED' or 'COMMITMENT_GRADE':
 *       i.   Generate a run-id (UUID v4)
 *       ii.  Load the prompt template for this (command, subcommand)
 *       iii. Inject arguments, context, run-id, and contract requirements
 *       iv.  Call ClaudeCodeRunner.invoke()
 *       v.   Return the validated SynthesisResult
 *
 * 4. SynthesisResult structure:
 *    ```typescript
 *    interface SynthesisResult<T> {
 *      data: T;                    // Contract-validated output
 *      runId: string;              // UUID for this synthesis run
 *      command: string;
 *      subcommand: string;
 *      model: string;              // Model used
 *      durationMs: number;
 *      contractSchema: string;     // Schema name used for validation
 *    }
 *    ```
 *
 * 5. The router is a pure function with no side effects beyond calling
 *    ClaudeCodeRunner. It does NOT:
 *    - Write artifacts (that's ADR-008)
 *    - Call the platform API (that's the command executor)
 *    - Modify CLI state
 *
 * ============================================================================
 * PROMPT TEMPLATE SYSTEM
 * ============================================================================
 *
 * 1. Templates live in `src/synthesis/prompts/` as exported string constants
 *    (not .txt files — TypeScript provides compile-time safety and tree-shaking).
 *
 * 2. Each template is a function: (args: PromptArgs) => string
 *
 * 3. PromptArgs includes:
 *    - runId: string
 *    - seed: number
 *    - command: string
 *    - subcommand: string
 *    - positionalArgs: string[]
 *    - contractSchemaName: string
 *    - contractSchemaFields: string (human-readable field list)
 *
 * 4. Every template MUST include:
 *    - "Respond ONLY with a JSON object. No prose, no markdown, no explanation."
 *    - The exact contract schema name
 *    - The run-id and seed
 *    - The required fields for the output schema
 *
 * 5. Template naming: `{command}_{subcommand}` (e.g., simulate_create)
 *
 * ============================================================================
 * DECISION-GRADE SUBCOMMAND MATRIX
 * ============================================================================
 *
 * | Command   | Subcommand | Synthesis Class      | Contract Schema  |
 * |-----------|------------|----------------------|------------------|
 * | simulate  | create     | SYNTHESIS_REQUIRED   | simulation       |
 * | simulate  | run        | COMMITMENT_GRADE     | simulation       |
 * | plan      | create     | SYNTHESIS_REQUIRED   | plan             |
 * | plan      | approve    | COMMITMENT_GRADE     | plan             |
 * | deploy    | preview    | SYNTHESIS_REQUIRED   | intent           |
 * | deploy    | run        | COMMITMENT_GRADE     | intent           |
 * | deploy    | rollback   | COMMITMENT_GRADE     | intent           |
 * | export    | terraform  | SYNTHESIS_REQUIRED   | export           |
 * | export    | kubernetes | SYNTHESIS_REQUIRED   | export           |
 * | export    | erp        | SYNTHESIS_REQUIRED   | export           |
 * | policy    | create     | SYNTHESIS_REQUIRED   | base             |
 * | policy    | edit       | SYNTHESIS_REQUIRED   | base             |
 * | policy    | enable     | COMMITMENT_GRADE     | base             |
 * | policy    | disable    | SYNTHESIS_REQUIRED   | base             |
 * | policy    | dry-run    | SYNTHESIS_REQUIRED   | base             |
 * | quantify  | create     | SYNTHESIS_REQUIRED   | roiReport        |
 * | quantify  | compare    | COMMITMENT_GRADE     | roiReport        |
 * | erp       | surface    | SYNTHESIS_REQUIRED   | base             |
 * | erp       | map        | SYNTHESIS_REQUIRED   | base             |
 * | erp       | export     | SYNTHESIS_REQUIRED   | export           |
 *
 * All other (command, subcommand) combinations return null from the router.
 *
 * ============================================================================
 * INTEGRATION POINT
 * ============================================================================
 *
 * The router is called from the CLI dispatch in src/cli/index.ts.
 * The integration follows this pattern:
 *
 * ```typescript
 * // In the command handler (e.g., simulate create)
 * const synthesisResult = synthesisRouter.route({
 *   command: parsed.command,
 *   subcommand: parsed.subcommand,
 *   positionalArgs: parsed.positionalArgs,
 *   options: parsed.options,
 *   flags: parsed.flags,
 *   userContext: { userId, orgId, traceId },
 * });
 *
 * if (synthesisResult) {
 *   // Decision-grade: use Claude Code output
 *   const platformResult = await executeWithSynthesis(synthesisResult);
 *   await persistArtifacts(synthesisResult, platformResult);
 * } else {
 *   // Non-synthesis: proceed with existing command handler
 *   await executeExistingHandler(...);
 * }
 * ```
 *
 * ============================================================================
 * ALTERNATIVES CONSIDERED
 * ============================================================================
 *
 * A. Middleware-based routing (intercept all commands):
 *    Rejected — synthesis is the exception, not the rule. A middleware
 *    pattern would add overhead to every command, including the majority
 *    that are SYNTHESIS_FORBIDDEN.
 *
 * B. Prompt templates as external .txt files:
 *    Rejected — TypeScript functions provide compile-time safety,
 *    argument validation, and can reference contract types. External
 *    files would need a runtime loader and lose type safety.
 *
 * C. One giant prompt for all subcommands:
 *    Rejected — each subcommand has unique argument shapes, contract
 *    schemas, and domain-specific instructions. Specialized prompts
 *    produce better-structured output.
 *
 * ============================================================================
 * CONSEQUENCES
 * ============================================================================
 *
 * - Every decision-grade subcommand gets exactly one Claude Code call
 * - Non-decision commands have zero synthesis overhead
 * - Prompt templates are version-controlled and type-safe
 * - New decision-grade subcommands require:
 *   a. ADR-001 COMMAND_REGISTRY entry with SYNTHESIS_REQUIRED/COMMITMENT_GRADE
 *   b. ADR-006 SYNTHESIS_SCHEMA_MAP entry
 *   c. A prompt template function in src/synthesis/prompts/
 *   d. CLI handler integration per the pattern above
 * - The router is stateless and testable in isolation
 */

// ============================================================================
// Type Exports
// ============================================================================

/**
 * Narrowed synthesis governance class for decision-grade subcommands.
 * SYNTHESIS_FORBIDDEN commands never reach the router — only these two are valid.
 */
export type SynthesisGovernanceClass = 'SYNTHESIS_REQUIRED' | 'COMMITMENT_GRADE';

export interface SynthesisRequest {
  readonly command: string;
  readonly subcommand: string;
  readonly positionalArgs: readonly string[];
  readonly options: Readonly<Record<string, string>>;
  readonly flags: Readonly<Record<string, boolean>>;
  readonly userContext: {
    readonly userId: string;
    readonly orgId: string;
    readonly traceId: string;
  };
}

export interface SynthesisResult<T = unknown> {
  /** Contract-validated output from Claude Code */
  readonly data: T;
  /** UUID for this synthesis run */
  readonly runId: string;
  /** Primary command */
  readonly command: string;
  /** Subcommand */
  readonly subcommand: string;
  /** Model used for synthesis */
  readonly model: string;
  /** Duration of Claude Code invocation */
  readonly durationMs: number;
  /** Contract schema used for validation */
  readonly contractSchema: string;
  /** Raw Claude Code output (for artifact persistence) */
  readonly rawOutput: string;
  /** ADR-001 synthesis governance classification */
  readonly synthesisClass: SynthesisGovernanceClass;
  /** The prompt that was sent to Claude Code (for artifact persistence and debugging) */
  readonly prompt: string;
}

export interface PromptArgs {
  readonly runId: string;
  readonly seed: number;
  readonly command: string;
  readonly subcommand: string;
  readonly positionalArgs: readonly string[];
  readonly options: Readonly<Record<string, string>>;
  readonly contractSchemaName: string;
}

/** Type for prompt template functions */
export type PromptTemplate = (args: PromptArgs) => string;

/**
 * Result of building a synthesis prompt without invoking Claude Code.
 * Used for dry-run mode and testing.
 */
export interface SynthesisPromptResult {
  /** The fully-constructed prompt string */
  readonly prompt: string;
  /** Generated run identifier */
  readonly runId: string;
  /** Generated seed for determinism */
  readonly seed: number;
  /** The (command.subcommand) routing key */
  readonly key: string;
  /** Contract schema name for validation */
  readonly contractSchema: string;
  /** ADR-001 synthesis governance classification */
  readonly synthesisClass: SynthesisGovernanceClass;
}

/**
 * The decision-grade subcommand set.
 * This is the canonical list; any subcommand NOT in this set
 * must NEVER trigger Claude Code invocation.
 */
export const DECISION_GRADE_SUBCOMMANDS: ReadonlySet<string> = new Set([
  'simulate.create',
  'simulate.run',
  'plan.create',
  'plan.approve',
  'deploy.preview',
  'deploy.run',
  'deploy.rollback',
  'export.terraform',
  'export.kubernetes',
  'export.erp',
  'policy.create',
  'policy.edit',
  'policy.enable',
  'policy.disable',
  'policy.dry-run',
  'quantify.create',
  'quantify.compare',
  'erp.surface',
  'erp.map',
  'erp.export',
]);
