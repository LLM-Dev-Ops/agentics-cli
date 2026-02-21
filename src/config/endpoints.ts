/**
 * Endpoint Configuration
 *
 * SPARC Architecture Reference: §2.4
 *
 * PURPOSE: Define downstream service endpoints
 *
 * FORBIDDEN:
 * - Business Logic
 * - Dynamic endpoint construction based on data
 *
 * LOCALHOST SAFEGUARD:
 * - By default, the CLI targets production Cloud Run endpoints
 * - If any endpoint URL resolves to localhost, the CLI will fail fast
 * - To enable local development, set AGENTICS_LOCAL_DEV=true explicitly
 * - This prevents accidental localhost usage in production
 */

import type { EndpointRegistry, EndpointConfig } from '../types/index.js';

// ============================================================================
// Local Development Mode Detection
// ============================================================================

/**
 * Check if local development mode is explicitly enabled.
 * Must be set to 'true' or '1' to enable localhost endpoints.
 */
export function isLocalDevMode(): boolean {
  const localDev = process.env['AGENTICS_LOCAL_DEV'];
  return localDev === 'true' || localDev === '1';
}

/**
 * Check if a URL points to localhost or 127.0.0.1
 */
export function isLocalhostUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    // URL parsing strips brackets from IPv6, so [::1] becomes ::1
    const hostname = parsed.hostname.toLowerCase();
    return (
      hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      hostname === '::1' ||
      hostname === '[::1]' ||
      hostname.startsWith('127.') ||
      hostname.endsWith('.localhost')
    );
  } catch {
    // If URL parsing fails, check for common localhost patterns in the string
    const lower = url.toLowerCase();
    return (
      lower.includes('localhost') ||
      lower.includes('127.0.0.1') ||
      lower.includes('[::1]') ||
      lower.includes('//::1')
    );
  }
}

/**
 * Error thrown when localhost is used without explicit local development mode.
 */
export class LocalhostInProductionError extends Error {
  readonly serviceName: string;
  readonly url: string;

  constructor(serviceName: string, url: string) {
    super(
      `\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
      `  LOCALHOST ENDPOINT BLOCKED\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
      `\n` +
      `  Service: ${serviceName}\n` +
      `  URL:     ${url}\n` +
      `\n` +
      `  The CLI detected a localhost URL for a production service.\n` +
      `  This is blocked to prevent accidental local execution in production.\n` +
      `\n` +
      `  TO FIX:\n` +
      `\n` +
      `  Option 1: Use production endpoints (recommended)\n` +
      `    - Unset the environment variable overriding this endpoint\n` +
      `    - The CLI will use the default Cloud Run URL\n` +
      `\n` +
      `  Option 2: Enable local development mode\n` +
      `    - Set AGENTICS_LOCAL_DEV=true to allow localhost endpoints\n` +
      `    - Example: AGENTICS_LOCAL_DEV=true agentics simulate "test"\n` +
      `\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`
    );
    this.name = 'LocalhostInProductionError';
    this.serviceName = serviceName;
    this.url = url;
  }
}

/**
 * Validate that an endpoint URL is allowed based on the current mode.
 * Throws LocalhostInProductionError if localhost is used without local dev mode.
 */
export function validateEndpointUrl(serviceName: string, url: string): void {
  if (isLocalhostUrl(url) && !isLocalDevMode()) {
    throw new LocalhostInProductionError(serviceName, url);
  }
}

// ============================================================================
// Default Endpoint Configuration
// ============================================================================

// Cloud Run service URLs (project: agentics-dev, region: us-central1)
// Each service has its own Cloud Run deployment with /v1/* routes

