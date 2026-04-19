# Claude Code Configuration - Claude Flow V3

## 🚨 MANDATORY: Automatic Multi-Agent Platform Routing

**Every user prompt MUST be checked against the domain table below. If it matches, invoke ALL relevant agents from the platform — NEVER attempt the task yourself. Routing is automatic. The user never needs to say "use agentics".**

The agentics platform has 28 deployed agent domains (123 agents). Claude Code is the **orchestration layer** — it invokes multiple agents in parallel, collects their results, and presents them. It does NOT replace agents or add its own analysis.

### Domain Matching Table (28 domains, 123 agents)

| Domain | Agent(s) | Matches These User Prompts |
|--------|----------|---------------------------|
| **auto-optimizer** | `token`, `model-select`, `self-optimize` | optimize tokens, reduce costs, select model, prompt optimization |
| **shield** | `prompt-injection`, `pii`, `secrets`, `toxicity`, `moderation`, `abuse`, `redaction`, `safety-boundary`, `credential-exposure` | injection, PII scan, secret leak, toxicity, moderation, abuse, redact, safety check, credential exposure |
| **test-bench** | `benchmark`, `compare`, `regression`, `quality`, `hallucination`, `faithfulness`, `bias`, `prompt-sensitivity`, `consistency`, `stress`, `red-team`, `adversarial`, `golden-dataset`, `synthetic-data` | benchmark model, compare models, **model** regression, **model/output** quality eval, hallucination, faithfulness, bias, prompt sensitivity, consistency, stress test, red team, adversarial, golden dataset, synthetic benchmark data |
| **quality-engineering** | `test-design`, `unit-test-gen`, `integration-test-gen`, `property-test-gen`, `bdd-test-gen`, `coverage-analysis`, `coverage-gap-detect`, `defect-prediction`, `flaky-detection`, `rca`, `traceability`, `chaos`, `test-execution`, `qe-reporting` | generate unit/integration/property/BDD tests, coverage analysis, **test** regression, defect prediction, flaky test detection, test RCA, requirements traceability, chaos engineering (fault injection), test execution orchestration, QE reports. Per ADR-082, overlapping capabilities (security, perf, SAP/SOAP, PII, cross-session learning) route to `shield`/`latency-lens`/`connector-hub`/`data-vault`/`memory-graph` respectively. |
| **costops** | `attribution`, `forecast`, `budget`, `roi`, `tradeoff` | spending breakdown, cost forecast, budget, ROI, cost vs quality |
| **observatory** | `telemetry`, `usage-patterns`, `failures`, `health-check`, `slo`, `post-mortem`, `visualization` | telemetry, usage patterns, failure analysis, health check, SLO, outage review, dashboard |
| **sentinel** | `anomaly`, `drift`, `alert`, `correlation`, `rca` | anomaly detection, drift, alert rules, event correlation, root cause |
| **memory-graph** | `conversation`, `lineage`, `decisions`, `knowledge-graph`, `retrieval`, `patterns` | conversation history, decision lineage, knowledge graph, memory retrieval, learned patterns |
| **latency-lens** | `latency`, `cold-start` | latency analysis, cold start, p99, response time |
| **forge** | `sdk`, `cli`, `api-translation`, `version-compat` | generate SDK, CLI tool, API translation, version compatibility |
| **edge** | `tool-invoke`, `circuit-breaker`, `failover`, `execution-guard`, `caching` | tool invocation, circuit breaker, failover, execution guard, cache |
| **orchestrator** | `workflow`, `scheduler`, `dependencies`, `retry`, `parallel`, `state-machine`, `swarm` | workflow, scheduler, dependencies, retry, parallel execution, state machine, swarm |
| **incident-manager** | `escalation`, `post-mortem`, `hitl` | escalate incident, post-mortem, human-in-the-loop |
| **governance-dashboard** | `audit`, `impact`, `oversight` | audit trail, impact analysis, governance oversight |
| **policy-engine** | `enforce`, `constraints`, `approval` | enforce policy, constraints, approval workflow |
| **registry** | `index`, `reputation`, `bootstrap` | agent registry, reputation score, bootstrap agent |
| **marketplace** | `package`, `deprecation` | marketplace, agent package, deprecation notice |
| **analytics-hub** | `consensus`, `recommendation` | consensus building, recommendation report |
| **config-manager** | `validate` | validate config, configuration check |
| **schema-registry** | `validate` | validate schema, JSON schema check |
| **connector-hub** | `erp-surface`, `database-query`, `webhook-ingest`, `event-normalize`, `auth-identity` | ERP, database query, webhook, event normalize, SSO/OAuth |
| **copilot** | `planner`, `config`, `decomposer`, `clarifier`, `intent`, `reflection`, `meta-reasoner` | plan task, decompose, clarify, intent classification, reflection |
| **simulator** | `what-if`, `scenario` | what-if simulation, scenario analysis |
| **benchmark-exchange** | `publish` | publish benchmark, benchmark leaderboard |
| **inference-gateway** | `route` | inference routing, load balance model |
| **data-vault** | `access-control`, `anonymize` | access control, anonymize data, de-identify |
| **research-lab** | `hypothesis`, `metrics` | hypothesis testing, A/B test, KPI analysis |
| **platform** | `decision`, `executive-summary`, `decision-memo`, `risk-score` | go/no-go decision, executive summary, decision memo, risk score |

