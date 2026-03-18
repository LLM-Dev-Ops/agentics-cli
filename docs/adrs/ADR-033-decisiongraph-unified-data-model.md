# ADR-033: DecisionGraph Unified Data Model

**Status:** Accepted
**Date:** 2026-03-17
**Deciders:** Platform Architecture Team
**Supersedes:** None
**Related:** ADR-032 (7-pass pipeline), ADR-034 (artifact package), ADR-039 (provenance tracing), ADR-030 (capability graph)

## Context

Today, agents produce outputs independently — each writes to its own namespace or returns results inline. There is no shared data structure that accumulates the full decision context across pipeline passes. This causes:

1. **Data loss between passes.** Pass 2 simulation outputs are not structurally available to Pass 4 CostOps agents.
2. **No cross-agent querying.** An agent cannot look up what another agent produced without ad-hoc memory searches.
3. **Artifact generation is stitching, not reading.** Pass 5 must reassemble scattered outputs rather than reading a coherent graph.
4. **Provenance is untrackable.** There is no record of which agent produced which data node.

The ACTION_ITEMS document recommends introducing a single internal data structure — `DecisionGraph` — that every agent writes to, where every artifact becomes a node.

## Decision

We introduce the **DecisionGraph** as the canonical shared data model for every pipeline execution. It is a directed acyclic graph (DAG) where nodes are data artifacts and edges represent derivation relationships.

### Node Schema

Every node in the DecisionGraph conforms to this schema:

```typescript
interface DecisionGraphNode {
  // Identity
  id: string;                    // UUID
  type: DecisionNodeType;        // Enumerated node type
  name: string;                  // Human-readable label

  // Content
  content: Record<string, unknown>;  // Structured payload (type-specific)
  summary: string;               // One-paragraph summary for executive consumption

  // Lineage
  producedBy: AgentRef;          // Which agent created this node
  pass: PipelinePass;            // Which pipeline pass (1-7)
  derivedFrom: string[];         // IDs of parent nodes this was derived from
  timestamp: string;             // ISO 8601

  // Quality
  confidence: number;            // 0.0 - 1.0, agent-reported confidence
  status: 'complete' | 'partial' | 'degraded' | 'failed';

  // Metadata
  tags: string[];                // Searchable tags
  version: number;               // Incremented on updates
}
```

### Node Types

```typescript
enum DecisionNodeType {
  // Pass 1 — Problem Intelligence
  PROBLEM_DEFINITION     = 'problem_definition',
  BUSINESS_CONTEXT       = 'business_context',
  TECHNICAL_SCOPE        = 'technical_scope',
  ARCHITECTURE_HYPOTHESIS = 'architecture_hypothesis',
  EXECUTION_PLAN         = 'execution_plan',
  DECISION_LINEAGE       = 'decision_lineage',

  // Pass 2 — Simulation
  SCENARIO               = 'scenario',
  RISK_SIGNAL            = 'risk_signal',
  RELIABILITY_REPORT     = 'reliability_report',

  // Pass 3 — Architecture
  SYSTEM_ARCHITECTURE    = 'system_architecture',
  INTEGRATION_MAP        = 'integration_map',
  DATA_FLOW              = 'data_flow',
  SERVICE_BOUNDARY       = 'service_boundary',
  PROTOTYPE              = 'prototype',
  API_CONTRACT           = 'api_contract',
  SDK_INTERFACE          = 'sdk_interface',

  // Pass 4 — Governance
  SECURITY_ANALYSIS      = 'security_analysis',
  COMPLIANCE_REPORT      = 'compliance_report',
  COST_MODEL             = 'cost_model',
  GOVERNANCE_REPORT      = 'governance_report',
  POLICY_ANALYSIS        = 'policy_analysis',

  // Pass 5 — Decision Artifacts
  EXECUTIVE_MEMO         = 'executive_memo',
  EXECUTIVE_SUMMARY      = 'executive_summary',
  RISK_ASSESSMENT        = 'risk_assessment',
  IMPLEMENTATION_ROADMAP = 'implementation_roadmap',
  ORG_IMPACT             = 'org_impact',
  STAKEHOLDER_MAP        = 'stakeholder_map',
  KPI_DEFINITION         = 'kpi_definition',
  OKR_ALIGNMENT          = 'okr_alignment',
  RAID_LOG               = 'raid_log',
  CONFIDENCE_SCORE       = 'confidence_score',

  // Pass 6 — Deployment
  DEPLOYMENT_ENDPOINT    = 'deployment_endpoint',
  INTEGRATION_RESULT     = 'integration_result',

  // Pass 7 — Observability
  TELEMETRY_CONFIG       = 'telemetry_config',
  HEALTH_CHECK           = 'health_check',
  LEARNED_PATTERN        = 'learned_pattern',

  // Cross-cutting
  PROVENANCE_MANIFEST    = 'provenance_manifest',
}
```

