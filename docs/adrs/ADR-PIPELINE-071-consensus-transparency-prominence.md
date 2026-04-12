# ADR-PIPELINE-071: Consensus Transparency — Prominence Rule for Low-Agreement Runs

**Status:** Accepted
**Date:** 2026-04-11
**Priority:** MEDIUM — Executive narrative credibility
**Originating Review:** OPERA Sustainability Prototype Readiness Review (2026-04-11), Executive Output 6/10
**Builds on:** ADR-PIPELINE-057 (Sensitivity & Confidence Framing), ADR-PIPELINE-052 (Executive Output 9/10)

## Context

The OPERA review flagged a narrative defect:

> "Consensus transparency is buried. The manifest shows `agreement_level_pct: 0` and analytics-hub consensus at 50% / 41.6% confidence. The executive summary footnotes this; the decision memo spins it as 'direction not disputed.' A McKinsey-grade document would lead with it as the reason the pilot structure exists, not minimize it."

The pipeline currently treats agreement/confidence as a single numeric field printed in a footnote. When the number is high, footnoting is fine. When the number is low, footnoting is actively misleading — it makes the document look more confident than the underlying evidence warrants, and a skeptical reader will catch it.

The fix is not more disclosure volume; it is *placement*. Low-consensus results must drive the document structure, not be hidden inside it.

## Decision

### 1. Consensus Thresholds

Define three consensus tiers in `src/synthesis/consensus-tiers.ts`:

```typescript
export type ConsensusTier = 'aligned' | 'directional' | 'contested';

export function classifyConsensus(
  agreementLevelPct: number,
  precisionConfidencePct: number,
): ConsensusTier {
  if (agreementLevelPct >= 70 && precisionConfidencePct >= 70) return 'aligned';
  if (agreementLevelPct >= 40 || precisionConfidencePct >= 50) return 'directional';
  return 'contested';
}
```

| Tier | Agreement % | Precision % | Narrative Treatment |
|---|---|---|---|
| **aligned** | ≥70 | ≥70 | Footnote acceptable |
| **directional** | 40–69 *or* 50–69 | mixed | Lead paragraph must acknowledge |
| **contested** | <40 and <50 | — | Headline-level treatment, drives document structure |

The OPERA run (`agreement_level_pct: 0`, precision `41.6%`) is `contested`.

### 2. Renderer Behavior by Tier

`src/pipeline/enterprise/artifact-renderers.ts` MUST branch on tier:

**aligned** — current behavior; figures stated directly, confidence footnoted.

**directional** — every renderer (executive summary, decision memo, roadmap) MUST:
- State the tier in the opening paragraph: `"Agent consensus: directional (52%) — direction is supported, magnitude has meaningful variance."`
- Replace single point-estimate headline figures with ranges (use `rangeLow`/`rangeHigh` from ADR-063 sensitivity).
- Add an "Assumption dependencies" callout box listing the top 3 variables the result is sensitive to.

**contested** — in addition to directional behavior:
- The executive summary's opening MUST lead with the reason for the pilot structure: `"Agent consensus is contested (agreement 0%, precision 42%). This is why the recommendation is a 12-week bounded pilot, not full deployment — the pilot is designed to resolve the disagreement with measured data."`
- The decision memo MUST include a dedicated "Why we are not more confident" section explaining which agents dissented and on what dimension.
- The roadmap MUST include an explicit "consensus gate" at Week 4: `"If measured pilot data does not move precision confidence above 60%, the Week 8 scale decision defaults to STOP."`
- The risk register MUST elevate "Analytical uncertainty" to a named risk with likelihood=High, severity=High.
- A loud header appears at the top of every executive document: `> **📊 Consensus: contested** — see §"Why we are not more confident" before interpreting figures.`

### 3. Consensus Must Flow Through the Pipeline as Structured Data

Currently consensus lives in the manifest as ad-hoc fields. Standardize in `src/pipeline/types.ts`:

