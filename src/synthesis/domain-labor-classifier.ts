/**
 * ADR-PIPELINE-070: Domain Labor-Intensity Classifier
 *
 * Pure rules-based classifier. Maps the detected sector + free-text query
 * keywords to a LaborProfile that downstream renderers consume:
 *
 *   - Risk register injects a Workforce Impact section
 *   - Financial analysis adds a workforce exposure block
 *   - Decision memo RACI gains HR + Legal rows
 *   - Sensitivity table gains a change-management variable
 *
 * The classifier is intentionally coarse — it answers "is this sector
 * labor-intensive enough that workforce risk MUST appear in the
 * deliverables?" not "what specific labor risks does this engagement
 * have?". The Workforce Impact rows it produces are templates labelled
 * `*Template risk — refine with HR during pilot scoping*`.
 */

import { classifySector, type Sector } from './domain-unit-registry.js';
import type { DomainAnalysis } from './simulation-renderers.js';

// ============================================================================
// Public types
// ============================================================================

export type LaborIntensity = 'high' | 'medium' | 'low';
export type UnionizationRisk = 'high' | 'medium' | 'low';
export type Region = 'NA' | 'EMEA' | 'APAC';

export interface LaborProfile {
  /** Overall labor intensity for this engagement. */
  readonly intensity: LaborIntensity;
  /** Detected sector (from ADR-066 registry) — 'unknown' when unmatched. */
  readonly sector: Sector;
  /** Plain-English role types most affected by the engagement. */
  readonly roleTypes: readonly string[];
  /** Likelihood that affected workforce sits within a unionized population. */
  readonly unionizationRisk: UnionizationRisk;
  /** Per-region labor exposure multipliers (1.0 = baseline). */
  readonly regionMultipliers: Readonly<Record<Region, number>>;
  /** Why the classifier picked this intensity — surfaced in logs/artifacts. */
  readonly reasoning: string;
}

// ============================================================================
// Sector → labor profile registry (ADR-070 §1)
// ============================================================================

interface SectorLaborTemplate {
  readonly sector: Sector;
  readonly intensity: LaborIntensity;
  readonly unionizationRisk: UnionizationRisk;
  readonly roleTypes: readonly string[];
  readonly regionMultipliers: Readonly<Record<Region, number>>;
  readonly notes: string;
}

const SECTOR_PROFILES: readonly SectorLaborTemplate[] = [
  {
    sector: 'hospitality',
    intensity: 'high',
    unionizationRisk: 'high',
    roleTypes: ['housekeeper', 'F&B server', 'front-desk associate', 'maintenance technician'],
    regionMultipliers: { NA: 1.0, EMEA: 1.5, APAC: 0.9 },
    notes: 'Housekeeping/F&B is labor-intensive; EMEA carries works-council obligations.',
  },
  {
    sector: 'retail',
    intensity: 'high',
    unionizationRisk: 'medium',
    roleTypes: ['floor associate', 'cashier', 'stockroom staff', 'shift supervisor'],
    regionMultipliers: { NA: 1.0, EMEA: 1.3, APAC: 0.95 },
    notes: 'Floor staff and stock teams scale with store count.',
  },
  {
    sector: 'fleet',
    intensity: 'high',
    unionizationRisk: 'high',
    roleTypes: ['driver', 'dispatcher', 'fleet mechanic'],
    regionMultipliers: { NA: 1.0, EMEA: 1.4, APAC: 0.9 },
    notes: 'Driver workforce is heavily regulated and frequently unionized in NA/EMEA.',
  },
  {
    sector: 'healthcare',
    intensity: 'high',
    unionizationRisk: 'high',
    roleTypes: ['registered nurse', 'allied health professional', 'clinical aide'],
    regionMultipliers: { NA: 1.0, EMEA: 1.4, APAC: 0.95 },
    notes: 'Nursing and allied health are protected categories with strong representation.',
  },
  {
    sector: 'call-center',
    intensity: 'high',
    unionizationRisk: 'medium',
    roleTypes: ['contact-center agent', 'team lead', 'workforce planner'],
    regionMultipliers: { NA: 1.0, EMEA: 1.3, APAC: 1.0 },
    notes: 'Performance-metric changes have direct labor implications.',
  },
  {
    sector: 'manufacturing',
    intensity: 'high',
    unionizationRisk: 'high',
    roleTypes: ['line operator', 'machinist', 'shift lead', 'maintenance technician'],
    regionMultipliers: { NA: 1.0, EMEA: 1.4, APAC: 1.0 },
    notes: 'Production-floor headcount scales with line count and shift coverage.',
  },
  {
    sector: 'commercial-real-estate',
    intensity: 'medium',
    unionizationRisk: 'low',
    roleTypes: ['facility operator', 'security officer', 'janitorial staff'],
    regionMultipliers: { NA: 1.0, EMEA: 1.2, APAC: 0.95 },
    notes: 'Facility ops and security are smaller per-property but still material to change-management.',
  },
  {
    sector: 'data-center',
    intensity: 'medium',
    unionizationRisk: 'low',
    roleTypes: ['site reliability engineer', 'data-center technician'],
    regionMultipliers: { NA: 1.0, EMEA: 1.1, APAC: 1.0 },
    notes: 'DC ops headcount is smaller but training cost on new processes is real.',
  },
];

