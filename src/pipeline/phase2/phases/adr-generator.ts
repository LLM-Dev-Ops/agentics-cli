/**
 * Phase 2 Pipeline -- Stage 4: ADR Generator
 *
 * Generates Architecture Decision Records DYNAMICALLY from the SPARC output
 * (Stage 3) and the research dossier (Stage 2). Instead of hardcoding a fixed
 * set, ADRs are derived by scanning the SPARC output for services, security
 * boundaries, high-severity risks, inter-service communication needs,
 * performance targets, compliance constraints, and data persistence concerns.
 *
 * Each ADR carries cross-references to both SPARC sections and research
 * dossier items for full traceability.
 *
 * ADR IDs follow the format ADR-P2-NNN. Files are written as Markdown with
 * a JSON index for programmatic consumption.
 *
 * Error codes:
 *   ECLI-P2-020  SPARC output not available on context
 *   ECLI-P2-021  ADR file write failure
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import type {
  Phase2Context,
  Phase2StageOutput,
  Phase2SPARCOutput,
  Phase2ADRRecord,
  ResearchDossier,
  DossierItem,
} from '../types.js';
import { createSpan, endSpan, emitSpan } from '../telemetry.js';

// ============================================================================
// Constants
// ============================================================================

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const ADR_SUBDIR = 'adrs';

/** Keywords that signal regulatory / compliance concerns. */
const COMPLIANCE_KEYWORDS = [
  'regulatory', 'compliance', 'gdpr', 'hipaa', 'soc', 'csrd',
  'pci', 'regulation', 'legal', 'privacy',
] as const;

/** Keywords that signal data-persistence concerns. */
const DATA_KEYWORDS = [
  'data', 'persistence', 'storage', 'database', 'cache', 'repository',
] as const;

/** Keywords that signal security concerns. */
const SECURITY_KEYWORDS = [
  'security', 'authentication', 'authorization', 'auth', 'access',
  'identity', 'iam', 'encryption', 'credential', 'token',
] as const;

// ============================================================================
// Helpers
// ============================================================================

/**
 * Convert a title string to a URL/filename-safe slug.
 * Lowercases, replaces non-alphanumeric runs with hyphens, trims hyphens.
 */
function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Collect dossier item IDs whose content or title matches any of the given
 * keywords (case-insensitive).
 */
function findDossierRefs(
  dossier: ResearchDossier,
  keywords: readonly string[],
  categoryFilter?: string,
): string[] {
  const refs: string[] = [];
  for (const item of dossier.items) {
    if (categoryFilter && item.category !== categoryFilter) continue;
    const lower = (item.content + ' ' + item.title).toLowerCase();
    if (keywords.some((kw) => lower.includes(kw.toLowerCase()))) {
      refs.push(item.id);
    }
  }
  return Array.from(new Set(refs));
}

/**
 * Collect dossier items (full objects) filtered by category.
 */
function findDossierRefsByCategory(
  dossier: ResearchDossier,
  category: string,
): DossierItem[] {
  return dossier.items.filter((item) => item.category === category);
}

/**
 * Zero-pad a number to 3 digits for ADR IDs.
 */
function pad3(n: number): string {
  return String(n).padStart(3, '0');
}

/**
 * Extract a concise name from a security boundary string.
 * Takes the first clause (up to first comma, semicolon, or period) and
 * truncates to 60 characters.
 */
function extractBoundaryName(boundary: string): string {
  const clause = boundary.split(/[,;.]/)[0]?.trim() ?? boundary;
  return clause.length > 60 ? clause.slice(0, 57) + '...' : clause;
}

/**
 * Check whether a dossier item's text matches any of the provided keywords.
 */
function itemMatchesKeywords(item: DossierItem, keywords: readonly string[]): boolean {
  const lower = (item.content + ' ' + item.title).toLowerCase();
  return keywords.some((kw) => lower.includes(kw.toLowerCase()));
}

