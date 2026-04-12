/**
 * ADR-PIPELINE-072 §6: Sector baseline waste / unit-cost / achievable-reduction
 * table. Consumed by the pre-render financial model to produce an initial
 * `unit-economics.json` BEFORE the prototype runs, so the ADR-066 tier-1
 * renderer path fires on the executive summary / decision memo / financial
 * analysis instead of falling to the per-employee heuristic.
 *
 * Numbers are conservative industry rules-of-thumb. The prototype is expected
 * to produce a more accurate manifest when its demo runs, and the ADR-072 §5
 * reconciler emits a warning on any drift >25%.
 *
 * Every entry must correspond to an entry in the ADR-066 sector registry
 * (`src/synthesis/domain-unit-registry.ts`). The integration test in
 * `tests/unit/pipeline/pre-render/sector-baselines-072.test.ts` enforces the
 * lockstep invariant.
 */

import type { Sector } from '../../synthesis/domain-unit-registry.js';

export interface SectorBaseline {
  /** Sector key — must match the ADR-066 registry. */
  readonly sector: Exclude<Sector, 'unknown'>;
  /** Human-readable label for the operational unit. */
  readonly unitLabel: string;
  /** Savings key (must match the registry's unitSavingsKey). */
  readonly unitSavingsKey: string;
  /** USD saved per operational unit per year, at baseline achievable reduction. */
  readonly usdPerUnitPerYear: number;
  /** Baseline waste rate (0..1) — what fraction of the unit cost is wasted today. */
  readonly baselineWasteRate: number;
  /** Achievable reduction (0..1) — what fraction of the waste can reasonably be eliminated. */
  readonly achievableReduction: number;
  /** Methodology string displayed in the rendered financial analysis. */
  readonly methodology: string;
  /** Short description of the unit cost basis (rooms × occupancy, etc.). */
  readonly unitCostBasis: string;
}

/**
 * ADR-PIPELINE-072 §6 — baseline table. Conservative industry rules-of-thumb.
 * The prototype's measured numbers will overwrite these during the real demo.
 */
export const SECTOR_BASELINES: readonly SectorBaseline[] = [
  {
    sector: 'hospitality',
    unitLabel: 'occupied room night',
    unitSavingsKey: 'usd_per_orn',
    usdPerUnitPerYear: 0.82,
    baselineWasteRate: 0.32,
    achievableReduction: 0.18,
    methodology: 'rooms × occupancy × $/occupied-room-night linen + water reduction',
    unitCostBasis: '0.32 kg linen/orn × $2.10/kg laundry',
  },
  {
    sector: 'airline-catering',
    unitLabel: 'meal loaded',
    unitSavingsKey: 'usd_per_meal_loaded',
    usdPerUnitPerYear: 0.92,
    baselineWasteRate: 0.18,
    achievableReduction: 0.22,
    methodology: 'meals × flights × 365 × $/meal-loaded waste reduction',
    unitCostBasis: '0.18 kg/meal × $4.20/meal loaded (loaded-to-consumed gap)',
  },
  {
    sector: 'commercial-real-estate',
    unitLabel: 'square foot-year',
    unitSavingsKey: 'usd_per_sqft_year',
    usdPerUnitPerYear: 0.25,
    baselineWasteRate: 0.20,
    achievableReduction: 0.15,
    methodology: 'sqft × $/sqft-year energy + HVAC reduction',
    unitCostBasis: '12 kWh/sqft-year × $0.14/kWh',
  },
  {
    sector: 'fleet',
    unitLabel: 'vehicle-mile',
    unitSavingsKey: 'usd_per_vehicle_mile',
    usdPerUnitPerYear: 0.28,
    baselineWasteRate: 0.20,
    achievableReduction: 0.12,
    methodology: 'fleet × miles × $/mile fuel + maintenance reduction',
    unitCostBasis: '0.65 gal/vehicle-mile × $3.80/gal',
  },
  {
    sector: 'retail',
    unitLabel: 'store-year',
    unitSavingsKey: 'usd_per_transaction',
    usdPerUnitPerYear: 14250,
    baselineWasteRate: 0.30,
    achievableReduction: 0.15,
    methodology: 'stores × $95K/yr energy × achievable reduction',
    unitCostBasis: '$95K/store/yr energy × 15% reduction ceiling',
  },
  {
    sector: 'manufacturing',
    unitLabel: 'unit produced',
    unitSavingsKey: 'usd_per_unit_produced',
    usdPerUnitPerYear: 0.85,
    baselineWasteRate: 0.023,
    achievableReduction: 0.25,
    methodology: 'throughput × $/unit scrap reduction',
    unitCostBasis: '2.3% scrap rate × $/unit',
  },
  {
    sector: 'healthcare',
    unitLabel: 'patient-day',
    unitSavingsKey: 'usd_per_patient_day',
    usdPerUnitPerYear: 0.22,
    baselineWasteRate: 0.18,
    achievableReduction: 0.20,
    methodology: 'census × $/patient-day disposal + material reduction',
    unitCostBasis: '0.8 kg waste/patient-day × $1.40/kg disposal',
  },
  {
    sector: 'data-center',
    unitLabel: 'kilowatt-hour',
    unitSavingsKey: 'usd_per_kwh',
    usdPerUnitPerYear: 0.018,
    baselineWasteRate: 0.23,
    achievableReduction: 0.18,
    methodology: 'load × 8760 × $/kWh PUE optimization',
    unitCostBasis: 'PUE 1.6 → 1.3 opportunity × $0.08/kWh',
  },
  {
    sector: 'call-center',
    unitLabel: 'contact minute',
    unitSavingsKey: 'usd_per_contact_minute',
    usdPerUnitPerYear: 0.09,
    baselineWasteRate: 0.12,
    achievableReduction: 0.14,
    methodology: 'agents × shifts × $/contact-minute overstaffing reduction',
    unitCostBasis: '12% overstaffing × $38/hr loaded',
  },
];

const BASELINE_BY_SECTOR: ReadonlyMap<Sector, SectorBaseline> = new Map(
  SECTOR_BASELINES.map(b => [b.sector as Sector, b]),
);

export function getSectorBaseline(sector: Sector): SectorBaseline | null {
  return BASELINE_BY_SECTOR.get(sector) ?? null;
}
