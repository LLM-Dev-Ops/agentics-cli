# ADR-PIPELINE-070: Workforce-Impact Risk Dimension for Labor-Intensive Domains

**Status:** Accepted
**Date:** 2026-04-11
**Priority:** MEDIUM — Strategic-depth gap in executive documents
**Originating Review:** OPERA Sustainability Prototype Readiness Review (2026-04-11), Executive Output 6/10
**Builds on:** ADR-PIPELINE-041 (Domain-Aware Simulation), ADR-PIPELINE-062 (Competitive Analysis)

## Context

The OPERA review identified a strategic blind spot:

> "Strategic depth is thin in one place: neither document addresses what happens to the 91K-employee workforce when housekeeping cadence changes — labor reallocation, union implications in EMEA, or the change-management cost in luxury properties. The risk register touches guest impact but not labor."

The pipeline's risk-register renderer (`src/pipeline/enterprise/artifact-renderers.ts` around `renderRiskRegister`) pulls risks from agent outputs and formats them into a heat-map. It has no concept of a "workforce-impact" risk dimension. When the domain involves operational labor — hotel housekeeping, retail floor staff, warehouse pickers, call-center agents, nursing staff — changes to cadence, tooling, or policy always have labor-side consequences, but agents tend to focus on cost/sustainability/customer dimensions and skip workforce entirely.

A top-tier consulting deliverable would never omit this. Workforce risk is the #1 reason enterprise AI pilots stall after a successful technical prototype.

## Decision

### 1. Define "Labor-Intensive" Domains

Add a classifier in `src/synthesis/domain-labor-classifier.ts`:

```typescript
export type LaborIntensity = 'high' | 'medium' | 'low';

export interface LaborProfile {
  intensity: LaborIntensity;
  roleTypes: string[];           // "housekeeper", "floor associate", "RN"
  unionizationRisk: 'high' | 'medium' | 'low';
  regionMultipliers: Record<'NA' | 'EMEA' | 'APAC', number>; // 1.0 = baseline, higher = more labor exposure
  reasoning: string;
}

export function classifyLaborIntensity(
  domainAnalysis: DomainAnalysis,
  query: string,
): LaborProfile;
```

Classification is rule-based on the `sector` field from ADR-PIPELINE-041, enriched with query keyword scan:

| Sector | Intensity | Unionization Risk | Notes |
|---|---|---|---|
| hospitality / hotels | high | high (EMEA) / medium (NA) | Housekeeping, F&B |
| retail | high | medium | Floor staff, stock |
| logistics / warehouse | high | high | Union-heavy in NA/EMEA |
| healthcare | high | high | Nursing, allied health |
| call center / BPO | high | medium | Agent performance metrics |
| manufacturing | high | high | Factory floor |
| commercial real estate | medium | low | Facility ops, security |
| professional services | medium | low | Knowledge workers |
| fleet / transportation | high | high | Drivers (EU/NA regulated) |
| SaaS / pure software | low | low | Engineering only |

### 2. Mandatory Workforce Risk Section When Intensity ≥ Medium

When `classifyLaborIntensity()` returns `medium` or `high`, the risk-register renderer MUST emit a dedicated **Workforce Impact** section with at least these rows (pre-populated from a template, overridable by agent output):

| Risk | Likelihood | Severity | Owner | Mitigation |
|---|---|---|---|---|
| Labor reallocation disputes | Medium | High | HR + Ops | Joint labor/ops working group before pilot start |
| Union consultation obligation (EMEA works councils) | High | Medium | Legal + Regional HR | CSRD-aligned notice period, minimum 30 days |
| Change-management cost underestimated | Medium | Medium | Pilot PM | Dedicated change budget = 12% of pilot investment |
| Role attrition from perceived job loss | Medium | High | HR | Explicit no-reduction commitment during pilot window |
| Training burden on line managers | High | Low | Ops | Train-the-trainer model, 4 hours max per mgr |

The agent output is *merged* with this template — agent-provided rows are preferred when they have matching `category` tags, template rows fill gaps.

