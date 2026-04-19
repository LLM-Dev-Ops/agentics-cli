import { createAdapter } from '../src/adapters/index.js';
import { loadEndpointConfig } from '../src/config/endpoints.js';
import { buildDomainPayload } from '../src/commands/agents.js';
import crypto from 'node:crypto';

(async () => {
  for (const agent of ['forecast', 'budget']) {
    const cid = crypto.randomUUID();
    const payload = buildDomainPayload('costops', agent, 'probe', cid);
    const cfg = loadEndpointConfig('costops-agents');
    const adapter = createAdapter('costops-agents', cfg, cid);
    try {
      const r = await adapter.invoke({ endpoint: `/v1/costops/${agent}`, method: 'POST', headers: {}, body: payload });
      const b: any = r.body;
      console.log(`=== costops/${agent} HTTP ${r.status} ===`);
      console.log(`  success=${b?.success} error_code=${b?.error?.code}`);
      console.log(`  message: ${b?.error?.message ?? '(none)'}`);
      if (b?.error?.details) console.log(`  details: ${JSON.stringify(b.error.details).slice(0, 500)}`);
      if (b?.success) console.log(`  body keys: ${Object.keys(b).join(', ')}`);
    } catch (e: any) {
      console.log(`=== costops/${agent} THREW ===`);
      console.log(e.message.slice(0, 500));
    }
  }
})().catch(console.error);
