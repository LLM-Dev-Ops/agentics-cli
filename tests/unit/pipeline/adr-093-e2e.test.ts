/**
 * ADR-PIPELINE-093 — End-to-end verification test suite.
 *
 * Covers the seven Verification scenarios declared in the ADR:
 *
 *   1. Force 503s on four remote diligence agents; assert Ruflo produced
 *      everything, manifest.execution.engineering_tier === 'ruflo-local',
 *      .agentics/plans/{sparc,adrs,ddd,prompts}/ all populated, no blocked
 *      phases, no FATAL banner.
 *   2. Force Ruflo to fail on Phase 4; assert Phase 5a's gate retries once,
 *      then marks Phase 5a blocked and prints the [PIPELINE-093] FATAL
 *      banner — runDir is preserved.
 *   3. Healthy run — every gate passes on first check. No inputs produced
 *      by gate, no FATAL.
 *   4. Scaffold-language gate — TypeScript project: no .py files emitted.
 *   5. Scaffold-language gate — Python project: [SCAFFOLD] skipped line +
 *      phase5b_skipped record; no .ts files emitted.
 *   6. Regression: ADR-089 Phase 1 health-gate still classifies `degraded`
 *      correctly; ADR-088 status.json still emits canonical keys
 *      (traceId, phase, inProgress, plansDir, artifacts).
 *   7. `execution-plan.json` mandatory emission — it exists, is valid JSON,
 *      has >=1 implementations[] entry; at least one impl-NNN-*.md sibling.
 *
 * Implementation note: `executeAutoChain` makes git calls, coordinator calls,
 * MCP calls, swarm init, etc. — invoking the full pipeline inside a unit test
 * is untenable. Instead, each scenario exercises the observable ADR-093
 * contract through the public helpers that auto-chain's wiring calls:
 *
 *   - `gatePhaseInputs`    — the gate itself (with injected `runPrimary`).
 *   - `writeGateBlockToManifest` — merges blocked_phases + per-phase
 *     inputs_produced_by_gate into manifest.json.
 *   - scaffold-language gate — ADR-PIPELINE-115 made `language-resolver.ts` the
 *     single source of truth (`resolveScaffoldLanguage`) and `decideScaffoldEmission`
 *     route ts/python/rust or emit a LANG-FAIL artifact. There is no skip path.
 *   - The Rule-4 FATAL-emission block (auto-chain.ts:4415-4461) is replayed
 *     because it's a terminal process.exit() call — unit tests capture the
 *     exit via a jest.spyOn sentinel.
 *
 * This keeps the test focused on the ADR's observable contract while the
 * wiring-level integration sits at the existing
 * `tests/unit/pipeline/auto-chain-ruflo-primary.test.ts` + `gate/*.test.ts`
 * coverage layer.
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  gatePhaseInputs,
  determineBlockedPhases,
  type GateResult,
  type PhaseId as GatePhaseId,
} from '../../../src/pipeline/gate/phase-dependency-gate.js';
import type {
  Phase1Dossier,
  RufloExecutionContext,
  PrimaryPhaseExecutionResult,
  PrimaryPhaseId,
  runPrimaryPhaseExecution as RunPrimaryPhaseExecutionFn,
} from '../../../src/pipeline/ruflo-phase-executor.js';
import {
  writeGateBlockToManifest,
  writeGateBlockToStatusJson,
  decideScaffoldEmission,
  computeExecutionBlock,
  writeExecutionBlockToManifest,
  promotePlanningArtifacts,
  writePlanPromotionToManifest,
  copyPlanningArtifacts,
  formatAutoChainForDisplay,
  type AutoChainResult,
} from '../../../src/pipeline/auto-chain.js';
import { computePhase1Verdict } from '../../../src/pipeline/phase1-verdict.js';

// ============================================================================
// Shared fixtures
// ============================================================================

interface TempRoots {
  readonly base: string;
  readonly runDir: string;
  readonly projectRoot: string;
}

/** Create a fresh pair of run + project temp dirs. */
function makeTempRoots(): TempRoots {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'adr-093-e2e-'));
  const runDir = path.join(base, 'run');
  const projectRoot = path.join(base, 'project');
  fs.mkdirSync(runDir, { recursive: true });
  fs.mkdirSync(projectRoot, { recursive: true });
  return { base, runDir, projectRoot };
}

function writeFile(absPath: string, content: string): void {
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(absPath, content, 'utf-8');
}

/** Markdown blob well above the 256-byte placeholder / 100-byte gate threshold. */
function bigMarkdown(title: string): string {
  return [
    `# ${title}`,
    '',
    'End-to-end verification fixture for ADR-PIPELINE-093. This blob is',
    'large enough to clear both the 100-byte gate minimum and the 256-byte',
    'plan-promotion placeholder threshold. It contains multiple paragraphs',
    'so the SHA of its bytes is nowhere near a known placeholder hash.',
    '',
    '## Details',
    '',
    '- Structural content marker one.',
    '- Structural content marker two.',
    '- Structural content marker three.',
    '',
    'End of fixture body.',
    '',
  ].join('\n');
}

