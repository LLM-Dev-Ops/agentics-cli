/**
 * Pass 5 — Apex Decision Layer (ADR-037)
 *
 * Executes in two phases:
 *
 *   Phase 1: Artifact Generation (concurrent)
 *     - Decision Memo Agent       → Artifact #1
 *     - Executive Summary Agent   → Artifact #2
 *     - Risk Scoring Agent        → Artifact #5
 *     - Documentation Generator   → Artifacts #8, #9, #10, #11, #13, #14
 *
 *   Phase 2: Scoring & Assembly (sequential, after Phase 1)
 *     - Decision Agent            → Artifact #12 (Confidence Score)
 *     - Pipeline Orchestrator     → Artifact #15 (Provenance Manifest)
 *     - Package Assembler         → DECISION_PACKAGE.md
 *
 * Artifacts #3 (Architecture), #4 (Simulation), #6 (CostOps), #7 (Compliance)
 * are read from the DecisionGraph — they were produced in Passes 2-4.
 */

import type {
  PassNumber,
  AgentRef,
  AgentInvocationResult,
  DecisionGraphNode,
  DecisionNodeType,
} from './types.js';
import { DecisionGraph } from './decision-graph.js';
import { ProvenanceTracker } from './provenance-tracker.js';

// ============================================================================
// Domain Types (ADR-037)
// ============================================================================

/** Confidence score component with weight. */
export interface ConfidenceComponent {
  readonly name: string;
  readonly weight: number;
  readonly rawScore: number;
  readonly weightedScore: number;
  readonly source: string;
  readonly degraded: boolean;
}

/** Full confidence score breakdown. */
export interface ConfidenceScoreBreakdown {
  readonly overall: number;
  readonly recommendation: ConfidenceRecommendation;
  readonly components: readonly ConfidenceComponent[];
  readonly degradationPenalty: number;
  readonly degradedPasses: readonly PassNumber[];
  readonly methodology: string;
}

/** Decision recommendation per ADR-037. */
export type ConfidenceRecommendation =
  | 'proceed'
  | 'proceed-with-conditions'
  | 'investigate-further'
  | 'do-not-proceed';

/** Phase 1 agent group identifiers. */
export type Phase1GroupId =
  | 'decision-memo'
  | 'executive-summary'
  | 'risk-scoring'
  | 'documentation-generator';

/** Agent group configuration for Phase 1. */
export interface Phase1GroupConfig {
  readonly id: Phase1GroupId;
  readonly label: string;
  readonly agents: readonly AgentRef[];
  readonly artifactNumbers: readonly number[];
  readonly graphNodeTypes: readonly DecisionNodeType[];
  /** Which DecisionGraph node types this group reads from. */
  readonly readsFrom: readonly DecisionNodeType[];
}

/** Result from a Phase 1 agent group. */
export interface Phase1GroupResult {
  readonly group: Phase1GroupId;
  readonly label: string;
  readonly agentResults: readonly AgentInvocationResult[];
  readonly successCount: number;
  readonly totalCount: number;
  readonly durationMs: number;
}

/** Full Pass 5 execution result. */
export interface Pass5Result {
  readonly phase1Results: readonly Phase1GroupResult[];
  readonly confidenceScore: ConfidenceScoreBreakdown;
  readonly graphNodeIds: readonly string[];
  readonly totalAgentResults: readonly AgentInvocationResult[];
}

// ============================================================================
// Phase 1 Agent Group Configurations (ADR-037)
// ============================================================================