const PROFILE_BY_SECTOR: ReadonlyMap<Sector, SectorLaborTemplate> = new Map(
  SECTOR_PROFILES.map(p => [p.sector, p]),
);

// ============================================================================
// Free-text override patterns
// ============================================================================
//
// Some queries need to bump intensity up (e.g. an internal-tooling project
// that explicitly mentions a 5,000-agent contact center) or down (e.g. a
// hospitality query that's actually about a SaaS dashboard for hoteliers).
// These patterns are evaluated AFTER the sector lookup and override the
// resulting intensity.

interface OverridePattern {
  readonly direction: 'up' | 'down';
  readonly target: LaborIntensity;
  readonly pattern: RegExp;
  readonly reason: string;
}

const OVERRIDE_PATTERNS: readonly OverridePattern[] = [
  {
    direction: 'down',
    target: 'low',
    pattern: /\b(?:internal\s+(?:dev\s+tool|tooling|dashboard)|developer\s+productivity|engineering\s+velocity)\b/i,
    reason: 'Internal developer tooling — knowledge workers only, no operational labor exposure.',
  },
  {
    direction: 'down',
    target: 'low',
    pattern: /\b(?:saas|api\s+gateway|micro[-\s]?service|library|sdk|cli\s+tool)\b/i,
    reason: 'Pure-software engagement — labor exposure limited to engineering team.',
  },
  {
    direction: 'up',
    target: 'high',
    pattern: /\b(?:contact\s*center|call\s*center|warehouse\s+pickers?|housekeep|union(?:ized)?|works\s+council)\b/i,
    reason: 'Query explicitly references operational labor — workforce impact required.',
  },
];

// ============================================================================
// Public API
// ============================================================================

const LOW_DEFAULT: LaborProfile = {
  intensity: 'low',
  sector: 'unknown',
  roleTypes: [],
  unionizationRisk: 'low',
  regionMultipliers: { NA: 1.0, EMEA: 1.0, APAC: 1.0 },
  reasoning: 'No labor-intensive sector detected and no override pattern matched.',
};

/**
 * ADR-PIPELINE-070: classify the labor intensity of an engagement.
 *
 * Inputs:
 *   - `domainAnalysis` — when present, its `domain` field is treated as the
 *     authoritative sector hint (from ADR-PIPELINE-041's pipeline output).
 *   - `query` — free-text query, used both for sector detection and for
 *     intensity-override patterns.
 *
 * The function never throws. Unknown sectors return the LOW_DEFAULT profile.
 */
export function classifyLaborIntensity(
  domainAnalysis: DomainAnalysis | null,
  query: string,
): LaborProfile {
  const sectorHint = domainAnalysis?.domain ?? null;
  const sector = classifySector(query, sectorHint);
  const template = PROFILE_BY_SECTOR.get(sector);

  let profile: LaborProfile = template
    ? {
        intensity: template.intensity,
        sector,
        roleTypes: template.roleTypes,
        unionizationRisk: template.unionizationRisk,
        regionMultipliers: template.regionMultipliers,
        reasoning: `Sector "${sector}" → ${template.intensity} labor intensity. ${template.notes}`,
      }
    : { ...LOW_DEFAULT, sector };

  // Apply override patterns. Down-overrides win over up-overrides for
  // genuinely soft engagements (a SaaS-for-hoteliers query should be low,
  // not high, even though "hotel" matches the sector classifier).
  for (const ov of OVERRIDE_PATTERNS) {
    if (!ov.pattern.test(query)) continue;
    if (ov.direction === 'down' && intensityRank(profile.intensity) > intensityRank(ov.target)) {
      profile = { ...profile, intensity: ov.target, reasoning: ov.reason };
      break;
    }
    if (ov.direction === 'up' && intensityRank(profile.intensity) < intensityRank(ov.target)) {
      profile = { ...profile, intensity: ov.target, reasoning: ov.reason };
      // Don't break — a later down-override should still win.
    }
  }

  return profile;
}

