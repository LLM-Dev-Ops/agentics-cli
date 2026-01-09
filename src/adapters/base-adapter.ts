/**
 * Downstream Adapter Module (Module C)
 *
 * SPARC Architecture Reference: §2.4
 *
 * PURPOSE: Invoke external repository APIs with minimal coupling
 *
 * DEPENDENCIES: HTTP Client only
 *
 * FORBIDDEN:
 * - Response Parsing (NO JSON schema validation)
 * - Response Transform (NO field mapping or conversion)
 * - Business Logic (NO conditional handling based on data)
 * - Caching (NO response storage)
 * - Error Recovery (Errors bubble up unchanged)
 */

import type {
  AdapterRequest,
  AdapterResponse,
  HealthStatus,
  EndpointConfig,
} from '../types/index.js';
import { ServiceError } from '../errors/index.js';

// ============================================================================
// Upstream Error Normalization
// ============================================================================

/**
 * Known fields that may contain error messages in upstream responses.
 * Checked in priority order.
 */
const ERROR_MESSAGE_FIELDS = ['message', 'error', 'detail', 'reason', 'description', 'msg'] as const;

/**
 * Known fields that may contain upstream trace/correlation IDs.
 */
const TRACE_ID_FIELDS = ['trace_id', 'traceId', 'correlation_id', 'correlationId', 'request_id', 'requestId'] as const;

/**
 * Normalized upstream error with human-readable message and optional trace ID.
 */
interface NormalizedUpstreamError {
  message: string;
  upstreamTraceId?: string;
  code?: string;
}

/**
 * Extract a human-readable error message from an upstream error payload.
 * Handles various error response formats and never returns [object Object].
 */
export function normalizeUpstreamError(payload: unknown): NormalizedUpstreamError {
  // Handle null/undefined
  if (payload === null || payload === undefined) {
    return { message: 'No error details provided' };
  }

  // Handle strings directly
  if (typeof payload === 'string') {
    return { message: payload.trim() || 'Empty error response' };
  }

  // Handle non-objects (numbers, booleans, etc.)
  if (typeof payload !== 'object') {
    return { message: String(payload) };
  }

  // Handle arrays
  if (Array.isArray(payload)) {
    if (payload.length === 0) {
      return { message: 'Empty error array' };
    }
    // Recursively normalize first element or join messages
    const messages = payload
      .slice(0, 5) // Limit to first 5 for readability
      .map(item => normalizeUpstreamError(item).message)
      .filter(Boolean);
    return { message: messages.join('; ') || 'Array of errors (no details)' };
  }

  // Handle objects
  const obj = payload as Record<string, unknown>;
  const result: NormalizedUpstreamError = { message: '' };

  // Extract error code if present (only if it's a primitive)
  if ('code' in obj && obj['code'] !== undefined) {
    const codeValue = obj['code'];
    if (typeof codeValue === 'string' || typeof codeValue === 'number') {
      result.code = String(codeValue);
    }
  }

  // Extract upstream trace ID if present
  for (const field of TRACE_ID_FIELDS) {
    if (field in obj && obj[field] !== undefined) {
      result.upstreamTraceId = String(obj[field]);
      break;
    }
  }

  // Try to extract message from known fields
  for (const field of ERROR_MESSAGE_FIELDS) {
    if (field in obj && obj[field] !== undefined) {
      const value = obj[field];

      // Handle nested error objects like { error: { message: "..." } }
      if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        const nested = normalizeUpstreamError(value);
        if (nested.message) {
          result.message = nested.message;
          result.upstreamTraceId = result.upstreamTraceId ?? nested.upstreamTraceId;
          break;
        }
      } else if (typeof value === 'string' && value.trim()) {
        result.message = value.trim();
        break;
      } else if (value !== null && value !== undefined) {
        // Non-string, non-null value - stringify it
        result.message = safeStringify(value);
        break;
      }
    }
  }

  // If no message found, try to create a meaningful summary
  if (!result.message) {
    // Check for status/statusCode fields
    if ('status' in obj || 'statusCode' in obj) {
      const status = obj['status'] ?? obj['statusCode'];
      result.message = `HTTP error ${status}`;
      if (result.code) {
        result.message += ` (${result.code})`;
      }
    } else if (result.code) {
      result.message = `Error code: ${result.code}`;
    } else {
      // Last resort: stringify the entire object
      result.message = safeStringify(obj);
    }
  }

  // Prepend error code to message if present and not already included
  if (result.code && !result.message.includes(result.code)) {
    result.message = `[${result.code}] ${result.message}`;
  }

  return result;
}

/**
 * Safely stringify a value, handling circular references and large objects.
 * Never returns [object Object].
 */
