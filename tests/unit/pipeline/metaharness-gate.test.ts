/**
 * MetaHarness Quality & Security Gate — ADR-PIPELINE-118 (Phase 5.5)
 *
 * London-school unit tests for the gate's branch matrix, exercised WITHOUT
 * spawning real metaharness/npx. node:child_process is mocked so the PATH probe
 * is fully under test control (no real `which`/`npx`/`metaharness` download), and
 * the deterministic branches are used:
 *   - mode=off  → short-circuits before any resolution
 *   - tier=mcp  → defers to the host MCP tools (no subprocess)
 *   - tier=none → advisory proceeds; block emits a loud-failure artifact
 * The resolver cache is reset between cases and process.env is restored in
 * afterEach.
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// The gate resolves MetaHarness via the fs-based resolver (no subprocess). The
// tested branches (off / mcp / none) all short-circuit BEFORE any assessment is
// spawned, so no real metaharness/npx is ever run. `tier:none` is forced with an
// empty PATH; `tier:mcp` via the env signal.
const { runMetaHarnessGate, resolveGateMode } = await import('../../../src/pipeline/metaharness-gate.js');
const { __resetMetaHarnessResolutionCache } = await import('../../../src/pipeline/metaharness-resolver.js');

const ENV_KEYS = [
  'AGENTICS_METAHARNESS_GATE',
  'AGENTICS_METAHARNESS_MCP',
  'AGENTICS_METAHARNESS_BIN',
  'AGENTICS_METAHARNESS_MIN_SCORE',
  'PATH',
] as const;

describe('ADR-118 — resolveGateMode', () => {
  let savedGate: string | undefined;

  beforeEach(() => { savedGate = process.env['AGENTICS_METAHARNESS_GATE']; });
  afterEach(() => {
    if (savedGate === undefined) delete process.env['AGENTICS_METAHARNESS_GATE'];
    else process.env['AGENTICS_METAHARNESS_GATE'] = savedGate;
  });

  it('maps "off" → off', () => {
    process.env['AGENTICS_METAHARNESS_GATE'] = 'off';
    expect(resolveGateMode()).toBe('off');
  });

  it('maps "block" → block', () => {
    process.env['AGENTICS_METAHARNESS_GATE'] = 'block';
    expect(resolveGateMode()).toBe('block');
  });

  it('maps "advisory" → advisory', () => {
    process.env['AGENTICS_METAHARNESS_GATE'] = 'advisory';
    expect(resolveGateMode()).toBe('advisory');
  });

  it('defaults to advisory when unset', () => {
    delete process.env['AGENTICS_METAHARNESS_GATE'];
    expect(resolveGateMode()).toBe('advisory');
  });

  it('is case/whitespace-insensitive and defaults unknown values to advisory', () => {
    process.env['AGENTICS_METAHARNESS_GATE'] = 'BLOCK '; // trimmed + lowered → block
    expect(resolveGateMode()).toBe('block');
    process.env['AGENTICS_METAHARNESS_GATE'] = 'nonsense';
    expect(resolveGateMode()).toBe('advisory');
  });
});

describe('ADR-118 — runMetaHarnessGate branch matrix', () => {
  let saved: Record<string, string | undefined>;
  let tmpRoot: string;
  let runDir: string;
  const projectDir = '/nonexistent/project'; // never read on the tested branches

  beforeEach(() => {
    saved = {};
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    delete process.env['AGENTICS_METAHARNESS_MCP'];
    delete process.env['AGENTICS_METAHARNESS_BIN'];
    delete process.env['AGENTICS_METAHARNESS_MIN_SCORE'];
    process.env['PATH'] = ''; // resolver → tier:none unless MCP env set
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-gate-'));
    runDir = path.join(tmpRoot, 'run');
    fs.mkdirSync(runDir, { recursive: true });
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

  // ---- mode=off ------------------------------------------------------------

  it('mode=off short-circuits: ran:false, proceed:true, no resolution needed', async () => {
    process.env['AGENTICS_METAHARNESS_GATE'] = 'off';

    const r = await runMetaHarnessGate(runDir, projectDir);

    expect(r.ran).toBe(false);
    expect(r.proceed).toBe(true);
    expect(r.mode).toBe('off');
    expect(r.tier).toBe('none');
    expect(r.reason).toMatch(/disabled/);
  });

  // ---- tier=mcp ------------------------------------------------------------

  it('tier=mcp + advisory → proceed:true, deferred to host MCP tools (no subprocess)', async () => {
    process.env['AGENTICS_METAHARNESS_MCP'] = '1';
    process.env['AGENTICS_METAHARNESS_GATE'] = 'advisory';

    const r = await runMetaHarnessGate(runDir, projectDir);

    expect(r.tier).toBe('mcp');
    expect(r.ran).toBe(false);
    expect(r.proceed).toBe(true);
    expect(r.reason).toMatch(/MCP/);
  });

  it('tier=mcp + block → proceed:false and emits the loud-failure artifact (cannot self-verify via the CLI)', async () => {
    process.env['AGENTICS_METAHARNESS_MCP'] = '1';
    process.env['AGENTICS_METAHARNESS_GATE'] = 'block';

    const r = await runMetaHarnessGate(runDir, projectDir);

    expect(r.tier).toBe('mcp');
    expect(r.ran).toBe(false);
    expect(r.proceed).toBe(false);
    expect(r.failureArtifact).toBe('metaharness/METAHARNESS-FAIL-001.md');
    expect(fs.existsSync(path.join(runDir, 'metaharness', 'METAHARNESS-FAIL-001.md'))).toBe(true);
  });

  // ---- tier=none -----------------------------------------------------------

  it('tier=none + block → proceed:false and writes METAHARNESS-FAIL-001.md loud-failure artifact', async () => {
    process.env['AGENTICS_METAHARNESS_GATE'] = 'block'; // whichResults empty → tier none

    const r = await runMetaHarnessGate(runDir, projectDir);

    expect(r.tier).toBe('none');
    expect(r.ran).toBe(false);
    expect(r.proceed).toBe(false);
    expect(r.failureArtifact).toBe('metaharness/METAHARNESS-FAIL-001.md');
    expect(r.artifacts).toContain('metaharness/METAHARNESS-FAIL-001.md');
    const failPath = path.join(runDir, 'metaharness', 'METAHARNESS-FAIL-001.md');
    expect(fs.existsSync(failPath)).toBe(true);
    expect(fs.readFileSync(failPath, 'utf-8')).toMatch(/METAHARNESS-FAIL-001/);
  });

  it('tier=none + advisory → proceed:true and writes NO loud-failure artifact', async () => {
    process.env['AGENTICS_METAHARNESS_GATE'] = 'advisory';

    const r = await runMetaHarnessGate(runDir, projectDir);

    expect(r.tier).toBe('none');
    expect(r.ran).toBe(false);
    expect(r.proceed).toBe(true);
    expect(r.failureArtifact).toBeUndefined();
    expect(fs.existsSync(path.join(runDir, 'metaharness', 'METAHARNESS-FAIL-001.md'))).toBe(false);
  });
});
