/**
 * Capability Classifier (ADR-030)
 *
 * Extracts capability names from a user prompt by matching against
 * the ecosystem graph's capability names and tags.
 *
 * Classification strategy (ordered by priority):
 * 1. Exact match — prompt contains a capability name verbatim
 * 2. Tag match  — prompt contains a tag from a capability entry
 * 3. Description match — prompt words overlap with capability descriptions
 *
 * No LLM calls. Pure keyword extraction for deterministic, zero-latency routing.
 */

import type { EcosystemGraph, CapabilityEntry } from './graph-loader.js';

// ============================================================================
// Types
// ============================================================================

export interface ClassifiedCapability {
  /** Capability name from the graph. */
  readonly name: string;
  /** How the match was determined. */
  readonly matchType: 'exact' | 'tag' | 'description';
  /** The specific token(s) from the prompt that triggered the match. */
  readonly matchedTokens: readonly string[];
  /** Confidence score 0.0-1.0. Exact > tag > description. */
  readonly confidence: number;
}

export interface ClassificationResult {
  /** All matched capabilities, sorted by confidence descending. */
  readonly capabilities: readonly ClassifiedCapability[];
  /** Normalized prompt tokens used for matching. */
  readonly promptTokens: readonly string[];
}

// ============================================================================
// Tokenization
// ============================================================================

/**
 * Normalize and tokenize a user prompt for matching.
 * Produces lowercase tokens with punctuation stripped.
 */
function tokenize(prompt: string): string[] {
  return prompt
    .toLowerCase()
    .replace(/[^a-z0-9\s\-_]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length >= 2);
}

/**
 * Build a set of n-grams (1-gram, 2-gram, 3-gram) from tokens
 * for multi-word matching against tags like "cold-start" or "root-cause".
 */
function buildNgrams(tokens: string[]): Set<string> {
  const ngrams = new Set<string>();

  for (const token of tokens) {
    ngrams.add(token);
  }

  for (let i = 0; i < tokens.length - 1; i++) {
    ngrams.add(`${tokens[i]}-${tokens[i + 1]}`);
    ngrams.add(`${tokens[i]}_${tokens[i + 1]}`);
    ngrams.add(`${tokens[i]}${tokens[i + 1]}`);
  }

  for (let i = 0; i < tokens.length - 2; i++) {
    ngrams.add(`${tokens[i]}-${tokens[i + 1]}-${tokens[i + 2]}`);
    ngrams.add(`${tokens[i]}_${tokens[i + 1]}_${tokens[i + 2]}`);
  }

  return ngrams;
}

// ============================================================================
// Stop Words
// ============================================================================

/**
 * Common English stop words that should not trigger capability matches.
 */
const STOP_WORDS: ReadonlySet<string> = new Set([
  'the', 'is', 'at', 'which', 'on', 'for', 'to', 'in', 'of', 'and',
  'or', 'not', 'be', 'are', 'was', 'were', 'been', 'being', 'have',
  'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should',
  'may', 'might', 'shall', 'can', 'need', 'dare', 'ought', 'used',
  'this', 'that', 'these', 'those', 'am', 'an', 'as', 'but', 'by',
  'from', 'if', 'into', 'it', 'its', 'my', 'no', 'so', 'than',
  'too', 'very', 'just', 'about', 'above', 'after', 'all', 'also',
  'any', 'because', 'before', 'between', 'both', 'each', 'few',
  'how', 'me', 'more', 'most', 'much', 'must', 'nor', 'only', 'other',
  'our', 'out', 'over', 'own', 'same', 'she', 'some', 'such', 'then',
  'there', 'they', 'through', 'under', 'up', 'what', 'when', 'where',
  'who', 'why', 'with', 'you', 'your', 'we', 'he', 'her', 'him',
  'his', 'us', 'them', 'their', 'here',
]);

// ============================================================================
// Classifier
// ============================================================================

/**
 * Classify a user prompt against the ecosystem capability graph.
 *
 * Returns matched capabilities with confidence scores and match metadata.
 * Zero-cost: no LLM calls, no network, no async.
 */
