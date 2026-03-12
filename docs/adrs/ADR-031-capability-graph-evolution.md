# ADR-031: Capability Graph Evolution — Weighted Edges, Telemetry Feedback, Composition Rules, Federation, and CI Validation

**Status**: Proposed
**Date**: 2026-03-12
**Decision Makers**: Platform Architecture, Engineering Lead
**Supersedes**: ADR-030 Future Improvements section
**Depends On**: ADR-030 (Ecosystem Capability Graph)

## Context

ADR-030 introduces a static capability graph (`docs/ecosystem.graph.json`) that maps business problems to agents via capability lookup. The initial design is deliberately minimal: flat JSON, unweighted edges, no feedback loop, manual curation, single file.

This simplicity is correct for the initial rollout, but the graph must evolve to handle three pressures that will emerge as adoption grows:

1. **Routing precision** — Not all agents within a capability are equally relevant. The graph currently treats all agents as equally weighted, causing over-selection when a capability has many agents (e.g., `benchmarking` has 14 agents but most tasks need only 2-3).

2. **Routing accuracy over time** — The graph is manually curated based on design-time assumptions. Without execution feedback, incorrect or suboptimal mappings persist indefinitely. We have no data on which agent combinations actually produce good outcomes.

3. **Scaling the graph** — At 55 repositories and 110+ agents, a single JSON file is manageable. At 200+ agents across multiple teams, centralized manual curation becomes a bottleneck. Teams need to own their own capability declarations.

This ADR defines five concrete phases that address these pressures. Each phase is independently deployable and builds on the previous one.

## Problem Statement

The static, unweighted, single-file capability graph from ADR-030 will produce increasingly imprecise routing as the ecosystem grows. There is no mechanism to:

- Distinguish primary agents from secondary agents within a capability
- Learn from execution outcomes to improve routing over time
- Express expert knowledge about capability interactions
- Distribute graph ownership across teams
- Validate graph correctness automatically

## Decision

Evolve the capability graph through five phases, each adding a specific capability to the routing system. All phases preserve backward compatibility with the ADR-030 base schema.

```
Phase 1: Weighted Edges            (routing precision)
Phase 2: Telemetry Feedback        (routing accuracy)
Phase 3: Composition Rules         (expert knowledge encoding)
Phase 4: Multi-Graph Federation    (scaling ownership)
Phase 5: CI Validation             (correctness guarantees)
```

### Phase Dependency Chain

```
ADR-030 (base graph)
    |
    +---> Phase 1: Weighted Edges
    |         |
    |         +---> Phase 2: Telemetry Feedback
    |                   |
    |                   +---> (feedback adjusts weights from Phase 1)
    |
    +---> Phase 3: Composition Rules  (independent of Phases 1-2)
    |
    +---> Phase 4: Federation         (independent, but benefits from Phase 5)
    |         |
    |         +---> Phase 5: CI Validation
    |                   |
    |                   +---> (validates federated fragments from Phase 4)
```

Phases 1-2 form a connected pair (weights + feedback loop).
Phase 3 is independent.
Phases 4-5 form a connected pair (federation + validation).
All five can be implemented in any order except: Phase 2 requires Phase 1, Phase 5 benefits from Phase 4.

## Architecture Overview

```
+-------------------+     +-------------------+     +-------------------+
|  Phase 1          |     |  Phase 3          |     |  Phase 4          |
|  Weighted Edges   |     |  Composition      |     |  Federation       |
|                   |     |  Rules            |     |                   |
|  agent.weight     |     |  when + add       |     |  per-repo graphs  |
|  primary/secondary|     |  expert rules     |     |  merge at resolve |
+--------+----------+     +--------+----------+     +--------+----------+
         |                         |                          |
         v                         v                          v
+--------+----------+     +--------+----------+     +--------+----------+
|  Phase 2          |     |  Graph Resolver   |     |  Phase 5          |
|  Telemetry        |     |  (ADR-030)        |     |  CI Validation    |
|  Feedback         |     |                   |     |                   |
|  outcome tracking |     |  reads all phases |     |  schema + ref     |
|  weight adjustment|     |                   |     |  checks           |
+-------------------+     +-------------------+     +-------------------+
```

