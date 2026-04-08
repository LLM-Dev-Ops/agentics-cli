# ADR-PIPELINE-021: Code Generation Quality — Typed Entities, Compilable Tests, Domain-Aware Ports

**Status:** Accepted
**Date:** 2026-04-08
**Priority:** CRITICAL — Generated code must compile and pass tests

## Context

The Phase 3-6 code generation pipeline produces TypeScript code that has three systemic quality issues:

### Issue 1: Generic Entity Fields (`Record<string, unknown>`)

`src/pipeline/phase3/phases/domain-codegen.ts` line 607-610:
```typescript
if (fields.length === 0) {
  const entitySlug = toCamelCase(entityName);
  fields.push({ name: `${entitySlug}Data`, type: 'Record<string, unknown>' });
}
```

When `extractFieldsFromDescription()` finds no matching patterns in the entity description, it falls back to `Record<string, unknown>`. This produces entities like:
```typescript
export class Properties {
  constructor(readonly id: string, readonly propertiesData: Record<string, unknown>) {}
}
```

The pattern list (lines 566-597) covers sustainability/environmental domains but misses:
- **Retail/grocery**: product, SKU, shelf life, expiry date, UPC, category, supplier, store, aisle, perishable
- **Real estate**: property, building, tenant, lease, square footage, EUI, HVAC, occupancy
- **Manufacturing**: work order, BOM, lot, batch, yield, defect rate, machine, production line
- **Financial**: invoice, payment, GL account, journal entry, period, ledger, reconciliation
- **Healthcare**: patient, encounter, diagnosis, procedure, prescription, provider
- **Supply chain**: shipment, carrier, warehouse, pick, pack, route, dock, pallet

### Issue 2: Non-Compiling Tests

Generated integration tests reference undefined functions or import from wrong paths. Unit tests assert mock passthrough (tautological — testing that a mock returns what the mock was set to return). Specific patterns:

- Integration tests import `../infra/telemetry.js` but the relative path doesn't resolve from `__tests__/integration/`
- Schema exports are duplicated when multiple domain-entity bounded contexts exist (ManageDomainEntitySchema declared 3x)
- `handlers/analyze.ts` imports `AnalyzeOptions` from `types.ts` but the type doesn't exist
- `commands/analyze.ts` imports `commander` which isn't in `package.json`

### Issue 3: Generic Port Interfaces

Port interfaces use `Record<string, unknown>` for inputs:
```typescript
interface WastePort {
  listWaste(input: Record<string, unknown>): Promise<Waste[]>;
}
```
Then adapters cast with `as unknown as Waste[]`, losing all type safety at the domain boundary.

### Issue 4: Template Bleed in Generated ADRs

LLM-generated ADRs sometimes contain language from previous domain templates. ADR-004 referenced "gCO2/ton-km per transport mode" in a real estate context. ADR-005 described "express/standard/economy priority levels" for a building upgrade system.

## Decision

### 1. Expand `extractFieldsFromDescription()` pattern list

Add domain-specific field patterns for 6 additional industry verticals:

**Retail/Grocery:**
```typescript
{ regex: /\b(?:product|sku|item|merchandise)\b/i, field: 'productId', type: 'string' },
{ regex: /\b(?:shelf[- ]?life|expir|best[- ]?before|use[- ]?by)\b/i, field: 'expiryDate', type: 'Date' },
{ regex: /\b(?:upc|barcode|ean|gtin)\b/i, field: 'upc', type: 'string' },
{ regex: /\b(?:store|branch|outlet|location)\b/i, field: 'storeId', type: 'string' },
{ regex: /\b(?:aisle|shelf|bin|slot)\b/i, field: 'shelfLocation', type: 'string' },
{ regex: /\b(?:perishab|fresh|frozen|chilled)\b/i, field: 'isPerishable', type: 'boolean' },
{ regex: /\b(?:supplier|vendor|manufacturer)\b/i, field: 'supplierId', type: 'string' },
{ regex: /\b(?:discount|markdown|promotion|clearance)\b/i, field: 'discountPct', type: 'number' },
{ regex: /\b(?:demand|forecast|predict)\b/i, field: 'forecastedDemand', type: 'number' },
{ regex: /\b(?:inventory|stock|on[- ]?hand)\b/i, field: 'quantityOnHand', type: 'number' },
{ regex: /\b(?:reorder|replenish|safety[- ]?stock)\b/i, field: 'reorderPoint', type: 'number' },
```

