/**
 * Phase 5 Quality Gate: Implementation Prompt Validator
 *
 * Validates implementation prompts before ruflo swarm execution.
 * Ensures prompts contain enough domain context for non-generic code.
 * Injects cloud provider, typed fields, and realistic test data.
 *
 * Runs AFTER prior-phase-loading and BEFORE domain-codegen, checking
 * that the merged phase2 artifacts (DDD model, ADRs, SPARC spec)
 * provide sufficient signal for the ruflo swarm to generate
 * domain-specific (not template-generic) implementation code.
 *
 * Error codes:
 *   ECLI-P5-030  Implementation prompt quality too low for code generation
 *   ECLI-P5-031  Required phase artifacts not available for validation
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import type {
  Phase5BuildContext,
  Phase5BuildStage,
} from '../types.js';

// ============================================================================
// Quality Report Types
// ============================================================================

export interface ImplementationQualityReport {
  readonly passed: boolean;
  readonly score: number; // 0-100
  readonly issues: string[];
  readonly cloudProviderDetected: string | null;
  readonly typedFieldsFound: number;
  readonly domainCommandsFound: number;
  readonly genericCRUDDetected: number;
  readonly testDataExamplesFound: number;
  readonly databaseDialectDetected: string | null;
  readonly recordUnknownPatterns: number;
  readonly missingArtifacts: string[];
}

export interface ImplementationStageOutput {
  readonly stage: Phase5BuildStage;
  readonly status: 'completed' | 'failed';
  readonly timing: number;
  readonly artifacts: string[];
  readonly summary: string;
  readonly data: ImplementationQualityReport;
}

// ============================================================================
// Detection Patterns
// ============================================================================

/**
 * Cloud provider detection patterns with canonical names.
 */
const CLOUD_PROVIDER_DETECTORS: ReadonlyArray<{ name: string; patterns: readonly RegExp[] }> = [
  {
    name: 'AWS',
    patterns: [
      /\b(?:AWS|Amazon\s*Web\s*Services)\b/gi,
      /\b(?:Lambda|DynamoDB|S3|SQS|SNS|ECS|EKS|Aurora|RDS|Kinesis|EventBridge|CloudFormation|CDK|Fargate|Step\s*Functions)\b/g,
    ],
  },
  {
    name: 'Azure',
    patterns: [
      /\bAzure\b/gi,
      /\b(?:Cosmos\s*DB|Azure\s*Functions|AKS|Azure\s*SQL|Service\s*Bus|Event\s*Grid|Bicep)\b/gi,
    ],
  },
  {
    name: 'GCP',
    patterns: [
      /\b(?:GCP|Google\s*Cloud)\b/gi,
      /\b(?:Cloud\s*Run|Cloud\s*SQL|Pub\/Sub|BigQuery|Firestore|Cloud\s*Functions|GKE|Spanner|Datastore)\b/gi,
    ],
  },
];

/**
 * Database dialect detection with canonical names.
 */
const DATABASE_DIALECT_DETECTORS: ReadonlyArray<{ name: string; patterns: readonly RegExp[] }> = [
  { name: 'PostgreSQL', patterns: [/\b(?:PostgreSQL|Postgres|pg_|pgcrypto|JSONB|SERIAL|BIGSERIAL|CREATE\s+EXTENSION)\b/gi] },
  { name: 'MySQL', patterns: [/\b(?:MySQL|MariaDB|AUTO_INCREMENT|ENGINE\s*=\s*InnoDB)\b/gi] },
  { name: 'DynamoDB', patterns: [/\b(?:DynamoDB|partition\s*key|sort\s*key|GSI|LSI|PutItem|GetItem|BatchWrite)\b/gi] },
  { name: 'MongoDB', patterns: [/\b(?:MongoDB|Mongoose|ObjectId|collection\.|aggregate\s*pipeline)\b/gi] },
  { name: 'CosmosDB', patterns: [/\b(?:Cosmos\s*DB|CosmosDB|partition\s*key|cross-partition|RU\/s)\b/gi] },
  { name: 'SQL Server', patterns: [/\b(?:SQL\s*Server|MSSQL|T-SQL|NVARCHAR|UNIQUEIDENTIFIER|GETDATE)\b/gi] },
  { name: 'Firestore', patterns: [/\b(?:Firestore|document\s*reference|collection\s*group|subcollection)\b/gi] },
];

