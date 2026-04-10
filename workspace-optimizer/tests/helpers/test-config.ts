import type { AppConfig } from '../../src/config.js';

/**
 * ADR-PRR-001: Shared test config factory.
 * Default values match the Zod schema defaults — changing a default in config.ts
 * means updating it here too, which is intentional (tests should be explicit).
 */
export function createTestConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    env: 'test',
    port: 3000,
    logLevel: 'info',
    simulationId: '00000000-0000-0000-0000-000000000000',
    pipelineVersion: '0.1.0',
    confidenceLevel: 0.416,
    totalEnterpriseEmployees: 68000,
    pilotBuildingCount: 3,
    scoring: {
      avgOccupancyWeight: 0.60,
      peakVarianceWeight: 0.25,
      flexibilityWeight: 0.15,
      severelyUnderutilizedThreshold: 0.30,
      underutilizedThreshold: 0.55,
      moderatelyUsedThreshold: 0.75,
      flexibilityHoursDivisor: 12,
    },
    costRates: {
      energyPerSqFtYear: 4.50,
      maintenancePerSqFtYear: 1.80,
      hvacPerSqFtYear: 2.20,
      leasePerSqFtYear: 6.00,
    },
    scenarioParams: {
      consolidationLeaseRecapturePct: 0.30,
      consolidationOccupancyMultiplier: 1.6,
      consolidationOccupancyCap: 0.85,
      scheduleEnergyReductionPct: 0.25,
      scheduleMaintenanceReductionPct: 0.15,
      scheduleHvacReductionPct: 0.35,
      scheduleOccupancyMultiplier: 1.3,
      scheduleOccupancyCap: 0.75,
      spaceReductionFactor: 0.40,
      spaceReductionLeaseRecapturePct: 0.60,
      spaceReductionOccupancyCap: 0.90,
    },
    environmental: {
      kwhPerSqFtYear: 22,
      co2TonnesPerKwh: 0.000277,
    },
    sensitivityParams: {
      energyPriceRangePct: 0.15,
      occupancyCoverageImpactPct: 0.20,
      hybridAdoptionImpactPct: 0.25,
      timelineImpactMonths: 3,
      leaseUpsideFactor: 0.50,
      scopeTargetBuildings: 8,
      scopeNetworkBonusPct: 0.15,
      directionalFloorFactor: 0.80,
      directionalConfidenceAllPositive: 95,
      directionalConfidenceMixed: 75,
      precisionRangePct: 0.15,
    },
    phaseGates: {
      gate1Week: 4,
      erpFieldCoveragePct: 0.80,
      scoringAccuracyPct: 0.75,
      systemUptimePct: 0.99,
      auditIntegrityPct: 1.00,
      gate2Week: 8,
      savingsVariancePct: 0.30,
      userAdoptionPct: 0.60,
      falsePositiveRatePct: 0.10,
      erpTransactionSuccessPct: 0.95,
      gate3Week: 12,
      projectedRoiPct: 1.50,
      securityCriticalFindings: 0,
      changeManagementReadinessPct: 0.80,
      dbLatencyP95Ms: 200,
    },
    approval: {
      vpEmployeeThreshold: 50,
      cfoEmployeeThreshold: 200,
      vpCostThreshold: 100_000,
      cfoCostThreshold: 500_000,
      minRationaleLength: 20,
    },
    erp: {
      baseUrl: 'https://archibus.example.com/api/v1',
      maxRetries: 3,
      retryBaseDelayMs: 1000,
      circuitBreakerThreshold: 5,
      circuitBreakerResetMs: 30_000,
      dryRun: true,
    },
    ...overrides,
  } as AppConfig;
}
