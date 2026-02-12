/**
 * Type Definitions for agentics-cli
 *
 * SPARC Architecture Reference:
 * - All types defined here are used across modules
 * - Types are interface-based for loose coupling
 * - No business logic in type definitions
 */

// ============================================================================
// Reference Types (SPARC_PSEUDOCODE §9.1)
// ============================================================================

export interface BaseReference {
  id: string;
  type: ReferenceType;
  repository: string;
  created_at: string;
  checksum: string;
}

export type ReferenceType =
  | 'ManifestReference'
  | 'PlanReference'
  | 'SimulationReference'
  | 'SimulationOutputReference'
  | 'RoiReportReference'
  | 'IntentReference'
  | 'ExportReference'
  | 'DiligencePackageReference';

export interface PlanReference extends BaseReference {
  type: 'PlanReference';
  repository: 'agentics-simulation-planner';
  manifest_ref?: ManifestReference;
}

export interface ManifestReference extends BaseReference {
  type: 'ManifestReference';
  repository: 'agentics-org-manifests';
}

export interface SimulationReference extends BaseReference {
  type: 'SimulationReference';
  repository: 'agentics-simulation-runner';
  plan_ref: PlanReference;
  iteration_count?: number;
}

export interface SimulationOutputReference extends BaseReference {
  type: 'SimulationOutputReference';
  repository: 'agentics-simulation-engine';
  sim_ref: SimulationReference;
  output_type: SimulationOutputType;
  artifact_location: string;
}

export type SimulationOutputType =
  | 'metrics'
  | 'logs'
  | 'state'
  | 'events'
  | 'summary'
  | 'full';

export interface RoiReportReference extends BaseReference {
  type: 'RoiReportReference';
  repository: 'enterprise-roi-engine';
  sim_ref: SimulationReference;
  report_type: RoiReportType;
  artifact_location: string;
}

export type RoiReportType =
  | 'executive-summary'
  | 'cfo-grade'
  | 'technical-deep-dive'
  | 'compliance-audit';

export interface IntentReference extends BaseReference {
  type: 'IntentReference';
  repository: 'agentics-deployment-intent';
  sim_ref: SimulationReference;
  status: IntentStatus;
}

export type IntentStatus = 'pending' | 'approved' | 'rejected';

export interface ExportReference extends BaseReference {
  type: 'ExportReference';
  repository: 'agentics-deployment-exporters';
  intent_ref: IntentReference;
  format: ExportFormat;
  artifact_location: string;
}

export type ExportFormat =
  | 'terraform'
  | 'pulumi'
  | 'cloudformation'
  | 'kubernetes'
  | 'helm'
  | 'json'
  | 'yaml';

export interface DiligencePackageReference extends BaseReference {
  type: 'DiligencePackageReference';
  repository: 'diligence-artifacts';
  source_refs: BaseReference[];
  frameworks: ComplianceFramework[];
  package_location: string;
}

export type ComplianceFramework = 'SOC2' | 'HIPAA' | 'GDPR' | 'PCI-DSS' | 'ISO27001' | 'FedRAMP' | 'NIST';

// ============================================================================
// Command Types (SPARC_ARCHITECTURE §2.2)
// ============================================================================

export interface CommandObject {
  command: string;
  subcommand?: string;
  flags: Record<string, boolean>;
  options: Record<string, string>;
  positionalArgs: string[];
}

// ============================================================================
// Natural Language Input Types (SPARC_ARCHITECTURE §2.2.1)
// ============================================================================

/**
 * Input that can be either structured JSON or natural language description.
 * Natural language inputs are forwarded unchanged to downstream services.
 */
export type FlexibleInput<T> = T | NaturalLanguageInput;

export interface NaturalLanguageInput {
  type: 'natural-language';
  description: string;
}

/**
 * Check if input is natural language (not valid JSON)
 */
export function isNaturalLanguageInput(value: string): boolean {
  if (!value || value.trim() === '') return false;
  const trimmed = value.trim();
  // JSON objects start with { or [
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      JSON.parse(trimmed);
      return false; // Valid JSON, not natural language
    } catch {
      return true; // Looks like JSON but isn't valid - treat as NL
    }
  }
  return true; // Doesn't look like JSON, is natural language
}

/**
 * Parse input that can be either JSON or natural language.
 * Returns parsed JSON if valid, otherwise returns NaturalLanguageInput wrapper.
 */