export function classifyCapabilities(
  prompt: string,
  graph: EcosystemGraph,
): ClassificationResult {
  const tokens = tokenize(prompt);
  const significantTokens = tokens.filter(t => !STOP_WORDS.has(t));
  const ngrams = buildNgrams(significantTokens);
  const promptLower = prompt.toLowerCase();

  const matches = new Map<string, ClassifiedCapability>();

  for (const cap of graph.capabilities) {
    // Strategy 1: Exact capability name match
    // Normalize capability name for matching (e.g., "erp_integration" → "erp integration")
    const nameNormalized = cap.name.replace(/_/g, ' ').toLowerCase();
    const nameUnderscore = cap.name.toLowerCase();

    if (promptLower.includes(nameNormalized) || promptLower.includes(nameUnderscore)) {
      setMatch(matches, cap, 'exact', [cap.name], 1.0);
      continue;
    }

    // Also check individual name parts (e.g., "erp_integration" splits to "erp", "integration")
    const nameParts = cap.name.toLowerCase().split('_').filter(p => p.length >= 3);
    const namePartMatches = nameParts.filter(part => !STOP_WORDS.has(part) && ngrams.has(part));
    if (namePartMatches.length === nameParts.length && nameParts.length > 0) {
      setMatch(matches, cap, 'exact', namePartMatches, 0.95);
      continue;
    }

    // Strategy 2: Tag match
    const tagMatches = findTagMatches(cap, ngrams);
    if (tagMatches.length > 0) {
      // Confidence scales with number of matching tags, capped at 0.9
      const tagConfidence = Math.min(0.9, 0.5 + tagMatches.length * 0.1);
      setMatch(matches, cap, 'tag', tagMatches, tagConfidence);
      continue;
    }

    // Strategy 3: Description match (lowest confidence)
    if (cap.description) {
      const descTokens = tokenize(cap.description).filter(t => !STOP_WORDS.has(t) && t.length >= 3);
      const descMatches = descTokens.filter(dt => ngrams.has(dt));
      // Require at least 2 description word matches to avoid false positives
      if (descMatches.length >= 2) {
        const descConfidence = Math.min(0.6, 0.2 + descMatches.length * 0.1);
        setMatch(matches, cap, 'description', descMatches, descConfidence);
      }
    }
  }

  let capabilities = Array.from(matches.values())
    .sort((a, b) => b.confidence - a.confidence);

  // ADR-030 fallback: if no capabilities matched but the prompt is a
  // substantive enterprise scenario (>40 significant tokens), route to
  // ALL pipeline capabilities. Every `agentics ask` prompt describes an
  // enterprise problem that needs the full pipeline — falling through to
  // the 109-agent full-fleet dispatch wastes 20-30 minutes on agents that
  // mostly hit fallbacks. The graph-routed pipeline is faster and produces
  // the same Phase 2-6 chain.
  if (capabilities.length === 0 && significantTokens.length >= 40) {
    capabilities = graph.capabilities.map(cap => ({
      name: cap.name,
      matchType: 'description' as const,
      matchedTokens: ['enterprise-scenario-fallback'],
      confidence: 0.4,
    }));
  }

  return {
    capabilities,
    promptTokens: significantTokens,
  };
}

function findTagMatches(cap: CapabilityEntry, ngrams: Set<string>): string[] {
  if (!cap.tags || cap.tags.length === 0) return [];

  const matched: string[] = [];
  for (const tag of cap.tags) {
    const tagLower = tag.toLowerCase();
    if (ngrams.has(tagLower)) {
      matched.push(tag);
    }
  }
  return matched;
}

function setMatch(
  matches: Map<string, ClassifiedCapability>,
  cap: CapabilityEntry,
  matchType: 'exact' | 'tag' | 'description',
  matchedTokens: string[],
  confidence: number,
): void {
  const existing = matches.get(cap.name);
  // Only replace if higher confidence
  if (!existing || confidence > existing.confidence) {
    matches.set(cap.name, {
      name: cap.name,
      matchType,
      matchedTokens,
      confidence,
    });
  }
}

/**
 * Extract just the capability names from a classification result.
 * Convenience method for the router.
 */
export function extractCapabilityNames(result: ClassificationResult): string[] {
  return result.capabilities.map(c => c.name);
}
