/**
 * Phase 4 Pipeline Type Definitions
 *
 * Complete type system for the Phase 4 pipeline: Phase 3 artifact validation,
 * ERP target resolution, schema generation, infrastructure adapter generation,
 * HTTP server generation, ERP client generation, deployment generation,
 * metadata augmentation, and manifest writing.
 *
 * All types are designed for strict TypeScript (strict: true, ES2022 target,
 * NodeNext modules). Interfaces use readonly fields throughout.
 */

// ============================================================================
// Phase 2 / Phase 3 Re-exports (consumed by Phase 4)
// ============================================================================

import type {
  Phase2SPARCOutput,
  Phase2ADRRecord,
  Phase2DomainModel,
  TDDPlan,
  TelemetrySpan,
  Phase2Manifest,
} from '../phase2/types.js';

import type {
  Phase3Manifest,
  ImplementationLanguage,
  Phase2Artifacts,
} from '../phase3/types.js';
import { hasTemplateSupport } from '../phase3/types.js';

import type {
  ERPSystem,
  DatabaseEngine,
  SQLDialect,
} from '../../deps/erp-database-map.js';

export type {
  Phase2SPARCOutput,
  Phase2ADRRecord,
  Phase2DomainModel,
  TDDPlan,
  TelemetrySpan,
  Phase2Manifest,
  Phase3Manifest,
  ImplementationLanguage,
  Phase2Artifacts,
  ERPSystem,
  DatabaseEngine,
  SQLDialect,
};
export { hasTemplateSupport };

// ============================================================================
// Phase 3 Artifacts (loaded from disk)
// ============================================================================

/**
 * Aggregated set of Phase 3 artifacts consumed by the Phase 4 pipeline.
 * Each field corresponds to a JSON file written by Phase 3.
 */
export interface Phase3Artifacts {
  /** The Phase 3 manifest loaded from phase3-manifest.json. */
  readonly manifest: Phase3Manifest;
  /** The resolved implementation language for the project. */
  readonly implementationLanguage: ImplementationLanguage;
  /** Absolute path to the Phase 3 project output directory. */
  readonly projectDir: string;
  /** The Phase 2 artifacts that were consumed by Phase 3. */
  readonly phase2Artifacts: Phase2Artifacts;
}

// ============================================================================
// ERP Resolution Types
// ============================================================================

/**
 * The resolved ERP system and associated database details for Phase 4.
 * Aggregates all detection signals into a final integration decision.
 */
export interface ERPResolution {
  /** The detected ERP system. */
  readonly erpSystem: ERPSystem;
  /** The primary database engine associated with the ERP system, or null for API-only ERPs. */
  readonly databaseEngine: DatabaseEngine | null;
  /** The SQL dialect associated with the database engine, or null for API-only ERPs. */
  readonly sqlDialect: SQLDialect | null;
  /** Whether the ERP system is accessed via API only (no direct database access). */
  readonly apiOnly: boolean;
  /** The source pipeline artifact that provided the strongest detection signal. */
  readonly detectionSource: 'scenario-query' | 'sparc-services' | 'dossier-items' | 'adr-context';
  /** Confidence in the ERP resolution (0.0 - 1.0). */
  readonly confidence: number;
  /** Named integration points between the project and the ERP system. */
  readonly integrationPoints: string[];
  /** Constraints imposed by the ERP system on the integration design. */
  readonly constraints: string[];
  /** The target cloud provider for deployment. Defaults to 'gcp' for backward compatibility. */
  readonly cloudProvider?: 'aws' | 'gcp' | 'azure' | 'alibaba' | 'on-prem';
}

// ============================================================================
// Generated File Types
// ============================================================================

/**
 * A single file produced by a Phase 4 generation stage.
 */
export interface GeneratedFile {
  /** Path relative to the Phase 4 output directory. */
  readonly relativePath: string;
  /** The full text content of the generated file. */
  readonly content: string;
  /** The category or purpose of this file (e.g. 'schema', 'adapter', 'server'). */
  readonly kind: string;
}

/**
 * A generated database schema file for a specific SQL dialect and bounded context.
 */
export interface SchemaFile extends GeneratedFile {
  /** The SQL dialect this schema is written in. */
  readonly dialect: SQLDialect;
  /** The DDD bounded context this schema covers. */
  readonly boundedContext: string;
  /** The number of tables defined in this schema file. */
  readonly tableCount: number;
}

