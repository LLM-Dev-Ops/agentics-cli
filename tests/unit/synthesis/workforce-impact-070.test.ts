/**
 * ADR-PIPELINE-070 tests: workforce-impact risk dimension.
 *
 * Verifies:
 *  - classifyLaborIntensity routes 8 sectors correctly
 *  - SaaS / pure-software queries return low intensity
 *  - workforceRiskTemplate produces ≥5 rows for high-intensity sectors
 *  - estimateWorkforceExposure scales with operationalUnits when present
 *  - workforceRaciTemplate includes HR + Legal + Regional HR rows
 *  - workforceSensitivityRow appears for high but not for low intensity
 *  - Renderer integration: hospitality query produces Workforce Impact in
 *    risk register, Workforce RACI in decision memo, Workforce Exposure in
 *    financial analysis, and a workforce row in the sensitivity tornado
 *  - Pure-SaaS query does NOT trigger any of the workforce sections
 *  - buildLaborProfileArtifact round-trips through JSON
 */

import {
  classifyLaborIntensity,
  isLaborIntensive,
  workforceRiskTemplate,
  workforceRaciTemplate,
  workforceSensitivityRow,
  estimateWorkforceExposure,
  buildLaborProfileArtifact,
  type LaborProfile,
} from '../../../src/synthesis/domain-labor-classifier.js';
import {
  buildRiskAssessment,
  renderDecisionMemo,
  renderFinancialAnalysis,
  buildSensitivityTable,
} from '../../../src/synthesis/simulation-renderers.js';

// ============================================================================
// Fixtures
// ============================================================================

const OPERA_QUERY =
  'I lead sustainability and housekeeping operations for a global hotel group with approximately 91,000 employees operating properties across North America, Europe, and Asia. Oracle Hospitality OPERA manages linen and towel cleaning frequency.';

const SAAS_QUERY =
  'Build an internal dashboard SaaS to track engineering velocity across our developer productivity teams. Pure software project, no operational impact.';

const FLEET_QUERY =
  'Transition our 3,200-vehicle truck fleet to EV across 12 depots over 3 years.';

// ============================================================================
// classifyLaborIntensity
// ============================================================================

describe('ADR-070 — classifyLaborIntensity', () => {
  it('classifies hospitality as high intensity with EMEA exposure', () => {
    const profile = classifyLaborIntensity(null, OPERA_QUERY);
    expect(profile.intensity).toBe('high');
    expect(profile.sector).toBe('hospitality');
    expect(profile.unionizationRisk).toBe('high');
    expect(profile.regionMultipliers.EMEA).toBeGreaterThan(profile.regionMultipliers.NA);
    expect(profile.roleTypes.length).toBeGreaterThan(0);
  });

  it('classifies a fleet query as high intensity (drivers)', () => {
    const profile = classifyLaborIntensity(null, FLEET_QUERY);
    expect(profile.intensity).toBe('high');
    expect(profile.sector).toBe('fleet');
    expect(profile.roleTypes.some(r => /driver/i.test(r))).toBe(true);
  });

  it('classifies a CRE query as medium intensity', () => {
    const profile = classifyLaborIntensity(null, 'Reduce energy use across our office portfolio buildings.');
    expect(profile.intensity).toBe('medium');
    expect(profile.sector).toBe('commercial-real-estate');
  });

  it('classifies a pure-SaaS query as low intensity', () => {
    const profile = classifyLaborIntensity(null, SAAS_QUERY);
    expect(profile.intensity).toBe('low');
  });

  it('respects an explicit domain hint', () => {
    const profile = classifyLaborIntensity(
      { domain: 'retail', keyMetrics: {}, scenarios: [], confidence: 0.8, methodology: 'test' },
      'Optimize something',
    );
    expect(profile.sector).toBe('retail');
    expect(profile.intensity).toBe('high');
  });

  it('isLaborIntensive returns false for low intensity', () => {
    const profile = classifyLaborIntensity(null, SAAS_QUERY);
    expect(isLaborIntensive(profile)).toBe(false);
  });

  it('isLaborIntensive returns true for medium and high', () => {
    expect(isLaborIntensive(classifyLaborIntensity(null, OPERA_QUERY))).toBe(true);
    expect(isLaborIntensive(classifyLaborIntensity(null, 'Reduce energy use across our building portfolio'))).toBe(true);
  });
});

// ============================================================================
// workforceRiskTemplate
// ============================================================================

