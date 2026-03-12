# ADR-030: Ecosystem Capability Graph for Intelligent Agent Routing

**Status**: Proposed
**Date**: 2026-03-12
**Decision Makers**: Platform Architecture, Engineering Lead
**Severity**: P1 — Agent over-selection produces generic, incoherent outputs

## Context

Agentics Dev is a multi-repository AI orchestration platform comprising approximately 55 repositories and 110+ agents across multiple execution layers. The Agentics CLI orchestrates simulations, deep research, SPARC specification generation, ADR creation, implementation generation, and ERP deployment.

The platform has grown organically. Each new capability added repositories and agents, but no structured mechanism exists to map a business problem to the minimal set of agents required to solve it.

### Current State

Today, the CLI uses two routing strategies:

1. **Keyword matching** — the `agentics ask` command matches user prompts against 95 keyword rules and 33 multi-agent combos. This is flat: it has no notion of capabilities, execution stages, or repository structure.

2. **CLAUDE.md domain table** — a 27-row lookup table hardcoded in the project instructions. This is static, requires manual synchronization, and cannot express relationships between capabilities.

Neither strategy answers the fundamental question: *given a business problem, which 5-10 agents (out of 110+) should execute, and in what order?*

### Observed Failures

When solving business problems like "Optimize supplier sustainability reporting for SAP", the current system:

- Loads 20-40 agents instead of 5-10
- Selects agents with no relevance to the problem (e.g., Benchmark Publication Agent for an ERP task)
- Produces generic outputs because the prompt context is diluted by irrelevant agent descriptions
- Cannot reason about execution stages (simulation before build, validation before deployment)

These failures are related to but distinct from ADR-028 (agent under-utilization) and ADR-029 (domain fidelity). Those ADRs address what happens *after* agents are selected. This ADR addresses *which agents get selected in the first place*.

## Problem Statement

The CLI cannot efficiently map a business problem to the minimal agent set required to solve it. There is no intermediate representation between "raw user prompt" and "list of all agents." The result is over-selection, context dilution, and generic outputs.

## Decision

Introduce a **lightweight ecosystem capability graph** stored as a static JSON file at `docs/ecosystem.graph.json`. The CLI loads this graph at routing time to resolve:

```
business problem → capabilities → repositories → agents
```

The graph is:

- A flat JSON file, not a graph database
- Versioned with the CLI repository
- Manually curated (no automatic indexing)
- Designed for LLM readability

We are intentionally NOT building:

- A full AST-level code graph
- A graph database (Neo4j, etc.)
- Automatic repository indexing or code analysis
- A dynamic agent discovery protocol

## Architecture Overview

```
+------------------+
| User Prompt      |
+--------+---------+
         |
         v
+--------+---------+
| Capability        |     1. Parse prompt into capability keywords
| Classifier        |     2. Match against graph capability names
+--------+---------+
         |
         v
+--------+---------+
| Graph Resolver    |     3. Load ecosystem.graph.json
|                   |     4. Return matching repos + agents
+--------+---------+
         |
         v
+--------+---------+
| Stage Sequencer   |     5. Order agents by execution stage
|                   |     6. Filter by stage constraints
+--------+---------+
         |
         v
+--------+---------+
| Pipeline Runner   |     7. Execute minimal agent pipeline
+------------------+
```

### Component Responsibilities

**Capability Classifier** — Extracts capability requirements from the user prompt. Uses keyword extraction with optional LLM classification fallback. Outputs a list of capability names (e.g., `["simulation", "erp_integration", "security_validation"]`).

**Graph Resolver** — Reads `docs/ecosystem.graph.json` and returns the union of repositories and agents matching the requested capabilities. This is a pure lookup with no inference.

**Stage Sequencer** — Orders the selected agents according to the execution pipeline stages defined in the graph. Agents tagged for "simulation" run before agents tagged for "build". Agents tagged for "validation" run before agents tagged for "deployment".

**Pipeline Runner** — Executes the sequenced agents. This is the existing CLI execution layer, unchanged.

## Graph Schema

The graph file lives at `docs/ecosystem.graph.json` and follows this schema:

```json
{
  "version": "1.0",
  "description": "Agentics Dev Ecosystem Capability Graph",
  "stages": [
    "simulation",
    "research",
    "specification",
    "architecture",
    "build",
    "validation",
    "deployment",
    "governance"
  ],
  "capabilities": [
    {
      "name": "string",
      "description": "string",
      "repos": ["string"],
      "agents": ["string"],
      "stage": "string",
      "depends_on": ["string"],
      "tags": ["string"]
    }
  ]
}
```

### Field Definitions

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | yes | Unique capability identifier (snake_case) |
| `description` | string | no | Human-readable purpose (helps LLM classification) |
| `repos` | string[] | yes | Repository names that implement this capability |
| `agents` | string[] | yes | Agent names available for this capability |
| `stage` | string | no | Default execution stage from the `stages` array |
| `depends_on` | string[] | no | Capabilities that must execute before this one |
| `tags` | string[] | no | Additional keywords for fuzzy matching |

