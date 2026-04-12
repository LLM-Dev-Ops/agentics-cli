/**
 * ADR-PIPELINE-076 tests: wire-complete server scaffold.
 *
 * Two layers:
 *   1. Static contract on BASE_APP_SCAFFOLD_HONO + BASE_APP_SCAFFOLD_EXPRESS
 *   2. Runtime: compile the Hono base app + its logger + middleware deps
 *      via ts.transpileModule, dynamic-import the resulting .mjs, build a
 *      Hono instance with two readiness checks, and fetch /health/live,
 *      /health/ready (ok + failing), /metrics.
 *
 * Also verifies:
 *   - OWNED_SCAFFOLD_MODULES gains src/api/base-app.ts
 *   - middleware entry now lists metricsHandlerExpress
 *   - Hono is importable (already a pipeline dep)
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import * as ts from 'typescript';

import {
  BASE_APP_SCAFFOLD_HONO,
  BASE_APP_SCAFFOLD_EXPRESS,
  LOGGER_SCAFFOLD,
  OWNED_SCAFFOLD_MODULES,
} from '../../../../src/pipeline/auto-chain.js';

// ============================================================================
// Helpers
// ============================================================================

function mkTempDir(label: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `adr076-${label}-`));
}

// Resolve hono's ESM entry point so the transpiled base-app.mjs can
// import it from an isolated temp directory (where plain `from 'hono'`
// wouldn't resolve without a node_modules walk).
const HONO_ESM_URL = pathToFileURL(
  path.resolve(process.cwd(), 'node_modules/hono/dist/index.js'),
).href;

function transpileToMjs(source: string, outPath: string, tsName: string): void {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      esModuleInterop: true,
      strict: false,
      skipLibCheck: true,
    },
    fileName: tsName,
    reportDiagnostics: false,
  });
  // Rewrite relative imports so the emitted .mjs files link to their
  // siblings by absolute .mjs path instead of the original `.js` spec.
  let out = compiled.outputText;
  out = out.replace(/from\s+['"]\.\.\/logger\.js['"]/g, `from '${pathToFileURL(path.join(path.dirname(outPath), '..', 'logger.mjs')).href}'`);
  out = out.replace(/from\s+['"]\.\.\/middleware\.js['"]/g, `from '${pathToFileURL(path.join(path.dirname(outPath), '..', 'middleware.mjs')).href}'`);
  out = out.replace(/from\s+['"]\.\/logger\.js['"]/g, `from '${pathToFileURL(path.join(path.dirname(outPath), 'logger.mjs')).href}'`);
  // Hono isn't resolvable from an isolated temp dir — rewrite to an
  // absolute file URL pointing at the pipeline's own node_modules.
  out = out.replace(/from\s+['"]hono['"]/g, `from '${HONO_ESM_URL}'`);
  fs.writeFileSync(outPath, out, 'utf-8');
}

/**
 * Minimal hand-rolled middleware.ts replacement that exposes the pure
 * `metricsHandler()`, `incrementCounter`, and `recordHistogram` functions
 * the base-app scaffold imports. Using a minimal inline version avoids
 * having to transpile the full middleware scaffold and all its deps.
 */
const MINIMAL_MIDDLEWARE_MJS = `
const counters = {};
const histograms = {};
export function incrementCounter(name, labels = {}) {
  const key = name + JSON.stringify(labels);
  counters[key] = (counters[key] ?? 0) + 1;
}
export function recordHistogram(name, value, labels = {}) {
  const key = name + JSON.stringify(labels);
  if (!histograms[key]) histograms[key] = [];
  histograms[key].push(value);
}
export function metricsHandler() {
  const lines = [];
  for (const [key, val] of Object.entries(counters)) {
    lines.push('# TYPE ' + key.split('{')[0] + ' counter');
    lines.push(key + ' ' + val);
  }
  for (const [key, vals] of Object.entries(histograms)) {
    const sum = vals.reduce((a, b) => a + b, 0);
    lines.push('# TYPE ' + key.split('{')[0] + ' histogram');
    lines.push(key + '_sum ' + sum);
    lines.push(key + '_count ' + vals.length);
  }
  return lines.join('\\n');
}
`;

interface BaseAppExports {
  createBaseApp: (deps: {
    serviceName: string;
    version: string;
    readiness: ReadonlyArray<{
      name: string;
      check: () => Promise<{ ok: boolean; detail?: string }>;
    }>;
  }) => { fetch: (req: Request) => Promise<Response> };
}

