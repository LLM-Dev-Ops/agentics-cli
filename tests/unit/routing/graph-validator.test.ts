/**
 * Tests for the Graph Validator (ADR-031 Phase 5)
 */

import * as path from 'node:path';
import {
  validateTier1,
  formatValidationReport,
} from '../../../src/routing/graph-validator.js';
import { clearGraphCache } from '../../../src/routing/graph-loader.js';

// ============================================================================
// Tests
// ============================================================================

describe('Graph Validator', () => {
  afterEach(() => {
    clearGraphCache();
  });

  describe('validateTier1', () => {
    it('validates production graph successfully', () => {
      const projectRoot = path.resolve(process.cwd());
      const graphPath = path.join(projectRoot, 'docs', 'ecosystem.graph.json');

      const report = validateTier1(graphPath);

      expect(report.tier).toBe('offline');
      expect(report.failed).toBe(0);
      expect(report.passed).toBeGreaterThan(0);
    });

    it('fails for nonexistent graph', () => {
      const report = validateTier1('/nonexistent/path.json');

      expect(report.failed).toBeGreaterThan(0);
      expect(report.results[0]!.passed).toBe(false);
    });

    it('reports all rule results', () => {
      const projectRoot = path.resolve(process.cwd());
      const graphPath = path.join(projectRoot, 'docs', 'ecosystem.graph.json');

      const report = validateTier1(graphPath);

      const ruleNames = report.results.map(r => r.rule);
      expect(ruleNames).toContain('Schema validation');
      expect(ruleNames).toContain('Unique capability names');
      expect(ruleNames).toContain('Non-empty agents');
      expect(ruleNames).toContain('Non-empty repos');
      expect(ruleNames).toContain('Valid stage references');
      expect(ruleNames).toContain('No circular dependencies');
      expect(ruleNames).toContain('Weight bounds');
    });
  });

  describe('formatValidationReport', () => {
    it('formats passing report', () => {
      const projectRoot = path.resolve(process.cwd());
      const graphPath = path.join(projectRoot, 'docs', 'ecosystem.graph.json');

      const report = validateTier1(graphPath);
      const formatted = formatValidationReport(report);

      expect(formatted).toContain('Capability Graph Validation');
      expect(formatted).toContain('Tier 1: Offline');
      expect(formatted).toContain('[PASS]');
      expect(formatted).toContain('Result:');
    });

    it('formats failing report with details', () => {
      const report = validateTier1('/nonexistent/path.json');
      const formatted = formatValidationReport(report);

      expect(formatted).toContain('[FAIL]');
    });
  });
});