export const DEFAULT_ENDPOINTS: EndpointRegistry = {
  'agentics-org-manifests': {
    baseUrl: process.env['AGENTICS_MANIFESTS_URL'] ?? 'https://agentics-manifests-1062287243982.us-central1.run.app',
    version: 'v1',
    timeout: 30000,
  },
  'agentics-simulation-planner': {
    baseUrl: process.env['AGENTICS_PLANNER_URL'] ?? 'https://agentics-simulation-planner-1062287243982.us-central1.run.app',
    version: 'v1',
    timeout: 60000,
  },
  'agentics-simulation-runner': {
    baseUrl: process.env['AGENTICS_RUNNER_URL'] ?? 'https://agentics-simulation-runner-1062287243982.us-central1.run.app',
    version: 'v1',
    timeout: 300000, // 5 minutes for simulations
  },
  'agentics-simulation-engine': {
    baseUrl: process.env['AGENTICS_SIMULATION_ENGINE_URL'] ?? 'https://agentics-simulation-1062287243982.us-central1.run.app',
    version: 'v1',
    timeout: 120000, // 2 minutes for artifact retrieval
  },
  'agentics-results-index': {
    baseUrl: process.env['AGENTICS_RESULTS_INDEX_URL'] ?? 'https://agentics-results-index-1062287243982.us-central1.run.app',
    version: 'v1',
    timeout: 30000, // 30 seconds for read-only queries
  },
  'enterprise-roi-engine': {
    baseUrl: process.env['ENTERPRISE_ROI_ENGINE_URL'] ?? 'https://enterprise-roi-engine-1062287243982.us-central1.run.app',
    version: 'v1',
    timeout: 180000, // 3 minutes for ROI calculations
  },
  'agentics-deployment-intent': {
    baseUrl: process.env['AGENTICS_INTENT_URL'] ?? 'https://agentics-intent-1062287243982.us-central1.run.app',
    version: 'v1',
    timeout: 60000,
  },
  'agentics-deployment-exporters': {
    baseUrl: process.env['AGENTICS_EXPORTERS_URL'] ?? 'https://agentics-exporters-1062287243982.us-central1.run.app',
    version: 'v1',
    timeout: 120000,
  },
  'diligence-artifacts': {
    baseUrl: process.env['DILIGENCE_URL'] ?? 'https://agentics-diligence-1062287243982.us-central1.run.app',
    version: 'v1',
    timeout: 180000,
  },
  'agentics-usage-ledger': {
    baseUrl: process.env['AGENTICS_USAGE_LEDGER_URL'] ?? 'https://agentics-usage-ledger-1062287243982.us-central1.run.app',
    version: 'v1',
    timeout: 15000, // 15 seconds for usage queries
  },
  'ruvector-service': {
    baseUrl: process.env['RUVECTOR_SERVICE_URL'] ?? 'https://ruvvector-service-1062287243982.us-central1.run.app',
    version: 'v1',
    timeout: 30000, // 30 seconds for plan storage operations
  },

  // ==========================================================================
  // Downstream Agent Cloud Functions
  // All deployed as Google Cloud Functions in us-central1
  // URL pattern: https://us-central1-agentics-dev.cloudfunctions.net/{name}
  // ==========================================================================

  // Phase 1: Evaluation, Telemetry, Safety
  'test-bench-agents': {
    baseUrl: process.env['TEST_BENCH_URL'] ?? 'https://us-central1-agentics-dev.cloudfunctions.net/test-bench-agents',
    version: 'v1',
    timeout: 120000, // 2 minutes for evaluation runs
  },
  'observatory-agents': {
    baseUrl: process.env['OBSERVATORY_URL'] ?? 'https://us-central1-agentics-dev.cloudfunctions.net/observatory-agents',
    version: 'v1',
    timeout: 60000,
  },
  'shield-agents': {
    baseUrl: process.env['SHIELD_URL'] ?? 'https://us-central1-agentics-dev.cloudfunctions.net/shield-agents',
    version: 'v1',
    timeout: 30000,
  },

  // Phase 2: Operational Intelligence
  'sentinel-agents': {
    baseUrl: process.env['SENTINEL_URL'] ?? 'https://us-central1-agentics-dev.cloudfunctions.net/sentinel-agents',
    version: 'v1',
    timeout: 60000,
  },
  'memory-graph-agents': {
    baseUrl: process.env['MEMORY_GRAPH_URL'] ?? 'https://us-central1-agentics-dev.cloudfunctions.net/memory-graph-agents',
    version: 'v1',
    timeout: 60000,
  },
  'latency-lens-agents': {
    baseUrl: process.env['LATENCY_LENS_URL'] ?? 'https://us-central1-agentics-dev.cloudfunctions.net/latency-lens-agents',
    version: 'v1',
    timeout: 60000,
  },
  'forge-agents': {
    baseUrl: process.env['FORGE_URL'] ?? 'https://us-central1-agentics-dev.cloudfunctions.net/forge-agents',
    version: 'v1',
    timeout: 120000, // 2 minutes for SDK generation
  },

  // Phase 3: Automation & Resilience
  'edge-agents': {
    baseUrl: process.env['EDGE_AGENTS_URL'] ?? 'https://us-central1-agentics-dev.cloudfunctions.net/edge-agents',
    version: 'v1',
    timeout: 30000,
  },
  'auto-optimizer-agents': {
    baseUrl: process.env['AUTO_OPTIMIZER_URL'] ?? 'https://us-central1-agentics-dev.cloudfunctions.net/auto-optimizer-agents',
    version: 'v1',
    timeout: 60000,
  },
  'incident-manager-agents': {
    baseUrl: process.env['INCIDENT_MANAGER_URL'] ?? 'https://us-central1-agentics-dev.cloudfunctions.net/incident-manager-agents',
    version: 'v1',
    timeout: 60000,
  },
  'orchestrator-agents': {
    baseUrl: process.env['ORCHESTRATOR_URL'] ?? 'https://us-central1-agentics-dev.cloudfunctions.net/orchestrator-agents',
    version: 'v1',
    timeout: 300000, // 5 minutes for orchestration workflows
  },

  // Phase 4: Governance & FinOps
  'costops-agents': {
    baseUrl: process.env['COSTOPS_URL'] ?? 'https://us-central1-agentics-dev.cloudfunctions.net/costops-agents',
    version: 'v1',
    timeout: 120000,
  },
  'governance-dashboard-agents': {
    baseUrl: process.env['GOVERNANCE_DASHBOARD_URL'] ?? 'https://us-central1-agentics-dev.cloudfunctions.net/governance-dashboard-agents',
    version: 'v1',
    timeout: 60000,
  },
  'policy-engine-agents': {
    baseUrl: process.env['POLICY_ENGINE_URL'] ?? 'https://us-central1-agentics-dev.cloudfunctions.net/policy-engine-agents',
    version: 'v1',
    timeout: 30000,
  },

  // Phase 5: Ecosystem & Collaboration
  'registry-agents': {
    baseUrl: process.env['REGISTRY_URL'] ?? 'https://us-central1-agentics-dev.cloudfunctions.net/registry-agents',
    version: 'v1',
    timeout: 30000,
  },
  'marketplace-agents': {
    baseUrl: process.env['MARKETPLACE_URL'] ?? 'https://us-central1-agentics-dev.cloudfunctions.net/marketplace-agents',
    version: 'v1',
    timeout: 60000,
  },
  'analytics-hub-agents': {
    baseUrl: process.env['ANALYTICS_HUB_URL'] ?? 'https://us-central1-agentics-dev.cloudfunctions.net/analytics-hub-agents',
    version: 'v1',
    timeout: 120000,
  },

  // Phase 6: Core Infrastructure
  'config-manager-agents': {
    baseUrl: process.env['CONFIG_MANAGER_URL'] ?? 'https://us-central1-agentics-dev.cloudfunctions.net/config-manager-agents',
    version: 'v1',
    timeout: 30000,
  },
  'schema-registry-agents': {
    baseUrl: process.env['SCHEMA_REGISTRY_URL'] ?? 'https://us-central1-agentics-dev.cloudfunctions.net/schema-registry-agents',
    version: 'v1',
    timeout: 30000,
  },
  'connector-hub-agents': {
    baseUrl: process.env['CONNECTOR_HUB_URL'] ?? 'https://connector-hub-agents-1062287243982.us-central1.run.app',
    version: 'v1',
    timeout: 60000,
  },

  // Phase 7: Intelligence & Expansion
  'copilot-agents': {
    baseUrl: process.env['COPILOT_URL'] ?? 'https://us-central1-agentics-dev.cloudfunctions.net/copilot-agents',
    version: 'v1',
    timeout: 120000,
  },
  'simulator-agents': {
    baseUrl: process.env['SIMULATOR_URL'] ?? 'https://us-central1-agentics-dev.cloudfunctions.net/simulator-agents',
    version: 'v1',
    timeout: 300000, // 5 minutes for simulations
  },
  'benchmark-exchange-agents': {
    baseUrl: process.env['BENCHMARK_EXCHANGE_URL'] ?? 'https://us-central1-agentics-dev.cloudfunctions.net/benchmark-exchange-agents',
    version: 'v1',
    timeout: 60000,
  },
  'inference-gateway-agents': {
    baseUrl: process.env['INFERENCE_GATEWAY_URL'] ?? 'https://us-central1-agentics-dev.cloudfunctions.net/inference-gateway-agents',
    version: 'v1',
    timeout: 120000,
  },
  'data-vault-agents': {
    baseUrl: process.env['DATA_VAULT_URL'] ?? 'https://us-central1-agentics-dev.cloudfunctions.net/data-vault-agents',
    version: 'v1',
    timeout: 60000,
  },
  'research-lab-agents': {
    baseUrl: process.env['RESEARCH_LAB_URL'] ?? 'https://us-central1-agentics-dev.cloudfunctions.net/research-lab-agents',
    version: 'v1',
    timeout: 120000,
  },

  // Phase 9: Apex Platform
  'platform-agents': {
    baseUrl: process.env['PLATFORM_AGENTS_URL'] ?? 'https://us-central1-agentics-dev.cloudfunctions.net/platform-agents',
    version: 'v1',
    timeout: 60000,
  },
};

