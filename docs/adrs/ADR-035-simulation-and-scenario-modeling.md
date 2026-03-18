# ADR-035: Simulation & Scenario Modeling (Pass 2)

**Status:** Accepted
**Date:** 2026-03-17
**Deciders:** Platform Architecture Team
**Supersedes:** None
**Related:** ADR-032 (7-pass pipeline), ADR-033 (DecisionGraph), ADR-034 (artifact #4 — Simulation & Scenario Analysis)

## Context

Pass 2 of the enterprise pipeline (ADR-032) is responsible for simulation and scenario modeling — generating deployment, failure, scaling, and integration scenarios before any architecture or prototype is built. This pass uses three agent domains:

1. **LLM-Simulator** — generates what-if scenarios
2. **LLM-Sentinel** — detects operational risk patterns
3. **LLM-Test-Bench** — validates model/prompt reliability

Today, these agents exist as independent domains dispatched via `agentics ask`. There is no defined protocol for how they collaborate within a pipeline pass, what inputs they require from Pass 1, or how their outputs feed into Pass 3 (architecture) and Pass 4 (governance/CostOps).

## Decision

### Pass 2 Execution Model

Pass 2 executes three concurrent workstreams that converge into a unified scenario matrix stored in the DecisionGraph.

```
Pass 1 outputs (DecisionGraph)
         │
         ├──► Workstream A: Scenario Generation (LLM-Simulator)
         ├──► Workstream B: Risk Signal Detection (LLM-Sentinel)
         └──► Workstream C: Model Reliability (LLM-Test-Bench)
                    │
                    ▼
            Scenario Matrix (merged)
                    │
                    ▼
         DecisionGraph (Pass 2 nodes)
```

### Workstream A: Scenario Generation

**Agents:** What-If Simulation Agent, Scenario Generator Agent

**Inputs from Pass 1:**
- Problem definition (business domain, scale, constraints)
- Technical scope (systems involved, data volumes)
- Architecture hypotheses (candidate approaches)

**Scenario Types Generated:**

| Type | Description | Example |
|------|-------------|---------|
| Deployment | How the system gets rolled out | Phased rollout vs. big-bang; cloud-first vs. hybrid |
| Integration | How external systems connect | ERP API availability, data format mismatches, auth flows |
| Failure | What breaks and how | Network partition, API timeout cascade, data corruption |
| Scaling | How the system handles growth | 10x load increase, geographic expansion, multi-tenant |
| Edge Case | Unusual but plausible conditions | Concurrent schema migration, regulatory change mid-deployment |

**Output per scenario:**
```typescript
interface Scenario {
  id: string;
  type: 'deployment' | 'integration' | 'failure' | 'scaling' | 'edge_case';
  name: string;
  description: string;
  assumptions: string[];
  probability: 'high' | 'medium' | 'low';
  impact: 'critical' | 'high' | 'medium' | 'low';
  expectedOutcome: string;
  mitigationStrategy: string;
  metrics: {
    reliabilityProbability?: number;    // 0.0 - 1.0
    failureProbability?: number;        // 0.0 - 1.0
    deploymentSuccessProbability?: number;
    estimatedRecoveryTime?: string;     // ISO 8601 duration
  };
}
```

**Minimum output:** 3 scenarios (at least one deployment, one failure).

### Workstream B: Risk Signal Detection

**Agents:** Anomaly Detection, Drift Detection, Incident Correlation, Root Cause Analysis

**Inputs from Pass 1:**
- Technical scope (technology stack, integration points)
- Business context (industry, regulatory environment)

**Risk signal categories:**

| Category | What It Detects |
|----------|----------------|
| Operational Risk | Infrastructure failure patterns, cascading dependencies |
| Integration Risk | API compatibility gaps, data format drift, version conflicts |
| Security Risk | Attack surface exposure, credential flow weaknesses |
| Compliance Risk | Regulatory misalignment patterns |
| Performance Risk | Latency bottlenecks, cold start impacts, resource exhaustion |

**Output per risk signal:**
```typescript
interface RiskSignal {
  id: string;
  category: 'operational' | 'integration' | 'security' | 'compliance' | 'performance';
  severity: 'critical' | 'high' | 'medium' | 'low';
  description: string;
  source: string;           // Which agent detected it
  correlatedWith: string[]; // IDs of related scenarios or other risk signals
  rootCause: string;        // RCA agent's analysis
  mitigationSuggestion: string;
}
```

### Workstream C: Model Reliability

**Agents:** Hallucination Detection, Faithfulness Verification, Bias Detection, Stress Test, Red Team, Adversarial Prompt

**Purpose:** Validate that the AI reasoning pipeline itself is trustworthy for this problem domain. This workstream tests the platform's own reliability, not the target system.

**Tests performed:**

| Test | Agent | What It Checks |
|------|-------|---------------|
| Hallucination Check | Hallucination Detection | Are scenario outputs grounded in Pass 1 data? |
| Faithfulness Check | Faithfulness Verification | Do agent outputs faithfully represent the input prompt? |
| Bias Check | Bias Detection | Are scenarios biased toward or against specific technologies/vendors? |
| Stress Test | Stress Test | Do agents produce consistent results under high-complexity prompts? |
| Red Team | Red Team + Adversarial Prompt | Can adversarial inputs cause agents to produce dangerous recommendations? |

**Output:**
```typescript
interface ReliabilityReport {
  overallScore: number;        // 0.0 - 1.0
  hallucinationScore: number;
  faithfulnessScore: number;
  biasScore: number;
  stressResilienceScore: number;
  redTeamFindings: string[];
  recommendation: 'reliable' | 'caution' | 'unreliable';
}
```

### Convergence: Scenario Matrix

After all three workstreams complete, their outputs are merged into a **Scenario Matrix** — a single DecisionGraph node that cross-references scenarios with risk signals and reliability assessments.

```typescript
interface ScenarioMatrix {
  scenarios: Scenario[];
  riskSignals: RiskSignal[];
  reliabilityReport: ReliabilityReport;
  crossReferences: {
    scenarioId: string;
    relatedRiskSignals: string[];
    reliabilityImpact: string;
  }[];
  overallRiskLevel: 'critical' | 'high' | 'medium' | 'low';
}
```

### DecisionGraph Integration

Pass 2 writes the following node types to the DecisionGraph (ADR-033):

| Node Type | Source | Count |
|-----------|--------|-------|
| `SCENARIO` | Workstream A | 3+ (one per scenario) |
| `RISK_SIGNAL` | Workstream B | Variable (one per detected risk) |
| `RELIABILITY_REPORT` | Workstream C | 1 |

All nodes have `pass: 2` and `derivedFrom` pointing to Pass 1 nodes.

### Downstream Consumption

| Downstream Pass | What It Reads from Pass 2 |
|----------------|---------------------------|
| Pass 3 (Architecture) | Scenarios → inform architecture decisions; risk signals → drive resilience requirements |
| Pass 4 (CostOps) | Scenarios → feed cost projections; failure scenarios → inform budget contingency |
| Pass 4 (Governance) | Risk signals → inform compliance analysis; reliability report → inform AI governance |
| Pass 5 (Decision) | Scenario Matrix → feeds Risk Assessment artifact; reliability → feeds Confidence Score |

### Exit Criteria

Pass 2 is complete when:
1. ≥3 scenarios generated (at least one deployment, one failure)
2. Risk signals classified by category and severity
3. Reliability score computed (even if some sub-scores are unavailable)
4. Scenario Matrix node written to DecisionGraph

If any workstream fails entirely, Pass 2 completes in `degraded` status with the available outputs.

## Consequences

### Positive
- Simulation happens before architecture — decisions are informed by scenarios, not the other way around.
- Risk signals are structural data, not prose — downstream agents can query and filter them.
- Model reliability testing builds trust in the platform's own outputs — critical for enterprise adoption.
- Scenario Matrix provides a single convergence point — no scattered, unlinked simulation results.

### Negative
- Three concurrent workstreams add complexity to Pass 2 orchestration.
- Simulation quality depends on the richness of Pass 1 outputs — thin problem definitions yield thin scenarios.
- Red Team / Adversarial testing adds latency — may be excessive for low-risk analyses.

### Mitigations
- Workstreams are independent and concurrent — wall-clock time is bounded by the slowest workstream, not the sum.
- Pass 1 exit criteria (ADR-032) enforce minimum problem definition quality before Pass 2 begins.
- Red Team testing can be skipped for low-risk analyses via `--skip-redteam` flag.