/**
 * Render an ADR record to Markdown format.
 */
function renderADRMarkdown(adr: Phase2ADRRecord): string {
  const lines: string[] = [
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
    ...adr.alternatives.map(
      (a) =>
        `- **${a.option}**: ${a.rationale}${a.rejected ? ' *(rejected)*' : ' *(selected)*'}`,
    ),
    '',
    '## Consequences',
    '',
    ...adr.consequences.map((c) => `- [${c.type}] ${c.description}`),
    '',
    '## References',
    '',
    `- SPARC sections: ${adr.sparcSectionRefs.join(', ') || 'none'}`,
    `- Research dossier items: ${adr.researchDossierItemRefs.join(', ') || 'none'}`,
  ];

  if (adr.supersedes) {
    lines.push(`- Supersedes: ${adr.supersedes}`);
  }

  lines.push('');

  return lines.join('\n');
}

// ============================================================================
// Dynamic ADR Builder
// ============================================================================

/**
 * Internal accumulator used while building ADRs. Tracks which dossier item
 * IDs have already been used as the *primary* driver for an ADR so that
 * duplicate ADRs are not generated when two triggers reference the same items.
 */
interface ADRAccumulator {
  adrs: Phase2ADRRecord[];
  coveredDossierIds: Set<string>;
  date: string;
}

/**
 * Check if a set of candidate dossier IDs is already fully covered by
 * previously generated ADRs. If so, merge the refs into the last ADR that
 * shares the most overlap and return true. Otherwise return false.
 */
function tryMergeIntoExisting(
  acc: ADRAccumulator,
  candidateIds: string[],
  extraSparcRefs: string[],
): boolean {
  if (candidateIds.length === 0) return false;
  const candidateSet = new Set(candidateIds);
  const uncovered = candidateIds.filter((id) => !acc.coveredDossierIds.has(id));
  // If every candidate is already covered, merge into best-matching existing ADR
  if (uncovered.length === 0) {
    let bestIdx = -1;
    let bestOverlap = 0;
    for (let i = 0; i < acc.adrs.length; i++) {
      const overlap = acc.adrs[i]!.researchDossierItemRefs.filter((r) => candidateSet.has(r)).length;
      if (overlap > bestOverlap) {
        bestOverlap = overlap;
        bestIdx = i;
      }
    }
    if (bestIdx >= 0) {
      const existing = acc.adrs[bestIdx]!;
      const mergedDossierRefs = Array.from(new Set([...existing.researchDossierItemRefs, ...candidateIds]));
      const mergedSparcRefs = Array.from(new Set([...existing.sparcSectionRefs, ...extraSparcRefs]));
      acc.adrs[bestIdx] = { ...existing, researchDossierItemRefs: mergedDossierRefs, sparcSectionRefs: mergedSparcRefs };
    }
    return true;
  }
  return false;
}

/**
 * Mark dossier IDs as covered in the accumulator.
 */
function markCovered(acc: ADRAccumulator, ids: string[]): void {
  for (const id of ids) {
    acc.coveredDossierIds.add(id);
  }
}

/**
 * Create the next ADR ID based on current accumulator length.
 */
function nextId(acc: ADRAccumulator): string {
  return `ADR-P2-${pad3(acc.adrs.length + 1)}`;
}

// ---- Trigger 1: Service Boundary ADRs ----

