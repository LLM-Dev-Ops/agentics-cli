/**
 * Phase 2 Stage 2 — Research Dossier Generation
 *
 * Pure extraction and cross-referencing engine that builds a structured
 * research dossier from Phase 1 artifacts. All extraction is deterministic:
 * sources are processed in a fixed order, items are sorted by category
 * within each source, IDs are assigned sequentially, and cross-references
 * are sorted by fromId then toId.
 *
 * Exports:
 *  - generateResearchDossier(context)  — async pipeline entry point
 *  - buildResearchDossier(artifacts, traceId) — pure, testable extraction
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import type {
  Phase2Context,
  Phase2StageOutput,
  Phase1Artifacts,
  ResearchDossier,
  DossierItem,
  DossierItemSource,
  DossierItemCategory,
  DossierCrossReference,
  DossierSummary,
  TelemetrySpan as ContextTelemetrySpan,
} from '../types.js';
import { ResearchDossierSchema } from '../schemas.js';
import { createSpan, endSpan, emitSpan } from '../telemetry.js';
import { createClaudeCodeRunner, isClaudeCodeRunnerAvailable } from '../../../runtime/claude-code-runner.js';

// ============================================================================
// Constants
// ============================================================================

const FILE_MODE = 0o600;
const DOSSIER_FILENAME = 'research-dossier.json';
const DOSSIER_MD_FILENAME = 'research-dossier.md';

/**
 * Fixed processing order for deterministic output. Sources are processed
 * in this exact sequence; items within each source are sorted by category.
 */
const SOURCE_ORDER: readonly DossierItemSource[] = [
  'scenario',
  'roadmap',
  'risk-assessment',
  'executive-summary',
  'decision-memo',
] as const;

/**
 * Category sort order for deterministic within-source ordering.
 * Lower index = earlier in the output.
 */
const CATEGORY_ORDER: readonly DossierItemCategory[] = [
  'requirement',
  'constraint',
  'stakeholder',
  'success-criterion',
  'timeline',
  'risk',
  'recommendation',
  'decision-rationale',
] as const;

// ============================================================================
// Safe accessor helpers
// ============================================================================

function safeStringArray(obj: unknown, key: string): string[] {
  if (!obj || typeof obj !== 'object') return [];
  const val = (obj as Record<string, unknown>)[key];
  return Array.isArray(val) ? val.filter((v): v is string => typeof v === 'string') : [];
}

function safeString(obj: unknown, key: string, fallback = ''): string {
  if (!obj || typeof obj !== 'object') return fallback;
  const val = (obj as Record<string, unknown>)[key];
  return typeof val === 'string' ? val : fallback;
}

// ============================================================================
// Markdown helpers
// ============================================================================

/**
 * Extract the body text below a level-2 heading, up to the next level-2
 * heading or end of file.
 *
 * @param md      - Full markdown text
 * @param heading - Heading text without the `## ` prefix
 * @returns Trimmed section body, or empty string if not found
 */
function extractMarkdownSection(md: string, heading: string): string {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`## ${escaped}\\s*\\n([\\s\\S]*?)(?=\\n## |$)`);
  const match = re.exec(md);
  return match?.[1]?.trim() ?? '';
}

/**
 * Extract items from bulleted or numbered list lines.
 * Matches lines starting with `- `, `* `, or `N. `.
 *
 * @param text - Text potentially containing list items
 * @returns Array of trimmed item texts (no bullet/number prefix)
 */
function extractListItems(text: string): string[] {
  const items: string[] = [];
  const re = /^(?:[-*]|\d+\.)\s+(.+)$/gm;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const item = match[1]?.trim();
    if (item) {
      items.push(item);
    }
  }
  return items;
}

/**
 * Truncate a string to `max` characters. If truncated, no ellipsis is added;
 * the caller decides how to present it.
 */
function truncate(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max);
}

/**
 * Extract the content after a label like "Required System Capabilities:" up to
 * the next label or section break (blank line followed by non-list content).
 */
function extractLabeledSection(text: string, label: string): string {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`${escaped}:?\\s*\\n([\\s\\S]*?)(?=\\n[A-Z][A-Za-z ]+:|\\n---|\$)`);
  const match = re.exec(text);
  return match?.[1]?.trim() ?? '';
}

/**
 * Extract all JSON code blocks from markdown text and parse them.
 */
