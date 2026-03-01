/**
 * Phase 2 Pipeline -- Stage 3: SPARC Specification
 *
 * Generates a complete SPARC specification (Specification, Pseudocode,
 * Architecture, Refinement, Completion) from the research dossier compiled
 * in Stage 2 and the Phase 1 artifacts loaded in Stage 1.
 *
 * Every element in the output carries `dossierItemRefs` for full traceability
 * back to the research dossier.
 *
 * Error codes:
 *   ECLI-P2-010  Research dossier not available on context
 *   ECLI-P2-011  SPARC file write failure
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import type {
  Phase2Context,
  Phase2StageOutput,
  ResearchDossier,
  Phase1Artifacts,
  Phase2SPARCOutput,
  Phase2Specification,
  Phase2Pseudocode,
  Phase2Architecture,
  Phase2Refinement,
  Phase2Completion,
  Phase2Requirement,
  Phase2Constraint,
  Phase2SuccessCriterion,
  Phase2PseudocodeModule,
  Phase2ServiceDefinition,
} from '../types.js';
import { createSpan, endSpan, emitSpan } from '../telemetry.js';
import { renderSPARCMarkdown } from '../renderers/markdown-renderer.js';

// ============================================================================
// Constants
// ============================================================================

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const SPARC_SUBDIR = 'sparc';

/** Regex that detects measurable numeric thresholds in text. */
const MEASURABLE_RE = /\d+%|>=?\s*\d+|<\s*\d+/;

/** Keywords that indicate security-related risk items. */
const SECURITY_KEYWORDS: readonly string[] = [
  'security', 'auth', 'access', 'pii', 'data-protection', 'credential',
  'encryption', 'authorization', 'authentication', 'privilege', 'rbac',
  'iam', 'token', 'secret', 'vulnerability',
];

/** Keywords for detecting external systems in scenario/dossier text. */
const INTEGRATION_KEYWORDS: ReadonlyArray<{ keyword: string; system: string }> = [
  { keyword: 'sap', system: 'sap' },
  { keyword: 'bigquery', system: 'bigquery' },
  { keyword: 'dataflow', system: 'dataflow' },
  { keyword: 'erp', system: 'erp' },
  { keyword: 'webhook', system: 'webhook' },
  { keyword: 'api gateway', system: 'api-gateway-ext' },
  { keyword: 'salesforce', system: 'salesforce' },
  { keyword: 'kafka', system: 'kafka' },
  { keyword: 'redis', system: 'redis' },
  { keyword: 'elasticsearch', system: 'elasticsearch' },
  { keyword: 'snowflake', system: 'snowflake' },
  { keyword: 'postgres', system: 'postgres' },
  { keyword: 'mongodb', system: 'mongodb' },
  { keyword: 'dynamodb', system: 'dynamodb' },
  { keyword: 's3', system: 's3' },
];

// ============================================================================
// Helpers
// ============================================================================

/**
 * Zero-padded index string for deterministic IDs (e.g. "001", "012").
 */
function pad3(n: number): string {
  return String(n).padStart(3, '0');
}

/**
 * Check whether a dossier item's content mentions any of the given keywords
 * (case-insensitive).
 */
function contentMatchesKeywords(content: string, keywords: readonly string[]): boolean {
  const lower = content.toLowerCase();
  return keywords.some((kw) => lower.includes(kw.toLowerCase()));
}

/**
 * Convert text to a URL-safe slug: lowercase, non-alphanumeric replaced with
 * hyphens, trimmed of leading/trailing hyphens.
 */
function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/**
 * Stop words and common verbs to strip when deriving domain concept names
 * from risk item titles. Keeps only domain-significant nouns.
 */
const DOMAIN_NAME_STOP_WORDS = new Set([
  // articles & prepositions
  'a', 'an', 'the', 'of', 'to', 'in', 'for', 'on', 'at', 'by', 'with', 'from',
  'into', 'through', 'during', 'before', 'after', 'above', 'below', 'between',
  // conjunctions
  'and', 'or', 'but', 'nor', 'so', 'yet',
  // common verbs
  'may', 'might', 'can', 'could', 'will', 'would', 'shall', 'should', 'must',
  'be', 'is', 'are', 'was', 'were', 'been', 'being', 'have', 'has', 'had',
  'do', 'does', 'did', 'require', 'requires', 'required', 'need', 'needs',
  'extend', 'extends', 'include', 'includes', 'involve', 'involves',
  'ensure', 'ensures', 'maintain', 'maintains', 'create', 'creates',
  'implement', 'implements', 'provide', 'provides', 'support', 'supports',
  // qualifiers
  'new', 'existing', 'current', 'additional', 'specific', 'various',
  'potential', 'possible', 'multiple', 'several', 'other',
  // generic terms
  'requirements', 'requirement', 'process', 'processes', 'system', 'systems',
  'management', 'operations', 'activities', 'aspects', 'factors',
]);

/**
 * Extract a concise domain concept (max 3 nouns) from a risk item title.
 *
 * "Compliance requirements may extend to third-party vendors" → "compliance-vendors"
 * "Data privacy: GDPR regulations for customer data" → "data-privacy"
 * "Revenue leakage through unreconciled intercompany transfers" → "revenue-leakage-transfers"
 */
function extractDomainConcept(title: string): string {
  // If there's a colon, use text before it (usually a clean label)
  const colonIdx = title.indexOf(':');
  const raw = colonIdx !== -1 ? title.slice(0, colonIdx) : title;

  const words = raw
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 1 && !DOMAIN_NAME_STOP_WORDS.has(w));

  // Take up to 3 domain-significant words
  const significant = words.slice(0, 3);

  if (significant.length === 0) {
    // Fallback: take first 2 words from original
    const fallback = raw.toLowerCase().split(/\s+/).filter((w) => w.length > 1).slice(0, 2);
    return fallback.join('-') || 'domain-concern';
  }

  return significant.join('-');
}

/**
 * Convert text to camelCase by slugifying first, then removing hyphens and
 * capitalizing the following letter.
 */
function camelCase(text: string): string {
  return slugify(text).replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
}

/**
 * Dynamically compute dossier item refs for a service by matching keywords
 * extracted from the service name and responsibility against dossier item
 * titles and content (case-insensitive).
 */
function computeDossierRefs(
  serviceName: string,
  responsibility: string,
  dossier: ResearchDossier,
): string[] {
  // Extract keywords from service name (split on hyphens) and responsibility
  const nameWords = serviceName.split('-').filter((w) => w.length > 2);
  const responsibilityWords = responsibility
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 3);

  const keywords = Array.from(new Set([...nameWords, ...responsibilityWords]));

  const refs: string[] = [];
  for (const item of dossier.items) {
    if (
      contentMatchesKeywords(item.content, keywords) ||
      contentMatchesKeywords(item.title, keywords)
    ) {
      refs.push(item.id);
    }
  }
  return Array.from(new Set(refs));
}

// ============================================================================
// Specification Builder
// ============================================================================

function buildSpecification(
  dossier: ResearchDossier,
  artifacts: Phase1Artifacts,
): Phase2Specification {
  const requirements: Phase2Requirement[] = [];
  const constraints: Phase2Constraint[] = [];
  const successCriteria: Phase2SuccessCriterion[] = [];
  const referencedIds = new Set<string>();

  // --- Requirements from dossier items ---
  let reqIdx = 1;
  for (const item of dossier.items) {
    if (item.category === 'requirement' || item.category === 'recommendation') {
      const priority: 'must' | 'should' | 'could' =
        item.source === 'risk-assessment' || item.source === 'decision-memo'
          ? 'must'
          : 'should';

      requirements.push({
        id: `SPEC-REQ-${pad3(reqIdx)}`,
        text: item.content,
        dossierItemRefs: [item.id],
        priority,
      });
      referencedIds.add(item.id);
      reqIdx++;
    }
  }

  // --- Synthetic requirements from scenario.constraints ---
  const scenario = artifacts.scenario;
  if (scenario.constraints) {
    for (const constraint of scenario.constraints) {
      requirements.push({
        id: `SPEC-REQ-${pad3(reqIdx)}`,
        text: constraint,
        dossierItemRefs: [],
        priority: 'must',
      });
      reqIdx++;
    }
  }

  // --- Constraints from dossier items ---
  let conIdx = 1;
  for (const item of dossier.items) {
    if (item.category === 'constraint') {
      constraints.push({
        id: `SPEC-CON-${pad3(conIdx)}`,
        text: item.content,
        dossierItemRefs: [item.id],
      });
      referencedIds.add(item.id);
      conIdx++;
    }
  }

  // --- Success Criteria from dossier items ---
  let scIdx = 1;
  for (const item of dossier.items) {
    if (item.category === 'success-criterion') {
      successCriteria.push({
        id: `SPEC-SC-${pad3(scIdx)}`,
        text: item.content,
        dossierItemRefs: [item.id],
        measurable: MEASURABLE_RE.test(item.content),
      });
      referencedIds.add(item.id);
      scIdx++;
    }
  }

  const dossierCoverage =
    dossier.items.length > 0
      ? (referencedIds.size / dossier.items.length) * 100
      : 0;

  const scope = `Full implementation scope for: ${artifacts.scenario.query ?? 'Phase 2 pipeline output'}`;

  return {
    requirements,
    constraints,
    successCriteria,
    scope,
    dossierCoverage: Math.round(dossierCoverage * 100) / 100,
  };
}

// ============================================================================
// Capability Detection & Pseudocode Builder
// ============================================================================

/**
 * Known capability patterns with keyword matchers and pseudocode templates.
 * Each pattern generates real algorithmic pseudocode (control flow, types,
 * error handling) instead of comment stubs.
 */
interface CapabilityPattern {
  readonly id: string;
  readonly name: string;
  /** All keywords must match (case-insensitive OR within group). */
  readonly keywords: string[][];
  /** Generates real pseudocode from matched dossier items + scenario context. */
  buildMarkdown(items: typeof EMPTY_ITEMS, scenarioText: string): string;
  buildDataStructures(items: typeof EMPTY_ITEMS): string[];
  buildTddAnchors(items: typeof EMPTY_ITEMS): string[];
}

const EMPTY_ITEMS: ResearchDossier['items'] = [];

/**
 * Extract domain-specific nouns from dossier content for use in pseudocode.
 * Returns entity names, field names, and system references found in the text.
 */