---

## Phase 1: Weighted Edges

### Problem

The `benchmarking` capability has 14 agents. When a user asks to "evaluate model quality", all 14 are candidates. In practice, only Benchmark Runner Agent, Quality Scoring Agent, and Hallucination Detection Agent are relevant. The remaining 11 add noise.

### Design

Change the `agents` field from a flat string array to an array of weighted agent objects. The string form remains valid for backward compatibility.

**Schema change**:

```json
{
  "name": "benchmarking",
  "agents": [
    { "name": "Benchmark Runner Agent", "weight": 1.0, "role": "primary" },
    { "name": "Quality Scoring Agent", "weight": 0.9, "role": "primary" },
    { "name": "Hallucination Detection Agent", "weight": 0.8, "role": "primary" },
    { "name": "Model Comparator Agent", "weight": 0.5, "role": "secondary" },
    { "name": "Regression Detection Agent", "weight": 0.5, "role": "secondary" },
    { "name": "Bias Detection Agent", "weight": 0.3, "role": "secondary" },
    { "name": "Red Team Agent", "weight": 0.2, "role": "specialist" },
    { "name": "Adversarial Prompt Agent", "weight": 0.2, "role": "specialist" }
  ]
}
```

**Field definitions**:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | yes | Agent name |
| `weight` | number (0.0-1.0) | yes | Selection priority. 1.0 = always selected. 0.0 = never selected. |
| `role` | enum | no | `primary` (default selected), `secondary` (selected when budget allows), `specialist` (selected only when tags match) |

**Backward compatibility**: The resolver accepts both forms:

```typescript
// Both are valid:
"agents": ["Agent A", "Agent B"]                          // legacy flat form
"agents": [{ "name": "Agent A", "weight": 1.0 }, ...]    // weighted form
```

When the resolver encounters a plain string, it treats it as `{ "name": string, "weight": 1.0, "role": "primary" }`.

**Selection algorithm**:

```
function selectAgents(capability, budget):
  agents = capability.agents.sort(by weight descending)

  selected = agents.filter(a => a.role === "primary")

  if selected.length < budget:
    selected += agents
      .filter(a => a.role === "secondary")
      .slice(0, budget - selected.length)

  if prompt matches specialist tags:
    selected += agents.filter(a => a.role === "specialist" && tagMatch(a))

  return selected.slice(0, budget)
```

**Impact**: For the `benchmarking` capability, a typical query selects 3 primary agents instead of 14. A security-focused query additionally pulls in the Red Team specialist.

### Implementation

```
src/routing/weighted-resolver.ts    — weight-aware agent selection
```

Single module. ~80 lines. No external dependencies.

---

## Phase 2: Telemetry Feedback

### Problem

Weights in Phase 1 are assigned by human judgment. We have no data on whether the Weight=0.8 Hallucination Detection Agent actually contributes to successful outcomes. Without feedback, weights become stale opinions.

### Design

Record execution outcomes and use them to adjust weights over time.

**Data flow**:

```
+-------------+     +----------------+     +----------------+     +----------------+
| Pipeline    | --> | Outcome        | --> | Weight         | --> | Graph File     |
| Execution   |     | Recorder       |     | Adjuster       |     | (updated)      |
+-------------+     +----------------+     +----------------+     +----------------+
                          |
                          v
                    +----------------+
                    | Telemetry      |
                    | Store          |
                    | (local JSON)   |
                    +----------------+
```

**Outcome record schema**:

```json
{
  "timestamp": "2026-03-12T14:30:00Z",
  "prompt_hash": "sha256:abc123",
  "capabilities_used": ["benchmarking", "security_validation"],
  "agents_selected": [
    "Benchmark Runner Agent",
    "Quality Scoring Agent",
    "Prompt Injection Detection Agent"
  ],
  "outcome": "success",
  "user_rating": null,
  "execution_time_ms": 12400,
  "agent_contributions": {
    "Benchmark Runner Agent": { "produced_output": true, "output_used": true },
    "Quality Scoring Agent": { "produced_output": true, "output_used": true },
    "Prompt Injection Detection Agent": { "produced_output": true, "output_used": false }
  }
}
```

