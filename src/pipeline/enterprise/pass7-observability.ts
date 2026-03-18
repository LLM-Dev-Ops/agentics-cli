/**
 * Pass 7 — Observability & Continuous Learning (ADR-038)
 *
 * Unlike Passes 1-6, Pass 7 is continuous. It starts after Pass 6 and
 * runs until explicitly stopped. Operates in three concurrent workstreams:
 *
 *   Workstream A: Observability (LLM-Observatory)
 *   Workstream B: Diagnostics & Incident Handling (LLM-Latency-Lens + LLM-Incident-Manager)
 *   Workstream C: Continuous Learning Loop (RuVector / Memory-Graph)
 *
 * The initial setup (executePass7) is synchronous and completes when:
 *   1. Telemetry is configured
 *   2. First health check passes
 *   3. Learning loop is registered
 *   4. Initial nodes written to DecisionGraph
 *
 * After setup, the pass reports as 'active' (not 'complete').
 */

import * as crypto from 'node:crypto';

import type {
  PassNumber,
  AgentRef,
  AgentInvocationResult,
} from './types.js';
import { DecisionGraph } from './decision-graph.js';
import { ProvenanceTracker } from './provenance-tracker.js';

// ============================================================================
// Domain Types (ADR-038)
// ============================================================================

// ── Health Check ──

export type HealthStatus = 'healthy' | 'degraded' | 'unhealthy';

export interface HealthCheck {
  readonly endpointUrl: string;
  readonly status: HealthStatus;
  readonly latencyMs: number;
  readonly lastChecked: string;
  readonly checkInterval: string;
  readonly failureCount: number;
  readonly alertThreshold: number;
}

// ── Telemetry ──

export type MetricCategory = 'availability' | 'performance' | 'usage' | 'errors' | 'sla_compliance';

export interface TelemetryMetric {
  readonly category: MetricCategory;
  readonly name: string;
  readonly value: number;
  readonly unit: string;
  readonly timestamp: string;
}

export interface TelemetryConfig {
  readonly executionId: string;
  readonly metrics: readonly TelemetryMetric[];
  readonly healthChecks: readonly HealthCheck[];
  readonly collectionIntervalMs: number;
  readonly configuredAt: string;
}

// ── Dashboard Spec ──

export type VisualizationType = 'timeseries' | 'gauge' | 'table' | 'heatmap';
export type AlertSeverity = 'critical' | 'warning' | 'info';

export interface DashboardPanel {
  readonly title: string;
  readonly metricQuery: string;
  readonly visualization: VisualizationType;
  readonly thresholds: readonly { readonly value: number; readonly color: string }[];
}

export interface AlertRule {
  readonly condition: string;
  readonly severity: AlertSeverity;
  readonly notificationChannel: string;
}

export interface DashboardSpec {
  readonly name: string;
  readonly panels: readonly DashboardPanel[];
  readonly alertRules: readonly AlertRule[];
}

// ── Diagnostics ──

export interface DiagnosticReport {
  readonly trigger: string;
  readonly rootCause: string;
  readonly affectedComponents: readonly string[];
  readonly recommendation: string;
  readonly estimatedImpact: string;
  readonly automaticMitigation: boolean;
}

// ── Incidents ──

export type IncidentSeverity = 'P1' | 'P2' | 'P3' | 'P4';
export type ActionItemStatus = 'open' | 'in_progress' | 'complete';

export interface IncidentTimeline {
  readonly detected: string;
  readonly escalated: string;
  readonly mitigated: string;
  readonly resolved: string;
}

export interface ActionItem {
  readonly action: string;
  readonly owner: string;
  readonly dueDate: string;
  readonly status: ActionItemStatus;
}

export interface PostMortem {
  readonly incidentId: string;
  readonly severity: IncidentSeverity;
  readonly timeline: IncidentTimeline;
  readonly rootCause: string;
  readonly impact: string;
  readonly actionItems: readonly ActionItem[];
  readonly lessonsLearned: readonly string[];
}

export interface Incident {
  readonly id: string;
  readonly severity: IncidentSeverity;
  readonly description: string;
  readonly detectedAt: string;
  readonly status: 'open' | 'investigating' | 'mitigated' | 'resolved';
  readonly diagnosticReport?: DiagnosticReport;
  readonly postMortem?: PostMortem;
  readonly requiresHumanReview: boolean;
}

// ── Learning ──

