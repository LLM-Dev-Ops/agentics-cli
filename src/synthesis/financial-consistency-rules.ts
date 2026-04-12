/**
 * ADR-PIPELINE-067: Financial Consistency Rules (FCR-001..009)
 *
 * Pure functions over the output of financial-claim-extractor + an optional
 * unit-economics manifest. Each rule returns zero or more Violation objects.
 *
 * Rule IDs:
 *   FCR-001  Same scope + same kind across documents ⇒ numeric ranges must overlap
 *   FCR-002  Pilot investment MUST be ≤ full-program investment
 *   FCR-003  Phase-1 range MUST be a subset of full-program range
 *   FCR-004  Every currency claim MUST have a non-unscoped scope
 *   FCR-005  Timeline claims for the same scope MUST match within ±1 week
 *   FCR-006  Savings + investment for the same scope MUST yield the ROI stated
 *   FCR-007  When unit-economics manifest exists, top-line figures match ±1%
 *   FCR-008  Pilot savings × (enterprise/pilot units) MUST equal enterprise savings ±5%
 *   FCR-009  At most one "headline" figure per document
 */

import type {
  FinancialClaim,
  FinancialClaimDocument,
  FinancialClaimKind,
  FinancialClaimScope,
} from './financial-claim-extractor.js';
import type { UnitEconomics } from '../pipeline/types.js';
import type { ConsensusSnapshot } from './consensus-tiers.js';
import { findForbiddenSpinPhrases } from './forbidden-spin-phrases.js';

export type Severity = 'error' | 'warn';

export interface Violation {
  readonly ruleId: string;
  readonly severity: Severity;
  readonly message: string;
  readonly claims: readonly FinancialClaim[];
  readonly suggestedFix?: string;
}

// ============================================================================
// Helpers
// ============================================================================

function anchorValue(claim: FinancialClaim): number {
  if (claim.pointValue !== undefined) return claim.pointValue;
  if (claim.rangeLow !== undefined) return claim.rangeLow;
  return 0;
}

function rangeOf(claim: FinancialClaim): [number, number] {
  if (claim.rangeLow !== undefined && claim.rangeHigh !== undefined) {
    return [claim.rangeLow, claim.rangeHigh];
  }
  const v = claim.pointValue ?? 0;
  return [v, v];
}

function rangesOverlap(a: [number, number], b: [number, number]): boolean {
  return a[0] <= b[1] && b[0] <= a[1];
}

function isCurrencyClaim(c: FinancialClaim): boolean {
  return c.unit === 'USD';
}

function byKey<K extends string, T>(items: readonly T[], key: (t: T) => K): Map<K, T[]> {
  const out = new Map<K, T[]>();
  for (const item of items) {
    const k = key(item);
    const list = out.get(k) ?? [];
    list.push(item);
    out.set(k, list);
  }
  return out;
}

/**
 * Two scopes are considered "same" for FCR-001 when they match exactly,
 * or when both map to the pilot/phase-1 concept.
 */
function canonicalScope(scope: FinancialClaimScope): FinancialClaimScope {
  if (scope === 'phase-1') return 'pilot';
  return scope;
}

// ============================================================================
// FCR-001 — Same scope + same kind across documents ⇒ ranges must overlap
// ============================================================================

