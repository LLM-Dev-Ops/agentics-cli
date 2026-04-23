/**
 * ADR-PIPELINE-091 — primary-executor unit tests.
 *
 * Covers the new canonical entry point `runPrimaryPhaseExecution` plus the
 * two new task builders (`buildCoverageGapTasks`, `buildImplPromptsTasks`)
 * added alongside the existing Phase 2/3/4/5/6 builders.
 *
 * Scope is strictly local behavior: env-gated disable path, argv enforcement,
 * task-count assertions. We do not spin up the real Ruflo binary here.
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  buildCoverageGapTasks,
  buildImplPromptsTasks,
  buildPhase2Tasks,
  buildPhase3Tasks,
  buildPhase4Tasks,
  buildPhase5Tasks,
  buildPhase6Tasks,
  runPrimaryPhaseExecution,
  type Phase1Dossier,
  type RufloExecutionContext,
  type RufloTask,
} from '../../../src/pipeline/ruflo-phase-executor.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeDossier(overrides: Partial<Phase1Dossier> = {}): Phase1Dossier {
  return {
    scenarioQuery: 'Build an enterprise sustainability platform for fleet operators.',
    traceId: 'test-trace-091',
    runDir: path.join(os.tmpdir(), 'ruflo-phase-executor-test-runs', 'test-trace-091'),
    artifacts: {},
    ...overrides,
  };
}

function makeContext(overrides: Partial<RufloExecutionContext> = {}): RufloExecutionContext {
  return {
    outputDir: path.join(os.tmpdir(), 'ruflo-phase-executor-test-out', String(Date.now())),
    language: 'typescript',
    ...overrides,
  };
}

function hasLocalOnly(task: RufloTask): boolean {
  return Array.isArray(task.argv) && task.argv.includes('--local-only');
}

// ---------------------------------------------------------------------------
// runPrimaryPhaseExecution — env-gated disable path
// ---------------------------------------------------------------------------

describe('runPrimaryPhaseExecution — env-gated disable path', () => {
  const originalDisable = process.env['AGENTICS_DISABLE_RUFLO'];

  beforeEach(() => {
    process.env['AGENTICS_DISABLE_RUFLO'] = 'true';
  });

  afterEach(() => {
    if (originalDisable === undefined) delete process.env['AGENTICS_DISABLE_RUFLO'];
    else process.env['AGENTICS_DISABLE_RUFLO'] = originalDisable;
  });

  it('returns executionTier="unavailable" when AGENTICS_DISABLE_RUFLO=true', async () => {
    const dossier = makeDossier();
    const context = makeContext();
    const result = await runPrimaryPhaseExecution('phase3-sparc', dossier, context);

    expect(result.executionTier).toBe('unavailable');
    expect(result.success).toBe(false);
    expect(result.reason).toBe('ruflo-disabled-by-env');
    expect(result.filesModified).toBe(0);
  });

  it('does not throw when Ruflo is disabled — caller decides fallback', async () => {
    const dossier = makeDossier();
    const context = makeContext();
    await expect(runPrimaryPhaseExecution('phase5-coverage', dossier, context)).resolves.toBeDefined();
  });

  it('honors the env disable across all canonical phase ids', async () => {
    const dossier = makeDossier();
    const context = makeContext();
    const phases: Array<'phase3-sparc' | 'phase4-adrs-ddd' | 'phase5a-prompts' | 'phase5-coverage'> = [
      'phase3-sparc', 'phase4-adrs-ddd', 'phase5a-prompts', 'phase5-coverage',
    ];
    for (const phase of phases) {
      const result = await runPrimaryPhaseExecution(phase, dossier, context);
      expect(result.executionTier).toBe('unavailable');
      expect(result.reason).toBe('ruflo-disabled-by-env');
    }
  });
});

// ---------------------------------------------------------------------------
// buildCoverageGapTasks
// ---------------------------------------------------------------------------

describe('buildCoverageGapTasks', () => {
  it('returns at least one task with --local-only in argv', () => {
    const tasks = buildCoverageGapTasks(makeDossier(), makeContext());
    expect(tasks.length).toBeGreaterThanOrEqual(1);
    for (const task of tasks) {
      expect(hasLocalOnly(task)).toBe(true);
    }
  });

  it('targets the coverage directory and embeds the scenario query', () => {
    const dossier = makeDossier({ scenarioQuery: 'Very specific scenario XYZ' });
    const tasks = buildCoverageGapTasks(dossier, makeContext());
    expect(tasks[0]!.targetDir).toBe('coverage');
    expect(tasks[0]!.description).toContain('Very specific scenario XYZ');
    expect(tasks[0]!.description).toContain('coverage-gaps.json');
  });

  it('includes the traceId so downstream tooling can correlate', () => {
    const tasks = buildCoverageGapTasks(
      makeDossier({ traceId: 'trace-abc-123' }),
      makeContext(),
    );
    expect(tasks[0]!.description).toContain('trace-abc-123');
  });
});

// ---------------------------------------------------------------------------
// buildImplPromptsTasks
// ---------------------------------------------------------------------------

describe('buildImplPromptsTasks', () => {
  // Canonical SPARC sections the builder enumerates: specification, pseudocode,
  // architecture, refinement, completion.
  const SPARC_SECTION_COUNT = 5;

  it('task count matches SPARC sections (5)', () => {
    const tasks = buildImplPromptsTasks(makeDossier(), makeContext(), [], []);
    expect(tasks).toHaveLength(SPARC_SECTION_COUNT);
  });

  it('every task carries --local-only in argv', () => {
    const tasks = buildImplPromptsTasks(makeDossier(), makeContext(), [], []);
    for (const task of tasks) {
      expect(hasLocalOnly(task)).toBe(true);
    }
  });

  it('writes impl-NNN-<slug>.md filenames that match auto-chain expectations', () => {
    const tasks = buildImplPromptsTasks(makeDossier(), makeContext(), [], []);
    // The first task should reference impl-001-specification.md, last should be impl-005-completion.md
    expect(tasks[0]!.description).toContain('impl-001-specification.md');
    expect(tasks[tasks.length - 1]!.description).toContain('impl-005-completion.md');
    for (const task of tasks) {
      expect(task.targetDir).toBe('plans/prompts');
    }
  });

  it('later tasks declare dependencies on prior prompts', () => {
    const tasks = buildImplPromptsTasks(makeDossier(), makeContext(), [], []);
    expect(tasks[0]!.dependsOn).toBeUndefined();
    for (let i = 1; i < tasks.length; i++) {
      expect(tasks[i]!.dependsOn).toBeDefined();
      expect(tasks[i]!.dependsOn!.length).toBeGreaterThan(0);
    }
  });

  it('includes supplied ADR + DDD context in the prompt body', () => {
    const tasks = buildImplPromptsTasks(
      makeDossier(),
      makeContext(),
      [{ id: 'ADR-001', title: 'Pick Postgres', decision: 'Use Postgres 15' }],
      [{ name: 'FleetManagement', aggregates: ['Vehicle', 'Route'] }],
    );
    const firstDescription = tasks[0]!.description;
    expect(firstDescription).toContain('ADR-001');
    expect(firstDescription).toContain('Pick Postgres');
    expect(firstDescription).toContain('FleetManagement');
  });
});

// ---------------------------------------------------------------------------
// --local-only enforcement across ALL builders (existing + new)
// ---------------------------------------------------------------------------

describe('--local-only enforcement across all task builders', () => {
  const scenarioQuery = 'Enterprise platform scenario.';
  const artifacts: Record<string, string> = {};

  function assertAllLocalOnly(tasks: RufloTask[], label: string): void {
    expect(tasks.length).toBeGreaterThan(0);
    for (const task of tasks) {
      if (!hasLocalOnly(task)) {
        throw new Error(`Task "${task.label}" in builder "${label}" is missing --local-only`);
      }
    }
  }

  it('buildPhase2Tasks passes --local-only on every task', () => {
    assertAllLocalOnly(buildPhase2Tasks(scenarioQuery, artifacts), 'buildPhase2Tasks');
  });

  it('buildPhase3Tasks passes --local-only on every task', () => {
    assertAllLocalOnly(buildPhase3Tasks(scenarioQuery, artifacts), 'buildPhase3Tasks');
  });

  it('buildPhase4Tasks passes --local-only on every task', () => {
    assertAllLocalOnly(buildPhase4Tasks(scenarioQuery, artifacts), 'buildPhase4Tasks');
  });

  it('buildPhase5Tasks passes --local-only on every task', () => {
    assertAllLocalOnly(
      buildPhase5Tasks(scenarioQuery, 'typescript', artifacts),
      'buildPhase5Tasks',
    );
  });

  it('buildPhase6Tasks passes --local-only on every task', () => {
    assertAllLocalOnly(buildPhase6Tasks(scenarioQuery, artifacts), 'buildPhase6Tasks');
  });

  it('buildCoverageGapTasks passes --local-only on every task', () => {
    assertAllLocalOnly(
      buildCoverageGapTasks(makeDossier(), makeContext()),
      'buildCoverageGapTasks',
    );
  });

  it('buildImplPromptsTasks passes --local-only on every task', () => {
    assertAllLocalOnly(
      buildImplPromptsTasks(makeDossier(), makeContext(), [], []),
      'buildImplPromptsTasks',
    );
  });
});

// ---------------------------------------------------------------------------
// Sanity — the exported types are usable from downstream modules.
// (Compile-time smoke test; if these lines type-check the test passes.)
// ---------------------------------------------------------------------------

describe('type exports are reachable', () => {
  it('Phase1Dossier and RufloExecutionContext compose without `any`', () => {
    const dossier: Phase1Dossier = makeDossier();
    const context: RufloExecutionContext = makeContext();
    expect(typeof dossier.scenarioQuery).toBe('string');
    expect(typeof context.outputDir).toBe('string');
    // Ensure we don't accidentally leak temp dirs — cleanup best-effort.
    try { fs.rmSync(context.outputDir, { recursive: true, force: true }); } catch { /* noop */ }
  });
});
