/**
 * Phase 2 Stage 6 — TDD Plan Generator (London School, Outside-In)
 *
 * Generates a London School (mockist, outside-in) TDD plan from the DDD
 * domain model and SPARC architecture output. The plan starts from the
 * outermost boundary (acceptance tests at the api-gateway) and works
 * inward to unit tests at the data layer.
 *
 * Exports:
 *  - generateTDDPlan(context)          — async pipeline entry point
 *  - buildTDDPlan(ddd, sparc)          — pure, testable builder
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import type {
  Phase2Context,
  Phase2StageOutput,
  Phase2DomainModel,
  Phase2SPARCOutput,
  TDDPlan,
  TestPyramid,
  TDDTestSuite,
  TDDTestCase,
  MockContract,
  MockContractMethod,
  SeamDefinition,
  TelemetrySpan as ContextTelemetrySpan,
} from '../types.js';
import { createSpan, endSpan, emitSpan } from '../telemetry.js';

// ============================================================================
// Constants
// ============================================================================

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

/**
 * Context-name ordering for London School bottom-up execution.
 * Lower priority values execute first. Names not in this map default
 * to priority 50.
 */
const EXECUTION_PRIORITY: Record<string, number> = {
  'data-persistence': 10,
  'core-engine': 20,
  'integration-adapter': 30,
  'monitoring': 40,
  'governance': 45,
  'api-gateway': 60,
};

/**
 * Layer ordering within a bounded context for execution sequencing.
 * Lower values execute first (unit before integration).
 */
const LAYER_PRIORITY: Record<string, number> = {
  'unit': 1,
  'integration': 2,
  'acceptance': 3,
  'e2e': 4,
};

// ============================================================================
// Helpers
// ============================================================================

/**
 * Convert a string to PascalCase.
 * Splits on hyphens, underscores, spaces, and camelCase boundaries,
 * then capitalizes the first letter of each segment.
 */
function pascalCase(text: string): string {
  return text
    .replace(/[-_\s]+(.)?/g, (_, c: string | undefined) => (c ? c.toUpperCase() : ''))
    .replace(/^(.)/, (_, c: string) => c.toUpperCase());
}

/**
 * Convert a string to a URL/file-safe slug.
 * Lowercases, replaces non-alphanumeric runs with hyphens, trims hyphens.
 */
function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Format a number as a zero-padded 3-digit string.
 */
function pad3(n: number): string {
  return String(n).padStart(3, '0');
}

// ============================================================================
// Test Case / Suite Builders
// ============================================================================

/**
 * Mutable counter shared across all suite-building functions to assign
 * globally sequential test case IDs (TC-001, TC-002, ...).
 */
interface Counter {
  value: number;
}

/**
 * Build acceptance test suite for a bounded context.
 * One test per command exercising the happy path with all dependencies mocked.
 */
function buildAcceptanceSuite(
  context: Phase2DomainModel['contexts'][number],
  suiteId: string,
  tc: Counter,
): TDDTestSuite {
  const tests: TDDTestCase[] = context.commands.map((command) => {
    tc.value++;
    const dependencies = context.aggregates
      .flatMap((agg) => agg.entities.map((e) => e.name))
      .slice(0, 3);
    return {
      id: `TC-${pad3(tc.value)}`,
      name: `${command.name} acceptance`,
      given: 'The system is initialized with valid configuration and dependencies',
      when: `${command.name} is invoked with ${command.input.join(', ')}`,
      then: command.postconditions.join(' AND '),
      mockSetup: dependencies.map((dep) => `Mock ${dep} with happy-path responses`),
      assertionType: 'behavior' as const,
    };
  });

  return {
    id: suiteId,
    boundedContext: context.name,
    layer: 'acceptance',
    name: `${context.name} Acceptance Tests`,
    description: `Outside-in acceptance tests for ${context.name} bounded context`,
    tests,
    mockDependencies: context.aggregates
      .flatMap((agg) => agg.entities.map((e) => e.name))
      .slice(0, 5),
    adrRefs: context.adrRefs,
  };
}

