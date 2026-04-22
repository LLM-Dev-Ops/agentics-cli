/**
 * ADR-PIPELINE-089 §2 — Phase 1 Health Gate tests.
 *
 * Verify that computePhase1Verdict classifies:
 *  - healthy: all agents 2xx, no degradations, artifacts written
 *  - degraded: some agents errored OR degradations sink is non-empty
 *  - failed: simulator errored (terminal / transient / unknown) OR no artifacts OR >50% agents errored
 */

import { describe, it, expect } from '@jest/globals';
import { computePhase1Verdict } from '../../../src/pipeline/phase1-verdict.js';
import type { Degradation } from '../../../src/observability/degradations.js';

interface InvBuilderResult {
  domain: string;
  agent: string;
  ok: boolean;
  errorMessage?: string;
}

function inv({ domain, agent, ok, errorMessage }: InvBuilderResult) {
  return {
    intent: { domain, agent },
    result: ok
      ? { domain, agent, status: 200, response: { ok: true }, timing: 1 }
      : { error: errorMessage ?? 'agent failure' },
  };
}

const ART = ['manifest.json', 'scenario.json', 'roadmap.json', 'executive-summary.md'];

describe('computePhase1Verdict', () => {
  it('returns healthy when simulator ok, all agents ok, artifacts present, zero degradations', () => {
    const res = computePhase1Verdict(
      [
        inv({ domain: 'simulator', agent: 'enterprise', ok: true }),
        inv({ domain: 'copilot', agent: 'planner', ok: true }),
        inv({ domain: 'research-lab', agent: 'metrics', ok: true }),
      ],
      [],
      ART,
    );
    expect(res.verdict).toBe('healthy');
    expect(res.degradations).toEqual([]);
    expect(res.stats.simulatorStatus).toBe('succeeded');
    expect(res.stats.erroredAgents).toBe(0);
  });

  it('returns failed when simulator terminal-failed', () => {
    const res = computePhase1Verdict(
      [
        inv({ domain: 'simulator', agent: 'enterprise', ok: false, errorMessage: 'contract_violation: intent_description required' }),
        inv({ domain: 'copilot', agent: 'planner', ok: true }),
      ],
      [],
      ART,
    );
    expect(res.verdict).toBe('failed');
    expect(res.stats.simulatorStatus).toBe('failed-terminal');
    expect(res.reason).toContain('terminally');
    expect(res.degradations.some(d => d.code === 'simulator-terminal')).toBe(true);
  });

  it('returns failed with transient tag when simulator exhausted retries', () => {
    const res = computePhase1Verdict(
      [
        inv({ domain: 'simulator', agent: 'enterprise', ok: false, errorMessage: 'service unreachable' }),
      ],
      [],
      ART,
    );
    expect(res.verdict).toBe('failed');
    expect(res.stats.simulatorStatus).toBe('failed-transient');
    expect(res.degradations.some(d => d.code === 'simulator-transient')).toBe(true);
    expect(res.reason.toLowerCase()).toContain('re-run');
  });

  it('returns failed when zero artifacts were produced', () => {
    const res = computePhase1Verdict(
      [inv({ domain: 'simulator', agent: 'enterprise', ok: true })],
      [],
      [],
    );
    expect(res.verdict).toBe('failed');
    expect(res.degradations.some(d => d.code === 'artifact-missing')).toBe(true);
  });

  it('returns failed when > 50% of graph-routed agents errored', () => {
    const res = computePhase1Verdict(
      [
        inv({ domain: 'simulator', agent: 'enterprise', ok: true }),
        inv({ domain: 'copilot', agent: 'planner', ok: false }),
        inv({ domain: 'research-lab', agent: 'metrics', ok: false }),
        inv({ domain: 'memory-graph', agent: 'knowledge-graph', ok: false }),
        inv({ domain: 'analytics-hub', agent: 'consensus', ok: true }),
      ],
      [],
      ART,
    );
    expect(res.verdict).toBe('failed');
    expect(res.reason).toMatch(/of \d+ graph-routed agents errored/);
  });

  it('returns degraded when some agents errored but under threshold', () => {
    const res = computePhase1Verdict(
      [
        inv({ domain: 'simulator', agent: 'enterprise', ok: true }),
        inv({ domain: 'copilot', agent: 'planner', ok: true }),
        inv({ domain: 'research-lab', agent: 'metrics', ok: false }),
        inv({ domain: 'memory-graph', agent: 'knowledge-graph', ok: true }),
      ],
      [],
      ART,
    );
    expect(res.verdict).toBe('degraded');
    expect(res.stats.erroredAgents).toBe(1);
    expect(res.stats.totalAgents).toBe(3);
  });

  it('returns degraded when degradation sink has entries but no errors', () => {
    const degs: Degradation[] = [
      { code: 'local-fallback', message: 'costops/attribution local compute', phase: 1 },
      { code: 'tag-survival-failed', message: 'executive-summary dropped fcv tags', phase: 1 },
    ];
    const res = computePhase1Verdict(
      [
        inv({ domain: 'simulator', agent: 'enterprise', ok: true }),
        inv({ domain: 'copilot', agent: 'planner', ok: true }),
      ],
      degs,
      ART,
    );
    expect(res.verdict).toBe('degraded');
    expect(res.degradations).toHaveLength(2);
    expect(res.reason).toContain('local-fallback');
    expect(res.reason).toContain('tag-survival-failed');
  });
});
