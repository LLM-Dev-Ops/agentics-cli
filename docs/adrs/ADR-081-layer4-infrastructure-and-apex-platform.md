# ADR-081: Layer 4 Infrastructure, Phase 8 Core Bundles, and Apex Platform

## Status: IMPLEMENTED

## Date: 2026-03-31

## Context

The previous ADRs (075-080) cover individual Phase 1-7 services. This ADR covers the remaining platform layers:

- **Phase 8 Core Bundles** (services 27-34) — compose lower-layer agents into opinionated workflows
- **Phase 9 Apex Platform** (service 35) — the unified decision layer
- **Layer 4 Infrastructure** (services 36-54) — specialized infrastructure services

These layers represent the platform's highest-value capabilities. Phase 8 bundles mean the generated code doesn't need to wire 8 individual services together — it makes one call to Security-Core which orchestrates Shield + Policy-Engine + Incident-Manager + Edge-Agent + Config-Manager internally. Phase 9 Apex produces the board-level decision outputs. Layer 4 provides the specialized infrastructure that replaces significant chunks of hand-built code.

### What the Generated Code Currently Does Instead

| Platform Layer | Capability | Generated Code |
|---|---|---|
| Phase 8 bundles | Unified security workflow | Hand-wires Zod + requireRole() separately |
| Phase 8 bundles | Unified governance workflow | In-memory audit + hand-coded ACL separately |
| Phase 9 Apex | Executive summary, decision memo, risk score | Hand-built `executiveSummary` in scenario orchestrator |
| Layer 4 enterprise-roi-engine | Enterprise ROI modeling | Nothing — no ROI calculation |
| Layer 4 erp-surface | Standardized ERP adapter | 331-line custom Oracle client |
| Layer 4 execution-engine | Approved operation execution | Direct Oracle calls after approval |
| Layer 4 enforcement | Policy enforcement at execution time | Trust the ACL state and execute |
| Layer 4 results-index | Search across all outputs | Nothing — results are returned once and gone |
| Layer 4 usage-ledger | Immutable usage metering | Nothing — no metering |
| Layer 4 simulation-planner | Simulation strategy planning | Hard-coded scenario parameters |
| Layer 4 simulator-runner | Isolated simulation execution | In-process simulation |

## Decision

### 1. Use Phase 8 Core Bundles as the primary calling convention

Instead of calling 5 individual services per request, call the appropriate Core Bundle. Each bundle exposes a single endpoint that orchestrates its constituent agents:

```typescript
// INSTEAD OF calling Shield, Policy-Engine, Incident-Manager, Edge-Agent, Config-Manager separately:
// Call Security-Core once
const securityResult = await callPlatformService(
  process.env.AGENTICS_SECURITY_CORE_URL,
  '/api/v1/secure-request',
  {
    request: {
      body: requestBody,
      actor: iamClaims,
      endpoint: c.req.path,
      method: c.req.method,
    },
    checks: ['scan', 'authorize', 'validate_config', 'guard_execution'],
  }
);
// Security-Core internally: Shield scans → Policy-Engine authorizes → Config validates → Edge guards
// Returns unified result: { allowed: true/false, findings: [...], policies: [...] }

// INSTEAD OF calling CostOps, Governance-Dashboard, Policy-Engine, Analytics-Hub, Config-Manager, Schema-Registry separately:
// Call Governance-Core once
await callPlatformService(
  process.env.AGENTICS_GOVERNANCE_CORE_URL,
  '/api/v1/govern-operation',
  {
    operation: 'erp_writeback',
    actor: approverId,
    resource: writebackPayload,
    auditContext: { runId, inputHash, correlationId },
  }
);
// Governance-Core internally: logs audit → tracks cost → enforces policy → validates schema → produces analytics
```

**Available Core Bundles:**

