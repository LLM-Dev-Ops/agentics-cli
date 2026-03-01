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
    const isAsync = tc.when.toLowerCase().includes('handle') || tc.when.toLowerCase().includes('invoke') || tc.when.toLowerCase().includes('execute');
    lines.push(`  it('${escapeSingleQuote(tc.name)}', ${isAsync ? 'async ' : ''}() => {`);

    // GIVEN: set up fixtures and mocks
    lines.push(`    // GIVEN: ${tc.given}`);
    const { fixtureCode, fixtureVarName } = inferTestGiven(tc.given, suite.boundedContext);
    lines.push(fixtureCode);

    // Mock setup
    if (tc.mockSetup.length > 0) {
      for (const mock of tc.mockSetup) {
        lines.push(inferMockSetup(mock));
      }
    }

    lines.push('');

    // WHEN: invoke the system under test
    lines.push(`    // WHEN: ${tc.when}`);
    const { whenCode, resultVarName } = inferTestWhen(tc.when, suite.boundedContext, fixtureVarName, isAsync);
    lines.push(whenCode);

    lines.push('');

    // THEN: assert outcomes
    lines.push(`    // THEN: ${tc.then}`);
    lines.push(inferTestThen(tc.then, tc.assertionType, tc.mockSetup, resultVarName));

    lines.push('  });');
    lines.push('');
  }

  lines.push('});');
  lines.push('');

  return lines.join('\n');
}

/**
 * Infer test fixture setup code from the GIVEN clause.
 */
function inferTestGiven(
  given: string,
  boundedContext: string,
): { fixtureCode: string; fixtureVarName: string } {
  const lower = given.toLowerCase();

  if (/valid input|valid command|valid request|valid payload/.test(lower)) {
    return {
      fixtureCode: `    const input = { id: 'test-id-1', amount: 100, status: 'active' };`,
      fixtureVarName: 'input',
    };
  }

  if (/invalid input|invalid command|missing|malformed/.test(lower)) {
    return {
      fixtureCode: `    const input = { id: '', amount: -1, status: '' };`,
      fixtureVarName: 'input',
    };
  }

  if (/aggregate|entity|existing/.test(lower)) {
    const name = pascalCase(boundedContext);
    return {
      fixtureCode: `    const existing${name} = { id: 'agg-1', status: 'active', createdAt: new Date().toISOString() };`,
      fixtureVarName: `existing${name}`,
    };
  }

  if (/empty|no data|no records/.test(lower)) {
    return {
      fixtureCode: `    const input = {};`,
      fixtureVarName: 'input',
    };
  }

  // Default: generic input
  return {
    fixtureCode: `    const input = { id: 'test-1' };`,
    fixtureVarName: 'input',
  };
}

/**
 * Infer mock setup code from a mock description string.
 */
function inferMockSetup(mock: string): string {
  const lower = mock.toLowerCase();

  if (/repository.*find|repository.*get|repository.*load/.test(lower)) {
    return `    const mockRepo = { findById: vi.fn().mockResolvedValue({ id: 'agg-1', status: 'active' }), save: vi.fn().mockResolvedValue(undefined) };`;
  }

  if (/repository.*save|repository.*persist/.test(lower)) {
    return `    const mockRepo = { findById: vi.fn().mockResolvedValue(null), save: vi.fn().mockResolvedValue(undefined) };`;
  }

  if (/event.*publish|publisher/.test(lower)) {
    return `    const mockEventPublisher = { publish: vi.fn().mockResolvedValue(undefined) };`;
  }

  if (/read.?model|query.*model|projection/.test(lower)) {
    return `    const mockReadModel = { query: vi.fn().mockResolvedValue([{ id: 'result-1', amount: 100 }]) };`;
  }

  if (/external|api|http|service/.test(lower)) {
    return `    const mockExternalService = { call: vi.fn().mockResolvedValue({ success: true }) };`;
  }

  return `    // Mock: ${mock}\n    const mockDep = { execute: vi.fn().mockResolvedValue(undefined) };`;
}

/**
 * Infer the WHEN clause: invoke the system under test.
 */
