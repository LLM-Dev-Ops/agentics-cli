/**
 * Call each failing agent directly via the adapter (no CLI fallback).
 * Captures the raw HTTP status + body from Cloud Run so we can classify:
 *   ENV       - service reports a missing config/URL — fixable via Secret Manager
 *   CODE      - handler crash/500 from server code — needs downstream repo fix
 *   SCHEMA    - server rejects payload shape — could be CLI or server
 *   404       - endpoint/route missing at the service — server wiring
 *   OTHER     - inspect manually
 */
import { createAdapter } from '../src/adapters/index.js';
import { loadEndpointConfig } from '../src/config/endpoints.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import crypto from 'node:crypto';

// Import the CLI's payload builder so we send the same body the real CLI would send.
// We need to grab it reflectively since it isn't exported.
import * as agentsModule from '../src/commands/agents.js';

const FAILING = [
  // test-bench (all 14)
  { domain: 'test-bench', agent: 'benchmark', service: 'test-bench-agents' },
  { domain: 'test-bench', agent: 'compare', service: 'test-bench-agents' },
  { domain: 'test-bench', agent: 'regression', service: 'test-bench-agents' },
  { domain: 'test-bench', agent: 'quality', service: 'test-bench-agents' },
  { domain: 'test-bench', agent: 'hallucination', service: 'test-bench-agents' },
  { domain: 'test-bench', agent: 'faithfulness', service: 'test-bench-agents' },
  { domain: 'test-bench', agent: 'bias', service: 'test-bench-agents' },
  { domain: 'test-bench', agent: 'prompt-sensitivity', service: 'test-bench-agents' },
  { domain: 'test-bench', agent: 'consistency', service: 'test-bench-agents' },
  { domain: 'test-bench', agent: 'stress', service: 'test-bench-agents' },
  { domain: 'test-bench', agent: 'red-team', service: 'test-bench-agents' },
  { domain: 'test-bench', agent: 'adversarial', service: 'test-bench-agents' },
  { domain: 'test-bench', agent: 'golden-dataset', service: 'test-bench-agents' },
  { domain: 'test-bench', agent: 'synthetic-data', service: 'test-bench-agents' },
  // forge
  { domain: 'forge', agent: 'version-compat', service: 'forge-agents' },
  // auto-optimizer
  { domain: 'auto-optimizer', agent: 'self-optimize', service: 'auto-optimizer-agents' },
  { domain: 'auto-optimizer', agent: 'model-select', service: 'auto-optimizer-agents' },
  // incident-manager
  { domain: 'incident-manager', agent: 'escalation', service: 'incident-manager-agents' },
  // costops
  { domain: 'costops', agent: 'forecast', service: 'costops-agents' },
  { domain: 'costops', agent: 'budget', service: 'costops-agents' },
  { domain: 'costops', agent: 'roi', service: 'costops-agents' },
  // policy-engine
  { domain: 'policy-engine', agent: 'enforce', service: 'policy-engine-agents' },
  { domain: 'policy-engine', agent: 'constraints', service: 'policy-engine-agents' },
  // inference-gateway
  { domain: 'inference-gateway', agent: 'route', service: 'inference-gateway-agents' },
  // research-lab
  { domain: 'research-lab', agent: 'hypothesis', service: 'research-lab-agents' },
];

const TEXT = 'Probe: exercise this agent with a realistic natural-language request to exercise its handler end-to-end.';

type RawResult = {
  domain: string;
  agent: string;
  status: number | null;
  headers: Record<string, string>;
  body_snippet: string;
  error_code?: string;
  error_message?: string;
  timing_ms: number;
  threw?: string;
};

function extractErrorInfo(body: unknown): { code?: string; message?: string } {
  if (!body || typeof body !== 'object') return {};
  const b = body as Record<string, unknown>;
  // common shapes
  const err = b['error'] ?? b['errors'];
  if (typeof err === 'string') return { message: err };
  if (Array.isArray(err)) return { message: err.map((e) => (typeof e === 'string' ? e : JSON.stringify(e))).join('; ') };
  if (err && typeof err === 'object') {
    const e = err as Record<string, unknown>;
    return { code: e['code'] as string | undefined, message: (e['message'] ?? e['msg']) as string | undefined };
  }
  if (b['message'] && typeof b['message'] === 'string') return { message: b['message'] as string };
  return {};
}

async function probeRaw(domain: string, agent: string, serviceName: string): Promise<RawResult> {
  const start = Date.now();
  const correlationId = crypto.randomUUID();
  // Use same payload-building the CLI does
  const buildDomainPayload = (agentsModule as unknown as { buildDomainPayload?: Function }).buildDomainPayload;
  let payload: unknown = { text: TEXT };
  if (typeof buildDomainPayload === 'function') {
    try {
      payload = buildDomainPayload(domain, agent, TEXT, correlationId);
    } catch {
      payload = { text: TEXT };
    }
  }

  try {
    const config = loadEndpointConfig(serviceName);
    const adapter = createAdapter(serviceName, config, correlationId);
    const extraHeaders: Record<string, string> = {};
    if (domain === 'policy-engine' || domain === 'governance-dashboard') {
      extraHeaders['x-execution-id'] = correlationId;
      extraHeaders['x-parent-span-id'] = correlationId;
    }
    const resp = await adapter.invoke({
      endpoint: `/v1/${domain}/${agent}`,
      method: 'POST',
      headers: extraHeaders,
      body: payload,
    });
    const bodyStr = typeof resp.body === 'string' ? resp.body : JSON.stringify(resp.body);
    const { code, message } = extractErrorInfo(resp.body);
    return {
      domain,
      agent,
      status: resp.status ?? null,
      headers: (resp.headers as Record<string, string>) ?? {},
      body_snippet: bodyStr.slice(0, 800),
      error_code: code,
      error_message: message,
      timing_ms: Date.now() - start,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Adapter throws on non-OK; try to extract status from message
    const statusMatch = /\b(\d{3})\b/.exec(msg);
    return {
      domain,
      agent,
      status: statusMatch ? Number(statusMatch[1]) : null,
      headers: {},
      body_snippet: msg.slice(0, 800),
      threw: msg.slice(0, 800),
      timing_ms: Date.now() - start,
    };
  }
}

async function main(): Promise<void> {
  const results: RawResult[] = [];
  process.stderr.write(`Raw-probing ${FAILING.length} failing agents...\n`);
  for (const { domain, agent, service } of FAILING) {
    process.stderr.write(`  ${domain}/${agent} ... `);
    const r = await probeRaw(domain, agent, service);
    results.push(r);
    const tag = r.threw ? `THREW(${r.status ?? '?'})` : `HTTP ${r.status}`;
    const errSummary = r.error_code || (r.error_message?.slice(0, 60) ?? '');
    process.stderr.write(`${tag} ${errSummary}\n`);
  }
  const outDir = join(process.cwd(), 'scripts', 'probe-results');
  mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const path = join(outDir, `raw-probe-${stamp}.json`);
  writeFileSync(path, JSON.stringify(results, null, 2));
  process.stderr.write(`\nReport: ${path}\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
