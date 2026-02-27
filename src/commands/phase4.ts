/**
 * Phase 4 Command
 *
 * Transforms Phase 3 domain-core implementations into deployable Cloud Run
 * services with full ERP integration:
 *   - Phase 3 Artifact Validation
 *   - ERP Target Resolution (SAP, Oracle, Dynamics, etc.)
 *   - SQL Schema Generation
 *   - Infrastructure Adapter Generation
 *   - HTTP Server Generation (Hono / Axum)
 *   - ERP Client Generation
 *   - Deployment Descriptor Generation (Cloud Run / Dockerfile)
 *   - Phase 2 Metadata Augmentation
 *
 * Usage:
 *   agentics phase4 --trace <TRACE_ID>
 *   agentics phase4 --latest
 *
 * Error codes:
 *   ECLI-P4-001  Missing Phase 3 artifacts
 *   ECLI-P4-005  No runs found (--latest with empty runs dir)
 *   ECLI-P4-006  Phase 4 output directory already exists (append-only)
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { join } from 'node:path';
import { CLIError } from '../errors/index.js';
import { executePhase4Pipeline } from '../pipeline/phase4/index.js';
import type { Phase4Context, Phase4PipelineResult } from '../pipeline/phase4/index.js';
import type { TelemetrySpan } from '../pipeline/phase2/types.js';
import { REPO_CACHE_ROOT } from '../agents/repo-agent-runner.js';

// ============================================================================
// Constants
// ============================================================================

const RUNS_DIR_NAME = '.agentics/runs';
const PHASE3_SUBDIR = 'phase3';
const PHASE4_SUBDIR = 'phase4';
const DIR_MODE = 0o700;

const PLATFORM_REPOS = ['agentics-contracts', 'infra', 'integrations', 'erp-surface'] as const;

// ============================================================================
// Types
// ============================================================================

export interface Phase4CommandOptions {
  readonly trace?: string;
  readonly latest?: boolean;
  readonly verbose?: boolean;
  readonly format?: 'json' | 'text';
}

// ============================================================================
// Command Executor
// ============================================================================

/**
 * Execute the `agentics phase4` command.
 *
 * Resolves the Phase 1 run directory (via --trace or --latest), validates
 * that Phase 3 exists and Phase 4 does not, constructs the Phase4Context,
 * and delegates to the pipeline coordinator.
 */
