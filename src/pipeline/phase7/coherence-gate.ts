/**
 * ADR-PIPELINE-098 D8 — Coherence Gate.
 *
 * Post-render financial validator. Walks the deliverables directory, scans
 * every emitted file for `<!-- fcv:kind=... -->` provenance tags, and
 * compares the value that follows each tag against the canonical value held
 * in `unit-economics.json` (per ADR-PIPELINE-066 — the single financial
 * source of truth).
 *
 * Tolerance: ±5% by default. Range tokens like `$22.1M – $30.9M` pass when
 * the canonical falls inside the range OR the range midpoint is within
 * tolerance of the canonical.
 *
 * The gate is a pure reporter: it does NOT decide phase status. The Phase 7
 * coordinator inspects the violation list and downgrades to `partial` when
 * appropriate (per D8). Coherence violations are non-fatal.
 *
 * Implementation notes:
 *  - File discovery is a manual recursive walk over `node:fs` — `fast-glob`
 *    is not a project dependency and pulling one in just for this gate is
 *    avoided.
 *  - File read errors are non-fatal: the offending file is skipped (not
 *    counted in `files_scanned`), but the gate continues.
 *  - The unit-economics manifest schema is permissive: only the fields that
 *    are actually present feed the canonical map. Kinds the manifest does
 *    not carry are skipped silently rather than reported as violations
 *    (the canonical value is unknown, not wrong).
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';

// ============================================================================
// Public types
// ============================================================================

export type CoherenceKind =
  | 'investment'
  | 'savings'
  | 'npv'
  | 'roi'
  | 'payback'
  | 'timeline';

export interface CoherenceViolation {
  readonly slug: string;
  readonly section: number;
  readonly kind: CoherenceKind;
  readonly expected: string;
  readonly got: string;
  readonly delta_pct: number;
  readonly path: string;
}

export interface CoherenceReport {
  readonly violations: ReadonlyArray<CoherenceViolation>;
  readonly files_scanned: number;
  readonly fcv_tags_total: number;
  readonly tolerance_pct: number;
}

export interface CoherenceGateOptions {
  /** Default ±5%. Applied symmetrically around the canonical value. */
  readonly tolerancePct?: number;
}

// ============================================================================
// File discovery
// ============================================================================

const SUPPORTED_EXT = new Set<string>(['.md', '.json', '.csv']);

async function walkFiles(root: string): Promise<string[]> {
  const out: string[] = [];

  async function visit(dir: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return; // unreadable dir is non-fatal
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        // Resolve the symlink target and decide based on its kind. Mirror
        // entries (D6) are symlinks to top-level docs; we still want to
        // scan them.
        try {
          const stat = await fs.stat(full);
          if (stat.isFile() && SUPPORTED_EXT.has(path.extname(full).toLowerCase())) {
            out.push(full);
          } else if (stat.isDirectory()) {
            await visit(full);
          }
        } catch {
          // dangling symlink — skip
        }
        continue;
      }
      if (entry.isDirectory()) {
        await visit(full);
        continue;
      }
      if (entry.isFile() && SUPPORTED_EXT.has(path.extname(entry.name).toLowerCase())) {
        out.push(full);
      }
    }
  }

  await visit(root);
  return out;
}

// ============================================================================
// Section / slug derivation
// ============================================================================

/**
 * Phase 7 lays files out as `<runDir>/deliverables/<NN-section>/<slug>.<ext>`.
 * The leading two-digit prefix on the parent directory is the section
 * number. Files outside this layout (e.g. `index.md`, `phase7-manifest.json`)
 * are still scanned, but reported with `section: 0`.
 */
function deriveSlugAndSection(absPath: string, root: string): { slug: string; section: number } {
  const rel = path.relative(root, absPath);
  const parts = rel.split(path.sep);
  const ext = path.extname(absPath);
  const slug = path.basename(absPath, ext);

  // First directory under root: e.g. `01-executive` → section 1.
  if (parts.length >= 2) {
    const dir = parts[0]!;
    const m = dir.match(/^(\d{1,2})-/);
    if (m && m[1]) {
      const n = Number.parseInt(m[1], 10);
      if (Number.isFinite(n) && n >= 1 && n <= 12) {
        return { slug, section: n };
      }
    }
  }
  return { slug, section: 0 };
}

// ============================================================================
// Tag scanner
// ============================================================================

const FCV_TAG_RE = /<!--\s*fcv:([^>]+?)\s*-->/g;