function ruleFcr001(claims: readonly FinancialClaim[]): Violation[] {
  const violations: Violation[] = [];
  const currency = claims.filter(isCurrencyClaim);

  const grouped = byKey(
    currency,
    c => `${canonicalScope(c.scope)}|${c.kind}`,
  );

  for (const [key, group] of grouped) {
    if (group.length < 2) continue;
    const byDoc = byKey(group, c => c.document);
    if (byDoc.size < 2) continue;

    // Compare each pair of documents' widest range.
    const docEntries = Array.from(byDoc.entries()).map(([doc, list]) => {
      const lows: number[] = [];
      const highs: number[] = [];
      for (const c of list) {
        const [lo, hi] = rangeOf(c);
        lows.push(lo);
        highs.push(hi);
      }
      return {
        document: doc,
        low: Math.min(...lows),
        high: Math.max(...highs),
        claims: list,
      };
    });

    for (let i = 0; i < docEntries.length; i++) {
      for (let j = i + 1; j < docEntries.length; j++) {
        const a = docEntries[i]!;
        const b = docEntries[j]!;
        if (!rangesOverlap([a.low, a.high], [b.low, b.high])) {
          violations.push({
            ruleId: 'FCR-001',
            severity: 'error',
            message:
              `[${key}] ${a.document} [$${a.low.toLocaleString()}–$${a.high.toLocaleString()}] does not overlap with ${b.document} [$${b.low.toLocaleString()}–$${b.high.toLocaleString()}]`,
            claims: [...a.claims, ...b.claims],
            suggestedFix:
              'Reconcile figures — either widen the scope label on one side or relabel the divergent figure with the correct scope.',
          });
        }
      }
    }
  }

  return violations;
}

// ============================================================================
// FCR-002 — Pilot investment ≤ full-program investment
// FCR-003 — Phase-1 range MUST be a subset of full-program range
// ============================================================================

function ruleFcr002and003(claims: readonly FinancialClaim[]): Violation[] {
  const violations: Violation[] = [];
  const investments = claims.filter(c => isCurrencyClaim(c) && c.kind === 'investment');

  const pilots = investments.filter(
    c => c.scope === 'pilot' || c.scope === 'phase-1',
  );
  const fulls = investments.filter(c => c.scope === 'full-program');
  if (pilots.length === 0 || fulls.length === 0) return violations;

  const fullHigh = Math.max(...fulls.map(c => rangeOf(c)[1]));

  // FCR-002 — pilot must not exceed the full-program ceiling.
  for (const pilot of pilots) {
    const [pLow] = rangeOf(pilot);
    if (pLow > fullHigh) {
      violations.push({
        ruleId: 'FCR-002',
        severity: 'error',
        message:
          `pilot investment ${pilot.rawText} exceeds full-program ceiling $${fullHigh.toLocaleString()}`,
        claims: [pilot, ...fulls],
        suggestedFix: 'Lower the pilot figure or correct the full-program range.',
      });
    }
  }

  // FCR-003 — the same numeric range must not appear with different scope
  // labels across documents. This catches the OPERA regression where the
  // executive summary labels $2.7M–$4.1M as (pilot) while the decision memo
  // labels the identical range as (full-program).
  const rangesApproxEqual = (a: FinancialClaim, b: FinancialClaim): boolean => {
    const [alo, ahi] = rangeOf(a);
    const [blo, bhi] = rangeOf(b);
    const loDelta = Math.abs(alo - blo) / Math.max(1, Math.max(alo, blo));
    const hiDelta = Math.abs(ahi - bhi) / Math.max(1, Math.max(ahi, bhi));
    return loDelta <= 0.1 && hiDelta <= 0.1;
  };

  for (const pilot of pilots) {
    for (const full of fulls) {
      if (pilot.document === full.document) continue;
      if (!rangesApproxEqual(pilot, full)) continue;
      violations.push({
        ruleId: 'FCR-003',
        severity: 'error',
        message:
          `${pilot.document} declares ${pilot.rawText} (${pilot.scope}) but ${full.document} labels the same range as (full-program)`,
        claims: [pilot, full],
        suggestedFix:
          "Relabel the pilot figure to '(full program)' if it covers the whole program, or split into distinct pilot + full-program lines.",
      });
    }
  }

  return violations;
}

// ============================================================================
// FCR-004 — Every currency claim MUST have a non-unscoped scope
// ============================================================================

function ruleFcr004(claims: readonly FinancialClaim[]): Violation[] {
  const unscoped = claims.filter(
    c => isCurrencyClaim(c) && c.scope === 'unscoped' && !c.tagged,
  );
  if (unscoped.length === 0) return [];
  // One violation per claim so callers can map it to a file:line
  return unscoped.map<Violation>(claim => ({
    ruleId: 'FCR-004',
    severity: 'error',
    message: `${claim.document} line ${claim.line}: ${claim.rawText} has no scope label`,
    claims: [claim],
    suggestedFix:
      "Append a scope label in parens — e.g. '(pilot)' or '(full program)' — or add an HTML fcv:scope= tag.",
  }));
}

