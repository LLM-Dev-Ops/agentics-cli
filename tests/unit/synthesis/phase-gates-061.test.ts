/**
 * ADR-PIPELINE-061 tests: domain-adaptive phase gate criteria.
 *
 * Verifies:
 *  - buildPhaseGates() returns 3 structured gates with criteria arrays
 *  - each criterion has metric, threshold, data_source
 *  - decision_authority is derived from the extracted stakeholders
 *  - compliance-triggered queries add regulatory criteria
 *  - buildRoadmapArtifact emits the new structured phase_gates, not
 *    the old 3-line hardcoded generic strings
 *  - PHASE_GATE_THRESHOLDS config file exports the expected defaults
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  buildPhaseGates,
  buildRoadmapArtifact,
  type PhaseGate,
  type GateCriterion,
} from '../../../src/synthesis/simulation-renderers.js';
import { PHASE_GATE_THRESHOLDS, pct } from '../../../src/synthesis/phase-gate-thresholds.js';

// ============================================================================
// Helpers
// ============================================================================

/**
 * Minimal ExtractedScenario stub. The real extractScenarioFromQuery is
 * complex; for these tests we build fixtures directly to exercise the
 * gate builder's branching. buildPhaseGates only reads a handful of
 * fields: scenario_type, stakeholders, domain_entities.
 */
function fakeExtracted(overrides: Record<string, unknown> = {}): unknown {
  return {
    scenario_type: 'supply-chain-management',
    stakeholders: ['VP Operations', 'CTO'],
    constraints: [],
    success_criteria: [],
    systems: ['SAP S/4HANA'],
    domain_entities: ['Supplier', 'PurchaseOrder'],
    capabilities: [],
    ...overrides,
  };
}

// ============================================================================
// buildPhaseGates — unit tests
// ============================================================================

describe('ADR-PIPELINE-061 — buildPhaseGates()', () => {
  it('returns exactly 3 gates', () => {
    const gates = buildPhaseGates('supply chain risk analysis', fakeExtracted() as never, 'SAP S/4HANA');
    expect(gates).toHaveLength(3);
  });

  it('gate ordering: phase-1 Technical → phase-2 Business → phase-3 Scale', () => {
    const gates = buildPhaseGates('supply chain risk analysis', fakeExtracted() as never, 'SAP S/4HANA');
    expect(gates[0]!.after_phase).toBe('phase-1');
    expect(gates[0]!.gate).toBe('Technical Validation');
    expect(gates[1]!.after_phase).toBe('phase-2');
    expect(gates[1]!.gate).toBe('Business Validation');
    expect(gates[2]!.after_phase).toBe('phase-3');
    expect(gates[2]!.gate).toBe('Scale Readiness');
  });

  it('every gate has at least 4 criteria with all required fields', () => {
    const gates = buildPhaseGates('supply chain risk analysis', fakeExtracted() as never, 'SAP S/4HANA');
    for (const gate of gates) {
      expect(gate.criteria.length).toBeGreaterThanOrEqual(4);
      for (const c of gate.criteria) {
        expect(c.metric.length).toBeGreaterThan(0);
        expect(c.threshold.length).toBeGreaterThan(0);
        expect(c.data_source.length).toBeGreaterThan(0);
      }
    }
  });

  it('every gate has a non-empty decision_authority and overall_decision', () => {
    const gates = buildPhaseGates('supply chain risk analysis', fakeExtracted() as never, 'SAP S/4HANA');
    for (const gate of gates) {
      expect(gate.decision_authority.length).toBeGreaterThan(0);
      expect(gate.overall_decision.length).toBeGreaterThan(0);
    }
  });

  it('Gate 1 first criterion references the primary system by name', () => {
    const gates = buildPhaseGates('supply chain risk analysis', fakeExtracted() as never, 'SAP S/4HANA');
    expect(gates[0]!.criteria[0]!.metric).toContain('SAP S/4HANA');
  });

  it('Gate 1 includes audit trail integrity criterion', () => {
    const gates = buildPhaseGates('supply chain risk analysis', fakeExtracted() as never, 'SAP S/4HANA');
    const auditCriterion = gates[0]!.criteria.find(c => /audit trail integrity/i.test(c.metric));
    expect(auditCriterion).toBeDefined();
    expect(auditCriterion!.threshold).toContain('100%');
  });

  it('Gate 2 includes quantified savings variance threshold', () => {
    const gates = buildPhaseGates('supply chain risk analysis', fakeExtracted() as never, 'SAP S/4HANA');
    const savingsCriterion = gates[1]!.criteria.find(c => /savings/i.test(c.metric));
    expect(savingsCriterion).toBeDefined();
    expect(savingsCriterion!.threshold).toMatch(/\d+%/);
  });

  it('Gate 3 includes projected ROI with a numeric threshold', () => {
    const gates = buildPhaseGates('supply chain risk analysis', fakeExtracted() as never, 'SAP S/4HANA');
    const roiCriterion = gates[2]!.criteria.find(c => /roi/i.test(c.metric));
    expect(roiCriterion).toBeDefined();
    expect(roiCriterion!.threshold).toMatch(/\d+%/);
  });

  it('Gate 3 always includes security audit findings criterion', () => {
    const gates = buildPhaseGates('supply chain risk analysis', fakeExtracted() as never, 'SAP S/4HANA');
    const secCriterion = gates[2]!.criteria.find(c => /security.*findings/i.test(c.metric));
    expect(secCriterion).toBeDefined();
    expect(secCriterion!.threshold).toContain('0 critical');
  });

  it('is deterministic for identical inputs', () => {
    const a = buildPhaseGates('supply chain analysis', fakeExtracted() as never, 'SAP S/4HANA');
    const b = buildPhaseGates('supply chain analysis', fakeExtracted() as never, 'SAP S/4HANA');
    expect(a).toEqual(b);
  });
});

