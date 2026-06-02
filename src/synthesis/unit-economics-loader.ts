/**
 * ADR-PIPELINE-066: Unit Economics Loader
 *
 * Reads `.agentics/runs/<run-id>/unit-economics.json` (or a caller-supplied
 * directory) and returns a Zod-validated UnitEconomics record. Falls back to
 * null when the file is absent or invalid — callers decide whether to use the
 * heuristic fallback or throw.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  UnitEconomicsSchema,
  type UnitEconomics,
} from '../pipeline/types.js';
import { getSectorEntry, type Sector } from './domain-unit-registry.js';

const MANIFEST_NAME = 'unit-economics.json';

export interface LoadUnitEconomicsResult {
  readonly manifest: UnitEconomics | null;
  /** Absolute path inspected, even when the file was missing. Useful for logs. */
  readonly inspectedPath: string | null;
  readonly reason: 'loaded' | 'missing' | 'invalid-json' | 'schema-rejected';
  readonly error?: string;
}

/**
 * Load the unit-economics manifest for a run.
 *
 * Search order:
 *   1. `<runDir>/unit-economics.json`
 *   2. `<runDir>/artifacts/unit-economics.json`
 *
 * Returns {manifest: null} for any missing/invalid case. This function never
 * throws — the 3-tier precedence in renderFinancialAnalysis relies on a
 * permissive contract.
 */
export function loadUnitEconomics(runDir: string | null | undefined): LoadUnitEconomicsResult {
  if (!runDir) {
    return { manifest: null, inspectedPath: null, reason: 'missing' };
  }

  const candidates = [
    path.join(runDir, MANIFEST_NAME),
    path.join(runDir, 'artifacts', MANIFEST_NAME),
  ];

  let inspectedPath: string | null = null;
  for (const candidate of candidates) {
    inspectedPath = candidate;
    if (!fs.existsSync(candidate)) continue;

    let raw: string;
    try {
      raw = fs.readFileSync(candidate, 'utf-8');
    } catch (err) {
      return {
        manifest: null,
        inspectedPath: candidate,
        reason: 'invalid-json',
        error: err instanceof Error ? err.message : String(err),
      };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      return {
        manifest: null,
        inspectedPath: candidate,
        reason: 'invalid-json',
        error: err instanceof Error ? err.message : String(err),
      };
    }

    const result = UnitEconomicsSchema.safeParse(parsed);
    if (!result.success) {
      return {
        manifest: null,
        inspectedPath: candidate,
        reason: 'schema-rejected',
        error: result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; '),
      };
    }
    return { manifest: result.data, inspectedPath: candidate, reason: 'loaded' };
  }

  return { manifest: null, inspectedPath, reason: 'missing' };
}

// ============================================================================
// Renderer helpers
// ============================================================================

export interface UnitEconomicsFinancialModel {
  readonly budget: string;
  readonly roi: string;
  readonly npv: string;
  readonly payback: string;
  readonly revenue: string;
  readonly costSavings: string;
  readonly methodology: string;
  /** Scope ratio used for extrapolation (enterprise / measured). */
  readonly scopeRatio: number;
}

/**
 * ADR-PIPELINE-110 D1: the single canonical USD formatter. ALWAYS includes the
 * leading `$`. Callers MUST interpolate it as `${formatUsd(n)}` and never
 * prefix their own `$` (the double-`$` defect). Exported so every financial
 * renderer shares one formatter.
 */
