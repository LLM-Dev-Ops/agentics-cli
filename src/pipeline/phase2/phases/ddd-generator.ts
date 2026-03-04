/**
 * Phase 2 Pipeline — Stage 5: DDD Model Generator
 *
 * Generates a Domain-Driven Design model from the SPARC architecture output
 * and research dossier. Produces bounded contexts (one per architecture
 * service), a context map of inter-service relationships, and a project-wide
 * ubiquitous language glossary.
 *
 * All domain model elements are derived from actual dossier content:
 *   - Entities from dossier item nouns mapped to each service
 *   - Value Objects from constraint/success-criterion dossier items
 *   - Commands from non-GET API methods + requirement dossier items
 *   - Queries from GET API methods + success-criterion dossier items
 *   - Domain Events from commands (success/failure) + timeline milestones
 *   - Ubiquitous Language from all generated element names + dossier titles
 *
 * No hardcoded caps on any element count. Output volume scales with dossier
 * richness and service complexity.
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
  Phase2ServiceDefinition,
  Phase2PseudocodeModule,
  DossierItem,
} from '../types.js';
import { createSpan, endSpan, emitSpan } from '../telemetry.js';

// ============================================================================
// Constants
// ============================================================================

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const JSON_INDENT = 2;

/**
 * Common English stop words that should be excluded when extracting nouns
 * from dossier text. Only words longer than 3 characters are listed here
 * since the extractNouns function already filters by length > 3.
 */
const STOP_WORDS = new Set([
  // pronouns, articles, prepositions
  'with', 'from', 'that', 'this', 'have', 'been', 'will', 'each',
  'which', 'their', 'through', 'between', 'about', 'would', 'there',
  'these', 'other', 'into', 'more', 'some', 'than', 'them', 'then',
  'what', 'when', 'where', 'also', 'after', 'before', 'such', 'only',
  'over', 'very', 'just', 'like', 'being', 'most', 'both', 'does',
  'here', 'much', 'many', 'well', 'back', 'even', 'still', 'must',
  'should', 'could', 'shall', 'might', 'need', 'able', 'keep',
  'make', 'made', 'ensure', 'using', 'used', 'based', 'within',
  'along', 'during', 'upon', 'across', 'under', 'above', 'below',
  'while', 'same', 'different', 'first', 'last', 'next', 'high',
  'include', 'including', 'provide', 'provided', 'support', 'define',
  'defined', 'required', 'specific', 'given', 'following', 'allows',
  // common verbs that appear in dossier text and should NOT become entities
  'ensuring', 'without', 'clearly', 'involves', 'proceed', 'addressed',
  'address', 'identify', 'identified', 'determining', 'determine',
  'establish', 'established', 'evaluate', 'evaluated', 'executing',
  'execute', 'managing', 'manage', 'maintain', 'maintained', 'consider',
  'considered', 'recommend', 'recommended', 'propose', 'proposed',
  'implement', 'implemented', 'achieve', 'achieved', 'approach',
  'approaches', 'applies', 'apply', 'applied', 'available', 'involves',
  'involved', 'involving', 'requires', 'require', 'describes',
  'described', 'affects', 'affect', 'affecting', 'allows', 'allowed',
  'contains', 'contain', 'contained', 'suggests', 'suggest', 'suggested',
  'indicates', 'indicate', 'indicated', 'result', 'results', 'resulting',
  // common adjectives/adverbs
  'overall', 'total', 'full', 'significant', 'potential', 'possible',
  'existing', 'current', 'additional', 'various', 'multiple', 'several',
  'expected', 'critical', 'important', 'ongoing', 'relevant', 'detailed',
  'comprehensive', 'appropriate', 'initial', 'final', 'certain', 'clear',
  'early', 'enough', 'already', 'often', 'typically', 'primarily',
  // generic business terms that don't make good entity names
  'complexity', 'challenges', 'constraints', 'factors', 'aspects',
  'elements', 'components', 'requirements', 'processes', 'activities',
  'operations', 'concerns', 'exposure', 'uncertainty', 'unproven',
  'experimental', 'dedicated', 'specialized', 'assessment', 'analysis',
  'approach', 'strategy', 'initiative', 'effort', 'execution',
  'information', 'environment', 'infrastructure', 'mechanism',
  'procedure', 'procedures', 'practice', 'methodology', 'framework', 'structure',
  // more verbs/adjectives that appear in dossier risk/recommendation text
  'increase', 'decrease', 'probability', 'unforeseen', 'technical',
  'validated', 'throughout', 'migration', 'process', 'prevent',
  'introduce', 'dependencies', 'dependency', 'proper', 'rollback',
  'loss', 'extend', 'timelines', 'expertise', 'integrity',
  'data', 'testing', 'phase', 'milestone', 'criteria', 'defined',
  'trigger', 'triggers', 'window', 'duration', 'scope', 'impact',
  'feasibility', 'readiness', 'availability', 'progress', 'outline',
  'candidate', 'representative', 'subset', 'confirm', 'confirmed',
  'cadence', 'reporting', 'guidance', 'begins', 'begin', 'obtain',
  'assemble', 'schedule', 'kickoff', 'governance', 'approval',
  'stakeholder', 'resource', 'resources', 'success', 'metrics',
  'acceptance', 'mapping', 'cutover', 'downtime', 'defines',
]);

/**
 * Query-style keywords that indicate a dossier success-criterion item
 * implies a read/reporting need.
 */
const QUERY_KEYWORDS = [
  'report', 'query', 'retrieve', 'show', 'display', 'list',
  'monitor', 'check', 'view', 'dashboard', 'status', 'summary',
  'overview', 'audit', 'inspect', 'track',
];

// ============================================================================
// String Helpers
// ============================================================================

/**
 * Convert a kebab-case, snake_case, or space-separated string to PascalCase.
 *
 * @example pascalCase('api-gateway')   // 'ApiGateway'
 * @example pascalCase('user_service')  // 'UserService'
 * @example pascalCase('hello world')   // 'HelloWorld'
 */
export function pascalCase(text: string): string {
  return text
    .split(/[-_\s]+/)
    .filter((segment) => segment.length > 0)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1).toLowerCase())
    .join('');
}

/**
 * Convert a PascalCase, camelCase, or space-separated string to a URL-safe
 * lowercase slug.
 *
 * @example slugify('Api Gateway')    // 'api-gateway'
 * @example slugify('ApiGateway')     // 'api-gateway'
 * @example slugify('hello world!')   // 'hello-world'
 */
export function slugify(text: string): string {
  return text
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
}

// ============================================================================
// Text Analysis Helpers
// ============================================================================

