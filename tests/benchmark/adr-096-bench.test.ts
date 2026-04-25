/**
 * ADR-PIPELINE-096 — performance benchmarks.
 *
 * Targets:
 *  - resolveClaim: <1ms per call (registry lookup is in the hot path of
 *    every executive-summary render).
 *  - resolveAllClaims: <2ms per call (used by D3 part 2 triangulation).
 *  - readResponsePath: <0.1ms per call (deeply nested response shapes).
 *  - 100 sequential resolveClaim calls: <50ms total (linear scaling).
 */

import { describe, it, expect } from '@jest/globals';

import {
  resolveClaim,
  resolveAllClaims,
  readResponsePath,
  type AgentResultLike,
} from '../../src/synthesis/agent-claim-registry.js';

function makeResults(count: number): AgentResultLike[] {
  // Realistic shape: every agent has a different response, only a few carry
  // values for the registered metrics.
  const results: AgentResultLike[] = [];
  for (let i = 0; i < count; i++) {
    results.push({
      domain: i % 5 === 0 ? 'costops' : `dom${i % 27}`,
      agent: i % 5 === 0 ? ['forecast', 'roi', 'budget', 'attribution', 'tradeoff'][Math.floor(i / 5) % 5]! : `agent${i}`,
      status: 200,
      response: {
        data: {
          investment: { total_usd: 2_000_000 + i * 1000 },
          roi_pct: 167,
          npv: { five_year_usd: 11_900_000 },
          payback_months: 9,
          annual_savings_usd: 3_400_000,
          extra: 'noise'.repeat(50),
        },
      },
    });
  }
  return results;
}

describe('ADR-096 — registry performance', () => {
  it('resolveClaim returns in <1ms for a 109-agent fleet', () => {
    const results = makeResults(109);
    const start = process.hrtime.bigint();
    for (let i = 0; i < 100; i++) {
      resolveClaim('investment', results);
    }
    const elapsed = Number(process.hrtime.bigint() - start) / 1e6;
    const perCall = elapsed / 100;
    expect(perCall).toBeLessThan(1);
  });

  it('resolveAllClaims returns in <2ms for a 109-agent fleet', () => {
    const results = makeResults(109);
    const start = process.hrtime.bigint();
    for (let i = 0; i < 100; i++) {
      resolveAllClaims('investment', results);
    }
    const elapsed = Number(process.hrtime.bigint() - start) / 1e6;
    const perCall = elapsed / 100;
    expect(perCall).toBeLessThan(2);
  });

  it('readResponsePath returns in <0.1ms for a 6-segment nested path', () => {
    const obj = { a: { b: { c: { d: { e: { f: 'value' } } } } } };
    const start = process.hrtime.bigint();
    for (let i = 0; i < 1000; i++) {
      readResponsePath(obj, 'a.b.c.d.e.f');
    }
    const elapsed = Number(process.hrtime.bigint() - start) / 1e6;
    const perCall = elapsed / 1000;
    expect(perCall).toBeLessThan(0.1);
  });

  it('100 sequential resolveClaim calls scale linearly (<50ms total)', () => {
    const results = makeResults(109);
    const start = process.hrtime.bigint();
    for (let i = 0; i < 100; i++) {
      resolveClaim(['investment', 'roi', 'npv', 'payback', 'savings'][i % 5]! as 'investment', results);
    }
    const elapsed = Number(process.hrtime.bigint() - start) / 1e6;
    expect(elapsed).toBeLessThan(50);
  });

  it('whole-document attribution pass (5 metrics × 100 calls) <100ms', () => {
    // Simulates what happens during exec-summary + decision-memo +
    // financial-analysis rendering: every metric is resolved once per doc.
    const results = makeResults(109);
    const start = process.hrtime.bigint();
    for (let doc = 0; doc < 100; doc++) {
      resolveClaim('investment', results);
      resolveClaim('roi', results);
      resolveClaim('npv', results);
      resolveClaim('payback', results);
      resolveClaim('savings', results);
    }
    const elapsed = Number(process.hrtime.bigint() - start) / 1e6;
    expect(elapsed).toBeLessThan(100);
  });
});
