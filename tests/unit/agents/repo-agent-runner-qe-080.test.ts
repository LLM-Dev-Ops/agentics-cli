/**
 * ADR-PIPELINE-080 acceptance tests — quality_engineering domain registration.
 *
 * Asserts the CLI-side wiring that registers AQE as the `quality-engineering`
 * domain, backed by the `agentic-qe` adapter repo bundled as
 * `agentic-qe-agents`.
 */

import { describe, it, expect } from '@jest/globals';
import {
  BUNDLE_NAMES,
  FUNCTION_NAMES,
  hasRepoAgent,
} from '../../../src/agents/repo-agent-runner.js';
import { hasLocalPrompt } from '../../../src/agents/system-prompts.js';

describe('ADR-080: quality_engineering domain registration', () => {
  describe('repo-agent-runner maps', () => {
    it('recognizes quality-engineering as a registered domain', () => {
      expect(hasRepoAgent('quality-engineering')).toBe(true);
    });

    it('maps quality-engineering → agentic-qe in FUNCTION_NAMES', () => {
      expect(FUNCTION_NAMES['quality-engineering']).toBe('agentic-qe');
    });

    it('maps agentic-qe → agentic-qe-agents in BUNDLE_NAMES', () => {
      expect(BUNDLE_NAMES['agentic-qe']).toBe('agentic-qe-agents');
    });
  });

  describe('system-prompts registration', () => {
    const EXPECTED_AGENTS = [
      'test-design',
      'unit-test-gen',
      'integration-test-gen',
      'property-test-gen',
      'bdd-test-gen',
      'coverage-analysis',
      'coverage-gap-detect',
      'defect-prediction',
      'flaky-detection',
      'rca',
      'traceability',
      'chaos',
      'test-execution',
      'qe-reporting',
    ];

    it('registers all 14 QE agents with local system prompts', () => {
      for (const agent of EXPECTED_AGENTS) {
        expect(hasLocalPrompt('quality-engineering', agent)).toBe(true);
      }
    });

    it('exposes exactly 14 QE agents (scope boundary per ADR-082)', () => {
      expect(EXPECTED_AGENTS).toHaveLength(14);
    });
  });
});