### Multi-Agent Orchestration (CRITICAL)

**For any non-trivial request, invoke MULTIPLE agents in PARALLEL. The `agentics ask` command does this automatically — it matches queries to multi-agent combos and dispatches 2-5 agents in parallel via `Promise.allSettled`.**

**33 Multi-Agent Combos (auto-dispatched by `agentics ask`):**

| # | Combo | Query Patterns | Agents Invoked |
|---|-------|---------------|----------------|
| 1 | cost-analysis | "how much am I spending", "cost analysis", "spending report" | costops/attribution + forecast + roi |
| 2 | token-optimization | "optimize tokens", "reduce token usage", "token cost" | auto-optimizer/token + model-select + costops/attribution |
| 3 | full-optimization | "optimize everything", "full system optimization" | auto-optimizer/self-optimize + token + model-select + costops/tradeoff + latency-lens/latency |
| 4 | cost-quality-tradeoff | "cost vs quality", "bang for buck" | costops/tradeoff + roi + auto-optimizer/model-select |
| 5 | security-scan | "security scan", "is this safe", "safety scan" | shield/prompt-injection + pii + secrets + toxicity + credential-exposure |
| 6 | red-team | "red team", "adversarial exercise" | test-bench/red-team + adversarial + shield/prompt-injection + safety-boundary |
| 7 | data-protection | "protect data", "anonymize and redact" | data-vault/anonymize + shield/pii + redaction + data-vault/access-control |
| 8 | abuse-detection | "detect abuse", "bad actor" | shield/abuse + observatory/usage-patterns + sentinel/anomaly + alert |
| 9 | safety-policies | "safety policies", "content rules" | policy-engine/enforce + constraints + shield/moderation + safety-boundary |
| 10 | model-evaluation | "evaluate model", "model quality" | test-bench/benchmark + quality + hallucination + faithfulness |
| 11 | full-model-eval | "comprehensive eval", "complete model test" | test-bench/benchmark + bias + hallucination + consistency + faithfulness |
| 12 | model-switch | "switch model", "what if we switch" | simulator/what-if + auto-optimizer/model-select + costops/tradeoff + test-bench/compare |
| 13 | drift-detection | "detect drift", "model degradation" | sentinel/drift + anomaly + test-bench/regression + observatory/telemetry |
| 14 | anomaly-investigation | "something looks wrong", "unusual pattern" | sentinel/anomaly + drift + correlation + observatory/telemetry |
| 15 | latency-debug | "why is it slow", "latency issue", "high latency" | latency-lens/latency + cold-start + sentinel/anomaly + rca |
| 16 | incident-response | "service down", "outage", "incident" | incident-manager/escalation + post-mortem + sentinel/rca + observatory/failures |
| 17 | observability-review | "observability", "system status", "platform health" | observatory/telemetry + health-check + slo + visualization |
| 18 | resilience-check | "make resilient", "handle failures" | edge/circuit-breaker + failover + execution-guard + orchestrator/retry |
| 19 | build-pipeline | "build pipeline", "set up workflow" | orchestrator/workflow + scheduler + dependencies + parallel |
| 20 | integration-setup | "wire up webhook", "integrate service" | connector-hub/webhook-ingest + event-normalize + orchestrator/workflow |
| 21 | enterprise-data | "query SAP", "ERP data", "enterprise data" | connector-hub/database-query + erp-surface + auth-identity |
| 22 | smart-routing | "smart routing", "intelligent routing" | inference-gateway/route + auto-optimizer/model-select + costops/tradeoff |
| 23 | executive-brief | "executive summary", "board report" | platform/executive-summary + costops/attribution + observatory/slo + research-lab/metrics |
| 24 | decision-package | "go/no-go", "decision package" | platform/decision + decision-memo + risk-score + costops/roi |
| 25 | risk-assessment | "risk assessment", "how risky" | platform/risk-score + governance-dashboard/impact + simulator/scenario |
| 26 | compliance-review | "compliance check", "GDPR", "HIPAA" | governance-dashboard/audit + oversight + policy-engine/enforce + data-vault/access-control |
| 27 | impact-analysis | "impact analysis", "blast radius" | governance-dashboard/impact + platform/risk-score + simulator/scenario + sentinel/correlation |
| 28 | decision-audit | "decision audit", "trace decisions" | memory-graph/decisions + lineage + governance-dashboard/audit + knowledge-graph |
| 29 | value-assessment | "delivering value", "AI team ROI" | costops/roi + research-lab/metrics + observatory/usage-patterns + platform/executive-summary |
| 30 | recommendation-report | "recommendation report" | analytics-hub/recommendation + consensus + platform/executive-summary |
| 31 | task-planning | "help me plan", "break down this task" | copilot/planner + decomposer + clarifier |
| 32 | scenario-simulation | "simulate scenario", "deployment scenario" | simulator/scenario + what-if + platform/risk-score |
| 33 | agent-onboarding | "onboard agent", "register new agent" | registry/bootstrap + index + config-manager/validate |

