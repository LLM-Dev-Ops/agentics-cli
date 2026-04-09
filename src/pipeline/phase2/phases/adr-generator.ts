/**
 * Phase 2 Pipeline -- Stage 4: ADR Generator
 *
 * Generates Architecture Decision Records as markdown documents driven by
 * the SPARC specification and research dossier. ADRs are derived from actual
 * architectural decisions implied by the SPARC output.
 *
 * Primary output: ADR markdown files (one per decision)
 * Compat output: adr-index.json for downstream consumers
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import type {
  Phase2Context,
  Phase2StageOutput,
  Phase2SPARCOutput,
  Phase2ADRRecord,
  Phase2ADRAlternative,
  Phase2ADRConsequence,
  Phase2ServiceDefinition,
  ResearchDossier,
} from '../types.js';
import { createSpan, endSpan, emitSpan } from '../telemetry.js';
import { detectTechnologyStack, writeTechStack, formatERPContextForPrompt } from './tech-stack-detector.js';

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const ADR_SUBDIR = 'adrs';

/**
 * Load agentics fleet report from phase2Dir and format for LLM context.
 */
function loadAgenticsFleetContextForADR(phase2Dir: string): string {
  try {
    // Check phase dir first, then .pre-phaseN (written before phase command runs)
    let reportPath = path.join(phase2Dir, 'agentics-agents-report.json');
    if (!fs.existsSync(reportPath)) {
      const prePhaseDir = path.join(path.dirname(phase2Dir), `.pre-${path.basename(phase2Dir)}`);
      reportPath = path.join(prePhaseDir, 'agentics-agents-report.json');
    }
    if (!fs.existsSync(reportPath)) return '';
    const report = JSON.parse(fs.readFileSync(reportPath, 'utf-8')) as {
      results?: Array<{ domain: string; agent: string; role: string; status: number; response: unknown }>;
    };
    if (!report.results || report.results.length === 0) return '';
    const successResults = report.results.filter(r => r.status === 200);
    if (successResults.length === 0) return '';
    const summaries = successResults.slice(0, 12).map(r => {
      const resp = r.response as Record<string, unknown> | undefined;
      const data = resp?.['data'] as Record<string, unknown> | undefined;
      let finding = '';
      if (data) {
        const vals = Object.values(data).filter(v => typeof v === 'string').slice(0, 2);
        finding = vals.map(v => String(v).slice(0, 100)).join('; ');
      }
      return `- [${r.domain}/${r.agent}] ${r.role}: ${finding || 'completed'}`;
    }).join('\n');
    return `\nAGENTICS FLEET ANALYSIS (${successResults.length} agents):\n${summaries}\n`;
  } catch { return ''; }
}

function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function pad3(n: number): string {
  return String(n).padStart(3, '0');
}

function findDossierRefs(dossier: ResearchDossier, keywords: readonly string[]): string[] {
  const refs: string[] = [];
  for (const item of dossier.items) {
    const text = `${item.title} ${item.content}`.toLowerCase();
    if (keywords.some(kw => text.includes(kw.toLowerCase()))) {
      refs.push(item.id);
    }
  }
  return refs;
}

// ============================================================================
// ADR Markdown Renderer
// ============================================================================

function renderADRMarkdown(adr: Phase2ADRRecord): string {
  const lines: string[] = [];
  lines.push(`# ${adr.id}: ${adr.title}`);
  lines.push('');
  lines.push(`**Status:** ${adr.status}`);
  lines.push(`**Date:** ${adr.date}`);
  lines.push('');
  lines.push('## Context');
  lines.push(adr.context);
  lines.push('');
  lines.push('## Decision');
  lines.push(adr.decision);
  lines.push('');

  if (adr.alternatives.length > 0) {
    lines.push('## Alternatives Considered');
    for (const alt of adr.alternatives) {
      const status = alt.rejected ? '(rejected)' : '(selected)';
      lines.push(`- **${alt.option}** ${status}: ${alt.rationale}`);
    }
    lines.push('');
  }

  if (adr.consequences.length > 0) {
    lines.push('## Consequences');
    for (const c of adr.consequences) {
      const icon = c.type === 'positive' ? '+' : c.type === 'negative' ? '-' : '~';
      lines.push(`- [${icon}] ${c.description}`);
    }
    lines.push('');
  }

  if (adr.researchDossierItemRefs.length > 0) {
    lines.push('## References');
    lines.push(`Dossier items: ${adr.researchDossierItemRefs.join(', ')}`);
    lines.push('');
  }

  // ADR-PIPELINE-018: Include simulation lineage when present
  if (adr.simulationId) {
    lines.push('## Lineage');
    lines.push(`Originating simulation: ${adr.simulationId}`);
    lines.push('');
  }

  return lines.join('\n');
}

// ============================================================================
// ADR Builder — derived from SPARC + dossier
// ============================================================================

function makeAlt(option: string, rationale: string, rejected: boolean): Phase2ADRAlternative {
  return { option, rationale, rejected };
}

function makeCons(description: string, type: 'positive' | 'negative' | 'neutral'): Phase2ADRConsequence {
  return { description, type };
}

/**
 * Normalize a loosely-typed SPARC object (e.g. loaded from disk with unknown
 * key shapes) into the arrays that ADR generation needs.
 */
function normalizeSPARCForADR(sparc: Phase2SPARCOutput): {
  services: Phase2ServiceDefinition[];
  securityItems: ReadonlyArray<{ id: string; text: string; dossierItemRefs: string[] }>;
  perfItems: ReadonlyArray<{ id: string; text: string; dossierItemRefs: string[] }>;
  integrationPlan: string;
} {
  // Services: may be on architecture.services or architecture.components or top-level services
  const raw = sparc as unknown as Record<string, unknown>;
  const arch = (raw.architecture ?? {}) as Record<string, unknown>;
  let services: Phase2ServiceDefinition[] = [];

  const candidateServices = arch.services ?? arch.components ?? arch.modules ?? raw.services;
  if (Array.isArray(candidateServices)) {
    services = candidateServices.map((s: Record<string, unknown>, i: number) => ({
      id: String(s.id ?? `SVC-${String(i + 1).padStart(3, '0')}`),
      name: String(s.name ?? s.label ?? `Service${i + 1}`),
      responsibility: String(s.responsibility ?? s.description ?? s.purpose ?? ''),
      api: Array.isArray(s.api) ? s.api.map(String) : Array.isArray(s.endpoints) ? s.endpoints.map(String) : [],
      dependencies: Array.isArray(s.dependencies) ? s.dependencies.map(String) : Array.isArray(s.deps) ? s.deps.map(String) : [],
      dossierItemRefs: Array.isArray(s.dossierItemRefs) ? s.dossierItemRefs.map(String) : [],
    }));
  }

  // Security: may be array of objects or array of strings
  const ref = (raw.refinement ?? {}) as Record<string, unknown>;
  let securityItems: Array<{ id: string; text: string; dossierItemRefs: string[] }> = [];
  const rawSec = ref.securityConsiderations ?? ref.security ?? [];
  if (Array.isArray(rawSec)) {
    securityItems = rawSec.map((item: unknown, i: number) => {
      if (typeof item === 'string') return { id: `sec-${i + 1}`, text: item, dossierItemRefs: [] };
      const obj = item as Record<string, unknown>;
      return { id: String(obj.id ?? `sec-${i + 1}`), text: String(obj.text ?? obj.description ?? obj.name ?? ''), dossierItemRefs: [] };
    });
  }

  // Performance: may be array of objects or array of strings
  let perfItems: Array<{ id: string; text: string; dossierItemRefs: string[] }> = [];
  const rawPerf = ref.performanceTargets ?? ref.performance ?? [];
  if (Array.isArray(rawPerf)) {
    perfItems = rawPerf.map((item: unknown, i: number) => {
      if (typeof item === 'string') return { id: `perf-${i + 1}`, text: item, dossierItemRefs: [] };
      const obj = item as Record<string, unknown>;
      return { id: String(obj.id ?? `perf-${i + 1}`), text: String(obj.text ?? obj.description ?? obj.target ?? ''), dossierItemRefs: [] };
    });
  }

  const comp = (raw.completion ?? {}) as Record<string, unknown>;
  const integrationPlan = typeof comp.integrationPlan === 'string' ? comp.integrationPlan : '';

  return { services, securityItems, perfItems, integrationPlan };
}

// ============================================================================
// ADR-PIPELINE-016: Domain-Specific Algorithmic Decision Detection
//
// Scans the query text for patterns that indicate non-obvious algorithmic
// design choices. Each detected pattern generates a dedicated ADR so the
// "why" behind scoring algorithms, routing strategies, threshold models,
// estimation approaches, and factor sourcing is captured independently.
// ============================================================================

interface AlgorithmicDecision {
  title: string;
  context: string;
  decision: string;
  alternatives: Phase2ADRAlternative[];
  consequences: Phase2ADRConsequence[];
  keywords: string[];
}

