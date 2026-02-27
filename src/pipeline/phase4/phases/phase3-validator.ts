/**
 * Phase 4 Pipeline — Stage 1: Phase 3 Artifact Validator
 *
 * Loads and validates the Phase 3 manifest and all Phase 2 artifacts
 * required for downstream Phase 4 code generation stages.
 *
 * Error codes:
 *   ECLI-P4-001  Phase 3 manifest missing or validation failed
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Phase4Context, Phase4StageOutput, Phase3Artifacts } from '../types.js';
import { createSpan, endSpan, emitSpan } from '../../phase2/telemetry.js';

// ============================================================================
// Helper: read + parse a single JSON file
// ============================================================================

/**
 * Read a JSON file from disk, parse it, and return the result.
 * Throws a descriptive error if the file is missing or unparseable.
 */
function readJson(dir: string, filename: string): unknown {
  const filepath = join(dir, filename);

  if (!existsSync(filepath)) {
    throw new Error(
      `ECLI-P4-001: Required artifact missing: ${filename} in ${dir}`,
    );
  }

  let raw: string;
  try {
    raw = readFileSync(filepath, 'utf-8');
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `ECLI-P4-001: Artifact read failed: ${filename}: ${message}`,
    );
  }

  try {
    return JSON.parse(raw);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `ECLI-P4-001: Artifact parse failed: ${filename}: JSON parse error: ${message}`,
    );
  }
}

// ============================================================================
// Main: validatePhase3Artifacts
// ============================================================================

/**
 * Stage 1: Load and validate the Phase 3 manifest and Phase 2 artifacts.
 *
 * Reads `phase3-manifest.json` from `context.phase3Dir`, verifies that
 * `schema_version === '3.0.0'` and `success === true`, then loads all
 * Phase 2 JSON artifacts from `context.phase2Dir`.
 *
 * On success, stores the assembled Phase3Artifacts on `context.phase3Artifacts`
 * and returns a completed Phase4StageOutput. On failure, returns a failed
 * output with the error message.
 *
 * @param context - The mutable Phase 4 pipeline context
 * @returns Stage output describing success or failure
 */
export function validatePhase3Artifacts(context: Phase4Context): Phase4StageOutput {
  const rootSpan = createSpan('phase3-validation', 'validate-all', {
    phase3Dir: context.phase3Dir,
    phase2Dir: context.phase2Dir,
  });

  try {
    // -------------------------------------------------------------------------
    // Step 1: Read and validate phase3-manifest.json
    // -------------------------------------------------------------------------
    const manifestSpan = createSpan(
      'phase3-validation',
      'load-phase3-manifest',
      { filename: 'phase3-manifest.json' },
      rootSpan.spanId,
    );

    let phase3Manifest: unknown;
    try {
      phase3Manifest = readJson(context.phase3Dir, 'phase3-manifest.json');
      const finalManifestSpan = endSpan(manifestSpan, 'ok', { filename: 'phase3-manifest.json' });
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

    // Validate schema_version and success flag
    const manifestObj = phase3Manifest as Record<string, unknown>;
    if (manifestObj['schema_version'] !== '3.0.0') {
      throw new Error(
        `ECLI-P4-001: Phase 3 manifest schema_version is '${String(manifestObj['schema_version'])}', expected '3.0.0'. ` +
        'Ensure Phase 3 completed with the current pipeline version.',
      );
    }
    if (manifestObj['success'] !== true) {
      throw new Error(
        'ECLI-P4-001: Phase 3 manifest indicates pipeline did not succeed (success=false). ' +
        'Re-run Phase 3 to completion before executing Phase 4.',
      );
    }

    // Derive implementation language from the manifest
    const implementationLanguage = (manifestObj['implementation_language'] as string) ?? 'typescript';

    // -------------------------------------------------------------------------
    // Step 2: Load Phase 2 artifacts from context.phase2Dir
    // -------------------------------------------------------------------------
    const artifactFilenames = [
      'phase2-manifest.json',
      'sparc/sparc-combined.json',
      'adrs/adr-index.json',
      'ddd/domain-model.json',
      'tdd/tdd-plan.json',
    ] as const;

    const loadedArtifacts: Record<string, unknown> = {};

    for (const filename of artifactFilenames) {
      const childSpan = createSpan(
        'phase3-validation',
        `load-${filename.replace(/\//g, '-')}`,
        { filename },
        rootSpan.spanId,
      );

      try {
        loadedArtifacts[filename] = readJson(context.phase2Dir, filename);
        const finalChild = endSpan(childSpan, 'ok', { filename });
        emitSpan(finalChild);
        context.telemetrySpans.push(finalChild);
      } catch (err: unknown) {
        const finalChild = endSpan(childSpan, 'error', {
          filename,
          error: err instanceof Error ? err.message : String(err),
        });
        emitSpan(finalChild);
        context.telemetrySpans.push(finalChild);
        throw err;
      }
    }

    // -------------------------------------------------------------------------
    // Step 3: Assemble Phase3Artifacts and mutate context
    // -------------------------------------------------------------------------
    const phase2Artifacts = {
      manifest: loadedArtifacts['phase2-manifest.json'],
      sparc: loadedArtifacts['sparc/sparc-combined.json'],
      adrs: loadedArtifacts['adrs/adr-index.json'],
      domainModel: loadedArtifacts['ddd/domain-model.json'],
      tddPlan: loadedArtifacts['tdd/tdd-plan.json'],
    };

    const phase3Artifacts: Phase3Artifacts = {
      manifest: manifestObj as unknown as Phase3Artifacts['manifest'],
      implementationLanguage: implementationLanguage as Phase3Artifacts['implementationLanguage'],
      projectDir: join(context.phase3Dir, 'project'),
      phase2Artifacts: phase2Artifacts as Phase3Artifacts['phase2Artifacts'],
    };

    // Mutate context to store the loaded artifacts
    (context as unknown as Record<string, unknown>)['phase3Artifacts'] = phase3Artifacts;

    // -------------------------------------------------------------------------
    // Step 4: Build and return stage output
    // -------------------------------------------------------------------------
    const finalRootSpan = endSpan(rootSpan, 'ok', {
      artifactsLoaded: artifactFilenames.length,
      implementationLanguage,
      schemaVersion: '3.0.0',
    });
    emitSpan(finalRootSpan);
    context.telemetrySpans.push(finalRootSpan);

    const timing = finalRootSpan.durationMs ?? 0;

    const output: Phase4StageOutput = {
      stage: 'phase3-validation',
      status: 'completed',
      data: phase3Artifacts,
      artifacts: artifactFilenames.map((f) => join(context.phase2Dir, f)),
      timing,
      summary:
        `  [OK] Loaded Phase 3 manifest (schema_version=3.0.0, success=true) ` +
        `and ${artifactFilenames.length} Phase 2 artifacts ` +
        `(language=${implementationLanguage}) in ${timing}ms`,
    };

    context.stageOutputs.set('phase3-validation', output);
    return output;
  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : String(err);

    const finalRootSpan = endSpan(rootSpan, 'error', { error: errorMessage });
    emitSpan(finalRootSpan);
    context.telemetrySpans.push(finalRootSpan);

    const timing = finalRootSpan.durationMs ?? 0;

    const output: Phase4StageOutput = {
      stage: 'phase3-validation',
      status: 'failed',
      data: { error: errorMessage },
      artifacts: [],
      timing,
      summary: `  [FAIL] Phase 3 artifact validation failed: ${errorMessage}`,
    };

    context.stageOutputs.set('phase3-validation', output);
    return output;
  }
}
