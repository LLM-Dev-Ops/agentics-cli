# ADR-080: Governance, Ecosystem, and Data Protection Services

## Status: IMPLEMENTED

## Date: 2026-03-31

## Context

The generated application implements governance as in-process code: `requireRole()` middleware for authorization, in-memory audit arrays in the Oracle ACL, and no data anonymization, no policy engine, no usage analytics, no strategic recommendations, and no registry of what's been deployed.

Meanwhile the platform has 8 services covering governance, ecosystem, and data protection that the generated code doesn't use:

| Service | What It Provides | What Generated Code Does Instead |
|---|---|---|
| **Governance-Dashboard** (3 agents) | Audit trail, change impact, usage oversight | In-memory audit arrays in `oracle-acl.ts` |
| **Policy-Engine** (3 agents) | Declarative enforcement, constraint solving, approval routing | Hard-coded `requireRole()` with static role lists |
| **Registry** (3 agents) | Model/agent registry, reputation scores, bootstrap templates | Nothing — no registry |
| **Marketplace** (2 agents) | Package components for reuse, deprecation management | Nothing |
| **Analytics-Hub** (2 agents) | Cross-system analytics, strategic recommendations | Nothing — no cross-system analytics |
| **Config-Manager** (1 agent) | Config validation, secrets management | `process.env` with no validation |
| **Schema-Registry** (1 agent) | Schema version control, contract validation | Zod schemas defined inline, no versioning |
| **Data-Vault** (2 agents) | Access control on sensitive data, anonymization | PII regex in mapper only |

### Why Each Matters

**Governance-Dashboard**: The Oracle ACL stores audit events in an in-memory array. When the instance restarts, audit history is gone. Governance-Dashboard provides persistent, queryable, cross-instance audit trails. Change Impact Agent tracks how simulation parameter changes affect downstream decisions. Usage Oversight Agent shows who is using the system, how often, and for what.

**Policy-Engine**: The generated code has `requireRole('writer', 'admin')` hard-coded per endpoint. Policy-Engine provides declarative rules: "writeback requests over $1M require approval from both risk and finance" or "suppliers in sanctioned regions require legal review." Constraint Solver handles complex multi-attribute authorization that `requireRole()` cannot express. Approval Routing sends approvals to the right person based on amount, domain, and organizational structure.

**Analytics-Hub**: The system produces simulation results, cost data, observability metrics, and governance events — but nothing synthesizes them. Analytics-Hub's Consensus Agent builds consensus across multiple stakeholders' scenario preferences. Strategic Recommendation Agent produces data-driven recommendations like "based on 50 runs, dual-sourcing consistently outperforms single-source on cost-adjusted resilience."

**Data-Vault**: The generated mapper has regex-based PII redaction for SSN/credit card patterns. Data-Vault provides comprehensive anonymization (names, addresses, medical data, non-US formats) and fine-grained access control on sensitive datasets. When a viewer role accesses supplier financials, Data-Vault can return anonymized data instead of blocking access entirely.

**Registry**: Nothing tracks what models, agents, or configurations are deployed. Registry provides a metadata store for everything the platform creates, with reputation scores for external data sources used in simulation.

## Decision

### 1. Governance-Dashboard replaces in-memory audit

Every audit event currently pushed to an in-memory array in `oracle-acl.ts` should go to Governance-Dashboard:

