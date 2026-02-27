/**
 * Phase 3 Test Generator — London School TDD
 *
 * Generates test files from the Phase 2 TDD plan following London School
 * (mockist) TDD principles. Produces Vitest test files for TypeScript
 * and inline/integration test modules for Rust.
 *
 * Exports:
 *   - buildTestFiles() — pure builder returning TestGenOutput
 *   - generateTests()  — pipeline stage entry returning Phase3StageOutput
 */

import type {
  Phase3Context,
  Phase3StageOutput,
  ImplementationLanguage,
  LanguageResolution,
  TestFile,
  TestGenOutput,
} from '../types.js';
import type {
  TDDPlan,
  TDDTestSuite,
  MockContract,
  Phase2DomainModel,
} from '../../phase2/types.js';
import { createSpan, endSpan, emitSpan } from '../../phase2/telemetry.js';
import * as fs from 'node:fs';
import * as path from 'node:path';

// ============================================================================
// Helpers
// ============================================================================

/**
 * Convert a PascalCase, camelCase, or space-separated name into a
 * lowercase kebab-case slug suitable for file paths.
 */
function slugify(name: string): string {
  return name
    .replace(/([a-z])([A-Z])/g, '$1-$2')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase();
}

/**
 * Convert a name into a snake_case identifier suitable for Rust
 * function and module names.
 */
function snakeCase(name: string): string {
  return name
    .replace(/([a-z])([A-Z])/g, '$1_$2')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_|_$/g, '')
    .toLowerCase();
}

/**
 * Convert a name into a PascalCase identifier suitable for TypeScript
 * interface and class names.
 */
function pascalCase(name: string): string {
  return name
    .replace(/[^a-zA-Z0-9]+/g, ' ')
    .split(' ')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join('');
}

// ============================================================================
// TypeScript Test Generation (Vitest)
// ============================================================================

/**
 * Generate the content of a single Vitest test file for a TDDTestSuite.
 */
function generateVitestSuiteContent(suite: TDDTestSuite): string {
  const lines: string[] = [];

  lines.push(`import { describe, it, expect, vi } from 'vitest';`);
  lines.push('');
  lines.push(`describe('${escapeSingleQuote(suite.name)}', () => {`);

  for (const tc of suite.tests) {
    lines.push(`  it('${escapeSingleQuote(tc.name)}', () => {`);
    lines.push(`    // GIVEN: ${tc.given}`);

    if (tc.mockSetup.length > 0) {
      for (const mock of tc.mockSetup) {
        lines.push(`    // Mock: ${mock}`);
      }
    }

    lines.push('');
    lines.push(`    // WHEN: ${tc.when}`);
    lines.push('');
    lines.push(`    // THEN: ${tc.then}`);
    lines.push('    expect(true).toBe(true); // TODO: implement assertion');
    lines.push('  });');
    lines.push('');
  }

  lines.push('});');
  lines.push('');

  return lines.join('\n');
}

/**
 * Determine the relative file path for a TypeScript test file based on
 * the test suite's layer and bounded context.
 */
function tsTestFilePath(suite: TDDTestSuite): string {
  const contextSlug = slugify(suite.boundedContext);
  const suiteSlug = slugify(suite.name);

  switch (suite.layer) {
    case 'unit':
      return `tests/unit/${contextSlug}/${suiteSlug}.test.ts`;
    case 'integration':
      return `tests/integration/${contextSlug}/${suiteSlug}.test.ts`;
    case 'acceptance':
      return `tests/acceptance/${contextSlug}/${suiteSlug}.test.ts`;
    case 'e2e':
      return `tests/e2e/${suiteSlug}.test.ts`;
  }
}

/**
 * Generate a mock factory file from a MockContract for TypeScript.
 */
function generateTsMockContent(contract: MockContract): string {
  const interfaceName = `I${pascalCase(contract.interfaceName)}`;
  const seamSlug = slugify(contract.targetService);
  const contextSlug = slugify(contract.boundedContext);
  const mockName = pascalCase(contract.name);

  const lines: string[] = [];

  lines.push(`// Mock factory for ${contract.name}`);
  lines.push(`import type { ${interfaceName} } from '../../src/${contextSlug}/ports/${seamSlug}.js';`);
  lines.push(`import { vi } from 'vitest';`);
  lines.push('');
  lines.push(`export function create${mockName}(): ${interfaceName} {`);
  lines.push('  return {');

  for (const method of contract.methods) {
    lines.push(`    ${method.name}: vi.fn(),`);
  }

  lines.push('  };');
  lines.push('}');
  lines.push('');

  return lines.join('\n');
}