function detectAlgorithmicDecisions(query: string, domain: DomainContext): AlgorithmicDecision[] {
  const decisions: AlgorithmicDecision[] = [];
  const q = query;

  // ── 1. Weighted / Multi-Objective Scoring Algorithm ──
  const hasScoring = /(?:weight|score|rank|multi.?(?:objective|criteria|factor|dimension)|normali[sz]|compar(?:e|ison).*(?:score|rank|metric))/i.test(q);
  const hasCostSpeedEmissions = /(?:cost|speed|emission|carbon|sustainab|environmental)/i.test(q) && /(?:weight|balanc|tradeoff|trade.?off|priori)/i.test(q);
  if (hasScoring || hasCostSpeedEmissions) {
    decisions.push({
      title: `${domain.primary} Scoring Algorithm: weighted multi-objective normalization with configurable dimensions`,
      context: `${domain.primary} requires comparing options across multiple competing dimensions (e.g. cost, speed, emissions). ` +
        `Each dimension operates on a different scale and unit. Stakeholders need to adjust relative importance of dimensions without code changes. ` +
        `The scoring algorithm embeds a non-obvious design choice: how to normalize disparate units into comparable scores.`,
      decision: `Use min-max normalization per dimension to map all values to [0, 100], then apply configurable weights that sum to 1.0. ` +
        `Round only the final composite score, not individual dimension scores (avoids compounding rounding error). ` +
        `Handle edge case where all options have identical values for a dimension (return score 100 for that dimension). ` +
        `Expose weights as configuration, not hardcoded constants, so domain experts can tune without code changes. ` +
        `Include weights used in every output for reproducibility and audit.`,
      alternatives: [
        makeAlt('Min-max normalization with configurable weights', 'Well-established technique; weights are intuitive for domain experts; handles disparate units', false),
        makeAlt('Z-score normalization', 'Better for normally distributed data but weights are less intuitive for business users', true),
        makeAlt('Rank-based scoring', 'Loses magnitude information — a 10x cost difference scores the same as 1.1x', true),
        makeAlt('Hardcoded scoring rules', 'Requires developer for every threshold change; not auditable', true),
      ],
      consequences: [
        makeCons('Domain experts can adjust priorities (cost vs speed vs emissions) without code changes', 'positive'),
        makeCons('Scores are deterministic and reproducible given the same inputs and weights', 'positive'),
        makeCons('Min-max normalization is sensitive to outliers — a single extreme value compresses the rest', 'negative'),
        makeCons('Weight validation (sum to 1.0) must be enforced at both API boundary and adapter level', 'negative'),
      ],
      keywords: ['scoring', 'weight', 'normalization', 'multi-objective', 'ranking'],
    });
  }

  // ── 2. Option Filtering / Selection Strategy ──
  const hasOptionFiltering = /(?:route|routing|modal|intermodal|multi.?modal|transport.*mode|shipping.*mode|freight|upgrade.*option|option.*filter|viab|feasib|eligible|candidate)/i.test(q);
  const hasOptionSplit = /(?:split|distribut|allocat|percentage|ratio|mix|combination|portfolio)/i.test(q)
    && /(?:option|mode|modal|upgrade|investment|scenario)/i.test(q);
  if (hasOptionFiltering || hasOptionSplit) {
    decisions.push({
      title: `${domain.primary} Option Selection: viability filtering with configurable thresholds and option categorization`,
      context: `${domain.primary} involves selecting between multiple options or strategies. ` +
        `Option viability depends on domain-specific constraints (cost, capacity, timing, regulatory requirements). ` +
        `Combined or hybrid options require defining allocation ratios. ` +
        `Viability thresholds embed non-obvious business knowledge and vary by context (region, property type, asset class).`,
      decision: `Filter viable options by domain-specific thresholds (e.g. budget limits, capacity constraints, regulatory requirements). ` +
        `Make all thresholds configurable via environment variables with sensible defaults. ` +
        `For combined strategies, define allocation ratios as configuration (not hardcoded). ` +
        `Generate recommendations only for viable options — do not score options that fail viability checks. ` +
        `Document option characteristics (cost, impact, timeline, constraints) as a typed configuration object.`,
      alternatives: [
        makeAlt('Threshold-based viability filtering with configurable parameters', 'Fast elimination of non-viable options; thresholds tunable per context', false),
        makeAlt('Score all options regardless of viability', 'Wastes computation; produces misleading recommendations for infeasible options', true),
        makeAlt('Hardcoded selection rules', 'Cannot adapt to regional or contextual differences', true),
      ],
      consequences: [
        makeCons('Different deployments can customize thresholds without code changes', 'positive'),
        makeCons('Option allocation ratios are transparent and auditable', 'positive'),
        makeCons('Threshold values require domain expertise to set correctly — wrong defaults produce wrong recommendations', 'negative'),
      ],
      keywords: ['option', 'filter', 'viability', 'threshold', 'selection', 'upgrade', 'candidate'],
    });
  }

  // ── 3. Emissions / Environmental Impact Factor Sourcing ──
  const hasEmissions = /(?:emission|carbon|co2|greenhouse|ghg|sustainab|environmental.*factor|emission.*factor|energy.*efficien|eui|energy.*usage)/i.test(q);
  if (hasEmissions) {
    // Detect the domain type to use appropriate examples
    const isRealEstate = /(?:building|property|propert|real\s*estate|hvac|insulation|lighting|tenant|facility|eui)/i.test(q);
    const emissionsUnit = isRealEstate ? 'kgCO2e/sqft/year per building type and climate zone' : 'gCO2 per unit of activity';
    const emissionsExamples = isRealEstate
      ? 'building type, climate zone, age, HVAC system type, and insulation rating'
      : 'region, equipment type, operational parameters, and fuel source';
    const emissionsFrameworks = isRealEstate
      ? 'ENERGY STAR Portfolio Manager, CRREM, GRESB, EPA eGRID'
      : 'GLEC Framework, EPA, DEFRA, GHG Protocol';

    decisions.push({
      title: `${domain.primary} Impact Factors: sourcing strategy with regional variation and customization`,
      context: `${domain.primary} calculates environmental impact using emissions/energy factors (e.g. ${emissionsUnit}). ` +
        `These factors vary significantly by ${emissionsExamples}. ` +
        `Using global averages produces inaccurate results for specific assets or regions. ` +
        `The sourcing strategy for these factors is a non-obvious design choice with regulatory and reporting implications.`,
      decision: `Provide default impact factors based on established sources (e.g. ${emissionsFrameworks}). ` +
        `Allow per-request override of factors so users can supply asset-specific or audited values. ` +
        `Store the factors used in every calculation output for auditability. ` +
        `Flag when default (benchmark) factors are used vs. user-supplied measured values in the output metadata. ` +
        `Support regional factor profiles as named configurations (e.g. "EU", "North America", "APAC").`,
      alternatives: [
        makeAlt('Configurable factors with defaults from established frameworks', 'Balances accuracy with usability; supports regulatory audit', false),
        makeAlt('Hardcoded global averages only', 'Inaccurate for specific assets; cannot meet regional regulatory requirements', true),
        makeAlt('Real-time factor API integration', 'Adds external dependency and latency; factors change slowly (annually)', true),
      ],
      consequences: [
        makeCons('Calculations are auditable — every output shows which factors were used and their source', 'positive'),
        makeCons('Regional deployments can use jurisdiction-specific factors', 'positive'),
        makeCons('Default factors must be maintained and updated when source frameworks publish new versions', 'negative'),
      ],
      keywords: ['emissions', 'carbon', 'environmental', 'factor', 'sustainability', 'energy', 'EUI'],
    });
  }

  // ── 4. Priority / Constraint Threshold Model ──
  const hasPriority = /(?:sla|service.?level|tolerance|priority|urgency|deadline|lead.?time|delivery.*time|transit.*time|timeline|disruption|impact.*level)/i.test(q);
  const hasThresholds = /(?:threshold|viable|feasib|acceptable|constraint|buffer|slack)/i.test(q);
  if (hasPriority || (hasThresholds && hasOptionFiltering)) {
    const isRealEstate = /(?:building|property|propert|real\s*estate|tenant|facility)/i.test(q);
    const priorityExamples = isRealEstate
      ? 'critical (safety/compliance), high (major efficiency gain), standard (planned improvement), low (cosmetic/minor)'
      : 'express: 0 days tolerance, standard: 1 day, economy: 2 days';
    const constraintType = isRealEstate
      ? 'tenant disruption level, implementation timeline, and budget constraints'
      : 'time constraints and service level requirements';

    decisions.push({
      title: `${domain.primary} Priority Model: constraint-based viability thresholds with configurable levels`,
      context: `${domain.primary} must filter and prioritize options based on ${constraintType}. Different priority levels ` +
        `(e.g. ${priorityExamples}) have different constraint tolerances. ` +
        `The threshold values embed domain knowledge about acceptable tradeoffs per priority class.`,
      decision: `Define priority levels as a typed enum with associated constraint tolerance values. ` +
        `Filter options by checking if estimated impact ≤ acceptable threshold for the given priority. ` +
        `Make tolerance values configurable per priority level via environment variables. ` +
        `When all options are filtered out (no viable options), return an explicit "no viable options" response rather than an empty array or 500 error.`,
      alternatives: [
        makeAlt('Priority-based constraint thresholds with configurable tolerances', 'Intuitive model; domain experts can adjust per-priority tolerances', false),
        makeAlt('Single global threshold', 'Cannot differentiate high-priority from low-priority — one threshold for all', true),
        makeAlt('No priority filtering (rank all options)', 'Returns options that violate constraints; wastes decision-maker time', true),
      ],
      consequences: [
        makeCons('High-priority items never recommend options that violate critical constraints', 'positive'),
        makeCons('Empty-result edge case is handled explicitly, preventing runtime crashes', 'positive'),
        makeCons('Priority-tolerance mapping requires business sign-off; wrong values produce wrong recommendations', 'negative'),
      ],
      keywords: ['priority', 'SLA', 'tolerance', 'threshold', 'constraint', 'disruption', 'timeline'],
    });
  }

  // ── 5. Distance / Cost Estimation Strategy ──
  const hasDistanceEstimation = /(?:distance|haversine|geodesic|great.?circle|route.*length|estimat.*distance)/i.test(q);
  const hasHardcodedData = /(?:hardcode|lookup|table|fallback.*default|unknown.*route|default.*distance)/i.test(q);
  if (hasDistanceEstimation || (hasOptionFiltering && hasHardcodedData)) {
    decisions.push({
      title: `${domain.primary} Distance Estimation: strategy for unknown routes with fallback handling`,
      context: `${domain.primary} needs point-to-point distances for scoring. A lookup table covers known high-volume corridors, ` +
        `but unknown origin-destination pairs fall back to a default value. A naive default (e.g. 5000km) materially affects scoring accuracy — ` +
        `short routes scored as long routes get wrong mode recommendations. The fallback strategy is a critical design choice.`,
      decision: `Use haversine (great-circle) calculation as the primary fallback for unknown routes instead of a fixed default distance. ` +
        `Maintain a lookup table for known high-volume corridors where actual road/rail distances differ significantly from great-circle. ` +
        `Flag outputs that used estimated (non-lookup) distances so decision-makers know the accuracy level. ` +
        `Apply a mode-specific distance multiplier to haversine results (e.g. road: 1.3x, rail: 1.2x, sea: 1.1x) to approximate actual route distances.`,
      alternatives: [
        makeAlt('Haversine fallback with corridor lookup table', 'Reasonable accuracy for unknown routes; exact for known corridors', false),
        makeAlt('Fixed default distance for unknowns', 'Produces materially wrong scores — a 200km route scored as 5000km recommends sea freight', true),
        makeAlt('External routing API (Google Maps, HERE)', 'Adds latency, cost, and external dependency for every comparison', true),
      ],
      consequences: [
        makeCons('Unknown routes get reasonable distance estimates instead of a wildly wrong default', 'positive'),
        makeCons('Output transparency — decision-makers see whether distance was exact or estimated', 'positive'),
        makeCons('Haversine underestimates road distance by ~20-40% for complex terrain; multiplier is an approximation', 'negative'),
      ],
      keywords: ['distance', 'haversine', 'estimation', 'fallback', 'route', 'corridor'],
    });
  }

  // ── 6. Comparison Immutability / Audit Chain ──
  const hasComparison = /(?:compar(?:e|ison)|scenario.*(?:save|store|persist)|immutab|audit.*chain|tamper)/i.test(q);
  const hasAuditTrail = /(?:audit|lineage|hash|reproducib|traceab)/i.test(q);
  if (hasComparison && hasAuditTrail) {
    decisions.push({
      title: `${domain.primary} Scenario Comparison: immutability model with content-hash audit chain`,
      context: `${domain.primary} produces scenario comparisons that inform business decisions. Once a comparison is created, ` +
        `it must not change — decision-makers need to trust that the comparison they approved is the same one that was generated. ` +
        `The immutability model and audit chain design embed governance requirements.`,
      decision: `Scenario comparisons are write-once: created via POST, readable via GET, never updated or deleted. ` +
        `Each comparison includes a content hash (SHA-256 of all inputs + weights + results) for tamper detection. ` +
        `Link each comparison to its originating simulation ID for full lineage tracing. ` +
        `Wrap comparison persistence in a database transaction — if the INSERT fails, the caller gets an error, not a phantom comparison. ` +
        `Add a database index on (shipment_id, created_at) for efficient listing queries.`,
      alternatives: [
        makeAlt('Write-once with content hash and simulation lineage', 'Meets audit and compliance requirements; tamper-detectable', false),
        makeAlt('Mutable comparisons', 'Cannot prove which version was approved — audit gap', true),
        makeAlt('In-memory only comparisons', 'Lost on process restart; no audit trail', true),
      ],
      consequences: [
        makeCons('Every comparison is traceable back to its simulation and forward to any decisions made from it', 'positive'),
        makeCons('Content hash enables tamper detection without blockchain overhead', 'positive'),
        makeCons('Write-once storage grows continuously — requires archival strategy for old comparisons', 'negative'),
      ],
      keywords: ['comparison', 'immutability', 'audit', 'hash', 'lineage', 'tamper'],
    });
  }

  return decisions;
}

