# ADR-PIPELINE-001: ERP Detection Expansion

## Status
Implemented

## Context
The ERP detection system in `src/pipeline/phase5-build/phases/integration-inferrer.ts` only recognizes SAP S/4HANA, Oracle/NetSuite, and Microsoft Dynamics. When a user mentions Deltek Costpoint, Infor CloudSuite, Guidewire, Epicor, Workday, or other ERP systems, the detector falls back to `sap-s4hana` — producing wrong API patterns (SAP OData `API_*_SRV` instead of Deltek REST, Infor ION, etc.), wrong SQL dialects, and wrong ERP client classes throughout the generated prototype.

In the `2c1a2192` run, the user explicitly said "Deltek Costpoint" but the pipeline produced SAP OData endpoints (`API_FINANCIAL_OPS_SRV`) and instantiated a `NetSuiteClient`.

## Decision
Expand the ERP detection lookup table to recognize at least these systems:

| ERP System | Detection Keywords | API Pattern | SQL Dialect |
|---|---|---|---|
| SAP S/4HANA | sap, s4hana, s/4 | OData `API_*_SRV` | HANA SQL |
| Oracle NetSuite | netsuite, oracle erp | REST `/fscmRestApi/resources/latest/*` | Oracle PL/SQL |
| Microsoft Dynamics 365 | dynamics, d365, dynamics 365 | OData `/api/data/v9.2/*` | T-SQL |
| Deltek Costpoint | deltek, costpoint | REST `/api/costpoint/v1/*` | T-SQL (Azure SQL) |
| Infor CloudSuite | infor, cloudsuite, m3 | ION API `/IONAPI/*` | PostgreSQL / DB2 |
| Epicor Kinetic | epicor, kinetic | REST `/api/v2/odata/*` | T-SQL |
| Workday | workday | REST `/ccx/api/v1/*` | N/A (SaaS) |
| Guidewire | guidewire, claimcenter, policycenter | REST `/rest/v1/*` | PostgreSQL |
| IFS | ifs, ifs cloud | REST `/api/v1/*` | Oracle / PostgreSQL |
| Sage Intacct | sage, intacct | REST `/api/v21/*` | N/A (SaaS) |

## Files to Change
- `src/pipeline/phase5-build/phases/integration-inferrer.ts` — expand ERP keyword → system mapping
- `src/pipeline/phase4/phases/http-server-generator.ts` — ERP client class selection based on detected system
- `src/pipeline/phase6/erp-surface-builder.ts` (or equivalent) — endpoint pattern generation per ERP

## Consequences
- Pipeline correctly identifies 10+ ERP systems instead of 3
- Generated ERP client, API patterns, and SQL dialect match the user's actual ERP
- Phase 6 ERP surface mapping produces correct endpoints
