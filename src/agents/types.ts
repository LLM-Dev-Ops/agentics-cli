/**
 * Agent Type Definitions for agentics-cli
 *
 * CONSTITUTION REFERENCE: PROMPT 0 (Agent Infrastructure Constitution)
 *
 * CLASSIFICATION: CLI UX ORCHESTRATION
 *
 * This module defines the complete type system for CLI UX Agents,
 * including the DecisionEvent schema required by the constitution.
 *
 * KEY CONSTRAINTS:
 * - All types import from agentics-contracts (schemas)
 * - Agents are stateless - no persistent storage
 * - DecisionEvents emit to ruvector-service only
 * - No business logic in type definitions
 */

// ============================================================================
// Agent Identity Types
// ============================================================================

/**
 * Agent classification as defined by the constitution.
 * agentics-cli agents are EXCLUSIVELY CLI UX ORCHESTRATION type.
 */
export type AgentClassification = 'CLI_UX_ORCHESTRATION';

/**
 * Agent identifier with semantic versioning.
 */
export interface AgentIdentifier {
  readonly agent_id: string;
  readonly agent_version: string;
  readonly agent_name: string;
  readonly classification: AgentClassification;
}

// ============================================================================
// DecisionEvent Schema (PROMPT 0 REQUIREMENT)
// ============================================================================

/**
 * Decision types for CLI UX Agents.
 *
 * As per constitution, agentics-cli agents handle UX orchestration only.
 */
export type DecisionType =
  | 'cli_ux_orchestration'      // Primary UX decision type
  | 'command_validation'         // Input validation decision
  | 'service_routing'           // Which downstream service to invoke
  | 'output_formatting'         // How to present output to user
  | 'error_presentation'        // How to present errors to user
  | 'workflow_guidance';        // Interactive workflow guidance

/**
 * Confidence level for CLI UX decisions.
 *
 * Represents certainty in:
 * - Command interpretation
 * - Input validation
 * - Service routing
 * - Output presentation
 */
export interface ConfidenceScore {
  /** Overall confidence (0.0 - 1.0) */
  readonly value: number;
  /** What the confidence represents */
  readonly basis: ConfidenceBasis;
  /** Breakdown by component */
  readonly components?: ConfidenceComponent[];
}

export type ConfidenceBasis =
  | 'command_resolution'     // How well command was understood
  | 'input_validation'       // How well inputs validated
  | 'service_match'          // How well routed to correct service
  | 'output_formatting';     // How appropriate output format is

export interface ConfidenceComponent {
  readonly name: string;
  readonly value: number;
  readonly weight: number;
}

/**
 * Constraints applied during CLI UX decision.
 */
export interface ConstraintsApplied {
  /** User permissions scope */
  readonly permissions: string[];
  /** Environment context */
  readonly environment: EnvironmentContext;
  /** Scope limitations */
  readonly scope: ScopeLimitation[];
}

export interface EnvironmentContext {
  readonly is_local: boolean;
  readonly is_production: boolean;
  readonly execution_gate_enabled: boolean;
  readonly auth_present: boolean;
}

export interface ScopeLimitation {
  readonly type: 'command' | 'service' | 'output';
  readonly constraint: string;
  readonly reason: string;
}

/**
 * DecisionEvent schema as required by PROMPT 0.
 *
 * EMISSION RULES:
 * - At most ONE DecisionEvent per agent invocation
 * - MAY be emitted to ruvector-service (async, non-blocking)
 * - MUST NOT be persisted locally
 */
export interface DecisionEvent {
  /** Agent that made the decision */
  readonly agent_id: string;

  /** Version of the agent */
  readonly agent_version: string;

  /** Type of decision made */
  readonly decision_type: DecisionType;

  /** Hash of inputs for reproducibility (no raw data) */
  readonly inputs_hash: string;

  /** Decision outputs (reference only, no raw data) */
  readonly outputs: DecisionOutputs;

  /** Confidence in the decision */
  readonly confidence: ConfidenceScore;

  /** Constraints that affected the decision */
  readonly constraints_applied: ConstraintsApplied;

  /** Reference to downstream execution (if any) */
  readonly execution_ref: ExecutionReference | null;

  /** UTC timestamp of decision */
  readonly timestamp: string;

  /** Trace ID for correlation */
  readonly trace_id: string;
}

/**
 * Decision outputs - references only, no raw data.
 */
export interface DecisionOutputs {
  /** Command that was executed */
  readonly command: string;
  /** Subcommand if applicable */
  readonly subcommand?: string;
  /** Result type */
  readonly result_type: 'success' | 'error' | 'guidance';
  /** Reference to any artifact produced */
  readonly artifact_ref?: string;
  /** Services invoked */
  readonly services_invoked: string[];
}

/**
 * Reference to downstream execution.
 */
export interface ExecutionReference {
  /** Downstream service that was invoked */
  readonly service: string;
  /** Execution ID from downstream */
  readonly execution_id: string;
  /** Trace ID for correlation */
  readonly trace_id: string;
}

// ============================================================================
// CLI UX Agent Contract Types (PROMPT 1)
// ============================================================================

/**
 * CLI UX Agent input contract.
 *
 * Uses schemas from agentics-contracts for validation.
 */
export interface CLIUXAgentInput {
  /** Raw command line arguments */
  readonly args: string[];
  /** Parsed command object */
  readonly command: ParsedCommand;
  /** Environment context */
  readonly context: AgentContext;
  /** Trace ID for correlation */
  readonly trace_id: string;
}

export interface ParsedCommand {
  readonly command: string;
  readonly subcommand?: string;
  readonly flags: Record<string, boolean>;
  readonly options: Record<string, string>;
  readonly positionalArgs: string[];
}