/**
 * Build integration test suite for a bounded context.
 * One test per context relation where this context participates.
 */
function buildIntegrationSuite(
  context: Phase2DomainModel['contexts'][number],
  relations: Phase2DomainModel['contextMap'],
  suiteId: string,
  tc: Counter,
): TDDTestSuite | null {
  const relevantRelations = relations.filter(
    (r) => r.upstream === context.name || r.downstream === context.name,
  );

  if (relevantRelations.length === 0) {
    return null;
  }

  const tests: TDDTestCase[] = relevantRelations.map((relation) => {
    tc.value++;
    const otherContext = relation.upstream === context.name
      ? relation.downstream
      : relation.upstream;
    const relevantCommand = context.commands[0];
    const commandName = relevantCommand?.name ?? `${context.name}Operation`;

    return {
      id: `TC-${pad3(tc.value)}`,
      name: `${context.name} <-> ${otherContext} integration`,
      given: 'Both services are running with real implementations',
      when: `${commandName} is invoked crossing the ${context.name}-${otherContext} boundary`,
      then: 'Response conforms to contract and data flows correctly',
      mockSetup: [],
      assertionType: 'state' as const,
    };
  });

  return {
    id: suiteId,
    boundedContext: context.name,
    layer: 'integration',
    name: `${context.name} Integration Tests`,
    description: `Integration tests for ${context.name} boundary interactions`,
    tests,
    mockDependencies: [],
    adrRefs: context.adrRefs,
  };
}

/**
 * Build unit test suite for a bounded context.
 * One test per aggregate invariant, one per value object invariant,
 * and one per domain event.
 */
function buildUnitSuite(
  context: Phase2DomainModel['contexts'][number],
  suiteId: string,
  tc: Counter,
): TDDTestSuite {
  const tests: TDDTestCase[] = [];

  // All dependency names for mock setup
  const allDependencies = context.aggregates
    .flatMap((agg) => agg.entities.map((e) => e.name));

  // One test per aggregate invariant
  for (const aggregate of context.aggregates) {
    for (const invariant of aggregate.invariants) {
      tc.value++;
      tests.push({
        id: `TC-${pad3(tc.value)}`,
        name: `${aggregate.name} invariant: ${invariant.slice(0, 50)}`,
        given: `A valid ${aggregate.name} instance`,
        when: `Invariant '${invariant}' is violated`,
        then: 'Error is thrown with descriptive message',
        mockSetup: allDependencies.map((dep) => `Mock ${dep}`),
        assertionType: 'interaction' as const,
      });
    }

    // One test per value object invariant
    for (const vo of aggregate.valueObjects) {
      for (const invariant of vo.invariants) {
        tc.value++;
        tests.push({
          id: `TC-${pad3(tc.value)}`,
          name: `${vo.name} invariant: ${invariant.slice(0, 50)}`,
          given: `A valid ${aggregate.name} instance`,
          when: `Invariant '${invariant}' is violated`,
          then: 'Error is thrown with descriptive message',
          mockSetup: allDependencies.map((dep) => `Mock ${dep}`),
          assertionType: 'interaction' as const,
        });
      }
    }
  }

  // One test per domain event
  for (const event of context.domainEvents) {
    tc.value++;
    tests.push({
      id: `TC-${pad3(tc.value)}`,
      name: `${event.name} event emission`,
      given: `A ${event.triggeredBy} command is processed`,
      when: 'Processing completes successfully',
      then: `${event.name} event is emitted with correct payload`,
      mockSetup: allDependencies.map((dep) => `Mock ${dep}`),
      assertionType: 'interaction' as const,
    });
  }

  return {
    id: suiteId,
    boundedContext: context.name,
    layer: 'unit',
    name: `${context.name} Unit Tests`,
    description: `London School unit tests for ${context.name} aggregates, value objects, and domain events`,
    tests,
    mockDependencies: allDependencies,
    adrRefs: context.adrRefs,
  };
}

