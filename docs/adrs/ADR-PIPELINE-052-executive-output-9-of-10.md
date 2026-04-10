# ADR-PIPELINE-052: Executive Output 9/10 — Quantified Business Case, Decision Memo, Alternative Comparison

**Status:** Accepted
**Date:** 2026-04-10
**Priority:** HIGH — Executive Output at 6.5-8/10, needs quantified financials and decision document

## Gap Analysis (6.5 → 9)

| Issue | Impact | Fix |
|-------|--------|-----|
| No quantified business case from prototype data | Executive can't make funding decision | Synthesize seed data into financial narrative |
| No standalone executive decision memo | Engineering artifacts ≠ board documents | Pipeline must always produce decision-memo.md |
| No comparison to alternatives | Solution evaluated in isolation | Include build-vs-buy and approach alternatives |
| Risk assessment lacks business framing | Technical risks ≠ business risks | Add customer/revenue impact per risk |
| Cross-document inconsistencies | "Packaging optimization" in energy query | Domain validation before rendering |

## Decision

### 1. Business Case from Prototype Data
```
RULE: The demo script MUST compute and display:
- Total addressable value (from seed data analysis)
- Projected annual savings/impact
- Implementation cost estimate
- ROI and payback period
- Confidence range (optimistic/base/pessimistic)

The executive summary MUST cite these prototype-derived numbers,
not generic per-employee heuristics.
```

### 2. Decision Memo Always Generated
```
RULE: The pipeline MUST always produce:
- executive-summary.md — 1 page, recommendation + impact
- decision-memo.md — 3-5 pages, options analysis + stakeholder RACI
- financial-analysis.md — ROI model with sensitivity table

These MUST use the SAME domain terminology as the user's query.
No packaging language in an energy query. No employee heuristics
for a fleet query. Domain mismatch = credibility failure.
```

### 3. Alternative Comparison
```
RULE: The decision memo MUST compare at least 3 approaches:
- Option A: Scoped AI pilot (recommended)
- Option B: Manual process improvement (no technology)
- Option C: Full ML/AI platform (higher investment, longer timeline)
- Option D: Do nothing (quantified cost of inaction)

Each option: investment, timeline, risk, expected impact, recommendation.
```

### 4. Business-Framed Risks
```
RULE: Every risk in the risk register MUST include:
- Financial exposure ($ impact if risk materializes)
- Schedule impact (weeks of delay)
- Business impact (customer/revenue/regulatory consequence)
- Not just "Medium impact" — quantify it
```

## Implementation

- Financial model improvements in simulation-renderers.ts (ADR-029 extended)
- Domain validation in tryDomainSpecificFinancials (ADR-045)
- Decision memo always produced by artifact generator
- Sensitivity table in financial analysis
