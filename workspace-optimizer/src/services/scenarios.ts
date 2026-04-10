import { randomUUID } from 'node:crypto';
import type { AppConfig } from '../config.js';
import type { Logger } from '../logger.js';
import type { ZoneScore, Building, Scenario, ScenarioType, SavingsBreakdown } from '../types.js';

export class ScenarioService {
  constructor(
    private readonly config: AppConfig,
    private readonly logger: Logger,
  ) {}

  generateScenarios(scores: ZoneScore[], buildings: Building[], correlationId?: string): Scenario[] {
    const buildingMap = new Map(buildings.map(b => [b.id, b]));
    const scenarios: Scenario[] = [];
    const corrId = correlationId ?? randomUUID();

    // Group scores by building
    const byBuilding = new Map<string, ZoneScore[]>();
    for (const score of scores) {
      const list = byBuilding.get(score.buildingId) ?? [];
      list.push(score);
      byBuilding.set(score.buildingId, list);
    }

    for (const [buildingId, buildingScores] of byBuilding) {
      const building = buildingMap.get(buildingId);
      if (!building) continue;

      const underutilized = buildingScores.filter(
        s => s.category === 'severely_underutilized' || s.category === 'underutilized',
      );

      if (underutilized.length === 0) continue;

      // Generate one of each type per building with underutilized zones
      scenarios.push(this.createConsolidationScenario(building, underutilized, corrId));
      scenarios.push(this.createScheduleScenario(building, underutilized, corrId));
      scenarios.push(this.createSpaceReductionScenario(building, underutilized, corrId));
    }

    this.logger.info('scenarios.generated', {
      count: scenarios.length,
      types: {
        consolidation: scenarios.filter(s => s.type === 'consolidation').length,
        schedule: scenarios.filter(s => s.type === 'schedule_optimization').length,
        reduction: scenarios.filter(s => s.type === 'space_reduction').length,
      },
    });

    return scenarios;
  }

  private createConsolidationScenario(building: Building, zones: ZoneScore[], correlationId: string): Scenario {
    const totalSqFt = zones.reduce((sum, z) => sum + z.sqFt, 0);
    const avgRate = zones.reduce((sum, z) => sum + z.avgOccupancyRate, 0) / zones.length;
    const employeesAffected = zones.reduce((sum, z) => sum + Math.round(z.capacity * z.avgOccupancyRate), 0);

    this.logger.info('scenario.consolidation.creating', {
      correlationId, buildingId: building.id, zones: zones.length, totalSqFt, avgRate,
    });

    // Component-level savings (ADR-053, ADR-PRR-001)
    const { costRates, scenarioParams, environmental } = this.config;
    const energySavingsUsd = totalSqFt * costRates.energyPerSqFtYear * (1 - avgRate);
    const maintenanceSavingsUsd = totalSqFt * costRates.maintenancePerSqFtYear * (1 - avgRate);
    const hvacSavingsUsd = totalSqFt * costRates.hvacPerSqFtYear * (1 - avgRate);
    const leaseSavingsUsd = totalSqFt * costRates.leasePerSqFtYear * (1 - avgRate) * scenarioParams.consolidationLeaseRecapturePct;
    const totalSavings = energySavingsUsd + maintenanceSavingsUsd + hvacSavingsUsd + leaseSavingsUsd;

    // ADR-PRR-003: Carbon reduction calculation chain (GHG Protocol Scope 2)
    //   1. Compute energy savings: sqft reduced × kWh/sqft/year
    //      (kwhPerSqFtYear sourced from EIA CBECS 2022 — see config.ts)
    //   2. Convert to CO2: kWh saved × tonnes CO2/kWh
    //      (co2TonnesPerKwh sourced from IEA 2023 OECD average — see config.ts)
    //   3. Result: avoided Scope 2 emissions from reduced electricity consumption
    // Limitation: does not account for Scope 3 embodied carbon in building
    // materials or Scope 1 emissions from on-site combustion (e.g., gas heating).
    const energySavingsKwh = totalSqFt * environmental.kwhPerSqFtYear * (1 - avgRate);
    const co2Tonnes = energySavingsKwh * environmental.co2TonnesPerKwh;

    return {
      id: randomUUID(),
      simulationId: this.config.simulationId,
      type: 'consolidation',
      name: `Consolidate underutilized zones — ${building.name}`,
      description: `Merge ${zones.length} underutilized zones into fewer active areas. Relocate ${employeesAffected} employees to optimize density.`,
      affectedZones: zones.map(z => z.zoneId),
      projectedOccupancyRate: Math.min(avgRate * scenarioParams.consolidationOccupancyMultiplier, scenarioParams.consolidationOccupancyCap),
      annualCostSavingsUsd: Math.round(totalSavings),
      annualEnergySavingsKwh: Math.round(energySavingsKwh),
      annualCo2ReductionTonnes: Math.round(co2Tonnes * 10) / 10,
      employeesAffected,
      employeeExperienceImpact: 'neutral',
      implementationRisk: 'medium',
      savingsBreakdown: {
        energySavingsUsd: Math.round(energySavingsUsd),
        maintenanceSavingsUsd: Math.round(maintenanceSavingsUsd),
        hvacSavingsUsd: Math.round(hvacSavingsUsd),
        leaseSavingsUsd: Math.round(leaseSavingsUsd),
      },
    };
  }

