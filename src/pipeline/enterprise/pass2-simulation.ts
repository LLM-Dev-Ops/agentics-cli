/**
 * Pass 2 — Simulation & Scenario Modeling (ADR-035)
 *
 * Executes three concurrent workstreams that converge into a unified
 * Scenario Matrix stored in the DecisionGraph:
 *
 *   Workstream A: Scenario Generation (LLM-Simulator)
 *   Workstream B: Risk Signal Detection (LLM-Sentinel)
 *   Workstream C: Model Reliability (LLM-Test-Bench)
 *
 * After all workstreams complete, their outputs are merged into a
 * ScenarioMatrix node that cross-references scenarios with risk signals
 * and reliability assessments.
 */

import * as crypto from 'node:crypto';

import type {
  PassNumber,
  AgentRef,
  AgentInvocationResult,
  DecisionGraphNode,
} from './types.js';
import { DecisionGraph } from './decision-graph.js';
import { ProvenanceTracker } from './provenance-tracker.js';

// ============================================================================
// Domain Types (ADR-035 Interfaces)
// ============================================================================

/** Scenario types per ADR-035. */
export type ScenarioType = 'deployment' | 'integration' | 'failure' | 'scaling' | 'edge_case';

/** Probability/impact levels. */
export type ProbabilityLevel = 'high' | 'medium' | 'low';
export type ImpactLevel = 'critical' | 'high' | 'medium' | 'low';

/** A single simulation scenario. */
export interface Scenario {
  readonly id: string;
  readonly type: ScenarioType;
  readonly name: string;
  readonly description: string;
  readonly assumptions: readonly string[];
  readonly probability: ProbabilityLevel;
  readonly impact: ImpactLevel;
  readonly expectedOutcome: string;
  readonly mitigationStrategy: string;
  readonly metrics: ScenarioMetrics;
}

/** Quantified metrics for a scenario. */
export interface ScenarioMetrics {
  readonly reliabilityProbability?: number;
  readonly failureProbability?: number;
  readonly deploymentSuccessProbability?: number;
  readonly estimatedRecoveryTime?: string;
}

/** Risk signal categories per ADR-035. */
export type RiskCategory = 'operational' | 'integration' | 'security' | 'compliance' | 'performance';

/** Severity levels for risk signals. */
export type SeverityLevel = 'critical' | 'high' | 'medium' | 'low';

/** A single risk signal detected by Sentinel agents. */
export interface RiskSignal {
  readonly id: string;
  readonly category: RiskCategory;
  readonly severity: SeverityLevel;
  readonly description: string;
  readonly source: string;
  readonly correlatedWith: readonly string[];
  readonly rootCause: string;
  readonly mitigationSuggestion: string;
}

/** Reliability recommendation. */
export type ReliabilityRecommendation = 'reliable' | 'caution' | 'unreliable';

/** Model reliability report from Test-Bench agents. */
export interface ReliabilityReport {
  readonly overallScore: number;
  readonly hallucinationScore: number;
  readonly faithfulnessScore: number;
  readonly biasScore: number;
  readonly stressResilienceScore: number;
  readonly redTeamFindings: readonly string[];
  readonly recommendation: ReliabilityRecommendation;
}

/** Cross-reference between a scenario and its related risk signals. */
export interface ScenarioCrossReference {
  readonly scenarioId: string;
  readonly relatedRiskSignals: readonly string[];
  readonly reliabilityImpact: string;
}

/** The merged output of all three workstreams. */
export interface ScenarioMatrix {
  readonly scenarios: readonly Scenario[];
  readonly riskSignals: readonly RiskSignal[];
  readonly reliabilityReport: ReliabilityReport;
  readonly crossReferences: readonly ScenarioCrossReference[];
  readonly overallRiskLevel: ImpactLevel;
}

// ============================================================================
// Workstream Definitions
// ============================================================================

/** Workstream identifier. */
export type WorkstreamId = 'scenario-generation' | 'risk-signal-detection' | 'model-reliability';

/** Agent-to-workstream mapping. */
export interface WorkstreamConfig {
  readonly id: WorkstreamId;
  readonly label: string;
  readonly agents: readonly AgentRef[];
}

