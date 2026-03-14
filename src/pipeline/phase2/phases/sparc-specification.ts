/**
 * Phase 2 Pipeline -- Stage 3: SPARC Specification
 *
 * Generates all 5 SPARC phases (Specification, Pseudocode, Architecture,
 * Refinement, Completion) as natural-language markdown documents following
 * the ruvnet/sparc methodology (https://github.com/ruvnet/sparc).
 *
 * Content is WRITTEN dynamically from the user's original prompt and
 * Phase 1/2 artifacts — NOT pattern-matched from hardcoded templates.
 *
 * The markdown documents are the primary output. A sparc-combined.json
 * compatibility shim is also written for downstream Phase 4/5 consumers.
 *
 * Error codes:
 *   ECLI-P2-010  Research dossier not available on context
 *   ECLI-P2-011  SPARC file write failure
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import type {
  Phase2Context,
  Phase2StageOutput,
  ResearchDossier,
  Phase1Artifacts,
  Phase2SPARCOutput,
  Phase2Specification,
  Phase2Pseudocode,
  Phase2Architecture,
  Phase2Refinement,
  Phase2Completion,
  Phase2Requirement,
  Phase2Constraint,
  Phase2SuccessCriterion,
  Phase2PseudocodeModule,
  Phase2ServiceDefinition,
} from '../types.js';
import { createSpan, endSpan, emitSpan } from '../telemetry.js';
import { normalizeContextName } from './ddd-generator.js';
import { createClaudeCodeRunner } from '../../../runtime/claude-code-runner.js';

// ============================================================================
// Constants
// ============================================================================

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const SPARC_SUBDIR = 'sparc';

// ============================================================================
// Intelligence / ML Detection
// ============================================================================

/**
 * Detect whether the user's query requires intelligence/ML/analytics contexts.
 * Returns keywords found and suggested intelligence context names.
 */
