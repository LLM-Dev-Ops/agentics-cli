/**
 * ADR-PIPELINE-066: Domain Unit Registry
 *
 * Maps a detected sector to its domain unit (the thing savings actually scale
 * with) and a savings-base formula. Replaces per-employee heuristics whenever
 * a sector in this registry is detected.
 *
 * Pure functions — no I/O.
 */

import type { DomainUnit } from '../pipeline/types.js';

export type Sector =
  | 'hospitality'
  | 'commercial-real-estate'
  | 'fleet'
  | 'retail'
  | 'manufacturing'
  | 'healthcare'
  | 'data-center'
  | 'call-center'
  | 'airline-catering'
  | 'unknown';

export interface SectorRegistryEntry {
  readonly sector: Exclude<Sector, 'unknown'>;
  readonly domainUnit: DomainUnit;
  /** Keys this sector expects in UnitEconomicsScope (primary first). */
  readonly scopeKeys: readonly string[];
  /**
   * Formula description for rendering. e.g. "rooms × occupancy × $/orn".
   * Not evaluated — just displayed so reviewers see the unit economics.
   */
  readonly savingsFormula: string;
  /** Unit savings key expected in UnitEconomics.unit_savings. */
  readonly unitSavingsKey: string;
}

/**
 * The eight sectors called out in ADR-PIPELINE-066 §3.
 * Order matters for classification — more specific patterns first.
 */
export const SECTOR_REGISTRY: readonly SectorRegistryEntry[] = [
  {
    sector: 'hospitality',
    domainUnit: { label: 'occupied room night', abbrev: 'orn' },
    scopeKeys: ['rooms', 'properties'],
    savingsFormula: 'rooms × occupancy × $/occupied-room-night',
    unitSavingsKey: 'usd_per_orn',
  },
  {
    sector: 'commercial-real-estate',
    domainUnit: { label: 'square foot-year', abbrev: 'sqft-yr' },
    scopeKeys: ['sqft', 'properties'],
    savingsFormula: 'sqft × $/sqft-year',
    unitSavingsKey: 'usd_per_sqft_year',
  },
  {
    sector: 'fleet',
    domainUnit: { label: 'vehicle-mile', abbrev: 'vmi' },
    scopeKeys: ['vehicles'],
    savingsFormula: 'fleet × miles × $/mile',
    unitSavingsKey: 'usd_per_vehicle_mile',
  },
  {
    sector: 'retail',
    domainUnit: { label: 'transaction', abbrev: 'txn' },
    scopeKeys: ['properties', 'units'],
    savingsFormula: 'daily transactions × 365 × $/transaction',
    unitSavingsKey: 'usd_per_transaction',
  },
  {
    sector: 'manufacturing',
    domainUnit: { label: 'unit produced', abbrev: 'unit' },
    scopeKeys: ['units'],
    savingsFormula: 'throughput × $/unit',
    unitSavingsKey: 'usd_per_unit_produced',
  },
  {
    sector: 'healthcare',
    domainUnit: { label: 'patient-day', abbrev: 'pday' },
    scopeKeys: ['beds'],
    savingsFormula: 'census × $/patient-day',
    unitSavingsKey: 'usd_per_patient_day',
  },
  {
    sector: 'data-center',
    domainUnit: { label: 'kilowatt-hour', abbrev: 'kWh' },
    scopeKeys: ['units'],
    savingsFormula: 'load × 8760 × $/kWh',
    unitSavingsKey: 'usd_per_kwh',
  },
  {
    sector: 'call-center',
    domainUnit: { label: 'contact minute', abbrev: 'cmin' },
    scopeKeys: ['agents'],
    savingsFormula: 'agents × minutes × $/contact-minute',
    unitSavingsKey: 'usd_per_contact_minute',
  },
  {
    sector: 'airline-catering',
    domainUnit: { label: 'meal loaded', abbrev: 'meal' },
    scopeKeys: ['units', 'properties'],
    savingsFormula: 'meals × flights × 365 × $/meal-loaded',
    unitSavingsKey: 'usd_per_meal_loaded',
  },
];

const REGISTRY_BY_SECTOR: ReadonlyMap<Sector, SectorRegistryEntry> = new Map(
  SECTOR_REGISTRY.map(e => [e.sector as Sector, e]),
);

