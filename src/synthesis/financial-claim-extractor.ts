/**
 * ADR-PIPELINE-067: Financial Claim Extractor
 *
 * Parses rendered executive markdown and returns a structured list of
 * FinancialClaim records. Used by the cross-document consistency runner to
 * compare dollar figures, timelines, and scope labels across documents.
 *
 * Pure functions. Regex-based — no LLM calls.
 *
 * Renderers can short-circuit extraction by emitting an HTML comment tag
 * immediately before the figure:
 *
 *   <!-- fcv:kind=investment scope=pilot -->
 *   **Pilot investment:** $1.0M–$1.4M
 */

export type FinancialClaimDocument =
  | 'executive-summary'
  | 'decision-memo'
  | 'roadmap'
  | 'business-case'
  | 'risk-register'
  | 'financial-analysis'
  | 'unknown';

export type FinancialClaimKind =
  | 'investment'
  | 'savings'
  | 'timeline'
  | 'headcount'
  | 'roi'
  | 'npv';

export type FinancialClaimScope =
  | 'pilot'
  | 'phase-1'
  | 'phase-2'
  | 'phase-3'
  | 'full-program'
  | 'unscoped';

export type FinancialClaimUnit = 'USD' | 'weeks' | 'months' | 'years' | 'count' | 'percent';

export interface FinancialClaim {
  readonly document: FinancialClaimDocument;
  readonly section: string;
  readonly kind: FinancialClaimKind;
  readonly scope: FinancialClaimScope;
  readonly rangeLow?: number;
  readonly rangeHigh?: number;
  readonly pointValue?: number;
  readonly unit: FinancialClaimUnit;
  readonly rawText: string;
  readonly line: number;
  /** True when the claim was pulled from an explicit fcv: HTML comment tag. */
  readonly tagged: boolean;
  /**
   * ADR-PIPELINE-073: when the tag carried a `doc=` field, this holds its
   * value. FCR-012 fires when this disagrees with the enclosing document.
   */
  readonly docTag?: FinancialClaimDocument;
}

/**
 * ADR-PIPELINE-073: Documents that MUST carry authoritative fcv tags on
 * every money figure. Untagged money figures in these docs fire FCR-011.
 * Other documents (narrative memos, agent output) continue to use
 * proximity-based scope detection as a fallback.
 */
export const EXPECTS_TAGS: ReadonlySet<FinancialClaimDocument> = new Set<FinancialClaimDocument>([
  'executive-summary',
  'decision-memo',
  'financial-analysis',
  'roadmap',
  'business-case',
]);

// ============================================================================
// Currency / money parsing
// ============================================================================

const CURRENCY_SUFFIX: Record<string, number> = {
  K: 1_000,
  M: 1_000_000,
  B: 1_000_000_000,
};

/**
 * Parse a single currency token like "$1.2M", "$600K", "$1,200,000",
 * "USD 1.2M", or "1.2 million dollars". Returns NaN when the input does not
 * look like a currency amount.
 */