function buildADRsFromSPARC(sparc: Phase2SPARCOutput, dossier: ResearchDossier, scenarioQuery?: string): Phase2ADRRecord[] {
  const adrs: Phase2ADRRecord[] = [];
  let idx = 1;
  const today = new Date().toISOString().slice(0, 10);
  const q = scenarioQuery ?? '';

  const { services, securityItems, perfItems, integrationPlan } = normalizeSPARCForADR(sparc);

  // ── Extract domain context from the query ──────────────────────────────
  const domain = extractDomainContext(q);
  const techStack = extractTechFromQuery(q);

  // ======================================================================
  // SPARC §S — Specification: Domain Model ADR
  // What entities exist, how they relate, what invariants constrain them
  // ======================================================================
  if (services.length > 0) {
    const entityNames = services.slice(0, 6).map(s => s.name);
    const depsAll = services.flatMap(s => s.dependencies).filter(Boolean);
    const uniqueDeps = [...new Set(depsAll)];

    adrs.push({
      id: `ADR-P2-${pad3(idx++)}`,
      title: `Domain Model: ${domain.primary} entity graph with ${entityNames.length} bounded contexts`,
      status: 'proposed',
      date: today,
      context: `The ${domain.primary} domain decomposes into ${entityNames.length} bounded contexts: ${entityNames.join(', ')}. ` +
        `${uniqueDeps.length > 0 ? 'Cross-context dependencies: ' + uniqueDeps.slice(0, 5).join(', ') + '. ' : ''}` +
        `${domain.stakeholders ? 'Stakeholders: ' + domain.stakeholders + '. ' : ''}` +
        `Each context must own its data and enforce its own invariants.`,
      decision: `Model ${domain.primary} as ${entityNames.length} bounded contexts with explicit aggregate roots. ` +
        `${entityNames.slice(0, 3).map(n => `"${n}" owns its entities and exposes a domain API`).join('; ')}. ` +
        `Cross-context communication via domain events (not shared database). ` +
        `${domain.erp ? 'Anti-corruption layer translates between ' + domain.erp + ' wire format and domain types.' : ''}`,
      alternatives: [
        makeAlt(`${entityNames.length} bounded contexts with domain events`, 'Each context evolves independently; matches ' + domain.primary + ' organizational structure', false),
        makeAlt('Shared domain model', 'Faster initial development but all contexts coupled — any schema change ripples everywhere', true),
        makeAlt('CRUD-only without domain model', 'Simpler but business rules scattered across layers, untestable', true),
      ],
      consequences: [
        makeCons(`Each ${domain.primary} context can be developed, tested, and deployed independently`, 'positive'),
        makeCons('Domain events provide audit trail of all cross-context interactions', 'positive'),
        makeCons('Requires upfront domain modeling investment before implementation', 'negative'),
        makeCons(`Cross-context queries (e.g. ${entityNames.length > 1 ? entityNames[0] + ' → ' + entityNames[1] : 'aggregation'}) require API composition, not JOINs`, 'negative'),
      ],
      sparcSectionRefs: ['specification.requirements', 'architecture.services'],
      researchDossierItemRefs: findDossierRefs(dossier, entityNames),
    });
  }

  // ======================================================================
  // SPARC §P — Pseudocode: Simulation / Optimization / Core Algorithm ADR
  // HOW the core computation works — not generic, specific to the domain
  // ======================================================================
  const hasSimulation = /simulat|scenario|what.?if|forecast|predict|model(?:ing|ed|s)/i.test(q);
  const hasOptimization = /optimiz|minimize|maximize|tradeoff|trade.?off|pareto|quantif/i.test(q);
  const hasGraphModeling = /graph|network|dependenc|flow|topolog|adjacen/i.test(q);

  if (hasSimulation || hasOptimization || hasGraphModeling) {
    const algoType = hasOptimization ? 'multi-objective optimization'
      : hasGraphModeling ? 'graph-based dependency modeling'
      : 'scenario simulation';

    const rustNote = techStack.includes('Rust')
      ? `Implement the compute-intensive ${algoType} engine in Rust for performance (graph traversal, constraint solving, Monte Carlo). TypeScript orchestrates scenario configuration, result aggregation, and API exposure.`
      : `Implement ${algoType} engine with clear separation between scenario configuration (inputs), computation (engine), and result presentation (outputs).`;

    const simOutputs = hasOptimization
      ? 'Pareto frontier across competing objectives (cost, risk, emissions, complexity). Each point on the frontier is a decision-grade scenario with full traceoff breakdown.'
      : 'Ranked scenario comparison with metrics per dimension. Each scenario includes confidence intervals, sensitivity analysis, and assumption documentation.';

    adrs.push({
      id: `ADR-P2-${pad3(idx++)}`,
      title: `${domain.primary} ${hasOptimization ? 'Optimization' : 'Simulation'} Engine: ${algoType} with immutable inputs/outputs`,
      status: 'proposed',
      date: today,
      context: `The system must ${hasOptimization ? 'optimize across competing objectives' : 'simulate multiple strategies'} for ${domain.primary}. ` +
        `Decision-makers need structured, comparative outputs — not automated execution. ` +
        `${hasGraphModeling ? 'The domain involves network/graph structures with dependencies that affect propagation of changes. ' : ''}` +
        `All simulation inputs must be immutable; results must be reproducible and auditable.`,
      decision: `${rustNote} ` +
        `Simulation accepts immutable scenario parameters, runs computation, and produces: ${simOutputs} ` +
        `Results carry a cryptographic hash of inputs for reproducibility verification. ` +
        `No execution occurs from simulation — results are decision-grade outputs for human review.`,
      alternatives: [
        makeAlt(`Dedicated ${algoType} engine with immutable I/O`, 'Auditable, reproducible, supports regulatory review', false),
        makeAlt('Spreadsheet-based modeling', 'Insufficient for multi-dimensional analysis at enterprise scale', true),
        makeAlt('Auto-executing optimizer', 'Violates human-in-the-loop governance requirement', true),
      ],
      consequences: [
        makeCons('Every simulation result is reproducible — same inputs always produce same outputs', 'positive'),
        makeCons('Stakeholders compare scenarios side-by-side before committing resources', 'positive'),
        makeCons(techStack.includes('Rust') ? 'Requires Rust/TypeScript FFI boundary and dual-language build pipeline' : 'Compute-intensive scenarios may require dedicated infrastructure', 'negative'),
        makeCons('Scenario parameter space must be bounded to prevent combinatorial explosion', 'negative'),
      ],
      sparcSectionRefs: ['pseudocode.modules', 'architecture.dataFlow'],
      researchDossierItemRefs: findDossierRefs(dossier, ['simulation', 'optimization', 'scenario', 'model', 'graph']),
    });
  }

  // ======================================================================
  // SPARC §P+ — Domain-Specific Algorithmic Decision ADRs
  // Detect algorithmic patterns in the query that warrant dedicated ADRs
  // (ADR-PIPELINE-016: each non-obvious design choice gets its own ADR)
  // ======================================================================
  const algorithmPatterns = detectAlgorithmicDecisions(q, domain);
  for (const algo of algorithmPatterns) {
    adrs.push({
      id: `ADR-P2-${pad3(idx++)}`,
      title: algo.title,
      status: 'proposed',
      date: today,
      context: algo.context,
      decision: algo.decision,
      alternatives: algo.alternatives,
      consequences: algo.consequences,
      sparcSectionRefs: ['pseudocode.modules', 'architecture.services'],
      researchDossierItemRefs: findDossierRefs(dossier, algo.keywords),
    });
  }

  // ======================================================================
  // SPARC §A — Architecture: Per-service implementation decisions
  // Each service gets a SPECIFIC decision, not "build as modular service"
  // ======================================================================
  for (const svc of services.slice(0, 6)) {
    // Skip if the service name would duplicate the domain model or simulation ADR
    if (idx > 2 && /domain|model|simul|optim|engine/i.test(svc.name)) continue;

    const depsText = svc.dependencies.length > 0
      ? svc.dependencies.join(', ')
      : '';
    const responsibility = svc.responsibility || svc.name;

    // Determine what KIND of service this is and generate a specific decision
    const isDataIngestion = /ingest|import|extract|collect|read|fetch|sync/i.test(responsibility);
    const isAnalysis = /analy|score|classif|evaluat|assess|rank|compar/i.test(responsibility);
    const isOrchestration = /orchestrat|workflow|pipeline|coordinat|schedul/i.test(responsibility);
    const isPresentation = /report|dashboard|visual|output|present|display|generat.*output/i.test(responsibility);
    const isGovernance = /approv|govern|audit|compliance|lineage|review/i.test(responsibility);

    let specificDecision: string;
    let specificTitle: string;
    let specificAlts: Phase2ADRAlternative[];

    if (isGovernance) {
      specificTitle = `${svc.name}: Human-in-the-loop approval with immutable audit trail`;
      specificDecision = `Implement ${svc.name} as a state machine (draft → submitted → approved/rejected → executed). ` +
        `Every state transition is logged immutably with actor identity, timestamp, and decision rationale. ` +
        `Approval requires authenticated user with appropriate role — no self-approval, no programmatic bypass. ` +
        `${domain.erp ? 'Only APPROVED decisions can trigger ' + domain.erp + ' writeback.' : ''}`;
      specificAlts = [
        makeAlt('State machine with RBAC and immutable log', 'Meets audit and compliance requirements', false),
        makeAlt('Simple boolean approved flag', 'No state history, no role enforcement, no audit trail', true),
        makeAlt('Manual email-based approval', 'No programmatic enforcement, approval can be forged', true),
      ];
    } else if (isDataIngestion) {
      specificTitle = `${svc.name}: ${domain.erp ? domain.erp + ' data ingestion' : 'External data ingestion'} with validation`;
      specificDecision = `${svc.name} ingests data from ${depsText || (domain.erp ?? 'external sources')} through an anti-corruption layer. ` +
        `All incoming records are validated against domain schemas before entering the system. ` +
        `Invalid records are quarantined with error details, not silently dropped. ` +
        `Ingestion is idempotent — re-running the same import produces identical state.`;
      specificAlts = [
        makeAlt('ACL with schema validation and quarantine', 'Protects domain model from external data quality issues', false),
        makeAlt('Direct database import', 'Couples domain model to external schemas — any upstream change breaks the system', true),
      ];
    } else if (isAnalysis) {
      specificTitle = `${svc.name}: Domain-specific ${/score|rank/i.test(responsibility) ? 'scoring' : 'analysis'} with configurable weights`;
      specificDecision = `${svc.name} implements ${responsibility.slice(0, 100)}. ` +
        `Scoring weights and thresholds are externalized as configuration (not hardcoded constants) so domain experts can tune them without code changes. ` +
        `All analysis outputs include the weights used, enabling reproducibility and audit. ` +
        `${depsText ? 'Consumes data from: ' + depsText + '.' : ''}`;
      specificAlts = [
        makeAlt('Configurable analysis with weight transparency', 'Domain experts can tune; results are auditable', false),
        makeAlt('Hardcoded scoring rules', 'Faster initially but requires developer for every threshold change', true),
      ];
    } else if (isOrchestration) {
      specificTitle = `${svc.name}: Workflow orchestration with checkpoint and resume`;
      specificDecision = `${svc.name} coordinates: ${responsibility.slice(0, 120)}. ` +
        `Each workflow step is checkpointed so failures resume from last successful step, not from scratch. ` +
        `Workflow state is persisted (not in-memory) to survive process restarts. ` +
        `${depsText ? 'Orchestrates: ' + depsText + '.' : ''}`;
      specificAlts = [
        makeAlt('Persistent workflow with checkpoints', 'Resilient to failures, supports long-running processes', false),
        makeAlt('In-memory orchestration', 'Process restart loses all workflow state', true),
      ];
    } else if (isPresentation) {
      specificTitle = `${svc.name}: Decision-grade output generation with lineage`;
      specificDecision = `${svc.name} generates structured outputs for ${domain.stakeholders || 'leadership review'}. ` +
        `Every output traces back to the simulation/analysis that produced it (lineage hash). ` +
        `Outputs include: comparative metrics, tradeoff visualization data, confidence indicators, and assumption documentation. ` +
        `${domain.erp ? 'Optionally formats approved outputs for ' + domain.erp + ' writeback.' : ''}`;
      specificAlts = [
        makeAlt('Structured outputs with lineage tracing', 'Decision-makers can verify what analysis produced each recommendation', false),
        makeAlt('Free-form text reports', 'No traceability, no structured comparison', true),
      ];
    } else {
      // Generic but still domain-specific — use the actual responsibility text
      specificTitle = `${svc.name}: ${responsibility.slice(0, 70)}`;
      specificDecision = `Implement ${svc.name} to handle: ${responsibility}. ` +
        `${depsText ? 'Integrates with ' + depsText + ' via typed interfaces (not direct coupling). ' : ''}` +
        `Expose domain operations as a service API. All state mutations produce domain events for downstream consumers. ` +
        `${techStack.includes('Rust') && /comput|optim|graph|simul/i.test(responsibility) ? 'Implement compute-intensive logic in Rust.' : ''}`;
      specificAlts = [
        makeAlt(`Dedicated ${svc.name} service with domain API`, `Encapsulates ${domain.primary} business rules for ${svc.name}`, false),
        makeAlt('Inline in monolith', 'Couples ' + svc.name + ' logic to unrelated concerns', true),
      ];
    }

    adrs.push({
      id: `ADR-P2-${pad3(idx++)}`,
      title: specificTitle,
      status: 'proposed',
      date: today,
      context: `${domain.primary} requires: ${responsibility.slice(0, 200)}. ` +
        `${depsText ? 'Dependencies: ' + depsText + '. ' : ''}` +
        `This service is part of the ${domain.primary} solution.`,
      decision: specificDecision,
      alternatives: specificAlts,
      consequences: [
        makeCons(`${svc.name} business rules are testable in isolation`, 'positive'),
        makeCons(`Clear API contract for ${svc.name} enables parallel team development`, 'positive'),
        makeCons(`Requires explicit interface definition between ${svc.name} and its consumers`, 'negative'),
      ],
      sparcSectionRefs: [`architecture.services.${svc.name}`],
      researchDossierItemRefs: findDossierRefs(dossier, [svc.name, ...svc.dependencies]),
    });
  }

  // ======================================================================
  // SPARC §A — Architecture: ERP Integration ADR (if ERP detected)
  // ======================================================================
  if (domain.erp) {
    adrs.push({
      id: `ADR-P2-${pad3(idx++)}`,
      title: `${domain.erp} Integration: Anti-corruption layer with governance-gated writeback`,
      status: 'proposed',
      date: today,
      context: `${domain.primary} data originates in ${domain.erp}. The AI system reads operational data for analysis/simulation ` +
        `and optionally writes approved decisions back. Direct coupling to ${domain.erp} internals would make the domain model fragile.`,
      decision: `Build an anti-corruption layer (ACL) between ${domain.erp} and the ${domain.primary} domain. ` +
        `The ACL translates ${domain.erp} wire formats into domain types and vice versa. ` +
        `Read mode is the default; writeback is gated behind APPROVED governance status. ` +
        `Circuit breaker + sync queue handle ${domain.erp} outages. ` +
        `All ${domain.erp} operations carry idempotency keys to prevent duplicate writes on retry.`,
      alternatives: [
        makeAlt(`ACL with governance-gated writeback`, `Protects ${domain.erp} integrity; enables AI-assisted decisions without risk`, false),
        makeAlt(`Direct ${domain.erp} API calls from services`, `Tight coupling; ${domain.erp} schema changes break domain model`, true),
        makeAlt('Full data replication to local DB', `Stale data risk; doubles storage cost; compliance concerns with data residency`, true),
      ],
      consequences: [
        makeCons(`${domain.erp} schema changes don't cascade to domain services`, 'positive'),
        makeCons(`Writeback requires human approval — no accidental ${domain.erp} mutations`, 'positive'),
        makeCons(`ACL translation layer must track ${domain.erp} API version changes`, 'negative'),
      ],
      sparcSectionRefs: ['architecture.services'],
      researchDossierItemRefs: findDossierRefs(dossier, [domain.erp.toLowerCase(), 'erp', 'integration']),
    });
  }

  // ======================================================================
  // SPARC §A — Architecture: Data Persistence ADR (technology-specific)
  // ======================================================================
  const databases = techStack.filter(t => /postgres|mysql|bigquery|mongodb|redis|dynamodb|cloud sql/i.test(t));
  const cloudProvider = techStack.find(t => /google cloud|aws|azure|gcp/i.test(t));
  if (databases.length > 0 || cloudProvider) {
    adrs.push({
      id: `ADR-P2-${pad3(idx++)}`,
      title: `Data Persistence: ${[...databases, cloudProvider].filter(Boolean).join(' + ')} for ${domain.primary}`,
      status: 'proposed',
      date: today,
      context: `${domain.primary} data includes: domain entities, ${hasSimulation ? 'simulation results, ' : ''}audit trail, and operational records. ` +
        `User specified: ${techStack.join(', ')}. ` +
        `Audit data must be immutable. Simulation results must be reproducible.`,
      decision: databases.map(db => {
        if (/bigquery/i.test(db)) return `**BigQuery** for analytical queries, historical trend analysis, and reporting aggregations.`;
        if (/postgres/i.test(db)) return `**Cloud SQL (PostgreSQL)** for transactional domain data, audit logs, and governance state. Use row-level security for multi-tenant isolation.`;
        if (/redis/i.test(db)) return `**Redis** for caching frequently-read reference data and session state.`;
        if (/mongodb/i.test(db)) return `**MongoDB** for flexible document storage of simulation configurations and results.`;
        return `**${db}** for persistent domain data.`;
      }).join(' ') +
        (cloudProvider ? ` Deploy on ${cloudProvider} managed services to reduce operational burden.` : ''),
      alternatives: [
        makeAlt(`${databases.join(' + ')} on ${cloudProvider ?? 'managed cloud'}`, 'Matches specified tech stack; managed services reduce ops burden', false),
        makeAlt('Single-database architecture', 'Simpler but cannot optimize for both transactional and analytical workloads', true),
        makeAlt('In-memory only', 'Process restart destroys all data — compliance disqualifier', true),
      ],
      consequences: [
        makeCons('Polyglot persistence optimizes each data access pattern', 'positive'),
        makeCons(`${cloudProvider ?? 'Cloud'} managed services handle backups, scaling, and failover`, 'positive'),
        makeCons('Multiple data stores increase operational complexity and migration effort', 'negative'),
      ],
      sparcSectionRefs: ['architecture.services'],
      researchDossierItemRefs: findDossierRefs(dossier, ['data', 'database', 'storage', 'persistence', ...databases.map(d => d.toLowerCase())]),
    });
  }

  // ======================================================================
  // SPARC §R — Refinement: Security & Compliance ADR
  // ======================================================================
  const secText = itemsToText(securityItems);
  const hasCompliance = /audit|compliance|regulatory|governance|lineage|human.?in.?the.?loop|esg|esg/i.test(q);

  if (secText || hasCompliance) {
    const complianceTerms = (q.match(/audit(?:ability)?|compliance|regulatory|governance|ESG|lineage|human.?in.?the.?loop|GDPR|HIPAA|SOX/gi) ?? []);
    const uniqueTerms = [...new Set(complianceTerms.map(t => t.toLowerCase()))];

    adrs.push({
      id: `ADR-P2-${pad3(idx++)}`,
      title: `Security & Compliance: ${uniqueTerms.slice(0, 3).join(', ') || 'RBAC and audit trail'} for ${domain.primary}`,
      status: 'proposed',
      date: today,
      context: `${domain.primary} decisions affect ${domain.stakeholders || 'operational teams and leadership'}. ` +
        `${secText ? 'Security requirements: ' + secText + '. ' : ''}` +
        `${uniqueTerms.length > 0 ? 'Compliance domains: ' + uniqueTerms.join(', ') + '. ' : ''}` +
        `The system must maintain strict auditability: who decided what, when, and based on which analysis.`,
      decision: `Implement RBAC with domain-specific roles (not just admin/user). ` +
        `Define roles mapped to ${domain.primary} operations: who can run simulations, who can approve decisions, who can trigger ${domain.erp ?? 'ERP'} writeback. ` +
        `All state-changing operations produce immutable audit entries with actor identity, timestamp, and operation details. ` +
        `${hasSimulation ? 'Simulation results are write-once with content hash for tamper detection. ' : ''}` +
        `Human-in-the-loop is mandatory before any changes propagate to operational systems.`,
      alternatives: [
        makeAlt(`RBAC + immutable audit + ${hasSimulation ? 'simulation lineage' : 'operation lineage'}`, 'Meets regulatory requirements; provides full traceability', false),
        makeAlt('Simple API key authentication', 'No role differentiation; anyone with the key can approve decisions', true),
        makeAlt('Audit logging without RBAC', 'Records who did what but cannot prevent unauthorized actions', true),
      ],
      consequences: [
        makeCons(`Full decision traceability for ${uniqueTerms[0] ?? 'regulatory'} compliance`, 'positive'),
        makeCons('No automated execution without human approval', 'positive'),
        makeCons('Role definition and permission matrix must be maintained as organization evolves', 'negative'),
        makeCons('Immutable audit log storage grows continuously — requires archival strategy', 'negative'),
      ],
      sparcSectionRefs: ['refinement.securityConsiderations'],
      researchDossierItemRefs: findDossierRefs(dossier, ['security', 'auth', 'access', 'compliance', 'audit', 'governance']),
    });
  }

  // ======================================================================
  // SPARC §R — Refinement: Performance ADR (if Rust or compute-intensive)
  // ======================================================================
  const perfText = itemsToText(perfItems);
  if (perfText || techStack.includes('Rust')) {
    adrs.push({
      id: `ADR-P2-${pad3(idx++)}`,
      title: `Performance: ${techStack.includes('Rust') ? 'Rust compute engine + TypeScript orchestration' : 'Optimization strategy for ' + domain.primary}`,
      status: 'proposed',
      date: today,
      context: `${perfText ? 'Performance requirements: ' + perfText + '. ' : ''}` +
        `${techStack.includes('Rust') ? 'The user specified Rust for compute-intensive components and TypeScript for orchestration. ' : ''}` +
        `${hasSimulation ? 'Simulation/optimization workloads require bounded execution time for interactive use.' : ''}`,
      decision: `${techStack.includes('Rust') ? 'Split computation: Rust handles graph traversal, constraint solving, and numerical optimization. TypeScript handles API routing, workflow orchestration, and result formatting. Communication via typed JSON over stdin/stdout (subprocess) or FFI (napi-rs). ' : ''}` +
        `All compute operations have configurable timeouts. Results include execution time metadata. ` +
        `${hasSimulation ? 'Simulation parameter space is bounded (max iterations, max graph depth) to prevent runaway computation.' : ''}`,
      alternatives: [
        makeAlt(techStack.includes('Rust') ? 'Rust engine + TypeScript orchestration' : 'Targeted optimization of critical paths', 'Best performance where it matters; orchestration stays in TypeScript for productivity', false),
        makeAlt('Pure TypeScript', techStack.includes('Rust') ? 'Simpler build but 10-100x slower for graph/numeric workloads' : 'Simpler but may not meet latency targets', true),
      ],
      consequences: [
        makeCons(techStack.includes('Rust') ? 'Compute-intensive operations run at native speed' : 'Critical paths are optimized based on profiling data', 'positive'),
        makeCons(techStack.includes('Rust') ? 'Dual-language build pipeline increases CI/CD complexity' : 'Optimization effort must be validated with benchmarks', 'negative'),
      ],
      sparcSectionRefs: ['refinement.performanceTargets'],
      researchDossierItemRefs: findDossierRefs(dossier, ['performance', 'latency', 'throughput', 'rust', 'compute']),
    });
  }

  // ======================================================================
  // SPARC §R — Refinement: High-severity risk ADRs from dossier
  // ======================================================================
  const highRisks = dossier.items.filter(i => i.category === 'risk' && i.severity && /high|critical/i.test(i.severity));
  for (const risk of highRisks.slice(0, 2)) {
    adrs.push({
      id: `ADR-P2-${pad3(idx++)}`,
      title: `Risk Mitigation: ${risk.title.slice(0, 70)}`,
      status: 'proposed',
      date: today,
      context: risk.content,
      decision: `Mitigate "${risk.title}" with: (1) input validation at the service boundary where this risk originates, ` +
        `(2) monitoring and alerting for early detection of the failure mode, ` +
        `(3) graceful degradation path that preserves data integrity when the risk materializes. ` +
        `Document specific controls in the affected service's test suite.`,
      alternatives: [
        makeAlt('Active boundary controls + monitoring + degradation', 'Prevents impact; detects early; degrades gracefully', false),
        makeAlt('Accept risk and monitor', 'Lower effort but reactive — damage occurs before detection', true),
      ],
      consequences: [
        makeCons(`"${risk.title.slice(0, 40)}" mitigated with layered controls`, 'positive'),
        makeCons('Mitigation logic adds complexity to the affected service boundary', 'negative'),
      ],
      sparcSectionRefs: [],
      researchDossierItemRefs: [risk.id],
    });
  }

  // ======================================================================
  // SPARC §C — Completion: Deployment & Integration ADR
  // ======================================================================
  const deployTech = techStack.filter(t => /cloud run|cloud function|lambda|fargate|ecs|kubernetes|k8s|docker/i.test(t));
  if (deployTech.length > 0 || cloudProvider) {
    adrs.push({
      id: `ADR-P2-${pad3(idx++)}`,
      title: `Deployment: ${deployTech.join(' + ') || cloudProvider || 'Cloud'} with environment-based configuration`,
      status: 'proposed',
      date: today,
      context: `${domain.primary} services deploy to ${cloudProvider ?? 'cloud infrastructure'}. ` +
        `${deployTech.length > 0 ? 'Specified: ' + deployTech.join(', ') + '. ' : ''}` +
        `Services must be stateless (state in databases), independently deployable, and environment-configurable.`,
      decision: `Deploy each service as a stateless container on ${deployTech[0] || cloudProvider || 'managed cloud compute'}. ` +
        `All configuration via environment variables (database URLs, API keys, feature flags) — zero hardcoded secrets. ` +
        `Health checks on every service endpoint. Structured JSON logging to cloud logging service. ` +
        `${integrationPlan ? 'Integration plan: ' + integrationPlan.slice(0, 150) + '.' : ''}`,
      alternatives: [
        makeAlt(`${deployTech[0] || 'Serverless'} with env-based config`, 'Matches specified infrastructure; scales automatically', false),
        makeAlt('VM-based deployment', 'More control but higher operational overhead', true),
      ],
      consequences: [
        makeCons('Zero-downtime deployments with rolling updates', 'positive'),
        makeCons('Environment parity (dev/staging/prod) via configuration only', 'positive'),
        makeCons('Cold start latency for serverless (mitigated with min instances)', 'negative'),
      ],
      sparcSectionRefs: ['completion.integrationPlan'],
      researchDossierItemRefs: findDossierRefs(dossier, ['deploy', 'cloud', 'infrastructure', 'container']),
    });
  }

  // Fallback: at least one ADR (should never fire with a real query)
  if (adrs.length === 0) {
    adrs.push({
      id: 'ADR-P2-001',
      title: `${domain.primary} System Architecture`,
      status: 'proposed',
      date: today,
      context: q.slice(0, 500) || 'Initial architecture decision based on SPARC specification.',
      decision: `Build modular ${domain.primary} system with bounded contexts, domain events, and iterative delivery. Start with working prototype.`,
      alternatives: [
        makeAlt('Modular bounded contexts', 'Follows SPARC methodology; enables incremental delivery', false),
        makeAlt('Monolithic', 'Simpler initially but limits independent evolution', true),
      ],
      consequences: [makeCons('Clean architecture enables iterative refinement', 'positive')],
      sparcSectionRefs: [],
      researchDossierItemRefs: [],
    });
  }

  return adrs;
}

