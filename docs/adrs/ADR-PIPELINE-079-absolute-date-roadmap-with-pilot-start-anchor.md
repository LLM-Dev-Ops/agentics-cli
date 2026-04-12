# ADR-PIPELINE-079: Absolute-Date Roadmap with Pilot-Start Anchor

**Status:** Accepted
**Date:** 2026-04-12
**Priority:** MEDIUM — Executive output credibility
**Originating Review:** Ramco Aviation Catering Readiness Review (2026-04-12), Executive Output 5/10
**Builds on:** ADR-PIPELINE-061 (Domain-Adaptive Phase Gates), ADR-PIPELINE-052 (Executive Output 9/10)

## Context

The Ramco review flagged a small but visible consulting-grade defect:

> "Roadmap dates are relative-only. 'Week 2, Week 4…' — top-tier deliverables anchor to absolute dates and owner names with committed capacity."

Every generated roadmap uses relative week labels: `Week 2: Data gate`, `Week 4: Scope lock`, `Week 8: Mid-pilot`, `Week 12: Scale decision`. This is fine for a technical plan but is below the bar for a McKinsey/BCG/Bain-grade deliverable because:

1. **Board members diff against real calendars.** "Week 4" is abstract; "2026-05-10" can be compared against the user's Q2 review cadence, vendor SLAs, and regulatory deadlines.
2. **Owner names are missing.** The RACI table has them; the roadmap does not. A reviewer can't tell who is accountable for each gate without cross-referencing two sections.
3. **Scheduling conflicts become invisible.** A pilot that overlaps a mobile-team release freeze, a GDPR audit window, or a board meeting should surface those conflicts in the roadmap itself.

The fix is to compute absolute dates in the roadmap renderer, derive the pilot-start date from the query or config (with a sensible default), and project each phase-gate row against the calendar with a named owner sourced from the RACI table.

## Decision

### 1. Pilot-Start Date Resolution

The roadmap renderer accepts a pilot-start date from one of four sources, in priority order:

1. **Query parse** — if the query contains a phrase like `"starting 2026-05-01"`, `"kick off June 1 2026"`, `"beginning of Q2"`, etc., extract it
2. **Config** — `AppConfig.pilot.startDate` (ISO date string)
3. **Manifest** — the simulation manifest's `pilot_start_date` field (new, optional)
4. **Default** — today + 14 days (rounded up to the next Monday)

New helper in `src/synthesis/roadmap-dates.ts`:

```typescript
export interface PilotStartResolution {
  readonly startDate: string;         // ISO date (YYYY-MM-DD)
  readonly source: 'query' | 'config' | 'manifest' | 'default';
  readonly reasoning: string;
}

export function resolvePilotStart(
  query: string,
  config: { pilot?: { startDate?: string } } | null,
  manifest: { pilot_start_date?: string } | null,
  now: Date = new Date(),
): PilotStartResolution;
```

Query parsing uses simple regexes:

| Pattern | Example match |
|---|---|
| `starting?\s+(?:on\s+)?(\d{4}-\d{2}-\d{2})` | `starting 2026-05-01` |
| `kick\s*off\s+(?:on\s+)?(\d{4}-\d{2}-\d{2})` | `kickoff 2026-06-15` |
| `beginning\s+of\s+(Q[1-4])\s+(\d{4})` | `beginning of Q3 2026` → `2026-07-01` |
| `(\d{4}-\d{2}-\d{2})\s+(?:as\s+)?(?:the\s+)?pilot\s+start` | `2026-05-01 as pilot start` |

The default (today + 14d, next Monday) gives a realistic "two weeks out" kickoff without anchoring to an arbitrary today-based date.

### 2. Phase/Gate Date Projection

`buildRoadmapArtifact` computes absolute dates for every phase and every gate using `addDays(startDate, offset)`:

