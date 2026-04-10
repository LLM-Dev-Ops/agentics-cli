import { describe, it, expect, vi } from 'vitest';
import { SensitivityService } from '../src/services/sensitivity.js';
import { ScoringService } from '../src/services/scoring.js';
import { ScenarioService } from '../src/services/scenarios.js';
import { buildings, zones, occupancyReadings } from '../src/data/seed.js';
import type { AppConfig } from '../src/config.js';
import type { Logger } from '../src/logger.js';

function mockLogger(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function testConfig(): AppConfig {
  return {
    env: 'test', port: 3000, logLevel: 'info',
    simulationId: '65aa51b1-1fe4-4053-a50e-2eaa7f01aa2c',
    pipelineVersion: '0.1.0', confidenceLevel: 0.416,
    totalEnterpriseEmployees: 68000, pilotBuildingCount: 3,
    scoring: { avgOccupancyWeight: 0.60, peakVarianceWeight: 0.25, flexibilityWeight: 0.15, severelyUnderutilizedThreshold: 0.30, underutilizedThreshold: 0.55 },
    approval: { vpEmployeeThreshold: 50, cfoEmployeeThreshold: 200, vpCostThreshold: 100000, cfoCostThreshold: 500000, minRationaleLength: 20 },
    erp: { baseUrl: 'https://archibus.example.com/api/v1', maxRetries: 3, retryBaseDelayMs: 1000, circuitBreakerThreshold: 5, circuitBreakerResetMs: 30000, dryRun: true },
  } as AppConfig;
}

function getScenarios() {
  const cfg = testConfig();
  const scoring = new ScoringService(cfg, mockLogger());
  const scenarioService = new ScenarioService(cfg, mockLogger());
  const scores = scoring.scoreZones(zones, occupancyReadings, buildings);
  return scenarioService.generateScenarios(scores, buildings);
}

describe('ADR-057: Sensitivity Analysis and Confidence Framing', () => {
  const cfg = testConfig();
  const scenarios = getScenarios();

  describe('Sensitivity analysis table', () => {
    it('returns 6 variables', () => {
      const service = new SensitivityService(cfg, mockLogger());
      const result = service.analyze(scenarios, cfg.pilotBuildingCount);
      expect(result.variables).toHaveLength(6);
    });

    it('variables are sorted by absolute impact magnitude (highest first)', () => {
      const service = new SensitivityService(cfg, mockLogger());
      const result = service.analyze(scenarios, cfg.pilotBuildingCount);

      for (let i = 1; i < result.variables.length; i++) {
        expect(Math.abs(result.variables[i - 1].impactUsd))
          .toBeGreaterThanOrEqual(Math.abs(result.variables[i].impactUsd));
      }
    });

    it('each variable has name, range, impactUsd, and impactPercent', () => {
      const service = new SensitivityService(cfg, mockLogger());
      const result = service.analyze(scenarios, cfg.pilotBuildingCount);

      for (const v of result.variables) {
        expect(v.name).toBeTruthy();
        expect(v.range).toBeTruthy();
        expect(typeof v.impactUsd).toBe('number');
        expect(typeof v.impactPercent).toBe('number');
        expect(v.impactUsd).not.toBe(0);
      }
    });

    it('includes energy price, occupancy coverage, hybrid adoption, timeline, lease, and scope', () => {
      const service = new SensitivityService(cfg, mockLogger());
      const result = service.analyze(scenarios, cfg.pilotBuildingCount);
      const names = result.variables.map(v => v.name);

      expect(names).toContain('Energy price');
      expect(names).toContain('Occupancy data coverage');
      expect(names).toContain('Hybrid adoption rate');
      expect(names).toContain('Implementation timeline');
      expect(names).toContain('Lease recapture rate');
      expect(names).toContain('Building scope (3 → 8)');
    });

    it('occupancy data coverage has negative impact (lower coverage = less savings)', () => {
      const service = new SensitivityService(cfg, mockLogger());
      const result = service.analyze(scenarios, cfg.pilotBuildingCount);
      const coverage = result.variables.find(v => v.name === 'Occupancy data coverage');
      expect(coverage).toBeDefined();
      expect(coverage!.impactUsd).toBeLessThan(0);
      expect(coverage!.impactPercent).toBeLessThan(0);
    });

    it('hybrid adoption rate has positive impact (more remote = more opportunity)', () => {
      const service = new SensitivityService(cfg, mockLogger());
      const result = service.analyze(scenarios, cfg.pilotBuildingCount);
      const hybrid = result.variables.find(v => v.name === 'Hybrid adoption rate');
      expect(hybrid).toBeDefined();
      expect(hybrid!.impactUsd).toBeGreaterThan(0);
    });

    it('baseline matches sum of scenario savings', () => {
      const service = new SensitivityService(cfg, mockLogger());
      const result = service.analyze(scenarios, cfg.pilotBuildingCount);
      const expectedBaseline = scenarios.reduce((sum, s) => sum + s.annualCostSavingsUsd, 0);
      expect(result.baselineTotalUsd).toBeCloseTo(expectedBaseline, -1);
    });
  });

  describe('Dual confidence framing', () => {
    it('directional confidence is >90% when all scenarios are positive', () => {
      const service = new SensitivityService(cfg, mockLogger());
      const result = service.analyze(scenarios, cfg.pilotBuildingCount);
      expect(result.directionalConfidencePercent).toBeGreaterThanOrEqual(90);
    });

    it('precision confidence matches config.confidenceLevel', () => {
      const service = new SensitivityService(cfg, mockLogger());
      const result = service.analyze(scenarios, cfg.pilotBuildingCount);
      expect(result.precisionConfidencePercent).toBeCloseTo(cfg.confidenceLevel * 100, 1);
    });

    it('directional floor is less than baseline (conservative)', () => {
      const service = new SensitivityService(cfg, mockLogger());
      const result = service.analyze(scenarios, cfg.pilotBuildingCount);
      expect(result.directionalFloorUsd).toBeLessThan(result.baselineTotalUsd);
      expect(result.directionalFloorUsd).toBeGreaterThan(0);
    });

    it('precision range brackets the baseline (±15%)', () => {
      const service = new SensitivityService(cfg, mockLogger());
      const result = service.analyze(scenarios, cfg.pilotBuildingCount);
      const [low, high] = result.precisionRangeUsd;
      expect(low).toBeLessThan(result.baselineTotalUsd);
      expect(high).toBeGreaterThan(result.baselineTotalUsd);
      // Check it's approximately ±15%
      expect(low).toBeCloseTo(result.baselineTotalUsd * 0.85, -2);
      expect(high).toBeCloseTo(result.baselineTotalUsd * 1.15, -2);
    });
  });
});