export const PHASE1_GROUP_CONFIGS: readonly Phase1GroupConfig[] = [
  {
    id: 'decision-memo',
    label: 'Decision Memo Agent',
    agents: [
      { domain: 'platform', agent: 'decision-memo', role: 'Decision Memo Agent' },
    ],
    artifactNumbers: [1],
    graphNodeTypes: ['executive_memo'],
    readsFrom: ['problem_definition', 'system_architecture', 'cost_model', 'risk_signal', 'security_analysis'],
  },
  {
    id: 'executive-summary',
    label: 'Executive Summary Agent',
    agents: [
      { domain: 'platform', agent: 'executive-summary', role: 'Executive Summary Agent' },
    ],
    artifactNumbers: [2],
    graphNodeTypes: ['executive_summary'],
    readsFrom: ['problem_definition', 'business_context', 'system_architecture', 'cost_model', 'scenario', 'compliance_report'],
  },
  {
    id: 'risk-scoring',
    label: 'Risk Scoring Agent',
    agents: [
      { domain: 'platform', agent: 'risk-score', role: 'Risk Scoring Agent' },
    ],
    artifactNumbers: [5],
    graphNodeTypes: ['risk_assessment'],
    readsFrom: ['risk_signal', 'security_analysis', 'compliance_report', 'policy_analysis'],
  },
  {
    id: 'documentation-generator',
    label: 'Documentation Generator',
    agents: [
      { domain: 'platform', agent: 'decision', role: 'Documentation Generator' },
      { domain: 'analytics-hub', agent: 'recommendation', role: 'Recommendation report' },
      { domain: 'research-lab', agent: 'metrics', role: 'KPI & metrics analyst' },
    ],
    artifactNumbers: [8, 9, 10, 11, 13, 14],
    graphNodeTypes: ['implementation_roadmap', 'org_impact', 'stakeholder_map', 'kpi_definition', 'okr_alignment', 'raid_log'],
    readsFrom: ['system_architecture', 'integration_map', 'cost_model', 'business_context', 'problem_definition', 'policy_analysis', 'scenario', 'risk_signal'],
  },
];

// ============================================================================
// Phase 2: Scoring Agent
// ============================================================================

const SCORING_AGENTS: readonly AgentRef[] = [
  { domain: 'platform', agent: 'decision', role: 'Decision Confidence Score Agent' },
];

// ============================================================================
// Pass 5 Executor
// ============================================================================

/**
 * Execute Pass 5: Apex Decision Layer.
 *
 * Phase 1: Generate artifacts #1, #2, #5, #8-11, #13-14 concurrently.
 * Phase 2: Compute Decision Confidence Score (#12) sequentially.
 *
 * Artifacts #3, #4, #6, #7, #15 are NOT generated here — they come from
 * Passes 2-4 and the Pipeline Orchestrator respectively.
 */