// ============================================================================
// Configuration Loader
// ============================================================================

/**
 * Load endpoint configuration for a specific service.
 * Validates that the endpoint URL is allowed (fails fast if localhost without local dev mode).
 *
 * @throws LocalhostInProductionError if localhost is used without AGENTICS_LOCAL_DEV=true
 */
export function loadEndpointConfig(
  serviceName: keyof EndpointRegistry,
  overrides?: Partial<EndpointConfig>
): EndpointConfig {
  const defaults = DEFAULT_ENDPOINTS[serviceName];
  const config = {
    ...defaults,
    ...overrides,
  };

  // Validate endpoint URL - fail fast if localhost in production mode
  validateEndpointUrl(serviceName, config.baseUrl);

  return config;
}

/**
 * Load all endpoint configurations.
 * Validates that all endpoint URLs are allowed (fails fast if any localhost without local dev mode).
 *
 * @throws LocalhostInProductionError if any localhost is used without AGENTICS_LOCAL_DEV=true
 */
export function loadAllEndpoints(
  overrides?: Partial<EndpointRegistry>
): EndpointRegistry {
  const endpoints = {
    ...DEFAULT_ENDPOINTS,
    ...overrides,
  };

  // Validate all endpoint URLs
  for (const [serviceName, config] of Object.entries(endpoints)) {
    validateEndpointUrl(serviceName, config.baseUrl);
  }

  return endpoints;
}

/**
 * Get information about the current endpoint mode.
 * Useful for debugging and logging.
 */
export function getEndpointModeInfo(): {
  isLocalDev: boolean;
  mode: 'local' | 'production';
  description: string;
} {
  const isLocalDev = isLocalDevMode();
  return {
    isLocalDev,
    mode: isLocalDev ? 'local' : 'production',
    description: isLocalDev
      ? 'Local development mode (localhost endpoints allowed)'
      : 'Production mode (Cloud Run endpoints only)',
  };
}
