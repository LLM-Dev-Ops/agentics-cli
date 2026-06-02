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
import { buildImplementationPrompt } from './ruflo-phase-executor.js';
import { AgentPanel, isLiveCapable } from '../cli/ui/live-status.js';
// ADR-PIPELINE-108: cloud breaker lives in a leaf module to avoid an import
// cycle (agents.ts ↔ swarm-orchestrator.ts). Re-exported below for tests that
// import CloudCircuitBreaker / CloudBreakerState from this module.
import {
  CloudCircuitBreaker,
  resolveCloudBreakerThreshold,
  type CloudBreakerState,
} from './fleet-dispatch-bounds.js';
export { CloudCircuitBreaker } from './fleet-dispatch-bounds.js';
export type { CloudBreakerState } from './fleet-dispatch-bounds.js';

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
      { domain: 'research-lab', agent: 'hypothesis', role: 'Research hypothesis tester' },
      { domain: 'research-lab', agent: 'metrics', role: 'Research KPI analyst' },
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
      { role: 'coordinator', type: 'planner', description: 'Coordinate full-fleet code generation and integration' },
      { role: 'coder', type: 'coder', description: 'Generate domain code from ADRs and DDD model' },
      { role: 'test-writer', type: 'tester', description: 'Generate test files from TDD plan' },
      { role: 'integration', type: 'backend-dev', description: 'Infer and inject integration dependencies' },
      { role: 'security', type: 'security-architect', description: 'Enforce security patterns in generated code' },
      { role: 'performance', type: 'perf-analyzer', description: 'Optimize generated code for performance' },
      { role: 'reviewer', type: 'reviewer', description: 'Final quality review of all generated artifacts' },
    ],
    agenticsServices: [
      // ── Wave 1: Code Generation (produce artifacts) ──
      { domain: 'forge', agent: 'sdk', role: 'SDK code generator' },
      { domain: 'forge', agent: 'cli', role: 'CLI scaffolding generator' },
      { domain: 'forge', agent: 'api-translation', role: 'API contract translator' },
      { domain: 'forge', agent: 'version-compat', role: 'Version compatibility checker' },
      { domain: 'connector-hub', agent: 'erp-surface', role: 'ERP integration code generator' },
      { domain: 'connector-hub', agent: 'database-query', role: 'Database layer generator' },
      { domain: 'connector-hub', agent: 'webhook-ingest', role: 'Webhook handler generator' },
      { domain: 'connector-hub', agent: 'event-normalize', role: 'Event schema normalizer' },
      { domain: 'connector-hub', agent: 'auth-identity', role: 'Auth integration generator' },

      // ── Wave 2: Architecture & Patterns (enrich artifacts) ──
      { domain: 'edge', agent: 'circuit-breaker', role: 'Circuit breaker pattern injector' },
      { domain: 'edge', agent: 'failover', role: 'Failover strategy generator' },
      { domain: 'edge', agent: 'execution-guard', role: 'Execution guard generator' },
      { domain: 'edge', agent: 'caching', role: 'Cache layer generator' },
      { domain: 'orchestrator', agent: 'workflow', role: 'Workflow orchestration code' },
      { domain: 'orchestrator', agent: 'retry', role: 'Retry strategy generator' },
      { domain: 'orchestrator', agent: 'state-machine', role: 'State machine generator' },
      { domain: 'orchestrator', agent: 'parallel', role: 'Parallel execution planner' },

      // ── Wave 3: Observability & Monitoring (instrument artifacts) ──
      { domain: 'observatory', agent: 'telemetry', role: 'OpenTelemetry instrumentation generator' },
      { domain: 'observatory', agent: 'health-check', role: 'Health check endpoint generator' },
      { domain: 'observatory', agent: 'slo', role: 'SLO definition generator' },
      { domain: 'observatory', agent: 'visualization', role: 'Dashboard config generator' },
      { domain: 'sentinel', agent: 'anomaly', role: 'Anomaly detection pattern generator' },
      { domain: 'sentinel', agent: 'alert', role: 'Alert rule generator' },
      { domain: 'sentinel', agent: 'drift', role: 'Drift detection generator' },

      // ── Wave 4: Security & Governance (validate artifacts) ──
      { domain: 'shield', agent: 'secrets', role: 'Secrets scanner' },
      { domain: 'shield', agent: 'pii', role: 'PII detector' },
      { domain: 'shield', agent: 'credential-exposure', role: 'Credential exposure scanner' },
      { domain: 'shield', agent: 'prompt-injection', role: 'Injection vulnerability scanner' },
      { domain: 'shield', agent: 'safety-boundary', role: 'Safety boundary validator' },
      { domain: 'policy-engine', agent: 'enforce', role: 'Policy compliance enforcer' },
      { domain: 'policy-engine', agent: 'constraints', role: 'Architecture constraint validator' },
      { domain: 'governance-dashboard', agent: 'audit', role: 'Code audit trail generator' },
      { domain: 'governance-dashboard', agent: 'impact', role: 'Change impact assessor' },
      { domain: 'data-vault', agent: 'access-control', role: 'Access control code generator' },

      // ── Wave 5: Quality & Testing (evaluate artifacts) ──
      { domain: 'test-bench', agent: 'quality', role: 'Code quality evaluator' },
      { domain: 'test-bench', agent: 'benchmark', role: 'Performance benchmark runner' },
      { domain: 'test-bench', agent: 'regression', role: 'Regression test generator' },
      { domain: 'test-bench', agent: 'hallucination', role: 'Code hallucination detector' },
      { domain: 'test-bench', agent: 'faithfulness', role: 'Spec faithfulness evaluator' },
      { domain: 'test-bench', agent: 'synthetic-data', role: 'Test data generator' },
      { domain: 'test-bench', agent: 'golden-dataset', role: 'Golden dataset builder' },
      { domain: 'schema-registry', agent: 'validate', role: 'Schema validator' },
      { domain: 'config-manager', agent: 'validate', role: 'Config validator' },

      // ── Wave 6: Intelligence & Reasoning (optimize artifacts) ──
      { domain: 'copilot', agent: 'planner', role: 'Implementation planner' },
      { domain: 'copilot', agent: 'decomposer', role: 'Code architecture decomposer' },
      { domain: 'copilot', agent: 'meta-reasoner', role: 'Architecture meta-reasoner' },
      { domain: 'copilot', agent: 'reflection', role: 'Code quality reflector' },
      { domain: 'copilot', agent: 'intent', role: 'Implementation intent classifier' },
      { domain: 'research-lab', agent: 'metrics', role: 'Implementation KPI analyst' },
      { domain: 'platform', agent: 'risk-score', role: 'Implementation risk scorer' },
      { domain: 'platform', agent: 'decision', role: 'Go/no-go quality gate' },
      { domain: 'costops', agent: 'roi', role: 'Implementation ROI calculator' },
      { domain: 'costops', agent: 'tradeoff', role: 'Cost-quality tradeoff analyst' },
      { domain: 'memory-graph', agent: 'knowledge-graph', role: 'Implementation knowledge tracker' },
      { domain: 'memory-graph', agent: 'patterns', role: 'Code pattern learner' },
      { domain: 'auto-optimizer', agent: 'self-optimize', role: 'Build process optimizer' },
      { domain: 'latency-lens', agent: 'latency', role: 'Code latency profiler' },
      { domain: 'inference-gateway', agent: 'route', role: 'Model routing optimizer' },
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
      { domain: 'connector-hub', agent: 'webhook-ingest', role: 'Webhook integration code' },
      { domain: 'forge', agent: 'sdk', role: 'ERP SDK generator' },
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
    keywords: ['healthcare', 'health', 'pharma', 'clinical', 'patient', 'medical', 'ehr', 'hl7', 'fhir', 'dicom', 'hipaa'],
    agents: [
      { domain: 'shield', agent: 'pii', role: 'PHI/PII scanner' },
      { domain: 'data-vault', agent: 'anonymize', role: 'Patient data anonymizer' },
      { domain: 'governance-dashboard', agent: 'audit', role: 'Healthcare compliance auditor' },
      { domain: 'policy-engine', agent: 'enforce', role: 'HIPAA policy enforcer' },
      { domain: 'data-vault', agent: 'access-control', role: 'Healthcare access control' },
    ],
  },
  // ── Life Sciences / Biotech ──
  {
    keywords: ['biotech', 'life science', 'genomics', 'gene', 'crispr', 'protein', 'drug discovery', 'clinical trial', 'fda', 'gmp', 'cro', 'bioinformatics'],
    agents: [
      { domain: 'governance-dashboard', agent: 'audit', role: 'FDA/GMP compliance auditor' },
      { domain: 'data-vault', agent: 'anonymize', role: 'Clinical trial data anonymizer' },
      { domain: 'shield', agent: 'pii', role: 'Patient trial PII scanner' },
      { domain: 'research-lab', agent: 'hypothesis', role: 'Drug discovery hypothesis tester' },
      { domain: 'orchestrator', agent: 'workflow', role: 'Clinical trial pipeline orchestrator' },
      { domain: 'policy-engine', agent: 'enforce', role: 'GxP regulatory enforcer' },
    ],
  },
  // ── Medical Devices / MedTech ──
  {
    keywords: ['medical device', 'medtech', 'wearable', 'diagnostic', 'imaging', 'prosthetic', 'iec 62304', 'class ii', 'class iii', 'premarket'],
    agents: [
      { domain: 'governance-dashboard', agent: 'audit', role: 'Medical device regulatory auditor' },
      { domain: 'policy-engine', agent: 'enforce', role: 'IEC 62304 compliance enforcer' },
      { domain: 'observatory', agent: 'telemetry', role: 'Device telemetry designer' },
      { domain: 'sentinel', agent: 'anomaly', role: 'Device anomaly detector' },
      { domain: 'shield', agent: 'pii', role: 'Patient device data scanner' },
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
  // ── Capital Markets / Trading ──
  {
    keywords: ['trading', 'capital market', 'stock', 'bond', 'derivative', 'portfolio', 'hedge fund', 'quant', 'algorithmic trading', 'fix protocol', 'settlement'],
    agents: [
      { domain: 'sentinel', agent: 'anomaly', role: 'Trade anomaly detector' },
      { domain: 'latency-lens', agent: 'latency', role: 'Trade execution latency profiler' },
      { domain: 'simulator', agent: 'scenario', role: 'Market scenario simulator' },
      { domain: 'governance-dashboard', agent: 'audit', role: 'Trade compliance auditor' },
      { domain: 'research-lab', agent: 'metrics', role: 'Portfolio metrics analyst' },
    ],
  },
  // ── Cryptocurrency / Blockchain / Web3 ──
  {
    keywords: ['crypto', 'blockchain', 'web3', 'defi', 'nft', 'smart contract', 'solidity', 'ethereum', 'bitcoin', 'token', 'wallet', 'dao'],
    agents: [
      { domain: 'sentinel', agent: 'anomaly', role: 'On-chain anomaly detector' },
      { domain: 'shield', agent: 'secrets', role: 'Private key exposure scanner' },
      { domain: 'governance-dashboard', agent: 'audit', role: 'Smart contract auditor' },
      { domain: 'simulator', agent: 'scenario', role: 'DeFi scenario simulator' },
      { domain: 'edge', agent: 'circuit-breaker', role: 'Transaction circuit breaker' },
    ],
  },
  // ── Payments / Digital Banking ──
  {
    keywords: ['payment gateway', 'stripe', 'plaid', 'open banking', 'psd2', 'digital bank', 'neobank', 'remittance', 'swift', 'ach', 'sepa', 'kyc', 'aml'],
    agents: [
      { domain: 'sentinel', agent: 'anomaly', role: 'Payment fraud detector' },
      { domain: 'policy-engine', agent: 'enforce', role: 'KYC/AML policy enforcer' },
      { domain: 'shield', agent: 'pii', role: 'Financial PII scanner' },
      { domain: 'connector-hub', agent: 'auth-identity', role: 'Payment identity connector' },
      { domain: 'governance-dashboard', agent: 'audit', role: 'Payment compliance auditor' },
    ],
  },
  // ── Insurance ──
  {
    keywords: ['insurance', 'insurtech', 'claim', 'underwriting', 'policy', 'actuary', 'premium', 'coverage', 'reinsurance'],
    agents: [
      { domain: 'sentinel', agent: 'anomaly', role: 'Claims fraud detector' },
      { domain: 'governance-dashboard', agent: 'audit', role: 'Insurance compliance auditor' },
      { domain: 'simulator', agent: 'scenario', role: 'Risk scenario simulator' },
      { domain: 'platform', agent: 'risk-score', role: 'Underwriting risk scorer' },
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
  // ── Automotive / Mobility ──
  {
    keywords: ['automotive', 'vehicle', 'car', 'fleet', 'connected car', 'adas', 'autonomous', 'ev', 'charging', 'telematics', 'oem'],
    agents: [
      { domain: 'observatory', agent: 'telemetry', role: 'Vehicle telemetry designer' },
      { domain: 'sentinel', agent: 'anomaly', role: 'Fleet anomaly detector' },
      { domain: 'connector-hub', agent: 'event-normalize', role: 'Telematics event normalizer' },
      { domain: 'edge', agent: 'caching', role: 'Edge compute cache for vehicles' },
      { domain: 'simulator', agent: 'scenario', role: 'Autonomous driving scenario simulator' },
    ],
  },
  // ── Aerospace / Defense ──
  {
    keywords: ['aerospace', 'defense', 'aviation', 'satellite', 'drone', 'radar', 'missile', 'military', 'nato', 'itar', 'space'],
    agents: [
      { domain: 'governance-dashboard', agent: 'audit', role: 'ITAR/defense compliance auditor' },
      { domain: 'policy-engine', agent: 'enforce', role: 'Classified data policy enforcer' },
      { domain: 'data-vault', agent: 'access-control', role: 'Defense-grade access control' },
      { domain: 'sentinel', agent: 'anomaly', role: 'Threat anomaly detector' },
      { domain: 'observatory', agent: 'telemetry', role: 'Mission telemetry designer' },
      { domain: 'shield', agent: 'secrets', role: 'Classified secrets scanner' },
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
  // ── Food & Beverage / AgriTech ──
  {
    keywords: ['food', 'beverage', 'restaurant', 'agritech', 'agriculture', 'farm', 'crop', 'livestock', 'food safety', 'haccp', 'traceability'],
    agents: [
      { domain: 'connector-hub', agent: 'erp-surface', role: 'Food supply chain ERP connector' },
      { domain: 'governance-dashboard', agent: 'audit', role: 'Food safety compliance auditor' },
      { domain: 'sentinel', agent: 'anomaly', role: 'Supply chain anomaly detector' },
      { domain: 'orchestrator', agent: 'workflow', role: 'Traceability workflow' },
      { domain: 'observatory', agent: 'telemetry', role: 'AgriTech sensor telemetry' },
    ],
  },
  // ── Hospitality / Travel ──
  {
    keywords: ['hospitality', 'hotel', 'travel', 'booking', 'reservation', 'airline', 'tourism', 'cruise', 'pms', 'ota'],
    agents: [
      { domain: 'latency-lens', agent: 'latency', role: 'Booking latency profiler' },
      { domain: 'sentinel', agent: 'anomaly', role: 'Booking fraud detector' },
      { domain: 'auto-optimizer', agent: 'self-optimize', role: 'Revenue management optimizer' },
      { domain: 'edge', agent: 'caching', role: 'Availability cache' },
      { domain: 'research-lab', agent: 'metrics', role: 'Occupancy/revenue metrics analyst' },
    ],
  },
  // ── Real Estate / PropTech ──
  {
    keywords: ['real estate', 'proptech', 'property', 'mortgage', 'lease', 'tenant', 'building', 'smart building', 'bms', 'reit'],
    agents: [
      { domain: 'connector-hub', agent: 'erp-surface', role: 'Property management ERP connector' },
      { domain: 'sentinel', agent: 'anomaly', role: 'Lease anomaly detector' },
      { domain: 'observatory', agent: 'telemetry', role: 'Smart building telemetry' },
      { domain: 'simulator', agent: 'scenario', role: 'Investment scenario simulator' },
      { domain: 'research-lab', agent: 'metrics', role: 'Portfolio performance analyst' },
    ],
  },
  // ── Construction / Engineering ──
  {
    keywords: ['construction', 'engineering', 'civil', 'architecture', 'bim', 'project management', 'contractor', 'blueprint', 'site'],
    agents: [
      { domain: 'orchestrator', agent: 'workflow', role: 'Construction project workflow' },
      { domain: 'orchestrator', agent: 'scheduler', role: 'Project scheduling' },
      { domain: 'orchestrator', agent: 'dependencies', role: 'Task dependency tracker' },
      { domain: 'simulator', agent: 'scenario', role: 'Project risk simulator' },
      { domain: 'governance-dashboard', agent: 'audit', role: 'Safety compliance auditor' },
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
  // ── Gaming / Entertainment ──
  {
    keywords: ['gaming', 'game', 'esports', 'multiplayer', 'matchmaking', 'leaderboard', 'virtual world', 'metaverse', 'unity', 'unreal'],
    agents: [
      { domain: 'latency-lens', agent: 'latency', role: 'Real-time gaming latency profiler' },
      { domain: 'latency-lens', agent: 'cold-start', role: 'Matchmaking cold-start optimizer' },
      { domain: 'sentinel', agent: 'anomaly', role: 'Cheating/exploit anomaly detector' },
      { domain: 'shield', agent: 'toxicity', role: 'In-game toxicity scanner' },
      { domain: 'shield', agent: 'abuse', role: 'Player abuse detector' },
      { domain: 'edge', agent: 'caching', role: 'Game state cache' },
    ],
  },
  // ── Publishing / Digital Media ──
  {
    keywords: ['publishing', 'cms', 'content management', 'editorial', 'news', 'magazine', 'blog', 'journalism', 'digital media', 'paywall'],
    agents: [
      { domain: 'shield', agent: 'toxicity', role: 'Content moderation scanner' },
      { domain: 'shield', agent: 'moderation', role: 'Editorial moderation' },
      { domain: 'edge', agent: 'caching', role: 'Content delivery cache' },
      { domain: 'auto-optimizer', agent: 'self-optimize', role: 'Content delivery optimizer' },
      { domain: 'research-lab', agent: 'metrics', role: 'Engagement metrics analyst' },
    ],
  },
  // ── Advertising / MarTech ──
  {
    keywords: ['advertising', 'adtech', 'martech', 'campaign', 'attribution', 'programmatic', 'dsp', 'ssp', 'cpm', 'ctr', 'retargeting'],
    agents: [
      { domain: 'sentinel', agent: 'anomaly', role: 'Ad fraud anomaly detector' },
      { domain: 'research-lab', agent: 'metrics', role: 'Campaign performance analyst' },
      { domain: 'data-vault', agent: 'anonymize', role: 'User data anonymizer' },
      { domain: 'shield', agent: 'pii', role: 'Audience PII scanner' },
      { domain: 'latency-lens', agent: 'latency', role: 'Ad serving latency profiler' },
      { domain: 'auto-optimizer', agent: 'self-optimize', role: 'Campaign budget optimizer' },
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
  // ── Oil & Gas / Mining ──
  {
    keywords: ['oil', 'gas', 'mining', 'petroleum', 'refinery', 'pipeline', 'drilling', 'upstream', 'downstream', 'midstream', 'mineral'],
    agents: [
      { domain: 'observatory', agent: 'telemetry', role: 'Field telemetry designer' },
      { domain: 'sentinel', agent: 'anomaly', role: 'Equipment anomaly detector' },
      { domain: 'governance-dashboard', agent: 'audit', role: 'Environmental compliance auditor' },
      { domain: 'simulator', agent: 'scenario', role: 'Extraction scenario planner' },
      { domain: 'edge', agent: 'circuit-breaker', role: 'Safety circuit breaker' },
    ],
  },
  // ── CleanTech / Sustainability ──
  {
    keywords: ['cleantech', 'sustainability', 'carbon', 'emission', 'esg', 'carbon credit', 'circular economy', 'recycle', 'green', 'net zero'],
    agents: [
      { domain: 'research-lab', agent: 'metrics', role: 'ESG metrics analyst' },
      { domain: 'governance-dashboard', agent: 'audit', role: 'ESG compliance auditor' },
      { domain: 'observatory', agent: 'telemetry', role: 'Emissions telemetry designer' },
      { domain: 'simulator', agent: 'scenario', role: 'Carbon reduction scenario simulator' },
      { domain: 'platform', agent: 'executive-summary', role: 'Sustainability reporting' },
    ],
  },
  // ── Education / EdTech ──
  {
    keywords: ['education', 'edtech', 'learning', 'student', 'curriculum', 'lms', 'course', 'mooc', 'e-learning'],
    agents: [
      { domain: 'test-bench', agent: 'bias', role: 'Educational bias detector' },
      { domain: 'shield', agent: 'toxicity', role: 'Content safety scanner' },
      { domain: 'data-vault', agent: 'anonymize', role: 'Student data anonymizer' },
      { domain: 'research-lab', agent: 'metrics', role: 'Learning metrics analyst' },
    ],
  },
  // ── HR / Workforce / Talent ──
  {
    keywords: ['hr', 'human resource', 'talent', 'recruitment', 'hiring', 'payroll', 'workforce', 'employee', 'onboarding', 'benefits', 'hris', 'ats'],
    agents: [
      { domain: 'test-bench', agent: 'bias', role: 'Hiring bias detector' },
      { domain: 'shield', agent: 'pii', role: 'Employee PII scanner' },
      { domain: 'data-vault', agent: 'anonymize', role: 'Employee data anonymizer' },
      { domain: 'connector-hub', agent: 'erp-surface', role: 'HRIS/ERP connector' },
      { domain: 'policy-engine', agent: 'enforce', role: 'Labor law policy enforcer' },
    ],
  },
  // ── Legal / LegalTech ──
  {
    keywords: ['legal', 'legaltech', 'contract', 'litigation', 'compliance', 'regulatory', 'patent', 'trademark', 'nda', 'clause', 'eDiscovery'],
    agents: [
      { domain: 'governance-dashboard', agent: 'audit', role: 'Legal compliance auditor' },
      { domain: 'shield', agent: 'pii', role: 'Legal document PII scanner' },
      { domain: 'data-vault', agent: 'access-control', role: 'Attorney-client privilege access control' },
      { domain: 'memory-graph', agent: 'knowledge-graph', role: 'Legal precedent knowledge graph' },
      { domain: 'policy-engine', agent: 'enforce', role: 'Contract clause enforcer' },
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
  // ── Defense / Intelligence ──
  {
    keywords: ['intelligence', 'sigint', 'osint', 'classified', 'security clearance', 'dod', 'fedramp', 'il4', 'il5', 'cmmc', 'nist 800'],
    agents: [
      { domain: 'governance-dashboard', agent: 'audit', role: 'FedRAMP/CMMC auditor' },
      { domain: 'policy-engine', agent: 'enforce', role: 'NIST 800-53 enforcer' },
      { domain: 'data-vault', agent: 'access-control', role: 'Clearance-based access control' },
      { domain: 'shield', agent: 'secrets', role: 'Classified data scanner' },
      { domain: 'shield', agent: 'credential-exposure', role: 'Credential exposure scanner' },
      { domain: 'data-vault', agent: 'anonymize', role: 'Intelligence data anonymizer' },
    ],
  },
  // ── Non-Profit / NGO ──
  {
    keywords: ['nonprofit', 'non-profit', 'ngo', 'charity', 'donation', 'grant', 'foundation', 'humanitarian', 'aid'],
    agents: [
      { domain: 'governance-dashboard', agent: 'audit', role: 'Grant compliance auditor' },
      { domain: 'governance-dashboard', agent: 'oversight', role: 'Donor oversight' },
      { domain: 'costops', agent: 'budget', role: 'Grant budget planner' },
      { domain: 'shield', agent: 'pii', role: 'Beneficiary PII scanner' },
      { domain: 'platform', agent: 'executive-summary', role: 'Impact reporting' },
    ],
  },
  // ── Logistics / Shipping / Freight ──
  {
    keywords: ['logistics', 'shipping', 'freight', 'last mile', 'delivery', 'courier', 'port', 'container', 'customs', 'tracking'],
    agents: [
      { domain: 'orchestrator', agent: 'workflow', role: 'Shipment workflow orchestrator' },
      { domain: 'sentinel', agent: 'anomaly', role: 'Delivery anomaly detector' },
      { domain: 'observatory', agent: 'telemetry', role: 'Fleet tracking telemetry' },
      { domain: 'simulator', agent: 'scenario', role: 'Route optimization simulator' },
      { domain: 'connector-hub', agent: 'event-normalize', role: 'Shipment event normalizer' },
    ],
  },
  // ── Telecommunications Infrastructure ──
  {
    keywords: ['network infrastructure', 'fiber', 'cell tower', 'spectrum', 'sdwan', 'nfv', 'sdn', 'oss', 'bss', 'network slicing'],
    agents: [
      { domain: 'observatory', agent: 'telemetry', role: 'Network infrastructure telemetry' },
      { domain: 'sentinel', agent: 'anomaly', role: 'Infrastructure anomaly detector' },
      { domain: 'latency-lens', agent: 'latency', role: 'Network latency profiler' },
      { domain: 'edge', agent: 'circuit-breaker', role: 'Network circuit breaker' },
      { domain: 'simulator', agent: 'scenario', role: 'Capacity planning simulator' },
    ],
  },
  // ── Cybersecurity / InfoSec ──
  {
    keywords: ['cybersecurity', 'infosec', 'soc', 'siem', 'threat intelligence', 'penetration test', 'vulnerability', 'zero trust', 'xdr', 'edr'],
    agents: [
      { domain: 'shield', agent: 'prompt-injection', role: 'Injection scanner' },
      { domain: 'shield', agent: 'secrets', role: 'Secrets leak detector' },
      { domain: 'shield', agent: 'credential-exposure', role: 'Credential scanner' },
      { domain: 'sentinel', agent: 'anomaly', role: 'Security anomaly detector' },
      { domain: 'sentinel', agent: 'rca', role: 'Incident root-cause analyzer' },
      { domain: 'governance-dashboard', agent: 'audit', role: 'Security posture auditor' },
    ],
  },
  // ── Robotics / Industrial Automation ──
  {
    keywords: ['robotics', 'robot', 'automation', 'plc', 'actuator', 'sensor network', 'cobot', 'ros', 'industrial automation'],
    agents: [
      { domain: 'observatory', agent: 'telemetry', role: 'Robot telemetry designer' },
      { domain: 'sentinel', agent: 'anomaly', role: 'Equipment fault detector' },
      { domain: 'edge', agent: 'execution-guard', role: 'Safety execution guard' },
      { domain: 'simulator', agent: 'scenario', role: 'Automation scenario simulator' },
      { domain: 'connector-hub', agent: 'event-normalize', role: 'Sensor event normalizer' },
    ],
  },
  // ── Smart City / Urban Tech ──
  {
    keywords: ['smart city', 'urban', 'traffic', 'parking', 'waste management', 'public transit', 'street light', 'municipal iot'],
    agents: [
      { domain: 'observatory', agent: 'telemetry', role: 'City sensor telemetry' },
      { domain: 'sentinel', agent: 'anomaly', role: 'Urban anomaly detector' },
      { domain: 'simulator', agent: 'scenario', role: 'Urban planning simulator' },
      { domain: 'orchestrator', agent: 'workflow', role: 'City service workflow' },
      { domain: 'data-vault', agent: 'anonymize', role: 'Citizen movement data anonymizer' },
    ],
  },
  // ── Fitness / Wellness / HealthTech ──
  {
    keywords: ['fitness', 'wellness', 'health app', 'wearable', 'biometric', 'nutrition', 'mental health', 'telehealth', 'telemedicine'],
    agents: [
      { domain: 'shield', agent: 'pii', role: 'Health data PII scanner' },
      { domain: 'data-vault', agent: 'anonymize', role: 'Biometric data anonymizer' },
      { domain: 'policy-engine', agent: 'enforce', role: 'Health data regulation enforcer' },
      { domain: 'observatory', agent: 'telemetry', role: 'Wearable telemetry designer' },
      { domain: 'research-lab', agent: 'metrics', role: 'Wellness metrics analyst' },
    ],
  },
  // ── Social Media / Community Platforms ──
  {
    keywords: ['social media', 'social network', 'community', 'forum', 'user generated content', 'ugc', 'influencer', 'feed', 'timeline'],
    agents: [
      { domain: 'shield', agent: 'toxicity', role: 'Community toxicity scanner' },
      { domain: 'shield', agent: 'abuse', role: 'Platform abuse detector' },
      { domain: 'shield', agent: 'moderation', role: 'Content moderator' },
      { domain: 'shield', agent: 'pii', role: 'User data PII scanner' },
      { domain: 'sentinel', agent: 'anomaly', role: 'Bot/spam anomaly detector' },
      { domain: 'data-vault', agent: 'anonymize', role: 'User data anonymizer' },
    ],
  },
  // ── SaaS / B2B Software ──
  {
    keywords: ['saas', 'b2b', 'multi-tenant', 'subscription', 'churn', 'onboarding', 'product-led', 'usage-based', 'seat license'],
    agents: [
      { domain: 'observatory', agent: 'usage-patterns', role: 'Product usage analyst' },
      { domain: 'sentinel', agent: 'anomaly', role: 'Churn anomaly detector' },
      { domain: 'research-lab', agent: 'metrics', role: 'SaaS metrics analyst' },
      { domain: 'costops', agent: 'roi', role: 'Customer ROI calculator' },
      { domain: 'auto-optimizer', agent: 'self-optimize', role: 'Onboarding optimizer' },
    ],
  },
  // ── Marketplace / Platform Economy ──
  {
    keywords: ['marketplace platform', 'two-sided', 'gig economy', 'sharing economy', 'peer-to-peer', 'p2p', 'escrow', 'rating', 'matching'],
    agents: [
      { domain: 'sentinel', agent: 'anomaly', role: 'Marketplace fraud detector' },
      { domain: 'shield', agent: 'abuse', role: 'Seller/buyer abuse detector' },
      { domain: 'auto-optimizer', agent: 'self-optimize', role: 'Matching optimizer' },
      { domain: 'research-lab', agent: 'metrics', role: 'Marketplace liquidity analyst' },
      { domain: 'policy-engine', agent: 'enforce', role: 'Platform terms enforcer' },
    ],
  },
  // ── Quantum Computing ──
  {
    keywords: ['quantum', 'qubit', 'quantum computing', 'quantum circuit', 'qiskit', 'cirq', 'quantum-safe', 'post-quantum'],
    agents: [
      { domain: 'research-lab', agent: 'hypothesis', role: 'Quantum hypothesis tester' },
      { domain: 'simulator', agent: 'scenario', role: 'Quantum circuit simulator' },
      { domain: 'shield', agent: 'secrets', role: 'Post-quantum cryptography scanner' },
      { domain: 'test-bench', agent: 'benchmark', role: 'Quantum performance benchmarker' },
    ],
  },
  // ── AR / VR / Spatial Computing ──
  {
    keywords: ['ar', 'vr', 'augmented reality', 'virtual reality', 'spatial computing', 'xr', 'mixed reality', 'hololens', 'vision pro', '3d'],
    agents: [
      { domain: 'latency-lens', agent: 'latency', role: 'XR latency profiler' },
      { domain: 'latency-lens', agent: 'cold-start', role: 'Scene load cold-start optimizer' },
      { domain: 'edge', agent: 'caching', role: 'Asset streaming cache' },
      { domain: 'observatory', agent: 'telemetry', role: 'Spatial telemetry designer' },
    ],
  },
  // ── Voice / Conversational AI ──
  {
    keywords: ['voice', 'conversational', 'chatbot', 'ivr', 'speech', 'nlu', 'dialog', 'alexa', 'siri', 'contact center', 'call center'],
    agents: [
      { domain: 'shield', agent: 'toxicity', role: 'Conversation toxicity scanner' },
      { domain: 'shield', agent: 'pii', role: 'Conversation PII scanner' },
      { domain: 'latency-lens', agent: 'latency', role: 'Voice response latency profiler' },
      { domain: 'test-bench', agent: 'hallucination', role: 'Chatbot hallucination detector' },
      { domain: 'test-bench', agent: 'faithfulness', role: 'Response faithfulness checker' },
    ],
  },
  // ── Document Processing / RPA ──
  {
    keywords: ['document processing', 'ocr', 'rpa', 'robotic process', 'pdf extraction', 'invoice processing', 'form recognition', 'idp'],
    agents: [
      { domain: 'orchestrator', agent: 'workflow', role: 'Document processing workflow' },
      { domain: 'shield', agent: 'pii', role: 'Document PII scanner' },
      { domain: 'connector-hub', agent: 'erp-surface', role: 'ERP document connector' },
      { domain: 'data-vault', agent: 'anonymize', role: 'Document data anonymizer' },
    ],
  },
  // ── Geospatial / GIS / Location ──
  {
    keywords: ['geospatial', 'gis', 'location', 'mapping', 'gps', 'geofence', 'coordinates', 'spatial data', 'imagery'],
    agents: [
      { domain: 'observatory', agent: 'telemetry', role: 'Location telemetry designer' },
      { domain: 'data-vault', agent: 'anonymize', role: 'Location data anonymizer' },
      { domain: 'sentinel', agent: 'anomaly', role: 'Geofence anomaly detector' },
      { domain: 'simulator', agent: 'scenario', role: 'Spatial scenario simulator' },
    ],
  },
  // ── Climate / Weather / Environmental ──
  {
    keywords: ['climate', 'weather', 'environmental', 'flood', 'wildfire', 'hurricane', 'seismic', 'ocean', 'atmosphere', 'meteorology'],
    agents: [
      { domain: 'observatory', agent: 'telemetry', role: 'Environmental sensor telemetry' },
      { domain: 'sentinel', agent: 'anomaly', role: 'Environmental anomaly detector' },
      { domain: 'simulator', agent: 'scenario', role: 'Climate scenario simulator' },
      { domain: 'sentinel', agent: 'alert', role: 'Weather alert rule engine' },
    ],
  },
  // ── Sports / Sports Analytics ──
  {
    keywords: ['sports', 'sports analytics', 'athlete', 'fantasy sports', 'betting', 'wager', 'stadium', 'match', 'tournament'],
    agents: [
      { domain: 'research-lab', agent: 'metrics', role: 'Sports analytics metrics' },
      { domain: 'sentinel', agent: 'anomaly', role: 'Betting anomaly detector' },
      { domain: 'latency-lens', agent: 'latency', role: 'Live streaming latency profiler' },
      { domain: 'edge', agent: 'caching', role: 'Live score cache' },
    ],
  },
  // ── Music / Audio / Podcast ──
  {
    keywords: ['music', 'audio', 'podcast', 'streaming audio', 'royalty', 'licensing', 'playlist', 'daw', 'studio'],
    agents: [
      { domain: 'governance-dashboard', agent: 'audit', role: 'Royalty/licensing auditor' },
      { domain: 'edge', agent: 'caching', role: 'Audio streaming cache' },
      { domain: 'shield', agent: 'moderation', role: 'Audio content moderator' },
      { domain: 'research-lab', agent: 'metrics', role: 'Listening engagement analyst' },
    ],
  },
  // ── Photography / Visual Media ──
  {
    keywords: ['photography', 'image', 'photo', 'visual media', 'stock photo', 'dam', 'digital asset', 'watermark'],
    agents: [
      { domain: 'shield', agent: 'moderation', role: 'Image content moderator' },
      { domain: 'edge', agent: 'caching', role: 'Image CDN cache' },
      { domain: 'data-vault', agent: 'access-control', role: 'Digital asset access control' },
      { domain: 'governance-dashboard', agent: 'audit', role: 'License compliance auditor' },
    ],
  },
  // ── Pharmaceutical Distribution / Pharmacy ──
  {
    keywords: ['pharmacy', 'prescription', 'dispensing', 'drug interaction', 'formulary', 'dscsa', 'serialization', 'cold chain'],
    agents: [
      { domain: 'governance-dashboard', agent: 'audit', role: 'DSCSA compliance auditor' },
      { domain: 'sentinel', agent: 'anomaly', role: 'Diversion anomaly detector' },
      { domain: 'orchestrator', agent: 'workflow', role: 'Prescription workflow' },
      { domain: 'observatory', agent: 'telemetry', role: 'Cold chain telemetry' },
      { domain: 'shield', agent: 'pii', role: 'Patient prescription PII scanner' },
    ],
  },
  // ── Veterinary / Animal Health ──
  {
    keywords: ['veterinary', 'vet', 'animal health', 'pet', 'livestock health', 'pet insurance'],
    agents: [
      { domain: 'shield', agent: 'pii', role: 'Pet owner PII scanner' },
      { domain: 'connector-hub', agent: 'erp-surface', role: 'Veterinary practice ERP connector' },
      { domain: 'research-lab', agent: 'metrics', role: 'Animal health metrics analyst' },
      { domain: 'orchestrator', agent: 'workflow', role: 'Clinical workflow' },
    ],
  },
  // ── Chemical / Materials Science ──
  {
    keywords: ['chemical', 'material science', 'polymer', 'compound', 'reagent', 'lab', 'formulation', 'r&d', 'lims'],
    agents: [
      { domain: 'governance-dashboard', agent: 'audit', role: 'Chemical safety compliance auditor' },
      { domain: 'observatory', agent: 'telemetry', role: 'Lab instrument telemetry' },
      { domain: 'research-lab', agent: 'hypothesis', role: 'Materials hypothesis tester' },
      { domain: 'policy-engine', agent: 'enforce', role: 'Hazardous material policy enforcer' },
    ],
  },
  // ── Luxury / Fashion ──
  {
    keywords: ['luxury', 'fashion', 'apparel', 'haute couture', 'brand', 'counterfeit', 'authenticity', 'supply chain traceability'],
    agents: [
      { domain: 'sentinel', agent: 'anomaly', role: 'Counterfeit detection anomaly scanner' },
      { domain: 'governance-dashboard', agent: 'audit', role: 'Supply chain provenance auditor' },
      { domain: 'edge', agent: 'caching', role: 'Product catalog cache' },
      { domain: 'research-lab', agent: 'metrics', role: 'Brand performance analyst' },
    ],
  },
  // ── Elections / Democracy Tech ──
  {
    keywords: ['election', 'vote', 'ballot', 'poll', 'democracy', 'civic tech', 'voter registration'],
    agents: [
      { domain: 'governance-dashboard', agent: 'audit', role: 'Election integrity auditor' },
      { domain: 'governance-dashboard', agent: 'oversight', role: 'Voting oversight' },
      { domain: 'shield', agent: 'pii', role: 'Voter PII scanner' },
      { domain: 'sentinel', agent: 'anomaly', role: 'Ballot anomaly detector' },
      { domain: 'data-vault', agent: 'access-control', role: 'Election data access control' },
    ],
  },
  // ── Cannabis / Regulated Substances ──
  {
    keywords: ['cannabis', 'marijuana', 'dispensary', 'seed-to-sale', 'metrc', 'regulated substance', 'controlled substance'],
    agents: [
      { domain: 'governance-dashboard', agent: 'audit', role: 'Regulatory compliance auditor' },
      { domain: 'orchestrator', agent: 'workflow', role: 'Seed-to-sale tracking workflow' },
      { domain: 'sentinel', agent: 'anomaly', role: 'Diversion anomaly detector' },
      { domain: 'policy-engine', agent: 'enforce', role: 'State regulation enforcer' },
    ],
  },
  // ── Marine / Maritime ──
  {
    keywords: ['marine', 'maritime', 'shipping lane', 'port authority', 'vessel', 'ais', 'imo', 'coast guard', 'offshore'],
    agents: [
      { domain: 'observatory', agent: 'telemetry', role: 'Vessel tracking telemetry' },
      { domain: 'sentinel', agent: 'anomaly', role: 'Maritime anomaly detector' },
      { domain: 'governance-dashboard', agent: 'audit', role: 'IMO compliance auditor' },
      { domain: 'simulator', agent: 'scenario', role: 'Route planning simulator' },
    ],
  },
  // ── Waste Management / Recycling ──
  {
    keywords: ['waste', 'recycling', 'waste management', 'landfill', 'composting', 'hazardous waste', 'circular'],
    agents: [
      { domain: 'orchestrator', agent: 'workflow', role: 'Collection route workflow' },
      { domain: 'observatory', agent: 'telemetry', role: 'Bin sensor telemetry' },
      { domain: 'governance-dashboard', agent: 'audit', role: 'Environmental compliance auditor' },
      { domain: 'simulator', agent: 'scenario', role: 'Capacity planning simulator' },
    ],
  },
  // ── Water / Wastewater ──
  {
    keywords: ['water', 'wastewater', 'water treatment', 'desalination', 'irrigation', 'water quality', 'aquifer'],
    agents: [
      { domain: 'observatory', agent: 'telemetry', role: 'Water quality telemetry' },
      { domain: 'sentinel', agent: 'anomaly', role: 'Water contamination anomaly detector' },
      { domain: 'sentinel', agent: 'alert', role: 'Water quality alert engine' },
      { domain: 'governance-dashboard', agent: 'audit', role: 'EPA compliance auditor' },
    ],
  },
  // ── Nuclear ──
  {
    keywords: ['nuclear', 'reactor', 'nuclear power', 'radiation', 'isotope', 'nrc', 'decommission'],
    agents: [
      { domain: 'governance-dashboard', agent: 'audit', role: 'NRC compliance auditor' },
      { domain: 'policy-engine', agent: 'enforce', role: 'Nuclear safety policy enforcer' },
      { domain: 'observatory', agent: 'telemetry', role: 'Radiation monitoring telemetry' },
      { domain: 'sentinel', agent: 'anomaly', role: 'Reactor anomaly detector' },
      { domain: 'edge', agent: 'circuit-breaker', role: 'Safety shutdown circuit breaker' },
    ],
  },
  // ── Childcare / Family Services ──
  {
    keywords: ['childcare', 'daycare', 'child', 'family', 'coppa', 'parental consent', 'minor', 'kid'],
    agents: [
      { domain: 'shield', agent: 'pii', role: 'Minor PII scanner' },
      { domain: 'policy-engine', agent: 'enforce', role: 'COPPA policy enforcer' },
      { domain: 'shield', agent: 'toxicity', role: 'Child-safe content scanner' },
      { domain: 'data-vault', agent: 'access-control', role: 'Parental consent access control' },
      { domain: 'shield', agent: 'safety-boundary', role: 'Child safety boundary enforcer' },
    ],
  },
  // ── Funeral / Death Care ──
  {
    keywords: ['funeral', 'death care', 'mortuary', 'cremation', 'obituary', 'cemetery'],
    agents: [
      { domain: 'shield', agent: 'pii', role: 'Deceased/family PII scanner' },
      { domain: 'governance-dashboard', agent: 'audit', role: 'Regulatory compliance auditor' },
      { domain: 'policy-engine', agent: 'enforce', role: 'FTC funeral rule enforcer' },
    ],
  },
  // ── Accessibility / Assistive Tech ──
  {
    keywords: ['accessibility', 'a11y', 'wcag', 'assistive', 'screen reader', 'disability', 'ada compliance', 'inclusive'],
    agents: [
      { domain: 'governance-dashboard', agent: 'audit', role: 'WCAG/ADA compliance auditor' },
      { domain: 'test-bench', agent: 'quality', role: 'Accessibility quality evaluator' },
      { domain: 'test-bench', agent: 'bias', role: 'Accessibility bias detector' },
      { domain: 'policy-engine', agent: 'enforce', role: 'Accessibility policy enforcer' },
    ],
  },
  // ── Localization / i18n ──
  {
    keywords: ['localization', 'i18n', 'l10n', 'translation', 'multilingual', 'locale', 'internationalization', 'rtl'],
    agents: [
      { domain: 'test-bench', agent: 'quality', role: 'Translation quality evaluator' },
      { domain: 'test-bench', agent: 'consistency', role: 'Localization consistency checker' },
      { domain: 'shield', agent: 'toxicity', role: 'Cross-cultural content scanner' },
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
// Ruflo Coding Swarm — Agent-Driven Code Generation
// ============================================================================

/**
 * Invoke the Ruflo coding swarm to build a complete prototype.
 *
 * Uses ruflo's actual working commands (swarm init, task create, swarm start)
 * to orchestrate an agent team that generates frontend, backend, middleware,
 * SQL, and tests — all driven by SPARC/ADR/DDD/TDD artifacts.
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
    // Try global ruflo
    try {
      execSync('ruflo --version', { stdio: 'pipe', timeout: 5000 });
      rufloBin = 'ruflo';
    } catch {
      // Last resort: install globally
      try {
        console.error('  [RUFLO-SWARM] Installing ruflo@latest globally...');
        execSync('npm install -g ruflo@latest', { stdio: 'pipe', timeout: 120000 });
        rufloBin = 'ruflo';
      } catch {
        console.error('  [RUFLO-SWARM] ruflo not available — coding swarm skipped');
        return { invoked: false, filesModified: 0, timing: Date.now() - start };
      }
    }
  }

  // Locate generated project — or create one from implementation prompts
  const codegenProject = path.join(runDir, 'phase5', 'codegen', 'project');
  const deployProject = path.join(runDir, 'phase5', 'deploy', 'project');
  let projectDir = fs.existsSync(codegenProject) ? codegenProject : fs.existsSync(deployProject) ? deployProject : '';

  // ADR-PIPELINE-039: If no Phase 5 project exists, create one and use implementation prompts
  if (!projectDir) {
    const promptsDir = path.join(runDir, 'prompts');
    const implPrompts = fs.existsSync(promptsDir)
      ? fs.readdirSync(promptsDir).filter(f => f.startsWith('impl-') && f.endsWith('.md')).sort()
      : [];

    if (implPrompts.length === 0) {
      console.error('  [RUFLO-SWARM] No generated project and no implementation prompts — coding swarm skipped');
      return { invoked: false, filesModified: 0, timing: Date.now() - start };
    }

    // Create a project directory and execute prompts via ruflo one at a time
    projectDir = path.join(runDir, 'phase5', 'codegen', 'project');
    fs.mkdirSync(projectDir, { recursive: true });

    // Also copy scaffold files if they exist
    const scaffoldDir = path.join(runDir, '..', '.agentics', 'plans', 'scaffold', 'src');
    const altScaffold = path.join(path.dirname(runDir), '..', '.agentics', 'plans', 'scaffold', 'src');
    const scaffoldSource = fs.existsSync(scaffoldDir) ? scaffoldDir : fs.existsSync(altScaffold) ? altScaffold : null;
    if (scaffoldSource) {
      const srcDir = path.join(projectDir, 'src');
      fs.mkdirSync(srcDir, { recursive: true });
      for (const f of fs.readdirSync(scaffoldSource)) {
        fs.copyFileSync(path.join(scaffoldSource, f), path.join(srcDir, f));
      }
      console.error(`  [RUFLO-SWARM] Copied scaffold files (logger.ts, config.ts, errors.ts) to project`);
    }

    console.error(`  [RUFLO-SWARM] Using ${implPrompts.length} implementation prompts as build steps`);

    // Execute each prompt via ruflo task
    for (const promptFile of implPrompts) {
      const promptContent = fs.readFileSync(path.join(promptsDir, promptFile), 'utf-8');
      const promptName = promptFile.replace('.md', '').replace('impl-', 'step-');

      try {
        execSync(`${rufloBin} task create --type implementation --description ${JSON.stringify(promptContent.slice(0, 10000))}`, {
          cwd: projectDir, timeout: 30000, encoding: 'utf-8', stdio: 'pipe',
        });
        console.error(`  [RUFLO-SWARM] Created task: ${promptName}`);
      } catch {
        console.error(`  [RUFLO-SWARM] Task creation failed for ${promptName} (continuing)`);
      }
    }
  }

  // Locate SPARC, ADRs, DDD model, TDD plan artifacts
  const sparcSpec = findArtifactUp(runDir, 'sparc/sparc-combined.json') ?? findArtifactUp(runDir, 'sparc-combined.json');
  const adrIndex = findArtifactUp(runDir, 'adrs/adr-index.json');
  const dddModel = findArtifactUp(runDir, 'ddd/domain-model.json');
  const tddPlan = findArtifactUp(runDir, 'tdd/tdd-plan.json');

  // Detect language from project files
  const language = fs.existsSync(path.join(projectDir, 'Cargo.toml')) ? 'rust' : 'typescript';

  // Build artifact context string for tasks — include ALL context sources
  const artifactParts: string[] = [];
  if (sparcSpec) artifactParts.push(`SPARC=${sparcSpec}`);
  if (adrIndex) artifactParts.push(`ADRs=${adrIndex}`);
  if (dddModel) artifactParts.push(`DDD=${dddModel}`);
  if (tddPlan) artifactParts.push(`TDD=${tddPlan}`);

  // Include agentics agent reports from ALL phases — this is the cooperation point
  for (const phase of ['phase2', 'phase3', 'phase4', 'phase5']) {
    const report = path.join(runDir, phase, 'agentics-agents-report.json');
    if (fs.existsSync(report)) artifactParts.push(`${phase}-agents=${report}`);
  }
  // Phase 1 fleet report
  const phase1Fleet = path.join(runDir, 'agentics-agents-report.json');
  if (fs.existsSync(phase1Fleet)) artifactParts.push(`phase1-fleet=${phase1Fleet}`);

  // Phase 1 artifacts
  for (const f of ['manifest.json', 'scenario.json', 'executive-summary.md', 'risk-assessment.json', 'decision-memo.md']) {
    const p = path.join(runDir, f);
    if (fs.existsSync(p)) artifactParts.push(`${f.replace('.json', '').replace('.md', '')}=${p}`);
  }

  const artifactContext = artifactParts.join(', ');

  console.error(`  [RUFLO-SWARM] Invoking coding swarm on ${projectDir}`);
  console.error(`  [RUFLO-SWARM] Language: ${language}, Context sources: ${artifactParts.length}`);

  // Count files before swarm
  let filesBefore = 0;
  try {
    const countCmd = `find "${projectDir}" -type f | wc -l`;
    filesBefore = parseInt(execSync(countCmd, { encoding: 'utf-8', stdio: 'pipe', timeout: 5000 }).trim(), 10) || 0;
  } catch { /* best effort */ }

  // Step 1: Initialize ruflo swarm
  try {
    execSync(`${rufloBin} swarm init --topology hierarchical --max-agents 8 --strategy specialized`, {
      cwd: projectDir, timeout: 30000, encoding: 'utf-8', stdio: 'pipe',
    });
    console.error('  [RUFLO-SWARM] Swarm initialized');
  } catch {
    console.error('  [RUFLO-SWARM] Swarm init warning (continuing)');
  }

  // Step 2: Build implementation prompt and create tasks
  const implArtifacts: Record<string, string> = {};
  if (sparcSpec) implArtifacts['SPARC'] = sparcSpec;
  if (adrIndex) implArtifacts['ADRs'] = adrIndex;
  if (dddModel) implArtifacts['DDD'] = dddModel;
  if (tddPlan) implArtifacts['TDD'] = tddPlan;

  // Read the scenario query from the run
  let scenarioQuery = 'enterprise prototype';
  try {
    const promptFile = path.join(runDir, 'prompt.txt');
    if (fs.existsSync(promptFile)) scenarioQuery = fs.readFileSync(promptFile, 'utf-8').trim().slice(0, 600);
  } catch { /* use default */ }

  const implPrompt = buildImplementationPrompt(implArtifacts, scenarioQuery, language);

  // Persist implementation prompt so both ruflo swarm and agentics agents can reference it
  try { fs.writeFileSync(path.join(runDir, 'implementation-prompt.md'), implPrompt, 'utf-8'); } catch { /* non-fatal */ }

  // Build per-context tasks from implementation prompts (not coarse "implement ALL" tasks).
  // Each bounded context gets its own ruflo task with its specific prompt, so the swarm
  // can implement real domain logic instead of producing generic scaffolding.
  const taskDescs: string[] = [];

  // Read per-context implementation prompts generated by Phase 5 codegen
  const promptsDir = path.join(projectDir, 'prompts');
  if (fs.existsSync(promptsDir)) {
    const promptFiles = fs.readdirSync(promptsDir).filter(f => f.endsWith('-implementation.md'));
    for (const pf of promptFiles) {
      const contextName = pf.replace('-implementation.md', '');
      const contextSrcDir = path.join(projectDir, 'src', contextName);
      const contextTestDir = path.join(projectDir, 'tests');
      try {
        const promptContent = fs.readFileSync(path.join(promptsDir, pf), 'utf-8');
        // Include the user's scenario query for domain context + the per-context prompt
        const taskDesc = `CONTEXT: ${contextName}\nSCENARIO: ${scenarioQuery.slice(0, 400)}\n\n${promptContent.slice(0, 2500)}\n\nTarget src: ${contextSrcDir}\nTarget tests: ${contextTestDir}`;
        taskDescs.push(taskDesc);
      } catch { /* skip unreadable prompts */ }
    }
  }

  // Add cross-cutting tasks that don't map to a single context
  if (taskDescs.length === 0) {
    // Fallback if no per-context prompts found
    taskDescs.push(`Backend: Implement ALL command handlers + query handlers from DDD bounded contexts using London School TDD. ${implPrompt.slice(0, 1500)}. Target: ${projectDir}/src`);
  }
  taskDescs.push(`Frontend: Dashboard + per-context pages + typed API client from DDD model. Target: ${projectDir}/ui`);
  taskDescs.push(`SQL schemas: CREATE TABLE per aggregate, indexes, FKs, migrations. Target: ${projectDir}/sql`);

  let tasksCreated = 0;
  for (const desc of taskDescs) {
    try {
      execSync(`${rufloBin} task create --type implementation --description "${desc.replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`, {
        cwd: projectDir, timeout: 30000, encoding: 'utf-8', stdio: 'pipe',
      });
      tasksCreated++;
    } catch { /* task creation failure is non-fatal */ }
  }
  console.error(`  [RUFLO-SWARM] Created ${tasksCreated} per-context implementation tasks (${taskDescs.length - 2} contexts + 2 cross-cutting)`);

  // Coordinate with claude-flow agents if available
  if (isClaudeFlowAvailable()) {
    cfExec(`agent spawn -t coder --name "ruflo-coder-${traceId.slice(0, 8)}" --task "Implement ADRs+DDDs with London School TDD in ${projectDir}"`, 5000);
    cfExec(`task create --description "Ruflo+agentics cooperation: implement ${language} prototype with London School TDD for trace ${traceId}" --type implementation`, 5000);
  }

  // Step 3: Start the swarm with the full implementation prompt + per-context task list as objective
  const contextList = taskDescs.slice(0, -2).map(d => d.split('\n')[0]).join(', ');
  const objective = implPrompt.slice(0, 2500) + `\n\nPer-context tasks: ${contextList}\n\nTarget: ${projectDir}. Artifact paths: ${artifactContext}`;

  let swarmSuccess = false;
  try {
    execSync(`${rufloBin} swarm start --objective "${objective.replace(/"/g, '\\"')}" -s development`, {
      cwd: projectDir, timeout: 600000, encoding: 'utf-8', stdio: 'pipe',
    });
    swarmSuccess = true;
    console.error('  [RUFLO-SWARM] Coding swarm completed');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`  [RUFLO-SWARM] Swarm execution note: ${msg.slice(0, 200)}`);
  }

  // Count files after swarm
  let filesAfter = 0;
  try {
    const countCmd = `find "${projectDir}" -type f | wc -l`;
    filesAfter = parseInt(execSync(countCmd, { encoding: 'utf-8', stdio: 'pipe', timeout: 5000 }).trim(), 10) || 0;
  } catch { /* best effort */ }

  const filesModified = Math.max(0, filesAfter - filesBefore);
  const timing = Date.now() - start;

  console.error(`  [RUFLO-SWARM] Result: ${filesModified} new files, ${tasksCreated} tasks, ${timing}ms`);

  // Store result in swarm memory
  if (isClaudeFlowAvailable()) {
    cfExec(`memory store --namespace phase5-build --key "ruflo-swarm-${traceId}" --value "Ruflo swarm: ${tasksCreated} tasks, ${filesModified} files in ${timing}ms"`);
    cfExec(`hooks post-task --task-id "ruflo-swarm-${traceId}" --success ${swarmSuccess} --store-results true`);
  }

  return { invoked: swarmSuccess || tasksCreated > 0, filesModified, timing };
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

function cfExec(command: string, timeoutMs = 10000): string | null {
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
/** Per-agent timeout: 30s max per invocation to prevent hanging. */
const AGENT_INVOKE_TIMEOUT_MS = 30000;

/**
 * Optional per-agent lifecycle hooks used by the live status panel.
 * Both methods MUST be no-throw — failures inside the panel must never
 * affect the dispatcher's outcome.
 */
interface PanelHooks {
  begin(id: string): void;
  complete(id: string, status: 'success' | 'failed' | 'skipped', detail?: string): void;
}

async function invokeAgenticsService(
  svc: AgenticsServiceCall,
  prompt: string,
  traceId: string,
  breaker?: CloudCircuitBreaker,
  panel?: PanelHooks,
): Promise<AgenticsServiceResult | null> {
  const start = Date.now();
  const options: CommandOptions = { trace_id: traceId, verbose: true };
  const id = `${svc.domain}/${svc.agent}`;

  // ADR-094 D7 — when the cloud circuit breaker has tripped for this fanout,
  // skip remaining cloud invocations entirely. The dispatcher already started
  // some invocations before the breaker tripped; those finish under their
  // own per-call timeout. Calls reaching this guard AFTER the trip return a
  // non-null result with `_breaker_skipped: true` so status.json sees them.
  if (breaker?.shouldSkip()) {
    panel?.complete(id, 'skipped', 'cloud breaker tripped');
    return {
      domain: svc.domain,
      agent: svc.agent,
      role: svc.role,
      status: 0,
      response: { _breaker_skipped: true, reason: 'cloud-breaker-tripped' },
      timing: 0,
    };
  }

  panel?.begin(id);

  try {
    // Wrap with timeout — if agent doesn't respond in 30s, move on
    const result: AgentsInvokeResult = await Promise.race([
      executeAgentsInvokeCommand(svc.domain, svc.agent, { text: prompt }, options),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`Agent ${svc.domain}/${svc.agent} timed out after ${AGENT_INVOKE_TIMEOUT_MS}ms`)), AGENT_INVOKE_TIMEOUT_MS),
      ),
    ]);

    // ADR-094 D7 — record success or failure outcome so the breaker can
    // decide whether subsequent dispatches should bypass cloud entirely.
    const isFallback = isLocalFallbackResp(result.response);
    const failed = result.status >= 400;
    breaker?.record(failed, isFallback ? 'local' : 'cloud', id);
    if (failed) {
      panel?.complete(id, 'failed', `status ${result.status}`);
    } else {
      panel?.complete(id, 'success', isFallback ? 'local-tier' : undefined);
    }

    return {
      domain: svc.domain,
      agent: svc.agent,
      role: svc.role,
      status: result.status,
      response: result.response,
      timing: Date.now() - start,
    };
  } catch (err: unknown) {
    // Non-fatal — agent invocation failures never block the pipeline
    const errMsg = err instanceof Error ? err.message : String(err);
    panel?.complete(id, 'failed', errMsg.slice(0, 80));
    if (!panel) {
      // Preserve the legacy plain-log line when no panel is attached so
      // existing log scrapers / tests still see it.
      console.error(`  [AGENTICS] [FAIL] ${svc.domain}/${svc.agent} (${svc.role}) — ${errMsg}`);
    }
    breaker?.record(true, 'cloud', id);
    return null;
  }
}

/** Detect a local-tier response. Mirrors the dispatcher's _fallback marker. */
function isLocalFallbackResp(resp: unknown): boolean {
  if (resp && typeof resp === 'object') {
    return (resp as Record<string, unknown>)['_fallback'] === true;
  }
  return false;
}

// ADR-094 D7 / ADR-108 — CloudCircuitBreaker, CloudBreakerState, and
// resolveCloudBreakerThreshold now live in ./fleet-dispatch-bounds.js
// (imported + re-exported at the top of this file) so commands/agents.ts can
// share them without an import cycle.

/**
 * Dispatch all agentics platform agents for a phase in parallel.
 * Returns results from all agents (some may be null on failure).
 */
/** Overall timeout for all agents in a phase: 45s. Individual agents have 30s timeout. */
const DISPATCH_ALL_TIMEOUT_MS = 45000;

async function dispatchAgenticsServices(
  services: AgenticsServiceCall[],
  prompt: string,
  traceId: string,
  breaker?: CloudCircuitBreaker,
  panelTitle?: string,
): Promise<AgenticsServiceResult[]> {
  if (services.length === 0) return [];

  // ADR-094 D7 — every fanout gets a fresh cloud circuit breaker. Cloud
  // failures within this fanout accumulate and short-circuit remaining
  // dispatches once the threshold is reached. Tests can inject their own
  // breaker via the optional argument.
  const fanoutBreaker = breaker ?? new CloudCircuitBreaker(resolveCloudBreakerThreshold());

  // ADR-PIPELINE-097 — live status panel. One row per agent; gracefully
  // degrades to plain `[AGENTICS] [..]/[OK ]/[FAIL]` lines in non-TTY mode
  // (CI, piped output, AGENTICS_NO_LIVE=1).
  const panel = panelTitle
    ? new AgentPanel(
        panelTitle,
        services.map((s) => ({ id: `${s.domain}/${s.agent}`, label: `${s.domain}/${s.agent}` })),
      ).start()
    : undefined;

  // Track completed results as they arrive so fleet timeout can return partial results
  const completedResults: AgenticsServiceResult[] = [];
  const wrappedPromises = services.map(async (svc) => {
    const result = await invokeAgenticsService(svc, prompt, traceId, fanoutBreaker, panel);
    if (result !== null) {
      completedResults.push(result);
    }
    return result;
  });

  // Race the entire batch against a hard deadline
  let timedOut = false;
  await Promise.race([
    Promise.allSettled(wrappedPromises),
    new Promise<void>((resolve) =>
      setTimeout(() => {
        timedOut = true;
        resolve();
      }, DISPATCH_ALL_TIMEOUT_MS),
    ),
  ]);

  if (timedOut) {
    const pending = services.length - completedResults.length;
    console.error(`  [AGENTICS] Fleet timeout after ${DISPATCH_ALL_TIMEOUT_MS}ms — ${completedResults.length} completed, ${pending} still pending`);
  }

  panel?.stop();

  // ADR-094 D7 — surface breaker state so callers can record it in
  // status.json. We attach it as a non-enumerable property on the result
  // array so the existing call sites stay backwards-compatible.
  const breakerState = fanoutBreaker.state();
  if (breakerState.tripped) {
    Object.defineProperty(completedResults, '__cloudBreakerState', {
      value: breakerState,
      enumerable: false,
    });
  }

  return completedResults;
}

/**
 * ADR-094 D7 — read the breaker state recorded by `dispatchAgenticsServices`
 * onto the returned results array. Returns `undefined` when the breaker did
 * not trip (or when the array did not come from this dispatcher).
 */
export function getCloudBreakerState(
  results: ReadonlyArray<AgenticsServiceResult>,
): CloudBreakerState | undefined {
  const state = (results as unknown as { __cloudBreakerState?: CloudBreakerState }).__cloudBreakerState;
  return state;
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
  // Each phase's agents receive prior-phase artifacts + fleet reports as context.
  // The agentics-agents-report.json from previous phases carries the 109
  // agentics.dev agent outputs so ruflo agents can coordinate with them.
  // Context chain: each phase reads ALL prior phase outputs sequentially.
  // The order matters: Research → SPARC → ADRs/DDD → Build → ERP.
  // SPARC (Phase 3) MUST inform ADRs/DDD (Phase 4), not the other way around.
  const contextFiles: Record<number, string[]> = {
    2: [
      'manifest.json',                          // Phase 1 simulation manifest
      'scenario.json',                          // Phase 1 scenario extraction
      'risk-assessment.json',                   // Phase 1 risk factors
      'executive-summary.md',                   // Phase 1 executive summary
      'roadmap.json',                           // Phase 1 implementation roadmap
    ],
    3: [
      'manifest.json',                          // Phase 1 simulation manifest
      'scenario.json',                          // Phase 1 scenario (full context)
      'phase2/research-dossier.json',           // Phase 2 deep research output
      'phase2/agentics-agents-report.json',     // Phase 2 agent results
    ],
    4: [
      'scenario.json',                          // Phase 1 scenario (full context)
      'phase2/research-dossier.json',           // Phase 2 research
      'phase3/sparc/sparc-combined.json',       // Phase 3 SPARC output (MUST inform ADRs)
      'phase3/phase3-manifest.json',            // Phase 3 manifest
      'phase3/tdd/tdd-plan.json',               // Phase 3 TDD plan
      'phase3/agentics-agents-report.json',     // Phase 3 agent results
    ],
    5: [
      'scenario.json',                          // Phase 1 scenario
      'phase3/sparc/sparc-combined.json',       // Phase 3 SPARC architecture
      'phase3/tdd/tdd-plan.json',               // Phase 3 TDD plan
      'phase4/adrs/adr-index.json',             // Phase 4 ADRs (informed by SPARC)
      'phase4/ddd/domain-model.json',           // Phase 4 DDD model (informed by SPARC)
      'phase4/agentics-agents-report.json',     // Phase 4 agent results
      'manifest.json',                          // Phase 1 simulation manifest
    ],
    6: [
      'manifest.json',                          // Phase 1 simulation manifest
      'phase4/ddd/domain-model.json',           // Phase 4 domain model
      'phase5/phase5-manifest.json',            // Phase 5 build output
      'phase5/agentics-agents-report.json',     // Phase 5 agent results
    ],
  };

  const files = contextFiles[phaseConfig.phase] ?? [];
  for (const file of files) {
    const fullPath = path.join(runDir, file);
    if (fs.existsSync(fullPath)) {
      try {
        const content = fs.readFileSync(fullPath, 'utf-8');
        context += `\n--- ${file} ---\n${content.slice(0, 32000)}\n`;
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

  // ── 1. Ruflo swarm coordination (non-blocking, reduced timeouts) ──
  if (isClaudeFlowAvailable()) {
    console.error(`  [RUFLO] Dispatching ${phaseConfig.agents.length} swarm agents for Phase ${phaseConfig.phase}: ${phaseConfig.label}`);

    // Create a task for the phase (5s timeout — quick coordination only)
    cfExec(
      `task create --description "Phase ${phaseConfig.phase}: ${phaseConfig.label} — trace ${traceId}" --type implementation`,
      5000,
    );

    // Spawn all swarm agents with tight 5s timeouts — they're fire-and-forget coordination
    for (const agent of phaseConfig.agents) {
      cfExec(
        `agent spawn -t ${agent.type} --name "${agent.role}-p${phaseConfig.phase}" --task "${agent.description}"`,
        5000,
      );
    }

    // Pre-task hook for routing intelligence (5s timeout)
    cfExec(
      `hooks pre-task --description "Phase ${phaseConfig.phase}: ${phaseConfig.label}" --coordinate-swarm true`,
      5000,
    );

    // Search memory for relevant patterns from past executions (5s timeout)
    const patterns = cfExec(
      `memory search --query "${phaseConfig.label}" --namespace patterns --limit 3`,
      5000,
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

  // ── 3. Agentics platform agent dispatch (fixed defaults + contextual, deduplicated) ──
  const seen = new Set<string>();
  const allServices: AgenticsServiceCall[] = [];
  for (const svc of [...phaseConfig.agenticsServices, ...contextualAgents]) {
    const key = `${svc.domain}/${svc.agent}`;
    if (!seen.has(key)) {
      seen.add(key);
      allServices.push(svc);
    }
  }

  // ── 3a. ADR-PIPELINE-089 §5: Phase 2 preflight ──
  // Before dispatching, probe each unique backend's /v1/health with a
  // short timeout. Skip agents whose backend is failing so we don't burn
  // 60-120s per dead Cloud Run service. If a majority fail, abort Phase 2
  // entirely — downstream artifacts built on no-op responses are worse
  // than no artifacts at all. Write the preflight result into status.json
  // so `agentics status` can surface it.
  let dispatchServices = allServices;
  if (phaseConfig.phase === 2 && allServices.length > 0) {
    const { runPhase2Preflight } = await import('./phase2-preflight.js');
    const preflightRefs = allServices.map(s => ({
      domain: s.domain,
      agent: s.agent,
      service: `${s.domain}-agents`,
    }));
    const preflight = await runPhase2Preflight(preflightRefs, traceId);
    console.error(
      `  [PREFLIGHT] ${preflight.healthy.length}/${preflight.probed} backends healthy ` +
      `in ${preflight.durationMs}ms (verdict: ${preflight.verdict})`,
    );
    if (preflight.unhealthy.length > 0) {
      console.error(`  [PREFLIGHT] Unhealthy: ${preflight.unhealthy.join(', ')}`);
      console.error(`  [PREFLIGHT] Skipping ${preflight.skipped.length} agents bound to unhealthy backends`);
    }

    // Persist preflight outcome to status.json for `agentics status` consumers.
    await writePhase2PreflightToStatus(traceId, preflight);

    if (preflight.verdict === 'abort') {
      console.error('  [PREFLIGHT] ≥4/7 backends unhealthy — aborting Phase 2 dispatch cleanly');
      return agenticsResults; // empty — caller handles missing content
    }
    const skippedSet = new Set(preflight.skipped);
    dispatchServices = allServices.filter(s => !skippedSet.has(`${s.domain}/${s.agent}`));
  }

  if (dispatchServices.length > 0) {
    const serviceNames = dispatchServices.map(s => `${s.domain}/${s.agent}`);
    // ADR-PIPELINE-097 — when stderr is a TTY the AgentPanel renders its own
    // header + animated rows + summary; suppress the legacy plain-log lines
    // to avoid duplication. In non-TTY mode the panel is silent, so we keep
    // the legacy lines for log scrapers.
    const liveUI = isLiveCapable();
    if (!liveUI) {
      console.error(`  [AGENTICS] Dispatching ${dispatchServices.length} platform agents: ${serviceNames.join(', ')}`);
    }

    const prompt = buildPhasePrompt(phaseConfig, scenarioQuery, runDir);
    const panelTitle = `Phase ${phaseConfig.phase} · ${phaseConfig.label}`;
    const results = await dispatchAgenticsServices(dispatchServices, prompt, traceId, undefined, panelTitle);

    for (const r of results) {
      agenticsResults.push(r);
      const resp = r.response as Record<string, unknown> | undefined;
      const isFallback = resp && resp['_fallback'] === true;
      if (!liveUI) {
        const icon = r.status === 200 ? (isFallback ? '[FB]' : '[OK]') : '[!!]';
        console.error(`  [AGENTICS] ${icon} ${r.domain}/${r.agent} (${r.role}) — ${r.timing}ms${isFallback ? ' (local fallback)' : ''}`);
      }

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

    const fallbackCount = results.filter(r => {
      const resp = r.response as Record<string, unknown> | undefined;
      return resp && resp['_fallback'] === true;
    }).length;
    const cloudCount = results.length - fallbackCount;
    console.error(`  [AGENTICS] ${results.length}/${dispatchServices.length} agents responded for Phase ${phaseConfig.phase} (${cloudCount} cloud, ${fallbackCount} local fallback)`);
    if (results.length === 0) {
      console.error(`  [AGENTICS] WARNING: No agents responded — costops/analytics output will be missing`);
    }
    if (fallbackCount > 0 && cloudCount === 0) {
      console.error(`  [AGENTICS] WARNING: All agents used local fallback — Cloud Run services may not be deployed or reachable`);
    }
  }

  return agenticsResults;
}

/**
 * ADR-PIPELINE-089 §6: patch status.json with the Phase 2 preflight
 * outcome so `agentics status` and the `agentics-status` MCP tool can
 * surface "skipped 5 unhealthy backends" instead of "Phase 2 running for
 * 7 minutes." Best-effort — status.json may not exist for shell-mode
 * runs, and that is the expected code path (no MCP fast-return detach).
 */
async function writePhase2PreflightToStatus(
  traceId: string,
  preflight: { probed: number; healthy: string[]; unhealthy: string[]; skipped: string[]; durationMs: number; verdict: string },
): Promise<void> {
  try {
    const fsMod = await import('node:fs');
    const pathMod = await import('node:path');
    const os = await import('node:os');
    const statusPath = pathMod.join(os.homedir(), '.agentics', 'runs', traceId, 'status.json');
    if (!fsMod.existsSync(statusPath)) return;
    const current = JSON.parse(fsMod.readFileSync(statusPath, 'utf-8')) as Record<string, unknown>;
    current['phase2_preflight'] = {
      probed: preflight.probed,
      healthy: preflight.healthy,
      unhealthy: preflight.unhealthy,
      skipped: preflight.skipped,
      duration_ms: preflight.durationMs,
      verdict: preflight.verdict,
      probed_at: new Date().toISOString(),
    };
    const tmp = statusPath + '.tmp';
    fsMod.writeFileSync(tmp, JSON.stringify(current, null, 2), { encoding: 'utf-8', mode: 0o600 });
    fsMod.renameSync(tmp, statusPath);
  } catch { /* non-fatal */ }
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

  const reviewLive = isLiveCapable();
  const results = await dispatchAgenticsServices(
    reviewServices, reviewPrompt, traceId, undefined,
    `Phase ${phaseConfig.phase} review`,
  );

  for (const r of results) {
    if (!reviewLive) {
      const icon = r.status === 200 ? '[OK]' : '[!!]';
      console.error(`  [REVIEW] ${icon} ${r.domain}/${r.agent} (${r.role}) — ${r.timing}ms`);
    }

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
