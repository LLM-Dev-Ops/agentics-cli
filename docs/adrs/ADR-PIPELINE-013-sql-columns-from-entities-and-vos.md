# ADR-PIPELINE-013: SQL Table Columns from DDD Entities and Value Objects

## Status
Implemented

## Context
The schema generator (`phase4/phases/schema-generator.ts`) `buildFallbackTable()` function (line 445) generates SQL table columns from aggregate entities and value objects. It creates `${entity.name}_id` columns for entities and `${vo.name}` columns for VOs. It also pulls `cmd.input[]` fields from commands whose names match the aggregate.

However, in the `081f90a2` run, the `turnaround_delay` table has only generic columns:

```sql
CREATE COLUMN TABLE turnaround_delay (
  id NVARCHAR(64) NOT NULL PRIMARY KEY,
  turnaround_delay_id NVARCHAR(64),
  status NVARCHAR(64) NOT NULL,
  version INTEGER NOT NULL,
  correlation_id NVARCHAR(64),
  created_by NVARCHAR(128) NOT NULL,
  updated_by NVARCHAR(128) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_UTCTIMESTAMP NOT NULL,
  updated_at TIMESTAMP DEFAULT CURRENT_UTCTIMESTAMP NOT NULL
);
```

Missing: `flight_number`, `gate_id`, `estimated_delay_minutes`, `actual_turnaround_minutes`, `delay_cause`, etc. The command name matching filter (`cmdLower.includes(aggLower)`) fails because the command name `EarlyOperationalSignalsThatATurnaroundDelayIsLikelyToOccur` doesn't match the aggregate name `TurnaroundDelayAggregate` in a simple substring check. Also, entity/VO fields (not just names) should become columns.

## Decision
Improve SQL column generation to produce domain-meaningful tables:

1. **Entity fields as columns**: For each entity in the aggregate, generate columns from the entity's description keywords and common field patterns (not just `entity_id`)
2. **Value object properties as columns**: VOs should expand into their constituent fields (e.g., `Address` → `street`, `city`, `zip`)
3. **Relaxed command matching**: Match commands to aggregates using normalized slugs, shared keywords, or bounded context association (all commands in a context map to all aggregates in that context)
4. **Query return fields as columns**: Parse `query.returns` for field names to include as table columns
5. **Domain event payload fields**: Event `payload[]` entries should map to columns (they represent state that must be persisted)

## Files to Change
- `src/pipeline/phase4/phases/schema-generator.ts` — update `buildFallbackTable()` to use relaxed command matching, entity field expansion, VO property expansion, and event payload fields as column sources

## Consequences
- SQL tables have domain-specific columns reflecting the bounded context's actual data model
- Tables include fields for entity attributes, VO properties, command inputs, and event payloads
- No more generic-only tables with just `id`, `status`, `version`, and audit columns
