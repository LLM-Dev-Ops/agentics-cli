/**
 * End-to-end integration test: Full sustainability supply-chain flow.
 *
 * Demonstrates the complete pipeline across 10 ERP systems, from material
 * ingestion through sustainability compliance checking, audit trail
 * recording, and executive decision memo generation.
 *
 * Exercises:
 *   1. Multi-ERP adapter — ACL mapping for SAP, Oracle, NetSuite, Dynamics,
 *      Infor, Epicor, Sage X3, IFS, Workday, PeopleSoft
 *   2. DB adapter — in-memory persistence via DbClient
 *   3. Domain thresholds — recycled (5%), organic (2%), dye (10%)
 *   4. Audit trail — hash-chained tamper-evident logging
 *   5. ERP detection — keyword-based resolution for all 10 ERPs
 *   6. Decision memo — validates cost/ROI fields present in prompt
 */

import { AuditTrailService } from '../../src/compliance/audit-trail.js';
import type { DbClient } from '../../src/compliance/audit-trail.js';
import {
  mapSAPMaterialToDomain,
  mapSAPVendorToDomain,
  mapSAPQualityToDomain,
  mapSAPBatchToDomain,
  meetsRecycledThreshold,
  meetsOrganicThreshold,
  meetsDyeThreshold,
  THRESHOLD_RECYCLED_PCT,
  THRESHOLD_ORGANIC_PCT,
  THRESHOLD_DYE_PCT,
  getERPAdapter,
  listERPAdapters,
  listERPAdapterIds,
} from '../../src/infrastructure/sap-adapter.js';
import type { ERPWireRecord } from '../../src/infrastructure/sap-adapter.js';
import { InMemoryDbAdapter } from '../../src/infrastructure/db-adapter.js';
import {
  detectERPFromText,
  resolveERPDatabase,
} from '../../src/deps/erp-database-map.js';
import { AGENT_SYSTEM_PROMPTS } from '../../src/agents/system-prompts.js';

// ---------------------------------------------------------------------------
// Seed data — realistic apparel supply chain records (SAP wire format)
// ---------------------------------------------------------------------------

const SAP_SEED_MATERIALS: ERPWireRecord[] = [
  { MATNR: 'MAT-VN-001', ZZRECYCLED_PCT: 45, ZZORGANIC_FLAG: 'X', ZZSUSTAIN_CERT: 'GRS' },
  { MATNR: 'MAT-TR-002', ZZRECYCLED_PCT: 3, ZZORGANIC_FLAG: '', ZZSUSTAIN_CERT: '' },
  { MATNR: 'MAT-IN-003', ZZRECYCLED_PCT: 80, ZZORGANIC_FLAG: 'X', ZZSUSTAIN_CERT: 'GOTS' },
];

const SAP_SEED_VENDORS: ERPWireRecord[] = [
  { LIFNR: 'V-VN-100', ZZSUSTAIN_TIER: 'GOLD', ZZAUDIT_DATE: '20250115', ZZCOMPLIANCE_STATUS: 'COMPLIANT' },
  { LIFNR: 'V-TR-200', ZZSUSTAIN_TIER: 'BRONZE', ZZAUDIT_DATE: '20241020', ZZCOMPLIANCE_STATUS: 'CONDITIONAL' },
  { LIFNR: 'V-IN-300', ZZSUSTAIN_TIER: 'SILVER', ZZAUDIT_DATE: '20250301', ZZCOMPLIANCE_STATUS: 'COMPLIANT' },
];

const SAP_SEED_QUALITY: ERPWireRecord = {
  QMNUM: 'QN-2025-0042',
  ZZDYE_COMPLIANCE: 'X',
  ZZREACH_STATUS: 'PASSED',
  ZZOEKOTEX_CLASS: 'Class I',
  items: [
    { ZZCHEMICAL_ID: 'AZO-DYE-01', ZZTEST_RESULT: 2.3, ZZTHRESHOLD_PASS: 'X' },
    { ZZCHEMICAL_ID: 'FORMALDEHYDE-02', ZZTEST_RESULT: 8.1, ZZTHRESHOLD_PASS: 'X' },
    { ZZCHEMICAL_ID: 'HEAVY-METAL-03', ZZTEST_RESULT: 0.4, ZZTHRESHOLD_PASS: 'X' },
  ],
};