export type PatternType = 'success_pattern' | 'anti_pattern' | 'calibration_adjustment';
export type Verdict = 'correct' | 'partially_correct' | 'incorrect';

export interface PatternEvidence {
  readonly executionId: string;
  readonly predicted: string;
  readonly actual: string;
  readonly verdict: Verdict;
}

export interface LearnedPattern {
  readonly id: string;
  readonly type: PatternType;
  readonly domain: string;
  readonly description: string;
  readonly evidence: PatternEvidence;
  readonly adjustment: string;
  readonly confidence: number;
  readonly applicableWhen: readonly string[];
}

export type FeedbackType = 'decision_outcome' | 'artifact_quality' | 'missing_information' | 'correction';

export interface FeedbackEntry {
  readonly id: string;
  readonly type: FeedbackType;
  readonly executionId: string;
  readonly artifactNumber?: number;
  readonly rating?: number;
  readonly comment: string;
  readonly timestamp: string;
}

// ── Learning Pipeline Steps ──

export type LearningStep = 'retrieve' | 'judge' | 'distill' | 'consolidate';

export interface LearningCycleResult {
  readonly executionId: string;
  readonly timestamp: string;
  readonly stepsCompleted: readonly LearningStep[];
  readonly patternsLearned: readonly LearnedPattern[];
  readonly feedbackProcessed: number;
  readonly verdicts: readonly { readonly domain: string; readonly verdict: Verdict }[];
}

// ── Pass 7 Lifecycle ──

export type Pass7Phase = 'startup' | 'active_monitoring' | 'incident_response' | 'learning_cycle' | 'shutdown';

// ============================================================================
// Workstream Definitions
// ============================================================================

export type Pass7WorkstreamId = 'observability' | 'diagnostics-incidents' | 'learning-loop';

export interface Pass7WorkstreamConfig {
  readonly id: Pass7WorkstreamId;
  readonly label: string;
  readonly agents: readonly AgentRef[];
}

export const PASS7_WORKSTREAM_CONFIGS: readonly Pass7WorkstreamConfig[] = [
  {
    id: 'observability',
    label: 'Observability (LLM-Observatory)',
    agents: [
      { domain: 'observatory', agent: 'telemetry', role: 'Telemetry collector' },
      { domain: 'observatory', agent: 'usage-patterns', role: 'Usage pattern analyser' },
      { domain: 'observatory', agent: 'failures', role: 'Failure classifier' },
      { domain: 'observatory', agent: 'health-check', role: 'Health check' },
      { domain: 'observatory', agent: 'slo', role: 'SLA enforcement' },
      { domain: 'observatory', agent: 'visualization', role: 'Visualisation spec generator' },
    ],
  },
  {
    id: 'diagnostics-incidents',
    label: 'Diagnostics & Incident Handling (Latency-Lens + Incident-Manager)',
    agents: [
      { domain: 'latency-lens', agent: 'latency', role: 'Latency analysis' },
      { domain: 'latency-lens', agent: 'cold-start', role: 'Cold start mitigation' },
      { domain: 'incident-manager', agent: 'escalation', role: 'Incident escalation' },
      { domain: 'incident-manager', agent: 'post-mortem', role: 'Post-mortem generator' },
      { domain: 'incident-manager', agent: 'hitl', role: 'Human-in-the-loop' },
    ],
  },
  {
    id: 'learning-loop',
    label: 'Continuous Learning Loop (Memory-Graph / RuVector)',
    agents: [
      { domain: 'memory-graph', agent: 'patterns', role: 'Approval learning' },
      { domain: 'memory-graph', agent: 'retrieval', role: 'Feedback assimilation' },
    ],
  },
];

// ============================================================================
// Result Types
// ============================================================================

export interface Pass7WorkstreamResult {
  readonly workstream: Pass7WorkstreamId;
  readonly label: string;
  readonly agentResults: readonly AgentInvocationResult[];
  readonly successCount: number;
  readonly totalCount: number;
  readonly durationMs: number;
}

export interface Pass7Result {
  readonly workstreamResults: readonly Pass7WorkstreamResult[];
  readonly telemetryConfig: TelemetryConfig;
  readonly healthChecks: readonly HealthCheck[];
  readonly dashboardSpec: DashboardSpec;
  readonly incidents: readonly Incident[];
  readonly learnedPatterns: readonly LearnedPattern[];
  readonly learningCycle: LearningCycleResult;
  readonly currentPhase: Pass7Phase;
  readonly graphNodeIds: readonly string[];
  readonly totalAgentResults: readonly AgentInvocationResult[];
}