export function getSectorEntry(sector: Sector): SectorRegistryEntry | null {
  return REGISTRY_BY_SECTOR.get(sector) ?? null;
}

// ============================================================================
// Classification
// ============================================================================
//
// Classification is strict-first (explicit domain words) then soft (industry
// words). Returns 'unknown' when nothing matches — callers then fall back to
// per-employee heuristics and emit the ADR-066 §2 warning banner.

interface SectorRule {
  sector: Exclude<Sector, 'unknown'>;
  patterns: readonly RegExp[];
}

// Hard patterns: unambiguous sector indicators that lock the classification.
// Order matters — airline-catering must be checked BEFORE hospitality because
// an airline-catering query ("in-flight catering", "meals") might otherwise
// match "catering" as hospitality-adjacent.
const HARD_RULES: readonly SectorRule[] = [
  {
    sector: 'airline-catering',
    patterns: [
      /\bin[-\s]?flight\s+catering\b/i,
      /\bairline\s+catering\b/i,
      /\bflight\s+catering\b/i,
      /\bmeal\s+planning\b/i,
      /\bmeals?\s+(?:loaded|per\s+flight)\b/i,
      /\bgalley\s+catering\b/i,
      /\b(?:airline|carrier)\s+(?:meal|food|galley)\b/i,
    ],
  },
  // commercial-real-estate is checked BEFORE hospitality so an office-with-
  // occupancy brief (the canonical Archibus / workplace-strategy shape) wins
  // over the loose `occupanc` token. ADR-PIPELINE-095 calibration: the
  // originating run `911d93ad-...` (water-usage / Archibus brief) was
  // misclassified as hospitality because hospitality matched "occupancy"
  // first; the brief had every CRE signal (Archibus, offices, facilities
  // management, space planning, workplace strategy) but none of the narrow
  // patterns hit. Both lists below are widened/tightened to match the
  // realistic shape of CRE briefs.
  {
    sector: 'commercial-real-estate',
    patterns: [
      /\bcommercial\s+real\s+estate\b/i,
      /\bArchibus\b/i,                                  // CRE / IWMS platform — strong signal
      /\boffice\s+portfolio\b/i,
      /\boffice\s+space\b/i,                            // "office space" (often pluralized)
      /\boffice\s+(?:layout|consolidat|utiliz|occupanc|usage|optim)/i,
      /\b(?:office|building|space|workspace|workplace)s?\s+(?:are\s+)?(?:underu(?:sed|tiliz)|consolidat)/i,
      /\bhybrid\s+work\s+(?:strateg|optim|utiliz|space|polic|pattern)/i,
      /\bbuilding\s+portfolio\b/i,
      /\bworkplace\s+(?:optim|utiliz|strateg|plan)/i,    // includes "workplace strategy"
      /\bsqft\b/i,
      /\bsquare\s+f(?:oot|eet)\b/i,
      /\bfacilit(?:y|ies)\s+management\b/i,             // handle plural "facilities management"
      /\bspace\s+(?:planning|utiliz|optimiz|consolidat)/i,
      /\boffice\s+(?:and|&)\s+occupanc/i,               // "office and occupancy data"
    ],
  },
  {
    sector: 'hospitality',
    patterns: [
      /\bhotel\b/i,
      /\bhousekeep/i,
      /\blodging\b/i,
      /\bhospitality\b/i,
      /\bresort\b/i,
      /\broom\s*night/i,
      // Tightened: bare `occupanc` was matching offices. Require a
      // hotel-shaped context word to avoid catching CRE briefs that talk
      // about office occupancy. `room` alone is dropped because office
      // briefs commonly say "meeting room occupancy" / "conference room
      // occupancy"; `room night` (above) still catches the hospitality form.
      // CRE patterns earlier already win on those.
      /\b(?:hotel|lodging|resort|guest)\s+occupanc/i,
    ],
  },
  {
    sector: 'fleet',
    patterns: [
      /\bfleet\b/i,
      /\b(?:truck|vehicle)\s+fleet\b/i,
      /\bEV\s+transition\b/i,
      /\bfleet\s+electrification\b/i,
      /\btransportation\s+(?:cost|fuel)/i,
    ],
  },
  {
    sector: 'retail',
    patterns: [
      /\bretail\s+chain\b/i,
      /\bstores?\b/i,
      /\bgrocery\b/i,
      /\bpoint[-\s]?of[-\s]?sale\b/i,
      /\bregister\s+throughput\b/i,
    ],
  },
  {
    sector: 'manufacturing',
    patterns: [
      /\bmanufactur/i,
      /\bfactory\b/i,
      /\bproduction\s+line\b/i,
      /\bassembly\s+line\b/i,
      /\bOEE\b/i,
    ],
  },
  {
    sector: 'healthcare',
    patterns: [
      /\bhospital\b/i,
      /\bclinic\b/i,
      /\bpatient\b/i,
      /\bnurs(?:e|ing)\b/i,
      /\bhealthcare\b/i,
      /\bhealth\s*system\b/i,
    ],
  },
  {
    sector: 'data-center',
    patterns: [
      /\bdata\s*center\b/i,
      /\bdatacenter\b/i,
      /\bPUE\b/i,
      /\bserver\s+farm\b/i,
      /\bcolocation\b/i,
    ],
  },
  {
    sector: 'call-center',
    patterns: [
      /\bcall\s*center\b/i,
      /\bcontact\s*center\b/i,
      /\bBPO\b/i,
      /\bagent\s+productivity\b/i,
      /\bcustomer\s+service\s+center\b/i,
    ],
  },
];