// ── Helpers for domain extraction from query ─────────────────────────────

interface DomainContext {
  primary: string;       // "Supplier Transition", "Waste Stream Optimization", etc.
  erp: string | null;    // "Workday", "Oracle Fusion Cloud", "SAP", etc.
  stakeholders: string;  // Who is affected
}

function extractDomainContext(query: string): DomainContext {
  // Extract primary domain — look for noun phrases that describe the system's purpose
  let primary = 'System';
  const domainPatterns = [
    /(?:global|enterprise)\s+([\w\s-]{5,60}?)(?:\s+(?:strategy|program|platform|system|initiative))/i,
    /(?:help\s+(?:model|optimize|manage|simulate|build))\s+(.{10,60}?)(?:\.|,|$)/i,
    /(?:challenge.*?is|goal.*?is)\s+(.{10,60}?)(?:\.|,|$)/i,
    /\b((?:supplier|waste|emission|carbon|inventory|financial|clinical|manufacturing|procurement|supply chain)\s+[\w\s-]{3,40}?(?:optimization|management|simulation|tracking|analysis|modeling|reduction|transition))/i,
  ];
  for (const pat of domainPatterns) {
    const m = query.match(pat);
    if (m) {
      primary = (m[1] ?? m[0]).trim().replace(/^(a|an|the)\s+/i, '');
      primary = primary.charAt(0).toUpperCase() + primary.slice(1);
      if (primary.length > 60) primary = primary.slice(0, 57) + '...';
      break;
    }
  }
  if (primary === 'System') {
    const fallback = query.match(/\b((?:global|enterprise|manufacturing|waste|carbon|emission|clinical|financial|supply|supplier|inventory)\s+\w+(?:\s+\w+){0,2})/i);
    if (fallback?.[1]) primary = fallback[1].charAt(0).toUpperCase() + fallback[1].slice(1);
  }

  // ERP detection
  let erp: string | null = null;
  const erpPatterns: Array<[RegExp, string]> = [
    [/\bworkday\b/i, 'Workday'],
    [/\boracle\s+fusion\s+cloud\b/i, 'Oracle Fusion Cloud'],
    [/\boracle\s+(?:erp|cloud)\b/i, 'Oracle ERP Cloud'],
    [/\bsap\s+s\/4\s*hana\b/i, 'SAP S/4HANA'],
    [/\bsap\b/i, 'SAP'],
    [/\bdynamics\s*365\b/i, 'Dynamics 365'],
    [/\bnetsuite\b/i, 'NetSuite'],
    [/\byardi\s+voyager\b/i, 'Yardi Voyager'],
    [/\byardi\b/i, 'Yardi Voyager'],
    [/\bshopify\s+plus\b/i, 'Shopify Plus'],
    [/\bshopify\b/i, 'Shopify Plus'],
  ];
  for (const [pat, name] of erpPatterns) {
    if (pat.test(query)) { erp = name; break; }
  }

  // Stakeholders
  const stakeholderMatch = query.match(/(?:affect|impact|involve)\s+(.{10,120}?)(?:\.|$)/i);
  const matchedStakeholders = (query.match(/(?:procurement|sustainability|operations|executive|leadership|compliance|regulatory)\s+(?:team|leadership|management)/gi) ?? []).join(', ');
  const stakeholders = stakeholderMatch?.[1]?.trim()
    ?? (matchedStakeholders || 'operational teams and leadership');

  return { primary, erp, stakeholders };
}

