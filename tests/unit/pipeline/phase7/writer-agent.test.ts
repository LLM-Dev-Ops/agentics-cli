/**
 * Phase 7 — Writer-Agent field generation (ADR-PIPELINE-111).
 *
 * Exercises the deterministic, offline-testable path of
 * `generateDeliverableFields`: agent dispatch (D3), per-run caching, the
 * artifact > slug deterministic backstop (D2), the reserved-field lock (D5),
 * unfilled accounting, and dispatch-failure isolation (D8).
 *
 * `enableLLM` is kept false throughout — `writeFieldsViaLLM` shells out to the
 * real `claude` binary, which is absent offline, so only the deterministic
 * tiers are asserted here.
 */
import { describe, it, expect } from '@jest/globals';
import {
  generateDeliverableFields,
  type WriterContext,
  type AgentDispatch,
  type AgentOutputCache,
} from '../../../../src/pipeline/phase7/writer-agent.js';
import type { DeliverableSpec } from '../../../../src/pipeline/phase7/deliverables-registry.js';

const SPEC: DeliverableSpec = {
  section: 2,
  slug: 'roi-irr-npv-analysis',
  title: 'ROI Analysis',
  format: 'md',
  inputArtifacts: ['unit-economics.json'],
  sourceAgents: ['costops/roi', 'platform/risk-score'],
  templateId: 'financial-model',
  fcvKinds: ['roi'],
};

const TEMPLATE_BODY =
  '# {{title}}\n{{fcvBlock}}\nROI {{roiFcv}}\n{{costBenefitNarrative}}\n{{riskNarrative}}\n{{strategyKind}}';

function makeCtx(overrides: Partial<WriterContext> = {}): WriterContext {
  return {
    scenarioQuery: 'evaluate the ROI of expanding to EU',
    runDir: '/tmp/run',
    traceId: 'trace-1',
    artifactFields: {},
    slugFields: {},
    // title/fcvBlock/roiFcv are coordinator-owned (D5).
    reservedFields: { title: 'ROI Analysis', fcvBlock: 'FCV', roiFcv: '18%' },
    canonicalFigures: 'ROI 18% | NPV $1.2M',
    enableAgents: false,
    enableLLM: false,
    ...overrides,
  };
}

/** Counting fake dispatch — records how many times it is actually invoked. */
function makeCountingDispatch(): { dispatch: AgentDispatch; calls: () => string[] } {
  const calls: string[] = [];
  const dispatch: AgentDispatch = async (domain, agent) => {
    calls.push(`${domain}/${agent}`);
    return { status: 200, tier: 'tier-2', data: { summary: `${domain}/${agent} output` } };
  };
  return { dispatch, calls: () => calls };
}

describe('generateDeliverableFields — D3 dispatch', () => {
  it('records one agents_called entry per sourceAgent, invoking the fake once each', async () => {
    const { dispatch, calls } = makeCountingDispatch();
    const cache: AgentOutputCache = new Map();

    const result = await generateDeliverableFields(
      SPEC,
      TEMPLATE_BODY,
      makeCtx({ enableAgents: true }),
      cache,
      dispatch,
    );

    expect(result.agents_called).toHaveLength(2);
    const refs = result.agents_called.map((a) => a.ref).sort();
    expect(refs).toEqual(['costops/roi', 'platform/risk-score']);
    for (const rec of result.agents_called) {
      expect(rec.status).toBe(200);
      expect(rec.tier).toBe('tier-2');
    }
    // Each unique agent invoked exactly once.
    expect(calls().sort()).toEqual(['costops/roi', 'platform/risk-score']);
  });

  it('caches across calls — same cache + overlapping agents invokes fake once per unique ref', async () => {
    const { dispatch, calls } = makeCountingDispatch();
    const cache: AgentOutputCache = new Map();

    await generateDeliverableFields(SPEC, TEMPLATE_BODY, makeCtx({ enableAgents: true }), cache, dispatch);

    // Second deliverable shares costops/roi, adds a new agent.
    const spec2: DeliverableSpec = { ...SPEC, slug: 'cost-benefit', sourceAgents: ['costops/roi', 'platform/decision'] };
    await generateDeliverableFields(spec2, TEMPLATE_BODY, makeCtx({ enableAgents: true }), cache, dispatch);

    // costops/roi reused from cache; only 3 unique dispatches total.
    expect(calls().sort()).toEqual(['costops/roi', 'platform/decision', 'platform/risk-score']);
    expect(calls().filter((c) => c === 'costops/roi')).toHaveLength(1);
  });

  it('does not dispatch when enableAgents is false', async () => {
    const { dispatch, calls } = makeCountingDispatch();
    const cache: AgentOutputCache = new Map();

    const result = await generateDeliverableFields(
      SPEC,
      TEMPLATE_BODY,
      makeCtx({ enableAgents: false }),
      cache,
      dispatch,
    );

    expect(result.agents_called).toEqual([]);
    expect(calls()).toEqual([]);
  });
});

