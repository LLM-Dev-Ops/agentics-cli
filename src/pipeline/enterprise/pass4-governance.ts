/**
 * Pass 4 — Governance, Compliance & CostOps (ADR-036)
 *
 * Executes four concurrent workstreams that converge into a unified
 * Governance Convergence Report stored in the DecisionGraph:
 *
 *   Workstream A: Security & Compliance Analysis (LLM-Shield)
 *   Workstream B: Policy Enforcement (LLM-Policy-Engine)
 *   Workstream C: Financial Modeling (LLM-CostOps)
 *   Workstream D: Governance Visibility (LLM-Governance-Dashboard)
 *
 * Key design: simulation data (Pass 2) feeds directly into cost models.
 * Security findings (Workstream A) inform policy analysis (Workstream B).
 */

import type {
  PassNumber,
  AgentRef,
  AgentInvocationResult,
} from './types.js';
import { DecisionGraph } from './decision-graph.js';
import { ProvenanceTracker } from './provenance-tracker.js';

// ============================================================================
// Domain Types (ADR-036 Interfaces)
// ============================================================================

// ── Shared Levels ──

export type RiskLevel = 'critical' | 'high' | 'medium' | 'low';
export type EffortLevel = 'low' | 'medium' | 'high';
export type ComplianceStatus = 'compliant' | 'gaps_identified' | 'non_compliant';
export type ExplainabilityScore = 'full' | 'partial' | 'opaque';
export type ReadinessScore = 'ready' | 'conditionally_ready' | 'not_ready';
export type ConfidenceLevel = 'high' | 'medium' | 'low';

// ── Workstream A: Security Analysis ──

export interface DataExposure {
  readonly dataType: string;
  readonly location: string;
  readonly risk: string;
  readonly remediation: string;
}

export interface SafetyAssessment {
  readonly injectionVectors: readonly string[];
  readonly contentRisks: readonly string[];
  readonly boundaryViolations: readonly string[];
}

export interface CredentialAnalysis {
  readonly authFlows: readonly string[];
  readonly storageLocations: readonly string[];
  readonly abuseVectors: readonly string[];
}

export interface RemediationPriority {
  readonly finding: string;
  readonly severity: RiskLevel;
  readonly effort: EffortLevel;
  readonly recommendation: string;
}

export interface SecurityAnalysis {
  readonly overallRiskLevel: RiskLevel;
  readonly dataExposureMap: readonly DataExposure[];
  readonly safetyAssessment: SafetyAssessment;
  readonly credentialAnalysis: CredentialAnalysis;
  readonly remediationPriorities: readonly RemediationPriority[];
}

// ── Workstream B: Policy Analysis ──

export interface RegulatoryFramework {
  readonly framework: string;
  readonly applicability: string;
  readonly complianceGaps: readonly string[];
  readonly remediationSteps: readonly string[];
}

export interface AIGovernance {
  readonly explainabilityScore: ExplainabilityScore;
  readonly biasAssessment: string;
  readonly humanOversightRequired: boolean;
  readonly requirements: readonly string[];
}

export interface ApprovalRoute {
  readonly approver: string;
  readonly reason: string;
  readonly threshold: string;
}

export interface PolicyAnalysis {
  readonly applicableFrameworks: readonly RegulatoryFramework[];
  readonly aiGovernance: AIGovernance;
  readonly approvalRouting: readonly ApprovalRoute[];
  readonly overallComplianceStatus: ComplianceStatus;
}

// ── Workstream C: Cost Model ──

export interface InfrastructureCost {
  readonly category: string;
  readonly provider: string;
  readonly monthlyCost: number;
  readonly annualCost: number;
  readonly assumptions: readonly string[];
}

export interface IntegrationCost {
  readonly system: string;
  readonly setupCost: number;
  readonly ongoingMonthlyCost: number;
  readonly assumptions: readonly string[];
}

export interface OperationalCost {
  readonly category: string;
  readonly annualCost: number;
  readonly fteRequired: number;
}

export interface TCOProjection {
  readonly year1: number;
  readonly year3: number;
  readonly year5: number;
}

export interface ROIProjection {
  readonly expectedReturn: number;
  readonly paybackPeriodMonths: number;
  readonly confidenceLevel: ConfidenceLevel;
}

export interface ScenarioVariant {
  readonly scenarioId: string;
  readonly scenarioName: string;
  readonly costDelta: number;
  readonly explanation: string;
}

export interface BudgetRisk {
  readonly contingencyRequired: number;
  readonly budgetExceedanceProbability: number;
  readonly riskFactors: readonly string[];
}

export interface CostModel {
  readonly infrastructure: readonly InfrastructureCost[];
  readonly integrationCosts: readonly IntegrationCost[];
  readonly operationalCosts: readonly OperationalCost[];
  readonly tco: TCOProjection;
  readonly roi: ROIProjection;
  readonly scenarioVariants: readonly ScenarioVariant[];
  readonly budgetRisk: BudgetRisk;
}

// ── Workstream D: Governance Report ──