function extractTechFromQuery(query: string): string[] {
  const techs: string[] = [];
  const patterns: Array<[RegExp, string]> = [
    [/\btypescript\b/i, 'TypeScript'], [/\brust\b/i, 'Rust'], [/\bpython\b/i, 'Python'],
    [/\bgoogle cloud\b/i, 'Google Cloud'], [/\bcloud run\b/i, 'Cloud Run'], [/\bcloud functions?\b/i, 'Cloud Functions'],
    [/\baws\b/i, 'AWS'], [/\bazure\b/i, 'Azure'],
    [/\bpostgres(?:ql)?\b/i, 'PostgreSQL'], [/\bcloud sql\b/i, 'Cloud SQL (PostgreSQL)'],
    [/\bbigquery\b/i, 'BigQuery'], [/\bmongodb\b/i, 'MongoDB'], [/\bredis\b/i, 'Redis'],
    [/\bkafka\b/i, 'Kafka'], [/\brabbitmq\b/i, 'RabbitMQ'],
    [/\bkubernetes\b|\bk8s\b/i, 'Kubernetes'], [/\bdocker\b/i, 'Docker'],
  ];
  for (const [pat, name] of patterns) {
    if (pat.test(query) && !techs.includes(name)) techs.push(name);
  }
  return techs;
}