/**
 * Build E2E test suite. Only generated for the api-gateway context.
 * Contains 2-3 tests covering the full request flow with no mocks.
 */
function buildE2ESuite(
  context: Phase2DomainModel['contexts'][number],
  suiteId: string,
  tc: Counter,
): TDDTestSuite {
  const tests: TDDTestCase[] = [];

  // Test 1: Full happy-path request flow
  tc.value++;
  tests.push({
    id: `TC-${pad3(tc.value)}`,
    name: 'Full request happy path',
    given: 'The entire system is deployed and running',
    when: 'A valid request is sent through the API gateway',
    then: 'Response is received with correct status and payload',
    mockSetup: [],
    assertionType: 'state' as const,
  });

  // Test 2: Error propagation through all layers
  tc.value++;
  tests.push({
    id: `TC-${pad3(tc.value)}`,
    name: 'Error propagation through layers',
    given: 'The entire system is deployed and running',
    when: 'An invalid request triggers a downstream error',
    then: 'Error response propagates correctly with appropriate status code',
    mockSetup: [],
    assertionType: 'state' as const,
  });

  // Test 3: Concurrent request handling (if context has multiple commands)
  if (context.commands.length > 1) {
    tc.value++;
    tests.push({
      id: `TC-${pad3(tc.value)}`,
      name: 'Concurrent request handling',
      given: 'The entire system is deployed and running under load',
      when: 'Multiple concurrent requests are sent through the API gateway',
      then: 'All requests are processed correctly without interference',
      mockSetup: [],
      assertionType: 'state' as const,
    });
  }

  return {
    id: suiteId,
    boundedContext: context.name,
    layer: 'e2e',
    name: `${context.name} E2E Tests`,
    description: `End-to-end tests for ${context.name} covering full request lifecycle`,
    tests,
    mockDependencies: [],
    adrRefs: context.adrRefs,
  };
}

// ============================================================================
// Mock Contracts Builder
// ============================================================================

/**
 * Build mock contracts from context relations.
 * Each relation produces one MockContract with 2-3 methods derived from
 * the upstream context's queries and commands.
 */
function buildMockContracts(
  ddd: Phase2DomainModel,
): MockContract[] {
  const contracts: MockContract[] = [];
  const contextMap = new Map(ddd.contexts.map((c) => [c.name, c]));

  for (let i = 0; i < ddd.contextMap.length; i++) {
    const relation = ddd.contextMap[i]!;
    const upstream = contextMap.get(relation.upstream);
    if (!upstream) continue;

    const interfaceName = `I${pascalCase(relation.upstream)}Port`;
    const methods: MockContractMethod[] = [];

    // Derive methods from upstream queries (up to 2)
    const queries = upstream.queries.slice(0, 2);
    for (const query of queries) {
      methods.push({
        name: query.name,
        input: query.parameters.join(', '),
        output: query.returns,
        behavior: `Returns successful response with valid ${upstream.name} data`,
      });
    }

    // Derive method from upstream commands (up to 1, to get 2-3 total)
    if (methods.length < 3 && upstream.commands.length > 0) {
      const command = upstream.commands[0]!;
      methods.push({
        name: command.name,
        input: command.input.join(', '),
        output: command.postconditions.join(', '),
        behavior: `Returns successful response with valid ${upstream.name} data`,
      });
    }

    contracts.push({
      id: `MC-${pad3(i + 1)}`,
      name: `${pascalCase(relation.downstream)}To${pascalCase(relation.upstream)}Mock`,
      boundedContext: relation.downstream,
      targetService: relation.upstream,
      interfaceName,
      methods,
    });
  }

  return contracts;
}

// ============================================================================
// Seam Definitions Builder
// ============================================================================

/**
 * Build seam definitions from context relations.
 * Each relation produces one SeamDefinition describing the boundary,
 * contract type, and integration test approach.
 */
