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
    baseUrl: process.env['AGENTICS_RUNNER_URL'] ?? 'https://agentics-runner-1062287243982.us-central1.run.app',
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
    baseUrl: process.env['ENTERPRISE_ROI_ENGINE_URL'] ?? 'https://agentics-roi-1062287243982.us-central1.run.app',
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
