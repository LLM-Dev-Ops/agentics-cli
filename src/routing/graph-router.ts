/**
 * Graph Router (ADR-030)
 *
 * Resolves classified capabilities into a stage-sequenced agent pipeline.
 * This is the core routing engine that replaces full-fleet dispatch with
 * targeted agent selection.
 *
 * Decision flow:
 *   1. Receive classified capabilities
 *   2. Resolve transitive dependencies
 *   3. Look up agents and repos from the graph
 *   4. Sequence agents by execution stage
 *   5. Enforce agent budget constraints
 *   6. Return a minimal, ordered pipeline
 */

import type { EcosystemGraph, CapabilityEntry, StageName } from './graph-loader.js';
import { getCapabilityByName, resolveDependencies } from './graph-loader.js';
import type { ClassificationResult } from './capability-classifier.js';
import { normalizeAgents } from './weighted-resolver.js';
import { applyCompositions, formatCompositionExplanation } from './composition-engine.js';
import type { CompositionResult } from './composition-engine.js';

// ============================================================================
// Types
// ============================================================================

export interface RoutedAgent {
  /** Agent display name from the graph. */
  readonly agentName: string;
  /** Capability that selected this agent. */
  readonly capability: string;
  /** Repository that implements this agent. */
  readonly repo: string;
  /** Execution stage this agent belongs to. */
  readonly stage: StageName;
  /** Agent weight from the graph (ADR-031 Phase 1). */
  readonly weight: number;
  /** Agent role classification (ADR-031 Phase 1). */
  readonly role: string;
}

export interface StageGroup {
  /** Stage name. */
  readonly stage: StageName;
  /** Agents to execute in this stage. */
  readonly agents: readonly RoutedAgent[];
}

export interface RoutingResult {
  /** Original classification that produced this routing. */
  readonly classification: ClassificationResult;
  /** Capabilities after dependency resolution. */
  readonly resolvedCapabilities: readonly string[];
  /** Agent pipeline ordered by stage. Only non-empty stages are included. */
  readonly pipeline: readonly StageGroup[];
  /** Total number of agents selected. */
  readonly totalAgents: number;
  /** Total number of repositories involved. */
  readonly totalRepos: number;
  /** Unique repository names. */
  readonly repos: readonly string[];
  /** Whether the agent budget was exceeded and pruning was applied. */
  readonly pruned: boolean;
  /** Human-readable routing explanation. */
  readonly explanation: string;
  /** Composition rules that fired (ADR-031 Phase 3). */
  readonly compositionResult?: CompositionResult;
}

// ============================================================================
// Agent Budget Constraints (ADR-030)
// ============================================================================

export interface AgentBudget {
  /** Max agents for a single capability match. Default: 5. */
  readonly singleCapability: number;
  /** Max agents for 2-3 capability matches. Default: 8. */
  readonly multiCapability: number;
  /** Max agents for 4+ capability matches. Default: 12. */
  readonly fullPipeline: number;
  /** Absolute maximum agents regardless of capabilities. Default: 15. */
  readonly hardCeiling: number;
}

const DEFAULT_BUDGET: AgentBudget = {
  singleCapability: 5,
  multiCapability: 8,
  fullPipeline: 12,
  hardCeiling: 15,
};

// ============================================================================
// Router
// ============================================================================

/**
 * Route classified capabilities through the ecosystem graph to produce
 * a stage-sequenced agent pipeline.
 *
 * @param classification - Output from classifyCapabilities()
 * @param graph - Loaded ecosystem graph
 * @param budget - Optional agent budget overrides
 * @returns Ordered pipeline of agents grouped by stage
 */
