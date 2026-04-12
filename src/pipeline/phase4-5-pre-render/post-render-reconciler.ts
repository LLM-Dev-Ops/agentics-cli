/**
 * ADR-PIPELINE-072 §5 — Post-Render Reconciliation.
 *
 * After the coding agent generates the prototype and its demo runs, the
 * real demo calls `writeUnitEconomics()` and overwrites
 * `<runDir>/unit-economics.json` with `source='prototype'` carrying
 * measured (not predicted) numbers.
 *
 * This reconciler reads BOTH manifests from the same run (the preview
 * remains in `<runDir>/unit-economics.preview.json` after the pre-render
 * pass), computes the drift, and emits:
 *
 *   - `<runDir>/reconciliation.report.json` — structured drift report
 *   - a drift warning header that can be prepended to executive docs
 *     when drift > 25% on the headline savings number
 *
 * The reconciler is strictly informational — it never blocks the pipeline.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { UnitEconomics } from '../types.js';
import { readManifestIfExists } from './pre-render-coordinator.js';

export interface ReconciliationInput {
  readonly runDir: string;
  readonly runId: string;
}

export interface ReconciliationReport {
  readonly run_id: string;
  readonly generated_at: string;
  readonly status: 'aligned' | 'drift' | 'missing-preview' | 'missing-prototype';
  readonly drift_pct: number | null;
  readonly tolerance_pct: number;
  readonly preview: {
    readonly annual_measured_savings_usd: number;
    readonly annual_extrapolated_savings_usd: number;
  } | null;
  readonly prototype: {
    readonly annual_measured_savings_usd: number;
    readonly annual_extrapolated_savings_usd: number;
  } | null;
  readonly message: string;
}

export type ReconciliationOutcome =
  | { readonly status: 'wrote'; readonly reportPath: string; readonly report: ReconciliationReport }
  | { readonly status: 'skipped'; readonly reason: string };

const DEFAULT_TOLERANCE_PCT = 25;

export function executeReconciliation(input: ReconciliationInput): ReconciliationOutcome {
  const previewPath = path.join(input.runDir, 'unit-economics.preview.json');
  const manifestPath = path.join(input.runDir, 'unit-economics.json');

  const preview = readManifestIfExists(previewPath);
  const manifest = readManifestIfExists(manifestPath);

  const report: ReconciliationReport = buildReport({
    runId: input.runId,
    preview,
    prototype: manifest && manifest.source === 'prototype' ? manifest : null,
  });

  try {
    fs.mkdirSync(input.runDir, { recursive: true });
    const reportPath = path.join(input.runDir, 'reconciliation.report.json');
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n', 'utf-8');
    return { status: 'wrote', reportPath, report };
  } catch (err) {
    return {
      status: 'skipped',
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

interface ReportInputs {
  readonly runId: string;
  readonly preview: UnitEconomics | null;
  readonly prototype: UnitEconomics | null;
}

function buildReport(inputs: ReportInputs): ReconciliationReport {
  const now = new Date().toISOString();

  if (!inputs.preview && !inputs.prototype) {
    return {
      run_id: inputs.runId,
      generated_at: now,
      status: 'missing-preview',
      drift_pct: null,
      tolerance_pct: DEFAULT_TOLERANCE_PCT,
      preview: null,
      prototype: null,
      message: 'Neither a preview nor a prototype manifest was found — pipeline likely skipped the pre-render pass.',
    };
  }

  if (!inputs.preview) {
    return {
      run_id: inputs.runId,
      generated_at: now,
      status: 'missing-preview',
      drift_pct: null,
      tolerance_pct: DEFAULT_TOLERANCE_PCT,
      preview: null,
      prototype: inputs.prototype
        ? {
            annual_measured_savings_usd: inputs.prototype.annual_measured_savings_usd,
            annual_extrapolated_savings_usd: inputs.prototype.annual_extrapolated_savings_usd,
          }
        : null,
      message: 'Prototype manifest found but no pre-render preview to compare against. Reconciliation skipped.',
    };
  }

  if (!inputs.prototype) {
    return {
      run_id: inputs.runId,
      generated_at: now,
      status: 'missing-prototype',
      drift_pct: null,
      tolerance_pct: DEFAULT_TOLERANCE_PCT,
      preview: {
        annual_measured_savings_usd: inputs.preview.annual_measured_savings_usd,
        annual_extrapolated_savings_usd: inputs.preview.annual_extrapolated_savings_usd,
      },
      prototype: null,
      message: 'Preview manifest present but prototype demo did not produce a prototype-sourced manifest. Executive documents are operating on pre-render numbers only.',
    };
  }

  const previewUsd = inputs.preview.annual_extrapolated_savings_usd;
  const prototypeUsd = inputs.prototype.annual_extrapolated_savings_usd;
  const base = Math.max(1, Math.max(previewUsd, prototypeUsd));
  const driftPct = Math.round((Math.abs(previewUsd - prototypeUsd) / base) * 1000) / 10;

  const status = driftPct > DEFAULT_TOLERANCE_PCT ? 'drift' : 'aligned';
  const message = status === 'drift'
    ? `Preview $${previewUsd.toLocaleString()} vs. prototype $${prototypeUsd.toLocaleString()} drifted ${driftPct.toFixed(1)}% (tolerance ±${DEFAULT_TOLERANCE_PCT}%). Executive documents were rendered from the preview — consider regenerating them from the prototype manifest.`
    : `Preview and prototype manifests agree within ±${DEFAULT_TOLERANCE_PCT}%. Executive documents are consistent with measured prototype output.`;

  return {
    run_id: inputs.runId,
    generated_at: now,
    status,
    drift_pct: driftPct,
    tolerance_pct: DEFAULT_TOLERANCE_PCT,
    preview: {
      annual_measured_savings_usd: inputs.preview.annual_measured_savings_usd,
      annual_extrapolated_savings_usd: inputs.preview.annual_extrapolated_savings_usd,
    },
    prototype: {
      annual_measured_savings_usd: inputs.prototype.annual_measured_savings_usd,
      annual_extrapolated_savings_usd: inputs.prototype.annual_extrapolated_savings_usd,
    },
    message,
  };
}

/**
 * Produce a markdown warning header for inclusion at the top of affected
 * executive documents. Returns null when no warning is needed.
 */
export function formatDriftWarning(report: ReconciliationReport): string | null {
  if (report.status !== 'drift') return null;
  return [
    '> ⚠️ **Preview/prototype drift** — ' + report.message,
    '> See `reconciliation.report.json` for the full breakdown.',
    '',
  ].join('\n');
}
