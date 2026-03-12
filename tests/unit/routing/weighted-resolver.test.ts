/**
 * Tests for the Weighted Agent Resolver (ADR-031 Phase 1)
 */

import {
  normalizeAgent,
  normalizeAgents,
  getAgentName,
  selectWeightedAgents,
  validateAgentInput,
  isWeightedAgent,
} from '../../../src/routing/weighted-resolver.js';
import type { AgentInput, WeightedAgent } from '../../../src/routing/weighted-resolver.js';

// ============================================================================
// Tests
// ============================================================================

describe('Weighted Resolver', () => {
  describe('normalizeAgent', () => {
    it('converts plain string to weighted agent', () => {
      const result = normalizeAgent('Test Agent');
      expect(result).toEqual({ name: 'Test Agent', weight: 1.0, role: 'primary' });
    });

    it('passes through weighted agent objects', () => {
      const input: WeightedAgent = { name: 'Agent X', weight: 0.7, role: 'secondary' };
      const result = normalizeAgent(input);
      expect(result).toEqual(input);
    });

    it('clamps weight to [0, 1]', () => {
      const over = normalizeAgent({ name: 'A', weight: 1.5, role: 'primary' });
      expect(over.weight).toBe(1.0);

      const under = normalizeAgent({ name: 'B', weight: -0.5, role: 'primary' });
      expect(under.weight).toBe(0);
    });

    it('defaults role to primary when missing', () => {
      const result = normalizeAgent({ name: 'A', weight: 0.5 } as WeightedAgent);
      expect(result.role).toBe('primary');
    });
  });

  describe('normalizeAgents', () => {
    it('normalizes mixed array of strings and objects', () => {
      const inputs: AgentInput[] = [
        'Agent A',
        { name: 'Agent B', weight: 0.8, role: 'secondary' },
      ];
      const result = normalizeAgents(inputs);
      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({ name: 'Agent A', weight: 1.0, role: 'primary' });
      expect(result[1]).toEqual({ name: 'Agent B', weight: 0.8, role: 'secondary' });
    });
  });

  describe('getAgentName', () => {
    it('extracts name from string', () => {
      expect(getAgentName('Agent A')).toBe('Agent A');
    });

    it('extracts name from weighted object', () => {
      expect(getAgentName({ name: 'Agent B', weight: 0.5, role: 'primary' })).toBe('Agent B');
    });
  });

  describe('selectWeightedAgents', () => {
    const agents: AgentInput[] = [
      { name: 'Primary A', weight: 1.0, role: 'primary' },
      { name: 'Primary B', weight: 0.9, role: 'primary' },
      { name: 'Secondary C', weight: 0.5, role: 'secondary' },
      { name: 'Secondary D', weight: 0.4, role: 'secondary' },
      { name: 'Red Team Specialist', weight: 0.2, role: 'specialist' },
    ];

    it('selects primary agents first', () => {
      const result = selectWeightedAgents(agents, { budget: 2 });
      expect(result).toHaveLength(2);
      expect(result[0]!.name).toBe('Primary A');
      expect(result[1]!.name).toBe('Primary B');
    });

    it('fills with secondary agents when budget allows', () => {
      const result = selectWeightedAgents(agents, { budget: 4 });
      expect(result).toHaveLength(4);
      expect(result[2]!.role).toBe('secondary');
      expect(result[3]!.role).toBe('secondary');
    });

    it('adds specialists when prompt tags match', () => {
      const result = selectWeightedAgents(agents, {
        budget: 3,
        promptTags: ['red', 'team'],
      });
      // Should have 2 primary + red team specialist
      const hasSpecialist = result.some(a => a.name === 'Red Team Specialist');
      expect(hasSpecialist).toBe(true);
    });

    it('does not add specialists without matching tags', () => {
      const result = selectWeightedAgents(agents, {
        budget: 5,
        promptTags: [],
      });
      const hasSpecialist = result.some(a => a.role === 'specialist');
      expect(hasSpecialist).toBe(false);
    });

    it('handles budget of 0', () => {
      const result = selectWeightedAgents(agents, { budget: 0 });
      expect(result).toHaveLength(0);
    });

    it('handles empty agent array', () => {
      const result = selectWeightedAgents([], { budget: 5 });
      expect(result).toHaveLength(0);
    });

    it('handles all-string agents (backward compat)', () => {
      const stringAgents: AgentInput[] = ['Agent 1', 'Agent 2', 'Agent 3'];
      const result = selectWeightedAgents(stringAgents, { budget: 2 });
      expect(result).toHaveLength(2);
      expect(result[0]!.weight).toBe(1.0);
      expect(result[0]!.role).toBe('primary');
    });
  });

  describe('validateAgentInput', () => {
    it('accepts valid string', () => {
      expect(validateAgentInput('Agent A', '$.agents[0]')).toHaveLength(0);
    });

    it('rejects empty string', () => {
      const errors = validateAgentInput('', '$.agents[0]');
      expect(errors.length).toBeGreaterThan(0);
    });

    it('accepts valid weighted object', () => {
      const errors = validateAgentInput(
        { name: 'A', weight: 0.5, role: 'secondary' },
        '$.agents[0]',
      );
      expect(errors).toHaveLength(0);
    });

    it('rejects weight out of range', () => {
      const errors = validateAgentInput(
        { name: 'A', weight: 1.5, role: 'primary' },
        '$.agents[0]',
      );
      expect(errors.length).toBeGreaterThan(0);
    });

    it('rejects invalid role', () => {
      const errors = validateAgentInput(
        { name: 'A', weight: 0.5, role: 'leader' },
        '$.agents[0]',
      );
      expect(errors.length).toBeGreaterThan(0);
    });

    it('rejects non-string/non-object', () => {
      const errors = validateAgentInput(42, '$.agents[0]');
      expect(errors.length).toBeGreaterThan(0);
    });
  });

  describe('isWeightedAgent', () => {
    it('returns true for weighted objects', () => {
      expect(isWeightedAgent({ name: 'A', weight: 0.5 })).toBe(true);
    });

    it('returns false for strings', () => {
      expect(isWeightedAgent('Agent A')).toBe(false);
    });

    it('returns false for null', () => {
      expect(isWeightedAgent(null)).toBe(false);
    });
  });
});