/**
 * Extract significant nouns from a text string.
 *
 * Selects words longer than 3 characters that are not common stop words.
 * Returns deduplicated results in the order they first appear.
 */
export function extractNouns(text: string): string[] {
  const words = text.split(/[^a-zA-Z]+/).filter((w) => w.length > 3);
  const seen = new Set<string>();
  const nouns: string[] = [];

  for (const word of words) {
    const lower = word.toLowerCase();
    if (STOP_WORDS.has(lower)) continue;
    if (seen.has(lower)) continue;
    seen.add(lower);
    nouns.push(word);
  }

  return nouns;
}

/**
 * Check whether a text string mentions words from a service's name or
 * responsibility description. Used to match dossier items to services.
 */
export function matchesServiceKeywords(
  text: string,
  service: Phase2ServiceDefinition,
): boolean {
  const textLower = text.toLowerCase();
  // Extract keywords from service name (split on separators)
  const nameKeywords = service.name
    .split(/[-_\s]+/)
    .filter((w) => w.length > 2)
    .map((w) => w.toLowerCase());
  // Extract keywords from responsibility
  const responsibilityKeywords = extractNouns(service.responsibility)
    .map((w) => w.toLowerCase());

  const allKeywords = [...nameKeywords, ...responsibilityKeywords];
  // Match if at least one meaningful keyword appears in the text
  return allKeywords.some((kw) => textLower.includes(kw));
}

/**
 * Split text into sentences. Handles period, exclamation, and question
 * delimiters. Filters out empty results.
 */
