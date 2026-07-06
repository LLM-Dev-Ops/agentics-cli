/**
 * Execution Gate Module — Credential Pre-flight
 *
 * ARCHITECTURE:
 *   The CLI does NOT resolve entitlements, maintain email allowlists,
 *   or enforce access policy locally. Authorization is a platform concern.
 *
 *   This gate checks whether ANY credential source exists before sending
 *   a request that would be guaranteed to 401. It checks:
 *     1. Environment variables (AGENTICS_API_KEY, AGENTICS_AUTH_TOKEN, etc.)
 *     2. Stored credentials from `agentics login`
 *
 *   If any credential exists, the request proceeds and the platform
 *   enforces actual policy.
 */

import { EXIT_CODES } from '../types/index.js';
import { createCredentialStore } from '../utils/credentials.js';

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
  // ADR-PIPELINE-088: read-only status probe of local run directory. No
  // network calls, no platform interaction — pure filesystem read. Bypassing
  // the auth gate lets MCP-side `agentics-status` calls work even when the
  // calling session has no credentials cached (e.g. a fresh Claude Code
  // session polling a trace id from a prior run).
  'status',
  // ADR-PIPELINE-119: `verify` is an offline, read-only hash+signature check of
  // a decision pack on disk — no platform interaction, so no credentials needed.
  'verify',
  // Internal helper invoked by the MCP fast-return path. It runs
  // executeAutoChain which does need credentials, but those are inherited
  // from the parent's env; the gate check is redundant for the hidden
  // subcommand and costs an extra round-trip to the credential store.
  '_autochain',
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

No valid credentials found. To authenticate:

  Option 1: Platform login (recommended)
    agentics login

  Option 2: API key via environment variable
    export AGENTICS_API_KEY=agentics_sk_...

`.trim();

// ============================================================================
// Execution Gate — Credential Pre-flight
// ============================================================================

/**
 * Check if a command is allowed to execute.
 *
 * For identity/help commands: always allowed (transport-level).
 * For all other commands: checks whether any credential source exists.
 * The platform decides actual authorization when the request arrives.
 */
export async function checkExecutionGate(command: string): Promise<ExecutionGateResult> {
  // Identity/help commands always allowed — transport-level bypass
  if (ALLOWED_COMMANDS.has(command)) {
    return { allowed: true };
  }

  // 1. Check environment variables
  const hasEnvCredentials = !!(
    process.env['AGENTICS_API_KEY'] ||
    process.env['AGENTICS_AUTH_TOKEN'] ||
    process.env['AGENTICS_USER_EMAIL'] ||
    process.env['AGENTICS_INTERNAL_KEY']
  );

  if (hasEnvCredentials) {
    return { allowed: true };
  }

  // 2. Check stored credentials from `agentics login`
  try {
    const store = createCredentialStore();
    const credentials = await store.load();
    if (credentials && credentials.api_key) {
      return { allowed: true };
    }
  } catch {
    // Stored credential check failed — continue to next source
  }

  // No credentials found from any source
  return {
    allowed: false,
    exitCode: EXECUTION_BLOCKED_EXIT_CODE,
    message: BLOCKED_MESSAGE,
  };
}

/**
 * Enforce the execution gate. Exits the process if blocked.
 */
export async function enforceExecutionGate(command: string): Promise<void> {
  const result = await checkExecutionGate(command);
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
  return hasCredentials ? 'paid' : 'none';
}

/**
 * @deprecated Use checkExecutionGate() instead.
 */
export async function isExecutionEnabled(): Promise<boolean> {
  const result = await checkExecutionGate('_check');
  return result.allowed;
}

/**
 * Get the list of commands that bypass the execution gate.
 */
export function getAllowedCommands(): ReadonlySet<string> {
  return ALLOWED_COMMANDS;
}