// ============================================================================
// FCR-005 — Timeline claims for the same scope match within ±1 week
// ============================================================================

const WEEK_IN_WEEKS = 1;

function timelineToWeeks(c: FinancialClaim): number {
  const v = c.pointValue ?? 0;
  if (c.unit === 'weeks') return v;
  if (c.unit === 'months') return v * 4.34524;
  if (c.unit === 'years') return v * 52;
  return v;
}

function ruleFcr005(claims: readonly FinancialClaim[]): Violation[] {
  const violations: Violation[] = [];
  const timelines = claims.filter(c => c.kind === 'timeline' && c.scope !== 'unscoped');
  const grouped = byKey(timelines, c => canonicalScope(c.scope));

  for (const [scope, group] of grouped) {
    if (group.length < 2) continue;
    const byDoc = byKey(group, c => c.document);
    if (byDoc.size < 2) continue;

    const weeksByDoc = Array.from(byDoc.entries()).map(([doc, list]) => ({
      document: doc,
      weeks: Math.max(...list.map(timelineToWeeks)),
      claims: list,
    }));

    for (let i = 0; i < weeksByDoc.length; i++) {
      for (let j = i + 1; j < weeksByDoc.length; j++) {
        const a = weeksByDoc[i]!;
        const b = weeksByDoc[j]!;
        if (Math.abs(a.weeks - b.weeks) > WEEK_IN_WEEKS) {
          violations.push({
            ruleId: 'FCR-005',
            severity: 'error',
            message:
              `[${scope}] timeline mismatch: ${a.document} says ${Math.round(a.weeks)} weeks, ${b.document} says ${Math.round(b.weeks)} weeks`,
            claims: [...a.claims, ...b.claims],
            suggestedFix:
              'Align timelines or split into distinct scopes (pilot vs. full program).',
          });
        }
      }
    }
  }
  return violations;
}

// ============================================================================
// FCR-006 — Savings ÷ investment ≈ ROI for the same scope (WARN)
// ============================================================================

function ruleFcr006(claims: readonly FinancialClaim[]): Violation[] {
  const violations: Violation[] = [];
  const byDoc = byKey(claims, c => c.document);

  for (const [doc, docClaims] of byDoc) {
    const investments = docClaims.filter(c => isCurrencyClaim(c) && c.kind === 'investment');
    const savings = docClaims.filter(c => isCurrencyClaim(c) && c.kind === 'savings');
    const rois = docClaims.filter(c => c.kind === 'roi' && c.unit === 'percent');
    if (investments.length === 0 || savings.length === 0 || rois.length === 0) continue;

    // Use the largest investment and savings in this document.
    const topInvest = investments.reduce((a, b) => (anchorValue(a) >= anchorValue(b) ? a : b));
    const topSavings = savings.reduce((a, b) => (anchorValue(a) >= anchorValue(b) ? a : b));
    const topRoi = rois.reduce((a, b) => ((a.pointValue ?? 0) >= (b.pointValue ?? 0) ? a : b));

    const investVal = anchorValue(topInvest);
    const savingsVal = anchorValue(topSavings);
    if (investVal <= 0) continue;

    const computed = (savingsVal / investVal) * 100;
    const stated = topRoi.pointValue ?? 0;
    if (Math.abs(computed - stated) / Math.max(1, stated) > 0.5) {
      violations.push({
        ruleId: 'FCR-006',
        severity: 'warn',
        message:
          `${doc}: savings $${savingsVal.toLocaleString()} ÷ investment $${investVal.toLocaleString()} ≈ ${Math.round(computed)}% but document states ROI of ${stated}%`,
        claims: [topInvest, topSavings, topRoi],
        suggestedFix:
          'Restate the ROI line or the underlying savings/investment figures so they reconcile.',
      });
    }
  }
  return violations;
}

