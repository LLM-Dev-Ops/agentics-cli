/**
 * ERP Surface Route Handler
 *
 * POST /v1/erpsurface
 *
 * Handles ERP Surface integration requests for 10 enterprise ERP systems.
 * Provides sustainability module endpoint definitions, entity/table mappings,
 * API paths, and custom field conventions for each platform.
 */

import { Hono } from 'hono';
import { ids } from '../utils/id-generator.js';
import { buildErpSurfaceReference } from '../utils/response-builder.js';

const erpsurface = new Hono();

// ---------------------------------------------------------------------------
// Multi-ERP Sustainability Module Registry
// ---------------------------------------------------------------------------

interface EntityMapping {
  readonly entity: string;
  readonly description: string;
  readonly keyFields: readonly string[];
  readonly sustainabilityFields: readonly string[];
}

interface ModuleEndpoint {
  readonly module: string;
  readonly description: string;
  readonly apiNames: readonly string[];
  readonly entities: readonly EntityMapping[];
  readonly servicePath: string;
}

interface ERPSustainabilityConfig {
  readonly erpId: string;
  readonly displayName: string;
  readonly apiType: string;
  readonly customFieldConvention: string;
  readonly modules: readonly ModuleEndpoint[];
  readonly supportedCertifications: readonly string[];
}

/**
 * Sustainability endpoint definitions for 10 ERP platforms.
 * Each entry documents the ERP's modules, entities, API paths,
 * and custom field naming conventions for apparel/textile sustainability.
 */
