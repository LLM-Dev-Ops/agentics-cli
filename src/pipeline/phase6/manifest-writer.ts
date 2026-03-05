/**
 * Phase 6 Manifest Writer
 *
 * Walks the phase6/ directory tree, computes SHA-256 checksums for every file,
 * and writes phase6-manifest.json with full artifact inventory.
 *
 * Follows the atomic write + checksum pattern from
 * src/pipeline/phase5/manifest-writer.ts, adapted for Phase 6 fields:
 *   - schema_version: '6.0.0'
 *   - erp_system, service_name, registration_id, endpoints
 *   - success (derived from stage results)
 *
 * Exports:
 *   - computeChecksum()     — pure SHA-256 hex digest helper
 *   - writePhase6Manifest() — builds and atomically writes the manifest
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import type {
  Phase6StageOutput,
  Phase6Manifest,
  Phase6ManifestArtifact,
  ERPSurfaceRegistration,
} from './types.js';

// ============================================================================
// Constants
// ============================================================================

const FILE_MODE = 0o600;
const MANIFEST_FILENAME = 'phase6-manifest.json';

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
function collectArtifacts(dir: string, baseDir: string): Phase6ManifestArtifact[] {
  const artifacts: Phase6ManifestArtifact[] = [];

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
 * Build and atomically write the Phase 6 manifest to `phase6-manifest.json`.
 *
 * Walks the Phase 6 output directory, checksums every artifact, and produces
 * a manifest with full provenance (trace id, ERP system, service registration,
 * endpoint mappings, stage results, timing, and per-file SHA-256 hashes).
 *
 * @param phase6Dir      - Root output directory for Phase 6 artifacts
 * @param traceId        - Trace identifier linking pipeline phases
 * @param erpSystem      - The resolved ERP system identifier
 * @param registration   - The ERP surface registration, or null if skipped
 * @param stageResults   - Outputs from each completed Phase 6 stage
 * @param totalTiming    - Wall-clock milliseconds for the entire Phase 6 run
 * @returns The fully-populated manifest object
 */
export function writePhase6Manifest(
  phase6Dir: string,
  traceId: string,
  erpSystem: string,
  registration: ERPSurfaceRegistration | null,
  stageResults: Phase6StageOutput[],
  totalTiming: number,
): Phase6Manifest {
  const artifacts = collectArtifacts(phase6Dir, phase6Dir);

  const allCompleted = stageResults.every((r) => r.status === 'completed');

  const manifest: Phase6Manifest = {
    schema_version: '6.0.0',
    trace_id: traceId,
    erp_system: erpSystem,
    service_name: registration?.service_name ?? 'unknown',
    registration_id: registration?.registration_id ?? 'none',
    endpoints: registration?.endpoints.map(e => ({
      method: e.method,
      path: e.path,
      erp_service: e.erp_service,
    })) ?? [],
    artifacts,
    total_timing_ms: totalTiming,
    success: allCompleted,
  };

  const content = JSON.stringify(manifest, null, 2);
  const manifestPath = path.join(phase6Dir, MANIFEST_FILENAME);
  atomicWriteFile(manifestPath, content);

  return manifest;
}
