/**
 * ADR-PIPELINE-111 — Phase 7 writer-agent optimization benchmarks.
 *
 * ADR-111 turned the discarded Ruflo fan-out into a real, agent-sourced field
 * map per deliverable (`writer-agent.ts`). The headline optimization is the
 * per-run AGENT CACHE: a `domain/agent` ref shared across many of the 87
 * deliverables (e.g. `costops/roi`, `platform/executive-summary`) must be
 * dispatched AT MOST ONCE per Phase 7 invocation, not once per row that lists
 * it. Without the cache the fan-out would re-invoke shared agents dozens of
 * times (the sum of per-row sourceAgents counts), blowing the cost/latency
 * budget.
 *
 * This benchmark proves two ADR-111 invariants hold with a fully-fed Phase 1
 * fixture and an instant, injected fake dispatch:
 *
 *   1. CACHE DEDUP: total dispatch calls === number of UNIQUE `domain/agent`
 *      refs across the registry's non-mirror rows. Each unique agent is
 *      invoked once per run, never per row.
 *   2. WALL TIME: the whole phase (87 rows, agents on, LLM off, noop Ruflo,
 *      instant dispatch) completes well under a generous bound — guarding
 *      against accidental O(n^2) or blocking work in the merge path.
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { executePhase7 } from '../../src/pipeline/phase7/coordinator.js';
import {
  DELIVERABLES_REGISTRY,
} from '../../src/pipeline/phase7/deliverables-registry.js';
import type { AgentDispatch } from '../../src/pipeline/phase7/writer-agent.js';

let tmpDir: string;
let runDir: string;

// --------------------------------------------------------------------------
// Fully-fed Phase 1 fixture builder.
//
// To force every NON-MIRROR row to reach the writer (and therefore dispatch
// its sourceAgents), we write EVERY distinct inputArtifact path the registry
// references. File-style inputs become small files; directory-style inputs
// (e.g. `phase4/adrs`, `phase2/tdd`) become a directory with one readable
// file inside so `loadInputs` reports them as available.
// --------------------------------------------------------------------------

function buildFullPhase1Fixture(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });

  // manifest.json — the D1 input gate. Without it Phase 7 short-circuits to
  // 'skipped-due-to-upstream' and dispatches nothing.
  fs.writeFileSync(
    path.join(dir, 'manifest.json'),
    JSON.stringify(
      {
        run_id: 'adr111-bench-run',
        project: { language: 'typescript', name: 'adr111-bench' },
        phases: [],
      },
      null,
      2,
    ),
  );

  // unit-economics.json — drives the reserved financial fcv fields + the
  // coherence gate's canonical source.
  fs.writeFileSync(
    path.join(dir, 'unit-economics.json'),
    JSON.stringify(
      {
        annual_measured_savings_usd: 2_200_000,
        annual_extrapolated_savings_usd: 55_300_000,
        enterprise_savings_per_year: 55_300_000,
        pilot_savings_per_year: 2_200_000,
        enterprise_investment: 22_100_000,
        npv_5yr: 171_300_000,
        roi_pct: 250,
        payback_months: 5,
      },
      null,
      2,
    ),
  );

  // executive-summary.md — minimal but with the sections extractCommonFields
  // looks for, so artifact-tier fields resolve.
  fs.writeFileSync(
    path.join(dir, 'executive-summary.md'),
    [
      '# Executive Summary',
      '',
      '<!-- consensus: agreement=0.92 precision=0.88 verdict=GO -->',
      '',
      '## Recommendation',
      'Approve a 12-week pilot.',
      '',
      '## Key Findings',
      '- A\n- B\n- C',
      '',
      '## Financial Impact',
      'Pilot savings <!-- fcv:kind=savings scope=pilot doc=executive-summary src=unit-economics --> $2.2M.',
      '',
      '## Risk Profile',
      'Medium.',
      '',
      'Sources: platform/executive-summary, costops/forecast.',
      '',
    ].join('\n'),
  );

  // Every distinct file-style inputArtifact (besides the three above) the
  // non-mirror rows reference. Cheap content; presence is what matters.
  const fileInputs: Record<string, string> = {
    'agent-fleet-report.md': '# Agent Fleet Report\n\nfixture\n',
    'agent-responses.json': JSON.stringify({ domains: 28, agents_called: 109, responses: [] }),
    'consensus.json': JSON.stringify({ agreement: 0.92, precision: 0.88, verdict: 'GO' }),
    'decision-memo.md': '# Decision Memo\n\n## Decision\nApprove.\n',
    'financial-analysis.md': '# Financial Analysis\n\nfixture\n',
    'integration-assessment.md': '# Integration Assessment\n\nfixture\n',
    'risk-assessment.json': JSON.stringify({
      overall_risk_level: 'Medium',
      risk_register: [{ id: 'R1', category: 'Adoption', likelihood: 'M', impact: 'H', description: 'x', mitigation: 'y', owner: 'z' }],
    }),
    'roadmap.json': JSON.stringify({ phases: [{ name: 'Pilot', date: '2026-Q3' }] }),
    'scenario.json': JSON.stringify({ summary: 'manufacturing pilot', horizon_years: 3, query: 'manufacturing pilot' }),
    'security-assessment.md': '# Security Assessment\n\nfixture\n',
    'phase2/research-dossier.json': JSON.stringify({ findings: ['a', 'b'] }),
    'phase2/research-dossier.md': '# Research Dossier\n\nfixture\n',
    'phase2/tech-stack.json': JSON.stringify({ stack: ['ts', 'node'] }),
  };
  for (const [rel, content] of Object.entries(fileInputs)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }

  // Directory-style inputs — each needs at least one readable text file so
  // `loadInputs` treats the directory as available.
  const dirInputs = ['phase2/tdd', 'phase3/sparc', 'phase3/tdd', 'phase4/adrs', 'phase5a/prompts'];
  for (const rel of dirInputs) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(abs, { recursive: true });
    fs.writeFileSync(path.join(abs, 'fixture.md'), '# fixture\n\ncontent\n');
  }

  // Top-level docs the 11 mirror rows point at (so mirror rows succeed and
  // don't perturb the run; mirror rows dispatch NO agents).
  const mirrorTargets: Record<string, string> = {
    'consensus.svg': '<svg></svg>',
  };
  for (const [rel, content] of Object.entries(mirrorTargets)) {
    fs.writeFileSync(path.join(dir, rel), content);
  }
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adr111-bench-'));
  runDir = path.join(tmpDir, 'run');
});

afterEach(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe('ADR-111 — Phase 7 writer-agent optimizations', () => {
  it(
    'dispatches each unique sourceAgent at most once per run (cache dedup) and finishes under budget',
    async () => {
      buildFullPhase1Fixture(runDir);

      // Expected unique agent set: union of sourceAgents over all NON-MIRROR
      // rows. Mirror rows run no writer and dispatch no agents.
      //
      // The writer only dispatches refs that split cleanly into
      // `domain/agent` (see writer-agent.ts: `if (!domain || !agent) continue`).
      // A bare ref like `system-architect` (no domain) is intentionally never
      // dispatched, so it must be excluded from the DISPATCHABLE expected set.
      const isDispatchable = (ref: string): boolean => {
        const [domain, agent] = ref.split('/');
        return Boolean(domain) && Boolean(agent);
      };
      const unionAllNonMirror = new Set<string>();
      const expectedUnique = new Set<string>();
      let nonMirrorRows = 0;
      for (const row of DELIVERABLES_REGISTRY) {
        if (row.mirrorsExisting) continue;
        nonMirrorRows++;
        for (const a of row.sourceAgents) {
          unionAllNonMirror.add(a);
          if (isDispatchable(a)) expectedUnique.add(a);
        }
      }

      // Instant fake dispatch: increments a global call counter and records
      // every `domain/agent` ref it is asked to invoke. Returns success so the
      // writer treats the row as agent-grounded.
      let dispatchCalls = 0;
      const dispatchedRefs = new Set<string>();
      const agentDispatch: AgentDispatch = async (domain, agent) => {
        dispatchCalls++;
        dispatchedRefs.add(`${domain}/${agent}`);
        return { status: 200, tier: 'fake', data: { ok: true } };
      };

      const start = process.hrtime.bigint();
      const result = await executePhase7({
        runDir,
        traceId: 'adr111-bench-trace',
        scenarioQuery: 'manufacturing pilot — adr-111 benchmark',
        options: {
          dispatchMode: 'noop',
          enableAgents: true,
          enrichWithLLM: false,
          agentDispatch,
        },
      });
      const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;

      // ── Summary line (one line, greppable) ──
      // eslint-disable-next-line no-console
      console.log(
        `[ADR-111-BENCH] rows=${result.deliverables_total} non-mirror=${nonMirrorRows} ` +
          `union-non-mirror=${unionAllNonMirror.size} dispatchable-unique=${expectedUnique.size} ` +
          `dispatched-unique=${dispatchedRefs.size} dispatch-calls=${dispatchCalls} ` +
          `ms=${elapsedMs.toFixed(1)}`,
      );

      // Sanity: the phase walked the full registry.
      expect(result.deliverables_total).toBe(DELIVERABLES_REGISTRY.length);

      // ── (1) CACHE DEDUP — the key ADR-111 optimization ──
      // Every unique agent must be invoked AT MOST ONCE. The strongest form of
      // the invariant: total dispatch calls === number of distinct refs seen.
      // If dispatchCalls > dispatchedRefs.size, the per-run cache is broken and
      // a shared agent was re-invoked — a real bug.
      expect(dispatchCalls).toBe(dispatchedRefs.size);

      // And the set the writer actually dispatched must equal the registry's
      // unique non-mirror sourceAgent union (every non-mirror row reached the
      // writer under the fully-fed fixture).
      expect(dispatchedRefs.size).toBe(expectedUnique.size);
      expect(dispatchCalls).toBe(expectedUnique.size);

      // Every dispatched ref belongs to the expected union (no phantom calls).
      for (const ref of dispatchedRefs) {
        expect(expectedUnique.has(ref)).toBe(true);
      }

      // ── (2) WALL TIME — guard against O(n^2) / blocking merge work ──
      expect(elapsedMs).toBeLessThan(15_000);

      // Phase must complete cleanly (no thrown failure).
      expect(['completed', 'partial']).toContain(result.status);
    },
    30_000,
  );
});