export function safeStringify(value: unknown, maxLength = 500): string {
  try {
    const str = JSON.stringify(value, null, 0);
    if (str.length > maxLength) {
      return str.slice(0, maxLength) + '... (truncated)';
    }
    return str;
  } catch {
    // Handle circular references or other stringify failures
    if (typeof value === 'object' && value !== null) {
      const keys = Object.keys(value as object);
      if (keys.length === 0) {
        return 'Empty error object';
      }
      return `Object with keys: ${keys.slice(0, 10).join(', ')}${keys.length > 10 ? '...' : ''}`;
    }
    return 'Unstringifiable error value';
  }
}

// Re-export types for use by other modules
export type { AdapterResponse, EndpointConfig } from '../types/index.js';

// ============================================================================
// Interface Definition
// ============================================================================

export interface IDownstreamAdapter {
  invoke(request: AdapterRequest): Promise<AdapterResponse>;
  health(): Promise<HealthStatus>;
  getEndpointConfig(): EndpointConfig;
}

// ============================================================================
// Debug Logging Configuration
// ============================================================================

/**
 * Check if debug logging is enabled via environment variable.
 * Set AGENTICS_DEBUG=true to enable detailed request/response logging.
 */
function isDebugEnabled(): boolean {
  const debug = process.env['AGENTICS_DEBUG'];
  return debug === 'true' || debug === '1';
}

/**
 * Map of service names to their corresponding environment variable names.
 */
const SERVICE_ENV_VAR_MAP: Record<string, string> = {
  'agentics-org-manifests': 'AGENTICS_MANIFESTS_URL',
  'agentics-simulation-planner': 'AGENTICS_PLANNER_URL',
  'agentics-simulation-runner': 'AGENTICS_RUNNER_URL',
  'agentics-simulation-engine': 'AGENTICS_SIMULATION_ENGINE_URL',
  'enterprise-roi-engine': 'ENTERPRISE_ROI_ENGINE_URL',
  'agentics-deployment-intent': 'AGENTICS_INTENT_URL',
  'agentics-deployment-exporters': 'AGENTICS_EXPORTERS_URL',
  'diligence-artifacts': 'DILIGENCE_URL',
};

/**
 * Determine the source of the endpoint URL (env var or default).
 */
function getEndpointSource(serviceName: string, baseUrl: string): string {
  const envVarName = SERVICE_ENV_VAR_MAP[serviceName];
  if (!envVarName) {
    return 'default (unknown service)';
  }

  const envValue = process.env[envVarName];
  if (envValue && envValue === baseUrl) {
    return `env:${envVarName}`;
  }
  return 'default (hardcoded)';
}

// ============================================================================
// Base Adapter Implementation
// ============================================================================

export class BaseAdapter implements IDownstreamAdapter {
  protected readonly config: EndpointConfig;
  protected readonly serviceName: string;
  protected readonly correlationId?: string;

  constructor(options: {
    serviceName: string;
    config: EndpointConfig;
    correlationId?: string;
  }) {
    this.serviceName = options.serviceName;
    this.config = options.config;
    this.correlationId = options.correlationId;
  }

