/**
 * Phase 6 — Stage 1: Phase 5 Artifact Validation
 *
 * Loads the phase5-manifest.json and validates that required artifacts exist:
 * - Codegen output (codegen/ directory)
 * - Deployment configs (deploy/ directory with Dockerfile, etc.)
 *
 * Error codes:
 *   ECLI-P6-002  Phase 5 manifest not found or invalid
 *   ECLI-P6-003  Required Phase 5 artifact missing
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Phase6Context, Phase6StageOutput, Phase5ManifestRef } from '../types.js';
import { createSpan, endSpan, emitSpan } from '../../phase2/telemetry.js';

// ============================================================================
// Constants
// ============================================================================

/** Minimum set of Phase 5 artifacts that must exist for Phase 6 to proceed. */
const REQUIRED_ARTIFACT_PATTERNS = [
  'deploy/deployment/Dockerfile',
] as const;

/** Additional artifacts whose presence is validated but not strictly required. */
const RECOMMENDED_ARTIFACT_PATTERNS = [
  'deploy/deployment/cloudbuild.yaml',
  'deploy/deployment/cloud-run-service.yaml',
  'deploy/deployment/.env.example',
] as const;

// ============================================================================
// Helper: Read and parse a JSON file
// ============================================================================

/**
 * Read a JSON file from disk, parse it, and return the result.
 * Throws a descriptive error with the appropriate Phase 6 error code
 * if the file is missing or unparseable.
 */
function readJson(dir: string, filename: string): unknown {
  const filepath = join(dir, filename);

  if (!existsSync(filepath)) {
    throw new Error(
      `ECLI-P6-002: Required artifact missing: ${filename} in ${dir}`,
    );
  }

  let raw: string;
  try {
    raw = readFileSync(filepath, 'utf-8');
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `ECLI-P6-002: Artifact read failed: ${filename}: ${message}`,
    );
  }

  try {
    return JSON.parse(raw);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `ECLI-P6-002: Artifact parse failed: ${filename}: JSON parse error: ${message}`,
    );
  }
}

// ============================================================================
// Helper: Recursively count files in a directory
// ============================================================================

/**
 * Walk a directory tree and return the total number of files found.
 * Returns 0 if the directory does not exist.
 */
function countFilesRecursive(dir: string): number {
  if (!existsSync(dir)) {
    return 0;
  }

  let count = 0;
  const entries = readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.isFile()) {
      count += 1;
    } else if (entry.isDirectory()) {
      count += countFilesRecursive(join(dir, entry.name));
    }
  }

  return count;
}

// ============================================================================
// Helper: Validate the Phase 5 manifest structure
// ============================================================================

/**
 * Validate that the parsed JSON conforms to the Phase5ManifestRef shape.
 * Checks for required top-level fields and returns a typed reference.
 */
function validateManifestShape(raw: unknown): Phase5ManifestRef {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error(
      'ECLI-P6-002: Phase 5 manifest is not a valid JSON object.',
    );
  }

  const obj = raw as Record<string, unknown>;

  if (typeof obj['schema_version'] !== 'string') {
    throw new Error(
      'ECLI-P6-002: Phase 5 manifest missing required field: schema_version.',
    );
  }

  if (typeof obj['trace_id'] !== 'string') {
    throw new Error(
      'ECLI-P6-002: Phase 5 manifest missing required field: trace_id.',
    );
  }

  if (obj['success'] !== true) {
    // Check if codegen succeeded — if so, allow degraded-mode Phase 6
    const stages = Array.isArray(obj['stages']) ? obj['stages'] as Array<Record<string, unknown>> : [];
    const codegenStage = stages.find(s => s['stage'] === 'domain-codegen');
    const codegenSucceeded = codegenStage && codegenStage['status'] === 'completed';
    if (!codegenSucceeded) {
      throw new Error(
        'ECLI-P6-002: Phase 5 manifest indicates pipeline did not succeed (success=false) ' +
        'and domain codegen did not complete. Re-run Phase 5 to completion before executing Phase 6.',
      );
    }
    // Codegen succeeded — proceed in degraded mode (non-critical stages like integration-injection may have failed)
    console.error('  [WARN] Phase 5 had non-critical failures but codegen succeeded. Proceeding in degraded mode.');
  }

  if (typeof obj['implementation_language'] !== 'string') {
    throw new Error(
      'ECLI-P6-002: Phase 5 manifest missing required field: implementation_language.',
    );
  }

  // erp_system may come from the Phase 5 Build manifest
  if (typeof obj['erp_system'] !== 'string') {
    throw new Error(
      'ECLI-P6-002: Phase 5 manifest missing required field: erp_system.',
    );
  }

  return obj as unknown as Phase5ManifestRef;
}

