/**
 * Domain Boundary Resolution
 *
 * Disambiguation rules for overlapping capability keywords and tie-break rules
 * for domain ownership. Currently both rule lists are empty; the module is
 * retained as the extension point for future per-keyword routing overrides.
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
export const DISAMBIGUATION_RULES: readonly DisambiguationRule[] = [];

// ============================================================================
// Rules — ADR-082 §4
// ============================================================================

/**
 * Priority resolution: certain keywords always belong to one domain regardless
 * of what other domains might tag.
 */
export const TIE_BREAK_RULES: readonly TieBreakRule[] = [];

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
