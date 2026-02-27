/**
 * Phase 3 Pipeline Schemas
 *
 * Zod validation schemas for reading Phase 2 artifacts from disk and
 * validating Phase 3 output structures.
 *
 * All "OnDisk" schemas use `.passthrough()` liberally so that Phase 2
 * format evolution does not break Phase 3 ingestion. Phase 3 only
 * validates the fields it actually reads; extra fields are preserved
 * but ignored.
 */

import { z } from 'zod';

// ============================================================================
// Phase 2 Manifest (on-disk format from phase2-manifest.json)
// ============================================================================

/**
 * Schema for the phase2-manifest.json file written by Phase 2.
 *
 * Uses passthrough to tolerate extra fields such as `stages`,
 * `deterministic`, `pipeline_version`, `generated_at`, and any
 * future additions.
 */
export const Phase2ManifestOnDiskSchema = z.object({
  schema_version: z.string(),
  trace_id: z.string(),
  artifacts: z.array(z.object({
    path: z.string(),
    sha256: z.string(),
    size_bytes: z.number(),
  }).passthrough()),
  total_timing_ms: z.number(),
}).passthrough();

// ============================================================================
// SPARC Combined (on-disk format from sparc/sparc-combined.json)
// ============================================================================

/**
 * Schema for the sparc-combined.json file written by Phase 2.
 *
 * The on-disk format may include additional fields beyond what Phase 3
 * consumes (e.g. `scope`, extra requirement metadata). Passthrough is
 * applied at every object level for maximum forward-compatibility.
 */
export const SPARCOnDiskSchema = z.object({
  specification: z.object({
    requirements: z.array(z.object({
      id: z.string().optional(),
      text: z.string().optional(),
    }).passthrough()),
    constraints: z.array(z.object({
      id: z.string().optional(),
      text: z.string().optional(),
    }).passthrough()),
    successCriteria: z.array(z.object({
      id: z.string().optional(),
      text: z.string().optional(),
    }).passthrough()),
  }).passthrough(),

  pseudocode: z.object({
    modules: z.array(z.object({
      name: z.string(),
    }).passthrough()),
  }).passthrough(),

  architecture: z.object({
    services: z.array(z.object({
      id: z.string(),
      name: z.string(),
      responsibility: z.string(),
      api: z.array(z.string()),
      dependencies: z.array(z.string()),
    }).passthrough()),
    securityBoundaries: z.array(z.string()).optional(),
    apiContracts: z.array(z.string()).optional(),
  }).passthrough(),

  refinement: z.object({
    performanceTargets: z.array(z.object({
      id: z.string().optional(),
      text: z.string().optional(),
    }).passthrough()).optional(),
    securityConsiderations: z.array(z.object({
      id: z.string().optional(),
      text: z.string().optional(),
    }).passthrough()).optional(),
  }).passthrough(),

  completion: z.object({}).passthrough(),
}).passthrough();

// ============================================================================
// ADR Records (on-disk format from adrs/adr-index.json)
// ============================================================================

/**
 * Schema for a single ADR record as found in adr-index.json.
 *
 * The on-disk alternatives shape (`option`, `rationale`, `rejected`)
 * differs from the Phase 2 internal schema. We use passthrough on the
 * alternatives elements to tolerate either shape.
 */
export const ADRRecordOnDiskSchema = z.object({
  id: z.string(),
  title: z.string(),
  status: z.string(),
  context: z.string(),
  decision: z.string(),
  alternatives: z.array(z.object({}).passthrough()),
  consequences: z.array(z.object({}).passthrough()),
  sparcSectionRefs: z.array(z.string()),
  researchDossierItemRefs: z.array(z.string()),
}).passthrough();

/**
 * Schema for the full adr-index.json file: an array of ADR records.
 */
export const ADRIndexOnDiskSchema = z.array(ADRRecordOnDiskSchema);

// ============================================================================
// DDD Domain Model (on-disk format from ddd/domain-model.json)
// ============================================================================

/**
 * Schema for the domain-model.json file written by Phase 2.
 *
 * Bounded contexts on disk may carry entities with `description`
 * rather than `properties`/`invariants`. Commands, queries, and
 * domain events also have a different shape than the Phase 2
 * internal types. Passthrough absorbs all these variations.
 */