export function parseCurrency(token: string): number {
  const cleaned = token.trim().replace(/\s+/g, ' ');

  // "$1.2M" / "$600K" / "$1.2B"
  const suffixMatch = cleaned.match(/^\$?\s*([\d.]+)\s*([KMB])\b/i);
  if (suffixMatch) {
    const num = parseFloat(suffixMatch[1]!);
    const mult = CURRENCY_SUFFIX[suffixMatch[2]!.toUpperCase()] ?? 1;
    if (!Number.isNaN(num)) return num * mult;
  }

  // "USD 1.2M"
  const usdMatch = cleaned.match(/^USD\s*([\d.]+)\s*([KMB])?\b/i);
  if (usdMatch) {
    const num = parseFloat(usdMatch[1]!);
    const mult = usdMatch[2] ? (CURRENCY_SUFFIX[usdMatch[2]!.toUpperCase()] ?? 1) : 1;
    if (!Number.isNaN(num)) return num * mult;
  }

  // "1.2 million dollars" / "600 thousand dollars" — check BEFORE plain match
  // so the magnitude word is consumed before the bare number branch.
  const spelledMatch = cleaned.match(/^([\d.]+)\s*(thousand|million|billion)\s*(?:dollars?|USD)?/i);
  if (spelledMatch) {
    const num = parseFloat(spelledMatch[1]!);
    const mults: Record<string, number> = { thousand: 1_000, million: 1_000_000, billion: 1_000_000_000 };
    const mult = mults[spelledMatch[2]!.toLowerCase()] ?? 1;
    if (!Number.isNaN(num)) return num * mult;
  }

  // "$1,200,000" or "$600,000" — bare number must have a $ prefix to avoid
  // consuming the "1.2" in "1.2 million" before the spelled branch runs.
  const plainMatch = cleaned.match(/^\$\s*([\d,]+(?:\.\d+)?)\b/);
  if (plainMatch) {
    const num = parseFloat(plainMatch[1]!.replace(/,/g, ''));
    if (!Number.isNaN(num) && num > 0) return num;
  }

  return NaN;
}

// Currency range: "$1.2M–$1.4M" / "$1.2M - $1.4M" / "$1.2M to $1.4M"
const CURRENCY_RANGE_RE =
  /\$[\d.,]+\s*[KMB]?(?:\s*(?:[-–—]|to)\s*\$?[\d.,]+\s*[KMB]?)?/gi;

// ============================================================================
// Scope label detection
// ============================================================================

const SCOPE_PATTERNS: Array<{ re: RegExp; scope: FinancialClaimScope }> = [
  { re: /\b(?:pilot|phase[\s-]?1|first[\s-]phase)\b/i, scope: 'phase-1' },
  { re: /\bphase[\s-]?2\b/i, scope: 'phase-2' },
  { re: /\bphase[\s-]?3\b/i, scope: 'phase-3' },
  { re: /\b(?:full\s*(?:program|deployment|rollout|scale)|enterprise[\s-]wide|full[\s-]program)\b/i, scope: 'full-program' },
];

function detectScope(context: string): FinancialClaimScope {
  const lower = context.toLowerCase();
  if (/\bpilot\b/.test(lower)) return 'pilot';
  for (const { re, scope } of SCOPE_PATTERNS) {
    if (re.test(context)) return scope;
  }
  return 'unscoped';
}

/**
 * Scope detection around a specific match index. Scans a ±WINDOW char
 * window centered on the match and chooses the nearest scope keyword. This
 * lets a single line like "$1.0M pilot, $2.7M–$4.1M full deployment"
 * assign different scopes to each figure.
 */
function detectScopeNearIndex(
  context: string,
  matchStart: number,
  matchEnd: number,
): FinancialClaimScope {
  const WINDOW = 60;
  const start = Math.max(0, matchStart - WINDOW);
  const end = Math.min(context.length, matchEnd + WINDOW);
  const window = context.slice(start, end);

  // Find all scope hits in the window with their distances to the match.
  type Hit = { scope: FinancialClaimScope; distance: number };
  const hits: Hit[] = [];
  const scanners: Array<{ re: RegExp; scope: FinancialClaimScope }> = [
    { re: /\bpilot\b/gi, scope: 'pilot' },
    { re: /\bphase[\s-]?1\b|first[\s-]phase/gi, scope: 'phase-1' },
    { re: /\bphase[\s-]?2\b/gi, scope: 'phase-2' },
    { re: /\bphase[\s-]?3\b/gi, scope: 'phase-3' },
    { re: /\b(?:full\s*(?:program|deployment|rollout|scale)|enterprise[\s-]wide|full[\s-]program)\b/gi, scope: 'full-program' },
  ];

  for (const s of scanners) {
    let m: RegExpExecArray | null;
    s.re.lastIndex = 0;
    while ((m = s.re.exec(window)) !== null) {
      const absIdx = start + m.index;
      const distance =
        absIdx < matchStart ? matchStart - absIdx : absIdx - matchEnd;
      hits.push({ scope: s.scope, distance });
      if (m.index === s.re.lastIndex) s.re.lastIndex++;
    }
  }

  if (hits.length === 0) {
    // Fall back to a broader context scan — may return 'pilot' etc.
    return detectScope(context);
  }
  hits.sort((a, b) => a.distance - b.distance);
  return hits[0]!.scope;
}

