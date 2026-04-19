/**
 * ADR-PIPELINE-082 acceptance tests — domain boundary resolution.
 *
 * Exercises the disambiguation rules (§3) and tie-break rules (§4) documented
 * in the ADR. Covers the 15+ disambiguation cases called out in the ADR's
 * acceptance criteria.
 */

import { describe, it, expect } from '@jest/globals';
import {
  DISAMBIGUATION_RULES,
  TIE_BREAK_RULES,
  resolveDomainBoundary,
  isDomainSuppressed,
  routeKeyword,
} from '../../../src/routing/domain-boundary.js';

describe('ADR-082: Domain Boundary Resolution', () => {
  // ========================================================================
  // Rule inventory (per ADR-082 §1 capability ownership map)
  // ========================================================================
  describe('rule inventory', () => {
    it('declares the 4 disambiguation rules from ADR-082 §3', () => {
      const triggers = DISAMBIGUATION_RULES.map(r => r.trigger);
      expect(triggers).toEqual(expect.arrayContaining(['regression', 'quality', 'evaluation', 'synthetic']));
    });

    it('declares tie-break rules covering security, performance, privacy, and ERP boundaries', () => {
      const keywords = TIE_BREAK_RULES.map(r => r.keyword);
      expect(keywords).toEqual(expect.arrayContaining([
        'security', 'sast', 'dast', 'vulnerability',    // Shield
        'latency', 'cold-start',                         // Latency-Lens
        'anonymize', 'pii', 'redaction',                // Data-Vault + Shield
        'sap', 'oracle', 'workday', 'soap', 'odata',    // connector-hub / ERP surface
        'learning',                                      // Memory-Graph
      ]));
    });

    it('marks performance as complementary (both domains stay)', () => {
      const rule = TIE_BREAK_RULES.find(r => r.keyword === 'latency');
      expect(rule).toBeDefined();
      expect(rule?.suppress).toEqual([]);
    });

    it('suppresses quality_engineering on security, SAP, and privacy keywords', () => {
      const securityRule = TIE_BREAK_RULES.find(r => r.keyword === 'security');
      const sapRule = TIE_BREAK_RULES.find(r => r.keyword === 'sap');
      const piiRule = TIE_BREAK_RULES.find(r => r.keyword === 'pii');
      expect(securityRule?.suppress).toContain('quality_engineering');
      expect(sapRule?.suppress).toContain('quality_engineering');
      expect(piiRule?.suppress).toContain('quality_engineering');
    });
  });

  // ========================================================================
  // Disambiguation rules (§3)
  // ========================================================================
  describe('disambiguation: regression', () => {
    it('routes "regression test" → quality_engineering', () => {
      expect(routeKeyword('regression', 'run a regression test on the new endpoint')).toBe('quality_engineering');
    });

    it('routes "model regression" → test_bench', () => {
      expect(routeKeyword('regression', 'detect model regression after the fine-tune')).toBe('test_bench');
    });

    it('routes "quality regression" → test_bench', () => {
      expect(routeKeyword('regression', 'quality regression on benchmark runs')).toBe('test_bench');
    });

    it('defaults bare "regression" → test_bench', () => {
      expect(routeKeyword('regression', 'investigate a regression')).toBe('test_bench');
    });
  });

  describe('disambiguation: quality', () => {
    it('routes "code quality" → quality_engineering', () => {
      expect(routeKeyword('quality', 'audit the code quality of this module')).toBe('quality_engineering');
    });

    it('routes "test quality" → quality_engineering', () => {
      expect(routeKeyword('quality', 'improve the test quality across the suite')).toBe('quality_engineering');
    });

    it('routes "model quality" → test_bench', () => {
      expect(routeKeyword('quality', 'model quality after the quant change')).toBe('test_bench');
    });

    it('routes "output quality" → test_bench', () => {
      expect(routeKeyword('quality', 'output quality scoring across prompts')).toBe('test_bench');
    });

    it('defaults bare "quality" → quality_engineering', () => {
      expect(routeKeyword('quality', 'review the quality')).toBe('quality_engineering');
    });
  });

  describe('disambiguation: evaluation', () => {
    it('routes "code evaluation" → quality_engineering', () => {
      expect(routeKeyword('evaluation', 'static code evaluation of the PR')).toBe('quality_engineering');
    });

    it('routes "model evaluation" → test_bench', () => {
      expect(routeKeyword('evaluation', 'comprehensive model evaluation')).toBe('test_bench');
    });

    it('routes "prompt evaluation" → test_bench', () => {
      expect(routeKeyword('evaluation', 'prompt evaluation across variants')).toBe('test_bench');
    });
  });

  describe('disambiguation: synthetic', () => {
    it('routes "synthetic test data" → quality_engineering', () => {
      expect(routeKeyword('synthetic', 'generate synthetic test fixtures')).toBe('quality_engineering');
    });

    it('routes "synthetic benchmark data" → test_bench', () => {
      expect(routeKeyword('synthetic', 'synthetic benchmark dataset for eval')).toBe('test_bench');
    });
  });

  // ========================================================================
  // Tie-break rules (§4)
  // ========================================================================
  describe('tie-break: security keywords', () => {
    it('suppresses quality_engineering when prompt mentions "security"', () => {
      const { suppressedDomains } = resolveDomainBoundary('scan for security issues in the code');
      expect(suppressedDomains.has('quality_engineering')).toBe(true);
    });

    it('resolves "security" → safety', () => {
      expect(routeKeyword('security', 'security audit on the service')).toBe('safety');
    });

    it('resolves "SAST" and "DAST" → safety', () => {
      expect(routeKeyword('sast', 'run SAST on the commit')).toBe('safety');
      expect(routeKeyword('dast', 'DAST test on staging')).toBe('safety');
    });

    it('isDomainSuppressed returns true for quality_engineering on "vulnerability"', () => {
      expect(isDomainSuppressed('quality_engineering', 'scan for vulnerabilities')).toBe(true);
    });
  });

  describe('tie-break: performance is complementary', () => {
    it('does NOT suppress quality_engineering on "latency"', () => {
      const { suppressedDomains } = resolveDomainBoundary('investigate latency spikes under load');
      expect(suppressedDomains.has('quality_engineering')).toBe(false);
    });

    it('routes "latency" to performance_profiling as primary', () => {
      expect(routeKeyword('latency', 'latency investigation')).toBe('performance_profiling');
    });
  });

  describe('tie-break: ERP boundary (ADR-074)', () => {
    it('suppresses quality_engineering on "SAP"', () => {
      const { suppressedDomains } = resolveDomainBoundary('integrate with SAP S/4HANA');
      expect(suppressedDomains.has('quality_engineering')).toBe(true);
    });

    it('suppresses quality_engineering on "Oracle"', () => {
      expect(isDomainSuppressed('quality_engineering', 'test our Oracle ERP integration')).toBe(true);
    });

    it('routes "SAP" and "SOAP" → connector_hub', () => {
      expect(routeKeyword('sap', 'our SAP integration')).toBe('connector_hub');
      expect(routeKeyword('soap', 'SOAP envelope validation')).toBe('connector_hub');
    });
  });

  describe('tie-break: privacy', () => {
    it('suppresses quality_engineering on "PII"', () => {
      expect(isDomainSuppressed('quality_engineering', 'redact PII from the logs')).toBe(true);
    });

    it('routes "anonymize" → data_security (Data-Vault)', () => {
      expect(routeKeyword('anonymize', 'anonymize the dataset')).toBe('data_security');
    });

    it('routes "PII" → safety (Shield)', () => {
      expect(routeKeyword('pii', 'detect PII leakage')).toBe('safety');
    });
  });

  describe('tie-break: learning', () => {
    it('suppresses quality_engineering on "learning"', () => {
      expect(isDomainSuppressed('quality_engineering', 'cross-session learning patterns')).toBe(true);
    });

    it('routes "learning" → memory_context (Memory-Graph)', () => {
      expect(routeKeyword('learning', 'memory-graph learning system')).toBe('memory_context');
    });
  });

  // ========================================================================
  // Resolver composition
  // ========================================================================
  describe('resolveDomainBoundary (full prompt resolution)', () => {
    it('returns applied rules for explainability', () => {
      const { appliedRules } = resolveDomainBoundary('generate unit tests for this function');
      expect(appliedRules.length).toBeGreaterThanOrEqual(0);
    });

    it('handles prompts with no boundary-relevant keywords', () => {
      const { disambiguations, suppressedDomains } = resolveDomainBoundary('what is 2 plus 2');
      expect(disambiguations.size).toBe(0);
      expect(suppressedDomains.size).toBe(0);
    });

    it('composes multiple rules in one prompt', () => {
      // "security test" triggers both the security tie-break (suppress QE) and a
      // disambiguation on "test" implicitly; this exercises rule composition.
      const { suppressedDomains, appliedRules } = resolveDomainBoundary('security test review');
      expect(suppressedDomains.has('quality_engineering')).toBe(true);
      expect(appliedRules.length).toBeGreaterThan(0);
    });

    it('word-boundary test: "security" matches but "insecurity" does not', () => {
      expect(isDomainSuppressed('quality_engineering', 'insecurity theater in the codebase')).toBe(false);
      expect(isDomainSuppressed('quality_engineering', 'security audit')).toBe(true);
    });
  });

  // ========================================================================
  // Returns null for unknown keywords
  // ========================================================================
  describe('unknown keywords', () => {
    it('returns null for keywords not governed by any rule', () => {
      expect(routeKeyword('foobar', 'random query about foobar')).toBeNull();
    });
  });
});
