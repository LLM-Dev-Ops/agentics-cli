/**
 * Inspect Command - Standalone Read-Only HTTP Command
 *
 * ARCHITECTURE:
 * - This is a TERMINAL command with its own control flow
 * - Does NOT participate in orchestration, retrieval, or execution pipelines
 * - Issues direct HTTP GET requests to agentics-results-index
 * - Has its own error handling and exit codes
 * - No code path can fall through to simulation, planner, or execution services
 *
 * ROUTING:
 * - Routes EXCLUSIVELY to agentics-results-index
 * - NO routing to execution, planning, or simulation services
 * - Read-only operation - performs NO mutations
 */

import type {
  CommandOptions,
  FlexibleInput,
  NaturalLanguageInput,
} from '../types/index.js';
import { isNaturalLanguage } from '../types/index.js';
import { CLIError } from '../errors/index.js';
import { validateResultPacket } from '../contracts/canonical.js';

// ============================================================================
// Inspect-Specific Exit Codes
// ============================================================================

export const INSPECT_EXIT_CODES = {
  SUCCESS: 0,
  INPUT_ERROR: 100,
  SERVICE_UNAVAILABLE: 69,
  TIMEOUT: 75,
  NETWORK_ERROR: 120,
  UNEXPECTED_ERROR: 1,
} as const;

// ============================================================================
// Query Parameter Types
// ============================================================================

export interface ResultsQueryParams {
  environment?: 'production' | 'staging' | 'development' | 'local';
  status?: 'completed' | 'failed' | 'running' | 'pending';
  limit?: number;
  order?: 'newest' | 'oldest';
  id?: string;
}

// ============================================================================
// Result Types
// ============================================================================

/**
 * SimulationResult — aligned with canonical result_packet from agentics-contracts.
 * Fields use contract-canonical names. Do NOT rename keys.
 */
export interface SimulationResult {
  execution_id: string;
  status: string;
  environment: string;
  created_at: string;
  completed_at?: string;
  duration_ms?: number;
  summary?: string;
  metrics?: Record<string, unknown>;
  execution_metadata: {
    trace_id: string;
    timestamp: string;
    service: string;
    [key: string]: unknown;
  };
  execution_graph?: Record<string, unknown>;
  /** @deprecated Use execution_id. Retained for backward compatibility only. */
  id?: string;
}

export interface InspectCommandResult {
  results: SimulationResult[];
  query: ResultsQueryParams;
  count: number;
  timing: number;
}

// ============================================================================
// Command Interface
// ============================================================================

export interface InspectCommandInput {
  simRef: FlexibleInput<{ id: string }>;
  depth?: 'summary' | 'detailed' | 'full';
  includeMetrics?: boolean;
  includeTraces?: boolean;
}

// ============================================================================
// Inspect Subcommand Types
// ============================================================================

export interface InspectLatestInput {
  environment?: 'production' | 'staging' | 'development' | 'local';
  status?: 'completed' | 'failed' | 'running' | 'pending';
}

export interface InspectLatestResult {
  result: SimulationResult | null;
  found: boolean;
  timing: number;
}

export interface InspectRunInput {
  id: string;
}

export interface InspectRunResult {
  result: SimulationResult | null;
  found: boolean;
  timing: number;
}

// ============================================================================
// Endpoint Configuration (Standalone - No Shared Config)
// ============================================================================

/**
 * Get the results-index endpoint URL.
 * Uses environment variable override or production default.
 */
function getResultsIndexUrl(): string {
  const envUrl = process.env['AGENTICS_RESULTS_INDEX_URL'];
  if (envUrl) {
    return envUrl;
  }
  return 'https://agentics-results-index-1062287243982.us-central1.run.app';
}

/**
 * Get the request timeout in milliseconds.
 */