export interface AuditTrailEntry {
  readonly decision: string;
  readonly madeBy: string;
  readonly timestamp: string;
  readonly rationale: string;
  readonly dataInputs: readonly string[];
}

export interface ChangeImpactEntry {
  readonly affectedSystem: string;
  readonly changeType: string;
  readonly impactLevel: RiskLevel;
  readonly stakeholders: readonly string[];
}

export interface GovernanceReadiness {
  readonly overallScore: ReadinessScore;
  readonly conditions: readonly string[];
  readonly strengths: readonly string[];
  readonly gaps: readonly string[];
}

export interface GovernanceReport {
  readonly auditTrail: readonly AuditTrailEntry[];
  readonly changeImpact: readonly ChangeImpactEntry[];
  readonly governanceReadiness: GovernanceReadiness;
}

// ── Convergence ──

export interface GovernanceConvergence {
  readonly securityRiskLevel: RiskLevel;
  readonly complianceStatus: ComplianceStatus;
  readonly financialViability: ConfidenceLevel;
  readonly governanceReadiness: ReadinessScore;
  readonly overallAssessment: string;
}

// ============================================================================
// Workstream Definitions
// ============================================================================

export type Pass4WorkstreamId =
  | 'security-compliance'
  | 'policy-enforcement'
  | 'financial-modeling'
  | 'governance-visibility';

export interface Pass4WorkstreamConfig {
  readonly id: Pass4WorkstreamId;
  readonly label: string;
  readonly agents: readonly AgentRef[];
}

export const PASS4_WORKSTREAM_CONFIGS: readonly Pass4WorkstreamConfig[] = [
  {
    id: 'security-compliance',
    label: 'Security & Compliance Analysis (LLM-Shield)',
    agents: [
      { domain: 'shield', agent: 'prompt-injection', role: 'Prompt injection detection' },
      { domain: 'shield', agent: 'pii', role: 'PII detection' },
      { domain: 'shield', agent: 'redaction', role: 'Data redaction' },
      { domain: 'shield', agent: 'secrets', role: 'Secrets leakage detection' },
      { domain: 'shield', agent: 'toxicity', role: 'Toxicity detection' },
      { domain: 'shield', agent: 'safety-boundary', role: 'Safety boundary enforcement' },
      { domain: 'shield', agent: 'moderation', role: 'Content moderation' },
      { domain: 'shield', agent: 'abuse', role: 'Model abuse detection' },
      { domain: 'shield', agent: 'credential-exposure', role: 'Credential exposure detection' },
    ],
  },
  {
    id: 'policy-enforcement',
    label: 'Policy Enforcement (LLM-Policy-Engine)',
    agents: [
      { domain: 'policy-engine', agent: 'enforce', role: 'Policy enforcement' },
      { domain: 'policy-engine', agent: 'constraints', role: 'Constraint solver' },
      { domain: 'policy-engine', agent: 'approval', role: 'Approval routing' },
    ],
  },
  {
    id: 'financial-modeling',
    label: 'Financial Modeling (LLM-CostOps)',
    agents: [
      { domain: 'costops', agent: 'attribution', role: 'Cost attribution' },
      { domain: 'costops', agent: 'forecast', role: 'Cost forecasting' },
      { domain: 'costops', agent: 'budget', role: 'Budget enforcement' },
      { domain: 'costops', agent: 'roi', role: 'ROI estimation' },
      { domain: 'costops', agent: 'tradeoff', role: 'Cost-performance tradeoff' },
    ],
  },
  {
    id: 'governance-visibility',
    label: 'Governance Visibility (LLM-Governance-Dashboard)',
    agents: [
      { domain: 'governance-dashboard', agent: 'audit', role: 'Governance audit' },
      { domain: 'governance-dashboard', agent: 'impact', role: 'Change impact' },
      { domain: 'governance-dashboard', agent: 'oversight', role: 'Usage oversight' },
    ],
  },
];

// ============================================================================
// Workstream Result Types
// ============================================================================

export interface Pass4WorkstreamResult {
  readonly workstream: Pass4WorkstreamId;
  readonly label: string;
  readonly agentResults: readonly AgentInvocationResult[];
  readonly successCount: number;
  readonly totalCount: number;
  readonly durationMs: number;
}

export interface Pass4Result {
  readonly workstreamResults: readonly Pass4WorkstreamResult[];
  readonly securityAnalysis: SecurityAnalysis;
  readonly policyAnalysis: PolicyAnalysis;
  readonly costModel: CostModel;
  readonly governanceReport: GovernanceReport;
  readonly convergence: GovernanceConvergence;
  readonly graphNodeIds: readonly string[];
  readonly totalAgentResults: readonly AgentInvocationResult[];
}

// ============================================================================
// Pass 4 Executor
// ============================================================================

/**
 * Execute Pass 4: Governance, Compliance & CostOps.
 *
 * Dispatches four workstreams concurrently, processes results into
 * typed domain objects, converges into a GovernanceConvergence report,
 * and writes all outputs to the DecisionGraph.
 */
