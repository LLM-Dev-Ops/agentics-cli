/**
 * Dynamic Downstream Router for Synthesis Pipeline
 *
 * The Agentics CLI sits between two layers:
 *   1. agentics-contracts (schemas, validation, type system)
 *   2. agentics-platform repos (11 downstream Cloud Run services)
 *
 * This router analyzes simulation/plan/deployment descriptions to determine
 * which downstream platform repos, services, and agent types are relevant.
 * The routing decision is embedded into the synthesis prompt so the LLM
 * produces output aligned with the activated platform layers.
 *
 * All artifacts are persisted via the ruvector-service (persistent storage
 * backbone for plans, simulations, lineage, decisions, and ERP mappings).
 * All outputs are validated against agentics-contracts response schemas.
 *
 * INVARIANTS:
 * - Every simulation gets at least the base service set (planner + engine)
 * - ruvector-service is ALWAYS included (persistence is mandatory per ADR-004)
 * - Service selection is deterministic for the same input
 * - No HTTP calls are made here — this is prompt-time routing only
 * - The routing profile is included in synthesis output for traceability
 * - All output must conform to agentics-contracts schemas
 */

// ============================================================================
// Types
// ============================================================================

export interface DownstreamService {
  /** Service identifier matching endpoints.ts keys */
  name: string;
  /** Human-readable purpose for this simulation */
  purpose: string;
  /** API surface description for the LLM prompt */
  apiSurface: string;
  /** GitHub repo name (agentics-platform org) */
  repo: string;
  /** Contract schema this service validates against (from agentics-contracts) */
  contractSchema: string;
  /** Priority: 'primary' services are always referenced; 'supporting' are contextual */
  priority: 'primary' | 'supporting';
}

export interface AgentProfile {
  /** Agent type identifier */
  type: string;
  /** Role in this simulation */
  role: string;
  /** What this agent produces */
  outputs: string[];
}

export type SimulationCategory =
  | 'enterprise_ai_deployment'
  | 'financial_analysis'
  | 'regulatory_compliance'
  | 'infrastructure_deployment'
  | 'security_assessment'
  | 'erp_integration'
  | 'change_management'
  | 'research_development'
  | 'workforce_transformation'
  | 'general';

export interface SimulationProfile {
  /** Detected simulation category */
  category: SimulationCategory;
  /** Confidence score 0-1 for category detection */
  confidence: number;
  /** All detected categories with scores */
  detectedCategories: Array<{ category: SimulationCategory; score: number }>;
  /** Downstream services activated for this simulation */
  services: DownstreamService[];
  /** Agent types recommended for this simulation */
  agents: AgentProfile[];
  /** Platform layers this simulation touches */
  layers: string[];
  /** Industry vertical if detected */
  industry?: string;
  /** Scale descriptor */
  scale?: string;
}

// ============================================================================
// Service Catalog
// ============================================================================

/**
 * Full catalog of downstream agentics-platform services with their capabilities.
 *
 * Architecture:
 *   agentics-contracts (schemas) → agentics-cli (orchestration) → agentics-platform (services)
 *                                                                → ruvector-service (persistence)
 */
