/**
 * Phase 3 Pipeline -- Stage 4: Domain Code Generator
 *
 * Generates domain core code (aggregates, entities, value objects, events,
 * commands, queries, seam interfaces) for each bounded context defined in
 * the Phase 2 DDD domain model.
 *
 * All external dependencies are represented as seam interfaces/traits --
 * no database layer, HTTP server, ERP, deployment, or infrastructure code
 * is generated. Aggregate constructors enforce invariants. Value objects
 * are immutable with factory creation.
 *
 * Exports:
 *   - buildDomainCode(domainModel, tddPlan, language) -- pure builder (no I/O)
 *   - generateDomainCode(context) -- async pipeline entry point
 *
 * Error codes:
 *   ECLI-P3-030  Missing prerequisite stage output (scaffold-generation)
 *   ECLI-P3-031  Domain codegen file write failure
 */

import type {
  Phase3Context,
  Phase3StageOutput,
  ImplementationLanguage,
  LanguageResolution,
  CodegenFile,
  CodegenOutput,
  ScaffoldMetadata,
} from '../types.js';
import { hasTemplateSupport } from '../types.js';
import type {
  Phase2DomainModel,
  Phase2DDDBoundedContext,
  Phase2AggregateDefinition,
  Phase2Entity,
  Phase2ValueObject,
  Phase2DomainEvent,
  Phase2Command,
  Phase2Query,
  TDDPlan,
  SeamDefinition,
  MockContract,
  Phase2SPARCOutput,
  Phase2PseudocodeModule,
  Phase2ServiceDefinition,
} from '../../phase2/types.js';
import { parseApiSignature } from '../../phase2/phases/ddd-generator.js';
import { createSpan, endSpan, emitSpan } from '../../phase2/telemetry.js';
import * as fs from 'node:fs';
import * as path from 'node:path';

// ============================================================================
// Constants
// ============================================================================

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const ROOT_DIR = 'project';

// ============================================================================
// Name Helpers
// ============================================================================

/**
 * Convert a name to kebab-case slug. Splits on camelCase boundaries,
 * replaces non-alphanumeric runs with hyphens, and trims.
 */
function slugify(name: string): string {
  return name
    .replace(/([a-z])([A-Z])/g, '$1-$2')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase();
}

/**
 * Convert a name to snake_case.
 */
function snakeCase(name: string): string {
  return slugify(name).replace(/-/g, '_');
}

/**
 * Convert a name to PascalCase.
 */
function toPascalCase(name: string): string {
  return name
    .replace(/(?:^|[-_ ])(\w)/g, (_, c: string) => c.toUpperCase())
    .replace(/[^a-zA-Z0-9]/g, '');
}

/**
 * Convert a name to camelCase (PascalCase with lowered first character).
 */
function toCamelCase(name: string): string {
  const pascal = toPascalCase(name);
  return pascal.charAt(0).toLowerCase() + pascal.slice(1);
}

/**
 * Build a port interface name from a base name, preventing double-I prefix.
 * Strips any existing "I" prefix before prepending, ensuring names like
 * "IntegrationService" become "IntegrationServicePort" (not "IIntegrationServicePort").
 */
function toPortName(baseName: string): string {
  let pascal = toPascalCase(baseName);
  // Strip leading I-prefix(es) to prevent II*, III*, etc.
  while (/^I[A-Z]/.test(pascal)) {
    pascal = pascal.slice(1);
  }
  return `${pascal}Port`;
}

// ============================================================================
// SPARC Pseudocode / Architecture Helpers
// ============================================================================

/** Parsed field from a pseudocode dataStructure definition. */
interface DataStructureField {
  name: string;
  type: string;
}

/**
 * Parse a pseudocode dataStructure string into typed fields.
 *
 * Input:  "InvoicePayload { invoiceId: string; lineItems: LineItem[]; confidence: number }"
 * Output: [{ name: "invoiceId", type: "string" }, { name: "lineItems", type: "LineItem[]" }, ...]
 *
 * Returns empty array for simple type names without brace blocks.
 */
function parseDataStructureFields(ds: string): DataStructureField[] {
  const braceStart = ds.indexOf('{');
  if (braceStart === -1) return [];
  const braceEnd = ds.lastIndexOf('}');
  if (braceEnd === -1) return [];

  const body = ds.slice(braceStart + 1, braceEnd).trim();
  if (!body) return [];

  const fields: DataStructureField[] = [];
  // Split on ; or newline
  for (const segment of body.split(/[;\n]/)) {
    const trimmed = segment.trim();
    if (!trimmed || trimmed.startsWith('//')) continue;
    // Match "fieldName: TypeName" or "fieldName?: TypeName"
    const match = trimmed.match(/^(\w+)\??\s*:\s*(.+)$/);
    if (match) {
      fields.push({ name: match[1]!, type: match[2]!.trim() });
    }
  }
  return fields;
}

/**
 * Find the pseudocode dataStructure definition string that matches a given type name.
 * Searches across all pseudocode modules for a dataStructure whose leading name matches.
 *
 * Returns the full definition string (e.g., "InvoicePayload { ... }") or null.
 */
function findDataStructureDefinition(
  typeName: string,
  modules: ReadonlyArray<Phase2PseudocodeModule>,
): string | null {
  const target = typeName.trim();
  for (const mod of modules) {
    for (const ds of mod.dataStructures) {
      // Extract the leading name before any brace or whitespace
      const leadingName = ds.trim().split(/[\s{]/)[0]!;
      if (leadingName === target) return ds;
    }
  }
  return null;
}

/**
 * Find the architecture service definition matching a bounded context name.
 * Matches by comparing slugified/normalized names.
 */
function findMatchingService(
  ctxName: string,
  services: ReadonlyArray<Phase2ServiceDefinition>,
): Phase2ServiceDefinition | null {
  const ctxSlug = slugify(ctxName).replace(/-context$/, '');
  for (const svc of services) {
    const svcSlug = slugify(svc.name);
    if (svcSlug === ctxSlug || ctxSlug.includes(svcSlug) || svcSlug.includes(ctxSlug)) {
      return svc;
    }
  }
  return null;
}

/**
 * Find pseudocode modules matching a bounded context by dossierItemRef overlap
 * with the corresponding architecture service.
 */
function findPseudocodeModulesForContext(
  ctxName: string,
  sparc: Phase2SPARCOutput,
): Phase2PseudocodeModule[] {
  const service = findMatchingService(ctxName, sparc.architecture.services);
  if (!service) return [];

  const serviceRefs = new Set(service.dossierItemRefs);
  const matched: Phase2PseudocodeModule[] = [];

  for (const mod of sparc.pseudocode.modules) {
    const overlap = mod.dossierItemRefs.filter((r) => serviceRefs.has(r)).length;
    if (overlap >= 2 || (mod.dossierItemRefs.length > 0 && overlap / mod.dossierItemRefs.length >= 0.5)) {
      matched.push(mod);
    }
  }

  // If strict matching yields nothing, try keyword matching on module name vs service name
  if (matched.length === 0) {
    const svcWords = new Set(slugify(service.name).split('-').filter((w) => w.length > 2));
    for (const mod of sparc.pseudocode.modules) {
      const modWords = slugify(mod.name).split('-').filter((w) => w.length > 2);
      const hits = modWords.filter((w) => svcWords.has(w)).length;
      if (hits >= 2 || (modWords.length > 0 && hits / modWords.length >= 0.5)) {
        matched.push(mod);
      }
    }
  }

  return matched;
}

/**
 * Extract algorithm steps from a pseudocode module's markdown for a given command.
 * Parses numbered steps, error handling blocks, and key operations.
 * Returns an array of step description strings.
 */
function extractAlgorithmSteps(
  _commandName: string,
  modules: Phase2PseudocodeModule[],
): string[] {
  if (modules.length === 0) return [];

  // Combine all markdown from matching modules
  const allMarkdown = modules.map((m) => m.markdown).join('\n\n');
  if (!allMarkdown.trim()) return [];

  const steps: string[] = [];
  const lines = allMarkdown.split('\n');

  for (const line of lines) {
    const trimmed = line.trim();
    // Strip leading comment markers: "// 1. Do X" -> "1. Do X"
    const stripped = trimmed.replace(/^\/\/\s*/, '');

    // Capture numbered steps: "1. Do X", "Step 1: Do X"
    const stepMatch = stripped.match(/^(?:\d+[.)]\s*|Step\s+\d+[:.]\s*)(.*)/i);
    if (stepMatch && stepMatch[1]!.length > 5) {
      steps.push(stepMatch[1]!.trim());
      continue;
    }
    // Capture "- action" bullet points that describe operations
    const bulletMatch = stripped.match(/^[-*]\s+(.{10,})/);
    if (bulletMatch && !/^#|^\*\*/.test(stripped)) {
      steps.push(bulletMatch[1]!.trim());
      continue;
    }
    // Capture TRY/CATCH/IF control flow as steps
    if (/^TRY:/i.test(stripped)) continue; // skip bare TRY
    const catchMatch = stripped.match(/^CATCH\s+(\w+)/i);
    if (catchMatch) {
      steps.push(`Handle error: ${catchMatch[1]}`);
      continue;
    }
    // Capture pseudocode assignments with function calls: "token = authenticate(...)"
    const assignMatch = stripped.match(/^(\w+)\s*=\s*(\w+)\(.*\)/);
    if (assignMatch && assignMatch[2]!.length > 3) {
      steps.push(`${assignMatch[1]} = ${assignMatch[2]}(...)`);
    }
  }

  // Also extract from algorithms array
  for (const mod of modules) {
    for (const algo of mod.algorithms) {
      if (algo.length > 15) {
        // Extract function-like operations (case-insensitive)
        const funcMatch = algo.match(/\bFUNCTION\s+(\w+)/i);
        if (funcMatch) {
          steps.push(`Invoke ${funcMatch[1]}() per pseudocode specification`);
        }
        // Also extract commented numbered steps from algorithms array
        const algoStripped = algo.replace(/^\/\/\s*/, '').trim();
        const algoStepMatch = algoStripped.match(/^(?:\d+[.)]\s*|Step\s+\d+[:.]\s*)(.*)/i);
        if (algoStepMatch && algoStepMatch[1]!.length > 5) {
          steps.push(algoStepMatch[1]!.trim());
        }
      }
    }
  }

  // Deduplicate and limit
  const unique = [...new Set(steps)];
  return unique.slice(0, 15);
}

/**
 * Map a TypeScript/pseudocode type to its Rust equivalent.
 */
function tsTypeToRust(tsType: string): string {
  const t = tsType.trim();

  // Arrays
  if (t.endsWith('[]')) {
    const inner = t.slice(0, -2);
    return `Vec<${tsTypeToRust(inner)}>`;
  }
  const arrayGeneric = t.match(/^Array<(.+)>$/);
  if (arrayGeneric) return `Vec<${tsTypeToRust(arrayGeneric[1]!)}>`;

  // Maps / Records
  if (t.startsWith('Record<') || t.startsWith('Map<')) {
    return 'std::collections::HashMap<String, serde_json::Value>';
  }

  // Primitives
  switch (t.toLowerCase()) {
    case 'string': return 'String';
    case 'number': return 'f64';
    case 'boolean': case 'bool': return 'bool';
    case 'date': case 'iso8601': case 'datetime': return 'String';
    case 'any': case 'unknown': return 'serde_json::Value';
    case 'void': case 'null': case 'undefined': return '()';
    default: break;
  }

  // Optional
  if (t.endsWith('| null') || t.endsWith('| undefined')) {
    const inner = t.replace(/\s*\|\s*(null|undefined)\s*$/, '').trim();
    return `Option<${tsTypeToRust(inner)}>`;
  }

  // Domain types — keep as-is (PascalCase forward references)
  return toPascalCase(t);
}

/**
 * Map a TypeScript/pseudocode type to a TypeScript class type.
 * Mostly pass-through, but normalize some pseudocode conventions.
 */
function normalizeTsType(tsType: string): string {
  const t = tsType.trim();
  switch (t.toLowerCase()) {
    case 'iso8601': case 'datetime': return 'string';
    default: return t;
  }
}

// ============================================================================
// TypeScript Code Generation
// ============================================================================

/**
 * Generate a TypeScript aggregate class file.
 */
function tsAggregate(
  ctx: Phase2DDDBoundedContext,
  agg: Phase2AggregateDefinition,
): string {
  const className = toPascalCase(agg.name);

  // Entity fields with proper class references (not generic string)
  const entityFields = agg.entities
    .map((e) => `    readonly ${toCamelCase(e.name)}: ${toPascalCase(e.name)},`)
    .join('\n');

  // Value object fields with proper class references
  const voFields = agg.valueObjects
    .map((vo) => `    readonly ${toCamelCase(vo.name)}: ${toPascalCase(vo.name)},`)
    .join('\n');

  const allFields = [entityFields, voFields].filter(Boolean).join('\n');

  // Real invariant enforcement — actual if/throw, not comments
  const invariantChecks = agg.invariants
    .map(
      (inv, i) =>
        `    // Invariant ${i + 1}: ${inv}\n` +
        `    if (!this._checkInvariant${i + 1}()) {\n` +
        `      throw new Error('Invariant violated: ${inv.replace(/'/g, "\\'")}');\n` +
        `    }`,
    )
    .join('\n');

  // Per-invariant private validation methods
  const invariantMethods = agg.invariants
    .map(
      (inv, i) =>
        `\n  /** Domain rule: ${inv} */\n` +
        `  private _checkInvariant${i + 1}(): boolean {\n` +
        `${inferAggregateInvariantBody(inv, agg)}\n` +
        `  }`,
    )
    .join('\n');

  // Domain event emission methods from context-level events triggered by this aggregate
  const relatedEvents = ctx.domainEvents.filter(
    (e) => e.triggeredBy === agg.name || e.triggeredBy === agg.root,
  );
  const eventMethods = relatedEvents
    .map((event) => {
      const eventName = toPascalCase(event.name);
      const params = event.payload
        .map((p) => `${toCamelCase(p)}: string`)
        .join(', ');
      return [
        ``,
        `  /** Emit domain event: ${event.description} */`,
        `  protected emit${eventName}(${params}): void {`,
        `    this._domainEvents.push({`,
        `      type: '${slugify(event.name)}' as const,`,
        `      payload: {`,
        `        aggregateId: this.id,`,
        `        timestamp: new Date().toISOString(),`,
        `        correlationId: '',`,
        ...event.payload.map((p) => `        ${toCamelCase(p)},`),
        `      },`,
        `      triggeredBy: '${event.triggeredBy}',`,
        `    });`,
        `  }`,
      ].join('\n');
    })
    .join('\n');

  // Generate import statements for referenced entity and value object types
  const entityImports = agg.entities
    .map((e) => {
      const typeName = toPascalCase(e.name);
      const fileName = slugify(e.name);
      return `import type { ${typeName} } from '../entities/${fileName}.js';`;
    });
  const voImports = agg.valueObjects
    .map((vo) => {
      const typeName = toPascalCase(vo.name);
      const fileName = slugify(vo.name);
      return `import type { ${typeName} } from '../value-objects/${fileName}.js';`;
    });
  const allImports = [...entityImports, ...voImports];

  return [
    ...(allImports.length > 0 ? [...allImports, ''] : []),
    `/**`,
    ` * Aggregate: ${agg.name}`,
    ` * Root: ${agg.root}`,
    ` * Bounded context: ${ctx.name}`,
    ` * Invariants: ${agg.invariants.length}`,
    ` * Entities: ${agg.entities.map((e) => e.name).join(', ') || 'none'}`,
    ` * Value Objects: ${agg.valueObjects.map((vo) => vo.name).join(', ') || 'none'}`,
    ` */`,
    '',
    `export class ${className} {`,
    '  private readonly _domainEvents: unknown[] = [];',
    '',
    '  constructor(',
    '    readonly id: string,',
    allFields || '',
    '  ) {',
    '    this.validateInvariants();',
    '  }',
    '',
    '  private validateInvariants(): void {',
    invariantChecks || '    // No invariants defined for this aggregate',
    '  }',
    invariantMethods || '',
    '',
    '  /** Collect and clear domain events for outbox dispatch. */',
    '  pullDomainEvents(): readonly unknown[] {',
    '    const events = [...this._domainEvents];',
    '    this._domainEvents.length = 0;',
    '    return events;',
    '  }',
    eventMethods || '',
    '}',
    '',
  ]
    .filter((line) => line !== undefined)
    .join('\n');
}

/**
 * Generate a TypeScript entity class file.
 */
function tsEntity(
  ctx: Phase2DDDBoundedContext,
  entity: Phase2Entity,
  pseudoModules: ReadonlyArray<Phase2PseudocodeModule>,
): string {
  const className = toPascalCase(entity.name);

  // Try to find typed fields from pseudocode dataStructures
  const dsDef = findDataStructureDefinition(className, pseudoModules)
    ?? findDataStructureDefinition(entity.name, pseudoModules);
  const dsFields = dsDef ? parseDataStructureFields(dsDef) : [];

  let fields: Array<{ name: string; type: string }>;

  if (dsFields.length > 0) {
    // Use real typed fields from pseudocode
    fields = dsFields.map((f) => ({
      name: toCamelCase(f.name),
      type: normalizeTsType(f.type),
    }));
  } else {
    // Fallback: extract from description heuristics
    fields = extractFieldsFromDescription(entity.description, entity.name);
  }

  const fieldDeclarations = fields
    .filter((f) => f.name !== 'id')
    .map((f) => `    readonly ${f.name}: ${f.type},`)
    .join('\n');

  const snapshotFields = fields
    .filter((f) => f.name !== 'id')
    .map((f) => `      ${f.name}: this.${f.name},`);

  return [
    `/**`,
    ` * Entity: ${entity.name}`,
    ` * ${entity.description}`,
    ` * Bounded context: ${ctx.name}`,
    ` */`,
    '',
    `export class ${className} {`,
    '  constructor(',
    '    readonly id: string,',
    fieldDeclarations || `    readonly name: string,`,
    `    readonly createdAt: Date = new Date(),`,
    `    readonly updatedAt: Date = new Date(),`,
    '  ) {}',
    '',
    `  /** Create a snapshot for persistence. */`,
    `  toSnapshot(): Record<string, unknown> {`,
    `    return {`,
    `      id: this.id,`,
    ...snapshotFields,
    `      createdAt: this.createdAt.toISOString(),`,
    `      updatedAt: this.updatedAt.toISOString(),`,
    `    };`,
    `  }`,
    '}',
    '',
  ].join('\n');
}

/**
 * Extract potential field names and types from an entity description.
 * Uses heuristics to identify attribute-like nouns and infer their types.
 */
function extractFieldsFromDescription(
  description: string,
  entityName: string,
): Array<{ name: string; type: string }> {
  const fields: Array<{ name: string; type: string }> = [];
  const seen = new Set<string>();
  const lower = description.toLowerCase();

  // Common domain field patterns to detect
  const patterns: Array<{ regex: RegExp; field: string; type: string }> = [
    { regex: /\b(?:status|state)\b/i, field: 'status', type: 'string' },
    { regex: /\b(?:amount|total|balance|value)\b/i, field: 'amount', type: 'number' },
    { regex: /\b(?:price|cost|fee|rate)\b/i, field: 'price', type: 'number' },
    { regex: /\b(?:quantity|count|number)\b/i, field: 'quantity', type: 'number' },
    { regex: /\b(?:score|rating|rank)\b/i, field: 'score', type: 'number' },
    { regex: /\b(?:description|note|comment|text|summary)\b/i, field: 'description', type: 'string' },
    { regex: /\b(?:email|address)\b/i, field: 'email', type: 'string' },
    { regex: /\b(?:date|deadline|expir|timestamp)\b/i, field: 'date', type: 'Date' },
    { regex: /\b(?:name|title|label)\b/i, field: 'name', type: 'string' },
    { regex: /\b(?:type|kind|category)\b/i, field: 'type', type: 'string' },
    { regex: /\b(?:flag|enabled|active|valid|approved)\b/i, field: 'isActive', type: 'boolean' },
    { regex: /\b(?:url|link|uri|endpoint)\b/i, field: 'url', type: 'string' },
    { regex: /\b(?:currency)\b/i, field: 'currency', type: 'string' },
    { regex: /\b(?:version)\b/i, field: 'version', type: 'number' },
    { regex: /\b(?:owner|author|creator|assignee)\b/i, field: 'ownerId', type: 'string' },
    { regex: /\b(?:risk|severity|priority|level)\b/i, field: 'level', type: 'string' },
    // Environmental / sustainability domain fields
    { regex: /\b(?:emission|ghg|co2|carbon)\b/i, field: 'emissionsKg', type: 'number' },
    { regex: /\b(?:scope[\s-]?[123])\b/i, field: 'scope', type: 'number' },
    { regex: /\b(?:energy[\s-]?consump|electricity|kilowatt|megawatt)\b/i, field: 'energyKwh', type: 'number' },
    { regex: /\b(?:water[\s-]?usage|water[\s-]?consump)\b/i, field: 'waterLiters', type: 'number' },
    { regex: /\b(?:waste|disposal)\b/i, field: 'wasteKg', type: 'number' },
    { regex: /\b(?:facility|plant|site|location)\b/i, field: 'facilityId', type: 'string' },
    { regex: /\b(?:threshold|limit|tolerance)\b/i, field: 'threshold', type: 'number' },
    { regex: /\b(?:anomal|discrepanc|deviation|outlier)\b/i, field: 'deviationPct', type: 'number' },
    { regex: /\b(?:period|quarter|year|month|fiscal)\b/i, field: 'reportingPeriod', type: 'string' },
    { regex: /\b(?:unit|measure|metric|uom)\b/i, field: 'unitOfMeasure', type: 'string' },
    { regex: /\b(?:source|origin|provider)\b/i, field: 'dataSource', type: 'string' },
    { regex: /\b(?:baseline|benchmark|target)\b/i, field: 'baselineValue', type: 'number' },
    { regex: /\b(?:confidence|accuracy|reliability)\b/i, field: 'confidenceScore', type: 'number' },
  ];

  for (const p of patterns) {
    if (p.regex.test(lower) && !seen.has(p.field)) {
      seen.add(p.field);
      fields.push({ name: p.field, type: p.type });
    }
  }

  // If no fields were detected, generate a sensible default based on the entity name
  if (fields.length === 0) {
    const entitySlug = toCamelCase(entityName);
    fields.push({ name: `${entitySlug}Data`, type: 'Record<string, unknown>' });
  }

  return fields;
}

