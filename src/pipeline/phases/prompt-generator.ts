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

  // Guard: if ADRs array is empty, nothing to generate
  if (!adrs || adrs.length === 0) {
    return {
      stage: 'prompt-generation',
      status: 'failed',
      data: { error: 'No ADRs available for prompt generation' },
      artifacts: [],
      timing: Date.now() - start,
      summary: '  ERROR: No ADRs available for prompt generation.',
    };
  }

  const prompts = generatePrompts(sparc, adrs, domainModel ?? { contexts: [], contextMap: [], ubiquitousLanguageGlossary: [] }, context.query, feedback);

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
 * Build layer: a coherent unit of work — one or more DDD bounded contexts
 * that sit at the same depth in the dependency graph, plus all ADRs that
 * govern those contexts.
 */
interface BuildLayer {
  readonly name: string;
  readonly depth: number;
  readonly adrs: ADRRecord[];
  readonly contexts: DDDBoundedContext[];
  readonly dependsOn: string[];  // names of prior layers this imports from
}

function generatePrompts(
  sparc: SPARCOutput,
  adrs: ADRRecord[],
  domainModel: DomainModel,
  query: string,
  feedback: string[],
): ImplementationPrompt[] {
  const contexts = domainModel.contexts ?? [];
  const relations = domainModel.contextMap ?? [];

  // ── Fallback: If no DDD bounded contexts exist, derive layers from ADR relationships ──
  if (contexts.length === 0) {
    console.error('    [PROMPTS] No DDD bounded contexts found — deriving layers from ADR cross-references');
    return generatePromptsFromADRs(sparc, adrs, query, feedback);
  }

  // ── Step 1: Topological sort of bounded contexts using the DDD context map ──
  // Build adjacency: upstream → downstream means downstream depends on upstream
  const downstreamOf = new Map<string, Set<string>>(); // context → set of contexts it depends on
  const allNames = new Set(contexts.map(c => c.name));

  for (const ctx of contexts) {
    downstreamOf.set(ctx.name, new Set());
  }
  for (const rel of relations) {
    if (allNames.has(rel.upstream) && allNames.has(rel.downstream)) {
      downstreamOf.get(rel.downstream)?.add(rel.upstream);
    }
  }

  // Compute depth: contexts with no upstream deps = depth 0, others = max(upstream depths) + 1
  const depthOf = new Map<string, number>();
  function computeDepth(name: string, visited: Set<string>): number {
    if (depthOf.has(name)) return depthOf.get(name)!;
    if (visited.has(name)) return 0; // cycle guard
    visited.add(name);
    const deps = downstreamOf.get(name) ?? new Set();
    const maxUpstream = deps.size === 0 ? -1 : Math.max(...[...deps].map(d => computeDepth(d, visited)));
    const depth = maxUpstream + 1;
    depthOf.set(name, depth);
    return depth;
  }
  for (const ctx of contexts) {
    computeDepth(ctx.name, new Set());
  }

  // ── Step 2: Group contexts by depth into build layers ──
  const depthGroups = new Map<number, DDDBoundedContext[]>();
  for (const ctx of contexts) {
    const d = depthOf.get(ctx.name) ?? 0;
    if (!depthGroups.has(d)) depthGroups.set(d, []);
    depthGroups.get(d)!.push(ctx);
  }

  const sortedDepths = [...depthGroups.keys()].sort((a, b) => a - b);

  // ── Step 3: Assign ADRs to the layer where their affected contexts live ──
  // An ADR affects a context if the context name keywords appear in the ADR text
  const adrToLayer = new Map<string, number>(); // adr.id → depth

  for (const adr of adrs) {
    const adrText = `${adr.title} ${adr.context} ${adr.decision}`.toLowerCase();
    let bestDepth = -1;
    let bestScore = 0;

    for (const [depth, ctxGroup] of depthGroups) {
      for (const ctx of ctxGroup) {
        const keywords = ctx.name.toLowerCase().split(/[-_\s]+/).filter(k => k.length > 2);
        const score = keywords.filter(kw => adrText.includes(kw)).length;
        if (score > bestScore) {
          bestScore = score;
          bestDepth = depth;
        }
      }
    }

    // If no context matched, assign to depth 0 (foundation)
    adrToLayer.set(adr.id, bestDepth >= 0 ? bestDepth : 0);
  }

  // ── Step 4: Build layers with domain-specific names ──
  const layers: BuildLayer[] = [];
  const layerNameByDepth = new Map<number, string>();

  for (const depth of sortedDepths) {
    const ctxGroup = depthGroups.get(depth)!;
    const layerAdrs = adrs.filter(a => adrToLayer.get(a.id) === depth);

    // Name the layer after its actual contexts
    const ctxNames = ctxGroup.map(c => c.name);
    const name = ctxNames.length <= 3
      ? ctxNames.join(' + ')
      : `${ctxNames.slice(0, 2).join(' + ')} + ${ctxNames.length - 2} more`;
    layerNameByDepth.set(depth, name);

    // Dependencies: layers at lower depths that have upstream relationships to this layer's contexts
    const depNames: string[] = [];
    for (const ctx of ctxGroup) {
      const upstreams = downstreamOf.get(ctx.name) ?? new Set();
      for (const up of upstreams) {
        const upDepth = depthOf.get(up) ?? 0;
        const upLayerName = layerNameByDepth.get(upDepth);
        if (upLayerName && !depNames.includes(upLayerName)) {
          depNames.push(upLayerName);
        }
      }
    }

    layers.push({
      name,
      depth,
      adrs: layerAdrs,
      contexts: ctxGroup,
      dependsOn: depNames,
    });
  }

  // Handle orphan ADRs that matched depth 0 but no contexts exist at depth 0
  // (merge them into the first layer)
  const orphanAdrs = adrs.filter(a => {
    const d = adrToLayer.get(a.id) ?? 0;
    return !depthGroups.has(d);
  });
  if (orphanAdrs.length > 0 && layers.length > 0) {
    layers[0]!.adrs.push(...orphanAdrs);
  }

  // ── Step 5: Generate one prompt per layer ──
  const prompts: ImplementationPrompt[] = [];
  const completedLayers: string[] = [];

  for (let i = 0; i < layers.length; i++) {
    const layer = layers[i]!;
    const order = i + 1;

    const relatedServices = layer.contexts
      .map(ctx => (sparc.architecture?.services ?? []).find(s => s.name === ctx.name))
      .filter((s): s is NonNullable<typeof s> => s != null);

    const content = buildLayerPromptContent(
      query, layer, relatedServices, sparc, completedLayers, layers.length, feedback, order,
    );

    const contextName = layer.contexts.map(c => c.name).join('+');

    prompts.push({
      id: `prompt-${String(order).padStart(3, '0')}`,
      title: `Build: ${layer.name}`,
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
    `# Build Step ${order} of ${totalLayers}: ${layer.name}`,
    '',
    `**The implementation must be production ready, enterprise grade, commercially viable, bug and error free, without compilation errors.**`,
    '',
    layer.dependsOn.length > 0
      ? `> This step depends on: ${layer.dependsOn.join(', ')}. Those are already built — import from them.`
      : `> This is a foundation step — no prior steps to depend on. Build the core types and interfaces that later steps will import.`,
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

  // Quality requirements from SPARC refinement
  lines.push('## Quality Requirements', '');

  const secItems = sparc.refinement?.securityConsiderations ?? [];
  if (Array.isArray(secItems) && secItems.length > 0) {
    lines.push('### Security');
    for (const sec of secItems.slice(0, 4)) {
      lines.push(`- ${typeof sec === 'string' ? sec : (sec as { text?: string }).text ?? String(sec)}`);
    }
    lines.push('');
  }

  const perfItems = sparc.refinement?.performanceTargets ?? [];
  if (Array.isArray(perfItems) && perfItems.length > 0) {
    lines.push('### Performance');
    for (const perf of perfItems.slice(0, 3)) {
      lines.push(`- ${typeof perf === 'string' ? perf : (perf as { text?: string }).text ?? String(perf)}`);
    }
    lines.push('');
  }

  lines.push('### Testing');
  lines.push(`Use London School TDD: write tests first for the bounded contexts in this step, mock dependencies from prior steps.`);
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
  lines.push(`1. **Implement ALL ${layer.adrs.length} ADR(s) and ALL ${layer.contexts.length} bounded context(s) in this step together.** They form a coherent unit.`);
  lines.push('2. **Write tests first** (London School TDD). Mock dependencies from prior build steps. Define expected behavior, then implement to pass.');
  lines.push('3. **Write real domain logic** — no stubs, no TODOs, no placeholder functions. Every function must have a working body.');
  lines.push('4. **Use typed interfaces from the DDD domain model** — aggregates, entities, value objects as specified above. Never use `any` for domain types.');
  lines.push('5. **Enforce invariants** — validate domain rules in constructors and commands. Throw domain-specific exceptions on violation.');
  lines.push('6. **Import from prior steps** — the steps listed in "Already Built" are available. Import and use their types, services, and interfaces.');
  lines.push('7. **Export for future steps** — later build steps will import from this one. Export clean interfaces at module boundaries.');
  lines.push('8. **Zero compilation errors** — all imports must resolve, all types must align, all generics must be properly constrained.');
  lines.push('9. **Production-grade patterns** — connection pooling, graceful shutdown, structured logging, health checks, circuit breakers where applicable.');
  lines.push('');

  return lines.join('\n');
}

// ============================================================================
// Helpers
// ============================================================================

function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

// ============================================================================
// ADR-Only Prompt Generation (fallback when no DDD bounded contexts exist)
// ============================================================================

/**
 * When the DDD model has no bounded contexts, derive implementation layers
 * from ADR cross-references. Groups ADRs by domain affinity (shared keywords
 * in titles, contexts, and decisions), then orders groups by dependency depth
 * (infrastructure ADRs first, domain-specific ADRs later).
 */
function generatePromptsFromADRs(
  sparc: SPARCOutput,
  adrs: ADRRecord[],
  query: string,
  feedback: string[],
): ImplementationPrompt[] {
  // ── Step 1: Classify ADRs into tiers by keyword analysis ──
  const infraKeywords = new Set([
    'database', 'storage', 'persistence', 'infrastructure', 'deployment',
    'authentication', 'authorization', 'security', 'logging', 'monitoring',
    'configuration', 'environment', 'ci', 'cd', 'pipeline', 'container',
    'network', 'api', 'gateway', 'message', 'queue', 'event', 'bus',
    'cache', 'session', 'identity', 'encryption', 'tls', 'certificate',
  ]);
  const integrationKeywords = new Set([
    'integration', 'erp', 'external', 'connector', 'adapter', 'webhook',
    'sync', 'import', 'export', 'migration', 'data', 'transfer', 'etl',
    'api', 'client', 'sdk', 'protocol', 'format', 'schema', 'mapping',
  ]);

  interface ScoredADR {
    adr: ADRRecord;
    infraScore: number;
    integrationScore: number;
    tier: 'foundation' | 'domain' | 'integration';
    crossRefs: string[]; // IDs of ADRs this one references
  }

  const scored: ScoredADR[] = adrs.map(adr => {
    const text = `${adr.title} ${adr.context} ${adr.decision}`.toLowerCase();
    const words = text.split(/\W+/);

    let infraScore = 0;
    let integrationScore = 0;
    for (const w of words) {
      if (infraKeywords.has(w)) infraScore++;
      if (integrationKeywords.has(w)) integrationScore++;
    }

    // Find cross-references: ADR IDs mentioned in this ADR's text
    const crossRefs = adrs
      .filter(other => other.id !== adr.id && text.includes(other.id.toLowerCase()))
      .map(other => other.id);

    // Also find keyword-based cross-references (shared domain terms)
    const titleWords = adr.title.toLowerCase().split(/\W+/).filter(w => w.length > 3);
    for (const other of adrs) {
      if (other.id === adr.id || crossRefs.includes(other.id)) continue;
      const otherText = `${other.title} ${other.context} ${other.decision}`.toLowerCase();
      const sharedWords = titleWords.filter(w => otherText.includes(w));
      if (sharedWords.length >= 2) crossRefs.push(other.id);
    }

    const tier: 'foundation' | 'domain' | 'integration' =
      infraScore >= 2 ? 'foundation'
        : integrationScore >= 2 ? 'integration'
          : 'domain';

    return { adr, infraScore, integrationScore, tier, crossRefs };
  });

  // ── Step 2: Group into layers by tier (foundation → domain → integration) ──
  type TierEntry = { name: string; tier: 'foundation' | 'domain' | 'integration'; adrs: ScoredADR[] };
  const tiers: TierEntry[] = ([
    { name: 'Foundation & Infrastructure', tier: 'foundation' as const, adrs: scored.filter(s => s.tier === 'foundation') },
    { name: 'Core Domain Logic', tier: 'domain' as const, adrs: scored.filter(s => s.tier === 'domain') },
    { name: 'Integration & External Systems', tier: 'integration' as const, adrs: scored.filter(s => s.tier === 'integration') },
  ] satisfies TierEntry[]).filter(g => g.adrs.length > 0);

  // If all ADRs ended up in one tier, split into smaller groups for better granularity
  if (tiers.length === 1 && tiers[0]!.adrs.length > 3) {
    const all = tiers[0]!.adrs;
    const mid = Math.ceil(all.length / 2);
    tiers.length = 0;
    tiers.push(
      { name: 'Core Architecture & Foundations', tier: 'foundation' as const, adrs: all.slice(0, mid) },
      { name: 'Domain Services & Orchestration', tier: 'domain' as const, adrs: all.slice(mid) },
    );
  }

  // ── Step 3: Generate prompts per layer with full ADR content and cross-refs ──
  const prompts: ImplementationPrompt[] = [];
  const completedLayers: string[] = [];

  for (let i = 0; i < tiers.length; i++) {
    const group = tiers[i]!;
    const order = i + 1;

    const lines: string[] = [
      `# Build Step ${order} of ${tiers.length}: ${group.name}`,
      '',
      '**The implementation must be production ready, enterprise grade, commercially viable, bug and error free, without compilation errors.**',
      '',
      completedLayers.length > 0
        ? `> This step builds on: ${completedLayers.join(', ')}. Import from previously built modules.`
        : '> This is the foundation step. Build the core types and interfaces that later steps will import.',
      '',
      '## Project Objective',
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
    lines.push(`## Architecture Decisions for This Layer (${group.adrs.length} ADRs)`);
    lines.push('');
    for (const scored of group.adrs) {
      const adr = scored.adr;
      lines.push(`### ${adr.id}: ${adr.title}`);
      lines.push('');
      lines.push(`**Context:** ${adr.context}`);
      lines.push('');
      lines.push(`**Decision:** ${adr.decision}`);
      lines.push('');
      if (adr.alternatives && adr.alternatives.length > 0) {
        lines.push('**Alternatives Considered:**');
        for (const alt of adr.alternatives) { lines.push(`- ${alt}`); }
        lines.push('');
      }
      if (adr.consequences && adr.consequences.length > 0) {
        lines.push('**Consequences:**');
        for (const c of adr.consequences) { lines.push(`- ${c}`); }
        lines.push('');
      }
      // Cross-references to other ADRs
      if (scored.crossRefs.length > 0) {
        lines.push(`**Related ADRs:** ${scored.crossRefs.join(', ')}`);
        lines.push('');
      }
    }

    // Quality requirements from SPARC
    const secItems = sparc.refinement?.securityConsiderations ?? [];
    if (group.tier === 'foundation' && Array.isArray(secItems) && secItems.length > 0) {
      lines.push('## Security Requirements');
      lines.push('');
      for (const sec of secItems.slice(0, 4)) {
        lines.push(`- ${typeof sec === 'string' ? sec : (sec as { text?: string }).text ?? String(sec)}`);
      }
      lines.push('');
    }

    // Implementation guidance
    lines.push('## Implementation Requirements');
    lines.push('');
    lines.push('- Write clean, modular code following the language(s) specified in the project objective');
    lines.push('- Include comprehensive unit tests (London School TDD — mock at boundaries)');
    lines.push('- Follow domain-driven design patterns where applicable');
    lines.push('- Export public interfaces for downstream consumers');
    lines.push('- Ensure full type safety and compile-time correctness');
    lines.push('');

    if (feedback.length > 0) {
      lines.push('## User Feedback');
      lines.push('');
      for (const f of feedback) lines.push(`- ${f}`);
      lines.push('');
    }

    const content = lines.join('\n');
    const adrIds = group.adrs.map(s => s.adr.id);

    prompts.push({
      id: `prompt-${String(order).padStart(3, '0')}`,
      title: `Build: ${group.name}`,
      boundedContext: group.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
      relatedADRs: adrIds,
      content,
      dependencies: [...completedLayers],
      order,
    });

    completedLayers.push(group.name);
  }

  return prompts;
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
