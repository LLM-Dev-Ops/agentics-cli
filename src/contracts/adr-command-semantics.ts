/**
 * ADR-001: Command Argument Semantics & Synthesis Governance
 *
 * STATUS: Accepted
 * DATE: 2026-01-28
 * AUTHORS: Platform Engineering
 *
 * ============================================================================
 * CONTEXT
 * ============================================================================
 *
 * The Agentics CLI is an enterprise orchestration tool, not a chat interface.
 * Natural language seeds synthesis; IDs resolve persisted manifests.
 * These are categorically different argument types with non-overlapping semantics.
 *
 * Without formal governance:
 * - Users accidentally pass descriptions where IDs are required
 * - Synthesis triggers on read-only or irreversible commands
 * - Help output is ambiguous about what each command expects
 * - Tests cannot be mechanically derived from command specifications
 *
 * ============================================================================
 * DECISION
 * ============================================================================
 *
 * 1. All CLI arguments are formally classified into three types:
 *    ID, NATURAL_LANGUAGE, and SELECTOR.
 *
 * 2. Each command+subcommand declares its exact argument contract.
 *
 * 3. A synthesis governance matrix classifies every command as:
 *    SYNTHESIS_REQUIRED, SYNTHESIS_FORBIDDEN, or COMMITMENT_GRADE.
 *
 * 4. Runtime validation middleware enforces these contracts before dispatch.
 *
 * 5. Help output, tests, and error messages are all derived from this ADR.
 *
 * ============================================================================
 * ALTERNATIVES CONSIDERED
 * ============================================================================
 *
 * A. Loose validation with runtime inference:
 *    Rejected — violates determinism and enterprise-grade predictability.
 *
 * B. Per-command ad-hoc validation:
 *    Rejected — leads to inconsistency, untestable, help drift.
 *
 * C. External YAML/JSON config:
 *    Rejected — TypeScript provides compile-time safety and co-location
 *    with the code it governs.
 *
 * ============================================================================
 * CONSEQUENCES
 * ============================================================================
 *
 * - Every command has one unambiguous semantic meaning
 * - Users cannot accidentally misuse IDs vs natural language
 * - Synthesis is impossible where unsafe
 * - Validation, tests, and help all derive from this file
 * - New commands must register here before they compile
 *
 * ============================================================================
 * CLAUDE-CODE PARITY STATEMENT
 * ============================================================================
 *
 * The Agentics CLI mirrors claude-flow + claude-code behavior:
 * - Deterministic: same inputs always produce same dispatch path
 * - Explicit: no inference, no guessing, no auto-correction
 * - Enterprise-grade: fail fast with instructional errors
 * - Composable: commands are pipeline stages, not chat turns
 */

// ============================================================================
// Argument Type Definitions
// ============================================================================

/**
 * The three argument classes. No other classification exists.
 */
export type ArgumentType = 'ID' | 'NATURAL_LANGUAGE' | 'SELECTOR';

/**
 * Synthesis governance classification for each command.
 */
export type SynthesisClass =
  | 'SYNTHESIS_REQUIRED'     // LLM invocation allowed and expected
  | 'SYNTHESIS_FORBIDDEN'    // Must NEVER trigger synthesis
  | 'COMMITMENT_GRADE';      // Requires ID + explicit confirmation + synthesis

/**
 * Argument specification for a single positional argument.
 */
export interface ArgumentSpec {
  /** Name used in help output */
  readonly name: string;
  /** Argument type classification */
  readonly type: ArgumentType;
  /** Whether this argument must be provided */
  readonly required: boolean;
  /** Human-readable description for help */
  readonly description: string;
  /** Example value for help output */
  readonly example: string;
}

/**
 * Complete command specification — the atomic unit of the ADR.
 */
export interface CommandSpec {
  /** Full command path, e.g. "simulate create" */
  readonly command: string;
  /** Primary command name */
  readonly primary: string;
  /** Subcommand name, if any */
  readonly subcommand?: string;
  /** One-line description */
  readonly description: string;
  /** Synthesis governance class */
  readonly synthesis: SynthesisClass;
  /** Ordered positional arguments */
  readonly args: readonly ArgumentSpec[];
  /** Whether this command is irreversible */
  readonly irreversible: boolean;
  /** Whether this command requires confirmation (--force or interactive) */
  readonly requiresConfirmation: boolean;
}

