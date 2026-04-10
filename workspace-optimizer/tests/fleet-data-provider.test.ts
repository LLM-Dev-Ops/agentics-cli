import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/api.js';
import { createContainer } from '../src/container.js';
import { seedFleetData } from '../src/data/seed.js';
import type { FleetDataProvider, Building, Zone, Floor, OccupancyReading } from '../src/types.js';

// ADR-PRR-007: Fleet data provider decoupling tests

describe('ADR-PRR-007: FleetDataProvider decoupling', () => {
  describe('seedFleetData adapter', () => {
    it('implements all FleetDataProvider methods', () => {
      expect(typeof seedFleetData.getBuildings).toBe('function');
      expect(typeof seedFleetData.getFloors).toBe('function');
      expect(typeof seedFleetData.getZones).toBe('function');
      expect(typeof seedFleetData.getOccupancyReadings).toBe('function');
    });

    it('returns 3 buildings from seed data', () => {
      const buildings = seedFleetData.getBuildings();
      expect(buildings).toHaveLength(3);
      expect(buildings[0].name).toContain('San Francisco');
    });

    it('returns 17 zones from seed data', () => {
      const zones = seedFleetData.getZones();
      expect(zones).toHaveLength(17);
    });

    it('returns thousands of occupancy readings', () => {
      const readings = seedFleetData.getOccupancyReadings();
      expect(readings.length).toBeGreaterThan(1000);
    });
  });

  describe('container injection', () => {
    it('createContainer uses seedFleetData by default', () => {
      const c = createContainer();
      expect(c.fleetData).toBe(seedFleetData);
      expect(c.fleetData.getBuildings()).toHaveLength(3);
    });

    it('createContainer accepts a custom FleetDataProvider', () => {
      const customBuilding: Building = {
        id: 'b-custom-1',
        name: 'Custom HQ',
        region: 'north_america',
        address: '1 Custom St',
        totalSqFt: 50_000,
        floors: 3,
        annualEnergyCostUsd: 200_000,
        annualMaintenanceCostUsd: 80_000,
        employeeCapacity: 500,
      };

      const mockProvider: FleetDataProvider = {
        getBuildings: () => [customBuilding],
        getFloors: () => [],
        getZones: () => [],
        getOccupancyReadings: () => [],
      };

      const c = createContainer(undefined, mockProvider);
      expect(c.fleetData).toBe(mockProvider);
      expect(c.fleetData.getBuildings()).toHaveLength(1);
      expect(c.fleetData.getBuildings()[0].name).toBe('Custom HQ');
    });
  });

  describe('API routes consume container.fleetData', () => {
    it('GET /api/buildings returns data from injected provider, not seed module', async () => {
      const customBuilding: Building = {
        id: 'b-mock-1',
        name: 'Mock Building',
        region: 'europe',
        address: '1 Mock St',
        totalSqFt: 10_000,
        floors: 2,
        annualEnergyCostUsd: 50_000,
        annualMaintenanceCostUsd: 20_000,
        employeeCapacity: 100,
      };

      const mockProvider: FleetDataProvider = {
        getBuildings: () => [customBuilding],
        getFloors: () => [],
        getZones: () => [],
        getOccupancyReadings: () => [],
      };

      const c = createContainer(undefined, mockProvider);
      const app = createApp(c);

      const res = await request(app).get('/api/buildings');
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0].name).toBe('Mock Building');
      expect(res.body[0].id).toBe('b-mock-1');
    });

    it('GET /api/scores uses injected zones and occupancy from provider', async () => {
      const zone: Zone = {
        id: 'z-mock-1',
        floorId: 'f-mock-1',
        buildingId: 'b-mock-1',
        name: 'Mock Zone',
        spaceType: 'open_office',
        capacity: 50,
        sqFt: 2000,
        hasHvacZoning: true,
        energyCostPerSqFtYear: 5.00,
      };
      const building: Building = {
        id: 'b-mock-1',
        name: 'Mock HQ',
        region: 'asia',
        address: '1 Mock St',
        totalSqFt: 5000,
        floors: 1,
        annualEnergyCostUsd: 20_000,
        annualMaintenanceCostUsd: 8_000,
        employeeCapacity: 50,
      };
      const reading: OccupancyReading = {
        zoneId: 'z-mock-1',
        timestamp: new Date('2026-04-10T10:00:00Z'),
        headcount: 40,
        capacity: 50,
      };

      const mockProvider: FleetDataProvider = {
        getBuildings: () => [building],
        getFloors: () => [],
        getZones: () => [zone],
        getOccupancyReadings: () => [reading],
      };

      const c = createContainer(undefined, mockProvider);
      const app = createApp(c);

      const res = await request(app).get('/api/scores').set('X-User-Role', 'analyst');
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0].zoneId).toBe('z-mock-1');
      expect(res.body[0].avgOccupancyRate).toBeCloseTo(0.8, 1);
    });

    it('GET /api/scenarios uses injected provider for scenario generation', async () => {
      // Use seed data through the provider interface
      const c = createContainer(undefined, seedFleetData);
      const app = createApp(c);

      const res = await request(app).get('/api/scenarios').set('X-User-Role', 'analyst');
      expect(res.status).toBe(200);
      expect(res.body.length).toBeGreaterThan(0);
    });
  });
});