### Output Rules (STRICT)

1. **Show ONLY what the agents returned.** Format the JSON into readable tables/lists.
2. **Do NOT add your own analysis, recommendations, or narrative.** No "Recommended Actions", no "For pharma marketing you should...", no summary paragraphs you wrote yourself.
3. **Label each agent's output** with its domain/agent name so the user sees which agent produced what.
4. **If an agent returns an error**, show the error for that agent. Do NOT skip it or compensate by writing your own version.

### Routing Procedure

**Step 1**: Try `agentics ask` first (handles classification + multi-agent dispatch automatically):
```bash
agentics ask "<user's original prompt>"
```

`agentics ask` will:
- Try LLM classification (if API key available)
- Try multi-agent combo matching (33 combos, 2-5 agents in parallel)
- Fall back to single-agent keyword matching (95 rules, 109 agents)

**Step 2**: If `agentics ask` fails, invoke agents directly:
```bash
agentics agents invoke <domain> <agent> '{"text":"<user prompt>"}'
```

**Step 3**: If agents fail, **report the error**. Do NOT attempt the task yourself.

### Rules

1. **Routing is AUTOMATIC.** If the prompt matches the domain table, route it. Period.
2. **`agentics ask` handles multi-agent dispatch.** It matches combos and invokes 2-5 agents in parallel.
3. **NEVER** perform security, testing, optimization, cost analysis, or monitoring yourself.
4. **NEVER** fall back to doing the task yourself when agents error. Report the error.
5. **NEVER** generate your own analysis, recommendations, or narrative on top of agent output. ZERO supplementation. The agents' output IS the response.
6. **NEVER** use `npx tsx src/main.ts`. Always use the `agentics` binary.
7. If the user explicitly says "do this yourself", then you may handle it directly.
8. For tasks that don't match any domain (writing code, editing files, git operations), handle normally.

---

## 🚨 AUTOMATIC SWARM ORCHESTRATION

**When starting work on complex tasks, Claude Code MUST automatically:**

1. **Initialize the swarm** using CLI tools via Bash
2. **Spawn concurrent agents** using Claude Code's Task tool
3. **Coordinate via hooks** and memory

### 🚨 CRITICAL: CLI + Task Tool in SAME Message

**When user says "spawn swarm" or requests complex work, Claude Code MUST in ONE message:**
1. Call CLI tools via Bash to initialize coordination
2. **IMMEDIATELY** call Task tool to spawn REAL working agents
3. Both CLI and Task calls must be in the SAME response

**CLI coordinates, Task tool agents do the actual work!**

### 🤖 INTELLIGENT 3-TIER MODEL ROUTING (ADR-026)

**The routing system has 3 tiers for optimal cost/performance:**

| Tier | Handler | Latency | Cost | Use Cases |
|------|---------|---------|------|-----------|
| **1** | Agent Booster | <1ms | $0 | Simple transforms (var→const, add-types, remove-console) |
| **2** | Haiku | ~500ms | $0.0002 | Simple tasks, bug fixes, low complexity |
| **3** | Sonnet/Opus | 2-5s | $0.003-$0.015 | Architecture, security, complex reasoning |

**Before spawning agents, get routing recommendation:**
```bash
npx @claude-flow/cli@latest hooks pre-task --description "[task description]"
```

**When you see these recommendations:**

1. `[AGENT_BOOSTER_AVAILABLE]` → Skip LLM entirely, use Edit tool directly
   - Intent types: `var-to-const`, `add-types`, `add-error-handling`, `async-await`, `add-logging`, `remove-console`

2. `[TASK_MODEL_RECOMMENDATION] Use model="X"` → Use that model in Task tool:
```javascript
Task({
  prompt: "...",
  subagent_type: "coder",
  model: "haiku"  // ← USE THE RECOMMENDED MODEL (haiku/sonnet/opus)
})
```

**Benefits:** 75% cost reduction, 352x faster for Tier 1 tasks

---

### 🛡️ Anti-Drift Config (PREFERRED)

**Use this to prevent agent drift:**
```bash
# Small teams (6-8 agents) - use hierarchical for tight control
npx @claude-flow/cli@latest swarm init --topology hierarchical --max-agents 8 --strategy specialized

# Large teams (10-15 agents) - use hierarchical-mesh for V3 queen + peer communication
npx @claude-flow/cli@latest swarm init --topology hierarchical-mesh --max-agents 15 --strategy specialized
```

**Valid Topologies:**
- `hierarchical` - Queen controls workers directly (anti-drift for small teams)
- `hierarchical-mesh` - V3 queen + peer communication (recommended for 10+ agents)
- `mesh` - Fully connected peer network
- `ring` - Circular communication pattern
- `star` - Central coordinator with spokes
- `hybrid` - Dynamic topology switching

