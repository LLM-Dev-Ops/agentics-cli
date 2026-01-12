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
  environment?: 'production' | 'staging' | 'development' | 'test';
  status?: 'completed' | 'failed' | 'running' | 'pending';
  limit?: number;
  order?: 'newest' | 'oldest';
  id?: string;
}

// ============================================================================
// Result Types
// ============================================================================

export interface SimulationResult {
  id: string;
  environment: string;
  status: string;
  created_at: string;
  completed_at?: string;
  duration_ms?: number;
  summary?: string;
  metrics?: Record<string, unknown>;
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
  } else if (lower.includes('test')) {
    params.environment = 'test';
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

  // Validate environment if provided
  const validEnvironments = ['production', 'staging', 'development', 'test'];
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

    lines.push(`${statusIcon} ${result.id}`);
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
 */
function buildQueryUrl(baseUrl: string, params: ResultsQueryParams): string {
  const url = new URL('/v1/results', baseUrl);

  if (params.environment) {
    url.searchParams.set('environment', params.environment);
  }
  if (params.status) {
    url.searchParams.set('status', params.status);
  }
  if (params.limit !== undefined) {
    url.searchParams.set('limit', params.limit.toString());
  }
  if (params.order) {
    url.searchParams.set('order', params.order);
  }
  if (params.id) {
    url.searchParams.set('id', params.id);
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

  // Extract results from response body
  const responseBody = response.body as {
    results?: SimulationResult[];
    data?: SimulationResult[];
    items?: SimulationResult[];
  };

  // Handle various response formats (newest-first is enforced by the service)
  const results: SimulationResult[] =
    responseBody.results ??
    responseBody.data ??
    responseBody.items ??
    (Array.isArray(responseBody) ? responseBody : []);

  // Return result - command terminates here
  return {
    results,
    query: queryParams,
    count: results.length,
    timing: Date.now() - startTime,
  };
}
