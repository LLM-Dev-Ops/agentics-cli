/**
 * Phase 2 Quality Gate: DDD Model Validator
 *
 * Validates DDD domain model completeness before code generation.
 * Prevents copy-paste entities by ensuring:
 * - Every bounded context has aggregates with typed fields
 * - Ubiquitous language glossary is non-empty
 * - Context map has real relationships
 * - ADRs reference correct technology (not wrong ERP/cloud provider)
 *
 * Error codes:
 *   ECLI-P2-050  DDD model quality too low for code generation
 *   ECLI-P2-051  DDD model not available on context
 *   ECLI-P2-052  ADR technology mismatch detected
 */

import type {
  Phase2Context,
  Phase2StageOutput,
  Phase2DomainModel,
  Phase2AggregateDefinition,
  Phase2ADRRecord,
} from '../types.js';

// ============================================================================
// Quality Report Types
// ============================================================================

export interface DDDQualityReport {
  readonly passed: boolean;
  readonly score: number; // 0-100
  readonly issues: string[];
  readonly totalContexts: number;
  readonly contextsWithAggregates: number;
  readonly aggregatesWithTypedFields: number;
  readonly totalAggregates: number;
  readonly ubiquitousLanguageTerms: number;
  readonly contextMapRelations: number;
  readonly genericIndexSignaturesDetected: number;
  readonly technologyMismatches: string[];
}

// ============================================================================
// Detection Patterns
// ============================================================================

/**
 * Generic index signature patterns that indicate copy-paste or untyped entities.
 * These produce `Record<string, unknown>` style types in generated code.
 */
const GENERIC_SIGNATURE_PATTERNS: readonly RegExp[] = [
  /\[key:\s*string\]\s*:\s*unknown/g,
  /\[key:\s*string\]\s*:\s*any/g,
  /Record\s*<\s*string\s*,\s*(?:unknown|any)\s*>/g,
  /\{\s*\[k:\s*string\]\s*:\s*\w+\s*\}/g,
  /\bMap\s*<\s*string\s*,\s*(?:unknown|any)\s*>/g,
];

/**
 * Known cloud provider names for technology mismatch detection.
 */
const CLOUD_PROVIDERS: ReadonlyMap<string, readonly string[]> = new Map([
  ['aws', ['AWS', 'Amazon', 'Lambda', 'DynamoDB', 'S3', 'SQS', 'SNS', 'ECS', 'EKS', 'Aurora', 'RDS', 'Kinesis', 'EventBridge', 'CloudFormation', 'CDK']],
  ['azure', ['Azure', 'Cosmos DB', 'Azure Functions', 'AKS', 'Azure SQL', 'Service Bus', 'Event Grid', 'Bicep', 'ARM']],
  ['gcp', ['GCP', 'Google Cloud', 'Cloud Run', 'Cloud SQL', 'Pub/Sub', 'BigQuery', 'Firestore', 'Cloud Functions', 'GKE', 'Spanner']],
]);

/**
 * Known ERP system names for technology mismatch detection.
 */
const ERP_SYSTEMS: ReadonlyMap<string, readonly string[]> = new Map([
  ['sap', ['SAP', 'S/4HANA', 'SAP HANA', 'ABAP', 'BAPI', 'IDoc', 'RFC', 'OData']],
  ['oracle', ['Oracle ERP', 'Oracle Cloud', 'JD Edwards', 'PeopleSoft']],
  ['dynamics', ['Dynamics 365', 'D365', 'Business Central', 'Finance and Operations']],
  ['netsuite', ['NetSuite', 'SuiteScript', 'SuiteFlow']],
]);

/**
 * Known database engines for technology mismatch detection.
 */
const DATABASE_ENGINES: ReadonlyMap<string, readonly string[]> = new Map([
  ['postgresql', ['PostgreSQL', 'Postgres', 'pg_']],
  ['mysql', ['MySQL', 'MariaDB']],
  ['dynamodb', ['DynamoDB']],
  ['mongodb', ['MongoDB', 'Mongoose']],
  ['cosmosdb', ['Cosmos DB', 'CosmosDB']],
  ['firestore', ['Firestore']],
  ['sqlserver', ['SQL Server', 'MSSQL', 'T-SQL']],
]);