function generateServiceBoundaryADRs(
  sparc: Phase2SPARCOutput,
  dossier: ResearchDossier,
  acc: ADRAccumulator,
): void {
  for (const service of sparc.architecture.services) {
    const dossierRefs = service.dossierItemRefs.length > 0
      ? service.dossierItemRefs
      : findDossierRefs(dossier, [service.name, service.responsibility]);

    const adr: Phase2ADRRecord = {
      id: nextId(acc),
      title: `Service Boundary: ${service.name}`,
      status: 'accepted',
      date: acc.date,
      context:
        `The SPARC architecture identified ${service.name} as a distinct service responsible for: ${service.responsibility}. ` +
        `This decision affects ${dossierRefs.length} dossier item${dossierRefs.length !== 1 ? 's' : ''}.`,
      decision:
        `Establish ${service.name} as an independently deployable service with API: [${service.api.join(', ')}]. ` +
        `Dependencies: [${service.dependencies.join(', ')}].`,
      alternatives: [
        {
          option: `Dedicated ${service.name} service`,
          rationale: 'Clear bounded context with defined API contract',
          rejected: false,
        },
        {
          option: 'Merge into monolith',
          rationale: 'Simpler deployment but violates bounded context principle',
          rejected: true,
        },
        {
          option: 'Serverless functions',
          rationale: 'Lower operational overhead but harder to test and debug at scale',
          rejected: true,
        },
      ],
      consequences: [
        { description: 'Clear service boundary enables independent scaling and deployment', type: 'positive' },
        { description: 'Inter-service communication adds latency and complexity', type: 'negative' },
        { description: 'Team can be organized around service ownership', type: 'neutral' },
      ],
      sparcSectionRefs: [service.id],
      researchDossierItemRefs: dossierRefs,
    };

    acc.adrs.push(adr);
    markCovered(acc, dossierRefs);
  }
}

// ---- Trigger 2: Security Boundary ADRs ----

function generateSecurityBoundaryADRs(
  sparc: Phase2SPARCOutput,
  dossier: ResearchDossier,
  acc: ADRAccumulator,
): void {
  for (const boundary of sparc.architecture.securityBoundaries) {
    const boundaryName = extractBoundaryName(boundary);
    const dossierRefs = findDossierRefs(dossier, [...SECURITY_KEYWORDS, boundaryName], 'risk');
    const sparcRefs: string[] = [];

    // Add security considerations from refinement
    for (const sc of sparc.refinement.securityConsiderations) {
      sparcRefs.push(sc.id);
    }
    // Add services whose names relate to security
    for (const svc of sparc.architecture.services) {
      if (SECURITY_KEYWORDS.some((kw) => svc.name.toLowerCase().includes(kw)) ||
          SECURITY_KEYWORDS.some((kw) => svc.responsibility.toLowerCase().includes(kw))) {
        sparcRefs.push(svc.id);
      }
    }

    if (tryMergeIntoExisting(acc, dossierRefs, sparcRefs)) continue;

    const adr: Phase2ADRRecord = {
      id: nextId(acc),
      title: `Security Posture: ${boundaryName}`,
      status: 'accepted',
      date: acc.date,
      context:
        `The SPARC architecture defines a security boundary: "${boundary}". ` +
        `${dossierRefs.length} risk dossier item${dossierRefs.length !== 1 ? 's' : ''} relate to this boundary.`,
      decision:
        `Enforce security boundary "${boundaryName}" using defense-in-depth controls: ` +
        'authentication at ingress, authorization at service boundaries, and encryption at rest and in transit.',
      alternatives: [
        {
          option: 'Defense-in-depth enforcement at boundary',
          rationale: 'Layered security controls reduce blast radius of a breach',
          rejected: false,
        },
        {
          option: 'Perimeter-only security',
          rationale: 'Simpler but single point of failure; internal traffic is unprotected',
          rejected: true,
        },
        {
          option: 'Full zero-trust on every call',
          rationale: 'Maximum security but significant latency and operational complexity overhead',
          rejected: true,
        },
      ],
      consequences: [
        { description: 'Compromise of one service does not automatically grant access to others', type: 'positive' },
        { description: 'Additional latency from per-boundary authentication and authorization checks', type: 'negative' },
        { description: 'Security posture must be reviewed as new services are added', type: 'neutral' },
      ],
      sparcSectionRefs: Array.from(new Set(sparcRefs)),
      researchDossierItemRefs: dossierRefs,
    };

    acc.adrs.push(adr);
    markCovered(acc, dossierRefs);
  }
}

