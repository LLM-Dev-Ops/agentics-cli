# ADR-PRR-001: Externalize Hardcoded Scoring and Simulation Constants

## Status: IMPLEMENTED

## Date: 2026-04-10

## Priority: HIGH — Address before pilot

## Effort: 2-3 hours

## Context

Production readiness review (2026-04-10) identified ~12 hardcoded magic numbers in `src/services/lifecycle-scoring.ts` and `src/services/monte-carlo.ts`. These constants are correct for the seed data prototype but prevent runtime tuning and produce incorrect results when applied to different fleet compositions.

### Identified Constants

| File | Constant | Hardcoded Value | Problem |
|---|---|---|---|
| `lifecycle-scoring.ts` | Max repair count normalization | `5` | Varies by device category — monitors rarely need repair vs. networking gear |
| `lifecycle-scoring.ts` | Age baseline years | category-specific (3/5/7) | Should be configurable per deployment |
| `monte-carlo.ts` | Cost volatility percentage | `0.15` (15%) | Should reflect actual procurement volatility data |
| `monte-carlo.ts` | Carbon savings percentage | `0.80` (80%) | Depends on specific manufacturer take-back programs |
| `monte-carlo.ts` | Confidence increment per iteration | `0.1` | Should be tunable for simulation precision |
| `monte-carlo.ts` | Productivity loss per failure | `200` (USD) | Varies dramatically by department (Trading vs. HR) |
| `monte-carlo.ts` | kWh per year per device | `150` | Varies by device category and usage pattern |
| `monte-carlo.ts` | Carbon intensity per kWh | `0.4` (kg CO2) | Varies by region and energy mix |
| `monte-carlo.ts` | Simulation iterations | `1000` | Should be configurable for quick estimates vs. precision |
| `monte-carlo.ts` | Support cost multiplier | varies by scenario | Should be externalized for scenario customization |
| `opportunity.ts` | Carbon normalization factor | `0.75` | Undocumented normalization step |
| `opportunity.ts` | Default useful life years | `4` | Should match fleet-specific lifecycle data |

## Decision

### 1. Extend AppConfig with Zod-validated scoring and simulation sections

```typescript
// In src/config.ts
const SimulationConfigSchema = z.object({
  iterations: z.number().int().min(100).max(100000).default(1000),
  costVolatilityPct: z.number().min(0).max(1).default(0.15),
  carbonSavingsPct: z.number().min(0).max(1).default(0.80),
  confidenceIncrement: z.number().min(0.01).max(0.5).default(0.1),
  productivityLossPerFailureUsd: z.number().min(0).default(200),
  kwhPerYearPerDevice: z.number().min(0).default(150),
  carbonIntensityKgPerKwh: z.number().min(0).default(0.4),
});

const ScoringConfigSchema = z.object({
  maxRepairCount: z.number().int().min(1).default(5),
  ageBaselineYears: z.object({
    laptop: z.number().default(4),
    monitor: z.number().default(7),
    networking: z.number().default(5),
  }),
  defaultUsefulLifeYears: z.number().default(4),
  carbonNormalizationFactor: z.number().default(0.75),
});
```

### 2. Inject via constructor (existing DI pattern)

Services already receive `AppConfig` via constructor injection. Extend the config object — no structural change needed.

### 3. Override via environment variables

Each constant maps to an environment variable with the same Zod default as the current hardcoded value, ensuring backward compatibility:

```bash
SCORING_MAX_REPAIR_COUNT=5
SCORING_AGE_BASELINE_LAPTOP=4
SIMULATION_ITERATIONS=1000
SIMULATION_COST_VOLATILITY_PCT=0.15
```

## Consequences

### Positive
- Fleet-specific tuning without code changes
- Same codebase supports different enterprise configurations
- Audit trail can record which config was active per simulation
- Zod validation catches invalid values at startup

### Negative
- More environment variables to document
- Existing tests need config fixtures updated (create `testSimulationConfig()` helper)

## Related ADRs
- ADR-071: Parameterize Hardcoded Domain Constants (same pattern, prior project)
- ADR-PRR-007: Decouple Seed Constants from Services
