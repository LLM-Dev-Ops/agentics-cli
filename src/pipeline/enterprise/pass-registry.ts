/**
 * Pass Registry — Agent Configurations for Each Pipeline Pass (ADR-032)
 *
 * Defines which agents run in each of the 7 enterprise pipeline passes.
 * Agent references map to the existing 27 agent domains in agents.ts.
 *
 * This registry is the single source of truth for pass→agent mapping.
 */

import type { PassAgentConfig, PassNumber, AgentRef } from './types.js';

// ============================================================================
// Agent Reference Helpers
// ============================================================================

function ref(domain: string, agent: string, role: string): AgentRef {
  return { domain, agent, role };
}

// ============================================================================
// Pass Configurations
// ============================================================================

export const ENTERPRISE_PASS_CONFIGS: Readonly<Record<PassNumber, PassAgentConfig>> = {

  // --------------------------------------------------------------------------
  // Pass 1 — Problem Intelligence
  // --------------------------------------------------------------------------
  1: {
    pass: 1,
    passName: 'problem-intelligence',
    label: 'Problem Intelligence',
    description: 'Understand the problem, decompose it, build a structured execution plan.',
    memoryNamespace: 'pass1-intelligence',
    hasApprovalGate: false,
    agenticsServices: [
      // CoPilot agents
      ref('copilot', 'planner', 'Execution planner'),
      ref('copilot', 'decomposer', 'Problem decomposer'),
      ref('copilot', 'clarifier', 'Objective clarifier'),
      ref('copilot', 'intent', 'Intent classifier'),
      ref('copilot', 'meta-reasoner', 'Meta-reasoner'),
      // Memory-Graph agents
      ref('memory-graph', 'conversation', 'Conversation memory'),
      ref('memory-graph', 'lineage', 'Prompt lineage'),
      ref('memory-graph', 'decisions', 'Decision memory'),
      ref('memory-graph', 'knowledge-graph', 'Knowledge graph builder'),
    ],
  },

  // --------------------------------------------------------------------------
  // Pass 2 — Simulation & Scenario Modeling
  // --------------------------------------------------------------------------
  2: {
    pass: 2,
    passName: 'simulation-scenario',
    label: 'Simulation & Scenario Modeling',
    description: 'Generate deployment, failure, scaling, integration scenarios; assess operational risk and model reliability.',
    memoryNamespace: 'pass2-simulation',
    hasApprovalGate: true,
    agenticsServices: [
      // Workstream A: Scenario Generation (LLM-Simulator)
      ref('simulator', 'what-if', 'What-if simulation'),
      ref('simulator', 'scenario', 'Scenario generator'),
      // Workstream B: Risk Signal Detection (LLM-Sentinel)
      ref('sentinel', 'anomaly', 'Anomaly detection'),
      ref('sentinel', 'drift', 'Drift detection'),
      ref('sentinel', 'correlation', 'Incident correlation'),
      ref('sentinel', 'rca', 'Root cause analysis'),
      // Workstream C: Model Reliability (LLM-Test-Bench)
      ref('test-bench', 'hallucination', 'Hallucination detection'),
      ref('test-bench', 'faithfulness', 'Faithfulness verification'),
      ref('test-bench', 'bias', 'Bias detection'),
      ref('test-bench', 'stress', 'Stress testing'),
      ref('test-bench', 'red-team', 'Red team testing'),
      ref('test-bench', 'adversarial', 'Adversarial prompt testing'),
    ],
  },

  // --------------------------------------------------------------------------
  // Pass 3 — Architecture & Prototype Generation
  // --------------------------------------------------------------------------
  3: {
    pass: 3,
    passName: 'architecture-prototype',
    label: 'Architecture & Prototype Generation',
    description: 'Produce SPARC specs, ADRs, DDD artifacts, TDD outputs, executable prototypes, SDK interfaces, integration layers.',
    memoryNamespace: 'pass3-architecture',
    hasApprovalGate: true,
    agenticsServices: [
      // Orchestrator agents
      ref('orchestrator', 'workflow', 'Workflow orchestrator'),
      ref('orchestrator', 'scheduler', 'Task scheduler'),
      ref('orchestrator', 'dependencies', 'Dependency resolver'),
      ref('orchestrator', 'retry', 'Retry & recovery'),
      ref('orchestrator', 'parallel', 'Parallelisation'),
      ref('orchestrator', 'state-machine', 'State machine'),
      ref('orchestrator', 'swarm', 'Swarm coordinator'),
      // Forge agents
      ref('forge', 'sdk', 'SDK generator'),
      ref('forge', 'cli', 'CLI generator'),
      ref('forge', 'api-translation', 'API translation'),
      ref('forge', 'version-compat', 'Version compatibility'),
      // Connector-Hub agents
      ref('connector-hub', 'erp-surface', 'ERP surface mapper'),
      ref('connector-hub', 'database-query', 'Database query generator'),
      ref('connector-hub', 'webhook-ingest', 'Webhook listener'),
      ref('connector-hub', 'event-normalize', 'Event normaliser'),
      ref('connector-hub', 'auth-identity', 'Auth / identity'),
    ],
  },

  // --------------------------------------------------------------------------
  // Pass 4 — Governance, Compliance & CostOps
  // --------------------------------------------------------------------------
  4: {
    pass: 4,
    passName: 'governance-compliance-costops',
    label: 'Governance, Compliance & CostOps',
    description: 'Security analysis, policy compliance, financial modeling, governance readiness.',
    memoryNamespace: 'pass4-governance',
    hasApprovalGate: true,
    agenticsServices: [
      // Workstream A: Security & Compliance (LLM-Shield)
      ref('shield', 'prompt-injection', 'Prompt injection detection'),
      ref('shield', 'pii', 'PII detection'),
      ref('shield', 'redaction', 'Data redaction'),
      ref('shield', 'secrets', 'Secrets leakage detection'),
      ref('shield', 'toxicity', 'Toxicity detection'),
      ref('shield', 'safety-boundary', 'Safety boundary enforcement'),
      ref('shield', 'moderation', 'Content moderation'),
      ref('shield', 'abuse', 'Model abuse detection'),
      ref('shield', 'credential-exposure', 'Credential exposure detection'),
      // Workstream B: Policy Enforcement (LLM-Policy-Engine)
      ref('policy-engine', 'enforce', 'Policy enforcement'),
      ref('policy-engine', 'constraints', 'Constraint solver'),
      ref('policy-engine', 'approval', 'Approval routing'),
      // Workstream C: Financial Modeling (LLM-CostOps)
      ref('costops', 'attribution', 'Cost attribution'),
      ref('costops', 'forecast', 'Cost forecasting'),
      ref('costops', 'budget', 'Budget enforcement'),
      ref('costops', 'roi', 'ROI estimation'),
      ref('costops', 'tradeoff', 'Cost-performance tradeoff'),
      // Workstream D: Governance Visibility (LLM-Governance-Dashboard)
      ref('governance-dashboard', 'audit', 'Governance audit'),
      ref('governance-dashboard', 'impact', 'Change impact'),
      ref('governance-dashboard', 'oversight', 'Usage oversight'),
    ],
  },

  // --------------------------------------------------------------------------
  // Pass 5 — Decision Artifacts
  // --------------------------------------------------------------------------
  5: {
    pass: 5,
    passName: 'decision-artifacts',
    label: 'Decision Artifacts',
    description: 'Generate the 15 deterministic enterprise artifacts — executive memos, risk assessment, CostOps, OKRs, RAID log, provenance manifest.',
    memoryNamespace: 'pass5-decisions',
    hasApprovalGate: true,
    agenticsServices: [
      // Apex Decision Layer
      ref('platform', 'decision', 'Decision agent'),
      ref('platform', 'executive-summary', 'Executive summary agent'),
      ref('platform', 'decision-memo', 'Decision memo agent'),
      ref('platform', 'risk-score', 'Risk scoring agent'),
      // Analytics & Research (for KPIs, metrics, recommendations)
      ref('analytics-hub', 'recommendation', 'Recommendation report'),
      ref('research-lab', 'metrics', 'KPI & metrics analyst'),
    ],
  },

  // --------------------------------------------------------------------------
  // Pass 6 — ERP Prototype Deployment
  // --------------------------------------------------------------------------
  6: {
    pass: 6,
    passName: 'erp-deployment',
    label: 'ERP Prototype Deployment',
    description: 'Deploy the generated prototype to the target ERP/infrastructure environment.',
    memoryNamespace: 'pass6-deployment',
    hasApprovalGate: false,
    agenticsServices: [
      ref('connector-hub', 'erp-surface', 'ERP integration agent'),
      ref('connector-hub', 'auth-identity', 'Auth configurator'),
      ref('forge', 'sdk', 'Deployment SDK generator'),
      ref('platform', 'risk-score', 'Deployment risk scorer'),
    ],
  },

  // --------------------------------------------------------------------------
  // Pass 7 — Observability & Continuous Learning
  // --------------------------------------------------------------------------
  7: {
    pass: 7,
    passName: 'observability-learning',
    label: 'Observability & Continuous Learning',
    description: 'Monitor deployed prototype, collect telemetry, handle incidents, learn from outcomes.',
    memoryNamespace: 'pass7-observability',
    hasApprovalGate: false,
    agenticsServices: [
      // Observatory
      ref('observatory', 'telemetry', 'Telemetry collector'),
      ref('observatory', 'usage-patterns', 'Usage pattern analyser'),
      ref('observatory', 'failures', 'Failure classifier'),
      ref('observatory', 'health-check', 'Health check'),
      ref('observatory', 'slo', 'SLA enforcement'),
      ref('observatory', 'visualization', 'Visualisation spec generator'),
      // Latency-Lens
      ref('latency-lens', 'latency', 'Latency analysis'),
      ref('latency-lens', 'cold-start', 'Cold start mitigation'),
      // Incident-Manager
      ref('incident-manager', 'escalation', 'Incident escalation'),
      ref('incident-manager', 'post-mortem', 'Post-mortem generator'),
      ref('incident-manager', 'hitl', 'Human-in-the-loop'),
      // Learning Loop (Memory-Graph serves as RuVector proxy)
      ref('memory-graph', 'patterns', 'Approval learning'),
      ref('memory-graph', 'retrieval', 'Feedback assimilation'),
    ],
  },
};

