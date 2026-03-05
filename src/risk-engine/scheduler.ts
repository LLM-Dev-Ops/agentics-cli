/**
 * Risk Scan Scheduler
 *
 * Runs the SupplyRiskDetector on a configurable interval (default: 15 min).
 * Persists alerts, generates recommendations, and optionally auto-executes
 * critical actions when auto_action is enabled.
 */

import type { InventorySnapshot, DemandSignal, FacilityCapacity, DetectedRisk } from './detector.js';
import type { RiskThresholds } from './thresholds.js';
import type { Recommendation } from './recommender.js';
import { SupplyRiskDetector } from './detector.js';
import { RiskRecommender } from './recommender.js';

// ============================================================================
// Types
// ============================================================================

export interface PersistedAlert {
  readonly id: string;
  readonly risk: DetectedRisk;
  readonly status: 'open' | 'resolved';
  readonly created_at: string;
  readonly resolved_at?: string;
  readonly resolved_by?: string;
  readonly resolution_notes?: string;
}

/** Adapter for fetching live inventory/demand data and persisting results. */
export interface RiskDataAdapter {
  /** Return current inventory across all facilities. */
  getInventorySnapshots(): Promise<readonly InventorySnapshot[]>;
  /** Return demand signals (average daily usage per facility+SKU). */
  getDemandSignals(): Promise<readonly DemandSignal[]>;
  /** Return facility capacity metadata. */
  getFacilityCapacities(): Promise<readonly FacilityCapacity[]>;
  /** Persist a new alert row. */
  persistAlert(alert: PersistedAlert): Promise<void>;
  /** Execute a recommendation (create transfer or procurement order). */
  executeRecommendation(rec: Recommendation): Promise<{ success: boolean; order_id?: string }>;
}

export interface ScanResult {
  readonly scan_id: string;
  readonly timestamp: string;
  readonly risks_detected: number;
  readonly recommendations_generated: number;
  readonly auto_executed: number;
  readonly alerts: readonly PersistedAlert[];
  readonly recommendations: readonly Recommendation[];
}

// ============================================================================
// RiskScanScheduler
// ============================================================================

export class RiskScanScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly detector: SupplyRiskDetector;
  private readonly recommender: RiskRecommender;
  private lastScan: ScanResult | null = null;

  /** In-memory alert store (production would use DB). */
  private readonly alerts = new Map<string, PersistedAlert>();
  /** In-memory recommendation store. */
  private readonly recommendations = new Map<string, Recommendation>();

  constructor(
    private readonly thresholds: RiskThresholds,
    private readonly adapter: RiskDataAdapter,
    capacities: readonly FacilityCapacity[] = [],
  ) {
    this.detector = new SupplyRiskDetector(thresholds);
    this.recommender = new RiskRecommender(thresholds, capacities);
  }

  /** Start the periodic scan. Default interval: 15 minutes. */
  start(intervalMs = 15 * 60 * 1000): void {
    if (this.timer) return;
    // Run immediately, then on interval
    void this.runScan();
    this.timer = setInterval(() => void this.runScan(), intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  get isRunning(): boolean {
    return this.timer !== null;
  }

  get lastScanResult(): ScanResult | null {
    return this.lastScan;
  }

  /** Trigger an immediate scan (also called by the POST /risk/scan endpoint). */
  async runScan(): Promise<ScanResult> {
    const [inventory, demand, capacities] = await Promise.all([
      this.adapter.getInventorySnapshots(),
      this.adapter.getDemandSignals(),
      this.adapter.getFacilityCapacities(),
    ]);

    // Detect risks
    const risks = this.detector.detect(inventory, demand, capacities);

    // Generate recommendations
    const recs = this.recommender.generateRecommendations(risks);

    const now = new Date().toISOString();
    const scanId = `scan-${crypto.randomUUID().slice(0, 8)}`;
    const newAlerts: PersistedAlert[] = [];
    let autoExecuted = 0;

    // Persist alerts
    for (const risk of risks) {
      const alertId = `alert-${crypto.randomUUID().slice(0, 8)}`;
      const alert: PersistedAlert = {
        id: alertId,
        risk,
        status: 'open',
        created_at: now,
      };
      this.alerts.set(alertId, alert);
      newAlerts.push(alert);
      await this.adapter.persistAlert(alert);
    }

    // Store recommendations
    for (const rec of recs) {
      this.recommendations.set(rec.id, rec);
    }

    // Auto-execute critical recommendations if enabled
    if (this.thresholds.autoActionEnabled) {
      for (const rec of recs) {
        if (
          rec.urgency_score >= 90 &&
          rec.estimated_cost <= this.thresholds.autoActionMaxValue
        ) {
          const result = await this.adapter.executeRecommendation(rec);
          if (result.success) {
            autoExecuted++;
            this.recommendations.set(rec.id, { ...rec, status: 'executed' });
          }
        }
      }
    }

    const scanResult: ScanResult = {
      scan_id: scanId,
      timestamp: now,
      risks_detected: risks.length,
      recommendations_generated: recs.length,
      auto_executed: autoExecuted,
      alerts: newAlerts,
      recommendations: recs,
    };

    this.lastScan = scanResult;
    return scanResult;
  }

  // ── Alert queries ──────────────────────────────────────────────────────

  getAlerts(filter?: { status?: 'open' | 'resolved'; facility_id?: string; sku?: string }): PersistedAlert[] {
    let results = Array.from(this.alerts.values());
    if (filter?.status) results = results.filter((a) => a.status === filter.status);
    if (filter?.facility_id) results = results.filter((a) => a.risk.facility_id === filter.facility_id);
    if (filter?.sku) results = results.filter((a) => a.risk.sku === filter.sku);
    return results.sort((a, b) => b.created_at.localeCompare(a.created_at));
  }

  resolveAlert(alertId: string, resolvedBy: string, notes?: string): PersistedAlert | null {
    const alert = this.alerts.get(alertId);
    if (!alert || alert.status === 'resolved') return null;
    const resolved: PersistedAlert = {
      ...alert,
      status: 'resolved',
      resolved_at: new Date().toISOString(),
      resolved_by: resolvedBy,
      resolution_notes: notes,
    };
    this.alerts.set(alertId, resolved);
    return resolved;
  }

  // ── Recommendation queries ─────────────────────────────────────────────

  getRecommendations(filter?: { status?: 'pending' | 'executed' | 'dismissed' }): Recommendation[] {
    let results = Array.from(this.recommendations.values());
    if (filter?.status) results = results.filter((r) => r.status === filter.status);
    return results.sort((a, b) => b.urgency_score - a.urgency_score);
  }

  async executeRecommendation(recId: string): Promise<{ success: boolean; order_id?: string } | null> {
    const rec = this.recommendations.get(recId);
    if (!rec || rec.status !== 'pending') return null;

    const result = await this.adapter.executeRecommendation(rec);
    if (result.success) {
      this.recommendations.set(recId, { ...rec, status: 'executed' });
    }
    return result;
  }
}