async function loadBaseApp(dir: string): Promise<BaseAppExports> {
  const srcDir = path.join(dir, 'src');
  const apiDir = path.join(srcDir, 'api');
  fs.mkdirSync(apiDir, { recursive: true });
  // 1. Logger (real AsyncLocalStorage scaffold)
  transpileToMjs(LOGGER_SCAFFOLD, path.join(srcDir, 'logger.mjs'), 'logger.ts');
  // 2. Middleware — minimal hand-rolled version so the test doesn't need
  //    the full middleware scaffold transpile pipeline.
  fs.writeFileSync(path.join(srcDir, 'middleware.mjs'), MINIMAL_MIDDLEWARE_MJS, 'utf-8');
  // 3. Base app — transpile the real scaffold and rewrite its imports
  transpileToMjs(BASE_APP_SCAFFOLD_HONO, path.join(apiDir, 'base-app.mjs'), 'base-app.ts');

  const url = pathToFileURL(path.join(apiDir, 'base-app.mjs')).href + `?t=${Date.now()}-${Math.random()}`;
  return (await import(url)) as BaseAppExports;
}

// ============================================================================
// Static contract — Hono variant
// ============================================================================

describe('ADR-076 — BASE_APP_SCAFFOLD_HONO static contract', () => {
  it('exports createBaseApp + public types', () => {
    expect(BASE_APP_SCAFFOLD_HONO).toContain('export function createBaseApp');
    expect(BASE_APP_SCAFFOLD_HONO).toContain('export interface BaseAppDeps');
    expect(BASE_APP_SCAFFOLD_HONO).toContain('export interface BaseAppContextVariables');
    expect(BASE_APP_SCAFFOLD_HONO).toContain('export interface HealthCheck');
  });

  it('uses typed Hono<{ Variables: BaseAppContextVariables }>', () => {
    expect(BASE_APP_SCAFFOLD_HONO).toContain('Hono<{ Variables: BaseAppContextVariables }>');
    expect(BASE_APP_SCAFFOLD_HONO).toContain('new Hono<{ Variables: BaseAppContextVariables }>');
  });

  it('wires correlation middleware via runWithCorrelation', () => {
    expect(BASE_APP_SCAFFOLD_HONO).toContain('runWithCorrelation');
    expect(BASE_APP_SCAFFOLD_HONO).toContain("from '../logger.js'");
  });

  it('defines /health/live, /health/ready, /metrics routes', () => {
    expect(BASE_APP_SCAFFOLD_HONO).toContain("'/health/live'");
    expect(BASE_APP_SCAFFOLD_HONO).toContain("'/health/ready'");
    expect(BASE_APP_SCAFFOLD_HONO).toContain("'/metrics'");
  });

  it('imports metricsHandler from middleware', () => {
    expect(BASE_APP_SCAFFOLD_HONO).toContain('metricsHandler');
    expect(BASE_APP_SCAFFOLD_HONO).toContain("from '../middleware.js'");
  });

  it('emits Prometheus content-type on /metrics', () => {
    expect(BASE_APP_SCAFFOLD_HONO).toContain("text/plain; version=0.0.4");
  });

  it('registers an error handler via onError', () => {
    expect(BASE_APP_SCAFFOLD_HONO).toContain('app.onError');
  });
});

// ============================================================================
// Static contract — Express variant
// ============================================================================

describe('ADR-076 — BASE_APP_SCAFFOLD_EXPRESS static contract', () => {
  it('exports createBaseApp with Express type', () => {
    expect(BASE_APP_SCAFFOLD_EXPRESS).toContain('export function createBaseApp');
    expect(BASE_APP_SCAFFOLD_EXPRESS).toContain('express.Express');
  });

  it('wires correlation middleware', () => {
    expect(BASE_APP_SCAFFOLD_EXPRESS).toContain('runWithCorrelation(id, next)');
  });

  it('defines /health/live, /health/ready, /metrics routes', () => {
    expect(BASE_APP_SCAFFOLD_EXPRESS).toContain("'/health/live'");
    expect(BASE_APP_SCAFFOLD_EXPRESS).toContain("'/health/ready'");
    expect(BASE_APP_SCAFFOLD_EXPRESS).toContain("'/metrics'");
  });

  it('uses metricsHandlerExpress wrapper', () => {
    expect(BASE_APP_SCAFFOLD_EXPRESS).toContain('metricsHandlerExpress');
  });
});

// ============================================================================
// OWNED_SCAFFOLD_MODULES
// ============================================================================

describe('ADR-076 — OWNED_SCAFFOLD_MODULES entries', () => {
  it('lists src/api/base-app.ts with createBaseApp + type exports', () => {
    const entry = OWNED_SCAFFOLD_MODULES.find(m => m.path === 'src/api/base-app.ts');
    expect(entry).toBeDefined();
    expect(entry!.exports).toContain('createBaseApp');
    expect(entry!.exports).toContain('BaseAppDeps');
    expect(entry!.exports).toContain('BaseAppContextVariables');
    expect(entry!.exports).toContain('HealthCheck');
  });

  it('middleware entry lists metricsHandlerExpress alongside metricsHandler', () => {
    const entry = OWNED_SCAFFOLD_MODULES.find(m => m.path === 'src/middleware.ts');
    expect(entry?.exports).toContain('metricsHandler');
    expect(entry?.exports).toContain('metricsHandlerExpress');
  });
});