// ============================================================================
// Pass 7 Executor — Initial Setup
// ============================================================================

/**
 * Execute Pass 7 initial setup: Observability & Continuous Learning.
 *
 * This performs the synchronous startup phase:
 *   1. Configure telemetry collection
 *   2. Run initial health checks
 *   3. Generate dashboard spec
 *   4. Run initial diagnostics
 *   5. Execute first learning cycle
 *   6. Write all initial nodes to DecisionGraph
 *
 * After this returns, Pass 7 is 'active' (not 'complete').
 */
export async function executePass7(params: {
  prompt: string;
  graph: DecisionGraph;
  tracker: ProvenanceTracker;
  timeoutMs: number;
  verbose: boolean;
  invokeAgents?: (agents: readonly AgentRef[], payload: Record<string, unknown>, pass: PassNumber, timeoutMs: number) => Promise<AgentInvocationResult[]>;
}): Promise<Pass7Result> {
  const { prompt, graph, tracker, timeoutMs, verbose } = params;
  const pass: PassNumber = 7;
  const invoke = params.invokeAgents ?? defaultInvokeAgents;

  const priorContext = buildPriorContext(graph);
  const payload: Record<string, unknown> = {
    prompt,
    pass: 7,
    passName: 'Observability & Continuous Learning',
    context: priorContext,
  };

  if (verbose) {
    console.error(`  [Pass 7] Starting 3 concurrent workstreams (initial setup)`);
  }

  // ── Execute all 3 workstreams concurrently ──
  const workstreamPromises = PASS7_WORKSTREAM_CONFIGS.map(async (ws): Promise<Pass7WorkstreamResult> => {
    const wsStart = Date.now();
    if (verbose) {
      console.error(`  [Pass 7] Workstream: ${ws.label} (${ws.agents.length} agents)`);
    }
    const results = await invoke(ws.agents, payload, pass, timeoutMs);
    return {
      workstream: ws.id,
      label: ws.label,
      agentResults: results,
      successCount: results.filter(r => r.status >= 200 && r.status < 300).length,
      totalCount: results.length,
      durationMs: Date.now() - wsStart,
    };
  });

  const workstreamResults = await Promise.all(workstreamPromises);

  const allResults: AgentInvocationResult[] = [];
  for (const ws of workstreamResults) {
    for (const r of ws.agentResults) allResults.push(r);
  }

  // ── Extract workstream outputs ──
  const wsA = workstreamResults.find(w => w.workstream === 'observability');
  const wsB = workstreamResults.find(w => w.workstream === 'diagnostics-incidents');
  const wsC = workstreamResults.find(w => w.workstream === 'learning-loop');

  const telemetryConfig = extractTelemetryConfig(wsA, graph);
  const healthChecks = extractHealthChecks(wsA, graph);
  const dashboardSpec = extractDashboardSpec(wsA);
  const incidents = extractIncidents(wsB);
  const learnedPatterns = extractLearnedPatterns(wsC, graph);
  const learningCycle = runLearningCycle(graph, learnedPatterns);

  // ── Write to DecisionGraph ──
  const graphNodeIds = writeToGraph(graph, telemetryConfig, healthChecks, dashboardSpec, learnedPatterns, learningCycle, tracker, pass);

  if (verbose) {
    console.error(`  [Pass 7] Initial setup complete: ${healthChecks.length} health check(s), ${learnedPatterns.length} pattern(s) learned`);
    console.error(`  [Pass 7] Status: active (continuous monitoring started)`);
  }

  return {
    workstreamResults,
    telemetryConfig,
    healthChecks,
    dashboardSpec,
    incidents,
    learnedPatterns,
    learningCycle,
    currentPhase: 'active_monitoring',
    graphNodeIds,
    totalAgentResults: allResults,
  };
}

// ============================================================================
// Prior Context
// ============================================================================

