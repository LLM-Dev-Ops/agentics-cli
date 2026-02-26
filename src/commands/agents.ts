/**
 * Agents Command
 *
 * Routes CLI invocations to 27 downstream agent Cloud Functions.
 * Uses the existing adapter layer (createAdapter + invoke_agent).
 *
 * Usage:
 *   agentics agents list
 *   agentics agents health <domain>
 *   agentics agents invoke <domain> <agent> [json-payload]
 */

import { loadEndpointConfig } from '../config/endpoints.js';
import { createAdapter } from '../adapters/base-adapter.js';
import type { ServiceName } from '../adapters/base-adapter.js';
import type { CommandOptions } from '../types/index.js';
import { getAnthropicApiKey } from '../utils/credentials.js';
import { executeSimulateCommand } from './simulate.js';
import {
  detectEnterpriseSimulation,
  classifyIntent as semanticClassifyIntent,
  classifyMultiIntent as semanticClassifyMultiIntent,
} from './intent-classifier.js';
import {
  isRepoAgentMode,
  hasRepoAgent,
  executeRepoAgent,
} from '../agents/repo-agent-runner.js';

// ============================================================================
// Domain Registry
// ============================================================================

interface AgentDomain {
  serviceName: ServiceName;
  agents: string[];
  phase: string;
}

export const AGENT_DOMAINS: Record<string, AgentDomain> = {
  'test-bench': {
    serviceName: 'test-bench-agents',
    agents: ['benchmark', 'compare', 'regression', 'quality', 'hallucination', 'faithfulness', 'bias', 'prompt-sensitivity', 'consistency', 'stress', 'red-team', 'adversarial', 'golden-dataset', 'synthetic-data'],
    phase: 'Phase 1: Evaluation',
  },
  'observatory': {
    serviceName: 'observatory-agents',
    agents: ['telemetry', 'usage-patterns', 'failures', 'health-check', 'slo', 'post-mortem', 'visualization'],
    phase: 'Phase 1: Telemetry',
  },
  'shield': {
    serviceName: 'shield-agents',
    agents: ['prompt-injection', 'pii', 'redaction', 'secrets', 'toxicity', 'safety-boundary', 'moderation', 'abuse', 'credential-exposure'],
    phase: 'Phase 1: Safety',
  },
  'sentinel': {
    serviceName: 'sentinel-agents',
    agents: ['anomaly', 'drift', 'alert', 'correlation', 'rca'],
    phase: 'Phase 2: Operational Intelligence',
  },
  'memory-graph': {
    serviceName: 'memory-graph-agents',
    agents: ['conversation', 'lineage', 'decisions', 'knowledge-graph', 'retrieval', 'patterns'],
    phase: 'Phase 2: Operational Intelligence',
  },
  'latency-lens': {
    serviceName: 'latency-lens-agents',
    agents: ['latency', 'cold-start'],
    phase: 'Phase 2: Operational Intelligence',
  },
  'forge': {
    serviceName: 'forge-agents',
    agents: ['sdk', 'cli', 'api-translation', 'version-compat'],
    phase: 'Phase 2: Operational Intelligence',
  },
  'edge': {
    serviceName: 'edge-agents',
    agents: ['tool-invoke', 'circuit-breaker', 'failover', 'execution-guard', 'caching'],
    phase: 'Phase 3: Automation & Resilience',
  },
  'auto-optimizer': {
    serviceName: 'auto-optimizer-agents',
    agents: ['self-optimize', 'token', 'model-select'],
    phase: 'Phase 3: Automation & Resilience',
  },
  'incident-manager': {
    serviceName: 'incident-manager-agents',
    agents: ['escalation', 'post-mortem', 'hitl'],
    phase: 'Phase 3: Automation & Resilience',
  },
  'orchestrator': {
    serviceName: 'orchestrator-agents',
    agents: ['workflow', 'scheduler', 'dependencies', 'retry', 'parallel', 'state-machine', 'swarm'],
    phase: 'Phase 3: Automation & Resilience',
  },
  'costops': {
    serviceName: 'costops-agents',
    agents: ['attribution', 'forecast', 'budget', 'roi', 'tradeoff'],
    phase: 'Phase 4: Governance & FinOps',
  },
  'governance-dashboard': {
    serviceName: 'governance-dashboard-agents',
    agents: ['audit', 'impact', 'oversight'],
    phase: 'Phase 4: Governance & FinOps',
  },
  'policy-engine': {
    serviceName: 'policy-engine-agents',
    agents: ['enforce', 'constraints', 'approval'],
    phase: 'Phase 4: Governance & FinOps',
  },
  'registry': {
    serviceName: 'registry-agents',
    agents: ['index', 'reputation', 'bootstrap'],
    phase: 'Phase 5: Ecosystem',
  },
  'marketplace': {
    serviceName: 'marketplace-agents',
    agents: ['package', 'deprecation'],
    phase: 'Phase 5: Ecosystem',
  },
  'analytics-hub': {
    serviceName: 'analytics-hub-agents',
    agents: ['consensus', 'recommendation'],
    phase: 'Phase 5: Ecosystem',
  },
  'config-manager': {
    serviceName: 'config-manager-agents',
    agents: ['validate'],
    phase: 'Phase 6: Core Infrastructure',
  },
  'schema-registry': {
    serviceName: 'schema-registry-agents',
    agents: ['validate'],
    phase: 'Phase 6: Core Infrastructure',
  },
  'connector-hub': {
    serviceName: 'connector-hub-agents',
    agents: ['erp-surface', 'database-query', 'webhook-ingest', 'event-normalize', 'auth-identity'],
    phase: 'Phase 6: Core Infrastructure',
  },
  'copilot': {
    serviceName: 'copilot-agents',
    agents: ['planner', 'config', 'decomposer', 'clarifier', 'intent', 'reflection', 'meta-reasoner'],
    phase: 'Phase 7: Intelligence',
  },
  'simulator': {
    serviceName: 'simulator-agents',
    agents: ['what-if', 'scenario'],
    phase: 'Phase 7: Intelligence',
  },
  'benchmark-exchange': {
    serviceName: 'benchmark-exchange-agents',
    agents: ['publish'],
    phase: 'Phase 7: Intelligence',
  },
  'inference-gateway': {
    serviceName: 'inference-gateway-agents',
    agents: ['route'],
    phase: 'Phase 7: Intelligence',
  },
  'data-vault': {
    serviceName: 'data-vault-agents',
    agents: ['access-control', 'anonymize'],
    phase: 'Phase 7: Intelligence',
  },
  'research-lab': {
    serviceName: 'research-lab-agents',
    agents: ['hypothesis', 'metrics'],
    phase: 'Phase 7: Intelligence',
  },
  'platform': {
    serviceName: 'platform-agents',
    agents: ['decision', 'executive-summary', 'decision-memo', 'risk-score'],
    phase: 'Phase 9: Apex Platform',
  },
};

// ============================================================================
// Types
// ============================================================================

export interface AgentsListResult {
  domains: { name: string; serviceName: string; agents: string[]; agentCount: number; phase: string }[];
  totalDomains: number;
  totalAgents: number;
  timing: number;
}

export interface AgentsHealthResult {
  domain: string;
  serviceName: string;
  healthy: boolean;
  response: unknown;
  timing: number;
}

export interface AgentsInvokeResult {
  domain: string;
  agent: string;
  status: number;
  response: unknown;
  timing: number;
}

// ============================================================================
// Command Implementations
// ============================================================================

export async function executeAgentsListCommand(
  _options: CommandOptions,
): Promise<AgentsListResult> {
  const start = Date.now();
  const domains = Object.entries(AGENT_DOMAINS).map(([name, d]) => ({
    name,
    serviceName: d.serviceName,
    agents: d.agents,
    agentCount: d.agents.length,
    phase: d.phase,
  }));

  const totalAgents = domains.reduce((sum, d) => sum + d.agentCount, 0);

  return {
    domains,
    totalDomains: domains.length,
    totalAgents,
    timing: Date.now() - start,
  };
}

export async function executeAgentsHealthCommand(
  domain: string,
  options: CommandOptions,
): Promise<AgentsHealthResult> {
  const start = Date.now();
  const domainConfig = AGENT_DOMAINS[domain];
  if (!domainConfig) {
    const validDomains = Object.keys(AGENT_DOMAINS).join(', ');
    throw new Error(`Unknown domain '${domain}'. Valid domains: ${validDomains}`);
  }

  const config = loadEndpointConfig(domainConfig.serviceName);
  const correlationId = options.trace_id ?? crypto.randomUUID();
  const adapter = createAdapter(domainConfig.serviceName, config, correlationId);

  const response = await adapter.invoke({
    endpoint: '/health',
    method: 'GET',
    headers: {},
    timeout: 5000,
  });

  return {
    domain,
    serviceName: domainConfig.serviceName,
    healthy: response.status === 200,
    response: response.body,
    timing: Date.now() - start,
  };
}