// ============================================================================
// FCR-007 — Match unit-economics manifest within ±1%
// ============================================================================

function ruleFcr007(
  claims: readonly FinancialClaim[],
  manifest: UnitEconomics | null,
): Violation[] {
  if (!manifest) return [];
  const tol = 0.01;
  const violations: Violation[] = [];

  const savings = claims.filter(c => isCurrencyClaim(c) && c.kind === 'savings');
  const enterpriseSavings = savings.filter(c => c.scope === 'full-program');
  const pilotSavings = savings.filter(
    c => c.scope === 'pilot' || c.scope === 'phase-1',
  );

  const checkAgainst = (printed: FinancialClaim[], target: number, label: string): void => {
    for (const claim of printed) {
      const [lo, hi] = rangeOf(claim);
      const value = (lo + hi) / 2;
      const delta = Math.abs(value - target) / Math.max(1, target);
      if (delta > tol) {
        violations.push({
          ruleId: 'FCR-007',
          severity: 'error',
          message:
            `${claim.document} ${label} ${claim.rawText} deviates from unit-economics.json ($${target.toLocaleString()}) by ${(delta * 100).toFixed(1)}% (tolerance ±1%)`,
          claims: [claim],
          suggestedFix:
            'Regenerate the executive document or correct the unit-economics manifest so the two agree.',
        });
      }
    }
  };

  checkAgainst(enterpriseSavings, manifest.annual_extrapolated_savings_usd, 'enterprise savings');
  checkAgainst(pilotSavings, manifest.annual_measured_savings_usd, 'pilot savings');

  return violations;
}

// ============================================================================
// FCR-008 — Pilot × scope-ratio ≈ enterprise savings within ±5%
// ============================================================================

function ruleFcr008(
  claims: readonly FinancialClaim[],
  manifest: UnitEconomics | null,
): Violation[] {
  if (!manifest) return [];
  if (manifest.annual_measured_savings_usd <= 0) return [];
  const tol = 0.05;
  const violations: Violation[] = [];
  const manifestRatio =
    manifest.annual_extrapolated_savings_usd / manifest.annual_measured_savings_usd;

  const savings = claims.filter(c => isCurrencyClaim(c) && c.kind === 'savings');
  const byDoc = byKey(savings, c => c.document);
  for (const [doc, docSavings] of byDoc) {
    const pilot = docSavings.find(
      c => c.scope === 'pilot' || c.scope === 'phase-1',
    );
    const full = docSavings.find(c => c.scope === 'full-program');
    if (!pilot || !full) continue;

    const pilotVal = anchorValue(pilot);
    const fullVal = anchorValue(full);
    if (pilotVal <= 0) continue;
    const ratio = fullVal / pilotVal;
    const delta = Math.abs(ratio - manifestRatio) / Math.max(0.01, manifestRatio);
    if (delta > tol) {
      violations.push({
        ruleId: 'FCR-008',
        severity: 'error',
        message:
          `${doc}: pilot→enterprise ratio ${ratio.toFixed(1)}× deviates from manifest scope ratio ${manifestRatio.toFixed(1)}× by ${(delta * 100).toFixed(1)}% (tolerance ±5%)`,
        claims: [pilot, full],
        suggestedFix:
          'Align the printed figures with the manifest scope ratio or widen the extrapolation method explanation.',
      });
    }
  }

  return violations;
}

// ============================================================================
// FCR-009 — At most one headline figure per document (WARN)
// ============================================================================

function ruleFcr009(claims: readonly FinancialClaim[]): Violation[] {
  const violations: Violation[] = [];
  const byDoc = byKey(claims, c => c.document);

  for (const [doc, docClaims] of byDoc) {
    const headlines = docClaims.filter(
      c => isCurrencyClaim(c) && c.kind === 'savings' && c.scope === 'full-program',
    );
    if (headlines.length <= 1) continue;

    // Collapse identical numbers (same anchor) before flagging — a doc that
    // states "$30M/yr" twice isn't a problem, two *different* $30M and $4.1M
    // headline figures is.
    const distinct = new Set(headlines.map(c => Math.round(anchorValue(c))));
    if (distinct.size <= 1) continue;

    violations.push({
      ruleId: 'FCR-009',
      severity: 'warn',
      message:
        `${doc} has ${distinct.size} distinct full-program headline savings figures: ${[...distinct].map(v => '$' + v.toLocaleString()).join(' and ')}`,
      claims: headlines,
      suggestedFix:
        'Pick one headline savings figure and demote the others to a pilot/phase-1 scope or a sensitivity range.',
    });
  }

  return violations;
}

