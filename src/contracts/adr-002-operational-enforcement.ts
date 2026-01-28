/**
 * ADR-002: Operational Enforcement of CLI Governance
 *
 * STATUS: Accepted
 * DATE: 2026-01-28
 * AUTHORS: Platform Engineering
 * SUPERSEDES: None
 * DEPENDS ON: ADR-001 (Command Argument Semantics & Synthesis Governance)
 *
 * ============================================================================
 * CONTEXT
 * ============================================================================
 *
 * ADR-001 defines the semantic rules for the Agentics CLI:
 * - Argument type classification (ID, NATURAL_LANGUAGE, SELECTOR)
 * - Synthesis governance (REQUIRED, FORBIDDEN, COMMITMENT_GRADE)
 * - Command contracts (argument specs, irreversibility, confirmation)
 *
 * However, ADRs without mechanical enforcement drift. Without a runtime
 * enforcement layer, schema-driven CI, and regression controls:
 *
 * - Developers add commands without registering them in the ADR
 * - Validation logic diverges from the declared contract
 * - Help text lies about argument types
 * - Tests don't cover argument contract violations
 * - New gate bypass paths appear without review
 *
 * This ADR defines how ADR-001 governance becomes executable and
 * continuously enforced. It does NOT redefine command semantics.
 *
 * ============================================================================
 * DECISION 1: MACHINE-READABLE ADR SCHEMA
 * ============================================================================
 *
 * The COMMAND_REGISTRY in adr-command-semantics.ts IS the machine-readable
 * schema. This decision formalizes it as the single source of truth and
 * defines the contract it must satisfy.
 *
 * The schema (COMMAND_REGISTRY) MUST:
 *
 * 1. BE VERSIONED
 *    - The registry exports an ADR_SCHEMA_VERSION constant
 *    - Version follows semver: MAJOR.MINOR.PATCH
 *    - MAJOR: breaking argument contract changes
 *    - MINOR: new commands or optional fields
 *    - PATCH: help text or example corrections
 *
 * 2. BE HUMAN-AUDITABLE
 *    - TypeScript source with JSDoc comments on every command group
 *    - Grouped by domain (identity, simulation, planning, etc.)
 *    - No generated code — hand-authored and reviewed
 *
 * 3. BE DIFF-FRIENDLY
 *    - One command per object literal
 *    - Consistent field ordering: command, primary, subcommand,
 *      description, synthesis, args, irreversible, requiresConfirmation
 *    - Readonly arrays and properties prevent accidental mutation
 *
 * 4. BE LOADABLE AT RUNTIME
 *    - Imported by the argument-guard gate at CLI startup
 *    - Imported by the help renderer for usage generation
 *    - No file I/O or dynamic loading — compile-time resolution
 *
 * 5. BE CONSUMABLE BY:
 *    - CLI validation middleware (argument-guard.ts)
 *    - Unit test generation (schema-derived test cases)
 *    - Help / usage rendering (help-renderer.ts)
 *    - CI checks (schema completeness assertions)
 *
 * EXPLICITLY PROHIBITED:
 *
 * - Hard-coding validation rules outside the registry
 *   (all rules flow from COMMAND_REGISTRY → argument-guard.ts)
 *
 * - Divergent definitions across layers
 *   (help text, error messages, tests all read from COMMAND_REGISTRY)
 *
 * - Inline command specs in switch/case dispatch
 *   (cli/index.ts dispatches, contracts/adr-command-semantics.ts defines)
 *
 * ============================================================================
 * DECISION 2: CLI ENTRYPOINT VALIDATION MIDDLEWARE
 * ============================================================================
 *
 * A single validation middleware layer (the Argument Guard Gate) exists at
 * the CLI entrypoint. This decision formalizes its position, behavior, and
 * invariants.
 *
 * LOCATION:
 *   src/gates/argument-guard.ts
 *
 * LOADING:
 *   The guard imports COMMAND_REGISTRY from adr-command-semantics.ts
 *   at module initialization. No lazy loading. No fallback registry.
 *
 * EXECUTION ORDER (within the 5-gate pipeline):
 *   Gate 1: Execution Gate      — kill-switch / entitlement check
 *   Gate 2: Auth Session Gate   — requires authenticated session
 *   Gate 3: Service Health Gate — validates backend availability
 *   Gate 4: Output Format Gate  — enforces structured output
 *   Gate 5: Argument Guard Gate — ADR-001 contract enforcement ← THIS
 *
 * The Argument Guard Gate MUST:
 *
 * 1. Load the ADR schema (COMMAND_REGISTRY) at import time
 *
 * 2. Validate arguments BEFORE command execution:
 *    a. Look up the command+subcommand in the registry
 *    b. Verify required arguments are present
 *    c. Classify each argument (ID / NATURAL_LANGUAGE / SELECTOR)
 *    d. Reject type mismatches (e.g., NL where ID expected)
 *
 * 3. Enforce synthesis governance:
 *    a. SYNTHESIS_FORBIDDEN commands MUST reject NL arguments
 *    b. SYNTHESIS_REQUIRED commands MUST accept NL arguments
 *    c. COMMITMENT_GRADE commands MUST require ID + confirmation
 *
 * 4. Enforce irreversible action constraints:
 *    a. Commands marked irreversible: true MUST require --force
 *       or interactive confirmation before execution
 *    b. Commands marked requiresConfirmation: true MUST NOT proceed
 *       without explicit user consent
 *
 * 5. Block execution on violation:
 *    a. Exit with EXIT_CODES.ARG_VALIDATION_ERROR (100)
 *    b. Print deterministic, instructional error to stderr
 *    c. Include: expected type, received value, usage example
 *
 * 6. Produce deterministic, instructional errors:
 *    a. Error message format is fixed, not generated by LLM
 *    b. Includes: command name, expected argument spec, example
 *    c. No suggestions, no "did you mean", no inference
 *
 * BEHAVIORAL RULES:
 *
 * - Validation happens BEFORE any LLM call
 * - Validation happens BEFORE any state mutation
 * - Validation happens BEFORE any network request
 * - No inference or correction of user input
 * - No interactive fallback ("did you mean X?")
 * - No partial execution on validation failure
 * - Middleware is mandatory for all non-exempt commands
 *   (exempt: help, version)
 *
 * ARCHITECTURAL CONSTRAINT:
 *
 * All CLI commands MUST pass through the 5-gate pipeline.
 * No bypass paths are allowed. The gate enforcement order in
 * src/cli/index.ts is the ONLY execution path.
 *
 * Any code path that dispatches a command without passing through
 * all 5 gates is a bug.
 *
 * ============================================================================
 * DECISION 3: CI / REGRESSION ENFORCEMENT
 * ============================================================================
 *
 * CI enforcement guarantees the CLI cannot drift from the ADR schema.
 *
 * CI RESPONSIBILITIES:
 *
 * 1. VALIDATE THE ADR SCHEMA ITSELF
 *    - Every CommandSpec has all required fields
 *    - Every command string matches the format "primary subcommand"
 *    - No duplicate command entries
 *    - All ArgumentSpec entries have valid type, name, example
 *    - Schema version constant is present and valid semver
 *
 * 2. ENSURE EVERY CLI COMMAND IS DECLARED IN THE SCHEMA
 *    - Parse the switch/case dispatch in src/cli/index.ts
 *    - For each case label, assert a matching COMMAND_REGISTRY entry exists
 *    - For each subcommand branch, assert the primary+subcommand pair exists
 *    - FAIL if a dispatch path exists without a schema entry
 *
 * 3. ENSURE EVERY SCHEMA ENTRY HAS AN IMPLEMENTATION
 *    - For each COMMAND_REGISTRY entry, assert a matching dispatch path
 *    - FAIL if a schema entry exists without implementation
 *    - This prevents "dead" registry entries that mislead auditors
 *
 * 4. ENSURE HELP OUTPUT IS GENERATED FROM THE SCHEMA
 *    - The help renderer MUST consume COMMAND_REGISTRY
 *    - Help text for argument types, descriptions, and examples
 *      MUST match the registry verbatim
 *    - Snapshot tests capture help output and detect drift
 *
 * 5. RUN COMMAND-LEVEL TESTS DERIVED FROM THE SCHEMA
 *    - For each command with args[].type === 'ID':
 *      Assert NL input is rejected with ARG_VALIDATION_ERROR
 *    - For each command with synthesis === 'SYNTHESIS_FORBIDDEN':
 *      Assert NL arguments are rejected
 *    - For each command with irreversible === true:
 *      Assert --force is required
 *    - For each command with required args:
 *      Assert missing args produce instructional errors
 *
 * 6. FAIL BUILDS IF:
 *    - A command exists in dispatch without a schema entry
 *    - A schema entry exists without a dispatch implementation
 *    - Argument contracts change without ADR schema version bump
 *    - Help output snapshot changes without schema change
 *    - Argument Guard gate is bypassed in any code path
 *
 * REQUIRED CI ARTIFACTS:
 *
 * a. Schema validation tests
 *    Location: tests/unit/contracts/adr-schema-validation.test.ts
 *    Validates COMMAND_REGISTRY structural integrity
 *
 * b. Generated command behavior tests
 *    Location: tests/unit/contracts/adr-command-behavior.test.ts
 *    Auto-generates test cases from COMMAND_REGISTRY entries
 *
 * c. Snapshot tests for help output
 *    Location: tests/unit/contracts/adr-help-snapshot.test.ts
 *    Captures and compares help text against schema
 *
 * d. ADR version compatibility checks
 *    Location: tests/unit/contracts/adr-version-compat.test.ts
 *    Validates schema version constant and changelog
 *
 * e. Gate bypass detection
 *    Location: tests/unit/contracts/adr-gate-bypass.test.ts
 *    Static analysis to ensure no command dispatch without gate pipeline
 *
 * CI EXECUTION TIMING:
 *
 * - ON PULL REQUEST: all schema validation + behavior tests
 * - ON MERGE TO MAIN: full suite + snapshot comparison + bypass detection
 * - ON RELEASE: version compatibility check + schema export artifact
 *
 * DEVELOPER FEEDBACK LOOP:
 *
 * When CI fails due to an ADR violation:
 * 1. Error message identifies the specific violation type
 * 2. Error message references the ADR decision number
 * 3. Error message provides the exact fix required
 * 4. No ambiguity — the fix is mechanical, not judgmental
 *
 * Example CI failure message:
 *
 *   ADR-002 VIOLATION: Command 'notify send' exists in CLI dispatch
 *   (src/cli/index.ts:847) but has no COMMAND_REGISTRY entry.
 *
 *   Fix: Add a CommandSpec to COMMAND_REGISTRY in
 *   src/contracts/adr-command-semantics.ts for 'notify send'.
 *
 *   See: ADR-002, Decision 3, Rule 2
 *
 * ============================================================================
 * CONSEQUENCES
 * ============================================================================
 *
 * POSITIVE:
 *
 * - Changing CLI behavior REQUIRES changing the schema first
 * - Breaking the schema breaks CI — no silent drift
 * - Help text cannot lie — it's derived from the same registry
 * - Validation cannot be bypassed — gate pipeline is enforced
 * - The CLI behaves deterministically, like claude-flow / claude-code
 * - New commands cannot ship without full ADR registration
 * - Argument type mismatches are caught before any side effects
 * - Test coverage for argument contracts is mechanically complete
 *
 * NEGATIVE:
 *
 * - Adding a new command requires touching 3 files minimum:
 *   1. adr-command-semantics.ts (schema registration)
 *   2. cli/index.ts (dispatch implementation)
 *   3. commands/<name>.ts (command handler)
 *   This is intentional friction that prevents undocumented commands.
 *
 * - Schema version bumps are required for any argument contract change.
 *   This is intentional — argument contracts are API surfaces.
 *
 * - CI will reject PRs that add commands without schema entries.
 *   This is the desired behavior, not a limitation.
 *
 * ============================================================================
 * EXPLICIT CONSTRAINTS
 * ============================================================================
 *
 * 1. The Argument Guard gate MUST NOT perform inference.
 *    It validates. It does not guess, suggest, or correct.
 *
 * 2. The COMMAND_REGISTRY MUST be the sole source of truth for:
 *    - Which commands exist
 *    - What arguments each command accepts
 *    - What argument types are expected
 *    - Whether synthesis is allowed
 *    - Whether the command is irreversible
 *    - Whether confirmation is required
 *
 * 3. No validation logic may exist outside the gate pipeline.
 *    Individual command handlers MUST NOT re-validate arguments.
 *    They receive pre-validated input from the gate.
 *
 * 4. The gate pipeline order (1-5) MUST NOT be reordered.
 *    Gates are ordered by severity: execution → auth → health →
 *    format → arguments. This ensures the cheapest checks run first.
 *
 * 5. CI enforcement MUST NOT be optional.
 *    There is no --skip-adr-checks flag. There is no
 *    DISABLE_SCHEMA_VALIDATION environment variable.
 *
 * ============================================================================
 * ANTI-PATTERNS (WHAT IS FORBIDDEN)
 * ============================================================================
 *
 * 1. INLINE VALIDATION
 *    Forbidden: Checking argument types inside command handlers.
 *    Required: All validation flows through argument-guard.ts.
 *
 * 2. DUPLICATE REGISTRIES
 *    Forbidden: Maintaining a separate list of commands in help text,
 *    tests, or documentation that doesn't reference COMMAND_REGISTRY.
 *    Required: All command metadata derives from COMMAND_REGISTRY.
 *
 * 3. SOFT FAILURES
 *    Forbidden: Logging a warning and continuing when validation fails.
 *    Required: process.exit(EXIT_CODES.ARG_VALIDATION_ERROR) on any
 *    argument contract violation.
 *
 * 4. INFERENCE / AUTO-CORRECTION
 *    Forbidden: "Did you mean 'plan create'?" or fuzzy matching.
 *    Required: Exact match or deterministic error. No guessing.
 *
 * 5. BYPASS FLAGS
 *    Forbidden: --no-validate, --skip-gates, --unsafe-mode.
 *    Required: All commands pass through all applicable gates.
 *
 * 6. DYNAMIC SCHEMA LOADING
 *    Forbidden: Reading command specs from a config file at runtime.
 *    Required: COMMAND_REGISTRY is a compile-time TypeScript constant.
 *    This provides type safety, tree-shaking, and audit traceability.
 *
 * 7. GATE REORDERING
 *    Forbidden: Moving the Argument Guard before the Auth gate.
 *    Required: Gates execute in the defined order (1-5).
 *
 * 8. UNREGISTERED COMMANDS
 *    Forbidden: Adding a case to the CLI dispatch switch without
 *    a corresponding COMMAND_REGISTRY entry.
 *    Required: Schema-first development — register, then implement.
 *
 * ============================================================================
 * ADR SCHEMA SPECIFICATION
 * ============================================================================
 *
 * This section defines the schema structure that COMMAND_REGISTRY entries
 * must conform to. It is the formal specification for ADR-001's
 * machine-readable representation.
 *
 * FIELD DEFINITIONS:
 *
 * CommandSpec (required fields):
 *   command: string
 *     Full command path. Format: "<primary>" or "<primary> <subcommand>".
 *     Must be unique across the registry. Lowercase, space-separated.
 *
 *   primary: string
 *     The top-level command name. Matches the CLI dispatch case label.
 *     Lowercase, no spaces.
 *
 *   description: string
 *     One-line human-readable description. Used in help output.
 *     Must start with a verb. Must not exceed 80 characters.
 *
 *   synthesis: SynthesisClass
 *     One of: 'SYNTHESIS_REQUIRED', 'SYNTHESIS_FORBIDDEN', 'COMMITMENT_GRADE'.
 *     Governs whether LLM synthesis may be triggered by this command.
 *
 *   args: readonly ArgumentSpec[]
 *     Ordered positional arguments. May be empty for zero-argument commands.
 *
 *   irreversible: boolean
 *     Whether this command performs an irreversible state change.
 *     true requires confirmation before execution.
 *
 *   requiresConfirmation: boolean
 *     Whether this command requires explicit user confirmation.
 *     May be satisfied by --force flag or interactive prompt.
 *
 * CommandSpec (optional fields):
 *   subcommand: string
 *     The subcommand name, if this is a sub-operation of a primary command.
 *     Lowercase, no spaces.
 *
 * ArgumentSpec (all fields required):
 *   name: string
 *     Argument name for help output. Lowercase, hyphenated.
 *
 *   type: ArgumentType
 *     One of: 'ID', 'NATURAL_LANGUAGE', 'SELECTOR'.
 *
 *   required: boolean
 *     Whether this argument must be provided.
 *
 *   description: string
 *     Human-readable description for help and error messages.
 *
 *   example: string
 *     Example value shown in usage output and error messages.
 *
 * EXAMPLE ENTRIES:
 *
 *   // Zero-argument, synthesis-forbidden, read-only command
 *   {
 *     command: 'whoami',
 *     primary: 'whoami',
 *     description: 'Show current identity, org, and role',
 *     synthesis: 'SYNTHESIS_FORBIDDEN',
 *     args: [],
 *     irreversible: false,
 *     requiresConfirmation: false,
 *   }
 *
 *   // Single NL argument, synthesis-required, safe command
 *   {
 *     command: 'simulate create',
 *     primary: 'simulate',
 *     subcommand: 'create',
 *     description: 'Create a new simulation from a natural language description',
 *     synthesis: 'SYNTHESIS_REQUIRED',
 *     args: [{
 *       name: 'description',
 *       type: 'NATURAL_LANGUAGE',
 *       required: true,
 *       description: 'Quoted natural language description of the simulation',
 *       example: '"Simulate enterprise migration to cloud"',
 *     }],
 *     irreversible: false,
 *     requiresConfirmation: false,
 *   }
 *
 *   // Single ID argument, commitment-grade, irreversible command
 *   {
 *     command: 'simulate run',
 *     primary: 'simulate',
 *     subcommand: 'run',
 *     description: 'Execute a simulation by ID',
 *     synthesis: 'COMMITMENT_GRADE',
 *     args: [{
 *       name: 'simulation-id',
 *       type: 'ID',
 *       required: true,
 *       description: 'ID of the simulation to run',
 *       example: 'enterprise-cloud-migration',
 *     }],
 *     irreversible: true,
 *     requiresConfirmation: true,
 *   }
 *
 * ============================================================================
 * MIDDLEWARE INTEGRATION SPEC
 * ============================================================================
 *
 * WHERE IT LIVES:
 *   src/gates/argument-guard.ts
 *
 * HOW IT LOADS THE SCHEMA:
 *   import { lookupCommand, classifyArgument, validateArgument }
 *     from '../contracts/adr-command-semantics.js';
 *
 *   The import is resolved at compile time. The registry is available
 *   as a module-level constant. No file I/O. No async loading.
 *
 * EXECUTION ORDER:
 *   1. CLI entrypoint (src/cli/index.ts) calls parser.parse(args)
 *   2. Built-in commands (help, version) exit early
 *   3. Gate 1: enforceExecutionGate(command)
 *   4. Gate 2: enforceAuthSessionGate() [if applicable]
 *   5. Gate 3: enforceServiceHealthGate() [if applicable]
 *   6. Gate 4: enforceOutputFormatGate(format, command) [if applicable]
 *   7. Gate 5: enforceArgumentGuard(parsedCommand) [if applicable]
 *   8. Command dispatch (switch/case)
 *
 * ERROR HANDLING CONTRACT:
 *   On validation failure, enforceArgumentGuard():
 *   1. Writes a structured error message to stderr
 *   2. Calls process.exit(EXIT_CODES.ARG_VALIDATION_ERROR)
 *   3. Never returns — the process terminates
 *   4. Never throws — exit is immediate
 *   5. Never logs to stdout — only stderr
 *
 *   The error message format is deterministic:
 *     Line 1: "Error: <violation type>"
 *     Line 2: (blank)
 *     Line 3+: Contextual details (expected type, received value)
 *     Line N-2: (blank)
 *     Line N-1: "Usage: agentics <command> <args...>"
 *     Line N:   "Example: agentics <command> <example-value>"
 *
 * ============================================================================
 * CI ENFORCEMENT PLAN
 * ============================================================================
 *
 * WHAT RUNS ON PR:
 *   1. Schema structural validation (all fields present, no duplicates)
 *   2. Schema-command parity check (every dispatch has a schema entry)
 *   3. Argument contract behavior tests (generated from schema)
 *   4. TypeScript compilation (catches type-level contract violations)
 *   5. Existing unit test suite
 *
 * WHAT RUNS ON MERGE TO MAIN:
 *   All PR checks, plus:
 *   6. Help output snapshot comparison
 *   7. Gate bypass static analysis
 *   8. Schema version consistency check
 *
 * WHAT RUNS ON RELEASE:
 *   All merge checks, plus:
 *   9. Schema export as CI artifact (for external consumers)
 *   10. ADR version compatibility validation
 *   11. Changelog entry verification for schema changes
 *
 * FAILURE CONDITIONS:
 *   - Command in dispatch without schema entry → FAIL with file:line
 *   - Schema entry without dispatch implementation → FAIL with command name
 *   - Argument contract change without version bump → FAIL with diff
 *   - Help snapshot changed without schema change → FAIL with snapshot diff
 *   - Gate bypassed in any code path → FAIL with bypass location
 *
 * DEVELOPER FEEDBACK LOOP:
 *   CI failures include:
 *   1. The specific ADR rule violated (e.g., "Decision 3, Rule 2")
 *   2. The file and line where the violation was detected
 *   3. The exact fix required (add schema entry / update version / etc.)
 *   4. A link to this ADR for full context
 *
 * ============================================================================
 * EXPLICIT NON-GOALS
 * ============================================================================
 *
 * 1. This ADR does NOT redefine command semantics.
 *    ADR-001 defines what commands mean. This ADR defines how those
 *    definitions are enforced at runtime and in CI.
 *
 * 2. This ADR does NOT introduce new commands.
 *    Adding commands is governed by ADR-001. This ADR governs the
 *    process by which new commands are registered and validated.
 *
 * 3. This ADR does NOT allow CLI inference or "helpful guessing".
 *    The CLI is deterministic. Invalid input produces a fixed error.
 *    There is no fuzzy matching, no "did you mean", no autocorrect.
 *
 * 4. This ADR does NOT weaken synthesis boundaries.
 *    SYNTHESIS_FORBIDDEN means forbidden. No exceptions. No overrides.
 *    No environment variables to relax this constraint.
 *
 * 5. This ADR does NOT replace existing gate logic.
 *    Gates 1-4 remain unchanged. This ADR formalizes Gate 5 and
 *    adds CI enforcement across all gates.
 *
 * ============================================================================
 * SUCCESS CRITERIA
 * ============================================================================
 *
 * This ADR is successful if and only if:
 *
 * 1. Changing CLI behavior REQUIRES changing the schema
 *    - No command can be added, removed, or modified without updating
 *      COMMAND_REGISTRY in adr-command-semantics.ts
 *
 * 2. Breaking the schema BREAKS CI
 *    - Any structural or semantic violation in the registry causes
 *      CI to fail with an actionable error message
 *
 * 3. Help text CANNOT lie
 *    - All user-facing help text is derived from COMMAND_REGISTRY
 *    - Snapshot tests detect any divergence
 *
 * 4. Validation CANNOT be bypassed
 *    - The 5-gate pipeline is the only execution path
 *    - Static analysis detects any bypass in PRs
 *
 * 5. The CLI behaves like claude-flow / claude-code, not a chat tool
 *    - Deterministic: same inputs → same dispatch path
 *    - Explicit: no inference, no guessing, no auto-correction
 *    - Enterprise-grade: fail fast with instructional errors
 *    - Composable: commands are pipeline stages, not chat turns
 *
 * ============================================================================
 * ALTERNATIVES CONSIDERED
 * ============================================================================
 *
 * A. External YAML/JSON schema file loaded at runtime:
 *    Rejected — loses TypeScript compile-time safety, adds file I/O
 *    at startup, creates a second source of truth that can diverge
 *    from the TypeScript types.
 *
 * B. Runtime schema generation from TypeScript decorators:
 *    Rejected — decorators add complexity, are hard to audit, and
 *    create implicit registration that's easy to miss in review.
 *
 * C. Per-command validation in each handler:
 *    Rejected — distributes validation logic, makes it impossible
 *    to audit centrally, and guarantees drift over time.
 *
 * D. Lint rules instead of CI tests:
 *    Rejected — lint rules can be disabled with inline comments,
 *    and don't catch semantic violations (e.g., schema entry
 *    exists but with wrong synthesis class).
 *
 * E. Optional enforcement with gradual rollout:
 *    Rejected — optional enforcement is no enforcement. The gate
 *    is either in the pipeline or it isn't.
 *
 * ============================================================================
 * CLAUDE-CODE PARITY STATEMENT
 * ============================================================================
 *
 * This operational enforcement model mirrors claude-flow / claude-code
 * behavior:
 *
 * - Schema-driven: behavior is defined by data structures, not prose
 * - Gate pipeline: sequential validation before any side effects
 * - Fail-fast: violations terminate immediately with clear diagnostics
 * - No inference: the system does what it's told, or rejects the input
 * - Auditable: every decision can be traced to a registry entry
 * - CI-enforced: governance is mechanical, not aspirational
 */