export interface AgentContext {
  /** Current working directory */
  readonly cwd: string;
  /** Is authenticated */
  readonly authenticated: boolean;
  /** Is execution gate enabled */
  readonly execution_gate_enabled: boolean;
  /** Output format preference */
  readonly output_format: OutputFormat;
  /** Verbose mode */
  readonly verbose: boolean;
  /** Timeout in ms */
  readonly timeout: number;
}

export type OutputFormat = 'json' | 'yaml' | 'table' | 'text' | 'csv';

/**
 * CLI UX Agent output contract.
 */
export interface CLIUXAgentOutput {
  /** Success or failure */
  readonly success: boolean;
  /** Result to display to user */
  readonly result: AgentResult;
  /** Decision event (if emitting) */
  readonly decision_event?: DecisionEvent;
  /** Timing information */
  readonly timing: TimingInfo;
}

export type AgentResult =
  | SuccessResult
  | ErrorResult
  | GuidanceResult;

export interface SuccessResult {
  readonly type: 'success';
  readonly data: unknown;
  readonly artifact_ref?: string;
  readonly services_invoked: string[];
}

export interface ErrorResult {
  readonly type: 'error';
  readonly code: string;
  readonly message: string;
  readonly details?: Record<string, unknown>;
  readonly recoverable: boolean;
}

export interface GuidanceResult {
  readonly type: 'guidance';
  readonly message: string;
  readonly options?: GuidanceOption[];
  readonly next_steps?: string[];
}

export interface GuidanceOption {
  readonly label: string;
  readonly command: string;
  readonly description: string;
}

export interface TimingInfo {
  readonly total_ms: number;
  readonly breakdown: Record<string, number>;
  readonly started_at: string;
  readonly completed_at: string;
}

// ============================================================================
// Agent Registry Types
// ============================================================================

/**
 * Agent registration metadata.
 */
export interface AgentRegistration {
  readonly identifier: AgentIdentifier;
  readonly purpose: string;
  readonly inputs_schema_ref: string;
  readonly outputs_schema_ref: string;
  readonly decision_event_schema_ref: string;
  readonly invocable_services: string[];
  readonly non_responsibilities: string[];
  readonly failure_modes: FailureMode[];
}

export interface FailureMode {
  readonly code: string;
  readonly description: string;
  readonly exit_code: number;
  readonly recoverable: boolean;
}

// ============================================================================
// Telemetry Types (LLM-Observatory Compatible)
// ============================================================================

/**
 * Telemetry event for LLM-Observatory integration.
 */
export interface TelemetryEvent {
  readonly event_type: TelemetryEventType;
  readonly agent_id: string;
  readonly timestamp: string;
  readonly trace_id: string;
  readonly data: TelemetryData;
}

export type TelemetryEventType =
  | 'agent_invocation'
  | 'agent_completion'
  | 'service_call'
  | 'validation_event'
  | 'error_event';

export type TelemetryData =
  | InvocationTelemetry
  | CompletionTelemetry
  | ServiceCallTelemetry
  | ValidationTelemetry
  | ErrorTelemetry;

export interface InvocationTelemetry {
  readonly type: 'invocation';
  readonly command: string;
  readonly subcommand?: string;
  readonly input_hash: string;
}

export interface CompletionTelemetry {
  readonly type: 'completion';
  readonly success: boolean;
  readonly duration_ms: number;
  readonly services_invoked: string[];
}

export interface ServiceCallTelemetry {
  readonly type: 'service_call';
  readonly service: string;
  readonly method: string;
  readonly duration_ms: number;
  readonly status_code: number;
}

export interface ValidationTelemetry {
  readonly type: 'validation';
  readonly schema: string;
  readonly valid: boolean;
  readonly error_count?: number;
}

export interface ErrorTelemetry {
  readonly type: 'error';
  readonly code: string;
  readonly category: string;
  readonly recoverable: boolean;
}

// ============================================================================
// Type Guards
// ============================================================================

export function isSuccessResult(result: AgentResult): result is SuccessResult {
  return result.type === 'success';
}

export function isErrorResult(result: AgentResult): result is ErrorResult {
  return result.type === 'error';
}

export function isGuidanceResult(result: AgentResult): result is GuidanceResult {
  return result.type === 'guidance';
}

// ============================================================================
// Constants
// ============================================================================

/**
 * Current CLI UX Agent version.
 */
export const CLI_UX_AGENT_VERSION = '1.0.0';

/**
 * CLI UX Agent identifier.
 */
export const CLI_UX_AGENT_ID = 'cli-ux-agent';

/**
 * CLI UX Agent classification (always CLI_UX_ORCHESTRATION).
 */
export const CLI_UX_AGENT_CLASSIFICATION: AgentClassification = 'CLI_UX_ORCHESTRATION';

/**
 * Services that CLI UX Agent MAY invoke (per constitution).
 */
export const INVOCABLE_SERVICES = [
  'agentics-org-manifests',
  'agentics-simulation-planner',
  'agentics-simulation-runner',
  'agentics-simulation-engine',
  'agentics-results-index',
  'enterprise-roi-engine',
  'agentics-deployment-intent',
  'agentics-deployment-exporters',
  'diligence-artifacts',
  'ruvector-service',
] as const;

/**
 * Explicit non-responsibilities (per constitution).
 */
export const NON_RESPONSIBILITIES = [
  'Execute inference',
  'Execute workflows',
  'Modify upstream state directly',
  'Apply optimizations',
  'Enforce governance or policy decisions',
  'Trigger retries or automation implicitly',
  'Persist business state',
  'Synthesize executive decisions',
  'Connect directly to databases',
  'Execute SQL',
] as const;
