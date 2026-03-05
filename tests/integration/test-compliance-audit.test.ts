/**
 * Integration test: Full compliance layer.
 *
 * Tests RBAC access control, role extraction from JWT claims,
 * audit trail recording, and hash-chain integrity verification.
 */

import { AuditTrailService } from '../../src/compliance/audit-trail.js';
import type { DbClient, AuditRecord } from '../../src/compliance/audit-trail.js';
import { extractRole, checkAccess } from '../../src/compliance/access-control.js';
import type { Role } from '../../src/compliance/access-control.js';

// ---------------------------------------------------------------------------
// Mock DbClient with in-memory audit_log array
// ---------------------------------------------------------------------------

function createMockDbClient(): DbClient & { auditLog: AuditRecord[] } {
  const auditLog: AuditRecord[] = [];

  return {
    auditLog,

    async query(sql: string, params: unknown[]): Promise<unknown[]> {
      if (sql.includes('correlation_id')) {
        const correlationId = params[0] as string;
        return auditLog
          .filter((r) => r.correlation_id === correlationId)
          .sort((a, b) => a.sequence_number - b.sequence_number);
      }
      if (sql.includes('ORDER BY sequence_number')) {
        return [...auditLog].sort((a, b) => a.sequence_number - b.sequence_number);
      }
      return [];
    },

    async execute(sql: string, params: unknown[]): Promise<void> {
      if (sql.includes('INSERT INTO audit_log')) {
        const record: AuditRecord = {
          id: params[0] as string,
          sequence_number: params[1] as number,
          timestamp: params[2] as string,
          correlation_id: params[3] as string,
          actor: params[4] as string,
          action: params[5] as string,
          entity_type: params[6] as string,
          entity_id: params[7] as string | null,
          phase: params[8] as 'before' | 'after',
          request_body: typeof params[9] === 'string' ? JSON.parse(params[9] as string) : params[9],
          response_body: typeof params[10] === 'string' ? JSON.parse(params[10] as string) : params[10],
          response_status: params[11] as number | null,
          duration_ms: params[12] as number | null,
          success: params[13] as boolean | null,
          erp_wire_format: typeof params[14] === 'string' ? JSON.parse(params[14] as string) : params[14],
          checksum: params[15] as string,
          previous_checksum: params[16] as string,
        };
        auditLog.push(record);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Tests: Access control
// ---------------------------------------------------------------------------

describe('Compliance audit (integration)', () => {
  describe('checkAccess — RBAC route permissions', () => {
    it('VIEWER can GET /api/v1/inventory/levels', () => {
      const result = checkAccess('VIEWER' as Role, 'GET', '/api/v1/inventory/levels');
      expect(result.allowed).toBe(true);
    });

    it('VIEWER cannot POST /api/v1/transfers/create', () => {
      const result = checkAccess('VIEWER' as Role, 'POST', '/api/v1/transfers/create');
      expect(result.allowed).toBe(false);
      expect(result.reason).toBeDefined();
      expect(result.reason).toContain('VIEWER');
    });

    it('OPERATOR can POST /api/v1/transfers/create', () => {
      const result = checkAccess('OPERATOR' as Role, 'POST', '/api/v1/transfers/create');
      expect(result.allowed).toBe(true);
    });

    it('ADMIN can do everything — PUT and DELETE', () => {
      const putResult = checkAccess('ADMIN' as Role, 'PUT', '/api/v1/inventory/config');
      expect(putResult.allowed).toBe(true);

      const deleteResult = checkAccess('ADMIN' as Role, 'DELETE', '/api/v1/inventory/old-records');
      expect(deleteResult.allowed).toBe(true);

      const postResult = checkAccess('ADMIN' as Role, 'POST', '/api/v1/transfers/create');
      expect(postResult.allowed).toBe(true);

      const getResult = checkAccess('ADMIN' as Role, 'GET', '/api/v1/audit/trail');
      expect(getResult.allowed).toBe(true);
    });

    it('AUDITOR can GET /api/v1/audit/trail', () => {
      const result = checkAccess('AUDITOR' as Role, 'GET', '/api/v1/audit/trail');
      expect(result.allowed).toBe(true);
    });

    it('AUDITOR cannot POST /api/v1/transfers/create', () => {
      const result = checkAccess('AUDITOR' as Role, 'POST', '/api/v1/transfers/create');
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('AUDITOR');
    });
  });

  // -------------------------------------------------------------------------
  // Tests: Role extraction
  // -------------------------------------------------------------------------

  describe('extractRole — JWT claims parsing', () => {
    it('extracts role from { role: "ADMIN" }', () => {
      const role = extractRole({ role: 'ADMIN' });
      expect(role).toBe('ADMIN');
    });

    it('extracts highest role from { roles: ["VIEWER", "OPERATOR"] }', () => {
      const role = extractRole({ roles: ['VIEWER', 'OPERATOR'] });
      expect(role).toBe('OPERATOR');
    });

    it('returns VIEWER as default from empty claims {}', () => {
      const role = extractRole({});
      expect(role).toBe('VIEWER');
    });

    it('returns VIEWER from null claims', () => {
      const role = extractRole(null);
      expect(role).toBe('VIEWER');
    });

    it('returns VIEWER from undefined claims', () => {
      const role = extractRole(undefined);
      expect(role).toBe('VIEWER');
    });

    it('extracts from custom:role claim', () => {
      const role = extractRole({ 'custom:role': 'AUDITOR' });
      expect(role).toBe('AUDITOR');
    });

    it('prefers role over roles array', () => {
      const role = extractRole({ role: 'ADMIN', roles: ['VIEWER'] });
      expect(role).toBe('ADMIN');
    });
  });

  // -------------------------------------------------------------------------
  // Tests: Audit trail service
  // -------------------------------------------------------------------------

  describe('AuditTrailService — recording and chain integrity', () => {
    let db: ReturnType<typeof createMockDbClient>;
    let auditService: AuditTrailService;

    beforeEach(() => {
      db = createMockDbClient();
      auditService = new AuditTrailService(db);
    });

    it('records before/after for a series of operations', async () => {
      // Operation 1
      await auditService.recordBefore('corr-1', 'admin', 'POST /transfers', 'transfers', { from: 'A', to: 'B' });
      await auditService.recordAfter('corr-1', 'admin', 'POST /transfers', 'transfers', 'tx-001', { id: 'tx-001' }, 201, 45, true);

      // Operation 2
      await auditService.recordBefore('corr-2', 'operator', 'PUT /inventory', 'inventory', { quantity: 100 });
      await auditService.recordAfter('corr-2', 'operator', 'PUT /inventory', 'inventory', 'inv-002', { id: 'inv-002' }, 200, 30, true);

      expect(db.auditLog).toHaveLength(4);

      const corr1Records = await auditService.getByCorrelationId('corr-1');
      expect(corr1Records).toHaveLength(2);
      expect(corr1Records[0]!.phase).toBe('before');
      expect(corr1Records[1]!.phase).toBe('after');

      const corr2Records = await auditService.getByCorrelationId('corr-2');
      expect(corr2Records).toHaveLength(2);
    });

    it('verifyChainIntegrity returns valid=true for an intact chain', async () => {
      await auditService.recordBefore('c1', 'user', 'POST', 'inventory', { a: 1 });
      await auditService.recordAfter('c1', 'user', 'POST', 'inventory', 'e1', { ok: true }, 200, 10, true);
      await auditService.recordBefore('c2', 'user', 'PUT', 'inventory', { b: 2 });
      await auditService.recordAfter('c2', 'user', 'PUT', 'inventory', 'e2', { ok: true }, 200, 8, true);

      const result = await auditService.verifyChainIntegrity();
      expect(result.valid).toBe(true);
      expect(result.brokenAt).toBeUndefined();
    });

    it('verifyChainIntegrity detects tampered checksum', async () => {
      await auditService.recordBefore('c1', 'user', 'POST', 'inventory', { a: 1 });
      await auditService.recordAfter('c1', 'user', 'POST', 'inventory', 'e1', { ok: true }, 200, 10, true);
      await auditService.recordBefore('c2', 'user', 'PUT', 'inventory', { b: 2 });
      await auditService.recordAfter('c2', 'user', 'PUT', 'inventory', 'e2', { ok: true }, 200, 8, true);

      // Tamper with the third record's checksum
      const tamperedRecord = db.auditLog[2]!;
      const tamperedIndex = db.auditLog.indexOf(tamperedRecord);
      db.auditLog[tamperedIndex] = {
        ...tamperedRecord,
        checksum: 'tampered-checksum-value-000000000000',
      };

      const result = await auditService.verifyChainIntegrity();
      expect(result.valid).toBe(false);
      expect(result.brokenAt).toBe(tamperedRecord.sequence_number);
    });
  });
});
