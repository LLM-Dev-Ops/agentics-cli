import { createAdapter } from '../src/adapters/index.js';
import { loadEndpointConfig } from '../src/config/endpoints.js';
import { buildDomainPayload } from '../src/commands/agents.js';
import crypto from 'node:crypto';

(async () => {
  for (const agent of ['hypothesis', 'metrics']) {
    const cid = crypto.randomUUID();
    const payload = buildDomainPayload('research-lab', agent, 'probe', cid);
    const cfg = loadEndpointConfig('research-lab-agents');
    const adapter = createAdapter('research-lab-agents', cfg, cid);
    try {
      const r = await adapter.invoke({ endpoint: `/v1/research-lab/${agent}`, method: 'POST', headers: { 'x-execution-id': cid, 'x-parent-span-id': cid }, body: payload });
      const b: any = r.body;
      console.log(`=== research-lab/${agent}  HTTP ${r.status} ===`);
      console.log(JSON.stringify(b).slice(0, 900));
      console.log();
    } catch (e: any) {
      const m = e instanceof Error ? e.message : String(e);
      const st = /\b(\d{3})\b/.exec(m)?.[1] ?? '?';
      console.log(`=== research-lab/${agent}  THREW ${st} ===`);
      console.log(m.slice(0, 900));
      console.log();
    }
  }
})().catch(console.error);
