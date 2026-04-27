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

/**
 * ADR-PIPELINE-093 — prompt-generator precondition probe.
 *
 * Mirrors the Rule 4 hard-guard check on disk before any work starts:
 * refuses to run without a SPARC specification AND at least one of
 * ADRs / DDD bounded contexts / engineering architecture decisions.
 *
 * ADR-PIPELINE-094 Decision 2 — adds a `phase1-fallback` outcome that
 * fires when the SPARC/ADR/DDD chain is unavailable but Phase-1 simulator
 * consensus is on disk (decision-memo, scenario, executive-summary). The
 * caller treats `phase1-fallback` as a degraded-mode signal: prompts get
 * generated from Phase-1 inputs and tagged `degraded_mode: phase1-fallback`
 * in their markdown frontmatter so consumers know the provenance.
 *
 * Runs against `artifactsDir` (== runDir in auto-chain) so the same
 * rule fires whether the coordinator or auto-chain calls in.
 */
function checkPromptGeneratorInputs(runDir: string):
  | { ok: true; mode: 'normal' }
  | { ok: true; mode: 'phase1-fallback'; sources: { decisionMemo?: string; scenario?: string; execSummary?: string } }
  | { ok: false; reason: 'blocked-missing-upstream'; missing: string[] } {
  const sparcCandidates = [
    path.join(runDir, 'phase3', 'sparc', 'specification.md'),
    path.join(runDir, 'engineering', 'sparc-specification.md'),
  ];
  const adrGlobDirs = [
    path.join(runDir, 'phase4', 'adrs'),
  ];
  const dddFile = path.join(runDir, 'phase4', 'ddd', 'bounded-contexts.json');
  const engAdrsFile = path.join(runDir, 'engineering', 'architecture-decisions.md');

  // ADR-094 Decision 2 — Phase-1 fallback candidates. Phase 1 writes flat
  // (per swarm-orchestrator); we accept either flat or `phase1/` subdir
  // layout for backwards compat with existing fixtures.
  const phase1DecisionMemoCandidates = [
    path.join(runDir, 'decision-memo.md'),
    path.join(runDir, 'phase1', 'decision-memo.md'),
  ];
  const phase1ScenarioCandidates = [
    path.join(runDir, 'scenario.json'),
    path.join(runDir, 'phase1', 'scenario.json'),
  ];
  const phase1ExecSummaryCandidates = [
    path.join(runDir, 'executive-summary.md'),
    path.join(runDir, 'phase1', 'executive-summary.md'),
  ];

  const fileOk = (p: string, min = 100): boolean => {
    try {
      const s = fs.statSync(p);
      return s.isFile() && s.size > min;
    } catch {
      return false;
    }
  };
  const firstOk = (paths: string[], min = 100): string | undefined => {
    for (const p of paths) if (fileOk(p, min)) return p;
    return undefined;
  };
  const dirHasMd = (p: string): boolean => {
    try {
      return fs.readdirSync(p).some(f => f.endsWith('.md') && fileOk(path.join(p, f), 50));
    } catch {
      return false;
    }
  };

  const hasSparc = sparcCandidates.some(p => fileOk(p));
  const hasAdrs = adrGlobDirs.some(dirHasMd);
  const hasDdd = fileOk(dddFile, 50);
  const hasEngAdrs = fileOk(engAdrsFile);

  // Normal path — full SPARC + (ADRs OR DDD OR engineering decisions) chain.
  if (hasSparc && (hasAdrs || hasDdd || hasEngAdrs)) return { ok: true, mode: 'normal' };

  // Phase-1 fallback (ADR-094 Decision 2). At least one Phase-1 consensus
  // signal must be present AND >=100 bytes. decision-memo is the strongest
  // signal because Phase 1's ADR-089 health gate ensures it carries the
  // engineering rationale; scenario.json is accepted as a secondary source
  // (less narrative but always-present).
  const decisionMemo = firstOk(phase1DecisionMemoCandidates);
  const scenario = firstOk(phase1ScenarioCandidates);
  const execSummary = firstOk(phase1ExecSummaryCandidates);
  if (decisionMemo || scenario) {
    return {
      ok: true,
      mode: 'phase1-fallback',
      sources: { decisionMemo, scenario, execSummary },
    };
  }

  // Hard-block: nothing usable.
  const missing: string[] = [];
  if (!hasSparc) {
    missing.push('phase3/sparc/specification.md OR engineering/sparc-specification.md');
  }
  if (!hasAdrs && !hasDdd && !hasEngAdrs) {
    missing.push('phase4/adrs/*.md OR phase4/ddd/bounded-contexts.json OR engineering/architecture-decisions.md');
  }
  // ADR-094 D2 — surface the Phase-1 fallback as an attempted-but-also-missing
  // candidate so the FATAL banner explains what the gate looked for.
  missing.push('phase1/decision-memo.md OR phase1/scenario.json (Phase-1 fallback)');
  return { ok: false, reason: 'blocked-missing-upstream', missing };
}