function itemsToText(items: ReadonlyArray<{ id: string; text: string; dossierItemRefs: string[] }>): string {
  return items.slice(0, 3).map(s => {
    if (typeof s === 'string') return s;
    if (s && typeof s === 'object') {
      const obj = s as Record<string, unknown>;
      return String(obj['text'] ?? obj['description'] ?? JSON.stringify(s));
    }
    return String(s);
  }).join('; ');
}

export function buildPhase2ADRs(sparc: Phase2SPARCOutput, dossier: ResearchDossier, query?: string): Phase2ADRRecord[] {
  if (!query) {
    process.stderr.write('[adr-generator] No query provided — cannot generate domain-specific ADRs\n');
    return buildADRsFromSPARC(sparc, dossier, query);
  }

  // 1. Try Claude Code runner (works when NOT in MCP mode)
  const runnerResult = tryGenerateLLMADRs(sparc, dossier, query);
  if (runnerResult) return runnerResult;

  // 2. Try direct Anthropic API (works in MCP mode, needs API key)
  const apiResult = tryGenerateADRsViaAPI(sparc, dossier, query);
  if (apiResult) return apiResult;

  // 3. Last resort: SPARC-derived ADRs (still domain-specific, but not LLM-generated)
  process.stderr.write('[adr-generator] WARNING: Both LLM paths failed. Using SPARC-derived ADRs.\n');
  process.stderr.write('[adr-generator] Set ANTHROPIC_API_KEY to enable LLM-generated ADRs.\n');
  return buildADRsFromSPARC(sparc, dossier, query);
}

