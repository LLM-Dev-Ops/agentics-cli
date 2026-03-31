# ADR-079: Runtime Resilience, Orchestration, and Memory Services

## Status: IMPLEMENTED

## Date: 2026-03-31

## Context

The generated application hand-builds several capabilities that the platform already provides as deployed services:

| Generated Code | Lines | Platform Service That Already Does This |
|---|---|---|
| Circuit breaker in `erp-client/client.ts` | ~80 lines | **LLM-Edge-Agent** / Circuit Breaker Agent |
| Retry with jittered backoff in `erp-client/client.ts` | ~40 lines | **LLM-Edge-Agent** / Failover Agent |
| Governance state machine in `oracle-acl.ts` | ~120 lines | **LLM-Orchestrator** / State Machine Agent |
| In-memory sync queue in `erp-client/client.ts` | ~50 lines | **LLM-Orchestrator** / Retry & Recovery Agent |
| SHA-256 lineage hashing in `scenario-orchestrator.ts` | ~20 lines | **LLM-Memory-Graph** / Prompt Lineage Agent + Decision Memory Agent |
| Console error logging for failures | scattered | **LLM-Incident-Manager** / Incident Escalation Agent |
| No LLM optimization | N/A | **LLM-Auto-Optimizer** / Token Optimization + Model Selection |
| Custom Oracle HTTP client | ~200 lines | **LLM-Connector-Hub** / ERP Surface Agent |

This is ~500+ lines of code reimplementing what 6 platform services provide out of the box. The hand-built versions are also worse:
- Circuit breaker has no centralized state across instances
- Sync queue is in-memory (data loss on restart)
- Lineage hashing is stored nowhere persistent
- Failures are logged but never escalated
- No LLM call optimization exists at all

### Services Covered

| # | Service | Agents | What It Should Do at Runtime |
|---|---------|--------|------------------------------|
| 5 | **LLM-Memory-Graph** | Conversation Memory, Prompt Lineage, Decision Memory, Knowledge Graph Builder, Memory Retrieval, Long-Term Pattern (6) | Persist simulation lineage, decision history, knowledge graph of entity relationships |
| 8 | **LLM-Edge-Agent** | Tool Invocation, Circuit Breaker, Failover, Execution Guard, Caching Strategy (5) | Circuit breaking, failover, caching, operation validation |
| 9 | **LLM-Auto-Optimizer** | Self-Optimizing, Token Optimization, Model Selection (3) | Optimize LLM calls, select models, reduce token usage |
| 10 | **LLM-Incident-Manager** | Incident Escalation, Post-Mortem Generator, Human-in-the-Loop (3) | Escalate failures, generate post-mortems, gate critical operations |
| 11 | **LLM-Orchestrator** | Workflow Orchestrator, Task Scheduler, Dependency Resolver, Retry & Recovery, Parallelization, State Machine, Swarm Coordinator (7) | Workflow management, approval state machine, retry, scheduling, parallel execution |
| 20 | **LLM-Connector-Hub** | ERP Surface, Database Query, Webhook Listener, Event Normalization, Auth/Identity (5) | Standardized external system access |

## Decision

### 1. Edge-Agent replaces hand-built resilience code

The circuit breaker, retry logic, failover handling, and caching in `erp-client/client.ts` should be replaced with Edge-Agent calls:

```typescript
// BEFORE: Hand-built circuit breaker + retry
class OracleFusionClient {
  private circuitState = 'closed';
  private failureCount = 0;
  // ... 80 lines of circuit breaker
  // ... 40 lines of retry with backoff

  async callOracle(endpoint: string, payload: unknown) {
    if (this.circuitState === 'open') throw new Error('Circuit open');
    // ... manual retry loop with jittered backoff
  }
}

// AFTER: Use Edge-Agent
async callOracle(endpoint: string, payload: unknown) {
  return callPlatformService(process.env.AGENTICS_EDGE_URL, '/api/v1/invoke', {
    target: {
      service: 'oracle_fusion_cloud',
      endpoint,
      payload,
    },
    resilience: {
      circuitBreaker: true,
      retry: { maxAttempts: 3, backoff: 'jittered_exponential' },
      failover: { strategy: 'queue_for_retry' },
      timeout: 30000,
    },
    caching: {
      enabled: endpoint.startsWith('GET'),
      ttl: 300, // 5 minutes for read operations
    },
  });
}
```