export async function executePhase4Command(
  options: Phase4CommandOptions,
): Promise<Phase4PipelineResult> {
  const homeDir = process.env['HOME'] ?? '/tmp';
  const runsDir = path.join(homeDir, RUNS_DIR_NAME);

  // ── Resolve Phase 1 run directory ──
  const runDir = options.trace
    ? path.join(runsDir, options.trace)
    : options.latest
      ? findLatestRunDir(runsDir)
      : null;

  if (!runDir) {
    throw new CLIError({
      code: 'ECLI-P4-001',
      category: 'INPUT_ERROR',
      message: 'No trace ID specified. Use --trace <TRACE_ID> or --latest.',
      module: 'phase4',
      recoverable: false,
      exitCode: 1,
    });
  }

  // ── Validate run directory exists ──
  if (!fs.existsSync(runDir)) {
    throw new CLIError({
      code: 'ECLI-P4-001',
      category: 'INPUT_ERROR',
      message: `Run directory not found: ${runDir}`,
      details: { runDir },
      module: 'phase4',
      recoverable: false,
      exitCode: 1,
    });
  }

  // ── Validate Phase 3 subdirectory exists ──
  const phase3Dir = path.join(runDir, PHASE3_SUBDIR);
  if (!fs.existsSync(phase3Dir)) {
    throw new CLIError({
      code: 'ECLI-P4-001',
      category: 'INPUT_ERROR',
      message: `Phase 3 output not found. Run 'agentics phase3' first: ${phase3Dir}`,
      details: { phase3Dir },
      module: 'phase4',
      recoverable: false,
      exitCode: 1,
    });
  }

  // ── Append-only guard: Phase 4 must not already exist ──
  const phase4Dir = path.join(runDir, PHASE4_SUBDIR);
  if (fs.existsSync(phase4Dir)) {
    throw new CLIError({
      code: 'ECLI-P4-006',
      category: 'INPUT_ERROR',
      message: `Phase 4 already exists for this run. Output is append-only: ${phase4Dir}`,
      details: { phase4Dir },
      module: 'phase4',
      recoverable: false,
      exitCode: 1,
    });
  }

  // ── Create Phase 4 output directory ──
  fs.mkdirSync(phase4Dir, { recursive: true, mode: DIR_MODE });

  // ── Derive trace ID from directory name ──
  const traceId = path.basename(runDir);

  // ── Read scenario query from Phase 1 manifest ──
  let scenarioQuery = '';
  try {
    const manifestPath = path.join(runDir, 'manifest.json');
    if (fs.existsSync(manifestPath)) {
      const raw = fs.readFileSync(manifestPath, 'utf-8');
      const manifest = JSON.parse(raw) as { query?: string };
      scenarioQuery = manifest.query ?? '';
    }
  } catch {
    // Best-effort; the phase3-validator stage will try other sources
  }

  // ── Derive phase2 dir ──
  const phase2Dir = path.join(runDir, 'phase2');

  // ── Resolve platform repository paths ──
  const platformRepoPaths: Record<string, string> = {};
  for (const repoName of PLATFORM_REPOS) {
    platformRepoPaths[repoName] = join(REPO_CACHE_ROOT, repoName);
  }

  // ── Build empty Phase3Artifacts placeholder (phase3-validator fills it) ──
  const emptyPhase3Artifacts = {
    manifest: {},
    implementationLanguage: 'typescript',
    projectDir: '',
    phase2Artifacts: {
      manifest: {},
      sparc: {},
      adrs: [],
      domainModel: { contexts: [], contextMap: [] },
      tddPlan: { approach: '', testPyramid: {}, testSuites: [], mockContracts: [], seamDefinitions: [], executionOrder: [] },
    },
  };

  // ── Construct Phase4Context ──
  const context: Phase4Context = {
    traceId,
    phase2Dir,
    phase3Dir,
    phase4Dir,
    scenarioQuery,
    phase3Artifacts: emptyPhase3Artifacts as any,
    platformRepoPaths,
    stageOutputs: new Map(),
    telemetrySpans: [] as TelemetrySpan[],
  };

  // ── Execute pipeline ──
  const result = await executePhase4Pipeline(context);

  return result;
}

// ============================================================================
// Formatting
// ============================================================================

/**
 * Format Phase 4 result for human-readable display.
 */
export function formatPhase4ForDisplay(result: Phase4PipelineResult): string {
  const lines: string[] = [];

  lines.push('');
  lines.push('Phase 4: Deployable Cloud Run Service Generated');
  lines.push('='.repeat(50));
  lines.push('');
  lines.push(`  Trace ID:        ${result.traceId}`);
  lines.push(`  Output:          ${result.phase4Dir}`);
  lines.push(`  Language:        ${result.manifest.implementation_language}`);
  lines.push(`  ERP System:      ${result.manifest.erp_system}`);
  lines.push(`  Database Engine: ${result.manifest.database_engine ?? 'N/A'}`);
  lines.push(`  API Only:        ${result.manifest.api_only}`);
  lines.push(`  Duration:        ${result.totalTiming}ms`);
  lines.push(`  Stages:          ${result.stageResults.length}`);
  lines.push(`  Artifacts:       ${result.manifest.artifacts.length} files`);
  lines.push(`  Success:         ${result.manifest.success}`);
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
    const failData = failed.data as Record<string, unknown> | null;
    if (failData && typeof failData === 'object' && 'error' in failData) {
      lines.push(`         ${failData['error']}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Find the most recent Phase 1 run directory that has a Phase 3 subdirectory.
 */
function findLatestRunDir(runsDir: string): string {
  if (!fs.existsSync(runsDir)) {
    throw new CLIError({
      code: 'ECLI-P4-005',
      category: 'INPUT_ERROR',
      message: `Runs directory not found: ${runsDir}`,
      details: { runsDir },
      module: 'phase4',
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
    const phase3Path = path.join(runPath, PHASE3_SUBDIR);

    // Only consider runs that have Phase 3 output
    if (!fs.existsSync(phase3Path)) continue;

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
      code: 'ECLI-P4-005',
      category: 'INPUT_ERROR',
      message: 'No Phase 3 runs found. Run Phase 1, Phase 2, and Phase 3 first.',
      details: { runsDir },
      module: 'phase4',
      recoverable: false,
      exitCode: 1,
    });
  }

  return latestDir;
}
