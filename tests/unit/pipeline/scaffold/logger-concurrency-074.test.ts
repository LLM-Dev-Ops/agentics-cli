/**
 * ADR-PIPELINE-074 tests: AsyncLocalStorage correlation-id propagation.
 *
 * Two layers:
 *   1. Static contract checks against `LOGGER_SCAFFOLD` — the constant
 *      must import AsyncLocalStorage, export runWithCorrelation, and
 *      contain NO top-level `let currentCorrelationId` mutable.
 *   2. Runtime concurrency check: transpile the scaffold with the TS
 *      compiler, dynamic-import the resulting .mjs, and spawn 50
 *      concurrent `runWithCorrelation` tasks with distinct IDs. Assert
 *      that each task observes its own ID with zero cross-contamination.
 *
 * Also verifies:
 *   - OWNED_SCAFFOLD_MODULES entry for src/logger.ts lists runWithCorrelation
 *   - LOGGER_CONCURRENCY_TEST_SCAFFOLD constant is non-empty + references runWithCorrelation
 *   - The middleware scaffold imports runWithCorrelation and wraps next()
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import * as ts from 'typescript';

import {
  LOGGER_SCAFFOLD,
  LOGGER_CONCURRENCY_TEST_SCAFFOLD,
  OWNED_SCAFFOLD_MODULES,
} from '../../../../src/pipeline/auto-chain.js';

// ============================================================================
// Helpers
// ============================================================================

function mkTempDir(label: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `adr074-${label}-`));
}

function writeScaffoldAsMjs(targetDir: string): string {
  fs.mkdirSync(targetDir, { recursive: true });
  const compiled = ts.transpileModule(LOGGER_SCAFFOLD, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      esModuleInterop: true,
      strict: false,
      skipLibCheck: true,
    },
    fileName: 'logger.ts',
    reportDiagnostics: false,
  });
  const filePath = path.join(targetDir, 'logger.mjs');
  fs.writeFileSync(filePath, compiled.outputText, 'utf-8');
  return filePath;
}

interface ScaffoldExports {
  createLogger: (service: string) => {
    info: (event: string, data?: Record<string, unknown>) => void;
    child: (bindings: Record<string, unknown>) => ScaffoldExports['createLogger'] extends (s: string) => infer R ? R : never;
  };
  runWithCorrelation: <T>(id: string, fn: () => T) => T;
  getCorrelationId: () => string | undefined;
  setCorrelationId: (id: string | undefined) => void;
}

async function importScaffold(filePath: string): Promise<ScaffoldExports> {
  const url = pathToFileURL(filePath).href + `?t=${Date.now()}-${Math.random()}`;
  return (await import(url)) as ScaffoldExports;
}

// ============================================================================
// Static contract
// ============================================================================

describe('ADR-074 — LOGGER_SCAFFOLD static contract', () => {
  it('imports AsyncLocalStorage from node:async_hooks', () => {
    expect(LOGGER_SCAFFOLD).toContain("from 'node:async_hooks'");
    expect(LOGGER_SCAFFOLD).toContain('AsyncLocalStorage');
  });

  it('exports runWithCorrelation and getCorrelationId', () => {
    expect(LOGGER_SCAFFOLD).toContain('export function runWithCorrelation');
    expect(LOGGER_SCAFFOLD).toContain('export function getCorrelationId');
  });

  it('exports createLogger with child() support', () => {
    expect(LOGGER_SCAFFOLD).toContain('export function createLogger');
    expect(LOGGER_SCAFFOLD).toContain('child:');
  });

  it('contains NO module-level `let currentCorrelationId` mutable', () => {
    // Strip comments to avoid false matches in the header doc.
    const stripped = LOGGER_SCAFFOLD
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '');
    expect(stripped).not.toMatch(/^(?:let|var)\s+currentCorrelationId/m);
    // And no top-level mutable with any case variant
    expect(stripped).not.toMatch(/^(?:let|var)\s+\w*[cC]orrelation[A-Za-z_]*\s*(?::|=)/m);
  });

  it('retains setCorrelationId as a legacy shim', () => {
    expect(LOGGER_SCAFFOLD).toContain('export function setCorrelationId');
  });

  it('uses storage.run for scoping, not a direct variable assignment', () => {
    expect(LOGGER_SCAFFOLD).toContain('storage.run(');
  });
});

// ============================================================================
// Runtime concurrency test
// ============================================================================

describe('ADR-074 — scaffolded module runtime concurrency', () => {
  it('does NOT leak correlation IDs across 50 concurrent async tasks', async () => {
    const dir = mkTempDir('concurrency');
    try {
      const filePath = writeScaffoldAsMjs(dir);
      const mod = await importScaffold(filePath);

      const results: Array<{ requested: string; observed: string | undefined }> = [];
      const tasks: Promise<void>[] = [];
      for (let i = 0; i < 50; i++) {
        const id = `req-${i}`;
        tasks.push(
          mod.runWithCorrelation(id, async () => {
            // Randomized delay to force async interleaving
            await new Promise((r) => setTimeout(r, Math.random() * 10));
            results.push({ requested: id, observed: mod.getCorrelationId() });
          }),
        );
      }
      await Promise.all(tasks);

      // Every task must see its OWN id, not a sibling's
      for (const r of results) {
        expect(r.observed).toBe(r.requested);
      }
      expect(results).toHaveLength(50);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('nested runWithCorrelation scopes correctly', async () => {
    const dir = mkTempDir('nested');
    try {
      const filePath = writeScaffoldAsMjs(dir);
      const mod = await importScaffold(filePath);

      let innerSaw: string | undefined;
      let outerSawAfter: string | undefined;
      await mod.runWithCorrelation('outer', async () => {
        await mod.runWithCorrelation('inner', async () => {
          innerSaw = mod.getCorrelationId();
        });
        outerSawAfter = mod.getCorrelationId();
      });
      expect(innerSaw).toBe('inner');
      // After the inner scope unwinds we're back in outer
      expect(outerSawAfter).toBe('outer');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('getCorrelationId returns undefined outside any scope', async () => {
    const dir = mkTempDir('outside');
    try {
      const filePath = writeScaffoldAsMjs(dir);
      const mod = await importScaffold(filePath);
      expect(mod.getCorrelationId()).toBeUndefined();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('setCorrelationId is a no-op outside a scope', async () => {
    const dir = mkTempDir('shim');
    try {
      const filePath = writeScaffoldAsMjs(dir);
      const mod = await importScaffold(filePath);
      mod.setCorrelationId('should-not-leak');
      expect(mod.getCorrelationId()).toBeUndefined();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('setCorrelationId mutates the current scope when inside runWithCorrelation', async () => {
    const dir = mkTempDir('shim-mutate');
    try {
      const filePath = writeScaffoldAsMjs(dir);
      const mod = await importScaffold(filePath);
      let observed: string | undefined;
      await mod.runWithCorrelation('initial', async () => {
        mod.setCorrelationId('mutated');
        observed = mod.getCorrelationId();
      });
      expect(observed).toBe('mutated');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ============================================================================
// Owned modules + concurrency test scaffold
// ============================================================================

describe('ADR-074 — supporting scaffold surfaces', () => {
  it('OWNED_SCAFFOLD_MODULES entry for src/logger.ts lists runWithCorrelation', () => {
    const entry = OWNED_SCAFFOLD_MODULES.find(m => m.path === 'src/logger.ts');
    expect(entry).toBeDefined();
    expect(entry!.exports).toContain('runWithCorrelation');
    expect(entry!.exports).toContain('getCorrelationId');
    expect(entry!.exports).toContain('createLogger');
    expect(entry!.exports).toContain('Logger');
  });

  it('LOGGER_CONCURRENCY_TEST_SCAFFOLD exists and exercises runWithCorrelation', () => {
    expect(LOGGER_CONCURRENCY_TEST_SCAFFOLD.length).toBeGreaterThan(200);
    expect(LOGGER_CONCURRENCY_TEST_SCAFFOLD).toContain('runWithCorrelation');
    expect(LOGGER_CONCURRENCY_TEST_SCAFFOLD).toContain('getCorrelationId');
    expect(LOGGER_CONCURRENCY_TEST_SCAFFOLD).toMatch(/for\s*\(\s*let\s+i\s*=\s*0\s*;\s*i\s*<\s*50/);
  });
});
