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
  _researchData: Record<string, unknown> | undefined,
  feedback: string[],
): SPARCOutput['specification'] {
  const erpSystem = String(userContext['erpSystem'] ?? 'not specified');
  const techStack = userContext['techStack'] as string[] ?? [];
  const timeline = String(userContext['timeline'] ?? 'to be determined');

  // Extract requirements from simulation query and research
  const requirements = [
    `Implement solution for: ${query}`,
    ...(erpSystem !== 'not specified' ? [`Integrate with ${erpSystem} ERP system`] : []),
    ...(techStack.length > 0 ? [`Use technology stack: ${techStack.join(', ')}`] : []),
    `Deliver within target timeline: ${timeline}`,
  ];

  const constraints = [
    'Must maintain backward compatibility with existing systems',
    ...(erpSystem !== 'not specified' ? [`Must interface with ${erpSystem} APIs and data formats`] : []),
    'Must comply with enterprise security policies',
    'Must support horizontal scaling',
  ];

  const successCriteria = [
    'All automated tests pass with >90% coverage',
    'Performance benchmarks meet defined SLAs',
    'Security audit passes with no critical findings',
    'Integration tests with ERP system succeed',
  ];

  // Incorporate feedback
  if (feedback.length > 0) {
    requirements.push(`[Revised per feedback]: ${feedback[feedback.length - 1]}`);
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
  return {
    algorithms: [
      `// Main workflow for: ${spec.scope}`,
      '// 1. Initialize system context and configuration',
      '// 2. Validate input parameters and prerequisites',
      '// 3. Execute core business logic',
      '// 4. Handle integration with external systems',
      '// 5. Persist results and emit domain events',
      '// 6. Return structured response with audit trail',
    ],
    tddAnchors: [
      'TEST: System initializes with valid configuration',
      'TEST: Input validation rejects malformed data',
      'TEST: Core logic produces expected output for known inputs',
      'TEST: External system integration handles timeouts gracefully',
      'TEST: Results are persisted atomically',
      'TEST: Domain events are emitted in correct order',
    ],
    dataStructures: [
      `Primary data model for ${spec.scope}`,
      `Integration payload schema for ${String(userContext['erpSystem'] ?? 'external systems')}`,
      'Audit trail record structure',
      'Configuration schema with validation',
    ],
  };
}

function buildArchitecture(
  spec: SPARCOutput['specification'],
  _pseudocode: SPARCOutput['pseudocode'],
  userContext: Record<string, unknown>,
): SPARCOutput['architecture'] {
  const erpSystem = String(userContext['erpSystem'] ?? 'external-system');
  const techStack = userContext['techStack'] as string[] ?? ['Node.js'];

  return {
    services: [
      {
        name: 'api-gateway',
        responsibility: 'Request routing, authentication, rate limiting',
        api: ['POST /v1/execute', 'GET /v1/status', 'GET /v1/health'],
        dependencies: ['core-service'],
      },
      {
        name: 'core-service',
        responsibility: `Core business logic for: ${spec.scope}`,
        api: ['execute()', 'validate()', 'getStatus()'],
        dependencies: ['data-service', 'integration-service'],
      },
      {
        name: 'integration-service',
        responsibility: `${erpSystem} integration and data synchronization`,
        api: ['sync()', 'push()', 'pull()', 'mapSchema()'],
        dependencies: ['data-service'],
      },
      {
        name: 'data-service',
        responsibility: 'Data persistence, caching, and retrieval',
        api: ['store()', 'retrieve()', 'query()', 'audit()'],
        dependencies: [],
      },
    ],
    boundaries: [
      `Core Domain: Business logic for ${spec.scope}`,
      `Integration Layer: ${erpSystem} adapter with anti-corruption layer`,
      `Presentation Layer: API gateway with ${techStack[0] ?? 'Node.js'}`,
      'Infrastructure Layer: Data persistence and messaging',
    ],
    dataFlow: [
      `Client -> API Gateway -> Core Service -> Integration Service -> ${erpSystem}`,
      `${erpSystem} -> Integration Service -> Data Service -> Event Bus -> Audit Log`,
    ].join('\n'),
    apiContracts: [
      'OpenAPI 3.0 specification for all service endpoints',
      `${erpSystem} integration contract (inbound/outbound schemas)`,
      'Event schema definitions for domain events',
    ],
  };
}

function buildRefinement(
  architecture: SPARCOutput['architecture'],
  _spec: SPARCOutput['specification'],
  _userContext: Record<string, unknown>,
): SPARCOutput['refinement'] {
  return {
    securityConsiderations: [
      'Input validation on all API endpoints (Zod schemas)',
      'Authentication via JWT with refresh token rotation',
      'Authorization: claims-based access control (RBAC)',
      'Data encryption at rest (AES-256) and in transit (TLS 1.3)',
      'Audit logging for all state-changing operations',
      'SQL injection prevention via parameterized queries',
      'Rate limiting per API key and IP address',
    ],
    performanceTargets: [
      'API response time: p95 < 200ms, p99 < 500ms',
      'Throughput: 1000 requests/second per instance',
      'Database query time: p95 < 50ms',
      `Integration latency: p95 < 2s (depends on ${architecture.services[2]?.name ?? 'external'} system)`,
      'Memory footprint: < 512MB per instance',
    ],
    testStrategy: [
      'Unit tests: >90% line coverage, >80% branch coverage',
      'Integration tests: All service boundaries tested',
      'Contract tests: API schemas validated against consumers',
      'Performance tests: Load testing with k6 or Artillery',
      'Security tests: OWASP ZAP scan, dependency audit',
    ].join('\n'),
  };
}

function buildCompletion(
  architecture: SPARCOutput['architecture'],
  _refinement: SPARCOutput['refinement'],
  _spec: SPARCOutput['specification'],
): SPARCOutput['completion'] {
  return {
    integrationPlan: [
      '1. Deploy data-service with schema migrations',
      `2. Deploy integration-service with ${architecture.services[2]?.name ?? 'external'} adapter`,
      '3. Deploy core-service with feature flags',
      '4. Deploy api-gateway with canary routing',
      '5. Run integration test suite',
      '6. Enable monitoring and alerting',
      '7. Gradual traffic migration (10% -> 50% -> 100%)',
    ].join('\n'),
    documentation: [
      'API reference (auto-generated from OpenAPI spec)',
      'Architecture decision records (ADRs)',
      'Deployment runbook',
      'Monitoring and alerting playbook',
      'Integration guide for ERP system',
    ],
    monitoringSetup: [
      'Health check endpoints on all services',
      'Structured logging with correlation IDs',
      'Metrics: request rate, latency, error rate, saturation',
      'Alerts: SLO breach, error rate spike, latency degradation',
      'Dashboard: service topology, request flow, error hotspots',
    ],
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
