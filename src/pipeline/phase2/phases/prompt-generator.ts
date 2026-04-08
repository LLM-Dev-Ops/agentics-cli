/**
 * Phase 2 Pipeline — Prompt Generation Stage (ADR-PIPELINE-019)
 *
 * Converts Phase 2 ADRs + DDD bounded contexts into implementation prompts.
 * Each prompt targets one or more bounded contexts and includes the ADRs
 * that govern those contexts, providing a complete implementation brief.
 *
 * This stage was missing from Phase 2 — it existed only in the Phase 1
 * pipeline (src/pipeline/phases/prompt-generator.ts). Without it, the
 * pipeline produced ADRs and DDD models but zero actionable implementation
 * prompts, breaking the simulation → execution lineage.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import type {
  Phase2Context,
  Phase2StageOutput,
  Phase2ADRRecord,
  Phase2DDDBoundedContext,
  Phase2DomainModel,
  Phase2SPARCOutput,
} from '../types.js';
import { createSpan, endSpan, emitSpan } from '../telemetry.js';

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const PROMPTS_SUBDIR = 'prompts';

// ============================================================================
// Types
// ============================================================================

interface ImplementationPrompt {
  id: string;
  title: string;
  boundedContext: string;
  relatedADRs: string[];
  content: string;
  dependencies: string[];
  order: number;
}

// ============================================================================
// Public: Main Stage Function
// ============================================================================

export async function generateImplementationPrompts(
  context: Phase2Context,
): Promise<Phase2StageOutput> {
  const rootSpan = createSpan('prompt-generation', 'generate-prompts', { phase2Dir: context.phase2Dir });

  try {
    // Load ADRs from prior stage
    const adrStage = context.stageOutputs.get('adr-generation');
    if (!adrStage || adrStage.status !== 'completed') {
      throw new Error('ECLI-P2-030: ADR output not available for prompt generation.');
    }
    const adrs = adrStage.data as Phase2ADRRecord[];

    if (!adrs || adrs.length === 0) {
      throw new Error('ECLI-P2-030: No ADRs available — cannot generate implementation prompts.');
    }

    // Load DDD model from prior stage
    const dddStage = context.stageOutputs.get('ddd-generation');
    const domainModel = dddStage?.status === 'completed'
      ? dddStage.data as Phase2DomainModel
      : null;

    // Load SPARC for service definitions
    const sparcStage = context.stageOutputs.get('sparc-specification');
    const sparc = sparcStage?.status === 'completed'
      ? sparcStage.data as Phase2SPARCOutput
      : null;

    // Extract query for prompt context
    const query = context.phase1Artifacts?.scenario?.query
      ?? (context.phase1Artifacts?.manifest as unknown as Record<string, unknown>)?.['query'] as string
      ?? '';

    // Extract simulation ID for lineage
    const simulationId = context.phase1Artifacts?.manifest?.execution_id
      ?? context.phase1Artifacts?.manifest?.run_id
      ?? '';

    // Generate prompts
    const prompts = domainModel && domainModel.contexts.length > 0
      ? generateFromDDDContexts(adrs, domainModel, sparc, query, simulationId)
      : generateFromADRsOnly(adrs, query, simulationId);

    // Write prompt files
    const promptsDir = path.join(context.phase2Dir, PROMPTS_SUBDIR);
    fs.mkdirSync(promptsDir, { recursive: true, mode: DIR_MODE });
    const writtenPaths: string[] = [];

    for (const prompt of prompts) {
      const filename = `impl-${String(prompt.order).padStart(3, '0')}-${slugify(prompt.boundedContext)}.md`;
      const filePath = path.join(promptsDir, filename);
      fs.writeFileSync(filePath, prompt.content, { encoding: 'utf-8', mode: FILE_MODE });
      writtenPaths.push(filePath);
    }

    // Write execution plan
    const plan = {
      prompts: prompts.map(p => ({ id: p.id, title: p.title, order: p.order, boundedContext: p.boundedContext, relatedADRs: p.relatedADRs, dependencies: p.dependencies })),
      totalSteps: prompts.length,
      simulationId: simulationId || undefined,
    };
    const planPath = path.join(promptsDir, 'execution-plan.json');
    fs.writeFileSync(planPath, JSON.stringify(plan, null, 2) + '\n', { encoding: 'utf-8', mode: FILE_MODE });
    writtenPaths.push(planPath);

    endSpan(rootSpan, 'ok', { promptCount: prompts.length });
    emitSpan(rootSpan);

    const timing = rootSpan.durationMs ?? 0;
    const output: Phase2StageOutput = {
      stage: 'prompt-generation',
      status: 'completed',
      data: plan,
      artifacts: writtenPaths,
      timing,
      summary: `     Prompts: ${prompts.length} implementation prompts (${writtenPaths.length - 1} markdown + 1 execution plan)`,
    };

    context.stageOutputs.set('prompt-generation', output);
    return output;
  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    endSpan(rootSpan, 'error', { error: errorMessage });
    emitSpan(rootSpan);

    const output: Phase2StageOutput = {
      stage: 'prompt-generation',
      status: 'failed',
      data: { error: errorMessage },
      artifacts: [],
      timing: rootSpan.durationMs ?? 0,
      summary: `Prompt generation failed: ${errorMessage}`,
    };
    context.stageOutputs.set('prompt-generation', output);
    return output;
  }
}

// ============================================================================
// Prompt Generation: DDD-based (preferred path)
// ============================================================================

function generateFromDDDContexts(
  adrs: Phase2ADRRecord[],
  domainModel: Phase2DomainModel,
  sparc: Phase2SPARCOutput | null,
  query: string,
  simulationId: string,
): ImplementationPrompt[] {
  const contexts = domainModel.contexts;
  const relations = domainModel.contextMap ?? [];
  const prompts: ImplementationPrompt[] = [];

  // Topological sort by dependency depth
  const depthOf = computeContextDepths(contexts, relations);
  const sorted = [...contexts].sort((a, b) => (depthOf.get(a.name) ?? 0) - (depthOf.get(b.name) ?? 0));

  // Assign ADRs to their most relevant context
  const adrAssignment = assignADRsToContexts(adrs, contexts);

  const completedContexts: string[] = [];

  for (let i = 0; i < sorted.length; i++) {
    const ctx = sorted[i]!;
    const order = i + 1;
    const contextAdrs = adrAssignment.get(ctx.name) ?? [];

    // Find related service from SPARC
    const service = sparc?.architecture?.services?.find(
      s => s.name.toLowerCase() === ctx.name.toLowerCase(),
    );

    const content = buildContextPrompt(ctx, contextAdrs, service, query, completedContexts, sorted.length, order, simulationId);

    prompts.push({
      id: `prompt-${String(order).padStart(3, '0')}`,
      title: `Build: ${ctx.name}`,
      boundedContext: ctx.name,
      relatedADRs: contextAdrs.map(a => a.id),
      content,
      dependencies: completedContexts.slice(),
      order,
    });

    completedContexts.push(ctx.name);
  }

  return prompts;
}

// ============================================================================
// Prompt Generation: ADR-only fallback (when DDD model is empty)
// ============================================================================

function generateFromADRsOnly(
  adrs: Phase2ADRRecord[],
  query: string,
  simulationId: string,
): ImplementationPrompt[] {
  const prompts: ImplementationPrompt[] = [];

  // Group ADRs into logical clusters by keyword similarity
  const clusters = clusterADRs(adrs);

  for (let i = 0; i < clusters.length; i++) {
    const cluster = clusters[i]!;
    const order = i + 1;
    const clusterName = cluster.name;

    const lines: string[] = [
      `# Build Step ${order} of ${clusters.length}: ${clusterName}`,
      '',
      '**The implementation must be production ready, enterprise grade, commercially viable, bug and error free, without compilation errors.**',
      '',
      `## Project Objective`,
      '',
      query.slice(0, 500),
      '',
    ];

    if (simulationId) {
      lines.push(`## Simulation Lineage`, '', `Originating simulation: \`${simulationId}\``, '');
    }

    lines.push('## Architecture Decisions Governing This Step', '');
    for (const adr of cluster.adrs) {
      lines.push(`### ${adr.id}: ${adr.title}`, '');
      lines.push(`**Context:** ${adr.context}`, '');
      lines.push(`**Decision:** ${adr.decision}`, '');
      if (adr.consequences.length > 0) {
        lines.push('**Consequences:**');
        for (const c of adr.consequences) {
          const icon = c.type === 'positive' ? '+' : c.type === 'negative' ? '-' : '~';
          lines.push(`- [${icon}] ${c.description}`);
        }
        lines.push('');
      }
    }

    lines.push('## Implementation Requirements', '');
    lines.push('- Use London School TDD: write failing test first, then minimal implementation');
    lines.push('- No stubs or placeholders — every function must have real logic');
    lines.push('- All business rules from the ADRs above must be enforced in code');
    lines.push('- Include error handling for edge cases identified in the ADRs');
    lines.push('');

    prompts.push({
      id: `prompt-${String(order).padStart(3, '0')}`,
      title: `Build: ${clusterName}`,
      boundedContext: slugify(clusterName),
      relatedADRs: cluster.adrs.map(a => a.id),
      content: lines.join('\n'),
      dependencies: clusters.slice(0, i).map(c => c.name),
      order,
    });
  }

  return prompts;
}

// ============================================================================
// Helpers
// ============================================================================

function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function computeContextDepths(
  contexts: readonly Phase2DDDBoundedContext[],
  relations: readonly { upstream: string; downstream: string; type: string }[],
): Map<string, number> {
  const depthOf = new Map<string, number>();
  const deps = new Map<string, Set<string>>();

  for (const ctx of contexts) {
    deps.set(ctx.name, new Set());
  }
  for (const rel of relations) {
    deps.get(rel.downstream)?.add(rel.upstream);
  }

  function resolve(name: string, visited: Set<string>): number {
    if (depthOf.has(name)) return depthOf.get(name)!;
    if (visited.has(name)) return 0;
    visited.add(name);
    const d = deps.get(name) ?? new Set();
    const maxUp = d.size === 0 ? -1 : Math.max(...[...d].map(u => resolve(u, visited)));
    const depth = maxUp + 1;
    depthOf.set(name, depth);
    return depth;
  }

  for (const ctx of contexts) {
    resolve(ctx.name, new Set());
  }
  return depthOf;
}

function assignADRsToContexts(
  adrs: Phase2ADRRecord[],
  contexts: readonly Phase2DDDBoundedContext[],
): Map<string, Phase2ADRRecord[]> {
  const assignment = new Map<string, Phase2ADRRecord[]>();
  for (const ctx of contexts) {
    assignment.set(ctx.name, []);
  }

  for (const adr of adrs) {
    const adrText = `${adr.title} ${adr.context} ${adr.decision}`.toLowerCase();
    let bestCtx = contexts[0]?.name ?? '';
    let bestScore = 0;

    for (const ctx of contexts) {
      const keywords = ctx.name.toLowerCase().split(/[-_\s]+/).filter(k => k.length > 2);
      const score = keywords.filter(kw => adrText.includes(kw)).length;
      if (score > bestScore) {
        bestScore = score;
        bestCtx = ctx.name;
      }
    }

    if (bestCtx) {
      assignment.get(bestCtx)?.push(adr);
    }
  }

  return assignment;
}

interface ADRCluster {
  name: string;
  adrs: Phase2ADRRecord[];
}

function clusterADRs(adrs: Phase2ADRRecord[]): ADRCluster[] {
  if (adrs.length <= 3) {
    return [{ name: adrs.map(a => a.title.split(':')[0]?.trim() ?? a.title).slice(0, 2).join(' + '), adrs }];
  }

  // Cluster by SPARC section refs or by title keyword groups
  const domainAdrs = adrs.filter(a => /domain|model|entity|aggregate/i.test(a.title));
  const algoAdrs = adrs.filter(a => /scor|algo|optim|simul|weight|rank|routing|threshold|estimat|emission|factor/i.test(a.title));
  const infraAdrs = adrs.filter(a => /erp|persist|deploy|security|compliance|performance/i.test(a.title));
  const remaining = adrs.filter(a => !domainAdrs.includes(a) && !algoAdrs.includes(a) && !infraAdrs.includes(a));

  const clusters: ADRCluster[] = [];
  if (domainAdrs.length > 0) clusters.push({ name: 'Domain Model & Bounded Contexts', adrs: domainAdrs });
  if (algoAdrs.length > 0) clusters.push({ name: 'Core Algorithms & Business Logic', adrs: algoAdrs });
  if (infraAdrs.length > 0) clusters.push({ name: 'Infrastructure & Integration', adrs: infraAdrs });
  if (remaining.length > 0) {
    if (clusters.length > 0) {
      clusters[clusters.length - 1]!.adrs.push(...remaining);
    } else {
      clusters.push({ name: 'Implementation', adrs: remaining });
    }
  }

  return clusters;
}

function buildContextPrompt(
  ctx: Phase2DDDBoundedContext,
  adrs: Phase2ADRRecord[],
  service: { name: string; responsibility: string; api: string[]; dependencies: string[] } | undefined,
  query: string,
  completedContexts: string[],
  totalSteps: number,
  order: number,
  simulationId: string,
): string {
  const lines: string[] = [
    `# Build Step ${order} of ${totalSteps}: ${ctx.name}`,
    '',
    '**The implementation must be production ready, enterprise grade, commercially viable, bug and error free, without compilation errors.**',
    '',
    '## Project Objective',
    '',
    query.slice(0, 500),
    '',
  ];

  if (simulationId) {
    lines.push('## Simulation Lineage', '', `Originating simulation: \`${simulationId}\``, '');
  }

  if (completedContexts.length > 0) {
    lines.push('## Already Built (import from these)', '');
    for (const prev of completedContexts) {
      lines.push(`- ${prev}`);
    }
    lines.push('');
  }

  // Bounded context definition
  lines.push(`## Bounded Context: ${ctx.name}`, '');
  lines.push(ctx.description, '');

  if (ctx.aggregates.length > 0) {
    lines.push('### Aggregates', '');
    for (const agg of ctx.aggregates) {
      lines.push(`**${agg.root}** (Aggregate Root): ${agg.name}`);
      if (agg.entities.length > 0) {
        lines.push('  Entities:');
        for (const e of agg.entities) lines.push(`  - ${e.name}: ${e.description}`);
      }
      if (agg.valueObjects.length > 0) {
        lines.push('  Value Objects:');
        for (const vo of agg.valueObjects) {
          lines.push(`  - ${vo.name}: ${vo.description}`);
          if (vo.invariants.length > 0) {
            lines.push(`    Invariants: ${vo.invariants.join('; ')}`);
          }
        }
      }
      lines.push('');
    }
  }

  if (ctx.domainEvents.length > 0) {
    lines.push('### Domain Events', '');
    for (const ev of ctx.domainEvents) {
      lines.push(`- **${ev.name}**: ${ev.description} (payload: ${ev.payload.join(', ')})`);
    }
    lines.push('');
  }

  if (ctx.commands.length > 0) {
    lines.push('### Commands', '');
    for (const cmd of ctx.commands) {
      lines.push(`- **${cmd.name}**: ${cmd.description}`);
    }
    lines.push('');
  }

  // Service specification
  if (service) {
    lines.push('### Service Specification', '');
    lines.push(`Responsibility: ${service.responsibility}`);
    if (service.api.length > 0) lines.push(`API: ${service.api.join(', ')}`);
    if (service.dependencies.length > 0) lines.push(`Dependencies: ${service.dependencies.join(', ')}`);
    lines.push('');
  }

  // Architecture decisions
  if (adrs.length > 0) {
    lines.push('## Architecture Decisions Governing This Context', '');
    for (const adr of adrs) {
      lines.push(`### ${adr.id}: ${adr.title}`, '');
      lines.push(`**Context:** ${adr.context}`, '');
      lines.push(`**Decision:** ${adr.decision}`, '');
      if (adr.consequences.length > 0) {
        lines.push('**Consequences:**');
        for (const c of adr.consequences) {
          const icon = c.type === 'positive' ? '+' : c.type === 'negative' ? '-' : '~';
          lines.push(`- [${icon}] ${c.description}`);
        }
        lines.push('');
      }
    }
  }

  lines.push('## Implementation Requirements', '');
  lines.push('- Use London School TDD: write failing test first, then minimal implementation');
  lines.push('- No stubs or placeholders — every function must have real logic');
  lines.push('- All business rules from the ADRs above must be enforced in code');
  lines.push('- Include error handling for edge cases identified in the ADRs');
  lines.push('- Hexagonal architecture: ports (interfaces) + adapters (implementations)');
  lines.push('');

  return lines.join('\n');
}
