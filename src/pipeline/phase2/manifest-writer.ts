/**
 * Phase2 Manifest Writer
 *
 * Walks the phase2/ directory tree, computes SHA-256 checksums for every file,
 * and writes phase2-manifest.json with full artifact inventory.
 *
 * Follows the atomic write + checksum pattern from
 * src/synthesis/simulation-artifact-generator.ts
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import type {
  Phase2StageOutput,
  Phase2Manifest,
  Phase2ManifestArtifact,
  Phase2ManifestStage,
} from './types.js';

// ============================================================================
// Constants
// ============================================================================

const FILE_MODE = 0o600;
const MANIFEST_FILENAME = 'phase2-manifest.json';

// ============================================================================
// Helpers
// ============================================================================

/**
 * Compute a SHA-256 hex digest of the given string content.
 *
 * @param content - UTF-8 string to hash
 * @returns Lowercase hex SHA-256 checksum
 */
export function computeChecksum(content: string): string {
  return crypto.createHash('sha256').update(content, 'utf-8').digest('hex');
}

/**
 * Write a file atomically via temp-then-rename. On failure the temporary
 * file is cleaned up and the error is re-thrown.
 *
 * @param filePath - Final destination path
 * @param content  - UTF-8 string content to write
 */
function atomicWriteFile(filePath: string, content: string): void {
  const tmpPath = `${filePath}.tmp.${process.pid}`;
  try {
    fs.writeFileSync(tmpPath, content, { encoding: 'utf-8', mode: FILE_MODE });
    fs.renameSync(tmpPath, filePath);
  } catch (err: unknown) {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // Best-effort cleanup; ignore failures
    }
    throw err;
  }
}

/**
 * Recursively collect all files under `dir`, computing a checksum and size
 * for each. Paths are stored relative to `baseDir`. The manifest file itself
 * is excluded since it is written after collection.
 *
 * @param dir     - Directory to walk
 * @param baseDir - Root directory for computing relative paths
 * @returns Sorted array of artifact entries
 */
function collectArtifacts(dir: string, baseDir: string): Phase2ManifestArtifact[] {
  const artifacts: Phase2ManifestArtifact[] = [];

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      artifacts.push(...collectArtifacts(fullPath, baseDir));
    } else if (entry.isFile()) {
      const relativePath = path.relative(baseDir, fullPath);

      // Exclude the manifest itself — it is written after this runs
      if (relativePath === MANIFEST_FILENAME) {
        continue;
      }

      const content = fs.readFileSync(fullPath, 'utf-8');
      artifacts.push({
        path: relativePath,
        sha256: computeChecksum(content),
        size_bytes: Buffer.byteLength(content, 'utf-8'),
      });
    }
  }

  // Sort by path for deterministic output
  artifacts.sort((a, b) => a.path.localeCompare(b.path));
  return artifacts;
}

// ============================================================================
// Main
// ============================================================================

/**
 * Build and atomically write the phase2 manifest to `phase2-manifest.json`.
 *
 * Walks the phase2 output directory, checksums every artifact, and produces
 * a manifest with full provenance (trace id, phase1 run id, stage results,
 * timing, and per-file SHA-256 hashes).
 *
 * @param phase2Dir    - Root output directory for phase2 artifacts
 * @param traceId      - Trace identifier linking phase1 and phase2
 * @param phase1RunId  - Run identifier from the preceding phase1 execution
 * @param stageResults - Outputs from each completed phase2 stage
 * @param totalTiming  - Wall-clock milliseconds for the entire phase2 run
 * @returns The fully-populated manifest object
 */
export function writePhase2Manifest(
  phase2Dir: string,
  traceId: string,
  phase1RunId: string,
  stageResults: Phase2StageOutput[],
  totalTiming: number,
): Phase2Manifest {
  const artifacts = collectArtifacts(phase2Dir, phase2Dir);

  const stages: Phase2ManifestStage[] = stageResults.map((r) => ({
    stage: r.stage,
    status: r.status,
    timing_ms: r.timing,
    artifact_count: r.artifacts.length,
  }));

  const manifest: Phase2Manifest = {
    schema_version: '2.0.0',
    trace_id: traceId,
    phase1_run_id: phase1RunId,
    generated_at: new Date().toISOString(),
    pipeline_version: '1.0.0',
    stages,
    artifacts,
    total_timing_ms: totalTiming,
    deterministic: true,
  };

  const content = JSON.stringify(manifest, null, 2);
  const manifestPath = path.join(phase2Dir, MANIFEST_FILENAME);
  atomicWriteFile(manifestPath, content);

  return manifest;
}
