import { describe, it, expect, vi } from 'vitest';
import { ScenarioService } from '../src/services/scenarios.js';
import { ScoringService } from '../src/services/scoring.js';
import { buildings, zones, occupancyReadings } from '../src/data/seed.js';
import type { Logger } from '../src/logger.js';
import type { Scenario, SavingsBreakdown } from '../src/types.js';
import { createTestConfig } from './helpers/test-config.js';

function mockLogger(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

const testConfig = () => createTestConfig({ simulationId: '65aa51b1-1fe4-4053-a50e-2eaa7f01aa2c' });

function aggregateBreakdown(scenarios: Scenario[]): SavingsBreakdown {
  return scenarios.reduce(
    (acc, s) => ({
      energySavingsUsd: acc.energySavingsUsd + s.savingsBreakdown.energySavingsUsd,
      maintenanceSavingsUsd: acc.maintenanceSavingsUsd + s.savingsBreakdown.maintenanceSavingsUsd,
      hvacSavingsUsd: acc.hvacSavingsUsd + s.savingsBreakdown.hvacSavingsUsd,
      leaseSavingsUsd: acc.leaseSavingsUsd + s.savingsBreakdown.leaseSavingsUsd,
    }),
    { energySavingsUsd: 0, maintenanceSavingsUsd: 0, hvacSavingsUsd: 0, leaseSavingsUsd: 0 },
  );
}

describe('ADR-053: Financial Bridge — Pilot to Enterprise Reconciliation', () => {
  const cfg = testConfig();
  const scoring = new ScoringService(cfg, mockLogger());
  const scenarioService = new ScenarioService(cfg, mockLogger());
  const scores = scoring.scoreZones(zones, occupancyReadings, buildings);
  const scenarios = scenarioService.generateScenarios(scores, buildings);

  it('every scenario has a savingsBreakdown with 4 non-negative components', () => {
    for (const s of scenarios) {
      expect(s.savingsBreakdown).toBeDefined();
      expect(s.savingsBreakdown.energySavingsUsd).toBeGreaterThanOrEqual(0);
      expect(s.savingsBreakdown.maintenanceSavingsUsd).toBeGreaterThanOrEqual(0);
      expect(s.savingsBreakdown.hvacSavingsUsd).toBeGreaterThanOrEqual(0);
      expect(s.savingsBreakdown.leaseSavingsUsd).toBeGreaterThanOrEqual(0);
    }
  });

  it('component sum equals annualCostSavingsUsd for each scenario', () => {
    for (const s of scenarios) {
      const componentSum =
        s.savingsBreakdown.energySavingsUsd +
        s.savingsBreakdown.maintenanceSavingsUsd +
        s.savingsBreakdown.hvacSavingsUsd +
        s.savingsBreakdown.leaseSavingsUsd;
      expect(componentSum).toBeCloseTo(s.annualCostSavingsUsd, -1);
    }
  });

  it('aggregate waterfall sums to total pilot savings', () => {
    const pilotTotal = scenarios.reduce((sum, s) => sum + s.annualCostSavingsUsd, 0);
    const breakdown = aggregateBreakdown(scenarios);
    const waterfallTotal =
      breakdown.energySavingsUsd +
      breakdown.maintenanceSavingsUsd +
      breakdown.hvacSavingsUsd +
      breakdown.leaseSavingsUsd;
    expect(waterfallTotal).toBeCloseTo(pilotTotal, -2); // within $100
  });

  it('enterprise extrapolation uses correct scale factor', () => {
    const pilotCapacity = buildings.reduce((sum, b) => sum + b.employeeCapacity, 0);
    const scaleFactor = cfg.totalEnterpriseEmployees / pilotCapacity;

    // Scale factor should be approximately 68000 / 5200 ≈ 13.08
    expect(scaleFactor).toBeGreaterThan(10);
    expect(scaleFactor).toBeLessThan(20);

    const pilotTotal = scenarios.reduce((sum, s) => sum + s.annualCostSavingsUsd, 0);
    const enterpriseTotal = pilotTotal * scaleFactor;

    // Enterprise total should be meaningfully larger than pilot
    expect(enterpriseTotal).toBeGreaterThan(pilotTotal * 10);
    // And should be in a plausible range for 68K employees
    expect(enterpriseTotal).toBeGreaterThan(1_000_000);
    expect(enterpriseTotal).toBeLessThan(50_000_000);
  });

  it('all three buildings contribute to scenarios', () => {
    const buildingIds = new Set(
      scenarios.flatMap(s => {
        const scenarioZoneIds = s.affectedZones;
        return zones.filter(z => scenarioZoneIds.includes(z.id)).map(z => z.buildingId);
      }),
    );
    for (const b of buildings) {
      expect(buildingIds.has(b.id)).toBe(true);
    }
  });

  it('schedule_optimization scenarios have zero lease savings', () => {
    const scheduleScenarios = scenarios.filter(s => s.type === 'schedule_optimization');
    expect(scheduleScenarios.length).toBeGreaterThan(0);
    for (const s of scheduleScenarios) {
      expect(s.savingsBreakdown.leaseSavingsUsd).toBe(0);
    }
  });

  it('per-building breakdown aggregates correctly', () => {
    for (const building of buildings) {
      const bldgScenarios = scenarios.filter(s => {
        return s.affectedZones.some(zId => zones.find(z => z.id === zId)?.buildingId === building.id);
      });
      expect(bldgScenarios.length).toBeGreaterThan(0);

      const bldgTotal = bldgScenarios.reduce((sum, s) => sum + s.annualCostSavingsUsd, 0);
      const bldgBreakdown = aggregateBreakdown(bldgScenarios);
      const bldgWaterfall =
        bldgBreakdown.energySavingsUsd +
        bldgBreakdown.maintenanceSavingsUsd +
        bldgBreakdown.hvacSavingsUsd +
        bldgBreakdown.leaseSavingsUsd;
      expect(bldgWaterfall).toBeCloseTo(bldgTotal, -2);
    }
  });

  it('directional confidence floor is derived from minimum scenario savings', () => {
    const minSavings = Math.min(...scenarios.map(s => s.annualCostSavingsUsd));
    const directionalFloor = minSavings * buildings.length * 0.8;
    expect(directionalFloor).toBeGreaterThan(0);
    // Floor should be meaningfully lower than pilot total (conservative)
    const pilotTotal = scenarios.reduce((sum, s) => sum + s.annualCostSavingsUsd, 0);
    expect(directionalFloor).toBeLessThan(pilotTotal);
  });
});
