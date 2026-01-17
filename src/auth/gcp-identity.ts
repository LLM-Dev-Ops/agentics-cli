/**
 * GCP Identity Token Module
 *
 * PURPOSE: Acquire Google Cloud identity tokens for Cloud Run authentication
 *
 * CONSTRAINTS (NON-NEGOTIABLE):
 * - NO JWTs
 * - NO OAuth flows
 * - NO API keys
 * - NO long-lived tokens
 * - NO token validation or decoding
 *
 * The CLI relies on:
 * - Application Default Credentials (ADC)
 * - Existing gcloud auth login
 * - Cloud Run IAM for enforcement
 *
 * This module only acquires tokens; verification is done by Cloud Run.
 */

import { execSync } from 'node:child_process';
import { AuthError } from '../errors/index.js';

// ============================================================================
// Configuration
// ============================================================================

/**
 * Timeout for token acquisition (in milliseconds).
 * gcloud should respond quickly if credentials are valid.
 */
const TOKEN_ACQUISITION_TIMEOUT_MS = 10000;

/**
 * Cache for identity tokens per audience.
 * Tokens are cached for the duration of the CLI process only.
 * This is NOT long-lived storage - it expires when the process exits.
 */
const tokenCache = new Map<string, { token: string; expiresAt: number }>();

/**
 * Token expiry buffer (in milliseconds).
 * Request a new token if it expires within this buffer.
 * Identity tokens are typically valid for 1 hour.
 */
const TOKEN_EXPIRY_BUFFER_MS = 60000; // 1 minute buffer

// ============================================================================
// Identity Token Acquisition
// ============================================================================

export interface IdentityTokenResult {
  token: string;
  audience: string;
}

export interface IdentityTokenError {
  type: 'not_authenticated' | 'gcloud_not_found' | 'token_acquisition_failed';
  message: string;
  details?: string;
}

/**
 * Acquire a Google Cloud identity token for the specified audience.
 *
 * This function:
 * 1. Checks for a cached valid token
 * 2. If not cached, invokes gcloud to get a new token
 * 3. Caches the token for the process duration
 *
 * The CLI NEVER validates or decodes the token.
 * Cloud Run IAM handles all verification.
 *
 * @param audience - The Cloud Run service URL (e.g., https://service-xxx.run.app)
 * @returns The identity token
 * @throws AuthError if token acquisition fails
 */
export function acquireIdentityToken(audience: string): string {
  // Normalize audience URL (strip trailing slashes, path components)
  const normalizedAudience = normalizeAudience(audience);

  // Check cache first
  const cached = tokenCache.get(normalizedAudience);
  if (cached && cached.expiresAt > Date.now() + TOKEN_EXPIRY_BUFFER_MS) {
    return cached.token;
  }

  // Acquire new token via gcloud
  const result = executeGcloudTokenCommand(normalizedAudience);

  if ('error' in result) {
    throw createAuthError(result.error);
  }

  // Cache the token (assume 1 hour validity, typical for identity tokens)
  const expiresAt = Date.now() + 3600000; // 1 hour
  tokenCache.set(normalizedAudience, { token: result.token, expiresAt });

  return result.token;
}

/**
 * Check if the user has valid GCP credentials.
 * Returns true if gcloud auth is configured, false otherwise.
 * Does NOT acquire or cache tokens.
 */