```typescript
interface DatedPhase {
  readonly id: string;
  readonly name: string;
  readonly startDate: string;      // ISO
  readonly endDate: string;        // ISO
  readonly durationWeeks: number;
  readonly owner: { name: string; role: string };
  readonly focus: string;
  readonly deliverables: readonly string[];
}

interface DatedGate {
  readonly after_phase: string;
  readonly gate: string;
  readonly gate_date: string;      // ISO
  readonly criteria: readonly GateCriterion[];
  readonly decision_authority: { name: string; role: string };
  readonly overall_decision: string;
}
```

Every date field is ISO `YYYY-MM-DD`. A separate `renderAbsoluteDate(iso)` helper formats it for prose (`"Friday, May 10, 2026"`) when the renderer produces markdown.

### 3. Owner Sourcing from RACI

The decision memo already produces a stakeholder table (via ADR-PIPELINE-070 workforce RACI and the pre-existing stakeholder rows). The roadmap renderer reads those rows to pick an owner for each phase:

| Phase | RACI Role Priority |
|---|---|
| Discovery / Planning | Program Manager → Chief Information Officer → Operations Leadership |
| Prototype Development | Engineering Lead → Technical Lead |
| Validation / Refinement | QA Lead → Engineering Lead |
| Deployment / Handover | Operations Leadership → DevOps Lead |

When no stakeholder matches, the renderer falls back to a domain-appropriate default name drawn from `extractScenarioFromQuery` and labels the owner as `"To be named"` with a visible `⚠️` so the user sees the gap.

### 4. Business-Calendar Awareness (Optional Config)

`AppConfig.pilot.businessCalendar` (optional) can specify holidays and blackout windows:

```typescript
pilot: z.object({
  startDate: z.string().datetime().optional(),
  businessCalendar: z.object({
    region: z.enum(['US', 'EU', 'APAC']).default('US'),
    holidays: z.array(z.string()).default([]),  // ISO dates to skip
    blackoutWindows: z.array(z.object({
      start: z.string(),
      end: z.string(),
      reason: z.string(),
    })).default([]),
  }).optional(),
}),
```

Phase-gate dates that land on holidays or inside blackout windows get automatically pushed forward, with a note in the roadmap: `"Gate originally 2026-07-04; pushed to 2026-07-05 (US Independence Day)"`.

For the first release the feature is optional — projects without a business calendar still get absolute dates, just without calendar-awareness.

### 5. Decision Memo Mirrors the Dates

The decision memo's "Recommended Next Steps" section (generated by `buildDomainNextSteps`) today emits time-bound steps like `"Week 1: Stand up pilot data pipeline"`. Update it to use the same absolute dates the roadmap produces:

```markdown
## Recommended Next Steps

1. **By 2026-05-15 (Week 1)** — Stand up pilot data pipeline
   Owner: Maria Chen, Data Engineering Lead
2. **By 2026-05-29 (Week 3)** — Complete SME schema review for Ramco catering doc
   Owner: Vikram Patel, Ramco Integration Lead
3. **By 2026-06-05 (Week 4)** — Data-quality gate decision
   Authority: Jordan Okafor, Chief Information Officer
```

Both documents cite the same dates so a reviewer cannot find a contradiction.

### 6. Sensitivity to Timeline Shifts

ADR-PIPELINE-063 produced a sensitivity tornado including an "Implementation timeline ±3 months" variable. When the pilot is re-anchored (config change, query rewrite), the roadmap renderer recomputes every date and the tornado's timeline sensitivity row re-references the new base case. No user intervention required — ADR-073's fcv tags ensure the renderer output is extracted correctly.

### 7. New Phase Gate Metadata Field

`buildPhaseGates` gains a `gate_date` field on every gate row. Executive-facing renderers use it for the date prose; downstream automation (CI integrations, calendar exports) can import the roadmap.json and emit ICS files.

### 8. Roadmap Renderer Outputs

Two outputs change:

