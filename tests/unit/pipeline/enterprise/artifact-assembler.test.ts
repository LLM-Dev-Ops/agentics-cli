/**
 * Artifact Assembler — Unit Tests (ADR-034)
 *
 * Tests the enhanced artifact assembler including:
 *   - 15 artifact generation with dedicated renderers
 *   - DecisionGraph write-back
 *   - Partial pipeline artifact tracking
 *   - Degraded artifact handling
 *   - Confidence score computation
 *   - DECISION_PACKAGE.md index
 *   - Artifact definition metadata
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { ArtifactAssembler, ARTIFACT_DEFINITIONS } from '../../../../src/pipeline/enterprise/artifact-assembler.js';
import { DecisionGraph } from '../../../../src/pipeline/enterprise/decision-graph.js';
import { ProvenanceTracker } from '../../../../src/pipeline/enterprise/provenance-tracker.js';
import type { PassOutput, PassNumber } from '../../../../src/pipeline/enterprise/types.js';

describe('ArtifactAssembler (ADR-034)', () => {
  let graph: DecisionGraph;
  let tracker: ProvenanceTracker;
  let tmpDir: string;
  let assembler: ArtifactAssembler;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'artifact-test-'));
    graph = new DecisionGraph('exec-artifact-001', tmpDir);
    tracker = new ProvenanceTracker('exec-artifact-001');
    assembler = new ArtifactAssembler(graph, tracker, tmpDir, 'exec-artifact-001');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function createPassOutputs(statuses?: Record<number, string>): PassOutput[] {
    return [1, 2, 3, 4, 5, 6, 7].map(p => ({
      pass: 'problem-intelligence' as PassOutput['pass'],
      passNumber: p as PassOutput['passNumber'],
      status: (statuses?.[p] ?? 'completed') as PassOutput['status'],
      data: {},
      artifacts: [],
      agentResults: [],
      durationMs: 1000,
      summary: `Pass ${p}`,
    }));
  }

  // ==========================================================================
  // Artifact Definitions
  // ==========================================================================

  describe('ARTIFACT_DEFINITIONS', () => {
    test('has exactly 15 definitions', () => {
      expect(ARTIFACT_DEFINITIONS).toHaveLength(15);
    });

    test('artifact numbers are 1-15 in order', () => {
      for (let i = 0; i < 15; i++) {
        expect(ARTIFACT_DEFINITIONS[i]!.number).toBe(i + 1);
      }
    });

    test('each definition has all required fields', () => {
      for (const def of ARTIFACT_DEFINITIONS) {
        expect(def.name).toBeTruthy();
        expect(def.filename).toBeTruthy();
        expect(def.filename.endsWith('.md')).toBe(true);
        expect(def.producingAgent).toBeTruthy();
        expect(def.consultingAnalogy).toBeTruthy();
        expect(def.qualityCriteria).toBeTruthy();
        expect(Array.isArray(def.nodeTypes)).toBe(true);
        expect(Array.isArray(def.requiredPasses)).toBe(true);
        expect(def.graphNodeType).toBeTruthy();
      }
    });

    test('consulting analogies are meaningful descriptions', () => {
      for (const def of ARTIFACT_DEFINITIONS) {
        expect(def.consultingAnalogy.length).toBeGreaterThan(5);
      }
      // At least 10 of 15 reference well-known consulting firms
      const firms = ['McKinsey', 'Accenture', 'Capgemini', 'CGI', 'Deloitte', 'PwC', 'Agentics'];
      const firmCount = ARTIFACT_DEFINITIONS.filter(d =>
        firms.some(f => d.consultingAnalogy.includes(f)),
      ).length;
      expect(firmCount).toBeGreaterThanOrEqual(10);
    });

    test('filenames are numbered and unique', () => {
      const filenames = ARTIFACT_DEFINITIONS.map(d => d.filename);
      expect(new Set(filenames).size).toBe(15);
      for (const def of ARTIFACT_DEFINITIONS) {
        const prefix = String(def.number).padStart(2, '0');
        expect(def.filename.startsWith(prefix)).toBe(true);
      }
    });
  });

  // ==========================================================================
  // Assembly with Empty Graph
  // ==========================================================================

  describe('assemble with empty graph', () => {
    test('creates artifact directory', () => {
      assembler.assemble({
        prompt: 'Test prompt',
        passOutputs: createPassOutputs(),
        passesDegraded: [],
      });

      expect(fs.existsSync(path.join(tmpDir, 'exec-artifact-001'))).toBe(true);
    });

    test('writes DECISION_PACKAGE.md', () => {
      assembler.assemble({
        prompt: 'Test prompt',
        passOutputs: createPassOutputs(),
        passesDegraded: [],
      });

      const indexPath = path.join(tmpDir, 'exec-artifact-001', 'DECISION_PACKAGE.md');
      expect(fs.existsSync(indexPath)).toBe(true);

      const content = fs.readFileSync(indexPath, 'utf-8');
      expect(content).toContain('Agentics Decision Package');
      expect(content).toContain('exec-artifact-001');
      expect(content).toContain('Test prompt');
      expect(content).toContain('Consulting Analogy');
      expect(content).toContain('Schema v1.0');
    });

    test('writes all 15 artifact files', () => {
      assembler.assemble({
        prompt: 'Test prompt',
        passOutputs: createPassOutputs(),
        passesDegraded: [],
      });

      const artifactDir = path.join(tmpDir, 'exec-artifact-001');
      const files = fs.readdirSync(artifactDir).filter(f => f.endsWith('.md'));
      // 15 artifact files + DECISION_PACKAGE.md = 16
      expect(files.length).toBe(16);
    });

    test('marks missing artifacts as not_generated', () => {
      const pkg = assembler.assemble({
        prompt: 'Test prompt',
        passOutputs: createPassOutputs(),
        passesDegraded: [],
      });

      const notGenerated = pkg.artifacts.filter(a => a.status === 'not_generated');
      expect(notGenerated.length).toBeGreaterThan(0);
    });

    test('always generates provenance manifest (artifact 15)', () => {
      const pkg = assembler.assemble({
        prompt: 'Test prompt',
        passOutputs: createPassOutputs(),
        passesDegraded: [],
      });

      const prov = pkg.artifacts.find(a => a.number === 15);
      expect(prov).toBeDefined();
      expect(prov!.status).toBe('complete');
    });
  });

  // ==========================================================================
  // Assembly with Populated Graph
  // ==========================================================================

  describe('assemble with populated graph', () => {
    beforeEach(() => {
      graph.createNode({
        type: 'executive_memo',
        name: 'Executive Memo',
        content: { decision: 'Approve', problem: 'SAP migration' },
        summary: 'Approve the SAP migration.',
        producedBy: { domain: 'platform', agent: 'decision-memo', role: 'Memo' },
        pass: 5,
      });
      graph.createNode({
        type: 'executive_summary',
        name: 'Executive Summary',
        content: { context: 'Digital transformation', outcomes: ['50% cost reduction'] },
        summary: 'Strategic digital transformation initiative.',
        producedBy: { domain: 'platform', agent: 'executive-summary', role: 'Summary' },
        pass: 5,
      });
      graph.createNode({
        type: 'cost_model',
        name: 'Cost Model',
        content: { year1: '$2.4M', roi: '158%', infrastructure: 'Cloud-native' },
        summary: 'Year 1 TCO: $2.4M, ROI: 158%',
        producedBy: { domain: 'costops', agent: 'attribution', role: 'Cost' },
        pass: 4,
      });
      graph.createNode({
        type: 'scenario',
        name: 'Deployment Scenario',
        content: { deployment: 'Phased rollout', probability: 0.85 },
        summary: 'Phased deployment with 85% success probability.',
        producedBy: { domain: 'simulator', agent: 'what-if', role: 'Sim' },
        pass: 2,
      });
      graph.createNode({
        type: 'confidence_score',
        name: 'Confidence Score',
        content: { overall: 87, financial: 90, operational: 85 },
        summary: 'Overall confidence: 87%',
        producedBy: { domain: 'platform', agent: 'decision', role: 'Decision' },
        pass: 5,
      });
    });

    test('marks artifacts with data as complete', () => {
      const pkg = assembler.assemble({
        prompt: 'Test prompt',
        passOutputs: createPassOutputs(),
        passesDegraded: [],
      });

      const memo = pkg.artifacts.find(a => a.number === 1);
      expect(memo!.status).toBe('complete');

      const cost = pkg.artifacts.find(a => a.number === 6);
      expect(cost!.status).toBe('complete');

      const sim = pkg.artifacts.find(a => a.number === 4);
      expect(sim!.status).toBe('complete');
    });

    test('artifact files use dedicated renderers with structured content', () => {
      assembler.assemble({
        prompt: 'Test prompt',
        passOutputs: createPassOutputs(),
        passesDegraded: [],
      });

      // Check Executive Decision Memo uses its renderer
      const memo = fs.readFileSync(
        path.join(tmpDir, 'exec-artifact-001', '01-executive-decision-memo.md'), 'utf-8',
      );
      expect(memo).toContain('Executive Decision Memo');
      expect(memo).toContain('McKinsey decision document');
      expect(memo).toContain('Decision Requested');
      expect(memo).toContain('Approve');

      // Check CostOps uses its renderer
      const cost = fs.readFileSync(
        path.join(tmpDir, 'exec-artifact-001', '06-costops-financial-model.md'), 'utf-8',
      );
      expect(cost).toContain('CostOps Financial Model');
      expect(cost).toContain('Capgemini TCO/ROI');
      expect(cost).toContain('Total Cost of Ownership');

      // Check Simulation uses its renderer
      const sim = fs.readFileSync(
        path.join(tmpDir, 'exec-artifact-001', '04-simulation-scenario-analysis.md'), 'utf-8',
      );
      expect(sim).toContain('Simulation & Scenario');
      expect(sim).toContain('CGI scenario modeling');
    });

    test('writes artifact nodes back to DecisionGraph', () => {
      const nodeCountBefore = graph.nodeCount;
      assembler.assemble({
        prompt: 'Test prompt',
        passOutputs: createPassOutputs(),
        passesDegraded: [],
      });

      // Should have added nodes for each complete artifact
      expect(graph.nodeCount).toBeGreaterThan(nodeCountBefore);

      // Check that artifact nodes have correct metadata
      const artifactNodes = graph.getNodesByTag('artifact:1');
      expect(artifactNodes.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ==========================================================================
  // Partial Pipeline
  // ==========================================================================

  describe('Partial pipeline handling', () => {
    test('artifacts requiring unexecuted passes are not_generated', () => {
      const partialOutputs: PassOutput[] = [1, 2, 3].map(p => ({
        pass: 'problem-intelligence' as PassOutput['pass'],
        passNumber: p as PassNumber,
        status: 'completed' as const,
        data: {},
        artifacts: [],
        agentResults: [],
        durationMs: 1000,
        summary: `Pass ${p}`,
      }));

      const pkg = assembler.assemble({
        prompt: 'Partial test',
        passOutputs: partialOutputs,
        passesDegraded: [],
        passesExecuted: [1, 2, 3],
      });

      // Artifacts requiring Pass 4 or 5 should be not_generated
      const costOps = pkg.artifacts.find(a => a.number === 6);
      expect(costOps!.status).toBe('not_generated');
      expect(costOps!.degradationReason).toContain('not executed');

      // Artifact 4 (Simulation) requires Pass 2 which was executed
      const sim = pkg.artifacts.find(a => a.number === 4);
      // Will be not_generated because no graph nodes, but not because pass wasn't run
      expect(sim!.status).toBe('not_generated');
    });

    test('not_generated artifact files contain guidance to re-run', () => {
      const partialOutputs: PassOutput[] = [1].map(p => ({
        pass: 'problem-intelligence' as PassOutput['pass'],
        passNumber: p as PassNumber,
        status: 'completed' as const,
        data: {},
        artifacts: [],
        agentResults: [],
        durationMs: 1000,
        summary: `Pass ${p}`,
      }));

      assembler.assemble({
        prompt: 'Partial test',
        passOutputs: partialOutputs,
        passesDegraded: [],
        passesExecuted: [1],
      });

      const costContent = fs.readFileSync(
        path.join(tmpDir, 'exec-artifact-001', '06-costops-financial-model.md'), 'utf-8',
      );
      expect(costContent).toContain('NOT GENERATED');
      expect(costContent).toContain('agentics ask');
    });
  });

  // ==========================================================================
  // Degraded Artifacts
  // ==========================================================================

  describe('Degraded artifact handling', () => {
    test('artifacts from degraded passes are marked degraded', () => {
      const pkg = assembler.assemble({
        prompt: 'Test',
        passOutputs: createPassOutputs({ 4: 'degraded' }),
        passesDegraded: [4],
      });

      const cost = pkg.artifacts.find(a => a.number === 6);
      expect(cost!.status).toBe('degraded');
      expect(cost!.degradationReason).toBeTruthy();
    });

    test('degraded artifact files show banner', () => {
      assembler.assemble({
        prompt: 'Test',
        passOutputs: createPassOutputs({ 4: 'degraded' }),
        passesDegraded: [4],
      });

      const costContent = fs.readFileSync(
        path.join(tmpDir, 'exec-artifact-001', '06-costops-financial-model.md'), 'utf-8',
      );
      expect(costContent).toContain('DEGRADED');
    });
  });

  // ==========================================================================
  // Confidence Score
  // ==========================================================================

  describe('Confidence Score computation', () => {
    test('all passes completed yields high score', () => {
      const pkg = assembler.assemble({
        prompt: 'Test',
        passOutputs: createPassOutputs(),
        passesDegraded: [],
      });

      expect(pkg.confidenceScore).toBeGreaterThanOrEqual(80);
      expect(pkg.recommendation).toBe('proceed');
    });

    test('degraded passes reduce score', () => {
      const pkg = assembler.assemble({
        prompt: 'Test',
        passOutputs: createPassOutputs({ 2: 'degraded', 4: 'degraded' }),
        passesDegraded: [2, 4],
      });

      expect(pkg.confidenceScore).toBeLessThan(80);
    });

    test('all passes failed yields 0 score', () => {
      const failedOutputs = createPassOutputs({
        1: 'failed', 2: 'failed', 3: 'failed', 4: 'failed',
        5: 'failed', 6: 'failed', 7: 'failed',
      });

      const pkg = assembler.assemble({
        prompt: 'Test',
        passOutputs: failedOutputs,
        passesDegraded: [1, 2, 3, 4, 5, 6, 7],
      });

      expect(pkg.confidenceScore).toBe(0);
      expect(pkg.recommendation).toBe('do-not-proceed');
    });

    test('recommendation thresholds are correct', () => {
      // 80+ = proceed (tested above)
      // 60-79 = proceed-with-conditions
      // 40-59 = investigate-further
      // 0-39 = do-not-proceed

      // 3 degraded passes should put us in proceed-with-conditions or lower
      const pkg = assembler.assemble({
        prompt: 'Test',
        passOutputs: createPassOutputs({ 2: 'degraded', 3: 'degraded', 4: 'degraded' }),
        passesDegraded: [2, 3, 4],
      });
      expect(['proceed-with-conditions', 'investigate-further', 'do-not-proceed']).toContain(pkg.recommendation);
    });
  });

  // ==========================================================================
  // DECISION_PACKAGE.md Index
  // ==========================================================================

  describe('DECISION_PACKAGE.md index', () => {
    test('contains confidence score breakdown table', () => {
      assembler.assemble({
        prompt: 'Test',
        passOutputs: createPassOutputs(),
        passesDegraded: [],
      });

      const content = fs.readFileSync(
        path.join(tmpDir, 'exec-artifact-001', 'DECISION_PACKAGE.md'), 'utf-8',
      );
      expect(content).toContain('Confidence Score Breakdown');
      expect(content).toContain('Financial Outcome Stability');
      expect(content).toContain('25%');
    });

    test('contains consulting analogy column in artifact table', () => {
      assembler.assemble({
        prompt: 'Test',
        passOutputs: createPassOutputs(),
        passesDegraded: [],
      });

      const content = fs.readFileSync(
        path.join(tmpDir, 'exec-artifact-001', 'DECISION_PACKAGE.md'), 'utf-8',
      );
      expect(content).toContain('Consulting Analogy');
      expect(content).toContain('McKinsey');
    });

    test('lists degraded artifacts separately', () => {
      assembler.assemble({
        prompt: 'Test',
        passOutputs: createPassOutputs({ 4: 'degraded' }),
        passesDegraded: [4],
      });

      const content = fs.readFileSync(
        path.join(tmpDir, 'exec-artifact-001', 'DECISION_PACKAGE.md'), 'utf-8',
      );
      expect(content).toContain('Degraded Artifacts');
    });

    test('shows artifact completion counts', () => {
      assembler.assemble({
        prompt: 'Test',
        passOutputs: createPassOutputs(),
        passesDegraded: [],
      });

      const content = fs.readFileSync(
        path.join(tmpDir, 'exec-artifact-001', 'DECISION_PACKAGE.md'), 'utf-8',
      );
      expect(content).toContain('Artifacts Complete:');
      expect(content).toContain('Artifacts Degraded:');
      expect(content).toContain('Artifacts Not Generated:');
    });

    test('shows degradation penalty in confidence section', () => {
      assembler.assemble({
        prompt: 'Test',
        passOutputs: createPassOutputs({ 2: 'degraded', 4: 'degraded' }),
        passesDegraded: [2, 4],
      });

      const content = fs.readFileSync(
        path.join(tmpDir, 'exec-artifact-001', 'DECISION_PACKAGE.md'), 'utf-8',
      );
      expect(content).toContain('Degradation Penalty');
      expect(content).toContain('-20%');
    });
  });

  // ==========================================================================
  // DecisionPackage Metadata
  // ==========================================================================

  describe('DecisionPackage metadata', () => {
    test('includes all expected fields', () => {
      const pkg = assembler.assemble({
        prompt: 'Migrate SAP to cloud',
        passOutputs: createPassOutputs(),
        passesDegraded: [],
      });

      expect(pkg.executionId).toBe('exec-artifact-001');
      expect(pkg.timestamp).toBeTruthy();
      expect(pkg.prompt).toBe('Migrate SAP to cloud');
      expect(typeof pkg.confidenceScore).toBe('number');
      expect(pkg.artifacts).toHaveLength(15);
      expect(pkg.passesExecuted).toBe(7);
      expect(pkg.passesDegraded).toEqual([]);
      expect(typeof pkg.totalAgentsInvoked).toBe('number');
      expect(typeof pkg.totalDurationMs).toBe('number');
    });

    test('recommendation is a valid enum value', () => {
      const pkg = assembler.assemble({
        prompt: 'Test',
        passOutputs: createPassOutputs(),
        passesDegraded: [],
      });
      expect(['proceed', 'proceed-with-conditions', 'investigate-further', 'do-not-proceed']).toContain(pkg.recommendation);
    });
  });
});