function extractJsonCodeBlocks(md: string): unknown[] {
  const blocks: unknown[] = [];
  const re = /```json\s*\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(md)) !== null) {
    try {
      blocks.push(JSON.parse(match[1]!));
    } catch { /* skip malformed JSON */ }
  }
  return blocks;
}

/**
 * Safely traverse nested object paths. Returns unknown value at path or undefined.
 */
function getNestedValue(obj: unknown, ...keys: string[]): unknown {
  let current = obj;
  for (const key of keys) {
    if (!current || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

// ============================================================================
// Item extraction — one function per source
// ============================================================================

interface RawItem {
  source: DossierItemSource;
  category: DossierItemCategory;
  title: string;
  content: string;
  severity?: string;
  phase?: string;
}

function extractFromScenario(scenario: Phase1Artifacts['scenario']): RawItem[] {
  const items: RawItem[] = [];
  const scenarioAny = scenario as Record<string, unknown>;

  // Resolve query from multiple possible locations (flat or nested)
  const nestedScenario = scenarioAny.scenario as Record<string, unknown> | undefined;
  const nestedParams = nestedScenario?.parameters as Record<string, unknown> | undefined;
  const query =
    safeString(scenario, 'query') ||
    safeString(scenarioAny, 'query') ||
    safeString(nestedScenario, 'description') ||
    safeString(nestedParams, 'description') ||
    '';

  // Stakeholders from flat or nested
  const stakeholders = safeStringArray(scenario, 'stakeholders')
    .concat(safeStringArray(scenarioAny, 'stakeholders'));
  for (const name of stakeholders) {
    items.push({
      source: 'scenario',
      category: 'stakeholder',
      title: name,
      content: `Key stakeholder: ${name}`,
    });
  }

  // Constraints from flat array
  const constraints = safeStringArray(scenario, 'constraints')
    .concat(safeStringArray(scenarioAny, 'constraints'));
  for (const c of constraints) {
    items.push({
      source: 'scenario',
      category: 'constraint',
      title: truncate(c, 60),
      content: c,
    });
  }

  // Success criteria from flat array
  const criteria = safeStringArray(scenario, 'success_criteria')
    .concat(safeStringArray(scenarioAny, 'success_criteria'));
  for (const sc of criteria) {
    items.push({
      source: 'scenario',
      category: 'success-criterion',
      title: truncate(sc, 60),
      content: sc,
    });
  }

  // Domain entities → requirements
  const entities = safeStringArray(scenarioAny, 'domain_entities');
  for (const entity of entities) {
    items.push({
      source: 'scenario',
      category: 'requirement',
      title: `Domain Entity: ${entity}`,
      content: `The system must model and manage ${entity} as a core domain concept`,
    });
  }

  // Systems → constraints (integration requirements)
  const systems = safeStringArray(scenarioAny, 'systems');
  for (const sys of systems) {
    items.push({
      source: 'scenario',
      category: 'constraint',
      title: `Integration: ${sys}`,
      content: `The solution must integrate with ${sys} via its standard APIs`,
    });
  }

  // Capabilities → requirements
  const capabilities = safeStringArray(scenarioAny, 'capabilities');
  for (const cap of capabilities) {
    items.push({
      source: 'scenario',
      category: 'requirement',
      title: `Capability: ${truncate(cap, 50)}`,
      content: cap,
    });
  }

  // Scenario type → requirement
  const scenarioType = safeString(scenario, 'scenario_type') || safeString(scenarioAny, 'scenario_type');
  if (scenarioType) {
    items.push({
      source: 'scenario',
      category: 'requirement',
      title: `Domain: ${scenarioType}`,
      content: query || scenarioType,
    });
  }

  // Parse the query/description text for labeled sections
  // These are found in the simulation prompt: "Required System Capabilities:", "Simulation Constraints:", etc.
  if (query) {
    // Add scenario query as a requirement if no scenario_type was found
    if (!scenarioType) {
      const firstLine = query.split('\n')[0] ?? query;
      items.push({
        source: 'scenario',
        category: 'requirement',
        title: truncate(firstLine, 80),
        content: query,
      });
    }

    // Extract "Required System Capabilities:" → requirements
    const capabilities = extractLabeledSection(query, 'Required System Capabilities');
    if (capabilities) {
      for (const cap of extractListItems(capabilities)) {
        items.push({
          source: 'scenario',
          category: 'requirement',
          title: truncate(cap, 80),
          content: cap,
        });
      }
    }

    // Extract "Simulation Constraints:" → constraints
    const simConstraints = extractLabeledSection(query, 'Simulation Constraints');
    if (simConstraints && constraints.length === 0) {
      for (const c of extractListItems(simConstraints)) {
        items.push({
          source: 'scenario',
          category: 'constraint',
          title: truncate(c, 80),
          content: c,
        });
      }
    }

    // Extract "Enterprise Environment:" → constraints (technical)
    const envSection = extractLabeledSection(query, 'Enterprise Environment');
    if (envSection) {
      for (const e of extractListItems(envSection)) {
        items.push({
          source: 'scenario',
          category: 'constraint',
          title: truncate(e, 80),
          content: e,
        });
      }
    }

    // Extract "Outputs Required:" → success criteria
    const outputs = extractLabeledSection(query, 'Outputs Required');
    if (outputs && criteria.length === 0) {
      for (const o of extractListItems(outputs)) {
        items.push({
          source: 'scenario',
          category: 'success-criterion',
          title: truncate(o, 80),
          content: o,
        });
      }
    }

    // Extract "Execution Requirements:" → requirements
    const execReqs = extractLabeledSection(query, 'Execution Requirements');
    if (execReqs) {
      for (const line of execReqs.split('\n').filter((l) => l.trim().length > 0)) {
        const trimmed = line.trim().replace(/^Phase \d+:\s*/, '');
        if (trimmed) {
          items.push({
            source: 'scenario',
            category: 'requirement',
            title: truncate(trimmed, 80),
            content: trimmed,
          });
        }
      }
    }
  }

  return items;
}

function extractFromRoadmap(roadmap: Phase1Artifacts['roadmap']): RawItem[] {
  const items: RawItem[] = [];
  const phases = Array.isArray(roadmap.phases) ? roadmap.phases : [];

  for (const phase of phases) {
    const phaseName = safeString(phase, 'name', 'Unknown Phase');
    const deliverables = safeStringArray(phase, 'deliverables');
    for (const d of deliverables) {
      items.push({
        source: 'roadmap',
        category: 'timeline',
        title: truncate(d, 60),
        content: d,
        phase: phaseName,
      });
    }
  }

  return items;
}

function extractFromRiskAssessment(risk: Phase1Artifacts['riskAssessment']): RawItem[] {
  const items: RawItem[] = [];
  let factors = Array.isArray(risk.risk_factors) ? risk.risk_factors : [];

  // If top-level risk_factors is empty, check nested platform_risk_analysis.data.risk_factors
  if (factors.length === 0) {
    const riskAny = risk as Record<string, unknown>;
    const nestedFactors = getNestedValue(riskAny, 'platform_risk_analysis', 'data', 'risk_factors');
    if (Array.isArray(nestedFactors)) {
      factors = nestedFactors;
    }
  }

  for (const rf of factors) {
    // Handle both formats:
    //   Standard: { id, category, description, severity, likelihood, mitigation }
    //   Platform: { factor, score, weight, description }
    const rfAny = rf as Record<string, unknown>;
    const description = safeString(rf, 'description', '');
    const factor = safeString(rfAny, 'factor', '');

    let severity = safeString(rf, 'severity', '');
    if (!severity && typeof rfAny.score === 'number') {
      // Map numeric score to severity: 0-40=low, 41-60=medium, 61+=high
      const score = rfAny.score as number;
      severity = score >= 61 ? 'high' : score >= 41 ? 'medium' : 'low';
    }
    if (!severity) severity = 'medium';

    const category = safeString(rf, 'category', factor || 'general');
    const titleDesc = description || factor;

    items.push({
      source: 'risk-assessment',
      category: 'risk',
      title: `[${severity.toUpperCase()}] ${category}: ${titleDesc.slice(0, 80)}`,
      content: description || factor,
      severity,
    });
  }

  // Recommendations (top-level array on the risk assessment object)
  const recommendations = safeStringArray(risk, 'recommendations');
  for (const rec of recommendations) {
    items.push({
      source: 'risk-assessment',
      category: 'recommendation',
      title: truncate(rec, 60),
      content: rec,
    });
  }

  // Check nested mitigations from platform_risk_analysis.data.mitigations
  const riskAny = risk as Record<string, unknown>;
  const nestedMitigations = getNestedValue(riskAny, 'platform_risk_analysis', 'data', 'mitigations');
  if (Array.isArray(nestedMitigations)) {
    for (const m of nestedMitigations) {
      if (typeof m === 'string' && m.length > 0) {
        items.push({
          source: 'risk-assessment',
          category: 'recommendation',
          title: truncate(m, 60),
          content: m,
        });
      }
    }
  }

  // Check mitigation_strategy.immediate and ongoing
  const immediate = safeStringArray(riskAny, 'mitigation_strategy') || [];
  const mitigationStrategy = riskAny.mitigation_strategy as Record<string, unknown> | undefined;
  if (mitigationStrategy && typeof mitigationStrategy === 'object') {
    for (const key of ['immediate', 'ongoing'] as const) {
      const stratItems = safeStringArray(mitigationStrategy, key);
      for (const s of stratItems) {
        if (s && s !== 'No immediate mitigations required') {
          items.push({
            source: 'risk-assessment',
            category: 'recommendation',
            title: `[${key}] ${truncate(s, 50)}`,
            content: s,
          });
        }
      }
    }
  }
  void immediate; // suppress unused warning

  return items;
}

function extractFromExecutiveSummary(md: string): RawItem[] {
  const items: RawItem[] = [];

  // --- Parse ## heading-based sections (existing format) ---

  // Key Findings
  const findings = extractMarkdownSection(md, 'Key Findings');
  if (findings) {
    for (const f of extractListItems(findings)) {
      items.push({
        source: 'executive-summary',
        category: 'recommendation',
        title: f,
        content: f,
      });
    }
  }

  // Risk Factors (from executive summary, distinct from risk-assessment)
  const riskSection = extractMarkdownSection(md, 'Risk Factors');
  if (riskSection) {
    for (const r of extractListItems(riskSection)) {
      items.push({
        source: 'executive-summary',
        category: 'recommendation',
        title: r,
        content: r,
      });
    }
  }

  // Recommendation
  const recommendation = extractMarkdownSection(md, 'Recommendation');
  if (recommendation) {
    for (const r of extractListItems(recommendation)) {
      items.push({
        source: 'executive-summary',
        category: 'recommendation',
        title: r,
        content: r,
      });
    }
    if (extractListItems(recommendation).length === 0 && recommendation.length > 0) {
      items.push({
        source: 'executive-summary',
        category: 'recommendation',
        title: truncate(recommendation, 60),
        content: recommendation,
      });
    }
  }

  // Next Steps
  const nextSteps = extractMarkdownSection(md, 'Next Steps');
  if (nextSteps) {
    for (const step of extractListItems(nextSteps)) {
      items.push({
        source: 'executive-summary',
        category: 'recommendation',
        title: `Next Step: ${step}`,
        content: step,
      });
    }
  }

  // --- Parse label-based sections (e.g. "Required System Capabilities:") ---

  const capabilities = extractLabeledSection(md, 'Required System Capabilities');
  if (capabilities) {
    for (const cap of extractListItems(capabilities)) {
      items.push({
        source: 'executive-summary',
        category: 'requirement',
        title: truncate(cap, 80),
        content: cap,
      });
    }
  }

  const simConstraints = extractLabeledSection(md, 'Simulation Constraints');
  if (simConstraints) {
    for (const c of extractListItems(simConstraints)) {
      items.push({
        source: 'executive-summary',
        category: 'constraint',
        title: truncate(c, 80),
        content: c,
      });
    }
  }

  const outputsRequired = extractLabeledSection(md, 'Outputs Required');
  if (outputsRequired) {
    for (const o of extractListItems(outputsRequired)) {
      items.push({
        source: 'executive-summary',
        category: 'success-criterion',
        title: truncate(o, 80),
        content: o,
      });
    }
  }

  // --- Parse embedded JSON code blocks (Platform Analysis, Decision Context) ---
  const jsonBlocks = extractJsonCodeBlocks(md);
  for (const block of jsonBlocks) {
    if (!block || typeof block !== 'object') continue;
    const blockAny = block as Record<string, unknown>;
    const data = (blockAny.data ?? blockAny) as Record<string, unknown>;

    // key_findings → recommendations
    const keyFindings = data.key_findings;
    if (Array.isArray(keyFindings)) {
      for (const kf of keyFindings) {
        if (typeof kf === 'string') {
          items.push({
            source: 'executive-summary',
            category: 'recommendation',
            title: truncate(kf, 80),
            content: kf,
          });
        }
      }
    }

    // recommendation text → recommendation
    const recText = data.recommendation;
    if (typeof recText === 'string' && recText.length > 0) {
      items.push({
        source: 'executive-summary',
        category: 'recommendation',
        title: truncate(recText, 80),
        content: recText,
      });
    }

    // risks → risk items
    const risks = data.risks;
    if (Array.isArray(risks)) {
      for (const r of risks) {
        if (typeof r === 'string') {
          items.push({
            source: 'executive-summary',
            category: 'risk',
            title: truncate(r, 80),
            content: r,
            severity: 'medium',
          });
        }
      }
    }

    // next_steps → recommendations
    const stepsFromJson = data.next_steps;
    if (Array.isArray(stepsFromJson)) {
      for (const s of stepsFromJson) {
        if (typeof s === 'string') {
          items.push({
            source: 'executive-summary',
            category: 'recommendation',
            title: `Next Step: ${truncate(s, 70)}`,
            content: s,
          });
        }
      }
    }

    // options → decision-rationale
    const options = data.options;
    if (Array.isArray(options)) {
      for (const opt of options) {
        if (opt && typeof opt === 'object') {
          const optAny = opt as Record<string, unknown>;
          const optName = safeString(optAny, 'option', 'Option');
          const optDesc = safeString(optAny, 'description', '');
          const pros = safeStringArray(optAny, 'pros');
          const cons = safeStringArray(optAny, 'cons');
          const content = `${optDesc}${pros.length ? `\nPros: ${pros.join('; ')}` : ''}${cons.length ? `\nCons: ${cons.join('; ')}` : ''}`;
          items.push({
            source: 'executive-summary',
            category: 'decision-rationale',
            title: `Option: ${optName}`,
            content,
          });
        }
      }
    }
  }

  return items;
}

function extractFromDecisionMemo(md: string): RawItem[] {
  const items: RawItem[] = [];

  // --- Parse ## heading-based sections ---

  // Decision section
  const decision = extractMarkdownSection(md, 'Decision');
  if (decision) {
    items.push({
      source: 'decision-memo',
      category: 'decision-rationale',
      title: 'Primary Decision',
      content: decision,
    });
  }

  // Recommendation section (common in decision memos)
  const recSection = extractMarkdownSection(md, 'Recommendation');
  if (recSection) {
    items.push({
      source: 'decision-memo',
      category: 'decision-rationale',
      title: 'Recommendation',
      content: recSection,
    });
  }

  // Rationale numbered items
  const rationale = extractMarkdownSection(md, 'Rationale');
  if (rationale) {
    for (const item of extractListItems(rationale)) {
      items.push({
        source: 'decision-memo',
        category: 'decision-rationale',
        title: item,
        content: item,
      });
    }
  }

  // Alternatives Considered
  const alternatives = extractMarkdownSection(md, 'Alternatives Considered');
  if (alternatives) {
    for (const alt of extractListItems(alternatives)) {
      items.push({
        source: 'decision-memo',
        category: 'decision-rationale',
        title: `Alternative: ${alt}`,
        content: alt,
      });
    }
  }

  // Risk Summary section
  const riskSummary = extractMarkdownSection(md, 'Risk Summary');
  if (riskSummary) {
    for (const r of extractListItems(riskSummary)) {
      if (r !== 'No specific risk factors identified') {
        items.push({
          source: 'decision-memo',
          category: 'risk',
          title: truncate(r, 80),
          content: r,
          severity: 'medium',
        });
      }
    }
  }

  // Next Steps section
  const nextSteps = extractMarkdownSection(md, 'Next Steps');
  if (nextSteps) {
    for (const step of extractListItems(nextSteps)) {
      items.push({
        source: 'decision-memo',
        category: 'recommendation',
        title: truncate(step, 80),
        content: step,
      });
    }
  }

  // Conditions for Success
  const conditions = extractMarkdownSection(md, 'Conditions for Success');
  if (conditions) {
    for (const cond of extractListItems(conditions)) {
      items.push({
        source: 'decision-memo',
        category: 'constraint',
        title: cond,
        content: cond,
      });
    }
  }

  return items;
}

// ============================================================================
// Cross-reference generation
// ============================================================================

/**
 * Extract "significant" words from text: lowercased tokens longer than 4
 * characters, with common stop words removed.
 */
function significantWords(text: string): Set<string> {
  const stopWords = new Set([
    'about', 'above', 'after', 'again', 'being', 'below', 'between',
    'could', 'doing', 'during', 'every', 'further', 'having',
    'might', 'other', 'should', 'their', 'these', 'those', 'through',
    'under', 'until', 'where', 'which', 'while', 'would',
  ]);
  const words = text.toLowerCase().match(/[a-z]{5,}/g) ?? [];
  return new Set(words.filter((w) => !stopWords.has(w)));
}

/**
 * Count how many words two sets share.
 */
function sharedWordCount(a: Set<string>, b: Set<string>): number {
  let count = 0;
  for (const word of a) {
    if (b.has(word)) count++;
  }
  return count;
}

/**
 * Build deterministic cross-references between dossier items.
 *
 * Rules:
 *  1. Risk → Constraint sharing 3+ significant words → 'mitigates'
 *  2. Timeline item mentioning another item's title keyword → 'depends-on'
 *  3. Constraint → Requirement referencing constraint topic → 'constrains'
 *
 * References are sorted by (fromId, toId) for determinism.
 */
function buildCrossReferences(items: DossierItem[]): DossierCrossReference[] {
  const refs: DossierCrossReference[] = [];
  const seen = new Set<string>();

  const riskItems = items.filter((i) => i.category === 'risk');
  const constraintItems = items.filter((i) => i.category === 'constraint');
  const timelineItems = items.filter((i) => i.category === 'timeline');
  const requirementItems = items.filter((i) => i.category === 'requirement');

  // Precompute significant word sets
  const wordSets = new Map<string, Set<string>>();
  for (const item of items) {
    wordSets.set(item.id, significantWords(item.content));
  }

  // Rule 1: risk → constraint with 3+ shared significant words → 'mitigates'
  for (const risk of riskItems) {
    const riskWords = wordSets.get(risk.id)!;
    for (const constraint of constraintItems) {
      const constraintWords = wordSets.get(constraint.id)!;
      if (sharedWordCount(riskWords, constraintWords) >= 3) {
        const key = `${risk.id}:${constraint.id}`;
        if (!seen.has(key)) {
          seen.add(key);
          refs.push({
            fromId: risk.id,
            toId: constraint.id,
            relationship: 'mitigates',
          });
        }
      }
    }
  }

  // Rule 2: timeline items mentioning a dependency keyword from another item's title
  for (const timeline of timelineItems) {
    const tlContentLower = timeline.content.toLowerCase();
    for (const other of items) {
      if (other.id === timeline.id) continue;
      // Extract significant words from the other item's title
      const titleWords = significantWords(other.title);
      let matchCount = 0;
      for (const word of titleWords) {
        if (tlContentLower.includes(word)) {
          matchCount++;
        }
      }
      if (matchCount >= 1 && titleWords.size > 0) {
        const key = `${timeline.id}:${other.id}`;
        if (!seen.has(key)) {
          seen.add(key);
          refs.push({
            fromId: timeline.id,
            toId: other.id,
            relationship: 'depends-on',
          });
        }
      }
    }
  }

  // Rule 3: constraint → requirement where requirement content references
  // constraint topic (3+ shared significant words)
  for (const constraint of constraintItems) {
    const constraintWords = wordSets.get(constraint.id)!;
    for (const requirement of requirementItems) {
      const reqWords = wordSets.get(requirement.id)!;
      if (sharedWordCount(constraintWords, reqWords) >= 3) {
        const key = `${constraint.id}:${requirement.id}`;
        if (!seen.has(key)) {
          seen.add(key);
          refs.push({
            fromId: constraint.id,
            toId: requirement.id,
            relationship: 'constrains',
          });
        }
      }
    }
  }

  // Sort by fromId, then toId for determinism
  refs.sort((a, b) => {
    const cmp = a.fromId.localeCompare(b.fromId);
    return cmp !== 0 ? cmp : a.toId.localeCompare(b.toId);
  });

  return refs;
}

// ============================================================================
// Summary computation
// ============================================================================

/**
 * Build the dossier summary with counts, key risk IDs, and critical constraints.
 */
function buildDossierSummary(
  items: DossierItem[],
  crossRefs: DossierCrossReference[],
): DossierSummary {
  const bySource: Record<string, number> = {};
  const byCategory: Record<string, number> = {};

  for (const item of items) {
    bySource[item.source] = (bySource[item.source] ?? 0) + 1;
    byCategory[item.category] = (byCategory[item.category] ?? 0) + 1;
  }

  // Key risks: items with category 'risk' and severity 'high', sorted by ID
  const keyRisks = items
    .filter((i) => i.category === 'risk' && i.severity === 'high')
    .map((i) => i.id)
    .sort();

  // Critical constraints: first 5 constraint items, sorted by ID
  const criticalConstraints = items
    .filter((i) => i.category === 'constraint')
    .map((i) => i.id)
    .sort()
    .slice(0, 5);

  // The crossRefs parameter is accepted for future extensibility
  void crossRefs;

  return {
    totalItems: items.length,
    bySource,
    byCategory,
    keyRisks,
    criticalConstraints,
  };
}

// ============================================================================
// Core extraction: pure, deterministic, testable
// ============================================================================

/**
 * Build a complete research dossier from Phase 1 artifacts.
 *
 * This function is pure (no I/O, no side effects) and deterministic:
 * given the same artifacts and traceId it always produces the same output.
 *
 * @param artifacts - Loaded Phase 1 artifacts
 * @param traceId  - Trace identifier for provenance
 * @returns A fully populated ResearchDossier
 */
export function buildResearchDossier(
  artifacts: Phase1Artifacts,
  traceId: string,
): ResearchDossier {
  // Collect raw items in source order
  const rawBySource = new Map<DossierItemSource, RawItem[]>();

  rawBySource.set('scenario', extractFromScenario(artifacts.scenario));
  rawBySource.set('roadmap', extractFromRoadmap(artifacts.roadmap));
  rawBySource.set('risk-assessment', extractFromRiskAssessment(artifacts.riskAssessment));
  rawBySource.set('executive-summary', extractFromExecutiveSummary(artifacts.executiveSummary));
  rawBySource.set('decision-memo', extractFromDecisionMemo(artifacts.decisionMemo));

  // Build the ordered list: iterate sources in fixed order, sort items
  // within each source by category order
  const orderedRaw: RawItem[] = [];

  for (const source of SOURCE_ORDER) {
    const sourceItems = rawBySource.get(source) ?? [];
    // Stable sort by category order
    const sorted = [...sourceItems].sort((a, b) => {
      const aIdx = CATEGORY_ORDER.indexOf(a.category);
      const bIdx = CATEGORY_ORDER.indexOf(b.category);
      return aIdx - bIdx;
    });
    orderedRaw.push(...sorted);
  }

  // Assign sequential IDs: RD-001, RD-002, ...
  let counter = 0;
  const items: DossierItem[] = orderedRaw.map((raw) => {
    counter++;
    const item: DossierItem = {
      id: `RD-${String(counter).padStart(3, '0')}`,
      source: raw.source,
      category: raw.category,
      title: raw.title,
      content: raw.content,
      ...(raw.severity !== undefined ? { severity: raw.severity } : {}),
      ...(raw.phase !== undefined ? { phase: raw.phase } : {}),
    };
    return item;
  });

  // Cross-references
  const crossReferences = buildCrossReferences(items);

  // Summary
  const summary = buildDossierSummary(items, crossReferences);

  return {
    id: `dossier-${traceId}`,
    traceId,
    generatedFrom: artifacts.manifest.run_id,
    items,
    crossReferences,
    summary,
  };
}

// ============================================================================
// Markdown Rendering
// ============================================================================

/**
 * Render a research dossier as a human-readable markdown document.
 */
function renderDossierMarkdown(dossier: ResearchDossier): string {
  const lines: string[] = [];

  lines.push('# Research Dossier');
  lines.push('');
  lines.push(`> Trace ID: ${dossier.traceId}`);
  lines.push(`> Generated from: ${dossier.generatedFrom || 'Phase 1 simulation'}`);
  lines.push(`> Total items: ${dossier.items.length} | Cross-references: ${dossier.crossReferences.length}`);
  lines.push('');

  // Summary
  lines.push('## Summary');
  lines.push('');
  lines.push('| Source | Count |');
  lines.push('|--------|-------|');
  for (const [source, count] of Object.entries(dossier.summary.bySource)) {
    lines.push(`| ${source} | ${count} |`);
  }
  lines.push('');
  lines.push('| Category | Count |');
  lines.push('|----------|-------|');
  for (const [category, count] of Object.entries(dossier.summary.byCategory)) {
    lines.push(`| ${category} | ${count} |`);
  }
  lines.push('');

  if (dossier.summary.keyRisks.length > 0) {
    lines.push(`**Key Risks:** ${dossier.summary.keyRisks.join(', ')}`);
    lines.push('');
  }
  if (dossier.summary.criticalConstraints.length > 0) {
    lines.push(`**Critical Constraints:** ${dossier.summary.criticalConstraints.join(', ')}`);
    lines.push('');
  }

  // Group items by category
  const byCategory = new Map<string, DossierItem[]>();
  for (const item of dossier.items) {
    if (!byCategory.has(item.category)) byCategory.set(item.category, []);
    byCategory.get(item.category)!.push(item);
  }

  for (const [category, items] of byCategory) {
    const heading = category.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    lines.push(`## ${heading}`);
    lines.push('');
    for (const item of items) {
      const severity = item.severity ? ` [${item.severity}]` : '';
      const source = item.source ? ` _(${item.source})_` : '';
      lines.push(`### ${item.id}: ${item.title}${severity}`);
      lines.push('');
      lines.push(`${item.content}${source}`);
      lines.push('');
    }
  }

  // Cross-references
  if (dossier.crossReferences.length > 0) {
    lines.push('## Cross-References');
    lines.push('');
    lines.push('| From | To | Relationship |');
    lines.push('|------|----|-------------|');
    for (const ref of dossier.crossReferences) {
      lines.push(`| ${ref.fromId} | ${ref.toId} | ${ref.relationship} |`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

// ============================================================================
// Pipeline entry point
// ============================================================================

/**
 * Generate the research dossier as Stage 2 of the Phase 2 pipeline.
 *
 * 1. Creates a telemetry span
 * 2. Calls buildResearchDossier (pure extraction)
 * 3. Validates against ResearchDossierSchema (warn-only)
 * 4. Writes research-dossier.json to phase2Dir
 * 5. Stores output on context.stageOutputs
 * 6. Returns Phase2StageOutput
 *
 * @param context - Mutable Phase 2 pipeline context
 * @returns Stage output with status, timing, and artifact paths
 */
// ============================================================================
// ADR-027: LLM-Powered Domain Research
//
// The mechanical dossier re-slices the user's query into labeled items.
// This function calls Claude to generate ACTUAL domain research: industry
// terminology, real API surfaces, regulatory frameworks, domain entities
// with typed attributes, and technology-specific integration patterns.
// ============================================================================

function enrichDossierWithLLM(
  dossier: ResearchDossier,
  query: string,
  phase1Dir = '',
): void {
  if (!isClaudeCodeRunnerAvailable()) return;
  try {
    const runner = createClaudeCodeRunner();

    // Summarize what the mechanical extraction found
    const existingItems = dossier.items.slice(0, 15)
      .map(i => `- [${i.category}] ${i.title}`)
      .join('\n');

    // Load Phase 1 agent results if available (manifest tracks all 110 agents)
    let agentContext = '';
    try {
      const manifestPath = path.join(phase1Dir, 'manifest.json');
      if (phase1Dir && fs.existsSync(manifestPath)) {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as {
          agents_invoked?: Array<{ domain: string; agent: string; status: string }>;
        };
        if (manifest.agents_invoked && manifest.agents_invoked.length > 0) {
          const successAgents = manifest.agents_invoked.filter(a => a.status === 'success' || a.status === '200');
          const agentDomains = [...new Set(successAgents.map(a => a.domain))];
          agentContext = `\nAGENTICS FLEET: ${successAgents.length} agents across ${agentDomains.length} domains completed analysis: ${agentDomains.slice(0, 15).join(', ')}.\n` +
            `These agents (copilot/planner, research-lab/hypothesis, connector-hub/erp-surface, etc.) have already analyzed this domain. Build on their findings.\n`;
        }
      }
    } catch { /* non-fatal */ }

    const prompt =
      `You are a senior enterprise architect conducting deep domain research.\n` +
      `\nCLIENT REQUEST: ${query}\n` +
      (agentContext ? agentContext : '') +
      `\nMECHANICAL EXTRACTION (already found):\n${existingItems}\n` +
      `\nConduct REAL domain research and produce additional findings. You MUST include:\n` +
      `\n1. DOMAIN ENTITIES: Key business objects with their typed attributes (e.g., "TradePosition: instrument_id: string, quantity: number, mark_to_market: number, counterparty_id: string")\n` +
      `2. REAL API SURFACES: Actual API names for any mentioned systems (e.g., for SAP: API_BUSINESS_PARTNER, API_PRODUCT_SRV; for Salesforce: /services/data/vXX/sobjects). Do NOT fabricate — only name APIs you know exist.\n` +
      `3. REGULATORY FRAMEWORKS: Real regulations relevant to this domain (e.g., EMIR, MiFID II, SOX, HIPAA, GDPR — only those actually applicable)\n` +
      `4. DOMAIN ALGORITHMS: Key calculations and business rules (e.g., Value at Risk, demand forecasting, yield optimization — specific to this domain)\n` +
      `5. INTEGRATION PATTERNS: How the mentioned systems actually connect (batch vs real-time, event-driven, ETL, CDC)\n` +
      `6. KEY STAKEHOLDERS: Real roles in this domain (e.g., Chief Risk Officer, Floor Trader, Compliance Officer — not generic "Employees")\n` +
      `7. FAILURE MODES: Domain-specific risks (e.g., stale market data, position limit breaches, settlement failures)\n` +
      `\nReturn a JSON object:\n` +
      `{\n` +
      `  "items": [\n` +
      `    {\n` +
      `      "category": "requirement|constraint|stakeholder|risk|recommendation|decision-rationale",\n` +
      `      "title": "Short descriptive title",\n` +
      `      "content": "Detailed domain-specific finding with real terminology",\n` +
      `      "severity": "high|medium|low"\n` +
      `    }\n` +
      `  ]\n` +
      `}\n` +
      `\nCRITICAL: Include REAL domain knowledge from your training. Real API names, real regulatory frameworks, real industry terminology. This research drives all downstream code generation.`;

    const result = runner.invoke<Record<string, unknown>>(prompt, {
      runId: `research-llm-${Date.now()}`,
      timeoutMs: 120_000, // 2 min — LLM enrichment
    });

    const data = result.data as Record<string, unknown>;

    // Extract items from response (may be direct JSON or wrapped in content)
    let llmItems: Array<{ category: string; title: string; content: string; severity?: string }> | undefined;

    if (Array.isArray(data.items)) {
      llmItems = data.items as typeof llmItems;
    } else if (typeof data.content === 'string') {
      try {
        const parsed = JSON.parse(data.content);
        if (Array.isArray(parsed.items)) llmItems = parsed.items;
      } catch { /* not JSON */ }
    }

    if (!llmItems || llmItems.length === 0) {
      process.stderr.write('[research-dossier] LLM research: no items in response\n');
      return;
    }

    // Merge LLM items into dossier
    const validCategories = new Set<DossierItemCategory>([
      'requirement', 'constraint', 'stakeholder', 'success-criterion',
      'timeline', 'risk', 'recommendation', 'decision-rationale',
    ]);

    let addedCount = 0;
    for (const item of llmItems) {
      const category = validCategories.has(item.category as DossierItemCategory)
        ? item.category as DossierItemCategory
        : 'recommendation';
      const nextId = `RD-${String(dossier.items.length + 1).padStart(3, '0')}`;
      dossier.items.push({
        id: nextId,
        source: 'decision-memo' as DossierItemSource, // LLM research attributed to decision-memo
        category,
        title: (item.title || '').slice(0, 200),
        content: (item.content || '').slice(0, 1000),
        severity: item.severity,
      });
      addedCount++;
    }

    // Rebuild summary
    (dossier as { summary: DossierSummary }).summary = buildDossierSummary(dossier.items, dossier.crossReferences);

    process.stderr.write(
      `[research-dossier] LLM domain research: added ${addedCount} items in ${result.durationMs}ms\n`
    );
  } catch (err: unknown) {
    process.stderr.write(
      `[research-dossier] LLM research enrichment failed (using mechanical dossier): ${err instanceof Error ? err.message : String(err)}\n`
    );
  }
}

export async function generateResearchDossier(
  context: Phase2Context,
): Promise<Phase2StageOutput> {
  const span = createSpan('research-dossier', 'generate', { traceId: context.traceId });
  const startTime = Date.now();

  try {
    // Mechanical extraction from Phase 1 artifacts
    const dossier = buildResearchDossier(context.phase1Artifacts, context.traceId);

    // ADR-027: Enrich with LLM-generated domain research (real APIs, regulations, entities)
    const query = context.phase1Artifacts?.scenario?.query
      ?? (context.phase1Artifacts?.manifest as unknown as Record<string, unknown>)?.['query'] as string
      ?? '';
    if (query) {
      enrichDossierWithLLM(dossier, query, context.phase1Dir);
    }

    // Incorporate agent results (research-lab, copilot, etc.) from pre-dispatch
    const runDir = path.dirname(context.phase2Dir);
    const agentReportPath = path.join(runDir, '.pre-phase2', 'agentics-agents-report.json');
    try {
      if (fs.existsSync(agentReportPath)) {
        const report = JSON.parse(fs.readFileSync(agentReportPath, 'utf-8')) as {
          results: Array<{ domain: string; agent: string; role: string; status: number; response: unknown }>;
        };
        let agentItemCount = 0;
        for (const r of report.results) {
          if (r.status !== 200) continue;
          const resp = r.response as Record<string, unknown> | undefined;
          const data = resp?.['data'] as Record<string, unknown> | undefined;
          if (!data) continue;

          // research-lab/hypothesis → dossier recommendation item
          if (r.domain === 'research-lab' && r.agent === 'hypothesis') {
            const hyp = data['hypothesis'] as Record<string, unknown> | undefined;
            if (hyp) {
              const nextId = `RD-${String(dossier.items.length + 1).padStart(3, '0')}`;
              dossier.items.push({
                id: nextId,
                source: 'decision-memo' as DossierItemSource,
                category: 'recommendation' as DossierItemCategory,
                title: (hyp['statement'] as string || 'Research hypothesis').slice(0, 200),
                content: `Hypothesis: ${hyp['statement'] || 'N/A'}. Null hypothesis: ${hyp['null_hypothesis'] || 'N/A'}. Test type: ${hyp['test_type'] || 'A/B'}. Sample size required: ${hyp['sample_size_required'] || 'TBD'}. Confidence level: ${hyp['confidence_level'] || 0.95}. (Source: research-lab/hypothesis agent)`,
              });
              agentItemCount++;
            }
          }

          // research-lab/metrics → dossier success-criterion items
          if (r.domain === 'research-lab' && r.agent === 'metrics') {
            const metrics = data['metrics'] as Record<string, unknown> | undefined;
            const kpis = (metrics?.['kpis'] as Array<Record<string, unknown>>) ?? [];
            for (const kpi of kpis) {
              const nextId = `RD-${String(dossier.items.length + 1).padStart(3, '0')}`;
              dossier.items.push({
                id: nextId,
                source: 'decision-memo' as DossierItemSource,
                category: 'success-criterion' as DossierItemCategory,
                title: `KPI: ${kpi['name'] || 'unnamed'}`,
                content: `Target KPI "${kpi['name']}": current value ${kpi['value']} ${kpi['unit'] || ''}, trend: ${kpi['trend'] || 'unknown'}. (Source: research-lab/metrics agent)`,
              });
              agentItemCount++;
            }
          }

          // copilot/planner → dossier requirement items
          if (r.domain === 'copilot' && r.agent === 'planner') {
            const plan = data['plan'] as Record<string, unknown> | undefined;
            const steps = (plan?.['steps'] as Array<Record<string, unknown>>) ?? [];
            for (const step of steps.slice(0, 5)) {
              const nextId = `RD-${String(dossier.items.length + 1).padStart(3, '0')}`;
              dossier.items.push({
                id: nextId,
                source: 'scenario' as DossierItemSource,
                category: 'requirement' as DossierItemCategory,
                title: (step['title'] as string || step['description'] as string || 'Planning step').slice(0, 200),
                content: `${step['description'] || step['title'] || 'Planning requirement'}. (Source: copilot/planner agent)`,
              });
              agentItemCount++;
            }
          }
        }
        if (agentItemCount > 0) {
          console.error(`  [DOSSIER] Incorporated ${agentItemCount} items from agentics agents (research-lab, copilot)`);
          // Rebuild summary with new items
          (dossier as { summary: DossierSummary }).summary = buildDossierSummary(dossier.items, dossier.crossReferences);
        }
      }
    } catch {
      // Non-fatal — agent result incorporation should never block dossier generation
    }

    // Schema validation (warn-only, never blocks)
    try {
      ResearchDossierSchema.parse({
        items: dossier.items,
        crossReferences: dossier.crossReferences,
        summary: dossier.summary,
        generatedAt: new Date().toISOString(),
        sourceManifest: dossier.generatedFrom,
      });
    } catch (validationError: unknown) {
      const msg = validationError instanceof Error ? validationError.message : String(validationError);
      console.error(`  [WARN] research-dossier schema validation failed: ${msg}`);
    }

    // Write JSON to disk
    const outputPath = path.join(context.phase2Dir, DOSSIER_FILENAME);
    const content = JSON.stringify(dossier, null, 2);
    fs.writeFileSync(outputPath, content, { encoding: 'utf-8', mode: FILE_MODE });

    // Write Markdown to disk
    const mdOutputPath = path.join(context.phase2Dir, DOSSIER_MD_FILENAME);
    const mdContent = renderDossierMarkdown(dossier);
    fs.writeFileSync(mdOutputPath, mdContent, { encoding: 'utf-8', mode: FILE_MODE });

    const timing = Date.now() - startTime;

    const output: Phase2StageOutput = {
      stage: 'research-dossier',
      status: 'completed',
      data: dossier,
      artifacts: [outputPath, mdOutputPath],
      timing,
      summary: `Extracted ${dossier.items.length} items, ${dossier.crossReferences.length} cross-references from ${SOURCE_ORDER.length} sources`,
    };

    context.stageOutputs.set('research-dossier', output);

    endSpan(span, 'ok', {
      itemCount: dossier.items.length,
      crossRefCount: dossier.crossReferences.length,
      timingMs: timing,
    });
    emitSpan(span);
    context.telemetrySpans.push(span as unknown as ContextTelemetrySpan);

    return output;
  } catch (error: unknown) {
    const timing = Date.now() - startTime;
    const msg = error instanceof Error ? error.message : String(error);

    endSpan(span, 'error', { error: msg, timingMs: timing });
    emitSpan(span);
    context.telemetrySpans.push(span as unknown as ContextTelemetrySpan);

    const output: Phase2StageOutput = {
      stage: 'research-dossier',
      status: 'failed',
      data: null,
      artifacts: [],
      timing,
      summary: `Research dossier generation failed: ${msg}`,
    };

    context.stageOutputs.set('research-dossier', output);

    return output;
  }
}