export async function executePass5(params: {
  prompt: string;
  graph: DecisionGraph;
  tracker: ProvenanceTracker;
  timeoutMs: number;
  verbose: boolean;
  passesDegraded: readonly PassNumber[];
  invokeAgents?: (agents: readonly AgentRef[], payload: Record<string, unknown>, pass: PassNumber, timeoutMs: number) => Promise<AgentInvocationResult[]>;
}): Promise<Pass5Result> {
  const { prompt, graph, tracker, timeoutMs, verbose, passesDegraded } = params;
  const pass: PassNumber = 5;
  const invoke = params.invokeAgents ?? defaultInvokeAgents;

  if (verbose) {
    console.error(`  [Pass 5] Phase 1: Artifact Generation (${PHASE1_GROUP_CONFIGS.length} concurrent groups)`);
  }

  // ── Phase 1: Concurrent Artifact Generation ──
  const phase1Promises = PHASE1_GROUP_CONFIGS.map(async (group): Promise<Phase1GroupResult> => {
    const groupStart = Date.now();
    if (verbose) {
      console.error(`  [Pass 5]   Group: ${group.label} → Artifacts ${group.artifactNumbers.join(', ')}`);
    }

    // Build payload with relevant upstream context
    const relevantNodes = group.readsFrom.flatMap(t => graph.getNodesByType(t));
    const context = relevantNodes.map(n => ({
      type: n.type,
      name: n.name,
      summary: n.summary,
      pass: n.pass,
      content: n.content,
    }));

    const payload: Record<string, unknown> = {
      prompt,
      pass: 5,
      passName: 'Decision Artifacts',
      group: group.id,
      artifactNumbers: group.artifactNumbers,
      context,
    };

    const results = await invoke(group.agents, payload, pass, timeoutMs);
    const successCount = results.filter(r => r.status >= 200 && r.status < 300).length;

    // Write graph nodes for each artifact this group produces
    writePhase1Nodes(graph, group, results, relevantNodes, pass);

    return {
      group: group.id,
      label: group.label,
      agentResults: results,
      successCount,
      totalCount: results.length,
      durationMs: Date.now() - groupStart,
    };
  });

  const phase1Results = await Promise.all(phase1Promises);

  // ── Phase 2: Sequential Scoring & Assembly ──
  if (verbose) {
    console.error(`  [Pass 5] Phase 2: Scoring & Assembly`);
  }

  // Compute confidence score
  const confidenceScore = computeConfidenceScore(graph, passesDegraded);

  // Write confidence score to graph
  const scoreNodeId = writeConfidenceNode(graph, confidenceScore, pass);

  // Invoke scoring agents (for provenance tracking, even though we compute locally)
  const scoringPayload: Record<string, unknown> = {
    prompt,
    pass: 5,
    passName: 'Decision Confidence Score',
    confidenceScore: confidenceScore.overall,
    recommendation: confidenceScore.recommendation,
  };
  const scoringResults = await invoke(SCORING_AGENTS, scoringPayload, pass, timeoutMs);

  // Record provenance
  tracker.recordInvocation({
    agent: { domain: 'platform', agent: 'decision', role: 'Decision Confidence Score' },
    pass,
    passName: 'Apex Decision Layer',
    workstream: 'scoring',
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    durationMs: 0,
    inputNodeIds: graph.getNodesByPass(1).map(n => n.id).concat(
      graph.getNodesByPass(2).map(n => n.id),
      graph.getNodesByPass(3).map(n => n.id),
      graph.getNodesByPass(4).map(n => n.id),
    ).slice(0, 10),
    outputNodeIds: [scoreNodeId],
    artifactNumbers: [12],
    status: 'success',
    confidence: confidenceScore.overall / 100,
  });

  // Collect all results
  const allResults: AgentInvocationResult[] = [];
  for (const g of phase1Results) {
    for (const r of g.agentResults) allResults.push(r);
  }
  for (const r of scoringResults) allResults.push(r);

  // Collect all graph node IDs written by this pass
  const graphNodeIds = graph.getNodesByPass(5).map(n => n.id);

  if (verbose) {
    console.error(`  [Pass 5] Complete: confidence=${confidenceScore.overall}%, recommendation=${confidenceScore.recommendation}`);
  }

  return {
    phase1Results,
    confidenceScore,
    graphNodeIds,
    totalAgentResults: allResults,
  };
}

// ============================================================================
// Phase 1: Graph Node Writing
// ============================================================================

function writePhase1Nodes(
  graph: DecisionGraph,
  group: Phase1GroupConfig,
  results: readonly AgentInvocationResult[],
  upstreamNodes: readonly DecisionGraphNode[],
  pass: PassNumber,
): void {
  const successResults = results.filter(r => r.status >= 200 && r.status < 300);
  const derivedFrom = upstreamNodes.map(n => n.id).slice(0, 8);
  const hasData = successResults.length > 0;

  for (const nodeType of group.graphNodeTypes) {
    // Find the most relevant agent result for this node type
    const relevantResult = successResults[0]; // First successful result

    const content: Record<string, unknown> = hasData && relevantResult?.response
      ? (typeof relevantResult.response === 'object' && relevantResult.response !== null
        ? relevantResult.response as Record<string, unknown>
        : { data: relevantResult.response })
      : { status: 'no_agent_data' };

    const summary = hasData && relevantResult
      ? `Generated by ${relevantResult.agent.role} from ${derivedFrom.length} upstream node(s)`
      : `Placeholder — ${group.label} agents did not return data`;

    graph.createNode({
      type: nodeType,
      name: `${group.label}: ${nodeType}`,
      content,
      summary,
      producedBy: hasData && relevantResult
        ? relevantResult.agent
        : { domain: 'pipeline', agent: 'pass5-placeholder', role: 'Placeholder' },
      pass,
      derivedFrom,
      confidence: hasData ? 0.85 : 0.1,
      status: hasData ? 'complete' : 'degraded',
      tags: group.artifactNumbers.map(n => `artifact:${n}`),
    });
  }
}

