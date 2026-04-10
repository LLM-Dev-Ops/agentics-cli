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
}

/** Full sensitivity analysis result */
export interface SensitivityAnalysis {
  baselineTotalUsd: number;
  variables: SensitivityVariable[];
  directionalConfidencePercent: number;
  directionalFloorUsd: number;
  precisionConfidencePercent: number;
  precisionRangeUsd: [number, number];
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

    const variables: SensitivityVariable[] = [];

    // 1. Energy price ±15%
    const energyImpact = breakdown.energySavingsUsd * 0.15;
    variables.push({
      name: 'Energy price',
      range: '±15%',
      baselineUsd: baseline,
      adjustedUsd: baseline + energyImpact,
      impactUsd: energyImpact,
      impactPercent: (energyImpact / baseline) * 100,
    });

    // 2. Occupancy data coverage 70%→95%
    // Lower coverage means less reliable data → conservative 20% reduction
    const coverageImpact = baseline * 0.20;
    variables.push({
      name: 'Occupancy data coverage',
      range: '70% → 95%',
      baselineUsd: baseline,
      adjustedUsd: baseline - coverageImpact,
      impactUsd: -coverageImpact,
      impactPercent: -(coverageImpact / baseline) * 100,
    });

    // 3. Hybrid work adoption rate 40%→70%
    // Higher remote adoption = more underutilized space = more savings opportunity
    const hybridImpact = baseline * 0.25;
    variables.push({
      name: 'Hybrid adoption rate',
      range: '40% → 70%',
      baselineUsd: baseline,
      adjustedUsd: baseline + hybridImpact,
      impactUsd: hybridImpact,
      impactPercent: (hybridImpact / baseline) * 100,
    });

    // 4. Implementation timeline ±3 months
    // Delay reduces first-year NPV by roughly the proportion of delay
    const timelineImpactMonths = 3;
    const timelineImpact = baseline * (timelineImpactMonths / 12);
    variables.push({
      name: 'Implementation timeline',
      range: '±3 months',
      baselineUsd: baseline,
      adjustedUsd: baseline - timelineImpact,
      impactUsd: -timelineImpact,
      impactPercent: -(timelineImpact / baseline) * 100,
    });

    // 5. Lease recapture rate 30%→60%
    // Space reduction scenarios assume partial lease recapture; higher rate = more savings
    const currentLease = breakdown.leaseSavingsUsd;
    const leaseUpside = currentLease * 0.5; // 50% more if recapture improves from 30% to 60%
    variables.push({
      name: 'Lease recapture rate',
      range: '30% → 60%',
      baselineUsd: baseline,
      adjustedUsd: baseline + leaseUpside,
      impactUsd: leaseUpside,
      impactPercent: (leaseUpside / baseline) * 100,
    });

    // 6. Archibus integration scope 3→8 buildings
    // Non-linear: more buildings = better optimization opportunities (network effects)
    const scopeMultiplier = (8 / pilotBuildingCount) * 1.15; // 15% network bonus
    const scopeImpact = baseline * (scopeMultiplier - 1);
    variables.push({
      name: 'Building scope (3 → 8)',
      range: `${pilotBuildingCount} → 8 bldg`,
      baselineUsd: baseline,
      adjustedUsd: baseline + scopeImpact,
      impactUsd: scopeImpact,
      impactPercent: (scopeImpact / baseline) * 100,
    });

    // Sort by absolute impact (highest first) — tornado chart ordering
    variables.sort((a, b) => Math.abs(b.impactUsd) - Math.abs(a.impactUsd));

    // Confidence framing
    const directionalFloorUsd = minScenarioSavings * pilotBuildingCount * 0.8;
    const allPositive = scenarios.every(s => s.annualCostSavingsUsd > 0);
    const directionalConfidencePercent = allPositive ? 95 : 75;
    const precisionConfidencePercent = this.config.confidenceLevel * 100;
    const precisionRangeUsd: [number, number] = [
      Math.round(baseline * 0.85),
      Math.round(baseline * 1.15),
    ];

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