/**
 * Typed field patterns (from DDD entities/value objects).
 * Match concrete field definitions, not generic placeholders.
 */
const TYPED_FIELD_PATTERNS: readonly RegExp[] = [
  /\b\w+\s*:\s*(?:string|number|boolean|Date|UUID|decimal|integer|float|bigint|enum)\b/gi,
  /\b(?:readonly|public|private)\s+\w+\s*:\s*[A-Z]\w+/g,
  /\b\w+Id\s*:\s*(?:string|UUID|number)\b/gi,
  /\b\w+(?:Amount|Price|Total|Quantity|Count)\s*:\s*(?:number|decimal|Decimal|Money)\b/gi,
  /\b\w+(?:Date|Time|At|Timestamp)\s*:\s*(?:Date|DateTime|Instant|string)\b/gi,
  /\b\w+(?:Status|State|Phase)\s*:\s*(?:enum|string|'[^']+'\s*\|)/gi,
];

/**
 * Generic CRUD command patterns (indicate non-domain-specific generation).
 */
const GENERIC_CRUD_PATTERNS: readonly RegExp[] = [
  /\b(?:Create|Read|Update|Delete|List|Get|Set|Remove)\s*(?:Item|Record|Entry|Data|Entity|Resource|Object)\b/g,
  /\b(?:CRUD|crud)\s+(?:operation|endpoint|handler|controller)\b/gi,
  /\b(?:generic(?:Controller|Service|Repository|Handler))\b/g,
];

/**
 * Domain-specific command patterns (the GOOD kind).
 */
const DOMAIN_COMMAND_PATTERNS: readonly RegExp[] = [
  // PascalCase verbs + domain nouns (e.g. SubmitPurchaseOrder, ApproveBatchRelease)
  /\b(?:Submit|Approve|Reject|Cancel|Complete|Start|Initiate|Process|Verify|Validate|Register|Assign|Allocate|Release|Transfer|Dispatch|Reconcile|Archive|Amend|Revoke|Escalate|Finalize|Authorize)\s*[A-Z][a-z]+(?:[A-Z][a-z]+)*/g,
  // Domain event names (PascalCase + Past tense)
  /\b[A-Z][a-z]+(?:[A-Z][a-z]+)*(?:Created|Updated|Completed|Approved|Rejected|Cancelled|Submitted|Processed|Verified|Released|Dispatched|Reconciled|Archived)\b/g,
];

/**
 * Test data example patterns (realistic data, not just "test" or "sample").
 */
const TEST_DATA_PATTERNS: readonly RegExp[] = [
  // Specific numeric values (not just 0, 1, or round numbers)
  /\b(?:\d{3,}(?:\.\d{1,2})?)\b/g,
  // Date literals
  /\b(?:20\d{2}-\d{2}-\d{2}|January|February|March|April|May|June|July|August|September|October|November|December)\b/g,
  // UUID-like patterns
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
  // Email patterns in test data
  /\b\w+@\w+\.\w{2,4}\b/g,
  // Realistic business terms in test data (order numbers, part numbers, etc.)
  /\b(?:ORD|INV|PO|WO|SO|BOM|SKU|LOT|BATCH)-\d{3,}/g,
];

/**
 * Record<string, unknown> or similar untyped patterns in implementation artifacts.
 */
const RECORD_UNKNOWN_PATTERNS: readonly RegExp[] = [
  /Record\s*<\s*string\s*,\s*(?:unknown|any)\s*>/g,
  /\[key:\s*string\]\s*:\s*(?:unknown|any)/g,
  /:\s*(?:unknown|any)\s*(?:\[\])?(?:\s*[;,}])/g,
  /\bObject\.keys\b.*\bas\s+any\b/g,
];

// ============================================================================
// Artifact Loading
// ============================================================================

/**
 * Expected artifact files and their descriptions.
 */
const EXPECTED_ARTIFACTS: ReadonlyArray<{ filename: string; label: string; required: boolean }> = [
  { filename: 'ddd/domain-model.json', label: 'DDD domain model', required: true },
  { filename: 'sparc/sparc-combined.json', label: 'SPARC specification', required: true },
  { filename: 'adrs/adr-index.json', label: 'ADR index', required: false },
  { filename: 'tdd/tdd-plan.json', label: 'TDD plan', required: false },
];

