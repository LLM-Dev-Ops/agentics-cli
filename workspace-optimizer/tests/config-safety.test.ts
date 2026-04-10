import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { z } from 'zod';
import { ScenarioService } from '../src/services/scenarios.js';
import { ScoringService } from '../src/services/scoring.js';
import { DecisionService } from '../src/services/decisions.js';
import { AuditService } from '../src/services/audit.js';
import { createContainer } from '../src/container.js';
import { buildings, zones, occupancyReadings } from '../src/data/seed.js';
import type { AppConfig } from '../src/config.js';
import type { Logger } from '../src/logger.js';
import type { ZoneScore } from '../src/types.js';

function mockLogger(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function validConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    env: 'test', port: 3000, logLevel: 'info',
    simulationId: '00000000-0000-0000-0000-000000000000',
    pipelineVersion: '0.1.0', confidenceLevel: 0.416,
    totalEnterpriseEmployees: 68000, pilotBuildingCount: 3,
    scoring: {
      avgOccupancyWeight: 0.60, peakVarianceWeight: 0.25, flexibilityWeight: 0.15,
      severelyUnderutilizedThreshold: 0.30, underutilizedThreshold: 0.55,
    },
    approval: { vpEmployeeThreshold: 50, cfoEmployeeThreshold: 200, vpCostThreshold: 100000, cfoCostThreshold: 500000, minRationaleLength: 20 },
    erp: { baseUrl: 'https://archibus.example.com/api/v1', maxRetries: 3, retryBaseDelayMs: 1000, circuitBreakerThreshold: 5, circuitBreakerResetMs: 30000, dryRun: true },
    ...overrides,
  } as AppConfig;
}

