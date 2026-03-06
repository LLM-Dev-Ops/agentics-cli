# ADR-PIPELINE-007: Phase 6 ERP Surface Mapping from Detected ERP System

## Status
Implemented

## Context
Phase 6 generates ERP surface mappings (`erp-surface-mapping.json`, `registration.json`) that map internal API endpoints to ERP service endpoints. Currently it always uses SAP OData patterns (`API_FINANCIAL_OPS_SRV`, `API_CONTRACT_SRV`) regardless of the detected ERP system.

In the `2c1a2192` run (Deltek Costpoint), Phase 6 produced:
```json
{ "erp_service": "API_FINANCIAL_OPS_SRV" }
```
Instead of Deltek Costpoint's actual API pattern:
```json
{ "erp_service": "/api/costpoint/v1/financials/invoices" }
```

The ERP client class instantiated in routes.ts is also always `NetSuiteClient`, even for non-NetSuite scenarios.

## Decision
Phase 6 ERP surface mapping must use the ERP system detected in Phase 5 (via ADR-PIPELINE-001) to generate correct:

1. **ERP service endpoint patterns** per the detected system's API convention
2. **ERP client class name** matching the detected system (e.g., `DeltekClient`, `DynamicsClient`, `InforClient`)
3. **Authentication scheme** per ERP (OAuth2, certificate-based, API key, SAML)
4. **Deploy scripts** with correct environment variables for the detected ERP

The mapping should flow: Phase 5 detects ERP → writes to `phase5-manifest.json` → Phase 6 reads it → generates matching surface mapping.

## Files to Change
- `src/pipeline/phase6/` (or equivalent Phase 6 code) — read `erp_system` from phase5-manifest and generate matching endpoint patterns
- `src/pipeline/phase4/phases/http-server-generator.ts` — generate ERP client class matching detected system, not always `NetSuiteClient`

## Consequences
- Phase 6 ERP surface mapping matches the actual ERP system
- Generated deploy scripts have correct ERP-specific environment variables
- ERP client class in routes.ts matches the scenario
- Registration endpoint patterns are correct for the target ERP's API
