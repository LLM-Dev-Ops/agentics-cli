/**
 * Language Resolver — Pure function unit tests
 *
 * Tests the deterministic language resolution algorithm that scores
 * signals from Phase 2 artifacts to decide between Rust and TypeScript.
 */

import { resolveLanguage } from '../../../../src/pipeline/phase3/phases/language-resolver.js';
import type {
  Phase2SPARCOutput,
  Phase2ADRRecord,
  Phase2DomainModel,
} from '../../../../src/pipeline/phase2/types.js';

// ============================================================================
// Minimal fixture builders
// ============================================================================

function buildMinimalSPARC(overrides?: Partial<Phase2SPARCOutput>): Phase2SPARCOutput {
  return {
    specification: {
      scope: '',
      requirements: [],
      constraints: [],
      successCriteria: [],
      dossierCoverage: 0,
    },
    pseudocode: {
      modules: [],
    },
    architecture: {
      services: [],
      boundaries: [],
      dataFlow: '',
      securityBoundaries: [],
      apiContracts: [],
    },
    refinement: {
      performanceTargets: [],
      securityConsiderations: [],
      testStrategy: '',
    },
    completion: {
      integrationPlan: '',
      documentation: [],
      monitoringSetup: [],
    },
    ...overrides,
  };
}

function buildMinimalADR(overrides?: Partial<Phase2ADRRecord>): Phase2ADRRecord {
  return {
    id: 'ADR-001',
    title: 'Test ADR',
    status: 'accepted',
    date: '2025-01-01',
    context: 'Test context',
    decision: 'Test decision',
    alternatives: [],
    consequences: [],
    sparcSectionRefs: ['architecture'],
    researchDossierItemRefs: ['RD-001'],
    ...overrides,
  };
}

