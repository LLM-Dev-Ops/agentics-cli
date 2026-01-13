/**
 * Logout Command (agentics logout)
 *
 * PURPOSE: Clear local authentication state so all protected commands require re-login.
 *
 * BEHAVIOR:
 * - Removes persisted credentials
 * - Idempotent (safe to run multiple times)
 * - Graceful if already logged out
 * - No network calls
 *
 * DOES NOT:
 * - Duplicate auth logic
 * - Remove non-auth configuration
 * - Make network calls
 * - Introduce new storage formats
 */

import { createCredentialStore } from '../utils/credentials.js';

// ============================================================================
// Result Types
// ============================================================================

export interface LogoutCommandResult {
  success: boolean;
  hadSession: boolean;
  message: string;
}

// ============================================================================
// Logout Command Implementation
// ============================================================================

/**
 * Execute the logout command.
 *
 * Clears local authentication state using the existing credential store.
 * Idempotent - safe to call even if no session exists.
 */
export async function executeLogoutCommand(): Promise<LogoutCommandResult> {
  const credentialStore = createCredentialStore();

  try {
    // Check if session exists before deleting
    const hadSession = await credentialStore.exists();

    // Delete credentials (idempotent - no error if already gone)
    await credentialStore.delete();

    if (hadSession) {
      return {
        success: true,
        hadSession: true,
        message: 'Logged out successfully.',
      };
    } else {
      return {
        success: true,
        hadSession: false,
        message: 'No active session found.',
      };
    }
  } catch {
    // Should not happen, but handle gracefully
    return {
      success: false,
      hadSession: false,
      message: 'Failed to clear authentication state.',
    };
  }
}

// ============================================================================
// Display Formatting
// ============================================================================

/**
 * Format logout result for terminal output.
 */
export function formatLogoutForDisplay(result: LogoutCommandResult): string {
  if (result.hadSession) {
    return `✓ ${result.message}`;
  } else {
    return `ℹ ${result.message}`;
  }
}
