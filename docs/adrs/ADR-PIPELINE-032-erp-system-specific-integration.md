# ADR-PIPELINE-032: ERP System-Specific Integration — Surface Analysis Must Match Detected System

**Status:** Accepted
**Date:** 2026-04-09
**Priority:** MEDIUM — ERP Readiness scores 4.5-6.5/10; surface analysis returns wrong ERP

## Context

The `agentics-erp_surface` tool returns generic SAP S/4HANA and Oracle Fusion Cloud configurations regardless of the actual ERP system detected in the user's query. In the sustainability test run:

- User specified: "managed through Workday ERP"
- ERP surface returned: SAP S/4HANA (731 endpoints) + Oracle Fusion Cloud (471 endpoints)
- Neither SAP nor Oracle was mentioned in the query

This mismatch was noted in every evaluation and erodes the credibility of the ERP integration story.

Additionally, generated code uses `Record<string, unknown>` for ERP payloads instead of typed interfaces specific to the detected system.

## Decision

### 1. Detect and Route to Correct ERP System

The pipeline must detect the ERP system from the query and route the erp_surface call accordingly:

| Query Signal | Detected System | API Style | Key Endpoints |
|---|---|---|---|
| workday | Workday | REST + RaaS | Worker, Expense Report, Custom Object |
| sap, s/4hana | SAP S/4HANA | OData + RFC | Business Partner, Purchase Order, Journal Entry |
| maximo, ibm | IBM Maximo | OSLC | Work Order, Asset, Service Request |
| coupa | Coupa | REST | Supplier, Purchase Order, Invoice, Contract |
| oracle, fusion | Oracle ERP Cloud | REST | Supplier, Procurement, AP Invoice |
| netsuite | NetSuite | SuiteTalk/REST | Vendor, Purchase Order, Custom Record |

### 2. Generated Code Must Use Typed ERP Payloads

Instead of `Record<string, unknown>`, generate typed interfaces:

```typescript
// For Coupa
interface CoupaSupplierActionPayload {
  supplier_id: string;
  action_type: 'packaging_standard_update' | 'supplier_scorecard_note';
  description: string;
  cost_impact_usd: number;
  effective_date: string;
  approval_status: string;
  created_by: string;
}

// For Workday
interface WorkdayCustomObjectPayload {
  worker_reference: string;
  custom_object_type: string;
  effective_date: string;
  fields: Record<string, string | number | boolean>;
}
```

### 3. ERP Connector Must Include Auth Configuration

Generated ERP connectors must include:
- Configuration interface with `baseUrl`, `apiVersion`, `clientId`
- Auth method appropriate for the system (OAuth2 for Workday/Coupa, X-CSRF + OAuth for SAP, Basic + OSLC for Maximo)
- Environment-based configuration (never hardcoded credentials)

### 4. Risk Assessment Must Reference Detected ERP

`generateDomainRisks()` must produce system-specific integration risks:
- Workday: RaaS rate limits, custom report field gaps, worker location inconsistencies
- SAP: OData field mapping differences between on-prem and cloud, CSRF complexity
- Maximo: OSLC version differences (7.x vs MAS 8.x), custom attribute definitions
- Coupa: Supplier API pagination, approval workflow integration, contract lifecycle

## Consequences

### Positive
- ERP Readiness score should increase from 4.5-6.5 to 7.0+
- Risk assessment becomes system-specific and actionable
- Generated code is closer to production-ready for the target system

### Negative
- Requires maintaining ERP-specific templates for 6+ systems
- erp_surface tool itself may need modification (or results need post-processing)

## Implementation

Files to modify:
- `src/synthesis/simulation-renderers.ts` — `generateDomainRisks()` ERP-specific risks
- `src/synthesis/simulation-artifact-generator.ts` — Pass detected system to erp_surface
- Code generation templates — Typed ERP payload interfaces per system
