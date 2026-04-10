import { z } from 'zod';
import { createLogger } from './logger.js';

const logger = createLogger('config');

// ADR-PRR-001: Per-sqft cost rates used in scenario savings calculations
// ADR-PRR-003: Source citations for financial audit trail
//
// energyPerSqFtYear: $4.50/sqft/year — US commercial office average.
//   Source: EIA CBECS 2022, Table E1 (electricity expenditure per sqft).
//   Range: $2.50–$7.00 depending on climate zone. Seed data zones carry
//   per-zone energyCostPerSqFtYear for future per-zone override.
//
// maintenancePerSqFtYear: $1.80/sqft/year — janitorial + routine repairs.
//   Source: BOMA (2023) "Experience Exchange Report" — office maintenance
//   benchmark, US average. Excludes capital improvements.
//
// hvacPerSqFtYear: $2.20/sqft/year — heating, ventilation, air conditioning.
//   Source: ASHRAE (2023) "HVAC Applications Handbook" — typical office
//   operating cost. Higher in tropical climates (Singapore: ~$3.00).
//
// leasePerSqFtYear: $6.00/sqft/year — blended Class A/B office lease rate
//   normalized to the recapturable share. Actual lease rates vary widely
//   ($20–$80/sqft gross); this represents the marginal cost that can be
//   recaptured by subleasing or returning decommissioned space.
const CostRatesSchema = z.object({
  energyPerSqFtYear: z.coerce.number().min(0).default(4.50),
  maintenancePerSqFtYear: z.coerce.number().min(0).default(1.80),
  hvacPerSqFtYear: z.coerce.number().min(0).default(2.20),
  leasePerSqFtYear: z.coerce.number().min(0).default(6.00),
}).default({});

// ADR-PRR-001: Scenario-specific reduction factors and caps
const ScenarioParamsSchema = z.object({
  // Consolidation
  consolidationLeaseRecapturePct: z.coerce.number().min(0).max(1).default(0.30),
  consolidationOccupancyMultiplier: z.coerce.number().min(1).default(1.6),
  consolidationOccupancyCap: z.coerce.number().min(0).max(1).default(0.85),
  // Schedule optimization
  scheduleEnergyReductionPct: z.coerce.number().min(0).max(1).default(0.25),
  scheduleMaintenanceReductionPct: z.coerce.number().min(0).max(1).default(0.15),
  scheduleHvacReductionPct: z.coerce.number().min(0).max(1).default(0.35),
  scheduleOccupancyMultiplier: z.coerce.number().min(1).default(1.3),
  scheduleOccupancyCap: z.coerce.number().min(0).max(1).default(0.75),
  // Space reduction
  spaceReductionFactor: z.coerce.number().min(0).max(1).default(0.40),
  spaceReductionLeaseRecapturePct: z.coerce.number().min(0).max(1).default(0.60),
  spaceReductionOccupancyCap: z.coerce.number().min(0).max(1).default(0.90),
}).default({});

// ADR-PRR-001: Environmental conversion factors
// ADR-PRR-003: Source citations for ESG audit trail
//
// kwhPerSqFtYear: 22 kWh/sqft/year for commercial office space.
//   Source: EIA (2022) Commercial Buildings Energy Consumption Survey (CBECS),
//   Table C1 — electricity intensity for office buildings, US average.
//   Range: 15-30 kWh/sqft depending on climate zone and HVAC type.
//   Corroborated by ENERGY STAR Portfolio Manager benchmarking data.
//
// co2TonnesPerKwh: 0.000277 tonnes CO2/kWh (= 0.277 kg CO2/kWh).
//   Source: IEA (2023) "Emissions Factors" — OECD weighted average for
//   purchased electricity. Equivalent to EPA eGRID 2022 US national average
//   (0.2888 kg CO2/kWh, rounded to account for non-US grid mix).
//   Regional variation: NA ~0.25, EU ~0.23, Asia ~0.50 kg/kWh.
//   For region-specific analysis, override via ENV_CO2_TONNES_PER_KWH.
const EnvironmentalSchema = z.object({
  kwhPerSqFtYear: z.coerce.number().min(0).default(22),
  co2TonnesPerKwh: z.coerce.number().min(0).default(0.000277),
}).default({});

