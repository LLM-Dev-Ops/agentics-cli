/**
 * Platform Repo Resolver — Unit Tests
 *
 * Tests the git-based platform repository registry, SHA resolution,
 * cache management, lock file I/O, and error handling.
 *
 * All git operations are mocked via child_process. File system operations
 * use a temp directory to avoid touching the real cache.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as child_process from 'node:child_process';

// ============================================================================
// Mock REPO_CACHE_ROOT before importing the module under test
// ============================================================================

let TEST_CACHE_ROOT: string;

jest.mock('../../../src/agents/repo-agent-runner.js', () => ({
  get REPO_CACHE_ROOT() { return TEST_CACHE_ROOT; },
}));

jest.mock('node:child_process');

const mockedExecSync = child_process.execSync as jest.MockedFunction<typeof child_process.execSync>;

import {
  PLATFORM_REPOS,
  readLockFile,
  writeLockFile,
  resolveSHA,
  resolveAllPlatformRepos,
} from '../../../src/deps/platform-repo-resolver.js';
import type { PlatformRepoLock } from '../../../src/deps/platform-repo-resolver.js';
import { MissingSHAError } from '../../../src/deps/repo-errors.js';
import { RepoNotCachedError } from '../../../src/deps/repo-errors.js';
import { SHAMismatchError } from '../../../src/deps/repo-errors.js';
import { RepoFetchError } from '../../../src/deps/repo-errors.js';

// ============================================================================
// Helpers
// ============================================================================

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'repo-test-'));
}

function removeTempDir(dir: string): void {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
}

function writeLockEntry(repoName: string, sha: string): void {
  const lock = readLockFile();
  lock[repoName] = {
    sha,
    url: PLATFORM_REPOS[repoName]!.url,
    cached_at: new Date().toISOString(),
  };
  writeLockFile(lock);
}

// ============================================================================
// Test Lifecycle
// ============================================================================

beforeEach(() => {
  TEST_CACHE_ROOT = createTempDir();
  mockedExecSync.mockReset();
});

afterEach(() => {
  removeTempDir(TEST_CACHE_ROOT);
});

// ============================================================================
// 1. Registry Tests
// ============================================================================

describe('PLATFORM_REPOS registry', () => {
  it('should contain exactly 3 repos', () => {
    expect(Object.keys(PLATFORM_REPOS)).toHaveLength(3);
  });

  it('should include agentics-contracts', () => {
    expect(PLATFORM_REPOS['agentics-contracts']).toBeDefined();
    expect(PLATFORM_REPOS['agentics-contracts']!.url).toBe(
      'https://github.com/LLM-Dev-Ops/agentics-contracts',
    );
    expect(PLATFORM_REPOS['agentics-contracts']!.cliFlag).toBe('contracts-sha');
  });

  it('should include infra', () => {
    expect(PLATFORM_REPOS['infra']).toBeDefined();
    expect(PLATFORM_REPOS['infra']!.url).toBe(
      'https://github.com/LLM-Dev-Ops/infra',
    );
    expect(PLATFORM_REPOS['infra']!.cliFlag).toBe('infra-sha');
  });

  it('should include integrations', () => {
    expect(PLATFORM_REPOS['integrations']).toBeDefined();
    expect(PLATFORM_REPOS['integrations']!.url).toBe(
      'https://github.com/LLM-Dev-Ops/integrations',
    );
    expect(PLATFORM_REPOS['integrations']!.cliFlag).toBe('integrations-sha');
  });

  it('should have URLs under LLM-Dev-Ops org', () => {
    for (const name of Object.keys(PLATFORM_REPOS)) {
      expect(PLATFORM_REPOS[name]!.url).toMatch(/^https:\/\/github\.com\/LLM-Dev-Ops\//);
    }
  });
});

// ============================================================================
// 2. SHA Resolution
// ============================================================================

describe('resolveSHA', () => {
  it('should use CLI flag SHA when provided', () => {
    const sha = resolveSHA(
      'infra',
      { 'infra-sha': 'abc123def456' },
      {},
    );
    expect(sha).toBe('abc123def456');
  });

  it('should fall back to lock file when no CLI flag', () => {
    const lock: PlatformRepoLock = {
      'infra': { sha: 'locked-sha-789', url: '', cached_at: '' },
    };
    const sha = resolveSHA('infra', {}, lock);
    expect(sha).toBe('locked-sha-789');
  });

  it('should prefer CLI flag over lock file', () => {
    const lock: PlatformRepoLock = {
      'infra': { sha: 'locked-sha-789', url: '', cached_at: '' },
    };
    const sha = resolveSHA('infra', { 'infra-sha': 'cli-sha-abc' }, lock);
    expect(sha).toBe('cli-sha-abc');
  });

  it('should throw ECLI-DEP-001 when no SHA available', () => {
    expect(() => resolveSHA('infra', {}, {})).toThrow(MissingSHAError);
    try {
      resolveSHA('integrations', {}, {});
    } catch (err) {
      expect(err).toBeInstanceOf(MissingSHAError);
      expect((err as MissingSHAError).code).toBe('ECLI-DEP-001');
    }
  });

  it('should resolve agentics-contracts via contracts-sha flag', () => {
    const sha = resolveSHA(
      'agentics-contracts',
      { 'contracts-sha': 'contract-sha-xyz' },
      {},
    );
    expect(sha).toBe('contract-sha-xyz');
  });
});

// ============================================================================
// 3. Lock File I/O
// ============================================================================

describe('lock file', () => {
  it('should return empty object when lock file does not exist', () => {
    const lock = readLockFile();
    expect(lock).toEqual({});
  });

  it('should round-trip a lock file', () => {
    const original: PlatformRepoLock = {
      'infra': {
        sha: 'abc123',
        url: 'https://github.com/LLM-Dev-Ops/infra',
        cached_at: '2025-01-01T00:00:00.000Z',
      },
    };
    writeLockFile(original);
    const loaded = readLockFile();
    expect(loaded).toEqual(original);
  });

  it('should preserve entries for other repos when updating one', () => {
    const initial: PlatformRepoLock = {
      'infra': { sha: 'sha1', url: 'url1', cached_at: 't1' },
      'integrations': { sha: 'sha2', url: 'url2', cached_at: 't2' },
    };
    writeLockFile(initial);

    const lock = readLockFile();
    lock['agentics-contracts'] = { sha: 'sha3', url: 'url3', cached_at: 't3' };
    writeLockFile(lock);

    const final = readLockFile();
    expect(final['infra']?.sha).toBe('sha1');
    expect(final['integrations']?.sha).toBe('sha2');
    expect(final['agentics-contracts']?.sha).toBe('sha3');
  });

  it('should store lock file in the repo cache root', () => {
    writeLockFile({ 'infra': { sha: 'x', url: 'y', cached_at: 'z' } });
    const lockPath = path.join(TEST_CACHE_ROOT, 'platform-repos.lock.json');
    expect(fs.existsSync(lockPath)).toBe(true);
  });
});

// ============================================================================
// 4. Cache Behavior (offline)
// ============================================================================

describe('offline mode', () => {
  it('should work when all repos are cached with correct SHAs', () => {
    const sha = 'a'.repeat(40);

    // Seed all 3 repos as cached
    for (const repoName of Object.keys(PLATFORM_REPOS)) {
      const repoDir = path.join(TEST_CACHE_ROOT, repoName);
      fs.mkdirSync(path.join(repoDir, '.git'), { recursive: true });
    }

    // Mock git rev-parse HEAD to return our SHA
    mockedExecSync.mockImplementation((cmd: string) => {
      if (typeof cmd === 'string' && cmd.includes('rev-parse HEAD')) {
        return Buffer.from(sha + '\n');
      }
      return Buffer.from('');
    });

    // Write lock file with all 3 repos
    const lock: PlatformRepoLock = {};
    for (const name of Object.keys(PLATFORM_REPOS)) {
      lock[name] = { sha, url: PLATFORM_REPOS[name]!.url, cached_at: new Date().toISOString() };
    }
    writeLockFile(lock);

    const result = resolveAllPlatformRepos({}, {});

    expect(Object.keys(result)).toHaveLength(3);
    for (const name of Object.keys(result)) {
      expect(result[name]!.sha).toBe(sha);
      expect(result[name]!.path).toBe(path.join(TEST_CACHE_ROOT, name));
    }

    // Verify no clone/fetch commands were issued
    const gitCalls = mockedExecSync.mock.calls
      .map(c => String(c[0]))
      .filter(cmd => cmd.includes('git clone') || cmd.includes('git fetch'));
    expect(gitCalls).toHaveLength(0);
  });
});

// ============================================================================
// 5. Missing Cache (ECLI-DEP-002)
// ============================================================================

describe('repo not cached', () => {
  it('should throw ECLI-DEP-002 when not cached and no --fetch-deps', () => {
    const sha = 'b'.repeat(40);
    writeLockEntry('infra', sha);

    // infra is not seeded in cache, so resolution should fail
    expect(() => {
      resolveAllPlatformRepos(
        { 'contracts-sha': sha, 'integrations-sha': sha },
        {},
      );
    }).toThrow(RepoNotCachedError);
  });

  it('should include ECLI-DEP-002 code', () => {
    try {
      resolveAllPlatformRepos(
        { 'contracts-sha': 'x', 'infra-sha': 'y', 'integrations-sha': 'z' },
        {},
      );
    } catch (err) {
      expect(err).toBeInstanceOf(RepoNotCachedError);
      expect((err as RepoNotCachedError).code).toBe('ECLI-DEP-002');
    }
  });
});

// ============================================================================
// 6. SHA Mismatch (ECLI-DEP-004)
// ============================================================================

describe('SHA mismatch', () => {
  it('should throw ECLI-DEP-004 when cached SHA differs and no --fetch-deps', () => {
    const expectedSha = 'c'.repeat(40);
    const cachedSha = 'd'.repeat(40);

    // Seed all repos
    for (const repoName of Object.keys(PLATFORM_REPOS)) {
      const repoDir = path.join(TEST_CACHE_ROOT, repoName);
      fs.mkdirSync(path.join(repoDir, '.git'), { recursive: true });
    }

    // Mock HEAD to return a different SHA
    mockedExecSync.mockImplementation((cmd: string) => {
      if (typeof cmd === 'string' && cmd.includes('rev-parse HEAD')) {
        return Buffer.from(cachedSha + '\n');
      }
      return Buffer.from('');
    });

    expect(() => {
      resolveAllPlatformRepos(
        { 'contracts-sha': expectedSha, 'infra-sha': expectedSha, 'integrations-sha': expectedSha },
        {},
      );
    }).toThrow(SHAMismatchError);
  });
});

// ============================================================================
// 7. Fetch with --fetch-deps (ECLI-DEP-003)
// ============================================================================

describe('fetch with --fetch-deps', () => {
  it('should clone repos when --fetch-deps and not cached', () => {
    const sha = 'e'.repeat(40);

    // After clone, mock that .git exists and HEAD returns correct SHA
    let cloneCount = 0;
    mockedExecSync.mockImplementation((cmd: string) => {
      const cmdStr = typeof cmd === 'string' ? cmd : '';

      if (cmdStr.includes('git clone')) {
        // Simulate clone by creating .git dir
        const parts = cmdStr.split(' ');
        const targetDir = parts[parts.length - 1];
        if (targetDir) {
          fs.mkdirSync(path.join(targetDir, '.git'), { recursive: true });
        }
        cloneCount++;
        return Buffer.from('');
      }

      if (cmdStr.includes('rev-parse HEAD')) {
        return Buffer.from(sha + '\n');
      }

      if (cmdStr.includes('checkout')) {
        return Buffer.from('');
      }

      return Buffer.from('');
    });

    const result = resolveAllPlatformRepos(
      { 'contracts-sha': sha, 'infra-sha': sha, 'integrations-sha': sha },
      { 'fetch-deps': true },
    );

    expect(cloneCount).toBe(3);
    expect(Object.keys(result)).toHaveLength(3);
  });

  it('should throw ECLI-DEP-003 when git clone fails', () => {
    mockedExecSync.mockImplementation((cmd: string) => {
      if (typeof cmd === 'string' && cmd.includes('git clone')) {
        throw new Error('fatal: repository not found');
      }
      return Buffer.from('');
    });

    expect(() => {
      resolveAllPlatformRepos(
        { 'contracts-sha': 'f'.repeat(40), 'infra-sha': 'f'.repeat(40), 'integrations-sha': 'f'.repeat(40) },
        { 'fetch-deps': true },
      );
    }).toThrow(RepoFetchError);
  });

  it('should fetch and checkout when cached SHA mismatches with --fetch-deps', () => {
    const oldSha = 'g'.repeat(40);
    const newSha = 'h'.repeat(40);

    // Seed all repos with old SHA
    for (const repoName of Object.keys(PLATFORM_REPOS)) {
      const repoDir = path.join(TEST_CACHE_ROOT, repoName);
      fs.mkdirSync(path.join(repoDir, '.git'), { recursive: true });
    }

    let fetchCount = 0;
    let revParseCallCount = 0;
    mockedExecSync.mockImplementation((cmd: string) => {
      const cmdStr = typeof cmd === 'string' ? cmd : '';

      if (cmdStr.includes('rev-parse HEAD')) {
        revParseCallCount++;
        // First call per repo returns old SHA (pre-fetch check),
        // subsequent calls return new SHA (post-checkout verification)
        // Each repo gets called twice: once in ensureRepoCached, once in verifyIntegrity
        // For the first call (check), return old SHA. For second (verify), return new.
        // Pattern: odd calls = old SHA, even calls = new SHA per repo
        if (revParseCallCount % 2 === 1) {
          return Buffer.from(oldSha + '\n');
        }
        return Buffer.from(newSha + '\n');
      }

      if (cmdStr.includes('git fetch') || cmdStr.includes('git -C')) {
        if (cmdStr.includes('fetch origin')) {
          fetchCount++;
        }
        return Buffer.from('');
      }

      return Buffer.from('');
    });

    const result = resolveAllPlatformRepos(
      { 'contracts-sha': newSha, 'infra-sha': newSha, 'integrations-sha': newSha },
      { 'fetch-deps': true },
    );

    expect(fetchCount).toBe(3);
    expect(Object.keys(result)).toHaveLength(3);
  });
});

// ============================================================================
// 8. Error Code Validation
// ============================================================================

describe('error codes', () => {
  it('MissingSHAError should have code ECLI-DEP-001', () => {
    const err = new MissingSHAError('infra');
    expect(err.code).toBe('ECLI-DEP-001');
    expect(err.name).toBe('MissingSHAError');
  });

  it('RepoNotCachedError should have code ECLI-DEP-002', () => {
    const err = new RepoNotCachedError('infra', 'abc123');
    expect(err.code).toBe('ECLI-DEP-002');
    expect(err.name).toBe('RepoNotCachedError');
  });

  it('RepoFetchError should have code ECLI-DEP-003', () => {
    const err = new RepoFetchError('infra', 'https://example.com', 'timeout');
    expect(err.code).toBe('ECLI-DEP-003');
    expect(err.name).toBe('RepoFetchError');
  });

  it('SHAMismatchError should have code ECLI-DEP-004', () => {
    const err = new SHAMismatchError('infra', 'expected', 'actual');
    expect(err.code).toBe('ECLI-DEP-004');
    expect(err.name).toBe('SHAMismatchError');
  });
});
