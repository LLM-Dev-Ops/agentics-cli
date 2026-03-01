/**
 * Swarm Orchestrator — Ruflo + Agentics Platform Integration
 *
 * Coordinates Ruflo swarm agents with Agentics platform services:
 *   1. Ensures Ruflo (claude-flow) is installed as a first-class dependency
 *   2. Initializes hierarchical swarm with anti-drift config
 *   3. Dispatches swarm agents + agentics platform agents per phase
 *   4. Stores all results in swarm memory for cross-phase coordination
 *   5. Runs quality/security reviews using agentics agents after each phase
 *
 * Ruflo swarm coordinates. Agentics agents do real work.
 * Together they form a team that produces enterprise-grade artifacts.
 */

import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { executeAgentsInvokeCommand } from '../commands/agents.js';
import type { AgentsInvokeResult } from '../commands/agents.js';
import type { CommandOptions } from '../types/index.js';

// ============================================================================
// Types
// ============================================================================

export interface SwarmConfig {
  readonly topology: 'hierarchical' | 'hierarchical-mesh' | 'mesh';
  readonly maxAgents: number;
  readonly strategy: 'specialized' | 'balanced';
  readonly traceId: string;
  readonly runDir: string;
}

export interface PhaseAgent {
  readonly role: string;
  readonly type: string;
  readonly description: string;
}

/** Agentics platform service invocation for a pipeline phase. */
export interface AgenticsServiceCall {
  readonly domain: string;
  readonly agent: string;
  readonly role: string; // human-readable role in the team
}

export interface SwarmPhaseConfig {
  readonly phase: number;
  readonly label: string;
  readonly agents: PhaseAgent[];
  readonly agenticsServices: AgenticsServiceCall[];
  readonly memoryNamespace: string;
}

export interface AgenticsServiceResult {
  readonly domain: string;
  readonly agent: string;
  readonly role: string;
  readonly status: number;
  readonly response: unknown;
  readonly timing: number;
}

export interface SwarmStatus {
  readonly initialized: boolean;
  readonly available: boolean;
  readonly agentCount: number;
  readonly agenticsServicesInvoked: number;
  readonly tasksCompleted: number;
  readonly memoryEntries: number;
}

// ============================================================================
// Phase Agent + Agentics Service Configurations
// ============================================================================

/**
 * Agent teams dispatched per pipeline phase.
 *
 * Each phase has:
 *   - `agents`: Ruflo swarm agents (coordination, spawned via claude-flow CLI)
 *   - `agenticsServices`: Agentics platform agents (real work, invoked via agentics CLI)
 *
 * The swarm agents coordinate; the agentics agents analyze, validate, and enrich.
 */
export const PHASE_AGENTS: Record<number, SwarmPhaseConfig> = {
  2: {
    phase: 2,
    label: 'Deep Research',
    memoryNamespace: 'phase2-research',
    agents: [
      { role: 'coordinator', type: 'planner', description: 'Coordinate deep research extraction from simulation artifacts' },
      { role: 'researcher', type: 'researcher', description: 'Extract and synthesize knowledge from Phase 1 artifacts' },
      { role: 'analyst', type: 'analyst', description: 'Cross-reference dossier items and identify gaps' },
    ],
    agenticsServices: [
      { domain: 'copilot', agent: 'planner', role: 'Research planner' },
      { domain: 'copilot', agent: 'decomposer', role: 'Requirements decomposer' },
      { domain: 'research-lab', agent: 'hypothesis', role: 'Research hypotheses' },
      { domain: 'memory-graph', agent: 'knowledge-graph', role: 'Knowledge graph builder' },
    ],
  },
  3: {
    phase: 3,
    label: 'SPARC + London TDD',
    memoryNamespace: 'phase3-sparc',
    agents: [
      { role: 'coordinator', type: 'sparc-coord', description: 'Orchestrate SPARC methodology phases' },
      { role: 'specification', type: 'specification', description: 'Generate SPARC specification from research dossier' },
      { role: 'pseudocode', type: 'pseudocode', description: 'Design algorithms and pseudocode from specification' },
      { role: 'architect', type: 'architecture', description: 'Design microservice architecture from pseudocode' },
      { role: 'tester', type: 'tester', description: 'Generate London School TDD plan with mock contracts' },
    ],
    agenticsServices: [
      { domain: 'copilot', agent: 'decomposer', role: 'Spec decomposer' },
      { domain: 'copilot', agent: 'meta-reasoner', role: 'Architecture reasoner' },
      { domain: 'test-bench', agent: 'quality', role: 'Spec quality evaluator' },
      { domain: 'schema-registry', agent: 'validate', role: 'Schema validator' },
    ],
  },
  4: {
    phase: 4,
    label: 'ADRs + DDDs',
    memoryNamespace: 'phase4-adrs',
    agents: [
      { role: 'coordinator', type: 'planner', description: 'Coordinate ADR and DDD generation' },
      { role: 'adr-writer', type: 'system-architect', description: 'Generate Architecture Decision Records from SPARC output' },
      { role: 'ddd-modeler', type: 'system-architect', description: 'Generate DDD bounded contexts, aggregates, and domain events' },
      { role: 'reviewer', type: 'reviewer', description: 'Review ADRs and DDD model for consistency and completeness' },
    ],
    agenticsServices: [
      { domain: 'governance-dashboard', agent: 'audit', role: 'Architecture auditor' },
      { domain: 'governance-dashboard', agent: 'impact', role: 'Impact analyst' },
      { domain: 'copilot', agent: 'reflection', role: 'Decision reflector' },
      { domain: 'platform', agent: 'risk-score', role: 'Architecture risk scorer' },
    ],
  },
  5: {
    phase: 5,
    label: 'Build (Code Generation)',
    memoryNamespace: 'phase5-build',
    agents: [
      { role: 'coordinator', type: 'planner', description: 'Coordinate code generation and integration' },
      { role: 'coder', type: 'coder', description: 'Generate domain code from ADRs and DDD model' },
      { role: 'test-writer', type: 'tester', description: 'Generate test files from TDD plan' },
      { role: 'integration', type: 'backend-dev', description: 'Infer and inject integration dependencies' },
      { role: 'reviewer', type: 'reviewer', description: 'Review generated code for quality and completeness' },
    ],
    agenticsServices: [
      { domain: 'shield', agent: 'secrets', role: 'Secrets scanner' },
      { domain: 'shield', agent: 'pii', role: 'PII detector' },
      { domain: 'test-bench', agent: 'quality', role: 'Code quality evaluator' },
      { domain: 'config-manager', agent: 'validate', role: 'Config validator' },
      { domain: 'copilot', agent: 'reflection', role: 'Code review reflector' },
    ],
  },
  6: {
    phase: 6,
    label: 'ERP Surface Push',
    memoryNamespace: 'phase6-deploy',
    agents: [
      { role: 'coordinator', type: 'planner', description: 'Coordinate deployment and ERP registration' },
      { role: 'deployer', type: 'backend-dev', description: 'Generate deployment configurations and scripts' },
    ],
    agenticsServices: [
      { domain: 'connector-hub', agent: 'erp-surface', role: 'ERP surface mapper' },
      { domain: 'connector-hub', agent: 'auth-identity', role: 'Auth configurator' },
      { domain: 'platform', agent: 'risk-score', role: 'Deployment risk scorer' },
    ],
  },
};

// ============================================================================
// Contextual Agent Triggers — Dynamic Agentics Agent Selection
// ============================================================================

/**
 * Keyword-to-agent mapping for dynamic dispatch. When scenario text or phase
 * artifacts contain these keywords, the corresponding agentics agents are added
 * to the phase dispatch alongside the fixed defaults.
 *
 * This ensures the full breadth of the platform is leveraged contextually.
 */
interface ContextualTrigger {
  readonly keywords: string[];
  readonly agents: AgenticsServiceCall[];
  /** Only dispatch for these phases (empty = all phases) */
  readonly phases?: number[];
}

