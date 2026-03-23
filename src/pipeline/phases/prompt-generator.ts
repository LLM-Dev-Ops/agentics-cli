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
  DDDBoundedContext,
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

/**
 * Build layer definition: a coherent unit of work combining related ADRs
 * and DDD bounded contexts that should be built together.
 */
interface BuildLayer {
  readonly name: string;
  readonly priority: number;  // lower = build first
  readonly adrs: ADRRecord[];
  readonly contexts: DDDBoundedContext[];
  readonly dependsOn: string[];  // names of layers this depends on
}

function generatePrompts(
  sparc: SPARCOutput,
  adrs: ADRRecord[],
  domainModel: DomainModel,
  query: string,
  feedback: string[],
): ImplementationPrompt[] {
  // ── Step 1: Classify each ADR into a build layer ──
  const layerDefs: Array<{ name: string; priority: number; pattern: RegExp; dependsOn: string[] }> = [
    { name: 'Foundation & Shared Types',     priority: 0, pattern: /\b(?:infrastructure|platform|foundation|architecture[\s-]style|type|schema|shared|common)/i, dependsOn: [] },
    { name: 'Data Persistence',              priority: 1, pattern: /\b(?:data|persist|storage|database|migration|cqrs|event[\s-]?sourc)/i, dependsOn: ['Foundation & Shared Types'] },
    { name: 'Security & Identity',           priority: 2, pattern: /\b(?:security|auth|identity|access|encrypt|jwt|rbac|token)/i, dependsOn: ['Foundation & Shared Types'] },
    { name: 'Integration & Adapters',        priority: 3, pattern: /\b(?:integration|adapter|connector|erp|sap|api[\s-]?gateway|anti[\s-]?corruption|webhook)/i, dependsOn: ['Data Persistence', 'Security & Identity'] },
    { name: 'Communication & Messaging',     priority: 4, pattern: /\b(?:communicat|messag|event[\s-]?bus|queue|async|pub[\s-]?sub|inter[\s-]?service)/i, dependsOn: ['Foundation & Shared Types', 'Data Persistence'] },
    { name: 'Core Domain Logic',             priority: 5, pattern: /\b(?:domain|business|workflow|process|aggregate|command|query|core)/i, dependsOn: ['Data Persistence', 'Communication & Messaging'] },
    { name: 'Observability & Performance',   priority: 6, pattern: /\b(?:performance|cach|optimi|monitor|telemetry|observ|latency|health)/i, dependsOn: ['Core Domain Logic'] },
    { name: 'Compliance & Governance',       priority: 7, pattern: /\b(?:compliance|regulat|audit|governance|risk|gdpr|hipaa|disclosure)/i, dependsOn: ['Core Domain Logic', 'Security & Identity'] },
    { name: 'Deployment & Release',          priority: 8, pattern: /\b(?:deploy|release|ci[\s/]?cd|container|docker|kubernetes|cloud[\s-]?run|canary)/i, dependsOn: ['Core Domain Logic', 'Integration & Adapters'] },
  ];

  // Assign each ADR to its best-fit layer
  const layerMap = new Map<string, BuildLayer>();
  for (const def of layerDefs) {
    layerMap.set(def.name, { name: def.name, priority: def.priority, adrs: [], contexts: [], dependsOn: def.dependsOn });
  }

  for (const adr of adrs) {
    const text = `${adr.title} ${adr.context} ${adr.decision}`.toLowerCase();
    let assigned = false;
    for (const def of layerDefs) {
      if (def.pattern.test(text)) {
        layerMap.get(def.name)!.adrs.push(adr);
        assigned = true;
        break;
      }
    }
    if (!assigned) {
      // Default to Core Domain Logic
      layerMap.get('Core Domain Logic')!.adrs.push(adr);
    }
  }

  // ── Step 2: Map DDD bounded contexts to layers using the context map ──
  // Use the context map's upstream/downstream relationships to assign contexts
  const contextMap = domainModel.contextMap ?? [];
  const upstreamContexts = new Set(contextMap.map(r => r.upstream));
  const downstreamContexts = new Set(contextMap.map(r => r.downstream));

  for (const ctx of domainModel.contexts) {
    const ctxText = `${ctx.name} ${ctx.description}`.toLowerCase();
    let assigned = false;

    // First: check if any layer's ADRs reference this context
    for (const [, layer] of layerMap) {
      for (const adr of layer.adrs) {
        const adrText = `${adr.title} ${adr.context} ${adr.decision}`.toLowerCase();
        const keywords = ctx.name.toLowerCase().split(/[-_\s]+/).filter(k => k.length > 2);
        if (keywords.some(kw => adrText.includes(kw))) {
          layer.contexts.push(ctx);
          assigned = true;
          break;
        }
      }
      if (assigned) break;
    }

    if (!assigned) {
      // Use context map: upstream = foundational, downstream = dependent
      if (/\b(?:gateway|api|auth|identity)\b/i.test(ctxText) || (upstreamContexts.has(ctx.name) && !downstreamContexts.has(ctx.name))) {
        layerMap.get('Integration & Adapters')!.contexts.push(ctx);
      } else if (/\b(?:data|storage|persist)\b/i.test(ctxText)) {
        layerMap.get('Data Persistence')!.contexts.push(ctx);
      } else {
        layerMap.get('Core Domain Logic')!.contexts.push(ctx);
      }
    }
  }

  // ── Step 3: Remove empty layers, sort by priority ──
  const activeLayers = [...layerMap.values()]
    .filter(l => l.adrs.length > 0 || l.contexts.length > 0)
    .sort((a, b) => a.priority - b.priority);

  // Prune dependsOn to only reference active layers
  const activeNames = new Set(activeLayers.map(l => l.name));
  for (const layer of activeLayers) {
    (layer as { dependsOn: string[] }).dependsOn = layer.dependsOn.filter(d => activeNames.has(d));
  }

  // ── Step 4: Generate one prompt per active layer ──
  const prompts: ImplementationPrompt[] = [];
  const completedLayers: string[] = [];

  for (let i = 0; i < activeLayers.length; i++) {
    const layer = activeLayers[i]!;
    const order = i + 1;

    // Find SPARC services related to this layer's contexts
    const relatedServices = layer.contexts
      .map(ctx => sparc.architecture.services.find(s => s.name === ctx.name))
      .filter((s): s is NonNullable<typeof s> => s != null);

    const content = buildLayerPromptContent(
      query, layer, relatedServices, sparc, completedLayers, activeLayers.length, feedback, order,
    );

    const contextName = layer.contexts.length > 0
      ? layer.contexts.map(c => c.name).join('+')
      : slugify(layer.name);

    prompts.push({
      id: `prompt-${String(order).padStart(3, '0')}`,
      title: `Build Layer ${order}: ${layer.name}`,
      boundedContext: contextName,
      relatedADRs: layer.adrs.map(a => a.id),
      content,
      dependencies: layer.dependsOn,
      order,
    });

    completedLayers.push(layer.name);
  }

  return prompts;
}

