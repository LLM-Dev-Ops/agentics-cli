/**
 * Authoritative ERP → Database Engine Mapping
 *
 * Single source of truth for Phase 4 schema generation.
 * No ERP-to-database mapping may exist anywhere else in the codebase.
 *
 * Mapping follows the user specification:
 *   SAP S/4HANA      → SAP HANA
 *   SAP ECC (legacy)  → Oracle / Db2 / SQL Server
 *   Oracle ERP        → Oracle Database
 *   Microsoft Dynamics → SQL Server
 *   Infor             → Oracle / SQL Server / Db2
 *   Workday           → API-only (no database)
 *   NetSuite          → Oracle Database
 */

// ============================================================================
// Types
// ============================================================================

export type ERPSystem =
  | 'sap-s4hana'
  | 'sap-ecc'
  | 'oracle-erp'
  | 'oracle-netsuite'
  | 'microsoft-dynamics'
  | 'infor'
  | 'workday';

export type DatabaseEngine = 'sap-hana' | 'oracle' | 'sql-server' | 'db2';

export type SQLDialect = 'hana-sql' | 'oracle-sql' | 'tsql' | 'db2-sql';

export interface ERPDatabaseMapping {
  readonly erpSystem: ERPSystem;
  readonly displayName: string;
  readonly primaryEngine: DatabaseEngine | null;
  readonly alternateEngines: readonly DatabaseEngine[];
  readonly apiOnly: boolean;
  readonly sqlDialect: SQLDialect | null;
}

// ============================================================================
// Mapping Table (Frozen)
// ============================================================================

export const ERP_DATABASE_MAP: Readonly<Record<ERPSystem, ERPDatabaseMapping>> = {
  'sap-s4hana': {
    erpSystem: 'sap-s4hana',
    displayName: 'SAP S/4HANA',
    primaryEngine: 'sap-hana',
    alternateEngines: [],
    apiOnly: false,
    sqlDialect: 'hana-sql',
  },
  'sap-ecc': {
    erpSystem: 'sap-ecc',
    displayName: 'SAP ECC (Legacy)',
    primaryEngine: 'oracle',
    alternateEngines: ['db2', 'sql-server'],
    apiOnly: false,
    sqlDialect: 'oracle-sql',
  },
  'oracle-erp': {
    erpSystem: 'oracle-erp',
    displayName: 'Oracle ERP Cloud',
    primaryEngine: 'oracle',
    alternateEngines: [],
    apiOnly: false,
    sqlDialect: 'oracle-sql',
  },
  'oracle-netsuite': {
    erpSystem: 'oracle-netsuite',
    displayName: 'NetSuite',
    primaryEngine: 'oracle',
    alternateEngines: [],
    apiOnly: false,
    sqlDialect: 'oracle-sql',
  },
  'microsoft-dynamics': {
    erpSystem: 'microsoft-dynamics',
    displayName: 'Microsoft Dynamics 365',
    primaryEngine: 'sql-server',
    alternateEngines: [],
    apiOnly: false,
    sqlDialect: 'tsql',
  },
  'infor': {
    erpSystem: 'infor',
    displayName: 'Infor',
    primaryEngine: 'oracle',
    alternateEngines: ['sql-server', 'db2'],
    apiOnly: false,
    sqlDialect: 'oracle-sql',
  },
  'workday': {
    erpSystem: 'workday',
    displayName: 'Workday',
    primaryEngine: null,
    alternateEngines: [],
    apiOnly: true,
    sqlDialect: null,
  },
};

// ============================================================================
// Detection Keywords
// ============================================================================

export interface ERPDetectionRule {
  readonly keywords: readonly string[];
  readonly system: ERPSystem;
  readonly weight: number;
}

export const ERP_DETECTION_RULES: readonly ERPDetectionRule[] = [
  { keywords: ['sap s/4hana', 's4hana', 'sap s4', 'sap hana', 's/4 hana'], system: 'sap-s4hana', weight: 1.0 },
  { keywords: ['sap ecc', 'sap r/3', 'sap r3'], system: 'sap-ecc', weight: 0.9 },
  { keywords: ['oracle erp', 'oracle cloud erp', 'oracle fusion', 'oracle erp cloud'], system: 'oracle-erp', weight: 1.0 },
  { keywords: ['netsuite', 'net suite', 'oracle netsuite'], system: 'oracle-netsuite', weight: 1.0 },
  { keywords: ['dynamics 365', 'dynamics365', 'd365', 'microsoft dynamics'], system: 'microsoft-dynamics', weight: 1.0 },
  { keywords: ['infor', 'infor cloudsuite', 'infor m3', 'infor ln'], system: 'infor', weight: 0.9 },
  { keywords: ['workday'], system: 'workday', weight: 1.0 },
];

// ============================================================================
// Helpers
// ============================================================================

export function resolveERPDatabase(system: ERPSystem): ERPDatabaseMapping {
  return ERP_DATABASE_MAP[system];
}

export function isApiOnlyERP(system: ERPSystem): boolean {
  return ERP_DATABASE_MAP[system].apiOnly;
}

export function getSQLDialect(system: ERPSystem): SQLDialect | null {
  return ERP_DATABASE_MAP[system].sqlDialect;
}

export function getPrimaryEngine(system: ERPSystem): DatabaseEngine | null {
  return ERP_DATABASE_MAP[system].primaryEngine;
}

export interface ERPDetectionResult {
  readonly system: ERPSystem;
  readonly confidence: number;
  readonly matchedKeyword: string;
}

/**
 * Scan text for ERP system keywords. Returns all matches sorted by
 * confidence (descending). Returns empty array if no ERP detected.
 */
export function detectERPFromText(text: string): ERPDetectionResult[] {
  const lower = text.toLowerCase();
  const results: ERPDetectionResult[] = [];

  for (const rule of ERP_DETECTION_RULES) {
    for (const keyword of rule.keywords) {
      if (lower.includes(keyword.toLowerCase())) {
        // Avoid duplicates for the same system
        if (!results.some(r => r.system === rule.system)) {
          results.push({
            system: rule.system,
            confidence: rule.weight,
            matchedKeyword: keyword,
          });
        }
        break;
      }
    }
  }

  return results.sort((a, b) => b.confidence - a.confidence);
}

/**
 * Return all known ERP systems.
 */
export function getAllERPSystems(): readonly ERPSystem[] {
  return Object.keys(ERP_DATABASE_MAP) as ERPSystem[];
}
