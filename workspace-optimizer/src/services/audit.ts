import { createHash, randomUUID } from 'node:crypto';
import type { Logger } from '../logger.js';
import type { AuditEntry } from '../types.js';
import { ValidationError } from '../errors.js';

const GENESIS_HASH = 'genesis';

export class AuditService {
  private chain: AuditEntry[] = [];

  constructor(private readonly logger: Logger) {}

  append(params: {
    action: string;
    actor: string;
    entityType: string;
    entityId: string;
    details: Record<string, unknown>;
  }): AuditEntry {
    const previousHash = this.chain.length > 0 ? this.chain[this.chain.length - 1].hash : GENESIS_HASH;

    const entry: AuditEntry = {
      id: randomUUID(),
      timestamp: new Date(),
      action: params.action,
      actor: params.actor,
      entityType: params.entityType,
      entityId: params.entityId,
      details: params.details,
      previousHash,
      hash: '', // computed below
    };

    entry.hash = this.computeHash(entry, previousHash);
    this.chain.push(entry);

    this.logger.info('audit.appended', {
      entryId: entry.id,
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId,
      chainLength: this.chain.length,
    });

    return entry;
  }

  verify(): { valid: boolean; chainLength: number; brokenAt?: number } {
    if (this.chain.length === 0) return { valid: true, chainLength: 0 };

    for (let i = 0; i < this.chain.length; i++) {
      const entry = this.chain[i];
      const expectedPrevious = i === 0 ? GENESIS_HASH : this.chain[i - 1].hash;

      if (entry.previousHash !== expectedPrevious) {
        this.logger.warn('audit.chain.broken', { index: i, entryId: entry.id });
        return { valid: false, chainLength: this.chain.length, brokenAt: i };
      }

      const recomputed = this.computeHash(entry, expectedPrevious);
      if (entry.hash !== recomputed) {
        this.logger.warn('audit.hash.mismatch', { index: i, entryId: entry.id });
        return { valid: false, chainLength: this.chain.length, brokenAt: i };
      }
    }

    return { valid: true, chainLength: this.chain.length };
  }

  getEntries(): ReadonlyArray<AuditEntry> {
    return [...this.chain];
  }

  getEntriesByEntity(entityId: string): AuditEntry[] {
    return this.chain.filter(e => e.entityId === entityId);
  }

  reset(): void {
    this.chain = [];
  }

  private computeHash(entry: AuditEntry, previousHash: string): string {
    const data = JSON.stringify({
      id: entry.id,
      timestamp: entry.timestamp.toISOString(),
      action: entry.action,
      actor: entry.actor,
      entityType: entry.entityType,
      entityId: entry.entityId,
      details: entry.details,
      previousHash,
    });
    return createHash('sha256').update(data).digest('hex');
  }
}