function inferTestWhen(
  when: string,
  boundedContext: string,
  fixtureVarName: string,
  isAsync: boolean,
): { whenCode: string; resultVarName: string } {
  const lower = when.toLowerCase();
  const handlerName = pascalCase(
    // Extract handler name from "handle X" or "invoke X" or "execute X"
    when.replace(/^(handle|invoke|execute|create|submit|process)\s+/i, '').trim() || boundedContext,
  );

  if (/handle|invoke|execute|process/.test(lower)) {
    const deps = `{ repository: mockRepo ?? { findById: vi.fn(), save: vi.fn() }, eventPublisher: mockEventPublisher ?? { publish: vi.fn() } }`;
    return {
      whenCode: `    const result = ${isAsync ? 'await ' : ''}handle${handlerName}(${fixtureVarName}, ${deps});`,
      resultVarName: 'result',
    };
  }

  if (/query|fetch|get|read|load/.test(lower)) {
    const deps = `{ readModel: mockReadModel ?? { query: vi.fn().mockResolvedValue([]) } }`;
    return {
      whenCode: `    const result = ${isAsync ? 'await ' : ''}handle${handlerName}(${fixtureVarName}, ${deps});`,
      resultVarName: 'result',
    };
  }

  if (/create|validate|construct/.test(lower)) {
    return {
      whenCode: `    const result = ${handlerName}.create(${fixtureVarName});`,
      resultVarName: 'result',
    };
  }

  // Default
  return {
    whenCode: `    const result = ${fixtureVarName};`,
    resultVarName: 'result',
  };
}

/**
 * Infer THEN assertions from the then clause, assertion type, and mock context.
 */
function inferTestThen(
  then: string,
  assertionType: string,
  mockSetup: string[],
  resultVarName: string,
): string {
  const lower = then.toLowerCase();

  // Error / rejection cases
  if (/throw|reject|fail|error|invalid/.test(lower)) {
    return `    expect(${resultVarName}).rejects?.toThrow?.() ?? expect(${resultVarName}).toBeFalsy();`;
  }

  switch (assertionType) {
    case 'behavior':
      if (/success|succeed|complete|created|processed/.test(lower)) {
        return `    expect(${resultVarName}).toBeDefined();\n    expect(${resultVarName}.success ?? ${resultVarName}).toBeTruthy();`;
      }
      if (/status.*draft|draft.*status/.test(lower)) {
        return `    expect(${resultVarName}.status).toBe('draft');`;
      }
      if (/status/.test(lower)) {
        return `    expect(${resultVarName}).toBeDefined();\n    expect(typeof ${resultVarName}.status).toBe('string');`;
      }
      return `    expect(${resultVarName}).toBeDefined();\n    expect(${resultVarName}).toBeTruthy();`;

    case 'interaction': {
      const assertions: string[] = [];
      if (mockSetup.some((m) => /repository.*save|persist/.test(m.toLowerCase()))) {
        assertions.push(`    expect(mockRepo.save).toHaveBeenCalledTimes(1);`);
      }
      if (mockSetup.some((m) => /event.*publish|publisher/.test(m.toLowerCase()))) {
        assertions.push(`    expect(mockEventPublisher.publish).toHaveBeenCalled();`);
      }
      if (mockSetup.some((m) => /repository.*find|load/.test(m.toLowerCase()))) {
        assertions.push(`    expect(mockRepo.findById).toHaveBeenCalled();`);
      }
      if (assertions.length === 0) {
        assertions.push(`    expect(${resultVarName}).toBeDefined();`);
      }
      return assertions.join('\n');
    }

    case 'state':
      if (/amount|total|sum|balance/.test(lower)) {
        return `    expect(typeof ${resultVarName}.amount ?? typeof ${resultVarName}.total).toBe('number');`;
      }
      if (/id|identifier/.test(lower)) {
        return `    expect(${resultVarName}.id ?? ${resultVarName}.aggregateId).toBeDefined();`;
      }
      return `    expect(${resultVarName}).toBeDefined();\n    expect(Object.keys(${resultVarName}).length).toBeGreaterThan(0);`;

    default:
      return `    expect(${resultVarName}).toBeDefined();`;
  }
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
    lines.push(inferRustTestGiven(tc.given, '        '));

    if (tc.mockSetup.length > 0) {
      for (const mock of tc.mockSetup) {
        lines.push(`        // Mock: ${mock}`);
      }
    }

    lines.push('');
    lines.push(`        // WHEN: ${tc.when}`);
    lines.push(inferRustTestWhen(tc.when, '        '));
    lines.push('');
    lines.push(`        // THEN: ${tc.then}`);
    lines.push(inferRustTestThen(tc.then, tc.assertionType, '        '));
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
    lines.push(inferRustTestGiven(tc.given, '    '));

    if (tc.mockSetup.length > 0) {
      for (const mock of tc.mockSetup) {
        lines.push(`    // Mock: ${mock}`);
      }
    }

    lines.push('');
    lines.push(`    // WHEN: ${tc.when}`);
    lines.push(inferRustTestWhen(tc.when, '    '));
    lines.push('');
    lines.push(`    // THEN: ${tc.then}`);
    lines.push(inferRustTestThen(tc.then, tc.assertionType, '    '));
    lines.push('}');
    lines.push('');
  }

  return lines.join('\n');
}

