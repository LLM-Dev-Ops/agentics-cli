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
import { createIdentityStore } from '../utils/identity-store.js';
import { getActiveAccount, hasValidCredentials } from '../auth/gcp-identity.js';
import { isExecutionEnabled, resolveEntitlement, type Entitlement } from '../gates/execution-gate.js';
import type { OrgRole } from '../types/index.js';

// ============================================================================
// Result Types
// ============================================================================

export interface WhoamiCommandResult {
  authenticated: boolean;
  user?: string;
  user_id?: string;
  org?: string;
  org_id?: string;
  role?: OrgRole;
  entitlement?: Entitlement;
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
 * Resolve user from credentials or environment.
 * Only called when authenticated.
 *
 * @param storedEmail - Email from stored credentials (if available)
 */
function resolveUser(storedEmail?: string): string {
  // Priority 1: Email from stored credentials
  if (storedEmail && storedEmail.trim()) {
    return storedEmail.trim();
  }

  // Priority 2: Environment variables
  const envEmail = process.env['AGENTICS_USER_EMAIL'];
  if (envEmail && envEmail.trim()) {
    return envEmail.trim();
  }

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
        entitlement: resolveEntitlement(),
        gcp: gcpInfo,
        execution_enabled: await isExecutionEnabled(),
      };
    }

    // Load cached identity for user_id, org_id, role
    const identityStore = createIdentityStore();
    const identity = await identityStore.load();

    return {
      authenticated: true,
      user: resolveUser(credentials.email),
      user_id: identity?.user.user_id,
      org: resolveOrg(),
      org_id: identity?.org.org_id,
      role: identity?.role,
      entitlement: resolveEntitlement(),
      gcp: gcpInfo,
      execution_enabled: await isExecutionEnabled(),
    };
  } catch {
    // On any error, report unauthenticated (never throw)
    return {
      authenticated: false,
      entitlement: resolveEntitlement(),
      gcp: gcpInfo,
      execution_enabled: await isExecutionEnabled(),
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
    lines.push(`  User:    ${result.user}`);
    if (result.user_id) {
      lines.push(`  User ID: ${result.user_id}`);
    }
    if (result.org_id) {
      lines.push(`  Org ID:  ${result.org_id}`);
    } else {
      lines.push(`  Org:     ${result.org}`);
    }
    if (result.role) {
      lines.push(`  Role:    ${result.role}`);
    }
    if (result.entitlement === 'internal') {
      lines.push('  Access:  Internal (full execution)');
    } else if (result.entitlement === 'paid') {
      lines.push('  Access:  Paid');
    }
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