const CONTEXTUAL_TRIGGERS: ContextualTrigger[] = [

  // ═══════════════════════════════════════════════════════════════════════════
  // ENTERPRISE SYSTEMS & DATA
  // ═══════════════════════════════════════════════════════════════════════════

  // ── ERP / SAP ──
  {
    keywords: ['sap', 's4hana', 's/4hana', 'erp', 'abap', 'bapi', 'idoc', 'odata', 'fiori', 'hana'],
    agents: [
      { domain: 'connector-hub', agent: 'erp-surface', role: 'ERP surface mapper' },
      { domain: 'connector-hub', agent: 'database-query', role: 'ERP data querier' },
      { domain: 'connector-hub', agent: 'auth-identity', role: 'ERP auth connector' },
    ],
  },
  // ── Databases & Data Stores ──
  {
    keywords: ['database', 'postgres', 'mysql', 'mongodb', 'redis', 'elasticsearch', 'dynamodb', 'bigquery', 'sql', 'nosql', 'data warehouse', 'data lake'],
    agents: [
      { domain: 'connector-hub', agent: 'database-query', role: 'Database architect' },
      { domain: 'schema-registry', agent: 'validate', role: 'Schema validator' },
    ],
  },
  // ── Data Pipelines / ETL ──
  {
    keywords: ['etl', 'data pipeline', 'data ingestion', 'data transform', 'data migration', 'data sync', 'cdc', 'change data capture'],
    agents: [
      { domain: 'connector-hub', agent: 'event-normalize', role: 'Data normalizer' },
      { domain: 'orchestrator', agent: 'workflow', role: 'Pipeline orchestrator' },
      { domain: 'orchestrator', agent: 'dependencies', role: 'Pipeline dependency resolver' },
      { domain: 'connector-hub', agent: 'database-query', role: 'Data source connector' },
    ],
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // SECURITY & COMPLIANCE
  // ═══════════════════════════════════════════════════════════════════════════

  // ── Security (full shield suite) ──
  {
    keywords: ['security', 'vulnerability', 'encryption', 'zero-trust', 'penetration', 'attack surface', 'threat model'],
    agents: [
      { domain: 'shield', agent: 'prompt-injection', role: 'Injection scanner' },
      { domain: 'shield', agent: 'credential-exposure', role: 'Credential scanner' },
      { domain: 'shield', agent: 'secrets', role: 'Secrets detector' },
      { domain: 'shield', agent: 'safety-boundary', role: 'Safety boundary enforcer' },
    ],
  },
  // ── Compliance / Regulatory ──
  {
    keywords: ['compliance', 'gdpr', 'hipaa', 'sox', 'pci', 'pci-dss', 'iso 27001', 'fedramp', 'nist', 'regulatory', 'audit trail'],
    agents: [
      { domain: 'governance-dashboard', agent: 'audit', role: 'Compliance auditor' },
      { domain: 'governance-dashboard', agent: 'oversight', role: 'Governance oversight' },
      { domain: 'policy-engine', agent: 'enforce', role: 'Policy enforcer' },
      { domain: 'policy-engine', agent: 'constraints', role: 'Constraint validator' },
      { domain: 'data-vault', agent: 'access-control', role: 'Access control validator' },
    ],
  },
  // ── Content Moderation / Safety ──
  {
    keywords: ['moderation', 'toxic', 'harmful', 'content safety', 'abuse', 'spam', 'hate speech', 'content filter'],
    agents: [
      { domain: 'shield', agent: 'toxicity', role: 'Toxicity scanner' },
      { domain: 'shield', agent: 'moderation', role: 'Content moderator' },
      { domain: 'shield', agent: 'abuse', role: 'Abuse detector' },
      { domain: 'shield', agent: 'safety-boundary', role: 'Safety boundary enforcer' },
      { domain: 'policy-engine', agent: 'enforce', role: 'Content policy enforcer' },
    ],
  },
  // ── Data Protection / Privacy ──
  {
    keywords: ['pii', 'anonymize', 'de-identify', 'data protection', 'privacy', 'redaction', 'data masking', 'consent'],
    agents: [
      { domain: 'data-vault', agent: 'anonymize', role: 'Data anonymizer' },
      { domain: 'shield', agent: 'pii', role: 'PII scanner' },
      { domain: 'shield', agent: 'redaction', role: 'Redaction engine' },
      { domain: 'data-vault', agent: 'access-control', role: 'Access control designer' },
    ],
  },
  // ── Approval & Policy Workflows ──
  {
    keywords: ['approval workflow', 'approval gate', 'policy approval', 'change management', 'change control'],
    agents: [
      { domain: 'policy-engine', agent: 'approval', role: 'Approval workflow designer' },
      { domain: 'policy-engine', agent: 'constraints', role: 'Constraint definer' },
      { domain: 'governance-dashboard', agent: 'oversight', role: 'Change oversight' },
    ],
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // COST & OPTIMIZATION
  // ═══════════════════════════════════════════════════════════════════════════

  // ── Cost / FinOps ──
  {
    keywords: ['cost', 'budget', 'roi', 'spending', 'finops', 'billing', 'pricing', 'total cost of ownership', 'tco'],
    agents: [
      { domain: 'costops', agent: 'attribution', role: 'Cost attribution analyst' },
      { domain: 'costops', agent: 'roi', role: 'ROI calculator' },
      { domain: 'costops', agent: 'tradeoff', role: 'Cost-quality tradeoff analyst' },
      { domain: 'costops', agent: 'forecast', role: 'Cost forecaster' },
      { domain: 'costops', agent: 'budget', role: 'Budget planner' },
    ],
  },
  // ── Token / Prompt Optimization ──
  {
    keywords: ['token', 'prompt optimization', 'context window', 'token usage', 'prompt engineering', 'token cost'],
    agents: [
      { domain: 'auto-optimizer', agent: 'token', role: 'Token optimizer' },
      { domain: 'auto-optimizer', agent: 'model-select', role: 'Model selector' },
      { domain: 'costops', agent: 'tradeoff', role: 'Token cost tradeoff' },
    ],
  },
  // ── Full System Optimization ──
  {
    keywords: ['optimize', 'optimization', 'efficiency', 'reduce cost', 'improve performance'],
    agents: [
      { domain: 'auto-optimizer', agent: 'self-optimize', role: 'System self-optimizer' },
      { domain: 'costops', agent: 'tradeoff', role: 'Optimization tradeoff analyst' },
    ],
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // PERFORMANCE & RELIABILITY
  // ═══════════════════════════════════════════════════════════════════════════

  // ── Performance / Latency ──
  {
    keywords: ['performance', 'latency', 'p99', 'p95', 'throughput', 'scalability', 'scale', 'high-volume', 'response time'],
    agents: [
      { domain: 'latency-lens', agent: 'latency', role: 'Latency profiler' },
      { domain: 'latency-lens', agent: 'cold-start', role: 'Cold start optimizer' },
      { domain: 'auto-optimizer', agent: 'self-optimize', role: 'Performance optimizer' },
    ],
  },
  // ── Resilience / Fault Tolerance ──
  {
    keywords: ['resilience', 'fault-tolerance', 'circuit breaker', 'failover', 'retry', 'backoff', 'dead letter', 'timeout handling', 'graceful degradation'],
    agents: [
      { domain: 'edge', agent: 'circuit-breaker', role: 'Circuit breaker designer' },
      { domain: 'edge', agent: 'failover', role: 'Failover architect' },
      { domain: 'edge', agent: 'execution-guard', role: 'Execution guard' },
      { domain: 'orchestrator', agent: 'retry', role: 'Retry strategy designer' },
    ],
  },
  // ── Caching / Edge ──
  {
    keywords: ['cache', 'caching', 'cdn', 'edge computing', 'memoize', 'invalidation', 'ttl'],
    agents: [
      { domain: 'edge', agent: 'caching', role: 'Cache architect' },
      { domain: 'edge', agent: 'execution-guard', role: 'Cache guard' },
      { domain: 'latency-lens', agent: 'latency', role: 'Cache latency profiler' },
    ],
  },
  // ── Incident / Outage Response ──
  {
    keywords: ['incident', 'outage', 'downtime', 'service down', 'production issue', 'on-call', 'pager'],
    agents: [
      { domain: 'incident-manager', agent: 'escalation', role: 'Incident escalation planner' },
      { domain: 'incident-manager', agent: 'post-mortem', role: 'Post-mortem writer' },
      { domain: 'incident-manager', agent: 'hitl', role: 'Human-in-the-loop coordinator' },
      { domain: 'sentinel', agent: 'rca', role: 'Root cause analyst' },
      { domain: 'observatory', agent: 'failures', role: 'Failure analyst' },
    ],
  },
  // ── SLA / SLO ──
  {
    keywords: ['sla', 'slo', 'sli', 'uptime', 'availability', 'nine', '99.9', 'error budget'],
    agents: [
      { domain: 'observatory', agent: 'slo', role: 'SLO designer' },
      { domain: 'observatory', agent: 'health-check', role: 'Health check architect' },
      { domain: 'sentinel', agent: 'alert', role: 'SLA alert designer' },
      { domain: 'incident-manager', agent: 'escalation', role: 'SLA breach escalation' },
    ],
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // MONITORING & OBSERVABILITY
  // ═══════════════════════════════════════════════════════════════════════════

  // ── Full Observability Stack ──
  {
    keywords: ['monitoring', 'observability', 'telemetry', 'tracing', 'logging', 'metrics', 'opentelemetry', 'prometheus', 'grafana', 'datadog'],
    agents: [
      { domain: 'observatory', agent: 'telemetry', role: 'Telemetry designer' },
      { domain: 'observatory', agent: 'health-check', role: 'Health check architect' },
      { domain: 'observatory', agent: 'slo', role: 'SLO designer' },
      { domain: 'observatory', agent: 'visualization', role: 'Dashboard designer' },
      { domain: 'observatory', agent: 'usage-patterns', role: 'Usage pattern analyst' },
    ],
  },
  // ── Alerting / Notification ──
  {
    keywords: ['alerting', 'alert rule', 'notification', 'pagerduty', 'opsgenie', 'on-call'],
    agents: [
      { domain: 'sentinel', agent: 'alert', role: 'Alert rule designer' },
      { domain: 'sentinel', agent: 'correlation', role: 'Alert correlator' },
      { domain: 'observatory', agent: 'telemetry', role: 'Alert telemetry source' },
    ],
  },
  // ── Anomaly / Drift Detection ──
  {
    keywords: ['anomaly', 'drift', 'outlier', 'fraud', 'leakage', 'deviation', 'unexpected behavior', 'model drift'],
    agents: [
      { domain: 'sentinel', agent: 'anomaly', role: 'Anomaly detector' },
      { domain: 'sentinel', agent: 'drift', role: 'Drift detector' },
      { domain: 'sentinel', agent: 'correlation', role: 'Event correlator' },
      { domain: 'sentinel', agent: 'rca', role: 'Root cause analyst' },
    ],
  },
  // ── Post-Mortem / Root Cause ──
  {
    keywords: ['post-mortem', 'root cause', 'lessons learned', 'blameless', 'failure analysis', 'why did it fail'],
    agents: [
      { domain: 'incident-manager', agent: 'post-mortem', role: 'Post-mortem writer' },
      { domain: 'sentinel', agent: 'rca', role: 'Root cause analyst' },
      { domain: 'observatory', agent: 'failures', role: 'Failure pattern analyst' },
      { domain: 'observatory', agent: 'post-mortem', role: 'Post-mortem data provider' },
      { domain: 'memory-graph', agent: 'lineage', role: 'Decision lineage tracer' },
    ],
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // AUTH & IDENTITY
  // ═══════════════════════════════════════════════════════════════════════════

  {
    keywords: ['oauth', 'sso', 'authentication', 'authorization', 'identity', 'jwt', 'saml', 'oidc', 'rbac', 'abac', 'multi-tenant', 'tenant'],
    agents: [
      { domain: 'connector-hub', agent: 'auth-identity', role: 'Auth architect' },
      { domain: 'data-vault', agent: 'access-control', role: 'Access control designer' },
      { domain: 'policy-engine', agent: 'enforce', role: 'Auth policy enforcer' },
    ],
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // EVENT-DRIVEN & INTEGRATION
  // ═══════════════════════════════════════════════════════════════════════════

  // ── Webhooks / Event-Driven ──
  {
    keywords: ['webhook', 'event-driven', 'pubsub', 'kafka', 'rabbitmq', 'message queue', 'event sourcing', 'cqrs', 'nats', 'sqs', 'sns'],
    agents: [
      { domain: 'connector-hub', agent: 'webhook-ingest', role: 'Webhook architect' },
      { domain: 'connector-hub', agent: 'event-normalize', role: 'Event normalizer' },
      { domain: 'orchestrator', agent: 'workflow', role: 'Event workflow orchestrator' },
      { domain: 'orchestrator', agent: 'state-machine', role: 'Event state machine designer' },
    ],
  },
  // ── Tool / Function Invocation ──
  {
    keywords: ['tool calling', 'function calling', 'tool use', 'tool invocation', 'mcp', 'plugin'],
    agents: [
      { domain: 'edge', agent: 'tool-invoke', role: 'Tool invocation architect' },
      { domain: 'edge', agent: 'execution-guard', role: 'Tool execution guard' },
      { domain: 'edge', agent: 'circuit-breaker', role: 'Tool circuit breaker' },
    ],
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // ML / AI / LLM
  // ═══════════════════════════════════════════════════════════════════════════

  // ── ML / AI Models ──
  {
    keywords: ['machine learning', 'ml model', 'inference', 'prediction', 'neural', 'deep learning', 'training', 'fine-tuning', 'fine tuning'],
    agents: [
      { domain: 'inference-gateway', agent: 'route', role: 'Inference router' },
      { domain: 'auto-optimizer', agent: 'model-select', role: 'Model selector' },
      { domain: 'sentinel', agent: 'drift', role: 'Model drift detector' },
      { domain: 'test-bench', agent: 'benchmark', role: 'Model benchmark runner' },
    ],
  },
  // ── LLM / Chatbot / Agent ──
  {
    keywords: ['llm', 'chatbot', 'conversational', 'ai agent', 'ai assistant', 'prompt', 'large language model', 'generative ai', 'gen ai'],
    agents: [
      { domain: 'auto-optimizer', agent: 'token', role: 'Token optimizer' },
      { domain: 'auto-optimizer', agent: 'model-select', role: 'LLM model selector' },
      { domain: 'shield', agent: 'prompt-injection', role: 'Prompt injection shield' },
      { domain: 'test-bench', agent: 'hallucination', role: 'Hallucination detector' },
      { domain: 'test-bench', agent: 'faithfulness', role: 'Faithfulness evaluator' },
      { domain: 'inference-gateway', agent: 'route', role: 'Inference router' },
    ],
  },
  // ── AI Quality / Evaluation ──
  {
    keywords: ['hallucination', 'faithfulness', 'bias', 'fairness', 'ai quality', 'model evaluation', 'eval', 'benchmark'],
    agents: [
      { domain: 'test-bench', agent: 'hallucination', role: 'Hallucination detector' },
      { domain: 'test-bench', agent: 'faithfulness', role: 'Faithfulness evaluator' },
      { domain: 'test-bench', agent: 'bias', role: 'Bias detector' },
      { domain: 'test-bench', agent: 'consistency', role: 'Consistency checker' },
      { domain: 'test-bench', agent: 'quality', role: 'Quality evaluator' },
    ],
  },
  // ── Red Team / Adversarial ──
  {
    keywords: ['red team', 'adversarial', 'jailbreak', 'prompt attack', 'stress test', 'robustness'],
    agents: [
      { domain: 'test-bench', agent: 'red-team', role: 'Red team exerciser' },
      { domain: 'test-bench', agent: 'adversarial', role: 'Adversarial tester' },
      { domain: 'test-bench', agent: 'stress', role: 'Stress tester' },
      { domain: 'shield', agent: 'prompt-injection', role: 'Injection defense tester' },
      { domain: 'shield', agent: 'safety-boundary', role: 'Safety boundary tester' },
    ],
  },
  // ── Synthetic Data / Golden Dataset ──
  {
    keywords: ['synthetic data', 'golden dataset', 'test data', 'data generation', 'mock data', 'fixture', 'seed data'],
    agents: [
      { domain: 'test-bench', agent: 'synthetic-data', role: 'Synthetic data generator' },
      { domain: 'test-bench', agent: 'golden-dataset', role: 'Golden dataset builder' },
    ],
  },
  // ── Model Comparison / Migration ──
  {
    keywords: ['model comparison', 'compare model', 'switch model', 'model migration', 'model swap', 'a/b test'],
    agents: [
      { domain: 'test-bench', agent: 'compare', role: 'Model comparator' },
      { domain: 'test-bench', agent: 'regression', role: 'Regression tester' },
      { domain: 'simulator', agent: 'what-if', role: 'Model switch simulator' },
      { domain: 'costops', agent: 'tradeoff', role: 'Model cost tradeoff' },
    ],
  },
  // ── Prompt Sensitivity ──
  {
    keywords: ['prompt sensitivity', 'prompt robustness', 'prompt variation', 'prompt stability'],
    agents: [
      { domain: 'test-bench', agent: 'prompt-sensitivity', role: 'Prompt sensitivity tester' },
      { domain: 'test-bench', agent: 'consistency', role: 'Output consistency checker' },
    ],
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // WORKFLOW & ORCHESTRATION
  // ═══════════════════════════════════════════════════════════════════════════

  // ── Workflow / Orchestration ──
  {
    keywords: ['workflow', 'pipeline', 'orchestration', 'scheduler', 'cron', 'batch', 'dag', 'airflow', 'step function'],
    agents: [
      { domain: 'orchestrator', agent: 'workflow', role: 'Workflow planner' },
      { domain: 'orchestrator', agent: 'dependencies', role: 'Dependency resolver' },
      { domain: 'orchestrator', agent: 'scheduler', role: 'Scheduler' },
      { domain: 'orchestrator', agent: 'parallel', role: 'Parallel execution planner' },
    ],
  },
  // ── State Machine / Saga ──
  {
    keywords: ['state machine', 'saga', 'choreography', 'process manager', 'long-running', 'fsm'],
    agents: [
      { domain: 'orchestrator', agent: 'state-machine', role: 'State machine designer' },
      { domain: 'orchestrator', agent: 'workflow', role: 'Saga orchestrator' },
      { domain: 'orchestrator', agent: 'retry', role: 'Saga retry handler' },
    ],
  },
  // ── Swarm / Multi-Agent ──
  {
    keywords: ['swarm', 'multi-agent', 'agent coordination', 'agent fleet', 'autonomous agent', 'agent swarm'],
    agents: [
      { domain: 'orchestrator', agent: 'swarm', role: 'Swarm coordinator' },
      { domain: 'orchestrator', agent: 'parallel', role: 'Parallel agent executor' },
      { domain: 'registry', agent: 'index', role: 'Agent registry indexer' },
    ],
  },
  // ── Human-in-the-Loop ──
  {
    keywords: ['human-in-the-loop', 'hitl', 'manual review', 'approval gate', 'human review', 'manual approval'],
    agents: [
      { domain: 'incident-manager', agent: 'hitl', role: 'HITL coordinator' },
      { domain: 'policy-engine', agent: 'approval', role: 'Approval gate designer' },
      { domain: 'governance-dashboard', agent: 'oversight', role: 'Review oversight' },
    ],
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // RISK, DECISION, & SIMULATION
  // ═══════════════════════════════════════════════════════════════════════════

  // ── Risk / Decision Making ──
  {
    keywords: ['risk', 'risk assessment', 'decision', 'go/no-go', 'impact analysis', 'risk score', 'risk matrix'],
    agents: [
      { domain: 'platform', agent: 'risk-score', role: 'Risk scorer' },
      { domain: 'platform', agent: 'decision', role: 'Decision maker' },
      { domain: 'platform', agent: 'decision-memo', role: 'Decision memo writer' },
      { domain: 'simulator', agent: 'what-if', role: 'What-if simulator' },
      { domain: 'governance-dashboard', agent: 'impact', role: 'Impact analyst' },
    ],
  },
  // ── Simulation / Scenario Planning ──
  {
    keywords: ['simulation', 'scenario', 'what-if', 'forecast', 'projection', 'monte carlo', 'war game'],
    agents: [
      { domain: 'simulator', agent: 'scenario', role: 'Scenario planner' },
      { domain: 'simulator', agent: 'what-if', role: 'What-if simulator' },
      { domain: 'platform', agent: 'risk-score', role: 'Scenario risk scorer' },
      { domain: 'costops', agent: 'forecast', role: 'Cost forecaster' },
    ],
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // KNOWLEDGE & MEMORY
  // ═══════════════════════════════════════════════════════════════════════════

  // ── Knowledge Graph / RAG ──
  {
    keywords: ['knowledge graph', 'rag', 'retrieval augmented', 'embedding', 'vector search', 'semantic search'],
    agents: [
      { domain: 'memory-graph', agent: 'knowledge-graph', role: 'Knowledge graph architect' },
      { domain: 'memory-graph', agent: 'retrieval', role: 'Retrieval optimizer' },
      { domain: 'memory-graph', agent: 'patterns', role: 'Pattern learner' },
    ],
  },
  // ── Conversation / Context Memory ──
  {
    keywords: ['conversation history', 'context window', 'memory management', 'session', 'chat history', 'stateful'],
    agents: [
      { domain: 'memory-graph', agent: 'conversation', role: 'Conversation memory architect' },
      { domain: 'memory-graph', agent: 'retrieval', role: 'Context retrieval optimizer' },
    ],
  },
  // ── Decision Lineage / Audit Trail ──
  {
    keywords: ['decision trail', 'lineage', 'provenance', 'decision history', 'audit trail', 'trace decision'],
    agents: [
      { domain: 'memory-graph', agent: 'decisions', role: 'Decision tracker' },
      { domain: 'memory-graph', agent: 'lineage', role: 'Lineage tracer' },
      { domain: 'governance-dashboard', agent: 'audit', role: 'Decision auditor' },
    ],
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // API / SDK / DEVELOPER TOOLS
  // ═══════════════════════════════════════════════════════════════════════════

  // ── API / SDK Generation ──
  {
    keywords: ['api', 'sdk', 'swagger', 'openapi', 'graphql', 'rest', 'grpc', 'protobuf', 'api gateway'],
    agents: [
      { domain: 'forge', agent: 'sdk', role: 'SDK generator' },
      { domain: 'forge', agent: 'api-translation', role: 'API translator' },
      { domain: 'schema-registry', agent: 'validate', role: 'API schema validator' },
    ],
  },
  // ── CLI / Developer Tooling ──
  {
    keywords: ['cli tool', 'command line', 'developer tool', 'dev tool', 'scaffold', 'boilerplate', 'starter kit'],
    agents: [
      { domain: 'forge', agent: 'cli', role: 'CLI tool generator' },
      { domain: 'forge', agent: 'sdk', role: 'SDK scaffolder' },
      { domain: 'config-manager', agent: 'validate', role: 'Config validator' },
    ],
  },
  // ── Version Compatibility / Deprecation ──
  {
    keywords: ['version', 'backward compatible', 'deprecation', 'migration guide', 'breaking change', 'api version'],
    agents: [
      { domain: 'forge', agent: 'version-compat', role: 'Version compatibility checker' },
      { domain: 'marketplace', agent: 'deprecation', role: 'Deprecation advisor' },
      { domain: 'registry', agent: 'index', role: 'Registry version indexer' },
    ],
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // AGENT ECOSYSTEM
  // ═══════════════════════════════════════════════════════════════════════════

  // ── Agent Registry / Marketplace ──
  {
    keywords: ['agent registry', 'agent marketplace', 'agent catalog', 'agent discovery', 'agent reputation'],
    agents: [
      { domain: 'registry', agent: 'index', role: 'Agent index' },
      { domain: 'registry', agent: 'reputation', role: 'Agent reputation scorer' },
      { domain: 'registry', agent: 'bootstrap', role: 'Agent bootstrapper' },
      { domain: 'marketplace', agent: 'package', role: 'Agent packager' },
    ],
  },
  // ── Benchmark / Leaderboard ──
  {
    keywords: ['leaderboard', 'publish benchmark', 'benchmark exchange', 'ranking', 'scoreboard'],
    agents: [
      { domain: 'benchmark-exchange', agent: 'publish', role: 'Benchmark publisher' },
      { domain: 'test-bench', agent: 'benchmark', role: 'Benchmark runner' },
      { domain: 'analytics-hub', agent: 'consensus', role: 'Consensus builder' },
    ],
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // ANALYTICS & REPORTING
  // ═══════════════════════════════════════════════════════════════════════════

  // ── Executive / Board Reporting ──
  {
    keywords: ['executive', 'board', 'stakeholder', 'leadership', 'c-suite', 'kpi'],
    agents: [
      { domain: 'platform', agent: 'executive-summary', role: 'Executive summarizer' },
      { domain: 'platform', agent: 'decision-memo', role: 'Decision memo writer' },
      { domain: 'research-lab', agent: 'metrics', role: 'KPI analyst' },
      { domain: 'analytics-hub', agent: 'recommendation', role: 'Recommendation writer' },
    ],
  },
  // ── Consensus / Recommendation ──
  {
    keywords: ['consensus', 'recommendation', 'multi-stakeholder', 'collaborative decision', 'vote'],
    agents: [
      { domain: 'analytics-hub', agent: 'consensus', role: 'Consensus builder' },
      { domain: 'analytics-hub', agent: 'recommendation', role: 'Recommendation engine' },
      { domain: 'platform', agent: 'executive-summary', role: 'Summary generator' },
    ],
  },
  // ── Research / Hypothesis Testing ──
  {
    keywords: ['hypothesis', 'a/b test', 'experiment', 'research', 'metrics analysis', 'statistical'],
    agents: [
      { domain: 'research-lab', agent: 'hypothesis', role: 'Hypothesis tester' },
      { domain: 'research-lab', agent: 'metrics', role: 'Metrics analyst' },
      { domain: 'observatory', agent: 'usage-patterns', role: 'Usage pattern analyst' },
    ],
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // COPILOT INTELLIGENCE
  // ═══════════════════════════════════════════════════════════════════════════

  // ── Task Planning / Decomposition ──
  {
    keywords: ['plan', 'decompose', 'break down', 'task breakdown', 'work breakdown', 'subtask'],
    agents: [
      { domain: 'copilot', agent: 'planner', role: 'Task planner' },
      { domain: 'copilot', agent: 'decomposer', role: 'Task decomposer' },
      { domain: 'copilot', agent: 'clarifier', role: 'Requirements clarifier' },
    ],
    phases: [2, 3],
  },
  // ── Intent / Classification ──
  {
    keywords: ['classify', 'intent', 'categorize', 'triage', 'route request'],
    agents: [
      { domain: 'copilot', agent: 'intent', role: 'Intent classifier' },
      { domain: 'copilot', agent: 'clarifier', role: 'Intent clarifier' },
    ],
  },
  // ── Reflection / Meta-Reasoning ──
  {
    keywords: ['reflect', 'self-assess', 'meta-reason', 'introspect', 'self-critique'],
    agents: [
      { domain: 'copilot', agent: 'reflection', role: 'Reflective reasoner' },
      { domain: 'copilot', agent: 'meta-reasoner', role: 'Meta reasoner' },
    ],
    phases: [4, 5],
  },
  // ── Configuration Validation ──
  {
    keywords: ['config', 'configuration', 'env', 'environment variable', 'settings', '.env'],
    agents: [
      { domain: 'copilot', agent: 'config', role: 'Config assistant' },
      { domain: 'config-manager', agent: 'validate', role: 'Config validator' },
    ],
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // CLOUD & INFRASTRUCTURE
  // ═══════════════════════════════════════════════════════════════════════════

  // ── Cloud Providers ──
  {
    keywords: ['aws', 'gcp', 'google cloud', 'azure', 'cloud native', 'serverless', 'lambda', 'cloud function', 'cloud run'],
    agents: [
      { domain: 'connector-hub', agent: 'auth-identity', role: 'Cloud auth connector' },
      { domain: 'edge', agent: 'execution-guard', role: 'Cloud execution guard' },
      { domain: 'latency-lens', agent: 'cold-start', role: 'Serverless cold start analyzer' },
    ],
  },
  // ── DevOps / CI-CD ──
  {
    keywords: ['devops', 'ci/cd', 'cicd', 'docker', 'kubernetes', 'k8s', 'terraform', 'helm', 'github actions', 'jenkins'],
    agents: [
      { domain: 'orchestrator', agent: 'workflow', role: 'CI/CD workflow designer' },
      { domain: 'orchestrator', agent: 'dependencies', role: 'Build dependency resolver' },
      { domain: 'config-manager', agent: 'validate', role: 'Infra config validator' },
    ],
    phases: [5, 6],
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // ARCHITECTURE PATTERNS
  // ═══════════════════════════════════════════════════════════════════════════

  // ── Microservices ──
  {
    keywords: ['microservice', 'service mesh', 'api gateway', 'service discovery', 'sidecar', 'istio', 'envoy'],
    agents: [
      { domain: 'edge', agent: 'circuit-breaker', role: 'Service mesh resilience' },
      { domain: 'edge', agent: 'failover', role: 'Service failover' },
      { domain: 'orchestrator', agent: 'dependencies', role: 'Service dependency mapper' },
      { domain: 'observatory', agent: 'telemetry', role: 'Distributed tracing designer' },
      { domain: 'connector-hub', agent: 'auth-identity', role: 'Service-to-service auth' },
    ],
    phases: [3, 4, 5],
  },
  // ── DDD / Hexagonal / Clean Architecture ──
  {
    keywords: ['domain driven', 'ddd', 'hexagonal', 'clean architecture', 'bounded context', 'aggregate', 'event storming', 'ports and adapters'],
    agents: [
      { domain: 'copilot', agent: 'decomposer', role: 'Domain decomposer' },
      { domain: 'copilot', agent: 'meta-reasoner', role: 'Architecture reasoner' },
      { domain: 'governance-dashboard', agent: 'impact', role: 'Domain boundary impact analyst' },
      { domain: 'memory-graph', agent: 'knowledge-graph', role: 'Domain model grapher' },
    ],
    phases: [3, 4],
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // INDUSTRY VERTICALS
  // ═══════════════════════════════════════════════════════════════════════════

  // ── Healthcare / Pharma ──
  {
    keywords: ['healthcare', 'health', 'pharma', 'clinical', 'patient', 'medical', 'ehr', 'hl7', 'fhir', 'dicom'],
    agents: [
      { domain: 'shield', agent: 'pii', role: 'PHI/PII scanner' },
      { domain: 'data-vault', agent: 'anonymize', role: 'Patient data anonymizer' },
      { domain: 'governance-dashboard', agent: 'audit', role: 'Healthcare compliance auditor' },
      { domain: 'policy-engine', agent: 'enforce', role: 'HIPAA policy enforcer' },
      { domain: 'data-vault', agent: 'access-control', role: 'Healthcare access control' },
    ],
  },
  // ── Financial Services / Fintech ──
  {
    keywords: ['financial', 'fintech', 'banking', 'payment', 'transaction', 'ledger', 'accounting', 'invoice', 'billing', 'forex'],
    agents: [
      { domain: 'sentinel', agent: 'anomaly', role: 'Transaction anomaly detector' },
      { domain: 'sentinel', agent: 'correlation', role: 'Financial event correlator' },
      { domain: 'governance-dashboard', agent: 'audit', role: 'Financial auditor' },
      { domain: 'shield', agent: 'pii', role: 'Financial PII scanner' },
      { domain: 'policy-engine', agent: 'enforce', role: 'Financial regulation enforcer' },
      { domain: 'data-vault', agent: 'access-control', role: 'Financial access control' },
    ],
  },
  // ── Manufacturing / Supply Chain ──
  {
    keywords: ['manufacturing', 'supply chain', 'logistics', 'inventory', 'warehouse', 'production', 'bom', 'mrp', 'factory', 'iot'],
    agents: [
      { domain: 'connector-hub', agent: 'erp-surface', role: 'Manufacturing ERP connector' },
      { domain: 'sentinel', agent: 'anomaly', role: 'Production anomaly detector' },
      { domain: 'orchestrator', agent: 'workflow', role: 'Supply chain workflow' },
      { domain: 'observatory', agent: 'telemetry', role: 'IoT telemetry designer' },
      { domain: 'simulator', agent: 'scenario', role: 'Supply chain simulator' },
    ],
  },
  // ── Retail / E-Commerce ──
  {
    keywords: ['retail', 'e-commerce', 'ecommerce', 'shopping', 'cart', 'checkout', 'product catalog', 'storefront', 'marketplace'],
    agents: [
      { domain: 'sentinel', agent: 'anomaly', role: 'Fraud anomaly detector' },
      { domain: 'auto-optimizer', agent: 'self-optimize', role: 'Checkout optimizer' },
      { domain: 'latency-lens', agent: 'latency', role: 'Storefront latency profiler' },
      { domain: 'research-lab', agent: 'metrics', role: 'Conversion metrics analyst' },
      { domain: 'edge', agent: 'caching', role: 'Product catalog cache' },
    ],
  },
  // ── Insurance ──
  {
    keywords: ['insurance', 'claim', 'underwriting', 'policy', 'actuary', 'premium', 'coverage'],
    agents: [
      { domain: 'sentinel', agent: 'anomaly', role: 'Claims fraud detector' },
      { domain: 'governance-dashboard', agent: 'audit', role: 'Insurance compliance auditor' },
      { domain: 'simulator', agent: 'scenario', role: 'Risk scenario simulator' },
      { domain: 'platform', agent: 'risk-score', role: 'Underwriting risk scorer' },
    ],
  },
  // ── Telecom / Media ──
  {
    keywords: ['telecom', 'telco', 'media', 'streaming', 'broadcast', 'subscriber', 'bandwidth', '5g'],
    agents: [
      { domain: 'latency-lens', agent: 'latency', role: 'Streaming latency profiler' },
      { domain: 'edge', agent: 'caching', role: 'Content delivery cache' },
      { domain: 'observatory', agent: 'usage-patterns', role: 'Subscriber usage analyst' },
      { domain: 'sentinel', agent: 'anomaly', role: 'Network anomaly detector' },
    ],
  },
  // ── Energy / Utilities ──
  {
    keywords: ['energy', 'utility', 'grid', 'solar', 'wind', 'scada', 'smart meter', 'power'],
    agents: [
      { domain: 'observatory', agent: 'telemetry', role: 'Grid telemetry designer' },
      { domain: 'sentinel', agent: 'anomaly', role: 'Grid anomaly detector' },
      { domain: 'simulator', agent: 'scenario', role: 'Energy scenario planner' },
      { domain: 'connector-hub', agent: 'event-normalize', role: 'Sensor event normalizer' },
    ],
  },
  // ── Education / EdTech ──
  {
    keywords: ['education', 'edtech', 'learning', 'student', 'curriculum', 'lms', 'course'],
    agents: [
      { domain: 'test-bench', agent: 'bias', role: 'Educational bias detector' },
      { domain: 'shield', agent: 'toxicity', role: 'Content safety scanner' },
      { domain: 'data-vault', agent: 'anonymize', role: 'Student data anonymizer' },
      { domain: 'research-lab', agent: 'metrics', role: 'Learning metrics analyst' },
    ],
  },
  // ── Government / Public Sector ──
  {
    keywords: ['government', 'public sector', 'federal', 'municipal', 'citizen', 'civic', 'open data'],
    agents: [
      { domain: 'governance-dashboard', agent: 'audit', role: 'Government audit' },
      { domain: 'governance-dashboard', agent: 'oversight', role: 'Public oversight' },
      { domain: 'data-vault', agent: 'access-control', role: 'Citizen data access control' },
      { domain: 'shield', agent: 'pii', role: 'Citizen PII scanner' },
      { domain: 'policy-engine', agent: 'enforce', role: 'Regulatory compliance enforcer' },
    ],
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // PHASE-SPECIFIC ENRICHMENT
  // ═══════════════════════════════════════════════════════════════════════════

  // ── Phase 2 Research: always add pattern learning ──
  {
    keywords: ['research', 'analysis', 'requirement', 'discovery', 'stakeholder'],
    agents: [
      { domain: 'memory-graph', agent: 'patterns', role: 'Research pattern learner' },
      { domain: 'copilot', agent: 'clarifier', role: 'Research clarifier' },
    ],
    phases: [2],
  },
  // ── Phase 3 SPARC: architecture enrichment ──
  {
    keywords: ['specification', 'architecture', 'design', 'system design', 'technical design'],
    agents: [
      { domain: 'copilot', agent: 'meta-reasoner', role: 'Architecture meta-reasoner' },
      { domain: 'observatory', agent: 'visualization', role: 'Architecture visualizer' },
    ],
    phases: [3],
  },
  // ── Phase 5 Build: full quality + security sweep ──
  {
    keywords: ['code', 'implementation', 'build', 'generate', 'scaffold'],
    agents: [
      { domain: 'test-bench', agent: 'benchmark', role: 'Code benchmark runner' },
      { domain: 'test-bench', agent: 'regression', role: 'Code regression tester' },
      { domain: 'shield', agent: 'credential-exposure', role: 'Build credential scanner' },
    ],
    phases: [5],
  },
  // ── Phase 6 Deploy: deployment validation ──
  {
    keywords: ['deploy', 'release', 'production', 'go-live', 'rollout'],
    agents: [
      { domain: 'platform', agent: 'risk-score', role: 'Deployment risk scorer' },
      { domain: 'simulator', agent: 'scenario', role: 'Deployment scenario simulator' },
      { domain: 'observatory', agent: 'health-check', role: 'Pre-deploy health checker' },
    ],
    phases: [6],
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // CROSS-CUTTING COMBOS (inspired by 33 multi-agent combos)
  // ═══════════════════════════════════════════════════════════════════════════

  // ── Revenue / Monetization ──
  {
    keywords: ['revenue', 'monetization', 'pricing model', 'subscription', 'saas', 'mrr', 'arr', 'churn'],
    agents: [
      { domain: 'costops', agent: 'attribution', role: 'Revenue attribution' },
      { domain: 'costops', agent: 'roi', role: 'Revenue ROI calculator' },
      { domain: 'research-lab', agent: 'metrics', role: 'Revenue metrics analyst' },
      { domain: 'sentinel', agent: 'anomaly', role: 'Revenue anomaly detector' },
    ],
  },
  // ── Migration / Modernization ──
  {
    keywords: ['migration', 'modernization', 'legacy', 'lift and shift', 'replatform', 'refactor', 'brownfield'],
    agents: [
      { domain: 'forge', agent: 'version-compat', role: 'Migration compat checker' },
      { domain: 'forge', agent: 'api-translation', role: 'API migration translator' },
      { domain: 'governance-dashboard', agent: 'impact', role: 'Migration impact analyst' },
      { domain: 'simulator', agent: 'what-if', role: 'Migration scenario simulator' },
      { domain: 'platform', agent: 'risk-score', role: 'Migration risk scorer' },
    ],
  },
  // ── Multi-Tenancy / Isolation ──
  {
    keywords: ['multi-tenant', 'tenant isolation', 'data isolation', 'tenant', 'namespace', 'partition'],
    agents: [
      { domain: 'data-vault', agent: 'access-control', role: 'Tenant isolation designer' },
      { domain: 'policy-engine', agent: 'constraints', role: 'Tenant constraint enforcer' },
      { domain: 'shield', agent: 'secrets', role: 'Tenant secrets scanner' },
    ],
  },
  // ── Usage Analytics / Patterns ──
  {
    keywords: ['usage analytics', 'usage pattern', 'adoption', 'user behavior', 'funnel', 'retention'],
    agents: [
      { domain: 'observatory', agent: 'usage-patterns', role: 'Usage pattern analyst' },
      { domain: 'research-lab', agent: 'metrics', role: 'Adoption metrics analyst' },
      { domain: 'analytics-hub', agent: 'recommendation', role: 'Usage recommendation engine' },
    ],
  },
  // ── Smart Routing / Load Balancing ──
  {
    keywords: ['routing', 'load balancing', 'traffic', 'canary', 'blue-green', 'feature flag'],
    agents: [
      { domain: 'inference-gateway', agent: 'route', role: 'Intelligent router' },
      { domain: 'edge', agent: 'execution-guard', role: 'Traffic guard' },
      { domain: 'orchestrator', agent: 'parallel', role: 'Load distributor' },
    ],
  },
];

/**
 * Scan scenario text + phase context for keywords and return additional
 * agentics agents to dispatch alongside the fixed defaults.
 *
 * Deduplicates against already-scheduled agents to avoid double-invocation.
 */
export function inferContextualAgents(
  scenarioQuery: string,
  phaseConfig: SwarmPhaseConfig,
  runDir: string,
): AgenticsServiceCall[] {
  // Build searchable text from scenario + prior-phase artifacts
  let searchText = scenarioQuery.toLowerCase();

  // Include key artifact text for richer context matching
  const contextFiles: Record<number, string[]> = {
    2: [],
    3: ['phase2/research-dossier.json'],
    4: ['phase3/sparc/sparc-combined.json'],
    5: ['phase4/ddd/domain-model.json'],
    6: ['phase5/phase5-manifest.json'],
  };

  for (const file of contextFiles[phaseConfig.phase] ?? []) {
    const fullPath = path.join(runDir, file);
    if (fs.existsSync(fullPath)) {
      try {
        const content = fs.readFileSync(fullPath, 'utf-8');
        searchText += ' ' + content.slice(0, 3000).toLowerCase();
      } catch {
        // Non-fatal
      }
    }
  }

  // Build set of already-scheduled agent keys for dedup
  const scheduled = new Set(
    phaseConfig.agenticsServices.map(s => `${s.domain}/${s.agent}`),
  );

  const additional: AgenticsServiceCall[] = [];
  const addedKeys = new Set<string>();

  for (const trigger of CONTEXTUAL_TRIGGERS) {
    // Phase filter: skip triggers that don't apply to this phase
    if (trigger.phases && trigger.phases.length > 0 && !trigger.phases.includes(phaseConfig.phase)) {
      continue;
    }

    // Check if any keyword matches the scenario/context text
    const matched = trigger.keywords.some(kw => searchText.includes(kw));
    if (!matched) continue;

    // Add agents that aren't already scheduled
    for (const agent of trigger.agents) {
      const key = `${agent.domain}/${agent.agent}`;
      if (!scheduled.has(key) && !addedKeys.has(key)) {
        additional.push(agent);
        addedKeys.add(key);
      }
    }
  }

  return additional;
}

// ============================================================================
// Ruflo Coding Swarm — Real Code Enhancement
// ============================================================================

/**
 * Invoke the Ruflo coding swarm to enhance generated code.
 *
 * After the deterministic generators produce the project scaffold and base
 * implementations, ruflo fill uses the claude-flow swarm to fill remaining
 * stubs with real logic derived from ADRs, DDD model, and TDD plan.
 *
 * This is the "coding swarm" — a team of specialized agents coordinated
 * by Ruflo that actually build the high-fidelity MVP.
 */
export function invokeRufloCodingSwarm(
  traceId: string,
  runDir: string,
): { invoked: boolean; filesModified: number; timing: number } {
  const start = Date.now();

  // Find the ruflo binary (first-class dependency)
  let rufloBin: string | null = null;
  const localBin = path.resolve(process.cwd(), 'node_modules', '.bin', 'ruflo');
  if (fs.existsSync(localBin)) {
    rufloBin = localBin;
  } else {
    // Walk up directory tree
    let dir = path.dirname(new URL(import.meta.url).pathname);
    for (let i = 0; i < 6; i++) {
      const candidate = path.join(dir, 'node_modules', '.bin', 'ruflo');
      if (fs.existsSync(candidate)) {
        rufloBin = candidate;
        break;
      }
      dir = path.dirname(dir);
    }
  }

  if (!rufloBin) {
    console.error('  [RUFLO-SWARM] ruflo binary not found — coding swarm skipped');
    return { invoked: false, filesModified: 0, timing: Date.now() - start };
  }

  // Locate generated project and supporting artifacts
  const codegenProject = path.join(runDir, 'phase5', 'codegen', 'project');
  const deployProject = path.join(runDir, 'phase5', 'deploy', 'project');
  const projectDir = fs.existsSync(codegenProject) ? codegenProject : deployProject;

  if (!fs.existsSync(projectDir)) {
    console.error('  [RUFLO-SWARM] No generated project found — coding swarm skipped');
    return { invoked: false, filesModified: 0, timing: Date.now() - start };
  }

  // Locate ADRs, DDD model, TDD plan for ruflo fill context
  const adrIndex = findArtifactUp(runDir, 'adrs/adr-index.json');
  const dddModel = findArtifactUp(runDir, 'ddd/domain-model.json');
  const tddPlan = findArtifactUp(runDir, 'tdd/tdd-plan.json');

  // Detect language from project files
  const language = fs.existsSync(path.join(projectDir, 'Cargo.toml')) ? 'rust' : 'typescript';

  // Build ruflo fill command
  const args = ['fill', '--language', language, '--target', projectDir];
  if (adrIndex) args.push('--adr-index', adrIndex);
  if (dddModel) args.push('--ddd-model', dddModel);
  if (tddPlan) args.push('--tdd-plan', tddPlan);

  console.error(`  [RUFLO-SWARM] Invoking coding swarm on ${projectDir}`);
  console.error(`  [RUFLO-SWARM] Language: ${language}, ADRs: ${adrIndex ? 'yes' : 'no'}, DDD: ${dddModel ? 'yes' : 'no'}, TDD: ${tddPlan ? 'yes' : 'no'}`);

  // Spawn the swarm coding task via claude-flow
  if (isClaudeFlowAvailable()) {
    cfExec(
      `agent spawn -t coder --name "ruflo-coder-${traceId.slice(0, 8)}" --task "Fill implementation stubs in ${projectDir} using ruflo coding swarm"`,
      30000,
    );
    cfExec(
      `task create --description "Ruflo coding swarm: fill stubs in generated ${language} project — trace ${traceId}" --type implementation`,
      30000,
    );
  }

  // Execute ruflo fill
  try {
    const result = execSync(`${rufloBin} ${args.join(' ')}`, {
      cwd: projectDir,
      timeout: 300_000,
      encoding: 'utf-8',
      stdio: 'pipe',
    });

    const filesMatch = result.match(/(\d+)\s+files?\s+modified/i);
    const filesModified = filesMatch?.[1] ? parseInt(filesMatch[1], 10) : 0;
    const timing = Date.now() - start;

    console.error(`  [RUFLO-SWARM] Coding swarm completed: ${filesModified} files enhanced in ${timing}ms`);

    // Store result in swarm memory
    if (isClaudeFlowAvailable()) {
      cfExec(
        `memory store --namespace phase5-build --key "ruflo-fill-${traceId}" --value "Ruflo coding swarm filled ${filesModified} files in ${timing}ms"`,
      );
      cfExec(
        `hooks post-task --task-id "ruflo-fill-${traceId}" --success true --store-results true`,
      );
    }

    return { invoked: true, filesModified, timing };
  } catch (err) {
    const timing = Date.now() - start;
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`  [RUFLO-SWARM] Coding swarm failed: ${msg.slice(0, 200)}`);

    if (isClaudeFlowAvailable()) {
      cfExec(
        `memory store --namespace failures --key "ruflo-fill-${traceId}" --value "FAILED: ${msg.slice(0, 200).replace(/"/g, '\\"')}"`,
      );
    }

    return { invoked: false, filesModified: 0, timing };
  }
}

/** Search phase directories for an artifact file. */
function findArtifactUp(runDir: string, relativePath: string): string | null {
  // Check in phase4, phase3, phase2 directories
  for (const phase of ['phase4', 'phase3', 'phase2']) {
    const candidate = path.join(runDir, phase, relativePath);
    if (fs.existsSync(candidate)) return candidate;
  }
  // Check in merged directory
  const merged = path.join(runDir, 'phase5', '.phase2-merged', relativePath);
  if (fs.existsSync(merged)) return merged;
  return null;
}

// ============================================================================
// Ruflo Binary Resolution & Installation
// ============================================================================

let _cfBinary: string | null = null;

/**
 * Resolve the claude-flow binary from the local node_modules.
 * claude-flow is a first-class dependency in package.json — no npx needed.
 */
function resolveClaudeFlowBinary(): string {
  if (_cfBinary) return _cfBinary;

  // Priority 1: Local node_modules binary (package.json dependency)
  const localBin = path.resolve(process.cwd(), 'node_modules', '.bin', 'claude-flow');
  if (fs.existsSync(localBin)) {
    _cfBinary = localBin;
    return _cfBinary;
  }

  // Priority 2: Walk up from this file's directory to find node_modules
  let dir = path.dirname(new URL(import.meta.url).pathname);
  for (let i = 0; i < 5; i++) {
    const candidate = path.join(dir, 'node_modules', '.bin', 'claude-flow');
    if (fs.existsSync(candidate)) {
      _cfBinary = candidate;
      return _cfBinary;
    }
    dir = path.dirname(dir);
  }

  // Priority 3: Global fallback — try which
  try {
    const global = execSync('which claude-flow', { stdio: 'pipe', encoding: 'utf-8' }).trim();
    if (global) {
      _cfBinary = global;
      return _cfBinary;
    }
  } catch {
    // Not found globally
  }

  // Priority 4: npx fallback (last resort — slower but works)
  _cfBinary = 'npx claude-flow';
  return _cfBinary;
}

/**
 * Ensure Ruflo (claude-flow) is installed and functional.
 *
 * claude-flow is a declared dependency in package.json. If the binary is
 * missing (e.g. node_modules was cleared), we re-install it automatically.
 * This guarantees the swarm orchestrator always has its runtime available.
 *
 * Returns the path to the binary, or null if installation failed.
 */
export function ensureRufloInstalled(): string | null {
  const binary = resolveClaudeFlowBinary();

  // Verify the binary actually works
  try {
    execSync(`${binary} --version`, {
      stdio: 'pipe',
      timeout: 10000,
    });
    return binary;
  } catch {
    // Binary found but broken, or npx fallback — try installing
  }

  console.error('  [RUFLO] claude-flow not found — installing from package.json dependency...');
  try {
    execSync('npm install claude-flow --no-save', {
      stdio: 'pipe',
      timeout: 60000,
      cwd: process.cwd(),
    });
    // Reset cache and re-resolve
    _cfBinary = null;
    const newBinary = resolveClaudeFlowBinary();

    execSync(`${newBinary} --version`, {
      stdio: 'pipe',
      timeout: 10000,
    });
    console.error('  [RUFLO] claude-flow installed successfully');
    return newBinary;
  } catch {
    console.error('  [RUFLO] claude-flow installation failed — swarm features degraded');
    return null;
  }
}

// ============================================================================
// Ruflo CLI Availability
// ============================================================================

let _rufloAvailable: boolean | null = null;
let _rufloVerified = false;

/**
 * Check if Ruflo is available. On first call, ensures installation.
 */
export function isClaudeFlowAvailable(): boolean {
  if (_rufloAvailable !== null) return _rufloAvailable;

  if (!_rufloVerified) {
    _rufloVerified = true;
    const binary = ensureRufloInstalled();
    _rufloAvailable = binary !== null;
  }

  return _rufloAvailable ?? false;
}

/** Reset the availability cache (for testing). */
export function resetAvailabilityCache(): void {
  _rufloAvailable = null;
  _rufloVerified = false;
  _cfBinary = null;
}

// ============================================================================
// Safe Ruflo CLI Execution
// ============================================================================

function cfExec(command: string, timeoutMs = 30000): string | null {
  const binary = resolveClaudeFlowBinary();
  try {
    return execSync(`${binary} ${command}`, {
      stdio: 'pipe',
      timeout: timeoutMs,
      encoding: 'utf-8',
    }).trim();
  } catch {
    return null;
  }
}

// ============================================================================
// Agentics Platform Agent Invocation
// ============================================================================

/**
 * Invoke an Agentics platform agent and return its result.
 * Never throws — failures are captured and returned as null.
 */
async function invokeAgenticsService(
  svc: AgenticsServiceCall,
  prompt: string,
  traceId: string,
): Promise<AgenticsServiceResult | null> {
  const start = Date.now();
  const options: CommandOptions = { trace_id: traceId };

  try {
    const result: AgentsInvokeResult = await executeAgentsInvokeCommand(
      svc.domain,
      svc.agent,
      { text: prompt },
      options,
    );

    return {
      domain: svc.domain,
      agent: svc.agent,
      role: svc.role,
      status: result.status,
      response: result.response,
      timing: Date.now() - start,
    };
  } catch {
    // Non-fatal — agent invocation failures never block the pipeline
    return null;
  }
}

/**
 * Dispatch all agentics platform agents for a phase in parallel.
 * Returns results from all agents (some may be null on failure).
 */
async function dispatchAgenticsServices(
  services: AgenticsServiceCall[],
  prompt: string,
  traceId: string,
): Promise<AgenticsServiceResult[]> {
  if (services.length === 0) return [];

  const promises = services.map(svc => invokeAgenticsService(svc, prompt, traceId));
  const results = await Promise.allSettled(promises);

  const collected: AgenticsServiceResult[] = [];
  for (const r of results) {
    if (r.status === 'fulfilled' && r.value !== null) {
      collected.push(r.value);
    }
  }
  return collected;
}

/**
 * Build the prompt text for agentics agents based on phase context.
 */
function buildPhasePrompt(
  phaseConfig: SwarmPhaseConfig,
  scenarioQuery: string,
  runDir: string,
): string {
  const phaseDir = path.join(runDir, `phase${phaseConfig.phase}`);
  let context = `Pipeline Phase ${phaseConfig.phase}: ${phaseConfig.label}\n`;
  context += `Scenario: ${scenarioQuery.slice(0, 500)}\n`;

  // Include key prior-phase artifact summaries for context
  const contextFiles: Record<number, string[]> = {
    2: [],
    3: ['phase2/research-dossier.json'],
    4: ['phase3/sparc/sparc-combined.json'],
    5: ['phase4/ddd/domain-model.json', 'phase4/adrs/adr-index.json'],
    6: ['phase5/phase5-manifest.json'],
  };

  const files = contextFiles[phaseConfig.phase] ?? [];
  for (const file of files) {
    const fullPath = path.join(runDir, file);
    if (fs.existsSync(fullPath)) {
      try {
        const content = fs.readFileSync(fullPath, 'utf-8');
        context += `\n--- ${file} (excerpt) ---\n${content.slice(0, 1500)}\n`;
      } catch {
        // Non-fatal
      }
    }
  }

  // Include current phase artifacts if they exist (for review agents)
  if (fs.existsSync(phaseDir)) {
    try {
      const entries = fs.readdirSync(phaseDir).slice(0, 10);
      context += `\nPhase ${phaseConfig.phase} artifacts: ${entries.join(', ')}\n`;
    } catch {
      // Non-fatal
    }
  }

  return context;
}

// ============================================================================
// Swarm Lifecycle
// ============================================================================

/**
 * Initialize the Ruflo swarm for the pipeline.
 *
 * Ensures claude-flow is installed (first-class dependency), then initializes
 * the hierarchical swarm with anti-drift configuration.
 *
 * Returns true if swarm was initialized, false on failure.
 */
export function initSwarm(config: SwarmConfig): boolean {
  if (!isClaudeFlowAvailable()) {
    console.error('  [RUFLO] Swarm unavailable — running pipeline in local-only mode');
    return false;
  }

  console.error('  [RUFLO] Initializing swarm orchestration...');

  // Initialize swarm with anti-drift config
  const initResult = cfExec(
    `swarm init --topology ${config.topology} --max-agents ${config.maxAgents} --strategy ${config.strategy}`,
  );

  if (!initResult) {
    console.error('  [RUFLO] Swarm init failed — falling back to local mode');
    return false;
  }

  // Store pipeline metadata in swarm memory
  cfExec(
    `memory store --namespace pipeline --key "trace-${config.traceId}" --value "Pipeline started at ${new Date().toISOString()}"`,
  );

  // Start session for cross-phase learning
  cfExec(
    `hooks session-start --session-id "pipeline-${config.traceId}" --auto-configure true`,
  );

  console.error(`  [RUFLO] Swarm initialized: topology=${config.topology}, max-agents=${config.maxAgents}`);
  console.error(`  [RUFLO] Agentics platform agents will be dispatched per phase`);
  return true;
}

/**
 * Dispatch swarm agents + agentics platform agents for a pipeline phase.
 *
 * The Ruflo swarm coordinates agent teams while agentics platform services
 * (deployed in GCloud, cached locally) do real analysis, validation, and
 * enrichment work. Together they form a team.
 */
export async function dispatchPhaseAgents(
  phaseConfig: SwarmPhaseConfig,
  traceId: string,
  runDir: string,
  scenarioQuery = '',
): Promise<AgenticsServiceResult[]> {
  const agenticsResults: AgenticsServiceResult[] = [];

  // ── 1. Ruflo swarm coordination ──
  if (isClaudeFlowAvailable()) {
    console.error(`  [RUFLO] Dispatching ${phaseConfig.agents.length} swarm agents for Phase ${phaseConfig.phase}: ${phaseConfig.label}`);

    // Create a task for the phase
    cfExec(
      `task create --description "Phase ${phaseConfig.phase}: ${phaseConfig.label} — trace ${traceId}" --type implementation`,
      60000,
    );

    // Spawn specialized swarm agents
    for (const agent of phaseConfig.agents) {
      cfExec(
        `agent spawn -t ${agent.type} --name "${agent.role}-p${phaseConfig.phase}" --task "${agent.description}"`,
        30000,
      );
    }

    // Pre-task hook for routing intelligence
    cfExec(
      `hooks pre-task --description "Phase ${phaseConfig.phase}: ${phaseConfig.label}" --coordinate-swarm true`,
    );

    // Search memory for relevant patterns from past executions
    const patterns = cfExec(
      `memory search --query "${phaseConfig.label}" --namespace patterns --limit 3`,
    );
    if (patterns && patterns.length > 10) {
      console.error(`  [RUFLO] Found prior patterns for ${phaseConfig.label}`);
    }
  }

  // ── 2. Infer contextual agents from scenario + artifacts ──
  const contextualAgents = inferContextualAgents(scenarioQuery, phaseConfig, runDir);
  if (contextualAgents.length > 0) {
    const ctxNames = contextualAgents.map(s => `${s.domain}/${s.agent}`);
    console.error(`  [AGENTICS] +${contextualAgents.length} contextual agents triggered: ${ctxNames.join(', ')}`);
  }

  // ── 3. Agentics platform agent dispatch (fixed defaults + contextual) ──
  const allServices = [...phaseConfig.agenticsServices, ...contextualAgents];
  if (allServices.length > 0) {
    const serviceNames = allServices.map(s => `${s.domain}/${s.agent}`);
    console.error(`  [AGENTICS] Dispatching ${allServices.length} platform agents: ${serviceNames.join(', ')}`);

    const prompt = buildPhasePrompt(phaseConfig, scenarioQuery, runDir);
    const results = await dispatchAgenticsServices(allServices, prompt, traceId);

    for (const r of results) {
      agenticsResults.push(r);
      const icon = r.status === 200 ? '[OK]' : '[!!]';
      console.error(`  [AGENTICS] ${icon} ${r.domain}/${r.agent} (${r.role}) — ${r.timing}ms`);

      // Store successful results in swarm memory for cross-phase access
      if (isClaudeFlowAvailable() && r.status === 200) {
        const summary = typeof r.response === 'string'
          ? r.response.slice(0, 500)
          : JSON.stringify(r.response).slice(0, 500);
        cfExec(
          `memory store --namespace ${phaseConfig.memoryNamespace} --key "${r.domain}-${r.agent}-${traceId}" --value "${summary.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`,
        );
      }
    }

    if (results.length > 0) {
      console.error(`  [AGENTICS] ${results.length}/${allServices.length} agents responded for Phase ${phaseConfig.phase}`);
    }
  }

  return agenticsResults;
}

/**
 * Store phase artifacts in swarm memory for cross-phase coordination.
 */
export function storePhaseArtifacts(
  phaseConfig: SwarmPhaseConfig,
  traceId: string,
  runDir: string,
  artifacts: string[],
  timing: number,
): void {
  if (!isClaudeFlowAvailable()) return;

  const phaseDir = path.join(runDir, `phase${phaseConfig.phase}`);

  // Store artifact list in memory
  const artifactSummary = artifacts.slice(0, 10).join(', ');
  cfExec(
    `memory store --namespace ${phaseConfig.memoryNamespace} --key "artifacts-${traceId}" --value "${artifactSummary.replace(/"/g, '\\"')}"`,
  );

  // Store timing metrics
  cfExec(
    `memory store --namespace metrics --key "phase${phaseConfig.phase}-timing-${traceId}" --value "${timing}ms"`,
  );

  // Post-task hook for learning
  cfExec(
    `hooks post-task --task-id "phase${phaseConfig.phase}-${traceId}" --success true --store-results true`,
  );

  // Read key artifact content and store summaries in memory for downstream phases
  const keyArtifacts: Record<number, string[]> = {
    2: ['research-dossier.json'],
    3: ['sparc-combined.json', 'tdd/tdd-plan.json'],
    4: ['adrs/adr-index.json', 'ddd/domain-model.json'],
    5: ['phase5-manifest.json'],
    6: ['phase6-manifest.json'],
  };

  const filesToStore = keyArtifacts[phaseConfig.phase] ?? [];
  for (const file of filesToStore) {
    const fullPath = path.join(phaseDir, file);
    if (fs.existsSync(fullPath)) {
      try {
        const content = fs.readFileSync(fullPath, 'utf-8');
        const summary = content.slice(0, 2000);
        cfExec(
          `memory store --namespace ${phaseConfig.memoryNamespace} --key "${path.basename(file)}-${traceId}" --value "${summary.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`,
        );
      } catch {
        // Non-fatal
      }
    }
  }

  console.error(`  [RUFLO] Phase ${phaseConfig.phase} artifacts stored in swarm memory (${artifacts.length} files, ${timing}ms)`);
}

/**
 * Run quality review on phase output using both swarm agents and agentics services.
 *
 * Post-phase review dispatches:
 *   - Ruflo reviewer agent (swarm coordination)
 *   - Agentics quality/security agents (real validation)
 */
export async function reviewPhaseOutput(
  phaseConfig: SwarmPhaseConfig,
  traceId: string,
  runDir: string,
): Promise<AgenticsServiceResult[]> {
  const phaseDir = path.join(runDir, `phase${phaseConfig.phase}`);
  if (!fs.existsSync(phaseDir)) return [];

  // ── 1. Ruflo swarm reviewer ──
  if (isClaudeFlowAvailable()) {
    cfExec(
      `agent spawn -t reviewer --name "reviewer-p${phaseConfig.phase}" --task "Review Phase ${phaseConfig.phase} (${phaseConfig.label}) output at ${phaseDir} for quality and completeness"`,
      30000,
    );

    // Train neural patterns on successful phase completion
    cfExec(
      `hooks post-edit --file "${phaseDir}" --train-neural true`,
    );
  }

  // ── 2. Agentics quality/security review agents ──
  const reviewServices: AgenticsServiceCall[] = [
    { domain: 'test-bench', agent: 'quality', role: 'Quality reviewer' },
  ];

  // Phase 5 (code generation): add security scanning
  if (phaseConfig.phase === 5) {
    reviewServices.push(
      { domain: 'shield', agent: 'secrets', role: 'Post-build secrets scan' },
      { domain: 'shield', agent: 'pii', role: 'Post-build PII scan' },
    );
  }

  // Phase 4 (ADRs): add governance audit
  if (phaseConfig.phase === 4) {
    reviewServices.push(
      { domain: 'governance-dashboard', agent: 'audit', role: 'ADR audit review' },
    );
  }

  // Phase 6 (deploy): add deployment risk scoring
  if (phaseConfig.phase === 6) {
    reviewServices.push(
      { domain: 'platform', agent: 'risk-score', role: 'Deployment risk review' },
    );
  }

  // Build review prompt with phase artifact content
  let reviewPrompt = `Review Phase ${phaseConfig.phase} (${phaseConfig.label}) output for quality, completeness, and security.\n`;
  try {
    const entries = fs.readdirSync(phaseDir).slice(0, 10);
    reviewPrompt += `Artifacts: ${entries.join(', ')}\n`;

    // Include a sample of the first few artifact files for context
    for (const entry of entries.slice(0, 3)) {
      const filePath = path.join(phaseDir, entry);
      try {
        const stat = fs.statSync(filePath);
        if (stat.isFile() && stat.size < 5000) {
          const content = fs.readFileSync(filePath, 'utf-8');
          reviewPrompt += `\n--- ${entry} ---\n${content.slice(0, 1500)}\n`;
        }
      } catch {
        // Non-fatal
      }
    }
  } catch {
    // Non-fatal
  }

  const results = await dispatchAgenticsServices(reviewServices, reviewPrompt, traceId);

  for (const r of results) {
    const icon = r.status === 200 ? '[OK]' : '[!!]';
    console.error(`  [REVIEW] ${icon} ${r.domain}/${r.agent} (${r.role}) — ${r.timing}ms`);

    // Store review results in swarm memory
    if (isClaudeFlowAvailable() && r.status === 200) {
      const summary = typeof r.response === 'string'
        ? r.response.slice(0, 500)
        : JSON.stringify(r.response).slice(0, 500);
      cfExec(
        `memory store --namespace reviews --key "p${phaseConfig.phase}-${r.domain}-${r.agent}-${traceId}" --value "${summary.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`,
      );
    }
  }

  return results;
}

/**
 * Record a phase failure in swarm memory.
 */
export function recordPhaseFailure(
  phaseConfig: SwarmPhaseConfig,
  traceId: string,
  error: string,
): void {
  if (!isClaudeFlowAvailable()) return;

  cfExec(
    `memory store --namespace failures --key "phase${phaseConfig.phase}-${traceId}" --value "FAILED: ${error.slice(0, 200).replace(/"/g, '\\"')}"`,
  );

  cfExec(
    `hooks post-task --task-id "phase${phaseConfig.phase}-${traceId}" --success false`,
  );
}

/**
 * Shutdown the swarm and persist metrics.
 */
export function shutdownSwarm(traceId: string, success: boolean, totalTiming: number): void {
  if (!isClaudeFlowAvailable()) return;

  console.error('  [RUFLO] Shutting down swarm and persisting metrics...');

  // Store pipeline completion in memory
  cfExec(
    `memory store --namespace pipeline --key "completed-${traceId}" --value "Pipeline ${success ? 'succeeded' : 'failed'} in ${totalTiming}ms at ${new Date().toISOString()}"`,
  );

  // Store successful pattern for future reference
  if (success) {
    cfExec(
      `memory store --namespace patterns --key "pipeline-success-${Date.now()}" --value "Full pipeline completed in ${totalTiming}ms for trace ${traceId}"`,
    );
  }

  // Export session metrics
  cfExec(
    `hooks session-end --generate-summary true --export-metrics true`,
  );

  // Shutdown the swarm
  cfExec('swarm shutdown', 15000);

  console.error('  [RUFLO] Swarm shutdown complete');
}

/**
 * Get current swarm status including agentics service stats.
 */
export function getSwarmStatus(): SwarmStatus {
  if (!isClaudeFlowAvailable()) {
    return { initialized: false, available: false, agentCount: 0, agenticsServicesInvoked: 0, tasksCompleted: 0, memoryEntries: 0 };
  }

  const status = cfExec('swarm status');
  const agentList = cfExec('agent list');
  cfExec('memory stats');

  const agentCount = agentList ? (agentList.match(/agent/gi) ?? []).length : 0;

  return {
    initialized: status !== null,
    available: true,
    agentCount,
    agenticsServicesInvoked: 0,
    tasksCompleted: 0,
    memoryEntries: 0,
  };
}
