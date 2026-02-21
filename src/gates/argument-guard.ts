/**
 * Argument Guard Gate (Gate 5)
 *
 * Runtime validation middleware derived from ADR-001 (Command Argument Semantics).
 * This gate enforces:
 *
 * 1. ID vs Natural Language argument rules
 * 2. Required argument presence
 * 3. Synthesis allow/deny per command
 * 4. Confirmation enforcement for irreversible commands
 * 5. Deterministic, instructional error messages
 *
 * The ADR (adr-command-semantics.ts) is the authoritative policy.
 * This gate is mechanically derived from it.
 */

import type { CommandObject } from '../types/index.js';
import {
  lookupCommand,
  classifyArgument,
  validateArgument,
  type CommandSpec,
  type ArgumentType,
} from '../contracts/adr-command-semantics.js';
import { EXIT_CODES } from '../types/index.js';

// ============================================================================
// Result Types
// ============================================================================

export interface ArgumentGuardResult {
  allowed: boolean;
  exitCode?: number;
  message?: string;
  spec?: CommandSpec;
}

// ============================================================================
// Guard Implementation
// ============================================================================

/**
 * Check if the given command object passes argument validation.
 * Returns a result indicating whether the command may proceed.
 */
export function checkArgumentGuard(cmd: CommandObject): ArgumentGuardResult {
  const { command, subcommand, positionalArgs } = cmd;

  // Step 1: Look up command spec in ADR registry
  const spec = lookupCommand(command, subcommand);

  if (!spec) {
    // Command not in registry. Commands like 'help', 'version' may have
    // no subcommand spec. Allow unregistered commands to pass through
    // (other gates handle unknown commands).
    const primarySpec = lookupCommand(command);
    if (!primarySpec && subcommand) {
      // Try: maybe the subcommand is actually a positional arg
      // for the primary command (e.g., "plan <manifestQuery>")
      const parentSpec = lookupCommand(command);
      if (parentSpec) {
        const modifiedCmd: CommandObject = {
          ...cmd,
          positionalArgs: [subcommand, ...positionalArgs],
        };
        return validateArgs(parentSpec, modifiedCmd);
      }
    }
    // No spec found — allow through (other gates will catch truly invalid commands)
    return { allowed: true };
  }

  // Step 2: Validate argument count, types, and confirmation requirements
  return validateArgs(spec, cmd);
}

/**
 * Validate positional arguments against the command spec.
 * Accepts the full CommandObject to access flags for confirmation checks.
 */
