/**
 * ERP Sustainability Adapters — infrastructure layer for multi-ERP integration.
 *
 * Implements the Anti-Corruption Layer pattern for 10 enterprise ERP systems.
 * Each adapter translates between the ERP's native wire format and the
 * internal domain model (MaterialSustainability, SupplierCompliance, etc.).
 *
 * Supported ERP systems:
 *   1. SAP S/4HANA      — OData + BAPI (MARA, EKPO, LIPS, QMEL, AFKO, CHVW, LFA1)
 *   2. Oracle ERP Cloud  — REST (Fusion Procurement, Quality)
 *   3. Oracle NetSuite   — SuiteQL + SuiteTalk REST (Items, Vendors, QA)
 *   4. Microsoft Dynamics — Dataverse OData (Products, Vendors, Quality Orders)
 *   5. Infor CloudSuite  — ION API + Data Lake (Items, Suppliers, QC)
 *   6. Epicor Kinetic     — REST v2 (Parts, Suppliers, Inspections)
 *   7. Sage X3           — REST (Products, BPs, Quality)
 *   8. IFS Cloud         — OData (InventoryParts, Suppliers, QualityPlans)
 *   9. Workday           — SOAP/REST (Spend, Suppliers, PRISM Analytics)
 *  10. PeopleSoft        — Component Interface (Items, Vendors, Quality)
 *
 * Domain model is ERP-agnostic — only the wire-format mappers change.
 */

// ---------------------------------------------------------------------------
// Domain Value Objects (wire-format agnostic — shared by ALL ERPs)
// ---------------------------------------------------------------------------

export interface MaterialSustainability {
  readonly materialNumber: string;
  readonly recycledPercent: number;
  readonly organicCertified: boolean;
  readonly sustainabilityCertification: string | null;
}

export interface SupplierCompliance {
  readonly vendorId: string;
  readonly sustainabilityTier: 'gold' | 'silver' | 'bronze' | 'uncertified';
  readonly lastAuditDate: string;
  readonly complianceStatus: 'compliant' | 'conditional' | 'non-compliant';
}

export interface DyeComplianceResult {
  readonly notificationId: string;
  readonly dyeCompliance: boolean;
  readonly reachStatus: 'passed' | 'failed' | 'pending';
  readonly oekoTexClass: string | null;
  readonly testResults: readonly LabTestResult[];
}

export interface LabTestResult {
  readonly chemicalId: string;
  readonly result: number;
  readonly thresholdPassed: boolean;
}

export interface BatchTraceability {
  readonly batchId: string;
  readonly materialNumber: string;
  readonly dyeLot: string;
  readonly originCountry: string;
  readonly fiberBlend: string;
  readonly carbonKg: number;
  readonly waterLiters: number;
  readonly energyKwh: number;
}

// ---------------------------------------------------------------------------
// Generic ERP Wire Record — common shape, each ERP maps fields differently
// ---------------------------------------------------------------------------

