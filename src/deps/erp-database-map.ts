/**
 * Authoritative ERP → Database Engine Mapping
 *
 * Single source of truth for Phase 4 schema generation.
 * No ERP-to-database mapping may exist anywhere else in the codebase.
 *
 * Covers all commonly deployed enterprise ERP systems:
 *   SAP S/4HANA        → SAP HANA
 *   SAP ECC (legacy)    → Oracle / Db2 / SQL Server
 *   SAP Business One    → SQL Server / SAP HANA
 *   Oracle ERP Cloud    → Oracle Database
 *   Oracle NetSuite     → Oracle Database
 *   Oracle JD Edwards   → Oracle / Db2
 *   Oracle PeopleSoft   → Oracle Database
 *   Microsoft Dynamics  → SQL Server
 *   Infor               → Oracle / SQL Server / Db2
 *   Epicor              → SQL Server
 *   Sage X3             → SQL Server
 *   Sage Intacct        → API-only (cloud)
 *   IFS                 → SQL Server / Oracle
 *   Acumatica           → API-only (cloud)
 *   Unit4               → SQL Server
 *   SYSPRO              → SQL Server
 *   Workday             → API-only (no database)
 */

// ============================================================================
// Types
// ============================================================================

export type ERPSystem =
  | 'sap-s4hana'
  | 'sap-ecc'
  | 'sap-business-one'
  | 'oracle-erp'
  | 'oracle-netsuite'
  | 'oracle-jd-edwards'
  | 'oracle-peoplesoft'
  | 'microsoft-dynamics'
  | 'infor'
  | 'epicor'
  | 'sage-x3'
  | 'sage-intacct'
  | 'ifs'
  | 'acumatica'
  | 'unit4'
  | 'syspro'
  | 'workday'
  | 'deltek-costpoint'
  | 'guidewire'
  | 'yardi-voyager'
  | 'shopify-plus';

export type DatabaseEngine = 'sap-hana' | 'oracle' | 'sql-server' | 'db2' | 'postgresql' | 'mysql' | 'bigquery' | 'sqlite' | 'redshift';

