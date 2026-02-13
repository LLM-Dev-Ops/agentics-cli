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

import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
  AdapterRequest,
  AdapterResponse,
  HealthStatus,
  EndpointConfig,
  ActiveDownstreamCall,
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

// ============================================================================
// Downstream Call Tracking (Statusline Integration)
// ============================================================================

const CALLS_DIR = path.join(process.env['HOME'] ?? '/tmp', '.agentics', 'calls');

/**
 * Write a tracking file before an HTTP call. Non-blocking, failure-tolerant.
 * Returns the tracking file path (or undefined if write failed).
 */
function writeCallTracker(
  trackingId: string,
  serviceName: string,
  endpoint: string,
  method: string,
  correlationId?: string,
): string | undefined {
  try {
    fs.mkdirSync(CALLS_DIR, { recursive: true });
    const filePath = path.join(CALLS_DIR, `${trackingId}.json`);
    const data: ActiveDownstreamCall = {
      service: serviceName,
      endpoint,
      method,
      started_at: new Date().toISOString(),
      correlation_id: correlationId,
    };
    fs.writeFileSync(filePath, JSON.stringify(data), 'utf-8');
    return filePath;
  } catch {
    return undefined;
  }
}

/**
 * Remove a tracking file after an HTTP call completes (success or failure).
 */
function removeCallTracker(filePath: string | undefined): void {
  if (!filePath) return;
  try {
    fs.unlinkSync(filePath);
  } catch {
    // File may already be gone; ignore
  }
}

/**
 * Map of service names to their corresponding environment variable names.
 */