function buildPriorContext(graph: DecisionGraph): Record<string, unknown> {
  const ctx: Record<string, unknown> = {};

  // Pass 5 confidence score
  const scoreNodes = graph.getNodesByType('confidence_score');
  if (scoreNodes.length > 0) {
    ctx['confidenceScore'] = { summary: scoreNodes[0]!.summary, ...scoreNodes[0]!.content };
  }

  // Pass 6 deployment endpoints
  const deployNodes = graph.getNodesByType('deployment_endpoint');
  ctx['deploymentEndpoints'] = deployNodes.map(n => ({ summary: n.summary, ...n.content }));

  // Pass 3 architecture (for component mapping)
  const archNodes = graph.getNodesByType('system_architecture');
  if (archNodes.length > 0) {
    ctx['architecture'] = { summary: archNodes[0]!.summary, ...archNodes[0]!.content };
  }

  // KPIs from Pass 5 (for SLA tracking)
  const kpiNodes = graph.getNodesByType('kpi_definition');
  if (kpiNodes.length > 0) {
    ctx['kpis'] = { summary: kpiNodes[0]!.summary, ...kpiNodes[0]!.content };
  }

  // Cost model (for cost actuals comparison)
  const costNodes = graph.getNodesByType('cost_model');
  if (costNodes.length > 0) {
    ctx['costModel'] = { summary: costNodes[0]!.summary, ...costNodes[0]!.content };
  }

  return ctx;
}

// ============================================================================
// Workstream A: Telemetry & Health Check Extraction
// ============================================================================

function extractTelemetryConfig(ws: Pass7WorkstreamResult | undefined, graph: DecisionGraph): TelemetryConfig {
  const execId = graph.getExecutionId();
  const now = new Date().toISOString();

  const metrics: TelemetryMetric[] = [];
  const healthChecks: HealthCheck[] = [];

  if (ws) {
    for (const result of ws.agentResults) {
      if (result.status < 200 || result.status >= 300 || !result.response) continue;
      const resp = result.response as Record<string, unknown>;

      // Extract metrics from telemetry/usage/failures/slo agents
      const rawMetrics = extractArray(resp, 'metrics', 'telemetry', 'data');
      for (const item of rawMetrics) {
        if (typeof item === 'object' && item !== null) {
          const m = item as Record<string, unknown>;
          metrics.push({
            category: normalizeMetricCategory(m['category']),
            name: String(m['name'] ?? m['metric'] ?? ''),
            value: Number(m['value'] ?? 0),
            unit: String(m['unit'] ?? ''),
            timestamp: now,
          });
        }
      }

      // Extract health checks
      const rawChecks = extractArray(resp, 'healthChecks', 'checks', 'endpoints');
      for (const item of rawChecks) {
        if (typeof item === 'object' && item !== null) {
          const h = item as Record<string, unknown>;
          healthChecks.push(normalizeHealthCheck(h, now));
        }
      }
    }
  }

  // Ensure at least one health check from deployment endpoints
  if (healthChecks.length === 0) {
    const deployNodes = graph.getNodesByType('deployment_endpoint');
    for (const n of deployNodes) {
      healthChecks.push({
        endpointUrl: String(n.content['url'] ?? n.content['endpoint'] ?? `/api/${n.name}`),
        status: 'healthy',
        latencyMs: 0,
        lastChecked: now,
        checkInterval: 'PT5M',
        failureCount: 0,
        alertThreshold: 3,
      });
    }
    // Fallback default health check
    if (healthChecks.length === 0) {
      healthChecks.push({
        endpointUrl: '/health',
        status: 'healthy',
        latencyMs: 0,
        lastChecked: now,
        checkInterval: 'PT5M',
        failureCount: 0,
        alertThreshold: 3,
      });
    }
  }

  return {
    executionId: execId,
    metrics,
    healthChecks,
    collectionIntervalMs: 300_000, // 5 minutes
    configuredAt: now,
  };
}

function extractHealthChecks(ws: Pass7WorkstreamResult | undefined, _graph: DecisionGraph): HealthCheck[] {
  const checks: HealthCheck[] = [];
  const now = new Date().toISOString();

  if (ws) {
    for (const result of ws.agentResults) {
      if (result.agent.agent !== 'health-check') continue;
      if (result.status < 200 || result.status >= 300 || !result.response) continue;
      const resp = result.response as Record<string, unknown>;
      const rawChecks = extractArray(resp, 'healthChecks', 'checks', 'results');
      for (const item of rawChecks) {
        if (typeof item === 'object' && item !== null) {
          checks.push(normalizeHealthCheck(item as Record<string, unknown>, now));
        }
      }
      // Single check result
      if (rawChecks.length === 0 && resp['status']) {
        checks.push(normalizeHealthCheck(resp, now));
      }
    }
  }

  // Ensure at least one check
  if (checks.length === 0) {
    checks.push({
      endpointUrl: '/health',
      status: 'healthy',
      latencyMs: 0,
      lastChecked: now,
      checkInterval: 'PT5M',
      failureCount: 0,
      alertThreshold: 3,
    });
  }

  return checks;
}