function buildSeamDefinitions(
  ddd: Phase2DomainModel,
): SeamDefinition[] {
  const seams: SeamDefinition[] = [];
  const contextMap = new Map(ddd.contexts.map((c) => [c.name, c]));

  for (let i = 0; i < ddd.contextMap.length; i++) {
    const relation = ddd.contextMap[i]!;

    // Determine contract type
    let contractType: SeamDefinition['contractType'];
    if (relation.type === 'anticorruption-layer') {
      contractType = 'sync-request-response';
    } else {
      // Check if any domain events flow between the contexts
      const upstream = contextMap.get(relation.upstream);
      const downstream = contextMap.get(relation.downstream);
      const hasEventFlow = upstream?.domainEvents.some((event) =>
        downstream?.commands.some((cmd) =>
          cmd.name.toLowerCase().includes(event.name.toLowerCase().replace(/event$/i, '').trim()) ||
          event.triggeredBy.toLowerCase().includes(cmd.name.toLowerCase()),
        ),
      ) ?? false;

      contractType = hasEventFlow ? 'async-event' : 'sync-request-response';
    }

    const interfaceName = `I${pascalCase(relation.upstream)}Port`;

    seams.push({
      id: `SEAM-${pad3(i + 1)}`,
      name: `${relation.upstream}-to-${relation.downstream}-seam`,
      between: [relation.upstream, relation.downstream] as const,
      contractType,
      mockBoundary: `${interfaceName} at ${relation.downstream} boundary`,
      integrationTestApproach: contractType === 'async-event'
        ? `Verify ${relation.upstream} publishes events that ${relation.downstream} consumes correctly using an in-memory event bus`
        : `Verify ${relation.downstream} calls ${interfaceName} and receives valid responses from ${relation.upstream} using contract tests`,
    });
  }

  return seams;
}

// ============================================================================
// Test Pyramid Computation
// ============================================================================

/**
 * Compute test pyramid distribution from all test suites.
 * Counts tests per layer and computes percentage of total.
 */
function computeTestPyramid(suites: TDDTestSuite[]): TestPyramid {
  const counts = { unit: 0, integration: 0, acceptance: 0, e2e: 0 };

  for (const suite of suites) {
    counts[suite.layer] += suite.tests.length;
  }

  const total = counts.unit + counts.integration + counts.acceptance + counts.e2e;

  const pct = (n: number): number =>
    total === 0 ? 0 : Math.round((n / total) * 1000) / 10;

  return {
    unit: { count: counts.unit, percentage: pct(counts.unit) },
    integration: { count: counts.integration, percentage: pct(counts.integration) },
    acceptance: { count: counts.acceptance, percentage: pct(counts.acceptance) },
    e2e: { count: counts.e2e, percentage: pct(counts.e2e) },
  };
}

// ============================================================================
// Execution Order
// ============================================================================

/**
 * Compute London School bottom-up execution order.
 *
 * Order:
 *  1. data-persistence context suites (unit, then integration)
 *  2. core-engine and integration-adapter suites
 *  3. monitoring and governance suites
 *  4. api-gateway suites
 *  5. e2e suites last
 */
function computeExecutionOrder(suites: TDDTestSuite[]): string[] {
  const sorted = [...suites].sort((a, b) => {
    // E2E suites always go last regardless of context
    const aIsE2E = a.layer === 'e2e' ? 1 : 0;
    const bIsE2E = b.layer === 'e2e' ? 1 : 0;
    if (aIsE2E !== bIsE2E) return aIsE2E - bIsE2E;

    // Sort by context priority
    const aPriority = contextPriority(a.boundedContext);
    const bPriority = contextPriority(b.boundedContext);
    if (aPriority !== bPriority) return aPriority - bPriority;

    // Within same context, sort by layer priority (unit before integration)
    const aLayer = LAYER_PRIORITY[a.layer] ?? 99;
    const bLayer = LAYER_PRIORITY[b.layer] ?? 99;
    return aLayer - bLayer;
  });

  return sorted.map((s) => s.id);
}

/**
 * Return the execution priority for a bounded context name.
 * Uses partial matching against known priority keys.
 */