function extractDomainNouns(text: string): { entities: string[]; systems: string[]; fields: string[] } {
  const lower = text.toLowerCase();
  const entities: string[] = [];
  const systems: string[] = [];
  const fields: string[] = [];

  // Detect entity types
  const entityPatterns: Array<[RegExp, string]> = [
    [/invoice/i, 'Invoice'], [/supplier/i, 'Supplier'], [/vendor/i, 'Vendor'],
    [/contract/i, 'Contract'], [/purchase.?order/i, 'PurchaseOrder'],
    [/emission/i, 'EmissionsRecord'], [/scope.?3/i, 'Scope3Emission'],
    [/business.?partner/i, 'BusinessPartner'], [/material/i, 'Material'],
    [/payment/i, 'Payment'], [/receipt/i, 'Receipt'], [/shipment/i, 'Shipment'],
    [/document/i, 'Document'], [/report/i, 'Report'], [/audit/i, 'AuditEntry'],
  ];
  for (const [re, name] of entityPatterns) {
    if (re.test(lower)) entities.push(name);
  }

  // Detect system references
  const systemPatterns: Array<[RegExp, string]> = [
    [/sap\s*s\/4\s*hana/i, 'SAP S/4HANA'], [/sap/i, 'SAP'], [/odata/i, 'OData'],
    [/cloud\s*run/i, 'Cloud Run'], [/cloud\s*functions/i, 'Cloud Functions'],
    [/hana/i, 'SAP HANA'], [/ruvector/i, 'Ruvector'], [/bigquery/i, 'BigQuery'],
    [/salesforce/i, 'Salesforce'], [/kafka/i, 'Kafka'],
  ];
  for (const [re, name] of systemPatterns) {
    if (re.test(lower)) systems.push(name);
  }

  // Detect field/data patterns
  const fieldPatterns: Array<[RegExp, string]> = [
    [/pdf/i, 'pdfContent'], [/email/i, 'emailPayload'], [/json/i, 'jsonPayload'],
    [/confidence/i, 'confidenceScore'], [/schema/i, 'schemaDefinition'],
    [/token/i, 'authToken'], [/endpoint/i, 'serviceEndpoint'],
    [/rollback/i, 'rollbackState'], [/drift/i, 'driftMetrics'],
  ];
  for (const [re, name] of fieldPatterns) {
    if (re.test(lower)) fields.push(name);
  }

  return {
    entities: Array.from(new Set(entities)),
    systems: Array.from(new Set(systems)),
    fields: Array.from(new Set(fields)),
  };
}

