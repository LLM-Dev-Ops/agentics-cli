/**
 * ADR-PIPELINE-068 tests: ESM-safe simulation lineage scaffold.
 *
 * Two layers:
 *  1. Static checks against the SIMULATION_LINEAGE_SCAFFOLD constant
 *     emitted by auto-chain.ts. Verifies the file uses readFileSync /
 *     fileURLToPath, contains the expected exports, and has no
 *     CommonJS require( anywhere in its body.
 *  2. Runtime checks: write the scaffold to a temp directory, dynamic-
 *     import it as ESM, and exercise loadSimulationLineage / require
 *     SimulationLineage / formatLineageBanner across the env, manifest,
 *     and fallback paths.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import * as ts from 'typescript';

import { SIMULATION_LINEAGE_SCAFFOLD } from '../../../../src/pipeline/auto-chain.js';

// ============================================================================
// Helpers
// ============================================================================

function mkTempDir(label: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `adr068-${label}-`));
}

/**
 * Compile the scaffolded simulation-lineage.ts to .mjs using the TypeScript
 * compiler API and write it to a temp directory. Returns the absolute path.
 */
function writeScaffoldAsMjs(targetDir: string): string {
  fs.mkdirSync(targetDir, { recursive: true });
  const compiled = ts.transpileModule(SIMULATION_LINEAGE_SCAFFOLD, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      esModuleInterop: true,
      strict: false,
      skipLibCheck: true,
    },
    fileName: 'simulation-lineage.ts',
    reportDiagnostics: false,
  });
  const filePath = path.join(targetDir, 'simulation-lineage.mjs');
  fs.writeFileSync(filePath, compiled.outputText, 'utf-8');
  return filePath;
}

interface ScaffoldExports {
  loadSimulationLineage: () => {
    simulationId: string;
    traceId: string;
    runId: string;
    source: 'env' | 'manifest' | 'fallback';
    manifestPath?: string;
  };
  requireSimulationLineage: () => ReturnType<ScaffoldExports['loadSimulationLineage']>;
  formatLineageBanner: (lineage: { source: string; simulationId: string }) => string;
  loadSimulationId: () => string;
}

async function importScaffold(filePath: string): Promise<ScaffoldExports> {
  // Cache-bust by appending a unique query param so each test gets a fresh
  // module evaluation under Node's ESM loader.
  const url = pathToFileURL(filePath).href + `?t=${Date.now()}-${Math.random()}`;
  return (await import(url)) as ScaffoldExports;
}

// Suppress jest's automatic env injection during tests so process.env
// changes inside a test are local. We snapshot and restore.
function withEnv<T>(
  overrides: Record<string, string | undefined>,
  fn: () => T,
): T {
  const original: Record<string, string | undefined> = {};
  for (const key of Object.keys(overrides)) {
    original[key] = process.env[key];
    if (overrides[key] === undefined) delete process.env[key];
    else process.env[key] = overrides[key]!;
  }
  try {
    return fn();
  } finally {
    for (const key of Object.keys(overrides)) {
      if (original[key] === undefined) delete process.env[key];
      else process.env[key] = original[key]!;
    }
  }
}

// ============================================================================
// Static checks
// ============================================================================

describe('ADR-068 — SIMULATION_LINEAGE_SCAFFOLD static contract', () => {
  it('contains the ESM-safe imports', () => {
    expect(SIMULATION_LINEAGE_SCAFFOLD).toContain("from 'node:fs'");
    expect(SIMULATION_LINEAGE_SCAFFOLD).toContain('readFileSync');
    expect(SIMULATION_LINEAGE_SCAFFOLD).toContain('fileURLToPath');
    expect(SIMULATION_LINEAGE_SCAFFOLD).toContain("from 'node:url'");
  });

  it('contains NO CommonJS require( call in executable code', () => {
    // Strip line and block comments before scanning so the header prose
    // ("never use CommonJS require()") doesn't false-match.
    const stripped = SIMULATION_LINEAGE_SCAFFOLD
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '');
    // Word-bounded so requireSimulationLineage doesn't false-match.
    expect(stripped).not.toMatch(/(?:^|[^.\w$])require\s*\(/);
  });

  it('exports loadSimulationLineage and requireSimulationLineage', () => {
    expect(SIMULATION_LINEAGE_SCAFFOLD).toContain('export function loadSimulationLineage');
    expect(SIMULATION_LINEAGE_SCAFFOLD).toContain('export function requireSimulationLineage');
  });

  it('exports formatLineageBanner and the legacy loadSimulationId alias', () => {
    expect(SIMULATION_LINEAGE_SCAFFOLD).toContain('export function formatLineageBanner');
    expect(SIMULATION_LINEAGE_SCAFFOLD).toContain('export const loadSimulationId');
  });

  it('walks at most 6 directories looking for the manifest', () => {
    expect(SIMULATION_LINEAGE_SCAFFOLD).toContain('WALK_DEPTH = 6');
  });

  it('throws ECLI-LIN-068 from the strict variant', () => {
    expect(SIMULATION_LINEAGE_SCAFFOLD).toContain('ECLI-LIN-068');
  });
});

// ============================================================================
// Runtime checks — dynamic import the scaffolded ESM module
// ============================================================================