interface FcvTagMatch {
  readonly kind: CoherenceKind | null;
  /** Index immediately AFTER the closing `-->` — where the value text begins. */
  readonly tailIndex: number;
}

/**
 * Parse a single fcv tag's attribute string (the bit between `fcv:` and
 * the closing `-->`). Only `kind=` is significant for the gate — `scope`,
 * `doc`, `src` are recorded by the renderer but not used here.
 */
function parseTagAttrs(attrs: string): { kind: CoherenceKind | null } {
  let kind: string | null = null;
  for (const pair of attrs.split(/\s+/)) {
    const eq = pair.indexOf('=');
    if (eq === -1) continue;
    const key = pair.slice(0, eq).trim();
    const val = pair.slice(eq + 1).trim();
    if (key === 'kind') kind = val;
  }
  // Kind aliasing: keep the canonical set narrow but accept renderer-side
  // synonyms. `revenueImpact` → `savings`, `paybackPeriod` → `payback`.
  // The exec-summary uses `timeline` for payback figures; we keep that as
  // its own kind so range/duration parsing can split, then alias to
  // `payback` for the canonical-value lookup later.
  if (!kind) return { kind: null };
  const lower = kind.toLowerCase();
  if (lower === 'revenueimpact' || lower === 'revenue-impact' || lower === 'cost-savings' || lower === 'costsavings') {
    return { kind: 'savings' };
  }
  if (lower === 'paybackperiod' || lower === 'payback-period') {
    return { kind: 'payback' };
  }
  if (
    lower === 'investment' ||
    lower === 'savings' ||
    lower === 'npv' ||
    lower === 'roi' ||
    lower === 'payback' ||
    lower === 'timeline'
  ) {
    return { kind: lower as CoherenceKind };
  }
  return { kind: null };
}

function scanTags(body: string): FcvTagMatch[] {
  const out: FcvTagMatch[] = [];
  for (const m of body.matchAll(FCV_TAG_RE)) {
    const attrs = m[1] ?? '';
    const tailIndex = (m.index ?? 0) + m[0].length;
    const { kind } = parseTagAttrs(attrs);
    out.push({ kind, tailIndex });
  }
  return out;
}

// ============================================================================
// Value extraction (the token immediately following a tag)
// ============================================================================

/**
 * Scan up to ~200 chars after a tag for the next dollar-or-duration token.
 * This window comfortably covers the patterns observed in exec-summary:
 *   `<!-- ... --> $22.1M – $30.9M (Bottom-up unit economics ...)`
 *   `<!-- ... --> 5 months (break-even ...)`
 *   `<!-- ... --> 250% projected ($55.3M annual savings ...)`
 *
 * For ROI we want the percent token, not the trailing `$X.YM`. The kind
 * dictates which extractor runs.
 */
const VALUE_WINDOW = 240;

function extractValueText(body: string, fromIndex: number, kind: CoherenceKind): string | null {
  const window = body.slice(fromIndex, fromIndex + VALUE_WINDOW);
  // Trim leading whitespace / pipe (table cells) / colon.
  const trimmed = window.replace(/^[\s:|]+/, '');
  if (trimmed.length === 0) return null;

  if (kind === 'roi') {
    const m = trimmed.match(/^(\d+(?:\.\d+)?)\s*%/);
    if (m) return `${m[1]}%`;
    // Some renderers print `ROI: 250% projected`. If the value isn't first,
    // fall through to a broader scan.
    const broad = trimmed.match(/(\d+(?:\.\d+)?)\s*%/);
    if (broad) return `${broad[1]}%`;
    return null;
  }

  if (kind === 'payback' || kind === 'timeline') {
    // Duration tokens: "5 months", "0.7 year(s)", "3-month", "18-week".
    const m = trimmed.match(/^(\d+(?:\.\d+)?)[\s-]?(months?|years?|weeks?)\b/i);
    if (m) return `${m[1]} ${m[2]!.toLowerCase()}`;
    // Some payback cells lead with a dollar token (the cumulative-savings
    // breakeven). Fall through to dollar extraction so the gate still
    // produces a comparable number.
    return extractDollarToken(trimmed);
  }

  // investment / savings / npv → dollar token (point or range)
  return extractDollarToken(trimmed);
}

function extractDollarToken(s: string): string | null {
  // Range: `$22.1M – $30.9M`, `$22.1M-$30.9M`, `$22.1M to $30.9M`.
  const range = s.match(
    /^\$\s*[\d,]+(?:\.\d+)?\s*[KMB]?\s*(?:[-–—]|to)\s*\$?\s*[\d,]+(?:\.\d+)?\s*[KMB]?/i,
  );
  if (range) return range[0]!.trim();
  // Point: `$22.1M`, `$1,200,000`, `$500K`.
  const point = s.match(/^\$\s*[\d,]+(?:\.\d+)?\s*[KMB]?/i);
  if (point) return point[0]!.trim();
  return null;
}

