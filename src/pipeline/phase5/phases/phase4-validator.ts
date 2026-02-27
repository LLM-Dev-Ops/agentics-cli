/**
 * Phase 5 — Stage 1: Phase 4 Artifact Validation
 *
 * Loads the phase4-manifest.json and validates that required artifacts exist:
 * - Deployment configs (Dockerfile, cloudbuild.yaml, cloud-run-service.yaml)
 * - ERP client files
 * - HTTP server files
 * - Schema files (if database-backed)
 *
 * Error codes:
 *   ECLI-P5-002  Phase 4 manifest not found or invalid
 *   ECLI-P5-003  Required Phase 4 artifact missing
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Phase5Context, Phase5StageOutput, Phase4ManifestRef } from '../types.js';
import { createSpan, endSpan, emitSpan } from '../../phase2/telemetry.js';

// ============================================================================
// Constants
// ============================================================================

/** Minimum set of Phase 4 artifacts that must exist for Phase 5 to proceed. */
const REQUIRED_ARTIFACT_PATTERNS = [
  'deployment/Dockerfile',
] as const;

/** Additional artifacts whose presence is validated but not strictly required. */
const RECOMMENDED_ARTIFACT_PATTERNS = [
  'deployment/cloudbuild.yaml',
  'deployment/cloud-run-service.yaml',
  'deployment/.env.example',
] as const;

// ============================================================================
// Helper: Read and parse a JSON file
// ============================================================================

/**
 * Read a JSON file from disk, parse it, and return the result.
 * Throws a descriptive error with the appropriate Phase 5 error code
 * if the file is missing or unparseable.
 */
function readJson(dir: string, filename: string): unknown {
  const filepath = join(dir, filename);

  if (!existsSync(filepath)) {
    throw new Error(
      `ECLI-P5-002: Required artifact missing: ${filename} in ${dir}`,
    );
  }

  let raw: string;
  try {
    raw = readFileSync(filepath, 'utf-8');
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `ECLI-P5-002: Artifact read failed: ${filename}: ${message}`,
    );
  }

  try {
    return JSON.parse(raw);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `ECLI-P5-002: Artifact parse failed: ${filename}: JSON parse error: ${message}`,
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
// Helper: Validate the Phase 4 manifest structure
// ============================================================================

/**
 * Validate that the parsed JSON conforms to the Phase4ManifestRef shape.
 * Checks for required top-level fields and returns a typed reference.
 */
function validateManifestShape(raw: unknown): Phase4ManifestRef {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error(
      'ECLI-P5-002: Phase 4 manifest is not a valid JSON object.',
    );
  }

  const obj = raw as Record<string, unknown>;

  if (typeof obj['schema_version'] !== 'string') {
    throw new Error(
      'ECLI-P5-002: Phase 4 manifest missing required field: schema_version.',
    );
  }

  if (typeof obj['trace_id'] !== 'string') {
    throw new Error(
      'ECLI-P5-002: Phase 4 manifest missing required field: trace_id.',
    );
  }

  if (obj['success'] !== true) {
    throw new Error(
      'ECLI-P5-002: Phase 4 manifest indicates pipeline did not succeed (success=false). ' +
      'Re-run Phase 4 to completion before executing Phase 5.',
    );
  }

  if (typeof obj['implementation_language'] !== 'string') {
    throw new Error(
      'ECLI-P5-002: Phase 4 manifest missing required field: implementation_language.',
    );
  }

  if (typeof obj['erp_system'] !== 'string') {
    throw new Error(
      'ECLI-P5-002: Phase 4 manifest missing required field: erp_system.',
    );
  }

  return obj as unknown as Phase4ManifestRef;
}

// ============================================================================
// Main: validatePhase4Artifacts
// ============================================================================

/**
 * Stage 1: Load and validate Phase 4 artifacts.
 *
 * Reads `phase4-manifest.json` from the Phase 4 output directory, verifies
 * its shape and success flag, confirms that required deployment artifacts
 * exist on disk, and populates `context.phase4Artifacts` with the loaded data.
 *
 * The Phase 4 directory is located by examining `context.phase4Dir`. If the
 * manifest is in the parent directory's `phase4/` subdirectory, we resolve
 * that path as well.
 *
 * @param context - The mutable Phase 5 pipeline context
 * @returns Stage output describing success or failure
 */