// ============================================================================
// Lookup Helpers
// ============================================================================

/** Get agent config for a specific pass. */
export function getPassConfig(pass: PassNumber): PassAgentConfig {
  return ENTERPRISE_PASS_CONFIGS[pass];
}

/** Get all pass configs as an ordered array. */
export function getAllPassConfigs(): readonly PassAgentConfig[] {
  return [1, 2, 3, 4, 5, 6, 7].map(p => ENTERPRISE_PASS_CONFIGS[p as PassNumber]);
}

/** Get total agent count across all passes (with deduplication). */
export function getTotalUniqueAgents(): number {
  const seen = new Set<string>();
  for (const config of Object.values(ENTERPRISE_PASS_CONFIGS)) {
    for (const svc of config.agenticsServices) {
      seen.add(`${svc.domain}/${svc.agent}`);
    }
  }
  return seen.size;
}

/** Get all unique agents across all passes. */
export function getAllUniqueAgents(): readonly AgentRef[] {
  const seen = new Map<string, AgentRef>();
  for (const config of Object.values(ENTERPRISE_PASS_CONFIGS)) {
    for (const svc of config.agenticsServices) {
      const key = `${svc.domain}/${svc.agent}`;
      if (!seen.has(key)) {
        seen.set(key, svc);
      }
    }
  }
  return Array.from(seen.values());
}
