/**
 * ADR-PIPELINE-091 §5 — Artifact Renderers consume the `execution` block.
 *
 * Verifies that `renderExecutiveSummary` and `renderExecutiveDecisionMemo`
 * report `engineering_tier` and `enrichment_depth_pct` as TWO INDEPENDENT
 * signals from `manifest.execution`. Ends the dacf7975-class failure where
 * "75% remote availability" was conflated with "50% pipeline precision".
 */

import {
  ARTIFACT_RENDERERS,
  type RenderContext,
  type ExecutionInfo,
} from '../../../../src/pipeline/enterprise/artifact-renderers.js';
import type { DecisionGraphNode } from '../../../../src/pipeline/enterprise/types.js';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function makeNode(overrides: Partial<DecisionGraphNode> = {}): DecisionGraphNode {
  return {
    id: 'node-1',
    type: 'executive_summary',
    name: 'Exec Node',
    content: { context: 'ctx', problem: 'p', outcomes: 'o', risks: 'r', timeline: 't' },
    summary: 'summary',
    producedBy: { domain: 'test', agent: 'test', role: 'test' },
    pass: 5,
    derivedFrom: [],
    timestamp: '2026-04-23T00:00:00Z',
    confidence: 0.9,
    status: 'complete',
    tags: [],
    version: 1,
    ...overrides,
  };
}

function makeCtx(
  execution: ExecutionInfo | undefined,
  overrides: Partial<RenderContext> = {},
): RenderContext {
  return {
    executionId: 'exec-1',
    prompt: 'test',
    timestamp: '2026-04-23T00:00:00Z',
    allNodes: [],
    relevantNodes: [makeNode({ type: 'executive_summary' })],
    isDegraded: false,
    passesDegraded: [],
    execution,
    ...overrides,
  };
}

const renderExecSummary = ARTIFACT_RENDERERS[2]!;
const renderExecMemo = ARTIFACT_RENDERERS[1]!;

// A patterns of strings that indicate the old dacf7975-class conflation.
// Any of these appearing in rendered output = a regression.
const PRECISION_CONFLATION_PATTERNS: readonly (string | RegExp)[] = [
  /precision\s*:\s*50%/i,
  /precision\s*:\s*75%/i,
  /pipeline precision/i,
  /pipeline-wide precision/i,
];

