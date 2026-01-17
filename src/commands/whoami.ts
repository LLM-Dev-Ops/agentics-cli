/**
 * Whoami Command - Identity Introspection
 *
 * PURPOSE: Report current authentication state
 *
 * BEHAVIOR:
 * - If not authenticated: Show message suggesting login
 * - If authenticated: Show user and org info
 * - Show GCP identity status (required for execution)
 *
 * DOES NOT:
 * - Initiate login
 * - Require an API key to explain state
 * - Fabricate identity
 * - Make network calls
 * - Throw on missing auth
 */

import { createCredentialStore } from '../utils/credentials.js';
import { getActiveAccount, hasValidCredentials } from '../auth/gcp-identity.js';
import { isExecutionEnabled } from '../gates/execution-gate.js';

// ============================================================================
// Result Types
// ============================================================================

export interface WhoamiCommandResult {
  authenticated: boolean;
  user?: string;
  org?: string;
  gcp?: {
    authenticated: boolean;
    account?: string;
  };
  execution_enabled: boolean;
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
 *
 * Also reports GCP identity status (required for execution).
 */
export async function executeWhoamiCommand(): Promise<WhoamiCommandResult> {
  const credentialStore = createCredentialStore();

  // Check GCP identity (required for execution when enabled)
  const gcpAccount = getActiveAccount();
  const gcpAuthenticated = gcpAccount !== null || hasValidCredentials();

  const gcpInfo = {
    authenticated: gcpAuthenticated,
    account: gcpAccount ?? undefined,
  };

  try {
    // Check authentication state using existing credential store
    const credentials = await credentialStore.load();

    if (!credentials) {
      // Not authenticated - return simple state, no identity resolution
      return {
        authenticated: false,
        gcp: gcpInfo,
        execution_enabled: isExecutionEnabled(),
      };
    }

    // Authenticated - resolve identity
    return {
      authenticated: true,
      user: resolveUser(),
      org: resolveOrg(),
      gcp: gcpInfo,
      execution_enabled: isExecutionEnabled(),
    };
  } catch {
    // On any error, report unauthenticated (never throw)
    return {
      authenticated: false,
      gcp: gcpInfo,
      execution_enabled: isExecutionEnabled(),
    };
  }
}

// ============================================================================
// Display Formatting
// ============================================================================

/**
 * Format whoami result for terminal output.
 */
export function formatWhoamiForDisplay(result: WhoamiCommandResult): string {
  const lines: string[] = [];

  // Platform authentication status
  if (!result.authenticated) {
    lines.push('Platform: Not authenticated');
    lines.push('  Run `agentics login` to access the platform.');
  } else {
    lines.push('Platform: Authenticated');
    lines.push(`  User: ${result.user}`);
    lines.push(`  Org:  ${result.org}`);
  }

  lines.push('');

  // GCP identity status (required for execution)
  if (result.gcp?.authenticated) {
    lines.push('GCP Identity: Authenticated');
    if (result.gcp.account) {
      lines.push(`  Account: ${result.gcp.account}`);
    }
  } else {
    lines.push('GCP Identity: Not authenticated');
    lines.push('  Run `gcloud auth login` to enable execution.');
  }

  lines.push('');

  // Execution gate status
  if (result.execution_enabled) {
    lines.push('Execution: ENABLED');
  } else {
    lines.push('Execution: DISABLED (explore-only mode)');
  }

  return lines.join('\n');
}
