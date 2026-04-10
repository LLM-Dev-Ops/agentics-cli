# ADR-PIPELINE-058: ERP Surface Targeting — Archibus-Specific Detection and Schema Versioning

**Status:** Accepted
**Date:** 2026-04-10
**Priority:** HIGH — ERP Readiness scored 6.5/10, lowest category
**Originating Review:** Production Readiness Review (2026-04-10), ERP Readiness 6.5/10
**Builds on:** ADR-PIPELINE-050 (ERP Readiness 9/10)

## Context

The ERP surface analysis returned SAP S/4HANA integration mappings (GL Account, Journal Entry, Purchase Order), but the prototype targets **Archibus** — a facilities management ERP, not a financial ERP. This mismatch means the surfaced integration points don't correspond to the Archibus schema the code actually implements.

The root cause: the ERP surface agent matches broadly on "ERP" keywords and defaults to SAP when the system is not in its primary detection list. Archibus is a domain-specific IWMS (Integrated Workplace Management System), not a Tier 1 financial ERP.

Additionally, `ADR-PIPELINE-050` required schema versioning for ERP adapters, but the current `ERPAdapter` does not implement schema version negotiation. When Archibus upgrades (e.g., from v25 to v26), field names or data types may change, and the adapter has no mechanism to detect or handle this.

### Two Distinct Issues

1. **Detection**: The pipeline's ERP surface agent must recognize Archibus and return Archibus-specific integration points (not SAP's)
2. **Versioning**: The adapter must handle schema evolution gracefully

## Decision

### 1. Archibus-Specific ERP Surface Detection

```
RULE: The ERP surface agent MUST include Archibus in its detection
vocabulary:

Archibus keywords: "Archibus", "IWMS", "space management",
  "facilities management", "room allocation", "bl_id", "fl_id"

When Archibus is detected, surface these integration points:
- Activity Log (afm_activity_log) — decision recording
- Space Allocation (rm) — zone/room assignment updates
- Work Request (wr) — maintenance scheduling
- Building Operations (bl) — energy/occupancy aggregation
- Data Source API (afm/datasource) — programmatic CRUD

Do NOT surface SAP-specific endpoints (GL Account, Purchase Order,
Journal Entry) for an Archibus deployment. These are meaningless
in the Archibus context and signal that the surface analysis
doesn't understand the target system.
```

### 2. Schema Version Negotiation

```
RULE: The ERPAdapter MUST include schema versioning:

1. Declare supported schema version(s) in the adapter:
   static readonly SUPPORTED_SCHEMA_VERSIONS = ['25.1', '25.2', '26.0'];

2. On first connection (or health check), query the Archibus
   instance for its schema version:
   GET /api/v1/system/version → { version: '25.2', schema: '25.2.0' }

3. If the remote schema version is not in SUPPORTED_SCHEMA_VERSIONS:
   - Log a warning with both versions
   - If major version differs: throw SchemaVersionError (hard stop)
   - If minor version differs: proceed with warning (field additions
     are typically backward-compatible)

4. Include schema version in every ERP transaction record:
   { ...transaction, schemaVersion: '25.2.0' }

This enables post-incident analysis: "These records were written
against schema 25.2, but the ERP was upgraded to 26.0 on Tuesday."
```

### 3. Sandbox Validation Before Pilot

```
RULE: Before pilot deployment, the ERPAdapter MUST be validated
against an Archibus sandbox instance (not just simulated success):

Validation checklist:
- [ ] Write a decision record to afm_activity_log → verify it appears
- [ ] Read back the record → verify field mapping correctness
- [ ] Write with duplicate idempotency key → verify no duplicate created
- [ ] Write with circuit breaker open → verify graceful failure
- [ ] Query schema version → verify detection works

If no Archibus sandbox is available, at minimum:
- Validate the request payload against the Archibus REST API
  OpenAPI spec (if available)
- Implement a response schema validator that checks the shape
  of simulated responses matches documented Archibus responses
```

## Implementation

### In ERP Surface Agent

Add Archibus to the ERP detection map with correct integration endpoints. Filter results to only show endpoints relevant to the detected system.

### In `src/erp/adapter.ts`

1. Add `SUPPORTED_SCHEMA_VERSIONS` static field
2. Add `negotiateSchemaVersion()` method called during circuit breaker health check
3. Include `schemaVersion` in `ERPTransaction` type and all write payloads

### In `src/erp/schema.ts`

Add version-aware field mapping:
```typescript
const FIELD_MAPS: Record<string, FieldMap> = {
  '25.1': { /* original mappings */ },
  '25.2': { /* same as 25.1 for this prototype */ },
  '26.0': { /* future: handle renamed fields */ },
};
```

## Validation

- [ ] ERP surface agent returns Archibus-specific endpoints when "Archibus" is mentioned
- [ ] ERP surface agent does NOT return SAP endpoints for Archibus queries
- [ ] ERPAdapter includes schema version in transaction records
- [ ] Schema version mismatch (major) throws clear error at startup
- [ ] Schema version mismatch (minor) logs warning but proceeds

## Consequences

- Eliminates the most visible ERP credibility gap (wrong system's endpoints)
- Provides forward-compatibility mechanism for Archibus upgrades
- Enables post-incident schema version forensics
- Moves ERP Readiness from 6.5 toward 8.5/10