function contextPriority(contextName: string): number {
  const slug = slugify(contextName);
  for (const [key, priority] of Object.entries(EXECUTION_PRIORITY)) {
    if (slug.includes(key)) return priority;
  }
  return 50;
}

// ============================================================================
// Core builder: pure, deterministic, testable
// ============================================================================

/**
 * Build a complete London School TDD plan from the DDD model and SPARC output.
 *
 * This function is pure (no I/O, no side effects) and deterministic:
 * given the same DDD model and SPARC output it always produces the same plan.
 *
 * @param ddd   - Phase 2 DDD domain model
 * @param sparc - Phase 2 SPARC architecture output
 * @returns A fully populated TDDPlan
 */
export function buildTDDPlan(
  ddd: Phase2DomainModel,
  sparc: Phase2SPARCOutput,
): TDDPlan {
  // sparc is accepted for future extensibility and cross-referencing
  void sparc;

  const suites: TDDTestSuite[] = [];
  const tc: Counter = { value: 0 };
  let suiteCounter = 0;

  for (let contextIndex = 0; contextIndex < ddd.contexts.length; contextIndex++) {
    const context = ddd.contexts[contextIndex]!;
    const isApiGateway = slugify(context.name).includes('api-gateway');

    // a) Acceptance test suite
    suiteCounter++;
    const acceptanceSuiteId = `TS-${pad3(contextIndex * 4 + 1)}`;
    suites.push(buildAcceptanceSuite(context, acceptanceSuiteId, tc));

    // b) Integration test suite (only if context has relations)
    suiteCounter++;
    const integrationSuiteId = `TS-${pad3(contextIndex * 4 + 2)}`;
    const integrationSuite = buildIntegrationSuite(
      context,
      ddd.contextMap,
      integrationSuiteId,
      tc,
    );
    if (integrationSuite) {
      suites.push(integrationSuite);
    }

    // c) Unit test suite
    suiteCounter++;
    const unitSuiteId = `TS-${pad3(contextIndex * 4 + 3)}`;
    suites.push(buildUnitSuite(context, unitSuiteId, tc));

    // d) E2E test suite (only for api-gateway context)
    if (isApiGateway) {
      suiteCounter++;
      const e2eSuiteId = `TS-${pad3(contextIndex * 4 + 4)}`;
      suites.push(buildE2ESuite(context, e2eSuiteId, tc));
    }
  }

  const mockContracts = buildMockContracts(ddd);
  const seamDefinitions = buildSeamDefinitions(ddd);
  const testPyramid = computeTestPyramid(suites);
  const executionOrder = computeExecutionOrder(suites);

  return {
    approach: 'london-school',
    testPyramid,
    testSuites: suites,
    mockContracts,
    seamDefinitions,
    executionOrder,
  };
}

// ============================================================================
// Pipeline entry point
// ============================================================================

/**
 * Generate the TDD plan as Stage 6 of the Phase 2 pipeline.
 *
 * 1. Retrieves the DDD model and SPARC output from prior stage outputs
 * 2. Creates a telemetry span
 * 3. Calls buildTDDPlan (pure builder)
 * 4. Writes artifacts to phase2/tdd/ directory
 * 5. Stores output on context.stageOutputs
 * 6. Returns Phase2StageOutput
 *
 * @param context - Mutable Phase 2 pipeline context
 * @returns Stage output with status, timing, and artifact paths
 */
