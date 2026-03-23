/**
 * Phase 6 Command (ERP Surface Push)
 *
 * Pushes Phase 5 Build deployable services onto an ERP surface with full
 * registration, materialization, and governance:
 *   - Phase 5 Artifact Validation
 *   - ERP Service Registration
 *   - Project Materialization
 *   - Deployment Finalization
 *   - Manifest Writing
 *
 * Usage:
 *   agentics phase6 --trace <TRACE_ID>
 *   agentics phase6 --latest
 *
 * Error codes:
 *   ECLI-P6-001  Missing Phase 5 (Build) artifacts
 *   ECLI-P6-006  Phase 6 output directory already exists (append-only)
 *   ECLI-P6-007  No runs found (--latest with empty runs dir)
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { CLIError } from '../errors/index.js';
import { executePhase6Pipeline } from '../pipeline/phase6/index.js';
import type { Phase6Context, Phase6PipelineResult, Phase5Artifacts, Phase5ManifestRef } from '../pipeline/phase6/types.js';
import type { TelemetrySpan } from '../pipeline/phase2/types.js';
import { REPO_CACHE_ROOT } from '../agents/repo-agent-runner.js';

// ============================================================================
// Constants
// ============================================================================

const RUNS_DIR_NAME = '.agentics/runs';
const PHASE5_SUBDIR = 'phase5';
const PHASE6_SUBDIR = 'phase6';
const DIR_MODE = 0o700;

const PLATFORM_REPOS = ['agentics-contracts', 'infra', 'integrations', 'erp-surface'] as const;

// ============================================================================
// Types
// ============================================================================

export interface Phase6CommandOptions {
  readonly trace?: string;
  readonly latest?: boolean;
  readonly verbose?: boolean;
  readonly format?: 'json' | 'text';
  readonly outputDir?: string;
}

// ============================================================================
// Command Executor
// ============================================================================

/**
 * Execute the `agentics phase6` command.
 *
 * Resolves the Phase 1 run directory (via --trace or --latest), validates
 * that Phase 5 (Build) exists and Phase 6 does not, constructs the
 * Phase6Context, and delegates to the Phase 6 pipeline coordinator.
 */
export async function executePhase6Command(
  options: Phase6CommandOptions,
): Promise<Phase6PipelineResult> {
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
      code: 'ECLI-P6-001',
      category: 'INPUT_ERROR',
      message: 'No trace ID specified. Use --trace <TRACE_ID> or --latest.',
      module: 'phase6',
      recoverable: false,
      exitCode: 1,
    });
  }

  // -- Validate run directory exists --
  if (!fs.existsSync(runDir)) {
    throw new CLIError({
      code: 'ECLI-P6-001',
      category: 'INPUT_ERROR',
      message: `Run directory not found: ${runDir}`,
      details: { runDir },
      module: 'phase6',
      recoverable: false,
      exitCode: 1,
    });
  }

  // -- Validate Phase 5 (Build) subdirectory exists --
  const phase5Dir = path.join(runDir, PHASE5_SUBDIR);
  if (!fs.existsSync(phase5Dir)) {
    throw new CLIError({
      code: 'ECLI-P6-001',
      category: 'INPUT_ERROR',
      message: `Phase 5 output not found. Run 'agentics phase5' first: ${phase5Dir}`,
      details: { phase5Dir },
      module: 'phase6',
      recoverable: false,
      exitCode: 1,
    });
  }

  // -- Validate Phase 5 manifest exists --
  const phase5ManifestPath = path.join(phase5Dir, 'phase5-manifest.json');
  if (!fs.existsSync(phase5ManifestPath)) {
    throw new CLIError({
      code: 'ECLI-P6-001',
      category: 'INPUT_ERROR',
      message: `Phase 5 manifest not found. Run 'agentics phase5' to completion: ${phase5ManifestPath}`,
      details: { phase5ManifestPath },
      module: 'phase6',
      recoverable: false,
      exitCode: 1,
    });
  }

  // -- Append-only guard: Phase 6 must not already have completed output --
  // Allow re-running if the directory exists but has no registration (failed prior run)
  const phase6Dir = path.join(runDir, PHASE6_SUBDIR);
  const phase6Registration = path.join(phase6Dir, 'registration.json');
  if (fs.existsSync(phase6Dir) && fs.existsSync(phase6Registration)) {
    throw new CLIError({
      code: 'ECLI-P6-006',
      category: 'INPUT_ERROR',
      message: `Phase 6 already exists for this run. Output is append-only: ${phase6Dir}`,
      details: { phase6Dir },
      module: 'phase6',
      recoverable: false,
      exitCode: 1,
    });
  }

  // -- Create Phase 6 output directory --
  fs.mkdirSync(phase6Dir, { recursive: true, mode: DIR_MODE });

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

  // -- Load Phase 5 manifest for context --
  let phase5ManifestData: Phase5ManifestRef;
  try {
    const raw = fs.readFileSync(phase5ManifestPath, 'utf-8');
    phase5ManifestData = JSON.parse(raw) as Phase5ManifestRef;
  } catch {
    throw new CLIError({
      code: 'ECLI-P6-001',
      category: 'INPUT_ERROR',
      message: `Failed to parse Phase 5 manifest: ${phase5ManifestPath}`,
      module: 'phase6',
      recoverable: false,
      exitCode: 1,
    });
  }

  // -- Build Phase5Artifacts for context --
  const phase5Artifacts: Phase5Artifacts = {
    manifest: phase5ManifestData,
    implementationLanguage: phase5ManifestData.implementation_language ?? 'typescript',
    erpSystem: phase5ManifestData.erp_system ?? 'unknown',
    databaseEngine: (phase5ManifestData.database_engine as string | null) ?? null,
    apiOnly: (phase5ManifestData.api_only as boolean) ?? false,
    projectDir: join(phase5Dir, 'deploy', 'project'),
  };

  // -- Resolve platform repository paths --
  const platformRepoPaths: Record<string, string> = {};
  for (const repoName of PLATFORM_REPOS) {
    platformRepoPaths[repoName] = join(REPO_CACHE_ROOT, repoName);
  }

  // -- Construct Phase6Context --
  const context: Phase6Context = {
    traceId,
    phase5Dir,
    phase6Dir,
    scenarioQuery,
    phase5Artifacts,
    platformRepoPaths,
    stageOutputs: new Map(),
    telemetrySpans: [] as TelemetrySpan[],
  };

  // -- Execute pipeline --
  const result = await executePhase6Pipeline(context);

  // -- Materialize to --output-dir if specified --
  if (options.outputDir && result.manifest.success) {
    materializeToOutputDir(result, options.outputDir, scenarioQuery);
  }

  return result;
}

