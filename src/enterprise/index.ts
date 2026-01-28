/**
 * Enterprise Integration & Memory Architecture Exports (ADR-004)
 *
 * This module implements the enterprise integration domain model
 * described in ADR-004. All exports serve the five bounded contexts:
 *
 * 1. Enterprise Simulation Domain - simulation memory records
 * 2. Memory & Lineage Domain - lineage tracking, traceability
 * 3. Integration Domain - integration registry, proposals
 * 4. ERP Surface Domain - ERP mappings
 * 5. CLI as Orchestrator - validation helpers
 */

// Lineage tracking (ADR-004, Domain 2)
export {
  createLineageRecord,
  createSimulationMemoryRecord,
  completeSimulationMemoryRecord,
  failSimulationMemoryRecord,
  createIntegrationProposal,
  createErpSurfaceMapping,
  validateTraceability,
  validateLineageChain,
} from './lineage.js';

// Integration registry (ADR-004, Domain 3)
export {
  INTEGRATION_REGISTRY,
  lookupIntegration,
  getIntegrationsByCategory,
  getIntegrationNames,
  isKnownIntegration,
  getAffectedEntities,
} from './integration-registry.js';

export type {
  IntegrationDefinition,
  IntegrationCategory,
} from './integration-registry.js';