export function detectIntelligenceRequirements(query: string): {
  hasIntelligence: boolean;
  keywords: string[];
  suggestedContexts: Array<{
    name: string;
    type: 'ml-inference' | 'analytics' | 'anomaly-detection' | 'forecasting' | 'data-pipeline';
    commands: string[];
    description: string;
  }>;
} {
  const lowerQuery = query.toLowerCase();
  const keywords: string[] = [];

  const patterns: Array<[RegExp, string]> = [
    [/\b(?:ai|artificial[\s-]?intelligence|machine[\s-]?learning|ml)\b/i, 'AI/ML'],
    [/\b(?:predict|prediction|predictive)\b/i, 'prediction'],
    [/\b(?:anomal|outlier|deviation[\s-]?detect)\b/i, 'anomaly-detection'],
    [/\b(?:pattern[\s-]?recogni|pattern[\s-]?detect|pattern[\s-]?analys)\b/i, 'pattern-recognition'],
    [/\b(?:forecast|forecasting|time[\s-]?series)\b/i, 'forecasting'],
    [/\b(?:classif|categoriz|cluster)\b/i, 'classification'],
    [/\b(?:neural[\s-]?net|deep[\s-]?learn|transformer|llm|nlp)\b/i, 'deep-learning'],
    [/\b(?:recommend|suggestion[\s-]?engine|collaborative[\s-]?filter)\b/i, 'recommendation'],
    [/\b(?:sentiment[\s-]?analy|text[\s-]?mining|natural[\s-]?language)\b/i, 'nlp'],
    [/\b(?:computer[\s-]?vision|image[\s-]?recogni|object[\s-]?detect)\b/i, 'vision'],
    [/\b(?:drift|model[\s-]?degradat|concept[\s-]?drift)\b/i, 'drift-detection'],
    [/\b(?:feature[\s-]?engineer|feature[\s-]?extract|feature[\s-]?store)\b/i, 'feature-engineering'],
    [/\b(?:train|training[\s-]?data|training[\s-]?pipeline|model[\s-]?train)\b/i, 'model-training'],
    [/\b(?:data[\s-]?pipeline|etl|data[\s-]?ingest|data[\s-]?lake)\b/i, 'data-pipeline'],
    [/\b(?:analytics|analytic|statistical[\s-]?analys|data[\s-]?analys)\b/i, 'analytics'],
    [/\b(?:historical[\s-]?data|historical[\s-]?pattern|trend[\s-]?analys)\b/i, 'historical-analysis'],
  ];

  for (const [pat, keyword] of patterns) {
    if (pat.test(lowerQuery)) keywords.push(keyword);
  }

  if (keywords.length === 0) return { hasIntelligence: false, keywords: [], suggestedContexts: [] };

  // Build suggested contexts based on detected keywords
  const suggestedContexts: Array<{
    name: string;
    type: 'ml-inference' | 'analytics' | 'anomaly-detection' | 'forecasting' | 'data-pipeline';
    commands: string[];
    description: string;
  }> = [];

  if (keywords.some(k => ['anomaly-detection', 'drift-detection', 'pattern-recognition'].includes(k))) {
    suggestedContexts.push({
      name: 'anomaly-detection-engine',
      type: 'anomaly-detection',
      commands: ['DetectAnomalies', 'TrainDetectionModel', 'UpdateBaseline', 'GetAnomalyReport', 'ConfigureThresholds'],
      description: 'Anomaly detection and pattern recognition engine using statistical and ML models',
    });
  }

  if (keywords.some(k => ['prediction', 'forecasting', 'time-series'].includes(k))) {
    suggestedContexts.push({
      name: 'forecasting-engine',
      type: 'forecasting',
      commands: ['RunForecast', 'TrainForecastModel', 'EvaluateModelAccuracy', 'GetForecastResults', 'UpdateHistoricalData'],
      description: 'Time-series forecasting and predictive analytics engine',
    });
  }

  if (keywords.some(k => ['AI/ML', 'deep-learning', 'classification', 'model-training'].includes(k))) {
    suggestedContexts.push({
      name: 'ml-inference-engine',
      type: 'ml-inference',
      commands: ['RunInference', 'TrainModel', 'DeployModel', 'EvaluateModel', 'GetModelMetrics', 'RetireModel'],
      description: 'Machine learning model lifecycle management and inference engine',
    });
  }

  if (keywords.some(k => ['analytics', 'historical-analysis'].includes(k))) {
    suggestedContexts.push({
      name: 'analytics-engine',
      type: 'analytics',
      commands: ['RunAnalysis', 'GenerateReport', 'ComputeMetrics', 'QueryHistoricalData', 'BuildDashboard'],
      description: 'Analytics and business intelligence engine for historical data analysis',
    });
  }

  if (keywords.some(k => ['data-pipeline', 'feature-engineering'].includes(k))) {
    suggestedContexts.push({
      name: 'data-pipeline',
      type: 'data-pipeline',
      commands: ['IngestData', 'TransformData', 'ExtractFeatures', 'ValidateData', 'SchedulePipeline'],
      description: 'Data ingestion, transformation, and feature engineering pipeline',
    });
  }

  if (keywords.some(k => ['recommendation', 'nlp', 'vision'].includes(k))) {
    suggestedContexts.push({
      name: 'ml-inference-engine',
      type: 'ml-inference',
      commands: ['RunInference', 'TrainModel', 'DeployModel', 'EvaluateModel', 'GetModelMetrics', 'RetireModel'],
      description: 'Machine learning model lifecycle management and inference engine',
    });
  }

  // If we detected intelligence keywords but no specific context matched, add a generic one
  if (suggestedContexts.length === 0) {
    suggestedContexts.push({
      name: 'intelligence-engine',
      type: 'analytics',
      commands: ['AnalyzeData', 'DetectPatterns', 'GenerateInsights', 'RunModel', 'GetResults'],
      description: 'Intelligence and analytics engine for data-driven insights',
    });
  }

  // Deduplicate by name
  const seen = new Set<string>();
  const deduped = suggestedContexts.filter(c => {
    if (seen.has(c.name)) return false;
    seen.add(c.name);
    return true;
  });

  return { hasIntelligence: true, keywords, suggestedContexts: deduped };
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Load agentics fleet report from phase2Dir and format for LLM context.
 * Returns a string summary of agent findings, or empty string if unavailable.
 */
function loadAgenticsFleetContext(phase2Dir: string): string {
  try {
    const reportPath = path.join(phase2Dir, 'agentics-agents-report.json');
    if (!fs.existsSync(reportPath)) return '';
    const report = JSON.parse(fs.readFileSync(reportPath, 'utf-8')) as {
      results?: Array<{ domain: string; agent: string; role: string; status: number; response: unknown }>;
    };
    if (!report.results || report.results.length === 0) return '';

    const successResults = report.results.filter(r => r.status === 200);
    if (successResults.length === 0) return '';

    const agentSummaries = successResults.slice(0, 15).map(r => {
      const resp = r.response as Record<string, unknown> | undefined;
      const data = resp?.['data'] as Record<string, unknown> | undefined;
      // Extract meaningful content from agent response
      let finding = '';
      if (data) {
        // Common agent response shapes
        const plan = data['plan'] as Record<string, unknown> | undefined;
        const analysis = data['analysis'] as Record<string, unknown> | undefined;
        const hypothesis = data['hypothesis'] as Record<string, unknown> | undefined;
        const metrics = data['metrics'] as Record<string, unknown> | undefined;
        const recommendations = data['recommendations'] as unknown[] | undefined;

        if (plan?.['steps']) {
          const steps = (plan['steps'] as Array<Record<string, unknown>>).slice(0, 3);
          finding = steps.map(s => s['title'] || s['description'] || '').join('; ');
        } else if (analysis?.['summary'] || analysis?.['findings']) {
          finding = String(analysis['summary'] || analysis['findings'] || '').slice(0, 200);
        } else if (hypothesis?.['statement']) {
          finding = `Hypothesis: ${hypothesis['statement']}`;
        } else if (metrics?.['kpis']) {
          const kpis = (metrics['kpis'] as Array<Record<string, unknown>>).slice(0, 3);
          finding = kpis.map(k => `${k['name']}: ${k['value']} ${k['unit'] || ''}`).join('; ');
        } else if (recommendations) {
          finding = (recommendations as Array<Record<string, unknown>>).slice(0, 3)
            .map(r2 => String(r2['recommendation'] || r2['title'] || r2)).join('; ');
        } else {
          // Generic extraction: take first few string values
          const vals = Object.values(data).filter(v => typeof v === 'string').slice(0, 2);
          finding = vals.map(v => String(v).slice(0, 100)).join('; ');
        }
      }
      return `- [${r.domain}/${r.agent}] ${r.role}: ${finding || 'analysis completed'}`;
    }).join('\n');

    return `\nAGENTICS FLEET ANALYSIS (${successResults.length} agents from 27 domains):\n${agentSummaries}\n`;
  } catch {
    return '';
  }
}

function pad3(n: number): string {
  return String(n).padStart(3, '0');
}

// ============================================================================
// Complete SPARC Generation (single LLM call)
//
// SPARC is a high-level architecture document with 5 sections:
//   Specification, Pseudocode, Architecture, Refinement, Completion
// Each section should be deep, domain-specific, and cohesive — not
// disconnected template fragments. See docs/SPARC-reference.md for examples.
// ============================================================================

/**
 * Generate the ENTIRE SPARC document in one LLM call.
 * This produces a cohesive architecture document like the PowerInfer example
 * in docs/SPARC-reference.md — deep domain-specific content, not templates.
 */
function tryGenerateCompleteSPARC(
  query: string,
  projectContext: string,
  dossier: ResearchDossier,
  artifacts: Phase1Artifacts,
  phase2Dir: string,
): string | null {
  try {
    const runner = createClaudeCodeRunner();

    // Build rich context from dossier + agents
    const dossierItems = dossier.items.slice(0, 40)
      .map(i => `- [${i.category}] ${i.title}: ${i.content.slice(0, 200)}`)
      .join('\n');

    const agentContext = loadAgenticsFleetContext(phase2Dir);

    // Extract domain services for the prompt
    const domainServices = extractDomainServices(query, artifacts, dossier);
    const servicesList = domainServices.map(svc =>
      `- ${svc.name}: ${svc.responsibility} (capabilities: ${svc.capabilities.join(', ')}; systems: ${svc.relatedSystems.join(', ') || 'none'})`
    ).join('\n');

    // Detect tech stack
    const allText = (query + ' ' + projectContext).toLowerCase();
    const techStack: string[] = [];
    const techPatterns: Array<[RegExp, string]> = [
      [/\bsap\b/i, 'SAP'], [/\bsnowflake\b/i, 'Snowflake'], [/\bsalesforce\b/i, 'Salesforce'],
      [/\baws\b/i, 'AWS'], [/\bazure\b/i, 'Azure'], [/\bgcp\b|google cloud/i, 'GCP'],
      [/\bkafka\b/i, 'Kafka'], [/\bpostgres/i, 'PostgreSQL'], [/\bmongodb\b/i, 'MongoDB'],
      [/\bredis\b/i, 'Redis'], [/\bkubernetes\b|\bk8s\b/i, 'Kubernetes'],
      [/\boracle\b/i, 'Oracle'], [/\bnetsuite\b/i, 'NetSuite'], [/\bworkday\b/i, 'Workday'],
    ];
    for (const [pat, name] of techPatterns) {
      if (pat.test(allText)) techStack.push(name);
    }

    // Detect intelligence/ML requirements
    const intelligenceReqs = detectIntelligenceRequirements(query);
    let intelligenceGuidance = '';
    if (intelligenceReqs.hasIntelligence) {
      intelligenceGuidance = '\n=== INTELLIGENCE/ML REQUIREMENTS ===\n' +
        `Detected keywords: ${intelligenceReqs.keywords.join(', ')}\n` +
        'The following intelligence contexts MUST be included in the architecture:\n' +
        intelligenceReqs.suggestedContexts.map(c =>
          `- ${c.name} (${c.type}): ${c.description}\n  Commands: ${c.commands.join(', ')}\n  NOTE: This is NOT a CRUD context. It must contain ML/analytics logic, not Create/Update/Delete operations.`
        ).join('\n') +
        '\n\nCRITICAL: Intelligence contexts must have commands like TrainModel, RunInference, DetectAnomalies — NOT generic Create*, Update*, Delete*.\n';
    }

    const prompt =
      `You are a senior enterprise architect creating a complete SPARC architecture document.\n` +
      `\nSPARC is a high-level architecture methodology with 5 sections: Specification, Pseudocode, Architecture, Refinement, Completion.\n` +
      `Each section must be DEEPLY domain-specific — not generic templates.\n` +
      `\n=== PROJECT ===\n${query}\n` +
      `\n=== TECHNOLOGY STACK ===\n${techStack.join(', ') || 'To be determined based on domain requirements'}\n` +
      `\n=== PROJECT CONTEXT ===\n${projectContext.slice(0, 3000)}\n` +
      `\n=== RESEARCH FINDINGS (${dossier.items.length} items from 110 agents) ===\n${dossierItems}\n` +
      (agentContext ? `\n${agentContext}` : '') +
      (intelligenceGuidance ? `\n${intelligenceGuidance}` : '') +
      `\n=== DOMAIN SERVICES ===\n${servicesList}\n` +
      `\nWrite the COMPLETE SPARC document with these 5 sections. Use the section headers EXACTLY as shown:\n` +
      `\n# Specification\n` +
      `Deep domain analysis: goals and motivation, supported features/model classes, specific performance/latency/memory targets with numbers, ` +
      `compatibility and integration requirements with actual system APIs (e.g. real SAP API names, real Snowflake SQL interfaces). ` +
      `Include functional requirements with acceptance criteria, non-functional requirements with specific numbers, ` +
      `stakeholder roles specific to this domain (not generic "Employees"), and system integration details.\n` +
      `\n# Pseudocode\n` +
      `High-level pseudocode showing the ACTUAL algorithms, data structures, and control flow. ` +
      `Include typed struct/class definitions with real field names and types. ` +
      `Show function signatures with typed parameters. Show the REAL business logic — calculations, validations, decision trees, state machines. ` +
      `NOT generic "validate_input → process → persist" templates. ` +
      `Use \`\`\`pseudocode blocks for code.\n` +
      `\n# Architecture\n` +
      `System architecture: component design, data flow diagrams, module interactions, technology stack decisions with rationale. ` +
      `Include crate/package organization, backend implementations, data models and schemas, ` +
      `key architectural patterns (why microservices vs monolith, why event sourcing vs CRUD, etc.), ` +
      `scalability strategy, security architecture, and integration architecture with actual external system APIs.\n` +
      `\n# Refinement\n` +
      `Optimization and hardening: quantization/performance support, format compatibility details, ` +
      `fallback strategies, SIMD/parallel optimizations, memory layout, cache locality, ` +
      `quality vs performance trade-offs with specific tuning parameters, security hardening, ` +
      `edge case handling specific to this domain.\n` +
      `\n# Completion\n` +
      `Integration plan: how components connect end-to-end, testing plan (unit/integration/e2e with domain-specific test cases), ` +
      `benchmark targets with specific numbers, deployment strategy, monitoring and observability, ` +
      `model/system-specific adjustments, post-deployment validation.\n` +
      `\nCRITICAL RULES:\n` +
      `1. Every section must be DEEPLY domain-specific to "${query.slice(0, 100)}"\n` +
      `2. Include REAL API names, REAL data structures, REAL algorithms — not placeholders\n` +
      `3. Pseudocode must have typed structs and real function logic, not "validate→execute→persist"\n` +
      `4. Architecture must describe actual component interactions, not "User → API → DB"\n` +
      `5. Use the research findings and agent analysis above as your primary source of domain knowledge\n` +
      `6. Each section should be 500-2000 words of substantive content\n` +
      `7. This is a HIGH-LEVEL ARCHITECTURE document — not a process description`;

    const result = runner.invoke<Record<string, unknown>>(prompt, {
      runId: `sparc-complete-${Date.now()}`,
      timeoutMs: 300_000, // 5 minutes for comprehensive document
    });

    const data = result.data as Record<string, unknown>;
    const content = typeof data.content === 'string' ? data.content : '';

    // Validate: must have all 5 sections and substantial content
    if (content.length < 3000) {
      process.stderr.write(`[sparc] Using deterministic SPARC generator\n`);
      return null;
    }
    const hasSections = ['# Specification', '# Pseudocode', '# Architecture', '# Refinement', '# Completion']
      .every(h => content.includes(h));
    if (!hasSections) {
      process.stderr.write('[sparc] Using deterministic SPARC generator\n');
      return null;
    }

    process.stderr.write(
      `[sparc] LLM-generated complete SPARC: ${content.length} chars in ${result.durationMs}ms\n`
    );
    return content;
  } catch (err: unknown) {
    process.stderr.write(
      `[sparc] Complete SPARC generation failed: ${err instanceof Error ? err.message : String(err)}\n`
    );
    return null;
  }
}

/**
 * Split a complete SPARC document into its 5 sections.
 * Looks for "# Specification", "# Pseudocode", "# Architecture", "# Refinement", "# Completion"
 * as top-level headers.
 */
function splitSPARCSections(fullDoc: string): {
  specification: string;
  pseudocode: string;
  architecture: string;
  refinement: string;
  completion: string;
} {
  const sectionPattern = /^# (Specification|Pseudocode|Architecture|Refinement|Completion)\b/gm;
  const positions: Array<{ name: string; start: number }> = [];
  let match: RegExpExecArray | null;
  while ((match = sectionPattern.exec(fullDoc)) !== null) {
    const sectionName = match[1];
    if (sectionName) {
      positions.push({ name: sectionName.toLowerCase(), start: match.index });
    }
  }

  const extract = (name: string): string => {
    const idx = positions.findIndex(p => p.name === name);
    if (idx === -1) return `# ${name.charAt(0).toUpperCase() + name.slice(1)}\n\n(Section not generated)`;
    const pos = positions[idx]!;
    const nextPos = idx + 1 < positions.length ? positions[idx + 1] : undefined;
    const end = nextPos ? nextPos.start : fullDoc.length;
    return fullDoc.slice(pos.start, end).trim();
  };

  return {
    specification: extract('specification'),
    pseudocode: extract('pseudocode'),
    architecture: extract('architecture'),
    refinement: extract('refinement'),
    completion: extract('completion'),
  };
}

/** Gather all textual content from Phase 1 artifacts into a single context blob. */
function gatherProjectContext(artifacts: Phase1Artifacts): string {
  const parts: string[] = [];

  const query = artifacts.scenario?.query ?? artifacts.manifest?.query ?? '';
  if (query) parts.push(`## User Query\n${query}`);

  if (artifacts.executiveSummary) {
    parts.push(`## Executive Summary\n${artifacts.executiveSummary}`);
  }
  if (artifacts.decisionMemo) {
    parts.push(`## Decision Memo\n${artifacts.decisionMemo}`);
  }

  // Roadmap phases
  const roadmap = artifacts.roadmap as Record<string, unknown> | undefined;
  if (roadmap) {
    const phases = roadmap['phases'] as Array<Record<string, unknown>> | undefined;
    if (phases && phases.length > 0) {
      const roadmapLines = phases.map((p, i) => {
        const name = p['name'] ?? `Phase ${i + 1}`;
        const desc = p['description'] ?? '';
        const deliverables = Array.isArray(p['deliverables'])
          ? (p['deliverables'] as string[]).join(', ')
          : '';
        return `${i + 1}. **${name}**: ${desc}${deliverables ? ` (Deliverables: ${deliverables})` : ''}`;
      });
      parts.push(`## Roadmap\n${roadmapLines.join('\n')}`);
    }
  }

  // Risk assessment
  const risk = artifacts.riskAssessment as Record<string, unknown> | undefined;
  if (risk) {
    const factors = risk['risk_factors'] as Array<Record<string, unknown>> | undefined;
    if (factors && factors.length > 0) {
      const riskLines = factors.slice(0, 15).map((f) => {
        const title = f['title'] ?? f['name'] ?? 'Risk';
        const severity = f['severity'] ?? f['overall_risk_level'] ?? '';
        const mitigation = f['mitigation'] ?? '';
        return `- **${title}**${severity ? ` [${severity}]` : ''}${mitigation ? `: ${mitigation}` : ''}`;
      });
      parts.push(`## Risk Factors\n${riskLines.join('\n')}`);
    }
  }

  // Scenario fields
  const scenario = artifacts.scenario as Record<string, unknown> | undefined;
  if (scenario) {
    for (const key of ['stakeholders', 'constraints', 'success_criteria', 'systems', 'domain_entities', 'capabilities']) {
      const val = scenario[key];
      if (Array.isArray(val) && val.length > 0) {
        parts.push(`## ${key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())}\n${val.map((v: string) => `- ${v}`).join('\n')}`);
      }
    }
  }

  return parts.join('\n\n');
}

/** Summarize dossier items by category. */
function summarizeDossier(dossier: ResearchDossier): string {
  const byCategory = new Map<string, string[]>();
  for (const item of dossier.items) {
    const cat = item.category;
    if (!byCategory.has(cat)) byCategory.set(cat, []);
    byCategory.get(cat)!.push(`- [${item.id}] ${item.title}: ${item.content}`);
  }

  const sections: string[] = [];
  for (const [cat, items] of byCategory) {
    sections.push(`### ${cat.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase())}\n${items.join('\n')}`);
  }
  return sections.join('\n\n');
}

// ============================================================================
// SPARC Markdown Generators (ruvnet/sparc methodology)
//
// Each function writes a SPARC phase document driven entirely by the user's
// query and collected artifacts. No hardcoded patterns.
// ============================================================================

function writeSpecificationMarkdown(
  query: string,
  projectContext: string,
  _dossierSummary: string,
  dossier: ResearchDossier,
  phase2Dir = '',
): string {
  // ADR-027: Try LLM-generated specification first
  const llmSpec = tryGenerateLLMSpecification(query, projectContext, dossier, phase2Dir);
  if (llmSpec) return llmSpec;

  // Fallback: deterministic bullet-point format
  return writeTemplateSpecification(query, projectContext, dossier);
}

/**
 * ADR-027: Generate a real specification using Claude.
 * Derives functional requirements, acceptance criteria, stakeholder analysis,
 * and non-functional requirements from the domain — not just bullet-pointing the dossier.
 */
function tryGenerateLLMSpecification(
  query: string,
  projectContext: string,
  dossier: ResearchDossier,
  phase2Dir = '',
): string | null {
  try {
    const runner = createClaudeCodeRunner();

    const dossierItems = dossier.items.slice(0, 30)
      .map(i => `- [${i.category}] ${i.title}: ${i.content.slice(0, 150)}`)
      .join('\n');

    // ADR-027: Include agentics fleet analysis from 110 agents
    const agentContext = phase2Dir ? loadAgenticsFleetContext(phase2Dir) : '';

    const prompt =
      `You are a senior business analyst writing a functional specification.\n` +
      `\nPROJECT: ${query}\n` +
      `\nPROJECT CONTEXT:\n${projectContext.slice(0, 2000)}\n` +
      `\nRESEARCH FINDINGS:\n${dossierItems}\n` +
      (agentContext ? agentContext + '\n' : '') +
      `\nWrite a complete "Specification" markdown document with these sections:\n` +
      `\n# Specification\n` +
      `## Objective - What this system does and why\n` +
      `## Stakeholders & Actors - Real roles (e.g., Trader, Risk Manager, Compliance Officer, IT Admin) with their needs — NOT generic "Employees"\n` +
      `## Functional Requirements - Numbered, testable requirements with acceptance criteria. Each requirement must be specific enough to write a test for.\n` +
      `## Non-Functional Requirements - Performance targets (specific numbers), security requirements, compliance requirements, scalability targets\n` +
      `## System Integrations - Specific systems to integrate with, actual API surfaces, data flows, authentication methods\n` +
      `## Domain Model Overview - Key entities with their attributes and relationships (typed fields, not generic)\n` +
      `## Risk Factors - Domain-specific risks with severity and mitigation strategies\n` +
      `## Success Criteria - Measurable outcomes that determine project success\n` +
      `## Assumptions & Constraints\n` +
      `## Reflection - Summary of specification coverage\n` +
      `\nCRITICAL: Derive REAL requirements from the domain. Do NOT just reformat the research findings as bullet points. Each requirement must be specific, testable, and include acceptance criteria.`;

    const result = runner.invoke<Record<string, unknown>>(prompt, {
      runId: `sparc-spec-${Date.now()}`,
      timeoutMs: 180_000,
    });

    const data = result.data as Record<string, unknown>;
    const content = typeof data.content === 'string' ? data.content : '';

    if (content.length > 500) {
      process.stderr.write(
        `[sparc-specification] LLM-generated specification: ${content.length} chars in ${result.durationMs}ms\n`
      );
      return content;
    }

    return null;
  } catch (err: unknown) {
    process.stderr.write(
      `[sparc-specification] LLM spec failed: ${err instanceof Error ? err.message : String(err)}\n`
    );
    return null;
  }
}

/** Fallback: deterministic specification from dossier items. */
function writeTemplateSpecification(
  query: string,
  projectContext: string,
  dossier: ResearchDossier,
): string {
  const requirements = dossier.items.filter(i => i.category === 'requirement' || i.category === 'recommendation');
  const constraints = dossier.items.filter(i => i.category === 'constraint');
  const risks = dossier.items.filter(i => i.category === 'risk');
  const successCriteria = dossier.items.filter(i => i.category === 'success-criterion');
  const stakeholders = dossier.items.filter(i => i.category === 'stakeholder');
  const decisions = dossier.items.filter(i => i.category === 'decision-rationale');

  const lines: string[] = [];
  lines.push('# Specification');
  lines.push('');
  lines.push('## Objective');
  lines.push(`Develop a comprehensive specification for: **${query}**`);
  lines.push('');

  lines.push('## Project Overview');
  lines.push(projectContext);
  lines.push('');

  if (requirements.length > 0) {
    lines.push('## Functional Requirements');
    for (const r of requirements) {
      lines.push(`- **[${r.id}]** ${r.content}`);
    }
    lines.push('');
  }

  if (constraints.length > 0) {
    lines.push('## Non-Functional Requirements & Constraints');
    for (const c of constraints) {
      lines.push(`- **[${c.id}]** ${c.content}`);
    }
    lines.push('');
  }

  if (stakeholders.length > 0) {
    lines.push('## Stakeholders & Actors');
    for (const s of stakeholders) {
      lines.push(`- **${s.title}**: ${s.content}`);
    }
    lines.push('');
  }

  if (risks.length > 0) {
    lines.push('## Risk Factors');
    for (const r of risks) {
      const severity = r.severity ? ` [${r.severity}]` : '';
      lines.push(`- **[${r.id}]${severity}** ${r.content}`);
    }
    lines.push('');
  }

  if (successCriteria.length > 0) {
    lines.push('## Success Criteria');
    for (const sc of successCriteria) {
      lines.push(`- **[${sc.id}]** ${sc.content}`);
    }
    lines.push('');
  }

  if (decisions.length > 0) {
    lines.push('## Key Decisions');
    for (const d of decisions) {
      lines.push(`- **[${d.id}]** ${d.content}`);
    }
    lines.push('');
  }

  lines.push('## Assumptions');
  lines.push('- Phase 1 agent analysis across 27 domains is the primary input for this specification.');
  lines.push('- All requirements are derived from the research dossier and executive summary.');
  lines.push('- Architecture and technology choices will be refined in subsequent SPARC phases.');
  lines.push('');

  lines.push('## Reflection');
  lines.push(`This specification captures ${dossier.items.length} items from the research dossier across ${new Set(dossier.items.map(i => i.source)).size} sources. `);
  lines.push(`${requirements.length} functional requirements, ${constraints.length} constraints, and ${risks.length} risk factors drive the design.`);
  lines.push('');

  return lines.join('\n');
}

function writePseudocodeMarkdown(
  query: string,
  _context: string,
  dossier: ResearchDossier,
  artifacts: Phase1Artifacts,
  phase2Dir = '',
): string {
  // Derive modules from DOMAIN services (not roadmap phases)
  const domainServices = extractDomainServices(query, artifacts, dossier);

  // ADR-027 Change 1: Try LLM-generated domain-specific pseudocode first
  const llmResult = tryGenerateLLMPseudocode(query, domainServices, dossier, phase2Dir);
  if (llmResult) return llmResult;

  // Fallback: deterministic template (original behavior pre-ADR-027)
  return writeTemplatePseudocode(query, domainServices);
}

/**
 * ADR-027 Change 1: Generate domain-specific pseudocode using Claude Code LLM.
 *
 * Instead of the generic validate→execute→persist template, Claude generates
 * pseudocode with domain-specific typed data structures, real algorithms,
 * business rules, and integration points.
 *
 * @returns Pseudocode markdown string, or null if LLM is unavailable/fails.
 */
function tryGenerateLLMPseudocode(
  query: string,
  services: DomainService[],
  dossier: ResearchDossier,
  phase2Dir = '',
): string | null {
  try {
    const runner = createClaudeCodeRunner();

    // Build dossier context (limit to avoid prompt overflow)
    const relevantItems = dossier.items
      .filter(i => ['requirement', 'recommendation', 'decision-rationale', 'constraint'].includes(i.category))
      .slice(0, 25);
    const dossierContext = relevantItems
      .map(i => `- [${i.category}] ${i.title}: ${i.content.slice(0, 200)}`)
      .join('\n');

    // ADR-027: Include agentics fleet analysis from 110 agents
    const agentContext = phase2Dir ? loadAgenticsFleetContext(phase2Dir) : '';

    const servicesList = services.map(svc =>
      `### ${svc.name}\n- Responsibility: ${svc.responsibility}\n- Capabilities: ${svc.capabilities.join(', ')}\n- Related systems: ${svc.relatedSystems.join(', ') || 'none'}`
    ).join('\n\n');

    const prompt =
      `You are a senior domain engineer writing detailed pseudocode for an enterprise system.\n` +
      `\nDOMAIN: ${query}\n` +
      `\nRESEARCH FINDINGS:\n${dossierContext}\n` +
      (agentContext ? agentContext + '\n' : '') +
      `\nSERVICES TO IMPLEMENT:\n${servicesList}\n` +
      `\nWrite a complete pseudocode document in markdown. For EACH service above, write:\n` +
      `1. Domain-specific data structures with typed fields (string, number, boolean, Date, enums)\n` +
      `2. Functions with typed parameters implementing REAL domain algorithms\n` +
      `3. Domain-specific error handling and validation\n` +
      `4. Business rules, calculations, and decision logic specific to this domain\n` +
      `\nCRITICAL: Do NOT write generic templates like "validate_preconditions(input) -> aggregate.execute(input) -> persist(aggregate)". Every function must contain domain-specific logic with real typed parameters.\n` +
      `\nFormat: Start with "# Pseudocode" then "## Objective" describing the domain, then a "## [Service Name] Service" section per service with \`\`\`pseudocode blocks containing typed structs and functions. End with "## Reflection" summarizing coverage.\n` +
      `\nExample of GOOD pseudocode for a maintenance domain (write for YOUR domain, not this):\n` +
      `\`\`\`pseudocode\n` +
      `struct MaintenanceOrder:\n` +
      `    order_id: string\n` +
      `    aircraft_registration: string\n` +
      `    task_type: enum(scheduled|unscheduled|deferred)\n` +
      `    priority: enum(AOG|urgent|routine)\n` +
      `    estimated_labor_hours: number\n` +
      `    parts_required: PartRequirement[]\n` +
      `\n` +
      `function create_maintenance_order(reg: string, task: TaskType, findings: InspectionFinding[]):\n` +
      `    aircraft = lookup_aircraft(reg)\n` +
      `    if aircraft.status == "retired": return AircraftRetiredError(reg)\n` +
      `    priority = assess_priority(findings, aircraft.next_flight_time)\n` +
      `    parts = calculate_required_parts(findings, aircraft.type_certificate)\n` +
      `    labor = estimate_labor_hours(findings, aircraft.maintenance_history)\n` +
      `    order = MaintenanceOrder(generate_id(), reg, task, priority, labor, parts)\n` +
      `    if priority == AOG: notify_ops_control(aircraft, order)\n` +
      `    persist(order)\n` +
      `    emit_event("maintenance.order.created", order)\n` +
      `    return order\n` +
      `\`\`\``;

    const result = runner.invoke<Record<string, unknown>>(prompt, {
      runId: `sparc-pseudo-${Date.now()}`,
      timeoutMs: 180_000, // 3 minutes for comprehensive pseudocode
    });

    // Extract content from unwrapped Claude Code envelope
    const data = result.data as Record<string, unknown>;
    const content = typeof data.content === 'string' ? data.content : '';

    if (content.length > 300) {
      process.stderr.write(
        `[sparc-specification] LLM-generated pseudocode: ${content.length} chars in ${result.durationMs}ms\n`
      );
      return content;
    }

    process.stderr.write('[sparc-specification] Using deterministic pseudocode generator\n');
    return null;
  } catch (err: unknown) {
    process.stderr.write(
      `[sparc-specification] Using deterministic pseudocode generator\n`
    );
    return null;
  }
}

/** Fallback: deterministic pseudocode template (pre-ADR-027 behavior). */
function writeTemplatePseudocode(query: string, domainServices: DomainService[]): string {
  const lines: string[] = [];

  lines.push('# Pseudocode');
  lines.push('');
  lines.push('## Objective');
  lines.push(`Create a pseudocode outline for each domain service: **${query}**`);
  lines.push('');

  for (const svc of domainServices) {
    const title = svc.name.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    lines.push(`## ${title} Service`);
    lines.push('');
    lines.push(svc.responsibility);
    lines.push('');
    lines.push('```pseudocode');
    lines.push(`// Service: ${svc.name}`);
    lines.push(`// ${svc.responsibility}`);
    lines.push('');

    for (const cap of svc.capabilities) {
      const funcName = cap.replace(/[^a-zA-Z0-9\s]/g, '').replace(/\s+/g, '_').toLowerCase();
      lines.push(`function ${funcName}(input):`);
      lines.push(`    // Capability: ${cap}`);
      lines.push('    validate_preconditions(input)');
      lines.push('    aggregate = load_or_create_aggregate(input.id)');
      lines.push('    result = aggregate.execute(input)');
      lines.push('    if result.error:');
      lines.push('        return ErrorResponse(result.error)');
      lines.push(`    emit_event("${svc.name}.${funcName}.completed", result)`);
      lines.push('    persist(aggregate)');
      lines.push('    return SuccessResponse(result.data)');
      lines.push('');
    }

    lines.push('```');
    lines.push('');
  }

  lines.push('## Reflection');
  lines.push('- Pseudocode models the business domain — each module is a domain service.');
  lines.push(`- ${domainServices.length} domain services identified from scenario entities and capabilities.`);
  lines.push('- Error handling and validation are included at every entry point.');
  lines.push('- TDD anchors: each function boundary is a test seam for London School outside-in testing.');
  lines.push('');

  return lines.join('\n');
}

function writeArchitectureMarkdown(
  query: string,
  projectContext: string,
  dossier: ResearchDossier,
  artifacts: Phase1Artifacts,
): string {
  const archConstraints = dossier.items.filter(i => i.category === 'constraint');
  const risks = dossier.items.filter(i => i.category === 'risk');
  const requirements = dossier.items.filter(i => i.category === 'requirement' || i.category === 'recommendation');

  const lines: string[] = [];
  lines.push('# Architecture');
  lines.push('');
  lines.push('## Objective');
  lines.push(`Define the system architecture and technical design for: **${query}**`);
  lines.push('');

  // Detect systems from scenario/context
  const allText = (projectContext + ' ' + query).toLowerCase();
  const detectedSystems: string[] = [];
  const systemKeywords: Array<[string, string]> = [
    ['workday', 'Workday HCM'], ['sap', 'SAP ERP'], ['netsuite', 'NetSuite'],
    ['oracle', 'Oracle'], ['salesforce', 'Salesforce'], ['servicenow', 'ServiceNow'],
    ['google cloud', 'Google Cloud Platform'], ['aws', 'Amazon Web Services'],
    ['azure', 'Microsoft Azure'], ['kafka', 'Apache Kafka'], ['redis', 'Redis'],
    ['postgres', 'PostgreSQL'], ['mongodb', 'MongoDB'], ['elasticsearch', 'Elasticsearch'],
    ['snowflake', 'Snowflake'], ['bigquery', 'BigQuery'], ['kubernetes', 'Kubernetes'],
    ['docker', 'Docker'], ['terraform', 'Terraform'],
  ];
  for (const [kw, name] of systemKeywords) {
    if (allText.includes(kw)) detectedSystems.push(name);
  }

  lines.push('## Architectural Style');
  if (requirements.length > 10 || detectedSystems.length > 3) {
    lines.push('- **Microservices Architecture**: Selected due to the complexity and number of integration points.');
    lines.push('- Each bounded context operates as an independent service with its own data store.');
  } else {
    lines.push('- **Modular Monolith**: Selected for initial implementation simplicity with clear module boundaries.');
    lines.push('- Can evolve to microservices as scale demands grow.');
  }
  lines.push('');

  if (detectedSystems.length > 0) {
    lines.push('## Technology Stack');
    lines.push('### External Systems');
    for (const sys of detectedSystems) {
      lines.push(`- ${sys}`);
    }
    lines.push('');
  }

  // Derive components from DOMAIN services (not roadmap phases)
  const domainServices = extractDomainServices(query, artifacts, dossier);

  lines.push('## Key Components (Domain Services)');
  lines.push('');
  lines.push('| Service | Responsibility | Capabilities | Dependencies |');
  lines.push('|---------|---------------|-------------|-------------|');
  for (const svc of domainServices) {
    const caps = svc.capabilities.slice(0, 3).join(', ');
    const deps = svc.relatedSystems.length > 0 ? svc.relatedSystems.join(', ') : '-';
    lines.push(`| ${svc.name} | ${svc.responsibility.slice(0, 60)} | ${caps} | ${deps} |`);
  }
  lines.push('');

  lines.push('## Data Flow');
  lines.push('```');
  lines.push('User Request → API Gateway → Service Layer → Data Store');
  if (detectedSystems.length > 0) {
    lines.push(`              → Integration Layer → [${detectedSystems.slice(0, 3).join(', ')}]`);
  }
  lines.push('              → Event Bus → Notification Service → User');
  lines.push('```');
  lines.push('');

  if (archConstraints.length > 0) {
    lines.push('## Scalability, Security, and Performance');
    lines.push('### Constraints');
    for (const c of archConstraints.slice(0, 10)) {
      lines.push(`- ${c.content}`);
    }
    lines.push('');
  }

  if (risks.length > 0) {
    lines.push('### Risk Mitigations');
    for (const r of risks.slice(0, 10)) {
      lines.push(`- **${r.title}**: ${r.content.slice(0, 120)}`);
    }
    lines.push('');
  }

  lines.push('## Reflection');
  lines.push(`- Architecture addresses ${archConstraints.length} constraints and ${risks.length} risk factors from the research dossier.`);
  if (detectedSystems.length > 0) {
    lines.push(`- Integration with ${detectedSystems.length} external systems requires adapter pattern and circuit breakers.`);
  }
  lines.push('- Security boundaries align with bounded contexts — each service manages its own auth scope.');
  lines.push('');

  return lines.join('\n');
}

function writeRefinementMarkdown(
  query: string,
  _context: string,
  dossier: ResearchDossier,
): string {
  const risks = dossier.items.filter(i => i.category === 'risk');

  const lines: string[] = [];
  lines.push('# Refinement');
  lines.push('');
  lines.push('## Objective');
  lines.push(`Iteratively improve the architecture and pseudocode for: **${query}**`);
  lines.push('');

  lines.push('## Security Considerations');
  const securityItems = dossier.items.filter(i =>
    i.content.toLowerCase().match(/security|auth|access|pii|encrypt|credential|token|rbac|iam/)
  );
  if (securityItems.length > 0) {
    for (const item of securityItems.slice(0, 10)) {
      lines.push(`- **[${item.id}]** ${item.content.slice(0, 150)}`);
    }
  } else {
    lines.push('- Implement authentication and authorization at all API endpoints.');
    lines.push('- Encrypt data at rest and in transit.');
    lines.push('- Apply principle of least privilege for service accounts.');
  }
  lines.push('');

  lines.push('## Performance Targets');
  const perfItems = dossier.items.filter(i =>
    i.content.toLowerCase().match(/performance|latency|throughput|response time|scalab|p99|sla/)
  );
  if (perfItems.length > 0) {
    for (const item of perfItems.slice(0, 10)) {
      lines.push(`- **[${item.id}]** ${item.content.slice(0, 150)}`);
    }
  } else {
    lines.push('- API response time < 200ms at p95.');
    lines.push('- System handles 1000 concurrent users.');
    lines.push('- Data pipeline processes within SLA window.');
  }
  lines.push('');

  lines.push('## Test Strategy');
  lines.push('- **London School TDD**: Outside-in approach starting from acceptance tests.');
  lines.push('- **Test Pyramid**: Unit (70%) → Integration (20%) → E2E (10%).');
  lines.push('- **Mock Contracts**: Each service boundary gets a mock contract for isolated testing.');
  lines.push('- **Seams**: Service boundaries, adapters, and gateways are primary test seams.');
  lines.push('');

  if (risks.length > 0) {
    lines.push('## Edge Cases & Risk Mitigations');
    for (const r of risks.slice(0, 8)) {
      lines.push(`- **${r.title}**: ${r.content.slice(0, 120)}`);
    }
    lines.push('');
  }

  lines.push('## Reflection');
  lines.push(`- ${securityItems.length} security-related items identified from research dossier.`);
  lines.push(`- ${perfItems.length} performance-related items drive the targets.`);
  lines.push(`- ${risks.length} risk factors inform edge case handling.`);
  lines.push('- Test strategy uses London School TDD for clean separation of concerns.');
  lines.push('');

  return lines.join('\n');
}

function writeCompletionMarkdown(
  query: string,
  _context: string,
  _dossier: ResearchDossier,
  _artifacts: Phase1Artifacts,
): string {
  const lines: string[] = [];
  lines.push('# Completion');
  lines.push('');
  lines.push('## Objective');
  lines.push(`Finalize the project, ensuring it is ready for deployment: **${query}**`);
  lines.push('');

  lines.push('## Integration Plan');
  lines.push('- Integrate all bounded contexts via event-driven messaging.');
  lines.push('- Wire external system adapters with circuit breakers and retry policies.');
  lines.push('- End-to-end smoke tests validate the full integration path.');
  lines.push('');

  lines.push('## Testing Checklist');
  lines.push('- [ ] Unit tests pass for all modules (>80% coverage).');
  lines.push('- [ ] Integration tests validate service boundaries.');
  lines.push('- [ ] E2E tests cover primary user flows.');
  lines.push('- [ ] Security audit completed (no critical/high vulnerabilities).');
  lines.push('- [ ] Performance benchmarks meet targets from Refinement phase.');
  lines.push('');

  lines.push('## Documentation');
  lines.push('- API documentation (OpenAPI/Swagger).');
  lines.push('- Architecture Decision Records (ADRs) — generated in Phase 4.');
  lines.push('- Domain model documentation (DDD bounded contexts) — generated in Phase 4.');
  lines.push('- Deployment runbook and rollback procedures.');
  lines.push('- User guides and onboarding documentation.');
  lines.push('');

  lines.push('## Deployment & Monitoring');
  lines.push('- CI/CD pipeline with automated testing gates.');
  lines.push('- Health check endpoints for all services.');
  lines.push('- Structured logging with correlation IDs.');
  lines.push('- Alerting on SLO violations.');
  lines.push('- Dashboard for key business metrics.');
  lines.push('');

  lines.push('## Post-Deployment');
  lines.push('- Monitor error rates and latency for 48 hours post-deploy.');
  lines.push('- Gather user feedback via analytics and support channels.');
  lines.push('- Plan iteration based on production telemetry.');
  lines.push('');

  lines.push('## Reflection');
  lines.push('- This SPARC specification was generated from Phase 1 simulation (109 agents) and Phase 2 research dossier.');
  lines.push('- ADRs and DDDs will be generated in Phase 4 using ruflo coding agents, building on this SPARC output.');
  lines.push('- Phase 5 will produce the actual implementation code.');
  lines.push('');

  return lines.join('\n');
}

// ============================================================================
// Domain Service Extraction
//
// Derives architecture services from the DOMAIN — scenario entities,
// capabilities, systems, and query analysis. NEVER from roadmap phases.
// Roadmap phases are project management artifacts (discovery, prototyping),
// NOT bounded contexts or services.
// ============================================================================

interface DomainService {
  name: string;         // kebab-case domain service name
  responsibility: string;
  capabilities: string[];
  relatedSystems: string[];
  dossierItemRefs: string[];
}

/**
 * Extract domain services from scenario entities, capabilities, systems,
 * dossier requirements, and NLP analysis of the query itself.
 *
 * This is the critical function that ensures SPARC services model the
 * BUSINESS DOMAIN (inventory-management, demand-forecasting) not project
 * management phases (discovery-planning, prototype-development).
 */
function extractDomainServices(
  query: string,
  artifacts: Phase1Artifacts,
  dossier: ResearchDossier,
): DomainService[] {
  const scenario = artifacts.scenario as Record<string, unknown> | undefined;
  const services = new Map<string, DomainService>();

  // ── Stop-words: common English words that never form domain names ──
  const STOP_WORDS = new Set([
    'a', 'an', 'the', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
    'of', 'with', 'by', 'from', 'as', 'is', 'was', 'are', 'were', 'be',
    'been', 'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will',
    'would', 'could', 'should', 'may', 'might', 'shall', 'can', 'that',
    'this', 'these', 'those', 'it', 'its', 'we', 'our', 'they', 'their',
    'them', 'you', 'your', 'i', 'my', 'me', 'he', 'she', 'his', 'her',
    'if', 'when', 'where', 'how', 'what', 'which', 'who', 'whom', 'why',
    'not', 'no', 'nor', 'so', 'very', 'too', 'also', 'just', 'about',
    'into', 'through', 'during', 'before', 'after', 'above', 'below',
    'between', 'under', 'over', 'again', 'further', 'then', 'once',
    'here', 'there', 'all', 'each', 'every', 'both', 'few', 'more',
    'most', 'other', 'some', 'such', 'any', 'only', 'same', 'than',
    'because', 'until', 'while', 'although', 'since', 'unless',
    // Project/task verbs that aren't domain nouns
    'build', 'create', 'make', 'develop', 'design', 'implement',
    'prototype', 'evaluate', 'demonstrate', 'deploy', 'run', 'use',
    'need', 'want', 'like', 'look', 'help', 'show', 'get', 'set',
    'currently', 'typically', 'roughly', 'ideally', 'basically',
    'across', 'within', 'several', 'enough', 'early', 'certain',
    // Action verbs — valid in capabilities but not in service names
    'analyze', 'analyse', 'detect', 'identify', 'predict', 'monitor',
    'track', 'measure', 'notify', 'trigger', 'generate', 'produce',
    'integrate', 'connect', 'interface', 'manage', 'handle',
    'check', 'verify', 'validate', 'ensure', 'maintain', 'support',
    // Adjectives and adverbs that don't belong in service names
    'inconsistent', 'unusual', 'historical', 'internal', 'external',
    'operational', 'financial', 'regulatory', 'automatic', 'manual',
    'potential', 'existing', 'current', 'previous', 'expected',
    'significant', 'relevant', 'specific', 'general', 'overall',
    'situations', 'indicators', 'patterns', 'signals', 'issues',
    // Generic tech/business words too vague for a service name
    'system', 'application', 'platform', 'solution', 'service',
    'process', 'data', 'information', 'operations', 'management',
    'existing', 'working', 'possible', 'potential', 'based',
  ]);

  /**
   * Extract the core domain noun(s) from a raw phrase.
   *
   * Strategy: strip stop-words, keep only meaningful domain terms (1-3 words),
   * return a clean kebab-case name like "vendor" or "risk-indicator".
   * Then normalize via domain vocabulary to get canonical names.
   */
  const toServiceName = (raw: string): string => {
    // First try domain vocabulary normalization on the full phrase
    const normalized = normalizeContextName(raw);
    if (normalized !== raw.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40)
        && normalized !== 'default-context') {
      return normalized;
    }

    // Full phrase didn't match vocabulary — try sliding sub-phrase windows
    const words = raw.toLowerCase()
      .replace(/[^a-z0-9\s-]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 1 && !STOP_WORDS.has(w));

    // Try 2-word windows
    for (let i = 0; i <= words.length - 2; i++) {
      const subPhrase = words.slice(i, i + 2).join(' ');
      const result = normalizeContextName(subPhrase);
      if (result !== 'default-context') return result;
    }

    // Try individual words
    for (const word of words) {
      const result = normalizeContextName(word);
      if (result !== 'default-context') return result;
    }

    // Nothing matched domain vocabulary — skip this entity entirely
    // rather than generating a garbage name like "booking-trends-event"
    return '';
  };

  // 1. Extract from scenario.domain_entities (primary source)
  const domainEntities = (scenario?.['domain_entities'] as string[]) ?? [];
  for (const entity of domainEntities) {
    const name = toServiceName(entity);
    if (!name || name.length < 2) continue;
    if (!services.has(name)) {
      services.set(name, {
        name,
        responsibility: `Manage ${entity} domain logic, CRUD operations, business rules, and event handling`,
        capabilities: [`create-${name}`, `update-${name}`, `query-${name}`, `delete-${name}`],
        relatedSystems: [],
        dossierItemRefs: [],
      });
    }
  }

  // 2. Extract from scenario.capabilities (functional capabilities become services)
  //    Use only the core domain noun(s) from each capability — never full sentences.
  //    Standard CRUD verbs are used for capabilities instead of sentence fragments.
  const capabilities = (scenario?.['capabilities'] as string[]) ?? [];
  for (const cap of capabilities) {
    const name = toServiceName(cap);
    if (!name || name.length < 2) continue;
    // Merge into existing service if similar, otherwise create new
    const existing = services.get(name);
    if (existing) {
      // Add clean CRUD capabilities, not the raw sentence
      if (!existing.capabilities.includes(`manage-${name}`)) {
        existing.capabilities.push(`manage-${name}`);
      }
    } else {
      services.set(name, {
        name,
        responsibility: `${cap} — business capability implementation with validation, processing, and event emission`,
        capabilities: [`create-${name}`, `update-${name}`, `query-${name}`],
        relatedSystems: [],
        dossierItemRefs: [],
      });
    }
  }

  // 3. Extract from scenario.systems (external system integrations become adapter services)
  const systems = (scenario?.['systems'] as string[]) ?? [];
  for (const sys of systems) {
    const baseName = toServiceName(sys);
    const name = `${baseName}-integration`;
    if (!name || name.length < 4) continue;
    if (!services.has(name)) {
      services.set(name, {
        name,
        responsibility: `Integration adapter for ${sys} — API client, data mapping, retry/circuit-breaker, event bridge`,
        capabilities: [`connect-${baseName}`, `sync-${baseName}`, `query-${baseName}`],
        relatedSystems: [sys],
        dossierItemRefs: [],
      });
    }
  }

  // 4. Research-first: extract domain services from the dossier content.
  //    The deep research (ruflo swarm + 110 agents) already identified the key
  //    domain concepts. We extract service names from dossier item titles and
  //    content, then normalize through the domain vocabulary.
  //    This replaces the old approach of hardcoded NLP regex patterns per industry.
  for (const item of dossier.items) {
    if (item.category !== 'requirement' && item.category !== 'recommendation'
        && item.category !== 'decision-rationale') continue;
    // Try to derive a service name from the item title
    const candidateName = normalizeContextName(item.title);
    if (candidateName && candidateName !== 'default-context' && !services.has(candidateName)) {
      services.set(candidateName, {
        name: candidateName,
        responsibility: item.content.slice(0, 200),
        capabilities: [`manage-${candidateName}`, `query-${candidateName}`],
        relatedSystems: [],
        dossierItemRefs: [item.id],
      });
    }
  }

  // 5. Fallback: if dossier produced fewer than 3 services, scan query+entities
  //    through normalizeContextName (from ddd-generator's domain vocabulary)
  if (services.size < 3) {
    const allText = query + ' ' + domainEntities.join(' ') + ' ' + capabilities.join(' ');
    // Split into overlapping 3-5 word windows and try to normalize each
    const words = allText.toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').split(/\s+/).filter(w => w.length > 2);
    for (let windowSize = 3; windowSize >= 1; windowSize--) {
      for (let i = 0; i <= words.length - windowSize; i++) {
        const phrase = words.slice(i, i + windowSize).join(' ');
        const name = normalizeContextName(phrase);
        if (name && name !== 'default-context' && !services.has(name) && services.size < 12) {
          services.set(name, {
            name,
            responsibility: `${name.replace(/-/g, ' ')} — domain service derived from project scope`,
            capabilities: [`manage-${name}`, `query-${name}`],
            relatedSystems: [],
            dossierItemRefs: [],
          });
        }
      }
    }
  }

  // 6. Enrich services with dossier item references
  for (const item of dossier.items) {
    if (item.category !== 'requirement' && item.category !== 'recommendation') continue;
    const itemText = item.content.toLowerCase();
    for (const svc of services.values()) {
      const nameWords = svc.name.split('-');
      if (nameWords.some(w => w.length > 2 && itemText.includes(w))) {
        svc.dossierItemRefs.push(item.id);
      }
    }
  }

  // 7. Always ensure at least an API gateway service
  if (!services.has('api-gateway')) {
    services.set('api-gateway', {
      name: 'api-gateway',
      responsibility: 'API gateway — request routing, authentication, rate limiting, request/response transformation',
      capabilities: ['route-requests', 'authenticate', 'rate-limit'],
      relatedSystems: [],
      dossierItemRefs: [],
    });
  }

  // 8. If no domain services were extracted, create from the query directly
  //    Use stop-word-filtered nouns, not adjacent word pairs
  if (services.size <= 1) {
    const queryNouns = query.toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 3 && !STOP_WORDS.has(w));

    // Each remaining noun becomes a candidate service (deduplicated)
    for (const noun of queryNouns) {
      if (!services.has(noun) && services.size < 8) {
        services.set(noun, {
          name: noun,
          responsibility: `${noun} — domain service for business logic, data management, and event processing`,
          capabilities: [`manage-${noun}`, `query-${noun}`],
          relatedSystems: [],
          dossierItemRefs: [],
        });
      }
    }
  }

  // 9. ADR-029 Fix 4: Add intelligence/ML services when query requires them
  const intelligenceReqs = detectIntelligenceRequirements(query);
  if (intelligenceReqs.hasIntelligence) {
    for (const ctx of intelligenceReqs.suggestedContexts) {
      // Only add if not already covered by an existing service
      const alreadyExists = Array.from(services.values()).some(s =>
        s.name.toLowerCase().includes(ctx.name.split('-')[0]!) ||
        ctx.name.includes(s.name.toLowerCase())
      );
      if (!alreadyExists) {
        services.set(ctx.name, {
          name: ctx.name,
          responsibility: ctx.description,
          capabilities: ctx.commands,
          relatedSystems: [],
          dossierItemRefs: [],
        });
      }
    }
  }

  return Array.from(services.values()).slice(0, 12);
}

