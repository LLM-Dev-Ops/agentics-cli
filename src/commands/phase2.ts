/**
 * Phase 2 Command
 *
 * Deep Research phase — extracts structured knowledge from Phase 1 artifacts:
 *   - Phase 1 Artifact Loading + Validation
 *   - Research Dossier (structured extraction with cross-references)
 *
 * SPARC, TDD, ADRs, and DDDs are generated in subsequent phases (3, 4).
 *
 * Usage:
 *   agentics phase2 --trace <TRACE_ID>
 *   agentics phase2 --latest
 *
 * Error codes:
 *   ECLI-P2-001  Missing or unreadable Phase 1 artifacts
 *   ECLI-P2-003  Phase 2 output directory already exists (append-only)
 *   ECLI-P2-004  No runs found (--latest with empty runs dir)
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { CLIError } from '../errors/index.js';
import { executePhase2Pipeline } from '../pipeline/phase2/index.js';
import type { Phase2Context, Phase2PipelineResult, TelemetrySpan } from '../pipeline/phase2/index.js';

// ============================================================================
// Constants
// ============================================================================

const RUNS_DIR_NAME = '.agentics/runs';
const PHASE2_SUBDIR = 'phase2';
const DIR_MODE = 0o700;

// ============================================================================
// Types
// ============================================================================

export interface Phase2CommandOptions {
  readonly trace?: string;
  readonly latest?: boolean;
  readonly verbose?: boolean;
  readonly format?: 'json' | 'text';
}

// ============================================================================
// Command Executor
// ============================================================================

/**
 * Execute the `agentics phase2` command.
 *
 * Resolves the Phase 1 run directory (via --trace or --latest), validates
 * that Phase 2 has not already been generated, constructs the Phase2Context,
 * and delegates to the pipeline coordinator.
 */
export async function executePhase2Command(
  options: Phase2CommandOptions,
): Promise<Phase2PipelineResult> {
  const homeDir = process.env['HOME'] ?? '/tmp';
  const runsDir = path.join(homeDir, RUNS_DIR_NAME);

  // ── Resolve Phase 1 run directory ──
  const phase1Dir = options.trace
    ? path.join(runsDir, options.trace)
    : options.latest
      ? findLatestRunDir(runsDir)
      : null;

  if (!phase1Dir) {
    throw new CLIError({
      code: 'ECLI-P2-001',
      category: 'INPUT_ERROR',
      message: 'No trace ID specified. Use --trace <TRACE_ID> or --latest.',
      module: 'phase2',
      recoverable: false,
      exitCode: 1,
    });
  }

  // ── Validate Phase 1 directory exists ──
  if (!fs.existsSync(phase1Dir)) {
    throw new CLIError({
      code: 'ECLI-P2-001',
      category: 'INPUT_ERROR',
      message: `Phase 1 run directory not found: ${phase1Dir}`,
      details: { phase1Dir },
      module: 'phase2',
      recoverable: false,
      exitCode: 1,
    });
  }

  // ── Validate Phase 1 manifest exists ──
  const manifestPath = path.join(phase1Dir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    throw new CLIError({
      code: 'ECLI-P2-001',
      category: 'INPUT_ERROR',
      message: `Phase 1 manifest not found: ${manifestPath}`,
      details: { manifestPath },
      module: 'phase2',
      recoverable: false,
      exitCode: 1,
    });
  }

  // ── Append-only guard: Phase 2 must not already exist ──
  const phase2Dir = path.join(phase1Dir, PHASE2_SUBDIR);
  if (fs.existsSync(phase2Dir)) {
    throw new CLIError({
      code: 'ECLI-P2-003',
      category: 'INPUT_ERROR',
      message: `Phase 2 already exists for this run. Output is append-only: ${phase2Dir}`,
      details: { phase2Dir },
      module: 'phase2',
      recoverable: false,
      exitCode: 1,
    });
  }

  // ── Create Phase 2 output directory ──
  fs.mkdirSync(phase2Dir, { recursive: true, mode: DIR_MODE });

  // ── Derive trace ID from directory name ──
  const traceId = path.basename(phase1Dir);

  // ── Build empty Phase1Artifacts placeholder (artifact-loader fills it) ──
  const emptyPhase1Artifacts = {
    manifest: { run_id: '', execution_id: '', correlation_id: '', query: '', created_at: '', timing_ms: 0, agents_invoked: [], artifacts: [], schema_version: '' },
    scenario: { query: '' },
    roadmap: { phases: [] },
    executiveSummary: '',
    riskAssessment: { risk_factors: [], overall_risk_level: '' },
    decisionMemo: '',
  };

  // ── Construct Phase2Context ──
  const context: Phase2Context = {
    traceId,
    phase1Dir,
    phase2Dir,
    phase1Artifacts: emptyPhase1Artifacts,
    stageOutputs: new Map(),
    telemetrySpans: [] as TelemetrySpan[],
  };

  // ── Execute pipeline ──
  const result = await executePhase2Pipeline(context);

  return result;
}

// ============================================================================
// Formatting
// ============================================================================

/**
 * Format Phase2 result for human-readable display.
 */
export function formatPhase2ForDisplay(result: Phase2PipelineResult): string {
  const lines: string[] = [];

  lines.push('');
  lines.push('Phase 2: Deep Research Complete');
  lines.push('='.repeat(50));
  lines.push('');
  lines.push(`  Trace ID:    ${result.traceId}`);
  lines.push(`  Output:      ${result.phase2Dir}`);
  lines.push(`  Duration:    ${result.totalTiming}ms`);
  lines.push(`  Stages:      ${result.stageResults.length}`);
  lines.push(`  Artifacts:   ${result.manifest.artifacts.length} files`);
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
 * Find the most recent Phase 1 run directory by parsing manifest.json
 * created_at timestamps.
 */
function findLatestRunDir(runsDir: string): string {
  if (!fs.existsSync(runsDir)) {
    throw new CLIError({
      code: 'ECLI-P2-004',
      category: 'INPUT_ERROR',
      message: `Runs directory not found: ${runsDir}`,
      details: { runsDir },
      module: 'phase2',
      recoverable: false,
      exitCode: 1,
    });
  }

  let latestDir = '';
  let latestTime = '';

  const entries = fs.readdirSync(runsDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const manifestPath = path.join(runsDir, entry.name, 'manifest.json');
    if (!fs.existsSync(manifestPath)) continue;

    try {
      const raw = fs.readFileSync(manifestPath, 'utf-8');
      const manifest = JSON.parse(raw) as { created_at?: string };
      const createdAt = manifest.created_at ?? '';

      if (createdAt > latestTime) {
        latestTime = createdAt;
        latestDir = path.join(runsDir, entry.name);
      }
    } catch {
      // Skip unreadable manifests
    }
  }

  if (!latestDir) {
    throw new CLIError({
      code: 'ECLI-P2-004',
      category: 'INPUT_ERROR',
      message: 'No Phase 1 runs found. Run a simulation first.',
      details: { runsDir },
      module: 'phase2',
      recoverable: false,
      exitCode: 1,
    });
  }

  return latestDir;
}