export async function generateTDDPlan(
  context: Phase2Context,
): Promise<Phase2StageOutput> {
  const span = createSpan('tdd-plan-generation', 'generate', { traceId: context.traceId });
  const startTime = Date.now();

  try {
    // Retrieve upstream stage outputs
    const dddStageOutput = context.stageOutputs.get('ddd-generation');
    if (!dddStageOutput || dddStageOutput.status !== 'completed') {
      throw new Error('DDD generation stage has not completed successfully');
    }

    const sparcStageOutput = context.stageOutputs.get('sparc-specification');
    if (!sparcStageOutput || sparcStageOutput.status !== 'completed') {
      throw new Error('SPARC specification stage has not completed successfully');
    }

    const ddd = dddStageOutput.data as Phase2DomainModel;
    const sparc = sparcStageOutput.data as Phase2SPARCOutput;

    // Pure builder
    const plan = buildTDDPlan(ddd, sparc);

    // Create output directories
    const tddDir = path.join(context.phase2Dir, 'tdd');
    const testSuitesDir = path.join(tddDir, 'test-suites');
    fs.mkdirSync(tddDir, { recursive: true, mode: DIR_MODE });
    fs.mkdirSync(testSuitesDir, { recursive: true, mode: DIR_MODE });

    const artifactPaths: string[] = [];

    // Write tdd-plan.json
    const planPath = path.join(tddDir, 'tdd-plan.json');
    fs.writeFileSync(planPath, JSON.stringify(plan, null, 2), {
      encoding: 'utf-8',
      mode: FILE_MODE,
    });
    artifactPaths.push(planPath);

    // Write mock-contracts.json
    const mockContractsPath = path.join(tddDir, 'mock-contracts.json');
    fs.writeFileSync(mockContractsPath, JSON.stringify(plan.mockContracts, null, 2), {
      encoding: 'utf-8',
      mode: FILE_MODE,
    });
    artifactPaths.push(mockContractsPath);

    // Write seam-definitions.json
    const seamDefsPath = path.join(tddDir, 'seam-definitions.json');
    fs.writeFileSync(seamDefsPath, JSON.stringify(plan.seamDefinitions, null, 2), {
      encoding: 'utf-8',
      mode: FILE_MODE,
    });
    artifactPaths.push(seamDefsPath);

    // Write per-context test suite files
    const contextSuites = new Map<string, TDDTestSuite[]>();
    for (const suite of plan.testSuites) {
      const existing = contextSuites.get(suite.boundedContext) ?? [];
      existing.push(suite);
      contextSuites.set(suite.boundedContext, existing);
    }

    for (const [contextName, suites] of contextSuites) {
      const filename = `${slugify(contextName)}.json`;
      const suitePath = path.join(testSuitesDir, filename);
      fs.writeFileSync(suitePath, JSON.stringify(suites, null, 2), {
        encoding: 'utf-8',
        mode: FILE_MODE,
      });
      artifactPaths.push(suitePath);
    }

    const timing = Date.now() - startTime;

    const totalTests = plan.testSuites.reduce((sum, s) => sum + s.tests.length, 0);

    const output: Phase2StageOutput = {
      stage: 'tdd-plan-generation',
      status: 'completed',
      data: plan,
      artifacts: artifactPaths,
      timing,
      summary: `Generated London School TDD plan: ${plan.testSuites.length} suites, ${totalTests} tests, ${plan.mockContracts.length} mock contracts, ${plan.seamDefinitions.length} seams`,
    };

    context.stageOutputs.set('tdd-plan-generation', output);

    endSpan(span, 'ok', {
      suiteCount: plan.testSuites.length,
      testCount: totalTests,
      mockContractCount: plan.mockContracts.length,
      seamCount: plan.seamDefinitions.length,
      timingMs: timing,
    });
    emitSpan(span);
    context.telemetrySpans.push(span as unknown as ContextTelemetrySpan);

    return output;
  } catch (error: unknown) {
    const timing = Date.now() - startTime;
    const msg = error instanceof Error ? error.message : String(error);

    endSpan(span, 'error', { error: msg, timingMs: timing });
    emitSpan(span);
    context.telemetrySpans.push(span as unknown as ContextTelemetrySpan);

    const output: Phase2StageOutput = {
      stage: 'tdd-plan-generation',
      status: 'failed',
      data: null,
      artifacts: [],
      timing,
      summary: `TDD plan generation failed: ${msg}`,
    };

    context.stageOutputs.set('tdd-plan-generation', output);

    return output;
  }
}
