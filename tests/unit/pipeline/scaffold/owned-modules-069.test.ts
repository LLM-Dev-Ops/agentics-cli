/**
 * ADR-PIPELINE-069 tests: scaffold/generator file ownership.
 *
 * Verifies:
 *  - OWNED_SCAFFOLD_MODULES has all expected entries with public exports
 *  - buildOwnedModulesManifest produces a JSON-serializable shape v1.0
 *  - CIRCUIT_BREAKER_SCAFFOLD contains the canonical class and imports
 *    from logger.js (the dedicated scaffold file from §2 of the ADR)
 *  - detectScaffoldDuplicates flags a synthetic duplicate, ignores
 *    scaffolded files themselves, ignores tests, ignores .agentics/
 *  - The implementation prompt template contains the SCAFFOLD-OWNED block
 *    with at least the CircuitBreaker entry
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  OWNED_SCAFFOLD_MODULES,
  CIRCUIT_BREAKER_SCAFFOLD,
  buildOwnedModulesManifest,
  detectScaffoldDuplicates,
  type OwnedScaffoldModule,
} from '../../../../src/pipeline/auto-chain.js';

// ============================================================================
// Helpers
// ============================================================================

function mkTempProject(label: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `adr069-${label}-`));
}

function writeFile(root: string, relPath: string, content: string): void {
  const full = path.join(root, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, 'utf-8');
}

// ============================================================================
// OWNED_SCAFFOLD_MODULES contract
// ============================================================================

describe('ADR-069 — OWNED_SCAFFOLD_MODULES', () => {
  it('lists every cross-cutting scaffold module', () => {
    const paths = OWNED_SCAFFOLD_MODULES.map(m => m.path);
    expect(paths).toEqual(
      expect.arrayContaining([
        'src/logger.ts',
        'src/config.ts',
        'src/errors.ts',
        'src/middleware.ts',
        'src/circuit-breaker.ts',
        'src/unit-economics.ts',
        'src/simulation-lineage.ts',
      ]),
    );
  });

  it('every entry has a non-empty exports list', () => {
    for (const mod of OWNED_SCAFFOLD_MODULES) {
      expect(mod.exports.length).toBeGreaterThan(0);
      expect(mod.path).toMatch(/^src\//);
    }
  });

  it('CircuitBreaker is owned by src/circuit-breaker.ts (not middleware.ts)', () => {
    const owner = OWNED_SCAFFOLD_MODULES.find(m => m.exports.includes('CircuitBreaker'));
    expect(owner).toBeDefined();
    expect(owner!.path).toBe('src/circuit-breaker.ts');
  });

  it('no two scaffold files claim the same export', () => {
    const seen = new Map<string, string>();
    const collisions: string[] = [];
    for (const mod of OWNED_SCAFFOLD_MODULES) {
      for (const ex of mod.exports) {
        const prior = seen.get(ex);
        if (prior && prior !== mod.path) {
          collisions.push(`${ex} declared by both ${prior} and ${mod.path}`);
        }
        seen.set(ex, mod.path);
      }
    }
    expect(collisions).toEqual([]);
  });
});

describe('ADR-069 — buildOwnedModulesManifest', () => {
  it('produces a v1.0 manifest with generated_at and owned[]', () => {
    const manifest = buildOwnedModulesManifest(new Date('2026-04-11T12:00:00Z'));
    expect(manifest.version).toBe('1.0');
    expect(manifest.generated_at).toBe('2026-04-11T12:00:00.000Z');
    expect(Array.isArray(manifest.owned)).toBe(true);
    expect(manifest.owned.length).toBe(OWNED_SCAFFOLD_MODULES.length);
  });

  it('round-trips through JSON', () => {
    const manifest = buildOwnedModulesManifest();
    const roundTripped = JSON.parse(JSON.stringify(manifest)) as { owned: OwnedScaffoldModule[] };
    expect(roundTripped.owned.find(m => m.path === 'src/circuit-breaker.ts')?.exports).toContain('CircuitBreaker');
  });
});

// ============================================================================
// CIRCUIT_BREAKER_SCAFFOLD body
// ============================================================================

describe('ADR-069 — CIRCUIT_BREAKER_SCAFFOLD', () => {
  it('declares the canonical class', () => {
    expect(CIRCUIT_BREAKER_SCAFFOLD).toContain('export class CircuitBreaker');
  });

  it('imports createLogger from the logger scaffold', () => {
    expect(CIRCUIT_BREAKER_SCAFFOLD).toContain("from './logger.js'");
    expect(CIRCUIT_BREAKER_SCAFFOLD).toContain('createLogger');
  });

  it('contains all three state names so PGV-009 is satisfiable', () => {
    expect(CIRCUIT_BREAKER_SCAFFOLD).toContain("'closed'");
    expect(CIRCUIT_BREAKER_SCAFFOLD).toContain("'open'");
    expect(CIRCUIT_BREAKER_SCAFFOLD).toContain("'half-open'");
  });
});

// ============================================================================
// detectScaffoldDuplicates
// ============================================================================

describe('ADR-069 — detectScaffoldDuplicates', () => {
  it('returns 0 findings on a clean project', () => {
    const dir = mkTempProject('clean');
    try {
      writeFile(dir, 'src/services/widget.ts', 'export class Widget {}');
      expect(detectScaffoldDuplicates(dir)).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('flags a duplicate CircuitBreaker class outside the scaffold', () => {
    const dir = mkTempProject('dupe-cb');
    try {
      writeFile(dir, 'src/erp/breaker.ts',
        'export class CircuitBreaker { constructor(public name: string) {} }');
      const dupes = detectScaffoldDuplicates(dir);
      expect(dupes).toHaveLength(1);
      expect(dupes[0]!.exportName).toBe('CircuitBreaker');
      expect(dupes[0]!.ownedPath).toBe('src/circuit-breaker.ts');
      expect(dupes[0]!.path).toContain(path.join('src', 'erp', 'breaker.ts'));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('flags a duplicate createLogger function', () => {
    const dir = mkTempProject('dupe-fn');
    try {
      writeFile(dir, 'src/services/log.ts',
        'export function createLogger(s: string) { return { info() {} }; }');
      const dupes = detectScaffoldDuplicates(dir);
      expect(dupes.some(d => d.exportName === 'createLogger')).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does NOT flag the scaffold-owned files themselves', () => {
    const dir = mkTempProject('scaffold-itself');
    try {
      // Same basename as the owned scaffold path → must be exempt.
      writeFile(dir, 'src/circuit-breaker.ts',
        'export class CircuitBreaker { constructor(public name: string) {} }');
      writeFile(dir, 'src/logger.ts',
        'export function createLogger(s: string) { return { info() {} }; }');
      expect(detectScaffoldDuplicates(dir)).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does NOT flag test files', () => {
    const dir = mkTempProject('tests');
    try {
      writeFile(dir, 'tests/circuit-breaker.test.ts',
        'export class CircuitBreaker { constructor(public name: string) {} }');
      expect(detectScaffoldDuplicates(dir)).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('skips node_modules and .agentics directories', () => {
    const dir = mkTempProject('skipdirs');
    try {
      writeFile(dir, 'node_modules/dep/circuit-breaker.ts',
        'export class CircuitBreaker { constructor(public name: string) {} }');
      writeFile(dir, '.agentics/plans/scaffold/src/circuit-breaker.ts',
        'export class CircuitBreaker { constructor(public name: string) {} }');
      expect(detectScaffoldDuplicates(dir)).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('flags a re-export of a scaffold-owned name from a barrel', () => {
    const dir = mkTempProject('reexport');
    try {
      writeFile(dir, 'src/index.ts',
        'export { CircuitBreaker } from "./services/breaker.js";');
      const dupes = detectScaffoldDuplicates(dir);
      expect(dupes.some(d => d.exportName === 'CircuitBreaker')).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ============================================================================
// Implementation prompt injection
// ============================================================================

describe('ADR-069 — implementation prompt SCAFFOLD-OWNED block', () => {
  // We can't import the prompt-generator's CROSS_CUTTING_FOOTER directly
  // (it's not exported), but we can read the source file and assert the
  // generated block is present. This guards against accidental removal of
  // the injection point.
  it('prompt-generator.ts contains the SCAFFOLD-OWNED MODULES heading', () => {
    const promptGen = fs.readFileSync(
      path.join(process.cwd(), 'src', 'pipeline', 'phase2', 'phases', 'prompt-generator.ts'),
      'utf-8',
    );
    expect(promptGen).toContain('SCAFFOLD-OWNED MODULES');
    expect(promptGen).toContain('PGV-012');
    expect(promptGen).toContain('OWNED_SCAFFOLD_MODULES');
  });
});