// ---- Trigger 3: High-Severity Risk ADRs ----

function generateHighSeverityRiskADRs(
  sparc: Phase2SPARCOutput,
  dossier: ResearchDossier,
  acc: ADRAccumulator,
): void {
  const highRiskItems = findDossierRefsByCategory(dossier, 'risk')
    .filter((item) => item.severity === 'high');

  for (const riskItem of highRiskItems) {
    // Skip if this risk item is already covered as a primary ref
    if (acc.coveredDossierIds.has(riskItem.id)) continue;

    // Find related constraint items
    const relatedConstraintIds = findDossierRefs(
      dossier,
      riskItem.title.split(/\s+/).filter((w) => w.length > 3),
      'constraint',
    );

    const dossierRefs = Array.from(new Set([riskItem.id, ...relatedConstraintIds]));

    // Find SPARC services that reference this risk item
    const sparcRefs: string[] = [];
    for (const svc of sparc.architecture.services) {
      if (svc.dossierItemRefs.includes(riskItem.id)) {
        sparcRefs.push(svc.id);
      }
    }

    if (tryMergeIntoExisting(acc, dossierRefs, sparcRefs)) continue;

    // Derive mitigation from risk content
    const mitigationSuffix = riskItem.content.length > 200
      ? riskItem.content.slice(0, 197) + '...'
      : riskItem.content;

    const adr: Phase2ADRRecord = {
      id: nextId(acc),
      title: `Risk Mitigation: ${riskItem.title}`,
      status: 'accepted',
      date: acc.date,
      context:
        `A high-severity risk has been identified: "${riskItem.title}". ` +
        `Detail: ${mitigationSuffix}`,
      decision:
        `Mitigate "${riskItem.title}" through proactive architectural controls: ` +
        'implement monitoring, automated alerting, and fallback mechanisms to reduce impact.',
      alternatives: [
        {
          option: 'Proactive architectural mitigation',
          rationale: 'Addresses risk at the design level before it materializes',
          rejected: false,
        },
        {
          option: 'Accept risk with monitoring only',
          rationale: 'Lower cost but reactive; damage may occur before detection',
          rejected: true,
        },
        {
          option: 'Transfer risk via third-party service',
          rationale: 'Shifts responsibility but introduces external dependency and potential vendor lock-in',
          rejected: true,
        },
      ],
      consequences: [
        { description: `Reduces likelihood and impact of "${riskItem.title}"`, type: 'positive' },
        { description: 'Mitigation controls add implementation and maintenance cost', type: 'negative' },
        { description: 'Risk must be re-assessed periodically as the system evolves', type: 'neutral' },
      ],
      sparcSectionRefs: sparcRefs,
      researchDossierItemRefs: dossierRefs,
    };

    acc.adrs.push(adr);
    markCovered(acc, dossierRefs);
  }
}

// ---- Trigger 4: Inter-Service Communication ADR ----