**Anti-Drift Guidelines:**
- **hierarchical**: Coordinator catches divergence
- **max-agents 6-8**: Smaller team = less drift
- **specialized**: Clear roles, no overlap
- **consensus**: raft (leader maintains state)

---

### 🔄 Auto-Start Swarm Protocol (Background Execution)

When the user requests a complex task, **spawn agents in background and WAIT for completion:**

```javascript
// STEP 1: Initialize swarm coordination (anti-drift config)
Bash("npx @claude-flow/cli@latest swarm init --topology hierarchical --max-agents 8 --strategy specialized")

// STEP 2: Spawn ALL agents IN BACKGROUND in a SINGLE message
// Use run_in_background: true so agents work concurrently
Task({
  prompt: "Research requirements, analyze codebase patterns, store findings in memory",
  subagent_type: "researcher",
  description: "Research phase",
  run_in_background: true  // ← CRITICAL: Run in background
})
Task({
  prompt: "Design architecture based on research. Document decisions.",
  subagent_type: "system-architect",
  description: "Architecture phase",
  run_in_background: true
})
Task({
  prompt: "Implement the solution following the design. Write clean code.",
  subagent_type: "coder",
  description: "Implementation phase",
  run_in_background: true
})
Task({
  prompt: "Write comprehensive tests for the implementation.",
  subagent_type: "tester",
  description: "Testing phase",
  run_in_background: true
})
Task({
  prompt: "Review code quality, security, and best practices.",
  subagent_type: "reviewer",
  description: "Review phase",
  run_in_background: true
})

// STEP 3: WAIT - Tell user agents are working, then STOP
// Say: "I've spawned 5 agents to work on this in parallel. They'll report back when done."
// DO NOT check status repeatedly. Just wait for user or agent responses.
```

### ⏸️ CRITICAL: Spawn and Wait Pattern

**After spawning background agents:**

1. **TELL USER** - "I've spawned X agents working in parallel on: [list tasks]"
2. **STOP** - Do not continue with more tool calls
3. **WAIT** - Let the background agents complete their work
4. **RESPOND** - When agents return results, review and synthesize

**Example response after spawning:**
```
I've launched 5 concurrent agents to work on this:
- 🔍 Researcher: Analyzing requirements and codebase
- 🏗️ Architect: Designing the implementation approach
- 💻 Coder: Implementing the solution
- 🧪 Tester: Writing tests
- 👀 Reviewer: Code review and security check

They're working in parallel. I'll synthesize their results when they complete.
```

### 🚫 DO NOT:
- Continuously check swarm status
- Poll TaskOutput repeatedly
- Add more tool calls after spawning
- Ask "should I check on the agents?"

### ✅ DO:
- Spawn all agents in ONE message
- Tell user what's happening
- Wait for agent results to arrive
- Synthesize results when they return

## 🧠 AUTO-LEARNING PROTOCOL

### Before Starting Any Task
```bash
# 1. Search memory for relevant patterns from past successes
Bash("npx @claude-flow/cli@latest memory search --query '[task keywords]' --namespace patterns")

# 2. Check if similar task was done before
Bash("npx @claude-flow/cli@latest memory search --query '[task type]' --namespace tasks")

# 3. Load learned optimizations
Bash("npx @claude-flow/cli@latest hooks route --task '[task description]'")
```

### After Completing Any Task Successfully
```bash
# 1. Store successful pattern for future reference
Bash("npx @claude-flow/cli@latest memory store --namespace patterns --key '[pattern-name]' --value '[what worked]'")

# 2. Train neural patterns on the successful approach
Bash("npx @claude-flow/cli@latest hooks post-edit --file '[main-file]' --train-neural true")

# 3. Record task completion with metrics
Bash("npx @claude-flow/cli@latest hooks post-task --task-id '[id]' --success true --store-results true")

# 4. Trigger optimization worker if performance-related
Bash("npx @claude-flow/cli@latest hooks worker dispatch --trigger optimize")
```

### Continuous Improvement Triggers

| Trigger | Worker | When to Use |
|---------|--------|-------------|
| After major refactor | `optimize` | Performance optimization |
| After adding features | `testgaps` | Find missing test coverage |
| After security changes | `audit` | Security analysis |
| After API changes | `document` | Update documentation |
| Every 5+ file changes | `map` | Update codebase map |
| Complex debugging | `deepdive` | Deep code analysis |

### Memory-Enhanced Development

**ALWAYS check memory before:**
- Starting a new feature (search for similar implementations)
- Debugging an issue (search for past solutions)
- Refactoring code (search for learned patterns)
- Performance work (search for optimization strategies)

**ALWAYS store in memory after:**
- Solving a tricky bug (store the solution pattern)
- Completing a feature (store the approach)
- Finding a performance fix (store the optimization)
- Discovering a security issue (store the vulnerability pattern)

### 📋 Agent Routing (Anti-Drift)

| Code | Task | Agents |
|------|------|--------|
| 1 | Bug Fix | coordinator, researcher, coder, tester |
| 3 | Feature | coordinator, architect, coder, tester, reviewer |
| 5 | Refactor | coordinator, architect, coder, reviewer |
| 7 | Performance | coordinator, perf-engineer, coder |
| 9 | Security | coordinator, security-architect, auditor |
| 11 | Docs | researcher, api-docs |