/** Define which agents belong to which workstream. */
export const WORKSTREAM_CONFIGS: readonly WorkstreamConfig[] = [
  {
    id: 'scenario-generation',
    label: 'Scenario Generation (LLM-Simulator)',
    agents: [
      { domain: 'simulator', agent: 'what-if', role: 'What-if simulation' },
      { domain: 'simulator', agent: 'scenario', role: 'Scenario generator' },
    ],
  },
  {
    id: 'risk-signal-detection',
    label: 'Risk Signal Detection (LLM-Sentinel)',
    agents: [
      { domain: 'sentinel', agent: 'anomaly', role: 'Anomaly detection' },
      { domain: 'sentinel', agent: 'drift', role: 'Drift detection' },
      { domain: 'sentinel', agent: 'correlation', role: 'Incident correlation' },
      { domain: 'sentinel', agent: 'rca', role: 'Root cause analysis' },
    ],
  },
  {
    id: 'model-reliability',
    label: 'Model Reliability (LLM-Test-Bench)',
    agents: [
      { domain: 'test-bench', agent: 'hallucination', role: 'Hallucination detection' },
      { domain: 'test-bench', agent: 'faithfulness', role: 'Faithfulness verification' },
      { domain: 'test-bench', agent: 'bias', role: 'Bias detection' },
      { domain: 'test-bench', agent: 'stress', role: 'Stress testing' },
      { domain: 'test-bench', agent: 'red-team', role: 'Red team testing' },
      { domain: 'test-bench', agent: 'adversarial', role: 'Adversarial prompt testing' },
    ],
  },
];

// ============================================================================
// Workstream Result Types
// ============================================================================

/** Result from a single workstream execution. */
export interface WorkstreamResult {
  readonly workstream: WorkstreamId;
  readonly label: string;
  readonly agentResults: readonly AgentInvocationResult[];
  readonly successCount: number;
  readonly totalCount: number;
  readonly durationMs: number;
}

/** Full Pass 2 execution result. */
export interface Pass2Result {
  readonly workstreamResults: readonly WorkstreamResult[];
  readonly scenarios: readonly Scenario[];
  readonly riskSignals: readonly RiskSignal[];
  readonly reliabilityReport: ReliabilityReport;
  readonly scenarioMatrix: ScenarioMatrix;
  readonly graphNodeIds: readonly string[];
  readonly totalAgentResults: readonly AgentInvocationResult[];
}

// ============================================================================
// Pass 2 Executor
// ============================================================================

/**
 * Execute Pass 2: Simulation & Scenario Modeling.
 *
 * Dispatches three workstreams concurrently, processes their results
 * into typed domain objects, merges into a ScenarioMatrix, and writes
 * all outputs to the DecisionGraph.
 */
