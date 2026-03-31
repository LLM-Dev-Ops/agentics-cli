/**
 * ADR-074: Agentics Platform Service Catalog
 *
 * Central registry of all ~50 platform services and 109 agents.
 * Used by codegen prompts and deployment generators to ensure
 * generated applications use the full platform infrastructure.
 */

// ============================================================================
// Service Definitions
// ============================================================================

export interface PlatformService {
  /** Service number from the platform architecture */
  readonly id: number;
  /** Service name (e.g., 'LLM-CostOps') */
  readonly name: string;
  /** Phase in the platform architecture */
  readonly phase: string;
  /** Environment variable name for the service URL */
  readonly envVar: string;
  /** Agent names in this service */
  readonly agents: readonly string[];
  /** When this service is used: 'runtime', 'build', or 'both' */
  readonly usedAt: 'runtime' | 'build' | 'both';
  /** Availability tier */
  readonly tier: 'must-have' | 'should-have' | 'operational' | 'build-only';
  /** One-line description of what this service does for generated code */
  readonly role: string;
}

export const PLATFORM_SERVICES: readonly PlatformService[] = [
  // Phase 1 — Foundational Tooling
  { id: 1,  name: 'LLM-Test-Bench',         phase: '1', envVar: 'AGENTICS_TEST_BENCH_URL',     agents: ['benchmark', 'compare', 'regression', 'quality', 'hallucination', 'faithfulness', 'bias', 'prompt-sensitivity', 'consistency', 'stress', 'red-team', 'adversarial', 'golden-dataset', 'synthetic-data'], usedAt: 'both',    tier: 'build-only',  role: 'Validate code quality, red-team API, benchmark simulation, generate golden datasets' },
  { id: 2,  name: 'LLM-Observatory',         phase: '1', envVar: 'AGENTICS_OBSERVATORY_URL',    agents: ['telemetry', 'usage-patterns', 'failures', 'health-check', 'slo', 'post-mortem', 'visualization'], usedAt: 'runtime', tier: 'operational', role: 'All telemetry spans, domain events, performance metrics, SLO enforcement' },
  { id: 3,  name: 'LLM-Shield',              phase: '1', envVar: 'AGENTICS_SHIELD_URL',         agents: ['prompt-injection', 'pii', 'secrets', 'toxicity', 'moderation', 'abuse', 'credential-exposure', 'safety-boundary', 'redaction'], usedAt: 'runtime', tier: 'must-have',   role: 'Scan inbound mutations and outbound ERP payloads — blocking dependency' },

  // Phase 2 — Operational Intelligence
  { id: 4,  name: 'LLM-Sentinel',            phase: '2', envVar: 'AGENTICS_SENTINEL_URL',       agents: ['anomaly', 'drift', 'alert', 'correlation', 'rca'], usedAt: 'runtime', tier: 'operational', role: 'Anomaly detection on simulation outputs, alerting, RCA on failures' },
  { id: 5,  name: 'LLM-Memory-Graph',        phase: '2', envVar: 'AGENTICS_MEMORY_GRAPH_URL',   agents: ['conversation', 'lineage', 'decisions', 'knowledge-graph', 'retrieval', 'patterns'], usedAt: 'runtime', tier: 'should-have', role: 'Persist simulation lineage, decision history, entity relationship graph' },
  { id: 6,  name: 'LLM-Latency-Lens',        phase: '2', envVar: 'AGENTICS_LATENCY_LENS_URL',   agents: ['latency', 'cold-start'], usedAt: 'both',    tier: 'operational', role: 'Profile latency, track p50/p95/p99 per operation' },
  { id: 7,  name: 'LLM-Forge',               phase: '2', envVar: 'AGENTICS_FORGE_URL',          agents: ['sdk', 'cli', 'api-translation', 'version-compat'], usedAt: 'build',   tier: 'build-only',  role: 'Generate typed clients for external APIs' },

  // Phase 3 — Automation & Resilience
  { id: 8,  name: 'LLM-Edge-Agent',          phase: '3', envVar: 'AGENTICS_EDGE_URL',           agents: ['tool-invoke', 'circuit-breaker', 'failover', 'execution-guard', 'caching'], usedAt: 'runtime', tier: 'should-have', role: 'Circuit breaking, failover, caching, operation validation' },
  { id: 9,  name: 'LLM-Auto-Optimizer',      phase: '3', envVar: 'AGENTICS_OPTIMIZER_URL',      agents: ['self-optimize', 'token', 'model-select'], usedAt: 'runtime', tier: 'operational', role: 'Optimize LLM calls, select models, reduce token usage' },
  { id: 10, name: 'LLM-Incident-Manager',    phase: '3', envVar: 'AGENTICS_INCIDENT_URL',       agents: ['escalation', 'post-mortem', 'hitl'], usedAt: 'runtime', tier: 'operational', role: 'Escalate failures, generate post-mortems, human-in-the-loop' },
  { id: 11, name: 'LLM-Orchestrator',        phase: '3', envVar: 'AGENTICS_ORCHESTRATOR_URL',   agents: ['workflow', 'scheduler', 'dependencies', 'retry', 'parallel', 'state-machine', 'swarm'], usedAt: 'runtime', tier: 'should-have', role: 'Workflow orchestration, approval state machine, retry, scheduling' },

  // Phase 4 — Governance & FinOps
  { id: 12, name: 'LLM-CostOps',             phase: '4', envVar: 'AGENTICS_COSTOPS_URL',        agents: ['attribution', 'forecast', 'budget', 'roi', 'tradeoff'], usedAt: 'runtime', tier: 'should-have', role: 'Cost attribution, forecasting, ROI, budget enforcement' },
  { id: 13, name: 'LLM-Governance-Dashboard', phase: '4', envVar: 'AGENTICS_GOVERNANCE_URL',    agents: ['audit', 'impact', 'oversight'], usedAt: 'runtime', tier: 'should-have', role: 'Persistent audit trail, change impact, usage oversight' },
  { id: 14, name: 'LLM-Policy-Engine',       phase: '4', envVar: 'AGENTICS_POLICY_URL',         agents: ['enforce', 'constraints', 'approval'], usedAt: 'runtime', tier: 'must-have',   role: 'Declarative policy enforcement, constraint solving, approval routing' },

  // Phase 5 — Ecosystem
  { id: 15, name: 'LLM-Registry',            phase: '5', envVar: 'AGENTICS_REGISTRY_URL',       agents: ['index', 'reputation', 'bootstrap'], usedAt: 'both',    tier: 'operational', role: 'Agent/model registry, reputation scores, template bootstrap' },
  { id: 16, name: 'LLM-Marketplace',         phase: '5', envVar: 'AGENTICS_MARKETPLACE_URL',    agents: ['package', 'deprecation'], usedAt: 'build',   tier: 'build-only',  role: 'Package components for reuse, deprecation management' },
  { id: 17, name: 'LLM-Analytics-Hub',       phase: '5', envVar: 'AGENTICS_ANALYTICS_URL',      agents: ['consensus', 'recommendation'], usedAt: 'runtime', tier: 'operational', role: 'Cross-system analytics, strategic recommendations, consensus' },

  // Phase 6 — Core Infrastructure
  { id: 18, name: 'LLM-Config-Manager',      phase: '6', envVar: 'AGENTICS_CONFIG_URL',         agents: ['validate'], usedAt: 'both',    tier: 'operational', role: 'Config validation, secrets management' },
  { id: 19, name: 'LLM-Schema-Registry',     phase: '6', envVar: 'AGENTICS_SCHEMA_URL',         agents: ['validate'], usedAt: 'both',    tier: 'operational', role: 'Schema version control, contract validation' },
  { id: 20, name: 'LLM-Connector-Hub',       phase: '6', envVar: 'AGENTICS_CONNECTOR_URL',      agents: ['erp-surface', 'database-query', 'webhook-ingest', 'event-normalize', 'auth-identity'], usedAt: 'runtime', tier: 'should-have', role: 'Standardized ERP adapter, database queries, webhooks, auth' },

  // Phase 7 — Intelligence
  { id: 21, name: 'LLM-CoPilot-Agent',       phase: '7', envVar: 'AGENTICS_COPILOT_URL',        agents: ['planner', 'config', 'decomposer', 'clarifier', 'intent', 'reflection', 'meta-reasoner'], usedAt: 'both',    tier: 'build-only',  role: 'Task planning, decomposition, intent classification, reflection' },
  { id: 22, name: 'LLM-Simulator',           phase: '7', envVar: 'AGENTICS_SIMULATOR_URL',      agents: ['what-if', 'scenario'], usedAt: 'both',    tier: 'build-only',  role: 'Stress-test without API costs, dynamic what-if scenarios' },
  { id: 23, name: 'LLM-Benchmark-Exchange',  phase: '7', envVar: 'AGENTICS_BENCHMARK_URL',      agents: ['publish'], usedAt: 'build',   tier: 'build-only',  role: 'Publish benchmarks to platform leaderboard' },
  { id: 24, name: 'LLM-Inference-Gateway',   phase: '7', envVar: 'AGENTICS_INFERENCE_URL',      agents: ['route'], usedAt: 'runtime', tier: 'operational', role: 'Route inference to optimal backend (Anthropic, OpenAI, Ollama, vLLM)' },
  { id: 25, name: 'LLM-Data-Vault',          phase: '7', envVar: 'AGENTICS_DATAVAULT_URL',      agents: ['access-control', 'anonymize'], usedAt: 'runtime', tier: 'should-have', role: 'Fine-grained data access control, anonymization for GDPR/SOX' },
  { id: 26, name: 'LLM-Research-Lab',        phase: '7', envVar: 'AGENTICS_RESEARCH_URL',       agents: ['hypothesis', 'metrics'], usedAt: 'both',    tier: 'build-only',  role: 'Hypothesis testing, experimental metrics, A/B testing' },

  // Phase 8 — Core Integration Bundles
  { id: 27, name: 'LLM-Intelligence-Core',   phase: '8', envVar: 'AGENTICS_INTELLIGENCE_CORE_URL', agents: [], usedAt: 'runtime', tier: 'operational', role: 'Unified analytics + drift: Test-Bench + Observatory + Sentinel + Latency-Lens + Analytics-Hub + Schema-Registry' },
  { id: 28, name: 'LLM-Security-Core',       phase: '8', envVar: 'AGENTICS_SECURITY_CORE_URL',    agents: [], usedAt: 'runtime', tier: 'must-have',   role: 'Unified security: Shield + Edge-Agent + Incident-Manager + Policy-Engine + Config-Manager' },
  { id: 29, name: 'LLM-Automation-Core',     phase: '8', envVar: 'AGENTICS_AUTOMATION_CORE_URL',  agents: [], usedAt: 'runtime', tier: 'should-have', role: 'Unified automation: Forge + Auto-Optimizer + Orchestrator + Connector-Hub' },
  { id: 30, name: 'LLM-Governance-Core',     phase: '8', envVar: 'AGENTICS_GOVERNANCE_CORE_URL',  agents: [], usedAt: 'runtime', tier: 'should-have', role: 'Unified governance: CostOps + Governance-Dashboard + Policy-Engine + Analytics-Hub + Config + Schema' },
  { id: 31, name: 'LLM-Data-Core',           phase: '8', envVar: 'AGENTICS_DATA_CORE_URL',        agents: [], usedAt: 'runtime', tier: 'should-have', role: 'Unified data: Memory-Graph + Registry + Data-Vault + Config + Schema' },
  { id: 32, name: 'LLM-Ecosystem-Core',      phase: '8', envVar: 'AGENTICS_ECOSYSTEM_CORE_URL',   agents: [], usedAt: 'runtime', tier: 'operational', role: 'Community: Marketplace + Analytics-Hub + Benchmark-Exchange' },
  { id: 33, name: 'LLM-Research-Core',       phase: '8', envVar: 'AGENTICS_RESEARCH_CORE_URL',    agents: [], usedAt: 'both',    tier: 'build-only',  role: 'Experimentation: Schema-Registry + Simulator + Research-Lab' },
  { id: 34, name: 'LLM-Interface-Core',      phase: '8', envVar: 'AGENTICS_INTERFACE_CORE_URL',   agents: [], usedAt: 'both',    tier: 'operational', role: 'Developer tooling: Forge + Config + Connector-Hub + CoPilot + Inference-Gateway' },

  // Phase 9 — Apex Platform
  { id: 35, name: 'Agentics-Dev-Platform',   phase: '9', envVar: 'AGENTICS_PLATFORM_URL',         agents: ['decision', 'executive-summary', 'decision-memo', 'risk-score'], usedAt: 'runtime', tier: 'should-have', role: 'Go/no-go decisions, executive summaries, decision memos, risk scores' },

  // Layer 4 — Infrastructure
  { id: 47, name: 'enterprise-roi-engine',    phase: 'L4', envVar: 'AGENTICS_ROI_ENGINE_URL',      agents: ['enterprise-strategy'], usedAt: 'runtime', tier: 'should-have', role: 'Enterprise ROI: NPV, IRR, payback period, department-level breakdown' },
  { id: 48, name: 'erp-surface',             phase: 'L4', envVar: 'AGENTICS_ERP_SURFACE_URL',     agents: ['erp-integration'], usedAt: 'runtime', tier: 'should-have', role: 'Standardized ERP adapter — replaces hand-built Oracle/SAP clients' },
  { id: 50, name: 'agentics-results-index',  phase: 'L4', envVar: 'AGENTICS_RESULTS_INDEX_URL',   agents: [], usedAt: 'runtime', tier: 'operational', role: 'Index and search all simulation results, decisions, outputs' },
  { id: 51, name: 'agentics-usage-ledger',   phase: 'L4', envVar: 'AGENTICS_USAGE_LEDGER_URL',    agents: [], usedAt: 'runtime', tier: 'operational', role: 'Immutable usage metering and billing ledger' },
  { id: 52, name: 'agentics-execution-engine', phase: 'L4', envVar: 'AGENTICS_EXECUTION_URL',     agents: [], usedAt: 'runtime', tier: 'should-have', role: 'Execute approved operations (writeback, deployment)' },
  { id: 53, name: 'agentics-enforcement',    phase: 'L4', envVar: 'AGENTICS_ENFORCEMENT_URL',     agents: [], usedAt: 'runtime', tier: 'must-have',   role: 'Runtime policy enforcement — execution layer for Policy-Engine decisions' },
  { id: 46, name: 'ruvector-service',        phase: 'L4', envVar: 'AGENTICS_RUVECTOR_URL',        agents: ['approval-learning', 'feedback-assimilation'], usedAt: 'runtime', tier: 'operational', role: 'Vector operations, approval learning, feedback assimilation' },
  { id: 39, name: 'agentics-simulation-planner', phase: 'L4', envVar: 'AGENTICS_SIM_PLANNER_URL', agents: [], usedAt: 'runtime', tier: 'operational', role: 'Plan simulation strategies — which scenarios, parameters, suppliers to include' },
  { id: 40, name: 'agentics-simulator-runner', phase: 'L4', envVar: 'AGENTICS_SIM_RUNNER_URL',    agents: [], usedAt: 'runtime', tier: 'operational', role: 'Execute simulations in isolated environments' },
] as const;

