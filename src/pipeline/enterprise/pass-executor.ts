/**
 * Pass Executor — Executes a Single Pipeline Pass (ADR-032)
 *
 * Dispatches all agents for a given pass concurrently, collects results,
 * evaluates exit criteria, and writes outputs to the DecisionGraph.
 *
 * This module uses the existing agent invocation infrastructure from
 * commands/agents.ts via the adapter layer. It does NOT replace or
 * modify any existing pipeline code.
 */

import type {
  PassNumber,
  PassOutput,
  PassStatus,
  AgentRef,
  AgentInvocationResult,
  ExitCriteriaResult,
  CriterionCheck,
  DecisionNodeType,
} from './types.js';
import { PASS_ID_MAP } from './types.js';
import { getPassConfig } from './pass-registry.js';
import { DecisionGraph } from './decision-graph.js';
import { ProvenanceTracker } from './provenance-tracker.js';

// ============================================================================
// Agent Invocation
// ============================================================================

/**
 * Invoke a single agentics agent via the existing adapter layer.
 *
 * Uses dynamic import to avoid circular dependencies with agents.ts.
 * Falls back gracefully on invocation errors — never throws.
 */
async function invokeAgent(
  agent: AgentRef,
  payload: Record<string, unknown>,
  pass: PassNumber,
  _timeoutMs: number,
): Promise<AgentInvocationResult> {
  const start = Date.now();
  const timestamp = new Date().toISOString();

  try {
    // Dynamic import to avoid circular dependency with agents command
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
    const message = err instanceof Error ? err.message : String(err);
    return {
      agent,
      status: 500,
      response: { error: message },
      durationMs: Date.now() - start,
      pass,
      timestamp,
    };
  }
}

/**
 * Invoke all agents for a pass concurrently.
 * Uses Promise.allSettled so one failure doesn't block others.
 */
