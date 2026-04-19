/**
 * ADR-PIPELINE-085 acceptance tests — test_bench and quality_engineering
 * domain coexistence.
 *
 * Verifies that:
 *   - test_bench is registered in ecosystem.graph.json infrastructure[]
 *     (resolves the runner/graph inconsistency documented in ADR-085).
 *   - Disambiguation rules from ADR-085 §3 route queries to the correct domain
 *     across the 15+ boundary cases called out by the ADR.
 *
 * Rules under test (ADR-085 §3):
 *   "regression"    → test: QE; model/quality/none: test_bench
 *   "quality"       → code/test: QE; model/output: test_bench; bare: QE (default)
 *   "evaluation"    → code/test/coverage/defect: QE; model/prompt/llm: test_bench
 *   "synthetic"     → test/fixture/mock: QE; benchmark/dataset/training: test_bench
 */

import { describe, it, expect } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { routeKeyword, resolveDomainBoundary } from '../../../src/routing/domain-boundary.js';

const GRAPH_PATH = join(process.cwd(), 'docs', 'ecosystem.graph.json');

interface InfrastructureEntry {
  name: string;
  agents?: string[];
  tags?: string[];
  scope?: string;
  description?: string;
  repos?: string[];
}

describe('ADR-085: test_bench and quality_engineering coexistence', () => {
  // ========================================================================
  // Ecosystem graph inconsistency resolution (§1)
  // ========================================================================
  describe('ecosystem graph registration', () => {
    const graph = JSON.parse(readFileSync(GRAPH_PATH, 'utf-8')) as { infrastructure: InfrastructureEntry[] };
    const testBench = graph.infrastructure.find(d => d.name === 'test_bench');
    const qe = graph.infrastructure.find(d => d.name === 'quality_engineering');

    it('test_bench is registered in infrastructure[]', () => {
      expect(testBench).toBeDefined();
    });

    it('test_bench has global scope', () => {
      expect(testBench?.scope).toBe('global');
    });

    it('test_bench declares 14 agents matching the ADR-085 inventory', () => {
      expect(testBench?.agents).toHaveLength(14);
      expect(testBench?.agents).toEqual(expect.arrayContaining([
        'Benchmark Agent', 'Compare Agent', 'Regression Detection Agent',
        'Quality Scoring Agent', 'Hallucination Detection Agent',
        'Faithfulness Agent', 'Bias Evaluation Agent',
        'Prompt Sensitivity Agent', 'Consistency Agent', 'Stress Test Agent',
        'Red Team Agent', 'Adversarial Agent', 'Golden Dataset Agent',
        'Synthetic Data Agent',
      ]));
    });

    it('test_bench tags do not overlap with QE-owned test-generation tags', () => {
      const tb = new Set(testBench?.tags ?? []);
      const qeOwnedTags = ['test-generation', 'unit-test', 'integration-test', 'property-test', 'bdd', 'chaos', 'flaky-detection', 'traceability'];
      for (const tag of qeOwnedTags) {
        expect(tb.has(tag)).toBe(false);
      }
    });

    it('test_bench and quality_engineering both registered as peers', () => {
      expect(testBench).toBeDefined();
      expect(qe).toBeDefined();
    });
  });

  // ========================================================================
  // Disambiguation cases from ADR-085 §3 — 15+ boundary scenarios
  // ========================================================================
  describe('disambiguation case 1: "regression"', () => {
    it('"regression test" → quality_engineering', () => {
      expect(routeKeyword('regression', 'please run a regression test')).toBe('quality_engineering');
    });

    it('"API regression test" → quality_engineering', () => {
      expect(routeKeyword('regression', 'API regression test suite')).toBe('quality_engineering');
    });

    it('"model regression" → test_bench', () => {
      expect(routeKeyword('regression', 'detect model regression after fine-tune')).toBe('test_bench');
    });

    it('"quality regression" → test_bench', () => {
      expect(routeKeyword('regression', 'quality regression over benchmark runs')).toBe('test_bench');
    });

    it('bare "regression" (no modifier) → test_bench', () => {
      expect(routeKeyword('regression', 'investigate a regression')).toBe('test_bench');
    });
  });

  describe('disambiguation case 2: "quality"', () => {
    it('"code quality" → quality_engineering', () => {
      expect(routeKeyword('quality', 'audit the code quality of this module')).toBe('quality_engineering');
    });

    it('"test quality" → quality_engineering', () => {
      expect(routeKeyword('quality', 'improve the test quality')).toBe('quality_engineering');
    });

    it('"model quality" → test_bench', () => {
      expect(routeKeyword('quality', 'model quality after quantization')).toBe('test_bench');
    });

    it('"output quality" → test_bench', () => {
      expect(routeKeyword('quality', 'output quality scoring on the agent')).toBe('test_bench');
    });

    it('bare "quality" (no modifier) → quality_engineering (default)', () => {
      expect(routeKeyword('quality', 'review the quality')).toBe('quality_engineering');
    });
  });

  describe('disambiguation case 3: "evaluation"', () => {
    it('"code evaluation" → quality_engineering', () => {
      expect(routeKeyword('evaluation', 'static code evaluation of the PR')).toBe('quality_engineering');
    });

    it('"coverage evaluation" → quality_engineering', () => {
      expect(routeKeyword('evaluation', 'coverage evaluation on the suite')).toBe('quality_engineering');
    });

    it('"defect evaluation" → quality_engineering', () => {
      expect(routeKeyword('evaluation', 'defect evaluation for risk scoring')).toBe('quality_engineering');
    });

    it('"model evaluation" → test_bench', () => {
      expect(routeKeyword('evaluation', 'comprehensive model evaluation')).toBe('test_bench');
    });

    it('"prompt evaluation" → test_bench', () => {
      expect(routeKeyword('evaluation', 'prompt evaluation across variants')).toBe('test_bench');
    });

    it('"LLM evaluation" → test_bench', () => {
      expect(routeKeyword('evaluation', 'LLM evaluation framework')).toBe('test_bench');
    });
  });

  describe('disambiguation case 4: "synthetic"', () => {
    it('"synthetic test data" → quality_engineering', () => {
      expect(routeKeyword('synthetic', 'generate synthetic test data')).toBe('quality_engineering');
    });

    it('"synthetic fixtures" → quality_engineering', () => {
      expect(routeKeyword('synthetic', 'synthetic fixtures for the integration tests')).toBe('quality_engineering');
    });

    it('"synthetic mock data" → quality_engineering', () => {
      expect(routeKeyword('synthetic', 'synthetic mock data for handler unit tests')).toBe('quality_engineering');
    });

    it('"synthetic benchmark dataset" → test_bench', () => {
      expect(routeKeyword('synthetic', 'synthetic benchmark dataset for evaluation')).toBe('test_bench');
    });

    it('"synthetic training data" → test_bench', () => {
      expect(routeKeyword('synthetic', 'synthetic training data for fine-tune')).toBe('test_bench');
    });
  });

  // ========================================================================
  // Suppression does not fire between test_bench and quality_engineering
  // ========================================================================
  describe('no cross-suppression between test_bench and QE', () => {
    it('"generate unit tests" does NOT suppress test_bench (they are peers, not competitors)', () => {
      const { suppressedDomains } = resolveDomainBoundary('generate unit tests');
      expect(suppressedDomains.has('test_bench')).toBe(false);
    });

    it('"benchmark our model" does NOT suppress quality_engineering', () => {
      const { suppressedDomains } = resolveDomainBoundary('benchmark our model against GPT-4');
      expect(suppressedDomains.has('quality_engineering')).toBe(false);
    });
  });

  // ========================================================================
  // End-to-end: full prompts route to the correct domain primary
  // ========================================================================
  describe('end-to-end prompt routing', () => {
    const cases: Array<{ prompt: string; expected: string; label: string }> = [
      { prompt: 'write a regression test for the new endpoint', expected: 'quality_engineering', label: 'regression test → QE' },
      { prompt: 'detect model quality regression after the update', expected: 'test_bench', label: 'model quality regression → test_bench' },
      { prompt: 'audit the code quality of this module', expected: 'quality_engineering', label: 'code quality → QE' },
      { prompt: 'score model quality across variants', expected: 'test_bench', label: 'model quality → test_bench' },
      { prompt: 'run coverage evaluation on the suite', expected: 'quality_engineering', label: 'coverage evaluation → QE' },
      { prompt: 'full model evaluation on MMLU', expected: 'test_bench', label: 'model evaluation → test_bench' },
      { prompt: 'generate synthetic test data for the suite', expected: 'quality_engineering', label: 'synthetic test data → QE' },
      { prompt: 'generate synthetic benchmark dataset', expected: 'test_bench', label: 'synthetic benchmark → test_bench' },
    ];

    it.each(cases)('$label: routes correctly', ({ prompt, expected }) => {
      const { disambiguations } = resolveDomainBoundary(prompt);
      const winners = Array.from(disambiguations.values());
      expect(winners).toContain(expected);
    });
  });
});
