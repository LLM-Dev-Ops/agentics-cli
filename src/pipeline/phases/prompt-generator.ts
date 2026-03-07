/**
 * Pipeline Phase 5: Prompt Generation
 *
 * Combines ADRs and DDDs into implementation prompts for RuvFlow.
 * Each bounded context + its related ADRs = one implementation prompt.
 * Writes to <run-dir>/prompts/.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
  PipelineContext,
  StageOutput,
  SPARCOutput,
  ADRRecord,
  DomainModel,
  ImplementationPrompt,
  ExecutionPlan,
} from '../types.js';

export async function executePromptGeneration(
  context: PipelineContext,
): Promise<StageOutput> {
  const start = Date.now();
  const promptsDir = path.join(context.artifactsDir, 'prompts');
  fs.mkdirSync(promptsDir, { recursive: true, mode: 0o700 });
  const artifacts: string[] = [];

  // Get inputs from previous stages
  const sparcOutput = context.stageOutputs.get('sparc-development');
  const adrDddOutput = context.stageOutputs.get('adr-ddd-generation');
  const feedback = context.userFeedback.get('prompt-generation') ?? [];

  const sparc = sparcOutput?.data as SPARCOutput | undefined;
  const adrDddData = adrDddOutput?.data as { adrs: ADRRecord[]; domainModel: DomainModel } | undefined;

  if (!sparc || !adrDddData) {
    return {
      stage: 'prompt-generation',
      status: 'failed',
      data: { error: 'SPARC or ADR/DDD output not available' },
      artifacts: [],
      timing: Date.now() - start,
      summary: '  ERROR: Previous stage outputs not available.',
    };
  }

  console.error('  Generating implementation prompts...');
  console.error('');

  const { adrs, domainModel } = adrDddData;
  const prompts = generatePrompts(sparc, adrs, domainModel, context.query, feedback);

  // Write individual prompt files
  for (const prompt of prompts) {
    const filename = `impl-${String(prompt.order).padStart(3, '0')}-${slugify(prompt.boundedContext)}.md`;
    fs.writeFileSync(path.join(promptsDir, filename), prompt.content, { mode: 0o600, encoding: 'utf-8' });
    artifacts.push(`prompts/${filename}`);
    console.error(`    [${prompt.order}/${prompts.length}] ${prompt.title}`);
  }

  // Write execution plan
  const executionPlan: ExecutionPlan = {
    prompts,
    totalSteps: prompts.length,
    estimatedDuration: `${prompts.length * 5}-${prompts.length * 15} minutes`,
  };

  const planContent = JSON.stringify(executionPlan, null, 2);
  fs.writeFileSync(path.join(promptsDir, 'execution-plan.json'), planContent, { mode: 0o600, encoding: 'utf-8' });
  artifacts.push('prompts/execution-plan.json');

  console.error('');
  console.error(`  Generated ${prompts.length} implementation prompts.`);
  console.error('');

  return {
    stage: 'prompt-generation',
    status: 'completed',
    data: executionPlan,
    artifacts,
    timing: Date.now() - start,
    summary: buildPromptSummary(executionPlan),
  };
}

// ============================================================================
// Prompt Generation
// ============================================================================

function generatePrompts(
  sparc: SPARCOutput,
  adrs: ADRRecord[],
  domainModel: DomainModel,
  query: string,
  feedback: string[],
): ImplementationPrompt[] {
  const prompts: ImplementationPrompt[] = [];

  // ADR-driven implementation: one prompt per ADR, sequentially
  // Each prompt says "Implement ADR-N" with full architectural context
  // This gives agents a focused, deliverable unit of work per dispatch.

  // Sort ADRs by dependency order: infrastructure/integration first, domain logic last
  const sortedADRs = sortADRsByDependency(adrs, domainModel);

  for (let i = 0; i < sortedADRs.length; i++) {
    const adr = sortedADRs[i]!;
    const order = i + 1;

    // Find bounded contexts affected by this ADR
    const affectedContexts = findContextsForADR(adr, domainModel);

    // Find SPARC services related to this ADR
    const relatedServices = affectedContexts
      .map(ctx => sparc.architecture.services.find(s => s.name === ctx.name))
      .filter((s): s is NonNullable<typeof s> => s != null);

    // Gather dependencies from related services
    const deps = relatedServices.flatMap(s => s.dependencies ?? []);

    const content = buildADRPromptContent(
      query, adr, affectedContexts, relatedServices, sparc,
      sortedADRs, feedback, order, sortedADRs.length,
    );

    const contextName = affectedContexts.length > 0
      ? affectedContexts[0]!.name
      : slugify(adr.title);

    prompts.push({
      id: `prompt-${String(order).padStart(3, '0')}`,
      title: `Implement ${adr.id}: ${adr.title}`,
      boundedContext: contextName,
      relatedADRs: [adr.id],
      content,
      dependencies: [...new Set(deps)],
      order,
    });
  }

  return prompts;
}

/**
 * Sort ADRs so infrastructure/integration ADRs execute before domain logic.
 * Security and data ADRs before business rules. Integration before domain.
 */
