# ADR-034: Deterministic Enterprise Artifact Package

**Status:** Accepted
**Date:** 2026-03-17
**Deciders:** Platform Architecture Team
**Supersedes:** None
**Related:** ADR-032 (7-pass pipeline), ADR-033 (DecisionGraph), ADR-037 (Apex Decision Layer), ADR-039 (provenance tracing)

## Context

Enterprise buyers evaluate technology investments through structured deliverables — the same artifacts that firms like McKinsey, Accenture, Capgemini, CGI, Deloitte, and PwC produce during consulting engagements. Today, the Agentics platform produces variable outputs depending on which agents fire and what content they generate. There is no guaranteed output contract.

To position the platform as **Enterprise Decision Infrastructure**, every pipeline execution must produce a deterministic, complete artifact package — regardless of the input prompt. Missing artifacts are explicitly marked as degraded, never silently omitted.

## Decision

Every full pipeline execution (Passes 1-7) produces exactly **15 deterministic enterprise artifacts**. Each artifact has a defined structure, producing agent(s), source pass, and quality criteria.

### The 15 Artifacts

---

#### 1. Executive Decision Memo
**Pass:** 5 — Decision Artifacts
**Producing Agent:** Decision Memo Agent
**Consulting Analogy:** McKinsey decision document

**Structure:**
- Decision Requested (Approve / Reject / Investigate Further)
- Problem Statement
- Strategic Importance & Business Justification
- Recommended Solution (architecture summary)
- Financial Impact (ROI projections from CostOps)
- Top Risks (from Risk Assessment)
- Recommendation with confidence level

**Quality Criteria:** Must reference specific outputs from Passes 2-4. No generic boilerplate.

---

#### 2. Executive Summary
**Pass:** 5 — Decision Artifacts
**Producing Agent:** Executive Summary Agent
**Consulting Analogy:** Board briefing document

**Structure:**
- Strategic Context
- Problem Description
- Recommended Architecture (summary, not full spec)
- Expected Outcomes (quantified where possible)
- Key Risks (top 3-5)
- Timeline Summary

**Quality Criteria:** ≤2 pages. Written for non-technical executive audience.

---

#### 3. Architecture & Prototype Specification
**Pass:** 3 — Architecture & Prototype Generation
**Producing Agents:** Orchestrator agents, Forge agents
**Consulting Analogy:** Accenture technology blueprint

**Structure:**
- System Architecture (components, boundaries, interfaces)
- Integration Map (external systems, data flows)
- Service Boundaries (DDD bounded contexts)
- Data Model (entities, aggregates, value objects)
- Generated Prototype (endpoint listing, tech stack)
- ERP Integration Points

**Quality Criteria:** Architecture must reflect detected ERP system and domain model (per ADR-029). Prototype must have at least one functional endpoint.

---

#### 4. Simulation & Scenario Analysis
**Pass:** 2 — Simulation & Scenario Modeling
**Producing Agents:** What-If Simulation Agent, Scenario Generator Agent
**Consulting Analogy:** CGI scenario modeling report

**Structure:**
- Deployment Scenarios (best case, expected, worst case)
- Failure Scenarios (integration failures, scaling limits)
- Scaling Scenarios (load projections)
- Integration Edge Cases
- Per-scenario metrics: reliability probability, failure probability, deployment success probability

**Quality Criteria:** ≥3 distinct scenarios. Each scenario has quantified probability and impact.

---

#### 5. Risk Assessment
**Pass:** 5 — Decision Artifacts (aggregated from Pass 2 + Pass 4)
**Producing Agent:** Risk Scoring Agent
**Consulting Analogy:** Deloitte risk register

**Structure:**
- Risk Register table: Risk | Category (technical/integration/security/compliance/operational) | Probability | Impact | Mitigation Strategy
- Risk Heat Map (probability × impact matrix)
- Top 5 Risks with detailed mitigation plans
- Residual risk after mitigations

**Quality Criteria:** Risks sourced from Sentinel agents (Pass 2) and Shield/Policy agents (Pass 4). No invented risks.

---

#### 6. CostOps Financial Model
**Pass:** 4 — Governance, Compliance & CostOps
**Producing Agents:** Cost Attribution, Cost Forecasting, ROI Estimation, Budget Enforcement
**Consulting Analogy:** Capgemini TCO/ROI financial model

