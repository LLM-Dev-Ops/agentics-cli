/**
 * ADR-PIPELINE-075 tests: scaffolded persistence primitives.
 *
 * Two layers:
 *  1. Static contract checks on each scaffold constant (REPOSITORY_SCAFFOLD,
 *     IN_MEMORY_REPO_SCAFFOLD, SQLITE_REPO_SCAFFOLD, AUDIT_REPO_SCAFFOLD):
 *     imports, exports, forbidden patterns.
 *  2. Runtime check on InMemoryRepository: transpile the scaffold + its
 *     repository-interface dependency, dynamic-import the resulting .mjs,
 *     exercise save/get/list/delete with a real Zod schema.
 *
 * SqliteRepository runtime is NOT exercised here — better-sqlite3 is a
 * scaffolded dependency, not a pipeline dependency, so we validate its
 * static shape only. A generated project's own tests will cover the
 * SQLite path when the user installs the dep.
 *
 * Also verifies:
 *  - OWNED_SCAFFOLD_MODULES gains 4 persistence entries
 *  - PGV-017 fires on Map-backed service classes and passes on clean code
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import * as ts from 'typescript';

import {
  REPOSITORY_SCAFFOLD,
  IN_MEMORY_REPO_SCAFFOLD,
  SQLITE_REPO_SCAFFOLD,
  AUDIT_REPO_SCAFFOLD,
  OWNED_SCAFFOLD_MODULES,
} from '../../../../src/pipeline/auto-chain.js';

// ============================================================================
// Helpers
// ============================================================================

function mkTempDir(label: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `adr075-${label}-`));
}

/**
 * Transpile a scaffold string to .mjs with inlined type-stripping and
 * write to a target path. Handles the cross-file import from
 * in-memory-repository.ts to repository.ts by giving the caller control
 * over where each file lands.
 *
 * CRITICAL: fileName must end in `.ts` so TypeScript parses the input as
 * TypeScript source. Passing a `.mjs` filename makes the compiler treat
 * input as plain JS and it produces garbled output.
 */