// ============================================================================
// Compliance-triggered criteria (ADR-PIPELINE-061 §1 conditional rows)
// ============================================================================

describe('ADR-PIPELINE-061 — compliance-triggered gate criteria', () => {
  it('pharmaceutical query adds regulatory mapping to Gate 1', () => {
    const gates = buildPhaseGates(
      'We need a GxP-compliant pharmaceutical batch release system with cold-chain monitoring.',
      fakeExtracted({ scenario_type: 'pharma-life-sciences' }) as never,
      'SAP S/4HANA',
    );
    const regCriterion = gates[0]!.criteria.find(c => /regulatory mapping/i.test(c.metric));
    expect(regCriterion).toBeDefined();
    expect(regCriterion!.metric).toContain('FDA');
  });

  it('compliance query adds regulatory sign-off to Gate 3', () => {
    const gates = buildPhaseGates(
      'FDA 21 CFR Part 11 compliance for pharmaceutical electronic records.',
      fakeExtracted({ scenario_type: 'pharma-life-sciences' }) as never,
      'SAP S/4HANA',
    );
    const signoff = gates[2]!.criteria.find(c => /regulatory sign-?off/i.test(c.metric));
    expect(signoff).toBeDefined();
  });

  it('non-regulated query does NOT add compliance criteria', () => {
    const gates = buildPhaseGates(
      'Improve internal dashboards for analytics.',
      fakeExtracted({ scenario_type: 'data-analytics' }) as never,
      'Snowflake',
    );
    expect(gates[0]!.criteria.find(c => /regulatory mapping/i.test(c.metric))).toBeUndefined();
    expect(gates[2]!.criteria.find(c => /regulatory sign-?off/i.test(c.metric))).toBeUndefined();
  });
});

// ============================================================================
// Decision authority derivation
// ============================================================================

describe('ADR-PIPELINE-061 — decision_authority derivation', () => {
  it('defaults to CTO + VP Operations for Gate 1', () => {
    const gates = buildPhaseGates(
      'analysis',
      fakeExtracted({ stakeholders: ['VP Operations', 'CTO'] }) as never,
      'SAP S/4HANA',
    );
    expect(gates[0]!.decision_authority).toContain('CTO');
  });

  it('defaults to CFO + CTO for Gate 2', () => {
    const gates = buildPhaseGates(
      'analysis',
      fakeExtracted({ stakeholders: ['CFO', 'CTO'] }) as never,
      'SAP S/4HANA',
    );
    expect(gates[1]!.decision_authority).toContain('CFO');
  });

  it('escalates to Board when board stakeholders are present for Gate 3', () => {
    const gates = buildPhaseGates(
      'analysis',
      fakeExtracted({ stakeholders: ['Board of Directors', 'Steering Committee'] }) as never,
      'SAP S/4HANA',
    );
    expect(gates[2]!.decision_authority).toContain('Board');
  });

  it('defaults to Steering Committee for Gate 3 when no Board', () => {
    const gates = buildPhaseGates(
      'analysis',
      fakeExtracted({ stakeholders: ['CTO', 'VP Operations'] }) as never,
      'SAP S/4HANA',
    );
    expect(gates[2]!.decision_authority).toContain('Steering');
  });
});

