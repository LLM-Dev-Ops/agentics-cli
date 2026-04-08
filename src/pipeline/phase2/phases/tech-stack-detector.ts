/**
 * Phase 2 Pipeline -- Shared Tech Stack Detector (ADR-029 Fix 1)
 *
 * Deterministic (no LLM calls) detection of technology stack from query and
 * dossier text. Produces a canonical TechStack object that flows end-to-end
 * through the pipeline so every stage uses the SAME ERP, cloud, and database
 * details.
 *
 * Primary consumers:
 *   - adr-generator.ts   (writes tech-stack.json, embeds in LLM prompt)
 *   - ruflo-phase-executor.ts (reads tech-stack.json, embeds in wave prompts)
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

// ============================================================================
// Types
// ============================================================================

export interface ERPSystem {
  readonly name: string;
  readonly slug: string;
  readonly baseApiPath: string;
  readonly authMethod: string;
  readonly commonResources: string[];
}

export type CloudProvider = 'aws' | 'azure' | 'gcp' | null;

export type DatabaseEngine =
  | 'postgresql'
  | 'mysql'
  | 'mongodb'
  | 'dynamodb'
  | 'cosmosdb'
  | 'bigquery'
  | 'snowflake'
  | 'sql-server'
  | null;

export interface TechStack {
  readonly erp: ERPSystem | null;
  readonly cloud: CloudProvider;
  readonly database: DatabaseEngine;
  readonly messageQueue: string | null;
  readonly searchEngine: string | null;
  readonly cacheLayer: string | null;
}

// ============================================================================
// ERP Registry -- canonical API details per ERP vendor
// ============================================================================

const ERP_REGISTRY: readonly ERPSystem[] = [
  {
    name: 'Oracle Fusion',
    slug: 'oracle-fusion',
    baseApiPath: '/fscmRestApi/resources/v1/{resource}',
    authMethod: 'OAuth2 JWT bearer',
    commonResources: ['purchaseOrders', 'suppliers', 'budgets', 'transferOrders', 'journalEntries'],
  },
  {
    name: 'SAP S/4HANA',
    slug: 'sap-s4hana',
    baseApiPath: '/sap/opu/odata4/sap/{service}',
    authMethod: 'SAP OAuth/SAML',
    commonResources: [
      'API_BUSINESS_PARTNER',
      'API_PURCHASEORDER_PROCESS_SRV',
      'API_SALES_ORDER_SRV',
    ],
  },
  {
    name: 'NetSuite',
    slug: 'netsuite',
    baseApiPath: '/services/rest/record/v1/{record}',
    authMethod: 'Token-Based Authentication (TBA)',
    commonResources: ['transferOrder', 'purchaseOrder', 'salesOrder', 'customer', 'vendor'],
  },
  {
    name: 'Workday',
    slug: 'workday',
    baseApiPath: '/ccx/api/v1/{tenant}/{resource}',
    authMethod: 'OAuth2',
    commonResources: ['workers', 'organizations', 'budgets', 'costCenters'],
  },
  {
    name: 'Microsoft Dynamics 365',
    slug: 'dynamics-365',
    baseApiPath: '/api/data/v9.2/{entity}',
    authMethod: 'OAuth2 (Azure AD)',
    commonResources: ['accounts', 'salesorders', 'invoices', 'products'],
  },
  {
    name: 'Infor CloudSuite',
    slug: 'infor-cloudsuite',
    baseApiPath: '/M3/m3api-rest/v2/execute/{program}',
    authMethod: 'OAuth2/IFS',
    commonResources: ['CRS610MI', 'PMS100MI', 'OIS100MI'],
  },
  {
    name: 'Yardi Voyager',
    slug: 'yardi-voyager',
    baseApiPath: '/api/rest/v1/{resource}',
    authMethod: 'OAuth2',
    commonResources: ['Property', 'Lease', 'Tenant', 'WorkOrder', 'CapitalProject', 'UtilityExpense', 'GLAccount'],
  },
] as const;

// ============================================================================
// Detection patterns -- ordered from most specific to least specific
// ============================================================================

/**
 * ERP detection rules. Order matters: more specific patterns are checked first
 * so "Oracle Fusion" beats a bare "Oracle" match.
 */
