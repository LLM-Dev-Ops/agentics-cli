/**
 * Phase 3 Pipeline Type Definitions
 *
 * Complete type system for the Phase 3 pipeline: Phase 2 artifact validation,
 * language resolution, scaffold generation, domain codegen, test generation,
 * Ruflo execution, and manifest writing.
 *
 * All types are designed for strict TypeScript (strict: true, ES2022 target,
 * NodeNext modules). Interfaces use readonly fields throughout.
 */

// ============================================================================
// Phase 2 Re-exports (consumed by Phase 3)
// ============================================================================

import type {
  Phase2SPARCOutput,
  Phase2ADRRecord,
  Phase2DomainModel,
  TDDPlan,
  TelemetrySpan,
  Phase2Manifest,
} from '../phase2/types.js';

export type { Phase2SPARCOutput, Phase2ADRRecord, Phase2DomainModel, TDDPlan, TelemetrySpan };

// ============================================================================
// Phase 2 Artifacts (loaded from disk)
// ============================================================================

/**
 * Aggregated set of Phase 2 artifacts consumed by the Phase 3 pipeline.
 * Each field corresponds to a JSON file written by Phase 2.
 */
export interface Phase2Artifacts {
  /** The Phase 2 manifest loaded from phase2-manifest.json. */
  readonly manifest: Phase2Manifest;
  /** The combined SPARC output loaded from sparc/sparc-combined.json. */
  readonly sparc: Phase2SPARCOutput;
  /** The ADR index loaded from adrs/adr-index.json. */
  readonly adrs: Phase2ADRRecord[];
  /** The domain model loaded from ddd/domain-model.json. */
  readonly domainModel: Phase2DomainModel;
  /** The TDD plan loaded from tdd/tdd-plan.json. */
  readonly tddPlan: TDDPlan;
}

// ============================================================================
// Language Resolution Types
// ============================================================================

/** The two implementation languages supported by Phase 3. */
export type ImplementationLanguage = 'rust' | 'typescript';

/**
 * A single signal contributing to language resolution.
 * Each signal captures evidence from a specific source that favors
 * one implementation language over the other.
 */
export interface LanguageSignal {
  /** Human-readable name for this signal. */
  readonly name: string;
  /** The pipeline source that produced this signal. */
  readonly source: 'sparc' | 'adr' | 'ddd' | 'query' | 'explicit';
  /** Which implementation language this signal favors. */
  readonly favors: ImplementationLanguage;
  /** Relative importance of this signal (0.0 - 1.0). */
  readonly weight: number;
  /** Computed score: weight * confidence. */
  readonly score: number;
  /** Confidence in this signal's accuracy (0.0 - 1.0). */
  readonly confidence: number;
  /** Human-readable evidence supporting this signal. */
  readonly evidence: string;
}

/**
 * The resolved implementation language for the Phase 3 pipeline.
 * Aggregates all language signals into a final decision.
 */
export interface LanguageResolution {
  /** The chosen implementation language. */
  readonly language: ImplementationLanguage;
  /** Whether the project uses both languages. Always false for Phase 3. */
  readonly mixed_mode: false;
  /** Human-readable explanation of the language choice. */
  readonly rationale: string;
  /** All signals that contributed to the resolution. */
  readonly signals: LanguageSignal[];
  /** Aggregate score for TypeScript across all signals. */
  readonly typescript_score: number;
  /** Aggregate score for Rust across all signals. */
  readonly rust_score: number;
}

// ============================================================================
// Scaffold Types
// ============================================================================

/**
 * A single file to be written during scaffold generation.
 */
export interface ScaffoldFile {
  /** Path relative to the scaffold root directory. */
  readonly relativePath: string;
  /** The full text content of the file. */
  readonly content: string;
  /** Whether the file should be marked executable (e.g. scripts). */
  readonly executable?: boolean;
}

/**
 * Metadata describing the generated project scaffold, including
 * module layout, shared kernel modules, and all scaffold files.
 */
export interface ScaffoldMetadata {
  /** The resolved implementation language for the scaffold. */
  readonly language: ImplementationLanguage;
  /** Root directory name for the scaffold (always 'project'). */
  readonly rootDir: string;
  /** Modules derived from DDD bounded contexts. */
  readonly modules: ReadonlyArray<{
    name: string;
    path: string;
    boundedContext: string;
  }>;
  /** Module names designated as shared kernel. */
  readonly sharedKernelModules: string[];
  /** All files generated as part of the scaffold. */
  readonly files: ScaffoldFile[];
}

// ============================================================================
// Codegen Types
// ============================================================================

/**
 * A single generated source file from the domain codegen stage.
 */
export interface CodegenFile {
  /** Path relative to the project root. */
  readonly relativePath: string;
  /** The full text content of the generated file. */
  readonly content: string;
  /** The DDD bounded context this file belongs to. */
  readonly boundedContext: string;
  /** The kind of DDD artifact this file implements. */
  readonly kind: 'aggregate' | 'entity' | 'value-object' | 'event' | 'command' | 'query' | 'seam' | 'mod' | 'barrel';
}

/**
 * Output of the domain codegen stage, containing all generated files
 * and summary counts by DDD artifact kind.
 */
