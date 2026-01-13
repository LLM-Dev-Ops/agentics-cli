/**
 * Usage Command - Verify connectivity to agentics-usage-ledger service
 *
 * ARCHITECTURE:
 * - Standalone read-only command
 * - Issues direct HTTP GET request to agentics-usage-ledger
 * - Returns current usage/balance information
 * - Does NOT enforce limits, perform debits, or block execution
 *
 * PURPOSE:
 * - Verify CLI-to-usage-ledger connectivity
 * - Display current balance or usage information
 */

import type { CommandOptions } from '../types/index.js';
import { CLIError } from '../errors/index.js';
import { validateEndpointUrl } from '../config/endpoints.js';

// ============================================================================
// Usage-Specific Exit Codes
// ============================================================================

export const USAGE_EXIT_CODES = {
  SUCCESS: 0,
  SERVICE_UNAVAILABLE: 69,
  TIMEOUT: 75,
  NETWORK_ERROR: 120,
  UNEXPECTED_ERROR: 1,
} as const;

// ============================================================================
// Result Types
// ============================================================================

export interface UsageBalance {
  current_balance?: number;
  credits_remaining?: number;
  credits_used?: number;
  total_credits?: number;
  currency?: string;
  last_updated?: string;
}

export interface UsageCommandResult {
  balance: UsageBalance | null;
  connected: boolean;
  timing: number;
  message: string;
}

// ============================================================================
// Endpoint Configuration
// ============================================================================

/**
 * Get the usage-ledger endpoint URL.
 * Uses environment variable override or production default.
 */
function getUsageLedgerUrl(): string {
  const envUrl = process.env['AGENTICS_USAGE_LEDGER_URL'];
  if (envUrl) {
    return envUrl;
  }
  return 'https://agentics-usage-ledger-1062287243982.us-central1.run.app';
}

/**
 * Get the request timeout in milliseconds.
 */
