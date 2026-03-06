# ADR-PIPELINE-014: Database Dialect Override When Prompt Mentions Explicit Database

## Status
Implemented

## Context
ADR-006 added `detectDatabaseFromText()` in `erp-database-map.ts` to scan text for explicit database keywords (PostgreSQL, MySQL, BigQuery, etc.) and override the ERP-inferred dialect. The `erp-target-resolver.ts` runs this scan at Step 5b after ERP resolution.

However, in the `081f90a2` run, the user's prompt explicitly states:

> "our operational analytics and flight operations data is stored in Amazon Redshift and PostgreSQL"

Yet the generated SQL uses `hana-sql` dialect (`CREATE COLUMN TABLE`, `NVARCHAR`, `CURRENT_UTCTIMESTAMP`). The ERP detection correctly finds `sap-s4hana`, which maps to `hana-sql` — but the explicit PostgreSQL mention should have overridden this.

The issue is that `detectDatabaseFromText()` returns matches but the override logic may not be triggering because:
1. The scan sources include `scenarioQuery` but the text matching might fail on case or word boundaries
2. The detection result might be returned but never applied to the final dialect
3. When multiple databases are mentioned (Redshift AND PostgreSQL), the first match might not be the right one to use for SQL schema generation

## Decision
Fix the database dialect override to reliably catch explicit database mentions:

1. **Priority ordering**: When multiple databases are detected, prioritize the primary transactional database (PostgreSQL > Redshift > BigQuery) for schema generation
2. **Case-insensitive matching**: Ensure `detectDatabaseFromText()` is case-insensitive for all patterns
3. **Verify the override is applied**: Add telemetry span attributes logging the pre-override and post-override dialects so the override path is visible
4. **Separate analytics from transactional**: When Redshift/BigQuery are detected alongside PostgreSQL/MySQL, use the transactional DB for schema DDL and note the analytics DB for read-model schemas
5. **Test with the exact prompt text**: The scanning must match `"PostgreSQL"` and `"Redshift"` as they appear in natural language prompts

## Files to Change
- `src/deps/erp-database-map.ts` — verify `detectDatabaseFromText()` handles case variations and natural language phrasing; add priority ranking for transactional vs analytics databases
- `src/pipeline/phase4/phases/erp-target-resolver.ts` — verify the override at Step 5b actually applies to `resolvedDialect`; add telemetry for override tracing; handle multi-database scenarios

## Consequences
- When a user explicitly mentions PostgreSQL, the SQL schemas use PostgreSQL dialect regardless of ERP
- Redshift/BigQuery are identified as analytics databases, not used for transactional DDL
- The override path is traceable via telemetry spans
- ERP-inferred dialect is only used when no explicit database is mentioned
