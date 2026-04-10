import type { Logger } from '../logger.js';
import type { AuditService } from './audit.js';
import type { ERPAdapter } from '../erp/adapter.js';
import type { Decision, Scenario, ERPTransaction } from '../types.js';

/**
 * ADR-056: Orchestrates ERP sync with audit chain entries.
 *
 * The ERPAdapter handles communication; this service handles the audit trail
 * around it. This keeps the adapter focused on ERP concerns and prevents
 * a circular dependency between ERPAdapter and AuditService.
 */
export class DecisionLifecycleService {
  constructor(
    private readonly audit: AuditService,
    private readonly erp: ERPAdapter,
    private readonly logger: Logger,
  ) {}

  async syncToErp(
    decision: Decision,
    scenario: Scenario,
    buildingId: string,
    floorId: string,
  ): Promise<ERPTransaction> {
    const startTime = Date.now();

    // 1. Audit: sync initiated
    this.audit.append({
      action: 'erp_sync_initiated',
      actor: 'system',
      entityType: 'erp_transaction',
      entityId: decision.id,
      details: {
        decisionId: decision.id,
        scenarioId: scenario.id,
        targetSystem: 'archibus',
        buildingId,
        floorId,
      },
    });

    try {
      const tx = await this.erp.syncDecision(decision, scenario, buildingId, floorId);
      const durationMs = Date.now() - startTime;

      if (tx.status === 'confirmed') {
        // 2a. Audit: sync completed
        this.audit.append({
          action: 'erp_sync_completed',
          actor: 'system',
          entityType: 'erp_transaction',
          entityId: tx.id,
          details: {
            decisionId: decision.id,
            transactionId: tx.id,
            responseStatus: tx.responseStatus ?? 200,
            durationMs,
            dryRun: tx.status === 'confirmed' && durationMs < 50, // heuristic for dry-run
            idempotencyKey: tx.idempotencyKey,
            attempts: tx.attempts,
          },
        });

        this.logger.info('lifecycle.erp.sync.completed', {
          decisionId: decision.id,
          transactionId: tx.id,
          durationMs,
        });
      } else {
        // 2b. Audit: sync failed (adapter exhausted retries but didn't throw)
        this.audit.append({
          action: 'erp_sync_failed',
          actor: 'system',
          entityType: 'erp_transaction',
          entityId: tx.id,
          details: {
            decisionId: decision.id,
            transactionId: tx.id,
            attempts: tx.attempts,
            finalStatus: tx.status,
            durationMs,
            idempotencyKey: tx.idempotencyKey,
          },
        });

        this.logger.warn('lifecycle.erp.sync.failed', {
          decisionId: decision.id,
          transactionId: tx.id,
          finalStatus: tx.status,
          attempts: tx.attempts,
        });
      }

      return tx;
    } catch (error) {
      const durationMs = Date.now() - startTime;
      const err = error instanceof Error ? error : new Error(String(error));

      // 2c. Audit: sync failed (adapter threw an exception)
      this.audit.append({
        action: 'erp_sync_failed',
        actor: 'system',
        entityType: 'erp_transaction',
        entityId: decision.id,
        details: {
          decisionId: decision.id,
          error: err.message,
          durationMs,
        },
      });

      this.logger.error('lifecycle.erp.sync.error', err, {
        decisionId: decision.id,
        durationMs,
      });

      throw error;
    }
  }
}
