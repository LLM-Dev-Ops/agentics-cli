/**
 * Pass 7 — Observability & Continuous Learning (ADR-038) — Unit Tests
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import {
  executePass7,
  PASS7_WORKSTREAM_CONFIGS,
} from '../../../../src/pipeline/enterprise/pass7-observability.js';
import type {
  Pass7Result,
} from '../../../../src/pipeline/enterprise/pass7-observability.js';
import { DecisionGraph } from '../../../../src/pipeline/enterprise/decision-graph.js';
import { ProvenanceTracker } from '../../../../src/pipeline/enterprise/provenance-tracker.js';
import type { AgentRef, AgentInvocationResult, PassNumber } from '../../../../src/pipeline/enterprise/types.js';

// ============================================================================
// Helpers
// ============================================================================

function makeResult(agent: AgentRef, response: unknown, status = 200): AgentInvocationResult {
  return { agent, status, response, durationMs: 50, pass: 7, timestamp: new Date().toISOString() };
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

function seedGraph(graph: DecisionGraph): void {
  // Pass 1
  graph.createNode({
    type: 'problem_definition', name: 'Problem', content: { domain: 'logistics' },
    summary: 'Supply chain logistics platform', producedBy: { domain: 'copilot', agent: 'planner', role: 'P' }, pass: 1,
  });
  // Pass 2
  graph.createNode({
    type: 'scenario', name: 'Deploy', content: { type: 'deployment' },
    summary: 'Cloud deployment', producedBy: { domain: 'simulator', agent: 'what-if', role: 'S' }, pass: 2, confidence: 0.85,
  });
  graph.createNode({
    type: 'risk_signal', name: 'Risk', content: { severity: 'medium' },
    summary: 'Medium risk', producedBy: { domain: 'sentinel', agent: 'anomaly', role: 'R' }, pass: 2,
  });
  // Pass 3
  graph.createNode({
    type: 'system_architecture', name: 'Arch', content: { services: ['api', 'worker'] },
    summary: 'Microservices', producedBy: { domain: 'orchestrator', agent: 'workflow', role: 'A' }, pass: 3,
  });
  // Pass 4
  graph.createNode({
    type: 'cost_model', name: 'Cost', content: { tco: { year1: 100000 } },
    summary: 'TCO: $100K', producedBy: { domain: 'costops', agent: 'forecast', role: 'C' }, pass: 4,
  });
  // Pass 5
  graph.createNode({
    type: 'confidence_score', name: 'Score', content: { overall: 82 },
    summary: '82% confidence', producedBy: { domain: 'platform', agent: 'decision', role: 'D' }, pass: 5,
  });
  graph.createNode({
    type: 'kpi_definition', name: 'KPIs', content: { kpis: [{ name: 'Uptime', target: '99.9%' }] },
    summary: 'KPI targets', producedBy: { domain: 'platform', agent: 'decision', role: 'D' }, pass: 5,
  });
  // Pass 6
  graph.createNode({
    type: 'deployment_endpoint', name: 'API Endpoint', content: { url: 'https://api.example.com/v1' },
    summary: 'Deployed endpoint', producedBy: { domain: 'connector-hub', agent: 'erp-surface', role: 'E' }, pass: 6,
  });
}

describe('Pass 7 — Observability & Continuous Learning (ADR-038)', () => {
  let graph: DecisionGraph;
  let tracker: ProvenanceTracker;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pass7-test-'));
    graph = new DecisionGraph('pass7-exec-001', tmpDir);
    tracker = new ProvenanceTracker('pass7-exec-001');
    seedGraph(graph);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ==========================================================================
  // Workstream Configurations
  // ==========================================================================

  describe('PASS7_WORKSTREAM_CONFIGS', () => {
    test('has 3 workstreams', () => {
      expect(PASS7_WORKSTREAM_CONFIGS).toHaveLength(3);
    });

    test('workstream A is observability with 6 observatory agents', () => {
      const ws = PASS7_WORKSTREAM_CONFIGS.find(w => w.id === 'observability');
      expect(ws).toBeDefined();
      expect(ws!.agents).toHaveLength(6);
      expect(ws!.agents.every(a => a.domain === 'observatory')).toBe(true);
    });

    test('workstream B is diagnostics-incidents with latency-lens + incident-manager', () => {
      const ws = PASS7_WORKSTREAM_CONFIGS.find(w => w.id === 'diagnostics-incidents');
      expect(ws).toBeDefined();
      expect(ws!.agents).toHaveLength(5);
      const domains = new Set(ws!.agents.map(a => a.domain));
      expect(domains.has('latency-lens')).toBe(true);
      expect(domains.has('incident-manager')).toBe(true);
    });

    test('workstream C is learning-loop with memory-graph agents', () => {
      const ws = PASS7_WORKSTREAM_CONFIGS.find(w => w.id === 'learning-loop');
      expect(ws).toBeDefined();
      expect(ws!.agents).toHaveLength(2);
      expect(ws!.agents.every(a => a.domain === 'memory-graph')).toBe(true);
    });
  });

  // ==========================================================================
  // Full Execution
  // ==========================================================================

  describe('executePass7 with successful agents', () => {
    const mockInvoker = createMockInvoker({
      // Observatory
      'observatory/telemetry': { response: { metrics: [{ category: 'availability', name: 'uptime', value: 99.9, unit: '%' }] } },
      'observatory/usage-patterns': { response: { patterns: ['Peak usage 9-11am', 'Low weekend traffic'] } },
      'observatory/failures': { response: { classifications: ['timeout', 'auth_failure'] } },
      'observatory/health-check': { response: { healthChecks: [{ endpointUrl: 'https://api.example.com/health', status: 'healthy', latencyMs: 45 }] } },
      'observatory/slo': { response: { slaStatus: 'compliant', metrics: [{ name: 'availability', actual: 99.95, target: 99.9 }] } },
      'observatory/visualization': { response: { name: 'Logistics Dashboard', panels: [{ title: 'API Latency', metricQuery: 'latency_p99', visualization: 'timeseries', thresholds: [{ value: 200, color: 'green' }] }] } },
      // Diagnostics
      'latency-lens/latency': { response: { analysis: 'No latency issues detected' } },
      'latency-lens/cold-start': { response: { coldStarts: 0 } },
      'incident-manager/escalation': { response: { incidents: [] } },
      'incident-manager/post-mortem': { response: { postMortems: [] } },
      'incident-manager/hitl': { response: { pendingReviews: 0 } },
      // Learning
      'memory-graph/patterns': { response: { patterns: [{ type: 'success_pattern', domain: 'deployment', description: 'Phased rollout succeeded', evidence: { predicted: 'success', actual: 'success', verdict: 'correct' }, confidence: 0.9, applicableWhen: ['cloud_native'] }] } },
      'memory-graph/retrieval': { response: { feedbackProcessed: 0 } },
    });

    let result: Pass7Result;

    beforeEach(async () => {
      result = await executePass7({
        prompt: 'Supply chain logistics platform',
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

    test('current phase is active_monitoring', () => {
      expect(result.currentPhase).toBe('active_monitoring');
    });

    // ── Telemetry ──

    test('telemetry config is populated', () => {
      expect(result.telemetryConfig.executionId).toBe('pass7-exec-001');
      expect(result.telemetryConfig.metrics.length).toBeGreaterThan(0);
      expect(result.telemetryConfig.healthChecks.length).toBeGreaterThan(0);
      expect(result.telemetryConfig.collectionIntervalMs).toBe(300000);
    });

    test('health checks are extracted', () => {
      expect(result.healthChecks.length).toBeGreaterThan(0);
      const check = result.healthChecks[0]!;
      expect(check.endpointUrl).toBeTruthy();
      expect(['healthy', 'degraded', 'unhealthy']).toContain(check.status);
    });

    // ── Dashboard ──

    test('dashboard spec has panels and alert rules', () => {
      expect(result.dashboardSpec.name).toBeTruthy();
      expect(result.dashboardSpec.panels.length).toBeGreaterThan(0);
      expect(result.dashboardSpec.alertRules.length).toBeGreaterThan(0);
    });

    test('dashboard panels have correct structure', () => {
      for (const panel of result.dashboardSpec.panels) {
        expect(panel.title).toBeTruthy();
        expect(panel.metricQuery).toBeTruthy();
        expect(['timeseries', 'gauge', 'table', 'heatmap']).toContain(panel.visualization);
      }
    });

    // ── Incidents ──

    test('incidents array is present (may be empty)', () => {
      expect(Array.isArray(result.incidents)).toBe(true);
    });

    // ── Learning ──

    test('learned patterns are extracted', () => {
      expect(result.learnedPatterns.length).toBeGreaterThan(0);
      const pattern = result.learnedPatterns[0]!;
      expect(['success_pattern', 'anti_pattern', 'calibration_adjustment']).toContain(pattern.type);
      expect(pattern.domain).toBeTruthy();
      expect(pattern.confidence).toBeGreaterThan(0);
    });

    test('learning cycle completes all 4 steps', () => {
      expect(result.learningCycle.stepsCompleted).toEqual(['retrieve', 'judge', 'distill', 'consolidate']);
    });

    test('learning cycle has verdicts', () => {
      expect(result.learningCycle.verdicts.length).toBeGreaterThan(0);
      for (const v of result.learningCycle.verdicts) {
        expect(v.domain).toBeTruthy();
        expect(['correct', 'partially_correct', 'incorrect']).toContain(v.verdict);
      }
    });

    // ── DecisionGraph ──

    test('writes telemetry_config node', () => {
      const nodes = graph.getNodesByType('telemetry_config');
      expect(nodes.length).toBeGreaterThanOrEqual(1);
    });

    test('writes health_check nodes', () => {
      const nodes = graph.getNodesByType('health_check');
      expect(nodes.length).toBeGreaterThanOrEqual(1);
    });

    test('writes learned_pattern nodes', () => {
      const nodes = graph.getNodesByType('learned_pattern');
      expect(nodes.length).toBeGreaterThanOrEqual(1);
    });

    test('all pass 7 nodes are pass 7', () => {
      const pass7Nodes = graph.getNodesByPass(7);
      expect(pass7Nodes.length).toBeGreaterThanOrEqual(3);
      for (const n of pass7Nodes) {
        expect(n.pass).toBe(7);
      }
    });

    test('graph node IDs are returned', () => {
      expect(result.graphNodeIds.length).toBeGreaterThan(0);
    });

    test('collects all agent results (6+5+2=13)', () => {
      expect(result.totalAgentResults.length).toBe(13);
    });
  });

  // ==========================================================================
  // Agent Failures
  // ==========================================================================

  describe('All agents failing (degraded mode)', () => {
    test('still produces telemetry config with defaults', async () => {
      const result = await executePass7({
        prompt: 'Failing test',
        graph, tracker, timeoutMs: 10000, verbose: false,
        invokeAgents: createMockInvoker({}),
      });

      // Telemetry should be configured from deployment endpoints
      expect(result.telemetryConfig.healthChecks.length).toBeGreaterThan(0);
      expect(result.telemetryConfig.healthChecks[0]!.endpointUrl).toContain('api.example.com');
    });

    test('still produces default dashboard spec', async () => {
      const result = await executePass7({
        prompt: 'Failing test',
        graph, tracker, timeoutMs: 10000, verbose: false,
        invokeAgents: createMockInvoker({}),
      });

      expect(result.dashboardSpec.panels.length).toBeGreaterThan(0);
      expect(result.dashboardSpec.alertRules.length).toBeGreaterThan(0);
    });

    test('still runs learning cycle', async () => {
      const result = await executePass7({
        prompt: 'Failing test',
        graph, tracker, timeoutMs: 10000, verbose: false,
        invokeAgents: createMockInvoker({}),
      });

      expect(result.learningCycle.stepsCompleted).toHaveLength(4);
    });

    test('still writes nodes to graph', async () => {
      const nodesBefore = graph.nodeCount;
      await executePass7({
        prompt: 'Failing test',
        graph, tracker, timeoutMs: 10000, verbose: false,
        invokeAgents: createMockInvoker({}),
      });
      expect(graph.nodeCount).toBeGreaterThan(nodesBefore);
    });
  });

  // ==========================================================================
  // Prior Context
  // ==========================================================================

  describe('Prior context', () => {
    test('payload includes context from Passes 5-6', async () => {
      let capturedPayload: Record<string, unknown> | undefined;
      const mockInvoker = async (agents: readonly AgentRef[], payload: Record<string, unknown>) => {
        capturedPayload = payload;
        return agents.map(a => makeResult(a, { result: 'ok' }));
      };

      await executePass7({
        prompt: 'Context test',
        graph, tracker, timeoutMs: 10000, verbose: false,
        invokeAgents: mockInvoker,
      });

      const ctx = capturedPayload!['context'] as Record<string, unknown>;
      expect(ctx['confidenceScore']).toBeDefined();
      expect(ctx['deploymentEndpoints']).toBeDefined();
      expect(ctx['architecture']).toBeDefined();
      expect(ctx['kpis']).toBeDefined();
      expect(ctx['costModel']).toBeDefined();
    });
  });

  // ==========================================================================
  // Incident Extraction
  // ==========================================================================

  describe('Incident extraction', () => {
    test('extracts incidents from incident-manager', async () => {
      const result = await executePass7({
        prompt: 'Incident test',
        graph, tracker, timeoutMs: 10000, verbose: false,
        invokeAgents: createMockInvoker({
          'observatory/telemetry': { response: {} },
          'observatory/usage-patterns': { response: {} },
          'observatory/failures': { response: {} },
          'observatory/health-check': { response: {} },
          'observatory/slo': { response: {} },
          'observatory/visualization': { response: {} },
          'latency-lens/latency': { response: {} },
          'latency-lens/cold-start': { response: {} },
          'incident-manager/escalation': {
            response: {
              incidents: [
                { severity: 'P2', description: 'SLA breach on payment API', status: 'investigating' },
              ],
            },
          },
          'incident-manager/post-mortem': { response: {} },
          'incident-manager/hitl': { response: {} },
          'memory-graph/patterns': { response: {} },
          'memory-graph/retrieval': { response: {} },
        }),
      });

      expect(result.incidents).toHaveLength(1);
      expect(result.incidents[0]!.severity).toBe('P2');
      expect(result.incidents[0]!.status).toBe('investigating');
    });
  });

  // ==========================================================================
  // Provenance
  // ==========================================================================

  describe('Provenance tracking', () => {
    test('records setup provenance', async () => {
      await executePass7({
        prompt: 'Provenance test',
        graph, tracker, timeoutMs: 10000, verbose: false,
        invokeAgents: createMockInvoker({
          'observatory/telemetry': { response: {} }, 'observatory/usage-patterns': { response: {} },
          'observatory/failures': { response: {} }, 'observatory/health-check': { response: {} },
          'observatory/slo': { response: {} }, 'observatory/visualization': { response: {} },
          'latency-lens/latency': { response: {} }, 'latency-lens/cold-start': { response: {} },
          'incident-manager/escalation': { response: {} }, 'incident-manager/post-mortem': { response: {} },
          'incident-manager/hitl': { response: {} },
          'memory-graph/patterns': { response: {} }, 'memory-graph/retrieval': { response: {} },
        }),
      });

      const records = tracker.getRecordsByPass(7);
      expect(records.length).toBeGreaterThan(0);
      expect(records.some(r => r.workstream === 'initial-setup')).toBe(true);
    });
  });

  // ==========================================================================
  // Health Check Defaults
  // ==========================================================================

  describe('Health check defaults', () => {
    test('creates health check from deployment endpoint when agents fail', async () => {
      const result = await executePass7({
        prompt: 'Default health check test',
        graph, tracker, timeoutMs: 10000, verbose: false,
        invokeAgents: createMockInvoker({}),
      });

      // Should use the deployment endpoint from Pass 6
      const hasEndpointCheck = result.telemetryConfig.healthChecks.some(
        h => h.endpointUrl.includes('api.example.com'),
      );
      expect(hasEndpointCheck).toBe(true);
    });

    test('creates /health fallback when no deployment endpoints exist', async () => {
      // Create graph without Pass 6 deployment endpoints
      const emptyGraph = new DecisionGraph('pass7-empty-001', tmpDir);
      const emptyTracker = new ProvenanceTracker('pass7-empty-001');

      const result = await executePass7({
        prompt: 'Fallback test',
        graph: emptyGraph, tracker: emptyTracker, timeoutMs: 10000, verbose: false,
        invokeAgents: createMockInvoker({}),
      });

      expect(result.telemetryConfig.healthChecks.length).toBeGreaterThan(0);
      expect(result.telemetryConfig.healthChecks[0]!.endpointUrl).toBe('/health');
    });
  });
});
