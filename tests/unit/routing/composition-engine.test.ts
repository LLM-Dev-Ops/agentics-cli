/**
 * Tests for the Composition Engine (ADR-031 Phase 3)
 */

import {
  applyCompositions,
  validateCompositionRules,
  detectCompositionCycles,
  formatCompositionExplanation,
} from '../../../src/routing/composition-engine.js';
import type { CompositionRule } from '../../../src/routing/composition-engine.js';

// ============================================================================
// Test Fixtures
// ============================================================================

const VALID_CAPABILITIES = new Set([
  'security_validation',
  'erp_integration',
  'workflow_orchestration',
  'data_security',
  'incident_management',
  'simulation',
  'cost_finops',
  'performance_profiling',
  'governance',
]);

const TEST_RULES: CompositionRule[] = [
  {
    id: 'erp-data-protection',
    when: ['erp_integration', 'security_validation'],
    operator: 'all',
    add: ['data_security'],
    reason: 'ERP data contains PII requiring anonymization controls',
    priority: 'required',
  },
  {
    id: 'cost-simulation-latency',
    when: ['simulation', 'cost_finops'],
    operator: 'all',
    add: ['performance_profiling'],
    reason: 'Cost simulations need latency data for accuracy',
    priority: 'recommended',
  },
  {
    id: 'enterprise-escalation',
    when: ['workflow_orchestration', 'erp_integration'],
    operator: 'all',
    add: ['incident_management'],
    reason: 'Enterprise workflows require escalation paths',
    priority: 'recommended',
  },
  {
    id: 'security-audit-governance',
    when: ['security_validation'],
    operator: 'any',
    add: ['governance'],
    reason: 'Security changes require governance audit trail',
    priority: 'optional',
  },
];

// ============================================================================
// Tests
// ============================================================================