const SAP_SEED_BATCH: ERPWireRecord = {
  CHARG: 'BATCH-2025-VN-001',
  MATNR: 'MAT-VN-001',
  ZZDYE_LOT: 'DL-2025-042',
  ZZORIGIN_COUNTRY: 'VN',
  ZZFIBER_BLEND: '60% recycled polyester / 40% organic cotton',
  ZZCARBON_KG: 12.5,
  ZZWATER_LITERS: 2400,
  ZZENERGY_KWH: 85,
};

// ---------------------------------------------------------------------------
// Seed data for OTHER ERPs (one set per ERP, using each ERP's wire format)
// ---------------------------------------------------------------------------

const ORACLE_MATERIAL: ERPWireRecord = {
  ItemNumber: 'ITEM-ORA-001', RecycledContentPct: 55, OrganicCertified: 'Y', SustainabilityCertCode: 'GRS',
};
const ORACLE_VENDOR: ERPWireRecord = {
  SupplierId: 'SUP-ORA-100', SustainabilityRating: 'GOLD', LastAuditDate: '2025-02-10', ComplianceStatus: 'COMPLIANT',
};
const NETSUITE_MATERIAL: ERPWireRecord = {
  itemId: 'NS-ITEM-001', custitem_recycled_pct: 32, custitem_organic: 'T', custitem_sustain_cert: 'GOTS',
};
const NETSUITE_VENDOR: ERPWireRecord = {
  entityId: 'NS-VEND-100', custentity_sustain_tier: 'SILVER', custentity_audit_date: '2025-01-20', custentity_compliance: 'COMPLIANT',
};
const DYNAMICS_MATERIAL: ERPWireRecord = {
  ProductNumber: 'D365-PROD-001', cust_RecycledPercent: 60, cust_OrganicCertified: true, cust_SustainabilityCert: 'GRS',
};
const DYNAMICS_VENDOR: ERPWireRecord = {
  VendorAccountNumber: 'D365-V-100', cust_SustainabilityTier: 'GOLD', cust_LastAuditDate: '2025-03-01', cust_ComplianceStatus: 'COMPLIANT',
};
const INFOR_MATERIAL: ERPWireRecord = {
  ITNO: 'INF-ITEM-001', RecycledContentPercentage: 25, OrganicFlag: '1', SustainabilityCertType: 'OEKO-TEX',
};
const INFOR_VENDOR: ERPWireRecord = {
  SUNO: 'INF-SUP-100', SustainTier: 'BRONZE', AuditDate: '2024-11-15', ComplianceCode: 'CONDITIONAL',
};
const EPICOR_MATERIAL: ERPWireRecord = {
  PartNum: 'EPC-PART-001', RecycledContent_c: 70, OrganicCert_c: true, SustainCert_c: 'bluesign',
};
const EPICOR_VENDOR: ERPWireRecord = {
  VendorID: 'EPC-V-100', SustainTier_c: 'SILVER', AuditDate_c: '2025-01-05', CompStatus_c: 'COMPLIANT',
};
const SAGE_MATERIAL: ERPWireRecord = {
  ITMREF: 'SX3-ITM-001', YRECYCLEDPCT: 15, YORGANIC: 1, YSUSTAINCERT: 'GRS',
};
const SAGE_VENDOR: ERPWireRecord = {
  BPSNUM: 'SX3-BPS-100', YSUSTAINTIER: 'GOLD', YAUDITDAT: '20250210', YCOMPLIANCE: 'COMPLIANT',
};
const IFS_MATERIAL: ERPWireRecord = {
  PartNo: 'IFS-PT-001', CfRecycledPct: 42, CfOrganicCertified: 'TRUE', CfSustainabilityCert: 'GOTS',
};
const IFS_VENDOR: ERPWireRecord = {
  SupplierId: 'IFS-SUP-100', CfSustainTier: 'GOLD', CfAuditDate: '2025-02-20', CfComplianceStatus: 'COMPLIANT',
};
const WORKDAY_MATERIAL: ERPWireRecord = {
  Spend_Item_ID: 'WD-SI-001', Custom_Recycled_Percent: 38, Custom_Organic_Certified: true, Custom_Sustainability_Cert: 'GRS',
};
const WORKDAY_VENDOR: ERPWireRecord = {
  Supplier_ID: 'WD-SUP-100', Custom_Sustainability_Tier: 'SILVER', Custom_Last_Audit_Date: '2025-01-25', Custom_Compliance_Status: 'COMPLIANT',
};
const PSOFT_MATERIAL: ERPWireRecord = {
  INV_ITEM_ID: 'PS-INV-001', CUST_RECYCLED_PCT: 50, CUST_ORGANIC_FLG: 'Y', CUST_SUSTAIN_CERT: 'OEKO-TEX',
};
const PSOFT_VENDOR: ERPWireRecord = {
  VENDOR_ID: 'PS-V-100', CUST_SUSTAIN_TIER: 'GOLD', CUST_AUDIT_DT: '20250115', CUST_COMPLIANCE: 'COMPLIANT',
};