export async function executeAgentsInvokeCommand(
  domain: string,
  agent: string,
  payload: unknown,
  options: CommandOptions,
): Promise<AgentsInvokeResult> {
  const start = Date.now();
  const domainConfig = AGENT_DOMAINS[domain];
  if (!domainConfig) {
    const validDomains = Object.keys(AGENT_DOMAINS).join(', ');
    throw new Error(`Unknown domain '${domain}'. Valid domains: ${validDomains}`);
  }

  if (!domainConfig.agents.includes(agent)) {
    throw new Error(`Unknown agent '${agent}' in domain '${domain}'. Valid agents: ${domainConfig.agents.join(', ')}`);
  }

  const correlationId = options.trace_id ?? crypto.randomUUID();

  // Normalize payload: if caller sends generic { text: "..." } but the domain
  // expects a different schema, transform it via buildDomainPayload.
  let normalizedPayload = payload;
  if (payload && typeof payload === 'object' && 'text' in payload) {
    const payloadObj = payload as Record<string, unknown>;
    const text = payloadObj['text'] as string;
    if (text && typeof text === 'string') {
      // Check if domain needs specific payload format
      const needsTransform = ['simulator', 'platform', 'copilot', 'governance-dashboard', 'costops', 'policy-engine', 'sentinel'].includes(domain);
      if (needsTransform) {
        normalizedPayload = buildDomainPayload(domain, agent, text, correlationId);
      }
    }
  }

  // Repo-local mode: download the Cloud Function's source, inject claude shim,
  // and run the handler in-process. Uses Claude Code (Claude Max) for AI — no API key.
  if (isRepoAgentMode() && hasRepoAgent(domain)) {
    if (options.verbose) {
      console.error(`[repo-local] Executing ${domain}/${agent} using repo code + Claude Code`);
    }
    const repoResult = await executeRepoAgent(domain, agent, normalizedPayload as Record<string, unknown>, correlationId);
    // If repo execution succeeded (or returned a meaningful non-provisioning error), use it.
    // If 502 (source unavailable / provisioning failure), fall through to the Cloud Function
    // adapter path so the agent can still be reached via its deployed endpoint.
    if (repoResult.status !== 502) {
      return repoResult;
    }
    console.error(`[repo-local] ${domain}/${agent} source unavailable, falling back to cloud endpoint`);
  }

  const config = loadEndpointConfig(domainConfig.serviceName);
  const adapter = createAdapter(domainConfig.serviceName, config, correlationId);

  // Attach Anthropic API key for agents that need LLM inference (e.g. copilot)
  const invokeHeaders: Record<string, string> = {};
  if (domainConfig.serviceName === 'copilot-agents') {
    const anthropicKey = await getAnthropicApiKey();
    if (anthropicKey) {
      invokeHeaders['X-Anthropic-Api-Key'] = anthropicKey;
    }
  }

  // governance-dashboard requires execution context in HTTP headers, not body
  if (domain === 'governance-dashboard') {
    invokeHeaders['x-execution-id'] = correlationId;
    invokeHeaders['x-parent-span-id'] = correlationId;
  }

  const response = await adapter.invoke({
    endpoint: `/v1/${domain}/${agent}`,
    method: 'POST',
    headers: invokeHeaders,
    body: normalizedPayload,
  });

  return {
    domain,
    agent,
    status: response.status,
    response: response.body,
    timing: Date.now() - start,
  };
}

// ============================================================================
// Formatters
// ============================================================================

export function formatAgentsListForDisplay(result: AgentsListResult): string {
  const lines: string[] = [];
  lines.push(`Downstream Agent Services: ${result.totalDomains} domains, ${result.totalAgents} agents`);
  lines.push('');

  let currentPhase = '';
  for (const d of result.domains) {
    if (d.phase !== currentPhase) {
      currentPhase = d.phase;
      lines.push(`  ${currentPhase}`);
    }
    const agentList = d.agents.join(', ');
    lines.push(`    ${d.name.padEnd(24)} [${d.agentCount}] ${agentList}`);
  }

  return lines.join('\n');
}

export function formatAgentResultForDisplay(result: AgentsInvokeResult): string {
  const lines: string[] = [];
  lines.push(`Agent: ${result.domain}/${result.agent}`);
  lines.push(`Status: ${result.status}`);
  lines.push(`Timing: ${result.timing}ms`);
  lines.push('');
  lines.push(JSON.stringify(result.response, null, 2));
  return lines.join('\n');
}

// ============================================================================
// Natural Language Routing
// ============================================================================

export interface IntentClassification {
  domain: string;
  agent: string;
  confidence: number;
  suggested_payload: Record<string, unknown>;
  reasoning?: string;
  alternatives?: Array<{
    domain: string;
    agent: string;
    confidence: number;
  }>;
}

export interface NaturalLanguageRouteResult {
  intent: IntentClassification;
  invocation: AgentsInvokeResult;
  timing: number;
}

export interface MultiAgentRouteResult {
  query: string;
  intents: IntentClassification[];
  invocations: Array<{
    intent: IntentClassification;
    result: AgentsInvokeResult | { error: string };
  }>;
  timing: number;
}

export type RouteResult =
  | { kind: 'single'; result: NaturalLanguageRouteResult }
  | { kind: 'multi'; result: MultiAgentRouteResult };

const NL_MINIMUM_CONFIDENCE = 0.2;
const NL_LOW_CONFIDENCE = 0.5;

/**
 * Route a natural language query to the appropriate downstream agent.
 *
 * Calls copilot/intent with the query + full domain registry.
 * The end-user's Anthropic API key is passed via X-Anthropic-Api-Key header
 * so copilot-agents can use it for LLM inference (billed to end-user, not platform).
 * Validates the classification, then dispatches to the target agent.
 */
// ============================================================================
// Keyword-Based Intent Classification (fallback when no API key / LLM fails)
// ============================================================================

interface KeywordRule {
  domain: string;
  agent: string;
  keywords: string[];
}

/**
 * Static keyword rules mapping common phrases to domain/agent pairs.
 * Used as a fallback when LLM-based classification is unavailable.
 * Order matters: first match wins — more specific rules go first.
 */
