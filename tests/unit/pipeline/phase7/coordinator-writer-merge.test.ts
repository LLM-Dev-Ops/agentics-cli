/**
 * ADR-PIPELINE-111 — Phase 7 writer-agent integration tests.
 *
 * Exercises the agent-sourced field merge OFFLINE via the `options.agentDispatch`
 * DI seam, with `dispatchMode:'noop'` (no real Ruflo) + `enableAgents:true` +
 * `enrichWithLLM:false` (no real `claude` binary in CI; the LLM tier returns
 * nothing and the deterministic artifact/slug backstop takes over). This lets us
 * assert the full ADR-111 contract — agent dispatch, per-run cache dedup,
 * deterministic merge, manifest provenance, and the D5 coherence gate — in
 * a few seconds with zero network.
 *
 * Covered decisions:
 *   D3  — sourceAgents are invoked through the injected dispatch and cached
 *         once per `domain/agent` across all 87 rows.
 *   D5  — financial fcv figures are reserved (the canonical `$8.5M` enterprise
 *         savings survives) and no doc leaks a literal `$$` template artifact.
 *   D7  — the manifest records `agents_invoked`, `source_agents_called`
 *         (`domain/agent:status`), and a numeric `field_provenance` per
 *         emitted non-mirror row.
 *   D8  — the coherence gate runs (manifest carries `coherence_violations`).
 *   NO_AGENTS hatch — `AGENTICS_PHASE7_NO_AGENTS=1` suppresses all dispatch.
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { executePhase7 } from '../../../../src/pipeline/phase7/coordinator.js';

let tmpDir: string;
let runDir: string;

// Canonical enterprise savings figure: 8.5M → renders as "$8.5M".
const CANONICAL_SAVINGS_DISPLAY = '$8.5M';

// --------------------------------------------------------------------------
// Fixture builder — a minimal-but-renderable Phase 1 run dir.
// --------------------------------------------------------------------------

function buildPhase1Fixture(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });

  // REQUIRED gate file — without manifest.json the phase returns
  // 'skipped-due-to-upstream'.
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({}, null, 2));

  // unit-economics.json — carries both the simplified keys the coordinator's
  // raw extractor reads (annual_*_savings_usd) AND the full ADR-066 schema so
  // `loadUnitEconomics` validates and `buildFcvBlock` emits a real fcv block.
  fs.writeFileSync(
    path.join(dir, 'unit-economics.json'),
    JSON.stringify(
      {
        // Simplified keys read directly by the coordinator / coherence gate.
        annual_measured_savings_usd: 340_000,
        annual_extrapolated_savings_usd: 8_500_000,
        extrapolation_method: 'linear',
        enterprise_investment: 3_400_000,
        roi_pct: 150,
        payback_months: 18,
        npv_5yr: 12_000_000,
        // Full ADR-066 schema fields so UnitEconomicsSchema.safeParse passes.
        run_id: 'phase7-writer-merge-run',
        sector: 'finance-operations',
        domain_unit: { label: 'invoice', abbrev: 'inv' },
        measured_scope: { units: 12_000, region_mix: ['NA'] },
        enterprise_scope: { units: 300_000, region_mix: ['NA', 'EMEA'] },
        unit_savings: { 'per-invoice': 28.3 },
        confidence: { directional: 0.9, precision: 0.75 },
        source: 'prototype-preview',
      },
      null,
      2,
    ),
  );

  fs.writeFileSync(
    path.join(dir, 'executive-summary.md'),
    [
      '# Executive Summary',
      '',
      '## Recommendation',
      '',
      'Approve a 12-week pilot to automate invoice processing.',
      '',
      '## Key Findings',
      '',
      'Invoice cycle time can be cut by 60%. Error rates drop materially.',
      '',
      '## Financial Impact',
      '',
      'Enterprise annual savings of $8.5M against a $3.4M investment.',
      '',
      '## Risk Profile',
      '',
      'Primary risk is change management; mitigated by phased rollout.',
      '',
      'Sources: platform/executive-summary, costops/forecast.',
      '',
    ].join('\n'),
  );

  fs.writeFileSync(
    path.join(dir, 'scenario.json'),
    JSON.stringify(
      {
        query: 'Automate invoice processing',
        stakeholders: ['CFO'],
        success_criteria: ['cut cycle time'],
        constraints: ['budget'],
      },
      null,
      2,
    ),
  );

  fs.writeFileSync(
    path.join(dir, 'risk-assessment.json'),
    JSON.stringify(
      {
        risk_register: [
          {
            id: 'R1',
            category: 'ops',
            likelihood: 'med',
            impact: 'high',
            description: 'x',
            mitigation: 'y',
            owner: 'z',
          },
        ],
      },
      null,
      2,
    ),
  );

  // Top-level docs the 11 mirror rows symlink/copy to — present so mirror rows
  // emit rather than fail (keeps emitted > 0 robust and the run realistic).
  for (const f of [
    'decision-memo.md',
    'financial-analysis.md',
    'security-assessment.md',
    'integration-assessment.md',
    'agent-fleet-report.md',
  ]) {
    fs.writeFileSync(path.join(dir, f), `# ${f}\n\nfixture body for ${f}\n`);
  }
  fs.writeFileSync(path.join(dir, 'roadmap.json'), JSON.stringify({ phases: [] }));
  fs.writeFileSync(
    path.join(dir, 'consensus.json'),
    JSON.stringify({ agreement: 0.9, precision: 0.75, verdict: 'GO' }),
  );
}

/**
 * Fake agent dispatch. Increments a per-`domain/agent` counter so we can prove
 * the cross-row cache dedups invocations, and returns a 200/`tier3` response
 * shaped like the real `executeAgentsInvokeCommand` data envelope.
 */
