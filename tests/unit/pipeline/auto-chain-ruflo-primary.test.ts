/**
 * ADR-PIPELINE-091 — auto-chain Ruflo-primary unit tests.
 *
 * Scope: the pure helpers that auto-chain uses to (a) snapshot remote
 * enrichment from `manifest.json`, (b) compute the `execution` block, and
 * (c) merge that block back into the manifest. These are the load-bearing
 * pieces of Implementation Plan bullet 1 that can be unit-tested without
 * spinning up the full pipeline.
 *
 * The `runPrimaryPhaseExecution` executor itself is already covered by
 * `ruflo-phase-executor.test.ts` — here we mock it out where auto-chain
 * would call it, and assert on the downstream manifest side-effect.
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { PrimaryPhaseExecutionResult } from '../../../src/pipeline/ruflo-phase-executor.js';
import {
  computeExecutionBlock,
  readRemoteEnrichmentSnapshot,
  writeExecutionBlockToManifest,
  type RemoteAgentInvocation,
} from '../../../src/pipeline/auto-chain.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeTempRunDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'auto-chain-091-'));
}

function writeManifest(runDir: string, body: Record<string, unknown>): void {
  fs.writeFileSync(path.join(runDir, 'manifest.json'), JSON.stringify(body, null, 2), 'utf-8');
}

function rufloOk(phaseId: PrimaryPhaseExecutionResult['phaseId']): PrimaryPhaseExecutionResult {
  return {
    phaseId,
    success: true,
    executionTier: 'ruflo-local',
    filesModified: 3,
    timing: 1234,
    message: 'ok',
  };
}

function rufloUnavailable(phaseId: PrimaryPhaseExecutionResult['phaseId']): PrimaryPhaseExecutionResult {
  return {
    phaseId,
    success: false,
    executionTier: 'unavailable',
    reason: 'ruflo-disabled-by-env',
    filesModified: 0,
    timing: 10,
    message: 'disabled',
  };
}

function rufloTimeout(phaseId: PrimaryPhaseExecutionResult['phaseId']): PrimaryPhaseExecutionResult {
  return {
    phaseId,
    success: false,
    executionTier: 'ruflo-local',
    reason: 'ruflo-timeout',
    filesModified: 0,
    timing: 600_000,
    message: 'timed out',
  };
}

// ---------------------------------------------------------------------------
// readRemoteEnrichmentSnapshot
// ---------------------------------------------------------------------------

describe('readRemoteEnrichmentSnapshot (ADR-091)', () => {
  let runDir: string;

  beforeEach(() => { runDir = makeTempRunDir(); });
  afterEach(() => { fs.rmSync(runDir, { recursive: true, force: true }); });

  it('returns empty snapshot when manifest.json is missing', () => {
    const snap = readRemoteEnrichmentSnapshot(runDir);
    expect(snap).toEqual({ available: [], errored: [], entries: [] });
  });

  it('returns empty snapshot when manifest.json is unreadable JSON', () => {
    fs.writeFileSync(path.join(runDir, 'manifest.json'), '{not valid json', 'utf-8');
    const snap = readRemoteEnrichmentSnapshot(runDir);
    expect(snap).toEqual({ available: [], errored: [], entries: [] });
  });

  it('returns empty snapshot when manifest has no agents_invoked', () => {
    writeManifest(runDir, { query: 'x' });
    const snap = readRemoteEnrichmentSnapshot(runDir);
    expect(snap.available).toEqual([]);
    expect(snap.errored).toEqual([]);
  });

  it('partitions success / invoked as available and everything else as errored', () => {
    const agents_invoked: RemoteAgentInvocation[] = [
      { domain: 'diligence-artifacts', agent: 'sparc-specification', status: '503' },
      { domain: 'diligence-artifacts', agent: 'adr-generation', status: 'timeout' },
      { domain: 'research-lab', agent: 'competitive-analysis', status: 'success' },
      { domain: 'research-lab', agent: 'regulatory-citations', status: 'invoked' },
    ];
    writeManifest(runDir, { agents_invoked });
    const snap = readRemoteEnrichmentSnapshot(runDir);

    expect(snap.available).toEqual(['competitive-analysis', 'regulatory-citations']);
    expect(snap.errored).toEqual(['sparc-specification', 'adr-generation']);
    expect(snap.entries).toHaveLength(4);
  });
});

// ---------------------------------------------------------------------------
// computeExecutionBlock
// ---------------------------------------------------------------------------

describe('computeExecutionBlock (ADR-091 §5)', () => {
  const emptyEnrichment = { available: [], errored: [], entries: [] };

  it('tags engineering_tier="template" when ALL ruflo results are unavailable', () => {
    const block = computeExecutionBlock(
      [
        rufloUnavailable('phase3-sparc'),
        rufloUnavailable('phase4-adrs-ddd'),
        rufloUnavailable('phase5a-prompts'),
      ],
      emptyEnrichment,
    );
    expect(block.engineering_tier).toBe('template');
    expect(block.tier_counts).toEqual({ 'ruflo-local': 0, template: 3 });
  });

  it('tags engineering_tier="ruflo-local" when all three ruflo results succeed', () => {
    const block = computeExecutionBlock(
      [
        rufloOk('phase3-sparc'),
        rufloOk('phase4-adrs-ddd'),
        rufloOk('phase5a-prompts'),
      ],
      emptyEnrichment,
    );
    expect(block.engineering_tier).toBe('ruflo-local');
    expect(block.tier_counts).toEqual({ 'ruflo-local': 3, template: 0 });
  });

  it('tags engineering_tier="ruflo-local" even when only ONE phase succeeded', () => {
    const block = computeExecutionBlock(
      [
        rufloOk('phase3-sparc'),
        rufloTimeout('phase4-adrs-ddd'),
        rufloUnavailable('phase5a-prompts'),
      ],
      emptyEnrichment,
    );
    expect(block.engineering_tier).toBe('ruflo-local');
    expect(block.tier_counts).toEqual({ 'ruflo-local': 1, template: 2 });
  });

  it('treats ruflo-timeout (executionTier="ruflo-local" but success=false) as template', () => {
    const block = computeExecutionBlock(
      [rufloTimeout('phase3-sparc'), rufloTimeout('phase4-adrs-ddd'), rufloTimeout('phase5a-prompts')],
      emptyEnrichment,
    );
    expect(block.engineering_tier).toBe('template');
    expect(block.tier_counts['template']).toBe(3);
    expect(block.tier_counts['ruflo-local']).toBe(0);
  });

  it('treats undefined / null entries as template', () => {
    const block = computeExecutionBlock(
      [undefined, null, rufloOk('phase5a-prompts')],
      emptyEnrichment,
    );
    expect(block.engineering_tier).toBe('ruflo-local');
    expect(block.tier_counts).toEqual({ 'ruflo-local': 1, template: 2 });
  });

  it('computes enrichment_depth_pct=75 for 12/16 successful remote agents', () => {
    const available = Array.from({ length: 12 }, (_, i) => `enrich-ok-${i}`);
    const errored = Array.from({ length: 4 }, (_, i) => `enrich-fail-${i}`);
    const block = computeExecutionBlock(
      [rufloOk('phase3-sparc'), rufloOk('phase4-adrs-ddd'), rufloOk('phase5a-prompts')],
      { available, errored, entries: [] },
    );
    expect(block.enrichment.enrichment_depth_pct).toBe(75);
    expect(block.enrichment.remote_agents_available).toEqual(available);
    expect(block.enrichment.remote_agents_errored).toEqual(errored);
  });

  it('reports enrichment_depth_pct=null (NOT zero) when no remote enrichment ran', () => {
    const block = computeExecutionBlock(
      [rufloOk('phase3-sparc'), rufloOk('phase4-adrs-ddd'), rufloOk('phase5a-prompts')],
      { available: [], errored: [], entries: [] },
    );
    expect(block.enrichment.enrichment_depth_pct).toBeNull();
    expect(block.enrichment.remote_agents_available).toEqual([]);
    expect(block.enrichment.remote_agents_errored).toEqual([]);
  });

  it('reports enrichment_depth_pct=0 when all remote agents errored', () => {
    const block = computeExecutionBlock(
      [rufloOk('phase3-sparc'), rufloOk('phase4-adrs-ddd'), rufloOk('phase5a-prompts')],
      { available: [], errored: ['a', 'b', 'c', 'd'], entries: [] },
    );
    expect(block.enrichment.enrichment_depth_pct).toBe(0);
  });

  it('reports enrichment_depth_pct=100 when all remote agents succeeded', () => {
    const block = computeExecutionBlock(
      [rufloOk('phase3-sparc'), rufloOk('phase4-adrs-ddd'), rufloOk('phase5a-prompts')],
      { available: ['a', 'b', 'c'], errored: [], entries: [] },
    );
    expect(block.enrichment.enrichment_depth_pct).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// writeExecutionBlockToManifest
// ---------------------------------------------------------------------------

describe('writeExecutionBlockToManifest (ADR-091 §5)', () => {
  let runDir: string;

  beforeEach(() => { runDir = makeTempRunDir(); });
  afterEach(() => { fs.rmSync(runDir, { recursive: true, force: true }); });

  it('merges the execution block into an existing manifest.json without dropping other keys', () => {
    writeManifest(runDir, {
      traceId: 'trace-abc-123',
      query: 'Build a platform',
      simulation_id: 'sim-xyz-9',
      agents_invoked: [{ domain: 'x', agent: 'y', status: 'success' }],
    });
    const block = computeExecutionBlock(
      [rufloOk('phase3-sparc'), rufloOk('phase4-adrs-ddd'), rufloOk('phase5a-prompts')],
      readRemoteEnrichmentSnapshot(runDir),
    );
    writeExecutionBlockToManifest(runDir, block);

    const merged = JSON.parse(fs.readFileSync(path.join(runDir, 'manifest.json'), 'utf-8'));
    expect(merged.traceId).toBe('trace-abc-123');
    expect(merged.query).toBe('Build a platform');
    expect(merged.simulation_id).toBe('sim-xyz-9');
    expect(merged.agents_invoked).toHaveLength(1);
    expect(merged.execution).toEqual(block);
    expect(merged.execution.engineering_tier).toBe('ruflo-local');
  });

  it('creates manifest.json when it does not exist (best-effort)', () => {
    const block = computeExecutionBlock([rufloUnavailable('phase3-sparc')], { available: [], errored: [], entries: [] });
    writeExecutionBlockToManifest(runDir, block);

    const written = JSON.parse(fs.readFileSync(path.join(runDir, 'manifest.json'), 'utf-8'));
    expect(written.execution).toEqual(block);
  });

  it('overwrites a prior execution block (idempotent) without clobbering sibling keys', () => {
    writeManifest(runDir, {
      traceId: 't-1',
      execution: { engineering_tier: 'template', tier_counts: { 'ruflo-local': 0, template: 3 } },
    });
    const block = computeExecutionBlock(
      [rufloOk('phase3-sparc'), rufloOk('phase4-adrs-ddd'), rufloOk('phase5a-prompts')],
      { available: ['a'], errored: [], entries: [] },
    );
    writeExecutionBlockToManifest(runDir, block);

    const merged = JSON.parse(fs.readFileSync(path.join(runDir, 'manifest.json'), 'utf-8'));
    expect(merged.traceId).toBe('t-1');
    expect(merged.execution.engineering_tier).toBe('ruflo-local');
    expect(merged.execution.tier_counts).toEqual({ 'ruflo-local': 3, template: 0 });
    expect(merged.execution.enrichment.enrichment_depth_pct).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// End-to-end manifest-shape scenarios per the ADR verification table
// ---------------------------------------------------------------------------

describe('ADR-091 manifest scenarios', () => {
  let runDir: string;

  beforeEach(() => { runDir = makeTempRunDir(); });
  afterEach(() => { fs.rmSync(runDir, { recursive: true, force: true }); });

  it('Ruflo-available + healthy remote fleet: engineering_tier=ruflo-local, depth=100', () => {
    writeManifest(runDir, {
      agents_invoked: [
        { domain: 'diligence-artifacts', agent: 'sparc-specification', status: 'success' },
        { domain: 'diligence-artifacts', agent: 'sparc-merge', status: 'success' },
        { domain: 'diligence-artifacts', agent: 'adr-generation', status: 'success' },
        { domain: 'quality-engineering', agent: 'coverage-gap-detect', status: 'success' },
      ],
    });
    const block = computeExecutionBlock(
      [rufloOk('phase3-sparc'), rufloOk('phase4-adrs-ddd'), rufloOk('phase5a-prompts')],
      readRemoteEnrichmentSnapshot(runDir),
    );
    writeExecutionBlockToManifest(runDir, block);

    const merged = JSON.parse(fs.readFileSync(path.join(runDir, 'manifest.json'), 'utf-8'));
    expect(merged.execution.engineering_tier).toBe('ruflo-local');
    expect(merged.execution.tier_counts).toEqual({ 'ruflo-local': 3, template: 0 });
    expect(merged.execution.enrichment.enrichment_depth_pct).toBe(100);
    expect(merged.execution.enrichment.remote_agents_available).toHaveLength(4);
    expect(merged.execution.enrichment.remote_agents_errored).toEqual([]);
  });

  it('Ruflo-available + 4 remote 503s: engineering_tier=ruflo-local, depth=0, but artifacts still produced', () => {
    writeManifest(runDir, {
      agents_invoked: [
        { domain: 'diligence-artifacts', agent: 'sparc-specification', status: '503' },
        { domain: 'diligence-artifacts', agent: 'sparc-merge', status: '503' },
        { domain: 'diligence-artifacts', agent: 'adr-generation', status: '503' },
        { domain: 'quality-engineering', agent: 'coverage-gap-detect', status: '503' },
      ],
    });
    const block = computeExecutionBlock(
      [rufloOk('phase3-sparc'), rufloOk('phase4-adrs-ddd'), rufloOk('phase5a-prompts')],
      readRemoteEnrichmentSnapshot(runDir),
    );
    writeExecutionBlockToManifest(runDir, block);

    const merged = JSON.parse(fs.readFileSync(path.join(runDir, 'manifest.json'), 'utf-8'));
    expect(merged.execution.engineering_tier).toBe('ruflo-local');
    expect(merged.execution.enrichment.enrichment_depth_pct).toBe(0);
    expect(merged.execution.enrichment.remote_agents_errored).toHaveLength(4);
  });

  it('AGENTICS_DISABLE_RUFLO path: engineering_tier=template', () => {
    // Simulates the state auto-chain lands in when the executor returns
    // `executionTier: "unavailable"` for all three phases because the env
    // disable is set.
    writeManifest(runDir, {
      agents_invoked: [
        { domain: 'research-lab', agent: 'competitive-analysis', status: 'success' },
      ],
    });
    const block = computeExecutionBlock(
      [
        rufloUnavailable('phase3-sparc'),
        rufloUnavailable('phase4-adrs-ddd'),
        rufloUnavailable('phase5a-prompts'),
      ],
      readRemoteEnrichmentSnapshot(runDir),
    );
    writeExecutionBlockToManifest(runDir, block);

    const merged = JSON.parse(fs.readFileSync(path.join(runDir, 'manifest.json'), 'utf-8'));
    expect(merged.execution.engineering_tier).toBe('template');
    expect(merged.execution.tier_counts).toEqual({ 'ruflo-local': 0, template: 3 });
    expect(merged.execution.enrichment.enrichment_depth_pct).toBe(100);
  });

  it('Mixed enrichment 12/16 = depth 75', () => {
    const agents_invoked: RemoteAgentInvocation[] = [
      ...Array.from({ length: 12 }, (_, i) => ({ domain: 'research-lab', agent: `ok-${i}`, status: 'success' })),
      ...Array.from({ length: 4 }, (_, i) => ({ domain: 'diligence-artifacts', agent: `fail-${i}`, status: '503' })),
    ];
    writeManifest(runDir, { agents_invoked });
    const block = computeExecutionBlock(
      [rufloOk('phase3-sparc'), rufloOk('phase4-adrs-ddd'), rufloOk('phase5a-prompts')],
      readRemoteEnrichmentSnapshot(runDir),
    );
    writeExecutionBlockToManifest(runDir, block);

    const merged = JSON.parse(fs.readFileSync(path.join(runDir, 'manifest.json'), 'utf-8'));
    expect(merged.execution.enrichment.enrichment_depth_pct).toBe(75);
    expect(merged.execution.enrichment.remote_agents_available).toHaveLength(12);
    expect(merged.execution.enrichment.remote_agents_errored).toHaveLength(4);
  });

  it('zero remote enrichment: depth is null (not 0) per ADR §5', () => {
    writeManifest(runDir, { traceId: 'nope', query: 'no remote agents' });
    const block = computeExecutionBlock(
      [rufloOk('phase3-sparc'), rufloOk('phase4-adrs-ddd'), rufloOk('phase5a-prompts')],
      readRemoteEnrichmentSnapshot(runDir),
    );
    writeExecutionBlockToManifest(runDir, block);

    const merged = JSON.parse(fs.readFileSync(path.join(runDir, 'manifest.json'), 'utf-8'));
    expect(merged.execution.enrichment.enrichment_depth_pct).toBeNull();
    expect(merged.execution.enrichment.remote_agents_available).toEqual([]);
    expect(merged.execution.enrichment.remote_agents_errored).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Dossier context plumbing — `runRufloPrimaryForPhase` should see the
// successful remote enrichment as part of the Phase1Dossier extras.
//
// We verify this indirectly via the snapshot helper since that's the single
// source of truth feeding the dossier extras. The full end-to-end wiring is
// exercised by ruflo-phase-executor.test.ts when the executor is actually
// invoked.
// ---------------------------------------------------------------------------

describe('Dossier extras plumbing (ADR-091 §2)', () => {
  let runDir: string;
  beforeEach(() => { runDir = makeTempRunDir(); });
  afterEach(() => { fs.rmSync(runDir, { recursive: true, force: true }); });

  it('surfaces successful remote enrichment to Ruflo as dossier extras (partial remote wins)', () => {
    const agents_invoked: RemoteAgentInvocation[] = [
      { domain: 'diligence-artifacts', agent: 'sparc-specification', status: 'success' }, // partial success
      { domain: 'diligence-artifacts', agent: 'sparc-merge', status: '503' },                // 503
      { domain: 'diligence-artifacts', agent: 'adr-generation', status: '503' },             // 503
      { domain: 'quality-engineering', agent: 'coverage-gap-detect', status: '503' },        // 503
    ];
    writeManifest(runDir, { agents_invoked });

    const snap = readRemoteEnrichmentSnapshot(runDir);
    // The sparc-specification partial result IS in the snapshot and would be
    // wired through buildRufloDossierExtras into Phase1Dossier.extras. The
    // failed ones are NOT in .available (so Ruflo ignores them silently).
    expect(snap.available).toEqual(['sparc-specification']);
    expect(snap.errored).toEqual(['sparc-merge', 'adr-generation', 'coverage-gap-detect']);
    expect(snap.entries).toHaveLength(4);
  });
});
