import type { Building, Floor, Zone, OccupancyReading } from '../types.js';

// === Three pilot buildings across regions ===

export const buildings: Building[] = [
  {
    id: 'b1000000-0000-0000-0000-000000000001',
    name: 'San Francisco HQ - Tower A',
    region: 'north_america',
    address: '100 Market St, San Francisco, CA 94105',
    totalSqFt: 180_000,
    floors: 12,
    annualEnergyCostUsd: 810_000,
    annualMaintenanceCostUsd: 324_000,
    employeeCapacity: 2400,
  },
  {
    id: 'b2000000-0000-0000-0000-000000000002',
    name: 'London - Canary Wharf Office',
    region: 'europe',
    address: '1 Canada Square, London E14 5AB',
    totalSqFt: 120_000,
    floors: 8,
    annualEnergyCostUsd: 660_000,
    annualMaintenanceCostUsd: 228_000,
    employeeCapacity: 1600,
  },
  {
    id: 'b3000000-0000-0000-0000-000000000003',
    name: 'Singapore - Marina Bay',
    region: 'asia',
    address: '10 Marina Blvd, Singapore 018983',
    totalSqFt: 95_000,
    floors: 6,
    annualEnergyCostUsd: 570_000,
    annualMaintenanceCostUsd: 190_000,
    employeeCapacity: 1200,
  },
];

// === Floors ===

export const floors: Floor[] = [
  // SF
  { id: 'f1-01', buildingId: buildings[0].id, level: 1, sqFt: 15000, zones: [] },
  { id: 'f1-02', buildingId: buildings[0].id, level: 2, sqFt: 15000, zones: [] },
  { id: 'f1-03', buildingId: buildings[0].id, level: 3, sqFt: 15000, zones: [] },
  { id: 'f1-04', buildingId: buildings[0].id, level: 4, sqFt: 15000, zones: [] },
  { id: 'f1-05', buildingId: buildings[0].id, level: 5, sqFt: 15000, zones: [] },
  { id: 'f1-06', buildingId: buildings[0].id, level: 6, sqFt: 15000, zones: [] },
  // London
  { id: 'f2-01', buildingId: buildings[1].id, level: 1, sqFt: 15000, zones: [] },
  { id: 'f2-02', buildingId: buildings[1].id, level: 2, sqFt: 15000, zones: [] },
  { id: 'f2-03', buildingId: buildings[1].id, level: 3, sqFt: 15000, zones: [] },
  { id: 'f2-04', buildingId: buildings[1].id, level: 4, sqFt: 15000, zones: [] },
  // Singapore
  { id: 'f3-01', buildingId: buildings[2].id, level: 1, sqFt: 15833, zones: [] },
  { id: 'f3-02', buildingId: buildings[2].id, level: 2, sqFt: 15833, zones: [] },
  { id: 'f3-03', buildingId: buildings[2].id, level: 3, sqFt: 15834, zones: [] },
];

// === Zones (underutilized mix across all buildings) ===