describe('ADR-070 — workforceRiskTemplate', () => {
  it('produces 5 mandatory rows for hospitality', () => {
    const profile = classifyLaborIntensity(null, OPERA_QUERY);
    const rows = workforceRiskTemplate(profile);
    expect(rows.length).toBe(5);
    expect(rows.every(r => r.template === true)).toBe(true);
  });

  it('every row has owner + mitigation + category=workforce', () => {
    const profile = classifyLaborIntensity(null, OPERA_QUERY);
    for (const row of workforceRiskTemplate(profile)) {
      expect(row.owner.length).toBeGreaterThan(0);
      expect(row.mitigation.length).toBeGreaterThan(0);
      expect(row.category).toBe('workforce');
    }
  });

  it('EMEA works-council row likelihood is High when unionization risk is high', () => {
    const profile = classifyLaborIntensity(null, OPERA_QUERY);
    const rows = workforceRiskTemplate(profile);
    const emea = rows.find(r => r.risk.includes('EMEA works-council'));
    expect(emea?.likelihood).toBe('High');
  });
});

// ============================================================================
// estimateWorkforceExposure
// ============================================================================

describe('ADR-070 — estimateWorkforceExposure', () => {
  it('returns null for low intensity', () => {
    const profile = classifyLaborIntensity(null, SAAS_QUERY);
    expect(estimateWorkforceExposure(profile, { employees: 5000 })).toBeNull();
  });

  it('uses operationalUnits ratio for hospitality (rooms)', () => {
    const profile = classifyLaborIntensity(null, OPERA_QUERY);
    const exposure = estimateWorkforceExposure(profile, {
      employees: 91000,
      operationalUnits: 36250, // rooms
      pilotInvestmentUsd: 1_000_000,
    });
    expect(exposure).not.toBeNull();
    expect(exposure!.rolesAffected).toBeGreaterThan(2000);
    expect(exposure!.rolesAffected).toBeLessThan(5000);
    expect(exposure!.primaryRoleLabel).toBe('housekeepers');
    expect(exposure!.changeMgmtPct).toBe(0.12);
    expect(exposure!.changeMgmtBudgetLowUsd).toBe(120_000);
    expect(exposure!.reallocationNeutral).toBe(true);
  });

  it('falls back to a headcount fraction when operationalUnits unknown', () => {
    const profile = classifyLaborIntensity(null, FLEET_QUERY);
    const exposure = estimateWorkforceExposure(profile, { employees: 50_000, pilotInvestmentUsd: 500_000 });
    expect(exposure).not.toBeNull();
    expect(exposure!.rolesAffected).toBeGreaterThan(0);
    expect(exposure!.changeMgmtBudgetLowUsd).toBe(60_000);
  });

  it('zero EMEA union exposure when unionization risk is low', () => {
    const profile: LaborProfile = {
      intensity: 'medium',
      sector: 'commercial-real-estate',
      roleTypes: ['facility operator'],
      unionizationRisk: 'low',
      regionMultipliers: { NA: 1.0, EMEA: 1.0, APAC: 1.0 },
      reasoning: 'test',
    };
    const exposure = estimateWorkforceExposure(profile, { employees: 5000, operationalUnits: 1_000_000 });
    expect(exposure!.emeaUnionExposure).toBe(0);
  });
});

// ============================================================================
// workforceRaciTemplate
// ============================================================================

describe('ADR-070 — workforceRaciTemplate', () => {
  it('returns HR + Legal + Regional HR for high intensity', () => {
    const profile = classifyLaborIntensity(null, OPERA_QUERY);
    const rows = workforceRaciTemplate(profile);
    const roles = rows.map(r => r.role);
    expect(roles).toEqual(expect.arrayContaining(['HR', 'Legal', 'Regional HR leads']));
  });

  it('returns empty list for low intensity', () => {
    const profile = classifyLaborIntensity(null, SAAS_QUERY);
    expect(workforceRaciTemplate(profile)).toEqual([]);
  });

  it('Legal cadence mentions works-council when unionization is high', () => {
    const profile = classifyLaborIntensity(null, OPERA_QUERY);
    const legal = workforceRaciTemplate(profile).find(r => r.role === 'Legal');
    expect(legal?.cadence).toMatch(/works-council|EMEA/);
  });
});

// ============================================================================
// workforceSensitivityRow
// ============================================================================

