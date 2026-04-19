import { createAdapter } from '../src/adapters/index.js';
import { loadEndpointConfig } from '../src/config/endpoints.js';
import { buildDomainPayload } from '../src/commands/agents.js';
import crypto from 'node:crypto';

const targets: Array<{ domain: string; agent: string; service: string; needsExecHeaders?: boolean }> = [
  { domain: 'auto-optimizer', agent: 'token', service: 'auto-optimizer-agents' },
  { domain: 'policy-engine', agent: 'approval', service: 'policy-engine-agents', needsExecHeaders: true },
];

async function probe(t: typeof targets[number], attempt: number) {
  const cid = crypto.randomUUID();
  const payload = buildDomainPayload(t.domain, t.agent, 'probe', cid);
  const cfg = loadEndpointConfig(t.service);
  const adapter = createAdapter(t.service, cfg, cid);
  const headers: Record<string, string> = {};
  if (t.needsExecHeaders) {
    headers['x-execution-id'] = cid;
    headers['x-parent-span-id'] = cid;
  }
  try {
    const r = await adapter.invoke({ endpoint: `/v1/${t.domain}/${t.agent}`, method: 'POST', headers, body: payload });
    const b: any = r.body;
    const isReal = !b?._fallback && ('execution_metadata' in (b || {}));
    console.log(`[attempt ${attempt}] ${t.domain}/${t.agent} HTTP ${r.status}  success=${b?.success}  error=${b?.error?.code ?? '(none)'}  hasExecMeta=${'execution_metadata' in (b||{})}`);
    if (b?.error) console.log(`                              message: ${JSON.stringify(b.error).slice(0, 220)}`);
  } catch (e: any) {
    const m = e instanceof Error ? e.message : String(e);
    const status = /\b(\d{3})\b/.exec(m)?.[1] ?? '?';
    console.log(`[attempt ${attempt}] ${t.domain}/${t.agent} THREW ${status}  ${m.slice(0, 200)}`);
  }
}

(async () => {
  for (const t of targets) {
    console.log(`\n=== ${t.domain}/${t.agent} (3 attempts, 2s apart) ===`);
    for (let i = 1; i <= 3; i++) {
      await probe(t, i);
      if (i < 3) await new Promise((r) => setTimeout(r, 2000));
    }
  }
})().catch(console.error);
