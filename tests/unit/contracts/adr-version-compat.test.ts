/**
 * ADR-002 Decision 3, Rule 7: Version and Metadata Validation
 * CI Check: ADR-002.D3.R7
 *
 * Validates:
 * - ADR_SCHEMA_VERSION matches semver pattern
 * - ADR-002 metadata constants are present
 * - GATE_PIPELINE has exactly 5 entries in correct order
 * - GATE_EXEMPT_COMMANDS contains expected values
 * - CI_CHECK_IDS has all required identifiers
 */

import { ADR_SCHEMA_VERSION } from '../../../src/contracts/adr-command-semantics.js';
import {
  ADR_002_ID,
  ADR_002_TITLE,
  ADR_002_STATUS,
  ADR_002_DATE,
  GATE_PIPELINE,
  GATE_EXEMPT_COMMANDS,
  CI_CHECK_IDS,
} from '../../../src/contracts/adr-002-operational-enforcement.js';

// ============================================================================
// ADR Schema Version
// ============================================================================

describe('ADR-002.D3.R7: ADR_SCHEMA_VERSION', () => {
  test('is valid semver', () => {
    expect(ADR_SCHEMA_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  test('major version is at least 1', () => {
    const [major] = ADR_SCHEMA_VERSION.split('.').map(Number);
    expect(major).toBeGreaterThanOrEqual(1);
  });
});

// ============================================================================
// ADR-002 Metadata Constants
// ============================================================================

describe('ADR-002.D3.R7: ADR-002 metadata', () => {
  test('ADR_002_ID is defined', () => {
    expect(ADR_002_ID).toBe('ADR-002');
  });

  test('ADR_002_TITLE is non-empty', () => {
    expect(ADR_002_TITLE.length).toBeGreaterThan(0);
  });

  test('ADR_002_STATUS is Accepted', () => {
    expect(ADR_002_STATUS).toBe('Accepted');
  });

  test('ADR_002_DATE is valid ISO date', () => {
    expect(ADR_002_DATE).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

// ============================================================================
// Gate Pipeline
// ============================================================================

describe('ADR-002.D3.R7: GATE_PIPELINE', () => {
  test('has exactly 5 gates', () => {
    expect(GATE_PIPELINE).toHaveLength(5);
  });

  test('gates are numbered 1 through 5', () => {
    for (let i = 0; i < 5; i++) {
      expect(GATE_PIPELINE[i]!.gate).toBe(i + 1);
    }
  });

  test('gate order is correct', () => {
    expect(GATE_PIPELINE[0].name).toBe('ExecutionGate');
    expect(GATE_PIPELINE[1].name).toBe('AuthSessionGate');
    expect(GATE_PIPELINE[2].name).toBe('ServiceHealthGate');
    expect(GATE_PIPELINE[3].name).toBe('OutputFormatGate');
    expect(GATE_PIPELINE[4].name).toBe('ArgumentGuard');
  });

  test('every gate has a module path', () => {
    for (const gate of GATE_PIPELINE) {
      expect(gate.module).toMatch(/^gates\/.*\.ts$/);
    }
  });

  test('every gate has a description', () => {
    for (const gate of GATE_PIPELINE) {
      expect(gate.description.length).toBeGreaterThan(0);
    }
  });
});

// ============================================================================
// Gate Exempt Commands
// ============================================================================

describe('ADR-002.D3.R7: GATE_EXEMPT_COMMANDS', () => {
  test('contains help and version', () => {
    expect(GATE_EXEMPT_COMMANDS).toContain('help');
    expect(GATE_EXEMPT_COMMANDS).toContain('version');
  });

  test('contains only help and version', () => {
    expect(GATE_EXEMPT_COMMANDS).toHaveLength(2);
  });
});

// ============================================================================
// CI Check IDs
// ============================================================================

describe('ADR-002.D3.R7: CI_CHECK_IDS', () => {
  test('has all 7 required check identifiers', () => {
    expect(CI_CHECK_IDS.SCHEMA_STRUCTURAL_VALIDATION).toBeDefined();
    expect(CI_CHECK_IDS.COMMAND_SCHEMA_PARITY).toBeDefined();
    expect(CI_CHECK_IDS.SCHEMA_IMPLEMENTATION_PARITY).toBeDefined();
    expect(CI_CHECK_IDS.HELP_SCHEMA_DERIVATION).toBeDefined();
    expect(CI_CHECK_IDS.COMMAND_BEHAVIOR_TESTS).toBeDefined();
    expect(CI_CHECK_IDS.GATE_BYPASS_DETECTION).toBeDefined();
    expect(CI_CHECK_IDS.VERSION_COMPATIBILITY).toBeDefined();
  });

  test('all IDs follow ADR-002.D3.RN format', () => {
    for (const [, value] of Object.entries(CI_CHECK_IDS)) {
      expect(value).toMatch(/^ADR-002\.D3\.R\d+$/);
    }
  });
});
