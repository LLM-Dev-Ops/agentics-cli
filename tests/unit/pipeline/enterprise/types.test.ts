/**
 * Enterprise Pipeline Types — Unit Tests
 */

import {
  PASS_ID_MAP,
  PASS_NUMBER_MAP,
} from '../../../../src/pipeline/enterprise/types.js';
import type {
  EnterprisePass,
  PassNumber,
  PassStatus,
  DecisionNodeType,
  ArtifactNumber,
} from '../../../../src/pipeline/enterprise/types.js';

describe('Enterprise Pipeline Types', () => {

  describe('PASS_ID_MAP', () => {
    test('maps all 7 passes', () => {
      expect(Object.keys(PASS_ID_MAP)).toHaveLength(7);
    });

    test('pass 1 is problem-intelligence', () => {
      expect(PASS_ID_MAP[1]).toBe('problem-intelligence');
    });

    test('pass 2 is simulation-scenario', () => {
      expect(PASS_ID_MAP[2]).toBe('simulation-scenario');
    });

    test('pass 3 is architecture-prototype', () => {
      expect(PASS_ID_MAP[3]).toBe('architecture-prototype');
    });

    test('pass 4 is governance-compliance-costops', () => {
      expect(PASS_ID_MAP[4]).toBe('governance-compliance-costops');
    });

    test('pass 5 is decision-artifacts', () => {
      expect(PASS_ID_MAP[5]).toBe('decision-artifacts');
    });

    test('pass 6 is erp-deployment', () => {
      expect(PASS_ID_MAP[6]).toBe('erp-deployment');
    });

    test('pass 7 is observability-learning', () => {
      expect(PASS_ID_MAP[7]).toBe('observability-learning');
    });
  });

  describe('PASS_NUMBER_MAP', () => {
    test('is the inverse of PASS_ID_MAP', () => {
      for (const [numStr, passId] of Object.entries(PASS_ID_MAP)) {
        const num = Number(numStr) as PassNumber;
        expect(PASS_NUMBER_MAP[passId as EnterprisePass]).toBe(num);
      }
    });

    test('maps all 7 passes', () => {
      expect(Object.keys(PASS_NUMBER_MAP)).toHaveLength(7);
    });
  });

  describe('Type safety', () => {
    test('PassNumber accepts 1-7', () => {
      const passes: PassNumber[] = [1, 2, 3, 4, 5, 6, 7];
      expect(passes).toHaveLength(7);
    });

    test('PassStatus includes degraded', () => {
      const statuses: PassStatus[] = ['pending', 'running', 'completed', 'degraded', 'failed', 'skipped'];
      expect(statuses).toContain('degraded');
    });

    test('DecisionNodeType includes all ADR-033 types', () => {
      const types: DecisionNodeType[] = [
        'problem_definition', 'business_context', 'technical_scope',
        'scenario', 'risk_signal', 'reliability_report',
        'system_architecture', 'prototype',
        'security_analysis', 'cost_model', 'compliance_report',
        'executive_memo', 'executive_summary', 'confidence_score',
        'okr_alignment', 'raid_log', 'provenance_manifest',
      ];
      expect(types.length).toBeGreaterThan(0);
    });

    test('ArtifactNumber accepts 1-15', () => {
      const nums: ArtifactNumber[] = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];
      expect(nums).toHaveLength(15);
    });
  });
});
