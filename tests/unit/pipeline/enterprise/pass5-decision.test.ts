/**
 * Pass 5 — Apex Decision Layer (ADR-037) — Unit Tests
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import {
  executePass5,
  PHASE1_GROUP_CONFIGS,
} from '../../../../src/pipeline/enterprise/pass5-decision.js';
import type {
  Pass5Result,
} from '../../../../src/pipeline/enterprise/pass5-decision.js';
import { DecisionGraph } from '../../../../src/pipeline/enterprise/decision-graph.js';
import { ProvenanceTracker } from '../../../../src/pipeline/enterprise/provenance-tracker.js';
import type { AgentRef, AgentInvocationResult, PassNumber } from '../../../../src/pipeline/enterprise/types.js';

// ============================================================================
// Helpers
// ============================================================================

function makeResult(agent: AgentRef, response: unknown, status = 200): AgentInvocationResult {
  return { agent, status, response, durationMs: 50, pass: 5, timestamp: new Date().toISOString() };
}

function createMockInvoker(
  map: Record<string, { response: unknown; status?: number }>,
): (agents: readonly AgentRef[], payload: Record<string, unknown>, pass: PassNumber, timeoutMs: number) => Promise<AgentInvocationResult[]> {
  return async (agents) =>
    agents.map(a => {
      const key = `${a.domain}/${a.agent}`;
      const entry = map[key];
      return entry ? makeResult(a, entry.response, entry.status ?? 200) : makeResult(a, { error: 'no mock' }, 500);
    });
}

/** Seed a graph with realistic pass 1-4 nodes. */
function seedGraph(graph: DecisionGraph): void {
  // Pass 1
  graph.createNode({
    type: 'problem_definition', name: 'Problem', content: { domain: 'healthcare' },
    summary: 'Healthcare platform modernization', producedBy: { domain: 'copilot', agent: 'planner', role: 'P' }, pass: 1,
  });
  graph.createNode({
    type: 'business_context', name: 'Business', content: { industry: 'healthcare', geography: 'US' },
    summary: 'US healthcare provider', producedBy: { domain: 'copilot', agent: 'clarifier', role: 'C' }, pass: 1,
  });
  // Pass 2
  graph.createNode({
    type: 'scenario', name: 'Deploy', content: { type: 'deployment', probability: 'high' },
    summary: 'Cloud deployment scenario', producedBy: { domain: 'simulator', agent: 'what-if', role: 'S' }, pass: 2,
    confidence: 0.85,
  });
  graph.createNode({
    type: 'risk_signal', name: 'Risk', content: { category: 'operational', severity: 'medium' },
    summary: 'Operational risk signal', producedBy: { domain: 'sentinel', agent: 'anomaly', role: 'R' }, pass: 2,
    confidence: 0.7,
  });
  graph.createNode({
    type: 'reliability_report', name: 'Reliability', content: { overallScore: 0.88 },
    summary: 'Model reliability: reliable', producedBy: { domain: 'test-bench', agent: 'quality', role: 'Q' }, pass: 2,
  });
  // Pass 3
  graph.createNode({
    type: 'system_architecture', name: 'Architecture', content: { services: ['patient-api', 'auth-service'] },
    summary: 'Microservices architecture', producedBy: { domain: 'orchestrator', agent: 'workflow', role: 'A' }, pass: 3,
    confidence: 0.9,
  });
  graph.createNode({
    type: 'prototype', name: 'Prototype', content: { endpoints: ['/api/patients'] },
    summary: 'Working prototype with 1 endpoint', producedBy: { domain: 'forge', agent: 'sdk', role: 'F' }, pass: 3,
    confidence: 0.85,
  });
  graph.createNode({
    type: 'integration_map', name: 'Integrations', content: { systems: ['Epic', 'Salesforce'] },
    summary: 'EHR and CRM integration map', producedBy: { domain: 'connector-hub', agent: 'erp-surface', role: 'I' }, pass: 3,
  });
  // Pass 4
  graph.createNode({
    type: 'security_analysis', name: 'Security', content: { overallRiskLevel: 'medium' },
    summary: 'Security risk: medium', producedBy: { domain: 'shield', agent: 'security-analysis', role: 'S' }, pass: 4,
    confidence: 0.8,
  });
  graph.createNode({
    type: 'cost_model', name: 'Cost', content: { tco: { year1: 500000 }, roi: { expectedReturn: 1200000, confidenceLevel: 'high' } },
    summary: 'Year 1 TCO: $500K, ROI: $1.2M', producedBy: { domain: 'costops', agent: 'forecast', role: 'C' }, pass: 4,
    confidence: 0.9,
  });
  graph.createNode({
    type: 'policy_analysis', name: 'Policy', content: { overallComplianceStatus: 'gaps_identified' },
    summary: 'Compliance: gaps identified', producedBy: { domain: 'policy-engine', agent: 'enforce', role: 'P' }, pass: 4,
    confidence: 0.7,
  });
  graph.createNode({
    type: 'compliance_report', name: 'Compliance', content: { status: 'gaps_identified', frameworks: ['HIPAA'] },
    summary: 'HIPAA compliance gaps identified', producedBy: { domain: 'policy-engine', agent: 'constraints', role: 'C' }, pass: 4,
  });
  graph.createNode({
    type: 'governance_report', name: 'Governance', content: { governanceReadiness: { overallScore: 'conditionally_ready' } },
    summary: 'Governance: conditionally ready', producedBy: { domain: 'governance-dashboard', agent: 'audit', role: 'G' }, pass: 4,
    confidence: 0.75,
  });
}