export function hasValidCredentials(): boolean {
  try {
    // Try to get account info - this doesn't require a specific audience
    execSync('gcloud auth list --filter=status:ACTIVE --format="value(account)"', {
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
      encoding: 'utf-8',
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Get the currently active GCP account (if any).
 * Returns null if not authenticated.
 */
export function getActiveAccount(): string | null {
  try {
    const result = execSync(
      'gcloud auth list --filter=status:ACTIVE --format="value(account)"',
      {
        timeout: 5000,
        stdio: ['pipe', 'pipe', 'pipe'],
        encoding: 'utf-8',
      }
    );
    const account = result.trim();
    return account || null;
  } catch {
    return null;
  }
}

/**
 * Clear the in-process token cache.
 * Useful for testing or forcing re-authentication.
 */
export function clearTokenCache(): void {
  tokenCache.clear();
}

// ============================================================================
// Internal Functions
// ============================================================================

/**
 * Normalize the audience URL for consistent caching.
 * Extracts just the origin (scheme + host).
 */
function normalizeAudience(audience: string): string {
  try {
    const url = new URL(audience);
    return `${url.protocol}//${url.host}`;
  } catch {
    // If URL parsing fails, return as-is
    return audience;
  }
}

/**
 * Service account for CLI to impersonate when acquiring identity tokens.
 * This service account must have Cloud Run Invoker role on target services.
 * Users must have Service Account Token Creator role on this service account.
 */
const CLI_SERVICE_ACCOUNT = process.env['AGENTICS_SERVICE_ACCOUNT']
  ?? 'agentics-cli-invoker@agentics-dev.iam.gserviceaccount.com';

/**
 * Execute gcloud command to get an identity token.
 * Uses service account impersonation to generate identity tokens with audiences.
 * Returns either a token or an error descriptor.
 */
function executeGcloudTokenCommand(
  audience: string
): IdentityTokenResult | { error: IdentityTokenError } {
  try {
    // Use gcloud to print an identity token for the specific audience
    // Uses service account impersonation to support --audiences flag
    const command = `gcloud auth print-identity-token --audiences="${audience}" --impersonate-service-account="${CLI_SERVICE_ACCOUNT}"`;

    const result = execSync(command, {
      timeout: TOKEN_ACQUISITION_TIMEOUT_MS,
      stdio: ['pipe', 'pipe', 'pipe'],
      encoding: 'utf-8',
    });

    const token = result.trim();

    if (!token) {
      return {
        error: {
          type: 'token_acquisition_failed',
          message: 'gcloud returned an empty token',
          details: 'The command succeeded but no token was returned',
        },
      };
    }

    return { token, audience };
  } catch (error) {
    return { error: classifyGcloudError(error) };
  }
}

/**
 * Classify a gcloud execution error into a typed error descriptor.
 */
function classifyGcloudError(error: unknown): IdentityTokenError {
  const errorMessage = error instanceof Error ? error.message : String(error);
  const lowerMessage = errorMessage.toLowerCase();

  // Check for gcloud not found
  if (
    lowerMessage.includes('command not found') ||
    lowerMessage.includes('not recognized') ||
    lowerMessage.includes('enoent')
  ) {
    return {
      type: 'gcloud_not_found',
      message: 'Google Cloud CLI (gcloud) is not installed or not in PATH',
      details:
        'Install gcloud from https://cloud.google.com/sdk/docs/install and run `gcloud auth login`',
    };
  }

  // Check for authentication issues
  if (
    lowerMessage.includes('not logged in') ||
    lowerMessage.includes('no credential') ||
    lowerMessage.includes('could not load') ||
    lowerMessage.includes('refresh token') ||
    lowerMessage.includes('access token') ||
    lowerMessage.includes('authentication')
  ) {
    return {
      type: 'not_authenticated',
      message: 'Not authenticated with Google Cloud',
      details: 'Run `gcloud auth login` to authenticate',
    };
  }

  // Generic failure
  return {
    type: 'token_acquisition_failed',
    message: 'Failed to acquire identity token',
    details: errorMessage,
  };
}

/**
 * Create an AuthError from an IdentityTokenError.
 */
function createAuthError(error: IdentityTokenError): AuthError {
  const typeMapping: Record<IdentityTokenError['type'], 'missing' | 'invalid' | 'expired'> = {
    not_authenticated: 'missing',
    gcloud_not_found: 'missing',
    token_acquisition_failed: 'invalid',
  };

  let fullMessage = error.message;
  if (error.details) {
    fullMessage += `\n\n${error.details}`;
  }

  return new AuthError({
    type: typeMapping[error.type],
    message: fullMessage,
  });
}
