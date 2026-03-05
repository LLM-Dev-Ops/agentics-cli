/**
 * Phase 2 Stage 6 — TDD Plan Generator (London School, Outside-In)
 *
 * Generates a London School TDD test plan as markdown, driven by the SPARC
 * specification and DDD domain model. Produces rich test descriptions
 * following the ruvnet/sparc methodology rather than pattern-matching.
 *
 * Primary output: TDD markdown documents
 * Compat output: tdd-plan.json for downstream consumers
 *
 * Exports:
 *  - generateTDDPlan(context)          — async pipeline entry point
 *  - buildTDDPlan(ddd, sparc)          — pure, testable builder (compat)
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

function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function pad3(n: number): string {
  return String(n).padStart(3, '0');
}

function pascalCase(text: string): string {
  return text
    .replace(/[-_\s]+(.)?/g, (_, c: string | undefined) => (c ? c.toUpperCase() : ''))
    .replace(/^(.)/, (_, c: string) => c.toUpperCase());
}

// ============================================================================
// TDD Markdown Generator
// ============================================================================

function writeTDDMarkdown(ddd: Phase2DomainModel, sparc: Phase2SPARCOutput): string {
  const lines: string[] = [];
  const services = sparc.architecture?.services ?? [];
  const contexts = ddd.contexts ?? [];

  lines.push('# London School TDD Plan');
  lines.push('');
  lines.push('## Approach');
  lines.push('**London School (Outside-In, Mock-Driven)**');
  lines.push('');
  lines.push('Start from the outermost boundary (acceptance tests at the API gateway) and work');
  lines.push('inward to unit tests at the data layer. Each service boundary gets a mock contract.');
  lines.push('');

  lines.push('## Test Pyramid');
  lines.push('');
  lines.push('| Level | Target Count | Description |');
  lines.push('|-------|-------------|-------------|');
  lines.push(`| Unit | ${Math.max(contexts.length * 5, 10)} | Pure logic tests per aggregate/entity |`);
  lines.push(`| Integration | ${Math.max(contexts.length * 3, 5)} | Service boundary and adapter tests |`);
  lines.push(`| E2E | ${Math.max(contexts.length, 3)} | Full user-flow acceptance tests |`);
  lines.push(`| Contract | ${Math.max(services.length, 2)} | API contract verification |`);
  lines.push('');
  lines.push('**Coverage Target: 80%**');
  lines.push('');

  // Test suites per context
  lines.push('## Test Suites');
  lines.push('');

  if (contexts.length > 0) {
    for (const ctx of contexts) {
      lines.push(`### ${ctx.name}`);
      lines.push(`> ${ctx.description}`);
      lines.push('');

      // Unit tests from aggregates
      if (ctx.aggregates && ctx.aggregates.length > 0) {
        lines.push('#### Unit Tests');
        for (const agg of ctx.aggregates) {
          lines.push(`- **${agg.name}**`);
          if (agg.entities) {
            for (const entity of agg.entities) {
              const entityName = typeof entity === 'string' ? entity : entity.name ?? entity.description ?? '';
              lines.push(`  - \`test_${slugify(entityName)}_creation\`: Given valid input, when creating ${entityName}, then entity is valid`);
              lines.push(`  - \`test_${slugify(entityName)}_validation\`: Given invalid input, when creating ${entityName}, then validation error raised`);
            }
          }
          if (agg.invariants) {
            for (const inv of agg.invariants) {
              lines.push(`  - \`test_invariant\`: ${inv}`);
            }
          }
        }
        lines.push('');
      }

      // Integration tests from commands/queries
      if ((ctx.commands && ctx.commands.length > 0) || (ctx.queries && ctx.queries.length > 0)) {
        lines.push('#### Integration Tests');
        for (const cmd of (ctx.commands ?? [])) {
          lines.push(`- \`test_${slugify(cmd.name)}\`: Given preconditions met, when ${cmd.name} executes, then state changes and events emitted`);
        }
        for (const q of (ctx.queries ?? [])) {
          lines.push(`- \`test_${slugify(q.name)}\`: Given data exists, when ${q.name} called, then correct results returned`);
        }
        lines.push('');
      }

      // Acceptance tests from domain events
      if (ctx.domainEvents && ctx.domainEvents.length > 0) {
        lines.push('#### Acceptance Tests');
        for (const evt of ctx.domainEvents) {
          lines.push(`- \`test_${slugify(evt.name)}_flow\`: Given user action, when complete flow triggers ${evt.name}, then downstream consumers notified`);
        }
        lines.push('');
      }
    }
  } else {
    // Derive from services
    for (const svc of services) {
      lines.push(`### ${svc.name}`);
      lines.push(`> ${svc.responsibility}`);
      lines.push('');
      lines.push('#### Unit Tests');
      for (const api of svc.api) {
        lines.push(`- \`test_${slugify(api)}\`: Given valid request, when ${api} called, then correct response`);
        lines.push(`- \`test_${slugify(api)}_error\`: Given invalid request, when ${api} called, then error handled`);
      }
      lines.push('');
      lines.push('#### Integration Tests');
      for (const dep of svc.dependencies) {
        lines.push(`- \`test_${slugify(svc.name)}_${slugify(dep)}_integration\`: Given ${dep} available, when ${svc.name} calls ${dep}, then data flows correctly`);
      }
      lines.push('');
    }
  }

  // Mock contracts
  lines.push('## Mock Contracts');
  lines.push('');
  if (services.length > 0) {
    for (const svc of services) {
      lines.push(`### Mock${pascalCase(svc.name)}`);
      lines.push(`Target: ${svc.name}`);
      lines.push('');
      lines.push('| Method | Parameters | Returns | Behavior |');
      lines.push('|--------|-----------|---------|----------|');
      for (const api of svc.api) {
        const isGet = api.toLowerCase().includes('get');
        lines.push(`| ${api} | request | ${isGet ? 'data' : 'result'} | ${isGet ? 'Returns mock data' : 'Returns success/failure'} |`);
      }
      lines.push('');
    }
  }

  // Seam definitions
  lines.push('## Test Seams');
  lines.push('');
  lines.push('| Seam | Type | From | To | Description |');
  lines.push('|------|------|------|----|-------------|');
  if (services.length > 0) {
    lines.push(`| api-gateway-seam | port | external | ${services[0]?.name ?? 'core'} | External API entry point |`);
    for (const svc of services) {
      for (const dep of svc.dependencies) {
        lines.push(`| ${slugify(svc.name)}-to-${slugify(dep)} | adapter | ${svc.name} | ${dep} | Service-to-service boundary |`);
      }
    }
  }
  if (contexts.length > 0) {
    for (const rel of (ddd.contextMap ?? [])) {
      lines.push(`| ${slugify(rel.upstream)}-${slugify(rel.downstream)} | service-boundary | ${rel.upstream} | ${rel.downstream} | ${rel.description ?? rel.type} |`);
    }
  }
  lines.push('');

  lines.push('## Reflection');
  lines.push('- London School TDD ensures each service boundary is tested in isolation with mocks.');
  lines.push('- Outside-in approach: acceptance → integration → unit — guarantees user-facing behavior first.');
  lines.push(`- ${services.length} services and ${contexts.length} bounded contexts drive the test structure.`);
  lines.push('- All seams are mockable for fast, reliable test execution.');
  lines.push('');

  return lines.join('\n');
}

// ============================================================================
// JSON Compat Builder
// ============================================================================

export function buildTDDPlan(ddd: Phase2DomainModel, sparc: Phase2SPARCOutput): TDDPlan {
  const services = sparc.architecture?.services ?? [];
  const contexts = ddd.contexts ?? [];

  // Test suites
  const testSuites: TDDTestSuite[] = [];
  let testIdx = 1;
  let suiteIdx = 1;
  let seamIdx = 1;
  let mcIdx = 1;

  const addSuite = (
    name: string,
    boundedContext: string,
    layer: 'unit' | 'integration' | 'acceptance' | 'e2e',
    description: string,
    tests: TDDTestCase[],
    adrRefs: string[] = [],
  ) => {
    const deps = layer === 'unit' ? [] : services.filter(s => s.name === boundedContext).flatMap(s => s.dependencies);
    testSuites.push({
      id: `TS-${pad3(suiteIdx++)}`,
      boundedContext,
      layer,
      name,
      description,
      tests,
      mockDependencies: deps,
      adrRefs,
    });
  };

  if (contexts.length > 0) {
    for (const ctx of contexts) {
      const unitTests: TDDTestCase[] = [];
      const integTests: TDDTestCase[] = [];

      for (const agg of (ctx.aggregates ?? [])) {
        unitTests.push({
          id: `TC-${pad3(testIdx++)}`,
          name: `${agg.name} creation`,
          given: `Valid ${agg.name} input`,
          when: `Creating ${agg.name}`,
          then: `${agg.name} is valid and invariants hold`,
          mockSetup: [],
          assertionType: 'state',
        });
      }

      for (const cmd of (ctx.commands ?? [])) {
        const deps = services.filter(s => s.name === ctx.name).flatMap(s => s.dependencies);
        integTests.push({
          id: `TC-${pad3(testIdx++)}`,
          name: `${cmd.name} execution`,
          given: 'Preconditions met',
          when: `${cmd.name} executes`,
          then: 'State changes and events emitted',
          mockSetup: deps.map(d => `mock ${d} adapter`),
          assertionType: 'behavior',
        });
      }

      if (unitTests.length > 0) addSuite(`${ctx.name}-unit`, ctx.name, 'unit', `Unit tests for ${ctx.name} aggregates`, unitTests, ctx.adrRefs ?? []);
      if (integTests.length > 0) addSuite(`${ctx.name}-integration`, ctx.name, 'integration', `Integration tests for ${ctx.name} commands`, integTests, ctx.adrRefs ?? []);
    }
  } else {
    for (const svc of services) {
      const tests: TDDTestCase[] = svc.api.map(api => ({
        id: `TC-${pad3(testIdx++)}`,
        name: `${api} test`,
        given: `Valid request to ${svc.name}`,
        when: `${api} is called`,
        then: 'Correct response returned',
        mockSetup: svc.dependencies.map(d => `mock ${d}`),
        assertionType: 'behavior' as const,
      }));
      addSuite(`${svc.name}-unit`, svc.name, 'unit', `Unit tests for ${svc.name}`, tests);
    }
  }

  // Pyramid from actual suite counts
  const unitCount = testSuites.filter(s => s.layer === 'unit').reduce((n, s) => n + s.tests.length, 0);
  const integCount = testSuites.filter(s => s.layer === 'integration').reduce((n, s) => n + s.tests.length, 0);
  const acceptCount = testSuites.filter(s => s.layer === 'acceptance').reduce((n, s) => n + s.tests.length, 0);
  const e2eCount = testSuites.filter(s => s.layer === 'e2e').reduce((n, s) => n + s.tests.length, 0);
  const total = Math.max(unitCount + integCount + acceptCount + e2eCount, 1);
  const pct = (n: number) => Math.round((n / total) * 100);

  const testPyramid: TestPyramid = {
    unit: { count: unitCount, percentage: pct(unitCount) },
    integration: { count: integCount, percentage: pct(integCount) },
    acceptance: { count: acceptCount, percentage: pct(acceptCount) },
    e2e: { count: e2eCount, percentage: pct(e2eCount) },
  };

  // Mock contracts — extract clean method names and typed signatures
  const mockContracts: MockContract[] = services.map(svc => {
    const svcPascal = pascalCase(svc.name);

    const methods = svc.api.map((api): MockContractMethod => {
      // Parse "POST /context/action" or "GET /context/:id" into clean method name
      const withoutMethod = api.replace(/^\s*(GET|POST|PUT|PATCH|DELETE)\s+/i, '');
      const httpVerb = api.match(/^\s*(GET|POST|PUT|PATCH|DELETE)\b/i)?.[1]?.toLowerCase() ?? 'get';
      const segments = withoutMethod.split('/').filter(Boolean);
      const actionSegment = segments[segments.length - 1] ?? '';
      const cleanAction = actionSegment.replace(/[^a-zA-Z0-9-]/g, '').replace(/:.*/, '');

      let methodName: string;
      if (!cleanAction || slugify(cleanAction) === slugify(svc.name)) {
        // GET /context → list, POST /context → create
        methodName = httpVerb === 'get' ? `list${svcPascal}` : `create${svcPascal}`;
      } else if (cleanAction.includes(':id') || cleanAction.includes('{id}')) {
        methodName = `get${svcPascal}ById`;
      } else {
        // "create-vendor" → "createVendor"
        const camel = cleanAction
          .replace(/[-_]+(.)?/g, (_: string, c: string | undefined) => (c ? c.toUpperCase() : ''))
          .replace(/^(.)/, (_: string, c: string) => c.toLowerCase());
        methodName = camel;
      }

      const isQuery = httpVerb === 'get';
      const inputType = isQuery ? 'Record<string, unknown>' : `${svcPascal}Input`;
      const outputType = isQuery ? `${svcPascal}[]` : svcPascal;

      return {
        name: methodName,
        input: inputType,
        output: outputType,
        behavior: isQuery ? `Returns ${svc.name} data` : `Creates or updates ${svc.name} record`,
      };
    });

    // Deduplicate methods by name (same action may appear multiple times)
    const seen = new Set<string>();
    const uniqueMethods = methods.filter(m => {
      if (seen.has(m.name)) return false;
      seen.add(m.name);
      return true;
    });

    return {
      id: `MC-${pad3(mcIdx++)}`,
      name: `Mock${svcPascal}`,
      boundedContext: svc.name,
      targetService: svc.name,
      interfaceName: `I${svcPascal}`,
      methods: uniqueMethods,
    };
  });

  // Seam definitions
  const seamDefinitions: SeamDefinition[] = [];
  if (services.length > 0) {
    seamDefinitions.push({
      id: `SEAM-${pad3(seamIdx++)}`,
      name: 'api-gateway-seam',
      between: ['external', services[0]?.name ?? 'core'],
      contractType: 'sync-request-response',
      mockBoundary: 'API gateway mock adapter',
      integrationTestApproach: 'Contract test with mock external client',
    });
    for (const svc of services) {
      for (const dep of svc.dependencies) {
        seamDefinitions.push({
          id: `SEAM-${pad3(seamIdx++)}`,
          name: `${slugify(svc.name)}-to-${slugify(dep)}`,
          between: [svc.name, dep],
          contractType: 'sync-request-response',
          mockBoundary: `Mock ${dep} adapter in ${svc.name}`,
          integrationTestApproach: `Integration test with mock ${dep}`,
        });
      }
    }
  }
  for (const rel of (ddd.contextMap ?? [])) {
    seamDefinitions.push({
      id: `SEAM-${pad3(seamIdx++)}`,
      name: `${slugify(rel.upstream)}-${slugify(rel.downstream)}`,
      between: [rel.upstream, rel.downstream],
      contractType: rel.type === 'partnership' ? 'async-event' : 'sync-request-response',
      mockBoundary: `Anti-corruption layer at ${rel.downstream}`,
      integrationTestApproach: `${rel.type} contract verification`,
    });
  }

  const executionOrder = testSuites.map(s => s.id);

  return {
    approach: 'london-school',
    testPyramid,
    testSuites,
    mockContracts,
    seamDefinitions,
    executionOrder,
  };
}

