/**
 * Execution Context Detection
 *
 * Detects whether the CLI is running inside the agentics-cli development
 * repository (MODE 1: Development) or an end-user project repository
 * (MODE 2: Project). Routes MVP materialization accordingly:
 *
 *   Development mode: Sandbox/ephemeral — no git mutations, output only in ~/.agentics/runs/
 *   Project mode:     GitOps branch-per-simulation — creates scenario branch, commits MVP, returns to original branch
 *
 * Detection precedence:
 *   1. AGENTICS_EXECUTION_MODE env var ('development' | 'project')
 *   2. Git remote URL or repo directory name containing "agentics-cli"
 */

import { execSync } from 'node:child_process';
import { CLIError } from '../errors/index.js';

// ============================================================================
// Types
// ============================================================================

export type ExecutionMode = 'development' | 'project';

export interface ExecutionContext {
  readonly mode: ExecutionMode;
  readonly repoRoot: string | null;
  readonly remoteUrl: string | null;
  readonly isGitRepo: boolean;
  readonly isCleanTree: boolean;
  readonly currentBranch: string | null;
}

// ============================================================================
// Git Helpers (silent — never throw on git absence)
// ============================================================================

function gitExec(command: string, cwd?: string): string | null {
  try {
    return execSync(command, {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 5000,
    }).toString().trim();
  } catch {
    return null;
  }
}

// ============================================================================
// Core Detection
// ============================================================================

/**
 * Detect the execution mode based on the current working directory.
 *
 * Returns a full ExecutionContext with mode, repo info, and git state.
 */
export function detectExecutionMode(): ExecutionContext {
  // Priority 1: Explicit env var override
  const envMode = process.env['AGENTICS_EXECUTION_MODE'];
  if (envMode === 'development' || envMode === 'project') {
    const ctx = gatherGitContext();
    return { ...ctx, mode: envMode };
  }

  const ctx = gatherGitContext();

  // Always use project mode — `agentics ask` must produce code on a new branch.
  // The old "development" guard silently suppressed branch creation and code commits,
  // leaving artifacts buried in ~/.agentics/runs/ with no visible output.
  return { ...ctx, mode: ctx.isGitRepo ? 'project' : 'project' };
}

/**
 * Gather git context from the current working directory.
 */
function gatherGitContext(): Omit<ExecutionContext, 'mode'> {
  const repoRoot = gitExec('git rev-parse --show-toplevel');
  const isGitRepo = repoRoot !== null;

  if (!isGitRepo) {
    return {
      repoRoot: null,
      remoteUrl: null,
      isGitRepo: false,
      isCleanTree: false,
      currentBranch: null,
    };
  }

  const remoteUrl = gitExec('git remote get-url origin');
  const currentBranch = gitExec('git rev-parse --abbrev-ref HEAD');
  const statusOutput = gitExec('git status --porcelain');
  const isCleanTree = statusOutput !== null && statusOutput.length === 0;

  return {
    repoRoot,
    remoteUrl,
    isGitRepo,
    isCleanTree,
    currentBranch,
  };
}

// ============================================================================
// Validation
// ============================================================================

/**
 * Validate that the working tree is clean. Throws if dirty.
 * Only called in project mode before creating a scenario branch.
 */
export function validateCleanWorkingTree(): void {
  const status = gitExec('git status --porcelain');

  if (status === null) {
    throw new CLIError({
      code: 'ECLI-GIT-004',
      category: 'INPUT_ERROR',
      message: 'Not inside a git repository. Initialize with `git init` first.',
      module: 'execution-context',
      recoverable: false,
      exitCode: 1,
    });
  }

  if (status.length > 0) {
    throw new CLIError({
      code: 'ECLI-GIT-001',
      category: 'INPUT_ERROR',
      message: 'Working tree is not clean. Commit or stash changes before running the pipeline.',
      details: { dirtyFiles: status.split('\n').length },
      module: 'execution-context',
      recoverable: true,
      exitCode: 1,
    });
  }
}

// ============================================================================
// Scenario Branch Utilities
// ============================================================================

/**
 * Generate a URL-safe slug from a scenario query string.
 *
 * Takes the first 40 characters, lowercases, replaces non-alphanumeric
 * with hyphens, collapses runs, trims edges, appends YYYYMMDD date.
 */
export function generateScenarioSlug(query: string): string {
  const slug = query
    .slice(0, 40)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');

  const now = new Date();
  const date = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
  ].join('');
  const time = [
    String(now.getHours()).padStart(2, '0'),
    String(now.getMinutes()).padStart(2, '0'),
    String(now.getSeconds()).padStart(2, '0'),
  ].join('');

  return `${slug || 'scenario'}-${date}-${time}`;
}

/**
 * Generate the full branch name for a scenario simulation.
 *
 * Format: scenario/<slugified-query>-<YYYYMMDD>
 */
export function generateScenarioBranchName(query: string): string {
  return `scenario/${generateScenarioSlug(query)}`;
}

/**
 * Generate a branch name for `agentics ask` results.
 *
 * Format: agentics/<slugified-query>-<YYYYMMDD>
 */
export function generateAskBranchName(query: string): string {
  return `agentics/${generateScenarioSlug(query)}`;
}

/**
 * Create and checkout a new scenario branch. Throws on failure.
 */
export function createScenarioBranch(branchName: string): void {
  // If branch already exists, delete it and recreate (same-day reruns)
  const exists = gitExec(`git rev-parse --verify ${branchName}`);
  if (exists !== null) {
    gitExec(`git branch -D ${branchName}`);
  }

  const result = gitExec(`git checkout -b ${branchName}`);
  if (result === null) {
    throw new CLIError({
      code: 'ECLI-GIT-003',
      category: 'INTERNAL_ERROR',
      message: `Failed to create branch '${branchName}'.`,
      details: { branchName },
      module: 'execution-context',
      recoverable: false,
      exitCode: 1,
    });
  }
}

/**
 * Commit all staged and unstaged files with a descriptive message.
 * Returns the commit SHA.
 */
export function commitScenarioFiles(query: string): string {
  const commitMsg = query
    ? `feat: generated prototype — ${query.slice(0, 80)}`
    : 'feat: generated enterprise prototype';

  gitExec('git add -A');

  const commitResult = gitExec(`git commit -m "${commitMsg.replace(/"/g, '\\"')}"`);
  if (commitResult === null) {
    throw new CLIError({
      code: 'ECLI-GIT-003',
      category: 'INTERNAL_ERROR',
      message: 'Failed to commit scenario files.',
      module: 'execution-context',
      recoverable: false,
      exitCode: 1,
    });
  }

  const sha = gitExec('git rev-parse HEAD');
  return sha ?? 'unknown';
}

/**
 * Switch back to the original branch after scenario materialization.
 */
export function checkoutBranch(branchName: string): void {
  const result = gitExec(`git checkout ${branchName}`);
  if (result === null) {
    // Non-fatal — warn but don't crash
    console.error(`  [WARN] Could not switch back to branch '${branchName}'`);
  }
}
