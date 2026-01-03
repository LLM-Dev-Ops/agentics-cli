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

      // Check for error status codes - surface error, no retry
      if (!response.ok) {
        throw new ServiceError({
          service: this.serviceName,
          operation: request.endpoint,
          type: response.status >= 500 ? 'internal_error' : 'unavailable',
          statusCode: response.status,
          upstreamMessage: typeof body === 'object' && body !== null && 'message' in body
            ? String((body as { message: unknown }).message)
            : String(body),
          correlationId: this.correlationId,
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
      endpoint: '/api/v1/manifests/select',
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
      endpoint: '/api/v1/plans/create',
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
      endpoint: '/api/v1/simulations/execute',
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
      endpoint: '/api/v1/intents/resolve',
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
      endpoint: '/api/v1/exports/generate',
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
      endpoint: '/api/v1/diligence/package',
      method: 'POST',
      headers: {},
      body: { refs, requirements },
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
