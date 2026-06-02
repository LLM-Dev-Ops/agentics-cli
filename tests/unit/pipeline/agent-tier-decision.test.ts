/**
 * ADR-PIPELINE-109 D3/D4 — agent tier decision.
 *
 * Unit tests for the pure tier-selection logic that routes each agent to the
 * repo tier or the cloud tier.
 */

import { describe, it, expect } from '@jest/globals';

import { decideAgentTier } from '../../../src/pipeline/fleet-dispatch-bounds.js';

describe('ADR-109 D3/D4 — decideAgentTier', () => {
  it('forces cloud when AGENTICS_AGENT_TIER=cloud, regardless of eligibility', () => {
    expect(decideAgentTier({ forced: 'cloud', hasRepo: true, repoMode: true, sourceCached: true })).toBe('cloud');
  });

  it('forces repo when AGENTICS_AGENT_TIER=repo and a repo mapping exists (even if not cached)', () => {
    expect(decideAgentTier({ forced: 'repo', hasRepo: true, repoMode: false, sourceCached: false })).toBe('repo');
  });

  it('forced repo falls back to cloud when the domain has no repo mapping', () => {
    expect(decideAgentTier({ forced: 'repo', hasRepo: false, repoMode: true, sourceCached: true })).toBe('cloud');
  });

  it('auto: chooses repo only when repoMode + hasRepo + sourceCached all hold', () => {
    expect(decideAgentTier({ hasRepo: true, repoMode: true, sourceCached: true })).toBe('repo');
  });

  it('auto: empty cache → cloud (the 00fa108 failure mode is avoided, no wasted attempt)', () => {
    expect(decideAgentTier({ hasRepo: true, repoMode: true, sourceCached: false })).toBe('cloud');
  });

  it('auto: repo mode off → cloud', () => {
    expect(decideAgentTier({ hasRepo: true, repoMode: false, sourceCached: true })).toBe('cloud');
  });

  it('auto: no repo mapping → cloud', () => {
    expect(decideAgentTier({ hasRepo: false, repoMode: true, sourceCached: true })).toBe('cloud');
  });

  it('case-insensitive + undefined forced value behaves as auto', () => {
    expect(decideAgentTier({ forced: 'CLOUD', hasRepo: true, repoMode: true, sourceCached: true })).toBe('cloud');
    expect(decideAgentTier({ forced: undefined, hasRepo: true, repoMode: true, sourceCached: true })).toBe('repo');
    expect(decideAgentTier({ forced: '', hasRepo: true, repoMode: true, sourceCached: false })).toBe('cloud');
  });
});
