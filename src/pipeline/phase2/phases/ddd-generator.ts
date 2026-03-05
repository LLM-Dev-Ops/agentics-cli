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
  // Inventory / stock
  [/\b(?:inventory|stock|warehouse|reorder|stockout)\b/i, 'inventory-optimization'],
  // Demand / forecasting
  [/\b(?:demand|forecast|predict|trend|seasonal)\b/i, 'demand-forecasting'],
  // Supply chain / coordination
  [/\b(?:supply[\s-]?chain|coordination|orchestrat|upstream|downstream)\b/i, 'supply-chain-coordination'],
  // Supply risk / imbalance / shortage
  [/\b(?:supply[\s-]?imbalance|shortage|surplus|supply[\s-]?risk|stockout|overstock)\b/i, 'supply-risk-detection'],
  // Procurement / sourcing
  [/\b(?:procurement|sourcing|purchas|vendor|supplier)\b/i, 'procurement-automation'],
  // Facility / transfer / warehouse movement
  [/\b(?:facility|transfer|warehouse[\s-]?movement|inter[\s-]?site|relocation)\b/i, 'facility-transfer'],
  // Compliance / audit
  [/\b(?:compliance|audit|regulat|inspection|certif)\b/i, 'compliance-auditing'],
  // Distribution / logistics / shipping
  [/\b(?:distribution|logistics|shipping|transport|delivery|route)\b/i, 'distribution-logistics'],
  // Quality
  [/\b(?:quality|defect|qa|inspection)\b/i, 'quality-assurance'],
  // Analytics / reporting / dashboard
  [/\b(?:analytics|dashboard|report|metric|kpi|visualization)\b/i, 'analytics-reporting'],
  // Order management
  [/\b(?:order|fulfillment|sales[\s-]?order|purchase[\s-]?order)\b/i, 'order-management'],
  // Customer / CRM
  [/\b(?:customer|crm|client|account[\s-]?management)\b/i, 'customer-management'],
  // Finance / billing
  [/\b(?:finance|billing|invoice|payment|accounting)\b/i, 'financial-ops'],
  // Production / manufacturing
  [/\b(?:production|manufactur|assembly|plant)\b/i, 'production-management'],
  // Monitoring / alerting
  [/\b(?:monitor|real[\s-]?time|alert|notification)\b/i, 'monitoring-alerts'],
  // Security / access
  [/\b(?:security|auth|access[\s-]?control|rbac|iam)\b/i, 'security-access'],
  // Asset / maintenance
  [/\b(?:maintenance|asset|equipment)\b/i, 'asset-maintenance'],
  // HR / workforce
  [/\b(?:hr|employee|workforce|personnel|talent)\b/i, 'workforce-management'],
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
  [/\b(?:integration|adapter|connector|gateway|infrastructure)\b/i, 'generic'],
  [/\b(?:netsuite|oracle|sap|azure|aws|gcp|salesforce|servicenow|dynamics|workday)\b/i, 'generic'],
  [/\b(?:analytics|reporting|dashboard|monitoring|alerts?)\b/i, 'generic'],
  // Supporting: important but not the core differentiator
  [/\b(?:procurement|compliance|audit|quality|assurance)\b/i, 'supporting'],
  [/\b(?:facility|transfer|distribution|logistics)\b/i, 'supporting'],
  [/\b(?:security|access|auth|workforce|hr)\b/i, 'supporting'],
  // Core: primary domain logic that differentiates the system
  [/\b(?:inventory|stock|warehouse)\b/i, 'core'],
  [/\b(?:demand|forecast|predict)\b/i, 'core'],
  [/\b(?:supply[\s-]?risk|risk[\s-]?detect|imbalance|shortage)\b/i, 'core'],
  [/\b(?:supply[\s-]?chain|coordination|orchestrat)\b/i, 'core'],
  [/\b(?:order[\s-]?management|fulfillment)\b/i, 'core'],
  [/\b(?:production|manufactur)\b/i, 'core'],
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
 */
function toCommandName(apiMethod: string, contextName: string): string {
  // Strip leading HTTP method (POST, PUT, PATCH, DELETE)
  const withoutMethod = apiMethod.replace(/^\s*(POST|PUT|PATCH|DELETE)\s+/i, '');
  // Extract the last path segment (the action: "create-vendor", "update-payment")
  const segments = withoutMethod.split('/').filter(Boolean);
  const action = segments[segments.length - 1] ?? '';
  const cleaned = action.replace(/[^a-zA-Z0-9-]/g, '');
  if (!cleaned) return `Execute${contextName}`;
  return pascalCase(cleaned);
}

/**
 * Convert an API string like "GET /vendor" or "GET /vendor:id" into a
 * domain query name like "GetVendor" or "GetVendorById".
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

    // Aggregate from service
    const rootEntity: Phase2Entity = {
      name: svcName,
      description: svc.responsibility,
    };

    const aggregate: Phase2AggregateDefinition = {
      name: `${svcName}Aggregate`,
      root: svcName,
      entities: [rootEntity],
      valueObjects: [],
      invariants: [`${svcName} must be in a valid state`],
    };

    // Commands from non-GET APIs
    const commands: Phase2Command[] = svc.api
      .filter(a => !a.toLowerCase().startsWith('get'))
      .map(apiMethod => ({
        name: toCommandName(apiMethod, svcName),
        description: `${apiMethod} for ${svc.name}`,
        input: ['requestPayload'],
        preconditions: [`${svc.name} is accessible`],
        postconditions: [`${toCommandName(apiMethod, svcName)} completes successfully`],
      }));

    // Queries from GET APIs
    const queries: Phase2Query[] = svc.api
      .filter(a => a.toLowerCase().startsWith('get') || a.toLowerCase().includes('get'))
      .map(apiMethod => ({
        name: toQueryName(apiMethod, svcName),
        description: `${apiMethod} for ${svc.name}`,
        parameters: ['filters'],
        returns: `${svcName}Response`,
      }));

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

    // Build domain model
    const domainModel = buildPhase2DDD(sparc, Array.isArray(adrs) ? adrs : [], dossier);

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
