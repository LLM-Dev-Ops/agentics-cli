# ADR-038: Observability & Continuous Learning (Pass 7)

**Status:** Accepted
**Date:** 2026-03-17
**Deciders:** Platform Architecture Team
**Supersedes:** None
**Related:** ADR-032 (7-pass pipeline), ADR-033 (DecisionGraph), ADR-034 (artifact package)

## Context

Pass 7 is the post-deployment phase. After the prototype is deployed (Pass 6), the platform must monitor its real-world behavior, detect issues, handle incidents, and — critically — learn from outcomes to improve future pipeline executions.

Today, Observatory, Latency-Lens, Incident-Manager, and RuVector agents exist as independent domains. There is no defined protocol for:
- How observability feeds back into the DecisionGraph
- How incident data triggers re-evaluation of prior decision artifacts
- How the RuVector learning loop ingests outcomes and improves future pipeline runs
- When Pass 7 "ends" (if ever — observability is inherently continuous)

## Decision

### Pass 7 Execution Model

Unlike Passes 1-6, Pass 7 is **continuous** — it starts after Pass 6 completes and runs until explicitly stopped or until the deployment is decommissioned. It operates in three concurrent, long-running workstreams.

```
Pass 6 outputs (deployed endpoints)
         │
         ├──► Workstream A: Observability (LLM-Observatory)
         │         │
         │         ├──► Workstream B: Diagnostics & Incidents
         │         │    (LLM-Latency-Lens + LLM-Incident-Manager)
         │         │
         │         └──► Workstream C: Learning Loop (RuVector)
         │
         ▼
    Continuous feedback into DecisionGraph + Memory-Graph
```

### Workstream A: Observability

**Agents:** Telemetry Collector, Usage Pattern, Failure Classification, Health Check, SLA Enforcement, Visualization Spec

**Purpose:** Continuous monitoring of the deployed prototype and the pipeline's own performance.

#### Telemetry Collection

The Telemetry Collector agent establishes monitoring for:

| Metric Category | Examples | Source |
|----------------|----------|--------|
| Availability | Uptime %, endpoint response codes | Health Check Agent |
| Performance | Latency p50/p95/p99, throughput | Telemetry Collector |
| Usage | Request volume, unique users, feature utilization | Usage Pattern Agent |
| Errors | Error rates by type, failure classification | Failure Classification Agent |
| SLA Compliance | Metric vs. target for each defined SLA | SLA Enforcement Agent |

#### Health Check Protocol

```typescript
interface HealthCheck {
  endpointUrl: string;
  status: 'healthy' | 'degraded' | 'unhealthy';
  latencyMs: number;
  lastChecked: string;          // ISO 8601
  checkInterval: string;        // ISO 8601 duration (e.g., "PT5M")
  failureCount: number;         // Consecutive failures
  alertThreshold: number;       // Failures before escalation
}
```

Health checks run at configurable intervals (default: every 5 minutes). After `alertThreshold` consecutive failures, Workstream B is notified.

#### Usage Pattern Analysis

