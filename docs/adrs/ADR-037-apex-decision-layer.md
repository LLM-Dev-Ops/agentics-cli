# ADR-037: Apex Decision Layer (Pass 5)

**Status:** Accepted
**Date:** 2026-03-17
**Deciders:** Platform Architecture Team
**Supersedes:** None
**Related:** ADR-032 (7-pass pipeline), ADR-033 (DecisionGraph), ADR-034 (15 artifacts), ADR-039 (provenance tracing)

## Context

Pass 5 is the culmination of the enterprise pipeline — it reads all outputs from Passes 1-4 and generates the final decision artifacts that executives use to approve or reject an implementation. This is the pass that transforms raw analysis into enterprise-grade deliverables.

Today, the Apex agents (Decision, Executive Summary, Decision Memo, Risk Scoring) and the Diligence artifact generator exist but have no defined protocol for:
- How they read from the DecisionGraph
- How they divide artifact generation responsibilities
- How the Decision Confidence Score is computed
- How the OKRs, RAID Log, and Provenance Manifest (new in ADR-034) are produced

## Decision

### Pass 5 Execution Model

Pass 5 executes in two phases: **Generation** (concurrent) then **Scoring** (sequential, after generation completes).

```
Pass 1-4 outputs (DecisionGraph)
         │
         ▼
    ┌─ Phase 1: Artifact Generation (concurrent) ─┐
    │                                               │
    │  ├─ Decision Memo Agent      → Artifact #1    │
    │  ├─ Executive Summary Agent  → Artifact #2    │
    │  ├─ Risk Scoring Agent       → Artifact #5    │
    │  └─ Documentation Generator  → Artifacts      │
    │       #8, #9, #10, #11, #13, #14              │
    │                                               │
    └───────────────────────────────────────────────┘
         │
         ▼
    ┌─ Phase 2: Scoring & Assembly (sequential) ───┐
    │                                               │
    │  ├─ Decision Agent           → Artifact #12   │
    │  │   (Decision Confidence Score)              │
    │  ├─ Pipeline Orchestrator    → Artifact #15   │
    │  │   (Provenance Manifest)                    │
    │  └─ Package Assembler        → DECISION_      │
    │       PACKAGE.md index                        │
    │                                               │
    └───────────────────────────────────────────────┘
```

**Note:** Artifacts #3 (Architecture Spec) and #4 (Simulation Analysis) are produced in Passes 3 and 2 respectively. Artifacts #6 (CostOps) and #7 (Compliance) are produced in Pass 4. Pass 5 does not regenerate them — it reads them from the DecisionGraph.

### Phase 1: Artifact Generation

All Phase 1 agents run concurrently. Each reads from the DecisionGraph and writes its artifact(s) as new DecisionGraph nodes.

#### Decision Memo Agent → Artifact #1

**Reads:** Problem definition (Pass 1), architecture summary (Pass 3), ROI projection (Pass 4), top risks (Pass 2+4)

**Generation rules:**
- Decision Requested section must be one of: `Approve`, `Reject`, `Investigate Further`
- Financial Impact must reference specific numbers from the CostOps model, not invented figures
- Top Risks must be the highest-severity entries from the Risk Assessment, not rewritten
- Recommendation must include a confidence qualifier (e.g., "Proceed with high confidence" or "Proceed with conditions")

#### Executive Summary Agent → Artifact #2

**Reads:** All Pass 1-4 summary nodes

**Generation rules:**
- Maximum 2 pages (approximately 1000 words)
- Written for non-technical executive audience — no jargon, no code references
- Must include quantified outcomes (from CostOps and KPIs)
- Must include timeline (from Implementation Roadmap)
- Structure: Context → Problem → Solution → Outcomes → Risks → Timeline

#### Risk Scoring Agent → Artifact #5

**Reads:** Risk signals (Pass 2), security analysis (Pass 4), compliance gaps (Pass 4)

**Generation rules:**
- Risk register table: every risk from Passes 2 and 4, deduplicated by root cause
- Probability × Impact matrix (heat map)
- Top 5 risks with detailed mitigation plans
- Residual risk computed after mitigations applied
- No invented risks — every entry must trace to a specific Pass 2 or Pass 4 finding

#### Documentation Generator Agent → Artifacts #8, #9, #10, #11, #13, #14

This agent produces six artifacts in sequence (internally), reading from the DecisionGraph for each:

| Artifact | Primary DecisionGraph Inputs |
|----------|------------------------------|
| #8 Implementation Roadmap | Architecture (Pass 3), CostOps (Pass 4), scenarios (Pass 2) |
| #9 Organizational Impact | Architecture (Pass 3), integration map (Pass 3), business context (Pass 1) |
| #10 Stakeholder Map | Business context (Pass 1), approval routing (Pass 4), org impact (#9) |
| #11 Success Metrics & KPIs | CostOps (Pass 4), architecture (Pass 3), problem definition (Pass 1) |
| #13 OKRs & Strategic Alignment | Business context (Pass 1), KPIs (#11), roadmap (#8) |
| #14 RAID Log | Risks (#5), all assumptions from Passes 1-4, open issues, dependencies from architecture (Pass 3) |

**Generation rules for each:**

**#8 Implementation Roadmap:**
- Phases must reference specific architecture components, not generic milestones
- Durations grounded in complexity (lines of integration, number of systems) not arbitrary
- Go/No-Go criteria between phases must be measurable

**#9 Organizational Impact:**
- Teams derived from architecture integration map — if the architecture touches SAP, the SAP admin team is listed
- Training requirements specific to the technologies in the prototype
- Organizational Readiness Score: 0-100 based on change magnitude vs. organizational capacity

