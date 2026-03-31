# ADR-075: CostOps Usage for Business Case Generation

## Status: IMPLEMENTED

## Date: 2026-03-31

## Context

CostOps (LLM-CostOps, Phase 4) is deployed on GCP with 5 agents:
- **Cost Attribution Agent** — tracks what costs what, broken down by operation, model, team
- **Cost Forecasting Agent** — projects spend over time based on usage patterns
- **Budget Enforcement Agent** — alerts when spend approaches thresholds
- **ROI Estimation Agent** — correlates platform cost against business value delivered
- **Cost-Performance Tradeoff Agent** — quantifies what you get for what you spend

The generated application currently has **zero cost tracking**. No operation records what it costs. No simulation run tracks compute spend. No ERP writeback records the cost of the governance workflow.

This is the single biggest gap for enterprise adoption. When a VP of Procurement asks "what does this system cost us per decision?" there is no answer. When a CFO asks "what's the ROI?" there is no data. CostOps exists specifically to produce these numbers, but the generated code never calls it.

### What Should Be Tracked

Every pipeline-generated application performs operations that have measurable costs:
- **LLM calls** — token consumption for codegen, simulation, analysis
- **Simulation runs** — compute time (Node.js + Rust subprocess), memory, duration
- **ERP operations** — Oracle API calls, governance workflow time
- **Data queries** — BigQuery scans, PostgreSQL queries
- **Infrastructure** — Cloud Run instance-seconds, memory-GB-seconds

Without CostOps, none of this is visible.

## Decision

### 1. Every generated application must call CostOps for cost-bearing operations

The codegen prompt must produce code that calls CostOps at these points:

```typescript
// After every simulation run
await callPlatformService(process.env.AGENTICS_COSTOPS_URL, '/api/v1/track', {
  operation: 'scenario_simulation',
  domain: 'climate_risk',  // or whatever domain this pipeline produced
  metadata: {
    scenarioCount: 5,
    supplierCount: 8,
    durationMs: elapsed,
    rustSubprocessMs: rustElapsed,
  },
  // CostOps agents compute the actual cost from operation metadata
});

// After every ERP writeback
await callPlatformService(process.env.AGENTICS_COSTOPS_URL, '/api/v1/track', {
  operation: 'erp_writeback',
  domain: 'oracle_fusion',
  metadata: {
    endpoint: 'supplier_score_update',
    governanceApprovalDurationMs: approvalElapsed,
  },
});

// After every API request (via middleware)
app.use('*', async (c, next) => {
  const start = Date.now();
  await next();
  // Fire-and-forget — don't block the response
  callPlatformService(process.env.AGENTICS_COSTOPS_URL, '/api/v1/track', {
    operation: 'api_request',
    domain: c.req.path.split('/')[3],  // e.g., 'climate'
    metadata: {
      method: c.req.method,
      path: c.req.path,
      status: c.res.status,
      durationMs: Date.now() - start,
    },
  }).catch(() => {}); // Non-blocking, operational tier
});
```

### 2. CostOps agents produce the business case outputs

Once operations are tracked, the CostOps agents can be queried to produce:

| CostOps Agent | Output | Enterprise Use |
|---|---|---|
| Cost Attribution | "Simulation runs cost $X/month, ERP writebacks cost $Y/month" | Budget line items |
| Cost Forecasting | "At current growth, monthly cost will be $Z by Q3" | Financial planning |
| ROI Estimation | "Each simulation saves $W in avoided contract renegotiation" | Business case justification |
| Cost-Performance Tradeoff | "Upgrading Rust engine reduces simulation cost by 40%" | Optimization decisions |
| Budget Enforcement | "Team X is at 80% of monthly budget" | Operational governance |

These outputs are queried via `agentics agents invoke costops <agent>` or via the CostOps REST API. The generated application's dashboard or reporting layer should surface them.

### 3. Cost tracking is fire-and-forget

CostOps is a "should have" tier service (ADR-074). If it's unavailable:
- Log the cost event locally
- Continue processing — never block domain operations for cost tracking
- Queue for retry on next successful connection

## Consequences

### Positive
- Enterprises get the cost/ROI data they need to justify the platform
- Every operation is attributable — no mystery spend
- CostOps agents produce forecasting and tradeoff analysis automatically
- Budget enforcement prevents runaway costs

### Negative
- Adds a fire-and-forget HTTP call to every operation — negligible latency impact
- Cost metadata schema must be defined per operation type

## Implementation Priority

**CRITICAL — Days 1-2.** Without cost data, there is no business case. CostOps is already deployed; the generated code just needs to call it.

## Related ADRs
- ADR-074: Pipeline Must Use Platform Services
