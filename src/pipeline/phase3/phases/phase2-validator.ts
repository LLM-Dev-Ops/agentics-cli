/**
 * Phase 3 Pipeline — Stage 1: Phase 2 Artifact Validator
 *
 * Loads and validates all Phase 2 artifacts from disk using Zod schemas.
 * Each JSON file is parsed and validated against its on-disk schema.
 *
 * Error codes:
 *   ECLI-P3-001  Phase 2 directory or required artifact missing
 *   ECLI-P3-004  Phase 2 artifact parse / validation failed
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { z } from 'zod';

import type {
  Phase2Artifacts,
  Phase3Context,
  Phase3StageOutput,
} from '../types.js';
import {
  Phase2ManifestOnDiskSchema,
  SPARCOnDiskSchema,
  ADRIndexOnDiskSchema,
  DomainModelOnDiskSchema,
  TDDPlanOnDiskSchema,
} from '../schemas.js';
import { createSpan, endSpan, emitSpan } from '../../phase2/telemetry.js';

// ============================================================================
// Helper: read + parse + validate a single JSON artifact
// ============================================================================

/**
 * Read a JSON file, parse it, and validate against `schema`.
 *
 * @param dir      - Directory containing the artifact
 * @param filename - Relative path within the directory
 * @param schema   - Zod schema to validate the parsed object
 * @returns The validated object
 * @throws Error with ECLI-P3-001 if the file does not exist
 * @throws Error with ECLI-P3-004 if JSON parsing or Zod validation fails
 */