/**
 * Classify a query into a sector from the registry, or 'unknown'.
 * Prefers an explicit sector hint (from domain_analysis.sector) when provided.
 */
export function classifySector(
  query: string,
  sectorHint?: string | null,
): Sector {
  if (sectorHint) {
    const normalized = normalizeSectorHint(sectorHint);
    if (normalized !== 'unknown') return normalized;
  }
  for (const rule of HARD_RULES) {
    if (rule.patterns.some(p => p.test(query))) return rule.sector;
  }
  return 'unknown';
}

function normalizeSectorHint(hint: string): Sector {
  const h = hint.toLowerCase().trim();
  // airline-catering checked BEFORE hospitality so "hotel catering" doesn't misclassify
  if (/airline[-\s]catering|in[-\s]?flight|flight[-\s]catering|galley/.test(h)) return 'airline-catering';
  if (/hospitality|hotel|lodging|resort/.test(h)) return 'hospitality';
  if (/commercial[-\s]real[-\s]estate|cre\b|office|workplace|building/.test(h)) return 'commercial-real-estate';
  if (/fleet|transportation|vehicle/.test(h)) return 'fleet';
  if (/retail|store/.test(h)) return 'retail';
  if (/manufactur|factory|production/.test(h)) return 'manufacturing';
  if (/healthcare|hospital|clinic|patient/.test(h)) return 'healthcare';
  if (/data[-\s]?center|datacenter/.test(h)) return 'data-center';
  if (/call[-\s]?center|contact[-\s]?center|bpo/.test(h)) return 'call-center';
  return 'unknown';
}

// ============================================================================
// Domain Scale Extraction — ADR-PIPELINE-066 §4
// ============================================================================

export interface DomainScale {
  /** Employees — still available for context, NOT as a savings multiplicand. */
  readonly employees: number;
  /** Primary operational units (rooms, sqft, vehicles, etc.). */
  readonly operationalUnits: number;
  /** Human-readable label for the operational unit. */
  readonly unitLabel: string;
  /** Short form for display. */
  readonly unitAbbrev: string;
  /** Detected sector or 'unknown'. */
  readonly sector: Sector;
  /** Where the operational count came from. */
  readonly source: 'prototype' | 'query-regex' | 'default';
}

/** Extract employee count from free text. Used for context only. */
export function extractEmployeeCountFromText(query: string): number {
  const lower = query.toLowerCase();
  let employees = 10000;
  const empIdx = lower.indexOf('employees');
  const staffIdx = lower.indexOf('staff');
  const targetIdx = empIdx !== -1 ? empIdx : staffIdx;
  if (targetIdx > 5) {
    const before = query.substring(Math.max(0, targetIdx - 30), targetIdx).trim();
    const words = before.split(/\s+/);
    for (let i = words.length - 1; i >= 0; i--) {
      const cleaned = (words[i] ?? '').replace(/,/g, '').replace(/approximately/i, '').trim();
      const num = parseInt(cleaned, 10);
      if (num > 100 && num < 10_000_000) {
        employees = num;
        break;
      }
    }
  }
  return employees;
}

