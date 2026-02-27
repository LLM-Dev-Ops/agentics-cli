/**
 * Phase 5 Pipeline — Public API (Build)
 *
 * Chains domain-core code generation and deployable service generation
 * from Phase 4 ADRs + DDDs and Phase 3 SPARC + TDD output.
 */

export { executePhase5BuildPipeline } from './phase5-build-coordinator.js';

export type {
  Phase5BuildContext,
  Phase5BuildPipelineResult,
  Phase5BuildManifest,
} from './types.js';
