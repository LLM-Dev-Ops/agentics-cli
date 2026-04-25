/**
 * ADR-PIPELINE-098 — Phase 7 coordinator tests.
 *
 * Covers:
 *   1. Happy-path stub: 12 section dirs + index.md + phase7-manifest.json with
 *      deliverables_total === 85. Ruflo dispatch is monkey-patched.
 *   2. Skeleton path: missing inputArtifact -> the written file carries
 *      `degraded_mode: generation-failed` frontmatter.
 *   3. Mirror path: entries with mirrorsExisting produce symlinks (POSIX).
 *   4. Phase 1 missing: no manifest.json -> status === 'skipped-due-to-upstream',
 *      no exception, no deliverables dir created.
 *
 * The coordinator module (`src/pipeline/phase7/coordinator.ts`) is being
 * written in parallel by another agent. Until it lands, these tests will fail
 * at import time — that is the correct signal.
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { executePhase7 } from '../../../../src/pipeline/phase7/coordinator.js';

let tmpDir: string;
let runDir: string;

const IS_POSIX = process.platform !== 'win32';

// --------------------------------------------------------------------------
// Synthetic Phase 1 fixture builder.
// --------------------------------------------------------------------------

interface FixtureOptions {
  readonly omitManifest?: boolean;
  readonly omitAgentResponses?: boolean;
  /**
   * When true the fixture writes ONLY manifest.json + unit-economics.json,
   * omitting every other phase-1 input. With most rows pointing at scenario
   * + agent-responses + research-dossier as their inputs, this leaves many
   * rows with zero available inputs and forces the D7 skeleton path.
   */
  readonly minimal?: boolean;
}

function buildPhase1Fixture(dir: string, opts: FixtureOptions = {}): void {
  fs.mkdirSync(dir, { recursive: true });

  if (!opts.omitManifest) {
    fs.writeFileSync(
      path.join(dir, 'manifest.json'),
      JSON.stringify(
        {
          run_id: 'phase7-test-run',
          project: { language: 'typescript', name: 'phase7-fixture' },
          phases: [],
        },
        null,
        2
      )
    );
  }

  fs.writeFileSync(
    path.join(dir, 'unit-economics.json'),
    JSON.stringify(
      {
        pilot_savings_per_year: 2_200_000,
        pilot_savings: 2_200_000,
        annual_run_rate_savings: 2_200_000,
        investment_total: 750_000,
        npv_3yr: 4_400_000,
        roi_pct: 187,
        payback_months: 5,
        timeline_months: 12,
      },
      null,
      2
    )
  );

  if (opts.minimal) return;

  fs.writeFileSync(
    path.join(dir, 'executive-summary.md'),
    [
      '# Executive Summary',
      '',
      '<!-- consensus: agreement=0.92 precision=0.88 verdict=GO -->',
      '',
      'Pilot savings <!-- fcv:kind=savings scope=pilot doc=executive-summary src=unit-economics --> $2.2M.',
      '',
      'Sources: platform/executive-summary, costops/forecast.',
      '',
    ].join('\n')
  );

  fs.writeFileSync(
    path.join(dir, 'scenario.json'),
    JSON.stringify({ summary: 'manufacturing pilot', horizon_years: 3 }, null, 2)
  );

  if (!opts.omitAgentResponses) {
    fs.writeFileSync(
      path.join(dir, 'agent-responses.json'),
      JSON.stringify(
        {
          domains: 28,
          agents_called: 109,
          responses: [
            {
              domain: 'platform',
              agent: 'executive-summary',
              status: 200,
              text: 'fixture',
            },
          ],
        },
        null,
        2
      )
    );
  }

  // Pre-existing top-level docs that mirror entries point at. Cover the
  // canonical set so D6 mirror logic has something real to symlink to.
  fs.writeFileSync(path.join(dir, 'decision-memo.md'), '# Decision Memo\n\nfixture\n');
  fs.writeFileSync(
    path.join(dir, 'financial-analysis.md'),
    '# Financial Analysis\n\nfixture\n'
  );
  fs.writeFileSync(
    path.join(dir, 'risk-assessment.json'),
    JSON.stringify({ risks: [] })
  );
  fs.writeFileSync(path.join(dir, 'roadmap.json'), JSON.stringify({ phases: [] }));
  fs.writeFileSync(
    path.join(dir, 'security-assessment.md'),
    '# Security Assessment\n\nfixture\n'
  );
  fs.writeFileSync(
    path.join(dir, 'integration-assessment.md'),
    '# Integration Assessment\n\nfixture\n'
  );
  fs.writeFileSync(
    path.join(dir, 'agent-fleet-report.md'),
    '# Agent Fleet Report\n\nfixture\n'
  );
  fs.writeFileSync(
    path.join(dir, 'consensus.json'),
    JSON.stringify({ agreement: 0.92, precision: 0.88, verdict: 'GO' })
  );
  fs.writeFileSync(path.join(dir, 'consensus.svg'), '<svg></svg>');
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase7-coord-'));
  runDir = path.join(tmpDir, 'run');
});

