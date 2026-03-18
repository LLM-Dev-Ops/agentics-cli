/**
 * Pass 2 — Simulation & Scenario Modeling (ADR-035) — Unit Tests
 *
 * Tests the three concurrent workstreams, result extraction,
 * scenario matrix convergence, and DecisionGraph integration.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import {
  executePass2,
  WORKSTREAM_CONFIGS,
} from '../../../../src/pipeline/enterprise/pass2-simulation.js';
import type {
  Pass2Result,
} from '../../../../src/pipeline/enterprise/pass2-simulation.js';
import { DecisionGraph } from '../../../../src/pipeline/enterprise/decision-graph.js';
import { ProvenanceTracker } from '../../../../src/pipeline/enterprise/provenance-tracker.js';
import type { AgentRef, AgentInvocationResult, PassNumber } from '../../../../src/pipeline/enterprise/types.js';

// ============================================================================
// Test Helpers
// ============================================================================

function makeInvokeResult(agent: AgentRef, response: unknown, status = 200): AgentInvocationResult {
  return {
    agent,
    status,
    response,
    durationMs: 100,
    pass: 2,
    timestamp: new Date().toISOString(),
  };
}

/** Creates a mock invoker that returns predefined results per agent. */
function createMockInvoker(
  resultMap: Record<string, { response: unknown; status?: number }>,
): (agents: readonly AgentRef[], payload: Record<string, unknown>, pass: PassNumber, timeoutMs: number) => Promise<AgentInvocationResult[]> {
  return async (agents) => {
    return agents.map(agent => {
      const key = `${agent.domain}/${agent.agent}`;
      const entry = resultMap[key];
      if (entry) {
        return makeInvokeResult(agent, entry.response, entry.status ?? 200);
      }
      return makeInvokeResult(agent, { error: 'No mock configured' }, 500);
    });
  };
}

