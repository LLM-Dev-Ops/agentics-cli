/**
 * ADR-PIPELINE-096 D3 part 1 — Agent-Claim Registry tests.
 *
 * Covers ADR Verification scenario 4 (agent-driven exec-summary) at the
 * registry level. End-to-end exec-summary attribution lives in the
 * originating-run regression test (scenario 10).
 */

import { describe, it, expect } from '@jest/globals';

import {
  AGENT_CLAIM_REGISTRY,
  resolveClaim,
  resolveAllClaims,
  readResponsePath,
  type AgentResultLike,
} from '../../../src/synthesis/agent-claim-registry.js';

function ok(domain: string, agent: string, response: unknown): AgentResultLike {
  return { domain, agent, status: 200, response };
}
function fail(domain: string, agent: string): AgentResultLike {
  return { domain, agent, status: 503, response: { error: 'mocked' } };
}

describe('ADR-096 D3 — readResponsePath', () => {
  it('walks dot-delimited paths', () => {
    expect(readResponsePath({ data: { investment: { total_usd: 2_000_000 } } }, 'data.investment.total_usd')).toBe(2_000_000);
  });
  it('walks array indices via [N]', () => {
    expect(readResponsePath({ data: { scenarios: [{ npv: 100 }, { npv: 200 }] } }, 'data.scenarios[1].npv')).toBe(200);
  });
  it('returns null on a miss', () => {
    expect(readResponsePath({ data: {} }, 'data.missing.path')).toBeNull();
  });
  it('handles null response gracefully', () => {
    expect(readResponsePath(null, 'data.x')).toBeNull();
  });
});

describe('ADR-096 D3 — resolveClaim picks the highest-priority agent', () => {
  it('resolves investment from costops/forecast (priority 10) before costops/budget (priority 20)', () => {
    const results = [
      ok('costops', 'budget', { data: { allocated_budget: { usd: 1_500_000 } } }),
      ok('costops', 'forecast', { data: { investment: { total_usd: 2_000_000 } } }),
    ];
    const claim = resolveClaim('investment', results);
    expect(claim).not.toBeNull();
    expect(claim!.value).toBe(2_000_000);
    expect(claim!.source).toBe('costops/forecast');
  });

  it('falls through to costops/budget when costops/forecast did not return a value', () => {
    const results = [
      ok('costops', 'forecast', { data: { investment: {} } }),  // path missing
      ok('costops', 'budget', { data: { allocated_budget: { usd: 1_500_000 } } }),
    ];
    const claim = resolveClaim('investment', results);
    expect(claim!.source).toBe('costops/budget');
    expect(claim!.value).toBe(1_500_000);
  });

  it('returns null when no registered agent succeeded with the value', () => {
    const results = [
      fail('costops', 'forecast'),
      fail('costops', 'budget'),
      ok('costops', 'attribution', { data: {} }),  // path empty
    ];
    expect(resolveClaim('investment', results)).toBeNull();
  });

  it('skips failed (status >= 400) agents even if they would have matched the path', () => {
    const results = [
      { domain: 'costops', agent: 'forecast', status: 503, response: { data: { investment: { total_usd: 999_999 } } } } as AgentResultLike,
    ];
    expect(resolveClaim('investment', results)).toBeNull();
  });

  it('resolves NPV from simulator/scenario before costops/forecast', () => {
    const results = [
      ok('costops', 'forecast', { data: { npv: { five_year_usd: 10_000_000 } } }),
      ok('simulator', 'scenario', { data: { dcf: { npv_5yr_usd: 11_900_000 } } }),
    ];
    const claim = resolveClaim('npv', results);
    expect(claim!.source).toBe('simulator/scenario');
    expect(claim!.value).toBe(11_900_000);
  });

  it('resolves ROI from costops/roi', () => {
    const results = [ok('costops', 'roi', { data: { roi_pct: 167 } })];
    const claim = resolveClaim('roi', results);
    expect(claim!.value).toBe(167);
    expect(claim!.source).toBe('costops/roi');
  });

  it('resolves Payback from costops/budget', () => {
    const results = [ok('costops', 'budget', { data: { payback_months: 9 } })];
    const claim = resolveClaim('payback', results);
    expect(claim!.value).toBe(9);
  });

  it('resolves Savings from costops/roi', () => {
    const results = [ok('costops', 'roi', { data: { annual_savings_usd: 3_400_000 } })];
    const claim = resolveClaim('savings', results);
    expect(claim!.value).toBe(3_400_000);
    expect(claim!.source).toBe('costops/roi');
  });
});

describe('ADR-096 D3 — resolveAllClaims surfaces every contributing agent (for triangulation)', () => {
  it('returns all agents that supplied a value, in priority order', () => {
    const results = [
      ok('costops', 'attribution', { data: { total_cost: { usd: 2_100_000 } } }),
      ok('costops', 'forecast', { data: { investment: { total_usd: 2_000_000 } } }),
      ok('costops', 'budget', { data: { allocated_budget: { usd: 2_050_000 } } }),
    ];
    const claims = resolveAllClaims('investment', results);
    expect(claims).toHaveLength(3);
    expect(claims[0]!.source).toBe('costops/forecast');  // priority 10
    expect(claims[1]!.source).toBe('costops/budget');    // priority 20
    expect(claims[2]!.source).toBe('costops/attribution'); // priority 30
    expect(claims.map(c => c.value)).toEqual([2_000_000, 2_050_000, 2_100_000]);
  });

  it('returns empty array when no agents returned values', () => {
    expect(resolveAllClaims('investment', [fail('costops', 'forecast')])).toEqual([]);
  });
});

describe('ADR-096 D3 — registry coverage', () => {
  it('covers all 5 ClaimKinds', () => {
    const kinds = new Set(AGENT_CLAIM_REGISTRY.map(m => m.kind));
    expect(kinds.has('investment')).toBe(true);
    expect(kinds.has('roi')).toBe(true);
    expect(kinds.has('npv')).toBe(true);
    expect(kinds.has('payback')).toBe(true);
    expect(kinds.has('savings')).toBe(true);
  });

  it('every entry references a domain/agent that exists in CLAUDE.md catalog', () => {
    const validDomains = new Set([
      'costops', 'simulator', 'platform', 'observatory', 'sentinel', 'shield',
      'governance-dashboard', 'connector-hub', 'data-vault', 'research-lab',
      'memory-graph', 'forge', 'edge', 'orchestrator', 'analytics-hub',
      'auto-optimizer', 'incident-manager', 'inference-gateway', 'latency-lens',
      'marketplace', 'registry', 'config-manager', 'schema-registry',
      'test-bench', 'copilot', 'benchmark-exchange', 'edge', 'policy-engine',
    ]);
    for (const m of AGENT_CLAIM_REGISTRY) {
      expect(validDomains.has(m.domain)).toBe(true);
      expect(m.priority).toBeGreaterThan(0);
      expect(m.response_path.length).toBeGreaterThan(0);
    }
  });
});