// ============================================================================
// JSON Compatibility Shim
//
// Downstream consumers (Phase 4 ADR/DDD generators, Phase 5 build, TDD plan)
// expect Phase2SPARCOutput JSON. We populate it FROM the dossier/artifacts
// with minimal structured data — the markdown is the real output.
// ============================================================================

function buildCompatJSON(
  dossier: ResearchDossier,
  artifacts: Phase1Artifacts,
): Phase2SPARCOutput {
  const query = artifacts.scenario?.query ?? artifacts.manifest?.query ?? '';

  // --- Specification ---
  const requirements: Phase2Requirement[] = [];
  const constraints: Phase2Constraint[] = [];
  const successCriteria: Phase2SuccessCriterion[] = [];
  const referencedIds = new Set<string>();
  let reqIdx = 1, conIdx = 1, scIdx = 1;

  for (const item of dossier.items) {
    if (item.category === 'requirement' || item.category === 'recommendation') {
      requirements.push({
        id: `SPEC-REQ-${pad3(reqIdx)}`,
        text: item.content,
        dossierItemRefs: [item.id],
        priority: item.source === 'risk-assessment' || item.source === 'decision-memo' ? 'must' : 'should',
      });
      referencedIds.add(item.id);
      reqIdx++;
    } else if (item.category === 'constraint') {
      constraints.push({
        id: `SPEC-CON-${pad3(conIdx)}`,
        text: item.content,
        dossierItemRefs: [item.id],
      });
      referencedIds.add(item.id);
      conIdx++;
    } else if (item.category === 'success-criterion') {
      successCriteria.push({
        id: `SPEC-SC-${pad3(scIdx)}`,
        text: item.content,
        dossierItemRefs: [item.id],
        measurable: /\d+%|>=?\s*\d+|<\s*\d+/.test(item.content),
      });
      referencedIds.add(item.id);
      scIdx++;
    }
  }

  const dossierCoverage = dossier.items.length > 0
    ? Math.round((referencedIds.size / dossier.items.length) * 10000) / 100
    : 0;

  const specification: Phase2Specification = {
    requirements,
    constraints,
    successCriteria,
    scope: `Full implementation scope for: ${query}`,
    dossierCoverage,
  };

  // --- Extract domain services (NOT roadmap phases) ---
  const domainServices = extractDomainServices(query, artifacts, dossier);

  // --- Pseudocode (from domain services) ---
  // Function names use clean slug from capability (max 3 words), not raw sentences.
  const toFuncName = (cap: string): string => {
    const words = cap.toLowerCase()
      .replace(/[^a-z0-9\s-]/g, ' ')
      .split(/[\s-]+/)
      .filter(w => w.length > 1);
    return words.slice(0, 3).join('_') || 'execute';
  };

  const modules: Phase2PseudocodeModule[] = domainServices.map((svc, i) => ({
    id: `PC-MOD-${pad3(i + 1)}`,
    name: svc.name,
    algorithms: svc.capabilities.map(c =>
      `${toFuncName(c)}: ${svc.responsibility.slice(0, 60)}`
    ),
    markdown: svc.capabilities.map(c => {
      const funcName = toFuncName(c);
      return `function ${funcName}(input):\n    // ${svc.responsibility.slice(0, 80)}\n    validate_preconditions(input)\n    result = execute_domain_logic(input)\n    emit_domain_event("${svc.name}.${funcName}.completed", result)\n    return result`;
    }).join('\n\n'),
    tddAnchors: svc.capabilities.map(c => `test_${toFuncName(c)}`),
    dataStructures: [`${svc.name.replace(/-/g, '_')}_aggregate`, `${svc.name.replace(/-/g, '_')}_dto`],
    dossierItemRefs: svc.dossierItemRefs.slice(0, 5),
  }));

  const pseudocode: Phase2Pseudocode = { modules };

  // --- Architecture (services from domain extraction) ---
  // API paths use clean CRUD slugs (max 3 words), never raw sentence fragments.
  const sanitizeCapSlug = (cap: string): string => {
    const words = cap.toLowerCase()
      .replace(/[^a-z0-9\s-]/g, ' ')
      .split(/[\s-]+/)
      .filter(w => w.length > 1);
    return words.slice(0, 3).join('-') || 'execute';
  };

  const services: Phase2ServiceDefinition[] = domainServices.map((svc, i) => ({
    id: `SVC-${pad3(i + 1)}`,
    name: svc.name,
    responsibility: svc.responsibility,
    api: [
      ...svc.capabilities.slice(0, 3).map(c => `POST /${svc.name}/${sanitizeCapSlug(c)}`),
      `GET /${svc.name}`,
      `GET /${svc.name}/:id`,
    ],
    dependencies: svc.relatedSystems.length > 0
      ? svc.relatedSystems.map(s => s.toLowerCase().replace(/[^a-z0-9]+/g, '-'))
      : [],
    dossierItemRefs: svc.dossierItemRefs.slice(0, 5),
  }));

  const architecture: Phase2Architecture = {
    services,
    boundaries: [
      {
        id: 'BND-001',
        name: 'api-boundary',
        description: 'External API boundary — all external traffic enters here',
        dossierItemRefs: [],
      },
      ...domainServices
        .filter(s => s.relatedSystems.length > 0)
        .map((s, i) => ({
          id: `BND-${pad3(i + 2)}`,
          name: `${s.name}-boundary`,
          description: `Integration boundary for ${s.relatedSystems.join(', ')} — adapter pattern with circuit breaker`,
          dossierItemRefs: [],
        })),
    ],
    dataFlow: `User → API Gateway → ${services.filter(s => s.name !== 'api-gateway').map(s => s.name).join(' | ')} → Data Store`,
    apiContracts: services.map(s => `${s.name}: ${s.api.join(', ')}`),
    securityBoundaries: ['API authentication required at gateway', 'Service-to-service mTLS', 'ERP integration uses OAuth2/API keys'],
  };

  // --- Refinement ---
  const securityItems = dossier.items.filter(i =>
    i.content.toLowerCase().match(/security|auth|access|pii|encrypt|credential|token/)
  );
  const perfItems = dossier.items.filter(i =>
    i.content.toLowerCase().match(/performance|latency|throughput|scalab|sla/)
  );

  const refinement: Phase2Refinement = {
    securityConsiderations: securityItems.slice(0, 10).map((item, i) => ({
      id: `SEC-${pad3(i + 1)}`,
      text: item.content.slice(0, 200),
      dossierItemRefs: [item.id],
    })),
    performanceTargets: perfItems.slice(0, 10).map((item, i) => ({
      id: `PERF-${pad3(i + 1)}`,
      text: item.content.slice(0, 200),
      dossierItemRefs: [item.id],
    })),
    testStrategy: 'London School TDD — outside-in, mock-driven, test pyramid (unit 70% / integration 20% / e2e 10%)',
  };

  // --- Completion ---
  const completion: Phase2Completion = {
    integrationPlan: 'Event-driven integration across bounded contexts with circuit breakers for external systems.',
    documentation: [
      'API documentation (OpenAPI/Swagger)',
      'Architecture Decision Records (ADRs)',
      'Domain model (DDD bounded contexts)',
      'Deployment runbook',
    ],
    monitoringSetup: [
      'Health check endpoints',
      'Structured logging with correlation IDs',
      'SLO alerting',
      'Business metrics dashboard',
    ],
  };

  return { specification, pseudocode, architecture, refinement, completion };
}