function validateArgs(spec: CommandSpec, cmd: CommandObject): ArgumentGuardResult {
  const positionalArgs = cmd.positionalArgs;
  const requiredArgs = spec.args.filter(a => a.required);

  // Case A: Missing required arguments
  if (requiredArgs.length > 0 && positionalArgs.length < requiredArgs.length) {
    const missing = requiredArgs.slice(positionalArgs.length);
    const missingNames = missing.map(a => `<${a.name}>`).join(' ');
    const examples = missing.map(a => `  ${a.example}  — ${a.description}`).join('\n');

    return {
      allowed: false,
      exitCode: EXIT_CODES.ARG_VALIDATION_ERROR,
      message:
        `Error: Missing required argument${missing.length > 1 ? 's' : ''}: ${missingNames}\n` +
        `\n` +
        `Usage: agentics ${spec.command} ${spec.args.map(a => a.required ? `<${a.name}>` : `[${a.name}]`).join(' ')}\n` +
        `\n` +
        `Expected:\n` +
        `${examples}\n` +
        `\n` +
        formatArgumentTypeHint(missing[0]!.type),
      spec,
    };
  }

  // Case B/C: Wrong argument type
  for (let i = 0; i < spec.args.length && i < positionalArgs.length; i++) {
    const argSpec = spec.args[i]!;
    const argValue = positionalArgs[i]!;
    const error = validateArgument(argValue, argSpec);

    if (error) {
      return {
        allowed: false,
        exitCode: EXIT_CODES.ARG_VALIDATION_ERROR,
        message:
          `Error: Invalid argument for '${spec.command}'\n` +
          `\n` +
          `${error}\n` +
          `\n` +
          `Usage: agentics ${spec.command} ${spec.args.map(a => a.required ? `<${a.name}>` : `[${a.name}]`).join(' ')}`,
        spec,
      };
    }
  }

  // Case D: Synthesis attempted on forbidden command
  // (Checked at the command level — if NL detected on SYNTHESIS_FORBIDDEN)
  if (spec.synthesis === 'SYNTHESIS_FORBIDDEN') {
    for (let i = 0; i < spec.args.length && i < positionalArgs.length; i++) {
      const argSpec = spec.args[i]!;
      if (argSpec.type === 'ID') {
        const detected = classifyArgument(positionalArgs[i]!);
        if (detected === 'NATURAL_LANGUAGE') {
          return {
            allowed: false,
            exitCode: EXIT_CODES.ARG_VALIDATION_ERROR,
            message:
              `Error: Synthesis is not allowed on '${spec.command}'.\n` +
              `\n` +
              `This command requires an ID, not a description.\n` +
              `Natural language input triggers synthesis, which is forbidden for this command.\n` +
              `\n` +
              `Usage: agentics ${spec.command} <${argSpec.name}>\n` +
              `Example: agentics ${spec.command} ${argSpec.example}`,
            spec,
          };
        }
      }
    }
  }

  // Case E: Irreversible command without explicit confirmation (ADR-002 Decision 2, Rule 4)
  if (spec.requiresConfirmation) {
    const hasForceFlag = cmd.flags['force'] === true;
    if (!hasForceFlag) {
      const argsUsage = spec.args.map(a => a.required ? `<${a.name}>` : `[${a.name}]`).join(' ');
      return {
        allowed: false,
        exitCode: EXIT_CODES.ARG_VALIDATION_ERROR,
        message:
          `Error: Command '${spec.command}' requires explicit confirmation.\n` +
          `\n` +
          (spec.irreversible
            ? `This command performs an irreversible operation and cannot be undone.\n`
            : `This command requires confirmation before proceeding.\n`) +
          `You must provide the --force flag to confirm.\n` +
          `\n` +
          `Usage: agentics ${spec.command} ${argsUsage} --force`,
        spec,
      };
    }
  }

  return { allowed: true, spec };
}

/**
 * Generate a hint string for the expected argument type.
 */
function formatArgumentTypeHint(type: ArgumentType): string {
  switch (type) {
    case 'ID':
      return 'Hint: IDs are lowercase, hyphenated identifiers or UUIDs.\n' +
             '      They resolve to persisted objects. Never use quoted text here.';
    case 'NATURAL_LANGUAGE':
      return 'Hint: Descriptions must be quoted natural language strings.\n' +
             '      They seed synthesis to create new resources.';
    case 'SELECTOR':
      return 'Hint: Selectors are keywords like "latest" or UUIDs.\n' +
             '      They select existing resources without triggering synthesis.';
  }
}

// ============================================================================
// Gate Enforcement
// ============================================================================

/**
 * Enforce the argument guard. Exits the process on failure.
 * Follows the same pattern as other gates (execution-gate, auth-session-gate).
 */
export function enforceArgumentGuard(cmd: CommandObject): void {
  const result = checkArgumentGuard(cmd);

  if (!result.allowed) {
    console.error(result.message);
    process.exit(result.exitCode ?? EXIT_CODES.ARG_VALIDATION_ERROR);
  }
}

/**
 * Check if a command requires argument validation.
 * Built-in commands (help, version) are exempt.
 */
export function requiresArgumentValidation(command: string): boolean {
  const exempt = ['help', 'version', 'demo', 'ask'];
  return !exempt.includes(command);
}