**Codes 1-9: hierarchical/specialized (anti-drift). Code 11: mesh/balanced**

### 🎯 Task Complexity Detection

**AUTO-INVOKE SWARM when task involves:**
- Multiple files (3+)
- New feature implementation
- Refactoring across modules
- API changes with tests
- Security-related changes
- Performance optimization
- Database schema changes

**SKIP SWARM for:**
- Single file edits
- Simple bug fixes (1-2 lines)
- Documentation updates
- Configuration changes
- Quick questions/exploration

## 🚨 CRITICAL: CONCURRENT EXECUTION & FILE MANAGEMENT

**ABSOLUTE RULES**:
1. ALL operations MUST be concurrent/parallel in a single message
2. **NEVER save working files, text/mds and tests to the root folder**
3. ALWAYS organize files in appropriate subdirectories
4. **USE CLAUDE CODE'S TASK TOOL** for spawning agents concurrently, not just MCP

### ⚡ GOLDEN RULE: "1 MESSAGE = ALL RELATED OPERATIONS"

**MANDATORY PATTERNS:**
- **TodoWrite**: ALWAYS batch ALL todos in ONE call (5-10+ todos minimum)
- **Task tool (Claude Code)**: ALWAYS spawn ALL agents in ONE message with full instructions
- **File operations**: ALWAYS batch ALL reads/writes/edits in ONE message
- **Bash commands**: ALWAYS batch ALL terminal operations in ONE message
- **Memory operations**: ALWAYS batch ALL memory store/retrieve in ONE message

### 📁 File Organization Rules

**NEVER save to root folder. Use these directories:**
- `/src` - Source code files
- `/tests` - Test files
- `/docs` - Documentation and markdown files
- `/config` - Configuration files
- `/scripts` - Utility scripts
- `/examples` - Example code

## Project Config (Anti-Drift Defaults)

- **Topology**: hierarchical (prevents drift)
- **Max Agents**: 8 (smaller = less drift)
- **Strategy**: specialized (clear roles)
- **Consensus**: raft
- **Memory**: hybrid
- **HNSW**: Enabled
- **Neural**: Enabled

## 🚀 V3 CLI Commands (26 Commands, 140+ Subcommands)

### Core Commands

| Command | Subcommands | Description |
|---------|-------------|-------------|
| `init` | 4 | Project initialization with wizard, presets, skills, hooks |
| `agent` | 8 | Agent lifecycle (spawn, list, status, stop, metrics, pool, health, logs) |
| `swarm` | 6 | Multi-agent swarm coordination and orchestration |
| `memory` | 11 | AgentDB memory with vector search (150x-12,500x faster) |
| `mcp` | 9 | MCP server management and tool execution |
| `task` | 6 | Task creation, assignment, and lifecycle |
| `session` | 7 | Session state management and persistence |
| `config` | 7 | Configuration management and provider setup |
| `status` | 3 | System status monitoring with watch mode |
| `workflow` | 6 | Workflow execution and template management |
| `hooks` | 17 | Self-learning hooks + 12 background workers |
| `hive-mind` | 6 | Queen-led Byzantine fault-tolerant consensus |

### Advanced Commands

| Command | Subcommands | Description |
|---------|-------------|-------------|
| `daemon` | 5 | Background worker daemon (start, stop, status, trigger, enable) |
| `neural` | 5 | Neural pattern training (train, status, patterns, predict, optimize) |
| `security` | 6 | Security scanning (scan, audit, cve, threats, validate, report) |
| `performance` | 5 | Performance profiling (benchmark, profile, metrics, optimize, report) |
| `providers` | 5 | AI providers (list, add, remove, test, configure) |
| `plugins` | 5 | Plugin management (list, install, uninstall, enable, disable) |
| `deployment` | 5 | Deployment management (deploy, rollback, status, environments, release) |
| `embeddings` | 4 | Vector embeddings (embed, batch, search, init) - 75x faster with agentic-flow |
| `claims` | 4 | Claims-based authorization (check, grant, revoke, list) |
| `migrate` | 5 | V2 to V3 migration with rollback support |
| `doctor` | 1 | System diagnostics with health checks |
| `completions` | 4 | Shell completions (bash, zsh, fish, powershell) |

### Quick CLI Examples

```bash
# Initialize project
npx @claude-flow/cli@latest init --wizard

# Start daemon with background workers
npx @claude-flow/cli@latest daemon start

# Spawn an agent
npx @claude-flow/cli@latest agent spawn -t coder --name my-coder

# Initialize swarm
npx @claude-flow/cli@latest swarm init --v3-mode

# Search memory (HNSW-indexed)
npx @claude-flow/cli@latest memory search --query "authentication patterns"

# System diagnostics
npx @claude-flow/cli@latest doctor --fix

# Security scan
npx @claude-flow/cli@latest security scan --depth full

# Performance benchmark
npx @claude-flow/cli@latest performance benchmark --suite all
```

