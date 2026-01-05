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
  | 'detailed-analysis'
  | 'cfo-grade'
  | 'custom';

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
  | 'kubernetes'
  | 'cloudformation'
  | 'pulumi'
  | 'ansible'
  | 'custom';

export interface DiligencePackageReference extends BaseReference {
  type: 'DiligencePackageReference';
  repository: 'diligence-artifacts';
  source_refs: BaseReference[];
  frameworks: ComplianceFramework[];
  package_location: string;
}

export type ComplianceFramework = 'SOC2' | 'HIPAA' | 'GDPR' | 'PCI-DSS' | 'custom';

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
  'enterprise-roi-engine': EndpointConfig;
  'agentics-deployment-intent': EndpointConfig;
  'agentics-deployment-exporters': EndpointConfig;
  'diligence-artifacts': EndpointConfig;
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
  INTERNAL_CLI_ERROR: 150,
} as const;

export type ExitCode = (typeof EXIT_CODES)[keyof typeof EXIT_CODES];