function expectNoConflation(output: string): void {
  for (const p of PRECISION_CONFLATION_PATTERNS) {
    if (typeof p === 'string') {
      expect(output).not.toContain(p);
    } else {
      expect(output).not.toMatch(p);
    }
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ADR-PIPELINE-091 §5 — renderers consume execution block as two independent signals', () => {

  describe('renderExecutiveSummary', () => {

    test('ruflo-local tier + 75% enrichment → reports Ruflo AND 75%, no precision conflation', () => {
      const execution: ExecutionInfo = {
        engineering_tier: 'ruflo-local',
        tier_counts: { 'ruflo-local': 5, template: 0 },
        enrichment: {
          remote_agents_available: [
            'competitive-analysis', 'regulatory-citations', 'industry-benchmarks',
            'market-sizing', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h',
          ],
          remote_agents_errored: [
            'sparc-specification', 'sparc-merge', 'adr-generation', 'coverage-gap-detect',
          ],
          enrichment_depth_pct: 75,
        },
      };

      const out = renderExecSummary(makeCtx(execution));

      // Signal 1 — engineering tier
      expect(out).toContain('Ruflo');
      expect(out).toMatch(/local Ruflo swarm/i);

      // Signal 2 — enrichment depth (independent of tier)
      expect(out).toContain('75%');
      expect(out).toMatch(/12 of 16/);
      expect(out).toContain('sparc-specification');

      // No dacf7975-class conflation
      expectNoConflation(out);

      // Independence framing present
      expect(out).toMatch(/two signals are independent|independent signals/i);
    });

    test('template tier → reports deterministic templates and template-tier fidelity', () => {
      const execution: ExecutionInfo = {
        engineering_tier: 'template',
        tier_counts: { 'ruflo-local': 0, template: 5 },
        enrichment: {
          remote_agents_available: [],
          remote_agents_errored: [],
          enrichment_depth_pct: null,
        },
      };

      const out = renderExecSummary(makeCtx(execution));

      expect(out).toMatch(/deterministic templates|template-tier|template tier/i);
      expect(out).toMatch(/lower fidelity/i);
      expectNoConflation(out);
    });

    test('100% enrichment → reports "all enrichment agents returned"', () => {
      const execution: ExecutionInfo = {
        engineering_tier: 'ruflo-local',
        tier_counts: { 'ruflo-local': 5, template: 0 },
        enrichment: {
          remote_agents_available: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm', 'n', 'o', 'p'],
          remote_agents_errored: [],
          enrichment_depth_pct: 100,
        },
      };

      const out = renderExecSummary(makeCtx(execution));

      expect(out).toContain('100%');
      expect(out).toMatch(/all 16 remote enrichment agents returned/i);
      expectNoConflation(out);
    });

    test('0% enrichment → reports "no remote enrichment agents returned"', () => {
      const execution: ExecutionInfo = {
        engineering_tier: 'ruflo-local',
        tier_counts: { 'ruflo-local': 5, template: 0 },
        enrichment: {
          remote_agents_available: [],
          remote_agents_errored: ['a', 'b', 'c'],
          enrichment_depth_pct: 0,
        },
      };

      const out = renderExecSummary(makeCtx(execution));

      expect(out).toMatch(/no remote enrichment agents returned/i);
      expect(out).toMatch(/Phase 1 dossier/i);
      expectNoConflation(out);
    });

    test('enrichment_depth_pct === null → no enrichment-depth prose at all', () => {
      const execution: ExecutionInfo = {
        engineering_tier: 'ruflo-local',
        tier_counts: { 'ruflo-local': 5, template: 0 },
        enrichment: {
          remote_agents_available: [],
          remote_agents_errored: [],
          enrichment_depth_pct: null,
        },
      };

      const out = renderExecSummary(makeCtx(execution));

      // Engineering tier still reported
      expect(out).toMatch(/local Ruflo swarm/i);
      // Enrichment-depth prose skipped entirely
      expect(out).not.toMatch(/enrichment depth/i);
      expect(out).not.toMatch(/remote enrichment agents returned/i);
      expectNoConflation(out);
    });

    test('execution block absent → output is pre-ADR-091 baseline (no new prose)', () => {
      const baseline = renderExecSummary(makeCtx(undefined));
      const withUndefined = renderExecSummary(makeCtx(undefined));

      // Stable across calls (the renderer is pure for a given ctx).
      expect(baseline).toBe(withUndefined);

      // None of the new section headers leak in when execution is absent.
      expect(baseline).not.toContain('Pipeline Execution Provenance');
      expect(baseline).not.toMatch(/Engineering artifact production/i);
      expect(baseline).not.toMatch(/Remote enrichment depth/i);
      expect(baseline).not.toMatch(/local Ruflo swarm/i);
      expect(baseline).not.toMatch(/deterministic templates/i);

      // And baseline still contains the existing section headers.
      expect(baseline).toContain('Executive Summary');
      expect(baseline).toContain('Strategic Context');
      expect(baseline).toContain('Quality Criteria');
    });

    test('execution present does NOT remove or alter pre-existing Executive Summary sections', () => {
      const execution: ExecutionInfo = {
        engineering_tier: 'ruflo-local',
        tier_counts: { 'ruflo-local': 5, template: 0 },
        enrichment: {
          remote_agents_available: ['a'],
          remote_agents_errored: [],
          enrichment_depth_pct: 100,
        },
      };
      const out = renderExecSummary(makeCtx(execution));

      expect(out).toContain('Executive Summary');
      expect(out).toContain('Strategic Context');
      expect(out).toContain('Problem Description');
      expect(out).toContain('Recommended Architecture');
      expect(out).toContain('Expected Outcomes');
      expect(out).toContain('Key Risks');
      expect(out).toContain('Timeline Summary');
      expect(out).toContain('Quality Criteria');
    });
  });

  describe('renderExecutiveDecisionMemo', () => {

    test('adds "How these artifacts were produced" note when execution present', () => {
      const execution: ExecutionInfo = {
        engineering_tier: 'ruflo-local',
        tier_counts: { 'ruflo-local': 5, template: 0 },
        enrichment: {
          remote_agents_available: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l'],
          remote_agents_errored: ['x', 'y', 'z', 'w'],
          enrichment_depth_pct: 75,
        },
      };

      const ctx: RenderContext = {
        executionId: 'exec-1',
        prompt: 'test',
        timestamp: '2026-04-23T00:00:00Z',
        allNodes: [],
        relevantNodes: [makeNode({ type: 'executive_memo', content: { decision: 'Approve' } })],
        isDegraded: false,
        passesDegraded: [],
        execution,
      };

      const out = renderExecMemo(ctx);

      expect(out).toMatch(/How these artifacts were produced/i);
      expect(out).toMatch(/local Ruflo swarm/i);
      expect(out).toContain('75%');
      expect(out).toMatch(/12 of 16/);
      expectNoConflation(out);

      // Existing memo structure preserved.
      expect(out).toContain('Decision Requested');
      expect(out).toContain('Problem Statement');
      expect(out).toContain('Recommendation');
      expect(out).toContain('Quality Criteria');
    });

    test('template tier memo note mentions deterministic templates', () => {
      const execution: ExecutionInfo = {
        engineering_tier: 'template',
        tier_counts: { 'ruflo-local': 0, template: 5 },
        enrichment: {
          remote_agents_available: [],
          remote_agents_errored: [],
          enrichment_depth_pct: null,
        },
      };

      const ctx: RenderContext = {
        executionId: 'exec-1',
        prompt: 'test',
        timestamp: '2026-04-23T00:00:00Z',
        allNodes: [],
        relevantNodes: [makeNode({ type: 'executive_memo', content: { decision: 'Approve' } })],
        isDegraded: false,
        passesDegraded: [],
        execution,
      };

      const out = renderExecMemo(ctx);

      expect(out).toMatch(/How these artifacts were produced/i);
      expect(out).toMatch(/deterministic templates/i);
      // No enrichment sentence when enrichment_depth_pct === null.
      expect(out).not.toMatch(/Remote enrichment depth was/i);
      expectNoConflation(out);
    });

    test('execution absent → memo output unchanged from pre-ADR-091 baseline', () => {
      const ctx: RenderContext = {
        executionId: 'exec-1',
        prompt: 'test',
        timestamp: '2026-04-23T00:00:00Z',
        allNodes: [],
        relevantNodes: [makeNode({ type: 'executive_memo', content: { decision: 'Approve' } })],
        isDegraded: false,
        passesDegraded: [],
      };

      const out = renderExecMemo(ctx);

      expect(out).not.toMatch(/How these artifacts were produced/i);
      expect(out).not.toMatch(/local Ruflo swarm/i);
      expect(out).not.toMatch(/deterministic templates/i);

      // Baseline structure preserved.
      expect(out).toContain('Executive Decision Memo');
      expect(out).toContain('Decision Requested');
      expect(out).toContain('Quality Criteria');
    });
  });

  describe('Independence invariant — no conflation of tier and enrichment', () => {

    test('low enrichment (0%) under ruflo-local tier does NOT penalize engineering-tier prose', () => {
      const execution: ExecutionInfo = {
        engineering_tier: 'ruflo-local',
        tier_counts: { 'ruflo-local': 5, template: 0 },
        enrichment: {
          remote_agents_available: [],
          remote_agents_errored: ['a', 'b', 'c', 'd'],
          enrichment_depth_pct: 0,
        },
      };

      const out = renderExecSummary(makeCtx(execution));

      // Engineering-tier prose still positive about Ruflo.
      expect(out).toMatch(/local Ruflo swarm/i);
      expect(out).not.toMatch(/lower fidelity/i); // that's template-tier wording

      // Enrichment prose independently reports 0%.
      expect(out).toMatch(/no remote enrichment agents returned/i);

      expectNoConflation(out);
    });

    test('100% enrichment under template tier still reports template-tier honestly', () => {
      const execution: ExecutionInfo = {
        engineering_tier: 'template',
        tier_counts: { 'ruflo-local': 0, template: 5 },
        enrichment: {
          remote_agents_available: ['a', 'b', 'c'],
          remote_agents_errored: [],
          enrichment_depth_pct: 100,
        },
      };

      const out = renderExecSummary(makeCtx(execution));

      expect(out).toMatch(/deterministic templates/i);
      expect(out).toMatch(/lower fidelity/i);
      expect(out).toContain('100%');
      expectNoConflation(out);
    });
  });
});
