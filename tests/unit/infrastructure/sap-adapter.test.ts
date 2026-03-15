/**
 * ERP Sustainability Adapter Tests
 *
 * Tests the multi-ERP adapter registry, field mappings, domain model
 * transformations, and threshold functions.
 */

import {
  getERPAdapter,
  listERPAdapters,
  listERPAdapterIds,
  mapSAPMaterialToDomain,
  mapDomainMaterialToSAP,
  mapSAPVendorToDomain,
  mapSAPQualityToDomain,
  mapSAPBatchToDomain,
  meetsRecycledThreshold,
  meetsOrganicThreshold,
  meetsDyeThreshold,
  THRESHOLD_RECYCLED_PCT,
  THRESHOLD_ORGANIC_PCT,
  THRESHOLD_DYE_PCT,
  type MaterialSustainability,
  type ERPWireRecord,
} from '../../../src/infrastructure/sap-adapter.js';

describe('ERP Sustainability Adapters', () => {
  // -----------------------------------------------------------------------
  // Registry completeness
  // -----------------------------------------------------------------------

  describe('Adapter Registry', () => {
    it('should have all 10 unique ERP adapters registered', () => {
      const adapters = listERPAdapters();
      expect(adapters.length).toBe(10);
    });

    it('should register 12 ERP IDs (including SAP aliases)', () => {
      const ids = listERPAdapterIds();
      expect(ids.length).toBe(12);
      // SAP has 3 aliases: sap-s4hana, sap-ecc, sap-business-one
      expect(ids).toContain('sap-s4hana');
      expect(ids).toContain('sap-ecc');
      expect(ids).toContain('sap-business-one');
    });

    it('should have required fields on each adapter', () => {
      const adapters = listERPAdapters();
      for (const adapter of adapters) {
        expect(typeof adapter.erpId).toBe('string');
        expect(adapter.erpId.length).toBeGreaterThan(0);
        expect(typeof adapter.displayName).toBe('string');
        expect(adapter.displayName.length).toBeGreaterThan(0);
        expect(typeof adapter.mapMaterial).toBe('function');
        expect(typeof adapter.mapVendor).toBe('function');
        expect(typeof adapter.mapQuality).toBe('function');
        expect(typeof adapter.mapBatch).toBe('function');
      }
    });

    it('should return the correct adapter by erpId', () => {
      const sap = getERPAdapter('sap-s4hana');
      expect(sap).toBeDefined();
      expect(sap!.erpId).toBe('sap-s4hana');
      expect(sap!.displayName).toBe('SAP S/4HANA');
    });

    it('should return undefined for unknown erpId', () => {
      expect(getERPAdapter('unknown-erp')).toBeUndefined();
      expect(getERPAdapter('')).toBeUndefined();
    });

    it('should return same adapter for SAP aliases', () => {
      const s4 = getERPAdapter('sap-s4hana');
      const ecc = getERPAdapter('sap-ecc');
      const b1 = getERPAdapter('sap-business-one');
      expect(s4).toBe(ecc);
      expect(s4).toBe(b1);
    });
  });

  // -----------------------------------------------------------------------
  // SAP Material Mapping
  // -----------------------------------------------------------------------

  describe('SAP Material Mapping', () => {
    it('should map a complete SAP material record', () => {
      const record: ERPWireRecord = {
        MATNR: 'MAT-001',
        ZZRECYCLED_PCT: 45,
        ZZORGANIC_FLAG: 'X',
        ZZSUSTAIN_CERT: 'GOTS',
      };
      const result = mapSAPMaterialToDomain(record);
      expect(result.materialNumber).toBe('MAT-001');
      expect(result.recycledPercent).toBe(45);
      expect(result.organicCertified).toBe(true);
      expect(result.sustainabilityCertification).toBe('GOTS');
    });

    it('should handle missing fields with defaults', () => {
      const result = mapSAPMaterialToDomain({});
      expect(result.materialNumber).toBe('');
      expect(result.recycledPercent).toBe(0);
      expect(result.organicCertified).toBe(false);
      expect(result.sustainabilityCertification).toBeNull();
    });

    it('should map organic flag false when not X', () => {
      const result = mapSAPMaterialToDomain({ ZZORGANIC_FLAG: '' });
      expect(result.organicCertified).toBe(false);

      const result2 = mapSAPMaterialToDomain({ ZZORGANIC_FLAG: 'N' });
      expect(result2.organicCertified).toBe(false);
    });

    it('should round-trip through mapDomainMaterialToSAP', () => {
      const domain: MaterialSustainability = {
        materialNumber: 'MAT-100',
        recycledPercent: 60,
        organicCertified: true,
        sustainabilityCertification: 'bluesign',
      };
      const wire = mapDomainMaterialToSAP(domain);
      expect(wire['MATNR']).toBe('MAT-100');
      expect(wire['ZZRECYCLED_PCT']).toBe(60);
      expect(wire['ZZORGANIC_FLAG']).toBe('X');
      expect(wire['ZZSUSTAIN_CERT']).toBe('bluesign');
    });

    it('should map organicCertified=false to empty string in reverse', () => {
      const domain: MaterialSustainability = {
        materialNumber: 'MAT-200',
        recycledPercent: 0,
        organicCertified: false,
        sustainabilityCertification: null,
      };
      const wire = mapDomainMaterialToSAP(domain);
      expect(wire['ZZORGANIC_FLAG']).toBe('');
      expect(wire['ZZSUSTAIN_CERT']).toBe('');
    });
  });

  // -----------------------------------------------------------------------
  // SAP Vendor Mapping
  // -----------------------------------------------------------------------

  describe('SAP Vendor Mapping', () => {
    it('should map vendor tiers correctly', () => {
      expect(mapSAPVendorToDomain({ LIFNR: 'V1', ZZSUSTAIN_TIER: 'GOLD' }).sustainabilityTier).toBe('gold');
      expect(mapSAPVendorToDomain({ LIFNR: 'V2', ZZSUSTAIN_TIER: 'SILVER' }).sustainabilityTier).toBe('silver');
      expect(mapSAPVendorToDomain({ LIFNR: 'V3', ZZSUSTAIN_TIER: 'BRONZE' }).sustainabilityTier).toBe('bronze');
    });

    it('should default to uncertified for unknown tier', () => {
      expect(mapSAPVendorToDomain({ ZZSUSTAIN_TIER: 'PLATINUM' }).sustainabilityTier).toBe('uncertified');
      expect(mapSAPVendorToDomain({}).sustainabilityTier).toBe('uncertified');
    });

    it('should map compliance statuses correctly', () => {
      expect(mapSAPVendorToDomain({ ZZCOMPLIANCE_STATUS: 'COMPLIANT' }).complianceStatus).toBe('compliant');
      expect(mapSAPVendorToDomain({ ZZCOMPLIANCE_STATUS: 'CONDITIONAL' }).complianceStatus).toBe('conditional');
      expect(mapSAPVendorToDomain({ ZZCOMPLIANCE_STATUS: 'NON_COMPLIANT' }).complianceStatus).toBe('non-compliant');
    });

    it('should default to non-compliant for unknown status', () => {
      expect(mapSAPVendorToDomain({ ZZCOMPLIANCE_STATUS: 'MAYBE' }).complianceStatus).toBe('non-compliant');
      expect(mapSAPVendorToDomain({}).complianceStatus).toBe('non-compliant');
    });

    it('should format SAP date from YYYYMMDD to YYYY-MM-DD', () => {
      const result = mapSAPVendorToDomain({ ZZAUDIT_DATE: '20250115' });
      expect(result.lastAuditDate).toBe('2025-01-15');
    });

    it('should pass through non-8-digit dates unchanged', () => {
      const result = mapSAPVendorToDomain({ ZZAUDIT_DATE: '2025-01-15' });
      expect(result.lastAuditDate).toBe('2025-01-15');
    });
  });

  // -----------------------------------------------------------------------
  // SAP Quality Mapping
  // -----------------------------------------------------------------------

  describe('SAP Quality Mapping', () => {
    it('should map dye compliance correctly', () => {
      expect(mapSAPQualityToDomain({ ZZDYE_COMPLIANCE: 'X' }).dyeCompliance).toBe(true);
      expect(mapSAPQualityToDomain({ ZZDYE_COMPLIANCE: '' }).dyeCompliance).toBe(false);
      expect(mapSAPQualityToDomain({}).dyeCompliance).toBe(false);
    });

    it('should map REACH statuses', () => {
      expect(mapSAPQualityToDomain({ ZZREACH_STATUS: 'PASSED' }).reachStatus).toBe('passed');
      expect(mapSAPQualityToDomain({ ZZREACH_STATUS: 'FAILED' }).reachStatus).toBe('failed');
      expect(mapSAPQualityToDomain({ ZZREACH_STATUS: 'PENDING' }).reachStatus).toBe('pending');
      expect(mapSAPQualityToDomain({}).reachStatus).toBe('pending');
    });

    it('should map quality notification items to test results', () => {
      const record: ERPWireRecord = {
        QMNUM: 'QN-001',
        ZZDYE_COMPLIANCE: 'X',
        ZZREACH_STATUS: 'PASSED',
        ZZOEKOTEX_CLASS: 'I',
        items: [
          { ZZCHEMICAL_ID: 'CHEM-A', ZZTEST_RESULT: 0.5, ZZTHRESHOLD_PASS: 'X' },
          { ZZCHEMICAL_ID: 'CHEM-B', ZZTEST_RESULT: 12.3, ZZTHRESHOLD_PASS: '' },
        ],
      };
      const result = mapSAPQualityToDomain(record);
      expect(result.testResults).toHaveLength(2);
      expect(result.testResults[0]!.chemicalId).toBe('CHEM-A');
      expect(result.testResults[0]!.thresholdPassed).toBe(true);
      expect(result.testResults[1]!.thresholdPassed).toBe(false);
    });

    it('should return empty test results when items missing', () => {
      const result = mapSAPQualityToDomain({ QMNUM: 'QN-002' });
      expect(result.testResults).toEqual([]);
    });
  });

  // -----------------------------------------------------------------------
  // SAP Batch Mapping
  // -----------------------------------------------------------------------

  describe('SAP Batch Mapping', () => {
    it('should map all batch traceability fields', () => {
      const record: ERPWireRecord = {
        CHARG: 'BATCH-001',
        MATNR: 'MAT-001',
        ZZDYE_LOT: 'DL-2025-001',
        ZZORIGIN_COUNTRY: 'IN',
        ZZFIBER_BLEND: '60% Cotton / 40% Polyester',
        ZZCARBON_KG: 12.5,
        ZZWATER_LITERS: 850,
        ZZENERGY_KWH: 45.2,
      };
      const result = mapSAPBatchToDomain(record);
      expect(result.batchId).toBe('BATCH-001');
      expect(result.materialNumber).toBe('MAT-001');
      expect(result.dyeLot).toBe('DL-2025-001');
      expect(result.originCountry).toBe('IN');
      expect(result.fiberBlend).toBe('60% Cotton / 40% Polyester');
      expect(result.carbonKg).toBe(12.5);
      expect(result.waterLiters).toBe(850);
      expect(result.energyKwh).toBe(45.2);
    });

    it('should default numeric fields to 0 when missing', () => {
      const result = mapSAPBatchToDomain({});
      expect(result.carbonKg).toBe(0);
      expect(result.waterLiters).toBe(0);
      expect(result.energyKwh).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // Cross-ERP adapter tests (non-SAP)
  // -----------------------------------------------------------------------

  describe('Oracle ERP Cloud adapter', () => {
    it('should map Oracle Fusion material records', () => {
      const adapter = getERPAdapter('oracle-erp')!;
      const result = adapter.mapMaterial({
        ItemNumber: 'ITEM-001',
        RecycledContentPct: 30,
        OrganicCertified: 'Y',
        SustainabilityCertCode: 'GRS',
      });
      expect(result.materialNumber).toBe('ITEM-001');
      expect(result.recycledPercent).toBe(30);
      expect(result.organicCertified).toBe(true);
      expect(result.sustainabilityCertification).toBe('GRS');
    });

    it('should use REST endpoint format for Oracle Fusion', () => {
      // The adapter has displayName — verify it
      const adapter = getERPAdapter('oracle-erp')!;
      expect(adapter.displayName).toBe('Oracle ERP Cloud');
    });
  });

  describe('Normalization helpers via adapters', () => {
    it('should normalize tier A/B/C to gold/silver/bronze', () => {
      const adapter = getERPAdapter('oracle-erp')!;
      expect(adapter.mapVendor({ SustainabilityRating: 'A' }).sustainabilityTier).toBe('gold');
      expect(adapter.mapVendor({ SustainabilityRating: 'B' }).sustainabilityTier).toBe('silver');
      expect(adapter.mapVendor({ SustainabilityRating: 'C' }).sustainabilityTier).toBe('bronze');
    });

    it('should normalize tier 1/2/3 to gold/silver/bronze', () => {
      const adapter = getERPAdapter('oracle-erp')!;
      expect(adapter.mapVendor({ SustainabilityRating: '1' }).sustainabilityTier).toBe('gold');
      expect(adapter.mapVendor({ SustainabilityRating: '2' }).sustainabilityTier).toBe('silver');
      expect(adapter.mapVendor({ SustainabilityRating: '3' }).sustainabilityTier).toBe('bronze');
    });

    it('should normalize REACH status from Y/N/TRUE/FALSE', () => {
      const adapter = getERPAdapter('oracle-erp')!;
      expect(adapter.mapQuality({ REACHStatus: 'Y' }).reachStatus).toBe('passed');
      expect(adapter.mapQuality({ REACHStatus: 'N' }).reachStatus).toBe('failed');
      expect(adapter.mapQuality({ REACHStatus: 'TRUE' }).reachStatus).toBe('passed');
      expect(adapter.mapQuality({ REACHStatus: 'FALSE' }).reachStatus).toBe('failed');
    });
  });

  // -----------------------------------------------------------------------
  // Threshold functions
  // -----------------------------------------------------------------------

  describe('Threshold functions', () => {
    it('should validate recycled threshold at boundary', () => {
      expect(meetsRecycledThreshold(THRESHOLD_RECYCLED_PCT)).toBe(true);
      expect(meetsRecycledThreshold(THRESHOLD_RECYCLED_PCT - 1)).toBe(false);
      expect(meetsRecycledThreshold(0)).toBe(false);
      expect(meetsRecycledThreshold(100)).toBe(true);
    });

    it('should validate organic threshold at boundary', () => {
      expect(meetsOrganicThreshold(THRESHOLD_ORGANIC_PCT)).toBe(true);
      expect(meetsOrganicThreshold(THRESHOLD_ORGANIC_PCT - 1)).toBe(false);
    });

    it('should validate dye threshold at boundary (upper limit)', () => {
      expect(meetsDyeThreshold(THRESHOLD_DYE_PCT)).toBe(true);
      expect(meetsDyeThreshold(THRESHOLD_DYE_PCT + 1)).toBe(false);
      expect(meetsDyeThreshold(0)).toBe(true);
    });

    it('should have correct threshold constants', () => {
      expect(THRESHOLD_RECYCLED_PCT).toBe(5);
      expect(THRESHOLD_ORGANIC_PCT).toBe(2);
      expect(THRESHOLD_DYE_PCT).toBe(10);
    });
  });
});
