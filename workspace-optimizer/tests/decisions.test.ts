import { describe, it, expect, vi } from 'vitest';
import { DecisionService } from '../src/services/decisions.js';
import { AuditService } from '../src/services/audit.js';
import type { AppConfig } from '../src/config.js';
import type { Logger } from '../src/logger.js';
import type { Scenario } from '../src/types.js';
import { AuthorizationError, ValidationError } from '../src/errors.js';

function mockLogger(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function mockConfig(): AppConfig {
  return {
    env: 'test', port: 3000, logLevel: 'info',
    simulationId: '22222222-2222-2222-2222-222222222222',
    pipelineVersion: '0.1.0', confidenceLevel: 0.416,
    totalEnterpriseEmployees: 68000, pilotBuildingCount: 3,
    scoring: { avgOccupancyWeight: 0.60, peakVarianceWeight: 0.25, flexibilityWeight: 0.15, severelyUnderutilizedThreshold: 0.30, underutilizedThreshold: 0.55 },
    approval: { vpEmployeeThreshold: 50, cfoEmployeeThreshold: 200, vpCostThreshold: 100000, cfoCostThreshold: 500000, minRationaleLength: 20 },
    erp: { baseUrl: 'https://archibus.example.com/api/v1', maxRetries: 3, retryBaseDelayMs: 1000, circuitBreakerThreshold: 5, circuitBreakerResetMs: 30000, dryRun: true },
  } as AppConfig;
}

const testScenario: Scenario = {
  id: 'scenario-1',
  simulationId: '22222222-2222-2222-2222-222222222222',
  type: 'consolidation',
  name: 'Test Consolidation',
  description: 'Test scenario',
  affectedZones: ['z-1'],
  projectedOccupancyRate: 0.75,
  annualCostSavingsUsd: 150000,
  annualEnergySavingsKwh: 50000,
  annualCo2ReductionTonnes: 15,
  employeesAffected: 80,
  employeeExperienceImpact: 'neutral',
  implementationRisk: 'medium',
  savingsBreakdown: { energySavingsUsd: 50000, maintenanceSavingsUsd: 30000, hvacSavingsUsd: 40000, leaseSavingsUsd: 30000 },
};

describe('DecisionService', () => {
  it('creates a decision and records audit entry', () => {
    const audit = new AuditService(mockLogger());
    const service = new DecisionService(mockConfig(), mockLogger(), audit);
    const decision = service.create({
      scenario: testScenario,
      createdBy: 'user@test.com',
      rationale: 'This is a sufficient rationale for the decision',
    });
    expect(decision.status).toBe('draft');
    expect(decision.createdBy).toBe('user@test.com');
    expect(audit.getEntries()).toHaveLength(1);
    expect(audit.getEntries()[0].action).toBe('decision_created');
  });

  it('rejects short rationale', () => {
    const audit = new AuditService(mockLogger());
    const service = new DecisionService(mockConfig(), mockLogger(), audit);
    expect(() => service.create({ scenario: testScenario, createdBy: 'user@test.com', rationale: 'too short' }))
      .toThrow(ValidationError);
  });

  it('follows the submit → approve workflow', () => {
    const audit = new AuditService(mockLogger());
    const service = new DecisionService(mockConfig(), mockLogger(), audit);
    const decision = service.create({ scenario: testScenario, createdBy: 'creator@test.com', rationale: 'This is a sufficient rationale for the decision' });
    service.submit(decision.id, 'creator@test.com');
    expect(service.get(decision.id)?.status).toBe('pending_review');

    service.approve({
      decisionId: decision.id, approver: 'approver@test.com', role: 'vp_operations',
      rationale: 'Approved after reviewing the occupancy data and projected savings',
    });
    expect(service.get(decision.id)?.status).toBe('approved_vp');
  });

  it('prevents self-approval (separation of duties)', () => {
    const audit = new AuditService(mockLogger());
    const service = new DecisionService(mockConfig(), mockLogger(), audit);
    const decision = service.create({ scenario: testScenario, createdBy: 'user@test.com', rationale: 'This is a sufficient rationale for the decision' });
    service.submit(decision.id, 'user@test.com');
    expect(() => service.approve({
      decisionId: decision.id, approver: 'user@test.com', role: 'vp_operations',
      rationale: 'Trying to approve my own decision which should fail',
    })).toThrow(AuthorizationError);
  });

  it('requires sufficient role level for high-value decisions', () => {
    const audit = new AuditService(mockLogger());
    const service = new DecisionService(mockConfig(), mockLogger(), audit);
    const decision = service.create({ scenario: testScenario, createdBy: 'creator@test.com', rationale: 'This is a sufficient rationale for the decision' });
    service.submit(decision.id, 'creator@test.com');
    // testScenario has 80 employees (> vpThreshold 50) and $150K savings (> vpCostThreshold 100K)
    // So requires VP level, FM should fail
    expect(() => service.approve({
      decisionId: decision.id, approver: 'fm@test.com', role: 'facility_manager',
      rationale: 'FM trying to approve a VP-level decision which should fail',
    })).toThrow(AuthorizationError);
  });
});
