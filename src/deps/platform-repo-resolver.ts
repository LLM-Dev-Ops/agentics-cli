/**
 * Platform Repository Resolver
 *
 * Extends the existing repo cache system (same ~/.agentics/repo-cache/ root)
 * to support git-based platform repositories with explicit commit SHA pinning.
 *
 * Resolution order:
 *   1. CLI flag (--contracts-sha, --infra-sha, --integrations-sha)
 *   2. Lock file entry (~/.agentics/repo-cache/platform-repos.lock.json)
 *   3. Fail deterministically (ECLI-DEP-001)
 *
 * Repos are cloned/fetched only when --fetch-deps is provided.
 * Integrity is verified by matching git HEAD against the expected SHA.
 *
 * No floating branch references. No silent fetching. Offline-first.
 */

import { execSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_CACHE_ROOT } from '../agents/repo-agent-runner.js';
import {
  MissingSHAError,
  RepoNotCachedError,
  RepoFetchError,
  SHAMismatchError,
} from './repo-errors.js';

// ============================================================================
// Registry
// ============================================================================

export interface PlatformRepoEntry {
  readonly url: string;
  readonly cliFlag: string;
}

/**
 * Platform repository registry. Each entry maps a repo name to its
 * GitHub URL and the CLI flag used to provide a pinned SHA.
 */
export const PLATFORM_REPOS: Readonly<Record<string, PlatformRepoEntry>> = {
  'agentics-contracts': {
    url: 'https://github.com/LLM-Dev-Ops/agentics-contracts',
    cliFlag: 'contracts-sha',
  },
  'infra': {
    url: 'https://github.com/LLM-Dev-Ops/infra',
    cliFlag: 'infra-sha',
  },
  'integrations': {
    url: 'https://github.com/LLM-Dev-Ops/integrations',
    cliFlag: 'integrations-sha',
  },
  'erp-surface': {
    url: 'https://github.com/LLM-Dev-Ops/erp-surface',
    cliFlag: 'erp-surface-sha',
  },
};

// ============================================================================
// Lock File Types
// ============================================================================

export interface LockFileEntry {
  sha: string;
  url: string;
  cached_at: string;
}

export type PlatformRepoLock = Record<string, LockFileEntry>;

const LOCK_FILENAME = 'platform-repos.lock.json';

// ============================================================================
// Lock File I/O
// ============================================================================

function getLockFilePath(): string {
  return join(REPO_CACHE_ROOT, LOCK_FILENAME);
}

export function readLockFile(): PlatformRepoLock {
  const lockPath = getLockFilePath();
  if (!existsSync(lockPath)) {
    return {};
  }
  try {
    const raw = readFileSync(lockPath, 'utf-8');
    return JSON.parse(raw) as PlatformRepoLock;
  } catch {
    return {};
  }
}

export function writeLockFile(lock: PlatformRepoLock): void {
  mkdirSync(REPO_CACHE_ROOT, { recursive: true });
  const lockPath = getLockFilePath();
  const tmpPath = `${lockPath}.tmp.${process.pid}`;
  try {
    writeFileSync(tmpPath, JSON.stringify(lock, null, 2) + '\n', {
      encoding: 'utf-8',
      mode: 0o600,
    });
    renameSync(tmpPath, lockPath);
  } catch (err: unknown) {
    try { writeFileSync(tmpPath, ''); renameSync(tmpPath, '/dev/null'); } catch { /* best-effort cleanup */ }
    throw err;
  }
}

// ============================================================================
// SHA Resolution
// ============================================================================

/**
 * Resolve the pinned commit SHA for a repo.
 *
 * Priority: CLI flag → lock file → error.
 */
export function resolveSHA(
  repoName: string,
  cliOptions: Record<string, string>,
  lock: PlatformRepoLock,
): string {
  const entry = PLATFORM_REPOS[repoName];
  if (!entry) {
    throw new Error(`Unknown platform repo: ${repoName}`);
  }

  // 1. CLI flag takes priority
  const cliSha = cliOptions[entry.cliFlag];
  if (cliSha) {
    return cliSha;
  }

  // 2. Lock file entry
  const lockEntry = lock[repoName];
  if (lockEntry?.sha) {
    return lockEntry.sha;
  }

  // 3. No SHA available
  throw new MissingSHAError(repoName);
}

// ============================================================================
// Cache Inspection
// ============================================================================

function getRepoCacheDir(repoName: string): string {
  return join(REPO_CACHE_ROOT, repoName);
}

function isRepoCached(repoName: string): boolean {
  const dir = getRepoCacheDir(repoName);
  return existsSync(join(dir, '.git'));
}