// ============================================================================
// Numeric parsers
// ============================================================================

const SUFFIX_MULT: Record<string, number> = {
  K: 1_000,
  M: 1_000_000,
  B: 1_000_000_000,
};

/**
 * Parse a single dollar token like `$22.1M`, `$500K`, `$1,200,000`.
 * Returns null on failure — callers decide whether absence is a violation.
 */
export function parseDollarToBase(s: string): number | null {
  const cleaned = s.trim().replace(/^\$/, '').replace(/\s+/g, '');
  if (cleaned.length === 0) return null;

  const suffixMatch = cleaned.match(/^([\d,]+(?:\.\d+)?)([KMB])$/i);
  if (suffixMatch) {
    const num = Number.parseFloat(suffixMatch[1]!.replace(/,/g, ''));
    const mult = SUFFIX_MULT[suffixMatch[2]!.toUpperCase()] ?? 1;
    if (Number.isFinite(num)) return num * mult;
    return null;
  }

  const plainMatch = cleaned.match(/^([\d,]+(?:\.\d+)?)$/);
  if (plainMatch) {
    const num = Number.parseFloat(plainMatch[1]!.replace(/,/g, ''));
    if (Number.isFinite(num)) return num;
  }
  return null;
}

interface DollarRange {
  readonly low: number;
  readonly high: number;
}

function parseDollarRange(s: string): DollarRange | null {
  const parts = s.split(/\s*(?:[-–—]|\bto\b)\s*/i);
  if (parts.length !== 2) return null;
  const a = parseDollarToBase(parts[0]!);
  const b = parseDollarToBase(parts[1]!);
  if (a === null || b === null) return null;
  return { low: Math.min(a, b), high: Math.max(a, b) };
}

/**
 * Parse a duration token like `5 months`, `1.5 years`, `12-week` and
 * normalize to months. Years/weeks are converted at standard ratios
 * (1 yr = 12 mo, 1 wk = 12/52 mo ≈ 0.231 mo).
 */
export function parseDurationToMonths(s: string): number | null {
  const m = s.trim().match(/^(\d+(?:\.\d+)?)[\s-]?(months?|years?|weeks?)\b/i);
  if (!m) return null;
  const n = Number.parseFloat(m[1]!);
  if (!Number.isFinite(n)) return null;
  const unit = m[2]!.toLowerCase();
  if (unit.startsWith('month')) return n;
  if (unit.startsWith('year')) return n * 12;
  if (unit.startsWith('week')) return (n * 12) / 52;
  return null;
}

// ============================================================================
// Canonical value loader
// ============================================================================

interface CanonicalValues {
  readonly investmentUsd?: number;
  readonly savingsUsd?: number;
  readonly npvUsd?: number;
  readonly roiPct?: number;
  readonly paybackMonths?: number;
  /** Pretty-printed canonical strings (for the violation `expected` field). */
  readonly display: Readonly<Record<CoherenceKind, string | undefined>>;
}

/**
 * Best-effort canonical-value extractor for the unit-economics manifest.
 *
 * The manifest schema (ADR-PIPELINE-066) encodes savings directly but
 * derives investment / NPV / ROI / payback at render time. To keep the
 * gate self-contained we re-derive the same numbers here using the same
 * rule-of-thumb the renderer uses (40% of enterprise savings as
 * implementation cost, NPV = enterprise × 3.5 − impl, payback months =
 * impl / enterprise × 12, ROI = enterprise / impl × 100).
 *
 * If the manifest carries explicit fields (`pilot_investment`,
 * `enterprise_investment`, `payback_months`, `npv_5yr`, `roi_pct`) those
 * take precedence over the derivation. This makes the gate forward-compatible
 * with future schema extensions without breaking on today's manifests.
 */