**Outcome signals** (ordered by reliability):

| Signal | Source | Reliability |
|--------|--------|-------------|
| Explicit user rating | User feedback prompt | High |
| Pipeline completion | Did the pipeline finish without errors? | Medium |
| Agent output usage | Was the agent's output consumed by a downstream stage? | Medium |
| Retry count | Did the user re-run with different parameters? | Low (negative signal) |

**Weight adjustment algorithm**:

```
function adjustWeights(capability, outcomes[]):
  for each agent in capability.agents:
    successRate = outcomes
      .filter(o => o.agents_selected.includes(agent.name))
      .filter(o => o.outcome === "success")
      .length / totalSelections

    usageRate = outcomes
      .filter(o => o.agent_contributions[agent.name]?.output_used)
      .length / totalSelections

    // Exponential moving average, alpha = 0.1 (slow adaptation)
    agent.weight = agent.weight * 0.9 + (successRate * 0.5 + usageRate * 0.5) * 0.1

    // Clamp to [0.05, 1.0] — never fully disable an agent
    agent.weight = clamp(agent.weight, 0.05, 1.0)
```

**Constraints**:

- Weight adjustment runs as a CLI command (`npx @claude-flow/cli@latest graph adjust-weights`), not automatically
- Requires a minimum of 20 outcome records before adjusting any weight
- Changes are written to a separate file (`docs/ecosystem.graph.weights.json`) that overlays the base graph, preserving the curated base weights
- Human review required before merging adjusted weights into the base graph

**Telemetry storage**: Local JSON file at `.agentics/telemetry/outcomes.jsonl` (append-only, one record per line). No external services. Optionally forwarded to LLM-Observatory if configured.

### Implementation

```
src/routing/outcome-recorder.ts     — records execution outcomes
src/routing/weight-adjuster.ts      — calculates adjusted weights
docs/ecosystem.graph.weights.json   — overlay file for adjusted weights
.agentics/telemetry/outcomes.jsonl  — local outcome log
```

---

## Phase 3: Composition Rules

### Problem

Some capability combinations require additional capabilities that neither the user nor the classifier would identify. Examples:

- `erp_integration` + `security_validation` should add `data_security` (ERP data contains PII that needs anonymization controls)
- `simulation` + `cost_finops` should add `performance_profiling` (cost simulations need latency data to be accurate)
- `workflow_orchestration` + `erp_integration` should add `incident_management` (enterprise workflows need escalation paths)

These are expert-knowledge rules that cannot be derived from keyword matching or tag similarity.

### Design

Add a top-level `compositions` array to the graph schema.

**Schema addition**:

```json
{
  "version": "1.1",
  "capabilities": [ ... ],
  "compositions": [
    {
      "id": "erp-data-protection",
      "when": ["erp_integration", "security_validation"],
      "operator": "all",
      "add": ["data_security"],
      "reason": "ERP data contains PII requiring anonymization controls",
      "priority": "required"
    },
    {
      "id": "cost-simulation-latency",
      "when": ["simulation", "cost_finops"],
      "operator": "all",
      "add": ["performance_profiling"],
      "reason": "Cost simulations need latency data for accuracy",
      "priority": "recommended"
    },
    {
      "id": "enterprise-escalation",
      "when": ["workflow_orchestration", "erp_integration"],
      "operator": "all",
      "add": ["incident_management"],
      "reason": "Enterprise workflows require escalation paths",
      "priority": "recommended"
    },
    {
      "id": "security-audit-governance",
      "when": ["security_validation"],
      "operator": "any",
      "add": ["governance"],
      "reason": "Security changes require governance audit trail",
      "priority": "optional"
    }
  ]
}
```

