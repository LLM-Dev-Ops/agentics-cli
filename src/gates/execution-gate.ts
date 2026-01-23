/**
 * Execution Gate Module
 *
 * HARD EXECUTION KILL-SWITCH
 *
 * PURPOSE: Global execution gate that prevents all operational commands from running
 *          unless execution is explicitly enabled. This is a binary gate enforced
 *          BEFORE any entitlement, usage, or billing logic.
 *
 * ENTITLEMENTS:
 * - "internal" - Internal maintainers (allow-listed by email)
 * - Standard entitlements follow existing payment/execution logic
 *
 * FORBIDDEN:
 * - Consulting usage or billing for internal users
 * - Allowing partial execution
 * - Allowing "free tier" commands
 *
 * This is a hard kill-switch, not a pricing feature.
 */

import { EXIT_CODES } from '../types/index.js';
import { getActiveAccount } from '../auth/gcp-identity.js';

// ============================================================================
// Execution Gate Configuration
// ============================================================================

/**
 * HARD KILL-SWITCH: Execution is DISABLED by default.
 *
 * To enable execution, set environment variable:
 *   AGENTICS_EXECUTION_ENABLED=true
 *
 * This gate decides IF execution is possible at all.
 */
const EXECUTION_ENABLED = process.env.AGENTICS_EXECUTION_ENABLED === 'true';

/**
 * Commands that are ALWAYS allowed, regardless of execution gate status.
 * These are identity and help commands only.
 */
const ALLOWED_COMMANDS = new Set([
  'login',
  'logout',
  'whoami',
  'help',
  'version',
]);

// ============================================================================
// Internal Entitlement Configuration
// ============================================================================

/**
 * Entitlement types supported by the execution gate.
 */
export type Entitlement = 'internal' | 'paid' | 'none';

/**
 * INTERNAL_EMAILS: Authoritative allow-list for internal maintainers.
 *
 * Users with emails in this list are granted the "internal" entitlement,
 * which allows full CLI execution without payment verification.
 *
 * This is a first-class entitlement, not a bypass or debug shortcut.
 */
const INTERNAL_EMAILS: ReadonlySet<string> = new Set([
  'nick@nicholasruest.com',
  'sales@globalbusinessadvisors.co',
  'nicholasruest1@gmail.com',
  'nick.ruest@agentics.org',
  'ruv@ruv.net',
  'ruv@agentics.org',
  'cvsrohit@gmail.com',
  'rishubcheddlla@gmail.com',
]);

/**
 * Resolve the entitlement for the currently authenticated user.
 *
 * @returns The user's entitlement: 'internal' for allow-listed users, 'none' otherwise
 */
export function resolveEntitlement(): Entitlement {
  const account = getActiveAccount();

  if (account && INTERNAL_EMAILS.has(account.toLowerCase())) {
    return 'internal';
  }

  // Future: Check for paid entitlements via payment service
  // For now, return 'none' to fall through to existing execution gate logic
  return 'none';
}

/**
 * Exit code for blocked execution.
 * Uses PERMISSION_DENIED (77) to indicate access is denied.
 */
export const EXECUTION_BLOCKED_EXIT_CODE = EXIT_CODES.PERMISSION_DENIED;

// ============================================================================
// Execution Gate Error Message
// ============================================================================

const BLOCKED_MESSAGE = `
❌ Execution Disabled

This command requires an active Agentics execution environment.

The Agentics CLI is currently in explore-only mode.

Contact the Agentics team to enable execution.
`.trim();

// ============================================================================
// Execution Gate Implementation
// ============================================================================

export interface ExecutionGateResult {
  allowed: boolean;
  exitCode?: number;
  message?: string;
}

/**
 * Check if a command is allowed to execute.
 *
 * This is the SINGLE, CENTRALIZED execution gate.
 * It must be called BEFORE:
 *   - command parsing (post-parse)
 *   - network calls
 *   - domain service invocation
 *
 * Execution flow:
 *   1. Always allow identity and help commands
 *   2. Resolve user entitlement
 *   3. If entitlement === "internal" → allow execution
 *   4. If EXECUTION_ENABLED === true → allow execution
 *   5. Otherwise → block execution
 *
 * @param command - The command name (e.g., 'plan', 'simulate', 'login')
 * @returns ExecutionGateResult indicating if execution is allowed
 */
export function checkExecutionGate(command: string): ExecutionGateResult {
  // Always allow identity and help commands
  if (ALLOWED_COMMANDS.has(command)) {
    return { allowed: true };
  }

  // Resolve entitlement before applying execution gate
  const entitlement = resolveEntitlement();

  // Internal users have full access - this is a first-class entitlement
  if (entitlement === 'internal') {
    return { allowed: true };
  }

  // If execution is enabled, allow all commands
  if (EXECUTION_ENABLED) {
    return { allowed: true };
  }

  // Block all other commands
  return {
    allowed: false,
    exitCode: EXECUTION_BLOCKED_EXIT_CODE,
    message: BLOCKED_MESSAGE,
  };
}

/**
 * Enforce the execution gate. Exits the process if blocked.
 *
 * @param command - The command name to check
 */
export function enforceExecutionGate(command: string): void {
  const result = checkExecutionGate(command);

  if (!result.allowed) {
    console.error(result.message);
    process.exit(result.exitCode);
  }
}

/**
 * Check if execution is globally enabled.
 *
 * @returns true if execution is enabled, false otherwise
 */
export function isExecutionEnabled(): boolean {
  return EXECUTION_ENABLED;
}

/**
 * Get the list of commands that are always allowed.
 *
 * @returns Set of allowed command names
 */
export function getAllowedCommands(): ReadonlySet<string> {
  return ALLOWED_COMMANDS;
}