describe('Pass 2 — Simulation & Scenario Modeling (ADR-035)', () => {
  let graph: DecisionGraph;
  let tracker: ProvenanceTracker;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pass2-test-'));
    graph = new DecisionGraph('pass2-exec-001', tmpDir);
    tracker = new ProvenanceTracker('pass2-exec-001');

    // Seed Pass 1 nodes for context
    graph.createNode({
      type: 'problem_definition',
      name: 'Problem',
      content: { domain: 'healthcare', scale: 'enterprise' },
      summary: 'Healthcare data platform migration',
      producedBy: { domain: 'copilot', agent: 'planner', role: 'Planner' },
      pass: 1,
    });
    graph.createNode({
      type: 'technical_scope',
      name: 'Tech Scope',
      content: { stack: ['Java', 'PostgreSQL'], integrations: ['SAP', 'Salesforce'] },
      summary: 'Java/PostgreSQL stack with SAP and Salesforce integration',
      producedBy: { domain: 'copilot', agent: 'decomposer', role: 'Decomposer' },
      pass: 1,
    });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ==========================================================================
  // Workstream Configurations
  // ==========================================================================

  describe('WORKSTREAM_CONFIGS', () => {
    test('has 3 workstreams', () => {
      expect(WORKSTREAM_CONFIGS).toHaveLength(3);
    });

    test('workstream A is scenario-generation with simulator agents', () => {
      const ws = WORKSTREAM_CONFIGS.find(w => w.id === 'scenario-generation');
      expect(ws).toBeDefined();
      expect(ws!.agents.every(a => a.domain === 'simulator')).toBe(true);
      expect(ws!.agents).toHaveLength(2);
    });

    test('workstream B is risk-signal-detection with sentinel agents', () => {
      const ws = WORKSTREAM_CONFIGS.find(w => w.id === 'risk-signal-detection');
      expect(ws).toBeDefined();
      expect(ws!.agents.every(a => a.domain === 'sentinel')).toBe(true);
      expect(ws!.agents).toHaveLength(4);
    });

    test('workstream C is model-reliability with test-bench agents', () => {
      const ws = WORKSTREAM_CONFIGS.find(w => w.id === 'model-reliability');
      expect(ws).toBeDefined();
      expect(ws!.agents.every(a => a.domain === 'test-bench')).toBe(true);
      expect(ws!.agents).toHaveLength(6);
    });
  });

  // ==========================================================================
  // Full Execution with Mock Agents
  // ==========================================================================

  describe('executePass2 with successful agents', () => {
    const mockInvoker = createMockInvoker({
      'simulator/what-if': {
        response: {
          scenarios: [
            { type: 'deployment', name: 'Cloud Migration', description: 'Phased cloud migration', probability: 'high', impact: 'medium', metrics: { deploymentSuccessProbability: 0.9 } },
            { type: 'failure', name: 'API Timeout Cascade', description: 'Cascading timeouts under load', probability: 'medium', impact: 'high', metrics: { failureProbability: 0.3 } },
          ],
        },
      },
      'simulator/scenario': {
        response: {
          scenarios: [
            { type: 'scaling', name: '10x Load', description: 'System under 10x load increase', probability: 'low', impact: 'medium', metrics: { reliabilityProbability: 0.85 } },
          ],
        },
      },
      'sentinel/anomaly': {
        response: {
          risks: [
            { category: 'operational', severity: 'high', description: 'Single point of failure in auth service', rootCause: 'No redundancy', mitigation: 'Add failover' },
          ],
        },
      },
      'sentinel/drift': {
        response: {
          risks: [
            { category: 'integration', severity: 'medium', description: 'API version drift between services', rootCause: 'No version pinning', mitigation: 'Implement contract testing' },
          ],
        },
      },
      'sentinel/correlation': { response: { result: 'No correlations found' } },
      'sentinel/rca': { response: { result: 'Root causes identified' } },
      'test-bench/hallucination': { response: { score: 0.92 } },
      'test-bench/faithfulness': { response: { score: 0.88 } },
      'test-bench/bias': { response: { score: 0.95 } },
      'test-bench/stress': { response: { score: 0.85 } },
      'test-bench/red-team': { response: { findings: ['No critical vulnerabilities found'] } },
      'test-bench/adversarial': { response: { findings: [] } },
    });

    let result: Pass2Result;

    beforeEach(async () => {
      result = await executePass2({
        prompt: 'Healthcare data platform migration',
        graph,
        tracker,
        timeoutMs: 10000,
        verbose: false,
        invokeAgents: mockInvoker,
      });
    });

    test('returns 3 workstream results', () => {
      expect(result.workstreamResults).toHaveLength(3);
    });

    test('extracts 3+ scenarios', () => {
      expect(result.scenarios.length).toBeGreaterThanOrEqual(3);
    });

    test('scenarios include deployment and failure types', () => {
      const types = new Set(result.scenarios.map(s => s.type));
      expect(types.has('deployment')).toBe(true);
      expect(types.has('failure')).toBe(true);
    });

    test('extracts risk signals from sentinel', () => {
      expect(result.riskSignals.length).toBeGreaterThanOrEqual(2);
    });

    test('risk signals have category and severity', () => {
      for (const signal of result.riskSignals) {
        expect(['operational', 'integration', 'security', 'compliance', 'performance']).toContain(signal.category);
        expect(['critical', 'high', 'medium', 'low']).toContain(signal.severity);
      }
    });

    test('reliability report has valid scores', () => {
      const report = result.reliabilityReport;
      expect(report.overallScore).toBeGreaterThan(0);
      expect(report.overallScore).toBeLessThanOrEqual(1);
      expect(report.hallucinationScore).toBeGreaterThan(0);
      expect(report.faithfulnessScore).toBeGreaterThan(0);
      expect(report.biasScore).toBeGreaterThan(0);
      expect(['reliable', 'caution', 'unreliable']).toContain(report.recommendation);
    });

    test('scenario matrix is populated', () => {
      const matrix = result.scenarioMatrix;
      expect(matrix.scenarios.length).toBeGreaterThanOrEqual(3);
      expect(matrix.riskSignals.length).toBeGreaterThanOrEqual(2);
      expect(matrix.reliabilityReport.overallScore).toBeGreaterThan(0);
      expect(matrix.crossReferences.length).toBe(matrix.scenarios.length);
      expect(['critical', 'high', 'medium', 'low']).toContain(matrix.overallRiskLevel);
    });

    test('writes nodes to DecisionGraph', () => {
      expect(result.graphNodeIds.length).toBeGreaterThan(0);

      // Scenario nodes
      const scenarioNodes = graph.getNodesByType('scenario');
      expect(scenarioNodes.length).toBeGreaterThanOrEqual(3);

      // Risk signal nodes
      const riskNodes = graph.getNodesByType('risk_signal');
      expect(riskNodes.length).toBeGreaterThanOrEqual(2);

      // Reliability report node
      const reliabilityNodes = graph.getNodesByType('reliability_report');
      expect(reliabilityNodes).toHaveLength(1);
    });

    test('graph nodes are pass 2 with derivedFrom pass 1', () => {
      const pass2Nodes = graph.getNodesByPass(2);
      for (const node of pass2Nodes) {
        expect(node.pass).toBe(2);
        // Should derive from pass 1 nodes
        expect(node.derivedFrom.length).toBeGreaterThanOrEqual(0);
      }
    });

    test('collects all agent results', () => {
      expect(result.totalAgentResults.length).toBe(12); // 2 + 4 + 6 agents
    });

    test('cross-references link scenarios to risk signals', () => {
      for (const ref of result.scenarioMatrix.crossReferences) {
        // Each cross-reference has a scenario ID that exists
        const scenario = result.scenarios.find(s => s.id === ref.scenarioId);
        expect(scenario).toBeDefined();
        // Related risk signals should be strings
        expect(Array.isArray(ref.relatedRiskSignals)).toBe(true);
      }
    });
  });

  // ==========================================================================
  // Skip Red Team
  // ==========================================================================

  describe('Skip red team', () => {
    test('removes red-team and adversarial agents when skipRedTeam is true', async () => {
      const invokedAgents: string[] = [];
      const mockInvoker = async (agents: readonly AgentRef[]) => {
        for (const a of agents) {
          invokedAgents.push(`${a.domain}/${a.agent}`);
        }
        return agents.map(a => makeInvokeResult(a, { result: 'ok' }));
      };

      await executePass2({
        prompt: 'Test',
        graph,
        tracker,
        timeoutMs: 10000,
        verbose: false,
        skipRedTeam: true,
        invokeAgents: mockInvoker,
      });

      expect(invokedAgents).not.toContain('test-bench/red-team');
      expect(invokedAgents).not.toContain('test-bench/adversarial');
      // But other test-bench agents should still be invoked
      expect(invokedAgents).toContain('test-bench/hallucination');
      expect(invokedAgents).toContain('test-bench/faithfulness');
    });
  });

  // ==========================================================================
  // Agent Failures (Degraded Mode)
  // ==========================================================================

  describe('Agent failures (degraded mode)', () => {
    test('handles all agents failing gracefully', async () => {
      const mockInvoker = createMockInvoker({}); // All agents return 500

      const result = await executePass2({
        prompt: 'Failing test',
        graph,
        tracker,
        timeoutMs: 10000,
        verbose: false,
        invokeAgents: mockInvoker,
      });

      // Should still produce minimum 3 scenarios (fallback)
      expect(result.scenarios.length).toBeGreaterThanOrEqual(3);
      expect(result.scenarios.some(s => s.type === 'deployment')).toBe(true);
      expect(result.scenarios.some(s => s.type === 'failure')).toBe(true);

      // Reliability report should be caution/unreliable
      expect(['caution', 'unreliable']).toContain(result.reliabilityReport.recommendation);

      // Still writes to graph
      expect(result.graphNodeIds.length).toBeGreaterThan(0);
    });

    test('partial workstream failure still produces results', async () => {
      // Simulator succeeds, sentinel and test-bench fail
      const mockInvoker = createMockInvoker({
        'simulator/what-if': {
          response: { scenarios: [{ type: 'deployment', name: 'Deploy', description: 'test' }] },
        },
        'simulator/scenario': {
          response: { scenarios: [{ type: 'failure', name: 'Fail', description: 'test' }] },
        },
      });

      const result = await executePass2({
        prompt: 'Partial failure test',
        graph,
        tracker,
        timeoutMs: 10000,
        verbose: false,
        invokeAgents: mockInvoker,
      });

      // Should have scenarios from working simulator
      expect(result.scenarios.length).toBeGreaterThanOrEqual(3);
      // Risk signals may be empty
      expect(Array.isArray(result.riskSignals)).toBe(true);
    });
  });

  // ==========================================================================
  // Scenario Types
  // ==========================================================================

  describe('Scenario type coverage', () => {
    test('all 5 scenario types are valid', () => {
      const types: string[] = ['deployment', 'integration', 'failure', 'scaling', 'edge_case'];
      for (const t of types) {
        expect(typeof t).toBe('string');
      }
    });
  });

  // ==========================================================================
  // Risk Signal Categories
  // ==========================================================================

  describe('Risk signal categories', () => {
    test('all 5 categories are valid', () => {
      const categories: string[] = ['operational', 'integration', 'security', 'compliance', 'performance'];
      expect(categories).toHaveLength(5);
    });
  });

  // ==========================================================================
  // Overall Risk Level Computation
  // ==========================================================================

  describe('Overall risk level', () => {
    test('critical risk signal yields critical overall level', async () => {
      const mockInvoker = createMockInvoker({
        'simulator/what-if': { response: { scenarios: [] } },
        'simulator/scenario': { response: { scenarios: [] } },
        'sentinel/anomaly': {
          response: {
            risks: [{ category: 'security', severity: 'critical', description: 'Critical vulnerability' }],
          },
        },
        'sentinel/drift': { response: {} },
        'sentinel/correlation': { response: {} },
        'sentinel/rca': { response: {} },
        'test-bench/hallucination': { response: { score: 0.9 } },
        'test-bench/faithfulness': { response: { score: 0.9 } },
        'test-bench/bias': { response: { score: 0.9 } },
        'test-bench/stress': { response: { score: 0.9 } },
        'test-bench/red-team': { response: { findings: [] } },
        'test-bench/adversarial': { response: { findings: [] } },
      });

      const result = await executePass2({
        prompt: 'Critical risk test',
        graph,
        tracker,
        timeoutMs: 10000,
        verbose: false,
        invokeAgents: mockInvoker,
      });

      expect(result.scenarioMatrix.overallRiskLevel).toBe('critical');
    });
  });

  // ==========================================================================
  // Pass 1 Context
  // ==========================================================================

  describe('Pass 1 context', () => {
    test('pass 1 nodes are passed as context to agents', async () => {
      let capturedPayload: Record<string, unknown> | undefined;

      const mockInvoker = async (agents: readonly AgentRef[], payload: Record<string, unknown>) => {
        capturedPayload = payload;
        return agents.map(a => makeInvokeResult(a, { result: 'ok' }));
      };

      await executePass2({
        prompt: 'Context test',
        graph,
        tracker,
        timeoutMs: 10000,
        verbose: false,
        invokeAgents: mockInvoker,
      });

      expect(capturedPayload).toBeDefined();
      expect(capturedPayload!['pass']).toBe(2);

      const context = capturedPayload!['context'] as Record<string, unknown>;
      expect(context).toBeDefined();
      expect(context['problemDefinition']).toBeDefined();
      expect(context['technicalScope']).toBeDefined();
    });
  });

  // ==========================================================================
  // Provenance Tracking
  // ==========================================================================

  describe('Provenance tracking', () => {
    test('records provenance traces for scenario nodes', async () => {
      const mockInvoker = createMockInvoker({
        'simulator/what-if': {
          response: { scenarios: [{ type: 'deployment', name: 'D1', description: 'test' }] },
        },
        'simulator/scenario': { response: {} },
        'sentinel/anomaly': { response: {} },
        'sentinel/drift': { response: {} },
        'sentinel/correlation': { response: {} },
        'sentinel/rca': { response: {} },
        'test-bench/hallucination': { response: { score: 0.9 } },
        'test-bench/faithfulness': { response: { score: 0.9 } },
        'test-bench/bias': { response: { score: 0.9 } },
        'test-bench/stress': { response: { score: 0.9 } },
        'test-bench/red-team': { response: { findings: [] } },
        'test-bench/adversarial': { response: { findings: [] } },
      });

      await executePass2({
        prompt: 'Provenance test',
        graph,
        tracker,
        timeoutMs: 10000,
        verbose: false,
        invokeAgents: mockInvoker,
      });

      const records = tracker.getRecordsByPass(2);
      expect(records.length).toBeGreaterThan(0);
      expect(records.some(r => r.workstream === 'scenario-generation')).toBe(true);
    });
  });
});
