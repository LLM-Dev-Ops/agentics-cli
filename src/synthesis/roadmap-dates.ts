/**
 * ADR-PIPELINE-079: Absolute-Date Roadmap with Pilot-Start Anchor.
 *
 * Pure functions. Given a query, optional config, and optional manifest,
 * resolve a pilot start date and project every phase / gate onto the
 * calendar with absolute ISO dates.
 *
 * No I/O — results consumed by buildRoadmapArtifact and renderDecisionMemo.
 */

// ============================================================================
// Pilot start resolution
// ============================================================================

export type PilotStartSource = 'query' | 'config' | 'manifest' | 'default';

export interface PilotStartResolution {
  /** ISO date (YYYY-MM-DD). */
  readonly startDate: string;
  readonly source: PilotStartSource;
  readonly reasoning: string;
}

/**
 * ADR-PIPELINE-079 §1: Resolve the pilot start date from four sources in
 * priority order:
 *
 *   1. Query text — explicit date or quarter reference
 *   2. Config — `pilot.startDate` field
 *   3. Manifest — `pilot_start_date` field
 *   4. Default — today + 14 days, rounded up to next Monday
 */
export function resolvePilotStart(
  query: string,
  config?: { pilot?: { startDate?: string } } | null,
  manifest?: { pilot_start_date?: string } | null,
  now: Date = new Date(),
): PilotStartResolution {
  // 1. Query parse
  const queryDate = parseDateFromQuery(query);
  if (queryDate) {
    return {
      startDate: queryDate.date,
      source: 'query',
      reasoning: `Extracted "${queryDate.rawMatch}" from the query text.`,
    };
  }

  // 2. Config
  if (config?.pilot?.startDate) {
    return {
      startDate: config.pilot.startDate,
      source: 'config',
      reasoning: 'Pilot start date from AppConfig.pilot.startDate.',
    };
  }

  // 3. Manifest
  if (manifest?.pilot_start_date) {
    return {
      startDate: manifest.pilot_start_date,
      source: 'manifest',
      reasoning: 'Pilot start date from simulation manifest.pilot_start_date.',
    };
  }

  // 4. Default — today + 14 days, rounded up to next Monday
  const defaultDate = nextMonday(addDays(now, 14));
  return {
    startDate: toISODate(defaultDate),
    source: 'default',
    reasoning: `Default: today (${toISODate(now)}) + 14 days, rounded to next Monday.`,
  };
}

// ============================================================================
// Query date parsing
// ============================================================================

interface QueryDateMatch {
  date: string;
  rawMatch: string;
}

const DATE_PATTERNS: Array<{ re: RegExp; extract: (match: RegExpMatchArray) => string | null }> = [
  {
    // "starting 2026-05-01" or "kickoff 2026-06-15"
    re: /(?:start(?:ing)?|kick\s*off|begin(?:ning)?)\s+(?:on\s+)?(\d{4}-\d{2}-\d{2})/i,
    extract: (m) => m[1] ?? null,
  },
  {
    // "2026-05-01 as pilot start"
    re: /(\d{4}-\d{2}-\d{2})\s+(?:as\s+)?(?:the\s+)?pilot\s+start/i,
    extract: (m) => m[1] ?? null,
  },
  {
    // "beginning of Q3 2026" → first day of that quarter
    re: /beginning\s+of\s+(Q[1-4])\s+(\d{4})/i,
    extract: (m) => {
      const q = m[1]?.toUpperCase();
      const year = m[2];
      if (!q || !year) return null;
      const monthMap: Record<string, string> = { Q1: '01', Q2: '04', Q3: '07', Q4: '10' };
      const month = monthMap[q];
      if (!month) return null;
      return `${year}-${month}-01`;
    },
  },
  {
    // "starting June 1 2026" or "kickoff May 15, 2026"
    re: /(?:start(?:ing)?|kick\s*off|begin(?:ning)?)\s+(?:on\s+)?(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),?\s+(\d{4})/i,
    extract: (m) => {
      const month = monthNumber(m[1]);
      const day = m[2]?.padStart(2, '0');
      const year = m[3];
      if (!month || !day || !year) return null;
      return `${year}-${month}-${day}`;
    },
  },
];

