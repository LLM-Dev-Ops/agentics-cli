/**
 * Phase 3 Pipeline -- Public API (SPARC + London School TDD)
 *
 * Generates SPARC specification and London School TDD test plans
 * from Phase 2 deep research dossier.
 */

export { executePhase3SPARCPipeline } from './phase3-sparc-coordinator.js';

export type {
  Phase3SPARCContext,
  Phase3SPARCPipelineResult,
  Phase3SPARCStage,
  Phase3SPARCManifest,
} from './types.js';