export type SQLDialect = 'hana-sql' | 'oracle-sql' | 'tsql' | 'db2-sql' | 'postgresql' | 'mysql' | 'bigquery-sql' | 'sqlite' | 'redshift-sql';

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
  // ── SAP Family ──
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
  'sap-business-one': {
    erpSystem: 'sap-business-one',
    displayName: 'SAP Business One',
    primaryEngine: 'sql-server',
    alternateEngines: ['sap-hana'],
    apiOnly: false,
    sqlDialect: 'tsql',
  },

  // ── Oracle Family ──
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
  'oracle-jd-edwards': {
    erpSystem: 'oracle-jd-edwards',
    displayName: 'JD Edwards EnterpriseOne',
    primaryEngine: 'oracle',
    alternateEngines: ['db2', 'sql-server'],
    apiOnly: false,
    sqlDialect: 'oracle-sql',
  },
  'oracle-peoplesoft': {
    erpSystem: 'oracle-peoplesoft',
    displayName: 'PeopleSoft',
    primaryEngine: 'oracle',
    alternateEngines: [],
    apiOnly: false,
    sqlDialect: 'oracle-sql',
  },

  // ── Microsoft ──
  'microsoft-dynamics': {
    erpSystem: 'microsoft-dynamics',
    displayName: 'Microsoft Dynamics 365',
    primaryEngine: 'sql-server',
    alternateEngines: [],
    apiOnly: false,
    sqlDialect: 'tsql',
  },

  // ── Mid-market / Tier 2 ──
  'infor': {
    erpSystem: 'infor',
    displayName: 'Infor',
    primaryEngine: 'oracle',
    alternateEngines: ['sql-server', 'db2'],
    apiOnly: false,
    sqlDialect: 'oracle-sql',
  },
  'epicor': {
    erpSystem: 'epicor',
    displayName: 'Epicor Kinetic',
    primaryEngine: 'sql-server',
    alternateEngines: [],
    apiOnly: false,
    sqlDialect: 'tsql',
  },
  'sage-x3': {
    erpSystem: 'sage-x3',
    displayName: 'Sage X3',
    primaryEngine: 'sql-server',
    alternateEngines: [],
    apiOnly: false,
    sqlDialect: 'tsql',
  },
  'sage-intacct': {
    erpSystem: 'sage-intacct',
    displayName: 'Sage Intacct',
    primaryEngine: null,
    alternateEngines: [],
    apiOnly: true,
    sqlDialect: null,
  },
  'ifs': {
    erpSystem: 'ifs',
    displayName: 'IFS Cloud',
    primaryEngine: 'sql-server',
    alternateEngines: ['oracle'],
    apiOnly: false,
    sqlDialect: 'tsql',
  },
  'acumatica': {
    erpSystem: 'acumatica',
    displayName: 'Acumatica',
    primaryEngine: null,
    alternateEngines: [],
    apiOnly: true,
    sqlDialect: null,
  },
  'unit4': {
    erpSystem: 'unit4',
    displayName: 'Unit4 ERPx',
    primaryEngine: 'sql-server',
    alternateEngines: [],
    apiOnly: false,
    sqlDialect: 'tsql',
  },
  'syspro': {
    erpSystem: 'syspro',
    displayName: 'SYSPRO',
    primaryEngine: 'sql-server',
    alternateEngines: [],
    apiOnly: false,
    sqlDialect: 'tsql',
  },

  // ── Cloud-only / API-only ──
  'workday': {
    erpSystem: 'workday',
    displayName: 'Workday',
    primaryEngine: null,
    alternateEngines: [],
    apiOnly: true,
    sqlDialect: null,
  },

  // ── Vertical / Specialized ──
  'deltek-costpoint': {
    erpSystem: 'deltek-costpoint',
    displayName: 'Deltek Costpoint',
    primaryEngine: 'sql-server',
    alternateEngines: [],
    apiOnly: false,
    sqlDialect: 'tsql',
  },
  'guidewire': {
    erpSystem: 'guidewire',
    displayName: 'Guidewire InsuranceSuite',
    primaryEngine: null,
    alternateEngines: [],
    apiOnly: false,
    sqlDialect: null,
  },
  'yardi-voyager': {
    erpSystem: 'yardi-voyager',
    displayName: 'Yardi Voyager',
    primaryEngine: 'sql-server',
    alternateEngines: ['oracle'],
    apiOnly: false,
    sqlDialect: 'tsql',
  },
  'shopify-plus': {
    erpSystem: 'shopify-plus',
    displayName: 'Shopify Plus',
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
  // ── SAP Family (most specific first) ──
  { keywords: ['sap s/4hana', 's4hana', 'sap s4', 'sap hana', 's/4 hana'], system: 'sap-s4hana', weight: 1.0 },
  { keywords: ['sap ecc', 'sap r/3', 'sap r3'], system: 'sap-ecc', weight: 0.9 },
  { keywords: ['sap business one', 'sap b1', 'sap-b1'], system: 'sap-business-one', weight: 1.0 },
  { keywords: ['sap environment', 'sap procurement', 'sap adapter', 'sap module', 'sap integration', 'sap odata', 'sap bapi', 'sap idoc', 'sap'], system: 'sap-s4hana', weight: 0.7 },

  // ── Oracle Family ──
  { keywords: ['oracle erp', 'oracle cloud erp', 'oracle fusion', 'oracle erp cloud'], system: 'oracle-erp', weight: 1.0 },
  { keywords: ['netsuite', 'net suite', 'oracle netsuite', 'suitetalk', 'suiteql'], system: 'oracle-netsuite', weight: 1.0 },
  { keywords: ['jd edwards', 'jde', 'jd-edwards', 'enterpriseone', 'world erp'], system: 'oracle-jd-edwards', weight: 1.0 },
  { keywords: ['peoplesoft', 'people soft', 'psft'], system: 'oracle-peoplesoft', weight: 1.0 },

  // ── Microsoft ──
  { keywords: ['dynamics 365', 'dynamics365', 'd365', 'microsoft dynamics', 'dynamics f&o', 'dynamics finance', 'dynamics business central', 'business central', 'nav erp', 'navision', 'ax erp', 'dynamics ax'], system: 'microsoft-dynamics', weight: 1.0 },

  // ── Mid-market / Tier 2 ──
  { keywords: ['epicor', 'epicor kinetic', 'epicor erp', 'epicor prophet 21'], system: 'epicor', weight: 1.0 },
  { keywords: ['infor cloudsuite', 'infor m3', 'infor ln', 'infor erp', 'infor'], system: 'infor', weight: 0.9 },
  { keywords: ['sage x3', 'sage enterprise', 'sage erp'], system: 'sage-x3', weight: 1.0 },
  { keywords: ['sage intacct', 'intacct'], system: 'sage-intacct', weight: 1.0 },
  { keywords: ['ifs cloud', 'ifs erp', 'ifs applications', 'ifs'], system: 'ifs', weight: 0.9 },
  { keywords: ['acumatica'], system: 'acumatica', weight: 1.0 },
  { keywords: ['unit4', 'unit 4', 'unit4 erpx', 'agresso'], system: 'unit4', weight: 1.0 },
  { keywords: ['syspro'], system: 'syspro', weight: 1.0 },

  // ── Cloud-only / API-only ──
  { keywords: ['workday'], system: 'workday', weight: 1.0 },

  // ── Vertical / Specialized ──
  { keywords: ['deltek costpoint', 'deltek', 'costpoint', 'deltek vantagepoint'], system: 'deltek-costpoint', weight: 1.0 },
  { keywords: ['guidewire', 'claimcenter', 'policycenter', 'billingcenter', 'guidewire cloud', 'insurancesuite'], system: 'guidewire', weight: 1.0 },

  // ── Property Management / Real Estate ──
  { keywords: ['yardi voyager', 'yardi erp', 'yardi'], system: 'yardi-voyager', weight: 1.0 },

  // ── E-Commerce / DTC ──
  { keywords: ['shopify plus', 'shopify', 'shopify admin api'], system: 'shopify-plus', weight: 1.0 },

  // ── Generic ERP/procurement fallback → defaults to SAP S/4HANA ──
  { keywords: ['erp system', 'erp environment', 'erp integration', 'procurement system', 'procurement copilot', 'supply chain management', 'enterprise resource planning'], system: 'sap-s4hana', weight: 0.5 },
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

// ============================================================================
// Direct Database Detection (independent of ERP)
// ============================================================================

export interface DatabaseDetectionRule {
  readonly keywords: readonly string[];
  readonly engine: DatabaseEngine;
  readonly dialect: SQLDialect;
  readonly weight: number;
  /** Whether this is a transactional (OLTP) database vs analytics (OLAP/warehouse). */
  readonly category: 'transactional' | 'analytics';
}

export const DATABASE_DETECTION_RULES: readonly DatabaseDetectionRule[] = [
  // ── Transactional databases (used for schema DDL) ──
  // PostgreSQL family
  { keywords: ['postgresql', 'postgres', 'cloud sql for postgresql', 'aurora postgresql', 'supabase', 'neon database', 'cockroachdb', 'timescaledb', 'citus'], engine: 'postgresql', dialect: 'postgresql', weight: 1.0, category: 'transactional' },
  // MySQL family
  { keywords: ['mysql', 'aurora mysql', 'planetscale', 'mariadb', 'cloud sql for mysql', 'tidb', 'vitess'], engine: 'mysql', dialect: 'mysql', weight: 1.0, category: 'transactional' },
  // SQLite
  { keywords: ['sqlite', 'sqlite3', 'libsql', 'turso'], engine: 'sqlite', dialect: 'sqlite', weight: 1.0, category: 'transactional' },
  // Azure SQL / SQL Server (explicit mention overrides ERP-inferred dialect)
  { keywords: ['azure sql', 'azure synapse', 'sql server', 'mssql', 'azure sql database'], engine: 'sql-server', dialect: 'tsql', weight: 0.9, category: 'transactional' },
  // Oracle (explicit)
  { keywords: ['oracle database', 'oracle db', 'oracle cloud infrastructure database'], engine: 'oracle', dialect: 'oracle-sql', weight: 0.9, category: 'transactional' },
  // SAP HANA (explicit)
  { keywords: ['sap hana database', 'hana cloud'], engine: 'sap-hana', dialect: 'hana-sql', weight: 0.9, category: 'transactional' },

  // ── Analytics / warehouse databases (not used for transactional DDL) ──
  // Redshift
  { keywords: ['redshift', 'amazon redshift', 'redshift serverless', 'redshift spectrum'], engine: 'redshift', dialect: 'redshift-sql', weight: 0.8, category: 'analytics' },
  // BigQuery
  { keywords: ['bigquery', 'big query', 'google bigquery'], engine: 'bigquery', dialect: 'bigquery-sql', weight: 0.8, category: 'analytics' },
];

export interface DatabaseDetectionResult {
  readonly engine: DatabaseEngine;
  readonly dialect: SQLDialect;
  readonly confidence: number;
  readonly matchedKeyword: string;
  readonly category: 'transactional' | 'analytics';
}

/**
 * Scan text for explicit database infrastructure keywords.
 * Returns all matches sorted by confidence (descending).
 * This is independent of ERP detection — it catches cases where
 * the user specifies "PostgreSQL" or "BigQuery" directly.
 */
export function detectDatabaseFromText(text: string): DatabaseDetectionResult[] {
  const lower = text.toLowerCase();
  const results: DatabaseDetectionResult[] = [];

  for (const rule of DATABASE_DETECTION_RULES) {
    for (const keyword of rule.keywords) {
      if (lower.includes(keyword.toLowerCase())) {
        if (!results.some(r => r.engine === rule.engine)) {
          results.push({
            engine: rule.engine,
            dialect: rule.dialect,
            confidence: rule.weight,
            matchedKeyword: keyword,
            category: rule.category,
          });
        }
        break;
      }
    }
  }

  return results.sort((a, b) => b.confidence - a.confidence);
}

/**
 * From a list of database detection results, pick the best database for
 * transactional schema DDL generation. Transactional databases (PostgreSQL,
 * MySQL, SQL Server, etc.) are preferred over analytics databases (Redshift,
 * BigQuery) since schema DDL targets the primary data store, not the warehouse.
 *
 * Returns null if no transactional database was detected.
 */
export function pickTransactionalDatabase(results: DatabaseDetectionResult[]): DatabaseDetectionResult | null {
  const transactional = results.filter(r => r.category === 'transactional');
  return transactional.length > 0 ? transactional[0]! : null;
}
