/**
 * Pipeline Phase 4: ADR & DDD Generation
 *
 * Takes SPARC output and generates:
 * - Architecture Decision Records (ADRs) -> <run-dir>/adrs/
 * - Domain-Driven Design artifacts (DDDs) -> <run-dir>/ddd/
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
  PipelineContext,
  StageOutput,
  SPARCOutput,
  ADRRecord,
  DDDBoundedContext,
  DomainModel,
} from '../types.js';

export async function executeADRDDDGeneration(
  context: PipelineContext,
): Promise<StageOutput> {
  const start = Date.now();
  const artifacts: string[] = [];

  const sparcOutput = context.stageOutputs.get('sparc-development');
  const sparc = sparcOutput?.data as SPARCOutput | undefined;
  const feedback = context.userFeedback.get('adr-ddd-generation') ?? [];

  if (!sparc) {
    return {
      stage: 'adr-ddd-generation',
      status: 'failed',
      data: { error: 'SPARC output not available' },
      artifacts: [],
      timing: Date.now() - start,
      summary: '  ERROR: SPARC output not available. Cannot generate ADRs/DDDs.',
    };
  }

  console.error('  Generating Architecture Decision Records...');

  // ========================================================================
  // Generate ADRs
  // ========================================================================
  const adrDir = path.join(context.artifactsDir, 'adrs');
  fs.mkdirSync(adrDir, { recursive: true, mode: 0o700 });

  const adrs = generateADRs(sparc, context.query, feedback);

  for (const adr of adrs) {
    const filename = `${adr.id}-${slugify(adr.title)}.md`;
    const content = renderADRMarkdown(adr);
    fs.writeFileSync(path.join(adrDir, filename), content, { mode: 0o600, encoding: 'utf-8' });
    artifacts.push(`adrs/${filename}`);
    console.error(`    [ADR] ${adr.id}: ${adr.title}`);
  }

  console.error('');
  console.error('  Generating Domain-Driven Design artifacts...');

  // ========================================================================
  // Generate DDD
  // ========================================================================
  const dddDir = path.join(context.artifactsDir, 'ddd');
  const contextsDir = path.join(dddDir, 'contexts');
  fs.mkdirSync(contextsDir, { recursive: true, mode: 0o700 });

  const domainModel = generateDomainModel(sparc, context.query, feedback);

  // Write domain model
  const modelContent = JSON.stringify(domainModel, null, 2);
  fs.writeFileSync(path.join(dddDir, 'domain-model.json'), modelContent, { mode: 0o600, encoding: 'utf-8' });
  artifacts.push('ddd/domain-model.json');

  // Write individual bounded context files
  for (const ctx of domainModel.contexts) {
    const filename = `${slugify(ctx.name)}.json`;
    const ctxContent = JSON.stringify(ctx, null, 2);
    fs.writeFileSync(path.join(contextsDir, filename), ctxContent, { mode: 0o600, encoding: 'utf-8' });
    artifacts.push(`ddd/contexts/${filename}`);
    console.error(`    [DDD] Context: ${ctx.name}`);
  }

  console.error('');

  return {
    stage: 'adr-ddd-generation',
    status: 'completed',
    data: { adrs, domainModel },
    artifacts,
    timing: Date.now() - start,
    summary: buildADRDDDSummary(adrs, domainModel),
  };
}

// ============================================================================
// ADR Generation
// ============================================================================

function generateADRs(sparc: SPARCOutput, query: string, feedback: string[]): ADRRecord[] {
  const now = new Date().toISOString().split('T')[0] ?? new Date().toISOString();
  const adrs: ADRRecord[] = [];

  // ADR 1: Architecture Style
  adrs.push({
    id: 'ADR-001',
    title: 'Architecture Style Selection',
    status: 'proposed',
    date: now,
    context: `The system "${query}" requires a scalable, maintainable architecture. The SPARC analysis identified ${sparc.architecture.services.length} services with distinct responsibilities.`,
    decision: `Adopt a microservices architecture with ${sparc.architecture.services.length} services: ${sparc.architecture.services.map(s => s.name).join(', ')}. Services communicate via REST APIs with async event-driven integration where appropriate.`,
    alternatives: [
      'Monolithic architecture — simpler but harder to scale independently',
      'Serverless functions — lower cost at low scale but cold start concerns',
      'Modular monolith — compromise between simplicity and separation',
    ],
    consequences: [
      'Each service can be deployed and scaled independently',
      'Increased operational complexity (more services to monitor)',
      'Requires service discovery and API gateway',
      'Team can work on services in parallel',
    ],
  });

  // ADR 2: Integration Strategy
  const integrationService = sparc.architecture.services.find(s => s.name.includes('integration'));
  if (integrationService) {
    adrs.push({
      id: 'ADR-002',
      title: 'ERP Integration Strategy',
      status: 'proposed',
      date: now,
      context: `Integration with external ERP systems is a core requirement. The ${integrationService.name} service handles bidirectional data synchronization.`,
      decision: `Use an Anti-Corruption Layer (ACL) pattern via ${integrationService.name}. External data formats are translated at the boundary, keeping the core domain model clean.`,
      alternatives: [
        'Direct API integration — simpler but couples core to external schemas',
        'ETL pipeline — batch processing but higher latency',
        'Event sourcing bridge — complex but provides full audit trail',
      ],
      consequences: [
        'Core domain model remains independent of external schemas',
        'Schema changes in ERP only affect the ACL adapter',
        'Bidirectional sync requires conflict resolution strategy',
        'Additional translation overhead per request',
      ],
    });
  }

  // ADR 3: Security Architecture
  adrs.push({
    id: 'ADR-003',
    title: 'Security Architecture',
    status: 'proposed',
    date: now,
    context: `Enterprise security requirements mandate: ${sparc.refinement.securityConsiderations.slice(0, 3).join('; ')}.`,
    decision: `Implement defense-in-depth: JWT authentication with refresh tokens, claims-based RBAC authorization, input validation via Zod schemas at all boundaries, TLS 1.3 for all communications, AES-256 encryption at rest.`,
    alternatives: [
      'Session-based auth — simpler but not suitable for microservices',
      'OAuth2 only — standard but requires identity provider setup',
      'mTLS between services — more secure but complex certificate management',
    ],
    consequences: [
      'Strong authentication and authorization model',
      'Token management adds complexity to client implementations',
      'Audit trail captures all security-relevant events',
      'Compliance with common enterprise security frameworks',
    ],
  });

  // ADR 4: Data Management
  adrs.push({
    id: 'ADR-004',
    title: 'Data Management Strategy',
    status: 'proposed',
    date: now,
    context: `Each service requires its own data management. The system must support both transactional operations and analytical queries.`,
    decision: `Database-per-service pattern. Each service owns its data store. Use event-driven synchronization for cross-service data needs. Implement CQRS where read and write patterns diverge significantly.`,
    alternatives: [
      'Shared database — simpler but creates tight coupling',
      'Single event store — unified audit trail but complex querying',
      'Data mesh — domain-oriented but requires mature data platform',
    ],
    consequences: [
      'Services are fully decoupled at the data layer',
      'Cross-service queries require event-driven materialized views',
      'Each service can choose optimal storage technology',
      'Data consistency is eventual (not immediate) across services',
    ],
  });

  // ADR 5: Deployment Strategy (from SPARC completion)
  adrs.push({
    id: 'ADR-005',
    title: 'Deployment and Release Strategy',
    status: 'proposed',
    date: now,
    context: `The integration plan calls for phased deployment: ${sparc.completion.integrationPlan.split('\n').slice(0, 2).join('; ')}.`,
    decision: `Adopt GitOps with canary deployments. Use feature flags for gradual rollout (10% -> 50% -> 100%). Each service has independent CI/CD pipeline with automated testing gates.`,
    alternatives: [
      'Blue-green deployment — simpler but doubles infrastructure cost',
      'Rolling update — standard but limited rollback capability',
      'A/B testing deployment — useful for UX but complex for backend',
    ],
    consequences: [
      'Zero-downtime deployments with automated rollback',
      'Feature flags enable controlled exposure to new functionality',
      'Independent service deployment allows faster iteration',
      'Requires investment in deployment tooling and monitoring',
    ],
  });

  // Incorporate feedback into the last ADR
  if (feedback.length > 0) {
    adrs.push({
      id: `ADR-${String(adrs.length + 1).padStart(3, '0')}`,
      title: 'Feedback-Driven Adjustments',
      status: 'proposed',
      date: now,
      context: `Stakeholder feedback identified areas for revision: ${feedback[feedback.length - 1]}`,
      decision: `Incorporate the following changes based on feedback: ${feedback[feedback.length - 1]}`,
      alternatives: ['Maintain original design without changes'],
      consequences: ['Design better aligned with stakeholder expectations', 'May require additional iteration'],
    });
  }

  return adrs;
}

// ============================================================================
// DDD Generation
// ============================================================================

function generateDomainModel(sparc: SPARCOutput, _query: string, feedback: string[]): DomainModel {
  const contexts: DDDBoundedContext[] = [];

  // Map each architecture service to a bounded context
  for (const service of sparc.architecture.services) {
    contexts.push({
      name: service.name,
      description: service.responsibility,
      aggregates: [
        {
          name: `${pascalCase(service.name)}Aggregate`,
          root: `${pascalCase(service.name)}Root`,
          entities: service.api.map((_, i) => `${pascalCase(service.name)}Entity${i + 1}`),
          valueObjects: [`${pascalCase(service.name)}Config`, `${pascalCase(service.name)}Status`],
        },
      ],
      domainEvents: [
        `${pascalCase(service.name)}Created`,
        `${pascalCase(service.name)}Updated`,
        `${pascalCase(service.name)}Completed`,
        `${pascalCase(service.name)}Failed`,
      ],
      commands: service.api.filter(a => !a.startsWith('get') && !a.startsWith('GET')).map(a => `Execute${pascalCase(a.split('(')[0] ?? a)}`),
      queries: service.api.filter(a => a.startsWith('get') || a.startsWith('GET')).map(a => `Query${pascalCase(a.split('(')[0] ?? a)}`),
    });
  }

  // Add feedback-driven context if applicable
  if (feedback.length > 0) {
    const lastCtx = contexts[contexts.length - 1];
    if (lastCtx) {
      lastCtx.description += ` [Revised: ${feedback[feedback.length - 1]}]`;
    }
  }

  // Build context map
  const contextMap = buildContextMap(contexts);

  return { contexts, contextMap };
}

function buildContextMap(contexts: DDDBoundedContext[]): DomainModel['contextMap'] {
  const relations: DomainModel['contextMap'] = [];

  // API gateway is upstream to core
  const gateway = contexts.find(c => c.name.includes('gateway'));
  const core = contexts.find(c => c.name.includes('core'));
  const integration = contexts.find(c => c.name.includes('integration'));
  const data = contexts.find(c => c.name.includes('data'));

  if (gateway && core) {
    relations.push({ upstream: gateway.name, downstream: core.name, type: 'customer-supplier' });
  }
  if (core && integration) {
    relations.push({ upstream: core.name, downstream: integration.name, type: 'anticorruption-layer' });
  }
  if (core && data) {
    relations.push({ upstream: core.name, downstream: data.name, type: 'partnership' });
  }
  if (integration && data) {
    relations.push({ upstream: integration.name, downstream: data.name, type: 'customer-supplier' });
  }

  return relations;
}

// ============================================================================
// Renderers
// ============================================================================

function renderADRMarkdown(adr: ADRRecord): string {
  return [
    `# ${adr.id}: ${adr.title}`,
    '',
    `**Status:** ${adr.status}`,
    `**Date:** ${adr.date}`,
    '',
    '## Context',
    '',
    adr.context,
    '',
    '## Decision',
    '',
    adr.decision,
    '',
    '## Alternatives Considered',
    '',
    ...adr.alternatives.map(a => `- ${a}`),
    '',
    '## Consequences',
    '',
    ...adr.consequences.map(c => `- ${c}`),
    '',
  ].join('\n');
}

function buildADRDDDSummary(adrs: ADRRecord[], model: DomainModel): string {
  return [
    '  ADR & DDD Generation Summary:',
    '',
    '  Architecture Decision Records:',
    ...adrs.map(a => `    - ${a.id}: ${a.title} (${a.status})`),
    '',
    '  Domain-Driven Design:',
    `    - ${model.contexts.length} bounded contexts`,
    ...model.contexts.map(c => `      - ${c.name}: ${c.aggregates.length} aggregate(s), ${c.domainEvents.length} event(s)`),
    `    - ${model.contextMap.length} context relationships`,
  ].join('\n');
}

// ============================================================================
// Utilities
// ============================================================================

function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

function pascalCase(text: string): string {
  return text
    .replace(/[^a-zA-Z0-9]/g, ' ')
    .split(' ')
    .filter(Boolean)
    .map(w => (w[0]?.toUpperCase() ?? '') + w.slice(1))
    .join('');
}