// ============================================================================
// Output Directory Materialization
// ============================================================================

/**
 * Copy the materialized project to a user-specified output directory,
 * initialize a git repository, and create an initial commit.
 */
function materializeToOutputDir(
  result: Phase6PipelineResult,
  outputDir: string,
  scenarioQuery: string,
): void {
  const absOutputDir = path.resolve(outputDir);

  // Locate the materialized project inside the Phase 6 output
  const phase6ProjectDir = path.join(result.phase6Dir, 'project');
  if (!fs.existsSync(phase6ProjectDir)) {
    console.error(`     [WARN] No project directory in Phase 6 output: ${phase6ProjectDir}`);
    return;
  }

  // Create output directory (fail if it already exists with content)
  fs.mkdirSync(absOutputDir, { recursive: true, mode: DIR_MODE });

  // Recursively copy phase6/project/* → outputDir/
  copyTreeForOutput(phase6ProjectDir, absOutputDir);

  // Also copy Phase 6 manifest for reference
  const phase6ManifestSrc = path.join(result.phase6Dir, 'phase6-manifest.json');
  if (fs.existsSync(phase6ManifestSrc)) {
    fs.copyFileSync(phase6ManifestSrc, path.join(absOutputDir, 'phase6-manifest.json'));
  }

  // Initialize git repository and create initial commit
  try {
    execSync('git init', { cwd: absOutputDir, stdio: 'pipe' });
    execSync('git add -A', { cwd: absOutputDir, stdio: 'pipe' });

    const commitMsg = scenarioQuery
      ? `feat: generated prototype — ${scenarioQuery.slice(0, 80)}`
      : 'feat: generated enterprise prototype';
    execSync(`git commit -m "${commitMsg}"`, { cwd: absOutputDir, stdio: 'pipe' });
  } catch {
    // Non-fatal — git init is best-effort
    console.error('     [WARN] git init/commit in output directory failed (non-fatal)');
  }

  // Print next-steps instructions
  console.log('');
  console.log(`  Project materialized: ${absOutputDir}`);
  console.log('');
  console.log('  Next steps:');
  console.log(`    cd ${outputDir}`);
  console.log('    npm install');
  console.log('    npm run dev');
  console.log('');
  console.log(`  Or inspect the generated prototype:`);
  console.log(`    tree ${outputDir}/src --dirsfirst -L 3`);
  console.log('');
}

/**
 * Recursively copy a directory tree for output materialization.
 */
export function copyTreeForOutput(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true, mode: DIR_MODE });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      copyTreeForOutput(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

// ============================================================================
// Formatting
// ============================================================================

/**
 * Format Phase 6 result for human-readable display.
 */
export function formatPhase6ForDisplay(result: Phase6PipelineResult, outputDir?: string): string {
  const lines: string[] = [];

  lines.push('');
  lines.push('Phase 6: ERP Surface Push');
  lines.push('='.repeat(50));
  lines.push('');
  lines.push(`  Trace ID:       ${result.traceId}`);
  lines.push(`  Output:         ${result.phase6Dir}`);
  lines.push(`  ERP System:     ${result.manifest.erp_system}`);
  lines.push(`  Service:        ${result.manifest.service_name}`);
  lines.push(`  Registration:   ${result.manifest.registration_id}`);
  lines.push(`  Endpoints:      ${result.manifest.endpoints.length}`);
  lines.push(`  Duration:       ${result.totalTiming}ms`);
  lines.push(`  Artifacts:      ${result.manifest.artifacts.length} files`);
  lines.push(`  Success:        ${result.manifest.success}`);
  if (outputDir) {
    lines.push(`  Output Dir:     ${path.resolve(outputDir)}`);
  }
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
    if (failed.summary) {
      lines.push(`         ${failed.summary}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Find the most recent Phase 1 run directory that has a Phase 5 subdirectory
 * with a phase5-manifest.json.
 */
function findLatestRunDir(runsDir: string): string {
  if (!fs.existsSync(runsDir)) {
    throw new CLIError({
      code: 'ECLI-P6-007',
      category: 'INPUT_ERROR',
      message: `Runs directory not found: ${runsDir}`,
      details: { runsDir },
      module: 'phase6',
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
    const phase5Path = path.join(runPath, PHASE5_SUBDIR);

    // Only consider runs that have Phase 5 output with manifest
    if (!fs.existsSync(phase5Path)) continue;

    const phase5ManifestPath = path.join(phase5Path, 'phase5-manifest.json');
    if (!fs.existsSync(phase5ManifestPath)) continue;

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
      code: 'ECLI-P6-007',
      category: 'INPUT_ERROR',
      message: 'No Phase 5 runs found. Run Phase 1 through Phase 5 first.',
      details: { runsDir },
      module: 'phase6',
      recoverable: false,
      exitCode: 1,
    });
  }

  return latestDir;
}
