/**
 * Database Adapter — infrastructure layer implementation of DbClient.
 *
 * Provides concrete adapters that bridge the domain's DbClient port
 * to database backends. Two implementations:
 *
 *   1. InMemoryDbAdapter  — zero-dependency, used for simulation/prototype
 *      demonstrations. Data lives in Maps; no persistence across restarts.
 *      This is the default for `agentics simulate` runs so enterprises can
 *      evaluate the solution without provisioning real infrastructure.
 *
 *   2. Production path (not included here) — the enterprise replaces this
 *      adapter with a real connection pool (SAP HANA, PostgreSQL, SQL Server)
 *      when moving from prototype to production. The DbClient interface
 *      remains identical, so domain code needs zero changes.
 *
 * Supports SAP HANA, PostgreSQL, and SQL Server dialects used by the
 * ERP database map. Passwords are always read from environment variables.
 *
 * To add sqlite for local persistence (optional):
 *   npm install sql.js   (WASM-based, no native compilation)
 *   Then implement DbClient.query/execute against sql.js API.
 */

import type { DbClient } from '../compliance/audit-trail.js';
import type { SQLDialect } from '../deps/erp-database-map.js';

// ---------------------------------------------------------------------------
// Connection Configuration
// ---------------------------------------------------------------------------

export interface DbConnectionConfig {
  readonly host: string;
  readonly port: number;
  readonly database: string;
  readonly user: string;
  /** Read from environment — never hardcode. */
  readonly passwordEnvVar: string;
  readonly ssl: boolean;
  readonly maxConnections: number;
  readonly idleTimeoutMs: number;
  readonly dialect: SQLDialect;
}

/**
 * Build a DbConnectionConfig from environment variables.
 * Passwords are always resolved from env at runtime — never stored in config.
 */
export function buildDbConfigFromEnv(dialect: SQLDialect): DbConnectionConfig {
  return {
    host: process.env['DB_HOST'] ?? 'localhost',
    port: Number(process.env['DB_PORT'] ?? dialectDefaultPort(dialect)),
    database: process.env['DB_NAME'] ?? 'agentics',
    user: process.env['DB_USER'] ?? '',
    passwordEnvVar: 'DB_PASSWORD',
    ssl: process.env['DB_SSL'] !== 'false',
    maxConnections: Number(process.env['DB_MAX_CONNECTIONS'] ?? 10),
    idleTimeoutMs: Number(process.env['DB_IDLE_TIMEOUT_MS'] ?? 30_000),
    dialect,
  };
}

function dialectDefaultPort(dialect: SQLDialect): number {
  switch (dialect) {
    case 'hana-sql': return 30015;
    case 'oracle-sql': return 1521;
    case 'tsql': return 1433;
    case 'db2-sql': return 50000;
    case 'postgresql': return 5432;
    case 'mysql': return 3306;
    default: return 5432;
  }
}

// ---------------------------------------------------------------------------
// In-Memory DbClient (for prototyping / testing)
// ---------------------------------------------------------------------------

export interface InMemoryRow {
  [key: string]: unknown;
}

/**
 * In-memory implementation of DbClient for prototype demonstrations.
 * Stores rows in Maps keyed by table name, parsed from SQL statements.
 */
export class InMemoryDbAdapter implements DbClient {
  private readonly tables = new Map<string, InMemoryRow[]>();

  getTable(name: string): InMemoryRow[] {
    if (!this.tables.has(name)) {
      this.tables.set(name, []);
    }
    return this.tables.get(name)!;
  }

  async query(sql: string, params: unknown[]): Promise<unknown[]> {
    const tableName = extractTableName(sql);
    if (!tableName) return [];

    const rows = this.getTable(tableName);

    // Simple WHERE clause matching on first param
    if (sql.includes('WHERE') && params.length > 0) {
      const columnMatch = sql.match(/WHERE\s+(\w+)\s*=/i);
      if (columnMatch) {
        const column = columnMatch[1]!;
        return rows.filter((r) => r[column] === params[0]);
      }
    }

    // ORDER BY support for audit_log
    if (sql.includes('ORDER BY sequence_number')) {
      return [...rows].sort(
        (a, b) => (a['sequence_number'] as number) - (b['sequence_number'] as number),
      );
    }

    return rows;
  }

  async execute(sql: string, params: unknown[]): Promise<void> {
    const tableName = extractTableName(sql);
    if (!tableName) return;

    if (sql.match(/INSERT/i)) {
      const columns = extractInsertColumns(sql);
      const row: InMemoryRow = {};
      columns.forEach((col, idx) => {
        row[col] = params[idx];
      });
      this.getTable(tableName).push(row);
    }

    if (sql.match(/UPDATE/i)) {
      const setMatch = sql.match(/SET\s+(\w+)\s*=\s*\$/i);
      const whereMatch = sql.match(/WHERE\s+(\w+)\s*=\s*\$/i);
      if (setMatch && whereMatch) {
        const setCol = setMatch[1]!;
        const whereCol = whereMatch[1]!;
        const whereVal = params[params.length - 1];
        const rows = this.getTable(tableName);
        for (const row of rows) {
          if (row[whereCol] === whereVal) {
            row[setCol] = params[0];
          }
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Factory — swap adapter without changing domain code
// ---------------------------------------------------------------------------

export type DbAdapterMode = 'in-memory' | 'sqlite' | 'production';

/**
 * Create a DbClient for the requested mode.
 *
 * - 'in-memory': Default for simulations. Zero dependencies, fast, ephemeral.
 * - 'sqlite':    For local persistence. Requires `sql.js` (WASM). Not yet
 *                implemented — falls back to in-memory with a warning.
 * - 'production': Reserved for enterprise deployment. Throws if called in
 *                 the prototype — enterprises implement this themselves.
 */
export function createDbAdapter(mode: DbAdapterMode = 'in-memory'): DbClient {
  switch (mode) {
    case 'in-memory':
      return new InMemoryDbAdapter();
    case 'sqlite':
      // sqlite via sql.js can be added here when needed:
      //   import initSqlJs from 'sql.js';
      //   const SQL = await initSqlJs();
      //   const db = new SQL.Database();
      // For now, fall back to in-memory (sufficient for simulation).
      console.warn('[db-adapter] sqlite mode not yet installed — using in-memory adapter');
      return new InMemoryDbAdapter();
    case 'production':
      throw new Error(
        '[db-adapter] Production mode requires a real database adapter. ' +
        'Implement DbClient against your SAP HANA / PostgreSQL / SQL Server instance.',
      );
  }
}

// ---------------------------------------------------------------------------
// SQL Helpers
// ---------------------------------------------------------------------------

function extractTableName(sql: string): string | null {
  const match = sql.match(/(?:FROM|INTO|UPDATE)\s+(\w+)/i);
  return match ? match[1]! : null;
}

function extractInsertColumns(sql: string): string[] {
  const match = sql.match(/\(([^)]+)\)\s*VALUES/i);
  if (!match) return [];
  return match[1]!.split(',').map((c) => c.trim());
}