export async function executePromptGeneration(
  context: PipelineContext,
): Promise<StageOutput> {
  const start = Date.now();
  const promptsDir = path.join(context.artifactsDir, 'prompts');
  fs.mkdirSync(promptsDir, { recursive: true, mode: 0o700 });
  const artifacts: string[] = [];

  // Get inputs from previous stages (peek first so the ADR-093 hard guard
  // can honour in-memory stage outputs as a valid upstream signal).
  const sparcOutput = context.stageOutputs.get('sparc-development');
  const adrDddOutput = context.stageOutputs.get('adr-ddd-generation');
  const feedback = context.userFeedback.get('prompt-generation') ?? [];
  const hasInMemoryUpstream = !!sparcOutput?.data && !!adrDddOutput?.data;

  // ADR-PIPELINE-093 Rule 4 — HARD GUARD.
  // Refuse to run unless SPARC spec exists AND at least one of:
  //   ADRs / DDD bounded contexts / engineering architecture-decisions.md
  // When the coordinator already has in-memory upstream `stageOutputs` (the
  // common path for the phase2 pipeline tests), the disk check is bypassed
  // because the in-memory data subsumes the disk requirement. Auto-chain
  // does NOT call this entry point directly — it invokes the gate, then
  // the phase coordinator writes artifacts to disk. The disk-based guard
  // still fires for standalone consumers that lack stage-outputs.
  //
  // ADR-094 Decision 2 — when SPARC/ADR/DDD chain is missing but Phase-1
  // consensus is on disk, branch into the phase1-fallback path which writes
  // a single degraded-mode prompt + execution-plan instead of failing.
  if (!hasInMemoryUpstream) {
    const inputCheck = checkPromptGeneratorInputs(context.artifactsDir);
    if (!inputCheck.ok) {
      return {
        stage: 'prompt-generation',
        status: 'failed',
        data: {
          ok: false,
          reason: inputCheck.reason,
          missing: inputCheck.missing,
        },
        artifacts: [],
        timing: Date.now() - start,
        summary: `  ERROR: prompt-generator blocked — missing upstream: ${inputCheck.missing.join(', ')}`,
      };
    }
    if (inputCheck.mode === 'phase1-fallback') {
      return executePhase1FallbackPromptGeneration(
        context,
        promptsDir,
        inputCheck.sources,
        start,
      );
    }
  }

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
  const dddContextCount = (domainModel?.contexts ?? []).length;

  // ADR-PIPELINE-093 Rule 4 — symmetric DDD-only branch.
  // The existing ADR-only branch (`generatePromptsFromADRs`, :452) covers
  // the "ADRs present but no DDD" disjunct. This symmetric branch fires
  // when DDD bounded contexts exist but ADRs are absent — in which case
  // `generatePrompts` still runs (the DDD layer topology drives the
  // layers; per-layer `adrs` arrays are empty but the prompt content
  // renders from DDD + SPARC). Without this relaxation the pipeline
  // would silently skip prompt generation.
  if ((!adrs || adrs.length === 0) && dddContextCount === 0) {
    return {
      stage: 'prompt-generation',
      status: 'failed',
      data: { error: 'No ADRs and no DDD bounded contexts available for prompt generation' },
      artifacts: [],
      timing: Date.now() - start,
      summary: '  ERROR: No ADRs and no DDD bounded contexts available for prompt generation.',
    };
  }

  const safeAdrs: ADRRecord[] = adrs ?? [];
  const prompts = generatePrompts(
    sparc,
    safeAdrs,
    domainModel ?? { contexts: [], contextMap: [], ubiquitousLanguageGlossary: [] },
    context.query,
    feedback,
  );

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
// ADR-094 Decision 2 — Phase-1 fallback prompt generation
// ============================================================================

/**
 * Phase-1 fallback prompt generation. Consumes Phase-1 simulator consensus
 * (decision-memo, scenario, executive-summary) and produces a single degraded
 * implementation prompt plus a valid execution-plan.json. The output is
 * lower quality than the SPARC→ADR→DDD chain but satisfies the contract:
 * `prompts/impl-001-phase1-*.md` exists, `prompts/execution-plan.json` is
 * valid JSON with at least one `prompts[]` entry. Each prompt's frontmatter
 * carries `degraded_mode: phase1-fallback` so consumers know provenance.
 *
 * Invoked from `executePromptGeneration` when `checkPromptGeneratorInputs`
 * returns `mode: 'phase1-fallback'`.
 */
function executePhase1FallbackPromptGeneration(
  context: PipelineContext,
  promptsDir: string,
  sources: { decisionMemo?: string; scenario?: string; execSummary?: string },
  start: number,
): StageOutput {
  const artifacts: string[] = [];
  console.error('  [PROMPTS] Phase-1 fallback mode — degraded prompts from simulator consensus');

  // Read the consensus inputs (best-effort; missing files are skipped).
  const readSafe = (p: string | undefined): string | undefined => {
    if (!p) return undefined;
    try {
      return fs.readFileSync(p, 'utf8');
    } catch {
      return undefined;
    }
  };
  const decisionMemo = readSafe(sources.decisionMemo);
  const scenarioRaw = readSafe(sources.scenario);
  const execSummary = readSafe(sources.execSummary);

  // Synthesize a single coherent prompt from whatever we have. The prompt
  // is intentionally short and focused: list the brief, the consensus
  // material, and a concrete implementation directive. The frontmatter
  // tags it so post-run consumers know the provenance.
  const promptId = 'impl-001-phase1-consensus';
  const order = 1;
  const promptContent = buildPhase1FallbackPromptMarkdown({
    query: context.query,
    decisionMemo,
    scenarioRaw,
    execSummary,
  });
  const promptPath = path.join(promptsDir, `${promptId}.md`);
  fs.writeFileSync(promptPath, promptContent, { mode: 0o600, encoding: 'utf-8' });
  artifacts.push(`prompts/${promptId}.md`);

  // Build the execution plan with a single prompt entry traced to its source.
  const prompt: ImplementationPrompt = {
    id: promptId,
    title: `Implementation: ${(context.query || 'phase-1 consensus').slice(0, 80)}`,
    boundedContext: 'phase1-consensus',
    relatedADRs: [],
    content: promptContent,
    dependencies: [],
    order,
  };
  const executionPlan: ExecutionPlan = {
    prompts: [prompt],
    totalSteps: 1,
    estimatedDuration: '5-15 minutes',
  };
  fs.writeFileSync(
    path.join(promptsDir, 'execution-plan.json'),
    JSON.stringify(executionPlan, null, 2),
    { mode: 0o600, encoding: 'utf-8' },
  );
  artifacts.push('prompts/execution-plan.json');

  console.error('    [1/1] phase1-consensus (degraded_mode: phase1-fallback)');
  console.error('  Generated 1 degraded implementation prompt from Phase-1 consensus.');

  return {
    stage: 'prompt-generation',
    status: 'completed',
    data: executionPlan,
    artifacts,
    timing: Date.now() - start,
    summary: '  Phase-1 fallback: 1 degraded prompt + execution-plan.json',
  };
}

/**
 * Build the markdown body for a Phase-1 fallback prompt. The frontmatter is
 * the ADR-094 D2 contract surface: consumers grep for `degraded_mode:` to
 * decide whether the prompt is full-fidelity or simulator-only.
 */
function buildPhase1FallbackPromptMarkdown(args: {
  query: string;
  decisionMemo: string | undefined;
  scenarioRaw: string | undefined;
  execSummary: string | undefined;
}): string {
  const lines: string[] = [];
  // YAML frontmatter — the canonical degraded-mode tag.
  lines.push('---');
  lines.push('id: impl-001-phase1-consensus');
  lines.push('title: Phase-1 Consensus Implementation');
  lines.push('order: 1');
  lines.push('degraded_mode: phase1-fallback');
  lines.push(`source: ${[
    args.decisionMemo ? 'phase1/decision-memo.md' : null,
    args.scenarioRaw ? 'phase1/scenario.json' : null,
    args.execSummary ? 'phase1/executive-summary.md' : null,
  ].filter(Boolean).join(', ')}`);
  lines.push('quality: degraded');
  lines.push('---');
  lines.push('');
  lines.push('# Implementation: Phase-1 Consensus');
  lines.push('');
  lines.push('> **Generated by Phase-1 fallback** (ADR-PIPELINE-094 Decision 2). The full SPARC → ADR → DDD chain was unavailable for this run; this prompt was produced directly from Phase-1 simulator consensus. Quality: **degraded**. For full-fidelity prompts, re-run with Ruflo available and Phases 3–4 enabled.');
  lines.push('');
  lines.push('## Brief');
  lines.push('');
  lines.push(args.query || '(no brief recorded)');
  lines.push('');
  if (args.execSummary) {
    lines.push('## Executive Summary');
    lines.push('');
    lines.push(args.execSummary.trim());
    lines.push('');
  }
  if (args.decisionMemo) {
    lines.push('## Decision Memo');
    lines.push('');
    lines.push(args.decisionMemo.trim());
    lines.push('');
  }
  if (args.scenarioRaw) {
    lines.push('## Scenario');
    lines.push('');
    lines.push('```json');
    lines.push(args.scenarioRaw.trim());
    lines.push('```');
    lines.push('');
  }
  lines.push('## Implementation Directive');
  lines.push('');
  lines.push('Implement the system described in the Brief, using the Decision Memo and Executive Summary above as the architectural rationale. Produce:');
  lines.push('');
  lines.push('- A single deployable service in the language declared by `phase1/manifest.json` (`project.language`).');
  lines.push('- Clear separation between the analysis layer, the decision layer, and the integration layer.');
  lines.push('- Input validation on all public functions.');
  lines.push('- Correlation ID threading from the inbound request through to any external surface.');
  lines.push('- Unit tests for the analysis and decision layers.');
  lines.push('');
  lines.push('Because no DDD bounded contexts or ADRs are available, the file layout follows a flat structure under `src/`:');
  lines.push('');
  lines.push('```');
  lines.push('src/');
  lines.push('  index.ts            # entry point');
  lines.push('  config.ts           # AppConfig + environment loading');
  lines.push('  errors.ts           # typed AppError classes');
  lines.push('  analysis.ts         # analysis layer (pure functions)');
  lines.push('  decisions.ts        # decision layer (pure functions)');
  lines.push('  integration.ts      # outbound integration (HTTP/ERP)');
  lines.push('tests/');
  lines.push('  analysis.test.ts');
  lines.push('  decisions.test.ts');
  lines.push('```');
  lines.push('');
  lines.push('Do not invent fields the Brief does not mention. When in doubt, prefer the smallest-scope change that satisfies the brief.');
  lines.push('');
  return lines.join('\n');
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

  // ADR-PIPELINE-100 §D4: phase-aware ADR path injection.
  // Reference each governing ADR by its on-disk path so the downstream code
  // generator reads source-of-truth instead of a paraphrased summary. We
  // partition ADRs into:
  //   - layer-specific: ADRs whose phaseTags overlap this layer's name OR
  //     legacy ADRs without phaseTags (defaulted into the layer assigned by
  //     generatePrompts' keyword-overlap heuristic — same behaviour as before)
  //   - cross-cutting: ADRs explicitly tagged 'cross-cutting' apply to every
  //     layer and surface in their own section so they aren't lost
  const layerNameTokens = layer.name.toLowerCase().split(/[-_\s]+/).filter(t => t.length > 2);
  const layerSpecificAdrs = layer.adrs.filter(a => !(a.phaseTags ?? []).includes('cross-cutting'));
  const crossCuttingAdrs = layer.adrs.filter(a => (a.phaseTags ?? []).includes('cross-cutting'));

  if (layerSpecificAdrs.length > 0) {
    lines.push(`## Architecture Decisions Governing This Layer (${layerSpecificAdrs.length} ADRs)`);
    lines.push('');
    lines.push(`The implementation must satisfy these decisions. **Read each ADR file in full before writing code.** Do NOT paraphrase from this prompt — open the file at the listed path and follow its decision section, alternatives rationale, and consequences exactly.`);
    lines.push('');
    for (const adr of layerSpecificAdrs) {
      const tagBadge = (adr.phaseTags ?? []).length > 0
        ? ` [phase: ${(adr.phaseTags ?? []).join(', ')}]`
        : '';
      if (adr.filePath) {
        lines.push(`- **${adr.id}: ${adr.title}**${tagBadge}`);
        lines.push(`  Source: \`${adr.filePath}\` — read sections: Decision, Alternatives Considered, Consequences`);
      } else {
        // Legacy fallback: ADR has no on-disk filePath. Inline a one-line
        // hook so the prompt still names the decision; downstream code
        // generation will be weaker without the file but at least won't be
        // missing the ADR entirely.
        lines.push(`- **${adr.id}: ${adr.title}**${tagBadge} (no source file resolved — see plans/adrs/ or phase4/adrs/)`);
        if (adr.decision) {
          lines.push(`  Decision summary: ${adr.decision.slice(0, 240)}${adr.decision.length > 240 ? '…' : ''}`);
        }
      }
    }
    lines.push('');
    if (layerNameTokens.length > 0) {
      // Surface the layer name tokens used for phase matching so the prompt
      // is self-explanatory when a reader wonders why these ADRs (and not
      // others) are in scope here.
      lines.push(`> Phase-match tokens: ${layerNameTokens.join(', ')} (ADR-PIPELINE-100 §D4)`);
      lines.push('');
    }
  }

  if (crossCuttingAdrs.length > 0) {
    lines.push(`## Cross-Cutting Decisions (apply across all layers)`);
    lines.push('');
    lines.push(`These ADRs apply to every implementation step regardless of layer. Read them once and follow them throughout.`);
    lines.push('');
    for (const adr of crossCuttingAdrs) {
      if (adr.filePath) {
        lines.push(`- **${adr.id}: ${adr.title}** — \`${adr.filePath}\``);
      } else {
        lines.push(`- **${adr.id}: ${adr.title}** (no source file resolved)`);
      }
    }
    lines.push('');
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
