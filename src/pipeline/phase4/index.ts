/**
 * Phase 4 Pipeline — Public API
 *
 * Transforms Phase 3 domain-core implementations into deployable Cloud Run
 * services with ERP integration:
 *   - Phase 3 Artifact Validation
 *   - ERP Target Resolution (SAP, Oracle, Dynamics, etc.)
 *   - SQL Schema Generation
 *   - Infrastructure Adapter Generation
 *   - HTTP Server Generation (Hono / Axum)
 *   - ERP Client Generation
 *   - Deployment Descriptor Generation (Cloud Run / Dockerfile)
 *   - Phase 2 Metadata Augmentation
 *
 * Usage:
 *   import { executePhase4Pipeline } from './pipeline/phase4/index.js';
 *   const result = await executePhase4Pipeline(context);
 */

export { executePhase4Pipeline } from './phase4-coordinator.js';

export type {
  Phase2SPARCOutput,
  Phase2ADRRecord,
  Phase2DomainModel,
  TDDPlan,
  TelemetrySpan,
  Phase2Manifest,
  Phase3Manifest,
  ImplementationLanguage,
  Phase2Artifacts,
  ERPSystem,
  DatabaseEngine,
  SQLDialect,
  Phase3Artifacts,
  ERPResolution,
  GeneratedFile,
  SchemaFile,
  AdapterFile,
  ServerFile,
  ClientFile,
  DeploymentFile,
  SchemaGenOutput,
  InfraAdapterOutput,
  HttpServerOutput,
  ERPClientOutput,
  DeploymentOutput,
  RuntimeDecision,
  MetadataAugmentOutput,
  Phase4Stage,
  Phase4StageOutput,
  Phase4Context,
  Phase4ManifestArtifact,
  Phase4Manifest,
  Phase4PipelineResult,
} from './types.js';