// ============================================================================
// Phase 2: Confidence Score Computation (ADR-037 formula)
// ============================================================================

/** Confidence Score weight configuration. */
const CONFIDENCE_WEIGHTS = {
  financial:      { weight: 0.25, name: 'Financial Outcome Stability',  source: 'CostOps ROI confidence + budget risk' },
  operational:    { weight: 0.20, name: 'Operational Risk Level',       source: 'Inverse of Risk Assessment severity' },
  compliance:     { weight: 0.20, name: 'Compliance Exposure',          source: 'Policy analysis compliance status' },
  architecture:   { weight: 0.20, name: 'Architecture Feasibility',     source: 'Simulation success probability + prototype status' },
  organizational: { weight: 0.15, name: 'Organizational Readiness',     source: 'Org Impact readiness score' },
} as const;

function computeConfidenceScore(
  graph: DecisionGraph,
  passesDegraded: readonly PassNumber[],
): ConfidenceScoreBreakdown {
  const components: ConfidenceComponent[] = [];

  // ── Financial Outcome Stability (25%) ──
  const financialRaw = computeFinancialScore(graph, passesDegraded);
  components.push({
    name: CONFIDENCE_WEIGHTS.financial.name,
    weight: CONFIDENCE_WEIGHTS.financial.weight,
    rawScore: financialRaw,
    weightedScore: financialRaw * CONFIDENCE_WEIGHTS.financial.weight,
    source: CONFIDENCE_WEIGHTS.financial.source,
    degraded: passesDegraded.includes(4),
  });

  // ── Operational Risk Level (20%) ──
  const operationalRaw = computeOperationalScore(graph, passesDegraded);
  components.push({
    name: CONFIDENCE_WEIGHTS.operational.name,
    weight: CONFIDENCE_WEIGHTS.operational.weight,
    rawScore: operationalRaw,
    weightedScore: operationalRaw * CONFIDENCE_WEIGHTS.operational.weight,
    source: CONFIDENCE_WEIGHTS.operational.source,
    degraded: passesDegraded.includes(2),
  });

  // ── Compliance Exposure (20%) ──
  const complianceRaw = computeComplianceScore(graph, passesDegraded);
  components.push({
    name: CONFIDENCE_WEIGHTS.compliance.name,
    weight: CONFIDENCE_WEIGHTS.compliance.weight,
    rawScore: complianceRaw,
    weightedScore: complianceRaw * CONFIDENCE_WEIGHTS.compliance.weight,
    source: CONFIDENCE_WEIGHTS.compliance.source,
    degraded: passesDegraded.includes(4),
  });

  // ── Architecture Feasibility (20%) ──
  const architectureRaw = computeArchitectureScore(graph, passesDegraded);
  components.push({
    name: CONFIDENCE_WEIGHTS.architecture.name,
    weight: CONFIDENCE_WEIGHTS.architecture.weight,
    rawScore: architectureRaw,
    weightedScore: architectureRaw * CONFIDENCE_WEIGHTS.architecture.weight,
    source: CONFIDENCE_WEIGHTS.architecture.source,
    degraded: passesDegraded.includes(2) || passesDegraded.includes(3),
  });

  // ── Organizational Readiness (15%) ──
  const organizationalRaw = computeOrganizationalScore(graph, passesDegraded);
  components.push({
    name: CONFIDENCE_WEIGHTS.organizational.name,
    weight: CONFIDENCE_WEIGHTS.organizational.weight,
    rawScore: organizationalRaw,
    weightedScore: organizationalRaw * CONFIDENCE_WEIGHTS.organizational.weight,
    source: CONFIDENCE_WEIGHTS.organizational.source,
    degraded: passesDegraded.includes(5),
  });

  // Sum weighted scores
  const rawTotal = components.reduce((sum, c) => sum + c.weightedScore, 0);

  // Degradation penalty: -10% per degraded pass
  const degradationPenalty = passesDegraded.length * 0.10;

  // Final score (0-100)
  const overall = Math.round(Math.max(0, Math.min(1, rawTotal - degradationPenalty)) * 100);

  // Recommendation thresholds (ADR-037)
  const recommendation = scoreToRecommendation(overall);

  return {
    overall,
    recommendation,
    components,
    degradationPenalty: Math.round(degradationPenalty * 100),
    degradedPasses: [...passesDegraded],
    methodology: 'Weighted average: Financial 25%, Operational 20%, Compliance 20%, Architecture 20%, Organizational 15%. -10% per degraded pass.',
  };
}

