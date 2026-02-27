/**
 * Phase 3 Command
 *
 * Transforms Phase 2 engineering packages into a deterministic, runnable
 * domain-core implementation:
 *   - Language Resolution (Rust vs TypeScript)
 *   - Project Scaffold (ESM + Vitest or Cargo workspace)
 *   - Domain Code (aggregates, VOs, events, commands, queries, seam interfaces)
 *   - London School TDD Tests
 *   - Ruflo Stub Filling (optional)
 *
 * Usage:
 *   agentics phase3 --trace <TRACE_ID>
 *   agentics phase3 --latest
 *
 * Error codes:
 *   ECLI-P3-001  Missing Phase 2 artifacts
 *   ECLI-P3-006  Phase 3 output directory already exists (append-only)
 *   ECLI-P3-007  No runs found (--latest with empty runs dir)
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { CLIError } from '../errors/index.js';
import { executePhase3Pipeline } from '../pipeline/phase3/index.js';
import type { Phase3Context, Phase3PipelineResult } from '../pipeline/phase3/index.js';
import type { TelemetrySpan } from '../pipeline/phase2/types.js';

// ============================================================================
// Constants
// ============================================================================

const RUNS_DIR_NAME = '.agentics/runs';
const PHASE2_SUBDIR = 'phase2';
const PHASE3_SUBDIR = 'phase3';
const DIR_MODE = 0o700;

// ============================================================================
// Types
// ============================================================================

export interface Phase3CommandOptions {
  readonly trace?: string;
  readonly latest?: boolean;
  readonly verbose?: boolean;
  readonly format?: 'json' | 'text';
}

// ============================================================================
// Command Executor
// ============================================================================

/**
 * Execute the `agentics phase3` command.
 *
 * Resolves the Phase 1 run directory (via --trace or --latest), validates
 * that Phase 2 exists and Phase 3 does not, constructs the Phase3Context,
 * and delegates to the pipeline coordinator.
 */
export async function executePhase3Command(
  options: Phase3CommandOptions,
): Promise<Phase3PipelineResult> {
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
      code: 'ECLI-P3-001',
      category: 'INPUT_ERROR',
      message: 'No trace ID specified. Use --trace <TRACE_ID> or --latest.',
      module: 'phase3',
      recoverable: false,
      exitCode: 1,
    });
  }

  // ── Validate run directory exists ──
  if (!fs.existsSync(runDir)) {
    throw new CLIError({
      code: 'ECLI-P3-001',
      category: 'INPUT_ERROR',
      message: `Run directory not found: ${runDir}`,
      details: { runDir },
      module: 'phase3',
      recoverable: false,
      exitCode: 1,
    });
  }

  // ── Validate Phase 2 subdirectory exists ──
  const phase2Dir = path.join(runDir, PHASE2_SUBDIR);
  if (!fs.existsSync(phase2Dir)) {
    throw new CLIError({
      code: 'ECLI-P3-001',
      category: 'INPUT_ERROR',
      message: `Phase 2 output not found. Run 'agentics phase2' first: ${phase2Dir}`,
      details: { phase2Dir },
      module: 'phase3',
      recoverable: false,
      exitCode: 1,
    });
  }

  // ── Append-only guard: Phase 3 must not already exist ──
  const phase3Dir = path.join(runDir, PHASE3_SUBDIR);
  if (fs.existsSync(phase3Dir)) {
    throw new CLIError({
      code: 'ECLI-P3-006',
      category: 'INPUT_ERROR',
      message: `Phase 3 already exists for this run. Output is append-only: ${phase3Dir}`,
      details: { phase3Dir },
      module: 'phase3',
      recoverable: false,
      exitCode: 1,
    });
  }

  // ── Create Phase 3 output directory ──
  fs.mkdirSync(phase3Dir, { recursive: true, mode: DIR_MODE });

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
    // Best-effort; the phase2-validator stage will try other sources
  }

  // ── Build empty Phase2Artifacts placeholder (phase2-validator fills it) ──
  const emptyPhase2Artifacts = {
    manifest: {},
    sparc: {},
    adrs: [],
    domainModel: { contexts: [], contextMap: [] },
    tddPlan: { approach: '', testPyramid: {}, testSuites: [], mockContracts: [], seamDefinitions: [], executionOrder: [] },
  };

  // ── Construct Phase3Context ──
  const context: Phase3Context = {
    traceId,
    phase2Dir,
    phase3Dir,
    scenarioQuery,
    phase2Artifacts: emptyPhase2Artifacts as any,
    stageOutputs: new Map(),
    telemetrySpans: [] as TelemetrySpan[],
  };

  // ── Execute pipeline ──
  const result = await executePhase3Pipeline(context);

  return result;
}

// ============================================================================
// Formatting
// ============================================================================

/**
 * Format Phase 3 result for human-readable display.
 */
export function formatPhase3ForDisplay(result: Phase3PipelineResult): string {
  const lines: string[] = [];

  lines.push('');
  lines.push('Phase 3: Domain-Core Implementation Generated');
  lines.push('='.repeat(50));
  lines.push('');
  lines.push(`  Trace ID:    ${result.traceId}`);
  lines.push(`  Output:      ${result.phase3Dir}`);
  lines.push(`  Language:    ${result.manifest.implementation_language}`);
  lines.push(`  Duration:    ${result.totalTiming}ms`);
  lines.push(`  Stages:      ${result.stageResults.length}`);
  lines.push(`  Artifacts:   ${result.manifest.artifacts.length} files`);
  lines.push(`  Success:     ${result.manifest.success}`);
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
 * Find the most recent Phase 1 run directory that has a Phase 2 subdirectory.
 */
function findLatestRunDir(runsDir: string): string {
  if (!fs.existsSync(runsDir)) {
    throw new CLIError({
      code: 'ECLI-P3-007',
      category: 'INPUT_ERROR',
      message: `Runs directory not found: ${runsDir}`,
      details: { runsDir },
      module: 'phase3',
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
    const phase2Path = path.join(runPath, PHASE2_SUBDIR);

    // Only consider runs that have Phase 2 output
    if (!fs.existsSync(phase2Path)) continue;

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
      code: 'ECLI-P3-007',
      category: 'INPUT_ERROR',
      message: 'No Phase 2 runs found. Run Phase 1 and Phase 2 first.',
      details: { runsDir },
      module: 'phase3',
      recoverable: false,
      exitCode: 1,
    });
  }

  return latestDir;
}
