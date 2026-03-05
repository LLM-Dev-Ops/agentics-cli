/**
 * Healthcare supply-chain audit trail — tamper-evident, hash-chained logging
 * middleware and service for Hono HTTP handlers.
 */

import { createHash } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import type { MiddlewareHandler } from 'hono';
import { createMiddleware } from 'hono/factory';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AuditRecord {
  id: string;
  sequence_number: number;
  timestamp: string;
  correlation_id: string;
  actor: string;
  action: string;
  entity_type: string;
  entity_id: string | null;
  phase: 'before' | 'after';
  request_body: unknown;
  response_body: unknown;
  response_status: number | null;
  duration_ms: number | null;
  success: boolean | null;
  erp_wire_format: unknown;
  checksum: string;
  previous_checksum: string;
}

export interface DbClient {
  query(sql: string, params: unknown[]): Promise<unknown[]>;
  execute(sql: string, params: unknown[]): Promise<void>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ENTITY_KEYWORDS = [
  'inventory',
  'forecasts',
  'risk',
  'transfers',
  'procurement',
  'netsuite',
  'dashboard',
] as const;

export function deriveEntityType(path: string): string {
  const segments = path.split('/').filter(Boolean);
  for (const segment of segments) {
    const lower = segment.toLowerCase();
    if ((ENTITY_KEYWORDS as readonly string[]).includes(lower)) {
      return lower;
    }
  }
  return 'unknown';
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class AuditTrailService {
  private lastChecksum = '';
  private sequenceNumber = 0;

  constructor(private readonly db: DbClient) {}

  computeChecksum(record: Omit<AuditRecord, 'checksum'>): string {
    const payload = JSON.stringify(record) + record.previous_checksum;
    return createHash('sha256').update(payload).digest('hex');
  }

  async recordBefore(
    correlationId: string,
    actor: string,
    action: string,
    entityType: string,
    requestBody: unknown,
    erpWireFormat: unknown = null,
  ): Promise<AuditRecord> {
    return this.persist({
      correlationId,
      actor,
      action,
      entityType,
      entityId: null,
      phase: 'before' as const,
      requestBody,
      responseBody: null,
      responseStatus: null,
      durationMs: null,
      success: null,
      erpWireFormat,
    });
  }

  async recordAfter(
    correlationId: string,
    actor: string,
    action: string,
    entityType: string,
    entityId: string | null,
    responseBody: unknown,
    responseStatus: number,
    durationMs: number,
    success: boolean,
    erpWireFormat: unknown = null,
  ): Promise<AuditRecord> {
    return this.persist({
      correlationId,
      actor,
      action,
      entityType,
      entityId,
      phase: 'after' as const,
      requestBody: null,
      responseBody,
      responseStatus,
      durationMs,
      success,
      erpWireFormat,
    });
  }

  async getByCorrelationId(correlationId: string): Promise<AuditRecord[]> {
    const rows = await this.db.query(
      'SELECT * FROM audit_log WHERE correlation_id = $1 ORDER BY sequence_number',
      [correlationId],
    );
    return rows as AuditRecord[];
  }

  async verifyChainIntegrity(): Promise<{ valid: boolean; brokenAt?: number }> {
    const rows = (await this.db.query(
      'SELECT * FROM audit_log ORDER BY sequence_number',
      [],
    )) as AuditRecord[];

    let previousChecksum = '';
    for (const row of rows) {
      const { checksum: _stored, ...rest } = row;
      const expected = this.computeChecksum({ ...rest, previous_checksum: previousChecksum });
      if (expected !== row.checksum) {
        return { valid: false, brokenAt: row.sequence_number };
      }
      previousChecksum = row.checksum;
    }
    return { valid: true };
  }

  // -----------------------------------------------------------------------

  private async persist(params: {
    correlationId: string;
    actor: string;
    action: string;
    entityType: string;
    entityId: string | null;
    phase: 'before' | 'after';
    requestBody: unknown;
    responseBody: unknown;
    responseStatus: number | null;
    durationMs: number | null;
    success: boolean | null;
    erpWireFormat: unknown;
  }): Promise<AuditRecord> {
    this.sequenceNumber += 1;

    const partial: Omit<AuditRecord, 'checksum'> = {
      id: randomUUID(),
      sequence_number: this.sequenceNumber,
      timestamp: new Date().toISOString(),
      correlation_id: params.correlationId,
      actor: params.actor,
      action: params.action,
      entity_type: params.entityType,
      entity_id: params.entityId,
      phase: params.phase,
      request_body: params.requestBody,
      response_body: params.responseBody,
      response_status: params.responseStatus,
      duration_ms: params.durationMs,
      success: params.success,
      erp_wire_format: params.erpWireFormat,
      previous_checksum: this.lastChecksum,
    };

    const checksum = this.computeChecksum(partial);
    const record: AuditRecord = { ...partial, checksum };
    this.lastChecksum = checksum;

    await this.db.execute(
      `INSERT INTO audit_log (
        id, sequence_number, timestamp, correlation_id, actor, action,
        entity_type, entity_id, phase, request_body, response_body,
        response_status, duration_ms, success, erp_wire_format,
        checksum, previous_checksum
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17
      )`,
      [
        record.id,
        record.sequence_number,
        record.timestamp,
        record.correlation_id,
        record.actor,
        record.action,
        record.entity_type,
        record.entity_id,
        record.phase,
        JSON.stringify(record.request_body),
        JSON.stringify(record.response_body),
        record.response_status,
        record.duration_ms,
        record.success,
        JSON.stringify(record.erp_wire_format),
        record.checksum,
        record.previous_checksum,
      ],
    );

    return record;
  }
}

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

const WRITE_METHODS = new Set(['POST', 'PUT', 'DELETE']);

export function createAuditMiddleware(
  auditService: AuditTrailService,
): MiddlewareHandler {
  return createMiddleware(async (c, next) => {
    if (!WRITE_METHODS.has(c.req.method)) {
      await next();
      return;
    }

    const startTime = Date.now();
    const actor: string =
      (c.get('iamClaims') as { sub?: string } | undefined)?.sub ?? 'anonymous';
    const correlationId: string =
      (c.get('correlationId') as string | undefined) ?? randomUUID();
    const action = `${c.req.method} ${c.req.path}`;
    const entityType = deriveEntityType(c.req.path);

    let requestBody: unknown = null;
    try {
      requestBody = await c.req.json();
    } catch {
      /* no JSON body */
    }

    try {
      await auditService.recordBefore(
        correlationId,
        actor,
        action,
        entityType,
        requestBody,
      );
    } catch {
      /* audit must not break request */
    }

    await next();

    let responseBody: unknown = null;
    let entityId: string | null = null;
    try {
      const cloned = c.res.clone();
      responseBody = await cloned.json();
      if (
        responseBody &&
        typeof responseBody === 'object' &&
        'id' in (responseBody as Record<string, unknown>)
      ) {
        entityId = String((responseBody as Record<string, unknown>).id);
      }
    } catch {
      /* non-JSON response */
    }

    const durationMs = Date.now() - startTime;
    const responseStatus = c.res.status;
    const success = responseStatus >= 200 && responseStatus < 400;

    try {
      await auditService.recordAfter(
        correlationId,
        actor,
        action,
        entityType,
        entityId,
        responseBody,
        responseStatus,
        durationMs,
        success,
      );
    } catch {
      /* audit must not break request */
    }
  });
}
