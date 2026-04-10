import { describe, it, expect, vi } from 'vitest';
import { ERPAdapter } from '../src/erp/adapter.js';
import { CircuitBreaker } from '../src/middleware.js';
import {
  detectERPSystem,
  getIntegrationPointsForSystem,
  ARCHIBUS_INTEGRATION_POINTS,
  SUPPORTED_SCHEMA_VERSIONS,
  DEFAULT_SCHEMA_VERSION,
  negotiateSchemaVersion,
  getFieldMap,
  SchemaVersionError,
} from '../src/erp/schema.js';
import type { Logger } from '../src/logger.js';
import type { Decision, Scenario } from '../src/types.js';
import { createTestConfig } from './helpers/test-config.js';

function mockLogger(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function testConfig() {
  return createTestConfig({
    erp: { baseUrl: 'https://archibus.example.com/api/v1', maxRetries: 3, retryBaseDelayMs: 1, circuitBreakerThreshold: 5, circuitBreakerResetMs: 30000, dryRun: true },
  });
}

const testDecision: Decision = {
  id: 'dec-test-1', simulationId: 'sim-1', scenarioId: 'scn-1',
  status: 'approved_vp', createdBy: 'user@test.com',
  createdAt: new Date('2026-04-10T10:00:00Z'),
  rationale: 'Test decision for ERP surface testing',
  approvals: [], annualCostSavingsUsd: 150000, employeesAffected: 60,
};

const testScenario: Scenario = {
  id: 'scn-1', simulationId: 'sim-1', type: 'consolidation',
  name: 'Test', description: 'Test', affectedZones: ['z-1'],
  projectedOccupancyRate: 0.75, annualCostSavingsUsd: 150000,
  annualEnergySavingsKwh: 50000, annualCo2ReductionTonnes: 15,
  employeesAffected: 60, employeeExperienceImpact: 'neutral',
  implementationRisk: 'medium',
  savingsBreakdown: { energySavingsUsd: 50000, maintenanceSavingsUsd: 30000, hvacSavingsUsd: 40000, leaseSavingsUsd: 30000 },
};

describe('ADR-058: ERP Surface Targeting and Schema Versioning', () => {

  // === 1. Archibus Detection ===

  describe('ERP system detection', () => {
    it('detects Archibus from keyword "Archibus"', () => {
      expect(detectERPSystem('We use Archibus for facilities management')).toBe('archibus');
    });

    it('detects Archibus from keyword "IWMS"', () => {
      expect(detectERPSystem('Our IWMS handles space planning')).toBe('archibus');
    });

    it('detects Archibus from field names like bl_id', () => {
      expect(detectERPSystem('The bl_id field maps to building codes')).toBe('archibus');
    });

    it('detects SAP from keyword "SAP"', () => {
      expect(detectERPSystem('We run SAP S/4HANA for finance')).toBe('sap');
    });

    it('detects ServiceNow from keyword "ServiceNow"', () => {
      expect(detectERPSystem('ServiceNow CMDB manages our assets')).toBe('servicenow');
    });

    it('returns unknown for unrecognized systems', () => {
      expect(detectERPSystem('We use a custom-built system')).toBe('unknown');
    });

    it('is case-insensitive', () => {
      expect(detectERPSystem('ARCHIBUS is our primary tool')).toBe('archibus');
    });
  });

  describe('Integration point filtering', () => {
    it('returns Archibus-specific endpoints for Archibus', () => {
      const points = getIntegrationPointsForSystem('archibus');
      expect(points).not.toBeNull();
      expect(points!.length).toBe(5);
      const tables = points!.map(p => p.table);
      expect(tables).toContain('afm_activity_log');
      expect(tables).toContain('rm');
      expect(tables).toContain('wr');
      expect(tables).toContain('bl');
      expect(tables).toContain('afm/datasource');
    });

    it('does NOT return SAP endpoints for Archibus queries', () => {
      const points = getIntegrationPointsForSystem('archibus');
      const descriptions = points!.map(p => p.description.toLowerCase());
      for (const desc of descriptions) {
        expect(desc).not.toContain('gl account');
        expect(desc).not.toContain('journal entry');
        expect(desc).not.toContain('purchase order');
      }
    });

    it('returns null for SAP (not implemented in this prototype)', () => {
      expect(getIntegrationPointsForSystem('sap')).toBeNull();
    });

    it('each integration point has table, description, operations, apiPath', () => {
      for (const point of ARCHIBUS_INTEGRATION_POINTS) {
        expect(point.table).toBeTruthy();
        expect(point.description).toBeTruthy();
        expect(point.operations.length).toBeGreaterThan(0);
        expect(point.apiPath).toMatch(/^\/api\/v1\//);
      }
    });
  });

  // === 2. Schema Version Negotiation ===

  describe('Schema version negotiation', () => {
    it('accepts exact supported version (25.2)', () => {
      const result = negotiateSchemaVersion('25.2');
      expect(result.compatible).toBe(true);
      expect(result.effectiveVersion).toBe('25.2');
      expect(result.warning).toBeUndefined();
    });

    it('accepts all declared supported versions', () => {
      for (const v of SUPPORTED_SCHEMA_VERSIONS) {
        const result = negotiateSchemaVersion(v);
        expect(result.compatible).toBe(true);
      }
    });

    it('rejects major version 24 (not supported)', () => {
      const result = negotiateSchemaVersion('24.5');
      expect(result.compatible).toBe(false);
      expect(result.warning).toContain('not supported');
    });

    it('rejects major version 27 (not supported)', () => {
      const result = negotiateSchemaVersion('27.0');
      expect(result.compatible).toBe(false);
    });

    it('accepts minor mismatch within same major with warning', () => {
      const result = negotiateSchemaVersion('25.9');
      expect(result.compatible).toBe(true);
      expect(result.warning).toContain('Minor version mismatch');
      expect(result.effectiveVersion).toBe('25.2'); // latest 25.x we support
    });

    it('accepts minor mismatch for v26 with warning', () => {
      const result = negotiateSchemaVersion('26.3');
      expect(result.compatible).toBe(true);
      expect(result.warning).toContain('Minor version mismatch');
      expect(result.effectiveVersion).toBe('26.0');
    });
  });

  describe('Version-aware field maps', () => {
    it('returns field map for v25.1', () => {
      const map = getFieldMap('25.1');
      expect(map.costSavingsAnnual).toBe('cost_savings_annual');
    });

    it('returns field map for v26.0 with renamed fields', () => {
      const map = getFieldMap('26.0');
      expect(map.costSavingsAnnual).toBe('annual_cost_savings');
      expect(map.energySavingsKwh).toBe('annual_energy_savings_kwh');
    });

    it('throws for unsupported version', () => {
      expect(() => getFieldMap('24.0')).toThrow('No field map');
    });
  });

  // === 3. ERPAdapter Schema Version Integration ===

  describe('ERPAdapter schema versioning', () => {
    it('exposes SUPPORTED_SCHEMA_VERSIONS static field', () => {
      expect(ERPAdapter.SUPPORTED_SCHEMA_VERSIONS).toBeDefined();
      expect(ERPAdapter.SUPPORTED_SCHEMA_VERSIONS.length).toBeGreaterThanOrEqual(3);
    });

    it('negotiateVersion succeeds for supported version', async () => {
      const cb = new CircuitBreaker(5, 30000, mockLogger());
      const adapter = new ERPAdapter(testConfig(), mockLogger(), cb);
      const result = await adapter.negotiateVersion('25.2');
      expect(result.effectiveVersion).toBe('25.2');
      expect(adapter.getSchemaVersion()).toBe('25.2');
    });

    it('negotiateVersion throws SchemaVersionError for incompatible major version', async () => {
      const cb = new CircuitBreaker(5, 30000, mockLogger());
      const adapter = new ERPAdapter(testConfig(), mockLogger(), cb);
      await expect(adapter.negotiateVersion('27.0')).rejects.toThrow(SchemaVersionError);
    });

    it('negotiateVersion warns for minor mismatch', async () => {
      const loggerMock = mockLogger();
      const cb = new CircuitBreaker(5, 30000, mockLogger());
      const adapter = new ERPAdapter(testConfig(), loggerMock, cb);
      const result = await adapter.negotiateVersion('25.9');
      expect(result.effectiveVersion).toBe('25.2');
      expect(result.warning).toContain('Minor version');
      expect((loggerMock.warn as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(0);
    });

    it('includes schemaVersion in every transaction', async () => {
      const cb = new CircuitBreaker(5, 30000, mockLogger());
      const adapter = new ERPAdapter(testConfig(), mockLogger(), cb);
      await adapter.negotiateVersion('25.2');
      const tx = await adapter.syncDecision(testDecision, testScenario, 'b1', 'f1-01');
      expect(tx.schemaVersion).toBe('25.2');
    });

    it('auto-negotiates with default version on first sync if not called explicitly', async () => {
      const cb = new CircuitBreaker(5, 30000, mockLogger());
      const adapter = new ERPAdapter(testConfig(), mockLogger(), cb);
      // Don't call negotiateVersion — adapter should auto-negotiate
      const tx = await adapter.syncDecision(testDecision, testScenario, 'b1', 'f1-01');
      expect(tx.schemaVersion).toBe(DEFAULT_SCHEMA_VERSION);
    });

    it('reset clears negotiated version', async () => {
      const cb = new CircuitBreaker(5, 30000, mockLogger());
      const adapter = new ERPAdapter(testConfig(), mockLogger(), cb);
      await adapter.negotiateVersion('26.0');
      expect(adapter.getSchemaVersion()).toBe('26.0');
      adapter.reset();
      expect(adapter.getSchemaVersion()).toBe(DEFAULT_SCHEMA_VERSION);
    });
  });
});
