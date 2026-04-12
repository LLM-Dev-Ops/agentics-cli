/**
 * ADR-PIPELINE-072 §2: Bottom-up financial model for the pre-render pass.
 *
 * Pure functions. Given a query + domain analysis + scenario, compute a
 * `UnitEconomics` shape with `source='prototype-preview'` that the executive
 * renderer's ADR-066 tier-1 path can consume.
 *
 * **Invariant: no per-employee math for savings.** Employees MAY appear as
 * context (region mix, scale reference) but MUST NOT be the multiplicand in
 * the savings formula. Every savings number derives from
 *     operational_units × unit_cost × waste_rate × achievable_reduction
 */

import type {
  UnitEconomics,
  UnitEconomicsScope,
  DomainUnit,
} from '../types.js';
import {
  classifySector,
  extractDomainScale,
  getSectorEntry,
  type Sector,
  type DomainScale,
} from '../../synthesis/domain-unit-registry.js';
import {
  getSectorBaseline,
  type SectorBaseline,
} from './sector-baselines.js';

// ============================================================================
// Public types
// ============================================================================

export interface PreRenderFinancialInput {
  readonly runId: string;
  readonly query: string;
  /** Sector hint from the domain-analysis / phase-4 output. Optional. */
  readonly sectorHint?: string | null;
  /** Operational scope from the scenario artifact. Optional. */
  readonly scopeOverrides?: Partial<UnitEconomicsScope>;
  /** Extrapolation scale factor — pilot_units / enterprise_units. */
  readonly scopeRatioOverride?: number;
}

export interface PreRenderFinancialOutput {
  readonly manifest: UnitEconomics;
  readonly metrics: {
    readonly sector: Sector;
    readonly domainScale: DomainScale;
    readonly baseline: SectorBaseline;
    readonly pilotOperationalUnits: number;
    readonly enterpriseOperationalUnits: number;
    readonly usdPerUnitPerYear: number;
    readonly annualMeasuredSavingsUsd: number;
    readonly annualExtrapolatedSavingsUsd: number;
    readonly confidence: number;
  };
}

export class PreRenderFinancialError extends Error {
  constructor(message: string, public readonly code = 'ECLI-PRERENDER-001') {
    super(`${code}: ${message}`);
    this.name = 'PreRenderFinancialError';
  }
}

// ============================================================================
// Entry point
// ============================================================================

/**
 * Compute a `unit-economics.json`-shaped manifest from the query + optional
 * domain analysis. Returns null when the sector is unknown (caller falls
 * back to ADR-066 tier-3 heuristic banner — worse than having a preview,
 * but still honest).
 */
export function computePreRenderUnitEconomics(
  input: PreRenderFinancialInput,
): PreRenderFinancialOutput | null {
  const sectorHint = input.sectorHint ?? null;
  const sector = classifySector(input.query, sectorHint);
  if (sector === 'unknown') {
    return null;
  }

  const baseline = getSectorBaseline(sector);
  const entry = getSectorEntry(sector);
  if (!baseline || !entry) {
    return null;
  }

  // Operational scale derivation. Prefer query-regex counts; fall back to
  // sector ratios. ADR-066 invariant: employees is context, not multiplicand.
  const domainScale = extractDomainScale(input.query, sectorHint);

  // Pilot scope: the operational units actually represented in the prototype
  // (a subset). Enterprise scope: the full network the executive narrative
  // applies to. Pilot→enterprise ratio defaults to 0.04 (e.g. 4% of meals
  // or 4% of rooms), which matches common pilot sizings observed across
  // the OPERA / Ramco / CRE readiness reviews. Caller can override.
  const scopeRatio = input.scopeRatioOverride ?? 25;
  const enterpriseOperationalUnits = Math.max(1, domainScale.operationalUnits);
  const pilotOperationalUnits = Math.max(1, Math.round(enterpriseOperationalUnits / scopeRatio));

  // Bottom-up savings. The baseline's usdPerUnitPerYear is already net of
  // achievable reduction — it's the savings-per-unit-per-year the pilot can
  // expect to realize. Multiply by the unit count to get annual savings.
  const pilotSavings = Math.round(pilotOperationalUnits * baseline.usdPerUnitPerYear);
  const enterpriseSavings = Math.round(enterpriseOperationalUnits * baseline.usdPerUnitPerYear);

  const measuredScope = buildScope(sector, pilotOperationalUnits, entry.scopeKeys, input.scopeOverrides);
  const enterpriseScope = buildScope(
    sector,
    enterpriseOperationalUnits,
    entry.scopeKeys,
    input.scopeOverrides,
    { employees: domainScale.employees },
  );

  const domainUnit: DomainUnit = entry.domainUnit;
  const unitSavings: Record<string, number> = {
    [baseline.unitSavingsKey]: baseline.usdPerUnitPerYear,
  };

  const manifest: UnitEconomics = {
    run_id: input.runId,
    sector,
    domain_unit: domainUnit,
    measured_scope: measuredScope,
    enterprise_scope: enterpriseScope,
    unit_savings: unitSavings,
    annual_measured_savings_usd: pilotSavings,
    annual_extrapolated_savings_usd: enterpriseSavings,
    extrapolation_method: `linear_by_${entry.scopeKeys[0] ?? 'units'}__${baseline.methodology.replace(/\s+/g, '_')}`,
    confidence: { directional: 0.88, precision: 0.42 },
    generated_at: new Date().toISOString(),
    source: 'prototype-preview',
  };

  return {
    manifest,
    metrics: {
      sector,
      domainScale,
      baseline,
      pilotOperationalUnits,
      enterpriseOperationalUnits,
      usdPerUnitPerYear: baseline.usdPerUnitPerYear,
      annualMeasuredSavingsUsd: pilotSavings,
      annualExtrapolatedSavingsUsd: enterpriseSavings,
      confidence: 0.7,
    },
  };
}

// ============================================================================
// Helpers
// ============================================================================

function buildScope(
  sector: Sector,
  operationalUnits: number,
  scopeKeys: readonly string[],
  overrides: Partial<UnitEconomicsScope> | undefined,
  extras: Partial<UnitEconomicsScope> = {},
): UnitEconomicsScope {
  const primaryKey = scopeKeys[0] ?? 'units';
  const scope: UnitEconomicsScope = {
    region_mix: overrides?.region_mix ?? ['NA', 'EMEA', 'APAC'],
    ...extras,
    ...overrides,
  };
  // Assign the operational-unit count to the primary scope key for this
  // sector. Keep type-safe by reading a mutable copy.
  const record = scope as Record<string, unknown>;
  if (!Object.prototype.hasOwnProperty.call(record, primaryKey) || record[primaryKey] === undefined) {
    record[primaryKey] = operationalUnits;
  }
  // Airline-catering prefers flights as the secondary scope; expose it
  // alongside the primary `units` key so renderers can display either.
  if (sector === 'airline-catering' && !record['properties']) {
    // properties column is used for flight count in the scope display
    record['properties'] = Math.max(1, Math.round(operationalUnits / 120)); // ~120 meals/flight
  }
  return scope;
}