```typescript
export interface ConsensusSnapshot {
  readonly agreementLevelPct: number;       // 0–100
  readonly precisionConfidencePct: number;  // 0–100
  readonly directionalConfidencePct: number;// 0–100 (ADR-057)
  readonly tier: ConsensusTier;
  readonly dissentingAgents: Array<{
    domain: string;
    agent: string;
    dimension: 'financial' | 'operational' | 'compliance' | 'workforce' | 'technical';
    summary: string;
  }>;
  readonly loadBearingAssumptions: string[]; // top-3 variables the result depends on
}
```

The enterprise pipeline's `pass5-decision.ts` must populate this snapshot; renderers read from it, not from loose manifest fields.

### 4. Ban "No Meaningful Dissent" Spin for Contested Runs

Add a rule to the cross-document consistency validator from ADR-PIPELINE-067:

| ID | Rule | Action on Violation |
|---|---|---|
| FCR-010 | For `contested` runs, no document may contain phrases like "direction not disputed", "no meaningful dissent", "broad agreement", "agents aligned" | Error — renaming required |

Phrase list is maintained in `src/synthesis/forbidden-spin-phrases.ts` and extensible.

### 5. Consensus Visualization

Generate a `consensus.svg` in the run directory showing per-dimension agreement (financial, operational, compliance, workforce, technical). Embed as inline SVG in the executive summary for `directional` and `contested` tiers. Top-tier consulting deliverables always include a visual — this closes that gap with zero LLM cost.

## Implementation

1. New file `src/synthesis/consensus-tiers.ts` with classifier and constants.
2. New type `ConsensusSnapshot` in `src/pipeline/types.ts`.
3. `src/pipeline/enterprise/pass5-decision.ts` populates the snapshot from agent results.
4. Renderer updates in `src/pipeline/enterprise/artifact-renderers.ts`:
   - Branch on tier in `renderExecutiveSummary`, `renderDecisionMemo`, `renderRoadmap`, `renderRiskRegister`.
   - Inject the opening-paragraph treatment for `directional`.
   - Inject the headline treatment + "Why we are not more confident" + consensus gate for `contested`.
5. Forbidden-spin validator rule FCR-010 in ADR-067's rule set.
6. SVG generator `src/synthesis/consensus-svg.ts` (pure string templating, no libraries).
7. Tests:
   - Classifier unit tests at tier boundaries
   - Renderer test: OPERA-like fixture (agreement 0%, precision 42%) → contested behavior all documents
   - Renderer test: high-agreement fixture → aligned behavior unchanged
   - FCR-010 detects "no meaningful dissent" on a contested run

## Acceptance Criteria

1. Re-running the OPERA query produces an executive summary whose opening paragraph leads with "Agent consensus is contested" — not a footnote.
2. The decision memo for that run contains a "Why we are not more confident" section naming dissenting agents.
3. The roadmap contains an explicit Week 4 consensus gate with a stated default action.
4. `consensus.svg` exists in the run directory and is referenced from the executive summary.
5. FCR-010 fires against a fixture containing "direction not disputed" on a contested run.
6. Aligned-tier runs render identically to today — no regression.

## Consequences

### Positive
- Low-consensus runs become credible ("we are being honest about uncertainty") instead of suspect ("they hid this in a footnote")
- Forces the document to earn confidence through pilot design, not rhetoric
- The contested-tier consensus gate gives boards a decisive check-in point
- Makes dissent visible and reviewable instead of collapsed into a single number

### Negative
- Contested-tier runs produce longer, heavier documents — intentional; the weight is the point
- Requires renderer branching logic — adds test surface
- Teams that want a crisp executive summary for a contested run will push back; the right answer is "resolve consensus first, then re-render"

## Related
- ADR-PIPELINE-057 (dual confidence framing — this ADR sits on top of it)
- ADR-PIPELINE-052 (executive output 9/10 baseline)
- ADR-PIPELINE-063 (sensitivity tornado — provides rangeLow/rangeHigh for directional tier)
- ADR-PIPELINE-067 (cross-document consistency — hosts FCR-010)
- ADR-PIPELINE-070 (workforce risk — surfaces separately in consensus dimensions)
