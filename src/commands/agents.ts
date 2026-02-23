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

  const config = loadEndpointConfig(domainConfig.serviceName);
  const correlationId = options.trace_id ?? crypto.randomUUID();
  const adapter = createAdapter(domainConfig.serviceName, config, correlationId);

  const response = await adapter.invoke({
    endpoint: `/v1/${domain}/${agent}`,
    method: 'POST',
    headers: {},
    body: payload,
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
  // auto-optimizer
  { domain: 'auto-optimizer', agent: 'token', keywords: ['token optim', 'optimize token', 'token usage', 'reduce token', 'token cost', 'token waste', 'token efficien', 'token budget'] },
  { domain: 'auto-optimizer', agent: 'model-select', keywords: ['select model', 'model select', 'choose model', 'best model', 'which model', 'model recommend', 'model comparison'] },
  { domain: 'auto-optimizer', agent: 'self-optimize', keywords: ['self optim', 'auto optim', 'optimize system', 'optimize performance', 'optimize cost', 'reduce cost', 'cost optim', 'optimize spend'] },
  // shield
  { domain: 'shield', agent: 'prompt-injection', keywords: ['injection', 'prompt attack', 'jailbreak', 'prompt inject'] },
  { domain: 'shield', agent: 'pii', keywords: ['pii', 'personal info', 'personally identifiable'] },
  { domain: 'shield', agent: 'secrets', keywords: ['secret', 'credential', 'api key', 'password leak'] },
  { domain: 'shield', agent: 'toxicity', keywords: ['toxic', 'toxicity', 'harmful', 'offensive'] },
  { domain: 'shield', agent: 'moderation', keywords: ['moderat', 'content filter', 'content polic'] },
  { domain: 'shield', agent: 'abuse', keywords: ['abuse', 'misuse'] },
  { domain: 'shield', agent: 'redaction', keywords: ['redact', 'mask data', 'scrub data'] },
  // test-bench
  { domain: 'test-bench', agent: 'red-team', keywords: ['red team', 'red-team', 'adversarial test'] },
  { domain: 'test-bench', agent: 'benchmark', keywords: ['benchmark', 'bench mark', 'eval score'] },
  { domain: 'test-bench', agent: 'hallucination', keywords: ['hallucin', 'fabricat', 'grounding'] },
  { domain: 'test-bench', agent: 'quality', keywords: ['quality test', 'test quality', 'quality eval'] },
  { domain: 'test-bench', agent: 'bias', keywords: ['bias', 'fairness'] },
  // costops
  { domain: 'costops', agent: 'attribution', keywords: ['cost attribut', 'cost breakdown', 'spending breakdown', 'how much am i spend', 'cost per', 'spend by'] },
  { domain: 'costops', agent: 'forecast', keywords: ['cost forecast', 'spending forecast', 'predict cost', 'future cost', 'budget forecast'] },
  { domain: 'costops', agent: 'budget', keywords: ['budget', 'spending limit'] },
  { domain: 'costops', agent: 'roi', keywords: ['roi', 'return on invest', 'cost benefit'] },
  // observatory
  { domain: 'observatory', agent: 'telemetry', keywords: ['telemetry', 'metrics collect'] },
  { domain: 'observatory', agent: 'usage-patterns', keywords: ['usage pattern', 'usage trend', 'usage analys'] },
  { domain: 'observatory', agent: 'failures', keywords: ['failure analys', 'error rate', 'failure rate'] },
  { domain: 'observatory', agent: 'health-check', keywords: ['health check', 'service health', 'system health'] },
  { domain: 'observatory', agent: 'slo', keywords: ['slo', 'sli', 'service level'] },
  // sentinel
  { domain: 'sentinel', agent: 'anomaly', keywords: ['anomal', 'outlier', 'unusual'] },
  { domain: 'sentinel', agent: 'drift', keywords: ['drift', 'distribution shift', 'model drift'] },
  { domain: 'sentinel', agent: 'rca', keywords: ['root cause', 'rca', 'why did'] },
  { domain: 'sentinel', agent: 'alert', keywords: ['alert', 'notify', 'alarm'] },
  // memory-graph
  { domain: 'memory-graph', agent: 'lineage', keywords: ['lineage', 'decision history', 'decision trail'] },
  { domain: 'memory-graph', agent: 'conversation', keywords: ['conversation history', 'chat history', 'previous conversation'] },
  { domain: 'memory-graph', agent: 'knowledge-graph', keywords: ['knowledge graph', 'entity relation'] },
  // latency-lens
  { domain: 'latency-lens', agent: 'latency', keywords: ['latency', 'response time', 'slow response'] },
  { domain: 'latency-lens', agent: 'cold-start', keywords: ['cold start', 'cold-start', 'startup time', 'warm up'] },
  // orchestrator
  { domain: 'orchestrator', agent: 'workflow', keywords: ['workflow', 'pipeline', 'orchestrat'] },
  { domain: 'orchestrator', agent: 'scheduler', keywords: ['schedule', 'cron', 'recurring'] },
  // incident-manager
  { domain: 'incident-manager', agent: 'escalation', keywords: ['escalat', 'page on-call', 'incident'] },
  { domain: 'incident-manager', agent: 'post-mortem', keywords: ['post-mortem', 'postmortem', 'post mortem', 'incident review'] },
  // governance-dashboard
  { domain: 'governance-dashboard', agent: 'audit', keywords: ['audit trail', 'audit log', 'governance audit'] },
  { domain: 'governance-dashboard', agent: 'impact', keywords: ['impact analys', 'blast radius'] },
  // policy-engine
  { domain: 'policy-engine', agent: 'enforce', keywords: ['enforce policy', 'policy enforce', 'apply policy'] },
  { domain: 'policy-engine', agent: 'constraints', keywords: ['constraint', 'guardrail', 'limit'] },
  { domain: 'policy-engine', agent: 'approval', keywords: ['approval', 'approve', 'sign-off'] },
  // platform
  { domain: 'platform', agent: 'executive-summary', keywords: ['executive summary', 'exec summary', 'summary report'] },
  { domain: 'platform', agent: 'decision-memo', keywords: ['decision memo', 'decision document'] },
  { domain: 'platform', agent: 'risk-score', keywords: ['risk score', 'risk assess', 'risk analys', 'risk evaluat'] },
  // forge
  { domain: 'forge', agent: 'sdk', keywords: ['generate sdk', 'sdk generat', 'client library'] },
  { domain: 'forge', agent: 'api-translation', keywords: ['api translat', 'convert api', 'openapi'] },
  // connector-hub
  { domain: 'connector-hub', agent: 'database-query', keywords: ['query database', 'database query', 'sql query', 'db query'] },
  { domain: 'connector-hub', agent: 'webhook-ingest', keywords: ['webhook', 'ingest event'] },
  { domain: 'connector-hub', agent: 'erp-surface', keywords: ['erp', 'enterprise resource'] },
  // data-vault
  { domain: 'data-vault', agent: 'anonymize', keywords: ['anonymize', 'anonymis', 'de-identify', 'deidentif'] },
  { domain: 'data-vault', agent: 'access-control', keywords: ['access control', 'permission', 'authorizat'] },
  // research-lab
  { domain: 'research-lab', agent: 'hypothesis', keywords: ['hypothesis', 'experiment', 'a/b test'] },
  { domain: 'research-lab', agent: 'metrics', keywords: ['metrics analys', 'analyze metrics', 'kpi'] },
  // simulator
  { domain: 'simulator', agent: 'what-if', keywords: ['what-if', 'what if', 'simulat', 'scenario'] },
  // compliance
  { domain: 'governance-dashboard', agent: 'audit', keywords: ['compliance', 'compliant', 'regulat', 'data residency', 'gdpr', 'hipaa', 'consent'] },
];

/**
 * Classify a query using keyword matching against the static rule table.
 * Returns the best match or null if no keywords match.
 */
function classifyByKeywords(query: string): IntentClassification | null {
  const q = query.toLowerCase();

  for (const rule of KEYWORD_RULES) {
    for (const kw of rule.keywords) {
      if (q.includes(kw)) {
        // Verify domain/agent exist in registry
        const domainConfig = AGENT_DOMAINS[rule.domain];
        if (domainConfig && domainConfig.agents.includes(rule.agent)) {
          return {
            domain: rule.domain,
            agent: rule.agent,
            confidence: 0.70, // keyword match — decent but not LLM-grade
            suggested_payload: {},
            reasoning: `Keyword match: "${kw}"`,
          };
        }
      }
    }
  }

  return null;
}

// ============================================================================
// Natural Language Routing (LLM with keyword fallback)
// ============================================================================

export async function executeNaturalLanguageRoute(
  query: string,
  options: CommandOptions,
): Promise<NaturalLanguageRouteResult> {
  const start = Date.now();
  const correlationId = options.trace_id ?? crypto.randomUUID();

  // Try LLM-based classification first (if API key available)
  let intent: IntentClassification | null = null;
  const anthropicKey = await getAnthropicApiKey();

  if (anthropicKey) {
    intent = await tryLlmClassification(query, anthropicKey, correlationId);
  }

  // Fall back to keyword-based classification
  if (!intent) {
    intent = classifyByKeywords(query);
    if (intent) {
      console.error(`Routing to ${intent.domain}/${intent.agent} (keyword match)`);
    }
  }

  // If neither method matched, throw a helpful error
  if (!intent) {
    throw new Error(
      `Could not determine intent from: "${query}"\n` +
      `\n` +
      `  No matching agent domain found. Try being more specific, or use explicit invocation:\n` +
      `    agentics agents invoke <domain> <agent> '<json-payload>'\n` +
      `    agentics agents list   # show available domains and agents`
    );
  }

  // Build dispatch payload
  const dispatchPayload: Record<string, unknown> = {
    execution_ref: correlationId,
    text: query,
    ...intent.suggested_payload,
  };

  // Dispatch to the target agent
  let invocation: AgentsInvokeResult;
  try {
    invocation = await executeAgentsInvokeCommand(
      intent.domain,
      intent.agent,
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
        `Routed to ${intent.domain}/${intent.agent} (${(intent.confidence * 100).toFixed(0)}% confidence)\n` +
        (intent.reasoning ? `  Reason: ${intent.reasoning}\n` : '') +
        `\n` +
        `  This agent requires structured input that cannot be inferred\n` +
        `  from a natural language query.\n` +
        `  Missing field: ${fieldName}\n` +
        `\n` +
        `  Use explicit invocation with the required payload:\n` +
        `    agentics agents invoke ${intent.domain} ${intent.agent} '{"execution_ref":"...","${fieldName}":"..."}'`
      );
    }
    throw dispatchError;
  }

  return {
    intent,
    invocation,
    timing: Date.now() - start,
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
