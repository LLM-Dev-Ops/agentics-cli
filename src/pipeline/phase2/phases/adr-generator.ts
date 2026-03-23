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
  Phase2ServiceDefinition,
  ResearchDossier,
} from '../types.js';
import { createSpan, endSpan, emitSpan } from '../telemetry.js';
import { createClaudeCodeRunner } from '../../../runtime/claude-code-runner.js';
import { detectTechnologyStack, writeTechStack, formatERPContextForPrompt } from './tech-stack-detector.js';

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const ADR_SUBDIR = 'adrs';

/**
 * Load agentics fleet report from phase2Dir and format for LLM context.
 */
function loadAgenticsFleetContextForADR(phase2Dir: string): string {
  try {
    const reportPath = path.join(phase2Dir, 'agentics-agents-report.json');
    if (!fs.existsSync(reportPath)) return '';
    const report = JSON.parse(fs.readFileSync(reportPath, 'utf-8')) as {
      results?: Array<{ domain: string; agent: string; role: string; status: number; response: unknown }>;
    };
    if (!report.results || report.results.length === 0) return '';
    const successResults = report.results.filter(r => r.status === 200);
    if (successResults.length === 0) return '';
    const summaries = successResults.slice(0, 12).map(r => {
      const resp = r.response as Record<string, unknown> | undefined;
      const data = resp?.['data'] as Record<string, unknown> | undefined;
      let finding = '';
      if (data) {
        const vals = Object.values(data).filter(v => typeof v === 'string').slice(0, 2);
        finding = vals.map(v => String(v).slice(0, 100)).join('; ');
      }
      return `- [${r.domain}/${r.agent}] ${r.role}: ${finding || 'completed'}`;
    }).join('\n');
    return `\nAGENTICS FLEET ANALYSIS (${successResults.length} agents):\n${summaries}\n`;
  } catch { return ''; }
}

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

/**
 * Normalize a loosely-typed SPARC object (e.g. loaded from disk with unknown
 * key shapes) into the arrays that ADR generation needs.
 */
function normalizeSPARCForADR(sparc: Phase2SPARCOutput): {
  services: Phase2ServiceDefinition[];
  securityItems: ReadonlyArray<{ id: string; text: string; dossierItemRefs: string[] }>;
  perfItems: ReadonlyArray<{ id: string; text: string; dossierItemRefs: string[] }>;
  integrationPlan: string;
} {
  // Services: may be on architecture.services or architecture.components or top-level services
  const raw = sparc as unknown as Record<string, unknown>;
  const arch = (raw.architecture ?? {}) as Record<string, unknown>;
  let services: Phase2ServiceDefinition[] = [];

  const candidateServices = arch.services ?? arch.components ?? arch.modules ?? raw.services;
  if (Array.isArray(candidateServices)) {
    services = candidateServices.map((s: Record<string, unknown>, i: number) => ({
      id: String(s.id ?? `SVC-${String(i + 1).padStart(3, '0')}`),
      name: String(s.name ?? s.label ?? `Service${i + 1}`),
      responsibility: String(s.responsibility ?? s.description ?? s.purpose ?? ''),
      api: Array.isArray(s.api) ? s.api.map(String) : Array.isArray(s.endpoints) ? s.endpoints.map(String) : [],
      dependencies: Array.isArray(s.dependencies) ? s.dependencies.map(String) : Array.isArray(s.deps) ? s.deps.map(String) : [],
      dossierItemRefs: Array.isArray(s.dossierItemRefs) ? s.dossierItemRefs.map(String) : [],
    }));
  }

  // Security: may be array of objects or array of strings
  const ref = (raw.refinement ?? {}) as Record<string, unknown>;
  let securityItems: Array<{ id: string; text: string; dossierItemRefs: string[] }> = [];
  const rawSec = ref.securityConsiderations ?? ref.security ?? [];
  if (Array.isArray(rawSec)) {
    securityItems = rawSec.map((item: unknown, i: number) => {
      if (typeof item === 'string') return { id: `sec-${i + 1}`, text: item, dossierItemRefs: [] };
      const obj = item as Record<string, unknown>;
      return { id: String(obj.id ?? `sec-${i + 1}`), text: String(obj.text ?? obj.description ?? obj.name ?? ''), dossierItemRefs: [] };
    });
  }

  // Performance: may be array of objects or array of strings
  let perfItems: Array<{ id: string; text: string; dossierItemRefs: string[] }> = [];
  const rawPerf = ref.performanceTargets ?? ref.performance ?? [];
  if (Array.isArray(rawPerf)) {
    perfItems = rawPerf.map((item: unknown, i: number) => {
      if (typeof item === 'string') return { id: `perf-${i + 1}`, text: item, dossierItemRefs: [] };
      const obj = item as Record<string, unknown>;
      return { id: String(obj.id ?? `perf-${i + 1}`), text: String(obj.text ?? obj.description ?? obj.target ?? ''), dossierItemRefs: [] };
    });
  }

  const comp = (raw.completion ?? {}) as Record<string, unknown>;
  const integrationPlan = typeof comp.integrationPlan === 'string' ? comp.integrationPlan : '';

  return { services, securityItems, perfItems, integrationPlan };
}