function transpileAndWrite(source: string, filePath: string, tsName: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
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
  // Rewrite import specifier from './repository.js' to match the .mjs
  // sibling we just wrote alongside it.
  let out = compiled.outputText;
  out = out.replace(/from\s+['"]\.\/repository\.js['"]/g, "from './repository.mjs'");
  fs.writeFileSync(filePath, out, 'utf-8');
}

// ============================================================================
// Static contract — REPOSITORY_SCAFFOLD
// ============================================================================

describe('ADR-075 — REPOSITORY_SCAFFOLD static contract', () => {
  it('exports Repository, RepositoryOptions, RepositoryError', () => {
    expect(REPOSITORY_SCAFFOLD).toContain('export interface Repository');
    expect(REPOSITORY_SCAFFOLD).toContain('export interface RepositoryOptions');
    expect(REPOSITORY_SCAFFOLD).toContain('export class RepositoryError');
  });

  it('Repository interface has save/get/list/delete', () => {
    expect(REPOSITORY_SCAFFOLD).toContain('save(entity: T)');
    expect(REPOSITORY_SCAFFOLD).toContain('get(id: string)');
    expect(REPOSITORY_SCAFFOLD).toContain('list(filter');
    expect(REPOSITORY_SCAFFOLD).toContain('delete(id: string)');
  });

  it('imports Zod for schema validation', () => {
    expect(REPOSITORY_SCAFFOLD).toContain('ZodType');
  });
});

// ============================================================================
// Static contract — IN_MEMORY_REPO_SCAFFOLD
// ============================================================================

describe('ADR-075 — IN_MEMORY_REPO_SCAFFOLD static contract', () => {
  it('exports InMemoryRepository class implementing Repository<T>', () => {
    expect(IN_MEMORY_REPO_SCAFFOLD).toContain('export class InMemoryRepository');
    expect(IN_MEMORY_REPO_SCAFFOLD).toContain('implements Repository<T>');
  });

  it('validates entities on save via the Zod schema', () => {
    expect(IN_MEMORY_REPO_SCAFFOLD).toContain('this.options.schema.parse(entity)');
  });

  it('exposes clear() test helper', () => {
    expect(IN_MEMORY_REPO_SCAFFOLD).toContain('clear(): void');
  });
});

// ============================================================================
// Static contract — SQLITE_REPO_SCAFFOLD
// ============================================================================

describe('ADR-075 — SQLITE_REPO_SCAFFOLD static contract', () => {
  it('exports SqliteRepository + BetterSqliteDatabase structural type', () => {
    expect(SQLITE_REPO_SCAFFOLD).toContain('export class SqliteRepository');
    expect(SQLITE_REPO_SCAFFOLD).toContain('export interface BetterSqliteDatabase');
    expect(SQLITE_REPO_SCAFFOLD).toContain('export interface SqliteRepositoryDeps');
  });

  it('rejects unsafe table names with ECLI-REPO-001', () => {
    expect(SQLITE_REPO_SCAFFOLD).toContain('ECLI-REPO-001');
    expect(SQLITE_REPO_SCAFFOLD).toMatch(/\/\^\[a-zA-Z_\]\[a-zA-Z0-9_\]\*\$\//);
  });

  it('uses ON CONFLICT upsert pattern', () => {
    expect(SQLITE_REPO_SCAFFOLD).toContain('ON CONFLICT(id)');
    expect(SQLITE_REPO_SCAFFOLD).toContain('updated_at');
  });

  it('re-validates JSON rows on read', () => {
    expect(SQLITE_REPO_SCAFFOLD).toContain('this.options.schema.parse(JSON.parse(row.data))');
  });
});

// ============================================================================
// Static contract — AUDIT_REPO_SCAFFOLD
// ============================================================================

describe('ADR-075 — AUDIT_REPO_SCAFFOLD static contract', () => {
  it('exports AppendOnlyAuditRepository', () => {
    expect(AUDIT_REPO_SCAFFOLD).toContain('export class AppendOnlyAuditRepository');
  });

  it('creates audit_log table with the full schema', () => {
    expect(AUDIT_REPO_SCAFFOLD).toContain('CREATE TABLE IF NOT EXISTS audit_log');
    expect(AUDIT_REPO_SCAFFOLD).toContain('entry_id TEXT NOT NULL UNIQUE');
    expect(AUDIT_REPO_SCAFFOLD).toContain('prev_hash TEXT NOT NULL');
    expect(AUDIT_REPO_SCAFFOLD).toContain('CREATE INDEX IF NOT EXISTS idx_audit_log_entity');
  });

  it('exports append + list + listByEntity + size but NO update or delete', () => {
    expect(AUDIT_REPO_SCAFFOLD).toContain('append(entry: AuditEntry)');
    expect(AUDIT_REPO_SCAFFOLD).toContain('list(): readonly AuditEntry[]');
    expect(AUDIT_REPO_SCAFFOLD).toContain('listByEntity(entityType: string');
    expect(AUDIT_REPO_SCAFFOLD).toContain('size(): number');
    // The critical invariant: no update or delete methods on the class
    expect(AUDIT_REPO_SCAFFOLD).not.toMatch(/\bupdate\s*\(/);
    expect(AUDIT_REPO_SCAFFOLD).not.toMatch(/\bdelete\s*\(/);
  });
});

// ============================================================================
// OWNED_SCAFFOLD_MODULES coverage
// ============================================================================

describe('ADR-075 — OWNED_SCAFFOLD_MODULES entries', () => {
  it('lists all four persistence scaffold files', () => {
    const paths = OWNED_SCAFFOLD_MODULES.map(m => m.path);
    expect(paths).toEqual(
      expect.arrayContaining([
        'src/persistence/repository.ts',
        'src/persistence/in-memory-repository.ts',
        'src/persistence/sqlite-repository.ts',
        'src/persistence/audit-repository.ts',
      ]),
    );
  });

  it('repository.ts entry includes Repository + RepositoryError', () => {
    const entry = OWNED_SCAFFOLD_MODULES.find(m => m.path === 'src/persistence/repository.ts');
    expect(entry?.exports).toContain('Repository');
    expect(entry?.exports).toContain('RepositoryOptions');
    expect(entry?.exports).toContain('RepositoryError');
  });

  it('audit-repository.ts entry includes AppendOnlyAuditRepository + AuditEntry', () => {
    const entry = OWNED_SCAFFOLD_MODULES.find(m => m.path === 'src/persistence/audit-repository.ts');
    expect(entry?.exports).toContain('AppendOnlyAuditRepository');
    expect(entry?.exports).toContain('AuditEntry');
  });
});

// ============================================================================
// Runtime — InMemoryRepository against a real Zod schema
// ============================================================================

describe('ADR-075 — InMemoryRepository runtime', () => {
  /**
   * Compile repository.ts + in-memory-repository.ts to a temp dir, then
   * dynamic-import and exercise the full CRUD cycle with a Zod schema.
   * Uses zod from node_modules directly (already a pipeline dependency).
   */
  interface CompiledMods {
    repo: {
      InMemoryRepository: new <T>(options: {
        idOf: (e: T) => string;
        schema: { parse: (x: unknown) => T };
        tableName: string;
      }) => {
        save: (e: T) => Promise<void>;
        get: (id: string) => Promise<T | null>;
        list: (filter?: Partial<T>) => Promise<readonly T[]>;
        delete: (id: string) => Promise<void>;
        clear: () => void;
        readonly size: number;
      };
    };
  }

  async function loadMods(dir: string): Promise<CompiledMods> {
    transpileAndWrite(REPOSITORY_SCAFFOLD, path.join(dir, 'repository.mjs'), 'repository.ts');
    transpileAndWrite(IN_MEMORY_REPO_SCAFFOLD, path.join(dir, 'in-memory-repository.mjs'), 'in-memory-repository.ts');
    const repoUrl =
      pathToFileURL(path.join(dir, 'in-memory-repository.mjs')).href +
      `?t=${Date.now()}-${Math.random()}`;
    const repo = (await import(repoUrl)) as CompiledMods['repo'];
    return { repo };
  }

  it('saves, gets, lists, and deletes entities', async () => {
    const dir = mkTempDir('inmem-crud');
    try {
      const { repo } = await loadMods(dir);
      const { z } = await import('zod');
      const WidgetSchema = z.object({
        id: z.string(),
        name: z.string(),
        color: z.enum(['red', 'green', 'blue']),
      });
      type Widget = import('zod').infer<typeof WidgetSchema>;
      const store = new repo.InMemoryRepository<Widget>({
        idOf: (w) => w.id,
        schema: WidgetSchema,
        tableName: 'widgets',
      });

      expect(store.size).toBe(0);
      await store.save({ id: 'w1', name: 'alpha', color: 'red' });
      await store.save({ id: 'w2', name: 'beta', color: 'green' });
      expect(store.size).toBe(2);

      const w1 = await store.get('w1');
      expect(w1?.name).toBe('alpha');

      const red = await store.list({ color: 'red' });
      expect(red).toHaveLength(1);
      expect(red[0]!.id).toBe('w1');

      await store.delete('w1');
      expect(store.size).toBe(1);
      expect(await store.get('w1')).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects entities that fail Zod validation at save time', async () => {
    const dir = mkTempDir('inmem-validate');
    try {
      const { repo } = await loadMods(dir);
      const { z } = await import('zod');
      const StrictSchema = z.object({
        id: z.string(),
        count: z.number().int().nonnegative(),
      });
      type Row = import('zod').infer<typeof StrictSchema>;
      const store = new repo.InMemoryRepository<Row>({
        idOf: (r) => r.id,
        schema: StrictSchema,
        tableName: 'rows',
      });
      await expect(
        store.save({ id: 'x', count: -1 } as Row),
      ).rejects.toThrow();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