const CAPABILITY_PATTERNS: CapabilityPattern[] = [
  // --- Ingestion ---
  {
    id: 'ingestion',
    name: 'Document Ingestion Service',
    keywords: [['ingest', 'pdf', 'email', 'document', 'listener', 'upload', 'receive']],
    buildMarkdown(items, scenarioText) {
      const nouns = extractDomainNouns(items.map((i) => i.content).join(' ') + ' ' + scenarioText);
      const entity = nouns.entities[0] ?? 'Document';
      const hasPdf = scenarioText.toLowerCase().includes('pdf');
      const hasEmail = scenarioText.toLowerCase().includes('email');
      return [
        `FUNCTION ingestDocument(source: ${hasPdf ? 'PDFBinary | ' : ''}${hasEmail ? 'EmailMIME | ' : ''}RawPayload): ${entity}Payload`,
        `  // Accepts raw documents and normalizes into structured payload`,
        `  // Traces: ${items.map((i) => i.id).join(', ')}`,
        ``,
        `  INPUT:  source       -- raw document (${[hasPdf && 'PDF binary', hasEmail && 'email MIME'].filter(Boolean).join(', ') || 'raw bytes'})`,
        `  OUTPUT: ${entity}Payload  -- validated, structured payload with extraction metadata`,
        ``,
        `  traceId = generateTraceId()`,
        `  LOG("ingestion_start", { traceId, sourceType: typeOf(source) })`,
        ``,
        ...(hasPdf ? [
          `  IF source IS PDFBinary:`,
          `    rawText   = extractTextFromPDF(source)`,
          `    tables    = extractTablesFromPDF(source)`,
          `    metadata  = extractPDFMetadata(source)   // page count, creator, dates`,
          ``,
        ] : []),
        ...(hasEmail ? [
          `  ${hasPdf ? 'ELSE ' : ''}IF source IS EmailMIME:`,
          `    rawText      = parseEmailBody(source)`,
          `    attachments  = extractAttachments(source)`,
          `    FOR EACH attachment IN attachments:`,
          `      IF attachment.mimeType == "application/pdf":`,
          `        rawText += "\\n" + extractTextFromPDF(attachment.content)`,
          `        tables  += extractTablesFromPDF(attachment.content)`,
          ``,
        ] : []),
        `  ELSE:`,
        `    rawText = decodeUTF8(source)`,
        `    tables  = []`,
        ``,
        `  // Field extraction with confidence scoring`,
        `  extracted = extractStructuredFields(rawText, tables)`,
        ``,
        `  // Schema validation against target format`,
        `  validation = validateAgainstSchema(extracted, ${entity}Schema)`,
        `  IF NOT validation.isValid:`,
        `    LOG_WARN("ingestion_validation_failed", { traceId, errors: validation.errors })`,
        `    appendToAuditMemory("ingestion_rejected", { traceId, errors: validation.errors })`,
        `    THROW ValidationError(validation.errors)`,
        ``,
        `  payload = ${entity}Payload {`,
        ...nouns.entities.slice(0, 3).map((e) => `    ${camelCase(e)}: extracted.${camelCase(e)},`),
        `    lineItems:    extracted.lineItems,`,
        `    rawText:      rawText,`,
        `    confidence:   extracted.confidence,`,
        `    traceId:      traceId,`,
        `    ingestedAt:   NOW(),`,
        `    sourceFormat: typeOf(source),`,
        `  }`,
        ``,
        `  appendToAuditMemory("ingestion_complete", { traceId, fieldCount: keys(payload).length })`,
        `  LOG("ingestion_complete", { traceId, confidence: payload.confidence })`,
        `  RETURN payload`,
      ].join('\n');
    },
    buildDataStructures(items) {
      const nouns = extractDomainNouns(items.map((i) => i.content).join(' '));
      const entity = nouns.entities[0] ?? 'Document';
      return [
        `${entity}Payload { ${camelCase(entity)}Id: string; lineItems: LineItem[]; rawText: string; confidence: number; traceId: string; ingestedAt: ISO8601; sourceFormat: string }`,
        `LineItem { description: string; quantity: number; unit: string; amount: number; category: string; emissionsFactor?: number }`,
        `ValidationResult { isValid: boolean; errors: ValidationError[]; warnings: string[]; confidence: number }`,
      ];
    },
    buildTddAnchors(_items) {
      return [
        'TEST: Valid PDF ingestion produces structured payload with confidence > 0.8',
        'TEST: Valid email with PDF attachment extracts text from attachment',
        'TEST: Malformed PDF returns ValidationError with descriptive message',
        'TEST: Empty document returns ValidationError, not crash',
        'TEST: Audit memory receives ingestion_complete event with traceId',
        'TEST: Each ingested field has a confidence score between 0.0 and 1.0',
      ];
    },
  },

  // --- LLM Extraction ---
  {
    id: 'extraction',
    name: 'LLM Data Extraction Service',
    keywords: [['llm', 'extract', 'ai', 'model', 'prompt', 'gpt', 'claude', 'anthropic', 'nlp']],
    buildMarkdown(items, scenarioText) {
      const nouns = extractDomainNouns(items.map((i) => i.content).join(' ') + ' ' + scenarioText);
      const entity = nouns.entities.find((e) => e !== 'AuditEntry') ?? 'Record';
      const targetSchema = nouns.entities.includes('Scope3Emission') ? 'Scope3EmissionsSchema' :
        nouns.entities.includes('EmissionsRecord') ? 'EmissionsRecordSchema' : `${entity}Schema`;
      return [
        `FUNCTION extractStructuredData(payload: IngestedPayload, schema: JSONSchema): ExtractionResult`,
        `  // LLM-based extraction with schema validation and confidence scoring`,
        `  // Traces: ${items.map((i) => i.id).join(', ')}`,
        ``,
        `  INPUT:  payload  -- ingested document payload with raw text and tables`,
        `          schema   -- target JSON schema (e.g. ${targetSchema})`,
        `  OUTPUT: ExtractionResult -- structured data matching schema, with per-field confidence`,
        ``,
        `  traceId = payload.traceId`,
        `  LOG("extraction_start", { traceId, schemaName: schema.title })`,
        ``,
        `  // 1. Build extraction prompt with schema constraints`,
        `  systemPrompt = buildSystemPrompt(schema)`,
        `  userPrompt   = buildExtractionPrompt(payload.rawText, payload.lineItems, schema)`,
        ``,
        `  // 2. Policy check BEFORE LLM call`,
        `  policyResult = enforcePreCallPolicy(userPrompt, payload)`,
        `  IF policyResult.blocked:`,
        `    LOG_WARN("extraction_policy_blocked", { traceId, reason: policyResult.reason })`,
        `    THROW PolicyViolationError(policyResult.reason)`,
        ``,
        `  // 3. Call LLM with structured output`,
        `  TRY:`,
        `    llmResponse = callLLM({`,
        `      model:         CONFIG.extractionModel,`,
        `      systemPrompt:  systemPrompt,`,
        `      userPrompt:    userPrompt,`,
        `      responseFormat: "json",`,
        `      temperature:   0.0,   // deterministic for reproducibility`,
        `      maxTokens:     4096,`,
        `    })`,
        `  CATCH error:`,
        `    LOG_ERROR("llm_call_failed", { traceId, error: error.message })`,
        `    appendToAuditMemory("extraction_failed", { traceId, error: error.message })`,
        `    THROW ExtractionError("LLM call failed: " + error.message)`,
        ``,
        `  // 4. Parse and validate response`,
        `  parsed = parseJSON(llmResponse.content)`,
        `  schemaValidation = validateAgainstSchema(parsed, schema)`,
        ``,
        `  IF NOT schemaValidation.isValid:`,
        `    LOG_WARN("extraction_schema_mismatch", { traceId, errors: schemaValidation.errors })`,
        `    // Attempt one retry with error context`,
        `    retryPrompt = buildRetryPrompt(userPrompt, schemaValidation.errors)`,
        `    llmRetry    = callLLM({ ...CONFIG, userPrompt: retryPrompt })`,
        `    parsed      = parseJSON(llmRetry.content)`,
        `    schemaValidation = validateAgainstSchema(parsed, schema)`,
        `    IF NOT schemaValidation.isValid:`,
        `      THROW SchemaValidationError(schemaValidation.errors)`,
        ``,
        `  // 5. Compute per-field confidence scores`,
        `  fieldConfidences = computeFieldConfidences(parsed, payload.rawText)`,
        `  overallConfidence = mean(values(fieldConfidences))`,
        ``,
        `  result = ExtractionResult {`,
        `    data:             parsed,`,
        `    schema:           schema.title,`,
        `    fieldConfidences: fieldConfidences,`,
        `    overallConfidence: overallConfidence,`,
        `    tokensUsed:       llmResponse.usage.totalTokens,`,
        `    traceId:          traceId,`,
        `    extractedAt:      NOW(),`,
        `  }`,
        ``,
        `  appendToAuditMemory("extraction_complete", {`,
        `    traceId, confidence: overallConfidence, fieldsExtracted: keys(parsed).length`,
        `  })`,
        `  LOG("extraction_complete", { traceId, confidence: overallConfidence })`,
        `  RETURN result`,
      ].join('\n');
    },
    buildDataStructures(_items) {
      return [
        'ExtractionResult { data: Record<string, unknown>; schema: string; fieldConfidences: Record<string, number>; overallConfidence: number; tokensUsed: number; traceId: string; extractedAt: ISO8601 }',
        'LLMCallConfig { model: string; systemPrompt: string; userPrompt: string; responseFormat: "json" | "text"; temperature: number; maxTokens: number }',
        'FieldConfidence { fieldName: string; score: number; source: "exact_match" | "inferred" | "default" }',
      ];
    },
    buildTddAnchors(_items) {
      return [
        'TEST: Valid invoice text produces structured output matching target schema',
        'TEST: LLM response with schema mismatch triggers one retry then succeeds',
        'TEST: LLM response failing both attempts throws SchemaValidationError',
        'TEST: Policy violation before LLM call throws PolicyViolationError',
        'TEST: Per-field confidence scores are between 0.0 and 1.0',
        'TEST: Extraction uses temperature=0.0 for deterministic output',
        'TEST: Token usage is recorded in result and audit memory',
        'TEST: Audit memory receives extraction_complete with confidence score',
      ];
    },
  },

  // --- Policy Enforcement ---
  {
    id: 'policy',
    name: 'Policy Enforcement Service',
    keywords: [['policy', 'pii', 'injection', 'guard', 'compliance', 'redact', 'moderation', 'training reuse']],
    buildMarkdown(items, scenarioText) {
      const hasPii = scenarioText.toLowerCase().includes('pii');
      const hasInjection = scenarioText.toLowerCase().includes('injection');
      const hasTraining = scenarioText.toLowerCase().includes('training');
      return [
        `FUNCTION enforcePolicy(input: PolicyInput): PolicyResult`,
        `  // Multi-layer policy enforcement: PII, injection, training-reuse, compliance`,
        `  // Traces: ${items.map((i) => i.id).join(', ')}`,
        ``,
        `  INPUT:  input  -- content to evaluate (prompt text, extracted data, or response)`,
        `  OUTPUT: PolicyResult -- pass/fail with violation details and remediation`,
        ``,
        `  violations = []`,
        `  traceId = input.traceId`,
        `  LOG("policy_check_start", { traceId, checkTypes: input.checkTypes })`,
        ``,
        ...(hasPii ? [
          `  // Layer 1: PII Detection & Redaction`,
          `  IF "pii" IN input.checkTypes:`,
          `    piiScan = scanForPII(input.content)`,
          `    IF piiScan.detected:`,
          `      FOR EACH match IN piiScan.matches:`,
          `        violations.push(PolicyViolation {`,
          `          type:     "PII_DETECTED",`,
          `          severity: "HIGH",`,
          `          field:    match.field,`,
          `          pattern:  match.pattern,  // e.g. "SSN", "email", "phone"`,
          `          location: match.offset,`,
          `        })`,
          `      IF input.autoRedact:`,
          `        input.content = redactPII(input.content, piiScan.matches)`,
          `        LOG("pii_redacted", { traceId, count: piiScan.matches.length })`,
          ``,
        ] : []),
        ...(hasInjection ? [
          `  // Layer 2: Prompt Injection Detection`,
          `  IF "injection" IN input.checkTypes:`,
          `    injectionScan = detectPromptInjection(input.content)`,
          `    IF injectionScan.score > CONFIG.injectionThreshold:`,
          `      violations.push(PolicyViolation {`,
          `        type:     "PROMPT_INJECTION",`,
          `        severity: "CRITICAL",`,
          `        score:    injectionScan.score,`,
          `        pattern:  injectionScan.matchedPattern,`,
          `      })`,
          `      LOG_WARN("injection_detected", { traceId, score: injectionScan.score })`,
          `      // Hard block -- do not continue processing`,
          `      appendToAuditMemory("policy_injection_blocked", { traceId, score: injectionScan.score })`,
          `      RETURN PolicyResult { passed: false, violations, action: "BLOCK" }`,
          ``,
        ] : []),
        ...(hasTraining ? [
          `  // Layer 3: Training Data Reuse Guard`,
          `  IF "training_reuse" IN input.checkTypes:`,
          `    reuseCheck = checkTrainingDataReuse(input.content, input.modelId)`,
          `    IF reuseCheck.violates:`,
          `      violations.push(PolicyViolation {`,
          `        type:     "TRAINING_REUSE",`,
          `        severity: "HIGH",`,
          `        detail:   reuseCheck.detail,`,
          `      })`,
          ``,
        ] : []),
        `  // Layer ${[hasPii, hasInjection, hasTraining].filter(Boolean).length + 1}: Compliance Rules`,
        `  FOR EACH rule IN loadComplianceRules(input.context):`,
        `    result = evaluateRule(rule, input)`,
        `    IF NOT result.passed:`,
        `      violations.push(PolicyViolation {`,
        `        type:     "COMPLIANCE_RULE",`,
        `        severity: rule.severity,`,
        `        ruleId:   rule.id,`,
        `        detail:   result.reason,`,
        `      })`,
        ``,
        `  passed = violations.length == 0`,
        `  action = passed ? "ALLOW" : (violations.any(v => v.severity == "CRITICAL") ? "BLOCK" : "WARN")`,
        ``,
        `  appendToAuditMemory("policy_evaluated", {`,
        `    traceId, passed, violationCount: violations.length, action`,
        `  })`,
        `  LOG("policy_check_complete", { traceId, passed, action })`,
        `  RETURN PolicyResult { passed, violations, action }`,
      ].join('\n');
    },
    buildDataStructures(_items) {
      return [
        'PolicyInput { content: string; traceId: string; checkTypes: ("pii" | "injection" | "training_reuse" | "compliance")[]; context: Record<string, unknown>; autoRedact: boolean; modelId?: string }',
        'PolicyResult { passed: boolean; violations: PolicyViolation[]; action: "ALLOW" | "WARN" | "BLOCK" }',
        'PolicyViolation { type: string; severity: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL"; field?: string; detail?: string; score?: number; ruleId?: string }',
      ];
    },
    buildTddAnchors(_items) {
      return [
        'TEST: Content with SSN pattern triggers PII_DETECTED violation',
        'TEST: Prompt injection above threshold returns BLOCK action immediately',
        'TEST: Training reuse violation is detected and reported',
        'TEST: Clean content passes all policy layers with ALLOW action',
        'TEST: Auto-redact mode replaces PII in content before returning',
        'TEST: Each policy evaluation creates an audit memory entry',
        'TEST: Multiple violations are collected, not short-circuited (except injection)',
      ];
    },
  },

  // --- Drift Detection ---
  {
    id: 'drift',
    name: 'Drift Detection & Confidence Scoring Service',
    keywords: [['drift', 'confidence', 'scoring', 'anomaly', 'degradation', 'baseline']],
    buildMarkdown(items, _scenarioText) {
      return [
        `FUNCTION detectDrift(current: ExtractionResult, baseline: BaselineStats): DriftReport`,
        `  // Compare current extraction against historical baseline for quality drift`,
        `  // Traces: ${items.map((i) => i.id).join(', ')}`,
        ``,
        `  INPUT:  current   -- latest extraction result with per-field confidences`,
        `          baseline  -- rolling statistical baseline (mean, stddev, percentiles)`,
        `  OUTPUT: DriftReport -- drift scores, alerts, and recommended actions`,
        ``,
        `  traceId = current.traceId`,
        `  LOG("drift_check_start", { traceId })`,
        ``,
        `  driftScores = {}`,
        `  alerts      = []`,
        ``,
        `  // 1. Per-field confidence drift`,
        `  FOR EACH field, confidence IN current.fieldConfidences:`,
        `    IF field IN baseline.fieldStats:`,
        `      stats    = baseline.fieldStats[field]`,
        `      zScore   = (confidence - stats.mean) / max(stats.stddev, 0.001)`,
        `      driftScores[field] = { zScore, current: confidence, baselineMean: stats.mean }`,
        ``,
        `      IF abs(zScore) > CONFIG.driftThreshold:`,
        `        alerts.push(DriftAlert {`,
        `          field:     field,`,
        `          severity:  abs(zScore) > CONFIG.criticalDriftThreshold ? "CRITICAL" : "WARNING",`,
        `          zScore:    zScore,`,
        `          message:   "{field} confidence {confidence} deviates {zScore}σ from baseline {stats.mean}",`,
        `        })`,
        ``,
        `  // 2. Overall extraction quality drift`,
        `  overallDrift = computeKLDivergence(`,
        `    distribution: values(current.fieldConfidences),`,
        `    baseline:     baseline.overallDistribution,`,
        `  )`,
        ``,
        `  IF overallDrift > CONFIG.overallDriftThreshold:`,
        `    alerts.push(DriftAlert {`,
        `      field:    "_overall",`,
        `      severity: "CRITICAL",`,
        `      zScore:   overallDrift,`,
        `      message:  "Overall extraction quality drift: KL divergence = {overallDrift}",`,
        `    })`,
        ``,
        `  // 3. Schema compliance drift (new/missing fields)`,
        `  expectedFields = keys(baseline.fieldStats)`,
        `  actualFields   = keys(current.fieldConfidences)`,
        `  missingFields  = difference(expectedFields, actualFields)`,
        `  newFields      = difference(actualFields, expectedFields)`,
        ``,
        `  IF missingFields.length > 0:`,
        `    alerts.push(DriftAlert { field: "_schema", severity: "WARNING",`,
        `      message: "Missing fields: {join(missingFields, ', ')}" })`,
        ``,
        `  report = DriftReport {`,
        `    traceId:        traceId,`,
        `    driftScores:    driftScores,`,
        `    overallDrift:   overallDrift,`,
        `    alerts:         alerts,`,
        `    hasCritical:    alerts.any(a => a.severity == "CRITICAL"),`,
        `    recommendation: alerts.length == 0 ? "PROCEED" :`,
        `                    alerts.any(a => a.severity == "CRITICAL") ? "HALT_AND_REVIEW" : "PROCEED_WITH_CAUTION",`,
        `    checkedAt:      NOW(),`,
        `  }`,
        ``,
        `  appendToAuditMemory("drift_report", { traceId, alertCount: alerts.length, recommendation: report.recommendation })`,
        `  LOG("drift_check_complete", { traceId, alertCount: alerts.length })`,
        `  RETURN report`,
      ].join('\n');
    },
    buildDataStructures(_items) {
      return [
        'DriftReport { traceId: string; driftScores: Record<string, DriftScore>; overallDrift: number; alerts: DriftAlert[]; hasCritical: boolean; recommendation: "PROCEED" | "PROCEED_WITH_CAUTION" | "HALT_AND_REVIEW"; checkedAt: ISO8601 }',
        'DriftScore { zScore: number; current: number; baselineMean: number }',
        'DriftAlert { field: string; severity: "WARNING" | "CRITICAL"; zScore: number; message: string }',
        'BaselineStats { fieldStats: Record<string, { mean: number; stddev: number; p50: number; p95: number }>; overallDistribution: number[]; sampleCount: number }',
      ];
    },
    buildTddAnchors(_items) {
      return [
        'TEST: Field confidence 3σ below baseline triggers WARNING alert',
        'TEST: KL divergence above threshold triggers CRITICAL overall drift alert',
        'TEST: Missing expected fields trigger schema drift WARNING',
        'TEST: No drift produces PROCEED recommendation with empty alerts',
        'TEST: Critical alert produces HALT_AND_REVIEW recommendation',
        'TEST: Drift report is appended to audit memory',
      ];
    },
  },

  // --- ERP Push ---
  {
    id: 'erp-push',
    name: 'ERP Push Service',
    keywords: [['erp', 'sap', 'odata', 'push', 's4hana', 's/4hana', 'post', 'hana']],
    buildMarkdown(items, scenarioText) {
      const nouns = extractDomainNouns(scenarioText);
      const erpSystem = nouns.systems.find((s) => s.includes('SAP')) ?? 'ERP';
      const entity = nouns.entities.find((e) => e.includes('Emission')) ?? nouns.entities[0] ?? 'Record';
      return [
        `FUNCTION pushToERP(data: ValidatedPayload, config: ERPConfig): ERPPushResult`,
        `  // Authenticated push to ${erpSystem} via OData v4 POST with rollback support`,
        `  // Traces: ${items.map((i) => i.id).join(', ')}`,
        ``,
        `  INPUT:  data    -- schema-validated, policy-cleared extraction result`,
        `          config  -- ${erpSystem} connection config (endpoint, auth, entity set)`,
        `  OUTPUT: ERPPushResult -- success/failure with ERP response and rollback info`,
        ``,
        `  traceId = data.traceId`,
        `  LOG("erp_push_start", { traceId, erpSystem: "${erpSystem}", entitySet: config.entitySet })`,
        ``,
        `  // 1. Authenticate with IAM-scoped service account`,
        `  TRY:`,
        `    authToken = authenticateServiceAccount(config.serviceAccount, config.scope)`,
        `  CATCH authError:`,
        `    LOG_ERROR("erp_auth_failed", { traceId, error: authError.message })`,
        `    appendToAuditMemory("erp_auth_failed", { traceId, error: authError.message })`,
        `    THROW ERPAuthenticationError(authError.message)`,
        ``,
        `  // 2. Transform to ${erpSystem} OData payload format`,
        `  odataPayload = transform${entity}ToOData(data, config.entitySet)`,
        `  odataPayload["@odata.type"]   = config.odataType`,
        `  odataPayload["sap-cancel-on-close"] = true   // enable transactional safety`,
        ``,
        `  // 3. Create rollback snapshot`,
        `  rollbackId = createRollbackSnapshot(traceId, odataPayload)`,
        ``,
        `  // 4. POST to OData endpoint`,
        `  TRY:`,
        `    response = httpPost(`,
        `      url:     config.baseUrl + "/" + config.entitySet,`,
        `      headers: {`,
        `        "Authorization":  "Bearer " + authToken,`,
        `        "Content-Type":   "application/json",`,
        `        "Accept":         "application/json",`,
        `        "X-CSRF-Token":   fetchCSRFToken(config.baseUrl, authToken),`,
        `        "X-Correlation-ID": traceId,`,
        `      },`,
        `      body:    serialize(odataPayload),`,
        `      timeout: CONFIG.erpTimeoutMs,`,
        `    )`,
        `  CATCH networkError:`,
        `    LOG_ERROR("erp_push_network_error", { traceId, error: networkError.message })`,
        `    executeRollback(rollbackId)`,
        `    appendToAuditMemory("erp_push_failed", { traceId, error: networkError.message, rolledBack: true })`,
        `    THROW ERPNetworkError(networkError.message)`,
        ``,
        `  // 5. Handle response`,
        `  IF response.status == 201 OR response.status == 200:`,
        `    erpRecord = parseJSON(response.body)`,
        `    LOG("erp_push_accepted", { traceId, erpId: erpRecord.id, status: "ERP_ACCEPTED" })`,
        `    appendToAuditMemory("erp_push_accepted", {`,
        `      traceId, erpId: erpRecord.id, entitySet: config.entitySet, timestamp: NOW()`,
        `    })`,
        `    RETURN ERPPushResult {`,
        `      status:     "ERP_ACCEPTED",`,
        `      erpId:      erpRecord.id,`,
        `      entitySet:  config.entitySet,`,
        `      traceId:    traceId,`,
        `      rollbackId: rollbackId,`,
        `      pushedAt:   NOW(),`,
        `    }`,
        ``,
        `  ELSE IF response.status >= 400:`,
        `    errorDetail = parseODataError(response.body)`,
        `    LOG_ERROR("erp_push_rejected", { traceId, status: response.status, error: errorDetail })`,
        `    executeRollback(rollbackId)`,
        `    appendToAuditMemory("erp_push_rejected", { traceId, status: response.status, error: errorDetail, rolledBack: true })`,
        `    THROW ERPRejectionError(response.status, errorDetail)`,
      ].join('\n');
    },
    buildDataStructures(items) {
      const nouns = extractDomainNouns(items.map((i) => i.content).join(' '));
      void nouns.entities.find((e) => e.includes('Emission'));
      return [
        `ERPConfig { baseUrl: string; entitySet: string; odataType: string; serviceAccount: string; scope: string; timeout: number }`,
        `ERPPushResult { status: "ERP_ACCEPTED" | "ERP_REJECTED"; erpId: string; entitySet: string; traceId: string; rollbackId: string; pushedAt: ISO8601 }`,
        `ODataPayload { "@odata.type": string; "sap-cancel-on-close": boolean; [key: string]: unknown }`,
        `RollbackSnapshot { id: string; traceId: string; payload: ODataPayload; createdAt: ISO8601 }`,
      ];
    },
    buildTddAnchors(_items) {
      return [
        'TEST: Successful POST returns ERP_ACCEPTED with erpId',
        'TEST: Authentication failure throws ERPAuthenticationError before POST',
        'TEST: Network timeout triggers rollback and throws ERPNetworkError',
        'TEST: 400+ response triggers rollback and throws ERPRejectionError',
        'TEST: CSRF token is fetched and included in POST headers',
        'TEST: X-Correlation-ID header matches traceId',
        'TEST: Audit memory records both success and failure outcomes',
        'TEST: Rollback snapshot is created before POST attempt',
      ];
    },
  },

  // --- Error Handling / Rollback ---
  {
    id: 'error-handling',
    name: 'Error Handling & Rollback Service',
    keywords: [['error', 'rollback', 'retry', 'recovery', 'fallback', 'circuit']],
    buildMarkdown(items, _scenarioText) {
      return [
        `FUNCTION handlePipelineError(error: PipelineError, context: PipelineContext): ErrorResolution`,
        `  // Centralized error handling with rollback, retry, and audit logging`,
        `  // Traces: ${items.map((i) => i.id).join(', ')}`,
        ``,
        `  INPUT:  error    -- the error that occurred in any pipeline stage`,
        `          context  -- current pipeline state including rollback snapshots`,
        `  OUTPUT: ErrorResolution -- action taken (retried, rolled back, escalated)`,
        ``,
        `  traceId = context.traceId`,
        `  LOG_ERROR("pipeline_error", { traceId, stage: error.stage, type: error.type, message: error.message })`,
        ``,
        `  // 1. Classify error severity and retryability`,
        `  classification = classifyError(error)`,
        ``,
        `  // 2. Attempt retry for transient errors`,
        `  IF classification.retryable AND context.retryCount < CONFIG.maxRetries:`,
        `    context.retryCount += 1`,
        `    delay = computeBackoff(context.retryCount)  // exponential with jitter`,
        `    WAIT(delay)`,
        `    LOG("pipeline_retry", { traceId, attempt: context.retryCount, delay })`,
        `    RETURN ErrorResolution { action: "RETRY", retryCount: context.retryCount }`,
        ``,
        `  // 3. Execute rollback for stateful operations`,
        `  IF context.rollbackSnapshots.length > 0:`,
        `    FOR EACH snapshot IN reverse(context.rollbackSnapshots):`,
        `      TRY:`,
        `        executeRollback(snapshot)`,
        `        LOG("rollback_executed", { traceId, snapshotId: snapshot.id })`,
        `      CATCH rollbackError:`,
        `        LOG_ERROR("rollback_failed", { traceId, snapshotId: snapshot.id, error: rollbackError.message })`,
        ``,
        `  // 4. Record in audit memory`,
        `  appendToAuditMemory("pipeline_error_handled", {`,
        `    traceId, stage: error.stage, type: error.type,`,
        `    action: classification.retryable ? "RETRIES_EXHAUSTED" : "ROLLED_BACK",`,
        `    rollbackCount: context.rollbackSnapshots.length,`,
        `  })`,
        ``,
        `  RETURN ErrorResolution {`,
        `    action:     "ESCALATE",`,
        `    error:      error,`,
        `    rollbacks:  context.rollbackSnapshots.length,`,
        `    traceId:    traceId,`,
        `    resolvedAt: NOW(),`,
        `  }`,
      ].join('\n');
    },
    buildDataStructures(_items) {
      return [
        'PipelineError { stage: string; type: string; message: string; stack?: string; retryable: boolean }',
        'PipelineContext { traceId: string; retryCount: number; rollbackSnapshots: RollbackSnapshot[]; startedAt: ISO8601 }',
        'ErrorResolution { action: "RETRY" | "ESCALATE" | "ROLLED_BACK"; error?: PipelineError; retryCount?: number; rollbacks?: number; traceId: string; resolvedAt: ISO8601 }',
      ];
    },
    buildTddAnchors(_items) {
      return [
        'TEST: Transient error triggers retry with exponential backoff',
        'TEST: Max retries exhausted escalates error',
        'TEST: Rollback executes snapshots in reverse order',
        'TEST: Failed rollback logs error but continues with remaining snapshots',
        'TEST: All error resolutions are recorded in audit memory',
      ];
    },
  },

  // --- Audit / Decision Memory ---
  {
    id: 'audit-memory',
    name: 'Append-Only Decision Memory Service',
    keywords: [['audit', 'memory', 'append', 'decision', 'ruvector', 'trail', 'log', 'ledger']],
    buildMarkdown(items, scenarioText) {
      const nouns = extractDomainNouns(scenarioText);
      const memorySystem = nouns.systems.find((s) => s.toLowerCase().includes('ruvector')) ?? 'AuditMemory';
      return [
        `FUNCTION appendToAuditMemory(eventType: string, payload: AuditPayload): AuditReceipt`,
        `  // Append-only decision memory in ${memorySystem} -- immutable audit trail`,
        `  // Traces: ${items.map((i) => i.id).join(', ')}`,
        ``,
        `  INPUT:  eventType  -- classification of the decision/event`,
        `          payload    -- structured event data with traceId`,
        `  OUTPUT: AuditReceipt -- confirmation with sequence number and hash`,
        ``,
        `  record = AuditRecord {`,
        `    id:         generateUUID(),`,
        `    eventType:  eventType,`,
        `    traceId:    payload.traceId,`,
        `    payload:    payload,`,
        `    timestamp:  NOW(),`,
        `    sequence:   getNextSequence(),`,
        `    prevHash:   getLastRecordHash(),`,
        `  }`,
        ``,
        `  // Compute integrity hash (append-only chain)`,
        `  record.hash = sha256(record.prevHash + serialize(record))`,
        ``,
        `  // Write to ${memorySystem} (append-only, no updates or deletes)`,
        `  TRY:`,
        `    writeResult = ${camelCase(memorySystem)}.append(record)`,
        `  CATCH writeError:`,
        `    LOG_ERROR("audit_write_failed", { traceId: payload.traceId, error: writeError.message })`,
        `    // Audit failures must not block pipeline -- buffer and retry async`,
        `    bufferForRetry(record)`,
        `    RETURN AuditReceipt { success: false, buffered: true }`,
        ``,
        `  RETURN AuditReceipt {`,
        `    success:    true,`,
        `    recordId:   record.id,`,
        `    sequence:   record.sequence,`,
        `    hash:       record.hash,`,
        `    writtenAt:  NOW(),`,
        `  }`,
        ``,
        ``,
        `FUNCTION queryAuditTrail(traceId: string): AuditRecord[]`,
        `  // Retrieve full audit trail for a given trace`,
        `  records = ${camelCase(memorySystem)}.query({ traceId: traceId }, orderBy: "sequence ASC")`,
        ``,
        `  // Verify chain integrity`,
        `  FOR i = 1 TO records.length - 1:`,
        `    expected = sha256(records[i-1].hash + serialize(records[i]))`,
        `    IF records[i].hash != expected:`,
        `      LOG_ERROR("audit_integrity_violation", { traceId, recordId: records[i].id })`,
        `      THROW IntegrityError("Audit chain broken at sequence " + records[i].sequence)`,
        ``,
        `  RETURN records`,
      ].join('\n');
    },
    buildDataStructures(_items) {
      return [
        'AuditRecord { id: string; eventType: string; traceId: string; payload: Record<string, unknown>; timestamp: ISO8601; sequence: number; prevHash: string; hash: string }',
        'AuditReceipt { success: boolean; recordId?: string; sequence?: number; hash?: string; buffered?: boolean; writtenAt?: ISO8601 }',
        'AuditPayload { traceId: string; [key: string]: unknown }',
      ];
    },
    buildTddAnchors(_items) {
      return [
        'TEST: Append creates record with sequential sequence number',
        'TEST: Hash chain links each record to previous via sha256',
        'TEST: Query returns records in sequence order with verified integrity',
        'TEST: Tampered record in chain throws IntegrityError',
        'TEST: Write failure buffers record for async retry, does not throw',
        'TEST: Append-only: no update or delete operations exist on the interface',
      ];
    },
  },

  // --- Schema Validation / JSON Emission ---
  {
    id: 'schema-validation',
    name: 'Schema Validation & JSON Emission Service',
    keywords: [['schema', 'validation', 'json', 'structured', 'emission', 'format', 'normalize']],
    buildMarkdown(items, scenarioText) {
      const nouns = extractDomainNouns(scenarioText);
      const targetSchema = nouns.entities.includes('Scope3Emission') ? 'SAPEmissionsReportingSchema' :
        nouns.entities.includes('EmissionsRecord') ? 'EmissionsRecordSchema' : 'TargetSchema';
      return [
        `FUNCTION validateAndEmit(data: ExtractionResult, targetSchema: JSONSchema): ValidatedEmission`,
        `  // Validate extracted data against ${targetSchema} and emit structured JSON`,
        `  // Traces: ${items.map((i) => i.id).join(', ')}`,
        ``,
        `  INPUT:  data          -- LLM extraction result with per-field confidences`,
        `          targetSchema  -- JSON Schema defining the expected output format`,
        `  OUTPUT: ValidatedEmission -- conformant JSON payload ready for ERP push`,
        ``,
        `  traceId = data.traceId`,
        ``,
        `  // 1. Deep schema validation`,
        `  validation = validateDeep(data.data, targetSchema)`,
        `  IF NOT validation.isValid:`,
        `    LOG_WARN("schema_validation_failed", { traceId, errorCount: validation.errors.length })`,
        `    THROW SchemaValidationError(validation.errors)`,
        ``,
        `  // 2. Normalize field values to schema types`,
        `  normalized = normalizeToSchemaTypes(data.data, targetSchema)`,
        ``,
        `  // 3. Enrich with computed fields`,
        `  normalized.processingMetadata = {`,
        `    extractedAt:      data.extractedAt,`,
        `    confidence:        data.overallConfidence,`,
        `    schemaVersion:     targetSchema.version,`,
        `    traceId:           traceId,`,
        `  }`,
        ``,
        `  // 4. Emit as deterministic JSON (sorted keys for reproducibility)`,
        `  emission = ValidatedEmission {`,
        `    payload:     serializeDeterministic(normalized),`,
        `    schema:      targetSchema.title,`,
        `    confidence:  data.overallConfidence,`,
        `    traceId:     traceId,`,
        `    emittedAt:   NOW(),`,
        `  }`,
        ``,
        `  appendToAuditMemory("emission_validated", { traceId, schema: targetSchema.title })`,
        `  RETURN emission`,
      ].join('\n');
    },
    buildDataStructures(_items) {
      return [
        'ValidatedEmission { payload: string; schema: string; confidence: number; traceId: string; emittedAt: ISO8601 }',
        'SchemaValidationError { errors: Array<{ path: string; message: string; expected: string; actual: string }> }',
      ];
    },
    buildTddAnchors(_items) {
      return [
        'TEST: Valid data matching schema produces ValidatedEmission',
        'TEST: Data violating schema throws SchemaValidationError with field paths',
        'TEST: Output JSON has deterministic key ordering',
        'TEST: Processing metadata includes traceId and confidence',
        'TEST: Audit memory records emission_validated event',
      ];
    },
  },
];