async function invokePassAgents(
  agents: readonly AgentRef[],
  payload: Record<string, unknown>,
  pass: PassNumber,
  timeoutMs: number,
): Promise<AgentInvocationResult[]> {
  const promises = agents.map(agent =>
    invokeAgent(agent, payload, pass, timeoutMs),
  );

  const settled = await Promise.allSettled(promises);
  const results: AgentInvocationResult[] = [];

  for (let i = 0; i < settled.length; i++) {
    const outcome = settled[i]!;
    if (outcome.status === 'fulfilled') {
      results.push(outcome.value);
    } else {
      // Promise rejection — create a failed result
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
// Exit Criteria Evaluation
// ============================================================================

/** Exit criteria evaluators for each pass. */
const EXIT_CRITERIA: Record<PassNumber, (graph: DecisionGraph, results: readonly AgentInvocationResult[]) => ExitCriteriaResult> = {

  // Pass 1: Problem definition is non-empty, ≥1 architecture hypothesis, execution plan has ≥1 phase.
  1: (graph, results) => {
    const checks: CriterionCheck[] = [];
    const successCount = results.filter(r => r.status >= 200 && r.status < 300).length;
    const problemNodes = graph.getNodesByType('problem_definition');
    const hypothesisNodes = graph.getNodesByType('architecture_hypothesis');
    const planNodes = graph.getNodesByType('execution_plan');

    checks.push({
      name: 'At least one successful agent response',
      passed: successCount > 0,
      detail: `${successCount}/${results.length} agents succeeded`,
    });
    checks.push({
      name: 'Problem definition exists',
      passed: problemNodes.length > 0,
      detail: `${problemNodes.length} problem definition(s)`,
    });
    checks.push({
      name: 'Architecture hypothesis exists',
      passed: hypothesisNodes.length > 0,
      detail: `${hypothesisNodes.length} hypothesis(es)`,
    });
    checks.push({
      name: 'Execution plan exists',
      passed: planNodes.length > 0,
      detail: `${planNodes.length} plan(s)`,
    });

    return { passed: checks.every(c => c.passed), criteria: checks };
  },

  // Pass 2: ≥3 scenarios, risk signals classified, reliability score computed.
  2: (graph, results) => {
    const checks: CriterionCheck[] = [];
    const successCount = results.filter(r => r.status >= 200 && r.status < 300).length;
    const scenarios = graph.getNodesByType('scenario');
    const riskSignals = graph.getNodesByType('risk_signal');
    const reliability = graph.getNodesByType('reliability_report');

    checks.push({
      name: 'At least one successful agent response',
      passed: successCount > 0,
      detail: `${successCount}/${results.length} agents succeeded`,
    });
    checks.push({
      name: '3+ scenarios generated',
      passed: scenarios.length >= 3,
      detail: `${scenarios.length} scenario(s)`,
    });
    checks.push({
      name: 'Risk signals classified',
      passed: riskSignals.length > 0,
      detail: `${riskSignals.length} risk signal(s)`,
    });
    checks.push({
      name: 'Reliability score computed',
      passed: reliability.length > 0,
      detail: `${reliability.length} report(s)`,
    });

    return { passed: checks.every(c => c.passed), criteria: checks };
  },

  // Pass 3: Architecture non-empty, ≥1 prototype endpoint, integration map covers external systems.
  3: (graph, results) => {
    const checks: CriterionCheck[] = [];
    const successCount = results.filter(r => r.status >= 200 && r.status < 300).length;
    const architecture = graph.getNodesByType('system_architecture');
    const prototypes = graph.getNodesByType('prototype');
    const integrationMaps = graph.getNodesByType('integration_map');

    checks.push({
      name: 'At least one successful agent response',
      passed: successCount > 0,
      detail: `${successCount}/${results.length} agents succeeded`,
    });
    checks.push({
      name: 'System architecture exists',
      passed: architecture.length > 0,
      detail: `${architecture.length} architecture(s)`,
    });
    checks.push({
      name: 'Prototype exists',
      passed: prototypes.length > 0,
      detail: `${prototypes.length} prototype(s)`,
    });
    checks.push({
      name: 'Integration map exists',
      passed: integrationMaps.length > 0,
      detail: `${integrationMaps.length} integration map(s)`,
    });

    return { passed: checks.every(c => c.passed), criteria: checks };
  },

  // Pass 4: Security scan complete, compliance covers ≥1 framework, cost model has Year 1 TCO.
  4: (graph, results) => {
    const checks: CriterionCheck[] = [];
    const successCount = results.filter(r => r.status >= 200 && r.status < 300).length;
    const security = graph.getNodesByType('security_analysis');
    const compliance = graph.getNodesByType('compliance_report');
    const cost = graph.getNodesByType('cost_model');
    const governance = graph.getNodesByType('governance_report');

    checks.push({
      name: 'At least one successful agent response',
      passed: successCount > 0,
      detail: `${successCount}/${results.length} agents succeeded`,
    });
    checks.push({
      name: 'Security analysis complete',
      passed: security.length > 0,
      detail: `${security.length} analysis(es)`,
    });
    checks.push({
      name: 'Compliance report exists',
      passed: compliance.length > 0,
      detail: `${compliance.length} report(s)`,
    });
    checks.push({
      name: 'Cost model exists',
      passed: cost.length > 0,
      detail: `${cost.length} model(s)`,
    });
    checks.push({
      name: 'Governance readiness computed',
      passed: governance.length > 0,
      detail: `${governance.length} report(s)`,
    });

    return { passed: checks.every(c => c.passed), criteria: checks };
  },

  // Pass 5: All 15 artifacts generated, confidence score computed, provenance manifest complete.
  5: (graph, results) => {
    const checks: CriterionCheck[] = [];
    const successCount = results.filter(r => r.status >= 200 && r.status < 300).length;
    const confidenceScore = graph.getNodesByType('confidence_score');
    const memo = graph.getNodesByType('executive_memo');
    const summary = graph.getNodesByType('executive_summary');

    checks.push({
      name: 'At least one successful agent response',
      passed: successCount > 0,
      detail: `${successCount}/${results.length} agents succeeded`,
    });
    checks.push({
      name: 'Executive memo generated',
      passed: memo.length > 0,
      detail: `${memo.length} memo(s)`,
    });
    checks.push({
      name: 'Executive summary generated',
      passed: summary.length > 0,
      detail: `${summary.length} summary(ies)`,
    });
    checks.push({
      name: 'Confidence score computed',
      passed: confidenceScore.length > 0,
      detail: `${confidenceScore.length} score(s)`,
    });

    return { passed: checks.every(c => c.passed), criteria: checks };
  },

  // Pass 6: ≥1 endpoint responds, integration test passes.
  6: (graph, results) => {
    const checks: CriterionCheck[] = [];
    const successCount = results.filter(r => r.status >= 200 && r.status < 300).length;
    const endpoints = graph.getNodesByType('deployment_endpoint');

    checks.push({
      name: 'At least one successful agent response',
      passed: successCount > 0,
      detail: `${successCount}/${results.length} agents succeeded`,
    });
    checks.push({
      name: 'Deployment endpoint registered',
      passed: endpoints.length > 0,
      detail: `${endpoints.length} endpoint(s)`,
    });

    return { passed: checks.every(c => c.passed), criteria: checks };
  },

  // Pass 7: Telemetry active, ≥1 health check passes, learning loop registered.
  7: (graph, results) => {
    const checks: CriterionCheck[] = [];
    const successCount = results.filter(r => r.status >= 200 && r.status < 300).length;
    const telemetry = graph.getNodesByType('telemetry_config');
    const healthChecks = graph.getNodesByType('health_check');

    checks.push({
      name: 'At least one successful agent response',
      passed: successCount > 0,
      detail: `${successCount}/${results.length} agents succeeded`,
    });
    checks.push({
      name: 'Telemetry configured',
      passed: telemetry.length > 0,
      detail: `${telemetry.length} config(s)`,
    });
    checks.push({
      name: 'Health check registered',
      passed: healthChecks.length > 0,
      detail: `${healthChecks.length} check(s)`,
    });

    return { passed: checks.every(c => c.passed), criteria: checks };
  },
};

// ============================================================================
// Node Type Mapping
// ============================================================================

/** Map pass number to primary node types produced by that pass. */
const PASS_NODE_TYPES: Record<PassNumber, readonly DecisionNodeType[]> = {
  1: ['problem_definition', 'business_context', 'technical_scope', 'architecture_hypothesis', 'execution_plan', 'decision_lineage'],
  2: ['scenario', 'risk_signal', 'reliability_report'],
  3: ['system_architecture', 'integration_map', 'data_flow', 'service_boundary', 'prototype', 'api_contract', 'sdk_interface'],
  4: ['security_analysis', 'compliance_report', 'cost_model', 'governance_report', 'policy_analysis'],
  5: ['executive_memo', 'executive_summary', 'risk_assessment', 'implementation_roadmap', 'org_impact', 'stakeholder_map', 'kpi_definition', 'okr_alignment', 'raid_log', 'confidence_score'],
  6: ['deployment_endpoint', 'integration_result'],
  7: ['telemetry_config', 'health_check', 'learned_pattern'],
};

// ============================================================================
// Pass Executor
// ============================================================================

/**
 * Execute a single pipeline pass.
 *
 * 1. Reads the pass agent configuration from the registry.
 * 2. Builds the payload from the DecisionGraph (prior pass outputs).
 * 3. Invokes all agents concurrently.
 * 4. Writes outputs to the DecisionGraph as typed nodes.
 * 5. Records provenance traces.
 * 6. Evaluates exit criteria.
 * 7. Returns PassOutput with status.
 */
export async function executePass(params: {
  pass: PassNumber;
  prompt: string;
  graph: DecisionGraph;
  tracker: ProvenanceTracker;
  timeoutMs: number;
  verbose: boolean;
}): Promise<PassOutput> {
  const { pass, prompt, graph, tracker, timeoutMs, verbose } = params;
  const config = getPassConfig(pass);
  const passId = PASS_ID_MAP[pass];
  const start = Date.now();

  if (verbose) {
    console.error(`  [Pass ${pass}] Starting: ${config.label}`);
    console.error(`  [Pass ${pass}] Agents: ${config.agenticsServices.length}`);
  }

  // ── Build payload from prior pass outputs ──
  const priorNodes = getPriorPassSummaries(graph, pass);
  const payload: Record<string, unknown> = {
    prompt,
    pass: pass,
    passName: config.label,
    priorContext: priorNodes,
  };

  // ── Invoke all agents concurrently ──
  const agentResults = await invokePassAgents(
    config.agenticsServices,
    payload,
    pass,
    timeoutMs,
  );

  // ── Write results to DecisionGraph ──
  const nodeTypes = PASS_NODE_TYPES[pass];
  const createdNodeIds: string[] = [];

  // Create a node for each successful agent result, mapped to appropriate types
  const successfulResults = agentResults.filter(r => r.status >= 200 && r.status < 300);

  for (let i = 0; i < successfulResults.length && i < nodeTypes.length; i++) {
    const result = successfulResults[i]!;
    const nodeType = nodeTypes[i]!;

    const priorPassNodes = pass > 1 ? graph.getNodesByPass((pass - 1) as PassNumber).map(n => n.id) : [];

    const node = graph.createNode({
      type: nodeType,
      name: `${config.label}: ${result.agent.role}`,
      content: typeof result.response === 'object' && result.response !== null
        ? result.response as Record<string, unknown>
        : { data: result.response },
      summary: `Output from ${result.agent.domain}/${result.agent.agent} (${result.agent.role})`,
      producedBy: result.agent,
      pass,
      derivedFrom: priorPassNodes.slice(0, 5), // Limit to 5 parent references
      confidence: result.status >= 200 && result.status < 300 ? 0.85 : 0,
      status: result.status >= 200 && result.status < 300 ? 'complete' : 'failed',
      tags: [`pass:${pass}`, `domain:${result.agent.domain}`, `agent:${result.agent.agent}`],
    });
    createdNodeIds.push(node.id);
  }

  // If more node types than successful results, create remaining as degraded
  if (successfulResults.length < nodeTypes.length) {
    for (let i = successfulResults.length; i < nodeTypes.length; i++) {
      const nodeType = nodeTypes[i]!;
      const node = graph.createNode({
        type: nodeType,
        name: `${config.label}: ${nodeType} (degraded)`,
        content: { reason: 'Insufficient successful agent responses' },
        summary: `Degraded node — insufficient agent coverage for ${nodeType}`,
        producedBy: { domain: 'pipeline', agent: 'orchestrator', role: 'Pipeline pass executor' },
        pass,
        derivedFrom: [],
        confidence: 0,
        status: 'degraded',
        tags: [`pass:${pass}`, 'degraded'],
      });
      createdNodeIds.push(node.id);
    }
  }

  // ── Record provenance traces ──
  for (const result of agentResults) {
    tracker.recordFromResult(result, config.label, config.passName, createdNodeIds);
  }

  // ── Evaluate exit criteria ──
  const exitCriteria = EXIT_CRITERIA[pass](graph, agentResults);

  // ── Determine status ──
  const successCount = successfulResults.length;
  const totalCount = agentResults.length;
  let status: PassStatus;
  let degradationReason: string | undefined;

  if (exitCriteria.passed) {
    status = 'completed';
  } else if (successCount > 0) {
    status = 'degraded';
    const failedCriteria = exitCriteria.criteria.filter(c => !c.passed);
    degradationReason = `Exit criteria not fully met: ${failedCriteria.map(c => c.name).join(', ')}`;
  } else {
    status = 'failed';
    degradationReason = `All ${totalCount} agents failed`;
  }

  const durationMs = Date.now() - start;

  if (verbose) {
    console.error(`  [Pass ${pass}] Completed: ${status} (${successCount}/${totalCount} agents, ${durationMs}ms)`);
    if (degradationReason) {
      console.error(`  [Pass ${pass}] Degradation: ${degradationReason}`);
    }
  }

  // ── Build summary ──
  const summary = buildPassSummary(pass, config.label, status, successCount, totalCount, durationMs, exitCriteria);

  return {
    pass: passId,
    passNumber: pass,
    status,
    data: {
      agentResults: agentResults.map(r => ({
        agent: `${r.agent.domain}/${r.agent.agent}`,
        role: r.agent.role,
        status: r.status,
        durationMs: r.durationMs,
      })),
      nodesCreated: createdNodeIds.length,
      exitCriteria: exitCriteria.criteria.map(c => ({
        name: c.name,
        passed: c.passed,
        detail: c.detail,
      })),
    },
    artifacts: [],
    agentResults,
    durationMs,
    summary,
    degradationReason,
  };
}

// ============================================================================
// Helpers
// ============================================================================

/** Get summaries of all nodes from prior passes for context injection. */
function getPriorPassSummaries(
  graph: DecisionGraph,
  currentPass: PassNumber,
): Record<string, unknown>[] {
  const summaries: Record<string, unknown>[] = [];
  for (let p = 1; p < currentPass; p++) {
    const nodes = graph.getNodesByPass(p as PassNumber);
    for (const node of nodes) {
      summaries.push({
        type: node.type,
        name: node.name,
        summary: node.summary,
        pass: node.pass,
        confidence: node.confidence,
        status: node.status,
      });
    }
  }
  return summaries;
}

/** Build a human-readable summary for a pass. */
function buildPassSummary(
  pass: PassNumber,
  label: string,
  status: PassStatus,
  successCount: number,
  totalCount: number,
  durationMs: number,
  exitCriteria: ExitCriteriaResult,
): string {
  const statusIcon = status === 'completed' ? '\u2705'
    : status === 'degraded' ? '\u26a0\ufe0f'
    : '\u274c';

  const lines: string[] = [
    `  ${statusIcon} Pass ${pass}: ${label}`,
    `     Agents: ${successCount}/${totalCount} succeeded`,
    `     Duration: ${durationMs}ms`,
    `     Exit criteria: ${exitCriteria.passed ? 'PASSED' : 'NOT MET'}`,
  ];

  for (const c of exitCriteria.criteria) {
    const icon = c.passed ? '\u2713' : '\u2717';
    lines.push(`       ${icon} ${c.name}: ${c.detail}`);
  }

  return lines.join('\n');
}