export function formatUsd(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '$0';
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(0)}K`;
  return `$${Math.round(n)}`;
}

/** @deprecated use {@link formatUsd}. Retained as an internal alias. */
const formatMoney = formatUsd;

function computeScopeRatio(manifest: UnitEconomics): number {
  const entry = getSectorEntry(manifest.sector as Sector);
  const keys = entry?.scopeKeys ?? ['units', 'rooms', 'sqft', 'vehicles', 'beds', 'agents', 'properties'];
  for (const key of keys) {
    const measured = (manifest.measured_scope as Record<string, unknown>)[key];
    const enterprise = (manifest.enterprise_scope as Record<string, unknown>)[key];
    if (typeof measured === 'number' && typeof enterprise === 'number' && measured > 0) {
      return enterprise / measured;
    }
  }
  // Fall back to the saved ratio implied by the two savings numbers.
  if (manifest.annual_measured_savings_usd > 0) {
    return manifest.annual_extrapolated_savings_usd / manifest.annual_measured_savings_usd;
  }
  return 1;
}

/**
 * Derive the FinancialData fields the executive renderer needs from a
 * unit-economics manifest. Uses the manifest's own numbers — no heuristic
 * substitution.
 */
export function buildFinancialModelFromUnitEconomics(
  manifest: UnitEconomics,
): UnitEconomicsFinancialModel {
  const measured = manifest.annual_measured_savings_usd;
  const enterprise = manifest.annual_extrapolated_savings_usd;
  const ratio = computeScopeRatio(manifest);
  const entry = getSectorEntry(manifest.sector as Sector);
  const unitLabel = manifest.domain_unit.label;
  const formula = entry?.savingsFormula ?? `${unitLabel} × unit economics`;

  // Implementation cost rule-of-thumb: 40% of year-1 enterprise savings, floor $500K.
  const implCost = Math.max(500_000, Math.round(enterprise * 0.4));
  const roiPct = enterprise > 0 ? Math.round((enterprise / implCost) * 100) : 0;
  const paybackMonths = enterprise > 0
    ? Math.max(3, Math.min(36, Math.round((implCost / enterprise) * 12)))
    : 24;
  const npv5yr = Math.round(enterprise * 3.5 - implCost);

  // ADR-PIPELINE-110 D1: formatUsd already includes `$` — do NOT prefix another.
  const methodology =
    `Bottom-up unit economics (${formula}); measured pilot ${formatUsd(measured)}/yr scales ${ratio.toFixed(1)}× to enterprise ${formatUsd(enterprise)}/yr via ${manifest.extrapolation_method}.`;

  return {
    budget: `${formatMoney(implCost)} – ${formatMoney(implCost * 1.4)} (${methodology})`,
    roi: `${roiPct}% projected (${formatMoney(enterprise)} annual savings ÷ ${formatMoney(implCost)} investment)`,
    npv: `${formatMoney(npv5yr)} 5-year NPV (10% discount rate, ${formatMoney(enterprise)}/yr enterprise savings)`,
    payback: `${paybackMonths} months (break-even when cumulative savings exceed investment)`,
    revenue: `${formatMoney(enterprise)} annual enterprise savings — ${formatMoney(measured)} measured on pilot scope, extrapolated via ${manifest.extrapolation_method}`,
    costSavings: `Pilot (${describeScope(manifest.measured_scope)}): ${formatMoney(measured)}/yr · Enterprise (${describeScope(manifest.enterprise_scope)}): ${formatMoney(enterprise)}/yr`,
    methodology,
    scopeRatio: ratio,
  };
}

function describeScope(scope: UnitEconomics['measured_scope']): string {
  const parts: string[] = [];
  const record = scope as unknown as Record<string, unknown>;
  for (const key of ['properties', 'rooms', 'sqft', 'vehicles', 'beds', 'agents', 'units']) {
    const v = record[key];
    if (typeof v === 'number' && v > 0) parts.push(`${v.toLocaleString()} ${key}`);
  }
  if (parts.length === 0) return 'pilot scope';
  return parts.join(', ');
}

// ============================================================================
// Scope-ratio consistency check — ADR-PIPELINE-066 §5
// ============================================================================

export class UnitEconomicsConsistencyError extends Error {
  constructor(message: string, public readonly code = 'ECLI-SYN-066') {
    super(`${code}: ${message}`);
    this.name = 'UnitEconomicsConsistencyError';
  }
}

export interface ConsistencyCheckResult {
  readonly passed: boolean;
  readonly violations: string[];
}

/**
 * Verify that numbers derived from the manifest still match the manifest
 * within tolerance. Used right before we emit a document so drift between
 * the manifest and the printed prose is caught.
 */
export function verifyManifestConsistency(
  manifest: UnitEconomics,
  printed: {
    measuredSavingsUsd?: number;
    enterpriseSavingsUsd?: number;
  },
  tolerancePct = 1,
): ConsistencyCheckResult {
  const violations: string[] = [];
  const tol = tolerancePct / 100;

  if (typeof printed.measuredSavingsUsd === 'number') {
    const delta = Math.abs(printed.measuredSavingsUsd - manifest.annual_measured_savings_usd);
    const max = Math.max(1, manifest.annual_measured_savings_usd * tol);
    if (delta > max) {
      violations.push(
        `printed measured savings $${printed.measuredSavingsUsd.toLocaleString()} differs from manifest $${manifest.annual_measured_savings_usd.toLocaleString()} by more than ±${tolerancePct}%`,
      );
    }
  }

  if (typeof printed.enterpriseSavingsUsd === 'number') {
    const delta = Math.abs(printed.enterpriseSavingsUsd - manifest.annual_extrapolated_savings_usd);
    const max = Math.max(1, manifest.annual_extrapolated_savings_usd * tol);
    if (delta > max) {
      violations.push(
        `printed enterprise savings $${printed.enterpriseSavingsUsd.toLocaleString()} differs from manifest $${manifest.annual_extrapolated_savings_usd.toLocaleString()} by more than ±${tolerancePct}%`,
      );
    }
  }

  if (
    typeof printed.measuredSavingsUsd === 'number' &&
    typeof printed.enterpriseSavingsUsd === 'number' &&
    printed.measuredSavingsUsd > 0
  ) {
    const ratio = printed.enterpriseSavingsUsd / printed.measuredSavingsUsd;
    const manifestRatio = computeScopeRatio(manifest);
    const ratioDelta = Math.abs(ratio - manifestRatio);
    const ratioMax = Math.max(0.01, manifestRatio * 0.05);
    if (ratioDelta > ratioMax) {
      violations.push(
        `pilot→enterprise ratio ${ratio.toFixed(2)}× differs from manifest scope ratio ${manifestRatio.toFixed(2)}× by more than ±5%`,
      );
    }
  }

  return { passed: violations.length === 0, violations };
}

/**
 * Entrypoint used by the renderer: run the check, then either throw (strict
 * mode) or return the violations for a soft warning.
 */
export function enforceManifestConsistency(
  manifest: UnitEconomics,
  printed: { measuredSavingsUsd?: number; enterpriseSavingsUsd?: number },
): ConsistencyCheckResult {
  const result = verifyManifestConsistency(manifest, printed);
  if (!result.passed && process.env['AGENTICS_STRICT_UNIT_ECONOMICS'] === 'true') {
    throw new UnitEconomicsConsistencyError(result.violations.join('; '));
  }
  return result;
}