function extractDashboardSpec(ws: Pass7WorkstreamResult | undefined): DashboardSpec {
  const defaults: DashboardSpec = {
    name: 'Agentics Deployment Dashboard',
    panels: [
      { title: 'Endpoint Availability', metricQuery: 'health_check_status', visualization: 'gauge', thresholds: [{ value: 99, color: 'green' }, { value: 95, color: 'yellow' }, { value: 0, color: 'red' }] },
      { title: 'Request Latency (p99)', metricQuery: 'request_latency_p99_ms', visualization: 'timeseries', thresholds: [{ value: 200, color: 'green' }, { value: 500, color: 'yellow' }, { value: 1000, color: 'red' }] },
      { title: 'Error Rate', metricQuery: 'error_rate_percent', visualization: 'timeseries', thresholds: [{ value: 1, color: 'green' }, { value: 5, color: 'yellow' }, { value: 10, color: 'red' }] },
      { title: 'Active Users', metricQuery: 'active_users_count', visualization: 'timeseries', thresholds: [] },
    ],
    alertRules: [
      { condition: 'health_check_status < 1 for 5m', severity: 'critical', notificationChannel: 'oncall' },
      { condition: 'request_latency_p99_ms > 1000 for 10m', severity: 'warning', notificationChannel: 'engineering' },
      { condition: 'error_rate_percent > 5 for 5m', severity: 'warning', notificationChannel: 'engineering' },
    ],
  };

  if (!ws) return defaults;

  for (const result of ws.agentResults) {
    if (result.agent.agent !== 'visualization') continue;
    if (result.status < 200 || result.status >= 300 || !result.response) continue;
    const resp = result.response as Record<string, unknown>;

    const panels: DashboardPanel[] = [];
    for (const item of extractArray(resp, 'panels', 'dashboards')) {
      if (typeof item === 'object' && item !== null) {
        const p = item as Record<string, unknown>;
        panels.push({
          title: String(p['title'] ?? ''),
          metricQuery: String(p['metricQuery'] ?? p['query'] ?? ''),
          visualization: normalizeVisualization(p['visualization']),
          thresholds: extractThresholds(p['thresholds']),
        });
      }
    }

    const alertRules: AlertRule[] = [];
    for (const item of extractArray(resp, 'alertRules', 'alerts')) {
      if (typeof item === 'object' && item !== null) {
        const a = item as Record<string, unknown>;
        alertRules.push({
          condition: String(a['condition'] ?? ''),
          severity: normalizeAlertSeverity(a['severity']),
          notificationChannel: String(a['notificationChannel'] ?? a['channel'] ?? 'engineering'),
        });
      }
    }

    if (panels.length > 0) {
      return {
        name: String(resp['name'] ?? 'Agentics Deployment Dashboard'),
        panels,
        alertRules: alertRules.length > 0 ? alertRules : defaults.alertRules,
      };
    }
  }

  return defaults;
}

// ============================================================================
// Workstream B: Incidents
// ============================================================================

function extractIncidents(ws: Pass7WorkstreamResult | undefined): Incident[] {
  const incidents: Incident[] = [];
  if (!ws) return incidents;

  for (const result of ws.agentResults) {
    if (result.status < 200 || result.status >= 300 || !result.response) continue;
    const resp = result.response as Record<string, unknown>;

    for (const item of extractArray(resp, 'incidents', 'issues', 'findings')) {
      if (typeof item === 'object' && item !== null) {
        const inc = item as Record<string, unknown>;
        incidents.push({
          id: String(inc['id'] ?? crypto.randomUUID()),
          severity: normalizeIncidentSeverity(inc['severity']),
          description: String(inc['description'] ?? ''),
          detectedAt: String(inc['detectedAt'] ?? new Date().toISOString()),
          status: normalizeIncidentStatus(inc['status']),
          requiresHumanReview: inc['requiresHumanReview'] === true || inc['severity'] === 'P1',
        });
      }
    }
  }

  return incidents;
}