function sortADRsByDependency(adrs: ADRRecord[], _domainModel: DomainModel): ADRRecord[] {
  const priorityKeywords: Array<[RegExp, number]> = [
    [/\b(?:infrastructure|platform|foundation)/i, 0],
    [/\b(?:security|auth|identity|access)/i, 1],
    [/\b(?:data|persist|storage|database|migration)/i, 2],
    [/\b(?:integration|adapter|connector|erp|sap|azure|snowflake)/i, 3],
    [/\b(?:communication|messaging|event|api[\s-]?gateway)/i, 4],
    [/\b(?:performance|caching|optimization)/i, 5],
    [/\b(?:compliance|regulatory|audit|governance)/i, 6],
    [/\b(?:risk|mitigation|resilience|fallback)/i, 7],
  ];

  function getPriority(adr: ADRRecord): number {
    const text = `${adr.title} ${adr.context} ${adr.decision}`.toLowerCase();
    for (const [pattern, priority] of priorityKeywords) {
      if (pattern.test(text)) return priority;
    }
    return 8; // Domain/business logic last
  }

  return [...adrs].sort((a, b) => getPriority(a) - getPriority(b));
}

/**
 * Find bounded contexts affected by an ADR.
 */
function findContextsForADR(
  adr: ADRRecord,
  domainModel: DomainModel,
): Array<{ name: string; description: string; aggregates: unknown[]; domainEvents: string[]; commands: string[]; queries: string[] }> {
  const adrText = `${adr.title} ${adr.context} ${adr.decision}`.toLowerCase();
  return domainModel.contexts.filter(ctx => {
    const keywords = ctx.name.toLowerCase().split('-');
    return keywords.some(kw => kw.length > 2 && adrText.includes(kw));
  });
}

/**
 * Build an implementation prompt for a single ADR.
 * Each prompt is self-contained: it has the ADR decision, affected bounded
 * contexts, service specs, and prior ADR list so the agent knows what was
 * already implemented.
 */
