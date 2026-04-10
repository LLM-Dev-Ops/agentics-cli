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

    // Component-level savings (ADR-053)
    const energySavingsUsd = totalSqFt * 4.50 * (1 - avgRate);
    const maintenanceSavingsUsd = totalSqFt * 1.80 * (1 - avgRate);
    const hvacSavingsUsd = totalSqFt * 2.20 * (1 - avgRate);
    const leaseSavingsUsd = totalSqFt * 6.00 * (1 - avgRate) * 0.3; // 30% of lease recapturable
    const totalSavings = energySavingsUsd + maintenanceSavingsUsd + hvacSavingsUsd + leaseSavingsUsd;

    const energySavingsKwh = totalSqFt * 22 * (1 - avgRate);
    const co2Tonnes = energySavingsKwh * 0.000277;

    return {
      id: randomUUID(),
      simulationId: this.config.simulationId,
      type: 'consolidation',
      name: `Consolidate underutilized zones — ${building.name}`,
      description: `Merge ${zones.length} underutilized zones into fewer active areas. Relocate ${employeesAffected} employees to optimize density.`,
      affectedZones: zones.map(z => z.zoneId),
      projectedOccupancyRate: Math.min(avgRate * 1.6, 0.85),
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

    const energySavingsUsd = totalSqFt * 4.50 * 0.25; // 25% reduction from scheduling
    const maintenanceSavingsUsd = totalSqFt * 1.80 * 0.15;
    const hvacSavingsUsd = totalSqFt * 2.20 * 0.35; // HVAC benefits most from scheduling
    const leaseSavingsUsd = 0; // No lease savings from schedule changes
    const totalSavings = energySavingsUsd + maintenanceSavingsUsd + hvacSavingsUsd + leaseSavingsUsd;

    const energySavingsKwh = totalSqFt * 22 * 0.25;
    const co2Tonnes = energySavingsKwh * 0.000277;

    return {
      id: randomUUID(),
      simulationId: this.config.simulationId,
      type: 'schedule_optimization',
      name: `Optimize schedules — ${building.name}`,
      description: `Implement dynamic scheduling for ${zones.length} zones. Reduce active hours based on usage patterns.`,
      affectedZones: zones.map(z => z.zoneId),
      projectedOccupancyRate: Math.min(avgRate * 1.3, 0.75),
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

    const reductionFactor = 0.4; // Decommission 40% of underutilized space
    const energySavingsUsd = totalSqFt * reductionFactor * 4.50;
    const maintenanceSavingsUsd = totalSqFt * reductionFactor * 1.80;
    const hvacSavingsUsd = totalSqFt * reductionFactor * 2.20;
    const leaseSavingsUsd = totalSqFt * reductionFactor * 6.00 * 0.6; // 60% recapturable
    const totalSavings = energySavingsUsd + maintenanceSavingsUsd + hvacSavingsUsd + leaseSavingsUsd;

    const energySavingsKwh = totalSqFt * reductionFactor * 22;
    const co2Tonnes = energySavingsKwh * 0.000277;

    return {
      id: randomUUID(),
      simulationId: this.config.simulationId,
      type: 'space_reduction',
      name: `Reduce active space — ${building.name}`,
      description: `Decommission ${Math.round(reductionFactor * 100)}% of underutilized space in ${zones.length} zones. Sublease or repurpose freed areas.`,
      affectedZones: zones.map(z => z.zoneId),
      projectedOccupancyRate: Math.min(avgRate / (1 - reductionFactor), 0.90),
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
