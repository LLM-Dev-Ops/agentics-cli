/**
 * Lineage Tracking Module (ADR-004, Domain 2)
 *
 * PURPOSE: Track parent-child relationships between simulation artifacts.
 * Ruvector stores lineage as first-class data, not inferred from timestamps.
 *
 * INVARIANTS ENFORCED:
 * - Invariant 1: Every simulation has a memory footprint
 * - Invariant 2: Every integration/ERP mapping derives from a simulation
 * - Invariant 3: No integration proposal without traceability
 * - Invariant 7: CLI is only path for artifact creation
 *
 * FORBIDDEN:
 * - Creating lineage without a simulation parent
 * - Querying live enterprise systems
 * - Storing credentials or tokens
 * - Business logic (lineage is structural, not behavioral)
 */

import * as crypto from 'node:crypto';
import type {
  LineageRecord,
  SimulationMemoryRecord,
  IntegrationProposal,
  ErpSurfaceMapping,
  ArtifactCategory,
  Attribution,
} from '../types/index.js';

// ============================================================================
// Lineage Record Construction
// ============================================================================

/**
 * Create a lineage record for an artifact.
 * Every artifact persisted in Ruvector must have a corresponding lineage record.
 *
 * @param artifactId - The artifact this lineage entry describes
 * @param category - The type of artifact
 * @param simulationId - The parent simulation (Invariant 2)
 * @param decisionContext - The natural language input that seeded synthesis
 * @param attribution - Identity attribution (user_id, org_id)
 * @param planId - The plan this artifact belongs to (optional)
 */
export function createLineageRecord(
  artifactId: string,
  category: ArtifactCategory,
  simulationId: string,
  decisionContext: string,
  attribution: Attribution,
  planId?: string,
): LineageRecord {
  return {
    id: `lin-${crypto.randomUUID()}`,
    artifact_id: artifactId,
    artifact_category: category,
    simulation_id: simulationId,
    plan_id: planId,
    decision_context: decisionContext,
    attribution,
    governance: {
      gate_pipeline_version: '1.0.0',
      synthesis_classification: classifySynthesis(category),
    },
    created_at: new Date().toISOString(),
  };
}

/**
 * Determine the synthesis classification for an artifact category.
 * Mirrors ADR-001 classifications.
 */
function classifySynthesis(category: ArtifactCategory): string {
  switch (category) {
    case 'simulation':
    case 'plan':
    case 'integration_mapping':
    case 'erp_proposal':
    case 'cost_projection':
    case 'risk_assessment':
      return 'SYNTHESIS_REQUIRED';
    case 'deployment':
    case 'decision':
      return 'COMMITMENT_GRADE';
    default:
      return 'SYNTHESIS_REQUIRED';
  }
}

// ============================================================================
// Simulation Memory Record Construction
// ============================================================================

/**
 * Create a simulation memory record for Ruvector persistence (Invariant 1).
 * Called when a simulation is initiated through the CLI.
 */
export function createSimulationMemoryRecord(
  id: string,
  intent: string,
  attribution: Attribution,
): SimulationMemoryRecord {
  const now = new Date().toISOString();
  // Ruvector-service enforces a 2000-character max on intent and intent_description.
  // Truncate with ellipsis so the full query still reaches the simulation engine
  // (via the scenario description) but the memory record fits the contract.
  const MAX_INTENT_LENGTH = 2000;
  const truncatedIntent = intent.length > MAX_INTENT_LENGTH
    ? intent.slice(0, MAX_INTENT_LENGTH - 3) + '...'
    : intent;
  return {
    id,
    type: 'simulation',
    intent: truncatedIntent,
    intent_description: truncatedIntent,
    status: 'created',
    attribution,
    artifact_ids: [],
    created_at: now,
    updated_at: now,
    checksum: computeChecksum({ id, intent: truncatedIntent, created_at: now }),
  };
}

/**
 * Update a simulation memory record with completion data.
 */