// ============================================================================
// Runtime — boot a Hono base app and fetch each route
// ============================================================================

describe('ADR-076 — Hono base app runtime', () => {
  it('/health/live returns 200 ok', async () => {
    const dir = mkTempDir('runtime-live');
    try {
      const mod = await loadBaseApp(dir);
      const app = mod.createBaseApp({
        serviceName: 'test-service',
        version: '0.0.1',
        readiness: [{ name: 'process', check: async () => ({ ok: true }) }],
      });
      const res = await app.fetch(new Request('http://localhost/health/live'));
      expect(res.status).toBe(200);
      const body = await res.json() as { status: string; service: string; version: string };
      expect(body.status).toBe('ok');
      expect(body.service).toBe('test-service');
      expect(body.version).toBe('0.0.1');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('/health/ready returns 200 when all checks pass', async () => {
    const dir = mkTempDir('runtime-ready-ok');
    try {
      const mod = await loadBaseApp(dir);
      const app = mod.createBaseApp({
        serviceName: 'test-service',
        version: '0.0.1',
        readiness: [
          { name: 'db', check: async () => ({ ok: true }) },
          { name: 'erp', check: async () => ({ ok: true }) },
        ],
      });
      const res = await app.fetch(new Request('http://localhost/health/ready'));
      expect(res.status).toBe(200);
      const body = await res.json() as { status: string; checks: Array<{ name: string; ok: boolean }> };
      expect(body.status).toBe('ready');
      expect(body.checks).toHaveLength(2);
      expect(body.checks.every(c => c.ok)).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('/health/ready returns 503 when a check fails', async () => {
    const dir = mkTempDir('runtime-ready-fail');
    try {
      const mod = await loadBaseApp(dir);
      const app = mod.createBaseApp({
        serviceName: 'test-service',
        version: '0.0.1',
        readiness: [
          { name: 'db', check: async () => ({ ok: true }) },
          { name: 'erp', check: async () => ({ ok: false, detail: 'circuit open' }) },
        ],
      });
      const res = await app.fetch(new Request('http://localhost/health/ready'));
      expect(res.status).toBe(503);
      const body = await res.json() as { status: string; checks: Array<{ name: string; ok: boolean; detail?: string }> };
      expect(body.status).toBe('not-ready');
      const erp = body.checks.find(c => c.name === 'erp');
      expect(erp?.ok).toBe(false);
      expect(erp?.detail).toBe('circuit open');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('/health/ready catches thrown errors and reports them as failures', async () => {
    const dir = mkTempDir('runtime-ready-throw');
    try {
      const mod = await loadBaseApp(dir);
      const app = mod.createBaseApp({
        serviceName: 'test-service',
        version: '0.0.1',
        readiness: [
          { name: 'ramco', check: async () => { throw new Error('connection refused'); } },
        ],
      });
      const res = await app.fetch(new Request('http://localhost/health/ready'));
      expect(res.status).toBe(503);
      const body = await res.json() as { checks: Array<{ name: string; ok: boolean; detail?: string }> };
      expect(body.checks[0]!.ok).toBe(false);
      expect(body.checks[0]!.detail).toContain('connection refused');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('/metrics returns Prometheus text after a request', async () => {
    const dir = mkTempDir('runtime-metrics');
    try {
      const mod = await loadBaseApp(dir);
      const app = mod.createBaseApp({
        serviceName: 'test-service',
        version: '0.0.1',
        readiness: [{ name: 'process', check: async () => ({ ok: true }) }],
      });
      // Fire a request first so the request-logging middleware records
      // counters + histograms.
      await app.fetch(new Request('http://localhost/health/live'));
      const res = await app.fetch(new Request('http://localhost/metrics'));
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/plain');
      const text = await res.text();
      expect(text).toMatch(/http_requests_total/);
      expect(text).toMatch(/http_request_duration_ms/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('correlation ID header is emitted on every response', async () => {
    const dir = mkTempDir('runtime-corr');
    try {
      const mod = await loadBaseApp(dir);
      const app = mod.createBaseApp({
        serviceName: 'test-service',
        version: '0.0.1',
        readiness: [{ name: 'process', check: async () => ({ ok: true }) }],
      });
      const res = await app.fetch(new Request('http://localhost/health/live'));
      expect(res.headers.get('x-correlation-id')).toBeTruthy();
      expect(res.headers.get('x-correlation-id')!.length).toBeGreaterThanOrEqual(8);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
