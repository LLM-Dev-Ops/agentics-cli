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
  const url = `${config.baseUrl}/health`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeout);

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'X-Correlation-ID': options.trace_id ?? crypto.randomUUID(),
      },
      signal: controller.signal,
    });

    const body = await response.json() as unknown;
    return {
      domain,
      serviceName: domainConfig.serviceName,
      healthy: response.ok,
      response: body,
      timing: Date.now() - start,
    };
  } finally {
    clearTimeout(timeout);
  }
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
 * Calls copilot/intent with the query + full domain registry,
 * validates the classification, then dispatches to the target agent.
 */
export async function executeNaturalLanguageRoute(
  query: string,
  options: CommandOptions,
): Promise<NaturalLanguageRouteResult> {
  const start = Date.now();
  const correlationId = options.trace_id ?? crypto.randomUUID();

  // Build domain registry for the intent agent
  const availableDomains: Record<string, { agents: string[]; phase: string }> = {};
  for (const [name, domain] of Object.entries(AGENT_DOMAINS)) {
    availableDomains[name] = {
      agents: domain.agents,
      phase: domain.phase,
    };
  }

  // Call copilot/intent agent
  const config = loadEndpointConfig('copilot-agents');
  const adapter = createAdapter('copilot-agents', config, correlationId);

  let intentResponse;
  try {
    intentResponse = await adapter.invoke({
      endpoint: '/v1/copilot/intent',
      method: 'POST',
      headers: {},
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
  } catch (adapterError) {
    throw new Error(
      `Intent classification failed for: "${query}"\n` +
      `  The copilot intent agent returned an error.\n` +
      `  ${adapterError instanceof Error ? adapterError.message : String(adapterError)}\n` +
      `\n` +
      `  Use explicit invocation instead:\n` +
      `    agentics agents list\n` +
      `    agentics agents invoke <domain> <agent> '<json-payload>'`
    );
  }

  // Parse the intent classification from response
  const responseBody = intentResponse.body as Record<string, unknown>;
  // The result may be nested inside a `result` envelope
  const resultBody = (responseBody.result ?? responseBody) as Record<string, unknown>;

  const intent: IntentClassification = {
    domain: (resultBody.domain as string) ?? '',
    agent: (resultBody.agent as string) ?? '',
    confidence: (resultBody.confidence as number) ?? 0,
    suggested_payload: (resultBody.suggested_payload as Record<string, unknown>) ?? {},
    reasoning: resultBody.reasoning as string | undefined,
    alternatives: resultBody.alternatives as IntentClassification['alternatives'],
  };

  // Validate confidence threshold
  if (intent.confidence < NL_MINIMUM_CONFIDENCE || !intent.domain || !intent.agent) {
    throw new Error(
      `Could not determine intent from: "${query}"\n` +
      `  Confidence: ${(intent.confidence * 100).toFixed(0)}% (minimum: ${(NL_MINIMUM_CONFIDENCE * 100)}%)\n` +
      (intent.reasoning ? `  Reasoning: ${intent.reasoning}\n` : '') +
      `\n` +
      `  Try being more specific, or use explicit invocation:\n` +
      `    agentics agents invoke <domain> <agent> '<json-payload>'\n` +
      `    agentics agents list   # show available domains and agents`
    );
  }

  // Validate domain/agent against local registry
  const domainConfig = AGENT_DOMAINS[intent.domain];
  if (!domainConfig) {
    throw new Error(
      `Intent agent returned unknown domain: '${intent.domain}'\n` +
      `  Valid domains: ${Object.keys(AGENT_DOMAINS).join(', ')}`
    );
  }
  if (!domainConfig.agents.includes(intent.agent)) {
    throw new Error(
      `Intent agent returned unknown agent '${intent.agent}' for domain '${intent.domain}'\n` +
      `  Valid agents: ${domainConfig.agents.join(', ')}`
    );
  }

  // Log classification to stderr
  const pct = (intent.confidence * 100).toFixed(0);
  console.error(`Routing to ${intent.domain}/${intent.agent} (${pct}% confidence)`);
  if (intent.reasoning) {
    console.error(`  Reason: ${intent.reasoning}`);
  }

  // Warn on low confidence
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

  // Dispatch to the target agent
  const invocation = await executeAgentsInvokeCommand(
    intent.domain,
    intent.agent,
    intent.suggested_payload,
    options,
  );

  return {
    intent,
    invocation,
    timing: Date.now() - start,
  };
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