export async function executePass2(params: {
  prompt: string;
  graph: DecisionGraph;
  tracker: ProvenanceTracker;
  timeoutMs: number;
  verbose: boolean;
  skipRedTeam?: boolean;
  /** Injected invoker for testing. If not provided, uses the real agent invoker. */
  invokeAgents?: (agents: readonly AgentRef[], payload: Record<string, unknown>, pass: PassNumber, timeoutMs: number) => Promise<AgentInvocationResult[]>;
}): Promise<Pass2Result> {
  const { prompt, graph, tracker, timeoutMs, verbose, skipRedTeam } = params;
  const pass: PassNumber = 2;
  const start = Date.now();

  // Get Pass 1 context from DecisionGraph
  const pass1Nodes = graph.getNodesByPass(1);
  const pass1Context = buildPass1Context(pass1Nodes);

  // Build payload for all agents
  const payload: Record<string, unknown> = {
    prompt,
    pass: 2,
    passName: 'Simulation & Scenario Modeling',
    context: pass1Context,
  };

  // Resolve workstream configs (optionally skip red team)
  const workstreams = resolveWorkstreams(skipRedTeam);

  // Invoke function (injectable for testing)
  const invoke = params.invokeAgents ?? defaultInvokeAgents;

  if (verbose) {
    console.error(`  [Pass 2] Starting ${workstreams.length} concurrent workstreams`);
  }

  // ── Execute all 3 workstreams concurrently ──
  const workstreamPromises = workstreams.map(async (ws): Promise<WorkstreamResult> => {
    const wsStart = Date.now();
    if (verbose) {
      console.error(`  [Pass 2] Workstream: ${ws.label} (${ws.agents.length} agents)`);
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

  // ── Collect all agent results ──
  const allResults: AgentInvocationResult[] = [];
  for (const ws of workstreamResults) {
    for (const r of ws.agentResults) {
      allResults.push(r);
    }
  }

  // ── Process each workstream's output ──
  const wsA = workstreamResults.find(w => w.workstream === 'scenario-generation');
  const wsB = workstreamResults.find(w => w.workstream === 'risk-signal-detection');
  const wsC = workstreamResults.find(w => w.workstream === 'model-reliability');

  const scenarios = extractScenarios(wsA, prompt);
  const riskSignals = extractRiskSignals(wsB);
  const reliabilityReport = extractReliabilityReport(wsC);

  // ── Converge into Scenario Matrix ──
  const crossReferences = buildCrossReferences(scenarios, riskSignals);
  const overallRiskLevel = computeOverallRiskLevel(riskSignals, scenarios);

  const scenarioMatrix: ScenarioMatrix = {
    scenarios,
    riskSignals,
    reliabilityReport,
    crossReferences,
    overallRiskLevel,
  };

  // ── Write to DecisionGraph ──
  const graphNodeIds = writeToGraph(graph, scenarios, riskSignals, reliabilityReport, scenarioMatrix, pass1Nodes, tracker, pass);

  if (verbose) {
    console.error(`  [Pass 2] Complete: ${scenarios.length} scenarios, ${riskSignals.length} risk signals, reliability: ${reliabilityReport.recommendation}`);
    console.error(`  [Pass 2] Duration: ${Date.now() - start}ms`);
  }

  return {
    workstreamResults,
    scenarios,
    riskSignals,
    reliabilityReport,
    scenarioMatrix,
    graphNodeIds,
    totalAgentResults: allResults,
  };
}

// ============================================================================
// Workstream Resolution
// ============================================================================

/**
 * Resolve workstream configs, optionally removing red team agents.
 */
function resolveWorkstreams(skipRedTeam?: boolean): readonly WorkstreamConfig[] {
  if (!skipRedTeam) return WORKSTREAM_CONFIGS;

  return WORKSTREAM_CONFIGS.map(ws => {
    if (ws.id !== 'model-reliability') return ws;
    return {
      ...ws,
      agents: ws.agents.filter(a => a.agent !== 'red-team' && a.agent !== 'adversarial'),
    };
  });
}

// ============================================================================
// Pass 1 Context Builder
// ============================================================================

/** Extract structured context from Pass 1 nodes for Pass 2 agent payloads. */
function buildPass1Context(pass1Nodes: readonly DecisionGraphNode[]): Record<string, unknown> {
  const context: Record<string, unknown> = {};

  for (const node of pass1Nodes) {
    switch (node.type) {
      case 'problem_definition':
        context['problemDefinition'] = { summary: node.summary, ...node.content };
        break;
      case 'business_context':
        context['businessContext'] = { summary: node.summary, ...node.content };
        break;
      case 'technical_scope':
        context['technicalScope'] = { summary: node.summary, ...node.content };
        break;
      case 'architecture_hypothesis':
        if (!context['architectureHypotheses']) {
          context['architectureHypotheses'] = [];
        }
        (context['architectureHypotheses'] as unknown[]).push({ summary: node.summary, ...node.content });
        break;
      case 'execution_plan':
        context['executionPlan'] = { summary: node.summary, ...node.content };
        break;
      default:
        break;
    }
  }

  return context;
}

// ============================================================================
// Result Extractors
// ============================================================================

/**
 * Extract typed Scenario objects from Workstream A results.
 * Parses agent responses and falls back to generated scenarios
 * if the agents fail or return unparseable data.
 */
function extractScenarios(
  ws: WorkstreamResult | undefined,
  prompt: string,
): Scenario[] {
  const scenarios: Scenario[] = [];

  if (ws) {
    for (const result of ws.agentResults) {
      if (result.status >= 200 && result.status < 300 && result.response) {
        const parsed = parseScenarioResponse(result.response, result.agent);
        for (const s of parsed) {
          scenarios.push(s);
        }
      }
    }
  }

  // Ensure minimum 3 scenarios (at least 1 deployment, 1 failure)
  ensureMinimumScenarios(scenarios, prompt);

  return scenarios;
}

/** Parse a single agent response into Scenario objects. */
function parseScenarioResponse(response: unknown, agent: AgentRef): Scenario[] {
  const results: Scenario[] = [];

  if (!response || typeof response !== 'object') return results;

  const resp = response as Record<string, unknown>;

  // Try to extract scenarios from common response shapes
  const candidates = resp['scenarios'] ?? resp['data'] ?? resp['results'] ?? resp['result'];

  if (Array.isArray(candidates)) {
    for (const item of candidates) {
      if (typeof item === 'object' && item !== null) {
        results.push(normalizeScenario(item as Record<string, unknown>, agent));
      }
    }
  } else if (typeof candidates === 'object' && candidates !== null) {
    results.push(normalizeScenario(candidates as Record<string, unknown>, agent));
  }

  // If no structured scenarios found, create one from the raw response
  if (results.length === 0 && Object.keys(resp).length > 0) {
    results.push(normalizeScenario(resp, agent));
  }

  return results;
}

/** Normalize a raw object into a typed Scenario. */
function normalizeScenario(raw: Record<string, unknown>, agent: AgentRef): Scenario {
  return {
    id: String(raw['id'] ?? crypto.randomUUID()),
    type: normalizeScenarioType(raw['type']),
    name: String(raw['name'] ?? raw['title'] ?? `${agent.role} scenario`),
    description: String(raw['description'] ?? raw['summary'] ?? ''),
    assumptions: normalizeStringArray(raw['assumptions']),
    probability: normalizeProbability(raw['probability']),
    impact: normalizeImpact(raw['impact']),
    expectedOutcome: String(raw['expectedOutcome'] ?? raw['expected_outcome'] ?? raw['outcome'] ?? ''),
    mitigationStrategy: String(raw['mitigationStrategy'] ?? raw['mitigation_strategy'] ?? raw['mitigation'] ?? ''),
    metrics: normalizeMetrics(raw['metrics']),
  };
}

/** Extract typed RiskSignal objects from Workstream B results. */
function extractRiskSignals(ws: WorkstreamResult | undefined): RiskSignal[] {
  const signals: RiskSignal[] = [];

  if (ws) {
    for (const result of ws.agentResults) {
      if (result.status >= 200 && result.status < 300 && result.response) {
        const parsed = parseRiskSignalResponse(result.response, result.agent);
        for (const s of parsed) {
          signals.push(s);
        }
      }
    }
  }

  return signals;
}

/** Parse a single agent response into RiskSignal objects. */
function parseRiskSignalResponse(response: unknown, agent: AgentRef): RiskSignal[] {
  const results: RiskSignal[] = [];

  if (!response || typeof response !== 'object') return results;

  const resp = response as Record<string, unknown>;
  const candidates = resp['risks'] ?? resp['signals'] ?? resp['data'] ?? resp['results'] ?? resp['result'];

  if (Array.isArray(candidates)) {
    for (const item of candidates) {
      if (typeof item === 'object' && item !== null) {
        results.push(normalizeRiskSignal(item as Record<string, unknown>, agent));
      }
    }
  } else if (typeof candidates === 'object' && candidates !== null) {
    results.push(normalizeRiskSignal(candidates as Record<string, unknown>, agent));
  }

  if (results.length === 0 && Object.keys(resp).length > 0) {
    results.push(normalizeRiskSignal(resp, agent));
  }

  return results;
}

/** Normalize a raw object into a typed RiskSignal. */
function normalizeRiskSignal(raw: Record<string, unknown>, agent: AgentRef): RiskSignal {
  return {
    id: String(raw['id'] ?? crypto.randomUUID()),
    category: normalizeRiskCategory(raw['category']),
    severity: normalizeSeverity(raw['severity']),
    description: String(raw['description'] ?? raw['summary'] ?? ''),
    source: String(raw['source'] ?? `${agent.domain}/${agent.agent}`),
    correlatedWith: normalizeStringArray(raw['correlatedWith'] ?? raw['correlated_with']),
    rootCause: String(raw['rootCause'] ?? raw['root_cause'] ?? ''),
    mitigationSuggestion: String(raw['mitigationSuggestion'] ?? raw['mitigation_suggestion'] ?? raw['mitigation'] ?? ''),
  };
}

/** Extract a typed ReliabilityReport from Workstream C results. */
function extractReliabilityReport(ws: WorkstreamResult | undefined): ReliabilityReport {
  const defaults: ReliabilityReport = {
    overallScore: 0,
    hallucinationScore: 0,
    faithfulnessScore: 0,
    biasScore: 0,
    stressResilienceScore: 0,
    redTeamFindings: [],
    recommendation: 'caution',
  };

  if (!ws || ws.successCount === 0) return defaults;

  const scores: Partial<Record<string, number>> = {};
  const findings: string[] = [];

  for (const result of ws.agentResults) {
    if (result.status < 200 || result.status >= 300 || !result.response) continue;

    const resp = result.response as Record<string, unknown>;
    const agentName = result.agent.agent;
    const score = extractScore(resp);

    switch (agentName) {
      case 'hallucination':
        scores['hallucination'] = score;
        break;
      case 'faithfulness':
        scores['faithfulness'] = score;
        break;
      case 'bias':
        scores['bias'] = score;
        break;
      case 'stress':
        scores['stress'] = score;
        break;
      case 'red-team':
      case 'adversarial': {
        const rtFindings = resp['findings'] ?? resp['vulnerabilities'] ?? resp['issues'];
        if (Array.isArray(rtFindings)) {
          for (const f of rtFindings) {
            findings.push(typeof f === 'string' ? f : JSON.stringify(f));
          }
        }
        break;
      }
    }
  }

  const hallucinationScore = scores['hallucination'] ?? 0;
  const faithfulnessScore = scores['faithfulness'] ?? 0;
  const biasScore = scores['bias'] ?? 0;
  const stressResilienceScore = scores['stress'] ?? 0;

  const scoreCount = Object.keys(scores).length;
  const overallScore = scoreCount > 0
    ? (hallucinationScore + faithfulnessScore + biasScore + stressResilienceScore) / Math.max(scoreCount, 1)
    : 0;

  const recommendation: ReliabilityRecommendation =
    overallScore >= 0.8 ? 'reliable'
    : overallScore >= 0.5 ? 'caution'
    : 'unreliable';

  return {
    overallScore: clamp01(overallScore),
    hallucinationScore: clamp01(hallucinationScore),
    faithfulnessScore: clamp01(faithfulnessScore),
    biasScore: clamp01(biasScore),
    stressResilienceScore: clamp01(stressResilienceScore),
    redTeamFindings: findings,
    recommendation,
  };
}

// ============================================================================
// Convergence: Scenario Matrix
// ============================================================================

/** Build cross-references between scenarios and risk signals. */
function buildCrossReferences(
  scenarios: readonly Scenario[],
  riskSignals: readonly RiskSignal[],
): ScenarioCrossReference[] {
  const refs: ScenarioCrossReference[] = [];

  for (const scenario of scenarios) {
    // Find related risk signals by category overlap and keyword matching
    const related = riskSignals.filter(rs => {
      // Category alignment
      if (scenario.type === 'failure' && rs.category === 'operational') return true;
      if (scenario.type === 'integration' && rs.category === 'integration') return true;
      if (scenario.type === 'scaling' && rs.category === 'performance') return true;
      if (scenario.type === 'deployment' && rs.category === 'operational') return true;

      // Keyword overlap in descriptions
      const scenarioWords = new Set(scenario.description.toLowerCase().split(/\s+/).filter(w => w.length > 3));
      const signalWords = rs.description.toLowerCase().split(/\s+/).filter(w => w.length > 3);
      const overlap = signalWords.filter(w => scenarioWords.has(w)).length;
      return overlap >= 2;
    });

    refs.push({
      scenarioId: scenario.id,
      relatedRiskSignals: related.map(r => r.id),
      reliabilityImpact: related.length > 0
        ? `${related.length} risk signal(s) correlated — review mitigation alignment`
        : 'No directly correlated risk signals',
    });
  }

  return refs;
}

/** Compute the overall risk level from signals and scenarios. */
function computeOverallRiskLevel(
  riskSignals: readonly RiskSignal[],
  scenarios: readonly Scenario[],
): ImpactLevel {
  // Check for critical severity
  if (riskSignals.some(r => r.severity === 'critical')) return 'critical';
  if (scenarios.some(s => s.impact === 'critical' && s.probability === 'high')) return 'critical';

  // Check for high severity
  const highSignals = riskSignals.filter(r => r.severity === 'high').length;
  const highScenarios = scenarios.filter(s => s.impact === 'high').length;
  if (highSignals >= 3 || highScenarios >= 2) return 'high';
  if (highSignals >= 1 || highScenarios >= 1) return 'medium';

  return 'low';
}

// ============================================================================
// DecisionGraph Write
// ============================================================================

/** Write all Pass 2 outputs to the DecisionGraph. */
function writeToGraph(
  graph: DecisionGraph,
  scenarios: readonly Scenario[],
  riskSignals: readonly RiskSignal[],
  reliabilityReport: ReliabilityReport,
  scenarioMatrix: ScenarioMatrix,
  pass1Nodes: readonly DecisionGraphNode[],
  tracker: ProvenanceTracker,
  pass: PassNumber,
): string[] {
  const nodeIds: string[] = [];
  const pass1Ids = pass1Nodes.map(n => n.id).slice(0, 5);

  // Write scenario nodes
  for (const scenario of scenarios) {
    const node = graph.createNode({
      type: 'scenario',
      name: `Scenario: ${scenario.name}`,
      content: scenario as unknown as Record<string, unknown>,
      summary: `${scenario.type} scenario — ${scenario.description.slice(0, 100)}`,
      producedBy: { domain: 'simulator', agent: 'scenario', role: 'Scenario Generator' },
      pass,
      derivedFrom: pass1Ids,
      confidence: probabilityToConfidence(scenario.probability),
      tags: [`scenario:${scenario.type}`, `impact:${scenario.impact}`, `probability:${scenario.probability}`],
    });
    nodeIds.push(node.id);

    tracker.recordInvocation({
      agent: { domain: 'simulator', agent: 'scenario', role: 'Scenario Generator' },
      pass,
      passName: 'Simulation & Scenario Modeling',
      workstream: 'scenario-generation',
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      durationMs: 0,
      inputNodeIds: pass1Ids,
      outputNodeIds: [node.id],
      artifactNumbers: [4],
      status: 'success',
      confidence: probabilityToConfidence(scenario.probability),
    });
  }

  // Write risk signal nodes
  for (const signal of riskSignals) {
    const node = graph.createNode({
      type: 'risk_signal',
      name: `Risk Signal: ${signal.description.slice(0, 60)}`,
      content: signal as unknown as Record<string, unknown>,
      summary: `${signal.category} risk (${signal.severity}) — ${signal.description.slice(0, 100)}`,
      producedBy: { domain: 'sentinel', agent: signal.source.split('/')[1] ?? 'anomaly', role: 'Risk Detection' },
      pass,
      derivedFrom: pass1Ids,
      confidence: severityToConfidence(signal.severity),
      tags: [`risk:${signal.category}`, `severity:${signal.severity}`],
    });
    nodeIds.push(node.id);
  }

  // Write reliability report node
  const reliabilityNode = graph.createNode({
    type: 'reliability_report',
    name: 'Model Reliability Report',
    content: reliabilityReport as unknown as Record<string, unknown>,
    summary: `Model reliability: ${reliabilityReport.recommendation} (overall score: ${(reliabilityReport.overallScore * 100).toFixed(0)}%)`,
    producedBy: { domain: 'test-bench', agent: 'quality', role: 'Model Reliability Assessment' },
    pass,
    derivedFrom: pass1Ids,
    confidence: reliabilityReport.overallScore,
    tags: [`reliability:${reliabilityReport.recommendation}`],
  });
  nodeIds.push(reliabilityNode.id);

  // Write scenario matrix convergence node
  const matrixNode = graph.createNode({
    type: 'scenario',
    name: 'Scenario Matrix (Convergence)',
    content: {
      scenarioCount: scenarioMatrix.scenarios.length,
      riskSignalCount: scenarioMatrix.riskSignals.length,
      reliabilityScore: scenarioMatrix.reliabilityReport.overallScore,
      overallRiskLevel: scenarioMatrix.overallRiskLevel,
      crossReferenceCount: scenarioMatrix.crossReferences.length,
    },
    summary: `Pass 2 convergence: ${scenarioMatrix.scenarios.length} scenarios, ${scenarioMatrix.riskSignals.length} risk signals, overall risk: ${scenarioMatrix.overallRiskLevel}`,
    producedBy: { domain: 'pipeline', agent: 'pass2-convergence', role: 'Scenario Matrix Builder' },
    pass,
    derivedFrom: nodeIds.slice(0, 10),
    confidence: reliabilityReport.overallScore > 0 ? reliabilityReport.overallScore : 0.5,
    tags: ['convergence', `risk-level:${scenarioMatrix.overallRiskLevel}`],
  });
  nodeIds.push(matrixNode.id);

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
  const results: AgentInvocationResult[] = [];

  const promises = agents.map(async (agent): Promise<AgentInvocationResult> => {
    const start = Date.now();
    const timestamp = new Date().toISOString();

    try {
      const { executeAgentsInvokeCommand } = await import('../../commands/agents.js');
      const result = await executeAgentsInvokeCommand(
        agent.domain,
        agent.agent,
        JSON.stringify(payload),
        { format: 'json' },
      );
      return {
        agent,
        status: result.status,
        response: result.response,
        durationMs: Date.now() - start,
        pass,
        timestamp,
      };
    } catch (err) {
      return {
        agent,
        status: 500,
        response: { error: err instanceof Error ? err.message : String(err) },
        durationMs: Date.now() - start,
        pass,
        timestamp,
      };
    }
  });

  const settled = await Promise.allSettled(promises);
  for (let i = 0; i < settled.length; i++) {
    const outcome = settled[i]!;
    if (outcome.status === 'fulfilled') {
      results.push(outcome.value);
    } else {
      results.push({
        agent: agents[i]!,
        status: 500,
        response: { error: String(outcome.reason) },
        durationMs: 0,
        pass,
        timestamp: new Date().toISOString(),
      });
    }
  }

  return results;
}

// ============================================================================
// Minimum Scenario Enforcement
// ============================================================================

/** Ensure at least 3 scenarios exist with required types. */
function ensureMinimumScenarios(scenarios: Scenario[], prompt: string): void {
  const hasDeployment = scenarios.some(s => s.type === 'deployment');
  const hasFailure = scenarios.some(s => s.type === 'failure');

  if (!hasDeployment) {
    scenarios.push({
      id: crypto.randomUUID(),
      type: 'deployment',
      name: 'Standard Phased Deployment',
      description: `Phased rollout for: ${prompt.slice(0, 80)}`,
      assumptions: ['Standard deployment infrastructure available', 'Team capacity sufficient for pilot'],
      probability: 'medium',
      impact: 'medium',
      expectedOutcome: 'Successful deployment with standard risk profile',
      mitigationStrategy: 'Phased rollout with rollback capability at each stage',
      metrics: { deploymentSuccessProbability: 0.75, estimatedRecoveryTime: 'PT4H' },
    });
  }

  if (!hasFailure) {
    scenarios.push({
      id: crypto.randomUUID(),
      type: 'failure',
      name: 'Integration Failure Scenario',
      description: `Integration failure during: ${prompt.slice(0, 80)}`,
      assumptions: ['External system API may change without notice'],
      probability: 'medium',
      impact: 'high',
      expectedOutcome: 'Service degradation requiring manual intervention',
      mitigationStrategy: 'Circuit breaker pattern with automated failover',
      metrics: { failureProbability: 0.25, estimatedRecoveryTime: 'PT2H' },
    });
  }

  while (scenarios.length < 3) {
    scenarios.push({
      id: crypto.randomUUID(),
      type: 'scaling',
      name: 'Load Scaling Scenario',
      description: `System behavior under 10x load increase for: ${prompt.slice(0, 80)}`,
      assumptions: ['Cloud auto-scaling enabled', 'Database can handle connection pooling'],
      probability: 'low',
      impact: 'medium',
      expectedOutcome: 'Graceful degradation under peak load',
      mitigationStrategy: 'Horizontal scaling with load balancing and caching',
      metrics: { reliabilityProbability: 0.85 },
    });
  }
}

// ============================================================================
// Normalization Helpers
// ============================================================================

function normalizeScenarioType(raw: unknown): ScenarioType {
  const VALID: Set<string> = new Set(['deployment', 'integration', 'failure', 'scaling', 'edge_case']);
  const str = String(raw ?? '').toLowerCase().replace(/[\s-]/g, '_');
  return VALID.has(str) ? str as ScenarioType : 'deployment';
}

function normalizeProbability(raw: unknown): ProbabilityLevel {
  const str = String(raw ?? '').toLowerCase();
  if (str === 'high') return 'high';
  if (str === 'low') return 'low';
  return 'medium';
}

function normalizeImpact(raw: unknown): ImpactLevel {
  const str = String(raw ?? '').toLowerCase();
  if (str === 'critical') return 'critical';
  if (str === 'high') return 'high';
  if (str === 'low') return 'low';
  return 'medium';
}

function normalizeRiskCategory(raw: unknown): RiskCategory {
  const VALID: Set<string> = new Set(['operational', 'integration', 'security', 'compliance', 'performance']);
  const str = String(raw ?? '').toLowerCase();
  return VALID.has(str) ? str as RiskCategory : 'operational';
}

function normalizeSeverity(raw: unknown): SeverityLevel {
  const str = String(raw ?? '').toLowerCase();
  if (str === 'critical') return 'critical';
  if (str === 'high') return 'high';
  if (str === 'low') return 'low';
  return 'medium';
}

function normalizeStringArray(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map(String);
  if (typeof raw === 'string') return [raw];
  return [];
}

function normalizeMetrics(raw: unknown): ScenarioMetrics {
  if (!raw || typeof raw !== 'object') return {};
  const m = raw as Record<string, unknown>;
  return {
    reliabilityProbability: typeof m['reliabilityProbability'] === 'number' ? clamp01(m['reliabilityProbability']) : undefined,
    failureProbability: typeof m['failureProbability'] === 'number' ? clamp01(m['failureProbability']) : undefined,
    deploymentSuccessProbability: typeof m['deploymentSuccessProbability'] === 'number' ? clamp01(m['deploymentSuccessProbability']) : undefined,
    estimatedRecoveryTime: typeof m['estimatedRecoveryTime'] === 'string' ? m['estimatedRecoveryTime'] : undefined,
  };
}

function extractScore(resp: Record<string, unknown>): number {
  const score = resp['score'] ?? resp['confidence'] ?? resp['value'] ?? resp['result'];
  if (typeof score === 'number') return clamp01(score);
  if (typeof score === 'string') {
    const n = parseFloat(score);
    if (!isNaN(n)) return clamp01(n > 1 ? n / 100 : n);
  }
  return 0;
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

function probabilityToConfidence(p: ProbabilityLevel): number {
  switch (p) {
    case 'high': return 0.9;
    case 'medium': return 0.7;
    case 'low': return 0.5;
  }
}

function severityToConfidence(s: SeverityLevel): number {
  switch (s) {
    case 'critical': return 0.95;
    case 'high': return 0.85;
    case 'medium': return 0.7;
    case 'low': return 0.5;
  }
}