// ---------------------------------------------------------------------------
// Mock DbClient with audit log support
// ---------------------------------------------------------------------------

interface AuditRow {
  id: string;
  sequence_number: number;
  timestamp: string;
  correlation_id: string;
  actor: string;
  action: string;
  entity_type: string;
  entity_id: string | null;
  phase: 'before' | 'after';
  request_body: unknown;
  response_body: unknown;
  response_status: number | null;
  duration_ms: number | null;
  success: boolean | null;
  erp_wire_format: unknown;
  checksum: string;
  previous_checksum: string;
}

function createE2EDbClient(): DbClient & { auditLog: AuditRow[] } {
  const auditLog: AuditRow[] = [];

  return {
    auditLog,
    async query(sql: string, params: unknown[]): Promise<unknown[]> {
      if (sql.includes('audit_log') && sql.includes('correlation_id')) {
        return auditLog.filter((r) => r.correlation_id === params[0]);
      }
      if (sql.includes('audit_log') && sql.includes('ORDER BY sequence_number')) {
        return [...auditLog].sort((a, b) => a.sequence_number - b.sequence_number);
      }
      return [];
    },
    async execute(sql: string, params: unknown[]): Promise<void> {
      if (sql.includes('INSERT INTO audit_log')) {
        auditLog.push({
          id: params[0] as string,
          sequence_number: params[1] as number,
          timestamp: params[2] as string,
          correlation_id: params[3] as string,
          actor: params[4] as string,
          action: params[5] as string,
          entity_type: params[6] as string,
          entity_id: params[7] as string | null,
          phase: params[8] as 'before' | 'after',
          request_body: typeof params[9] === 'string' ? JSON.parse(params[9] as string) : params[9],
          response_body: typeof params[10] === 'string' ? JSON.parse(params[10] as string) : params[10],
          response_status: params[11] as number | null,
          duration_ms: params[12] as number | null,
          success: params[13] as boolean | null,
          erp_wire_format: typeof params[14] === 'string' ? JSON.parse(params[14] as string) : params[14],
          checksum: params[15] as string,
          previous_checksum: params[16] as string,
        });
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('End-to-end sustainability supply-chain flow', () => {
  let db: ReturnType<typeof createE2EDbClient>;
  let auditService: AuditTrailService;

  beforeEach(() => {
    db = createE2EDbClient();
    auditService = new AuditTrailService(db);
  });

  // =========================================================================
  // SAP S/4HANA (backward-compat convenience functions)
  // =========================================================================

  it('maps SAP MARA records to domain MaterialSustainability via ACL', () => {
    const domainMaterials = SAP_SEED_MATERIALS.map(mapSAPMaterialToDomain);

    expect(domainMaterials).toHaveLength(3);
    expect(domainMaterials[0]!.materialNumber).toBe('MAT-VN-001');
    expect(domainMaterials[0]!.recycledPercent).toBe(45);
    expect(domainMaterials[0]!.organicCertified).toBe(true);
    expect(domainMaterials[0]!.sustainabilityCertification).toBe('GRS');
    expect(domainMaterials[1]!.recycledPercent).toBe(3);
    expect(domainMaterials[1]!.organicCertified).toBe(false);
    expect(domainMaterials[2]!.recycledPercent).toBe(80);
  });

  it('maps SAP LFA1 vendor records to domain SupplierCompliance', () => {
    const domainVendors = SAP_SEED_VENDORS.map(mapSAPVendorToDomain);

    expect(domainVendors[0]!.vendorId).toBe('V-VN-100');
    expect(domainVendors[0]!.sustainabilityTier).toBe('gold');
    expect(domainVendors[0]!.complianceStatus).toBe('compliant');
    expect(domainVendors[0]!.lastAuditDate).toBe('2025-01-15');
    expect(domainVendors[1]!.sustainabilityTier).toBe('bronze');
  });

  it('maps SAP QMEL quality notifications to DyeComplianceResult', () => {
    const result = mapSAPQualityToDomain(SAP_SEED_QUALITY);

    expect(result.notificationId).toBe('QN-2025-0042');
    expect(result.dyeCompliance).toBe(true);
    expect(result.reachStatus).toBe('passed');
    expect(result.oekoTexClass).toBe('Class I');
    expect(result.testResults).toHaveLength(3);
    expect(result.testResults.every((t) => t.thresholdPassed)).toBe(true);
  });

  it('maps SAP CHVW batch records to BatchTraceability', () => {
    const batch = mapSAPBatchToDomain(SAP_SEED_BATCH);

    expect(batch.batchId).toBe('BATCH-2025-VN-001');
    expect(batch.originCountry).toBe('VN');
    expect(batch.fiberBlend).toContain('recycled polyester');
    expect(batch.carbonKg).toBe(12.5);
    expect(batch.waterLiters).toBe(2400);
  });

  // =========================================================================
  // Multi-ERP Adapter Registry
  // =========================================================================

  it('adapter registry has 10 distinct ERP adapters', () => {
    const adapters = listERPAdapters();
    expect(adapters.length).toBe(10);

    const ids = listERPAdapterIds();
    // 12 entries (SAP has 3 aliases: s4hana, ecc, business-one)
    expect(ids.length).toBe(12);
  });

  it('all 12 ERP IDs resolve to a valid adapter', () => {
    const ids = listERPAdapterIds();
    for (const id of ids) {
      const adapter = getERPAdapter(id);
      expect(adapter).toBeDefined();
      expect(adapter!.erpId).toBeTruthy();
      expect(adapter!.displayName).toBeTruthy();
    }
  });

  // =========================================================================
  // Oracle ERP Cloud
  // =========================================================================

  it('Oracle ERP Cloud: maps material and vendor records', () => {
    const adapter = getERPAdapter('oracle-erp')!;
    const mat = adapter.mapMaterial(ORACLE_MATERIAL);
    expect(mat.materialNumber).toBe('ITEM-ORA-001');
    expect(mat.recycledPercent).toBe(55);
    expect(mat.organicCertified).toBe(true);
    expect(mat.sustainabilityCertification).toBe('GRS');

    const vendor = adapter.mapVendor(ORACLE_VENDOR);
    expect(vendor.vendorId).toBe('SUP-ORA-100');
    expect(vendor.sustainabilityTier).toBe('gold');
    expect(vendor.complianceStatus).toBe('compliant');
  });

  // =========================================================================
  // Oracle NetSuite
  // =========================================================================

  it('NetSuite: maps custitem_/custentity_ fields correctly', () => {
    const adapter = getERPAdapter('oracle-netsuite')!;
    const mat = adapter.mapMaterial(NETSUITE_MATERIAL);
    expect(mat.materialNumber).toBe('NS-ITEM-001');
    expect(mat.recycledPercent).toBe(32);
    expect(mat.organicCertified).toBe(true);
    expect(mat.sustainabilityCertification).toBe('GOTS');

    const vendor = adapter.mapVendor(NETSUITE_VENDOR);
    expect(vendor.vendorId).toBe('NS-VEND-100');
    expect(vendor.sustainabilityTier).toBe('silver');
  });

  // =========================================================================
  // Microsoft Dynamics 365
  // =========================================================================

  it('Dynamics 365: maps cust_* custom fields correctly', () => {
    const adapter = getERPAdapter('microsoft-dynamics')!;
    const mat = adapter.mapMaterial(DYNAMICS_MATERIAL);
    expect(mat.materialNumber).toBe('D365-PROD-001');
    expect(mat.recycledPercent).toBe(60);
    expect(mat.organicCertified).toBe(true);

    const vendor = adapter.mapVendor(DYNAMICS_VENDOR);
    expect(vendor.vendorId).toBe('D365-V-100');
    expect(vendor.sustainabilityTier).toBe('gold');
  });

  // =========================================================================
  // Infor CloudSuite
  // =========================================================================

  it('Infor: maps M3 ITNO/SUNO fields correctly', () => {
    const adapter = getERPAdapter('infor')!;
    const mat = adapter.mapMaterial(INFOR_MATERIAL);
    expect(mat.materialNumber).toBe('INF-ITEM-001');
    expect(mat.recycledPercent).toBe(25);
    expect(mat.organicCertified).toBe(true);

    const vendor = adapter.mapVendor(INFOR_VENDOR);
    expect(vendor.vendorId).toBe('INF-SUP-100');
    expect(vendor.sustainabilityTier).toBe('bronze');
    expect(vendor.complianceStatus).toBe('conditional');
  });

  // =========================================================================
  // Epicor Kinetic
  // =========================================================================

  it('Epicor: maps _c suffix UD fields correctly', () => {
    const adapter = getERPAdapter('epicor')!;
    const mat = adapter.mapMaterial(EPICOR_MATERIAL);
    expect(mat.materialNumber).toBe('EPC-PART-001');
    expect(mat.recycledPercent).toBe(70);
    expect(mat.sustainabilityCertification).toBe('bluesign');

    const vendor = adapter.mapVendor(EPICOR_VENDOR);
    expect(vendor.vendorId).toBe('EPC-V-100');
    expect(vendor.sustainabilityTier).toBe('silver');
  });

  // =========================================================================
  // Sage X3
  // =========================================================================

  it('Sage X3: maps Y* prefix fields correctly', () => {
    const adapter = getERPAdapter('sage-x3')!;
    const mat = adapter.mapMaterial(SAGE_MATERIAL);
    expect(mat.materialNumber).toBe('SX3-ITM-001');
    expect(mat.recycledPercent).toBe(15);
    expect(mat.organicCertified).toBe(true);

    const vendor = adapter.mapVendor(SAGE_VENDOR);
    expect(vendor.vendorId).toBe('SX3-BPS-100');
    expect(vendor.sustainabilityTier).toBe('gold');
    // SAP-style date YYYYMMDD → ISO
    expect(vendor.lastAuditDate).toBe('2025-02-10');
  });

  // =========================================================================
  // IFS Cloud
  // =========================================================================

  it('IFS Cloud: maps Cf* prefix fields correctly', () => {
    const adapter = getERPAdapter('ifs')!;
    const mat = adapter.mapMaterial(IFS_MATERIAL);
    expect(mat.materialNumber).toBe('IFS-PT-001');
    expect(mat.recycledPercent).toBe(42);
    expect(mat.organicCertified).toBe(true);

    const vendor = adapter.mapVendor(IFS_VENDOR);
    expect(vendor.vendorId).toBe('IFS-SUP-100');
    expect(vendor.sustainabilityTier).toBe('gold');
  });

  // =========================================================================
  // Workday
  // =========================================================================

  it('Workday: maps Custom_* fields correctly', () => {
    const adapter = getERPAdapter('workday')!;
    const mat = adapter.mapMaterial(WORKDAY_MATERIAL);
    expect(mat.materialNumber).toBe('WD-SI-001');
    expect(mat.recycledPercent).toBe(38);
    expect(mat.organicCertified).toBe(true);

    const vendor = adapter.mapVendor(WORKDAY_VENDOR);
    expect(vendor.vendorId).toBe('WD-SUP-100');
    expect(vendor.sustainabilityTier).toBe('silver');
  });

  // =========================================================================
  // Oracle PeopleSoft
  // =========================================================================

  it('PeopleSoft: maps CUST_* fields with Y/N booleans correctly', () => {
    const adapter = getERPAdapter('oracle-peoplesoft')!;
    const mat = adapter.mapMaterial(PSOFT_MATERIAL);
    expect(mat.materialNumber).toBe('PS-INV-001');
    expect(mat.recycledPercent).toBe(50);
    expect(mat.organicCertified).toBe(true);

    const vendor = adapter.mapVendor(PSOFT_VENDOR);
    expect(vendor.vendorId).toBe('PS-V-100');
    expect(vendor.sustainabilityTier).toBe('gold');
    expect(vendor.lastAuditDate).toBe('2025-01-15');
  });

  // =========================================================================
  // All ERPs: same domain thresholds apply regardless of ERP source
  // =========================================================================

  it('domain thresholds are ERP-agnostic (5% recycled, 2% organic, 10% dye)', () => {
    expect(THRESHOLD_RECYCLED_PCT).toBe(5);
    expect(THRESHOLD_ORGANIC_PCT).toBe(2);
    expect(THRESHOLD_DYE_PCT).toBe(10);

    // Test thresholds with data from different ERPs
    const sapMat = getERPAdapter('sap-s4hana')!.mapMaterial(SAP_SEED_MATERIALS[0]!);
    const oracleMat = getERPAdapter('oracle-erp')!.mapMaterial(ORACLE_MATERIAL);
    const dynamicsMat = getERPAdapter('microsoft-dynamics')!.mapMaterial(DYNAMICS_MATERIAL);
    const epicorMat = getERPAdapter('epicor')!.mapMaterial(EPICOR_MATERIAL);

    expect(meetsRecycledThreshold(sapMat.recycledPercent)).toBe(true);      // 45%
    expect(meetsRecycledThreshold(oracleMat.recycledPercent)).toBe(true);   // 55%
    expect(meetsRecycledThreshold(dynamicsMat.recycledPercent)).toBe(true); // 60%
    expect(meetsRecycledThreshold(epicorMat.recycledPercent)).toBe(true);   // 70%

    // Turkish supplier below threshold — still fails regardless of ERP
    const sapBelowThreshold = getERPAdapter('sap-s4hana')!.mapMaterial(SAP_SEED_MATERIALS[1]!);
    expect(meetsRecycledThreshold(sapBelowThreshold.recycledPercent)).toBe(false); // 3%

    expect(meetsOrganicThreshold(2)).toBe(true);
    expect(meetsOrganicThreshold(1.5)).toBe(false);
    expect(meetsDyeThreshold(8.1)).toBe(true);
    expect(meetsDyeThreshold(10.1)).toBe(false);
  });

  // =========================================================================
  // ERP Detection — all 10 systems
  // =========================================================================

  it('detects all 10 ERP systems from prompt text', () => {
    const testCases: Array<{ prompt: string; expectedSystem: string; expectedEngine: string | null }> = [
      { prompt: 'Integrate with SAP S/4HANA procurement', expectedSystem: 'sap-s4hana', expectedEngine: 'sap-hana' },
      { prompt: 'Connect to Oracle ERP Cloud Fusion', expectedSystem: 'oracle-erp', expectedEngine: 'oracle' },
      { prompt: 'Pull data from NetSuite inventory', expectedSystem: 'oracle-netsuite', expectedEngine: 'oracle' },
      { prompt: 'Query Microsoft Dynamics 365 vendors', expectedSystem: 'microsoft-dynamics', expectedEngine: 'sql-server' },
      { prompt: 'Build adapter for Infor CloudSuite M3', expectedSystem: 'infor', expectedEngine: 'oracle' },
      { prompt: 'Connect to Epicor Kinetic parts', expectedSystem: 'epicor', expectedEngine: 'sql-server' },
      { prompt: 'Sync with Sage X3 products', expectedSystem: 'sage-x3', expectedEngine: 'sql-server' },
      { prompt: 'Integrate IFS Cloud quality data', expectedSystem: 'ifs', expectedEngine: 'sql-server' },
      { prompt: 'Fetch Workday supplier records', expectedSystem: 'workday', expectedEngine: null },
      { prompt: 'Extract from PeopleSoft inventory', expectedSystem: 'oracle-peoplesoft', expectedEngine: 'oracle' },
    ];

    for (const tc of testCases) {
      const results = detectERPFromText(tc.prompt);
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0]!.system).toBe(tc.expectedSystem);

      const mapping = resolveERPDatabase(results[0]!.system);
      expect(mapping.primaryEngine).toBe(tc.expectedEngine);
    }
  });

  // =========================================================================
  // Audit Trail with Hash Chain (ERP-agnostic)
  // =========================================================================

  it('records multi-ERP ingestion flow with tamper-evident audit trail', async () => {
    const correlationId = 'e2e-multi-erp';

    // Ingest from 3 different ERPs in the same audit chain
    const sapMat = getERPAdapter('sap-s4hana')!.mapMaterial(SAP_SEED_MATERIALS[0]!);
    const oracleMat = getERPAdapter('oracle-erp')!.mapMaterial(ORACLE_MATERIAL);
    const dynamicsMat = getERPAdapter('microsoft-dynamics')!.mapMaterial(DYNAMICS_MATERIAL);

    await auditService.recordBefore(correlationId, 'multi-erp-adapter', 'INGEST', 'materials', {
      erp_sources: ['sap-s4hana', 'oracle-erp', 'microsoft-dynamics'],
      material_count: 3,
    });

    // All pass thresholds
    const allCompliant = [sapMat, oracleMat, dynamicsMat].every(
      (m) => meetsRecycledThreshold(m.recycledPercent),
    );
    expect(allCompliant).toBe(true);

    await auditService.recordAfter(correlationId, 'multi-erp-adapter', 'INGEST', 'materials', null, {
      compliant: 3, non_compliant: 0,
    }, 200, 85, true);

    const integrity = await auditService.verifyChainIntegrity();
    expect(integrity.valid).toBe(true);

    const records = await auditService.getByCorrelationId(correlationId);
    expect(records).toHaveLength(2);
  });

  // =========================================================================
  // InMemoryDbAdapter
  // =========================================================================

  it('InMemoryDbAdapter supports insert and query operations', async () => {
    const memDb = new InMemoryDbAdapter();

    await memDb.execute(
      'INSERT INTO materials (id, name, recycled_pct) VALUES ($1, $2, $3)',
      ['MAT-001', 'Recycled Polyester', 45],
    );
    await memDb.execute(
      'INSERT INTO materials (id, name, recycled_pct) VALUES ($1, $2, $3)',
      ['MAT-002', 'Organic Cotton', 100],
    );

    const allRows = await memDb.query('SELECT * FROM materials', []);
    expect(allRows).toHaveLength(2);

    const filtered = await memDb.query('SELECT * FROM materials WHERE id = $1', ['MAT-001']);
    expect(filtered).toHaveLength(1);
    expect((filtered[0] as Record<string, unknown>)['name']).toBe('Recycled Polyester');
  });

  // =========================================================================
  // Decision Memo Prompt includes Cost/ROI fields
  // =========================================================================

  it('decision-memo system prompt includes cost_estimate and roi_analysis fields', () => {
    const prompt = AGENT_SYSTEM_PROMPTS['platform']!['decision-memo']!;

    expect(prompt).toContain('cost_estimate');
    expect(prompt).toContain('implementation_cost_usd');
    expect(prompt).toContain('annual_operating_cost_usd');
    expect(prompt).toContain('cost_breakdown');
    expect(prompt).toContain('roi_analysis');
    expect(prompt).toContain('projected_annual_savings_usd');
    expect(prompt).toContain('payback_period_months');
    expect(prompt).toContain('three_year_roi_percent');
    expect(prompt).toContain('value_drivers');
    expect(prompt).toContain('go_no_go');
  });

  // =========================================================================
  // Full cross-ERP end-to-end flow
  // =========================================================================

  it('end-to-end: multi-ERP ingestion → threshold check → quality → audit → chain verified', async () => {
    const correlationId = 'e2e-full-multi-erp';

    // Step 1: Ingest materials from 4 different ERPs
    const materials = [
      getERPAdapter('sap-s4hana')!.mapMaterial(SAP_SEED_MATERIALS[0]!),
      getERPAdapter('oracle-erp')!.mapMaterial(ORACLE_MATERIAL),
      getERPAdapter('microsoft-dynamics')!.mapMaterial(DYNAMICS_MATERIAL),
      getERPAdapter('epicor')!.mapMaterial(EPICOR_MATERIAL),
    ];

    // Step 2: Check recycled thresholds
    const complianceResults = materials.map((m) => ({
      materialNumber: m.materialNumber,
      recycledCompliant: meetsRecycledThreshold(m.recycledPercent),
    }));
    expect(complianceResults.every((c) => c.recycledCompliant)).toBe(true);

    // Step 3: Quality check from SAP
    const dyeResult = mapSAPQualityToDomain(SAP_SEED_QUALITY);
    expect(dyeResult.testResults.every((t) => t.thresholdPassed)).toBe(true);

    // Step 4: Batch traceability from SAP
    const batch = mapSAPBatchToDomain(SAP_SEED_BATCH);
    expect(batch.originCountry).toBe('VN');

    // Step 5: Audit the complete flow
    await auditService.recordBefore(correlationId, 'e2e-flow', 'FULL_PIPELINE', 'sustainability', {
      erp_sources: ['sap-s4hana', 'oracle-erp', 'microsoft-dynamics', 'epicor'],
      materials_ingested: materials.length,
    });

    await auditService.recordAfter(correlationId, 'e2e-flow', 'FULL_PIPELINE', 'sustainability', null, {
      compliant: complianceResults.filter((c) => c.recycledCompliant).length,
      non_compliant: complianceResults.filter((c) => !c.recycledCompliant).length,
      dye_compliance: dyeResult.dyeCompliance,
      reach_status: dyeResult.reachStatus,
    }, 200, 150, true);

    // Step 6: Verify chain integrity
    const integrity = await auditService.verifyChainIntegrity();
    expect(integrity.valid).toBe(true);

    const records = await auditService.getByCorrelationId(correlationId);
    expect(records).toHaveLength(2);
    const afterRecord = records.find((r) => r.phase === 'after')!;
    expect((afterRecord.response_body as Record<string, unknown>)['compliant']).toBe(4);
  });
});
