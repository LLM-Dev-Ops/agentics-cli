/**
 * Phase 3 Command (SPARC + London School TDD)
 *
 * Generates SPARC specifications and London School TDD test plans from
 * the Phase 2 research dossier:
 *   - Phase 2 Loading (research dossier + Phase 1 artifacts from disk)
 *   - SPARC Specification (spec, pseudocode, architecture, refinement, completion)
 *   - London School TDD Plan (outside-in test plan with mock contracts and seams)
 *
 * Usage:
 *   agentics phase3 --trace <TRACE_ID>
 *   agentics phase3 --latest
 *
 * Error codes:
 *   ECLI-P3-001  Missing Phase 2 artifacts or research dossier
 *   ECLI-P3-006  Phase 3 output directory already exists (append-only)
 *   ECLI-P3-007  No runs found (--latest with empty runs dir)
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { CLIError } from '../errors/index.js';
import { executePhase3SPARCPipeline } from '../pipeline/phase3-sparc/index.js';
import type { Phase3SPARCContext, Phase3SPARCPipelineResult } from '../pipeline/phase3-sparc/index.js';
import type { TelemetrySpan } from '../pipeline/phase2/types.js';

// ============================================================================
// Constants
// ============================================================================

const RUNS_DIR_NAME = '.agentics/runs';
const PHASE2_SUBDIR = 'phase2';
const PHASE3_SUBDIR = 'phase3';
const DIR_MODE = 0o700;
const RESEARCH_DOSSIER_FILENAME = 'research-dossier.json';

/**
 * Files that may legitimately exist in phase3/ before this command runs
 * without meaning "Phase 3 output was already produced". The dependency gate
 * (ADR-PIPELINE-093) writes `gate-decision-log.json` here as a pre-flight
 * side-effect; dotfiles are internal caches (`.ruflo-cache`, `.swarm`, …).
 */
const PHASE3_NON_OUTPUT_ENTRIES = new Set(['gate-decision-log.json']);

/**
 * Whether phase3/ already holds real SPARC/TDD output (vs. only gate metadata).
 * A directory containing solely `gate-decision-log.json` and/or dotfiles is
 * treated as "not yet produced" so the append-only guard does not force the
 * carry-forward recovery path on every run.
 */
function phase3DirHasOutput(dir: string): boolean {
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return false;
  }
  return entries.some(
    (e) => !e.startsWith('.') && !PHASE3_NON_OUTPUT_ENTRIES.has(e),
  );
}

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
 * that Phase 2 exists with a research dossier and Phase 3 does not,
 * constructs the Phase3SPARCContext, and delegates to the pipeline coordinator.
 */
export async function executePhase3Command(
  options: Phase3CommandOptions,
): Promise<Phase3SPARCPipelineResult> {
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
      code: 'ECLI-P3-001',
      category: 'INPUT_ERROR',
      message: 'No trace ID specified. Use --trace <TRACE_ID> or --latest.',
      module: 'phase3',
      recoverable: false,
      exitCode: 1,
    });
  }

  // -- Validate run directory exists --
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

  // -- Validate Phase 2 subdirectory exists --
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

  // -- Validate research dossier exists --
  const dossierPath = path.join(phase2Dir, RESEARCH_DOSSIER_FILENAME);
  if (!fs.existsSync(dossierPath)) {
    throw new CLIError({
      code: 'ECLI-P3-001',
      category: 'INPUT_ERROR',
      message: `Research dossier not found. Run 'agentics phase2' first: ${dossierPath}`,
      details: { dossierPath },
      module: 'phase3',
      recoverable: false,
      exitCode: 1,
    });
  }

  // -- Append-only guard: Phase 3 must not already contain real output --
  // The dependency gate (ADR-PIPELINE-093) writes `gate-decision-log.json`
  // into phase3/ BEFORE this command runs, which pre-creates the directory.
  // That metadata file (and dotfile caches) must NOT trip the append-only
  // guard — only actual SPARC/TDD output written by this command counts as
  // "already produced". Treating a metadata-only directory as existing output
  // forced every run down the verbatim carry-forward path, which mis-cased the
  // SPARC filenames and cascade-skipped Phases 4–6.
  const phase3Dir = path.join(runDir, PHASE3_SUBDIR);
  if (fs.existsSync(phase3Dir) && phase3DirHasOutput(phase3Dir)) {
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

  // -- Create Phase 3 output directory --
  fs.mkdirSync(phase3Dir, { recursive: true, mode: DIR_MODE });

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
    // Best-effort; the pipeline will try other sources
  }

  // -- Construct Phase3SPARCContext --
  const context: Phase3SPARCContext = {
    traceId,
    phase2Dir,
    phase3Dir,
    scenarioQuery,
    stageOutputs: new Map(),
    telemetrySpans: [] as TelemetrySpan[],
  };

  // -- Execute pipeline --
  const result = await executePhase3SPARCPipeline(context);

  return result;
}

// ============================================================================
// Formatting
// ============================================================================

/**
 * Format Phase 3 result for human-readable display.
 */
export function formatPhase3ForDisplay(result: Phase3SPARCPipelineResult): string {
  const lines: string[] = [];

  lines.push('');
  lines.push('Phase 3: SPARC + London TDD');
  lines.push('='.repeat(50));
  lines.push('');
  lines.push(`  Trace ID:    ${result.traceId}`);
  lines.push(`  Output:      ${result.phase3Dir}`);
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
  const failed = result.stageResults.find((s) => s.status === 'failed');
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
 * Find the most recent Phase 1 run directory that has a Phase 2 subdirectory
 * with a research dossier.
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

    // Only consider runs that have Phase 2 output with research dossier
    if (!fs.existsSync(phase2Path)) continue;

    const dossierPath = path.join(phase2Path, RESEARCH_DOSSIER_FILENAME);
    if (!fs.existsSync(dossierPath)) continue;

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
      message: 'No Phase 2 runs with research dossier found. Run Phase 1 and Phase 2 first.',
      details: { runsDir },
      module: 'phase3',
      recoverable: false,
      exitCode: 1,
    });
  }

  return latestDir;
}