export async function executePass4(params: {
  prompt: string;
  graph: DecisionGraph;
  tracker: ProvenanceTracker;
  timeoutMs: number;
  verbose: boolean;
  invokeAgents?: (agents: readonly AgentRef[], payload: Record<string, unknown>, pass: PassNumber, timeoutMs: number) => Promise<AgentInvocationResult[]>;
}): Promise<Pass4Result> {
  const { prompt, graph, tracker, timeoutMs, verbose } = params;
  const pass: PassNumber = 4;

  // Build context from Passes 1-3
  const priorContext = buildPriorContext(graph);

  const payload: Record<string, unknown> = {
    prompt,
    pass: 4,
    passName: 'Governance, Compliance & CostOps',
    context: priorContext,
  };

  const invoke = params.invokeAgents ?? defaultInvokeAgents;

  if (verbose) {
    console.error(`  [Pass 4] Starting 4 concurrent workstreams`);
  }

  // ── Execute all 4 workstreams concurrently ──
  const workstreamPromises = PASS4_WORKSTREAM_CONFIGS.map(async (ws): Promise<Pass4WorkstreamResult> => {
    const wsStart = Date.now();
    if (verbose) {
      console.error(`  [Pass 4] Workstream: ${ws.label} (${ws.agents.length} agents)`);
    }
    const results = await invoke(ws.agents, payload, pass, timeoutMs);
    const successCount = results.filter(r => r.status >= 200 && r.status < 300).length;
    return {
      workstream: ws.id,
      label: ws.label,
      agentResults: results,
      successCount,
      totalCount: results.length,
      durationMs: Date.now() - wsStart,
    };
  });

  const workstreamResults = await Promise.all(workstreamPromises);

  const allResults: AgentInvocationResult[] = [];
  for (const ws of workstreamResults) {
    for (const r of ws.agentResults) {
      allResults.push(r);
    }
  }

  // ── Extract typed domain objects per workstream ──
  const wsA = workstreamResults.find(w => w.workstream === 'security-compliance');
  const wsB = workstreamResults.find(w => w.workstream === 'policy-enforcement');
  const wsC = workstreamResults.find(w => w.workstream === 'financial-modeling');
  const wsD = workstreamResults.find(w => w.workstream === 'governance-visibility');

  const securityAnalysis = extractSecurityAnalysis(wsA);
  const policyAnalysis = extractPolicyAnalysis(wsB, priorContext);
  const costModel = extractCostModel(wsC, graph);
  const governanceReport = extractGovernanceReport(wsD, graph);

  // ── Converge ──
  const convergence = buildConvergence(securityAnalysis, policyAnalysis, costModel, governanceReport);

  // ── Write to DecisionGraph ──
  const graphNodeIds = writeToGraph(graph, securityAnalysis, policyAnalysis, costModel, governanceReport, convergence, tracker, pass);

  if (verbose) {
    console.error(`  [Pass 4] Complete: security=${securityAnalysis.overallRiskLevel}, compliance=${policyAnalysis.overallComplianceStatus}, governance=${governanceReport.governanceReadiness.overallScore}`);
  }

  return {
    workstreamResults,
    securityAnalysis,
    policyAnalysis,
    costModel,
    governanceReport,
    convergence,
    graphNodeIds,
    totalAgentResults: allResults,
  };
}

// ============================================================================
// Prior Context Builder
// ============================================================================

function buildPriorContext(graph: DecisionGraph): Record<string, unknown> {
  const ctx: Record<string, unknown> = {};

  // Pass 1
  for (const n of graph.getNodesByPass(1)) {
    if (n.type === 'business_context') ctx['businessContext'] = { summary: n.summary, ...n.content };
    if (n.type === 'problem_definition') ctx['problemDefinition'] = { summary: n.summary, ...n.content };
    if (n.type === 'technical_scope') ctx['technicalScope'] = { summary: n.summary, ...n.content };
  }

  // Pass 2 — scenarios & risk signals feed into CostOps
  const scenarios: unknown[] = [];
  const riskSignals: unknown[] = [];
  for (const n of graph.getNodesByPass(2)) {
    if (n.type === 'scenario') scenarios.push({ summary: n.summary, ...n.content });
    if (n.type === 'risk_signal') riskSignals.push({ summary: n.summary, ...n.content });
    if (n.type === 'reliability_report') ctx['reliabilityReport'] = { summary: n.summary, ...n.content };
  }
  ctx['scenarios'] = scenarios;
  ctx['riskSignals'] = riskSignals;

  // Pass 3 — architecture
  for (const n of graph.getNodesByPass(3)) {
    if (n.type === 'system_architecture') ctx['architecture'] = { summary: n.summary, ...n.content };
    if (n.type === 'integration_map') ctx['integrationMap'] = { summary: n.summary, ...n.content };
    if (n.type === 'prototype') ctx['prototype'] = { summary: n.summary, ...n.content };
  }

  return ctx;
}

// ============================================================================
// Workstream A: Security Analysis Extraction
// ============================================================================

