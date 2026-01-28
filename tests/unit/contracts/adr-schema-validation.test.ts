/**
 * ADR-002 Decision 3, Rule 1: Schema Structural Validation
 * CI Check: ADR-002.D3.R1
 *
 * Validates COMMAND_REGISTRY structural integrity:
 * - Every CommandSpec has all required fields
 * - No duplicate command entries
 * - Command string format matches primary + subcommand
 * - All ArgumentSpec entries are valid
 * - ADR_SCHEMA_VERSION is valid semver
 * - Semantic consistency (irreversible → requiresConfirmation)
 */

import {
  COMMAND_REGISTRY,
  ADR_SCHEMA_VERSION,
} from '../../../src/contracts/adr-command-semantics.js';

// ============================================================================
// Schema Version Validation
// ============================================================================

describe('ADR-002.D3.R1: ADR_SCHEMA_VERSION', () => {
  test('is exported and defined', () => {
    expect(ADR_SCHEMA_VERSION).toBeDefined();
    expect(typeof ADR_SCHEMA_VERSION).toBe('string');
  });

  test('is valid semver format', () => {
    const semverPattern = /^\d+\.\d+\.\d+$/;
    expect(ADR_SCHEMA_VERSION).toMatch(semverPattern);
  });
});

// ============================================================================
// Command Registry Structural Integrity
// ============================================================================

describe('ADR-002.D3.R1: COMMAND_REGISTRY structural integrity', () => {
  test('registry is non-empty', () => {
    expect(COMMAND_REGISTRY.length).toBeGreaterThan(0);
  });

  test('no duplicate command paths', () => {
    const paths = COMMAND_REGISTRY.map(s => s.command);
    const unique = new Set(paths);
    const duplicates = paths.filter((p, i) => paths.indexOf(p) !== i);
    expect(duplicates).toEqual([]);
    expect(unique.size).toBe(paths.length);
  });

  test('every command has all required fields', () => {
    for (const spec of COMMAND_REGISTRY) {
      expect(typeof spec.command).toBe('string');
      expect(spec.command.length).toBeGreaterThan(0);

      expect(typeof spec.primary).toBe('string');
      expect(spec.primary.length).toBeGreaterThan(0);

      expect(typeof spec.description).toBe('string');
      expect(spec.description.length).toBeGreaterThan(0);

      expect(['SYNTHESIS_REQUIRED', 'SYNTHESIS_FORBIDDEN', 'COMMITMENT_GRADE']).toContain(spec.synthesis);

      expect(Array.isArray(spec.args)).toBe(true);

      expect(typeof spec.irreversible).toBe('boolean');
      expect(typeof spec.requiresConfirmation).toBe('boolean');
    }
  });

  test('command string matches primary + subcommand format', () => {
    for (const spec of COMMAND_REGISTRY) {
      if (spec.subcommand) {
        expect(spec.command).toBe(`${spec.primary} ${spec.subcommand}`);
      } else {
        expect(spec.command).toBe(spec.primary);
      }
    }
  });

  test('primary is lowercase with no spaces', () => {
    for (const spec of COMMAND_REGISTRY) {
      expect(spec.primary).toMatch(/^[a-z][a-z0-9-]*$/);
    }
  });

  test('subcommand (when present) is lowercase with no spaces', () => {
    for (const spec of COMMAND_REGISTRY) {
      if (spec.subcommand) {
        expect(spec.subcommand).toMatch(/^[a-z][a-z0-9-]*$/);
      }
    }
  });
});

// ============================================================================
// ArgumentSpec Validation
// ============================================================================

describe('ADR-002.D3.R1: ArgumentSpec validation', () => {
  test('every argument has all required fields', () => {
    for (const spec of COMMAND_REGISTRY) {
      for (const arg of spec.args) {
        expect(typeof arg.name).toBe('string');
        expect(arg.name.length).toBeGreaterThan(0);

        expect(['ID', 'NATURAL_LANGUAGE', 'SELECTOR']).toContain(arg.type);

        expect(typeof arg.required).toBe('boolean');

        expect(typeof arg.description).toBe('string');
        expect(arg.description.length).toBeGreaterThan(0);

        expect(typeof arg.example).toBe('string');
        expect(arg.example.length).toBeGreaterThan(0);
      }
    }
  });

  test('argument names are lowercase hyphenated', () => {
    for (const spec of COMMAND_REGISTRY) {
      for (const arg of spec.args) {
        expect(arg.name).toMatch(/^[a-z][a-z0-9-]*$/);
      }
    }
  });

  test('required arguments precede optional arguments', () => {
    for (const spec of COMMAND_REGISTRY) {
      let seenOptional = false;
      for (const arg of spec.args) {
        if (!arg.required) {
          seenOptional = true;
        }
        if (seenOptional && arg.required) {
          fail(`Command '${spec.command}': required arg '${arg.name}' follows optional arg`);
        }
      }
    }
  });
});

// ============================================================================
// Semantic Consistency
// ============================================================================

describe('ADR-002.D3.R1: Semantic consistency', () => {
  test('irreversible commands always require confirmation', () => {
    const irreversible = COMMAND_REGISTRY.filter(s => s.irreversible);
    expect(irreversible.length).toBeGreaterThan(0);
    for (const spec of irreversible) {
      expect(spec.requiresConfirmation).toBe(true);
    }
  });

  test('commitment-grade commands always require confirmation', () => {
    const commitment = COMMAND_REGISTRY.filter(s => s.synthesis === 'COMMITMENT_GRADE');
    expect(commitment.length).toBeGreaterThan(0);
    for (const spec of commitment) {
      expect(spec.requiresConfirmation).toBe(true);
    }
  });

  test('synthesis-forbidden commands with no args have no ID requirements', () => {
    const forbidden = COMMAND_REGISTRY.filter(
      s => s.synthesis === 'SYNTHESIS_FORBIDDEN' && s.args.length === 0
    );
    expect(forbidden.length).toBeGreaterThan(0);
    for (const spec of forbidden) {
      expect(spec.args.length).toBe(0);
    }
  });

  test('description does not exceed 80 characters', () => {
    for (const spec of COMMAND_REGISTRY) {
      expect(spec.description.length).toBeLessThanOrEqual(80);
    }
  });
});
