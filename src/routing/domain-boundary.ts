/**
 * Domain Boundary Resolution (ADR-PIPELINE-082)
 *
 * Disambiguation rules for overlapping capability keywords and tie-break rules
 * for domain ownership. Used to resolve which domain should handle a query
 * when multiple domains could legitimately claim the same tag.
 *
 * Two rule types:
 *   1. DISAMBIGUATION_RULES — modifier-based routing (ADR-082 §3).
 *      "regression" alone → test_bench; "regression test" → quality_engineering.
 *   2. TIE_BREAK_RULES — priority resolution (ADR-082 §4).
 *      "security" always goes to safety (shield), never quality_engineering.
 *
 * This module is declarative; callers (capability classifier, agentics ask)
 * consult it to refine routing decisions. It performs no I/O and is safe to
 * import anywhere.
 */

// ============================================================================
// Types
// ============================================================================

/**
 * A disambiguation rule for a keyword that could route to multiple domains
 * depending on nearby modifiers in the prompt.
 */
export interface DisambiguationRule {
  /** Trigger keyword that activates this rule (lowercase). */
  readonly trigger: string;
  /** Ordered modifier patterns. First match wins. */
  readonly modifiers: readonly { pattern: RegExp; domain: string }[];
  /** Domain used when no modifier matches. */
  readonly defaultDomain: string;
  /** Human-readable rationale tied to ADR-082. */
  readonly note: string;
}

/**
 * A tie-break rule declaring that one domain always wins a keyword over
 * another. Used to enforce the capability ownership boundary from ADR-082 §1.
 */
export interface TieBreakRule {
  /** Keyword that triggers this rule (lowercase). */
  readonly keyword: string;
  /** The domain that wins — its capabilities stay. */
  readonly winner: string;
  /**
   * Domains whose capabilities are suppressed when this keyword is present
   * AND they would otherwise match. Empty means "both stay" (complementary).
   */
  readonly suppress: readonly string[];
  /** Human-readable rationale. */
  readonly note: string;
}

/** Result of resolving a prompt against the boundary rules. */
export interface BoundaryResolution {
  /** Disambiguation resolutions: keyword → winning domain. */
  readonly disambiguations: ReadonlyMap<string, string>;
  /** Suppressed domains — their capabilities should be filtered from routing. */
  readonly suppressedDomains: ReadonlySet<string>;
  /** Applied rules for explain/debug. */
  readonly appliedRules: readonly string[];
}

// ============================================================================
// Rules — ADR-082 §3
// ============================================================================

/**
 * Modifier-based disambiguation rules. Order within modifiers[] matters:
 * the first matching modifier wins, so more specific patterns come first.
 */
export const DISAMBIGUATION_RULES: readonly DisambiguationRule[] = [
  {
    trigger: 'regression',
    modifiers: [
      { pattern: /\btests?\b/i, domain: 'quality_engineering' },
      { pattern: /\b(models?|qualit(?:y|ies))\b/i, domain: 'test_bench' },
    ],
    defaultDomain: 'test_bench',
    note: 'ADR-082 §3: "regression test" → QE; "model regression" → test_bench',
  },
  {
    trigger: 'quality',
    modifiers: [
      { pattern: /\b(code|tests?)\s+qualit(?:y|ies)\b/i, domain: 'quality_engineering' },
      { pattern: /\b(models?|outputs?)\s+qualit(?:y|ies)\b/i, domain: 'test_bench' },
    ],
    defaultDomain: 'quality_engineering',
    note: 'ADR-082 §3: code/test quality → QE; model/output quality → test_bench',
  },
  {
    trigger: 'evaluation',
    modifiers: [
      { pattern: /\b(code|tests?|coverage|defects?)\b/i, domain: 'quality_engineering' },
      { pattern: /\b(models?|prompts?|llms?)\b/i, domain: 'test_bench' },
    ],
    defaultDomain: 'test_bench',
    note: 'ADR-082 §3: code/test evaluation → QE; model/prompt evaluation → test_bench',
  },
  {
    trigger: 'synthetic',
    modifiers: [
      { pattern: /\b(tests?|fixtures?|mocks?)\b/i, domain: 'quality_engineering' },
      { pattern: /\b(benchmarks?|datasets?|training)\b/i, domain: 'test_bench' },
    ],
    defaultDomain: 'test_bench',
    note: 'ADR-082 §3: synthetic test data → QE; synthetic benchmark data → test_bench',
  },
];

