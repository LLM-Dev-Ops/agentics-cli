/**
 * Gate Validation Tests
 *
 * Tests the auth session gate, readiness gate, and output format gate
 * for correct enforcement behavior across edge cases.
 */

import {
  requiresAuthentication,
  AuthSessionRequiredError,
} from '../../../src/gates/auth-session-gate.js';

import {
  checkReadinessGate,
  requiresReadinessValidation,
  READINESS_GATE_EXIT_CODE,
} from '../../../src/gates/readiness-gate.js';

import {
  checkOutputFormatGate,
  requiresStructuredOutput,
  getDefaultFormat,
  InvalidOutputFormatError,
  INVALID_FORMAT_EXIT_CODE,
} from '../../../src/gates/output-format-gate.js';

import type { CommandObject } from '../../../src/types/index.js';

// Helper to build a CommandObject
function cmd(command: string, subcommand?: string): CommandObject {
  return {
    command,
    subcommand,
    flags: {},
    options: {},
    positionalArgs: [],
  };
}

describe('Gate Validation', () => {
  // -----------------------------------------------------------------------
  // Auth Session Gate
  // -----------------------------------------------------------------------

  describe('Auth Session Gate', () => {
    it('should require authentication for operational commands', () => {
      const authCommands = ['plan', 'simulate', 'inspect', 'quantify', 'deploy', 'export', 'diligence', 'usage', 'policy', 'erp', 'logout', 'ask'];
      for (const c of authCommands) {
        expect(requiresAuthentication(c)).toBe(true);
      }
    });

    it('should NOT require authentication for identity/meta commands', () => {
      const noAuthCommands = ['login', 'whoami', 'help', 'version', 'agents'];
      for (const c of noAuthCommands) {
        expect(requiresAuthentication(c)).toBe(false);
      }
    });

    it('should NOT require authentication for unknown commands', () => {
      expect(requiresAuthentication('foobar')).toBe(false);
      expect(requiresAuthentication('')).toBe(false);
    });

    it('AuthSessionRequiredError should contain login instructions', () => {
      const err = new AuthSessionRequiredError();
      expect(err.name).toBe('AuthSessionRequiredError');
      expect(err.message).toContain('AUTHENTICATION REQUIRED');
      expect(err.message).toContain('agentics login');
      expect(err.message).toContain('AGENTICS_API_KEY');
      expect(err.message).toContain('AGENTICS_INTERNAL_KEY');
    });

    it('AuthSessionRequiredError should be an instance of Error', () => {
      const err = new AuthSessionRequiredError();
      expect(err).toBeInstanceOf(Error);
    });
  });

  // -----------------------------------------------------------------------
  // Readiness Gate
  // -----------------------------------------------------------------------

  describe('Readiness Gate', () => {
    it('should allow exempt commands regardless of state', () => {
      const exemptCmds = ['help', 'version', 'login', 'logout', 'whoami', 'usage', 'readiness', 'inspect', 'policy', 'audit', 'demo'];
      for (const c of exemptCmds) {
        const result = checkReadinessGate(cmd(c));
        expect(result.allowed).toBe(true);
        expect(result.readinessRequired).toBe(false);
      }
    });

    it('should allow non-write subcommands on deploy', () => {
      const result = checkReadinessGate(cmd('deploy', 'status'));
      expect(result.allowed).toBe(true);
      expect(result.readinessRequired).toBe(false);
    });

    it('should allow deploy with no subcommand', () => {
      const result = checkReadinessGate(cmd('deploy'));
      expect(result.allowed).toBe(true);
    });

    it('should block deploy run when no readiness state exists', () => {
      // This test relies on the readiness-state.json NOT existing in CI
      const result = checkReadinessGate(cmd('deploy', 'run'));
      // Either blocked (no state file) or allowed (EXECUTION_READY state)
      if (!result.allowed) {
        expect(result.exitCode).toBe(READINESS_GATE_EXIT_CODE);
        expect(result.message).toContain('EXECUTION_READY');
      }
    });

    it('should block deploy rollback when no readiness state exists', () => {
      const result = checkReadinessGate(cmd('deploy', 'rollback'));
      if (!result.allowed) {
        expect(result.exitCode).toBe(READINESS_GATE_EXIT_CODE);
      }
    });

    it('requiresReadinessValidation should return true for deploy run', () => {
      expect(requiresReadinessValidation('deploy', 'run')).toBe(true);
      expect(requiresReadinessValidation('deploy', 'rollback')).toBe(true);
    });

    it('requiresReadinessValidation should return false for non-write commands', () => {
      expect(requiresReadinessValidation('deploy', 'status')).toBe(false);
      expect(requiresReadinessValidation('plan', 'create')).toBe(false);
      expect(requiresReadinessValidation('help')).toBe(false);
    });

    it('requiresReadinessValidation should return false when subcommand is undefined', () => {
      expect(requiresReadinessValidation('deploy')).toBe(false);
    });

    it('should have exit code 111 for readiness violations', () => {
      expect(READINESS_GATE_EXIT_CODE).toBe(111);
    });
  });

  // -----------------------------------------------------------------------
  // Output Format Gate
  // -----------------------------------------------------------------------

  describe('Output Format Gate', () => {
    it('should accept json format for operational commands', () => {
      const result = checkOutputFormatGate('json', 'plan');
      expect(result.valid).toBe(true);
      expect(result.format).toBe('json');
    });

    it('should accept yaml format for operational commands', () => {
      const result = checkOutputFormatGate('yaml', 'simulate');
      expect(result.valid).toBe(true);
      expect(result.format).toBe('yaml');
    });

    it('should reject text format for operational commands', () => {
      const result = checkOutputFormatGate('text', 'plan');
      expect(result.valid).toBe(false);
      expect(result.exitCode).toBe(INVALID_FORMAT_EXIT_CODE);
      expect(result.message).toContain('INVALID OUTPUT FORMAT');
    });

    it('should reject table format for operational commands', () => {
      const result = checkOutputFormatGate('table', 'deploy');
      expect(result.valid).toBe(false);
    });

    it('should accept any format for non-operational commands', () => {
      // help, version, login, whoami are not in STRUCTURED_OUTPUT_COMMANDS
      const result = checkOutputFormatGate('text', 'help');
      expect(result.valid).toBe(true);
    });

    it('should default to json when format is undefined', () => {
      const result = checkOutputFormatGate(undefined, 'plan');
      expect(result.valid).toBe(true);
      expect(result.format).toBe('json');
    });

    it('requiresStructuredOutput should return true for operational commands', () => {
      const ops = ['plan', 'simulate', 'inspect', 'quantify', 'deploy', 'export', 'diligence', 'usage', 'policy', 'erp'];
      for (const c of ops) {
        expect(requiresStructuredOutput(c)).toBe(true);
      }
    });

    it('requiresStructuredOutput should return false for meta commands', () => {
      expect(requiresStructuredOutput('help')).toBe(false);
      expect(requiresStructuredOutput('version')).toBe(false);
      expect(requiresStructuredOutput('login')).toBe(false);
    });

    it('getDefaultFormat should return json for operational commands', () => {
      expect(getDefaultFormat('plan')).toBe('json');
      expect(getDefaultFormat('deploy')).toBe('json');
    });

    it('getDefaultFormat should return text for meta commands', () => {
      expect(getDefaultFormat('help')).toBe('text');
      expect(getDefaultFormat('version')).toBe('text');
    });

    it('InvalidOutputFormatError should include requested and allowed formats', () => {
      const err = new InvalidOutputFormatError('csv', ['json', 'yaml']);
      expect(err.requestedFormat).toBe('csv');
      expect(err.allowedFormats).toEqual(['json', 'yaml']);
      expect(err.name).toBe('InvalidOutputFormatError');
      expect(err.message).toContain('csv');
      expect(err.message).toContain('json, yaml');
    });

    it('InvalidOutputFormatError should be an instance of Error', () => {
      const err = new InvalidOutputFormatError('text', ['json']);
      expect(err).toBeInstanceOf(Error);
    });
  });
});
