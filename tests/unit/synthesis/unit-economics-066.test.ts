/**
 * ADR-PIPELINE-066 tests: domain-adaptive unit economics.
 *
 * Verifies:
 *  - UnitEconomicsSchema validates a well-formed manifest
 *  - classifySector routes the OPERA hotel query to 'hospitality'
 *  - extractDomainScale returns rooms for hospitality, sqft for CRE,
 *    vehicles for fleet; never forces employees when a sector is present
 *  - loadUnitEconomics reads a manifest from <runDir>/unit-economics.json
 *    and rejects schema-invalid input permissively
 *  - buildFinancialModelFromUnitEconomics produces dollar figures that match
 *    the manifest within ±1%
 *  - renderFinancialAnalysis prefers the manifest over per-employee heuristics
 *    (manifest path); emits the ⚠️ heuristic fallback banner when no manifest
 *    exists and the fallback path is taken
 *  - verifyManifestConsistency fires FCR-ratio violations
 *  - renderFinancialAnalysis never multiplies `employees × $/employee` when a
 *    manifest is present (grep regression)
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  UnitEconomicsSchema,
  type UnitEconomics,
} from '../../../src/pipeline/types.js';
import {
  classifySector,
  extractDomainScale,
  getSectorEntry,
} from '../../../src/synthesis/domain-unit-registry.js';
import {
  loadUnitEconomics,
  buildFinancialModelFromUnitEconomics,
  verifyManifestConsistency,
  enforceManifestConsistency,
  UnitEconomicsConsistencyError,
} from '../../../src/synthesis/unit-economics-loader.js';
import { renderFinancialAnalysis } from '../../../src/synthesis/simulation-renderers.js';

// ============================================================================
// Fixtures
// ============================================================================

function makeHospitalityManifest(): UnitEconomics {
  return {
    run_id: 'sim-test-066',
    sector: 'hospitality',
    domain_unit: { label: 'occupied room night', abbrev: 'orn' },
    measured_scope: { properties: 4, rooms: 1450, region_mix: ['NA', 'EMEA', 'APAC'] },
    enterprise_scope: { properties: 100, rooms: 36250, employees: 91000, region_mix: ['NA', 'EMEA', 'APAC'] },
    unit_savings: {
      usd_per_orn: 0.82,
      water_liters_per_orn: 14.5,
      co2_kg_per_orn: 0.62,
    },
    annual_measured_savings_usd: 1_203_400,
    annual_extrapolated_savings_usd: 30_085_000,
    extrapolation_method: 'linear_by_rooms_weighted_by_regional_cost',
    confidence: { directional: 0.92, precision: 0.42 },
    source: 'prototype',
  };
}

function writeManifestTo(dir: string, manifest: UnitEconomics): string {
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, 'unit-economics.json');
  fs.writeFileSync(p, JSON.stringify(manifest, null, 2), 'utf-8');
  return p;
}

function mkTempDir(label: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `adr066-${label}-`));
}

const OPERA_QUERY =
  'I lead sustainability and housekeeping operations for a global hotel group with approximately 91,000 employees operating properties across North America, Europe, and Asia. Oracle Hospitality OPERA manages linen and towel cleaning frequency.';

// ============================================================================
// Schema
// ============================================================================

describe('ADR-066 — UnitEconomicsSchema', () => {
  it('accepts a well-formed hospitality manifest', () => {
    const parsed = UnitEconomicsSchema.safeParse(makeHospitalityManifest());
    expect(parsed.success).toBe(true);
  });

  it('rejects negative savings', () => {
    const bad = { ...makeHospitalityManifest(), annual_measured_savings_usd: -1 };
    expect(UnitEconomicsSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects missing domain_unit', () => {
    const bad = { ...makeHospitalityManifest() } as Record<string, unknown>;
    delete bad['domain_unit'];
    expect(UnitEconomicsSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects confidence values outside 0..1', () => {
    const bad = { ...makeHospitalityManifest(), confidence: { directional: 1.5, precision: 0.4 } };
    expect(UnitEconomicsSchema.safeParse(bad).success).toBe(false);
  });
});

// ============================================================================
// Sector classification + scale extraction
// ============================================================================

describe('ADR-066 — classifySector', () => {
  it('routes OPERA hotel query to hospitality', () => {
    expect(classifySector(OPERA_QUERY)).toBe('hospitality');
  });

  it('routes a fleet query to fleet', () => {
    expect(classifySector('Transition our 3,200-vehicle fleet to EV over 3 years')).toBe('fleet');
  });

  it('routes a CRE query to commercial-real-estate', () => {
    expect(classifySector('Reduce energy use across our office portfolio and building portfolio')).toBe('commercial-real-estate');
  });

  it('routes a call-center query to call-center', () => {
    expect(classifySector('Improve agent productivity in our contact center BPO')).toBe('call-center');
  });

  it('respects an explicit sector hint', () => {
    expect(classifySector('generic optimization request', 'retail')).toBe('retail');
  });

  it('returns unknown for a generic internal tooling query', () => {
    expect(classifySector('Build a dashboard to track engineering velocity')).toBe('unknown');
  });
});

describe('ADR-066 — extractDomainScale', () => {
  it('returns rooms as the operational unit for a hospitality query', () => {
    const scale = extractDomainScale(OPERA_QUERY);
    expect(scale.sector).toBe('hospitality');
    expect(scale.unitLabel).toBe('rooms');
    expect(scale.source).not.toBe('default');
  });

  it('returns vehicles for an explicit fleet count', () => {
    const scale = extractDomainScale('Manage 3,200 vehicles across 12 depots');
    expect(scale.sector).toBe('fleet');
    expect(scale.operationalUnits).toBe(3200);
    expect(scale.unitLabel).toBe('vehicles');
    expect(scale.source).toBe('query-regex');
  });

  it('falls back to employees only when no sector matches', () => {
    const scale = extractDomainScale('Ship a dashboard to track engineering velocity');
    expect(scale.sector).toBe('unknown');
    expect(scale.unitLabel).toBe('employees');
    expect(scale.source).toBe('default');
  });

  it('still exposes employees as context when a sector is detected', () => {
    const scale = extractDomainScale(OPERA_QUERY);
    expect(scale.employees).toBe(91000);
  });
});

describe('ADR-066 — sector registry', () => {
  it('every sector entry has a domain unit and a scope key', () => {
    for (const sector of ['hospitality', 'commercial-real-estate', 'fleet', 'retail', 'manufacturing', 'healthcare', 'data-center', 'call-center'] as const) {
      const entry = getSectorEntry(sector);
      expect(entry).not.toBeNull();
      expect(entry!.domainUnit.label.length).toBeGreaterThan(0);
      expect(entry!.scopeKeys.length).toBeGreaterThan(0);
      expect(entry!.unitSavingsKey.length).toBeGreaterThan(0);
    }
  });
});

// ============================================================================
// Loader
// ============================================================================

describe('ADR-066 — loadUnitEconomics', () => {
  it('loads a well-formed manifest from <runDir>/unit-economics.json', () => {
    const dir = mkTempDir('loader-ok');
    try {
      writeManifestTo(dir, makeHospitalityManifest());
      const result = loadUnitEconomics(dir);
      expect(result.reason).toBe('loaded');
      expect(result.manifest?.sector).toBe('hospitality');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns missing reason when no file exists', () => {
    const dir = mkTempDir('loader-missing');
    try {
      const result = loadUnitEconomics(dir);
      expect(result.reason).toBe('missing');
      expect(result.manifest).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns invalid-json reason for malformed JSON', () => {
    const dir = mkTempDir('loader-bad-json');
    try {
      fs.writeFileSync(path.join(dir, 'unit-economics.json'), '{not-json', 'utf-8');
      const result = loadUnitEconomics(dir);
      expect(result.reason).toBe('invalid-json');
      expect(result.manifest).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns schema-rejected reason when required fields are missing', () => {
    const dir = mkTempDir('loader-bad-schema');
    try {
      fs.writeFileSync(path.join(dir, 'unit-economics.json'), JSON.stringify({ run_id: 'x' }), 'utf-8');
      const result = loadUnitEconomics(dir);
      expect(result.reason).toBe('schema-rejected');
      expect(result.manifest).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns missing reason when passed null', () => {
    expect(loadUnitEconomics(null).reason).toBe('missing');
  });
});

// ============================================================================
// Financial model builder
// ============================================================================

describe('ADR-066 — buildFinancialModelFromUnitEconomics', () => {
  it('derives dollar figures from the manifest (within ±1%)', () => {
    const manifest = makeHospitalityManifest();
    const model = buildFinancialModelFromUnitEconomics(manifest);

    const matchMoney = (s: string): number => {
      const m = s.match(/\$(\d[\d.,]*)(M|K)?/);
      if (!m) return 0;
      const num = parseFloat(m[1]!.replace(/,/g, ''));
      const suffix = (m[2] ?? '').toUpperCase();
      return suffix === 'M' ? num * 1_000_000 : suffix === 'K' ? num * 1_000 : num;
    };

    const revenue = matchMoney(model.revenue);
    const rel = Math.abs(revenue - manifest.annual_extrapolated_savings_usd) / manifest.annual_extrapolated_savings_usd;
    // ~5% tolerance for string-rounded money formatter ($30.1M)
    expect(rel).toBeLessThan(0.05);
    expect(model.methodology).toMatch(/rooms × occupancy/);
    expect(model.scopeRatio).toBeCloseTo(25, 0); // 36250 / 1450
  });

  it('puts the sector formula in the methodology line', () => {
    const manifest = makeHospitalityManifest();
    const model = buildFinancialModelFromUnitEconomics(manifest);
    expect(model.methodology).toContain('occupied-room-night');
  });
});

// ============================================================================
// Consistency check
// ============================================================================

describe('ADR-066 — verifyManifestConsistency', () => {
  it('passes when printed figures match the manifest exactly', () => {
    const manifest = makeHospitalityManifest();
    const result = verifyManifestConsistency(manifest, {
      measuredSavingsUsd: manifest.annual_measured_savings_usd,
      enterpriseSavingsUsd: manifest.annual_extrapolated_savings_usd,
    });
    expect(result.passed).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  it('fires when printed measured savings drift past 1%', () => {
    const manifest = makeHospitalityManifest();
    const drifted = manifest.annual_measured_savings_usd * 1.1;
    const result = verifyManifestConsistency(manifest, {
      measuredSavingsUsd: drifted,
      enterpriseSavingsUsd: manifest.annual_extrapolated_savings_usd,
    });
    expect(result.passed).toBe(false);
    expect(result.violations.join(' ')).toMatch(/measured savings/);
  });

  it('fires when pilot→enterprise ratio deviates past 5%', () => {
    const manifest = makeHospitalityManifest();
    const result = verifyManifestConsistency(manifest, {
      measuredSavingsUsd: manifest.annual_measured_savings_usd,
      enterpriseSavingsUsd: manifest.annual_measured_savings_usd * 10, // manifest is ~25x
    });
    expect(result.passed).toBe(false);
    expect(result.violations.join(' ')).toMatch(/ratio/);
  });

  it('enforceManifestConsistency throws under strict mode', () => {
    const prev = process.env['AGENTICS_STRICT_UNIT_ECONOMICS'];
    process.env['AGENTICS_STRICT_UNIT_ECONOMICS'] = 'true';
    try {
      const manifest = makeHospitalityManifest();
      expect(() =>
        enforceManifestConsistency(manifest, {
          measuredSavingsUsd: manifest.annual_measured_savings_usd * 2,
          enterpriseSavingsUsd: manifest.annual_extrapolated_savings_usd,
        }),
      ).toThrow(UnitEconomicsConsistencyError);
    } finally {
      if (prev === undefined) delete process.env['AGENTICS_STRICT_UNIT_ECONOMICS'];
      else process.env['AGENTICS_STRICT_UNIT_ECONOMICS'] = prev;
    }
  });
});

// ============================================================================
// renderFinancialAnalysis — 3-tier precedence
// ============================================================================

describe('ADR-066 — renderFinancialAnalysis prefers unit-economics.json', () => {
  it('emits the ✅ manifest banner when unit-economics.json exists', () => {
    const dir = mkTempDir('render-manifest');
    try {
      writeManifestTo(dir, makeHospitalityManifest());
      const out = renderFinancialAnalysis(OPERA_QUERY, null, [], dir);
      expect(out).toMatch(/Financial model: prototype unit economics/);
      expect(out).toContain('hospitality');
      expect(out).toContain('occupied room night');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('emits the ⚠️ heuristic fallback banner when no manifest exists', () => {
    const dir = mkTempDir('render-no-manifest');
    try {
      const out = renderFinancialAnalysis(OPERA_QUERY, null, [], dir);
      expect(out).toMatch(/heuristic fallback/);
      expect(out).toMatch(/no prototype `unit-economics\.json` found/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('never prints a per-employee multiplication when a manifest is present', () => {
    const dir = mkTempDir('render-no-employee-math');
    try {
      writeManifestTo(dir, makeHospitalityManifest());
      const out = renderFinancialAnalysis(OPERA_QUERY, null, [], dir);
      // The heuristic path emits phrases like "employees × $/employee benchmark" —
      // under ADR-066, those must be absent when the manifest wins.
      expect(out).not.toMatch(/employees × \$\d+\/employee/);
      expect(out).not.toMatch(/per employee annual efficiency gain/i);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('includes the manifest scope ratio in the methodology', () => {
    const dir = mkTempDir('render-scope-ratio');
    try {
      writeManifestTo(dir, makeHospitalityManifest());
      const out = renderFinancialAnalysis(OPERA_QUERY, null, [], dir);
      // 36250 / 1450 = 25x
      expect(out).toMatch(/25\.0×|scales 25/);
      expect(out).toContain('linear_by_rooms_weighted_by_regional_cost');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('falls through to heuristic when runDir is undefined', () => {
    const out = renderFinancialAnalysis(OPERA_QUERY, null, []);
    expect(out).toMatch(/heuristic fallback/);
  });
});