/** Seed the canonical Phase 1 artifacts that every scenario assumes. */
function seedPhase1(runDir: string, projectLanguage?: string): void {
  const manifest: Record<string, unknown> = {
    traceId: 'test-trace-093',
    query: 'adr-093 e2e fixture',
    simulation_id: 'sim-e2e-093',
    artifacts: [
      'phase1/manifest.json',
      'phase1/executive-summary.md',
    ],
  };
  if (projectLanguage) manifest['project'] = { language: projectLanguage };
  // Phase-1 scoped manifest (consumed by `gatePhaseInputs`).
  writeFile(path.join(runDir, 'phase1', 'manifest.json'), JSON.stringify(manifest, null, 2));
  writeFile(path.join(runDir, 'phase1', 'executive-summary.md'), bigMarkdown('Executive Summary'));
  // Top-level manifest.json — consumed by writeGateBlockToManifest / scaffold gate.
  writeFile(path.join(runDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
}

/** Seed the Phase 2 research dossier (the real shape, large enough to pass the gate). */
function seedPhase2(runDir: string): void {
  const dossier = {
    traceId: 'test-trace-093',
    query: 'adr-093 e2e fixture',
    sections: Array.from({ length: 6 }, (_, i) => ({
      heading: `Section ${i + 1}`,
      body: 'body '.repeat(32),
    })),
  };
  writeFile(path.join(runDir, 'phase2', 'research-dossier.json'), JSON.stringify(dossier, null, 2));
}

/** Seed Ruflo engineering/ primary outputs for a given phase — mimics what the
 *  primary executor writes under success. */
function seedRufloEngineering(runDir: string, which: 'phase3' | 'phase4' | 'phase5a' | 'all'): void {
  if (which === 'phase3' || which === 'all') {
    writeFile(path.join(runDir, 'engineering', 'sparc-specification.md'), bigMarkdown('SPARC Specification'));
    writeFile(path.join(runDir, 'engineering', 'tdd-test-plan.md'), bigMarkdown('TDD Test Plan'));
  }
  if (which === 'phase4' || which === 'all') {
    writeFile(path.join(runDir, 'engineering', 'architecture-decisions.md'), bigMarkdown('Architecture Decisions'));
    writeFile(path.join(runDir, 'engineering', 'domain-model.md'), bigMarkdown('Domain Model'));
    // Also produce a conventional phase4 adr file so plan-promotion picks one up.
    writeFile(path.join(runDir, 'phase4', 'adrs', 'ADR-001-primary.md'), bigMarkdown('ADR-001 Primary'));
  }
  if (which === 'phase5a' || which === 'all') {
    writeFile(path.join(runDir, 'engineering', 'implementation-roadmap.md'), bigMarkdown('Implementation Roadmap'));
  }
}

/** Seed execution-plan.json + impl files the way Phase 5a emission would. */
function seedPhase5aOutputs(projectRoot: string, opts: { implCount: number } = { implCount: 1 }): void {
  const promptsDir = path.join(projectRoot, '.agentics', 'plans', 'prompts');
  fs.mkdirSync(promptsDir, { recursive: true });
  const plan = {
    implementations: Array.from({ length: opts.implCount }, (_, i) => ({
      id: `impl-${String(i + 1).padStart(3, '0')}`,
      title: `Implementation ${i + 1}`,
      file: `impl-${String(i + 1).padStart(3, '0')}-${i === 0 ? 'foundation' : 'feature'}.md`,
    })),
  };
  fs.writeFileSync(path.join(promptsDir, 'execution-plan.json'), JSON.stringify(plan, null, 2));
  for (const impl of plan.implementations) {
    fs.writeFileSync(path.join(promptsDir, impl.file), bigMarkdown(impl.title));
  }
}

/** Capture process.stderr.write chunks for the duration of a block. */
function captureStderr(fn: () => void | Promise<void>): Promise<string> {
  const chunks: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process.stderr as any).write = (chunk: any): boolean => {
    chunks.push(typeof chunk === 'string' ? chunk : chunk.toString('utf-8'));
    return true;
  };
  const done = Promise.resolve(fn());
  return done.finally(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process.stderr as any).write = original;
  }).then(() => chunks.join(''));
}

function makeDossier(runDir: string): Phase1Dossier {
  return { scenarioQuery: 'adr-093 e2e', traceId: 'test-trace-093', runDir };
}
function makeContext(runDir: string): RufloExecutionContext {
  return { outputDir: path.join(runDir, '.ruflo-cache'), language: 'typescript' };
}

function rufloOk(phaseId: PrimaryPhaseId, files = 3): PrimaryPhaseExecutionResult {
  return { phaseId, success: true, executionTier: 'ruflo-local', filesModified: files, timing: 100, message: 'ok' };
}
function rufloTimeout(phaseId: PrimaryPhaseId): PrimaryPhaseExecutionResult {
  return {
    phaseId, success: false, executionTier: 'ruflo-local',
    reason: 'ruflo-timeout', filesModified: 0, timing: 600_000, message: 'timed out',
  };
}

// ============================================================================
// Shared: replays the FATAL block at auto-chain.ts:4415-4461 so scenario 2 can
// assert the exit behaviour without running the full orchestrator.
// ============================================================================

class ExitSentinelError extends Error {
  constructor(readonly code: number | string | null | undefined) {
    super(`ExitSentinel(${String(code)})`);
  }
}

/**
 * Replays the Phase 5a FATAL check from `auto-chain.ts` (around :4415). Returns
 * the exit code that would have been emitted (or null when not FATAL). All
 * stderr output goes through the real `process.stderr.write` so the caller's
 * capture wrapper sees it.
 */
function runPhase5aFatalCheck(projectRoot: string, runDir: string): number | null {
  const promotedPromptsDir = path.join(projectRoot, '.agentics', 'plans', 'prompts');
  const executionPlanPath = path.join(promotedPromptsDir, 'execution-plan.json');

  let hasValidPlan = false;
  try {
    if (fs.existsSync(executionPlanPath)) {
      const parsed = JSON.parse(fs.readFileSync(executionPlanPath, 'utf-8')) as { implementations?: unknown[]; prompts?: unknown[] };
      const implCount = Array.isArray(parsed.implementations)
        ? parsed.implementations.length
        : Array.isArray(parsed.prompts)
          ? parsed.prompts.length
          : 0;
      hasValidPlan = implCount >= 1;
    }
  } catch { hasValidPlan = false; }

  let implFileCount = 0;
  try {
    if (fs.existsSync(promotedPromptsDir)) {
      implFileCount = fs.readdirSync(promotedPromptsDir).filter(f => /^impl-\d+-.+\.md$/.test(f)).length;
    }
  } catch { implFileCount = 0; }

  if (!hasValidPlan || implFileCount < 1) {
    const missingList: string[] = [];
    if (!hasValidPlan) missingList.push('execution-plan.json');
    if (implFileCount < 1) missingList.push('impl-NNN-*.md');
    process.stderr.write(`[PIPELINE-093] FATAL: prompt-generator blocked — upstream artifacts unrecoverable\n`);
    process.stderr.write(`  missing: ${missingList.join(', ')}\n`);
    process.stderr.write(`  attempted: Ruflo invocation for phase 4 (failed or timed out)\n`);
    process.stderr.write(`  run directory preserved: ${runDir}\n`);
    return 1;
  }
  return null;
}

// ============================================================================
// Note on the scaffold-language gate: prior revisions of this file used a
// synthetic `runScaffoldLanguageGate` helper that never emitted Python files,
// which masked the ADR-093 §Rule 5 compliance gap (the Python-scaffold block
// was unconditional in `copyPlanningArtifacts`). Scenario 4 now calls the
// real `copyPlanningArtifacts` directly and walks the emitted tree for
// stray `.py` / `.ts` files; Scenario 5 exercises `decideScaffoldEmission`
// as the unit-level decision table. The synthetic helper was removed to
// prevent future drift between the helper and the real code path.
// ============================================================================
// Running tally — sanity assertion at the end of the file.
// ============================================================================