function intensityRank(i: LaborIntensity): number {
  return i === 'high' ? 2 : i === 'medium' ? 1 : 0;
}

/** True when the renderer must inject workforce content. */
export function isLaborIntensive(profile: LaborProfile): boolean {
  return profile.intensity !== 'low';
}

// ============================================================================
// Workforce template rows for the risk register (ADR-070 §2)
// ============================================================================

export interface WorkforceRiskRow {
  readonly category: string;
  readonly risk: string;
  readonly likelihood: 'High' | 'Medium' | 'Low';
  readonly severity: 'High' | 'Medium' | 'Low';
  readonly owner: string;
  readonly mitigation: string;
  readonly template: true;
}

export function workforceRiskTemplate(profile: LaborProfile): readonly WorkforceRiskRow[] {
  const rows: WorkforceRiskRow[] = [
    {
      category: 'workforce',
      risk: 'Labor reallocation disputes',
      likelihood: 'Medium',
      severity: 'High',
      owner: 'HR + Ops',
      mitigation: 'Joint labor/ops working group convened before pilot start.',
      template: true,
    },
    {
      category: 'workforce',
      risk: 'EMEA works-council consultation obligation',
      likelihood: profile.unionizationRisk === 'high' ? 'High' : 'Medium',
      severity: 'Medium',
      owner: 'Legal + Regional HR',
      mitigation: 'CSRD-aligned notice period; minimum 30 days before EMEA rollout.',
      template: true,
    },
    {
      category: 'workforce',
      risk: 'Change-management cost underestimated',
      likelihood: 'Medium',
      severity: 'Medium',
      owner: 'Pilot PM',
      mitigation: 'Dedicated change budget = 12% of pilot investment, tracked separately.',
      template: true,
    },
    {
      category: 'workforce',
      risk: 'Role attrition from perceived job loss',
      likelihood: 'Medium',
      severity: 'High',
      owner: 'HR',
      mitigation: 'Explicit no-reduction commitment communicated for the pilot window.',
      template: true,
    },
    {
      category: 'workforce',
      risk: 'Training burden on line managers',
      likelihood: 'High',
      severity: 'Low',
      owner: 'Ops',
      mitigation: 'Train-the-trainer model; cap at 4 hours per manager.',
      template: true,
    },
  ];
  return rows;
}

// ============================================================================
// Workforce exposure for the financial analysis block (ADR-070 §3)
// ============================================================================

export interface WorkforceExposure {
  readonly rolesAffected: number;
  readonly emeaUnionExposure: number;
  readonly changeMgmtBudgetLowUsd: number;
  readonly changeMgmtBudgetHighUsd: number;
  readonly changeMgmtPct: number;
  readonly reallocationNeutral: boolean;
  readonly primaryRoleLabel: string;
}

interface WorkforceExposureInputs {
  /** Total enterprise headcount (for context only — never the savings base). */
  readonly employees: number;
  /** Operational units (rooms, sqft, vehicles, ...) when known. */
  readonly operationalUnits?: number;
  /** Pilot investment range mid-point in USD — basis for change-mgmt budget. */
  readonly pilotInvestmentUsd?: number;
}

const ROLES_PER_OPERATIONAL_UNIT: Partial<Record<Sector, number>> = {
  hospitality: 0.085,        // ~1 housekeeper per 12 rooms
  retail: 18,                // ~18 floor staff per store
  fleet: 1.05,               // driver + relief + occasional mechanic per vehicle
  healthcare: 1.6,           // nurses + aides per bed
  'call-center': 1.0,        // 1 role per agent
  manufacturing: 35,         // line workers per plant
  'commercial-real-estate': 0.0006, // ~6 facility ops per 10K sqft
  'data-center': 0.0008,
};