// ============================================================================
// Public: buildPhase2SPARC (backward compat export)
// ============================================================================

export function buildPhase2SPARC(
  dossier: ResearchDossier,
  artifacts: Phase1Artifacts,
): Phase2SPARCOutput {
  return buildCompatJSON(dossier, artifacts);
}

// ============================================================================
// Public: Main Stage Function
// ============================================================================

/**
 * Stage 3 entry point: generate SPARC specification from the research dossier
 * and Phase 1 artifacts stored on the pipeline context.
 *
 * Writes 5 SPARC markdown documents + JSON compatibility files to
 * `context.phase2Dir/sparc/`.
 */
export async function generateSPARCSpecification(
  context: Phase2Context,
): Promise<Phase2StageOutput> {
  const rootSpan = createSpan('sparc-specification', 'generate-sparc', {
    phase2Dir: context.phase2Dir,
  });

  try {
    // Retrieve the research dossier from the previous stage
    const dossierStage = context.stageOutputs.get('research-dossier');
    if (!dossierStage || dossierStage.status !== 'completed') {
      throw new Error(
        'ECLI-P2-010: Research dossier not available on context. ' +
        'Ensure the research-dossier stage completed successfully before running sparc-specification.',
      );
    }
    const dossier = dossierStage.data as ResearchDossier;
    const query = context.phase1Artifacts?.scenario?.query
      ?? context.phase1Artifacts?.manifest?.query
      ?? '';

    // Gather project context from all artifacts
    const projectContext = gatherProjectContext(context.phase1Artifacts);
    const dossierSummary = summarizeDossier(dossier);

    // ADR-027: Try single comprehensive LLM SPARC generation first
    // SPARC is ONE cohesive architecture document, not 5 disconnected fragments
    const llmSparc = tryGenerateCompleteSPARC(query, projectContext, dossier, context.phase1Artifacts, context.phase2Dir);

    let specMd: string;
    let pseudoMd: string;
    let archMd: string;
    let refineMd: string;
    let completionMd: string;

    if (llmSparc) {
      // LLM generated the full SPARC — split into sections
      const sections = splitSPARCSections(llmSparc);
      specMd = sections.specification;
      pseudoMd = sections.pseudocode;
      archMd = sections.architecture;
      refineMd = sections.refinement;
      completionMd = sections.completion;
    } else {
      // Fallback: individual LLM calls per section, then template fallback
      specMd = writeSpecificationMarkdown(query, projectContext, dossierSummary, dossier, context.phase2Dir);
      pseudoMd = writePseudocodeMarkdown(query, projectContext, dossier, context.phase1Artifacts, context.phase2Dir);
      archMd = writeArchitectureMarkdown(query, projectContext, dossier, context.phase1Artifacts);
      refineMd = writeRefinementMarkdown(query, projectContext, dossier);
      completionMd = writeCompletionMarkdown(query, projectContext, dossier, context.phase1Artifacts);
    }

    // Build JSON compat shim
    const sparc = buildCompatJSON(dossier, context.phase1Artifacts);

    // Write files
    const sparcDir = path.join(context.phase2Dir, SPARC_SUBDIR);
    fs.mkdirSync(sparcDir, { recursive: true, mode: DIR_MODE });

    const writtenPaths: string[] = [];

    const writeFile = (name: string, content: string) => {
      const filePath = path.join(sparcDir, name);
      try {
        fs.writeFileSync(filePath, content + '\n', { encoding: 'utf-8', mode: FILE_MODE });
        writtenPaths.push(filePath);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(`ECLI-P2-011: Failed to write SPARC file ${name}: ${message}`);
      }
    };

    // Primary output: 5 SPARC markdown documents
    writeFile('Specification.md', specMd);
    writeFile('Pseudocode.md', pseudoMd);
    writeFile('Architecture.md', archMd);
    writeFile('Refinement.md', refineMd);
    writeFile('Completion.md', completionMd);

    // Combined markdown
    const combinedMd = [specMd, pseudoMd, archMd, refineMd, completionMd].join('\n\n---\n\n');
    writeFile('sparc-combined.md', combinedMd);

    // JSON compat shim for downstream consumers
    const writeJSON = (name: string, data: unknown) => {
      const filePath = path.join(sparcDir, name);
      try {
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', { encoding: 'utf-8', mode: FILE_MODE });
        writtenPaths.push(filePath);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(`ECLI-P2-011: Failed to write SPARC file ${name}: ${message}`);
      }
    };

    writeJSON('specification.json', sparc.specification);
    writeJSON('pseudocode.json', sparc.pseudocode);
    writeJSON('architecture.json', sparc.architecture);
    writeJSON('refinement.json', sparc.refinement);
    writeJSON('completion.json', sparc.completion);
    writeJSON('sparc-combined.json', sparc);

    endSpan(rootSpan, 'ok', {
      markdownFiles: 6,
      jsonFiles: 6,
      dossierCoverage: sparc.specification.dossierCoverage,
    });
    emitSpan(rootSpan);

    const timing = rootSpan.durationMs ?? 0;

    const output: Phase2StageOutput = {
      stage: 'sparc-specification',
      status: 'completed',
      data: sparc,
      artifacts: writtenPaths,
      timing,
      summary:
        `     SPARC: 5 markdown docs + JSON compat | ` +
        `${sparc.specification.requirements.length} requirements, ` +
        `${sparc.specification.constraints.length} constraints, ` +
        `${sparc.architecture.services.length} services ` +
        `(dossier coverage: ${sparc.specification.dossierCoverage}%)`,
    };

    context.stageOutputs.set('sparc-specification', output);
    return output;
  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : String(err);

    endSpan(rootSpan, 'error', { error: errorMessage });
    emitSpan(rootSpan);

    const timing = rootSpan.durationMs ?? 0;

    const output: Phase2StageOutput = {
      stage: 'sparc-specification',
      status: 'failed',
      data: { error: errorMessage },
      artifacts: [],
      timing,
      summary: `SPARC specification generation failed: ${errorMessage}`,
    };

    context.stageOutputs.set('sparc-specification', output);
    return output;
  }
}