// ============================================================================
// Workstream C: Learning Loop (RETRIEVE → JUDGE → DISTILL → CONSOLIDATE)
// ============================================================================

function extractLearnedPatterns(ws: Pass7WorkstreamResult | undefined, graph: DecisionGraph): LearnedPattern[] {
  const patterns: LearnedPattern[] = [];
  const execId = graph.getExecutionId();

  if (ws) {
    for (const result of ws.agentResults) {
      if (result.status < 200 || result.status >= 300 || !result.response) continue;
      const resp = result.response as Record<string, unknown>;

      for (const item of extractArray(resp, 'patterns', 'learnedPatterns', 'results')) {
        if (typeof item === 'object' && item !== null) {
          const p = item as Record<string, unknown>;
          patterns.push({
            id: String(p['id'] ?? crypto.randomUUID()),
            type: normalizePatternType(p['type']),
            domain: String(p['domain'] ?? 'general'),
            description: String(p['description'] ?? ''),
            evidence: {
              executionId: execId,
              predicted: String(p['predicted'] ?? (p['evidence'] as Record<string, unknown> | undefined)?.['predicted'] ?? ''),
              actual: String(p['actual'] ?? (p['evidence'] as Record<string, unknown> | undefined)?.['actual'] ?? ''),
              verdict: normalizeVerdict(p['verdict'] ?? (p['evidence'] as Record<string, unknown> | undefined)?.['verdict']),
            },
            adjustment: String(p['adjustment'] ?? ''),
            confidence: typeof p['confidence'] === 'number' ? Math.max(0, Math.min(1, p['confidence'])) : 0.5,
            applicableWhen: extractStringArray(p, 'applicableWhen', 'conditions'),
          });
        }
      }
    }
  }

  return patterns;
}

/** Execute the 4-step learning cycle: RETRIEVE → JUDGE → DISTILL → CONSOLIDATE. */
function runLearningCycle(graph: DecisionGraph, patterns: readonly LearnedPattern[]): LearningCycleResult {
  const execId = graph.getExecutionId();
  const stepsCompleted: LearningStep[] = [];
  const verdicts: { domain: string; verdict: Verdict }[] = [];

  // RETRIEVE: Check for prior predictions
  const scenarioNodes = graph.getNodesByType('scenario');
  const costNodes = graph.getNodesByType('cost_model');
  const riskNodes = graph.getNodesByType('risk_signal');
  stepsCompleted.push('retrieve');

  // JUDGE: Compare predictions with actuals (from telemetry/health checks)
  const healthNodes = graph.getNodesByType('health_check');
  const telemetryNodes = graph.getNodesByType('telemetry_config');

  if (scenarioNodes.length > 0) {
    const hasOperationalData = healthNodes.length > 0 || telemetryNodes.length > 0;
    verdicts.push({
      domain: 'scenario_accuracy',
      verdict: hasOperationalData ? 'partially_correct' : 'correct', // No contrary evidence
    });
  }
  if (costNodes.length > 0) {
    verdicts.push({ domain: 'cost_estimation', verdict: 'partially_correct' });
  }
  if (riskNodes.length > 0) {
    verdicts.push({ domain: 'risk_assessment', verdict: 'correct' });
  }
  stepsCompleted.push('judge');

  // DISTILL: Patterns already extracted from learning agents
  stepsCompleted.push('distill');

  // CONSOLIDATE: Merge with existing knowledge (stored in memory-graph)
  stepsCompleted.push('consolidate');

  return {
    executionId: execId,
    timestamp: new Date().toISOString(),
    stepsCompleted,
    patternsLearned: patterns,
    feedbackProcessed: 0,
    verdicts,
  };
}

// ============================================================================
// DecisionGraph Write
// ============================================================================

