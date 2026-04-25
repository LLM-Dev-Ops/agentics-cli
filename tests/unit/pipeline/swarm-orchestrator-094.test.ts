/**
 * ADR-PIPELINE-094 Decision 7 — Cloud-agent circuit breaker.
 *
 * Tests the CloudCircuitBreaker class in isolation. Integration with the
 * full Phase 5 fanout is covered by the originating-run regression test.
 */

import { describe, it, expect } from '@jest/globals';

import {
  CloudCircuitBreaker,
  resolveCloudBreakerThreshold,
} from '../../../src/pipeline/swarm-orchestrator.js';

describe('ADR-094 D7 — CloudCircuitBreaker', () => {
  it('does not trip below the threshold', () => {
    const b = new CloudCircuitBreaker(3);
    b.record(true, 'cloud', 'forge/sdk');
    b.record(true, 'cloud', 'connector-hub/erp');
    expect(b.shouldSkip()).toBe(false);
    expect(b.state().tripped).toBe(false);
  });

  it('trips after exactly N consecutive cloud failures', () => {
    const b = new CloudCircuitBreaker(3);
    b.record(true, 'cloud', 'forge/sdk');
    b.record(true, 'cloud', 'connector-hub/erp');
    b.record(true, 'cloud', 'edge/circuit-breaker');
    expect(b.shouldSkip()).toBe(true);
    const state = b.state();
    expect(state.tripped).toBe(true);
    expect(state.after_n_timeouts).toBe(3);
    expect(state.agents).toEqual(['forge/sdk', 'connector-hub/erp', 'edge/circuit-breaker']);
  });

  it('resets the streak on a cloud success', () => {
    const b = new CloudCircuitBreaker(3);
    b.record(true, 'cloud', 'a');
    b.record(true, 'cloud', 'b');
    b.record(false, 'cloud', 'c'); // success — resets streak
    b.record(true, 'cloud', 'd');
    expect(b.shouldSkip()).toBe(false);
  });

  it('local successes and failures do not move the breaker state', () => {
    const b = new CloudCircuitBreaker(3);
    for (let i = 0; i < 10; i++) {
      b.record(true, 'local', `local-fail-${i}`);
      b.record(false, 'local', `local-ok-${i}`);
    }
    expect(b.shouldSkip()).toBe(false);
    expect(b.state().agents).toEqual([]);
  });

  it('continues to record agents but does not change after_n_timeouts once tripped', () => {
    const b = new CloudCircuitBreaker(2);
    b.record(true, 'cloud', 'a');
    b.record(true, 'cloud', 'b'); // trips
    expect(b.state().after_n_timeouts).toBe(2);

    // After tripping, additional records are no-ops on internal counters.
    b.record(true, 'cloud', 'c');
    expect(b.state().after_n_timeouts).toBe(2);
    expect(b.shouldSkip()).toBe(true);
  });

  it('clamps threshold to a minimum of 1', () => {
    const b = new CloudCircuitBreaker(0);
    b.record(true, 'cloud', 'a');
    expect(b.shouldSkip()).toBe(true);
  });
});

describe('ADR-094 D7 — resolveCloudBreakerThreshold', () => {
  const ENV_KEY = 'AGENTICS_CLOUD_BREAKER_THRESHOLD';
  const original = process.env[ENV_KEY];

  afterEach(() => {
    if (original === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = original;
  });

  it('returns the default when env var is unset', () => {
    delete process.env[ENV_KEY];
    expect(resolveCloudBreakerThreshold()).toBe(3);
  });

  it('reads a positive integer from env', () => {
    process.env[ENV_KEY] = '5';
    expect(resolveCloudBreakerThreshold()).toBe(5);
  });

  it('rejects non-numeric env values and falls back to default', () => {
    process.env[ENV_KEY] = 'hello';
    expect(resolveCloudBreakerThreshold()).toBe(3);
  });

  it('rejects zero and negative env values', () => {
    process.env[ENV_KEY] = '0';
    expect(resolveCloudBreakerThreshold()).toBe(3);
    process.env[ENV_KEY] = '-1';
    expect(resolveCloudBreakerThreshold()).toBe(3);
  });
});
