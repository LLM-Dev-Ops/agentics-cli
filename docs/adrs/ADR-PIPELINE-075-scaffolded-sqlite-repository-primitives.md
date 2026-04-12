# ADR-PIPELINE-075: Scaffolded Persistence Layer — SQLite Repository Primitives

**Status:** Accepted
**Date:** 2026-04-12
**Priority:** HIGH — Persistence is flagged on every readiness review
**Originating Review:** Ramco Aviation Catering Readiness Review (2026-04-12), Architecture 6/10
**Prior Reviews:** OPERA Sustainability Review (2026-04-11) called out the same class of defect in ApprovalService
**Builds on:** ADR-PIPELINE-069 (Scaffold Ownership), ADR-PIPELINE-039 (Scaffold Files)

## Context

Every production readiness review surfaces the same architecture gap:

> "Persistence is in-memory: `RecommendationService.store`, `AuditService.entries`, and the Ramco transport all evaporate on restart. For a pilot, a Postgres-backed store (recommendations, audit_log with append-only trigger, erp_outbox) is the single highest-leverage change."
> — Ramco review 2026-04-12, Architecture 6/10
>
> "Persistence is in-memory Map inside ApprovalService — acceptable for pilot, must be called out as a pilot-only seam."
> — OPERA review 2026-04-11, Architecture 8/10

The problem is **not** that the coding agent chose `Map` — it is that the scaffold provides no persistence primitives. Every prototype starts from zero and lands on `new Map<string, T>()` as the path of least resistance. Pilot teams then rewrite the store during stabilization, which is exactly the high-leverage work ADR-069's ownership model was designed to eliminate.

The fix is to ship persistence as a scaffold primitive: a `Repository<T>` interface, an `InMemoryRepository<T>` for tests, and a `SqliteRepository<T>` backed by `better-sqlite3` (which has zero native-compilation drama on all platforms the CLI targets). Generated services import from the scaffold and configure one or the other via `AppConfig`.

Additionally, the audit log needs its own variant — append-only with a "trigger" (emulated as an insert-only helper + verify step) so tamper attempts are rejected at the repository layer, not just at the hash-chain layer.

## Decision

### 1. Scaffold `src/persistence/` Directory

Add four new scaffold files to `src/pipeline/auto-chain.ts`:

- `src/persistence/repository.ts` — `Repository<T>` interface
- `src/persistence/in-memory-repository.ts` — `InMemoryRepository<T>` for tests
- `src/persistence/sqlite-repository.ts` — `SqliteRepository<T>` (better-sqlite3)
- `src/persistence/audit-repository.ts` — `AppendOnlyAuditRepository` for audit log

Each is emitted by `copyPlanningArtifacts()` alongside `src/logger.ts`, `src/simulation-lineage.ts`, etc.

### 2. `Repository<T>` Interface

```typescript
// src/persistence/repository.ts
export interface Repository<T> {
  save(entity: T): Promise<void>;
  get(id: string): Promise<T | null>;
  list(filter?: Partial<T>): Promise<readonly T[]>;
  delete(id: string): Promise<void>;
}

export interface RepositoryOptions<T> {
  /** How to extract the primary key from an entity. */
  readonly idOf: (entity: T) => string;
  /** Zod schema used to validate rows on load from SQLite JSON columns. */
  readonly schema: import('zod').ZodType<T>;
  /** Table name for SQLite backend. Ignored by in-memory impl. */
  readonly tableName: string;
}

/** Errors thrown by all Repository implementations. */
export class RepositoryError extends Error {
  constructor(message: string, public readonly code: string) {
    super(`${code}: ${message}`);
    this.name = 'RepositoryError';
  }
}
```

### 3. `InMemoryRepository<T>` for Tests

