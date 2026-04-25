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
      ok('costops', 'budget', { data: { allocated_budget: '$1.5M' } }),
      ok('costops', 'forecast', { data: { investment: '$2.0M - $3.1M' } }),
    ];
    const claim = resolveClaim('investment', results);
    expect(claim).not.toBeNull();
    expect(claim!.value).toBe('$2.0M - $3.1M');
    expect(claim!.source).toBe('costops/forecast');
  });

  it('falls through to costops/budget when costops/forecast did not return a value', () => {
    const results = [
      ok('costops', 'forecast', { data: {} }),  // no investment field
      ok('costops', 'budget', { data: { allocated_budget: '$1.5M' } }),
    ];
    const claim = resolveClaim('investment', results);
    expect(claim!.source).toBe('costops/budget');
    expect(claim!.value).toBe('$1.5M');
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
      { domain: 'costops', agent: 'forecast', status: 503, response: { data: { investment: '$999K' } } } as AgentResultLike,
    ];
    expect(resolveClaim('investment', results)).toBeNull();
  });

  it('resolves NPV from simulator/scenario before costops/forecast', () => {
    const results = [
      ok('costops', 'forecast', { data: { npv: '$10.0M' } }),
      ok('simulator', 'scenario', { data: { npv: '$11.9M' } }),
    ];
    const claim = resolveClaim('npv', results);
    expect(claim!.source).toBe('simulator/scenario');
    expect(claim!.value).toBe('$11.9M');
  });

  it('resolves ROI from costops/roi', () => {
    const results = [ok('costops', 'roi', { data: { roi: '167%' } })];
    const claim = resolveClaim('roi', results);
    expect(claim!.value).toBe('167%');
    expect(claim!.source).toBe('costops/roi');
  });

  it('resolves Payback from costops/budget', () => {
    const results = [ok('costops', 'budget', { data: { payback: '9 months' } })];
    const claim = resolveClaim('payback', results);
    expect(claim!.value).toBe('9 months');
  });

  it('resolves Savings from costops/roi', () => {
    const results = [ok('costops', 'roi', { data: { annual_savings: '$3.4M' } })];
    const claim = resolveClaim('savings', results);
    expect(claim!.value).toBe('$3.4M');
    expect(claim!.source).toBe('costops/roi');
  });
});

describe('ADR-096 D3 — resolveAllClaims surfaces every contributing agent (for triangulation)', () => {
  it('returns all agents that supplied a value, in priority order', () => {
    const results = [
      ok('costops', 'attribution', { data: { total_cost: '$2.1M' } }),
      ok('costops', 'forecast', { data: { investment: '$2.0M' } }),
      ok('costops', 'budget', { data: { allocated_budget: '$2.05M' } }),
    ];
    const claims = resolveAllClaims('investment', results);
    expect(claims.length).toBeGreaterThanOrEqual(3);
    // costops/forecast (priority 10) comes first
    expect(claims[0]!.source).toBe('costops/forecast');
    // The 3 unique agents must all appear
    const sources = new Set(claims.map(c => c.source));
    expect(sources.has('costops/forecast')).toBe(true);
    expect(sources.has('costops/budget')).toBe(true);
    expect(sources.has('costops/attribution')).toBe(true);
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
