# ADR-PRR-007: Decouple Seed Data Constants from Service Modules

## Status: IMPLEMENTED

## Date: 2026-04-10

## Priority: MEDIUM — Address during pilot

## Effort: 1 hour

## Context

Production readiness review (2026-04-10) found that `baseCarbonFootprint` and `regionalCarbonIntensity` maps from `src/data/seed.ts` are imported directly into service modules (`monte-carlo.ts`, `opportunity.ts`). This creates a hard dependency between business logic and test/demo data.

In production, these values will come from configuration, a database, or an external API (e.g., IEA regional emissions data). The current direct import prevents clean substitution.

## Decision

### 1. Define carbon data as a typed interface

```typescript
// In src/types.ts
export interface CarbonDataProvider {
  getBaseFootprint(category: DeviceCategory): number;
  getRegionalIntensity(region: Region): number;
}
```

### 2. Create a seed-data implementation

```typescript
// In src/data/seed.ts (existing, refactored)
import type { CarbonDataProvider } from '../types.js';

export const seedCarbonData: CarbonDataProvider = {
  getBaseFootprint(category) {
    return baseCarbonFootprint.get(category) ?? 300;
  },
  getRegionalIntensity(region) {
    return regionalCarbonIntensity.get(region) ?? 0.4;
  },
};
```

### 3. Inject via container

```typescript
// In src/container.ts
const carbonData: CarbonDataProvider = seedCarbonData; // swap for production source later

const monteCarloService = new MonteCarloService(config, logger, simulationId, carbonData);
const opportunityService = new OpportunityService(config, logger, simulationId, audit, carbonData);
```

### 4. Update service constructors

```typescript
// In MonteCarloService and OpportunityService
constructor(
  private readonly config: AppConfig,
  private readonly logger: Logger,
  private readonly simulationId: string,
  private readonly carbonData: CarbonDataProvider,  // ← NEW
) {}
```

## Consequences

### Positive
- Services have no dependency on seed data module
- Carbon data source is swappable (config, database, API) without touching business logic
- Tests can inject mock carbon data for edge cases
- Clean separation of concerns between demo data and domain logic

### Negative
- Additional interface and constructor parameter
- Seed data module needs a thin adapter wrapper

## Related ADRs
- ADR-PRR-001: Externalize Hardcoded Constants
- ADR-PRR-003: Document Carbon Calculation Assumptions
