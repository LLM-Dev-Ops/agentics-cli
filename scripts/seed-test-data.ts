#!/usr/bin/env npx tsx

/**
 * Seed script for healthcare supply chain demo/test data.
 *
 * Populates facilities, inventory, demand signals, facility capacities,
 * and 30 days of historical usage data. Designed to trigger risk scenarios:
 *   - FAC-WEST-01 has critically low SUP-MASKS-N95 (15 units)
 *   - FAC-EAST-01 has surplus SUP-GLOVES-L (50 000 units)
 *
 * Usage:
 *   npx tsx scripts/seed-test-data.ts          # runs with mock DbClient
 *   import { seedAll } from './seed-test-data'  # programmatic use
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface DbClient {
  query(sql: string, params: unknown[]): Promise<unknown[]>;
  execute(sql: string, params: unknown[]): Promise<void>;
}

interface Facility {
  facility_id: string;
  name: string;
  region: string;
  address: string;
  is_active: boolean;
}

interface InventoryRecord {
  facility_id: string;
  sku: string;
  quantity_on_hand: number;
  unit_of_measure: string;
  lot_number: string;
  expiry_date: string;
}

interface DemandSignal {
  facility_id: string;
  sku: string;
  average_daily_usage: number;
}

interface FacilityCapacity {
  facility_id: string;
  region: string;
  max_storage_units: number;
  max_transfer_quantity: number;
}

interface HistoricalUsage {
  facility_id: string;
  sku: string;
  usage_date: string;
  daily_usage: number;
}

// ---------------------------------------------------------------------------
// Seed data
// ---------------------------------------------------------------------------

const facilities: Facility[] = [
  {
    facility_id: "FAC-WEST-01",
    name: "West Coast Distribution Center",
    region: "West Coast",
    address: "1200 Harbor Blvd, Los Angeles, CA 90012",
    is_active: true,
  },
  {
    facility_id: "FAC-EAST-01",
    name: "East Coast Distribution Center",
    region: "East Coast",
    address: "500 Industrial Pkwy, Newark, NJ 07102",
    is_active: true,
  },
  {
    facility_id: "FAC-CENTRAL-01",
    name: "Central Distribution Hub",
    region: "Central",
    address: "800 Logistics Dr, Dallas, TX 75201",
    is_active: true,
  },
  {
    facility_id: "FAC-SOUTH-01",
    name: "South Regional Warehouse",
    region: "South",
    address: "350 Medical Center Way, Atlanta, GA 30301",
    is_active: true,
  },
];

const skus = [
  "SUP-GLOVES-L",
  "SUP-MASKS-N95",
  "SUP-GOWNS-ISO",
  "SUP-SYRINGES-5ML",
  "SUP-SALINE-1L",
  "SUP-GAUZE-4X4",
  "SUP-TUBING-IV",
  "SUP-ALCOHOL-PREP",
] as const;

type Sku = (typeof skus)[number];

const uom: Record<Sku, string> = {
  "SUP-GLOVES-L": "box",
  "SUP-MASKS-N95": "unit",
  "SUP-GOWNS-ISO": "unit",
  "SUP-SYRINGES-5ML": "unit",
  "SUP-SALINE-1L": "bag",
  "SUP-GAUZE-4X4": "pack",
  "SUP-TUBING-IV": "set",
  "SUP-ALCOHOL-PREP": "box",
};

/**
 * Inventory quantities per facility+SKU.
 * FAC-WEST-01 / SUP-MASKS-N95 is critically low (15).
 * FAC-EAST-01 / SUP-GLOVES-L is surplus (50 000).
 */
const inventoryMatrix: Record<string, Record<Sku, number>> = {
  "FAC-WEST-01": {
    "SUP-GLOVES-L": 1200,
    "SUP-MASKS-N95": 15, // CRITICAL — triggers low-stock risk
    "SUP-GOWNS-ISO": 300,
    "SUP-SYRINGES-5ML": 800,
    "SUP-SALINE-1L": 450,
    "SUP-GAUZE-4X4": 600,
    "SUP-TUBING-IV": 200,
    "SUP-ALCOHOL-PREP": 900,
  },
  "FAC-EAST-01": {
    "SUP-GLOVES-L": 50000, // SURPLUS — triggers imbalance risk
    "SUP-MASKS-N95": 5000,
    "SUP-GOWNS-ISO": 3200,
    "SUP-SYRINGES-5ML": 4100,
    "SUP-SALINE-1L": 2800,
    "SUP-GAUZE-4X4": 3500,
    "SUP-TUBING-IV": 1500,
    "SUP-ALCOHOL-PREP": 4200,
  },
  "FAC-CENTRAL-01": {
    "SUP-GLOVES-L": 2400,
    "SUP-MASKS-N95": 1800,
    "SUP-GOWNS-ISO": 950,
    "SUP-SYRINGES-5ML": 2200,
    "SUP-SALINE-1L": 1100,
    "SUP-GAUZE-4X4": 1400,
    "SUP-TUBING-IV": 700,
    "SUP-ALCOHOL-PREP": 1900,
  },
  "FAC-SOUTH-01": {
    "SUP-GLOVES-L": 1800,
    "SUP-MASKS-N95": 900,
    "SUP-GOWNS-ISO": 500,
    "SUP-SYRINGES-5ML": 1500,
    "SUP-SALINE-1L": 750,
    "SUP-GAUZE-4X4": 1000,
    "SUP-TUBING-IV": 400,
    "SUP-ALCOHOL-PREP": 1300,
  },
};