The Usage Pattern Agent identifies:
- Peak usage windows
- Underutilized features (candidates for removal or redesign)
- Unexpected usage patterns (possible misuse or unplanned integrations)
- Adoption metrics (tracking against KPIs from Artifact #11)

#### Visualization Specification

The Visualization Spec Agent generates dashboard configurations (not the dashboards themselves) that can be imported into Grafana, Datadog, or similar tools:

```typescript
interface DashboardSpec {
  name: string;
  panels: {
    title: string;
    metricQuery: string;
    visualization: 'timeseries' | 'gauge' | 'table' | 'heatmap';
    thresholds: { value: number; color: string }[];
  }[];
  alertRules: {
    condition: string;
    severity: 'critical' | 'warning' | 'info';
    notificationChannel: string;
  }[];
}
```

### Workstream B: Diagnostics & Incident Handling

**Agents:** Latency Analysis, Cold Start Mitigation (Latency-Lens), Incident Escalation, Post-Mortem Generator, Human-in-the-Loop (Incident-Manager)

#### Diagnostics (LLM-Latency-Lens)

Triggered when observability detects performance degradation:

| Trigger | Diagnostic Action |
|---------|-------------------|
| p99 latency exceeds SLA | Latency Analysis Agent traces the request path to identify bottleneck |
| Cold start detected | Cold Start Mitigation Agent recommends warming strategies |
| Throughput drop >20% | Latency Analysis Agent correlates with infrastructure metrics |

**Output:**
```typescript
interface DiagnosticReport {
  trigger: string;
  rootCause: string;
  affectedComponents: string[];
  recommendation: string;
  estimatedImpact: string;
  automaticMitigation: boolean;  // Can the platform fix this without human intervention?
}
```

#### Incident Handling (LLM-Incident-Manager)

Triggered when health checks fail or diagnostics identify critical issues:

**Escalation Protocol:**

| Severity | Criteria | Response |
|----------|----------|----------|
| P1 — Critical | Service down, data loss risk | Immediate escalation, Human-in-the-Loop Agent notifies stakeholders |
| P2 — High | Degraded performance, SLA breach | Automated diagnostics, escalation if unresolved in 15 minutes |
| P3 — Medium | Intermittent errors, non-critical feature failure | Logged, diagnostics scheduled, addressed in next maintenance window |
| P4 — Low | Cosmetic issues, minor deviations | Logged for trend analysis |

**Post-Mortem Generation:**

After any P1 or P2 incident is resolved, the Post-Mortem Generator Agent produces:

```typescript
interface PostMortem {
  incidentId: string;
  severity: string;
  timeline: {
    detected: string;
    escalated: string;
    mitigated: string;
    resolved: string;
  };
  rootCause: string;
  impact: string;
  actionItems: {
    action: string;
    owner: string;    // Role
    dueDate: string;
    status: 'open' | 'in_progress' | 'complete';
  }[];
  lessonsLearned: string[];
}
```

**Human-in-the-Loop:**

The HITL Agent manages scenarios requiring human judgment:
- Ambiguous incident classification
- Decisions that exceed the platform's authority (e.g., rollback affecting production users)
- Compliance-sensitive incidents (data breach, regulatory notification requirements)

It creates a structured handoff document with context, options, and recommended action, then pauses until human response is received.

### Workstream C: Continuous Learning Loop

**Agents:** Approval Learning Agent, Feedback Assimilation Agent (RuVector-Service)

This is the workstream that closes the feedback loop — making future pipeline executions better based on real-world outcomes.

#### Learning Inputs

| Input | Source | What It Teaches |
|-------|--------|----------------|
| Decision outcomes | Human feedback: was the decision correct? | Improves Decision Confidence Score calibration |
| Deployment success | Health checks, incident rate | Improves simulation scenario accuracy |
| Cost actuals vs. projections | Infrastructure billing data | Improves CostOps cost model accuracy |
| Architecture performance | Latency, throughput, error rates | Improves architecture hypothesis quality |
| Organizational adoption | Usage patterns, feature utilization | Improves Org Impact predictions |
| Incident patterns | Post-mortem action items | Improves risk signal detection |

#### Learning Pipeline

```
Real-world data
      │
      ▼
  ┌─ RETRIEVE ─┐
  │ Fetch prior DecisionGraph for this execution     │
  │ Find similar past executions via HNSW search      │
  └──────────────────────────────────────────────────┘
      │
      ▼
  ┌─ JUDGE ────┐
  │ Compare predicted outcomes (Passes 2-5) with      │
  │ actual outcomes (Pass 7 telemetry)                 │
  │ Generate verdicts: correct / partially_correct /   │
  │ incorrect for each prediction                      │
  └──────────────────────────────────────────────────┘
      │
      ▼
  ┌─ DISTILL ──┐
  │ Extract patterns from correct predictions          │
  │ Extract anti-patterns from incorrect predictions   │
  │ Store as learned patterns in Memory-Graph           │
  └──────────────────────────────────────────────────┘
      │
      ▼
  ┌─ CONSOLIDATE ┐
  │ Merge new patterns with existing knowledge base    │
  │ Prevent catastrophic forgetting (EWC++)            │
  │ Update agent routing weights (capability graph)    │
  └──────────────────────────────────────────────────┘
```

This follows the existing RuVector 4-step intelligence pipeline (RETRIEVE → JUDGE → DISTILL → CONSOLIDATE).

#### Learned Pattern Storage

Patterns are stored in the Memory-Graph (LLM-Memory-Graph) and indexed via HNSW for fast retrieval in future Pass 1 executions:

```typescript
interface LearnedPattern {
  id: string;
  type: 'success_pattern' | 'anti_pattern' | 'calibration_adjustment';
  domain: string;               // e.g., "cost_estimation", "risk_assessment"
  description: string;
  evidence: {
    executionId: string;
    predicted: string;
    actual: string;
    verdict: 'correct' | 'partially_correct' | 'incorrect';
  };
  adjustment: string;           // How future predictions should change
  confidence: number;           // 0.0 - 1.0
  applicableWhen: string[];     // Conditions under which this pattern applies
}
```

#### Feedback Assimilation

The Feedback Assimilation Agent collects explicit human feedback:

| Feedback Type | Collection Method | Impact |
|---------------|-------------------|--------|
| Decision approval/rejection | Platform UI or API callback | Trains Decision Confidence Score calibration |
| Artifact quality rating | Per-artifact star rating (1-5) | Prioritizes artifact generation improvements |
| Missing information flags | User marks gaps in artifacts | Adds new data requirements to future passes |
| Correction submissions | User corrects specific data points | Directly updates learned patterns |

### DecisionGraph Integration

Pass 7 writes the following node types:

| Node Type | Source | Count |
|-----------|--------|-------|
| `TELEMETRY_CONFIG` | Telemetry Collector | 1 |
| `HEALTH_CHECK` | Health Check Agent | Ongoing (one per check cycle) |
| `LEARNED_PATTERN` | Learning Loop | Ongoing (one per pattern) |

Unlike Passes 1-6, Pass 7 continues writing to the DecisionGraph over time. The graph grows as operational data accumulates.

### Pass 7 Lifecycle

| Phase | Duration | Trigger |
|-------|----------|---------|
| **Startup** | Immediate after Pass 6 | Pipeline orchestrator |
| **Active Monitoring** | Continuous | Automated on schedule |
| **Incident Response** | Event-driven | Health check failures, SLA breaches |
| **Learning Cycles** | Periodic (default: weekly) | Scheduled or triggered by significant outcome data |
| **Shutdown** | On command | `agentics pipeline stop --execution {id}` or deployment decommission |

### Exit Criteria (for pipeline completion reporting)

Pass 7's initial setup is "complete" when:
1. Telemetry collection is configured and active
2. At least one health check has passed
3. Learning loop is registered and awaiting first feedback cycle
4. All initial nodes written to DecisionGraph

The pass continues running after these criteria are met. The pipeline reports Pass 7 as `active` rather than `complete`.

## Consequences

### Positive
- Closed feedback loop — the platform genuinely learns from outcomes, not just executes.
- Incident handling is structured — post-mortems feed back into risk models.
- Cost actuals vs. projections improve CostOps accuracy over time.
- Human-in-the-Loop ensures the platform doesn't overstep its authority on critical decisions.

### Negative
- Continuous operation consumes resources even when the deployment is stable.
- Learning requires real-world outcome data — first few executions have no historical patterns to draw from.
- Post-mortem quality depends on incident classification accuracy.

### Mitigations
- Health check and learning cycle intervals are configurable — reduce frequency for stable deployments.
- Cold-start learning uses pretrained patterns from `npx @claude-flow/cli@latest hooks pretrain`.
- Post-mortem generation uses structured templates to maintain consistent quality.
