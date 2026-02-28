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
// Pseudocode Builder
// ============================================================================

function buildPseudocode(dossier: ResearchDossier): Phase2Pseudocode {
  // Group dossier items that are requirements/recommendations by source
  const sourceGroups = new Map<string, typeof dossier.items>();

  for (const item of dossier.items) {
    if (item.category === 'requirement' || item.category === 'recommendation') {
      const existing = sourceGroups.get(item.source) ?? [];
      existing.push(item);
      sourceGroups.set(item.source, existing);
    }
  }

  const modules: Phase2PseudocodeModule[] = [];
  let modIdx = 1;

  // Deterministic iteration: sort source keys
  const sortedSources = Array.from(sourceGroups.keys()).sort();

  for (const source of sortedSources) {
    const items = sourceGroups.get(source)!;
    const sourceName = source
      .split('-')
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ');

    const moduleName =
      source === 'risk-assessment'
        ? 'Risk Mitigation Module'
        : source === 'scenario'
          ? 'Scenario Requirements Module'
          : `${sourceName} Module`;

    // Generate algorithm descriptions from ALL items (no cap)
    const algorithms: string[] = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i]!;
      algorithms.push(
        `// STEP ${i + 1}: ${item.title}\n` +
        `//   Input: ${item.source} data → ${slugify(item.title)} processing context\n` +
        `//   Process: ${item.content}\n` +
        `//   Output: Validated ${slugify(item.title)} result with traceability ref ${item.id}\n` +
        `//   Error handling: If validation fails, emit diagnostic event and propagate error upstream`,
      );
    }
    // Cross-module integration step
    algorithms.push(
      `// STEP ${algorithms.length + 1}: Cross-module integration\n` +
      `//   Aggregate outputs from all previous steps into ${moduleName} result\n` +
      `//   Verify inter-module consistency and referential integrity across ${items.length} items\n` +
      `//   Emit ${moduleName} completion event with full audit trail`,
    );

    // Generate TDD anchors for ALL items (no cap)
    const tddAnchors: string[] = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i]!;
      tddAnchors.push(
        `TEST [${item.id}]: Given valid ${item.source} input for "${item.title}", ` +
        `verify processing produces correct output. Assertion: ${item.content}`,
      );
    }
    // Boundary and integration test anchors
    tddAnchors.push(`TEST [boundary]: ${moduleName} rejects malformed input with descriptive error containing source context`);
    tddAnchors.push(`TEST [empty]: ${moduleName} handles empty dataset gracefully and returns valid empty result`);
    tddAnchors.push(`TEST [integrity]: ${moduleName} maintains referential integrity across all ${items.length} dossier item refs`);

    // Generate data structure descriptions for each item
    const dataStructures: string[] = [
      `${moduleName}Input: { items: Array<${camelCase(source)}DataItem>, metadata: { source: '${source}', itemCount: number, traceId: string } }`,
      `${moduleName}Result: { outputs: Array<ProcessedResult>, auditTrail: AuditEntry[], dossierRefs: string[], timing_ms: number }`,
    ];
    for (const item of items) {
      const valueType = item.content.includes('score') || item.content.includes('metric') || item.content.includes('latency') || item.content.includes('threshold') ? 'number' : 'string';
      dataStructures.push(
        `${camelCase(item.title)}Schema: { id: string, value: ${valueType}, validated: boolean, dossierRef: '${item.id}', source: '${item.source}' }`,
      );
    }

    modules.push({
      id: `PC-MOD-${pad3(modIdx)}`,
      name: moduleName,
      algorithms,
      tddAnchors,
      dataStructures,
      dossierItemRefs: items.map((it) => it.id),
    });
    modIdx++;
  }

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
  // 2. Roadmap-phase services: one per roadmap phase
  // --------------------------------------------------------------------------
  const phases = artifacts.roadmap.phases ?? [];
  // Sort by original index (already ordered, but explicit for clarity)
  const sortedPhases = phases.map((p, i) => ({ phase: p, index: i }));

  for (const { phase } of sortedPhases) {
    const name = slugify(phase.name) + '-service';
    const deliverables = phase.deliverables ?? [];
    const responsibility = deliverables.length > 0
      ? deliverables.join(', ')
      : `Implementation phase: ${phase.name}`;
    const api = deliverables.map((d) => `${camelCase(d)}()`);
    // Pad to at least one API method
    if (api.length === 0) {
      api.push(`execute${camelCase(phase.name)}()`);
    }
    const dependencies = (phase.dependencies ?? []).map((dep) => slugify(dep) + '-service');

    const svc: Phase2ServiceDefinition = {
      id: nextSvcId(),
      name,
      responsibility,
      api,
      dependencies,
      dossierItemRefs: computeDossierRefs(name, responsibility, dossier),
    };
    services.push(svc);
    serviceByName.set(svc.name, svc);
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
      // extract from title — use text before colon, or first 4 words for a clean slug
      const titlePart = item.title.includes(':')
        ? item.title.split(':')[0]!
        : item.title.split(/\s+/).slice(0, 4).join(' ');
      let category = item.phase ?? slugify(titlePart);
      category = slugify(category);

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
  const pseudocode = buildPseudocode(dossier);
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