```typescript
// Replace: this.auditLog.push({ action, actor, timestamp, ... })
// With:
await callPlatformService(process.env.AGENTICS_GOVERNANCE_URL, '/api/v1/audit/log', {
  action: 'WRITEBACK_APPROVED',
  actor: approverId,
  resource: { type: 'writeback_request', id: requestId },
  context: {
    inputHash: request.inputHash,
    simulationRunId: request.runId,
    targetSystem: 'oracle_fusion_cloud',
  },
  correlationId: currentCorrelationId(),
});

// Query audit trail (for compliance views)
const auditTrail = await callPlatformService(
  process.env.AGENTICS_GOVERNANCE_URL,
  '/api/v1/audit/query',
  { resource: { type: 'writeback_request', id: requestId }, depth: 'full' }
);

// Change Impact: before a parameter change, check what it affects
const impact = await callPlatformService(
  process.env.AGENTICS_GOVERNANCE_URL,
  '/api/v1/impact/assess',
  { change: { parameter: 'probability_cap', from: 0.95, to: 0.90 } }
);
// Returns: "Affects 47 historical simulation runs. 12 recommendations would change severity."

// Usage Oversight
const usage = await callPlatformService(
  process.env.AGENTICS_GOVERNANCE_URL,
  '/api/v1/oversight/usage',
  { period: 'last_30d', groupBy: 'role' }
);
```

### 2. Policy-Engine replaces hard-coded role checks

```typescript
// BEFORE: Static role check
app.post('/erp/supplier-score-update', requireRole('erp_writer', 'admin'), handler);

// AFTER: Declarative policy evaluation
app.post('/erp/supplier-score-update', async (c, next) => {
  const decision = await callPlatformService(process.env.AGENTICS_POLICY_URL, '/api/v1/evaluate', {
    action: 'erp_writeback',
    subject: {
      roles: c.get('iamClaims').roles,
      department: c.get('iamClaims').department,
      userId: c.get('iamClaims').sub,
    },
    resource: {
      type: 'supplier_score_update',
      supplierId: c.req.param('id'),
      amount: requestBody.estimatedImpact,
      region: requestBody.supplierRegion,
    },
    context: {
      time: new Date().toISOString(),
      previousApprovals: existingApprovals,
    },
  });

  if (!decision.allowed) {
    return c.json({ error: 'Policy denied', reasons: decision.reasons }, 403);
  }

  // Policy may require additional approvals
  if (decision.requiresApproval) {
    // Route to the appropriate approver(s) via Approval Routing Agent
    await callPlatformService(process.env.AGENTICS_POLICY_URL, '/api/v1/approval/route', {
      request: requestId,
      requiredApprovers: decision.requiredApprovers, // e.g., ['risk_lead', 'finance_director']
      reason: decision.approvalReason,
    });
    return c.json({ status: 'pending_approval', approvers: decision.requiredApprovers }, 202);
  }

  await next();
});
```

Policy-Engine enables rules like:
- "Writebacks affecting suppliers in high-risk regions require risk team approval"
- "Simulation parameter changes require the original requester to re-validate"
- "Budget over $500K requires finance director sign-off"
- "After hours operations are read-only unless emergency flag is set"

These are configured as policies, not compiled into middleware.

### 3. Analytics-Hub for cross-system intelligence

```typescript
// After accumulating simulation runs, ask Analytics-Hub for recommendations
const recommendation = await callPlatformService(
  process.env.AGENTICS_ANALYTICS_URL,
  '/api/v1/recommend',
  {
    domain: 'supplier_risk_strategy',
    dataPoints: ['simulation_results', 'cost_data', 'governance_events', 'erp_writeback_history'],
    question: 'Which scenario configurations consistently produce the best cost-adjusted resilience?',
  }
);

// Build consensus across stakeholder preferences
const consensus = await callPlatformService(
  process.env.AGENTICS_ANALYTICS_URL,
  '/api/v1/consensus',
  {
    topic: 'preferred_scenario_for_q3_planning',
    stakeholders: [
      { role: 'procurement', preference: 'cost_optimized' },
      { role: 'risk_management', preference: 'resilience_optimized' },
      { role: 'finance', preference: 'insurance_cost_minimized' },
    ],
    simulationData: recentComparisons,
  }
);
```

### 4. Data-Vault for access control and anonymization