export const DomainModelOnDiskSchema = z.object({
  contexts: z.array(z.object({
    name: z.string(),
    description: z.string().optional(),
    aggregates: z.array(z.object({
      name: z.string(),
    }).passthrough()).optional(),
    commands: z.array(z.object({
      name: z.string(),
    }).passthrough()).optional(),
    queries: z.array(z.object({
      name: z.string(),
    }).passthrough()).optional(),
    domainEvents: z.array(z.object({
      name: z.string(),
    }).passthrough()).optional(),
    ubiquitousLanguage: z.array(z.object({
      term: z.string(),
    }).passthrough()).optional(),
  }).passthrough()),

  contextMap: z.array(z.object({
    upstream: z.string(),
    downstream: z.string(),
    type: z.string(),
    description: z.string().optional(),
  }).passthrough()),

  ubiquitousLanguageGlossary: z.array(z.object({
    term: z.string(),
  }).passthrough()).optional(),
}).passthrough();

// ============================================================================
// TDD Plan (on-disk format from tdd/tdd-plan.json)
// ============================================================================

/**
 * Schema for the tdd-plan.json file written by Phase 2.
 *
 * The on-disk `testPyramid` is a record of layer names to count/pct
 * objects (not the `levels` array from the internal schema). Test
 * suites carry extra fields like `mockDependencies` and `adrRefs`.
 * Passthrough absorbs all variations.
 */
export const TDDPlanOnDiskSchema = z.object({
  approach: z.string(),
  testPyramid: z.object({}).passthrough(),
  testSuites: z.array(z.object({
    id: z.string(),
    boundedContext: z.string(),
    layer: z.string(),
    name: z.string(),
    tests: z.array(z.object({}).passthrough()),
  }).passthrough()),
  mockContracts: z.array(z.object({}).passthrough()),
  seamDefinitions: z.array(z.object({
    id: z.string().optional(),
    name: z.string().optional(),
  }).passthrough()),
  executionOrder: z.array(z.string()),
}).passthrough();

// ============================================================================
// Phase 3 Manifest (output format for phase3-manifest.json)
// ============================================================================

/**
 * Schema for the Phase 3 manifest written at the end of a successful run.
 * This is a strict schema (no passthrough) because Phase 3 controls the
 * output format.
 */
export const Phase3ManifestSchema = z.object({
  schema_version: z.literal('3.0.0'),
  trace_id: z.string(),
  implementation_language: z.enum(['rust', 'typescript']),
  mixed_mode: z.literal(false),
  ruflo_version: z.string(),
  artifacts: z.array(z.object({
    path: z.string(),
    sha256: z.string(),
    size_bytes: z.number(),
  })),
  total_timing_ms: z.number(),
  success: z.boolean(),
});

// ============================================================================
// Language Resolution (output of the language-resolution stage)
// ============================================================================

/**
 * Schema for the language resolution result produced by the
 * language-resolution pipeline stage.
 */
export const LanguageResolutionSchema = z.object({
  language: z.enum(['rust', 'typescript']),
  mixed_mode: z.literal(false),
  rationale: z.string(),
  signals: z.array(z.object({
    name: z.string(),
    source: z.string(),
    favors: z.enum(['rust', 'typescript']),
    weight: z.number(),
    score: z.number(),
    confidence: z.number(),
    evidence: z.string(),
  }).passthrough()),
  typescript_score: z.number(),
  rust_score: z.number(),
});

// ============================================================================
// Inferred Types
// ============================================================================

export type ValidatedPhase2ManifestOnDisk = z.infer<typeof Phase2ManifestOnDiskSchema>;
export type ValidatedSPARCOnDisk = z.infer<typeof SPARCOnDiskSchema>;
export type ValidatedADRRecordOnDisk = z.infer<typeof ADRRecordOnDiskSchema>;
export type ValidatedADRIndexOnDisk = z.infer<typeof ADRIndexOnDiskSchema>;
export type ValidatedDomainModelOnDisk = z.infer<typeof DomainModelOnDiskSchema>;
export type ValidatedTDDPlanOnDisk = z.infer<typeof TDDPlanOnDiskSchema>;
export type ValidatedPhase3Manifest = z.infer<typeof Phase3ManifestSchema>;
export type ValidatedLanguageResolution = z.infer<typeof LanguageResolutionSchema>;