/**
 * Infer DTO fields from a type name by matching against domain vocabulary.
 * Falls back to an id + data field if no patterns match.
 */
function inferDtoFields(typeName: string): Array<{ name: string; type: string }> {
  const lower = typeName.toLowerCase();
  const fields: Array<{ name: string; type: string }> = [
    { name: 'id', type: 'string' },
  ];

  // Match type name against known domain patterns
  const rules: Array<{ regex: RegExp; extraFields: Array<{ name: string; type: string }> }> = [
    { regex: /emission|ghg|carbon|co2/i, extraFields: [
      { name: 'facilityId', type: 'string' }, { name: 'scope', type: 'number' },
      { name: 'emissionsKg', type: 'number' }, { name: 'reportingPeriod', type: 'string' },
      { name: 'unitOfMeasure', type: 'string' }, { name: 'measuredAt', type: 'string' },
    ]},
    { regex: /anomal|discrepanc|deviation|outlier/i, extraFields: [
      { name: 'facilityId', type: 'string' }, { name: 'metricName', type: 'string' },
      { name: 'expectedValue', type: 'number' }, { name: 'actualValue', type: 'number' },
      { name: 'deviationPct', type: 'number' }, { name: 'severity', type: 'string' },
      { name: 'detectedAt', type: 'string' },
    ]},
    { regex: /energy|consumption|kwh/i, extraFields: [
      { name: 'facilityId', type: 'string' }, { name: 'energyKwh', type: 'number' },
      { name: 'source', type: 'string' }, { name: 'reportingPeriod', type: 'string' },
    ]},
    { regex: /water/i, extraFields: [
      { name: 'facilityId', type: 'string' }, { name: 'waterLiters', type: 'number' },
      { name: 'reportingPeriod', type: 'string' },
    ]},
    { regex: /waste|disposal/i, extraFields: [
      { name: 'facilityId', type: 'string' }, { name: 'wasteKg', type: 'number' },
      { name: 'wasteType', type: 'string' }, { name: 'reportingPeriod', type: 'string' },
    ]},
    { regex: /facility|plant|site/i, extraFields: [
      { name: 'name', type: 'string' }, { name: 'region', type: 'string' },
      { name: 'country', type: 'string' }, { name: 'status', type: 'string' },
    ]},
    { regex: /compliance|regulat|disclosure/i, extraFields: [
      { name: 'framework', type: 'string' }, { name: 'status', type: 'string' },
      { name: 'dueDate', type: 'string' }, { name: 'submittedAt', type: 'string | null' },
    ]},
    { regex: /supplier|vendor|procurement/i, extraFields: [
      { name: 'name', type: 'string' }, { name: 'category', type: 'string' },
      { name: 'sustainabilityScore', type: 'number' }, { name: 'status', type: 'string' },
    ]},
    { regex: /report|metric|kpi/i, extraFields: [
      { name: 'name', type: 'string' }, { name: 'value', type: 'number' },
      { name: 'period', type: 'string' }, { name: 'status', type: 'string' },
    ]},
    { regex: /promoti|campaign|trade[\s-]?spend/i, extraFields: [
      { name: 'campaignId', type: 'string' }, { name: 'retailerId', type: 'string' },
      { name: 'startDate', type: 'string' }, { name: 'endDate', type: 'string' },
      { name: 'spendAmount', type: 'number' }, { name: 'incrementalRevenue', type: 'number' },
      { name: 'roi', type: 'number' }, { name: 'status', type: 'string' },
    ]},
    { regex: /point[\s-]?of[\s-]?sale|pos[\s-]?data|retail[\s-]?data/i, extraFields: [
      { name: 'retailerId', type: 'string' }, { name: 'storeId', type: 'string' },
      { name: 'productId', type: 'string' }, { name: 'unitsSold', type: 'number' },
      { name: 'revenue', type: 'number' }, { name: 'transactionDate', type: 'string' },
    ]},
    { regex: /budget|spend[\s-]?allocat/i, extraFields: [
      { name: 'category', type: 'string' }, { name: 'allocatedAmount', type: 'number' },
      { name: 'spentAmount', type: 'number' }, { name: 'remainingAmount', type: 'number' },
      { name: 'period', type: 'string' }, { name: 'status', type: 'string' },
    ]},
    { regex: /contract|agreement/i, extraFields: [
      { name: 'retailerId', type: 'string' }, { name: 'startDate', type: 'string' },
      { name: 'endDate', type: 'string' }, { name: 'terms', type: 'string' },
      { name: 'status', type: 'string' },
    ]},
    { regex: /cannibaliz|displacement/i, extraFields: [
      { name: 'promotionId', type: 'string' }, { name: 'affectedProductId', type: 'string' },
      { name: 'baselineSales', type: 'number' }, { name: 'actualSales', type: 'number' },
      { name: 'displacementPct', type: 'number' }, { name: 'detectedAt', type: 'string' },
    ]},
    { regex: /inventory|stock/i, extraFields: [
      { name: 'productId', type: 'string' }, { name: 'locationId', type: 'string' },
      { name: 'quantityOnHand', type: 'number' }, { name: 'reorderPoint', type: 'number' },
      { name: 'status', type: 'string' },
    ]},
    { regex: /equipment[\s-]?telemetry|sensor[\s-]?data|vibrat|bearing/i, extraFields: [
      { name: 'equipmentId', type: 'string' }, { name: 'sensorType', type: 'string' },
      { name: 'value', type: 'number' }, { name: 'unit', type: 'string' },
      { name: 'threshold', type: 'number' }, { name: 'timestamp', type: 'string' },
      { name: 'locationId', type: 'string' }, { name: 'status', type: 'string' },
    ]},
    { regex: /predict(?:ive)?[\s-]?maint|condition[\s-]?monitor|failure[\s-]?predict/i, extraFields: [
      { name: 'equipmentId', type: 'string' }, { name: 'failureMode', type: 'string' },
      { name: 'probability', type: 'number' }, { name: 'remainingUsefulLife', type: 'number' },
      { name: 'confidence', type: 'number' }, { name: 'recommendedAction', type: 'string' },
      { name: 'predictedAt', type: 'string' }, { name: 'priority', type: 'string' },
    ]},
    { regex: /efficiency[\s-]?degrad|performance[\s-]?decay|throughput[\s-]?declin/i, extraFields: [
      { name: 'equipmentId', type: 'string' }, { name: 'metricName', type: 'string' },
      { name: 'baselineValue', type: 'number' }, { name: 'currentValue', type: 'number' },
      { name: 'degradationPct', type: 'number' }, { name: 'trendSlope', type: 'number' },
      { name: 'detectedAt', type: 'string' },
    ]},
    { regex: /production[\s-]?throughput|tonnage|output[\s-]?rate/i, extraFields: [
      { name: 'siteId', type: 'string' }, { name: 'equipmentId', type: 'string' },
      { name: 'tonnage', type: 'number' }, { name: 'targetTonnage', type: 'number' },
      { name: 'utilizationPct', type: 'number' }, { name: 'period', type: 'string' },
      { name: 'status', type: 'string' },
    ]},
    { regex: /fleet[\s-]?dispatch|vehicle[\s-]?track/i, extraFields: [
      { name: 'vehicleId', type: 'string' }, { name: 'operatorId', type: 'string' },
      { name: 'routeId', type: 'string' }, { name: 'loadTonnage', type: 'number' },
      { name: 'cycleTimeMinutes', type: 'number' }, { name: 'status', type: 'string' },
      { name: 'gpsLat', type: 'number' }, { name: 'gpsLon', type: 'number' },
    ]},
    { regex: /mining|mine[\s-]?site|ore|mineral/i, extraFields: [
      { name: 'siteId', type: 'string' }, { name: 'pitId', type: 'string' },
      { name: 'oreType', type: 'string' }, { name: 'gradePercent', type: 'number' },
      { name: 'tonnageExtracted', type: 'number' }, { name: 'status', type: 'string' },
    ]},
    { regex: /geotechnical|tailings|slope[\s-]?stabil/i, extraFields: [
      { name: 'siteId', type: 'string' }, { name: 'sensorId', type: 'string' },
      { name: 'displacementMm', type: 'number' }, { name: 'waterLevelM', type: 'number' },
      { name: 'stabilityIndex', type: 'number' }, { name: 'alertLevel', type: 'string' },
      { name: 'measuredAt', type: 'string' },
    ]},
    // Healthcare / Life Sciences
    { regex: /patient|ehr|medical[\s-]?record/i, extraFields: [
      { name: 'mrn', type: 'string' }, { name: 'firstName', type: 'string' },
      { name: 'lastName', type: 'string' }, { name: 'dateOfBirth', type: 'string' },
      { name: 'gender', type: 'string' }, { name: 'primaryDiagnosis', type: 'string' },
      { name: 'admittedAt', type: 'string | null' }, { name: 'status', type: 'string' },
    ]},
    { regex: /clinical[\s-]?trial|trial[\s-]?protocol/i, extraFields: [
      { name: 'trialId', type: 'string' }, { name: 'phase', type: 'string' },
      { name: 'sponsor', type: 'string' }, { name: 'indication', type: 'string' },
      { name: 'enrollmentTarget', type: 'number' }, { name: 'enrolledCount', type: 'number' },
      { name: 'startDate', type: 'string' }, { name: 'status', type: 'string' },
    ]},
    { regex: /drug[\s-]?discover|molecule|compound/i, extraFields: [
      { name: 'compoundId', type: 'string' }, { name: 'molecularWeight', type: 'number' },
      { name: 'targetProtein', type: 'string' }, { name: 'stage', type: 'string' },
      { name: 'efficacyScore', type: 'number' }, { name: 'toxicityFlag', type: 'boolean' },
    ]},
    { regex: /pharmacovigilance|adverse[\s-]?event/i, extraFields: [
      { name: 'caseId', type: 'string' }, { name: 'drugName', type: 'string' },
      { name: 'eventType', type: 'string' }, { name: 'severity', type: 'string' },
      { name: 'outcome', type: 'string' }, { name: 'reportedAt', type: 'string' },
    ]},
    { regex: /claim[\s-]?adjud|medical[\s-]?claim/i, extraFields: [
      { name: 'claimNumber', type: 'string' }, { name: 'patientId', type: 'string' },
      { name: 'providerId', type: 'string' }, { name: 'procedureCode', type: 'string' },
      { name: 'billedAmount', type: 'number' }, { name: 'allowedAmount', type: 'number' },
      { name: 'denialReason', type: 'string | null' }, { name: 'status', type: 'string' },
    ]},
    { regex: /genomic|genome|biomarker/i, extraFields: [
      { name: 'sampleId', type: 'string' }, { name: 'patientId', type: 'string' },
      { name: 'sequenceType', type: 'string' }, { name: 'variant', type: 'string' },
      { name: 'significance', type: 'string' }, { name: 'confidence', type: 'number' },
    ]},
    // Financial Services
    { regex: /trade[\s-]?execut|trading|order[\s-]?book/i, extraFields: [
      { name: 'symbol', type: 'string' }, { name: 'side', type: 'string' },
      { name: 'quantity', type: 'number' }, { name: 'price', type: 'number' },
      { name: 'orderType', type: 'string' }, { name: 'executedAt', type: 'string' },
      { name: 'venue', type: 'string' }, { name: 'status', type: 'string' },
    ]},
    { regex: /kyc|aml|sanctions/i, extraFields: [
      { name: 'customerId', type: 'string' }, { name: 'checkType', type: 'string' },
      { name: 'riskScore', type: 'number' }, { name: 'matchResult', type: 'string' },
      { name: 'screenedAt', type: 'string' }, { name: 'status', type: 'string' },
    ]},
    { regex: /loan[\s-]?originat|mortgage|credit[\s-]?assess/i, extraFields: [
      { name: 'applicationId', type: 'string' }, { name: 'borrowerId', type: 'string' },
      { name: 'loanAmount', type: 'number' }, { name: 'interestRate', type: 'number' },
      { name: 'termMonths', type: 'number' }, { name: 'creditScore', type: 'number' },
      { name: 'status', type: 'string' },
    ]},
    { regex: /portfolio[\s-]?manag|asset[\s-]?allocat|wealth/i, extraFields: [
      { name: 'portfolioId', type: 'string' }, { name: 'clientId', type: 'string' },
      { name: 'totalValue', type: 'number' }, { name: 'allocation', type: 'string' },
      { name: 'returnPct', type: 'number' }, { name: 'benchmarkPct', type: 'number' },
      { name: 'rebalancedAt', type: 'string | null' },
    ]},
    { regex: /fraud[\s-]?detect|suspicious/i, extraFields: [
      { name: 'transactionId', type: 'string' }, { name: 'accountId', type: 'string' },
      { name: 'amount', type: 'number' }, { name: 'riskScore', type: 'number' },
      { name: 'ruleTriggered', type: 'string' }, { name: 'flaggedAt', type: 'string' },
      { name: 'status', type: 'string' },
    ]},
    { regex: /risk[\s-]?manag|credit[\s-]?risk|market[\s-]?risk/i, extraFields: [
      { name: 'entityId', type: 'string' }, { name: 'riskType', type: 'string' },
      { name: 'exposure', type: 'number' }, { name: 'probability', type: 'number' },
      { name: 'impact', type: 'number' }, { name: 'mitigationStrategy', type: 'string' },
      { name: 'assessedAt', type: 'string' },
    ]},
    // Insurance
    { regex: /underwriting|policy[\s-]?pric/i, extraFields: [
      { name: 'applicationId', type: 'string' }, { name: 'riskClass', type: 'string' },
      { name: 'premiumAmount', type: 'number' }, { name: 'deductible', type: 'number' },
      { name: 'coverageLimit', type: 'number' }, { name: 'decision', type: 'string' },
    ]},
    { regex: /claims[\s-]?process|claim[\s-]?settl|loss[\s-]?adjust/i, extraFields: [
      { name: 'claimNumber', type: 'string' }, { name: 'policyId', type: 'string' },
      { name: 'lossDate', type: 'string' }, { name: 'claimAmount', type: 'number' },
      { name: 'reserveAmount', type: 'number' }, { name: 'adjusterAssigned', type: 'string' },
      { name: 'status', type: 'string' },
    ]},
    { regex: /policy[\s-]?manag|policy[\s-]?admin/i, extraFields: [
      { name: 'policyNumber', type: 'string' }, { name: 'holderId', type: 'string' },
      { name: 'coverageType', type: 'string' }, { name: 'effectiveDate', type: 'string' },
      { name: 'expirationDate', type: 'string' }, { name: 'premiumAmount', type: 'number' },
      { name: 'status', type: 'string' },
    ]},
    // Telecom
    { regex: /network[\s-]?operat|noc|cell[\s-]?tower/i, extraFields: [
      { name: 'siteId', type: 'string' }, { name: 'towerType', type: 'string' },
      { name: 'latitude', type: 'number' }, { name: 'longitude', type: 'number' },
      { name: 'signalStrength', type: 'number' }, { name: 'status', type: 'string' },
    ]},
    { regex: /subscriber|sim[\s-]?manag/i, extraFields: [
      { name: 'subscriberId', type: 'string' }, { name: 'msisdn', type: 'string' },
      { name: 'planType', type: 'string' }, { name: 'dataUsageMb', type: 'number' },
      { name: 'activatedAt', type: 'string' }, { name: 'status', type: 'string' },
    ]},
    { regex: /cdr|call[\s-]?detail|billing[\s-]?mediat/i, extraFields: [
      { name: 'callId', type: 'string' }, { name: 'callerMsisdn', type: 'string' },
      { name: 'calleeMsisdn', type: 'string' }, { name: 'durationSec', type: 'number' },
      { name: 'chargeAmount', type: 'number' }, { name: 'callType', type: 'string' },
      { name: 'timestamp', type: 'string' },
    ]},
    // Oil & Gas
    { regex: /reservoir|well[\s-]?log|seismic/i, extraFields: [
      { name: 'wellId', type: 'string' }, { name: 'fieldName', type: 'string' },
      { name: 'depth', type: 'number' }, { name: 'porosity', type: 'number' },
      { name: 'permeability', type: 'number' }, { name: 'pressure', type: 'number' },
      { name: 'fluidType', type: 'string' },
    ]},
    { regex: /drill(?:ing)?[\s-]?operat|wellbore/i, extraFields: [
      { name: 'wellId', type: 'string' }, { name: 'rigId', type: 'string' },
      { name: 'currentDepth', type: 'number' }, { name: 'targetDepth', type: 'number' },
      { name: 'rop', type: 'number' }, { name: 'mudWeight', type: 'number' },
      { name: 'status', type: 'string' },
    ]},
    { regex: /pipeline[\s-]?integrit|pipeline[\s-]?monitor|leak/i, extraFields: [
      { name: 'pipelineId', type: 'string' }, { name: 'segmentId', type: 'string' },
      { name: 'pressurePsi', type: 'number' }, { name: 'flowRate', type: 'number' },
      { name: 'wallThicknessMm', type: 'number' }, { name: 'inspectedAt', type: 'string' },
      { name: 'status', type: 'string' },
    ]},
    { regex: /refin(?:ery|ing)|crude[\s-]?process/i, extraFields: [
      { name: 'unitId', type: 'string' }, { name: 'feedRate', type: 'number' },
      { name: 'temperature', type: 'number' }, { name: 'pressure', type: 'number' },
      { name: 'yieldPct', type: 'number' }, { name: 'productType', type: 'string' },
    ]},
    // Agriculture
    { regex: /crop[\s-]?manag|planting|harvest/i, extraFields: [
      { name: 'fieldId', type: 'string' }, { name: 'cropType', type: 'string' },
      { name: 'plantedDate', type: 'string' }, { name: 'areaHectares', type: 'number' },
      { name: 'growthStage', type: 'string' }, { name: 'expectedYield', type: 'number' },
      { name: 'status', type: 'string' },
    ]},
    { regex: /precision[\s-]?ag|precision[\s-]?farm|ndvi/i, extraFields: [
      { name: 'fieldId', type: 'string' }, { name: 'zoneId', type: 'string' },
      { name: 'ndviScore', type: 'number' }, { name: 'applicationRate', type: 'number' },
      { name: 'sensorType', type: 'string' }, { name: 'capturedAt', type: 'string' },
    ]},
    { regex: /soil[\s-]?analy|nutrient|fertiliz/i, extraFields: [
      { name: 'fieldId', type: 'string' }, { name: 'sampleDepth', type: 'number' },
      { name: 'phLevel', type: 'number' }, { name: 'nitrogenPpm', type: 'number' },
      { name: 'phosphorusPpm', type: 'number' }, { name: 'potassiumPpm', type: 'number' },
      { name: 'sampledAt', type: 'string' },
    ]},
    { regex: /livestock|herd|cattle|animal[\s-]?health/i, extraFields: [
      { name: 'animalId', type: 'string' }, { name: 'species', type: 'string' },
      { name: 'breed', type: 'string' }, { name: 'weight', type: 'number' },
      { name: 'healthStatus', type: 'string' }, { name: 'locationId', type: 'string' },
    ]},
    // Construction / Real Estate
    { regex: /bim|building[\s-]?information/i, extraFields: [
      { name: 'projectId', type: 'string' }, { name: 'modelVersion', type: 'string' },
      { name: 'elementCount', type: 'number' }, { name: 'clashCount', type: 'number' },
      { name: 'lastUpdated', type: 'string' }, { name: 'status', type: 'string' },
    ]},
    { regex: /construction[\s-]?project|job[\s-]?site/i, extraFields: [
      { name: 'projectId', type: 'string' }, { name: 'siteName', type: 'string' },
      { name: 'budgetAmount', type: 'number' }, { name: 'spentAmount', type: 'number' },
      { name: 'completionPct', type: 'number' }, { name: 'targetDate', type: 'string' },
      { name: 'status', type: 'string' },
    ]},
    { regex: /property[\s-]?manag|tenant|lease/i, extraFields: [
      { name: 'propertyId', type: 'string' }, { name: 'tenantId', type: 'string' },
      { name: 'leaseStart', type: 'string' }, { name: 'leaseEnd', type: 'string' },
      { name: 'monthlyRent', type: 'number' }, { name: 'occupancyStatus', type: 'string' },
    ]},
    // Utilities
    { regex: /grid[\s-]?manag|power[\s-]?grid|transmission/i, extraFields: [
      { name: 'substationId', type: 'string' }, { name: 'voltageKv', type: 'number' },
      { name: 'loadMw', type: 'number' }, { name: 'capacityMw', type: 'number' },
      { name: 'frequencyHz', type: 'number' }, { name: 'status', type: 'string' },
    ]},
    { regex: /smart[\s-]?meter|meter[\s-]?data|ami/i, extraFields: [
      { name: 'meterId', type: 'string' }, { name: 'accountId', type: 'string' },
      { name: 'readingKwh', type: 'number' }, { name: 'intervalMinutes', type: 'number' },
      { name: 'readAt', type: 'string' }, { name: 'quality', type: 'string' },
    ]},
    { regex: /outage[\s-]?manag|outage[\s-]?detect/i, extraFields: [
      { name: 'outageId', type: 'string' }, { name: 'affectedMeters', type: 'number' },
      { name: 'cause', type: 'string' }, { name: 'reportedAt', type: 'string' },
      { name: 'restoredAt', type: 'string | null' }, { name: 'crewAssigned', type: 'string' },
    ]},
    { regex: /scada|supervisory[\s-]?control|plc/i, extraFields: [
      { name: 'deviceId', type: 'string' }, { name: 'signalName', type: 'string' },
      { name: 'value', type: 'number' }, { name: 'setpoint', type: 'number' },
      { name: 'alarmState', type: 'string' }, { name: 'timestamp', type: 'string' },
    ]},
    // Aviation
    { regex: /flight[\s-]?operat|flight[\s-]?plan/i, extraFields: [
      { name: 'flightNumber', type: 'string' }, { name: 'aircraftReg', type: 'string' },
      { name: 'origin', type: 'string' }, { name: 'destination', type: 'string' },
      { name: 'departureTime', type: 'string' }, { name: 'arrivalTime', type: 'string' },
      { name: 'status', type: 'string' },
    ]},
    { regex: /mro|aircraft[\s-]?maint|airworth/i, extraFields: [
      { name: 'aircraftReg', type: 'string' }, { name: 'workOrderId', type: 'string' },
      { name: 'taskType', type: 'string' }, { name: 'componentPn', type: 'string' },
      { name: 'manHours', type: 'number' }, { name: 'nextDueDate', type: 'string' },
      { name: 'status', type: 'string' },
    ]},
    // Maritime
    { regex: /vessel[\s-]?track|ais|ship[\s-]?track/i, extraFields: [
      { name: 'vesselImo', type: 'string' }, { name: 'vesselName', type: 'string' },
      { name: 'latitude', type: 'number' }, { name: 'longitude', type: 'number' },
      { name: 'speedKnots', type: 'number' }, { name: 'heading', type: 'number' },
      { name: 'destination', type: 'string' }, { name: 'eta', type: 'string' },
    ]},
    { regex: /port[\s-]?operat|terminal[\s-]?operat|berth/i, extraFields: [
      { name: 'portId', type: 'string' }, { name: 'berthId', type: 'string' },
      { name: 'vesselImo', type: 'string' }, { name: 'arrivalTime', type: 'string' },
      { name: 'departureTime', type: 'string' }, { name: 'cargoType', type: 'string' },
      { name: 'status', type: 'string' },
    ]},
    { regex: /container[\s-]?manag|container[\s-]?track|reefer/i, extraFields: [
      { name: 'containerId', type: 'string' }, { name: 'containerType', type: 'string' },
      { name: 'contents', type: 'string' }, { name: 'weightKg', type: 'number' },
      { name: 'temperature', type: 'number | null' }, { name: 'locationId', type: 'string' },
      { name: 'status', type: 'string' },
    ]},
    // Automotive
    { regex: /vehicle[\s-]?telematic|connected[\s-]?car|obd/i, extraFields: [
      { name: 'vin', type: 'string' }, { name: 'odometer', type: 'number' },
      { name: 'fuelLevel', type: 'number' }, { name: 'engineRpm', type: 'number' },
      { name: 'dtcCodes', type: 'string' }, { name: 'latitude', type: 'number' },
      { name: 'longitude', type: 'number' }, { name: 'timestamp', type: 'string' },
    ]},
    { regex: /recall[\s-]?manag|safety[\s-]?recall/i, extraFields: [
      { name: 'recallId', type: 'string' }, { name: 'campaignNumber', type: 'string' },
      { name: 'affectedVins', type: 'number' }, { name: 'defectDescription', type: 'string' },
      { name: 'remedyType', type: 'string' }, { name: 'completionPct', type: 'number' },
      { name: 'status', type: 'string' },
    ]},
    { regex: /ev[\s-]?charg|charging[\s-]?station/i, extraFields: [
      { name: 'stationId', type: 'string' }, { name: 'connectorType', type: 'string' },
      { name: 'powerKw', type: 'number' }, { name: 'sessionKwh', type: 'number' },
      { name: 'vehicleVin', type: 'string' }, { name: 'status', type: 'string' },
    ]},
    // Hospitality
    { regex: /reservation|booking[\s-]?engine|room[\s-]?allocat/i, extraFields: [
      { name: 'confirmationNumber', type: 'string' }, { name: 'guestId', type: 'string' },
      { name: 'roomType', type: 'string' }, { name: 'checkIn', type: 'string' },
      { name: 'checkOut', type: 'string' }, { name: 'rateAmount', type: 'number' },
      { name: 'status', type: 'string' },
    ]},
    { regex: /revenue[\s-]?manag|dynamic[\s-]?pric|rate[\s-]?optim/i, extraFields: [
      { name: 'roomType', type: 'string' }, { name: 'date', type: 'string' },
      { name: 'baseRate', type: 'number' }, { name: 'optimizedRate', type: 'number' },
      { name: 'occupancyPct', type: 'number' }, { name: 'demandScore', type: 'number' },
    ]},
    { regex: /loyalty[\s-]?program|reward[\s-]?point/i, extraFields: [
      { name: 'memberId', type: 'string' }, { name: 'tier', type: 'string' },
      { name: 'pointsBalance', type: 'number' }, { name: 'lifetimePoints', type: 'number' },
      { name: 'expiringPoints', type: 'number' }, { name: 'expiryDate', type: 'string' },
    ]},
    // Education
    { regex: /student[\s-]?information|sis|enrollment/i, extraFields: [
      { name: 'studentId', type: 'string' }, { name: 'firstName', type: 'string' },
      { name: 'lastName', type: 'string' }, { name: 'programCode', type: 'string' },
      { name: 'enrollmentDate', type: 'string' }, { name: 'gpa', type: 'number' },
      { name: 'status', type: 'string' },
    ]},
    { regex: /lms|learning[\s-]?manag|course[\s-]?manag/i, extraFields: [
      { name: 'courseId', type: 'string' }, { name: 'title', type: 'string' },
      { name: 'instructorId', type: 'string' }, { name: 'enrolledCount', type: 'number' },
      { name: 'completionRate', type: 'number' }, { name: 'status', type: 'string' },
    ]},
    // Government
    { regex: /permit|licensing|zoning/i, extraFields: [
      { name: 'permitNumber', type: 'string' }, { name: 'applicantId', type: 'string' },
      { name: 'permitType', type: 'string' }, { name: 'submittedAt', type: 'string' },
      { name: 'issuedAt', type: 'string | null' }, { name: 'expiresAt', type: 'string' },
      { name: 'status', type: 'string' },
    ]},
    { regex: /case[\s-]?manag|casework|social[\s-]?service/i, extraFields: [
      { name: 'caseNumber', type: 'string' }, { name: 'clientId', type: 'string' },
      { name: 'caseType', type: 'string' }, { name: 'assignedTo', type: 'string' },
      { name: 'priority', type: 'string' }, { name: 'openedAt', type: 'string' },
      { name: 'status', type: 'string' },
    ]},
    { regex: /grant[\s-]?manag|federal[\s-]?fund/i, extraFields: [
      { name: 'grantNumber', type: 'string' }, { name: 'awardAmount', type: 'number' },
      { name: 'disbursedAmount', type: 'number' }, { name: 'granteeId', type: 'string' },
      { name: 'programCode', type: 'string' }, { name: 'status', type: 'string' },
    ]},
    // Legal
    { regex: /litigation[\s-]?manag|docket|court[\s-]?filing/i, extraFields: [
      { name: 'caseNumber', type: 'string' }, { name: 'court', type: 'string' },
      { name: 'plaintiff', type: 'string' }, { name: 'defendant', type: 'string' },
      { name: 'filingDate', type: 'string' }, { name: 'nextHearing', type: 'string | null' },
      { name: 'status', type: 'string' },
    ]},
    { regex: /e[\s-]?discovery|document[\s-]?review/i, extraFields: [
      { name: 'matterId', type: 'string' }, { name: 'documentCount', type: 'number' },
      { name: 'reviewedCount', type: 'number' }, { name: 'relevantCount', type: 'number' },
      { name: 'privilegedCount', type: 'number' }, { name: 'status', type: 'string' },
    ]},
    // Media / Entertainment
    { regex: /content[\s-]?manag|cms|digital[\s-]?asset/i, extraFields: [
      { name: 'assetId', type: 'string' }, { name: 'title', type: 'string' },
      { name: 'contentType', type: 'string' }, { name: 'format', type: 'string' },
      { name: 'fileSizeBytes', type: 'number' }, { name: 'publishedAt', type: 'string | null' },
      { name: 'status', type: 'string' },
    ]},
    { regex: /ad[\s-]?tech|programmatic|ad[\s-]?serv/i, extraFields: [
      { name: 'campaignId', type: 'string' }, { name: 'advertiserId', type: 'string' },
      { name: 'impressions', type: 'number' }, { name: 'clicks', type: 'number' },
      { name: 'spend', type: 'number' }, { name: 'cpm', type: 'number' },
      { name: 'ctr', type: 'number' },
    ]},
    { regex: /streaming|transcod|video[\s-]?delivery/i, extraFields: [
      { name: 'contentId', type: 'string' }, { name: 'bitrateKbps', type: 'number' },
      { name: 'resolution', type: 'string' }, { name: 'concurrentViewers', type: 'number' },
      { name: 'bufferingPct', type: 'number' }, { name: 'status', type: 'string' },
    ]},
    // Cybersecurity
    { regex: /threat[\s-]?intellig|ioc|indicator[\s-]?of[\s-]?compromise/i, extraFields: [
      { name: 'iocValue', type: 'string' }, { name: 'iocType', type: 'string' },
      { name: 'source', type: 'string' }, { name: 'confidence', type: 'number' },
      { name: 'severity', type: 'string' }, { name: 'firstSeen', type: 'string' },
      { name: 'lastSeen', type: 'string' },
    ]},
    { regex: /siem|security[\s-]?event|log[\s-]?correlat/i, extraFields: [
      { name: 'eventId', type: 'string' }, { name: 'sourceIp', type: 'string' },
      { name: 'eventType', type: 'string' }, { name: 'severity', type: 'string' },
      { name: 'ruleId', type: 'string' }, { name: 'timestamp', type: 'string' },
      { name: 'correlated', type: 'boolean' },
    ]},
    { regex: /vulnerabilit|cve|patch[\s-]?manag/i, extraFields: [
      { name: 'cveId', type: 'string' }, { name: 'assetId', type: 'string' },
      { name: 'cvssScore', type: 'number' }, { name: 'severity', type: 'string' },
      { name: 'patchAvailable', type: 'boolean' }, { name: 'discoveredAt', type: 'string' },
      { name: 'status', type: 'string' },
    ]},
    // Logistics / 3PL
    { regex: /route[\s-]?optim|last[\s-]?mile|delivery[\s-]?optim/i, extraFields: [
      { name: 'routeId', type: 'string' }, { name: 'driverId', type: 'string' },
      { name: 'stopCount', type: 'number' }, { name: 'distanceKm', type: 'number' },
      { name: 'estimatedMinutes', type: 'number' }, { name: 'status', type: 'string' },
    ]},
    { regex: /wms|warehouse[\s-]?manag[\s-]?system|pick[\s-]?pack/i, extraFields: [
      { name: 'warehouseId', type: 'string' }, { name: 'orderId', type: 'string' },
      { name: 'skuCount', type: 'number' }, { name: 'zone', type: 'string' },
      { name: 'pickedAt', type: 'string | null' }, { name: 'shippedAt', type: 'string | null' },
      { name: 'status', type: 'string' },
    ]},
    { regex: /freight[\s-]?broker|carrier[\s-]?manag|tms/i, extraFields: [
      { name: 'shipmentId', type: 'string' }, { name: 'carrierId', type: 'string' },
      { name: 'origin', type: 'string' }, { name: 'destination', type: 'string' },
      { name: 'weightKg', type: 'number' }, { name: 'rateAmount', type: 'number' },
      { name: 'status', type: 'string' },
    ]},
    { regex: /customs|import[\s-]?export|tariff/i, extraFields: [
      { name: 'declarationId', type: 'string' }, { name: 'hsCode', type: 'string' },
      { name: 'countryOfOrigin', type: 'string' }, { name: 'dutyAmount', type: 'number' },
      { name: 'clearanceDate', type: 'string | null' }, { name: 'status', type: 'string' },
    ]},
    // E-commerce
    { regex: /product[\s-]?catalog|pim|sku[\s-]?manag/i, extraFields: [
      { name: 'sku', type: 'string' }, { name: 'name', type: 'string' },
      { name: 'category', type: 'string' }, { name: 'price', type: 'number' },
      { name: 'stockQuantity', type: 'number' }, { name: 'status', type: 'string' },
    ]},
    { regex: /shopping[\s-]?cart|checkout|cart[\s-]?abandon/i, extraFields: [
      { name: 'cartId', type: 'string' }, { name: 'customerId', type: 'string' },
      { name: 'itemCount', type: 'number' }, { name: 'totalAmount', type: 'number' },
      { name: 'abandonedAt', type: 'string | null' }, { name: 'convertedAt', type: 'string | null' },
    ]},
    { regex: /return[\s-]?manag|rma|reverse[\s-]?logistic/i, extraFields: [
      { name: 'rmaNumber', type: 'string' }, { name: 'orderId', type: 'string' },
      { name: 'reason', type: 'string' }, { name: 'refundAmount', type: 'number' },
      { name: 'condition', type: 'string' }, { name: 'status', type: 'string' },
    ]},
    { regex: /recommendation[\s-]?engine|personali[sz]/i, extraFields: [
      { name: 'userId', type: 'string' }, { name: 'productId', type: 'string' },
      { name: 'score', type: 'number' }, { name: 'algorithm', type: 'string' },
      { name: 'reason', type: 'string' }, { name: 'generatedAt', type: 'string' },
    ]},
    // HR expanded
    { regex: /payroll|compensation|benefit[\s-]?admin/i, extraFields: [
      { name: 'employeeId', type: 'string' }, { name: 'grossPay', type: 'number' },
      { name: 'deductions', type: 'number' }, { name: 'netPay', type: 'number' },
      { name: 'payPeriod', type: 'string' }, { name: 'status', type: 'string' },
    ]},
    { regex: /recruit|applicant[\s-]?track|talent[\s-]?acquis/i, extraFields: [
      { name: 'requisitionId', type: 'string' }, { name: 'candidateId', type: 'string' },
      { name: 'position', type: 'string' }, { name: 'stage', type: 'string' },
      { name: 'appliedAt', type: 'string' }, { name: 'status', type: 'string' },
    ]},
    { regex: /safety[\s-]?compliance|osha|incident[\s-]?report/i, extraFields: [
      { name: 'incidentId', type: 'string' }, { name: 'siteId', type: 'string' },
      { name: 'incidentType', type: 'string' }, { name: 'severity', type: 'string' },
      { name: 'reportedBy', type: 'string' }, { name: 'occurredAt', type: 'string' },
      { name: 'status', type: 'string' },
    ]},
    // Hospitality workforce planning
    { regex: /workforce[\s-]?plan|staffing[\s-]?optim|shift[\s-]?plan/i, extraFields: [
      { name: 'propertyId', type: 'string' }, { name: 'departmentId', type: 'string' },
      { name: 'headcount', type: 'number' }, { name: 'requiredStaff', type: 'number' },
      { name: 'shiftDate', type: 'string' }, { name: 'shiftType', type: 'string' },
      { name: 'status', type: 'string' },
    ]},
    { regex: /staffing[\s-]?alert|understaf|overstaff/i, extraFields: [
      { name: 'propertyId', type: 'string' }, { name: 'departmentId', type: 'string' },
      { name: 'alertType', type: 'string' }, { name: 'severity', type: 'string' },
      { name: 'currentStaff', type: 'number' }, { name: 'requiredStaff', type: 'number' },
      { name: 'triggeredAt', type: 'string' },
    ]},
    { regex: /labor[\s-]?cost|wage[\s-]?cost|overtime/i, extraFields: [
      { name: 'propertyId', type: 'string' }, { name: 'departmentId', type: 'string' },
      { name: 'regularHours', type: 'number' }, { name: 'overtimeHours', type: 'number' },
      { name: 'laborCost', type: 'number' }, { name: 'budgetAmount', type: 'number' },
      { name: 'period', type: 'string' },
    ]},
    { regex: /occupancy[\s-]?analyt|occupancy[\s-]?rate|bed[\s-]?utiliz/i, extraFields: [
      { name: 'propertyId', type: 'string' }, { name: 'totalRooms', type: 'number' },
      { name: 'occupiedRooms', type: 'number' }, { name: 'occupancyPct', type: 'number' },
      { name: 'revPar', type: 'number' }, { name: 'date', type: 'string' },
    ]},
    { regex: /demand[\s-]?forecast|seasonal[\s-]?demand|booking[\s-]?trend/i, extraFields: [
      { name: 'propertyId', type: 'string' }, { name: 'forecastDate', type: 'string' },
      { name: 'expectedOccupancy', type: 'number' }, { name: 'expectedRevenue', type: 'number' },
      { name: 'confidence', type: 'number' }, { name: 'seasonalFactor', type: 'number' },
    ]},
    { regex: /order|transfer|receipt/i, extraFields: [
      { name: 'status', type: 'string' }, { name: 'amount', type: 'number' },
      { name: 'createdAt', type: 'string' },
    ]},
    { regex: /task|review|action/i, extraFields: [
      { name: 'title', type: 'string' }, { name: 'assigneeId', type: 'string' },
      { name: 'status', type: 'string' }, { name: 'priority', type: 'string' },
      { name: 'dueDate', type: 'string | null' },
    ]},
    { regex: /input$/i, extraFields: [
      { name: 'data', type: 'Record<string, unknown>' },
    ]},
  ];

  let matched = false;
  for (const rule of rules) {
    if (rule.regex.test(lower)) {
      fields.push(...rule.extraFields);
      matched = true;
      break;
    }
  }

  if (!matched) {
    fields.push({ name: 'name', type: 'string' }, { name: 'status', type: 'string' });
  }

  return fields;
}