/**
 * Render a list of ADR records as a single markdown document.
 * Used by ask-artifact-writer to produce engineering/architecture-decisions.md
 */
export function renderADRsAsDocument(adrs: Phase2ADRRecord[], query: string): string {
  const lines: string[] = [];
  const now = new Date().toISOString();
  lines.push('# Architecture Decision Records');
  lines.push('');
  lines.push(`> Generated: ${now}`);
  lines.push(`> Project: ${query.slice(0, 200)}${query.length > 200 ? '...' : ''}`);
  lines.push(`> Derived from: SPARC specification analysis`);
  lines.push('');

  for (const adr of adrs) {
    lines.push(renderADRMarkdown(adr));
    lines.push('---');
    lines.push('');
  }

  lines.push(`*${adrs.length} ADRs derived from SPARC analysis. Review with the team before implementation.*`);
  return lines.join('\n');
}

// ============================================================================
// ADR-027: LLM-Generated Architecture Decision Records
// ============================================================================

/**
 * Generate domain-specific ADRs using Claude (--print mode).
 * Bypasses the MCP availability guard since `claude --print` is a stateless
 * one-shot subprocess that does NOT use MCP — safe to call from any context.
 * Uses the user's Claude Max subscription (no separate API key needed).
 */
function tryGenerateLLMADRs(
  sparc: Phase2SPARCOutput,
  dossier: ResearchDossier,
  query: string,
  phase2Dir = '',
): Phase2ADRRecord[] | null {
  try {
    // Resolve claude binary directly — do NOT use isClaudeCodeRunnerAvailable()
    // which blocks in MCP mode. `claude --print` is safe from any context.
    const { execFileSync } = require('node:child_process') as typeof import('node:child_process');
    let claudeBin: string | null = null;

    // Check env override first
    const envBin = process.env['AGENTICS_CLAUDE_BIN'];
    if (envBin) {
      claudeBin = envBin;
    } else {
      // Find claude on PATH
      const lookupCmd = process.platform === 'win32' ? 'where' : 'which';
      for (const candidate of ['claude', 'claude-code']) {
        try {
          const found = execFileSync(lookupCmd, [candidate], {
            stdio: ['pipe', 'pipe', 'pipe'],
            timeout: 5_000,
            encoding: 'utf-8',
          }).trim().split(/\r?\n/)[0]?.trim();
          if (found) { claudeBin = found; break; }
        } catch { /* not found, try next */ }
      }
    }

    if (!claudeBin) {
      process.stderr.write('[adr-generator] claude binary not found — cannot generate LLM ADRs\n');
      return null;
    }

    const prompt = buildADRPrompt(sparc, dossier, query, phase2Dir);
    const startMs = Date.now();

    // Use --print for one-shot generation (no MCP, no interactive session)
    const model = process.env['AGENTICS_CLAUDE_MODEL'] || 'claude-sonnet-4-20250514';
    const rawOutput = execFileSync(claudeBin, [
      '--print',
      '--output-format', 'text',
      '--model', model,
      prompt,
    ], {
      encoding: 'utf-8',
      timeout: 120_000, // 2 minutes — ADR generation is complex
      maxBuffer: 10 * 1024 * 1024,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, MCP_SERVER_MODE: undefined }, // Clear MCP flag for subprocess
    });

    const adrs = parseRawADRs(rawOutput, dossier);
    if (!adrs || adrs.length === 0) {
      process.stderr.write('[adr-generator] Claude --print returned no valid ADR JSON\n');
      return null;
    }

    const durationMs = Date.now() - startMs;
    process.stderr.write(
      `[adr-generator] LLM-generated ${adrs.length} domain-specific ADRs via claude --print in ${durationMs}ms\n`
    );
    return adrs;
  } catch (err: unknown) {
    process.stderr.write(
      `[adr-generator] LLM ADR generation failed: ${err instanceof Error ? err.message : String(err)}\n`
    );
    return null;
  }
}

// ============================================================================
// ADR Generation via Direct Anthropic API (for MCP mode where runner is blocked)
// ============================================================================

/**
 * Build the ADR generation prompt from SPARC + dossier + query.
 * Shared between tryGenerateLLMADRs (Claude Code runner) and tryGenerateADRsViaAPI (direct API).
 */
function buildADRPrompt(
  sparc: Phase2SPARCOutput,
  dossier: ResearchDossier,
  query: string,
  phase2Dir = '',
): string {
  const services = sparc.architecture?.services ?? [];
  const serviceList = services.map(s =>
    `- ${s.name}: ${s.responsibility.slice(0, 100)} (deps: ${s.dependencies.join(', ') || 'none'})`
  ).join('\n');

  const dossierContext = dossier.items
    .filter(i => ['requirement', 'constraint', 'risk', 'decision-rationale'].includes(i.category))
    .slice(0, 20)
    .map(i => `- [${i.category}] ${i.title}: ${i.content.slice(0, 120)}`)
    .join('\n');

  const agentContext = phase2Dir ? loadAgenticsFleetContextForADR(phase2Dir) : '';

  const dossierText = dossier.items.map(i => i.content).join(' ');
  const techStack = detectTechnologyStack(query, dossierText);
  const techMentions: string[] = [];
  if (techStack.erp) techMentions.push(techStack.erp.name);
  if (techStack.cloud) techMentions.push(techStack.cloud.toUpperCase());
  if (techStack.database) techMentions.push(techStack.database);
  if (techStack.messageQueue) techMentions.push(techStack.messageQueue);
  if (techStack.searchEngine) techMentions.push(techStack.searchEngine);
  if (techStack.cacheLayer) techMentions.push(techStack.cacheLayer);

  const erpPromptContext = techStack.erp
    ? `\nERP API DETAILS (use these EXACT paths):\n${formatERPContextForPrompt(techStack.erp)}\n`
    : '';

  return (
    `You are a senior solution architect writing Architecture Decision Records. Read the FULL project requirements below and write ADRs that guide a developer on HOW to build this specific system.\n\n` +
    `## Project Requirements\n\n${query}\n\n` +
    `## Services Identified\n${serviceList}\n` +
    `\nRESEARCH FINDINGS:\n${dossierContext}\n` +
    (agentContext ? agentContext + '\n' : '') +
    `\nDETECTED TECHNOLOGIES: ${techMentions.join(', ') || 'not specified'}\n` +
    erpPromptContext +
    `\nWrite 8-12 ADRs as a JSON array. Each ADR must be an IMPLEMENTATION DECISION that tells a developer what to build and how.\n` +
    `\nIMPORTANT: ADRs must cover TWO categories:\n` +
    `\nA) DOMAIN-SPECIFIC DECISIONS (at least 5) — these guide implementation of the actual business logic:\n` +
    `   - How to model the core domain concepts (e.g., "Model emissions as facility-level time series with BU rollup")\n` +
    `   - How to implement the key algorithms/calculations (scoring, ranking, normalization, weighting)\n` +
    `   - How to structure the decision/simulation/optimization logic\n` +
    `   - How domain entities relate and what business rules constrain them\n` +
    `   - How to handle the specific workflows the user described\n` +
    `   - CRITICAL: Each non-obvious algorithmic choice gets its OWN ADR:\n` +
    `     * Scoring/ranking algorithms (normalization method, weight handling, rounding)\n` +
    `     * Routing/filtering strategies (viability thresholds, mode selection, split ratios)\n` +
    `     * Factor sourcing (emissions factors, cost multipliers, regional variations)\n` +
    `     * Threshold models (SLA tolerances, priority levels, constraint buffers)\n` +
    `     * Estimation fallbacks (distance estimation for unknown routes, default handling)\n` +
    `     * Immutability/audit patterns (comparison persistence, content hashing, lineage)\n` +
    `\nB) INFRASTRUCTURE DECISIONS (3-5) — technology choices that support the domain:\n` +
    `   - Data persistence: which database(s) and why\n` +
    `   - ERP integration approach for ${techMentions[0] || 'the ERP system'}\n` +
    `   - Deployment and cloud platform specifics\n` +
    `   - Security and compliance requirements\n` +
    `\nEach ADR title should describe a SPECIFIC decision, not a category. Example:\n` +
    `  GOOD: "Use Monte Carlo simulation for carbon price forecasting with configurable volatility"\n` +
    `  BAD: "Performance Architecture"\n` +
    `  GOOD: "Model emissions baseline as facility-level time series with business unit rollup"\n` +
    `  BAD: "Data persistence strategy"\n` +
    `\nReturn ONLY a JSON array (no markdown fences, no explanation before or after):\n` +
    `[\n` +
    `  {\n` +
    `    "title": "Specific decision title that tells a developer what to build",\n` +
    `    "context": "Why this decision matters — reference the specific business problem from the requirements",\n` +
    `    "decision": "The specific approach — include enough detail that a developer can implement it",\n` +
    `    "alternatives": [{"option": "Name", "rationale": "Why considered", "rejected": true/false}],\n` +
    `    "consequences": [{"description": "Impact on the system", "type": "positive|negative|neutral"}]\n` +
    `  }\n` +
    `]\n` +
    `\nCRITICAL RULES:\n` +
    `- NO generic titles like "Security Architecture", "Performance Architecture", "Service Boundary"\n` +
    `- Every ADR must contain enough implementation detail that a developer can build from it\n` +
    `- The "decision" field should be 2-4 sentences describing the specific approach, not one vague sentence\n` +
    `- Reference actual domain concepts from the requirements (not generic "entities" or "services")\n` +
    `- If the user specified technologies (${techMentions.join(', ')}), reference them in relevant ADRs`
  );
}

