/**
 * Phase 2 Pipeline — Stage 5: DDD Model Generator
 *
 * Generates a Domain-Driven Design model as markdown + JSON, driven by the
 * SPARC architecture output, ADRs, and research dossier.
 *
 * Produces bounded contexts (one per architecture service), a context map,
 * and a ubiquitous language glossary — all derived from actual SPARC/dossier
 * content rather than noun-extraction heuristics.
 *
 * Primary output: DDD markdown documents
 * Compat output: domain-model.json, context-map.json for downstream consumers
 *
 * Error codes:
 *   ECLI-P2-010  Missing prerequisite stage output (SPARC or ADR)
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import type {
  Phase2Context,
  Phase2StageOutput,
  Phase2SPARCOutput,
  Phase2ADRRecord,
  ResearchDossier,
  Phase2DomainModel,
  Phase2DDDBoundedContext,
  Phase2AggregateDefinition,
  Phase2Entity,
  Phase2DomainEvent,
  Phase2Command,
  Phase2Query,
  UbiquitousLanguageTerm,
  Phase2ContextRelation,
} from '../types.js';
import { createSpan, endSpan, emitSpan } from '../telemetry.js';

// ============================================================================
// Constants
// ============================================================================

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const JSON_INDENT = 2;

function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function pascalCase(text: string): string {
  return text
    .replace(/[-_\s]+(.)?/g, (_, c: string | undefined) => (c ? c.toUpperCase() : ''))
    .replace(/^(.)/, (_, c: string) => c.toUpperCase());
}

/**
 * Convert an API string like "POST /vendor/create-vendor" into a
 * domain command name like "CreateVendor".
 *
 * Strategy: strip HTTP method and path prefix, extract the action
 * slug (e.g. "create-vendor"), and PascalCase it.
 */
function toCommandName(apiMethod: string, contextName: string): string {
  // Strip leading HTTP method (POST, PUT, PATCH, DELETE)
  const withoutMethod = apiMethod.replace(/^\s*(POST|PUT|PATCH|DELETE)\s+/i, '');
  // Extract the last path segment (the action: "create-vendor", "update-payment")
  const segments = withoutMethod.split('/').filter(Boolean);
  const action = segments[segments.length - 1] ?? '';
  const cleaned = action.replace(/[^a-zA-Z0-9-]/g, '');
  if (!cleaned) return `Execute${contextName}`;
  return pascalCase(cleaned);
}

/**
 * Convert an API string like "GET /vendor" or "GET /vendor:id" into a
 * domain query name like "GetVendor" or "GetVendorById".
 */
function toQueryName(apiMethod: string, contextName: string): string {
  const withoutMethod = apiMethod.replace(/^\s*(GET)\s+/i, '');
  const segments = withoutMethod.split('/').filter(Boolean);
  const last = segments[segments.length - 1] ?? '';
  // Handle ":id" or "{id}" parameter patterns
  if (last.includes(':id') || last.includes('{id}')) {
    return `Get${contextName}ById`;
  }
  // If the last segment is just the context name, it's a list query
  const cleaned = last.replace(/[^a-zA-Z0-9-]/g, '');
  if (!cleaned || slugify(cleaned) === slugify(contextName)) {
    return `List${contextName}`;
  }
  return `Get${pascalCase(cleaned)}`;
}

// ============================================================================
// API Signature Parser (used by domain-codegen downstream)
// ============================================================================

export interface ParsedApiMethod {
  methodName: string;
  params: Array<{ name: string; type: string }>;
  returnType: string | null;
}

export function parseApiSignature(api: string): ParsedApiMethod | null {
  const match = api.match(/^(\w+)\(([^)]*)\)(?:\s*:\s*([\w\[\]<>,|\s]+))?/);
  if (!match) return null;

  const methodName = match[1]!;
  const paramStr = match[2] ?? '';
  const returnType = match[3]?.trim() ?? null;

  const params: Array<{ name: string; type: string }> = [];
  if (paramStr.trim().length > 0) {
    for (const segment of paramStr.split(',')) {
      const parts = segment.trim().split(/\s*:\s*/);
      const name = parts[0]?.trim() ?? '';
      const type = parts[1]?.trim() ?? '';
      if (name && type) {
        params.push({ name, type });
      }
    }
  }

  return { methodName, params, returnType };
}

