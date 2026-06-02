/**
 * ADR-PIPELINE-108 — fleet dispatch bounds.
 *
 * Unit tests for the per-agent timeout helper and the env-driven config
 * resolvers that bound the Phase 1 fleet.
 */

import { describe, it, expect, afterEach } from '@jest/globals';

import {
  withAgentTimeout,
  AGENT_TIMED_OUT,
  resolveFleetAgentTimeoutMs,
  resolveFleetTimeoutMs,
  resolveFleetDispatchConfig,
  DEFAULT_FLEET_AGENT_TIMEOUT_MS,
  DEFAULT_FLEET_TIMEOUT_MS,
} from '../../../src/pipeline/fleet-dispatch-bounds.js';

describe('ADR-108 D1 — withAgentTimeout', () => {
  it('resolves the underlying value when the promise wins the race', async () => {
    const result = await withAgentTimeout(Promise.resolve('ok'), 1000);
    expect(result).toBe('ok');
  });

  it('returns AGENT_TIMED_OUT when the deadline wins', async () => {
    const slow = new Promise<string>((resolve) => {
      const t = setTimeout(() => resolve('late'), 1000);
      t.unref?.(); // don't keep the jest worker alive past the assertion
    });
    const result = await withAgentTimeout(slow, 20);
    expect(result).toBe(AGENT_TIMED_OUT);
  });

  it('does not reject when the underlying promise rejects after timeout', async () => {
    // A promise that rejects later must not produce an unhandled rejection that
    // crashes the process; the timeout result is what the caller sees.
    const rejectsLate = new Promise<string>((_, reject) => {
      const t = setTimeout(() => reject(new Error('boom')), 50);
      t.unref?.();
    });
    rejectsLate.catch(() => { /* swallow — mirrors fleet usage */ });
    const result = await withAgentTimeout(rejectsLate, 10);
    expect(result).toBe(AGENT_TIMED_OUT);
  });

  it('propagates a fast rejection when the promise loses to nothing', async () => {
    await expect(withAgentTimeout(Promise.reject(new Error('fast')), 1000)).rejects.toThrow('fast');
  });
});

describe('ADR-108 D5 — config resolvers', () => {
  const saved = {
    agent: process.env['AGENTICS_FLEET_AGENT_TIMEOUT_MS'],
    fleet: process.env['AGENTICS_FLEET_TIMEOUT_MS'],
    breaker: process.env['AGENTICS_CLOUD_BREAKER_THRESHOLD'],
  };

  afterEach(() => {
    // restore
    for (const [k, v] of [
      ['AGENTICS_FLEET_AGENT_TIMEOUT_MS', saved.agent],
      ['AGENTICS_FLEET_TIMEOUT_MS', saved.fleet],
      ['AGENTICS_CLOUD_BREAKER_THRESHOLD', saved.breaker],
    ] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('uses defaults when env unset', () => {
    delete process.env['AGENTICS_FLEET_AGENT_TIMEOUT_MS'];
    delete process.env['AGENTICS_FLEET_TIMEOUT_MS'];
    expect(resolveFleetAgentTimeoutMs()).toBe(DEFAULT_FLEET_AGENT_TIMEOUT_MS);
    expect(resolveFleetTimeoutMs()).toBe(DEFAULT_FLEET_TIMEOUT_MS);
  });

  it('honors valid env overrides', () => {
    process.env['AGENTICS_FLEET_AGENT_TIMEOUT_MS'] = '5000';
    process.env['AGENTICS_FLEET_TIMEOUT_MS'] = '12000';
    expect(resolveFleetAgentTimeoutMs()).toBe(5000);
    expect(resolveFleetTimeoutMs()).toBe(12000);
  });

  it('ignores invalid/non-positive env values', () => {
    process.env['AGENTICS_FLEET_AGENT_TIMEOUT_MS'] = 'not-a-number';
    process.env['AGENTICS_FLEET_TIMEOUT_MS'] = '-5';
    expect(resolveFleetAgentTimeoutMs()).toBe(DEFAULT_FLEET_AGENT_TIMEOUT_MS);
    expect(resolveFleetTimeoutMs()).toBe(DEFAULT_FLEET_TIMEOUT_MS);
  });

  it('resolveFleetDispatchConfig returns the full bound set', () => {
    delete process.env['AGENTICS_FLEET_AGENT_TIMEOUT_MS'];
    delete process.env['AGENTICS_FLEET_TIMEOUT_MS'];
    delete process.env['AGENTICS_CLOUD_BREAKER_THRESHOLD'];
    const cfg = resolveFleetDispatchConfig();
    expect(cfg).toEqual({
      agent_timeout_ms: DEFAULT_FLEET_AGENT_TIMEOUT_MS,
      fleet_timeout_ms: DEFAULT_FLEET_TIMEOUT_MS,
      cloud_breaker_threshold: 3,
    });
  });
});