// ============================================================================
// Per-Component Score Computation
// ============================================================================

/** Financial: CostOps ROI confidence + budget risk (from Pass 4). */
function computeFinancialScore(graph: DecisionGraph, degraded: readonly PassNumber[]): number {
  if (degraded.includes(4)) return 0.5;

  const costNodes = graph.getNodesByType('cost_model');
  if (costNodes.length === 0) return 0;

  // Average confidence of cost model nodes
  const avgConf = costNodes.reduce((s, n) => s + n.confidence, 0) / costNodes.length;

  // Check for ROI data
  const hasRoi = costNodes.some(n => {
    const c = n.content;
    return c['roi'] !== undefined || c['expectedReturn'] !== undefined || c['tco'] !== undefined;
  });

  return hasRoi ? Math.min(1, avgConf + 0.1) : avgConf;
}

/** Operational: Inverse of risk assessment severity (from Pass 2). */
function computeOperationalScore(graph: DecisionGraph, degraded: readonly PassNumber[]): number {
  if (degraded.includes(2)) return 0.5;

  const riskNodes = graph.getNodesByType('risk_signal');
  if (riskNodes.length === 0) return 0.8; // No risks = good operational score

  // Count critical/high severity risks
  let critical = 0;
  let high = 0;
  for (const n of riskNodes) {
    const sev = String(n.content['severity'] ?? '').toLowerCase();
    if (sev === 'critical') critical++;
    else if (sev === 'high') high++;
  }

  // More risks = lower score (inverse)
  if (critical > 0) return 0.2;
  if (high > 2) return 0.4;
  if (high > 0) return 0.6;
  return 0.8;
}

/** Compliance: Policy analysis compliance status (from Pass 4). */
function computeComplianceScore(graph: DecisionGraph, degraded: readonly PassNumber[]): number {
  if (degraded.includes(4)) return 0.5;

  const policyNodes = graph.getNodesByType('policy_analysis');
  const complianceNodes = graph.getNodesByType('compliance_report');
  const allNodes = [...policyNodes, ...complianceNodes];

  if (allNodes.length === 0) return 0;

  // Check compliance status
  for (const n of allNodes) {
    const status = String(n.content['overallComplianceStatus'] ?? n.content['status'] ?? '').toLowerCase();
    if (status === 'non_compliant') return 0.2;
    if (status === 'compliant') return 1.0;
  }

  // Gaps identified
  return 0.6;
}