interface UnitPatternRule {
  pattern: RegExp;
  sector: Exclude<Sector, 'unknown' | 'data-center'>;
  unitLabel: string;
  unitAbbrev: string;
}

const UNIT_PATTERNS: readonly UnitPatternRule[] = [
  { pattern: /(\d[\d,]*)\s*(?:flights?|aircraft)/i, sector: 'airline-catering', unitLabel: 'flights', unitAbbrev: 'flights' },
  { pattern: /(\d[\d,]*)\s*(?:hotels?|properties|resorts?)/i, sector: 'hospitality', unitLabel: 'rooms', unitAbbrev: 'rooms' },
  { pattern: /(\d[\d,]*)\s*(?:rooms?)\b/i, sector: 'hospitality', unitLabel: 'rooms', unitAbbrev: 'rooms' },
  { pattern: /(\d[\d,]*)\s*(?:buildings?|offices?|sites?)/i, sector: 'commercial-real-estate', unitLabel: 'sqft', unitAbbrev: 'sqft' },
  { pattern: /(\d[\d,]*)\s*(?:vehicles?|trucks?|vans?|cars?)/i, sector: 'fleet', unitLabel: 'vehicles', unitAbbrev: 'vehicles' },
  { pattern: /(\d[\d,]*)\s*(?:stores?|locations?|outlets?|branches?)/i, sector: 'retail', unitLabel: 'stores', unitAbbrev: 'stores' },
  { pattern: /(\d[\d,]*)\s*(?:plants?|factor(?:y|ies))/i, sector: 'manufacturing', unitLabel: 'plants', unitAbbrev: 'plants' },
  { pattern: /(\d[\d,]*)\s*(?:beds?|patients?)/i, sector: 'healthcare', unitLabel: 'beds', unitAbbrev: 'beds' },
  { pattern: /(\d[\d,]*)\s*(?:agents?)/i, sector: 'call-center', unitLabel: 'agents', unitAbbrev: 'agents' },
];

/**
 * ADR-PIPELINE-066 §4: Replace `extractEmployeeCount` with a richer shape that
 * carries the operational unit *and* its source. Savings math that used to
 * multiply `employees * ratio` must now multiply `operationalUnits * ratio`
 * whenever `source !== 'default'`.
 */
export function extractDomainScale(
  query: string,
  sectorHint?: string | null,
): DomainScale {
  const employees = extractEmployeeCountFromText(query);
  const sector = classifySector(query, sectorHint);

  // Prefer an explicit unit count in the query over sector-based fallback.
  for (const rule of UNIT_PATTERNS) {
    const match = query.match(rule.pattern);
    if (match?.[1]) {
      const count = parseInt(match[1].replace(/,/g, ''), 10);
      if (count > 0) {
        return {
          employees,
          operationalUnits: count,
          unitLabel: rule.unitLabel,
          unitAbbrev: rule.unitAbbrev,
          sector: sector === 'unknown' ? rule.sector : sector,
          source: 'query-regex',
        };
      }
    }
  }

  // Sector-based ratios when no explicit count was given. These are
  // intentionally coarse — the goal is to produce a plausible operational
  // unit count, NOT to compute savings. Savings come from unit-economics.json.
  if (sector !== 'unknown') {
    const entry = getSectorEntry(sector);
    const primaryKey = entry?.scopeKeys[0] ?? 'units';
    const ratios: Record<string, number> = {
      rooms: 0.02,        // ~1 room per 50 employees (hotel avg)
      sqft: 200,          // ~200 sqft per employee
      vehicles: 0.05,     // ~5% of workforce drives fleet
      stores: 0.005,      // ~1 store per 200 employees
      plants: 0.001,      // ~1 plant per 1000 employees
      beds: 0.2,          // ~1 bed per 5 staff
      agents: 0.3,        // ~30% of headcount
      units: 0.1,
      properties: 0.002,
    };
    const ratio = ratios[primaryKey] ?? 0.1;
    const operationalUnits = Math.max(1, Math.round(employees * ratio));
    return {
      employees,
      operationalUnits,
      unitLabel: primaryKey,
      unitAbbrev: primaryKey,
      sector,
      source: 'query-regex',
    };
  }

  return {
    employees,
    operationalUnits: employees,
    unitLabel: 'employees',
    unitAbbrev: 'emp',
    sector: 'unknown',
    source: 'default',
  };
}