function buildPseudocode(dossier: ResearchDossier, scenarioText: string): Phase2Pseudocode {
  // Collect all requirement/recommendation items
  const reqItems = dossier.items.filter(
    (item) => item.category === 'requirement' || item.category === 'recommendation',
  );

  const allText = reqItems.map((i) => `${i.title} ${i.content}`).join(' ').toLowerCase()
    + ' ' + scenarioText.toLowerCase();

  // Match capabilities to dossier items
  const matchedCapabilities: Array<{
    pattern: CapabilityPattern;
    items: typeof reqItems;
  }> = [];
  const assignedItemIds = new Set<string>();

  for (const pattern of CAPABILITY_PATTERNS) {
    // Check if any keyword group matches
    const matches = pattern.keywords.some((kwGroup) =>
      kwGroup.some((kw) => allText.includes(kw.toLowerCase())),
    );
    if (!matches) continue;

    // Find items most relevant to this capability
    const relevantItems = reqItems.filter((item) => {
      const itemText = `${item.title} ${item.content}`.toLowerCase();
      return pattern.keywords.some((kwGroup) =>
        kwGroup.some((kw) => itemText.includes(kw.toLowerCase())),
      );
    });

    // Use all remaining items if no specific matches
    const itemsForPattern = relevantItems.length > 0
      ? relevantItems
      : reqItems.filter((item) => !assignedItemIds.has(item.id));

    if (itemsForPattern.length > 0) {
      matchedCapabilities.push({ pattern, items: itemsForPattern });
      for (const item of itemsForPattern) {
        assignedItemIds.add(item.id);
      }
    }
  }

  // Catch-all: any unmatched requirement items get a generic module
  const unmatchedItems = reqItems.filter((item) => !assignedItemIds.has(item.id));
  if (unmatchedItems.length > 0) {
    matchedCapabilities.push({
      pattern: {
        id: 'generic',
        name: 'Core Processing Service',
        keywords: [],
        buildMarkdown(items, _scenarioText) {
          return [
            `FUNCTION processRequirements(input: ProcessInput): ProcessResult`,
            `  // Core processing for ${items.length} remaining requirements`,
            `  // Traces: ${items.map((i) => i.id).join(', ')}`,
            ``,
            ...items.flatMap((item, i) => [
              `  // Step ${i + 1}: ${item.title}`,
              `  result_${i + 1} = execute("${slugify(item.title)}", input)`,
              `  ASSERT result_${i + 1}.isValid, "${item.title} failed validation"`,
              ``,
            ]),
            `  RETURN ProcessResult {`,
            `    results: [${items.map((_, i) => `result_${i + 1}`).join(', ')}],`,
            `    traceId: input.traceId,`,
            `    completedAt: NOW(),`,
            `  }`,
          ].join('\n');
        },
        buildDataStructures(_items) {
          return [
            'ProcessInput { traceId: string; data: Record<string, unknown>; context: Record<string, unknown> }',
            'ProcessResult { results: unknown[]; traceId: string; completedAt: ISO8601 }',
          ];
        },
        buildTddAnchors(items) {
          return items.map((item) =>
            `TEST: "${item.title}" processes valid input and returns valid result`,
          );
        },
      },
      items: unmatchedItems,
    });
  }

  // Build modules
  const modules: Phase2PseudocodeModule[] = matchedCapabilities.map((cap, idx) => {
    const markdown = cap.pattern.buildMarkdown(cap.items, scenarioText);
    const dataStructures = cap.pattern.buildDataStructures(cap.items);
    const tddAnchors = cap.pattern.buildTddAnchors(cap.items);

    // Also keep algorithms as a summary list for backward compatibility
    const algorithms = markdown.split('\n')
      .filter((line) => line.trim().startsWith('FUNCTION') || line.trim().startsWith('//') || line.trim().startsWith('IF') || line.trim().startsWith('FOR') || line.trim().startsWith('TRY') || line.trim().startsWith('RETURN'))
      .slice(0, 15);

    return {
      id: `PC-MOD-${pad3(idx + 1)}`,
      name: cap.pattern.name,
      algorithms,
      markdown,
      tddAnchors,
      dataStructures,
      dossierItemRefs: cap.items.map((it) => it.id),
    };
  });

  return { modules };
}

