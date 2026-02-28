/**
 * Pipeline Phase 3: SPARC Development
 *
 * Runs the 5 SPARC phases (Specification, Pseudocode, Architecture,
 * Refinement, Completion) using research output as input.
 * Writes phase outputs to <run-dir>/sparc/.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { PipelineContext, StageOutput, SPARCOutput } from '../types.js';

export async function executeSPARCDevelopment(
  context: PipelineContext,
): Promise<StageOutput> {
  const start = Date.now();
  const sparcDir = path.join(context.artifactsDir, 'sparc');
  fs.mkdirSync(sparcDir, { recursive: true, mode: 0o700 });
  const artifacts: string[] = [];

  // Get research data and user feedback
  const researchOutput = context.stageOutputs.get('deep-research');
  const feedback = context.userFeedback.get('sparc-development') ?? [];

  const researchData = researchOutput?.data as Record<string, unknown> | undefined;
  const userContext = (researchData?.['user_context'] ?? context.userContext) as Record<string, unknown>;

  console.error('  Running SPARC development phases...');
  console.error('');

  // Phase 1: Specification
  console.error('    [1/5] Specification...');
  const specification = buildSpecification(context.query, userContext, researchData, feedback);
  writePhaseFile(sparcDir, 'specification.json', specification);
  artifacts.push('sparc/specification.json');

  // Phase 2: Pseudocode
  console.error('    [2/5] Pseudocode...');
  const pseudocode = buildPseudocode(specification, userContext);
  writePhaseFile(sparcDir, 'pseudocode.json', pseudocode);
  artifacts.push('sparc/pseudocode.json');

  // Phase 3: Architecture
  console.error('    [3/5] Architecture...');
  const architecture = buildArchitecture(specification, pseudocode, userContext);
  writePhaseFile(sparcDir, 'architecture.json', architecture);
  artifacts.push('sparc/architecture.json');

  // Phase 4: Refinement
  console.error('    [4/5] Refinement...');
  const refinement = buildRefinement(architecture, specification, userContext);
  writePhaseFile(sparcDir, 'refinement.json', refinement);
  artifacts.push('sparc/refinement.json');

  // Phase 5: Completion
  console.error('    [5/5] Completion...');
  const completion = buildCompletion(architecture, refinement, specification);
  writePhaseFile(sparcDir, 'completion.json', completion);
  artifacts.push('sparc/completion.json');

  const sparcOutput: SPARCOutput = {
    specification,
    pseudocode,
    architecture,
    refinement,
    completion,
  };

  // Write combined SPARC output
  writePhaseFile(sparcDir, 'sparc-combined.json', sparcOutput);
  artifacts.push('sparc/sparc-combined.json');

  console.error('    SPARC phases complete.');
  console.error('');

  return {
    stage: 'sparc-development',
    status: 'completed',
    data: sparcOutput,
    artifacts,
    timing: Date.now() - start,
    summary: buildSPARCSummary(sparcOutput),
  };
}

// ============================================================================
// SPARC Phase Builders
// ============================================================================

function buildSpecification(
  query: string,
  userContext: Record<string, unknown>,
  researchData: Record<string, unknown> | undefined,
  feedback: string[],
): SPARCOutput['specification'] {
  const erpSystem = String(userContext['erpSystem'] ?? 'not specified');
  const techStack = userContext['techStack'] as string[] ?? [];
  const timeline = String(userContext['timeline'] ?? 'to be determined');
  const lower = query.toLowerCase();

  // Detect domain from query
  const hasPdf = lower.includes('pdf');
  const hasEmail = lower.includes('email');
  const hasEmissions = lower.includes('emission') || lower.includes('scope 3') || lower.includes('scope3');
  const hasSap = lower.includes('sap') || erpSystem.toLowerCase().includes('sap');
  const hasInvoice = lower.includes('invoice');
  const hasSupplier = lower.includes('supplier') || lower.includes('vendor');
  const hasMl = lower.includes('ml') || lower.includes('ai') || lower.includes('extract') || lower.includes('llm');

  // Extract requirements from simulation query, research, and domain detection
  const requirements: string[] = [];
  let reqIdx = 1;

  // Core functional requirements derived from query analysis
  if (hasInvoice || hasPdf || hasEmail) {
    requirements.push(`REQ-${String(reqIdx++).padStart(3, '0')}: Ingest documents from ${[hasPdf && 'PDF', hasEmail && 'email'].filter(Boolean).join(' and ')} sources with format validation`);
    requirements.push(`REQ-${String(reqIdx++).padStart(3, '0')}: Parse and normalize ingested documents into structured payloads with confidence scoring`);
  }
  if (hasMl) {
    requirements.push(`REQ-${String(reqIdx++).padStart(3, '0')}: LLM-based structured data extraction with schema validation and per-field confidence scores`);
    requirements.push(`REQ-${String(reqIdx++).padStart(3, '0')}: Policy enforcement layer: PII detection, prompt injection guard, training-data reuse check`);
  }
  if (hasEmissions) {
    requirements.push(`REQ-${String(reqIdx++).padStart(3, '0')}: Scope 3 emissions calculation from supplier invoice line items using GHG Protocol methodology`);
    requirements.push(`REQ-${String(reqIdx++).padStart(3, '0')}: Emissions factor database with category-based lookup and uncertainty propagation`);
  }
  if (hasSap) {
    requirements.push(`REQ-${String(reqIdx++).padStart(3, '0')}: Authenticated push to ${erpSystem} via OData v4 POST with CSRF token handling and rollback support`);
    requirements.push(`REQ-${String(reqIdx++).padStart(3, '0')}: IAM-scoped service account authentication with VPC connector for on-premise ${erpSystem} access`);
  }
  if (hasSupplier) {
    requirements.push(`REQ-${String(reqIdx++).padStart(3, '0')}: Supplier profile management with risk scoring and compliance status tracking`);
  }
  requirements.push(`REQ-${String(reqIdx++).padStart(3, '0')}: Append-only audit trail for every pipeline stage with trace ID correlation`);
  requirements.push(`REQ-${String(reqIdx++).padStart(3, '0')}: Drift detection with statistical baseline comparison and alerting on confidence degradation`);
  if (techStack.length > 0) {
    requirements.push(`REQ-${String(reqIdx++).padStart(3, '0')}: Implementation using technology stack: ${techStack.join(', ')}`);
  }
  requirements.push(`REQ-${String(reqIdx++).padStart(3, '0')}: Deliver within target timeline: ${timeline}`);

  // Research-derived requirements
  if (researchData && typeof researchData === 'object') {
    const findings = researchData['findings'] ?? researchData['key_findings'];
    if (Array.isArray(findings)) {
      for (const finding of findings.slice(0, 5)) {
        const text = typeof finding === 'string' ? finding : String(finding);
        if (text.length > 10) {
          requirements.push(`REQ-${String(reqIdx++).padStart(3, '0')}: [Research] ${text}`);
        }
      }
    }
  }

  const constraints = [
    'CON-001: Files must remain < 500 lines; split into modules when exceeded',
    'CON-002: No hard-coded environment variables, secrets, or credentials in source code',
    ...(hasSap ? [
      `CON-003: Must interface with ${erpSystem} OData v4 APIs and respect entity set schemas`,
      'CON-004: Must handle SAP CSRF token lifecycle (fetch, cache, refresh on 403)',
    ] : []),
    'CON-005: Must comply with enterprise security policies (OWASP Top 10, SOC2)',
    'CON-006: Must support horizontal scaling with stateless service design',
    'CON-007: All data transformations must be idempotent with trace ID correlation',
    ...(hasEmissions ? ['CON-008: Emissions calculations must follow GHG Protocol corporate standard methodology'] : []),
  ];

  const successCriteria = [
    'SC-001: All automated tests pass with >90% line coverage and >80% branch coverage',
    'SC-002: API response time p95 < 200ms, p99 < 500ms under load',
    'SC-003: Security audit passes with zero critical and zero high findings',
    ...(hasSap ? [`SC-004: End-to-end integration test with ${erpSystem} completes successfully`] : []),
    'SC-005: Drift detection triggers alert within 60s of confidence degradation > 2σ',
    'SC-006: Audit trail captures 100% of pipeline events with < 100ms write latency',
    ...(hasMl ? ['SC-007: LLM extraction achieves >0.85 overall confidence on test corpus'] : []),
  ];

  if (feedback.length > 0) {
    requirements.push(`REQ-${String(reqIdx++).padStart(3, '0')}: [Revised per feedback]: ${feedback[feedback.length - 1]}`);
  }

  return {
    requirements,
    constraints,
    successCriteria,
    scope: query,
  };
}

function buildPseudocode(
  spec: SPARCOutput['specification'],
  userContext: Record<string, unknown>,
): SPARCOutput['pseudocode'] {
  const lower = spec.scope.toLowerCase();
  const erpSystem = String(userContext['erpSystem'] ?? 'ERP');
  const hasPdf = lower.includes('pdf');
  const hasEmail = lower.includes('email');
  const hasEmissions = lower.includes('emission') || lower.includes('scope 3');
  const hasSap = lower.includes('sap') || erpSystem.toLowerCase().includes('sap');
  const hasMl = lower.includes('ml') || lower.includes('ai') || lower.includes('extract') || lower.includes('llm');
  const entity = hasEmissions ? 'EmissionsRecord' : lower.includes('invoice') ? 'Invoice' : 'Document';

  const algorithms: string[] = [];

  // Ingestion pseudocode
  if (hasPdf || hasEmail) {
    algorithms.push(
      `FUNCTION ingestDocument(source: ${hasPdf ? 'PDFBinary | ' : ''}${hasEmail ? 'EmailMIME | ' : ''}RawPayload): ${entity}Payload`,
      `  traceId = generateTraceId()`,
      `  LOG("ingestion_start", { traceId, sourceType: typeOf(source) })`,
      ...(hasPdf ? [`  IF source IS PDFBinary:`, `    rawText = extractTextFromPDF(source)`, `    tables  = extractTablesFromPDF(source)`] : []),
      ...(hasEmail ? [`  IF source IS EmailMIME:`, `    rawText = parseEmailBody(source)`, `    attachments = extractAttachments(source)`, `    FOR EACH att IN attachments WHERE att.mimeType == "application/pdf":`, `      rawText += extractTextFromPDF(att.content)`] : []),
      `  extracted = extractStructuredFields(rawText, tables)`,
      `  validation = validateAgainstSchema(extracted, ${entity}Schema)`,
      `  IF NOT validation.isValid:`,
      `    THROW ValidationError(validation.errors)`,
      `  payload = ${entity}Payload { ...extracted, traceId, ingestedAt: NOW(), confidence: extracted.confidence }`,
      `  appendToAuditMemory("ingestion_complete", { traceId, fieldCount: keys(payload).length })`,
      `  RETURN payload`,
      '',
    );
  }

  // LLM extraction pseudocode
  if (hasMl) {
    algorithms.push(
      `FUNCTION extractStructuredData(payload: IngestedPayload, schema: JSONSchema): ExtractionResult`,
      `  systemPrompt = buildSystemPrompt(schema)`,
      `  userPrompt   = buildExtractionPrompt(payload.rawText, payload.lineItems, schema)`,
      `  policyResult = enforcePreCallPolicy(userPrompt, payload)`,
      `  IF policyResult.blocked:`,
      `    THROW PolicyViolationError(policyResult.reason)`,
      `  TRY:`,
      `    llmResponse = callLLM({ model: CONFIG.extractionModel, systemPrompt, userPrompt, responseFormat: "json", temperature: 0.0 })`,
      `  CATCH error:`,
      `    THROW ExtractionError("LLM call failed: " + error.message)`,
      `  parsed = parseJSON(llmResponse.content)`,
      `  schemaValidation = validateAgainstSchema(parsed, schema)`,
      `  IF NOT schemaValidation.isValid:`,
      `    retryPrompt = buildRetryPrompt(userPrompt, schemaValidation.errors)`,
      `    llmRetry = callLLM({ ...CONFIG, userPrompt: retryPrompt })`,
      `    parsed = parseJSON(llmRetry.content)`,
      `  fieldConfidences = computeFieldConfidences(parsed, payload.rawText)`,
      `  RETURN ExtractionResult { data: parsed, fieldConfidences, overallConfidence: mean(values(fieldConfidences)), traceId: payload.traceId }`,
      '',
    );
  }

  // ERP push pseudocode
  if (hasSap) {
    algorithms.push(
      `FUNCTION pushToERP(data: ValidatedPayload, config: ERPConfig): ERPPushResult`,
      `  authToken = authenticateServiceAccount(config.serviceAccount, config.scope)`,
      `  odataPayload = transform${entity}ToOData(data, config.entitySet)`,
      `  rollbackId = createRollbackSnapshot(data.traceId, odataPayload)`,
      `  TRY:`,
      `    response = httpPost(config.baseUrl + "/" + config.entitySet, {`,
      `      headers: { "Authorization": "Bearer " + authToken, "X-CSRF-Token": fetchCSRFToken(config.baseUrl, authToken) },`,
      `      body: serialize(odataPayload), timeout: CONFIG.erpTimeoutMs`,
      `    })`,
      `  CATCH networkError:`,
      `    executeRollback(rollbackId)`,
      `    THROW ERPNetworkError(networkError.message)`,
      `  IF response.status IN [200, 201]:`,
      `    RETURN ERPPushResult { status: "ERP_ACCEPTED", erpId: parseJSON(response.body).id, rollbackId }`,
      `  ELSE:`,
      `    executeRollback(rollbackId)`,
      `    THROW ERPRejectionError(response.status, parseODataError(response.body))`,
      '',
    );
  }

  // Drift detection pseudocode
  algorithms.push(
    `FUNCTION detectDrift(current: ExtractionResult, baseline: BaselineStats): DriftReport`,
    `  driftScores = {}; alerts = []`,
    `  FOR EACH field, confidence IN current.fieldConfidences:`,
    `    IF field IN baseline.fieldStats:`,
    `      zScore = (confidence - baseline.fieldStats[field].mean) / max(baseline.fieldStats[field].stddev, 0.001)`,
    `      IF abs(zScore) > CONFIG.driftThreshold:`,
    `        alerts.push(DriftAlert { field, severity: abs(zScore) > CONFIG.criticalThreshold ? "CRITICAL" : "WARNING", zScore })`,
    `  recommendation = alerts.length == 0 ? "PROCEED" : alerts.any(a => a.severity == "CRITICAL") ? "HALT_AND_REVIEW" : "PROCEED_WITH_CAUTION"`,
    `  RETURN DriftReport { driftScores, alerts, recommendation }`,
  );

  // TDD anchors derived from the actual pseudocode
  const tddAnchors: string[] = [];
  if (hasPdf || hasEmail) {
    tddAnchors.push(
      `TEST: Valid ${hasPdf ? 'PDF' : 'document'} ingestion produces structured payload with confidence > 0.8`,
      'TEST: Malformed document returns ValidationError with descriptive message',
      'TEST: Audit memory receives ingestion_complete event with traceId',
    );
  }
  if (hasMl) {
    tddAnchors.push(
      'TEST: Valid text produces structured output matching target schema',
      'TEST: LLM schema mismatch triggers one retry then succeeds',
      'TEST: Policy violation before LLM call throws PolicyViolationError',
      'TEST: Per-field confidence scores are between 0.0 and 1.0',
    );
  }
  if (hasSap) {
    tddAnchors.push(
      `TEST: Successful OData POST returns ERP_ACCEPTED with entity ID`,
      'TEST: Network timeout triggers rollback and throws ERPNetworkError',
      'TEST: 403 response triggers CSRF token refresh and retry',
      `TEST: ${erpSystem} authentication failure throws ERPAuthenticationError`,
    );
  }
  tddAnchors.push(
    'TEST: Confidence drift > 3σ triggers WARNING alert',
    'TEST: No drift produces PROCEED recommendation',
    'TEST: Critical drift produces HALT_AND_REVIEW recommendation',
  );

  // Data structures
  const dataStructures: string[] = [
    `${entity}Payload { id: string; lineItems: LineItem[]; rawText: string; confidence: number; traceId: string; ingestedAt: ISO8601 }`,
    'LineItem { description: string; quantity: number; unit: string; amount: number; category: string }',
  ];
  if (hasMl) {
    dataStructures.push(
      'ExtractionResult { data: Record<string, unknown>; fieldConfidences: Record<string, number>; overallConfidence: number; traceId: string }',
    );
  }
  if (hasSap) {
    dataStructures.push(
      `ERPConfig { baseUrl: string; entitySet: string; serviceAccount: string; scope: string; timeout: number }`,
      `ERPPushResult { status: "ERP_ACCEPTED" | "ERP_REJECTED"; erpId: string; rollbackId: string }`,
    );
  }
  if (hasEmissions) {
    dataStructures.push(
      'Scope3Emission { supplierId: string; category: string; co2eKg: number; emissionFactor: number; uncertainty: number; methodology: string }',
    );
  }
  dataStructures.push(
    'DriftReport { driftScores: Record<string, number>; alerts: DriftAlert[]; recommendation: "PROCEED" | "PROCEED_WITH_CAUTION" | "HALT_AND_REVIEW" }',
    'AuditEntry { traceId: string; event: string; timestamp: ISO8601; data: Record<string, unknown> }',
  );

  return {
    algorithms,
    tddAnchors,
    dataStructures,
  };
}

function buildArchitecture(
  spec: SPARCOutput['specification'],
  _pseudocode: SPARCOutput['pseudocode'],
  userContext: Record<string, unknown>,
): SPARCOutput['architecture'] {
  const erpSystem = String(userContext['erpSystem'] ?? 'external-system');
  const techStack = userContext['techStack'] as string[] ?? ['Rust'];
  const lower = spec.scope.toLowerCase();
  const hasPdf = lower.includes('pdf') || lower.includes('document') || lower.includes('invoice');
  const hasMl = lower.includes('ml') || lower.includes('ai') || lower.includes('extract') || lower.includes('llm');
  const hasEmissions = lower.includes('emission') || lower.includes('scope 3');
  const hasSap = lower.includes('sap') || erpSystem.toLowerCase().includes('sap');
  const lang = techStack[0] ?? 'Rust';

  const services: Array<{ name: string; responsibility: string; api: string[]; dependencies: string[] }> = [
    {
      name: 'api-gateway',
      responsibility: 'Request routing, JWT authentication, rate limiting, request correlation ID injection',
      api: ['POST /v1/ingest', 'POST /v1/extract', 'GET /v1/status/:traceId', 'GET /v1/health', 'GET /v1/governance/audit'],
      dependencies: ['ingestion-service', 'extraction-service', 'audit-service'],
    },
  ];

  if (hasPdf) {
    services.push({
      name: 'ingestion-service',
      responsibility: 'Document ingestion from PDF and email sources — text extraction, table parsing, format normalization',
      api: ['ingest(source: RawPayload): DocumentPayload', 'validateSchema(payload, schema): ValidationResult'],
      dependencies: ['audit-service'],
    });
  }

  if (hasMl) {
    services.push({
      name: 'extraction-service',
      responsibility: 'LLM-based structured data extraction with schema validation, retry logic, and per-field confidence scoring',
      api: ['extract(payload, schema): ExtractionResult', 'computeConfidence(parsed, rawText): FieldConfidences'],
      dependencies: ['policy-service', 'audit-service'],
    });
    services.push({
      name: 'policy-service',
      responsibility: 'Multi-layer policy enforcement: PII detection, prompt injection guard, compliance rules, training-data reuse check',
      api: ['enforce(input: PolicyInput): PolicyResult', 'scanPII(content): PIIScanResult', 'detectInjection(content): InjectionResult'],
      dependencies: ['audit-service'],
    });
  }

  if (hasEmissions) {
    services.push({
      name: 'emissions-calculator',
      responsibility: 'Scope 3 emissions calculation from invoice line items using GHG Protocol methodology with emission factor lookup',
      api: ['calculate(lineItems, supplierProfile): EmissionsResult', 'lookupFactor(category, region): EmissionFactor'],
      dependencies: ['audit-service'],
    });
  }

  if (hasSap) {
    services.push({
      name: 'erp-adapter',
      responsibility: `${erpSystem} OData v4 integration — authenticated push, CSRF token handling, schema transformation, rollback support`,
      api: [`pushToERP(data, config): ERPPushResult`, `fetchCSRFToken(baseUrl, auth): string`, `executeRollback(rollbackId): void`],
      dependencies: ['audit-service'],
    });
  }

  services.push({
    name: 'drift-monitor',
    responsibility: 'Extraction quality drift detection via statistical baseline comparison, KL divergence, and z-score alerting',
    api: ['detectDrift(current, baseline): DriftReport', 'updateBaseline(result): void'],
    dependencies: ['audit-service'],
  });

  services.push({
    name: 'audit-service',
    responsibility: 'Append-only audit trail with trace ID correlation — stores every pipeline event for governance and debugging',
    api: ['append(traceId, event, data): void', 'query(traceId): AuditEntry[]', 'exportAuditLog(dateRange): AuditExport'],
    dependencies: [],
  });

  const boundaries = [
    `Core Domain: ${hasMl ? 'Document extraction and ' : ''}${hasEmissions ? 'emissions calculation' : 'business logic'} for ${spec.scope}`,
    `Integration Layer: ${erpSystem} OData v4 adapter with anti-corruption layer and rollback support`,
    'Policy Layer: PII, injection, compliance enforcement — pre-LLM and post-extraction',
    `Presentation Layer: API gateway with ${lang} — JWT auth, rate limiting, CORS`,
    'Observability Layer: Audit trail, drift monitoring, alerting, structured logging',
  ];

  const dataFlowSteps = [
    `Client -> API Gateway -> ${hasPdf ? 'Ingestion Service -> ' : ''}${hasMl ? 'Policy Service -> Extraction Service -> ' : ''}${hasEmissions ? 'Emissions Calculator -> ' : ''}${hasSap ? 'ERP Adapter -> ' + erpSystem : 'Data Store'}`,
    `Drift Monitor observes extraction results and compares against rolling baseline`,
    `Audit Service receives events from every service via append-only log`,
  ];

  const apiContracts = [
    'OpenAPI 3.0 specification for all REST endpoints',
    ...(hasSap ? [`${erpSystem} OData v4 entity set schema (A_PurchaseContract, A_BusinessPartner, A_PurchaseOrder)`] : []),
    'AsyncAPI 2.0 specification for domain events (ingestion.completed, extraction.completed, erp.pushed)',
    'JSON Schema definitions for all inter-service payloads',
    'Policy contract: pre-call and post-extraction enforcement rules',
  ];

  return {
    services,
    boundaries,
    dataFlow: dataFlowSteps.join('\n'),
    apiContracts,
  };
}

function buildRefinement(
  architecture: SPARCOutput['architecture'],
  spec: SPARCOutput['specification'],
  userContext: Record<string, unknown>,
): SPARCOutput['refinement'] {
  const erpSystem = String(userContext['erpSystem'] ?? 'external');
  const lower = spec.scope.toLowerCase();
  const hasSap = lower.includes('sap') || erpSystem.toLowerCase().includes('sap');
  const hasMl = lower.includes('ml') || lower.includes('ai') || lower.includes('extract') || lower.includes('llm');
  const erpAdapter = architecture.services.find(s => s.name === 'erp-adapter');

  return {
    securityConsiderations: [
      'SEC-001: Input validation on all API endpoints using Zod schemas with strict mode',
      'SEC-002: JWT authentication with RS256 signing and refresh token rotation',
      'SEC-003: Claims-based authorization (RBAC) — service-level and field-level access control',
      'SEC-004: Data encryption at rest (AES-256-GCM) and in transit (TLS 1.3)',
      'SEC-005: Append-only audit logging for every state-changing operation with tamper detection',
      'SEC-006: SQL/NoSQL injection prevention via parameterized queries and input sanitization',
      'SEC-007: Rate limiting per API key (1000 req/min) and per IP (100 req/min)',
      ...(hasMl ? [
        'SEC-008: Prompt injection detection layer before every LLM call (score threshold: 0.7)',
        'SEC-009: PII detection and auto-redaction in LLM inputs and outputs',
        'SEC-010: LLM output sanitization — no executable code, no credential leakage',
      ] : []),
      ...(hasSap ? [
        `SEC-011: ${erpSystem} service account with least-privilege IAM roles (invoker, secretAccessor)`,
        'SEC-012: CSRF token lifecycle management — fetch, cache, refresh on 403',
        'SEC-013: VPC connector for on-premise SAP access — internal-only ingress',
      ] : []),
    ],
    performanceTargets: [
      'PERF-001: API response time: p50 < 100ms, p95 < 200ms, p99 < 500ms',
      'PERF-002: Throughput: 1000 requests/second per instance with horizontal auto-scaling',
      'PERF-003: Database query time: p95 < 50ms with connection pooling',
      ...(erpAdapter ? [`PERF-004: ${erpSystem} OData push latency: p95 < 2s including auth + CSRF`] : []),
      ...(hasMl ? ['PERF-005: LLM extraction latency: p95 < 5s with streaming response'] : []),
      'PERF-006: Memory footprint: < 512MB per instance under peak load',
      'PERF-007: Drift detection check: < 100ms per extraction result',
      'PERF-008: Audit trail write latency: < 50ms (append-only, async flush)',
    ],
    testStrategy: [
      'Unit tests: >90% line coverage, >80% branch coverage (London School TDD)',
      `Integration tests: All ${architecture.services.length} service boundaries tested with contract verification`,
      'Contract tests: OpenAPI schemas validated against consumer expectations',
      `End-to-end tests: Full pipeline from ingestion through ${hasSap ? erpSystem + ' push' : 'output'} with test fixtures`,
      'Performance tests: Load testing with k6 — sustained 1000 rps for 10 minutes',
      'Security tests: OWASP ZAP scan, dependency audit (npm audit / cargo audit), secret scanning',
      ...(hasMl ? ['LLM tests: Golden dataset evaluation with >0.85 confidence threshold on test corpus'] : []),
      'Drift tests: Synthetic degradation injection to verify alerting triggers within 60s',
    ].join('\n'),
  };
}

function buildCompletion(
  architecture: SPARCOutput['architecture'],
  _refinement: SPARCOutput['refinement'],
  spec: SPARCOutput['specification'],
): SPARCOutput['completion'] {
  const lower = spec.scope.toLowerCase();
  const hasSap = lower.includes('sap');
  const erpAdapter = architecture.services.find(s => s.name === 'erp-adapter');

  const steps: string[] = [];
  let step = 1;
  steps.push(`${step++}. Deploy audit-service with schema migrations and append-only storage`);
  if (architecture.services.find(s => s.name === 'ingestion-service')) {
    steps.push(`${step++}. Deploy ingestion-service with document parser dependencies`);
  }
  if (architecture.services.find(s => s.name === 'policy-service')) {
    steps.push(`${step++}. Deploy policy-service with PII detection models and rule engine`);
  }
  if (architecture.services.find(s => s.name === 'extraction-service')) {
    steps.push(`${step++}. Deploy extraction-service with LLM provider configuration`);
  }
  if (architecture.services.find(s => s.name === 'emissions-calculator')) {
    steps.push(`${step++}. Deploy emissions-calculator with emission factor database`);
  }
  if (erpAdapter) {
    steps.push(`${step++}. Deploy erp-adapter with ${hasSap ? 'SAP' : 'ERP'} VPC connector and service account credentials`);
  }
  steps.push(`${step++}. Deploy drift-monitor with baseline initialization from seed data`);
  steps.push(`${step++}. Deploy api-gateway with canary routing (10% initial traffic)`);
  steps.push(`${step++}. Run full integration test suite against staging environment`);
  steps.push(`${step++}. Enable monitoring dashboards and alerting rules`);
  steps.push(`${step++}. Gradual traffic migration: 10% -> 25% -> 50% -> 100%`);

  const documentation = [
    'API reference (auto-generated from OpenAPI 3.0 specification)',
    'Architecture decision records (ADRs) — one per major design choice',
    'Domain model documentation with bounded context map',
    'Deployment runbook with rollback procedures',
    'Monitoring and alerting playbook — escalation paths and response actions',
    ...(erpAdapter ? [`${hasSap ? 'SAP' : 'ERP'} integration guide — OData entity mapping and authentication setup`] : []),
    'Security audit report — OWASP compliance, PII handling, secret management',
    'Onboarding guide for new developers — local setup, test data, contribution flow',
  ];

  const monitoringSetup: string[] = [
    'Health check endpoints: /health and /ready on all services',
    'Structured logging with JSON format, trace ID correlation, and log levels',
    'Metrics per service: request rate, error rate, p50/p95/p99 latency, queue depth',
  ];
  for (const svc of architecture.services) {
    monitoringSetup.push(`${svc.name}: request count, error count, latency histogram, dependency health`);
  }
  monitoringSetup.push(
    'SLO dashboards: availability (99.9%), latency (p95 < 200ms), error rate (< 0.1%)',
    'Alerts: SLO burn rate breach, error rate spike > 5%, latency p99 > 1s, drift CRITICAL',
    'Capacity planning: CPU/memory utilization trends, auto-scaling triggers, cost projections',
    'Security monitoring: authentication failures, authorization denials, anomalous request patterns',
  );

  return {
    integrationPlan: steps.join('\n'),
    documentation,
    monitoringSetup,
  };
}

// ============================================================================
// Helpers
// ============================================================================

function writePhaseFile(dir: string, filename: string, data: unknown): void {
  const content = JSON.stringify(data, null, 2);
  fs.writeFileSync(path.join(dir, filename), content, { mode: 0o600, encoding: 'utf-8' });
}

function buildSPARCSummary(sparc: SPARCOutput): string {
  return [
    '  SPARC Development Summary:',
    '',
    `  Specification:`,
    `    - ${sparc.specification.requirements.length} requirements`,
    `    - ${sparc.specification.constraints.length} constraints`,
    `    - ${sparc.specification.successCriteria.length} success criteria`,
    '',
    `  Architecture:`,
    `    - ${sparc.architecture.services.length} services defined`,
    `    - ${sparc.architecture.boundaries.length} bounded contexts`,
    '',
    `  Refinement:`,
    `    - ${sparc.refinement.securityConsiderations.length} security items`,
    `    - ${sparc.refinement.performanceTargets.length} performance targets`,
    '',
    `  Completion:`,
    `    - ${sparc.completion.documentation.length} documentation items`,
    `    - ${sparc.completion.monitoringSetup.length} monitoring items`,
  ].join('\n');
}
