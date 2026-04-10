# ADR-PRR-013: Validate Seed Data Against Zod Schemas on Load

## Status: PROPOSED

## Date: 2026-04-10

## Priority: LOW — Address before full deployment

## Effort: 30 minutes

## Context

Production readiness review (2026-04-10) noted that seed data in `src/data/seed.ts` is typed via TypeScript's `satisfies` or explicit type annotations, but is not validated at runtime through the Zod schemas defined in `src/types.ts`.

If seed data drifts from the schema (e.g., a new required field is added to `DeviceSchema` but not to every seed device), TypeScript will catch it at compile time — but only if strict mode is correctly configured. Runtime validation provides defense-in-depth and catches issues that survive compilation (e.g., invalid enum values constructed via string concatenation, NaN from arithmetic, dates in wrong format).

This matters more when seed data is replaced with data loaded from files or APIs during the pilot.

## Decision

### 1. Validate seed arrays at module load time

```typescript
// At the bottom of src/data/seed.ts
import { DeviceSchema, DeviceTelemetrySchema, RefreshScenarioSchema } from '../types.js';
import { z } from 'zod';

// Validate all seed data against schemas — fails fast on import if data drifts
const validatedDevices = z.array(DeviceSchema).parse(seedDevices);
const validatedTelemetry = z.array(DeviceTelemetrySchema).parse(seedTelemetry);
const validatedScenarios = z.array(RefreshScenarioSchema).parse(seedScenarios);

// Re-export validated arrays (type-narrowed by Zod)
export { validatedDevices as seedDevices, validatedTelemetry as seedTelemetry, validatedScenarios as seedScenarios };
```

### 2. Alternative: Validate on first access (lazy)

If module load time cost is a concern (unlikely for 20 records):

```typescript
let _validated = false;
export function getSeedDevices(): Device[] {
  if (!_validated) {
    z.array(DeviceSchema).parse(seedDevices);
    _validated = true;
  }
  return seedDevices;
}
```

### 3. Extend to production data loading

When seed data is replaced with data from files or APIs, the same Zod schemas serve as the validation layer:

```typescript
// Future: load from JSON file or API response
const rawDevices = JSON.parse(await readFile('devices.json', 'utf-8'));
const devices = z.array(DeviceSchema).parse(rawDevices); // throws ZodError on invalid data
```

## Consequences

### Positive
- Catches data/schema drift at startup rather than during scoring or simulation
- Zod error messages pinpoint exactly which field on which record is invalid
- Same validation path works for both seed data and production data
- Defense-in-depth — doesn't rely solely on TypeScript compilation

### Negative
- Small startup overhead (parsing 20 records — negligible)
- Module re-export pattern requires updating import paths if using the validated export approach
- Circular dependency risk if schemas import from seed and seed imports from schemas — keep schemas in `types.ts` only

## Related ADRs
- ADR-PRR-001: Externalize Hardcoded Constants (new config values also need Zod validation)
- ADR-064: Schema Validation and Filter Parsing
