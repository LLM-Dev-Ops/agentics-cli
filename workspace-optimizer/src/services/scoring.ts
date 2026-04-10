import type { AppConfig } from '../config.js';
import type { Logger } from '../logger.js';
import type { OccupancyReading, Zone, Building, ZoneScore, UtilizationCategory } from '../types.js';

export class ScoringService {
  constructor(
    private readonly config: AppConfig,
    private readonly logger: Logger,
  ) {}

  scoreZones(zones: Zone[], readings: OccupancyReading[], buildings: Building[]): ZoneScore[] {
    const buildingMap = new Map(buildings.map(b => [b.id, b]));
    const scores = zones.map(zone => this.scoreZone(zone, readings.filter(r => r.zoneId === zone.id)));

    this.logger.info('scoring.complete', {
      zonesScored: scores.length,
      severelyUnderutilized: scores.filter(s => s.category === 'severely_underutilized').length,
      underutilized: scores.filter(s => s.category === 'underutilized').length,
    });

    return scores;
  }

  private scoreZone(zone: Zone, readings: OccupancyReading[]): ZoneScore {
    if (readings.length === 0) {
      return this.emptyScore(zone);
    }

    const rates = readings.map(r => r.headcount / r.capacity);
    const avgOccupancyRate = rates.reduce((a, b) => a + b, 0) / rates.length;
    const peakOccupancyRate = Math.max(...rates);
    const peakVariance = peakOccupancyRate - avgOccupancyRate;

    // Flexibility: how many distinct hours have any occupancy
    const uniqueHours = new Set(readings.filter(r => r.headcount > 0).map(r => r.timestamp.getHours())).size;
    const flexibilityScore = Math.min(uniqueHours / this.config.scoring.flexibilityHoursDivisor, 1);

    const weights = this.config.scoring;
    const efficiencyIndex =
      avgOccupancyRate * weights.avgOccupancyWeight +
      (1 - peakVariance) * weights.peakVarianceWeight +
      flexibilityScore * weights.flexibilityWeight;

    const category = this.categorize(efficiencyIndex);

    return {
      zoneId: zone.id,
      zoneName: zone.name,
      buildingId: zone.buildingId,
      spaceType: zone.spaceType,
      capacity: zone.capacity,
      sqFt: zone.sqFt,
      avgOccupancyRate: Math.round(avgOccupancyRate * 1000) / 1000,
      peakOccupancyRate: Math.round(peakOccupancyRate * 1000) / 1000,
      peakVariance: Math.round(peakVariance * 1000) / 1000,
      flexibilityScore: Math.round(flexibilityScore * 1000) / 1000,
      efficiencyIndex: Math.round(efficiencyIndex * 1000) / 1000,
      category,
    };
  }

  private categorize(index: number): UtilizationCategory {
    if (index < this.config.scoring.severelyUnderutilizedThreshold) return 'severely_underutilized';
    if (index < this.config.scoring.underutilizedThreshold) return 'underutilized';
    if (index < this.config.scoring.moderatelyUsedThreshold) return 'moderately_used';
    if (index <= 1.0) return 'well_used';
    return 'over_capacity';
  }

  private emptyScore(zone: Zone): ZoneScore {
    return {
      zoneId: zone.id,
      zoneName: zone.name,
      buildingId: zone.buildingId,
      spaceType: zone.spaceType,
      capacity: zone.capacity,
      sqFt: zone.sqFt,
      avgOccupancyRate: 0,
      peakOccupancyRate: 0,
      peakVariance: 0,
      flexibilityScore: 0,
      efficiencyIndex: 0,
      category: 'severely_underutilized',
    };
  }
}