// ============================================================================
// DDD Markdown Generator
// ============================================================================

function writeDDDMarkdown(model: Phase2DomainModel, sparc: Phase2SPARCOutput): string {
  const lines: string[] = [];

  lines.push('# Domain-Driven Design Model');
  lines.push('');
  lines.push(`Generated from SPARC architecture with ${sparc.architecture?.services?.length ?? 0} services.`);
  lines.push('');

  // Bounded Contexts
  lines.push('## Bounded Contexts');
  lines.push('');
  for (const ctx of model.contexts) {
    lines.push(`### ${ctx.name}`);
    lines.push(`> ${ctx.description}`);
    lines.push('');

    if (ctx.aggregates.length > 0) {
      lines.push('#### Aggregates');
      for (const agg of ctx.aggregates) {
        lines.push(`- **${agg.name}** (root: ${agg.root})`);
        if (agg.entities.length > 0) {
          for (const e of agg.entities) {
            lines.push(`  - Entity: ${e.name} — ${e.description ?? ''}`);
          }
        }
        if (agg.valueObjects.length > 0) {
          for (const vo of agg.valueObjects) {
            lines.push(`  - Value Object: ${vo.name}`);
          }
        }
        if (agg.invariants && agg.invariants.length > 0) {
          lines.push('  - Invariants:');
          for (const inv of agg.invariants) {
            lines.push(`    - ${inv}`);
          }
        }
      }
      lines.push('');
    }

    if (ctx.commands.length > 0) {
      lines.push('#### Commands');
      for (const cmd of ctx.commands) {
        lines.push(`- **${cmd.name}**: ${cmd.description ?? ''}`);
      }
      lines.push('');
    }

    if (ctx.queries.length > 0) {
      lines.push('#### Queries');
      for (const q of ctx.queries) {
        lines.push(`- **${q.name}**: returns ${q.returns ?? 'data'}`);
      }
      lines.push('');
    }

    if (ctx.domainEvents.length > 0) {
      lines.push('#### Domain Events');
      for (const evt of ctx.domainEvents) {
        lines.push(`- **${evt.name}**: ${evt.description ?? `triggered by ${evt.triggeredBy ?? 'command'}`}`);
      }
      lines.push('');
    }
  }

  // Context Map
  lines.push('## Context Map');
  lines.push('');
  if (model.contextMap.length > 0) {
    lines.push('| Upstream | Downstream | Relationship | Description |');
    lines.push('|----------|------------|-------------|-------------|');
    for (const rel of model.contextMap) {
      lines.push(`| ${rel.upstream} | ${rel.downstream} | ${rel.type} | ${rel.description ?? ''} |`);
    }
  } else {
    lines.push('No inter-context relationships (single bounded context).');
  }
  lines.push('');

  // Ubiquitous Language
  if (model.ubiquitousLanguageGlossary.length > 0) {
    lines.push('## Ubiquitous Language');
    lines.push('');
    lines.push('| Term | Definition | Context |');
    lines.push('|------|-----------|---------|');
    for (const term of model.ubiquitousLanguageGlossary) {
      lines.push(`| ${term.term} | ${term.definition} | ${term.context} |`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

// ============================================================================
// DDD Model Builder — derived from SPARC + dossier
// ============================================================================

export function buildPhase2DDD(
  sparc: Phase2SPARCOutput,
  adrs: Phase2ADRRecord[],
  dossier: ResearchDossier,
): Phase2DomainModel {
  const services = sparc.architecture?.services ?? [];
  const glossary: UbiquitousLanguageTerm[] = [];

  // Build bounded contexts from services
  const contexts: Phase2DDDBoundedContext[] = services.map((svc) => {
    const svcName = pascalCase(svc.name);

    // Aggregate from service
    const rootEntity: Phase2Entity = {
      name: svcName,
      description: svc.responsibility,
    };

    const aggregate: Phase2AggregateDefinition = {
      name: `${svcName}Aggregate`,
      root: svcName,
      entities: [rootEntity],
      valueObjects: [],
      invariants: [`${svcName} must be in a valid state`],
    };

    // Commands from non-GET APIs
    const commands: Phase2Command[] = svc.api
      .filter(a => !a.toLowerCase().startsWith('get'))
      .map(apiMethod => ({
        name: toCommandName(apiMethod, svcName),
        description: `${apiMethod} for ${svc.name}`,
        input: ['requestPayload'],
        preconditions: [`${svc.name} is accessible`],
        postconditions: [`${toCommandName(apiMethod, svcName)} completes successfully`],
      }));

    // Queries from GET APIs
    const queries: Phase2Query[] = svc.api
      .filter(a => a.toLowerCase().startsWith('get') || a.toLowerCase().includes('get'))
      .map(apiMethod => ({
        name: toQueryName(apiMethod, svcName),
        description: `${apiMethod} for ${svc.name}`,
        parameters: ['filters'],
        returns: `${svcName}Response`,
      }));

    // Domain events from commands
    const domainEvents: Phase2DomainEvent[] = commands.flatMap(cmd => [
      {
        name: `${cmd.name}Succeeded`,
        description: `Emitted when ${cmd.name} completes successfully`,
        payload: ['result'],
        triggeredBy: cmd.name,
      },
      {
        name: `${cmd.name}Failed`,
        description: `Emitted when ${cmd.name} fails`,
        payload: ['error'],
        triggeredBy: cmd.name,
      },
    ]);

    // Add to glossary
    glossary.push({
      term: svcName,
      definition: svc.responsibility,
      context: svc.name,
      aliases: [svc.name],
    });

    // ADR refs
    const adrRefs = adrs
      .filter(a => a.title.toLowerCase().includes(svc.name.toLowerCase()) || a.context.toLowerCase().includes(svc.name.toLowerCase()))
      .map(a => a.id);

    return {
      name: svc.name,
      description: svc.responsibility,
      aggregates: [aggregate],
      domainEvents,
      commands,
      queries,
      ubiquitousLanguage: [],
      adrRefs,
    };
  });

  // Context map from service dependencies
  const contextMap: Phase2ContextRelation[] = services.flatMap(svc =>
    svc.dependencies
      .filter(dep => services.some(s => s.name === dep))
      .map(dep => ({
        upstream: dep,
        downstream: svc.name,
        type: 'customer-supplier' as const,
        description: `${svc.name} depends on ${dep}`,
      })),
  );

  // Add dossier-derived glossary terms
  const dossierTerms = new Set<string>();
  for (const item of dossier.items) {
    if (item.category === 'requirement' || item.category === 'recommendation') {
      // Extract key term from title
      const term = item.title.split(/[:\-–]/)[0]?.trim();
      if (term && term.length > 2 && term.length < 40 && !dossierTerms.has(term.toLowerCase())) {
        dossierTerms.add(term.toLowerCase());
        glossary.push({
          term,
          definition: item.content.slice(0, 120),
          context: item.source,
          aliases: [],
        });
      }
    }
  }

  return {
    contexts,
    contextMap,
    ubiquitousLanguageGlossary: glossary,
  };
}

// ============================================================================
// Public: Main Stage Function
// ============================================================================

export async function generateDDDModel(
  context: Phase2Context,
): Promise<Phase2StageOutput> {
  const rootSpan = createSpan('ddd-generation', 'generate-ddd-model', {
    phase2Dir: context.phase2Dir,
  });

  try {
    // Retrieve prerequisites
    const sparcOutput = context.stageOutputs.get('sparc-specification');
    if (!sparcOutput || sparcOutput.status !== 'completed') {
      throw new Error('ECLI-P2-010: Missing prerequisite: sparc-specification must complete before ddd-generation');
    }

    const adrOutput = context.stageOutputs.get('adr-generation');
    if (!adrOutput || adrOutput.status !== 'completed') {
      throw new Error('ECLI-P2-010: Missing prerequisite: adr-generation must complete before ddd-generation');
    }

    const dossierOutput = context.stageOutputs.get('research-dossier');
    if (!dossierOutput || dossierOutput.status !== 'completed') {
      throw new Error('ECLI-P2-010: Missing prerequisite: research-dossier must complete before ddd-generation');
    }

    const sparc = sparcOutput.data as Phase2SPARCOutput;
    const adrs = (adrOutput.data as { adrs: Phase2ADRRecord[] }).adrs ?? (adrOutput.data as Phase2ADRRecord[]);
    const dossier = dossierOutput.data as ResearchDossier;

    // Build domain model
    const domainModel = buildPhase2DDD(sparc, Array.isArray(adrs) ? adrs : [], dossier);

    // Generate markdown
    const dddMarkdown = writeDDDMarkdown(domainModel, sparc);

    // Write artifacts
    const dddDir = path.join(context.phase2Dir, 'ddd');
    const contextsDir = path.join(dddDir, 'contexts');
    fs.mkdirSync(dddDir, { recursive: true, mode: DIR_MODE });
    fs.mkdirSync(contextsDir, { recursive: true, mode: DIR_MODE });

    const artifactPaths: string[] = [];

    // Primary: DDD markdown
    const mdPath = path.join(dddDir, 'DDD-Model.md');
    fs.writeFileSync(mdPath, dddMarkdown + '\n', { encoding: 'utf-8', mode: FILE_MODE });
    artifactPaths.push(mdPath);

    // JSON compat files
    const domainModelPath = path.join(dddDir, 'domain-model.json');
    fs.writeFileSync(domainModelPath, JSON.stringify(domainModel, null, JSON_INDENT), { encoding: 'utf-8', mode: FILE_MODE });
    artifactPaths.push(domainModelPath);

    const contextMapPath = path.join(dddDir, 'context-map.json');
    fs.writeFileSync(contextMapPath, JSON.stringify(domainModel.contextMap, null, JSON_INDENT), { encoding: 'utf-8', mode: FILE_MODE });
    artifactPaths.push(contextMapPath);

    const glossaryPath = path.join(dddDir, 'ubiquitous-language.json');
    fs.writeFileSync(glossaryPath, JSON.stringify(domainModel.ubiquitousLanguageGlossary, null, JSON_INDENT), { encoding: 'utf-8', mode: FILE_MODE });
    artifactPaths.push(glossaryPath);

    // Per-context files
    for (const ctx of domainModel.contexts) {
      const contextSlug = slugify(ctx.name);
      const contextPath = path.join(contextsDir, `${contextSlug}.json`);
      fs.writeFileSync(contextPath, JSON.stringify(ctx, null, JSON_INDENT), { encoding: 'utf-8', mode: FILE_MODE });
      artifactPaths.push(contextPath);
    }

    endSpan(rootSpan, 'ok', {
      contextsGenerated: domainModel.contexts.length,
      relationsGenerated: domainModel.contextMap.length,
      glossaryTerms: domainModel.ubiquitousLanguageGlossary.length,
    });
    emitSpan(rootSpan);

    const timing = rootSpan.durationMs ?? 0;

    const output: Phase2StageOutput = {
      stage: 'ddd-generation',
      status: 'completed',
      data: domainModel,
      artifacts: artifactPaths,
      timing,
      summary: `     DDD: ${domainModel.contexts.length} bounded contexts, ${domainModel.contextMap.length} relations, ${domainModel.ubiquitousLanguageGlossary.length} glossary terms`,
    };

    context.stageOutputs.set('ddd-generation', output);
    return output;
  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : String(err);

    endSpan(rootSpan, 'error', { error: errorMessage });
    emitSpan(rootSpan);

    const timing = rootSpan.durationMs ?? 0;

    const output: Phase2StageOutput = {
      stage: 'ddd-generation',
      status: 'failed',
      data: { error: errorMessage },
      artifacts: [],
      timing,
      summary: `DDD generation failed: ${errorMessage}`,
    };

    context.stageOutputs.set('ddd-generation', output);
    return output;
  }
}
