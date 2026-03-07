/**
 * Phase 2 Pipeline — Stage 5: DDD Model Generator
 *
 * Generates a Domain-Driven Design model as markdown + JSON, driven by the
 * SPARC architecture output, ADRs, and research dossier.
 *
 * Produces bounded contexts (one per architecture service), a context map,
 * and a ubiquitous language glossary — all derived from actual SPARC/dossier
 * content rather than noun-extraction heuristics.
 *
 * Primary output: DDD markdown documents
 * Compat output: domain-model.json, context-map.json for downstream consumers
 *
 * Error codes:
 *   ECLI-P2-010  Missing prerequisite stage output (SPARC or ADR)
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import type {
  Phase2Context,
  Phase2StageOutput,
  Phase2SPARCOutput,
  Phase2ADRRecord,
  ResearchDossier,
  Phase2DomainModel,
  Phase2DDDBoundedContext,
  Phase2AggregateDefinition,
  Phase2Entity,
  Phase2ValueObject,
  Phase2DomainEvent,
  Phase2Command,
  Phase2Query,
  UbiquitousLanguageTerm,
  Phase2ContextRelation,
  SubdomainType,
} from '../types.js';
import { createSpan, endSpan, emitSpan } from '../telemetry.js';

// ============================================================================
// Constants
// ============================================================================

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const JSON_INDENT = 2;

// ============================================================================
// Context Name Normalization
// ============================================================================

/**
 * Domain vocabulary for normalizing raw NLP-extracted context names into
 * canonical domain terms. Each entry maps a regex (matching raw fragments)
 * to a clean kebab-case domain term.
 *
 * Order matters: first match wins. More specific patterns come first.
 */
const DOMAIN_VOCABULARY: Array<[RegExp, string]> = [
  // Emissions / environmental reporting
  [/\b(?:emission|ghg|carbon|co2|greenhouse|scope[\s-]?[123])/i, 'emissions-tracking'],
  // Discrepancy / correction / remediation (before anomaly so "correct discrepancies" wins)
  [/\b(?:correct|remediat|rectif|resolv|fix).*(?:discrepanc|error|issue)/i, 'discrepancy-resolution'],
  [/\b(?:discrepanc).*(?:correct|resolv|remediat|fix)/i, 'discrepancy-resolution'],
  // Anomaly / detection (pure detection, not correction)
  [/\b(?:anomal|inconsisten|outlier|deviation)/i, 'anomaly-detection'],
  // Bare discrepancy without correction context → anomaly detection
  [/\b(?:discrepanc)/i, 'anomaly-detection'],
  // Environmental compliance / sustainability
  [/\b(?:sustainab|environment(?:al)?[\s-]?compliance|esg|csrd|tcfd|gri|cdp)/i, 'environmental-compliance'],
  // Waste / disposal / recycling
  [/\b(?:waste|disposal|recycl|hazardous|landfill|circular[\s-]?economy)/i, 'waste-management'],
  // Water / resource usage
  [/\b(?:water[\s-]?usage|water[\s-]?consump|effluent|water[\s-]?treatment)/i, 'water-management'],
  // Energy / consumption
  [/\b(?:energy[\s-]?consump|electricity|renewable|solar|wind|fossil[\s-]?fuel|kilowatt|megawatt)/i, 'energy-management'],
  // Regulatory / disclosure / filing
  [/\b(?:disclosure|filing|regulatory[\s-]?report|regulatory[\s-]?submiss)/i, 'regulatory-disclosure'],
  // Workflow / orchestration / lead / task routing
  [/\b(?:workflow|orchestrat|task[\s-]?rout|lead[\s-]?manag|work[\s-]?assign|dispatch)/i, 'workflow-orchestration'],
  // Bare "lead" as a standalone context (often means workflow coordination)
  [/^lead$/i, 'workflow-orchestration'],
  // Point of sale / POS / retail data ingestion (BEFORE promotion so "point-of-sale-retailers" wins)
  [/\b(?:point[\s-]?(?:of[\s-]?)?sale|pos[\s-]?data|retail[\s-]?(?:data|partner|point))/i, 'point-of-sale'],
  // Trade promotion / CPG / promotional effectiveness
  [/\b(?:promoti|trade[\s-]?promoti|trade[\s-]?spend|campaign[\s-]?effect|promo[\s-]?effect)/i, 'promotion-effectiveness'],
  // Budget / trade spending / financial planning
  [/\b(?:budget|trade[\s-]?spend|spend[\s-]?allocat|financial[\s-]?plan)/i, 'budget-management'],
  // Contract / retailer agreement
  [/\b(?:contract|retailer[\s-]?agreement|trade[\s-]?agreement|vendor[\s-]?contract)/i, 'contract-management'],
  // Cannibalization / sales displacement
  [/\b(?:cannibaliz|sales[\s-]?displace|channel[\s-]?shift|demand[\s-]?shift)/i, 'promotion-effectiveness'],
  // Underperforming / ineffective (promotion context)
  [/\b(?:underperform|ineffect|low[\s-]?roi|poor[\s-]?perform)/i, 'promotion-effectiveness'],
  // Inventory / stock
  [/\b(?:inventory|stock|warehouse|reorder|stockout)/i, 'inventory-optimization'],
  // Demand / forecasting
  [/\b(?:demand|forecast|predict|trend|seasonal)/i, 'demand-forecasting'],
  // Supply chain / coordination
  [/\b(?:supply[\s-]?chain|coordination|upstream|downstream)/i, 'supply-chain-coordination'],
  // Supply risk / imbalance / shortage
  [/\b(?:supply[\s-]?imbalance|shortage|surplus|supply[\s-]?risk|stockout|overstock)/i, 'supply-risk-detection'],
  // Procurement / sourcing
  [/\b(?:procurement|sourcing|purchas|vendor|supplier)/i, 'procurement-automation'],
  // Facility / transfer / warehouse movement
  [/\b(?:facility|transfer|warehouse[\s-]?movement|inter[\s-]?site|relocation)/i, 'facility-transfer'],
  // Compliance / audit
  [/\b(?:compliance|audit|regulat|inspection|certif)/i, 'compliance-auditing'],
  // Distribution / logistics / shipping
  [/\b(?:distribution|logistics|shipping|transport|delivery|route)/i, 'distribution-logistics'],
  // Quality
  [/\b(?:quality|defect|qa)/i, 'quality-assurance'],
  // Analytics / reporting / dashboard
  [/\b(?:analytics|dashboard|report|metric|kpi|visualization)/i, 'analytics-reporting'],
  // Order management
  [/\b(?:order|fulfillment|sales[\s-]?order|purchase[\s-]?order)/i, 'order-management'],
  // Customer / CRM
  [/\b(?:customer|crm|client|account[\s-]?management)/i, 'customer-management'],
  // Finance / billing
  [/\b(?:finance|billing|invoice|payment|accounting)/i, 'financial-ops'],
  // Production / manufacturing
  [/\b(?:production|manufactur|assembly|plant)/i, 'production-management'],
  // Monitoring / alerting
  [/\b(?:monitor|real[\s-]?time|alert|notification)/i, 'monitoring-alerts'],
  // Security / access
  [/\b(?:security|auth|access[\s-]?control|rbac|iam)/i, 'security-access'],
  // Mining / heavy equipment / predictive maintenance (BEFORE generic asset so "mining equipment" wins)
  [/\b(?:mining|mine[\s-]?site|ore|mineral|excavat|open[\s-]?pit|underground[\s-]?mine)/i, 'mining-operations'],
  [/\b(?:haul[\s-]?truck|loader|excavator|crusher|conveyor|drill[\s-]?rig|shovel)/i, 'equipment-telemetry'],
  [/\b(?:vibrat|bearing[\s-]?temp|oil[\s-]?analys|thermal[\s-]?imag|sensor[\s-]?data|iiot)/i, 'equipment-telemetry'],
  [/\b(?:predict(?:ive)?[\s-]?maint|condition[\s-]?monitor|failure[\s-]?predict|remaining[\s-]?useful[\s-]?life|rul\b)/i, 'predictive-maintenance'],
  [/\b(?:efficiency[\s-]?degrad|performance[\s-]?decay|throughput[\s-]?declin|degradat)/i, 'efficiency-degradation'],
  [/\b(?:production[\s-]?throughput|tonnage|output[\s-]?rate|processing[\s-]?rate|mill[\s-]?throughput)/i, 'production-throughput'],
  [/\b(?:fleet[\s-]?dispatch|fleet[\s-]?manag|vehicle[\s-]?track|gps[\s-]?track|dispatch[\s-]?optim)/i, 'fleet-dispatch'],
  [/\b(?:blast|drill[\s-]?pattern|fragmentation|blast[\s-]?optim)/i, 'blast-optimization'],
  [/\b(?:tailings|dam[\s-]?monitor|geotechnical|slope[\s-]?stabil)/i, 'geotechnical-monitoring'],
  // Asset / maintenance (generic fallback)
  [/\b(?:maintenance|asset|equipment)/i, 'asset-maintenance'],
  // HR / workforce
  [/\b(?:hr|employee|workforce|personnel|talent)/i, 'workforce-management'],
  // Integration adapter (keep as-is if already suffixed)
  [/-integration$/, '__keep__'],
  // API gateway (keep as-is)
  [/^api-gateway$/, '__keep__'],
];