// ============================================================================
// Rules — ADR-082 §4
// ============================================================================

/**
 * Priority resolution: certain keywords always belong to one domain regardless
 * of what other domains might tag. Enforces the capability ownership boundary
 * declared in ADR-082 §1 (Shield owns security, Latency-Lens owns perf, etc.).
 *
 * Note on domain names: ecosystem.graph.json uses underscores
 * ("quality_engineering"), the CLI runner uses hyphens ("quality-engineering").
 * These rules use the graph names (underscored) to match what the classifier
 * emits.
 */
export const TIE_BREAK_RULES: readonly TieBreakRule[] = [
  // Safety (Shield) owns security (ADR-082 §1 + §4)
  { keyword: 'security', winner: 'safety', suppress: ['quality_engineering'], note: 'Shield owns security per ADR-082 §1' },
  { keyword: 'sast', winner: 'safety', suppress: ['quality_engineering'], note: 'Shield owns SAST per ADR-082 §1' },
  { keyword: 'dast', winner: 'safety', suppress: ['quality_engineering'], note: 'Shield owns DAST per ADR-082 §1' },
  { keyword: 'vulnerability', winner: 'safety', suppress: ['quality_engineering'], note: 'Shield owns vulnerability scanning per ADR-082 §1' },
  { keyword: 'penetration', winner: 'safety', suppress: ['quality_engineering'], note: 'Shield owns pentest per ADR-082 §1' },

  // Performance Profiling (Latency-Lens) owns perf measurement, QE complements with chaos stressing
  { keyword: 'latency', winner: 'performance_profiling', suppress: [], note: 'Latency-Lens owns perf measurement; QE complements via chaos. Both stay.' },
  { keyword: 'cold-start', winner: 'performance_profiling', suppress: [], note: 'Latency-Lens owns cold-start; ADR-082 §4' },

  // Data Privacy (Data-Vault) owns anonymization
  { keyword: 'anonymize', winner: 'data_security', suppress: ['quality_engineering'], note: 'Data-Vault owns anonymization per ADR-082 §1' },
  { keyword: 'pii', winner: 'safety', suppress: ['quality_engineering'], note: 'Shield owns PII detection per ADR-082 §1' },
  { keyword: 'redaction', winner: 'safety', suppress: ['quality_engineering'], note: 'Shield owns redaction per ADR-082 §1' },

  // ERP boundary (connector-hub + ERP-Surface, ADR-074)
  { keyword: 'sap', winner: 'connector_hub', suppress: ['quality_engineering'], note: 'ERP surface boundary — connector-hub owns SAP integration per ADR-082 §1 + ADR-074' },
  { keyword: 'oracle', winner: 'connector_hub', suppress: ['quality_engineering'], note: 'ERP surface boundary per ADR-074' },
  { keyword: 'workday', winner: 'connector_hub', suppress: ['quality_engineering'], note: 'ERP surface boundary per ADR-074' },
  { keyword: 'soap', winner: 'connector_hub', suppress: ['quality_engineering'], note: 'Enterprise integration surface per ADR-082 §1' },
  { keyword: 'odata', winner: 'connector_hub', suppress: ['quality_engineering'], note: 'Enterprise integration surface per ADR-082 §1' },

  // Memory/learning (Memory-Graph)
  { keyword: 'learning', winner: 'memory_context', suppress: ['quality_engineering'], note: 'Memory-Graph owns cross-session learning per ADR-082 §1' },
];

// ============================================================================
// Resolvers
// ============================================================================

/**
 * Apply ADR-082 boundary rules to a user prompt.
 * Returns disambiguation decisions and suppressed domains.
 */
