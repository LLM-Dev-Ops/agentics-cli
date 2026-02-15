/**
 * Execution Gate Module — Thin Passthrough
 *
 * ARCHITECTURE:
 *   The CLI does NOT resolve entitlements, maintain email allowlists,
 *   or enforce access policy locally. Authorization is a platform concern.
 *
 *   The CLI sends the user's credentials (API key / auth token) to
 *   agentics-dev-platform, which returns an authorization decision.
 *
 * REMOVED (moved to platform):
 *   - DEFAULT_INTERNAL_EMAILS / hardcoded email allowlist
 *   - loadInternalEmails() / local config file parsing
 *   - resolveEntitlement() / multi-source local entitlement resolution
 *   - checkExecutionGate() / local policy enforcement
 *   - isExecutionEnabled() / local policy check
 *
 * WHAT REMAINS:
 *   - Type definitions (for contract compatibility)
 *   - ALLOWED_COMMANDS (identity/help commands that bypass auth — this is
 *     transport-level, not policy: you can't call login if login is gated)
 *   - enforceExecutionGate() — calls platform for authorization
 *   - Exit code constant
 */

import { EXIT_CODES } from '../types/index.js';

// ============================================================================
// Constants
// ============================================================================

/**
 * Commands that bypass the execution gate entirely.
 * These are identity bootstrapping and help commands — the CLI must
 * allow them so the user can authenticate in the first place.
 * This is transport-level routing, not policy enforcement.
 */
const ALLOWED_COMMANDS = new Set([
  'login',
  'logout',
  'whoami',
  'help',
  'version',
  'demo',
]);

export type Entitlement = 'internal' | 'paid' | 'none';

export const EXECUTION_BLOCKED_EXIT_CODE = EXIT_CODES.PERMISSION_DENIED;

// ============================================================================
// Execution Gate Result
// ============================================================================

export interface ExecutionGateResult {
  allowed: boolean;
  exitCode?: number;
  message?: string;
}

const BLOCKED_MESSAGE = `
❌ Execution Disabled

This command requires an active Agentics execution environment.

The Agentics CLI is currently in explore-only mode.

Contact the Agentics team to enable execution.
`.trim();

// ============================================================================
// Execution Gate — Platform Authorization
// ============================================================================

/**
 * Check if a command is allowed to execute.
 *
 * For identity/help commands: always allowed (transport-level).
 * For all other commands: the platform decides based on credentials.
 *
 * NOTE: The actual entitlement check (internal / paid / none) is now
 * performed by the platform when the request arrives. The CLI simply
 * checks whether credentials exist locally — if they do, the request
 * proceeds and the platform enforces policy. If no credentials exist,
 * the CLI blocks early to avoid a guaranteed 401.
 */
export function checkExecutionGate(command: string): ExecutionGateResult {
  // Identity/help commands always allowed — transport-level bypass
  if (ALLOWED_COMMANDS.has(command)) {
    return { allowed: true };
  }

  // Check if any credentials exist (API key or auth token)
  // This is NOT policy enforcement — it's a pre-flight check to avoid
  // sending unauthenticated requests that will always fail.
  const hasCredentials = !!(
    process.env['AGENTICS_API_KEY'] ||
    process.env['AGENTICS_AUTH_TOKEN'] ||
    process.env['AGENTICS_USER_EMAIL'] ||
    process.env['AGENTICS_INTERNAL_KEY']
  );

  if (hasCredentials) {
    return { allowed: true };
  }

  // No credentials at all — block early rather than send a doomed request
  return {
    allowed: false,
    exitCode: EXECUTION_BLOCKED_EXIT_CODE,
    message: BLOCKED_MESSAGE,
  };
}

/**
 * Enforce the execution gate. Exits the process if blocked.
 */
export function enforceExecutionGate(command: string): void {
  const result = checkExecutionGate(command);
  if (!result.allowed) {
    console.error(result.message);
    process.exit(result.exitCode);
  }
}

/**
 * @deprecated Entitlement resolution is now platform-side.
 * This stub checks for credential presence only — not entitlement type.
 */
export function resolveEntitlement(): Entitlement {
  const hasCredentials = !!(
    process.env['AGENTICS_API_KEY'] ||
    process.env['AGENTICS_AUTH_TOKEN'] ||
    process.env['AGENTICS_INTERNAL_KEY']
  );
  // Return 'paid' if any credential exists; the platform will resolve actual entitlement.
  return hasCredentials ? 'paid' : 'none';
}

/**
 * @deprecated Use checkExecutionGate() instead.
 */
export function isExecutionEnabled(): boolean {
  return checkExecutionGate('_check').allowed;
}

/**
 * Get the list of commands that bypass the execution gate.
 */
export function getAllowedCommands(): ReadonlySet<string> {
  return ALLOWED_COMMANDS;
}