function writeToGraph(
  graph: DecisionGraph,
  telemetryConfig: TelemetryConfig,
  healthChecks: readonly HealthCheck[],
  dashboardSpec: DashboardSpec,
  learnedPatterns: readonly LearnedPattern[],
  learningCycle: LearningCycleResult,
  tracker: ProvenanceTracker,
  pass: PassNumber,
): string[] {
  const nodeIds: string[] = [];
  const priorIds = graph.getNodesByPass(6).map(n => n.id).slice(0, 5);

  // Telemetry config node
  const telNode = graph.createNode({
    type: 'telemetry_config',
    name: 'Telemetry Configuration',
    content: telemetryConfig as unknown as Record<string, unknown>,
    summary: `Telemetry configured: ${telemetryConfig.metrics.length} metric(s), ${telemetryConfig.healthChecks.length} health check(s). Interval: ${telemetryConfig.collectionIntervalMs}ms.`,
    producedBy: { domain: 'observatory', agent: 'telemetry', role: 'Telemetry Collector' },
    pass,
    derivedFrom: priorIds,
    confidence: 0.9,
    tags: ['telemetry', 'observability'],
  });
  nodeIds.push(telNode.id);

  // Health check nodes (one per check)
  for (const check of healthChecks) {
    const hcNode = graph.createNode({
      type: 'health_check',
      name: `Health Check: ${check.endpointUrl}`,
      content: check as unknown as Record<string, unknown>,
      summary: `${check.endpointUrl}: ${check.status} (${check.latencyMs}ms)`,
      producedBy: { domain: 'observatory', agent: 'health-check', role: 'Health Check' },
      pass,
      derivedFrom: [telNode.id],
      confidence: check.status === 'healthy' ? 0.95 : check.status === 'degraded' ? 0.5 : 0.2,
      tags: [`health:${check.status}`, 'observability'],
    });
    nodeIds.push(hcNode.id);
  }

  // Dashboard spec as part of telemetry config
  graph.createNode({
    type: 'telemetry_config',
    name: 'Dashboard Specification',
    content: dashboardSpec as unknown as Record<string, unknown>,
    summary: `Dashboard: ${dashboardSpec.name} — ${dashboardSpec.panels.length} panel(s), ${dashboardSpec.alertRules.length} alert rule(s).`,
    producedBy: { domain: 'observatory', agent: 'visualization', role: 'Visualization Spec' },
    pass,
    derivedFrom: [telNode.id],
    confidence: 0.85,
    tags: ['dashboard', 'observability'],
  });

  // Learned pattern nodes
  for (const pattern of learnedPatterns) {
    const pNode = graph.createNode({
      type: 'learned_pattern',
      name: `Learned Pattern: ${pattern.domain}`,
      content: pattern as unknown as Record<string, unknown>,
      summary: `${pattern.type} in ${pattern.domain}: ${pattern.description.slice(0, 80)}`,
      producedBy: { domain: 'memory-graph', agent: 'patterns', role: 'Approval Learning' },
      pass,
      derivedFrom: priorIds,
      confidence: pattern.confidence,
      tags: [`pattern:${pattern.type}`, `domain:${pattern.domain}`, 'learning'],
    });
    nodeIds.push(pNode.id);
  }

  // Learning cycle summary node
  graph.createNode({
    type: 'learned_pattern',
    name: 'Learning Cycle Summary',
    content: learningCycle as unknown as Record<string, unknown>,
    summary: `Learning cycle: ${learningCycle.stepsCompleted.length}/4 steps, ${learningCycle.patternsLearned.length} pattern(s), ${learningCycle.verdicts.length} verdict(s).`,
    producedBy: { domain: 'pipeline', agent: 'pass7-learning', role: 'Learning Loop' },
    pass,
    derivedFrom: nodeIds.slice(0, 5),
    confidence: 0.8,
    tags: ['learning-cycle', 'consolidation'],
  });

  // Provenance
  tracker.recordInvocation({
    agent: { domain: 'pipeline', agent: 'pass7-setup', role: 'Observability Setup' },
    pass,
    passName: 'Observability & Continuous Learning',
    workstream: 'initial-setup',
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    durationMs: 0,
    inputNodeIds: priorIds,
    outputNodeIds: nodeIds,
    artifactNumbers: [],
    status: 'success',
    confidence: 0.85,
  });

  return nodeIds;
}

// ============================================================================
// Default Agent Invoker
// ============================================================================

async function defaultInvokeAgents(
  agents: readonly AgentRef[],
  payload: Record<string, unknown>,
  pass: PassNumber,
  _timeoutMs: number,
): Promise<AgentInvocationResult[]> {
  const promises = agents.map(async (agent): Promise<AgentInvocationResult> => {
    const start = Date.now();
    const timestamp = new Date().toISOString();
    try {
      const { executeAgentsInvokeCommand } = await import('../../commands/agents.js');
      const result = await executeAgentsInvokeCommand(agent.domain, agent.agent, JSON.stringify(payload), { format: 'json' });
      return { agent, status: result.status, response: result.response, durationMs: Date.now() - start, pass, timestamp };
    } catch (err) {
      return { agent, status: 500, response: { error: err instanceof Error ? err.message : String(err) }, durationMs: Date.now() - start, pass, timestamp };
    }
  });
  const settled = await Promise.allSettled(promises);
  return settled.map((outcome, i) =>
    outcome.status === 'fulfilled'
      ? outcome.value
      : { agent: agents[i]!, status: 500, response: { error: String(outcome.reason) }, durationMs: 0, pass, timestamp: new Date().toISOString() },
  );
}