const SERVICE_CATALOG: Record<string, Omit<DownstreamService, 'priority'>> = {
  'agentics-org-manifests': {
    name: 'agentics-org-manifests',
    purpose: 'Organization capability manifests and agent registry — defines what agents and capabilities exist',
    apiSurface: 'POST /v1/manifests — Select agent manifests matching criteria',
    repo: 'agentics-org-manifests',
    contractSchema: 'agentics-contracts/manifest/v1',
  },
  'agentics-simulation-planner': {
    name: 'agentics-simulation-planner',
    purpose: 'Simulation planning with phased execution strategy and dependency ordering',
    apiSurface: 'POST /v1/plans — Create execution plan from manifest + params',
    repo: 'agentics-simulation-planner',
    contractSchema: 'agentics-contracts/plan/v1',
  },
  'agentics-simulation-runner': {
    name: 'agentics-simulation-runner',
    purpose: 'Simulation execution engine with step-by-step orchestration and monitoring',
    apiSurface: 'POST /v1/runner — Execute plan with config and real-time monitoring',
    repo: 'agentics-simulation-runner',
    contractSchema: 'agentics-contracts/simulation/v1',
  },
  'agentics-simulation-engine': {
    name: 'agentics-simulation-engine',
    purpose: 'Core simulation compute, artifact generation, and output retrieval',
    apiSurface: 'POST /v1/simulate — Run simulation and retrieve outputs by type',
    repo: 'agentics-simulation-engine',
    contractSchema: 'agentics-contracts/simulation/v1',
  },
  'agentics-results-index': {
    name: 'agentics-results-index',
    purpose: 'Simulation results indexing, querying, and historical analysis',
    apiSurface: 'GET /v1/results — Query simulation results with filters (environment, status, limit)',
    repo: 'agentics-results-index',
    contractSchema: 'agentics-contracts/simulation-output/v1',
  },
  'enterprise-roi-engine': {
    name: 'enterprise-roi-engine',
    purpose: 'ROI calculation, financial modeling, NPV analysis, and cost-benefit quantification',
    apiSurface: 'POST /v1/roi — Quantify ROI with report type (summary, detailed, comparative)',
    repo: 'enterprise-roi-engine',
    contractSchema: 'agentics-contracts/roi-report/v1',
  },
  'agentics-deployment-intent': {
    name: 'agentics-deployment-intent',
    purpose: 'Deployment intent resolution, change impact analysis, and resource estimation',
    apiSurface: 'POST /v1/intent — Resolve deployment intent from simulation reference',
    repo: 'agentics-deployment-intent',
    contractSchema: 'agentics-contracts/intent/v1',
  },
  'agentics-deployment-exporters': {
    name: 'agentics-deployment-exporters',
    purpose: 'Infrastructure-as-code export generation (Terraform, Kubernetes, ERP)',
    apiSurface: 'POST /v1/exporters — Generate IaC from deployment intent',
    repo: 'agentics-deployment-exporters',
    contractSchema: 'agentics-contracts/export/v1',
  },
  'diligence-artifacts': {
    name: 'diligence-artifacts',
    purpose: 'Due diligence packaging, compliance evidence collection, audit trail generation',
    apiSurface: 'POST /v1/diligence — Package references with compliance requirements',
    repo: 'diligence-artifacts',
    contractSchema: 'agentics-contracts/diligence-package/v1',
  },
  'ruvector-service': {
    name: 'ruvector-service',
    purpose: 'Persistent storage backbone — plans, simulations, lineage, decisions, ERP mappings (ADR-004 mandatory)',
    apiSurface: 'POST /v1/simulations, /v1/plans, /v1/decisions, /v1/lineage, /v1/erp-mappings',
    repo: 'ruvector-service',
    contractSchema: 'agentics-contracts/decision-event/v1',
  },
};

// ============================================================================
// Agent Catalog
// ============================================================================

const AGENT_CATALOG: Record<string, Omit<AgentProfile, 'role'>> = {
  'simulation-planner': {
    type: 'simulation-planner',
    outputs: ['execution_plan', 'phase_definitions', 'dependency_graph'],
  },
  'financial-analyst': {
    type: 'financial-analyst',
    outputs: ['roi_model', 'cost_breakdown', 'npv_analysis', 'payback_period'],
  },
  'risk-assessor': {
    type: 'risk-assessor',
    outputs: ['risk_matrix', 'mitigation_strategies', 'contingency_plans'],
  },
  'compliance-auditor': {
    type: 'compliance-auditor',
    outputs: ['compliance_gaps', 'regulatory_mapping', 'audit_evidence'],
  },
  'infrastructure-architect': {
    type: 'infrastructure-architect',
    outputs: ['architecture_diagram', 'technology_stack', 'integration_map'],
  },
  'change-management-lead': {
    type: 'change-management-lead',
    outputs: ['impact_assessment', 'training_plan', 'communication_strategy'],
  },
  'security-analyst': {
    type: 'security-analyst',
    outputs: ['threat_model', 'security_controls', 'vulnerability_assessment'],
  },
  'data-engineer': {
    type: 'data-engineer',
    outputs: ['data_flow_map', 'pipeline_design', 'quality_framework'],
  },
  'workforce-strategist': {
    type: 'workforce-strategist',
    outputs: ['role_mapping', 'skill_gap_analysis', 'transition_timeline'],
  },
  'erp-integration-specialist': {
    type: 'erp-integration-specialist',
    outputs: ['entity_mapping', 'integration_protocol', 'migration_plan'],
  },
  'deployment-engineer': {
    type: 'deployment-engineer',
    outputs: ['deployment_manifest', 'rollback_strategy', 'canary_config'],
  },
};