Edge-Agent provides:
- **Cross-instance circuit breaker state** — if one Cloud Run instance sees Oracle failing, all instances know
- **Persistent retry queue** — survives instance restarts (replaces ADR-072 sync queue fix)
- **Intelligent caching** — repeated queries for the same supplier/scenario don't hit Oracle every time
- **Execution Guard** — validates operations before they execute (defense-in-depth with Shield)

### 2. Orchestrator replaces hand-built state machines and workflows

The governance approval workflow in `oracle-acl.ts` is a hand-coded state machine (draft → submitted → approved/rejected → executed). Orchestrator's State Machine Agent manages this:

```typescript
// Register the approval workflow with Orchestrator
await callPlatformService(process.env.AGENTICS_ORCHESTRATOR_URL, '/api/v1/workflows/register', {
  name: 'erp_writeback_approval',
  states: ['draft', 'submitted', 'approved', 'rejected', 'executed'],
  transitions: [
    { from: 'draft', to: 'submitted', requires: 'writer_role' },
    { from: 'submitted', to: 'approved', requires: 'approver_role', constraint: 'approver_ne_requester' },
    { from: 'submitted', to: 'rejected', requires: 'approver_role' },
    { from: 'approved', to: 'executed', requires: 'system' },
  ],
});

// Transition a writeback request
await callPlatformService(process.env.AGENTICS_ORCHESTRATOR_URL, '/api/v1/workflows/transition', {
  workflow: 'erp_writeback_approval',
  instanceId: requestId,
  to: 'approved',
  actor: approverId,
});
```

Orchestrator also provides:
- **Task Scheduler** — schedule recurring risk re-assessments (e.g., "re-run all supplier impact assessments every Monday")
- **Dependency Resolver** — ensure simulation completes before ERP writeback is offered
- **Parallelization** — run scenarios in parallel instead of sequentially
- **Retry & Recovery** — persistent retry for failed operations (replaces in-memory sync queue)

### 3. Memory-Graph replaces in-process lineage tracking

The scenario orchestrator computes SHA-256 hashes of simulation inputs for lineage but stores them nowhere persistent. Memory-Graph provides:

```typescript
// After each simulation run, persist lineage
await callPlatformService(process.env.AGENTICS_MEMORY_GRAPH_URL, '/api/v1/decisions/store', {
  type: 'simulation_run',
  runId: comparison.runId,
  inputHash: comparison.inputHash,
  inputs: {
    scenarios: scenarioNames,
    suppliers: supplierIds,
    sites: siteIds,
    timestamp: comparison.timestamp,
  },
  outputs: {
    paretoFrontier: comparison.paretoFrontier,
    recommendations: comparison.executiveSummary.recommendations,
    costRange: comparison.executiveSummary.totalCostRange,
  },
  lineage: {
    parentRunId: previousRunId, // if this is a follow-up simulation
    triggerSource: 'api_request',
    actor: currentUser,
  },
});

// Query lineage for audit
const history = await callPlatformService(
  process.env.AGENTICS_MEMORY_GRAPH_URL,
  '/api/v1/lineage/query',
  { entityType: 'simulation_run', entityId: runId, depth: 10 }
);

// Knowledge Graph: track entity relationships over time
await callPlatformService(process.env.AGENTICS_MEMORY_GRAPH_URL, '/api/v1/knowledge/relate', {
  subject: { type: 'supplier', id: supplierId },
  predicate: 'has_climate_exposure',
  object: { type: 'risk_zone', id: 'coastal_flood' },
  confidence: 0.87,
  source: { runId, scenario: 'rcp85_2035' },
});
```