// ============================================================================
// buildRoadmapArtifact integration
// ============================================================================

describe('ADR-PIPELINE-061 — buildRoadmapArtifact integration', () => {
  it('phase_gates is an array of 3 structured gates (not the old flat-string shape)', () => {
    const artifact = buildRoadmapArtifact(
      'supply chain risk analysis across 50 suppliers',
      null,
      [],
    );
    const gates = artifact.phase_gates as PhaseGate[];
    expect(Array.isArray(gates)).toBe(true);
    expect(gates).toHaveLength(3);
    for (const gate of gates) {
      expect(Array.isArray(gate.criteria)).toBe(true); // old shape was a string
      expect(gate.criteria.length).toBeGreaterThan(0);
      const first = gate.criteria[0]! as GateCriterion;
      expect(typeof first.metric).toBe('string');
      expect(typeof first.threshold).toBe('string');
      expect(typeof first.data_source).toBe('string');
    }
  });

  it('does NOT use the old hardcoded gate names', () => {
    const artifact = buildRoadmapArtifact('analysis query', null, []);
    const gates = artifact.phase_gates as PhaseGate[];
    const gateNames = gates.map(g => g.gate);
    expect(gateNames).not.toContain('Discovery Complete');
    expect(gateNames).not.toContain('Prototype Validated');
    expect(gateNames).not.toContain('Pilot Ready');
  });
});

// ============================================================================
// PHASE_GATE_THRESHOLDS config file
// ============================================================================

describe('ADR-PIPELINE-061 — phase-gate-thresholds.ts', () => {
  it('exports all 12 threshold keys', () => {
    const keys = Object.keys(PHASE_GATE_THRESHOLDS);
    const expected = [
      'erpFieldCoveragePct', 'scoringAccuracyPct', 'systemUptimePct', 'auditIntegrityPct',
      'savingsVariancePct', 'userAdoptionPct', 'falsePositiveRatePct', 'erpTransactionSuccessPct',
      'projectedRoiMultiplier', 'securityCriticalFindings', 'changeManagementReadinessPct', 'dbLatencyP95Ms',
    ];
    for (const key of expected) {
      expect(keys).toContain(key);
    }
  });

  it('defaults match consulting benchmarks from the ADR', () => {
    expect(PHASE_GATE_THRESHOLDS.erpFieldCoveragePct).toBe(0.80);
    expect(PHASE_GATE_THRESHOLDS.scoringAccuracyPct).toBe(0.75);
    expect(PHASE_GATE_THRESHOLDS.systemUptimePct).toBe(0.99);
    expect(PHASE_GATE_THRESHOLDS.auditIntegrityPct).toBe(1.00);
    expect(PHASE_GATE_THRESHOLDS.projectedRoiMultiplier).toBe(1.50);
    expect(PHASE_GATE_THRESHOLDS.securityCriticalFindings).toBe(0);
    expect(PHASE_GATE_THRESHOLDS.dbLatencyP95Ms).toBe(200);
  });

  it('pct() helper formats 0.80 as "80%"', () => {
    expect(pct(0.80)).toBe('80%');
    expect(pct(1.00)).toBe('100%');
    expect(pct(0.99)).toBe('99%');
  });
});

// ============================================================================
// Source regression
// ============================================================================

describe('ADR-PIPELINE-061 — source code regression', () => {
  it('simulation-renderers.ts no longer hardcodes the old 3 generic gates', () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), 'src/synthesis/simulation-renderers.ts'),
      'utf-8',
    );
    // The 3 old gate names should only appear in test files, NOT in source
    expect(source).not.toContain("gate: 'Discovery Complete'");
    expect(source).not.toContain("gate: 'Prototype Validated'");
    expect(source).not.toContain("gate: 'Pilot Ready'");
  });

  it('simulation-renderers.ts exports buildPhaseGates and PhaseGate type', () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), 'src/synthesis/simulation-renderers.ts'),
      'utf-8',
    );
    expect(source).toContain('export function buildPhaseGates');
    expect(source).toContain('export interface PhaseGate');
    expect(source).toContain('export interface GateCriterion');
  });
});
