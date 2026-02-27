/**
 * Phase2 Pipeline — Public API (Deep Research)
 *
 * Extracts structured knowledge from Phase 1 simulation artifacts:
 *   - Phase 1 Artifact Loading + Validation
 *   - Research Dossier (structured extraction with cross-references)
 *
 * SPARC, TDD, ADRs, and DDDs are generated in subsequent phases (3, 4).
 *
 * Usage:
 *   import { executePhase2Pipeline } from './pipeline/phase2/index.js';
 *   const result = await executePhase2Pipeline(context);
 */

export { executePhase2Pipeline } from './phase2-coordinator.js';

export type {
  Phase2Context,
  Phase2PipelineResult,
  Phase2Stage,
  Phase2StageOutput,
  Phase2Manifest,
  Phase1Artifacts,
  ResearchDossier,
  Phase2SPARCOutput,
  Phase2ADRRecord,
  Phase2DomainModel,
  TDDPlan,
  TelemetrySpan,
} from './types.js';
