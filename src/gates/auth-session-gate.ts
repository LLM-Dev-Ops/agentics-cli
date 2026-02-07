/**
 * Authentication Session Gate Module
 *
 * CONTROL PLANE HARDENING
 *
 * PURPOSE: Enforce authenticated session requirement for ALL operational commands.
 *          CLI MUST require valid authentication before invoking remote services.
 *
 * CRITICAL REQUIREMENTS:
 * - CLI requires authenticated session
 * - No anonymous operations allowed
 * - Clear error messaging for auth failures
 *
 * FORBIDDEN:
 * - Fallback to anonymous access
 * - Silent auth bypass
 * - Local execution fallback
 */

import { hasValidCredentials, getActiveAccount } from '../auth/gcp-identity.js';
import { createCredentialStore } from '../utils/credentials.js';
import { EXIT_CODES } from '../types/index.js';

// ============================================================================
// Authentication Gate Configuration
// ============================================================================

/**
 * Exit code for authentication required.
 */
export const AUTH_REQUIRED_EXIT_CODE = EXIT_CODES.AUTH_ERROR;

// ============================================================================
// Authentication Gate Error
// ============================================================================

export class AuthSessionRequiredError extends Error {
  constructor() {
    super(
      `\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
      `  AUTHENTICATION REQUIRED\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
      `\n` +
      `  The CLI requires an authenticated session to execute this command.\n` +
      `  No valid credentials were found.\n` +
      `\n` +
      `  TO AUTHENTICATE:\n` +
      `\n` +
      `  Option 1: Platform login (recommended)\n` +
      `    agentics login\n` +
      `\n` +
      `  Option 2: API key via environment variable\n` +
      `    export AGENTICS_API_KEY=agentics_sk_...\n` +
      `\n` +
      `  Option 3: Internal team access (no payment required)\n` +
      `    export AGENTICS_INTERNAL_KEY=agentics_internal_...\n` +
      `    export AGENTICS_EMAIL=you@company.com\n` +
      `\n` +
      `  Option 4: GCP authentication\n` +
      `    gcloud auth login\n` +
      `\n` +
      `  After authenticating, re-run your command.\n` +
      `\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`
    );
    this.name = 'AuthSessionRequiredError';
  }
}

// ============================================================================
// Authentication Gate Interface
// ============================================================================

export interface AuthSessionGateResult {
  authenticated: boolean;
  method?: 'platform' | 'gcp';
  account?: string;
  exitCode?: number;
  message?: string;
}

// ============================================================================
// Authentication Gate Implementation
// ============================================================================

/**
 * Check if user has valid platform credentials.
 * Supports three auth methods in priority order:
 *   1. AGENTICS_API_KEY environment variable (internal / CI use)
 *   2. AGENTICS_INTERNAL_KEY env var (approved internal emails, no payment required)
 *   3. Stored credentials from `agentics login`
 */
async function hasPlatformCredentials(): Promise<{ valid: boolean; email?: string }> {
  try {
    // Priority 1: AGENTICS_API_KEY env var — allows headless / CI auth
    const envKey = process.env['AGENTICS_API_KEY'];
    if (envKey && envKey.startsWith('agentics_sk_')) {
      return { valid: true, email: process.env['AGENTICS_EMAIL'] };
    }

    // Priority 2: AGENTICS_INTERNAL_KEY — approved internal users (no payment)
    const internalKey = process.env['AGENTICS_INTERNAL_KEY'];
    if (internalKey && internalKey.startsWith('agentics_internal_')) {
      return { valid: true, email: process.env['AGENTICS_EMAIL'] ?? 'internal-user' };
    }

    // Priority 3: Stored credentials from `agentics login`
    const store = createCredentialStore();
    const credentials = await store.load();

    if (credentials && credentials.api_key) {
      return { valid: true, email: credentials.email };
    }

    return { valid: false };
  } catch {
    return { valid: false };
  }
}

/**
 * Check if user has valid GCP credentials.
 */
function hasGcpCredentials(): { valid: boolean; account?: string } {
  const hasCredentials = hasValidCredentials();
  if (hasCredentials) {
    const account = getActiveAccount();
    return { valid: true, account: account ?? undefined };
  }
  return { valid: false };
}

/**
 * Check if user has valid authentication.
 * Checks both platform credentials and GCP credentials.
 */
export async function checkAuthSessionGate(): Promise<AuthSessionGateResult> {
  // Check platform credentials first
  const platformAuth = await hasPlatformCredentials();
  if (platformAuth.valid) {
    return {
      authenticated: true,
      method: 'platform',
      account: platformAuth.email,
    };
  }

  // Fall back to GCP credentials
  const gcpAuth = hasGcpCredentials();
  if (gcpAuth.valid) {
    return {
      authenticated: true,
      method: 'gcp',
      account: gcpAuth.account,
    };
  }

  // No valid credentials found
  return {
    authenticated: false,
    exitCode: AUTH_REQUIRED_EXIT_CODE,
    message: new AuthSessionRequiredError().message,
  };
}

/**
 * Enforce the authentication session gate.
 * Exits the process if no valid authentication is found.
 */
export async function enforceAuthSessionGate(): Promise<void> {
  const result = await checkAuthSessionGate();

  if (!result.authenticated) {
    console.error(result.message);
    process.exit(result.exitCode);
  }
}

/**
 * Commands that require authentication.
 * All operational commands require authentication.
 * Only login, whoami, help, and version are allowed without authentication.
 */
const AUTH_REQUIRED_COMMANDS = new Set([
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
  'logout',
]);

/**
 * Check if a command requires authentication.
 */
export function requiresAuthentication(command: string): boolean {
  return AUTH_REQUIRED_COMMANDS.has(command);
}