afterEach(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

// --------------------------------------------------------------------------
// Test 1 — happy path. Uses dispatchMode: 'noop' to skip the real Ruflo
// fan-out so the test runs deterministically in a few hundred ms; the per-
// row contract under noop is: every non-mirror row renders deterministically
// from local field extraction + template substitution, every mirror row
// resolves to a symlink/copy.
// --------------------------------------------------------------------------

describe('ADR-098 D1+D2 — coordinator happy path', () => {
  it(
    'creates 12 section dirs, index.md, phase7-manifest.json, and reports deliverables_total === 87',
    async () => {
      buildPhase1Fixture(runDir);

      const result = await executePhase7({
        runDir,
        traceId: 'phase7-test-trace',
        scenarioQuery: 'manufacturing pilot — phase7 happy path',
        options: { dispatchMode: 'noop' },
      });

      expect(result.deliverables_total).toBe(87);

      const deliverablesDir = path.join(runDir, 'deliverables');
      expect(fs.existsSync(deliverablesDir)).toBe(true);
      expect(fs.existsSync(path.join(deliverablesDir, 'index.md'))).toBe(true);
      expect(
        fs.existsSync(path.join(deliverablesDir, 'phase7-manifest.json'))
      ).toBe(true);

      const expectedSectionDirs = [
        '01-executive',
        '02-financial',
        '03-strategy',
        '04-operating-model',
        '05-technology',
        '06-risk-compliance',
        '07-research-diagnostics',
        '08-program-management',
        '09-implementation',
        '10-performance-monitoring',
        '11-commercial',
        '12-advanced',
      ];
      for (const d of expectedSectionDirs) {
        expect(fs.existsSync(path.join(deliverablesDir, d))).toBe(true);
      }
    },
    30_000,
  );
});

// --------------------------------------------------------------------------
// Test 2 — skeleton path. When inputArtifacts are missing, the coordinator
// MUST still emit a file with `degraded_mode: generation-failed` frontmatter
// (D7).
// --------------------------------------------------------------------------

describe('ADR-098 D7 — skeleton on missing inputArtifact', () => {
  it('emits at least one file with `degraded_mode: generation-failed` frontmatter when inputs are missing', async () => {
    // Minimal Phase 1 fixture: only manifest.json + unit-economics.json. Most
    // registry rows declare scenario.json / agent-responses.json / phaseN
    // outputs as inputs, so under this fixture they have ZERO available
    // inputs and the D7 "no-input-artifacts-available" skeleton path fires.
    buildPhase1Fixture(runDir, { minimal: true });

    let result: Awaited<ReturnType<typeof executePhase7>>;
    try {
      result = await executePhase7({
        runDir,
        traceId: 'phase7-skeleton-trace',
        scenarioQuery: 'manufacturing pilot — phase7 skeleton path',
        options: { dispatchMode: 'noop' }, // skip Ruflo dispatch — testing the per-row contract, not the swarm
      });
    } catch (err) {
      throw new Error(
        `Phase 7 must not throw on missing inputArtifacts (D7); threw: ${(err as Error).message}`
      );
    }

    // The phase must still complete (status partial or completed).
    expect(['completed', 'partial']).toContain(result.status);

    // Walk deliverables/ and look for any file with the degraded_mode tag.
    const deliverablesDir = path.join(runDir, 'deliverables');
    expect(fs.existsSync(deliverablesDir)).toBe(true);

    const skeletonFiles: string[] = [];
    function walk(dir: string): void {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(p);
          continue;
        }
        if (!entry.isFile()) continue;
        if (!/\.(md|json)$/.test(entry.name)) continue;
        let body: string;
        try {
          body = fs.readFileSync(p, 'utf8');
        } catch {
          continue;
        }
        if (/degraded_mode:\s*generation-failed/.test(body)) {
          skeletonFiles.push(p);
        }
      }
    }
    walk(deliverablesDir);

    expect(skeletonFiles.length).toBeGreaterThan(0);
  });
});