// ============================================================================
// Architecture Builder
// ============================================================================

function buildArchitecture(
  dossier: ResearchDossier,
  artifacts: Phase1Artifacts,
): Phase2Architecture {
  const querySlice = artifacts.scenario.query ?? '';
  const services: Phase2ServiceDefinition[] = [];

  // A map from service name -> service definition, used for deduplication
  // when risk services overlap with roadmap services.
  const serviceByName = new Map<string, Phase2ServiceDefinition>();

  let svcIdx = 0;

  function nextSvcId(): string {
    svcIdx++;
    return `SVC-${pad3(svcIdx)}`;
  }

  // --------------------------------------------------------------------------
  // 1. Gateway service: always include if any dossier item has category 'requirement'
  // --------------------------------------------------------------------------
  const hasRequirements = dossier.items.some((item) => item.category === 'requirement');
  if (hasRequirements) {
    const gateway: Phase2ServiceDefinition = {
      id: nextSvcId(),
      name: 'api-gateway',
      responsibility: `Request routing, authentication, rate limiting for ${querySlice}`,
      api: ['POST /api/v1/*', 'GET /api/v1/*', 'GET /health'],
      dependencies: [],
      dossierItemRefs: computeDossierRefs('api-gateway', 'request routing authentication rate limiting', dossier),
    };
    services.push(gateway);
    serviceByName.set(gateway.name, gateway);
  }

  // --------------------------------------------------------------------------
  // 2. Capability-derived services: one per system capability from dossier
  //    (replaces roadmap-phase services which mapped project management phases
  //     like "Discovery" / "Prototype" instead of real system capabilities)
  // --------------------------------------------------------------------------
  const CAPABILITY_SERVICE_MAP: Array<{
    keywords: string[];
    name: string;
    responsibility: string;
    api: string[];
  }> = [
    {
      keywords: ['ingest', 'upload', 'pdf', 'ocr', 'document', 'invoice', 'parse', 'scan'],
      name: 'document-ingestion-service',
      responsibility: 'Accept documents (PDF, image, structured), parse via OCR/text extraction, validate format, and emit raw payloads for downstream processing',
      api: [
        'POST /api/v1/documents/ingest',
        'POST /api/v1/documents/batch-ingest',
        'GET /api/v1/documents/:id/status',
        'ingestDocument(source: DocumentSource): IngestionResult',
        'validateFormat(payload: RawPayload): FormatValidation',
      ],
    },
    {
      keywords: ['extract', 'llm', 'nlp', 'ai', 'gpt', 'claude', 'prompt', 'emission', 'scope 3', 'scope3', 'carbon', 'ghg'],
      name: 'llm-extraction-service',
      responsibility: 'Build domain-specific prompts, invoke LLM for structured data extraction, parse and validate responses against target schema, compute per-field confidence scores',
      api: [
        'POST /api/v1/extraction/run',
        'POST /api/v1/extraction/batch',
        'GET /api/v1/extraction/:id/result',
        'extractFields(document: ParsedDocument, schema: TargetSchema): ExtractionResult',
        'scoreConfidence(result: ExtractionResult): ConfidenceReport',
      ],
    },
    {
      keywords: ['pii', 'injection', 'policy', 'guard', 'compliance', 'gdpr', 'hipaa', 'redact', 'filter', 'safety'],
      name: 'policy-enforcement-service',
      responsibility: 'Enforce data governance policies — PII redaction, prompt injection detection, compliance rule evaluation, content safety filtering',
      api: [
        'POST /api/v1/policy/evaluate',
        'POST /api/v1/policy/redact',
        'evaluatePolicy(content: string, rules: PolicyRule[]): PolicyResult',
        'detectPII(text: string): PIIDetection[]',
        'scanInjection(prompt: string): InjectionScanResult',
      ],
    },
    {
      keywords: ['drift', 'monitor', 'confidence', 'degrad', 'alert', 'threshold', 'slo', 'observ'],
      name: 'drift-detection-service',
      responsibility: 'Monitor model confidence distributions over time, detect statistical drift via KL-divergence or PSI, emit alerts when thresholds are breached',
      api: [
        'POST /api/v1/drift/check',
        'GET /api/v1/drift/report',
        'GET /api/v1/drift/alerts',
        'compareDistributions(baseline: Distribution, current: Distribution): DriftScore',
        'emitAlert(alert: DriftAlert): void',
      ],
    },
    {
      keywords: ['sap', 'erp', 'odata', 'push', 's4hana', 's/4hana', 'bapi', 'idoc', 'rfc'],
      name: 'erp-push-service',
      responsibility: 'Authenticate to SAP S/4HANA (or target ERP), build OData v4 payloads, execute POST with CSRF protection, handle rollback on failure',
      api: [
        'POST /api/v1/erp/push',
        'POST /api/v1/erp/batch-push',
        'GET /api/v1/erp/status/:correlationId',
        'authenticateERP(config: ERPConfig): AuthToken',
        'buildODataPayload(data: ValidatedEmission): ODataPayload',
        'pushToERP(payload: ODataPayload, token: AuthToken): ERPResponse',
        'rollbackTransaction(correlationId: string): RollbackResult',
      ],
    },
    {
      keywords: ['schema', 'valid', 'json', 'normalize', 'transform', 'map'],
      name: 'schema-validation-service',
      responsibility: 'Validate extracted data against target JSON schemas, normalize field types, enrich with processing metadata, emit deterministic JSON',
      api: [
        'POST /api/v1/schema/validate',
        'validateAndEmit(data: ExtractionResult, schema: JSONSchema): ValidatedEmission',
        'normalizeFields(data: Record<string, unknown>, schema: JSONSchema): NormalizedData',
      ],
    },
    {
      keywords: ['audit', 'memory', 'decision', 'ruvector', 'trail', 'ledger', 'append', 'immutable'],
      name: 'audit-memory-service',
      responsibility: 'Append-only decision memory with hash-chain integrity — records all pipeline decisions, extractions, and ERP interactions for full auditability',
      api: [
        'POST /api/v1/audit/append',
        'GET /api/v1/audit/trail/:traceId',
        'GET /api/v1/audit/verify/:traceId',
        'appendToAuditMemory(event: string, payload: AuditPayload): AuditReceipt',
        'queryAuditTrail(traceId: string): AuditRecord[]',
        'verifyChainIntegrity(traceId: string): IntegrityReport',
      ],
    },
  ];

  // Scan combined text from dossier + scenario to match capabilities
  const allReqText = dossier.items
    .filter((item) => item.category === 'requirement' || item.category === 'recommendation')
    .map((item) => `${item.title} ${item.content}`)
    .join(' ')
    .toLowerCase();
  const capabilityText = `${allReqText} ${querySlice.toLowerCase()}`;

  // Track the previous capability service to wire sequential dependencies
  let prevCapabilityService: string | null = null;

  for (const cap of CAPABILITY_SERVICE_MAP) {
    const matches = cap.keywords.some((kw) => capabilityText.includes(kw));
    if (!matches) continue;
    if (serviceByName.has(cap.name)) continue;

    const deps: string[] = [];
    if (prevCapabilityService) {
      deps.push(prevCapabilityService);
    }

    const svc: Phase2ServiceDefinition = {
      id: nextSvcId(),
      name: cap.name,
      responsibility: cap.responsibility,
      api: cap.api,
      dependencies: deps,
      dossierItemRefs: computeDossierRefs(cap.name, cap.responsibility, dossier),
    };
    services.push(svc);
    serviceByName.set(svc.name, svc);
    prevCapabilityService = cap.name;
  }

  // --------------------------------------------------------------------------
  // 3. Integration-adapter services: one per external system
  // --------------------------------------------------------------------------
  const externalSystems = new Set<string>();

  // Scan scenario for technology_context fields
  const scenarioAny = artifacts.scenario as Record<string, unknown>;
  const techContext = scenarioAny.technology_context as Record<string, unknown> | undefined;
  if (techContext && typeof techContext === 'object') {
    for (const [key, value] of Object.entries(techContext)) {
      if (typeof value === 'string' && value.length > 0) {
        // Key names like erp_system, cloud_platform, data_warehouse become system names
        externalSystems.add(slugify(value));
      } else if (typeof value === 'string' || typeof value === 'undefined') {
        // Use the key itself if value is not useful
        if (key.length > 0) {
          externalSystems.add(slugify(key));
        }
      }
    }
  }

  // Scan dossier items and scenario text for integration keywords
  const allDossierText = dossier.items.map((item) => `${item.title} ${item.content}`).join(' ');
  const scenarioText = `${artifacts.scenario.query ?? ''} ${JSON.stringify(artifacts.scenario)}`;
  const combinedText = `${allDossierText} ${scenarioText}`.toLowerCase();

  for (const { keyword, system } of INTEGRATION_KEYWORDS) {
    if (combinedText.includes(keyword.toLowerCase())) {
      externalSystems.add(system);
    }
  }

  // Remove 'api-gateway-ext' if we already have an api-gateway service (to avoid confusion)
  if (serviceByName.has('api-gateway')) {
    externalSystems.delete('api-gateway-ext');
  }

  // Find the first data-related roadmap service to use as dependency
  const dataRelatedService = services.find((svc) =>
    svc.name !== 'api-gateway' &&
    contentMatchesKeywords(svc.responsibility, ['data', 'storage', 'persist', 'database', 'pipeline']),
  );

  const sortedSystems = Array.from(externalSystems).sort();
  for (const system of sortedSystems) {
    const adapterName = `${system}-adapter`;
    // Skip if a service with this name already exists
    if (serviceByName.has(adapterName)) continue;

    const deps: string[] = [];
    if (dataRelatedService) {
      deps.push(dataRelatedService.name);
    }

    const svc: Phase2ServiceDefinition = {
      id: nextSvcId(),
      name: adapterName,
      responsibility: `External system integration adapter for ${system}`,
      api: [
        `connect${camelCase(system)}()`,
        `ingest${camelCase(system)}Data(payload: ${camelCase(system)}Payload)`,
        `transform${camelCase(system)}Payload(raw: RawData): TransformedPayload`,
        `sync${camelCase(system)}State(direction: 'push' | 'pull')`,
        `validate${camelCase(system)}Connection(): HealthStatus`,
        `get${camelCase(system)}Schema(): SchemaDefinition`,
      ],
      dependencies: deps,
      dossierItemRefs: computeDossierRefs(adapterName, `integration adapter ${system}`, dossier),
    };
    services.push(svc);
    serviceByName.set(svc.name, svc);
  }

  // --------------------------------------------------------------------------
  // 4. Risk-driven cross-cutting services: one per distinct risk category
  // --------------------------------------------------------------------------
  const riskCategories = new Map<string, { items: typeof dossier.items; mitigations: string[] }>();

  for (const item of dossier.items) {
    if (
      item.category === 'risk' &&
      (item.severity === 'high' || item.severity === 'medium')
    ) {
      // Derive category from the item: use the phase field if present, otherwise
      // extract domain-significant nouns from the title (max 3 words)
      let category = item.phase
        ? slugify(item.phase)
        : extractDomainConcept(item.title);

      if (!riskCategories.has(category)) {
        riskCategories.set(category, { items: [], mitigations: [] });
      }
      const group = riskCategories.get(category)!;
      group.items.push(item);
      group.mitigations.push(item.content);
    }
  }

  const sortedRiskCategories = Array.from(riskCategories.entries()).sort(([a], [b]) => a.localeCompare(b));

  for (const [category, { items, mitigations }] of sortedRiskCategories) {
    const riskServiceName = `${category}-service`;

    // Deduplicate: if a roadmap service with this name already exists, merge refs
    if (serviceByName.has(riskServiceName)) {
      const existing = serviceByName.get(riskServiceName)!;
      const mergedRefs = Array.from(new Set([
        ...existing.dossierItemRefs,
        ...items.map((it) => it.id),
      ]));
      // Replace in the services array with merged version
      const idx = services.findIndex((s) => s.name === riskServiceName);
      if (idx !== -1) {
        services[idx] = {
          ...existing,
          dossierItemRefs: mergedRefs,
        };
        serviceByName.set(riskServiceName, services[idx]!);
      }
      continue;
    }

    const responsibility = mitigations.join('; ');
    const svc: Phase2ServiceDefinition = {
      id: nextSvcId(),
      name: riskServiceName,
      responsibility: `Risk mitigation: ${responsibility}`,
      api: [`mitigate${camelCase(category)}()`, `assess${camelCase(category)}Risk()`, `report${camelCase(category)}Status()`],
      dependencies: [],
      dossierItemRefs: items.map((it) => it.id),
    };
    services.push(svc);
    serviceByName.set(svc.name, svc);
  }

  // --------------------------------------------------------------------------
  // 5. Monitoring service: always include if any risk items exist
  // --------------------------------------------------------------------------
  const hasRiskItems = dossier.items.some((item) => item.category === 'risk');
  if (hasRiskItems) {
    const monitoringName = 'monitoring-service';
    if (!serviceByName.has(monitoringName)) {
      const svc: Phase2ServiceDefinition = {
        id: nextSvcId(),
        name: monitoringName,
        responsibility: 'Observability, drift detection, SLO tracking',
        api: ['emitMetric()', 'checkSLO()', 'detectDrift()'],
        dependencies: [],
        dossierItemRefs: computeDossierRefs(monitoringName, 'observability drift detection SLO tracking monitoring', dossier),
      };
      services.push(svc);
      serviceByName.set(svc.name, svc);
    }
  }

  // --------------------------------------------------------------------------
  // Boundaries: one per service (already dynamic pattern)
  // --------------------------------------------------------------------------
  const boundaries = services.map((svc) => ({
    id: `BND-${svc.id.replace('SVC-', '')}`,
    name: `${svc.name} boundary`,
    description: `Bounded context for ${svc.responsibility.toLowerCase()}`,
    dossierItemRefs: svc.dossierItemRefs,
  }));

  // --------------------------------------------------------------------------
  // Security boundaries: one per high-severity risk item mentioning security keywords
  // --------------------------------------------------------------------------
  const securityBoundaries: string[] = [];
  for (const item of dossier.items) {
    if (
      item.category === 'risk' &&
      item.severity === 'high' &&
      contentMatchesKeywords(`${item.title} ${item.content}`, SECURITY_KEYWORDS)
    ) {
      securityBoundaries.push(`${item.id} boundary: ${item.content}`);
    }
  }
  // Ensure at least one security boundary if we have an api-gateway
  if (securityBoundaries.length === 0 && serviceByName.has('api-gateway')) {
    securityBoundaries.push('Default boundary: All external requests authenticated at api-gateway');
  }

  // --------------------------------------------------------------------------
  // API contracts: one per service-to-service dependency edge
  // --------------------------------------------------------------------------
  const apiContracts: string[] = [];
  for (const svc of services) {
    for (const dep of svc.dependencies) {
      const depSvc = serviceByName.get(dep);
      const contractDesc = depSvc
        ? `Contract via ${svc.api[0] ?? svc.name}`
        : `Contract via ${svc.name} API`;
      apiContracts.push(`${svc.name} <-> ${dep}: ${contractDesc}`);
    }
  }

  // --------------------------------------------------------------------------
  // Data flow: generated from the actual service dependency graph
  // --------------------------------------------------------------------------
  const flowEdges: string[] = [];
  for (const svc of services) {
    for (const dep of svc.dependencies) {
      flowEdges.push(`${svc.name} -> ${dep}`);
    }
  }
  const dataFlow = flowEdges.length > 0
    ? flowEdges.join('; ')
    : services.map((s) => s.name).join(' -> ');

  return {
    services,
    boundaries,
    dataFlow,
    apiContracts,
    securityBoundaries,
  };
}

