/**
 * ADR-PIPELINE-096 D2 — Runtime lineage block in ask-artifact-writer's
 * manifest.json.
 *
 * Validates that buildManifest emits a `runtime` block with the three
 * sub-keys: ruflo, ruvector, fleet. Verification scenarios 3 (Ruvector
 * lineage) and 8 (lite-depth backwards compat) live here.
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { persistAskResults } from '../../../src/synthesis/ask-artifact-writer.js';
import type { RouteResult } from '../../../src/commands/agents.js';

let tmpDir: string;
let savedHome: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ask-runtime-096-'));
  savedHome = process.env['HOME'];
  process.env['HOME'] = tmpDir;
});

afterEach(() => {
  if (savedHome === undefined) delete process.env['HOME'];
  else process.env['HOME'] = savedHome;
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

function makeMultiResult(invocations: Array<{ domain: string; agent: string; succeeded?: boolean; status?: number }>): RouteResult {
  return {
    kind: 'multi' as const,
    result: {
      query: 'test',
      intents: invocations.map(i => ({
        domain: i.domain,
        agent: i.agent,
        confidence: 1,
        suggested_payload: {},
        reasoning: 'test',
      })),
      invocations: invocations.map(i => ({
        intent: {
          domain: i.domain,
          agent: i.agent,
          confidence: 1,
          suggested_payload: {},
          reasoning: 'test',
        },
        result: i.succeeded === false
          ? { error: 'mocked error' }
          : { domain: i.domain, agent: i.agent, status: i.status ?? 200, response: { ok: true }, timing: 100 },
      })),
      routing: { matched: true, totalAgents: invocations.length, totalRepos: 1, resolvedCapabilities: ['test'], explanation: 'test' },
      timing: 1234,
    },
  };
}

describe('ADR-096 D2 — manifest.runtime block', () => {
  it('emits runtime.ruflo, runtime.ruvector, runtime.fleet on every run', async () => {
    const route = makeMultiResult([
      { domain: 'simulator', agent: 'enterprise' },
      { domain: 'costops', agent: 'forecast' },
      { domain: 'costops', agent: 'roi' },
    ]);
    const out = persistAskResults({ query: 'q', routeResult: route, traceId: 'trace-d2-1', timing: 100 });
    const manifest = JSON.parse(fs.readFileSync(path.join(out.runDir, 'manifest.json'), 'utf8')) as Record<string, unknown>;

    expect(manifest['runtime']).toBeDefined();
    const runtime = manifest['runtime'] as Record<string, unknown>;
    expect(runtime['ruflo']).toBeDefined();
    expect(runtime['ruvector']).toBeDefined();
    expect(runtime['fleet']).toBeDefined();
    expect(manifest['schema_version']).toBe('1.1.0');
  });

  it('runtime.ruflo includes available, version, binary, reason fields', async () => {
    const route = makeMultiResult([{ domain: 'copilot', agent: 'planner' }]);
    const out = persistAskResults({ query: 'q', routeResult: route, traceId: 'trace-d2-2', timing: 100 });
    const manifest = JSON.parse(fs.readFileSync(path.join(out.runDir, 'manifest.json'), 'utf8')) as Record<string, unknown>;
    const ruflo = (manifest['runtime'] as Record<string, unknown>)['ruflo'] as Record<string, unknown>;
    expect(typeof ruflo['available']).toBe('boolean');
    expect(typeof ruflo['version']).toBe('string');
    expect(typeof ruflo['binary']).toBe('string');
    expect(typeof ruflo['reason']).toBe('string');
  });

  it('runtime.ruvector.hyperbolic_simulations enumerates simulator agents', async () => {
    const route = makeMultiResult([
      { domain: 'simulator', agent: 'enterprise' },
      { domain: 'simulator', agent: 'what-if' },
      { domain: 'simulator', agent: 'scenario' },
      { domain: 'costops', agent: 'forecast' },
    ]);
    const out = persistAskResults({ query: 'q', routeResult: route, traceId: 'trace-d2-3', timing: 100 });
    const manifest = JSON.parse(fs.readFileSync(path.join(out.runDir, 'manifest.json'), 'utf8')) as Record<string, unknown>;
    const ruvector = (manifest['runtime'] as Record<string, unknown>)['ruvector'] as Record<string, unknown>;
    const sims = ruvector['hyperbolic_simulations'] as Array<Record<string, unknown>>;
    expect(sims).toHaveLength(3);
    expect(sims.map(s => s['agent']).sort()).toEqual([
      'simulator/enterprise',
      'simulator/scenario',
      'simulator/what-if',
    ]);
  });

  it('runtime.fleet.by_domain aggregates dispatched/succeeded/failed per domain', async () => {
    const route = makeMultiResult([
      { domain: 'costops', agent: 'forecast' },
      { domain: 'costops', agent: 'roi' },
      { domain: 'costops', agent: 'budget', succeeded: false },
      { domain: 'shield', agent: 'pii' },
    ]);
    const out = persistAskResults({ query: 'q', routeResult: route, traceId: 'trace-d2-4', timing: 100 });
    const manifest = JSON.parse(fs.readFileSync(path.join(out.runDir, 'manifest.json'), 'utf8')) as Record<string, unknown>;
    const fleet = (manifest['runtime'] as Record<string, unknown>)['fleet'] as Record<string, unknown>;
    const byDomain = fleet['by_domain'] as Record<string, { dispatched: number; succeeded: number; failed: number }>;
    expect(byDomain['costops']).toEqual({ dispatched: 3, succeeded: 2, failed: 1 });
    expect(byDomain['shield']).toEqual({ dispatched: 1, succeeded: 1, failed: 0 });
    expect(fleet['dispatched']).toBe(4);
    expect(fleet['succeeded']).toBe(3);
    expect(fleet['failed']).toBe(1);
  });

  it('runtime.fleet.depth is inferred from dispatched count when not threaded through', async () => {
    // 5 agents → lite
    const lite = makeMultiResult([
      { domain: 'a', agent: '1' }, { domain: 'a', agent: '2' }, { domain: 'a', agent: '3' },
      { domain: 'a', agent: '4' }, { domain: 'a', agent: '5' },
    ]);
    const liteOut = persistAskResults({ query: 'q', routeResult: lite, traceId: 't-lite', timing: 100 });
    const liteManifest = JSON.parse(fs.readFileSync(path.join(liteOut.runDir, 'manifest.json'), 'utf8')) as Record<string, unknown>;
    expect(((liteManifest['runtime'] as Record<string, unknown>)['fleet'] as Record<string, unknown>)['depth']).toBe('lite');
  });

  it('runtime.fleet.depth=consultancy when 100+ agents dispatched', async () => {
    const fanout = Array.from({ length: 109 }, (_, i) => ({ domain: `dom${i % 27}`, agent: `agent${i}` }));
    const consultancy = makeMultiResult(fanout);
    const out = persistAskResults({ query: 'q', routeResult: consultancy, traceId: 't-consultancy', timing: 100 });
    const manifest = JSON.parse(fs.readFileSync(path.join(out.runDir, 'manifest.json'), 'utf8')) as Record<string, unknown>;
    expect(((manifest['runtime'] as Record<string, unknown>)['fleet'] as Record<string, unknown>)['depth']).toBe('consultancy');
  });

  it('schema_version is bumped to 1.1.0 (was 1.0.0 pre-D2)', async () => {
    const route = makeMultiResult([{ domain: 'a', agent: 'b' }]);
    const out = persistAskResults({ query: 'q', routeResult: route, traceId: 'trace-schema', timing: 100 });
    const manifest = JSON.parse(fs.readFileSync(path.join(out.runDir, 'manifest.json'), 'utf8')) as Record<string, unknown>;
    expect(manifest['schema_version']).toBe('1.1.0');
  });
});