// ADR-PRR-001: Sensitivity analysis parameters
const SensitivityParamsSchema = z.object({
  energyPriceRangePct: z.coerce.number().min(0).max(1).default(0.15),
  occupancyCoverageImpactPct: z.coerce.number().min(0).max(1).default(0.20),
  hybridAdoptionImpactPct: z.coerce.number().min(0).max(1).default(0.25),
  timelineImpactMonths: z.coerce.number().int().min(0).default(3),
  leaseUpsideFactor: z.coerce.number().min(0).default(0.50),
  scopeTargetBuildings: z.coerce.number().int().min(1).default(8),
  scopeNetworkBonusPct: z.coerce.number().min(0).max(1).default(0.15),
  directionalFloorFactor: z.coerce.number().min(0).max(1).default(0.80),
  directionalConfidenceAllPositive: z.coerce.number().int().min(0).max(100).default(95),
  directionalConfidenceMixed: z.coerce.number().int().min(0).max(100).default(75),
  precisionRangePct: z.coerce.number().min(0).max(1).default(0.15),
}).default({});

// ADR-PRR-002: Phase gate go/no-go thresholds
const PhaseGatesSchema = z.object({
  // Gate 1: Week 4 — Technical Validation
  gate1Week: z.coerce.number().int().min(1).default(4),
  erpFieldCoveragePct: z.coerce.number().min(0).max(1).default(0.80),
  scoringAccuracyPct: z.coerce.number().min(0).max(1).default(0.75),
  systemUptimePct: z.coerce.number().min(0).max(1).default(0.99),
  auditIntegrityPct: z.coerce.number().min(0).max(1).default(1.00),
  // Gate 2: Week 8 — Business Validation
  gate2Week: z.coerce.number().int().min(1).default(8),
  savingsVariancePct: z.coerce.number().min(0).max(1).default(0.30),
  userAdoptionPct: z.coerce.number().min(0).max(1).default(0.60),
  falsePositiveRatePct: z.coerce.number().min(0).max(1).default(0.10),
  erpTransactionSuccessPct: z.coerce.number().min(0).max(1).default(0.95),
  // Gate 3: Week 12 — Scale Readiness
  gate3Week: z.coerce.number().int().min(1).default(12),
  projectedRoiPct: z.coerce.number().min(0).default(1.50),
  securityCriticalFindings: z.coerce.number().int().min(0).default(0),
  changeManagementReadinessPct: z.coerce.number().min(0).max(1).default(0.80),
  dbLatencyP95Ms: z.coerce.number().min(0).default(200),
}).default({});

const AppConfigSchema = z.object({
  env: z.enum(['development', 'staging', 'production', 'test']).default('development'),
  port: z.coerce.number().int().min(1).max(65535).default(3000),
  logLevel: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  // Simulation lineage
  simulationId: z.string().uuid().default('65aa51b1-1fe4-4053-a50e-2eaa7f01aa2c'),
  pipelineVersion: z.string().default('0.1.0'),
  confidenceLevel: z.coerce.number().min(0).max(1).default(0.416),

  // Enterprise scaling (ADR-053)
  totalEnterpriseEmployees: z.coerce.number().int().positive().default(68000),
  pilotBuildingCount: z.coerce.number().int().positive().default(3),

  // Scoring weights (ADR-055: weights must sum to 1.0)
  scoring: z.object({
    avgOccupancyWeight: z.coerce.number().min(0).max(1).default(0.60),
    peakVarianceWeight: z.coerce.number().min(0).max(1).default(0.25),
    flexibilityWeight: z.coerce.number().min(0).max(1).default(0.15),
    severelyUnderutilizedThreshold: z.coerce.number().default(0.30),
    underutilizedThreshold: z.coerce.number().default(0.55),
    moderatelyUsedThreshold: z.coerce.number().default(0.75),
    flexibilityHoursDivisor: z.coerce.number().int().min(1).default(12),
  }).refine(
    (cfg) => Math.abs(cfg.avgOccupancyWeight + cfg.peakVarianceWeight + cfg.flexibilityWeight - 1.0) < 0.001,
    (cfg) => ({
      message: `Scoring weights must sum to 1.0 (got ${(cfg.avgOccupancyWeight + cfg.peakVarianceWeight + cfg.flexibilityWeight).toFixed(3)})`,
    }),
  ).default({}),

  // ADR-PRR-001: Externalized domain constants
  costRates: CostRatesSchema,
  scenarioParams: ScenarioParamsSchema,
  environmental: EnvironmentalSchema,
  sensitivityParams: SensitivityParamsSchema,

  // ADR-PRR-002: Phase gate thresholds
  phaseGates: PhaseGatesSchema,

  // Approval thresholds
  approval: z.object({
    vpEmployeeThreshold: z.coerce.number().int().default(50),
    cfoEmployeeThreshold: z.coerce.number().int().default(200),
    vpCostThreshold: z.coerce.number().default(100_000),
    cfoCostThreshold: z.coerce.number().default(500_000),
    minRationaleLength: z.coerce.number().int().default(20),
  }).default({}),

  // ERP
  erp: z.object({
    baseUrl: z.string().url().default('https://archibus.example.com/api/v1'),
    maxRetries: z.coerce.number().int().min(0).max(10).default(3),
    retryBaseDelayMs: z.coerce.number().int().default(1000),
    circuitBreakerThreshold: z.coerce.number().int().default(5),
    circuitBreakerResetMs: z.coerce.number().int().default(30_000),
    dryRun: z.coerce.boolean().default(true),
  }).default({}),
});