function extractSecurityAnalysis(ws: Pass4WorkstreamResult | undefined): SecurityAnalysis {
  const defaults: SecurityAnalysis = {
    overallRiskLevel: 'medium',
    dataExposureMap: [],
    safetyAssessment: { injectionVectors: [], contentRisks: [], boundaryViolations: [] },
    credentialAnalysis: { authFlows: [], storageLocations: [], abuseVectors: [] },
    remediationPriorities: [],
  };
  if (!ws || ws.successCount === 0) return defaults;

  const exposures: DataExposure[] = [];
  const injVectors: string[] = [];
  const contentRisks: string[] = [];
  const boundaryViolations: string[] = [];
  const authFlows: string[] = [];
  const storageLocations: string[] = [];
  const abuseVectors: string[] = [];
  const remediations: RemediationPriority[] = [];
  let worstRisk: RiskLevel = 'low';

  for (const result of ws.agentResults) {
    if (result.status < 200 || result.status >= 300 || !result.response) continue;
    const resp = result.response as Record<string, unknown>;
    const agentName = result.agent.agent;

    // Data protection agents
    if (['pii', 'redaction', 'secrets'].includes(agentName)) {
      const items = extractArray(resp, 'exposures', 'findings', 'data');
      for (const item of items) {
        if (typeof item === 'object' && item !== null) {
          const r = item as Record<string, unknown>;
          exposures.push({
            dataType: String(r['dataType'] ?? r['type'] ?? agentName),
            location: String(r['location'] ?? ''),
            risk: String(r['risk'] ?? ''),
            remediation: String(r['remediation'] ?? ''),
          });
        }
      }
    }

    // Safety agents
    if (['prompt-injection', 'toxicity', 'safety-boundary', 'moderation'].includes(agentName)) {
      const vectors = extractStringArray(resp, 'vectors', 'injectionVectors', 'findings');
      const risks = extractStringArray(resp, 'risks', 'contentRisks');
      const violations = extractStringArray(resp, 'violations', 'boundaryViolations');
      injVectors.push(...vectors);
      contentRisks.push(...risks);
      boundaryViolations.push(...violations);
    }

    // Credential agents
    if (['credential-exposure', 'abuse'].includes(agentName)) {
      authFlows.push(...extractStringArray(resp, 'authFlows', 'flows'));
      storageLocations.push(...extractStringArray(resp, 'storageLocations', 'locations'));
      abuseVectors.push(...extractStringArray(resp, 'abuseVectors', 'vectors'));
    }

    // Remediation from any agent
    const rems = extractArray(resp, 'remediations', 'remediationPriorities', 'recommendations');
    for (const item of rems) {
      if (typeof item === 'object' && item !== null) {
        const r = item as Record<string, unknown>;
        remediations.push({
          finding: String(r['finding'] ?? r['description'] ?? ''),
          severity: normalizeRiskLevel(r['severity']),
          effort: normalizeEffort(r['effort']),
          recommendation: String(r['recommendation'] ?? ''),
        });
      }
    }

    const level = normalizeRiskLevel(resp['riskLevel'] ?? resp['overallRiskLevel'] ?? resp['severity']);
    worstRisk = worstOf(worstRisk, level);
  }

  return {
    overallRiskLevel: worstRisk,
    dataExposureMap: exposures,
    safetyAssessment: { injectionVectors: injVectors, contentRisks, boundaryViolations },
    credentialAnalysis: { authFlows, storageLocations, abuseVectors },
    remediationPriorities: remediations,
  };
}

// ============================================================================
// Workstream B: Policy Analysis Extraction
// ============================================================================