describe('Composition Engine', () => {
  describe('applyCompositions', () => {
    it('adds capabilities when "all" condition is met', () => {
      const result = applyCompositions(
        ['erp_integration', 'security_validation'],
        TEST_RULES,
        VALID_CAPABILITIES,
      );

      expect(result.capabilities).toContain('data_security');
      expect(result.added).toContain('data_security');
      expect(result.firedRules.length).toBeGreaterThan(0);
    });

    it('does not fire "all" rule when only one capability present', () => {
      const result = applyCompositions(
        ['erp_integration'],
        TEST_RULES,
        VALID_CAPABILITIES,
      );

      expect(result.capabilities).not.toContain('data_security');
      expect(result.added).toHaveLength(0);
    });

    it('does not fire "optional" rules automatically', () => {
      const result = applyCompositions(
        ['security_validation'],
        TEST_RULES,
        VALID_CAPABILITIES,
      );

      expect(result.capabilities).not.toContain('governance');
    });

    it('fires "recommended" rules when under budget', () => {
      const result = applyCompositions(
        ['simulation', 'cost_finops'],
        TEST_RULES,
        VALID_CAPABILITIES,
        { currentAgentCount: 3, agentBudget: 15 },
      );

      expect(result.capabilities).toContain('performance_profiling');
    });

    it('skips "recommended" rules when near budget', () => {
      const result = applyCompositions(
        ['simulation', 'cost_finops'],
        TEST_RULES,
        VALID_CAPABILITIES,
        { currentAgentCount: 14, agentBudget: 15 },
      );

      expect(result.capabilities).not.toContain('performance_profiling');
    });

    it('handles empty capabilities', () => {
      const result = applyCompositions([], TEST_RULES, VALID_CAPABILITIES);
      expect(result.capabilities).toHaveLength(0);
      expect(result.iterations).toBe(0);
    });

    it('handles empty rules', () => {
      const result = applyCompositions(
        ['security_validation'],
        [],
        VALID_CAPABILITIES,
      );

      expect(result.capabilities).toEqual(['security_validation']);
      expect(result.iterations).toBe(0);
    });

    it('does not add capabilities not in validCapabilities', () => {
      const rules: CompositionRule[] = [
        {
          id: 'test-rule',
          when: ['security_validation'],
          operator: 'any',
          add: ['nonexistent_cap'],
          reason: 'test',
          priority: 'required',
        },
      ];

      const result = applyCompositions(
        ['security_validation'],
        rules,
        VALID_CAPABILITIES,
      );

      expect(result.capabilities).not.toContain('nonexistent_cap');
    });

    it('does not duplicate already-present capabilities', () => {
      const result = applyCompositions(
        ['erp_integration', 'security_validation', 'data_security'],
        TEST_RULES,
        VALID_CAPABILITIES,
      );

      const dataSecCount = result.capabilities.filter(c => c === 'data_security').length;
      expect(dataSecCount).toBe(1);
    });

    it('limits iterations to prevent infinite loops', () => {
      // Transitive rules that would loop without the iteration limit
      const chainRules: CompositionRule[] = [
        {
          id: 'chain-1',
          when: ['security_validation'],
          operator: 'any',
          add: ['data_security'],
          reason: 'test',
          priority: 'required',
        },
        {
          id: 'chain-2',
          when: ['data_security'],
          operator: 'any',
          add: ['governance'],
          reason: 'test',
          priority: 'required',
        },
      ];

      const result = applyCompositions(
        ['security_validation'],
        chainRules,
        VALID_CAPABILITIES,
      );

      expect(result.iterations).toBeLessThanOrEqual(3);
      expect(result.capabilities).toContain('data_security');
      expect(result.capabilities).toContain('governance');
    });

    it('fires "any" operator when at least one capability is present', () => {
      const anyRule: CompositionRule[] = [
        {
          id: 'any-test',
          when: ['erp_integration', 'simulation'],
          operator: 'any',
          add: ['governance'],
          reason: 'test',
          priority: 'required',
        },
      ];

      const result = applyCompositions(
        ['simulation'],
        anyRule,
        VALID_CAPABILITIES,
      );

      expect(result.capabilities).toContain('governance');
    });

    it('records fired rules with details', () => {
      const result = applyCompositions(
        ['erp_integration', 'security_validation'],
        TEST_RULES,
        VALID_CAPABILITIES,
      );

      const firedRule = result.firedRules.find(r => r.ruleId === 'erp-data-protection');
      expect(firedRule).toBeDefined();
      expect(firedRule!.reason).toContain('PII');
      expect(firedRule!.addedCapabilities).toContain('data_security');
    });
  });

  describe('validateCompositionRules', () => {
    it('accepts valid rules', () => {
      const errors = validateCompositionRules(TEST_RULES, VALID_CAPABILITIES);
      expect(errors).toHaveLength(0);
    });

    it('catches duplicate rule IDs', () => {
      const rules: CompositionRule[] = [
        { ...TEST_RULES[0]! },
        { ...TEST_RULES[0]! },
      ];
      const errors = validateCompositionRules(rules, VALID_CAPABILITIES);
      expect(errors.some(e => e.includes('duplicate'))).toBe(true);
    });

    it('catches unknown capabilities in "when"', () => {
      const rules: CompositionRule[] = [
        {
          id: 'bad-when',
          when: ['nonexistent'],
          operator: 'all',
          add: ['data_security'],
          reason: 'test',
          priority: 'required',
        },
      ];
      const errors = validateCompositionRules(rules, VALID_CAPABILITIES);
      expect(errors.some(e => e.includes('unknown capability'))).toBe(true);
    });

    it('catches unknown capabilities in "add"', () => {
      const rules: CompositionRule[] = [
        {
          id: 'bad-add',
          when: ['security_validation'],
          operator: 'all',
          add: ['nonexistent'],
          reason: 'test',
          priority: 'required',
        },
      ];
      const errors = validateCompositionRules(rules, VALID_CAPABILITIES);
      expect(errors.some(e => e.includes('unknown capability'))).toBe(true);
    });

    it('catches self-referencing rules', () => {
      const rules: CompositionRule[] = [
        {
          id: 'self-ref',
          when: ['security_validation'],
          operator: 'all',
          add: ['security_validation'],
          reason: 'test',
          priority: 'required',
        },
      ];
      const errors = validateCompositionRules(rules, VALID_CAPABILITIES);
      expect(errors.some(e => e.includes('self-referencing'))).toBe(true);
    });

    it('catches empty ID', () => {
      const rules: CompositionRule[] = [
        {
          id: '',
          when: ['security_validation'],
          operator: 'all',
          add: ['data_security'],
          reason: 'test',
          priority: 'required',
        },
      ];
      const errors = validateCompositionRules(rules, VALID_CAPABILITIES);
      expect(errors.length).toBeGreaterThan(0);
    });
  });

  describe('detectCompositionCycles', () => {
    it('detects no cycles in valid rules', () => {
      const result = detectCompositionCycles(TEST_RULES);
      expect(result.hasCycle).toBe(false);
    });

    it('detects cycles', () => {
      const cyclicRules: CompositionRule[] = [
        {
          id: 'r1',
          when: ['security_validation'],
          operator: 'any',
          add: ['data_security'],
          reason: 'test',
          priority: 'required',
        },
        {
          id: 'r2',
          when: ['data_security'],
          operator: 'any',
          add: ['security_validation'],
          reason: 'test',
          priority: 'required',
        },
      ];

      const result = detectCompositionCycles(cyclicRules);
      expect(result.hasCycle).toBe(true);
      expect(result.cycleNodes.length).toBeGreaterThan(0);
    });

    it('handles empty rules', () => {
      const result = detectCompositionCycles([]);
      expect(result.hasCycle).toBe(false);
    });
  });

  describe('formatCompositionExplanation', () => {
    it('formats fired rules', () => {
      const result = applyCompositions(
        ['erp_integration', 'security_validation'],
        TEST_RULES,
        VALID_CAPABILITIES,
      );

      const explanation = formatCompositionExplanation(result);
      expect(explanation).toContain('erp-data-protection');
      expect(explanation).toContain('data_security');
    });

    it('returns empty string when no rules fired', () => {
      const result = applyCompositions(
        ['simulation'],
        TEST_RULES,
        VALID_CAPABILITIES,
      );

      const explanation = formatCompositionExplanation(result);
      expect(explanation).toBe('');
    });
  });
});