// ============================================================================
// Command Registry — THE SINGLE SOURCE OF TRUTH
// ============================================================================

export const COMMAND_REGISTRY: readonly CommandSpec[] = [

  // ==========================================================================
  // IDENTITY & ACCESS — SYNTHESIS FORBIDDEN
  // ==========================================================================

  {
    command: 'login',
    primary: 'login',
    description: 'Authenticate the CLI via browser-based auth with API key',
    synthesis: 'SYNTHESIS_FORBIDDEN',
    args: [],
    irreversible: false,
    requiresConfirmation: false,
  },
  {
    command: 'logout',
    primary: 'logout',
    description: 'Clear local authentication state',
    synthesis: 'SYNTHESIS_FORBIDDEN',
    args: [],
    irreversible: false,
    requiresConfirmation: false,
  },
  {
    command: 'whoami',
    primary: 'whoami',
    description: 'Show current identity, org, and role',
    synthesis: 'SYNTHESIS_FORBIDDEN',
    args: [],
    irreversible: false,
    requiresConfirmation: false,
  },

  // ==========================================================================
  // SIMULATION — SYNTHESIS REQUIRED / COMMITMENT GRADE
  // ==========================================================================

  {
    command: 'simulate create',
    primary: 'simulate',
    subcommand: 'create',
    description: 'Create a new simulation from a natural language description',
    synthesis: 'SYNTHESIS_REQUIRED',
    args: [
      {
        name: 'description',
        type: 'NATURAL_LANGUAGE',
        required: true,
        description: 'Quoted natural language description of the simulation',
        example: '"Simulate enterprise migration to cloud"',
      },
    ],
    irreversible: false,
    requiresConfirmation: false,
  },
  {
    command: 'simulate run',
    primary: 'simulate',
    subcommand: 'run',
    description: 'Execute a simulation by ID',
    synthesis: 'COMMITMENT_GRADE',
    args: [
      {
        name: 'simulation-id',
        type: 'ID',
        required: true,
        description: 'ID of the simulation to run',
        example: 'enterprise-cloud-migration',
      },
    ],
    irreversible: true,
    requiresConfirmation: true,
  },
  {
    command: 'simulate list',
    primary: 'simulate',
    subcommand: 'list',
    description: 'List all simulations',
    synthesis: 'SYNTHESIS_FORBIDDEN',
    args: [],
    irreversible: false,
    requiresConfirmation: false,
  },
  {
    command: 'simulate inspect',
    primary: 'simulate',
    subcommand: 'inspect',
    description: 'Inspect a simulation by ID',
    synthesis: 'SYNTHESIS_FORBIDDEN',
    args: [
      {
        name: 'simulation-id',
        type: 'ID',
        required: true,
        description: 'ID of the simulation to inspect',
        example: 'enterprise-cloud-migration',
      },
    ],
    irreversible: false,
    requiresConfirmation: false,
  },
  {
    command: 'simulate delete',
    primary: 'simulate',
    subcommand: 'delete',
    description: 'Delete a simulation by ID',
    synthesis: 'SYNTHESIS_FORBIDDEN',
    args: [
      {
        name: 'simulation-id',
        type: 'ID',
        required: true,
        description: 'ID of the simulation to delete',
        example: 'enterprise-cloud-migration',
      },
    ],
    irreversible: true,
    requiresConfirmation: true,
  },

  // ==========================================================================
  // PLANNING — SYNTHESIS REQUIRED / COMMITMENT GRADE
  // ==========================================================================

  {
    command: 'plan create',
    primary: 'plan',
    subcommand: 'create',
    description: 'Create a new plan from a natural language description',
    synthesis: 'SYNTHESIS_REQUIRED',
    args: [
      {
        name: 'description',
        type: 'NATURAL_LANGUAGE',
        required: true,
        description: 'Quoted natural language description of the plan',
        example: '"Migrate authentication to OAuth2"',
      },
    ],
    irreversible: false,
    requiresConfirmation: false,
  },
  {
    command: 'plan approve',
    primary: 'plan',
    subcommand: 'approve',
    description: 'Approve a plan by ID (irreversible)',
    synthesis: 'COMMITMENT_GRADE',
    args: [
      {
        name: 'plan-id',
        type: 'ID',
        required: true,
        description: 'UUID of the plan to approve',
        example: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
      },
    ],
    irreversible: true,
    requiresConfirmation: true,
  },
  {
    command: 'plan list',
    primary: 'plan',
    subcommand: 'list',
    description: 'List all plans',
    synthesis: 'SYNTHESIS_FORBIDDEN',
    args: [],
    irreversible: false,
    requiresConfirmation: false,
  },
  {
    command: 'plan inspect',
    primary: 'plan',
    subcommand: 'inspect',
    description: 'Inspect a plan by ID',
    synthesis: 'SYNTHESIS_FORBIDDEN',
    args: [
      {
        name: 'plan-id',
        type: 'ID',
        required: true,
        description: 'UUID of the plan to inspect',
        example: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
      },
    ],
    irreversible: false,
    requiresConfirmation: false,
  },
  {
    command: 'plan delete',
    primary: 'plan',
    subcommand: 'delete',
    description: 'Delete a plan by ID',
    synthesis: 'SYNTHESIS_FORBIDDEN',
    args: [
      {
        name: 'plan-id',
        type: 'ID',
        required: true,
        description: 'UUID of the plan to delete',
        example: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
      },
    ],
    irreversible: true,
    requiresConfirmation: true,
  },

  // ==========================================================================
  // DEPLOYMENT — SYNTHESIS REQUIRED / COMMITMENT GRADE
  // ==========================================================================

  {
    command: 'deploy preview',
    primary: 'deploy',
    subcommand: 'preview',
    description: 'Preview a deployment for a simulation',
    synthesis: 'SYNTHESIS_REQUIRED',
    args: [
      {
        name: 'simulation-id',
        type: 'ID',
        required: true,
        description: 'ID of the simulation to preview deployment for',
        example: 'enterprise-cloud-migration',
      },
    ],
    irreversible: false,
    requiresConfirmation: false,
  },
  {
    command: 'deploy run',
    primary: 'deploy',
    subcommand: 'run',
    description: 'Execute a deployment (irreversible)',
    synthesis: 'COMMITMENT_GRADE',
    args: [
      {
        name: 'deployment-id',
        type: 'ID',
        required: true,
        description: 'ID of the deployment to execute',
        example: 'deploy-prod-2026-01',
      },
    ],
    irreversible: true,
    requiresConfirmation: true,
  },
  {
    command: 'deploy rollback',
    primary: 'deploy',
    subcommand: 'rollback',
    description: 'Rollback a deployment (irreversible)',
    synthesis: 'COMMITMENT_GRADE',
    args: [
      {
        name: 'deployment-id',
        type: 'ID',
        required: true,
        description: 'ID of the deployment to rollback',
        example: 'deploy-prod-2026-01',
      },
    ],
    irreversible: true,
    requiresConfirmation: true,
  },
  {
    command: 'deploy list',
    primary: 'deploy',
    subcommand: 'list',
    description: 'List all deployments',
    synthesis: 'SYNTHESIS_FORBIDDEN',
    args: [],
    irreversible: false,
    requiresConfirmation: false,
  },
  {
    command: 'deploy status',
    primary: 'deploy',
    subcommand: 'status',
    description: 'Check deployment status by ID',
    synthesis: 'SYNTHESIS_FORBIDDEN',
    args: [
      {
        name: 'deployment-id',
        type: 'ID',
        required: true,
        description: 'ID of the deployment to check',
        example: 'deploy-prod-2026-01',
      },
    ],
    irreversible: false,
    requiresConfirmation: false,
  },

  // ==========================================================================
  // EXPORT — SYNTHESIS REQUIRED
  // ==========================================================================

  {
    command: 'export terraform',
    primary: 'export',
    subcommand: 'terraform',
    description: 'Export deployment artifacts as Terraform',
    synthesis: 'SYNTHESIS_REQUIRED',
    args: [
      {
        name: 'intent-id',
        type: 'ID',
        required: true,
        description: 'ID of the deployment intent to export',
        example: 'intent-cloud-migration',
      },
    ],
    irreversible: false,
    requiresConfirmation: false,
  },
  {
    command: 'export kubernetes',
    primary: 'export',
    subcommand: 'kubernetes',
    description: 'Export deployment artifacts as Kubernetes manifests',
    synthesis: 'SYNTHESIS_REQUIRED',
    args: [
      {
        name: 'intent-id',
        type: 'ID',
        required: true,
        description: 'ID of the deployment intent to export',
        example: 'intent-cloud-migration',
      },
    ],
    irreversible: false,
    requiresConfirmation: false,
  },
  {
    command: 'export erp',
    primary: 'export',
    subcommand: 'erp',
    description: 'Export deployment artifacts as ERP integration',
    synthesis: 'SYNTHESIS_REQUIRED',
    args: [
      {
        name: 'intent-id',
        type: 'ID',
        required: true,
        description: 'ID of the deployment intent to export',
        example: 'intent-cloud-migration',
      },
    ],
    irreversible: false,
    requiresConfirmation: false,
  },

  // ==========================================================================
  // POLICY — SYNTHESIS REQUIRED / COMMITMENT GRADE
  // ==========================================================================

  {
    command: 'policy create',
    primary: 'policy',
    subcommand: 'create',
    description: 'Create a new policy from a natural language description or --name flag',
    synthesis: 'SYNTHESIS_REQUIRED',
    args: [
      {
        name: 'description',
        type: 'NATURAL_LANGUAGE',
        required: false,
        description: 'Quoted natural language description of the policy (optional when --name is provided)',
        example: '"Enforce SOC2 compliance on all deployments"',
      },
    ],
    irreversible: false,
    requiresConfirmation: false,
  },
  {
    command: 'policy edit',
    primary: 'policy',
    subcommand: 'edit',
    description: 'Edit a policy by ID',
    synthesis: 'SYNTHESIS_REQUIRED',
    args: [
      {
        name: 'policy-id',
        type: 'ID',
        required: true,
        description: 'ID of the policy to edit',
        example: 'soc2-compliance',
      },
    ],
    irreversible: false,
    requiresConfirmation: false,
  },
  {
    command: 'policy enable',
    primary: 'policy',
    subcommand: 'enable',
    description: 'Enable a policy by ID (commitment-grade)',
    synthesis: 'COMMITMENT_GRADE',
    args: [
      {
        name: 'policy-id',
        type: 'ID',
        required: true,
        description: 'ID of the policy to enable',
        example: 'soc2-compliance',
      },
    ],
    irreversible: true,
    requiresConfirmation: true,
  },
  {
    command: 'policy disable',
    primary: 'policy',
    subcommand: 'disable',
    description: 'Disable a policy by ID',
    synthesis: 'SYNTHESIS_REQUIRED',
    args: [
      {
        name: 'policy-id',
        type: 'ID',
        required: true,
        description: 'ID of the policy to disable',
        example: 'soc2-compliance',
      },
    ],
    irreversible: false,
    requiresConfirmation: true,
  },
  {
    command: 'policy dry-run',
    primary: 'policy',
    subcommand: 'dry-run',
    description: 'Dry-run a policy against a target',
    synthesis: 'SYNTHESIS_REQUIRED',
    args: [
      {
        name: 'policy-id',
        type: 'ID',
        required: true,
        description: 'ID of the policy to dry-run',
        example: 'soc2-compliance',
      },
    ],
    irreversible: false,
    requiresConfirmation: false,
  },
  {
    command: 'policy list',
    primary: 'policy',
    subcommand: 'list',
    description: 'List all policies',
    synthesis: 'SYNTHESIS_FORBIDDEN',
    args: [],
    irreversible: false,
    requiresConfirmation: false,
  },
  {
    command: 'policy inspect',
    primary: 'policy',
    subcommand: 'inspect',
    description: 'Inspect a policy by ID',
    synthesis: 'SYNTHESIS_FORBIDDEN',
    args: [
      {
        name: 'policy-id',
        type: 'ID',
        required: true,
        description: 'ID of the policy to inspect',
        example: 'soc2-compliance',
      },
    ],
    irreversible: false,
    requiresConfirmation: false,
  },
  {
    command: 'policy delete',
    primary: 'policy',
    subcommand: 'delete',
    description: 'Delete a policy by ID',
    synthesis: 'SYNTHESIS_FORBIDDEN',
    args: [
      {
        name: 'policy-id',
        type: 'ID',
        required: true,
        description: 'ID of the policy to delete',
        example: 'soc2-compliance',
      },
    ],
    irreversible: true,
    requiresConfirmation: true,
  },

  // ==========================================================================
  // QUANTIFY — SYNTHESIS REQUIRED / COMMITMENT GRADE
  // ==========================================================================

  {
    command: 'quantify create',
    primary: 'quantify',
    subcommand: 'create',
    description: 'Create a new ROI report from a natural language description',
    synthesis: 'SYNTHESIS_REQUIRED',
    args: [
      {
        name: 'description',
        type: 'NATURAL_LANGUAGE',
        required: true,
        description: 'Quoted natural language description of the ROI analysis',
        example: '"Compare cloud costs for 3-year migration"',
      },
    ],
    irreversible: false,
    requiresConfirmation: false,
  },
  {
    command: 'quantify compare',
    primary: 'quantify',
    subcommand: 'compare',
    description: 'Compare two ROI reports by ID (commitment-grade)',
    synthesis: 'COMMITMENT_GRADE',
    args: [
      {
        name: 'report-id-1',
        type: 'ID',
        required: true,
        description: 'ID of the first ROI report',
        example: 'roi-cloud-3yr',
      },
      {
        name: 'report-id-2',
        type: 'ID',
        required: true,
        description: 'ID of the second ROI report',
        example: 'roi-onprem-3yr',
      },
    ],
    irreversible: false,
    requiresConfirmation: true,
  },
  {
    command: 'quantify list',
    primary: 'quantify',
    subcommand: 'list',
    description: 'List all ROI reports',
    synthesis: 'SYNTHESIS_FORBIDDEN',
    args: [],
    irreversible: false,
    requiresConfirmation: false,
  },
  {
    command: 'quantify inspect',
    primary: 'quantify',
    subcommand: 'inspect',
    description: 'Inspect a ROI report by ID',
    synthesis: 'SYNTHESIS_FORBIDDEN',
    args: [
      {
        name: 'report-id',
        type: 'ID',
        required: true,
        description: 'ID of the ROI report to inspect',
        example: 'roi-cloud-3yr',
      },
    ],
    irreversible: false,
    requiresConfirmation: false,
  },
  {
    command: 'quantify delete',
    primary: 'quantify',
    subcommand: 'delete',
    description: 'Delete a ROI report by ID',
    synthesis: 'SYNTHESIS_FORBIDDEN',
    args: [
      {
        name: 'report-id',
        type: 'ID',
        required: true,
        description: 'ID of the ROI report to delete',
        example: 'roi-cloud-3yr',
      },
    ],
    irreversible: true,
    requiresConfirmation: true,
  },

  // ==========================================================================
  // ERP SURFACE — SYNTHESIS REQUIRED
  // ==========================================================================

  {
    command: 'erp surface',
    primary: 'erp',
    subcommand: 'surface',
    description: 'Surface ERP integration points for a plan',
    synthesis: 'SYNTHESIS_REQUIRED',
    args: [
      {
        name: 'plan-id',
        type: 'ID',
        required: true,
        description: 'ID of the plan to analyze for ERP integration',
        example: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
      },
    ],
    irreversible: false,
    requiresConfirmation: false,
  },
  {
    command: 'erp map',
    primary: 'erp',
    subcommand: 'map',
    description: 'Map ERP entities for a plan',
    synthesis: 'SYNTHESIS_REQUIRED',
    args: [
      {
        name: 'plan-id',
        type: 'ID',
        required: true,
        description: 'ID of the plan to map ERP entities for',
        example: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
      },
    ],
    irreversible: false,
    requiresConfirmation: false,
  },
  {
    command: 'erp export',
    primary: 'erp',
    subcommand: 'export',
    description: 'Export ERP integration artifacts for a plan',
    synthesis: 'SYNTHESIS_REQUIRED',
    args: [
      {
        name: 'plan-id',
        type: 'ID',
        required: true,
        description: 'ID of the plan to export ERP artifacts for',
        example: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
      },
    ],
    irreversible: false,
    requiresConfirmation: false,
  },
  {
    command: 'erp list',
    primary: 'erp',
    subcommand: 'list',
    description: 'List supported ERP systems',
    synthesis: 'SYNTHESIS_FORBIDDEN',
    args: [],
    irreversible: false,
    requiresConfirmation: false,
  },
  {
    command: 'erp inspect',
    primary: 'erp',
    subcommand: 'inspect',
    description: 'Inspect an ERP system configuration',
    synthesis: 'SYNTHESIS_FORBIDDEN',
    args: [
      {
        name: 'system-name',
        type: 'ID',
        required: true,
        description: 'Name of the ERP system to inspect',
        example: 'sap',
      },
    ],
    irreversible: false,
    requiresConfirmation: false,
  },

  // ==========================================================================
  // INSPECT — SYNTHESIS FORBIDDEN (READ-ONLY)
  // ==========================================================================

  {
    command: 'inspect',
    primary: 'inspect',
    description: 'Inspect a resource by reference (read-only)',
    synthesis: 'SYNTHESIS_FORBIDDEN',
    args: [
      {
        name: 'reference',
        type: 'ID',
        required: false,
        description: 'ID or JSON reference of the resource to inspect',
        example: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
      },
    ],
    irreversible: false,
    requiresConfirmation: false,
  },
  {
    command: 'inspect latest',
    primary: 'inspect',
    subcommand: 'latest',
    description: 'Inspect the latest run',
    synthesis: 'SYNTHESIS_FORBIDDEN',
    args: [],
    irreversible: false,
    requiresConfirmation: false,
  },
  {
    command: 'inspect run',
    primary: 'inspect',
    subcommand: 'run',
    description: 'Inspect a specific run by ID',
    synthesis: 'SYNTHESIS_FORBIDDEN',
    args: [
      {
        name: 'run-id',
        type: 'ID',
        required: true,
        description: 'ID of the run to inspect',
        example: 'run-2026-01-28-001',
      },
    ],
    irreversible: false,
    requiresConfirmation: false,
  },
  {
    command: 'inspect artifacts',
    primary: 'inspect',
    subcommand: 'artifacts',
    description: 'Inspect artifacts for a run by ID',
    synthesis: 'SYNTHESIS_FORBIDDEN',
    args: [
      {
        name: 'run-id',
        type: 'ID',
        required: true,
        description: 'ID of the run to inspect artifacts for',
        example: 'run-2026-01-28-001',
      },
    ],
    irreversible: false,
    requiresConfirmation: false,
  },

  // ==========================================================================
  // USAGE & BILLING — SYNTHESIS FORBIDDEN
  // ==========================================================================

  {
    command: 'usage',
    primary: 'usage',
    description: 'Show current usage summary',
    synthesis: 'SYNTHESIS_FORBIDDEN',
    args: [],
    irreversible: false,
    requiresConfirmation: false,
  },
  {
    command: 'usage history',
    primary: 'usage',
    subcommand: 'history',
    description: 'Show usage history',
    synthesis: 'SYNTHESIS_FORBIDDEN',
    args: [],
    irreversible: false,
    requiresConfirmation: false,
  },
  {
    command: 'usage limits',
    primary: 'usage',
    subcommand: 'limits',
    description: 'Show usage limits',
    synthesis: 'SYNTHESIS_FORBIDDEN',
    args: [],
    irreversible: false,
    requiresConfirmation: false,
  },
  {
    command: 'usage reset',
    primary: 'usage',
    subcommand: 'reset',
    description: 'Reset usage counters (requires --force)',
    synthesis: 'SYNTHESIS_FORBIDDEN',
    args: [],
    irreversible: true,
    requiresConfirmation: true,
  },

  // ==========================================================================
  // DILIGENCE — SYNTHESIS REQUIRED
  // ==========================================================================

  {
    command: 'diligence',
    primary: 'diligence',
    description: 'Run due diligence analysis on references',
    synthesis: 'SYNTHESIS_REQUIRED',
    args: [
      {
        name: 'description',
        type: 'NATURAL_LANGUAGE',
        required: true,
        description: 'Quoted natural language description or JSON references',
        example: '"Analyze compliance for SOC2 and HIPAA"',
      },
    ],
    irreversible: false,
    requiresConfirmation: false,
  },

  // ==========================================================================
  // NATURAL LANGUAGE ROUTING — SYNTHESIS REQUIRED
  // ==========================================================================

  {
    command: 'ask',
    primary: 'ask',
    description: 'Route a natural language query to the appropriate agent',
    synthesis: 'SYNTHESIS_REQUIRED',
    args: [
      { name: 'query', type: 'NATURAL_LANGUAGE' as const, required: true, description: 'Natural language query describing what you want to do', example: '"check this prompt for injection attacks"' },
    ],
    irreversible: false,
    requiresConfirmation: false,
  },

  // ==========================================================================
  // BUILT-IN — SYNTHESIS FORBIDDEN
  // ==========================================================================

  {
    command: 'help',
    primary: 'help',
    description: 'Show help information',
    synthesis: 'SYNTHESIS_FORBIDDEN',
    args: [],
    irreversible: false,
    requiresConfirmation: false,
  },
  {
    command: 'version',
    primary: 'version',
    description: 'Show CLI version',
    synthesis: 'SYNTHESIS_FORBIDDEN',
    args: [],
    irreversible: false,
    requiresConfirmation: false,
  },

] as const;