function extractPolicyAnalysis(ws: Pass4WorkstreamResult | undefined, _context: Record<string, unknown>): PolicyAnalysis {
  const defaults: PolicyAnalysis = {
    applicableFrameworks: [],
    aiGovernance: { explainabilityScore: 'partial', biasAssessment: '', humanOversightRequired: true, requirements: [] },
    approvalRouting: [],
    overallComplianceStatus: 'gaps_identified',
  };
  if (!ws || ws.successCount === 0) return defaults;

  const frameworks: RegulatoryFramework[] = [];
  const approvals: ApprovalRoute[] = [];
  let aiGov = defaults.aiGovernance;
  let complianceStatus: ComplianceStatus = 'compliant';

  for (const result of ws.agentResults) {
    if (result.status < 200 || result.status >= 300 || !result.response) continue;
    const resp = result.response as Record<string, unknown>;

    // Frameworks
    const fws = extractArray(resp, 'frameworks', 'applicableFrameworks', 'regulations');
    for (const item of fws) {
      if (typeof item === 'object' && item !== null) {
        const r = item as Record<string, unknown>;
        frameworks.push({
          framework: String(r['framework'] ?? r['name'] ?? ''),
          applicability: String(r['applicability'] ?? r['reason'] ?? ''),
          complianceGaps: extractStringArray(r, 'complianceGaps', 'gaps'),
          remediationSteps: extractStringArray(r, 'remediationSteps', 'remediation', 'steps'),
        });
      } else if (typeof item === 'string') {
        frameworks.push({ framework: item, applicability: 'Detected from context', complianceGaps: [], remediationSteps: [] });
      }
    }

    // AI Governance
    if (resp['aiGovernance'] && typeof resp['aiGovernance'] === 'object') {
      const ag = resp['aiGovernance'] as Record<string, unknown>;
      aiGov = {
        explainabilityScore: normalizeExplainability(ag['explainabilityScore']),
        biasAssessment: String(ag['biasAssessment'] ?? ''),
        humanOversightRequired: ag['humanOversightRequired'] !== false,
        requirements: extractStringArray(ag, 'requirements'),
      };
    }

    // Approval routing
    const apprs = extractArray(resp, 'approvalRouting', 'approvals');
    for (const item of apprs) {
      if (typeof item === 'object' && item !== null) {
        const r = item as Record<string, unknown>;
        approvals.push({
          approver: String(r['approver'] ?? r['role'] ?? ''),
          reason: String(r['reason'] ?? ''),
          threshold: String(r['threshold'] ?? ''),
        });
      }
    }

    // Compliance status
    const status = normalizeComplianceStatus(resp['complianceStatus'] ?? resp['overallComplianceStatus']);
    if (status === 'non_compliant') complianceStatus = 'non_compliant';
    else if (status === 'gaps_identified' && complianceStatus !== 'non_compliant') complianceStatus = 'gaps_identified';
  }

  // If no frameworks detected but gaps exist, mark as gaps_identified
  if (frameworks.length === 0) complianceStatus = 'gaps_identified';

  return { applicableFrameworks: frameworks, aiGovernance: aiGov, approvalRouting: approvals, overallComplianceStatus: complianceStatus };
}

// ============================================================================
// Workstream C: Cost Model Extraction
// ============================================================================

function extractCostModel(ws: Pass4WorkstreamResult | undefined, graph: DecisionGraph): CostModel {
  const defaults: CostModel = {
    infrastructure: [],
    integrationCosts: [],
    operationalCosts: [],
    tco: { year1: 0, year3: 0, year5: 0 },
    roi: { expectedReturn: 0, paybackPeriodMonths: 0, confidenceLevel: 'low' },
    scenarioVariants: [],
    budgetRisk: { contingencyRequired: 0, budgetExceedanceProbability: 0, riskFactors: [] },
  };
  if (!ws || ws.successCount === 0) return defaults;

  const infra: InfrastructureCost[] = [];
  const integ: IntegrationCost[] = [];
  const ops: OperationalCost[] = [];
  let tco = defaults.tco;
  let roi = defaults.roi;
  const variants: ScenarioVariant[] = [];
  let budgetRisk = defaults.budgetRisk;

  for (const result of ws.agentResults) {
    if (result.status < 200 || result.status >= 300 || !result.response) continue;
    const resp = result.response as Record<string, unknown>;

    // Infrastructure costs
    for (const item of extractArray(resp, 'infrastructure', 'infrastructureCosts')) {
      if (typeof item === 'object' && item !== null) {
        const r = item as Record<string, unknown>;
        infra.push({
          category: String(r['category'] ?? ''),
          provider: String(r['provider'] ?? ''),
          monthlyCost: Number(r['monthlyCost'] ?? r['monthly_cost'] ?? 0),
          annualCost: Number(r['annualCost'] ?? r['annual_cost'] ?? 0),
          assumptions: extractStringArray(r, 'assumptions'),
        });
      }
    }

    // Integration costs
    for (const item of extractArray(resp, 'integrationCosts', 'integrations')) {
      if (typeof item === 'object' && item !== null) {
        const r = item as Record<string, unknown>;
        integ.push({
          system: String(r['system'] ?? r['name'] ?? ''),
          setupCost: Number(r['setupCost'] ?? r['setup_cost'] ?? 0),
          ongoingMonthlyCost: Number(r['ongoingMonthlyCost'] ?? r['monthly_cost'] ?? 0),
          assumptions: extractStringArray(r, 'assumptions'),
        });
      }
    }

    // Operational costs
    for (const item of extractArray(resp, 'operationalCosts', 'operational')) {
      if (typeof item === 'object' && item !== null) {
        const r = item as Record<string, unknown>;
        ops.push({
          category: String(r['category'] ?? ''),
          annualCost: Number(r['annualCost'] ?? r['annual_cost'] ?? 0),
          fteRequired: Number(r['fteRequired'] ?? r['fte'] ?? 0),
        });
      }
    }

    // TCO
    if (resp['tco'] && typeof resp['tco'] === 'object') {
      const t = resp['tco'] as Record<string, unknown>;
      tco = {
        year1: Number(t['year1'] ?? 0),
        year3: Number(t['year3'] ?? 0),
        year5: Number(t['year5'] ?? 0),
      };
    }

    // ROI
    if (resp['roi'] && typeof resp['roi'] === 'object') {
      const r = resp['roi'] as Record<string, unknown>;
      roi = {
        expectedReturn: Number(r['expectedReturn'] ?? r['expected_return'] ?? 0),
        paybackPeriodMonths: Number(r['paybackPeriodMonths'] ?? r['payback_months'] ?? 0),
        confidenceLevel: normalizeConfidence(r['confidenceLevel'] ?? r['confidence']),
      };
    }

    // Budget risk
    if (resp['budgetRisk'] && typeof resp['budgetRisk'] === 'object') {
      const b = resp['budgetRisk'] as Record<string, unknown>;
      budgetRisk = {
        contingencyRequired: Number(b['contingencyRequired'] ?? 0),
        budgetExceedanceProbability: Number(b['budgetExceedanceProbability'] ?? 0),
        riskFactors: extractStringArray(b, 'riskFactors', 'factors'),
      };
    }
  }

  // Build scenario variants from Pass 2 scenarios
  const scenarioNodes = graph.getNodesByType('scenario');
  for (const sn of scenarioNodes) {
    if (sn.pass !== 2) continue;
    const sc = sn.content;
    variants.push({
      scenarioId: sn.id,
      scenarioName: String(sc['name'] ?? sn.name),
      costDelta: Number(sc['costDelta'] ?? 0),
      explanation: String(sc['mitigationStrategy'] ?? sc['description'] ?? ''),
    });
  }

  return { infrastructure: infra, integrationCosts: integ, operationalCosts: ops, tco, roi, scenarioVariants: variants, budgetRisk };
}