async function loadCanonical(unitEconomicsPath: string): Promise<CanonicalValues> {
  const display: Record<CoherenceKind, string | undefined> = {
    investment: undefined,
    savings: undefined,
    npv: undefined,
    roi: undefined,
    payback: undefined,
    timeline: undefined,
  };

  let raw: string;
  try {
    raw = await fs.readFile(unitEconomicsPath, 'utf-8');
  } catch {
    return { display };
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { display };
  }

  if (!isRecord(json)) return { display };

  // ----- direct fields (may or may not be present) -----
  const directInvestment =
    pickNumber(json, 'enterprise_investment') ?? pickNumber(json, 'pilot_investment');
  const directSavings =
    pickNumber(json, 'enterprise_savings_per_year') ??
    pickNumber(json, 'pilot_savings_per_year') ??
    pickNumber(json, 'annual_extrapolated_savings_usd') ??
    pickNumber(json, 'annual_measured_savings_usd');
  const directNpv = pickNumber(json, 'npv_5yr');
  const directRoi = pickNumber(json, 'roi_pct');
  const directPayback = pickNumber(json, 'payback_months');

  // ----- derive missing fields from annual_extrapolated_savings_usd -----
  const enterpriseSavings = pickNumber(json, 'annual_extrapolated_savings_usd');
  const measuredSavings = pickNumber(json, 'annual_measured_savings_usd');
  const baseSavings = enterpriseSavings ?? measuredSavings;

  let investmentUsd = directInvestment;
  let savingsUsd = directSavings;
  let npvUsd = directNpv;
  let roiPct = directRoi;
  let paybackMonths = directPayback;

  if (savingsUsd === undefined && baseSavings !== undefined) {
    savingsUsd = baseSavings;
  }

  if (baseSavings !== undefined && baseSavings > 0) {
    const derivedImpl = Math.max(500_000, Math.round(baseSavings * 0.4));
    if (investmentUsd === undefined) investmentUsd = derivedImpl;
    if (npvUsd === undefined) npvUsd = Math.round(baseSavings * 3.5 - derivedImpl);
    if (roiPct === undefined) roiPct = Math.round((baseSavings / derivedImpl) * 100);
    if (paybackMonths === undefined) {
      paybackMonths = Math.max(3, Math.min(36, Math.round((derivedImpl / baseSavings) * 12)));
    }
  }

  if (investmentUsd !== undefined) display.investment = formatMoney(investmentUsd);
  if (savingsUsd !== undefined) display.savings = formatMoney(savingsUsd);
  if (npvUsd !== undefined) display.npv = formatMoney(npvUsd);
  if (roiPct !== undefined) display.roi = `${roiPct}%`;
  if (paybackMonths !== undefined) {
    const txt = `${paybackMonths} months`;
    display.payback = txt;
    display.timeline = txt;
  }

  return {
    ...(investmentUsd !== undefined ? { investmentUsd } : {}),
    ...(savingsUsd !== undefined ? { savingsUsd } : {}),
    ...(npvUsd !== undefined ? { npvUsd } : {}),
    ...(roiPct !== undefined ? { roiPct } : {}),
    ...(paybackMonths !== undefined ? { paybackMonths } : {}),
    display,
  };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function pickNumber(obj: Record<string, unknown>, key: string): number | undefined {
  const v = obj[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function formatMoney(n: number): string {
  if (!Number.isFinite(n)) return '$0';
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `$${(n / 1_000).toFixed(0)}K`;
  return `$${Math.round(n)}`;
}

// ============================================================================
// Comparison
// ============================================================================

interface CanonicalLookup {
  readonly numeric?: number;
  readonly display?: string;
  /** Comparison units: usd for money, months for duration, percent for roi. */
  readonly unit: 'usd' | 'months' | 'percent';
}

function canonicalFor(kind: CoherenceKind, c: CanonicalValues): CanonicalLookup | null {
  switch (kind) {
    case 'investment':
      if (c.investmentUsd === undefined) return null;
      return { numeric: c.investmentUsd, display: c.display.investment, unit: 'usd' };
    case 'savings':
      if (c.savingsUsd === undefined) return null;
      return { numeric: c.savingsUsd, display: c.display.savings, unit: 'usd' };
    case 'npv':
      if (c.npvUsd === undefined) return null;
      return { numeric: c.npvUsd, display: c.display.npv, unit: 'usd' };
    case 'roi':
      if (c.roiPct === undefined) return null;
      return { numeric: c.roiPct, display: c.display.roi, unit: 'percent' };
    case 'payback':
    case 'timeline':
      if (c.paybackMonths === undefined) return null;
      return { numeric: c.paybackMonths, display: c.display.payback, unit: 'months' };
  }
}

interface ComparisonOutcome {
  readonly inTolerance: boolean;
  readonly deltaPct: number;
  readonly nonNumeric: boolean;
}

function compareValues(
  got: string,
  canon: CanonicalLookup,
  tolerancePct: number,
): ComparisonOutcome {
  if (canon.numeric === undefined) {
    return { inTolerance: true, deltaPct: 0, nonNumeric: true };
  }

  // Try numeric parse based on the canonical unit.
  let gotNum: number | null = null;
  let gotRange: DollarRange | null = null;

  if (canon.unit === 'usd') {
    gotRange = parseDollarRange(got);
    if (gotRange === null) gotNum = parseDollarToBase(got);
  } else if (canon.unit === 'months') {
    gotNum = parseDurationToMonths(got);
  } else if (canon.unit === 'percent') {
    const m = got.match(/(-?\d+(?:\.\d+)?)\s*%/);
    if (m) gotNum = Number.parseFloat(m[1]!);
  }

  if (gotRange) {
    // Range passes when canonical falls in the range OR midpoint is within
    // tolerance.
    const inRange = canon.numeric >= gotRange.low && canon.numeric <= gotRange.high;
    if (inRange) {
      return { inTolerance: true, deltaPct: 0, nonNumeric: false };
    }
    const mid = (gotRange.low + gotRange.high) / 2;
    const delta = pctDelta(mid, canon.numeric);
    return { inTolerance: delta <= tolerancePct, deltaPct: delta, nonNumeric: false };
  }

  if (gotNum === null) {
    // Couldn't parse — non-numeric mismatch (the deliverable said something
    // we couldn't compare; flag it so a human can review).
    return { inTolerance: false, deltaPct: -1, nonNumeric: true };
  }

  const delta = pctDelta(gotNum, canon.numeric);
  return { inTolerance: delta <= tolerancePct, deltaPct: delta, nonNumeric: false };
}

function pctDelta(got: number, canonical: number): number {
  if (canonical === 0) {
    return got === 0 ? 0 : Number.POSITIVE_INFINITY;
  }
  return Math.abs((got - canonical) / canonical) * 100;
}

// ============================================================================
// Entry point
// ============================================================================

/**
 * Run the coherence gate over a deliverables directory.
 *
 * Walks `<deliverablesDir>` recursively, scans every `*.md` / `*.json` /
 * `*.csv` for fcv tags, extracts the value following each tag, and compares
 * against the canonical from `unitEconomicsPath`. Returns a report — never
 * throws; all errors are absorbed (unreadable files are skipped, invalid
 * JSON in unit-economics yields an empty canonical map and the gate emits
 * zero violations).
 */
export async function runCoherenceGate(
  deliverablesDir: string,
  unitEconomicsPath: string,
  options?: CoherenceGateOptions,
): Promise<CoherenceReport> {
  const tolerancePct =
    options?.tolerancePct !== undefined && options.tolerancePct >= 0
      ? options.tolerancePct
      : 5;

  const canonical = await loadCanonical(unitEconomicsPath);

  let files: string[];
  try {
    files = await walkFiles(deliverablesDir);
  } catch {
    return {
      violations: [],
      files_scanned: 0,
      fcv_tags_total: 0,
      tolerance_pct: tolerancePct,
    };
  }

  const violations: CoherenceViolation[] = [];
  let filesScanned = 0;
  let fcvTagsTotal = 0;

  for (const file of files) {
    let body: string;
    try {
      body = await fs.readFile(file, 'utf-8');
    } catch {
      // file errors are non-fatal and don't increment files_scanned
      continue;
    }
    filesScanned += 1;

    const tags = scanTags(body);
    fcvTagsTotal += tags.length;
    if (tags.length === 0) continue;

    const { slug, section } = deriveSlugAndSection(file, deliverablesDir);

    for (const tag of tags) {
      if (tag.kind === null) continue; // unrecognized kind — not validated
      const canon = canonicalFor(tag.kind, canonical);
      if (canon === null) continue; // canonical not present for this kind

      const valueText = extractValueText(body, tag.tailIndex, tag.kind);
      if (valueText === null) continue; // no value to compare — silent skip

      const cmp = compareValues(valueText, canon, tolerancePct);
      if (cmp.inTolerance) continue;

      violations.push({
        slug,
        section,
        kind: tag.kind,
        expected: canon.display ?? String(canon.numeric),
        got: valueText,
        delta_pct: cmp.nonNumeric ? -1 : roundDelta(cmp.deltaPct),
        path: path.resolve(file),
      });
    }
  }

  return {
    violations,
    files_scanned: filesScanned,
    fcv_tags_total: fcvTagsTotal,
    tolerance_pct: tolerancePct,
  };
}

function roundDelta(n: number): number {
  if (!Number.isFinite(n)) return n;
  return Math.round(n * 10) / 10;
}