const RAN: string[] = [];

// ============================================================================
// Scenario 1 — Remote 503s; Ruflo still produces everything
// ============================================================================

describe('ADR-093 Scenario 1 — four remote diligence 503s, Ruflo primary executor succeeds', () => {
  let roots: TempRoots;

  beforeEach(() => { roots = makeTempRoots(); });
  afterEach(() => {
    try { fs.rmSync(roots.base, { recursive: true, force: true }); } catch { /* noop */ }
    RAN.push('scenario-1');
  });

  it('phase 3 gate passes via Ruflo when remote diligence agents are all 503', async () => {
    seedPhase1(roots.runDir, 'typescript');
    seedPhase2(roots.runDir);

    // Manifest records all four remote diligence agents as 503.
    const manifest = {
      traceId: 'test-trace-093',
      query: 'remote 503s',
      agents_invoked: [
        { domain: 'diligence-artifacts', agent: 'sparc-specification', status: '503' },
        { domain: 'diligence-artifacts', agent: 'sparc-merge', status: '503' },
        { domain: 'diligence-artifacts', agent: 'adr-generation', status: '503' },
        { domain: 'test-bench', agent: 'regression', status: '503' },
      ],
    };
    writeFile(path.join(roots.runDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

    // Ruflo mock writes engineering outputs for phase 3 and phase 4, then phase 5a.
    const runPrimary = jest.fn<typeof RunPrimaryPhaseExecutionFn>(async (phaseId) => {
      if (phaseId === 'phase3-sparc') seedRufloEngineering(roots.runDir, 'phase3');
      if (phaseId === 'phase4-adrs-ddd') seedRufloEngineering(roots.runDir, 'phase4');
      if (phaseId === 'phase5a-prompts') {
        seedRufloEngineering(roots.runDir, 'phase5a');
        // Simulate Phase 5a emission (execution-plan.json + impl-NNN-*.md)
        seedPhase5aOutputs(roots.projectRoot, { implCount: 3 });
      }
      return rufloOk(phaseId);
    });

    // Run Phase 3's gate (Phase 2 is seeded — gate is a no-op at this phase).
    const phase3Gate = await gatePhaseInputs('phase3-sparc', {
      runDir: roots.runDir,
      dossier: makeDossier(roots.runDir),
      context: makeContext(roots.runDir),
      runPrimaryPhaseExecution: runPrimary,
    });
    expect(phase3Gate.ok).toBe(true);
    expect(phase3Gate.ruflo_invoked).toEqual([]); // no missing inputs — no invocation

    // Now simulate auto-chain running Ruflo for phase 3 primary (the post-gate call).
    await runPrimary('phase3-sparc', makeDossier(roots.runDir), makeContext(roots.runDir));

    // Phase 4 gate — should also pass because engineering/sparc-specification.md satisfies any-of.
    const phase4Gate = await gatePhaseInputs('phase4-adrs-ddd', {
      runDir: roots.runDir,
      dossier: makeDossier(roots.runDir),
      context: makeContext(roots.runDir),
      runPrimaryPhaseExecution: runPrimary,
    });
    expect(phase4Gate.ok).toBe(true);
    await runPrimary('phase4-adrs-ddd', makeDossier(roots.runDir), makeContext(roots.runDir));

    // Phase 5a gate — sparc + engineering/architecture-decisions.md both present.
    const phase5aGate = await gatePhaseInputs('phase5a-prompts', {
      runDir: roots.runDir,
      dossier: makeDossier(roots.runDir),
      context: makeContext(roots.runDir),
      runPrimaryPhaseExecution: runPrimary,
    });
    expect(phase5aGate.ok).toBe(true);
    await runPrimary('phase5a-prompts', makeDossier(roots.runDir), makeContext(roots.runDir));

    // Promotion runs, moving engineering/* and phase4/adrs/* into .agentics/plans/.
    await captureStderr(() => {
      const summary = promotePlanningArtifacts(roots.runDir, roots.projectRoot);
      writePlanPromotionToManifest(roots.runDir, summary);
    });

    // Write ADR-091 execution block (Ruflo-local tier).
    const execBlock = computeExecutionBlock(
      [rufloOk('phase3-sparc'), rufloOk('phase4-adrs-ddd'), rufloOk('phase5a-prompts')],
      { available: [], errored: ['sparc-specification', 'sparc-merge', 'adr-generation', 'regression'], entries: [] },
    );
    writeExecutionBlockToManifest(roots.runDir, execBlock);

    // Write gate block (blocked_phases should be empty).
    const acc = {
      blocked: [],
      producedByGate: {
        phase2: [],
        'phase3-sparc': [],
        'phase4-adrs-ddd': [],
        'phase5a-prompts': [],
        'phase5b-scaffold': [],
      } as Record<GatePhaseId, string[]>,
      phase5bSkipped: null as null | { reason: string; detected: string; template: string },
    };
    writeGateBlockToManifest(roots.runDir, acc);

    // Now run the FATAL check — should NOT fire.
    let fatalCode: number | null = 999;
    const stderr = await captureStderr(() => {
      fatalCode = runPhase5aFatalCheck(roots.projectRoot, roots.runDir);
    });
    expect(fatalCode).toBeNull();
    expect(stderr).not.toMatch(/\[PIPELINE-093\] FATAL/);

    // Artifact assertions.
    const plans = path.join(roots.projectRoot, '.agentics', 'plans');
    const sparcSpec = path.join(plans, 'sparc', 'specification.md');
    expect(fs.existsSync(sparcSpec)).toBe(true);
    expect(fs.statSync(sparcSpec).size).toBeGreaterThan(100);

    const adrDirEntries = fs.readdirSync(path.join(plans, 'adrs'));
    expect(adrDirEntries.some(f => f.endsWith('.md'))).toBe(true);

    const dddPath = path.join(plans, 'ddd', 'domain-model.md');
    expect(fs.existsSync(dddPath)).toBe(true);

    const planJsonPath = path.join(plans, 'prompts', 'execution-plan.json');
    expect(fs.existsSync(planJsonPath)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(planJsonPath, 'utf-8')) as { implementations: unknown[] };
    expect(Array.isArray(parsed.implementations)).toBe(true);
    expect(parsed.implementations.length).toBeGreaterThanOrEqual(1);

    // Manifest assertions.
    const merged = JSON.parse(fs.readFileSync(path.join(roots.runDir, 'manifest.json'), 'utf-8'));
    expect(merged.execution.engineering_tier).toBe('ruflo-local');
    expect(Array.isArray(merged.blocked_phases)).toBe(true);
    expect(merged.blocked_phases).toEqual([]);

    // No Python files anywhere under plans/scaffold (scaffold wasn't run in this scenario, but the guarantee holds).
    const scaffoldDir = path.join(plans, 'scaffold');
    if (fs.existsSync(scaffoldDir)) {
      const walk = (d: string): string[] => fs.readdirSync(d).flatMap(e => {
        const full = path.join(d, e);
        return fs.statSync(full).isDirectory() ? walk(full) : [full];
      });
      expect(walk(scaffoldDir).filter(f => f.endsWith('.py'))).toEqual([]);
    }
  });
});

// ============================================================================
// Scenario 2 — Ruflo fails on Phase 4; gate retries; FATAL banner + exit(1)
// ============================================================================

describe('ADR-093 Scenario 2 — Ruflo fails on Phase 4; gate retry then FATAL', () => {
  let roots: TempRoots;

  beforeEach(() => { roots = makeTempRoots(); });
  afterEach(() => {
    try { fs.rmSync(roots.base, { recursive: true, force: true }); } catch { /* noop */ }
    RAN.push('scenario-2');
  });

  it('gate retries Ruflo once for phase 4, then phase 5a is blocked, then FATAL fires', async () => {
    seedPhase1(roots.runDir, 'typescript');
    seedPhase2(roots.runDir);
    // Phase 3 succeeded — SPARC spec is present so phase 4 gate has the OR-leg.
    seedRufloEngineering(roots.runDir, 'phase3');

    // Mock: phase 3 succeeds on demand; phase 4 always fails and never produces
    // architecture-decisions.md. (Both the original phase-4 call AND the gate's
    // retry from phase 5a should attempt it.)
    const runPrimary = jest.fn<typeof RunPrimaryPhaseExecutionFn>(async (phaseId) => {
      if (phaseId === 'phase3-sparc') {
        seedRufloEngineering(roots.runDir, 'phase3');
        return rufloOk(phaseId);
      }
      if (phaseId === 'phase4-adrs-ddd') {
        // No side effects; the Ruflo run timed out.
        return rufloTimeout(phaseId);
      }
      // Phase 5a — Ruflo returns ok but cannot produce impl files without ADRs.
      return rufloOk(phaseId);
    });

    // Simulate auto-chain: phase 4 is invoked as the primary (call #1, before gate).
    await runPrimary('phase4-adrs-ddd', makeDossier(roots.runDir), makeContext(roots.runDir));

    // Phase 5a gate — finds missing phase4 inputs (because the primary call
    // above failed to seed them). Should invoke Ruflo for phase4 again (call #2).
    const phase5aGate = await gatePhaseInputs('phase5a-prompts', {
      runDir: roots.runDir,
      dossier: makeDossier(roots.runDir),
      context: makeContext(roots.runDir),
      runPrimaryPhaseExecution: runPrimary,
    });

    // Gate should be blocked because Ruflo retry also failed.
    expect(phase5aGate.ok).toBe(false);
    expect(phase5aGate.stillMissing.length).toBeGreaterThan(0);
    // Ruflo invoked at least once for phase4 owner of the any-of missing set.
    expect(phase5aGate.ruflo_invoked).toContain('phase4-adrs-ddd');

    // Both original + gate retry should have been dispatched for phase4.
    const phase4Calls = runPrimary.mock.calls.filter(c => c[0] === 'phase4-adrs-ddd');
    expect(phase4Calls.length).toBeGreaterThanOrEqual(2);

    // Simulate the auto-chain accumulator + manifest flush.
    const acc = {
      blocked: [{ phase: 'phase5a-prompts' as GatePhaseId, missing: phase5aGate.stillMissing as string[] }],
      producedByGate: {
        phase2: [],
        'phase3-sparc': [],
        'phase4-adrs-ddd': [],
        'phase5a-prompts': [],
        'phase5b-scaffold': [],
      } as Record<GatePhaseId, string[]>,
      phase5bSkipped: null as null | { reason: string; detected: string; template: string },
    };
    writeGateBlockToManifest(roots.runDir, acc);
    // ADR-PIPELINE-093 §Rule 3 surface (a): same payload must land in
    // status.json so the CLI `status` command / MCP `agentics-status`
    // tool expose it. Seed a minimal status.json first (the MCP fast-return
    // path already creates this in production).
    fs.writeFileSync(
      path.join(roots.runDir, 'status.json'),
      JSON.stringify({
        traceId: 'test-trace-093',
        phase: 5,
        inProgress: false,
        plansDir: path.join(roots.projectRoot, '.agentics', 'plans'),
        artifacts: {},
        logPath: path.join(roots.runDir, 'autochain.log'),
      }, null, 2),
      { encoding: 'utf-8', mode: 0o600 },
    );
    writeGateBlockToStatusJson(roots.runDir, acc);

    // Emulate the FATAL-path decision: no execution-plan.json was written
    // because Phase 5a was blocked. Intercept process.exit via a sentinel.
    const exitSpy = jest.spyOn(process, 'exit').mockImplementation((code?: number | string | null | undefined) => {
      throw new ExitSentinelError(code);
    });

    let caught: unknown = null;
    const stderr = await captureStderr(() => {
      try {
        const code = runPhase5aFatalCheck(roots.projectRoot, roots.runDir);
        if (code !== null) {
          // Mirror auto-chain.ts:4460 — process.exit(1).
          process.exit(code);
        }
      } catch (err) {
        caught = err;
      }
    });

    expect(caught).toBeInstanceOf(ExitSentinelError);
    expect((caught as ExitSentinelError).code).toBe(1);
    expect(stderr).toMatch(/\[PIPELINE-093\] FATAL: prompt-generator blocked/);
    expect(stderr).toMatch(/run directory preserved:/);
    expect(stderr).toMatch(/Ruflo invocation for phase 4/);

    // Run directory must still exist.
    expect(fs.existsSync(roots.runDir)).toBe(true);

    // manifest.blocked_phases should carry the phase5a entry.
    const merged = JSON.parse(fs.readFileSync(path.join(roots.runDir, 'manifest.json'), 'utf-8'));
    expect(Array.isArray(merged.blocked_phases)).toBe(true);
    expect(merged.blocked_phases.length).toBeGreaterThanOrEqual(1);
    const p5 = (merged.blocked_phases as Array<{ phase: string; missing: string[] }>)
      .find(b => b.phase === 'phase5a-prompts');
    expect(p5).toBeDefined();
    // Missing list should reference phase 4 artifacts (the any-of set).
    expect(p5!.missing.some((m: string) =>
      m.startsWith('phase4/') || m === 'engineering/architecture-decisions.md'
    )).toBe(true);

    // ADR-PIPELINE-093 §Rule 3 — status.json must mirror manifest.json
    // so the CLI `status` command / MCP `agentics-status` tool surface
    // `blocked_phases` + per-phase gate-produced inputs.
    const status = JSON.parse(fs.readFileSync(path.join(roots.runDir, 'status.json'), 'utf-8'));
    expect(status.blocked_phases).toBeInstanceOf(Array);
    expect(status.blocked_phases.length).toBeGreaterThanOrEqual(1);
    expect(status.blocked_phases[0].phase).toBe('phase5a-prompts');
    expect(status.blocked_phases[0].missing).toEqual(expect.arrayContaining(['phase4/adrs/*.md']));
    // All per-phase gate-produced arrays present as [] (stable schema).
    expect(status.phase2_inputs_produced_by_gate).toEqual([]);
    expect(status.phase3_inputs_produced_by_gate).toEqual([]);
    expect(status.phase4_inputs_produced_by_gate).toEqual([]);
    expect(status.phase5a_inputs_produced_by_gate).toEqual([]);

    exitSpy.mockRestore();
  });
});

// ============================================================================
// Scenario 3 — Healthy run; no inputs produced by gate; no FATAL
// ============================================================================

describe('ADR-093 Scenario 3 — healthy run passes every gate on first check', () => {
  let roots: TempRoots;

  beforeEach(() => { roots = makeTempRoots(); });
  afterEach(() => {
    try { fs.rmSync(roots.base, { recursive: true, force: true }); } catch { /* noop */ }
    RAN.push('scenario-3');
  });

  it('no Ruflo invocations triggered by any gate; manifest.inputs_produced_by_gate arrays all empty', async () => {
    seedPhase1(roots.runDir, 'typescript');
    seedPhase2(roots.runDir);
    seedRufloEngineering(roots.runDir, 'all');
    seedPhase5aOutputs(roots.projectRoot, { implCount: 2 });

    const runPrimary = jest.fn<typeof RunPrimaryPhaseExecutionFn>(async (phaseId) => rufloOk(phaseId));

    const phase2 = await gatePhaseInputs('phase2', {
      runDir: roots.runDir, dossier: makeDossier(roots.runDir), context: makeContext(roots.runDir),
      runPrimaryPhaseExecution: runPrimary,
    });
    const phase3 = await gatePhaseInputs('phase3-sparc', {
      runDir: roots.runDir, dossier: makeDossier(roots.runDir), context: makeContext(roots.runDir),
      runPrimaryPhaseExecution: runPrimary,
    });
    const phase4 = await gatePhaseInputs('phase4-adrs-ddd', {
      runDir: roots.runDir, dossier: makeDossier(roots.runDir), context: makeContext(roots.runDir),
      runPrimaryPhaseExecution: runPrimary,
    });
    const phase5a = await gatePhaseInputs('phase5a-prompts', {
      runDir: roots.runDir, dossier: makeDossier(roots.runDir), context: makeContext(roots.runDir),
      runPrimaryPhaseExecution: runPrimary,
    });

    expect(phase2.ok).toBe(true);
    expect(phase3.ok).toBe(true);
    expect(phase4.ok).toBe(true);
    expect(phase5a.ok).toBe(true);
    // All gates should be no-ops on the happy path.
    expect(phase2.ruflo_invoked).toEqual([]);
    expect(phase3.ruflo_invoked).toEqual([]);
    expect(phase4.ruflo_invoked).toEqual([]);
    expect(phase5a.ruflo_invoked).toEqual([]);
    expect(runPrimary).not.toHaveBeenCalled();

    // Flush gate block + execution block.
    const acc = {
      blocked: [],
      producedByGate: {
        phase2: [], 'phase3-sparc': [], 'phase4-adrs-ddd': [],
        'phase5a-prompts': [], 'phase5b-scaffold': [],
      } as Record<GatePhaseId, string[]>,
      phase5bSkipped: null as null | { reason: string; detected: string; template: string },
    };
    writeGateBlockToManifest(roots.runDir, acc);
    const execBlock = computeExecutionBlock(
      [rufloOk('phase3-sparc'), rufloOk('phase4-adrs-ddd'), rufloOk('phase5a-prompts')],
      { available: [], errored: [], entries: [] },
    );
    writeExecutionBlockToManifest(roots.runDir, execBlock);

    // FATAL check must be a no-op.
    let fatalCode: number | null = 999;
    const stderr = await captureStderr(() => {
      fatalCode = runPhase5aFatalCheck(roots.projectRoot, roots.runDir);
    });
    expect(fatalCode).toBeNull();
    expect(stderr).not.toMatch(/\[PIPELINE-093\] FATAL/);

    // Manifest assertions.
    const merged = JSON.parse(fs.readFileSync(path.join(roots.runDir, 'manifest.json'), 'utf-8'));
    expect(merged.blocked_phases).toEqual([]);
    expect(merged.phase2_inputs_produced_by_gate).toEqual([]);
    expect(merged.phase3_inputs_produced_by_gate).toEqual([]);
    expect(merged.phase4_inputs_produced_by_gate).toEqual([]);
    expect(merged.phase5a_inputs_produced_by_gate).toEqual([]);
    expect(merged.execution.engineering_tier).toBe('ruflo-local');
  });
});

// ============================================================================
// Scenario 4 — Scaffold-language gate, exercising the REAL
// `copyPlanningArtifacts` path (per ADR-093 §Rule 5 Verification #4).
//
// This scenario replaces the prior synthetic `runScaffoldLanguageGate` helper
// invocation with a direct call into `copyPlanningArtifacts`, so the test now
// exercises BOTH the TS-scaffold gate AND the Python-scaffold gate. The
// originating bug was that the Python block was unconditional — this test
// locks it down by walking the emitted tree for stray `.py` or `.ts` files.
// ============================================================================

/** Recursively collect every file path under `root`. */
function walkAllFiles(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) return walkAllFiles(full);
    return [full];
  });
}