**Field definitions**:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | yes | Unique rule identifier |
| `when` | string[] | yes | Capability names that trigger this rule |
| `operator` | enum | yes | `all` (every capability must be present) or `any` (at least one) |
| `add` | string[] | yes | Capabilities to add when the rule triggers |
| `reason` | string | yes | Human-readable justification (included in explain output) |
| `priority` | enum | yes | `required` (always applied), `recommended` (applied if under agent budget), `optional` (applied only if explicitly requested) |

**Evaluation algorithm**:

```
function applyCompositions(capabilities, graph, agentBudget):
  rules = graph.compositions

  // Iterate until no new capabilities are added (handles transitive rules)
  changed = true
  while changed:
    changed = false
    for rule in rules:
      if rule.operator === "all" && rule.when.every(c => capabilities.includes(c)):
        for cap in rule.add:
          if !capabilities.includes(cap):
            if rule.priority === "required":
              capabilities.push(cap)
              changed = true
            elif rule.priority === "recommended" && currentAgentCount < agentBudget * 0.8:
              capabilities.push(cap)
              changed = true

      elif rule.operator === "any" && rule.when.some(c => capabilities.includes(c)):
        // same logic

  return capabilities
```

**Safety constraints**:

- Maximum 3 iterations of the composition loop (prevents runaway rule chains)
- Composition rules cannot remove capabilities, only add them
- If composition would exceed the agent budget ceiling (15), `recommended` and `optional` rules are skipped
- The `explain` hook reports which composition rules fired and why

**Integration with `hooks explain`**:

```
$ agentics ask "Deploy sustainability reporting to SAP"

Routing explanation:
  Classified capabilities: [simulation, erp_integration, workflow_orchestration, security_validation]
  Composition rule "erp-data-protection" triggered:
    when: [erp_integration, security_validation] — both present
    added: [data_security]
    reason: ERP data contains PII requiring anonymization controls
  Composition rule "enterprise-escalation" triggered:
    when: [workflow_orchestration, erp_integration] — both present
    added: [incident_management]
    reason: Enterprise workflows require escalation paths
  Final capabilities: [simulation, erp_integration, workflow_orchestration, security_validation, data_security, incident_management]
  Agents selected: 9 (within budget of 12)
```

### Implementation

```
src/routing/composition-engine.ts    — rule evaluation engine
```

Single module. ~120 lines. The compositions array lives in the existing `ecosystem.graph.json`.

---

## Phase 4: Multi-Graph Federation

### Problem

At 25 capabilities and 110 agents, a single JSON file is manageable. When the ecosystem reaches 200+ agents:

- A single file becomes a merge-conflict bottleneck (multiple teams editing concurrently)
- Capability ownership is unclear (who decides which agents belong to `security_validation`?)
- New repositories cannot declare their capabilities without modifying the central graph

### Design

Split the monolithic graph into **capability fragments** that each repository or team owns, and merge them at resolution time.

**Directory structure**:

```
docs/
  ecosystem.graph.json              — root graph (metadata + compositions + stage order)
  ecosystem.fragments/
    benchmarking.graph.json         — owned by LLM-Test-Bench team
    security_validation.graph.json  — owned by LLM-Shield team
    erp_integration.graph.json      — owned by erp-surface team
    ...
```

**Root graph** (reduced to metadata):

```json
{
  "version": "2.0",
  "description": "Agentics Dev Ecosystem Capability Graph",
  "stages": ["simulation", "research", "specification", "architecture", "build", "validation", "deployment", "governance"],
  "fragments_dir": "docs/ecosystem.fragments",
  "compositions": [ ... ],
  "overrides": {
    "benchmarking": {
      "max_agents": 5
    }
  }
}
```

**Fragment file** (`docs/ecosystem.fragments/benchmarking.graph.json`):