export function parseFlexibleInput<T>(value: string): FlexibleInput<T> {
  if (!value || value.trim() === '') {
    return { type: 'natural-language', description: '' };
  }

  const trimmed = value.trim();

  // Try to parse as JSON if it looks like JSON
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return JSON.parse(trimmed) as T;
    } catch {
      // Invalid JSON syntax - treat as natural language
      return { type: 'natural-language', description: value };
    }
  }

  // Not JSON - treat as natural language description
  return { type: 'natural-language', description: value };
}

/**
 * Check if a FlexibleInput is a NaturalLanguageInput
 */
export function isNaturalLanguage<T>(input: FlexibleInput<T>): input is NaturalLanguageInput {
  return typeof input === 'object' &&
         input !== null &&
         'type' in input &&
         (input as NaturalLanguageInput).type === 'natural-language';
}

export interface CommandOptions {
  timeout?: number;
  trace_id?: string;
  format?: OutputFormat;
  verbose?: boolean;
}

// ============================================================================
// Orchestration Types (SPARC_ARCHITECTURE §2.3)
// ============================================================================

export interface OrchestrationResult {
  stages: StageResult[];
  artifacts: ArtifactReference[];
  timing: TimingInfo;
  success: boolean;
}

export interface StageResult {
  name: string;
  status: StageStatus;
  response: unknown;
  error?: ErrorInfo;
  timing: number;
}

export type StageStatus = 'pending' | 'running' | 'complete' | 'failed';

export interface ArtifactReference {
  id: string;
  type: string;
  location: string;
  checksum?: string;
  metadata?: Record<string, string>;
}

export interface TimingInfo {
  total: number;
  breakdown: Record<string, number>;
  started_at: string;
  completed_at: string;
}

// ============================================================================
// Adapter Types (SPARC_ARCHITECTURE §2.4)
// ============================================================================

export interface AdapterRequest {
  endpoint: string;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  headers: Record<string, string>;
  body?: unknown;
  timeout?: number;
}

export interface AdapterResponse {
  status: number;
  headers: Record<string, string>;
  body: unknown;
  timing: number;
}

export interface HealthStatus {
  healthy: boolean;
  latency: number;
  version?: string;
}

export interface EndpointConfig {
  baseUrl: string;
  version: string;
  timeout: number;
}

// ============================================================================
// Error Types (SPARC_PSEUDOCODE §4.1)
// ============================================================================

export interface ErrorInfo {
  code: string;
  category: ErrorCategory;
  message: string;
  details?: Record<string, unknown>;
  stack?: string;
  timestamp: string;
  module: string;
  correlationId?: string;
}

export type ErrorCategory =
  | 'INPUT_ERROR'
  | 'NETWORK_ERROR'
  | 'DOWNSTREAM_ERROR'
  | 'INTERNAL_ERROR'
  | 'CONFIG_ERROR'
  | 'AUTH_ERROR';

export interface ContractViolation {
  service: string;
  expected_contract: string;
  actual_response: unknown;
  violation_type: ViolationType;
}

export type ViolationType = 'schema_mismatch' | 'missing_field' | 'type_error' | 'missing_contract';

// ============================================================================
// Audit Types (SPARC_PSEUDOCODE §6.1)
// ============================================================================

export interface AuditEntry {
  id: string;
  version: string;
  command: string;
  inputs_hash: string;
  inputs_redacted: unknown;
  outputs: BaseReference | null;
  dependencies: string[];
  timestamp: string;
  duration_ms: number;
  status: 'SUCCESS' | 'FAILED';
  error_code?: string;
  error_message?: string;
  trace_id: string;
  parent_id?: string;
  checksum: string;
}

export interface DownstreamCall {
  service: string;
  method: string;
  timestamp: string;
  duration_ms: number;
  success: boolean;
}

// ============================================================================
// Live Tracking Types (Statusline Integration)
// ============================================================================

/**
 * Tracking file written to ~/.agentics/agents/<id>.json
 * while a Task agent is running. File existence = agent alive.
 */
export interface ActiveAgent {
  type: string;
  prompt_snippet: string;
  started_at: string;
}

/**
 * Tracking file written to ~/.agentics/calls/<id>.json
 * while an HTTP call is in-flight. File existence = call active.
 */
export interface ActiveDownstreamCall {
  service: string;
  endpoint: string;
  method: string;
  started_at: string;
  correlation_id?: string;
}

