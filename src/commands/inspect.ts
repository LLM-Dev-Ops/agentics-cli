/**
 * Inspect Command
 *
 * SPARC Pseudocode Reference: §2.6
 *
 * FLOW:
 * 1. Parse arguments → CommandObject
 * 2. Translate natural language input to structured query parameters
 * 3. Query agentics-results-index via HTTP GET (read-only)
 * 4. Handle empty results gracefully
 * 5. Record audit entry
 * 6. Return InspectResult with human-readable output
 *
 * ROUTING:
 * - This command routes EXCLUSIVELY to agentics-results-index
 * - NO routing to execution, planning, or simulation services
 * - Read-only operation - performs NO mutations
 */

import type {
  CommandOptions,
  FlexibleInput,
  NaturalLanguageInput,
} from '../types/index.js';
import { isNaturalLanguage } from '../types/index.js';
import { ResultsIndexAdapter } from '../adapters/base-adapter.js';
import { createAuditTrail } from '../audit/audit-trail.js';
import { CLIError, failFast, toError } from '../errors/index.js';
import { loadEndpointConfig } from '../config/endpoints.js';

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

/**
 * Validate that query parameters are within acceptable bounds.
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
        exitCode: 100,
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
        exitCode: 100,
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
      exitCode: 100,
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
      exitCode: 100,
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
      exitCode: 100,
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
// Inspect Command Implementation
// ============================================================================

export async function executeInspectCommand(
  input: InspectCommandInput,
  options: CommandOptions
): Promise<InspectCommandResult> {
  const correlationId = options.trace_id ?? crypto.randomUUID();
  const startTime = Date.now();

  // Initialize components
  const audit = createAuditTrail();

  // Create adapter for results-index service (read-only)
  const resultsConfig = loadEndpointConfig('agentics-results-index');
  const resultsAdapter = new ResultsIndexAdapter(resultsConfig, correlationId);

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

  // Apply depth settings
  if (input.depth === 'detailed' || input.depth === 'full') {
    // For detailed/full depth, we still query the same endpoint
    // The depth affects output formatting, not the query itself
  }

  // Validate query parameters before making request
  validateQueryParams(queryParams, correlationId);

  try {
    // Execute read-only query against results-index
    const response = await resultsAdapter.query({
      environment: queryParams.environment,
      status: queryParams.status,
      limit: queryParams.limit,
      order: queryParams.order,
      id: queryParams.id,
    });

    // Extract results from response
    const responseBody = response.body as {
      results?: SimulationResult[];
      data?: SimulationResult[];
      items?: SimulationResult[];
    };

    // Handle various response formats
    const results: SimulationResult[] =
      responseBody.results ??
      responseBody.data ??
      responseBody.items ??
      (Array.isArray(responseBody) ? responseBody : []);

    // Log query summary for audit
    const queryDescription = isNaturalLanguage(input.simRef)
      ? `nl:${(input.simRef as NaturalLanguageInput).description.slice(0, 50)}`
      : `id:${(input.simRef as { id?: string }).id ?? 'unspecified'}`;

    // Record successful audit entry
    // Note: outputs is null because inspect is a read-only query that doesn't produce a reference
    audit.record({
      command: 'inspect',
      inputs: {
        query: queryDescription,
        params: queryParams,
        result_count: results.length,
      },
      outputs: null,
      dependencies: [
        {
          service: 'agentics-results-index',
          method: 'query',
          timestamp: new Date().toISOString(),
          duration_ms: response.timing,
          success: true,
        },
      ],
      duration_ms: Date.now() - startTime,
      status: 'SUCCESS',
      trace_id: correlationId,
    });

    return {
      results,
      query: queryParams,
      count: results.length,
      timing: Date.now() - startTime,
    };
  } catch (error) {
    // Record failure in audit
    const failedQueryDescription = isNaturalLanguage(input.simRef)
      ? `nl:${(input.simRef as NaturalLanguageInput).description.slice(0, 50)}`
      : `id:${(input.simRef as { id?: string }).id ?? 'unspecified'}`;

    audit.record({
      command: 'inspect',
      inputs: {
        query: failedQueryDescription,
        params: queryParams,
      },
      outputs: null,
      dependencies: [],
      duration_ms: Date.now() - startTime,
      status: 'FAILED',
      error_code: error instanceof Error ? error.name : 'UNKNOWN',
      error_message: error instanceof Error ? error.message : 'Unknown error',
      trace_id: correlationId,
    });

    // Handle service unavailability with user-friendly message
    const err = toError(error);
    if (err.message.includes('unavailable') || err.message.includes('ECONNREFUSED')) {
      throw new CLIError({
        code: 'ECLI-INSPECT-006',
        category: 'NETWORK_ERROR',
        message: 'Unable to retrieve results. The results service is currently unavailable.',
        details: {
          hint: 'Please try again in a few moments.',
        },
        module: 'inspect',
        correlationId,
        recoverable: true,
        exitCode: 69,
      });
    }

    // Fail fast for other errors
    failFast({
      command: 'inspect',
      phase: 'query',
      upstreamError: err,
      inputs: input,
      correlationId,
    });
  }
}
