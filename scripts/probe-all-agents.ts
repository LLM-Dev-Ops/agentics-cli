/**
 * Probe every (domain, agent) pair and classify each response:
 *   REAL       - response came from Cloud Run handler (has execution_metadata, no _fallback)
 *   FALLBACK   - CLI synthesized a local response (_fallback: true)
 *   HEALTH     - endpoint returned a generic health-check shell
 *   ERROR      - threw/unreachable
 *   UNKNOWN    - neither marker present
 *
 * Writes a JSON report and a human-readable summary to scripts/probe-results/.
 */
import { executeAgentsInvokeCommand, AGENT_DOMAINS } from '../src/commands/agents.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

type Verdict = 'REAL' | 'FALLBACK' | 'HEALTH' | 'ERROR' | 'UNKNOWN';

interface Probe {
  domain: string;
  agent: string;
  verdict: Verdict;
  status: number | null;
  timing_ms: number;
  fallback_reason?: string;
  error?: string;
  has_execution_metadata: boolean;
  response_keys: string[];
  response_snippet: string;
}

const DEFAULT_QUERY = 'Probe: exercise this agent with a realistic natural-language request to exercise its handler end-to-end.';

function classify(resp: Record<string, unknown> | undefined): Pick<Probe, 'verdict' | 'fallback_reason' | 'has_execution_metadata'> {
  if (!resp) return { verdict: 'ERROR', has_execution_metadata: false };
  if (resp['_fallback'] === true) {
    return {
      verdict: 'FALLBACK',
      fallback_reason: String(resp['_fallback_reason'] ?? ''),
      has_execution_metadata: 'execution_metadata' in resp,
    };
  }
  const hasExec = 'execution_metadata' in resp;
  if (hasExec) return { verdict: 'REAL', has_execution_metadata: true };

  // Generic health-check shell
  const statusVal = String((resp['status'] ?? resp['Status'] ?? '')).toLowerCase();
  if (statusVal === 'healthy' && ('service' in resp || 'agents' in resp)) {
    return { verdict: 'HEALTH', has_execution_metadata: false };
  }
  return { verdict: 'UNKNOWN', has_execution_metadata: false };
}

async function probeOne(domain: string, agent: string): Promise<Probe> {
  const start = Date.now();
  try {
    const result = await executeAgentsInvokeCommand(
      domain,
      agent,
      { text: DEFAULT_QUERY },
      { format: 'json' },
    );
    const resp = result.response as Record<string, unknown> | undefined;
    const { verdict, fallback_reason, has_execution_metadata } = classify(resp);
    const keys = resp ? Object.keys(resp).slice(0, 20) : [];
    const snippet = resp ? JSON.stringify(resp).slice(0, 280) : '';
    return {
      domain,
      agent,
      verdict,
      status: result.status,
      timing_ms: result.timing,
      fallback_reason,
      has_execution_metadata,
      response_keys: keys,
      response_snippet: snippet,
    };
  } catch (err) {
    return {
      domain,
      agent,
      verdict: 'ERROR',
      status: null,
      timing_ms: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
      has_execution_metadata: false,
      response_keys: [],
      response_snippet: '',
    };
  }
}

async function main(): Promise<void> {
  const filterDomain = process.env['PROBE_DOMAIN'];
  const probes: Probe[] = [];

  const targets: { domain: string; agent: string }[] = [];
  for (const [domain, config] of Object.entries(AGENT_DOMAINS)) {
    if (filterDomain && domain !== filterDomain) continue;
    for (const agent of config.agents) {
      targets.push({ domain, agent });
    }
  }

  process.stderr.write(`Probing ${targets.length} agents across ${filterDomain ? 1 : Object.keys(AGENT_DOMAINS).length} domain(s)...\n`);

  for (const { domain, agent } of targets) {
    process.stderr.write(`  ${domain}/${agent} ... `);
    const probe = await probeOne(domain, agent);
    probes.push(probe);
    process.stderr.write(`${probe.verdict} (${probe.timing_ms}ms)\n`);
  }

  const outDir = join(process.cwd(), 'scripts', 'probe-results');
  mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const jsonPath = join(outDir, `probe-${stamp}.json`);
  writeFileSync(jsonPath, JSON.stringify(probes, null, 2));

  // Summary
  const counts: Record<Verdict, number> = { REAL: 0, FALLBACK: 0, HEALTH: 0, ERROR: 0, UNKNOWN: 0 };
  for (const p of probes) counts[p.verdict]++;
  const total = probes.length;
  const pct = (n: number) => `${n} (${((n / total) * 100).toFixed(1)}%)`;
  process.stderr.write('\n=== SUMMARY ===\n');
  process.stderr.write(`Total:    ${total}\n`);
  process.stderr.write(`REAL:     ${pct(counts.REAL)}\n`);
  process.stderr.write(`FALLBACK: ${pct(counts.FALLBACK)}\n`);
  process.stderr.write(`HEALTH:   ${pct(counts.HEALTH)}\n`);
  process.stderr.write(`ERROR:    ${pct(counts.ERROR)}\n`);
  process.stderr.write(`UNKNOWN:  ${pct(counts.UNKNOWN)}\n`);
  process.stderr.write(`\nReport: ${jsonPath}\n`);

  // Per-domain rollup
  const byDomain: Record<string, Record<Verdict, number>> = {};
  for (const p of probes) {
    byDomain[p.domain] ??= { REAL: 0, FALLBACK: 0, HEALTH: 0, ERROR: 0, UNKNOWN: 0 };
    byDomain[p.domain][p.verdict]++;
  }
  process.stderr.write('\n=== BY DOMAIN ===\n');
  const domainRows = Object.entries(byDomain)
    .map(([d, c]) => ({ d, ...c, total: c.REAL + c.FALLBACK + c.HEALTH + c.ERROR + c.UNKNOWN }))
    .sort((a, b) => b.FALLBACK + b.HEALTH - (a.FALLBACK + a.HEALTH));
  for (const r of domainRows) {
    process.stderr.write(
      `  ${r.d.padEnd(24)} real=${r.REAL}  fb=${r.FALLBACK}  hc=${r.HEALTH}  err=${r.ERROR}  unk=${r.UNKNOWN}  (total=${r.total})\n`,
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