/**
 * A generated infrastructure adapter file bridging a DDD port to an ERP system.
 */
export interface AdapterFile extends GeneratedFile {
  /** The DDD bounded context this adapter belongs to. */
  readonly boundedContext: string;
  /** The port interface this adapter implements. */
  readonly portInterface: string;
}

/**
 * A generated HTTP server file (routes, handlers, middleware).
 */
export interface ServerFile extends GeneratedFile {}

/**
 * A generated ERP API client file.
 */
export interface ClientFile extends GeneratedFile {}

/**
 * A generated deployment configuration file (Cloud Run, Dockerfile, etc.).
 */
export interface DeploymentFile extends GeneratedFile {}

// ============================================================================
// Stage Output Types
// ============================================================================

/**
 * Output of the schema generation stage.
 */
export interface SchemaGenOutput {
  /** The SQL dialect used for schema generation, or null if skipped. */
  readonly dialect: SQLDialect | null;
  /** All generated schema files. */
  readonly files: SchemaFile[];
  /** Total number of tables across all schema files. */
  readonly tableCount: number;
  /** Whether schema generation was skipped (e.g. API-only ERP). */
  readonly skipped: boolean;
  /** Human-readable reason why schema generation was skipped, if applicable. */
  readonly skipReason?: string;
}

/**
 * Output of the infrastructure adapter generation stage.
 */
export interface InfraAdapterOutput {
  /** All generated adapter files. */
  readonly adapters: AdapterFile[];
  /** Total number of adapters generated. */
  readonly totalAdapters: number;
  /** Serialised connection pool configuration used across all adapters. */
  readonly connectionPoolConfig: string;
}

/**
 * Output of the HTTP server generation stage.
 */
export interface HttpServerOutput {
  /** The HTTP framework used for code generation. */
  readonly framework: 'hono' | 'axum';
  /** All generated server files. */
  readonly files: ServerFile[];
  /** Total number of routes registered across all server files. */
  readonly routeCount: number;
}

/**
 * Output of the ERP client generation stage.
 */
export interface ERPClientOutput {
  /** All generated ERP client files. */
  readonly files: ClientFile[];
  /** Total number of ERP API endpoints covered by the generated clients. */
  readonly endpointCount: number;
}

/**
 * Output of the deployment configuration generation stage.
 */
export interface DeploymentOutput {
  /** All generated deployment files. */
  readonly files: DeploymentFile[];
  /** Name of the deployed service (Cloud Run, ECS, or Container Apps). */
  readonly cloudRunService: string;
}

/**
 * A runtime Architecture Decision Record created during the metadata
 * augmentation stage to document Phase 4 integration decisions.
 */
export interface RuntimeDecision {
  /** Unique identifier for this runtime decision. */
  readonly id: string;
  /** Short descriptive title. */
  readonly title: string;
  /** Background and forces that led to this decision. */
  readonly context: string;
  /** The decision that was made. */
  readonly decision: string;
  /** Explanation of why this decision was chosen over alternatives. */
  readonly rationale: string;
}

/**
 * Output of the metadata augmentation stage.
 */
export interface MetadataAugmentOutput {
  /** Number of existing Phase 2/3 ADRs augmented with Phase 4 context. */
  readonly augmentedADRCount: number;
  /** New runtime decisions recorded during Phase 4 execution. */
  readonly runtimeDecisions: RuntimeDecision[];
}

// ============================================================================
// Pipeline Context Types
// ============================================================================

/** The stages that the Phase 4 pipeline executes in order. */
export type Phase4Stage =
  | 'phase3-validation'
  | 'erp-target-resolution'
  | 'schema-generation'
  | 'infra-adapter-generation'
  | 'http-server-generation'
  | 'erp-client-generation'
  | 'rust-optimizer-generation'
  | 'deployment-generation'
  | 'metadata-augmentation'
  | 'manifest-writing';

/** Output produced by a single Phase 4 pipeline stage. */
export interface Phase4StageOutput {
  /** The stage that produced this output. */
  readonly stage: Phase4Stage;
  /** Whether the stage completed successfully or failed. */
  readonly status: 'completed' | 'failed';
  /** Stage-specific output data. */
  readonly data: unknown;
  /** Paths to artifacts written by this stage. */
  readonly artifacts: string[];
  /** Wall-clock time in milliseconds for this stage. */
  readonly timing: number;
  /** Human-readable summary of what the stage accomplished. */
  readonly summary: string;
}

