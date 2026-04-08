# ADR-PIPELINE-020: Agent Result Consumption Pipeline

**Status:** Accepted
**Date:** 2026-04-08
**Priority:** CRITICAL — Directly impacts production readiness scores

## Context

The Agentics platform invokes up to 109 agents across 27 domains per simulation run. However, only 3-5 agent results are consumed by downstream document renderers:

- `platform/executive-summary` → executive-summary.md
- `platform/risk-score` → risk-assessment.json (partial)
- `platform/decision-memo` → decision-memo.md (**unused** — parameter is `_platformResults` with underscore prefix)

The remaining ~104 agents fire, return results, get stored in `scenario.json`'s `platform_analysis` array, and **nothing reads them**. Specifically:

| Domain | Agents | Invoked | Results Consumed |
|--------|--------|---------|-----------------|
| costops | roi, forecast, attribution, budget, tradeoff | Yes | **No** — zero financial documents generated |
| sentinel | anomaly, drift, alert, correlation, rca | Yes | **No** — not in risk assessment |
| observatory | telemetry, usage-patterns, failures, health-check, slo | Yes | **No** |
| shield | prompt-injection, pii, secrets, toxicity, credential-exposure | Yes | **No** — not in security assessment |
| connector-hub | erp-surface, database-query, webhook-ingest | Yes | **No** — not in integration assessment |
| research-lab | hypothesis, metrics | Yes | **Partial** — in research dossier only |
| copilot | planner, decomposer, clarifier, meta-reasoner | Yes | **Partial** — as LLM prompt context only |
| test-bench | benchmark, quality, hallucination, faithfulness | Yes | **No** |

Additionally, `ask-artifact-writer.ts` defines `data.roi` and `data.tradeoff` accessor fields (lines 363-364) but **never calls them** in any builder function.

## Decision

### 1. Create `extractAgentsByDomain()` utility

Add to `simulation-renderers.ts`:
```typescript
function extractAgentsByDomain(results: AgentResult[], domain: string): AgentResult[] {
  return results.filter(r => r.domain === domain && r.status >= 200 && r.status < 300);
}

function extractAgentData(results: AgentResult[], domain: string, agent: string): Record<string, unknown> | null {
  const r = results.find(r => r.domain === domain && r.agent === agent && r.status >= 200 && r.status < 300);
  return r ? (extractSignalPayload(r.response).data ?? r.response as Record<string, unknown>) : null;
}
```

### 2. Wire domain-specific agent results into existing renderers

| Renderer | Currently Uses | Must Also Use |
|----------|---------------|---------------|
| `renderExecutiveSummary()` | executive-summary, risk-score, decision-memo | costops/roi (ROI summary), research-lab/metrics (KPIs) |
| `renderDecisionMemo()` | **nothing** (_platformResults unused) | costops/roi, costops/tradeoff, platform/risk-score, research-lab/hypothesis |
| `buildRiskAssessment()` | risk-score only | sentinel/anomaly, sentinel/drift, shield/secrets, shield/pii, observatory/failures |
| `buildRoadmapArtifact()` | none (hardcoded phases) | copilot/planner (phase plan), costops/forecast (cost per phase), research-lab/metrics |
| `buildScenarioArtifact()` | stores all in platform_analysis | No change needed (data store is correct) |

### 3. Fix `_platformResults` in `renderDecisionMemo()`

Remove the underscore prefix and wire the parameter into the memo:
- Extract costops/roi for financial impact section
- Extract costops/tradeoff for alternative comparison
- Extract platform/risk-score for risk section
- Extract copilot/planner for implementation approach

### 4. Add new document renderers

Add to `simulation-renderers.ts`:

- `renderFinancialAnalysis(query, simulationResult, platformResults)` → Uses costops/roi, costops/forecast, costops/attribution, costops/budget, costops/tradeoff
- `renderSecurityAssessment(query, simulationResult, platformResults)` → Uses shield/*, governance-dashboard/audit
- `renderIntegrationAssessment(query, simulationResult, platformResults)` → Uses connector-hub/*, edge/*
- `renderAgentFleetReport(query, simulationResult, platformResults)` → All agents: utilization, contribution, hollow detection

### 5. Add new artifacts to `generateSimulationArtifacts()`

Extend the 6-artifact set to 10:
7. `financial-analysis.md` — ROI, TCO, cost-benefit, break-even
8. `security-assessment.md` — Shield scan results, credential exposure, PII findings
9. `integration-assessment.md` — ERP connector analysis, webhook patterns, data flow
10. `agent-fleet-report.md` — Which agents ran, contributed, failed, were hollow

## Files to Change

- `src/synthesis/simulation-renderers.ts` — Add extractors, fix _platformResults, add 4 renderers
- `src/synthesis/simulation-artifact-generator.ts` — Add 4 new artifact writes
- `src/synthesis/ask-artifact-writer.ts` — Wire data.roi and data.tradeoff into builders

## Consequences

- [+] All 109 agents contribute to output documents — no more wasted invocations
- [+] Financial analysis uses real costops agent data, not placeholders
- [+] Risk assessment enriched with sentinel/shield data
- [+] Users see which agents contributed and which failed
- [-] 4 additional artifact files per run (~50KB total)
- [-] Renderer functions become more complex
