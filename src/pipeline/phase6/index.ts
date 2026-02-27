/**
 * Phase 6 Pipeline — Public API (ERP Surface Push)
 *
 * Pushes Phase 5 Build deployable services onto an ERP surface with full
 * registration, materialization, and governance:
 *   - Phase 5 Artifact Validation
 *   - ERP Service Registration
 *   - Project Materialization
 *   - Deployment Finalization
 *   - Manifest Writing
 */

export { executePhase6Pipeline } from './phase6-coordinator.js';

export type {
  Phase6Context,
  Phase6Stage,
  Phase6StageOutput,
  Phase6PipelineResult,
  Phase6Manifest,
  Phase6ManifestArtifact,
  Phase5Artifacts,
  Phase5ManifestRef,
  ERPSurfaceRegistration,
  ERPEndpointMapping,
} from './types.js';