/**
 * Mutable pipeline context threaded through all Phase 4 stages.
 * Accumulates stage outputs and telemetry as the pipeline progresses.
 */
/** ADR-052: Simulation context from RuVector (Pass 2) and CostOps (Pass 4). */
export interface SimulationContext {
  readonly scenarios: ReadonlyArray<{
    id: string;
    name: string;
    costDelta: number;
    riskLevel: string;
    mitigationStrategy: string;
    reliability: number;
  }>;
  readonly costModel: {
    baselineCost: number;
    scenarioVariants: ReadonlyArray<{ scenarioId: string; costDelta: number; explanation: string }>;
    budgetThreshold: number;
    roi: number;
    confidence: number;
  } | null;
  readonly riskSignals: ReadonlyArray<{ signal: string; severity: string; source: string }>;
  readonly simulationId: string | null;
}

export interface Phase4Context {
  /** Unique trace identifier for this pipeline run. */
  readonly traceId: string;
  /** Absolute path to the Phase 2 output directory. */
  readonly phase2Dir: string;
  /** Absolute path to the Phase 3 output directory. */
  readonly phase3Dir: string;
  /** Absolute path to the Phase 4 output directory. */
  readonly phase4Dir: string;
  /** The original scenario query driving this pipeline run. */
  readonly scenarioQuery: string;
  /** Phase 3 artifacts loaded from disk. */
  readonly phase3Artifacts: Phase3Artifacts;
  /** Absolute paths to platform repository roots, keyed by repository name. */
  readonly platformRepoPaths: Record<string, string>;
  /** Accumulated stage outputs keyed by stage name. */
  readonly stageOutputs: Map<Phase4Stage, Phase4StageOutput>;
  /** Telemetry spans collected during pipeline execution. */
  readonly telemetrySpans: TelemetrySpan[];
  /** ADR-052: Simulation results from RuVector + CostOps, loaded from pipeline run directory. */
  readonly simulationContext?: SimulationContext;
}

// ============================================================================
// Manifest Types
// ============================================================================

/** A hashed artifact reference in the Phase 4 manifest. */
export interface Phase4ManifestArtifact {
  /** Relative path to the artifact file. */
  readonly path: string;
  /** SHA-256 hash of the artifact contents. */
  readonly sha256: string;
  /** Size of the artifact file in bytes. */
  readonly size_bytes: number;
}

/**
 * The Phase 4 manifest written to disk at the end of a successful run.
 * Provides a complete record of the ERP target, database engine, all
 * artifacts, and total timing.
 */
export interface Phase4Manifest {
  /** Schema version for this manifest format. */
  readonly schema_version: '4.0.0';
  /** Unique trace identifier for this pipeline run. */
  readonly trace_id: string;
  /** The resolved implementation language. */
  readonly implementation_language: ImplementationLanguage;
  /** The resolved ERP system identifier. */
  readonly erp_system: string;
  /** The resolved database engine identifier, or null for API-only ERPs. */
  readonly database_engine: string | null;
  /** Whether the ERP system is accessed via API only. */
  readonly api_only: boolean;
  /** All artifacts produced by the pipeline. */
  readonly artifacts: Phase4ManifestArtifact[];
  /** Total wall-clock time in milliseconds for the entire pipeline. */
  readonly total_timing_ms: number;
  /** Whether the pipeline completed successfully. */
  readonly success: boolean;
}

// ============================================================================
// Pipeline Result Types
// ============================================================================

/**
 * The final result returned by the Phase 4 pipeline after all stages
 * have completed (or the first stage has failed).
 */
export interface Phase4PipelineResult {
  /** Unique trace identifier for this pipeline run. */
  readonly traceId: string;
  /** Absolute path to the Phase 4 output directory. */
  readonly phase4Dir: string;
  /** The manifest written at the end of the pipeline. */
  readonly manifest: Phase4Manifest;
  /** Ordered list of stage outputs from the pipeline run. */
  readonly stageResults: Phase4StageOutput[];
  /** Total wall-clock time in milliseconds for the entire pipeline. */
  readonly totalTiming: number;
}