export function routeCapabilities(
  classification: ClassificationResult,
  graph: EcosystemGraph,
  budget?: Partial<AgentBudget>,
): RoutingResult {
  const effectiveBudget: AgentBudget = { ...DEFAULT_BUDGET, ...budget };

  // Step 1: Extract capability names from classification
  const classifiedNames = classification.capabilities.map(c => c.name);

  if (classifiedNames.length === 0) {
    return buildEmptyResult(classification);
  }

  // Step 2: Apply composition rules (ADR-031 Phase 3)
  let compositionResult: CompositionResult | undefined;
  let expandedNames = classifiedNames;

  if (graph.compositions && graph.compositions.length > 0) {
    const validCaps = new Set(graph.capabilities.map(c => c.name));
    compositionResult = applyCompositions(
      classifiedNames,
      graph.compositions,
      validCaps,
      { agentBudget: effectiveBudget.hardCeiling },
    );
    expandedNames = [...compositionResult.capabilities];
  }

  // Step 3: Resolve transitive dependencies
  const resolvedNames = resolveDependencies(graph, expandedNames);

  // Step 4: Look up all capability entries
  const entries = new Map<string, CapabilityEntry>();
  for (const name of resolvedNames) {
    const cap = getCapabilityByName(graph, name);
    if (cap) {
      entries.set(name, cap);
    }
  }

  // Step 5: Build agent list with deduplication and weighted selection
  const agentSet = new Map<string, RoutedAgent>(); // key = agentName for dedup
  for (const [capName, cap] of entries) {
    const stage = cap.stage ?? inferStage(cap);
    const weightedAgents = normalizeAgents(cap.agents);

    // Sort by weight descending for selection priority
    const sorted = [...weightedAgents].sort((a, b) => b.weight - a.weight);

    for (const wa of sorted) {
      const repo = cap.repos[0] ?? 'unknown';
      // First occurrence wins (preserves capability with highest confidence)
      if (!agentSet.has(wa.name)) {
        agentSet.set(wa.name, {
          agentName: wa.name,
          capability: capName,
          repo,
          stage,
          weight: wa.weight,
          role: wa.role,
        });
      }
    }
  }

  // Step 6: Determine budget limit
  const capCount = classifiedNames.length;
  let maxAgents: number;
  if (capCount <= 1) {
    maxAgents = effectiveBudget.singleCapability;
  } else if (capCount <= 3) {
    maxAgents = effectiveBudget.multiCapability;
  } else {
    maxAgents = effectiveBudget.fullPipeline;
  }
  maxAgents = Math.min(maxAgents, effectiveBudget.hardCeiling);

  // Step 7: Prune if over budget (weight-aware: prefer primary > secondary > specialist)
  let agents = Array.from(agentSet.values());
  let pruned = false;

  if (agents.length > maxAgents) {
    agents = pruneAgents(agents, classification, maxAgents);
    pruned = true;
  }

  // Step 8: Group by stage in execution order
  const pipeline = buildPipeline(agents, graph.stages);

  // Step 9: Collect unique repos
  const repoSet = new Set<string>();
  for (const agent of agents) {
    repoSet.add(agent.repo);
  }
  const repos = Array.from(repoSet);

  // Step 10: Build explanation
  const explanation = buildExplanation(
    classification,
    resolvedNames,
    classifiedNames,
    pipeline,
    agents.length,
    pruned,
    compositionResult,
  );

  return {
    classification,
    resolvedCapabilities: resolvedNames,
    pipeline,
    totalAgents: agents.length,
    totalRepos: repos.length,
    repos,
    pruned,
    explanation,
    compositionResult,
  };
}

// ============================================================================
// Pruning
// ============================================================================

/**
 * Prune agents to fit within budget. Strategy:
 * 1. Rank agents by the confidence of the capability that selected them
 * 2. Ensure at least one agent per classified capability
 * 3. Fill remaining budget with highest-confidence agents
 */