**#10 Stakeholder Map:**
- RACI matrix with roles derived from business context and approval routing
- Every role must correspond to a function mentioned in the analysis, not generic placeholders

**#11 Success Metrics & KPIs:**
- Every KPI linked to a specific architecture component or CostOps line item
- Baseline values stated as assumptions if current-state data unavailable (explicitly marked)
- Measurement methodology defined (how will this KPI be tracked)

**#13 OKRs & Strategic Alignment:**
- 3-5 objectives derived from the problem definition's strategic importance
- Key results are quantified, time-bound, and traceable to KPIs (#11)
- Quarterly milestones aligned to implementation roadmap phases (#8)
- Alignment score computed: what percentage of stated strategic priorities does this address

**#14 RAID Log:**
- **Risks:** Extracted from artifact #5, not duplicated — cross-referenced by ID
- **Assumptions:** Every assumption made in Passes 1-4, collected from DecisionGraph node metadata
- **Issues:** Unresolved questions or blockers flagged by any agent
- **Dependencies:** Cross-workstream dependencies from architecture, external dependencies from integration map
- Each entry has: status (Open/Resolved/Accepted), priority (Critical/High/Medium/Low), owner (role)

### Phase 2: Scoring & Assembly

Phase 2 runs after all Phase 1 artifacts are complete.

#### Decision Agent → Artifact #12 (Decision Confidence Score)

**Reads:** All 13 artifacts produced so far (Phase 1 outputs + Pass 2-4 artifacts)

**Scoring formula:**

```
Overall Confidence = weighted average of:
  - Financial Outcome Stability (25%)   ← CostOps ROI confidence + budget risk
  - Operational Risk Level (20%)        ← Inverse of Risk Assessment severity
  - Compliance Exposure (20%)           ← Policy analysis compliance status
  - Architecture Feasibility (20%)      ← Simulation success probability + prototype status
  - Organizational Readiness (15%)      ← Org Impact readiness score
```

**Score interpretation:**
| Score | Recommendation |
|-------|---------------|
| 80-100% | Proceed — strong confidence |
| 60-79% | Proceed with Conditions — address identified gaps |
| 40-59% | Investigate Further — significant uncertainties |
| 0-39% | Do Not Proceed — fundamental issues identified |

**Degradation impact:** Each pass that completed in `degraded` status applies a -10% penalty to its corresponding component score, and the degradation is noted in the score report.

#### Pipeline Orchestrator → Artifact #15 (Provenance Manifest)

Auto-generated by the pipeline orchestrator (not an LLM agent). See ADR-039 for full specification.

#### Package Assembler → DECISION_PACKAGE.md

Generates the index file at `./plans/{execution_id}/DECISION_PACKAGE.md`:

```markdown
# Agentics Decision Package
**Execution ID:** {execution_id}
**Date:** {timestamp}
**Prompt:** {original user prompt}
**Decision Confidence Score:** {score}%
**Recommendation:** {Proceed | Proceed with Conditions | Investigate Further | Do Not Proceed}

## Artifacts

| # | Artifact | Status | File |
|---|----------|--------|------|
| 1 | Executive Decision Memo | ✅ Complete | [01-executive-decision-memo.md](./01-executive-decision-memo.md) |
| 2 | Executive Summary | ✅ Complete | [02-executive-summary.md](./02-executive-summary.md) |
| ... | ... | ... | ... |
| 15 | Agent & Code Provenance Manifest | ✅ Complete | [15-provenance-manifest.md](./15-provenance-manifest.md) |

## Pipeline Summary
- Passes Executed: 1-7
- Total Agents Invoked: {count}
- Execution Duration: {duration}
- Degraded Passes: {list or "None"}
```

### DecisionGraph Integration

Pass 5 writes the following node types:

| Node Type | Source | Count |
|-----------|--------|-------|
| `EXECUTIVE_MEMO` | Decision Memo Agent | 1 |
| `EXECUTIVE_SUMMARY` | Executive Summary Agent | 1 |
| `RISK_ASSESSMENT` | Risk Scoring Agent | 1 |
| `IMPLEMENTATION_ROADMAP` | Documentation Generator | 1 |
| `ORG_IMPACT` | Documentation Generator | 1 |
| `STAKEHOLDER_MAP` | Documentation Generator | 1 |
| `KPI_DEFINITION` | Documentation Generator | 1 |
| `OKR_ALIGNMENT` | Documentation Generator | 1 |
| `RAID_LOG` | Documentation Generator | 1 |
| `CONFIDENCE_SCORE` | Decision Agent | 1 |
| `PROVENANCE_MANIFEST` | Pipeline Orchestrator | 1 |

### Exit Criteria

Pass 5 is complete when:
1. All 15 artifacts exist (either generated in this pass or read from prior passes)
2. Decision Confidence Score is computed
3. Provenance Manifest is generated
4. DECISION_PACKAGE.md index is written
5. All artifact nodes written to DecisionGraph

## Consequences

### Positive
- Two-phase execution ensures scoring uses complete artifact data.
- Artifact generation rules prevent generic boilerplate — every artifact must reference specific upstream data.
- Decision Confidence Score provides a single, quantified go/no-go indicator.
- Package index gives stakeholders a single entry point to the full analysis.

### Negative
- Phase 2 is sequential — adds latency after Phase 1 completes.
- Documentation Generator produces 6 artifacts — it is a bottleneck if it runs slowly.
- Confidence Score formula is opinionated — organizations may weight dimensions differently.

### Mitigations
- Phase 2 is lightweight (scoring + file assembly) — typically completes in seconds.
- Documentation Generator can internally parallelize the 6 artifacts since they have minimal cross-dependencies.
- Confidence Score weights can be made configurable via pipeline configuration in future iterations.