/** Average daily usage per facility+SKU. */
const demandMatrix: Record<string, Record<Sku, number>> = {
  "FAC-WEST-01": {
    "SUP-GLOVES-L": 80,
    "SUP-MASKS-N95": 50,
    "SUP-GOWNS-ISO": 25,
    "SUP-SYRINGES-5ML": 60,
    "SUP-SALINE-1L": 35,
    "SUP-GAUZE-4X4": 40,
    "SUP-TUBING-IV": 15,
    "SUP-ALCOHOL-PREP": 55,
  },
  "FAC-EAST-01": {
    "SUP-GLOVES-L": 120,
    "SUP-MASKS-N95": 90,
    "SUP-GOWNS-ISO": 40,
    "SUP-SYRINGES-5ML": 100,
    "SUP-SALINE-1L": 50,
    "SUP-GAUZE-4X4": 70,
    "SUP-TUBING-IV": 25,
    "SUP-ALCOHOL-PREP": 85,
  },
  "FAC-CENTRAL-01": {
    "SUP-GLOVES-L": 60,
    "SUP-MASKS-N95": 45,
    "SUP-GOWNS-ISO": 20,
    "SUP-SYRINGES-5ML": 55,
    "SUP-SALINE-1L": 30,
    "SUP-GAUZE-4X4": 35,
    "SUP-TUBING-IV": 12,
    "SUP-ALCOHOL-PREP": 48,
  },
  "FAC-SOUTH-01": {
    "SUP-GLOVES-L": 70,
    "SUP-MASKS-N95": 40,
    "SUP-GOWNS-ISO": 22,
    "SUP-SYRINGES-5ML": 50,
    "SUP-SALINE-1L": 28,
    "SUP-GAUZE-4X4": 38,
    "SUP-TUBING-IV": 14,
    "SUP-ALCOHOL-PREP": 52,
  },
};