## 🚀 Available Agents (60+ Types)

### Core Development
`coder`, `reviewer`, `tester`, `planner`, `researcher`

### V3 Specialized Agents
`security-architect`, `security-auditor`, `memory-specialist`, `performance-engineer`

### 🔐 @claude-flow/security
CVE remediation, input validation, path security:
- `InputValidator` - Zod validation
- `PathValidator` - Traversal prevention
- `SafeExecutor` - Injection protection

### Swarm Coordination
`hierarchical-coordinator`, `mesh-coordinator`, `adaptive-coordinator`, `collective-intelligence-coordinator`, `swarm-memory-manager`

### Consensus & Distributed
`byzantine-coordinator`, `raft-manager`, `gossip-coordinator`, `consensus-builder`, `crdt-synchronizer`, `quorum-manager`, `security-manager`

### Performance & Optimization
`perf-analyzer`, `performance-benchmarker`, `task-orchestrator`, `memory-coordinator`, `smart-agent`

### GitHub & Repository
`github-modes`, `pr-manager`, `code-review-swarm`, `issue-tracker`, `release-manager`, `workflow-automation`, `project-board-sync`, `repo-architect`, `multi-repo-swarm`

### SPARC Methodology
`sparc-coord`, `sparc-coder`, `specification`, `pseudocode`, `architecture`, `refinement`

### Specialized Development
`backend-dev`, `mobile-dev`, `ml-developer`, `cicd-engineer`, `api-docs`, `system-architect`, `code-analyzer`, `base-template-generator`

### Testing & Validation
`tdd-london-swarm`, `production-validator`

## 🪝 V3 Hooks System (27 Hooks + 12 Workers)

### All Available Hooks

| Hook | Description | Key Options |
|------|-------------|-------------|
| `pre-edit` | Get context before editing files | `--file`, `--operation` |
| `post-edit` | Record editing outcome for learning | `--file`, `--success`, `--train-neural` |
| `pre-command` | Assess risk before commands | `--command`, `--validate-safety` |
| `post-command` | Record command execution outcome | `--command`, `--track-metrics` |
| `pre-task` | Record task start, get agent suggestions | `--description`, `--coordinate-swarm` |
| `post-task` | Record task completion for learning | `--task-id`, `--success`, `--store-results` |
| `session-start` | Start/restore session (v2 compat) | `--session-id`, `--auto-configure` |
| `session-end` | End session and persist state | `--generate-summary`, `--export-metrics` |
| `session-restore` | Restore a previous session | `--session-id`, `--latest` |
| `route` | Route task to optimal agent | `--task`, `--context`, `--top-k` |
| `route-task` | (v2 compat) Alias for route | `--task`, `--auto-swarm` |
| `explain` | Explain routing decision | `--topic`, `--detailed` |
| `pretrain` | Bootstrap intelligence from repo | `--model-type`, `--epochs` |
| `build-agents` | Generate optimized agent configs | `--agent-types`, `--focus` |
| `metrics` | View learning metrics dashboard | `--v3-dashboard`, `--format` |
| `transfer` | Transfer patterns via IPFS registry | `store`, `from-project` |
| `list` | List all registered hooks | `--format` |
| `intelligence` | RuVector intelligence system | `trajectory-*`, `pattern-*`, `stats` |
| `worker` | Background worker management | `list`, `dispatch`, `status`, `detect` |
| `progress` | Check V3 implementation progress | `--detailed`, `--format` |
| `statusline` | Generate dynamic statusline | `--json`, `--compact`, `--no-color` |
| `coverage-route` | Route based on test coverage gaps | `--task`, `--path` |
| `coverage-suggest` | Suggest coverage improvements | `--path` |
| `coverage-gaps` | List coverage gaps with priorities | `--format`, `--limit` |
| `pre-bash` | (v2 compat) Alias for pre-command | Same as pre-command |
| `post-bash` | (v2 compat) Alias for post-command | Same as post-command |

### 12 Background Workers

| Worker | Priority | Description |
|--------|----------|-------------|
| `ultralearn` | normal | Deep knowledge acquisition |
| `optimize` | high | Performance optimization |
| `consolidate` | low | Memory consolidation |
| `predict` | normal | Predictive preloading |
| `audit` | critical | Security analysis |
| `map` | normal | Codebase mapping |
| `preload` | low | Resource preloading |
| `deepdive` | normal | Deep code analysis |
| `document` | normal | Auto-documentation |
| `refactor` | normal | Refactoring suggestions |
| `benchmark` | normal | Performance benchmarking |
| `testgaps` | normal | Test coverage analysis |

### Essential Hook Commands