/**
 * Normalize a raw context/service name into a canonical domain term.
 *
 * Rules:
 * - Strip verb phrases and sentence fragments
 * - Map to domain vocabulary via regex matching
 * - Enforce kebab-case with max 3 words
 * - Reject names longer than 40 characters (truncate to last full word)
 * - Collapse synonymous contexts to the same canonical name
 */
export function normalizeContextName(raw: string): string {
  const cleaned = raw
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .trim();

  // Check against domain vocabulary
  for (const [pattern, canonical] of DOMAIN_VOCABULARY) {
    if (pattern.test(cleaned) || pattern.test(raw)) {
      if (canonical === '__keep__') break; // Use fallback normalization
      return canonical;
    }
  }

  // Fallback: strip stop words and keep max 3 meaningful words
  const CONTEXT_STOP_WORDS = new Set([
    'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
    'of', 'with', 'by', 'from', 'as', 'is', 'was', 'are', 'were', 'be',
    'been', 'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will',
    'would', 'could', 'should', 'may', 'might', 'can', 'shall', 'must',
    'that', 'which', 'who', 'whom', 'this', 'these', 'those', 'it', 'its',
    'not', 'no', 'nor', 'so', 'if', 'when', 'where', 'how', 'what', 'why',
    'all', 'each', 'every', 'both', 'few', 'more', 'most', 'other', 'some',
    'such', 'than', 'too', 'very', 'just', 'about', 'above', 'after',
    'before', 'between', 'into', 'through', 'during', 'without', 'within',
    'inside', 'outside', 'also', 'only', 'then', 'once', 'here', 'there',
    'up', 'down', 'out', 'off', 'over', 'under', 'again', 'further',
    'likely', 'earlier', 'later', 'already', 'still', 'even', 'well',
  ]);

  const words = cleaned
    .split(/[\s-]+/)
    .filter(w => w.length > 1 && !CONTEXT_STOP_WORDS.has(w));

  if (words.length === 0) return raw.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'default-context';

  // Take max 3 words
  const slug = words.slice(0, 3).join('-');

  // Enforce 40-char limit, truncating at word boundary
  if (slug.length <= 40) return slug;
  const truncated = slug.slice(0, 40);
  const lastDash = truncated.lastIndexOf('-');
  return lastDash > 0 ? truncated.slice(0, lastDash) : truncated;
}

// ============================================================================
// Subdomain Classification
// ============================================================================

/**
 * Classify a context into core, supporting, or generic subdomain based on
 * its normalized name and description.
 *
 * - Core: Contexts that embody the primary competitive advantage / domain logic
 * - Supporting: Contexts that enable the core but are not differentiating
 * - Generic: Infrastructure, integration adapters, and cross-cutting concerns
 */
