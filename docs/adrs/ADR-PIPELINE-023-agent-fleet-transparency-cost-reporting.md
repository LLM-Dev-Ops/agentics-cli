# ADR-PIPELINE-023: Agent Fleet Transparency, Cost Reporting, and Utilization Metrics

**Status:** Accepted
**Date:** 2026-04-08
**Priority:** HIGH — Users have no visibility into what they're paying for

## Context

Users invoke `agentics ask` and the platform dispatches 2-15+ agents across multiple domains. There is zero transparency into:

1. **Which agents ran** — manifest.json lists `agents_invoked` but doesn't show contribution level
2. **Which agents contributed** — no mapping from agent results to output documents
3. **Which agents failed or returned hollow data** — hollow detection exists (ADR-028) but results aren't user-facing
4. **What the run cost** — no cost estimate based on agents invoked, tokens used, or cloud functions called
5. **What the fleet effectiveness was** — no metric showing % of agents that produced actionable data
6. **Agent-to-document lineage** — when a user reads the financial analysis, they can't trace which costops agent produced which number

This is a business problem: cloud costs are accumulating from agent invocations, but users can't see whether they're getting value from those invocations. A customer paying for 109 agent calls should see that 85 contributed real data, 15 were enriched from hollow responses, and 9 failed — not just a final document with no provenance.

## Decision

### 1. Agent Fleet Report Artifact

Add `agent-fleet-report.md` to every pipeline run output. Structure:

```markdown
# Agent Fleet Report

## Fleet Summary
- **Agents Invoked:** 42
- **Successful (real data):** 31 (74%)
- **Enriched (hollow → filled):** 7 (17%)
- **Failed / Error:** 4 (9%)
- **Fleet Effectiveness Score:** 83%

## Cost Estimate
- **Estimated Token Usage:** ~45,000 tokens
- **Estimated Cost:** $0.12 (based on agent invocation model)
- **Cost Per Document:** $0.01 avg

## Per-Domain Breakdown

| Domain | Agents | Success | Hollow | Failed | Contributed To |
|--------|--------|---------|--------|--------|---------------|
| costops | 5 | 4 | 1 | 0 | financial-analysis.md, decision-memo.md |
| shield | 9 | 7 | 2 | 0 | security-assessment.md |
| sentinel | 5 | 3 | 1 | 1 | risk-assessment.json |
| connector-hub | 5 | 4 | 0 | 1 | integration-assessment.md |
| ...

## Agent Contributions

### financial-analysis.md
- costops/roi: Provided ROI calculation (payback: 14 months)
- costops/forecast: Provided 3-year projection ($1.2M → $3.4M)
- costops/attribution: Provided cost breakdown (infra 40%, dev 35%, ops 25%)

### security-assessment.md
- shield/pii: Scanned 3 data entities, found 2 PII fields
- shield/secrets: No credential exposure detected
...

## Hollow Response Details
- analytics-hub/consensus: Returned generic "evaluate" text → enriched with domain-specific consensus
- sentinel/drift: Returned 0/0.5 numeric values → enriched with realistic drift metrics
```

### 2. Cost Tracking Integration

Add cost estimation to the fleet report:

```typescript
interface AgentCostEstimate {
  domain: string;
  agent: string;
  estimatedTokens: number;
  estimatedCostUsd: number;
  wasEnriched: boolean;  // enrichment costs additional tokens
}
```

Cost estimation based on:
- Agent response size (proxy for output tokens)
- Whether enrichment was triggered (adds ~500 tokens per enriched response)
- Domain-specific multipliers (costops agents typically produce larger responses)

### 3. Agent-to-Document Lineage

Each rendered document includes a provenance footer:

```markdown
---
*Sources: costops/roi (success), costops/forecast (success), costops/attribution (enriched)*
*Fleet run: sim-fd989608 | Generated: 2026-04-08T22:15:00Z*
```

### 4. Fleet Effectiveness Score

Composite metric:

```
Fleet Effectiveness = (successful_agents / total_invoked) * 0.6
                    + (documents_with_real_data / total_documents) * 0.3
                    + (1 - hollow_ratio) * 0.1
```

Reported in manifest.json and fleet report.

### 5. Manifest Enhancement

Extend `manifest.json` with fleet metrics:

```json
{
  "fleet_metrics": {
    "total_invoked": 42,
    "successful": 31,
    "enriched": 7,
    "failed": 4,
    "hollow_detected": 7,
    "effectiveness_score": 0.83,
    "estimated_cost_usd": 0.12,
    "agent_to_document_map": {
      "financial-analysis.md": ["costops/roi", "costops/forecast", "costops/attribution"],
      "security-assessment.md": ["shield/pii", "shield/secrets", "shield/credential-exposure"]
    }
  }
}
```

## Files to Change

- `src/synthesis/simulation-renderers.ts` — Add `renderAgentFleetReport()`, add provenance footers to all renderers
- `src/synthesis/simulation-artifact-generator.ts` — Compute fleet metrics, write fleet report artifact, enhance manifest
- `src/pipeline/enterprise/pass5-artifacts.ts` — Add provenance manifest with contribution tracking

## Consequences

- [+] Users see exactly what they're paying for — which agents ran, contributed, or wasted budget
- [+] Fleet effectiveness score gives a quick quality signal per run
- [+] Agent-to-document lineage enables trust verification ("where did this ROI number come from?")
- [+] Cost estimates help users understand per-run economics
- [+] Hollow detection visibility helps identify which agents need improvement
- [-] Fleet report adds ~5-10KB per run
- [-] Cost estimation is approximate (based on response size, not actual billing)