```typescript
// src/persistence/in-memory-repository.ts
import type { Repository, RepositoryOptions } from './repository.js';

export class InMemoryRepository<T> implements Repository<T> {
  private readonly rows = new Map<string, T>();
  constructor(private readonly options: RepositoryOptions<T>) {}

  async save(entity: T): Promise<void> {
    const validated = this.options.schema.parse(entity);
    this.rows.set(this.options.idOf(validated), validated);
  }

  async get(id: string): Promise<T | null> {
    return this.rows.get(id) ?? null;
  }

  async list(filter?: Partial<T>): Promise<readonly T[]> {
    const all = Array.from(this.rows.values());
    if (!filter) return all;
    return all.filter(row =>
      Object.entries(filter).every(([k, v]) => (row as Record<string, unknown>)[k] === v),
    );
  }

  async delete(id: string): Promise<void> {
    this.rows.delete(id);
  }

  /** Test helper — never call from production code. */
  clear(): void {
    this.rows.clear();
  }
}
```

### 4. `SqliteRepository<T>` Backed by better-sqlite3

```typescript
// src/persistence/sqlite-repository.ts
import type Database from 'better-sqlite3';
import type { Repository, RepositoryOptions } from './repository.js';
import { RepositoryError } from './repository.js';

export interface SqliteRepositoryDeps {
  readonly db: Database.Database;
}

/**
 * SQLite-backed repository. Stores each entity as a JSON column keyed by
 * its primary key. Zod re-validates on every read — the JSON column is
 * untrusted at runtime.
 */
export class SqliteRepository<T> implements Repository<T> {
  constructor(
    private readonly deps: SqliteRepositoryDeps,
    private readonly options: RepositoryOptions<T>,
  ) {
    this.deps.db.exec(`
      CREATE TABLE IF NOT EXISTS ${this.safeTable()} (
        id TEXT PRIMARY KEY,
        data TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
    `);
  }

  private safeTable(): string {
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(this.options.tableName)) {
      throw new RepositoryError(`unsafe table name: ${this.options.tableName}`, 'ECLI-REPO-001');
    }
    return this.options.tableName;
  }

  async save(entity: T): Promise<void> {
    const validated = this.options.schema.parse(entity);
    const id = this.options.idOf(validated);
    const data = JSON.stringify(validated);
    this.deps.db
      .prepare(`INSERT INTO ${this.safeTable()} (id, data) VALUES (?, ?)
                ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`)
      .run(id, data);
  }

  async get(id: string): Promise<T | null> {
    const row = this.deps.db
      .prepare(`SELECT data FROM ${this.safeTable()} WHERE id = ?`)
      .get(id) as { data: string } | undefined;
    if (!row) return null;
    return this.options.schema.parse(JSON.parse(row.data));
  }

  async list(filter?: Partial<T>): Promise<readonly T[]> {
    const rows = this.deps.db
      .prepare(`SELECT data FROM ${this.safeTable()}`)
      .all() as Array<{ data: string }>;
    const parsed = rows.map(r => this.options.schema.parse(JSON.parse(r.data)));
    if (!filter) return parsed;
    return parsed.filter(row =>
      Object.entries(filter).every(([k, v]) => (row as Record<string, unknown>)[k] === v),
    );
  }

  async delete(id: string): Promise<void> {
    this.deps.db.prepare(`DELETE FROM ${this.safeTable()} WHERE id = ?`).run(id);
  }
}
```

Why `better-sqlite3`: synchronous API (simpler error handling), zero native-compile headaches on the platforms the CLI targets (pre-built binaries on x64/arm64 for macOS, Linux, Windows), single-file database (testable, portable), and the same library that the existing `@claude-flow/cli` daemon uses so there's no new dependency surface.

### 5. `AppendOnlyAuditRepository`

```typescript
// src/persistence/audit-repository.ts
import type Database from 'better-sqlite3';
import type { AuditEntry } from '../domain/types.js';  // generator-owned
import { RepositoryError } from './repository.js';

export interface AuditRepositoryDeps {
  readonly db: Database.Database;
}

/**
 * Append-only audit repository. There is no update and no delete — the
 * entire contract is "append and verify". Tampering is detected by
 * re-hashing the chain; the TABLE ITSELF has no DELETE or UPDATE helper,
 * eliminating an entire class of accidental rewrites from service code.
 */
export class AppendOnlyAuditRepository {
  constructor(private readonly deps: AuditRepositoryDeps) {
    this.deps.db.exec(`
      CREATE TABLE IF NOT EXISTS audit_log (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        entry_id TEXT NOT NULL UNIQUE,
        prev_hash TEXT NOT NULL,
        hash TEXT NOT NULL,
        payload TEXT NOT NULL,
        actor TEXT NOT NULL,
        action TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
      CREATE INDEX IF NOT EXISTS idx_audit_log_entity ON audit_log(entity_type, entity_id);
    `);
  }

  append(entry: AuditEntry): void {
    this.deps.db
      .prepare(`INSERT INTO audit_log (entry_id, prev_hash, hash, payload, actor, action, entity_type, entity_id)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        entry.entryId,
        entry.prevHash,
        entry.hash,
        JSON.stringify(entry.payload),
        entry.actor,
        entry.action,
        entry.entityType,
        entry.entityId,
      );
  }

  list(): readonly AuditEntry[] {
    const rows = this.deps.db.prepare(`SELECT * FROM audit_log ORDER BY sequence ASC`).all() as Array<{
      entry_id: string; prev_hash: string; hash: string; payload: string;
      actor: string; action: string; entity_type: string; entity_id: string; created_at: string;
    }>;
    return rows.map(r => ({
      entryId: r.entry_id,
      prevHash: r.prev_hash,
      hash: r.hash,
      payload: JSON.parse(r.payload),
      actor: r.actor,
      action: r.action,
      entityType: r.entity_type,
      entityId: r.entity_id,
      createdAt: r.created_at,
    }));
  }
}
```

The key invariant: the class has **no** `update`, `delete`, or `clear` methods. A service trying to mutate an audit entry has to bypass the repository and talk raw SQL — which PGV catches.

### 6. `OWNED_SCAFFOLD_MODULES` Entry

Add four new entries from ADR-069's single source of truth:

```typescript
{ path: 'src/persistence/repository.ts',
  exports: ['Repository', 'RepositoryOptions', 'RepositoryError'] },
{ path: 'src/persistence/in-memory-repository.ts',
  exports: ['InMemoryRepository'] },
{ path: 'src/persistence/sqlite-repository.ts',
  exports: ['SqliteRepository', 'SqliteRepositoryDeps'] },
{ path: 'src/persistence/audit-repository.ts',
  exports: ['AppendOnlyAuditRepository', 'AuditRepositoryDeps'] },
