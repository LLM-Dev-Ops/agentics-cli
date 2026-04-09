# ADR-PIPELINE-024: Consulting-Grade Executive Document Quality

**Status:** Accepted
**Date:** 2026-04-09
**Priority:** CRITICAL — Executive documents are the customer-facing deliverable. Low quality here means lost deals.

## Context

The pipeline's executive-facing documents (executive summary, decision memo, financial analysis, risk assessment, roadmap) scored **4/10** in production readiness reviews. The reviewer stated:

> "A McKinsey/BCG/Bain consultant would return this with three requirements: (1) financial quantification, (2) substantive risk register with likelihood/impact scoring, and (3) executive summary rewritten as problem→insight→recommendation→impact narrative."

Specific failures identified across multiple runs:

### Executive Summary (`renderExecutiveSummary`)
- Opens with a metrics table instead of a narrative
- No problem statement framed in business terms (cost of inaction)
- No insight derived from the analysis
- Recommendation is a single word ("CONDITIONAL PROCEED") without decomposition
- No impact quantification ("this will save $X" or "this reduces risk by Y%")
- 88% success probability is asserted without explaining what it means or how it was derived

### Decision Memo (`renderDecisionMemo`)
- Contradicts itself: "No specific risk factors identified" followed by 5 risk mitigation steps
- Financial impact section only shows raw field values, no narrative
- No alternative comparison ("Option A vs. Option B vs. Do Nothing")
- No stakeholder-specific framing (what does this mean for the CFO vs. the CTO vs. operations?)
- No decision criteria matrix

### Risk Assessment (`buildRiskAssessment`)
- `risk_factors: []` is common — produces "No risks identified" for 59,000-employee enterprises
- No likelihood × impact matrix
- No risk categorization (technical, operational, organizational, regulatory, financial)
- No risk ownership or mitigation timelines
- Overall risk level ("MEDIUM") is derived solely from success probability, not from actual risk analysis

### Financial Analysis (`renderFinancialAnalysis`)
- Shows "pending — agent data not available" when costops agents don't fire
- Even when data exists, it's presented as raw bullet points, not a structured financial model
- No sensitivity analysis
- No comparison of scenarios (optimistic/base/pessimistic)
- No total cost of ownership breakdown
- No break-even analysis

### Roadmap (`buildRoadmapArtifact`)
- Generic phase names ("Discovery & Planning", "Prototype Development")
- No resource requirements or team composition per phase
- No cost estimate per phase
- No dependencies between phases
- No success criteria per phase
- No risk gates between phases

## Decision

### Principle: Every Document Follows the Pyramid Principle

All executive documents must follow the McKinsey Pyramid Principle:
1. **Lead with the answer** — The first paragraph states the recommendation and its business impact
2. **Group supporting arguments** — Evidence organized by theme, not chronologically
3. **Order logically** — Most important arguments first
4. **Mutually exclusive, collectively exhaustive (MECE)** — No overlap, no gaps

### 1. Executive Summary — Rewrite as Strategic Narrative

**Structure:**

```markdown
# Executive Summary

## Recommendation
[One sentence: what to do and what it's worth]
Example: "Proceed with a 12-week pilot of the Returns Disposition Optimizer,
targeting $4.3M annual recovery value across 5 distribution centers."

## The Opportunity
[2-3 sentences: what problem exists and what it costs today]
Example: "Manual returns disposition across 59,000 employees results in
estimated $18M/year in suboptimal routing — items discounted that could
be resold, recyclable items sent to landfill. Current processes lack
visibility into which disposition path maximizes recovery value."

## What We Found
[3-5 bullet points: key insights from the analysis, each with a number]
- AI-optimized scoring identifies 80% waste reduction opportunity across sample data
- 5 items currently being discounted could be resold — $13,260/year recoverable per batch
- Regional emissions factors vary 2.3x between NA and EU, requiring configurable models
- Shopify Plus integration is API-ready with <2 week implementation effort
- Human-in-the-loop governance adds <5% processing overhead

## Financial Impact
| Metric | Value |
|--------|-------|
| Total Investment | $2.8M |
| 5-Year NPV | $8.75M |
| Payback Period | 14 months |
| Annual Recovery Value | $4.3M |

## Risk Profile
[Severity: LOW/MEDIUM/HIGH] — [1 sentence summary]
Top 3 risks: [name each with likelihood/impact]

## Recommended Next Steps
[3-5 numbered, time-bound actions]
```

