# ADR-PIPELINE-026: Simulation Financial Data Flow — Close the Agent-to-Document Gap

**Status:** Accepted
**Date:** 2026-04-09
**Priority:** CRITICAL — This is the #1 reason executive documents score 3.5/10

## Context

The pipeline invokes 9+ agents per run, several of which produce financial data:
- `copilot/planner` → phased implementation plan with effort estimates
- `simulator/what-if` → scenario analysis with probability and impact
- `simulator/scenario` → deployment scenarios with risk/cost factors
- `platform/decision` → go/no-go recommendation with financial context
- `costops/*` → ROI, forecast, attribution, budget, tradeoff (when invoked)

This data is captured in `scenario.json`'s `platform_analysis` array. But the simulation result object (`simData`) that renderers extract from has NONE of these fields. The simulation engine returns:

```json
{
  "success": true,
  "result": {
    "scenarioResult": { "status": "passed", "coverage": { "stepsPassed": 1, "stepsTotal": 1 } },
    "policyResult": { "complianceScore": 85 }
  }
}
```

No `budget`, no `roi`, no `npv`, no `payback_period`. The renderers call `safeString(simData, 'budget')` and get empty string. Every financial field falls through to the "To be quantified" fallback.

Meanwhile, the SAME pipeline run stores agent results with real financial context in `scenario.json.platform_analysis[]`, but the renderers look at `simulationResult` (the engine output) not at `platformAnalysis` (the agent results).

## Root Cause

The simulation artifact generator receives BOTH `simulationResult` AND `platformAnalysis`:

```typescript
interface SimulationArtifactInput {
  executionId: string;
  query: string;
  simulationResult: unknown;      // ← engine output (no financials)
  platformAnalysis: AgentResult[]; // ← agent results (HAS financials)
  correlationId: string;
  timing: number;
}
```

But the renderers receive `simulationResult` as their primary data source and only look at `platformResults` for specific named agents. The financial data from `copilot/planner` and `simulator/what-if` is in `platformResults` but the renderers don't look there for financial fields.

## Decision

### 1. Synthesize financial data from ALL sources before rendering

Add a `synthesizeSimulationData()` function that merges:
- Simulation engine result (simData)
- Agent results (platformResults) — extract structured fields
- Query-derived estimates (employee count, industry, scope)

```typescript
function synthesizeSimulationData(
  simData: Record<string, unknown>,
  platformResults: AgentResult[],
  query: string,
): Record<string, unknown> {
  const merged = { ...simData };
  
  // Extract financial data from agent results
  for (const agent of platformResults) {
    if (agent.status < 200 || agent.status >= 300) continue;
    const data = extractSignalPayload(agent.response).data;
    if (!data) continue;
    
    // Planner often has budget/timeline/phases
    if (agent.agent === 'planner' || agent.agent === 'decomposer') {
      if (!merged['budget']) merged['budget'] = safeString(data, 'budget') || safeString(data, 'estimated_cost') || safeString(data, 'total_budget');
      if (!merged['timeline_estimate']) merged['timeline_estimate'] = safeString(data, 'timeline') || safeString(data, 'estimated_duration');
      if (!merged['phases']) merged['phases'] = safeGet(data, 'phases') || safeGet(data, 'implementation_phases');
    }
    
    // What-if/scenario agents have financial projections
    if (agent.agent === 'what-if' || agent.agent === 'scenario') {
      if (!merged['roi']) merged['roi'] = safeString(data, 'roi') || safeString(data, 'expected_roi');
      if (!merged['npv']) merged['npv'] = safeString(data, 'npv') || safeString(data, 'net_present_value');
      if (!merged['payback_period']) merged['payback_period'] = safeString(data, 'payback_period') || safeString(data, 'payback');
      if (!merged['cost_savings']) merged['cost_savings'] = safeString(data, 'savings') || safeString(data, 'annual_savings');
    }
    
    // Decision agent has financial impact
    if (agent.agent === 'decision' || agent.agent === 'decision-memo') {
      if (!merged['budget']) merged['budget'] = safeString(data, 'investment') || safeString(data, 'budget');
      if (!merged['roi']) merged['roi'] = safeString(data, 'roi');
    }
    
    // CostOps agents
    if (agent.domain === 'costops') {
      if (agent.agent === 'roi' && !merged['roi']) merged['roi'] = safeString(data, 'roi') || safeString(data, 'expected_roi');
      if (agent.agent === 'forecast' && !merged['npv']) merged['npv'] = safeString(data, 'npv');
      if (agent.agent === 'attribution' && !merged['cost_breakdown']) merged['cost_breakdown'] = data;
      if (agent.agent === 'budget' && !merged['budget']) merged['budget'] = safeString(data, 'budget') || safeString(data, 'allocated_budget');
    }
  }
  
  // If STILL no financial data, estimate from query context
  if (!merged['budget'] && !merged['roi'] && !merged['npv']) {
    const estimates = estimateFinancialsFromQuery(query);
    Object.assign(merged, estimates);
  }
  
  return merged;
}
```

### 2. Call synthesizeSimulationData before ALL renderers

In `generateSimulationArtifacts()`, before calling any renderer:

```typescript
const synthesized = synthesizeSimulationData(simData, platformResults, input.query);
// Pass synthesized to all renderers instead of raw simData
```

### 3. estimateFinancialsFromQuery as last resort

When neither simulation nor agents provide financial data, estimate from:
- Employee count (extracted from query via simple string matching, not regex)
- Industry benchmarks (pharma: $25-50/employee, retail: $15-30/employee)
- Scope indicators (pilot vs enterprise, single region vs global)

All estimates clearly labeled: "Estimated based on organization size and industry benchmarks"

## Files to Change

- `src/synthesis/simulation-renderers.ts` — Add `synthesizeSimulationData()` and `estimateFinancialsFromQuery()`
- `src/synthesis/simulation-artifact-generator.ts` — Call synthesis before rendering

## Consequences

- [+] Financial data from agents flows into all executive documents
- [+] When agents don't produce financials, query-based estimates fill the gap
- [+] Documents never say "To be quantified" — they always have numbers (measured or estimated)
- [-] Estimated financials may not match actual customer context — labeled clearly
