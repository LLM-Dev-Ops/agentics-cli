/**
 * MetaHarness Resolver — ADR-PIPELINE-117 (D1)
 *
 * London-school / outside-in unit tests for `resolveMetaHarness`,
 * `metaHarnessArgv`, and the test-only cache reset.
 *
 * The resolver locates binaries via a pure filesystem PATH scan (no subprocess —
 * ADR-117 §D5 keeps it spawn-free and sub-millisecond, matching `resolveBackend`).
 * Because the lookup reads `process.env.PATH` and `fs.statSync` IN-PROCESS, the
 * hermetic seam is a controlled `PATH` pointing at temp "bin" directories — no
 * real `metaharness`/`npx` is ever consulted and no network is touched.
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const {
  resolveMetaHarness,
  metaHarnessArgv,
  __resetMetaHarnessResolutionCache,
} = await import('../../../src/pipeline/metaharness-resolver.js');
type MetaHarnessResolution = Awaited<ReturnType<typeof resolveMetaHarness>>;

const ENV_KEYS = ['AGENTICS_METAHARNESS_MCP', 'AGENTICS_METAHARNESS_BIN', 'PATH'] as const;

/** Create a real (empty) "executable" file the resolver's `isFile` probe accepts. */
function mkBin(dir: string, name: string): string {
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, name);
  fs.writeFileSync(p, '#!/bin/sh\n', 'utf-8');
  return p;
}

describe('ADR-117 — resolveMetaHarness', () => {
  let saved: Record<string, string | undefined>;
  let tmpRoot: string;
  let binDir: string;

  beforeEach(() => {
    saved = {};
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    delete process.env['AGENTICS_METAHARNESS_MCP'];
    delete process.env['AGENTICS_METAHARNESS_BIN'];
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-resolver-'));
    binDir = path.join(tmpRoot, 'bin');
    fs.mkdirSync(binDir, { recursive: true });
    // Controlled, empty PATH by default → the "none" baseline. Tests opt-in by
    // placing binaries in binDir and pointing PATH at it.
    process.env['PATH'] = '';
    __resetMetaHarnessResolutionCache();
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    __resetMetaHarnessResolutionCache();
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* noop */ }
  });

  // ---- Tier selection order ------------------------------------------------

  it('selects the mcp tier when AGENTICS_METAHARNESS_MCP is set (highest priority)', async () => {
    process.env['AGENTICS_METAHARNESS_MCP'] = '1';
    // A valid BIN override and on-PATH binaries must NOT win over MCP.
    process.env['AGENTICS_METAHARNESS_BIN'] = mkBin(binDir, 'metaharness');
    mkBin(binDir, 'npx');
    process.env['PATH'] = binDir;

    const r = await resolveMetaHarness();

    expect(r.tier).toBe('mcp');
    expect(r.command).toBeNull();
    expect(r.argvPrefix).toEqual([]);
    expect(r.reason).toMatch(/AGENTICS_METAHARNESS_MCP/);
  });

  it('selects the cli tier pointing at AGENTICS_METAHARNESS_BIN when it is a real file', async () => {
    const bin = mkBin(binDir, 'metaharness-bin');
    process.env['AGENTICS_METAHARNESS_BIN'] = bin;
    // A PATH metaharness must NOT be consulted once the override resolves.
    mkBin(binDir, 'metaharness');
    process.env['PATH'] = binDir;

    const r = await resolveMetaHarness();

    expect(r.tier).toBe('cli');
    expect(r.command).toBe(bin);
    expect(r.argvPrefix).toEqual([]);
    expect(r.reason).toContain(bin);
  });

  it('ignores an AGENTICS_METAHARNESS_BIN that does not point at a real file and falls through', async () => {
    process.env['AGENTICS_METAHARNESS_BIN'] = path.join(tmpRoot, 'does-not-exist');
    const onPath = mkBin(binDir, 'metaharness'); // PATH lookup then succeeds
    process.env['PATH'] = binDir;

    const r = await resolveMetaHarness();

    expect(r.tier).toBe('cli');
    expect(r.command).toBe(onPath);
    expect(r.argvPrefix).toEqual([]);
  });

  it('selects the cli tier from an on-PATH metaharness binary (before npx)', async () => {
    const mh = mkBin(binDir, 'metaharness');
    mkBin(binDir, 'npx');
    process.env['PATH'] = binDir;

    const r = await resolveMetaHarness();

    expect(r.tier).toBe('cli');
    expect(r.command).toBe(mh);
    expect(r.argvPrefix).toEqual([]);
    expect(r.reason).toMatch(/on PATH/);
  });

  it('falls back to the cli tier via npx when metaharness is not on PATH but npx is', async () => {
    const npx = mkBin(binDir, 'npx'); // no metaharness present
    process.env['PATH'] = binDir;

    const r = await resolveMetaHarness();

    expect(r.tier).toBe('cli');
    expect(r.command).toBe(npx);
    expect(r.argvPrefix).toEqual(['--yes', 'metaharness']);
    expect(r.reason).toMatch(/npx/);
  });

  it('resolves to the none tier when nothing is available (no MCP, no bin, empty PATH)', async () => {
    process.env['PATH'] = ''; // neither metaharness nor npx resolvable

    const r = await resolveMetaHarness();

    expect(r.tier).toBe('none');
    expect(r.command).toBeNull();
    expect(r.argvPrefix).toEqual([]);
    expect(r.reason).toMatch(/MetaHarness unavailable/);
  });

  // ---- Memoisation ---------------------------------------------------------

  it('memoises the decision: a second call returns the identical cached object', async () => {
    process.env['AGENTICS_METAHARNESS_MCP'] = '1';

    const first = await resolveMetaHarness();
    const second = await resolveMetaHarness();

    expect(second).toBe(first); // same reference — no re-resolution
  });

  it('does NOT re-resolve when the environment changes but the cache is warm', async () => {
    process.env['AGENTICS_METAHARNESS_MCP'] = '1';
    const first = await resolveMetaHarness();
    expect(first.tier).toBe('mcp');

    delete process.env['AGENTICS_METAHARNESS_MCP'];
    process.env['PATH'] = ''; // would resolve to none if it re-ran
    const second = await resolveMetaHarness();

    expect(second).toBe(first);
    expect(second.tier).toBe('mcp');
  });

  it('__resetMetaHarnessResolutionCache clears the memo so the next call re-resolves', async () => {
    process.env['AGENTICS_METAHARNESS_MCP'] = '1';
    const first = await resolveMetaHarness();
    expect(first.tier).toBe('mcp');

    __resetMetaHarnessResolutionCache();
    delete process.env['AGENTICS_METAHARNESS_MCP'];
    process.env['PATH'] = ''; // fresh resolution now yields none

    const second = await resolveMetaHarness();

    expect(second).not.toBe(first);
    expect(second.tier).toBe('none');
  });
});

