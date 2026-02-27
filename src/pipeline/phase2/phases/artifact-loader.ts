/**
 * Phase 2 Pipeline — Stage 1: Artifact Loader
 *
 * Loads and validates all 6 Phase 1 simulation artifacts from the run
 * directory on disk. Each JSON file is parsed and validated against its
 * Zod schema; markdown files are read as plain strings.
 *
 * Error codes:
 *   ECLI-P2-001  Required phase1 artifact missing
 *   ECLI-P2-002  Phase1 artifact parse / validation failed
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { z } from 'zod';

import type { Phase1Artifacts, Phase2Context, Phase2StageOutput } from '../types.js';
import {
  Phase1ManifestSchema,
  ScenarioArtifactSchema,
  RoadmapArtifactSchema,
  RiskAssessmentArtifactSchema,
} from '../schemas.js';
import { createSpan, endSpan, emitSpan } from '../telemetry.js';

// ============================================================================
// Helper: read + parse + validate a single JSON artifact
// ============================================================================

/**
 * Read a JSON file from `dir`, parse it, and validate against `schema`.
 *
 * @param dir      - Directory containing the artifact
 * @param filename - Name of the JSON file
 * @param schema   - Zod schema to validate the parsed object
 * @returns The validated object
 * @throws Error with ECLI-P2-001 if the file does not exist
 * @throws Error with ECLI-P2-002 if JSON parsing or Zod validation fails
 */
function readJsonArtifact<T>(dir: string, filename: string, schema: z.ZodType<T>): T {
  const filepath = path.join(dir, filename);

  if (!fs.existsSync(filepath)) {
    throw new Error(
      `ECLI-P2-001: Required phase1 artifact missing: ${filename} in ${dir}`,
    );
  }

  let raw: string;
  try {
    raw = fs.readFileSync(filepath, 'utf-8');
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `ECLI-P2-002: Phase1 artifact validation failed: ${filename}: ${message}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `ECLI-P2-002: Phase1 artifact validation failed: ${filename}: JSON parse error: ${message}`,
    );
  }

  try {
    return schema.parse(parsed);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `ECLI-P2-002: Phase1 artifact validation failed: ${filename}: ${message}`,
    );
  }
}

// ============================================================================
// Helper: read a plain-text (markdown) artifact
// ============================================================================

/**
 * Read a markdown file from `dir` as a UTF-8 string.
 *
 * @param dir      - Directory containing the artifact
 * @param filename - Name of the markdown file
 * @returns The file contents as a string
 * @throws Error with ECLI-P2-001 if the file does not exist
 */
function readMarkdownArtifact(dir: string, filename: string): string {
  const filepath = path.join(dir, filename);

  if (!fs.existsSync(filepath)) {
    throw new Error(
      `ECLI-P2-001: Required phase1 artifact missing: ${filename} in ${dir}`,
    );
  }

  return fs.readFileSync(filepath, 'utf-8');
}

// ============================================================================
// Artifact file descriptors
// ============================================================================

interface JsonArtifactDescriptor {
  readonly filename: string;
  readonly key: keyof Phase1Artifacts;
  readonly kind: 'json';
  readonly schema: z.ZodType<unknown>;
}

interface MarkdownArtifactDescriptor {
  readonly filename: string;
  readonly key: keyof Phase1Artifacts;
  readonly kind: 'markdown';
}

type ArtifactDescriptor = JsonArtifactDescriptor | MarkdownArtifactDescriptor;

const ARTIFACT_DESCRIPTORS: readonly ArtifactDescriptor[] = [
  { filename: 'manifest.json', key: 'manifest', kind: 'json', schema: Phase1ManifestSchema },
  { filename: 'scenario.json', key: 'scenario', kind: 'json', schema: ScenarioArtifactSchema },
  { filename: 'roadmap.json', key: 'roadmap', kind: 'json', schema: RoadmapArtifactSchema },
  { filename: 'executive-summary.md', key: 'executiveSummary', kind: 'markdown' },
  { filename: 'risk-assessment.json', key: 'riskAssessment', kind: 'json', schema: RiskAssessmentArtifactSchema },
  { filename: 'decision-memo.md', key: 'decisionMemo', kind: 'markdown' },
] as const;

// ============================================================================
// Main: loadPhase1Artifacts
// ============================================================================

/**
 * Load and validate all 6 Phase 1 artifacts from disk.
 *
 * Creates telemetry spans for overall loading and per-file operations.
 * On success, stores the assembled {@link Phase1Artifacts} on `context.phase1Artifacts`
 * and returns a completed {@link Phase2StageOutput}. On failure, returns a
 * failed output with the error message.
 *
 * @param context - The mutable Phase 2 pipeline context
 * @returns Stage output describing success or failure
 */
export async function loadPhase1Artifacts(
  context: Phase2Context,
): Promise<Phase2StageOutput> {
  const rootSpan = createSpan('artifact-loading', 'load-all', {
    phase1Dir: context.phase1Dir,
    artifactCount: ARTIFACT_DESCRIPTORS.length,
  });

  try {
    const artifacts: Record<string, unknown> = {};
    const loadedFilenames: string[] = [];

    for (const descriptor of ARTIFACT_DESCRIPTORS) {
      const childSpan = createSpan(
        'artifact-loading',
        `load-${descriptor.filename}`,
        { filename: descriptor.filename, kind: descriptor.kind },
        rootSpan.spanId,
      );

      try {
        if (descriptor.kind === 'json') {
          artifacts[descriptor.key] = readJsonArtifact(
            context.phase1Dir,
            descriptor.filename,
            descriptor.schema,
          );
        } else {
          artifacts[descriptor.key] = readMarkdownArtifact(
            context.phase1Dir,
            descriptor.filename,
          );
        }

        loadedFilenames.push(descriptor.filename);
        endSpan(childSpan, 'ok', { filename: descriptor.filename });
      } catch (err: unknown) {
        endSpan(childSpan, 'error', {
          filename: descriptor.filename,
          error: err instanceof Error ? err.message : String(err),
        });
        emitSpan(childSpan);
        throw err;
      }

      emitSpan(childSpan);
    }

    const phase1Artifacts = artifacts as unknown as Phase1Artifacts;

    // Store artifacts on the mutable context.
    // Phase2Context declares phase1Artifacts as readonly for downstream consumers,
    // but the loader is responsible for the initial assignment.
    (context as { phase1Artifacts: Phase1Artifacts }).phase1Artifacts = phase1Artifacts;

    endSpan(rootSpan, 'ok', { filesLoaded: loadedFilenames.length });
    emitSpan(rootSpan);

    const timing = rootSpan.durationMs ?? 0;

    const output: Phase2StageOutput = {
      stage: 'artifact-loading',
      status: 'completed',
      data: phase1Artifacts,
      artifacts: loadedFilenames,
      timing,
      summary: `Loaded and validated ${loadedFilenames.length} phase1 artifacts from ${context.phase1Dir} in ${timing}ms`,
    };

    context.stageOutputs.set('artifact-loading', output);

    return output;
  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : String(err);

    endSpan(rootSpan, 'error', { error: errorMessage });
    emitSpan(rootSpan);

    const timing = rootSpan.durationMs ?? 0;

    const output: Phase2StageOutput = {
      stage: 'artifact-loading',
      status: 'failed',
      data: { error: errorMessage },
      artifacts: [],
      timing,
      summary: `Artifact loading failed: ${errorMessage}`,
    };

    context.stageOutputs.set('artifact-loading', output);

    return output;
  }
}
