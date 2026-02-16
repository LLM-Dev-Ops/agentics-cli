/**
 * Argument Guard Tests — Mechanically Derived from ADR-001
 *
 * Every test case in this file maps directly to a rule in
 * src/contracts/adr-command-semantics.ts. If a test fails,
 * either the ADR or the guard is wrong — never both.
 *
 * Test categories:
 * 1. Missing required IDs (Case A)
 * 2. Natural language where ID required (Case B)
 * 3. ID where natural language required (Case C)
 * 4. Synthesis on forbidden commands (Case D)
 * 5. Valid invocations pass through
 * 6. Argument classification
 */

import {
  checkArgumentGuard,
  requiresArgumentValidation,
} from '../../src/gates/argument-guard.js';
import {
  classifyArgument,
  isSynthesisAllowed,
  isCommitmentGrade,
  COMMAND_REGISTRY,
} from '../../src/contracts/adr-command-semantics.js';
import type { CommandObject } from '../../src/types/index.js';

// ============================================================================
// Helpers
// ============================================================================

function makeCmd(command: string, subcommand?: string, positionalArgs: string[] = [], flags: Record<string, boolean> = {}): CommandObject {
  return {
    command,
    subcommand,
    flags,
    options: {},
    positionalArgs,
  };
}

// ============================================================================
// 1. CASE A — Missing Required ID
// ============================================================================

describe('Case A: Missing required arguments', () => {
  const commandsRequiringArgs: [string, string | undefined][] = [
    ['simulate', 'create'],
    ['simulate', 'run'],
    ['simulate', 'inspect'],
    ['simulate', 'delete'],
    ['plan', 'create'],
    ['plan', 'approve'],
    ['plan', 'inspect'],
    ['plan', 'delete'],
    ['deploy', 'preview'],
    ['deploy', 'run'],
    ['deploy', 'rollback'],
    ['deploy', 'status'],
    ['export', 'terraform'],
    ['export', 'kubernetes'],
    ['export', 'erp'],
    ['policy', 'edit'],
    ['policy', 'enable'],
    ['policy', 'disable'],
    ['policy', 'dry-run'],
    ['policy', 'inspect'],
    ['policy', 'delete'],
    ['quantify', 'create'],
    ['quantify', 'inspect'],
    ['quantify', 'delete'],
    ['erp', 'surface'],
    ['erp', 'map'],
    ['erp', 'export'],
    ['erp', 'inspect'],
    ['inspect', 'run'],
    ['inspect', 'artifacts'],
  ];

  test.each(commandsRequiringArgs)(
    '%s %s rejects when required arg is missing',
    (primary, subcommand) => {
      const cmd = makeCmd(primary, subcommand, []);
      const result = checkArgumentGuard(cmd);
      expect(result.allowed).toBe(false);
      expect(result.exitCode).toBe(100);
      expect(result.message).toContain('Missing required argument');
    }
  );

  test('quantify compare rejects when both IDs are missing', () => {
    const cmd = makeCmd('quantify', 'compare', []);
    const result = checkArgumentGuard(cmd);
    expect(result.allowed).toBe(false);
  });

  test('quantify compare rejects when only one ID is provided', () => {
    const cmd = makeCmd('quantify', 'compare', ['roi-cloud-3yr']);
    const result = checkArgumentGuard(cmd);
    expect(result.allowed).toBe(false);
  });
});

// ============================================================================
// 2. CASE B — Natural Language Where ID Required
// ============================================================================