export type AppConfig = z.infer<typeof AppConfigSchema>;

function loadConfig(): AppConfig {
  try {
    const raw = {
      env: process.env.NODE_ENV,
      port: process.env.PORT,
      logLevel: process.env.LOG_LEVEL,
      simulationId: process.env.SIMULATION_ID,
      pipelineVersion: process.env.PIPELINE_VERSION,
      confidenceLevel: process.env.CONFIDENCE_LEVEL,
      totalEnterpriseEmployees: process.env.TOTAL_ENTERPRISE_EMPLOYEES,
      pilotBuildingCount: process.env.PILOT_BUILDING_COUNT,
      scoring: {
        avgOccupancyWeight: process.env.SCORING_AVG_OCCUPANCY_WEIGHT,
        peakVarianceWeight: process.env.SCORING_PEAK_VARIANCE_WEIGHT,
        flexibilityWeight: process.env.SCORING_FLEXIBILITY_WEIGHT,
        severelyUnderutilizedThreshold: process.env.SCORING_SEVERELY_UNDERUTILIZED_THRESHOLD,
        underutilizedThreshold: process.env.SCORING_UNDERUTILIZED_THRESHOLD,
        moderatelyUsedThreshold: process.env.SCORING_MODERATELY_USED_THRESHOLD,
        flexibilityHoursDivisor: process.env.SCORING_FLEXIBILITY_HOURS_DIVISOR,
      },
      costRates: {
        energyPerSqFtYear: process.env.COST_ENERGY_PER_SQFT_YEAR,
        maintenancePerSqFtYear: process.env.COST_MAINTENANCE_PER_SQFT_YEAR,
        hvacPerSqFtYear: process.env.COST_HVAC_PER_SQFT_YEAR,
        leasePerSqFtYear: process.env.COST_LEASE_PER_SQFT_YEAR,
      },
      scenarioParams: {
        consolidationLeaseRecapturePct: process.env.SCENARIO_CONSOLIDATION_LEASE_RECAPTURE_PCT,
        consolidationOccupancyMultiplier: process.env.SCENARIO_CONSOLIDATION_OCCUPANCY_MULTIPLIER,
        consolidationOccupancyCap: process.env.SCENARIO_CONSOLIDATION_OCCUPANCY_CAP,
        scheduleEnergyReductionPct: process.env.SCENARIO_SCHEDULE_ENERGY_REDUCTION_PCT,
        scheduleMaintenanceReductionPct: process.env.SCENARIO_SCHEDULE_MAINTENANCE_REDUCTION_PCT,
        scheduleHvacReductionPct: process.env.SCENARIO_SCHEDULE_HVAC_REDUCTION_PCT,
        scheduleOccupancyMultiplier: process.env.SCENARIO_SCHEDULE_OCCUPANCY_MULTIPLIER,
        scheduleOccupancyCap: process.env.SCENARIO_SCHEDULE_OCCUPANCY_CAP,
        spaceReductionFactor: process.env.SCENARIO_SPACE_REDUCTION_FACTOR,
        spaceReductionLeaseRecapturePct: process.env.SCENARIO_SPACE_REDUCTION_LEASE_RECAPTURE_PCT,
        spaceReductionOccupancyCap: process.env.SCENARIO_SPACE_REDUCTION_OCCUPANCY_CAP,
      },
      environmental: {
        kwhPerSqFtYear: process.env.ENV_KWH_PER_SQFT_YEAR,
        co2TonnesPerKwh: process.env.ENV_CO2_TONNES_PER_KWH,
      },
      sensitivityParams: {
        energyPriceRangePct: process.env.SENSITIVITY_ENERGY_PRICE_RANGE_PCT,
        occupancyCoverageImpactPct: process.env.SENSITIVITY_OCCUPANCY_COVERAGE_IMPACT_PCT,
        hybridAdoptionImpactPct: process.env.SENSITIVITY_HYBRID_ADOPTION_IMPACT_PCT,
        timelineImpactMonths: process.env.SENSITIVITY_TIMELINE_IMPACT_MONTHS,
        leaseUpsideFactor: process.env.SENSITIVITY_LEASE_UPSIDE_FACTOR,
        scopeTargetBuildings: process.env.SENSITIVITY_SCOPE_TARGET_BUILDINGS,
        scopeNetworkBonusPct: process.env.SENSITIVITY_SCOPE_NETWORK_BONUS_PCT,
        directionalFloorFactor: process.env.SENSITIVITY_DIRECTIONAL_FLOOR_FACTOR,
        directionalConfidenceAllPositive: process.env.SENSITIVITY_DIRECTIONAL_CONFIDENCE_ALL_POSITIVE,
        directionalConfidenceMixed: process.env.SENSITIVITY_DIRECTIONAL_CONFIDENCE_MIXED,
        precisionRangePct: process.env.SENSITIVITY_PRECISION_RANGE_PCT,
      },
      phaseGates: {
        gate1Week: process.env.GATE1_WEEK,
        erpFieldCoveragePct: process.env.GATE1_ERP_FIELD_COVERAGE_PCT,
        scoringAccuracyPct: process.env.GATE1_SCORING_ACCURACY_PCT,
        systemUptimePct: process.env.GATE1_SYSTEM_UPTIME_PCT,
        auditIntegrityPct: process.env.GATE1_AUDIT_INTEGRITY_PCT,
        gate2Week: process.env.GATE2_WEEK,
        savingsVariancePct: process.env.GATE2_SAVINGS_VARIANCE_PCT,
        userAdoptionPct: process.env.GATE2_USER_ADOPTION_PCT,
        falsePositiveRatePct: process.env.GATE2_FALSE_POSITIVE_RATE_PCT,
        erpTransactionSuccessPct: process.env.GATE2_ERP_TRANSACTION_SUCCESS_PCT,
        gate3Week: process.env.GATE3_WEEK,
        projectedRoiPct: process.env.GATE3_PROJECTED_ROI_PCT,
        securityCriticalFindings: process.env.GATE3_SECURITY_CRITICAL_FINDINGS,
        changeManagementReadinessPct: process.env.GATE3_CHANGE_MANAGEMENT_READINESS_PCT,
        dbLatencyP95Ms: process.env.GATE3_DB_LATENCY_P95_MS,
      },
      approval: {
        vpEmployeeThreshold: process.env.APPROVAL_VP_EMPLOYEE_THRESHOLD,
        cfoEmployeeThreshold: process.env.APPROVAL_CFO_EMPLOYEE_THRESHOLD,
        vpCostThreshold: process.env.APPROVAL_VP_COST_THRESHOLD,
        cfoCostThreshold: process.env.APPROVAL_CFO_COST_THRESHOLD,
        minRationaleLength: process.env.APPROVAL_MIN_RATIONALE_LENGTH,
      },
      erp: {
        baseUrl: process.env.ERP_BASE_URL,
        maxRetries: process.env.ERP_MAX_RETRIES,
        retryBaseDelayMs: process.env.ERP_RETRY_BASE_DELAY_MS,
        circuitBreakerThreshold: process.env.ERP_CIRCUIT_BREAKER_THRESHOLD,
        circuitBreakerResetMs: process.env.ERP_CIRCUIT_BREAKER_RESET_MS,
        dryRun: process.env.ERP_DRY_RUN,
      },
    };

    const parsed = AppConfigSchema.parse(raw);
    logger.info('config.loaded', { env: parsed.env, simulationId: parsed.simulationId });
    return parsed;
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    logger.error('config.invalid', error);
    throw error;
  }
}

export const config = loadConfig();
