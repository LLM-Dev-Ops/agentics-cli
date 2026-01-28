/**
 * ADR-002 Decision 3, Rule 6: Gate Bypass Detection
 * CI Check: ADR-002.D3.R6
 *
 * Static analysis of src/cli/index.ts to verify:
 * - All 5 gate enforcement calls are present
 * - Gate calls appear before the switch/case dispatch
 * - No bypass patterns exist
 * - GATE_EXEMPT_COMMANDS match early-exit commands
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GATE_PIPELINE, GATE_EXEMPT_COMMANDS } from '../../../src/contracts/adr-002-operational-enforcement.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CLI_INDEX_PATH = path.resolve(__dirname, '../../../src/cli/index.ts');

// Read the CLI entrypoint source once for all tests
const cliSource = fs.readFileSync(CLI_INDEX_PATH, 'utf-8');

// ============================================================================
// Gate Enforcement Calls Present
// ============================================================================

describe('ADR-002.D3.R6: All gate enforcement calls present', () => {
  const expectedCalls = [
    'enforceExecutionGate',
    'enforceAuthSessionGate',
    'enforceServiceHealthGate',
    'enforceOutputFormatGate',
    'enforceArgumentGuard',
  ];

  test.each(expectedCalls)(
    'CLI entrypoint calls %s',
    (functionName) => {
      expect(cliSource).toContain(functionName);
    }
  );

  test('all 5 gate functions are imported', () => {
    for (const call of expectedCalls) {
      // Check that the function is imported (not just referenced in comments)
      const importPattern = new RegExp(`import\\s*\\{[^}]*${call}[^}]*\\}`, 's');
      expect(cliSource).toMatch(importPattern);
    }
  });
});

// ============================================================================
// Gate Calls Appear Before Dispatch
// ============================================================================

describe('ADR-002.D3.R6: Gates execute before command dispatch', () => {
  test('gate calls appear before switch statement', () => {
    const switchIndex = cliSource.indexOf('switch (parsed.command)');
    expect(switchIndex).toBeGreaterThan(0);

    // Each gate enforcement must appear before the switch
    const gates = [
      'enforceExecutionGate',
      'enforceAuthSessionGate',
      'enforceServiceHealthGate',
      'enforceOutputFormatGate',
      'enforceArgumentGuard',
    ];

    for (const gate of gates) {
      // Find the actual invocation (not just import or comment)
      // Gate calls may be: direct call, await call, or assigned to variable
      const callPattern = new RegExp(`(?:await\\s+)?(?:\\w+\\s*=\\s*)?${gate}\\(`, 'g');
      // Strip imports and comments to find actual invocations
      const cliWithoutImports = cliSource.replace(/^import\s.+$/gm, '');
      const match = cliWithoutImports.match(callPattern);
      expect(match).not.toBeNull();

      if (match) {
        // Skip past the import line to find the actual call
        const importLine = `import { ${gate}`;
        const importIndex = cliSource.indexOf(importLine);
        const callIndex = cliSource.indexOf(`${gate}(`, importIndex > -1 ? importIndex + importLine.length : 0);
        expect(callIndex).toBeGreaterThan(0);
        expect(callIndex).toBeLessThan(switchIndex);
      }
    }
  });
});

// ============================================================================
// Gate Pipeline Matches Implementation
// ============================================================================

describe('ADR-002.D3.R6: Gate pipeline matches GATE_PIPELINE constant', () => {
  test('GATE_PIPELINE has entries for all 5 gates', () => {
    expect(GATE_PIPELINE).toHaveLength(5);
  });

  test('each GATE_PIPELINE entry references an existing gate module', () => {
    for (const gate of GATE_PIPELINE) {
      const modulePath = path.resolve(__dirname, '../../../src', gate.module);
      expect(fs.existsSync(modulePath)).toBe(true);
    }
  });
});

// ============================================================================
// No Bypass Patterns
// ============================================================================

describe('ADR-002.D3.R6: No bypass patterns detected', () => {
  test('no --skip-gates or --no-validate flags', () => {
    expect(cliSource).not.toContain('skip-gates');
    expect(cliSource).not.toContain('no-validate');
    expect(cliSource).not.toContain('skip-validation');
    expect(cliSource).not.toContain('unsafe-mode');
  });

  test('no DISABLE_SCHEMA_VALIDATION environment variable', () => {
    expect(cliSource).not.toContain('DISABLE_SCHEMA_VALIDATION');
    expect(cliSource).not.toContain('SKIP_GATES');
    expect(cliSource).not.toContain('NO_VALIDATION');
  });
});

// ============================================================================
// Exempt Commands Match
// ============================================================================

describe('ADR-002.D3.R6: Exempt commands match early-exit paths', () => {
  test('help command exits before gate pipeline', () => {
    expect(GATE_EXEMPT_COMMANDS).toContain('help');

    // Verify help exits before gates in the source
    const helpExit = cliSource.indexOf("parsed.command === 'help'");
    const firstGate = cliSource.indexOf('enforceExecutionGate(');
    expect(helpExit).toBeGreaterThan(0);
    expect(firstGate).toBeGreaterThan(0);
    expect(helpExit).toBeLessThan(firstGate);
  });

  test('version command exits before gate pipeline', () => {
    expect(GATE_EXEMPT_COMMANDS).toContain('version');

    // Verify version exits before gates in the source
    const versionExit = cliSource.indexOf("parsed.command === 'version'");
    const firstGate = cliSource.indexOf('enforceExecutionGate(');
    expect(versionExit).toBeGreaterThan(0);
    expect(firstGate).toBeGreaterThan(0);
    expect(versionExit).toBeLessThan(firstGate);
  });
});
