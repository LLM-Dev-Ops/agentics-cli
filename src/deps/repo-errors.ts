/**
 * Platform Repository Dependency Errors
 *
 * Error classes for git-based platform repo resolution:
 *   ECLI-DEP-001  Missing pinned SHA (no CLI flag and no lock entry)
 *   ECLI-DEP-002  Repo not cached and --fetch-deps not provided
 *   ECLI-DEP-003  Git clone or fetch failed
 *   ECLI-DEP-004  Cached commit SHA does not match expected SHA
 */

import { CLIError } from '../errors/index.js';

// ============================================================================
// ECLI-DEP-001: Missing Pinned SHA
// ============================================================================

export class MissingSHAError extends CLIError {
  constructor(repoName: string) {
    super({
      code: 'ECLI-DEP-001',
      category: 'CONFIG_ERROR',
      message:
        `No pinned SHA for platform repo '${repoName}'. ` +
        `Provide --${repoName === 'agentics-contracts' ? 'contracts' : repoName}-sha <sha> ` +
        `or add an entry to the lock file.`,
      details: { repo: repoName },
      module: 'deps',
      recoverable: false,
      exitCode: 78,
    });
    this.name = 'MissingSHAError';
  }
}

// ============================================================================
// ECLI-DEP-002: Repo Not Cached
// ============================================================================

export class RepoNotCachedError extends CLIError {
  constructor(repoName: string, sha: string) {
    super({
      code: 'ECLI-DEP-002',
      category: 'CONFIG_ERROR',
      message:
        `Platform repo '${repoName}' (${sha.slice(0, 12)}) is not cached. ` +
        `Run with --fetch-deps to clone it.`,
      details: { repo: repoName, sha },
      module: 'deps',
      recoverable: false,
      exitCode: 78,
    });
    this.name = 'RepoNotCachedError';
  }
}

// ============================================================================
// ECLI-DEP-003: Repo Fetch Failed
// ============================================================================

export class RepoFetchError extends CLIError {
  constructor(repoName: string, url: string, reason: string) {
    super({
      code: 'ECLI-DEP-003',
      category: 'CONFIG_ERROR',
      message:
        `Failed to fetch platform repo '${repoName}' from ${url}: ${reason}`,
      details: { repo: repoName, url },
      module: 'deps',
      recoverable: false,
      exitCode: 78,
    });
    this.name = 'RepoFetchError';
  }
}

// ============================================================================
// ECLI-DEP-004: Commit SHA Mismatch
// ============================================================================

export class SHAMismatchError extends CLIError {
  constructor(repoName: string, expected: string, actual: string) {
    super({
      code: 'ECLI-DEP-004',
      category: 'CONFIG_ERROR',
      message:
        `Commit SHA mismatch for platform repo '${repoName}': ` +
        `expected ${expected.slice(0, 12)}, got ${actual.slice(0, 12)}. ` +
        `Run with --fetch-deps to update.`,
      details: { repo: repoName, expected, actual },
      module: 'deps',
      recoverable: false,
      exitCode: 78,
    });
    this.name = 'SHAMismatchError';
  }
}