**Implementation in `renderExecutiveSummary()`:**
- Extract `problemStatement` from query (already exists via `distillProblemStatement()`)
- Frame the opportunity as cost-of-inaction using simulation data
- Pull financial metrics from `simData` AND costops agents (already wired in 1.6.5)
- Derive insights from platform agent results — not generic "analysis completed"
- Build risk profile from sentinel/shield/platform agents — never say "no risks"
- Next steps should be time-bound and reference specific systems

### 2. Decision Memo — Structured Decision Package

**Structure:**

```markdown
# Decision Memo

## Decision Requested
[What specific approval is needed from whom]

## Recommendation: [PROCEED / CONDITIONAL PROCEED / DEFER]
[2-3 sentence rationale with evidence]

## Business Context
[Why this matters now — competitive pressure, regulatory deadline, cost escalation]

## Options Considered
| Option | Cost | Timeline | Risk | Recommendation |
|--------|------|----------|------|---------------|
| Option A: Full deployment | $X | Y months | Medium | Not recommended — scope too broad for initial validation |
| Option B: Scoped pilot | $X | Y months | Low | **Recommended** — validates core hypothesis with bounded risk |
| Option C: Do nothing | $0 | N/A | High | Unacceptable — costs escalate $X/quarter |

## Financial Impact
[Structured table with investment, ROI, NPV, payback — from simData + costops]

## Risk Assessment Summary
[Top 5 risks with likelihood × impact, not "no risks identified"]

## Implementation Approach
[From copilot/planner — phased plan with decision gates]

## Stakeholder Impact
| Stakeholder | Impact | Action Required |
|-------------|--------|----------------|
| CFO | Budget approval | Review financial model |
| CTO | Architecture sign-off | Validate integration approach |
| Operations | Process change | Pilot participation |
```

**Implementation in `renderDecisionMemo()`:**
- Never output "No specific risk factors identified" — generate domain-specific risks from the query context (every enterprise project has data quality, integration, change management, and regulatory risks)
- Always include an options comparison table (full deployment / scoped pilot / do nothing)
- Remove contradiction between empty risks and risk mitigation steps
- Pull copilot/planner data for implementation approach
- Add stakeholder impact section derived from extracted stakeholders

### 3. Risk Assessment — Likelihood × Impact Matrix

**Structure:**

```markdown
# Risk Assessment

## Risk Profile: [LOW/MEDIUM/HIGH]
[1 sentence summary with success probability decomposition]

## Risk Register

| # | Risk | Category | Likelihood | Impact | Score | Mitigation | Owner |
|---|------|----------|-----------|--------|-------|------------|-------|
| 1 | ERP API rate limits | Technical | Medium | High | 6 | Circuit breaker + sync queue | Engineering |
| 2 | Data quality variance | Data | High | Medium | 6 | Validation layer + quarantine | Data Team |
| 3 | Change management | Organizational | Medium | Medium | 4 | Phased rollout + training | Program Lead |
| ...

## Risk Heat Map
| | Low Impact | Medium Impact | High Impact |
|---|-----------|--------------|-------------|
| **High Likelihood** | | Data quality | |
| **Medium Likelihood** | | Change mgmt | API limits |
| **Low Likelihood** | | | |

## Mitigation Timeline
[Gantt-style text showing when each mitigation is addressed per phase]
```

**Implementation in `buildRiskAssessment()`:**
- When `risk_factors` array is empty, **generate domain-appropriate risks** from the query context:
  - If ERP mentioned → API stability, rate limiting, data format compatibility
  - If multi-region → regulatory compliance variance, data residency, timezone handling
  - If large employee count → change management, training, adoption resistance
  - If sustainability → reporting accuracy, emissions factor validation, audit requirements
  - Always include: data quality, integration complexity, scope creep, vendor dependency
- Score each risk as likelihood (1-3) × impact (1-3)
- Assign categories: Technical, Data, Organizational, Regulatory, Financial
- Include heat map visualization
- Sentinel/shield agent data enriches but never replaces generated risks

### 4. Financial Analysis — Structured Financial Model