// ============================================================================
// Validation Helpers
// ============================================================================

/**
 * Check if an aggregate has typed fields (not just names).
 * Typed fields means entities or value objects with descriptions
 * that contain type information, or invariants that reference fields.
 */
function aggregateHasTypedFields(agg: Phase2AggregateDefinition): boolean {
  // Check entities have non-trivial descriptions (> 15 chars, not just the name repeated)
  const typedEntities = agg.entities.filter((e) =>
    e.description.length > 15 &&
    e.description.toLowerCase() !== e.name.toLowerCase() &&
    !isGenericDescription(e.description),
  );

  // Check value objects have invariants and non-trivial descriptions
  const typedValueObjects = agg.valueObjects.filter((vo) =>
    vo.description.length > 15 &&
    (vo.invariants.length > 0 || hasFieldTypeIndicators(vo.description)),
  );

  // At least one entity or value object must have real type info
  return typedEntities.length > 0 || typedValueObjects.length > 0;
}

/**
 * Detect generic/placeholder descriptions that don't add real type information.
 */
function isGenericDescription(desc: string): boolean {
  const lower = desc.toLowerCase().trim();
  const genericPhrases = [
    'represents a',
    'contains data',
    'holds information',
    'stores data',
    'generic entity',
    'base entity',
    'to be defined',
    'placeholder',
    'tbd',
  ];
  return genericPhrases.some((p) => lower.startsWith(p) || lower === p);
}

/**
 * Check whether a description contains field-type indicators
 * (e.g. "string", "number", "Date", "UUID", "decimal").
 */
function hasFieldTypeIndicators(desc: string): boolean {
  return /\b(?:string|number|boolean|Date|UUID|decimal|integer|float|bigint|enum|array|list)\b/i.test(desc);
}

/**
 * Detect generic index signature patterns in DDD model content.
 */
function countGenericSignatures(model: Phase2DomainModel): number {
  const allText = serializeModelText(model);
  let count = 0;
  for (const pattern of GENERIC_SIGNATURE_PATTERNS) {
    const re = new RegExp(pattern.source, pattern.flags);
    const matches = allText.match(re);
    if (matches) count += matches.length;
  }
  return count;
}

/**
 * Serialize all DDD model text content for scanning.
 */
function serializeModelText(model: Phase2DomainModel): string {
  const parts: string[] = [];

  for (const ctx of model.contexts) {
    parts.push(ctx.name, ctx.description);
    for (const agg of ctx.aggregates) {
      parts.push(agg.name, agg.root);
      for (const e of agg.entities) parts.push(e.name, e.description);
      for (const vo of agg.valueObjects) parts.push(vo.name, vo.description, ...vo.invariants);
      parts.push(...agg.invariants);
    }
    for (const evt of ctx.domainEvents) parts.push(evt.name, evt.description, ...evt.payload);
    for (const cmd of ctx.commands) parts.push(cmd.name, cmd.description, ...cmd.input, ...cmd.preconditions, ...cmd.postconditions);
    for (const q of ctx.queries) parts.push(q.name, q.description, q.returns, ...q.parameters);
    for (const term of ctx.ubiquitousLanguage) parts.push(term.term, term.definition);
  }

  for (const rel of model.contextMap) parts.push(rel.upstream, rel.downstream, rel.description, rel.type);
  for (const term of model.ubiquitousLanguageGlossary) parts.push(term.term, term.definition);

  return parts.join('\n');
}

/**
 * Detect technology mismatches between ADRs and user-stated constraints.
 *
 * Extracts the dominant cloud provider, ERP system, and database from the DDD
 * model text, then checks ADRs for references to competing technologies.
 */