const KEYWORD_RULES: KeywordRule[] = [
  // ==========================================================================
  // auto-optimizer (3/3 agents)
  // ==========================================================================
  { domain: 'auto-optimizer', agent: 'token', keywords: ['token optim', 'optimize token', 'token usage', 'reduce token', 'token cost', 'token waste', 'token efficien', 'token budget', 'token count', 'token spend', 'token saving'] },
  { domain: 'auto-optimizer', agent: 'model-select', keywords: ['select model', 'model select', 'choose model', 'best model', 'which model', 'model recommend', 'model comparison', 'cheapest model', 'fastest model', 'model picker'] },
  { domain: 'auto-optimizer', agent: 'self-optimize', keywords: ['self optim', 'auto optim', 'optimize system', 'optimize performance', 'optimize cost', 'reduce cost', 'cost optim', 'optimize spend', 'optimize prompt', 'tune prompt', 'prompt optim'] },

  // ==========================================================================
  // shield (9/9 agents)
  // ==========================================================================
  { domain: 'shield', agent: 'prompt-injection', keywords: ['injection', 'prompt attack', 'jailbreak', 'prompt inject', 'inject attack', 'prompt hack'] },
  { domain: 'shield', agent: 'pii', keywords: ['pii', 'personal info', 'personally identifiable', 'personal data', 'phone number', 'social security', 'ssn detect'] },
  { domain: 'shield', agent: 'secrets', keywords: ['secret scan', 'credential leak', 'api key leak', 'password leak', 'leaked secret', 'exposed key', 'secret detect'] },
  { domain: 'shield', agent: 'toxicity', keywords: ['toxic', 'toxicity', 'harmful content', 'offensive', 'hate speech', 'harmful output'] },
  { domain: 'shield', agent: 'moderation', keywords: ['moderat', 'content filter', 'content polic', 'content review', 'flag content'] },
  { domain: 'shield', agent: 'abuse', keywords: ['abuse detect', 'misuse detect', 'abuse pattern', 'bad actor', 'malicious use'] },
  { domain: 'shield', agent: 'redaction', keywords: ['redact', 'mask data', 'scrub data', 'censor output', 'remove sensitiv'] },
  { domain: 'shield', agent: 'safety-boundary', keywords: ['safety boundar', 'safety limit', 'safety check', 'safe to show', 'is it safe', 'safety gate', 'crosses boundar'] },
  { domain: 'shield', agent: 'credential-exposure', keywords: ['credential expos', 'exposed credential', 'leaked credential', 'key exposure', 'password expos', 'api key expos'] },

  // ==========================================================================
  // test-bench (14/14 agents)
  // ==========================================================================
  { domain: 'test-bench', agent: 'red-team', keywords: ['red team', 'red-team', 'red team exercise'] },
  { domain: 'test-bench', agent: 'adversarial', keywords: ['adversarial', 'adversary', 'attack surface', 'adversarial input'] },
  { domain: 'test-bench', agent: 'benchmark', keywords: ['benchmark', 'bench mark', 'eval score', 'model benchmark'] },
  { domain: 'test-bench', agent: 'compare', keywords: ['compare model', 'model a vs', 'model b vs', 'side by side', 'head to head'] },
  { domain: 'test-bench', agent: 'regression', keywords: ['regression test', 'regression check', 'regression suite', 'regressed', 'performance regress'] },
  { domain: 'test-bench', agent: 'quality', keywords: ['quality test', 'test quality', 'quality eval', 'output quality', 'quality score'] },
  { domain: 'test-bench', agent: 'hallucination', keywords: ['hallucin', 'fabricat', 'grounding', 'made up fact', 'invented fact'] },
  { domain: 'test-bench', agent: 'faithfulness', keywords: ['faithful', 'faithfulness', 'grounded in source', 'source faithful', 'accurate to source'] },
  { domain: 'test-bench', agent: 'bias', keywords: ['bias', 'fairness', 'biased output', 'unfair', 'discriminat'] },
  { domain: 'test-bench', agent: 'prompt-sensitivity', keywords: ['prompt sensitiv', 'sensitivity test', 'prompt variation', 'prompt robust', 'input sensitiv'] },
  { domain: 'test-bench', agent: 'consistency', keywords: ['consistency test', 'consistent output', 'output consistenc', 'reproducib', 'deterministic'] },
  { domain: 'test-bench', agent: 'stress', keywords: ['stress test', 'load test', 'high concurrency', 'throughput test', '10k request', '1000 request'] },
  { domain: 'test-bench', agent: 'golden-dataset', keywords: ['golden dataset', 'golden set', 'gold standard', 'reference dataset', 'evaluation dataset', 'eval set'] },
  { domain: 'test-bench', agent: 'synthetic-data', keywords: ['synthetic data', 'generate data', 'fake data', 'test data generat', 'data augment', 'artificial data'] },

  // ==========================================================================
  // costops (5/5 agents)
  // ==========================================================================
  { domain: 'costops', agent: 'attribution', keywords: ['cost attribut', 'cost breakdown', 'spending breakdown', 'how much am i spend', 'cost per', 'spend by', 'spending by team', 'cost by project'] },
  { domain: 'costops', agent: 'forecast', keywords: ['cost forecast', 'spending forecast', 'predict cost', 'future cost', 'budget forecast', 'next quarter cost', 'project spending'] },
  { domain: 'costops', agent: 'budget', keywords: ['budget', 'spending limit', 'within budget', 'over budget', 'budget alert', 'budget threshold'] },
  { domain: 'costops', agent: 'roi', keywords: ['roi', 'return on invest', 'cost benefit', 'value delivered', 'payback period'] },
  { domain: 'costops', agent: 'tradeoff', keywords: ['tradeoff', 'trade-off', 'cost quality', 'cost vs quality', 'build or buy', 'build vs buy', 'price performance', 'bang for buck'] },

  // ==========================================================================
  // observatory (7/7 agents)
  // ==========================================================================
  { domain: 'observatory', agent: 'telemetry', keywords: ['telemetry', 'metrics collect', 'emit metric', 'telemetry data'] },
  { domain: 'observatory', agent: 'usage-patterns', keywords: ['usage pattern', 'usage trend', 'usage analys', 'usage over time', 'adoption metric'] },
  { domain: 'observatory', agent: 'failures', keywords: ['failure analys', 'error rate', 'failure rate', 'failure trend', 'error trend', 'failing request'] },
  { domain: 'observatory', agent: 'health-check', keywords: ['health check', 'service health', 'system health', 'is it up', 'service status', 'uptime'] },
  { domain: 'observatory', agent: 'slo', keywords: ['slo', 'sli', 'service level', 'error budget', 'nines of availability'] },
  { domain: 'observatory', agent: 'post-mortem', keywords: ['outage review', 'blameless review'] },
  { domain: 'observatory', agent: 'visualization', keywords: ['visualiz', 'dashboard', 'chart', 'graph metric', 'plot data', 'show me a graph'] },

  // ==========================================================================
  // sentinel (5/5 agents)
  // ==========================================================================
  { domain: 'sentinel', agent: 'anomaly', keywords: ['anomal', 'outlier', 'unusual', 'unexpected spike'] },
  { domain: 'sentinel', agent: 'drift', keywords: ['drift', 'distribution shift', 'model drift', 'data drift', 'concept drift', 'feature drift'] },
  { domain: 'sentinel', agent: 'rca', keywords: ['root cause', 'rca', 'why did', 'root-cause', 'diagnos'] },
  { domain: 'sentinel', agent: 'alert', keywords: ['set up alert', 'alert rule', 'alert config', 'pager', 'notify when'] },
  { domain: 'sentinel', agent: 'correlation', keywords: ['correlat', 'correlated event', 'event correlation', 'pattern correlation', 'cross-signal'] },

  // ==========================================================================
  // memory-graph (6/6 agents)
  // ==========================================================================
  { domain: 'memory-graph', agent: 'lineage', keywords: ['lineage', 'decision history', 'decision trail', 'provenance'] },
  { domain: 'memory-graph', agent: 'conversation', keywords: ['conversation history', 'chat history', 'previous conversation', 'session history'] },
  { domain: 'memory-graph', agent: 'decisions', keywords: ['decision log', 'decision record', 'past decision', 'decision made', 'track decision'] },
  { domain: 'memory-graph', agent: 'knowledge-graph', keywords: ['knowledge graph', 'entity relation', 'knowledge base', 'entity map'] },
  { domain: 'memory-graph', agent: 'retrieval', keywords: ['retriev from memory', 'fetch context', 'recall from', 'find in memory', 'search memory'] },
  { domain: 'memory-graph', agent: 'patterns', keywords: ['learned pattern', 'pattern detect', 'recurring pattern', 'behavior pattern', 'pattern histor'] },

  // ==========================================================================
  // latency-lens (2/2 agents)
  // ==========================================================================
  { domain: 'latency-lens', agent: 'latency', keywords: ['latency', 'response time', 'slow response', 'how fast', 'p99', 'p95', 'p50', 'tail latency', 'time to first token', 'ttft'] },
  { domain: 'latency-lens', agent: 'cold-start', keywords: ['cold start', 'cold-start', 'startup time', 'warm up', 'warm-up', 'first request slow', 'initialization time'] },

  // ==========================================================================
  // forge (4/4 agents)
  // ==========================================================================
  { domain: 'forge', agent: 'sdk', keywords: ['generate sdk', 'sdk generat', 'client library', 'sdk build', 'create sdk'] },
  { domain: 'forge', agent: 'cli', keywords: ['generate cli', 'cli generat', 'cli wrapper', 'cli tool generat', 'build cli'] },
  { domain: 'forge', agent: 'api-translation', keywords: ['api translat', 'convert api', 'openapi', 'swagger', 'api convert', 'api transform'] },
  { domain: 'forge', agent: 'version-compat', keywords: ['version compat', 'backward compat', 'breaking change', 'api version', 'version check', 'deprecated api'] },

  // ==========================================================================
  // edge (5/5 agents)
  // ==========================================================================
  { domain: 'edge', agent: 'tool-invoke', keywords: ['tool invoke', 'invoke tool', 'call tool', 'tool call', 'function call agent'] },
  { domain: 'edge', agent: 'circuit-breaker', keywords: ['circuit break', 'circuit-break', 'open circuit', 'trip circuit', 'breaker pattern'] },
  { domain: 'edge', agent: 'failover', keywords: ['failover', 'fail over', 'fallback endpoint', 'backup endpoint', 'failover config'] },
  { domain: 'edge', agent: 'execution-guard', keywords: ['execution guard', 'exec guard', 'execution limit', 'run guard', 'execution boundar'] },
  { domain: 'edge', agent: 'caching', keywords: ['cache layer', 'cache config', 'response cache', 'cache hit', 'cache miss', 'invalidate cache', 'cache ttl'] },

  // ==========================================================================
  // incident-manager (3/3 agents)
  // ==========================================================================
  { domain: 'incident-manager', agent: 'escalation', keywords: ['escalat', 'page on-call', 'page sre', 'critical incident', 'incident escalat'] },
  { domain: 'incident-manager', agent: 'post-mortem', keywords: ['post-mortem', 'postmortem', 'post mortem', 'incident review'] },
  { domain: 'incident-manager', agent: 'hitl', keywords: ['human in the loop', 'hitl', 'human review', 'manual review', 'human approval', 'human oversight', 'manual override'] },

  // ==========================================================================
  // orchestrator (7/7 agents)
  // ==========================================================================
  { domain: 'orchestrator', agent: 'workflow', keywords: ['workflow', 'pipeline', 'orchestrat', 'flow builder', 'agent pipeline'] },
  { domain: 'orchestrator', agent: 'scheduler', keywords: ['schedule', 'cron', 'recurring', 'nightly job', 'scheduled task', 'periodic'] },
  { domain: 'orchestrator', agent: 'dependencies', keywords: ['dependenc', 'dependency graph', 'task depend', 'depends on', 'prerequisit', 'blocked by'] },
  { domain: 'orchestrator', agent: 'retry', keywords: ['retry polic', 'retry config', 'retry strateg', 'backoff', 'exponential retry'] },
  { domain: 'orchestrator', agent: 'parallel', keywords: ['parallel exec', 'run parallel', 'run concurrent', 'fan out', 'fan-out', 'run simultaneously'] },
  { domain: 'orchestrator', agent: 'state-machine', keywords: ['state machine', 'state-machine', 'state transition', 'finite state', 'fsm'] },
  { domain: 'orchestrator', agent: 'swarm', keywords: ['swarm orchestrat', 'agent swarm', 'swarm status', 'multi-agent swarm'] },

  // ==========================================================================
  // governance-dashboard (3/3 agents)
  // ==========================================================================
  { domain: 'governance-dashboard', agent: 'audit', keywords: ['audit trail', 'audit log', 'governance audit', 'compliance', 'compliant', 'regulat', 'data residency', 'gdpr', 'hipaa', 'consent', 'sox', 'pci'] },
  { domain: 'governance-dashboard', agent: 'impact', keywords: ['impact analys', 'blast radius', 'change impact', 'downstream impact', 'affected service'] },
  { domain: 'governance-dashboard', agent: 'oversight', keywords: ['oversight', 'governance oversight', 'ai oversight', 'oversight board', 'governance review', 'supervision'] },

  // ==========================================================================
  // policy-engine (3/3 agents)
  // ==========================================================================
  { domain: 'policy-engine', agent: 'enforce', keywords: ['enforce policy', 'policy enforce', 'apply policy', 'enforce rule', 'policy check', 'policy gate'] },
  { domain: 'policy-engine', agent: 'constraints', keywords: ['constraint', 'guardrail', 'rate limit', 'usage limit', 'policy constraint'] },
  { domain: 'policy-engine', agent: 'approval', keywords: ['approval', 'approve', 'sign-off', 'sign off', 'require approval', 'pending approval', 'approval workflow'] },

  // ==========================================================================
  // registry (3/3 agents)
  // ==========================================================================
  { domain: 'registry', agent: 'index', keywords: ['agent index', 'agent registry', 'registered agent', 'agent catalog', 'discover agent'] },
  { domain: 'registry', agent: 'reputation', keywords: ['reputation', 'agent rating', 'trust score', 'reliability score', 'agent reputation'] },
  { domain: 'registry', agent: 'bootstrap', keywords: ['bootstrap agent', 'agent bootstrap', 'scaffold agent', 'onboard agent'] },

  // ==========================================================================
  // marketplace (2/2 agents)
  // ==========================================================================
  { domain: 'marketplace', agent: 'package', keywords: ['marketplace', 'install agent', 'agent package', 'marketplace search', 'agent plugin'] },
  { domain: 'marketplace', agent: 'deprecation', keywords: ['deprecat', 'end of life', 'sunset', 'eol', 'phase out', 'removal notice'] },

  // ==========================================================================
  // analytics-hub (2/2 agents)
  // ==========================================================================
  { domain: 'analytics-hub', agent: 'consensus', keywords: ['consensus build', 'group decision', 'collective opinion', 'consensus view'] },
  { domain: 'analytics-hub', agent: 'recommendation', keywords: ['recommendation report', 'what should i', 'recommend', 'best practice report'] },

  // ==========================================================================
  // config-manager (1/1 agents)
  // ==========================================================================
  { domain: 'config-manager', agent: 'validate', keywords: ['validate config', 'config valid', 'check config', 'configuration check', 'config error'] },

  // ==========================================================================
  // schema-registry (1/1 agents)
  // ==========================================================================
  { domain: 'schema-registry', agent: 'validate', keywords: ['schema valid', 'validate schema', 'json schema', 'schema check', 'schema error'] },

  // ==========================================================================
  // connector-hub (5/5 agents)
  // ==========================================================================
  { domain: 'connector-hub', agent: 'erp-surface', keywords: ['erp', 'enterprise resource', 'sap', 'salesforce', 'erp integrat'] },
  { domain: 'connector-hub', agent: 'database-query', keywords: ['query database', 'database query', 'sql query', 'db query', 'run query', 'select from'] },
  { domain: 'connector-hub', agent: 'webhook-ingest', keywords: ['webhook', 'ingest event', 'webhook endpoint', 'receive webhook', 'webhook setup'] },
  { domain: 'connector-hub', agent: 'event-normalize', keywords: ['event normaliz', 'normalize event', 'event transform', 'standardize event', 'event format'] },
  { domain: 'connector-hub', agent: 'auth-identity', keywords: ['auth identity', 'identity provider', 'idp', 'sso', 'oauth', 'saml', 'identity federation'] },

  // ==========================================================================
  // copilot (7/7 agents)
  // ==========================================================================
  { domain: 'copilot', agent: 'planner', keywords: ['plan task', 'create plan', 'task plan', 'action plan', 'project plan'] },
  { domain: 'copilot', agent: 'config', keywords: ['copilot config', 'configure copilot', 'agent config setup'] },
  { domain: 'copilot', agent: 'decomposer', keywords: ['decompose', 'break down task', 'split task', 'subtask', 'task decompos'] },
  { domain: 'copilot', agent: 'clarifier', keywords: ['clarif', 'what do you mean', 'ambiguous request', 'unclear request', 'refine request'] },
  { domain: 'copilot', agent: 'intent', keywords: ['classify intent', 'detect intent', 'intent classif', 'user intent'] },
  { domain: 'copilot', agent: 'reflection', keywords: ['reflect on', 'self assess', 'self-assess', 'introspect', 'how did i do'] },
  { domain: 'copilot', agent: 'meta-reasoner', keywords: ['meta reason', 'meta-reason', 'reasoning chain', 'chain of thought', 'reasoning trace'] },

  // ==========================================================================
  // simulator (2/2 agents)
  // ==========================================================================
  { domain: 'simulator', agent: 'what-if', keywords: ['what-if', 'what if', 'simulat', 'hypothetical'] },
  { domain: 'simulator', agent: 'scenario', keywords: ['scenario plan', 'scenario test', 'scenario analys', 'deployment scenario', 'failure scenario'] },

  // ==========================================================================
  // benchmark-exchange (1/1 agents)
  // ==========================================================================
  { domain: 'benchmark-exchange', agent: 'publish', keywords: ['publish benchmark', 'share benchmark', 'benchmark exchange', 'submit benchmark', 'benchmark leaderboard'] },

  // ==========================================================================
  // inference-gateway (1/1 agents)
  // ==========================================================================
  { domain: 'inference-gateway', agent: 'route', keywords: ['inference route', 'route request', 'gateway route', 'load balance model', 'model route', 'inference gateway'] },

  // ==========================================================================
  // data-vault (2/2 agents)
  // ==========================================================================
  { domain: 'data-vault', agent: 'anonymize', keywords: ['anonymize', 'anonymis', 'de-identify', 'deidentif', 'mask identit', 'strip pii'] },
  { domain: 'data-vault', agent: 'access-control', keywords: ['access control', 'who has access', 'rbac', 'role based access', 'data access'] },

  // ==========================================================================
  // research-lab (2/2 agents)
  // ==========================================================================
  { domain: 'research-lab', agent: 'hypothesis', keywords: ['hypothesis', 'experiment', 'a/b test', 'ab test', 'hypothesis test', 'statistical test'] },
  { domain: 'research-lab', agent: 'metrics', keywords: ['metrics analys', 'analyze metrics', 'kpi', 'key performance', 'metric trend'] },

  // ==========================================================================
  // platform (4/4 agents)
  // ==========================================================================
  { domain: 'platform', agent: 'decision', keywords: ['make decision', 'go no-go', 'go/no-go', 'decision support', 'decision framework', 'should we'] },
  { domain: 'platform', agent: 'executive-summary', keywords: ['executive summary', 'exec summary', 'summary report', 'tldr', 'tl;dr', 'overview report', 'board summary'] },
  { domain: 'platform', agent: 'decision-memo', keywords: ['decision memo', 'decision document', 'memo for', 'write memo', 'decision paper'] },
  { domain: 'platform', agent: 'risk-score', keywords: ['risk score', 'risk assess', 'risk analys', 'risk evaluat', 'risk level', 'risk rating', 'how risky'] },
];