const SUBDOMAIN_RULES: Array<[RegExp, SubdomainType]> = [
  // Generic: integration adapters, gateways, infrastructure
  [/-integration$/i, 'generic'],
  [/^api-gateway$/i, 'generic'],
  [/\b(?:integration|adapter|connector|gateway|infrastructure)/i, 'generic'],
  [/\b(?:netsuite|oracle|sap|azure|aws|gcp|salesforce|servicenow|dynamics|workday)/i, 'generic'],
  [/\b(?:analytics|reporting|dashboard|monitoring|alert)/i, 'generic'],
  // Supporting: important but not the core differentiator
  [/\b(?:procurement|compliance|audit|quality|assurance)/i, 'supporting'],
  [/\b(?:facility|transfer|distribution|logistics)/i, 'supporting'],
  [/\b(?:security|access|auth|workforce|hr)/i, 'supporting'],
  [/\b(?:workflow|orchestrat|task[\s-]?rout)/i, 'supporting'],
  [/\b(?:waste|water|energy)[\s-]?management/i, 'supporting'],
  [/\b(?:regulatory|disclosure|filing)/i, 'supporting'],
  // Supporting: CPG trade promotion supporting contexts
  [/\b(?:budget|contract|point[\s-]?of[\s-]?sale)/i, 'supporting'],
  // Supporting: mining infrastructure contexts
  [/\b(?:fleet[\s-]?dispatch|geotechnical|blast[\s-]?optim|tailings)/i, 'supporting'],
  // Core: mining predictive maintenance and production
  [/\b(?:predict(?:ive)?[\s-]?maint|equipment[\s-]?telemetry|efficiency[\s-]?degrad|production[\s-]?throughput|mining[\s-]?operat)/i, 'core'],
  // Core: primary domain logic that differentiates the system
  [/\b(?:promoti|trade[\s-]?promoti|campaign|cannibaliz)/i, 'core'],
  [/\b(?:emission|ghg|carbon|co2|scope[\s-]?[123])/i, 'core'],
  [/\b(?:anomal|discrepanc|outlier|deviation)/i, 'core'],
  [/\b(?:environment(?:al)?[\s-]?compliance|sustainab|esg)/i, 'core'],
  [/\b(?:inventory|stock|warehouse)/i, 'core'],
  [/\b(?:demand|forecast|predict)/i, 'core'],
  [/\b(?:supply[\s-]?risk|risk[\s-]?detect|imbalance|shortage)/i, 'core'],
  [/\b(?:supply[\s-]?chain|coordination)/i, 'core'],
  [/\b(?:order[\s-]?management|fulfillment)/i, 'core'],
  [/\b(?:production|manufactur)/i, 'core'],
];

function classifySubdomain(contextName: string, description: string): SubdomainType {
  const text = `${contextName} ${description}`.toLowerCase();
  for (const [pattern, subdomain] of SUBDOMAIN_RULES) {
    if (pattern.test(text)) return subdomain;
  }
  return 'supporting'; // Default: supporting
}

// ============================================================================
// Context Map Relationship Inference
// ============================================================================

/**
 * Domain-aware relationship rules. Each rule specifies a source pattern,
 * target pattern, and the relationship to create between them.
 *
 * These rules encode the structural domain knowledge: which contexts
 * naturally feed data to which others, and what integration pattern
 * governs the boundary.
 */
interface RelationshipRule {
  readonly sourcePattern: RegExp;
  readonly targetPattern: RegExp;
  readonly type: Phase2ContextRelation['type'];
  readonly integration_pattern: string;
  readonly data_flows: string[];
  readonly description: string;
  readonly anti_corruption_strategy?: string;
}

const RELATIONSHIP_RULES: RelationshipRule[] = [
  // inventory → demand-forecasting: inventory levels feed forecast models
  {
    sourcePattern: /\b(?:inventory|stock)\b/,
    targetPattern: /\b(?:demand|forecast)\b/,
    type: 'published-language',
    integration_pattern: 'Published Language — inventory levels published as standardized events',
    data_flows: ['InventoryLevelChanged', 'StockCountUpdated', 'ReorderPointReached'],
    description: 'Inventory levels feed demand forecast models via published events',
  },
  // demand-forecasting → supply-risk-detection: forecasts trigger risk alerts
  {
    sourcePattern: /\b(?:demand|forecast)\b/,
    targetPattern: /\b(?:supply[\s-]?risk|risk[\s-]?detect|imbalance|shortage)\b/,
    type: 'anticorruption-layer',
    integration_pattern: 'ACL — forecast output translated to risk-domain language',
    data_flows: ['DemandForecastPublished', 'ForecastAnomalyDetected'],
    description: 'Demand forecasts trigger supply risk evaluation through ACL',
    anti_corruption_strategy: 'Risk context translates forecast DTOs into risk assessment commands, rejecting malformed forecasts',
  },
  // supply-risk → procurement: risk alerts trigger procurement/transfer actions
  {
    sourcePattern: /\b(?:supply[\s-]?risk|risk[\s-]?detect|imbalance|shortage)\b/,
    targetPattern: /\b(?:procurement|sourcing|purchas)\b/,
    type: 'anticorruption-layer',
    integration_pattern: 'ACL — risk alerts translated to procurement commands',
    data_flows: ['SupplyRiskAlertRaised', 'ShortageDetected', 'SurplusIdentified'],
    description: 'Supply risk alerts trigger procurement automation through ACL',
    anti_corruption_strategy: 'Procurement context validates risk severity and maps alerts to PO creation or transfer requests',
  },
  // supply-risk → facility-transfer: risk alerts trigger facility transfers
  {
    sourcePattern: /\b(?:supply[\s-]?risk|risk[\s-]?detect|imbalance|shortage)\b/,
    targetPattern: /\b(?:facility|transfer)\b/,
    type: 'anticorruption-layer',
    integration_pattern: 'ACL — risk alerts translated to transfer orders',
    data_flows: ['SupplyRiskAlertRaised', 'InterFacilityTransferRequested'],
    description: 'Supply risk detection triggers facility transfer requests through ACL',
    anti_corruption_strategy: 'Transfer context validates facility capacity before accepting transfer commands',
  },
  // procurement → ERP integrations: all ERP writes go through ACL
  {
    sourcePattern: /\b(?:procurement|sourcing|purchas)\b/,
    targetPattern: /\b(?:netsuite|oracle|sap|dynamics|workday|erp)\b/,
    type: 'anticorruption-layer',
    integration_pattern: 'Anti-Corruption Layer — domain commands translated to ERP-native API calls',
    data_flows: ['PurchaseOrderCreated', 'VendorPaymentScheduled', 'ReceiptConfirmed'],
    description: 'All ERP writes go through anti-corruption layer',
    anti_corruption_strategy: 'Adapter translates domain aggregates to ERP-native entities, handles field mapping, retry, and idempotency',
  },
  // facility-transfer → ERP integrations
  {
    sourcePattern: /\b(?:facility|transfer)\b/,
    targetPattern: /\b(?:netsuite|oracle|sap|dynamics|workday|erp)\b/,
    type: 'anticorruption-layer',
    integration_pattern: 'Anti-Corruption Layer — transfer orders mapped to ERP inventory movements',
    data_flows: ['TransferOrderCreated', 'InventoryMovementRecorded'],
    description: 'Facility transfers written to ERP through anti-corruption layer',
    anti_corruption_strategy: 'Adapter maps inter-facility transfers to ERP-specific inventory movement transactions',
  },
  // ERP ↔ ERP: partnership when sharing backend
  {
    sourcePattern: /\b(?:netsuite)\b/,
    targetPattern: /\b(?:oracle)\b/,
    type: 'partnership',
    integration_pattern: 'Partnership — shared ERP backend with coordinated release schedules',
    data_flows: ['ERPSyncCompleted', 'MasterDataReplicated'],
    description: 'Shared ERP backend partnership with coordinated data synchronization',
  },
  // inventory → supply-chain-coordination
  {
    sourcePattern: /\b(?:inventory|stock)\b/,
    targetPattern: /\b(?:supply[\s-]?chain[\s-]?coord|coordination|orchestrat)\b/,
    type: 'customer-supplier',
    integration_pattern: 'Customer-Supplier — inventory provides stock data to supply chain coordinator',
    data_flows: ['StockLevelReport', 'WarehouseCapacityUpdate'],
    description: 'Inventory management supplies stock data to supply chain coordination',
  },
  // demand-forecasting → supply-chain-coordination
  {
    sourcePattern: /\b(?:demand|forecast)\b/,
    targetPattern: /\b(?:supply[\s-]?chain[\s-]?coord|coordination|orchestrat)\b/,
    type: 'customer-supplier',
    integration_pattern: 'Customer-Supplier — forecasts inform supply chain planning',
    data_flows: ['DemandForecastPublished', 'SeasonalTrendAnalysis'],
    description: 'Demand forecasts inform supply chain coordination planning',
  },
  // order-management → inventory
  {
    sourcePattern: /\b(?:order[\s-]?management|fulfillment)\b/,
    targetPattern: /\b(?:inventory|stock)\b/,
    type: 'customer-supplier',
    integration_pattern: 'Customer-Supplier — orders consume and reserve inventory',
    data_flows: ['OrderPlaced', 'InventoryReserved', 'OrderFulfilled'],
    description: 'Order management reserves and consumes inventory stock',
  },
  // order-management → procurement
  {
    sourcePattern: /\b(?:order[\s-]?management|fulfillment)\b/,
    targetPattern: /\b(?:procurement|sourcing)\b/,
    type: 'customer-supplier',
    integration_pattern: 'Customer-Supplier — unfulfillable orders trigger procurement',
    data_flows: ['StockoutDetected', 'ProcurementRequested'],
    description: 'Orders that cannot be fulfilled trigger procurement workflows',
  },
  // production → inventory
  {
    sourcePattern: /\b(?:production|manufactur)\b/,
    targetPattern: /\b(?:inventory|stock)\b/,
    type: 'customer-supplier',
    integration_pattern: 'Customer-Supplier — production output feeds inventory',
    data_flows: ['ProductionCompleted', 'GoodsReceivedIntoStock'],
    description: 'Completed production feeds inventory with finished goods',
  },
];