**Structure:**
- Infrastructure Cost Breakdown (compute, storage, network, licensing)
- Cloud Usage Projections (monthly/annual)
- Integration Costs (third-party APIs, ERP connectors)
- Operational Staffing Requirements
- Total Cost of Ownership: Year 1, Year 3, Year 5
- ROI Projection with payback period
- Budget Risk Assessment

**Quality Criteria:** Costs derived from architecture spec (Pass 3) and simulation data (Pass 2). ROI includes sensitivity analysis.

---

#### 7. Compliance & Policy Analysis
**Pass:** 4 — Governance, Compliance & CostOps
**Producing Agents:** Shield agents, Policy Engine agents
**Consulting Analogy:** PwC regulatory assessment

**Structure:**
- Regulatory Landscape (applicable frameworks: SOC2, GDPR, HIPAA, PIPEDA, etc.)
- Data Governance Requirements
- Security Implications (prompt injection, PII exposure, credential risks)
- AI Governance Compliance (model bias, explainability, fairness)
- Policy Gaps (areas where current policies are insufficient)
- Remediation Recommendations

**Quality Criteria:** Regulatory frameworks detected from business context and geography, not hardcoded.

---

#### 8. Implementation Roadmap
**Pass:** 5 — Decision Artifacts
**Producing Agent:** Documentation Generator Agent
**Consulting Analogy:** Accenture delivery plan / Capgemini implementation roadmap

**Structure:**
- Phase 1 — Pilot (scope, duration, success criteria)
- Phase 2 — Department Rollout (expansion plan, prerequisites)
- Phase 3 — Enterprise Deployment (full scale, operational handoff)
- Milestones & Deliverables per phase
- Dependencies & Prerequisites
- Resource Requirements per phase
- Go/No-Go Criteria between phases

**Quality Criteria:** Phases reference specific architecture components. Durations are grounded in complexity analysis, not arbitrary.

---

#### 9. Organizational Impact Analysis
**Pass:** 5 — Decision Artifacts
**Producing Agent:** Documentation Generator Agent
**Consulting Analogy:** McKinsey change management assessment

**Structure:**
- Teams Affected (IT, data engineering, operations, compliance, business units)
- Process Changes Required
- Training Requirements (new tools, governance workflows, monitoring)
- Change Management Risks
- Communication Plan Outline
- Organizational Readiness Score

**Quality Criteria:** Teams and processes derived from architecture and integration map, not generic templates.

---

#### 10. Stakeholder Map
**Pass:** 5 — Decision Artifacts
**Producing Agent:** Documentation Generator Agent
**Consulting Analogy:** RACI matrix / governance stakeholder map

**Structure:**
- RACI Matrix (Responsible, Accountable, Consulted, Informed)
- Executive Sponsor identification
- Technical Owners
- Governance & Compliance stakeholders
- Business Stakeholders
- External Partners / Vendors
- Decision Authority Chain

**Quality Criteria:** Roles mapped to actual organizational functions identified in the problem context.

---

#### 11. Success Metrics & KPIs
**Pass:** 5 — Decision Artifacts
**Producing Agent:** Documentation Generator Agent
**Consulting Analogy:** Balanced scorecard / KPI framework

**Structure:**
- Operational KPIs (efficiency improvement %, system uptime, latency targets)
- Financial KPIs (cost reduction, revenue impact, ROI realization)
- Quality KPIs (error rates, customer satisfaction, SLA adherence)
- Adoption KPIs (user onboarding, feature utilization)
- Measurement methodology for each KPI
- Baseline values (current state) and target values

**Quality Criteria:** KPIs linked to specific architecture components and CostOps projections. Baselines require current-state data or clearly stated assumptions.

---

#### 12. Decision Confidence Score
**Pass:** 5 — Decision Artifacts
**Producing Agent:** Risk Scoring Agent + Decision Agent
**Consulting Analogy:** Unique to Agentics

**Structure:**
- Overall Confidence Score (0-100%)
- Component Scores:
  - Financial Outcome Stability (from CostOps)
  - Operational Risk Level (from Sentinel + Risk Assessment)
  - Compliance Exposure (from Shield + Policy Engine)
  - Architecture Feasibility (from Simulation + Prototype)
  - Organizational Readiness (from Impact Analysis)
- Score Methodology (weighted aggregation formula)
- Degradation Notes (any passes that ran in degraded mode)
- Final Recommendation (Proceed / Proceed with Conditions / Do Not Proceed)