const ROLE_LABEL: Partial<Record<Sector, string>> = {
  hospitality: 'housekeepers',
  retail: 'floor associates',
  fleet: 'drivers',
  healthcare: 'nurses',
  'call-center': 'contact-center agents',
  manufacturing: 'line operators',
  'commercial-real-estate': 'facility ops',
  'data-center': 'data-center technicians',
};

export function estimateWorkforceExposure(
  profile: LaborProfile,
  inputs: WorkforceExposureInputs,
): WorkforceExposure | null {
  if (!isLaborIntensive(profile)) return null;
  const sector = profile.sector;
  const ratio = ROLES_PER_OPERATIONAL_UNIT[sector] ?? 0;

  // Prefer operational-unit math when available; fall back to a coarse
  // headcount fraction so the block is never zero.
  let rolesAffected = 0;
  if (inputs.operationalUnits && ratio > 0) {
    rolesAffected = Math.round(inputs.operationalUnits * ratio);
  }
  if (rolesAffected <= 0 && inputs.employees > 0) {
    // Coarse fallback: assume 5–15% of headcount when sector is high intensity.
    const frac = profile.intensity === 'high' ? 0.1 : 0.04;
    rolesAffected = Math.round(inputs.employees * frac);
  }
  rolesAffected = Math.max(rolesAffected, 1);

  const emeaShare = profile.regionMultipliers.EMEA / Object.values(profile.regionMultipliers).reduce((s, v) => s + v, 0);
  const emeaUnionExposure = profile.unionizationRisk === 'low'
    ? 0
    : Math.round(rolesAffected * emeaShare);

  const changeMgmtPct = 0.12;
  const pilot = inputs.pilotInvestmentUsd ?? 1_000_000;
  const changeMgmtBudgetLowUsd = Math.round(pilot * changeMgmtPct);
  const changeMgmtBudgetHighUsd = Math.round(pilot * changeMgmtPct * 1.4);

  return {
    rolesAffected,
    emeaUnionExposure,
    changeMgmtBudgetLowUsd,
    changeMgmtBudgetHighUsd,
    changeMgmtPct,
    reallocationNeutral: true,
    primaryRoleLabel: ROLE_LABEL[sector] ?? 'operational staff',
  };
}

// ============================================================================
// RACI injection for the decision memo (ADR-070 §4)
// ============================================================================

export interface WorkforceRaciRow {
  readonly role: string;
  readonly responsibility: 'Responsible' | 'Accountable' | 'Consulted' | 'Informed';
  readonly cadence: string;
  readonly template: true;
}

export function workforceRaciTemplate(profile: LaborProfile): readonly WorkforceRaciRow[] {
  if (!isLaborIntensive(profile)) return [];
  return [
    { role: 'HR', responsibility: 'Consulted', cadence: 'Every phase gate', template: true },
    {
      role: 'Legal',
      responsibility: 'Consulted',
      cadence:
        profile.unionizationRisk === 'high'
          ? 'Required before EMEA rollout (works-council obligations)'
          : 'Required before any cross-region rollout',
      template: true,
    },
    {
      role: 'Regional HR leads',
      responsibility: 'Informed',
      cadence: 'Weekly cadence during pilot',
      template: true,
    },
  ];
}

// ============================================================================
// Sensitivity row for the tornado chart (ADR-070 §5)
// ============================================================================

export interface WorkforceSensitivityRow {
  readonly variable: string;
  readonly range: string;
  readonly impactPctOfPilot: number;
  readonly reasoning: string;
}

export function workforceSensitivityRow(profile: LaborProfile): WorkforceSensitivityRow | null {
  if (!isLaborIntensive(profile)) return null;
  return {
    variable: 'Change management budget overrun',
    range: '+20% / +50%',
    impactPctOfPilot: 0.18,
    reasoning:
      profile.intensity === 'high'
        ? 'High labor intensity — change-management overruns dominate pilot risk.'
        : 'Moderate labor exposure — overruns affect ROI but not direction.',
  };
}

// ============================================================================
// Persistence shape — written to <runDir>/labor-profile.json
// ============================================================================

export interface LaborProfileArtifact {
  readonly version: '1.0';
  readonly generated_at: string;
  readonly profile: LaborProfile;
  readonly exposure: WorkforceExposure | null;
}

export function buildLaborProfileArtifact(
  profile: LaborProfile,
  exposure: WorkforceExposure | null,
): LaborProfileArtifact {
  return {
    version: '1.0',
    generated_at: new Date().toISOString(),
    profile,
    exposure,
  };
}
