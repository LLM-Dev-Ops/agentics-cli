/**
 * Phase2 Pipeline — Public API
 *
 * Transforms phase1 simulation artifacts into an engineering package:
 *   - Research Dossier (structured extraction)
 *   - SPARC Specification (with dossier cross-references)
 *   - Architecture Decision Records (citing SPARC + dossier)
 *   - Domain-Driven Design Model (bounded contexts, ubiquitous language)
 *   - London School TDD Plan (outside-in, mockist)
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
