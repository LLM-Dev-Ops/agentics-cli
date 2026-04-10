import { describe, it, expect, vi } from 'vitest';
import { AuditService } from '../src/services/audit.js';
import type { Logger } from '../src/logger.js';

function mockLogger(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

describe('AuditService', () => {
  it('appends entries with hash chain', () => {
    const service = new AuditService(mockLogger());
    const e1 = service.append({ action: 'test_action', actor: 'user', entityType: 'test', entityId: '1', details: {} });
    const e2 = service.append({ action: 'test_action_2', actor: 'user', entityType: 'test', entityId: '2', details: {} });
    expect(e2.previousHash).toBe(e1.hash);
    expect(e1.previousHash).toBe('genesis');
  });

  it('verifies an intact chain', () => {
    const service = new AuditService(mockLogger());
    service.append({ action: 'a1', actor: 'user', entityType: 'test', entityId: '1', details: {} });
    service.append({ action: 'a2', actor: 'user', entityType: 'test', entityId: '2', details: {} });
    const result = service.verify();
    expect(result.valid).toBe(true);
    expect(result.chainLength).toBe(2);
  });

  it('returns entries by entity ID', () => {
    const service = new AuditService(mockLogger());
    service.append({ action: 'a1', actor: 'user', entityType: 'test', entityId: 'entity-1', details: {} });
    service.append({ action: 'a2', actor: 'user', entityType: 'test', entityId: 'entity-2', details: {} });
    service.append({ action: 'a3', actor: 'user', entityType: 'test', entityId: 'entity-1', details: {} });
    const filtered = service.getEntriesByEntity('entity-1');
    expect(filtered).toHaveLength(2);
  });

  it('resets chain state', () => {
    const service = new AuditService(mockLogger());
    service.append({ action: 'a1', actor: 'user', entityType: 'test', entityId: '1', details: {} });
    expect(service.getEntries()).toHaveLength(1);
    service.reset();
    expect(service.getEntries()).toHaveLength(0);
    expect(service.verify().valid).toBe(true);
  });
});