### Schema Extensions Over Current Graph

The current `ecosystem.graph.json` (v1.0) has `name`, `repos`, and `agents`. This ADR adds three fields:

- **`stage`** — enables execution ordering without hardcoded rules
- **`depends_on`** — enables the sequencer to respect inter-capability dependencies
- **`tags`** — improves classification accuracy for ambiguous prompts

These are additive, non-breaking changes. Existing entries continue to work.

### Example Extended Entry

```json
{
  "name": "erp_integration",
  "description": "Push generated implementations to enterprise ERP systems",
  "repos": ["erp-surface"],
  "agents": ["ERP Integration Agent"],
  "stage": "deployment",
  "depends_on": ["workflow_orchestration"],
  "tags": ["sap", "oracle", "netsuite", "erp", "enterprise"]
}
```

## CLI Integration Strategy

The graph integration touches three parts of the CLI:

### 1. Graph Loader (new module)

A module that reads and validates `docs/ecosystem.graph.json` at startup. It caches the parsed result for the duration of the CLI process.

```
src/routing/graph-loader.ts
```

Responsibilities:
- Read and parse the JSON file
- Validate against the schema
- Provide lookup methods: `byCapability(name)`, `byTag(keyword)`, `byStage(stage)`

### 2. Capability Classifier (new module)

A module that extracts capability names from a user prompt.

```
src/routing/capability-classifier.ts
```

Classification strategy (ordered by priority):
1. **Exact match** — prompt contains a capability name verbatim
2. **Tag match** — prompt contains a tag from a capability entry
3. **LLM fallback** — if no matches found, ask the LLM to classify the prompt against the capability list (single cheap call using the capability names as the enum)

### 3. Integration Point (existing `agentics ask`)

The existing `agentics ask` command gains a graph-aware routing path:

```
Before:  prompt → keyword rules → agent list → execute all
After:   prompt → classifier → graph resolver → stage sequencer → execute minimal
```

The keyword rules and multi-agent combos remain as a fallback. The graph-based path takes priority when it produces matches.

## Routing Logic

The routing algorithm:

```
function route(prompt: string): AgentPipeline {
  // Step 1: Classify
  const capabilities = classifier.extract(prompt)

  // Step 2: Resolve
  const entries = capabilities.flatMap(c => graph.byCapability(c))
  const agents = deduplicate(entries.flatMap(e => e.agents))
  const repos = deduplicate(entries.flatMap(e => e.repos))

  // Step 3: Resolve dependencies
  const allCapabilities = resolveDependencies(capabilities, graph)
  // adds transitive dependencies (e.g., erp_integration depends_on workflow_orchestration)

  // Step 4: Sequence by stage
  const stages = graph.stages  // ordered array
  const pipeline = stages
    .map(stage => agents.filter(a => agentStage(a) === stage))
    .filter(group => group.length > 0)

  // Step 5: Cap agent count
  if (totalAgents(pipeline) > MAX_AGENTS) {
    pipeline = pruneByRelevanceScore(pipeline, prompt)
  }

  return pipeline
}
```

### Agent Count Constraints

| Scenario | Max Agents |
|----------|-----------|
| Single capability | 3-5 |
| Multi-capability (2-3) | 5-8 |
| Full pipeline (4+ capabilities) | 8-12 |
| Hard ceiling | 15 |

If resolution exceeds the ceiling, agents are pruned by relevance score (number of matching tags and capabilities).

## Example Query Flow

**User prompt**: "Optimize supplier sustainability reporting for SAP"

### Step 1: Classify

The classifier extracts:
- "sustainability reporting" → `simulation` (scenario analysis)
- "SAP" → `erp_integration` (tag: "sap")
- "optimize" → `workflow_orchestration` (pipeline optimization)
- implicit → `security_validation` (enterprise data requires validation)

Capabilities: `[simulation, erp_integration, workflow_orchestration, security_validation]`

### Step 2: Resolve

```
simulation          → LLM-Simulator       → [What-If Simulation Agent, Scenario Generator Agent]
erp_integration     → erp-surface          → [ERP Integration Agent]
workflow_orchestration → LLM-Orchestrator  → [Workflow Orchestrator Agent, Dependency Resolver Agent]
security_validation → LLM-Shield           → [Prompt Injection Detection Agent, PII Detection Agent]
```

### Step 3: Dependency Resolution

`erp_integration.depends_on = ["workflow_orchestration"]` — already included.

### Step 4: Stage Sequencing

```
Stage: simulation    → What-If Simulation Agent, Scenario Generator Agent
Stage: build         → Workflow Orchestrator Agent, Dependency Resolver Agent
Stage: validation    → Prompt Injection Detection Agent, PII Detection Agent
Stage: deployment    → ERP Integration Agent
```

