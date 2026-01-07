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
 */

import type { EndpointRegistry, EndpointConfig } from '../types/index.js';

// ============================================================================
// Default Endpoint Configuration
// ============================================================================

const API_BASE = process.env['AGENTICS_API_URL'] ?? 'https://agentics-cli-1062287243982.us-central1.run.app';

export const DEFAULT_ENDPOINTS: EndpointRegistry = {
  'agentics-org-manifests': {
    baseUrl: process.env['AGENTICS_MANIFESTS_URL'] ?? API_BASE,
    version: 'v1',
    timeout: 30000,
  },
  'agentics-simulation-planner': {
    baseUrl: process.env['AGENTICS_PLANNER_URL'] ?? API_BASE,
    version: 'v1',
    timeout: 60000,
  },
  'agentics-simulation-runner': {
    baseUrl: process.env['AGENTICS_RUNNER_URL'] ?? API_BASE,
    version: 'v1',
    timeout: 300000, // 5 minutes for simulations
  },
  'agentics-simulation-engine': {
    baseUrl: process.env['AGENTICS_SIMULATION_ENGINE_URL'] ?? API_BASE,
    version: 'v1',
    timeout: 120000, // 2 minutes for artifact retrieval
  },
  'enterprise-roi-engine': {
    baseUrl: process.env['ENTERPRISE_ROI_ENGINE_URL'] ?? API_BASE,
    version: 'v1',
    timeout: 180000, // 3 minutes for ROI calculations
  },
  'agentics-deployment-intent': {
    baseUrl: process.env['AGENTICS_INTENT_URL'] ?? API_BASE,
    version: 'v1',
    timeout: 60000,
  },
  'agentics-deployment-exporters': {
    baseUrl: process.env['AGENTICS_EXPORTERS_URL'] ?? API_BASE,
    version: 'v1',
    timeout: 120000,
  },
  'diligence-artifacts': {
    baseUrl: process.env['DILIGENCE_URL'] ?? API_BASE,
    version: 'v1',
    timeout: 180000,
  },
};

// ============================================================================
// Configuration Loader
// ============================================================================

export function loadEndpointConfig(
  serviceName: keyof EndpointRegistry,
  overrides?: Partial<EndpointConfig>
): EndpointConfig {
  const defaults = DEFAULT_ENDPOINTS[serviceName];
  return {
    ...defaults,
    ...overrides,
  };
}

export function loadAllEndpoints(
  overrides?: Partial<EndpointRegistry>
): EndpointRegistry {
  return {
    ...DEFAULT_ENDPOINTS,
    ...overrides,
  };
}