describe('ADR-070 — workforceSensitivityRow', () => {
  it('returns null for low intensity', () => {
    expect(workforceSensitivityRow(classifyLaborIntensity(null, SAAS_QUERY))).toBeNull();
  });

  it('returns a Change management overrun row for high intensity', () => {
    const row = workforceSensitivityRow(classifyLaborIntensity(null, OPERA_QUERY));
    expect(row?.variable).toMatch(/[Cc]hange management/);
  });

  it('buildSensitivityTable injects the workforce row when profile is high', () => {
    const profile = classifyLaborIntensity(null, OPERA_QUERY);
    const rows = buildSensitivityTable(5_000_000, 'sustainability-esg', profile);
    expect(rows.some(r => /change management/i.test(r.variable))).toBe(true);
  });

  it('buildSensitivityTable does NOT inject the workforce row for low intensity', () => {
    const profile = classifyLaborIntensity(null, SAAS_QUERY);
    const rows = buildSensitivityTable(5_000_000, 'sustainability-esg', profile);
    expect(rows.some(r => /change management/i.test(r.variable))).toBe(false);
  });

  it('buildSensitivityTable backwards-compatible when no profile is supplied', () => {
    const rows = buildSensitivityTable(5_000_000, 'sustainability-esg');
    expect(rows.length).toBeGreaterThanOrEqual(5);
  });
});

// ============================================================================
// Renderer integration — risk register
// ============================================================================

describe('ADR-070 — buildRiskAssessment workforce injection', () => {
  it('hospitality query produces Workforce category rows in the risk register', () => {
    const risk = buildRiskAssessment(OPERA_QUERY, null, []);
    const register = risk['risk_register'] as Array<{ category: string; description: string }>;
    expect(register.some(r => r.category === 'Workforce')).toBe(true);
    expect(register.some(r => /works-council|EMEA/i.test(r.description))).toBe(true);
  });

  it('hospitality query exposes workforce_impact metadata block', () => {
    const risk = buildRiskAssessment(OPERA_QUERY, null, []);
    expect(risk['workforce_impact']).not.toBeNull();
    const wf = risk['workforce_impact'] as { intensity: string; sector: string };
    expect(wf.intensity).toBe('high');
    expect(wf.sector).toBe('hospitality');
  });

  it('SaaS query does NOT add Workforce rows', () => {
    const risk = buildRiskAssessment(SAAS_QUERY, null, []);
    const register = risk['risk_register'] as Array<{ category: string }>;
    expect(register.some(r => r.category === 'Workforce')).toBe(false);
    expect(risk['workforce_impact']).toBeNull();
  });
});

// ============================================================================
// Renderer integration — decision memo RACI
// ============================================================================

describe('ADR-070 — renderDecisionMemo workforce RACI', () => {
  it('hospitality query injects HR/Legal/Regional HR rows', () => {
    const memo = renderDecisionMemo(OPERA_QUERY, null, []);
    expect(memo).toContain('Workforce RACI');
    expect(memo).toMatch(/\| HR \|/);
    expect(memo).toMatch(/\| Legal \|/);
    expect(memo).toMatch(/Regional HR leads/);
  });

  it('SaaS query does NOT inject the Workforce RACI section', () => {
    const memo = renderDecisionMemo(SAAS_QUERY, null, []);
    expect(memo).not.toContain('Workforce RACI');
  });
});

// ============================================================================
// Renderer integration — financial analysis exposure block
// ============================================================================

describe('ADR-070 — renderFinancialAnalysis workforce exposure', () => {
  it('hospitality query produces a Workforce Exposure block', () => {
    const out = renderFinancialAnalysis(OPERA_QUERY, null, []);
    expect(out).toContain('Workforce Exposure');
    expect(out).toMatch(/Roles affected/);
    expect(out).toMatch(/Change-management budget/);
    expect(out).toMatch(/Reallocation neutrality/);
  });

  it('SaaS query does NOT produce a Workforce Exposure block', () => {
    const out = renderFinancialAnalysis(SAAS_QUERY, null, []);
    expect(out).not.toContain('Workforce Exposure');
  });

  it('hospitality sensitivity tornado includes a workforce variable', () => {
    const out = renderFinancialAnalysis(OPERA_QUERY, null, []);
    expect(out).toMatch(/[Cc]hange management/);
  });
});

// ============================================================================
// Persistence shape
// ============================================================================

describe('ADR-070 — buildLaborProfileArtifact', () => {
  it('produces a v1.0 artifact that round-trips through JSON', () => {
    const profile = classifyLaborIntensity(null, OPERA_QUERY);
    const exposure = estimateWorkforceExposure(profile, { employees: 91000, operationalUnits: 36250, pilotInvestmentUsd: 1_000_000 });
    const artifact = buildLaborProfileArtifact(profile, exposure);
    expect(artifact.version).toBe('1.0');
    const round = JSON.parse(JSON.stringify(artifact)) as { profile: { sector: string }; exposure: { changeMgmtPct: number } | null };
    expect(round.profile.sector).toBe('hospitality');
    expect(round.exposure?.changeMgmtPct).toBe(0.12);
  });
});
