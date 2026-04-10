import { describe, it, expect, vi } from 'vitest';
import { ScenarioService } from '../src/services/scenarios.js';
import type { AppConfig } from '../src/config.js';
import type { Logger } from '../src/logger.js';
import type { ZoneScore, Building } from '../src/types.js';

function mockLogger(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function mockConfig(): AppConfig {
  return {
    env: 'test', port: 3000, logLevel: 'info',
    simulationId: '11111111-1111-1111-1111-111111111111',
    pipelineVersion: '0.1.0', confidenceLevel: 0.416,
    totalEnterpriseEmployees: 68000, pilotBuildingCount: 3,
    scoring: { avgOccupancyWeight: 0.60, peakVarianceWeight: 0.25, flexibilityWeight: 0.15, severelyUnderutilizedThreshold: 0.30, underutilizedThreshold: 0.55 },
    approval: { vpEmployeeThreshold: 50, cfoEmployeeThreshold: 200, vpCostThreshold: 100000, cfoCostThreshold: 500000, minRationaleLength: 20 },
    erp: { baseUrl: 'https://archibus.example.com/api/v1', maxRetries: 3, retryBaseDelayMs: 1000, circuitBreakerThreshold: 5, circuitBreakerResetMs: 30000, dryRun: true },
  } as AppConfig;
}

const building: Building = {
  id: 'b-test', name: 'Test Building', region: 'north_america', address: '123 Test St',
  totalSqFt: 10000, floors: 2, annualEnergyCostUsd: 50000, annualMaintenanceCostUsd: 20000, employeeCapacity: 200,
};

const underutilizedScore: ZoneScore = {
  zoneId: 'z-test', zoneName: 'Test Zone', buildingId: 'b-test', spaceType: 'open_office',
  capacity: 100, sqFt: 5000, avgOccupancyRate: 0.25, peakOccupancyRate: 0.45,
  peakVariance: 0.20, flexibilityScore: 0.5, efficiencyIndex: 0.28, category: 'severely_underutilized',
};

describe('ScenarioService', () => {
  it('generates 3 scenario types for a building with underutilized zones', () => {
    const service = new ScenarioService(mockConfig(), mockLogger());
    const scenarios = service.generateScenarios([underutilizedScore], [building]);
    expect(scenarios).toHaveLength(3);
    const types = scenarios.map(s => s.type);
    expect(types).toContain('consolidation');
    expect(types).toContain('schedule_optimization');
    expect(types).toContain('space_reduction');
  });

  it('sets simulation ID on all scenarios', () => {
    const service = new ScenarioService(mockConfig(), mockLogger());
    const scenarios = service.generateScenarios([underutilizedScore], [building]);
    for (const s of scenarios) {
      expect(s.simulationId).toBe('11111111-1111-1111-1111-111111111111');
    }
  });

  it('generates no scenarios for well-used zones', () => {
    const service = new ScenarioService(mockConfig(), mockLogger());
    const wellUsed: ZoneScore = { ...underutilizedScore, efficiencyIndex: 0.85, category: 'well_used' };
    const scenarios = service.generateScenarios([wellUsed], [building]);
    expect(scenarios).toHaveLength(0);
  });

  it('computes positive savings for all scenario types', () => {
    const service = new ScenarioService(mockConfig(), mockLogger());
    const scenarios = service.generateScenarios([underutilizedScore], [building]);
    for (const s of scenarios) {
      expect(s.annualCostSavingsUsd).toBeGreaterThan(0);
      expect(s.annualEnergySavingsKwh).toBeGreaterThan(0);
      expect(s.annualCo2ReductionTonnes).toBeGreaterThan(0);
    }
  });

  it('includes savingsBreakdown with all four categories (ADR-053)', () => {
    const service = new ScenarioService(mockConfig(), mockLogger());
    const scenarios = service.generateScenarios([underutilizedScore], [building]);
    for (const s of scenarios) {
      expect(s.savingsBreakdown).toBeDefined();
      expect(s.savingsBreakdown.energySavingsUsd).toBeGreaterThanOrEqual(0);
      expect(s.savingsBreakdown.maintenanceSavingsUsd).toBeGreaterThanOrEqual(0);
      expect(s.savingsBreakdown.hvacSavingsUsd).toBeGreaterThanOrEqual(0);
      expect(s.savingsBreakdown.leaseSavingsUsd).toBeGreaterThanOrEqual(0);
      // Sum of components must equal total
      const componentSum =
        s.savingsBreakdown.energySavingsUsd +
        s.savingsBreakdown.maintenanceSavingsUsd +
        s.savingsBreakdown.hvacSavingsUsd +
        s.savingsBreakdown.leaseSavingsUsd;
      expect(componentSum).toBeCloseTo(s.annualCostSavingsUsd, -1); // within $10
    }
  });
});