describe('ADR-068 — scaffolded module runtime behavior', () => {
  it('loads from AGENTICS_SIMULATION_ID env override', async () => {
    const dir = mkTempDir('runtime-env');
    try {
      const filePath = writeScaffoldAsMjs(dir);
      const mod = await importScaffold(filePath);
      const lineage = withEnv(
        { AGENTICS_SIMULATION_ID: 'sim-test-068', AGENTICS_TRACE_ID: 'trace-test-068' },
        () => mod.loadSimulationLineage(),
      );
      expect(lineage.simulationId).toBe('sim-test-068');
      expect(lineage.traceId).toBe('trace-test-068');
      expect(lineage.source).toBe('env');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reads .agentics/plans/manifest.json from a parent directory', async () => {
    const dir = mkTempDir('runtime-manifest');
    try {
      // Place manifest two levels up from where the scaffold lives.
      const projectRoot = dir;
      const plansDir = path.join(projectRoot, '.agentics', 'plans');
      fs.mkdirSync(plansDir, { recursive: true });
      fs.writeFileSync(
        path.join(plansDir, 'manifest.json'),
        JSON.stringify({
          run_id: 'sim-from-manifest-068',
          simulation_id: 'sim-from-manifest-068',
          trace_id: 'trace-from-manifest-068',
        }),
        'utf-8',
      );

      const moduleDir = path.join(projectRoot, 'src', 'services');
      fs.mkdirSync(moduleDir, { recursive: true });
      const filePath = writeScaffoldAsMjs(moduleDir);

      const mod = await importScaffold(filePath);
      const lineage = withEnv(
        { AGENTICS_SIMULATION_ID: undefined, AGENTICS_TRACE_ID: undefined },
        () => mod.loadSimulationLineage(),
      );
      expect(lineage.source).toBe('manifest');
      expect(lineage.simulationId).toBe('sim-from-manifest-068');
      expect(lineage.traceId).toBe('trace-from-manifest-068');
      expect(lineage.manifestPath).toContain('manifest.json');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns source=fallback when no env or manifest is available', async () => {
    const dir = mkTempDir('runtime-fallback');
    const isolatedCwd = mkTempDir('runtime-fallback-cwd');
    try {
      const filePath = writeScaffoldAsMjs(dir);
      const mod = await importScaffold(filePath);
      const originalCwd = process.cwd();
      try {
        process.chdir(isolatedCwd);
        const lineage = withEnv(
          { AGENTICS_SIMULATION_ID: undefined, AGENTICS_TRACE_ID: undefined },
          () => mod.loadSimulationLineage(),
        );
        expect(lineage.source).toBe('fallback');
        expect(lineage.simulationId).toBe('sim-unknown');
      } finally {
        process.chdir(originalCwd);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(isolatedCwd, { recursive: true, force: true });
    }
  });

  it('requireSimulationLineage throws ECLI-LIN-068 on fallback', async () => {
    const dir = mkTempDir('runtime-strict');
    const isolatedCwd = mkTempDir('runtime-strict-cwd');
    try {
      const filePath = writeScaffoldAsMjs(dir);
      const mod = await importScaffold(filePath);
      const originalCwd = process.cwd();
      try {
        process.chdir(isolatedCwd);
        withEnv({ AGENTICS_SIMULATION_ID: undefined }, () => {
          expect(() => mod.requireSimulationLineage()).toThrow(/ECLI-LIN-068/);
        });
      } finally {
        process.chdir(originalCwd);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(isolatedCwd, { recursive: true, force: true });
    }
  });

  it('formatLineageBanner prints a loud warning on fallback', async () => {
    const dir = mkTempDir('runtime-banner');
    try {
      const filePath = writeScaffoldAsMjs(dir);
      const mod = await importScaffold(filePath);
      const banner = mod.formatLineageBanner({ source: 'fallback', simulationId: 'sim-unknown' });
      expect(banner).toContain('Simulation lineage unavailable');
      expect(banner).toContain('AGENTICS_SIMULATION_ID');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('formatLineageBanner prints a quiet status line on env or manifest source', async () => {
    const dir = mkTempDir('runtime-banner-ok');
    try {
      const filePath = writeScaffoldAsMjs(dir);
      const mod = await importScaffold(filePath);
      const banner = mod.formatLineageBanner({ source: 'env', simulationId: 'sim-ok-068' });
      expect(banner).toContain('sim-ok-068');
      expect(banner).not.toContain('Simulation lineage unavailable');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ============================================================================
// Sanity: scaffold writes to disk via copyPlanningArtifacts (smoke test)
// ============================================================================
//
// We can't easily invoke copyPlanningArtifacts directly (it's not exported),
// but we can verify the SIMULATION_LINEAGE_SCAFFOLD constant matches what
// would be written. The static + runtime tests above already prove the
// content is correct; this stanza just documents the wiring path.

describe('ADR-068 — wiring sanity', () => {
  it('SIMULATION_LINEAGE_SCAFFOLD is non-empty and reasonably sized', () => {
    expect(SIMULATION_LINEAGE_SCAFFOLD.length).toBeGreaterThan(800);
    expect(SIMULATION_LINEAGE_SCAFFOLD.length).toBeLessThan(8000);
  });
});