function pruneAgents(
  agents: RoutedAgent[],
  classification: ClassificationResult,
  maxAgents: number,
): RoutedAgent[] {
  // Build confidence map from classification
  const confidenceMap = new Map<string, number>();
  for (const c of classification.capabilities) {
    confidenceMap.set(c.name, c.confidence);
  }

  // Ensure at least one agent per classified capability
  const guaranteedAgents = new Map<string, RoutedAgent>();
  for (const agent of agents) {
    if (!guaranteedAgents.has(agent.capability)) {
      guaranteedAgents.set(agent.capability, agent);
    }
  }

  const guaranteed = Array.from(guaranteedAgents.values());
  if (guaranteed.length >= maxAgents) {
    // Even one-per-capability exceeds budget — take top N by confidence
    return guaranteed
      .sort((a, b) => (confidenceMap.get(b.capability) ?? 0) - (confidenceMap.get(a.capability) ?? 0))
      .slice(0, maxAgents);
  }

  // Fill remaining slots — sort by: role priority (primary > secondary > specialist),
  // then by weight descending, then by capability confidence descending
  const guaranteedNames = new Set(guaranteed.map(a => a.agentName));
  const rolePriority: Record<string, number> = { primary: 3, secondary: 2, specialist: 1 };
  const remaining = agents
    .filter(a => !guaranteedNames.has(a.agentName))
    .sort((a, b) => {
      const roleDiff = (rolePriority[b.role] ?? 0) - (rolePriority[a.role] ?? 0);
      if (roleDiff !== 0) return roleDiff;
      const weightDiff = b.weight - a.weight;
      if (Math.abs(weightDiff) > 0.001) return weightDiff;
      return (confidenceMap.get(b.capability) ?? 0) - (confidenceMap.get(a.capability) ?? 0);
    });

  const remainingBudget = maxAgents - guaranteed.length;
  return [...guaranteed, ...remaining.slice(0, remainingBudget)];
}

// ============================================================================
// Pipeline Building
// ============================================================================

/**
 * Group agents by stage and order according to the graph's stage sequence.
 */
function buildPipeline(agents: RoutedAgent[], stages: readonly StageName[]): StageGroup[] {
  const stageMap = new Map<StageName, RoutedAgent[]>();

  for (const agent of agents) {
    const existing = stageMap.get(agent.stage);
    if (existing) {
      existing.push(agent);
    } else {
      stageMap.set(agent.stage, [agent]);
    }
  }

  // Return stages in order, only including non-empty ones
  const pipeline: StageGroup[] = [];
  for (const stage of stages) {
    const stageAgents = stageMap.get(stage);
    if (stageAgents && stageAgents.length > 0) {
      pipeline.push({ stage, agents: stageAgents });
    }
  }

  return pipeline;
}

/**
 * Infer a default stage for capabilities that don't have one assigned.
 */
function inferStage(_cap: CapabilityEntry): StageName {
  return 'build';
}

// ============================================================================
// Explanation
// ============================================================================

function buildExplanation(
  classification: ClassificationResult,
  resolvedNames: readonly string[],
  classifiedNames: readonly string[],
  pipeline: readonly StageGroup[],
  totalAgents: number,
  pruned: boolean,
  compositionResult?: CompositionResult,
): string {
  const lines: string[] = [];

  lines.push('Capability Graph Routing:');

  // Classification
  lines.push(`  Classified: [${classifiedNames.join(', ')}]`);
  for (const c of classification.capabilities) {
    lines.push(`    ${c.name}: ${c.matchType} match (${(c.confidence * 100).toFixed(0)}%) via [${c.matchedTokens.join(', ')}]`);
  }

  // Composition rules (ADR-031 Phase 3)
  if (compositionResult && compositionResult.firedRules.length > 0) {
    lines.push(formatCompositionExplanation(compositionResult));
  }

  // Dependencies
  const addedDeps = resolvedNames.filter(n => !classifiedNames.includes(n));
  if (addedDeps.length > 0) {
    lines.push(`  Dependencies added: [${addedDeps.join(', ')}]`);
  }

  // Pipeline
  lines.push(`  Pipeline (${totalAgents} agents)${pruned ? ' [PRUNED]' : ''}:`);
  for (const group of pipeline) {
    const agentNames = group.agents.map(a => a.agentName).join(', ');
    lines.push(`    ${group.stage}: ${agentNames}`);
  }

  return lines.join('\n');
}

