/**
 * Phase 2 Quality Gate: Deep Research Validator
 *
 * Validates research dossier completeness before allowing downstream phases.
 * Prevents empty domain models by ensuring research contains:
 * - Domain entity definitions with field types
 * - Industry-specific terminology
 * - Technology stack constraints (cloud provider, database, ERP system)
 * - Functional requirements (not placeholders)
 *
 * Error codes:
 *   ECLI-P2-030  Research dossier quality too low for downstream phases
 *   ECLI-P2-031  Research dossier missing from context
 */

import type {
  Phase2Context,
  Phase2StageOutput,
  ResearchDossier,
  DossierItem,
} from '../types.js';

// ============================================================================
// Quality Report Types
// ============================================================================

export interface ResearchQualityReport {
  readonly passed: boolean;
  readonly score: number; // 0-100
  readonly issues: string[];
  readonly domainEntitiesFound: number;
  readonly industryTermsFound: number;
  readonly techConstraintsFound: number;
  readonly functionalRequirementsFound: number;
  readonly quantitativeCriteriaFound: number;
  readonly placeholdersDetected: number;
}

// ============================================================================
// Detection Patterns
// ============================================================================

/**
 * Patterns that indicate PascalCase entity names or explicit entity keywords.
 * Matches words like "InvoiceLineItem", "ProductionOrder", "aggregate root".
 */
const ENTITY_PATTERNS: readonly RegExp[] = [
  /\b[A-Z][a-z]+(?:[A-Z][a-z]+){1,5}\b/g,                    // PascalCase multi-word
  /\b(?:entity|aggregate|model|value\s*object|domain\s*object|root)\b/gi,
  /\b(?:bounded\s*context|aggregate\s*root|domain\s*event)\b/gi,
  /\b[A-Z][a-z]+(?:Service|Repository|Factory|Handler|Controller|Manager)\b/g,
];

/**
 * Generic filler words that should NOT count as industry terms.
 * We subtract matches of these from industry term counts.
 */
const GENERIC_FILLER: ReadonlySet<string> = new Set([
  'system', 'data', 'process', 'information', 'management', 'solution',
  'platform', 'service', 'application', 'module', 'component', 'tool',
  'user', 'admin', 'interface', 'feature', 'function', 'item', 'record',
  'type', 'value', 'status', 'result', 'input', 'output', 'request',
  'response', 'object', 'thing', 'stuff', 'etc',
]);

/**
 * Technology constraint patterns: cloud providers, databases, ERP systems,
 * message brokers, and other concrete technology references.
 */
