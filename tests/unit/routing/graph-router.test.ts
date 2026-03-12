/**
 * Tests for the Graph Router (ADR-030)
 */

import {
  routeCapabilities,
  toDomainAgentList,
  resolveAgentRef,
} from '../../../src/routing/graph-router.js';
import { classifyCapabilities } from '../../../src/routing/capability-classifier.js';
import type { EcosystemGraph } from '../../../src/routing/graph-loader.js';

// ============================================================================
// Test Graph Fixture
// ============================================================================

const TEST_GRAPH: EcosystemGraph = {
  version: '1.1',
  description: 'Test graph',
  stages: ['simulation', 'research', 'specification', 'architecture', 'build', 'validation', 'deployment', 'governance'],
  capabilities: [
    {
      name: 'simulation',
      description: 'Offline scenario simulation',
      repos: ['LLM-Simulator'],
      agents: ['What-If Simulation Agent', 'Scenario Generator Agent'],
      stage: 'simulation',
      depends_on: [],
      tags: ['simulation', 'what-if', 'scenario'],
    },
    {
      name: 'security_validation',
      description: 'Security scanning and protection',
      repos: ['LLM-Shield'],
      agents: ['Prompt Injection Detection Agent', 'PII Detection Agent'],
      stage: 'validation',
      depends_on: [],
      tags: ['security', 'injection', 'pii'],
    },
    {
      name: 'erp_integration',
      description: 'Enterprise ERP deployment',
      repos: ['erp-surface'],
      agents: ['ERP Integration Agent'],
      stage: 'deployment',
      depends_on: ['workflow_orchestration'],
      tags: ['erp', 'sap', 'enterprise'],
    },
    {
      name: 'workflow_orchestration',
      description: 'Pipeline orchestration',
      repos: ['LLM-Orchestrator'],
      agents: ['Workflow Orchestrator Agent', 'Dependency Resolver Agent'],
      stage: 'build',
      depends_on: [],
      tags: ['workflow', 'orchestration', 'pipeline'],
    },
    {
      name: 'cost_finops',
      description: 'Cost tracking and ROI',
      repos: ['LLM-CostOps'],
      agents: ['Cost Attribution Agent', 'ROI Estimation Agent'],
      stage: 'governance',
      depends_on: [],
      tags: ['cost', 'roi', 'spending', 'budget'],
    },
  ],
};

// ============================================================================
// Tests
// ============================================================================