// ============================================================================
// Refinement Builder
// ============================================================================

function buildRefinement(dossier: ResearchDossier): Phase2Refinement {
  // Security considerations from high/medium risk items
  const securityConsiderations: Array<{ id: string; text: string; dossierItemRefs: string[] }> = [];
  let secIdx = 1;
  for (const item of dossier.items) {
    if (
      item.category === 'risk' &&
      (item.severity === 'high' || item.severity === 'medium')
    ) {
      securityConsiderations.push({
        id: `SEC-${pad3(secIdx)}`,
        text: item.content,
        dossierItemRefs: [item.id],
      });
      secIdx++;
    }
  }

  // Performance targets from success-criterion items mentioning latency/SLA/throughput
  const perfKeywords = ['latency', 'sla', 'throughput', 'response time', 'p99', 'p95'];
  const performanceTargets: Array<{ id: string; text: string; dossierItemRefs: string[] }> = [];
  let perfIdx = 1;
  for (const item of dossier.items) {
    if (
      item.category === 'success-criterion' &&
      contentMatchesKeywords(item.content, perfKeywords)
    ) {
      performanceTargets.push({
        id: `PERF-${pad3(perfIdx)}`,
        text: item.content,
        dossierItemRefs: [item.id],
      });
      perfIdx++;
    }
  }

  // Dynamic test strategy: one line per success criterion category found in dossier
  const scCategories = new Map<string, string[]>();
  for (const item of dossier.items) {
    if (item.category === 'success-criterion') {
      // Derive a category from the item title or content
      const category = item.phase ?? slugify(item.title.split(':')[0] ?? item.title);
      const normalized = slugify(category);
      if (!scCategories.has(normalized)) {
        scCategories.set(normalized, []);
      }
      scCategories.get(normalized)!.push(item.content);
    }
  }

  const strategyLines: string[] = ['Test Strategy:'];
  let strategyIdx = 1;

  if (scCategories.size > 0) {
    const sortedCategories = Array.from(scCategories.entries()).sort(([a], [b]) => a.localeCompare(b));
    for (const [category, criteria] of sortedCategories) {
      const criteriaDesc = criteria.join('; ');
      strategyLines.push(
        `${strategyIdx}. ${category} (${criteria.length} criteria): Validate ${criteriaDesc}`,
      );
      strategyIdx++;
    }
  } else {
    // Fallback if no success criteria found
    strategyLines.push(`${strategyIdx}. Unit tests: Mock all external dependencies at service boundaries.`);
    strategyIdx++;
    strategyLines.push(`${strategyIdx}. Integration tests: Verify service-to-service contracts.`);
    strategyIdx++;
    strategyLines.push(`${strategyIdx}. Acceptance tests: Validate end-to-end scenarios.`);
    strategyIdx++;
  }

  // Always include performance and security test lines if relevant items exist
  if (performanceTargets.length > 0) {
    strategyLines.push(`${strategyIdx}. Performance tests: Benchmark against PERF targets; assert latency SLOs.`);
    strategyIdx++;
  }
  if (securityConsiderations.length > 0) {
    strategyLines.push(`${strategyIdx}. Security tests: Validate security boundaries and audit trail completeness.`);
  }

  const testStrategy = strategyLines.join('\n');

  return {
    securityConsiderations,
    performanceTargets,
    testStrategy,
  };
}

