/**
 * Phase 4 ADR Manifest Writer
 *
 * Walks the phase4/ directory tree, computes SHA-256 checksums for every file,
 * and writes phase4-manifest.json with full artifact inventory.
 *
 * Follows the atomic write + checksum pattern from the Phase 3 manifest writer,
 * adapted for Phase 4 fields:
 *   - schema_version: '4.0.0'
 *   - success (derived from stage results)
 *
 * Exports:
 *   - writePhase4ADRManifest() — builds and writes the manifest
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import type { Phase4ADRManifest, Phase4ADRManifestArtifact, Phase4ADRStage } from './types.js';
import type { Phase2StageOutput } from '../phase2/types.js';

// ============================================================================
// Constants
// ============================================================================

const FILE_MODE = 0o600;
const MANIFEST_FILENAME = 'phase4-manifest.json';

// ============================================================================
// Helpers
// ============================================================================

/**
 * Compute a SHA-256 hex digest of a file on disk.
 *
 * @param filePath - Absolute path to the file
 * @returns Lowercase hex SHA-256 checksum
 */
function computeChecksum(filePath: string): string {
  const content = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(content).digest('hex');
}

/**
 * Recursively collect all files under `dir`, computing a checksum and size
 * for each. Paths are stored relative to `baseDir`. The manifest file itself
 * is excluded since it is written after collection.
 *
 * @param dir  - Directory to walk
 * @param base - Root directory for computing relative paths
 * @returns Array of artifact entries
 */
function walkDir(dir: string, base: string): Phase4ADRManifestArtifact[] {
  const results: Phase4ADRManifestArtifact[] = [];
  if (!fs.existsSync(dir)) return results;

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkDir(fullPath, base));
    } else if (entry.isFile() && entry.name !== MANIFEST_FILENAME) {
      const stat = fs.statSync(fullPath);
      results.push({
        path: path.relative(base, fullPath),
        sha256: computeChecksum(fullPath),
        size_bytes: stat.size,
      });
    }
  }

  // Sort by path for deterministic output
  results.sort((a, b) => a.path.localeCompare(b.path));
  return results;
}

// ============================================================================
// Main
// ============================================================================

/**
 * Build and write the Phase 4 manifest to `phase4-manifest.json`.
 *
 * Walks the Phase 4 output directory, checksums every artifact, and produces
 * a manifest with full provenance (trace id, stage results, timing, and
 * per-file SHA-256 hashes).
 *
 * @param phase4Dir    - Root output directory for Phase 4 artifacts
 * @param traceId      - Trace identifier linking pipeline phases
 * @param stages       - Outputs from each completed Phase 4 stage
 * @param totalTimingMs - Wall-clock milliseconds for the entire Phase 4 run
 * @returns The fully-populated manifest object
 */
export function writePhase4ADRManifest(
  phase4Dir: string,
  traceId: string,
  stages: Phase2StageOutput[],
  totalTimingMs: number,
): Phase4ADRManifest {
  const artifacts = walkDir(phase4Dir, phase4Dir);

  const manifest: Phase4ADRManifest = {
    schema_version: '4.0.0',
    trace_id: traceId,
    generated_at: new Date().toISOString(),
    pipeline_version: '1.0.0',
    stages: stages.map(s => ({
      stage: s.stage as Phase4ADRStage,
      status: s.status,
      timing_ms: s.timing,
      artifact_count: s.artifacts.length,
    })),
    artifacts,
    total_timing_ms: totalTimingMs,
    success: stages.every(s => s.status === 'completed'),
  };

  const manifestPath = path.join(phase4Dir, MANIFEST_FILENAME);
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), { encoding: 'utf-8', mode: FILE_MODE });

  return manifest;
}