### Edge Schema

```typescript
interface DecisionGraphEdge {
  from: string;   // Source node ID
  to: string;     // Target node ID
  relation: EdgeRelation;
}

enum EdgeRelation {
  DERIVED_FROM   = 'derived_from',    // B was computed from A
  INFORMS        = 'informs',         // A provides context to B
  VALIDATES      = 'validates',       // A validates/checks B
  SUPERSEDES     = 'supersedes',      // A replaces B (versioning)
  AGGREGATES     = 'aggregates',      // A summarizes multiple B nodes
}
```

### Agent Interaction Protocol

Every agent in the pipeline interacts with the DecisionGraph through three operations:

1. **Read:** Query nodes by type, pass, tag, or derivation chain. Agents read upstream outputs to inform their work.
2. **Write:** Create new nodes with full schema compliance. The `producedBy` and `derivedFrom` fields are mandatory.
3. **Update:** Increment `version`, update `content`/`status`. Original content is preserved (append-only history).

### Storage Backend

The DecisionGraph is stored in the existing AgentDB memory system with HNSW indexing (per ADR-030). Each node is a memory entry with:
- **Key:** `decisiongraph:{execution_id}:{node_id}`
- **Namespace:** `decisiongraph`
- **Vector embedding:** Generated from `summary` field for semantic search
- **Tags:** Node type, pass number, agent name

This reuses existing infrastructure — no new storage system is introduced.

### Graph Lifecycle

1. **Created** when the pipeline starts (Pass 1). A root node of type `PROBLEM_DEFINITION` is the first entry.
2. **Accumulated** through Passes 2-7 as agents add nodes and edges.
3. **Sealed** when the pipeline completes. The `PROVENANCE_MANIFEST` and `CONFIDENCE_SCORE` nodes are the final entries.
4. **Queryable** after completion for audit, retrieval, or re-execution of individual passes.
5. **Retained** per the platform's memory retention policy (default: indefinite).

### Querying

```bash
# List all nodes in an execution
npx @claude-flow/cli@latest memory list --namespace decisiongraph --tags "execution:{id}"

# Get all cost models
npx @claude-flow/cli@latest memory search --query "cost model" --namespace decisiongraph --tags "type:cost_model"

# Get full derivation chain for a node
npx @claude-flow/cli@latest memory retrieve --key "decisiongraph:{execution_id}:{node_id}"
```

## Consequences

### Positive
- Every agent reads and writes to a single coherent structure — no data loss between passes.
- Cross-agent querying is native — any agent can find any prior output by type, pass, or semantic search.
- Artifact generation in Pass 5 reads directly from the graph rather than stitching scattered outputs.
- Provenance is structural — `producedBy` and `derivedFrom` fields on every node.
- Reuses AgentDB — no new storage system to build or maintain.

### Negative
- Agents must conform to the node schema — existing agents need adapter logic.
- Graph can grow large for complex analyses — requires pagination/filtering for reads.
- Schema evolution (adding new node types) requires coordination across agents.

### Mitigations
- A thin `DecisionGraphClient` wrapper provides typed read/write methods — agents import the client, not raw memory APIs.
- Node listing supports type/pass/tag filtering to avoid full-graph reads.
- Node type enum is extensible — new types can be added without breaking existing agents.