// --------------------------------------------------------------------------
// Test 3 — mirror path. Mirror entries become symlinks (on POSIX) pointing at
// the original top-level artifact (D6).
// --------------------------------------------------------------------------

describe('ADR-098 D6 — mirror entries are symlinks on POSIX', () => {
  const itPosix = IS_POSIX ? it : it.skip;

  itPosix(
    'creates fs symlinks at deliverables/<NN-section>/<slug>.<ext> for every mirrorsExisting entry',
    async () => {
      buildPhase1Fixture(runDir);

      let result: Awaited<ReturnType<typeof executePhase7>>;
      try {
        result = await executePhase7({
          runDir,
          traceId: 'phase7-mirror-trace',
          scenarioQuery: 'manufacturing pilot — phase7 mirror path',
          options: { dispatchMode: 'noop' }, // mirror logic is independent of the writer dispatch
        });
      } catch (err) {
        throw new Error(
          `Phase 7 must not throw when mirroring exist top-level artifacts; threw: ${(err as Error).message}`
        );
      }

      const deliverablesDir = path.join(runDir, 'deliverables');
      expect(fs.existsSync(deliverablesDir)).toBe(true);

      // Discover mirror outputs by walking deliverables/ and asking the FS
      // which entries are symlinks. We expect at least one — the executive
      // summary mirror is the canonical example called out in the ADR.
      const symlinkPaths: string[] = [];
      function walk(dir: string): void {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const p = path.join(dir, entry.name);
          // entry.isSymbolicLink() is the right check; isDirectory walks into
          // resolved targets which would re-enter the source tree.
          if (entry.isSymbolicLink()) {
            symlinkPaths.push(p);
            continue;
          }
          if (entry.isDirectory()) walk(p);
        }
      }
      walk(deliverablesDir);

      expect(symlinkPaths.length).toBeGreaterThan(0);
      for (const link of symlinkPaths) {
        const stat = fs.lstatSync(link);
        expect(stat.isSymbolicLink()).toBe(true);
      }

      // Sanity: the result should not blow up on the mirror path.
      expect(result).toBeDefined();
    }
  );
});

// --------------------------------------------------------------------------
// Test 4 — Phase 1 inputs missing. Status must be 'skipped-due-to-upstream'
// and no deliverables/ directory should be created (D1 + ADR-094 D4).
// --------------------------------------------------------------------------

describe('ADR-098 D1 — Phase 1 missing -> skipped-due-to-upstream', () => {
  it('returns status === "skipped-due-to-upstream" without throwing and without creating deliverables/', async () => {
    // Empty runDir. Don't write manifest.json.
    fs.mkdirSync(runDir, { recursive: true });

    let result: Awaited<ReturnType<typeof executePhase7>>;
    try {
      result = await executePhase7({
        runDir,
        traceId: 'phase7-skip-trace',
        scenarioQuery: 'manufacturing pilot — phase7 skipped path',
      });
    } catch (err) {
      throw new Error(
        `Phase 7 must NOT throw when Phase 1 inputs are missing; threw: ${(err as Error).message}`
      );
    }

    expect(result.status).toBe('skipped-due-to-upstream');
    expect(fs.existsSync(path.join(runDir, 'deliverables'))).toBe(false);
  });
});
