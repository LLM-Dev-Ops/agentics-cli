import { describe, it, expect, vi } from 'vitest';
import { PhaseGateService } from '../src/services/phase-gates.js';
import type { Logger } from '../src/logger.js';
import type { SensitivityAnalysis } from '../src/services/sensitivity.js';
import { createTestConfig } from './helpers/test-config.js';

function mockLogger(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function mockSensitivity(): SensitivityAnalysis {
  return {
    baselineTotalUsd: 500_000,
    variables: [],
    directionalConfidencePercent: 95,
    directionalFloorUsd: 200_000,
    precisionConfidencePercent: 41.6,
    precisionRangeUsd: [425_000, 575_000],
    keyTakeaway: 'test takeaway',
  };
}

describe('ADR-PRR-002: Phase Gate Go/No-Go Criteria', () => {
  describe('buildGates', () => {
    it('returns 3 gates', () => {
      const service = new PhaseGateService(createTestConfig(), mockLogger());
      const gates = service.buildGates();
      expect(gates).toHaveLength(3);
    });

    it('gate 1 is at week 4 with 4 criteria', () => {
      const service = new PhaseGateService(createTestConfig(), mockLogger());
      const gates = service.buildGates();
      expect(gates[0].weekNumber).toBe(4);
      expect(gates[0].name).toBe('Technical Validation');
      expect(gates[0].criteria).toHaveLength(4);
      expect(gates[0].decisionAuthority).toContain('CTO');
    });

    it('gate 2 is at week 8 with 4 criteria', () => {
      const service = new PhaseGateService(createTestConfig(), mockLogger());
      const gates = service.buildGates();
      expect(gates[1].weekNumber).toBe(8);
      expect(gates[1].name).toBe('Business Validation');
      expect(gates[1].criteria).toHaveLength(4);
      expect(gates[1].decisionAuthority).toContain('CFO');
    });

    it('gate 3 is at week 12 with 4 criteria', () => {
      const service = new PhaseGateService(createTestConfig(), mockLogger());
      const gates = service.buildGates();
      expect(gates[2].weekNumber).toBe(12);
      expect(gates[2].name).toBe('Scale Readiness');
      expect(gates[2].criteria).toHaveLength(4);
      expect(gates[2].decisionAuthority).toContain('Steering Committee');
    });

    it('all criteria start as not_started', () => {
      const service = new PhaseGateService(createTestConfig(), mockLogger());
      const gates = service.buildGates();
      for (const gate of gates) {
        for (const criterion of gate.criteria) {
          expect(criterion.status).toBe('not_started');
        }
        expect(gate.overallStatus).toBe('not_started');
      }
    });

    it('uses configurable thresholds', () => {
      const cfg = createTestConfig();
      cfg.phaseGates.gate1Week = 6;
      cfg.phaseGates.erpFieldCoveragePct = 0.90;
      const service = new PhaseGateService(cfg, mockLogger());
      const gates = service.buildGates();
      expect(gates[0].weekNumber).toBe(6);
      expect(gates[0].criteria[0].threshold).toContain('90%');
    });

    it('each criterion has metric, threshold, and dataSource', () => {
      const service = new PhaseGateService(createTestConfig(), mockLogger());
      const gates = service.buildGates();
      for (const gate of gates) {
        for (const c of gate.criteria) {
          expect(c.metric.length).toBeGreaterThan(0);
          expect(c.threshold.length).toBeGreaterThan(0);
          expect(c.dataSource.length).toBeGreaterThan(0);
        }
      }
    });
  });

  describe('evaluate', () => {
    it('marks audit integrity as passed when chain is valid', () => {
      const service = new PhaseGateService(createTestConfig(), mockLogger());
      const gates = service.buildGates();
      const evaluated = service.evaluate(gates, {
        auditChainValid: true,
        scenarioCount: 9,
        pilotSavingsUsd: 500_000,
        enterpriseRoiPct: 200,
        sensitivityAnalysis: mockSensitivity(),
      });
      const auditCriterion = evaluated[0].criteria.find(c => c.metric === 'Audit trail integrity');
      expect(auditCriterion!.status).toBe('passed');
      expect(auditCriterion!.currentValue).toContain('valid');
    });

    it('marks audit integrity as failed when chain is broken', () => {
      const service = new PhaseGateService(createTestConfig(), mockLogger());
      const gates = service.buildGates();
      const evaluated = service.evaluate(gates, {
        auditChainValid: false,
        scenarioCount: 9,
        pilotSavingsUsd: 500_000,
        enterpriseRoiPct: 200,
        sensitivityAnalysis: mockSensitivity(),
      });
      const auditCriterion = evaluated[0].criteria.find(c => c.metric === 'Audit trail integrity');
      expect(auditCriterion!.status).toBe('failed');
    });

    it('marks scoring model as in_progress when scenarios exist', () => {
      const service = new PhaseGateService(createTestConfig(), mockLogger());
      const gates = service.buildGates();
      const evaluated = service.evaluate(gates, {
        auditChainValid: true,
        scenarioCount: 9,
        pilotSavingsUsd: 500_000,
        enterpriseRoiPct: 200,
        sensitivityAnalysis: mockSensitivity(),
      });
      const scoringCriterion = evaluated[0].criteria.find(c => c.metric === 'Scoring model accuracy');
      expect(scoringCriterion!.status).toBe('in_progress');
      expect(scoringCriterion!.currentValue).toContain('9 scenarios');
    });

    it('shows pilot savings baseline on gate 2 savings criterion', () => {
      const service = new PhaseGateService(createTestConfig(), mockLogger());
      const gates = service.buildGates();
      const evaluated = service.evaluate(gates, {
        auditChainValid: true,
        scenarioCount: 9,
        pilotSavingsUsd: 500_000,
        enterpriseRoiPct: 200,
        sensitivityAnalysis: mockSensitivity(),
      });
      const savingsCriterion = evaluated[1].criteria.find(c => c.metric === 'Cost savings realized vs. projected');
      expect(savingsCriterion!.currentValue).toContain('500,000');
    });

    it('marks gate 3 ROI as passed when above threshold', () => {
      const service = new PhaseGateService(createTestConfig(), mockLogger());
      const gates = service.buildGates();
      const evaluated = service.evaluate(gates, {
        auditChainValid: true,
        scenarioCount: 9,
        pilotSavingsUsd: 500_000,
        enterpriseRoiPct: 200, // 200% > 150% threshold
        sensitivityAnalysis: mockSensitivity(),
      });
      const roiCriterion = evaluated[2].criteria.find(c => c.metric === 'Projected enterprise-wide ROI');
      expect(roiCriterion!.status).toBe('passed');
    });

    it('marks gate 3 ROI as at_risk when below threshold', () => {
      const service = new PhaseGateService(createTestConfig(), mockLogger());
      const gates = service.buildGates();
      const evaluated = service.evaluate(gates, {
        auditChainValid: true,
        scenarioCount: 9,
        pilotSavingsUsd: 500_000,
        enterpriseRoiPct: 100, // 100% < 150% threshold
        sensitivityAnalysis: mockSensitivity(),
      });
      const roiCriterion = evaluated[2].criteria.find(c => c.metric === 'Projected enterprise-wide ROI');
      expect(roiCriterion!.status).toBe('at_risk');
    });

    it('does not mutate the original gates', () => {
      const service = new PhaseGateService(createTestConfig(), mockLogger());
      const gates = service.buildGates();
      const originalStatus = gates[0].criteria[3].status; // audit integrity
      service.evaluate(gates, {
        auditChainValid: true,
        scenarioCount: 9,
        pilotSavingsUsd: 500_000,
        enterpriseRoiPct: 200,
        sensitivityAnalysis: mockSensitivity(),
      });
      expect(gates[0].criteria[3].status).toBe(originalStatus);
    });
  });

  describe('overall status computation', () => {
    it('gate with a failed criterion has overall status failed', () => {
      const service = new PhaseGateService(createTestConfig(), mockLogger());
      const gates = service.buildGates();
      const evaluated = service.evaluate(gates, {
        auditChainValid: false, // will fail audit criterion
        scenarioCount: 9,
        pilotSavingsUsd: 500_000,
        enterpriseRoiPct: 200,
        sensitivityAnalysis: mockSensitivity(),
      });
      expect(evaluated[0].overallStatus).toBe('failed');
    });

    it('gate with in_progress and not_started criteria has in_progress status', () => {
      const service = new PhaseGateService(createTestConfig(), mockLogger());
      const gates = service.buildGates();
      const evaluated = service.evaluate(gates, {
        auditChainValid: true,
        scenarioCount: 9,
        pilotSavingsUsd: 500_000,
        enterpriseRoiPct: 200,
        sensitivityAnalysis: mockSensitivity(),
      });
      // Gate 1 has: audit=passed, scoring=in_progress, others=not_started
      expect(evaluated[0].overallStatus).toBe('in_progress');
    });

    it('gate with only not_started criteria has not_started status', () => {
      const service = new PhaseGateService(createTestConfig(), mockLogger());
      const gates = service.buildGates();
      const evaluated = service.evaluate(gates, {
        auditChainValid: true,
        scenarioCount: 9,
        pilotSavingsUsd: 500_000,
        enterpriseRoiPct: 200,
        sensitivityAnalysis: mockSensitivity(),
      });
      // Gate 2 has savings with a currentValue but still not_started status
      expect(evaluated[1].overallStatus).toBe('not_started');
    });
  });
});