// ============================================================================
// Output Types (SPARC_ARCHITECTURE §2.6)
// ============================================================================

export type OutputFormat = 'json' | 'yaml' | 'table' | 'text' | 'csv';

export interface OutputOptions {
  format: OutputFormat;
  pretty?: boolean;
  colorize?: boolean;
  destination?: 'stdout' | 'stderr' | string;
  includeStack?: boolean;
}

// ============================================================================
// Configuration Types
// ============================================================================

export interface CLIConfig {
  endpoints: EndpointRegistry;
  timeout: number;
  trace_id?: string;
  auth_token?: string;
  log_level: LogLevel;
}

export type LogLevel = 'error' | 'warn' | 'info' | 'debug';

export interface EndpointRegistry {
  'agentics-org-manifests': EndpointConfig;
  'agentics-simulation-planner': EndpointConfig;
  'agentics-simulation-runner': EndpointConfig;
  'agentics-simulation-engine': EndpointConfig;
  'agentics-results-index': EndpointConfig;
  'enterprise-roi-engine': EndpointConfig;
  'agentics-deployment-intent': EndpointConfig;
  'agentics-deployment-exporters': EndpointConfig;
  'diligence-artifacts': EndpointConfig;
  'agentics-usage-ledger': EndpointConfig;
  'ruvector-service': EndpointConfig;
}

// ============================================================================
// Exit Codes (SPARC_REFINEMENT §5.5)
// ============================================================================

export const EXIT_CODES = {
  SUCCESS: 0,
  GENERAL_ERROR: 1,
  MISUSE: 2,
  USAGE_ERROR: 64,
  DATA_FORMAT_ERROR: 65,
  CANNOT_OPEN_INPUT: 66,
  SERVICE_UNAVAILABLE: 69,
  INTERNAL_ERROR: 70,
  IO_ERROR: 74,
  TEMPORARY_FAILURE: 75,
  PERMISSION_DENIED: 77,
  CONFIG_ERROR: 78,
  // Reserved for agentics-cli
  ARG_VALIDATION_ERROR: 100,
  CONFIG_VALIDATION_ERROR: 110,
  NETWORK_ERROR: 120,
  AUTH_ERROR: 130,
  SERVICE_ERROR: 140,
  RUVECTOR_ACCEPTANCE_FAILED: 141,
  META_SIMULATION_ROUTING_FAILED: 142,
  INTERNAL_CLI_ERROR: 150,
} as const;

export type ExitCode = (typeof EXIT_CODES)[keyof typeof EXIT_CODES];

// ============================================================================
// Authentication Types (CLI Auth Flow)
// ============================================================================

export interface AuthSession {
  session_id: string;
  verification_url: string;
  user_code: string;
  expires_at: string;
  interval: number;
}

export interface AuthCredentials {
  api_key: string;
  created_at: string;
  expires_at?: string;
  email?: string;
  user_id?: string;
  payment_status?: 'paid' | 'free' | 'unknown';
}

export interface AuthTokenResponse {
  api_key: string;
  expires_at?: string;
  user_id?: string;
}

export type AuthSessionStatus = 'pending' | 'authorized' | 'expired' | 'denied';

// ============================================================================
// Identity Types (Identity + Org + Roles)
// ============================================================================

export type OrgRole = 'owner' | 'admin' | 'member';

export interface UserIdentity {
  user_id: string;
  display_name: string;
  created_at: string;
}

export interface OrgIdentity {
  org_id: string;
  org_name: string;
  created_at: string;
}

export interface IdentityContext {
  user: UserIdentity;
  org: OrgIdentity;
  role: OrgRole;
  resolved_at: string;
}

export interface Attribution {
  created_by: string;
  org_id: string;
}

// ============================================================================
// ADR-004: Enterprise Integration & Memory Architecture Types
// ============================================================================

/**
 * Artifact categories persisted into Ruvector (ADR-004, Domain 1).
 * Every artifact is an inert proposal produced by a simulation.
 */
export type ArtifactCategory =
  | 'simulation'
  | 'plan'
  | 'risk_assessment'
  | 'cost_projection'
  | 'integration_mapping'
  | 'erp_proposal'
  | 'decision'
  | 'deployment';

/**
 * Lineage record linking an artifact to its parent simulation (ADR-004, Domain 2).
 * Stored in Ruvector as first-class data, not inferred from timestamps.
 *
 * Invariant 3: No integration proposal exists without traceability to
 * a simulation, a plan, and a decision context.
 */