const ERP_SUSTAINABILITY_REGISTRY: readonly ERPSustainabilityConfig[] = [
  // ========================================================================
  // 1. SAP S/4HANA
  // ========================================================================
  {
    erpId: 'sap-s4hana',
    displayName: 'SAP S/4HANA',
    apiType: 'OData + BAPI',
    customFieldConvention: 'ZZ* namespace (e.g., ZZRECYCLED_PCT, ZZDYE_COMPLIANCE)',
    modules: [
      {
        module: 'MM-PUR',
        description: 'Materials Management - Purchasing: supplier sustainability certificates, eco-labeled materials',
        apiNames: ['BAPI_PO_CREATE1', 'BAPI_VENDOR_GETDETAIL', 'BAPI_MATERIAL_GET_DETAIL'],
        entities: [
          { entity: 'MARA', description: 'General Material Data', keyFields: ['MATNR'], sustainabilityFields: ['ZZRECYCLED_PCT', 'ZZORGANIC_FLAG', 'ZZSUSTAIN_CERT'] },
          { entity: 'EKPO', description: 'Purchasing Document Item', keyFields: ['EBELN', 'EBELP'], sustainabilityFields: ['ZZECO_LABEL', 'ZZSUPPLIER_SCORE', 'ZZCERT_EXPIRY'] },
          { entity: 'LFA1', description: 'Vendor Master (General)', keyFields: ['LIFNR'], sustainabilityFields: ['ZZSUSTAIN_TIER', 'ZZAUDIT_DATE', 'ZZCOMPLIANCE_STATUS'] },
        ],
        servicePath: '/sap/opu/odata/sap/API_PURCHASEORDER_PROCESS_SRV',
      },
      {
        module: 'QM-QN',
        description: 'Quality Management - Quality Notifications: textile lab test results, dye compliance, REACH/OEKO-TEX',
        apiNames: ['BAPI_QUALNOT_CREATE', 'BAPI_QUALNOT_GETDETAIL'],
        entities: [
          { entity: 'QMEL', description: 'Quality Notification', keyFields: ['QMNUM'], sustainabilityFields: ['ZZDYE_COMPLIANCE', 'ZZREACH_STATUS', 'ZZOEKOTEX_CLASS'] },
          { entity: 'QMFE', description: 'Quality Notification Items', keyFields: ['QMNUM', 'FEESSION'], sustainabilityFields: ['ZZTEST_RESULT', 'ZZCHEMICAL_ID', 'ZZTHRESHOLD_PASS'] },
        ],
        servicePath: '/sap/opu/odata/sap/API_QUALITYNOTIFICATION_SRV',
      },
      {
        module: 'PP-PI',
        description: 'Production Planning - Process Industries: batch traceability, dye lot tracking, water/energy usage',
        apiNames: ['BAPI_PROCORD_CREATE', 'BAPI_PROCORD_GETDETAIL'],
        entities: [
          { entity: 'LIPS', description: 'Delivery Document Item', keyFields: ['VBELN', 'POSNR'], sustainabilityFields: ['ZZCARBON_KG', 'ZZWATER_LITERS', 'ZZBATCH_TRACE_ID'] },
          { entity: 'CHVW', description: 'Batch Where-Used List', keyFields: ['CHARG', 'MATNR'], sustainabilityFields: ['ZZDYE_LOT', 'ZZORIGIN_COUNTRY', 'ZZFIBER_BLEND'] },
          { entity: 'AFKO', description: 'Process Order Header', keyFields: ['AUFNR'], sustainabilityFields: ['ZZENERGY_KWH', 'ZZWASTE_KG', 'ZZRECYCLED_INPUT_PCT'] },
        ],
        servicePath: '/sap/opu/odata/sap/API_PROCESS_ORDER_SRV',
      },
    ],
    supportedCertifications: ['OEKO-TEX Standard 100', 'GOTS', 'GRS', 'REACH', 'bluesign'],
  },

  // ========================================================================
  // 2. Oracle ERP Cloud (Fusion)
  // ========================================================================
  {
    erpId: 'oracle-erp',
    displayName: 'Oracle ERP Cloud',
    apiType: 'REST (Fusion)',
    customFieldConvention: 'Descriptive Flexfields (DFF) and Extensible Flexfields (EFF)',
    modules: [
      {
        module: 'Procurement',
        description: 'Fusion Procurement: supplier qualification, sustainable sourcing',
        apiNames: ['purchaseOrders', 'suppliers', 'items'],
        entities: [
          { entity: 'InventoryItems', description: 'Item Master', keyFields: ['ItemNumber'], sustainabilityFields: ['RecycledContentPct', 'OrganicCertified', 'SustainabilityCertCode'] },
          { entity: 'Suppliers', description: 'Supplier Master', keyFields: ['SupplierId'], sustainabilityFields: ['SustainabilityRating', 'LastAuditDate', 'ComplianceStatus'] },
        ],
        servicePath: '/fscmRestApi/resources/latest/purchaseOrders',
      },
      {
        module: 'Quality',
        description: 'Quality Management: inspection results, chemical compliance',
        apiNames: ['qualityIssues', 'inspectionResults'],
        entities: [
          { entity: 'QualityIssues', description: 'Quality Issue', keyFields: ['QualityIssueId'], sustainabilityFields: ['DyeComplianceFlag', 'REACHStatus', 'OEKOTEXClassification'] },
          { entity: 'InspectionResults', description: 'Inspection Line Results', keyFields: ['InspectionId'], sustainabilityFields: ['ChemicalSubstanceId', 'TestResult', 'WithinThreshold'] },
        ],
        servicePath: '/fscmRestApi/resources/latest/qualityIssues',
      },
      {
        module: 'Inventory',
        description: 'Inventory Management: lot/batch traceability, origin tracking',
        apiNames: ['inventoryLots', 'inventoryTransactions'],
        entities: [
          { entity: 'InventoryLots', description: 'Lot/Batch Records', keyFields: ['LotNumber', 'ItemNumber'], sustainabilityFields: ['DyeLotReference', 'CountryOfOrigin', 'FiberComposition', 'CarbonFootprintKg', 'WaterUsageLiters'] },
        ],
        servicePath: '/fscmRestApi/resources/latest/inventoryLots',
      },
    ],
    supportedCertifications: ['OEKO-TEX Standard 100', 'GOTS', 'GRS', 'REACH', 'bluesign'],
  },

  // ========================================================================
  // 3. Oracle NetSuite
  // ========================================================================
  {
    erpId: 'oracle-netsuite',
    displayName: 'Oracle NetSuite',
    apiType: 'SuiteQL + SuiteTalk REST',
    customFieldConvention: 'custitem_*, custentity_*, custrecord_* prefixes',
    modules: [
      {
        module: 'Items',
        description: 'Item records with sustainability custom fields',
        apiNames: ['GET /record/v1/inventoryItem', 'SuiteQL'],
        entities: [
          { entity: 'InventoryItem', description: 'Inventory Item', keyFields: ['itemId'], sustainabilityFields: ['custitem_recycled_pct', 'custitem_organic', 'custitem_sustain_cert'] },
          { entity: 'Vendor', description: 'Vendor Record', keyFields: ['entityId'], sustainabilityFields: ['custentity_sustain_tier', 'custentity_audit_date', 'custentity_compliance'] },
        ],
        servicePath: '/services/rest/record/v1/inventoryItem',
      },
      {
        module: 'Quality',
        description: 'Custom QA records for textile compliance',
        apiNames: ['GET /record/v1/customrecord_qa'],
        entities: [
          { entity: 'CustomRecord_QA', description: 'Quality Assessment', keyFields: ['custrecord_qa_id'], sustainabilityFields: ['custrecord_dye_pass', 'custrecord_reach', 'custrecord_oekotex'] },
        ],
        servicePath: '/services/rest/record/v1/customrecord_qa',
      },
      {
        module: 'Inventory',
        description: 'Lot/serial tracking for batch traceability',
        apiNames: ['GET /record/v1/inventoryNumber'],
        entities: [
          { entity: 'InventoryNumber', description: 'Lot/Serial Number', keyFields: ['inventoryNumber'], sustainabilityFields: ['custitem_dye_lot', 'custitem_origin_country', 'custitem_fiber_blend', 'custitem_carbon_kg'] },
        ],
        servicePath: '/services/rest/record/v1/inventoryNumber',
      },
    ],
    supportedCertifications: ['OEKO-TEX Standard 100', 'GOTS', 'GRS', 'REACH', 'bluesign'],
  },

  // ========================================================================
  // 4. Microsoft Dynamics 365
  // ========================================================================
  {
    erpId: 'microsoft-dynamics',
    displayName: 'Microsoft Dynamics 365 F&O',
    apiType: 'Dataverse OData v4',
    customFieldConvention: 'cust_* prefix on custom entities/fields',
    modules: [
      {
        module: 'ProductInformation',
        description: 'Product master with sustainability attributes',
        apiNames: ['ReleasedProducts', 'InventTable'],
        entities: [
          { entity: 'ReleasedProducts', description: 'Product Master', keyFields: ['ProductNumber'], sustainabilityFields: ['cust_RecycledPercent', 'cust_OrganicCertified', 'cust_SustainabilityCert'] },
          { entity: 'VendorV2', description: 'Vendor Master', keyFields: ['VendorAccountNumber'], sustainabilityFields: ['cust_SustainabilityTier', 'cust_LastAuditDate', 'cust_ComplianceStatus'] },
        ],
        servicePath: '/data/ReleasedProducts',
      },
      {
        module: 'QualityManagement',
        description: 'Quality orders and test results',
        apiNames: ['QualityOrders', 'QualityTestResults'],
        entities: [
          { entity: 'QualityOrders', description: 'Quality Order', keyFields: ['QualityOrderId'], sustainabilityFields: ['cust_DyeCompliance', 'cust_REACHStatus', 'cust_OEKOTEXClass'] },
        ],
        servicePath: '/data/QualityOrders',
      },
      {
        module: 'InventoryManagement',
        description: 'Batch/lot tracking with traceability',
        apiNames: ['InventBatch', 'InventTrans'],
        entities: [
          { entity: 'InventBatch', description: 'Inventory Batch', keyFields: ['InventBatchId', 'ProductNumber'], sustainabilityFields: ['cust_DyeLot', 'cust_OriginCountry', 'cust_FiberBlend', 'cust_CarbonKg'] },
        ],
        servicePath: '/data/InventBatch',
      },
    ],
    supportedCertifications: ['OEKO-TEX Standard 100', 'GOTS', 'GRS', 'REACH', 'bluesign', 'EU Ecolabel'],
  },

  // ========================================================================
  // 5. Infor CloudSuite
  // ========================================================================
  {
    erpId: 'infor',
    displayName: 'Infor CloudSuite',
    apiType: 'ION API + Infor Data Lake',
    customFieldConvention: 'User-defined fields via ION scripting',
    modules: [
      {
        module: 'M3-Items',
        description: 'Item master (M3 ITNO) with sustainability extensions',
        apiNames: ['MMS001MI', 'MMS200MI'],
        entities: [
          { entity: 'MITMAS', description: 'Item Master', keyFields: ['ITNO'], sustainabilityFields: ['RecycledContentPercentage', 'OrganicFlag', 'SustainabilityCertType'] },
          { entity: 'CIDMAS', description: 'Supplier Master', keyFields: ['SUNO'], sustainabilityFields: ['SustainTier', 'AuditDate', 'ComplianceCode'] },
        ],
        servicePath: '/M3/m3api-rest/v2/execute/MMS001MI',
      },
      {
        module: 'QMS',
        description: 'Quality Management System: test specs and results',
        apiNames: ['QMS300MI', 'QMS100MI'],
        entities: [
          { entity: 'QMSRES', description: 'Quality Test Result', keyFields: ['QualityNotifId'], sustainabilityFields: ['DyeTestPassed', 'REACHResult', 'OEKOTEXClassification'] },
        ],
        servicePath: '/M3/m3api-rest/v2/execute/QMS300MI',
      },
      {
        module: 'M3-Lots',
        description: 'Lot/batch tracking for process manufacturing',
        apiNames: ['MMS235MI'],
        entities: [
          { entity: 'MILOMA', description: 'Lot Master', keyFields: ['BANO', 'ITNO'], sustainabilityFields: ['DyeLotRef', 'OriginCountry', 'FiberComposition', 'CO2Kg', 'WaterUseLiters'] },
        ],
        servicePath: '/M3/m3api-rest/v2/execute/MMS235MI',
      },
    ],
    supportedCertifications: ['OEKO-TEX Standard 100', 'GOTS', 'GRS', 'REACH', 'bluesign'],
  },

  // ========================================================================
  // 6. Epicor Kinetic
  // ========================================================================
  {
    erpId: 'epicor',
    displayName: 'Epicor Kinetic',
    apiType: 'REST v2 (OData-like)',
    customFieldConvention: '_c suffix on User Defined fields (UD columns)',
    modules: [
      {
        module: 'Parts',
        description: 'Part master with sustainability UD fields',
        apiNames: ['Erp.BO.PartSvc', 'Erp.BO.VendorSvc'],
        entities: [
          { entity: 'Part', description: 'Part Master', keyFields: ['PartNum'], sustainabilityFields: ['RecycledContent_c', 'OrganicCert_c', 'SustainCert_c'] },
          { entity: 'Vendor', description: 'Vendor Master', keyFields: ['VendorID'], sustainabilityFields: ['SustainTier_c', 'AuditDate_c', 'CompStatus_c'] },
        ],
        servicePath: '/api/v2/odata/Erp.BO.PartSvc/Parts',
      },
      {
        module: 'Inspection',
        description: 'Inspection plans and results',
        apiNames: ['Erp.BO.InspResultsSvc'],
        entities: [
          { entity: 'InspResults', description: 'Inspection Results', keyFields: ['InspPlanNum'], sustainabilityFields: ['DyeCompliant_c', 'REACHStatus_c', 'OEKOTEXClass_c'] },
        ],
        servicePath: '/api/v2/odata/Erp.BO.InspResultsSvc/InspResults',
      },
      {
        module: 'LotTracking',
        description: 'Lot/batch tracking for traceability',
        apiNames: ['Erp.BO.LotSelectUpdateSvc'],
        entities: [
          { entity: 'PartLot', description: 'Part Lot', keyFields: ['LotNum', 'PartNum'], sustainabilityFields: ['DyeLot_c', 'CountryOfOrigin', 'FiberBlend_c', 'CarbonKg_c'] },
        ],
        servicePath: '/api/v2/odata/Erp.BO.LotSelectUpdateSvc/PartLots',
      },
    ],
    supportedCertifications: ['OEKO-TEX Standard 100', 'GOTS', 'GRS', 'REACH'],
  },

  // ========================================================================
  // 7. Sage X3
  // ========================================================================
  {
    erpId: 'sage-x3',
    displayName: 'Sage X3',
    apiType: 'REST (SOAP legacy)',
    customFieldConvention: 'Y* prefix on specific fields (e.g., YRECYCLEDPCT)',
    modules: [
      {
        module: 'Products',
        description: 'Product master (ITMREF) with sustainability Y-fields',
        apiNames: ['XITMMASTER', 'XBPS'],
        entities: [
          { entity: 'ITMMASTER', description: 'Item Master', keyFields: ['ITMREF'], sustainabilityFields: ['YRECYCLEDPCT', 'YORGANIC', 'YSUSTAINCERT'] },
          { entity: 'BPSUPPLIER', description: 'Business Partner (Supplier)', keyFields: ['BPSNUM'], sustainabilityFields: ['YSUSTAINTIER', 'YAUDITDAT', 'YCOMPLIANCE'] },
        ],
        servicePath: '/api/1/XITMMASTER',
      },
      {
        module: 'Quality',
        description: 'Quality control records',
        apiNames: ['XQUALCTRL'],
        entities: [
          { entity: 'QUALCTRL', description: 'Quality Control Record', keyFields: ['YQANUM'], sustainabilityFields: ['YDYEPASS', 'YREACH', 'YOEKOTEX'] },
        ],
        servicePath: '/api/1/XQUALCTRL',
      },
      {
        module: 'StockLots',
        description: 'Lot/batch tracking',
        apiNames: ['XSTOJOU'],
        entities: [
          { entity: 'STOJOU', description: 'Stock Journal (Lot)', keyFields: ['LOT', 'ITMREF'], sustainabilityFields: ['YDYELOT', 'YCOUNTRYOR', 'YFIBERBLEND', 'YCARBONKG'] },
        ],
        servicePath: '/api/1/XSTOJOU',
      },
    ],
    supportedCertifications: ['OEKO-TEX Standard 100', 'GOTS', 'GRS', 'REACH'],
  },

  // ========================================================================
  // 8. IFS Cloud
  // ========================================================================
  {
    erpId: 'ifs',
    displayName: 'IFS Cloud',
    apiType: 'OData (IFS REST)',
    customFieldConvention: 'Cf* prefix on custom fields (e.g., CfRecycledPct)',
    modules: [
      {
        module: 'PartCatalog',
        description: 'Part catalog with sustainability custom fields',
        apiNames: ['InventoryPartService', 'SupplierService'],
        entities: [
          { entity: 'InventoryPart', description: 'Inventory Part', keyFields: ['PartNo'], sustainabilityFields: ['CfRecycledPct', 'CfOrganicCertified', 'CfSustainabilityCert'] },
          { entity: 'Supplier', description: 'Supplier Master', keyFields: ['SupplierId'], sustainabilityFields: ['CfSustainTier', 'CfAuditDate', 'CfComplianceStatus'] },
        ],
        servicePath: '/api/data/InventoryParts',
      },
      {
        module: 'QualityAssurance',
        description: 'Quality plans and inspection results',
        apiNames: ['QualityPlanService'],
        entities: [
          { entity: 'QualityPlan', description: 'Quality Plan', keyFields: ['QualityPlanNo'], sustainabilityFields: ['CfDyeCompliance', 'CfREACHStatus', 'CfOEKOTEXClass'] },
        ],
        servicePath: '/api/data/QualityPlans',
      },
      {
        module: 'LotBatch',
        description: 'Lot/batch traceability',
        apiNames: ['LotBatchMasterService'],
        entities: [
          { entity: 'LotBatch', description: 'Lot/Batch Master', keyFields: ['LotBatchNo', 'PartNo'], sustainabilityFields: ['CfDyeLot', 'CfOriginCountry', 'CfFiberBlend', 'CfCarbonKg'] },
        ],
        servicePath: '/api/data/LotBatches',
      },
    ],
    supportedCertifications: ['OEKO-TEX Standard 100', 'GOTS', 'GRS', 'REACH', 'bluesign'],
  },

  // ========================================================================
  // 9. Workday
  // ========================================================================
  {
    erpId: 'workday',
    displayName: 'Workday',
    apiType: 'SOAP (WWS) + REST + PRISM Analytics',
    customFieldConvention: 'Custom_* prefix via Workday Extend or custom objects',
    modules: [
      {
        module: 'StrategicSourcing',
        description: 'Spend items and supplier sustainability tracking',
        apiNames: ['Resource_Management', 'Supplier'],
        entities: [
          { entity: 'SpendItem', description: 'Spend Item', keyFields: ['Spend_Item_ID'], sustainabilityFields: ['Custom_Recycled_Percent', 'Custom_Organic_Certified', 'Custom_Sustainability_Cert'] },
          { entity: 'Supplier', description: 'Supplier', keyFields: ['Supplier_ID'], sustainabilityFields: ['Custom_Sustainability_Tier', 'Custom_Last_Audit_Date', 'Custom_Compliance_Status'] },
        ],
        servicePath: '/ccx/api/v1/resourceManagement',
      },
      {
        module: 'QualityCompliance',
        description: 'Custom QA objects for textile testing (via Workday Extend)',
        apiNames: ['Custom_QA_Report'],
        entities: [
          { entity: 'Custom_QA_Report', description: 'Quality Assessment Report', keyFields: ['Custom_QA_Report_ID'], sustainabilityFields: ['Custom_Dye_Compliance', 'Custom_REACH_Status', 'Custom_OEKOTEX_Class'] },
        ],
        servicePath: '/ccx/api/v1/custom/qualityReports',
      },
      {
        module: 'SupplyChainTracking',
        description: 'Batch/lot tracking via custom objects',
        apiNames: ['Custom_Batch_Tracking'],
        entities: [
          { entity: 'Custom_Batch', description: 'Batch Record', keyFields: ['Custom_Batch_ID'], sustainabilityFields: ['Custom_Dye_Lot', 'Custom_Origin_Country', 'Custom_Fiber_Blend', 'Custom_Carbon_Kg'] },
        ],
        servicePath: '/ccx/api/v1/custom/batchTracking',
      },
    ],
    supportedCertifications: ['OEKO-TEX Standard 100', 'GOTS', 'GRS', 'REACH'],
  },

  // ========================================================================
  // 10. Oracle PeopleSoft
  // ========================================================================
  {
    erpId: 'oracle-peoplesoft',
    displayName: 'PeopleSoft',
    apiType: 'Component Interface + Integration Broker',
    customFieldConvention: 'CUST_* prefix on custom fields',
    modules: [
      {
        module: 'Inventory',
        description: 'Inventory items and vendor management',
        apiNames: ['CI_ITEM_MASTER', 'CI_VENDOR'],
        entities: [
          { entity: 'INV_ITEMS', description: 'Item Master', keyFields: ['INV_ITEM_ID'], sustainabilityFields: ['CUST_RECYCLED_PCT', 'CUST_ORGANIC_FLG', 'CUST_SUSTAIN_CERT'] },
          { entity: 'VENDOR', description: 'Vendor Table', keyFields: ['VENDOR_ID'], sustainabilityFields: ['CUST_SUSTAIN_TIER', 'CUST_AUDIT_DT', 'CUST_COMPLIANCE'] },
        ],
        servicePath: '/PSIGW/RESTListeningConnector/PSFT_HR/CI_ITEM_MASTER.v1',
      },
      {
        module: 'QualityMgmt',
        description: 'Quality plans and test results',
        apiNames: ['CI_QA_PLAN'],
        entities: [
          { entity: 'QA_PLAN', description: 'Quality Plan', keyFields: ['QA_PLAN_ID'], sustainabilityFields: ['CUST_DYE_COMPLY', 'CUST_REACH_STATUS', 'CUST_OEKOTEX_CLS'] },
        ],
        servicePath: '/PSIGW/RESTListeningConnector/PSFT_HR/CI_QA_PLAN.v1',
      },
      {
        module: 'LotControl',
        description: 'Lot/serial control for traceability',
        apiNames: ['CI_LOT_CONTROL'],
        entities: [
          { entity: 'LOT_CONTROL', description: 'Lot Control', keyFields: ['LOT_ID', 'INV_ITEM_ID'], sustainabilityFields: ['CUST_DYE_LOT', 'CUST_ORIGIN_CNTRY', 'CUST_FIBER_BLEND', 'CUST_CARBON_KG'] },
        ],
        servicePath: '/PSIGW/RESTListeningConnector/PSFT_HR/CI_LOT_CONTROL.v1',
      },
    ],
    supportedCertifications: ['OEKO-TEX Standard 100', 'GOTS', 'GRS', 'REACH'],
  },
];