/** Loosely-typed record from any ERP. Each ERP adapter knows its own keys. */
export interface ERPWireRecord {
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// ERP Adapter Interface — every ERP implements this
// ---------------------------------------------------------------------------

export interface ERPSustainabilityAdapter {
  readonly erpId: string;
  readonly displayName: string;
  mapMaterial(record: ERPWireRecord): MaterialSustainability;
  mapVendor(record: ERPWireRecord): SupplierCompliance;
  mapQuality(record: ERPWireRecord): DyeComplianceResult;
  mapBatch(record: ERPWireRecord): BatchTraceability;
}

// ============================================================================
// 1. SAP S/4HANA
// ============================================================================

function sapBool(val: unknown): boolean { return val === 'X' || val === true; }
function sapDate(val: unknown): string {
  const s = String(val ?? '');
  return s.length === 8 ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : s;
}

const sapAdapter: ERPSustainabilityAdapter = {
  erpId: 'sap-s4hana',
  displayName: 'SAP S/4HANA',
  mapMaterial(r) {
    return {
      materialNumber: String(r['MATNR'] ?? ''),
      recycledPercent: Number(r['ZZRECYCLED_PCT'] ?? 0),
      organicCertified: sapBool(r['ZZORGANIC_FLAG']),
      sustainabilityCertification: (r['ZZSUSTAIN_CERT'] as string) || null,
    };
  },
  mapVendor(r) {
    const tierMap: Record<string, SupplierCompliance['sustainabilityTier']> = {
      'GOLD': 'gold', 'SILVER': 'silver', 'BRONZE': 'bronze',
    };
    const statusMap: Record<string, SupplierCompliance['complianceStatus']> = {
      'COMPLIANT': 'compliant', 'CONDITIONAL': 'conditional', 'NON_COMPLIANT': 'non-compliant',
    };
    return {
      vendorId: String(r['LIFNR'] ?? ''),
      sustainabilityTier: tierMap[String(r['ZZSUSTAIN_TIER'] ?? '')] ?? 'uncertified',
      lastAuditDate: sapDate(r['ZZAUDIT_DATE']),
      complianceStatus: statusMap[String(r['ZZCOMPLIANCE_STATUS'] ?? '')] ?? 'non-compliant',
    };
  },
  mapQuality(r) {
    const reachMap: Record<string, DyeComplianceResult['reachStatus']> = {
      'PASSED': 'passed', 'FAILED': 'failed', 'PENDING': 'pending',
    };
    const items = (r['items'] ?? []) as ERPWireRecord[];
    return {
      notificationId: String(r['QMNUM'] ?? ''),
      dyeCompliance: sapBool(r['ZZDYE_COMPLIANCE']),
      reachStatus: reachMap[String(r['ZZREACH_STATUS'] ?? '')] ?? 'pending',
      oekoTexClass: (r['ZZOEKOTEX_CLASS'] as string) || null,
      testResults: items.map((item) => ({
        chemicalId: String(item['ZZCHEMICAL_ID'] ?? ''),
        result: Number(item['ZZTEST_RESULT'] ?? 0),
        thresholdPassed: sapBool(item['ZZTHRESHOLD_PASS']),
      })),
    };
  },
  mapBatch(r) {
    return {
      batchId: String(r['CHARG'] ?? ''),
      materialNumber: String(r['MATNR'] ?? ''),
      dyeLot: String(r['ZZDYE_LOT'] ?? ''),
      originCountry: String(r['ZZORIGIN_COUNTRY'] ?? ''),
      fiberBlend: String(r['ZZFIBER_BLEND'] ?? ''),
      carbonKg: Number(r['ZZCARBON_KG'] ?? 0),
      waterLiters: Number(r['ZZWATER_LITERS'] ?? 0),
      energyKwh: Number(r['ZZENERGY_KWH'] ?? 0),
    };
  },
};

// ============================================================================
// 2. Oracle ERP Cloud (Fusion)
// ============================================================================

const oracleErpAdapter: ERPSustainabilityAdapter = {
  erpId: 'oracle-erp',
  displayName: 'Oracle ERP Cloud',
  mapMaterial(r) {
    return {
      materialNumber: String(r['ItemNumber'] ?? ''),
      recycledPercent: Number(r['RecycledContentPct'] ?? 0),
      organicCertified: r['OrganicCertified'] === true || r['OrganicCertified'] === 'Y',
      sustainabilityCertification: (r['SustainabilityCertCode'] as string) || null,
    };
  },
  mapVendor(r) {
    return {
      vendorId: String(r['SupplierId'] ?? ''),
      sustainabilityTier: normalizeTier(r['SustainabilityRating']),
      lastAuditDate: normalizeDate(r['LastAuditDate']),
      complianceStatus: normalizeStatus(r['ComplianceStatus']),
    };
  },
  mapQuality(r) {
    const inspections = (r['InspectionResults'] ?? []) as ERPWireRecord[];
    return {
      notificationId: String(r['QualityIssueId'] ?? ''),
      dyeCompliance: r['DyeComplianceFlag'] === 'Y' || r['DyeComplianceFlag'] === true,
      reachStatus: normalizeReach(r['REACHStatus']),
      oekoTexClass: (r['OEKOTEXClassification'] as string) || null,
      testResults: inspections.map((i) => ({
        chemicalId: String(i['ChemicalSubstanceId'] ?? ''),
        result: Number(i['TestResult'] ?? 0),
        thresholdPassed: i['WithinThreshold'] === 'Y' || i['WithinThreshold'] === true,
      })),
    };
  },
  mapBatch(r) {
    return {
      batchId: String(r['LotNumber'] ?? ''),
      materialNumber: String(r['ItemNumber'] ?? ''),
      dyeLot: String(r['DyeLotReference'] ?? ''),
      originCountry: String(r['CountryOfOrigin'] ?? ''),
      fiberBlend: String(r['FiberComposition'] ?? ''),
      carbonKg: Number(r['CarbonFootprintKg'] ?? 0),
      waterLiters: Number(r['WaterUsageLiters'] ?? 0),
      energyKwh: Number(r['EnergyConsumptionKwh'] ?? 0),
    };
  },
};

// ============================================================================
// 3. Oracle NetSuite
// ============================================================================

const netsuiteAdapter: ERPSustainabilityAdapter = {
  erpId: 'oracle-netsuite',
  displayName: 'Oracle NetSuite',
  mapMaterial(r) {
    return {
      materialNumber: String(r['itemId'] ?? r['name'] ?? ''),
      recycledPercent: Number(r['custitem_recycled_pct'] ?? 0),
      organicCertified: r['custitem_organic'] === true || r['custitem_organic'] === 'T',
      sustainabilityCertification: (r['custitem_sustain_cert'] as string) || null,
    };
  },
  mapVendor(r) {
    return {
      vendorId: String(r['entityId'] ?? ''),
      sustainabilityTier: normalizeTier(r['custentity_sustain_tier']),
      lastAuditDate: normalizeDate(r['custentity_audit_date']),
      complianceStatus: normalizeStatus(r['custentity_compliance']),
    };
  },
  mapQuality(r) {
    const lines = (r['custrecord_qa_lines'] ?? []) as ERPWireRecord[];
    return {
      notificationId: String(r['custrecord_qa_id'] ?? ''),
      dyeCompliance: r['custrecord_dye_pass'] === true || r['custrecord_dye_pass'] === 'T',
      reachStatus: normalizeReach(r['custrecord_reach']),
      oekoTexClass: (r['custrecord_oekotex'] as string) || null,
      testResults: lines.map((l) => ({
        chemicalId: String(l['custrecord_chemical_id'] ?? ''),
        result: Number(l['custrecord_test_val'] ?? 0),
        thresholdPassed: l['custrecord_pass'] === true || l['custrecord_pass'] === 'T',
      })),
    };
  },
  mapBatch(r) {
    return {
      batchId: String(r['inventoryNumber'] ?? ''),
      materialNumber: String(r['itemId'] ?? ''),
      dyeLot: String(r['custitem_dye_lot'] ?? ''),
      originCountry: String(r['custitem_origin_country'] ?? ''),
      fiberBlend: String(r['custitem_fiber_blend'] ?? ''),
      carbonKg: Number(r['custitem_carbon_kg'] ?? 0),
      waterLiters: Number(r['custitem_water_liters'] ?? 0),
      energyKwh: Number(r['custitem_energy_kwh'] ?? 0),
    };
  },
};

// ============================================================================
// 4. Microsoft Dynamics 365
// ============================================================================

const dynamicsAdapter: ERPSustainabilityAdapter = {
  erpId: 'microsoft-dynamics',
  displayName: 'Microsoft Dynamics 365',
  mapMaterial(r) {
    return {
      materialNumber: String(r['ProductNumber'] ?? r['msdyn_productid'] ?? ''),
      recycledPercent: Number(r['cust_RecycledPercent'] ?? 0),
      organicCertified: r['cust_OrganicCertified'] === true,
      sustainabilityCertification: (r['cust_SustainabilityCert'] as string) || null,
    };
  },
  mapVendor(r) {
    return {
      vendorId: String(r['VendorAccountNumber'] ?? ''),
      sustainabilityTier: normalizeTier(r['cust_SustainabilityTier']),
      lastAuditDate: normalizeDate(r['cust_LastAuditDate']),
      complianceStatus: normalizeStatus(r['cust_ComplianceStatus']),
    };
  },
  mapQuality(r) {
    const lines = (r['QualityOrderLines'] ?? []) as ERPWireRecord[];
    return {
      notificationId: String(r['QualityOrderId'] ?? ''),
      dyeCompliance: r['cust_DyeCompliance'] === true,
      reachStatus: normalizeReach(r['cust_REACHStatus']),
      oekoTexClass: (r['cust_OEKOTEXClass'] as string) || null,
      testResults: lines.map((l) => ({
        chemicalId: String(l['cust_ChemicalId'] ?? ''),
        result: Number(l['cust_TestResult'] ?? 0),
        thresholdPassed: l['cust_ThresholdPassed'] === true,
      })),
    };
  },
  mapBatch(r) {
    return {
      batchId: String(r['InventBatchId'] ?? ''),
      materialNumber: String(r['ProductNumber'] ?? ''),
      dyeLot: String(r['cust_DyeLot'] ?? ''),
      originCountry: String(r['cust_OriginCountry'] ?? ''),
      fiberBlend: String(r['cust_FiberBlend'] ?? ''),
      carbonKg: Number(r['cust_CarbonKg'] ?? 0),
      waterLiters: Number(r['cust_WaterLiters'] ?? 0),
      energyKwh: Number(r['cust_EnergyKwh'] ?? 0),
    };
  },
};

// ============================================================================
// 5. Infor CloudSuite
// ============================================================================

const inforAdapter: ERPSustainabilityAdapter = {
  erpId: 'infor',
  displayName: 'Infor CloudSuite',
  mapMaterial(r) {
    return {
      materialNumber: String(r['ItemNumber'] ?? r['ITNO'] ?? ''),
      recycledPercent: Number(r['RecycledContentPercentage'] ?? 0),
      organicCertified: r['OrganicFlag'] === '1' || r['OrganicFlag'] === true,
      sustainabilityCertification: (r['SustainabilityCertType'] as string) || null,
    };
  },
  mapVendor(r) {
    return {
      vendorId: String(r['SupplierNumber'] ?? r['SUNO'] ?? ''),
      sustainabilityTier: normalizeTier(r['SustainTier']),
      lastAuditDate: normalizeDate(r['AuditDate']),
      complianceStatus: normalizeStatus(r['ComplianceCode']),
    };
  },
  mapQuality(r) {
    const results = (r['TestResults'] ?? []) as ERPWireRecord[];
    return {
      notificationId: String(r['QualityNotifId'] ?? ''),
      dyeCompliance: r['DyeTestPassed'] === '1' || r['DyeTestPassed'] === true,
      reachStatus: normalizeReach(r['REACHResult']),
      oekoTexClass: (r['OEKOTEXClassification'] as string) || null,
      testResults: results.map((t) => ({
        chemicalId: String(t['ChemId'] ?? ''),
        result: Number(t['Value'] ?? 0),
        thresholdPassed: t['Pass'] === '1' || t['Pass'] === true,
      })),
    };
  },
  mapBatch(r) {
    return {
      batchId: String(r['LotBatchNo'] ?? r['BANO'] ?? ''),
      materialNumber: String(r['ItemNumber'] ?? ''),
      dyeLot: String(r['DyeLotRef'] ?? ''),
      originCountry: String(r['OriginCountry'] ?? ''),
      fiberBlend: String(r['FiberComposition'] ?? ''),
      carbonKg: Number(r['CO2Kg'] ?? 0),
      waterLiters: Number(r['WaterUseLiters'] ?? 0),
      energyKwh: Number(r['EnergyKwh'] ?? 0),
    };
  },
};

// ============================================================================
// 6. Epicor Kinetic
// ============================================================================

const epicorAdapter: ERPSustainabilityAdapter = {
  erpId: 'epicor',
  displayName: 'Epicor Kinetic',
  mapMaterial(r) {
    return {
      materialNumber: String(r['PartNum'] ?? ''),
      recycledPercent: Number(r['RecycledContent_c'] ?? 0),
      organicCertified: r['OrganicCert_c'] === true,
      sustainabilityCertification: (r['SustainCert_c'] as string) || null,
    };
  },
  mapVendor(r) {
    return {
      vendorId: String(r['VendorID'] ?? ''),
      sustainabilityTier: normalizeTier(r['SustainTier_c']),
      lastAuditDate: normalizeDate(r['AuditDate_c']),
      complianceStatus: normalizeStatus(r['CompStatus_c']),
    };
  },
  mapQuality(r) {
    const lines = (r['InspResults'] ?? []) as ERPWireRecord[];
    return {
      notificationId: String(r['InspPlanNum'] ?? ''),
      dyeCompliance: r['DyeCompliant_c'] === true,
      reachStatus: normalizeReach(r['REACHStatus_c']),
      oekoTexClass: (r['OEKOTEXClass_c'] as string) || null,
      testResults: lines.map((l) => ({
        chemicalId: String(l['ChemicalID_c'] ?? ''),
        result: Number(l['TestValue_c'] ?? 0),
        thresholdPassed: l['Passed_c'] === true,
      })),
    };
  },
  mapBatch(r) {
    return {
      batchId: String(r['LotNum'] ?? ''),
      materialNumber: String(r['PartNum'] ?? ''),
      dyeLot: String(r['DyeLot_c'] ?? ''),
      originCountry: String(r['CountryOfOrigin'] ?? ''),
      fiberBlend: String(r['FiberBlend_c'] ?? ''),
      carbonKg: Number(r['CarbonKg_c'] ?? 0),
      waterLiters: Number(r['WaterLiters_c'] ?? 0),
      energyKwh: Number(r['EnergyKwh_c'] ?? 0),
    };
  },
};

// ============================================================================
// 7. Sage X3
// ============================================================================

const sageX3Adapter: ERPSustainabilityAdapter = {
  erpId: 'sage-x3',
  displayName: 'Sage X3',
  mapMaterial(r) {
    return {
      materialNumber: String(r['ITMREF'] ?? ''),
      recycledPercent: Number(r['YRECYCLEDPCT'] ?? 0),
      organicCertified: r['YORGANIC'] === 1 || r['YORGANIC'] === '1',
      sustainabilityCertification: (r['YSUSTAINCERT'] as string) || null,
    };
  },
  mapVendor(r) {
    return {
      vendorId: String(r['BPSNUM'] ?? ''),
      sustainabilityTier: normalizeTier(r['YSUSTAINTIER']),
      lastAuditDate: normalizeDate(r['YAUDITDAT']),
      complianceStatus: normalizeStatus(r['YCOMPLIANCE']),
    };
  },
  mapQuality(r) {
    const lines = (r['YQALINES'] ?? []) as ERPWireRecord[];
    return {
      notificationId: String(r['YQANUM'] ?? ''),
      dyeCompliance: r['YDYEPASS'] === 1 || r['YDYEPASS'] === '1',
      reachStatus: normalizeReach(r['YREACH']),
      oekoTexClass: (r['YOEKOTEX'] as string) || null,
      testResults: lines.map((l) => ({
        chemicalId: String(l['YCHEMID'] ?? ''),
        result: Number(l['YTESTVAL'] ?? 0),
        thresholdPassed: l['YPASS'] === 1 || l['YPASS'] === '1',
      })),
    };
  },
  mapBatch(r) {
    return {
      batchId: String(r['LOT'] ?? ''),
      materialNumber: String(r['ITMREF'] ?? ''),
      dyeLot: String(r['YDYELOT'] ?? ''),
      originCountry: String(r['YCOUNTRYOR'] ?? ''),
      fiberBlend: String(r['YFIBERBLEND'] ?? ''),
      carbonKg: Number(r['YCARBONKG'] ?? 0),
      waterLiters: Number(r['YWATERL'] ?? 0),
      energyKwh: Number(r['YENERGYKWH'] ?? 0),
    };
  },
};

// ============================================================================
// 8. IFS Cloud
// ============================================================================

const ifsAdapter: ERPSustainabilityAdapter = {
  erpId: 'ifs',
  displayName: 'IFS Cloud',
  mapMaterial(r) {
    return {
      materialNumber: String(r['PartNo'] ?? ''),
      recycledPercent: Number(r['CfRecycledPct'] ?? 0),
      organicCertified: r['CfOrganicCertified'] === 'TRUE' || r['CfOrganicCertified'] === true,
      sustainabilityCertification: (r['CfSustainabilityCert'] as string) || null,
    };
  },
  mapVendor(r) {
    return {
      vendorId: String(r['SupplierId'] ?? ''),
      sustainabilityTier: normalizeTier(r['CfSustainTier']),
      lastAuditDate: normalizeDate(r['CfAuditDate']),
      complianceStatus: normalizeStatus(r['CfComplianceStatus']),
    };
  },
  mapQuality(r) {
    const lines = (r['QualityResults'] ?? []) as ERPWireRecord[];
    return {
      notificationId: String(r['QualityPlanNo'] ?? ''),
      dyeCompliance: r['CfDyeCompliance'] === 'TRUE' || r['CfDyeCompliance'] === true,
      reachStatus: normalizeReach(r['CfREACHStatus']),
      oekoTexClass: (r['CfOEKOTEXClass'] as string) || null,
      testResults: lines.map((l) => ({
        chemicalId: String(l['CfChemicalId'] ?? ''),
        result: Number(l['CfTestResult'] ?? 0),
        thresholdPassed: l['CfPassed'] === 'TRUE' || l['CfPassed'] === true,
      })),
    };
  },
  mapBatch(r) {
    return {
      batchId: String(r['LotBatchNo'] ?? ''),
      materialNumber: String(r['PartNo'] ?? ''),
      dyeLot: String(r['CfDyeLot'] ?? ''),
      originCountry: String(r['CfOriginCountry'] ?? ''),
      fiberBlend: String(r['CfFiberBlend'] ?? ''),
      carbonKg: Number(r['CfCarbonKg'] ?? 0),
      waterLiters: Number(r['CfWaterLiters'] ?? 0),
      energyKwh: Number(r['CfEnergyKwh'] ?? 0),
    };
  },
};

// ============================================================================
// 9. Workday
// ============================================================================

const workdayAdapter: ERPSustainabilityAdapter = {
  erpId: 'workday',
  displayName: 'Workday',
  mapMaterial(r) {
    return {
      materialNumber: String(r['Spend_Item_ID'] ?? r['Item_ID'] ?? ''),
      recycledPercent: Number(r['Custom_Recycled_Percent'] ?? 0),
      organicCertified: r['Custom_Organic_Certified'] === true || r['Custom_Organic_Certified'] === '1',
      sustainabilityCertification: (r['Custom_Sustainability_Cert'] as string) || null,
    };
  },
  mapVendor(r) {
    return {
      vendorId: String(r['Supplier_ID'] ?? ''),
      sustainabilityTier: normalizeTier(r['Custom_Sustainability_Tier']),
      lastAuditDate: normalizeDate(r['Custom_Last_Audit_Date']),
      complianceStatus: normalizeStatus(r['Custom_Compliance_Status']),
    };
  },
  mapQuality(r) {
    const checks = (r['Custom_Quality_Checks'] ?? []) as ERPWireRecord[];
    return {
      notificationId: String(r['Custom_QA_Report_ID'] ?? ''),
      dyeCompliance: r['Custom_Dye_Compliance'] === true || r['Custom_Dye_Compliance'] === '1',
      reachStatus: normalizeReach(r['Custom_REACH_Status']),
      oekoTexClass: (r['Custom_OEKOTEX_Class'] as string) || null,
      testResults: checks.map((c) => ({
        chemicalId: String(c['Custom_Chemical_ID'] ?? ''),
        result: Number(c['Custom_Test_Result'] ?? 0),
        thresholdPassed: c['Custom_Passed'] === true || c['Custom_Passed'] === '1',
      })),
    };
  },
  mapBatch(r) {
    return {
      batchId: String(r['Custom_Batch_ID'] ?? ''),
      materialNumber: String(r['Spend_Item_ID'] ?? ''),
      dyeLot: String(r['Custom_Dye_Lot'] ?? ''),
      originCountry: String(r['Custom_Origin_Country'] ?? ''),
      fiberBlend: String(r['Custom_Fiber_Blend'] ?? ''),
      carbonKg: Number(r['Custom_Carbon_Kg'] ?? 0),
      waterLiters: Number(r['Custom_Water_Liters'] ?? 0),
      energyKwh: Number(r['Custom_Energy_Kwh'] ?? 0),
    };
  },
};

// ============================================================================
// 10. Oracle PeopleSoft
// ============================================================================

const peopleSoftAdapter: ERPSustainabilityAdapter = {
  erpId: 'oracle-peoplesoft',
  displayName: 'PeopleSoft',
  mapMaterial(r) {
    return {
      materialNumber: String(r['INV_ITEM_ID'] ?? ''),
      recycledPercent: Number(r['CUST_RECYCLED_PCT'] ?? 0),
      organicCertified: r['CUST_ORGANIC_FLG'] === 'Y',
      sustainabilityCertification: (r['CUST_SUSTAIN_CERT'] as string) || null,
    };
  },
  mapVendor(r) {
    return {
      vendorId: String(r['VENDOR_ID'] ?? ''),
      sustainabilityTier: normalizeTier(r['CUST_SUSTAIN_TIER']),
      lastAuditDate: normalizeDate(r['CUST_AUDIT_DT']),
      complianceStatus: normalizeStatus(r['CUST_COMPLIANCE']),
    };
  },
  mapQuality(r) {
    const lines = (r['CUST_QA_LINES'] ?? []) as ERPWireRecord[];
    return {
      notificationId: String(r['QA_PLAN_ID'] ?? ''),
      dyeCompliance: r['CUST_DYE_COMPLY'] === 'Y',
      reachStatus: normalizeReach(r['CUST_REACH_STATUS']),
      oekoTexClass: (r['CUST_OEKOTEX_CLS'] as string) || null,
      testResults: lines.map((l) => ({
        chemicalId: String(l['CUST_CHEM_ID'] ?? ''),
        result: Number(l['CUST_TEST_VAL'] ?? 0),
        thresholdPassed: l['CUST_PASS_FLG'] === 'Y',
      })),
    };
  },
  mapBatch(r) {
    return {
      batchId: String(r['LOT_ID'] ?? ''),
      materialNumber: String(r['INV_ITEM_ID'] ?? ''),
      dyeLot: String(r['CUST_DYE_LOT'] ?? ''),
      originCountry: String(r['CUST_ORIGIN_CNTRY'] ?? ''),
      fiberBlend: String(r['CUST_FIBER_BLEND'] ?? ''),
      carbonKg: Number(r['CUST_CARBON_KG'] ?? 0),
      waterLiters: Number(r['CUST_WATER_L'] ?? 0),
      energyKwh: Number(r['CUST_ENERGY_KWH'] ?? 0),
    };
  },
};

// ============================================================================
// Adapter Registry
// ============================================================================

const ADAPTER_REGISTRY: ReadonlyMap<string, ERPSustainabilityAdapter> = new Map([
  ['sap-s4hana', sapAdapter],
  ['sap-ecc', sapAdapter],            // ECC uses same wire format
  ['sap-business-one', sapAdapter],   // SAP B1 uses same field conventions
  ['oracle-erp', oracleErpAdapter],
  ['oracle-netsuite', netsuiteAdapter],
  ['microsoft-dynamics', dynamicsAdapter],
  ['infor', inforAdapter],
  ['epicor', epicorAdapter],
  ['sage-x3', sageX3Adapter],
  ['ifs', ifsAdapter],
  ['workday', workdayAdapter],
  ['oracle-peoplesoft', peopleSoftAdapter],
]);

/**
 * Get the sustainability adapter for a given ERP system.
 * Returns undefined if the ERP is not in the registry.
 */
export function getERPAdapter(erpId: string): ERPSustainabilityAdapter | undefined {
  return ADAPTER_REGISTRY.get(erpId);
}

/**
 * List all registered ERP adapters.
 */
export function listERPAdapters(): readonly ERPSustainabilityAdapter[] {
  // Deduplicate (SAP family shares one adapter)
  const seen = new Set<string>();
  const result: ERPSustainabilityAdapter[] = [];
  for (const adapter of ADAPTER_REGISTRY.values()) {
    if (!seen.has(adapter.erpId)) {
      seen.add(adapter.erpId);
      result.push(adapter);
    }
  }
  return result;
}

/**
 * Get all registered ERP IDs.
 */
export function listERPAdapterIds(): readonly string[] {
  return [...ADAPTER_REGISTRY.keys()];
}

// ============================================================================
// Convenience wrappers (preserve backward-compat with SAP-only callers)
// ============================================================================

export function mapSAPMaterialToDomain(record: ERPWireRecord): MaterialSustainability {
  return sapAdapter.mapMaterial(record);
}

export function mapDomainMaterialToSAP(domain: MaterialSustainability): ERPWireRecord {
  return {
    MATNR: domain.materialNumber,
    ZZRECYCLED_PCT: domain.recycledPercent,
    ZZORGANIC_FLAG: domain.organicCertified ? 'X' : '',
    ZZSUSTAIN_CERT: domain.sustainabilityCertification ?? '',
  };
}

export function mapSAPVendorToDomain(record: ERPWireRecord): SupplierCompliance {
  return sapAdapter.mapVendor(record);
}

export function mapSAPQualityToDomain(record: ERPWireRecord): DyeComplianceResult {
  return sapAdapter.mapQuality(record);
}

export function mapSAPBatchToDomain(record: ERPWireRecord): BatchTraceability {
  return sapAdapter.mapBatch(record);
}

// ============================================================================
// Domain Thresholds (from SPARC spec — ERP-agnostic)
// ============================================================================

/** Minimum recycled content percentage to qualify as "recycled material" */
export const THRESHOLD_RECYCLED_PCT = 5;

/** Minimum organic content percentage to qualify as "organic material" */
export const THRESHOLD_ORGANIC_PCT = 2;

/** Maximum restricted dye substance percentage (REACH compliance) */
export const THRESHOLD_DYE_PCT = 10;

export function meetsRecycledThreshold(pct: number): boolean {
  return pct >= THRESHOLD_RECYCLED_PCT;
}

export function meetsOrganicThreshold(pct: number): boolean {
  return pct >= THRESHOLD_ORGANIC_PCT;
}

export function meetsDyeThreshold(pct: number): boolean {
  return pct <= THRESHOLD_DYE_PCT;
}

// ============================================================================
// Shared Normalization Helpers
// ============================================================================

function normalizeTier(val: unknown): SupplierCompliance['sustainabilityTier'] {
  const s = String(val ?? '').toUpperCase();
  if (s.includes('GOLD') || s === 'A' || s === '1') return 'gold';
  if (s.includes('SILVER') || s === 'B' || s === '2') return 'silver';
  if (s.includes('BRONZE') || s === 'C' || s === '3') return 'bronze';
  return 'uncertified';
}

function normalizeStatus(val: unknown): SupplierCompliance['complianceStatus'] {
  const s = String(val ?? '').toUpperCase();
  if (s.includes('COMPLIANT') && !s.includes('NON')) return 'compliant';
  if (s.includes('CONDITIONAL') || s.includes('PARTIAL')) return 'conditional';
  return 'non-compliant';
}

function normalizeReach(val: unknown): DyeComplianceResult['reachStatus'] {
  const s = String(val ?? '').toUpperCase();
  if (s.includes('PASS') || s === 'Y' || s === 'TRUE') return 'passed';
  if (s.includes('FAIL') || s === 'N' || s === 'FALSE') return 'failed';
  return 'pending';
}

function normalizeDate(val: unknown): string {
  if (val == null) return '';
  const s = String(val);
  // SAP-style YYYYMMDD
  if (/^\d{8}$/.test(s)) return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  // ISO or other date string — pass through
  return s;
}