function generateInterServiceCommunicationADR(
  sparc: Phase2SPARCOutput,
  dossier: ResearchDossier,
  acc: ADRAccumulator,
): void {
  if (sparc.architecture.services.length <= 1) return;

  const serviceCount = sparc.architecture.services.length;
  const contracts = sparc.architecture.apiContracts;
  const allServiceIds = sparc.architecture.services.map((s) => s.id);

  const commKeywords = ['integration', 'communication', 'messaging', 'event', 'api', 'rest', 'grpc', 'queue'];
  const dossierRefs = findDossierRefs(dossier, commKeywords, 'constraint');
  const reqRefs = findDossierRefs(dossier, commKeywords, 'requirement');
  const allDossierRefs = Array.from(new Set([...dossierRefs, ...reqRefs]));

  if (tryMergeIntoExisting(acc, allDossierRefs, allServiceIds)) return;

  const adr: Phase2ADRRecord = {
    id: nextId(acc),
    title: 'Inter-Service Communication Pattern',
    status: 'accepted',
    date: acc.date,
    context:
      `${serviceCount} services need to communicate. ` +
      `API contracts: ${contracts.length > 0 ? contracts.join('; ') : 'to be defined'}. ` +
      `${allDossierRefs.length} dossier item${allDossierRefs.length !== 1 ? 's' : ''} reference integration or communication concerns.`,
    decision:
      'Adopt a hybrid communication strategy: synchronous REST/gRPC for query paths requiring immediate responses, ' +
      'and asynchronous event-driven messaging for commands and domain events that tolerate eventual consistency.',
    alternatives: [
      {
        option: 'Hybrid sync + async communication',
        rationale: 'Balances latency requirements with decoupling benefits',
        rejected: false,
      },
      {
        option: 'Synchronous REST only',
        rationale: 'Simple but creates tight temporal coupling between services',
        rejected: true,
      },
      {
        option: 'Event sourcing for all communication',
        rationale: 'Maximum decoupling but adds complexity for simple request/response patterns',
        rejected: true,
      },
    ],
    consequences: [
      { description: 'Services are decoupled for event-driven flows, reducing cascade failure risk', type: 'positive' },
      { description: 'Two communication paradigms increase developer cognitive load', type: 'negative' },
      { description: 'Contract testing is required for both sync and async interfaces', type: 'neutral' },
    ],
    sparcSectionRefs: allServiceIds,
    researchDossierItemRefs: allDossierRefs,
  };

  acc.adrs.push(adr);
  markCovered(acc, allDossierRefs);
}

// ---- Trigger 5: Performance Target ADRs ----

function generatePerformanceTargetADRs(
  sparc: Phase2SPARCOutput,
  _dossier: ResearchDossier,
  acc: ADRAccumulator,
): void {
  for (const target of sparc.refinement.performanceTargets) {
    const dossierRefs = target.dossierItemRefs;

    if (tryMergeIntoExisting(acc, dossierRefs, [target.id])) continue;

    const titleText = target.text.length > 60
      ? target.text.slice(0, 57) + '...'
      : target.text;

    const adr: Phase2ADRRecord = {
      id: nextId(acc),
      title: `Performance Architecture: ${titleText}`,
      status: 'accepted',
      date: acc.date,
      context:
        `A performance target has been defined: "${target.text}". ` +
        `${dossierRefs.length} dossier item${dossierRefs.length !== 1 ? 's' : ''} constrain this target.`,
      decision:
        `Meet the performance target "${titleText}" through a combination of ` +
        'caching at read-heavy paths, connection pooling, and horizontal scaling with load balancing.',
      alternatives: [
        {
          option: 'Caching + horizontal scaling',
          rationale: 'Proven approach that addresses both throughput and latency requirements',
          rejected: false,
        },
        {
          option: 'Vertical scaling only',
          rationale: 'Simpler but has a hard ceiling and creates single point of failure',
          rejected: true,
        },
        {
          option: 'Pre-computation / materialized views',
          rationale: 'Excellent read performance but increases storage cost and write complexity',
          rejected: true,
        },
      ],
      consequences: [
        { description: 'System can meet defined performance target under expected load', type: 'positive' },
        { description: 'Caching introduces eventual consistency for cached data', type: 'negative' },
        { description: 'Performance baselines must be established and monitored continuously', type: 'neutral' },
      ],
      sparcSectionRefs: [target.id],
      researchDossierItemRefs: dossierRefs,
    };

    acc.adrs.push(adr);
    markCovered(acc, dossierRefs);
  }
}

// ---- Trigger 6: Compliance ADR ----

