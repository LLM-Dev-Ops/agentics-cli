/**
 * Phase 4 Pipeline Schemas
 *
 * Zod validation schemas for reading Phase 3 artifacts from disk and
 * validating Phase 4 output structures.
 *
 * All "OnDisk" schemas use `.passthrough()` liberally so that Phase 3
 * format evolution does not break Phase 4 ingestion. Phase 4 only
 * validates the fields it actually reads; extra fields are preserved
 * but ignored.
 */

import { z } from 'zod';

// ============================================================================
// Phase 2 Schema Re-exports (from phase3/schemas.ts)
// ============================================================================

export {
  SPARCOnDiskSchema,
  ADRIndexOnDiskSchema,
  DomainModelOnDiskSchema,
  TDDPlanOnDiskSchema,
} from '../phase3/schemas.js';

// ============================================================================
// Phase 3 Manifest (on-disk format from phase3-manifest.json)
// ============================================================================

/**
 * Schema for the phase3-manifest.json file written by Phase 3.
 *
 * Uses passthrough to tolerate extra fields and allow forward
 * compatibility with future Phase 3 manifest additions such as
 * additional metadata or new optional fields.
 */
export const Phase3ManifestOnDiskSchema = z.object({
  schema_version: z.string(),
  trace_id: z.string(),
  implementation_language: z.enum(['rust', 'typescript']),
  mixed_mode: z.boolean(),
  ruflo_version: z.string(),
  artifacts: z.array(z.object({
    path: z.string(),
    sha256: z.string(),
    size_bytes: z.number(),
  }).passthrough()),
  total_timing_ms: z.number(),
  success: z.boolean(),
}).passthrough();

// ============================================================================
// Phase 4 Manifest (output format for phase4-manifest.json)
// ============================================================================

/**
 * Schema for the Phase 4 manifest written at the end of a successful run.
 * This is a loose schema (with passthrough) to allow forward compatibility
 * as Phase 4 output format evolves.
 */
export const Phase4ManifestSchema = z.object({
  schema_version: z.literal('4.0.0'),
  trace_id: z.string(),
  implementation_language: z.enum(['rust', 'typescript']),
  erp_system: z.string(),
  database_engine: z.string().nullable(),
  api_only: z.boolean(),
  artifacts: z.array(z.object({
    path: z.string(),
    sha256: z.string(),
    size_bytes: z.number(),
  }).passthrough()),
  total_timing_ms: z.number(),
  success: z.boolean(),
}).passthrough();

// ============================================================================
// Inferred Types
// ============================================================================

export type ValidatedPhase3ManifestOnDisk = z.infer<typeof Phase3ManifestOnDiskSchema>;
export type ValidatedPhase4Manifest = z.infer<typeof Phase4ManifestSchema>;