/**
 * Read the current HEAD commit SHA from a cached git repo.
 * Returns null if the repo is not cached or git fails.
 */
function getCachedSHA(repoName: string): string | null {
  const dir = getRepoCacheDir(repoName);
  if (!existsSync(join(dir, '.git'))) {
    return null;
  }
  try {
    return execSync('git rev-parse HEAD', {
      cwd: dir,
      stdio: 'pipe',
      timeout: 10_000,
    }).toString().trim();
  } catch {
    return null;
  }
}

// ============================================================================
// Fetch Logic
// ============================================================================

/**
 * Ensure a repo is cached at the expected SHA.
 *
 * - Not cached + no --fetch-deps → ECLI-DEP-002
 * - Not cached + --fetch-deps → clone + checkout
 * - Cached + SHA matches → no-op
 * - Cached + SHA mismatch + no --fetch-deps → ECLI-DEP-004
 * - Cached + SHA mismatch + --fetch-deps → fetch + checkout
 */
function ensureRepoCached(
  repoName: string,
  url: string,
  sha: string,
  fetchDeps: boolean,
): void {
  const cacheDir = getRepoCacheDir(repoName);
  const cached = isRepoCached(repoName);

  if (!cached) {
    if (!fetchDeps) {
      throw new RepoNotCachedError(repoName, sha);
    }
    cloneRepo(repoName, url, sha, cacheDir);
    return;
  }

  // Cached — verify SHA
  const currentSHA = getCachedSHA(repoName);
  if (currentSHA === sha) {
    return; // Already at correct commit
  }

  if (!fetchDeps) {
    throw new SHAMismatchError(repoName, sha, currentSHA ?? 'unknown');
  }

  // Fetch and checkout
  fetchAndCheckout(repoName, url, sha, cacheDir);
}

function cloneRepo(repoName: string, url: string, sha: string, cacheDir: string): void {
  mkdirSync(cacheDir, { recursive: true });
  try {
    execSync(`git clone ${url} ${cacheDir}`, {
      stdio: 'pipe',
      timeout: 120_000,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new RepoFetchError(repoName, url, `clone failed: ${msg}`);
  }

  try {
    execSync(`git -C ${cacheDir} checkout ${sha}`, {
      stdio: 'pipe',
      timeout: 30_000,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new RepoFetchError(repoName, url, `checkout ${sha.slice(0, 12)} failed: ${msg}`);
  }
}

function fetchAndCheckout(repoName: string, url: string, sha: string, cacheDir: string): void {
  try {
    execSync(`git -C ${cacheDir} fetch origin`, {
      stdio: 'pipe',
      timeout: 120_000,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new RepoFetchError(repoName, url, `fetch failed: ${msg}`);
  }

  try {
    execSync(`git -C ${cacheDir} checkout ${sha}`, {
      stdio: 'pipe',
      timeout: 30_000,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new RepoFetchError(repoName, url, `checkout ${sha.slice(0, 12)} failed: ${msg}`);
  }
}

// ============================================================================
// Post-fetch Integrity Check
// ============================================================================

function verifyIntegrity(repoName: string, expectedSHA: string): void {
  const actual = getCachedSHA(repoName);
  if (actual !== expectedSHA) {
    throw new SHAMismatchError(repoName, expectedSHA, actual ?? 'unknown');
  }
}

// ============================================================================
// Main Entry Point
// ============================================================================

export interface ResolvedRepo {
  path: string;
  sha: string;
}

export type ResolvedPlatformRepos = Record<string, ResolvedRepo>;

/**
 * Resolve all platform repos to local cached paths with verified SHAs.
 *
 * @param cliOptions - Parsed CLI options (e.g. `{ 'contracts-sha': 'abc123' }`)
 * @param cliFlags   - Parsed CLI flags (e.g. `{ 'fetch-deps': true }`)
 * @returns Map of repo name → { path, sha }
 */
export function resolveAllPlatformRepos(
  cliOptions: Record<string, string>,
  cliFlags: Record<string, boolean>,
): ResolvedPlatformRepos {
  const lock = readLockFile();
  const fetchDeps = cliFlags['fetch-deps'] === true;
  const result: ResolvedPlatformRepos = {};

  for (const [repoName, entry] of Object.entries(PLATFORM_REPOS)) {
    const sha = resolveSHA(repoName, cliOptions, lock);
    ensureRepoCached(repoName, entry.url, sha, fetchDeps);
    verifyIntegrity(repoName, sha);

    // Update lock file entry
    lock[repoName] = {
      sha,
      url: entry.url,
      cached_at: new Date().toISOString(),
    };

    result[repoName] = {
      path: getRepoCacheDir(repoName),
      sha,
    };
  }

  writeLockFile(lock);
  return result;
}