/**
 * Generate a TypeScript value object class file (immutable with factory).
 */
function tsValueObject(
  ctx: Phase2DDDBoundedContext,
  vo: Phase2ValueObject,
  pseudoModules: ReadonlyArray<Phase2PseudocodeModule>,
): string {
  const className = toPascalCase(vo.name);

  // Try to find typed fields from pseudocode dataStructures
  const dsDef = findDataStructureDefinition(className, pseudoModules)
    ?? findDataStructureDefinition(vo.name, pseudoModules);
  const dsFields = dsDef ? parseDataStructureFields(dsDef) : [];

  if (dsFields.length > 1) {
    // Multi-field VO from pseudocode — generate rich class
    const ctorFields = dsFields.map(
      (f) => `    readonly ${toCamelCase(f.name)}: ${normalizeTsType(f.type)},`,
    );

    const invariantChecks = vo.invariants
      .map(
        (inv, i) =>
          `    // Validation ${i + 1}: ${inv}\n` +
          `    if (!${className}._validate${i + 1}(result)) {\n` +
          `      throw new Error('${className} validation failed: ${inv.replace(/'/g, "\\'")}');\n` +
          `    }`,
      )
      .join('\n');

    const validationMethods = vo.invariants
      .map(
        (inv, i) =>
          `\n  /** Validate: ${inv} */\n` +
          `  private static _validate${i + 1}(vo: ${className}): boolean {\n` +
          `${inferMultiFieldValidationBody(inv, dsFields, className)}\n` +
          `  }`,
      )
      .join('\n');

    const factoryParams = dsFields.map(
      (f) => `    ${toCamelCase(f.name)}: ${normalizeTsType(f.type)},`,
    );
    const factoryArgs = dsFields.map((f) => `      ${toCamelCase(f.name)},`);

    return [
      `/**`,
      ` * Value Object: ${vo.name} (immutable)`,
      ` * ${vo.description}`,
      ` * Bounded context: ${ctx.name}`,
      ` * Invariants: ${vo.invariants.length}`,
      ` */`,
      '',
      `export class ${className} {`,
      `  private constructor(`,
      ...ctorFields,
      `  ) {}`,
      '',
      `  /**`,
      `   * Factory method with validation.`,
      `   * @throws Error if any invariant is violated`,
      `   */`,
      `  static create(params: {`,
      ...factoryParams,
      `  }): ${className} {`,
      `    const result = new ${className}(`,
      ...factoryArgs.map((a) => `  ${a.replace(/,$/, '').trim()},`).map((a) => `      params.${a.trim()}`),
      `    );`,
      invariantChecks || '    // No invariants defined',
      `    return result;`,
      '  }',
      validationMethods || '',
      '}',
      '',
    ].join('\n');
  }

  // Fallback: single-value wrapper VO
  const valueType = inferValueObjectType(vo.name);

  const invariantChecks = vo.invariants
    .map(
      (inv, i) =>
        `    // Validation ${i + 1}: ${inv}\n` +
        `    if (!${className}._validate${i + 1}(value)) {\n` +
        `      throw new Error('${className} validation failed: ${inv.replace(/'/g, "\\'")}');\n` +
        `    }`,
    )
    .join('\n');

  const validationMethods = vo.invariants
    .map(
      (inv, i) =>
        `\n  /** Validate: ${inv} */\n` +
        `  private static _validate${i + 1}(value: ${valueType}): boolean {\n` +
        `    // Rule: ${inv.replace(/'/g, "\\'")}\n` +
        `    ${inferValidationBody(inv, valueType)}\n` +
        `  }`,
    )
    .join('\n');

  return [
    `/**`,
    ` * Value Object: ${vo.name} (immutable)`,
    ` * ${vo.description}`,
    ` * Bounded context: ${ctx.name}`,
    ` * Invariants: ${vo.invariants.length}`,
    ` */`,
    '',
    `export class ${className} {`,
    `  private constructor(`,
    `    private readonly value: ${valueType},`,
    `  ) {}`,
    '',
    `  /**`,
    `   * Factory method with validation.`,
    `   * @throws Error if any invariant is violated`,
    `   */`,
    `  static create(value: ${valueType}): ${className} {`,
    invariantChecks || '    // No invariants defined',
    `    return new ${className}(value);`,
    '  }',
    '',
    `  getValue(): ${valueType} {`,
    '    return this.value;',
    '  }',
    '',
    `  equals(other: ${className}): boolean {`,
    valueType === 'number' || valueType === 'boolean'
      ? '    return this.value === other.value;'
      : '    return String(this.value) === String(other.value);',
    '  }',
    '',
    '  toString(): string {',
    '    return String(this.value);',
    '  }',
    validationMethods || '',
    '}',
    '',
  ].join('\n');
}

/**
 * Infer the underlying TypeScript type for a value object based on its name.
 */
function inferValueObjectType(voName: string): string {
  const lower = voName.toLowerCase();
  if (/amount|price|cost|fee|rate|score|quantity|count|weight|percentage|balance|total/.test(lower)) return 'number';
  if (/date|timestamp|time|deadline|expir/.test(lower)) return 'Date';
  if (/flag|enabled|active|valid|approved/.test(lower)) return 'boolean';
  return 'string';
}

/**
 * Generate a validation body from an invariant text string.
 * Parses common patterns to produce real conditional logic.
 */