// ============================================================================
// Workstream D: Governance Report Extraction
// ============================================================================

function extractGovernanceReport(ws: Pass4WorkstreamResult | undefined, graph: DecisionGraph): GovernanceReport {
  const defaults: GovernanceReport = {
    auditTrail: [],
    changeImpact: [],
    governanceReadiness: { overallScore: 'not_ready', conditions: [], strengths: [], gaps: [] },
  };

  const auditTrail: AuditTrailEntry[] = [];
  const changes: ChangeImpactEntry[] = [];
  let readiness = defaults.governanceReadiness;

  if (!ws || ws.successCount === 0) {
    // Fall through to auto-audit logic below
  } else {

  for (const result of ws.agentResults) {
    if (result.status < 200 || result.status >= 300 || !result.response) continue;
    const resp = result.response as Record<string, unknown>;

    // Audit trail
    for (const item of extractArray(resp, 'auditTrail', 'audit', 'decisions')) {
      if (typeof item === 'object' && item !== null) {
        const r = item as Record<string, unknown>;
        auditTrail.push({
          decision: String(r['decision'] ?? ''),
          madeBy: String(r['madeBy'] ?? r['agent'] ?? ''),
          timestamp: String(r['timestamp'] ?? new Date().toISOString()),
          rationale: String(r['rationale'] ?? ''),
          dataInputs: extractStringArray(r, 'dataInputs', 'inputs'),
        });
      }
    }

    // Change impact
    for (const item of extractArray(resp, 'changeImpact', 'changes', 'impacts')) {
      if (typeof item === 'object' && item !== null) {
        const r = item as Record<string, unknown>;
        changes.push({
          affectedSystem: String(r['affectedSystem'] ?? r['system'] ?? ''),
          changeType: String(r['changeType'] ?? r['type'] ?? ''),
          impactLevel: normalizeRiskLevel(r['impactLevel'] ?? r['impact']),
          stakeholders: extractStringArray(r, 'stakeholders'),
        });
      }
    }

    // Governance readiness
    if (resp['governanceReadiness'] && typeof resp['governanceReadiness'] === 'object') {
      const g = resp['governanceReadiness'] as Record<string, unknown>;
      readiness = {
        overallScore: normalizeReadiness(g['overallScore'] ?? g['score']),
        conditions: extractStringArray(g, 'conditions'),
        strengths: extractStringArray(g, 'strengths'),
        gaps: extractStringArray(g, 'gaps'),
      };
    }
  }
  } // end else (ws has successful agents)

  // Auto-generate audit trail from prior graph nodes if none from agents
  if (auditTrail.length === 0) {
    for (const n of graph.getAllNodes()) {
      if (n.pass <= 3) {
        auditTrail.push({
          decision: `${n.type}: ${n.name}`,
          madeBy: `${n.producedBy.domain}/${n.producedBy.agent}`,
          timestamp: n.timestamp,
          rationale: n.summary,
          dataInputs: [...n.derivedFrom].slice(0, 5),
        });
      }
    }
  }

  return { auditTrail, changeImpact: changes, governanceReadiness: readiness };
}

// ============================================================================
// Convergence
// ============================================================================