```json
{
  "capability": "benchmarking",
  "description": "Deterministic benchmarking and evaluation for LLM systems",
  "owner": "llm-test-bench-team",
  "repos": ["LLM-Test-Bench"],
  "agents": [
    { "name": "Benchmark Runner Agent", "weight": 1.0, "role": "primary" },
    { "name": "Quality Scoring Agent", "weight": 0.9, "role": "primary" },
    { "name": "Hallucination Detection Agent", "weight": 0.8, "role": "primary" },
    { "name": "Model Comparator Agent", "weight": 0.5, "role": "secondary" }
  ],
  "stage": "validation",
  "depends_on": [],
  "tags": ["benchmark", "eval", "quality", "regression", "model-compare"]
}
```

**Merge algorithm**:

```
function loadGraph():
  root = parseJSON("docs/ecosystem.graph.json")
  fragments = glob("docs/ecosystem.fragments/*.graph.json")
    .map(parseJSON)

  // Merge fragments into unified capability list
  capabilities = fragments.map(f => ({
    name: f.capability,
    ...f,
    // Apply root overrides
    ...root.overrides[f.capability]
  }))

  return {
    version: root.version,
    stages: root.stages,
    capabilities: capabilities,
    compositions: root.compositions
  }
```

**Conflict resolution**:

| Scenario | Resolution |
|----------|-----------|
| Two fragments declare the same capability name | Error at merge time. Capability names must be unique. |
| Fragment references a repo not in the organization | Warning (caught by Phase 5 CI validation) |
| Root override conflicts with fragment | Root override wins (central governance) |
| Fragment missing required fields | Error at merge time with clear message |

**Migration path from v1.0**:

The graph loader supports both formats:
- If `docs/ecosystem.graph.json` contains a `capabilities` array, use monolithic mode (v1.0)
- If it contains a `fragments_dir` field, use federation mode (v2.0)
- A migration script splits the monolithic file into fragments:

```bash
npx @claude-flow/cli@latest graph federate
# Reads ecosystem.graph.json, creates ecosystem.fragments/ directory,
# writes one fragment file per capability, updates root graph to v2.0
```

**Ownership model**:

Each fragment file has an `owner` field. CODEOWNERS rules enforce that only the owning team can modify their fragment:

```
# .github/CODEOWNERS
docs/ecosystem.fragments/benchmarking.graph.json    @llm-test-bench-team
docs/ecosystem.fragments/security_validation.graph.json  @llm-shield-team
```

### Implementation

```
src/routing/graph-federation.ts      — fragment loader and merger
scripts/federate-graph.ts            — migration script (monolithic → fragments)
docs/ecosystem.fragments/            — fragment directory
```

---

## Phase 5: CI Validation

### Problem

The capability graph is the routing truth for the entire platform. An incorrect graph entry (wrong agent name, missing repository, circular dependency) causes silent routing failures that are difficult to diagnose. Manual review is insufficient at scale, especially with federated fragments from multiple teams.

### Design

A CI pipeline check that runs on every PR that modifies graph files. The check validates structural correctness, referential integrity, and logical consistency.

**Validation rules**:

| # | Rule | Severity | Description |
|---|------|----------|-------------|
| 1 | Schema validation | Error | Every graph file conforms to the JSON schema |
| 2 | Unique capability names | Error | No two fragments declare the same capability |
| 3 | Non-empty agents | Error | Every capability has at least one agent |
| 4 | Non-empty repos | Error | Every capability has at least one repository |
| 5 | Valid stage references | Error | Every `stage` value exists in the root `stages` array |
| 6 | No circular dependencies | Error | `depends_on` graph has no cycles |
| 7 | Repository existence | Warning | Every repo name corresponds to an org repository (requires GitHub API) |
| 8 | Agent name consistency | Warning | Agent names in the graph match agent definitions in their repos (requires cross-repo access) |
| 9 | Weight bounds | Error | All weights are in [0.0, 1.0] |
| 10 | Composition rule validity | Error | All capability names in `when` and `add` exist in the graph |
| 11 | Composition cycle detection | Error | Composition rules cannot create infinite add loops |
| 12 | Fragment owner field | Warning | Every fragment has a non-empty `owner` field |
| 13 | Orphan detection | Warning | Capabilities with no inbound `depends_on` references and no tag matches in the last 30 days (requires telemetry from Phase 2) |

