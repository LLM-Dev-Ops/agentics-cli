/**
 * Integration test: Risk engine end-to-end.
 *
 * Tests SupplyRiskDetector, RiskRecommender, and RiskScanScheduler
 * with seeded inventory/demand data and a mock RiskDataAdapter.
 */

import { SupplyRiskDetector } from '../../src/risk-engine/detector.js';
import type {
  InventorySnapshot,
  DemandSignal,
  FacilityCapacity,
} from '../../src/risk-engine/detector.js';
import { RiskRecommender } from '../../src/risk-engine/recommender.js';
import type { Recommendation } from '../../src/risk-engine/recommender.js';
import { RiskScanScheduler } from '../../src/risk-engine/scheduler.js';
import type { RiskDataAdapter, PersistedAlert } from '../../src/risk-engine/scheduler.js';
import type { RiskThresholds } from '../../src/risk-engine/thresholds.js';

// ---------------------------------------------------------------------------
// Shared test data
// ---------------------------------------------------------------------------

const TEST_THRESHOLDS: RiskThresholds = {
  criticalDaysSupply: 2,
  warningDaysSupply: 7,
  surplusDaysSupply: 90,
  imbalanceRatio: 10,
  autoActionEnabled: false,
  autoActionMaxValue: 10_000,
  defaultReorderPointDays: 7,
  maxDaysOnHand: 90,
};

const CAPACITIES: readonly FacilityCapacity[] = [
  { facility_id: 'FAC-A', region: 'EAST', max_transfer_quantity: 500 },
  { facility_id: 'FAC-B', region: 'EAST', max_transfer_quantity: 500 },
];

/**
 * Facility A: 5 units, daily usage 10 => 0.5 days (SHORTAGE, critical < 2)
 * Facility B: 1000 units, daily usage 10 => 100 days (SURPLUS, 100 > 90)
 */
const INVENTORY: readonly InventorySnapshot[] = [
  { facility_id: 'FAC-A', sku: 'SKU-001', quantity: 5, unit_of_measure: 'EA' },
  { facility_id: 'FAC-B', sku: 'SKU-001', quantity: 1000, unit_of_measure: 'EA' },
];

const DEMAND: readonly DemandSignal[] = [
  { facility_id: 'FAC-A', sku: 'SKU-001', average_daily_usage: 10 },
  { facility_id: 'FAC-B', sku: 'SKU-001', average_daily_usage: 10 },
];

// ---------------------------------------------------------------------------
// Mock RiskDataAdapter
// ---------------------------------------------------------------------------