export interface CodegenOutput {
  /** All generated source files. */
  readonly files: CodegenFile[];
  /** Total number of aggregate files generated. */
  readonly totalAggregates: number;
  /** Total number of entity files generated. */
  readonly totalEntities: number;
  /** Total number of value object files generated. */
  readonly totalValueObjects: number;
  /** Total number of event files generated. */
  readonly totalEvents: number;
  /** Total number of command files generated. */
  readonly totalCommands: number;
  /** Total number of query files generated. */
  readonly totalQueries: number;
  /** Total number of seam files generated. */
  readonly totalSeams: number;
}

// ============================================================================
// Test Generation Types
// ============================================================================

/**
 * A single generated test file from the test generation stage.
 */
export interface TestFile {
  /** Path relative to the project root. */
  readonly relativePath: string;
  /** The full text content of the test file. */
  readonly content: string;
  /** The DDD bounded context this test file covers. */
  readonly boundedContext: string;
  /** The testing pyramid layer this file targets. */
  readonly layer: 'unit' | 'integration' | 'acceptance' | 'e2e';
  /** Number of individual test cases in this file. */
  readonly testCount: number;
}

/**
 * Output of the test generation stage, containing all generated test files
 * and distribution metrics across the testing pyramid.
 */
export interface TestGenOutput {
  /** All generated test files. */
  readonly files: TestFile[];
  /** Total number of test cases across all files. */
  readonly totalTests: number;
  /** Distribution of test counts across pyramid layers. */
  readonly pyramidDistribution: {
    readonly unit: number;
    readonly integration: number;
    readonly acceptance: number;
    readonly e2e: number;
  };
}

// ============================================================================
// Ruflo Types
// ============================================================================

/**
 * Result of executing the Ruflo formatter/linter on the generated codebase.
 */
export interface RufloResult {
  /** Process exit code (0 = success). */
  readonly exitCode: number;
  /** Standard output from the Ruflo process. */
  readonly stdout: string;
  /** Standard error from the Ruflo process. */
  readonly stderr: string;
  /** Ruflo version string used for this run. */
  readonly version: string;
  /** Number of files modified by Ruflo. */
  readonly filesModified: number;
  /** Wall-clock time in milliseconds for the Ruflo run. */
  readonly timingMs: number;
}

// ============================================================================
// Pipeline Context Types
// ============================================================================

/** The stages that the Phase 3 pipeline executes in order. */
export type Phase3Stage =
  | 'phase2-validation'
  | 'language-resolution'
  | 'scaffold-generation'
  | 'domain-codegen'
  | 'test-generation'
  | 'ruflo-execution'
  | 'manifest-writing';

/** Output produced by a single Phase 3 pipeline stage. */
export interface Phase3StageOutput {
  /** The stage that produced this output. */
  readonly stage: Phase3Stage;
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
 * Mutable pipeline context threaded through all Phase 3 stages.
 * Accumulates stage outputs and telemetry as the pipeline progresses.
 */
export interface Phase3Context {
  /** Unique trace identifier for this pipeline run. */
  readonly traceId: string;
  /** Absolute path to the Phase 2 output directory. */
  readonly phase2Dir: string;
  /** Absolute path to the Phase 3 output directory. */
  readonly phase3Dir: string;
  /** The original scenario query driving this pipeline run. */
  readonly scenarioQuery: string;
  /** Phase 2 artifacts loaded from disk. */
  readonly phase2Artifacts: Phase2Artifacts;
  /** Accumulated stage outputs keyed by stage name. */
  readonly stageOutputs: Map<Phase3Stage, Phase3StageOutput>;
  /** Telemetry spans collected during pipeline execution. */
  readonly telemetrySpans: TelemetrySpan[];
}

// ============================================================================
// Manifest Types
// ============================================================================

/** A hashed artifact reference in the Phase 3 manifest. */
export interface Phase3ManifestArtifact {
  /** Relative path to the artifact file. */
  readonly path: string;
  /** SHA-256 hash of the artifact contents. */
  readonly sha256: string;
  /** Size of the artifact file in bytes. */
  readonly size_bytes: number;
}

/**
 * The Phase 3 manifest written to disk at the end of a successful run.
 * Provides a complete record of the implementation language, Ruflo version,
 * all artifacts, and total timing.
 */
export interface Phase3Manifest {
  /** Schema version for this manifest format. */
  readonly schema_version: '3.0.0';
  /** Unique trace identifier for this pipeline run. */
  readonly trace_id: string;
  /** The resolved implementation language. */
  readonly implementation_language: ImplementationLanguage;
  /** Whether the project uses both languages. Always false for Phase 3. */
  readonly mixed_mode: false;
  /** Version string of the Ruflo binary used. */
  readonly ruflo_version: string;
  /** All artifacts produced by the pipeline. */
  readonly artifacts: Phase3ManifestArtifact[];
  /** Total wall-clock time in milliseconds for the entire pipeline. */
  readonly total_timing_ms: number;
  /** Whether the pipeline completed successfully. */
  readonly success: boolean;
}

// ============================================================================
// Pipeline Result Types
// ============================================================================

/**
 * The final result returned by the Phase 3 pipeline after all stages
 * have completed (or the first stage has failed).
 */
export interface Phase3PipelineResult {
  /** Unique trace identifier for this pipeline run. */
  readonly traceId: string;
  /** Absolute path to the Phase 3 output directory. */
  readonly phase3Dir: string;
  /** The manifest written at the end of the pipeline. */
  readonly manifest: Phase3Manifest;
  /** Ordered list of stage outputs from the pipeline run. */
  readonly stageResults: Phase3StageOutput[];
  /** Total wall-clock time in milliseconds for the entire pipeline. */
  readonly totalTiming: number;
}
