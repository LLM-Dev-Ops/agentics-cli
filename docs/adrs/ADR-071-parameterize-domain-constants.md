# ADR-071: Parameterize Hardcoded Domain Constants

## Status: IMPLEMENTED

## Date: 2026-03-31

## Context

Production readiness audit (2026-03-31) found hardcoded domain-specific constants across both TypeScript and Rust codebases. These constants were appropriate for the prototype with synthetic seed data, but will produce incorrect results when real supplier data, insurance contracts, and climate projections are loaded.

### Identified Constants

| File | Constant | Value | Problem |
|---|---|---|---|
| `scenario-orchestrator.ts` | Per-supplier insurance coverage | `5_000_000` | Real coverage varies per contract ($1M-$50M+) |
| `optimizer-engine/src/optimizer.rs:6` | Cost normalization factor | `10_000_000.0` | Doesn't scale — $10M normalization for a $3.2B project site distorts scoring |
| `optimizer-engine/src/optimizer.rs` | Upgrade strategy multiplier | `0.60` (40% reduction) | Should reflect actual supplier capability assessments |
| `optimizer-engine/src/optimizer.rs` | Replacement strategy multiplier | `0.30` (70% reduction) | Depends on alternative supplier availability |
| `optimizer-engine/src/optimizer.rs` | Dual-source strategy multiplier | `0.80` (20% reduction) | Varies by commodity type and market |
| `climate-risk-service.ts` | Probability cap | `0.95` | May need adjustment per regulatory framework |
| `insurance-cost-service.ts` | Recommendation thresholds | `CRITICAL > 50%, WARNING > 30%` etc. | Should align with company risk appetite |
| `mapper.ts` | Subsidiary ID | `'1'` (hardcoded 3 times) | Multi-entity Oracle deployments need different IDs |

## Decision

### 1. Create a typed configuration object

```typescript
// src/config/domain-config.ts
export interface ClimateRiskConfig {
  /** Maximum probability value for risk calculations */
  probabilityCap: number;
  /** Per-supplier default insurance coverage (USD) when contract data unavailable */
  defaultInsuranceCoverage: number;
  /** Recommendation severity thresholds (percentage of premium increase) */
  thresholds: {
    critical: number;
    warning: number;
    attention: number;
  };
}

export interface OptimizationConfig {
  /** Normalization divisor for cost scoring — should approximate max expected cost */
  costNormalizationFactor: number;
  /** Strategy effectiveness multipliers (0.0 = eliminates risk, 1.0 = no effect) */
  strategyMultipliers: {
    upgrade: number;
    replacement: number;
    dualSource: number;
  };
}

export interface ErpConfig {
  /** Oracle Fusion Cloud subsidiary ID for the target business unit */
  subsidiaryId: string;
  /** Read-only mode — disables all writeback even with approvals */
  readOnly: boolean;
}

export interface DomainConfig {
  climateRisk: ClimateRiskConfig;
  optimization: OptimizationConfig;
  erp: ErpConfig;
}
```

### 2. Load from environment with validated defaults

```typescript
export function loadDomainConfig(): DomainConfig {
  return {
    climateRisk: {
      probabilityCap: parseFloat(process.env.CLIMATE_PROBABILITY_CAP ?? '0.95'),
      defaultInsuranceCoverage: parseFloat(process.env.CLIMATE_DEFAULT_COVERAGE ?? '5000000'),
      thresholds: {
        critical: parseFloat(process.env.CLIMATE_THRESHOLD_CRITICAL ?? '0.50'),
        warning: parseFloat(process.env.CLIMATE_THRESHOLD_WARNING ?? '0.30'),
        attention: parseFloat(process.env.CLIMATE_THRESHOLD_ATTENTION ?? '0.15'),
      },
    },
    optimization: {
      costNormalizationFactor: parseFloat(process.env.OPT_COST_NORM_FACTOR ?? '10000000'),
      strategyMultipliers: {
        upgrade: parseFloat(process.env.OPT_STRATEGY_UPGRADE ?? '0.60'),
        replacement: parseFloat(process.env.OPT_STRATEGY_REPLACEMENT ?? '0.30'),
        dualSource: parseFloat(process.env.OPT_STRATEGY_DUAL_SOURCE ?? '0.80'),
      },
    },
    erp: {
      subsidiaryId: process.env.ORACLE_SUBSIDIARY_ID ?? '1',
      readOnly: process.env.ORACLE_READ_ONLY !== 'false',
    },
  };
}
```

### 3. Pass config through Rust subprocess via JSON

The TypeScript orchestrator already communicates with the Rust engine via JSON over stdin/stdout. Add a `config` field to the input payload:

```rust
#[derive(Deserialize)]
struct OptimizationInput {
    suppliers: Vec<Supplier>,
    config: OptimizationConfig,
}

#[derive(Deserialize)]
struct OptimizationConfig {
    cost_normalization_factor: f64,
    strategy_multipliers: StrategyMultipliers,
}
```

This eliminates all hardcoded constants from the Rust engine.

### 4. Inject config via dependency injection

```typescript
// In createDependencies()
const domainConfig = loadDomainConfig();

const climateRiskService = new ClimateRiskService(domainConfig.climateRisk);
const insuranceCostService = new InsuranceCostService(domainConfig.climateRisk);
const scenarioOrchestrator = new ScenarioOrchestrator(
  climateRiskService,
  insuranceCostService,
  domainConfig
);
const oracleAcl = new OracleACL(domainConfig.erp);
```

## Consequences

### Positive
- System produces correct results with real supplier data at any scale
- Configuration is validated at startup — bad values fail fast
- Same codebase supports multiple business units with different risk appetites
- Audit trail captures which config was active during each simulation run (add to inputHash)

### Negative
- More environment variables to manage — document in deployment runbook
- Existing tests need config fixtures — create a `testDomainConfig()` helper with current defaults
- Slight increase in JSON payload size for Rust subprocess communication

## Implementation Priority

**MEDIUM — Days 3-4 of pilot preparation.** Estimated effort: 4-6 hours. The current hardcoded values are correct for the seed data, so this is not a blocker for initial pilot with synthetic data. Must be completed before loading real supplier data.

## Related ADRs
- ADR-067: LLM-Driven Code Generation (identified hardcoded subsidiary ID as a template bug)
- ADR-043: Rust and Multi-Language Support