/** Architecture: Simulation success + prototype status (from Passes 2+3). */
function computeArchitectureScore(graph: DecisionGraph, degraded: readonly PassNumber[]): number {
  let score = 0;
  let count = 0;

  // Simulation success probability (Pass 2)
  if (!degraded.includes(2)) {
    const scenarios = graph.getNodesByType('scenario');
    if (scenarios.length > 0) {
      const avgConf = scenarios.reduce((s, n) => s + n.confidence, 0) / scenarios.length;
      score += avgConf;
      count++;
    }
  } else {
    score += 0.5;
    count++;
  }

  // Prototype/architecture status (Pass 3)
  if (!degraded.includes(3)) {
    const archNodes = graph.getNodesByType('system_architecture');
    const protoNodes = graph.getNodesByType('prototype');
    const allArch = [...archNodes, ...protoNodes];
    if (allArch.length > 0) {
      const avgConf = allArch.reduce((s, n) => s + n.confidence, 0) / allArch.length;
      score += avgConf;
      count++;
    }
  } else {
    score += 0.5;
    count++;
  }

  return count > 0 ? score / count : 0;
}

/** Organizational: Org Impact readiness score (from Pass 5 Phase 1 or Pass 4 governance). */
function computeOrganizationalScore(graph: DecisionGraph, degraded: readonly PassNumber[]): number {
  if (degraded.includes(5)) return 0.5;

  // Check org impact nodes (written by Phase 1)
  const orgNodes = graph.getNodesByType('org_impact');
  if (orgNodes.length > 0) {
    return orgNodes.reduce((s, n) => s + n.confidence, 0) / orgNodes.length;
  }

  // Fall back to governance readiness (Pass 4)
  const govNodes = graph.getNodesByType('governance_report');
  if (govNodes.length > 0) {
    for (const n of govNodes) {
      const readiness = n.content['governanceReadiness'];
      if (readiness && typeof readiness === 'object') {
        const score = String((readiness as Record<string, unknown>)['overallScore'] ?? '');
        if (score === 'ready') return 1.0;
        if (score === 'conditionally_ready') return 0.7;
      }
    }
    return govNodes.reduce((s, n) => s + n.confidence, 0) / govNodes.length;
  }

  return 0;
}

// ============================================================================
// Score Interpretation (ADR-037)
// ============================================================================

function scoreToRecommendation(score: number): ConfidenceRecommendation {
  if (score >= 80) return 'proceed';
  if (score >= 60) return 'proceed-with-conditions';
  if (score >= 40) return 'investigate-further';
  return 'do-not-proceed';
}

// ============================================================================
// Confidence Score Graph Node
// ============================================================================

function writeConfidenceNode(
  graph: DecisionGraph,
  score: ConfidenceScoreBreakdown,
  pass: PassNumber,
): string {
  const priorIds = [
    ...graph.getNodesByPass(1).map(n => n.id),
    ...graph.getNodesByPass(2).map(n => n.id),
    ...graph.getNodesByPass(3).map(n => n.id),
    ...graph.getNodesByPass(4).map(n => n.id),
  ].slice(0, 8);

  const node = graph.createNode({
    type: 'confidence_score',
    name: 'Decision Confidence Score',
    content: score as unknown as Record<string, unknown>,
    summary: `Overall: ${score.overall}% — ${formatRecommendation(score.recommendation)}. ${score.components.filter(c => c.degraded).length} degraded component(s).`,
    producedBy: { domain: 'platform', agent: 'decision', role: 'Decision Confidence Score Agent' },
    pass,
    derivedFrom: priorIds,
    confidence: score.overall / 100,
    tags: [`recommendation:${score.recommendation}`, `score:${score.overall}`],
  });

  return node.id;
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
// Helpers
// ============================================================================

function formatRecommendation(rec: ConfidenceRecommendation): string {
  switch (rec) {
    case 'proceed': return 'Proceed';
    case 'proceed-with-conditions': return 'Proceed with Conditions';
    case 'investigate-further': return 'Investigate Further';
    case 'do-not-proceed': return 'Do Not Proceed';
  }
}
