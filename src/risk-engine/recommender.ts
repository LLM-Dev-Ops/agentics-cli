/**
 * Supply Risk Recommender
 *
 * Generates actionable recommendations from detected risks:
 *   - SHORTAGE → procurement order with suggested quantity and vendor
 *   - SURPLUS → transfer to understocked facility
 *   - IMBALANCE → inter-facility transfer with specific quantities
 *
 * Each recommendation includes estimated cost impact and urgency score.
 */

import type { DetectedRisk, FacilityCapacity } from './detector.js';
import type { RiskThresholds } from './thresholds.js';

// ============================================================================
// Types
// ============================================================================

export type RecommendationType = 'procurement' | 'transfer';

export interface Recommendation {
  readonly id: string;
  readonly risk_id: string;
  readonly type: RecommendationType;
  readonly facility_id: string;
  readonly sku: string;
  readonly urgency_score: number;
  readonly estimated_cost: number;
  readonly description: string;
  readonly status: 'pending' | 'executed' | 'dismissed';
  readonly created_at: string;
  /** For procurement recommendations. */
  readonly suggested_quantity?: number;
  readonly suggested_vendor_id?: string;
  /** For transfer recommendations. */
  readonly from_facility?: string;
  readonly to_facility?: string;
  readonly transfer_quantity?: number;
}

// ============================================================================
// Default cost table (per-unit estimates for healthcare supplies)
// ============================================================================

const DEFAULT_UNIT_COST = 25; // conservative per-unit cost estimate

// ============================================================================
// RiskRecommender
// ============================================================================

export class RiskRecommender {
  constructor(
    private readonly thresholds: RiskThresholds,
    private readonly capacities: readonly FacilityCapacity[],
  ) {}

  generateRecommendations(risks: readonly DetectedRisk[]): Recommendation[] {
    const recommendations: Recommendation[] = [];
    const now = new Date().toISOString();

    for (const risk of risks) {
      switch (risk.risk_type) {
        case 'shortage':
          recommendations.push(this.recommendProcurement(risk, now));
          break;
        case 'surplus':
          recommendations.push(...this.recommendTransferFromSurplus(risk, now));
          break;
        case 'imbalance':
          recommendations.push(this.recommendRebalanceTransfer(risk, now));
          break;
      }
    }

    // Sort by urgency descending
    recommendations.sort((a, b) => b.urgency_score - a.urgency_score);
    return recommendations;
  }

  private recommendProcurement(risk: DetectedRisk, now: string): Recommendation {
    // Calculate how much to order: bring facility up to warningDaysSupply + buffer
    const targetDays = this.thresholds.warningDaysSupply + 7;
    const deficit = Math.max(
      0,
      (targetDays * risk.average_daily_usage) - risk.quantity_on_hand,
    );
    const suggestedQuantity = Math.ceil(deficit / 10) * 10; // round up to nearest 10

    const urgency = this.computeUrgency(risk);
    const estimatedCost = suggestedQuantity * DEFAULT_UNIT_COST;

    return {
      id: `rec-${crypto.randomUUID().slice(0, 8)}`,
      risk_id: `${risk.facility_id}:${risk.sku}:${risk.risk_type}`,
      type: 'procurement',
      facility_id: risk.facility_id,
      sku: risk.sku,
      urgency_score: urgency,
      estimated_cost: estimatedCost,
      description: `Procure ${suggestedQuantity} units of ${risk.sku} for ${risk.facility_id} — ${risk.days_of_supply} days supply remaining`,
      status: 'pending',
      created_at: now,
      suggested_quantity: suggestedQuantity,
      suggested_vendor_id: this.pickVendor(risk.sku),
    };
  }

  private recommendTransferFromSurplus(risk: DetectedRisk, now: string): Recommendation[] {
    // Find understocked facilities for this SKU (from the risk list or use nearest)
    const nearestUnderstocked = this.findNearestFacility(risk.facility_id, risk.sku);
    if (!nearestUnderstocked) return [];

    // Transfer enough to bring surplus back to max threshold
    const excessDays = risk.days_of_supply - this.thresholds.surplusDaysSupply;
    const transferQuantity = Math.floor(excessDays * risk.average_daily_usage * 0.5);
    if (transferQuantity <= 0) return [];

    const urgency = this.computeUrgency(risk);
    const estimatedCost = transferQuantity * 2; // transfer cost is low

    return [{
      id: `rec-${crypto.randomUUID().slice(0, 8)}`,
      risk_id: `${risk.facility_id}:${risk.sku}:${risk.risk_type}`,
      type: 'transfer',
      facility_id: risk.facility_id,
      sku: risk.sku,
      urgency_score: urgency,
      estimated_cost: estimatedCost,
      description: `Transfer ${transferQuantity} units of ${risk.sku} from ${risk.facility_id} (surplus) to ${nearestUnderstocked}`,
      status: 'pending',
      created_at: now,
      from_facility: risk.facility_id,
      to_facility: nearestUnderstocked,
      transfer_quantity: transferQuantity,
    }];
  }

  private recommendRebalanceTransfer(risk: DetectedRisk, now: string): Recommendation {
    const counterpart = risk.counterpart_facility ?? 'unknown';
    const counterpartQty = risk.counterpart_quantity ?? 0;

    // Transfer enough to equalize within reason
    const totalStock = risk.quantity_on_hand + counterpartQty;
    const equalShare = Math.floor(totalStock / 2);
    const transferQuantity = Math.min(
      equalShare - risk.quantity_on_hand,
      Math.floor(counterpartQty * 0.3), // don't take more than 30% from counterpart
    );

    const urgency = this.computeUrgency(risk);
    const estimatedCost = Math.max(transferQuantity, 0) * 2;

    return {
      id: `rec-${crypto.randomUUID().slice(0, 8)}`,
      risk_id: `${risk.facility_id}:${risk.sku}:${risk.risk_type}`,
      type: 'transfer',
      facility_id: risk.facility_id,
      sku: risk.sku,
      urgency_score: urgency,
      estimated_cost: estimatedCost,
      description: `Rebalance ${Math.max(transferQuantity, 0)} units of ${risk.sku} from ${counterpart} to ${risk.facility_id}`,
      status: 'pending',
      created_at: now,
      from_facility: counterpart,
      to_facility: risk.facility_id,
      transfer_quantity: Math.max(transferQuantity, 0),
    };
  }

  private computeUrgency(risk: DetectedRisk): number {
    const severityScores: Record<string, number> = {
      critical: 100,
      high: 75,
      medium: 50,
      low: 25,
    };
    let base = severityScores[risk.severity] ?? 50;

    // Boost urgency for very low days-of-supply
    if (risk.days_of_supply < 1) base += 20;
    else if (risk.days_of_supply < 3) base += 10;

    // Cap at 100
    return Math.min(100, base);
  }

  private findNearestFacility(excludeFacility: string, _sku: string): string | null {
    // Use capacity data to find another facility in the same or nearest region
    const current = this.capacities.find((c) => c.facility_id === excludeFacility);
    if (!current) return this.capacities.find((c) => c.facility_id !== excludeFacility)?.facility_id ?? null;

    // Prefer same-region facilities
    const sameRegion = this.capacities.find(
      (c) => c.facility_id !== excludeFacility && c.region === current.region,
    );
    if (sameRegion) return sameRegion.facility_id;

    // Fall back to any other facility
    return this.capacities.find((c) => c.facility_id !== excludeFacility)?.facility_id ?? null;
  }

  private pickVendor(_sku: string): string {
    // In production, this would look up preferred vendors per SKU
    return 'vendor-default';
  }
}