// ============================================================================
// Helpers
// ============================================================================

/** Get all runtime services (used at 'runtime' or 'both') */
export function getRuntimeServices(): readonly PlatformService[] {
  return PLATFORM_SERVICES.filter(s => s.usedAt === 'runtime' || s.usedAt === 'both');
}

/** Get all build-time services */
export function getBuildTimeServices(): readonly PlatformService[] {
  return PLATFORM_SERVICES.filter(s => s.usedAt === 'build' || s.usedAt === 'both');
}

/** Get services by availability tier */
export function getServicesByTier(tier: PlatformService['tier']): readonly PlatformService[] {
  return PLATFORM_SERVICES.filter(s => s.tier === tier);
}

// ============================================================================
// Codegen Prompt Context
// ============================================================================

/**
 * Generate the platform service catalog block for injection into LLM codegen prompts.
 * This tells the LLM what services are available and how to use them.
 */
export function buildPlatformCatalogPrompt(): string {
  const runtimeServices = getRuntimeServices();
  const lines: string[] = [
    '## ADR-074: Available Platform Services (use these — do NOT reimplement)',
    '',
    'The Agentics platform provides deployed Cloud Run services that handle cross-cutting concerns.',
    'Generated code MUST use them via HTTP calls authenticated with GCP identity tokens.',
    'Do NOT create local implementations of telemetry, audit logging, cost tracking, security scanning,',
    'circuit breaking, or any other capability listed below.',
    '',
    '### Service Catalog (runtime)',
    '',
    '| Service | Env Var | Tier | Role |',
    '|---------|---------|------|------|',
  ];

  for (const svc of runtimeServices) {
    lines.push(`| ${svc.name} | ${svc.envVar} | ${svc.tier} | ${svc.role} |`);
  }

  lines.push('');
  lines.push('### Availability Tiers');
  lines.push('- **must-have**: Block request if unavailable (Shield, Policy-Engine, enforcement)');
  lines.push('- **should-have**: Queue locally, retry later (CostOps, Governance-Dashboard, Memory-Graph)');
  lines.push('- **operational**: Log locally, continue without (Observatory, Sentinel, Analytics-Hub)');
  lines.push('');
  lines.push('### Calling Convention');
  lines.push('```typescript');
  lines.push('// All platform services use the same pattern:');
  lines.push('await callPlatformService(process.env.AGENTICS_SHIELD_URL, \'/api/v1/scan\', payload);');
  lines.push('```');
  lines.push('The `callPlatformService` utility is available in dependencies.ts. It handles GCP auth tokens,');
  lines.push('correlation ID propagation, and availability tier behavior (block/queue/continue).');
  lines.push('');

  return lines.join('\n');
}