// ============================================================================
// Multi-Agent Combo Classification (invoke 2-5 agents in parallel)
// ============================================================================

interface MultiAgentCombo {
  id: string;
  keywords: string[];
  agents: Array<{ domain: string; agent: string }>;
}

/**
 * Multi-agent combos for complex queries. Checked BEFORE single-agent keywords.
 * Each combo maps a query pattern to 2-5 agents that should all be invoked in parallel.
 */
const MULTI_AGENT_COMBOS: MultiAgentCombo[] = [
  // === Cost & Optimization ===
  { id: 'cost-analysis', keywords: ['how much am i spend', 'cost analysis', 'spending report', 'cost review', 'what are we spend', 'spending on ai', 'ai cost', 'ai spend', 'total cost', 'monthly cost'],
    agents: [{ domain: 'costops', agent: 'attribution' }, { domain: 'costops', agent: 'forecast' }, { domain: 'costops', agent: 'roi' }] },
  { id: 'token-optimization', keywords: ['optimize token', 'token optim', 'reduce token', 'token usage for', 'token cost'],
    agents: [{ domain: 'auto-optimizer', agent: 'token' }, { domain: 'auto-optimizer', agent: 'model-select' }, { domain: 'costops', agent: 'attribution' }] },
  { id: 'full-optimization', keywords: ['optimize everything', 'full system optim', 'comprehensive optim'],
    agents: [{ domain: 'auto-optimizer', agent: 'self-optimize' }, { domain: 'auto-optimizer', agent: 'token' }, { domain: 'auto-optimizer', agent: 'model-select' }, { domain: 'costops', agent: 'tradeoff' }, { domain: 'latency-lens', agent: 'latency' }] },
  { id: 'cost-quality-tradeoff', keywords: ['cost vs quality', 'cost quality tradeoff', 'cheapest good', 'bang for buck'],
    agents: [{ domain: 'costops', agent: 'tradeoff' }, { domain: 'costops', agent: 'roi' }, { domain: 'auto-optimizer', agent: 'model-select' }] },

  // === Security ===
  { id: 'security-scan', keywords: ['security scan', 'scan for security', 'security issue', 'security check', 'is this safe', 'safety scan', 'check security', 'vulnerability scan', 'secure enough'],
    agents: [{ domain: 'shield', agent: 'prompt-injection' }, { domain: 'shield', agent: 'pii' }, { domain: 'shield', agent: 'secrets' }, { domain: 'shield', agent: 'toxicity' }, { domain: 'shield', agent: 'credential-exposure' }] },
  { id: 'red-team', keywords: ['red team', 'red-team', 'adversarial exercise'],
    agents: [{ domain: 'test-bench', agent: 'red-team' }, { domain: 'test-bench', agent: 'adversarial' }, { domain: 'shield', agent: 'prompt-injection' }, { domain: 'shield', agent: 'safety-boundary' }] },
  { id: 'data-protection', keywords: ['protect data', 'data protect', 'anonymize and redact', 'redact pii'],
    agents: [{ domain: 'data-vault', agent: 'anonymize' }, { domain: 'shield', agent: 'pii' }, { domain: 'shield', agent: 'redaction' }, { domain: 'data-vault', agent: 'access-control' }] },
  { id: 'abuse-detection', keywords: ['detect abuse', 'misusing the api', 'abuse pattern', 'bad actor'],
    agents: [{ domain: 'shield', agent: 'abuse' }, { domain: 'observatory', agent: 'usage-patterns' }, { domain: 'sentinel', agent: 'anomaly' }, { domain: 'sentinel', agent: 'alert' }] },
  { id: 'safety-policies', keywords: ['safety polic', 'content rule', 'moderation polic', 'content safet'],
    agents: [{ domain: 'policy-engine', agent: 'enforce' }, { domain: 'policy-engine', agent: 'constraints' }, { domain: 'shield', agent: 'moderation' }, { domain: 'shield', agent: 'safety-boundary' }] },

  // === Model Evaluation ===
  { id: 'model-evaluation', keywords: ['evaluate model', 'model evaluation', 'model quality', 'benchmark model', 'eval my model', 'test my model', 'model perform', 'how good is the model'],
    agents: [{ domain: 'test-bench', agent: 'benchmark' }, { domain: 'test-bench', agent: 'quality' }, { domain: 'test-bench', agent: 'hallucination' }, { domain: 'test-bench', agent: 'faithfulness' }] },
  { id: 'full-model-eval', keywords: ['comprehensive eval', 'full eval', 'complete model test'],
    agents: [{ domain: 'test-bench', agent: 'benchmark' }, { domain: 'test-bench', agent: 'bias' }, { domain: 'test-bench', agent: 'hallucination' }, { domain: 'test-bench', agent: 'consistency' }, { domain: 'test-bench', agent: 'faithfulness' }] },
  { id: 'model-switch', keywords: ['switch model', 'model migration', 'what if we switch', 'migrate model'],
    agents: [{ domain: 'simulator', agent: 'what-if' }, { domain: 'auto-optimizer', agent: 'model-select' }, { domain: 'costops', agent: 'tradeoff' }, { domain: 'test-bench', agent: 'compare' }] },
  { id: 'drift-detection', keywords: ['detect drift', 'model degrad', 'drift in production'],
    agents: [{ domain: 'sentinel', agent: 'drift' }, { domain: 'sentinel', agent: 'anomaly' }, { domain: 'test-bench', agent: 'regression' }, { domain: 'observatory', agent: 'telemetry' }] },

  // === SRE & Operations ===
  { id: 'anomaly-investigation', keywords: ['detect anomal', 'something looks wrong', 'investigate anomal', 'unusual pattern', 'anomal detect', 'check for anomal', 'weird pattern'],
    agents: [{ domain: 'sentinel', agent: 'anomaly' }, { domain: 'sentinel', agent: 'drift' }, { domain: 'sentinel', agent: 'correlation' }, { domain: 'observatory', agent: 'telemetry' }] },
  { id: 'latency-debug', keywords: ['why is it slow', 'latency issue', 'latency problem', 'slow request', 'high latency', 'latency so high', 'too slow', 'why so slow', 'response too slow', 'latency spike'],
    agents: [{ domain: 'latency-lens', agent: 'latency' }, { domain: 'latency-lens', agent: 'cold-start' }, { domain: 'sentinel', agent: 'anomaly' }, { domain: 'sentinel', agent: 'rca' }] },
  { id: 'incident-response', keywords: ['service down', 'outage', 'incident happen', 'went down', 'service failure', 'things are broken', 'production down', 'everything is down'],
    agents: [{ domain: 'incident-manager', agent: 'escalation' }, { domain: 'incident-manager', agent: 'post-mortem' }, { domain: 'sentinel', agent: 'rca' }, { domain: 'observatory', agent: 'failures' }] },
  { id: 'observability-review', keywords: ['observability', 'system status', 'platform health', 'monitoring overview'],
    agents: [{ domain: 'observatory', agent: 'telemetry' }, { domain: 'observatory', agent: 'health-check' }, { domain: 'observatory', agent: 'slo' }, { domain: 'observatory', agent: 'visualization' }] },
  { id: 'resilience-check', keywords: ['make resilient', 'handle failure', 'failure handling', 'fault toleran'],
    agents: [{ domain: 'edge', agent: 'circuit-breaker' }, { domain: 'edge', agent: 'failover' }, { domain: 'edge', agent: 'execution-guard' }, { domain: 'orchestrator', agent: 'retry' }] },

  // === Pipeline & Integration ===
  { id: 'build-pipeline', keywords: ['build pipeline', 'create pipeline', 'orchestrate task', 'set up workflow'],
    agents: [{ domain: 'orchestrator', agent: 'workflow' }, { domain: 'orchestrator', agent: 'scheduler' }, { domain: 'orchestrator', agent: 'dependencies' }, { domain: 'orchestrator', agent: 'parallel' }] },
  { id: 'integration-setup', keywords: ['wire up webhook', 'integrate service', 'connect webhook', 'webhook pipeline'],
    agents: [{ domain: 'connector-hub', agent: 'webhook-ingest' }, { domain: 'connector-hub', agent: 'event-normalize' }, { domain: 'orchestrator', agent: 'workflow' }] },
  { id: 'enterprise-data', keywords: ['query sap', 'erp data', 'enterprise data', 'get records from'],
    agents: [{ domain: 'connector-hub', agent: 'database-query' }, { domain: 'connector-hub', agent: 'erp-surface' }, { domain: 'connector-hub', agent: 'auth-identity' }] },
  { id: 'smart-routing', keywords: ['smart routing', 'route inference optimal', 'intelligent routing'],
    agents: [{ domain: 'inference-gateway', agent: 'route' }, { domain: 'auto-optimizer', agent: 'model-select' }, { domain: 'costops', agent: 'tradeoff' }] },

  // === Simulation (MUST match before governance/compliance keywords) ===
  { id: 'scenario-simulation', keywords: ['simulate scenario', 'test scenario', 'deployment scenario', 'simulate a ', 'simulate an ', 'simulate the ', 'run simulation', 'run a simulation', 'simulation of'],
    agents: [{ domain: 'simulator', agent: 'scenario' }, { domain: 'simulator', agent: 'what-if' }, { domain: 'platform', agent: 'risk-score' }] },

  // === Executive & Governance ===
  { id: 'executive-brief', keywords: ['executive summary', 'board report', 'platform summary', 'executive overview'],
    agents: [{ domain: 'platform', agent: 'executive-summary' }, { domain: 'costops', agent: 'attribution' }, { domain: 'observatory', agent: 'slo' }, { domain: 'research-lab', agent: 'metrics' }] },
  { id: 'decision-package', keywords: ['go no-go', 'go/no-go', 'decision package', 'decision memo'],
    agents: [{ domain: 'platform', agent: 'decision' }, { domain: 'platform', agent: 'decision-memo' }, { domain: 'platform', agent: 'risk-score' }, { domain: 'costops', agent: 'roi' }] },
  { id: 'risk-assessment', keywords: ['risk assess', 'how risky', 'risk evaluat', 'risk analys'],
    agents: [{ domain: 'platform', agent: 'risk-score' }, { domain: 'governance-dashboard', agent: 'impact' }, { domain: 'simulator', agent: 'scenario' }] },
  { id: 'compliance-review', keywords: ['compliance check', 'are we compliant', 'gdpr complian', 'hipaa complian', 'governance review', 'gdpr audit', 'hipaa audit', 'compliance audit', 'compliance review', 'regulatory compliance review'],
    agents: [{ domain: 'governance-dashboard', agent: 'audit' }, { domain: 'governance-dashboard', agent: 'oversight' }, { domain: 'policy-engine', agent: 'enforce' }, { domain: 'data-vault', agent: 'access-control' }] },
  { id: 'impact-analysis', keywords: ['impact analys', 'blast radius', 'change impact'],
    agents: [{ domain: 'governance-dashboard', agent: 'impact' }, { domain: 'platform', agent: 'risk-score' }, { domain: 'simulator', agent: 'scenario' }, { domain: 'sentinel', agent: 'correlation' }] },
  { id: 'decision-audit', keywords: ['decision audit', 'trace decision', 'decision trail'],
    agents: [{ domain: 'memory-graph', agent: 'decisions' }, { domain: 'memory-graph', agent: 'lineage' }, { domain: 'governance-dashboard', agent: 'audit' }, { domain: 'memory-graph', agent: 'knowledge-graph' }] },
  { id: 'value-assessment', keywords: ['delivering value', 'ai team roi', 'are we delivering', 'value assessment'],
    agents: [{ domain: 'costops', agent: 'roi' }, { domain: 'research-lab', agent: 'metrics' }, { domain: 'observatory', agent: 'usage-patterns' }, { domain: 'platform', agent: 'executive-summary' }] },
  { id: 'recommendation-report', keywords: ['recommendation report', 'generate recommendation', 'board recommendation'],
    agents: [{ domain: 'analytics-hub', agent: 'recommendation' }, { domain: 'analytics-hub', agent: 'consensus' }, { domain: 'platform', agent: 'executive-summary' }] },

  // === Planning ===
  { id: 'task-planning', keywords: ['help me plan', 'break down this', 'plan this task', 'decompose this'],
    agents: [{ domain: 'copilot', agent: 'planner' }, { domain: 'copilot', agent: 'decomposer' }, { domain: 'copilot', agent: 'clarifier' }] },
  { id: 'version-health', keywords: ['version compat', 'is this deprecated', 'api still supported'],
    agents: [{ domain: 'forge', agent: 'version-compat' }, { domain: 'marketplace', agent: 'deprecation' }, { domain: 'registry', agent: 'index' }] },
  { id: 'agent-onboarding', keywords: ['onboard agent', 'register new agent', 'new agent setup'],
    agents: [{ domain: 'registry', agent: 'bootstrap' }, { domain: 'registry', agent: 'index' }, { domain: 'config-manager', agent: 'validate' }] },
];