// ============================================================================
// Tag parser — HTML comment pre-annotations
// ============================================================================

interface Tag {
  kind?: FinancialClaimKind;
  scope?: FinancialClaimScope;
  unit?: FinancialClaimUnit;
  /** ADR-PIPELINE-073: document identity for cross-document contamination checks. */
  doc?: FinancialClaimDocument;
}

const TAG_RE = /<!--\s*fcv:([^>]+?)\s*-->/;
/** Global flag for the extractor's inline-tag counting pass. */
const TAG_RE_G = /<!--\s*fcv:([^>]+?)\s*-->/g;

function parseTag(line: string): Tag | null {
  const m = line.match(TAG_RE);
  if (!m) return null;
  const tag: Tag = {};
  for (const pair of m[1]!.split(/\s+/)) {
    const eq = pair.indexOf('=');
    if (eq === -1) continue;
    const key = pair.slice(0, eq).trim();
    const val = pair.slice(eq + 1).trim();
    if (key === 'kind') tag.kind = val as FinancialClaimKind;
    else if (key === 'scope') tag.scope = val as FinancialClaimScope;
    else if (key === 'unit') tag.unit = val as FinancialClaimUnit;
    else if (key === 'doc') tag.doc = val as FinancialClaimDocument;
  }
  return tag;
}

/** ADR-PIPELINE-073: count fcv tags in a document body. */
export function countFcvTags(body: string): number {
  const matches = body.match(TAG_RE_G);
  return matches ? matches.length : 0;
}

/**
 * ADR-PIPELINE-089 §4: extract the set of fcv tag *keys* (kind/scope/doc
 * tuples) from a document body. Used by the relaxed tag-survival check,
 * which asserts set-containment of mandatory keys rather than raw count
 * parity (which penalized LLMs for legitimate tag deduplication).
 *
 * A tag without any recognized kind/scope/doc contributes an empty string;
 * duplicates are collapsed (Set). Callers comparing skeleton ⊆ synthesized
 * check `missing = [...skeletonKeys].filter(k => !synthesizedKeys.has(k))`.
 */
export function fcvTagKeys(body: string): Set<string> {
  const keys = new Set<string>();
  const matches = body.matchAll(TAG_RE_G);
  for (const m of matches) {
    const tag = parseTag(`<!-- fcv:${m[1]} -->`);
    if (!tag) continue;
    // Compose a stable key; unit is intentionally excluded (not every
    // renderer emits it and it's not dereferenced by downstream phases).
    const key = `${tag.kind ?? ''}|${tag.scope ?? ''}|${tag.doc ?? ''}`;
    keys.add(key);
  }
  return keys;
}

/**
 * ADR-PIPELINE-073: emit an fcv HTML comment tag. Used by renderers.
 * Exported here (not in simulation-renderers) so the extractor and the
 * renderer speak the same grammar.
 */
export function fcvTag(
  kind: FinancialClaimKind,
  scope: FinancialClaimScope,
  doc: FinancialClaimDocument,
): string {
  return `<!-- fcv:kind=${kind} scope=${scope} doc=${doc} -->`;
}

// ============================================================================
// Kind inference from surrounding prose
// ============================================================================

