/**
 * ADR-PIPELINE-081 — validate-adapter-bundle.ts unit tests.
 *
 * Spawns the validator as a subprocess against synthetic adapter repos laid
 * out in tmpdir. Exercises the six documented rules (§6.1 of adapter-repo.md):
 *   - Required manifest fields
 *   - Handler inventory match (exposed ↔ files)
 *   - Exact-name exclusion
 *   - Pattern exclusion
 *   - Orphan handlers (warning, not error)
 *   - Non-adapter bundle.json (skipped cleanly)
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const VALIDATOR = join(process.cwd(), 'scripts', 'validate-adapter-bundle.ts');

interface AdapterFixture {
  manifest: Record<string, unknown>;
  handlers?: Record<string, string>;
}

function makeAdapter(fixture: AdapterFixture): string {
  const dir = mkdtempSync(join(tmpdir(), 'adapter-test-'));
  writeFileSync(join(dir, 'bundle.json'), JSON.stringify(fixture.manifest, null, 2));
  const handlersDir = join(dir, 'src', 'handlers');
  mkdirSync(handlersDir, { recursive: true });
  for (const [name, content] of Object.entries(fixture.handlers ?? {})) {
    writeFileSync(join(handlersDir, name), content);
  }
  return dir;
}

function runValidator(adapterPath: string): { code: number; stderr: string; stdout: string } {
  const result = spawnSync('npx', ['tsx', VALIDATOR, adapterPath], { encoding: 'utf-8' });
  return { code: result.status ?? -1, stderr: result.stderr, stdout: result.stdout };
}

describe('ADR-081: validate-adapter-bundle', () => {
  const createdDirs: string[] = [];

  beforeEach(() => { createdDirs.length = 0; });
  afterEach(() => {
    for (const dir of createdDirs) {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  function make(fixture: AdapterFixture): string {
    const dir = makeAdapter(fixture);
    createdDirs.push(dir);
    return dir;
  }

  const validManifest = {
    type: 'adapter',
    name: 'test-adapter-agents',
    agentics_domain: 'test-adapter',
    upstream: { product: 'test', mcp_command: 'echo mcp', version_pin: '1.0.0' },
    exposed_agents: ['example'],
    excluded_upstream_agents: [],
    excluded_patterns: [],
  };

  const validHandler = `
import { registerHandler } from '../index.js';
export const UPSTREAM_TOOL = 'SafeUpstreamTool';
registerHandler('example', async (body) => ({ status: 200, data: {}, execution_metadata: {} as any, timing: 0 }));
`;

  it('passes a well-formed adapter bundle', () => {
    const dir = make({ manifest: validManifest, handlers: { 'example.ts': validHandler } });
    const { code, stderr } = runValidator(dir);
    expect(code).toBe(0);
    expect(stderr).toContain('validation passed');
  });

  it('fails when bundle.json is missing required upstream.version_pin', () => {
    const dir = make({
      manifest: { ...validManifest, upstream: { product: 'test', mcp_command: 'echo mcp' } },
      handlers: { 'example.ts': validHandler },
    });
    const { code, stderr } = runValidator(dir);
    expect(code).toBe(1);
    expect(stderr).toContain('upstream.version_pin');
  });

  it('fails when version_pin is "latest" (forbidden)', () => {
    const dir = make({
      manifest: { ...validManifest, upstream: { product: 'test', mcp_command: 'echo mcp', version_pin: 'latest' } },
      handlers: { 'example.ts': validHandler },
    });
    const { code, stderr } = runValidator(dir);
    expect(code).toBe(1);
    expect(stderr).toMatch(/version_pin.*latest/);
  });

  it('fails when exposed agent has no matching handler file', () => {
    const dir = make({
      manifest: { ...validManifest, exposed_agents: ['example', 'missing-one'] },
      handlers: { 'example.ts': validHandler },
    });
    const { code, stderr } = runValidator(dir);
    expect(code).toBe(1);
    expect(stderr).toContain('missing-one');
  });

  it('fails when handler references an excluded upstream agent (exact match)', () => {
    const forbiddenHandler = `
import { registerHandler } from '../index.js';
export const UPSTREAM_TOOL = "Security-SAST";
registerHandler('example', async () => ({ status: 200, data: {}, execution_metadata: {} as any, timing: 0 }));
`;
    const dir = make({
      manifest: { ...validManifest, excluded_upstream_agents: ['Security-SAST'] },
      handlers: { 'example.ts': forbiddenHandler },
    });
    const { code, stderr } = runValidator(dir);
    expect(code).toBe(1);
    expect(stderr).toContain('Security-SAST');
  });

  it('fails when handler\'s upstreamTool matches an excluded pattern', () => {
    const forbiddenHandler = `
import { registerHandler } from '../index.js';
export const UPSTREAM_TOOL = "SAP-Integration-Tester";
registerHandler('example', async () => ({ status: 200, data: {}, execution_metadata: {} as any, timing: 0 }));
`;
    const dir = make({
      manifest: { ...validManifest, excluded_patterns: ['^(SAP-|SOAP-)'] },
      handlers: { 'example.ts': forbiddenHandler },
    });
    const { code, stderr } = runValidator(dir);
    expect(code).toBe(1);
    expect(stderr).toMatch(/excluded pattern/);
  });

  it('warns (but does not fail) on orphan handler', () => {
    const dir = make({
      manifest: { ...validManifest, exposed_agents: [] },
      handlers: { 'orphan.ts': validHandler },
    });
    const { code, stderr } = runValidator(dir);
    expect(code).toBe(0);
    expect(stderr).toMatch(/orphan-handler/);
  });

  it('skips non-adapter bundles cleanly (exit 0)', () => {
    const dir = make({
      manifest: { type: 'domain', name: 'some-other-thing' },
    });
    const { code, stderr } = runValidator(dir);
    expect(code).toBe(0);
    expect(stderr).toContain('Skipping');
  });

  it('fails with exit 2 when bundle.json is missing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'adapter-test-empty-'));
    createdDirs.push(dir);
    const { code, stderr } = runValidator(dir);
    expect(code).toBe(2);
    expect(stderr).toContain('bundle.json not found');
  });
});