function buildADRsFromSPARC(sparc: Phase2SPARCOutput, dossier: ResearchDossier): Phase2ADRRecord[] {
  const adrs: Phase2ADRRecord[] = [];
  let idx = 1;
  const today = new Date().toISOString().slice(0, 10);

  const { services, securityItems, perfItems } = normalizeSPARCForADR(sparc);

  // 1. Service boundary ADRs (generate for any service with deps, or the first 3 services if none have deps)
  const svcWithDeps = services.filter(s => s.dependencies.length > 0);
  const svcForADRs = svcWithDeps.length > 0 ? svcWithDeps : services.slice(0, 3);
  for (const svc of svcForADRs) {
    const depsText = svc.dependencies.length > 0
      ? `depends on: ${svc.dependencies.join(', ')}`
      : `is a standalone service`;
    adrs.push({
      id: `ADR-P2-${pad3(idx++)}`,
      title: `${svc.name} Service Boundary`,
      status: 'proposed',
      date: today,
      context: `The ${svc.name} service (${svc.responsibility || 'core functionality'}) ${depsText}.`,
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
// ADR-027: LLM-Generated Architecture Decision Records
// ============================================================================

/**
 * Generate domain-specific ADRs using Claude instead of generic boilerplate.
 * Returns enriched ADR array, or null if LLM is unavailable.
 */
function tryGenerateLLMADRs(
  sparc: Phase2SPARCOutput,
  dossier: ResearchDossier,
  query: string,
  phase2Dir = '',
): Phase2ADRRecord[] | null {
  try {
    const runner = createClaudeCodeRunner();

    const services = sparc.architecture?.services ?? [];
    const serviceList = services.map(s =>
      `- ${s.name}: ${s.responsibility.slice(0, 100)} (deps: ${s.dependencies.join(', ') || 'none'})`
    ).join('\n');

    const dossierContext = dossier.items
      .filter(i => ['requirement', 'constraint', 'risk', 'decision-rationale'].includes(i.category))
      .slice(0, 20)
      .map(i => `- [${i.category}] ${i.title}: ${i.content.slice(0, 120)}`)
      .join('\n');

    // ADR-027: Include agentics fleet analysis from 110 agents
    const agentContext = phase2Dir ? loadAgenticsFleetContextForADR(phase2Dir) : '';

    // ADR-029: Use shared tech stack detector instead of inline patterns
    const dossierText = dossier.items.map(i => i.content).join(' ');
    const techStack = detectTechnologyStack(query, dossierText);
    const techMentions: string[] = [];
    if (techStack.erp) techMentions.push(techStack.erp.name);
    if (techStack.cloud) techMentions.push(techStack.cloud.toUpperCase());
    if (techStack.database) techMentions.push(techStack.database);
    if (techStack.messageQueue) techMentions.push(techStack.messageQueue);
    if (techStack.searchEngine) techMentions.push(techStack.searchEngine);
    if (techStack.cacheLayer) techMentions.push(techStack.cacheLayer);

    // Build ERP-specific API context for the prompt
    const erpPromptContext = techStack.erp
      ? `\nERP API DETAILS (use these EXACT paths):\n${formatERPContextForPrompt(techStack.erp)}\n`
      : '';

    const prompt =
      `You are a senior solution architect writing Architecture Decision Records for: ${query}\n` +
      `\nSERVICES:\n${serviceList}\n` +
      `\nRESEARCH FINDINGS:\n${dossierContext}\n` +
      (agentContext ? agentContext + '\n' : '') +
      `\nDETECTED TECHNOLOGIES: ${techMentions.join(', ') || 'not specified'}\n` +
      erpPromptContext +
      `\nWrite 5-8 ADRs as a JSON array. Each ADR must be SPECIFIC to this domain and technology stack.\n` +
      `\nRequired ADR topics:\n` +
      `1. Data persistence strategy — which database(s) for which contexts, with domain-specific rationale\n` +
      `2. Integration pattern for the primary external system (${techMentions[0] || 'ERP'}) — actual API approach, not generic "adapter pattern"\n` +
      `3. Domain-specific architecture choice (e.g., event sourcing for audit trail, CQRS for read-heavy analytics)\n` +
      `4. Security architecture — domain-specific auth requirements (e.g., role-based trading limits, HIPAA PHI access)\n` +
      `5. Real-time vs batch processing — which data flows need real-time and why\n` +
      `\nReturn JSON array:\n` +
      `[\n` +
      `  {\n` +
      `    "title": "Domain-specific decision title",\n` +
      `    "context": "Why this decision matters for THIS domain",\n` +
      `    "decision": "The specific technology/pattern choice with rationale",\n` +
      `    "alternatives": [{"option": "Name", "rationale": "Why considered", "rejected": true/false}],\n` +
      `    "consequences": [{"description": "Impact", "type": "positive|negative|neutral"}]\n` +
      `  }\n` +
      `]\n` +
      `\nCRITICAL: Every ADR must reference the ACTUAL domain (${query.slice(0, 50)}) and technologies (${techMentions.join(', ')}). No generic "adapter pattern" or "defense-in-depth" without domain context.`;

    const result = runner.invoke<Record<string, unknown>>(prompt, {
      runId: `adr-llm-${Date.now()}`,
      timeoutMs: 180_000,
    });

    const data = result.data as Record<string, unknown>;
    let rawAdrs: Array<Record<string, unknown>> | undefined;

    if (Array.isArray(data)) {
      rawAdrs = data as Array<Record<string, unknown>>;
    } else if (typeof data.content === 'string') {
      try {
        const parsed = JSON.parse(data.content);
        if (Array.isArray(parsed)) rawAdrs = parsed;
      } catch { /* not JSON */ }
    }

    if (!rawAdrs || rawAdrs.length === 0) {
      process.stderr.write('[adr-generator] LLM ADRs: no decisions in response\n');
      return null;
    }

    const today = new Date().toISOString().slice(0, 10);
    const adrs: Phase2ADRRecord[] = rawAdrs.map((raw, idx) => {
      const alts = Array.isArray(raw.alternatives)
        ? (raw.alternatives as Array<{ option?: string; rationale?: string; rejected?: boolean }>).map(a =>
          makeAlt(String(a.option || ''), String(a.rationale || ''), !!a.rejected))
        : [makeAlt('Selected approach', String(raw.decision || ''), false)];

      const cons = Array.isArray(raw.consequences)
        ? (raw.consequences as Array<{ description?: string; type?: string }>).map(c =>
          makeCons(String(c.description || ''), (c.type || 'neutral') as 'positive' | 'negative' | 'neutral'))
        : [makeCons('Decision applied', 'neutral')];

      return {
        id: `ADR-P2-${pad3(idx + 1)}`,
        title: String(raw.title || `Decision ${idx + 1}`),
        status: 'proposed' as const,
        date: today,
        context: String(raw.context || ''),
        decision: String(raw.decision || ''),
        alternatives: alts,
        consequences: cons,
        sparcSectionRefs: [] as string[],
        researchDossierItemRefs: findDossierRefs(dossier, [
          String(raw.title || '').toLowerCase(),
        ]),
      };
    });

    process.stderr.write(
      `[adr-generator] LLM-generated ${adrs.length} domain-specific ADRs in ${result.durationMs}ms\n`
    );
    return adrs;
  } catch (err: unknown) {
    process.stderr.write(
      `[adr-generator] LLM ADR generation failed: ${err instanceof Error ? err.message : String(err)}\n`
    );
    return null;
  }
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

    // ADR-027: Try LLM-generated domain-specific ADRs first, fall back to template
    const query = context.phase1Artifacts?.scenario?.query
      ?? (context.phase1Artifacts?.manifest as unknown as Record<string, unknown>)?.['query'] as string
      ?? '';

    // ADR-029: Detect and persist tech stack so downstream phases use the same ERP
    const dossierText = dossier.items.map(i => i.content).join(' ');
    const techStack = detectTechnologyStack(query, dossierText);
    writeTechStack(techStack, context.phase2Dir);
    if (techStack.erp) {
      process.stderr.write(`[adr-generator] Detected ERP: ${techStack.erp.name} (${techStack.erp.slug})\n`);
    }

    const adrs = (query ? tryGenerateLLMADRs(sparc, dossier, query, context.phase2Dir) : null)
      ?? buildADRsFromSPARC(sparc, dossier);

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