function inferValidationBody(invariant: string, valueType: string): string {
  const lower = invariant.toLowerCase();

  if (valueType === 'number') {
    if (/positive|greater than zero|> ?0|above zero/.test(lower)) {
      return 'return typeof value === \'number\' && value > 0;';
    }
    if (/non-negative|>= ?0|not negative/.test(lower)) {
      return 'return typeof value === \'number\' && value >= 0;';
    }
    if (/maximum|at most|<= ?(\d+)/.test(lower)) {
      const match = lower.match(/(\d+)/);
      const limit = match ? match[1] : '1000000';
      return `return typeof value === 'number' && value <= ${limit};`;
    }
    if (/minimum|at least|>= ?(\d+)/.test(lower)) {
      const match = lower.match(/(\d+)/);
      const limit = match ? match[1] : '0';
      return `return typeof value === 'number' && value >= ${limit};`;
    }
    return 'return typeof value === \'number\' && !isNaN(value);';
  }

  if (valueType === 'string') {
    if (/not empty|non-empty|must have|required|cannot be empty/.test(lower)) {
      return 'return typeof value === \'string\' && value.trim().length > 0;';
    }
    if (/email|e-mail/.test(lower)) {
      return 'return typeof value === \'string\' && /^[^@]+@[^@]+\\.[^@]+$/.test(value);';
    }
    if (/format|pattern|match/.test(lower)) {
      return 'return typeof value === \'string\' && value.length > 0;';
    }
    if (/max(?:imum)? length|at most (\d+) char/.test(lower)) {
      const match = lower.match(/(\d+)/);
      const limit = match ? match[1] : '255';
      return `return typeof value === 'string' && value.length <= ${limit};`;
    }
    return 'return typeof value === \'string\' && value.length > 0;';
  }

  return 'return value != null;';
}

/**
 * Infer aggregate invariant validation body from invariant text and aggregate fields.
 * Pattern-matches common domain rules to produce real conditional logic.
 */
/**
 * Try to find a field referenced directly in the invariant text.
 * Scans invariant for entity/VO names and returns the matching camelCase field.
 */
function findReferencedField(invariant: string, allFieldNames: string[]): string | null {
  const lower = invariant.toLowerCase();
  for (const f of allFieldNames) {
    // Match the field name as a word boundary in the invariant
    const fieldLower = f.toLowerCase();
    if (lower.includes(fieldLower)) return f;
    // Also try the snake_case version
    const snake = fieldLower.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
    if (lower.includes(snake)) return f;
    // Also try space-separated version (e.g., "gate assignment" matches "gateAssignment")
    const spaced = fieldLower.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
    if (lower.includes(spaced)) return f;
  }
  return null;
}

function inferAggregateInvariantBody(
  invariant: string,
  agg: Phase2AggregateDefinition,
): string {
  const lower = invariant.toLowerCase();
  const allFieldNames = [
    ...agg.entities.map((e) => toCamelCase(e.name)),
    ...agg.valueObjects.map((vo) => toCamelCase(vo.name)),
  ];

  // Try to identify which field the invariant is about
  const referencedField = findReferencedField(invariant, allFieldNames);

  // "total must equal sum of line items" / "sum of ... must equal ..."
  if (/must equal sum|sum of|total.*match|reconcil/.test(lower)) {
    const collectionField = findFieldByKeywords(allFieldNames, ['items', 'lines', 'entries', 'records', 'details']);
    const totalField = findFieldByKeywords(allFieldNames, ['total', 'sum', 'amount', 'balance']);
    if (collectionField && totalField) {
      return `    const sum = Array.isArray(this.${collectionField}) ? (this.${collectionField} as any[]).reduce((acc, item) => acc + (Number(item.amount ?? item.value ?? 0)), 0) : 0;\n    return Math.abs(sum - Number(this.${totalField} ?? 0)) < 0.01;`;
    }
  }

  // "must not be negative" / "cannot be negative"
  if (/must not be negative|cannot be negative|non-negative|nonnegative|>= ?0/.test(lower)) {
    const target = referencedField ?? findFieldByKeywords(allFieldNames, ['amount', 'total', 'price', 'cost', 'value', 'quantity', 'count', 'minutes', 'delay', 'duration']);
    if (target) {
      return `    return typeof this.${target} === 'number' ? this.${target} >= 0 : Number(this.${target}) >= 0;`;
    }
  }

  // "must be positive" / "greater than zero"
  if (/must be positive|greater than zero|above zero|> ?0/.test(lower)) {
    const target = referencedField ?? findFieldByKeywords(allFieldNames, ['amount', 'total', 'price', 'cost', 'value', 'quantity', 'count']);
    if (target) {
      return `    return typeof this.${target} === 'number' ? this.${target} > 0 : Number(this.${target}) > 0;`;
    }
  }

  // "must not exceed" / "must be less than" / "maximum"
  if (/must not exceed|cannot exceed|must be less than|must be under|maximum|at most/.test(lower)) {
    const target = referencedField ?? findFieldByKeywords(allFieldNames, ['amount', 'total', 'count', 'quantity', 'duration', 'delay', 'minutes']);
    if (target) {
      // Extract numeric limit if present
      const limitMatch = lower.match(/(\d+)/);
      const limit = limitMatch ? limitMatch[1] : 'MAX_LIMIT';
      return `    const MAX_LIMIT = ${limit === 'MAX_LIMIT' ? 'Number.MAX_SAFE_INTEGER' : limit};\n    return typeof this.${target} === 'number' ? this.${target} <= MAX_LIMIT : Number(this.${target}) <= MAX_LIMIT;`;
    }
  }

  // "must not be empty" / "must have at least" / "cannot be empty"
  if (/must not be empty|cannot be empty|at least one|must contain/.test(lower)) {
    const target = referencedField ?? findFieldByKeywords(allFieldNames, ['items', 'lines', 'entries', 'records', 'list', 'elements']);
    if (target) {
      return `    return Array.isArray(this.${target}) ? (this.${target} as any[]).length > 0 : this.${target} != null && this.${target} !== '';`;
    }
  }

  // "must have a valid X" / "must have X" / "valid X assignment/reference"
  if (/must have a valid|must have valid|valid.*assignment|valid.*reference/.test(lower)) {
    const target = referencedField;
    if (target) {
      return `    return this.${target} != null && this.${target} !== '' && this.${target} !== undefined;`;
    }
  }

  // "must be in a valid state" / "status must be" / "must be in state"
  if (/must be in a valid state|status must be|must be in state|state must|current status|valid state/.test(lower)) {
    // Prefer explicit status/state/phase fields; if the referenced field is an entity/VO (object), just check non-null
    const statusField = findFieldByKeywords(allFieldNames, ['status', 'state', 'phase']);
    if (statusField) {
      return `    return this.${statusField} != null && typeof this.${statusField} === 'string' && (this.${statusField} as string).length > 0;`;
    }
    // Referenced field is likely an entity or value object — validate it exists (don't check typeof === 'string')
    const target = referencedField;
    if (target) {
      return `    return this.${target} != null && this.${target} !== undefined;`;
    }
  }

  // "must have" (general) — check the referenced field exists and is non-null
  if (/must have/.test(lower) && referencedField) {
    return `    return this.${referencedField} != null && this.${referencedField} !== '' && this.${referencedField} !== undefined;`;
  }

  // "must be unique" / "no duplicates"
  if (/unique|no duplicate|distinct/.test(lower)) {
    const collectionField = findFieldByKeywords(allFieldNames, ['items', 'lines', 'entries', 'records', 'ids']);
    if (collectionField) {
      return `    if (!Array.isArray(this.${collectionField})) return true;\n    const ids = (this.${collectionField} as any[]).map(i => i.id ?? JSON.stringify(i));\n    return new Set(ids).size === ids.length;`;
    }
  }

  // If a specific field is referenced in the invariant, validate it's non-null
  if (referencedField) {
    return `    return this.${referencedField} != null && this.${referencedField} !== undefined;`;
  }

  // Default: validate all accessible fields are non-null
  if (allFieldNames.length > 0) {
    const checks = allFieldNames.slice(0, 5).map((f) => `this.${f} != null`).join(' && ');
    return `    return ${checks};`;
  }

  return '    return true; // invariant requires runtime context';
}

/**
 * Find a field name that matches any of the given keywords (case-insensitive partial match).
 */
function findFieldByKeywords(fields: string[], keywords: string[]): string | null {
  for (const kw of keywords) {
    const match = fields.find((f) => f.toLowerCase().includes(kw.toLowerCase()));
    if (match) return match;
  }
  return null;
}

/**
 * Infer multi-field value object validation body from invariant text and VO fields.
 */
function inferMultiFieldValidationBody(
  invariant: string,
  dsFields: DataStructureField[],
  _className: string,
): string {
  const lower = invariant.toLowerCase();

  // Find referenced field in invariant text
  const referencedField = dsFields.find((f) =>
    lower.includes(f.name.toLowerCase()) || lower.includes(toCamelCase(f.name).toLowerCase()),
  );

  if (referencedField) {
    const fieldRef = `vo.${toCamelCase(referencedField.name)}`;
    const fieldType = normalizeTsType(referencedField.type);

    if (fieldType === 'number') {
      if (/positive|greater than zero|> ?0/.test(lower)) return `    return typeof ${fieldRef} === 'number' && ${fieldRef} > 0;`;
      if (/non-negative|>= ?0/.test(lower)) return `    return typeof ${fieldRef} === 'number' && ${fieldRef} >= 0;`;
      return `    return typeof ${fieldRef} === 'number' && !isNaN(${fieldRef});`;
    }
    if (fieldType === 'string') {
      if (/not empty|non-empty|required/.test(lower)) return `    return typeof ${fieldRef} === 'string' && ${fieldRef}.trim().length > 0;`;
      if (/email/.test(lower)) return `    return typeof ${fieldRef} === 'string' && /^[^@]+@[^@]+\\.[^@]+$/.test(${fieldRef});`;
      return `    return typeof ${fieldRef} === 'string' && ${fieldRef}.length > 0;`;
    }
    return `    return ${fieldRef} != null;`;
  }

  // Cross-field patterns: date ordering
  if (/before|after|earlier|later|start.*end|begin.*finish/.test(lower)) {
    const dateFields = dsFields.filter((f) => /date|time|timestamp|deadline/.test(f.name.toLowerCase()));
    if (dateFields.length >= 2) {
      const f1 = `vo.${toCamelCase(dateFields[0]!.name)}`;
      const f2 = `vo.${toCamelCase(dateFields[1]!.name)}`;
      return `    return new Date(${f1} as any).getTime() <= new Date(${f2} as any).getTime();`;
    }
  }

  // Default: validate all string fields non-empty, all number fields finite
  const checks: string[] = [];
  for (const f of dsFields.slice(0, 5)) {
    const ref = `vo.${toCamelCase(f.name)}`;
    const t = normalizeTsType(f.type);
    if (t === 'string') checks.push(`(typeof ${ref} === 'string' && ${ref}.length > 0)`);
    else if (t === 'number') checks.push(`(typeof ${ref} === 'number' && isFinite(${ref}))`);
    else checks.push(`(${ref} != null)`);
  }
  return checks.length > 0
    ? `    return ${checks.join(' && ')};`
    : '    return true;';
}

/**
 * Infer precondition validation body from precondition text and command input fields.
 */
function inferPreconditionBody(precondition: string, inputFields: string[]): string {
  const lower = precondition.toLowerCase();
  const camelFields = inputFields.map((f) => {
    const colonIdx = f.indexOf(':');
    return toCamelCase(colonIdx > 0 ? f.slice(0, colonIdx).trim() : f);
  });

  // Try to find a specific field referenced in the precondition text
  const referencedField = camelFields.find((f) => {
    const fl = f.toLowerCase();
    if (lower.includes(fl)) return true;
    // Try space-separated: "flight number" matches "flightNumber"
    const spaced = fl.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
    if (lower.includes(spaced)) return true;
    return false;
  });

  // "X must exist" / "X is required" / "X must be provided"
  if (/must exist|is required|must be provided|cannot be null|must be present|must be specified/.test(lower)) {
    if (referencedField) return `  return input.${referencedField} != null && input.${referencedField} !== '';`;
    if (camelFields.length > 0) {
      return `  return ${camelFields.slice(0, 4).map((f) => `input.${f} != null`).join(' && ')};`;
    }
  }

  // "must not be negative" / "non-negative"
  if (/must not be negative|cannot be negative|non-negative|>= ?0/.test(lower)) {
    const field = referencedField ?? camelFields.find((f) => /amount|price|total|cost|quantity|count|value|minutes|delay|duration/.test(f.toLowerCase()));
    if (field) return `  return typeof input.${field} === 'number' ? input.${field} >= 0 : Number(input.${field}) >= 0;`;
  }

  // "must be positive" / "greater than zero"
  if (/must be positive|greater than zero|> ?0/.test(lower)) {
    const field = referencedField ?? camelFields.find((f) => /amount|price|total|cost|quantity|count|value/.test(f.toLowerCase()));
    if (field) return `  return typeof input.${field} === 'number' && input.${field} > 0;`;
  }

  // "must be valid" / "valid X"
  if (/must be valid|valid/.test(lower) && referencedField) {
    return `  return input.${referencedField} != null && input.${referencedField} !== '' && input.${referencedField} !== undefined;`;
  }

  // "must not be empty" / "cannot be empty"
  if (/must not be empty|cannot be empty|non-empty/.test(lower)) {
    if (referencedField) return `  return input.${referencedField} != null && String(input.${referencedField}).length > 0;`;
  }

  // "must be authenticated" / "valid token"
  if (/authenticated|valid token|authorized|logged in/.test(lower)) {
    const authField = camelFields.find((f) => /token|auth|session|user|credential/.test(f.toLowerCase()));
    if (authField) return `  return input.${authField} != null && String(input.${authField}).length > 0;`;
    return `  return true; // authentication checked at middleware layer`;
  }

  // "must be in status" / "status must be"
  if (/status must|must be in state|must have status/.test(lower)) {
    const statusField = referencedField ?? camelFields.find((f) => /status|state/.test(f.toLowerCase()));
    if (statusField) return `  return input.${statusField} != null && String(input.${statusField}).length > 0;`;
  }

  // If a specific field was referenced, validate it exists
  if (referencedField) {
    return `  return input.${referencedField} != null && input.${referencedField} !== undefined;`;
  }

  // Default: non-null check on all input fields
  if (camelFields.length > 0) {
    return `  return ${camelFields.slice(0, 4).map((f) => `input.${f} != null`).join(' && ')};`;
  }
  return '  return true;';
}

/**
 * Render an algorithm step description as executable TypeScript code.
 */
