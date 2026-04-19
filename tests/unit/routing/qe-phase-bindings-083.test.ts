/**
 * ADR-PIPELINE-083 acceptance tests — phase capability bindings for QE.
 *
 * Verifies that docs/ecosystem.graph.json has the expected QE agent bindings
 * on each phase per ADR-083 §6, and that the capability classifier can
 * match QE-related prompts to the relevant phases via their updated tags.
 */

import { describe, it, expect } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { classifyCapabilities } from '../../../src/routing/capability-classifier.js';
import type { EcosystemGraph } from '../../../src/routing/graph-loader.js';

const GRAPH_PATH = join(process.cwd(), 'docs', 'ecosystem.graph.json');

interface PhaseCapability {
  name: string;
  phase?: number;
  mandatory_agents?: string[];
  optional_agents?: string[];
  tags?: string[];
}

function loadGraph(): EcosystemGraph {
  return JSON.parse(readFileSync(GRAPH_PATH, 'utf-8')) as EcosystemGraph;
}

function phase(graph: EcosystemGraph, n: number): PhaseCapability {
  const cap = graph.capabilities.find(c => 'phase' in c && (c as PhaseCapability).phase === n) as PhaseCapability | undefined;
  if (!cap) throw new Error(`Phase ${n} not found in graph`);
  return cap;
}

// All 14 QE agents per ADR-080.
const ALL_QE_AGENTS = [
  'Test Design Agent',
  'Unit Test Generation Agent',
  'Integration Test Generation Agent',
  'Property-Based Test Agent',
  'BDD Test Generation Agent',
  'Coverage Analysis Agent',
  'Coverage Gap Detection Agent',
  'Defect Prediction Agent',
  'Flaky Test Detection Agent',
  'Root Cause Analysis Agent',
  'Requirements Traceability Agent',
  'Chaos Engineering Agent',
  'Test Execution Orchestrator Agent',
  'QE Reporting Agent',
] as const;