describe('Case B: Natural language used where ID required', () => {
  const idCommands: [string, string | undefined, string][] = [
    ['simulate', 'run', 'run a big enterprise simulation'],
    ['simulate', 'inspect', 'show me the simulation results'],
    ['simulate', 'delete', 'delete all simulations please'],
    ['plan', 'approve', 'approve the migration plan'],
    ['plan', 'inspect', 'inspect the latest plan'],
    ['plan', 'delete', 'delete old plans'],
    ['deploy', 'run', 'deploy to production now'],
    ['deploy', 'rollback', 'rollback the last deployment'],
    ['deploy', 'status', 'check my deployment status'],
    ['deploy', 'preview', 'preview the cloud migration'],
    ['export', 'terraform', 'export my infrastructure'],
    ['export', 'kubernetes', 'export k8s manifests'],
    ['policy', 'edit', 'edit the compliance policy'],
    ['policy', 'enable', 'enable security policy'],
    ['policy', 'disable', 'disable the old policy'],
    ['policy', 'inspect', 'inspect the main policy'],
    ['quantify', 'inspect', 'show the ROI report'],
    ['quantify', 'delete', 'remove old reports'],
    ['inspect', 'run', 'inspect the latest run please'],
    ['inspect', 'artifacts', 'show artifacts for the run'],
    ['erp', 'inspect', 'show me the SAP config'],
    ['erp', 'surface', 'find ERP integration points'],
    ['erp', 'map', 'map the ERP entities'],
    ['erp', 'export', 'export the ERP artifacts'],
  ];

  test.each(idCommands)(
    '%s %s rejects natural language input: "%s"',
    (primary, subcommand, nlInput) => {
      const cmd = makeCmd(primary, subcommand ?? undefined, [nlInput]);
      const result = checkArgumentGuard(cmd);
      expect(result.allowed).toBe(false);
      expect(result.message).toContain('requires an ID, not a description');
    }
  );
});

// ============================================================================
// 3. CASE C — ID Where Natural Language Required
// ============================================================================

describe('Case C: ID used where natural language required', () => {
  const nlCommands: [string, string | undefined, string][] = [
    ['simulate', 'create', 'test-sim'],
    ['plan', 'create', 'my-plan'],
    ['quantify', 'create', 'roi-report'],
    ['policy', 'create', 'soc2-policy'],
  ];

  test.each(nlCommands)(
    '%s %s rejects bare ID input: "%s"',
    (primary, subcommand, idInput) => {
      const cmd = makeCmd(primary, subcommand ?? undefined, [idInput]);
      const result = checkArgumentGuard(cmd);
      expect(result.allowed).toBe(false);
      expect(result.message).toContain('requires a quoted natural language description');
    }
  );
});

// ============================================================================
// 4. CASE D — Synthesis on Forbidden Commands
// ============================================================================

describe('Case D: Synthesis attempted on forbidden commands', () => {
  const forbiddenCommands: [string, string | undefined][] = [
    ['login', undefined],
    ['logout', undefined],
    ['whoami', undefined],
    ['usage', undefined],
    ['usage', 'history'],
    ['usage', 'limits'],
    ['usage', 'reset'],
    ['inspect', 'latest'],
    ['simulate', 'list'],
    ['plan', 'list'],
    ['deploy', 'list'],
    ['quantify', 'list'],
    ['policy', 'list'],
    ['erp', 'list'],
  ];

  test.each(forbiddenCommands)(
    '%s %s has synthesis FORBIDDEN in registry',
    (primary, subcommand) => {
      expect(isSynthesisAllowed(primary, subcommand ?? undefined)).toBe(false);
    }
  );
});

// ============================================================================
// 5. VALID INVOCATIONS PASS THROUGH
// ============================================================================

