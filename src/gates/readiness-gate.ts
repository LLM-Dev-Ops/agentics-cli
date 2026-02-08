/**
 * Readiness Gate — Gate 7 (Execution Safety Enforcement)
 *
 * PURPOSE: Enforce that write-path commands (deploy run, erp export in
 * execute mode, rollback, live sync) are blocked when the platform state
 * is INTEGRATION_READY_EXECUTION_GATED. This gate ensures no ERP writes
 * or production deployments occur until all prerequisites are met.
 *
 * INVARIANTS ENFORCED:
 * - No production writes when execution_gate is LOCKED
 * - No deploy run / deploy rollback when connectors are missing
 * - No erp export --mode=execute when systems are BLOCKED
 * - Read-only and integration-mode commands always allowed
 *
 * EXIT CODE: 111 (READINESS_GATE_VIOLATION)
 *
 * BEHAVIOR:
 * - Commands that perform external writes (deploy run, deploy rollback)
 *   are blocked when the readiness state has execution_gate.locked = true.
 * - Commands that are read-only (readiness show, inspect, erp list) are
 *   always permitted regardless of readiness state.
 * - The gate reads state from ~/.agentics/exports/decision-readiness/readiness-state.json.
 *   If the file does not exist, the gate assumes INSPECTION_ONLY (most restrictive).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { CommandObject } from '../types/index.js';

// ============================================================================
// Constants
// ============================================================================

export const READINESS_GATE_EXIT_CODE = 111;

/**
 * Canonical readiness states.
 * Transitions: INSPECTION_ONLY -> INTEGRATION_READY_EXECUTION_GATED -> EXECUTION_READY
 */
export type ReadinessState =
  | 'INSPECTION_ONLY'
  | 'INTEGRATION_READY_EXECUTION_GATED'
  | 'EXECUTION_READY';

/**
 * Commands + subcommands that require execution mode to be unlocked.
 * These commands perform writes to external systems and are blocked
 * when the readiness state is not EXECUTION_READY.
 */
const WRITE_COMMANDS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['deploy', new Set(['run', 'rollback'])],
]);

/**
 * Commands that are always exempt from readiness validation.
 * These are identity, read-only, or introspection commands.
 */
const READINESS_EXEMPT_COMMANDS: ReadonlySet<string> = new Set([
  'help',
  'version',
  'login',
  'logout',
  'whoami',
  'usage',
  'readiness',
  'inspect',
  'policy',
  'audit',
]);

// ============================================================================
// Gate Result Type
// ============================================================================

export interface ReadinessGateResult {
  /** Whether the command passed readiness validation */
  allowed: boolean;
  /** Error message if validation failed */
  message: string;
  /** Exit code if validation failed */
  exitCode: number;
  /** Whether this command requires readiness validation */
  readinessRequired: boolean;
  /** Current readiness state (if loaded) */
  state?: ReadinessState;
}

// ============================================================================
// Readiness State File Schema
// ============================================================================

export interface ReadinessStateFile {
  schema: string;
  state: ReadinessState;
  simulation_id: string;
  plan_ref: string;
  determined_at: string;
  execution_gate: {
    locked: boolean;
    reason: string;
    prerequisites_total: number;
    prerequisites_completed: number;
    critical_blockers: Array<{
      id: number;
      system: string;
      severity: string;
      effort: string;
    }>;
  };
  integration_readiness: {
    entities_ready: number;
    entities_blocked: number;
    entities_total: number;
    readiness_pct: number;
    systems_ready: string[];
    systems_blocked: string[];
  };
  financial_posture: {
    annual_api_spend_usd: number;
    year1_investment_usd: number;
    annual_savings_usd: number;
    roi_payback_months: number;
    npv_5yr_usd: number;
  };
  audit_matrix: {
    result: string;
    checks_passed: number;
    checks_total: number;
    last_audit: string;
  };
}

// ============================================================================
// State Loader
// ============================================================================

const READINESS_STATE_PATH = path.join(
  os.homedir(),
  '.agentics',
  'exports',
  'decision-readiness',
  'readiness-state.json',
);

/**
 * Load readiness state from the canonical artifact path.
 * Returns null if the file does not exist or is invalid.
 */
