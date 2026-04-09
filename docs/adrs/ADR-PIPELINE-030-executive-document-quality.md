# ADR-PIPELINE-030: Executive Document Quality — Eliminate Query Echo, Template Leakage, and Generic Stakeholders

**Status:** Accepted
**Date:** 2026-04-09
**Priority:** HIGH — Recurring across all 3 evaluation runs

## Context

Executive-facing documents (executive summary, decision memo, research dossier) have three persistent quality problems:

### Problem 1: Query Echo in Problem Statement
`distillProblemStatement()` strips "I want to build..." but not "I lead sustainability and..." biographical introductions. Result: the executive summary opens with the user's own words reflected back, which is never acceptable in a consulting deliverable.

**Example from sustainability run:**
> "The organization requires ai could help us better understand and reduce unnecessary packaging"

This is a lowercase sentence fragment extracted from the middle of the user's query.

### Problem 2: Template Leakage Across Domains
The risk assessment generates domain-specific risks but also leaks risks from other domains:
- RD-036 in the packaging run references "sensor coverage per DMA" — a water utility concept
- "Workforce" appears as a stakeholder 4+ times instead of domain-specific roles

### Problem 3: Generic Stakeholders
The stakeholder patterns detect "Employees" and "Customers" but miss domain-specific roles:
- Water utility: VP Operations, Chief Engineer, Field Operations supervisors, Regulatory Affairs
- Sustainability: Sustainability Officer, Travel Policy Manager, ESG Reporting
- Packaging/procurement: Procurement Director, Supplier Relationship Managers, Packaging Engineers, Sustainability VP

## Decision

### 1. Problem Statement Extraction Must Strip Biographical Context

`distillProblemStatement()` must:
1. Strip "I lead/manage/run [role] for [org description]" biographical openings
2. Strip "One of the challenges we face is..." context-setting sentences
3. Extract core objective from "We believe..." / "Ideally, the system would..." / "The goal is..."
4. If the remaining text still starts with a lowercase conjunction, skip to the next sentence
5. Never output a lowercase-starting fragment

### 2. Risk Generation Must Be Domain-Scoped

`generateDomainRisks()` must:
1. Produce system-specific risks based on detected ERP (Workday, SAP, Maximo, Coupa, Oracle)
   - Workday: RaaS API rate limits, worker field gaps, custom report limitations
   - SAP: OData field mapping differences, CSRF token complexity
   - Maximo: OSLC version differences, custom attribute exposure
   - Coupa: Supplier API pagination, approval workflow integration
2. Add domain-specific risks only when domain signals are present in the query
3. Never include risks from unrelated domains (no "sensor coverage" in a procurement analysis)

### 3. Stakeholder Detection Must Be Industry-Aware

`STAKEHOLDER_PATTERNS` must include:
- Infrastructure/utility roles: VP Operations, Chief Engineer, Field Operations, Asset Management, SCADA/IoT
- Sustainability roles: Sustainability Officer, ESG Reporting, Travel Policy Manager
- Procurement roles: Procurement Director, Supplier Relationship Manager, Packaging Engineer
- General enterprise roles: Executive Sponsor, IT/OT, Finance/CFO, Compliance, Union Representatives

The decision memo stakeholder table must use a dynamic RACI-style format that maps extracted stakeholders to domain-appropriate roles, impacts, and actions — not generic "Technology Lead" / "Operations Team" fallbacks.

### 4. Success Probability Decomposition Must Be Domain-Aware

The current decomposition is mechanical: `techFeasibility = successProb + 0.04`. Replace with:
- Technical: higher for standard API patterns, lower for multiple system integrations
- Organizational: lower for large workforces (>10K employees), lower with complex constraints
- Data: lower for multi-system or multi-region scenarios
- Integration: lower proportional to number of detected external systems

### 5. Research Dossier Must Be Deduplicated

The self-concatenation bug (`scenarioAny` is the same object as `scenario`) in `research-dossier.ts` doubles all stakeholders, constraints, and success criteria. Fix by using `nestedScenario` for the second array and deduplicating via case-insensitive set.

## Consequences

### Positive
- Executive Output Quality score should increase from 3.0-4.5 to 6.5+
- Documents become credible in a boardroom setting
- No more prompt echo, template leakage, or generic stakeholders

### Negative
- More complex extraction logic increases maintenance surface
- Domain-specific patterns require updates as new industries are encountered

## Implementation

Files to modify:
- `src/synthesis/simulation-renderers.ts` — `distillProblemStatement()`, `generateDomainRisks()`, `STAKEHOLDER_PATTERNS`, `extractScenarioFromQuery()`, success probability decomposition
- `src/pipeline/phase2/phases/research-dossier.ts` — `extractFromScenario()` deduplication fix
