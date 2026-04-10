import { describe, it, expect, vi } from 'vitest';
import { DecisionLifecycleService } from '../src/services/lifecycle.js';
import { AuditService } from '../src/services/audit.js';
import { ERPAdapter } from '../src/erp/adapter.js';
import { CircuitBreaker } from '../src/middleware.js';
import type { Logger } from '../src/logger.js';
import type { Decision, Scenario } from '../src/types.js';
import { createTestConfig } from './helpers/test-config.js';

function mockLogger(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function testConfig(overrides: Partial<{ dryRun: boolean }> = {}) {
  return createTestConfig({
    erp: { baseUrl: 'https://archibus.example.com/api/v1', maxRetries: 3, retryBaseDelayMs: 1, circuitBreakerThreshold: 5, circuitBreakerResetMs: 30000, dryRun: overrides.dryRun ?? true },
  });
}

const testDecision: Decision = {
  id: 'dec-00000000-0000-0000-0000-000000000001',
  simulationId: '00000000-0000-0000-0000-000000000000',
  scenarioId: 'scn-00000000-0000-0000-0000-000000000001',
  status: 'approved_vp',
  createdBy: 'sarah@company.com',
  createdAt: new Date('2026-04-10T10:00:00Z'),
  rationale: 'Approved consolidation scenario for SF HQ',
  approvals: [],
  annualCostSavingsUsd: 278000,
  employeesAffected: 58,
};

const testScenario: Scenario = {
  id: 'scn-00000000-0000-0000-0000-000000000001',
  simulationId: '00000000-0000-0000-0000-000000000000',
  type: 'consolidation',
  name: 'Test Consolidation',
  description: 'Test',
  affectedZones: ['z-1'],
  projectedOccupancyRate: 0.75,
  annualCostSavingsUsd: 278000,
  annualEnergySavingsKwh: 595000,
  annualCo2ReductionTonnes: 165,
  employeesAffected: 58,
  employeeExperienceImpact: 'neutral',
  implementationRisk: 'medium',
  savingsBreakdown: { energySavingsUsd: 100000, maintenanceSavingsUsd: 60000, hvacSavingsUsd: 70000, leaseSavingsUsd: 48000 },
};

describe('ADR-056: ERP Audit Chain Completeness', () => {

  describe('Successful sync (dry-run)', () => {
    it('appends erp_sync_initiated and erp_sync_completed to audit chain', async () => {
      const audit = new AuditService(mockLogger());
      const cb = new CircuitBreaker(5, 30000, mockLogger());
      const erp = new ERPAdapter(testConfig(), mockLogger(), cb);
      const lifecycle = new DecisionLifecycleService(audit, erp, mockLogger());

      const tx = await lifecycle.syncToErp(testDecision, testScenario, 'b1', 'f1-01');

      expect(tx.status).toBe('confirmed');

      const entries = audit.getEntries();
      expect(entries).toHaveLength(2);
      expect(entries[0].action).toBe('erp_sync_initiated');
      expect(entries[1].action).toBe('erp_sync_completed');
    });

    it('erp_sync_initiated contains decisionId and targetSystem', async () => {
      const audit = new AuditService(mockLogger());
      const cb = new CircuitBreaker(5, 30000, mockLogger());
      const erp = new ERPAdapter(testConfig(), mockLogger(), cb);
      const lifecycle = new DecisionLifecycleService(audit, erp, mockLogger());

      await lifecycle.syncToErp(testDecision, testScenario, 'b1', 'f1-01');

      const initiated = audit.getEntries()[0];
      expect(initiated.actor).toBe('system');
      expect(initiated.entityType).toBe('erp_transaction');
      expect(initiated.details.decisionId).toBe(testDecision.id);
      expect(initiated.details.targetSystem).toBe('archibus');
      expect(initiated.details.buildingId).toBe('b1');
    });

    it('erp_sync_completed contains transactionId and durationMs', async () => {
      const audit = new AuditService(mockLogger());
      const cb = new CircuitBreaker(5, 30000, mockLogger());
      const erp = new ERPAdapter(testConfig(), mockLogger(), cb);
      const lifecycle = new DecisionLifecycleService(audit, erp, mockLogger());

      const tx = await lifecycle.syncToErp(testDecision, testScenario, 'b1', 'f1-01');

      const completed = audit.getEntries()[1];
      expect(completed.details.transactionId).toBe(tx.id);
      expect(completed.details.decisionId).toBe(testDecision.id);
      expect(typeof completed.details.durationMs).toBe('number');
      expect(completed.details.idempotencyKey).toBe(tx.idempotencyKey);
    });
  });

  describe('Failed sync', () => {
    it('appends erp_sync_initiated and erp_sync_failed when adapter returns failed status', async () => {
      const audit = new AuditService(mockLogger());
      // Circuit breaker with threshold=1 so it opens after first failure
      const cb = new CircuitBreaker(1, 100, mockLogger());

      // Force the circuit breaker open so all calls fail
      try { await cb.execute(async () => { throw new Error('forced'); }); } catch {}

      const cfg = testConfig({ dryRun: false });
      const erp = new ERPAdapter(cfg, mockLogger(), cb);
      const lifecycle = new DecisionLifecycleService(audit, erp, mockLogger());

      const tx = await lifecycle.syncToErp(testDecision, testScenario, 'b1', 'f1-01');

      expect(tx.status).toBe('failed');

      const entries = audit.getEntries();
      expect(entries).toHaveLength(2);
      expect(entries[0].action).toBe('erp_sync_initiated');
      expect(entries[1].action).toBe('erp_sync_failed');
    });

    it('erp_sync_failed contains attempts and finalStatus', async () => {
      const audit = new AuditService(mockLogger());
      const cb = new CircuitBreaker(1, 100, mockLogger());
      try { await cb.execute(async () => { throw new Error('forced'); }); } catch {}

      const cfg = testConfig({ dryRun: false });
      const erp = new ERPAdapter(cfg, mockLogger(), cb);
      const lifecycle = new DecisionLifecycleService(audit, erp, mockLogger());

      await lifecycle.syncToErp(testDecision, testScenario, 'b1', 'f1-01');

      const failed = audit.getEntries()[1];
      expect(failed.actor).toBe('system');
      expect(failed.details.decisionId).toBe(testDecision.id);
      expect(failed.details.finalStatus).toBe('failed');
      expect(typeof failed.details.attempts).toBe('number');
      expect(typeof failed.details.durationMs).toBe('number');
    });
  });

  describe('Audit chain integrity', () => {
    it('chain remains valid after ERP sync entries are appended', async () => {
      const audit = new AuditService(mockLogger());
      const cb = new CircuitBreaker(5, 30000, mockLogger());
      const erp = new ERPAdapter(testConfig(), mockLogger(), cb);
      const lifecycle = new DecisionLifecycleService(audit, erp, mockLogger());

      // Add some pre-existing audit entries (decision lifecycle)
      audit.append({ action: 'decision_created', actor: 'sarah@co.com', entityType: 'decision', entityId: testDecision.id, details: {} });
      audit.append({ action: 'decision_submitted', actor: 'sarah@co.com', entityType: 'decision', entityId: testDecision.id, details: {} });
      audit.append({ action: 'approval_granted', actor: 'jennifer@co.com', entityType: 'decision', entityId: testDecision.id, details: {} });

      // Now sync — adds 2 more entries
      await lifecycle.syncToErp(testDecision, testScenario, 'b1', 'f1-01');

      const verification = audit.verify();
      expect(verification.valid).toBe(true);
      expect(verification.chainLength).toBe(5); // 3 decision + 2 ERP
    });

    it('full decision lifecycle is visible in audit chain', async () => {
      const audit = new AuditService(mockLogger());
      const cb = new CircuitBreaker(5, 30000, mockLogger());
      const erp = new ERPAdapter(testConfig(), mockLogger(), cb);
      const lifecycle = new DecisionLifecycleService(audit, erp, mockLogger());

      // Simulate full lifecycle
      audit.append({ action: 'decision_created', actor: 'sarah@co.com', entityType: 'decision', entityId: testDecision.id, details: {} });
      audit.append({ action: 'decision_submitted', actor: 'sarah@co.com', entityType: 'decision', entityId: testDecision.id, details: {} });
      audit.append({ action: 'approval_granted', actor: 'jennifer@co.com', entityType: 'decision', entityId: testDecision.id, details: {} });
      await lifecycle.syncToErp(testDecision, testScenario, 'b1', 'f1-01');

      const actions = audit.getEntries().map(e => e.action);
      expect(actions).toEqual([
        'decision_created',
        'decision_submitted',
        'approval_granted',
        'erp_sync_initiated',
        'erp_sync_completed',
      ]);
    });

    it('hash chain links correctly across decision and ERP entries', async () => {
      const audit = new AuditService(mockLogger());
      const cb = new CircuitBreaker(5, 30000, mockLogger());
      const erp = new ERPAdapter(testConfig(), mockLogger(), cb);
      const lifecycle = new DecisionLifecycleService(audit, erp, mockLogger());

      audit.append({ action: 'approval_granted', actor: 'jen@co.com', entityType: 'decision', entityId: 'd1', details: {} });
      await lifecycle.syncToErp(testDecision, testScenario, 'b1', 'f1-01');

      const entries = audit.getEntries();
      // erp_sync_initiated's previousHash should be approval_granted's hash
      expect(entries[1].previousHash).toBe(entries[0].hash);
      // erp_sync_completed's previousHash should be erp_sync_initiated's hash
      expect(entries[2].previousHash).toBe(entries[1].hash);
    });
  });

  describe('Querying ERP entries by decision', () => {
    it('getEntriesByEntity returns ERP sync entries for the decision', async () => {
      const audit = new AuditService(mockLogger());
      const cb = new CircuitBreaker(5, 30000, mockLogger());
      const erp = new ERPAdapter(testConfig(), mockLogger(), cb);
      const lifecycle = new DecisionLifecycleService(audit, erp, mockLogger());

      await lifecycle.syncToErp(testDecision, testScenario, 'b1', 'f1-01');

      // erp_sync_initiated uses decision.id as entityId
      const byDecision = audit.getEntriesByEntity(testDecision.id);
      expect(byDecision.length).toBeGreaterThanOrEqual(1);
      expect(byDecision[0].action).toBe('erp_sync_initiated');
    });
  });
});