describe('Graph Router', () => {
  describe('routeCapabilities', () => {
    it('routes a single capability match', () => {
      const classification = classifyCapabilities('Check for injection attacks', TEST_GRAPH);
      const result = routeCapabilities(classification, TEST_GRAPH);

      expect(result.totalAgents).toBeGreaterThan(0);
      expect(result.totalAgents).toBeLessThanOrEqual(5); // single cap budget
      expect(result.repos).toContain('LLM-Shield');
      expect(result.pipeline.length).toBeGreaterThan(0);
    });

    it('routes multiple capabilities in stage order', () => {
      const classification = classifyCapabilities(
        'Simulate SAP deployment with security validation',
        TEST_GRAPH,
      );
      const result = routeCapabilities(classification, TEST_GRAPH);

      expect(result.totalAgents).toBeGreaterThan(2);
      expect(result.pipeline.length).toBeGreaterThan(1);

      // Verify stage ordering: simulation before validation before deployment
      const stageOrder = result.pipeline.map(g => g.stage);
      const simIdx = stageOrder.indexOf('simulation');
      const valIdx = stageOrder.indexOf('validation');
      const depIdx = stageOrder.indexOf('deployment');

      if (simIdx >= 0 && valIdx >= 0) {
        expect(simIdx).toBeLessThan(valIdx);
      }
      if (valIdx >= 0 && depIdx >= 0) {
        expect(valIdx).toBeLessThan(depIdx);
      }
    });

    it('resolves transitive dependencies', () => {
      const classification = classifyCapabilities('Deploy to SAP ERP', TEST_GRAPH);
      const result = routeCapabilities(classification, TEST_GRAPH);

      // erp_integration depends on workflow_orchestration
      expect(result.resolvedCapabilities).toContain('erp_integration');
      expect(result.resolvedCapabilities).toContain('workflow_orchestration');
      expect(result.repos).toContain('erp-surface');
      expect(result.repos).toContain('LLM-Orchestrator');
    });

    it('returns empty result for no matches', () => {
      const classification = classifyCapabilities('Hello world', TEST_GRAPH);
      const result = routeCapabilities(classification, TEST_GRAPH);

      expect(result.totalAgents).toBe(0);
      expect(result.pipeline).toHaveLength(0);
      expect(result.repos).toHaveLength(0);
      expect(result.pruned).toBe(false);
    });

    it('deduplicates agents across capabilities', () => {
      const classification = classifyCapabilities(
        'Security scan and injection detection',
        TEST_GRAPH,
      );
      const result = routeCapabilities(classification, TEST_GRAPH);

      // All agents should be unique
      const agentNames = result.pipeline
        .flatMap(g => g.agents.map(a => a.agentName));
      const unique = new Set(agentNames);
      expect(agentNames.length).toBe(unique.size);
    });

    it('enforces agent budget ceiling', () => {
      // Create a graph with many agents per capability
      const bigGraph: EcosystemGraph = {
        ...TEST_GRAPH,
        capabilities: [
          {
            name: 'big_cap',
            repos: ['big-repo'],
            agents: Array.from({ length: 20 }, (_, i) => `Agent ${i}`),
            stage: 'build',
            depends_on: [],
            tags: ['big'],
          },
        ],
      };

      const classification = classifyCapabilities('big task', bigGraph);
      const result = routeCapabilities(classification, bigGraph);

      expect(result.totalAgents).toBeLessThanOrEqual(15); // hard ceiling
      expect(result.pruned).toBe(true);
    });

    it('includes explanation in result', () => {
      const classification = classifyCapabilities('SAP security scan', TEST_GRAPH);
      const result = routeCapabilities(classification, TEST_GRAPH);

      expect(result.explanation).toContain('Capability Graph Routing');
      expect(result.explanation.length).toBeGreaterThan(50);
    });

    it('custom budget overrides defaults', () => {
      const classification = classifyCapabilities('Check for injection attacks', TEST_GRAPH);
      const result = routeCapabilities(classification, TEST_GRAPH, {
        singleCapability: 1,
      });

      expect(result.totalAgents).toBeLessThanOrEqual(1);
    });
  });

  describe('resolveAgentRef', () => {
    it('resolves known agent names to domain/agent pairs', () => {
      const ref = resolveAgentRef('ERP Integration Agent');
      expect(ref).toEqual({ domain: 'connector-hub', agent: 'erp-surface' });
    });

    it('resolves Prompt Injection Detection Agent', () => {
      const ref = resolveAgentRef('Prompt Injection Detection Agent');
      expect(ref).toEqual({ domain: 'shield', agent: 'prompt-injection' });
    });

    it('resolves What-If Simulation Agent', () => {
      const ref = resolveAgentRef('What-If Simulation Agent');
      expect(ref).toEqual({ domain: 'simulator', agent: 'what-if' });
    });

    it('returns undefined for unknown agents', () => {
      expect(resolveAgentRef('Nonexistent Agent')).toBeUndefined();
    });
  });

  describe('toDomainAgentList', () => {
    it('converts routing result to domain/agent refs', () => {
      const classification = classifyCapabilities('Check for injection attacks', TEST_GRAPH);
      const routing = routeCapabilities(classification, TEST_GRAPH);
      const refs = toDomainAgentList(routing);

      expect(refs.length).toBeGreaterThan(0);
      for (const ref of refs) {
        expect(ref.domain).toBeTruthy();
        expect(ref.agent).toBeTruthy();
      }
    });

    it('deduplicates domain/agent pairs', () => {
      const classification = classifyCapabilities('Security and injection scan', TEST_GRAPH);
      const routing = routeCapabilities(classification, TEST_GRAPH);
      const refs = toDomainAgentList(routing);

      const keys = refs.map(r => `${r.domain}/${r.agent}`);
      const unique = new Set(keys);
      expect(keys.length).toBe(unique.size);
    });

    it('returns empty for no matches', () => {
      const classification = classifyCapabilities('Hello world', TEST_GRAPH);
      const routing = routeCapabilities(classification, TEST_GRAPH);
      const refs = toDomainAgentList(routing);

      expect(refs).toHaveLength(0);
    });
  });
});