// ============================================================================
// Empty Result
// ============================================================================

function buildEmptyResult(classification: ClassificationResult): RoutingResult {
  return {
    classification,
    resolvedCapabilities: [],
    pipeline: [],
    totalAgents: 0,
    totalRepos: 0,
    repos: [],
    pruned: false,
    explanation: 'Capability Graph Routing:\n  No capabilities matched. Falling back to full-fleet dispatch.',
  };
}

// ============================================================================
// Domain/Agent Mapping (Bridge to existing agent invocation)
// ============================================================================

/**
 * Map from graph agent names (e.g., "ERP Integration Agent") to the
 * domain/agent identifiers used by the existing invocation system
 * (e.g., { domain: "connector-hub", agent: "erp-surface" }).
 *
 * This mapping bridges the capability graph's human-readable agent names
 * to the AGENT_DOMAINS registry in commands/agents.ts.
 */
export interface DomainAgentRef {
  readonly domain: string;
  readonly agent: string;
}

/**
 * Comprehensive mapping from graph agent display names to domain/agent pairs.
 * Maintained manually; must stay in sync with AGENT_DOMAINS in agents.ts.
 */
const AGENT_NAME_TO_DOMAIN: ReadonlyMap<string, DomainAgentRef> = new Map([
  // test-bench
  ['Benchmark Runner Agent', { domain: 'test-bench', agent: 'benchmark' }],
  ['Model Comparator Agent', { domain: 'test-bench', agent: 'compare' }],
  ['Regression Detection Agent', { domain: 'test-bench', agent: 'regression' }],
  ['Quality Scoring Agent', { domain: 'test-bench', agent: 'quality' }],
  ['Hallucination Detection Agent', { domain: 'test-bench', agent: 'hallucination' }],
  ['Faithfulness Verification Agent', { domain: 'test-bench', agent: 'faithfulness' }],
  ['Bias Detection Agent', { domain: 'test-bench', agent: 'bias' }],
  ['Prompt Sensitivity Agent', { domain: 'test-bench', agent: 'prompt-sensitivity' }],
  ['Output Consistency Agent', { domain: 'test-bench', agent: 'consistency' }],
  ['Stress Test Agent', { domain: 'test-bench', agent: 'stress' }],
  ['Red Team Agent', { domain: 'test-bench', agent: 'red-team' }],
  ['Adversarial Prompt Agent', { domain: 'test-bench', agent: 'adversarial' }],
  ['Golden Dataset Validator Agent', { domain: 'test-bench', agent: 'golden-dataset' }],
  ['Synthetic Data Generator Agent', { domain: 'test-bench', agent: 'synthetic-data' }],
  // observatory
  ['Telemetry Collector Agent', { domain: 'observatory', agent: 'telemetry' }],
  ['Usage Pattern Agent', { domain: 'observatory', agent: 'usage-patterns' }],
  ['Failure Classification Agent', { domain: 'observatory', agent: 'failures' }],
  ['Health Check Agent', { domain: 'observatory', agent: 'health-check' }],
  ['SLO / SLA Enforcement Agent', { domain: 'observatory', agent: 'slo' }],
  ['Post-Mortem Generator Agent', { domain: 'observatory', agent: 'post-mortem' }],
  ['Visualization Spec Agent', { domain: 'observatory', agent: 'visualization' }],
  // shield
  ['Prompt Injection Detection Agent', { domain: 'shield', agent: 'prompt-injection' }],
  ['PII Detection Agent', { domain: 'shield', agent: 'pii' }],
  ['Data Redaction Agent', { domain: 'shield', agent: 'redaction' }],
  ['Secrets Leakage Agent', { domain: 'shield', agent: 'secrets' }],
  ['Toxicity Detection Agent', { domain: 'shield', agent: 'toxicity' }],
  ['Safety Boundary Agent', { domain: 'shield', agent: 'safety-boundary' }],
  ['Content Moderation Agent', { domain: 'shield', agent: 'moderation' }],
  ['Model Abuse Detection Agent', { domain: 'shield', agent: 'abuse' }],
  ['Credential Exposure Agent', { domain: 'shield', agent: 'credential-exposure' }],
  // sentinel
  ['Anomaly Detection Agent', { domain: 'sentinel', agent: 'anomaly' }],
  ['Drift Detection Agent', { domain: 'sentinel', agent: 'drift' }],
  ['Alerting Agent', { domain: 'sentinel', agent: 'alert' }],
  ['Incident Correlation Agent', { domain: 'sentinel', agent: 'correlation' }],
  ['Root Cause Analysis Agent', { domain: 'sentinel', agent: 'rca' }],
  // memory-graph
  // (note: QE has its own RCA agent — see 'QE Root Cause Analysis Agent' under quality-engineering
  // per ADR-PIPELINE-087 §2. Display-name collision was resolved by renaming the QE entry in
  // docs/ecosystem.graph.json; the sentinel mapping above is unchanged.)
  ['Conversation Memory Agent', { domain: 'memory-graph', agent: 'conversation' }],
  ['Prompt Lineage Agent', { domain: 'memory-graph', agent: 'lineage' }],
  ['Decision Memory Agent', { domain: 'memory-graph', agent: 'decisions' }],
  ['Knowledge Graph Builder Agent', { domain: 'memory-graph', agent: 'knowledge-graph' }],
  ['Memory Retrieval Agent', { domain: 'memory-graph', agent: 'retrieval' }],
  ['Long-Term Pattern Agent', { domain: 'memory-graph', agent: 'patterns' }],
  // latency-lens
  ['Latency Analysis Agent', { domain: 'latency-lens', agent: 'latency' }],
  ['Cold Start Mitigation Agent', { domain: 'latency-lens', agent: 'cold-start' }],
  // forge
  ['SDK Generator Agent', { domain: 'forge', agent: 'sdk' }],
  ['CLI Command Generator Agent', { domain: 'forge', agent: 'cli' }],
  ['API Translation Agent', { domain: 'forge', agent: 'api-translation' }],
  ['Version Compatibility Agent', { domain: 'forge', agent: 'version-compat' }],
  // edge
  ['Tool Invocation Agent', { domain: 'edge', agent: 'tool-invoke' }],
  ['Circuit Breaker Agent', { domain: 'edge', agent: 'circuit-breaker' }],
  ['Failover Agent', { domain: 'edge', agent: 'failover' }],
  ['Execution Guard Agent', { domain: 'edge', agent: 'execution-guard' }],
  ['Caching Strategy Agent', { domain: 'edge', agent: 'caching' }],
  // auto-optimizer
  ['Self-Optimizing Agent', { domain: 'auto-optimizer', agent: 'self-optimize' }],
  ['Token Optimization Agent', { domain: 'auto-optimizer', agent: 'token' }],
  ['Model Selection Agent', { domain: 'auto-optimizer', agent: 'model-select' }],
  // incident-manager
  ['Incident Escalation Agent', { domain: 'incident-manager', agent: 'escalation' }],
  ['Human-in-the-Loop Agent', { domain: 'incident-manager', agent: 'hitl' }],
  // orchestrator
  ['Workflow Orchestrator Agent', { domain: 'orchestrator', agent: 'workflow' }],
  ['Task Scheduler Agent', { domain: 'orchestrator', agent: 'scheduler' }],
  ['Dependency Resolver Agent', { domain: 'orchestrator', agent: 'dependencies' }],
  ['Retry & Recovery Agent', { domain: 'orchestrator', agent: 'retry' }],
  ['Parallelization Agent', { domain: 'orchestrator', agent: 'parallel' }],
  ['State Machine Agent', { domain: 'orchestrator', agent: 'state-machine' }],
  ['Swarm Coordinator Agent', { domain: 'orchestrator', agent: 'swarm' }],
  // costops
  ['Cost Attribution Agent', { domain: 'costops', agent: 'attribution' }],
  ['Cost Forecasting Agent', { domain: 'costops', agent: 'forecast' }],
  ['Budget Enforcement Agent', { domain: 'costops', agent: 'budget' }],
  ['ROI Estimation Agent', { domain: 'costops', agent: 'roi' }],
  ['Cost-Performance Tradeoff Agent', { domain: 'costops', agent: 'tradeoff' }],
  // governance-dashboard
  ['Governance Audit Agent', { domain: 'governance-dashboard', agent: 'audit' }],
  ['Change Impact Agent', { domain: 'governance-dashboard', agent: 'impact' }],
  ['Usage Oversight Agent', { domain: 'governance-dashboard', agent: 'oversight' }],
  // policy-engine
  ['Policy Enforcement Agent', { domain: 'policy-engine', agent: 'enforce' }],
  ['Constraint Solver Agent', { domain: 'policy-engine', agent: 'constraints' }],
  ['Approval Routing Agent', { domain: 'policy-engine', agent: 'approval' }],
  // registry
  ['Registry Indexing Agent', { domain: 'registry', agent: 'index' }],
  ['Agent Reputation Agent', { domain: 'registry', agent: 'reputation' }],
  ['Template Bootstrap Agent', { domain: 'registry', agent: 'bootstrap' }],
  // marketplace
  ['Marketplace Packaging Agent', { domain: 'marketplace', agent: 'package' }],
  ['Deprecation Agent', { domain: 'marketplace', agent: 'deprecation' }],
  // analytics-hub
  ['Consensus Agent', { domain: 'analytics-hub', agent: 'consensus' }],
  ['Strategic Recommendation Agent', { domain: 'analytics-hub', agent: 'recommendation' }],
  // config-manager (shared agent name)
  // schema-registry (shared agent name)
  // connector-hub
  ['ERP Integration Agent', { domain: 'connector-hub', agent: 'erp-surface' }],
  // copilot
  ['Planner Agent', { domain: 'copilot', agent: 'planner' }],
  ['Decomposer Agent', { domain: 'copilot', agent: 'decomposer' }],
  ['Objective Clarifier Agent', { domain: 'copilot', agent: 'clarifier' }],
  ['Intent Classifier Agent', { domain: 'copilot', agent: 'intent' }],
  ['Reflection Agent', { domain: 'copilot', agent: 'reflection' }],
  ['Meta-Reasoner Agent', { domain: 'copilot', agent: 'meta-reasoner' }],
  // simulator
  ['What-If Simulation Agent', { domain: 'simulator', agent: 'what-if' }],
  ['Scenario Generator Agent', { domain: 'simulator', agent: 'scenario' }],
  // benchmark-exchange
  ['Benchmark Publication Agent', { domain: 'benchmark-exchange', agent: 'publish' }],
  // inference-gateway
  ['Inference Routing Agent', { domain: 'inference-gateway', agent: 'route' }],
  // data-vault
  ['Data Access Control Agent', { domain: 'data-vault', agent: 'access-control' }],
  ['Dataset Anonymization Agent', { domain: 'data-vault', agent: 'anonymize' }],
  // research-lab
  ['Hypothesis Agent', { domain: 'research-lab', agent: 'hypothesis' }],
  ['Experimental Metric Agent', { domain: 'research-lab', agent: 'metrics' }],
  // platform
  ['Decision Agent', { domain: 'platform', agent: 'decision' }],
  ['Executive Summary Agent', { domain: 'platform', agent: 'executive-summary' }],
  ['Decision Memo Agent', { domain: 'platform', agent: 'decision-memo' }],
  ['Risk Scoring Agent', { domain: 'platform', agent: 'risk-score' }],
  // enterprise
  ['Enterprise Strategy Agent', { domain: 'costops', agent: 'roi' }],

  // ==========================================================================
  // ADR-PIPELINE-087 §1 — Resolver coverage for agents referenced by
  // docs/ecosystem.graph.json but previously missing from the map.
  // ==========================================================================

  // quality-engineering (AQE, 14 agents) — ADR-PIPELINE-080 registered these
  // in the graph but did not add resolver entries. Every AQE selection fell
  // through resolveAgentRef() → undefined → silently skipped.
  ['Test Design Agent', { domain: 'quality-engineering', agent: 'test-design' }],
  ['Unit Test Generation Agent', { domain: 'quality-engineering', agent: 'unit-test-gen' }],
  ['Integration Test Generation Agent', { domain: 'quality-engineering', agent: 'integration-test-gen' }],
  ['Property-Based Test Agent', { domain: 'quality-engineering', agent: 'property-test-gen' }],
  ['BDD Test Generation Agent', { domain: 'quality-engineering', agent: 'bdd-test-gen' }],
  ['Coverage Analysis Agent', { domain: 'quality-engineering', agent: 'coverage-analysis' }],
  ['Coverage Gap Detection Agent', { domain: 'quality-engineering', agent: 'coverage-gap-detect' }],
  ['Defect Prediction Agent', { domain: 'quality-engineering', agent: 'defect-prediction' }],
  ['Flaky Test Detection Agent', { domain: 'quality-engineering', agent: 'flaky-detection' }],
  ['Requirements Traceability Agent', { domain: 'quality-engineering', agent: 'traceability' }],
  ['Chaos Engineering Agent', { domain: 'quality-engineering', agent: 'chaos' }],
  ['Test Execution Orchestrator Agent', { domain: 'quality-engineering', agent: 'test-execution' }],
  ['QE Reporting Agent', { domain: 'quality-engineering', agent: 'qe-reporting' }],
  // ADR-PIPELINE-087 §2: QE owns test-failure RCA; renamed in the graph to
  // disambiguate from sentinel's platform-level Root Cause Analysis Agent.
  ['QE Root Cause Analysis Agent', { domain: 'quality-engineering', agent: 'rca' }],

  // connector-hub — graph references these sub-agents; prior resolver only
  // mapped "ERP Integration Agent".
  ['ERP Surface Agent', { domain: 'connector-hub', agent: 'erp-surface' }],
  ['Database Query Agent', { domain: 'connector-hub', agent: 'database-query' }],
  ['Webhook Listener Agent', { domain: 'connector-hub', agent: 'webhook-ingest' }],
  ['Event Normalization Agent', { domain: 'connector-hub', agent: 'event-normalize' }],
  ['Auth / Identity Agent', { domain: 'connector-hub', agent: 'auth-identity' }],

  // config-manager / schema-registry
  ['Config Validation Agent', { domain: 'config-manager', agent: 'validate' }],
  ['Schema Validation Agent', { domain: 'schema-registry', agent: 'validate' }],

  // test-bench — graph uses shortened aliases in some capabilities.
  ['Benchmark Agent', { domain: 'test-bench', agent: 'benchmark' }],
  ['Compare Agent', { domain: 'test-bench', agent: 'compare' }],
  ['Consistency Agent', { domain: 'test-bench', agent: 'consistency' }],
  ['Faithfulness Agent', { domain: 'test-bench', agent: 'faithfulness' }],
  ['Synthetic Data Agent', { domain: 'test-bench', agent: 'synthetic-data' }],
  ['Golden Dataset Agent', { domain: 'test-bench', agent: 'golden-dataset' }],
  ['Bias Evaluation Agent', { domain: 'test-bench', agent: 'bias' }],
  ['Adversarial Agent', { domain: 'test-bench', agent: 'adversarial' }],

  // diligence-artifacts — SPARC/ADR/DDD agents are produced by the
  // agentics-diligence-artifacts repo. These agents are driven by the phase
  // coordinators (phase2/phase3/phase4), not by cloud-function dispatch, but
  // they are still classifier-selected and must resolve so ADR-PIPELINE-087 §4
  // doesn't drop them silently.
  ['SPARC Specification Agent', { domain: 'diligence-artifacts', agent: 'sparc-specification' }],
  ['SPARC Pseudocode Agent', { domain: 'diligence-artifacts', agent: 'sparc-pseudocode' }],
  ['SPARC Architecture Agent', { domain: 'diligence-artifacts', agent: 'sparc-architecture' }],
  ['SPARC Refinement Agent', { domain: 'diligence-artifacts', agent: 'sparc-refinement' }],
  ['SPARC Completion Agent', { domain: 'diligence-artifacts', agent: 'sparc-completion' }],
  ['SPARC Merge Agent', { domain: 'diligence-artifacts', agent: 'sparc-merge' }],
  ['ADR Generation Agent', { domain: 'diligence-artifacts', agent: 'adr-generation' }],
  ['DDD Domain Model Agent', { domain: 'diligence-artifacts', agent: 'ddd-domain-model' }],
  ['Context Map Agent', { domain: 'diligence-artifacts', agent: 'context-map' }],
  ['Architecture Decision Validator Agent', { domain: 'diligence-artifacts', agent: 'adr-validator' }],
  ['Documentation Generator Agent', { domain: 'diligence-artifacts', agent: 'documentation' }],
]);

