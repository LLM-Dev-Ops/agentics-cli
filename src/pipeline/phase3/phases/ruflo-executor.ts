/**
 * Phase 3 Ruflo Executor
 *
 * Invokes the ruflo CLI tool via child_process to fill implementation
 * stubs in the generated project scaffold. If ruflo is not installed,
 * the stage completes with a warning rather than failing the pipeline.
 *
 * Export:
 *   - executeRuflo() — pipeline stage entry returning Phase3StageOutput
 */

import type {
  Phase3Context,
  Phase3StageOutput,
  RufloResult,
  LanguageResolution,
} from '../types.js';
import { createSpan, endSpan, emitSpan } from '../../phase2/telemetry.js';
import { execSync, spawnSync } from 'node:child_process';

// ============================================================================
// Constants
// ============================================================================

/** Maximum time (ms) to wait for the ruflo process. */
const RUFLO_TIMEOUT = 300_000; // 5 minutes

/** Timeout for installation checks. */
const CHECK_TIMEOUT = 10_000;

/** Shorter timeout for `which` fallback. */
const WHICH_TIMEOUT = 5_000;

// ============================================================================
// Helpers
// ============================================================================

/**
 * Check whether ruflo is installed globally and attempt to determine its
 * version string. Falls back to `which ruflo` if the npm list approach
 * fails.
 *
 * @returns An object indicating whether ruflo was found and its version
 */
function checkRufloInstalled(): { installed: boolean; version: string } {
  try {
    const output = execSync('npm list -g ruflo@alpha', {
      encoding: 'utf-8',
      timeout: CHECK_TIMEOUT,
    });
    const match = output.match(/ruflo@([^\s\n]+)/);
    return { installed: true, version: match?.[1] ?? 'unknown' };
  } catch {
    // Fallback: try which
    try {
      execSync('which ruflo', { encoding: 'utf-8', timeout: WHICH_TIMEOUT });
      return { installed: true, version: 'unknown' };
    } catch {
      return { installed: false, version: 'N/A' };
    }
  }
}

// ============================================================================
// Pipeline Stage Entry
// ============================================================================

/**
 * Pipeline stage entry point for ruflo execution.
 *
 * Checks whether ruflo is installed, and if so invokes it to fill
 * implementation stubs in the generated project. If ruflo is not
 * installed, the stage completes successfully with a warning rather
 * than failing the pipeline.
 *
 * @param context - The Phase 3 pipeline context
 * @returns Phase3StageOutput summarizing ruflo execution results
 */
export function executeRuflo(context: Phase3Context): Phase3StageOutput {
  const span = createSpan('ruflo-execution', 'execute-ruflo');
  const startTime = Date.now();

  try {
    // ---- Check ruflo installation ----

    const rufloCheck = checkRufloInstalled();

    if (!rufloCheck.installed) {
      const timing = Date.now() - startTime;

      const skippedSpan = endSpan(span, 'ok', {
        rufloInstalled: false,
        skipped: true,
        timingMs: timing,
      });
      emitSpan(skippedSpan);
      context.telemetrySpans.push(skippedSpan);

      return {
        stage: 'ruflo-execution',
        status: 'completed',
        data: { skipped: true, reason: 'ruflo not installed' },
        artifacts: [],
        timing,
        summary: 'Ruflo execution skipped: ruflo is not installed. Install ruflo@alpha globally to enable stub filling.',
      };
    }

    // ---- Resolve language from prior stage ----

    const langStageOutput = context.stageOutputs.get('language-resolution');
    if (!langStageOutput || langStageOutput.status === 'failed') {
      const timing = Date.now() - startTime;

      const failedSpan = endSpan(span, 'error', { reason: 'language-resolution not available' });
      emitSpan(failedSpan);
      context.telemetrySpans.push(failedSpan);

      return {
        stage: 'ruflo-execution',
        status: 'failed',
        data: { error: 'ECLI-P3-003: language-resolution stage output not available' },
        artifacts: [],
        timing,
        summary: 'Ruflo execution failed: language resolution not available.',
      };
    }

    const langResolution = langStageOutput.data as LanguageResolution;
    const language = langResolution.language;

    // ---- Build ruflo command ----

    const phase2Dir = context.phase2Dir;
    const phase3Dir = context.phase3Dir;
    const projectDir = `${phase3Dir}/project`;

    const args = [
      'fill',
      '--language', language,
      '--adr-index', `${phase2Dir}/adrs/adr-index.json`,
      '--ddd-model', `${phase2Dir}/ddd/domain-model.json`,
      '--tdd-plan', `${phase2Dir}/tdd/tdd-plan.json`,
      '--target', projectDir,
    ];

    // ---- Execute ruflo ----

    const rufloStart = Date.now();
    const result = spawnSync('ruflo', args, {
      cwd: projectDir,
      timeout: RUFLO_TIMEOUT,
      encoding: 'utf-8',
    });
    const rufloTimingMs = Date.now() - rufloStart;

    const stdout = result.stdout ?? '';
    const stderr = result.stderr ?? '';
    const exitCode = result.status ?? 1;

    // ---- Parse files modified from stdout (best-effort) ----

    const filesModifiedMatch = stdout.match(/(\d+)\s+files?\s+modified/i);
    const filesModified = filesModifiedMatch?.[1] ? parseInt(filesModifiedMatch[1], 10) : 0;

    const rufloResult: RufloResult = {
      exitCode,
      stdout,
      stderr,
      version: rufloCheck.version,
      filesModified,
      timingMs: rufloTimingMs,
    };

    // ---- Handle failure ----

    if (exitCode !== 0) {
      const timing = Date.now() - startTime;

      const failedSpan = endSpan(span, 'error', {
        rufloVersion: rufloCheck.version,
        exitCode,
        timingMs: timing,
        stderr: stderr.slice(0, 500),
      });
      emitSpan(failedSpan);
      context.telemetrySpans.push(failedSpan);

      return {
        stage: 'ruflo-execution',
        status: 'failed',
        data: { error: `ECLI-P3-003: ruflo exited with code ${exitCode}`, rufloResult },
        artifacts: [],
        timing,
        summary: `Ruflo execution failed with exit code ${exitCode}: ${stderr.slice(0, 200)}`,
      };
    }

    // ---- Success ----

    const timing = Date.now() - startTime;

    const completedSpan = endSpan(span, 'ok', {
      rufloVersion: rufloCheck.version,
      exitCode: 0,
      filesModified,
      timingMs: timing,
    });
    emitSpan(completedSpan);
    context.telemetrySpans.push(completedSpan);

    return {
      stage: 'ruflo-execution',
      status: 'completed',
      data: rufloResult,
      artifacts: [],
      timing,
      summary: `Ruflo v${rufloCheck.version} filled ${filesModified} implementation stubs in ${rufloTimingMs}ms.`,
    };
  } catch (err: unknown) {
    const timing = Date.now() - startTime;
    const message = err instanceof Error ? err.message : String(err);

    const errorSpan = endSpan(span, 'error', { error: message });
    emitSpan(errorSpan);
    context.telemetrySpans.push(errorSpan);

    return {
      stage: 'ruflo-execution',
      status: 'failed',
      data: { error: `ECLI-P3-003: ${message}` },
      artifacts: [],
      timing,
      summary: `Ruflo execution failed: ${message}`,
    };
  }
}