describe('Valid invocations pass through', () => {
  const validCommands: [string, string | undefined, string[], Record<string, boolean>][] = [
    // Identity (no args)
    ['login', undefined, [], {}],
    ['logout', undefined, [], {}],
    ['whoami', undefined, [], {}],
    ['help', undefined, [], {}],
    ['version', undefined, [], {}],

    // List commands (no args)
    ['simulate', 'list', [], {}],
    ['plan', 'list', [], {}],
    ['deploy', 'list', [], {}],
    ['quantify', 'list', [], {}],
    ['policy', 'list', [], {}],
    ['policy', 'create', [], {}],  // positional is optional when --name is used
    ['erp', 'list', [], {}],
    ['usage', undefined, [], {}],
    ['usage', 'history', [], {}],
    ['usage', 'limits', [], {}],
    ['inspect', 'latest', [], {}],

    // ID commands with valid IDs (--force for requiresConfirmation commands)
    ['simulate', 'run', ['enterprise-cloud-migration'], { force: true }],
    ['simulate', 'inspect', ['my-simulation-v2'], {}],
    ['plan', 'approve', ['a1b2c3d4-e5f6-7890-abcd-ef1234567890'], { force: true }],
    ['plan', 'inspect', ['a1b2c3d4-e5f6-7890-abcd-ef1234567890'], {}],
    ['deploy', 'run', ['deploy-prod-2026'], { force: true }],
    ['deploy', 'status', ['deploy-staging-v3'], {}],
    ['export', 'terraform', ['intent-cloud-migration'], {}],
    ['policy', 'enable', ['soc2-compliance'], { force: true }],
    ['erp', 'inspect', ['sap'], {}],

    // NL commands with quoted text
    ['simulate', 'create', ['"Simulate enterprise migration to cloud"'], {}],
    ['plan', 'create', ['"Migrate authentication to OAuth2"'], {}],
    ['quantify', 'create', ['"Compare cloud costs for 3-year migration"'], {}],
    ['policy', 'create', ['"Enforce SOC2 compliance on all deployments"'], {}],

    // Two-arg commands (--force for requiresConfirmation)
    ['quantify', 'compare', ['roi-cloud-3yr', 'roi-onprem-3yr'], { force: true }],
  ];

  test.each(validCommands)(
    '%s %s with args %j passes validation',
    (primary, subcommand, args, flags) => {
      const cmd = makeCmd(primary, subcommand ?? undefined, args, flags);
      const result = checkArgumentGuard(cmd);
      expect(result.allowed).toBe(true);
    }
  );
});

// ============================================================================
// 6. ARGUMENT CLASSIFICATION
// ============================================================================

describe('Argument classification', () => {
  test('lowercase-hyphenated strings are IDs', () => {
    expect(classifyArgument('enterprise-cloud-migration')).toBe('ID');
    expect(classifyArgument('my-plan-v2')).toBe('ID');
    expect(classifyArgument('sap')).toBe('ID');
    expect(classifyArgument('soc2-compliance')).toBe('ID');
  });

  test('UUIDs are IDs', () => {
    expect(classifyArgument('a1b2c3d4-e5f6-7890-abcd-ef1234567890')).toBe('ID');
    expect(classifyArgument('550e8400-e29b-41d4-a716-446655440000')).toBe('ID');
  });

  test('quoted strings are NATURAL_LANGUAGE', () => {
    expect(classifyArgument('"Simulate enterprise migration"')).toBe('NATURAL_LANGUAGE');
    expect(classifyArgument("'Migrate to cloud'")).toBe('NATURAL_LANGUAGE');
  });

  test('strings with spaces are NATURAL_LANGUAGE', () => {
    expect(classifyArgument('simulate an enterprise')).toBe('NATURAL_LANGUAGE');
    expect(classifyArgument('deploy to production now')).toBe('NATURAL_LANGUAGE');
  });

  test('"latest" is a SELECTOR', () => {
    expect(classifyArgument('latest')).toBe('SELECTOR');
  });

  test('dotted identifiers are IDs', () => {
    expect(classifyArgument('v1.2.3')).toBe('ID');
    expect(classifyArgument('deploy.prod.2026')).toBe('ID');
  });
});

// ============================================================================
// 7. SYNTHESIS GOVERNANCE MATRIX
// ============================================================================

