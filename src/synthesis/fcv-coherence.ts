/**
 * ADR-PIPELINE-110 D6 — shared financial-coherence primitives.
 *
 * One source of truth for fcv-tag *kind* normalization and the coherence
 * tolerance, consumed by BOTH coherence checkers:
 *   - the Phase 1 financial-consistency runner (ADR-067), and
 *   - the Phase 7 coherence gate (ADR-098 D8 / ADR-105 D7).
 *
 * Keeping kind-aliasing and tolerance here prevents the "passes Phase 1 but
 * fails Phase 7 (or vice-versa) over a parsing discrepancy" divergence D6
 * warns about. Both readers parse the same `<!-- fcv:kind=... -->` grammar;
 * this module canonicalizes the renderer-side synonyms they may encounter.
 */

/** The canonical coherence tolerance (fraction, e.g. 0.05 = ±5%). */
export const FCV_TOLERANCE_PCT = 0.05;

/** Canonical fcv kinds the coherence checkers reason about. */
export type CanonicalFcvKind =
  | 'investment'
  | 'savings'
  | 'npv'
  | 'roi'
  | 'payback'
  | 'timeline';

const CANONICAL_KINDS: ReadonlySet<string> = new Set<CanonicalFcvKind>([
  'investment', 'savings', 'npv', 'roi', 'payback', 'timeline',
]);

/**
 * Normalize a raw fcv `kind=` value to a canonical kind, accepting the
 * renderer-side synonyms (`revenueImpact`/`cost-savings` → `savings`,
 * `paybackPeriod` → `payback`). Returns null for unknown kinds.
 */
export function normalizeFcvKind(raw: string | null | undefined): CanonicalFcvKind | null {
  if (!raw) return null;
  const lower = raw.trim().toLowerCase();
  if (lower === 'revenueimpact' || lower === 'revenue-impact' || lower === 'cost-savings' || lower === 'costsavings') {
    return 'savings';
  }
  if (lower === 'paybackperiod' || lower === 'payback-period') {
    return 'payback';
  }
  return CANONICAL_KINDS.has(lower) ? (lower as CanonicalFcvKind) : null;
}
