/**
 * Round 2: wrapper shape is correct (current shape reaches the handler,
 * others 502). The handler sees "got 0" samples — so the observations
 * structure doesn't match what the handler reads. Test alternates.
 */
import { createAdapter } from '../src/adapters/index.js';
import { loadEndpointConfig } from '../src/config/endpoints.js';
import crypto from 'node:crypto';

const correlationId = crypto.randomUUID();

const hyp = {
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
};

// 60 total observations (30 per group) - well over the 30 minimum
const makeObsGrouped = (perGroup: number) => [
  ...Array.from({ length: perGroup }, () => ({ id: crypto.randomUUID(), values: { model: 'A', accuracy: 0.88 + Math.random() * 0.08 }, group: 'A' })),
  ...Array.from({ length: perGroup }, () => ({ id: crypto.randomUUID(), values: { model: 'B', accuracy: 0.83 + Math.random() * 0.08 }, group: 'B' })),
];

const qm = { completeness: 1.0, validity: 1.0, outlier_count: 0, duplicate_count: 0 };
const config = { test_method: 'mann_whitney_u', apply_correction: false, compute_effect_size: true, generate_diagnostics: true, correction_method: null, random_seed: 42 };

const variants: Array<{ name: string; body: unknown }> = [
  {
    name: '60 grouped observations (30/group)',
    body: {
      input: {
        request_id: crypto.randomUUID(),
        hypothesis: hyp,
        experimental_data: { source_id: 'eval', collected_at: new Date().toISOString(), observations: makeObsGrouped(30), sample_size: 60, quality_metrics: qm },
        config,
      },
      trace_context: { trace_id: correlationId, span_id: correlationId.slice(0, 16) },
    },
  },
  {
    name: 'flat values (no nested .values)',
    body: {
      input: {
        request_id: crypto.randomUUID(),
        hypothesis: hyp,
        experimental_data: {
          source_id: 'eval', collected_at: new Date().toISOString(),
          observations: Array.from({ length: 60 }, (_, i) => ({ id: crypto.randomUUID(), group: i < 30 ? 'A' : 'B', model: i < 30 ? 'A' : 'B', accuracy: (i < 30 ? 0.88 : 0.83) + Math.random() * 0.08 })),
          sample_size: 60, quality_metrics: qm,
        },
        config,
      },
    },
  },
  {
    name: 'observations with data field instead of values',
    body: {
      input: {
        request_id: crypto.randomUUID(),
        hypothesis: hyp,
        experimental_data: {
          source_id: 'eval', collected_at: new Date().toISOString(),
          observations: Array.from({ length: 60 }, (_, i) => ({ id: crypto.randomUUID(), data: { model: i < 30 ? 'A' : 'B', accuracy: (i < 30 ? 0.88 : 0.83) + Math.random() * 0.08 }, group: i < 30 ? 'A' : 'B' })),
          sample_size: 60, quality_metrics: qm,
        },
        config,
      },
    },
  },
  {
    name: 'single-sample test_method',
    body: {
      input: {
        request_id: crypto.randomUUID(),
        hypothesis: { ...hyp, hypothesis_type: 'directional' },
        experimental_data: { source_id: 'eval', collected_at: new Date().toISOString(), observations: makeObsGrouped(20), sample_size: 40, quality_metrics: qm },
        config: { ...config, test_method: 't_test_one_sample' },
      },
    },
  },
  {
    name: 'groups field (control/treatment)',
    body: {
      input: {
        request_id: crypto.randomUUID(),
        hypothesis: hyp,
        experimental_data: {
          source_id: 'eval', collected_at: new Date().toISOString(),
          observations: makeObsGrouped(20),
          groups: {
            A: Array.from({ length: 20 }, () => 0.88 + Math.random() * 0.08),
            B: Array.from({ length: 20 }, () => 0.83 + Math.random() * 0.08),
          },
          sample_size: 40, quality_metrics: qm,
        },
        config,
      },
    },
  },
  {
    name: 'observations at top of input (not under experimental_data)',
    body: {
      input: {
        request_id: crypto.randomUUID(),
        hypothesis: hyp,
        observations: makeObsGrouped(20),
        config,
      },
    },
  },
];

async function tryOne(name: string, body: unknown): Promise<{ name: string; status: number | null; code?: string; message?: string; body_snippet?: string }> {
  const cid = crypto.randomUUID();
  const cfg = loadEndpointConfig('research-lab-agents');
  const adapter = createAdapter('research-lab-agents', cfg, cid);
  try {
    const resp = await adapter.invoke({ endpoint: `/v1/research-lab/hypothesis`, method: 'POST', headers: {}, body });
    const b = resp.body as Record<string, unknown> | undefined;
    const err = b?.['error'] as Record<string, unknown> | undefined;
    return {
      name,
      status: resp.status ?? null,
      code: err?.['code'] as string | undefined,
      message: err?.['message'] as string | undefined,
      body_snippet: JSON.stringify(b).slice(0, 300),
    };
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    const s = /\b(\d{3})\b/.exec(m);
    return { name, status: s ? Number(s[1]) : null, message: m.slice(0, 220) };
  }
}

async function main() {
  for (const v of variants) {
    const r = await tryOne(v.name, v.body);
    const tag = r.status === 200 ? '✅ SUCCESS' : `❌ ${r.status}`;
    process.stderr.write(`${tag}  ${r.name.padEnd(60)} ${r.code ?? ''}\n`);
    if (r.status !== 200 && r.message) process.stderr.write(`    └ ${r.message.slice(0, 160)}\n`);
  }
}
main().catch(console.error);