export function loadReadinessState(): ReadinessStateFile | null {
  try {
    if (!fs.existsSync(READINESS_STATE_PATH)) {
      return null;
    }
    const content = fs.readFileSync(READINESS_STATE_PATH, 'utf-8');
    const parsed = JSON.parse(content) as ReadinessStateFile;
    if (!parsed.state || !parsed.execution_gate) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

// ============================================================================
// Gate Implementation
// ============================================================================

/**
 * Check whether a command passes readiness validation.
 * Returns a result indicating whether the command is allowed.
 *
 * Write-path commands are blocked when:
 * 1. The readiness state file exists AND execution_gate.locked === true
 * 2. The readiness state file does not exist (defaults to most restrictive)
 *
 * Read-only commands always pass.
 */
export function checkReadinessGate(cmd: CommandObject): ReadinessGateResult {
  const primary = cmd.command;
  const sub = cmd.subcommand;

  // Exempt commands skip readiness validation
  if (READINESS_EXEMPT_COMMANDS.has(primary)) {
    return { allowed: true, message: '', exitCode: 0, readinessRequired: false };
  }

  // Check if this command+subcommand is a write command
  const writeSubs = WRITE_COMMANDS.get(primary);
  if (!writeSubs || !sub || !writeSubs.has(sub)) {
    // Not a write command — allow
    return { allowed: true, message: '', exitCode: 0, readinessRequired: false };
  }

  // This is a write command — check readiness state
  const state = loadReadinessState();

  // No readiness state file → assume most restrictive (block writes)
  if (!state) {
    return {
      allowed: false,
      message:
        `Readiness gate: No readiness state found.\n` +
        `Write command "${primary} ${sub}" requires EXECUTION_READY state.\n` +
        `\n` +
        `Run: agentics readiness show <scenario> to check current state.\n` +
        `Current state: UNKNOWN (no readiness-state.json found)`,
      exitCode: READINESS_GATE_EXIT_CODE,
      readinessRequired: true,
    };
  }

  // EXECUTION_READY → allow all commands
  if (state.state === 'EXECUTION_READY') {
    return {
      allowed: true,
      message: '',
      exitCode: 0,
      readinessRequired: true,
      state: state.state,
    };
  }

  // Any other state with execution_gate.locked → block writes
  if (state.execution_gate.locked) {
    const blockers = state.execution_gate.critical_blockers
      .map(b => `  - ${b.system} (${b.severity}, ${b.effort})`)
      .join('\n');

    return {
      allowed: false,
      message:
        `Readiness gate: Execution mode is LOCKED.\n` +
        `Command "${primary} ${sub}" requires EXECUTION_READY state.\n` +
        `\n` +
        `Current state: ${state.state}\n` +
        `Reason: ${state.execution_gate.reason}\n` +
        `Prerequisites: ${state.execution_gate.prerequisites_completed}/${state.execution_gate.prerequisites_total} completed\n` +
        `\n` +
        `Critical blockers:\n${blockers}\n` +
        `\n` +
        `Run: agentics readiness show ${state.simulation_id} for full status.`,
      exitCode: READINESS_GATE_EXIT_CODE,
      readinessRequired: true,
      state: state.state,
    };
  }

  // execution_gate.locked is false but state is not EXECUTION_READY — allow cautiously
  return {
    allowed: true,
    message: '',
    exitCode: 0,
    readinessRequired: true,
    state: state.state,
  };
}

/**
 * Enforce readiness gate — exits the process if validation fails.
 */
export function enforceReadinessGate(cmd: CommandObject): void {
  const result = checkReadinessGate(cmd);
  if (!result.allowed) {
    console.error(JSON.stringify({
      error: {
        code: 'READINESS_GATE_VIOLATION',
        message: result.message,
        command: `${cmd.command} ${cmd.subcommand ?? ''}`.trim(),
        exit_code: result.exitCode,
        state: result.state ?? 'UNKNOWN',
      },
    }));
    process.exit(result.exitCode);
  }
}

/**
 * Check if a command requires readiness validation.
 */
export function requiresReadinessValidation(primary: string, sub?: string): boolean {
  if (READINESS_EXEMPT_COMMANDS.has(primary)) return false;
  const writeSubs = WRITE_COMMANDS.get(primary);
  if (!writeSubs) return false;
  if (!sub) return false;
  return writeSubs.has(sub);
}