// ============================================================================
// Payload Adapter: map generic { text } to domain-specific required fields
// ============================================================================

/**
 * Build a dispatch payload adapted to each agent domain's required schema.
 * Downstream agents expect different field names (e.g. copilot wants "objective",
 * simulator wants "scenario_id" + "parameters"). This function maps the user's
 * natural-language query into the correct shape.
 */
function buildDomainPayload(
  domain: string,
  agent: string,
  query: string,
  correlationId: string,
): Record<string, unknown> {
  // Some agents have strict schema validation and reject unknown properties.
  // Only include execution_ref for agents that accept it.
  const base: Record<string, unknown> = { execution_ref: correlationId };

  switch (domain) {
    case 'copilot':
      return { ...base, objective: query };

    case 'simulator':
      // Simulator agents use strict validation — no extra properties allowed.
      if (agent === 'what-if') {
        return { input: query, domain: 'enterprise' };
      }
      // scenario agent
      return {
        scenario_id: `sim-${correlationId.slice(0, 8)}`,
        parameters: { description: query },
      };

    case 'platform':
      // Platform agents use strict Zod validation — no extra properties.
      return { objective: query };

    case 'governance-dashboard': {
      // governance-dashboard/audit requires a strict Zod-validated payload with
      // request_id, organization_id, time_range, audit_scope, decision_trails, policy_snapshots.
      // Build simulation-appropriate data so the agent can produce a meaningful audit.
      const now = new Date().toISOString();
      const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
      if (agent === 'audit') {
        return {
          request_id: correlationId,
          organization_id: 'org-simulation',
          time_range: { start: thirtyDaysAgo, end: now },
          audit_scope: {
            categories: ['policy_compliance', 'cost_governance', 'model_usage'],
            include_compliance: true,
            include_policy_coverage: true,
          },
          decision_trails: [{
            decision_event_id: correlationId,
            agent_id: 'policy-enforcement-agent',
            decision_type: 'policy_enforcement_decision',
            organization_id: 'org-simulation',
            timestamp: now,
            approval_status: 'not_required' as const,
            compliance_status: 'compliant' as const,
          }],
          policy_snapshots: [{
            policy_id: 'policy-default',
            policy_name: 'Default Governance Policy',
            is_active: true,
            rule_count: 3,
            scope: 'organization' as const,
            last_modified: now,
            categories: ['policy_compliance', 'cost_governance'] as string[],
          }],
          query,
        };
      }
      // governance-dashboard/impact requires structured Zod-validated payload:
      // organization_id, change_request (object), scope (object not string).
      if (agent === 'impact') {
        return {
          organization_id: 'org-simulation',
          change_request: {
            change_id: correlationId,
            change_type: 'configure' as const,
            subject_type: 'configuration' as const,
            subject_id: 'config-simulation',
            description: query,
            timestamp: now,
            initiator: 'agentics-cli',
          },
          scope: {
            analysis_depth: 3,
            include_cost_impact: true,
            include_compliance_impact: true,
          },
          include_downstream: true,
          include_risk_projection: true,
          query,
        };
      }
      // oversight agents accept simpler payloads
      return { text: query, scope: 'full' };
    }

    case 'policy-engine': {
      // Each policy-engine agent has different input requirements.
      // enforce/constraints: need context with LLM, user, project metadata
      // approval: needs action_context + requester objects
      if (agent === 'approval') {
        // Approval handler validates action_context and requester as required objects.
        return {
          action_context: {
            action_type: 'model_access',
            resource_id: 'claude-sonnet-4-20250514',
            resource_type: 'model',
            operation: 'execute',
            details: {
              tier: 'premium',
              estimated_tokens: 4096,
              use_case: query,
            },
          },
          requester: {
            id: 'cli-user',
            email: 'developer@org-simulation.dev',
            roles: ['developer', 'ai-user'],
            department: 'engineering',
            manager_id: 'mgr-001',
            cost_center: 'cc-engineering-ai',
          },
          priority: 'normal' as const,
          trace: true,
        };
      }
      // enforce and constraints handlers validate req.body.context as required.
      // Provide rich context with fields that match synthetic policy rule conditions
      // (llm.provider, llm.model, llm.maxTokens, user.roles, project.environment)
      // so the policy engine evaluates rules and produces meaningful decisions.
      return {
        execution_ref: correlationId,
        text: query,
        scope: 'full',
        agent,
        context: {
          llm: {
            provider: 'anthropic',
            model: 'claude-sonnet-4-20250514',
            prompt: query,
            max_tokens: 4096,
            temperature: 0.7,
          },
          user: {
            id: 'cli-user',
            email: 'developer@org-simulation.dev',
            roles: ['developer', 'ai-user'],
            permissions: ['model:read', 'model:execute'],
          },
          team: {
            id: 'team-engineering',
            name: 'Engineering',
            tier: 'standard',
          },
          project: {
            id: 'proj-demo',
            name: 'AI Operations Demo',
            environment: 'production',
          },
          request: {
            id: correlationId,
            timestamp: Date.now(),
            type: 'policy-evaluation',
          },
        },
        trace: true,
      };
    }

    case 'costops': {
      // CostOps agents require structured cost data — build synthetic payloads
      // with realistic non-zero values so agents produce meaningful output.
      const costNow = new Date().toISOString();
      const dayMs = 24 * 60 * 60 * 1000;

      if (agent === 'attribution') {
        return {
          requestId: correlationId,
          timestamp: costNow,
          usage: {
            provider: 'anthropic',
            model: 'claude-sonnet-4-20250514',
            inputTokens: 1547,
            outputTokens: 423,
            cachedTokens: 312,
            latencyMs: 1850,
          },
          dimensions: {
            organizationId: 'org-simulation',
            projectId: 'proj-demo',
            environment: 'staging',
            userId: 'cli-user',
          },
          pricingContext: {
            tier: 'standard',
            currency: 'USD',
          },
          query,
        };
      }

      if (agent === 'forecast') {
        // 14 data points (well above minimum 7) with realistic ascending cost curve
        const forecastData = Array.from({ length: 14 }, (_, i) => {
          const baseCost = 42 + i * 2.7 + (Math.sin(i * 0.8) * 4);
          const baseTokens = 28000 + i * 1800 + (i % 3) * 500;
          return {
            timestamp: new Date(Date.now() - (14 - i) * dayMs).toISOString(),
            total_cost: Math.round(baseCost * 100) / 100,
            total_tokens: Math.round(baseTokens),
            request_count: 150 + i * 11 + (i % 4) * 8,
            by_provider: { anthropic: Math.round(baseCost * 0.7 * 100) / 100, openai: Math.round(baseCost * 0.3 * 100) / 100 },
            by_model: { 'claude-sonnet-4-20250514': Math.round(baseCost * 0.55 * 100) / 100, 'claude-haiku-4-5-20251001': Math.round(baseCost * 0.15 * 100) / 100, 'gpt-4o': Math.round(baseCost * 0.3 * 100) / 100 },
          };
        });
        return {
          historical_data: forecastData,
          forecast_horizon_days: 30,
          granularity: 'daily' as const,
          confidence_level: 0.95,
          constraints: {
            budget_cap: 3000,
            max_growth_rate: 25,
          },
          metadata: {
            organization_id: 'org-simulation',
            project_id: 'proj-demo',
            execution_ref: correlationId,
            source: 'agentics-cli',
          },
          query,
        };
      }

      if (agent === 'roi') {
        const roiStart = new Date(Date.now() - 240 * dayMs).toISOString();
        // Generate 40 cost records to meet data quality volume threshold
        // (score = (cost+outcome)/250, need >= 75 total for score >= 0.3)
        const costModels = [
          { provider: 'Anthropic' as const, model: 'claude-sonnet-4-20250514', promptBase: 2100, compBase: 580 },
          { provider: 'Anthropic' as const, model: 'claude-haiku-4-5-20251001', promptBase: 4200, compBase: 1100 },
          { provider: 'OpenAI' as const, model: 'gpt-4o', promptBase: 1800, compBase: 450 },
        ];
        const costRecords = Array.from({ length: 40 }, (_, i) => {
          const cm = costModels[i % costModels.length]!;
          const promptTokens = cm.promptBase + i * 50 + (i % 5) * 120;
          const completionTokens = cm.compBase + i * 15 + (i % 3) * 40;
          const costAmount = (35 + i * 4.2 + Math.sin(i * 0.5) * 8).toFixed(2);
          return {
            id: crypto.randomUUID(),
            timestamp: new Date(Date.now() - (240 - i * 6) * dayMs).toISOString(),
            provider: cm.provider,
            model: cm.model,
            organization_id: 'org-simulation',
            project_id: 'proj-demo',
            prompt_tokens: promptTokens,
            completion_tokens: completionTokens,
            total_tokens: promptTokens + completionTokens,
            cost_amount: costAmount,
            currency: 'USD' as const,
            latency_ms: 900 + i * 25 + (i % 4) * 50,
          };
        });
        // Generate 40 outcome metrics across diverse types
        const metricTypes = [
          { type: 'revenue_impact' as const, name: 'ai_revenue_uplift', baseVal: 2800, unit: 'USD' },
          { type: 'cost_savings' as const, name: 'manual_process_savings', baseVal: 680, unit: 'USD' },
          { type: 'productivity_gain' as const, name: 'developer_velocity', baseVal: 22, unit: 'percent' },
          { type: 'task_completion' as const, name: 'tasks_automated', baseVal: 150, unit: 'count' },
          { type: 'quality_score' as const, name: 'response_accuracy', baseVal: 0.88, unit: 'ratio' },
          { type: 'throughput' as const, name: 'requests_processed', baseVal: 3200, unit: 'count' },
          { type: 'success_rate' as const, name: 'successful_completions', baseVal: 0.94, unit: 'ratio' },
          { type: 'user_satisfaction' as const, name: 'csat_score', baseVal: 4.1, unit: 'score' },
        ];
        const outcomeMetrics = Array.from({ length: 40 }, (_, i) => {
          const mt = metricTypes[i % metricTypes.length]!;
          // Add slight growth trend so correlations emerge
          const growthFactor = 1 + i * 0.008;
          return {
            id: crypto.randomUUID(),
            timestamp: new Date(Date.now() - (240 - i * 6) * dayMs).toISOString(),
            metric_type: mt.type,
            metric_name: mt.name,
            value: Math.round(mt.baseVal * growthFactor * 100) / 100,
            unit: mt.unit,
            organization_id: 'org-simulation',
            project_id: 'proj-demo',
            correlation_window_hours: 168,
          };
        });
        return {
          analysis_scope: 'organization' as const,
          period_start: roiStart,
          period_end: costNow,
          request_id: correlationId,
          cost_records: costRecords,
          outcome_metrics: outcomeMetrics,
          business_value_per_unit: '45.00',
          baseline_cost: '500.00',
          baseline_outcome: 100,
          roi_calculation_method: 'simple' as const,
          correlation_method: 'pearson' as const,
          min_correlation_threshold: 0.3,
          query,
        };
      }

      if (agent === 'budget') {
        const qStart = new Date(Date.now() - 60 * dayMs).toISOString();
        const qEnd = new Date(Date.now() + 30 * dayMs).toISOString();
        // 7 days of daily spend history
        const dailySpend = Array.from({ length: 7 }, (_, i) => ({
          date: new Date(Date.now() - (7 - i) * dayMs).toISOString(),
          spend: 2100 + i * 180 + (i % 3) * 250,
        }));
        return {
          request_id: correlationId,
          timestamp: costNow,
          budget: {
            budget_id: `budget-${correlationId.slice(0, 8)}`,
            name: 'Q1 AI Operations',
            limit: 250000,
            currency: 'USD',
            period_start: qStart,
            period_end: qEnd,
            warning_threshold: 0.8,
            critical_threshold: 0.95,
            gating_threshold: 1.0,
            is_soft_limit: true,
            enable_forecasting: true,
            scope: {
              type: 'tenant' as const,
              tenant_id: 'org-simulation',
              project_id: 'proj-demo',
            },
          },
          spend_data: {
            current_spend: 67432.50,
            currency: 'USD',
            data_completeness: 0.94,
            data_as_of: costNow,
            daily_spend_history: dailySpend,
          },
          include_forecast: true,
          query,
        };
      }

      if (agent === 'tradeoff') {
        // 3 performance records with full nested cost/latency/quality objects
        const tradeoffRecords = [
          {
            id: crypto.randomUUID(),
            timestamp: costNow,
            provider: 'Anthropic' as const,
            model: 'claude-sonnet-4-20250514',
            model_tier: 'premium' as const,
            cost: { cost_per_request_usd: 0.0234, cost_per_1k_tokens_usd: 0.012, total_cost_usd: 342.18, token_count: 28515 },
            latency: { p50_ms: 980, p95_ms: 1650, p99_ms: 2340, avg_ms: 1120, min_ms: 420, max_ms: 3100 },
            quality: { accuracy: 0.94, relevance: 0.91, coherence: 0.96, helpfulness: 0.93, composite_score: 0.935 },
            tenant_id: 'org-simulation',
          },
          {
            id: crypto.randomUUID(),
            timestamp: costNow,
            provider: 'Anthropic' as const,
            model: 'claude-haiku-4-5-20251001',
            model_tier: 'economy' as const,
            cost: { cost_per_request_usd: 0.0041, cost_per_1k_tokens_usd: 0.002, total_cost_usd: 58.92, token_count: 29460 },
            latency: { p50_ms: 310, p95_ms: 580, p99_ms: 890, avg_ms: 370, min_ms: 140, max_ms: 1200 },
            quality: { accuracy: 0.82, relevance: 0.84, coherence: 0.88, helpfulness: 0.80, composite_score: 0.835 },
            tenant_id: 'org-simulation',
          },
          {
            id: crypto.randomUUID(),
            timestamp: costNow,
            provider: 'OpenAI' as const,
            model: 'gpt-4o',
            model_tier: 'premium' as const,
            cost: { cost_per_request_usd: 0.0198, cost_per_1k_tokens_usd: 0.010, total_cost_usd: 287.45, token_count: 28745 },
            latency: { p50_ms: 850, p95_ms: 1420, p99_ms: 2100, avg_ms: 980, min_ms: 380, max_ms: 2800 },
            quality: { accuracy: 0.91, relevance: 0.89, coherence: 0.93, helpfulness: 0.90, composite_score: 0.908 },
            tenant_id: 'org-simulation',
          },
        ];
        return {
          records: tradeoffRecords,
          analysis_scope: 'model' as const,
          weights: { cost: 0.33, latency: 0.33, quality: 0.34 },
          constraints: {
            max_cost_per_request_usd: 0.05,
            max_latency_p95_ms: 3000,
            min_quality_score: 0.75,
          },
          options: {
            include_diminishing_returns: true,
            include_pareto_frontier: true,
            include_recommendations: true,
            normalize_metrics: true,
          },
          query,
        };
      }

      return { ...base, text: query };
    }

    case 'data-vault':
      if (agent === 'access-control') {
        return {
          request_id: correlationId,
          subject: { type: 'user', id: 'cli-user' },
          resource: { type: 'query', id: correlationId },
          permission: 'read' as const,
          context: { source: 'cli', query },
        };
      }
      return { ...base, text: query };

    case 'sentinel': {
      // Sentinel agents expect { payload: {...}, context: {} } with agent-specific data.
      // Provide realistic synthetic telemetry so agents produce meaningful analysis.
      const sentinelNow = new Date().toISOString();

      if (agent === 'drift') {
        // Needs >= 10 samples in both reference_data and current_data
        // Simulate slight latency drift: reference ~100ms, current ~105ms
        return {
          payload: {
            reference_data: [98, 102, 99, 101, 100, 103, 97, 104, 100, 99, 101, 98, 102, 100, 103],
            current_data: [104, 108, 103, 107, 106, 110, 105, 112, 107, 104, 109, 106, 111, 105, 108],
            metric: 'response_latency_ms',
            service: 'inference-gateway',
          },
          context: {},
        };
      }

      if (agent === 'anomaly') {
        return {
          payload: {
            telemetry: {
              cpu_usage: 72.3,
              memory_usage: 68.1,
              request_rate: 1250,
              error_rate: 0.023,
              p99_latency_ms: 890,
              active_connections: 342,
              gpu_utilization: 84.7,
              queue_depth: 18,
            },
          },
          context: {},
        };
      }

      if (agent === 'correlation') {
        // Needs non-empty signals array
        return {
          payload: {
            signals: [
              {
                type: 'latency_spike',
                severity: 'warning',
                timestamp: sentinelNow,
                source: 'inference-gateway',
                metric: 'p99_latency_ms',
                metric_value: 890,
                threshold: 500,
              },
              {
                type: 'error_rate_increase',
                severity: 'info',
                timestamp: sentinelNow,
                source: 'inference-gateway',
                metric: 'error_rate',
                metric_value: 0.023,
                threshold: 0.01,
              },
              {
                type: 'cpu_spike',
                severity: 'warning',
                timestamp: sentinelNow,
                source: 'compute-cluster',
                metric: 'cpu_usage',
                metric_value: 72.3,
                threshold: 70,
              },
            ],
            time_window_secs: 600,
          },
          context: {},
        };
      }

      if (agent === 'alert') {
        return {
          payload: {
            anomaly: {
              type: 'latency_spike',
              severity: 'warning',
              metric: 'p99_latency_ms',
              current_value: 890,
              threshold: 500,
              service: 'inference-gateway',
              timestamp: sentinelNow,
              duration_seconds: 320,
            },
            source: 'sentinel-anomaly',
          },
          context: {},
        };
      }

      if (agent === 'rca') {
        return {
          payload: {
            incident: {
              id: `inc-${correlationId.slice(0, 8)}`,
              title: 'Elevated P99 Latency on Inference Gateway',
              severity: 'warning',
              service: 'inference-gateway',
              start_time: new Date(Date.now() - 20 * 60 * 1000).toISOString(),
              symptoms: [
                'P99 latency increased from 500ms to 890ms',
                'CPU usage elevated to 72.3%',
                'Error rate slightly above threshold at 2.3%',
              ],
              affected_metrics: [
                { metric: 'p99_latency_ms', before: 500, after: 890 },
                { metric: 'cpu_usage', before: 55, after: 72.3 },
                { metric: 'error_rate', before: 0.008, after: 0.023 },
              ],
            },
            max_hypotheses: 5,
          },
          context: {},
        };
      }

      // Default sentinel payload
      return { payload: { text: query }, context: {} };
    }

    default:
      // Most agents accept { text } + extra fields
      return { ...base, text: query };
  }
}