// ============================================================================
// Rust Test Generation
// ============================================================================

/**
 * Generate an inline Rust test module for a unit test suite.
 */
function generateRustUnitTestContent(suite: TDDTestSuite): string {
  const lines: string[] = [];

  lines.push('#[cfg(test)]');
  lines.push('mod tests {');
  lines.push('    use super::*;');
  lines.push('');

  for (const tc of suite.tests) {
    const fnName = snakeCase(tc.name);

    lines.push('    #[test]');
    lines.push(`    fn test_${fnName}() {`);
    lines.push(`        // GIVEN: ${tc.given}`);

    if (tc.mockSetup.length > 0) {
      for (const mock of tc.mockSetup) {
        lines.push(`        // Mock: ${mock}`);
      }
    }

    lines.push('');
    lines.push(`        // WHEN: ${tc.when}`);
    lines.push('');
    lines.push(`        // THEN: ${tc.then}`);
    lines.push('        assert!(true); // TODO: implement');
    lines.push('    }');
    lines.push('');
  }

  lines.push('}');
  lines.push('');

  return lines.join('\n');
}

/**
 * Generate a standalone Rust integration/acceptance/e2e test file.
 */
function generateRustIntegrationTestContent(suite: TDDTestSuite): string {
  const lines: string[] = [];

  lines.push(`//! ${suite.name}`);
  lines.push('//!');
  lines.push(`//! ${suite.description}`);
  lines.push('');

  for (const tc of suite.tests) {
    const fnName = snakeCase(tc.name);

    lines.push('#[test]');
    lines.push(`fn test_${fnName}() {`);
    lines.push(`    // GIVEN: ${tc.given}`);

    if (tc.mockSetup.length > 0) {
      for (const mock of tc.mockSetup) {
        lines.push(`    // Mock: ${mock}`);
      }
    }

    lines.push('');
    lines.push(`    // WHEN: ${tc.when}`);
    lines.push('');
    lines.push(`    // THEN: ${tc.then}`);
    lines.push('    assert!(true); // TODO: implement');
    lines.push('}');
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Determine the relative file path for a Rust test file based on
 * the test suite's layer and bounded context.
 */
function rustTestFilePath(suite: TDDTestSuite): string {
  const contextSlug = slugify(suite.boundedContext);
  const suiteSlug = slugify(suite.name);

  switch (suite.layer) {
    case 'unit':
      // Inline tests are appended to the source module; store separately
      // for scaffold merging.
      return `tests/unit/${contextSlug}/${suiteSlug}.rs`;
    case 'integration':
      return `tests/integration/${contextSlug}/${suiteSlug}.rs`;
    case 'acceptance':
      return `tests/acceptance/${contextSlug}/${suiteSlug}.rs`;
    case 'e2e':
      return `tests/e2e/${suiteSlug}.rs`;
  }
}

// ============================================================================
// Escape Utility
// ============================================================================

function escapeSingleQuote(s: string): string {
  return s.replace(/'/g, "\\'");
}

// ============================================================================
// Pure Builder
// ============================================================================

/**
 * Build all test files from the Phase 2 TDD plan.
 *
 * This is a pure function: it computes the test file contents without
 * performing any I/O. Call the pipeline entry `generateTests()` to both
 * build and write them to disk.
 *
 * @param tddPlan     - The TDD plan from Phase 2
 * @param domainModel - The DDD domain model from Phase 2
 * @param language    - The resolved implementation language
 * @returns TestGenOutput with all generated files and distribution metrics
 */
export function buildTestFiles(
  tddPlan: TDDPlan,
  _domainModel: Phase2DomainModel,
  language: ImplementationLanguage,
): TestGenOutput {
  const files: TestFile[] = [];

  const pyramidDistribution = {
    unit: 0,
    integration: 0,
    acceptance: 0,
    e2e: 0,
  };

  // ---- Generate test suite files ----

  for (const suite of tddPlan.testSuites) {
    let content: string;
    let relativePath: string;

    if (language === 'typescript') {
      content = generateVitestSuiteContent(suite);
      relativePath = tsTestFilePath(suite);
    } else {
      if (suite.layer === 'unit') {
        content = generateRustUnitTestContent(suite);
      } else {
        content = generateRustIntegrationTestContent(suite);
      }
      relativePath = rustTestFilePath(suite);
    }

    const testCount = suite.tests.length;
    pyramidDistribution[suite.layer] += testCount;

    files.push({
      relativePath,
      content,
      boundedContext: suite.boundedContext,
      layer: suite.layer,
      testCount,
    });
  }

  // ---- Generate mock files (TypeScript only) ----

  if (language === 'typescript') {
    for (const contract of tddPlan.mockContracts) {
      const contractSlug = slugify(contract.name);
      const mockContent = generateTsMockContent(contract);

      files.push({
        relativePath: `tests/mocks/${contractSlug}.mock.ts`,
        content: mockContent,
        boundedContext: contract.boundedContext,
        layer: 'unit',
        testCount: 0,
      });
    }
  }

  const totalTests =
    pyramidDistribution.unit +
    pyramidDistribution.integration +
    pyramidDistribution.acceptance +
    pyramidDistribution.e2e;

  return {
    files,
    totalTests,
    pyramidDistribution,
  };
}

// ============================================================================
// Pipeline Stage Entry
// ============================================================================

/**
 * Pipeline stage entry point for test generation.
 *
 * Reads the TDD plan and domain model from the Phase 3 context,
 * builds all test files, writes them to disk under the project
 * directory, and returns a Phase3StageOutput.
 *
 * @param context - The Phase 3 pipeline context
 * @returns Phase3StageOutput summarizing test generation results
 */
export function generateTests(context: Phase3Context): Phase3StageOutput {
  const span = createSpan('test-generation', 'generate-tests');
  const startTime = Date.now();

  try {
    // Resolve language from prior stage output
    const langStageOutput = context.stageOutputs.get('language-resolution');
    if (!langStageOutput || langStageOutput.status === 'failed') {
      const failedSpan = endSpan(span, 'error', { reason: 'language-resolution not available' });
      emitSpan(failedSpan);
      context.telemetrySpans.push(failedSpan);

      return {
        stage: 'test-generation',
        status: 'failed',
        data: { error: 'ECLI-P3-002: language-resolution stage output not available' },
        artifacts: [],
        timing: Date.now() - startTime,
        summary: 'Test generation failed: language resolution not available.',
      };
    }

    const langResolution = langStageOutput.data as LanguageResolution;
    const language = langResolution.language;

    const { tddPlan, domainModel } = context.phase2Artifacts;

    // Build test files (pure computation)
    const testOutput = buildTestFiles(tddPlan, domainModel, language);

    // Write files to disk
    const projectDir = path.join(context.phase3Dir, 'project');
    const writtenArtifacts: string[] = [];

    for (const file of testOutput.files) {
      const fullPath = path.join(projectDir, file.relativePath);
      const dir = path.dirname(fullPath);

      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(fullPath, file.content, { encoding: 'utf-8', mode: 0o600 });

      writtenArtifacts.push(file.relativePath);
    }

    const timing = Date.now() - startTime;
    const completedSpan = endSpan(span, 'ok', {
      language,
      totalFiles: testOutput.files.length,
      totalTests: testOutput.totalTests,
      unitTests: testOutput.pyramidDistribution.unit,
      integrationTests: testOutput.pyramidDistribution.integration,
      acceptanceTests: testOutput.pyramidDistribution.acceptance,
      e2eTests: testOutput.pyramidDistribution.e2e,
      timingMs: timing,
    });
    emitSpan(completedSpan);
    context.telemetrySpans.push(completedSpan);

    const summary = [
      `Generated ${testOutput.files.length} test files`,
      `(${testOutput.totalTests} tests:`,
      `${testOutput.pyramidDistribution.unit} unit,`,
      `${testOutput.pyramidDistribution.integration} integration,`,
      `${testOutput.pyramidDistribution.acceptance} acceptance,`,
      `${testOutput.pyramidDistribution.e2e} e2e)`,
      `for ${language}.`,
    ].join(' ');

    return {
      stage: 'test-generation',
      status: 'completed',
      data: testOutput,
      artifacts: writtenArtifacts,
      timing,
      summary,
    };
  } catch (err: unknown) {
    const timing = Date.now() - startTime;
    const message = err instanceof Error ? err.message : String(err);

    const errorSpan = endSpan(span, 'error', { error: message });
    emitSpan(errorSpan);
    context.telemetrySpans.push(errorSpan);

    return {
      stage: 'test-generation',
      status: 'failed',
      data: { error: `ECLI-P3-002: ${message}` },
      artifacts: [],
      timing,
      summary: `Test generation failed: ${message}`,
    };
  }
}