function generateComplianceADR(
  sparc: Phase2SPARCOutput,
  dossier: ResearchDossier,
  acc: ADRAccumulator,
): void {
  const complianceConstraints = findDossierRefsByCategory(dossier, 'constraint')
    .filter((item) => itemMatchesKeywords(item, COMPLIANCE_KEYWORDS));

  if (complianceConstraints.length === 0) return;

  const dossierRefs = complianceConstraints.map((item) => item.id);

  // Also include risk items that reference compliance
  const complianceRiskRefs = findDossierRefs(dossier, [...COMPLIANCE_KEYWORDS], 'risk');
  const allDossierRefs = Array.from(new Set([...dossierRefs, ...complianceRiskRefs]));

  if (tryMergeIntoExisting(acc, allDossierRefs, [])) return;

  // Find governance-related services
  const govKeywords = ['governance', 'audit', 'compliance', 'policy', 'reporting'];
  const sparcRefs: string[] = [];
  for (const svc of sparc.architecture.services) {
    if (govKeywords.some((kw) =>
      svc.name.toLowerCase().includes(kw) || svc.responsibility.toLowerCase().includes(kw))) {
      sparcRefs.push(svc.id);
    }
  }

  const constraintSummary = complianceConstraints
    .map((c) => c.title)
    .join('; ');

  const adr: Phase2ADRRecord = {
    id: nextId(acc),
    title: 'Compliance Architecture',
    status: 'accepted',
    date: acc.date,
    context:
      `${complianceConstraints.length} dossier constraint${complianceConstraints.length !== 1 ? 's' : ''} reference ` +
      `regulatory or compliance requirements: ${constraintSummary}.`,
    decision:
      'Implement compliance enforcement through immutable audit trails, automated policy checks, ' +
      'and data residency controls. All state-changing operations emit compliance events for audit purposes.',
    alternatives: [
      {
        option: 'Built-in compliance enforcement with audit trails',
        rationale: 'Provides continuous compliance verification and audit readiness',
        rejected: false,
      },
      {
        option: 'Manual compliance audits',
        rationale: 'Lower initial cost but does not scale and risks gaps between audits',
        rejected: true,
      },
      {
        option: 'Third-party compliance SaaS',
        rationale: 'Feature-rich but introduces data residency concerns and external dependency',
        rejected: true,
      },
    ],
    consequences: [
      { description: 'System maintains continuous compliance posture with verifiable audit trails', type: 'positive' },
      { description: 'Compliance infrastructure adds development and operational overhead', type: 'negative' },
      { description: 'Compliance rules must be updated as regulations evolve', type: 'neutral' },
    ],
    sparcSectionRefs: sparcRefs,
    researchDossierItemRefs: allDossierRefs,
  };

  acc.adrs.push(adr);
  markCovered(acc, allDossierRefs);
}

// ---- Trigger 7: Data Persistence Strategy ADR ----