describe('generateDeliverableFields — D2 deterministic backstop', () => {
  it('resolves artifact-only field with provenance "artifact" and slug-only with "slug"', async () => {
    const cache: AgentOutputCache = new Map();
    const ctx = makeCtx({
      artifactFields: { costBenefitNarrative: 'from artifact' },
      slugFields: { strategyKind: 'from slug' },
    });

    const result = await generateDeliverableFields(SPEC, TEMPLATE_BODY, ctx, cache);

    expect(result.fields.costBenefitNarrative).toBe('from artifact');
    expect(result.field_provenance.costBenefitNarrative).toBe('artifact');
    expect(result.fields.strategyKind).toBe('from slug');
    expect(result.field_provenance.strategyKind).toBe('slug');
  });

  it('artifact wins over slug when a field is present in both', async () => {
    const cache: AgentOutputCache = new Map();
    const ctx = makeCtx({
      artifactFields: { strategyKind: 'artifact value' },
      slugFields: { strategyKind: 'slug value' },
    });

    const result = await generateDeliverableFields(SPEC, TEMPLATE_BODY, ctx, cache);

    expect(result.fields.strategyKind).toBe('artifact value');
    expect(result.field_provenance.strategyKind).toBe('artifact');
  });
});

describe('generateDeliverableFields — D5 reserved lock', () => {
  it('never includes a reserved key (roiFcv) in result.fields', async () => {
    const cache: AgentOutputCache = new Map();
    // Try to smuggle roiFcv in via artifact + slug — it must still be excluded.
    const ctx = makeCtx({
      artifactFields: { roiFcv: 'spoofed', costBenefitNarrative: 'cb' },
      slugFields: { roiFcv: 'spoofed-slug' },
    });

    const result = await generateDeliverableFields(SPEC, TEMPLATE_BODY, ctx, cache);

    expect('roiFcv' in result.fields).toBe(false);
    expect('title' in result.fields).toBe(false);
    expect('fcvBlock' in result.fields).toBe(false);
    expect(result.unfilled).not.toContain('roiFcv');
  });
});

describe('generateDeliverableFields — unfilled accounting', () => {
  it('lists fillable placeholders with no value (LLM off, no artifact/slug)', async () => {
    const cache: AgentOutputCache = new Map();
    const result = await generateDeliverableFields(SPEC, TEMPLATE_BODY, makeCtx(), cache);

    // Fillable = template placeholders minus reserved (title/fcvBlock/roiFcv).
    expect(result.unfilled.sort()).toEqual(['costBenefitNarrative', 'riskNarrative', 'strategyKind']);
    expect(result.fields).toEqual({});
  });
});

describe('generateDeliverableFields — D8 dispatch failure isolation', () => {
  it('a throwing dispatch yields a status>=500 entry and does not throw', async () => {
    const dispatch: AgentDispatch = async (domain, agent) => {
      if (domain === 'costops') throw new Error('boom');
      return { status: 200, tier: 'tier-2', data: { ok: true } };
    };
    const cache: AgentOutputCache = new Map();

    const result = await generateDeliverableFields(
      SPEC,
      TEMPLATE_BODY,
      makeCtx({ enableAgents: true }),
      cache,
      dispatch,
    );

    const failed = result.agents_called.find((a) => a.ref === 'costops/roi');
    expect(failed).toBeDefined();
    expect(failed!.status).toBeGreaterThanOrEqual(500);
    // The healthy agent is still recorded successfully.
    const ok = result.agents_called.find((a) => a.ref === 'platform/risk-score');
    expect(ok!.status).toBe(200);
  });
});
