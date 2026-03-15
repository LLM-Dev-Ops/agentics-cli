/**
 * Command Parser Edge Case Tests
 *
 * Tests boundary conditions, special characters, malformed input,
 * and unusual argument combinations that the command parser must handle.
 */

import { CommandParser, createCommandParser, SUPPORTED_COMMANDS } from '../../../src/modules/command-parser.js';
import { ValidationError } from '../../../src/errors/index.js';

describe('CommandParser Edge Cases', () => {
  let parser: CommandParser;

  beforeEach(() => {
    parser = createCommandParser() as CommandParser;
  });

  // -----------------------------------------------------------------------
  // Empty and missing input
  // -----------------------------------------------------------------------

  describe('Empty and missing input', () => {
    it('should throw ValidationError for empty array', () => {
      expect(() => parser.parse([])).toThrow(ValidationError);
    });

    it('should throw ValidationError with descriptive message', () => {
      try {
        parser.parse([]);
        fail('Expected ValidationError');
      } catch (err) {
        expect(err).toBeInstanceOf(ValidationError);
        expect((err as Error).message).toContain('No command specified');
      }
    });

    it('should throw ValidationError for array containing only empty string', () => {
      // Empty string is falsy, so the parser treats it as no command and throws
      expect(() => parser.parse([''])).toThrow(ValidationError);
    });

    it('should handle array with only undefined entries by skipping them', () => {
      // The parser guards: if (arg === undefined) continue
      // So an array with all undefined-like values should throw (no command found)
      const args: string[] = [];
      args.length = 3; // Creates sparse array with 3 undefined slots
      expect(() => parser.parse(args)).toThrow(ValidationError);
    });
  });

  // -----------------------------------------------------------------------
  // Extremely long input
  // -----------------------------------------------------------------------

  describe('Extremely long input', () => {
    it('should handle a 10K character command name without crashing', () => {
      const longCmd = 'a'.repeat(10000);
      const result = parser.parse([longCmd]);
      expect(result.command).toBe(longCmd);
      expect(result.command.length).toBe(10000);
    });

    it('should handle a 10K character option value', () => {
      const longValue = 'x'.repeat(10000);
      const result = parser.parse(['plan', '--timeout', longValue]);
      expect(result.options['timeout']).toBe(longValue);
    });

    it('should handle many positional arguments (100+)', () => {
      const args = ['ask', ...Array.from({ length: 100 }, (_, i) => `arg${i}`)];
      const result = parser.parse(args);
      expect(result.command).toBe('ask');
      expect(result.positionalArgs.length).toBe(100);
    });

    it('should handle many flags (50+)', () => {
      const flags = Array.from({ length: 50 }, (_, i) => `--flag${i}`);
      const result = parser.parse(['plan', ...flags]);
      expect(result.command).toBe('plan');
      expect(Object.keys(result.flags).length).toBe(50);
    });
  });

  // -----------------------------------------------------------------------
  // Special characters in input
  // -----------------------------------------------------------------------

  describe('Special characters', () => {
    it('should handle quotes in positional arguments', () => {
      const result = parser.parse(['ask', '"hello world"']);
      expect(result.command).toBe('ask');
      expect(result.positionalArgs[0]).toBe('"hello world"');
    });

    it('should handle backslashes in option values', () => {
      const result = parser.parse(['plan', '--path', 'C:\\Users\\test']);
      expect(result.options['path']).toBe('C:\\Users\\test');
    });

    it('should handle unicode characters', () => {
      const result = parser.parse(['ask', 'optimiser les co\u00fbts']);
      expect(result.positionalArgs[0]).toBe('optimiser les co\u00fbts');
    });

    it('should handle emoji in arguments', () => {
      const result = parser.parse(['ask', 'deploy \u{1F680} service']);
      expect(result.positionalArgs[0]).toContain('\u{1F680}');
    });

    it('should handle special shell characters in values', () => {
      const result = parser.parse(['ask', 'test && echo pwned']);
      expect(result.positionalArgs[0]).toBe('test && echo pwned');
    });

    it('should handle equals signs in option values', () => {
      const result = parser.parse(['plan', '--config=key=value']);
      expect(result.options['config']).toBe('key=value');
    });

    it('should handle option with empty value after equals', () => {
      const result = parser.parse(['plan', '--key=']);
      // Empty value after = should be treated as boolean flag=true
      expect(result.flags['key']).toBe(true);
    });

    it('should handle --option=true and --option=false', () => {
      const result = parser.parse(['plan', '--verbose=true', '--debug=false']);
      expect(result.flags['verbose']).toBe(true);
      expect(result.flags['debug']).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // Whitespace handling
  // -----------------------------------------------------------------------

  describe('Whitespace handling', () => {
    it('should handle arguments with leading/trailing spaces (as-is)', () => {
      // In real CLI, the shell strips whitespace. But the parser should handle gracefully.
      const result = parser.parse(['  plan  ']);
      expect(result.command).toBe('  plan  ');
    });

    it('should handle tab characters in arguments', () => {
      const result = parser.parse(['ask', 'hello\tworld']);
      expect(result.positionalArgs[0]).toBe('hello\tworld');
    });

    it('should handle newlines in arguments', () => {
      const result = parser.parse(['ask', 'line1\nline2']);
      expect(result.positionalArgs[0]).toBe('line1\nline2');
    });
  });

  // -----------------------------------------------------------------------
  // Subcommand parsing
  // -----------------------------------------------------------------------

  describe('Subcommand parsing', () => {
    it('should parse subcommands for commands that have them', () => {
      const cmdsWithSubs = ['audit', 'inspect', 'policy', 'plan', 'simulate', 'quantify', 'deploy', 'export', 'erp', 'usage', 'readiness', 'demo', 'agents'];
      for (const command of cmdsWithSubs) {
        const result = parser.parse([command, 'sub']);
        expect(result.command).toBe(command);
        expect(result.subcommand).toBe('sub');
      }
    });

    it('should NOT parse subcommands for commands without them', () => {
      const cmdsWithoutSubs = ['login', 'logout', 'whoami', 'ask', 'version', 'help'];
      for (const command of cmdsWithoutSubs) {
        const result = parser.parse([command, 'extra']);
        expect(result.command).toBe(command);
        expect(result.subcommand).toBeUndefined();
        expect(result.positionalArgs).toContain('extra');
      }
    });

    it('should handle multiple positional args after subcommand', () => {
      const result = parser.parse(['plan', 'create', 'arg1', 'arg2']);
      expect(result.command).toBe('plan');
      expect(result.subcommand).toBe('create');
      expect(result.positionalArgs).toEqual(['arg1', 'arg2']);
    });
  });

  // -----------------------------------------------------------------------
  // Short flag expansion
  // -----------------------------------------------------------------------

  describe('Short flag expansion', () => {
    it('should expand -v to verbose', () => {
      const result = parser.parse(['plan', '-v']);
      expect(result.flags['verbose']).toBe(true);
    });

    it('should expand -h to help', () => {
      const result = parser.parse(['plan', '-h']);
      expect(result.flags['help']).toBe(true);
    });

    it('should expand -f to force', () => {
      const result = parser.parse(['plan', '-f']);
      expect(result.flags['force']).toBe(true);
    });

    it('should keep unknown single-char flags as-is', () => {
      const result = parser.parse(['plan', '-z']);
      expect(result.flags['z']).toBe(true);
    });

    it('should expand combined short flags', () => {
      const result = parser.parse(['plan', '-vqf']);
      expect(result.flags['verbose']).toBe(true);
      expect(result.flags['quiet']).toBe(true);
      expect(result.flags['force']).toBe(true);
    });

    it('should treat -o as expecting a value (output)', () => {
      const result = parser.parse(['plan', '-o', 'file.json']);
      expect(result.options['output']).toBe('file.json');
    });

    it('should treat -t as expecting a value (timeout)', () => {
      const result = parser.parse(['plan', '-t', '5000']);
      expect(result.options['timeout']).toBe('5000');
    });
  });

  // -----------------------------------------------------------------------
  // Mixed flags and options
  // -----------------------------------------------------------------------

  describe('Mixed flags and options', () => {
    it('should handle interleaved flags, options, and positional args', () => {
      const result = parser.parse([
        'plan', 'create', '--verbose', '--timeout', '5000', 'some-desc', '--format', 'json', '--debug',
      ]);
      expect(result.command).toBe('plan');
      expect(result.subcommand).toBe('create');
      expect(result.flags['verbose']).toBe(true);
      expect(result.flags['debug']).toBe(true);
      expect(result.options['timeout']).toBe('5000');
      expect(result.options['format']).toBe('json');
      expect(result.positionalArgs).toContain('some-desc');
    });

    it('should handle -- (bare double dash) as a flag with empty key', () => {
      // '--' becomes withoutDashes = '' → flags[''] = true
      const result = parser.parse(['plan', '--']);
      expect(result.flags['']).toBe(true);
    });

    it('should handle single dash as positional argument', () => {
      // '-' has length 1, so it won't match `-X` (length > 1) pattern
      // It starts with - but length is 1, so falls through to positional
      const result = parser.parse(['ask', '-']);
      // Since 'ask' doesn't have subcommands, '-' is positional
      expect(result.positionalArgs).toContain('-');
    });
  });

  // -----------------------------------------------------------------------
  // Supported commands list
  // -----------------------------------------------------------------------

  describe('SUPPORTED_COMMANDS', () => {
    it('should include at least 20 commands', () => {
      expect(SUPPORTED_COMMANDS.length).toBeGreaterThanOrEqual(20);
    });

    it('should include phase commands', () => {
      expect(SUPPORTED_COMMANDS).toContain('phase2');
      expect(SUPPORTED_COMMANDS).toContain('phase3');
      expect(SUPPORTED_COMMANDS).toContain('phase4');
      expect(SUPPORTED_COMMANDS).toContain('phase5');
      expect(SUPPORTED_COMMANDS).toContain('phase6');
    });

    it('should include core operational commands', () => {
      expect(SUPPORTED_COMMANDS).toContain('plan');
      expect(SUPPORTED_COMMANDS).toContain('simulate');
      expect(SUPPORTED_COMMANDS).toContain('deploy');
      expect(SUPPORTED_COMMANDS).toContain('ask');
    });

    it('should be a readonly tuple (frozen at compile time)', () => {
      // Verify the runtime array exists
      expect(Array.isArray(SUPPORTED_COMMANDS)).toBe(true);
      // Values should all be strings
      for (const cmd of SUPPORTED_COMMANDS) {
        expect(typeof cmd).toBe('string');
        expect(cmd.length).toBeGreaterThan(0);
      }
    });
  });

  // -----------------------------------------------------------------------
  // createCommandParser factory
  // -----------------------------------------------------------------------

  describe('createCommandParser factory', () => {
    it('should return an object with a parse method', () => {
      const p = createCommandParser();
      expect(typeof p.parse).toBe('function');
    });

    it('should return a new instance each time', () => {
      const p1 = createCommandParser();
      const p2 = createCommandParser();
      expect(p1).not.toBe(p2);
    });
  });
});