// ============================================================================
// Category Detection Patterns
// ============================================================================

interface CategoryPattern {
  category: SimulationCategory;
  /** Keywords that strongly indicate this category */
  keywords: string[];
  /** Phrases that are high-confidence indicators */
  phrases: string[];
  /** Weight multiplier for this category */
  weight: number;
}

const CATEGORY_PATTERNS: CategoryPattern[] = [
  {
    category: 'enterprise_ai_deployment',
    keywords: ['ai', 'agentic', 'llm', 'ml', 'machine learning', 'neural', 'automation', 'intelligent', 'cognitive', 'autonomous'],
    phrases: ['ai implementation', 'agentic systems', 'ai deployment', 'ai transformation', 'digital transformation', 'enterprise ai', 'ai across', 'implement ai', 'deploy ai', 'ai and agentics'],
    weight: 1.0,
  },
  {
    category: 'financial_analysis',
    keywords: ['roi', 'cost', 'budget', 'revenue', 'profit', 'financial', 'investment', 'savings', 'pricing', 'monetization'],
    phrases: ['cost benefit', 'return on investment', 'financial model', 'cost reduction', 'revenue impact', 'total cost of ownership'],
    weight: 0.9,
  },
  {
    category: 'regulatory_compliance',
    keywords: ['compliance', 'regulatory', 'gdpr', 'hipaa', 'sox', 'pci', 'fda', 'audit', 'governance', 'regulation'],
    phrases: ['regulatory compliance', 'data privacy', 'compliance requirements', 'audit trail', 'regulatory framework', 'compliance program'],
    weight: 1.0,
  },
  {
    category: 'infrastructure_deployment',
    keywords: ['infrastructure', 'deployment', 'cloud', 'kubernetes', 'terraform', 'aws', 'azure', 'gcp', 'devops', 'cicd'],
    phrases: ['cloud migration', 'infrastructure deployment', 'container orchestration', 'cloud native', 'infrastructure as code'],
    weight: 0.9,
  },
  {
    category: 'security_assessment',
    keywords: ['security', 'threat', 'vulnerability', 'penetration', 'encryption', 'authentication', 'zero trust', 'cybersecurity'],
    phrases: ['security assessment', 'threat model', 'security posture', 'zero trust', 'security architecture', 'vulnerability assessment'],
    weight: 1.0,
  },
  {
    category: 'erp_integration',
    keywords: ['erp', 'sap', 'oracle', 'salesforce', 'workday', 'integration', 'middleware', 'api gateway'],
    phrases: ['erp integration', 'system integration', 'enterprise integration', 'api integration', 'data integration'],
    weight: 0.9,
  },
  {
    category: 'change_management',
    keywords: ['change', 'adoption', 'training', 'culture', 'stakeholder', 'communication', 'transition', 'organizational'],
    phrases: ['change management', 'organizational change', 'digital adoption', 'stakeholder management', 'culture change', 'workforce transition'],
    weight: 0.8,
  },
  {
    category: 'research_development',
    keywords: ['research', 'prototype', 'experiment', 'innovation', 'poc', 'pilot', 'discovery', 'feasibility'],
    phrases: ['proof of concept', 'research and development', 'innovation lab', 'pilot program', 'feasibility study'],
    weight: 0.8,
  },
  {
    category: 'workforce_transformation',
    keywords: ['workforce', 'employees', 'headcount', 'hiring', 'reskilling', 'talent', 'hr', 'staffing'],
    phrases: ['workforce transformation', 'talent strategy', 'employee experience', 'workforce planning', 'skill development'],
    weight: 0.8,
  },
];

// ============================================================================
// Industry Detection
// ============================================================================

