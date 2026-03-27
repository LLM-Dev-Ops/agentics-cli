/**
 * Phase 5 Command (Build)
 *
 * Chains code generation and deployable service generation into a
 * single Build pipeline:
 *   - Prior Phase Loading (Phase 2/3/4 artifact validation)
 *   - Domain Code Generation (existing Phase 3 codegen pipeline)
 *   - Deployable Service Generation (existing Phase 4 deploy pipeline)
 *
 * Usage:
 *   agentics phase5 --trace <TRACE_ID>
 *   agentics phase5 --latest
 *
 * Error codes:
 *   ECLI-P5-001  Missing Phase 4 (ADRs+DDDs) artifacts
 *   ECLI-P5-006  Phase 5 output directory already exists (append-only)
 *   ECLI-P5-007  No runs found (--latest with empty runs dir)
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { CLIError } from '../errors/index.js';
import { executePhase5BuildPipeline } from '../pipeline/phase5-build/index.js';
import type { Phase5BuildContext, Phase5BuildPipelineResult } from '../pipeline/phase5-build/index.js';
import type { TelemetrySpan } from '../pipeline/phase2/types.js';
import { REPO_CACHE_ROOT } from '../agents/repo-agent-runner.js';

// ============================================================================
// Constants
// ============================================================================

const RUNS_DIR_NAME = '.agentics/runs';
const PHASE2_SUBDIR = 'phase2';
const PHASE3_SUBDIR = 'phase3';
const PHASE4_SUBDIR = 'phase4';
const PHASE5_SUBDIR = 'phase5';
const DIR_MODE = 0o700;

const PLATFORM_REPOS = ['agentics-contracts', 'infra', 'integrations', 'erp-surface'] as const;

// ============================================================================
// Types
// ============================================================================

export interface Phase5CommandOptions {
  readonly trace?: string;
  readonly latest?: boolean;
  readonly verbose?: boolean;
  readonly format?: 'json' | 'text';
}

// ============================================================================
// Command Executor
// ============================================================================

/**
 * Execute the `agentics phase5` command.
 *
 * Resolves the Phase 1 run directory (via --trace or --latest), validates
 * that Phase 4 (ADRs+DDDs) exists and Phase 5 does not, constructs the
 * Phase5BuildContext, and delegates to the build pipeline coordinator.
 */
export async function executePhase5Command(
  options: Phase5CommandOptions,
): Promise<Phase5BuildPipelineResult> {
  const homeDir = process.env['HOME'] ?? '/tmp';
  const runsDir = path.join(homeDir, RUNS_DIR_NAME);

  // -- Resolve Phase 1 run directory --
  const runDir = options.trace
    ? path.join(runsDir, options.trace)
    : options.latest
      ? findLatestRunDir(runsDir)
      : null;

  if (!runDir) {
    throw new CLIError({
      code: 'ECLI-P5-001',
      category: 'INPUT_ERROR',
      message: 'No trace ID specified. Use --trace <TRACE_ID> or --latest.',
      module: 'phase5',
      recoverable: false,
      exitCode: 1,
    });
  }

  // -- Validate run directory exists --
  if (!fs.existsSync(runDir)) {
    throw new CLIError({
      code: 'ECLI-P5-001',
      category: 'INPUT_ERROR',
      message: `Run directory not found: ${runDir}`,
      details: { runDir },
      module: 'phase5',
      recoverable: false,
      exitCode: 1,
    });
  }

  // -- Validate Phase 4 (ADRs+DDDs) subdirectory exists --
  const phase4Dir = path.join(runDir, PHASE4_SUBDIR);
  if (!fs.existsSync(phase4Dir)) {
    throw new CLIError({
      code: 'ECLI-P5-001',
      category: 'INPUT_ERROR',
      message: `Phase 4 output not found. Run 'agentics phase4' first: ${phase4Dir}`,
      details: { phase4Dir },
      module: 'phase5',
      recoverable: false,
      exitCode: 1,
    });
  }

  // -- Validate Phase 4 manifest exists --
  const phase4ManifestPath = path.join(phase4Dir, 'phase4-manifest.json');
  if (!fs.existsSync(phase4ManifestPath)) {
    throw new CLIError({
      code: 'ECLI-P5-001',
      category: 'INPUT_ERROR',
      message: `Phase 4 manifest not found. Run 'agentics phase4' to completion: ${phase4ManifestPath}`,
      details: { phase4ManifestPath },
      module: 'phase5',
      recoverable: false,
      exitCode: 1,
    });
  }

  // -- Append-only guard: Phase 5 must not already exist --
  const phase5Dir = path.join(runDir, PHASE5_SUBDIR);
  if (fs.existsSync(phase5Dir)) {
    throw new CLIError({
      code: 'ECLI-P5-006',
      category: 'INPUT_ERROR',
      message: `Phase 5 already exists for this run. Output is append-only: ${phase5Dir}`,
      details: { phase5Dir },
      module: 'phase5',
      recoverable: false,
      exitCode: 1,
    });
  }

  // -- Create Phase 5 output directory --
  fs.mkdirSync(phase5Dir, { recursive: true, mode: DIR_MODE });

  // -- Derive trace ID from directory name --
  const traceId = path.basename(runDir);

  // -- Read scenario query from Phase 1 manifest --
  let scenarioQuery = '';
  try {
    const manifestPath = path.join(runDir, 'manifest.json');
    if (fs.existsSync(manifestPath)) {
      const raw = fs.readFileSync(manifestPath, 'utf-8');
      const manifest = JSON.parse(raw) as { query?: string };
      scenarioQuery = manifest.query ?? '';
    }
  } catch {
    // Best-effort; the pipeline stages will try other sources
  }

  // -- Derive prior phase directories --
  const phase2Dir = path.join(runDir, PHASE2_SUBDIR);
  const phase3Dir = path.join(runDir, PHASE3_SUBDIR);

  // -- Resolve platform repository paths --
  const platformRepoPaths: Record<string, string> = {};
  for (const repoName of PLATFORM_REPOS) {
    platformRepoPaths[repoName] = join(REPO_CACHE_ROOT, repoName);
  }

  // -- Check ruflo availability (optional — Phase 5 works without it) --
  {
    const rufloBin = join(process.cwd(), 'node_modules', '.bin', 'ruflo');
    try {
      execSync(`${rufloBin} --version`, { stdio: 'pipe', timeout: 10_000 });
    } catch {
      // ruflo not installed — Phase 5 continues without coding swarm
    }
  }

  // -- Construct Phase5BuildContext --
  const context: Phase5BuildContext = {
    traceId,
    phase2Dir,
    phase3Dir,
    phase4Dir,
    phase5Dir,
    scenarioQuery,
    platformRepoPaths,
    telemetrySpans: [] as TelemetrySpan[],
  };

  // -- Execute pipeline --
  const result = await executePhase5BuildPipeline(context);

  return result;
}

