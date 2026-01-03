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
   */
  extractReference(body: unknown): BaseReference | null {
    if (!body || typeof body !== 'object') {
      return null;
    }

    const obj = body as Record<string, unknown>;

    // Check for required reference fields
    if (!('id' in obj) || !('type' in obj) || !('repository' in obj)) {
      return null;
    }

    // Return as BaseReference - no type validation
    return {
      id: String(obj['id']),
      type: obj['type'] as ReferenceType,
      repository: String(obj['repository']),
      created_at: 'created_at' in obj ? String(obj['created_at']) : new Date().toISOString(),
      checksum: 'checksum' in obj ? String(obj['checksum']) : '',
    };
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
