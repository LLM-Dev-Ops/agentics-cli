/**
 * Lineage Gate — Gate 6 (ADR-004 Enforcement)
 *
 * PURPOSE: Enforce that artifact-producing commands reference a valid
 * simulation parent. No integration proposal or ERP mapping may
 * exist without traceability to a governed simulation.
 *
 * INVARIANTS ENFORCED:
 * - ADR-004 Invariant 2: Every integration/ERP mapping derives from a simulation
 * - ADR-004 Invariant 3: No integration proposal without traceability
 * - ADR-004 Invariant 7: CLI is only path for artifact creation
 *
 * EXIT CODE: 110 (LINEAGE_VIOLATION)
 *
 * BEHAVIOR:
 * - Commands that produce enterprise artifacts (erp surface, erp map,
 *   erp export) must pass a simulation_id in their positional args
 *   or flags when the lineage gate is enabled.
 * - Commands that do not produce artifacts (list, inspect, help)
 *   are exempt from lineage validation.
 * - The gate validates that simulation_id is present and non-empty.
 *   Whether the simulation exists in Ruvector is validated at the
 *   command level, not at the gate level (gate is synchronous).
 */

import type { CommandObject } from '../types/index.js';
import { validateTraceability } from '../enterprise/lineage.js';

// ============================================================================
// Constants
// ============================================================================

export const LINEAGE_VIOLATION_EXIT_CODE = 110;

/**
 * Commands that produce enterprise artifacts requiring lineage.
 * These commands must reference a simulation_id.
 */
const LINEAGE_REQUIRED_COMMANDS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['erp', new Set(['surface', 'map', 'export'])],
]);

/**
 * Commands exempt from lineage validation.
 * These commands are read-only or do not produce artifacts.
 */
const LINEAGE_EXEMPT_COMMANDS: ReadonlySet<string> = new Set([
  'help',
  'version',
  'login',
  'logout',
  'whoami',
  'usage',
]);

// ============================================================================
// Gate Result Type
// ============================================================================

export interface LineageGateResult {
  /** Whether the command passed lineage validation */
  allowed: boolean;
  /** Error message if validation failed */
  message: string;
  /** Exit code if validation failed */
  exitCode: number;
  /** Whether this command requires lineage */
  lineageRequired: boolean;
}

// ============================================================================
// Gate Implementation
// ============================================================================

/**
 * Check whether a command passes lineage validation.
 * Returns a result indicating whether the command is allowed.
 *
 * Lineage is required when:
 * 1. The command is in LINEAGE_REQUIRED_COMMANDS
 * 2. The command is not in LINEAGE_EXEMPT_COMMANDS
 * 3. The command produces enterprise artifacts
 */
export function checkLineageGate(cmd: CommandObject): LineageGateResult {
  const primary = cmd.command;
  const sub = cmd.subcommand;

  // Exempt commands skip lineage validation
  if (LINEAGE_EXEMPT_COMMANDS.has(primary)) {
    return { allowed: true, message: '', exitCode: 0, lineageRequired: false };
  }

  // Check if this command+subcommand requires lineage
  const requiredSubs = LINEAGE_REQUIRED_COMMANDS.get(primary);
  if (!requiredSubs || !sub || !requiredSubs.has(sub)) {
    return { allowed: true, message: '', exitCode: 0, lineageRequired: false };
  }

  // This command requires lineage — check for simulation_id
  // simulation_id can be provided as:
  // 1. A flag: --simulation-id <id>
  // 2. An option: simulation_id in options
  // 3. The first positional arg (for commands that take simulation_id as primary arg)
  const simulationId =
    (cmd.options['simulation-id'] as string | undefined) ??
    (cmd.options['simulation_id'] as string | undefined) ??
    (cmd.flags['simulation-id'] as string | undefined) ??
    undefined;

  const validation = validateTraceability(simulationId, `${primary} ${sub}`);

  if (!validation.valid) {
    return {
      allowed: false,
      message: `Lineage violation: ${validation.message}\n` +
        `Usage: agentics ${primary} ${sub} --simulation-id <simulation_id>\n` +
        `\n` +
        `Enterprise artifacts must trace to a governed simulation (ADR-004).`,
      exitCode: LINEAGE_VIOLATION_EXIT_CODE,
      lineageRequired: true,
    };
  }

  return { allowed: true, message: '', exitCode: 0, lineageRequired: true };
}

/**
 * Enforce lineage gate — exits the process if validation fails.
 */
export function enforceLineageGate(cmd: CommandObject): void {
  const result = checkLineageGate(cmd);
  if (!result.allowed) {
    console.error(JSON.stringify({
      error: {
        code: 'LINEAGE_VIOLATION',
        message: result.message,
        command: `${cmd.command} ${cmd.subcommand ?? ''}`.trim(),
        exit_code: result.exitCode,
        adr: 'ADR-004',
      },
    }));
    process.exit(result.exitCode);
  }
}

/**
 * Check if a command requires lineage validation.
 */
export function requiresLineageValidation(primary: string, sub?: string): boolean {
  if (LINEAGE_EXEMPT_COMMANDS.has(primary)) return false;
  const requiredSubs = LINEAGE_REQUIRED_COMMANDS.get(primary);
  if (!requiredSubs) return false;
  if (!sub) return false;
  return requiredSubs.has(sub);
}