/**
 * Parse raw LLM JSON response into Phase2ADRRecord[].
 */
function parseRawADRs(rawText: string, dossier: ResearchDossier): Phase2ADRRecord[] | null {
  // Strip markdown code fences if present
  let cleaned = rawText.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
  }

  let rawAdrs: Array<Record<string, unknown>>;
  try {
    const parsed = JSON.parse(cleaned);
    if (!Array.isArray(parsed) || parsed.length === 0) return null;
    rawAdrs = parsed;
  } catch {
    // Try to extract JSON array from the response
    const arrayMatch = cleaned.match(/\[[\s\S]*\]/);
    if (!arrayMatch) return null;
    try {
      const parsed = JSON.parse(arrayMatch[0]);
      if (!Array.isArray(parsed) || parsed.length === 0) return null;
      rawAdrs = parsed;
    } catch {
      return null;
    }
  }

  const today = new Date().toISOString().slice(0, 10);
  return rawAdrs.map((raw, idx) => {
    const alts = Array.isArray(raw.alternatives)
      ? (raw.alternatives as Array<{ option?: string; rationale?: string; rejected?: boolean }>).map(a =>
        makeAlt(String(a.option || ''), String(a.rationale || ''), !!a.rejected))
      : [makeAlt('Selected approach', String(raw.decision || ''), false)];

    const cons = Array.isArray(raw.consequences)
      ? (raw.consequences as Array<{ description?: string; type?: string }>).map(c =>
        makeCons(String(c.description || ''), (c.type || 'neutral') as 'positive' | 'negative' | 'neutral'))
      : [makeCons('Decision applied', 'neutral')];

    return {
      id: `ADR-P2-${pad3(idx + 1)}`,
      title: String(raw.title || `Decision ${idx + 1}`),
      status: 'proposed' as const,
      date: today,
      context: String(raw.context || ''),
      decision: String(raw.decision || ''),
      alternatives: alts,
      consequences: cons,
      sparcSectionRefs: [] as string[],
      researchDossierItemRefs: findDossierRefs(dossier, [
        String(raw.title || '').toLowerCase(),
      ]),
    };
  });
}

/**
 * Generate ADRs via direct Anthropic API call.
 * Used when Claude Code runner is unavailable (MCP mode).
 * Requires ANTHROPIC_API_KEY in env or ~/.agentics/credentials.json.
 */
function tryGenerateADRsViaAPI(
  sparc: Phase2SPARCOutput,
  dossier: ResearchDossier,
  query: string,
): Phase2ADRRecord[] | null {
  // Synchronous API key check — getAnthropicApiKey is async but we need sync here.
  // Check env var directly (most common path).
  const apiKey = process.env['ANTHROPIC_API_KEY'] ?? null;
  if (!apiKey) {
    process.stderr.write('[adr-generator] No ANTHROPIC_API_KEY — cannot call API directly\n');
    return null;
  }

  try {
    const prompt = buildADRPrompt(sparc, dossier, query);
    const startMs = Date.now();

    // Synchronous HTTP via child_process (Node fetch is async-only)
    const { execFileSync } = require('node:child_process') as typeof import('node:child_process');

    const curlArgs = [
      '-s', '--max-time', '90',
      '-X', 'POST',
      'https://api.anthropic.com/v1/messages',
      '-H', 'Content-Type: application/json',
      '-H', `x-api-key: ${apiKey}`,
      '-H', 'anthropic-version: 2023-06-01',
      '-d', JSON.stringify({
        model: process.env['AGENTICS_ADR_MODEL'] || 'claude-sonnet-4-20250514',
        max_tokens: 8192,
        messages: [{ role: 'user', content: prompt }],
      }),
    ];

    const rawResponse = execFileSync('curl', curlArgs, {
      encoding: 'utf-8',
      timeout: 120_000,
      maxBuffer: 10 * 1024 * 1024,
    });

    const response = JSON.parse(rawResponse) as {
      content?: Array<{ type: string; text?: string }>;
      error?: { message: string };
    };

    if (response.error) {
      process.stderr.write(`[adr-generator] API error: ${response.error.message}\n`);
      return null;
    }

    const textBlock = response.content?.find(b => b.type === 'text');
    if (!textBlock?.text) {
      process.stderr.write('[adr-generator] API returned no text content\n');
      return null;
    }

    const adrs = parseRawADRs(textBlock.text, dossier);
    if (!adrs || adrs.length === 0) {
      process.stderr.write('[adr-generator] API response did not contain valid ADR JSON\n');
      return null;
    }

    const durationMs = Date.now() - startMs;
    process.stderr.write(
      `[adr-generator] API-generated ${adrs.length} domain-specific ADRs in ${durationMs}ms\n`
    );
    return adrs;
  } catch (err: unknown) {
    process.stderr.write(
      `[adr-generator] API ADR generation failed: ${err instanceof Error ? err.message : String(err)}\n`
    );
    return null;
  }
}

// ============================================================================
// Public: Main Stage Function
// ============================================================================

export async function generateADRs(context: Phase2Context): Promise<Phase2StageOutput> {
  const rootSpan = createSpan('adr-generation', 'generate-adrs', { phase2Dir: context.phase2Dir });

  try {
    const sparcStage = context.stageOutputs.get('sparc-specification');
    if (!sparcStage || sparcStage.status !== 'completed') {
      throw new Error('ECLI-P2-020: SPARC output not available.');
    }
    const sparc = sparcStage.data as Phase2SPARCOutput;

    const dossierStage = context.stageOutputs.get('research-dossier');
    if (!dossierStage || dossierStage.status !== 'completed') {
      throw new Error('ECLI-P2-020: Research dossier not available.');
    }
    const dossier = dossierStage.data as ResearchDossier;

    // ADR-027: Try LLM-generated domain-specific ADRs first, fall back to template
    const query = context.phase1Artifacts?.scenario?.query
      ?? (context.phase1Artifacts?.manifest as unknown as Record<string, unknown>)?.['query'] as string
      ?? '';

    // ADR-PIPELINE-018: Extract simulation ID for lineage tracing
    const simulationId = context.phase1Artifacts?.manifest?.execution_id
      ?? context.phase1Artifacts?.manifest?.run_id
      ?? '';
    if (simulationId) {
      process.stderr.write(`[adr-generator] Linking ADRs to simulation: ${simulationId}\n`);
    }

    // ADR-029: Detect and persist tech stack so downstream phases use the same ERP
    const dossierText = dossier.items.map(i => i.content).join(' ');
    const techStack = detectTechnologyStack(query, dossierText);
    writeTechStack(techStack, context.phase2Dir);
    if (techStack.erp) {
      process.stderr.write(`[adr-generator] Detected ERP: ${techStack.erp.name} (${techStack.erp.slug})\n`);
    }

    // 3-tier ADR generation: claude --print → Anthropic API → SPARC-derived
    let adrs = (query ? tryGenerateLLMADRs(sparc, dossier, query, context.phase2Dir) : null)
      ?? (query ? tryGenerateADRsViaAPI(sparc, dossier, query) : null)
      ?? buildADRsFromSPARC(sparc, dossier, query);

    // ADR-PIPELINE-018: Stamp simulation lineage on all ADRs
    if (simulationId) {
      adrs = adrs.map(adr => ({ ...adr, simulationId }));
    }

    const adrDir = path.join(context.phase2Dir, ADR_SUBDIR);
    fs.mkdirSync(adrDir, { recursive: true, mode: DIR_MODE });
    const writtenPaths: string[] = [];

    for (const adr of adrs) {
      const slug = slugify(adr.title);
      const filename = `${adr.id}-${slug}.md`;
      const filePath = path.join(adrDir, filename);
      const markdown = renderADRMarkdown(adr);
      fs.writeFileSync(filePath, markdown, { encoding: 'utf-8', mode: FILE_MODE });
      writtenPaths.push(filePath);
    }

    const indexPath = path.join(adrDir, 'adr-index.json');
    fs.writeFileSync(indexPath, JSON.stringify(adrs, null, 2) + '\n', { encoding: 'utf-8', mode: FILE_MODE });
    writtenPaths.push(indexPath);

    endSpan(rootSpan, 'ok', { adrCount: adrs.length });
    emitSpan(rootSpan);

    const timing = rootSpan.durationMs ?? 0;
    const output: Phase2StageOutput = {
      stage: 'adr-generation',
      status: 'completed',
      data: adrs,
      artifacts: writtenPaths,
      timing,
      summary: `     ADRs: ${adrs.length} decisions (${writtenPaths.length - 1} markdown + 1 JSON index)`,
    };

    context.stageOutputs.set('adr-generation', output);
    return output;
  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    endSpan(rootSpan, 'error', { error: errorMessage });
    emitSpan(rootSpan);

    const output: Phase2StageOutput = {
      stage: 'adr-generation',
      status: 'failed',
      data: { error: errorMessage },
      artifacts: [],
      timing: rootSpan.durationMs ?? 0,
      summary: `ADR generation failed: ${errorMessage}`,
    };
    context.stageOutputs.set('adr-generation', output);
    return output;
  }
}