// ============================================================================
// Main: validatePhase5Artifacts
// ============================================================================

/**
 * Stage 1: Load and validate Phase 5 Build artifacts.
 *
 * Reads `phase5-manifest.json` from the Phase 5 output directory, verifies
 * its shape and success flag, confirms that required deployment artifacts
 * exist on disk, and populates `context.phase5Artifacts` with the loaded data.
 *
 * @param context - The mutable Phase 6 pipeline context
 * @returns Stage output describing success or failure
 */
export function validatePhase5Artifacts(context: Phase6Context): Phase6StageOutput {
  const startTime = Date.now();
  const rootSpan = createSpan('phase5-validation', 'validate-all', {
    phase5Dir: context.phase5Dir,
  });

  try {
    // -------------------------------------------------------------------------
    // Step 1: Locate and read phase5-manifest.json
    // -------------------------------------------------------------------------
    const manifestSpan = createSpan(
      'phase5-validation',
      'load-phase5-manifest',
      { filename: 'phase5-manifest.json' },
      rootSpan.spanId,
    );

    let manifestRaw: unknown;
    try {
      manifestRaw = readJson(context.phase5Dir, 'phase5-manifest.json');
      const finalManifestSpan = endSpan(manifestSpan, 'ok', { filename: 'phase5-manifest.json' });
      emitSpan(finalManifestSpan);
      context.telemetrySpans.push(finalManifestSpan);
    } catch (err: unknown) {
      const finalManifestSpan = endSpan(manifestSpan, 'error', {
        error: err instanceof Error ? err.message : String(err),
      });
      emitSpan(finalManifestSpan);
      context.telemetrySpans.push(finalManifestSpan);
      throw err;
    }

    // -------------------------------------------------------------------------
    // Step 2: Validate manifest structure and required fields
    // -------------------------------------------------------------------------
    const validateSpan = createSpan(
      'phase5-validation',
      'validate-manifest-shape',
      {},
      rootSpan.spanId,
    );

    const manifest = validateManifestShape(manifestRaw);

    const finalValidateSpan = endSpan(validateSpan, 'ok', {
      schemaVersion: manifest.schema_version,
      erpSystem: manifest.erp_system,
      implementationLanguage: manifest.implementation_language,
    });
    emitSpan(finalValidateSpan);
    context.telemetrySpans.push(finalValidateSpan);

    // -------------------------------------------------------------------------
    // Step 3: Verify required artifacts exist on disk
    // -------------------------------------------------------------------------
    const artifactSpan = createSpan(
      'phase5-validation',
      'verify-required-artifacts',
      { requiredCount: REQUIRED_ARTIFACT_PATTERNS.length },
      rootSpan.spanId,
    );

    const missingRequired: string[] = [];
    const missingRecommended: string[] = [];

    for (const pattern of REQUIRED_ARTIFACT_PATTERNS) {
      const absPath = join(context.phase5Dir, pattern);
      if (!existsSync(absPath)) {
        missingRequired.push(pattern);
      }
    }

    if (missingRequired.length > 0) {
      // In degraded mode (success=false but codegen succeeded), treat missing deploy artifacts as warnings
      const isDegradedMode = (manifestRaw as Record<string, unknown>)['success'] !== true;
      if (isDegradedMode) {
        console.error(`  [WARN] Missing deploy artifacts in degraded mode: ${missingRequired.join(', ')}`);
        const warnArtifactSpan = endSpan(artifactSpan, 'ok', {
          degradedMode: true,
          missingRequired: missingRequired.join(', '),
        });
        emitSpan(warnArtifactSpan);
        context.telemetrySpans.push(warnArtifactSpan);
      } else {
        const finalArtifactSpan = endSpan(artifactSpan, 'error', {
          missingRequired: missingRequired.join(', '),
        });
        emitSpan(finalArtifactSpan);
        context.telemetrySpans.push(finalArtifactSpan);
        throw new Error(
          `ECLI-P6-003: Required Phase 5 artifact(s) missing: ${missingRequired.join(', ')}. ` +
          'Ensure Phase 5 completed the deployable-service stage.',
        );
      }
    }

    for (const pattern of RECOMMENDED_ARTIFACT_PATTERNS) {
      const absPath = join(context.phase5Dir, pattern);
      if (!existsSync(absPath)) {
        missingRecommended.push(pattern);
      }
    }

    const finalArtifactSpan = endSpan(artifactSpan, 'ok', {
      requiredPresent: REQUIRED_ARTIFACT_PATTERNS.length,
      recommendedMissing: missingRecommended.length,
    });
    emitSpan(finalArtifactSpan);
    context.telemetrySpans.push(finalArtifactSpan);

    // -------------------------------------------------------------------------
    // Step 4: Walk the Phase 5 project directory and count files
    // -------------------------------------------------------------------------
    const countSpan = createSpan(
      'phase5-validation',
      'count-project-files',
      { phase5Dir: context.phase5Dir },
      rootSpan.spanId,
    );

    const projectDir = join(context.phase5Dir, 'deploy', 'project');
    const totalFiles = countFilesRecursive(context.phase5Dir);
    const projectFiles = countFilesRecursive(projectDir);

    const finalCountSpan = endSpan(countSpan, 'ok', {
      totalFiles,
      projectFiles,
      projectDirExists: existsSync(projectDir),
    });
    emitSpan(finalCountSpan);
    context.telemetrySpans.push(finalCountSpan);

    // -------------------------------------------------------------------------
    // Step 5: Populate context.phase5Artifacts
    // -------------------------------------------------------------------------
    const phase5Artifacts = {
      manifest,
      implementationLanguage: manifest.implementation_language,
      erpSystem: manifest.erp_system,
      databaseEngine: (manifest.database_engine as string | null) ?? null,
      apiOnly: (manifest.api_only as boolean) ?? false,
      projectDir,
    };

    // Mutate context to store the loaded artifacts
    (context as unknown as Record<string, unknown>)['phase5Artifacts'] = phase5Artifacts;

    // -------------------------------------------------------------------------
    // Step 6: Build and return stage output
    // -------------------------------------------------------------------------
    const finalRootSpan = endSpan(rootSpan, 'ok', {
      schemaVersion: manifest.schema_version,
      traceId: manifest.trace_id,
      erpSystem: manifest.erp_system,
      implementationLanguage: manifest.implementation_language,
      totalFiles,
      projectFiles,
    });
    emitSpan(finalRootSpan);
    context.telemetrySpans.push(finalRootSpan);

    const timing = Date.now() - startTime;

    const artifactPaths = [
      join(context.phase5Dir, 'phase5-manifest.json'),
      ...REQUIRED_ARTIFACT_PATTERNS.map((p) => join(context.phase5Dir, p)),
      ...RECOMMENDED_ARTIFACT_PATTERNS
        .filter((p) => !missingRecommended.includes(p))
        .map((p) => join(context.phase5Dir, p)),
    ];

    const output: Phase6StageOutput = {
      stage: 'phase5-validation',
      status: 'completed',
      data: phase5Artifacts,
      artifacts: artifactPaths,
      timing,
    };

    context.stageOutputs.set('phase5-validation', output);
    return output;
  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : String(err);

    const finalRootSpan = endSpan(rootSpan, 'error', { error: errorMessage });
    emitSpan(finalRootSpan);
    context.telemetrySpans.push(finalRootSpan);

    const timing = Date.now() - startTime;

    const output: Phase6StageOutput = {
      stage: 'phase5-validation',
      status: 'failed',
      data: { error: errorMessage },
      artifacts: [],
      timing,
    };

    context.stageOutputs.set('phase5-validation', output);
    return output;
  }
}