/**
 * Load and concatenate all textual artifact content from a merged phase2 directory.
 * Returns the combined text for pattern scanning, plus a list of missing artifacts.
 */
function loadArtifactCorpus(
  phase2Dir: string,
): { corpus: string; missingArtifacts: string[] } {
  const parts: string[] = [];
  const missingArtifacts: string[] = [];

  for (const { filename, label, required } of EXPECTED_ARTIFACTS) {
    const fullPath = path.join(phase2Dir, filename);
    if (!fs.existsSync(fullPath)) {
      if (required) missingArtifacts.push(label);
      continue;
    }
    try {
      const content = fs.readFileSync(fullPath, 'utf-8');
      parts.push(content);
    } catch {
      if (required) missingArtifacts.push(`${label} (read error)`);
    }
  }

  // Also scan any markdown files in the phase2 directory tree
  const mdFiles = findFilesRecursive(phase2Dir, '.md', 10);
  for (const mdPath of mdFiles) {
    try {
      parts.push(fs.readFileSync(mdPath, 'utf-8'));
    } catch { /* skip unreadable */ }
  }

  return { corpus: parts.join('\n'), missingArtifacts };
}

/**
 * Recursively find files with a given extension, up to a max count.
 */
function findFilesRecursive(dir: string, ext: string, maxFiles: number): string[] {
  const results: string[] = [];
  if (!fs.existsSync(dir)) return results;

  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (results.length >= maxFiles) break;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory() && !['node_modules', '.git'].includes(entry.name)) {
        results.push(...findFilesRecursive(fullPath, ext, maxFiles - results.length));
      } else if (entry.isFile() && entry.name.endsWith(ext)) {
        results.push(fullPath);
      }
    }
  } catch { /* skip unreadable directories */ }

  return results;
}

// ============================================================================
// Counting Helpers
// ============================================================================

function countUniqueMatches(text: string, patterns: readonly RegExp[]): number {
  const matches = new Set<string>();
  for (const pattern of patterns) {
    const re = new RegExp(pattern.source, pattern.flags);
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      matches.add(m[0].toLowerCase().trim());
    }
  }
  return matches.size;
}

function detectProvider(
  text: string,
  detectors: ReadonlyArray<{ name: string; patterns: readonly RegExp[] }>,
): string | null {
  let bestName: string | null = null;
  let bestCount = 0;

  for (const { name, patterns } of detectors) {
    let count = 0;
    for (const pattern of patterns) {
      const re = new RegExp(pattern.source, pattern.flags);
      const matches = text.match(re);
      if (matches) count += matches.length;
    }
    if (count > bestCount) {
      bestCount = count;
      bestName = name;
    }
  }

  return bestCount >= 2 ? bestName : null;
}

// ============================================================================
// Main Validation
// ============================================================================

const PASSING_SCORE = 60;

const WEIGHTS = {
  cloudProvider: 15,       // cloud provider directive present
  typedFields: 25,         // typed field definitions from DDD model
  domainCommands: 20,      // domain-specific commands (not generic CRUD)
  testData: 10,            // realistic test data examples
  databaseDialect: 10,     // database-specific SQL dialect hints
  artifactCompleteness: 10, // all expected artifacts present
  contentIntegrity: 10,    // no Record<string, unknown> patterns
} as const;

/**
 * Validate implementation artifacts quality before ruflo swarm execution.
 */