/**
 * Build the context map by inferring relationships between bounded contexts
 * using domain-semantic rules, explicit SPARC dependencies, and structural
 * patterns (integration adapters, shared kernels, observer contexts).
 */
function buildContextMap(
  contexts: Phase2DDDBoundedContext[],
  deduplicatedServices: Array<{ name: string; dependencies: string[] }>,
  normalizedNameMap: Map<string, string>,
): Phase2ContextRelation[] {
  const contextNames = new Set(contexts.map(c => c.name));
  const relations: Phase2ContextRelation[] = [];
  const seen = new Set<string>(); // "upstream|downstream|type" dedup key

  const addRelation = (rel: Phase2ContextRelation): void => {
    if (rel.upstream === rel.downstream) return;
    if (!contextNames.has(rel.upstream) || !contextNames.has(rel.downstream)) return;
    const key = `${rel.upstream}|${rel.downstream}|${rel.type}`;
    if (seen.has(key)) return;
    seen.add(key);
    relations.push(rel);
  };

  // 1. Apply domain-semantic relationship rules
  for (const rule of RELATIONSHIP_RULES) {
    for (const source of contexts) {
      if (!rule.sourcePattern.test(source.name)) continue;
      for (const target of contexts) {
        if (source.name === target.name) continue;
        if (!rule.targetPattern.test(target.name)) continue;
        addRelation({
          upstream: source.name,
          downstream: target.name,
          type: rule.type,
          description: rule.description,
          integration_pattern: rule.integration_pattern,
          data_flows: rule.data_flows,
          anti_corruption_strategy: rule.anti_corruption_strategy,
        });
      }
    }
  }

  // 2. Integration adapters: any *-integration context gets a shared-kernel
  //    relationship from infrastructure contexts that provide data connectivity
  const integrationContexts = contexts.filter(c =>
    c.name.endsWith('-integration') || /\b(?:azure|aws|gcp)\b/.test(c.name),
  );
  const coreAndSupporting = contexts.filter(c => {
    const sub = c.subdomain ?? classifySubdomain(c.name, c.description);
    return sub === 'core' || sub === 'supporting';
  });

  for (const infra of integrationContexts) {
    // If the infra context name contains a cloud provider, it's a shared kernel
    if (/\b(?:azure|aws|gcp)\b/.test(infra.name)) {
      for (const core of coreAndSupporting) {
        addRelation({
          upstream: infra.name,
          downstream: core.name,
          type: 'shared-kernel',
          description: `${infra.name} provides shared data connectivity to ${core.name}`,
          integration_pattern: 'Shared Kernel — common data connectivity and authentication layer',
          data_flows: ['ConnectionPoolShared', 'AuthTokenExchanged'],
        });
      }
    }
  }

  // 3. Compliance/auditing: conformist observer to all write-path contexts
  const auditContexts = contexts.filter(c => /\b(?:compliance|audit)\b/.test(c.name));
  const writePathContexts = contexts.filter(c => c.commands.length > 0 && !/\b(?:compliance|audit)\b/.test(c.name));

  for (const audit of auditContexts) {
    for (const writer of writePathContexts) {
      addRelation({
        upstream: writer.name,
        downstream: audit.name,
        type: 'conformist',
        description: `${audit.name} observes all write operations in ${writer.name} for audit trail`,
        integration_pattern: 'Conformist — audit context subscribes to domain events without transforming them',
        data_flows: writer.domainEvents
          .filter(e => e.name.endsWith('Succeeded'))
          .slice(0, 3)
          .map(e => e.name),
      });
    }
  }

  // 4. Explicit SPARC dependencies (normalized) — only add if not already covered
  for (const svc of deduplicatedServices) {
    const normalizedDown = normalizedNameMap.get(svc.name)!;
    for (const dep of svc.dependencies) {
      if (!normalizedNameMap.has(dep)) continue;
      const normalizedUp = normalizedNameMap.get(dep)!;
      addRelation({
        upstream: normalizedUp,
        downstream: normalizedDown,
        type: 'customer-supplier',
        description: `${normalizedDown} depends on ${normalizedUp}`,
        integration_pattern: 'Customer-Supplier — downstream conforms to upstream API contract',
        data_flows: [],
      });
    }
  }

  return relations;
}