const ERP_PATTERNS: ReadonlyArray<{ pattern: RegExp; slug: string }> = [
  // Oracle variants -- specific first
  { pattern: /\boracle\s+fusion/i, slug: 'oracle-fusion' },
  { pattern: /\boracle\s+erp\b/i, slug: 'oracle-fusion' },
  { pattern: /\boracle\s+cloud\s+erp\b/i, slug: 'oracle-fusion' },
  { pattern: /\boracle\b/i, slug: 'oracle-fusion' },

  // SAP variants
  { pattern: /\bsap\s+s\/4\s*hana\b/i, slug: 'sap-s4hana' },
  { pattern: /\bsap\s+s4\s*hana\b/i, slug: 'sap-s4hana' },
  { pattern: /\bs\/4\s*hana\b/i, slug: 'sap-s4hana' },
  { pattern: /\bsap\b/i, slug: 'sap-s4hana' },

  // NetSuite
  { pattern: /\bnetsuite\b/i, slug: 'netsuite' },

  // Workday
  { pattern: /\bworkday\b/i, slug: 'workday' },

  // Dynamics 365
  { pattern: /\bdynamics\s*365\b/i, slug: 'dynamics-365' },
  { pattern: /\bd365\b/i, slug: 'dynamics-365' },
  { pattern: /\bmicrosoft\s+dynamics\b/i, slug: 'dynamics-365' },

  // Infor
  { pattern: /\binfor\s+cloudsuite\b/i, slug: 'infor-cloudsuite' },
  { pattern: /\binfor\s+m3\b/i, slug: 'infor-cloudsuite' },
  { pattern: /\binfor\b/i, slug: 'infor-cloudsuite' },

  // Yardi
  { pattern: /\byardi\s+voyager\b/i, slug: 'yardi-voyager' },
  { pattern: /\byardi\s+erp\b/i, slug: 'yardi-voyager' },
  { pattern: /\byardi\b/i, slug: 'yardi-voyager' },
];

const CLOUD_PATTERNS: ReadonlyArray<{ pattern: RegExp; provider: CloudProvider }> = [
  { pattern: /\baws\b/i, provider: 'aws' },
  { pattern: /\bamazon\s+web\s+services\b/i, provider: 'aws' },
  { pattern: /\bazure\b/i, provider: 'azure' },
  { pattern: /\bmicrosoft\s+azure\b/i, provider: 'azure' },
  { pattern: /\bgcp\b/i, provider: 'gcp' },
  { pattern: /\bgoogle\s+cloud/i, provider: 'gcp' },
];

const DATABASE_PATTERNS: ReadonlyArray<{ pattern: RegExp; engine: DatabaseEngine }> = [
  { pattern: /\bpostgres(?:ql)?\b/i, engine: 'postgresql' },
  { pattern: /\bmysql\b/i, engine: 'mysql' },
  { pattern: /\bmongodb\b/i, engine: 'mongodb' },
  { pattern: /\bdynamodb\b/i, engine: 'dynamodb' },
  { pattern: /\bcosmos\s*db\b/i, engine: 'cosmosdb' },
  { pattern: /\bbigquery\b/i, engine: 'bigquery' },
  { pattern: /\bsnowflake\b/i, engine: 'snowflake' },
  { pattern: /\bsql\s*server\b/i, engine: 'sql-server' },
  { pattern: /\bmssql\b/i, engine: 'sql-server' },
];

const MESSAGE_QUEUE_PATTERNS: ReadonlyArray<{ pattern: RegExp; name: string }> = [
  { pattern: /\bkafka\b/i, name: 'Kafka' },
  { pattern: /\brabbitmq\b/i, name: 'RabbitMQ' },
  { pattern: /\bsqs\b/i, name: 'AWS SQS' },
  { pattern: /\bservice\s*bus\b/i, name: 'Azure Service Bus' },
  { pattern: /\bpub\/?sub\b/i, name: 'Google Pub/Sub' },
  { pattern: /\bnats\b/i, name: 'NATS' },
];

const SEARCH_ENGINE_PATTERNS: ReadonlyArray<{ pattern: RegExp; name: string }> = [
  { pattern: /\belasticsearch\b/i, name: 'Elasticsearch' },
  { pattern: /\bopensearch\b/i, name: 'OpenSearch' },
  { pattern: /\bsolr\b/i, name: 'Solr' },
  { pattern: /\balgolia\b/i, name: 'Algolia' },
];

const CACHE_PATTERNS: ReadonlyArray<{ pattern: RegExp; name: string }> = [
  { pattern: /\bredis\b/i, name: 'Redis' },
  { pattern: /\bmemcached\b/i, name: 'Memcached' },
  { pattern: /\belasticache\b/i, name: 'ElastiCache' },
];

// ============================================================================
// Detection functions
// ============================================================================

function detectERP(text: string): ERPSystem | null {
  for (const rule of ERP_PATTERNS) {
    if (rule.pattern.test(text)) {
      const erp = ERP_REGISTRY.find(e => e.slug === rule.slug);
      if (erp) return erp;
    }
  }
  return null;
}

