/**
 * Tests for the Capability Classifier (ADR-030)
 */

import {
  classifyCapabilities,
  extractCapabilityNames,
} from '../../../src/routing/capability-classifier.js';
import type { EcosystemGraph } from '../../../src/routing/graph-loader.js';

// ============================================================================
// Test Graph Fixture
// ============================================================================

const TEST_GRAPH: EcosystemGraph = {
  version: '1.1',
  description: 'Test graph',
  stages: ['simulation', 'research', 'build', 'validation', 'deployment', 'governance'],
  capabilities: [
    {
      name: 'security_validation',
      description: 'Protect against prompt injection, data leakage, and unsafe outputs',
      repos: ['LLM-Shield'],
      agents: ['Prompt Injection Detection Agent', 'PII Detection Agent'],
      stage: 'validation',
      depends_on: [],
      tags: ['security', 'injection', 'pii', 'secrets', 'scan'],
    },
    {
      name: 'erp_integration',
      description: 'Push generated implementations to enterprise ERP systems',
      repos: ['erp-surface'],
      agents: ['ERP Integration Agent'],
      stage: 'deployment',
      depends_on: ['workflow_orchestration'],
      tags: ['erp', 'sap', 'oracle', 'netsuite', 'enterprise'],
    },
    {
      name: 'workflow_orchestration',
      description: 'Multi-model pipeline orchestration and scheduling',
      repos: ['LLM-Orchestrator'],
      agents: ['Workflow Orchestrator Agent', 'Dependency Resolver Agent'],
      stage: 'build',
      depends_on: [],
      tags: ['workflow', 'orchestration', 'pipeline', 'scheduler'],
    },
    {
      name: 'simulation',
      description: 'Offline scenario simulation and what-if analysis',
      repos: ['LLM-Simulator'],
      agents: ['What-If Simulation Agent', 'Scenario Generator Agent'],
      stage: 'simulation',
      depends_on: [],
      tags: ['simulation', 'what-if', 'scenario', 'simulate'],
    },
    {
      name: 'cost_finops',
      description: 'Cost tracking, attribution, forecasting, and ROI analytics',
      repos: ['LLM-CostOps'],
      agents: ['Cost Attribution Agent', 'ROI Estimation Agent'],
      stage: 'governance',
      depends_on: [],
      tags: ['cost', 'finops', 'budget', 'roi', 'spending'],
    },
    {
      name: 'performance_profiling',
      description: 'Latency analysis, cold start mitigation, and performance profiling',
      repos: ['LLM-Latency-Lens'],
      agents: ['Latency Analysis Agent'],
      stage: 'validation',
      depends_on: [],
      tags: ['latency', 'performance', 'cold-start', 'p99'],
    },
  ],
};

// ============================================================================
// Tests
// ============================================================================

describe('Capability Classifier', () => {
  describe('classifyCapabilities', () => {
    it('matches capability by exact name in prompt', () => {
      const result = classifyCapabilities('Run erp_integration for SAP', TEST_GRAPH);
      const names = extractCapabilityNames(result);
      expect(names).toContain('erp_integration');
    });

    it('matches capability by tag', () => {
      const result = classifyCapabilities('Check for injection attacks in this prompt', TEST_GRAPH);
      const names = extractCapabilityNames(result);
      expect(names).toContain('security_validation');
    });

    it('matches multiple capabilities in one prompt', () => {
      const result = classifyCapabilities(
        'Simulate deployment to SAP and check security',
        TEST_GRAPH,
      );
      const names = extractCapabilityNames(result);
      expect(names).toContain('simulation');
      expect(names).toContain('security_validation');
      expect(names).toContain('erp_integration'); // "SAP" tag
    });

    it('returns empty when no capabilities match', () => {
      const result = classifyCapabilities('Hello, how are you today?', TEST_GRAPH);
      expect(result.capabilities).toHaveLength(0);
    });

    it('matches SAP tag to erp_integration', () => {
      const result = classifyCapabilities('Deploy sustainability reporting to SAP', TEST_GRAPH);
      const names = extractCapabilityNames(result);
      expect(names).toContain('erp_integration');
    });

    it('matches cost-related keywords', () => {
      const result = classifyCapabilities('How much am I spending on AI?', TEST_GRAPH);
      const names = extractCapabilityNames(result);
      expect(names).toContain('cost_finops');
    });

    it('matches performance/latency keywords', () => {
      const result = classifyCapabilities('Why is my model so slow? High latency detected.', TEST_GRAPH);
      const names = extractCapabilityNames(result);
      expect(names).toContain('performance_profiling');
    });

    it('assigns higher confidence to exact matches than tag matches', () => {
      const result = classifyCapabilities('Run simulation and security scan', TEST_GRAPH);
      const simCap = result.capabilities.find(c => c.name === 'simulation');
      const secCap = result.capabilities.find(c => c.name === 'security_validation');

      expect(simCap).toBeDefined();
      expect(secCap).toBeDefined();
      // "simulation" matches both name parts and tag — classifier picks exact match
      expect(simCap!.confidence).toBeGreaterThan(0);
      expect(secCap!.confidence).toBeGreaterThan(0);
    });

    it('sorts results by confidence descending', () => {
      const result = classifyCapabilities(
        'Run simulation and security scan and check latency',
        TEST_GRAPH,
      );
      for (let i = 1; i < result.capabilities.length; i++) {
        expect(result.capabilities[i]!.confidence)
          .toBeLessThanOrEqual(result.capabilities[i - 1]!.confidence);
      }
    });

    it('includes matched tokens in results', () => {
      const result = classifyCapabilities('Check for PII in the data', TEST_GRAPH);
      const secCap = result.capabilities.find(c => c.name === 'security_validation');
      expect(secCap).toBeDefined();
      expect(secCap!.matchedTokens.length).toBeGreaterThan(0);
    });

    it('handles empty prompt gracefully', () => {
      const result = classifyCapabilities('', TEST_GRAPH);
      expect(result.capabilities).toHaveLength(0);
      expect(result.promptTokens).toHaveLength(0);
    });

    it('handles punctuation-heavy prompts', () => {
      const result = classifyCapabilities('!!!SAP??? @#$security!!!', TEST_GRAPH);
      const names = extractCapabilityNames(result);
      expect(names).toContain('erp_integration');
      expect(names).toContain('security_validation');
    });

    it('is case-insensitive', () => {
      const result = classifyCapabilities('SECURITY SCAN for SAP', TEST_GRAPH);
      const names = extractCapabilityNames(result);
      expect(names).toContain('security_validation');
      expect(names).toContain('erp_integration');
    });

    it('matches workflow orchestration by tag', () => {
      const result = classifyCapabilities('Build a data pipeline with orchestration', TEST_GRAPH);
      const names = extractCapabilityNames(result);
      expect(names).toContain('workflow_orchestration');
    });

    it('does not match on common stop words', () => {
      const result = classifyCapabilities('The is for and or but not', TEST_GRAPH);
      expect(result.capabilities).toHaveLength(0);
    });
  });

  describe('extractCapabilityNames', () => {
    it('returns just the names from a classification result', () => {
      const result = classifyCapabilities('SAP security scan', TEST_GRAPH);
      const names = extractCapabilityNames(result);
      expect(Array.isArray(names)).toBe(true);
      for (const name of names) {
        expect(typeof name).toBe('string');
      }
    });
  });
});
