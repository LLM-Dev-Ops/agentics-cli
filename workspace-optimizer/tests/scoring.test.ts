import { describe, it, expect, vi } from 'vitest';
import { ScoringService } from '../src/services/scoring.js';
import type { Logger } from '../src/logger.js';
import type { Zone, Building, OccupancyReading } from '../src/types.js';
import { createTestConfig } from './helpers/test-config.js';

function mockLogger(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

const mockConfig = createTestConfig;

const testBuilding: Building = {
  id: 'b-test', name: 'Test Building', region: 'north_america', address: '123 Test St',
  totalSqFt: 10000, floors: 2, annualEnergyCostUsd: 50000, annualMaintenanceCostUsd: 20000, employeeCapacity: 200,
};

const testZone: Zone = {
  id: 'z-test', floorId: 'f-test', buildingId: 'b-test', name: 'Test Zone',
  spaceType: 'open_office', capacity: 100, sqFt: 5000, hasHvacZoning: true, energyCostPerSqFtYear: 4.50,
};

describe('ScoringService', () => {
  it('returns empty score for zone with no readings', () => {
    const service = new ScoringService(mockConfig(), mockLogger());
    const scores = service.scoreZones([testZone], [], [testBuilding]);
    expect(scores).toHaveLength(1);
    expect(scores[0].efficiencyIndex).toBe(0);
    expect(scores[0].category).toBe('severely_underutilized');
  });

  it('scores a zone with low occupancy as underutilized', () => {
    const service = new ScoringService(mockConfig(), mockLogger());
    const readings: OccupancyReading[] = Array.from({ length: 48 }, (_, i) => ({
      zoneId: 'z-test',
      timestamp: new Date(2026, 2, 10, 7 + Math.floor(i / 4), (i % 4) * 15),
      headcount: 20,
      capacity: 100,
    }));
    const scores = service.scoreZones([testZone], readings, [testBuilding]);
    expect(scores[0].avgOccupancyRate).toBeCloseTo(0.2, 1);
    expect(['severely_underutilized', 'underutilized']).toContain(scores[0].category);
  });

  it('scores a zone with high occupancy as well used', () => {
    const service = new ScoringService(mockConfig(), mockLogger());
    const readings: OccupancyReading[] = Array.from({ length: 48 }, (_, i) => ({
      zoneId: 'z-test',
      timestamp: new Date(2026, 2, 10, 7 + Math.floor(i / 4), (i % 4) * 15),
      headcount: 85,
      capacity: 100,
    }));
    const scores = service.scoreZones([testZone], readings, [testBuilding]);
    expect(scores[0].avgOccupancyRate).toBeCloseTo(0.85, 1);
    expect(['well_used', 'moderately_used']).toContain(scores[0].category);
  });

  it('computes peak variance correctly', () => {
    const service = new ScoringService(mockConfig(), mockLogger());
    const readings: OccupancyReading[] = [
      { zoneId: 'z-test', timestamp: new Date(2026, 2, 10, 9, 0), headcount: 10, capacity: 100 },
      { zoneId: 'z-test', timestamp: new Date(2026, 2, 10, 12, 0), headcount: 90, capacity: 100 },
    ];
    const scores = service.scoreZones([testZone], readings, [testBuilding]);
    expect(scores[0].peakVariance).toBeGreaterThan(0.3);
  });

  it('handles multiple zones independently', () => {
    const service = new ScoringService(mockConfig(), mockLogger());
    const zone2: Zone = { ...testZone, id: 'z-test-2', name: 'Zone 2' };
    const readings: OccupancyReading[] = [
      { zoneId: 'z-test', timestamp: new Date(2026, 2, 10, 9, 0), headcount: 80, capacity: 100 },
      { zoneId: 'z-test-2', timestamp: new Date(2026, 2, 10, 9, 0), headcount: 10, capacity: 100 },
    ];
    const scores = service.scoreZones([testZone, zone2], readings, [testBuilding]);
    expect(scores).toHaveLength(2);
    expect(scores[0].avgOccupancyRate).toBeGreaterThan(scores[1].avgOccupancyRate);
  });
});
