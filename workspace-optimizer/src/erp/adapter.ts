import { createHash, randomUUID } from 'node:crypto';
import type { AppConfig } from '../config.js';
import type { Logger } from '../logger.js';
import type { CircuitBreaker } from '../middleware.js';
import type { ERPTransaction, Scenario, Decision } from '../types.js';
import {
  mapDecisionToArchibus,
  SUPPORTED_SCHEMA_VERSIONS,
  DEFAULT_SCHEMA_VERSION,
  negotiateSchemaVersion,
  SchemaVersionError,
} from './schema.js';

export class ERPAdapter {
  /** ADR-058: Schema versions this adapter can produce payloads for */
  static readonly SUPPORTED_SCHEMA_VERSIONS = SUPPORTED_SCHEMA_VERSIONS;

  private transactions: Map<string, ERPTransaction> = new Map();
  private negotiatedVersion: string = DEFAULT_SCHEMA_VERSION;
  private versionNegotiated = false;

  constructor(
    private readonly config: AppConfig,
    private readonly logger: Logger,
    private readonly circuitBreaker: CircuitBreaker,
  ) {}

  /**
   * ADR-058: Negotiate schema version with remote Archibus instance.
   * In production, this would call GET /api/v1/system/version.
   * For the prototype, it validates the provided version against supported list.
   */
  async negotiateVersion(remoteVersion?: string): Promise<{
    effectiveVersion: string;
    warning?: string;
  }> {
    const version = remoteVersion ?? DEFAULT_SCHEMA_VERSION;
    const result = negotiateSchemaVersion(version);

    if (!result.compatible) {
      const error = new SchemaVersionError(
        SUPPORTED_SCHEMA_VERSIONS.join(', '),
        version,
      );
      this.logger.error('erp.schema.incompatible', error, {
        remoteVersion: version,
        supportedVersions: [...SUPPORTED_SCHEMA_VERSIONS],
      });
      throw error;
    }

    if (result.warning) {
      this.logger.warn('erp.schema.minor-mismatch', {
        remoteVersion: version,
        effectiveVersion: result.effectiveVersion,
        warning: result.warning,
      });
    } else {
      this.logger.info('erp.schema.negotiated', {
        version: result.effectiveVersion,
      });
    }

    this.negotiatedVersion = result.effectiveVersion;
    this.versionNegotiated = true;

    return {
      effectiveVersion: result.effectiveVersion,
      warning: result.warning,
    };
  }

  /** Returns the currently negotiated schema version */
  getSchemaVersion(): string {
    return this.negotiatedVersion;
  }

  async syncDecision(decision: Decision, scenario: Scenario, buildingId: string, floorId: string): Promise<ERPTransaction> {
    // Auto-negotiate on first call if not done explicitly
    if (!this.versionNegotiated) {
      await this.negotiateVersion();
    }

    const idempotencyKey = createHash('sha256')
      .update(`${decision.id}:${decision.createdAt.toISOString()}`)
      .digest('hex');

    // Check for existing transaction with this idempotency key
    for (const tx of this.transactions.values()) {
      if (tx.idempotencyKey === idempotencyKey) {
        this.logger.info('erp.idempotent.hit', { decisionId: decision.id, transactionId: tx.id });
        return tx;
      }
    }

    const payload = mapDecisionToArchibus(decision, scenario, buildingId, floorId, idempotencyKey);

    const transaction: ERPTransaction = {
      id: randomUUID(),
      decisionId: decision.id,
      simulationId: decision.simulationId,
      idempotencyKey,
      status: 'pending',
      payload,
      createdAt: new Date(),
      attempts: 0,
      schemaVersion: this.negotiatedVersion,
    };

    this.transactions.set(transaction.id, transaction);

    if (this.config.erp.dryRun) {
      transaction.status = 'confirmed';
      transaction.responseStatus = 200;
      transaction.attempts = 1;
      transaction.lastAttemptAt = new Date();
      this.logger.info('erp.sync.dryrun', {
        transactionId: transaction.id,
        decisionId: decision.id,
        schemaVersion: this.negotiatedVersion,
      });
      return transaction;
    }

    return this.sendWithRetry(transaction);
  }

  getTransaction(id: string): ERPTransaction | undefined {
    return this.transactions.get(id);
  }

  reset(): void {
    this.transactions.clear();
    this.versionNegotiated = false;
    this.negotiatedVersion = DEFAULT_SCHEMA_VERSION;
  }

  private async sendWithRetry(transaction: ERPTransaction): Promise<ERPTransaction> {
    const maxRetries = this.config.erp.maxRetries;
    const baseDelay = this.config.erp.retryBaseDelayMs;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      transaction.attempts = attempt;
      transaction.lastAttemptAt = new Date();

      try {
        await this.circuitBreaker.execute(async () => {
          this.logger.info('erp.sync.attempt', {
            transactionId: transaction.id,
            attempt,
            maxRetries,
            schemaVersion: this.negotiatedVersion,
          });
          transaction.status = 'confirmed';
          transaction.responseStatus = 200;
        });
        return transaction;
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        this.logger.warn('erp.sync.retry', {
          transactionId: transaction.id,
          attempt,
          error: err.message,
        });

        if (attempt < maxRetries) {
          await new Promise(resolve => setTimeout(resolve, baseDelay * Math.pow(2, attempt - 1)));
        }
      }
    }

    transaction.status = 'failed';
    this.logger.error('erp.sync.failed', new Error('Max retries exhausted'), {
      transactionId: transaction.id,
      attempts: transaction.attempts,
    });
    return transaction;
  }
}