function detectCloud(text: string): CloudProvider {
  for (const rule of CLOUD_PATTERNS) {
    if (rule.pattern.test(text)) return rule.provider;
  }
  return null;
}

function detectDatabase(text: string): DatabaseEngine {
  for (const rule of DATABASE_PATTERNS) {
    if (rule.pattern.test(text)) return rule.engine;
  }
  return null;
}

function detectFirst(text: string, patterns: ReadonlyArray<{ pattern: RegExp; name: string }>): string | null {
  for (const rule of patterns) {
    if (rule.pattern.test(text)) return rule.name;
  }
  return null;
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Scan query and dossier text for technology mentions. Returns a deterministic
 * TechStack — no LLM calls, purely regex-based.
 */
export function detectTechnologyStack(query: string, dossierText: string): TechStack {
  // Query takes priority (user intent), then dossier (research findings)
  const combined = `${query}\n${dossierText}`;

  return {
    erp: detectERP(combined),
    cloud: detectCloud(combined),
    database: detectDatabase(combined),
    messageQueue: detectFirst(combined, MESSAGE_QUEUE_PATTERNS),
    searchEngine: detectFirst(combined, SEARCH_ENGINE_PATTERNS),
    cacheLayer: detectFirst(combined, CACHE_PATTERNS),
  };
}

/**
 * Write tech-stack.json to the output directory.
 * Returns the absolute path of the written file.
 */
export function writeTechStack(techStack: TechStack, outputDir: string): string {
  const filePath = path.join(outputDir, 'tech-stack.json');
  try {
    fs.writeFileSync(filePath, JSON.stringify(techStack, null, 2) + '\n', { encoding: 'utf-8', mode: 0o600 });
    process.stderr.write(`[tech-stack-detector] Wrote ${filePath}\n`);
  } catch (err: unknown) {
    process.stderr.write(
      `[tech-stack-detector] Failed to write ${filePath}: ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }
  return filePath;
}

/**
 * Read tech-stack.json from a directory. Returns null if not found or invalid.
 */
export function loadTechStack(dir: string): TechStack | null {
  const filePath = path.join(dir, 'tech-stack.json');
  try {
    if (!fs.existsSync(filePath)) return null;
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as TechStack;
    return raw;
  } catch {
    return null;
  }
}

/**
 * Format ERP details into a string suitable for embedding in LLM prompts.
 */
export function formatERPContextForPrompt(erp: ERPSystem): string {
  return [
    `ERP System: ${erp.name}`,
    `API Base: ${erp.baseApiPath}`,
    `Authentication: ${erp.authMethod}`,
    `Resources: ${erp.commonResources.join(', ')}`,
  ].join('\n');
}

/**
 * Format the full tech stack for LLM prompt embedding.
 * Only includes non-null fields.
 */
export function formatTechStackForPrompt(ts: TechStack): string {
  const lines: string[] = ['## Technology Stack (from detection)'];
  if (ts.erp) {
    lines.push(formatERPContextForPrompt(ts.erp));
    lines.push(`CRITICAL: Use these EXACT API paths. Do NOT use ${otherERPNames(ts.erp.slug)} APIs.`);
  }
  if (ts.cloud) lines.push(`Cloud Provider: ${ts.cloud.toUpperCase()}`);
  if (ts.database) lines.push(`Database: ${ts.database}`);
  if (ts.messageQueue) lines.push(`Message Queue: ${ts.messageQueue}`);
  if (ts.searchEngine) lines.push(`Search Engine: ${ts.searchEngine}`);
  if (ts.cacheLayer) lines.push(`Cache: ${ts.cacheLayer}`);
  return lines.join('\n');
}

/**
 * Return a human-readable list of other ERP names for negative prompting.
 */
function otherERPNames(currentSlug: string): string {
  return ERP_REGISTRY
    .filter(e => e.slug !== currentSlug)
    .map(e => e.name)
    .join(', ');
}

// ============================================================================
// ERP-Specific API Path Registry (ADR-029 Fix 1 — end-to-end)
// ============================================================================

/** ERP-specific operation paths for code generation templates. */
export interface ERPOperationPaths {
  readonly transferOrder: string;
  readonly purchaseOrder: string;
  readonly inventoryBalance: string;
  readonly itemReceipt: string;
  readonly defaultEntity: string;
  readonly auditLogLabel: string;
  readonly authComment: string;
}

const ERP_OPERATION_PATHS: Record<string, ERPOperationPaths> = {
  'netsuite': {
    transferOrder: '/services/rest/record/v1/transferOrder',
    purchaseOrder: '/services/rest/record/v1/purchaseOrder',
    inventoryBalance: '/services/rest/record/v1/inventoryBalance',
    itemReceipt: '/services/rest/record/v1/itemReceipt',
    defaultEntity: '/services/rest/record/v1/entity',
    auditLogLabel: 'netsuite_call',
    authComment: 'Token-Based Authentication (TBA)',
  },
  'oracle-fusion': {
    transferOrder: '/fscmRestApi/resources/v1/transferOrders',
    purchaseOrder: '/fscmRestApi/resources/v1/purchaseOrders',
    inventoryBalance: '/fscmRestApi/resources/v1/inventoryBalances',
    itemReceipt: '/fscmRestApi/resources/v1/receivingTransactions',
    defaultEntity: '/fscmRestApi/resources/v1/entity',
    auditLogLabel: 'oracle_fusion_call',
    authComment: 'OAuth2 JWT bearer token',
  },
  'sap-s4hana': {
    transferOrder: '/sap/opu/odata4/sap/API_STOCK_TRANSFER_ORDER_SRV/StockTransferOrder',
    purchaseOrder: '/sap/opu/odata4/sap/API_PURCHASEORDER_PROCESS_SRV/A_PurchaseOrder',
    inventoryBalance: '/sap/opu/odata4/sap/API_MATERIAL_STOCK_SRV/A_MatlStkInAcctMod',
    itemReceipt: '/sap/opu/odata4/sap/API_MATERIAL_DOCUMENT_SRV/A_MaterialDocumentHeader',
    defaultEntity: '/sap/opu/odata4/sap/API_ENTITY_SRV/Entity',
    auditLogLabel: 'sap_s4hana_call',
    authComment: 'SAP OAuth2/SAML token',
  },
  'workday': {
    transferOrder: '/ccx/api/v1/{tenant}/supplyChain/transferOrders',
    purchaseOrder: '/ccx/api/v1/{tenant}/procurement/purchaseOrders',
    inventoryBalance: '/ccx/api/v1/{tenant}/inventory/balances',
    itemReceipt: '/ccx/api/v1/{tenant}/receiving/receipts',
    defaultEntity: '/ccx/api/v1/{tenant}/entity',
    auditLogLabel: 'workday_call',
    authComment: 'OAuth2 token',
  },
  'dynamics-365': {
    transferOrder: '/api/data/v9.2/msdyn_transferorders',
    purchaseOrder: '/api/data/v9.2/purchaseorders',
    inventoryBalance: '/api/data/v9.2/msdyn_inventoryonhand',
    itemReceipt: '/api/data/v9.2/msdyn_productreceipts',
    defaultEntity: '/api/data/v9.2/entity',
    auditLogLabel: 'dynamics365_call',
    authComment: 'OAuth2 (Azure AD) token',
  },
  'infor-cloudsuite': {
    transferOrder: '/M3/m3api-rest/v2/execute/MMS850MI/AddTransferOrder',
    purchaseOrder: '/M3/m3api-rest/v2/execute/PPS200MI/AddPurchaseOrder',
    inventoryBalance: '/M3/m3api-rest/v2/execute/MMS200MI/GetItemBalance',
    itemReceipt: '/M3/m3api-rest/v2/execute/PPS300MI/AddReceipt',
    defaultEntity: '/M3/m3api-rest/v2/execute/ENTITY',
    auditLogLabel: 'infor_cloudsuite_call',
    authComment: 'OAuth2/IFS token',
  },
  'yardi-voyager': {
    transferOrder: '/api/rest/v1/CapitalProject',
    purchaseOrder: '/api/rest/v1/PurchaseOrder',
    inventoryBalance: '/api/rest/v1/Property',
    itemReceipt: '/api/rest/v1/WorkOrder',
    defaultEntity: '/api/rest/v1/Property',
    auditLogLabel: 'yardi_voyager_call',
    authComment: 'OAuth2 token (Yardi Voyager API)',
  },
};

/**
 * Get ERP-specific API operation paths for code generation.
 * Falls back to NetSuite paths for unknown ERP slugs.
 */
export function getERPOperationPaths(erpSlug: string | undefined): ERPOperationPaths {
  if (erpSlug && ERP_OPERATION_PATHS[erpSlug]) {
    return ERP_OPERATION_PATHS[erpSlug]!;
  }
  return ERP_OPERATION_PATHS['netsuite']!;
}

/**
 * Look up an ERPSystem by slug.
 */
export function getERPBySlug(slug: string): ERPSystem | null {
  return ERP_REGISTRY.find(e => e.slug === slug) ?? null;
}