const facilityCapacities: FacilityCapacity[] = [
  { facility_id: "FAC-WEST-01", region: "West Coast", max_storage_units: 25000, max_transfer_quantity: 5000 },
  { facility_id: "FAC-EAST-01", region: "East Coast", max_storage_units: 80000, max_transfer_quantity: 10000 },
  { facility_id: "FAC-CENTRAL-01", region: "Central", max_storage_units: 40000, max_transfer_quantity: 8000 },
  { facility_id: "FAC-SOUTH-01", region: "South", max_storage_units: 30000, max_transfer_quantity: 6000 },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function lotNumber(sku: string, facility: string): string {
  const facilityShort = facility.replace("FAC-", "").replace("-01", "");
  const skuShort = sku.replace("SUP-", "").slice(0, 6).toUpperCase();
  return `LOT-${facilityShort}-${skuShort}-2026`;
}

function expiryDate(): string {
  const d = new Date();
  d.setFullYear(d.getFullYear() + 1);
  d.setMonth(d.getMonth() + Math.floor(Math.random() * 6));
  return formatDate(d);
}

/**
 * Generate 30 days of historical usage with realistic daily variance
 * (+-20 % around the average daily usage).
 */
function generateHistoricalUsage(
  facilityId: string,
  sku: Sku,
  avgDailyUsage: number,
): HistoricalUsage[] {
  const records: HistoricalUsage[] = [];
  const today = new Date();

  for (let daysAgo = 30; daysAgo >= 1; daysAgo--) {
    const date = new Date(today);
    date.setDate(date.getDate() - daysAgo);

    // +- 20 % variance, floored to 0
    const variance = 0.2;
    const factor = 1 + (Math.random() * 2 - 1) * variance;
    const dailyUsage = Math.max(0, Math.round(avgDailyUsage * factor));

    records.push({
      facility_id: facilityId,
      sku,
      usage_date: formatDate(date),
      daily_usage: dailyUsage,
    });
  }

  return records;
}

// ---------------------------------------------------------------------------
// Seed functions
// ---------------------------------------------------------------------------

async function seedFacilities(db: DbClient): Promise<void> {
  console.log("[seed] Inserting facilities...");
  for (const f of facilities) {
    await db.execute(
      `INSERT INTO facilities (facility_id, name, region, address, is_active)
       VALUES (:1, :2, :3, :4, :5)`,
      [f.facility_id, f.name, f.region, f.address, f.is_active ? 1 : 0],
    );
  }
  console.log(`[seed]   ${facilities.length} facilities inserted.`);
}

async function seedInventory(db: DbClient): Promise<void> {
  console.log("[seed] Inserting inventory records...");
  let count = 0;
  for (const [facilityId, skuMap] of Object.entries(inventoryMatrix)) {
    for (const [sku, qty] of Object.entries(skuMap) as [Sku, number][]) {
      const record: InventoryRecord = {
        facility_id: facilityId,
        sku,
        quantity_on_hand: qty,
        unit_of_measure: uom[sku],
        lot_number: lotNumber(sku, facilityId),
        expiry_date: expiryDate(),
      };
      await db.execute(
        `INSERT INTO inventory (facility_id, sku, quantity_on_hand, unit_of_measure, lot_number, expiry_date)
         VALUES (:1, :2, :3, :4, :5, TO_DATE(:6, 'YYYY-MM-DD'))`,
        [
          record.facility_id,
          record.sku,
          record.quantity_on_hand,
          record.unit_of_measure,
          record.lot_number,
          record.expiry_date,
        ],
      );
      count++;
    }
  }
  console.log(`[seed]   ${count} inventory records inserted.`);
}

async function seedDemandSignals(db: DbClient): Promise<void> {
  console.log("[seed] Inserting demand signals...");
  let count = 0;
  for (const [facilityId, skuMap] of Object.entries(demandMatrix)) {
    for (const [sku, avgDaily] of Object.entries(skuMap) as [Sku, number][]) {
      const signal: DemandSignal = {
        facility_id: facilityId,
        sku,
        average_daily_usage: avgDaily,
      };
      await db.execute(
        `INSERT INTO demand_signals (facility_id, sku, average_daily_usage)
         VALUES (:1, :2, :3)`,
        [signal.facility_id, signal.sku, signal.average_daily_usage],
      );
      count++;
    }
  }
  console.log(`[seed]   ${count} demand signals inserted.`);
}

async function seedFacilityCapacities(db: DbClient): Promise<void> {
  console.log("[seed] Inserting facility capacities...");
  for (const cap of facilityCapacities) {
    await db.execute(
      `INSERT INTO facility_capacities (facility_id, region, max_storage_units, max_transfer_quantity)
       VALUES (:1, :2, :3, :4)`,
      [cap.facility_id, cap.region, cap.max_storage_units, cap.max_transfer_quantity],
    );
  }
  console.log(`[seed]   ${facilityCapacities.length} facility capacities inserted.`);
}

async function seedHistoricalUsage(db: DbClient): Promise<void> {
  console.log("[seed] Inserting historical usage (30 days)...");
  let count = 0;
  for (const [facilityId, skuMap] of Object.entries(demandMatrix)) {
    for (const [sku, avgDaily] of Object.entries(skuMap) as [Sku, number][]) {
      const records = generateHistoricalUsage(facilityId, sku as Sku, avgDaily);
      for (const rec of records) {
        await db.execute(
          `INSERT INTO historical_usage (facility_id, sku, usage_date, daily_usage)
           VALUES (:1, :2, TO_DATE(:3, 'YYYY-MM-DD'), :4)`,
          [rec.facility_id, rec.sku, rec.usage_date, rec.daily_usage],
        );
        count++;
      }
    }
  }
  console.log(`[seed]   ${count} historical usage records inserted.`);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function seedAll(db: DbClient): Promise<void> {
  console.log("[seed] === Healthcare Supply Chain — Seed Start ===\n");

  await seedFacilities(db);
  await seedInventory(db);
  await seedDemandSignals(db);
  await seedFacilityCapacities(db);
  await seedHistoricalUsage(db);

  console.log("\n[seed] === Seed Complete ===");
}

// ---------------------------------------------------------------------------
// CLI entry point — mock DbClient that logs SQL to stdout
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const mockDb: DbClient = {
    async query(sql: string, params: unknown[]): Promise<unknown[]> {
      console.log(`[mock-db] QUERY: ${sql.trim()}`);
      console.log(`[mock-db]   PARAMS: ${JSON.stringify(params)}`);
      return [];
    },
    async execute(sql: string, params: unknown[]): Promise<void> {
      console.log(`[mock-db] EXECUTE: ${sql.trim()}`);
      console.log(`[mock-db]   PARAMS: ${JSON.stringify(params)}`);
    },
  };

  await seedAll(mockDb);
}

// Run main() when executed directly (ESM: check import.meta.url)
const isDirectRun =
  typeof process !== "undefined" &&
  process.argv[1] &&
  import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/"));

if (isDirectRun || process.argv[1]?.endsWith("seed-test-data.ts")) {
  main().catch((err) => {
    console.error("[seed] Fatal error:", err);
    process.exit(1);
  });
}
