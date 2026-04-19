import { createAdapter } from '../src/adapters/index.js';
import { loadEndpointConfig } from '../src/config/endpoints.js';
import { buildDomainPayload } from '../src/commands/agents.js';
import crypto from 'node:crypto';

const targets: Array<{ domain: string; agent: string; service: string; headers?: Record<string, string> }> = [
  { domain: 'auto-optimizer', agent: 'self-optimize', service: 'auto-optimizer-agents' },
  { domain: 'auto-optimizer', agent: 'token', service: 'auto-optimizer-agents' },
  { domain: 'auto-optimizer', agent: 'model-select', service: 'auto-optimizer-agents' },
  { domain: 'costops', agent: 'roi', service: 'costops-agents' },
  { domain: 'policy-engine', agent: 'approval', service: 'policy-engine-agents' },
  { domain: 'research-lab', agent: 'hypothesis', service: 'research-lab-agents' },
];

(async () => {
  for (const t of targets) {
    const cid = crypto.randomUUID();
    const payload = buildDomainPayload(t.domain, t.agent, 'probe', cid);
    const cfg = loadEndpointConfig(t.service);
    const adapter = createAdapter(t.service, cfg, cid);
    const headers: Record<string, string> = { ...(t.headers || {}) };
    if (t.domain === 'policy-engine' || t.domain === 'governance-dashboard' || t.domain === 'costops') {
      headers['x-execution-id'] = cid;
      headers['x-parent-span-id'] = cid;
    }
    try {
      const r = await adapter.invoke({ endpoint: `/v1/${t.domain}/${t.agent}`, method: 'POST', headers, body: payload });
      const b: any = r.body;
      const code = b?.error?.code ?? b?.error?.type ?? '(no code)';
      const msg = (typeof b?.error === 'string' ? b.error : b?.error?.message) ?? '(no msg)';
      console.log(`${t.domain}/${t.agent}  HTTP ${r.status}  code=${code}`);
      console.log(`    ${String(msg).slice(0, 200)}`);
    } catch (e: any) {
      const m = e instanceof Error ? e.message : String(e);
      const st = /\b(\d{3})\b/.exec(m)?.[1] ?? '?';
      console.log(`${t.domain}/${t.agent}  THREW ${st}`);
      console.log(`    ${m.slice(0, 250)}`);
    }
  }
})().catch(console.error);
