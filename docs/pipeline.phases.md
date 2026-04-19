# Agentics Execution Pipeline

This file defines the deterministic execution order of the Agentics platform.

The CLI must execute phases sequentially unless explicitly marked as a swarm phase.

---

# Phase Execution Order

1. Prompt Structuring
2. Simulation
3. Research
4. SPARC Generation (swarm)
5. SPARC Handoff
6. ADR / DDD Architecture (swarm)
7. Implementation Planning
8. Build
9. Validation
10. Integration Mapping
11. Governance / FinOps
12. Decision Packaging

---

# Phase Descriptions

## 1. Prompt Structuring
Convert user input into structured execution context.

Output:
PROMPT_CONTEXT.md

---

## 2. Simulation
Evaluate feasibility and scenario viability.

Output:
SIMULATION_ANALYSIS.md

Execution:
Sequential.

---

## 3. Research
Generate supporting analysis and technical research.

Output:
RESEARCH_NOTES.md

Execution:
Sequential.

---

## 4. SPARC Generation
Generate engineering architecture artifacts.

Execution:
Ruflo swarm.

Outputs:
SPECIFICATION.md
PSEUDOCODE.md
ARCHITECTURE.md
REFINEMENT.md
COMPLETION.md

---

## 5. SPARC Handoff
Merge the five SPARC documents without modification.

Output:
SPARC_HANDOFF.md

Execution:
Sequential deterministic merge.

---

## 6. ADR / DDD Architecture
Generate architecture decision records and domain models.

Execution:
Ruflo swarm.

Outputs:
ADR-001.md
ADR-002.md
ADR-003.md
ADR-004.md
ADR-005.md
ADR-006.md
ADR-007.md

domain-model.md
context-map.md

---

## 7. Implementation Planning
Translate ADR/DDD architecture into ordered implementation tasks.

Outputs:
IMPLEMENTATION_PLAN.md
implementation_prompts.json

Typical size:
10–30 prompts.

Execution:
Sequential planning.

---

## 8. Build
Execute implementation prompts sequentially.

Each prompt may internally use a Ruflo swarm.

Build responsibilities:
- generate domain code
- generate application services
- generate infrastructure adapters
- wire integrations
- publish ERP surface outputs

Mandatory repositories:
LLM-Forge
integrations
LLM-Connector-Hub
erp-surface

---

## 9. Validation
Evaluate build outputs using testing agents.

Output:
VALIDATION_REPORT.md

---

## 10. Integration Mapping
Connect generated system to infrastructure connectors.

Outputs:
integration configuration
connector mapping

ERP integrations are not implemented directly.
All enterprise outputs are published through ERP Surface endpoints.

---

## 11. Governance / FinOps
Evaluate risk, cost, and compliance.

Outputs:
ROI_REPORT.md
RISK_REPORT.md

---

## 12. Decision Packaging
Generate board-level artifacts.

Outputs:
EXECUTIVE_SUMMARY.md
DECISION_MEMO.md

---

# QE Phase Bindings (ADR-PIPELINE-083)

The `quality_engineering` domain (ADR-PIPELINE-080) binds to specific phases. Phase 8 is the gating anchor with 14 mandatory QE agents; phases 3, 5, 6, 7, 9, 10 bind subsets as optional (tag-activated).

| Phase | Mode | QE agents bound |
|-------|------|-----------------|
| 3 SPARC Generation | Optional (advisory) | Test Design Agent, Requirements Traceability Agent |
| 5 ADR / DDD | Optional (advisory) | Defect Prediction Agent, Test Design Agent |
| 6 Implementation Planning | Optional (advisory) | Coverage Gap Detection Agent |
| 7 Build | Optional (advisory) | Unit/Integration/Property/BDD Test Gen, Coverage Analysis |
| 8 Validation | **Mandatory (gating)** | All 14 QE agents |
| 9 Integration Mapping | Optional (advisory→gating) | Integration Test Gen, Chaos Engineering |
| 10 Governance / FinOps | Optional (advisory) | QE Reporting Agent |

Phase 8 mandatory failures halt the pipeline with exit 141 via the Ruvector Acceptance Gate. Phase 8 always runs its mandatory QE agents regardless of problem tags. Optional bindings activate only when the capability classifier matches QE-relevant tags on the phase's tag array — see `src/routing/domain-boundary.ts` (ADR-PIPELINE-082) for disambiguation rules.

Kill-switch and regression semantics: `AGENTICS_QE_GATING={on,advisory,off}` — see ADR-PIPELINE-086.