// ============================================================================
// Schema Version (ADR-002 Decision 1)
// ============================================================================

/**
 * ADR schema version. Must be bumped when:
 * - MAJOR: argument contracts change in a breaking way
 * - MINOR: new commands are added
 * - PATCH: help text, examples, or descriptions are corrected
 */
export const ADR_SCHEMA_VERSION = '1.0.0' as const;

// ============================================================================
// Registry Lookup Functions
// ============================================================================

/**
 * Look up a command specification by primary + subcommand.
 * Returns undefined if not registered (which is itself an error).
 */
export function lookupCommand(primary: string, subcommand?: string): CommandSpec | undefined {
  if (subcommand) {
    return COMMAND_REGISTRY.find(
      c => c.primary === primary && c.subcommand === subcommand
    );
  }
  // Match primary-only (no subcommand)
  return COMMAND_REGISTRY.find(
    c => c.primary === primary && !c.subcommand
  );
}

/**
 * Get all commands for a primary command.
 */
export function getSubcommands(primary: string): readonly CommandSpec[] {
  return COMMAND_REGISTRY.filter(c => c.primary === primary);
}

/**
 * Check if a command allows synthesis.
 */
export function isSynthesisAllowed(primary: string, subcommand?: string): boolean {
  const spec = lookupCommand(primary, subcommand);
  if (!spec) return false;
  return spec.synthesis === 'SYNTHESIS_REQUIRED' || spec.synthesis === 'COMMITMENT_GRADE';
}