function generateDataPersistenceADR(
  sparc: Phase2SPARCOutput,
  dossier: ResearchDossier,
  acc: ADRAccumulator,
): void {
  const dataServices = sparc.architecture.services.filter((svc) =>
    DATA_KEYWORDS.some((kw) => svc.name.toLowerCase().includes(kw) ||
      svc.responsibility.toLowerCase().includes(kw)));

  if (dataServices.length === 0) return;

  const sparcRefs = dataServices.map((svc) => svc.id);
  const dataDossierRefs = findDossierRefs(dossier, [...DATA_KEYWORDS]);
  const serviceDossierRefs = dataServices.flatMap((svc) => svc.dossierItemRefs);
  const allDossierRefs = Array.from(new Set([...dataDossierRefs, ...serviceDossierRefs]));

  if (tryMergeIntoExisting(acc, allDossierRefs, sparcRefs)) return;

  const serviceNames = dataServices.map((svc) => svc.name).join(', ');

  const adr: Phase2ADRRecord = {
    id: nextId(acc),
    title: 'Data Storage Strategy',
    status: 'accepted',
    date: acc.date,
    context:
      `The following service${dataServices.length !== 1 ? 's' : ''} handle data persistence: ${serviceNames}. ` +
      `${allDossierRefs.length} dossier item${allDossierRefs.length !== 1 ? 's' : ''} relate to data storage or persistence concerns.`,
    decision:
      'Adopt a polyglot persistence strategy: relational storage for transactional data requiring ACID guarantees, ' +
      'document storage for semi-structured domain objects, and a caching layer for frequently accessed read paths. ' +
      'Each service owns its data store to preserve bounded context independence.',
    alternatives: [
      {
        option: 'Polyglot persistence with per-service data ownership',
        rationale: 'Each service uses the storage engine best suited to its access patterns',
        rejected: false,
      },
      {
        option: 'Single relational database for all services',
        rationale: 'Simpler operations but creates a shared data coupling between services',
        rejected: true,
      },
      {
        option: 'NoSQL-only approach',
        rationale: 'Flexible schema but sacrifices ACID transactions for data requiring strong consistency',
        rejected: true,
      },
    ],
    consequences: [
      { description: 'Each service can choose the optimal storage engine for its workload', type: 'positive' },
      { description: 'Multiple storage technologies increase operational complexity', type: 'negative' },
      { description: 'Cross-service queries require explicit data integration patterns', type: 'neutral' },
    ],
    sparcSectionRefs: sparcRefs,
    researchDossierItemRefs: allDossierRefs,
  };

  acc.adrs.push(adr);
  markCovered(acc, allDossierRefs);
}

// ============================================================================
// Public: Pure Builder
// ============================================================================

/**
 * Pure function that dynamically builds ADR records from SPARC output and the
 * research dossier. The number and content of ADRs depends on what the SPARC
 * analysis actually produced: one ADR per service, per security boundary, per
 * high-severity risk, plus conditional ADRs for inter-service communication,
 * performance targets, compliance, and data persistence.
 *
 * No side effects (no file I/O, no telemetry). Exported for unit testing.
 *
 * @param sparc   - The SPARC output from Stage 3
 * @param dossier - The research dossier from Stage 2
 * @returns Array of Phase2ADRRecord objects (length depends on SPARC content)
 */
export function buildPhase2ADRs(
  sparc: Phase2SPARCOutput,
  dossier: ResearchDossier,
): Phase2ADRRecord[] {
  const acc: ADRAccumulator = {
    adrs: [],
    coveredDossierIds: new Set(),
    date: dossier.generatedFrom,
  };

  // Trigger order determines sort order:
  // 1. Service boundary ADRs (sorted by service ID naturally)
  generateServiceBoundaryADRs(sparc, dossier, acc);

  // 2. Security boundary ADRs
  generateSecurityBoundaryADRs(sparc, dossier, acc);

  // 3. High-severity risk ADRs (not already covered by security)
  generateHighSeverityRiskADRs(sparc, dossier, acc);

  // 4. Inter-service communication (if >1 service)
  generateInterServiceCommunicationADR(sparc, dossier, acc);

  // 5. Performance target ADRs
  generatePerformanceTargetADRs(sparc, dossier, acc);

  // 6. Compliance ADR (if regulatory constraints exist)
  generateComplianceADR(sparc, dossier, acc);

  // 7. Data persistence ADR (if data-related services exist)
  generateDataPersistenceADR(sparc, dossier, acc);

  // Re-number all ADRs sequentially to ensure clean IDs after any merges
  return acc.adrs.map((adr, index) => ({
    ...adr,
    id: `ADR-P2-${pad3(index + 1)}`,
  }));
}

// ============================================================================
// Public: Main Stage Function
// ============================================================================

/**
 * Stage 4 entry point: generate Architecture Decision Records from the SPARC
 * output and research dossier stored on the pipeline context.
 *
 * Writes Markdown files and a JSON index to `context.phase2Dir/adrs/`.
 *
 * @param context - The Phase 2 pipeline context
 * @returns Stage output describing success or failure
 */