function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function pascalCase(text: string): string {
  return text
    .replace(/[-_\s]+(.)?/g, (_, c: string | undefined) => (c ? c.toUpperCase() : ''))
    .replace(/^(.)/, (_, c: string) => c.toUpperCase());
}

/**
 * Convert an API string like "POST /vendor/create-vendor" into a
 * domain command name like "CreateVendor".
 *
 * Strategy: strip HTTP method and path prefix, extract the action
 * slug (e.g. "create-vendor"), and PascalCase it.
 *
 * Safety: enforces max 3 meaningful words in the command name.
 * If the action slug is longer than 3 words, uses a standard CRUD
 * verb + context name (e.g., "UpdateProject") to prevent sentence
 * fragments from becoming 80-character PascalCase monstrosities.
 */
function toCommandName(apiMethod: string, contextName: string): string {
  // Strip leading HTTP method (POST, PUT, PATCH, DELETE)
  const withoutMethod = apiMethod.replace(/^\s*(POST|PUT|PATCH|DELETE)\s+/i, '');
  // Extract the last path segment (the action: "create-vendor", "update-payment")
  const segments = withoutMethod.split('/').filter(Boolean);
  const action = segments[segments.length - 1] ?? '';
  const cleaned = action.replace(/[^a-zA-Z0-9-]/g, '');
  if (!cleaned) return `Execute${contextName}`;

  // Split into words and enforce max 3 words
  const words = cleaned.split('-').filter(w => w.length > 0);
  if (words.length <= 3) {
    return pascalCase(cleaned);
  }

  // Too long — extract a CRUD verb if present, otherwise default to "Execute"
  const CRUD_VERBS = ['create', 'update', 'delete', 'remove', 'add', 'set', 'cancel', 'approve', 'reject', 'submit', 'process', 'manage'];
  const verb = words.find(w => CRUD_VERBS.includes(w.toLowerCase()));
  if (verb) {
    // Take the verb + at most 2 domain words after it
    const verbIdx = words.indexOf(verb);
    const tail = words.slice(verbIdx + 1, verbIdx + 3);
    return pascalCase([verb, ...tail].join('-'));
  }

  // No recognizable verb — use first 3 words
  return pascalCase(words.slice(0, 3).join('-'));
}

/**
 * Convert an API string like "GET /vendor" or "GET /vendor:id" into a
 * domain query name like "GetVendor" or "GetVendorById".
 *
 * Safety: enforces max 3 words to prevent sentence-fragment query names.
 */
function toQueryName(apiMethod: string, contextName: string): string {
  const withoutMethod = apiMethod.replace(/^\s*(GET)\s+/i, '');
  const segments = withoutMethod.split('/').filter(Boolean);
  const last = segments[segments.length - 1] ?? '';
  // Handle ":id" or "{id}" parameter patterns
  if (last.includes(':id') || last.includes('{id}')) {
    return `Get${contextName}ById`;
  }
  // If the last segment is just the context name, it's a list query
  const cleaned = last.replace(/[^a-zA-Z0-9-]/g, '');
  if (!cleaned || slugify(cleaned) === slugify(contextName)) {
    return `List${contextName}`;
  }
  // Enforce max 3 words
  const words = cleaned.split('-').filter(w => w.length > 0);
  if (words.length > 3) {
    return `Get${pascalCase(words.slice(0, 3).join('-'))}`;
  }
  return `Get${pascalCase(cleaned)}`;
}

// ============================================================================
// API Signature Parser (used by domain-codegen downstream)
// ============================================================================

export interface ParsedApiMethod {
  methodName: string;
  params: Array<{ name: string; type: string }>;
  returnType: string | null;
}

export function parseApiSignature(api: string): ParsedApiMethod | null {
  const match = api.match(/^(\w+)\(([^)]*)\)(?:\s*:\s*([\w\[\]<>,|\s]+))?/);
  if (!match) return null;

  const methodName = match[1]!;
  const paramStr = match[2] ?? '';
  const returnType = match[3]?.trim() ?? null;

  const params: Array<{ name: string; type: string }> = [];
  if (paramStr.trim().length > 0) {
    for (const segment of paramStr.split(',')) {
      const parts = segment.trim().split(/\s*:\s*/);
      const name = parts[0]?.trim() ?? '';
      const type = parts[1]?.trim() ?? '';
      if (name && type) {
        params.push({ name, type });
      }
    }
  }

  return { methodName, params, returnType };
}

// ============================================================================
// DDD Markdown Generator
// ============================================================================

