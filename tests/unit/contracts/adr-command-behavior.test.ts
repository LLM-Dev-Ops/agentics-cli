/**
 * ADR-002 Decision 3, Rule 5: Command Behavior Tests
 * CI Check: ADR-002.D3.R5
 *
 * Auto-generates test cases from COMMAND_REGISTRY entries:
 * - ID args reject NL input
 * - SYNTHESIS_FORBIDDEN rejects NL arguments
 * - requiresConfirmation rejects without --force
 * - Required args produce instructional errors when missing
 */

import {
  checkArgumentGuard,
} from '../../../src/gates/argument-guard.js';
import {
  COMMAND_REGISTRY,
} from '../../../src/contracts/adr-command-semantics.js';
import { EXIT_CODES } from '../../../src/types/index.js';
import type { CommandObject } from '../../../src/types/index.js';

// ============================================================================
// Helpers
// ============================================================================

function makeCmd(
  command: string,
  subcommand?: string,
  positionalArgs: string[] = [],
  flags: Record<string, boolean> = {},
): CommandObject {
  return { command, subcommand, flags, options: {}, positionalArgs };
}

// ============================================================================
// Auto-generated: ID args reject NL input
// ============================================================================

describe('ADR-002.D3.R5: ID arguments reject natural language input', () => {
  const idCommands = COMMAND_REGISTRY.filter(
    spec => spec.args.some(a => a.type === 'ID' && a.required)
  );

  test.each(idCommands.map(s => [s.command, s.primary, s.subcommand] as const))(
    '%s rejects NL where ID expected',
    (_command, primary, subcommand) => {
      const cmd = makeCmd(
        primary,
        subcommand,
        ['run a big enterprise simulation for cloud migration'],
        { force: true },
      );
      const result = checkArgumentGuard(cmd);
      expect(result.allowed).toBe(false);
      expect(result.exitCode).toBe(EXIT_CODES.ARG_VALIDATION_ERROR);
      expect(result.message).toBeDefined();
    }
  );
});

// ============================================================================
// Auto-generated: SYNTHESIS_FORBIDDEN rejects NL arguments
// ============================================================================

describe('ADR-002.D3.R5: SYNTHESIS_FORBIDDEN commands reject NL on ID args', () => {
  const forbiddenWithIdArgs = COMMAND_REGISTRY.filter(
    spec => spec.synthesis === 'SYNTHESIS_FORBIDDEN' &&
            spec.args.some(a => a.type === 'ID' && a.required)
  );

  test.each(forbiddenWithIdArgs.map(s => [s.command, s.primary, s.subcommand] as const))(
    '%s (SYNTHESIS_FORBIDDEN) rejects NL input',
    (_command, primary, subcommand) => {
      const cmd = makeCmd(
        primary,
        subcommand,
        ['deploy to production now with extra stuff'],
        { force: true },
      );
      const result = checkArgumentGuard(cmd);
      expect(result.allowed).toBe(false);
    }
  );
});

// ============================================================================
// Auto-generated: requiresConfirmation rejects without --force
// ============================================================================

describe('ADR-002.D3.R5: requiresConfirmation commands reject without --force', () => {
  const confirmationCommands = COMMAND_REGISTRY.filter(
    spec => spec.requiresConfirmation
  );

  expect(confirmationCommands.length).toBeGreaterThan(0);

  test.each(confirmationCommands.map(s => [s.command, s.primary, s.subcommand, s.args] as const))(
    '%s requires --force flag',
    (_command, primary, subcommand, args) => {
      // Build valid positional args (use examples as values)
      const positionalArgs = args
        .filter(a => a.required)
        .map(a => a.example.replace(/^["']|["']$/g, ''));

      // Without --force: should be rejected
      const cmdNoForce = makeCmd(primary, subcommand, positionalArgs, {});
      const resultNoForce = checkArgumentGuard(cmdNoForce);
      expect(resultNoForce.allowed).toBe(false);
      expect(resultNoForce.exitCode).toBe(EXIT_CODES.ARG_VALIDATION_ERROR);
      expect(resultNoForce.message).toContain('--force');

      // With --force: should be allowed
      const cmdWithForce = makeCmd(primary, subcommand, positionalArgs, { force: true });
      const resultWithForce = checkArgumentGuard(cmdWithForce);
      expect(resultWithForce.allowed).toBe(true);
    }
  );
});

// ============================================================================
// Auto-generated: Required args produce instructional errors
// ============================================================================

describe('ADR-002.D3.R5: Missing required args produce instructional errors', () => {
  const commandsWithRequiredArgs = COMMAND_REGISTRY.filter(
    spec => spec.args.some(a => a.required)
  );

  test.each(commandsWithRequiredArgs.map(s => [s.command, s.primary, s.subcommand] as const))(
    '%s with no args produces instructional error',
    (_command, primary, subcommand) => {
      const cmd = makeCmd(primary, subcommand, []);
      const result = checkArgumentGuard(cmd);
      expect(result.allowed).toBe(false);
      expect(result.exitCode).toBe(EXIT_CODES.ARG_VALIDATION_ERROR);
      expect(result.message).toContain('Usage:');
      expect(result.message).toContain('agentics');
    }
  );
});
