# ADR-PRR-008: Strengthen Executive Competitive Analysis to Consulting Grade

## Status: IMPLEMENTED

## Date: 2026-04-10

## Priority: MEDIUM — Address during pilot

## Effort: 2 hours

## Context

Production readiness review (2026-04-10) found that the executive summary references peer organizations (JPMorgan, Deutsche Bank, HSBC) as one-line examples but lacks the structured competitive analysis expected in McKinsey/BCG/Bain deliverables.

Current state: "JPMorgan achieved 22% e-waste reduction" — a supporting data point, not analysis.

Required state: A capability maturity comparison showing where this firm sits relative to peers, which capabilities close the gap, and what the competitive risk is of inaction.

## Decision

### 1. Add a Capability Maturity Comparison Table

The executive summary must include a multi-dimensional comparison:

| Capability | This Firm (Current) | JPMorgan | Deutsche Bank | HSBC | This Firm (Post-Pilot) |
|---|---|---|---|---|---|
| **Telemetry Integration** | Manual audits | Real-time device telemetry | Partial telemetry | Manual + quarterly audits | AI-scored real-time telemetry |
| **Predictive Analytics** | None (time-based refresh) | ML-based scoring | Rule-based scoring | Time-based + manual exceptions | Monte Carlo simulation + multi-factor scoring |
| **ESG Reporting** | Spreadsheet estimates | Automated Scope 3 tracking | Partial automation | Manual estimates | Automated carbon footprint per device |
| **Procurement Automation** | Manual requisitions | SAP-integrated auto-orders | Partial SAP integration | Oracle-integrated, batch | SAP Ariba direct integration with approval workflow |
| **Decision Governance** | Email approvals | Workflow with audit trail | Basic workflow | Email + spreadsheet | Hash-chained audit, separation of duties, RBAC |

**Maturity Scale**: None → Manual → Rule-Based → Automated → AI-Optimized

### 2. Add a Competitive Risk of Inaction Section

Frame the analysis around what happens if the firm does NOT proceed:
- Peers are 12-18 months ahead on telemetry integration
- EU CSRD compliance (mandatory 2025) requires automated Scope 3 tracking
- Procurement cost disadvantage grows as peers optimize refresh timing

### 3. Add a Gap-to-Close Summary

Identify the 3-5 specific capabilities that the pilot addresses and quantify the maturity jump:
- "This pilot moves telemetry integration from 'Manual' to 'AI-Optimized' — matching JPMorgan's capability in a single phase"
- "Governance jumps from 'Email approvals' to 'Hash-chained audit trail' — exceeding all peer implementations"

## Consequences

### Positive
- Executives see competitive positioning, not just internal ROI
- "Cost of inaction" framing creates urgency grounded in market data
- Gap-to-close summary directly links pilot investment to competitive outcomes
- Meets the standard expected in boardroom presentations

### Negative
- Peer capability data must be validated (currently from public sources and industry reports)
- Maturity assessments are subjective — document the assessment methodology

## Related ADRs
- ADR-PIPELINE-024: Consulting-Grade Executive Documents
- ADR-PIPELINE-030: Executive Document Quality
- ADR-PRR-002: Phase Gate Criteria
