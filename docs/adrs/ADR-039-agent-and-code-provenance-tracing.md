# ADR-039: Agent & Code Provenance Tracing

**Status:** Accepted
**Date:** 2026-03-17
**Deciders:** Platform Architecture Team
**Supersedes:** None
**Related:** ADR-032 (7-pass pipeline), ADR-033 (DecisionGraph), ADR-034 (artifact #15 — Provenance Manifest)

## Context

When an enterprise receives the 15-artifact Decision Package (ADR-034), a natural question arises: **"What produced this?"** Specifically:

1. Which AI agents were involved?
2. What source code / repo modules powered those agents?
3. In what order did they execute?
4. Which agent produced which artifact?
5. Can we audit the full chain for regulatory compliance?

Today, agent invocations are logged but not structured for provenance querying. There is no mechanism that maps agent execution back to the specific source code that powered it, and no automated report that summarizes the end-to-end process.

This ADR defines the **runtime tracing system** that collects provenance data throughout the pipeline and the **Provenance Manifest** that presents it as Artifact #15.

## Decision

### Provenance Tracing Architecture

Every agent invocation during a pipeline execution is recorded in a **Provenance Trace** — a structured log that captures identity, timing, inputs, outputs, and code lineage.

```
Pipeline Start
     │
     ├─► Agent invoked → TraceRecord written to DecisionGraph
     ├─► Agent invoked → TraceRecord written to DecisionGraph
     ├─► ...
     │
Pipeline End
     │
     ▼
Manifest Generator reads all TraceRecords → Produces Artifact #15
```

### TraceRecord Schema

Every agent invocation produces one TraceRecord:

```typescript
interface TraceRecord {
  // Identity
  traceId: string;              // UUID for this trace
  executionId: string;          // Pipeline execution ID

  // Agent Identity
  agent: {
    domain: string;             // e.g., "costops", "shield", "simulator"
    name: string;               // e.g., "Cost Attribution Agent"
    agentId: string;            // Runtime agent instance ID
    version: string;            // Agent version (from registry)
  };

  // Pipeline Position
  pass: number;                 // 1-7
  passName: string;             // e.g., "Governance, Compliance & CostOps"
  workstream: string;           // e.g., "Financial Modeling"

  // Timing
  startedAt: string;            // ISO 8601
  completedAt: string;          // ISO 8601
  durationMs: number;

  // Code Provenance
  codeProvenance: {
    package: string;            // npm package or repo name, e.g., "@agentics/costops"
    version: string;            // Package version
    entryPoint: string;         // Source file, e.g., "src/agents/cost-attribution.ts"
    repository: string;         // Git repo URL
    commitHash: string;         // Git commit SHA at execution time
    dependencies: string[];     // Key runtime dependencies
  };

  // Execution Details
  inputs: {
    decisionGraphNodes: string[];   // IDs of DecisionGraph nodes read
    parameters: Record<string, unknown>;  // Agent-specific parameters
  };
  outputs: {
    decisionGraphNodes: string[];   // IDs of DecisionGraph nodes written
    artifactNumbers: number[];      // Which of the 15 artifacts this agent contributed to
    status: 'success' | 'partial' | 'failed';
    confidence: number;             // 0.0 - 1.0
  };

  // Resource Usage
  resources: {
    tokensUsed: number;         // LLM tokens consumed
    modelUsed: string;          // e.g., "claude-sonnet-4-6", "claude-haiku-4-5"
    estimatedCost: number;      // USD
  };
}
```

### Trace Collection Mechanism

Tracing is implemented as a **pipeline middleware** — it wraps every agent invocation without modifying agent code.

```
Pipeline Orchestrator
     │
     ├─► TraceMiddleware.before(agentRef)  → Creates TraceRecord, records startedAt
     │        │
     │        ▼
     │    Agent executes (unchanged)
     │        │
     │        ▼
     ├─► TraceMiddleware.after(agentRef, result)  → Completes TraceRecord, records outputs
     │
     ▼
TraceRecord stored in DecisionGraph (namespace: provenance)
```

**Key principle:** Agents are unaware of tracing. They do not need to emit trace data. The middleware infers inputs (which DecisionGraph nodes were read) and outputs (which nodes were written) by diffing the graph state before and after agent execution.

### Code Provenance Resolution

The `codeProvenance` field is populated by the **Code Resolver** — a utility that maps agent identifiers to their source code:

| Resolution Method | How It Works |
|-------------------|-------------|
| Package registry lookup | Agent domain → npm package name → package.json version + repository field |
| Git context | Current working directory → `git rev-parse HEAD` for commit hash |
| Entry point mapping | Agent type → configured entry point in agent registry (existing `registry/index` agent) |
| Dependency resolution | Package lock file → key runtime dependencies |

For agents that are built-in to the CLI (not separate packages), the code provenance points to the CLI's own package and the specific source module.

### Provenance Manifest (Artifact #15)

At pipeline completion, the Manifest Generator reads all TraceRecords and produces a structured `.md` file.

#### Manifest Structure

```markdown
# Agent & Code Provenance Manifest
**Execution ID:** {execution_id}
**Date:** {timestamp}
**Pipeline Duration:** {total_duration}
**Total Agents Invoked:** {count}
**Total LLM Tokens Used:** {total_tokens}
**Estimated Pipeline Cost:** ${total_cost}

## Agent Inventory

| # | Agent | Domain | Pass | Duration | Tokens | Model | Status |
|---|-------|--------|------|----------|--------|-------|--------|
| 1 | Planner Agent | copilot | Pass 1 | 2.3s | 1,240 | claude-sonnet-4-6 | ✅ |
| 2 | Decomposer Agent | copilot | Pass 1 | 1.8s | 980 | claude-sonnet-4-6 | ✅ |
| ... | ... | ... | ... | ... | ... | ... | ... |

## Code Inventory

| Package | Version | Repository | Agents Using |
|---------|---------|------------|-------------|
| @agentics/copilot | 2.1.0 | github.com/ruvnet/agentics-copilot | Planner, Decomposer, Clarifier |
| @agentics/costops | 1.4.2 | github.com/ruvnet/agentics-costops | Cost Attribution, Forecasting, ROI |
| @agentics/shield | 3.0.1 | github.com/ruvnet/agentics-shield | PII Detection, Injection, Secrets |
| ... | ... | ... | ... |

**Git Commit:** {commit_hash}

## Execution Flow

### Pass 1 — Problem Intelligence
```
[00:00.000] Planner Agent started
[00:02.312] Planner Agent completed (✅)
[00:00.000] Decomposer Agent started (concurrent)
[00:01.843] Decomposer Agent completed (✅)
...
```

### Pass 2 — Simulation & Scenario Modeling
```
[00:04.200] What-If Simulation Agent started
...
```

*(repeated for all 7 passes)*

## Artifact Ownership

| # | Artifact | Producing Agent(s) | Pass |
|---|----------|-------------------|------|
| 1 | Executive Decision Memo | Decision Memo Agent | 5 |
| 2 | Executive Summary | Executive Summary Agent | 5 |
| 3 | Architecture & Prototype Spec | Workflow Orchestrator, SDK Generator | 3 |
| ... | ... | ... | ... |
| 15 | Provenance Manifest | Pipeline Orchestrator (auto) | 5 |

## Quality Scores

| Agent | Confidence | Notes |
|-------|-----------|-------|
| Cost Attribution Agent | 0.92 | — |
| Scenario Generator Agent | 0.78 | Limited historical data for this domain |
| PII Detection Agent | 0.95 | — |
| ... | ... | ... |

## Resource Summary

| Resource | Value |
|----------|-------|
| Total agents invoked | {count} |
| Unique agent types | {count} |
| Unique code packages | {count} |
| Total LLM tokens | {total} |
| Total estimated cost | ${cost} |
| Pipeline wall-clock time | {duration} |
| Longest agent execution | {agent_name} ({duration}) |
| Passes completed | {count}/7 |
| Passes degraded | {list or "None"} |
```

### DecisionGraph Storage

The Provenance Manifest is stored as a `PROVENANCE_MANIFEST` node in the DecisionGraph. Individual TraceRecords are stored as separate entries in the `provenance` namespace:

```bash
# Store trace records
Key: provenance:{execution_id}:{trace_id}
Namespace: provenance
Tags: ["agent:{domain}/{name}", "pass:{pass_number}", "execution:{execution_id}"]

# Retrieve all traces for an execution
npx @claude-flow/cli@latest memory list --namespace provenance --tags "execution:{id}"

# Search for traces by agent
npx @claude-flow/cli@latest memory search --query "Cost Attribution" --namespace provenance
```

### Auditability

The provenance system satisfies enterprise audit requirements:

| Requirement | How It's Met |
|-------------|-------------|
| **Who** made each decision | `agent.name` + `agent.domain` in every TraceRecord |
| **What** code was used | `codeProvenance.package` + `commitHash` |
| **When** it happened | `startedAt` / `completedAt` timestamps |
| **What** data was used | `inputs.decisionGraphNodes` — exact node IDs read |
| **What** was produced | `outputs.decisionGraphNodes` + `outputs.artifactNumbers` |
| **How** confident is the result | `outputs.confidence` per agent |
| **How much** did it cost | `resources.tokensUsed` + `resources.estimatedCost` |
| **Reproducibility** | `codeProvenance.commitHash` + `inputs.parameters` enable re-execution |

### Privacy & Redaction

TraceRecords do **not** store the full content of agent inputs/outputs — only DecisionGraph node IDs (pointers). This means:
- Provenance data is lightweight (metadata only, no payload duplication)
- Sensitive content is not duplicated into the provenance namespace
- Access control on DecisionGraph nodes governs who can see the actual content

## Consequences

### Positive
- Full end-to-end traceability — every artifact can be traced to its producing agent and source code.
- Enterprise audit compliance — who, what, when, how for every decision.
- Cost transparency — per-agent and per-pipeline cost tracking.
- Reproducibility — commit hash + parameters enable re-execution.
- Zero agent modification required — middleware-based collection.

### Negative
- TraceRecord storage adds overhead per pipeline execution (typically small: metadata only).
- Code provenance resolution requires a maintained agent→package mapping.
- Git commit hash assumes agents run from a consistent codebase (not always true for distributed deployments).

### Mitigations
- TraceRecords are metadata-only — storage overhead is minimal.
- Agent→package mapping is maintained in the existing agent registry (`registry/index`).
- For distributed deployments, each agent reports its own package version — the manifest notes version discrepancies.