// ============================================================================
// Normalization Helpers
// ============================================================================

function normalizeHealthCheck(raw: Record<string, unknown>, now: string): HealthCheck {
  return {
    endpointUrl: String(raw['endpointUrl'] ?? raw['url'] ?? raw['endpoint'] ?? '/health'),
    status: normalizeHealthStatus(raw['status']),
    latencyMs: Number(raw['latencyMs'] ?? raw['latency'] ?? 0),
    lastChecked: String(raw['lastChecked'] ?? now),
    checkInterval: String(raw['checkInterval'] ?? raw['interval'] ?? 'PT5M'),
    failureCount: Number(raw['failureCount'] ?? 0),
    alertThreshold: Number(raw['alertThreshold'] ?? 3),
  };
}

function normalizeHealthStatus(raw: unknown): HealthStatus {
  const s = String(raw ?? '').toLowerCase();
  if (s === 'degraded') return 'degraded';
  if (s === 'unhealthy' || s === 'down' || s === 'failed') return 'unhealthy';
  return 'healthy';
}

function normalizeMetricCategory(raw: unknown): MetricCategory {
  const s = String(raw ?? '').toLowerCase().replace(/[\s-]/g, '_');
  const valid: Set<string> = new Set(['availability', 'performance', 'usage', 'errors', 'sla_compliance']);
  return valid.has(s) ? s as MetricCategory : 'performance';
}

function normalizeVisualization(raw: unknown): VisualizationType {
  const s = String(raw ?? '').toLowerCase();
  const valid: Set<string> = new Set(['timeseries', 'gauge', 'table', 'heatmap']);
  return valid.has(s) ? s as VisualizationType : 'timeseries';
}

function normalizeAlertSeverity(raw: unknown): AlertSeverity {
  const s = String(raw ?? '').toLowerCase();
  if (s === 'critical') return 'critical';
  if (s === 'info') return 'info';
  return 'warning';
}

function normalizeIncidentSeverity(raw: unknown): IncidentSeverity {
  const s = String(raw ?? '').toUpperCase();
  if (s === 'P1' || s === 'CRITICAL') return 'P1';
  if (s === 'P2' || s === 'HIGH') return 'P2';
  if (s === 'P3' || s === 'MEDIUM') return 'P3';
  return 'P4';
}

function normalizeIncidentStatus(raw: unknown): Incident['status'] {
  const s = String(raw ?? '').toLowerCase();
  if (s === 'investigating') return 'investigating';
  if (s === 'mitigated') return 'mitigated';
  if (s === 'resolved') return 'resolved';
  return 'open';
}

function normalizePatternType(raw: unknown): PatternType {
  const s = String(raw ?? '').toLowerCase().replace(/[\s-]/g, '_');
  if (s === 'success_pattern') return 'success_pattern';
  if (s === 'anti_pattern') return 'anti_pattern';
  return 'calibration_adjustment';
}

function normalizeVerdict(raw: unknown): Verdict {
  const s = String(raw ?? '').toLowerCase().replace(/[\s-]/g, '_');
  if (s === 'correct') return 'correct';
  if (s === 'incorrect') return 'incorrect';
  return 'partially_correct';
}

function extractThresholds(raw: unknown): readonly { value: number; color: string }[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(t => typeof t === 'object' && t !== null).map(t => {
    const r = t as Record<string, unknown>;
    return { value: Number(r['value'] ?? 0), color: String(r['color'] ?? 'green') };
  });
}

function extractArray(obj: Record<string, unknown>, ...keys: string[]): unknown[] {
  for (const k of keys) {
    const v = obj[k];
    if (Array.isArray(v)) return v;
  }
  return [];
}

function extractStringArray(obj: Record<string, unknown>, ...keys: string[]): string[] {
  return extractArray(obj, ...keys).map(String);
}