export function completeSimulationMemoryRecord(
  record: SimulationMemoryRecord,
  result: unknown,
  artifactIds: string[],
): SimulationMemoryRecord {
  const now = new Date().toISOString();
  return {
    ...record,
    status: 'completed',
    result,
    artifact_ids: [...record.artifact_ids, ...artifactIds],
    updated_at: now,
    checksum: computeChecksum({ ...record, result, updated_at: now }),
  };
}

/**
 * Mark a simulation memory record as failed.
 */
export function failSimulationMemoryRecord(
  record: SimulationMemoryRecord,
  error: string,
): SimulationMemoryRecord {
  const now = new Date().toISOString();
  return {
    ...record,
    status: 'failed',
    result: { error },
    updated_at: now,
    checksum: computeChecksum({ ...record, error, updated_at: now }),
  };
}

// ============================================================================
// Integration Proposal Construction
// ============================================================================

/**
 * Create an integration proposal derived from a simulation (Invariant 2).
 * Proposals describe what would change, not what has changed.
 */
export function createIntegrationProposal(
  integrationName: string,
  proposedChanges: string,
  risks: string[],
  dependencies: string[],
  simulationId: string,
  attribution: Attribution,
  planId?: string,
): IntegrationProposal {
  return {
    id: `intprop-${crypto.randomUUID()}`,
    type: 'integration_proposal',
    integration_name: integrationName,
    proposed_changes: proposedChanges,
    risks,
    dependencies,
    simulation_id: simulationId,
    plan_id: planId,
    attribution,
    created_at: new Date().toISOString(),
  };
}

// ============================================================================
// ERP Surface Mapping Construction
// ============================================================================

/**
 * Create an ERP Surface mapping derived from a simulation (Invariant 6).
 * ERP Surface never initiates — it receives proposed implementations.
 */
export function createErpSurfaceMapping(
  erpType: string,
  entityType: string,
  proposedImplementation: unknown,
  simulationId: string,
  integrationProposalIds: string[],
  attribution: Attribution,
): ErpSurfaceMapping {
  return {
    id: `erpmap-${crypto.randomUUID()}`,
    type: 'erp_mapping',
    erp_type: erpType,
    entity_type: entityType,
    proposed_implementation: proposedImplementation,
    simulation_id: simulationId,
    integration_proposal_ids: integrationProposalIds,
    attribution,
    created_at: new Date().toISOString(),
  };
}

// ============================================================================
// Traceability Validation
// ============================================================================

/**
 * Validate that an artifact has a valid simulation parent.
 * Returns a validation result with specific error messaging.
 *
 * ADR-004, Invariant 3: No integration proposal exists without traceability.
 */
export function validateTraceability(
  simulationId: string | undefined,
  artifactType: string,
): { valid: boolean; message: string } {
  if (!simulationId) {
    return {
      valid: false,
      message: `${artifactType} requires a simulation_id. ` +
        `All enterprise artifacts must trace to a governed simulation ` +
        `(ADR-004, Invariant 2).`,
    };
  }

  if (typeof simulationId !== 'string' || simulationId.trim() === '') {
    return {
      valid: false,
      message: `${artifactType} simulation_id must be a non-empty string. ` +
        `Received: ${String(simulationId)}`,
    };
  }

  return { valid: true, message: '' };
}

/**
 * Validate that a lineage chain is complete.
 * Checks that simulation → plan → artifact chain is traceable.
 */
export function validateLineageChain(records: LineageRecord[]): {
  complete: boolean;
  missing: string[];
} {
  const missing: string[] = [];

  for (const record of records) {
    if (!record.simulation_id) {
      missing.push(`Lineage ${record.id}: missing simulation_id`);
    }
    if (!record.attribution.created_by) {
      missing.push(`Lineage ${record.id}: missing attribution.created_by`);
    }
    if (!record.attribution.org_id) {
      missing.push(`Lineage ${record.id}: missing attribution.org_id`);
    }
    if (!record.decision_context) {
      missing.push(`Lineage ${record.id}: missing decision_context`);
    }
  }

  return {
    complete: missing.length === 0,
    missing,
  };
}

// ============================================================================
// Internal Helpers
// ============================================================================

function computeChecksum(data: unknown): string {
  const canonical = JSON.stringify(data);
  return crypto.createHash('sha256').update(canonical).digest('hex');
}