describe('ADR-055: Scoring Configuration Safety', () => {

  // === 1. Weight Sum Validation ===

  describe('Scoring weight sum validation', () => {
    // We test the Zod schema directly since config.ts loads at import time
    const ScoringSchema = z.object({
      avgOccupancyWeight: z.coerce.number().min(0).max(1).default(0.60),
      peakVarianceWeight: z.coerce.number().min(0).max(1).default(0.25),
      flexibilityWeight: z.coerce.number().min(0).max(1).default(0.15),
      severelyUnderutilizedThreshold: z.coerce.number().default(0.30),
      underutilizedThreshold: z.coerce.number().default(0.55),
    }).refine(
      (cfg) => Math.abs(cfg.avgOccupancyWeight + cfg.peakVarianceWeight + cfg.flexibilityWeight - 1.0) < 0.001,
      (cfg) => ({
        message: `Scoring weights must sum to 1.0 (got ${(cfg.avgOccupancyWeight + cfg.peakVarianceWeight + cfg.flexibilityWeight).toFixed(3)})`,
      }),
    );

    it('accepts weights that sum to exactly 1.0', () => {
      const result = ScoringSchema.safeParse({
        avgOccupancyWeight: 0.60,
        peakVarianceWeight: 0.25,
        flexibilityWeight: 0.15,
      });
      expect(result.success).toBe(true);
    });

    it('accepts weights that sum to 1.0 within floating-point tolerance', () => {
      // 0.1 + 0.2 + 0.7 = 0.9999999999999999 in IEEE 754
      const result = ScoringSchema.safeParse({
        avgOccupancyWeight: 0.1,
        peakVarianceWeight: 0.2,
        flexibilityWeight: 0.7,
      });
      expect(result.success).toBe(true);
    });

    it('rejects weights that sum to 1.1', () => {
      const result = ScoringSchema.safeParse({
        avgOccupancyWeight: 0.70,
        peakVarianceWeight: 0.25,
        flexibilityWeight: 0.15,
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toContain('Scoring weights must sum to 1.0');
        expect(result.error.issues[0].message).toContain('1.100');
      }
    });

    it('rejects weights that sum to 0.5', () => {
      const result = ScoringSchema.safeParse({
        avgOccupancyWeight: 0.20,
        peakVarianceWeight: 0.15,
        flexibilityWeight: 0.15,
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toContain('0.500');
      }
    });

    it('defaults to valid weights when no overrides provided', () => {
      const result = ScoringSchema.safeParse({});
      expect(result.success).toBe(true);
      if (result.success) {
        const sum = result.data.avgOccupancyWeight + result.data.peakVarianceWeight + result.data.flexibilityWeight;
        expect(Math.abs(sum - 1.0)).toBeLessThan(0.001);
      }
    });
  });

  // === 2. Correlation ID in Scenario Generation ===

  describe('Correlation ID in scenario generation (ADR-055)', () => {
    it('passes correlationId through to logger calls', () => {
      const loggerMock = mockLogger();
      const service = new ScenarioService(validConfig(), loggerMock);
      const scoring = new ScoringService(validConfig(), mockLogger());
      const scores = scoring.scoreZones(zones, occupancyReadings, buildings);

      const corrId = 'test-correlation-id-12345';
      service.generateScenarios(scores, buildings, corrId);

      // Check that the private method logger calls include correlationId
      const infoCalls = (loggerMock.info as ReturnType<typeof vi.fn>).mock.calls;
      const scenarioCreationCalls = infoCalls.filter(
        (call: unknown[]) => typeof call[0] === 'string' && (call[0] as string).startsWith('scenario.'),
      );

      // Should have 3 calls per building × 3 buildings = 9 scenario creation log entries
      expect(scenarioCreationCalls.length).toBe(9);

      // Every scenario creation call should include correlationId
      for (const call of scenarioCreationCalls) {
        expect((call[1] as Record<string, unknown>).correlationId).toBe(corrId);
      }
    });

    it('generates a correlationId when none provided', () => {
      const loggerMock = mockLogger();
      const service = new ScenarioService(validConfig(), loggerMock);
      const scoring = new ScoringService(validConfig(), mockLogger());
      const scores = scoring.scoreZones(zones, occupancyReadings, buildings);

      service.generateScenarios(scores, buildings); // no correlationId

      const infoCalls = (loggerMock.info as ReturnType<typeof vi.fn>).mock.calls;
      const scenarioCreationCalls = infoCalls.filter(
        (call: unknown[]) => typeof call[0] === 'string' && (call[0] as string).startsWith('scenario.'),
      );

      // Should still have correlationId (auto-generated UUID)
      for (const call of scenarioCreationCalls) {
        const corrId = (call[1] as Record<string, unknown>).correlationId as string;
        expect(corrId).toBeDefined();
        expect(corrId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      }
    });

    it('logs all three scenario types with correlationId', () => {
      const loggerMock = mockLogger();
      const service = new ScenarioService(validConfig(), loggerMock);
      const scoring = new ScoringService(validConfig(), mockLogger());
      const scores = scoring.scoreZones(zones, occupancyReadings, buildings);

      service.generateScenarios(scores, buildings, 'test-corr');

      const infoCalls = (loggerMock.info as ReturnType<typeof vi.fn>).mock.calls;
      const events = infoCalls.map((call: unknown[]) => call[0] as string);

      expect(events).toContain('scenario.consolidation.creating');
      expect(events).toContain('scenario.schedule.creating');
      expect(events).toContain('scenario.space-reduction.creating');
    });
  });

  // === 3. Container Factory for Test Isolation ===

  describe('Container factory (ADR-055)', () => {
    it('createContainer returns a fresh container with independent services', () => {
      const c1 = createContainer();
      const c2 = createContainer();

      // Different audit service instances
      c1.audit.append({ action: 'test', actor: 'user', entityType: 'test', entityId: '1', details: {} });
      expect(c1.audit.getEntries()).toHaveLength(1);
      expect(c2.audit.getEntries()).toHaveLength(0); // c2 is independent
    });

    it('createContainer accepts config override', () => {
      const customConfig = validConfig({ simulationId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' });
      const c = createContainer(customConfig);
      expect(c.config.simulationId).toBe('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
    });

    it('decisions in one container do not leak to another', () => {
      const c1 = createContainer();
      const c2 = createContainer();

      const scoring = c1.scoring;
      const scores = scoring.scoreZones(zones, occupancyReadings, buildings);
      const scenarios = c1.scenarios.generateScenarios(scores, buildings);
      const scenario = scenarios[0];

      c1.decisions.create({
        scenario,
        createdBy: 'user@test.com',
        rationale: 'This rationale is long enough to pass validation',
      });

      // c2 should have no decisions
      expect(c2.decisions.get('any-id')).toBeUndefined();
      expect(c1.audit.getEntries().length).toBeGreaterThan(0);
      expect(c2.audit.getEntries()).toHaveLength(0);
    });

    it('running test suite twice produces identical results with fresh containers', () => {
      function runScenarioCount(): number {
        const c = createContainer();
        const scores = c.scoring.scoreZones(zones, occupancyReadings, buildings);
        const scenarios = c.scenarios.generateScenarios(scores, buildings);
        return scenarios.length;
      }

      const run1 = runScenarioCount();
      const run2 = runScenarioCount();
      expect(run1).toBe(run2);
      expect(run1).toBeGreaterThan(0);
    });
  });
});