export function validateImplementationQuality(
  corpus: string,
  missingArtifacts: string[],
): ImplementationQualityReport {
  const issues: string[] = [];

  // ---- Empty corpus fast-path ----
  if (corpus.trim().length === 0) {
    return {
      passed: false,
      score: 0,
      issues: ['No implementation artifacts found. Phase 2 output may be empty or unreachable.'],
      cloudProviderDetected: null,
      typedFieldsFound: 0,
      domainCommandsFound: 0,
      genericCRUDDetected: 0,
      testDataExamplesFound: 0,
      databaseDialectDetected: null,
      recordUnknownPatterns: 0,
      missingArtifacts,
    };
  }

  // ---- Detect signals ----

  // 1. Cloud provider
  const cloudProviderDetected = detectProvider(corpus, CLOUD_PROVIDER_DETECTORS);

  // 2. Typed fields
  const typedFieldsFound = countUniqueMatches(corpus, TYPED_FIELD_PATTERNS);

  // 3. Domain-specific commands vs generic CRUD
  const domainCommandsFound = countUniqueMatches(corpus, DOMAIN_COMMAND_PATTERNS);
  const genericCRUDDetected = countUniqueMatches(corpus, GENERIC_CRUD_PATTERNS);

  // 4. Test data examples
  const testDataExamplesFound = countUniqueMatches(corpus, TEST_DATA_PATTERNS);

  // 5. Database dialect
  const databaseDialectDetected = detectProvider(corpus, DATABASE_DIALECT_DETECTORS);

  // 6. Record<string, unknown> patterns
  const recordUnknownPatterns = countUniqueMatches(corpus, RECORD_UNKNOWN_PATTERNS);

  // ---- Compute sub-scores ----

  // Cloud provider (binary: detected or not)
  const cloudScore = cloudProviderDetected
    ? WEIGHTS.cloudProvider
    : 0;

  // Typed fields (full marks at >= 10 typed fields)
  const typedFieldsRatio = Math.min(1, typedFieldsFound / 10);
  const typedFieldsScore = typedFieldsRatio * WEIGHTS.typedFields;

  // Domain commands (full marks at >= 5, penalize if too many generic CRUDs)
  const domainRatio = Math.min(1, domainCommandsFound / 5);
  const crudPenalty = genericCRUDDetected > domainCommandsFound && domainCommandsFound < 3
    ? 0.5  // halve the score if generic CRUD dominates
    : 1.0;
  const domainScore = domainRatio * crudPenalty * WEIGHTS.domainCommands;

  // Test data (full marks at >= 5 examples)
  const testDataRatio = Math.min(1, testDataExamplesFound / 5);
  const testDataScore = testDataRatio * WEIGHTS.testData;

  // Database dialect (binary: detected or not)
  const dbScore = databaseDialectDetected
    ? WEIGHTS.databaseDialect
    : 0;

  // Artifact completeness
  const requiredArtifacts = EXPECTED_ARTIFACTS.filter((a) => a.required);
  const missingRequired = missingArtifacts.filter((m) =>
    requiredArtifacts.some((a) => a.label === m || m.startsWith(a.label)),
  );
  const artifactRatio = requiredArtifacts.length > 0
    ? (requiredArtifacts.length - missingRequired.length) / requiredArtifacts.length
    : 1;
  const artifactScore = artifactRatio * WEIGHTS.artifactCompleteness;

  // Content integrity (penalize Record<string, unknown>)
  const integrityPenalty = Math.min(WEIGHTS.contentIntegrity, recordUnknownPatterns * 2);
  const integrityScore = WEIGHTS.contentIntegrity - integrityPenalty;

  const rawScore = cloudScore + typedFieldsScore + domainScore +
    testDataScore + dbScore + artifactScore + integrityScore;
  const score = Math.max(0, Math.min(100, Math.round(rawScore)));

  // ---- Collect actionable issues ----

  if (!cloudProviderDetected) {
    issues.push(
      'No cloud provider detected in implementation artifacts. ' +
      'Specify AWS, Azure, or GCP so code generation uses the correct SDK, service names, and deployment targets.',
    );
  }

  if (typedFieldsFound < 10) {
    issues.push(
      `Only ${typedFieldsFound}/10 typed field definitions found. ` +
      'DDD model should include concrete types (e.g. "orderId: UUID", "amount: Decimal") not just entity names.',
    );
  }

  if (domainCommandsFound < 5) {
    issues.push(
      `Only ${domainCommandsFound}/5 domain-specific commands found. ` +
      'Use domain verbs (SubmitOrder, ApproveRelease) instead of generic CRUD (CreateItem, UpdateRecord).',
    );
  }

  if (genericCRUDDetected > domainCommandsFound && domainCommandsFound < 3) {
    issues.push(
      `${genericCRUDDetected} generic CRUD patterns detected vs ${domainCommandsFound} domain commands. ` +
      'Domain commands should outnumber generic CRUD to prevent template-like code generation.',
    );
  }

  if (testDataExamplesFound < 5) {
    issues.push(
      `Only ${testDataExamplesFound}/5 realistic test data examples found. ` +
      'Add concrete examples: dates, order numbers (e.g. ORD-12345), UUIDs, realistic amounts.',
    );
  }

  if (!databaseDialectDetected) {
    issues.push(
      'No database dialect detected. Specify the database engine (PostgreSQL, DynamoDB, etc.) ' +
      'so code generation produces correct SQL dialect, index strategies, and connection patterns.',
    );
  }

  if (missingRequired.length > 0) {
    issues.push(
      `Missing required artifacts: ${missingRequired.join(', ')}. ` +
      'Phase 2 pipeline may not have completed successfully.',
    );
  }

  if (recordUnknownPatterns > 0) {
    issues.push(
      `${recordUnknownPatterns} untyped patterns detected (Record<string, unknown>, [key: string]: any). ` +
      'Replace with concrete typed interfaces from the DDD model.',
    );
  }

  const passed = score >= PASSING_SCORE;

  return {
    passed,
    score,
    issues,
    cloudProviderDetected,
    typedFieldsFound,
    domainCommandsFound,
    genericCRUDDetected,
    testDataExamplesFound,
    databaseDialectDetected,
    recordUnknownPatterns,
    missingArtifacts,
  };
}

