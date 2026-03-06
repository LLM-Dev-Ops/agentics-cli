# ADR-PIPELINE-006: SQL Dialect Selection from Infrastructure Detection

## Status
Implemented

## Context
The SQL schema generator in `src/pipeline/phase4/phases/schema-generator.ts` always produces Oracle-dialect SQL (`VARCHAR2`, `SYSTIMESTAMP`, `NOCACHE`, `NUMBER(10)`) regardless of the user's stated database infrastructure.

In the `2c1a2192` run, the user said "Azure Synapse Analytics and Azure SQL Database" but got Oracle SQL. In the `35f1e356` run, the user said "BigQuery and Cloud SQL for PostgreSQL" but also got Oracle SQL.

## Decision
Detect the database infrastructure from the user's prompt and SPARC artifacts, then generate SQL in the correct dialect:

| Infrastructure Keywords | SQL Dialect | Key Syntax Differences |
|---|---|---|
| PostgreSQL, Cloud SQL, Supabase, Aurora PostgreSQL | PostgreSQL | `VARCHAR`, `TIMESTAMPTZ`, `SERIAL`, `GENERATED ALWAYS AS IDENTITY` |
| Azure SQL, SQL Server, Azure Synapse | T-SQL | `NVARCHAR`, `GETUTCDATE()`, `IDENTITY(1,1)`, `NEWSEQUENTIALID()` |
| Oracle, Oracle Cloud | Oracle PL/SQL | `VARCHAR2`, `SYSTIMESTAMP`, `NOCACHE`, `NUMBER` |
| MySQL, Aurora MySQL, PlanetScale | MySQL | `VARCHAR`, `NOW()`, `AUTO_INCREMENT`, `ENGINE=InnoDB` |
| BigQuery | BigQuery SQL | `STRING`, `TIMESTAMP`, `GENERATE_UUID()`, no FK constraints |
| SQLite | SQLite | `TEXT`, `INTEGER PRIMARY KEY AUTOINCREMENT` |

Also generate the migration file (`migrate.sql`) with dialect-appropriate `IF NOT EXISTS` guards.

## Files to Change
- `src/pipeline/phase4/phases/schema-generator.ts` — add dialect detection and per-dialect SQL generation
- `src/pipeline/phase5-build/phases/integration-inferrer.ts` — export detected database type alongside ERP type

## Consequences
- SQL schemas match the user's actual database platform
- Migration scripts are runnable without manual dialect conversion
- PostgreSQL users get `TIMESTAMPTZ` instead of `SYSTIMESTAMP`
- Azure SQL users get `NVARCHAR` and `IDENTITY` instead of Oracle sequences
