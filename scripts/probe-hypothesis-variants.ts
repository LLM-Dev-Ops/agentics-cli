/**
 * Try multiple payload shapes for research-lab/hypothesis to find what the
 * server actually reads the sample count from.
 */
import { createAdapter } from '../src/adapters/index.js';
import { loadEndpointConfig } from '../src/config/endpoints.js';
import crypto from 'node:crypto';

const makeObservations = () => [
  ...Array.from({ length: 20 }, () => ({ id: crypto.randomUUID(), values: { model: 'A', accuracy: 0.88 + Math.random() * 0.08 }, group: 'A' })),
  ...Array.from({ length: 20 }, () => ({ id: crypto.randomUUID(), values: { model: 'B', accuracy: 0.83 + Math.random() * 0.08 }, group: 'B' })),
];

const makeSamples = () => Array.from({ length: 40 }, (_, i) => ({
  id: crypto.randomUUID(),
  group: i < 20 ? 'A' : 'B',
  value: (i < 20 ? 0.88 : 0.83) + Math.random() * 0.08,
  accuracy: (i < 20 ? 0.88 : 0.83) + Math.random() * 0.08,
}));

const baseHypothesis = (correlationId: string) => ({
  id: crypto.randomUUID(),
  name: 'Platform Performance Evaluation',
  statement: 'A outperforms B',
  hypothesis_type: 'comparative',
  null_hypothesis: 'No significant difference',
  alternative_hypothesis: 'A > B',
  variables: [
    { name: 'model', role: 'independent', data_type: 'categorical' },
    { name: 'accuracy', role: 'dependent', data_type: 'continuous', unit: 'percentage' },
  ],
  significance_level: 0.05,
});

function buildVariants(correlationId: string): Array<{ name: string; body: unknown }> {
  const hyp = baseHypothesis(correlationId);
  const obs = makeObservations();
  const samples = makeSamples();
  const qualityMetrics = { completeness: 1.0, validity: 1.0, outlier_count: 0, duplicate_count: 0 };
  const config = { test_method: 'mann_whitney_u', apply_correction: false, compute_effect_size: true, generate_diagnostics: true, correction_method: null, random_seed: 42 };

  return [
    // CURRENT SHAPE (the one failing)
    {
      name: 'current (input.experimental_data.observations)',
      body: {
        input: {
          request_id: crypto.randomUUID(),
          hypothesis: hyp,
          experimental_data: { source_id: 'eval', collected_at: new Date().toISOString(), observations: obs, sample_size: 30, quality_metrics: qualityMetrics },
          config,
        },
        trace_context: { trace_id: correlationId, span_id: correlationId.slice(0, 16) },
      },
    },
    // no input wrapper
    {
      name: 'no-input-wrapper (top-level experimental_data)',
      body: {
        request_id: crypto.randomUUID(),
        hypothesis: hyp,
        experimental_data: { source_id: 'eval', collected_at: new Date().toISOString(), observations: obs, sample_size: 30, quality_metrics: qualityMetrics },
        config,
      },
    },
    // samples instead of observations
    {
      name: 'input.samples',
      body: {
        input: {
          request_id: crypto.randomUUID(),
          hypothesis: hyp,
          samples,
          config,
        },
      },
    },
    // data.samples
    {
      name: 'input.data.samples',
      body: {
        input: {
          request_id: crypto.randomUUID(),
          hypothesis: hyp,
          data: { samples, sample_size: 40 },
          config,
        },
      },
    },
    // control_group + treatment_group
    {
      name: 'input.control_group+treatment_group',
      body: {
        input: {
          request_id: crypto.randomUUID(),
          hypothesis: hyp,
          control_group: samples.slice(0, 20).map((s) => s.value),
          treatment_group: samples.slice(20).map((s) => s.value),
          config,
        },
      },
    },
    // payload wrapper (sometimes used)
    {
      name: 'payload.hypothesis+samples',
      body: {
        payload: {
          hypothesis: hyp,
          samples,
          config,
        },
      },
    },
  ];
}

async function tryOne(name: string, body: unknown): Promise<{ name: string; status: number | null; code?: string; message?: string; sample_count_hint?: string; body_len: number }> {
  const correlationId = crypto.randomUUID();
  const cfg = loadEndpointConfig('research-lab-agents');
  const adapter = createAdapter('research-lab-agents', cfg, correlationId);
  try {
    const resp = await adapter.invoke({
      endpoint: `/v1/research-lab/hypothesis`,
      method: 'POST',
      headers: {},
      body,
    });
    const b = resp.body as Record<string, unknown> | undefined;
    const err = b?.['error'] as Record<string, unknown> | undefined;
    const msg = err?.['message'] as string | undefined;
    return {
      name,
      status: resp.status ?? null,
      code: err?.['code'] as string | undefined,
      message: msg,
      sample_count_hint: msg && /got (\d+)/.exec(msg)?.[0],
      body_len: JSON.stringify(b).length,
    };
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    const statusMatch = /\b(\d{3})\b/.exec(m);
    return { name, status: statusMatch ? Number(statusMatch[1]) : null, message: m.slice(0, 300), body_len: 0 };
  }
}

async function main() {
  const cid = crypto.randomUUID();
  const variants = buildVariants(cid);
  for (const v of variants) {
    const res = await tryOne(v.name, v.body);
    const tag = res.status === 200 ? '✅ SUCCESS' : `❌ ${res.status}`;
    process.stderr.write(`${tag}  ${res.name.padEnd(55)} ${res.code ?? ''} ${res.sample_count_hint ?? ''}\n`);
    if (res.status !== 200 && res.message) {
      process.stderr.write(`    └ ${res.message.slice(0, 140)}\n`);
    }
  }
}
main().catch(console.error);