function buildADRPromptContent(
  query: string,
  adr: ADRRecord,
  affectedContexts: Array<{ name: string; description: string; aggregates: unknown[]; domainEvents: string[]; commands: string[]; queries: string[] }>,
  relatedServices: Array<{ name: string; responsibility: string; api: string[]; dependencies: string[] }>,
  sparc: SPARCOutput,
  allADRs: ADRRecord[],
  feedback: string[],
  order: number,
  total: number,
): string {
  const lines: string[] = [
    `# Implement ${adr.id}: ${adr.title}`,
    '',
    `**The implementation must be production ready, enterprise grade, commercially viable, bug and error free, without compilation errors.**`,
    '',
    `> Step ${order} of ${total} in the ADR implementation sequence.`,
    '',
    `## Project Objective`,
    '',
    query,
    '',
    `## Architecture Decision to Implement`,
    '',
    `### ${adr.id}: ${adr.title}`,
    '',
    `**Context:** ${adr.context}`,
    '',
    `**Decision:** ${adr.decision}`,
    '',
    `**Status:** ${adr.status}`,
    '',
  ];

  if (adr.consequences.length > 0) {
    lines.push('**Consequences:**');
    for (const c of adr.consequences) {
      lines.push(`- ${c}`);
    }
    lines.push('');
  }

  // Show what was already implemented (prior ADRs)
  if (order > 1) {
    lines.push('## Previously Implemented ADRs (already done — build on these)');
    lines.push('');
    for (let i = 0; i < order - 1; i++) {
      const prev = allADRs[i]!;
      lines.push(`- **${prev.id}:** ${prev.title} — ${prev.decision.slice(0, 120)}`);
    }
    lines.push('');
  }

  // Affected bounded contexts
  if (affectedContexts.length > 0) {
    lines.push('## Affected Bounded Contexts', '');
    for (const ctx of affectedContexts) {
      lines.push(`### ${ctx.name}`);
      lines.push('');
      lines.push(ctx.description);
      lines.push('');

      if (ctx.domainEvents.length > 0) {
        lines.push('**Domain Events:**');
        for (const evt of ctx.domainEvents) { lines.push(`- ${evt}`); }
        lines.push('');
      }
      if (ctx.commands.length > 0) {
        lines.push('**Commands:**');
        for (const cmd of ctx.commands) { lines.push(`- ${cmd}`); }
        lines.push('');
      }
      if (ctx.queries.length > 0) {
        lines.push('**Queries:**');
        for (const q of ctx.queries) { lines.push(`- ${q}`); }
        lines.push('');
      }
    }
  }

  // Service specifications
  if (relatedServices.length > 0) {
    lines.push('## Service Specifications', '');
    for (const svc of relatedServices) {
      lines.push(`### ${svc.name}`);
      lines.push(`**Responsibility:** ${svc.responsibility}`);
      lines.push('**API:**');
      for (const api of svc.api) { lines.push(`- ${api}`); }
      if (svc.dependencies.length > 0) {
        lines.push(`**Dependencies:** ${svc.dependencies.join(', ')}`);
      }
      lines.push('');
    }
  }

  // Quality requirements
  lines.push('## Quality Requirements', '');

  lines.push('### Security');
  for (const sec of sparc.refinement.securityConsiderations.slice(0, 4)) {
    lines.push(`- ${sec}`);
  }
  lines.push('');

  lines.push('### Performance');
  for (const perf of sparc.refinement.performanceTargets.slice(0, 3)) {
    lines.push(`- ${perf}`);
  }
  lines.push('');

  lines.push('### Testing');
  lines.push(sparc.refinement.testStrategy);
  lines.push('');

  // Feedback
  if (feedback.length > 0) {
    lines.push('## Stakeholder Feedback', '');
    for (const fb of feedback) { lines.push(`- ${fb}`); }
    lines.push('');
  }

  // Clear instructions
  lines.push('## Implementation Instructions', '');
  lines.push('**The implementation must be production ready, enterprise grade, commercially viable, bug and error free, without compilation errors.**');
  lines.push('');
  lines.push('1. **Implement ONLY this ADR.** Do not implement other ADRs in this step.');
  lines.push('2. **Write tests first** (TDD). Define expected behavior, then implement to pass.');
  lines.push('3. **Write real domain logic** — no stubs, no TODOs, no placeholder functions. Every function must have a working body.');
  lines.push('4. **Use typed interfaces** — no `Record<string, unknown>` or `any` for domain types. Define concrete types with named fields.');
  lines.push('5. **Enforce invariants** — validate domain rules in constructors and commands. Throw domain-specific exceptions on violation.');
  lines.push('6. **Handle all error paths** — use domain exceptions with error codes, not generic throws. Include retry logic where appropriate.');
  lines.push('7. **Integrate with prior ADRs** — build on what was already implemented. Import and use existing types and services.');
  lines.push('8. **Zero compilation errors** — all imports must resolve, all types must align, all generics must be properly constrained.');
  lines.push('9. **Production-grade patterns** — connection pooling, graceful shutdown, structured logging, health checks, circuit breakers where applicable.');
  lines.push('10. **Complete test coverage** — unit tests for domain logic, integration tests for service boundaries, contract tests for external APIs.');
  lines.push('');

  return lines.join('\n');
}

// ============================================================================
// Helpers
// ============================================================================

function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

function buildPromptSummary(plan: ExecutionPlan): string {
  return [
    '  ADR Implementation Plan:',
    '',
    `  - ${plan.totalSteps} ADRs to implement sequentially`,
    `  - Estimated execution time: ${plan.estimatedDuration}`,
    '',
    '  Execution order:',
    ...plan.prompts.map(p => `    ${p.order}. ${p.title} (context: ${p.boundedContext}, deps: ${p.dependencies.length > 0 ? p.dependencies.join(', ') : 'none'})`),
  ].join('\n');
}
