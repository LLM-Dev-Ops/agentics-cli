import { createAdapter } from '../src/adapters/index.js';
import { loadEndpointConfig } from '../src/config/endpoints.js';
import { buildDomainPayload } from '../src/commands/agents.js';
import crypto from 'node:crypto';

const cid = crypto.randomUUID();
const base = buildDomainPayload('research-lab', 'metrics', 'probe', cid) as any;

const variants: Array<{ name: string; headers: Record<string,string>; body: any }> = [
  { name: 'baseline (no headers, no ctx)', headers: {}, body: base },
  { name: 'x-execution-id + x-parent-span-id',
    headers: { 'x-execution-id': cid, 'x-parent-span-id': cid }, body: base },
  { name: 'execution_context in body at top level',
    headers: {}, body: { ...base, execution_context: { execution_id: cid, parent_span_id: cid } } },
  { name: 'execution_context inside input',
    headers: {}, body: { ...base, input: { ...base.input, execution_context: { execution_id: cid, parent_span_id: cid } } } },
  { name: 'headers + body at top',
    headers: { 'x-execution-id': cid, 'x-parent-span-id': cid },
    body: { ...base, execution_context: { execution_id: cid, parent_span_id: cid } } },
  { name: 'Agentics- prefix headers',
    headers: { 'Agentics-Execution-Id': cid, 'Agentics-Parent-Span-Id': cid }, body: base },
];

async function test(name: string, headers: Record<string,string>, body: any) {
  const cfg = loadEndpointConfig('research-lab-agents');
  const adapter = createAdapter('research-lab-agents', cfg, crypto.randomUUID());
  try {
    const r = await adapter.invoke({ endpoint: '/v1/research-lab/metrics', method: 'POST', headers, body });
    const b: any = r.body;
    const ok = r.status === 200 && !b?.repo_span?.status?.toString?.().includes('FAIL');
    const failReason = b?.repo_span?.failure_reason || b?.error?.message || '';
    console.log(`${ok ? '✅' : '❌'} ${String(r.status).padEnd(3)} ${name.padEnd(45)} ${failReason.slice(0, 80)}`);
  } catch (e: any) {
    const m = e instanceof Error ? e.message : String(e);
    const st = /\b(\d{3})\b/.exec(m)?.[1] ?? '?';
    console.log(`❌ ${st.padEnd(3)} ${name.padEnd(45)} threw`);
  }
}

(async () => { for (const v of variants) await test(v.name, v.headers, v.body); })().catch(console.error);
