/**
 * Phase 4 Pipeline Type Definitions (ADRs + DDDs)
 *
 * Phase 4 generates Architecture Decision Records and Domain-Driven Design
 * models from the Phase 2 research dossier and Phase 3 SPARC + TDD output.
 */

import type { TelemetrySpan, Phase2StageOutput } from '../phase2/types.js';

export type Phase4ADRStage =
  | 'prior-phase-loading'
  | 'adr-generation'
  | 'ddd-generation';

export interface Phase4ADRContext {
  readonly traceId: string;
  readonly phase2Dir: string;
  readonly phase3Dir: string;
  readonly phase4Dir: string;
  readonly scenarioQuery: string;
  readonly stageOutputs: Map<string, Phase2StageOutput>;
  readonly telemetrySpans: TelemetrySpan[];
}

export interface Phase4ADRManifestArtifact {
  readonly path: string;
  readonly sha256: string;
  readonly size_bytes: number;
}

export interface Phase4ADRManifest {
  readonly schema_version: '4.0.0';
  readonly trace_id: string;
  readonly generated_at: string;
  readonly pipeline_version: string;
  readonly stages: ReadonlyArray<{
    stage: Phase4ADRStage;
    status: string;
    timing_ms: number;
    artifact_count: number;
  }>;
  readonly artifacts: Phase4ADRManifestArtifact[];
  readonly total_timing_ms: number;
  readonly success: boolean;
}

export interface Phase4ADRPipelineResult {
  readonly traceId: string;
  readonly phase4Dir: string;
  readonly manifest: Phase4ADRManifest;
  readonly stageResults: Phase2StageOutput[];
  readonly totalTiming: number;
}