function splitSentences(text: string): string[] {
  return text
    .split(/[.!?]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

// ============================================================================
// SPARC API Signature Parsing
// ============================================================================

/**
 * A parsed typed method signature from a SPARC architecture service API.
 */
interface ParsedApiMethod {
  readonly methodName: string;
  readonly params: ReadonlyArray<{ name: string; type: string }>;
  readonly returnType: string | null;
}

/**
 * Primitive/generic types that should NOT become domain entities or VOs.
 */
const PRIMITIVE_TYPES = new Set([
  'string', 'number', 'boolean', 'void', 'any', 'unknown', 'null',
  'undefined', 'object', 'never', 'bigint', 'symbol',
  'String', 'Number', 'Boolean', 'Object',
  'Promise', 'Array', 'Map', 'Set', 'Record', 'Partial', 'Required',
  'Readonly', 'Pick', 'Omit',
]);

/**
 * Parse a typed API method signature into structured parts.
 *
 * Handles signatures like:
 *   "ingestDocument(source: DocumentSource): IngestionResult"
 *   "validateFormat(payload: RawPayload): FormatValidation"
 *   "emitAlert(alert: DriftAlert): void"
 *
 * Returns null for REST-style routes like "POST /api/v1/documents/ingest"
 * or plain method names without typed signatures.
 */
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

/**
 * Extract the base type name from a potentially decorated type string.
 * Handles: "PolicyRule[]" -> "PolicyRule", "Array<DriftAlert>" -> "DriftAlert",
 * "Promise<ERPResponse>" -> "ERPResponse", "string | null" -> ["string", "null"]
 */
function extractBaseTypes(typeStr: string): string[] {
  // Handle union types
  const unionParts = typeStr.split('|').map((s) => s.trim());
  const results: string[] = [];

  for (const part of unionParts) {
    // Strip array suffix
    let cleaned = part.replace(/\[\]$/, '');
    // Strip generic wrapper: Array<X>, Promise<X>, ReadonlyArray<X>, etc.
    const genericMatch = cleaned.match(/^\w+<(.+)>$/);
    if (genericMatch) {
      cleaned = genericMatch[1]!;
    }
    cleaned = cleaned.trim();
    if (cleaned.length > 0) {
      results.push(cleaned);
    }
  }

  return results;
}

/**
 * Check whether a type name is a meaningful domain type (not a primitive).
 */
function isDomainType(typeName: string): boolean {
  return !PRIMITIVE_TYPES.has(typeName) && typeName.length > 1;
}

/**
 * Extract all domain types (entities + value objects) from a service's
 * typed API method signatures. Returns deduplicated type names.
 */
function extractDomainTypesFromApi(service: Phase2ServiceDefinition): {
  allTypes: string[];
  paramTypes: string[];
  returnTypes: string[];
  parsedMethods: ParsedApiMethod[];
} {
  const allTypes = new Set<string>();
  const paramTypes = new Set<string>();
  const returnTypes = new Set<string>();
  const parsedMethods: ParsedApiMethod[] = [];

  for (const apiEntry of service.api) {
    const parsed = parseApiSignature(apiEntry);
    if (!parsed) continue;
    parsedMethods.push(parsed);

    // Collect parameter types
    for (const param of parsed.params) {
      for (const baseType of extractBaseTypes(param.type)) {
        if (isDomainType(baseType)) {
          allTypes.add(baseType);
          paramTypes.add(baseType);
        }
      }
    }

    // Collect return types
    if (parsed.returnType) {
      for (const baseType of extractBaseTypes(parsed.returnType)) {
        if (isDomainType(baseType)) {
          allTypes.add(baseType);
          returnTypes.add(baseType);
        }
      }
    }
  }

  return {
    allTypes: [...allTypes],
    paramTypes: [...paramTypes],
    returnTypes: [...returnTypes],
    parsedMethods,
  };
}

// ============================================================================
// Pseudocode Data Structure Extraction
// ============================================================================

/**
 * Extract just the type name from a pseudocode data structure definition.
 * Handles entries like "InvoicePayload { invoiceId: string; ... }" → "InvoicePayload"
 * and plain names like "InvoicePayload" → "InvoicePayload".
 */
function extractTypeName(dsEntry: string): string {
  // Take only the first word (the type name), before any { or whitespace-then-{
  const match = dsEntry.match(/^(\w+)/);
  return match ? match[1]! : dsEntry.trim();
}

/**
 * Find pseudocode modules whose dossierItemRefs overlap with this service's
 * dossierItemRefs, or whose name closely matches the service name.
 * Returns the union of their dataStructures type names (deduplicated).
 *
 * Uses strict matching: requires at least 2 dossierItemRef overlaps, or
 * a strong name match (50%+ of service keywords found in module name).
 */
function getPseudocodeTypesForService(
  pseudocodeModules: readonly Phase2PseudocodeModule[],
  service: Phase2ServiceDefinition,
): string[] {
  const serviceRefs = new Set(service.dossierItemRefs ?? []);
  const serviceNameLower = service.name.toLowerCase();
  const serviceKeywords = serviceNameLower.split(/[-_\s]+/).filter((w) => w.length > 2);
  const types = new Set<string>();

  for (const mod of pseudocodeModules) {
    const moduleRefs = new Set(mod.dossierItemRefs ?? []);
    // Count overlapping refs — require at least 2 for a match
    const refOverlapCount = [...serviceRefs].filter((ref) => moduleRefs.has(ref)).length;
    const hasStrongRefOverlap = refOverlapCount >= 2;

    // Name match: require 50%+ of service keywords to match
    const moduleNameLower = mod.name.toLowerCase();
    const matchCount = serviceKeywords.filter((kw) => moduleNameLower.includes(kw)).length;
    const hasStrongNameMatch = serviceKeywords.length > 0 && matchCount >= Math.ceil(serviceKeywords.length * 0.5);

    if (hasStrongRefOverlap || hasStrongNameMatch) {
      for (const ds of mod.dataStructures) {
        const typeName = extractTypeName(ds);
        if (isDomainType(typeName)) {
          types.add(typeName);
        }
      }
    }
  }

  return [...types];
}

// ============================================================================
// Value Object Classification Heuristics
// ============================================================================

/**
 * Suffixes/patterns that indicate a type is a value object rather than an entity.
 * Entities are long-lived with identity; VOs are immutable data carriers.
 */
const VO_SUFFIXES = [
  'Config', 'Configuration', 'Settings', 'Options', 'Payload',
  'Request', 'Response', 'Result', 'Report', 'Score', 'Rule',
  'Criteria', 'Validation', 'Detection', 'Alert', 'Snapshot',
  'Stats', 'Metadata', 'Schema', 'Token', 'Credential',
];

/**
 * Classify a domain type as entity vs value object based on naming heuristics.
 * Returns true if the type is likely a value object.
 */
function isLikelyValueObject(typeName: string): boolean {
  return VO_SUFFIXES.some((suffix) => typeName.endsWith(suffix));
}

/**
 * Extract verb + object from a short title or phrase, returning a
 * PascalCase command name. Falls back to PascalCase of the full title
 * if parsing produces nothing useful.
 */
function commandNameFromTitle(title: string): string {
  const nouns = extractNouns(title);
  const words = title.split(/\s+/);
  // Try to find a verb-like word at the beginning
  const verbCandidates = ['create', 'update', 'delete', 'process', 'validate',
    'configure', 'initialize', 'execute', 'submit', 'approve', 'assign',
    'deploy', 'register', 'transform', 'import', 'export', 'sync',
    'migrate', 'publish', 'schedule', 'trigger', 'enable', 'disable'];
  const firstWord = words[0]?.toLowerCase() ?? '';
  const hasVerb = verbCandidates.includes(firstWord);

  if (hasVerb && nouns.length > 0) {
    return pascalCase(firstWord + ' ' + (nouns[0] ?? ''));
  }
  if (nouns.length >= 2) {
    return pascalCase((nouns[0] ?? '') + ' ' + (nouns[1] ?? ''));
  }
  if (nouns.length === 1) {
    return `Process${pascalCase(nouns[0] ?? '')}`;
  }
  // Fallback: PascalCase the first 3 words
  return pascalCase(words.slice(0, 3).join(' '));
}

// ============================================================================
// Dossier Item Lookup Helpers
// ============================================================================

/**
 * Get all dossier items that are directly referenced by a service via
 * its dossierItemRefs, or that textually match the service's keywords.
 */
function getDossierItemsForService(
  service: Phase2ServiceDefinition,
  dossier: ResearchDossier,
): DossierItem[] {
  const refSet = new Set(service.dossierItemRefs ?? []);
  const matched: DossierItem[] = [];
  const seenIds = new Set<string>();

  // First: items explicitly referenced
  for (const item of dossier.items) {
    if (refSet.has(item.id) && !seenIds.has(item.id)) {
      seenIds.add(item.id);
      matched.push(item);
    }
  }

  // Second: items matching service keywords (but not already included)
  for (const item of dossier.items) {
    if (seenIds.has(item.id)) continue;
    if (matchesServiceKeywords(item.title, service) ||
        matchesServiceKeywords(item.content, service)) {
      seenIds.add(item.id);
      matched.push(item);
    }
  }

  return matched;
}

/**
 * Filter dossier items by category.
 */
function filterByCategory(
  items: readonly DossierItem[],
  category: DossierItem['category'],
): DossierItem[] {
  return items.filter((item) => item.category === category);
}

// ============================================================================
// Entity Derivation
// ============================================================================

/**
 * Derive entities from SPARC architecture API signatures and pseudocode
 * data structures. Uses a 3-tier priority system:
 *
 *   Tier 1: Domain types extracted from typed API method signatures
 *           (return types and non-VO parameter types)
 *   Tier 2: Data structures from matching pseudocode modules
 *   Tier 3: Dossier noun extraction (fallback only)
 *
 * Types classified as value objects (ending in Config, Result, etc.) are
 * excluded here — they are handled by deriveValueObjects() instead.
 */
function deriveEntities(
  service: Phase2ServiceDefinition,
  serviceItems: readonly DossierItem[],
  contextName: string,
  pseudocodeModules: readonly Phase2PseudocodeModule[],
): Phase2Entity[] {
  const seen = new Set<string>();
  const entities: Phase2Entity[] = [];

  function addEntity(name: string, description: string): void {
    if (seen.has(name)) return;
    seen.add(name);
    entities.push({ name, description });
  }

  // --- Tier 1: Domain types from SPARC API method signatures ---
  const { allTypes } = extractDomainTypesFromApi(service);
  for (const typeName of allTypes) {
    // Entities are types that are NOT value objects (not ending in Result, Config, etc.)
    if (!isLikelyValueObject(typeName)) {
      addEntity(
        typeName,
        `Domain entity from ${service.name} API within the ${contextName} bounded context`,
      );
    }
  }

  // --- Tier 2: Data structures from pseudocode modules ---
  const pseudocodeTypes = getPseudocodeTypesForService(pseudocodeModules, service);
  for (const typeName of pseudocodeTypes) {
    if (!isLikelyValueObject(typeName)) {
      addEntity(
        typeName,
        `Domain entity from pseudocode data structures within the ${contextName} bounded context`,
      );
    }
  }

  // --- Tier 3: Fallback to dossier noun extraction (only if Tiers 1+2 yielded < 2) ---
  if (entities.length < 2) {
    for (const item of serviceItems) {
      const nouns = extractNouns(item.title);
      for (const noun of nouns) {
        const name = pascalCase(noun);
        addEntity(
          name,
          `Entity derived from dossier within the ${contextName} bounded context`,
        );
      }
    }
  }

  return entities.sort((a, b) => a.name.localeCompare(b.name));
}

// ============================================================================
// Value Object Derivation
// ============================================================================

/**
 * Derive value objects from SPARC API parameter types and pseudocode
 * data structures. Value objects are immutable data carriers without
 * identity — types ending in Config, Result, Payload, Score, etc.
 *
 * Priority:
 *   1. Types from API signatures classified as VOs
 *   2. Pseudocode data structures matching VO patterns
 *   3. Constraint dossier items (fallback for invariants)
 *
 * Invariants are derived from constraint dossier items that match
 * the service keywords.
 */
function deriveValueObjects(
  service: Phase2ServiceDefinition,
  serviceItems: readonly DossierItem[],
  pseudocodeModules: readonly Phase2PseudocodeModule[],
): Phase2ValueObject[] {
  const seen = new Set<string>();
  const valueObjects: Phase2ValueObject[] = [];

  // Collect invariants from constraint dossier items for this service
  const constraintItems = serviceItems.filter(
    (item) => item.category === 'constraint' || item.category === 'success-criterion',
  );
  const allInvariants: string[] = constraintItems
    .flatMap((item) => splitSentences(item.content))
    .filter((s) => s.length > 10);

  function addVO(name: string, description: string): void {
    if (seen.has(name)) return;
    seen.add(name);
    // Assign relevant invariants from constraints (round-robin to spread them)
    const voInvariants = allInvariants.length > 0
      ? allInvariants.slice(0, 3)
      : [`Must be valid before ${service.name} operations can proceed`];
    valueObjects.push({ name, description, invariants: voInvariants });
  }

  // --- Primary: Value object types from SPARC API signatures ---
  const { allTypes, paramTypes } = extractDomainTypesFromApi(service);
  for (const typeName of allTypes) {
    if (isLikelyValueObject(typeName)) {
      const role = paramTypes.includes(typeName) ? 'input' : 'output';
      addVO(
        typeName,
        `Value object (${role}) for the ${service.name} service API`,
      );
    }
  }

  // --- Secondary: Pseudocode data structures matching VO patterns ---
  const pseudocodeTypes = getPseudocodeTypesForService(pseudocodeModules, service);
  for (const typeName of pseudocodeTypes) {
    if (isLikelyValueObject(typeName)) {
      addVO(
        typeName,
        `Value object from pseudocode data structures for the ${service.name} service`,
      );
    }
  }

  // --- Fallback: Constraint-derived VOs (only if no typed VOs found) ---
  if (valueObjects.length === 0) {
    for (const item of constraintItems) {
      const nouns = extractNouns(item.title);
      const nameBase: string = nouns.length >= 2
        ? nouns.slice(0, 2).join(' ')
        : nouns.length === 1
          ? (nouns[0] ?? item.title)
          : item.title.split(/\s+/).slice(0, 2).join(' ');
      const voName = `${pascalCase(nameBase)}Policy`;
      const sentences = splitSentences(item.content);
      const invariants = sentences.length > 0
        ? sentences
        : [`Must satisfy: ${item.title}`];

      if (!seen.has(voName)) {
        seen.add(voName);
        valueObjects.push({
          name: voName,
          description: `Value object enforcing ${item.title.toLowerCase()} within the ${service.name} service`,
          invariants,
        });
      }
    }
  }

  // Minimum 1 VO guarantee
  if (valueObjects.length === 0) {
    const pascal = pascalCase(service.name);
    valueObjects.push({
      name: `${pascal}Configuration`,
      description: `Configuration value object for the ${service.name} service`,
      invariants: ['Must be valid before operations can proceed'],
    });
  }

  return valueObjects.sort((a, b) => a.name.localeCompare(b.name));
}

// ============================================================================
// Command Derivation
// ============================================================================

/**
 * Derive commands from:
 *   1. Non-GET API methods from the service
 *   2. Dossier items with category 'requirement' that match service keywords
 *
 * No hardcoded cap. Minimum 2 commands.
 */
function deriveCommands(
  service: Phase2ServiceDefinition,
  serviceItems: readonly DossierItem[],
  constraintItems: readonly DossierItem[],
  criterionItems: readonly DossierItem[],
): Phase2Command[] {
  const pascal = pascalCase(service.name);
  const getPattern = /^(get|find|list|query|fetch|read|check|is|has)/i;
  const commands: Phase2Command[] = [];
  const seen = new Set<string>();

  // Collect preconditions from constraint items
  const preconditionTexts = constraintItems
    .flatMap((item) => splitSentences(item.content))
    .slice(0, 5); // Limit precondition pool to keep them relevant

  // Collect postconditions from success-criterion items
  const postconditionTexts = criterionItems
    .flatMap((item) => splitSentences(item.content))
    .slice(0, 5);

  // 1. Commands from non-GET API methods (with typed parameter extraction)
  for (const method of service.api) {
    const parsed = parseApiSignature(method);
    const methodName = parsed ? parsed.methodName : method.replace(/\(.*\)/, '').trim();
    if (getPattern.test(methodName)) continue;

    const commandName = `${pascalCase(methodName)}${pascal}`;
    if (seen.has(commandName)) continue;
    seen.add(commandName);

    // Extract typed inputs from parsed signature, or fall back to generic
    const input: string[] = parsed && parsed.params.length > 0
      ? parsed.params.map((p) => `${p.name}: ${p.type}`)
      : ['aggregateId', 'payload', 'initiatedBy'];

    commands.push({
      name: commandName,
      description: `Command to ${methodName} on the ${service.name} service`,
      input,
      preconditions: preconditionTexts.length > 0
        ? [`${pascal} aggregate must exist`, preconditionTexts[0] ?? '']
        : [`${pascal} aggregate must exist`, `Caller must have ${methodName} permission`],
      postconditions: postconditionTexts.length > 0
        ? [`${pascal} state is updated`, postconditionTexts[0] ?? '']
        : [`${pascal} state is updated`, `${commandName}Succeeded event is emitted`],
    });
  }

  // 2. Commands from requirement dossier items
  const requirementItems = filterByCategory(serviceItems, 'requirement');
  for (const item of requirementItems) {
    const commandName = commandNameFromTitle(item.title);
    if (seen.has(commandName)) continue;
    seen.add(commandName);

    const inputKeywords = extractNouns(item.content).slice(0, 4);
    const inputs = inputKeywords.length > 0
      ? ['aggregateId', ...inputKeywords.map((n) => n.charAt(0).toLowerCase() + n.slice(1))]
      : ['aggregateId', 'payload', 'initiatedBy'];

    const preconditions = preconditionTexts.length > 0
      ? preconditionTexts.slice(0, 2)
      : [`${pascal} must be in a valid state`];

    const postconditions = postconditionTexts.length > 0
      ? postconditionTexts.slice(0, 2)
      : [`${commandName}Succeeded event is emitted`];

    commands.push({
      name: commandName,
      description: `Command derived from requirement: ${item.title}`,
      input: inputs,
      preconditions,
      postconditions,
    });
  }

  // Minimum 2 commands guarantee
  if (commands.length < 2) {
    const fallbacks = [
      {
        name: `Initialize${pascal}`,
        description: `Initialize the ${service.name} aggregate`,
        input: ['config', 'initiatedBy'],
        preconditions: [`${pascal} must not already be initialized`],
        postconditions: [`${pascal} is in active state`],
      },
      {
        name: `Shutdown${pascal}`,
        description: `Gracefully shut down the ${service.name} aggregate`,
        input: ['aggregateId', 'reason'],
        preconditions: [`${pascal} must be in active state`],
        postconditions: [`${pascal} is in offline state`],
      },
    ];

    for (const fb of fallbacks) {
      if (!seen.has(fb.name) && commands.length < 2) {
        seen.add(fb.name);
        commands.push(fb);
      }
    }
  }

  return commands.sort((a, b) => a.name.localeCompare(b.name));
}

// ============================================================================
// Query Derivation
// ============================================================================

/**
 * Derive queries from:
 *   1. GET-style API methods
 *   2. Success-criterion dossier items that imply a read/reporting need
 *
 * No hardcoded cap. Minimum 1 query.
 */
function deriveQueries(
  service: Phase2ServiceDefinition,
  serviceItems: readonly DossierItem[],
): Phase2Query[] {
  const pascal = pascalCase(service.name);
  const getPattern = /^(get|find|list|query|fetch|read|check|is|has)/i;
  const queries: Phase2Query[] = [];
  const seen = new Set<string>();

  // 1. Queries from GET-style API methods (with typed parameters and return types)
  for (const method of service.api) {
    const parsed = parseApiSignature(method);
    const methodName = parsed ? parsed.methodName : method.replace(/\(.*\)/, '').trim();
    if (!getPattern.test(methodName)) continue;

    const queryName = `${pascalCase(methodName)}${pascal}`;
    if (seen.has(queryName)) continue;
    seen.add(queryName);

    // Extract typed parameters from parsed signature, or fall back to generic
    const parameters: string[] = parsed && parsed.params.length > 0
      ? parsed.params.map((p) => `${p.name}: ${p.type}`)
      : ['aggregateId', 'filters'];

    // Use actual return type from signature, or fall back to generic
    const returns: string = parsed?.returnType && isDomainType(parsed.returnType)
      ? parsed.returnType
      : `${pascal}ReadModel`;

    queries.push({
      name: queryName,
      description: `Query to ${methodName} from the ${service.name} service`,
      parameters,
      returns,
    });
  }

  // 2. Queries from success-criterion dossier items with read/reporting keywords
  const criterionItems = filterByCategory(serviceItems, 'success-criterion');
  for (const item of criterionItems) {
    const titleLower = item.title.toLowerCase();
    const contentLower = item.content.toLowerCase();
    const combined = titleLower + ' ' + contentLower;
    const matchesQuery = QUERY_KEYWORDS.some((kw) => combined.includes(kw));
    if (!matchesQuery) continue;

    const nouns = extractNouns(item.title);
    const primaryNoun = nouns[0] ?? service.name;
    const isPlural = titleLower.includes('list') || titleLower.includes('all') || titleLower.includes('multiple');
    const queryName = isPlural
      ? `List${pascalCase(primaryNoun)}`
      : `Get${pascalCase(primaryNoun)}`;

    if (seen.has(queryName)) continue;
    seen.add(queryName);

    queries.push({
      name: queryName,
      description: `Query derived from success criterion: ${item.title}`,
      parameters: ['aggregateId', 'filters'],
      returns: `${pascalCase(primaryNoun)}ReadModel`,
    });
  }

  // Minimum 1 query guarantee
  if (queries.length === 0) {
    queries.push({
      name: `Get${pascal}Status`,
      description: `Retrieve the current status of the ${service.name} aggregate`,
      parameters: ['aggregateId'],
      returns: `${pascal}StatusReadModel`,
    });
  }

  return queries.sort((a, b) => a.name.localeCompare(b.name));
}

// ============================================================================
// Domain Events
// ============================================================================

/**
 * Generate domain events derived from commands and timeline dossier items.
 *
 * For each command:
 *   - One SUCCESS event: {CommandName}Succeeded
 *   - One FAILURE event (if the command has preconditions): {CommandName}Failed
 *
 * For each timeline dossier item referencing this context:
 *   - One lifecycle event: {MilestoneName}Reached
 *
 * No hardcoded cap. Total events per context ~ commands * 1.5 to 2.
 */
function deriveDomainEvents(
  commands: readonly Phase2Command[],
  serviceItems: readonly DossierItem[],
): Phase2DomainEvent[] {
  const events: Phase2DomainEvent[] = [];
  const seen = new Set<string>();

  // Success and failure events per command
  for (const cmd of commands) {
    // SUCCESS event
    const successName = `${cmd.name}Succeeded`;
    if (!seen.has(successName)) {
      seen.add(successName);
      events.push({
        name: successName,
        description: `Emitted when ${cmd.name} completes successfully`,
        payload: [...cmd.input, 'aggregateId', 'timestamp', 'correlationId'],
        triggeredBy: cmd.name,
      });
    }

    // FAILURE event (only if the command has preconditions)
    if (cmd.preconditions.length > 0) {
      const failureName = `${cmd.name}Failed`;
      if (!seen.has(failureName)) {
        seen.add(failureName);
        events.push({
          name: failureName,
          description: `Emitted when ${cmd.name} fails due to precondition violation`,
          payload: ['aggregateId', 'timestamp', 'correlationId', 'failureReason'],
          triggeredBy: cmd.name,
        });
      }
    }
  }

  // Lifecycle events from timeline dossier items
  const timelineItems = filterByCategory(serviceItems, 'timeline');
  for (const item of timelineItems) {
    const nouns = extractNouns(item.title);
    const milestoneName = nouns.length > 0
      ? pascalCase(nouns.slice(0, 3).join(' '))
      : pascalCase(item.title.split(/\s+/).slice(0, 3).join(' '));
    const eventName = `${milestoneName}Reached`;

    if (seen.has(eventName)) continue;
    seen.add(eventName);

    // Pick the most relevant command as trigger (first command or fallback)
    const trigger = commands[0]?.name ?? 'SystemLifecycle';

    events.push({
      name: eventName,
      description: item.content.length > 120 ? item.content.slice(0, 117) + '...' : item.content,
      payload: ['aggregateId', 'timestamp', 'milestone'],
      triggeredBy: trigger,
    });
  }

  return events.sort((a, b) => a.name.localeCompare(b.name));
}

// ============================================================================
// Ubiquitous Language
// ============================================================================

/**
 * Extract ALL significant terms from entity names, VO names, command names,
 * event names, and dossier item titles referencing this context. No cap.
 *
 * Minimum 3 terms per context.
 */
function deriveUbiquitousLanguage(
  service: Phase2ServiceDefinition,
  serviceItems: readonly DossierItem[],
  contextName: string,
  entities: readonly Phase2Entity[],
  valueObjects: readonly Phase2ValueObject[],
  commands: readonly Phase2Command[],
  domainEvents: readonly Phase2DomainEvent[],
  dossier: ResearchDossier,
): UbiquitousLanguageTerm[] {
  const terms: UbiquitousLanguageTerm[] = [];
  const seen = new Set<string>();

  function addTerm(term: string, definition: string, aliases: string[] = []): void {
    if (seen.has(term)) return;
    seen.add(term);
    terms.push({ term, definition, context: contextName, aliases });
  }

  // From entity names
  for (const entity of entities) {
    addTerm(entity.name, entity.description);
  }

  // From VO names
  for (const vo of valueObjects) {
    addTerm(vo.name, vo.description);
  }

  // From command names
  for (const cmd of commands) {
    addTerm(cmd.name, cmd.description);
  }

  // From event names
  for (const evt of domainEvents) {
    addTerm(evt.name, evt.description);
  }

  // From dossier item titles referencing this context
  const aliasMap = new Map<string, string[]>();
  for (const item of serviceItems) {
    const nouns = extractNouns(item.title);
    for (const noun of nouns) {
      const termName = pascalCase(noun);
      // Track aliases: different casings/phrasings from different items
      if (seen.has(termName)) {
        const existing = aliasMap.get(termName) ?? [];
        if (!existing.includes(noun) && noun !== termName) {
          existing.push(noun);
          aliasMap.set(termName, existing);
        }
        continue;
      }

      const definition = item.content.length > 120
        ? item.content.slice(0, 117) + '...'
        : item.content;
      addTerm(termName, definition);
    }
  }

  // Also scan all dossier items for alternative phrasings (aliases)
  for (const item of dossier.items) {
    const nouns = extractNouns(item.title);
    for (const noun of nouns) {
      const termName = pascalCase(noun);
      if (seen.has(termName) && noun.toLowerCase() !== termName.toLowerCase()) {
        const existing = aliasMap.get(termName) ?? [];
        if (!existing.includes(noun)) {
          existing.push(noun);
          aliasMap.set(termName, existing);
        }
      }
    }
  }

  // Apply aliases back to terms
  for (const t of terms) {
    const aliases = aliasMap.get(t.term);
    if (aliases && aliases.length > 0) {
      // Mutate via object spread is not possible (readonly); build a new reference
      const idx = terms.indexOf(t);
      terms[idx] = { ...t, aliases: [...new Set(aliases)] };
    }
  }

  // Minimum 3 terms guarantee
  if (terms.length < 3) {
    const pascal = pascalCase(service.name);
    const fallbackTerms = [
      { term: `${pascal}Aggregate`, def: `Root aggregate for the ${contextName} bounded context` },
      { term: `${pascal}Policy`, def: `Business policy governing ${contextName} operations` },
      { term: `${pascal}Event`, def: `Domain event within the ${contextName} bounded context` },
    ];
    for (const fb of fallbackTerms) {
      if (terms.length >= 3) break;
      addTerm(fb.term, fb.def);
    }
  }

  return terms.sort((a, b) => a.term.localeCompare(b.term));
}

// ============================================================================
// ADR Reference Matching
// ============================================================================

/**
 * Find ADR IDs whose sparcSectionRefs include any ID associated with a service.
 */
function findAdrRefs(
  service: Phase2ServiceDefinition,
  adrs: readonly Phase2ADRRecord[],
): string[] {
  const serviceIds = new Set<string>([service.id, service.name]);

  return adrs
    .filter((adr) =>
      adr.sparcSectionRefs.some((ref) => serviceIds.has(ref)),
    )
    .map((adr) => adr.id);
}

// ============================================================================
// Context Map
// ============================================================================

/**
 * Determine the relationship type between two services based on naming.
 */
function classifyRelationType(
  upstreamName: string,
  downstreamName: string,
): Phase2ContextRelation['type'] {
  const downLower = downstreamName.toLowerCase();
  const upLower = upstreamName.toLowerCase();

  if (downLower.includes('integration') || downLower.includes('adapter')) {
    return 'anticorruption-layer';
  }
  if (downLower.includes('gateway') || upLower.includes('gateway')) {
    return 'open-host-service';
  }

  return 'customer-supplier';
}

/**
 * Build the context map from service dependency declarations.
 *
 * - If two services depend on each other, the relationship is a 'partnership'.
 * - If two contexts reference the same VO names, add 'shared-kernel'.
 * - If a downstream service has no dependencies of its own, add 'conformist'.
 */
function buildContextMap(
  services: readonly Phase2ServiceDefinition[],
  contextVoNames: ReadonlyMap<string, Set<string>>,
): Phase2ContextRelation[] {
  const serviceNameSet = new Set(services.map((s) => s.name));
  const relations: Phase2ContextRelation[] = [];
  const partnershipPairs = new Set<string>();
  const seenRelations = new Set<string>();

  function addRelation(rel: Phase2ContextRelation): void {
    const key = `${rel.upstream}::${rel.downstream}::${rel.type}`;
    if (seenRelations.has(key)) return;
    seenRelations.add(key);
    relations.push(rel);
  }

  // First pass: detect mutual dependencies (partnerships)
  for (const service of services) {
    for (const dep of service.dependencies) {
      if (!serviceNameSet.has(dep)) continue;
      const depService = services.find((s) => s.name === dep);
      if (depService && depService.dependencies.includes(service.name)) {
        const pairKey = [service.name, dep].sort().join('::');
        if (!partnershipPairs.has(pairKey)) {
          partnershipPairs.add(pairKey);
          addRelation({
            upstream: service.name,
            downstream: dep,
            type: 'partnership',
            description: `${service.name} and ${dep} mutually depend on each other`,
          });
        }
      }
    }
  }

  // Second pass: non-mutual dependencies
  for (const service of services) {
    for (const dep of service.dependencies) {
      if (!serviceNameSet.has(dep)) continue;

      const pairKey = [service.name, dep].sort().join('::');
      if (partnershipPairs.has(pairKey)) continue;

      const relType = classifyRelationType(dep, service.name);
      addRelation({
        upstream: dep,
        downstream: service.name,
        type: relType,
        description: `${service.name} consumes ${dep} for ${
          services.find((s) => s.name === dep)?.responsibility ?? 'its services'
        }`,
      });
    }
  }

  // Third pass: shared-kernel when two contexts reference the same VO names
  const serviceNames = services.map((s) => s.name).sort();
  for (let i = 0; i < serviceNames.length; i++) {
    const svcA = serviceNames[i];
    if (svcA === undefined) continue;
    for (let j = i + 1; j < serviceNames.length; j++) {
      const svcB = serviceNames[j];
      if (svcB === undefined) continue;
      const vosA = contextVoNames.get(svcA);
      const vosB = contextVoNames.get(svcB);
      if (!vosA || !vosB) continue;

      const shared: string[] = [];
      for (const vo of vosA) {
        if (vosB.has(vo)) shared.push(vo);
      }

      if (shared.length > 0) {
        addRelation({
          upstream: svcA,
          downstream: svcB,
          type: 'shared-kernel',
          description: `${svcA} and ${svcB} share value objects: ${shared.join(', ')}`,
        });
      }
    }
  }

  // Fourth pass: conformist when downstream has no dependencies of its own
  for (const service of services) {
    if (service.dependencies.length > 0) continue;
    // This service depends on no one; check if others depend on it
    for (const otherService of services) {
      if (otherService.name === service.name) continue;
      if (otherService.dependencies.includes(service.name)) continue;
      // Check if service is a downstream in any existing relation
      const isDownstream = relations.some(
        (r) => r.downstream === service.name && r.upstream === otherService.name,
      );
      if (isDownstream) {
        addRelation({
          upstream: otherService.name,
          downstream: service.name,
          type: 'conformist',
          description: `${service.name} conforms to ${otherService.name} without its own upstream dependencies`,
        });
      }
    }
  }

  return relations.sort((a, b) => {
    const cmp = a.upstream.localeCompare(b.upstream);
    return cmp !== 0 ? cmp : a.downstream.localeCompare(b.downstream);
  });
}

// ============================================================================
// Pure Builder (exported for testing)
// ============================================================================

/**
 * Build a complete DDD domain model from SPARC architecture output, ADRs, and
 * the research dossier. This is a pure function with no I/O side effects,
 * suitable for direct use in unit tests.
 *
 * All domain model elements are derived from actual dossier content. No
 * hardcoded caps on array lengths -- output scales with dossier richness.
 *
 * @param sparc   - The SPARC output containing architecture service definitions
 * @param adrs    - The ADR records generated from SPARC output
 * @param dossier - The research dossier compiled from Phase 1 artifacts
 * @returns A complete Phase2DomainModel
 */
export function buildPhase2DDD(
  sparc: Phase2SPARCOutput,
  adrs: Phase2ADRRecord[],
  dossier: ResearchDossier,
): Phase2DomainModel {
  const contexts: Phase2DDDBoundedContext[] = [];
  // Track VO names per service for shared-kernel detection
  const contextVoNames = new Map<string, Set<string>>();

  for (const service of sparc.architecture.services) {
    const pascal = pascalCase(service.name);
    const contextName = `${pascal}Context`;

    // Gather all dossier items relevant to this service
    const serviceItems = getDossierItemsForService(service, dossier);
    const constraintItems = filterByCategory(serviceItems, 'constraint');
    const criterionItems = filterByCategory(serviceItems, 'success-criterion');

    // --- Aggregate Root Entity ---
    const rootEntity: Phase2Entity = {
      name: `${pascal}Root`,
      description: service.responsibility,
    };

    // --- Entities (from SPARC API types + pseudocode, no cap) ---
    const pseudocodeModules = sparc.pseudocode?.modules ?? [];
    const childEntities = deriveEntities(service, serviceItems, contextName, pseudocodeModules);
    const allEntities = [rootEntity, ...childEntities.filter((e) => e.name !== rootEntity.name)];
    // Minimum 2 entities (root + at least 1 child)
    if (allEntities.length < 2) {
      allEntities.push({
        name: `${pascal}Record`,
        description: `Default entity for the ${contextName} bounded context`,
      });
    }

    // --- Value Objects (from SPARC API types + pseudocode, no cap) ---
    const valueObjects = deriveValueObjects(service, serviceItems, pseudocodeModules);

    // Track VO names for shared-kernel detection
    contextVoNames.set(service.name, new Set(valueObjects.map((vo) => vo.name)));

    // --- Aggregate invariants (dynamic, from VO invariants + responsibility) ---
    const aggregateInvariants: string[] = [];
    for (const vo of valueObjects) {
      for (const inv of vo.invariants) {
        aggregateInvariants.push(inv);
      }
    }
    const responsibilitySnippet = service.responsibility.length > 60
      ? service.responsibility.slice(0, 60)
      : service.responsibility;
    aggregateInvariants.push(
      `Must maintain consistency of ${responsibilitySnippet}`,
    );

    const aggregate: Phase2AggregateDefinition = {
      name: `${pascal}Aggregate`,
      root: rootEntity.name,
      entities: allEntities,
      valueObjects,
      invariants: aggregateInvariants,
    };

    // --- Commands (from API + requirement dossier items, no cap) ---
    const commands = deriveCommands(service, serviceItems, constraintItems, criterionItems);

    // --- Queries (from API + success-criterion dossier items, no cap) ---
    const queries = deriveQueries(service, serviceItems);

    // --- Domain Events (from commands + timeline, no fixed template) ---
    const domainEvents = deriveDomainEvents(commands, serviceItems);

    // --- Ubiquitous Language (all significant terms, no cap) ---
    const ubiquitousLanguage = deriveUbiquitousLanguage(
      service, serviceItems, contextName,
      allEntities, valueObjects, commands, domainEvents, dossier,
    );

    // --- ADR References ---
    const adrRefs = findAdrRefs(service, adrs);

    contexts.push({
      name: contextName,
      description: `Bounded context for the ${service.name} service: ${service.responsibility}`,
      aggregates: [aggregate],
      domainEvents,
      commands,
      queries,
      ubiquitousLanguage,
      adrRefs,
    });
  }

  // --- Context Map (with shared-kernel and conformist support) ---
  const contextMap = buildContextMap(sparc.architecture.services, contextVoNames);

  // --- Ubiquitous Language Glossary (project-wide, deduplicated, merged) ---
  const glossaryMap = new Map<string, UbiquitousLanguageTerm>();
  for (const ctx of contexts) {
    for (const term of ctx.ubiquitousLanguage) {
      const existing = glossaryMap.get(term.term);
      if (!existing) {
        glossaryMap.set(term.term, { ...term });
      } else {
        // Merge definitions from multiple contexts
        const mergedDef = existing.context === term.context
          ? existing.definition
          : `${existing.definition} | [${term.context}]: ${term.definition}`;
        const mergedAliases = [...new Set([...existing.aliases, ...term.aliases])];
        const mergedContext = existing.context === term.context
          ? existing.context
          : `${existing.context}, ${term.context}`;
        glossaryMap.set(term.term, {
          term: term.term,
          definition: mergedDef,
          context: mergedContext,
          aliases: mergedAliases,
        });
      }
    }
  }
  const ubiquitousLanguageGlossary = Array.from(glossaryMap.values()).sort(
    (a, b) => a.term.localeCompare(b.term),
  );

  return {
    contexts,
    contextMap,
    ubiquitousLanguageGlossary,
  };
}

// ============================================================================
// Main: generateDDDModel
// ============================================================================

/**
 * Generate a DDD model from the SPARC architecture output and research
 * dossier. Reads prerequisite stage outputs from the pipeline context,
 * builds the domain model, and writes all artifacts to disk.
 *
 * Artifacts produced:
 *   - phase2/ddd/domain-model.json       — Full Phase2DomainModel
 *   - phase2/ddd/context-map.json        — Context map array
 *   - phase2/ddd/ubiquitous-language.json — Glossary
 *   - phase2/ddd/contexts/<slug>.json     — Per-context files
 *
 * @param context - The mutable Phase 2 pipeline context
 * @returns Stage output describing success or failure
 */
export async function generateDDDModel(
  context: Phase2Context,
): Promise<Phase2StageOutput> {
  const rootSpan = createSpan('ddd-generation', 'generate-ddd-model', {
    phase2Dir: context.phase2Dir,
  });

  try {
    // ------------------------------------------------------------------
    // Retrieve prerequisite stage outputs
    // ------------------------------------------------------------------
    const sparcOutput = context.stageOutputs.get('sparc-specification');
    if (!sparcOutput || sparcOutput.status !== 'completed') {
      throw new Error(
        'ECLI-P2-010: Missing prerequisite stage output: sparc-specification must complete before ddd-generation',
      );
    }

    const adrOutput = context.stageOutputs.get('adr-generation');
    if (!adrOutput || adrOutput.status !== 'completed') {
      throw new Error(
        'ECLI-P2-010: Missing prerequisite stage output: adr-generation must complete before ddd-generation',
      );
    }

    const dossierOutput = context.stageOutputs.get('research-dossier');
    if (!dossierOutput || dossierOutput.status !== 'completed') {
      throw new Error(
        'ECLI-P2-010: Missing prerequisite stage output: research-dossier must complete before ddd-generation',
      );
    }

    const sparc = sparcOutput.data as Phase2SPARCOutput;
    const adrs = (adrOutput.data as { adrs: Phase2ADRRecord[] }).adrs ?? (adrOutput.data as Phase2ADRRecord[]);
    const dossier = dossierOutput.data as ResearchDossier;

    // ------------------------------------------------------------------
    // Build the domain model (pure computation)
    // ------------------------------------------------------------------
    const buildSpan = createSpan(
      'ddd-generation',
      'build-domain-model',
      { serviceCount: sparc.architecture.services.length },
      rootSpan.spanId,
    );

    const domainModel = buildPhase2DDD(
      sparc,
      Array.isArray(adrs) ? adrs : [],
      dossier,
    );

    endSpan(buildSpan, 'ok', {
      contextCount: domainModel.contexts.length,
      relationCount: domainModel.contextMap.length,
      glossaryTermCount: domainModel.ubiquitousLanguageGlossary.length,
    });
    emitSpan(buildSpan);

    // ------------------------------------------------------------------
    // Write artifacts to disk
    // ------------------------------------------------------------------
    const writeSpan = createSpan(
      'ddd-generation',
      'write-artifacts',
      {},
      rootSpan.spanId,
    );

    const dddDir = path.join(context.phase2Dir, 'ddd');
    const contextsDir = path.join(dddDir, 'contexts');

    fs.mkdirSync(dddDir, { recursive: true, mode: DIR_MODE });
    fs.mkdirSync(contextsDir, { recursive: true, mode: DIR_MODE });

    const artifactPaths: string[] = [];

    // domain-model.json
    const domainModelPath = path.join(dddDir, 'domain-model.json');
    fs.writeFileSync(
      domainModelPath,
      JSON.stringify(domainModel, null, JSON_INDENT),
      { encoding: 'utf-8', mode: FILE_MODE },
    );
    artifactPaths.push(domainModelPath);

    // context-map.json
    const contextMapPath = path.join(dddDir, 'context-map.json');
    fs.writeFileSync(
      contextMapPath,
      JSON.stringify(domainModel.contextMap, null, JSON_INDENT),
      { encoding: 'utf-8', mode: FILE_MODE },
    );
    artifactPaths.push(contextMapPath);

    // ubiquitous-language.json
    const glossaryPath = path.join(dddDir, 'ubiquitous-language.json');
    fs.writeFileSync(
      glossaryPath,
      JSON.stringify(domainModel.ubiquitousLanguageGlossary, null, JSON_INDENT),
      { encoding: 'utf-8', mode: FILE_MODE },
    );
    artifactPaths.push(glossaryPath);

    // Per-context files
    for (const ctx of domainModel.contexts) {
      const contextSlug = slugify(ctx.name);
      const contextPath = path.join(contextsDir, `${contextSlug}.json`);
      fs.writeFileSync(
        contextPath,
        JSON.stringify(ctx, null, JSON_INDENT),
        { encoding: 'utf-8', mode: FILE_MODE },
      );
      artifactPaths.push(contextPath);
    }

    endSpan(writeSpan, 'ok', { filesWritten: artifactPaths.length });
    emitSpan(writeSpan);

    // ------------------------------------------------------------------
    // Finalize
    // ------------------------------------------------------------------
    endSpan(rootSpan, 'ok', {
      contextsGenerated: domainModel.contexts.length,
      relationsGenerated: domainModel.contextMap.length,
      glossaryTerms: domainModel.ubiquitousLanguageGlossary.length,
      artifactsWritten: artifactPaths.length,
    });
    emitSpan(rootSpan);

    const timing = rootSpan.durationMs ?? 0;

    const output: Phase2StageOutput = {
      stage: 'ddd-generation',
      status: 'completed',
      data: domainModel,
      artifacts: artifactPaths,
      timing,
      summary: `Generated DDD model with ${domainModel.contexts.length} bounded contexts, ${domainModel.contextMap.length} relations, and ${domainModel.ubiquitousLanguageGlossary.length} glossary terms in ${timing}ms`,
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