### 3. Workforce Exposure KPI in Financial Analysis

The financial analysis renderer (ADR-PIPELINE-066) must add a workforce exposure line:

```
Workforce exposure:
  Roles affected:            ~3,200 (housekeepers across 100 properties)
  EMEA union exposure:       ~1,100 roles (34% of affected population)
  Change-management budget:  12% of pilot investment = $120K–$170K
  Reallocation neutrality:   Committed (no headcount reduction during pilot)
```

The numbers come from:
- `operationalUnits` / `rolesPerUnit` ratios from the labor-intensity classifier
- Region mix from the unit-economics manifest (ADR-066)
- Fixed 12% change-management rule-of-thumb, overridable via `domain_analysis.change_mgmt_pct`

### 4. Decision Memo RACI Must Include HR + Legal

When labor intensity ≥ medium, the decision memo's stakeholder RACI table MUST include:

- **HR** — Consulted on every phase gate
- **Legal** — Consulted before EMEA rollout (works-council obligations)
- **Regional HR leads** — Informed on weekly cadence during pilot

If agent output omits these roles, the renderer injects them automatically and emits a log line `renderer.workforce.raci.injected`.

### 5. Consensus & Sensitivity Hooks

- The sensitivity table from ADR-PIPELINE-063 must include at least one workforce variable when intensity ≥ medium: "Change management budget overrun (+20% / +50%) — NPV impact."
- The consensus-transparency rule from ADR-PIPELINE-071 must surface low confidence on workforce-risk claims separately from financial claims (workforce risk is typically the lowest-confidence dimension).

## Implementation

1. New file `src/synthesis/domain-labor-classifier.ts` with the sector table and keyword rules.
2. Extend `src/pipeline/enterprise/artifact-renderers.ts::renderRiskRegister` to call the classifier, merge template rows with agent output, and emit the Workforce Impact section.
3. Extend `renderFinancialAnalysis` (ADR-066) to add the workforce-exposure block when applicable.
4. Extend `renderDecisionMemo` to inject HR/Legal RACI rows.
5. Extend `renderSensitivityTable` (ADR-063) to add a workforce variable row.
6. Tests:
   - Classifier unit tests for each sector
   - Renderer test: hospitality query produces Workforce Impact section with ≥5 rows
   - Renderer test: pure-SaaS query does NOT produce the section (intensity low)
   - Integration test against the OPERA fixture confirms "Union consultation obligation (EMEA)" appears in risk register

## Acceptance Criteria

1. Running the pipeline against the OPERA query produces a risk register containing an explicit Workforce Impact section.
2. The decision memo RACI for the OPERA run includes HR and Legal.
3. The financial analysis for the OPERA run shows a workforce-exposure block with `~3,200 roles affected`.
4. A pure-SaaS query (e.g., "optimize our internal dev tooling") does NOT emit the workforce section — classifier returns `low`.
5. Classifier output is persisted to `run-dir/labor-profile.json` for downstream consumers.

## Consequences

### Positive
- Closes the #1 strategic-depth gap flagged in consulting-grade reviews
- Prevents pilots from stalling on unanticipated labor objections
- EMEA/CSRD works-council compliance surfaces at the right phase gate, not after-the-fact
- The classifier is reusable across all enterprise-facing renderers

### Negative
- Template rows carry a false-precision risk — they're rules-of-thumb, not engagement-specific analysis. Labeled as such in the rendered output: `*Template risk — refine with HR during pilot scoping*`
- Adds ~300ms to rendering time for labor-intensive queries (classification + template merge)
- Creates an expectation that all future sectors have labor profiles — the table must be maintained as new sectors are onboarded

## Related
- ADR-PIPELINE-041 (domain-aware simulation — provides the sector field)
- ADR-PIPELINE-062 (competitive analysis — similar "always include this section" pattern)
- ADR-PIPELINE-063 (sensitivity tornado — workforce variable added here)
- ADR-PIPELINE-066 (unit economics — provides role-count ratios)
- ADR-PIPELINE-071 (consensus transparency — surfaces workforce risk confidence separately)