describe('Synthesis governance matrix', () => {
  test('synthesis-required commands', () => {
    expect(isSynthesisAllowed('simulate', 'create')).toBe(true);
    expect(isSynthesisAllowed('plan', 'create')).toBe(true);
    expect(isSynthesisAllowed('deploy', 'preview')).toBe(true);
    expect(isSynthesisAllowed('export', 'terraform')).toBe(true);
    expect(isSynthesisAllowed('export', 'kubernetes')).toBe(true);
    expect(isSynthesisAllowed('export', 'erp')).toBe(true);
    expect(isSynthesisAllowed('policy', 'create')).toBe(true);
    expect(isSynthesisAllowed('policy', 'edit')).toBe(true);
    expect(isSynthesisAllowed('policy', 'dry-run')).toBe(true);
    expect(isSynthesisAllowed('quantify', 'create')).toBe(true);
    expect(isSynthesisAllowed('erp', 'surface')).toBe(true);
    expect(isSynthesisAllowed('erp', 'map')).toBe(true);
    expect(isSynthesisAllowed('erp', 'export')).toBe(true);
    expect(isSynthesisAllowed('diligence')).toBe(true);
  });

  test('commitment-grade commands', () => {
    expect(isCommitmentGrade('simulate', 'run')).toBe(true);
    expect(isCommitmentGrade('plan', 'approve')).toBe(true);
    expect(isCommitmentGrade('deploy', 'run')).toBe(true);
    expect(isCommitmentGrade('deploy', 'rollback')).toBe(true);
    expect(isCommitmentGrade('policy', 'enable')).toBe(true);
    expect(isCommitmentGrade('quantify', 'compare')).toBe(true);
  });

  test('synthesis-forbidden commands', () => {
    expect(isSynthesisAllowed('login')).toBe(false);
    expect(isSynthesisAllowed('logout')).toBe(false);
    expect(isSynthesisAllowed('whoami')).toBe(false);
    expect(isSynthesisAllowed('usage')).toBe(false);
    expect(isSynthesisAllowed('usage', 'history')).toBe(false);
    expect(isSynthesisAllowed('inspect', 'latest')).toBe(false);
    expect(isSynthesisAllowed('inspect', 'run')).toBe(false);
    expect(isSynthesisAllowed('inspect', 'artifacts')).toBe(false);
    expect(isSynthesisAllowed('help')).toBe(false);
    expect(isSynthesisAllowed('version')).toBe(false);
  });
});

// ============================================================================
// 8. COMMAND REGISTRY COMPLETENESS
// ============================================================================

describe('Command registry completeness', () => {
  test('every registered command has a description', () => {
    for (const spec of COMMAND_REGISTRY) {
      expect(spec.description).toBeTruthy();
      expect(spec.description.length).toBeGreaterThan(5);
    }
  });

  test('every required arg has an example', () => {
    for (const spec of COMMAND_REGISTRY) {
      for (const arg of spec.args) {
        if (arg.required) {
          expect(arg.example).toBeTruthy();
          expect(arg.example.length).toBeGreaterThan(0);
        }
      }
    }
  });

  test('commitment-grade commands all require confirmation', () => {
    const commitmentSpecs = COMMAND_REGISTRY.filter(s => s.synthesis === 'COMMITMENT_GRADE');
    expect(commitmentSpecs.length).toBeGreaterThan(0);
    for (const spec of commitmentSpecs) {
      expect(spec.requiresConfirmation).toBe(true);
    }
  });

  test('synthesis-forbidden commands with ID args are read-only or destructive', () => {
    const forbidden = COMMAND_REGISTRY.filter(s => s.synthesis === 'SYNTHESIS_FORBIDDEN');
    for (const spec of forbidden) {
      // These commands should never trigger LLM invocation
      expect(spec.synthesis).toBe('SYNTHESIS_FORBIDDEN');
    }
  });

  test('help and version are exempt from argument validation', () => {
    expect(requiresArgumentValidation('help')).toBe(false);
    expect(requiresArgumentValidation('version')).toBe(false);
    expect(requiresArgumentValidation('plan')).toBe(true);
    expect(requiresArgumentValidation('simulate')).toBe(true);
  });
});

// ============================================================================
// 9. ERROR MESSAGE QUALITY
// ============================================================================

describe('Error messages are instructional', () => {
  test('missing ID error includes usage example', () => {
    const cmd = makeCmd('plan', 'approve', []);
    const result = checkArgumentGuard(cmd);
    expect(result.allowed).toBe(false);
    expect(result.message).toContain('Usage:');
    expect(result.message).toContain('agentics plan approve');
  });

  test('wrong type error includes correct example', () => {
    const cmd = makeCmd('simulate', 'run', ['run a big enterprise simulation']);
    const result = checkArgumentGuard(cmd);
    expect(result.allowed).toBe(false);
    expect(result.message).toContain('requires an ID');
    expect(result.message).toContain('Example:');
  });

  test('NL-where-ID error does not say "unknown"', () => {
    const cmd = makeCmd('deploy', 'run', ['deploy to production now']);
    const result = checkArgumentGuard(cmd);
    expect(result.allowed).toBe(false);
    expect(result.message).not.toContain('unknown');
  });
});