export const zones: Zone[] = [
  // SF — 6 zones
  { id: 'z-sf-1a', floorId: 'f1-01', buildingId: buildings[0].id, name: 'SF Open Plan A', spaceType: 'open_office', capacity: 120, sqFt: 7200, hasHvacZoning: true, energyCostPerSqFtYear: 4.50 },
  { id: 'z-sf-1b', floorId: 'f1-01', buildingId: buildings[0].id, name: 'SF Meeting Hub', spaceType: 'meeting_room', capacity: 40, sqFt: 3200, hasHvacZoning: true, energyCostPerSqFtYear: 5.00 },
  { id: 'z-sf-2a', floorId: 'f1-02', buildingId: buildings[0].id, name: 'SF Open Plan B', spaceType: 'open_office', capacity: 100, sqFt: 6500, hasHvacZoning: true, energyCostPerSqFtYear: 4.50 },
  { id: 'z-sf-3a', floorId: 'f1-03', buildingId: buildings[0].id, name: 'SF Private Offices', spaceType: 'private_office', capacity: 30, sqFt: 4500, hasHvacZoning: false, energyCostPerSqFtYear: 5.50 },
  { id: 'z-sf-4a', floorId: 'f1-04', buildingId: buildings[0].id, name: 'SF Flex Space', spaceType: 'flexible', capacity: 80, sqFt: 5500, hasHvacZoning: true, energyCostPerSqFtYear: 4.00 },
  { id: 'z-sf-5a', floorId: 'f1-05', buildingId: buildings[0].id, name: 'SF Commons', spaceType: 'common_area', capacity: 60, sqFt: 4000, hasHvacZoning: false, energyCostPerSqFtYear: 3.50 },
  // London — 6 zones
  { id: 'z-ln-1a', floorId: 'f2-01', buildingId: buildings[1].id, name: 'LDN Open Plan A', spaceType: 'open_office', capacity: 110, sqFt: 6800, hasHvacZoning: true, energyCostPerSqFtYear: 5.50 },
  { id: 'z-ln-1b', floorId: 'f2-01', buildingId: buildings[1].id, name: 'LDN Meeting Rooms', spaceType: 'meeting_room', capacity: 35, sqFt: 2800, hasHvacZoning: true, energyCostPerSqFtYear: 6.00 },
  { id: 'z-ln-2a', floorId: 'f2-02', buildingId: buildings[1].id, name: 'LDN Open Plan B', spaceType: 'open_office', capacity: 90, sqFt: 5800, hasHvacZoning: true, energyCostPerSqFtYear: 5.50 },
  { id: 'z-ln-3a', floorId: 'f2-03', buildingId: buildings[1].id, name: 'LDN Private Offices', spaceType: 'private_office', capacity: 25, sqFt: 3800, hasHvacZoning: false, energyCostPerSqFtYear: 6.50 },
  { id: 'z-ln-3b', floorId: 'f2-03', buildingId: buildings[1].id, name: 'LDN Flex Zone', spaceType: 'flexible', capacity: 70, sqFt: 4800, hasHvacZoning: true, energyCostPerSqFtYear: 5.00 },
  { id: 'z-ln-4a', floorId: 'f2-04', buildingId: buildings[1].id, name: 'LDN Commons', spaceType: 'common_area', capacity: 50, sqFt: 3500, hasHvacZoning: false, energyCostPerSqFtYear: 4.50 },
  // Singapore — 5 zones
  { id: 'z-sg-1a', floorId: 'f3-01', buildingId: buildings[2].id, name: 'SG Open Plan A', spaceType: 'open_office', capacity: 100, sqFt: 6200, hasHvacZoning: true, energyCostPerSqFtYear: 6.00 },
  { id: 'z-sg-1b', floorId: 'f3-01', buildingId: buildings[2].id, name: 'SG Meeting Center', spaceType: 'meeting_room', capacity: 30, sqFt: 2500, hasHvacZoning: true, energyCostPerSqFtYear: 6.50 },
  { id: 'z-sg-2a', floorId: 'f3-02', buildingId: buildings[2].id, name: 'SG Open Plan B', spaceType: 'open_office', capacity: 85, sqFt: 5500, hasHvacZoning: true, energyCostPerSqFtYear: 6.00 },
  { id: 'z-sg-2b', floorId: 'f3-02', buildingId: buildings[2].id, name: 'SG Flex Area', spaceType: 'flexible', capacity: 60, sqFt: 4000, hasHvacZoning: true, energyCostPerSqFtYear: 5.50 },
  { id: 'z-sg-3a', floorId: 'f3-03', buildingId: buildings[2].id, name: 'SG Private Offices', spaceType: 'private_office', capacity: 20, sqFt: 3200, hasHvacZoning: false, energyCostPerSqFtYear: 7.00 },
];

// Wire zone IDs back into floors
for (const zone of zones) {
  const floor = floors.find(f => f.id === zone.floorId);
  if (floor) floor.zones.push(zone.id);
}

// === Occupancy Readings (4 weeks, 15-min intervals, business hours 7am-7pm) ===

function generateReadings(): OccupancyReading[] {
  const readings: OccupancyReading[] = [];
  const startDate = new Date('2026-03-10T00:00:00Z');
  const days = 20; // 4 weeks of weekdays

  // Utilization profiles per zone (avg occupancy rate)
  const profiles: Record<string, number> = {
    'z-sf-1a': 0.32, 'z-sf-1b': 0.22, 'z-sf-2a': 0.28, 'z-sf-3a': 0.18,
    'z-sf-4a': 0.38, 'z-sf-5a': 0.25,
    'z-ln-1a': 0.35, 'z-ln-1b': 0.20, 'z-ln-2a': 0.30, 'z-ln-3a': 0.15,
    'z-ln-3b': 0.40, 'z-ln-4a': 0.28,
    'z-sg-1a': 0.38, 'z-sg-1b': 0.25, 'z-sg-2a': 0.33, 'z-sg-2b': 0.42,
    'z-sg-3a': 0.20,
  };

  let dayCount = 0;
  for (let d = 0; dayCount < days; d++) {
    const date = new Date(startDate.getTime() + d * 86400_000);
    const dow = date.getDay();
    if (dow === 0 || dow === 6) continue; // skip weekends
    dayCount++;

    for (const zone of zones) {
      const baseRate = profiles[zone.id] ?? 0.30;
      // Business hours: 7am to 7pm, 15-min intervals = 48 readings
      for (let slot = 0; slot < 48; slot++) {
        const hour = 7 + slot * 0.25;
        const timestamp = new Date(date);
        timestamp.setUTCHours(Math.floor(hour), (hour % 1) * 60, 0, 0);

        // Bell curve around midday, variance by zone
        const peakFactor = 1 - Math.abs(hour - 12.5) / 5.5;
        const noise = 0.85 + Math.random() * 0.30;
        const rate = Math.min(Math.max(baseRate * peakFactor * noise, 0), 1);
        const headcount = Math.round(zone.capacity * rate);

        readings.push({
          zoneId: zone.id,
          timestamp,
          headcount,
          capacity: zone.capacity,
        });
      }
    }
  }

  return readings;
}

export const occupancyReadings: OccupancyReading[] = generateReadings();