export interface LineageRecord {
  /** Unique lineage record ID */
  id: string;
  /** The artifact this lineage entry describes */
  artifact_id: string;
  /** The category of the artifact */
  artifact_category: ArtifactCategory;
  /** The simulation that produced this artifact (Invariant 2) */
  simulation_id: string;
  /** The plan this artifact belongs to (if applicable) */
  plan_id?: string;
  /** The natural language input that seeded synthesis */
  decision_context: string;
  /** Identity attribution (user_id, org_id) */
  attribution: Attribution;
  /** Governance metadata: which gate pipeline version was applied */
  governance: {
    gate_pipeline_version: string;
    synthesis_classification: string;
  };
  /** Immutable creation timestamp */
  created_at: string;
}

/**
 * Simulation memory footprint persisted in Ruvector (ADR-004, Invariant 1).
 * A simulation that exists only in memory is not a simulation —
 * it is an untracked computation.
 */
export interface SimulationMemoryRecord {
  /** Simulation identifier */
  id: string;
  type: 'simulation';
  /** Natural language input that seeded synthesis */
  intent: string;
  /** Simulation status lifecycle */
  status: 'created' | 'running' | 'completed' | 'failed';
  /** Simulation result data (when completed) */
  result?: unknown;
  /** Identity attribution */
  attribution: Attribution;
  /** IDs of artifacts this simulation has produced */
  artifact_ids: string[];
  /** Immutable creation timestamp */
  created_at: string;
  /** Last updated timestamp */
  updated_at: string;
  /** Data integrity checksum */
  checksum: string;
}

/**
 * Integration proposal derived from a simulation (ADR-004, Domain 3).
 * Proposals describe what would change in an enterprise system.
 * They are never created outside of the simulation lifecycle.
 */
export interface IntegrationProposal {
  /** Proposal identifier */
  id: string;
  type: 'integration_proposal';
  /** The integration system affected (e.g. 'sap', 'salesforce') */
  integration_name: string;
  /** What changes would be required */
  proposed_changes: string;
  /** Risks introduced by this change */
  risks: string[];
  /** Dependencies on other proposals or artifacts */
  dependencies: string[];
  /** Simulation that produced this proposal (Invariant 2) */
  simulation_id: string;
  /** Plan this proposal belongs to */
  plan_id?: string;
  /** Identity attribution */
  attribution: Attribution;
  /** Immutable creation timestamp */
  created_at: string;
}

/**
 * ERP Surface mapping derived from a simulation (ADR-004, Domain 4).
 * Describes how enterprise-wide processes would be affected.
 * ERP Surface never initiates simulations — it receives proposals.
 */
export interface ErpSurfaceMapping {
  /** Mapping identifier */
  id: string;
  type: 'erp_mapping';
  /** ERP system type */
  erp_type: string;
  /** Entity type affected */
  entity_type: string;
  /** Proposed changes to the enterprise model */
  proposed_implementation: unknown;
  /** Simulation that produced this mapping (Invariant 2) */
  simulation_id: string;
  /** Integration proposals this mapping depends on */
  integration_proposal_ids: string[];
  /** Identity attribution */
  attribution: Attribution;
  /** Immutable creation timestamp */
  created_at: string;
}

// ============================================================================
// Ruvector-Rooted Execution Span Types
// ============================================================================

/** A span in the execution graph, rooted at ruvector-service */
export interface ExecutionSpan {
  span_id: string;
  parent_span_id: string | null;
  service: string;
  operation: string;
  status: 'started' | 'completed' | 'failed';
  started_at: string;
  completed_at?: string;
  duration_ms?: number;
  children: ExecutionSpan[];
  metadata?: Record<string, unknown>;
}

/** Complete ruvector-rooted execution graph for CLI output */
export interface RuvectorRootedGraph {
  graph_id: string;
  root: ExecutionSpan;
  total_spans: number;
  created_at: string;
}

/** Result of ruvector acceptance (blocking) */
export interface RuvectorAcceptanceResult {
  accepted: boolean;
  ruvector_span_id: string;
  graph: RuvectorRootedGraph;
  timing_ms: number;
}

/** Downstream span descriptor for graph construction */
export interface DownstreamSpanDescriptor {
  service: string;
  operation: string;
  status: 'completed' | 'failed';
  started_at: string;
  completed_at: string;
  duration_ms: number;
  children?: DownstreamSpanDescriptor[];
}