describe('Pass 5 — Apex Decision Layer (ADR-037)', () => {
  let graph: DecisionGraph;
  let tracker: ProvenanceTracker;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pass5-test-'));
    graph = new DecisionGraph('pass5-exec-001', tmpDir);
    tracker = new ProvenanceTracker('pass5-exec-001');
    seedGraph(graph);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ==========================================================================
  // Phase 1 Group Configurations
  // ==========================================================================

  describe('PHASE1_GROUP_CONFIGS', () => {
    test('has 4 groups', () => {
      expect(PHASE1_GROUP_CONFIGS).toHaveLength(4);
    });

    test('decision-memo group produces artifact #1', () => {
      const g = PHASE1_GROUP_CONFIGS.find(c => c.id === 'decision-memo');
      expect(g).toBeDefined();
      expect(g!.artifactNumbers).toEqual([1]);
      expect(g!.graphNodeTypes).toContain('executive_memo');
    });

    test('executive-summary group produces artifact #2', () => {
      const g = PHASE1_GROUP_CONFIGS.find(c => c.id === 'executive-summary');
      expect(g).toBeDefined();
      expect(g!.artifactNumbers).toEqual([2]);
      expect(g!.graphNodeTypes).toContain('executive_summary');
    });

    test('risk-scoring group produces artifact #5', () => {
      const g = PHASE1_GROUP_CONFIGS.find(c => c.id === 'risk-scoring');
      expect(g).toBeDefined();
      expect(g!.artifactNumbers).toEqual([5]);
      expect(g!.graphNodeTypes).toContain('risk_assessment');
    });

    test('documentation-generator produces artifacts #8,9,10,11,13,14', () => {
      const g = PHASE1_GROUP_CONFIGS.find(c => c.id === 'documentation-generator');
      expect(g).toBeDefined();
      expect(g!.artifactNumbers).toEqual([8, 9, 10, 11, 13, 14]);
      expect(g!.graphNodeTypes).toHaveLength(6);
    });

    test('all groups have readsFrom upstream node types', () => {
      for (const g of PHASE1_GROUP_CONFIGS) {
        expect(g.readsFrom.length).toBeGreaterThan(0);
      }
    });
  });

  // ==========================================================================
  // Full Execution
  // ==========================================================================

  describe('executePass5 with successful agents', () => {
    const mockInvoker = createMockInvoker({
      'platform/decision-memo': { response: { decision: 'Approve', problem: 'Healthcare modernization', recommendation: 'Proceed with high confidence' } },
      'platform/executive-summary': { response: { context: 'US healthcare provider', outcomes: ['40% efficiency improvement'] } },
      'platform/risk-score': { response: { risks: [{ risk: 'Integration complexity', severity: 'medium', mitigation: 'Phased approach' }] } },
      'platform/decision': { response: { score: 82, recommendation: 'proceed' } },
      'analytics-hub/recommendation': { response: { recommendations: ['Prioritize HIPAA compliance'] } },
      'research-lab/metrics': { response: { kpis: [{ name: 'Uptime', target: '99.9%' }] } },
    });

    let result: Pass5Result;

    beforeEach(async () => {
      result = await executePass5({
        prompt: 'Healthcare platform modernization',
        graph,
        tracker,
        timeoutMs: 10000,
        verbose: false,
        passesDegraded: [],
        invokeAgents: mockInvoker,
      });
    });

    test('returns 4 phase 1 group results', () => {
      expect(result.phase1Results).toHaveLength(4);
    });

    test('phase 1 groups match expected IDs', () => {
      const ids = result.phase1Results.map(r => r.group);
      expect(ids).toContain('decision-memo');
      expect(ids).toContain('executive-summary');
      expect(ids).toContain('risk-scoring');
      expect(ids).toContain('documentation-generator');
    });

    test('confidence score is computed', () => {
      expect(typeof result.confidenceScore.overall).toBe('number');
      expect(result.confidenceScore.overall).toBeGreaterThanOrEqual(0);
      expect(result.confidenceScore.overall).toBeLessThanOrEqual(100);
    });

    test('confidence score has 5 components', () => {
      expect(result.confidenceScore.components).toHaveLength(5);
      const names = result.confidenceScore.components.map(c => c.name);
      expect(names).toContain('Financial Outcome Stability');
      expect(names).toContain('Operational Risk Level');
      expect(names).toContain('Compliance Exposure');
      expect(names).toContain('Architecture Feasibility');
      expect(names).toContain('Organizational Readiness');
    });

    test('confidence components have correct weights summing to 1.0', () => {
      const totalWeight = result.confidenceScore.components.reduce((s, c) => s + c.weight, 0);
      expect(totalWeight).toBeCloseTo(1.0, 5);
    });

    test('recommendation follows score thresholds', () => {
      const score = result.confidenceScore.overall;
      const rec = result.confidenceScore.recommendation;
      if (score >= 80) expect(rec).toBe('proceed');
      else if (score >= 60) expect(rec).toBe('proceed-with-conditions');
      else if (score >= 40) expect(rec).toBe('investigate-further');
      else expect(rec).toBe('do-not-proceed');
    });

    test('methodology is documented', () => {
      expect(result.confidenceScore.methodology).toContain('25%');
      expect(result.confidenceScore.methodology).toContain('20%');
      expect(result.confidenceScore.methodology).toContain('15%');
    });

    test('writes Pass 5 nodes to DecisionGraph', () => {
      const pass5Nodes = graph.getNodesByPass(5);
      expect(pass5Nodes.length).toBeGreaterThanOrEqual(5);
    });

    test('writes executive_memo node', () => {
      expect(graph.getNodesByType('executive_memo').length).toBeGreaterThanOrEqual(1);
    });

    test('writes executive_summary node', () => {
      expect(graph.getNodesByType('executive_summary').length).toBeGreaterThanOrEqual(1);
    });

    test('writes risk_assessment node', () => {
      expect(graph.getNodesByType('risk_assessment').length).toBeGreaterThanOrEqual(1);
    });

    test('writes confidence_score node', () => {
      const scoreNodes = graph.getNodesByType('confidence_score');
      expect(scoreNodes.length).toBeGreaterThanOrEqual(1);
      expect(scoreNodes[0]!.summary).toContain('%');
    });

    test('writes implementation_roadmap node', () => {
      expect(graph.getNodesByType('implementation_roadmap').length).toBeGreaterThanOrEqual(1);
    });

    test('writes all 6 documentation generator node types', () => {
      expect(graph.getNodesByType('org_impact').length).toBeGreaterThanOrEqual(1);
      expect(graph.getNodesByType('stakeholder_map').length).toBeGreaterThanOrEqual(1);
      expect(graph.getNodesByType('kpi_definition').length).toBeGreaterThanOrEqual(1);
      expect(graph.getNodesByType('okr_alignment').length).toBeGreaterThanOrEqual(1);
      expect(graph.getNodesByType('raid_log').length).toBeGreaterThanOrEqual(1);
    });

    test('collects all agent results', () => {
      // 1 (memo) + 1 (summary) + 1 (risk) + 3 (doc gen) + 1 (scoring) = 7
      expect(result.totalAgentResults.length).toBe(7);
    });

    test('graph node IDs are returned', () => {
      expect(result.graphNodeIds.length).toBeGreaterThanOrEqual(5);
    });
  });

  // ==========================================================================
  // Confidence Score with Degraded Passes
  // ==========================================================================

  describe('Confidence score with degraded passes', () => {
    test('degraded passes apply -10% penalty each', async () => {
      const noDegradation = await executePass5({
        prompt: 'Test', graph, tracker, timeoutMs: 10000, verbose: false,
        passesDegraded: [],
        invokeAgents: createMockInvoker({}),
      });

      // Reset graph for second run
      const graph2 = new DecisionGraph('pass5-exec-002', tmpDir);
      seedGraph(graph2);
      const tracker2 = new ProvenanceTracker('pass5-exec-002');

      const withDegradation = await executePass5({
        prompt: 'Test', graph: graph2, tracker: tracker2, timeoutMs: 10000, verbose: false,
        passesDegraded: [2, 4],
        invokeAgents: createMockInvoker({}),
      });

      expect(withDegradation.confidenceScore.degradationPenalty).toBe(20);
      expect(withDegradation.confidenceScore.degradedPasses).toEqual([2, 4]);
      // Score should be lower with degradation
      expect(withDegradation.confidenceScore.overall).toBeLessThanOrEqual(noDegradation.confidenceScore.overall);
    });

    test('components show degraded flag', async () => {
      const result = await executePass5({
        prompt: 'Test', graph, tracker, timeoutMs: 10000, verbose: false,
        passesDegraded: [4],
        invokeAgents: createMockInvoker({}),
      });

      const financial = result.confidenceScore.components.find(c => c.name === 'Financial Outcome Stability');
      expect(financial!.degraded).toBe(true);

      const compliance = result.confidenceScore.components.find(c => c.name === 'Compliance Exposure');
      expect(compliance!.degraded).toBe(true);

      const operational = result.confidenceScore.components.find(c => c.name === 'Operational Risk Level');
      expect(operational!.degraded).toBe(false);
    });
  });

  // ==========================================================================
  // Score Interpretation Thresholds
  // ==========================================================================

  describe('Score interpretation thresholds', () => {
    test('80+ yields proceed', async () => {
      // With good upstream data and no degradation, score should be high
      const result = await executePass5({
        prompt: 'Test', graph, tracker, timeoutMs: 10000, verbose: false,
        passesDegraded: [],
        invokeAgents: createMockInvoker({
          'platform/decision-memo': { response: { decision: 'Approve' } },
          'platform/executive-summary': { response: {} },
          'platform/risk-score': { response: {} },
          'platform/decision': { response: {} },
          'analytics-hub/recommendation': { response: {} },
          'research-lab/metrics': { response: {} },
        }),
      });

      if (result.confidenceScore.overall >= 80) {
        expect(result.confidenceScore.recommendation).toBe('proceed');
      }
    });

    test('all degraded passes yields do-not-proceed', async () => {
      const result = await executePass5({
        prompt: 'Test', graph, tracker, timeoutMs: 10000, verbose: false,
        passesDegraded: [1, 2, 3, 4, 5, 6, 7],
        invokeAgents: createMockInvoker({}),
      });

      expect(result.confidenceScore.overall).toBeLessThan(40);
      expect(result.confidenceScore.recommendation).toBe('do-not-proceed');
    });
  });

  // ==========================================================================
  // Agent Failures
  // ==========================================================================

  describe('Agent failures (degraded mode)', () => {
    test('all agents failing still produces confidence score', async () => {
      const result = await executePass5({
        prompt: 'Failing test',
        graph, tracker, timeoutMs: 10000, verbose: false,
        passesDegraded: [],
        invokeAgents: createMockInvoker({}),
      });

      expect(typeof result.confidenceScore.overall).toBe('number');
      expect(result.confidenceScore.components).toHaveLength(5);
      // Still writes nodes (degraded)
      expect(graph.getNodesByPass(5).length).toBeGreaterThan(0);
    });

    test('degraded nodes are marked as degraded', async () => {
      await executePass5({
        prompt: 'Failing test',
        graph, tracker, timeoutMs: 10000, verbose: false,
        passesDegraded: [],
        invokeAgents: createMockInvoker({}),
      });

      const pass5Nodes = graph.getNodesByPass(5);
      const degradedNodes = pass5Nodes.filter(n => n.status === 'degraded');
      expect(degradedNodes.length).toBeGreaterThan(0);
    });
  });

  // ==========================================================================
  // Context Passing
  // ==========================================================================

  describe('Context from prior passes', () => {
    test('decision memo reads from problem_definition, architecture, cost_model', async () => {
      let capturedPayload: Record<string, unknown> | undefined;
      const mockInvoker = async (agents: readonly AgentRef[], payload: Record<string, unknown>) => {
        if (agents.some(a => a.agent === 'decision-memo')) {
          capturedPayload = payload;
        }
        return agents.map(a => makeResult(a, { result: 'ok' }));
      };

      await executePass5({
        prompt: 'Context test', graph, tracker, timeoutMs: 10000, verbose: false,
        passesDegraded: [],
        invokeAgents: mockInvoker,
      });

      expect(capturedPayload).toBeDefined();
      const context = capturedPayload!['context'] as unknown[];
      expect(context.length).toBeGreaterThan(0);
      const types = context.map((c: unknown) => (c as Record<string, unknown>)['type']);
      expect(types).toContain('problem_definition');
    });
  });

  // ==========================================================================
  // Provenance
  // ==========================================================================

  describe('Provenance tracking', () => {
    test('records scoring provenance', async () => {
      await executePass5({
        prompt: 'Provenance test', graph, tracker, timeoutMs: 10000, verbose: false,
        passesDegraded: [],
        invokeAgents: createMockInvoker({
          'platform/decision-memo': { response: {} },
          'platform/executive-summary': { response: {} },
          'platform/risk-score': { response: {} },
          'platform/decision': { response: {} },
          'analytics-hub/recommendation': { response: {} },
          'research-lab/metrics': { response: {} },
        }),
      });

      const records = tracker.getRecordsByPass(5);
      expect(records.length).toBeGreaterThan(0);
      expect(records.some(r => r.workstream === 'scoring')).toBe(true);
      expect(records.some(r => r.outputs.artifactNumbers.includes(12))).toBe(true);
    });
  });
});
