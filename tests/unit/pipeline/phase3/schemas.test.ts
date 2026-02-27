/**
 * Phase 3 Schemas — Zod validation tests
 *
 * Tests that the Phase 2 on-disk schemas correctly validate real fixture data
 * and reject malformed inputs.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  Phase2ManifestOnDiskSchema,
  SPARCOnDiskSchema,
  ADRIndexOnDiskSchema,
  DomainModelOnDiskSchema,
  TDDPlanOnDiskSchema,
  Phase3ManifestSchema,
  LanguageResolutionSchema,
} from '../../../../src/pipeline/phase3/schemas.js';

// ============================================================================
// Fixture paths
// ============================================================================

const FIXTURE_DIR = path.resolve(
  __dirname,
  '../../../fixtures/phase3/run-fixture-001/phase2',
);

function readFixture(relativePath: string): unknown {
  const raw = fs.readFileSync(path.join(FIXTURE_DIR, relativePath), 'utf-8');
  return JSON.parse(raw);
}

// ============================================================================
// Tests
// ============================================================================

describe('Phase2ManifestOnDiskSchema', () => {
  it('should validate the real fixture phase2-manifest.json', () => {
    const data = readFixture('phase2-manifest.json');
    const result = Phase2ManifestOnDiskSchema.safeParse(data);
    expect(result.success).toBe(true);
  });

  it('should require schema_version', () => {
    const result = Phase2ManifestOnDiskSchema.safeParse({ trace_id: 't', artifacts: [], total_timing_ms: 0 });
    expect(result.success).toBe(false);
  });

  it('should require trace_id', () => {
    const result = Phase2ManifestOnDiskSchema.safeParse({ schema_version: '2.0.0', artifacts: [], total_timing_ms: 0 });
    expect(result.success).toBe(false);
  });

  it('should tolerate extra fields via passthrough', () => {
    const data = {
      schema_version: '2.0.0',
      trace_id: 'test',
      artifacts: [],
      total_timing_ms: 100,
      extra_field: 'should not fail',
      another: 42,
    };
    const result = Phase2ManifestOnDiskSchema.safeParse(data);
    expect(result.success).toBe(true);
  });
});

describe('SPARCOnDiskSchema', () => {
  it('should validate the real fixture sparc-combined.json', () => {
    const data = readFixture('sparc/sparc-combined.json');
    const result = SPARCOnDiskSchema.safeParse(data);
    expect(result.success).toBe(true);
  });

  it('should require specification section', () => {
    const result = SPARCOnDiskSchema.safeParse({
      pseudocode: { modules: [] },
      architecture: { services: [] },
      refinement: {},
      completion: {},
    });
    expect(result.success).toBe(false);
  });

  it('should require architecture.services array', () => {
    const data = {
      specification: { requirements: [], constraints: [], successCriteria: [] },
      pseudocode: { modules: [] },
      architecture: {},
      refinement: {},
      completion: {},
    };
    const result = SPARCOnDiskSchema.safeParse(data);
    expect(result.success).toBe(false);
  });
});

describe('ADRIndexOnDiskSchema', () => {
  it('should validate the real fixture adr-index.json', () => {
    const data = readFixture('adrs/adr-index.json');
    const result = ADRIndexOnDiskSchema.safeParse(data);
    expect(result.success).toBe(true);
  });

  it('should be an array', () => {
    const result = ADRIndexOnDiskSchema.safeParse({ id: 'ADR-001' });
    expect(result.success).toBe(false);
  });

  it('should require id and title on each record', () => {
    const result = ADRIndexOnDiskSchema.safeParse([
      { status: 'accepted', context: 'c', decision: 'd', alternatives: [], consequences: [], sparcSectionRefs: [], researchDossierItemRefs: [] },
    ]);
    expect(result.success).toBe(false);
  });
});

describe('DomainModelOnDiskSchema', () => {
  it('should validate the real fixture domain-model.json', () => {
    const data = readFixture('ddd/domain-model.json');
    const result = DomainModelOnDiskSchema.safeParse(data);
    expect(result.success).toBe(true);
  });

  it('should require contexts array', () => {
    const result = DomainModelOnDiskSchema.safeParse({ contextMap: [] });
    expect(result.success).toBe(false);
  });

  it('should require contextMap array', () => {
    const result = DomainModelOnDiskSchema.safeParse({ contexts: [] });
    expect(result.success).toBe(false);
  });
});

describe('TDDPlanOnDiskSchema', () => {
  it('should validate the real fixture tdd-plan.json', () => {
    const data = readFixture('tdd/tdd-plan.json');
    const result = TDDPlanOnDiskSchema.safeParse(data);
    expect(result.success).toBe(true);
  });

  it('should require approach', () => {
    const result = TDDPlanOnDiskSchema.safeParse({
      testPyramid: {},
      testSuites: [],
      mockContracts: [],
      seamDefinitions: [],
      executionOrder: [],
    });
    expect(result.success).toBe(false);
  });

  it('should require testSuites array', () => {
    const result = TDDPlanOnDiskSchema.safeParse({
      approach: 'london-school',
      testPyramid: {},
      mockContracts: [],
      seamDefinitions: [],
      executionOrder: [],
    });
    expect(result.success).toBe(false);
  });
});

describe('Phase3ManifestSchema', () => {
  it('should validate a well-formed Phase 3 manifest', () => {
    const manifest = {
      schema_version: '3.0.0',
      trace_id: 'test-trace',
      implementation_language: 'typescript',
      mixed_mode: false,
      ruflo_version: 'N/A',
      artifacts: [
        { path: 'project/package.json', sha256: 'a'.repeat(64), size_bytes: 100 },
      ],
      total_timing_ms: 5000,
      success: true,
    };
    const result = Phase3ManifestSchema.safeParse(manifest);
    expect(result.success).toBe(true);
  });

  it('should reject schema_version other than 3.0.0', () => {
    const manifest = {
      schema_version: '2.0.0',
      trace_id: 'test',
      implementation_language: 'typescript',
      mixed_mode: false,
      ruflo_version: 'N/A',
      artifacts: [],
      total_timing_ms: 0,
      success: true,
    };
    const result = Phase3ManifestSchema.safeParse(manifest);
    expect(result.success).toBe(false);
  });

  it('should reject invalid implementation_language', () => {
    const manifest = {
      schema_version: '3.0.0',
      trace_id: 'test',
      implementation_language: 'python',
      mixed_mode: false,
      ruflo_version: 'N/A',
      artifacts: [],
      total_timing_ms: 0,
      success: true,
    };
    const result = Phase3ManifestSchema.safeParse(manifest);
    expect(result.success).toBe(false);
  });

  it('should reject mixed_mode: true', () => {
    const manifest = {
      schema_version: '3.0.0',
      trace_id: 'test',
      implementation_language: 'typescript',
      mixed_mode: true,
      ruflo_version: 'N/A',
      artifacts: [],
      total_timing_ms: 0,
      success: true,
    };
    const result = Phase3ManifestSchema.safeParse(manifest);
    expect(result.success).toBe(false);
  });
});

describe('LanguageResolutionSchema', () => {
  it('should validate a well-formed resolution', () => {
    const resolution = {
      language: 'typescript',
      mixed_mode: false,
      rationale: 'TypeScript wins',
      signals: [
        {
          name: 'tech-stack',
          source: 'query',
          favors: 'typescript',
          weight: 0.5,
          score: 0.25,
          confidence: 0.5,
          evidence: 'SAP mentioned',
        },
      ],
      typescript_score: 0.25,
      rust_score: 0.0,
    };
    const result = LanguageResolutionSchema.safeParse(resolution);
    expect(result.success).toBe(true);
  });

  it('should reject invalid language values', () => {
    const resolution = {
      language: 'python',
      mixed_mode: false,
      rationale: 'test',
      signals: [],
      typescript_score: 0,
      rust_score: 0,
    };
    const result = LanguageResolutionSchema.safeParse(resolution);
    expect(result.success).toBe(false);
  });
});