Memory-Graph's Knowledge Graph Builder creates a persistent, queryable graph of relationships: suppliers → risk zones → insurance policies → contracts → project sites. This compounds over time — each simulation run enriches the graph.

### 4. Incident-Manager replaces console.error()

When things go wrong, the generated code logs to console. Incident-Manager escalates properly:

```typescript
// When circuit breaker opens
await callPlatformService(process.env.AGENTICS_INCIDENT_URL, '/api/v1/escalate', {
  severity: 'high',
  type: 'circuit_breaker_open',
  service: 'oracle_fusion_cloud',
  context: { recentErrors: lastFiveErrors, affectedOperations: queuedCount },
});

// When simulation produces anomalous results (flagged by Sentinel)
await callPlatformService(process.env.AGENTICS_INCIDENT_URL, '/api/v1/escalate', {
  severity: 'medium',
  type: 'simulation_anomaly',
  context: { runId, anomalies: sentinelFindings },
});

// Human-in-the-Loop for high-risk decisions
const hitlResult = await callPlatformService(process.env.AGENTICS_INCIDENT_URL, '/api/v1/hitl/request', {
  decision: 'erp_writeback_high_value',
  context: { amount: writebackAmount, supplier: supplierId, riskScore: riskScore },
  requiredApprovers: ['risk_team', 'finance_team'],
  timeout: '4h',
});
```

### 5. Auto-Optimizer manages LLM usage

Any LLM calls in the generated application (narrative generation, executive summaries, intent classification) should go through Auto-Optimizer:

```typescript
// Instead of direct LLM calls
const summary = await callPlatformService(process.env.AGENTICS_OPTIMIZER_URL, '/api/v1/optimize', {
  task: 'generate_executive_summary',
  input: simulationResults,
  constraints: {
    maxTokens: 2000,
    maxCost: 0.05,
    minQuality: 0.8,
  },
});
// Auto-Optimizer selects the best model, optimizes the prompt, and tracks token usage
```

### 6. Connector-Hub replaces custom ERP client

The 331-line `erp-client/client.ts` should delegate to Connector-Hub's ERP Surface Agent:

```typescript
// Instead of custom Oracle HTTP client
await callPlatformService(process.env.AGENTICS_CONNECTOR_URL, '/api/v1/erp/write', {
  system: 'oracle_fusion_cloud',
  operation: 'supplier_score_update',
  payload: mappedPayload,
  auth: { method: 'gcp_identity_token' },
  idempotencyKey: requestId,
});
```

Connector-Hub provides standardized adapters for Oracle, SAP, and other ERP systems. The generated code doesn't need to know Oracle's API specifics — that's Connector-Hub's job.

## Consequences

### Positive
- ~500 lines of hand-built resilience/orchestration/lineage code replaced by platform service calls
- Circuit breaker state is shared across instances
- Retry queue survives instance restarts
- Decision lineage is persistent and queryable
- Failures are escalated through proper channels
- LLM usage is optimized automatically
- ERP adapters are managed by the platform

### Negative
- More runtime dependencies on platform services
- Network latency for resilience operations (Edge-Agent) — mitigated by Edge-Agent's own caching
- Connector-Hub must support Oracle Fusion Cloud's specific API patterns

## Implementation Priority

**HIGH — Days 2-5.** Order of implementation:
1. Memory-Graph for lineage (fixes ADR-070 inputHash validation + ADR-072 persistence gap simultaneously)
2. Edge-Agent for resilience (replaces circuit breaker + sync queue)
3. Orchestrator for approval workflow (replaces hand-coded state machine)
4. Incident-Manager for escalation (replaces console.error)
5. Connector-Hub for ERP (replaces custom client)
6. Auto-Optimizer for LLM calls (new capability)

## Related ADRs
- ADR-074: Pipeline Must Use the Full Agentics Platform
- ADR-070: Secure ID Generation and ACL Hardening (inputHash validation moves to Memory-Graph)
- ADR-072: ERP Sync Queue Persistence (sync queue moves to Edge-Agent/Orchestrator)
