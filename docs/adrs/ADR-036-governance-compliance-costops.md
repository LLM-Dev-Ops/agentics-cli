# ADR-036: Governance, Compliance & CostOps (Pass 4)

**Status:** Accepted
**Date:** 2026-03-17
**Deciders:** Platform Architecture Team
**Supersedes:** None
**Related:** ADR-032 (7-pass pipeline), ADR-033 (DecisionGraph), ADR-034 (artifacts #6, #7), ADR-035 (simulation feeds into CostOps)

## Context

Pass 4 of the enterprise pipeline produces the governance, compliance, and financial artifacts that enterprise decision-makers require before approving any implementation. This pass consumes outputs from all three prior passes:

- **Pass 1** — business context, regulatory environment, organizational constraints
- **Pass 2** — simulation scenarios, risk signals (feed directly into cost models and compliance analysis)
- **Pass 3** — architecture specification, integration map, prototype endpoints

Today, Shield, Policy-Engine, CostOps, and Governance-Dashboard agents operate independently. There is no defined protocol for how simulation data feeds into cost projections, how security findings inform policy analysis, or how all four domains converge into a unified governance picture.

## Decision

### Pass 4 Execution Model

Pass 4 executes four concurrent workstreams that converge into a unified governance report in the DecisionGraph.

```
Pass 1-3 outputs (DecisionGraph)
         │
         ├──► Workstream A: Security & Compliance (LLM-Shield)
         ├──► Workstream B: Policy Enforcement (LLM-Policy-Engine)
         ├──► Workstream C: Financial Modeling (LLM-CostOps)
         └──► Workstream D: Governance Visibility (LLM-Governance-Dashboard)
                    │
                    ▼
          Governance Convergence Report
                    │
                    ▼
         DecisionGraph (Pass 4 nodes)
```

### Workstream A: Security & Compliance Analysis

**Agents:** Prompt Injection Detection, PII Detection, Data Redaction, Secrets Leakage, Toxicity Detection, Safety Boundary, Content Moderation, Model Abuse Detection, Credential Exposure

**Inputs:**
- Architecture spec (Pass 3) — attack surface, data flows, integration points
- Reliability report (Pass 2) — adversarial vulnerabilities found during red team

**Analysis Dimensions:**

| Dimension | Agents | Output |
|-----------|--------|--------|
| Data Protection | PII Detection, Data Redaction, Secrets Leakage | Data exposure map: what sensitive data exists, where it flows, what's at risk |
| Runtime Safety | Prompt Injection, Toxicity, Safety Boundary, Content Moderation | Safety assessment: injection vectors, content risks, boundary violations |
| Credential Security | Credential Exposure, Model Abuse Detection | Credential flow analysis: how auth tokens move, where they're stored, abuse potential |

**Output:**
```typescript
interface SecurityAnalysis {
  overallRiskLevel: 'critical' | 'high' | 'medium' | 'low';
  dataExposureMap: {
    dataType: string;           // e.g., "PII - email addresses"
    location: string;           // e.g., "ERP API response body"
    risk: string;               // e.g., "Transmitted unencrypted to analytics"
    remediation: string;
  }[];
  safetyAssessment: {
    injectionVectors: string[];
    contentRisks: string[];
    boundaryViolations: string[];
  };
  credentialAnalysis: {
    authFlows: string[];
    storageLocations: string[];
    abuseVectors: string[];
  };
  remediationPriorities: {
    finding: string;
    severity: 'critical' | 'high' | 'medium' | 'low';
    effort: 'low' | 'medium' | 'high';
    recommendation: string;
  }[];
}
```

### Workstream B: Policy Enforcement

**Agents:** Policy Enforcement, Constraint Solver, Approval Routing

**Inputs:**
- Business context (Pass 1) — industry, geography, organizational policies
- Architecture spec (Pass 3) — technology choices, data handling patterns
- Security analysis (Workstream A, when available) — findings that have policy implications

**Analysis Dimensions:**

| Dimension | Description |
|-----------|-------------|
| Regulatory Compliance | Which frameworks apply (SOC2, GDPR, HIPAA, PIPEDA, PCI-DSS, etc.) based on industry and geography |
| AI Governance | Model explainability, bias reporting, human oversight requirements |
| Organizational Policy | Internal policies on data residency, vendor approval, change management |
| Approval Requirements | Who must approve based on budget thresholds, data sensitivity, regulatory exposure |

**Output:**
```typescript
interface PolicyAnalysis {
  applicableFrameworks: {
    framework: string;          // e.g., "GDPR"
    applicability: string;      // Why it applies
    complianceGaps: string[];   // Where the architecture falls short
    remediationSteps: string[];
  }[];
  aiGovernance: {
    explainabilityScore: 'full' | 'partial' | 'opaque';
    biasAssessment: string;
    humanOversightRequired: boolean;
    requirements: string[];
  };
  approvalRouting: {
    approver: string;           // Role, not person
    reason: string;             // Why their approval is needed
    threshold: string;          // What triggers this approval
  }[];
  overallComplianceStatus: 'compliant' | 'gaps_identified' | 'non_compliant';
}
```

### Workstream C: Financial Modeling

**Agents:** Cost Attribution, Cost Forecasting, Budget Enforcement, ROI Estimation, Cost-Performance Tradeoff

**Inputs:**
- Architecture spec (Pass 3) — components to cost (compute, storage, licensing, integration)
- Simulation scenarios (Pass 2) — scenario-specific cost variations
- Risk signals (Pass 2) — contingency budget requirements

**The simulation-to-cost feed is critical:** each simulation scenario generates a cost variant. The financial model is not a single projection — it is a scenario-aware cost range.

**Cost Model Structure:**
```typescript
interface CostModel {
  // Infrastructure breakdown
  infrastructure: {
    category: string;           // compute, storage, network, licensing
    provider: string;           // e.g., "AWS", "Azure", "on-prem"
    monthlyCost: number;
    annualCost: number;
    assumptions: string[];
  }[];

  // Integration costs
  integrationCosts: {
    system: string;             // e.g., "SAP S/4HANA API"
    setupCost: number;
    ongoingMonthlyCost: number;
    assumptions: string[];
  }[];

  // Operational costs
  operationalCosts: {
    category: string;           // staffing, training, support
    annualCost: number;
    fteRequired: number;
  }[];

  // Projections
  tco: {
    year1: number;
    year3: number;
    year5: number;
  };
  roi: {
    expectedReturn: number;
    paybackPeriodMonths: number;
    confidenceLevel: 'high' | 'medium' | 'low';
  };

  // Scenario variants
  scenarioVariants: {
    scenarioId: string;         // References Pass 2 scenario
    scenarioName: string;
    costDelta: number;          // +/- from base case
    explanation: string;
  }[];

  // Budget risk
  budgetRisk: {
    contingencyRequired: number;  // Based on failure scenario costs
    budgetExceedanceProbability: number;
    riskFactors: string[];
  };
}
```

### Workstream D: Governance Visibility

**Agents:** Governance Audit, Change Impact, Usage Oversight

**Inputs:**
- All Pass 1-3 outputs
- Outputs from Workstreams A-C (when available)

**Purpose:** Produce the governance readiness assessment and audit trail.

**Output:**
```typescript
interface GovernanceReport {
  auditTrail: {
    decision: string;
    madeBy: string;             // Agent or pipeline pass
    timestamp: string;
    rationale: string;
    dataInputs: string[];       // DecisionGraph node IDs used
  }[];

  changeImpact: {
    affectedSystem: string;
    changeType: string;
    impactLevel: 'high' | 'medium' | 'low';
    stakeholders: string[];
  }[];

  governanceReadiness: {
    overallScore: 'ready' | 'conditionally_ready' | 'not_ready';
    conditions: string[];       // What must be resolved before proceeding
    strengths: string[];
    gaps: string[];
  };
}
```

### Convergence

After all four workstreams complete, a **Governance Convergence Report** is written to the DecisionGraph. This node aggregates:

- Security risk level (from Workstream A)
- Compliance status (from Workstream B)
- Financial viability (from Workstream C)
- Governance readiness (from Workstream D)

This convergence node is the primary input for Pass 5's Decision Confidence Score.

### DecisionGraph Integration

Pass 4 writes the following node types:

| Node Type | Source | Count |
|-----------|--------|-------|
| `SECURITY_ANALYSIS` | Workstream A | 1 |
| `POLICY_ANALYSIS` | Workstream B | 1 |
| `COMPLIANCE_REPORT` | Workstream B | 1 |
| `COST_MODEL` | Workstream C | 1 |
| `GOVERNANCE_REPORT` | Workstream D | 1 |

### Exit Criteria

Pass 4 is complete when:
1. Security scan has completed (even if findings are zero)
2. Compliance analysis covers at least one applicable regulatory framework
3. Cost model has at least a Year 1 TCO projection
4. Governance readiness score is computed
5. All nodes written to DecisionGraph

## Consequences

### Positive
- Simulation data directly feeds cost models — projections are scenario-aware, not static estimates.
- Security findings inform policy analysis — no siloed assessment.
- Governance convergence gives Pass 5 a single, structured input for decision scoring.
- Audit trail is built automatically — satisfies enterprise governance requirements.

### Negative
- Four concurrent workstreams with cross-dependencies (A→B) add orchestration complexity.
- Financial projections are estimates — garbage assumptions yield garbage costs.
- Regulatory framework detection may miss niche industry regulations.

### Mitigations
- Workstream B can start with Pass 1-3 inputs and incorporate Workstream A findings when they arrive (eventual consistency within the pass).
- Cost model assumptions are explicitly listed — users can override them.
- Regulatory framework list is extensible — new frameworks can be added without schema changes.
