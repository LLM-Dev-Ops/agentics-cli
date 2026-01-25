/**
 * Service Health Gate Module
 *
 * CONTROL PLANE HARDENING
 *
 * PURPOSE: Validate Ruvector-backed service availability before ANY remote execution.
 *          This gate ensures the CLI NEVER executes against misconfigured or unavailable services.
 *
 * CRITICAL REQUIREMENTS:
 * - CLI MUST require Ruvector-backed services
 * - CLI MUST fail loudly if services are misconfigured
 * - Abort command if health check fails
 *
 * FORBIDDEN:
 * - Fallback behavior
 * - Local caching of results
 * - Silent failures
 */

import { loadEndpointConfig } from '../config/endpoints.js';
import { BaseAdapter } from '../adapters/base-adapter.js';
import { EXIT_CODES } from '../types/index.js';

// ============================================================================
// Service Health Gate Configuration
// ============================================================================

/**
 * Critical services that MUST be healthy before any operational command.
 * Ruvector is the primary persistence layer - without it, operations cannot be verified.
 */
const CRITICAL_SERVICES = ['ruvector-service'] as const;

/**
 * Timeout for health checks (in milliseconds).
 * Fast timeout - services should respond quickly if healthy.
 */
const HEALTH_CHECK_TIMEOUT_MS = 5000;

/**
 * Exit code for service unavailable.
 */
export const SERVICE_UNAVAILABLE_EXIT_CODE = EXIT_CODES.SERVICE_UNAVAILABLE;

// ============================================================================
// Service Health Gate Error
// ============================================================================

export class ServiceHealthError extends Error {
  readonly serviceName: string;
  readonly healthCheckUrl: string;
  readonly cause?: Error;

  constructor(serviceName: string, healthCheckUrl: string, cause?: Error) {
    super(
      `\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
      `  SERVICE UNAVAILABLE\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
      `\n` +
      `  Service:     ${serviceName}\n` +
      `  Health URL:  ${healthCheckUrl}/health\n` +
      `  Status:      UNREACHABLE\n` +
      `\n` +
      `  The CLI requires this Ruvector-backed service to be available.\n` +
      `  All operational commands are blocked until the service is healthy.\n` +
      `\n` +
      `  TROUBLESHOOTING:\n` +
      `\n` +
      `  1. Verify service deployment:\n` +
      `     Check that the Cloud Run service is deployed and running.\n` +
      `\n` +
      `  2. Check network connectivity:\n` +
      `     Ensure you have network access to the service URL.\n` +
      `\n` +
      `  3. Verify authentication:\n` +
      `     Run 'agentics whoami' to check authentication status.\n` +
      `\n` +
      `  4. Contact platform support:\n` +
      `     If the issue persists, contact the Agentics platform team.\n` +
      `\n` +
      (cause ? `  Error: ${cause.message}\n\n` : '') +
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`
    );
    this.name = 'ServiceHealthError';
    this.serviceName = serviceName;
    this.healthCheckUrl = healthCheckUrl;
    this.cause = cause;
  }
}

// ============================================================================
// Service Health Gate Interface
// ============================================================================

export interface ServiceHealthResult {
  healthy: boolean;
  service: string;
  url: string;
  latency?: number;
  error?: string;
}

export interface ServiceHealthGateResult {
  passed: boolean;
  results: ServiceHealthResult[];
  exitCode?: number;
  message?: string;
}

// ============================================================================
// Service Health Gate Implementation
// ============================================================================

/**
 * Check health of a single service.
 * Returns structured result - does not throw.
 */
async function checkServiceHealth(
  serviceName: typeof CRITICAL_SERVICES[number]
): Promise<ServiceHealthResult> {
  const startTime = Date.now();

  try {
    const config = loadEndpointConfig(serviceName);
    const adapter = new BaseAdapter({
      serviceName,
      config: {
        ...config,
        timeout: HEALTH_CHECK_TIMEOUT_MS,
      },
    });

    const healthResult = await adapter.health();

    return {
      healthy: healthResult.healthy,
      service: serviceName,
      url: config.baseUrl,
      latency: Date.now() - startTime,
    };
  } catch (error) {
    return {
      healthy: false,
      service: serviceName,
      url: 'unknown',
      latency: Date.now() - startTime,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Check if all critical services are healthy.
 * Returns a structured result - does not exit the process.
 */
export async function checkServiceHealthGate(): Promise<ServiceHealthGateResult> {
  const results: ServiceHealthResult[] = [];

  // Check all critical services in parallel
  const healthChecks = CRITICAL_SERVICES.map(service => checkServiceHealth(service));
  const healthResults = await Promise.all(healthChecks);

  for (const result of healthResults) {
    results.push(result);
  }

  // Gate passes only if ALL critical services are healthy
  const unhealthyServices = results.filter(r => !r.healthy);

  if (unhealthyServices.length > 0) {
    const failedService = unhealthyServices[0]!;
    return {
      passed: false,
      results,
      exitCode: SERVICE_UNAVAILABLE_EXIT_CODE,
      message: new ServiceHealthError(
        failedService.service,
        failedService.url,
        failedService.error ? new Error(failedService.error) : undefined
      ).message,
    };
  }

  return {
    passed: true,
    results,
  };
}

/**
 * Enforce the service health gate. Exits the process if any critical service is unhealthy.
 * This is the HARD gate that blocks all operations if services are misconfigured.
 */
export async function enforceServiceHealthGate(): Promise<void> {
  const result = await checkServiceHealthGate();

  if (!result.passed) {
    console.error(result.message);
    process.exit(result.exitCode);
  }
}

/**
 * Commands that require service health check.
 * All operational commands require healthy services.
 * Identity commands (login, logout, whoami) and meta commands (help, version) do NOT require health checks.
 */
const HEALTH_CHECK_REQUIRED_COMMANDS = new Set([
  'plan',
  'simulate',
  'inspect',
  'quantify',
  'deploy',
  'export',
  'diligence',
  'usage',
  'policy',
  'erp',
]);

/**
 * Check if a command requires service health check.
 */
export function requiresHealthCheck(command: string): boolean {
  return HEALTH_CHECK_REQUIRED_COMMANDS.has(command);
}