### Step 5: Result

**7 agents** selected (down from 110+). **4 repos** loaded. Agents execute in stage order.

```
Before (current system):
  110+ agents considered → 20-40 loaded → generic output

After (with capability graph):
  4 capabilities matched → 7 agents selected → 4 stages sequenced → focused output
```

## Alternatives Considered

### 1. Full Graph Database (Neo4j / Dgraph)

Would enable relationship queries, transitive dependency resolution, and graph algorithms (PageRank for agent importance).

**Rejected because**: Adds infrastructure dependency. The CLI must work offline, in CI/CD, and in air-gapped environments. A JSON file has zero runtime dependencies.

### 2. Automatic Repository Indexing

Scan all 55 repositories, extract agent definitions, and build the graph automatically.

**Rejected because**: Agent definitions are not standardized across repositories. The cost of building and maintaining a cross-repo scanner exceeds the cost of manual curation for a 25-entry graph. This may be revisited when the ecosystem exceeds 200 agents.

### 3. LLM-Only Classification

Skip the graph entirely. Send the full agent list to an LLM and ask it to select the right agents for each prompt.

**Rejected because**: Sending 110+ agent descriptions in every prompt costs ~4,000 tokens per request. Classification accuracy degrades as the list grows. The graph approach costs zero tokens for resolution (the LLM fallback is only for ambiguous prompts and sends only capability *names*, not full descriptions).

### 4. Embedding-Based Similarity Search

Embed all agent descriptions and user prompts into a vector space. Use cosine similarity to select agents.

**Rejected because**: Adds an embedding model dependency. Similarity search has no concept of execution stages or dependencies. A sustainability reporting prompt might be "similar" to a benchmark publication agent (both mention "reporting") — semantic similarity is not capability equivalence.

### 5. Hardcoded Pipeline Templates

Define fixed agent pipelines for common task types (e.g., "erp-deployment-pipeline" always uses agents X, Y, Z).

**Rejected because**: Too rigid. Real business problems combine capabilities in unpredictable ways. The graph approach allows combinatorial composition while templates require O(n^2) definitions for n capability combinations.

## Tradeoffs

### Benefits

| Benefit | Impact |
|---------|--------|
| Agent selection reduced from 110+ to 5-10 | Directly improves output quality by reducing context dilution |
| Execution stage ordering | Prevents agents from running out of sequence (validation before build) |
| Zero runtime dependencies | JSON file works offline, in CI, in air-gapped environments |
| LLM-readable | The graph file can be included in prompts when needed (~2KB) |
| Incremental adoption | Existing keyword routing continues to work as fallback |
| Manual curation | Ensures graph accuracy — no false positives from automated indexing |

### Costs

| Cost | Mitigation |
|------|------------|
| Manual maintenance | Graph has ~25 entries. Updates are infrequent (new capabilities are rare). |
| No automatic discovery | Acceptable at current scale. Revisit at 200+ agents. |
| Classification errors | LLM fallback for ambiguous prompts. Tag system for fuzzy matching. |
| Schema migration | Additive fields only. No breaking changes to existing entries. |
| Single point of truth | If graph is wrong, routing is wrong. Mitigated by keeping the existing keyword fallback active. |

### What This Does NOT Solve

- **Agent output quality** — The graph selects the right agents but does not improve what those agents produce. ADR-029 addresses output quality.
- **Agent utilization** — The graph does not change how much of an agent's capability is used. ADR-028 addresses utilization.
- **Cross-repo dependencies** — The graph tracks which repos are needed but does not manage code-level dependencies between them.

## Future Improvements

### Phase 2: Weighted Edges

Add confidence weights to capability-agent mappings:

```json
{
  "name": "erp_integration",
  "agents": [
    { "name": "ERP Integration Agent", "weight": 1.0 },
    { "name": "Workflow Orchestrator Agent", "weight": 0.3 }
  ]
}
```

This enables the resolver to prefer primary agents and include secondary agents only when the agent budget allows.

### Phase 3: Execution Telemetry Feedback

Record which agent combinations produce successful outcomes. Use this data to adjust weights and prune underperforming agent selections over time. Integrates with the existing `LLM-Observatory` telemetry pipeline.

### Phase 4: Capability Composition Rules

Define rules for how capabilities interact:

```json
{
  "compositions": [
    {
      "when": ["erp_integration", "security_validation"],
      "add": ["data_security"],
      "reason": "ERP data requires anonymization controls"
    }
  ]
}
```

This codifies expert knowledge about which capability combinations require additional capabilities.

### Phase 5: Multi-Graph Federation

When the platform exceeds 200 agents, split the monolithic graph into per-layer graphs that compose at resolution time. Each repository team maintains their own capability fragment.

### Phase 6: Automated Graph Validation

CI check that verifies:
- Every agent in the graph exists in its declared repository
- Every repository in the graph exists in the organization
- No capability has zero agents
- No circular dependencies in `depends_on`
