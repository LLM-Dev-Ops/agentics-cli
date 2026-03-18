/**
 * Code Resolver — Unit Tests (ADR-039)
 */

import {
  resolveCodeProvenance,
  resolveCodeProvenanceBatch,
  resolveGitCommit,
  resolveCLIVersion,
  clearResolverCache,
  detectVersionDiscrepancies,
  getPackageForDomain,
  getAllDomainPackages,
} from '../../../../src/pipeline/enterprise/code-resolver.js';
import type { AgentRef } from '../../../../src/pipeline/enterprise/types.js';

describe('Code Resolver (ADR-039)', () => {

  beforeEach(() => {
    clearResolverCache();
  });

  describe('resolveCodeProvenance', () => {
    test('resolves known domain to correct package', () => {
      const prov = resolveCodeProvenance({ domain: 'costops', agent: 'roi', role: 'ROI' });
      expect(prov.package).toBe('@agentics/costops');
    });

    test('resolves unknown domain to @agentics/{domain}', () => {
      const prov = resolveCodeProvenance({ domain: 'custom-domain', agent: 'x', role: 'X' });
      expect(prov.package).toBe('@agentics/custom-domain');
    });

    test('resolves pipeline domain to CLI package', () => {
      const prov = resolveCodeProvenance({ domain: 'pipeline', agent: 'orchestrator', role: 'Orch' });
      expect(prov.package).toBe('@llm-dev-ops/agentics-cli');
      expect(prov.entryPoint).toContain('pipeline/enterprise');
    });

    test('sets entry point based on domain/agent', () => {
      const prov = resolveCodeProvenance({ domain: 'shield', agent: 'pii', role: 'PII' });
      expect(prov.entryPoint).toBe('src/agents/shield/pii.ts');
    });

    test('includes git commit hash', () => {
      const prov = resolveCodeProvenance({ domain: 'costops', agent: 'roi', role: 'ROI' });
      expect(prov.commitHash).toBeTruthy();
      expect(typeof prov.commitHash).toBe('string');
    });

    test('includes version', () => {
      const prov = resolveCodeProvenance({ domain: 'costops', agent: 'roi', role: 'ROI' });
      expect(prov.version).toBeTruthy();
    });

    test('includes repository URL', () => {
      const prov = resolveCodeProvenance({ domain: 'costops', agent: 'roi', role: 'ROI' });
      expect(prov.repository).toContain('github.com');
    });

    test('includes dependencies for known domains', () => {
      const prov = resolveCodeProvenance({ domain: 'shield', agent: 'pii', role: 'PII' });
      expect(prov.dependencies.length).toBeGreaterThan(0);
    });
  });

  describe('resolveCodeProvenanceBatch', () => {
    test('resolves multiple agents', () => {
      const agents: AgentRef[] = [
        { domain: 'costops', agent: 'roi', role: 'ROI' },
        { domain: 'shield', agent: 'pii', role: 'PII' },
        { domain: 'costops', agent: 'forecast', role: 'Forecast' },
      ];
      const batch = resolveCodeProvenanceBatch(agents);
      expect(batch.size).toBe(3);
      expect(batch.has('costops/roi')).toBe(true);
      expect(batch.has('shield/pii')).toBe(true);
    });

    test('deduplicates identical agent keys', () => {
      const agents: AgentRef[] = [
        { domain: 'costops', agent: 'roi', role: 'ROI' },
        { domain: 'costops', agent: 'roi', role: 'ROI Duplicate' },
      ];
      const batch = resolveCodeProvenanceBatch(agents);
      expect(batch.size).toBe(1);
    });
  });

  describe('resolveGitCommit', () => {
    test('returns a string', () => {
      const commit = resolveGitCommit();
      expect(typeof commit).toBe('string');
      expect(commit.length).toBeGreaterThan(0);
    });

    test('caches the result', () => {
      const first = resolveGitCommit();
      const second = resolveGitCommit();
      expect(first).toBe(second);
    });
  });

  describe('resolveCLIVersion', () => {
    test('returns a version string', () => {
      const version = resolveCLIVersion();
      expect(typeof version).toBe('string');
    });
  });

  describe('detectVersionDiscrepancies', () => {
    test('returns empty for consistent versions', () => {
      const provs = new Map([
        ['costops/roi', resolveCodeProvenance({ domain: 'costops', agent: 'roi', role: 'R' })],
        ['costops/forecast', resolveCodeProvenance({ domain: 'costops', agent: 'forecast', role: 'F' })],
      ]);
      const discrepancies = detectVersionDiscrepancies(provs);
      // Same package, same version → no discrepancies
      expect(discrepancies).toHaveLength(0);
    });
  });

  describe('getPackageForDomain', () => {
    test('returns known package for known domain', () => {
      expect(getPackageForDomain('costops')).toBe('@agentics/costops');
      expect(getPackageForDomain('shield')).toBe('@agentics/shield');
      expect(getPackageForDomain('platform')).toBe('@agentics/platform');
    });

    test('returns convention-based package for unknown domain', () => {
      expect(getPackageForDomain('unknown-domain')).toBe('@agentics/unknown-domain');
    });
  });

  describe('getAllDomainPackages', () => {
    test('returns all domain mappings', () => {
      const all = getAllDomainPackages();
      expect(Object.keys(all).length).toBeGreaterThanOrEqual(27);
      expect(all['costops']).toBe('@agentics/costops');
      expect(all['pipeline']).toBe('@llm-dev-ops/agentics-cli');
    });
  });
});