function buildMinimalDDD(overrides?: Partial<Phase2DomainModel>): Phase2DomainModel {
  return {
    contexts: [{
      name: 'TestContext',
      description: 'A test bounded context',
      aggregates: [{
        name: 'TestAggregate',
        root: 'TestRoot',
        entities: [],
        valueObjects: [],
        invariants: [],
      }],
      commands: [{ name: 'TestCommand', description: '', input: [], preconditions: [], postconditions: [] }],
      queries: [{ name: 'TestQuery', description: '', parameters: [], returns: '' }],
      domainEvents: [{ name: 'TestEvent', description: '', payload: [], triggeredBy: 'TestCommand' }],
      ubiquitousLanguage: [{ term: 'Test', definition: 'A test thing', context: 'TestContext', aliases: [] }],
      adrRefs: [],
    }],
    contextMap: [],
    ubiquitousLanguageGlossary: [],
    ...overrides,
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('resolveLanguage', () => {

  // ========================================================================
  // Explicit language mention
  // ========================================================================

  describe('explicit language mention', () => {
    it('should resolve to Rust when query mentions "rust"', () => {
      const result = resolveLanguage(
        buildMinimalSPARC(),
        [],
        buildMinimalDDD(),
        'Build a high-performance Rust service',
      );
      expect(result.language).toBe('rust');
    });

    it('should resolve to TypeScript when query mentions "typescript"', () => {
      const result = resolveLanguage(
        buildMinimalSPARC(),
        [],
        buildMinimalDDD(),
        'Build a TypeScript API service',
      );
      expect(result.language).toBe('typescript');
    });

    it('should prefer the first-mentioned language when both appear', () => {
      const result = resolveLanguage(
        buildMinimalSPARC(),
        [],
        buildMinimalDDD(),
        'Compare Rust and TypeScript implementations',
      );
      expect(result.language).toBe('rust');
    });

    it('should override scoring when explicit mention is present', () => {
      // Even with heavy TS signals, explicit "rust" should win
      const sparc = buildMinimalSPARC({
        architecture: {
          services: [
            { id: 's1', name: 'api-gateway', responsibility: 'REST integration', api: [], dependencies: [], dossierItemRefs: [] },
            { id: 's2', name: 'data-adapter', responsibility: 'ETL pipeline', api: [], dependencies: [], dossierItemRefs: [] },
          ],
          boundaries: [],
          dataFlow: '',
          securityBoundaries: [],
          apiContracts: Array.from({ length: 15 }, (_, i) => `contract-${i}`),
        },
      });
      const result = resolveLanguage(sparc, [], buildMinimalDDD(), 'Implement in Rust');
      expect(result.language).toBe('rust');
    });
  });

  // ========================================================================
  // TypeScript-favoring signals
  // ========================================================================

  describe('TypeScript-favoring signals', () => {
    it('should favor TypeScript for integration-heavy architectures', () => {
      const sparc = buildMinimalSPARC({
        architecture: {
          services: [
            { id: 's1', name: 'api-gateway', responsibility: 'Gateway', api: [], dependencies: [], dossierItemRefs: [] },
            { id: 's2', name: 'data-adapter', responsibility: 'Adapter', api: [], dependencies: [], dossierItemRefs: [] },
            { id: 's3', name: 'connector-hub', responsibility: 'Integration', api: [], dependencies: [], dossierItemRefs: [] },
            { id: 's4', name: 'event-gateway', responsibility: 'Events', api: [], dependencies: [], dossierItemRefs: [] },
          ],
          boundaries: [],
          dataFlow: '',
          securityBoundaries: [],
          apiContracts: [],
        },
      });
      const result = resolveLanguage(sparc, [], buildMinimalDDD(), 'Enterprise data integration');
      expect(result.language).toBe('typescript');
    });

    it('should favor TypeScript for IO-bound pipeline scenarios', () => {
      const sparc = buildMinimalSPARC({
        architecture: {
          services: [
            { id: 's1', name: 'etl-service', responsibility: 'ETL pipeline for data extraction and reporting', api: [], dependencies: [], dossierItemRefs: [] },
          ],
          boundaries: [],
          dataFlow: '',
          securityBoundaries: [],
          apiContracts: [],
        },
      });
      const result = resolveLanguage(sparc, [], buildMinimalDDD(), 'Build a data ingestion pipeline');
      expect(result.language).toBe('typescript');
    });

    it('should favor TypeScript for heavy API surface', () => {
      const sparc = buildMinimalSPARC({
        architecture: {
          services: [{ id: 's1', name: 'core', responsibility: 'Core service', api: [], dependencies: [], dossierItemRefs: [] }],
          boundaries: [],
          dataFlow: '',
          securityBoundaries: [],
          apiContracts: Array.from({ length: 15 }, (_, i) => `contract-${i}`),
        },
      });
      const result = resolveLanguage(sparc, [], buildMinimalDDD(), 'Build service');
      expect(result.language).toBe('typescript');
    });

    it('should favor TypeScript for technology stack affinity', () => {
      const result = resolveLanguage(
        buildMinimalSPARC(),
        [],
        buildMinimalDDD(),
        'Connect SAP, Oracle, NetSuite, BigQuery, Snowflake via REST, GraphQL, webhook, SFTP across AWS, GCP, Azure cloud',
      );
      // Saturated tech-stack signal must beat the 0.3 rust-default baseline.
      expect(result.language).toBe('typescript');
    });
  });

  // ========================================================================
  // Rust-favoring signals
  // ========================================================================

  describe('Rust-favoring signals', () => {
    it('should favor Rust for performance-critical targets', () => {
      const sparc = buildMinimalSPARC({
        refinement: {
          performanceTargets: [
            { id: 'pt1', text: 'Response latency must be < 10ms for all queries', dossierItemRefs: [] },
            { id: 'pt2', text: 'Throughput must exceed > 10K/s under peak load', dossierItemRefs: [] },
          ],
          securityConsiderations: [],
          testStrategy: '',
        },
      });
      const result = resolveLanguage(sparc, [], buildMinimalDDD(), 'Build kernel');
      expect(result.language).toBe('rust');
    });

    it('should favor Rust for concurrency requirements', () => {
      const sparc = buildMinimalSPARC({
        refinement: {
          performanceTargets: [
            { id: 'pt1', text: 'Must support concurrent processing of 1000 tasks', dossierItemRefs: [] },
          ],
          securityConsiderations: [
            { id: 'sc1', text: 'Lock-free data structures required for parallel access', dossierItemRefs: [] },
          ],
          testStrategy: '',
        },
      });
      const result = resolveLanguage(sparc, [], buildMinimalDDD(), 'Build kernel');
      expect(result.language).toBe('rust');
    });

    it('should favor Rust for memory safety requirements', () => {
      const adrs = [
        buildMinimalADR({ context: 'Memory safety is critical for buffer overflow prevention', decision: 'Use zero-copy parsing' }),
      ];
      const result = resolveLanguage(buildMinimalSPARC(), adrs, buildMinimalDDD(), 'Build kernel');
      expect(result.language).toBe('rust');
    });

    it('should favor Rust for cryptographic operations', () => {
      const adrs = [
        buildMinimalADR({ context: 'Cryptographic signing required', decision: 'Implement encryption at rest' }),
      ];
      const result = resolveLanguage(buildMinimalSPARC(), adrs, buildMinimalDDD(), 'Build kernel');
      expect(result.language).toBe('rust');
    });
  });

  // ========================================================================
  // Edge cases
  // ========================================================================

  describe('edge cases', () => {
    it('resolves to rust by default when no other signals are detected', () => {
      // The resolver injects a rust-default-preference baseline signal, so the
      // no-signal case resolves to rust rather than throwing ECLI-P3-005.
      const result = resolveLanguage(buildMinimalSPARC(), [], buildMinimalDDD(), '');
      expect(result.language).toBe('rust');
      expect(result.signals.some((s) => s.name === 'rust-default-preference')).toBe(true);
    });

    it('should always set mixed_mode to false', () => {
      const result = resolveLanguage(
        buildMinimalSPARC(),
        [],
        buildMinimalDDD(),
        'Build a TypeScript service',
      );
      expect(result.mixed_mode).toBe(false);
    });

    it('should return signals array with valid structure', () => {
      const result = resolveLanguage(
        buildMinimalSPARC(),
        [],
        buildMinimalDDD(),
        'Build a TypeScript service',
      );

      for (const signal of result.signals) {
        expect(signal).toHaveProperty('name');
        expect(signal).toHaveProperty('source');
        expect(signal).toHaveProperty('favors');
        expect(signal).toHaveProperty('weight');
        expect(signal).toHaveProperty('score');
        expect(signal).toHaveProperty('confidence');
        expect(signal).toHaveProperty('evidence');
        expect(['rust', 'typescript']).toContain(signal.favors);
        expect(signal.weight).toBeGreaterThanOrEqual(0);
        expect(signal.weight).toBeLessThanOrEqual(1);
      }
    });

    it('should prefer TypeScript on tie', () => {
      // Create signals that exactly balance
      const sparc = buildMinimalSPARC({
        refinement: {
          performanceTargets: [
            { id: 'pt1', text: 'Must handle data extraction pipeline efficiently', dossierItemRefs: [] },
          ],
          securityConsiderations: [
            { id: 'sc1', text: 'Must support concurrent processing', dossierItemRefs: [] },
          ],
          testStrategy: '',
        },
        architecture: {
          services: [
            { id: 's1', name: 'integration-gateway', responsibility: 'gateway for ETL pipeline', api: [], dependencies: [], dossierItemRefs: [] },
          ],
          boundaries: [],
          dataFlow: '',
          securityBoundaries: [],
          apiContracts: [],
        },
      });

      const result = resolveLanguage(sparc, [], buildMinimalDDD(), 'Build service');
      // TypeScript should win on ties
      expect(result.language).toBe('typescript');
    });
  });

  // ========================================================================
  // Sustainability fixture (the real Phase 3 test fixture)
  // ========================================================================

  describe('sustainability fixture', () => {
    it('should resolve to TypeScript for the full sustainability scenario', () => {
      // The sustainability fixture is integration/IO-heavy with SAP/BigQuery stack
      const result = resolveLanguage(
        buildMinimalSPARC({
          architecture: {
            services: [
              { id: 's1', name: 'supplier-data-ingestion-gateway', responsibility: 'Extraction and ingestion of supplier data via SAP BAPI', api: [], dependencies: [], dossierItemRefs: [] },
              { id: 's2', name: 'data-quality-adapter', responsibility: 'Data normalization and quality pipeline', api: [], dependencies: [], dossierItemRefs: [] },
              { id: 's3', name: 'emissions-calculation-engine', responsibility: 'GHG Protocol Scope 3 calculations', api: [], dependencies: [], dossierItemRefs: [] },
              { id: 's4', name: 'regulatory-reporting-connector', responsibility: 'CSRD compliance reporting generation', api: [], dependencies: [], dossierItemRefs: [] },
            ],
            boundaries: [],
            dataFlow: '',
            securityBoundaries: ['EU data residency boundary'],
            apiContracts: Array.from({ length: 12 }, (_, i) => `contract-${i}`),
          },
        }),
        [],
        buildMinimalDDD({
          contexts: [
            {
              name: 'Supplier Data Integration',
              description: 'Data ingestion from ERP',
              aggregates: [{ name: 'SupplierProfile', root: 'SupplierProfile', entities: [], valueObjects: [], invariants: [] }],
              commands: [{ name: 'IngestSupplierData', description: '', input: [], preconditions: [], postconditions: [] }],
              queries: [{ name: 'GetSupplierProfile', description: '', parameters: [], returns: '' }],
              domainEvents: [{ name: 'SupplierDataIngested', description: '', payload: [], triggeredBy: 'IngestSupplierData' }],
              ubiquitousLanguage: [],
              adrRefs: [],
            },
          ],
        }),
        'Implement Scope 3 supplier carbon emissions extraction and reporting pipeline for a global manufacturing enterprise with 2,400 tier-1 suppliers across 14 countries',
      );

      expect(result.language).toBe('typescript');
      expect(result.typescript_score).toBeGreaterThan(result.rust_score);
    });
  });
});