const INDUSTRY_PATTERNS: Array<{ industry: string; keywords: string[] }> = [
  { industry: 'pharmaceutical', keywords: ['pharmaceutical', 'pharma', 'drug', 'clinical trial', 'fda', 'biotech', 'medication', 'therapeutics'] },
  { industry: 'healthcare', keywords: ['healthcare', 'hospital', 'patient', 'clinical', 'medical', 'health system', 'hipaa', 'ehr'] },
  { industry: 'financial_services', keywords: ['banking', 'financial', 'fintech', 'insurance', 'trading', 'wealth management', 'payments'] },
  { industry: 'manufacturing', keywords: ['manufacturing', 'factory', 'supply chain', 'logistics', 'warehouse', 'production', 'assembly'] },
  { industry: 'retail', keywords: ['retail', 'ecommerce', 'store', 'inventory', 'customer experience', 'omnichannel', 'merchandise'] },
  { industry: 'technology', keywords: ['saas', 'platform', 'software', 'tech company', 'startup', 'developer', 'api'] },
  { industry: 'energy', keywords: ['energy', 'utilities', 'oil', 'gas', 'renewable', 'solar', 'grid', 'power'] },
  { industry: 'government', keywords: ['government', 'public sector', 'federal', 'municipal', 'agency', 'defense', 'military'] },
  { industry: 'telecommunications', keywords: ['telecom', 'telecommunications', 'network', '5g', 'broadband', 'carrier'] },
  { industry: 'education', keywords: ['education', 'university', 'school', 'learning', 'academic', 'student', 'curriculum'] },
];

// ============================================================================
// Category → Service Mapping
// ============================================================================

/** Maps simulation categories to their required downstream services */
const CATEGORY_SERVICE_MAP: Record<SimulationCategory, Array<{ service: string; priority: 'primary' | 'supporting' }>> = {
  enterprise_ai_deployment: [
    { service: 'agentics-org-manifests', priority: 'primary' },
    { service: 'agentics-simulation-planner', priority: 'primary' },
    { service: 'agentics-simulation-runner', priority: 'primary' },
    { service: 'agentics-simulation-engine', priority: 'primary' },
    { service: 'enterprise-roi-engine', priority: 'primary' },
    { service: 'agentics-results-index', priority: 'supporting' },
    { service: 'diligence-artifacts', priority: 'supporting' },
    { service: 'ruvector-service', priority: 'supporting' },
  ],
  financial_analysis: [
    { service: 'enterprise-roi-engine', priority: 'primary' },
    { service: 'agentics-simulation-engine', priority: 'primary' },
    { service: 'agentics-results-index', priority: 'primary' },
    { service: 'diligence-artifacts', priority: 'supporting' },
    { service: 'ruvector-service', priority: 'supporting' },
  ],
  regulatory_compliance: [
    { service: 'diligence-artifacts', priority: 'primary' },
    { service: 'agentics-org-manifests', priority: 'primary' },
    { service: 'agentics-simulation-engine', priority: 'primary' },
    { service: 'ruvector-service', priority: 'primary' },
    { service: 'enterprise-roi-engine', priority: 'supporting' },
  ],
  infrastructure_deployment: [
    { service: 'agentics-deployment-intent', priority: 'primary' },
    { service: 'agentics-deployment-exporters', priority: 'primary' },
    { service: 'agentics-simulation-planner', priority: 'primary' },
    { service: 'agentics-simulation-runner', priority: 'primary' },
    { service: 'agentics-simulation-engine', priority: 'supporting' },
    { service: 'ruvector-service', priority: 'supporting' },
  ],
  security_assessment: [
    { service: 'diligence-artifacts', priority: 'primary' },
    { service: 'agentics-org-manifests', priority: 'primary' },
    { service: 'agentics-simulation-engine', priority: 'primary' },
    { service: 'agentics-simulation-planner', priority: 'supporting' },
    { service: 'ruvector-service', priority: 'supporting' },
  ],
  erp_integration: [
    { service: 'agentics-org-manifests', priority: 'primary' },
    { service: 'agentics-deployment-exporters', priority: 'primary' },
    { service: 'enterprise-roi-engine', priority: 'primary' },
    { service: 'agentics-simulation-engine', priority: 'primary' },
    { service: 'diligence-artifacts', priority: 'supporting' },
    { service: 'ruvector-service', priority: 'supporting' },
  ],
  change_management: [
    { service: 'agentics-org-manifests', priority: 'primary' },
    { service: 'agentics-simulation-planner', priority: 'primary' },
    { service: 'enterprise-roi-engine', priority: 'primary' },
    { service: 'agentics-simulation-engine', priority: 'supporting' },
    { service: 'ruvector-service', priority: 'supporting' },
  ],
  research_development: [
    { service: 'agentics-simulation-engine', priority: 'primary' },
    { service: 'agentics-simulation-planner', priority: 'primary' },
    { service: 'agentics-results-index', priority: 'primary' },
    { service: 'enterprise-roi-engine', priority: 'supporting' },
    { service: 'ruvector-service', priority: 'supporting' },
  ],
  workforce_transformation: [
    { service: 'agentics-org-manifests', priority: 'primary' },
    { service: 'enterprise-roi-engine', priority: 'primary' },
    { service: 'agentics-simulation-planner', priority: 'primary' },
    { service: 'diligence-artifacts', priority: 'supporting' },
    { service: 'ruvector-service', priority: 'supporting' },
  ],
  general: [
    { service: 'agentics-simulation-planner', priority: 'primary' },
    { service: 'agentics-simulation-engine', priority: 'primary' },
    { service: 'enterprise-roi-engine', priority: 'supporting' },
    { service: 'agentics-results-index', priority: 'supporting' },
    { service: 'ruvector-service', priority: 'supporting' },
  ],
};