/**
 * Resolve a graph agent name to its domain/agent invocation reference.
 * Returns undefined for unknown agents.
 */
export function resolveAgentRef(agentName: string): DomainAgentRef | undefined {
  return AGENT_NAME_TO_DOMAIN.get(agentName);
}

/**
 * A classifier-selected agent whose display name did not resolve to a
 * domain/agent pair. ADR-PIPELINE-087 §4 surfaces these instead of dropping
 * them silently.
 */
export interface UnresolvedAgent {
  readonly stage: StageName;
  readonly agentName: string;
  readonly capability: string;
}

/**
 * Result of projecting a RoutingResult onto the dispatch layer. The
 * `unresolved` list is the ADR-PIPELINE-087 §4 signal: agents the graph
 * selected but the resolver could not map. An empty array is the healthy state.
 */
export interface DispatchProjection {
  readonly refs: readonly DomainAgentRef[];
  readonly unresolved: readonly UnresolvedAgent[];
}

/**
 * Convert a routing result into a flat list of domain/agent pairs
 * ready for dispatch via the existing executeAgentsInvokeCommand, along with
 * the list of agents that failed to resolve.
 *
 * ADR-PIPELINE-087 §4: unresolved agents are logged at WARN (stderr) and
 * returned to the caller so they can be surfaced in the JSON envelope
 * (`routing.unresolved`) and in the MCP tool response.
 */
