/**
 * Phase 5 Pipeline — Public API
 *
 * Pushes Phase 4 deployable services onto an ERP surface with full
 * registration, materialization, and governance:
 *   - Phase 4 Artifact Validation
 *   - ERP Service Registration
 *   - Project Materialization
 *   - Deployment Finalization
 *   - Manifest Writing
 *
 * Usage:
 *   import { executePhase5Pipeline } from './pipeline/phase5/index.js';
 *   const result = await executePhase5Pipeline(context);
 */

export { executePhase5Pipeline } from './phase5-coordinator.js';

export type {
  Phase5Context,
  Phase5Stage,
  Phase5StageOutput,
  Phase5PipelineResult,
  Phase5Manifest,
  Phase5ManifestArtifact,
  Phase4Artifacts,
  Phase4ManifestRef,
  ERPSurfaceRegistration,
  ERPEndpointMapping,
} from './types.js';
