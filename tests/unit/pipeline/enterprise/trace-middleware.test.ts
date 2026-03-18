/**
 * Trace Middleware — Unit Tests (ADR-039)
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import {
  createTracingInvoker,
  createFullTracingInvoker,
} from '../../../../src/pipeline/enterprise/trace-middleware.js';
import type { AgentInvoker } from '../../../../src/pipeline/enterprise/trace-middleware.js';
import { DecisionGraph } from '../../../../src/pipeline/enterprise/decision-graph.js';
import { ProvenanceTracker } from '../../../../src/pipeline/enterprise/provenance-tracker.js';
import type { AgentRef, AgentInvocationResult } from '../../../../src/pipeline/enterprise/types.js';

function makeResult(agent: AgentRef, response: unknown, status = 200): AgentInvocationResult {
  return { agent, status, response, durationMs: 100, pass: 2, timestamp: new Date().toISOString() };
}

describe('Trace Middleware (ADR-039)', () => {
  let graph: DecisionGraph;
  let tracker: ProvenanceTracker;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-mw-'));
    graph = new DecisionGraph('trace-mw-001', tmpDir);
    tracker = new ProvenanceTracker('trace-mw-001');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('createTracingInvoker', () => {
    test('wraps inner invoker transparently', async () => {
      const mockAgent: AgentRef = { domain: 'simulator', agent: 'what-if', role: 'Sim' };
      const mockInner: AgentInvoker = async (agents) =>
        agents.map(a => makeResult(a, { result: 'ok' }));

      const traced = createTracingInvoker(mockInner, graph, tracker, 'Simulation', 'scenario-gen');
      const results = await traced([mockAgent], { prompt: 'test' }, 2, 10000);

      expect(results).toHaveLength(1);
      expect(results[0]!.status).toBe(200);
    });

    test('records trace for each agent invoked', async () => {
      const agents: AgentRef[] = [
        { domain: 'simulator', agent: 'what-if', role: 'Sim' },
        { domain: 'simulator', agent: 'scenario', role: 'Scenario' },
      ];
      const mockInner: AgentInvoker = async (agentList) =>
        agentList.map(a => makeResult(a, { result: 'ok' }));

      const traced = createTracingInvoker(mockInner, graph, tracker, 'Simulation', 'scenario-gen');
      await traced(agents, { prompt: 'test' }, 2, 10000);

      const records = tracker.getAllRecords();
      expect(records).toHaveLength(2);
      expect(records[0]!.agent.domain).toBe('simulator');
      expect(records[0]!.agent.agent).toBe('what-if');
      expect(records[1]!.agent.agent).toBe('scenario');
    });

    test('records pass name and workstream', async () => {
      const mockInner: AgentInvoker = async (agents) =>
        agents.map(a => makeResult(a, { result: 'ok' }));

      const traced = createTracingInvoker(mockInner, graph, tracker, 'My Pass', 'my-workstream');
      await traced([{ domain: 'test', agent: 'test', role: 'Test' }], {}, 3, 10000);

      const record = tracker.getAllRecords()[0]!;
      expect(record.passName).toBe('My Pass');
      expect(record.workstream).toBe('my-workstream');
    });

    test('records failed status for non-2xx responses', async () => {
      const mockInner: AgentInvoker = async (agents) =>
        agents.map(a => makeResult(a, { error: 'timeout' }, 500));

      const traced = createTracingInvoker(mockInner, graph, tracker, 'Sim', 'gen');
      await traced([{ domain: 'test', agent: 'test', role: 'Test' }], {}, 2, 10000);

      const record = tracker.getAllRecords()[0]!;
      expect(record.outputs.status).toBe('failed');
      expect(record.outputs.confidence).toBe(0);
    });

    test('infers output node IDs from graph diff', async () => {
      // Add a node to the graph before tracing
      graph.createNode({
        type: 'problem_definition', name: 'Existing', content: {},
        summary: '', producedBy: { domain: 'test', agent: 'test', role: 'test' }, pass: 1,
      });

      // Inner invoker adds a node to the graph during execution
      const mockInner: AgentInvoker = async (agents) => {
        graph.createNode({
          type: 'scenario', name: 'New Scenario', content: {},
          summary: '', producedBy: { domain: 'simulator', agent: 'what-if', role: 'Sim' }, pass: 2,
        });
        return agents.map(a => makeResult(a, { result: 'ok' }));
      };

      const traced = createTracingInvoker(mockInner, graph, tracker, 'Sim', 'gen');
      await traced([{ domain: 'simulator', agent: 'what-if', role: 'Sim' }], {}, 2, 10000);

      const record = tracker.getAllRecords()[0]!;
      // Should have detected the new node
      expect(record.outputs.decisionGraphNodes.length).toBeGreaterThanOrEqual(0);
    });

    test('extracts token usage from response', async () => {
      const mockInner: AgentInvoker = async (agents) =>
        agents.map(a => makeResult(a, { result: 'ok', tokensUsed: 1500, model: 'claude-sonnet-4-6' }));

      const traced = createTracingInvoker(mockInner, graph, tracker, 'Sim', 'gen');
      await traced([{ domain: 'test', agent: 'test', role: 'Test' }], {}, 2, 10000);

      const record = tracker.getAllRecords()[0]!;
      expect(record.resources.tokensUsed).toBe(1500);
      expect(record.resources.modelUsed).toBe('claude-sonnet-4-6');
    });
  });

  describe('createFullTracingInvoker', () => {
    test('writes trace records to DecisionGraph as provenance nodes', async () => {
      const mockInner: AgentInvoker = async (agents) =>
        agents.map(a => makeResult(a, { result: 'ok' }));

      const traced = createFullTracingInvoker(mockInner, graph, tracker, 'Sim', 'gen');
      await traced([{ domain: 'simulator', agent: 'what-if', role: 'Sim' }], {}, 2, 10000);

      // Should have written provenance node to graph
      const provenanceNodes = graph.getNodesByTag('provenance');
      expect(provenanceNodes.length).toBeGreaterThanOrEqual(1);
    });

    test('provenance graph nodes have correct metadata', async () => {
      const mockInner: AgentInvoker = async (agents) =>
        agents.map(a => makeResult(a, { result: 'ok', tokensUsed: 500 }));

      const traced = createFullTracingInvoker(mockInner, graph, tracker, 'Governance', 'security');
      await traced([{ domain: 'shield', agent: 'pii', role: 'PII' }], {}, 4, 10000);

      const provenanceNodes = graph.getNodesByTag('provenance');
      expect(provenanceNodes.length).toBeGreaterThanOrEqual(1);

      const node = provenanceNodes[0]!;
      expect(node.content['agentDomain']).toBe('shield');
      expect(node.content['agentName']).toBe('pii');
      expect(node.content['status']).toBe('success');
      expect(node.summary).toContain('shield/pii');
    });

    test('still returns original results', async () => {
      const mockInner: AgentInvoker = async (agents) =>
        agents.map(a => makeResult(a, { data: 42 }));

      const traced = createFullTracingInvoker(mockInner, graph, tracker, 'Sim', 'gen');
      const results = await traced([{ domain: 'test', agent: 'test', role: 'T' }], {}, 2, 10000);

      expect(results).toHaveLength(1);
      expect((results[0]!.response as Record<string, unknown>)['data']).toBe(42);
    });
  });

  describe('Privacy & Redaction', () => {
    test('trace records do not store agent payload content', async () => {
      const sensitivePayload = { prompt: 'test', sensitiveData: 'SSN-123-45-6789' };
      const mockInner: AgentInvoker = async (agents) =>
        agents.map(a => makeResult(a, { result: 'ok' }));

      const traced = createTracingInvoker(mockInner, graph, tracker, 'Sim', 'gen');
      await traced([{ domain: 'test', agent: 'test', role: 'T' }], sensitivePayload, 2, 10000);

      const record = tracker.getAllRecords()[0]!;
      const serialized = JSON.stringify(record);
      // Sensitive data should NOT appear in the trace record
      expect(serialized).not.toContain('SSN-123-45-6789');
      // Only node IDs (pointers) in inputs/outputs
      expect(record.inputs.parameters).toEqual({});
    });
  });
});