function getRequestTimeout(): number {
  const envTimeout = process.env['AGENTICS_RESULTS_INDEX_TIMEOUT'];
  if (envTimeout) {
    const parsed = parseInt(envTimeout, 10);
    if (!isNaN(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return 30000; // 30 seconds default
}

// ============================================================================
// Natural Language Query Parser
// ============================================================================

/**
 * Translate free-form natural language input into structured query parameters.
 * Recognizes common patterns like "last production test", "latest run", etc.
 */
function parseNaturalLanguageQuery(description: string): ResultsQueryParams {
  const lower = description.toLowerCase().trim();
  const params: ResultsQueryParams = {
    order: 'newest', // Default to newest-first for all queries
    limit: 10, // Default limit
  };

  // Environment detection
  if (lower.includes('production') || lower.includes('prod')) {
    params.environment = 'production';
  } else if (lower.includes('staging') || lower.includes('stage')) {
    params.environment = 'staging';
  } else if (lower.includes('development') || lower.includes('dev')) {
    params.environment = 'development';
  } else if (/\btest\b/.test(lower) || lower.includes('local')) {
    params.environment = 'local';
  }

  // Status detection
  if (lower.includes('failed') || lower.includes('failure') || lower.includes('error')) {
    params.status = 'failed';
  } else if (lower.includes('completed') || lower.includes('success') || lower.includes('passed')) {
    params.status = 'completed';
  } else if (lower.includes('running') || lower.includes('in progress') || lower.includes('active')) {
    params.status = 'running';
  } else if (lower.includes('pending') || lower.includes('queued') || lower.includes('waiting')) {
    params.status = 'pending';
  }

  // Limit detection
  if (lower.includes('last') || lower.includes('latest') || lower.includes('most recent')) {
    // Check for specific numbers
    const numberMatch = lower.match(/last\s+(\d+)/);
    if (numberMatch && numberMatch[1]) {
      params.limit = Math.min(parseInt(numberMatch[1], 10), 100);
    } else {
      params.limit = 1; // "last" without number means just one
    }
  } else if (lower.includes('all')) {
    params.limit = 100; // Cap at 100 for safety
  }

  // Order detection (override default if explicitly specified)
  if (lower.includes('oldest') || lower.includes('first') || lower.includes('earliest')) {
    params.order = 'oldest';
  }

  return params;
}

// ============================================================================
// Input Validation (Standalone)
// ============================================================================

/**
 * Validate query parameters. Throws InspectError on invalid input.
 */
function validateQueryParams(params: ResultsQueryParams, correlationId?: string): void {
  // Validate limit
  if (params.limit !== undefined) {
    if (params.limit < 1) {
      throw new CLIError({
        code: 'ECLI-INSPECT-001',
        category: 'INPUT_ERROR',
        message: 'Query limit must be at least 1',
        details: { provided_limit: params.limit },
        module: 'inspect',
        correlationId,
        recoverable: false,
        exitCode: INSPECT_EXIT_CODES.INPUT_ERROR,
      });
    }
    if (params.limit > 100) {
      throw new CLIError({
        code: 'ECLI-INSPECT-002',
        category: 'INPUT_ERROR',
        message: 'Query limit cannot exceed 100 results',
        details: { provided_limit: params.limit, max_limit: 100 },
        module: 'inspect',
        correlationId,
        recoverable: false,
        exitCode: INSPECT_EXIT_CODES.INPUT_ERROR,
      });
    }
  }

  // Validate environment if provided (service supports: production, staging, development, local)
  const validEnvironments = ['production', 'staging', 'development', 'local', 'test'];
  if (params.environment && !validEnvironments.includes(params.environment)) {
    throw new CLIError({
      code: 'ECLI-INSPECT-003',
      category: 'INPUT_ERROR',
      message: `Invalid environment filter: ${params.environment}`,
      details: {
        provided: params.environment,
        valid_options: validEnvironments,
      },
      module: 'inspect',
      correlationId,
      recoverable: false,
      exitCode: INSPECT_EXIT_CODES.INPUT_ERROR,
    });
  }

  // Validate status if provided
  const validStatuses = ['completed', 'failed', 'running', 'pending'];
  if (params.status && !validStatuses.includes(params.status)) {
    throw new CLIError({
      code: 'ECLI-INSPECT-004',
      category: 'INPUT_ERROR',
      message: `Invalid status filter: ${params.status}`,
      details: {
        provided: params.status,
        valid_options: validStatuses,
      },
      module: 'inspect',
      correlationId,
      recoverable: false,
      exitCode: INSPECT_EXIT_CODES.INPUT_ERROR,
    });
  }

  // Validate order if provided
  const validOrders = ['newest', 'oldest'];
  if (params.order && !validOrders.includes(params.order)) {
    throw new CLIError({
      code: 'ECLI-INSPECT-005',
      category: 'INPUT_ERROR',
      message: `Invalid order: ${params.order}`,
      details: {
        provided: params.order,
        valid_options: validOrders,
      },
      module: 'inspect',
      correlationId,
      recoverable: false,
      exitCode: INSPECT_EXIT_CODES.INPUT_ERROR,
    });
  }
}

// ============================================================================
// Result Formatting
// ============================================================================

/**
 * Format simulation results for human-readable terminal output.
 */
export function formatResultsForDisplay(results: SimulationResult[]): string {
  if (results.length === 0) {
    return 'No simulation results found matching the query.';
  }

  const lines: string[] = [];
  lines.push(`Found ${results.length} result${results.length === 1 ? '' : 's'}:`);
  lines.push('');

  for (const result of results) {
    const statusIcon = getStatusIcon(result.status);
    const duration = result.duration_ms ? `${(result.duration_ms / 1000).toFixed(1)}s` : 'N/A';
    const completedAt = result.completed_at
      ? new Date(result.completed_at).toLocaleString()
      : 'In progress';

    lines.push(`${statusIcon} ${result.execution_id}`);
    lines.push(`   Environment: ${result.environment}`);
    lines.push(`   Status:      ${result.status}`);
    lines.push(`   Created:     ${new Date(result.created_at).toLocaleString()}`);
    lines.push(`   Completed:   ${completedAt}`);
    lines.push(`   Duration:    ${duration}`);
    if (result.summary) {
      lines.push(`   Summary:     ${result.summary}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

function getStatusIcon(status: string): string {
  switch (status) {
    case 'completed':
      return '[OK]';
    case 'failed':
      return '[FAIL]';
    case 'running':
      return '[...]';
    case 'pending':
      return '[WAIT]';
    default:
      return '[?]';
  }
}

// ============================================================================
// Direct HTTP Request (No Shared Adapter)
// ============================================================================

/**
 * Build the query URL for the results-index service.
 *
 * Service endpoints (from /api/v1):
 * - GET /api/v1/runs - list runs
 * - GET /api/v1/runs/last - latest run
 * - GET /api/v1/runs/:id - specific run by ID
 */
function buildQueryUrl(baseUrl: string, params: ResultsQueryParams): string {
  // If specific ID requested, use the direct ID endpoint
  if (params.id) {
    return new URL(`/api/v1/runs/${params.id}`, baseUrl).toString();
  }

  // For list queries, use /api/v1/runs with query params
  const url = new URL('/api/v1/runs', baseUrl);

  // Environment is required by the service - default to 'production'
  url.searchParams.set('environment', params.environment ?? 'production');

  if (params.status) {
    url.searchParams.set('status', params.status);
  }
  if (params.limit !== undefined) {
    url.searchParams.set('limit', params.limit.toString());
  }
  // Note: 'order' parameter not supported by service - results are returned newest-first by default

  return url.toString();
}

/**
 * Build the URL for the latest run endpoint.
 * Note: The results-index service requires 'environment' parameter.
 */
function buildLatestUrl(baseUrl: string, params: ResultsQueryParams): string {
  const url = new URL('/api/v1/runs/last', baseUrl);

  // Environment is required by the service - default to 'production'
  url.searchParams.set('environment', params.environment ?? 'production');

  if (params.status) {
    url.searchParams.set('status', params.status);
  }

  return url.toString();
}

/**
 * Execute a direct HTTP GET request to the results-index service.
 * This is a standalone implementation that does not use shared adapters.
 */
async function executeHttpGet(
  url: string,
  timeout: number,
  correlationId: string
): Promise<{ body: unknown; timing: number; status: number }> {
  const startTime = Date.now();
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'X-Correlation-ID': correlationId,
        'X-API-Version': 'v1',
      },
      signal: controller.signal,
    });

    clearTimeout(timeoutId);
    const timing = Date.now() - startTime;

    // Parse response body
    let body: unknown;
    const contentType = response.headers.get('content-type') ?? '';
    if (contentType.includes('application/json')) {
      body = await response.json();
    } else {
      body = await response.text();
    }

    return { body, timing, status: response.status };
  } catch (error) {
    clearTimeout(timeoutId);

    // Handle abort (timeout)
    if (error instanceof Error && error.name === 'AbortError') {
      throw new CLIError({
        code: 'ECLI-INSPECT-TIMEOUT',
        category: 'NETWORK_ERROR',
        message: `Request timed out after ${timeout}ms`,
        details: { timeout_ms: timeout },
        module: 'inspect',
        correlationId,
        recoverable: true,
        exitCode: INSPECT_EXIT_CODES.TIMEOUT,
      });
    }

    // Handle network errors
    if (error instanceof TypeError) {
      throw new CLIError({
        code: 'ECLI-INSPECT-NETWORK',
        category: 'NETWORK_ERROR',
        message: 'Unable to connect to the results service',
        details: { hint: 'Check your network connection and try again.' },
        module: 'inspect',
        correlationId,
        recoverable: true,
        exitCode: INSPECT_EXIT_CODES.NETWORK_ERROR,
      });
    }

    // Re-throw CLIErrors
    if (error instanceof CLIError) {
      throw error;
    }

    // Wrap unknown errors
    throw new CLIError({
      code: 'ECLI-INSPECT-UNKNOWN',
      category: 'INTERNAL_ERROR',
      message: error instanceof Error ? error.message : 'An unexpected error occurred',
      module: 'inspect',
      correlationId,
      recoverable: false,
      exitCode: INSPECT_EXIT_CODES.UNEXPECTED_ERROR,
    });
  }
}

// ============================================================================
// Inspect Command Implementation (Standalone Terminal Command)
// ============================================================================

/**
 * Execute the inspect command.
 *
 * This is a STANDALONE command that:
 * - Does NOT use shared orchestration, retrieval, or execution helpers
 * - Issues direct HTTP GET requests to agentics-results-index
 * - Has its own error handling with inspect-specific exit codes
 * - Cannot fall through to any other service
 */
export async function executeInspectCommand(
  input: InspectCommandInput,
  options: CommandOptions
): Promise<InspectCommandResult> {
  const correlationId = options.trace_id ?? crypto.randomUUID();
  const startTime = Date.now();

  // Get endpoint configuration (standalone - no shared config loader)
  const baseUrl = getResultsIndexUrl();
  const timeout = options.timeout ?? getRequestTimeout();

  // Build query parameters from input
  let queryParams: ResultsQueryParams;

  if (isNaturalLanguage(input.simRef)) {
    // Translate natural language to structured query
    const nlInput = input.simRef as NaturalLanguageInput;
    queryParams = parseNaturalLanguageQuery(nlInput.description);
  } else {
    // Structured input - extract ID if present
    const structuredInput = input.simRef as { id?: string };
    queryParams = {
      id: structuredInput.id,
      order: 'newest',
      limit: 1,
    };
  }

  // Validate query parameters (throws on error - no fall-through)
  validateQueryParams(queryParams, correlationId);

  // Build request URL
  const requestUrl = buildQueryUrl(baseUrl, queryParams);

  // Execute direct HTTP GET request (no shared adapter)
  const response = await executeHttpGet(requestUrl, timeout, correlationId);

  // Handle non-2xx responses
  if (response.status >= 400) {
    // Extract error message from response body if available
    let errorMessage = 'The results service returned an error';
    if (typeof response.body === 'object' && response.body !== null) {
      const body = response.body as Record<string, unknown>;
      if (typeof body['message'] === 'string') {
        errorMessage = body['message'];
      } else if (typeof body['error'] === 'string') {
        errorMessage = body['error'];
      }
    }

    if (response.status === 503 || response.status === 502 || response.status === 504) {
      throw new CLIError({
        code: 'ECLI-INSPECT-SERVICE-UNAVAILABLE',
        category: 'NETWORK_ERROR',
        message: 'The results service is currently unavailable. Please try again later.',
        details: { hint: 'The service may be temporarily down for maintenance.' },
        module: 'inspect',
        correlationId,
        recoverable: true,
        exitCode: INSPECT_EXIT_CODES.SERVICE_UNAVAILABLE,
      });
    }

    throw new CLIError({
      code: `ECLI-INSPECT-HTTP-${response.status}`,
      category: response.status >= 500 ? 'NETWORK_ERROR' : 'INPUT_ERROR',
      message: errorMessage,
      details: { http_status: response.status },
      module: 'inspect',
      correlationId,
      recoverable: response.status >= 500,
      exitCode: response.status >= 500
        ? INSPECT_EXIT_CODES.SERVICE_UNAVAILABLE
        : INSPECT_EXIT_CODES.INPUT_ERROR,
    });
  }

  // ============================================================================
  // CONTRACT VALIDATION — CLI assumes results-index returns canonical result_packet.
  // Do NOT reshape returned payload. Do NOT try multiple response formats.
  // ============================================================================
  const responseBody = response.body;

  // Results-index returns canonical format — extract results array directly
  let results: SimulationResult[];
  if (Array.isArray(responseBody)) {
    results = responseBody as SimulationResult[];
  } else if (typeof responseBody === 'object' && responseBody !== null && 'result_packet' in responseBody) {
    // Unwrap result_packet envelope added by results-index update
    const packet = (responseBody as Record<string, unknown>)['result_packet'];
    if (typeof packet === 'object' && packet !== null && 'results' in packet) {
      results = (packet as Record<string, unknown>)['results'] as SimulationResult[];
    } else {
      results = [];
    }
  } else if (typeof responseBody === 'object' && responseBody !== null && 'results' in responseBody) {
    results = (responseBody as Record<string, unknown>)['results'] as SimulationResult[];
  } else {
    throw new CLIError({
      code: 'ECLI-INSPECT-CONTRACT-001',
      category: 'DOWNSTREAM_ERROR',
      message: 'Results-index response does not conform to canonical result_packet format',
      details: {
        received_type: typeof responseBody,
        received_keys: typeof responseBody === 'object' && responseBody !== null
          ? Object.keys(responseBody)
          : [],
      },
      module: 'inspect',
      correlationId,
      recoverable: false,
      exitCode: INSPECT_EXIT_CODES.UNEXPECTED_ERROR,
    });
  }

  // Validate each result against the canonical result_packet schema
  for (const result of results) {
    validateResultPacket(result, correlationId);
  }

  // Return result - command terminates here
  return {
    results,
    query: queryParams,
    count: results.length,
    timing: Date.now() - startTime,
  };
}

// ============================================================================
// Inspect Latest Subcommand Implementation
// ============================================================================

/**
 * Execute the 'inspect latest' subcommand.
 * Returns the most recent simulation result matching the filters.
 * Uses the dedicated /api/v1/runs/last endpoint.
 */
export async function executeInspectLatestCommand(
  input: InspectLatestInput,
  options: CommandOptions
): Promise<InspectLatestResult> {
  const correlationId = options.trace_id ?? crypto.randomUUID();
  const startTime = Date.now();

  // Get endpoint configuration
  const baseUrl = getResultsIndexUrl();
  const timeout = options.timeout ?? getRequestTimeout();

  // Build query for latest result
  const queryParams: ResultsQueryParams = {
    order: 'newest',
    limit: 1,
    environment: input.environment,
    status: input.status,
  };

  // Validate query parameters
  validateQueryParams(queryParams, correlationId);

  // Build request URL - use dedicated latest endpoint
  const requestUrl = buildLatestUrl(baseUrl, queryParams);

  // Execute HTTP GET request
  const response = await executeHttpGet(requestUrl, timeout, correlationId);

  // Handle non-2xx responses
  if (response.status >= 400) {
    let errorMessage = 'The results service returned an error';
    if (typeof response.body === 'object' && response.body !== null) {
      const body = response.body as Record<string, unknown>;
      if (typeof body['message'] === 'string') {
        errorMessage = body['message'];
      } else if (typeof body['error'] === 'string') {
        errorMessage = body['error'];
      }
    }

    if (response.status === 503 || response.status === 502 || response.status === 504) {
      throw new CLIError({
        code: 'ECLI-INSPECT-SERVICE-UNAVAILABLE',
        category: 'NETWORK_ERROR',
        message: 'The results service is currently unavailable. Please try again later.',
        details: { hint: 'The service may be temporarily down for maintenance.' },
        module: 'inspect',
        correlationId,
        recoverable: true,
        exitCode: INSPECT_EXIT_CODES.SERVICE_UNAVAILABLE,
      });
    }

    throw new CLIError({
      code: `ECLI-INSPECT-HTTP-${response.status}`,
      category: response.status >= 500 ? 'NETWORK_ERROR' : 'INPUT_ERROR',
      message: errorMessage,
      details: { http_status: response.status },
      module: 'inspect',
      correlationId,
      recoverable: response.status >= 500,
      exitCode: response.status >= 500
        ? INSPECT_EXIT_CODES.SERVICE_UNAVAILABLE
        : INSPECT_EXIT_CODES.INPUT_ERROR,
    });
  }

  // ============================================================================
  // CONTRACT VALIDATION — CLI assumes results-index returns canonical result_packet.
  // Do NOT reshape returned payload. Do NOT try multiple response formats.
  // Empty response is NOT treated as success.
  // ============================================================================
  const responseBody = response.body;

  // Handle empty or null response explicitly
  if (responseBody === null || responseBody === undefined) {
    throw new CLIError({
      code: 'ECLI-INSPECT-EMPTY-001',
      category: 'DOWNSTREAM_ERROR',
      message: 'No contract-compliant execution found.',
      details: { endpoint: '/api/v1/runs/last' },
      module: 'inspect',
      correlationId,
      recoverable: false,
      exitCode: INSPECT_EXIT_CODES.UNEXPECTED_ERROR,
    });
  }

  // Extract the result from the canonical response format
  let latestResult: SimulationResult | null = null;

  if (typeof responseBody === 'object' && responseBody !== null) {
    const body = responseBody as Record<string, unknown>;

    // Unwrap result_packet envelope if present (new results-index format)
    if ('result_packet' in body) {
      const packet = body['result_packet'];
      if (packet === null || packet === undefined || body['found'] === false) {
        // No runs indexed — return empty result
        return { result: null, found: false, timing: Date.now() - startTime };
      }
      if (typeof packet === 'object' && 'execution_id' in (packet as Record<string, unknown>)) {
        validateResultPacket(packet as Record<string, unknown>, correlationId);
        latestResult = packet as unknown as SimulationResult;
      }
    }
    // Canonical format: result_packet object with execution_id
    else if ('execution_id' in body && typeof body['execution_id'] === 'string') {
      validateResultPacket(body, correlationId);
      latestResult = body as unknown as SimulationResult;
    }
    // Canonical list format: { results: [result_packet] }
    else if ('results' in body && Array.isArray(body['results'])) {
      const results = body['results'] as Record<string, unknown>[];
      if (results.length > 0 && results[0]) {
        validateResultPacket(results[0], correlationId);
        latestResult = results[0] as unknown as SimulationResult;
      }
    }
    // Empty object or no matching structure
    else if (Object.keys(body).length === 0) {
      throw new CLIError({
        code: 'ECLI-INSPECT-EMPTY-002',
        category: 'DOWNSTREAM_ERROR',
        message: 'No contract-compliant execution found.',
        details: { endpoint: '/api/v1/runs/last' },
        module: 'inspect',
        correlationId,
        recoverable: false,
        exitCode: INSPECT_EXIT_CODES.UNEXPECTED_ERROR,
      });
    }
  }

  if (latestResult === null) {
    throw new CLIError({
      code: 'ECLI-INSPECT-EMPTY-003',
      category: 'DOWNSTREAM_ERROR',
      message: 'No contract-compliant execution found.',
      details: { endpoint: '/api/v1/runs/last' },
      module: 'inspect',
      correlationId,
      recoverable: false,
      exitCode: INSPECT_EXIT_CODES.UNEXPECTED_ERROR,
    });
  }

  return {
    result: latestResult,
    found: true,
    timing: Date.now() - startTime,
  };
}

// ============================================================================
// Inspect Run Subcommand Implementation
// ============================================================================

/**
 * Execute the 'inspect run <id>' subcommand.
 * Returns a specific simulation result by ID.
 */
export async function executeInspectRunCommand(
  input: InspectRunInput,
  options: CommandOptions
): Promise<InspectRunResult> {
  const correlationId = options.trace_id ?? crypto.randomUUID();
  const startTime = Date.now();

  // Validate ID
  if (!input.id || typeof input.id !== 'string' || input.id.trim() === '') {
    throw new CLIError({
      code: 'ECLI-INSPECT-INVALID-ID',
      category: 'INPUT_ERROR',
      message: 'Run ID is required',
      details: { provided: input.id },
      module: 'inspect',
      correlationId,
      recoverable: false,
      exitCode: INSPECT_EXIT_CODES.INPUT_ERROR,
    });
  }

  // Get endpoint configuration
  const baseUrl = getResultsIndexUrl();
  const timeout = options.timeout ?? getRequestTimeout();

  // Build query for specific ID
  const queryParams: ResultsQueryParams = {
    id: input.id.trim(),
    limit: 1,
  };

  // Validate query parameters
  validateQueryParams(queryParams, correlationId);

  // Build request URL
  const requestUrl = buildQueryUrl(baseUrl, queryParams);

  // Execute HTTP GET request
  const response = await executeHttpGet(requestUrl, timeout, correlationId);

  // Handle 404 - run not found (return found: false instead of error)
  if (response.status === 404) {
    return {
      result: null,
      found: false,
      timing: Date.now() - startTime,
    };
  }

  // Handle other non-2xx responses
  if (response.status >= 400) {
    let errorMessage = 'The results service returned an error';
    if (typeof response.body === 'object' && response.body !== null) {
      const body = response.body as Record<string, unknown>;
      if (typeof body['message'] === 'string') {
        errorMessage = body['message'];
      } else if (typeof body['error'] === 'string') {
        errorMessage = body['error'];
      }
    }

    if (response.status === 503 || response.status === 502 || response.status === 504) {
      throw new CLIError({
        code: 'ECLI-INSPECT-SERVICE-UNAVAILABLE',
        category: 'NETWORK_ERROR',
        message: 'The results service is currently unavailable. Please try again later.',
        details: { hint: 'The service may be temporarily down for maintenance.' },
        module: 'inspect',
        correlationId,
        recoverable: true,
        exitCode: INSPECT_EXIT_CODES.SERVICE_UNAVAILABLE,
      });
    }

    throw new CLIError({
      code: `ECLI-INSPECT-HTTP-${response.status}`,
      category: response.status >= 500 ? 'NETWORK_ERROR' : 'INPUT_ERROR',
      message: errorMessage,
      details: { http_status: response.status },
      module: 'inspect',
      correlationId,
      recoverable: response.status >= 500,
      exitCode: response.status >= 500
        ? INSPECT_EXIT_CODES.SERVICE_UNAVAILABLE
        : INSPECT_EXIT_CODES.INPUT_ERROR,
    });
  }

  // ============================================================================
  // CONTRACT VALIDATION — CLI assumes results-index returns canonical result_packet.
  // Do NOT reshape returned payload.
  // ============================================================================
  const responseBody = response.body;

  if (!responseBody || typeof responseBody !== 'object') {
    throw new CLIError({
      code: 'ECLI-INSPECT-RUN-CONTRACT-001',
      category: 'DOWNSTREAM_ERROR',
      message: 'No contract-compliant execution found.',
      details: { run_id: input.id },
      module: 'inspect',
      correlationId,
      recoverable: false,
      exitCode: INSPECT_EXIT_CODES.UNEXPECTED_ERROR,
    });
  }

  const body = responseBody as Record<string, unknown>;

  // Canonical format: result_packet with execution_id
  if ('execution_id' in body) {
    validateResultPacket(body, correlationId);
    return {
      result: body as unknown as SimulationResult,
      found: true,
      timing: Date.now() - startTime,
    };
  }

  // Canonical list format: { results: [result_packet] }
  if ('results' in body && Array.isArray(body['results']) && (body['results'] as unknown[]).length > 0) {
    const first = (body['results'] as Record<string, unknown>[])[0];
    if (first) {
      validateResultPacket(first, correlationId);
      return {
        result: first as unknown as SimulationResult,
        found: true,
        timing: Date.now() - startTime,
      };
    }
  }

  throw new CLIError({
    code: 'ECLI-INSPECT-RUN-CONTRACT-002',
    category: 'DOWNSTREAM_ERROR',
    message: `Result packet missing required contract fields for run: ${input.id}`,
    details: {
      run_id: input.id,
      received_keys: Object.keys(body),
    },
    module: 'inspect',
    correlationId,
    recoverable: false,
    exitCode: INSPECT_EXIT_CODES.UNEXPECTED_ERROR,
  });
}

// ============================================================================
// Inspect Artifacts Types
// ============================================================================

export interface InspectArtifactsInput {
  id: string;
}

export interface InspectArtifact {
  id: string;
  type: string;
  name: string;
  location: string;
  size_bytes?: number;
  created_at: string;
  checksum?: string;
}

export interface InspectArtifactsResult {
  artifacts: InspectArtifact[];
  run_id: string;
  count: number;
  found: boolean;
  timing: number;
}

// ============================================================================
// Inspect Artifacts Command Implementation
// ============================================================================

/**
 * Get artifacts for a specific simulation run.
 * Queries the results-index service for artifact metadata.
 */
export async function executeInspectArtifactsCommand(
  input: InspectArtifactsInput,
  options: CommandOptions
): Promise<InspectArtifactsResult> {
  const correlationId = options.trace_id ?? crypto.randomUUID();
  const startTime = Date.now();

  // Validate ID
  if (!input.id || typeof input.id !== 'string' || input.id.trim() === '') {
    throw new CLIError({
      code: 'ECLI-INSPECT-ARTIFACTS-INVALID-ID',
      category: 'INPUT_ERROR',
      message: 'Run ID is required for artifact inspection',
      details: { provided: input.id },
      module: 'inspect',
      correlationId,
      recoverable: false,
      exitCode: INSPECT_EXIT_CODES.INPUT_ERROR,
    });
  }

  // Get endpoint configuration
  const baseUrl = getResultsIndexUrl();
  const timeout = options.timeout ?? getRequestTimeout();

  // Build request URL for artifacts endpoint
  const requestUrl = `${baseUrl}/api/v1/runs/${encodeURIComponent(input.id.trim())}/artifacts`;

  // Execute HTTP GET request
  const response = await executeHttpGet(requestUrl, timeout, correlationId);

  // Handle 404 - run not found
  if (response.status === 404) {
    return {
      artifacts: [],
      run_id: input.id,
      count: 0,
      found: false,
      timing: Date.now() - startTime,
    };
  }

  // Handle other non-2xx responses
  if (response.status >= 400) {
    let errorMessage = 'The results service returned an error';
    if (typeof response.body === 'object' && response.body !== null) {
      const body = response.body as Record<string, unknown>;
      if (typeof body['message'] === 'string') {
        errorMessage = body['message'];
      } else if (typeof body['error'] === 'string') {
        errorMessage = body['error'];
      }
    }

    throw new CLIError({
      code: `ECLI-INSPECT-ARTIFACTS-HTTP-${response.status}`,
      category: response.status >= 500 ? 'NETWORK_ERROR' : 'INPUT_ERROR',
      message: errorMessage,
      details: { http_status: response.status },
      module: 'inspect',
      correlationId,
      recoverable: response.status >= 500,
      exitCode: response.status >= 500
        ? INSPECT_EXIT_CODES.SERVICE_UNAVAILABLE
        : INSPECT_EXIT_CODES.INPUT_ERROR,
    });
  }

  // ============================================================================
  // CONTRACT VALIDATION — Do NOT reshape returned payload.
  // CLI assumes results-index returns canonical artifact format.
  // ============================================================================
  const responseBody = response.body;
  let artifacts: InspectArtifact[] = [];

  if (typeof responseBody === 'object' && responseBody !== null && 'artifacts' in responseBody) {
    const body = responseBody as Record<string, unknown>;
    if (Array.isArray(body['artifacts'])) {
      artifacts = body['artifacts'] as InspectArtifact[];
    }
  } else {
    throw new CLIError({
      code: 'ECLI-INSPECT-ARTIFACTS-CONTRACT-001',
      category: 'DOWNSTREAM_ERROR',
      message: 'Artifacts response does not conform to canonical format (missing "artifacts" field)',
      details: {
        run_id: input.id,
        received_type: typeof responseBody,
      },
      module: 'inspect',
      correlationId,
      recoverable: false,
      exitCode: INSPECT_EXIT_CODES.UNEXPECTED_ERROR,
    });
  }

  return {
    artifacts,
    run_id: input.id,
    count: artifacts.length,
    found: true,
    timing: Date.now() - startTime,
  };
}

/**
 * Format artifacts list for human-readable display
 */
export function formatArtifactsForDisplay(artifacts: InspectArtifact[], runId: string): string {
  if (artifacts.length === 0) {
    return `No artifacts found for run: ${runId}`;
  }

  const lines: string[] = [];
  lines.push(`Artifacts for run ${runId} (${artifacts.length}):`);
  lines.push('');

  for (const artifact of artifacts) {
    lines.push(`  ${artifact.id}`);
    lines.push(`    Type:     ${artifact.type}`);
    lines.push(`    Name:     ${artifact.name}`);
    lines.push(`    Location: ${artifact.location}`);
    if (artifact.size_bytes !== undefined) {
      lines.push(`    Size:     ${artifact.size_bytes} bytes`);
    }
    if (artifact.checksum) {
      lines.push(`    Checksum: ${artifact.checksum}`);
    }
    lines.push(`    Created:  ${new Date(artifact.created_at).toLocaleString()}`);
    lines.push('');
  }

  return lines.join('\n');
}
