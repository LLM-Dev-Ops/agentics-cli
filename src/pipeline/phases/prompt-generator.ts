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
  let order = 1;

  for (const context of domainModel.contexts) {
    // Find related ADRs for this bounded context
    const relatedADRs = findRelatedADRs(context.name, adrs);

    // Find the matching service from SPARC architecture
    const service = sparc.architecture.services.find(s => s.name === context.name);

    const content = buildPromptContent(
      query,
      context,
      relatedADRs,
      service,
      sparc,
      feedback,
      order,
      domainModel.contexts.length,
    );

    prompts.push({
      id: `prompt-${String(order).padStart(3, '0')}`,
      title: `Implement ${context.name}`,
      boundedContext: context.name,
      relatedADRs: relatedADRs.map(a => a.id),
      content,
      dependencies: service?.dependencies ?? [],
      order,
    });

    order++;
  }

  // Sort by dependencies (services with no deps first)
  prompts.sort((a, b) => a.dependencies.length - b.dependencies.length);
  prompts.forEach((p, i) => { p.order = i + 1; });

  return prompts;
}

function findRelatedADRs(contextName: string, adrs: ADRRecord[]): ADRRecord[] {
  const keywords = contextName.toLowerCase().split('-');
  return adrs.filter(adr => {
    const adrText = `${adr.title} ${adr.context} ${adr.decision}`.toLowerCase();
    return keywords.some(kw => adrText.includes(kw));
  });
}

function buildPromptContent(
  query: string,
  context: { name: string; description: string; aggregates: unknown[]; domainEvents: string[]; commands: string[]; queries: string[] },
  relatedADRs: ADRRecord[],
  service: { name: string; responsibility: string; api: string[]; dependencies: string[] } | undefined,
  sparc: SPARCOutput,
  feedback: string[],
  order: number,
  total: number,
): string {
  const lines: string[] = [
    `# Implementation Prompt ${order}/${total}: ${context.name}`,
    '',
    `## Project Context`,
    '',
    `**Objective:** ${query}`,
    `**Component:** ${context.name}`,
    `**Responsibility:** ${context.description}`,
    '',
    '## Architecture Decisions',
    '',
  ];

  if (relatedADRs.length > 0) {
    for (const adr of relatedADRs) {
      lines.push(`### ${adr.id}: ${adr.title}`);
      lines.push('');
      lines.push(`**Decision:** ${adr.decision}`);
      lines.push('');
      lines.push('**Consequences:**');
      for (const c of adr.consequences) {
        lines.push(`- ${c}`);
      }
      lines.push('');
    }
  } else {
    lines.push('No specific ADRs apply to this component.', '');
  }

  lines.push('## Domain Model', '');
  lines.push(`**Bounded Context:** ${context.name}`, '');

  if (context.domainEvents.length > 0) {
    lines.push('**Domain Events:**');
    for (const evt of context.domainEvents) {
      lines.push(`- ${evt}`);
    }
    lines.push('');
  }

  if (context.commands.length > 0) {
    lines.push('**Commands:**');
    for (const cmd of context.commands) {
      lines.push(`- ${cmd}`);
    }
    lines.push('');
  }

  if (context.queries.length > 0) {
    lines.push('**Queries:**');
    for (const q of context.queries) {
      lines.push(`- ${q}`);
    }
    lines.push('');
  }

  if (service) {
    lines.push('## Service Specification', '');
    lines.push(`**Service:** ${service.name}`);
    lines.push(`**API Endpoints:**`);
    for (const api of service.api) {
      lines.push(`- ${api}`);
    }
    if (service.dependencies.length > 0) {
      lines.push(`**Dependencies:** ${service.dependencies.join(', ')}`);
    }
    lines.push('');
  }

  // Security requirements from SPARC
  lines.push('## Requirements', '');
  lines.push('### Security');
  for (const sec of sparc.refinement.securityConsiderations.slice(0, 4)) {
    lines.push(`- ${sec}`);
  }
  lines.push('');

  lines.push('### Performance Targets');
  for (const perf of sparc.refinement.performanceTargets.slice(0, 3)) {
    lines.push(`- ${perf}`);
  }
  lines.push('');

  lines.push('### Test Strategy');
  lines.push(sparc.refinement.testStrategy);
  lines.push('');

  // Incorporate feedback
  if (feedback.length > 0) {
    lines.push('## Revisions from Stakeholder Feedback', '');
    for (const fb of feedback) {
      lines.push(`- ${fb}`);
    }
    lines.push('');
  }

  lines.push('## Instructions', '');
  lines.push('Implement this component following the architecture decisions and domain model above.');
  lines.push('Write clean, well-tested code with comprehensive error handling.');
  lines.push('Follow TDD: write tests first, then implement to make tests pass.');
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
    '  Prompt Generation Summary:',
    '',
    `  - ${plan.totalSteps} implementation prompts generated`,
    `  - Estimated execution time: ${plan.estimatedDuration}`,
    '',
    '  Execution order:',
    ...plan.prompts.map(p => `    ${p.order}. ${p.title} (${p.relatedADRs.length} ADR(s), deps: ${p.dependencies.length > 0 ? p.dependencies.join(', ') : 'none'})`),
  ].join('\n');
}