function buildConvergence(
  security: SecurityAnalysis,
  policy: PolicyAnalysis,
  cost: CostModel,
  governance: GovernanceReport,
): GovernanceConvergence {
  const financialViability: ConfidenceLevel =
    cost.roi.expectedReturn > 0 && cost.tco.year1 > 0 ? cost.roi.confidenceLevel
    : cost.tco.year1 > 0 ? 'medium'
    : 'low';

  const parts: string[] = [];
  parts.push(`Security: ${security.overallRiskLevel}`);
  parts.push(`Compliance: ${policy.overallComplianceStatus}`);
  parts.push(`Financial: ${financialViability}`);
  parts.push(`Governance: ${governance.governanceReadiness.overallScore}`);

  return {
    securityRiskLevel: security.overallRiskLevel,
    complianceStatus: policy.overallComplianceStatus,
    financialViability,
    governanceReadiness: governance.governanceReadiness.overallScore,
    overallAssessment: parts.join(' | '),
  };
}

// ============================================================================
// DecisionGraph Write
// ============================================================================

function writeToGraph(
  graph: DecisionGraph,
  security: SecurityAnalysis,
  policy: PolicyAnalysis,
  cost: CostModel,
  governance: GovernanceReport,
  convergence: GovernanceConvergence,
  tracker: ProvenanceTracker,
  pass: PassNumber,
): string[] {
  const nodeIds: string[] = [];
  const priorIds = [...graph.getNodesByPass(1), ...graph.getNodesByPass(2), ...graph.getNodesByPass(3)]
    .map(n => n.id).slice(0, 5);

  // Security Analysis
  const secNode = graph.createNode({
    type: 'security_analysis',
    name: 'Security & Compliance Analysis',
    content: security as unknown as Record<string, unknown>,
    summary: `Security risk: ${security.overallRiskLevel}. ${security.dataExposureMap.length} data exposure(s), ${security.remediationPriorities.length} remediation(s).`,
    producedBy: { domain: 'shield', agent: 'security-analysis', role: 'Security Analyst' },
    pass,
    derivedFrom: priorIds,
    confidence: riskLevelToConfidence(security.overallRiskLevel),
    tags: [`security:${security.overallRiskLevel}`],
  });
  nodeIds.push(secNode.id);

  // Policy Analysis
  const polNode = graph.createNode({
    type: 'policy_analysis',
    name: 'Policy Enforcement Analysis',
    content: policy as unknown as Record<string, unknown>,
    summary: `Compliance: ${policy.overallComplianceStatus}. ${policy.applicableFrameworks.length} framework(s), ${policy.approvalRouting.length} approval(s).`,
    producedBy: { domain: 'policy-engine', agent: 'enforce', role: 'Policy Analyst' },
    pass,
    derivedFrom: [secNode.id, ...priorIds.slice(0, 4)],
    confidence: complianceToConfidence(policy.overallComplianceStatus),
    tags: [`compliance:${policy.overallComplianceStatus}`],
  });
  nodeIds.push(polNode.id);

  // Compliance Report (distinct from policy analysis per ADR-036)
  const compNode = graph.createNode({
    type: 'compliance_report',
    name: 'Regulatory Compliance Report',
    content: {
      frameworks: policy.applicableFrameworks,
      aiGovernance: policy.aiGovernance,
      status: policy.overallComplianceStatus,
    },
    summary: `${policy.applicableFrameworks.length} regulatory framework(s) assessed. Status: ${policy.overallComplianceStatus}.`,
    producedBy: { domain: 'policy-engine', agent: 'constraints', role: 'Compliance Analyst' },
    pass,
    derivedFrom: [polNode.id],
    confidence: complianceToConfidence(policy.overallComplianceStatus),
    tags: [`compliance:${policy.overallComplianceStatus}`],
  });
  nodeIds.push(compNode.id);

  // Cost Model
  const costNode = graph.createNode({
    type: 'cost_model',
    name: 'CostOps Financial Model',
    content: cost as unknown as Record<string, unknown>,
    summary: `TCO Year 1: ${cost.tco.year1}, ROI: ${cost.roi.expectedReturn}, Payback: ${cost.roi.paybackPeriodMonths}mo. ${cost.scenarioVariants.length} scenario variant(s).`,
    producedBy: { domain: 'costops', agent: 'forecast', role: 'Financial Modeler' },
    pass,
    derivedFrom: priorIds,
    confidence: confidenceToNumber(cost.roi.confidenceLevel),
    tags: [`roi-confidence:${cost.roi.confidenceLevel}`],
  });
  nodeIds.push(costNode.id);

  // Governance Report
  const govNode = graph.createNode({
    type: 'governance_report',
    name: 'Governance Readiness Report',
    content: governance as unknown as Record<string, unknown>,
    summary: `Governance readiness: ${governance.governanceReadiness.overallScore}. ${governance.auditTrail.length} audit entries, ${governance.changeImpact.length} impact(s).`,
    producedBy: { domain: 'governance-dashboard', agent: 'audit', role: 'Governance Assessor' },
    pass,
    derivedFrom: [...nodeIds],
    confidence: readinessToConfidence(governance.governanceReadiness.overallScore),
    tags: [`readiness:${governance.governanceReadiness.overallScore}`],
  });
  nodeIds.push(govNode.id);

  // Convergence node
  graph.createNode({
    type: 'governance_report',
    name: 'Governance Convergence Report',
    content: convergence as unknown as Record<string, unknown>,
    summary: convergence.overallAssessment,
    producedBy: { domain: 'pipeline', agent: 'pass4-convergence', role: 'Governance Convergence' },
    pass,
    derivedFrom: nodeIds.slice(0, 5),
    confidence: 0.8,
    tags: ['convergence'],
  });

  // Record provenance
  tracker.recordInvocation({
    agent: { domain: 'pipeline', agent: 'pass4-convergence', role: 'Governance Convergence' },
    pass,
    passName: 'Governance, Compliance & CostOps',
    workstream: 'convergence',
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    durationMs: 0,
    inputNodeIds: priorIds,
    outputNodeIds: nodeIds,
    artifactNumbers: [5, 6, 7],
    status: 'success',
    confidence: 0.8,
  });

  return nodeIds;
}