describe('ADR-083: Phase Capability Binding for Quality Engineering', () => {
  const graph = loadGraph();

  // ========================================================================
  // Phase 8 — Mandatory gating anchor
  // ========================================================================
  describe('phase 8 (validation) — mandatory gating', () => {
    const p8 = phase(graph, 8);

    it('includes all 14 QE agents in mandatory_agents', () => {
      for (const agent of ALL_QE_AGENTS) {
        expect(p8.mandatory_agents).toContain(agent);
      }
    });

    it('preserves the original 4 pre-QE mandatory agents', () => {
      expect(p8.mandatory_agents).toContain('Quality Scoring Agent');
      expect(p8.mandatory_agents).toContain('Output Consistency Agent');
      expect(p8.mandatory_agents).toContain('Hallucination Detection Agent');
      expect(p8.mandatory_agents).toContain('Faithfulness Verification Agent');
    });

    it('has 18 mandatory agents total (4 original + 14 QE)', () => {
      expect(p8.mandatory_agents).toHaveLength(18);
    });

    it('adds QE tags for classifier matching', () => {
      expect(p8.tags).toEqual(expect.arrayContaining([
        'qe', 'testing', 'test', 'coverage', 'defect', 'flaky', 'rca', 'traceability', 'chaos', 'quality-engineering',
      ]));
    });
  });

  // ========================================================================
  // Phases 3, 5, 6, 7, 9, 10 — Optional (advisory) bindings
  // ========================================================================
  describe('phase 3 (sparc_generation)', () => {
    const p3 = phase(graph, 3);

    it('adds Test Design + Requirements Traceability as optional', () => {
      expect(p3.optional_agents).toContain('Test Design Agent');
      expect(p3.optional_agents).toContain('Requirements Traceability Agent');
    });

    it('does NOT add QE agents to mandatory', () => {
      for (const agent of ALL_QE_AGENTS) {
        expect(p3.mandatory_agents ?? []).not.toContain(agent);
      }
    });

    it('adds testability + traceability tags', () => {
      expect(p3.tags).toEqual(expect.arrayContaining(['testability', 'traceability']));
    });
  });

  describe('phase 5 (adr_ddd_architecture)', () => {
    const p5 = phase(graph, 5);

    it('adds Defect Prediction + Test Design as optional', () => {
      expect(p5.optional_agents).toContain('Defect Prediction Agent');
      expect(p5.optional_agents).toContain('Test Design Agent');
    });

    it('adds defect-prediction + testability tags', () => {
      expect(p5.tags).toEqual(expect.arrayContaining(['defect-prediction', 'testability']));
    });
  });

  describe('phase 6 (implementation_planning)', () => {
    const p6 = phase(graph, 6);

    it('adds Coverage Gap Detection as optional', () => {
      expect(p6.optional_agents).toContain('Coverage Gap Detection Agent');
    });

    it('adds coverage + coverage-gap tags', () => {
      expect(p6.tags).toEqual(expect.arrayContaining(['coverage', 'coverage-gap']));
    });
  });

  describe('phase 7 (build)', () => {
    const p7 = phase(graph, 7);

    it('adds the 5 test-generation + coverage analysis agents as optional', () => {
      expect(p7.optional_agents).toEqual(expect.arrayContaining([
        'Unit Test Generation Agent',
        'Integration Test Generation Agent',
        'Property-Based Test Agent',
        'BDD Test Generation Agent',
        'Coverage Analysis Agent',
      ]));
    });

    it('adds test-generation + unit-test + integration-test + property-test + bdd + coverage tags', () => {
      expect(p7.tags).toEqual(expect.arrayContaining([
        'test-generation', 'unit-test', 'integration-test', 'property-test', 'bdd', 'coverage',
      ]));
    });
  });

  describe('phase 9 (integration_mapping)', () => {
    const p9 = phase(graph, 9);

    it('adds Integration Test Generation + Chaos Engineering as optional', () => {
      expect(p9.optional_agents).toContain('Integration Test Generation Agent');
      expect(p9.optional_agents).toContain('Chaos Engineering Agent');
    });

    it('adds integration-test + chaos + fault-injection tags', () => {
      expect(p9.tags).toEqual(expect.arrayContaining(['integration-test', 'chaos', 'fault-injection']));
    });
  });

  describe('phase 10 (governance_finops)', () => {
    const p10 = phase(graph, 10);

    it('adds QE Reporting Agent as optional', () => {
      expect(p10.optional_agents).toContain('QE Reporting Agent');
    });

    it('adds qe-reporting + test-metrics tags', () => {
      expect(p10.tags).toEqual(expect.arrayContaining(['qe-reporting', 'test-metrics']));
    });
  });

  // ========================================================================
  // Non-bound phases (0, 1, 2, 4, 11) — ADR-083 §1 says these get no QE binding
  // ========================================================================
  describe('non-bound phases (0, 1, 2, 4, 11) have no QE bindings', () => {
    it.each([0, 1, 2, 4, 11])('phase %i has no QE agents in mandatory or optional', (n) => {
      const cap = phase(graph, n);
      const all = [...(cap.mandatory_agents ?? []), ...(cap.optional_agents ?? [])];
      for (const agent of ALL_QE_AGENTS) {
        expect(all).not.toContain(agent);
      }
    });
  });

  // ========================================================================
  // Classifier smoke test — QE-related queries match the right phases
  // ========================================================================
  describe('capability classifier QE tag activation', () => {
    it('matches "generate unit tests" to phase 7 (build)', () => {
      const result = classifyCapabilities('generate unit tests for the new service', graph);
      const matchedNames = result.capabilities.map(c => c.name);
      expect(matchedNames).toContain('build');
    });

    it('matches "coverage analysis" to phases 6 and 7', () => {
      const result = classifyCapabilities('run coverage analysis on the codebase', graph);
      const matchedNames = result.capabilities.map(c => c.name);
      expect(matchedNames).toContain('build');
    });

    it('matches "chaos engineering" to phase 9 (integration)', () => {
      const result = classifyCapabilities('chaos engineering fault injection tests', graph);
      const matchedNames = result.capabilities.map(c => c.name);
      expect(matchedNames).toContain('integration_mapping');
    });

    it('matches "testability review" to phases 3 and 5', () => {
      const result = classifyCapabilities('testability review of the architecture', graph);
      const matchedNames = result.capabilities.map(c => c.name);
      expect(matchedNames).toEqual(expect.arrayContaining(['sparc_generation', 'adr_ddd_architecture']));
    });
  });

  // ========================================================================
  // Binding-count invariants (sanity checks)
  // ========================================================================
  describe('binding-count invariants', () => {
    it('phase 8 mandatory count ≥ 18 (original 4 + all 14 QE)', () => {
      expect(phase(graph, 8).mandatory_agents?.length ?? 0).toBeGreaterThanOrEqual(18);
    });

    it('phase 7 optional count ≥ 10 (original 5 + 5 QE)', () => {
      expect(phase(graph, 7).optional_agents?.length ?? 0).toBeGreaterThanOrEqual(10);
    });

    it('phase 10 optional count ≥ 7 (original 6 + 1 QE)', () => {
      expect(phase(graph, 10).optional_agents?.length ?? 0).toBeGreaterThanOrEqual(7);
    });
  });
});