**Structure:**

```markdown
# Financial Analysis

## Investment Summary
| Metric | Value |
|--------|-------|
| Total Investment | [from simData or costops] |
| Expected ROI | [from simData or costops] |
| Payback Period | [from simData or costops] |
| 5-Year NPV | [from simData or costops] |

## Cost Breakdown
| Category | Year 1 | Year 2 | Year 3 | Total |
|----------|--------|--------|--------|-------|
| Development | | | | |
| Infrastructure | | | | |
| Integration | | | | |
| Operations | | | | |
| **Total** | | | | |

## Scenario Analysis
| Scenario | Investment | ROI | Payback | NPV | Probability |
|----------|-----------|-----|---------|-----|------------|
| Optimistic | | | | | 25% |
| Base Case | | | | | 50% |
| Pessimistic | | | | | 25% |

## Sensitivity Analysis
[What assumptions change the outcome most — discount rate, adoption rate, cost overruns]

## Break-Even Analysis
[At what adoption rate / volume does the investment pay for itself]
```

**Implementation in `renderFinancialAnalysis()`:**
- Primary source: `simData` fields (budget, roi, npv, payback, financial_model)
- Enrichment source: costops agent results
- When neither has data, generate **reasonable estimates** from the query context:
  - Employee count × typical per-employee implementation cost
  - Timeline × typical monthly burn rate
  - Industry benchmark ROI ranges
- Always include scenario analysis (optimistic/base/pessimistic) even if derived from ±20% of base
- Never output "pending — agent data not available" — always produce a model

### 5. Roadmap — Resource-Costed Phased Plan

**Structure per phase:**

```markdown
## Phase 1: Discovery & Validation (Weeks 1-4)
**Investment:** $X | **Team:** Y FTEs | **Risk Gate:** Z

### Objectives
- [Specific, measurable objectives]

### Deliverables
- [Concrete outputs with acceptance criteria]

### Dependencies
- [What must be true before this phase starts]

### Success Criteria
- [How we know this phase succeeded — metrics, not feelings]

### Risk Gate
[What decision is made at the end of this phase before proceeding]
```

**Implementation in `buildRoadmapArtifact()`:**
- Each phase gets a cost estimate (from costops/budget or derived from timeline × team size)
- Each phase gets explicit dependencies
- Each phase has a risk gate — a decision point where stakeholders decide go/no-go
- Success criteria are measurable
- Resource requirements are specific (X engineers, Y weeks, Z infrastructure)
- Use copilot/planner agent data when available, but structure the output regardless

## Files to Change

- `src/synthesis/simulation-renderers.ts`:
  - `renderExecutiveSummary()` — Pyramid Principle narrative
  - `renderDecisionMemo()` — Options table, stakeholder impact, no contradictions
  - `buildRiskAssessment()` — Generated risks when empty, heat map, likelihood×impact
  - `renderFinancialAnalysis()` — Structured model, scenarios, break-even
  - `buildRoadmapArtifact()` — Costed phases, risk gates, success criteria
  - Add helper: `generateDomainRisks(query, extracted)` — context-aware risk generation
  - Add helper: `generateFinancialEstimates(query, extracted, simData)` — estimate when data missing

## Quality Bar

After this change, every document should pass the **boardroom test**:
1. A senior executive can read it and make a decision without asking clarifying questions
2. The financial model is internally consistent (numbers in exec summary match decision memo match financial analysis)
3. Risk assessment never says "no risks identified" for an enterprise system
4. Every recommendation is backed by evidence from the analysis
5. The document set could be presented alongside McKinsey/BCG/Bain deliverables without embarrassment

## Consequences

- [+] Executive documents are consulting-grade — credible in boardroom settings
- [+] Financial model is always populated (from simulation, agents, or derived estimates)
- [+] Risk register is always substantive (generated from context when agents return empty)
- [+] Documents are internally consistent (shared data extraction, no contradictions)
- [+] Roadmap includes resource costs and decision gates
- [-] Renderer functions grow significantly (~200-400 lines each)
- [-] Generated risk/financial estimates may not perfectly match actual customer context
- [-] The "generate when data is missing" approach means documents always look populated, even when agent data was unavailable — provenance footers must clearly indicate which data is measured vs. estimated