```

PGV-012 (scaffold ownership) auto-extends to block any generator-emitted redeclaration of these names.

### 7. PGV-017 — Ban `new Map` in Service Layers

Add to the post-generation validator:

| ID | Rule | File Pattern | Check |
|---|---|---|---|
| PGV-017 | No `new Map<string, T>` as primary storage in service files | `src/**/services/**/*.ts`, `src/**/application/**/*.ts` | Match `(?:private\|public\|readonly)\s+\w+\s*=\s*new Map<string` and warn; error when the containing class is named `*Service` AND has no `Repository` field |

The rule is lenient — it's a warning by default, error only when a Service clearly has NO persistence dependency. That avoids false positives on short-lived caches (rate-limit windows, request-scoped memoization).

### 8. Implementation Prompt Update

`src/pipeline/phase2/phases/prompt-generator.ts` adds a new cross-cutting block:

> ## Persistence (ADR-PIPELINE-075)
>
> For any stateful service (recommendations, approvals, audit trails, outbox, tasks):
>
> 1. Define the entity as a Zod schema in `src/domain/types.ts`
> 2. Import `Repository<T>` from `src/persistence/repository.ts`
> 3. Construct `SqliteRepository<T>` in the composition root (`src/container.ts`)
>    with `db: new Database(config.db.path)`
> 4. Tests construct `InMemoryRepository<T>` with the same Zod schema
> 5. For audit trails use `AppendOnlyAuditRepository` — do NOT roll your own
>
> DO NOT store service state in `new Map<string, T>()` at class scope.
> DO NOT store audit entries in an array; the append-only repository
> enforces immutability at the table level.

### 9. `AppConfig.db` Schema Extension

Config gains a `db` block:

```typescript
db: z.object({
  driver: z.enum(['sqlite', 'in-memory']).default('sqlite'),
  path: z.string().default('./data/app.db'),
}),
```

The prototype defaults to `sqlite` with a relative file path so `npm run demo` produces a persistent database file. Tests override to `in-memory`.

### 10. Sample Composition-Root Snippet in the Prompt

Prompts include a short pasteable snippet so the coding agent does not have to invent wiring:

```typescript
// In src/container.ts:
import Database from 'better-sqlite3';
import { SqliteRepository } from './persistence/sqlite-repository.js';
import { AppendOnlyAuditRepository } from './persistence/audit-repository.js';
import { RecommendationSchema } from './domain/types.js';