function readJsonArtifact<T>(dir: string, filename: string, schema: z.ZodType<T>): T {
  const filepath = path.join(dir, filename);

  if (!fs.existsSync(filepath)) {
    throw new Error(
      `ECLI-P3-001: Required Phase 2 artifact missing: ${filename} in ${dir}`,
    );
  }

  let raw: string;
  try {
    raw = fs.readFileSync(filepath, 'utf-8');
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `ECLI-P3-004: Phase 2 artifact read failed: ${filename}: ${message}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `ECLI-P3-004: Phase 2 artifact parse failed: ${filename}: JSON parse error: ${message}`,
    );
  }

  try {
    return schema.parse(parsed);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `ECLI-P3-004: Phase 2 artifact validation failed: ${filename}: ${message}`,
    );
  }
}

// ============================================================================
// Artifact descriptors
// ============================================================================

interface ArtifactDescriptor {
  readonly filename: string;
  readonly key: keyof Phase2Artifacts;
  readonly schema: z.ZodType<unknown>;
}

const ARTIFACT_DESCRIPTORS: readonly ArtifactDescriptor[] = [
  { filename: 'phase2-manifest.json', key: 'manifest', schema: Phase2ManifestOnDiskSchema },
  { filename: 'sparc/sparc-combined.json', key: 'sparc', schema: SPARCOnDiskSchema },
  { filename: 'adrs/adr-index.json', key: 'adrs', schema: ADRIndexOnDiskSchema },
  { filename: 'ddd/domain-model.json', key: 'domainModel', schema: DomainModelOnDiskSchema },
  { filename: 'tdd/tdd-plan.json', key: 'tddPlan', schema: TDDPlanOnDiskSchema },
] as const;

// ============================================================================
// Main: validatePhase2Artifacts
// ============================================================================

/**
 * Load and validate all Phase 2 artifacts from disk.
 *
 * Creates telemetry spans for overall loading and per-file operations.
 * On success, stores the assembled Phase2Artifacts on `context.phase2Artifacts`
 * and the scenario query on `context.scenarioQuery`, then returns a completed
 * Phase3StageOutput. On failure, returns a failed output with the error message.
 *
 * @param context - The mutable Phase 3 pipeline context
 * @returns Stage output describing success or failure
 */
export async function validatePhase2Artifacts(
  context: Phase3Context,
): Promise<Phase3StageOutput> {
  const rootSpan = createSpan('phase2-validation', 'validate-all', {
    phase2Dir: context.phase2Dir,
    artifactCount: ARTIFACT_DESCRIPTORS.length,
  });

  try {
    // Check Phase 2 directory exists
    if (!fs.existsSync(context.phase2Dir)) {
      throw new Error(
        `ECLI-P3-001: Phase 2 output directory not found: ${context.phase2Dir}`,
      );
    }

    const artifacts: Record<string, unknown> = {};
    const loadedFilenames: string[] = [];

    for (const descriptor of ARTIFACT_DESCRIPTORS) {
      const childSpan = createSpan(
        'phase2-validation',
        `load-${descriptor.filename.replace(/\//g, '-')}`,
        { filename: descriptor.filename },
        rootSpan.spanId,
      );

      try {
        artifacts[descriptor.key] = readJsonArtifact(
          context.phase2Dir,
          descriptor.filename,
          descriptor.schema,
        );

        loadedFilenames.push(descriptor.filename);
        const finalChild = endSpan(childSpan, 'ok', { filename: descriptor.filename });
        emitSpan(finalChild);
        context.telemetrySpans.push(finalChild);
      } catch (err: unknown) {
        const finalChild = endSpan(childSpan, 'error', {
          filename: descriptor.filename,
          error: err instanceof Error ? err.message : String(err),
        });
        emitSpan(finalChild);
        context.telemetrySpans.push(finalChild);
        throw err;
      }
    }

    const phase2Artifacts = artifacts as unknown as Phase2Artifacts;

    // Structural validation: at least 1 bounded context
    const domainModel = phase2Artifacts.domainModel;
    if (!domainModel.contexts || domainModel.contexts.length === 0) {
      throw new Error(
        'ECLI-P3-004: Phase 2 domain model contains no bounded contexts. ' +
        'At least 1 bounded context is required for code generation.',
      );
    }

    // Structural validation: at least 1 test suite
    const tddPlan = phase2Artifacts.tddPlan;
    if (!tddPlan.testSuites || tddPlan.testSuites.length === 0) {
      throw new Error(
        'ECLI-P3-004: Phase 2 TDD plan contains no test suites. ' +
        'At least 1 test suite is required for test generation.',
      );
    }

    // Store artifacts on the mutable context
    (context as { phase2Artifacts: Phase2Artifacts }).phase2Artifacts = phase2Artifacts;

    // Extract scenario query from the manifest chain
    const scenarioQuery = (phase2Artifacts.manifest as unknown as Record<string, unknown>)['scenario_query'] as string
      ?? context.scenarioQuery
      ?? '';
    (context as { scenarioQuery: string }).scenarioQuery = scenarioQuery;

    const finalRootSpan = endSpan(rootSpan, 'ok', {
      filesLoaded: loadedFilenames.length,
      boundedContexts: domainModel.contexts.length,
      testSuites: tddPlan.testSuites.length,
    });
    emitSpan(finalRootSpan);
    context.telemetrySpans.push(finalRootSpan);

    const timing = finalRootSpan.durationMs ?? 0;

    const output: Phase3StageOutput = {
      stage: 'phase2-validation',
      status: 'completed',
      data: phase2Artifacts,
      artifacts: loadedFilenames,
      timing,
      summary:
        `  [OK] Loaded ${loadedFilenames.length} Phase 2 artifacts ` +
        `(${domainModel.contexts.length} bounded contexts, ` +
        `${tddPlan.testSuites.length} test suites) in ${timing}ms`,
    };

    context.stageOutputs.set('phase2-validation', output);
    return output;
  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : String(err);

    const finalRootSpan = endSpan(rootSpan, 'error', { error: errorMessage });
    emitSpan(finalRootSpan);
    context.telemetrySpans.push(finalRootSpan);

    const timing = finalRootSpan.durationMs ?? 0;

    const output: Phase3StageOutput = {
      stage: 'phase2-validation',
      status: 'failed',
      data: { error: errorMessage },
      artifacts: [],
      timing,
      summary: `  [FAIL] Phase 2 artifact validation failed: ${errorMessage}`,
    };

    context.stageOutputs.set('phase2-validation', output);
    return output;
  }
}