function makeFakeDispatch(): {
  dispatch: (
    domain: string,
    agent: string,
    payload: Record<string, unknown>,
  ) => Promise<{ status: number; tier?: string; data: unknown }>;
  counts: Map<string, number>;
} {
  const counts = new Map<string, number>();
  const dispatch = async (
    domain: string,
    agent: string,
    _payload: Record<string, unknown>,
  ): Promise<{ status: number; tier?: string; data: unknown }> => {
    const ref = `${domain}/${agent}`;
    counts.set(ref, (counts.get(ref) ?? 0) + 1);
    return {
      status: 200,
      tier: 'tier3',
      data: { summary: `analysis from ${ref}`, finding: 'offline-fixture' },
    };
  };
  return { dispatch, counts };
}

function walkFiles(dir: string, predicate: (p: string) => boolean): string[] {
  const out: string[] = [];
  const stack = [dir];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = path.join(cur, e.name);
      // Don't follow symlinks back into the source tree.
      if (e.isSymbolicLink()) {
        if (predicate(p)) out.push(p);
        continue;
      }
      if (e.isDirectory()) {
        stack.push(p);
        continue;
      }
      if (e.isFile() && predicate(p)) out.push(p);
    }
  }
  return out;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase7-writer-merge-'));
  runDir = path.join(tmpDir, 'run');
});

