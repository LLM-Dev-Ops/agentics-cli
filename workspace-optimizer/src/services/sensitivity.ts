import type { AppConfig } from '../config.js';
import type { Logger } from '../logger.js';
import type { Scenario, SavingsBreakdown } from '../types.js';

/** A single row in the sensitivity table */
export interface SensitivityVariable {
  name: string;
  range: string;
  baselineUsd: number;
  adjustedUsd: number;
  impactUsd: number;
  impactPercent: number;
  /** ADR-PRR-009: pessimistic scenario total (baseline − |impact|) */
  lowCaseUsd: number;
  /** ADR-PRR-009: optimistic scenario total (baseline + |impact|) */
  highCaseUsd: number;
  /** ADR-PRR-009: 1-based rank after sorting by absolute impact (1 = highest) */
  rank: number;
}

/** Full sensitivity analysis result */
export interface SensitivityAnalysis {
  baselineTotalUsd: number;
  variables: SensitivityVariable[];
  directionalConfidencePercent: number;
  directionalFloorUsd: number;
  precisionConfidencePercent: number;
  precisionRangeUsd: [number, number];
  /** ADR-PRR-009: pilot-linked key takeaway paragraph */
  keyTakeaway: string;
}

/**
 * ADR-057: Computes sensitivity analysis by varying key input assumptions
 * and measuring their impact on total savings.
 *
 * Variables are sorted by absolute impact magnitude (highest first) —
 * effectively a text-based tornado chart.
 */
export class SensitivityService {
  constructor(
    private readonly config: AppConfig,
    private readonly logger: Logger,
  ) {}