// ============================================================================
// Pipeline Stage Entry Point
// ============================================================================

/**
 * Execute the implementation quality gate as a Phase 5 pipeline stage.
 *
 * Scans the merged phase2 artifacts directory for domain context signals
 * and validates that enough information is present for non-generic code
 * generation by the ruflo swarm.
 *
 * @param context - Phase 5 build context with directory paths
 * @returns Stage output indicating pass or fail with actionable issues
 */
export async function executeImplementationQualityGate(
  context: Phase5BuildContext,
): Promise<ImplementationStageOutput> {
  const start = Date.now();

  // Look for merged phase2 artifacts in the phase5 build directory
  const mergedPhase2Dir = path.join(context.phase5Dir, '.phase2-merged');
  const phase2Dir = fs.existsSync(mergedPhase2Dir) ? mergedPhase2Dir : context.phase2Dir;

  if (!fs.existsSync(phase2Dir)) {
    const elapsed = Date.now() - start;
    return {
      stage: 'prior-phase-loading',
      status: 'failed',
      timing: elapsed,
      artifacts: [],
      summary: 'ECLI-P5-031: Phase 2 artifacts directory not found. Cannot validate implementation readiness.',
      data: {
        passed: false,
        score: 0,
        issues: [`Phase 2 directory not found: ${phase2Dir}`],
        cloudProviderDetected: null,
        typedFieldsFound: 0,
        domainCommandsFound: 0,
        genericCRUDDetected: 0,
        testDataExamplesFound: 0,
        databaseDialectDetected: null,
        recordUnknownPatterns: 0,
        missingArtifacts: ['all'],
      },
    };
  }

  const { corpus, missingArtifacts } = loadArtifactCorpus(phase2Dir);
  const report = validateImplementationQuality(corpus, missingArtifacts);
  const elapsed = Date.now() - start;

  if (!report.passed) {
    console.error(`  [QUALITY-GATE] Implementation artifacts FAILED (score: ${report.score}/100)`);
    for (const issue of report.issues) {
      console.error(`    - ${issue}`);
    }

    return {
      stage: 'prior-phase-loading',
      status: 'failed',
      timing: elapsed,
      artifacts: [],
      summary:
        `ECLI-P5-030: Implementation prompt quality too low (score: ${report.score}/100, minimum: ${PASSING_SCORE}). ` +
        `Issues: ${report.issues.join(' | ')}`,
      data: report,
    };
  }

  console.error(`  [QUALITY-GATE] Implementation artifacts PASSED (score: ${report.score}/100)`);
  console.error(`    Cloud: ${report.cloudProviderDetected ?? 'none'}, DB: ${report.databaseDialectDetected ?? 'none'}, ` +
    `Typed fields: ${report.typedFieldsFound}, Domain commands: ${report.domainCommandsFound}`);

  return {
    stage: 'prior-phase-loading',
    status: 'completed',
    timing: elapsed,
    artifacts: [],
    summary:
      `Implementation quality gate passed (score: ${report.score}/100). ` +
      `Cloud: ${report.cloudProviderDetected ?? 'undetected'}, DB: ${report.databaseDialectDetected ?? 'undetected'}, ` +
      `${report.typedFieldsFound} typed fields, ${report.domainCommandsFound} domain commands.`,
    data: report,
  };
}