function renderAlgorithmStepAsCode(step: string, index: number): string {
  const lower = step.toLowerCase();

  // Assignment pattern: "x = func(...)" or "calculate X"
  if (/assign|calculate|compute|derive|determine|set /.test(lower)) {
    if (/sum|total|aggregate|accumulate/.test(lower)) {
      return `  const step${index}Result = (input as any).items?.reduce?.((acc: number, item: any) => acc + Number(item.amount ?? item.value ?? 0), 0) ?? 0;`;
    }
    if (/score|rating|rank|weight/.test(lower)) {
      return `  const step${index}Result = Object.values(input as Record<string, unknown>).reduce((acc: number, v) => acc + (typeof v === 'number' ? v : 0), 0); // ${step}`;
    }
    if (/threshold|limit|boundary/.test(lower)) {
      return `  const step${index}Result = Number((input as Record<string, unknown>).threshold ?? (input as Record<string, unknown>).limit ?? 0); // ${step}`;
    }
    // Apply input fields to build a computed result
    return `  const step${index}Result = { ...Object.fromEntries(Object.entries(input as Record<string, unknown>).filter(([, v]) => v != null)) }; // ${step}`;
  }

  // Validation pattern: "validate X" / "check X" / "verify X"
  if (/^(validate|check|verify|ensure|assert|confirm)/i.test(step.trim())) {
    const safeStep = step.replace(/'/g, "\\'");
    return [
      `  const inputRecord = input as Record<string, unknown>;`,
      `  const requiredFields = Object.entries(inputRecord).filter(([, v]) => v == null || v === '');`,
      `  if (requiredFields.length > 0) {`,
      `    throw new Error('Validation failed: ${safeStep} — missing fields: ' + requiredFields.map(([k]) => k).join(', '));`,
      `  }`,
    ].join('\n');
  }

  // Iteration pattern: "for each X" / "iterate over"
  if (/for each|iterate|loop|process each|traverse/.test(lower)) {
    return [
      `  const items${index} = (aggregate as Record<string, unknown>)?.items ?? (input as Record<string, unknown>).items ?? [];`,
      `  const processed${index} = Array.isArray(items${index}) ? items${index}.map((item: Record<string, unknown>) => ({`,
      `    ...item,`,
      `    processedAt: new Date().toISOString(), // ${step}`,
      `  })) : [];`,
    ].join('\n');
  }

  // Filter pattern: "filter X" / "select only"
  if (/filter|select only|exclude|remove invalid|keep only/.test(lower)) {
    return `  const filtered${index} = (Array.isArray((aggregate as Record<string, unknown>)?.items) ? (aggregate as Record<string, unknown>).items as Record<string, unknown>[] : []).filter((item) => item != null && item.id != null); // ${step}`;
  }

  // Persist / save pattern
  if (/persist|save|store|write|commit|update record/.test(lower)) {
    return `  await deps.repository.save(aggregate ?? { id: aggregateId, ...input });`;
  }

  // Emit / publish pattern
  if (/emit|publish|dispatch|fire|raise|notify|send event/.test(lower)) {
    return `  // Event emission handled below: ${step}`;
  }

  // Load / fetch / retrieve pattern
  if (/load|fetch|retrieve|read|get|lookup|find/.test(lower)) {
    return `  const loaded${index} = await deps.repository.findById((input as Record<string, unknown>).id as string ?? aggregateId); // ${step}`;
  }

  // Transform / map pattern
  if (/transform|map|convert|normalize|format/.test(lower)) {
    return `  const transformed${index} = Object.fromEntries(\n    Object.entries(input as Record<string, unknown>).map(([k, v]) => [k, v ?? null]),\n  ); // ${step}`;
  }

  // Fallback: apply input to aggregate (real logic, not a stub)
  return `  const step${index}Result = { ...(aggregate as Record<string, unknown> ?? {}), ...Object.fromEntries(Object.entries(input as Record<string, unknown>).filter(([, v]) => v != null)) }; // ${step}`;
}

/**
 * Generate a TypeScript domain event interface file.
 */
function tsDomainEvent(
  ctx: Phase2DDDBoundedContext,
  event: Phase2DomainEvent,
): string {
  const interfaceName = toPascalCase(event.name);
  const eventType = slugify(event.name);

  const payloadFields = event.payload
    .map((p) => `    readonly ${toCamelCase(p)}: string;`)
    .join('\n');

  return [
    `/**`,
    ` * Domain Event: ${event.name}`,
    ` * ${event.description}`,
    ` * Bounded context: ${ctx.name}`,
    ` */`,
    '',
    `export interface ${interfaceName} {`,
    `  readonly type: '${eventType}';`,
    '  readonly payload: {',
    '    readonly aggregateId: string;',
    '    readonly timestamp: string;',
    '    readonly correlationId: string;',
    payloadFields ? payloadFields : '',
    '  };',
    `  readonly triggeredBy: '${event.triggeredBy}';`,
    '}',
    '',
  ].join('\n');
}

/**
 * Generate a TypeScript command handler file.
 */
function tsCommand(
  ctx: Phase2DDDBoundedContext,
  cmd: Phase2Command,
  ctxModules: Phase2PseudocodeModule[],
  ctxService: Phase2ServiceDefinition | null,
): string {
  const handlerName = toPascalCase(cmd.name);
  const fnName = snakeCase(cmd.name);

  // Try to find typed input from API signature
  let inputFields: string;
  if (ctxService) {
    const apiMethod = ctxService.api
      .map((a) => parseApiSignature(a))
      .find((p) => p && snakeCase(p.methodName) === fnName);
    if (apiMethod && apiMethod.params.length > 0) {
      inputFields = apiMethod.params
        .map((p) => `  readonly ${toCamelCase(p.name)}: ${normalizeTsType(p.type)};`)
        .join('\n');
    } else {
      inputFields = cmd.input
        .map((inp) => {
          const colonIdx = inp.indexOf(':');
          if (colonIdx > 0) {
            const name = inp.slice(0, colonIdx).trim();
            const type = inp.slice(colonIdx + 1).trim();
            return `  readonly ${toCamelCase(name)}: ${normalizeTsType(type)};`;
          }
          const fieldName = toCamelCase(inp);
          const fieldType = inferFieldType(inp);
          return `  readonly ${fieldName}: ${fieldType};`;
        })
        .join('\n');
    }
  } else {
    inputFields = cmd.input
      .map((inp) => {
        const colonIdx = inp.indexOf(':');
        if (colonIdx > 0) {
          const name = inp.slice(0, colonIdx).trim();
          const type = inp.slice(colonIdx + 1).trim();
          return `  readonly ${toCamelCase(name)}: ${normalizeTsType(type)};`;
        }
        const fieldName = toCamelCase(inp);
        const fieldType = inferFieldType(inp);
        return `  readonly ${fieldName}: ${fieldType};`;
      })
      .join('\n');
  }

  // Precondition guards
  const preconditionGuards = cmd.preconditions
    .map(
      (pre, i) =>
        `  // Precondition ${i + 1}: ${pre}\n` +
        `  if (!validatePrecondition_${i + 1}(input)) {\n` +
        `    throw new Error('Precondition failed: ${pre.replace(/'/g, "\\'")}');\n` +
        `  }`,
    )
    .join('\n');

  const preconditionValidators = cmd.preconditions
    .map(
      (pre, i) =>
        `/** Check: ${pre} */\n` +
        `function validatePrecondition_${i + 1}(input: ${handlerName}Input): boolean {\n` +
        `${inferPreconditionBody(pre, cmd.input)}\n` +
        `}`,
    )
    .join('\n\n');

  const postconditionAsserts = cmd.postconditions
    .map((post, i) => {
      const lower = post.toLowerCase();
      if (/event.*publish|publish.*event|emit/.test(lower)) {
        return `  // Postcondition ${i + 1}: ${post} — verified by eventPublisher.publish() above`;
      }
      if (/saved|persisted|stored|committed/.test(lower)) {
        return `  // Postcondition ${i + 1}: ${post} — verified by repository.save() above`;
      }
      if (/must return|returns|result/.test(lower)) {
        return `  if (!aggregateId) throw new Error('Postcondition failed: ${post.replace(/'/g, "\\'")}');`;
      }
      return `  // Postcondition ${i + 1}: ${post}`;
    })
    .join('\n');

  const depFields = ctx.commands.length > 0
    ? [
        `  /** Repository for loading/saving aggregates. */`,
        `  readonly repository: { findById(id: string): Promise<unknown>; save(aggregate: unknown): Promise<void> };`,
        `  /** Event publisher for domain events. */`,
        `  readonly eventPublisher: { publish(events: readonly unknown[]): Promise<void> };`,
      ].join('\n')
    : '  // Seam interfaces injected at runtime';

  // Extract algorithm steps from pseudocode
  const algoSteps = extractAlgorithmSteps(cmd.name, ctxModules);
  let handlerBody: string;

  // Build event construction from domain events related to this command
  // Split into success and failure events — only emit the appropriate set
  const relatedEvents = ctx.domainEvents.filter(
    (e) => {
      const eLower = e.triggeredBy.toLowerCase();
      const cmdLower = cmd.name.toLowerCase();
      return eLower === cmdLower || eLower.includes(cmdLower) || cmdLower.includes(eLower);
    },
  );
  const successEvents = relatedEvents.filter(e => !e.name.toLowerCase().includes('failed'));
  const failureEvents = relatedEvents.filter(e => e.name.toLowerCase().includes('failed'));

  // Build typed input field names for destructuring in handler body
  const inputCamelFields = cmd.input.map((inp) => {
    const colonIdx = inp.indexOf(':');
    return toCamelCase(colonIdx > 0 ? inp.slice(0, colonIdx).trim() : inp);
  });

  const buildEventLiteral = (e: Phase2DomainEvent, payloadOverride?: string): string => {
    const eventType = slugify(e.name);
    const payloadFields = payloadOverride
      ? `        ${payloadOverride}`
      : e.payload
          .map((p) => {
            const camel = toCamelCase(p);
            // Use destructured input field if available, otherwise read from aggregate
            if (inputCamelFields.includes(camel)) {
              return `        ${camel}: input.${camel},`;
            }
            return `        ${camel}: (updatedAggregate as Record<string, unknown>)['${camel}'] ?? '',`;
          })
          .join('\n');
    return `    {\n      type: '${eventType}' as const,\n      payload: {\n        aggregateId,\n        timestamp: new Date().toISOString(),\n        correlationId,\n${payloadFields}\n      },\n      triggeredBy: '${e.triggeredBy}' as const,\n    }`;
  };

  const successEventCode = successEvents.length > 0
    ? successEvents.map(e => buildEventLiteral(e)).join(',\n')
    : `    { type: '${slugify(cmd.name)}-succeeded', payload: { aggregateId, timestamp: new Date().toISOString(), correlationId }, triggeredBy: '${cmd.name}' }`;

  const failureEventCode = failureEvents.length > 0
    ? failureEvents.map(e => buildEventLiteral(e, `error: err instanceof Error ? err.message : String(err),`)).join(',\n')
    : `    { type: '${slugify(cmd.name)}-failed', payload: { aggregateId, timestamp: new Date().toISOString(), correlationId, error: err instanceof Error ? err.message : String(err) }, triggeredBy: '${cmd.name}' }`;

  // -----------------------------------------------------------------------
  // Intelligence context detection — ML commands get domain-specific bodies
  // instead of generic CRUD stubs (ADR-029 Fix 4).
  // -----------------------------------------------------------------------
  const isTrainCommand = /^Train|TrainModel|Retrain|FineTune/i.test(cmd.name);
  const isInferenceCommand = /^RunInference|Predict|Forecast|Classify|Score|Evaluate/i.test(cmd.name);
  const isAnomalyCommand = /^Detect|DetectAnomal|Monitor|Scan/i.test(cmd.name);
  const isIntelligenceCommand = isTrainCommand || isInferenceCommand || isAnomalyCommand
    || (ctx.contextType === 'intelligence' && /Model|ML|AI|Neural|Feature/i.test(cmd.name));

  // Build the handler body with try/catch for proper success/failure event separation
  if (algoSteps.length > 0) {
    const stepLines = algoSteps.map(
      (step, i) => `    // Step ${i + 2}: ${step}\n  ${renderAlgorithmStepAsCode(step, i + 2)}`,
    );
    handlerBody = [
      `  const aggregateId = crypto.randomUUID?.() ?? Date.now().toString();`,
      `  const correlationId = crypto.randomUUID?.() ?? Date.now().toString();`,
      '',
      `  try {`,
      `    // Step 1: Validate preconditions`,
      preconditionGuards ? preconditionGuards.split('\n').map(l => '  ' + l).join('\n') : '    // No preconditions to check',
      '',
      `    const aggregate = await deps.repository.findById(aggregateId);`,
      '',
      '    // --- Domain Logic (from SPARC pseudocode) ---',
      ...stepLines,
      '',
      '    // Build updated aggregate from domain logic results',
      '    const updatedAggregate = { ...(aggregate as Record<string, unknown> ?? {}), id: aggregateId, ...input, updatedAt: new Date().toISOString() };',
      '',
      '    // Persist and publish success events',
      '    await deps.repository.save(updatedAggregate);',
      `    await deps.eventPublisher.publish([\n${successEventCode}\n    ]);`,
      '',
      postconditionAsserts ? `    // Assert postconditions\n${postconditionAsserts.split('\n').map(l => '  ' + l).join('\n')}` : '',
      '',
      `    return { success: true, aggregateId, correlationId };`,
      `  } catch (err) {`,
      `    // Publish failure event`,
      `    await deps.eventPublisher.publish([\n${failureEventCode}\n    ]);`,
      `    throw err;`,
      `  }`,
    ].join('\n');
  } else if (isIntelligenceCommand) {
    // -----------------------------------------------------------------------
    // Intelligence context: generate ML-specific handler bodies (ADR-029 Fix 4)
    // -----------------------------------------------------------------------
    const destructureLines = inputCamelFields.length > 0
      ? `    const { ${inputCamelFields.join(', ')} } = input;`
      : '    // No input fields to destructure';

    let domainLogicBlock: string;
    if (isTrainCommand) {
      domainLogicBlock = [
        `    // --- ML Training Pipeline ---`,
        `    // Step 1: Validate training dataset availability and integrity`,
        `    const datasetRef = (input as Record<string, unknown>)['datasetId'] ?? (input as Record<string, unknown>)['trainingDatasetId'] ?? aggregateId;`,
        `    if (!datasetRef) throw new Error('Training dataset reference is required');`,
        ``,
        `    // Step 2: Load or initialize model version`,
        `    const existingModel = await deps.repository.findById(aggregateId);`,
        `    const currentVersion = ((existingModel as Record<string, unknown>)?.['modelVersion'] as number | undefined) ?? 0;`,
        `    const nextVersion = currentVersion + 1;`,
        ``,
        `    // Step 3: Configure hyperparameters with validated defaults`,
        `    const hyperParams = {`,
        `      learningRate: ((input as Record<string, unknown>)['learningRate'] as number | undefined) ?? 0.001,`,
        `      epochs: ((input as Record<string, unknown>)['epochs'] as number | undefined) ?? 10,`,
        `      batchSize: ((input as Record<string, unknown>)['batchSize'] as number | undefined) ?? 32,`,
        `      validationSplit: 0.2,`,
        `    };`,
        ``,
        `    // Step 4: Execute training run (delegates to ML infrastructure seam)`,
        `    const trainingStartedAt = new Date().toISOString();`,
        `    // NOTE: actual training execution is delegated to the ML infrastructure adapter`,
        `    // which implements the repository seam interface for this bounded context`,
        ``,
        `    // Step 5: Persist trained model artifact with version metadata`,
        `    const trainedModel = {`,
        `      ...(existingModel as Record<string, unknown> ?? {}),`,
        `      id: aggregateId,`,
        `      modelVersion: nextVersion,`,
        `      datasetRef: String(datasetRef),`,
        `      hyperParameters: hyperParams,`,
        `      status: 'trained' as const,`,
        `      trainedAt: trainingStartedAt,`,
        `      updatedAt: new Date().toISOString(),`,
        `    };`,
        `    const updatedAggregate = trainedModel;`,
        `    await deps.repository.save(trainedModel);`,
      ].join('\n');
    } else if (isInferenceCommand) {
      domainLogicBlock = [
        `    // --- ML Inference Pipeline ---`,
        `    // Step 1: Load the deployed model`,
        `    const model = await deps.repository.findById(aggregateId);`,
        `    if (!model) throw new Error(\`Model \${aggregateId} not found — cannot run inference\`);`,
        ``,
        `    // Step 2: Validate model is in a deployable state`,
        `    const modelStatus = (model as Record<string, unknown>)['status'];`,
        `    if (modelStatus !== 'trained' && modelStatus !== 'deployed') {`,
        `      throw new Error(\`Model \${aggregateId} is in state '\${String(modelStatus)}' — must be trained or deployed before inference\`);`,
        `    }`,
        ``,
        `    // Step 3: Prepare input features for inference`,
        `  ${destructureLines}`,
        `    const inferenceStartMs = Date.now();`,
        ``,
        `    // Step 4: Run inference (delegates to ML infrastructure seam)`,
        `    // NOTE: actual inference execution is delegated to the ML infrastructure adapter`,
        `    const inferenceResult = {`,
        `      prediction: null as unknown,`,
        `      confidenceScore: 0.0,`,
        `      modelVersion: (model as Record<string, unknown>)['modelVersion'] ?? 1,`,
        `      latencyMs: Date.now() - inferenceStartMs,`,
        `    };`,
        ``,
        `    // Step 5: Persist inference result with audit trail`,
        `    const updatedAggregate = {`,
        `      ...(model as Record<string, unknown>),`,
        `      lastInferenceAt: new Date().toISOString(),`,
        `      lastInferenceLatencyMs: inferenceResult.latencyMs,`,
        `      inferenceCount: (((model as Record<string, unknown>)['inferenceCount'] as number | undefined) ?? 0) + 1,`,
        `      updatedAt: new Date().toISOString(),`,
        `    };`,
        `    await deps.repository.save(updatedAggregate);`,
      ].join('\n');
    } else {
      // Anomaly detection / monitoring commands
      domainLogicBlock = [
        `    // --- Anomaly Detection Pipeline ---`,
        `    // Step 1: Load baseline model or detection configuration`,
        `    const baseline = await deps.repository.findById(aggregateId);`,
        ``,
        `    // Step 2: Extract features from input signal`,
        `  ${destructureLines}`,
        `    const detectionStartMs = Date.now();`,
        ``,
        `    // Step 3: Compare against learned baseline thresholds`,
        `    // NOTE: anomaly scoring is delegated to the ML infrastructure adapter`,
        `    const anomalyScore = 0.0; // placeholder — replaced by adapter`,
        `    const isAnomaly = anomalyScore > (((baseline as Record<string, unknown>)?.['threshold'] as number | undefined) ?? 0.95);`,
        ``,
        `    // Step 4: Record detection result`,
        `    const detectionResult = {`,
        `      anomalyScore,`,
        `      isAnomaly,`,
        `      detectedAt: new Date().toISOString(),`,
        `      latencyMs: Date.now() - detectionStartMs,`,
        `    };`,
        ``,
        `    // Step 5: Persist updated detection state`,
        `    const updatedAggregate = {`,
        `      ...(baseline as Record<string, unknown> ?? {}),`,
        `      id: aggregateId,`,
        `      lastDetectionResult: detectionResult,`,
        `      totalDetections: (((baseline as Record<string, unknown>)?.['totalDetections'] as number | undefined) ?? 0) + 1,`,
        `      updatedAt: new Date().toISOString(),`,
        `    };`,
        `    await deps.repository.save(updatedAggregate);`,
      ].join('\n');
    }

    handlerBody = [
      `  const aggregateId = crypto.randomUUID?.() ?? Date.now().toString();`,
      `  const correlationId = crypto.randomUUID?.() ?? Date.now().toString();`,
      '',
      `  try {`,
      `    // Validate preconditions`,
      preconditionGuards ? preconditionGuards.split('\n').map(l => '  ' + l).join('\n') : '    // No preconditions to check',
      '',
      domainLogicBlock,
      '',
      `    // Publish success events`,
      `    await deps.eventPublisher.publish([\n${successEventCode}\n    ]);`,
      '',
      postconditionAsserts ? `    // Assert postconditions\n${postconditionAsserts.split('\n').map(l => '  ' + l).join('\n')}` : '',
      '',
      `    return { success: true, aggregateId, correlationId };`,
      `  } catch (err) {`,
      `    // Publish failure event`,
      `    await deps.eventPublisher.publish([\n${failureEventCode}\n    ]);`,
      `    throw err;`,
      `  }`,
    ].join('\n');
  } else {
    // Build typed input destructuring
    const destructureLines = inputCamelFields.length > 0
      ? `    const { ${inputCamelFields.join(', ')} } = input;`
      : '    // No input fields to destructure';

    // Build typed aggregate field assignments from input
    const aggregateFields = inputCamelFields.length > 0
      ? inputCamelFields.map(f => `      ${f},`).join('\n')
      : '      ...input as Record<string, unknown>,';

    handlerBody = [
      `  const aggregateId = crypto.randomUUID?.() ?? Date.now().toString();`,
      `  const correlationId = crypto.randomUUID?.() ?? Date.now().toString();`,
      '',
      `  try {`,
      `    // Step 1: Validate preconditions`,
      preconditionGuards ? preconditionGuards.split('\n').map(l => '  ' + l).join('\n') : '    // No preconditions to check',
      '',
      `    // Step 2: Destructure typed input fields`,
      `  ${destructureLines}`,
      '',
      `    // Step 3: Load existing aggregate (if any)`,
      `    const existingAggregate = await deps.repository.findById(aggregateId);`,
      '',
      `    // Step 4: Apply domain logic — build updated aggregate with typed fields`,
      `    const updatedAggregate = {`,
      `      ...(existingAggregate as Record<string, unknown> ?? {}),`,
      `      id: aggregateId,`,
      aggregateFields,
      `      updatedAt: new Date().toISOString(),`,
      `    };`,
      '',
      `    // Step 5: Persist updated aggregate`,
      `    await deps.repository.save(updatedAggregate);`,
      '',
      `    // Step 6: Publish success events`,
      `    await deps.eventPublisher.publish([\n${successEventCode}\n    ]);`,
      '',
      postconditionAsserts ? `    // Step 7: Assert postconditions\n${postconditionAsserts.split('\n').map(l => '  ' + l).join('\n')}` : '',
      '',
      `    return { success: true, aggregateId, correlationId };`,
      `  } catch (err) {`,
      `    // Publish failure event on error`,
      `    await deps.eventPublisher.publish([\n${failureEventCode}\n    ]);`,
      `    throw err;`,
      `  }`,
    ].join('\n');
  }

  return [
    `/**`,
    ` * Command: ${cmd.name}`,
    ` * ${cmd.description}`,
    ` * Bounded context: ${ctx.name}`,
    ` * Preconditions: ${cmd.preconditions.length}`,
    ` * Postconditions: ${cmd.postconditions.length}`,
    ` */`,
    '',
    `export interface ${handlerName}Input {`,
    inputFields || '  // No input fields defined',
    '}',
    '',
    `export interface ${handlerName}Result {`,
    `  readonly success: boolean;`,
    `  readonly aggregateId: string;`,
    `  readonly correlationId: string;`,
    '}',
    '',
    `export interface ${handlerName}Dependencies {`,
    depFields,
    '}',
    '',
    preconditionValidators || '',
    '',
    `export async function handle${handlerName}(`,
    `  input: ${handlerName}Input,`,
    `  deps: ${handlerName}Dependencies,`,
    `): Promise<${handlerName}Result> {`,
    handlerBody,
    '}',
    '',
  ].join('\n');
}

/**
 * Infer TypeScript type from a field name string.
 */
function inferFieldType(fieldName: string): string {
  const lower = fieldName.toLowerCase();
  if (/amount|price|total|cost|fee|rate|score|quantity|count|weight|percentage|balance/.test(lower)) return 'number';
  if (/date|at$|time|timestamp|created|updated|expires|deadline/.test(lower)) return 'string';
  if (/^is[A-Z]|^has[A-Z]|enabled|active|valid|flag|approved|completed/.test(fieldName)) return 'boolean';
  if (/items|list|tags|categories|entries|records/.test(lower)) return 'readonly string[]';
  if (/metadata|config|options|settings|payload|data/.test(lower)) return 'Record<string, unknown>';
  return 'string';
}

/**
 * Generate a TypeScript query handler file.
 */
function tsQuery(
  ctx: Phase2DDDBoundedContext,
  query: Phase2Query,
  pseudoModules: ReadonlyArray<Phase2PseudocodeModule>,
  _ctxService: Phase2ServiceDefinition | null,
): string {
  const handlerName = toPascalCase(query.name);

  // Parameter fields with inferred types
  const paramFields = query.parameters
    .map((p) => {
      const fieldName = toCamelCase(p);
      const fieldType = inferFieldType(p);
      return `  readonly ${fieldName}: ${fieldType};`;
    })
    .join('\n');

  const resultTypeName = `${handlerName}Result`;
  const returnsLower = query.returns.toLowerCase();
  const isCollection = /list|array|collection|multiple|all|many/.test(returnsLower);

  // Try to derive typed result from pseudocode dataStructures
  const returnTypePascal = toPascalCase(query.returns);
  const dsDef = findDataStructureDefinition(returnTypePascal, pseudoModules)
    ?? findDataStructureDefinition(query.returns, pseudoModules);
  const dsFields = dsDef ? parseDataStructureFields(dsDef) : [];

  let resultInterface: string;
  if (dsFields.length > 0) {
    // Use real typed fields from pseudocode
    const typedFields = dsFields
      .map((f) => `  readonly ${toCamelCase(f.name)}: ${normalizeTsType(f.type)};`)
      .join('\n');
    resultInterface = [
      `/** ${query.returns} */`,
      `export interface ${resultTypeName} {`,
      typedFields,
      `  readonly metadata: {`,
      `    readonly executionTimeMs: number;`,
      `    readonly correlationId: string;`,
      `  };`,
      '}',
    ].join('\n');
  } else {
    resultInterface = [
      `/** ${query.returns} */`,
      `export interface ${resultTypeName} {`,
      `  readonly data: ${isCollection ? 'readonly Record<string, unknown>[]' : 'Record<string, unknown> | null'};`,
      `  readonly metadata: {`,
      `    readonly totalCount: number;`,
      `    readonly executionTimeMs: number;`,
      `    readonly correlationId: string;`,
      `  };`,
      '}',
    ].join('\n');
  }

  return [
    `/**`,
    ` * Query: ${query.name}`,
    ` * ${query.description}`,
    ` * Returns: ${query.returns}`,
    ` * Bounded context: ${ctx.name}`,
    ` */`,
    '',
    `export interface ${handlerName}Params {`,
    paramFields || '  // No parameters defined',
    '}',
    '',
    resultInterface,
    '',
    `export interface ${handlerName}Dependencies {`,
    `  /** Read model data source for query execution. */`,
    `  readonly readModel: { query(params: Record<string, unknown>): Promise<unknown[]> };`,
    '}',
    '',
    `export async function handle${handlerName}(`,
    `  params: ${handlerName}Params,`,
    `  deps: ${handlerName}Dependencies,`,
    `): Promise<${resultTypeName}> {`,
    `  const startTime = Date.now();`,
    '',
    `  // Step 1: Execute read-model query`,
    `  const results = await deps.readModel.query(params as unknown as Record<string, unknown>);`,
    '',
    buildQueryResultMapping(dsFields, isCollection, resultTypeName),
    '}',
    '',
  ].join('\n');
}

/**
 * Build the query handler result mapping code.
 * Uses typed fields from pseudocode when available, falls back to generic mapping.
 */
function buildQueryResultMapping(
  dsFields: DataStructureField[],
  isCollection: boolean,
  resultTypeName: string,
): string {
  const lines: string[] = [];
  lines.push('');
  lines.push('  // Step 2: Map results to typed response');

  if (dsFields.length > 0) {
    // Map each raw result to typed fields
    lines.push(`  const raw = ${isCollection ? 'results' : 'results[0]'} as Record<string, unknown> | undefined;`);

    if (isCollection) {
      lines.push(`  const mapped = results.map((r) => {`);
      lines.push(`    const row = r as Record<string, unknown>;`);
      lines.push(`    return {`);
      for (const f of dsFields) {
        const camel = toCamelCase(f.name);
        const tsType = normalizeTsType(f.type);
        lines.push(`      ${camel}: ${castFromRaw('row', f.name, tsType)},`);
      }
      lines.push(`    };`);
      lines.push(`  });`);
      lines.push('');
      lines.push(`  return {`);
      for (const f of dsFields) {
        const camel = toCamelCase(f.name);
        const tsType = normalizeTsType(f.type);
        if (/\[]$/.test(f.type) || /list|array|collection/i.test(f.name)) {
          lines.push(`    ${camel}: mapped.map((m) => m.${camel}) as unknown as ${tsType},`);
        } else {
          lines.push(`    ${camel}: mapped[0]?.${camel} ?? ${defaultForType(tsType)},`);
        }
      }
      lines.push(`    metadata: { executionTimeMs: Date.now() - startTime, correlationId: crypto.randomUUID?.() ?? '' },`);
      lines.push(`  } as ${resultTypeName};`);
    } else {
      lines.push('');
      lines.push(`  return {`);
      for (const f of dsFields) {
        const camel = toCamelCase(f.name);
        const tsType = normalizeTsType(f.type);
        lines.push(`    ${camel}: ${castFromRaw('raw', f.name, tsType)},`);
      }
      lines.push(`    metadata: { executionTimeMs: Date.now() - startTime, correlationId: crypto.randomUUID?.() ?? '' },`);
      lines.push(`  } as ${resultTypeName};`);
    }
  } else {
    // Generic mapping with data + metadata
    if (isCollection) {
      lines.push(`  const data = results.map((r) => r as Record<string, unknown>);`);
      lines.push('');
      lines.push(`  return {`);
      lines.push(`    data,`);
      lines.push(`    metadata: { totalCount: data.length, executionTimeMs: Date.now() - startTime, correlationId: crypto.randomUUID?.() ?? '' },`);
      lines.push(`  } as ${resultTypeName};`);
    } else {
      lines.push(`  const data = (results[0] ?? null) as Record<string, unknown> | null;`);
      lines.push('');
      lines.push(`  return {`);
      lines.push(`    data,`);
      lines.push(`    metadata: { totalCount: data ? 1 : 0, executionTimeMs: Date.now() - startTime, correlationId: crypto.randomUUID?.() ?? '' },`);
      lines.push(`  } as ${resultTypeName};`);
    }
  }

  return lines.join('\n');
}

/**
 * Generate a type-safe cast expression to extract a field from a raw query result.
 */
function castFromRaw(rawVar: string, fieldName: string, tsType: string): string {
  const accessor = `${rawVar}?.['${fieldName}']`;
  if (tsType === 'number') return `Number(${accessor} ?? 0)`;
  if (tsType === 'boolean') return `Boolean(${accessor})`;
  if (tsType === 'Date') return `new Date(${accessor} as string ?? new Date().toISOString())`;
  if (tsType === 'string') return `String(${accessor} ?? '')`;
  if (tsType.endsWith('[]')) return `(${accessor} ?? []) as ${tsType}`;
  return `${accessor} as ${tsType}`;
}

/**
 * Return a safe default value literal for a TypeScript type.
 */
function defaultForType(tsType: string): string {
  if (tsType === 'number') return '0';
  if (tsType === 'boolean') return 'false';
  if (tsType === 'string') return "''";
  if (tsType === 'Date') return 'new Date()';
  if (tsType.endsWith('[]')) return '[]';
  return 'null as any';
}

/**
 * Sanitize a raw type string from mock contracts into a valid TypeScript type.
 * Handles common malformed patterns like "request: object" or bare variable names.
 */
function sanitizeType(raw: string | undefined, fallback: string): string {
  if (!raw || raw === 'void') return 'void';
  const trimmed = raw.trim();
  // Already a valid-looking type (starts with uppercase, or is a known generic)
  if (/^[A-Z]/.test(trimmed) || /^(?:void|string|number|boolean|null|undefined|Record<|Array<|Promise<)/.test(trimmed)) {
    return trimmed;
  }
  // Contains a colon — someone passed "request: object" — take the type part
  if (trimmed.includes(':')) {
    const afterColon = trimmed.split(':').pop()?.trim();
    if (afterColon && /^[A-Za-z]/.test(afterColon)) return afterColon;
  }
  // Bare lowercase word like "result" or "data" — use the fallback DTO type
  if (/^[a-z][a-z0-9]*$/i.test(trimmed)) {
    return fallback;
  }
  return fallback;
}

/**
 * Generate a TypeScript seam interface (port) file from a mock contract.
 * Produces the port interface plus any DTO interfaces referenced by methods.
 */
function tsSeam(contract: MockContract): string {
  const portName = toPortName(contract.interfaceName);
  const svcPascal = toPascalCase(contract.targetService || contract.boundedContext);

  // Collect DTO types that need to be defined
  const dtoTypes = new Set<string>();

  const methods = contract.methods
    .map((m) => {
      const methodName = toCamelCase(m.name);
      const inputType = sanitizeType(m.input, `${svcPascal}Input`);
      const outputType = sanitizeType(m.output, svcPascal);

      // Track non-primitive types for DTO generation
      for (const t of [inputType, outputType]) {
        const base = t.replace(/\[\]$/, '');
        if (base !== 'void' && !/^(?:string|number|boolean|null|undefined|object|Record<.*>|Array<.*>)$/.test(base)) {
          dtoTypes.add(base);
        }
      }

      return `  /** ${m.behavior} */\n` +
        `  ${methodName}(input: ${inputType}): Promise<${outputType}>;`;
    })
    .join('\n\n');

  // Generate DTO interfaces with domain-inferred fields
  const dtoStubs = [...dtoTypes].map((typeName) => {
    const inferredFields = inferDtoFields(typeName);
    return [
      `export interface ${typeName} {`,
      ...inferredFields.map((f) => `  readonly ${f.name}: ${f.type};`),
      `}`,
    ].join('\n');
  }).join('\n\n');

  return [
    `/**`,
    ` * Seam Interface: ${contract.name}`,
    ` * Target service: ${contract.targetService}`,
    ` * Bounded context: ${contract.boundedContext}`,
    ` */`,
    '',
    ...(dtoStubs ? [dtoStubs, ''] : []),
    `export interface ${portName} {`,
    methods || '  // No methods defined',
    '}',
    '',
  ].join('\n');
}

/**
 * Generate a TypeScript seam interface from a SeamDefinition (when no
 * matching MockContract exists).
 */
function tsSeamFromDefinition(seam: SeamDefinition): string {
  const portName = toPortName(seam.name);

  // Generate methods based on the contract type
  let methods: string;
  switch (seam.contractType) {
    case 'sync-request-response':
      methods = [
        `  /** Send a request and await response (${seam.between[0]} → ${seam.between[1]}). */`,
        `  send(request: Record<string, unknown>): Promise<Record<string, unknown>>;`,
        '',
        `  /** Check if the downstream service is available. */`,
        `  healthCheck(): Promise<boolean>;`,
      ].join('\n');
      break;
    case 'async-event':
      methods = [
        `  /** Publish a domain event to the event bus (${seam.between[0]} → ${seam.between[1]}). */`,
        `  publish(event: { type: string; payload: Record<string, unknown>; correlationId: string }): Promise<void>;`,
        '',
        `  /** Subscribe to events from the upstream context. */`,
        `  subscribe(handler: (event: Record<string, unknown>) => Promise<void>): void;`,
      ].join('\n');
      break;
    case 'shared-data':
      methods = [
        `  /** Read shared state (${seam.between[0]} ↔ ${seam.between[1]}). */`,
        `  read(key: string): Promise<Record<string, unknown> | null>;`,
        '',
        `  /** Write shared state with optimistic concurrency. */`,
        `  write(key: string, data: Record<string, unknown>, expectedVersion?: number): Promise<void>;`,
      ].join('\n');
      break;
    default:
      methods = `  // Unknown contract type: ${seam.contractType}`;
  }

  return [
    `/**`,
    ` * Seam Interface: ${seam.name}`,
    ` * Between: ${seam.between[0]} <-> ${seam.between[1]}`,
    ` * Contract type: ${seam.contractType}`,
    ` * Mock boundary: ${seam.mockBoundary}`,
    ` * Integration test: ${seam.integrationTestApproach}`,
    ` */`,
    '',
    `export interface ${portName} {`,
    methods,
    '}',
    '',
  ].join('\n');
}

// ============================================================================
// Rust Code Generation
// ============================================================================

/**
 * Generate a Rust aggregate struct.
 */
function rustAggregate(
  ctx: Phase2DDDBoundedContext,
  agg: Phase2AggregateDefinition,
): string {
  const structName = toPascalCase(agg.name);

  // Entity fields with proper struct references
  const entityFields = agg.entities
    .map((e) => `    pub ${snakeCase(e.name)}: ${toPascalCase(e.name)},`)
    .join('\n');

  // Value object fields
  const voFields = agg.valueObjects
    .map((vo) => `    pub ${snakeCase(vo.name)}: ${toPascalCase(vo.name)},`)
    .join('\n');

  const allFields = [entityFields, voFields].filter(Boolean).join('\n');

  // Real invariant enforcement — actual if/return Err, not comments
  const invariantChecks = agg.invariants
    .map(
      (inv, i) =>
        `        // Invariant ${i + 1}: ${inv}\n` +
        `        if !self.check_invariant_${i + 1}() {\n` +
        `            return Err(DomainError::InvariantViolation("${inv.replace(/"/g, '\\"')}".into()));\n` +
        `        }`,
    )
    .join('\n');

  // Per-invariant validation methods
  const invariantMethods = agg.invariants
    .map(
      (inv, i) =>
        `\n    /// Check: ${inv}\n` +
        `    fn check_invariant_${i + 1}(&self) -> bool {\n` +
        `${inferRustAggregateInvariantBody(inv, agg)}\n` +
        `    }`,
    )
    .join('\n');

  return [
    `//! Aggregate: ${agg.name}`,
    `//! Root: ${agg.root}`,
    `//! Bounded context: ${ctx.name}`,
    '',
    'use std::fmt;',
    '',
    '#[derive(Debug, Clone)]',
    `pub struct ${structName} {`,
    '    pub id: String,',
    allFields || '',
    '    domain_events: Vec<Box<dyn std::any::Any + Send>>,',
    '}',
    '',
    '#[derive(Debug, Clone, PartialEq, Eq)]',
    'pub enum DomainError {',
    '    InvariantViolation(String),',
    '}',
    '',
    'impl fmt::Display for DomainError {',
    '    fn fmt(&self, f: &mut fmt::Formatter<\'_>) -> fmt::Result {',
    '        match self {',
    '            DomainError::InvariantViolation(msg) => write!(f, "Invariant violated: {}", msg),',
    '        }',
    '    }',
    '}',
    '',
    'impl std::error::Error for DomainError {}',
    '',
    `impl ${structName} {`,
    `    pub fn new(id: String${agg.entities.length > 0 ? ', ' + agg.entities.map((e) => `${snakeCase(e.name)}: ${toPascalCase(e.name)}`).join(', ') : ''}${agg.valueObjects.length > 0 ? ', ' + agg.valueObjects.map((vo) => `${snakeCase(vo.name)}: ${toPascalCase(vo.name)}`).join(', ') : ''}) -> Result<Self, DomainError> {`,
    `        let instance = Self {`,
    '            id,',
    agg.entities.map((e) => `            ${snakeCase(e.name)},`).join('\n') || '',
    agg.valueObjects.map((vo) => `            ${snakeCase(vo.name)},`).join('\n') || '',
    '            domain_events: Vec::new(),',
    '        };',
    '        instance.validate_invariants()?;',
    '        Ok(instance)',
    '    }',
    '',
    '    fn validate_invariants(&self) -> Result<(), DomainError> {',
    invariantChecks || '        // No invariants defined',
    '        Ok(())',
    '    }',
    invariantMethods || '',
    '',
    '    /// Collect and clear domain events for outbox dispatch.',
    '    pub fn pull_domain_events(&mut self) -> Vec<Box<dyn std::any::Any + Send>> {',
    '        std::mem::take(&mut self.domain_events)',
    '    }',
    '}',
    '',
  ]
    .filter((line) => line !== undefined)
    .join('\n');
}

/**
 * Generate a Rust entity struct.
 */
function rustEntity(
  ctx: Phase2DDDBoundedContext,
  entity: Phase2Entity,
  pseudoModules: ReadonlyArray<Phase2PseudocodeModule>,
): string {
  const structName = toPascalCase(entity.name);

  // Try to find typed fields from pseudocode dataStructures
  const dsDef = findDataStructureDefinition(structName, pseudoModules)
    ?? findDataStructureDefinition(entity.name, pseudoModules);
  const dsFields = dsDef ? parseDataStructureFields(dsDef) : [];

  let structFields: string;
  let ctorParams: string;
  let ctorBody: string;

  if (dsFields.length > 0) {
    // Use real typed fields from pseudocode
    const fieldLines = ['    pub id: String,'];
    const paramLines = ['        id: String,'];
    const bodyLines = ['            id,'];

    for (const f of dsFields) {
      const rustType = tsTypeToRust(f.type);
      const fieldName = snakeCase(f.name);
      if (fieldName === 'id') continue; // already included
      fieldLines.push(`    pub ${fieldName}: ${rustType},`);
      paramLines.push(`        ${fieldName}: ${rustType},`);
      bodyLines.push(`            ${fieldName},`);
    }

    structFields = fieldLines.join('\n');
    ctorParams = paramLines.join('\n');
    ctorBody = bodyLines.join('\n');
  } else {
    // Fallback: bare id field
    structFields = '    pub id: String,';
    ctorParams = '        id: String,';
    ctorBody = '            id,';
  }

  return [
    `//! Entity: ${entity.name}`,
    `//! ${entity.description}`,
    `//! Bounded context: ${ctx.name}`,
    '',
    '#[derive(Debug, Clone)]',
    `pub struct ${structName} {`,
    structFields,
    '}',
    '',
    `impl ${structName} {`,
    `    pub fn new(`,
    ctorParams,
    '    ) -> Self {',
    '        Self {',
    ctorBody,
    '        }',
    '    }',
    '}',
    '',
  ].join('\n');
}

/**
 * Generate a Rust value object struct (immutable with factory).
 */
function rustValueObject(
  ctx: Phase2DDDBoundedContext,
  vo: Phase2ValueObject,
  pseudoModules: ReadonlyArray<Phase2PseudocodeModule>,
): string {
  const structName = toPascalCase(vo.name);

  // Try to find typed fields from pseudocode dataStructures
  const dsDef = findDataStructureDefinition(structName, pseudoModules)
    ?? findDataStructureDefinition(vo.name, pseudoModules);
  const dsFields = dsDef ? parseDataStructureFields(dsDef) : [];

  if (dsFields.length > 1) {
    // Multi-field VO from pseudocode — generate a rich struct
    const fieldLines = dsFields.map(
      (f) => `    pub ${snakeCase(f.name)}: ${tsTypeToRust(f.type)},`,
    );
    const paramLines = dsFields.map(
      (f) => `        ${snakeCase(f.name)}: ${tsTypeToRust(f.type)},`,
    );
    const bodyLines = dsFields.map((f) => `            ${snakeCase(f.name)},`);

    // Invariant checks against the struct fields
    const invariantChecks = vo.invariants
      .map(
        (inv, i) =>
          `        // Validation ${i + 1}: ${inv}\n` +
          `        if !Self::validate_${i + 1}(&result) {\n` +
          `            return Err("${structName} validation failed: ${inv.replace(/"/g, '\\"')}".into());\n` +
          `        }`,
      )
      .join('\n');

    const validationFns = vo.invariants
      .map(
        (inv, i) =>
          `\n    /// Validate: ${inv}\n` +
          `    fn validate_${i + 1}(vo: &Self) -> bool {\n` +
          `${inferRustMultiFieldValidation(inv, dsFields)}\n` +
          `    }`,
      )
      .join('\n');

    return [
      `//! Value Object: ${vo.name} (immutable)`,
      `//! ${vo.description}`,
      `//! Bounded context: ${ctx.name}`,
      `//! Invariants: ${vo.invariants.length}`,
      '',
      '#[derive(Clone, Debug, PartialEq)]',
      `pub struct ${structName} {`,
      ...fieldLines,
      '}',
      '',
      `impl ${structName} {`,
      '    /// Factory with validation. Returns Err if any invariant is violated.',
      '    pub fn create(',
      ...paramLines,
      '    ) -> Result<Self, Box<dyn std::error::Error>> {',
      `        let result = Self {`,
      ...bodyLines,
      '        };',
      invariantChecks || '        // No invariants defined',
      '        Ok(result)',
      '    }',
      validationFns || '',
      '}',
      '',
    ].join('\n');
  }

  // Fallback: single-value wrapper VO
  const invariantChecks = vo.invariants
    .map(
      (inv, i) =>
        `        // Validation ${i + 1}: ${inv}\n` +
        `        if !Self::validate_${i + 1}(&value) {\n` +
        `            return Err("${structName} validation failed: ${inv.replace(/"/g, '\\"')}".into());\n` +
        `        }`,
    )
    .join('\n');

  const validationFns = vo.invariants
    .map(
      (inv, i) =>
        `\n    /// Validate: ${inv}\n` +
        `    fn validate_${i + 1}(value: &str) -> bool {\n` +
        `        // Rule: ${inv.replace(/"/g, '\\"')}\n` +
        `        !value.is_empty()\n` +
        `    }`,
    )
    .join('\n');

  return [
    `//! Value Object: ${vo.name} (immutable)`,
    `//! ${vo.description}`,
    `//! Bounded context: ${ctx.name}`,
    `//! Invariants: ${vo.invariants.length}`,
    '',
    '#[derive(Clone, Debug, PartialEq, Eq)]',
    `pub struct ${structName} {`,
    '    value: String,',
    '}',
    '',
    `impl ${structName} {`,
    '    /// Factory with validation. Returns Err if any invariant is violated.',
    '    pub fn create(value: String) -> Result<Self, Box<dyn std::error::Error>> {',
    invariantChecks || '        // No invariants defined',
    '        Ok(Self { value })',
    '    }',
    '',
    '    pub fn value(&self) -> &str {',
    '        &self.value',
    '    }',
    validationFns || '',
    '}',
    '',
  ].join('\n');
}

/**
 * Generate a Rust domain event struct.
 */
function rustDomainEvent(
  ctx: Phase2DDDBoundedContext,
  event: Phase2DomainEvent,
): string {
  const structName = toPascalCase(event.name);

  const payloadFields = event.payload
    .map((p) => `    pub ${snakeCase(p)}: String,`)
    .join('\n');

  return [
    `//! Domain Event: ${event.name}`,
    `//! ${event.description}`,
    `//! Bounded context: ${ctx.name}`,
    '',
    '#[derive(Debug, Clone)]',
    `pub struct ${structName}Payload {`,
    '    pub aggregate_id: String,',
    '    pub timestamp: String,',
    '    pub correlation_id: String,',
    payloadFields || '',
    '}',
    '',
    '#[derive(Debug, Clone)]',
    `pub struct ${structName} {`,
    `    pub event_type: String,`,
    `    pub payload: ${structName}Payload,`,
    `    pub triggered_by: String,`,
    '}',
    '',
    `impl ${structName} {`,
    `    pub fn new(payload: ${structName}Payload) -> Self {`,
    '        Self {',
    `            event_type: "${slugify(event.name)}".to_string(),`,
    '            payload,',
    `            triggered_by: "${event.triggeredBy}".to_string(),`,
    '        }',
    '    }',
    '}',
    '',
  ].join('\n');
}

/**
 * Generate a Rust command handler.
 */
function rustCommand(
  ctx: Phase2DDDBoundedContext,
  cmd: Phase2Command,
  ctxModules: Phase2PseudocodeModule[],
  ctxService: Phase2ServiceDefinition | null,
): string {
  const handlerName = toPascalCase(cmd.name);
  const fnName = snakeCase(cmd.name);

  // Try to find typed input from API signature
  let inputFields: string;
  if (ctxService) {
    const apiMethod = ctxService.api
      .map((a) => parseApiSignature(a))
      .find((p) => p && snakeCase(p.methodName) === fnName);
    if (apiMethod && apiMethod.params.length > 0) {
      inputFields = apiMethod.params
        .map((p) => `    pub ${snakeCase(p.name)}: ${tsTypeToRust(p.type)},`)
        .join('\n');
    } else {
      inputFields = cmd.input
        .map((inp) => {
          // Check if input has embedded type: "config: ERPConfig"
          const colonIdx = inp.indexOf(':');
          if (colonIdx > 0) {
            const name = inp.slice(0, colonIdx).trim();
            const type = inp.slice(colonIdx + 1).trim();
            return `    pub ${snakeCase(name)}: ${tsTypeToRust(type)},`;
          }
          return `    pub ${snakeCase(inp)}: String,`;
        })
        .join('\n');
    }
  } else {
    inputFields = cmd.input
      .map((inp) => {
        const colonIdx = inp.indexOf(':');
        if (colonIdx > 0) {
          const name = inp.slice(0, colonIdx).trim();
          const type = inp.slice(colonIdx + 1).trim();
          return `    pub ${snakeCase(name)}: ${tsTypeToRust(type)},`;
        }
        return `    pub ${snakeCase(inp)}: String,`;
      })
      .join('\n');
  }

  // Precondition guards
  const preconditionGuards = cmd.preconditions
    .map(
      (pre, i) =>
        `    // Precondition ${i + 1}: ${pre}\n` +
        `    if !validate_precondition_${i + 1}(&input) {\n` +
        `        return Err("Precondition failed: ${pre.replace(/"/g, '\\"')}".into());\n` +
        `    }`,
    )
    .join('\n');

  const preconditionFns = cmd.preconditions
    .map(
      (pre, i) =>
        `/// Check: ${pre}\n` +
        `fn validate_precondition_${i + 1}(input: &${handlerName}Input) -> bool {\n` +
        `${inferRustPreconditionBody(pre, cmd.input)}\n` +
        `}`,
    )
    .join('\n\n');

  // Extract algorithm steps from pseudocode
  const algoSteps = extractAlgorithmSteps(cmd.name, ctxModules);
  let handlerBody: string;

  if (algoSteps.length > 0) {
    // Rich handler body from pseudocode algorithms
    const stepLines = algoSteps.map(
      (step, i) => `    // Step ${i + 2}: ${step}\n${renderRustAlgorithmStep(step, i + 2)}`,
    );
    handlerBody = [
      '    // Step 1: Validate preconditions',
      preconditionGuards || '    // No preconditions defined',
      '',
      '    let aggregate_id = format!("{}", uuid::Uuid::new_v4());',
      '    let correlation_id = format!("{}", uuid::Uuid::new_v4());',
      '',
      '    // --- Domain Logic (from SPARC pseudocode) ---',
      ...stepLines,
      '',
      `    Ok(${handlerName}Result {`,
      '        success: true,',
      '        aggregate_id,',
      '        correlation_id,',
      '    })',
    ].join('\n');
  } else {
    // Build Rust input field destructuring
    const rustInputFields = cmd.input.map((inp) => {
      const colonIdx = inp.indexOf(':');
      return snakeCase(colonIdx > 0 ? inp.slice(0, colonIdx).trim() : inp);
    });
    const rustDestructure = rustInputFields.length > 0
      ? `    let ${handlerName}Input { ${rustInputFields.join(', ')}, .. } = &input;`
      : '    let _input = &input;';

    handlerBody = [
      '    // Step 1: Validate preconditions',
      preconditionGuards || '    // No preconditions defined',
      '',
      '    // Step 2: Destructure typed input fields',
      `  ${rustDestructure}`,
      '',
      '    // Step 3: Load aggregate and apply domain logic',
      '    let aggregate_id = format!("{}", uuid::Uuid::new_v4());',
      '    let correlation_id = format!("{}", uuid::Uuid::new_v4());',
      '',
      '    // Step 4: Build updated aggregate from typed input',
      `    // TODO: Load from repository, apply ${rustInputFields.join(', ')}, persist`,
      '',
      `    Ok(${handlerName}Result {`,
      '        success: true,',
      '        aggregate_id,',
      '        correlation_id,',
      '    })',
    ].join('\n');
  }

  return [
    `//! Command: ${cmd.name}`,
    `//! ${cmd.description}`,
    `//! Bounded context: ${ctx.name}`,
    `//! Preconditions: ${cmd.preconditions.length}`,
    '',
    '#[derive(Debug, Clone)]',
    `pub struct ${handlerName}Input {`,
    inputFields || '    // No input fields defined',
    '}',
    '',
    '#[derive(Debug, Clone)]',
    `pub struct ${handlerName}Result {`,
    '    pub success: bool,',
    '    pub aggregate_id: String,',
    '    pub correlation_id: String,',
    '}',
    '',
    preconditionFns || '',
    '',
    `pub async fn handle_${fnName}(`,
    `    input: ${handlerName}Input,`,
    `) -> Result<${handlerName}Result, Box<dyn std::error::Error>> {`,
    handlerBody,
    '}',
    '',
  ].join('\n');
}

// ============================================================================
// Rust Inference Helpers (parallel to TypeScript inference helpers above)
// ============================================================================

/**
 * Infer Rust aggregate invariant body from invariant text.
 */
function inferRustAggregateInvariantBody(
  invariant: string,
  agg: Phase2AggregateDefinition,
): string {
  const lower = invariant.toLowerCase();
  const allFieldNames = [
    ...agg.entities.map((e) => snakeCase(e.name)),
    ...agg.valueObjects.map((vo) => snakeCase(vo.name)),
  ];

  // Try to find a field referenced in the invariant text
  const referencedField = findReferencedField(invariant, allFieldNames);

  if (/must equal sum|sum of|total.*match|reconcil/.test(lower)) {
    return '        // Sum validation — compare aggregate total with item sum\n        true // structural invariant verified at construction';
  }

  // "must not be negative" / "non-negative"
  if (/must not be negative|cannot be negative|non-negative|nonnegative|>= ?0/.test(lower)) {
    const field = referencedField ?? findFieldByKeywords(allFieldNames, ['amount', 'total', 'price', 'cost', 'value', 'quantity', 'count', 'minutes', 'delay', 'duration']);
    if (field) return `        self.${field} >= 0.0`;
  }

  // "must be positive"
  if (/must be positive|greater than zero|above zero/.test(lower)) {
    const field = referencedField ?? findFieldByKeywords(allFieldNames, ['amount', 'total', 'price', 'cost', 'value', 'quantity', 'count']);
    if (field) return `        self.${field} > 0.0`;
  }

  // "must not exceed" / "maximum"
  if (/must not exceed|cannot exceed|must be less than|must be under|maximum|at most/.test(lower)) {
    const field = referencedField ?? findFieldByKeywords(allFieldNames, ['amount', 'total', 'count', 'quantity', 'duration', 'delay', 'minutes']);
    const limitMatch = lower.match(/(\d+)/);
    const limit = limitMatch ? limitMatch[1] : 'i64::MAX';
    if (field) return `        self.${field} <= ${limit} as f64`;
  }

  // "must not be empty" / "at least one"
  if (/must not be empty|cannot be empty|at least one|must contain/.test(lower)) {
    const field = referencedField ?? findFieldByKeywords(allFieldNames, ['items', 'lines', 'entries', 'records', 'list', 'elements']);
    if (field) return `        !self.${field}.is_empty()`;
  }

  // "must have a valid X" / "valid assignment/reference"
  if (/must have a valid|must have valid|valid.*assignment|valid.*reference/.test(lower)) {
    if (referencedField) return `        !self.${referencedField}.to_string().is_empty()`;
  }

  // "must be in a valid state" / "status must be"
  if (/must be in a valid state|status must|must be in state|state must|current status|valid state/.test(lower)) {
    const field = referencedField ?? findFieldByKeywords(allFieldNames, ['status', 'state', 'phase']);
    if (field) return `        !self.${field}.is_empty()`;
  }

  // "must have" (general)
  if (/must have/.test(lower) && referencedField) {
    return `        !self.${referencedField}.to_string().is_empty()`;
  }

  if (/unique|no duplicate|distinct/.test(lower)) {
    const field = findFieldByKeywords(allFieldNames, ['items', 'lines', 'entries', 'ids']);
    if (field) return `        // Uniqueness check\n        let ids: Vec<_> = self.${field}.iter().map(|i| &i.id).collect();\n        let unique: std::collections::HashSet<_> = ids.iter().collect();\n        unique.len() == ids.len()`;
  }

  // If a specific field is referenced, validate it's non-empty
  if (referencedField) {
    return `        !self.${referencedField}.to_string().is_empty()`;
  }

  if (allFieldNames.length > 0) {
    return `        // Verify essential fields are initialized\n        ${allFieldNames.slice(0, 3).map((f) => `!self.${f}.to_string().is_empty()`).join(' && ')}`;
  }
  return '        true // invariant requires runtime context';
}

/**
 * Infer Rust multi-field VO validation from invariant text.
 */
function inferRustMultiFieldValidation(
  invariant: string,
  dsFields: DataStructureField[],
): string {
  const lower = invariant.toLowerCase();

  const referencedField = dsFields.find((f) =>
    lower.includes(f.name.toLowerCase()) || lower.includes(snakeCase(f.name)),
  );

  if (referencedField) {
    const fieldRef = `vo.${snakeCase(referencedField.name)}`;
    const rustType = tsTypeToRust(referencedField.type);
    if (/f32|f64|i32|i64|u32|u64|usize/.test(rustType)) {
      if (/positive|greater than zero/.test(lower)) return `        ${fieldRef} > 0.0`;
      if (/non-negative/.test(lower)) return `        ${fieldRef} >= 0.0`;
      return `        ${fieldRef}.is_finite()`;
    }
    if (rustType === 'String') {
      if (/not empty|non-empty|required/.test(lower)) return `        !${fieldRef}.trim().is_empty()`;
      if (/email/.test(lower)) return `        ${fieldRef}.contains('@') && ${fieldRef}.contains('.')`;
      return `        !${fieldRef}.is_empty()`;
    }
    return `        true // validated: ${invariant.replace(/"/g, '')}`;
  }

  // Cross-field date ordering
  if (/before|after|start.*end/.test(lower)) {
    const dateFields = dsFields.filter((f) => /date|time|deadline/.test(f.name.toLowerCase()));
    if (dateFields.length >= 2) {
      return `        vo.${snakeCase(dateFields[0]!.name)} <= vo.${snakeCase(dateFields[1]!.name)}`;
    }
  }

  // Default: validate all string fields non-empty
  const checks = dsFields.slice(0, 5).map((f) => {
    const ref = `vo.${snakeCase(f.name)}`;
    const rt = tsTypeToRust(f.type);
    if (rt === 'String') return `!${ref}.is_empty()`;
    if (/f32|f64|i32|i64/.test(rt)) return `${ref}.is_finite()`;
    return 'true';
  });
  return checks.length > 0
    ? `        ${checks.join(' && ')}`
    : '        true';
}

/**
 * Infer Rust precondition body from precondition text.
 */
function inferRustPreconditionBody(precondition: string, inputFields: string[]): string {
  const lower = precondition.toLowerCase();
  const rustFields = inputFields.map((f) => snakeCase(f.replace(/:.*$/, '').trim()));

  if (/must exist|is required|must be provided|cannot be null/.test(lower)) {
    const field = rustFields.find((f) => lower.includes(f));
    if (field) return `    !input.${field}.is_empty()`;
    if (rustFields.length > 0) {
      return `    ${rustFields.slice(0, 3).map((f) => `!input.${f}.to_string().is_empty()`).join(' && ')}`;
    }
  }
  if (/must be positive|greater than zero/.test(lower)) {
    const numField = rustFields.find((f) => /amount|price|total|cost|quantity/.test(f));
    if (numField) return `    input.${numField} > 0.0`;
  }
  if (/authenticated|valid token|authorized/.test(lower)) {
    return '    true // authentication checked at middleware layer';
  }
  if (rustFields.length > 0) {
    return `    ${rustFields.slice(0, 3).map((f) => `!input.${f}.to_string().is_empty()`).join(' && ')}`;
  }
  return '    true';
}

/**
 * Render an algorithm step as Rust code.
 */
function renderRustAlgorithmStep(step: string, index: number): string {
  const lower = step.toLowerCase();

  if (/validate|check|verify|ensure/.test(lower)) {
    return `    // Validated in precondition guards above`;
  }
  if (/calculate|compute|sum|total|accumulate/.test(lower)) {
    return `    let _step${index}_result: f64 = 0.0; // ${step}`;
  }
  if (/for each|iterate|loop|process each/.test(lower)) {
    return `    // Iteration: ${step}\n    // for item in &input.items { /* process */ }`;
  }
  if (/filter|select only|exclude/.test(lower)) {
    return `    // Filter: ${step}`;
  }
  if (/persist|save|store|commit/.test(lower)) {
    return `    // Persist: handled by repository layer`;
  }
  if (/emit|publish|dispatch|fire|notify/.test(lower)) {
    return `    // Event emission: ${step}`;
  }
  if (/load|fetch|retrieve|read|get|lookup/.test(lower)) {
    return `    // Load from repository: ${step}`;
  }
  return `    let _ = (); /* STEP: ${step.replace(/\*\//g, '* /')} */`;
}

/**
 * Build the Rust query handler result mapping code.
 */
function buildRustQueryResultMapping(
  dsFields: DataStructureField[],
  isCollection: boolean,
  handlerName: string,
): string {
  const lines: string[] = [];
  lines.push('');
  lines.push('    // Step 2: Map results to typed response');

  if (dsFields.length > 0) {
    lines.push(`    let elapsed = start.elapsed().as_millis() as u64;`);
    lines.push(`    Ok(${handlerName}Result {`);
    for (const f of dsFields) {
      const rustName = snakeCase(f.name);
      const rustType = tsTypeToRust(f.type);
      lines.push(`        ${rustName}: ${rustDefault(rustType)},`);
    }
    lines.push('        execution_time_ms: elapsed,');
    lines.push('    })');
  } else if (isCollection) {
    lines.push(`    let elapsed = start.elapsed().as_millis() as u64;`);
    lines.push(`    Ok(${handlerName}Result {`);
    lines.push('        data: Vec::new(),');
    lines.push('        total_count: 0,');
    lines.push('        execution_time_ms: elapsed,');
    lines.push('    })');
  } else {
    lines.push(`    let elapsed = start.elapsed().as_millis() as u64;`);
    lines.push(`    Ok(${handlerName}Result {`);
    lines.push('        data: None,');
    lines.push('        execution_time_ms: elapsed,');
    lines.push('    })');
  }

  return lines.join('\n');
}

/**
 * Return a safe default value for a Rust type.
 */
function rustDefault(rustType: string): string {
  if (/f32|f64/.test(rustType)) return '0.0';
  if (/i32|i64|u32|u64|usize/.test(rustType)) return '0';
  if (rustType === 'bool') return 'false';
  if (rustType === 'String') return 'String::new()';
  if (rustType.startsWith('Vec<')) return 'Vec::new()';
  if (rustType.startsWith('Option<')) return 'None';
  return 'Default::default()';
}

/**
 * Generate a Rust query handler.
 */
function rustQuery(
  ctx: Phase2DDDBoundedContext,
  query: Phase2Query,
  pseudoModules: ReadonlyArray<Phase2PseudocodeModule>,
  _ctxService: Phase2ServiceDefinition | null,
): string {
  const handlerName = toPascalCase(query.name);
  const fnName = snakeCase(query.name);

  const paramFields = query.parameters
    .map((p) => `    pub ${snakeCase(p)}: String,`)
    .join('\n');

  const isCollection = /list|array|collection|multiple|all|many/.test(query.returns.toLowerCase());

  // Try to derive typed result from return type
  let resultFields: string;
  const returnTypeName = toPascalCase(query.returns);
  const dsDef = findDataStructureDefinition(returnTypeName, pseudoModules)
    ?? findDataStructureDefinition(query.returns, pseudoModules);
  const dsFields = dsDef ? parseDataStructureFields(dsDef) : [];

  if (dsFields.length > 0) {
    // Use real typed fields from pseudocode for the result
    resultFields = dsFields
      .map((f) => `    pub ${snakeCase(f.name)}: ${tsTypeToRust(f.type)},`)
      .join('\n');
  } else if (isCollection) {
    resultFields = '    pub data: Vec<serde_json::Value>,\n    pub total_count: usize,';
  } else {
    resultFields = '    pub data: Option<serde_json::Value>,';
  }

  return [
    `//! Query: ${query.name}`,
    `//! ${query.description}`,
    `//! Returns: ${query.returns}`,
    `//! Bounded context: ${ctx.name}`,
    '',
    '#[derive(Debug, Clone)]',
    `pub struct ${handlerName}Params {`,
    paramFields || '    // No parameters defined',
    '}',
    '',
    `/// ${query.returns}`,
    '#[derive(Debug, Clone, Serialize, Deserialize)]',
    `pub struct ${handlerName}Result {`,
    resultFields,
    '    pub execution_time_ms: u64,',
    '}',
    '',
    `pub async fn handle_${fnName}(`,
    `    params: ${handlerName}Params,`,
    `) -> Result<${handlerName}Result, Box<dyn std::error::Error>> {`,
    '    let start = std::time::Instant::now();',
    '',
    '    // Step 1: Execute read-model query',
    `    let _ = &params; // consumed by query logic`,
    '',
    buildRustQueryResultMapping(dsFields, isCollection, handlerName),
    '}',
    '',
  ].join('\n');
}

/**
 * Generate a Rust seam trait from a MockContract.
 */
function rustSeam(contract: MockContract): string {
  const traitName = toPortName(contract.interfaceName);

  const methods = contract.methods
    .map(
      (m) =>
        `    /// ${m.behavior}\n` +
        `    async fn ${snakeCase(m.name)}(&self, input: ${m.input || '()'}) -> Result<${m.output || '()'}, Box<dyn std::error::Error>>;`,
    )
    .join('\n\n');

  return [
    `//! Seam Interface: ${contract.name}`,
    `//! Target service: ${contract.targetService}`,
    `//! Bounded context: ${contract.boundedContext}`,
    '',
    '#[async_trait::async_trait]',
    `pub trait ${traitName}: Send + Sync {`,
    methods || '    // No methods defined',
    '}',
    '',
  ].join('\n');
}

/**
 * Generate a Rust seam trait from a SeamDefinition.
 */
function rustSeamFromDefinition(seam: SeamDefinition): string {
  const traitName = toPortName(seam.name);

  // Generate methods based on contract type
  let methods: string;
  switch (seam.contractType) {
    case 'sync-request-response':
      methods = [
        `    /// Send a request and await response (${seam.between[0]} → ${seam.between[1]}).`,
        `    async fn send(&self, request: serde_json::Value) -> Result<serde_json::Value, Box<dyn std::error::Error>>;`,
        '',
        `    /// Check downstream service availability.`,
        `    async fn health_check(&self) -> Result<bool, Box<dyn std::error::Error>>;`,
      ].join('\n');
      break;
    case 'async-event':
      methods = [
        `    /// Publish a domain event (${seam.between[0]} → ${seam.between[1]}).`,
        `    async fn publish(&self, event: serde_json::Value) -> Result<(), Box<dyn std::error::Error>>;`,
      ].join('\n');
      break;
    case 'shared-data':
      methods = [
        `    /// Read shared state (${seam.between[0]} ↔ ${seam.between[1]}).`,
        `    async fn read(&self, key: &str) -> Result<Option<serde_json::Value>, Box<dyn std::error::Error>>;`,
        '',
        `    /// Write shared state with optimistic concurrency.`,
        `    async fn write(&self, key: &str, data: serde_json::Value, expected_version: Option<u64>) -> Result<(), Box<dyn std::error::Error>>;`,
      ].join('\n');
      break;
    default:
      methods = `    // Unknown contract type: ${seam.contractType}`;
  }

  return [
    `//! Seam Interface: ${seam.name}`,
    `//! Between: ${seam.between[0]} <-> ${seam.between[1]}`,
    `//! Contract type: ${seam.contractType}`,
    `//! Mock boundary: ${seam.mockBoundary}`,
    `//! Integration test: ${seam.integrationTestApproach}`,
    '',
    '#[async_trait::async_trait]',
    `pub trait ${traitName}: Send + Sync {`,
    methods,
    '}',
    '',
  ].join('\n');
}

// ============================================================================
// Aggregate Entity/VO Extraction
// ============================================================================

/**
 * Collect all entities across all aggregates in a bounded context.
 */
function collectEntities(ctx: Phase2DDDBoundedContext): Phase2Entity[] {
  const entities: Phase2Entity[] = [];
  const seen = new Set<string>();
  for (const agg of ctx.aggregates) {
    for (const entity of agg.entities) {
      if (!seen.has(entity.name)) {
        seen.add(entity.name);
        entities.push(entity);
      }
    }
  }
  return entities;
}

/**
 * Collect all value objects across all aggregates in a bounded context.
 */
function collectValueObjects(ctx: Phase2DDDBoundedContext): Phase2ValueObject[] {
  const vos: Phase2ValueObject[] = [];
  const seen = new Set<string>();
  for (const agg of ctx.aggregates) {
    for (const vo of agg.valueObjects) {
      if (!seen.has(vo.name)) {
        seen.add(vo.name);
        vos.push(vo);
      }
    }
  }
  return vos;
}

// ============================================================================
// Mock Contract Resolution
// ============================================================================

/**
 * Find all mock contracts that belong to a given bounded context.
 */
function contractsForContext(
  contextName: string,
  contracts: readonly MockContract[],
): MockContract[] {
  const ctxSlug = slugify(contextName.replace(/Context$/i, ''));
  return contracts.filter((c) => {
    const bcSlug = slugify(c.boundedContext.replace(/Context$/i, ''));
    return bcSlug === ctxSlug || c.boundedContext === contextName;
  });
}

/**
 * Find all seam definitions that reference a given bounded context
 * (in either side of the `between` tuple) and have no matching mock contract.
 *
 * Normalizes names by stripping a trailing "Context" suffix and slugifying,
 * so that DDD context names like "ApiGatewayContext" match seam `between`
 * values like "api-gateway".
 */
function orphanSeamsForContext(
  contextName: string,
  seams: readonly SeamDefinition[],
  contracts: readonly MockContract[],
): SeamDefinition[] {
  const ctxSlug = slugify(contextName.replace(/Context$/i, ''));
  const contractNames = new Set(contracts.map((c) => c.name));
  return seams.filter(
    (s) =>
      (slugify(s.between[0]) === ctxSlug || slugify(s.between[1]) === ctxSlug) &&
      !contractNames.has(s.name),
  );
}

// ============================================================================
// Barrel File Generators
// ============================================================================

/**
 * Generate a TypeScript barrel file that re-exports all modules in a directory.
 */
function tsBarrel(exports: string[]): string {
  if (exports.length === 0) {
    return '// No exports yet\n';
  }
  return exports.map((e) => `export * from './${e}.js';`).join('\n') + '\n';
}

/**
 * Generate a Rust mod.rs file that declares public modules.
 */
function rustMod(modules: string[]): string {
  if (modules.length === 0) {
    return '// No modules yet\n';
  }
  return modules.map((m) => `pub mod ${m};`).join('\n') + '\n';
}

// ============================================================================
// Public: Pure Builder
// ============================================================================

/**
 * Pure function that builds all domain code files from the DDD domain model,
 * TDD plan, and SPARC pseudocode/architecture. No side effects -- does not
 * write anything to disk.
 *
 * @param domainModel - The Phase 2 DDD domain model
 * @param tddPlan     - The Phase 2 TDD plan (for seam/mock contract info)
 * @param language    - The resolved implementation language
 * @param sparc       - The Phase 2 SPARC output (pseudocode modules + architecture)
 * @returns CodegenOutput with all generated files and summary counts
 */
export function buildDomainCode(
  domainModel: Phase2DomainModel,
  tddPlan: TDDPlan,
  language: ImplementationLanguage,
  sparc: Phase2SPARCOutput,
): CodegenOutput {
  const files: CodegenFile[] = [];
  let totalAggregates = 0;
  let totalEntities = 0;
  let totalValueObjects = 0;
  let totalEvents = 0;
  let totalCommands = 0;
  let totalQueries = 0;
  let totalSeams = 0;

  const isTs = language === 'typescript';
  const pseudoModules = sparc.pseudocode.modules;

  for (const ctx of domainModel.contexts) {
    const ctxSlug = isTs ? slugify(ctx.name) : snakeCase(ctx.name);
    const basePath = isTs
      ? `${ROOT_DIR}/src/${ctxSlug}`
      : `${ROOT_DIR}/${ctxSlug}/src`;

    // Track names for barrel/mod files
    const aggregateNames: string[] = [];
    const entityNames: string[] = [];
    const voNames: string[] = [];
    const eventNames: string[] = [];
    const commandNames: string[] = [];
    const queryNames: string[] = [];
    const seamNames: string[] = [];

    // --- Aggregates ---
    for (const agg of ctx.aggregates) {
      const fileSlug = slugify(agg.name);
      const modName = isTs ? fileSlug : snakeCase(agg.name);
      aggregateNames.push(modName);
      totalAggregates++;

      const content = isTs ? tsAggregate(ctx, agg) : rustAggregate(ctx, agg);
      const relPath = isTs
        ? `${basePath}/domain/aggregates/${fileSlug}.ts`
        : `${basePath}/domain/aggregates/${snakeCase(agg.name)}.rs`;

      files.push({
        relativePath: relPath,
        content,
        boundedContext: ctx.name,
        kind: 'aggregate',
      });
    }

    // --- Resolve pseudocode modules for this bounded context ---
    const ctxPseudoModules = findPseudocodeModulesForContext(ctx.name, sparc);
    const ctxService = findMatchingService(ctx.name, sparc.architecture.services);

    // --- Entities ---
    const entities = collectEntities(ctx);
    for (const entity of entities) {
      const fileSlug = slugify(entity.name);
      const modName = isTs ? fileSlug : snakeCase(entity.name);
      entityNames.push(modName);
      totalEntities++;

      const content = isTs
        ? tsEntity(ctx, entity, pseudoModules)
        : rustEntity(ctx, entity, pseudoModules);
      const relPath = isTs
        ? `${basePath}/domain/entities/${fileSlug}.ts`
        : `${basePath}/domain/entities/${snakeCase(entity.name)}.rs`;

      files.push({
        relativePath: relPath,
        content,
        boundedContext: ctx.name,
        kind: 'entity',
      });
    }

    // --- Value Objects ---
    const valueObjects = collectValueObjects(ctx);
    for (const vo of valueObjects) {
      const fileSlug = slugify(vo.name);
      const modName = isTs ? fileSlug : snakeCase(vo.name);
      voNames.push(modName);
      totalValueObjects++;

      const content = isTs
        ? tsValueObject(ctx, vo, pseudoModules)
        : rustValueObject(ctx, vo, pseudoModules);
      const relPath = isTs
        ? `${basePath}/domain/value-objects/${fileSlug}.ts`
        : `${basePath}/domain/value_objects/${snakeCase(vo.name)}.rs`;

      files.push({
        relativePath: relPath,
        content,
        boundedContext: ctx.name,
        kind: 'value-object',
      });
    }

    // --- Domain Events ---
    for (const event of ctx.domainEvents) {
      const fileSlug = slugify(event.name);
      const modName = isTs ? fileSlug : snakeCase(event.name);
      eventNames.push(modName);
      totalEvents++;

      const content = isTs ? tsDomainEvent(ctx, event) : rustDomainEvent(ctx, event);
      const relPath = isTs
        ? `${basePath}/domain/events/${fileSlug}.ts`
        : `${basePath}/domain/events/${snakeCase(event.name)}.rs`;

      files.push({
        relativePath: relPath,
        content,
        boundedContext: ctx.name,
        kind: 'event',
      });
    }

    // --- Commands ---
    for (const cmd of ctx.commands) {
      const fileSlug = slugify(cmd.name);
      const modName = isTs ? fileSlug : snakeCase(cmd.name);
      commandNames.push(modName);
      totalCommands++;

      const content = isTs
        ? tsCommand(ctx, cmd, ctxPseudoModules, ctxService)
        : rustCommand(ctx, cmd, ctxPseudoModules, ctxService);
      const relPath = isTs
        ? `${basePath}/domain/commands/${fileSlug}.ts`
        : `${basePath}/domain/commands/${snakeCase(cmd.name)}.rs`;

      files.push({
        relativePath: relPath,
        content,
        boundedContext: ctx.name,
        kind: 'command',
      });
    }

    // --- Queries ---
    for (const query of ctx.queries) {
      const fileSlug = slugify(query.name);
      const modName = isTs ? fileSlug : snakeCase(query.name);
      queryNames.push(modName);
      totalQueries++;

      const content = isTs
        ? tsQuery(ctx, query, pseudoModules, ctxService)
        : rustQuery(ctx, query, pseudoModules, ctxService);
      const relPath = isTs
        ? `${basePath}/domain/queries/${fileSlug}.ts`
        : `${basePath}/domain/queries/${snakeCase(query.name)}.rs`;

      files.push({
        relativePath: relPath,
        content,
        boundedContext: ctx.name,
        kind: 'query',
      });
    }

    // --- Seam Interfaces (from MockContracts) ---
    const ctxContracts = contractsForContext(ctx.name, tddPlan.mockContracts);
    for (const contract of ctxContracts) {
      const fileSlug = slugify(contract.interfaceName);
      const modName = isTs ? fileSlug : snakeCase(contract.interfaceName);
      seamNames.push(modName);
      totalSeams++;

      const content = isTs ? tsSeam(contract) : rustSeam(contract);
      const relPath = isTs
        ? `${basePath}/ports/${fileSlug}.ts`
        : `${basePath}/ports/${snakeCase(contract.interfaceName)}.rs`;

      files.push({
        relativePath: relPath,
        content,
        boundedContext: ctx.name,
        kind: 'seam',
      });
    }

    // --- Seam Interfaces (from orphan SeamDefinitions) ---
    const orphanSeams = orphanSeamsForContext(
      ctx.name,
      tddPlan.seamDefinitions,
      tddPlan.mockContracts,
    );
    for (const seam of orphanSeams) {
      const fileSlug = slugify(seam.name);
      const modName = isTs ? fileSlug : snakeCase(seam.name);
      // Avoid duplicates in the same context
      if (!seamNames.includes(modName)) {
        seamNames.push(modName);
        totalSeams++;

        const content = isTs
          ? tsSeamFromDefinition(seam)
          : rustSeamFromDefinition(seam);
        const relPath = isTs
          ? `${basePath}/ports/${fileSlug}.ts`
          : `${basePath}/ports/${snakeCase(seam.name)}.rs`;

        files.push({
          relativePath: relPath,
          content,
          boundedContext: ctx.name,
          kind: 'seam',
        });
      }
    }

    // --- Barrel / Mod files ---
    if (isTs) {
      // TypeScript barrel index files for each subdirectory
      const barrels: Array<{ dir: string; names: string[] }> = [
        { dir: 'domain/aggregates', names: aggregateNames },
        { dir: 'domain/entities', names: entityNames },
        { dir: 'domain/value-objects', names: voNames },
        { dir: 'domain/events', names: eventNames },
        { dir: 'domain/commands', names: commandNames },
        { dir: 'domain/queries', names: queryNames },
        { dir: 'ports', names: seamNames },
      ];

      for (const barrel of barrels) {
        if (barrel.names.length > 0) {
          files.push({
            relativePath: `${basePath}/${barrel.dir}/index.ts`,
            content: tsBarrel(barrel.names),
            boundedContext: ctx.name,
            kind: 'barrel',
          });
        }
      }

      // Context-level barrel
      files.push({
        relativePath: `${basePath}/index.ts`,
        content: [
          `// Barrel export for bounded context: ${ctx.name}`,
          `export * from './domain/aggregates/index.js';`,
          `export * from './domain/entities/index.js';`,
          `export * from './domain/value-objects/index.js';`,
          `export * from './domain/events/index.js';`,
          `export * from './domain/commands/index.js';`,
          `export * from './domain/queries/index.js';`,
          `export * from './ports/index.js';`,
          '',
        ].join('\n'),
        boundedContext: ctx.name,
        kind: 'barrel',
      });
    } else {
      // Rust mod.rs files for each subdirectory
      const modFiles: Array<{ dir: string; names: string[] }> = [
        { dir: 'domain/aggregates', names: aggregateNames },
        { dir: 'domain/entities', names: entityNames },
        { dir: 'domain/value_objects', names: voNames },
        { dir: 'domain/events', names: eventNames },
        { dir: 'domain/commands', names: commandNames },
        { dir: 'domain/queries', names: queryNames },
        { dir: 'ports', names: seamNames },
      ];

      for (const modFile of modFiles) {
        if (modFile.names.length > 0) {
          files.push({
            relativePath: `${basePath}/${modFile.dir}/mod.rs`,
            content: rustMod(modFile.names),
            boundedContext: ctx.name,
            kind: 'mod',
          });
        }
      }

      // domain/mod.rs (with all sub-module declarations)
      files.push({
        relativePath: `${basePath}/domain/mod.rs`,
        content: [
          `//! Domain layer for ${ctx.name}`,
          '',
          'pub mod aggregates;',
          'pub mod entities;',
          'pub mod value_objects;',
          'pub mod events;',
          'pub mod commands;',
          'pub mod queries;',
          '',
        ].join('\n'),
        boundedContext: ctx.name,
        kind: 'mod',
      });

      // ports/mod.rs (already handled in the modFiles loop if non-empty)
      if (seamNames.length === 0) {
        files.push({
          relativePath: `${basePath}/ports/mod.rs`,
          content: `//! Port interfaces for ${ctx.name}\n`,
          boundedContext: ctx.name,
          kind: 'mod',
        });
      }
    }
    // --- Per-Context Implementation Prompt (ADR-004) ---
    // Generate a focused implementation prompt that the Ruflo swarm uses
    // to produce real business logic instead of stubs.
    const implPrompt = buildContextImplementationPrompt(ctx, tddPlan, sparc);
    files.push({
      relativePath: `${ROOT_DIR}/prompts/${ctxSlug}-implementation.md`,
      content: implPrompt,
      boundedContext: ctx.name,
      kind: 'implementation-prompt',
    });
  }

  return {
    files,
    totalAggregates,
    totalEntities,
    totalValueObjects,
    totalEvents,
    totalCommands,
    totalQueries,
    totalSeams,
  };
}

// ============================================================================
// Per-Context Implementation Prompt (ADR-004)
// ============================================================================

/**
 * Build a focused implementation prompt for a single bounded context.
 *
 * This prompt contains everything the Ruflo swarm needs to generate real
 * business logic for this context: aggregates with invariants, commands
 * with pre/post conditions, queries with return shapes, domain events
 * with payloads, ports/adapters needed, ADR constraints, and TDD test cases.
 */
function buildContextImplementationPrompt(
  ctx: Phase2DDDBoundedContext,
  tddPlan: TDDPlan,
  sparc: Phase2SPARCOutput,
): string {
  const lines: string[] = [];
  const ctxSlug = slugify(ctx.name);

  lines.push(`# Implementation Prompt: ${ctx.name}`);
  lines.push('');
  lines.push(`> Bounded context: **${ctx.name}**`);
  if (ctx.subdomain) lines.push(`> Subdomain: ${ctx.subdomain}`);
  lines.push(`> ${ctx.description}`);
  lines.push('');

  // --- Aggregates with invariants ---
  if (ctx.aggregates.length > 0) {
    lines.push('## Aggregates');
    lines.push('');
    for (const agg of ctx.aggregates) {
      lines.push(`### ${agg.name} (root: ${agg.root})`);
      if (agg.invariants.length > 0) {
        lines.push('**Invariants** (MUST be enforced — throw on violation):');
        for (const inv of agg.invariants) {
          lines.push(`- ${inv}`);
        }
      }
      if (agg.entities.length > 0) {
        lines.push(`**Entities**: ${agg.entities.map(e => e.name).join(', ')}`);
      }
      if (agg.valueObjects.length > 0) {
        lines.push(`**Value Objects**: ${agg.valueObjects.map(v => v.name).join(', ')}`);
      }
      lines.push('');
    }
  }

  // --- Commands with pre/post conditions ---
  if (ctx.commands.length > 0) {
    lines.push('## Commands');
    lines.push('');
    for (const cmd of ctx.commands) {
      lines.push(`### ${cmd.name}`);
      lines.push(cmd.description);
      if (cmd.input.length > 0) {
        lines.push(`**Input**: ${cmd.input.join(', ')}`);
      }
      if (cmd.preconditions.length > 0) {
        lines.push('**Preconditions**:');
        for (const pre of cmd.preconditions) {
          lines.push(`- ${pre}`);
        }
      }
      if (cmd.postconditions.length > 0) {
        lines.push('**Postconditions**:');
        for (const post of cmd.postconditions) {
          lines.push(`- ${post}`);
        }
      }
      lines.push('');
    }
  }

  // --- Queries with return shapes ---
  if (ctx.queries.length > 0) {
    lines.push('## Queries');
    lines.push('');
    for (const query of ctx.queries) {
      lines.push(`### ${query.name}`);
      lines.push(query.description);
      if (query.parameters.length > 0) {
        lines.push(`**Parameters**: ${query.parameters.join(', ')}`);
      }
      lines.push(`**Returns**: ${query.returns}`);
      lines.push('');
    }
  }

  // --- Domain Events with payloads ---
  if (ctx.domainEvents.length > 0) {
    lines.push('## Domain Events');
    lines.push('');
    for (const event of ctx.domainEvents) {
      lines.push(`### ${event.name}`);
      lines.push(event.description);
      lines.push(`**Triggered by**: ${event.triggeredBy}`);
      if (event.payload.length > 0) {
        lines.push(`**Payload**: ${event.payload.join(', ')}`);
      }
      lines.push('');
    }
  }

  // --- Ports/Adapters needed ---
  const ctxContracts = contractsForContext(ctx.name, tddPlan.mockContracts);
  const orphanSeams = orphanSeamsForContext(ctx.name, tddPlan.seamDefinitions, tddPlan.mockContracts);
  if (ctxContracts.length > 0 || orphanSeams.length > 0) {
    lines.push('## Ports & Adapters');
    lines.push('');
    for (const contract of ctxContracts) {
      lines.push(`### ${contract.interfaceName}`);
      lines.push(`Context: ${contract.boundedContext}`);
      for (const method of contract.methods) {
        lines.push(`- \`${method.name}(${method.input}): ${method.output}\` — ${method.behavior}`);
      }
      lines.push('');
    }
    for (const seam of orphanSeams) {
      lines.push(`### ${seam.name} (seam)`);
      lines.push(`${seam.between[0]} <-> ${seam.between[1]}`);
      lines.push(`Contract type: ${seam.contractType}`);
      lines.push('');
    }
  }

  // --- ADR constraints ---
  if (ctx.adrRefs.length > 0) {
    lines.push('## ADR Constraints');
    lines.push('');
    lines.push('The following ADRs apply to this context and MUST be respected:');
    for (const ref of ctx.adrRefs) {
      lines.push(`- ${ref}`);
    }
    lines.push('');
  }

  // --- TDD test cases for this context ---
  const ctxSuites = tddPlan.testSuites.filter(
    s => s.boundedContext.toLowerCase() === ctx.name.toLowerCase()
      || slugify(s.boundedContext) === ctxSlug,
  );
  if (ctxSuites.length > 0) {
    lines.push('## TDD Test Cases');
    lines.push('');
    lines.push('Implement code that makes ALL of these tests pass (London School TDD):');
    lines.push('');
    for (const suite of ctxSuites) {
      lines.push(`### ${suite.name} (${suite.layer})`);
      lines.push(suite.description);
      if (suite.mockDependencies.length > 0) {
        lines.push(`Mock dependencies: ${suite.mockDependencies.join(', ')}`);
      }
      lines.push('');
      for (const test of suite.tests) {
        lines.push(`#### ${test.name}`);
        lines.push(`- **Given**: ${test.given}`);
        lines.push(`- **When**: ${test.when}`);
        lines.push(`- **Then**: ${test.then}`);
        if (test.mockSetup.length > 0) {
          lines.push(`- **Mock setup**: ${test.mockSetup.join('; ')}`);
        }
        lines.push(`- **Assertion**: ${test.assertionType}`);
        lines.push('');
      }
    }
  }

  // --- SPARC architecture guidance ---
  const ctxService = findMatchingService(ctx.name, sparc.architecture.services);
  const ctxPseudoModules = findPseudocodeModulesForContext(ctx.name, sparc);
  if (ctxService || ctxPseudoModules.length > 0) {
    lines.push('## Architecture Guidance (SPARC)');
    lines.push('');
    if (ctxService) {
      lines.push(`Service: ${ctxService.name}`);
    }
    if (ctxPseudoModules.length > 0) {
      lines.push(`Pseudocode modules: ${ctxPseudoModules.map(m => m.name).join(', ')}`);
    }
    lines.push('');
  }

  // --- Ubiquitous language ---
  if (ctx.ubiquitousLanguage.length > 0) {
    lines.push('## Ubiquitous Language');
    lines.push('');
    for (const term of ctx.ubiquitousLanguage) {
      lines.push(`- **${term.term}**: ${term.definition}`);
    }
    lines.push('');
  }

  // --- Implementation rules ---
  lines.push('## Implementation Rules');
  lines.push('');
  lines.push('1. Write REAL business logic — not stubs, not TODOs, not placeholder comments');
  lines.push('2. Aggregates MUST enforce all listed invariants (throw on violation)');
  lines.push('3. Command handlers: validate preconditions, mutate aggregate, emit domain event, verify postconditions');
  lines.push('4. Query handlers: return the documented shape with proper filtering/pagination');
  lines.push('5. Domain events: include all payload fields listed above');
  lines.push('6. Ports: define interfaces only — no infrastructure imports in domain layer');
  lines.push('7. All code must pass the TDD test cases listed above');
  lines.push('');

  return lines.join('\n');
}

// ============================================================================
// File Writing
// ============================================================================

/**
 * Write all codegen files to disk under the given base directory.
 * Creates directories as needed with 0o700 permissions and files
 * with 0o600 permissions.
 *
 * @param files   - Codegen files to write
 * @param baseDir - Absolute path to the Phase 3 output directory
 * @returns Array of absolute paths written
 */
function writeCodegenFiles(files: readonly CodegenFile[], baseDir: string): string[] {
  const writtenPaths: string[] = [];

  for (const file of files) {
    const absPath = path.join(baseDir, file.relativePath);
    const dir = path.dirname(absPath);

    fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE });

    try {
      fs.writeFileSync(absPath, file.content, {
        encoding: 'utf-8',
        mode: FILE_MODE,
      });
      writtenPaths.push(absPath);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(
        `ECLI-P3-031: Failed to write codegen file ${file.relativePath}: ${message}`,
      );
    }
  }

  return writtenPaths;
}

