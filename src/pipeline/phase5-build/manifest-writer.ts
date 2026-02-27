/**
 * Phase 5 Build Manifest Writer
 *
 * Walks the phase5/ directory tree, computes SHA-256 checksums for every file,
 * and writes phase5-manifest.json with full artifact inventory.
 *
 * Follows the atomic write + checksum pattern from
 * src/pipeline/phase4/manifest-writer.ts, adapted for Phase 5 Build fields:
 *   - schema_version: '5.0.0'
 *   - implementation_language, erp_system
 *   - stages array with per-stage timing
 *   - success (derived from stage results)
 *
 * Exports:
 *   - computeChecksum()            — pure SHA-256 hex digest helper
 *   - writePhase5BuildManifest()   — builds and atomically writes the manifest
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import type {
  Phase5BuildManifest,
  Phase5BuildManifestArtifact,
  Phase5BuildStage,
} from './types.js';

// ============================================================================
// Constants
// ============================================================================

const FILE_MODE = 0o600;
const MANIFEST_FILENAME = 'phase5-manifest.json';
const PIPELINE_VERSION = '5.0.0';

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
function collectArtifacts(dir: string, baseDir: string): Phase5BuildManifestArtifact[] {
  const artifacts: Phase5BuildManifestArtifact[] = [];

  if (!fs.existsSync(dir)) {
    return artifacts;
  }

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
 * Build and atomically write the Phase 5 Build manifest to `phase5-manifest.json`.
 *
 * Walks the Phase 5 output directory, checksums every artifact, and produces
 * a manifest with full provenance (trace id, implementation language, ERP system,
 * stage results, timing, and per-file SHA-256 hashes).
 *
 * @param phase5Dir              - Root output directory for Phase 5 artifacts
 * @param traceId                - Trace identifier linking pipeline phases
 * @param implementationLanguage - The resolved implementation language
 * @param erpSystem              - The resolved ERP system identifier
 * @param stageResults           - Outputs from each completed Phase 5 stage
 * @param totalTiming            - Wall-clock milliseconds for the entire Phase 5 run
 * @returns The fully-populated manifest object
 */
export function writePhase5BuildManifest(
  phase5Dir: string,
  traceId: string,
  implementationLanguage: string,
  erpSystem: string,
  stageResults: ReadonlyArray<{
    stage: Phase5BuildStage;
    status: 'completed' | 'failed';
    timing: number;
    artifacts: string[];
    summary: string;
  }>,
  totalTiming: number,
): Phase5BuildManifest {
  const artifacts = collectArtifacts(phase5Dir, phase5Dir);

  const allCompleted = stageResults.every((r) => r.status === 'completed');

  const manifest: Phase5BuildManifest = {
    schema_version: '5.0.0',
    trace_id: traceId,
    generated_at: new Date().toISOString(),
    pipeline_version: PIPELINE_VERSION,
    implementation_language: implementationLanguage,
    erp_system: erpSystem,
    stages: stageResults.map((r) => ({
      stage: r.stage,
      status: r.status,
      timing_ms: r.timing,
      artifact_count: r.artifacts.length,
    })),
    artifacts,
    total_timing_ms: totalTiming,
    success: allCompleted,
  };

  const content = JSON.stringify(manifest, null, 2);
  const manifestPath = path.join(phase5Dir, MANIFEST_FILENAME);
  atomicWriteFile(manifestPath, content);

  return manifest;
}