export function validatePhase4Artifacts(context: Phase5Context): Phase5StageOutput {
  const startTime = Date.now();
  const rootSpan = createSpan('phase4-validation', 'validate-all', {
    phase4Dir: context.phase4Dir,
  });

  try {
    // -------------------------------------------------------------------------
    // Step 1: Locate and read phase4-manifest.json
    // -------------------------------------------------------------------------
    const manifestSpan = createSpan(
      'phase4-validation',
      'load-phase4-manifest',
      { filename: 'phase4-manifest.json' },
      rootSpan.spanId,
    );

    let manifestRaw: unknown;
    try {
      manifestRaw = readJson(context.phase4Dir, 'phase4-manifest.json');
      const finalManifestSpan = endSpan(manifestSpan, 'ok', { filename: 'phase4-manifest.json' });
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
      'phase4-validation',
      'validate-manifest-shape',
      {},
      rootSpan.spanId,
    );

    const manifest = validateManifestShape(manifestRaw);

    const finalValidateSpan = endSpan(validateSpan, 'ok', {
      schemaVersion: manifest.schema_version,
      erpSystem: manifest.erp_system,
      implementationLanguage: manifest.implementation_language,
      apiOnly: manifest.api_only,
    });
    emitSpan(finalValidateSpan);
    context.telemetrySpans.push(finalValidateSpan);

    // -------------------------------------------------------------------------
    // Step 3: Verify required artifacts exist on disk
    // -------------------------------------------------------------------------
    const artifactSpan = createSpan(
      'phase4-validation',
      'verify-required-artifacts',
      { requiredCount: REQUIRED_ARTIFACT_PATTERNS.length },
      rootSpan.spanId,
    );

    const missingRequired: string[] = [];
    const missingRecommended: string[] = [];

    for (const pattern of REQUIRED_ARTIFACT_PATTERNS) {
      const absPath = join(context.phase4Dir, pattern);
      if (!existsSync(absPath)) {
        missingRequired.push(pattern);
      }
    }

    if (missingRequired.length > 0) {
      const finalArtifactSpan = endSpan(artifactSpan, 'error', {
        missingRequired: missingRequired.join(', '),
      });
      emitSpan(finalArtifactSpan);
      context.telemetrySpans.push(finalArtifactSpan);
      throw new Error(
        `ECLI-P5-003: Required Phase 4 artifact(s) missing: ${missingRequired.join(', ')}. ` +
        'Ensure Phase 4 completed the deployment-generation stage.',
      );
    }

    for (const pattern of RECOMMENDED_ARTIFACT_PATTERNS) {
      const absPath = join(context.phase4Dir, pattern);
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
    // Step 4: Walk the Phase 4 project directory and count files
    // -------------------------------------------------------------------------
    const countSpan = createSpan(
      'phase4-validation',
      'count-project-files',
      { phase4Dir: context.phase4Dir },
      rootSpan.spanId,
    );

    const projectDir = join(context.phase4Dir, 'project');
    const totalFiles = countFilesRecursive(context.phase4Dir);
    const projectFiles = countFilesRecursive(projectDir);

    const finalCountSpan = endSpan(countSpan, 'ok', {
      totalFiles,
      projectFiles,
      projectDirExists: existsSync(projectDir),
    });
    emitSpan(finalCountSpan);
    context.telemetrySpans.push(finalCountSpan);

    // -------------------------------------------------------------------------
    // Step 5: Populate context.phase4Artifacts
    // -------------------------------------------------------------------------
    const phase4Artifacts = {
      manifest,
      implementationLanguage: manifest.implementation_language,
      erpSystem: manifest.erp_system,
      databaseEngine: manifest.database_engine,
      apiOnly: manifest.api_only,
      projectDir,
    };

    // Mutate context to store the loaded artifacts
    (context as unknown as Record<string, unknown>)['phase4Artifacts'] = phase4Artifacts;

    // -------------------------------------------------------------------------
    // Step 6: Build and return stage output
    // -------------------------------------------------------------------------
    const finalRootSpan = endSpan(rootSpan, 'ok', {
      schemaVersion: manifest.schema_version,
      traceId: manifest.trace_id,
      erpSystem: manifest.erp_system,
      implementationLanguage: manifest.implementation_language,
      apiOnly: manifest.api_only,
      totalFiles,
      projectFiles,
    });
    emitSpan(finalRootSpan);
    context.telemetrySpans.push(finalRootSpan);

    const timing = Date.now() - startTime;

    const artifactPaths = [
      join(context.phase4Dir, 'phase4-manifest.json'),
      ...REQUIRED_ARTIFACT_PATTERNS.map((p) => join(context.phase4Dir, p)),
      ...RECOMMENDED_ARTIFACT_PATTERNS
        .filter((p) => !missingRecommended.includes(p))
        .map((p) => join(context.phase4Dir, p)),
    ];

    const output: Phase5StageOutput = {
      stage: 'phase4-validation',
      status: 'completed',
      data: phase4Artifacts,
      artifacts: artifactPaths,
      timing,
    };

    context.stageOutputs.set('phase4-validation', output);
    return output;
  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : String(err);

    const finalRootSpan = endSpan(rootSpan, 'error', { error: errorMessage });
    emitSpan(finalRootSpan);
    context.telemetrySpans.push(finalRootSpan);

    const timing = Date.now() - startTime;

    const output: Phase5StageOutput = {
      stage: 'phase4-validation',
      status: 'failed',
      data: { error: errorMessage },
      artifacts: [],
      timing,
    };

    context.stageOutputs.set('phase4-validation', output);
    return output;
  }
}