// ============================================================================
// Category → Agent Mapping
// ============================================================================

const CATEGORY_AGENT_MAP: Record<SimulationCategory, Array<{ agent: string; role: string }>> = {
  enterprise_ai_deployment: [
    { agent: 'simulation-planner', role: 'Orchestrate phased AI rollout across departments' },
    { agent: 'financial-analyst', role: 'Model ROI, TCO, and payback for AI investment' },
    { agent: 'risk-assessor', role: 'Identify technical, organizational, and regulatory risks' },
    { agent: 'infrastructure-architect', role: 'Design AI platform architecture and integrations' },
    { agent: 'change-management-lead', role: 'Plan organizational adoption and training' },
    { agent: 'workforce-strategist', role: 'Map workforce impact and transition plans' },
  ],
  financial_analysis: [
    { agent: 'financial-analyst', role: 'Build comprehensive financial model with projections' },
    { agent: 'risk-assessor', role: 'Quantify financial risks and sensitivity analysis' },
    { agent: 'simulation-planner', role: 'Structure financial scenario phases' },
  ],
  regulatory_compliance: [
    { agent: 'compliance-auditor', role: 'Map regulatory requirements and identify gaps' },
    { agent: 'risk-assessor', role: 'Assess compliance risk exposure' },
    { agent: 'security-analyst', role: 'Evaluate data protection and privacy controls' },
    { agent: 'simulation-planner', role: 'Phase compliance implementation' },
  ],
  infrastructure_deployment: [
    { agent: 'infrastructure-architect', role: 'Design deployment architecture' },
    { agent: 'deployment-engineer', role: 'Plan deployment strategy and rollback' },
    { agent: 'security-analyst', role: 'Validate infrastructure security posture' },
    { agent: 'simulation-planner', role: 'Sequence deployment phases' },
  ],
  security_assessment: [
    { agent: 'security-analyst', role: 'Conduct threat modeling and vulnerability assessment' },
    { agent: 'compliance-auditor', role: 'Validate security compliance frameworks' },
    { agent: 'infrastructure-architect', role: 'Review security architecture' },
    { agent: 'risk-assessor', role: 'Quantify security risk exposure' },
  ],
  erp_integration: [
    { agent: 'erp-integration-specialist', role: 'Map ERP entities and integration protocols' },
    { agent: 'data-engineer', role: 'Design data pipelines and quality framework' },
    { agent: 'infrastructure-architect', role: 'Architecture integration middleware' },
    { agent: 'financial-analyst', role: 'Model integration ROI' },
  ],
  change_management: [
    { agent: 'change-management-lead', role: 'Design change program and communication plan' },
    { agent: 'workforce-strategist', role: 'Map impacted roles and transition timeline' },
    { agent: 'simulation-planner', role: 'Phase change management activities' },
    { agent: 'financial-analyst', role: 'Model change management costs and benefits' },
  ],
  research_development: [
    { agent: 'simulation-planner', role: 'Structure R&D phases and experiments' },
    { agent: 'infrastructure-architect', role: 'Design prototype environments' },
    { agent: 'risk-assessor', role: 'Assess technical feasibility risks' },
    { agent: 'financial-analyst', role: 'Model R&D investment and timeline' },
  ],
  workforce_transformation: [
    { agent: 'workforce-strategist', role: 'Map workforce transformation strategy' },
    { agent: 'change-management-lead', role: 'Plan training and adoption programs' },
    { agent: 'financial-analyst', role: 'Model talent costs and productivity gains' },
    { agent: 'simulation-planner', role: 'Phase workforce transition' },
  ],
  general: [
    { agent: 'simulation-planner', role: 'Orchestrate simulation phases' },
    { agent: 'financial-analyst', role: 'Model costs and benefits' },
    { agent: 'risk-assessor', role: 'Identify and assess risks' },
  ],
};