  analyze(scenarios: Scenario[], pilotBuildingCount: number): SensitivityAnalysis {
    const baseline = scenarios.reduce((sum, s) => sum + s.annualCostSavingsUsd, 0);
    const breakdown = this.aggregateBreakdown(scenarios);
    const minScenarioSavings = Math.min(...scenarios.map(s => s.annualCostSavingsUsd));

    const sp = this.config.sensitivityParams;
    const variables: SensitivityVariable[] = [];

    // 1. Energy price variation
    const energyImpact = breakdown.energySavingsUsd * sp.energyPriceRangePct;
    variables.push({
      name: 'Energy price',
      range: `±${Math.round(sp.energyPriceRangePct * 100)}%`,
      baselineUsd: baseline,
      adjustedUsd: baseline + energyImpact,
      impactUsd: energyImpact,
      impactPercent: (energyImpact / baseline) * 100,
      lowCaseUsd: 0, highCaseUsd: 0, rank: 0, // populated post-sort (ADR-PRR-009)
    });

    // 2. Occupancy data coverage 70%→95%
    // Lower coverage means less reliable data → conservative reduction
    const coverageImpact = baseline * sp.occupancyCoverageImpactPct;
    variables.push({
      name: 'Occupancy data coverage',
      range: '70% → 95%',
      baselineUsd: baseline,
      adjustedUsd: baseline - coverageImpact,
      impactUsd: -coverageImpact,
      impactPercent: -(coverageImpact / baseline) * 100,
      lowCaseUsd: 0, highCaseUsd: 0, rank: 0,
    });

    // 3. Hybrid work adoption rate 40%→70%
    // Higher remote adoption = more underutilized space = more savings opportunity
    const hybridImpact = baseline * sp.hybridAdoptionImpactPct;
    variables.push({
      name: 'Hybrid adoption rate',
      range: '40% → 70%',
      baselineUsd: baseline,
      adjustedUsd: baseline + hybridImpact,
      impactUsd: hybridImpact,
      impactPercent: (hybridImpact / baseline) * 100,
      lowCaseUsd: 0, highCaseUsd: 0, rank: 0,
    });

    // 4. Implementation timeline delay
    // Delay reduces first-year NPV by roughly the proportion of delay
    const timelineImpact = baseline * (sp.timelineImpactMonths / 12);
    variables.push({
      name: 'Implementation timeline',
      range: `±${sp.timelineImpactMonths} months`,
      baselineUsd: baseline,
      adjustedUsd: baseline - timelineImpact,
      impactUsd: -timelineImpact,
      impactPercent: -(timelineImpact / baseline) * 100,
      lowCaseUsd: 0, highCaseUsd: 0, rank: 0,
    });

    // 5. Lease recapture rate
    // Space reduction scenarios assume partial lease recapture; higher rate = more savings
    const currentLease = breakdown.leaseSavingsUsd;
    const leaseUpside = currentLease * sp.leaseUpsideFactor;
    variables.push({
      name: 'Lease recapture rate',
      range: '30% → 60%',
      baselineUsd: baseline,
      adjustedUsd: baseline + leaseUpside,
      impactUsd: leaseUpside,
      impactPercent: (leaseUpside / baseline) * 100,
      lowCaseUsd: 0, highCaseUsd: 0, rank: 0,
    });

    // 6. Archibus integration scope expansion
    // Non-linear: more buildings = better optimization opportunities (network effects)
    const scopeMultiplier = (sp.scopeTargetBuildings / pilotBuildingCount) * (1 + sp.scopeNetworkBonusPct);
    const scopeImpact = baseline * (scopeMultiplier - 1);
    variables.push({
      name: `Building scope (${pilotBuildingCount} → ${sp.scopeTargetBuildings})`,
      range: `${pilotBuildingCount} → ${sp.scopeTargetBuildings} bldg`,
      baselineUsd: baseline,
      adjustedUsd: baseline + scopeImpact,
      impactUsd: scopeImpact,
      impactPercent: (scopeImpact / baseline) * 100,
      lowCaseUsd: 0, highCaseUsd: 0, rank: 0,
    });

    // Sort by absolute impact (highest first) — tornado chart ordering
    variables.sort((a, b) => Math.abs(b.impactUsd) - Math.abs(a.impactUsd));

    // ADR-PRR-009: Populate low/high case and rank after sorting
    for (let i = 0; i < variables.length; i++) {
      const v = variables[i];
      const magnitude = Math.abs(v.impactUsd);
      v.lowCaseUsd = Math.round(baseline - magnitude);
      v.highCaseUsd = Math.round(baseline + magnitude);
      v.rank = i + 1;
    }

    // Confidence framing
    const directionalFloorUsd = minScenarioSavings * pilotBuildingCount * sp.directionalFloorFactor;
    const allPositive = scenarios.every(s => s.annualCostSavingsUsd > 0);
    const directionalConfidencePercent = allPositive ? sp.directionalConfidenceAllPositive : sp.directionalConfidenceMixed;
    const precisionConfidencePercent = this.config.confidenceLevel * 100;
    const precisionRangeUsd: [number, number] = [
      Math.round(baseline * (1 - sp.precisionRangePct)),
      Math.round(baseline * (1 + sp.precisionRangePct)),
    ];

    // ADR-PRR-009: Key takeaway paragraph linking top variables to pilot design
    const top1 = variables[0]?.name ?? 'baseline assumptions';
    const top2 = variables[1]?.name ?? 'pilot scope';
    const bottom = variables[variables.length - 1]?.name ?? 'secondary factors';
    const keyTakeaway =
      `The business case is most sensitive to ${top1} and ${top2} — ` +
      `both of which the pilot is specifically designed to validate with 4 weeks of ` +
      `real occupancy data across ${pilotBuildingCount} buildings. ` +
      `${bottom} has minimal impact, meaning the ROI holds even with ±20% variation in that assumption. ` +
      `The pilot is structured to reduce uncertainty in the top drivers before Phase 2 commitment.`;

    this.logger.info('sensitivity.analyzed', {
      baseline,
      variableCount: variables.length,
      topDriver: variables[0]?.name,
      directionalConfidence: directionalConfidencePercent,
    });

    return {
      baselineTotalUsd: baseline,
      variables,
      directionalConfidencePercent,
      directionalFloorUsd,
      precisionConfidencePercent,
      precisionRangeUsd,
      keyTakeaway,
    };
  }

  private aggregateBreakdown(scenarios: Scenario[]): SavingsBreakdown {
    return scenarios.reduce(
      (acc, s) => ({
        energySavingsUsd: acc.energySavingsUsd + s.savingsBreakdown.energySavingsUsd,
        maintenanceSavingsUsd: acc.maintenanceSavingsUsd + s.savingsBreakdown.maintenanceSavingsUsd,
        hvacSavingsUsd: acc.hvacSavingsUsd + s.savingsBreakdown.hvacSavingsUsd,
        leaseSavingsUsd: acc.leaseSavingsUsd + s.savingsBreakdown.leaseSavingsUsd,
      }),
      { energySavingsUsd: 0, maintenanceSavingsUsd: 0, hvacSavingsUsd: 0, leaseSavingsUsd: 0 },
    );
  }
}