// ============================================================================
// Public: Main Stage Function
// ============================================================================

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

    // Generate markdown
    const tddMarkdown = writeTDDMarkdown(ddd, sparc);

    // Build JSON compat
    const plan = buildTDDPlan(ddd, sparc);

    // Write output
    const tddDir = path.join(context.phase2Dir, 'tdd');
    const testSuitesDir = path.join(tddDir, 'test-suites');
    fs.mkdirSync(tddDir, { recursive: true, mode: DIR_MODE });
    fs.mkdirSync(testSuitesDir, { recursive: true, mode: DIR_MODE });

    const artifactPaths: string[] = [];

    // Primary: TDD markdown
    const mdPath = path.join(tddDir, 'TDD-Plan.md');
    fs.writeFileSync(mdPath, tddMarkdown + '\n', { encoding: 'utf-8', mode: FILE_MODE });
    artifactPaths.push(mdPath);

    // JSON compat files
    const planPath = path.join(tddDir, 'tdd-plan.json');
    fs.writeFileSync(planPath, JSON.stringify(plan, null, 2), { encoding: 'utf-8', mode: FILE_MODE });
    artifactPaths.push(planPath);

    const mockContractsPath = path.join(tddDir, 'mock-contracts.json');
    fs.writeFileSync(mockContractsPath, JSON.stringify(plan.mockContracts, null, 2), { encoding: 'utf-8', mode: FILE_MODE });
    artifactPaths.push(mockContractsPath);

    const seamDefsPath = path.join(tddDir, 'seam-definitions.json');
    fs.writeFileSync(seamDefsPath, JSON.stringify(plan.seamDefinitions, null, 2), { encoding: 'utf-8', mode: FILE_MODE });
    artifactPaths.push(seamDefsPath);

    // Per-context test suite files
    const contextSuites = new Map<string, TDDTestSuite[]>();
    for (const suite of plan.testSuites) {
      const existing = contextSuites.get(suite.boundedContext) ?? [];
      existing.push(suite);
      contextSuites.set(suite.boundedContext, existing);
    }

    for (const [contextName, suites] of contextSuites) {
      const filename = `${slugify(contextName)}.json`;
      const suitePath = path.join(testSuitesDir, filename);
      fs.writeFileSync(suitePath, JSON.stringify(suites, null, 2), { encoding: 'utf-8', mode: FILE_MODE });
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
      summary: `     TDD: ${plan.testSuites.length} suites, ${totalTests} tests, ${plan.mockContracts.length} mocks, ${plan.seamDefinitions.length} seams (London School)`,
    };

    context.stageOutputs.set('tdd-plan-generation', output);

    endSpan(span, 'ok', { suiteCount: plan.testSuites.length, testCount: totalTests, timingMs: timing });
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