  async invoke(request: AdapterRequest): Promise<AdapterResponse> {
    const startTime = Date.now();
    const url = `${this.config.baseUrl}${request.endpoint}`;
    const timeout = request.timeout ?? this.config.timeout;
    const debug = isDebugEnabled();

    // ========================================================================
    // PRE-REQUEST DEBUG LOGGING
    // ========================================================================
    if (debug) {
      const endpointSource = getEndpointSource(this.serviceName, this.config.baseUrl);
      console.error('\n╔══════════════════════════════════════════════════════════════════════════');
      console.error('║ [AGENTICS DEBUG] PRE-REQUEST');
      console.error('╠══════════════════════════════════════════════════════════════════════════');
      console.error(`║ Service Name:     ${this.serviceName}`);
      console.error(`║ Endpoint Source:  ${endpointSource}`);
      console.error(`║ Base URL:         ${this.config.baseUrl}`);
      console.error(`║ Full URL:         ${url}`);
      console.error(`║ Method:           ${request.method}`);
      console.error(`║ Correlation ID:   ${this.correlationId ?? 'N/A'}`);
      console.error(`║ Timeout:          ${timeout}ms`);
      console.error('╚══════════════════════════════════════════════════════════════════════════\n');
    }

    // Create abort controller for timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
      const response = await fetch(url, {
        method: request.method,
        headers: {
          'Content-Type': 'application/json',
          'X-Correlation-ID': this.correlationId ?? crypto.randomUUID(),
          'X-API-Version': this.config.version,
          ...request.headers,
        },
        body: request.body ? JSON.stringify(request.body) : undefined,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      const timing = Date.now() - startTime;

      // Get response body - PASSTHROUGH, no interpretation
      let body: unknown;
      const contentType = response.headers.get('content-type') ?? '';

      if (contentType.includes('application/json')) {
        body = await response.json();
      } else {
        body = await response.text();
      }

      // ======================================================================
      // POST-REQUEST DEBUG LOGGING (BEFORE any validation or transformation)
      // ======================================================================
      if (debug) {
        const rawBodyStr = typeof body === 'string' ? body : JSON.stringify(body, null, 2);
        const hasExecutionMetadata = typeof body === 'object' && body !== null && 'execution_metadata' in body;
        console.error('\n╔══════════════════════════════════════════════════════════════════════════');
        console.error('║ [AGENTICS DEBUG] POST-REQUEST - RAW UPSTREAM RESPONSE');
        console.error('╠══════════════════════════════════════════════════════════════════════════');
        console.error(`║ Service Name:         ${this.serviceName}`);
        console.error(`║ Full URL:             ${url}`);
        console.error(`║ HTTP Status:          ${response.status} ${response.statusText}`);
        console.error(`║ Content-Type:         ${contentType}`);
        console.error(`║ Timing:               ${timing}ms`);
        console.error(`║ Has execution_metadata: ${hasExecutionMetadata}`);
        console.error('╠──────────────────────────────────────────────────────────────────────────');
        console.error('║ RAW RESPONSE BODY:');
        console.error('╠──────────────────────────────────────────────────────────────────────────');
        // Print body with indentation
        const bodyLines = rawBodyStr.split('\n');
        for (const line of bodyLines) {
          console.error(`║ ${line}`);
        }
        console.error('╚══════════════════════════════════════════════════════════════════════════\n');
      }

      // Check for error status codes - surface error, no retry
      if (!response.ok) {
        // Normalize upstream error to extract meaningful message
        const normalized = normalizeUpstreamError(body);

        throw new ServiceError({
          service: this.serviceName,
          operation: request.endpoint,
          type: response.status >= 500 ? 'internal_error' : 'unavailable',
          statusCode: response.status,
          upstreamMessage: normalized.message,
          correlationId: normalized.upstreamTraceId ?? this.correlationId,
        });
      }

      // Return raw response - NO transformation
      return {
        status: response.status,
        headers: Object.fromEntries(response.headers.entries()),
        body, // Raw passthrough - never parsed by CLI
        timing,
      };
    } catch (error) {
      clearTimeout(timeoutId);

      // Handle abort (timeout)
      if (error instanceof Error && error.name === 'AbortError') {
        throw new ServiceError({
          service: this.serviceName,
          operation: request.endpoint,
          type: 'timeout',
          upstreamMessage: `Request timed out after ${timeout}ms`,
          correlationId: this.correlationId,
        });
      }

      // Handle network errors
      if (error instanceof TypeError) {
        throw new ServiceError({
          service: this.serviceName,
          operation: request.endpoint,
          type: 'unavailable',
          upstreamMessage: `Network error: ${error.message}`,
          correlationId: this.correlationId,
        });
      }

      // Re-throw CLIErrors as-is
      throw error;
    }
  }

  async health(): Promise<HealthStatus> {
    const startTime = Date.now();

    try {
      const response = await this.invoke({
        endpoint: '/health',
        method: 'GET',
        headers: {},
        timeout: 5000, // Health check has short timeout
      });

      return {
        healthy: response.status === 200,
        latency: Date.now() - startTime,
        version: this.config.version,
      };
    } catch {
      return {
        healthy: false,
        latency: Date.now() - startTime,
        version: this.config.version,
      };
    }
  }

  getEndpointConfig(): EndpointConfig {
    return { ...this.config };
  }
}

// ============================================================================
// Service-Specific Adapters
// ============================================================================

export class ManifestsAdapter extends BaseAdapter {
  constructor(config: EndpointConfig, correlationId?: string) {
    super({
      serviceName: 'agentics-org-manifests',
      config,
      correlationId,
    });
  }

  async select(criteria: unknown): Promise<AdapterResponse> {
    return this.invoke({
      endpoint: '/v1/manifests',
      method: 'POST',
      headers: {},
      body: criteria,
    });
  }
}

export class PlannerAdapter extends BaseAdapter {
  constructor(config: EndpointConfig, correlationId?: string) {
    super({
      serviceName: 'agentics-simulation-planner',
      config,
      correlationId,
    });
  }

  async createPlan(manifestRef: unknown, params: unknown): Promise<AdapterResponse> {
    return this.invoke({
      endpoint: '/v1/plans',
      method: 'POST',
      headers: {},
      body: { manifest_ref: manifestRef, params },
    });
  }
}

export class RunnerAdapter extends BaseAdapter {
  constructor(config: EndpointConfig, correlationId?: string) {
    super({
      serviceName: 'agentics-simulation-runner',
      config,
      correlationId,
    });
  }