  private createScheduleScenario(building: Building, zones: ZoneScore[], correlationId: string): Scenario {
    const totalSqFt = zones.reduce((sum, z) => sum + z.sqFt, 0);
    const avgRate = zones.reduce((sum, z) => sum + z.avgOccupancyRate, 0) / zones.length;
    const employeesAffected = zones.reduce((sum, z) => sum + Math.round(z.capacity * z.avgOccupancyRate), 0);

    this.logger.info('scenario.schedule.creating', {
      correlationId, buildingId: building.id, zones: zones.length, totalSqFt, avgRate,
    });

    const { costRates, scenarioParams, environmental } = this.config;
    const energySavingsUsd = totalSqFt * costRates.energyPerSqFtYear * scenarioParams.scheduleEnergyReductionPct;
    const maintenanceSavingsUsd = totalSqFt * costRates.maintenancePerSqFtYear * scenarioParams.scheduleMaintenanceReductionPct;
    const hvacSavingsUsd = totalSqFt * costRates.hvacPerSqFtYear * scenarioParams.scheduleHvacReductionPct;
    const leaseSavingsUsd = 0; // No lease savings from schedule changes
    const totalSavings = energySavingsUsd + maintenanceSavingsUsd + hvacSavingsUsd + leaseSavingsUsd;

    // Carbon calculation: same methodology as consolidation (ADR-PRR-003)
    // Schedule optimization reduces active hours, not total area — so the
    // energy reduction is proportional to the schedule reduction percentage
    // rather than the vacancy rate used in consolidation.
    const energySavingsKwh = totalSqFt * environmental.kwhPerSqFtYear * scenarioParams.scheduleEnergyReductionPct;
    const co2Tonnes = energySavingsKwh * environmental.co2TonnesPerKwh;

    return {
      id: randomUUID(),
      simulationId: this.config.simulationId,
      type: 'schedule_optimization',
      name: `Optimize schedules — ${building.name}`,
      description: `Implement dynamic scheduling for ${zones.length} zones. Reduce active hours based on usage patterns.`,
      affectedZones: zones.map(z => z.zoneId),
      projectedOccupancyRate: Math.min(avgRate * scenarioParams.scheduleOccupancyMultiplier, scenarioParams.scheduleOccupancyCap),
      annualCostSavingsUsd: Math.round(totalSavings),
      annualEnergySavingsKwh: Math.round(energySavingsKwh),
      annualCo2ReductionTonnes: Math.round(co2Tonnes * 10) / 10,
      employeesAffected,
      employeeExperienceImpact: 'positive',
      implementationRisk: 'low',
      savingsBreakdown: {
        energySavingsUsd: Math.round(energySavingsUsd),
        maintenanceSavingsUsd: Math.round(maintenanceSavingsUsd),
        hvacSavingsUsd: Math.round(hvacSavingsUsd),
        leaseSavingsUsd: Math.round(leaseSavingsUsd),
      },
    };
  }

  private createSpaceReductionScenario(building: Building, zones: ZoneScore[], correlationId: string): Scenario {
    const totalSqFt = zones.reduce((sum, z) => sum + z.sqFt, 0);
    const avgRate = zones.reduce((sum, z) => sum + z.avgOccupancyRate, 0) / zones.length;
    const employeesAffected = zones.reduce((sum, z) => sum + Math.round(z.capacity * z.avgOccupancyRate), 0);

    this.logger.info('scenario.space-reduction.creating', {
      correlationId, buildingId: building.id, zones: zones.length, totalSqFt, avgRate,
    });

    const { costRates, scenarioParams, environmental } = this.config;
    const reductionFactor = scenarioParams.spaceReductionFactor;
    const energySavingsUsd = totalSqFt * reductionFactor * costRates.energyPerSqFtYear;
    const maintenanceSavingsUsd = totalSqFt * reductionFactor * costRates.maintenancePerSqFtYear;
    const hvacSavingsUsd = totalSqFt * reductionFactor * costRates.hvacPerSqFtYear;
    const leaseSavingsUsd = totalSqFt * reductionFactor * costRates.leasePerSqFtYear * scenarioParams.spaceReductionLeaseRecapturePct;
    const totalSavings = energySavingsUsd + maintenanceSavingsUsd + hvacSavingsUsd + leaseSavingsUsd;

    // Carbon calculation: same methodology as consolidation (ADR-PRR-003)
    // Space reduction fully decommissions a percentage of area, so the energy
    // savings are proportional to the decommissioned sqft, not occupancy rate.
    const energySavingsKwh = totalSqFt * reductionFactor * environmental.kwhPerSqFtYear;
    const co2Tonnes = energySavingsKwh * environmental.co2TonnesPerKwh;

    return {
      id: randomUUID(),
      simulationId: this.config.simulationId,
      type: 'space_reduction',
      name: `Reduce active space — ${building.name}`,
      description: `Decommission ${Math.round(reductionFactor * 100)}% of underutilized space in ${zones.length} zones. Sublease or repurpose freed areas.`,
      affectedZones: zones.map(z => z.zoneId),
      projectedOccupancyRate: Math.min(avgRate / (1 - reductionFactor), scenarioParams.spaceReductionOccupancyCap),
      annualCostSavingsUsd: Math.round(totalSavings),
      annualEnergySavingsKwh: Math.round(energySavingsKwh),
      annualCo2ReductionTonnes: Math.round(co2Tonnes * 10) / 10,
      employeesAffected,
      employeeExperienceImpact: 'negative',
      implementationRisk: 'high',
      savingsBreakdown: {
        energySavingsUsd: Math.round(energySavingsUsd),
        maintenanceSavingsUsd: Math.round(maintenanceSavingsUsd),
        hvacSavingsUsd: Math.round(hvacSavingsUsd),
        leaseSavingsUsd: Math.round(leaseSavingsUsd),
      },
    };
  }
}