// ============================================================================
// Generated Code: Platform Client Utility
// ============================================================================

/**
 * Generate the `callPlatformService` utility function for inclusion
 * in the generated dependencies.ts file.
 */
export function generatePlatformClientCode(): string {
  return [
    '// ============================================================================',
    '// ADR-074: Platform Service Client',
    '// ============================================================================',
    '',
    'type AvailabilityTier = \'must-have\' | \'should-have\' | \'operational\';',
    '',
    'interface PlatformCallOptions {',
    '  /** Availability tier — controls behavior when service is unavailable */',
    '  tier?: AvailabilityTier;',
    '  /** Correlation ID for tracing */',
    '  correlationId?: string;',
    '  /** Timeout in ms (default: 10000) */',
    '  timeoutMs?: number;',
    '}',
    '',
    '/**',
    ' * Call an Agentics platform service.',
    ' * All platform services are Cloud Run endpoints authenticated via GCP identity tokens.',
    ' * Behavior on failure depends on availability tier:',
    ' *   must-have: throws (caller should return 503)',
    ' *   should-have: logs warning, returns null',
    ' *   operational: logs debug, returns null',
    ' */',
    'export async function callPlatformService(',
    '  serviceUrl: string | undefined,',
    '  path: string,',
    '  payload: unknown,',
    '  options: PlatformCallOptions = {},',
    '): Promise<unknown | null> {',
    '  if (!serviceUrl) {',
    '    if (options.tier === \'must-have\') {',
    '      throw new Error(`Platform service not configured (${path}). Set the environment variable.`);',
    '    }',
    '    return null;',
    '  }',
    '',
    '  const timeout = options.timeoutMs ?? 10_000;',
    '  const controller = new AbortController();',
    '  const timeoutId = setTimeout(() => controller.abort(), timeout);',
    '',
    '  try {',
    '    // GCP service-to-service auth via metadata server',
    '    let token = \'\';',
    '    try {',
    '      const metadataUrl = `http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity?audience=${serviceUrl}`;',
    '      const tokenResponse = await fetch(metadataUrl, {',
    '        headers: { \'Metadata-Flavor\': \'Google\' },',
    '        signal: AbortSignal.timeout(3_000),',
    '      });',
    '      if (tokenResponse.ok) token = await tokenResponse.text();',
    '    } catch {',
    '      // Not on GCP (local dev) — proceed without token',
    '    }',
    '',
    '    const headers: Record<string, string> = {',
    '      \'Content-Type\': \'application/json\',',
    '      ...(options.correlationId ? { \'X-Correlation-ID\': options.correlationId } : {}),',
    '      ...(token ? { \'Authorization\': `Bearer ${token}` } : {}),',
    '    };',
    '',
    '    const response = await fetch(`${serviceUrl}${path}`, {',
    '      method: \'POST\',',
    '      headers,',
    '      body: JSON.stringify(payload),',
    '      signal: controller.signal,',
    '    });',
    '',
    '    if (!response.ok) {',
    '      const body = await response.text().catch(() => \'\');',
    '      throw new Error(`Platform service ${path} returned HTTP ${response.status}: ${body}`);',
    '    }',
    '',
    '    return response.json();',
    '  } catch (err) {',
    '    if (options.tier === \'must-have\') {',
    '      throw err;',
    '    }',
    '    if (options.tier === \'should-have\') {',
    '      console.warn(JSON.stringify({ level: \'warn\', type: \'PLATFORM_SERVICE_UNAVAILABLE\', path, error: err instanceof Error ? err.message : String(err) }));',
    '    }',
    '    return null;',
    '  } finally {',
    '    clearTimeout(timeoutId);',
    '  }',
    '}',
    '',
  ].join('\n');
}

// ============================================================================
// Generated Code: Environment Variable Block for .env.example
// ============================================================================

/**
 * Generate the platform service URL environment variables block
 * for inclusion in the generated .env.example file.
 */
export function generatePlatformEnvBlock(): string {
  const runtimeServices = getRuntimeServices();
  const lines: string[] = [
    '# ADR-074: Agentics Platform Service URLs',
    '# These are deployed Cloud Run services. Set during deployment.',
    '# Services with no URL configured will use availability tier behavior:',
    '#   must-have → error, should-have → skip+log, operational → skip silently',
  ];

  for (const svc of runtimeServices) {
    lines.push(`# ${svc.envVar}= # ${svc.name} (${svc.tier}): ${svc.role}`);
  }

  lines.push('');
  return lines.join('\n');
}