/**
 * Classify a query against multi-agent combos.
 * Returns an array of intents if a combo matches, or null.
 */
function classifyMultiAgent(query: string): IntentClassification[] | null {
  // Use semantic intent classifier instead of brittle .includes() matching
  const result = semanticClassifyMultiIntent(query, MULTI_AGENT_COMBOS);

  if (!result) return null;

  // Verify all agents exist in registry
  const validAgents = result.agents.filter(({ domain, agent }) => {
    const dc = AGENT_DOMAINS[domain];
    return dc && dc.agents.includes(agent);
  });

  if (validAgents.length < 2) return null;

  return validAgents.map(({ domain, agent }) => ({
    domain,
    agent,
    confidence: result.confidence,
    suggested_payload: {},
    reasoning: result.reasoning,
  }));
}

/**
 * Classify a query using semantic intent scoring against the static rule table.
 * Uses multi-signal scoring (token overlap, stem matching, concept clusters)
 * instead of brittle .includes() substring matching.
 */
function classifyByKeywords(query: string): IntentClassification | null {
  const result = semanticClassifyIntent(query, KEYWORD_RULES);

  if (!result) return null;

  // Verify domain/agent exist in registry
  const domainConfig = AGENT_DOMAINS[result.domain];
  if (!domainConfig || !domainConfig.agents.includes(result.agent)) {
    return null;
  }

  return {
    domain: result.domain,
    agent: result.agent,
    confidence: result.confidence,
    suggested_payload: {},
    reasoning: result.reasoning,
  };
}