export async function generateADRs(
  context: Phase2Context,
): Promise<Phase2StageOutput> {
  const rootSpan = createSpan('adr-generation', 'generate-adrs', {
    phase2Dir: context.phase2Dir,
  });

  try {
    // Retrieve the SPARC output from the previous stage
    const sparcStage = context.stageOutputs.get('sparc-specification');
    if (!sparcStage || sparcStage.status !== 'completed') {
      throw new Error(
        'ECLI-P2-020: SPARC output not available on context. ' +
        'Ensure the sparc-specification stage completed successfully before running adr-generation.',
      );
    }
    const sparc = sparcStage.data as Phase2SPARCOutput;

    // Retrieve the research dossier
    const dossierStage = context.stageOutputs.get('research-dossier');
    if (!dossierStage || dossierStage.status !== 'completed') {
      throw new Error(
        'ECLI-P2-020: Research dossier not available on context. ' +
        'Ensure the research-dossier stage completed successfully before running adr-generation.',
      );
    }
    const dossier = dossierStage.data as ResearchDossier;

    // Build the ADRs (pure, deterministic)
    const buildSpan = createSpan(
      'adr-generation',
      'build-adrs',
      { dossierItems: dossier.items.length },
      rootSpan.spanId,
    );

    const adrs = buildPhase2ADRs(sparc, dossier);

    endSpan(buildSpan, 'ok', { adrCount: adrs.length });
    emitSpan(buildSpan);

    // Write files to disk
    const writeSpan = createSpan(
      'adr-generation',
      'write-files',
      {},
      rootSpan.spanId,
    );

    const adrDir = path.join(context.phase2Dir, ADR_SUBDIR);
    fs.mkdirSync(adrDir, { recursive: true, mode: DIR_MODE });

    const writtenPaths: string[] = [];

    for (const adr of adrs) {
      const slug = slugify(adr.title);
      const filename = `${adr.id}-${slug}.md`;
      const filePath = path.join(adrDir, filename);

      try {
        const markdown = renderADRMarkdown(adr);
        fs.writeFileSync(filePath, markdown, { encoding: 'utf-8', mode: FILE_MODE });
        writtenPaths.push(filePath);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(
          `ECLI-P2-021: Failed to write ADR file ${filename}: ${message}`,
        );
      }
    }

    // Write JSON index
    const indexPath = path.join(adrDir, 'adr-index.json');
    try {
      fs.writeFileSync(
        indexPath,
        JSON.stringify(adrs, null, 2) + '\n',
        { encoding: 'utf-8', mode: FILE_MODE },
      );
      writtenPaths.push(indexPath);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(
        `ECLI-P2-021: Failed to write ADR index: ${message}`,
      );
    }

    endSpan(writeSpan, 'ok', { filesWritten: writtenPaths.length });
    emitSpan(writeSpan);

    endSpan(rootSpan, 'ok', {
      adrCount: adrs.length,
      totalArtifacts: writtenPaths.length,
    });
    emitSpan(rootSpan);

    const timing = rootSpan.durationMs ?? 0;

    const output: Phase2StageOutput = {
      stage: 'adr-generation',
      status: 'completed',
      data: adrs,
      artifacts: writtenPaths,
      timing,
      summary:
        `Generated ${adrs.length} Architecture Decision Records ` +
        `(${writtenPaths.length - 1} markdown files + 1 JSON index) in ${timing}ms`,
    };

    context.stageOutputs.set('adr-generation', output);
    return output;
  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : String(err);

    endSpan(rootSpan, 'error', { error: errorMessage });
    emitSpan(rootSpan);

    const timing = rootSpan.durationMs ?? 0;

    const output: Phase2StageOutput = {
      stage: 'adr-generation',
      status: 'failed',
      data: { error: errorMessage },
      artifacts: [],
      timing,
      summary: `ADR generation failed: ${errorMessage}`,
    };

    context.stageOutputs.set('adr-generation', output);
    return output;
  }
}