function getRequestTimeout(): number {
  const envTimeout = process.env['AGENTICS_USAGE_LEDGER_TIMEOUT'];
  if (envTimeout) {
    const parsed = parseInt(envTimeout, 10);
    if (!isNaN(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return 15000; // 15 seconds default
}

// ============================================================================
// Output Formatting
// ============================================================================

/**
 * Format usage balance for human-readable terminal output.
 */
export function formatUsageForDisplay(result: UsageCommandResult): string {
  const lines: string[] = [];

  if (!result.connected) {
    lines.push('Usage Ledger Status: UNREACHABLE');
    lines.push('');
    lines.push(result.message);
    return lines.join('\n');
  }

  lines.push('Usage Ledger Status: CONNECTED');
  lines.push('');

  if (result.balance === null) {
    lines.push(result.message);
  } else {
    // Display balance information
    const b = result.balance;

    if (b.current_balance !== undefined) {
      const currency = b.currency ?? 'credits';
      lines.push(`  Current Balance: ${b.current_balance.toLocaleString()} ${currency}`);
    } else if (b.credits_remaining !== undefined) {
      lines.push(`  Credits Remaining: ${b.credits_remaining.toLocaleString()}`);
    }

    if (b.credits_used !== undefined) {
      lines.push(`  Credits Used: ${b.credits_used.toLocaleString()}`);
    }

    if (b.total_credits !== undefined) {
      lines.push(`  Total Credits: ${b.total_credits.toLocaleString()}`);
    }

    if (b.last_updated) {
      lines.push(`  Last Updated: ${new Date(b.last_updated).toLocaleString()}`);
    }

    // If no specific fields, show the message
    if (lines.length === 2) {
      lines.push(result.message);
    }
  }

  lines.push('');
  lines.push(`Response time: ${result.timing}ms`);

  return lines.join('\n');
}

// ============================================================================
// Direct HTTP Request
// ============================================================================

/**
 * Execute a direct HTTP GET request to the usage-ledger service.
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
        code: 'ECLI-USAGE-TIMEOUT',
        category: 'NETWORK_ERROR',
        message: `Request timed out after ${timeout}ms`,
        details: { timeout_ms: timeout },
        module: 'usage',
        correlationId,
        recoverable: true,
        exitCode: USAGE_EXIT_CODES.TIMEOUT,
      });
    }

    // Handle network errors
    if (error instanceof TypeError) {
      throw new CLIError({
        code: 'ECLI-USAGE-NETWORK',
        category: 'NETWORK_ERROR',
        message: 'Unable to connect to the usage ledger service',
        details: { hint: 'Check your network connection and try again.' },
        module: 'usage',
        correlationId,
        recoverable: true,
        exitCode: USAGE_EXIT_CODES.NETWORK_ERROR,
      });
    }

    // Re-throw CLIErrors
    if (error instanceof CLIError) {
      throw error;
    }

    // Wrap unknown errors
    throw new CLIError({
      code: 'ECLI-USAGE-UNKNOWN',
      category: 'INTERNAL_ERROR',
      message: error instanceof Error ? error.message : 'An unexpected error occurred',
      module: 'usage',
      correlationId,
      recoverable: false,
      exitCode: USAGE_EXIT_CODES.UNEXPECTED_ERROR,
    });
  }
}

// ============================================================================
// Usage Command Implementation
// ============================================================================

/**
 * Execute the usage command.
 *
 * Verifies connectivity to the usage-ledger service and returns
 * current balance/usage information.
 */
export async function executeUsageCommand(
  options: CommandOptions
): Promise<UsageCommandResult> {
  const correlationId = options.trace_id ?? crypto.randomUUID();
  const startTime = Date.now();

  // Get endpoint configuration
  const baseUrl = getUsageLedgerUrl();
  const timeout = options.timeout ?? getRequestTimeout();

  // Validate endpoint URL (fails fast if localhost without local dev mode)
  validateEndpointUrl('agentics-usage-ledger', baseUrl);

  // Build request URL - try /v1/usage/balance first, fall back to /v1/usage
  const balanceUrl = `${baseUrl}/v1/usage/balance`;

  try {
    const response = await executeHttpGet(balanceUrl, timeout, correlationId);

    // Handle successful response
    if (response.status >= 200 && response.status < 300) {
      const body = response.body as Record<string, unknown>;

      // Extract balance information from various response formats
      const balance: UsageBalance = {};

      if (typeof body['current_balance'] === 'number') {
        balance.current_balance = body['current_balance'];
      }
      if (typeof body['balance'] === 'number') {
        balance.current_balance = body['balance'];
      }
      if (typeof body['credits_remaining'] === 'number') {
        balance.credits_remaining = body['credits_remaining'];
      }
      if (typeof body['credits_used'] === 'number') {
        balance.credits_used = body['credits_used'];
      }
      if (typeof body['total_credits'] === 'number') {
        balance.total_credits = body['total_credits'];
      }
      if (typeof body['currency'] === 'string') {
        balance.currency = body['currency'];
      }
      if (typeof body['last_updated'] === 'string') {
        balance.last_updated = body['last_updated'];
      }

      const hasBalanceData = Object.keys(balance).length > 0;

      return {
        balance: hasBalanceData ? balance : null,
        connected: true,
        timing: response.timing,
        message: hasBalanceData
          ? 'Successfully retrieved usage information.'
          : 'No usage recorded yet.',
      };
    }

    // Handle 404 - endpoint might be /v1/usage instead
    if (response.status === 404) {
      // Try the alternate endpoint
      const usageUrl = `${baseUrl}/v1/usage`;
      const altResponse = await executeHttpGet(usageUrl, timeout, correlationId);

      if (altResponse.status >= 200 && altResponse.status < 300) {
        const body = altResponse.body as Record<string, unknown>;
        const balance: UsageBalance = {};

        if (typeof body['current_balance'] === 'number') {
          balance.current_balance = body['current_balance'];
        }
        if (typeof body['balance'] === 'number') {
          balance.current_balance = body['balance'];
        }
        if (typeof body['credits_remaining'] === 'number') {
          balance.credits_remaining = body['credits_remaining'];
        }
        if (typeof body['credits_used'] === 'number') {
          balance.credits_used = body['credits_used'];
        }
        if (typeof body['total_credits'] === 'number') {
          balance.total_credits = body['total_credits'];
        }
        if (typeof body['currency'] === 'string') {
          balance.currency = body['currency'];
        }
        if (typeof body['last_updated'] === 'string') {
          balance.last_updated = body['last_updated'];
        }

        const hasBalanceData = Object.keys(balance).length > 0;

        return {
          balance: hasBalanceData ? balance : null,
          connected: true,
          timing: Date.now() - startTime,
          message: hasBalanceData
            ? 'Successfully retrieved usage information.'
            : 'No usage recorded yet.',
        };
      }
    }

    // Handle service unavailable
    if (response.status === 503 || response.status === 502 || response.status === 504) {
      throw new CLIError({
        code: 'ECLI-USAGE-SERVICE-UNAVAILABLE',
        category: 'NETWORK_ERROR',
        message: 'The usage ledger service is currently unavailable. Please try again later.',
        details: { hint: 'The service may be temporarily down for maintenance.' },
        module: 'usage',
        correlationId,
        recoverable: true,
        exitCode: USAGE_EXIT_CODES.SERVICE_UNAVAILABLE,
      });
    }

    // Handle other error responses but still indicate connectivity
    let errorMessage = 'Service responded but could not retrieve usage data.';
    if (typeof response.body === 'object' && response.body !== null) {
      const body = response.body as Record<string, unknown>;
      if (typeof body['message'] === 'string') {
        errorMessage = body['message'];
      } else if (typeof body['error'] === 'string') {
        errorMessage = body['error'];
      }
    }

    return {
      balance: null,
      connected: true,
      timing: response.timing,
      message: errorMessage,
    };
  } catch (error) {
    // Re-throw CLI errors
    if (error instanceof CLIError) {
      throw error;
    }

    // Unexpected errors
    throw new CLIError({
      code: 'ECLI-USAGE-UNEXPECTED',
      category: 'INTERNAL_ERROR',
      message: error instanceof Error ? error.message : 'An unexpected error occurred',
      module: 'usage',
      correlationId,
      recoverable: false,
      exitCode: USAGE_EXIT_CODES.UNEXPECTED_ERROR,
    });
  }
}
