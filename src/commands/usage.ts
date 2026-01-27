/**
 * Usage Command - Usage Management and Connectivity Verification
 *
 * ARCHITECTURE:
 * - Main command issues direct HTTP GET request to agentics-usage-ledger
 * - Subcommands provide local stubbed data for history/limits
 * - reset requires --force flag
 *
 * SUBCOMMANDS:
 * - (default) Check current usage balance via ledger service
 * - history   Show usage history (stubbed)
 * - limits    Show usage limits (stubbed)
 * - reset     Reset usage counters (requires --force)
 *
 * PURPOSE:
 * - Verify CLI-to-usage-ledger connectivity
 * - Display current balance or usage information
 * - Provide org-scoped usage data
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
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

// ============================================================================
// Usage History Types
// ============================================================================

export interface UsageHistoryInput {
  limit?: number;
  since?: string;
}

export interface UsageHistoryEntry {
  id: string;
  action: string;
  credits_used: number;
  timestamp: string;
  command?: string;
  correlation_id?: string;
}

export interface UsageHistoryResult {
  history: UsageHistoryEntry[];
  count: number;
  timing: number;
}

// ============================================================================
// Usage Limits Types
// ============================================================================

export interface UsageLimitsInput {
  org_id?: string;
}

export interface UsageLimits {
  daily_limit: number;
  monthly_limit: number;
  concurrent_limit: number;
  rate_limit_per_minute: number;
  current_daily_usage: number;
  current_monthly_usage: number;
  reset_at: string;
}

export interface UsageLimitsResult {
  limits: UsageLimits;
  timing: number;
}

// ============================================================================
// Usage Reset Types
// ============================================================================

export interface UsageResetInput {
  force: boolean;
}

export interface UsageResetResult {
  reset: boolean;
  previous_usage: number;
  advisory: boolean;
  timing: number;
  message: string;
}

// ============================================================================
// Local State Storage (for reset tracking)
// ============================================================================

function getUsageStateDir(): string {
  const baseDir = process.env['AGENTICS_DATA_DIR'] ?? process.cwd();
  return path.join(baseDir, '.agentics', 'usage');
}

function ensureUsageStateDir(): void {
  const dir = getUsageStateDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function getUsageStatePath(): string {
  return path.join(getUsageStateDir(), 'state.json');
}

interface UsageState {
  last_reset_at?: string;
  reset_count: number;
  total_credits_used: number;
}

function loadUsageState(): UsageState {
  const filePath = getUsageStatePath();
  if (!fs.existsSync(filePath)) {
    return { reset_count: 0, total_credits_used: 0 };
  }
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(content) as UsageState;
  } catch {
    return { reset_count: 0, total_credits_used: 0 };
  }
}

function saveUsageState(state: UsageState): void {
  ensureUsageStateDir();
  const filePath = getUsageStatePath();
  fs.writeFileSync(filePath, JSON.stringify(state, null, 2), 'utf-8');
}

// ============================================================================
// Display Formatting
// ============================================================================

export function formatHistoryForDisplay(history: UsageHistoryEntry[]): string {
  if (history.length === 0) {
    return 'No usage history found.';
  }

  const lines: string[] = [];
  lines.push(`Usage History (${history.length} entries):`);
  lines.push('');

  for (const entry of history) {
    lines.push(`  ${entry.timestamp} - ${entry.action}`);
    lines.push(`    Credits: ${entry.credits_used}`);
    if (entry.command) {
      lines.push(`    Command: ${entry.command}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

export function formatLimitsForDisplay(limits: UsageLimits): string {
  const lines: string[] = [];
  lines.push('Usage Limits:');
  lines.push('');
  lines.push(`  Daily Limit:           ${limits.daily_limit.toLocaleString()} credits`);
  lines.push(`  Monthly Limit:         ${limits.monthly_limit.toLocaleString()} credits`);
  lines.push(`  Concurrent Limit:      ${limits.concurrent_limit} operations`);
  lines.push(`  Rate Limit:            ${limits.rate_limit_per_minute} requests/minute`);
  lines.push('');
  lines.push('Current Usage:');
  lines.push(`  Daily:                 ${limits.current_daily_usage.toLocaleString()} / ${limits.daily_limit.toLocaleString()}`);
  lines.push(`  Monthly:               ${limits.current_monthly_usage.toLocaleString()} / ${limits.monthly_limit.toLocaleString()}`);
  lines.push('');
  lines.push(`  Resets at:             ${new Date(limits.reset_at).toLocaleString()}`);

  return lines.join('\n');
}

// ============================================================================
// Usage History Command Implementation (Stubbed)
// ============================================================================

/**
 * Get usage history - returns stubbed data
 */