// ---- metaHarnessArgv (pure) -----------------------------------------------

describe('ADR-117 — metaHarnessArgv', () => {
  it('returns null for the mcp tier', () => {
    const res: MetaHarnessResolution = { tier: 'mcp', command: null, argvPrefix: [], reason: 'x' };
    expect(metaHarnessArgv(res, ['score'])).toBeNull();
  });

  it('returns null for the none tier', () => {
    const res: MetaHarnessResolution = { tier: 'none', command: null, argvPrefix: [], reason: 'x' };
    expect(metaHarnessArgv(res, ['score', '.'])).toBeNull();
  });

  it('returns null for a cli tier with a null command (defensive)', () => {
    const res: MetaHarnessResolution = { tier: 'cli', command: null, argvPrefix: [], reason: 'x' };
    expect(metaHarnessArgv(res, ['score'])).toBeNull();
  });

  it('builds {command,args} for a direct-binary cli tier (empty prefix)', () => {
    const res: MetaHarnessResolution = { tier: 'cli', command: '/usr/local/bin/metaharness', argvPrefix: [], reason: 'x' };
    expect(metaHarnessArgv(res, ['score', './proj', '--json'])).toEqual({
      command: '/usr/local/bin/metaharness',
      args: ['score', './proj', '--json'],
    });
  });

  it('prepends the argvPrefix for an npx-backed cli tier', () => {
    const res: MetaHarnessResolution = { tier: 'cli', command: '/usr/bin/npx', argvPrefix: ['--yes', 'metaharness'], reason: 'x' };
    expect(metaHarnessArgv(res, ['mcp-scan', './proj'])).toEqual({
      command: '/usr/bin/npx',
      args: ['--yes', 'metaharness', 'mcp-scan', './proj'],
    });
  });
});