// ============================================================================
// Scale Detection
// ============================================================================

function detectScale(description: string): string | undefined {
  const lower = description.toLowerCase();

  // Employee count patterns
  const employeeMatch = /(\d[\d,]*)\s*(?:employees?|workers?|staff|people|headcount)/i.exec(lower);
  if (employeeMatch?.[1]) {
    const count = parseInt(employeeMatch[1].replace(/,/g, ''), 10);
    if (count >= 50_000) return 'mega-enterprise (50,000+ employees)';
    if (count >= 10_000) return 'large-enterprise (10,000+ employees)';
    if (count >= 1_000) return 'mid-enterprise (1,000+ employees)';
    if (count >= 100) return 'growth-stage (100+ employees)';
    return `small-team (${count} employees)`;
  }

  // Revenue patterns
  if (/\$?\d+\s*[bt]illion/i.test(lower)) return 'mega-enterprise';
  if (/\$?\d+\s*billion/i.test(lower) || /fortune\s*(100|500)/i.test(lower)) return 'large-enterprise';
  if (/\$?\d+\s*million/i.test(lower)) return 'mid-enterprise';

  // Keyword-based
  if (lower.includes('enterprise') || lower.includes('global') || lower.includes('multinational')) return 'enterprise';
  if (lower.includes('startup') || lower.includes('small business')) return 'growth-stage';

  return undefined;
}

// ============================================================================
// Core Resolution Function
// ============================================================================

/**
 * Resolve a simulation profile from a natural-language description.
 *
 * Analyzes the description to determine:
 * 1. Simulation category (enterprise AI, compliance, financial, etc.)
 * 2. Which downstream platform services are relevant
 * 3. Which agent types should be deployed
 * 4. Industry vertical and organizational scale
 *
 * This is used at prompt-construction time to dynamically tailor
 * the synthesis prompt to the specific simulation type.
 */