// ============================================================================
// FCR-010 — No forbidden spin phrases on contested-tier runs (ADR-PIPELINE-071)
// ============================================================================

export interface DocumentBody {
  readonly document: FinancialClaimDocument;
  readonly content: string;
}

function ruleFcr010(
  documents: readonly DocumentBody[],
  consensus: ConsensusSnapshot | null,
): Violation[] {
  if (!consensus || consensus.tier !== 'contested') return [];
  const violations: Violation[] = [];

  for (const doc of documents) {
    const findings = findForbiddenSpinPhrases(doc.content);
    if (findings.length === 0) continue;
    for (const f of findings) {
      const claim: FinancialClaim = {
        document: doc.document,
        section: '(spin scan)',
        kind: 'investment',
        scope: 'unscoped',
        unit: 'USD',
        rawText: f.rawText,
        line: f.line,
        tagged: false,
      };
      violations.push({
        ruleId: 'FCR-010',
        severity: 'error',
        message:
          `${doc.document} line ${f.line}: forbidden spin phrase "${f.rawText}" — ${f.note} (consensus is contested at agreement ${consensus.agreementLevelPct}%, precision ${consensus.precisionConfidencePct}%)`,
        claims: [claim],
        suggestedFix:
          'Remove the phrase or relabel the document — under contested consensus the executive narrative must NOT minimize dissent.',
      });
    }
  }

  return violations;
}

// ============================================================================
// Entry point
// ============================================================================

export interface RunRulesInput {
  readonly claims: readonly FinancialClaim[];
  readonly manifest?: UnitEconomics | null;
  readonly documents?: readonly DocumentBody[];
  readonly consensus?: ConsensusSnapshot | null;
}

export function runConsistencyRules(input: RunRulesInput): Violation[] {
  const { claims, manifest = null, documents = [], consensus = null } = input;
  return [
    ...ruleFcr001(claims),
    ...ruleFcr002and003(claims),
    ...ruleFcr004(claims),
    ...ruleFcr005(claims),
    ...ruleFcr006(claims),
    ...ruleFcr007(claims, manifest),
    ...ruleFcr008(claims, manifest),
    ...ruleFcr009(claims),
    ...ruleFcr010(documents, consensus),
  ];
}

// Exported for unit tests so individual rules can be exercised in isolation.
export const __internal = {
  ruleFcr001,
  ruleFcr002and003,
  ruleFcr004,
  ruleFcr005,
  ruleFcr006,
  ruleFcr007,
  ruleFcr008,
  ruleFcr009,
  ruleFcr010,
};

// Back-compat alias for callers that only need the counts.
export function countViolations(vs: readonly Violation[]): {
  errors: number;
  warnings: number;
} {
  let errors = 0;
  let warnings = 0;
  for (const v of vs) {
    if (v.severity === 'error') errors++;
    else warnings++;
  }
  return { errors, warnings };
}

// Keep a helper so the runner can prefix per-document warnings easily.
export function violationsByDocument(
  vs: readonly Violation[],
): Map<FinancialClaimDocument, Violation[]> {
  const out = new Map<FinancialClaimDocument, Violation[]>();
  for (const v of vs) {
    for (const c of v.claims) {
      const list = out.get(c.document) ?? [];
      if (!list.includes(v)) list.push(v);
      out.set(c.document, list);
    }
  }
  return out;
}

// Exported for the runner’s use.
export type { FinancialClaim, FinancialClaimDocument, FinancialClaimKind, FinancialClaimScope };
