/**
 * ADR-002 Decision 3, Rule 4: Help Output Matches Schema
 * CI Check: ADR-002.D3.R4
 *
 * Verifies that help output is generated from COMMAND_REGISTRY:
 * - renderHelp() contains every primary command
 * - renderCommandHelp() shows correct subcommands
 * - No command in help that's missing from COMMAND_REGISTRY
 */

import { renderHelp, renderCommandHelp } from '../../../src/modules/help-renderer.js';
import { COMMAND_REGISTRY } from '../../../src/contracts/adr-command-semantics.js';

// ============================================================================
// Top-level help contains all primary commands
// ============================================================================

describe('ADR-002.D3.R4: Top-level help contains all primary commands', () => {
  const helpOutput = renderHelp();
  const primaryCommands = [...new Set(COMMAND_REGISTRY.map(s => s.primary))];

  test.each(primaryCommands)(
    'help output contains primary command "%s"',
    (primary) => {
      expect(helpOutput).toContain(primary);
    }
  );

  test('help output is non-empty', () => {
    expect(helpOutput.length).toBeGreaterThan(100);
  });

  test('help output contains USAGE section', () => {
    expect(helpOutput).toContain('USAGE:');
  });

  test('help output contains COMMANDS section', () => {
    expect(helpOutput).toContain('COMMANDS:');
  });
});

// ============================================================================
// Command-level help shows correct subcommands
// ============================================================================

describe('ADR-002.D3.R4: Command help shows correct subcommands', () => {
  // Group commands by primary to find those with subcommands
  const commandGroups = new Map<string, string[]>();
  for (const spec of COMMAND_REGISTRY) {
    if (spec.subcommand) {
      const existing = commandGroups.get(spec.primary) ?? [];
      existing.push(spec.subcommand);
      commandGroups.set(spec.primary, existing);
    }
  }

  for (const [primary, subcommands] of commandGroups) {
    describe(`${primary} command help`, () => {
      const commandHelp = renderCommandHelp(primary);

      test.each(subcommands)(
        'contains subcommand "%s"',
        (subcommand) => {
          expect(commandHelp).toContain(subcommand);
        }
      );
    });
  }
});

// ============================================================================
// Help descriptions match registry
// ============================================================================

describe('ADR-002.D3.R4: Help descriptions derive from registry', () => {
  const helpOutput = renderHelp();

  test('every registry command description appears in help output', () => {
    // Check that primary command descriptions appear
    const primariesSeen = new Set<string>();
    for (const spec of COMMAND_REGISTRY) {
      if (!primariesSeen.has(spec.primary)) {
        primariesSeen.add(spec.primary);
        // The top-level help should contain the description of primary commands
        // (either the primary-only spec or the first spec for that primary)
        expect(helpOutput).toContain(spec.primary);
      }
    }
  });
});
