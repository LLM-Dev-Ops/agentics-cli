# ADR-PIPELINE-022: Enterprise Deliverable Completeness — Consulting-Grade Document Package

**Status:** Accepted
**Date:** 2026-04-08
**Priority:** CRITICAL — Customers expect McKinsey/Accenture-level deliverables

## Context

The pipeline produces 15 artifacts per ADR-034 (enterprise pipeline) and 6 artifacts per simulation run (ask pipeline). However:

### Skeleton Documents (Exist But Empty)

| Artifact | Problem |
|----------|---------|
| CostOps Financial Model (#6) | Year 1/3/5 costs show `*TBD*`. No TCO, no ROI calculation, no break-even. |
| Implementation Roadmap (#8) | All three phases are placeholders: "*Scope, duration, success criteria*" |
| Stakeholder Map (#10) | RACI matrix shows "*To be determined from organizational analysis*" |
| Success Metrics/KPIs (#11) | All entries say "*To be defined*" |
| OKRs (#13) | "*Key results to be defined per strategic objective*" |
| RAID Log (#14) | Assumptions/Issues/Dependencies are empty tables |
| Compliance & Policy (#7) | Regulatory frameworks **hardcoded** (SOC2, GDPR, HIPAA) — violates ADR-034 |

### Missing Documents (Not Produced At All)

Compared to deliverables from Capgemini, CGI, McKinsey, Accenture, Deloitte, EY, PwC, KPMG:

| Document | Status | Source Data Available |
|----------|--------|---------------------|
| **Business Case with ROI** | Missing | costops/roi agent returns ROI data but it's discarded |
| **Cost-Benefit Analysis** | Missing | costops/tradeoff returns cost-quality comparisons |
| **Data Strategy / Data Quality Assessment** | Missing | connector-hub agents return data entity analysis |
| **Change Management Plan** | Missing | copilot/decomposer returns phased approach |
| **Vendor/Technology Selection Rationale** | Missing | auto-optimizer/model-select returns comparisons |
| **Governance Framework Document** | Missing | governance-dashboard/audit + policy-engine/enforce return framework data |
| **ERP Integration Assessment** | Missing | connector-hub/erp-surface returns detailed mappings |
| **Security Architecture Review** | Missing | shield/* agents return scan results |

### Ask Pipeline Artifacts (Even Worse)

The `agentics ask` pipeline produces only 6 artifacts:
1. manifest.json
2. scenario.json (stores all agent data but nothing reads it)
3. roadmap.json
4. executive-summary.md
5. risk-assessment.json (often with `risk_factors: []`)
6. decision-memo.md (ignores platform results)

No financial analysis, no security assessment, no integration plan, no agent utilization report.

## Decision

### Phase 1: Populate Existing Skeleton Documents

Wire agent results into the existing 15-artifact renderers in `src/pipeline/enterprise/pass5-artifacts.ts`:

| Artifact | Wire These Agents |
|----------|------------------|
| CostOps Financial Model (#6) | costops/roi → ROI calculation, costops/forecast → Year 1/3/5 projections, costops/attribution → cost breakdown by component, costops/budget → budget allocation |
| Implementation Roadmap (#8) | copilot/planner → phased plan, costops/forecast → cost per phase, research-lab/metrics → success metrics per phase |
| Stakeholder Map (#10) | copilot/decomposer → team structure, observatory/usage-patterns → user personas |
| Success Metrics/KPIs (#11) | research-lab/metrics → KPI definitions, test-bench/benchmark → baseline measurements |
| Compliance & Policy (#7) | **Remove hardcoded list.** Use shield/pii + shield/secrets scan results, policy-engine/enforce for applicable frameworks, governance-dashboard/audit for compliance requirements. Detect from geography/industry in query. |
| RAID Log (#14) | sentinel/anomaly → Risks, copilot/clarifier → Assumptions, sentinel/rca → Issues, connector-hub/erp-surface → Dependencies |

### Phase 2: Add Missing Documents to Ask Pipeline

Extend `simulation-artifact-generator.ts` from 6 to 12 artifacts:

7. **`financial-analysis.md`** — Business case + ROI + cost-benefit
   - Source: costops/roi, costops/forecast, costops/attribution, costops/tradeoff
   - Sections: Executive Financial Summary, Total Cost of Ownership (Year 1/3/5), ROI & Payback Period, Cost-Benefit Analysis, Sensitivity Analysis, Budget Allocation, Financial Risks

8. **`security-assessment.md`** — Security architecture + compliance
   - Source: shield/prompt-injection, shield/pii, shield/secrets, shield/credential-exposure, shield/toxicity
   - Sections: Security Posture, Data Protection (PII scan results), Secret Detection, Threat Vectors, Compliance Alignment, Recommendations

9. **`integration-assessment.md`** — ERP integration plan + data strategy
   - Source: connector-hub/erp-surface, connector-hub/database-query, connector-hub/webhook-ingest, connector-hub/auth-identity
   - Sections: ERP System Analysis, API Endpoint Mapping, Data Entity Mapping, Authentication Strategy, Data Quality Assessment, Migration Approach, Cutover Plan

10. **`agent-fleet-report.md`** — Agent utilization and contribution
    - Source: All agent results
    - Sections: Fleet Summary (invoked/succeeded/failed/hollow), Per-Domain Breakdown, Agent Contributions to Documents, Hollow Response Analysis, Enrichment Results, Fleet Effectiveness Score

11. **`change-management-plan.md`** — Organizational readiness
    - Source: copilot/decomposer, copilot/planner, observatory/usage-patterns
    - Sections: Stakeholder Analysis, Impact Assessment, Training Requirements, Communication Plan, Adoption Timeline, Resistance Management, Success Metrics

12. **`governance-framework.md`** — Decision governance
    - Source: governance-dashboard/audit, governance-dashboard/oversight, policy-engine/enforce, policy-engine/constraints
    - Sections: Governance Structure, Decision Authority Matrix, Approval Workflows, Audit Trail Requirements, Escalation Paths, Review Cadence

### Phase 3: Add Missing Documents to Enterprise Pipeline

Add 3 new artifacts to the enterprise 15-artifact set (making 18):

16. **`vendor-technology-rationale.md`**
    - Source: auto-optimizer/model-select, forge/sdk, forge/version-compat, inference-gateway/route
    - Sections: Technology Selection Matrix, Vendor Comparison, Licensing Analysis, Support Model, Migration Path, Lock-in Risks

17. **`data-strategy.md`**
    - Source: connector-hub/database-query, connector-hub/event-normalize, data-vault/access-control, data-vault/anonymize
    - Sections: Data Architecture, Master Data Management, Data Quality Framework, Data Governance Model, Privacy & Anonymization, Retention & Archival

18. **`kpi-measurement-framework.md`**
    - Source: research-lab/metrics, research-lab/hypothesis, test-bench/benchmark, observatory/slo
    - Sections: KPI Definitions with Baselines, Measurement Methodology, Reporting Cadence, Dashboard Requirements, Alert Thresholds, Success Criteria

## Files to Change

- `src/synthesis/simulation-renderers.ts` — Add 6 new renderer functions
- `src/synthesis/simulation-artifact-generator.ts` — Write 6 new artifacts (ask pipeline)
- `src/pipeline/enterprise/pass5-artifacts.ts` — Wire agent data into skeleton renderers, add 3 new artifacts
- `src/pipeline/enterprise/pass4-governance.ts` — Remove hardcoded compliance frameworks

## Consequences

- [+] Ask pipeline delivers 12 artifacts (up from 6) — complete consulting-grade package
- [+] Enterprise pipeline delivers 18 artifacts (up from 15) — matches Capgemini/Accenture scope
- [+] Financial analysis uses real costops data, not placeholders
- [+] Security assessment reflects actual Shield scan results
- [+] Compliance frameworks detected from context, not hardcoded
- [+] Every agent domain contributes to at least one document
- [-] 6 additional files per ask run, 3 per enterprise run
- [-] Renderer code grows significantly (~500 lines for 6 new renderers)