function detectKind(context: string, defaultKind: FinancialClaimKind): FinancialClaimKind {
  const lower = context.toLowerCase();
  if (/\b(?:5[-\s]?year\s*)?npv\b/.test(lower)) return 'npv';
  if (/\broi\b|return\s+on\s+investment/.test(lower)) return 'roi';
  if (/\bsavings?\b|annual\s+(?:value|impact|benefit)/.test(lower)) return 'savings';
  if (/\binvestment\b|\bcapex\b|\bcost\b|\bbudget\b|\bspend\b/.test(lower)) return 'investment';
  return defaultKind;
}

// ============================================================================
// Section tracker — most-recent H1/H2/H3 heading
// ============================================================================

function updateSection(current: string, line: string): string {
  const m = line.match(/^(#{1,3})\s+(.*?)\s*$/);
  if (!m) return current;
  return m[2]!.trim();
}

// ============================================================================
// Entry point
// ============================================================================

/**
 * Extract FinancialClaim records from a markdown document. The document name
 * is recorded on every claim and becomes the primary key for
 * cross-document rule evaluation.
 *
 * Scoping heuristic:
 *   1. If an HTML fcv: tag precedes the figure (same line or prior line),
 *      use its declared kind/scope verbatim.
 *   2. Otherwise scan a ±60 char window around the figure for scope words
 *      ("pilot", "phase 1", "full program", ...).
 */
export function extractClaims(
  markdown: string,
  document: FinancialClaimDocument,
): FinancialClaim[] {
  const claims: FinancialClaim[] = [];
  const lines = markdown.split(/\r?\n/);

  let section = '(preamble)';
  let pendingTag: Tag | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    section = updateSection(section, line);

    // Accumulate a pending tag on its own line — consume it on the next
    // non-empty, non-tag line.
    const tag = parseTag(line);
    if (tag) {
      // Inline tag on the same line as the figure is also supported.
      // In that case we use it immediately and skip the pending cycle.
      const withoutTag = line.replace(TAG_RE, '').trim();
      if (withoutTag.length > 0) {
        extractFromLine(withoutTag, i + 1, section, tag, claims, document);
      } else {
        pendingTag = tag;
      }
      continue;
    }

    if (line.trim().length === 0) continue;

    const useTag = pendingTag;
    pendingTag = null;

    extractFromLine(line, i + 1, section, useTag, claims, document);
  }

  return claims;
}

function extractFromLine(
  line: string,
  lineNumber: number,
  section: string,
  tag: Tag | null,
  out: FinancialClaim[],
  document: FinancialClaimDocument,
): void {
  // Currency claims
  const currencyMatches = Array.from(line.matchAll(CURRENCY_RANGE_RE));
  for (const match of currencyMatches) {
    const raw = match[0];
    // Ignore obvious context-only mentions like "$/sqft" or "$0"
    if (/\$\s*\/|\$0\b|\$\s*X\b/i.test(raw)) continue;

    const hasRange = /[-–—]|to/.test(raw);
    let rangeLow: number | undefined;
    let rangeHigh: number | undefined;
    let pointValue: number | undefined;

    if (hasRange) {
      const parts = raw.split(/\s*(?:[-–—]|to)\s*/i);
      if (parts.length === 2) {
        const a = parseCurrency(parts[0]!);
        const b = parseCurrency(parts[1]!);
        if (!Number.isNaN(a) && !Number.isNaN(b)) {
          rangeLow = Math.min(a, b);
          rangeHigh = Math.max(a, b);
        } else if (!Number.isNaN(a)) {
          pointValue = a;
        }
      }
    } else {
      const v = parseCurrency(raw);
      if (!Number.isNaN(v)) pointValue = v;
    }

    if (rangeLow === undefined && pointValue === undefined) continue;

    // Small-dollar amounts (< $1000) are almost never "financial claims" in
    // an executive doc — they're unit prices, per-capita figures, etc.
    // Skip them to reduce false positives. Real investment/savings figures
    // are always ≥ $1K.
    const anchorValue = pointValue ?? rangeLow ?? 0;
    if (anchorValue < 1_000) continue;

    const context = line;
    const kindDefault: FinancialClaimKind = 'investment';
    const matchStart = match.index ?? 0;
    const matchEnd = matchStart + raw.length;
    const kind = tag?.kind ?? detectKind(context, kindDefault);
    const scope = tag?.scope ?? detectScopeNearIndex(context, matchStart, matchEnd);

    const claim: FinancialClaim = {
      document,
      section,
      kind,
      scope,
      ...(rangeLow !== undefined ? { rangeLow } : {}),
      ...(rangeHigh !== undefined ? { rangeHigh } : {}),
      ...(pointValue !== undefined ? { pointValue } : {}),
      unit: 'USD',
      rawText: raw,
      line: lineNumber,
      tagged: tag !== null,
      ...(tag?.doc ? { docTag: tag.doc } : {}),
    };
    out.push(claim);
  }

  // Timeline claims — weeks or months
  const timelineMatches = Array.from(line.matchAll(/(\d+)[\s-]*(week|month|year)s?/gi));
  for (const tm of timelineMatches) {
    const value = parseInt(tm[1]!, 10);
    if (!Number.isFinite(value) || value <= 0) continue;
    const unitWord = tm[2]!.toLowerCase();
    const unit: FinancialClaimUnit =
      unitWord.startsWith('week') ? 'weeks' :
      unitWord.startsWith('month') ? 'months' : 'years';

    const tmStart = tm.index ?? 0;
    const tmEnd = tmStart + tm[0]!.length;
    const HISTORY_WINDOW = 30;
    const windowStart = Math.max(0, tmStart - HISTORY_WINDOW);
    const windowEnd = Math.min(line.length, tmEnd + HISTORY_WINDOW);
    const window = line.slice(windowStart, windowEnd).toLowerCase();

    // Ignore history references like "last 3 years" — check ONLY the window
    // around this match, not the whole line, so legitimate forward-looking
    // timelines aren't dropped when a history reference appears elsewhere.
    if (/\b(last|past|previous|over the (?:past|last))\b/.test(window)) continue;
    // Ignore payback-style tokens — those are covered by FCR-006 ROI, not timeline.
    if (/payback/.test(window)) continue;

    const scope = tag?.scope ?? detectScopeNearIndex(line, tmStart, tmEnd);
    out.push({
      document,
      section,
      kind: 'timeline',
      scope,
      pointValue: value,
      unit,
      rawText: tm[0]!,
      line: lineNumber,
      tagged: tag !== null,
    });
  }

  // Headcount claims — "91,000 employees" / "3,200 roles"
  const headcountMatches = Array.from(
    line.matchAll(/([\d][\d,]{2,})\s*(?:employees|roles|headcount|staff)\b/gi),
  );
  for (const hm of headcountMatches) {
    const v = parseInt(hm[1]!.replace(/,/g, ''), 10);
    if (!Number.isFinite(v) || v <= 0) continue;
    out.push({
      document,
      section,
      kind: 'headcount',
      scope: tag?.scope ?? detectScope(line),
      pointValue: v,
      unit: 'count',
      rawText: hm[0]!,
      line: lineNumber,
      tagged: tag !== null,
    });
  }

  // ROI percent claims — "217% projected" / "ROI 300%"
  const roiMatches = Array.from(line.matchAll(/(\d+)\s*%/g));
  for (const rm of roiMatches) {
    if (!/\broi\b|return\s+on\s+investment/i.test(line)) continue;
    const v = parseInt(rm[1]!, 10);
    if (!Number.isFinite(v)) continue;
    out.push({
      document,
      section,
      kind: 'roi',
      scope: tag?.scope ?? detectScope(line),
      pointValue: v,
      unit: 'percent',
      rawText: rm[0]!,
      line: lineNumber,
      tagged: tag !== null,
    });
  }
}