export async function executeUsageHistoryCommand(
  input: UsageHistoryInput,
  _options: CommandOptions
): Promise<UsageHistoryResult> {
  const startTime = Date.now();

  // Generate stubbed history entries
  const now = new Date();
  const history: UsageHistoryEntry[] = [];

  // Create some placeholder entries
  const limit = input.limit ?? 10;
  for (let i = 0; i < Math.min(limit, 5); i++) {
    const timestamp = new Date(now.getTime() - (i * 3600000)); // 1 hour apart
    history.push({
      id: `usage-${Date.now().toString(36)}-${i}`,
      action: i === 0 ? 'usage_check' : i === 1 ? 'simulate_run' : i === 2 ? 'plan_create' : 'api_call',
      credits_used: Math.floor(Math.random() * 10) + 1,
      timestamp: timestamp.toISOString(),
      command: i === 0 ? 'usage' : i === 1 ? 'simulate run' : i === 2 ? 'plan create' : 'inspect',
      correlation_id: crypto.randomUUID(),
    });
  }

  // If since filter provided, filter (stub behavior - just return less data)
  if (input.since) {
    const sinceDate = new Date(input.since);
    const filtered = history.filter(h => new Date(h.timestamp) >= sinceDate);
    return {
      history: filtered,
      count: filtered.length,
      timing: Date.now() - startTime,
    };
  }

  return {
    history,
    count: history.length,
    timing: Date.now() - startTime,
  };
}

// ============================================================================
// Usage Limits Command Implementation (Stubbed)
// ============================================================================

/**
 * Get usage limits - returns stubbed data
 */
export async function executeUsageLimitsCommand(
  _input: UsageLimitsInput,
  _options: CommandOptions
): Promise<UsageLimitsResult> {
  const startTime = Date.now();

  // Get current state for usage numbers
  const state = loadUsageState();

  // Calculate reset time (next midnight UTC)
  const now = new Date();
  const resetAt = new Date(now);
  resetAt.setUTCHours(24, 0, 0, 0);

  const limits: UsageLimits = {
    daily_limit: 10000,
    monthly_limit: 100000,
    concurrent_limit: 10,
    rate_limit_per_minute: 60,
    current_daily_usage: state.total_credits_used % 10000, // Stub: roll over at daily limit
    current_monthly_usage: state.total_credits_used,
    reset_at: resetAt.toISOString(),
  };

  return {
    limits,
    timing: Date.now() - startTime,
  };
}

// ============================================================================
// Usage Reset Command Implementation
// ============================================================================

/**
 * Reset usage counters - requires --force flag
 */
export async function executeUsageResetCommand(
  input: UsageResetInput,
  options: CommandOptions
): Promise<UsageResetResult> {
  const startTime = Date.now();
  const correlationId = options.trace_id ?? crypto.randomUUID();

  if (!input.force) {
    throw new CLIError({
      code: 'ECLI-USAGE-RESET-REQUIRES-FORCE',
      category: 'INPUT_ERROR',
      message: 'Usage reset requires --force flag to confirm',
      details: { hint: 'Run with --force to confirm the reset operation' },
      module: 'usage',
      correlationId,
      recoverable: true,
      exitCode: USAGE_EXIT_CODES.SUCCESS, // Not an error, just requires confirmation
    });
  }

  // Load current state
  const state = loadUsageState();
  const previousUsage = state.total_credits_used;

  // Reset usage counters
  const newState: UsageState = {
    last_reset_at: new Date().toISOString(),
    reset_count: state.reset_count + 1,
    total_credits_used: 0,
  };

  saveUsageState(newState);

  return {
    reset: true,
    previous_usage: previousUsage,
    advisory: false,
    timing: Date.now() - startTime,
    message: 'Usage counters reset successfully',
  };
}