  async execute(planRef: unknown, config: unknown): Promise<AdapterResponse> {
    return this.invoke({
      endpoint: '/v1/runner',
      method: 'POST',
      headers: {},
      body: { plan_ref: planRef, config },
    });
  }
}

export class IntentAdapter extends BaseAdapter {
  constructor(config: EndpointConfig, correlationId?: string) {
    super({
      serviceName: 'agentics-deployment-intent',
      config,
      correlationId,
    });
  }

  async resolve(simRef: unknown, spec: unknown): Promise<AdapterResponse> {
    return this.invoke({
      endpoint: '/v1/intent',
      method: 'POST',
      headers: {},
      body: { sim_ref: simRef, spec },
    });
  }
}

export class ExportersAdapter extends BaseAdapter {
  constructor(config: EndpointConfig, correlationId?: string) {
    super({
      serviceName: 'agentics-deployment-exporters',
      config,
      correlationId,
    });
  }

  async generate(intentRef: unknown, formatSpec: unknown): Promise<AdapterResponse> {
    return this.invoke({
      endpoint: '/v1/exporters',
      method: 'POST',
      headers: {},
      body: { intent_ref: intentRef, format_spec: formatSpec },
    });
  }
}

export class DiligenceAdapter extends BaseAdapter {
  constructor(config: EndpointConfig, correlationId?: string) {
    super({
      serviceName: 'diligence-artifacts',
      config,
      correlationId,
    });
  }

  async package(refs: unknown[], requirements: unknown): Promise<AdapterResponse> {
    return this.invoke({
      endpoint: '/v1/diligence',
      method: 'POST',
      headers: {},
      body: { refs, requirements },
    });
  }
}

export class SimulationEngineAdapter extends BaseAdapter {
  constructor(config: EndpointConfig, correlationId?: string) {
    super({
      serviceName: 'agentics-simulation-engine',
      config,
      correlationId,
    });
  }

  async inspect(simRef: unknown, outputType: string): Promise<AdapterResponse> {
    return this.invoke({
      endpoint: '/v1/simulate',
      method: 'POST',
      headers: {},
      body: { sim_ref: simRef, output_type: outputType },
    });
  }

  async getOutputs(simRef: unknown): Promise<AdapterResponse> {
    return this.invoke({
      endpoint: '/v1/simulate',
      method: 'POST',
      headers: {},
      body: { sim_ref: simRef },
    });
  }
}

export class RoiEngineAdapter extends BaseAdapter {
  constructor(config: EndpointConfig, correlationId?: string) {
    super({
      serviceName: 'enterprise-roi-engine',
      config,
      correlationId,
    });
  }

  async quantify(simRef: unknown, reportType: string, params?: unknown): Promise<AdapterResponse> {
    return this.invoke({
      endpoint: '/v1/roi',
      method: 'POST',
      headers: {},
      body: { sim_ref: simRef, report_type: reportType, params: params ?? {} },
    });
  }

  async getSummary(simRef: unknown): Promise<AdapterResponse> {
    return this.invoke({
      endpoint: '/v1/roi',
      method: 'POST',
      headers: {},
      body: { sim_ref: simRef },
    });
  }
}

// ============================================================================
// Adapter Factory
// ============================================================================

export type ServiceName =
  | 'agentics-org-manifests'
  | 'agentics-simulation-planner'
  | 'agentics-simulation-runner'
  | 'agentics-simulation-engine'
  | 'enterprise-roi-engine'
  | 'agentics-deployment-intent'
  | 'agentics-deployment-exporters'
  | 'diligence-artifacts';

export function createAdapter(
  serviceName: ServiceName,
  config: EndpointConfig,
  correlationId?: string
): IDownstreamAdapter {
  switch (serviceName) {
    case 'agentics-org-manifests':
      return new ManifestsAdapter(config, correlationId);
    case 'agentics-simulation-planner':
      return new PlannerAdapter(config, correlationId);
    case 'agentics-simulation-runner':
      return new RunnerAdapter(config, correlationId);
    case 'agentics-simulation-engine':
      return new SimulationEngineAdapter(config, correlationId);
    case 'enterprise-roi-engine':
      return new RoiEngineAdapter(config, correlationId);
    case 'agentics-deployment-intent':
      return new IntentAdapter(config, correlationId);
    case 'agentics-deployment-exporters':
      return new ExportersAdapter(config, correlationId);
    case 'diligence-artifacts':
      return new DiligenceAdapter(config, correlationId);
    default:
      throw new Error(`Unknown service: ${serviceName}`);
  }
}