| Bundle | Composes | Use When |
|---|---|---|
| **Security-Core** | Shield + Edge-Agent + Incident-Manager + Policy-Engine + Config-Manager | Every inbound request. Single "is this request safe and authorized?" call. |
| **Governance-Core** | CostOps + Governance-Dashboard + Policy-Engine + Analytics-Hub + Config-Manager + Schema-Registry | Every state-changing operation. Single "audit, cost-track, and govern this operation" call. |
| **Intelligence-Core** | Test-Bench + Observatory + Sentinel + Latency-Lens + Analytics-Hub + Schema-Registry | Every response. Single "observe, detect anomalies, and analyze this operation" call. |
| **Automation-Core** | Forge + Auto-Optimizer + Orchestrator + Connector-Hub | Workflow execution. Single "orchestrate this multi-step process" call. |
| **Data-Core** | Memory-Graph + Registry + Data-Vault + Config-Manager + Schema-Registry | Data operations. Single "persist, protect, and version this data" call. |
| **Interface-Core** | Forge + Config-Manager + Connector-Hub + CoPilot-Agent + Inference-Gateway | External interactions. SDK generation, inference routing, config management. |
| **Research-Core** | Schema-Registry + Simulator + Research-Lab | Experimentation. Hypothesis testing, simulation, metric tracking. |
| **Ecosystem-Core** | Marketplace + Analytics-Hub + Benchmark-Exchange | Sharing and comparison. Package publishing, benchmark leaderboards. |

### 2. Apex Platform produces final decision outputs

The generated `scenario-orchestrator.ts` builds an `executiveSummary` object with cost ranges, recommendations, and Pareto frontier analysis. This is useful domain-specific analysis, but the Apex Platform's agents produce the board-level synthesis:

```typescript
// After domain-specific scenario orchestration completes:
const domainResults = orchestrator.compareScenarios(scenarios, suppliers, sites, contracts, insurance);

// Apex Platform produces decision-grade outputs
const executiveSummary = await callPlatformService(
  process.env.AGENTICS_PLATFORM_URL,
  '/api/v1/executive-summary',
  {
    domainResults,
    costData: costOpsAttribution,      // from CostOps
    riskFindings: shieldFindings,       // from Shield
    anomalies: sentinelAlerts,          // from Sentinel
    auditTrail: governanceEvents,       // from Governance-Dashboard
    historicalContext: memoryGraphLineage, // from Memory-Graph
  }
);
// Returns: board-level narrative synthesizing all platform intelligence

const decisionMemo = await callPlatformService(
  process.env.AGENTICS_PLATFORM_URL,
  '/api/v1/decision-memo',
  {
    options: domainResults.paretoFrontier,
    criteria: ['cost', 'risk', 'resilience', 'insurance_premium', 'regulatory_exposure'],
    stakeholders: ['procurement', 'risk_management', 'finance', 'legal'],
    constraints: organizationalConstraints,
  }
);
// Returns: structured decision memo with options, tradeoffs, and recommendation per stakeholder

const riskScore = await callPlatformService(
  process.env.AGENTICS_PLATFORM_URL,
  '/api/v1/risk-score',
  {
    scenarios: domainResults.scenarios,
    supplierExposures: domainResults.supplierImpacts,
    insuranceCoverage: domainResults.insuranceModeling,
  }
);
// Returns: unified risk score with confidence interval and contributing factors

const goNoGo = await callPlatformService(
  process.env.AGENTICS_PLATFORM_URL,
  '/api/v1/decision',
  {
    decisionMemo,
    riskScore,
    costProjection: costOpsForecast,
    complianceStatus: governanceDashboardCompliance,
  }
);
// Returns: go/no-go recommendation with conditions, risks, and next steps
```

### 3. Layer 4: enterprise-roi-engine replaces missing ROI

CostOps tracks operational costs. enterprise-roi-engine models business impact:

```typescript
// Calculate enterprise-grade ROI
const roi = await callPlatformService(
  process.env.AGENTICS_ROI_ENGINE_URL,
  '/api/v1/calculate',
  {
    platform: {
      operationalCost: costOpsAttribution.total,        // from CostOps
      implementationCost: deploymentCosts,
      ongoingMaintenance: projectedMaintenance,
    },
    businessValue: {
      avoidedContractRenegotiation: domainResults.estimatedSavings,
      improvedSupplierResilience: resilienceGainValue,
      reducedInsurancePremiums: premiumReduction,
      regulatoryComplianceValue: compliancePenaltyAvoided,
      decisionSpeedImprovement: decisionCycleReduction,
    },
    timeHorizon: '3_years',
    discountRate: 0.08,
  }
);
// Returns: NPV, IRR, payback period, department-level breakdown
```