function writeDDDMarkdown(model: Phase2DomainModel, sparc: Phase2SPARCOutput): string {
  const lines: string[] = [];

  lines.push('# Domain-Driven Design Model');
  lines.push('');
  lines.push(`Generated from SPARC architecture with ${sparc.architecture?.services?.length ?? 0} services.`);
  lines.push('');

  // Bounded Contexts
  lines.push('## Bounded Contexts');
  lines.push('');
  for (const ctx of model.contexts) {
    const subdomainLabel = ctx.subdomain ? ` [${ctx.subdomain} subdomain]` : '';
    lines.push(`### ${ctx.name}${subdomainLabel}`);
    lines.push(`> ${ctx.description}`);
    lines.push('');

    if (ctx.aggregates.length > 0) {
      lines.push('#### Aggregates');
      for (const agg of ctx.aggregates) {
        lines.push(`- **${agg.name}** (root: ${agg.root})`);
        if (agg.entities.length > 0) {
          for (const e of agg.entities) {
            lines.push(`  - Entity: ${e.name} — ${e.description ?? ''}`);
          }
        }
        if (agg.valueObjects.length > 0) {
          for (const vo of agg.valueObjects) {
            lines.push(`  - Value Object: ${vo.name}`);
          }
        }
        if (agg.invariants && agg.invariants.length > 0) {
          lines.push('  - Invariants:');
          for (const inv of agg.invariants) {
            lines.push(`    - ${inv}`);
          }
        }
      }
      lines.push('');
    }

    if (ctx.commands.length > 0) {
      lines.push('#### Commands');
      for (const cmd of ctx.commands) {
        lines.push(`- **${cmd.name}**: ${cmd.description ?? ''}`);
      }
      lines.push('');
    }

    if (ctx.queries.length > 0) {
      lines.push('#### Queries');
      for (const q of ctx.queries) {
        lines.push(`- **${q.name}**: returns ${q.returns ?? 'data'}`);
      }
      lines.push('');
    }

    if (ctx.domainEvents.length > 0) {
      lines.push('#### Domain Events');
      for (const evt of ctx.domainEvents) {
        lines.push(`- **${evt.name}**: ${evt.description ?? `triggered by ${evt.triggeredBy ?? 'command'}`}`);
      }
      lines.push('');
    }
  }

  // Context Map
  lines.push('## Context Map');
  lines.push('');
  if (model.contextMap.length > 0) {
    lines.push('| Upstream | Downstream | Relationship | Pattern | Description |');
    lines.push('|----------|------------|-------------|---------|-------------|');
    for (const rel of model.contextMap) {
      const pattern = rel.integration_pattern ?? '';
      lines.push(`| ${rel.upstream} | ${rel.downstream} | ${rel.type} | ${pattern} | ${rel.description ?? ''} |`);
    }
    lines.push('');

    // Data flows detail
    const flowRelations = model.contextMap.filter(r => r.data_flows && r.data_flows.length > 0);
    if (flowRelations.length > 0) {
      lines.push('### Data Flows');
      lines.push('');
      for (const rel of flowRelations) {
        lines.push(`**${rel.upstream} → ${rel.downstream}**: ${rel.data_flows!.join(', ')}`);
        if (rel.anti_corruption_strategy) {
          lines.push(`  - ACL Strategy: ${rel.anti_corruption_strategy}`);
        }
        lines.push('');
      }
    }
  } else {
    lines.push('No inter-context relationships (single bounded context).');
  }
  lines.push('');

  // Ubiquitous Language
  if (model.ubiquitousLanguageGlossary.length > 0) {
    lines.push('## Ubiquitous Language');
    lines.push('');
    lines.push('| Term | Definition | Context |');
    lines.push('|------|-----------|---------|');
    for (const term of model.ubiquitousLanguageGlossary) {
      lines.push(`| ${term.term} | ${term.definition} | ${term.context} |`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

// ============================================================================
// DDD Model Builder — derived from SPARC + dossier
// ============================================================================

export function buildPhase2DDD(
  sparc: Phase2SPARCOutput,
  adrs: Phase2ADRRecord[],
  dossier: ResearchDossier,
  scenarioQuery?: string,
): Phase2DomainModel {
  const services = sparc.architecture?.services ?? [];
  const glossary: UbiquitousLanguageTerm[] = [];

  // Normalize service names to canonical domain terms and deduplicate.
  // Multiple raw NLP fragments may collapse to the same canonical name;
  // when that happens, merge their capabilities and keep the first.
  const normalizedNameMap = new Map<string, string>(); // raw -> normalized
  for (const svc of services) {
    normalizedNameMap.set(svc.name, normalizeContextName(svc.name));
  }

  // Deduplicate: group services by their normalized name
  const seen = new Set<string>();
  const deduplicatedServices = services.filter((svc) => {
    const normalized = normalizedNameMap.get(svc.name)!;
    if (seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  });

  // Build bounded contexts from deduplicated services
  const contexts: Phase2DDDBoundedContext[] = deduplicatedServices.map((svc) => {
    const contextName = normalizedNameMap.get(svc.name)!;
    const svcName = pascalCase(contextName);

    // ── Extract typed fields and value objects from API signatures ──
    const parsedApis = svc.api.map(a => parseApiSignature(a)).filter(Boolean) as ParsedApiMethod[];
    const entityFields: string[] = [];
    const valueObjects: Phase2ValueObject[] = [];
    const seenVOs = new Set<string>();

    for (const parsed of parsedApis) {
      // Collect unique parameter names as entity fields
      for (const p of parsed.params) {
        if (!entityFields.includes(p.name)) entityFields.push(p.name);
        // Complex types (non-primitive) become value objects
        const primitives = new Set(['string', 'number', 'boolean', 'Date', 'void', 'any', 'unknown']);
        const baseType = p.type.replace(/[\[\]<>,|?\s]/g, '');
        if (baseType && !primitives.has(baseType) && !seenVOs.has(baseType)) {
          seenVOs.add(baseType);
          valueObjects.push({
            name: baseType,
            description: `${baseType} value for ${svc.name}`,
            invariants: [`${baseType} must contain valid, well-formed data`],
          });
        }
      }
      // Return types as value objects too
      if (parsed.returnType) {
        const baseRet = parsed.returnType.replace(/[\[\]<>,|?\s]/g, '');
        const primitives = new Set(['string', 'number', 'boolean', 'Date', 'void', 'any', 'unknown']);
        if (baseRet && !primitives.has(baseRet) && !seenVOs.has(baseRet)) {
          seenVOs.add(baseRet);
          valueObjects.push({
            name: baseRet,
            description: `Response value from ${svc.name}`,
            invariants: [`${baseRet} must satisfy the service contract schema`],
          });
        }
      }
    }

    // ── Derive domain-specific invariants from responsibility + scenario ──
    const invariants: string[] = [];

    // Extract key nouns/concepts from responsibility for invariants
    const resp = svc.responsibility.toLowerCase();
    if (resp.includes('inventory') || resp.includes('stock'))
      invariants.push(`${svcName} stock quantity must be non-negative`);
    if (resp.includes('price') || resp.includes('pricing') || resp.includes('markdown') || resp.includes('cost'))
      invariants.push(`${svcName} price must be a positive decimal value`);
    if (resp.includes('order') || resp.includes('purchase'))
      invariants.push(`${svcName} order must have at least one line item`);
    if (resp.includes('forecast') || resp.includes('demand') || resp.includes('predict'))
      invariants.push(`${svcName} forecast horizon must be between 1 and 365 days`);
    if (resp.includes('auth') || resp.includes('identity') || resp.includes('credential'))
      invariants.push(`${svcName} credentials must be validated before access is granted`);
    if (resp.includes('schedul') || resp.includes('workflow') || resp.includes('orchestrat'))
      invariants.push(`${svcName} workflow transitions must follow the defined state machine`);
    if (resp.includes('notification') || resp.includes('alert') || resp.includes('event'))
      invariants.push(`${svcName} events must be idempotent and include a correlation ID`);
    if (resp.includes('integrat') || resp.includes('connect') || resp.includes('sync'))
      invariants.push(`${svcName} integration payloads must conform to the upstream contract schema`);
    if (resp.includes('report') || resp.includes('analytic') || resp.includes('dashboard') || resp.includes('metric'))
      invariants.push(`${svcName} report data must reference a valid time range`);
    if (resp.includes('user') || resp.includes('employee') || resp.includes('staff'))
      invariants.push(`${svcName} user records must have a unique identifier`);
    if (resp.includes('store') || resp.includes('location') || resp.includes('site'))
      invariants.push(`${svcName} location must have a valid geographic identifier`);
    if (resp.includes('config') || resp.includes('setting') || resp.includes('parameter'))
      invariants.push(`${svcName} configuration changes must be versioned`);

    // Always include a data-integrity invariant derived from the responsibility
    invariants.push(`${svcName} aggregate state must be internally consistent after every command`);

    // If we still have few invariants, add one from dependency contracts
    if (invariants.length < 3 && svc.dependencies.length > 0) {
      invariants.push(`${svcName} must validate responses from ${svc.dependencies.slice(0, 2).join(', ')} before updating state`);
    }

    // Aggregate from service — with typed entity and derived value objects
    const rootEntity: Phase2Entity = {
      name: svcName,
      description: svc.responsibility,
    };

    // Add sub-entities for non-trivial API surfaces (>3 methods = likely has sub-entities)
    const subEntities: Phase2Entity[] = [];
    if (svc.api.length > 3) {
      // Group API methods by prefix to discover implicit sub-entities
      const prefixCounts = new Map<string, number>();
      for (const api of svc.api) {
        const parsed = parseApiSignature(api);
        if (!parsed) continue;
        // Extract the domain noun from method name (e.g., "updateItem" -> "Item")
        const noun = parsed.methodName.replace(/^(get|set|update|create|delete|remove|add|find|list|fetch|submit|cancel|approve|reject)/i, '');
        if (noun && noun !== svcName && noun.length > 2) {
          prefixCounts.set(noun, (prefixCounts.get(noun) ?? 0) + 1);
        }
      }
      for (const [noun] of prefixCounts) {
        subEntities.push({
          name: noun,
          description: `${noun} managed by ${svc.name}`,
        });
      }
    }

    const aggregate: Phase2AggregateDefinition = {
      name: `${svcName}Aggregate`,
      root: svcName,
      entities: [rootEntity, ...subEntities],
      valueObjects,
      invariants,
    };

    // Commands from non-GET APIs — with parsed inputs and meaningful preconditions
    const commands: Phase2Command[] = svc.api
      .filter(a => !a.toLowerCase().startsWith('get'))
      .map(apiMethod => {
        const parsed = parseApiSignature(apiMethod);
        const inputFields = parsed?.params.map(p => `${p.name}: ${p.type}`) ?? ['requestPayload'];
        const cmdName = toCommandName(apiMethod, svcName);

        // Derive preconditions from command semantics
        const preconditions: string[] = [];
        const methodLower = apiMethod.toLowerCase();
        if (methodLower.includes('update') || methodLower.includes('modify'))
          preconditions.push(`${svcName} aggregate must exist before update`);
        else if (methodLower.includes('delete') || methodLower.includes('remove'))
          preconditions.push(`${svcName} aggregate must exist and not be in a protected state`);
        else if (methodLower.includes('create') || methodLower.includes('add'))
          preconditions.push(`No duplicate ${svcName} with the same identity may exist`);
        else if (methodLower.includes('submit') || methodLower.includes('approve'))
          preconditions.push(`${svcName} must be in a submittable/approvable state`);
        if (svc.dependencies.length > 0)
          preconditions.push(`Dependent service ${svc.dependencies[0]} must be reachable`);
        if (preconditions.length === 0)
          preconditions.push(`Caller must be authorized to invoke ${cmdName}`);

        return {
          name: cmdName,
          description: `${apiMethod} for ${svc.name}`,
          input: inputFields,
          preconditions,
          postconditions: [`${cmdName} completes and domain event is emitted`],
        };
      });

    // Queries from GET APIs — with parsed parameters and typed returns
    const queries: Phase2Query[] = svc.api
      .filter(a => a.toLowerCase().startsWith('get') || a.toLowerCase().includes('get'))
      .map(apiMethod => {
        const parsed = parseApiSignature(apiMethod);
        const params = parsed?.params.map(p => `${p.name}: ${p.type}`) ?? ['filters'];
        const returnType = parsed?.returnType ?? `${svcName}Response`;
        return {
          name: toQueryName(apiMethod, svcName),
          description: `${apiMethod} for ${svc.name}`,
          parameters: params,
          returns: returnType,
        };
      });

    // Domain events from commands
    const domainEvents: Phase2DomainEvent[] = commands.flatMap(cmd => [
      {
        name: `${cmd.name}Succeeded`,
        description: `Emitted when ${cmd.name} completes successfully`,
        payload: ['result'],
        triggeredBy: cmd.name,
      },
      {
        name: `${cmd.name}Failed`,
        description: `Emitted when ${cmd.name} fails`,
        payload: ['error'],
        triggeredBy: cmd.name,
      },
    ]);

    // Add to glossary
    glossary.push({
      term: svcName,
      definition: svc.responsibility,
      context: contextName,
      aliases: [svc.name, contextName].filter((v, i, a) => a.indexOf(v) === i),
    });

    // ADR refs — match against both the original raw name and normalized name
    const adrRefs = adrs
      .filter(a => {
        const lower = a.title.toLowerCase() + ' ' + a.context.toLowerCase();
        return lower.includes(svc.name.toLowerCase()) || lower.includes(contextName.toLowerCase());
      })
      .map(a => a.id);

    return {
      name: contextName,
      description: svc.responsibility,
      aggregates: [aggregate],
      domainEvents,
      commands,
      queries,
      ubiquitousLanguage: [],
      adrRefs,
      subdomain: classifySubdomain(contextName, svc.responsibility),
    };
  });

  // Build context map using domain-semantic relationship inference
  const contextMap = buildContextMap(contexts, deduplicatedServices, normalizedNameMap);

  // Add dossier-derived glossary terms
  const dossierTerms = new Set<string>();
  for (const item of dossier.items) {
    if (item.category === 'requirement' || item.category === 'recommendation') {
      // Extract key term from title
      const term = item.title.split(/[:\-–]/)[0]?.trim();
      if (term && term.length > 2 && term.length < 40 && !dossierTerms.has(term.toLowerCase())) {
        dossierTerms.add(term.toLowerCase());
        glossary.push({
          term,
          definition: item.content.slice(0, 120),
          context: item.source,
          aliases: [],
        });
      }
    }
  }

  return {
    contexts,
    contextMap,
    ubiquitousLanguageGlossary: glossary,
    scenarioQuery,
  };
}

// ============================================================================
// Public: Main Stage Function
// ============================================================================

export async function generateDDDModel(
  context: Phase2Context,
): Promise<Phase2StageOutput> {
  const rootSpan = createSpan('ddd-generation', 'generate-ddd-model', {
    phase2Dir: context.phase2Dir,
  });

  try {
    // Retrieve prerequisites
    const sparcOutput = context.stageOutputs.get('sparc-specification');
    if (!sparcOutput || sparcOutput.status !== 'completed') {
      throw new Error('ECLI-P2-010: Missing prerequisite: sparc-specification must complete before ddd-generation');
    }

    const adrOutput = context.stageOutputs.get('adr-generation');
    if (!adrOutput || adrOutput.status !== 'completed') {
      throw new Error('ECLI-P2-010: Missing prerequisite: adr-generation must complete before ddd-generation');
    }

    const dossierOutput = context.stageOutputs.get('research-dossier');
    if (!dossierOutput || dossierOutput.status !== 'completed') {
      throw new Error('ECLI-P2-010: Missing prerequisite: research-dossier must complete before ddd-generation');
    }

    const sparc = sparcOutput.data as Phase2SPARCOutput;
    const adrs = (adrOutput.data as { adrs: Phase2ADRRecord[] }).adrs ?? (adrOutput.data as Phase2ADRRecord[]);
    const dossier = dossierOutput.data as ResearchDossier;

    // Build domain model — include the full scenario query for Ruflo swarm extraction
    const query = context.phase1Artifacts?.scenario?.query
      ?? context.phase1Artifacts?.manifest?.query
      ?? '';
    const domainModel = buildPhase2DDD(sparc, Array.isArray(adrs) ? adrs : [], dossier, query);

    // Generate markdown
    const dddMarkdown = writeDDDMarkdown(domainModel, sparc);

    // Write artifacts
    const dddDir = path.join(context.phase2Dir, 'ddd');
    const contextsDir = path.join(dddDir, 'contexts');
    fs.mkdirSync(dddDir, { recursive: true, mode: DIR_MODE });
    fs.mkdirSync(contextsDir, { recursive: true, mode: DIR_MODE });

    const artifactPaths: string[] = [];

    // Primary: DDD markdown
    const mdPath = path.join(dddDir, 'DDD-Model.md');
    fs.writeFileSync(mdPath, dddMarkdown + '\n', { encoding: 'utf-8', mode: FILE_MODE });
    artifactPaths.push(mdPath);

    // JSON compat files
    const domainModelPath = path.join(dddDir, 'domain-model.json');
    fs.writeFileSync(domainModelPath, JSON.stringify(domainModel, null, JSON_INDENT), { encoding: 'utf-8', mode: FILE_MODE });
    artifactPaths.push(domainModelPath);

    const contextMapPath = path.join(dddDir, 'context-map.json');
    fs.writeFileSync(contextMapPath, JSON.stringify(domainModel.contextMap, null, JSON_INDENT), { encoding: 'utf-8', mode: FILE_MODE });
    artifactPaths.push(contextMapPath);

    const glossaryPath = path.join(dddDir, 'ubiquitous-language.json');
    fs.writeFileSync(glossaryPath, JSON.stringify(domainModel.ubiquitousLanguageGlossary, null, JSON_INDENT), { encoding: 'utf-8', mode: FILE_MODE });
    artifactPaths.push(glossaryPath);

    // Per-context files
    for (const ctx of domainModel.contexts) {
      const contextSlug = slugify(ctx.name);
      const contextPath = path.join(contextsDir, `${contextSlug}.json`);
      fs.writeFileSync(contextPath, JSON.stringify(ctx, null, JSON_INDENT), { encoding: 'utf-8', mode: FILE_MODE });
      artifactPaths.push(contextPath);
    }

    endSpan(rootSpan, 'ok', {
      contextsGenerated: domainModel.contexts.length,
      relationsGenerated: domainModel.contextMap.length,
      glossaryTerms: domainModel.ubiquitousLanguageGlossary.length,
    });
    emitSpan(rootSpan);

    const timing = rootSpan.durationMs ?? 0;

    const output: Phase2StageOutput = {
      stage: 'ddd-generation',
      status: 'completed',
      data: domainModel,
      artifacts: artifactPaths,
      timing,
      summary: `     DDD: ${domainModel.contexts.length} bounded contexts, ${domainModel.contextMap.length} relations, ${domainModel.ubiquitousLanguageGlossary.length} glossary terms`,
    };

    context.stageOutputs.set('ddd-generation', output);
    return output;
  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : String(err);

    endSpan(rootSpan, 'error', { error: errorMessage });
    emitSpan(rootSpan);

    const timing = rootSpan.durationMs ?? 0;

    const output: Phase2StageOutput = {
      stage: 'ddd-generation',
      status: 'failed',
      data: { error: errorMessage },
      artifacts: [],
      timing,
      summary: `DDD generation failed: ${errorMessage}`,
    };

    context.stageOutputs.set('ddd-generation', output);
    return output;
  }
}