function detectTechnologyMismatches(
  model: Phase2DomainModel,
  adrs: readonly Phase2ADRRecord[],
): string[] {
  const mismatches: string[] = [];
  const modelText = serializeModelText(model).toLowerCase();
  const adrText = adrs.map((a) => `${a.context} ${a.decision} ${a.title}`).join('\n').toLowerCase();
  const combinedText = `${modelText}\n${adrText}`;

  // Detect dominant technologies in the model
  const detectedCloud = detectDominant(combinedText, CLOUD_PROVIDERS);
  const detectedERP = detectDominant(combinedText, ERP_SYSTEMS);
  const _detectedDB = detectDominant(combinedText, DATABASE_ENGINES);
  void _detectedDB; // reserved for future DB mismatch checks

  // Check ADRs for competing cloud provider references
  if (detectedCloud) {
    for (const [provider, keywords] of CLOUD_PROVIDERS) {
      if (provider === detectedCloud) continue;
      for (const kw of keywords) {
        if (adrText.includes(kw.toLowerCase())) {
          mismatches.push(
            `ADR references ${kw} (${provider}) but dominant cloud provider in model is ${detectedCloud}. ` +
            'Verify the correct cloud provider is used consistently.',
          );
          break; // One mismatch per provider is enough
        }
      }
    }
  }

  // Check ADRs for competing ERP references
  if (detectedERP) {
    for (const [system, keywords] of ERP_SYSTEMS) {
      if (system === detectedERP) continue;
      for (const kw of keywords) {
        if (adrText.includes(kw.toLowerCase())) {
          mismatches.push(
            `ADR references ${kw} (${system}) but dominant ERP system in model is ${detectedERP}. ` +
            'Ensure ADRs align with the user\'s stated ERP system.',
          );
          break;
        }
      }
    }
  }

  return mismatches;
}

/**
 * Find the dominant technology from a set of known providers/systems
 * by counting keyword occurrences in the text.
 */
function detectDominant(
  text: string,
  providers: ReadonlyMap<string, readonly string[]>,
): string | null {
  let maxCount = 0;
  let dominant: string | null = null;

  for (const [name, keywords] of providers) {
    let count = 0;
    for (const kw of keywords) {
      const re = new RegExp(`\\b${escapeRegExp(kw)}\\b`, 'gi');
      const matches = text.match(re);
      if (matches) count += matches.length;
    }
    if (count > maxCount) {
      maxCount = count;
      dominant = name;
    }
  }

  // Only return if there's a meaningful signal (at least 2 mentions)
  return maxCount >= 2 ? dominant : null;
}

/** Escape special regex characters in a string. */
function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ============================================================================
// Main Validation
// ============================================================================

const PASSING_SCORE = 60;

const WEIGHTS = {
  contextsExist: 15,           // at least one bounded context
  aggregatesTyped: 25,         // aggregates have typed fields
  ubiquitousLanguage: 15,      // glossary is non-empty
  contextMapComplete: 15,      // context map has real relations
  commandsAndEvents: 15,       // domain has commands and events
  contentIntegrity: 10,        // no generic index signatures
  technologyAlignment: 5,      // ADR tech matches model tech
} as const;

/**
 * Validate DDD domain model quality and produce a detailed report.
 */