```bash
# Core hooks
npx @claude-flow/cli@latest hooks pre-task --description "[task]"
npx @claude-flow/cli@latest hooks post-task --task-id "[id]" --success true
npx @claude-flow/cli@latest hooks post-edit --file "[file]" --train-neural true

# Session management
npx @claude-flow/cli@latest hooks session-start --session-id "[id]"
npx @claude-flow/cli@latest hooks session-end --export-metrics true
npx @claude-flow/cli@latest hooks session-restore --session-id "[id]"

# Intelligence routing
npx @claude-flow/cli@latest hooks route --task "[task]"
npx @claude-flow/cli@latest hooks explain --topic "[topic]"

# Neural learning
npx @claude-flow/cli@latest hooks pretrain --model-type moe --epochs 10
npx @claude-flow/cli@latest hooks build-agents --agent-types coder,tester

# Background workers
npx @claude-flow/cli@latest hooks worker list
npx @claude-flow/cli@latest hooks worker dispatch --trigger audit
npx @claude-flow/cli@latest hooks worker status

# Coverage-aware routing
npx @claude-flow/cli@latest hooks coverage-gaps --format table
npx @claude-flow/cli@latest hooks coverage-route --task "[task]"

# Statusline (for Claude Code integration)
npx @claude-flow/cli@latest hooks statusline
npx @claude-flow/cli@latest hooks statusline --json
```

## 🔄 Migration (V2 to V3)

```bash
# Check migration status
npx @claude-flow/cli@latest migrate status

# Run migration with backup
npx @claude-flow/cli@latest migrate run --backup

# Rollback if needed
npx @claude-flow/cli@latest migrate rollback

# Validate migration
npx @claude-flow/cli@latest migrate validate
```

## 🧠 Intelligence System (RuVector)

V3 includes the RuVector Intelligence System:
- **SONA**: Self-Optimizing Neural Architecture (<0.05ms adaptation)
- **MoE**: Mixture of Experts for specialized routing
- **HNSW**: 150x-12,500x faster pattern search
- **EWC++**: Elastic Weight Consolidation (prevents forgetting)
- **Flash Attention**: 2.49x-7.47x speedup

The 4-step intelligence pipeline:
1. **RETRIEVE** - Fetch relevant patterns via HNSW
2. **JUDGE** - Evaluate with verdicts (success/failure)
3. **DISTILL** - Extract key learnings via LoRA
4. **CONSOLIDATE** - Prevent catastrophic forgetting via EWC++

## 📦 Embeddings Package (v3.0.0-alpha.12)

Features:
- **sql.js**: Cross-platform SQLite persistent cache (WASM, no native compilation)
- **Document chunking**: Configurable overlap and size
- **Normalization**: L2, L1, min-max, z-score
- **Hyperbolic embeddings**: Poincaré ball model for hierarchical data
- **75x faster**: With agentic-flow ONNX integration
- **Neural substrate**: Integration with RuVector

## 🐝 Hive-Mind Consensus

### Topologies
- `hierarchical` - Queen controls workers directly
- `mesh` - Fully connected peer network
- `hierarchical-mesh` - Hybrid (recommended)
- `adaptive` - Dynamic based on load

### Consensus Strategies
- `byzantine` - BFT (tolerates f < n/3 faulty)
- `raft` - Leader-based (tolerates f < n/2)
- `gossip` - Epidemic for eventual consistency
- `crdt` - Conflict-free replicated data types
- `quorum` - Configurable quorum-based

## V3 Performance Targets

| Metric | Target |
|--------|--------|
| Flash Attention | 2.49x-7.47x speedup |
| HNSW Search | 150x-12,500x faster |
| Memory Reduction | 50-75% with quantization |
| MCP Response | <100ms |
| CLI Startup | <500ms |
| SONA Adaptation | <0.05ms |

## 📊 Performance Optimization Protocol

### Automatic Performance Tracking
```bash
# After any significant operation, track metrics
Bash("npx @claude-flow/cli@latest hooks post-command --command '[operation]' --track-metrics true")

# Periodically run benchmarks (every major feature)
Bash("npx @claude-flow/cli@latest performance benchmark --suite all")

# Analyze bottlenecks when performance degrades
Bash("npx @claude-flow/cli@latest performance profile --target '[component]'")
```

### Session Persistence (Cross-Conversation Learning)
```bash
# At session start - restore previous context
Bash("npx @claude-flow/cli@latest session restore --latest")

# At session end - persist learned patterns
Bash("npx @claude-flow/cli@latest hooks session-end --generate-summary true --persist-state true --export-metrics true")
```

### Neural Pattern Training
```bash
# Train on successful code patterns
Bash("npx @claude-flow/cli@latest neural train --pattern-type coordination --epochs 10")

# Predict optimal approach for new tasks
Bash("npx @claude-flow/cli@latest neural predict --input '[task description]'")

# View learned patterns
Bash("npx @claude-flow/cli@latest neural patterns --list")
```

## 🔧 Environment Variables

```bash
# Configuration
CLAUDE_FLOW_CONFIG=./claude-flow.config.json
CLAUDE_FLOW_LOG_LEVEL=info

# Provider API Keys
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...
GOOGLE_API_KEY=...

# MCP Server
CLAUDE_FLOW_MCP_PORT=3000
CLAUDE_FLOW_MCP_HOST=localhost
CLAUDE_FLOW_MCP_TRANSPORT=stdio

# Memory
CLAUDE_FLOW_MEMORY_BACKEND=hybrid
CLAUDE_FLOW_MEMORY_PATH=./data/memory
```

