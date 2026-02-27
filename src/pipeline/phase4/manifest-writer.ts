/**
 * Phase 4 Manifest Writer
 *
 * Walks the phase4/ directory tree, computes SHA-256 checksums for every file,
 * and writes phase4-manifest.json with full artifact inventory.
 *
 * Follows the atomic write + checksum pattern from
 * src/pipeline/phase3/manifest-writer.ts, adapted for Phase 4 fields:
 *   - schema_version: '4.0.0'
 *   - erp_system, database_engine, api_only, implementation_language
 *   - success (derived from stage results)
 *
 * Exports:
 *   - computeChecksum()     — pure SHA-256 hex digest helper
 *   - writePhase4Manifest() — builds and atomically writes the manifest
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import type {
  ImplementationLanguage,
  Phase4StageOutput,
  Phase4Manifest,
  Phase4ManifestArtifact,
} from './types.js';

// ============================================================================
// Constants
// ============================================================================

const FILE_MODE = 0o600;
const MANIFEST_FILENAME = 'phase4-manifest.json';

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
function collectArtifacts(dir: string, baseDir: string): Phase4ManifestArtifact[] {
  const artifacts: Phase4ManifestArtifact[] = [];

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
 * Build and atomically write the Phase 4 manifest to `phase4-manifest.json`.
 *
 * Walks the Phase 4 output directory, checksums every artifact, and produces
 * a manifest with full provenance (trace id, implementation language, ERP
 * system, database engine, api-only flag, stage results, timing, and
 * per-file SHA-256 hashes).
 *
 * @param phase4Dir      - Root output directory for Phase 4 artifacts
 * @param traceId        - Trace identifier linking pipeline phases
 * @param language       - The resolved implementation language
 * @param erpSystem      - The resolved ERP system identifier
 * @param databaseEngine - The resolved database engine identifier, or null
 * @param apiOnly        - Whether the ERP system is accessed via API only
 * @param stageResults   - Outputs from each completed Phase 4 stage
 * @param totalTiming    - Wall-clock milliseconds for the entire Phase 4 run
 * @returns The fully-populated manifest object
 */
export function writePhase4Manifest(
  phase4Dir: string,
  traceId: string,
  language: ImplementationLanguage,
  erpSystem: string,
  databaseEngine: string | null,
  apiOnly: boolean,
  stageResults: Phase4StageOutput[],
  totalTiming: number,
): Phase4Manifest {
  const artifacts = collectArtifacts(phase4Dir, phase4Dir);

  const allCompleted = stageResults.every((r) => r.status === 'completed');

  const manifest: Phase4Manifest = {
    schema_version: '4.0.0',
    trace_id: traceId,
    implementation_language: language,
    erp_system: erpSystem,
    database_engine: databaseEngine,
    api_only: apiOnly,
    artifacts,
    total_timing_ms: totalTiming,
    success: allCompleted,
  };

  const content = JSON.stringify(manifest, null, 2);
  const manifestPath = path.join(phase4Dir, MANIFEST_FILENAME);
  atomicWriteFile(manifestPath, content);

  return manifest;
}