// ============================================================================
// Natural Language Routing (LLM with keyword fallback)
// ============================================================================

export async function executeNaturalLanguageRoute(
  query: string,
  options: CommandOptions,
): Promise<RouteResult> {
  const start = Date.now();
  const correlationId = options.trace_id ?? crypto.randomUUID();

  // Priority 0: Enterprise simulation → ruvector pipeline + platform analysis agents
  // Enterprise simulations go through agentics-simulation-engine → ruvector-service.
  // Platform agents (risk-score, executive-summary, decision-memo) run in parallel
  // to provide analysis on top of the simulation.
  //
  // Uses semantic intent classifier (not brittle keyword matching) to detect
  // enterprise simulation intent from natural language queries.
  {
    const simDetection = detectEnterpriseSimulation(query);
    if (simDetection.detected) {
      console.error(`Enterprise simulation detected — ${simDetection.reasoning} (${(simDetection.confidence * 100).toFixed(0)}% confidence)`);

      // Dispatch enterprise simulation AND platform analysis agents in parallel
      const platformAgents = [
        { domain: 'platform', agent: 'risk-score' },
        { domain: 'platform', agent: 'executive-summary' },
        { domain: 'platform', agent: 'decision-memo' },
      ];

      const simPromise = executeSimulateCommand(
        { planRef: { type: 'natural-language' as const, description: query } },
        { ...options, trace_id: correlationId },
      ).then(result => ({ kind: 'simulation' as const, status: 200, response: result }))
       .catch(err => ({ kind: 'simulation' as const, status: 502, response: { error: err instanceof Error ? err.message : String(err) } }));

      const platformPromises = platformAgents.map(async ({ domain, agent }) => {
        try {
          const domainConfig = AGENT_DOMAINS[domain];
          if (!domainConfig) return { kind: 'agent' as const, domain, agent, status: 404, response: { error: `Unknown domain: ${domain}` } };
          const agentConfig = loadEndpointConfig(domainConfig.serviceName);
          const agentAdapter = createAdapter(domainConfig.serviceName, agentConfig, correlationId);
          const agentPayload = buildDomainPayload(domain, agent, query, correlationId);
          // Inject execution context headers for domains that require them
          const agentHeaders: Record<string, string> = {};
          if (domain === 'governance-dashboard') {
            agentHeaders['x-execution-id'] = correlationId;
            agentHeaders['x-parent-span-id'] = correlationId;
          }
          const resp = await agentAdapter.invoke({
            endpoint: `/v1/${domain}/${agent}`,
            method: 'POST',
            headers: agentHeaders,
            body: agentPayload,
          });
          return { kind: 'agent' as const, domain, agent, status: resp.status, response: resp.body };
        } catch (err) {
          return { kind: 'agent' as const, domain, agent, status: 502, response: { error: err instanceof Error ? err.message : String(err) } };
        }
      });

      const allResults = await Promise.allSettled([simPromise, ...platformPromises]);
      const elapsed = Date.now() - start;

      // Build multi-result response matching MultiAgentRouteResult shape
      const intents: IntentClassification[] = [];
      const invocations: Array<{ intent: IntentClassification; result: AgentsInvokeResult | { error: string } }> = [];

      for (const settled of allResults) {
        if (settled.status === 'fulfilled') {
          const val = settled.value;
          const domain = val.kind === 'simulation' ? 'simulator' : val.domain;
          const agent = val.kind === 'simulation' ? 'enterprise' : val.agent;
          const intent: IntentClassification = {
            domain,
            agent,
            confidence: 1.0,
            suggested_payload: {},
            reasoning: val.kind === 'simulation' ? 'Enterprise simulation via ruvector pipeline' : `Platform analysis: ${agent}`,
          };
          intents.push(intent);
          if (val.status >= 200 && val.status < 300) {
            invocations.push({ intent, result: { domain, agent, status: val.status, response: val.response, timing: elapsed } });
          } else {
            const errMsg = val.response && typeof val.response === 'object' && 'error' in val.response
              ? String((val.response as Record<string, unknown>).error)
              : `HTTP ${val.status}`;
            invocations.push({ intent, result: { error: errMsg } });
          }
        }
      }

      // Non-fatal: generate simulation artifacts to ~/.agentics/runs/<id>/
      try {
        const { generateSimulationArtifacts } = await import('../synthesis/simulation-artifact-generator.js');
        const simResult = allResults[0]?.status === 'fulfilled' ? allResults[0].value : undefined;
        const platformResults = allResults.slice(1)
          .filter((r): r is PromiseFulfilledResult<{ kind: 'agent'; domain: string; agent: string; status: number; response: unknown }> => r.status === 'fulfilled')
          .map(r => r.value);
        const artifacts = await generateSimulationArtifacts({
          executionId: correlationId,
          query,
          simulationResult: simResult?.response,
          platformAnalysis: platformResults.map(p => ({ domain: p.domain, agent: p.agent, status: p.status, response: p.response })),
          correlationId,
          timing: elapsed,
        });
        console.error(`Simulation artifacts: ${artifacts.runDir}`);
      } catch { /* non-fatal — artifact generation should never block the response */ }

      return {
        kind: 'multi' as const,
        result: {
          query,
          intents,
          invocations,
          timing: elapsed,
        },
      };
    }
  }

  // Priority 1: Try multi-agent combo keywords (complex queries → 2-5 agents in parallel)
  {
    const multiIntents = classifyMultiAgent(query);
    if (multiIntents) {
      // Multi-agent combo matched — dispatch all agents in parallel
      const agentLabels = multiIntents.map(i => `${i.domain}/${i.agent}`).join(', ');
      console.error(`Multi-agent routing: ${agentLabels}`);

      const dispatchPromises = multiIntents.map(async (intent) => {
        const payload: Record<string, unknown> = {
          ...buildDomainPayload(intent.domain, intent.agent, query, correlationId),
          ...intent.suggested_payload,
        };
        try {
          const result = await executeAgentsInvokeCommand(
            intent.domain,
            intent.agent,
            payload,
            options,
          );
          return { intent, result: result as AgentsInvokeResult | { error: string } };
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          return { intent, result: { error: errMsg } };
        }
      });

      const invocations = await Promise.allSettled(dispatchPromises);
      const results: Array<{ intent: IntentClassification; result: AgentsInvokeResult | { error: string } }> = invocations.map((settled, idx) => {
        if (settled.status === 'fulfilled') {
          return settled.value;
        }
        // Shouldn't happen since we catch inside, but handle anyway
        return {
          intent: multiIntents[idx]!,
          result: { error: settled.reason instanceof Error ? settled.reason.message : String(settled.reason) },
        };
      });

      return {
        kind: 'multi',
        result: {
          query,
          intents: multiIntents,
          invocations: results,
          timing: Date.now() - start,
        },
      };
    }

  }

  // Priority 2: Try LLM-based classification (if API key available)
  let singleIntent: IntentClassification | null = null;
  const anthropicKey = await getAnthropicApiKey();

  if (anthropicKey) {
    singleIntent = await tryLlmClassification(query, anthropicKey, correlationId);
  }

  // Priority 3: Fall back to single-agent keyword classification
  if (!singleIntent) {
    singleIntent = classifyByKeywords(query);
    if (singleIntent) {
      console.error(`Routing to ${singleIntent.domain}/${singleIntent.agent} (keyword match)`);
    }
  }

  // If no method matched, throw a helpful error
  if (!singleIntent) {
    throw new Error(
      `Could not determine intent from: "${query}"\n` +
      `\n` +
      `  No matching agent domain found. Try being more specific, or use explicit invocation:\n` +
      `    agentics agents invoke <domain> <agent> '<json-payload>'\n` +
      `    agentics agents list   # show available domains and agents`
    );
  }

  // Build dispatch payload adapted to the target domain's schema
  const dispatchPayload: Record<string, unknown> = {
    ...buildDomainPayload(singleIntent.domain, singleIntent.agent, query, correlationId),
    ...singleIntent.suggested_payload,
  };

  // Dispatch to the target agent
  let invocation: AgentsInvokeResult;
  try {
    invocation = await executeAgentsInvokeCommand(
      singleIntent.domain,
      singleIntent.agent,
      dispatchPayload,
      options,
    );
  } catch (dispatchError) {
    const errStr = dispatchError instanceof Error ? dispatchError.message : String(dispatchError);
    const fieldBefore = errStr.match(/(\w+)\s+is required/i);
    const fieldAfter = errStr.match(/missing required field\W*'?(\w+)/i);
    const fieldName = fieldBefore?.[1] || fieldAfter?.[1];

    if (fieldName) {
      throw new Error(
        `Routed to ${singleIntent.domain}/${singleIntent.agent} (${(singleIntent.confidence * 100).toFixed(0)}% confidence)\n` +
        (singleIntent.reasoning ? `  Reason: ${singleIntent.reasoning}\n` : '') +
        `\n` +
        `  This agent requires structured input that cannot be inferred\n` +
        `  from a natural language query.\n` +
        `  Missing field: ${fieldName}\n` +
        `\n` +
        `  Use explicit invocation with the required payload:\n` +
        `    agentics agents invoke ${singleIntent.domain} ${singleIntent.agent} '{"execution_ref":"...","${fieldName}":"..."}'`
      );
    }
    throw dispatchError;
  }

  return {
    kind: 'single',
    result: {
      intent: singleIntent,
      invocation,
      timing: Date.now() - start,
    },
  };
}

/**
 * Attempt LLM-based classification via the copilot/intent agent.
 * Returns null (instead of throwing) if classification fails for any reason.
 */
async function tryLlmClassification(
  query: string,
  anthropicKey: string,
  correlationId: string,
): Promise<IntentClassification | null> {
  try {
    const availableDomains: Record<string, { agents: string[]; phase: string }> = {};
    for (const [name, domain] of Object.entries(AGENT_DOMAINS)) {
      availableDomains[name] = {
        agents: domain.agents,
        phase: domain.phase,
      };
    }

    const config = loadEndpointConfig('copilot-agents');
    const adapter = createAdapter('copilot-agents', config, correlationId);

    const intentResponse = await adapter.invoke({
      endpoint: '/v1/copilot/intent',
      method: 'POST',
      headers: {
        'X-Anthropic-Api-Key': anthropicKey,
      },
      body: {
        text: query,
        agent: 'intent',
        payload: {
          query,
          available_domains: availableDomains,
        },
        context: {
          trace_id: correlationId,
          source: 'cli-nl-routing',
        },
      },
    });

    const responseBody = intentResponse.body as Record<string, unknown>;
    const resultBody = (responseBody.result ?? responseBody) as Record<string, unknown>;

    const intent: IntentClassification = {
      domain: (resultBody.domain as string) ?? '',
      agent: (resultBody.agent as string) ?? '',
      confidence: (resultBody.confidence as number) ?? 0,
      suggested_payload: (resultBody.suggested_payload as Record<string, unknown>) ?? {},
      reasoning: resultBody.reasoning as string | undefined,
      alternatives: resultBody.alternatives as IntentClassification['alternatives'],
    };

    // Validate classification quality
    if (intent.confidence < NL_MINIMUM_CONFIDENCE || !intent.domain || !intent.agent) {
      return null; // Low confidence — let keyword fallback try
    }

    // Validate domain/agent exist in registry
    const domainConfig = AGENT_DOMAINS[intent.domain];
    if (!domainConfig || !domainConfig.agents.includes(intent.agent)) {
      return null; // Invalid domain/agent — let keyword fallback try
    }

    // Log classification
    const pct = (intent.confidence * 100).toFixed(0);
    console.error(`Routing to ${intent.domain}/${intent.agent} (${pct}% confidence)`);
    if (intent.reasoning) {
      console.error(`  Reason: ${intent.reasoning}`);
    }

    if (intent.confidence < NL_LOW_CONFIDENCE) {
      console.error(
        `  Warning: Low confidence match. If incorrect, try:\n` +
        `    agentics agents invoke ${intent.domain} ${intent.agent} '<payload>'`
      );
      if (intent.alternatives && intent.alternatives.length > 0) {
        console.error(`  Other candidates:`);
        for (const alt of intent.alternatives.slice(0, 3)) {
          console.error(`    - ${alt.domain}/${alt.agent} (${(alt.confidence * 100).toFixed(0)}%)`);
        }
      }
    }

    return intent;
  } catch {
    // LLM classification failed — silently fall back to keyword routing
    return null;
  }
}

export function formatNaturalLanguageRouteForDisplay(result: NaturalLanguageRouteResult): string {
  const lines: string[] = [];
  lines.push(`Query routed to: ${result.intent.domain}/${result.intent.agent}`);
  lines.push(`Confidence: ${(result.intent.confidence * 100).toFixed(0)}%`);
  if (result.intent.reasoning) {
    lines.push(`Reasoning: ${result.intent.reasoning}`);
  }
  lines.push(`Agent Status: ${result.invocation.status}`);
  lines.push(`Total Timing: ${result.timing}ms`);
  lines.push('');
  lines.push(JSON.stringify(result.invocation.response, null, 2));
  return lines.join('\n');
}

export function formatMultiAgentRouteForDisplay(result: MultiAgentRouteResult): string {
  const lines: string[] = [];
  const agentCount = result.invocations.length;
  const succeeded = result.invocations.filter(i => !('error' in i.result)).length;
  const failed = agentCount - succeeded;

  lines.push(`Multi-agent query: "${result.query}"`);
  lines.push(`Agents invoked: ${agentCount} (${succeeded} succeeded${failed > 0 ? `, ${failed} failed` : ''})`);
  lines.push(`Total Timing: ${result.timing}ms`);
  lines.push('');

  for (const inv of result.invocations) {
    const label = `[${inv.intent.domain}/${inv.intent.agent}]`;
    if ('error' in inv.result) {
      lines.push(`${label} ERROR: ${inv.result.error}`);
    } else {
      const agentResult = inv.result as AgentsInvokeResult;
      lines.push(`${label} Status: ${agentResult.status} (${agentResult.timing}ms)`);
      lines.push(JSON.stringify(agentResult.response, null, 2));
    }
    lines.push('');
  }

  return lines.join('\n');
}

export function formatRouteResultForDisplay(routeResult: RouteResult): string {
  if (routeResult.kind === 'multi') {
    return formatMultiAgentRouteForDisplay(routeResult.result);
  }
  return formatNaturalLanguageRouteForDisplay(routeResult.result);
}

export function routeResultToJson(routeResult: RouteResult, query: string): unknown {
  if (routeResult.kind === 'multi') {
    return {
      kind: 'multi',
      query: routeResult.result.query,
      agents: routeResult.result.invocations.map(i => ({
        domain: i.intent.domain,
        agent: i.intent.agent,
        confidence: i.intent.confidence,
        reasoning: i.intent.reasoning,
        result: 'error' in i.result ? { error: i.result.error } : i.result,
      })),
      timing: routeResult.result.timing,
    };
  }
  return {
    kind: 'single',
    query,
    intent: routeResult.result.intent,
    result: routeResult.result.invocation,
    timing: routeResult.result.timing,
  };
}