export function validateDDDQuality(
  model: Phase2DomainModel,
  adrs?: readonly Phase2ADRRecord[],
): DDDQualityReport {
  const issues: string[] = [];

  const contexts = model.contexts;
  const totalContexts = contexts.length;

  // ---- Empty model fast-path ----
  if (totalContexts === 0) {
    return {
      passed: false,
      score: 0,
      issues: ['DDD model contains zero bounded contexts. DDD generation may have failed entirely.'],
      totalContexts: 0,
      contextsWithAggregates: 0,
      aggregatesWithTypedFields: 0,
      totalAggregates: 0,
      ubiquitousLanguageTerms: 0,
      contextMapRelations: 0,
      genericIndexSignaturesDetected: 0,
      technologyMismatches: [],
    };
  }

  // ---- Count signals ----

  // 1. Contexts with aggregates
  const contextsWithAggregates = contexts.filter((c) => c.aggregates.length > 0).length;

  // 2. Aggregates with typed fields
  const allAggregates = contexts.flatMap((c) => c.aggregates);
  const totalAggregates = allAggregates.length;
  const aggregatesWithTypedFields = allAggregates.filter(aggregateHasTypedFields).length;

  // 3. Ubiquitous language terms (context-level + global glossary)
  const contextLevelTerms = contexts.flatMap((c) => c.ubiquitousLanguage).length;
  const globalTerms = model.ubiquitousLanguageGlossary.length;
  const ubiquitousLanguageTerms = contextLevelTerms + globalTerms;

  // 4. Context map relations
  const contextMapRelations = model.contextMap.length;

  // 5. Commands and events (indicate real domain modeling, not just CRUD)
  const totalCommands = contexts.flatMap((c) => c.commands).length;
  const totalEvents = contexts.flatMap((c) => c.domainEvents).length;

  // 6. Generic index signatures
  const genericIndexSignaturesDetected = countGenericSignatures(model);

  // 7. Technology mismatches (only if ADRs provided)
  const technologyMismatches = adrs ? detectTechnologyMismatches(model, adrs) : [];

  // ---- Compute sub-scores ----

  // Contexts exist
  const contextsScore = totalContexts > 0
    ? (contextsWithAggregates / totalContexts) * WEIGHTS.contextsExist
    : 0;

  // Aggregates typed
  const aggRatio = totalAggregates > 0 ? aggregatesWithTypedFields / totalAggregates : 0;
  const aggregatesScore = aggRatio * WEIGHTS.aggregatesTyped;

  // Ubiquitous language
  const ulThreshold = 5;
  const ulRatio = Math.min(1, ubiquitousLanguageTerms / ulThreshold);
  const ulScore = ulRatio * WEIGHTS.ubiquitousLanguage;

  // Context map
  const expectedRelations = Math.max(1, totalContexts - 1); // at least N-1 relations
  const cmRatio = Math.min(1, contextMapRelations / expectedRelations);
  const cmScore = cmRatio * WEIGHTS.contextMapComplete;

  // Commands and events (expect at least 1 per context)
  const ceRatio = totalContexts > 0
    ? Math.min(1, (totalCommands + totalEvents) / (totalContexts * 2))
    : 0;
  const ceScore = ceRatio * WEIGHTS.commandsAndEvents;

  // Content integrity (penalize generic signatures)
  const integrityPenalty = Math.min(WEIGHTS.contentIntegrity, genericIndexSignaturesDetected * 2);
  const integrityScore = WEIGHTS.contentIntegrity - integrityPenalty;

  // Technology alignment
  const techPenalty = Math.min(WEIGHTS.technologyAlignment, technologyMismatches.length * 2.5);
  const techScore = WEIGHTS.technologyAlignment - techPenalty;

  const rawScore = contextsScore + aggregatesScore + ulScore + cmScore +
    ceScore + integrityScore + techScore;
  const score = Math.max(0, Math.min(100, Math.round(rawScore)));

  // ---- Collect actionable issues ----

  if (contextsWithAggregates < totalContexts) {
    issues.push(
      `Only ${contextsWithAggregates}/${totalContexts} bounded contexts have aggregates. ` +
      'Every bounded context should define at least one aggregate root.',
    );
  }

  if (totalAggregates > 0 && aggregatesWithTypedFields < totalAggregates) {
    issues.push(
      `Only ${aggregatesWithTypedFields}/${totalAggregates} aggregates have typed field definitions. ` +
      'Entities and value objects need descriptions with concrete types, not just names.',
    );
  }

  if (ubiquitousLanguageTerms === 0) {
    issues.push(
      'Ubiquitous language glossary is empty. Add domain terms with definitions.',
    );
  } else if (ubiquitousLanguageTerms < ulThreshold) {
    issues.push(
      `Only ${ubiquitousLanguageTerms}/${ulThreshold} ubiquitous language terms defined. ` +
      'Expand the glossary to cover key domain concepts.',
    );
  }

  if (totalContexts > 1 && contextMapRelations === 0) {
    issues.push(
      'Context map has no relationships despite multiple bounded contexts. ' +
      'Define upstream/downstream relationships between contexts.',
    );
  } else if (totalContexts > 1 && contextMapRelations < totalContexts - 1) {
    issues.push(
      `Only ${contextMapRelations} context map relations for ${totalContexts} contexts. ` +
      `Expected at least ${totalContexts - 1} relationships.`,
    );
  }

  if (totalCommands === 0) {
    issues.push(
      'No domain commands defined. Add commands that express intent to change domain state.',
    );
  }

  if (totalEvents === 0) {
    issues.push(
      'No domain events defined. Add events that signal meaningful state changes.',
    );
  }

  if (genericIndexSignaturesDetected > 0) {
    issues.push(
      `${genericIndexSignaturesDetected} generic index signatures detected (e.g. "[key: string]: unknown"). ` +
      'Replace with concrete typed fields to prevent Record<string, unknown> in generated code.',
    );
  }

  for (const mismatch of technologyMismatches) {
    issues.push(`ECLI-P2-052: ${mismatch}`);
  }

  const passed = score >= PASSING_SCORE;

  return {
    passed,
    score,
    issues,
    totalContexts,
    contextsWithAggregates,
    aggregatesWithTypedFields,
    totalAggregates,
    ubiquitousLanguageTerms,
    contextMapRelations,
    genericIndexSignaturesDetected,
    technologyMismatches,
  };
}

