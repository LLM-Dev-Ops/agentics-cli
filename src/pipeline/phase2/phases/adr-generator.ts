/**
 * Phase 2 Pipeline -- Stage 4: ADR Generator
 *
 * Generates Architecture Decision Records as markdown documents driven by
 * the SPARC specification and research dossier. ADRs are derived from actual
 * architectural decisions implied by the SPARC output.
 *
 * Primary output: ADR markdown files (one per decision)
 * Compat output: adr-index.json for downstream consumers
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import type {
  Phase2Context,
  Phase2StageOutput,
  Phase2SPARCOutput,
  Phase2ADRRecord,
  Phase2ADRAlternative,
  Phase2ADRConsequence,
  ResearchDossier,
} from '../types.js';
import { createSpan, endSpan, emitSpan } from '../telemetry.js';

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const ADR_SUBDIR = 'adrs';

function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function pad3(n: number): string {
  return String(n).padStart(3, '0');
}

function findDossierRefs(dossier: ResearchDossier, keywords: readonly string[]): string[] {
  const refs: string[] = [];
  for (const item of dossier.items) {
    const text = `${item.title} ${item.content}`.toLowerCase();
    if (keywords.some(kw => text.includes(kw.toLowerCase()))) {
      refs.push(item.id);
    }
  }
  return refs;
}

// ============================================================================
// ADR Markdown Renderer
// ============================================================================

function renderADRMarkdown(adr: Phase2ADRRecord): string {
  const lines: string[] = [];
  lines.push(`# ${adr.id}: ${adr.title}`);
  lines.push('');
  lines.push(`**Status:** ${adr.status}`);
  lines.push(`**Date:** ${adr.date}`);
  lines.push('');
  lines.push('## Context');
  lines.push(adr.context);
  lines.push('');
  lines.push('## Decision');
  lines.push(adr.decision);
  lines.push('');

  if (adr.alternatives.length > 0) {
    lines.push('## Alternatives Considered');
    for (const alt of adr.alternatives) {
      const status = alt.rejected ? '(rejected)' : '(selected)';
      lines.push(`- **${alt.option}** ${status}: ${alt.rationale}`);
    }
    lines.push('');
  }

  if (adr.consequences.length > 0) {
    lines.push('## Consequences');
    for (const c of adr.consequences) {
      const icon = c.type === 'positive' ? '+' : c.type === 'negative' ? '-' : '~';
      lines.push(`- [${icon}] ${c.description}`);
    }
    lines.push('');
  }

  if (adr.researchDossierItemRefs.length > 0) {
    lines.push('## References');
    lines.push(`Dossier items: ${adr.researchDossierItemRefs.join(', ')}`);
    lines.push('');
  }

  return lines.join('\n');
}

// ============================================================================
// ADR Builder — derived from SPARC + dossier
// ============================================================================

function makeAlt(option: string, rationale: string, rejected: boolean): Phase2ADRAlternative {
  return { option, rationale, rejected };
}

function makeCons(description: string, type: 'positive' | 'negative' | 'neutral'): Phase2ADRConsequence {
  return { description, type };
}

function buildADRsFromSPARC(sparc: Phase2SPARCOutput, dossier: ResearchDossier): Phase2ADRRecord[] {
  const adrs: Phase2ADRRecord[] = [];
  let idx = 1;
  const today = new Date().toISOString().slice(0, 10);

  const services = sparc.architecture?.services ?? [];
  const securityItems = sparc.refinement?.securityConsiderations ?? [];
  const perfItems = sparc.refinement?.performanceTargets ?? [];

  // 1. Service boundary ADRs
  for (const svc of services) {
    if (svc.dependencies.length === 0) continue;
    adrs.push({
      id: `ADR-P2-${pad3(idx++)}`,
      title: `${svc.name} Service Boundary`,
      status: 'proposed',
      date: today,
      context: `The ${svc.name} service (${svc.responsibility}) depends on: ${svc.dependencies.join(', ')}.`,
      decision: `Use adapter pattern for ${svc.name} with circuit breaker and retry logic per dependency.`,
      alternatives: [
        makeAlt('Adapter pattern', 'Clean separation, mockable boundaries', false),
        makeAlt('Direct calls', 'Simpler but tight coupling', true),
        makeAlt('Message queue', 'Async but more infrastructure', true),
      ],
      consequences: [
        makeCons('Clean separation of concerns at service boundaries', 'positive'),
        makeCons('Each adapter independently mockable for TDD', 'positive'),
        makeCons('Additional adapter code per dependency', 'negative'),
      ],
      sparcSectionRefs: [`architecture.services.${svc.name}`],
      researchDossierItemRefs: findDossierRefs(dossier, [svc.name, ...svc.dependencies]),
    });
  }

  // 2. Security ADR
  if (securityItems.length > 0) {
    adrs.push({
      id: `ADR-P2-${pad3(idx++)}`,
      title: 'Security Architecture',
      status: 'proposed',
      date: today,
      context: `${securityItems.length} security considerations from SPARC refinement.`,
      decision: 'Defense-in-depth: auth at gateway, per-service authorization, encryption at rest and in transit.',
      alternatives: [
        makeAlt('Defense-in-depth', 'Strong posture across all layers', false),
        makeAlt('Perimeter-only', 'Simpler but single point of failure', true),
      ],
      consequences: [
        makeCons('Strong security posture', 'positive'),
        makeCons('Increased service configuration complexity', 'negative'),
      ],
      sparcSectionRefs: ['refinement.securityConsiderations'],
      researchDossierItemRefs: findDossierRefs(dossier, ['security', 'auth', 'access', 'encryption']),
    });
  }

  // 3. Performance ADR
  if (perfItems.length > 0) {
    adrs.push({
      id: `ADR-P2-${pad3(idx++)}`,
      title: 'Performance Architecture',
      status: 'proposed',
      date: today,
      context: `${perfItems.length} performance targets from SPARC refinement.`,
      decision: 'Caching at service boundaries, async for non-critical paths, connection pooling.',
      alternatives: [
        makeAlt('Caching + async', 'Meets performance targets', false),
        makeAlt('Synchronous everything', 'Simple but slow', true),
      ],
      consequences: [
        makeCons('Meets performance targets', 'positive'),
        makeCons('Cache invalidation complexity', 'negative'),
      ],
      sparcSectionRefs: ['refinement.performanceTargets'],
      researchDossierItemRefs: findDossierRefs(dossier, ['performance', 'latency', 'throughput']),
    });
  }

  // 4. High-severity risk ADRs
  const highRisks = dossier.items.filter(i => i.category === 'risk' && i.severity && /high|critical/i.test(i.severity));
  for (const risk of highRisks.slice(0, 3)) {
    adrs.push({
      id: `ADR-P2-${pad3(idx++)}`,
      title: `Risk Mitigation: ${risk.title.slice(0, 60)}`,
      status: 'proposed',
      date: today,
      context: risk.content,
      decision: `Mitigate through redundancy, monitoring, and graceful degradation.`,
      alternatives: [
        makeAlt('Active mitigation', 'Reduces impact', false),
        makeAlt('Accept risk', 'No cost but potential impact', true),
      ],
      consequences: [
        makeCons(`Risk "${risk.title.slice(0, 40)}" addressed`, 'positive'),
        makeCons('Additional design effort', 'negative'),
      ],
      sparcSectionRefs: [],
      researchDossierItemRefs: [risk.id],
    });
  }

  // 5. Compliance ADR
  const complianceRefs = findDossierRefs(dossier, ['compliance', 'regulatory', 'gdpr', 'hipaa', 'pci', 'privacy']);
  if (complianceRefs.length > 0) {
    adrs.push({
      id: `ADR-P2-${pad3(idx++)}`,
      title: 'Compliance and Regulatory Architecture',
      status: 'proposed',
      date: today,
      context: `${complianceRefs.length} compliance items in research dossier.`,
      decision: 'Audit logging at service boundaries, data classification, consent management, CI/CD compliance checks.',
      alternatives: [
        makeAlt('Automated compliance', 'Scales well', false),
        makeAlt('Manual compliance', 'Error-prone', true),
      ],
      consequences: [
        makeCons('Reduced audit burden', 'positive'),
        makeCons('Logging overhead', 'negative'),
      ],
      sparcSectionRefs: [],
      researchDossierItemRefs: complianceRefs,
    });
  }

  // 6. Data persistence ADR
  const dataRefs = findDossierRefs(dossier, ['data', 'database', 'storage', 'persistence']);
  if (dataRefs.length > 0) {
    adrs.push({
      id: `ADR-P2-${pad3(idx++)}`,
      title: 'Data Persistence Strategy',
      status: 'proposed',
      date: today,
      context: `${dataRefs.length} data-related items. Services need isolated data stores.`,
      decision: 'Each bounded context owns its data store. Event sourcing for audit-critical domains.',
      alternatives: [
        makeAlt('Context-owned stores', 'Strong isolation', false),
        makeAlt('Shared database', 'Simpler but coupling risk', true),
      ],
      consequences: [
        makeCons('Data isolation per bounded context', 'positive'),
        makeCons('Cross-context queries need API/events', 'negative'),
      ],
      sparcSectionRefs: ['architecture.services'],
      researchDossierItemRefs: dataRefs,
    });
  }

  // 7. Inter-service communication
  if (services.length > 1) {
    adrs.push({
      id: `ADR-P2-${pad3(idx++)}`,
      title: 'Inter-Service Communication Pattern',
      status: 'proposed',
      date: today,
      context: `${services.length} services need communication pattern.`,
      decision: 'Sync REST/gRPC for queries, async events for commands and domain events.',
      alternatives: [
        makeAlt('Hybrid sync+async', 'Balanced approach', false),
        makeAlt('All synchronous', 'Simple but cascading failures', true),
        makeAlt('All async', 'Loose coupling but complex debugging', true),
      ],
      consequences: [
        makeCons('Sync for reads, async for writes — balanced', 'positive'),
        makeCons('Need both REST and messaging infrastructure', 'negative'),
      ],
      sparcSectionRefs: ['architecture.dataFlow'],
      researchDossierItemRefs: [],
    });
  }

  // Fallback: at least one ADR
  if (adrs.length === 0) {
    adrs.push({
      id: 'ADR-P2-001',
      title: 'System Architecture Approach',
      status: 'proposed',
      date: today,
      context: 'Initial architecture decision based on SPARC specification.',
      decision: 'Build modular system with clear service boundaries, TDD, and iterative refinement.',
      alternatives: [
        makeAlt('Modular architecture', 'Follows SPARC methodology', false),
        makeAlt('Monolithic', 'Simpler but harder to scale', true),
      ],
      consequences: [makeCons('Clean architecture', 'positive')],
      sparcSectionRefs: [],
      researchDossierItemRefs: [],
    });
  }

  return adrs;
}

export function buildPhase2ADRs(sparc: Phase2SPARCOutput, dossier: ResearchDossier): Phase2ADRRecord[] {
  return buildADRsFromSPARC(sparc, dossier);
}

// ============================================================================
// Public: Main Stage Function
// ============================================================================

export async function generateADRs(context: Phase2Context): Promise<Phase2StageOutput> {
  const rootSpan = createSpan('adr-generation', 'generate-adrs', { phase2Dir: context.phase2Dir });

  try {
    const sparcStage = context.stageOutputs.get('sparc-specification');
    if (!sparcStage || sparcStage.status !== 'completed') {
      throw new Error('ECLI-P2-020: SPARC output not available.');
    }
    const sparc = sparcStage.data as Phase2SPARCOutput;

    const dossierStage = context.stageOutputs.get('research-dossier');
    if (!dossierStage || dossierStage.status !== 'completed') {
      throw new Error('ECLI-P2-020: Research dossier not available.');
    }
    const dossier = dossierStage.data as ResearchDossier;

    const adrs = buildADRsFromSPARC(sparc, dossier);

    const adrDir = path.join(context.phase2Dir, ADR_SUBDIR);
    fs.mkdirSync(adrDir, { recursive: true, mode: DIR_MODE });
    const writtenPaths: string[] = [];

    for (const adr of adrs) {
      const slug = slugify(adr.title);
      const filename = `${adr.id}-${slug}.md`;
      const filePath = path.join(adrDir, filename);
      const markdown = renderADRMarkdown(adr);
      fs.writeFileSync(filePath, markdown, { encoding: 'utf-8', mode: FILE_MODE });
      writtenPaths.push(filePath);
    }

    const indexPath = path.join(adrDir, 'adr-index.json');
    fs.writeFileSync(indexPath, JSON.stringify(adrs, null, 2) + '\n', { encoding: 'utf-8', mode: FILE_MODE });
    writtenPaths.push(indexPath);

    endSpan(rootSpan, 'ok', { adrCount: adrs.length });
    emitSpan(rootSpan);

    const timing = rootSpan.durationMs ?? 0;
    const output: Phase2StageOutput = {
      stage: 'adr-generation',
      status: 'completed',
      data: adrs,
      artifacts: writtenPaths,
      timing,
      summary: `     ADRs: ${adrs.length} decisions (${writtenPaths.length - 1} markdown + 1 JSON index)`,
    };

    context.stageOutputs.set('adr-generation', output);
    return output;
  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    endSpan(rootSpan, 'error', { error: errorMessage });
    emitSpan(rootSpan);

    const output: Phase2StageOutput = {
      stage: 'adr-generation',
      status: 'failed',
      data: { error: errorMessage },
      artifacts: [],
      timing: rootSpan.durationMs ?? 0,
      summary: `ADR generation failed: ${errorMessage}`,
    };
    context.stageOutputs.set('adr-generation', output);
    return output;
  }
}