const SERVICE_ENV_VAR_MAP: Record<string, string> = {
  'agentics-org-manifests': 'AGENTICS_MANIFESTS_URL',
  'agentics-simulation-planner': 'AGENTICS_PLANNER_URL',
  'agentics-simulation-runner': 'AGENTICS_RUNNER_URL',
  'agentics-simulation-engine': 'AGENTICS_SIMULATION_ENGINE_URL',
  'agentics-results-index': 'AGENTICS_RESULTS_INDEX_URL',
  'enterprise-roi-engine': 'ENTERPRISE_ROI_ENGINE_URL',
  'agentics-deployment-intent': 'AGENTICS_INTENT_URL',
  'agentics-deployment-exporters': 'AGENTICS_EXPORTERS_URL',
  'diligence-artifacts': 'DILIGENCE_URL',
  'ruvector-service': 'RUVECTOR_SERVICE_URL',
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

    // Write call tracking file for statusline visibility
    const trackingId = crypto.randomUUID();
    const trackerPath = writeCallTracker(
      trackingId,
      this.serviceName,
      request.endpoint,
      request.method,
      this.correlationId,
    );

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
      console.error(`║ Auth: Platform API Key`);
      console.error('╚══════════════════════════════════════════════════════════════════════════\n');
    }

    // Create abort controller for timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
      // Build headers with identity token if available
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'X-Correlation-ID': this.correlationId ?? crypto.randomUUID(),
        'X-API-Version': this.config.version,
        ...request.headers,
      };


      const response = await fetch(url, {
        method: request.method,
        headers,
        body: request.body ? JSON.stringify(request.body) : undefined,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);
      removeCallTracker(trackerPath);

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
      removeCallTracker(trackerPath);

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

    // No silent error handling — CLI must fail loudly when upstream services fail.
    const response = await this.invoke({
      endpoint: '/health',
      method: 'GET',
      headers: {},
      timeout: 5000,
    });

    if (response.status !== 200) {
      throw new ServiceError({
        service: this.serviceName,
        operation: '/health',
        type: 'unavailable',
        statusCode: response.status,
        upstreamMessage: `Health check returned status ${response.status}`,
        correlationId: this.correlationId,
      });
    }

    return {
      healthy: true,
      latency: Date.now() - startTime,
      version: this.config.version,
    };
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

export class ResultsIndexAdapter extends BaseAdapter {
  constructor(config: EndpointConfig, correlationId?: string) {
    super({
      serviceName: 'agentics-results-index',
      config,
      correlationId,
    });
  }

  /**
   * Query simulation results from the results index.
   * This is a read-only operation using HTTP GET.
   *
   * @param queryParams - Structured query parameters (environment, status, limit, order)
   * @returns AdapterResponse with results array
   */
  async query(queryParams: {
    environment?: string;
    status?: string;
    limit?: number;
    order?: 'newest' | 'oldest';
    id?: string;
  }): Promise<AdapterResponse> {
    // Build query string from params
    const params = new URLSearchParams();
    if (queryParams.environment) params.set('environment', queryParams.environment);
    if (queryParams.status) params.set('status', queryParams.status);
    if (queryParams.limit) params.set('limit', queryParams.limit.toString());
    if (queryParams.order) params.set('order', queryParams.order);
    if (queryParams.id) params.set('id', queryParams.id);

    const queryString = params.toString();
    const endpoint = queryString ? `/v1/results?${queryString}` : '/v1/results';

    return this.invoke({
      endpoint,
      method: 'GET',
      headers: {},
    });
  }
}

/**
 * Ruvector Service Adapter
 *
 * Persistent storage for plans. Plans are generated once by the planner
 * and persisted in Ruvector; inspection is retrieval-only.
 */
export class RuvectorAdapter extends BaseAdapter {
  constructor(config: EndpointConfig, correlationId?: string) {
    super({
      serviceName: 'ruvector-service',
      config,
      correlationId,
    });
  }

  /**
   * Store a plan in Ruvector.
   * Persistence is mandatory - failure to persist is a command failure.
   */
  async storePlan(plan: {
    id: string;
    type: 'plan';
    intent: string;
    plan: unknown;
    created_at: string;
    org_id: string;
    user_id: string;
    checksum: string;
  }): Promise<AdapterResponse> {
    return this.invoke({
      endpoint: '/v1/plans',
      method: 'POST',
      headers: {},
      body: plan,
    });
  }

  /**
   * Retrieve a plan by ID from Ruvector.
   * This is retrieval-only - never triggers planning.
   */
  async getPlan(planId: string): Promise<AdapterResponse> {
    return this.invoke({
      endpoint: `/v1/plans/${planId}`,
      method: 'GET',
      headers: {},
    });
  }

  /**
   * List plans with optional filters.
   */
  async listPlans(params?: {
    org_id?: string;
    limit?: number;
    offset?: number;
  }): Promise<AdapterResponse> {
    const queryParams = new URLSearchParams();
    if (params?.org_id) queryParams.set('org_id', params.org_id);
    if (params?.limit) queryParams.set('limit', params.limit.toString());
    if (params?.offset) queryParams.set('offset', params.offset.toString());

    const queryString = queryParams.toString();
    const endpoint = queryString ? `/v1/plans?${queryString}` : '/v1/plans';

    return this.invoke({
      endpoint,
      method: 'GET',
      headers: {},
    });
  }

  /**
   * Delete a plan from Ruvector.
   */
  async deletePlan(planId: string): Promise<AdapterResponse> {
    return this.invoke({
      endpoint: `/v1/plans/${planId}`,
      method: 'DELETE',
      headers: {},
    });
  }

  // ==========================================================================
  // Deployment Storage Methods
  // ==========================================================================

  /**
   * Store a deployment in Ruvector.
   */
  async storeDeployment(deployment: {
    id: string;
    target_id: string;
    environment: string;
    status: string;
    preview: unknown;
    execution: unknown;
    created_at: string;
    updated_at: string;
    version: number;
    metadata?: Record<string, unknown>;
  }): Promise<AdapterResponse> {
    return this.invoke({
      endpoint: '/v1/deployments',
      method: 'POST',
      headers: {},
      body: deployment,
    });
  }

  /**
   * Retrieve a deployment by ID from Ruvector.
   */
  async getDeployment(deploymentId: string): Promise<AdapterResponse> {
    return this.invoke({
      endpoint: `/v1/deployments/${deploymentId}`,
      method: 'GET',
      headers: {},
    });
  }

  /**
   * Update a deployment in Ruvector.
   */
  async updateDeployment(deploymentId: string, updates: {
    status?: string;
    execution?: unknown;
    updated_at: string;
    version: number;
  }): Promise<AdapterResponse> {
    return this.invoke({
      endpoint: `/v1/deployments/${deploymentId}`,
      method: 'PUT',
      headers: {},
      body: updates,
    });
  }

  /**
   * List deployments with optional filters.
   */
  async listDeployments(params?: {
    environment?: string;
    status?: string;
    limit?: number;
    offset?: number;
  }): Promise<AdapterResponse> {
    const queryParams = new URLSearchParams();
    if (params?.environment) queryParams.set('environment', params.environment);
    if (params?.status) queryParams.set('status', params.status);
    if (params?.limit) queryParams.set('limit', params.limit.toString());
    if (params?.offset) queryParams.set('offset', params.offset.toString());

    const queryString = queryParams.toString();
    const endpoint = queryString ? `/v1/deployments?${queryString}` : '/v1/deployments';

    return this.invoke({
      endpoint,
      method: 'GET',
      headers: {},
    });
  }

  /**
   * Delete a deployment from Ruvector.
   */
  async deleteDeployment(deploymentId: string): Promise<AdapterResponse> {
    return this.invoke({
      endpoint: `/v1/deployments/${deploymentId}`,
      method: 'DELETE',
      headers: {},
    });
  }

  // ==========================================================================
  // Decision Storage Methods (Executive Synthesis Integration)
  // ==========================================================================

  /**
   * Store a decision record in Ruvector.
   * Used by executive synthesis to persist learning events.
   */
  async storeDecision(decision: {
    id: string;
    objective: string;
    command: string;
    raw_output_hash: string;
    recommendation: string;
    confidence: string;
    signals: {
      financial: string;
      risk: string;
      complexity: string;
    };
    embedding_text: string;
    graph_relations: {
      objective_to_repos: string[];
      repos_to_signals: Record<string, string[]>;
      signals_to_recommendation: string[];
    };
    created_at: string;
  }): Promise<AdapterResponse> {
    return this.invoke({
      endpoint: '/v1/decisions',
      method: 'POST',
      headers: {},
      body: decision,
    });
  }

  /**
   * Retrieve a decision by ID from Ruvector.
   */
  async getDecision(decisionId: string): Promise<AdapterResponse> {
    return this.invoke({
      endpoint: `/v1/decisions/${decisionId}`,
      method: 'GET',
      headers: {},
    });
  }

  /**
   * List decisions with optional filters.
   */
  async listDecisions(params?: {
    objective?: string;
    limit?: number;
    offset?: number;
  }): Promise<AdapterResponse> {
    const queryParams = new URLSearchParams();
    if (params?.objective) queryParams.set('objective', params.objective);
    if (params?.limit) queryParams.set('limit', params.limit.toString());
    if (params?.offset) queryParams.set('offset', params.offset.toString());

    const queryString = queryParams.toString();
    const endpoint = queryString ? `/v1/decisions?${queryString}` : '/v1/decisions';

    return this.invoke({
      endpoint,
      method: 'GET',
      headers: {},
    });
  }

  // ==========================================================================
  // ADR-004: Simulation Memory Methods (Invariant 1)
  // ==========================================================================

  /**
   * Store a simulation memory record in Ruvector.
   * Persistence is mandatory — a simulation without a memory footprint
   * is not a simulation (ADR-004, Invariant 1).
   */
  async storeSimulation(simulation: {
    id: string;
    type: 'simulation';
    intent: string;
    status: string;
    result?: unknown;
    attribution: { created_by: string; org_id: string };
    artifact_ids: string[];
    created_at: string;
    updated_at: string;
    checksum: string;
  }): Promise<AdapterResponse> {
    return this.invoke({
      endpoint: '/v1/simulations',
      method: 'POST',
      headers: {},
      body: simulation,
    });
  }

  /**
   * Retrieve a simulation by ID from Ruvector.
   */
  async getSimulation(simulationId: string): Promise<AdapterResponse> {
    return this.invoke({
      endpoint: `/v1/simulations/${simulationId}`,
      method: 'GET',
      headers: {},
    });
  }

  /**
   * Update a simulation record in Ruvector.
   */
  async updateSimulation(simulationId: string, updates: {
    status?: string;
    result?: unknown;
    artifact_ids?: string[];
    updated_at: string;
    checksum: string;
  }): Promise<AdapterResponse> {
    return this.invoke({
      endpoint: `/v1/simulations/${simulationId}`,
      method: 'PUT',
      headers: {},
      body: updates,
    });
  }

  /**
   * List simulations with optional filters.
   */
  async listSimulations(params?: {
    org_id?: string;
    status?: string;
    limit?: number;
    offset?: number;
  }): Promise<AdapterResponse> {
    const queryParams = new URLSearchParams();
    if (params?.org_id) queryParams.set('org_id', params.org_id);
    if (params?.status) queryParams.set('status', params.status);
    if (params?.limit) queryParams.set('limit', params.limit.toString());
    if (params?.offset) queryParams.set('offset', params.offset.toString());

    const queryString = queryParams.toString();
    const endpoint = queryString ? `/v1/simulations?${queryString}` : '/v1/simulations';

    return this.invoke({
      endpoint,
      method: 'GET',
      headers: {},
    });
  }

  // ==========================================================================
  // ADR-004: Lineage Methods (Invariants 2, 3)
  // ==========================================================================

  /**
   * Store a lineage record in Ruvector.
   * Every artifact must have a lineage record linking it to a simulation.
   */
  async storeLineage(lineage: {
    id: string;
    artifact_id: string;
    artifact_category: string;
    simulation_id: string;
    plan_id?: string;
    decision_context: string;
    attribution: { created_by: string; org_id: string };
    governance: { gate_pipeline_version: string; synthesis_classification: string };
    created_at: string;
  }): Promise<AdapterResponse> {
    return this.invoke({
      endpoint: '/v1/lineage',
      method: 'POST',
      headers: {},
      body: lineage,
    });
  }

  /**
   * Query lineage forward: what artifacts did this simulation produce?
   */
  async queryLineageForward(simulationId: string): Promise<AdapterResponse> {
    return this.invoke({
      endpoint: `/v1/lineage/simulation/${simulationId}/artifacts`,
      method: 'GET',
      headers: {},
    });
  }

  /**
   * Query lineage backward: what simulation created this artifact?
   */
  async queryLineageBackward(artifactId: string): Promise<AdapterResponse> {
    return this.invoke({
      endpoint: `/v1/lineage/artifact/${artifactId}`,
      method: 'GET',
      headers: {},
    });
  }

  // ==========================================================================
  // ADR-004: Integration Proposal Methods (Invariant 5)
  // ==========================================================================

  /**
   * Store an integration proposal in Ruvector.
   * Proposals describe what would change, not what has changed.
   */
  async storeIntegrationProposal(proposal: {
    id: string;
    type: 'integration_proposal';
    integration_name: string;
    proposed_changes: string;
    risks: string[];
    dependencies: string[];
    simulation_id: string;
    plan_id?: string;
    attribution: { created_by: string; org_id: string };
    created_at: string;
  }): Promise<AdapterResponse> {
    return this.invoke({
      endpoint: '/v1/integration-proposals',
      method: 'POST',
      headers: {},
      body: proposal,
    });
  }

  /**
   * List integration proposals for a simulation.
   */
  async listIntegrationProposals(simulationId: string): Promise<AdapterResponse> {
    return this.invoke({
      endpoint: `/v1/integration-proposals?simulation_id=${simulationId}`,
      method: 'GET',
      headers: {},
    });
  }

  // ==========================================================================
  // ADR-004: ERP Surface Mapping Methods (Invariant 6)
  // ==========================================================================

  /**
   * Store an ERP Surface mapping in Ruvector.
   * ERP Surface reflects proposed state, not live mutation.
   */
  async storeErpMapping(mapping: {
    id: string;
    type: 'erp_mapping';
    erp_type: string;
    entity_type: string;
    proposed_implementation: unknown;
    simulation_id: string;
    integration_proposal_ids: string[];
    attribution: { created_by: string; org_id: string };
    created_at: string;
  }): Promise<AdapterResponse> {
    return this.invoke({
      endpoint: '/v1/erp-mappings',
      method: 'POST',
      headers: {},
      body: mapping,
    });
  }

  /**
   * List ERP mappings for a simulation.
   */
  async listErpMappings(simulationId: string): Promise<AdapterResponse> {
    return this.invoke({
      endpoint: `/v1/erp-mappings?simulation_id=${simulationId}`,
      method: 'GET',
      headers: {},
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
  | 'agentics-results-index'
  | 'enterprise-roi-engine'
  | 'agentics-deployment-intent'
  | 'agentics-deployment-exporters'
  | 'diligence-artifacts'
  | 'ruvector-service';

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
    case 'agentics-results-index':
      return new ResultsIndexAdapter(config, correlationId);
    case 'enterprise-roi-engine':
      return new RoiEngineAdapter(config, correlationId);
    case 'agentics-deployment-intent':
      return new IntentAdapter(config, correlationId);
    case 'agentics-deployment-exporters':
      return new ExportersAdapter(config, correlationId);
    case 'diligence-artifacts':
      return new DiligenceAdapter(config, correlationId);
    case 'ruvector-service':
      return new RuvectorAdapter(config, correlationId);
    default:
      throw new Error(`Unknown service: ${serviceName}`);
  }
}