- `roadmap.json` artifact (from `buildRoadmapArtifact`) gains `pilot_start: { date, source, reasoning }` and every phase/gate row has absolute date fields
- `renderRoadmapMarkdown` (new helper) produces a rendered `roadmap.md` that mirrors the JSON with human-readable dates and owner attribution

The JSON artifact is authoritative; the markdown is derived.

## Implementation

1. New module `src/synthesis/roadmap-dates.ts`:
   - `resolvePilotStart(query, config, manifest, now)`
   - `projectDates(startDate, phaseDurations)`
   - `applyBusinessCalendar(date, calendar)`
   - `renderAbsoluteDate(iso)` formatter
2. Extend `AppConfig.pilot` in the scaffold config template.
3. Modify `buildRoadmapArtifact` in `src/synthesis/simulation-renderers.ts`:
   - Resolve pilot start
   - Project dates onto every phase + gate
   - Attach owner from the RACI / stakeholder pool
   - Include `pilot_start` metadata in the returned object
4. New helper `renderRoadmapMarkdown(artifact)` that produces a markdown document; artifact generator writes `roadmap.md` alongside `roadmap.json`.
5. Modify `buildDomainNextSteps` in the decision memo to consume the same absolute dates.
6. Add a new renderer test fixture: `tests/unit/synthesis/roadmap-dates-079.test.ts` asserting:
   - Query parse finds `starting 2026-05-01`
   - Default falls to next-Monday rounding
   - Business calendar pushes July 4 gate to July 5
   - Decision memo's absolute dates match the roadmap's
7. `FinancialClaimDocument` from ADR-073 gains `'roadmap'` as a valid value so the consistency runner can scan `roadmap.md` for contradictions.

## Acceptance Criteria

1. Every generated `roadmap.json` contains an absolute `pilot_start` field with `source` metadata.
2. Every phase in `roadmap.json` has `startDate`, `endDate`, `durationWeeks`, and `owner` fields.
3. Every gate in `roadmap.json` has a `gate_date` field.
4. The rendered `roadmap.md` cites absolute dates (e.g., `"2026-05-10"` or `"Friday, May 10, 2026"`) — zero occurrences of `"Week N"` as a standalone date label.
5. The decision memo's "Recommended Next Steps" section cites the same dates as the roadmap.
6. A query containing `"starting June 1 2026"` resolves to `pilot_start.date === '2026-06-01'` with `source === 'query'`.
7. A query with no date hint AND no config AND no manifest falls to `default` with a next-Monday rounding from today.
8. When a gate falls on US Independence Day and the business calendar is US, the date is pushed one day with a visible note.

## Consequences

### Positive

- Executive roadmap output becomes comparable against real calendars — raises boardroom credibility at near-zero cost.
- Owner attribution closes the RACI ↔ roadmap cross-reference gap reviewers flag.
- Business-calendar awareness turns a common scheduling oversight into a visible warning.
- Downstream tooling (ICS export, Gantt rendering) becomes possible because the roadmap artifact now has structured date fields.

### Negative

- Adds ~150ms to the roadmap render for business-calendar projection. Noise.
- The default "today + 14d, next Monday" can mislead readers who don't realize the date was computed, not chosen. Mitigated by the `pilot_start.source === 'default'` metadata and a visible note in the rendered roadmap.
- Query-parsing regexes for dates are English-only for the first release. Non-English queries fall to config/default.
- When the coding agent generates a different set of RACI roles than the default mapping expects, the owner assignment falls back to "To be named" with the warning marker. That's the right behavior (don't fabricate an owner) but it surfaces as a gap in the rendered doc.

## Related

- **ADR-PIPELINE-061** (Phase Gate Criteria — this ADR adds date anchoring)
- **ADR-PIPELINE-063** (Sensitivity Tornado — timeline variable references the same base case)
- **ADR-PIPELINE-070** (Workforce RACI — source of owner attribution)
- **ADR-PIPELINE-073** (Tag Preservation — consistency runner scans the rendered roadmap)
- **ADR-PIPELINE-052** (Executive Output 9/10)
