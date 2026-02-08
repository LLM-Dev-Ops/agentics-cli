/**
 * Execution Gate Module
 *
 * PURPOSE: Global execution gate that controls command access based on
 *          user entitlement (internal email or paid API key).
 *
 * ENTITLEMENTS:
 * - "internal" - Internal maintainers (allow-listed by email)
 * - "paid" - Users with a valid API key
 * - "none" - No entitlement, blocked from operational commands
 *
 * LOGIC:
 * - Identity commands (login, logout, whoami, help, version) always allowed
 * - Internal or paid users get full access to all commands
 * - Users with no entitlement are blocked
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { EXIT_CODES } from '../types/index.js';
import type { AuthCredentials } from '../types/index.js';
import { getActiveAccount } from '../auth/gcp-identity.js';

// ============================================================================
// Execution Gate Configuration
// ============================================================================

/**
 * Commands that are ALWAYS allowed, regardless of entitlement.
 * These are identity and help commands only.
 */
const ALLOWED_COMMANDS = new Set([
  'login',
  'logout',
  'whoami',
  'help',
  'version',
  'demo',
]);

// ============================================================================
// Internal Entitlement Configuration
// ============================================================================

/**
 * Entitlement types supported by the execution gate.
 */
export type Entitlement = 'internal' | 'paid' | 'none';

/**
 * Default internal emails (fallback if config file doesn't exist).
 */
const DEFAULT_INTERNAL_EMAILS = [
  'nick@nicholasruest.com',
  'sales@globalbusinessadvisors.co',
  'nicholasruest1@gmail.com',
  'nick.ruest@agentics.org',
  'ruv@ruv.net',
  'ruv@agentics.org',
  'cvsrohit@gmail.com',
  'rishubcheddlla@gmail.com',
];

/**
 * Load internal emails from config file or use defaults.
 * Config file: ~/.agentics/internal-users.json
 * Format: { "emails": ["email1@example.com", "email2@example.com"] }
 */
function loadInternalEmails(): Set<string> {
  try {
    const configPath = path.join(os.homedir(), '.agentics', 'internal-users.json');
    if (fs.existsSync(configPath)) {
      const content = fs.readFileSync(configPath, 'utf-8');
      const config = JSON.parse(content);
      if (Array.isArray(config.emails)) {
        return new Set(config.emails.map((e: string) => e.toLowerCase()));
      }
    }
  } catch {
    // Config file doesn't exist or is invalid, use defaults
  }

  // Create default config file if it doesn't exist
  try {
    const configDir = path.join(os.homedir(), '.agentics');
    const configPath = path.join(configDir, 'internal-users.json');
    if (!fs.existsSync(configPath)) {
      if (!fs.existsSync(configDir)) {
        fs.mkdirSync(configDir, { recursive: true });
      }
      fs.writeFileSync(configPath, JSON.stringify({ emails: DEFAULT_INTERNAL_EMAILS }, null, 2));
    }
  } catch {
    // Failed to create config file, continue with defaults
  }

  return new Set(DEFAULT_INTERNAL_EMAILS.map(e => e.toLowerCase()));
}

// Load internal emails once at startup
const INTERNAL_EMAILS = loadInternalEmails();

/**
 * Resolve the entitlement for the currently authenticated user.
 *
 * Checks in order:
 * 1. AGENTICS_USER_EMAIL environment variable
 * 2. Email stored in credentials file (~/.agentics/credentials.json)
 * 3. gcloud authenticated account
 *
 * @returns The user's entitlement: 'internal' for allow-listed users, 'none' otherwise
 */
export function resolveEntitlement(): Entitlement {
  // Check environment variable first (simplest path for internal users)
  const envEmail = process.env['AGENTICS_USER_EMAIL'];
  if (envEmail && INTERNAL_EMAILS.has(envEmail.toLowerCase())) {
    return 'internal';
  }

  // Check stored credentials for email and payment status
  const storedCreds = getStoredCredentials();
  if (storedCreds?.email && INTERNAL_EMAILS.has(storedCreds.email.toLowerCase())) {
    return 'internal';
  }

  // Check if API key holder has paid status
  if (storedCreds?.api_key && storedCreds.payment_status === 'paid') {
    return 'paid';
  }

  // Fall back to gcloud account
  const account = getActiveAccount();
  if (account && INTERNAL_EMAILS.has(account.toLowerCase())) {
    return 'internal';
  }

  // If user has a valid API key, treat as paid (API keys are issued to paying users)
  if (storedCreds?.api_key) {
    return 'paid';
  }

  return 'none';
}

/**
 * Read stored credentials (sync).
 */
function getStoredCredentials(): AuthCredentials | null {
  try {
    const credPath = path.join(os.homedir(), '.agentics', 'credentials.json');
    const content = fs.readFileSync(credPath, 'utf-8');
    const creds = JSON.parse(content) as AuthCredentials;
    if (!creds.api_key) return null;
    return creds;
  } catch {
    return null;
  }
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
 *   3. If entitlement === "internal" or "paid" → allow execution
 *   4. Otherwise → block execution
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

  // Internal users have full access
  if (entitlement === 'internal') {
    return { allowed: true };
  }

  // Paid users have full access
  if (entitlement === 'paid') {
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
 * Check if execution is enabled for the current user.
 *
 * @returns true if the user has internal or paid entitlement
 */
export function isExecutionEnabled(): boolean {
  const entitlement = resolveEntitlement();
  return entitlement === 'internal' || entitlement === 'paid';
}

/**
 * Get the list of commands that are always allowed.
 *
 * @returns Set of allowed command names
 */
export function getAllowedCommands(): ReadonlySet<string> {
  return ALLOWED_COMMANDS;
}
