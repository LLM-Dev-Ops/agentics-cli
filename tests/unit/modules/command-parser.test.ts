/**
 * Command Parser Unit Tests
 *
 * SPARC Architecture Reference: §2.2
 * Tests parsing of CLI arguments and flags
 */

import { CommandParser, createCommandParser, SUPPORTED_COMMANDS } from '../../../src/modules/command-parser.js';
import { ValidationError } from '../../../src/errors/index.js';

describe('CommandParser', () => {
  let parser: CommandParser;

  beforeEach(() => {
    parser = createCommandParser() as CommandParser;
  });

  describe('parse', () => {
    it('should parse a simple command', () => {
      const result = parser.parse(['plan']);
      expect(result.command).toBe('plan');
      expect(result.subcommand).toBeUndefined();
      expect(result.flags).toEqual({});
      expect(result.options).toEqual({});
      expect(result.positionalArgs).toEqual([]);
    });

    it('should parse command with positional arguments', () => {
      const result = parser.parse(['plan', 'manifest-query']);
      expect(result.command).toBe('plan');
      expect(result.positionalArgs).toEqual(['manifest-query']);
    });

    it('should parse boolean flags', () => {
      const result = parser.parse(['plan', '--verbose', '--debug']);
      expect(result.flags['verbose']).toBe(true);
      expect(result.flags['debug']).toBe(true);
    });

    it('should parse short flags', () => {
      const result = parser.parse(['plan', '-v', '-q']);
      expect(result.flags['verbose']).toBe(true);
      expect(result.flags['quiet']).toBe(true);
    });

    it('should parse combined short flags', () => {
      const result = parser.parse(['plan', '-vq']);
      expect(result.flags['verbose']).toBe(true);
      expect(result.flags['quiet']).toBe(true);
    });

    it('should parse options with values', () => {
      const result = parser.parse(['plan', '--timeout', '5000', '--format', 'json']);
      expect(result.options['timeout']).toBe('5000');
      expect(result.options['format']).toBe('json');
    });

    it('should parse options with equals syntax', () => {
      const result = parser.parse(['plan', '--timeout=5000', '--format=yaml']);
      expect(result.options['timeout']).toBe('5000');
      expect(result.options['format']).toBe('yaml');
    });

    it('should handle audit subcommand', () => {
      const result = parser.parse(['audit', 'list']);
      expect(result.command).toBe('audit');
      expect(result.subcommand).toBe('list');
    });

    it('should throw ValidationError for missing command', () => {
      expect(() => parser.parse([])).toThrow(ValidationError);
    });

    it('should parse all supported commands', () => {
      for (const command of SUPPORTED_COMMANDS) {
        const result = parser.parse([command]);
        expect(result.command).toBe(command);
      }
    });
  });
});