function parseDateFromQuery(query: string): QueryDateMatch | null {
  for (const { re, extract } of DATE_PATTERNS) {
    const match = query.match(re);
    if (match) {
      const date = extract(match);
      if (date) return { date, rawMatch: match[0] };
    }
  }
  return null;
}

function monthNumber(name?: string): string | null {
  if (!name) return null;
  const months: Record<string, string> = {
    january: '01', february: '02', march: '03', april: '04',
    may: '05', june: '06', july: '07', august: '08',
    september: '09', october: '10', november: '11', december: '12',
  };
  return months[name.toLowerCase()] ?? null;
}

// ============================================================================
// Date projection
// ============================================================================

export interface DatedPhase {
  readonly id: string;
  readonly name: string;
  readonly startDate: string;
  readonly endDate: string;
  readonly durationWeeks: number;
}

export interface DatedGate {
  readonly afterPhase: string;
  readonly gateDate: string;
}

/**
 * Parse a duration string like "2-4 weeks" or "4-8 weeks" and return the
 * midpoint in weeks (rounded up). Falls back to 3 when the string can't
 * be parsed.
 */
export function parseDurationWeeks(duration: string): number {
  const m = duration.match(/(\d+)\s*-\s*(\d+)\s*weeks?/i);
  if (m && m[1] && m[2]) {
    return Math.ceil((parseInt(m[1], 10) + parseInt(m[2], 10)) / 2);
  }
  const single = duration.match(/(\d+)\s*weeks?/i);
  if (single && single[1]) return parseInt(single[1], 10);
  return 3;
}

/**
 * Project absolute dates onto an ordered list of phases. Each phase starts
 * the day after the previous phase ends. The first phase starts on `startDate`.
 *
 * Returns:
 *   - `phases` with `startDate`, `endDate`, `durationWeeks`
 *   - `gates` with one entry per inter-phase boundary carrying `gateDate`
 *     (= the endDate of the preceding phase)
 */
export function projectDates(
  startDate: string,
  phases: ReadonlyArray<{ id: string; name: string; duration: string }>,
): { datedPhases: DatedPhase[]; datedGates: DatedGate[] } {
  const datedPhases: DatedPhase[] = [];
  const datedGates: DatedGate[] = [];
  let cursor = parseISODate(startDate);

  for (let i = 0; i < phases.length; i++) {
    const phase = phases[i]!;
    const weeks = parseDurationWeeks(phase.duration);
    const phaseStart = cursor;
    const phaseEnd = addDays(phaseStart, weeks * 7 - 1);
    datedPhases.push({
      id: phase.id,
      name: phase.name,
      startDate: toISODate(phaseStart),
      endDate: toISODate(phaseEnd),
      durationWeeks: weeks,
    });
    // Gate sits at the end of each phase (except the last)
    if (i < phases.length - 1) {
      datedGates.push({
        afterPhase: phase.id,
        gateDate: toISODate(phaseEnd),
      });
    }
    // Next phase starts the day after this one ends
    cursor = addDays(phaseEnd, 1);
  }

  return { datedPhases, datedGates };
}

// ============================================================================
// Date formatting
// ============================================================================

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;
const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
] as const;

/** Format an ISO date string as "Friday, May 10, 2026". */
export function renderAbsoluteDate(iso: string): string {
  const d = parseISODate(iso);
  const dayName = DAY_NAMES[d.getUTCDay()]!;
  const monthName = MONTH_NAMES[d.getUTCMonth()]!;
  const day = d.getUTCDate();
  const year = d.getUTCFullYear();
  return `${dayName}, ${monthName} ${day}, ${year}`;
}

// ============================================================================
// Date arithmetic helpers
// ============================================================================

export function addDays(date: Date, days: number): Date {
  const result = new Date(date.getTime());
  result.setUTCDate(result.getUTCDate() + days);
  return result;
}

export function nextMonday(date: Date): Date {
  const dayOfWeek = date.getUTCDay(); // 0=Sun, 1=Mon, ...
  if (dayOfWeek === 1) return date; // already Monday
  const daysUntilMonday = dayOfWeek === 0 ? 1 : 8 - dayOfWeek;
  return addDays(date, daysUntilMonday);
}

export function toISODate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function parseISODate(iso: string): Date {
  return new Date(iso + 'T00:00:00Z');
}
