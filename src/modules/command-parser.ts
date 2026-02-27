/**
 * Command Parsing Module (Module A)
 *
 * SPARC Architecture Reference: §2.2
 *
 * PURPOSE: Parse CLI arguments and flags into structured objects
 *
 * DEPENDENCIES: Standard Library ONLY
 *
 * FORBIDDEN:
 * - Business Logic (NO interpretation of command semantics)
 * - Validation beyond format (NO validation of business rules)
 * - Downstream-specific logic
 */

import type { CommandObject } from '../types/index.js';
import { ValidationError } from '../errors/index.js';

// ============================================================================
// Interface Definition
// ============================================================================

export interface ICommandParser {
  parse(args: string[]): CommandObject;
}

// ============================================================================
// Command Definitions
// ============================================================================

export const SUPPORTED_COMMANDS = [
  'login',
  'logout',
  'whoami',
  'plan',
  'simulate',
  'inspect',
  'quantify',
  'deploy',
  'export',
  'erp',
  'diligence',
  'usage',
  'policy',
  'agents',
  'audit',
  'readiness',
  'demo',
  'ask',
  'phase2',
  'version',
  'help',
] as const;

export type SupportedCommand = (typeof SUPPORTED_COMMANDS)[number];

// ============================================================================
// Command Parser Implementation
// ============================================================================

export class CommandParser implements ICommandParser {
  parse(args: string[]): CommandObject {
    const flags: Record<string, boolean> = {};
    const options: Record<string, string> = {};
    const positionalArgs: string[] = [];

    let command = '';
    let subcommand: string | undefined;
    let expectingValue: string | null = null;

    for (let i = 0; i < args.length; i++) {
      const arg = args[i];

      if (arg === undefined) continue;

      // Handle expected value from previous flag
      if (expectingValue !== null) {
        options[expectingValue] = arg;
        expectingValue = null;
        continue;
      }

      // Handle long options (--option=value or --option value)
      if (arg.startsWith('--')) {
        const withoutDashes = arg.slice(2);
        const equalsIndex = withoutDashes.indexOf('=');

        if (equalsIndex !== -1) {
          const key = withoutDashes.slice(0, equalsIndex);
          const value = withoutDashes.slice(equalsIndex + 1);
          if (value === '' || value === 'true') {
            flags[key] = true;
          } else if (value === 'false') {
            flags[key] = false;
          } else {
            options[key] = value;
          }
        } else {
          // Boolean flag or option expecting value
          const key = withoutDashes;
          const nextArg = args[i + 1];

          if (nextArg && !nextArg.startsWith('-')) {
            // Could be a value for this option
            if (this.isKnownBooleanFlag(key)) {
              flags[key] = true;
            } else {
              expectingValue = key;
            }
          } else {
            flags[key] = true;
          }
        }
        continue;
      }

      // Handle short options (-o value or -v)
      if (arg.startsWith('-') && arg.length > 1) {
        const key = arg.slice(1);

        if (key.length === 1) {
          // Single character flag
          const expanded = this.expandShortFlag(key);
          const nextArg = args[i + 1];

          if (nextArg && !nextArg.startsWith('-') && !this.isKnownBooleanFlag(expanded)) {
            expectingValue = expanded;
          } else {
            flags[expanded] = true;
          }
        } else {
          // Multiple short flags (-abc = -a -b -c)
          for (const char of key) {
            flags[this.expandShortFlag(char)] = true;
          }
        }
        continue;
      }

      // Positional arguments
      if (!command) {
        command = arg;
      } else if (!subcommand && this.commandHasSubcommands(command)) {
        subcommand = arg;
      } else {
        positionalArgs.push(arg);
      }
    }

    // Validate we have a command
    if (!command) {
      throw new ValidationError({
        message: 'No command specified',
        field: 'command',
        expected: SUPPORTED_COMMANDS.join(' | '),
        actual: 'none',
      });
    }

    return {
      command,
      subcommand,
      flags,
      options,
      positionalArgs,
    };
  }

  private isKnownBooleanFlag(key: string): boolean {
    const booleanFlags = [
      'verbose', 'v',
      'quiet', 'q',
      'help', 'h',
      'version', 'V',
      'debug',
      'dry-run',
      'force', 'f',
      'pretty',
      'colorize',
      'latest',
    ];
    return booleanFlags.includes(key);
  }

  private expandShortFlag(char: string): string {
    const expansions: Record<string, string> = {
      'v': 'verbose',
      'q': 'quiet',
      'h': 'help',
      'V': 'version',
      'f': 'force',
      'o': 'output',
      't': 'timeout',
      'c': 'config',
    };
    return expansions[char] ?? char;
  }

  private commandHasSubcommands(command: string): boolean {
    const commandsWithSubcommands = ['audit', 'inspect', 'policy', 'plan', 'simulate', 'quantify', 'deploy', 'export', 'erp', 'usage', 'readiness', 'demo', 'agents'];
    return commandsWithSubcommands.includes(command);
  }
}

// ============================================================================
// Factory Function
// ============================================================================

export function createCommandParser(): ICommandParser {
  return new CommandParser();
}