export function resolveSimulationProfile(description: string): SimulationProfile {
  const lower = description.toLowerCase();

  // Score each category
  const scores: Array<{ category: SimulationCategory; score: number }> = [];

  for (const pattern of CATEGORY_PATTERNS) {
    let score = 0;

    // Score keywords (1 point each)
    for (const keyword of pattern.keywords) {
      if (lower.includes(keyword)) {
        score += 1;
      }
    }

    // Score phrases (3 points each — more specific = higher weight)
    for (const phrase of pattern.phrases) {
      if (lower.includes(phrase)) {
        score += 3;
      }
    }

    // Apply category weight
    score *= pattern.weight;

    if (score > 0) {
      scores.push({ category: pattern.category, score });
    }
  }

  // Sort by score descending
  scores.sort((a, b) => b.score - a.score);

  // Pick primary category (or 'general' if nothing matched)
  const topScore = scores[0];
  const primaryCategory: SimulationCategory = topScore ? topScore.category : 'general';
  const primaryScore = topScore ? topScore.score : 0;

  // Normalize confidence to 0-1 range (cap at score=15 for max confidence)
  const confidence = Math.min(primaryScore / 15, 1.0);

  // Detect industry
  let industry: string | undefined;
  for (const pattern of INDUSTRY_PATTERNS) {
    for (const keyword of pattern.keywords) {
      if (lower.includes(keyword)) {
        industry = pattern.industry;
        break;
      }
    }
    if (industry) break;
  }

  // Detect scale
  const scale = detectScale(description);

  // Resolve downstream services for primary category
  const serviceEntries = CATEGORY_SERVICE_MAP[primaryCategory];
  const services: DownstreamService[] = [];
  for (const entry of serviceEntries) {
    const catalog = SERVICE_CATALOG[entry.service];
    if (catalog) {
      services.push({
        name: catalog.name,
        purpose: catalog.purpose,
        apiSurface: catalog.apiSurface,
        repo: catalog.repo,
        contractSchema: catalog.contractSchema,
        priority: entry.priority,
      });
    }
  }

  // If secondary categories have high scores, add their primary services too
  for (let i = 1; i < scores.length && i < 3; i++) {
    const secondaryEntry = scores[i];
    if (secondaryEntry && secondaryEntry.score >= primaryScore * 0.5) {
      const secondaryServices = CATEGORY_SERVICE_MAP[secondaryEntry.category];
      for (const entry of secondaryServices) {
        if (entry.priority === 'primary' && !services.some(s => s.name === entry.service)) {
          const catalog = SERVICE_CATALOG[entry.service];
          if (catalog) {
            services.push({
              name: catalog.name,
              purpose: catalog.purpose,
              apiSurface: catalog.apiSurface,
              repo: catalog.repo,
              contractSchema: catalog.contractSchema,
              priority: 'supporting',
            });
          }
        }
      }
    }
  }

  // Resolve agents for primary category
  const agentEntries = CATEGORY_AGENT_MAP[primaryCategory];
  const agents: AgentProfile[] = [];
  for (const entry of agentEntries) {
    const catalog = AGENT_CATALOG[entry.agent];
    if (catalog) {
      agents.push({
        type: catalog.type,
        outputs: catalog.outputs,
        role: entry.role,
      });
    }
  }

  // Build platform layers list
  const layers = buildLayersList(services);

  return {
    category: primaryCategory,
    confidence,
    detectedCategories: scores,
    services,
    agents,
    layers,
    industry,
    scale,
  };
}

/**
 * Build a human-readable list of platform layers from activated services.
 */
function buildLayersList(services: DownstreamService[]): string[] {
  const layers: string[] = ['synthesis', 'validation', 'artifact-generation'];

  const serviceNames = new Set(services.map(s => s.name));

  if (serviceNames.has('agentics-org-manifests')) layers.push('manifest-selection');
  if (serviceNames.has('agentics-simulation-planner')) layers.push('plan-generation');
  if (serviceNames.has('agentics-simulation-runner')) layers.push('simulation-execution');
  if (serviceNames.has('agentics-simulation-engine')) layers.push('compute-engine');
  if (serviceNames.has('agentics-results-index')) layers.push('results-indexing');
  if (serviceNames.has('enterprise-roi-engine')) layers.push('roi-quantification');
  if (serviceNames.has('agentics-deployment-intent')) layers.push('deployment-intent');
  if (serviceNames.has('agentics-deployment-exporters')) layers.push('iac-export');
  if (serviceNames.has('diligence-artifacts')) layers.push('compliance-diligence');
  if (serviceNames.has('ruvector-service')) layers.push('persistent-storage');

  return layers;
}

// ============================================================================
// Prompt Context Generation
// ============================================================================

/**
 * Generate prompt context from a simulation profile.
 *
 * Produces a structured text block that is injected into the synthesis
 * prompt to tell the LLM which platform services, agents, and layers
 * are activated for this specific simulation.
 */