/**
 * Build an implementation prompt for a build layer.
 * Each prompt combines multiple related ADRs and their DDD bounded contexts
 * into a coherent build unit. Earlier layers (foundations) are referenced as
 * already-built dependencies.
 */
function buildLayerPromptContent(
  query: string,
  layer: BuildLayer,
  relatedServices: Array<{ name: string; responsibility: string; api: string[]; dependencies: string[] }>,
  sparc: SPARCOutput,
  completedLayers: string[],
  totalLayers: number,
  feedback: string[],
  order: number,
): string {
  const lines: string[] = [
    `# Build Layer ${order}: ${layer.name}`,
    '',
    `**The implementation must be production ready, enterprise grade, commercially viable, bug and error free, without compilation errors.**`,
    '',
    `> Build layer ${order} of ${totalLayers}. ${layer.dependsOn.length > 0 ? `Depends on: ${layer.dependsOn.join(', ')}.` : 'No dependencies — this is a foundation layer.'}`,
    '',
    `## Project Objective`,
    '',
    query,
    '',
  ];

  // Previously built layers
  if (completedLayers.length > 0) {
    lines.push('## Already Built (import and build on these)');
    lines.push('');
    for (const prev of completedLayers) {
      lines.push(`- **${prev}** — completed and available for import`);
    }
    lines.push('');
  }

  // Architecture decisions for this layer
  if (layer.adrs.length > 0) {
    lines.push(`## Architecture Decisions for This Layer (${layer.adrs.length} ADRs)`);
    lines.push('');
    for (const adr of layer.adrs) {
      lines.push(`### ${adr.id}: ${adr.title}`);
      lines.push('');
      lines.push(`**Context:** ${adr.context}`);
      lines.push('');
      lines.push(`**Decision:** ${adr.decision}`);
      lines.push('');
      if (adr.consequences.length > 0) {
        lines.push('**Consequences:**');
        for (const c of adr.consequences) { lines.push(`- ${c}`); }
        lines.push('');
      }
    }
  }

  // Bounded contexts to implement in this layer
  if (layer.contexts.length > 0) {
    lines.push(`## Bounded Contexts to Implement (${layer.contexts.length})`);
    lines.push('');
    for (const ctx of layer.contexts) {
      lines.push(`### ${ctx.name}`);
      lines.push('');
      lines.push(ctx.description);
      lines.push('');

      // Aggregates with entities and value objects
      if (ctx.aggregates.length > 0) {
        lines.push('**Aggregates:**');
        for (const agg of ctx.aggregates) {
          lines.push(`- **${agg.name}** (root: ${agg.root})`);
          if (agg.entities.length > 0) lines.push(`  - Entities: ${agg.entities.join(', ')}`);
          if (agg.valueObjects.length > 0) lines.push(`  - Value Objects: ${agg.valueObjects.join(', ')}`);
        }
        lines.push('');
      }

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

  // Quality requirements (only include those relevant to this layer)
  lines.push('## Quality Requirements', '');

  if (layer.priority <= 2 || layer.name.includes('Security')) {
    lines.push('### Security');
    const secItems = sparc.refinement?.securityConsiderations ?? [];
    for (const sec of (Array.isArray(secItems) ? secItems : []).slice(0, 4)) {
      lines.push(`- ${typeof sec === 'string' ? sec : (sec as { text?: string }).text ?? String(sec)}`);
    }
    lines.push('');
  }

  if (layer.priority >= 5 || layer.name.includes('Performance')) {
    lines.push('### Performance');
    const perfItems = sparc.refinement?.performanceTargets ?? [];
    for (const perf of (Array.isArray(perfItems) ? perfItems : []).slice(0, 3)) {
      lines.push(`- ${typeof perf === 'string' ? perf : (perf as { text?: string }).text ?? String(perf)}`);
    }
    lines.push('');
  }

  lines.push('### Testing');
  lines.push(`Use London School TDD: write tests first for this layer's bounded contexts, mock dependencies from prior layers.`);
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
  lines.push(`1. **Implement ALL ${layer.adrs.length} ADRs in this layer together.** They form a coherent unit — implement them as a single build step.`);
  lines.push(`2. **Implement ALL ${layer.contexts.length} bounded context(s) listed above.** Include aggregates, commands, queries, and domain events.`);
  lines.push('3. **Write tests first** (London School TDD). Mock dependencies from prior layers. Define expected behavior, then implement to pass.');
  lines.push('4. **Write real domain logic** — no stubs, no TODOs, no placeholder functions. Every function must have a working body.');
  lines.push('5. **Use typed interfaces from the DDD domain model** — aggregates, entities, value objects as specified above. Never use `any` for domain types.');
  lines.push('6. **Enforce invariants** — validate domain rules in constructors and commands. Throw domain-specific exceptions on violation.');
  lines.push('7. **Import from prior layers** — the layers listed in "Already Built" are available. Import and use their types, services, and interfaces.');
  lines.push('8. **Export for future layers** — downstream layers will import from this one. Export clean interfaces at module boundaries.');
  lines.push('9. **Zero compilation errors** — all imports must resolve, all types must align, all generics must be properly constrained.');
  lines.push('10. **Production-grade patterns** — connection pooling, graceful shutdown, structured logging, health checks, circuit breakers where applicable.');
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
    '  Implementation Plan (layered build order):',
    '',
    `  - ${plan.totalSteps} build layers`,
    `  - Estimated execution time: ${plan.estimatedDuration}`,
    '',
    '  Build order:',
    ...plan.prompts.map(p => {
      const deps = p.dependencies.length > 0 ? ` [depends on: ${p.dependencies.join(', ')}]` : ' [foundation]';
      return `    ${p.order}. ${p.title} (${p.relatedADRs.length} ADRs, contexts: ${p.boundedContext})${deps}`;
    }),
  ].join('\n');
}
