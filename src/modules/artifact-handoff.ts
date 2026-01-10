/**
 * Artifact Handoff Module (Module D)
 *
 * SPARC Architecture Reference: §2.5
 *
 * PURPOSE: Pass artifacts between services without mutation
 *
 * DEPENDENCIES: None (pure data passthrough)
 *
 * FORBIDDEN:
 * - Artifact Validation (NO schema checking)
 * - Artifact Transformation (NO field mapping)
 * - Artifact Storage (NO caching or persistence)
 * - Content Interpretation (NO parsing of artifact data)
 */

import type {
  BaseReference,
  PlanReference,
  SimulationReference,
  IntentReference,
  ExportReference,
  DiligencePackageReference,
  ReferenceType,
} from '../types/index.js';

// ============================================================================
// Interface Definition
// ============================================================================

export interface IArtifactHandoff {
  /**
   * Pass artifact from upstream response to downstream request
   * PASSTHROUGH ONLY - no validation or transformation
   */
  passthrough<T extends BaseReference>(artifact: T): T;

  /**
   * Extract reference from raw response body
   * PASSTHROUGH ONLY - no validation
   */
  extractReference(body: unknown): BaseReference | null;

  /**
   * Build downstream request payload from reference
   * PASSTHROUGH ONLY - no transformation
   */
  buildPayload(ref: BaseReference, additionalParams?: Record<string, unknown>): unknown;
}

// ============================================================================
// Artifact Handoff Implementation
// ============================================================================

export class ArtifactHandoff implements IArtifactHandoff {
  /**
   * Pass artifact through unchanged
   * SPARC: Artifacts are never modified by CLI
   */
  passthrough<T extends BaseReference>(artifact: T): T {
    // Return artifact unchanged - pure passthrough
    return artifact;
  }

  /**
   * Extract reference from response body
   * SPARC: No validation, just structural extraction
   *
   * Handles multiple response formats:
   * 1. Standard reference: { id, type, repository, ... }
   * 2. Planner response: { success, plan: { metadata: { planId, ... } }, ... }
   * 3. Manifests response: { id, type, repository, execution_metadata, ... }
   */
  extractReference(body: unknown): BaseReference | null {
    if (!body || typeof body !== 'object') {
      return null;
    }

    const obj = body as Record<string, unknown>;

    // Format 1: Standard reference format (has id, type, repository at root)
    if ('id' in obj && 'type' in obj && 'repository' in obj) {
      return {
        id: String(obj['id']),
        type: obj['type'] as ReferenceType,
        repository: String(obj['repository']),
        created_at: 'created_at' in obj ? String(obj['created_at']) : new Date().toISOString(),
        checksum: 'checksum' in obj ? String(obj['checksum']) : '',
      };
    }

    // Format 2: Planner service response { success, plan: { metadata: { planId } }, execution_metadata }
    if ('plan' in obj && typeof obj['plan'] === 'object' && obj['plan'] !== null) {
      const plan = obj['plan'] as Record<string, unknown>;
      if ('metadata' in plan && typeof plan['metadata'] === 'object' && plan['metadata'] !== null) {
        const metadata = plan['metadata'] as Record<string, unknown>;
        const planId = metadata['planId'] as string | undefined;
        const createdAt = metadata['createdAt'] as string | undefined;
        const contentHash = metadata['contentHash'] as string | undefined;

        if (planId) {
          return {
            id: planId,
            type: 'PlanReference' as ReferenceType,
            repository: 'agentics-simulation-planner',
            created_at: createdAt ?? new Date().toISOString(),
            checksum: contentHash ? `sha256:${contentHash}` : '',
          };
        }
      }
    }

    // Format 3: Simulation engine response { success, result: { simulationId } }
    if ('result' in obj && typeof obj['result'] === 'object' && obj['result'] !== null) {
      const result = obj['result'] as Record<string, unknown>;
      if ('simulationId' in result) {
        return {
          id: String(result['simulationId']),
          type: 'SimulationReference' as ReferenceType,
          repository: 'agentics-simulation-engine',
          created_at: new Date().toISOString(),
          checksum: '',
        };
      }
    }

    return null;
  }

  /**
   * Build payload for downstream service
   * SPARC: Reference passed verbatim, additional params merged
   */
  buildPayload(ref: BaseReference, additionalParams?: Record<string, unknown>): unknown {
    return {
      ref,
      ...additionalParams,
    };
  }
}

// ============================================================================
// Reference Type Guards (for type narrowing only, no validation)
// ============================================================================

export function isPlanReference(ref: BaseReference): ref is PlanReference {
  return ref.type === 'PlanReference';
}

export function isSimulationReference(ref: BaseReference): ref is SimulationReference {
  return ref.type === 'SimulationReference';
}

export function isIntentReference(ref: BaseReference): ref is IntentReference {
  return ref.type === 'IntentReference';
}

export function isExportReference(ref: BaseReference): ref is ExportReference {
  return ref.type === 'ExportReference';
}

export function isDiligencePackageReference(ref: BaseReference): ref is DiligencePackageReference {
  return ref.type === 'DiligencePackageReference';
}

// ============================================================================
// Factory Function
// ============================================================================

export function createArtifactHandoff(): IArtifactHandoff {
  return new ArtifactHandoff();
}