export function projectDispatch(result: RoutingResult): DispatchProjection {
  const refs: DomainAgentRef[] = [];
  const unresolved: UnresolvedAgent[] = [];
  const seen = new Set<string>();

  for (const group of result.pipeline) {
    for (const agent of group.agents) {
      const ref = resolveAgentRef(agent.agentName);
      if (ref) {
        const key = `${ref.domain}/${ref.agent}`;
        if (!seen.has(key)) {
          seen.add(key);
          refs.push(ref);
        }
      } else {
        // ADR-PIPELINE-087 §4: emit a visible signal on every unresolved
        // agent. Prior behaviour silently dropped these, which let
        // ADR-PIPELINE-080..086 regress dispatch without any on-console or
        // on-disk evidence.
        console.error(
          `[routing] unresolved agent name "${agent.agentName}" in stage "${group.stage}" (capability "${agent.capability}") — skipping dispatch (ADR-PIPELINE-087 §4)`,
        );
        unresolved.push({
          stage: group.stage,
          agentName: agent.agentName,
          capability: agent.capability,
        });
      }
    }
  }

  return { refs, unresolved };
}

/**
 * Convert a routing result into a flat list of domain/agent pairs
 * ready for dispatch via the existing executeAgentsInvokeCommand.
 *
 * Agents that cannot be mapped are logged and skipped. Prefer
 * {@link projectDispatch} when the caller needs the unresolved list.
 */
export function toDomainAgentList(result: RoutingResult): DomainAgentRef[] {
  return [...projectDispatch(result).refs];
}
