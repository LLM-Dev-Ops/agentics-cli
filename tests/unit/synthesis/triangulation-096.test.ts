/**
 * ADR-PIPELINE-096 D3 part 2 — Triangulation surface tests.
 *
 * Verifies that synthesizeFinancials's `triangulation` map captures every
 * agent that returned a value for a given metric, in priority order.
 * Covers Verification scenario 5 (triangulation surface).
 */

import { describe, it, expect } from '@jest/globals';

import { synthesizeFinancials } from '../../../src/synthesis/simulation-renderers.js';

interface MockAgentResult {
  domain: string;
  agent: string;
  status: number;
  response: unknown;
}

function ok(domain: string, agent: string, response: unknown): MockAgentResult {
  return { domain, agent, status: 200, response };
}

describe('ADR-096 D3 pt 2 — triangulation surface', () => {
  it('emits triangulation.budget when 2+ agents return investment values', () => {
    const results = [
      ok('costops', 'forecast', { data: { investment: '$2.0M' } }),
      ok('costops', 'budget', { data: { allocated_budget: '$2.05M' } }),
    ] as Parameters<typeof synthesizeFinancials>[1];

    const fin = synthesizeFinancials({}, results, 'office optimization for 68k employees');

    expect(fin.triangulation).toBeDefined();
    expect(fin.triangulation!.budget).toBeDefined();
    expect(fin.triangulation!.budget!.length).toBeGreaterThanOrEqual(2);
    const sources = fin.triangulation!.budget!.map(t => t.source);
    expect(sources).toContain('costops/forecast');
    expect(sources).toContain('costops/budget');
  });

  it('does NOT emit triangulation when only 1 agent contributed', () => {
    const results = [
      ok('costops', 'forecast', { data: { investment: '$2.0M' } }),
    ] as Parameters<typeof synthesizeFinancials>[1];

    const fin = synthesizeFinancials({}, results, 'office optimization');

    // budget value is set, but no triangulation since only one agent.
    expect(fin.budget).toBeTruthy();
    expect(fin.triangulation?.budget).toBeUndefined();
  });

  it('emits triangulation across multiple metrics independently', () => {
    const results = [
      ok('costops', 'forecast', { data: { investment: '$2.0M', npv: '$11.5M' } }),
      ok('costops', 'budget', { data: { allocated_budget: '$2.05M' } }),
      ok('simulator', 'scenario', { data: { npv: '$11.9M' } }),
      ok('costops', 'roi', { data: { roi: '167%', annual_savings: '$3.4M' } }),
    ] as Parameters<typeof synthesizeFinancials>[1];

    const fin = synthesizeFinancials({}, results, 'consulting brief');

    // Investment: 2 sources (forecast, budget) → triangulation
    expect(fin.triangulation?.budget).toBeDefined();
    expect(fin.triangulation!.budget!.length).toBe(2);
    // NPV: 2 sources (forecast, scenario) → triangulation
    expect(fin.triangulation?.npv).toBeDefined();
    expect(fin.triangulation!.npv!.length).toBe(2);
    // ROI: 1 source → no triangulation
    expect(fin.triangulation?.roi).toBeUndefined();
  });

  it('triangulation entries carry both source and value for renderer to format', () => {
    const results = [
      ok('costops', 'forecast', { data: { investment: '$2.0M' } }),
      ok('costops', 'budget', { data: { allocated_budget: '$2.18M' } }),
    ] as Parameters<typeof synthesizeFinancials>[1];

    const fin = synthesizeFinancials({}, results, 'q');

    const entries = fin.triangulation!.budget!;
    for (const e of entries) {
      expect(typeof e.source).toBe('string');
      expect(e.source).toMatch(/^[a-z-]+\/[a-z-]+$/);
      expect(typeof e.value).toBe('string');
      expect(e.value.length).toBeGreaterThan(0);
    }
  });

  it('triangulation does not appear on FinancialData when no agents contributed (heuristic-only path)', () => {
    // Empty platformResults → falls through to estimateFinancialsFromQuery
    // which produces values without triangulation.
    const fin = synthesizeFinancials({}, [], 'enterprise office optimization for 68000 employees');
    expect(fin.budget).toBeTruthy();  // heuristic produced something
    expect(fin.triangulation).toBeUndefined();
  });
});