// ============================================================================
// Default Agent Invoker
// ============================================================================

async function defaultInvokeAgents(
  agents: readonly AgentRef[],
  payload: Record<string, unknown>,
  pass: PassNumber,
  _timeoutMs: number,
): Promise<AgentInvocationResult[]> {
  const promises = agents.map(async (agent): Promise<AgentInvocationResult> => {
    const start = Date.now();
    const timestamp = new Date().toISOString();
    try {
      const { executeAgentsInvokeCommand } = await import('../../commands/agents.js');
      const result = await executeAgentsInvokeCommand(agent.domain, agent.agent, JSON.stringify(payload), { format: 'json' });
      return { agent, status: result.status, response: result.response, durationMs: Date.now() - start, pass, timestamp };
    } catch (err) {
      return { agent, status: 500, response: { error: err instanceof Error ? err.message : String(err) }, durationMs: Date.now() - start, pass, timestamp };
    }
  });

  const settled = await Promise.allSettled(promises);
  return settled.map((outcome, i) =>
    outcome.status === 'fulfilled'
      ? outcome.value
      : { agent: agents[i]!, status: 500, response: { error: String(outcome.reason) }, durationMs: 0, pass, timestamp: new Date().toISOString() },
  );
}

// ============================================================================
// Normalization Helpers
// ============================================================================

function normalizeRiskLevel(raw: unknown): RiskLevel {
  const s = String(raw ?? '').toLowerCase();
  if (s === 'critical') return 'critical';
  if (s === 'high') return 'high';
  if (s === 'low') return 'low';
  return 'medium';
}

function normalizeEffort(raw: unknown): EffortLevel {
  const s = String(raw ?? '').toLowerCase();
  if (s === 'high') return 'high';
  if (s === 'low') return 'low';
  return 'medium';
}

function normalizeComplianceStatus(raw: unknown): ComplianceStatus {
  const s = String(raw ?? '').toLowerCase().replace(/[\s-]/g, '_');
  if (s === 'compliant') return 'compliant';
  if (s === 'non_compliant') return 'non_compliant';
  return 'gaps_identified';
}

function normalizeExplainability(raw: unknown): ExplainabilityScore {
  const s = String(raw ?? '').toLowerCase();
  if (s === 'full') return 'full';
  if (s === 'opaque') return 'opaque';
  return 'partial';
}

function normalizeReadiness(raw: unknown): ReadinessScore {
  const s = String(raw ?? '').toLowerCase().replace(/[\s-]/g, '_');
  if (s === 'ready') return 'ready';
  if (s === 'conditionally_ready') return 'conditionally_ready';
  return 'not_ready';
}

function normalizeConfidence(raw: unknown): ConfidenceLevel {
  const s = String(raw ?? '').toLowerCase();
  if (s === 'high') return 'high';
  if (s === 'low') return 'low';
  return 'medium';
}

function worstOf(a: RiskLevel, b: RiskLevel): RiskLevel {
  const order: Record<RiskLevel, number> = { critical: 4, high: 3, medium: 2, low: 1 };
  return order[a] >= order[b] ? a : b;
}

function riskLevelToConfidence(level: RiskLevel): number {
  switch (level) { case 'critical': return 0.95; case 'high': return 0.85; case 'medium': return 0.7; default: return 0.5; }
}

function complianceToConfidence(status: ComplianceStatus): number {
  switch (status) { case 'compliant': return 0.95; case 'gaps_identified': return 0.7; default: return 0.4; }
}

function confidenceToNumber(level: ConfidenceLevel): number {
  switch (level) { case 'high': return 0.9; case 'medium': return 0.7; default: return 0.5; }
}

function readinessToConfidence(score: ReadinessScore): number {
  switch (score) { case 'ready': return 0.95; case 'conditionally_ready': return 0.7; default: return 0.4; }
}

function extractArray(obj: Record<string, unknown>, ...keys: string[]): unknown[] {
  for (const k of keys) {
    const v = obj[k];
    if (Array.isArray(v)) return v;
  }
  return [];
}

function extractStringArray(obj: Record<string, unknown>, ...keys: string[]): string[] {
  const arr = extractArray(obj, ...keys);
  return arr.map(String);
}