// ============================================================================
// Completion Builder
// ============================================================================

function buildCompletion(
  artifacts: Phase1Artifacts,
  dossier: ResearchDossier,
  services: Phase2ServiceDefinition[],
): Phase2Completion {
  // Integration plan from roadmap phases — detailed per-phase breakdown
  const phases = artifacts.roadmap.phases ?? [];
  const phaseDescriptions: string[] = [];
  for (let i = 0; i < phases.length; i++) {
    const p = phases[i]!;
    const deliverables = p.deliverables ?? [];
    const deps = p.dependencies ?? [];
    const lines = [
      `Phase ${i + 1}: ${p.name}${p.duration ? ` (${p.duration})` : ''}`,
      `  Deliverables: ${deliverables.length > 0 ? deliverables.join(', ') : 'TBD'}`,
    ];
    if (deps.length > 0) {
      lines.push(`  Dependencies: ${deps.join(', ')}`);
    }
    lines.push(`  Verification: Integration tests for ${p.name} boundary contracts`);
    lines.push(`  Rollback: Revert to Phase ${Math.max(i, 1)} checkpoint if validation fails`);
    phaseDescriptions.push(lines.join('\n'));
  }
  const integrationPlan = phaseDescriptions.length > 0
    ? `Integration rollout (${phases.length} phases):\n\n${phaseDescriptions.join('\n\n')}\n\nPost-integration:\n  - Run full regression suite across all phase boundaries\n  - Validate end-to-end data flow from ingestion to reporting\n  - Establish performance baseline metrics for production SLOs`
    : 'Integration plan: Single-phase deployment with staged rollout, canary release, and automated rollback.';

  // Dynamic documentation list — comprehensive coverage
  const documentation: string[] = [
    'API reference (OpenAPI 3.1 spec) — all endpoints, request/response schemas, error codes',
    'Architecture Decision Records (ADRs) — rationale, alternatives considered, consequences',
    'System architecture overview — service topology, data flow diagrams, deployment model',
    'Domain model glossary — bounded contexts, aggregates, value objects, domain events',
  ];
  // One doc per roadmap phase
  for (const phase of phases) {
    const deliverables = phase.deliverables ?? [];
    documentation.push(
      `${phase.name} implementation guide — ${deliverables.length > 0 ? deliverables.join(', ') : 'setup, configuration, and verification steps'}`,
    );
  }
  documentation.push('Deployment runbook — environment setup, secrets management, health check verification');
  documentation.push('Operational playbook — incident response, escalation paths, on-call procedures');
  documentation.push('Security model documentation — authentication flows, authorization matrix, data classification');
  // One per high-severity risk area
  const highRiskAreas = new Set<string>();
  for (const item of dossier.items) {
    if (item.category === 'risk' && item.severity === 'high') {
      const area = item.phase ?? slugify(item.title.split(':')[0] ?? item.title);
      highRiskAreas.add(area);
    }
  }
  for (const area of Array.from(highRiskAreas).sort()) {
    documentation.push(`${area} risk mitigation guide — triggers, response procedures, monitoring thresholds`);
  }
  // Per-service API documentation
  for (const svc of services) {
    documentation.push(`${svc.name} service documentation — API contracts, configuration, health endpoints`);
  }

  // Dynamic monitoring setup — detailed per-service
  const monitoringSetup: string[] = [
    'Structured logging (JSON) — correlation IDs, request tracing, error categorization',
    'Distributed tracing (OpenTelemetry) — span collection, trace propagation across service boundaries',
    'Error tracking — exception aggregation, alerting thresholds, error budget tracking',
  ];
  // One monitoring item per service with specific metrics
  for (const svc of services) {
    monitoringSetup.push(
      `${svc.name}: request rate, error rate, p50/p95/p99 latency, dependency health, queue depth`,
    );
  }
  monitoringSetup.push('SLO dashboards with burn-rate alerting — availability, latency, error rate targets');
  monitoringSetup.push('Capacity planning — resource utilization trends, auto-scaling triggers, cost projections');
  monitoringSetup.push('Security monitoring — authentication failures, authorization denials, anomaly detection');

  return {
    integrationPlan,
    documentation,
    monitoringSetup,
  };
}

