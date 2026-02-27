/**
 * Phase 6 Pipeline Type Definitions
 *
 * Complete type system for the Phase 6 pipeline: ERP surface push.
 * Handles Phase 4 artifact validation, ERP service registration,
 * project materialization, deployment finalization, and manifest writing.
 *
 * All types are designed for strict TypeScript (strict: true, ES2022 target,
 * NodeNext modules). Interfaces use readonly fields throughout.
 */

// ============================================================================
// Phase 2 Re-exports (consumed by Phase 6)
// ============================================================================

import type { TelemetrySpan } from '../phase2/types.js';

export type { TelemetrySpan };

// ============================================================================
// Phase 6 Stages
// ============================================================================

/** The stages that the Phase 6 pipeline executes in order. */
export type Phase6Stage =
  | 'phase5-validation'
  | 'service-registration'
  | 'project-materialization'
  | 'deployment-finalization'
  | 'manifest-writing';

// ============================================================================
// Stage Output Types
// ============================================================================

/** Output produced by a single Phase 6 pipeline stage. */
export interface Phase6StageOutput {
  /** The stage that produced this output. */
  readonly stage: Phase6Stage;
  /** Whether the stage completed successfully, failed, or was skipped. */
  readonly status: 'completed' | 'failed' | 'skipped';
  /** Stage-specific output data. */
  readonly data: unknown;
  /** Paths to artifacts written by this stage. */
  readonly artifacts: string[];
  /** Wall-clock time in milliseconds for this stage. */
  readonly timing: number;
  /** Human-readable summary of what the stage accomplished. */
  readonly summary?: string;
}

// ============================================================================
// Phase 4 Artifacts (loaded from disk)
// ============================================================================

/**
 * Reference to the Phase 5 Build manifest loaded from phase4-manifest.json.
 * Uses an index signature for forward-compatible extensibility.
 */
export interface Phase5ManifestRef {
  /** Schema version for this manifest format. */
  readonly schema_version: string;
  /** Unique trace identifier for the Phase 5 Build pipeline run. */
  readonly trace_id: string;
  /** The resolved implementation language. */
  readonly implementation_language: string;
  /** The resolved ERP system identifier. */
  readonly erp_system: string;
  /** The resolved database engine identifier, or null for API-only ERPs. */
  readonly database_engine: string | null;
  /** Whether the ERP system is accessed via API only. */
  readonly api_only: boolean;
  /** All artifacts produced by Phase 4. */
  readonly artifacts: ReadonlyArray<{ path: string; sha256: string; size_bytes: number }>;
  /** Total wall-clock time in milliseconds for the Phase 5 Build pipeline. */
  readonly total_timing_ms: number;
  /** Whether the Phase 5 Build pipeline completed successfully. */
  readonly success: boolean;
  /** Allow additional properties for forward compatibility. */
  [key: string]: unknown;
}

/**
 * Aggregated set of Phase 5 Build artifacts consumed by the Phase 6 pipeline.
 * Each field corresponds to data loaded from the Phase 5 Build output directory.
 */
export interface Phase5Artifacts {
  /** The Phase 5 Build manifest loaded from phase4-manifest.json. */
  readonly manifest: Phase5ManifestRef;
  /** The resolved implementation language for the project. */
  readonly implementationLanguage: string;
  /** The resolved ERP system identifier. */
  readonly erpSystem: string;
  /** The resolved database engine identifier, or null for API-only ERPs. */
  readonly databaseEngine: string | null;
  /** Whether the ERP system is accessed via API only. */
  readonly apiOnly: boolean;
  /** Absolute path to the Phase 4 project output directory. */
  readonly projectDir: string;
}

// ============================================================================
// ERP Surface Registration Types
// ============================================================================

/**
 * Mapping of a single HTTP endpoint to an ERP service entity.
 */
export interface ERPEndpointMapping {
  /** HTTP method for this endpoint. */
  readonly method: 'GET' | 'POST';
  /** URL path for this endpoint. */
  readonly path: string;
  /** The SAP service this endpoint maps to. */
  readonly sap_service: string;
  /** The SAP entity this endpoint operates on. */
  readonly sap_entity: string;
  /** Human-readable description of what this endpoint does. */
  readonly description: string;
}

/**
 * Complete ERP surface registration record describing how a service
 * is registered with and connected to an ERP system.
 */
