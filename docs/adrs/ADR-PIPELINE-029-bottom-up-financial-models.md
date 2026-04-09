# ADR-PIPELINE-029: Bottom-Up Financial Models — Replace Per-Employee Heuristics with Domain-Specific Unit Economics

**Status:** Accepted
**Date:** 2026-04-09
**Priority:** HIGH — Executive Output Quality stuck at 3.0-4.5/10 across all evaluations

## Context

The financial model in executive documents uses a generic per-employee formula:

```
pilotCost = employees × costPerEmployee (industry benchmark)
annualSavings = employees × savingsMultiplier (industry benchmark)
ROI = annualSavings / pilotCost × 100
```

This produces numbers like "$1.4M - $2.0M investment" and "200% ROI" with no derivation visible to the reader. Every evaluation has flagged this:

- Water utility run: "$660K-$990K based on 22,000 employees" — no connection to water loss volumes
- Sustainability run: "$1.4M-$2.0M" with "200% ROI (estimated)" — no breakdown
- Packaging run: "$60/employee" benchmark — not connected to actual packaging data

A McKinsey deliverable would show: "8 suppliers × avg 22% excess packaging × $X/shipment × 12,000 annual shipments = $Y addressable waste."

## Decision

### 1. Domain-Aware Financial Synthesis

When `synthesizeFinancials()` has no agent-supplied data, `estimateFinancialsFromQuery()` must produce methodology strings that show the build-up, not just the result:

**Current (broken):**
```
budget: "$1.1M - $1.7M (estimated based on 45,000 employees)"
roi: "200% projected (estimated)"
```

**Required:**
```
budget: "$1.1M - $1.7M (45,000 employees × $25/employee professional services benchmark)"
roi: "200% projected ($2.3M savings ÷ $1.1M investment)"
npv: "$7.9M 5-year NPV (10% discount rate, 45,000 × $50/employee annual gain)"
```

### 2. Scenario-Specific Financial Override

When the prototype generates actual analysis data (e.g., excess packaging costs, water loss volumes, emission reductions), the executive documents should cite those numbers instead of the generic model. The `renderFinancialAnalysis()` function should:

1. Check if prototype analysis data exists in the run directory
2. If yes, extract domain-specific metrics (total addressable waste, cost per unit, etc.)
3. Build the financial model from those metrics
4. Fall back to per-employee estimates only when no analysis data exists

### 3. Decision Memo Pilot vs. Full Deployment Costs Must Differ

The Options Considered table must show:
- Pilot: ~30% of full deployment cost (scoped to subset of data/suppliers/zones)
- Full Deployment: full estimated investment
- Do Nothing: $0 investment, quantified cost of inaction

Parse the budget string, extract the numeric value, and compute the pilot range.

### 4. Industry Detection Must Be Comprehensive

Add detection for: utilities, sustainability, healthcare, professional services, manufacturing, consumer goods, pharma. Each industry gets calibrated cost-per-employee and savings-multiplier values, plus an industry label that appears in the methodology string.

## Consequences

### Positive
- Financial figures become defensible ("how did you get that number?" has an answer)
- Executive Output Quality score should increase from 3.0-4.5 to 6.0+
- Decision memo options table no longer shows identical costs for pilot and full deployment
- CFO-level scrutiny can be survived

### Negative
- Per-employee heuristics are still estimates, not actual quotes
- Bottom-up calculations from prototype data require the prototype to run first (chicken-and-egg for planning-only outputs)

## Implementation

Files to modify:
- `src/synthesis/simulation-renderers.ts` — `estimateFinancialsFromQuery()`, `renderDecisionMemo()`, `renderFinancialAnalysis()`