function createMockAdapter(
  inventory: readonly InventorySnapshot[] = INVENTORY,
  demand: readonly DemandSignal[] = DEMAND,
  capacities: readonly FacilityCapacity[] = CAPACITIES,
): RiskDataAdapter & {
  persistedAlerts: PersistedAlert[];
  executedRecs: Recommendation[];
} {
  const persistedAlerts: PersistedAlert[] = [];
  const executedRecs: Recommendation[] = [];

  return {
    persistedAlerts,
    executedRecs,

    async getInventorySnapshots() {
      return inventory;
    },
    async getDemandSignals() {
      return demand;
    },
    async getFacilityCapacities() {
      return capacities;
    },
    async persistAlert(alert: PersistedAlert) {
      persistedAlerts.push(alert);
    },
    async executeRecommendation(rec: Recommendation) {
      executedRecs.push(rec);
      return { success: true, order_id: `order-${rec.id}` };
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Risk detection engine (integration)', () => {
  describe('SupplyRiskDetector', () => {
    let detector: SupplyRiskDetector;

    beforeEach(() => {
      detector = new SupplyRiskDetector(TEST_THRESHOLDS);
    });

    it('detects SHORTAGE at facility A (0.5 days < criticalDaysSupply=2)', () => {
      const risks = detector.detect(INVENTORY, DEMAND, CAPACITIES);
      const shortages = risks.filter(
        (r) => r.risk_type === 'shortage' && r.facility_id === 'FAC-A',
      );

      expect(shortages.length).toBeGreaterThanOrEqual(1);
      const critical = shortages[0]!;
      expect(critical.severity).toBe('critical');
      expect(critical.days_of_supply).toBe(0.5);
      expect(critical.sku).toBe('SKU-001');
    });

    it('detects SURPLUS at facility B (100 days > surplusDaysSupply=90)', () => {
      const risks = detector.detect(INVENTORY, DEMAND, CAPACITIES);
      const surpluses = risks.filter(
        (r) => r.risk_type === 'surplus' && r.facility_id === 'FAC-B',
      );

      expect(surpluses.length).toBeGreaterThanOrEqual(1);
      const surplus = surpluses[0]!;
      expect(surplus.days_of_supply).toBe(100);
      expect(surplus.sku).toBe('SKU-001');
    });

    it('detects IMBALANCE between facilities (ratio=200, FAC-A has <3 days)', () => {
      const risks = detector.detect(INVENTORY, DEMAND, CAPACITIES);
      const imbalances = risks.filter((r) => r.risk_type === 'imbalance');

      expect(imbalances.length).toBeGreaterThanOrEqual(1);
      const imbalance = imbalances[0]!;
      expect(imbalance.facility_id).toBe('FAC-A');
      expect(imbalance.counterpart_facility).toBe('FAC-B');
      expect(imbalance.counterpart_quantity).toBe(1000);
      // ratio = 1000/5 = 200 >= imbalanceRatio(10) and lowDaysSupply = 0.5 < 3
      expect(imbalance.days_of_supply).toBe(0.5);
    });
  });

  describe('RiskRecommender', () => {
    let detector: SupplyRiskDetector;
    let recommender: RiskRecommender;

    beforeEach(() => {
      detector = new SupplyRiskDetector(TEST_THRESHOLDS);
      recommender = new RiskRecommender(TEST_THRESHOLDS, CAPACITIES);
    });

    it('generates procurement recommendation for facility A shortage', () => {
      const risks = detector.detect(INVENTORY, DEMAND, CAPACITIES);
      const recs = recommender.generateRecommendations(risks);

      const procurements = recs.filter(
        (r) => r.type === 'procurement' && r.facility_id === 'FAC-A',
      );
      expect(procurements.length).toBeGreaterThanOrEqual(1);

      const proc = procurements[0]!;
      expect(proc.sku).toBe('SKU-001');
      expect(proc.status).toBe('pending');
      expect(proc.suggested_quantity).toBeDefined();
      expect(proc.suggested_quantity!).toBeGreaterThan(0);
      expect(proc.suggested_vendor_id).toBeDefined();
    });

    it('generates transfer recommendation from facility B surplus', () => {
      const risks = detector.detect(INVENTORY, DEMAND, CAPACITIES);
      const recs = recommender.generateRecommendations(risks);

      const transfers = recs.filter(
        (r) => r.type === 'transfer' && r.from_facility === 'FAC-B',
      );
      expect(transfers.length).toBeGreaterThanOrEqual(1);

      const transfer = transfers[0]!;
      expect(transfer.sku).toBe('SKU-001');
      expect(transfer.transfer_quantity).toBeDefined();
      expect(transfer.transfer_quantity!).toBeGreaterThan(0);
    });
  });

  describe('RiskScanScheduler', () => {
    it('runScan() produces a ScanResult with correct counts', async () => {
      const mockAdapter = createMockAdapter();
      const scheduler = new RiskScanScheduler(TEST_THRESHOLDS, mockAdapter, CAPACITIES);

      const result = await scheduler.runScan();

      expect(result.scan_id).toMatch(/^scan-/);
      expect(result.timestamp).toBeDefined();
      // We expect at least: 1 shortage + 1 surplus + 1 imbalance = 3 risks
      expect(result.risks_detected).toBeGreaterThanOrEqual(3);
      expect(result.recommendations_generated).toBeGreaterThanOrEqual(1);
      expect(result.alerts).toHaveLength(result.risks_detected);
      expect(result.recommendations).toHaveLength(result.recommendations_generated);
      // auto_executed should be 0 because autoActionEnabled = false
      expect(result.auto_executed).toBe(0);

      // Verify alerts were persisted via adapter
      expect(mockAdapter.persistedAlerts).toHaveLength(result.risks_detected);
    });

    it('auto-executes critical recommendations when enabled', async () => {
      const autoThresholds: RiskThresholds = {
        ...TEST_THRESHOLDS,
        autoActionEnabled: true,
        autoActionMaxValue: 50_000,
      };

      const mockAdapter = createMockAdapter();
      const scheduler = new RiskScanScheduler(autoThresholds, mockAdapter, CAPACITIES);

      const result = await scheduler.runScan();

      // Critical shortage at FAC-A should produce urgency >= 90
      // (severity=critical=100, days_of_supply<1 => +20, capped at 100)
      expect(result.auto_executed).toBeGreaterThanOrEqual(1);
      expect(mockAdapter.executedRecs.length).toBeGreaterThanOrEqual(1);
    });

    it('executeRecommendation calls the mock adapter', async () => {
      const mockAdapter = createMockAdapter();
      const scheduler = new RiskScanScheduler(TEST_THRESHOLDS, mockAdapter, CAPACITIES);

      await scheduler.runScan();

      const pendingRecs = scheduler.getRecommendations({ status: 'pending' });
      expect(pendingRecs.length).toBeGreaterThanOrEqual(1);

      const recId = pendingRecs[0]!.id;
      const execResult = await scheduler.executeRecommendation(recId);
      expect(execResult).not.toBeNull();
      expect(execResult!.success).toBe(true);
      expect(execResult!.order_id).toBeDefined();

      // Verify recommendation status changed to executed
      const executedRecs = scheduler.getRecommendations({ status: 'executed' });
      expect(executedRecs.some((r) => r.id === recId)).toBe(true);
    });
  });
});
