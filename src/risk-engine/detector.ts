/**
 * Supply Risk Detector
 *
 * Analyzes inventory levels against demand forecasts to detect:
 *   - SHORTAGE: days-of-supply below reorder point
 *   - SURPLUS: days-of-supply above max threshold
 *   - IMBALANCE: one facility has drastically more stock than another for the same SKU
 */

import type { RiskThresholds } from './thresholds.js';

// ============================================================================
// Types
// ============================================================================

export interface InventorySnapshot {
  readonly facility_id: string;
  readonly sku: string;
  readonly quantity: number;
  readonly unit_of_measure: string;
}

export interface DemandSignal {
  readonly facility_id: string;
  readonly sku: string;
  readonly average_daily_usage: number;
}

export interface FacilityCapacity {
  readonly facility_id: string;
  readonly region: string;
  readonly max_transfer_quantity: number;
}

export type RiskType = 'shortage' | 'surplus' | 'imbalance';
export type Severity = 'critical' | 'high' | 'medium' | 'low';

export interface DetectedRisk {
  readonly facility_id: string;
  readonly sku: string;
  readonly risk_type: RiskType;
  readonly severity: Severity;
  readonly days_of_supply: number;
  readonly quantity_on_hand: number;
  readonly average_daily_usage: number;
  readonly message: string;
  /** For imbalance risks, the counterpart facility. */
  readonly counterpart_facility?: string;
  readonly counterpart_quantity?: number;
}

// ============================================================================
// SupplyRiskDetector
// ============================================================================

export class SupplyRiskDetector {
  constructor(private readonly thresholds: RiskThresholds) {}

  detect(
    inventory: readonly InventorySnapshot[],
    demand: readonly DemandSignal[],
    _capacities: readonly FacilityCapacity[],
  ): DetectedRisk[] {
    const risks: DetectedRisk[] = [];

    // Build demand lookup: facility_id:sku → average_daily_usage
    const demandMap = new Map<string, number>();
    for (const d of demand) {
      demandMap.set(`${d.facility_id}:${d.sku}`, d.average_daily_usage);
    }

    // Build inventory lookup by SKU across facilities (for imbalance detection)
    const skuFacilityMap = new Map<string, Array<{ facility_id: string; quantity: number }>>();
    for (const inv of inventory) {
      const existing = skuFacilityMap.get(inv.sku) ?? [];
      existing.push({ facility_id: inv.facility_id, quantity: inv.quantity });
      skuFacilityMap.set(inv.sku, existing);
    }

    // Per-item shortage and surplus detection
    for (const inv of inventory) {
      const dailyUsage = demandMap.get(`${inv.facility_id}:${inv.sku}`) ?? 0;
      const daysOfSupply = dailyUsage > 0
        ? inv.quantity / dailyUsage
        : inv.quantity > 0 ? Infinity : 0;

      // SHORTAGE detection
      if (daysOfSupply < this.thresholds.criticalDaysSupply) {
        risks.push({
          facility_id: inv.facility_id,
          sku: inv.sku,
          risk_type: 'shortage',
          severity: 'critical',
          days_of_supply: Math.round(daysOfSupply * 10) / 10,
          quantity_on_hand: inv.quantity,
          average_daily_usage: dailyUsage,
          message: `Critical shortage: ${inv.sku} at ${inv.facility_id} has ${Math.round(daysOfSupply * 10) / 10} days of supply (threshold: ${this.thresholds.criticalDaysSupply})`,
        });
      } else if (daysOfSupply < this.thresholds.warningDaysSupply) {
        risks.push({
          facility_id: inv.facility_id,
          sku: inv.sku,
          risk_type: 'shortage',
          severity: daysOfSupply < this.thresholds.criticalDaysSupply + 2 ? 'high' : 'medium',
          days_of_supply: Math.round(daysOfSupply * 10) / 10,
          quantity_on_hand: inv.quantity,
          average_daily_usage: dailyUsage,
          message: `Warning shortage: ${inv.sku} at ${inv.facility_id} has ${Math.round(daysOfSupply * 10) / 10} days of supply (threshold: ${this.thresholds.warningDaysSupply})`,
        });
      }

      // SURPLUS detection
      if (Number.isFinite(daysOfSupply) && daysOfSupply > this.thresholds.surplusDaysSupply) {
        risks.push({
          facility_id: inv.facility_id,
          sku: inv.sku,
          risk_type: 'surplus',
          severity: daysOfSupply > this.thresholds.surplusDaysSupply * 2 ? 'high' : 'medium',
          days_of_supply: Math.round(daysOfSupply * 10) / 10,
          quantity_on_hand: inv.quantity,
          average_daily_usage: dailyUsage,
          message: `Surplus: ${inv.sku} at ${inv.facility_id} has ${Math.round(daysOfSupply * 10) / 10} days of supply (max: ${this.thresholds.surplusDaysSupply})`,
        });
      }
    }

    // IMBALANCE detection across facilities for the same SKU
    for (const [sku, facilities] of skuFacilityMap) {
      if (facilities.length < 2) continue;

      // Sort by quantity descending
      const sorted = [...facilities].sort((a, b) => b.quantity - a.quantity);
      const highest = sorted[0]!;
      const lowest = sorted[sorted.length - 1]!;

      if (lowest.quantity === 0) continue;

      const ratio = highest.quantity / lowest.quantity;
      if (ratio >= this.thresholds.imbalanceRatio) {
        // Also check absolute days-of-supply for the low facility
        const lowDailyUsage = demandMap.get(`${lowest.facility_id}:${sku}`) ?? 1;
        const lowDaysSupply = lowest.quantity / lowDailyUsage;

        if (lowDaysSupply < 3) {
          risks.push({
            facility_id: lowest.facility_id,
            sku,
            risk_type: 'imbalance',
            severity: lowDaysSupply < 1 ? 'critical' : 'high',
            days_of_supply: Math.round(lowDaysSupply * 10) / 10,
            quantity_on_hand: lowest.quantity,
            average_daily_usage: lowDailyUsage,
            message: `Imbalance: ${sku} — ${lowest.facility_id} has ${lowest.quantity} units (${Math.round(lowDaysSupply * 10) / 10} days) while ${highest.facility_id} has ${highest.quantity} units (ratio: ${Math.round(ratio)}×)`,
            counterpart_facility: highest.facility_id,
            counterpart_quantity: highest.quantity,
          });
        }
      }
    }

    return risks;
  }
}
