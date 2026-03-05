/**
 * Integration test: Inventory lifecycle operations via mock adapters.
 *
 * Tests upsert, update, query-by-facility, and audit trail recording
 * using an in-memory Map-based DbClient.
 */

import { AuditTrailService } from '../../src/compliance/audit-trail.js';
import type { DbClient, AuditRecord } from '../../src/compliance/audit-trail.js';

// ---------------------------------------------------------------------------
// Mock DbClient — stores rows in Maps keyed by table name
// ---------------------------------------------------------------------------

interface InventoryRow {
  id: string;
  facility_id: string;
  sku: string;
  quantity: number;
  unit_of_measure: string;
  updated_at: string;
}

function createMockDbClient(): DbClient & {
  inventoryStore: Map<string, InventoryRow>;
  auditLog: AuditRecord[];
} {
  const inventoryStore = new Map<string, InventoryRow>();
  const auditLog: AuditRecord[] = [];

  return {
    inventoryStore,
    auditLog,

    async query(sql: string, params: unknown[]): Promise<unknown[]> {
      // Route based on SQL content
      if (sql.includes('audit_log') && sql.includes('correlation_id')) {
        const correlationId = params[0] as string;
        return auditLog.filter((r) => r.correlation_id === correlationId);
      }
      if (sql.includes('audit_log') && sql.includes('ORDER BY sequence_number')) {
        return [...auditLog].sort((a, b) => a.sequence_number - b.sequence_number);
      }
      if (sql.includes('inventory') && sql.includes('facility_id')) {
        const facilityId = params[0] as string;
        return Array.from(inventoryStore.values()).filter(
          (r) => r.facility_id === facilityId,
        );
      }
      if (sql.includes('inventory') && sql.includes('id =')) {
        const id = params[0] as string;
        const row = inventoryStore.get(id);
        return row ? [row] : [];
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
      if (sql.includes('INSERT INTO inventory') || sql.includes('UPSERT')) {
        const row: InventoryRow = {
          id: params[0] as string,
          facility_id: params[1] as string,
          sku: params[2] as string,
          quantity: params[3] as number,
          unit_of_measure: params[4] as string,
          updated_at: params[5] as string,
        };
        inventoryStore.set(row.id, row);
      }
      if (sql.includes('UPDATE inventory')) {
        const quantity = params[0] as number;
        const updatedAt = params[1] as string;
        const id = params[2] as string;
        const existing = inventoryStore.get(id);
        if (existing) {
          inventoryStore.set(id, { ...existing, quantity, updated_at: updatedAt });
        }
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Inventory adapter — thin layer over DbClient
// ---------------------------------------------------------------------------

interface InventoryAdapter {
  upsert(row: Omit<InventoryRow, 'updated_at'>): Promise<InventoryRow>;
  updateQuantity(id: string, newQuantity: number): Promise<InventoryRow | null>;
  queryByFacility(facilityId: string): Promise<InventoryRow[]>;
}

function createInventoryAdapter(
  db: DbClient & { inventoryStore: Map<string, InventoryRow> },
): InventoryAdapter {
  return {
    async upsert(row) {
      const now = new Date().toISOString();
      const full: InventoryRow = { ...row, updated_at: now };
      await db.execute(
        'INSERT INTO inventory (id, facility_id, sku, quantity, unit_of_measure, updated_at) VALUES ($1,$2,$3,$4,$5,$6)',
        [full.id, full.facility_id, full.sku, full.quantity, full.unit_of_measure, full.updated_at],
      );
      return full;
    },

    async updateQuantity(id, newQuantity) {
      const now = new Date().toISOString();
      await db.execute(
        'UPDATE inventory SET quantity=$1, updated_at=$2 WHERE id=$3',
        [newQuantity, now, id],
      );
      return db.inventoryStore.get(id) ?? null;
    },

    async queryByFacility(facilityId) {
      const rows = await db.query(
        'SELECT * FROM inventory WHERE facility_id = $1',
        [facilityId],
      );
      return rows as InventoryRow[];
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Inventory lifecycle (integration)', () => {
  let db: ReturnType<typeof createMockDbClient>;
  let adapter: InventoryAdapter;
  let auditService: AuditTrailService;

  beforeEach(() => {
    db = createMockDbClient();
    adapter = createInventoryAdapter(db);
    auditService = new AuditTrailService(db);
  });

  it('upserts a new inventory record and verifies it in the store', async () => {
    const row = await adapter.upsert({
      id: 'inv-001',
      facility_id: 'FAC-A',
      sku: 'SKU-100',
      quantity: 250,
      unit_of_measure: 'EA',
    });

    expect(row.id).toBe('inv-001');
    expect(row.facility_id).toBe('FAC-A');
    expect(row.quantity).toBe(250);
    expect(db.inventoryStore.has('inv-001')).toBe(true);
    expect(db.inventoryStore.get('inv-001')!.quantity).toBe(250);
  });

  it('updates quantity of an existing record', async () => {
    await adapter.upsert({
      id: 'inv-002',
      facility_id: 'FAC-A',
      sku: 'SKU-200',
      quantity: 100,
      unit_of_measure: 'EA',
    });

    const updated = await adapter.updateQuantity('inv-002', 75);
    expect(updated).not.toBeNull();
    expect(updated!.quantity).toBe(75);
    expect(db.inventoryStore.get('inv-002')!.quantity).toBe(75);
  });

  it('queries by facility_id and returns correct records', async () => {
    await adapter.upsert({ id: 'inv-A1', facility_id: 'FAC-A', sku: 'SKU-1', quantity: 10, unit_of_measure: 'EA' });
    await adapter.upsert({ id: 'inv-A2', facility_id: 'FAC-A', sku: 'SKU-2', quantity: 20, unit_of_measure: 'EA' });
    await adapter.upsert({ id: 'inv-B1', facility_id: 'FAC-B', sku: 'SKU-1', quantity: 30, unit_of_measure: 'EA' });

    const facARows = await adapter.queryByFacility('FAC-A');
    expect(facARows).toHaveLength(2);
    expect(facARows.every((r) => r.facility_id === 'FAC-A')).toBe(true);

    const facBRows = await adapter.queryByFacility('FAC-B');
    expect(facBRows).toHaveLength(1);
    expect(facBRows[0]!.sku).toBe('SKU-1');
  });

  it('audit trail records before and after entries for each mutation', async () => {
    // Simulate an upsert with audit
    const correlationId = 'corr-001';
    await auditService.recordBefore(
      correlationId,
      'user-1',
      'POST /api/v1/inventory',
      'inventory',
      { sku: 'SKU-100', quantity: 250 },
    );

    await adapter.upsert({
      id: 'inv-audit-1',
      facility_id: 'FAC-A',
      sku: 'SKU-100',
      quantity: 250,
      unit_of_measure: 'EA',
    });

    await auditService.recordAfter(
      correlationId,
      'user-1',
      'POST /api/v1/inventory',
      'inventory',
      'inv-audit-1',
      { id: 'inv-audit-1', quantity: 250 },
      201,
      12,
      true,
    );

    const auditRecords = await auditService.getByCorrelationId(correlationId);
    expect(auditRecords).toHaveLength(2);

    const beforeRecord = auditRecords.find((r) => r.phase === 'before');
    const afterRecord = auditRecords.find((r) => r.phase === 'after');
    expect(beforeRecord).toBeDefined();
    expect(afterRecord).toBeDefined();
    expect(beforeRecord!.action).toBe('POST /api/v1/inventory');
    expect(afterRecord!.success).toBe(true);
    expect(afterRecord!.entity_id).toBe('inv-audit-1');
  });

  it('audit records have incrementing sequence numbers', async () => {
    await auditService.recordBefore('corr-a', 'user-1', 'POST', 'inventory', {});
    await auditService.recordAfter('corr-a', 'user-1', 'POST', 'inventory', null, {}, 200, 5, true);
    await auditService.recordBefore('corr-b', 'user-2', 'PUT', 'inventory', {});
    await auditService.recordAfter('corr-b', 'user-2', 'PUT', 'inventory', null, {}, 200, 3, true);

    expect(db.auditLog).toHaveLength(4);
    for (let i = 1; i < db.auditLog.length; i++) {
      expect(db.auditLog[i]!.sequence_number).toBeGreaterThan(
        db.auditLog[i - 1]!.sequence_number,
      );
    }
  });
});