export interface ERPSurfaceRegistration {
  /** Unique identifier for this registration. */
  readonly registration_id: string;
  /** Name of the service being registered. */
  readonly service_name: string;
  /** The ERP system this service integrates with. */
  readonly erp_system: string;
  /** The ERP vendor for this registration. */
  readonly erp_vendor: 'sap' | 'oracle' | 'dynamics' | 'workday' | 'netsuite' | 'servicenow';
  /** The business domain surface this service covers. */
  readonly surface_domain: 'procurement' | 'finance' | 'hcm' | 'supply-chain';
  /** Endpoint mappings from HTTP routes to ERP entities. */
  readonly endpoints: ReadonlyArray<ERPEndpointMapping>;
  /** The connector protocol used to communicate with the ERP system. */
  readonly connector_type: 'odata-v4' | 'rest' | 'soap' | 'rfc';
  /** VPC networking configuration for the ERP connector. */
  readonly vpc_config: {
    readonly connector_name: string;
    readonly cidr_range: string;
    readonly ingress: string;
  };
  /** IAM configuration for service authentication and authorization. */
  readonly iam_config: {
    readonly service_account: string;
    readonly roles: string[];
  };
  /** Governance controls for the ERP surface. */
  readonly governance: {
    readonly read_only: boolean;
    readonly audit_enabled: boolean;
    readonly pii_redaction: boolean;
    readonly max_tokens_per_request: number;
  };
  /** ISO-8601 timestamp of when this registration was created. */
  readonly created_at: string;
}

// ============================================================================
// Pipeline Context Types
// ============================================================================

/**
 * Mutable pipeline context threaded through all Phase 6 stages.
 * Accumulates stage outputs and telemetry as the pipeline progresses.
 */
export interface Phase6Context {
  /** Unique trace identifier for this pipeline run. */
  readonly traceId: string;
  /** Absolute path to the Phase 5 Build output directory. */
  readonly phase5Dir: string;
  /** Absolute path to the Phase 6 output directory. */
  readonly phase6Dir: string;
  /** The original scenario query driving this pipeline run. */
  readonly scenarioQuery: string;
  /** Phase 5 Build artifacts loaded from disk. */
  readonly phase5Artifacts: Phase5Artifacts;
  /** Absolute paths to platform repository roots, keyed by repository name. */
  readonly platformRepoPaths: Record<string, string>;
  /** Accumulated stage outputs keyed by stage name. */
  readonly stageOutputs: Map<Phase6Stage, Phase6StageOutput>;
  /** Telemetry spans collected during pipeline execution. */
  readonly telemetrySpans: TelemetrySpan[];
}

// ============================================================================
// Manifest Types
// ============================================================================

/** A hashed artifact reference in the Phase 6 manifest. */
export interface Phase6ManifestArtifact {
  /** Relative path to the artifact file. */
  readonly path: string;
  /** SHA-256 hash of the artifact contents. */
  readonly sha256: string;
  /** Size of the artifact file in bytes. */
  readonly size_bytes: number;
}

/**
 * The Phase 6 manifest written to disk at the end of a successful run.
 * Provides a complete record of the ERP surface registration, endpoints,
 * all artifacts, and total timing.
 */
export interface Phase6Manifest {
  /** Schema version for this manifest format. */
  readonly schema_version: '6.0.0';
  /** Unique trace identifier for this pipeline run. */
  readonly trace_id: string;
  /** The ERP system this service integrates with. */
  readonly erp_system: string;
  /** Name of the registered service. */
  readonly service_name: string;
  /** Unique registration identifier for the ERP surface. */
  readonly registration_id: string;
  /** Endpoint mappings registered with the ERP surface. */
  readonly endpoints: ReadonlyArray<{ method: string; path: string; sap_service: string }>;
  /** All artifacts produced by the pipeline. */
  readonly artifacts: ReadonlyArray<Phase6ManifestArtifact>;
  /** Total wall-clock time in milliseconds for the entire pipeline. */
  readonly total_timing_ms: number;
  /** Whether the pipeline completed successfully. */
  readonly success: boolean;
}

// ============================================================================
// Pipeline Result Types
// ============================================================================

/**
 * The final result returned by the Phase 6 pipeline after all stages
 * have completed (or the first stage has failed).
 */
export interface Phase6PipelineResult {
  /** Unique trace identifier for this pipeline run. */
  readonly traceId: string;
  /** Absolute path to the Phase 6 output directory. */
  readonly phase6Dir: string;
  /** The manifest written at the end of the pipeline. */
  readonly manifest: Phase6Manifest;
  /** Ordered list of stage outputs from the pipeline run. */
  readonly stageResults: Phase6StageOutput[];
  /** Total wall-clock time in milliseconds for the entire pipeline. */
  readonly totalTiming: number;
}