const TECH_CONSTRAINT_PATTERNS: readonly RegExp[] = [
  // Cloud providers
  /\b(?:AWS|Amazon\s*Web\s*Services|Azure|Google\s*Cloud|GCP|Cloud\s*Run|Lambda|ECS|EKS|AKS|GKE)\b/gi,
  /\b(?:S3|DynamoDB|RDS|Aurora|Cosmos\s*DB|BigQuery|Cloud\s*SQL|Firestore|Redshift)\b/gi,
  // Databases
  /\b(?:PostgreSQL|Postgres|MySQL|MariaDB|MongoDB|Redis|Cassandra|CockroachDB|SQLite|Oracle\s*DB)\b/gi,
  /\b(?:Elasticsearch|OpenSearch|Neo4j|InfluxDB|TimescaleDB|Supabase|PlanetScale)\b/gi,
  // ERP systems
  /\b(?:SAP|S\/4HANA|SAP\s*HANA|Oracle\s*ERP|NetSuite|Dynamics\s*365|Odoo|Infor|Epicor|IFS)\b/gi,
  /\b(?:ABAP|BAPI|IDoc|RFC|OData)\b/gi,
  // Message brokers / queues
  /\b(?:Kafka|RabbitMQ|SQS|SNS|Pub\/Sub|EventBridge|NATS|Pulsar)\b/gi,
  // Containerization / orchestration
  /\b(?:Docker|Kubernetes|k8s|Terraform|Helm|Istio|Envoy)\b/gi,
  // Programming languages / frameworks (when used as constraints)
  /\b(?:TypeScript|Rust|Go(?:lang)?|Python|Java(?:Script)?|\.NET|C#|Node\.js|Deno|Bun)\b/g,
];

/**
 * Functional requirement indicators: modal verbs + action verbs.
 */
const REQUIREMENT_PATTERNS: readonly RegExp[] = [
  /\b(?:must|shall|should|will|need\s*to|required\s*to)\s+\w+/gi,
  /\b(?:the\s+system\s+(?:must|shall|should|will))\b/gi,
  /\b(?:users?\s+(?:must|shall|should|can|will)\s+be\s+able\s+to)\b/gi,
  /\b(?:support(?:s|ing)?\s+(?:for|of)\b)/gi,
  /\b(?:integrate[sd]?\s+with|connect[sd]?\s+to|interface[sd]?\s+with)\b/gi,
];

/**
 * Quantitative criteria patterns: numbers, percentages, SLAs, thresholds.
 */
const QUANTITATIVE_PATTERNS: readonly RegExp[] = [
  /\b\d+(?:\.\d+)?\s*(?:%|percent|ms|milliseconds?|seconds?|minutes?|hours?|days?)\b/gi,
  /\b(?:SLA|uptime|availability|latency|throughput|p\d{2,3})\b/gi,
  /\b(?:at\s+least|no\s+more\s+than|maximum|minimum|within|under|over)\s+\d+/gi,
  /\b\d+(?:,\d{3})*\s+(?:users?|requests?|transactions?|records?|rows?|events?)\b/gi,
  /\b(?:99\.9+%|five\s*nines?|four\s*nines?|three\s*nines?)\b/gi,
];

/**
 * Placeholder patterns that indicate incomplete or stubbed content.
 */
const PLACEHOLDER_PATTERNS: readonly RegExp[] = [
  /\b(?:to\s+be\s+derived|to\s+be\s+determined|to\s+be\s+defined)\b/gi,
  /\b(?:TBD|TBA|TODO|FIXME|PLACEHOLDER|XXX|HACK)\b/g,
  /\b(?:lorem\s+ipsum|placeholder\s+text|sample\s+data)\b/gi,
  /\[\s*(?:insert|add|fill\s+in|describe|specify)\b/gi,
  /\b(?:will\s+be\s+(?:added|defined|specified|determined)\s+later)\b/gi,
];

// ============================================================================
// Counting Helpers
// ============================================================================

/**
 * Count unique matches across all items for a set of patterns.
 * Returns the number of distinct match strings found.
 */
function countPatternMatches(
  items: readonly DossierItem[],
  patterns: readonly RegExp[],
): number {
  const matches = new Set<string>();
  const corpus = items.map((i) => `${i.title} ${i.content}`).join('\n');

  for (const pattern of patterns) {
    // Reset lastIndex for global regexps
    const re = new RegExp(pattern.source, pattern.flags);
    let m: RegExpExecArray | null;
    while ((m = re.exec(corpus)) !== null) {
      matches.add(m[0].toLowerCase().trim());
    }
  }
  return matches.size;
}

/**
 * Count domain entity references (PascalCase names, entity keywords).
 * Filters out generic terms to avoid false positives.
 */
function countDomainEntities(items: readonly DossierItem[]): number {
  const entities = new Set<string>();
  const corpus = items.map((i) => `${i.title} ${i.content}`).join('\n');

  for (const pattern of ENTITY_PATTERNS) {
    const re = new RegExp(pattern.source, pattern.flags);
    let m: RegExpExecArray | null;
    while ((m = re.exec(corpus)) !== null) {
      const term = m[0].trim();
      // Skip single-word generic filler
      if (!GENERIC_FILLER.has(term.toLowerCase())) {
        entities.add(term);
      }
    }
  }
  return entities.size;
}

/**
 * Count industry-specific terms by finding multi-word noun phrases
 * that are NOT in the generic filler set.
 */
function countIndustryTerms(items: readonly DossierItem[]): number {
  const terms = new Set<string>();
  const corpus = items.map((i) => `${i.title} ${i.content}`).join('\n');

  // Look for capitalized multi-word phrases (2-4 words)
  const phrasePattern = /\b[A-Z][a-z]+(?:\s+[A-Z]?[a-z]+){1,3}\b/g;
  let m: RegExpExecArray | null;
  while ((m = phrasePattern.exec(corpus)) !== null) {
    const phrase = m[0].trim();
    const words = phrase.toLowerCase().split(/\s+/);
    // At least one word must not be generic filler
    const hasSpecific = words.some((w) => !GENERIC_FILLER.has(w));
    if (hasSpecific) {
      terms.add(phrase.toLowerCase());
    }
  }

  // Also match known domain abbreviations (3+ uppercase letters)
  const abbrPattern = /\b[A-Z]{3,}\b/g;
  while ((m = abbrPattern.exec(corpus)) !== null) {
    const abbr = m[0];
    // Skip very common non-domain abbreviations
    const skipAbbr = new Set(['THE', 'AND', 'FOR', 'NOT', 'BUT', 'HAS', 'ARE', 'WAS', 'ALL', 'CAN', 'HAD', 'HER', 'WHO', 'OUR', 'OUT', 'DAY', 'GET', 'HOW', 'ITS', 'MAY', 'NEW', 'NOW', 'OLD', 'SEE', 'WAY', 'USE', 'HIS', 'ONE', 'TWO']);
    if (!skipAbbr.has(abbr)) {
      terms.add(abbr.toLowerCase());
    }
  }

  return terms.size;
}

/**
 * Count placeholder / stub indicators in dossier content.
 */
function countPlaceholders(items: readonly DossierItem[]): number {
  return countPatternMatches(items, PLACEHOLDER_PATTERNS);
}

// ============================================================================
// Main Validation
// ============================================================================

const PASSING_SCORE = 60;

/** Weight allocation for scoring (must sum to 100). */
const WEIGHTS = {
  domainEntities: 25,
  industryTerms: 20,
  techConstraints: 15,
  functionalRequirements: 25,
  quantitativeCriteria: 10,
  placeholderPenalty: 5,
} as const;

/** Thresholds for full marks in each category. */
const THRESHOLDS = {
  domainEntities: 5,
  industryTerms: 4,
  techConstraints: 2,
  functionalRequirements: 5,
  quantitativeCriteria: 3,
  placeholderMax: 0,   // any placeholders start reducing score
} as const;

/**
 * Validate research dossier quality and produce a detailed report.
 *
 * Scoring:
 *   - Domain entities found:         25 pts (full at >= 5 entities)
 *   - Industry-specific terms:       20 pts (full at >= 4 terms)
 *   - Technology constraints:        15 pts (full at >= 2 constraints)
 *   - Functional requirements:       25 pts (full at >= 5 requirements)
 *   - Quantitative criteria:         10 pts (full at >= 3 criteria)
 *   - Placeholder penalty:           -5 pts per placeholder detected
 */
export function validateResearchQuality(dossier: ResearchDossier): ResearchQualityReport {
  const issues: string[] = [];
  const items = dossier.items;

  // ---- Empty dossier fast-path ----
  if (!items || items.length === 0) {
    return {
      passed: false,
      score: 0,
      issues: ['Research dossier contains zero items. Phase 1 artifacts may not have been processed.'],
      domainEntitiesFound: 0,
      industryTermsFound: 0,
      techConstraintsFound: 0,
      functionalRequirementsFound: 0,
      quantitativeCriteriaFound: 0,
      placeholdersDetected: 0,
    };
  }

  // ---- Count signals ----
  const domainEntitiesFound = countDomainEntities(items);
  const industryTermsFound = countIndustryTerms(items);
  const techConstraintsFound = countPatternMatches(items, TECH_CONSTRAINT_PATTERNS);
  const functionalRequirementsFound = countPatternMatches(items, REQUIREMENT_PATTERNS);
  const quantitativeCriteriaFound = countPatternMatches(items, QUANTITATIVE_PATTERNS);
  const placeholdersDetected = countPlaceholders(items);

  // ---- Compute sub-scores ----
  const entityScore = Math.min(1, domainEntitiesFound / THRESHOLDS.domainEntities) * WEIGHTS.domainEntities;
  const industryScore = Math.min(1, industryTermsFound / THRESHOLDS.industryTerms) * WEIGHTS.industryTerms;
  const techScore = Math.min(1, techConstraintsFound / THRESHOLDS.techConstraints) * WEIGHTS.techConstraints;
  const reqScore = Math.min(1, functionalRequirementsFound / THRESHOLDS.functionalRequirements) * WEIGHTS.functionalRequirements;
  const quantScore = Math.min(1, quantitativeCriteriaFound / THRESHOLDS.quantitativeCriteria) * WEIGHTS.quantitativeCriteria;
  const placeholderPenalty = placeholdersDetected * WEIGHTS.placeholderPenalty;

  const rawScore = entityScore + industryScore + techScore + reqScore + quantScore - placeholderPenalty;
  const score = Math.max(0, Math.min(100, Math.round(rawScore)));

  // ---- Collect actionable issues ----
  if (domainEntitiesFound < THRESHOLDS.domainEntities) {
    issues.push(
      `Only ${domainEntitiesFound}/${THRESHOLDS.domainEntities} domain entities detected. ` +
      'Add PascalCase entity names (e.g. ProductionOrder, InvoiceLineItem) or explicit "entity"/"aggregate" keywords.',
    );
  }

  if (industryTermsFound < THRESHOLDS.industryTerms) {
    issues.push(
      `Only ${industryTermsFound}/${THRESHOLDS.industryTerms} industry-specific terms found. ` +
      'Dossier may be too generic. Include domain vocabulary (e.g. "Bill of Materials", "General Ledger", "Batch Record").',
    );
  }

  if (techConstraintsFound < THRESHOLDS.techConstraints) {
    issues.push(
      `Only ${techConstraintsFound}/${THRESHOLDS.techConstraints} technology constraints detected. ` +
      'Specify cloud provider (AWS/Azure/GCP), database engine (PostgreSQL/DynamoDB), or ERP system (SAP/Oracle).',
    );
  }

  if (functionalRequirementsFound < THRESHOLDS.functionalRequirements) {
    issues.push(
      `Only ${functionalRequirementsFound}/${THRESHOLDS.functionalRequirements} functional requirements found. ` +
      'Use "must", "shall", "should" + verb phrases to express concrete requirements.',
    );
  }

  if (quantitativeCriteriaFound < THRESHOLDS.quantitativeCriteria) {
    issues.push(
      `Only ${quantitativeCriteriaFound}/${THRESHOLDS.quantitativeCriteria} quantitative criteria found. ` +
      'Add measurable targets: SLAs, percentages, latency bounds, throughput numbers.',
    );
  }

  if (placeholdersDetected > 0) {
    issues.push(
      `${placeholdersDetected} placeholder(s) detected ("TBD", "to be derived", etc.). ` +
      'Replace placeholders with concrete content before proceeding.',
    );
  }

  const passed = score >= PASSING_SCORE;

  return {
    passed,
    score,
    issues,
    domainEntitiesFound,
    industryTermsFound,
    techConstraintsFound,
    functionalRequirementsFound,
    quantitativeCriteriaFound,
    placeholdersDetected,
  };
}

// ============================================================================
// Pipeline Stage Entry Point
// ============================================================================

/**
 * Execute the research quality gate as a Phase 2 pipeline stage.
 *
 * Reads the research dossier from context stage outputs, validates it,
 * and returns a stage output indicating pass or fail with actionable issues.
 *
 * @throws Error with ECLI-P2-031 if research dossier is not on context
 */
export async function executeResearchQualityGate(
  context: Phase2Context,
): Promise<Phase2StageOutput> {
  const start = Date.now();

  // Retrieve dossier from prior stage output
  const dossierOutput = context.stageOutputs.get('research-dossier');
  if (!dossierOutput || dossierOutput.status !== 'completed' || !dossierOutput.data) {
    throw new Error(
      'ECLI-P2-031: Research dossier not available on context. ' +
      'The research-dossier stage must complete successfully before the research quality gate.',
    );
  }

  const dossier = dossierOutput.data as ResearchDossier;
  const report = validateResearchQuality(dossier);
  const elapsed = Date.now() - start;

  if (!report.passed) {
    console.error(`  [QUALITY-GATE] Research dossier FAILED (score: ${report.score}/100)`);
    for (const issue of report.issues) {
      console.error(`    - ${issue}`);
    }

    return {
      stage: 'research-dossier',
      status: 'failed',
      data: report,
      artifacts: [],
      timing: elapsed,
      summary:
        `ECLI-P2-030: Research dossier quality too low (score: ${report.score}/100, minimum: ${PASSING_SCORE}). ` +
        `Issues: ${report.issues.join(' | ')}`,
    };
  }

  console.error(`  [QUALITY-GATE] Research dossier PASSED (score: ${report.score}/100)`);
  console.error(`    Entities: ${report.domainEntitiesFound}, Industry terms: ${report.industryTermsFound}, ` +
    `Tech constraints: ${report.techConstraintsFound}, Requirements: ${report.functionalRequirementsFound}`);

  return {
    stage: 'research-dossier',
    status: 'completed',
    data: report,
    artifacts: [],
    timing: elapsed,
    summary:
      `Research quality gate passed (score: ${report.score}/100). ` +
      `Found ${report.domainEntitiesFound} entities, ${report.industryTermsFound} industry terms, ` +
      `${report.techConstraintsFound} tech constraints, ${report.functionalRequirementsFound} requirements.`,
  };
}