// ============================================================================
// Public: Pure Builder
// ============================================================================

/**
 * Pure function that builds the full SPARC output from a research dossier
 * and Phase 1 artifacts. No side effects (no file I/O, no telemetry).
 * Exported for unit testing.
 *
 * @param dossier   - The research dossier compiled in Stage 2
 * @param artifacts - The Phase 1 artifacts loaded in Stage 1
 * @returns Complete SPARC output with dossier cross-references
 */
export function buildPhase2SPARC(
  dossier: ResearchDossier,
  artifacts: Phase1Artifacts,
): Phase2SPARCOutput {
  const specification = buildSpecification(dossier, artifacts);
  const pseudocode = buildPseudocode(dossier, artifacts.scenario.query ?? '');
  const architecture = buildArchitecture(dossier, artifacts);
  const refinement = buildRefinement(dossier);
  const completion = buildCompletion(artifacts, dossier, architecture.services);

  return {
    specification,
    pseudocode,
    architecture,
    refinement,
    completion,
  };
}

// ============================================================================
// Public: Main Stage Function
// ============================================================================

/**
 * Stage 3 entry point: generate SPARC specification from the research dossier
 * and Phase 1 artifacts stored on the pipeline context.
 *
 * Writes 6 JSON files to `context.phase2Dir/sparc/`:
 *   specification.json, pseudocode.json, architecture.json,
 *   refinement.json, completion.json, sparc-combined.json
 *
 * @param context - The Phase 2 pipeline context (must have dossier on stageOutputs)
 * @returns Stage output describing success or failure
 */
export async function generateSPARCSpecification(
  context: Phase2Context,
): Promise<Phase2StageOutput> {
  const rootSpan = createSpan('sparc-specification', 'generate-sparc', {
    phase2Dir: context.phase2Dir,
  });

  try {
    // Retrieve the research dossier from the previous stage
    const dossierStage = context.stageOutputs.get('research-dossier');
    if (!dossierStage || dossierStage.status !== 'completed') {
      throw new Error(
        'ECLI-P2-010: Research dossier not available on context. ' +
        'Ensure the research-dossier stage completed successfully before running sparc-specification.',
      );
    }
    const dossier = dossierStage.data as ResearchDossier;

    // Build the SPARC output (pure, deterministic)
    const buildSpan = createSpan(
      'sparc-specification',
      'build-sparc',
      { dossierItems: dossier.items.length },
      rootSpan.spanId,
    );

    const sparc = buildPhase2SPARC(dossier, context.phase1Artifacts);

    endSpan(buildSpan, 'ok', {
      requirements: sparc.specification.requirements.length,
      constraints: sparc.specification.constraints.length,
      services: sparc.architecture.services.length,
      modules: sparc.pseudocode.modules.length,
    });
    emitSpan(buildSpan);

    // Write files to disk
    const writeSpan = createSpan(
      'sparc-specification',
      'write-files',
      {},
      rootSpan.spanId,
    );

    const sparcDir = path.join(context.phase2Dir, SPARC_SUBDIR);
    fs.mkdirSync(sparcDir, { recursive: true, mode: DIR_MODE });

    const filesToWrite: Array<{ name: string; data: unknown }> = [
      { name: 'specification.json', data: sparc.specification },
      { name: 'pseudocode.json', data: sparc.pseudocode },
      { name: 'architecture.json', data: sparc.architecture },
      { name: 'refinement.json', data: sparc.refinement },
      { name: 'completion.json', data: sparc.completion },
      { name: 'sparc-combined.json', data: sparc },
    ];

    const writtenPaths: string[] = [];

    for (const file of filesToWrite) {
      const filePath = path.join(sparcDir, file.name);
      try {
        fs.writeFileSync(
          filePath,
          JSON.stringify(file.data, null, 2) + '\n',
          { encoding: 'utf-8', mode: FILE_MODE },
        );
        writtenPaths.push(filePath);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(
          `ECLI-P2-011: Failed to write SPARC file ${file.name}: ${message}`,
        );
      }
    }

    // Write markdown files alongside JSON
    try {
      const combinedMd = renderSPARCMarkdown(sparc);
      const mdPath = path.join(sparcDir, 'sparc-combined.md');
      fs.writeFileSync(mdPath, combinedMd + '\n', { encoding: 'utf-8', mode: FILE_MODE });
      writtenPaths.push(mdPath);

      // Write individual section markdown files
      const pseudocodeMdLines: string[] = ['# Pseudocode\n'];
      for (const mod of sparc.pseudocode.modules) {
        pseudocodeMdLines.push(`## ${mod.name}\n`);
        if (mod.markdown) {
          pseudocodeMdLines.push('```pseudocode');
          pseudocodeMdLines.push(mod.markdown);
          pseudocodeMdLines.push('```\n');
        }
        if (mod.dataStructures.length > 0) {
          pseudocodeMdLines.push('**Data Structures:**\n```typescript');
          pseudocodeMdLines.push(mod.dataStructures.join('\n'));
          pseudocodeMdLines.push('```\n');
        }
        if (mod.tddAnchors.length > 0) {
          pseudocodeMdLines.push('**TDD Anchors:**');
          for (const anchor of mod.tddAnchors) {
            pseudocodeMdLines.push(`- ${anchor}`);
          }
          pseudocodeMdLines.push('');
        }
      }
      const pseudoMdPath = path.join(sparcDir, 'pseudocode.md');
      fs.writeFileSync(pseudoMdPath, pseudocodeMdLines.join('\n') + '\n', { encoding: 'utf-8', mode: FILE_MODE });
      writtenPaths.push(pseudoMdPath);

      // Architecture markdown
      const archMdLines: string[] = ['# Architecture\n'];
      archMdLines.push('## Services\n');
      archMdLines.push('| ID | Service | Responsibility | Dependencies |');
      archMdLines.push('|----|---------|---------------|-------------|');
      for (const svc of sparc.architecture.services) {
        archMdLines.push(`| ${svc.id} | ${svc.name} | ${svc.responsibility} | ${svc.dependencies.join(', ')} |`);
      }
      archMdLines.push('');
      archMdLines.push('## Data Flow\n');
      archMdLines.push(sparc.architecture.dataFlow);
      archMdLines.push('');
      archMdLines.push('## API Contracts\n');
      for (const contract of sparc.architecture.apiContracts) {
        archMdLines.push(`- ${contract}`);
      }
      archMdLines.push('');
      archMdLines.push('## Security Boundaries\n');
      for (const boundary of sparc.architecture.securityBoundaries) {
        archMdLines.push(`- ${boundary}`);
      }
      const archMdPath = path.join(sparcDir, 'architecture.md');
      fs.writeFileSync(archMdPath, archMdLines.join('\n') + '\n', { encoding: 'utf-8', mode: FILE_MODE });
      writtenPaths.push(archMdPath);
    } catch (_mdErr: unknown) {
      // Markdown rendering is best-effort; do not fail the pipeline
    }

    endSpan(writeSpan, 'ok', { filesWritten: writtenPaths.length });
    emitSpan(writeSpan);

    endSpan(rootSpan, 'ok', {
      dossierCoverage: sparc.specification.dossierCoverage,
      totalArtifacts: writtenPaths.length,
    });
    emitSpan(rootSpan);

    const timing = rootSpan.durationMs ?? 0;

    const output: Phase2StageOutput = {
      stage: 'sparc-specification',
      status: 'completed',
      data: sparc,
      artifacts: writtenPaths,
      timing,
      summary:
        `Generated SPARC specification with ${sparc.specification.requirements.length} requirements, ` +
        `${sparc.specification.constraints.length} constraints, ` +
        `${sparc.architecture.services.length} services, ` +
        `${sparc.pseudocode.modules.length} pseudocode modules ` +
        `(dossier coverage: ${sparc.specification.dossierCoverage}%) in ${timing}ms`,
    };

    context.stageOutputs.set('sparc-specification', output);
    return output;
  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : String(err);

    endSpan(rootSpan, 'error', { error: errorMessage });
    emitSpan(rootSpan);

    const timing = rootSpan.durationMs ?? 0;

    const output: Phase2StageOutput = {
      stage: 'sparc-specification',
      status: 'failed',
      data: { error: errorMessage },
      artifacts: [],
      timing,
      summary: `SPARC specification generation failed: ${errorMessage}`,
    };

    context.stageOutputs.set('sparc-specification', output);
    return output;
  }
}
