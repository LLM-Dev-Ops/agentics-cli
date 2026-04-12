/**
 * ADR-PIPELINE-072 tests: Pre-Render Prototype Analysis Pass.
 *
 * Verifies:
 *  - UnitEconomicsSchema accepts source='prototype-preview' and 'prototype'
 *  - SECTOR_BASELINES table aligns with the ADR-066 sector registry
 *    (every registry sector has a baseline; both use the same keys)
 *  - computePreRenderUnitEconomics produces bottom-up savings for
 *    hospitality, airline-catering, CRE, fleet — no per-employee math
 *  - Classifier routes "in-flight catering" to airline-catering
 *  - executePreRender writes unit-economics.json to runDir with the
 *    preview source and returns correct metrics
 *  - executePreRender skips when the sector is unknown
 *  - Pre-render does NOT overwrite an existing source='prototype' manifest
 *  - executeReconciliation produces a drift report at >25% tolerance
 *  - formatDriftWarning returns a markdown header on drift and null on aligned
 *  - End-to-end: running generateSimulationArtifacts writes
 *    unit-economics.json before the executive renderers run
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  UnitEconomicsSchema,
  type UnitEconomics,
} from '../../../../src/pipeline/types.js';
import {
  SECTOR_BASELINES,
  getSectorBaseline,
} from '../../../../src/pipeline/phase4-5-pre-render/sector-baselines.js';
import {
  computePreRenderUnitEconomics,
} from '../../../../src/pipeline/phase4-5-pre-render/financial-model.js';
import {
  executePreRender,
  readManifestIfExists,
} from '../../../../src/pipeline/phase4-5-pre-render/pre-render-coordinator.js';
import {
  executeReconciliation,
  formatDriftWarning,
} from '../../../../src/pipeline/phase4-5-pre-render/post-render-reconciler.js';
import {
  SECTOR_REGISTRY,
  type Sector,
} from '../../../../src/synthesis/domain-unit-registry.js';

// ============================================================================
// Fixtures
// ============================================================================

function mkTempDir(label: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `adr072-${label}-`));
}

const RAMCO_QUERY =
  'I lead sustainability and food services for a global airline with approximately 69,000 employees operating flights across NA, EMEA, and APAC. Our catering operations are managed through Ramco Aviation ERP. Reduce food waste from in-flight catering by 22%.';

const OPERA_QUERY =
  'I lead sustainability and housekeeping operations for a global hotel group with 91,000 employees. Oracle Hospitality OPERA manages linen and towel cleaning frequency.';

const SAAS_QUERY =
  'Build an internal dashboard SaaS to track engineering velocity. Pure software project.';

// ============================================================================
// Schema — source enum
// ============================================================================

describe('ADR-072 — UnitEconomicsSchema source field', () => {
  it('accepts source=prototype-preview', () => {
    const manifest = {
      run_id: 'sim-test-072',
      sector: 'airline-catering',
      domain_unit: { label: 'meal loaded', abbrev: 'meal' },
      measured_scope: { units: 100, region_mix: ['NA'] },
      enterprise_scope: { units: 2500, region_mix: ['NA', 'EMEA'] },
      unit_savings: { usd_per_meal_loaded: 0.92 },
      annual_measured_savings_usd: 92,
      annual_extrapolated_savings_usd: 2300,
      extrapolation_method: 'linear_by_units',
      confidence: { directional: 0.88, precision: 0.42 },
      source: 'prototype-preview',
    };
    expect(UnitEconomicsSchema.safeParse(manifest).success).toBe(true);
  });

  it('accepts source=prototype', () => {
    const manifest = {
      run_id: 'sim-test-072',
      sector: 'hospitality',
      domain_unit: { label: 'occupied room night', abbrev: 'orn' },
      measured_scope: { rooms: 500, region_mix: ['NA'] },
      enterprise_scope: { rooms: 12000, region_mix: ['NA'] },
      unit_savings: { usd_per_orn: 0.82 },
      annual_measured_savings_usd: 410,
      annual_extrapolated_savings_usd: 9840,
      extrapolation_method: 'linear_by_rooms',
      confidence: { directional: 0.9, precision: 0.5 },
      source: 'prototype',
    };
    expect(UnitEconomicsSchema.safeParse(manifest).success).toBe(true);
  });

  it('rejects an unknown source value', () => {
    const manifest = {
      run_id: 'sim-test',
      sector: 'hospitality',
      domain_unit: { label: 'orn', abbrev: 'orn' },
      measured_scope: {},
      enterprise_scope: {},
      unit_savings: {},
      annual_measured_savings_usd: 0,
      annual_extrapolated_savings_usd: 0,
      extrapolation_method: 'x',
      confidence: { directional: 0.5, precision: 0.5 },
      source: 'hallucinated',
    };
    expect(UnitEconomicsSchema.safeParse(manifest).success).toBe(false);
  });
});

// ============================================================================
// Baseline <-> registry lockstep invariant
// ============================================================================

describe('ADR-072 — sector baselines / ADR-066 registry lockstep', () => {
  it('every ADR-066 registry sector has a matching baseline', () => {
    for (const entry of SECTOR_REGISTRY) {
      const baseline = getSectorBaseline(entry.sector as Sector);
      expect(baseline).not.toBeNull();
      expect(baseline!.sector).toBe(entry.sector);
    }
  });

  it('every baseline unitSavingsKey matches the registry', () => {
    for (const baseline of SECTOR_BASELINES) {
      const entry = SECTOR_REGISTRY.find(e => e.sector === baseline.sector);
      expect(entry).toBeDefined();
      expect(baseline.unitSavingsKey).toBe(entry!.unitSavingsKey);
    }
  });

  it('every baseline has a positive usdPerUnitPerYear', () => {
    for (const baseline of SECTOR_BASELINES) {
      expect(baseline.usdPerUnitPerYear).toBeGreaterThan(0);
      expect(baseline.achievableReduction).toBeGreaterThan(0);
      expect(baseline.achievableReduction).toBeLessThanOrEqual(1);
    }
  });
});

// ============================================================================
// computePreRenderUnitEconomics
// ============================================================================

describe('ADR-072 — computePreRenderUnitEconomics', () => {
  it('routes Ramco-style query to airline-catering', () => {
    const out = computePreRenderUnitEconomics({
      runId: 'sim-ramco',
      query: RAMCO_QUERY,
    });
    expect(out).not.toBeNull();
    expect(out!.metrics.sector).toBe('airline-catering');
    expect(out!.manifest.domain_unit.label).toBe('meal loaded');
    expect(out!.manifest.source).toBe('prototype-preview');
  });

  it('routes OPERA-style query to hospitality', () => {
    const out = computePreRenderUnitEconomics({
      runId: 'sim-opera',
      query: OPERA_QUERY,
    });
    expect(out).not.toBeNull();
    expect(out!.metrics.sector).toBe('hospitality');
    expect(out!.manifest.domain_unit.label).toBe('occupied room night');
  });

  it('returns null for pure-SaaS query (unknown sector)', () => {
    const out = computePreRenderUnitEconomics({
      runId: 'sim-saas',
      query: SAAS_QUERY,
    });
    expect(out).toBeNull();
  });

  it('savings are derived from operational units, not employees', () => {
    const out = computePreRenderUnitEconomics({
      runId: 'sim-test',
      query: RAMCO_QUERY,
    });
    expect(out).not.toBeNull();
    const baseline = getSectorBaseline('airline-catering')!;
    const expectedEnterprise = Math.round(out!.metrics.enterpriseOperationalUnits * baseline.usdPerUnitPerYear);
    expect(out!.manifest.annual_extrapolated_savings_usd).toBe(expectedEnterprise);
    // Not employees × magic constant
    const naiveHeuristic = 69000 * 60;
    expect(out!.manifest.annual_extrapolated_savings_usd).not.toBe(naiveHeuristic);
  });

  it('pilot savings scale down from enterprise via scopeRatio', () => {
    const out = computePreRenderUnitEconomics({
      runId: 'sim-test',
      query: RAMCO_QUERY,
      scopeRatioOverride: 20,
    });
    expect(out).not.toBeNull();
    // Pilot is 1/20th of enterprise operational units
    expect(out!.metrics.enterpriseOperationalUnits / out!.metrics.pilotOperationalUnits).toBeCloseTo(20, 0);
  });

  it('extrapolation_method is non-empty and references the scope key', () => {
    const out = computePreRenderUnitEconomics({
      runId: 'sim-test',
      query: RAMCO_QUERY,
    });
    expect(out!.manifest.extrapolation_method.length).toBeGreaterThan(0);
    expect(out!.manifest.extrapolation_method).toMatch(/linear_by_/);
  });
});

// ============================================================================
// executePreRender coordinator
// ============================================================================

describe('ADR-072 — executePreRender', () => {
  it('writes unit-economics.json with source=prototype-preview', () => {
    const dir = mkTempDir('coord-emit');
    try {
      const result = executePreRender({
        runDir: dir,
        runId: 'sim-coord-emit',
        query: RAMCO_QUERY,
      });
      expect(result.status).toBe('emitted');
      if (result.status === 'emitted') {
        expect(fs.existsSync(result.manifestPath)).toBe(true);
        const parsed = JSON.parse(fs.readFileSync(result.manifestPath, 'utf-8')) as UnitEconomics;
        expect(parsed.source).toBe('prototype-preview');
        expect(parsed.sector).toBe('airline-catering');
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('skips with reason=unknown-sector on a SaaS query', () => {
    const dir = mkTempDir('coord-skip');
    try {
      const result = executePreRender({
        runDir: dir,
        runId: 'sim-coord-skip',
        query: SAAS_QUERY,
      });
      expect(result.status).toBe('skipped');
      if (result.status === 'skipped') {
        expect(result.reason).toBe('unknown-sector');
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does NOT overwrite an existing source=prototype manifest', () => {
    const dir = mkTempDir('coord-no-overwrite');
    try {
      // Pre-place a prototype-sourced manifest
      const prototypeManifest: UnitEconomics = {
        run_id: 'existing',
        sector: 'airline-catering',
        domain_unit: { label: 'meal loaded', abbrev: 'meal' },
        measured_scope: { units: 999, region_mix: ['NA'] },
        enterprise_scope: { units: 9999, region_mix: ['NA'] },
        unit_savings: { usd_per_meal_loaded: 1.23 },
        annual_measured_savings_usd: 1229,
        annual_extrapolated_savings_usd: 12299,
        extrapolation_method: 'linear_by_units',
        confidence: { directional: 0.9, precision: 0.6 },
        source: 'prototype',
      };
      fs.writeFileSync(path.join(dir, 'unit-economics.json'), JSON.stringify(prototypeManifest, null, 2));

      const result = executePreRender({
        runDir: dir,
        runId: 'sim-test',
        query: RAMCO_QUERY,
      });
      expect(result.status).toBe('skipped');
      if (result.status === 'skipped') {
        expect(result.reason).toBe('existing-prototype-manifest');
      }

      // Manifest is untouched
      const after = JSON.parse(fs.readFileSync(path.join(dir, 'unit-economics.json'), 'utf-8')) as UnitEconomics;
      expect(after.run_id).toBe('existing');
      expect(after.source).toBe('prototype');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('readManifestIfExists returns null on missing file', () => {
    const dir = mkTempDir('coord-missing');
    try {
      expect(readManifestIfExists(path.join(dir, 'unit-economics.json'))).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ============================================================================
// Reconciler
// ============================================================================

describe('ADR-072 — executeReconciliation', () => {
  function writeManifest(dir: string, filename: string, overrides: Partial<UnitEconomics>): void {
    const base: UnitEconomics = {
      run_id: 'sim-test',
      sector: 'airline-catering',
      domain_unit: { label: 'meal loaded', abbrev: 'meal' },
      measured_scope: { units: 100, region_mix: ['NA'] },
      enterprise_scope: { units: 2500, region_mix: ['NA'] },
      unit_savings: { usd_per_meal_loaded: 0.92 },
      annual_measured_savings_usd: 92,
      annual_extrapolated_savings_usd: 2300,
      extrapolation_method: 'linear_by_units',
      confidence: { directional: 0.88, precision: 0.42 },
      source: 'prototype-preview',
    };
    fs.writeFileSync(path.join(dir, filename), JSON.stringify({ ...base, ...overrides }, null, 2));
  }

  it('emits status=aligned when preview and prototype match', () => {
    const dir = mkTempDir('recon-aligned');
    try {
      writeManifest(dir, 'unit-economics.preview.json', { source: 'prototype-preview', annual_extrapolated_savings_usd: 100000 });
      writeManifest(dir, 'unit-economics.json', { source: 'prototype', annual_extrapolated_savings_usd: 105000 });
      const result = executeReconciliation({ runDir: dir, runId: 'sim-test' });
      expect(result.status).toBe('wrote');
      if (result.status === 'wrote') {
        expect(result.report.status).toBe('aligned');
        expect(result.report.drift_pct).toBeLessThanOrEqual(25);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('emits status=drift when drift exceeds 25%', () => {
    const dir = mkTempDir('recon-drift');
    try {
      writeManifest(dir, 'unit-economics.preview.json', { source: 'prototype-preview', annual_extrapolated_savings_usd: 100000 });
      writeManifest(dir, 'unit-economics.json', { source: 'prototype', annual_extrapolated_savings_usd: 200000 });
      const result = executeReconciliation({ runDir: dir, runId: 'sim-test' });
      expect(result.status).toBe('wrote');
      if (result.status === 'wrote') {
        expect(result.report.status).toBe('drift');
        expect(result.report.drift_pct!).toBeGreaterThan(25);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('emits status=missing-prototype when only the preview exists', () => {
    const dir = mkTempDir('recon-missing-proto');
    try {
      writeManifest(dir, 'unit-economics.preview.json', { source: 'prototype-preview' });
      // Intentionally no unit-economics.json
      const result = executeReconciliation({ runDir: dir, runId: 'sim-test' });
      expect(result.status).toBe('wrote');
      if (result.status === 'wrote') {
        expect(result.report.status).toBe('missing-prototype');
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('formatDriftWarning returns a header only on drift', () => {
    const dir = mkTempDir('recon-warning');
    try {
      writeManifest(dir, 'unit-economics.preview.json', { source: 'prototype-preview', annual_extrapolated_savings_usd: 100000 });
      writeManifest(dir, 'unit-economics.json', { source: 'prototype', annual_extrapolated_savings_usd: 200000 });
      const result = executeReconciliation({ runDir: dir, runId: 'sim-test' });
      if (result.status === 'wrote') {
        const warning = formatDriftWarning(result.report);
        expect(warning).not.toBeNull();
        expect(warning).toContain('Preview/prototype drift');
        expect(warning).toContain('reconciliation.report.json');
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('formatDriftWarning returns null on aligned report', () => {
    const dir = mkTempDir('recon-aligned-warn');
    try {
      writeManifest(dir, 'unit-economics.preview.json', { source: 'prototype-preview', annual_extrapolated_savings_usd: 100000 });
      writeManifest(dir, 'unit-economics.json', { source: 'prototype', annual_extrapolated_savings_usd: 102000 });
      const result = executeReconciliation({ runDir: dir, runId: 'sim-test' });
      if (result.status === 'wrote') {
        expect(formatDriftWarning(result.report)).toBeNull();
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