export function generatePromptContext(profile: SimulationProfile): string {
  const lines: string[] = [];

  lines.push('=== DYNAMIC PLATFORM ROUTING ===');
  lines.push('Architecture: agentics-contracts (schemas) → agentics-cli (orchestration) → agentics-platform (services) → ruvector-service (persistence)');
  lines.push('');
  lines.push(`Category: ${profile.category.replace(/_/g, ' ').toUpperCase()}`);
  lines.push(`Confidence: ${(profile.confidence * 100).toFixed(0)}%`);
  if (profile.industry) {
    lines.push(`Industry: ${profile.industry.replace(/_/g, ' ')}`);
  }
  if (profile.scale) {
    lines.push(`Scale: ${profile.scale}`);
  }
  lines.push('');

  // Downstream services
  lines.push('ACTIVATED DOWNSTREAM REPOS from agentics-platform:');
  const primaryServices = profile.services.filter(s => s.priority === 'primary');
  const supportingServices = profile.services.filter(s => s.priority === 'supporting');

  if (primaryServices.length > 0) {
    lines.push('');
    lines.push('  PRIMARY (core to this simulation type):');
    for (const service of primaryServices) {
      lines.push(`    ${service.repo}`);
      lines.push(`      Purpose: ${service.purpose}`);
      lines.push(`      API: ${service.apiSurface}`);
      lines.push(`      Contract: ${service.contractSchema}`);
    }
  }

  if (supportingServices.length > 0) {
    lines.push('');
    lines.push('  SUPPORTING (contextual enrichment):');
    for (const service of supportingServices) {
      lines.push(`    ${service.repo}`);
      lines.push(`      Purpose: ${service.purpose}`);
      lines.push(`      Contract: ${service.contractSchema}`);
    }
  }
  lines.push('');

  // Persistence layer
  const ruvector = profile.services.find(s => s.name === 'ruvector-service');
  if (ruvector) {
    lines.push('PERSISTENCE LAYER (ruvector-service — always active per ADR-004):');
    lines.push('  All simulation artifacts, plans, decisions, and lineage records are persisted.');
    lines.push('  Endpoints: /v1/simulations, /v1/plans, /v1/decisions, /v1/lineage, /v1/erp-mappings');
    lines.push('');
  }

  // Agent deployments
  lines.push('AGENTS TO DEPLOY IN SIMULATION (include these in phases.agents_deployed):');
  for (const agent of profile.agents) {
    lines.push(`  - ${agent.type}: ${agent.role}`);
    lines.push(`    Outputs: ${agent.outputs.join(', ')}`);
  }
  lines.push('');

  // Platform layers
  lines.push(`PLATFORM LAYERS EXECUTED: ${profile.layers.join(' → ')}`);
  lines.push('');

  // Instructions
  lines.push('ROUTING INSTRUCTIONS:');
  lines.push('- Every phase MUST reference at least one activated downstream repo by name');
  lines.push('- Agent deployments MUST use the agent types listed above');
  lines.push('- The technology_architecture.platforms[] MUST include activated repos with their contract schemas');
  lines.push('- The execution_metadata.layers_executed MUST match the platform layers above');
  lines.push('- Include a "routing" object in your output with: category, confidence, industry, scale, services[], agents[], layers[]');
  lines.push('- Each service in routing.services[] must have: name, repo, purpose, contract_schema');
  lines.push('- All outputs validated against agentics-contracts response schemas');
  lines.push('- All artifacts persisted to ruvector-service');

  return lines.join('\n');
}

/**
 * Resolve profile for any command type, not just simulations.
 * For non-simulate commands, returns a minimal profile based on command type.
 */
export function resolveCommandProfile(
  command: string,
  subcommand: string,
  description: string,
): SimulationProfile | null {
  // Only simulate.create gets full dynamic routing for now
  if (command === 'simulate' && subcommand === 'create') {
    return resolveSimulationProfile(description);
  }

  // Plan create also benefits from context-aware routing
  if (command === 'plan' && subcommand === 'create') {
    return resolveSimulationProfile(description);
  }

  // Quantify create benefits from financial routing
  if (command === 'quantify' && subcommand === 'create') {
    const profile = resolveSimulationProfile(description);
    // Ensure ROI engine is primary
    const roiService = profile.services.find(s => s.name === 'enterprise-roi-engine');
    if (roiService) {
      roiService.priority = 'primary';
    }
    return profile;
  }

  return null;
}
