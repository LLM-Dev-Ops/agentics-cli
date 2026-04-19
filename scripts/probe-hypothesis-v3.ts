/**
 * Round 3: schema-valid payloads only (keep input.experimental_data.observations
 * shape to pass validation). Vary fields INSIDE experimental_data to find what
 * the handler uses for sample counting.
 */
import { createAdapter } from '../src/adapters/index.js';
import { loadEndpointConfig } from '../src/config/endpoints.js';
import crypto from 'node:crypto';

const cid = crypto.randomUUID();
const hyp = {
  id: crypto.randomUUID(),
  name: 'Platform Eval',
  statement: 'A > B',
  hypothesis_type: 'comparative',
  null_hypothesis: 'No difference',
  alternative_hypothesis: 'A > B',
  variables: [
    { name: 'model', role: 'independent', data_type: 'categorical' },
    { name: 'accuracy', role: 'dependent', data_type: 'continuous', unit: 'percentage' },
  ],
  significance_level: 0.05,
};
const qm = { completeness: 1.0, validity: 1.0, outlier_count: 0, duplicate_count: 0 };
const config = { test_method: 'mann_whitney_u', apply_correction: false, compute_effect_size: true, generate_diagnostics: true, correction_method: null, random_seed: 42 };

const obsGrouped = [
  ...Array.from({ length: 30 }, () => ({ id: crypto.randomUUID(), values: { model: 'A', accuracy: 0.88 + Math.random() * 0.08 }, group: 'A' })),
  ...Array.from({ length: 30 }, () => ({ id: crypto.randomUUID(), values: { model: 'B', accuracy: 0.83 + Math.random() * 0.08 }, group: 'B' })),
];

const variants: Array<{ name: string; body: unknown }> = [
  {
    name: 'add samples alongside observations',
    body: {
      input: {
        request_id: crypto.randomUUID(),
        hypothesis: hyp,
        experimental_data: {
          source_id: 'eval', collected_at: new Date().toISOString(),
          observations: obsGrouped,
          samples: obsGrouped.map((o) => (o.values as any).accuracy),
          sample_size: 60, quality_metrics: qm,
        },
        config,
      },
    },
  },
  {
    name: 'add data_points alongside observations',
    body: {
      input: {
        request_id: crypto.randomUUID(),
        hypothesis: hyp,
        experimental_data: {
          source_id: 'eval', collected_at: new Date().toISOString(),
          observations: obsGrouped,
          data_points: obsGrouped.map((o) => (o.values as any).accuracy),
          sample_size: 60, quality_metrics: qm,
        },
        config,
      },
    },
  },
  {
    name: 'add measurements alongside observations',
    body: {
      input: {
        request_id: crypto.randomUUID(),
        hypothesis: hyp,
        experimental_data: {
          source_id: 'eval', collected_at: new Date().toISOString(),
          observations: obsGrouped,
          measurements: obsGrouped.map((o) => ({ value: (o.values as any).accuracy, group: o.group })),
          sample_size: 60, quality_metrics: qm,
        },
        config,
      },
    },
  },
  {
    name: 'different hypothesis_type: single_variable',
    body: {
      input: {
        request_id: crypto.randomUUID(),
        hypothesis: { ...hyp, hypothesis_type: 'single_variable' },
        experimental_data: { source_id: 'eval', collected_at: new Date().toISOString(), observations: obsGrouped, sample_size: 60, quality_metrics: qm },
        config,
      },
    },
  },
  {
    name: 'different hypothesis_type: descriptive',
    body: {
      input: {
        request_id: crypto.randomUUID(),
        hypothesis: { ...hyp, hypothesis_type: 'descriptive' },
        experimental_data: { source_id: 'eval', collected_at: new Date().toISOString(), observations: obsGrouped, sample_size: 60, quality_metrics: qm },
        config,
      },
    },
  },
  {
    name: 'observation with statistical_sample wrapper',
    body: {
      input: {
        request_id: crypto.randomUUID(),
        hypothesis: hyp,
        experimental_data: {
          source_id: 'eval', collected_at: new Date().toISOString(),
          observations: obsGrouped.map((o) => ({ ...o, statistical_sample: (o.values as any).accuracy })),
          sample_size: 60, quality_metrics: qm,
        },
        config,
      },
    },
  },
  {
    name: 'test_method: t_test_independent',
    body: {
      input: {
        request_id: crypto.randomUUID(),
        hypothesis: hyp,
        experimental_data: { source_id: 'eval', collected_at: new Date().toISOString(), observations: obsGrouped, sample_size: 60, quality_metrics: qm },
        config: { ...config, test_method: 't_test_independent' },
      },
    },
  },
  {
    name: 'test_method: chi_square',
    body: {
      input: {
        request_id: crypto.randomUUID(),
        hypothesis: hyp,
        experimental_data: { source_id: 'eval', collected_at: new Date().toISOString(), observations: obsGrouped, sample_size: 60, quality_metrics: qm },
        config: { ...config, test_method: 'chi_square' },
      },
    },
  },
];

async function tryOne(name: string, body: unknown) {
  const cfg = loadEndpointConfig('research-lab-agents');
  const adapter = createAdapter('research-lab-agents', cfg, crypto.randomUUID());
  try {
    const resp = await adapter.invoke({ endpoint: '/v1/research-lab/hypothesis', method: 'POST', headers: {}, body });
    const b = resp.body as any;
    return { name, status: resp.status, code: b?.error?.code, message: b?.error?.message, has_output: !!b?.output };
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    const s = /\b(\d{3})\b/.exec(m);
    return { name, status: s ? Number(s[1]) : null, message: m.slice(0, 220) };
  }
}

(async () => {
  for (const v of variants) {
    const r = await tryOne(v.name, v.body);
    const tag = r.status === 200 ? '✅ 200' : `❌ ${r.status}`;
    process.stderr.write(`${tag}  ${(v.name as string).padEnd(55)} ${r.code ?? ''}${r.has_output ? ' [has output]' : ''}\n`);
    if (r.message && r.status !== 200) process.stderr.write(`    └ ${r.message.slice(0, 150)}\n`);
  }
})().catch(console.error);