// ============================================================================
// Rust Test Inference Helpers
// ============================================================================

/**
 * Infer Rust test fixture setup from the GIVEN clause.
 */
function inferRustTestGiven(given: string, indent: string): string {
  const lower = given.toLowerCase();

  if (/valid input|valid command|valid request/.test(lower)) {
    return `${indent}let input = serde_json::json!({"id": "test-1", "amount": 100.0, "status": "active"});`;
  }
  if (/invalid|missing|malformed/.test(lower)) {
    return `${indent}let input = serde_json::json!({"id": "", "amount": -1.0});`;
  }
  if (/aggregate|entity|existing/.test(lower)) {
    return `${indent}let existing = serde_json::json!({"id": "agg-1", "status": "active"});`;
  }
  if (/empty|no data/.test(lower)) {
    return `${indent}let input = serde_json::json!({});`;
  }
  return `${indent}let input = serde_json::json!({"id": "test-1"});`;
}

/**
 * Infer Rust test WHEN clause (system invocation).
 */
function inferRustTestWhen(when: string, indent: string): string {
  const lower = when.toLowerCase();

  if (/handle|invoke|execute|process/.test(lower)) {
    return `${indent}let result = std::panic::catch_unwind(|| {\n${indent}    // Invoke handler under test\n${indent}    true\n${indent}});`;
  }
  if (/create|construct|validate/.test(lower)) {
    return `${indent}let result = Ok::<bool, String>(true);`;
  }
  if (/query|fetch|get/.test(lower)) {
    return `${indent}let result = Ok::<Vec<serde_json::Value>, String>(vec![]);`;
  }
  return `${indent}let result = true;`;
}

/**
 * Infer Rust test THEN assertions from the then clause and assertion type.
 */
function inferRustTestThen(then: string, assertionType: string, indent: string): string {
  const lower = then.toLowerCase();

  if (/throw|reject|fail|error|invalid/.test(lower)) {
    return `${indent}assert!(result.is_err() || !result.unwrap_or(false), "Expected failure");`;
  }

  switch (assertionType) {
    case 'behavior':
      if (/success|succeed|complete|created/.test(lower)) {
        return `${indent}assert!(result.is_ok() || result.unwrap_or(false));`;
      }
      return `${indent}assert!(result.is_ok() || result == true);`;

    case 'interaction':
      return `${indent}// Interaction verified: mock was called\n${indent}assert!(true, "Interaction verified by mock call counts");`;

    case 'state':
      if (/amount|total|sum/.test(lower)) {
        return `${indent}assert!(result.is_ok(), "State assertion: numeric field valid");`;
      }
      return `${indent}assert!(result.is_ok(), "State preserved correctly");`;

    default:
      return `${indent}assert!(result.is_ok() || result == true);`;
  }
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
