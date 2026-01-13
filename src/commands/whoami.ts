/**
 * Whoami Command - Identity Introspection
 *
 * PURPOSE: Report current authentication state
 *
 * BEHAVIOR:
 * - If not authenticated: Show message suggesting login
 * - If authenticated: Show user and org info
 *
 * DOES NOT:
 * - Initiate login
 * - Require an API key to explain state
 * - Fabricate identity
 * - Make network calls
 * - Throw on missing auth
 */

import { createCredentialStore } from '../utils/credentials.js';

// ============================================================================
// Result Types
// ============================================================================

export interface WhoamiCommandResult {
  authenticated: boolean;
  user?: string;
  org?: string;
}

// ============================================================================
// Identity Resolution
// ============================================================================

/**
 * Resolve org name from environment or config.
 * Only called when authenticated.
 */
function resolveOrg(): string {
  // Check environment variables
  const envOrgName = process.env['AGENTICS_ORG_NAME'];
  if (envOrgName && envOrgName.trim()) {
    return envOrgName.trim();
  }

  const envOrgId = process.env['AGENTICS_ORG_ID'];
  if (envOrgId && envOrgId.trim()) {
    return envOrgId.trim();
  }

  return 'unknown';
}

/**
 * Resolve user from environment.
 * Only called when authenticated.
 */
function resolveUser(): string {
  const envUser = process.env['AGENTICS_USER'] ?? process.env['AGENTICS_USER_ID'];
  if (envUser && envUser.trim()) {
    return envUser.trim();
  }

  return 'unknown';
}

// ============================================================================
// Whoami Command Implementation
// ============================================================================

/**
 * Execute the whoami command.
 *
 * Checks authentication state FIRST. Identity resolution only
 * runs if authenticated.
 */
export async function executeWhoamiCommand(): Promise<WhoamiCommandResult> {
  const credentialStore = createCredentialStore();

  try {
    // Check authentication state using existing credential store
    const credentials = await credentialStore.load();

    if (!credentials) {
      // Not authenticated - return simple state, no identity resolution
      return { authenticated: false };
    }

    // Authenticated - resolve identity
    return {
      authenticated: true,
      user: resolveUser(),
      org: resolveOrg(),
    };
  } catch {
    // On any error, report unauthenticated (never throw)
    return { authenticated: false };
  }
}

// ============================================================================
// Display Formatting
// ============================================================================

/**
 * Format whoami result for terminal output.
 */
export function formatWhoamiForDisplay(result: WhoamiCommandResult): string {
  if (!result.authenticated) {
    return `Not authenticated.
Run \`agentics login\` to access the platform.`;
  }

  return `Authenticated as:
  User: ${result.user}
  Org:  ${result.org}`;
}