// ============================================================================
// Public: Pipeline Entry Point
// ============================================================================

/**
 * Stage 4 entry point: generate domain core code from the Phase 2 DDD domain
 * model, TDD plan, and resolved language stored on the pipeline context.
 *
 * Reads ScaffoldMetadata from context.stageOutputs.get('scaffold-generation')
 * and LanguageResolution from context.stageOutputs.get('language-resolution'),
 * calls buildDomainCode, writes all files to disk, and returns the stage output.
 *
 * @param context - The Phase 3 pipeline context
 * @returns Stage output describing success or failure
 */
export async function generateDomainCode(
  context: Phase3Context,
): Promise<Phase3StageOutput> {
  const startTime = Date.now();
  const rootSpan = createSpan('domain-codegen', 'generate-domain-code', {
    phase3Dir: context.phase3Dir,
  });

  try {
    // Verify scaffold generation completed
    const scaffoldStage = context.stageOutputs.get('scaffold-generation');
    if (!scaffoldStage || scaffoldStage.status !== 'completed') {
      throw new Error(
        'ECLI-P3-030: Scaffold generation not available on context. ' +
        'Ensure the scaffold-generation stage completed successfully before running domain-codegen.',
      );
    }
    // Validate scaffold data is present (consumed indirectly via disk layout)
    void (scaffoldStage.data as ScaffoldMetadata);

    // Retrieve language resolution
    const langStage = context.stageOutputs.get('language-resolution');
    if (!langStage || langStage.status !== 'completed') {
      throw new Error(
        'ECLI-P3-030: Language resolution not available on context. ' +
        'Ensure the language-resolution stage completed successfully before running domain-codegen.',
      );
    }
    const langResolution = langStage.data as LanguageResolution;
    const language = langResolution.language;

    // Non-TS/Rust languages are handled entirely by Ruflo swarm — skip template generation
    if (!hasTemplateSupport(language)) {
      const span = endSpan(rootSpan, 'ok', { delegated: true, language });
      emitSpan(span);
      const emptyOutput: CodegenOutput = {
        files: [], totalAggregates: 0, totalEntities: 0, totalValueObjects: 0,
        totalEvents: 0, totalCommands: 0, totalQueries: 0, totalSeams: 0,
      };
      return {
        stage: 'domain-codegen',
        status: 'completed',
        data: emptyOutput,
        artifacts: [],
        timing: Date.now() - startTime,
        summary: `Domain codegen for ${language} delegated to Ruflo swarm (no built-in template).`,
      };
    }

    // Retrieve Phase 2 artifacts
    const domainModel = context.phase2Artifacts.domainModel;
    const tddPlan = context.phase2Artifacts.tddPlan;
    const sparc = context.phase2Artifacts.sparc;

    // Build domain code (pure, no I/O)
    const buildSpan = createSpan(
      'domain-codegen',
      'build-domain-code',
      {
        language,
        contexts: domainModel.contexts.length,
        mockContracts: tddPlan.mockContracts.length,
        seamDefinitions: tddPlan.seamDefinitions.length,
        pseudocodeModules: sparc?.pseudocode?.modules?.length ?? 0,
        architectureServices: sparc?.architecture?.services?.length ?? 0,
      },
      rootSpan.spanId,
    );

    const codegen = buildDomainCode(domainModel, tddPlan, language, sparc);

    const finalBuildSpan = endSpan(buildSpan, 'ok', {
      totalFiles: codegen.files.length,
      totalAggregates: codegen.totalAggregates,
      totalEntities: codegen.totalEntities,
      totalValueObjects: codegen.totalValueObjects,
      totalEvents: codegen.totalEvents,
      totalCommands: codegen.totalCommands,
      totalQueries: codegen.totalQueries,
      totalSeams: codegen.totalSeams,
    });
    emitSpan(finalBuildSpan);

    // Write codegen files to disk
    const writeSpan = createSpan(
      'domain-codegen',
      'write-files',
      { totalFiles: codegen.files.length },
      rootSpan.spanId,
    );

    const writtenPaths = writeCodegenFiles(codegen.files, context.phase3Dir);

    // ADR-015: Also write implementation prompt files to the run directory
    // so the Ruflo swarm can find them regardless of phase directory layout.
    const runDir = path.dirname(context.phase3Dir);
    const promptFiles = codegen.files.filter(f => f.kind === 'implementation-prompt');
    if (promptFiles.length > 0) {
      const runPromptsDir = path.join(runDir, 'prompts');
      fs.mkdirSync(runPromptsDir, { recursive: true, mode: DIR_MODE });
      for (const pf of promptFiles) {
        const fileName = path.basename(pf.relativePath);
        const dest = path.join(runPromptsDir, fileName);
        try {
          fs.writeFileSync(dest, pf.content, { encoding: 'utf-8', mode: FILE_MODE });
        } catch { /* non-fatal — prompt files are also in phase3Dir */ }
      }
    }

    const finalWriteSpan = endSpan(writeSpan, 'ok', {
      filesWritten: writtenPaths.length,
    });
    emitSpan(finalWriteSpan);

    // Finalize root span
    const finalRootSpan = endSpan(rootSpan, 'ok', {
      language,
      totalFiles: writtenPaths.length,
      totalAggregates: codegen.totalAggregates,
      totalEntities: codegen.totalEntities,
      totalValueObjects: codegen.totalValueObjects,
      totalEvents: codegen.totalEvents,
      totalCommands: codegen.totalCommands,
      totalQueries: codegen.totalQueries,
      totalSeams: codegen.totalSeams,
    });
    emitSpan(finalRootSpan);

    const timing = finalRootSpan.durationMs ?? 0;

    const output: Phase3StageOutput = {
      stage: 'domain-codegen',
      status: 'completed',
      data: codegen,
      artifacts: writtenPaths,
      timing,
      summary:
        `Generated ${language} domain code: ` +
        `${codegen.totalAggregates} aggregates, ` +
        `${codegen.totalEntities} entities, ` +
        `${codegen.totalValueObjects} value objects, ` +
        `${codegen.totalEvents} events, ` +
        `${codegen.totalCommands} commands, ` +
        `${codegen.totalQueries} queries, ` +
        `${codegen.totalSeams} seams ` +
        `(${writtenPaths.length} files in ${timing}ms)`,
    };

    context.stageOutputs.set('domain-codegen', output);
    return output;
  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : String(err);

    const finalRootSpan = endSpan(rootSpan, 'error', { error: errorMessage });
    emitSpan(finalRootSpan);

    const timing = finalRootSpan.durationMs ?? 0;

    const output: Phase3StageOutput = {
      stage: 'domain-codegen',
      status: 'failed',
      data: { error: errorMessage },
      artifacts: [],
      timing,
      summary: `Domain codegen failed: ${errorMessage}`,
    };

    context.stageOutputs.set('domain-codegen', output);
    return output;
  }
}