**Validation tiers**:

```
Tier 1: Offline validation (no network required)
  Rules: 1, 2, 3, 4, 5, 6, 9, 10, 11, 12
  Runs: Every PR, every commit, local pre-commit hook

Tier 2: Online validation (requires GitHub API)
  Rules: 7, 8
  Runs: PR checks only (needs org read access)

Tier 3: Telemetry validation (requires outcome data from Phase 2)
  Rules: 13
  Runs: Weekly scheduled job
```

**CI integration** (GitHub Actions):

```yaml
# .github/workflows/graph-validation.yml
name: Capability Graph Validation
on:
  pull_request:
    paths:
      - 'docs/ecosystem.graph.json'
      - 'docs/ecosystem.fragments/**'
      - 'docs/ecosystem.graph.weights.json'

jobs:
  validate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Tier 1 — Offline validation
        run: npx @claude-flow/cli@latest graph validate --tier offline

      - name: Tier 2 — Repository checks
        run: npx @claude-flow/cli@latest graph validate --tier online
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

**CLI command**:

```bash
# Run all offline validations
npx @claude-flow/cli@latest graph validate --tier offline

# Run with online checks
npx @claude-flow/cli@latest graph validate --tier online

# Run with telemetry checks
npx @claude-flow/cli@latest graph validate --tier telemetry

# Auto-fix simple issues (missing weights default to 1.0, sort agents by weight)
npx @claude-flow/cli@latest graph validate --fix
```

**Cycle detection algorithm** (for both `depends_on` and composition rules):

```
function detectCycles(graph):
  // Build adjacency list from depends_on
  adj = {}
  for cap in graph.capabilities:
    adj[cap.name] = cap.depends_on || []

  // Add edges from composition rules
  for rule in graph.compositions:
    for trigger in rule.when:
      for target in rule.add:
        adj[trigger].push(target)

  // Kahn's algorithm for topological sort
  // If sort does not include all nodes, cycles exist
  inDegree = computeInDegrees(adj)
  queue = nodes.filter(n => inDegree[n] === 0)
  sorted = []

  while queue.length > 0:
    node = queue.shift()
    sorted.push(node)
    for neighbor in adj[node]:
      inDegree[neighbor]--
      if inDegree[neighbor] === 0:
        queue.push(neighbor)

  if sorted.length !== nodes.length:
    cycleNodes = nodes.filter(n => !sorted.includes(n))
    return { hasCycle: true, nodes: cycleNodes }

  return { hasCycle: false }
```

**Output format**:

```
$ npx @claude-flow/cli@latest graph validate --tier offline

Capability Graph Validation (Tier 1: Offline)
=============================================

[PASS] Schema validation: 25 capabilities valid
[PASS] Unique capability names: no duplicates
[PASS] Non-empty agents: all capabilities have agents
[PASS] Valid stage references: all stages exist
[PASS] No circular dependencies: topological sort succeeded
[PASS] Weight bounds: all weights in [0.0, 1.0]
[PASS] Composition rule validity: all referenced capabilities exist
[PASS] Composition cycle detection: no cycles
[WARN] Fragment owner field: 2 fragments missing owner
         - docs/ecosystem.fragments/analytics.graph.json
         - docs/ecosystem.fragments/marketplace_distribution.graph.json