/**
 * Check if a command is commitment-grade (irreversible + requires confirmation).
 */
export function isCommitmentGrade(primary: string, subcommand?: string): boolean {
  const spec = lookupCommand(primary, subcommand);
  if (!spec) return false;
  return spec.synthesis === 'COMMITMENT_GRADE';
}

// ============================================================================
// Argument Classification Helpers
// ============================================================================

/** ID pattern: lowercase alphanumeric, hyphens, dots, or UUID format */
const ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Classify a raw string argument into its detected type.
 */
export function classifyArgument(value: string): ArgumentType {
  const trimmed = value.trim();

  // Empty string is not valid for any type
  if (!trimmed) return 'NATURAL_LANGUAGE';

  // Selectors: special keywords
  if (trimmed === 'latest') return 'SELECTOR';

  // UUIDs are IDs
  if (UUID_PATTERN.test(trimmed)) return 'ID';

  // Quoted strings are natural language
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return 'NATURAL_LANGUAGE';
  }

  // Strings with spaces are natural language
  if (trimmed.includes(' ')) return 'NATURAL_LANGUAGE';

  // Lowercase hyphenated identifiers are IDs
  if (ID_PATTERN.test(trimmed)) return 'ID';

  // Everything else is natural language
  return 'NATURAL_LANGUAGE';
}

/**
 * Validate that a given argument matches its expected type.
 * Returns null if valid, or an error message if invalid.
 */
export function validateArgument(value: string, expected: ArgumentSpec): string | null {
  const detected = classifyArgument(value);

  if (expected.type === 'ID' && detected === 'NATURAL_LANGUAGE') {
    return `This command requires an ID, not a description. Got: "${value}"\n` +
           `Expected: ${expected.description}\n` +
           `Example:  agentics ... ${expected.example}`;
  }

  if (expected.type === 'NATURAL_LANGUAGE' && detected === 'ID') {
    return `This command requires a quoted natural language description, not an ID. Got: "${value}"\n` +
           `Expected: ${expected.description}\n` +
           `Example:  agentics ... ${expected.example}`;
  }

  return null;
}
