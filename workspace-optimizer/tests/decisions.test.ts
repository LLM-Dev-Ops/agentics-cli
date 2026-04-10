import { describe, it, expect, vi } from 'vitest';
import { DecisionService } from '../src/services/decisions.js';
import { AuditService } from '../src/services/audit.js';
import type { Logger } from '../src/logger.js';
import type { Scenario } from '../src/types.js';
import { AuthorizationError, ValidationError } from '../src/errors.js';
import { createTestConfig } from './helpers/test-config.js';

function mockLogger(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

const mockConfig = () => createTestConfig({ simulationId: '22222222-2222-2222-2222-222222222222' });

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

  // ADR-PRR-004: Rejection workflow tests

  it('rejects a pending_review decision with valid rationale', () => {
    const audit = new AuditService(mockLogger());
    const service = new DecisionService(mockConfig(), mockLogger(), audit);
    const decision = service.create({ scenario: testScenario, createdBy: 'creator@test.com', rationale: 'This is a sufficient rationale for the decision' });
    service.submit(decision.id, 'creator@test.com');
    expect(service.get(decision.id)?.status).toBe('pending_review');

    service.reject({
      decisionId: decision.id,
      rejector: 'reviewer@test.com',
      role: 'vp_operations',
      rationale: 'Employee disruption risk is too high for this quarter',
    });
    expect(service.get(decision.id)?.status).toBe('rejected');
  });

  it('records audit entry on rejection', () => {
    const audit = new AuditService(mockLogger());
    const service = new DecisionService(mockConfig(), mockLogger(), audit);
    const decision = service.create({ scenario: testScenario, createdBy: 'creator@test.com', rationale: 'This is a sufficient rationale for the decision' });
    service.submit(decision.id, 'creator@test.com');

    service.reject({
      decisionId: decision.id,
      rejector: 'reviewer@test.com',
      role: 'vp_operations',
      rationale: 'Employee disruption risk is too high for this quarter',
    });

    const entries = audit.getEntries();
    const rejectionEntry = entries.find(e => e.action === 'decision_rejected');
    expect(rejectionEntry).toBeDefined();
    expect(rejectionEntry!.actor).toBe('reviewer@test.com');
    expect(rejectionEntry!.details.newStatus).toBe('rejected');
    expect(rejectionEntry!.details.rationale).toContain('disruption risk');
  });

  it('prevents creator from rejecting their own decision (separation of duties)', () => {
    const audit = new AuditService(mockLogger());
    const service = new DecisionService(mockConfig(), mockLogger(), audit);
    const decision = service.create({ scenario: testScenario, createdBy: 'creator@test.com', rationale: 'This is a sufficient rationale for the decision' });
    service.submit(decision.id, 'creator@test.com');

    expect(() => service.reject({
      decisionId: decision.id,
      rejector: 'creator@test.com',
      role: 'vp_operations',
      rationale: 'Trying to reject my own decision which should fail',
    })).toThrow(AuthorizationError);
  });

  it('cannot reject a decision that is not in pending_review', () => {
    const audit = new AuditService(mockLogger());
    const service = new DecisionService(mockConfig(), mockLogger(), audit);
    const decision = service.create({ scenario: testScenario, createdBy: 'creator@test.com', rationale: 'This is a sufficient rationale for the decision' });
    // Still in 'draft' — not yet submitted
    expect(() => service.reject({
      decisionId: decision.id,
      rejector: 'reviewer@test.com',
      role: 'vp_operations',
      rationale: 'Trying to reject a draft decision which should fail',
    })).toThrow(ValidationError);
  });

  it('cannot reject an already-approved decision', () => {
    const audit = new AuditService(mockLogger());
    const service = new DecisionService(mockConfig(), mockLogger(), audit);
    const decision = service.create({ scenario: testScenario, createdBy: 'creator@test.com', rationale: 'This is a sufficient rationale for the decision' });
    service.submit(decision.id, 'creator@test.com');
    service.approve({
      decisionId: decision.id, approver: 'approver@test.com', role: 'vp_operations',
      rationale: 'Approved after reviewing the occupancy data and projected savings',
    });

    expect(() => service.reject({
      decisionId: decision.id,
      rejector: 'other@test.com',
      role: 'cfo',
      rationale: 'Trying to reject an approved decision which should fail',
    })).toThrow(ValidationError);
  });

  it('enforces minimum rationale length on rejection', () => {
    const audit = new AuditService(mockLogger());
    const service = new DecisionService(mockConfig(), mockLogger(), audit);
    const decision = service.create({ scenario: testScenario, createdBy: 'creator@test.com', rationale: 'This is a sufficient rationale for the decision' });
    service.submit(decision.id, 'creator@test.com');

    expect(() => service.reject({
      decisionId: decision.id,
      rejector: 'reviewer@test.com',
      role: 'vp_operations',
      rationale: 'no',
    })).toThrow(ValidationError);
  });
});