// ============================================================================
// Schema Version
// ============================================================================

/**
 * ADR schema version. Must be bumped when:
 * - MAJOR: argument contracts change in a breaking way
 * - MINOR: new commands are added
 * - PATCH: help text, examples, or descriptions are corrected
 */
export const ADR_SCHEMA_VERSION = '1.0.0' as const;

/**
 * ADR-002 identifier. Distinct from ADR-001.
 */
export const ADR_002_ID = 'ADR-002' as const;
export const ADR_002_TITLE = 'Operational Enforcement of CLI Governance' as const;
export const ADR_002_STATUS = 'Accepted' as const;
export const ADR_002_DATE = '2026-01-28' as const;

// ============================================================================
// Enforcement Configuration Types
// ============================================================================

/**
 * Gate enforcement order. This is the canonical definition of the
 * gate pipeline. Any code that dispatches commands must execute
 * these gates in this exact order.
 */
export const GATE_PIPELINE = [
  { gate: 1, name: 'ExecutionGate',    module: 'gates/execution-gate.ts',    description: 'Kill-switch / entitlement check' },
  { gate: 2, name: 'AuthSessionGate',  module: 'gates/auth-session-gate.ts', description: 'Requires authenticated session' },
  { gate: 3, name: 'ServiceHealthGate', module: 'gates/service-health-gate.ts', description: 'Validates backend availability' },
  { gate: 4, name: 'OutputFormatGate', module: 'gates/output-format-gate.ts', description: 'Enforces structured output' },
  { gate: 5, name: 'ArgumentGuard',   module: 'gates/argument-guard.ts',    description: 'ADR-001 contract enforcement' },
] as const;

/**
 * Commands exempt from argument validation.
 * These commands exit before the gate pipeline.
 */
export const GATE_EXEMPT_COMMANDS = ['help', 'version'] as const;

/**
 * CI check identifiers for traceability in failure messages.
 */
export const CI_CHECK_IDS = {
  SCHEMA_STRUCTURAL_VALIDATION: 'ADR-002.D3.R1',
  COMMAND_SCHEMA_PARITY: 'ADR-002.D3.R2',
  SCHEMA_IMPLEMENTATION_PARITY: 'ADR-002.D3.R3',
  HELP_SCHEMA_DERIVATION: 'ADR-002.D3.R4',
  COMMAND_BEHAVIOR_TESTS: 'ADR-002.D3.R5',
  GATE_BYPASS_DETECTION: 'ADR-002.D3.R6',
  VERSION_COMPATIBILITY: 'ADR-002.D3.R7',
} as const;
