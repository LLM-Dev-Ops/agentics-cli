/**
 * Tests for the routeQuery convenience function (ADR-030)
 *
 * This tests the full pipeline: graph load → classify → route → domain refs.
 */

import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { routeQuery, clearGraphCache } from '../../../src/routing/index.js';

// ============================================================================
// Helpers
// ============================================================================

function writeTempGraph(data: unknown): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'routequery-test-'));
  const filePath = path.join(tmpDir, 'ecosystem.graph.json');
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
  return filePath;
}

function cleanupTempGraph(filePath: string): void {
  try {
    fs.unlinkSync(filePath);
    fs.rmdirSync(path.dirname(filePath));
  } catch {
    // Best effort
  }
}

const GRAPH_DATA = {
  version: '1.1',
  description: 'Test graph',
  stages: ['simulation', 'research', 'build', 'validation', 'deployment', 'governance'],
  capabilities: [
    {
      name: 'security_validation',
      description: 'Protect against prompt injection and data leakage',
      repos: ['LLM-Shield'],
      agents: ['Prompt Injection Detection Agent', 'PII Detection Agent'],
      stage: 'validation',
      depends_on: [],
      tags: ['security', 'injection', 'pii', 'scan'],
    },
    {
      name: 'erp_integration',
      description: 'Push implementations to enterprise ERP systems',
      repos: ['erp-surface'],
      agents: ['ERP Integration Agent'],
      stage: 'deployment',
      depends_on: ['workflow_orchestration'],
      tags: ['erp', 'sap', 'oracle', 'enterprise'],
    },
    {
      name: 'workflow_orchestration',
      description: 'Multi-model pipeline orchestration',
      repos: ['LLM-Orchestrator'],
      agents: ['Workflow Orchestrator Agent', 'Dependency Resolver Agent'],
      stage: 'build',
      depends_on: [],
      tags: ['workflow', 'orchestration', 'pipeline'],
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
  ],
};

// ============================================================================
// Tests
// ============================================================================

describe('routeQuery (end-to-end)', () => {
  let graphPath: string;

  beforeEach(() => {
    clearGraphCache();
    graphPath = writeTempGraph(GRAPH_DATA);
  });

  afterEach(() => {
    clearGraphCache();
    cleanupTempGraph(graphPath);
  });

  it('matches capabilities and returns domain/agent refs', () => {
    const result = routeQuery('Check for injection attacks', graphPath);

    expect(result.matched).toBe(true);
    expect(result.agents.length).toBeGreaterThan(0);
    expect(result.routing.totalAgents).toBeGreaterThan(0);
  });

  it('returns matched=false for no matches', () => {
    const result = routeQuery('Hello, how are you?', graphPath);

    expect(result.matched).toBe(false);
    expect(result.agents).toHaveLength(0);
  });

  it('resolves dependencies in the full pipeline', () => {
    const result = routeQuery('Deploy to SAP', graphPath);

    expect(result.matched).toBe(true);
    // erp_integration depends on workflow_orchestration
    expect(result.routing.resolvedCapabilities).toContain('erp_integration');
    expect(result.routing.resolvedCapabilities).toContain('workflow_orchestration');
  });

  it('produces stage-ordered pipeline', () => {
    const result = routeQuery('Simulate SAP deployment with security', graphPath);

    expect(result.matched).toBe(true);
    const stages = result.routing.pipeline.map(g => g.stage);

    // Verify ordering: simulation < build < validation < deployment
    for (let i = 1; i < stages.length; i++) {
      const prevIdx = GRAPH_DATA.stages.indexOf(stages[i - 1]!);
      const currIdx = GRAPH_DATA.stages.indexOf(stages[i]!);
      expect(currIdx).toBeGreaterThanOrEqual(prevIdx);
    }
  });

  it('ADR-030 example: Optimize supplier sustainability reporting for SAP', () => {
    const result = routeQuery(
      'Optimize supplier sustainability reporting for SAP',
      graphPath,
    );

    expect(result.matched).toBe(true);
    // Should match erp_integration (tag: "sap") and its dependency
    expect(result.routing.resolvedCapabilities).toContain('erp_integration');
    expect(result.routing.resolvedCapabilities).toContain('workflow_orchestration');
    // Should produce a reasonable agent count
    expect(result.routing.totalAgents).toBeGreaterThanOrEqual(2);
    expect(result.routing.totalAgents).toBeLessThanOrEqual(15);
  });

  it('produces human-readable explanation', () => {
    const result = routeQuery('SAP security scan', graphPath);

    expect(result.routing.explanation).toContain('Capability Graph Routing');
    expect(result.routing.explanation).toContain('erp_integration');
    expect(result.routing.explanation).toContain('security_validation');
  });

  it('loads production graph successfully', () => {
    clearGraphCache();
    const projectRoot = path.resolve(process.cwd());
    const prodGraphPath = path.join(projectRoot, 'docs', 'ecosystem.graph.json');

    const result = routeQuery('Check for PII and injection attacks', prodGraphPath);
    expect(result.matched).toBe(true);
    expect(result.routing.totalAgents).toBeGreaterThan(0);
    expect(result.routing.totalAgents).toBeLessThanOrEqual(15);
  });
});