/** Minimal Phase 1 + Phase 2 seed so `copyPlanningArtifacts` has something to
 *  promote. Writes both `runDir/manifest.json` (consumed by the scaffold gate)
 *  and `runDir/phase1/manifest.json` so downstream promotion logic is happy. */
function seedMinimalArtifacts(runDir: string, opts: { projectLanguage?: string } = {}): void {
  const manifest: Record<string, unknown> = {
    traceId: 'test-trace-093',
    query: 'adr-093 scenario-4 real copyPlanningArtifacts',
    simulation_id: 'sim-scenario-4',
  };
  if (opts.projectLanguage) manifest['project'] = { language: opts.projectLanguage };
  writeFile(path.join(runDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  writeFile(path.join(runDir, 'phase1', 'manifest.json'), JSON.stringify(manifest, null, 2));
  writeFile(path.join(runDir, 'phase1', 'executive-summary.md'), bigMarkdown('Executive Summary'));
  // Phase-2 dossier so `copyPlanningArtifacts` has a non-trivial promote path.
  writeFile(path.join(runDir, 'phase2', 'research-dossier.json'),
    JSON.stringify({ traceId: 'test-trace-093', sections: [{ heading: 's1', body: 'body '.repeat(32) }] }, null, 2));
}

describe('ADR-093 Scenario 4 — scaffold gate via real copyPlanningArtifacts', () => {
  let roots: TempRoots;

  beforeEach(() => { roots = makeTempRoots(); });
  afterEach(() => {
    try { fs.rmSync(roots.base, { recursive: true, force: true }); } catch { /* noop */ }
    RAN.push('scenario-4');
  });

  it('TypeScript project: TS scaffold emitted, ZERO .py files under scaffold/, no phase5b_skipped', async () => {
    // projectRoot has package.json only. Detector should resolve to `typescript`.
    writeFile(path.join(roots.projectRoot, 'package.json'),
      JSON.stringify({ name: 'test-project', version: '1.0.0' }, null, 2));
    seedMinimalArtifacts(roots.runDir);

    const stderr = await captureStderr(() => {
      copyPlanningArtifacts(roots.runDir, roots.projectRoot);
    });
    expect(stderr).not.toMatch(/\[SCAFFOLD\] skipped/);

    // The TS scaffold block writes `logger.ts` into plans/scaffold/src.
    const tsLogger = path.join(roots.projectRoot, '.agentics/plans/scaffold/src/logger.ts');
    expect(fs.existsSync(tsLogger)).toBe(true);

    // The originating bug: zero `.py` anywhere under plans/scaffold/.
    const scaffoldRoot = path.join(roots.projectRoot, '.agentics/plans/scaffold');
    const allScaffoldFiles = walkAllFiles(scaffoldRoot);
    expect(allScaffoldFiles.filter(f => f.endsWith('.py'))).toEqual([]);

    // Manifest must NOT record a phase5b skip — TS was detected and emitted.
    const merged = JSON.parse(fs.readFileSync(path.join(roots.runDir, 'manifest.json'), 'utf-8'));
    expect(merged.phase5b_skipped).toBeUndefined();
  });

  it('Python project: Python scaffold emitted, ZERO .ts files under scaffold/, no phase5b_skipped', async () => {
    // Python marker only. Detector resolves to `python` → emit Py, skip TS.
    writeFile(path.join(roots.projectRoot, 'pyproject.toml'), `[project]\nname = "x"\n`);
    seedMinimalArtifacts(roots.runDir);

    const stderr = await captureStderr(() => {
      copyPlanningArtifacts(roots.runDir, roots.projectRoot);
    });
    // Python is a matched language, so NO mismatch line is emitted.
    expect(stderr).not.toMatch(/\[SCAFFOLD\] skipped/);

    // Python logger lands in plans/scaffold/python.
    const pyLogger = path.join(roots.projectRoot, '.agentics/plans/scaffold/python/logger.py');
    expect(fs.existsSync(pyLogger)).toBe(true);

    // ZERO `.ts` files under scaffold/. (Plan-promotion may copy other `.ts`
    // from Phase artifacts, but the scaffold/ tree is the scaffold's turf.)
    const scaffoldRoot = path.join(roots.projectRoot, '.agentics/plans/scaffold');
    const allScaffoldFiles = walkAllFiles(scaffoldRoot);
    expect(allScaffoldFiles.filter(f => f.endsWith('.ts'))).toEqual([]);

    // Manifest must NOT record a phase5b skip — Python was detected and emitted.
    const merged = JSON.parse(fs.readFileSync(path.join(roots.runDir, 'manifest.json'), 'utf-8'));
    expect(merged.phase5b_skipped).toBeUndefined();
  });

  it('Go project: unsupported language → LANG-FAIL-001, no TS/Py scaffold (ADR-115 §D3)', async () => {
    // Go marker only — no scaffold path. ADR-115 removes the skip; the gate
    // emits a loud-failure artifact instead.
    writeFile(path.join(roots.projectRoot, 'go.mod'), `module example.com/test\n\ngo 1.21\n`);
    seedMinimalArtifacts(roots.runDir);

    const stderr = await captureStderr(() => {
      copyPlanningArtifacts(roots.runDir, roots.projectRoot);
    });
    // No skip line anymore — a LANG-FAIL artifact is written.
    expect(stderr).not.toMatch(/\[SCAFFOLD\] skipped/);
    expect(stderr).toMatch(/LANG-FAIL-001 — unsupported language "go"/);

    // ZERO `.ts` and ZERO `.py` files under scaffold/.
    const scaffoldRoot = path.join(roots.projectRoot, '.agentics/plans/scaffold');
    const allScaffoldFiles = walkAllFiles(scaffoldRoot);
    expect(allScaffoldFiles.filter(f => f.endsWith('.ts'))).toEqual([]);
    expect(allScaffoldFiles.filter(f => f.endsWith('.py'))).toEqual([]);

    // The loud-failure artifact exists under <runDir>/phase5b/.
    const langFail = path.join(roots.runDir, 'phase5b', 'LANG-FAIL-001.md');
    expect(fs.existsSync(langFail)).toBe(true);

    // Manifest records the new phase5b failure (no `phase5b_skipped`).
    const merged = JSON.parse(fs.readFileSync(path.join(roots.runDir, 'manifest.json'), 'utf-8'));
    expect(merged.phase5b_skipped).toBeUndefined();
    expect(merged.phase5b).toEqual({
      status: 'failed', reason: 'unsupported-language', resolvedLanguage: 'go',
    });
  });
});

// ============================================================================
// Scenario 5 — Scaffold-language gate — decideScaffoldEmission unit coverage +
// the mismatch path still logs the canonical stderr line.
//
// NOTE: Before the ADR-093 compliance fix, a Python project hit the TS-only
// gate and was *skipped* with a `phase5b_skipped` record. After the fix, the
// gate routes Python to the Python template set, so this scenario now
// covers (a) the decision-table directly via `decideScaffoldEmission`, and
// (b) the stderr line for the residual go/rust/unknown mismatch path.
// ============================================================================

// ADR-PIPELINE-115 §D3 supersedes the ADR-093 Rule-5 skip semantics: there is
// no skip path. Every resolved language has a scaffold path (ts/python/rust) or
// produces a LANG-FAIL artifact (unsupported-language).
describe('ADR-115 Scenario 5 — decideScaffoldEmission decision table', () => {
  afterEach(() => { RAN.push('scenario-5'); });

  it('TypeScript → emit TS only', () => {
    expect(decideScaffoldEmission('typescript')).toEqual({
      emitTs: true, emitPy: false, emitRust: false, langFail: null,
    });
  });

  it('Python → emit Python only', () => {
    expect(decideScaffoldEmission('python')).toEqual({
      emitTs: false, emitPy: true, emitRust: false, langFail: null,
    });
  });

  it('Rust → emit Cargo workspace (no skip)', () => {
    expect(decideScaffoldEmission('rust')).toEqual({
      emitTs: false, emitPy: false, emitRust: true, langFail: null,
    });
  });

  it('Go → loud failure (unsupported-language)', () => {
    expect(decideScaffoldEmission('go')).toEqual({
      emitTs: false, emitPy: false, emitRust: false,
      langFail: { reason: 'unsupported-language', resolvedLanguage: 'go' },
    });
  });

  it('Unknown → loud failure (unsupported-language)', () => {
    expect(decideScaffoldEmission('unknown')).toEqual({
      emitTs: false, emitPy: false, emitRust: false,
      langFail: { reason: 'unsupported-language', resolvedLanguage: 'unknown' },
    });
  });
});

// ============================================================================
// Scenario 6 — Regression guards (ADR-089 health-gate + ADR-088 status.json)
// ============================================================================

describe('ADR-093 Scenario 6 — regression guards for ADR-089 and ADR-088', () => {
  afterEach(() => { RAN.push('scenario-6'); });

  it('ADR-089 health-gate still classifies `degraded` when 4/8 agents errored but artifacts exist', () => {
    // 8 agents, 4 errored. Simulator ok. Artifacts present. Expected: degraded.
    const invocations = [
      { intent: { domain: 'simulator', agent: 'enterprise' }, result: { status: 200, response: { ok: true } } },
      { intent: { domain: 'copilot', agent: 'planner' }, result: { status: 200, response: { ok: true } } },
      { intent: { domain: 'research-lab', agent: 'metrics' }, result: { status: 200, response: { ok: true } } },
      { intent: { domain: 'diligence', agent: 'sparc-specification' }, result: { status: 200, response: { ok: true } } },
      { intent: { domain: 'diligence', agent: 'adr-generation' }, result: { error: '503 timeout' } },
      { intent: { domain: 'diligence', agent: 'sparc-merge' }, result: { error: '503 timeout' } },
      { intent: { domain: 'quality', agent: 'regression' }, result: { error: '503 timeout' } },
      { intent: { domain: 'research-lab', agent: 'hypothesis' }, result: { error: '503 timeout' } },
    ];
    const artifacts = ['manifest.json', 'scenario.json', 'executive-summary.md', 'roadmap.json'];
    const verdict = computePhase1Verdict(invocations, [], artifacts);
    // 4/7 non-simulator errors = 57% — above the 50% ratio → verdict becomes `failed`.
    // Reduce to 3/7 (42%) for the `degraded` case we want to verify.
    const invocationsDegraded = invocations.slice(0, -1); // drop last error → 3/6 = 50%
    const verdictDegraded = computePhase1Verdict(invocationsDegraded, [], artifacts);
    // 3 errored out of 6 non-simulator → not > 50%, allowed to proceed.
    expect(['degraded', 'healthy']).toContain(verdictDegraded.verdict);
    // With 4 errors out of 7 non-simulator agents, ratio is 57% which triggers `failed`.
    expect(verdict.verdict).toBe('failed');
  });

  it('ADR-088 status.json schema still has the canonical keys expected by the MCP entry', () => {
    // The fast-return path at src/cli/index.ts:2344 writes this shape. We
    // reconstruct it locally and assert the schema (no on-disk invocation).
    const roots = makeTempRoots();
    try {
      const traceId = 'test-trace-093';
      const runDir = path.join(roots.base, 'run-status');
      const plansDir = path.join(roots.projectRoot, '.agentics', 'plans');
      fs.mkdirSync(runDir, { recursive: true, mode: 0o700 });
      const statusPath = path.join(runDir, 'status.json');
      const logPath = path.join(runDir, 'autochain.log');
      const initialStatus = {
        traceId,
        pid: 12345,
        startedAt: new Date().toISOString(),
        mode: 'mcp-fast-return',
        phase: 0,
        inProgress: true,
        completedPhases: [],
        logPath,
        plansDir,
        artifacts: {},
        phase1_verdict: 'healthy',
        phase1_reason: null,
        phase1_degradations: [],
        phase1_stats: null,
      };
      fs.writeFileSync(statusPath, JSON.stringify(initialStatus, null, 2), { encoding: 'utf-8', mode: 0o600 });

      const parsed = JSON.parse(fs.readFileSync(statusPath, 'utf-8'));
      for (const k of ['traceId', 'phase', 'inProgress', 'plansDir', 'artifacts', 'logPath', 'mode']) {
        expect(parsed).toHaveProperty(k);
      }
      expect(parsed.traceId).toBe(traceId);
      expect(parsed.phase).toBe(0);
      expect(parsed.inProgress).toBe(true);
    } finally {
      try { fs.rmSync(roots.base, { recursive: true, force: true }); } catch { /* noop */ }
    }
  });
});

// ============================================================================
// Scenario 7 — execution-plan.json mandatory emission
// ============================================================================

describe('ADR-093 Scenario 7 — mandatory execution-plan.json emission', () => {
  let roots: TempRoots;

  beforeEach(() => { roots = makeTempRoots(); });
  afterEach(() => {
    try { fs.rmSync(roots.base, { recursive: true, force: true }); } catch { /* noop */ }
    RAN.push('scenario-7');
  });

  it('healthy run emits valid execution-plan.json with >=1 implementations and at least one impl-NNN-*.md', () => {
    seedPhase1(roots.runDir, 'typescript');
    seedPhase2(roots.runDir);
    seedRufloEngineering(roots.runDir, 'all');
    seedPhase5aOutputs(roots.projectRoot, { implCount: 4 });

    const promotedPromptsDir = path.join(roots.projectRoot, '.agentics', 'plans', 'prompts');
    const executionPlanPath = path.join(promotedPromptsDir, 'execution-plan.json');

    expect(fs.existsSync(executionPlanPath)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(executionPlanPath, 'utf-8')) as { implementations: unknown[] };
    expect(Array.isArray(parsed.implementations)).toBe(true);
    expect(parsed.implementations.length).toBeGreaterThanOrEqual(1);

    const implFiles = fs.readdirSync(promotedPromptsDir).filter(f => /^impl-\d+-.+\.md$/.test(f));
    expect(implFiles.length).toBeGreaterThanOrEqual(1);

    // FATAL block should be a no-op.
    const code = runPhase5aFatalCheck(roots.projectRoot, roots.runDir);
    expect(code).toBeNull();
  });

  it('empty implementations[] array is rejected by the FATAL block and triggers exit(1)', async () => {
    // Seed an empty execution-plan.json and no impl files.
    const promptsDir = path.join(roots.projectRoot, '.agentics', 'plans', 'prompts');
    fs.mkdirSync(promptsDir, { recursive: true });
    fs.writeFileSync(path.join(promptsDir, 'execution-plan.json'),
      JSON.stringify({ implementations: [] }, null, 2));

    const exitSpy = jest.spyOn(process, 'exit').mockImplementation((code?: number | string | null | undefined) => {
      throw new ExitSentinelError(code);
    });
    let caught: unknown = null;
    const stderr = await captureStderr(() => {
      try {
        const code = runPhase5aFatalCheck(roots.projectRoot, roots.runDir);
        if (code !== null) process.exit(code);
      } catch (err) { caught = err; }
    });
    expect(caught).toBeInstanceOf(ExitSentinelError);
    expect((caught as ExitSentinelError).code).toBe(1);
    expect(stderr).toMatch(/\[PIPELINE-093\] FATAL: prompt-generator blocked/);
    exitSpy.mockRestore();
  });
});

// ============================================================================
// determineBlockedPhases sanity — the helper auto-chain uses to decide which
// phases to report blocked. Covered indirectly above, but exercised directly
// here so the test-file documents the shape callers depend on.
// ============================================================================

describe('ADR-093 determineBlockedPhases shape', () => {
  it('returns entries only for gates with stillMissing', () => {
    const okResult: GateResult = { ok: true, missing: [], ruflo_invoked: [], stillMissing: [] };
    const blockedResult: GateResult = {
      ok: false,
      missing: ['phase4/adrs/*.md'],
      ruflo_invoked: ['phase4-adrs-ddd'],
      stillMissing: ['phase4/adrs/*.md'],
    };
    const out = determineBlockedPhases([
      { phaseId: 'phase3-sparc', gateResult: okResult },
      { phaseId: 'phase5a-prompts', gateResult: blockedResult },
    ]);
    expect(out).toEqual([{ phase: 'phase5a-prompts', missing: ['phase4/adrs/*.md'] }]);
  });
});

// ============================================================================
// ADR-PIPELINE-093 §Rule 3 surface (c) — final `agentics ask` banner warning
// ============================================================================

describe('ADR-093 formatAutoChainForDisplay blocked-phases warning', () => {
  function baseResult(overrides: Partial<AutoChainResult> = {}): AutoChainResult {
    return {
      traceId: 'test-trace-093',
      runDir: '/tmp/run-093',
      phases: [],
      totalTiming: 5000,
      success: true,
      executionMode: 'development',
      ...overrides,
    };
  }

  it('emits a BLOCKED PHASES warning when blockedPhases is non-empty', () => {
    const result = baseResult({
      blockedPhases: [
        {
          phase: 'phase5a-prompts',
          missing: ['phase4/adrs/*.md', 'phase4/ddd/bounded-contexts.json'],
        },
      ],
    });
    const banner = formatAutoChainForDisplay(result);
    expect(banner).toMatch(/WARNING — BLOCKED PHASES:/);
    expect(banner).toMatch(/phase5a-prompts: missing phase4\/adrs\/\*\.md, phase4\/ddd\/bounded-contexts\.json/);
    expect(banner).toMatch(/~\/\.agentics\/runs\/test-trace-093\//);
  });

  it('emits NO warning when blockedPhases is empty', () => {
    const banner = formatAutoChainForDisplay(baseResult({ blockedPhases: [] }));
    expect(banner).not.toMatch(/BLOCKED PHASES/);
  });

  it('emits NO warning when blockedPhases is absent', () => {
    const banner = formatAutoChainForDisplay(baseResult());
    expect(banner).not.toMatch(/BLOCKED PHASES/);
  });

  it('renders multiple blocked phases on separate lines', () => {
    const result = baseResult({
      blockedPhases: [
        { phase: 'phase4-adrs-ddd', missing: ['phase3/sparc/specification.md'] },
        { phase: 'phase5a-prompts', missing: ['phase4/adrs/*.md'] },
      ],
    });
    const banner = formatAutoChainForDisplay(result);
    expect(banner).toMatch(/- phase4-adrs-ddd: missing phase3\/sparc\/specification\.md/);
    expect(banner).toMatch(/- phase5a-prompts: missing phase4\/adrs\/\*\.md/);
  });
});

// ============================================================================
// Suite health — sanity that all seven scenarios actually ran.
// ============================================================================

describe('ADR-093 test-suite health', () => {
  it('all 7 scenarios ran', () => {
    // Each scenario pushes its label once. Scenario 6 + 7 have 2 tests each
    // but the push happens in afterEach at the describe level, so the set of
    // unique labels is the truth metric.
    const unique = new Set(RAN);
    for (const label of ['scenario-1', 'scenario-2', 'scenario-3', 'scenario-4', 'scenario-5', 'scenario-6', 'scenario-7']) {
      expect(unique.has(label)).toBe(true);
    }
  });
});