// Build lookup map for fast access
const ERP_CONFIG_MAP = new Map<string, ERPSustainabilityConfig>();
for (const config of ERP_SUSTAINABILITY_REGISTRY) {
  ERP_CONFIG_MAP.set(config.erpId, config);
}

// ---------------------------------------------------------------------------
// Request Types
// ---------------------------------------------------------------------------

interface ErpSurfaceRequest {
  source_ref?: unknown;
  erp_type?: string;
  operation?: string;
  entity_type?: string;
  module?: string;
  query?: Record<string, unknown>;
  sync_config?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Route Handlers
// ---------------------------------------------------------------------------

/**
 * POST /v1/erpsurface
 *
 * Handles ERP Surface integration operations.
 */
erpsurface.post('/', async (c) => {
  try {
    const body = await c.req.json<ErpSurfaceRequest>();

    const id = ids.erp();
    const erpType = body.erp_type ?? 'generic';
    const operation = body.operation ?? 'sync';
    const entityType = body.entity_type ?? 'all';

    const response = buildErpSurfaceReference(
      id,
      body.source_ref,
      erpType,
      operation,
      entityType,
      body.query ?? {},
      body.sync_config ?? {}
    );

    return c.json(response, 200);
  } catch (error) {
    console.error('ERP Surface route error:', error);
    return c.json(
      { error: { code: 'INTERNAL_ERROR', message: error instanceof Error ? error.message : 'Unknown error' } },
      500
    );
  }
});

/**
 * GET /v1/erpsurface/:id
 *
 * Get ERP Surface integration status.
 */
erpsurface.get('/:id', async (c) => {
  const id = c.req.param('id');

  return c.json({
    id,
    type: 'ErpSurfaceReference',
    status: 'completed',
    repository: 'agentics-erp-surface',
    created_at: new Date().toISOString(),
    sync_status: {
      entities_synced: 1250,
      entities_failed: 0,
      last_sync_at: new Date().toISOString(),
      next_sync_at: new Date(Date.now() + 3600000).toISOString(),
    },
  });
});

/**
 * GET /v1/erpsurface/sustainability/platforms
 *
 * Lists all 10 supported ERP platforms with sustainability module metadata.
 */
erpsurface.get('/sustainability/platforms', async (c) => {
  return c.json({
    type: 'ERPSustainabilityPlatforms',
    platform_count: ERP_SUSTAINABILITY_REGISTRY.length,
    platforms: ERP_SUSTAINABILITY_REGISTRY.map((cfg) => ({
      erp_id: cfg.erpId,
      display_name: cfg.displayName,
      api_type: cfg.apiType,
      custom_field_convention: cfg.customFieldConvention,
      module_count: cfg.modules.length,
      modules: cfg.modules.map((m) => m.module),
      supported_certifications: cfg.supportedCertifications,
    })),
  });
});

/**
 * GET /v1/erpsurface/sustainability/modules/:erpId
 *
 * Returns sustainability module definitions for a specific ERP platform.
 * Works for any of the 10 supported ERPs.
 */
erpsurface.get('/sustainability/modules/:erpId', async (c) => {
  const erpId = c.req.param('erpId');
  const config = ERP_CONFIG_MAP.get(erpId);

  if (!config) {
    return c.json(
      {
        error: {
          code: 'ERP_NOT_FOUND',
          message: `Unknown ERP platform: ${erpId}`,
          supported: [...ERP_CONFIG_MAP.keys()],
        },
      },
      400,
    );
  }

  return c.json({
    type: 'ERPSustainabilityModules',
    erp_id: config.erpId,
    display_name: config.displayName,
    api_type: config.apiType,
    custom_field_convention: config.customFieldConvention,
    modules: config.modules.map((m) => ({
      module: m.module,
      description: m.description,
      api_names: m.apiNames,
      service_path: m.servicePath,
      entities: m.entities.map((e) => ({
        entity_name: e.entity,
        description: e.description,
        key_fields: e.keyFields,
        sustainability_fields: e.sustainabilityFields,
      })),
    })),
    supported_certifications: config.supportedCertifications,
  });
});

/**
 * POST /v1/erpsurface/sustainability/query
 *
 * Query sustainability data from any supported ERP by platform, module, and entity.
 */
erpsurface.post('/sustainability/query', async (c) => {
  try {
    const body = await c.req.json<{
      erp_id: string;
      module: string;
      entity?: string;
      filters?: Record<string, unknown>;
      fields?: string[];
    }>();

    const config = ERP_CONFIG_MAP.get(body.erp_id);
    if (!config) {
      return c.json(
        { error: { code: 'ERP_NOT_FOUND', message: `Unknown ERP: ${body.erp_id}`, supported: [...ERP_CONFIG_MAP.keys()] } },
        400,
      );
    }

    const moduleConfig = config.modules.find((m) => m.module === body.module);
    if (!moduleConfig) {
      return c.json(
        { error: { code: 'MODULE_NOT_FOUND', message: `Module ${body.module} not found in ${config.displayName}`, available: config.modules.map((m) => m.module) } },
        400,
      );
    }

    const targetEntity = body.entity
      ? moduleConfig.entities.find((e) => e.entity === body.entity)
      : moduleConfig.entities[0];

    if (!targetEntity) {
      return c.json(
        { error: { code: 'ENTITY_NOT_FOUND', message: `Entity ${body.entity} not found in module ${body.module}`, available: moduleConfig.entities.map((e) => e.entity) } },
        400,
      );
    }

    return c.json({
      id: ids.erp(),
      type: 'ERPSustainabilityQueryResult',
      erp_id: body.erp_id,
      erp_name: config.displayName,
      api_type: config.apiType,
      module: body.module,
      entity: targetEntity.entity,
      service_path: moduleConfig.servicePath,
      available_apis: moduleConfig.apiNames,
      query: {
        fields: body.fields ?? [...targetEntity.keyFields, ...targetEntity.sustainabilityFields],
        filters: body.filters ?? {},
      },
      status: 'ready',
      created_at: new Date().toISOString(),
    });
  } catch (error) {
    return c.json(
      { error: { code: 'INTERNAL_ERROR', message: error instanceof Error ? error.message : 'Unknown error' } },
      500,
    );
  }
});

// Backward-compat: SAP-specific routes redirect to generic ones
erpsurface.get('/sap/sustainability-modules', async (c) => {
  const config = ERP_CONFIG_MAP.get('sap-s4hana')!;
  return c.json({
    type: 'SAPSustainabilityModules',
    modules: config.modules.map((m) => ({
      module: m.module,
      description: m.description,
      bapi_names: m.apiNames,
      odata_service: m.servicePath,
      tables: m.entities.map((e) => ({
        table_name: e.entity,
        description: e.description,
        key_fields: e.keyFields,
        sustainability_fields: e.sustainabilityFields,
      })),
    })),
    custom_field_convention: config.customFieldConvention,
    supported_certifications: config.supportedCertifications,
  });
});

export { erpsurface };
