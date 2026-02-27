/**
 * Phase 4 Pipeline — Public API (ADRs + DDDs)
 *
 * Generates Architecture Decision Records and Domain-Driven Design models
 * from Phase 2 research dossier and Phase 3 SPARC + TDD output.
 *
 * Usage:
 *   import { executePhase4ADRPipeline } from './pipeline/phase4-adrs/index.js';
 *   const result = await executePhase4ADRPipeline(context);
 */

export { executePhase4ADRPipeline } from './phase4-adrs-coordinator.js';

export type {
  Phase4ADRContext,
  Phase4ADRPipelineResult,
  Phase4ADRStage,
  Phase4ADRManifest,
} from './types.js';