// ============================================================================
// Formatting
// ============================================================================

/**
 * Format Phase 5 Build result for human-readable display.
 */
export function formatPhase5ForDisplay(result: Phase5BuildPipelineResult): string {
  const lines: string[] = [];

  lines.push('');
  lines.push('Phase 5: Build (Code Gen + Deployable Service)');
  lines.push('='.repeat(50));
  lines.push('');
  lines.push(`  Trace ID:   ${result.traceId}`);
  lines.push(`  Output:     ${result.phase5Dir}`);
  lines.push(`  Language:   ${result.manifest.implementation_language}`);
  lines.push(`  ERP System: ${result.manifest.erp_system}`);
  lines.push(`  Duration:   ${result.totalTiming}ms`);
  lines.push(`  Stages:     ${result.stageResults.length}`);
  lines.push(`  Artifacts:  ${result.manifest.artifacts.length} files`);
  lines.push(`  Success:    ${result.manifest.success}`);
  lines.push('');

  // Stage summary
  lines.push('  Stages:');
  for (const stage of result.stageResults) {
    const icon = stage.status === 'completed' ? '[OK]' : '[FAIL]';
    lines.push(`    ${icon} ${stage.stage} (${stage.timing}ms)`);
  }
  lines.push('');

  // Check for failures
  const failed = result.stageResults.find(s => s.status === 'failed');
  if (failed) {
    lines.push(`  ERROR: Pipeline failed at stage "${failed.stage}"`);
    lines.push(`         ${failed.summary}`);
    lines.push('');
  }

  return lines.join('\n');
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Find the most recent Phase 1 run directory that has a Phase 4 subdirectory
 * with a phase4-manifest.json.
 */
function findLatestRunDir(runsDir: string): string {
  if (!fs.existsSync(runsDir)) {
    throw new CLIError({
      code: 'ECLI-P5-007',
      category: 'INPUT_ERROR',
      message: `Runs directory not found: ${runsDir}`,
      details: { runsDir },
      module: 'phase5',
      recoverable: false,
      exitCode: 1,
    });
  }

  let latestDir = '';
  let latestTime = '';

  const entries = fs.readdirSync(runsDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const runPath = path.join(runsDir, entry.name);
    const phase4Path = path.join(runPath, PHASE4_SUBDIR);

    // Only consider runs that have Phase 4 output with manifest
    if (!fs.existsSync(phase4Path)) continue;

    const phase4ManifestPath = path.join(phase4Path, 'phase4-manifest.json');
    if (!fs.existsSync(phase4ManifestPath)) continue;

    const manifestPath = path.join(runPath, 'manifest.json');
    if (!fs.existsSync(manifestPath)) continue;

    try {
      const raw = fs.readFileSync(manifestPath, 'utf-8');
      const manifest = JSON.parse(raw) as { created_at?: string };
      const createdAt = manifest.created_at ?? '';

      if (createdAt > latestTime) {
        latestTime = createdAt;
        latestDir = runPath;
      }
    } catch {
      // Skip unreadable manifests
    }
  }

  if (!latestDir) {
    throw new CLIError({
      code: 'ECLI-P5-007',
      category: 'INPUT_ERROR',
      message: 'No Phase 4 runs found. Run Phase 1 through Phase 4 first.',
      details: { runsDir },
      module: 'phase5',
      recoverable: false,
      exitCode: 1,
    });
  }

  return latestDir;
}
