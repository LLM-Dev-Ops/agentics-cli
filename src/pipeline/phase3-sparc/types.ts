/**
 * Phase 3 Pipeline Type Definitions (SPARC + London School TDD)
 *
 * Phase 3 generates SPARC specifications and London School TDD test plans
 * from the Phase 2 research dossier.
 */

import type { TelemetrySpan, Phase2StageOutput } from '../phase2/types.js';

export type Phase3SPARCStage =
  | 'phase2-loading'
  | 'sparc-specification'
  | 'tdd-plan-generation';

export interface Phase3SPARCContext {
  readonly traceId: string;
  readonly phase2Dir: string;
  readonly phase3Dir: string;
  readonly scenarioQuery: string;
  readonly stageOutputs: Map<string, Phase2StageOutput>;
  readonly telemetrySpans: TelemetrySpan[];
}

export interface Phase3SPARCManifestArtifact {
  readonly path: string;
  readonly sha256: string;
  readonly size_bytes: number;
}

export interface Phase3SPARCManifest {
  readonly schema_version: '3.0.0';
  readonly trace_id: string;
  readonly generated_at: string;
  readonly pipeline_version: string;
  readonly stages: ReadonlyArray<{
    stage: Phase3SPARCStage;
    status: string;
    timing_ms: number;
    artifact_count: number;
  }>;
  readonly artifacts: Phase3SPARCManifestArtifact[];
  readonly total_timing_ms: number;
  readonly success: boolean;
}

export interface Phase3SPARCPipelineResult {
  readonly traceId: string;
  readonly phase3Dir: string;
  readonly manifest: Phase3SPARCManifest;
  readonly stageResults: Phase2StageOutput[];
  readonly totalTiming: number;
}