const db = new Database(config.db.path);
const recommendations = new SqliteRepository({ db }, {
  idOf: r => r.recommendationId,
  schema: RecommendationSchema,
  tableName: 'recommendations',
});
const auditRepo = new AppendOnlyAuditRepository({ db });
```

## Implementation

1. `src/pipeline/auto-chain.ts`: extract four new scaffold constants (`REPOSITORY_SCAFFOLD`, `IN_MEMORY_REPO_SCAFFOLD`, `SQLITE_REPO_SCAFFOLD`, `AUDIT_REPO_SCAFFOLD`); write them under `src/persistence/` in `copyPlanningArtifacts`.
2. Extend `OWNED_SCAFFOLD_MODULES` with four entries.
3. Update the scaffold `package.json` template (new `DEFAULT_PACKAGE_JSON_DEPS` constant) to include `better-sqlite3` and `@types/better-sqlite3`.
4. Extend `AppConfig` schema in `CONFIG_SCAFFOLD` to include `db` block.
5. Add `RULE_PGV_017` to `post-generation-validator.ts`.
6. Extend `prompt-generator.ts` cross-cutting footer with the Persistence block.
7. Tests:
   - `tests/unit/pipeline/scaffold/repository-scaffold-075.test.ts` — compiles + runs the scaffolded repo code with an in-memory SQLite database
   - `tests/unit/pipeline/phase5/post-generation-validator.test.ts` — PGV-017 positive + negative cases

## Acceptance Criteria

1. Every generated project contains `src/persistence/` with four files and a passing sample test.
2. Generated `package.json` includes `better-sqlite3` as a dependency.
3. `AppConfig` has a `db` section.
4. PGV-017 fires against a synthetic `*Service` class that uses `new Map<string, T>()` with no Repository dependency.
5. The implementation prompt contains the Persistence block verbatim.
6. Running `npm run demo` in a fresh generated project produces a `./data/app.db` file with `recommendations` and `audit_log` tables.
7. `npm run demo` exits with a non-zero code if SQLite driver cannot open the database (fails loud, not silent).

## Consequences

### Positive

- Persistence stops being a recurring pilot-week-1 scramble. Every generated project ships with a production-shaped storage layer on day zero.
- The audit repository's missing `update`/`delete` closes an entire class of accidental mutations — compile-time enforcement instead of runtime hash-chain verification.
- The in-memory/SQLite pair gives tests fast turnaround without mocking.
- Fresh pilots become portable: a single `.db` file is all that needs to move between environments.

### Negative

- Adds `better-sqlite3` to the generated project's dependency footprint. Pre-built binaries exist for every target platform, but first-install time grows by ~2 seconds.
- Services that need fundamentally different storage (graph databases, time-series, etc.) still need to roll their own — the Repository interface is not a universal abstraction. Documented in the scaffold comment.
- `SqliteRepository` stores entities as JSON blobs rather than normalized columns. Query performance is fine for pilot-scale data (<100K rows) but won't scale to millions without indexing support. A follow-up ADR can add indexed-column support once a real pilot needs it.

## Related

- **ADR-PIPELINE-069** (Scaffold Ownership — this ADR adds four entries)
- **ADR-PIPELINE-065** (Post-Generation Validator — hosts PGV-017)
- **ADR-PIPELINE-039** (Scaffold Files Pattern)
- **ADR-PIPELINE-078** (Deep Canonical JSON — the audit repository uses it for payload hashing)