// ============================================================================
// Pipeline Stage Entry Point
// ============================================================================

/**
 * Execute the DDD quality gate as a Phase 2 pipeline stage.
 *
 * Reads the DDD domain model and optionally ADRs from context stage outputs,
 * validates the model, and returns a stage output indicating pass or fail.
 *
 * @throws Error with ECLI-P2-051 if DDD model is not on context
 */
export async function executeDDDQualityGate(
  context: Phase2Context,
): Promise<Phase2StageOutput> {
  const start = Date.now();

  const dddOutput = context.stageOutputs.get('ddd-generation');
  if (!dddOutput || dddOutput.status !== 'completed' || !dddOutput.data) {
    throw new Error(
      'ECLI-P2-051: DDD model not available on context. ' +
      'The ddd-generation stage must complete successfully before the DDD quality gate.',
    );
  }

  const model = dddOutput.data as Phase2DomainModel;

  // Optionally load ADRs for technology mismatch detection
  const adrOutput = context.stageOutputs.get('adr-generation');
  const adrs = (adrOutput?.status === 'completed' && adrOutput.data)
    ? (adrOutput.data as { records: Phase2ADRRecord[] }).records ?? []
    : [];

  const report = validateDDDQuality(model, adrs);
  const elapsed = Date.now() - start;

  if (!report.passed) {
    console.error(`  [QUALITY-GATE] DDD model FAILED (score: ${report.score}/100)`);
    for (const issue of report.issues) {
      console.error(`    - ${issue}`);
    }

    return {
      stage: 'ddd-generation',
      status: 'failed',
      data: report,
      artifacts: [],
      timing: elapsed,
      summary:
        `ECLI-P2-050: DDD model quality too low (score: ${report.score}/100, minimum: ${PASSING_SCORE}). ` +
        `Issues: ${report.issues.join(' | ')}`,
    };
  }

  console.error(`  [QUALITY-GATE] DDD model PASSED (score: ${report.score}/100)`);
  console.error(`    Contexts: ${report.totalContexts}, Aggregates: ${report.totalAggregates} ` +
    `(${report.aggregatesWithTypedFields} typed), UL terms: ${report.ubiquitousLanguageTerms}`);

  return {
    stage: 'ddd-generation',
    status: 'completed',
    data: report,
    artifacts: [],
    timing: elapsed,
    summary:
      `DDD quality gate passed (score: ${report.score}/100). ` +
      `${report.totalContexts} contexts, ${report.totalAggregates} aggregates, ` +
      `${report.ubiquitousLanguageTerms} UL terms validated.`,
  };
}
