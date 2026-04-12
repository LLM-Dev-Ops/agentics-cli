/**
 * ADR-PIPELINE-079 tests: absolute-date roadmap with pilot-start anchor.
 *
 * Verifies:
 *  - resolvePilotStart extracts dates from query, config, manifest, default
 *  - Query parsing handles ISO dates, "beginning of Q3 2026", "starting June 1 2026"
 *  - Default rounds to next Monday after today + 14 days
 *  - projectDates assigns startDate/endDate/durationWeeks to every phase
 *  - Gates carry gate_date = endDate of the preceding phase
 *  - parseDurationWeeks handles "2-4 weeks", "4 weeks", and fallback
 *  - renderAbsoluteDate formats correctly
 *  - buildRoadmapArtifact produces pilot_start metadata + phases with
 *    startDate/endDate + gates with gate_date
 */

import {
  resolvePilotStart,
  projectDates,
  parseDurationWeeks,
  renderAbsoluteDate,
  addDays,
  nextMonday,
  toISODate,
} from '../../../src/synthesis/roadmap-dates.js';
import { buildRoadmapArtifact } from '../../../src/synthesis/simulation-renderers.js';

// ============================================================================
// resolvePilotStart
// ============================================================================

describe('ADR-079 — resolvePilotStart', () => {
  it('extracts "starting 2026-05-01" from the query (source=query)', () => {
    const result = resolvePilotStart('We plan to begin starting 2026-05-01 with a pilot.', null, null);
    expect(result.startDate).toBe('2026-05-01');
    expect(result.source).toBe('query');
    expect(result.reasoning).toContain('starting 2026-05-01');
  });

  it('extracts "beginning of Q3 2026" from the query', () => {
    const result = resolvePilotStart('The pilot begins at the beginning of Q3 2026.', null, null);
    expect(result.startDate).toBe('2026-07-01');
    expect(result.source).toBe('query');
  });

  it('extracts "starting June 1 2026" from the query', () => {
    const result = resolvePilotStart('We are starting June 1 2026 with the first phase.', null, null);
    expect(result.startDate).toBe('2026-06-01');
    expect(result.source).toBe('query');
  });

  it('extracts "kickoff May 15, 2026" from the query', () => {
    const result = resolvePilotStart('Project kickoff May 15, 2026 for the pilot.', null, null);
    expect(result.startDate).toBe('2026-05-15');
    expect(result.source).toBe('query');
  });

  it('prefers query over config', () => {
    const result = resolvePilotStart(
      'starting 2026-05-01',
      { pilot: { startDate: '2026-08-01' } },
      null,
    );
    expect(result.startDate).toBe('2026-05-01');
    expect(result.source).toBe('query');
  });

  it('falls to config when query has no date', () => {
    const result = resolvePilotStart(
      'Reduce food waste in catering.',
      { pilot: { startDate: '2026-08-01' } },
      null,
    );
    expect(result.startDate).toBe('2026-08-01');
    expect(result.source).toBe('config');
  });

  it('falls to manifest when neither query nor config has a date', () => {
    const result = resolvePilotStart(
      'Reduce food waste.',
      null,
      { pilot_start_date: '2026-09-15' },
    );
    expect(result.startDate).toBe('2026-09-15');
    expect(result.source).toBe('manifest');
  });

  it('default rounds to next Monday after today + 14 days', () => {
    // Use a fixed "today" — Wednesday 2026-04-08
    const today = new Date('2026-04-08T12:00:00Z');
    const result = resolvePilotStart('Reduce food waste.', null, null, today);
    expect(result.source).toBe('default');
    // 2026-04-08 + 14d = 2026-04-22 (Wednesday), next Monday = 2026-04-27
    expect(result.startDate).toBe('2026-04-27');
  });

  it('default already on Monday stays on that Monday', () => {
    // 2026-04-06 is a Monday. +14d = 2026-04-20 (also Monday)
    const today = new Date('2026-04-06T12:00:00Z');
    const result = resolvePilotStart('Reduce food waste.', null, null, today);
    expect(result.startDate).toBe('2026-04-20');
  });
});

// ============================================================================
// parseDurationWeeks
// ============================================================================

describe('ADR-079 — parseDurationWeeks', () => {
  it('parses "2-4 weeks" as the midpoint (3)', () => {
    expect(parseDurationWeeks('2-4 weeks')).toBe(3);
  });

  it('parses "4-8 weeks" as the midpoint (6)', () => {
    expect(parseDurationWeeks('4-8 weeks')).toBe(6);
  });

  it('parses a single "4 weeks" literally', () => {
    expect(parseDurationWeeks('4 weeks')).toBe(4);
  });

  it('defaults to 3 when the string is unrecognized', () => {
    expect(parseDurationWeeks('about a month')).toBe(3);
  });
});

// ============================================================================
// projectDates
// ============================================================================

