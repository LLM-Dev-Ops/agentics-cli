/**
 * Phase 3 SPARC Manifest Writer
 *
 * Walks the phase3/ directory tree, computes SHA-256 checksums for every file,
 * and writes phase3-manifest.json with full artifact inventory.
 *
 * Follows the atomic write + checksum pattern from
 * src/pipeline/phase2/manifest-writer.ts
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import type { Phase3SPARCManifest, Phase3SPARCManifestArtifact, Phase3SPARCStage } from './types.js';
import type { Phase2StageOutput } from '../phase2/types.js';

// ============================================================================
// Constants
// ============================================================================

const FILE_MODE = 0o600;
const MANIFEST_FILENAME = 'phase3-manifest.json';

// ============================================================================
// Helpers
// ============================================================================

/**
 * Compute a SHA-256 hex digest of the given string content.
 *
 * @param content - UTF-8 string to hash
 * @returns Lowercase hex SHA-256 checksum
 */
function computeChecksum(content: string): string {
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
function collectArtifacts(dir: string, baseDir: string): Phase3SPARCManifestArtifact[] {
  const artifacts: Phase3SPARCManifestArtifact[] = [];

  if (!fs.existsSync(dir)) return artifacts;

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      artifacts.push(...collectArtifacts(fullPath, baseDir));
    } else if (entry.isFile()) {
      const relativePath = path.relative(baseDir, fullPath);

      // Exclude the manifest itself -- it is written after this runs
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
 * Build and atomically write the phase3 manifest to `phase3-manifest.json`.
 *
 * Walks the phase3 output directory, checksums every artifact, and produces
 * a manifest with full provenance (trace id, stage results, timing, and
 * per-file SHA-256 hashes).
 *
 * @param phase3Dir    - Root output directory for phase3 artifacts
 * @param traceId      - Trace identifier linking phases
 * @param stageResults - Outputs from each completed phase3 stage
 * @param totalTiming  - Wall-clock milliseconds for the entire phase3 run
 * @returns The fully-populated manifest object
 */
export function writePhase3SPARCManifest(
  phase3Dir: string,
  traceId: string,
  stageResults: Phase2StageOutput[],
  totalTiming: number,
): Phase3SPARCManifest {
  const artifacts = collectArtifacts(phase3Dir, phase3Dir);

  const stages = stageResults.map((r) => ({
    stage: r.stage as Phase3SPARCStage,
    status: r.status,
    timing_ms: r.timing,
    artifact_count: r.artifacts.length,
  }));

  const manifest: Phase3SPARCManifest = {
    schema_version: '3.0.0',
    trace_id: traceId,
    generated_at: new Date().toISOString(),
    pipeline_version: '1.0.0',
    stages,
    artifacts,
    total_timing_ms: totalTiming,
    success: stageResults.every((s) => s.status === 'completed'),
  };

  const content = JSON.stringify(manifest, null, 2);
  const manifestPath = path.join(phase3Dir, MANIFEST_FILENAME);
  atomicWriteFile(manifestPath, content);

  return manifest;
}