## 🔍 Doctor Health Checks

Run `npx @claude-flow/cli@latest doctor` to check:
- Node.js version (20+)
- npm version (9+)
- Git installation
- Config file validity
- Daemon status
- Memory database
- API keys
- MCP servers
- Disk space
- TypeScript installation

## 🚀 Quick Setup

```bash
# Add MCP servers (auto-detects MCP mode when stdin is piped)
claude mcp add claude-flow -- npx -y @claude-flow/cli@latest
claude mcp add ruv-swarm -- npx -y ruv-swarm mcp start  # Optional
claude mcp add flow-nexus -- npx -y flow-nexus@latest mcp start  # Optional

# Start daemon
npx @claude-flow/cli@latest daemon start

# Run doctor
npx @claude-flow/cli@latest doctor --fix
```

## 🎯 Claude Code vs CLI Tools

### Claude Code Handles ALL EXECUTION:
- **Task tool**: Spawn and run agents concurrently
- File operations (Read, Write, Edit, MultiEdit, Glob, Grep)
- Code generation and programming
- Bash commands and system operations
- TodoWrite and task management
- Git operations

### CLI Tools Handle Coordination (via Bash):
- **Swarm init**: `npx @claude-flow/cli@latest swarm init --topology <type>`
- **Swarm status**: `npx @claude-flow/cli@latest swarm status`
- **Agent spawn**: `npx @claude-flow/cli@latest agent spawn -t <type> --name <name>`
- **Memory store**: `npx @claude-flow/cli@latest memory store --key "mykey" --value "myvalue" --namespace patterns`
- **Memory search**: `npx @claude-flow/cli@latest memory search --query "search terms"`
- **Memory list**: `npx @claude-flow/cli@latest memory list --namespace patterns`
- **Memory retrieve**: `npx @claude-flow/cli@latest memory retrieve --key "mykey" --namespace patterns`
- **Hooks**: `npx @claude-flow/cli@latest hooks <hook-name> [options]`

## 📝 Memory Commands Reference (IMPORTANT)

### Store Data (ALL options shown)
```bash
# REQUIRED: --key and --value
# OPTIONAL: --namespace (default: "default"), --ttl, --tags
npx @claude-flow/cli@latest memory store --key "pattern-auth" --value "JWT with refresh tokens" --namespace patterns
npx @claude-flow/cli@latest memory store --key "bug-fix-123" --value "Fixed null check" --namespace solutions --tags "bugfix,auth"
```

### Search Data (semantic vector search)
```bash
# REQUIRED: --query (full flag, not -q)
# OPTIONAL: --namespace, --limit, --threshold
npx @claude-flow/cli@latest memory search --query "authentication patterns"
npx @claude-flow/cli@latest memory search --query "error handling" --namespace patterns --limit 5
```

### List Entries
```bash
# OPTIONAL: --namespace, --limit
npx @claude-flow/cli@latest memory list
npx @claude-flow/cli@latest memory list --namespace patterns --limit 10
```

### Retrieve Specific Entry
```bash
# REQUIRED: --key
# OPTIONAL: --namespace (default: "default")
npx @claude-flow/cli@latest memory retrieve --key "pattern-auth"
npx @claude-flow/cli@latest memory retrieve --key "pattern-auth" --namespace patterns
```

### Initialize Memory Database
```bash
npx @claude-flow/cli@latest memory init --force --verbose
```

**KEY**: CLI coordinates the strategy via Bash, Claude Code's Task tool executes with real agents.

## Support

- Documentation: https://github.com/ruvnet/claude-flow
- Issues: https://github.com/ruvnet/claude-flow/issues

---

Remember: **Claude Flow CLI coordinates, Claude Code Task tool creates!**

# important-instruction-reminders
Do what has been asked; nothing more, nothing less.
NEVER create files unless they're absolutely necessary for achieving your goal.
ALWAYS prefer editing an existing file to creating a new one.
NEVER proactively create documentation files (*.md) or README files. Only create documentation files if explicitly requested by the User.
Never save working files, text/mds and tests to the root folder.

## 🚨 SWARM EXECUTION RULES (CRITICAL)
1. **SPAWN IN BACKGROUND**: Use `run_in_background: true` for all agent Task calls
2. **SPAWN ALL AT ONCE**: Put ALL agent Task calls in ONE message for parallel execution
3. **TELL USER**: After spawning, list what each agent is doing (use emojis for clarity)
4. **STOP AND WAIT**: After spawning, STOP - do NOT add more tool calls or check status
5. **NO POLLING**: Never poll TaskOutput or check swarm status - trust agents to return
6. **SYNTHESIZE**: When agent results arrive, review ALL results before proceeding
7. **NO CONFIRMATION**: Don't ask "should I check?" - just wait for results

Example spawn message:
```
"I've launched 4 agents in background:
- 🔍 Researcher: [task]
- 💻 Coder: [task]
- 🧪 Tester: [task]
- 👀 Reviewer: [task]
Working in parallel - I'll synthesize when they complete."
```
