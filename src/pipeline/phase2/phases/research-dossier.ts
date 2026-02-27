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

// ============================================================================
// Constants
// ============================================================================

const FILE_MODE = 0o600;
const DOSSIER_FILENAME = 'research-dossier.json';

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

  // Stakeholders
  const stakeholders = safeStringArray(scenario, 'stakeholders');
  for (const name of stakeholders) {
    items.push({
      source: 'scenario',
      category: 'stakeholder',
      title: name,
      content: `Key stakeholder: ${name}`,
    });
  }

  // Constraints
  const constraints = safeStringArray(scenario, 'constraints');
  for (const c of constraints) {
    items.push({
      source: 'scenario',
      category: 'constraint',
      title: truncate(c, 60),
      content: c,
    });
  }

  // Success criteria
  const criteria = safeStringArray(scenario, 'success_criteria');
  for (const sc of criteria) {
    items.push({
      source: 'scenario',
      category: 'success-criterion',
      title: truncate(sc, 60),
      content: sc,
    });
  }

  // Scenario type → requirement
  const scenarioType = safeString(scenario, 'scenario_type');
  const query = safeString(scenario, 'query');
  if (scenarioType) {
    items.push({
      source: 'scenario',
      category: 'requirement',
      title: `Domain: ${scenarioType}`,
      content: query || scenarioType,
    });
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
  const factors = Array.isArray(risk.risk_factors) ? risk.risk_factors : [];

  for (const rf of factors) {
    const severity = safeString(rf, 'severity', 'unknown');
    const category = safeString(rf, 'category', 'general');
    const description = safeString(rf, 'description', '');
    items.push({
      source: 'risk-assessment',
      category: 'risk',
      title: `[${severity.toUpperCase()}] ${category}: ${description.slice(0, 50)}`,
      content: description,
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

  return items;
}

function extractFromExecutiveSummary(md: string): RawItem[] {
  const items: RawItem[] = [];

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
    // If no list items but section has content, treat entire section as one item
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

  return items;
}

function extractFromDecisionMemo(md: string): RawItem[] {
  const items: RawItem[] = [];

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
export async function generateResearchDossier(
  context: Phase2Context,
): Promise<Phase2StageOutput> {
  const span = createSpan('research-dossier', 'generate', { traceId: context.traceId });
  const startTime = Date.now();

  try {
    // Pure extraction
    const dossier = buildResearchDossier(context.phase1Artifacts, context.traceId);

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

    // Write to disk
    const outputPath = path.join(context.phase2Dir, DOSSIER_FILENAME);
    const content = JSON.stringify(dossier, null, 2);
    fs.writeFileSync(outputPath, content, { encoding: 'utf-8', mode: FILE_MODE });

    const timing = Date.now() - startTime;

    const output: Phase2StageOutput = {
      stage: 'research-dossier',
      status: 'completed',
      data: dossier,
      artifacts: [outputPath],
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