export function resolveDomainBoundary(prompt: string): BoundaryResolution {
  const promptLower = prompt.toLowerCase();
  const disambiguations = new Map<string, string>();
  const suppressedDomains = new Set<string>();
  const appliedRules: string[] = [];

  // Disambiguation rules
  for (const rule of DISAMBIGUATION_RULES) {
    if (!wordPresent(promptLower, rule.trigger)) continue;

    let matched = false;
    for (const mod of rule.modifiers) {
      if (mod.pattern.test(prompt)) {
        disambiguations.set(rule.trigger, mod.domain);
        appliedRules.push(`disambiguation:${rule.trigger}→${mod.domain} (${rule.note})`);
        matched = true;
        break;
      }
    }
    if (!matched) {
      disambiguations.set(rule.trigger, rule.defaultDomain);
      appliedRules.push(`disambiguation:${rule.trigger}→${rule.defaultDomain} (default, ${rule.note})`);
    }
  }

  // Tie-break rules
  for (const rule of TIE_BREAK_RULES) {
    if (!wordPresent(promptLower, rule.keyword)) continue;
    for (const loser of rule.suppress) {
      suppressedDomains.add(loser);
    }
    if (rule.suppress.length > 0) {
      appliedRules.push(`tie-break:${rule.keyword}→${rule.winner} (suppress: ${rule.suppress.join(', ')})`);
    } else {
      appliedRules.push(`tie-break:${rule.keyword}→${rule.winner} (complementary, no suppression)`);
    }
  }

  return {
    disambiguations,
    suppressedDomains,
    appliedRules,
  };
}

/**
 * Check whether a domain should be filtered from routing given the prompt.
 * Convenience wrapper over resolveDomainBoundary.
 */
export function isDomainSuppressed(domain: string, prompt: string): boolean {
  return resolveDomainBoundary(prompt).suppressedDomains.has(domain);
}

/**
 * Resolve a single keyword to its routing domain, applying both disambiguation
 * and tie-break rules. Returns null if the keyword is not governed by any rule.
 */
export function routeKeyword(keyword: string, prompt: string): string | null {
  const keywordLower = keyword.toLowerCase();

  // Disambiguation takes precedence when a modifier matches
  for (const rule of DISAMBIGUATION_RULES) {
    if (rule.trigger !== keywordLower) continue;
    for (const mod of rule.modifiers) {
      if (mod.pattern.test(prompt)) return mod.domain;
    }
    return rule.defaultDomain;
  }

  // Fall through to tie-break rules
  for (const rule of TIE_BREAK_RULES) {
    if (rule.keyword === keywordLower) return rule.winner;
  }

  return null;
}

// ============================================================================
// Internals
// ============================================================================

/**
 * Test whether a keyword appears in the prompt as a whole word, allowing
 * common English inflections at the end (plural -s/-es/-ies, participle
 * -ed/-ing).
 *
 * Matches:  "security", "securities", "regression", "regressions"
 *           "vulnerability", "vulnerabilities", "cold-start", "cold-started"
 * Does not match: "insecurity" (no preceding word boundary)
 */
function wordPresent(promptLower: string, keyword: string): boolean {
  const escaped = keyword.replace(/[-\s]/g, '[-\\s]').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Allow up to 4 trailing letters to catch common stems (s, es, ed, ing, ies)
  // without matching unrelated long words. The leading boundary remains strict.
  const re = new RegExp(`(?:^|[^a-z0-9_])${escaped}[a-z]{0,4}(?:$|[^a-z0-9_])`, 'i');
  if (re.test(promptLower)) return true;

  // Handle -y → -ies plurals explicitly (e.g., "vulnerability" → "vulnerabilities")
  if (keyword.endsWith('y')) {
    const stem = keyword.slice(0, -1);
    const escapedStem = stem.replace(/[-\s]/g, '[-\\s]').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const iesRe = new RegExp(`(?:^|[^a-z0-9_])${escapedStem}ies(?:$|[^a-z0-9_])`, 'i');
    if (iesRe.test(promptLower)) return true;
  }

  return false;
}