### 4. Layer 4: erp-surface replaces custom Oracle client

```typescript
// Instead of 331-line custom client:
const erpResult = await callPlatformService(
  process.env.AGENTICS_ERP_SURFACE_URL,
  '/api/v1/oracle/supplier-score-update',
  {
    supplierId: supplier.id,
    scores: { climateRisk: riskScore, resilience: resilienceIndex },
    governanceApproval: { requestId, approvedBy: approverId, inputHash },
    idempotencyKey: requestId,
  }
);
// erp-surface handles: auth, retry, circuit breaking, payload mapping, error normalization
```

### 5. Layer 4: results-index for searchable outputs

```typescript
// After every simulation run, index the results
await callPlatformService(process.env.AGENTICS_RESULTS_INDEX_URL, '/api/v1/index', {
  type: 'simulation_comparison',
  id: comparison.runId,
  data: comparison,
  searchableFields: ['scenarios', 'suppliers', 'recommendations', 'paretoFrontier'],
  tags: ['climate_risk', 'insurance', currentQuarter],
});

// Search across all historical results
const historical = await callPlatformService(
  process.env.AGENTICS_RESULTS_INDEX_URL,
  '/api/v1/search',
  { query: 'suppliers with coastal flood exposure above 0.7', limit: 20 }
);
```

### 6. Layer 4: usage-ledger for immutable metering

```typescript
// Every billable operation gets a ledger entry
await callPlatformService(process.env.AGENTICS_USAGE_LEDGER_URL, '/api/v1/record', {
  operation: 'simulation_run',
  actor: currentUser,
  organization: currentOrg,
  resources: { computeSeconds: elapsed / 1000, apiCalls: externalCallCount },
  timestamp: new Date().toISOString(),
});
```

### 7. Layer 4: simulation-planner + simulator-runner

Instead of hard-coding which scenarios to run:

```typescript
// Ask simulation-planner what to simulate
const plan = await callPlatformService(
  process.env.AGENTICS_SIM_PLANNER_URL,
  '/api/v1/plan',
  {
    domain: 'climate_risk',
    suppliers: supplierIds,
    sites: siteIds,
    historicalRuns: recentRunIds,
    objective: 'maximize_decision_coverage',
  }
);
// Returns: recommended scenarios, parameters, and supplier subsets to include

// Execute in isolated environment via simulator-runner
const results = await callPlatformService(
  process.env.AGENTICS_SIM_RUNNER_URL,
  '/api/v1/execute',
  {
    plan: plan.id,
    isolation: 'full',  // separate compute, no side effects
    timeout: '5m',
  }
);
```

## Consequences

### Positive
- Core Bundles dramatically simplify the calling convention — one call instead of 5-8
- Apex Platform produces the decision-grade outputs that enterprise leadership needs
- enterprise-roi-engine gives the CFO real NPV/IRR/payback numbers
- erp-surface eliminates 331 lines of custom Oracle code
- results-index makes historical simulation data searchable
- usage-ledger provides the metering needed for multi-tenant deployments
- simulation-planner removes hard-coded scenario definitions

### Negative
- Core Bundles add a layer of indirection — debugging requires tracing through the bundle to constituent services
- Apex Platform decision outputs need calibration per enterprise context
- More Layer 4 service URLs to configure

## Implementation Priority

**Days 3-7.** After individual services (ADR-075-080) are wired:
1. Phase 8 Core Bundles (simplify existing individual service calls into bundle calls)
2. Apex Platform decision outputs (highest business value)
3. enterprise-roi-engine (business case — complements CostOps)
4. erp-surface (replaces custom client)
5. results-index + usage-ledger (operational completeness)
6. simulation-planner + simulator-runner (advanced capability)

## Related ADRs
- ADR-074: Pipeline Must Use the Full Agentics Platform (master catalog)
- ADR-075-080: Individual service group ADRs
