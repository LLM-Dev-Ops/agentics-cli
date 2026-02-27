/**
 * Phase 5 Pipeline Type Definitions (Build)
 *
 * Phase 5 generates the complete implementation by chaining:
 *   - Domain-core code generation (from existing phase3 pipeline)
 *   - Deployable Cloud Run service (from existing phase4 pipeline)
 */

import type { TelemetrySpan } from '../phase2/types.js';

export type Phase5BuildStage =
  | 'prior-phase-loading'
  | 'domain-codegen'
  | 'integration-inference'
  | 'integration-injection'
  | 'deployable-service';

// ============================================================================
// Integration Inference Types
// ============================================================================

export type IntegrationCategory =
  | 'llm'
  | 'cloud'
  | 'identity'
  | 'communication'
  | 'productivity'
  | 'devops'
  | 'database'
  | 'vector-db'
  | 'monitoring'
  | 'billing'
  | 'media'
  | 'automation';

export interface IntegrationModule {
  readonly id: string;
  readonly category: IntegrationCategory;
  readonly repoPath: string;
  readonly keywords: readonly string[];
  readonly erpSignals: readonly string[];
  readonly domainSignals: readonly string[];
  readonly alwaysInclude: boolean;
  readonly weight: number;
  readonly hasRustVariant: boolean;
}

export interface InferredIntegration {
  readonly id: string;
  readonly category: IntegrationCategory;
  readonly score: number;
  readonly rationale: string;
  readonly repoPath: string;
  readonly hasRustVariant: boolean;
}

export interface IntegrationInferenceResult {
  readonly selectedModules: InferredIntegration[];
  readonly totalScanned: number;
  readonly corpusSize: number;
}

export interface IntegrationInjectionResult {
  readonly copiedModules: string[];
  readonly barrelExportPath: string;
  readonly manifestPath: string;
  readonly mergedDependencies: number;
}

export interface Phase5BuildContext {
  readonly traceId: string;
  readonly phase2Dir: string;
  readonly phase3Dir: string;
  readonly phase4Dir: string;
  readonly phase5Dir: string;
  readonly scenarioQuery: string;
  readonly platformRepoPaths: Record<string, string>;
  readonly telemetrySpans: TelemetrySpan[];
}

export interface Phase5BuildManifestArtifact {
  readonly path: string;
  readonly sha256: string;
  readonly size_bytes: number;
}

export interface Phase5BuildManifest {
  readonly schema_version: '5.0.0';
  readonly trace_id: string;
  readonly generated_at: string;
  readonly pipeline_version: string;
  readonly implementation_language: string;
  readonly erp_system: string;
  readonly stages: ReadonlyArray<{
    stage: Phase5BuildStage;
    status: string;
    timing_ms: number;
    artifact_count: number;
  }>;
  readonly artifacts: Phase5BuildManifestArtifact[];
  readonly total_timing_ms: number;
  readonly success: boolean;
}

export interface Phase5BuildPipelineResult {
  readonly traceId: string;
  readonly phase5Dir: string;
  readonly manifest: Phase5BuildManifest;
  readonly stageResults: ReadonlyArray<{
    stage: Phase5BuildStage;
    status: 'completed' | 'failed';
    timing: number;
    artifacts: string[];
    summary: string;
  }>;
  readonly totalTiming: number;
}