```typescript
// When a viewer role requests supplier financial data
app.get('/suppliers/:id/financials', async (c) => {
  const rawData = await getSupplierFinancials(c.req.param('id'));

  // Ask Data-Vault to apply access control and anonymization
  const result = await callPlatformService(process.env.AGENTICS_DATAVAULT_URL, '/api/v1/access', {
    data: rawData,
    requester: {
      roles: c.get('iamClaims').roles,
      clearanceLevel: c.get('iamClaims').clearance,
    },
    dataClassification: 'confidential_financial',
    anonymizationRules: {
      viewer: ['anonymize_amounts', 'redact_contract_terms'],
      writer: ['redact_contract_terms'],
      admin: [],  // full access
    },
  });

  return c.json(result.data);
});
```

Data-Vault handles:
- Fine-grained access control based on role, clearance, data classification
- Anonymization that preserves statistical properties (amounts are bucketed, not zeroed)
- GDPR right-to-erasure for supplier contact information
- SOX compliance for financial data access logging (forwarded to Governance-Dashboard)

### 5. Config-Manager for validated configuration

```typescript
// At application startup
const configValidation = await callPlatformService(
  process.env.AGENTICS_CONFIG_URL,
  '/api/v1/validate',
  {
    config: currentConfig,
    schema: 'enterprise_pipeline_v1',
    environment: process.env.NODE_ENV,
  }
);

if (!configValidation.valid) {
  throw new Error(`Invalid configuration: ${configValidation.errors.join(', ')}`);
}
```

### 6. Schema-Registry for contract validation

```typescript
// Register API schemas at deployment
await callPlatformService(process.env.AGENTICS_SCHEMA_URL, '/api/v1/register', {
  schemas: [
    { name: 'simulation_request', version: '1.0.0', schema: simulationRequestSchema },
    { name: 'erp_writeback_payload', version: '1.0.0', schema: erpWritebackSchema },
    { name: 'telemetry_event', version: '1.0.0', schema: telemetryEventSchema },
  ],
});

// Validate at runtime before sending to external systems
const validation = await callPlatformService(process.env.AGENTICS_SCHEMA_URL, '/api/v1/validate', {
  schemaName: 'erp_writeback_payload',
  data: wirePayload,
});
```

### 7. Registry for metadata and reputation

```typescript
// Register the generated application in the platform registry
await callPlatformService(process.env.AGENTICS_REGISTRY_URL, '/api/v1/register', {
  type: 'generated_application',
  name: 'climate-risk-insurance-platform',
  version: '1.0.0',
  domain: 'climate_risk',
  components: ['scenario_orchestrator', 'rust_optimizer', 'oracle_acl'],
  dataSources: ['bigquery_climate', 'oracle_fusion_cloud'],
});

// Track reputation of external data sources
await callPlatformService(process.env.AGENTICS_REGISTRY_URL, '/api/v1/reputation/update', {
  source: 'noaa_climate_projections',
  metrics: { freshness: 0.9, completeness: 0.85, accuracy: 0.92 },
});
```

## Consequences

### Positive
- Audit trail is persistent, queryable, and cross-instance
- Authorization rules are declarative and can be changed without code deployment
- Cross-system analytics produce strategic recommendations from accumulated data
- Sensitive data is protected by role and classification, not just endpoint access
- Configuration is validated against schemas, not just trusted
- API contracts are versioned and validated

### Negative
- Policy-Engine adds latency to every authorized request (mitigated by caching policy decisions)
- More environment variables for service URLs
- Policy rules must be authored and maintained separately from code

## Implementation Priority

**HIGH — Days 2-5.**
1. Governance-Dashboard (replaces in-memory audit — compliance critical)
2. Policy-Engine (replaces hard-coded role checks — enables complex authorization)
3. Data-Vault (GDPR/SOX compliance for data access)
4. Analytics-Hub (strategic recommendations — high business value)
5. Schema-Registry + Config-Manager (validation — defensive)
6. Registry (metadata — operational)

## Related ADRs
- ADR-074: Pipeline Must Use the Full Agentics Platform
- ADR-049: RBAC Enforcement, Governance Gating, and Immutable Audit Trail (Policy-Engine supersedes requireRole())
- ADR-070: Secure ID Generation and ACL Hardening (audit logging moves to Governance-Dashboard)