afterEach(() => {
  delete process.env['AGENTICS_PHASE7_NO_AGENTS'];
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

// --------------------------------------------------------------------------
// Test 1 — happy path with agent dispatch: completed/partial, 87 total,
//          emitted > 0, manifest provenance present.
// --------------------------------------------------------------------------

describe('ADR-111 — agent-sourced writer merge (offline DI)', () => {
  it(
    'runs the full agent dispatch + deterministic merge + manifest + coherence gate offline',
    async () => {
      buildPhase1Fixture(runDir);
      const { dispatch, counts } = makeFakeDispatch();

      const result = await executePhase7({
        runDir,
        traceId: 'phase7-writer-merge-trace',
        scenarioQuery: 'Automate invoice processing',
        options: {
          dispatchMode: 'noop',
          enableAgents: true,
          enrichWithLLM: false,
          agentDispatch: dispatch,
        },
      });

      // ── Assertion 1: status + totals ──
      expect(['completed', 'partial']).toContain(result.status);
      expect(result.deliverables_total).toBe(87);
      expect(result.deliverables_emitted).toBeGreaterThan(0);

      // ── Load the manifest ──
      const manifestPath = path.join(runDir, 'deliverables', 'phase7-manifest.json');
      expect(fs.existsSync(manifestPath)).toBe(true);
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
        coherence_violations: unknown;
        deliverables: Array<{
          slug: string;
          status: string;
          input_artifacts_missing?: string[];
          agents_invoked?: Array<{ ref: string; status: number; tier?: string }>;
          source_agents_called?: string[];
          field_provenance?: Record<string, number>;
          output_path: string;
        }>;
      };

      // ── Assertion 2: provenance on at least one emitted non-mirror row ──
      // Mirror rows have an empty source_agents_called and no agents_invoked;
      // the writer-merge rows are the ones with agents_invoked populated.
      const writerRows = manifest.deliverables.filter(
        (d) =>
          d.status === 'emitted' &&
          Array.isArray(d.agents_invoked) &&
          d.agents_invoked.length > 0,
      );
      expect(writerRows.length).toBeGreaterThan(0);

      const sample = writerRows[0]!;
      // agents_invoked: non-empty array of {ref, status}.
      expect(Array.isArray(sample.agents_invoked)).toBe(true);
      expect(sample.agents_invoked!.length).toBeGreaterThan(0);
      for (const a of sample.agents_invoked!) {
        expect(typeof a.ref).toBe('string');
        expect(a.ref).toMatch(/^[^/]+\/[^/]+$/); // domain/agent
        expect(typeof a.status).toBe('number');
      }
      // source_agents_called entries look like "domain/agent:200".
      expect(Array.isArray(sample.source_agents_called)).toBe(true);
      expect(sample.source_agents_called!.length).toBeGreaterThan(0);
      for (const ref of sample.source_agents_called!) {
        expect(ref).toMatch(/^[^/]+\/[^/]+:\d{3}$/);
      }
      // field_provenance is an object of numeric counts.
      expect(sample.field_provenance).toBeDefined();
      expect(typeof sample.field_provenance).toBe('object');
      for (const v of Object.values(sample.field_provenance!)) {
        expect(typeof v).toBe('number');
      }

      // ── Assertion 3: D3 cache dedup — no agent invoked more than once ──
      const overInvoked = [...counts.entries()].filter(([, n]) => n > 1);
      expect(overInvoked).toEqual([]);
      // And the writer actually dispatched something (cache only proves dedup
      // if at least one agent ran).
      expect(counts.size).toBeGreaterThan(0);

      // ── Assertion 4: D5 coherence ──
      // 4a. No emitted markdown leaks a literal `$$` template artifact.
      const mdFiles = walkFiles(path.join(runDir, 'deliverables'), (p) =>
        p.endsWith('.md'),
      );
      expect(mdFiles.length).toBeGreaterThan(0);
      for (const f of mdFiles) {
        const body = fs.readFileSync(f, 'utf8');
        expect(body.includes('$$')).toBe(false);
      }

      // 4b. The canonical enterprise savings figure appears in financial docs.
      const financialDir = path.join(runDir, 'deliverables', '02-financial');
      const financialFiles = walkFiles(financialDir, (p) => p.endsWith('.md'));
      const financialCorpus = financialFiles
        .map((f) => fs.readFileSync(f, 'utf8'))
        .join('\n\n');
      expect(financialCorpus).toContain(CANONICAL_SAVINGS_DISPLAY);

      // 4c. No financial doc fabricates a DIFFERENT savings figure for the
      // reserved fcv fields. The canonical is $8.5M (enterprise) / $0.3M
      // (measured). Any other "$N.NM" savings-adjacent figure that isn't a
      // sibling-canonical value (investment $3.4M, npv $12.0M) would be a leak.
      // We scope this narrowly: assert the reserved savings figure is the only
      // savings figure cited next to the word "savings".
      const fabricatedSavings = /([0-9]+(?:\.[0-9]+)?)\s*M\s*(?:annual\s+)?(?:enterprise\s+)?savings/gi;
      for (const f of financialFiles) {
        const body = fs.readFileSync(f, 'utf8');
        let m: RegExpExecArray | null;
        while ((m = fabricatedSavings.exec(body)) !== null) {
          // Allowed: 8.5 (enterprise) and 0.3 (measured, rounds from 0.34).
          const val = m[1]!;
          expect(['8.5', '0.3', '0.34']).toContain(val);
        }
      }

      // 4d. The gate ran — `coherence_violations` key exists on the manifest.
      expect(manifest).toHaveProperty('coherence_violations');
      expect(Array.isArray(manifest.coherence_violations)).toBe(true);
    },
    60_000,
  );

  // ------------------------------------------------------------------------
  // Test 2 — NO_AGENTS escape hatch suppresses all dispatch.
  // ------------------------------------------------------------------------

  it(
    'AGENTICS_PHASE7_NO_AGENTS=1 suppresses agent dispatch (no agents_invoked)',
    async () => {
      buildPhase1Fixture(runDir);
      const { dispatch, counts } = makeFakeDispatch();

      process.env['AGENTICS_PHASE7_NO_AGENTS'] = '1';

      const result = await executePhase7({
        runDir,
        traceId: 'phase7-no-agents-trace',
        scenarioQuery: 'Automate invoice processing',
        options: {
          dispatchMode: 'noop',
          enableAgents: true, // explicit true must be overridden by the env hatch
          enrichWithLLM: false,
          agentDispatch: dispatch,
        },
      });

      expect(['completed', 'partial']).toContain(result.status);
      expect(result.deliverables_total).toBe(87);

      // The fake dispatch must never have been called.
      expect(counts.size).toBe(0);

      // No emitted row carries a populated `agents_invoked`.
      const manifestPath = path.join(runDir, 'deliverables', 'phase7-manifest.json');
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
        deliverables: Array<{
          status: string;
          agents_invoked?: Array<unknown>;
        }>;
      };
      for (const d of manifest.deliverables) {
        if (d.status !== 'emitted') continue;
        expect(d.agents_invoked === undefined || d.agents_invoked.length === 0).toBe(
          true,
        );
      }
    },
    60_000,
  );
});