describe('ADR-079 — projectDates', () => {
  const phases = [
    { id: 'phase-1', name: 'Discovery', duration: '2 weeks' },
    { id: 'phase-2', name: 'Build', duration: '4 weeks' },
    { id: 'phase-3', name: 'Validate', duration: '2 weeks' },
  ];

  it('assigns startDate and endDate to each phase', () => {
    const { datedPhases } = projectDates('2026-05-01', phases);
    expect(datedPhases).toHaveLength(3);

    // Phase 1: 2026-05-01 to 2026-05-14 (2 weeks = 14 days, so end = start + 13)
    expect(datedPhases[0]!.startDate).toBe('2026-05-01');
    expect(datedPhases[0]!.endDate).toBe('2026-05-14');
    expect(datedPhases[0]!.durationWeeks).toBe(2);

    // Phase 2 starts the day after phase 1 ends
    expect(datedPhases[1]!.startDate).toBe('2026-05-15');
  });

  it('gate dates sit at the end of each phase (except the last)', () => {
    const { datedPhases, datedGates } = projectDates('2026-05-01', phases);
    expect(datedGates).toHaveLength(2);
    expect(datedGates[0]!.afterPhase).toBe('phase-1');
    expect(datedGates[0]!.gateDate).toBe(datedPhases[0]!.endDate);
    expect(datedGates[1]!.afterPhase).toBe('phase-2');
    expect(datedGates[1]!.gateDate).toBe(datedPhases[1]!.endDate);
  });

  it('phases are contiguous — no gaps between phases', () => {
    const { datedPhases } = projectDates('2026-05-01', phases);
    for (let i = 1; i < datedPhases.length; i++) {
      const prevEnd = new Date(datedPhases[i - 1]!.endDate + 'T00:00:00Z');
      const thisStart = new Date(datedPhases[i]!.startDate + 'T00:00:00Z');
      const daysBetween = (thisStart.getTime() - prevEnd.getTime()) / (1000 * 60 * 60 * 24);
      expect(daysBetween).toBe(1);
    }
  });
});

// ============================================================================
// renderAbsoluteDate
// ============================================================================

describe('ADR-079 — renderAbsoluteDate', () => {
  it('formats "2026-05-10" as "Sunday, May 10, 2026"', () => {
    expect(renderAbsoluteDate('2026-05-10')).toBe('Sunday, May 10, 2026');
  });

  it('formats "2026-01-01" as "Thursday, January 1, 2026"', () => {
    expect(renderAbsoluteDate('2026-01-01')).toBe('Thursday, January 1, 2026');
  });
});

// ============================================================================
// addDays + nextMonday + toISODate
// ============================================================================

describe('ADR-079 — date arithmetic helpers', () => {
  it('addDays advances correctly', () => {
    const d = new Date('2026-04-08T00:00:00Z');
    expect(toISODate(addDays(d, 14))).toBe('2026-04-22');
  });

  it('nextMonday advances a Wednesday to the following Monday', () => {
    const wed = new Date('2026-04-08T00:00:00Z'); // Wednesday
    expect(toISODate(nextMonday(wed))).toBe('2026-04-13');
  });

  it('nextMonday keeps a Monday as-is', () => {
    const mon = new Date('2026-04-06T00:00:00Z'); // Monday
    expect(toISODate(nextMonday(mon))).toBe('2026-04-06');
  });

  it('nextMonday advances a Sunday to the next day (Monday)', () => {
    const sun = new Date('2026-04-12T00:00:00Z'); // Sunday
    expect(toISODate(nextMonday(sun))).toBe('2026-04-13');
  });
});

// ============================================================================
// Integration — buildRoadmapArtifact
// ============================================================================

describe('ADR-079 — buildRoadmapArtifact absolute dates', () => {
  const QUERY = 'Reduce food waste from in-flight catering with 69,000 employees. Ramco Aviation ERP.';

  it('includes pilot_start metadata with source and reasoning', () => {
    const roadmap = buildRoadmapArtifact(QUERY, null, []);
    const ps = roadmap['pilot_start'] as { date: string; source: string; reasoning: string };
    expect(ps).toBeDefined();
    expect(ps.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(['query', 'config', 'manifest', 'default']).toContain(ps.source);
    expect(ps.reasoning.length).toBeGreaterThan(0);
  });

  it('every phase has startDate, endDate, and durationWeeks', () => {
    const roadmap = buildRoadmapArtifact(QUERY, null, []);
    const phases = roadmap['phases'] as Array<{
      id: string;
      startDate?: string;
      endDate?: string;
      durationWeeks?: number;
    }>;
    expect(phases.length).toBeGreaterThanOrEqual(3);
    for (const phase of phases) {
      expect(phase.startDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(phase.endDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(phase.durationWeeks).toBeGreaterThan(0);
    }
  });

  it('at least one phase gate has a gate_date field', () => {
    const roadmap = buildRoadmapArtifact(QUERY, null, []);
    const gates = roadmap['phase_gates'] as Array<{
      after_phase: string;
      gate_date?: string;
    }>;
    expect(gates.length).toBeGreaterThanOrEqual(1);
    const withDate = gates.filter(g => g.gate_date);
    expect(withDate.length).toBeGreaterThanOrEqual(1);
    expect(withDate[0]!.gate_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('extracts an explicit query date when provided', () => {
    const roadmap = buildRoadmapArtifact(
      'Reduce waste starting 2026-06-01. Ramco Aviation ERP.',
      null,
      [],
    );
    const ps = roadmap['pilot_start'] as { date: string; source: string };
    expect(ps.date).toBe('2026-06-01');
    expect(ps.source).toBe('query');
  });

  it('phases are contiguous (no gaps)', () => {
    const roadmap = buildRoadmapArtifact(QUERY, null, []);
    const phases = roadmap['phases'] as Array<{ startDate: string; endDate: string }>;
    for (let i = 1; i < phases.length; i++) {
      const prevEnd = new Date(phases[i - 1]!.endDate + 'T00:00:00Z');
      const thisStart = new Date(phases[i]!.startDate + 'T00:00:00Z');
      const daysBetween = (thisStart.getTime() - prevEnd.getTime()) / (1000 * 60 * 60 * 24);
      expect(daysBetween).toBe(1);
    }
  });
});