**Real Estate:**
```typescript
{ regex: /\b(?:property|building|asset)\b/i, field: 'propertyId', type: 'string' },
{ regex: /\b(?:tenant|lessee|occupant)\b/i, field: 'tenantId', type: 'string' },
{ regex: /\b(?:lease|rental|tenancy)\b/i, field: 'leaseId', type: 'string' },
{ regex: /\b(?:square[- ]?f(?:oo|ee)t|sqft|area|floor[- ]?space)\b/i, field: 'squareFootage', type: 'number' },
{ regex: /\b(?:eui|energy[- ]?use[- ]?intensity)\b/i, field: 'energyUseIntensity', type: 'number' },
{ regex: /\b(?:hvac|heating|cooling|ventilation)\b/i, field: 'hvacType', type: 'string' },
{ regex: /\b(?:occupan|vacancy)\b/i, field: 'occupancyPct', type: 'number' },
{ regex: /\b(?:year[- ]?built|construction[- ]?year|age)\b/i, field: 'yearBuilt', type: 'number' },
{ regex: /\b(?:region|market|metro|geography)\b/i, field: 'region', type: 'string' },
{ regex: /\b(?:upgrade|retrofit|improvement|renovation)\b/i, field: 'upgradeType', type: 'string' },
```

**Manufacturing, Financial, Healthcare, Supply Chain:** Similar expansions.

### 2. Improve fallback when no patterns match

Replace the `Record<string, unknown>` fallback at line 607-610 with a **DDD-aware fallback** that uses the bounded context's aggregate and entity metadata:

```typescript
if (fields.length === 0) {
  // Use DDD context metadata to generate domain-aware fields
  fields = generateFieldsFromDDDContext(entityName, ctx);
}
```

Where `generateFieldsFromDDDContext()` uses:
- The aggregate's invariants to infer constraint fields
- The bounded context's domain events to infer state fields
- The bounded context's commands to infer input fields
- The entity's description keywords (split and match individually, not as a phrase)

### 3. Fix test generation

In the test generators (Phase 3 TDD, Phase 4 test generation):
- Use correct relative import paths based on actual output directory structure
- Deduplicate schema exports by prefixing with bounded context name
- Generate tests that assert domain behavior, not mock passthrough
- Validate `package.json` dependencies exist for all imports

### 4. Type port interfaces

Replace `Record<string, unknown>` in port method signatures with the actual entity/VO types from the DDD model:
```typescript
// Before
listWaste(input: Record<string, unknown>): Promise<Waste[]>;
// After
listWaste(filter: { storeId?: string; status?: string; limit?: number }): Promise<Waste[]>;
```

### 5. Pass domain context to LLM ADR generation

Include the detected domain type (retail, real estate, manufacturing, etc.) in the LLM prompt to prevent cross-domain template bleed:
```
IMPORTANT: This project is in the ${detectedDomain} domain.
Do NOT reference concepts from other domains (logistics, transport, delivery tiers).
All examples, metrics, and terminology must be ${detectedDomain}-specific.
```

## Files to Change

- `src/pipeline/phase3/phases/domain-codegen.ts` — Expand field patterns, DDD-aware fallback, typed ports
- `src/pipeline/phase3/phases/test-codegen.ts` — Fix import paths, deduplicate schemas, domain-aware assertions
- `src/pipeline/phase4/phases/http-server-generator.ts` — Fix schema deduplication, iam-helper template literal
- `src/pipeline/phase2/phases/adr-generator.ts` — Pass domain context to LLM prompt

## Consequences

- [+] Entities have typed domain fields instead of `Record<string, unknown>` for all major industry verticals
- [+] Generated code compiles without manual fixes
- [+] Tests assert real domain behavior, not mock passthrough
- [+] Port interfaces are type-safe
- [-] Pattern list grows to ~80 patterns — consider grouping by vertical and lazy-loading
- [-] New field patterns may produce false positives for ambiguous terms
