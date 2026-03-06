# ADR-PIPELINE-008: ERP Client Class Name from Detected System

## Status
Implemented

## Context
Phase 4 `http-server-generator.ts` has a `resolveErpClientMeta()` function at line 316 that correctly maps ERP systems to client class names (e.g., `sap` → `SAPClient`, `dynamics` → `DynamicsClient`). However, the `tsRoutes()` function calls this and uses `erpMeta.className` in the generated `routes.ts`, but the **old static route code** that was merged into Phase 5/6 output still imports `NetSuiteClient` hardcoded at the top of `routes.ts`:

```typescript
import { NetSuiteClient } from '../erp-client/client.js';
```

In the `081f90a2` run (SAP S/4HANA airline), the generated `routes.ts` line 10 imports `NetSuiteClient` even though the ERP is SAP. The `resolveErpClientMeta()` mapping is never applied to the import statement or the client instantiation in the DI bootstrap section (lines 60-78).

The `erp-client/client.ts` file also hardcodes `class NetSuiteClient` regardless of detected ERP.

## Decision
The generated `routes.ts` must use the ERP client class name from `resolveErpClientMeta()`:

1. **Import statement**: `import { ${erpMeta.className} } from '../erp-client/client.js';`
2. **DI bootstrap**: Instantiate `new ${erpMeta.className}(...)` not `new NetSuiteClient(...)`
3. **erp-client/client.ts**: Generate the class with the correct name matching the detected ERP
4. **erp-client/types.ts**: Use ERP-specific type names in the domain transfer types

## Files to Change
- `src/pipeline/phase4/phases/http-server-generator.ts` — ensure `tsRoutes()` emits correct import and instantiation using `erpMeta.className`; ensure the `erp-client/client.ts` generator uses `erpMeta.className` for the exported class

## Consequences
- Generated `routes.ts` imports and instantiates the correct ERP client class
- `erp-client/client.ts` exports a class matching the detected ERP
- No more hardcoded `NetSuiteClient` when ERP is SAP, Dynamics, Oracle, etc.