**Quality Criteria:** Score is computed from actual pass outputs, not estimated. Degraded passes explicitly reduce the score.

---

#### 13. OKRs & Strategic Alignment
**Pass:** 5 — Decision Artifacts
**Producing Agent:** Documentation Generator Agent
**Consulting Analogy:** McKinsey/Capgemini strategic transformation deliverable

**Structure:**
- Strategic Objectives (3-5 high-level objectives aligned to organizational strategy)
- Key Results per Objective (2-4 measurable, time-bound key results each)
- Quarterly Milestones (Q1-Q4 targets mapped to implementation roadmap phases)
- Strategic Initiative Mapping (how this project connects to broader organizational initiatives)
- Alignment Score (how well the proposed solution maps to stated strategic priorities)
- Dependency on Other Initiatives (cross-program dependencies)

**Quality Criteria:** Objectives derived from business context in Pass 1, not generic. Key results are quantified and traceable to KPIs (Artifact #11) and CostOps projections (Artifact #6).

---

#### 14. RAID Log (Risks, Assumptions, Issues, Dependencies)
**Pass:** 5 — Decision Artifacts
**Producing Agent:** Documentation Generator Agent
**Consulting Analogy:** CGI/Accenture PMO standard deliverable

**Structure:**
- **Risks:** Extracted from Risk Assessment (#5), categorized by phase and severity
- **Assumptions:** Explicit assumptions made during analysis (e.g., "assumes current ERP version supports REST API", "assumes cloud budget approved")
- **Issues:** Known blockers or unresolved questions identified during Passes 1-4
- **Dependencies:** Cross-workstream, cross-team, and external dependencies with owners and due dates
- Status tracking: Open / In Progress / Resolved / Accepted
- Priority: Critical / High / Medium / Low

**Quality Criteria:** Every entry traced to a specific pipeline pass and agent output. Assumptions are falsifiable. Dependencies have identified owners.

---

#### 15. Agent & Code Provenance Manifest
**Pass:** 5 (generated at pipeline completion)
**Producing Agent:** Pipeline Orchestrator (automatic)
**Consulting Analogy:** Engagement methodology & tools appendix

**Structure:** See ADR-039 for full specification. Summary:
- Agent Inventory: every agent invoked, its domain, pass, execution time
- Code Inventory: every repo module, npm package, source file used
- Execution Flow: ordered sequence of agent invocations with timestamps
- Artifact Ownership: which agent produced which of the 15 artifacts
- Quality Scores: per-agent confidence scores

**Quality Criteria:** Auto-generated from runtime tracing (ADR-039). Not manually authored.

---

### Artifact Package Format

The complete package is output as:
1. **Individual `.md` files** — one per artifact, in a timestamped directory: `./plans/{execution_id}/`
2. **DecisionGraph nodes** — each artifact is a node in the DecisionGraph (ADR-033)
3. **Package index** — `./plans/{execution_id}/DECISION_PACKAGE.md` listing all 15 artifacts with links and status

### Partial Pipeline Artifacts

When running partial pipelines (`--passes 1-4`), only artifacts producible from completed passes are generated. The package index marks omitted artifacts as `NOT_GENERATED` with the reason (e.g., "Requires Pass 5").

### Degraded Artifacts

If a pass completes in degraded mode, its artifacts are still generated but marked with:
- `status: degraded` in the DecisionGraph node
- A visible `⚠️ DEGRADED` banner in the `.md` output
- An explanation of what data was missing or unreliable

## Consequences

### Positive
- Every execution produces the same 15 artifacts — enterprise buyers know exactly what they get.
- Artifact package mirrors what McKinsey/Accenture/Capgemini deliver — familiar to enterprise procurement.
- OKRs and RAID log fill the gap between technical analysis and program management.
- Provenance manifest provides full traceability — critical for audit and governance.
- Degraded-mode handling ensures partial results are still delivered, not silently dropped.

### Negative
- 15 artifacts is a large output set — smaller analyses may feel over-documented.
- Artifact quality depends entirely on agent output quality — garbage in, garbage out.
- New artifact types require schema updates to both the artifact spec and DecisionGraph.

### Mitigations
- Partial pipeline mode (`--passes`) naturally reduces artifact count for lightweight analyses.
- Content quality is governed by existing ADRs (027, 028, 029) and per-artifact quality criteria above.
- Artifact schema is versioned — additions are non-breaking.