Result: 8 passed, 0 failed, 1 warning
```

### Implementation

```
src/routing/graph-validator.ts             — validation engine
.github/workflows/graph-validation.yml     — CI workflow
```

---

## Alternatives Considered

### 1. Single Monolithic Evolution (no federation)

Keep the single JSON file and add weights, compositions, and telemetry inline.

**Rejected because**: At 200+ agents, the file exceeds 500 lines and becomes a merge-conflict bottleneck. The federation design is a clean separation that allows independent team ownership without changing the resolver interface.

### 2. Database-Backed Telemetry

Store execution outcomes in SQLite or PostgreSQL instead of a local JSONL file.

**Rejected because**: Adds a runtime dependency. The CLI must work in CI runners, air-gapped environments, and ephemeral containers. A JSONL file is append-only, requires no setup, and can be processed with standard Unix tools. If advanced analytics are needed, the file can be imported into LLM-Observatory.

### 3. Automatic Weight Learning (no human review)

Let the telemetry feedback loop adjust weights automatically and commit them.

**Rejected because**: Unsupervised weight changes could degrade routing for edge cases. The design requires human review before merging adjusted weights into the base graph. The `graph adjust-weights` command proposes changes; a human approves them.

### 4. Graph Query Language

Introduce a query language (like GraphQL or Cypher) for expressing routing queries.

**Rejected because**: Over-engineered for the current scale. The resolution algorithm is simple enough to express in 30 lines of TypeScript. A query language adds parsing complexity, documentation burden, and a learning curve for no measurable benefit at 25-50 capabilities.

### 5. Runtime Fragment Discovery (pull from repos)

Instead of committing fragments locally, fetch capability declarations from each repository at runtime via GitHub API.

**Rejected because**: Introduces network dependency into the routing hot path. Adds latency (55 API calls per resolution). Breaks offline and air-gapped usage. The federation design keeps all fragments local and versioned, with CI validation catching staleness.

## Tradeoffs

### Benefits

| Phase | Benefit | Quantified Impact |
|-------|---------|-------------------|
| Weighted Edges | Reduces agent selection within capabilities | `benchmarking`: 14 agents -> 3 primary (78% reduction) |
| Telemetry Feedback | Data-driven weight correction | Eliminates stale human assumptions after ~100 executions |
| Composition Rules | Prevents missing-capability bugs | Catches cases like ERP without data anonymization |
| Federation | Unblocks team-level graph ownership | Eliminates merge conflicts on shared graph file |
| CI Validation | Prevents silent routing failures | Catches broken references before they reach production |

### Costs

| Phase | Cost | Mitigation |
|-------|------|------------|
| Weighted Edges | More complex schema | Backward compatible — plain strings still work |
| Telemetry Feedback | Local storage growth | JSONL file rotation (keep last 1000 records) |
| Composition Rules | Rule maintenance burden | Start with 3-5 rules. Rules require `reason` field for self-documentation. |
| Federation | Directory sprawl | One file per capability. ~25 files initially. Standard glob patterns. |
| CI Validation | CI pipeline time | Tier 1 runs in <2 seconds. Tier 2 adds ~10 seconds for API calls. |

### Incremental Adoption

Each phase can be deployed independently. The graph loader detects which features are present and enables them:

```
Has weighted agents?       → Use weighted resolver (Phase 1)
Has outcomes.jsonl?        → Enable telemetry recording (Phase 2)
Has compositions array?    → Apply composition rules (Phase 3)
Has fragments_dir?         → Use federation loader (Phase 4)
Has graph-validation.yml?  → CI validates on PR (Phase 5)
```

No feature requires all previous features. A team can adopt CI validation (Phase 5) without ever using telemetry feedback (Phase 2).

## Implementation Priority

| Priority | Phase | Reason |
|----------|-------|--------|
| 1 | Weighted Edges | Immediate impact on routing precision, lowest effort |
| 2 | CI Validation | Prevents regressions as graph evolves, required before federation |
| 3 | Composition Rules | Encodes critical expert knowledge (ERP + security = data protection) |
| 4 | Telemetry Feedback | Requires execution data to accumulate, benefits compound over time |
| 5 | Federation | Only needed when team count or agent count makes single-file painful |

## Future Considerations

Beyond these five phases, the capability graph could evolve toward:

- **Cross-organization federation** — External teams publish capability fragments that the CLI can optionally include
- **Capability versioning** — Breaking changes to a capability's agent interface are versioned so downstream consumers can pin
- **Graph diffing** — `npx @claude-flow/cli@latest graph diff v1.0..v2.0` shows capability changes between versions
- **Routing simulation** — `npx @claude-flow/cli@latest graph simulate "user prompt"` shows which agents would be selected without executing them

These are not planned. They are recorded here so future ADRs can reference them.
