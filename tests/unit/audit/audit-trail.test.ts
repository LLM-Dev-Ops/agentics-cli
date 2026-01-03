/**
 * Audit Trail Unit Tests
 *
 * SPARC Architecture Reference: §6.1 (SPARC_PSEUDOCODE)
 * Tests audit logging functionality
 */

import {
  AuditTrail,
  createAuditTrail,
} from '../../../src/audit/audit-trail.js';
import type { PlanReference } from '../../../src/types/index.js';

describe('AuditTrail', () => {
  let auditTrail: AuditTrail;

  beforeEach(() => {
    auditTrail = createAuditTrail() as AuditTrail;
  });

  describe('record', () => {
    it('should record a successful command', () => {
      const planRef: PlanReference = {
        id: 'plan-123',
        type: 'PlanReference',
        repository: 'agentics-simulation-planner',
        created_at: '2024-01-01T00:00:00Z',
        checksum: 'abc123',
      };

      const entry = auditTrail.record({
        command: 'plan',
        inputs: { manifestQuery: 'test-query' },
        outputs: planRef,
        dependencies: [
          { service: 'agentics-org-manifests', method: 'select', timestamp: '2024-01-01T00:00:00Z', duration_ms: 100, success: true },
        ],
        duration_ms: 500,
        status: 'SUCCESS',
        trace_id: 'trace-123',
      });

      expect(entry.id).toBeDefined();
      expect(entry.command).toBe('plan');
      expect(entry.status).toBe('SUCCESS');
      expect(entry.trace_id).toBe('trace-123');
      expect(entry.inputs_hash).toBeDefined();
      expect(entry.checksum).toBeDefined();
    });

    it('should record a failed command', () => {
      const entry = auditTrail.record({
        command: 'simulate',
        inputs: { planRef: 'plan-123' },
        outputs: null,
        dependencies: [],
        duration_ms: 100,
        status: 'FAILED',
        error_code: 'ECLI-SVC-001',
        error_message: 'Service unavailable',
        trace_id: 'trace-456',
      });

      expect(entry.status).toBe('FAILED');
      expect(entry.error_code).toBe('ECLI-SVC-001');
      expect(entry.error_message).toBe('Service unavailable');
    });

    it('should redact sensitive fields', () => {
      const entry = auditTrail.record({
        command: 'deploy',
        inputs: {
          simRef: 'sim-123',
          auth_token: 'secret-token',
          password: 'my-password',
          api_key: 'api-key-123',
        },
        outputs: null,
        dependencies: [],
        duration_ms: 50,
        status: 'SUCCESS',
        trace_id: 'trace-789',
      });

      const redacted = entry.inputs_redacted as Record<string, unknown>;
      expect(redacted['auth_token']).toBe('[REDACTED]');
      expect(redacted['password']).toBe('[REDACTED]');
      expect(redacted['api_key']).toBe('[REDACTED]');
      expect(redacted['simRef']).toBe('sim-123');
    });
  });

  describe('getByTraceId', () => {
    it('should retrieve entries by trace ID', () => {
      const traceId = 'shared-trace-123';

      auditTrail.record({
        command: 'plan',
        inputs: {},
        outputs: null,
        dependencies: [],
        duration_ms: 100,
        status: 'SUCCESS',
        trace_id: traceId,
      });

      auditTrail.record({
        command: 'simulate',
        inputs: {},
        outputs: null,
        dependencies: [],
        duration_ms: 200,
        status: 'SUCCESS',
        trace_id: traceId,
      });

      const entries = auditTrail.getByTraceId(traceId);

      expect(entries).toHaveLength(2);
      expect(entries[0]?.command).toBe('plan');
      expect(entries[1]?.command).toBe('simulate');
    });

    it('should return empty array for unknown trace ID', () => {
      const entries = auditTrail.getByTraceId('unknown-trace');
      expect(entries).toEqual([]);
    });
  });

  describe('format', () => {
    it('should format entry as JSON', () => {
      const entry = auditTrail.record({
        command: 'test',
        inputs: {},
        outputs: null,
        dependencies: [],
        duration_ms: 50,
        status: 'SUCCESS',
        trace_id: 'trace-test',
      });

      const formatted = auditTrail.format(entry);
      const parsed = JSON.parse(formatted);

      expect(parsed.command).toBe('test');
      expect(parsed.trace_id).toBe('trace-test');
    });
  });
});
