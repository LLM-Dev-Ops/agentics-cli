/**
 * ADR-PIPELINE-072 §1 — Pre-Render Analysis Pass coordinator.
 *
 * Orchestrates:
 *   1. Classify sector from query + domain analysis
 *   2. Compute bottom-up unit economics via `computePreRenderUnitEconomics`
 *   3. Write `<runDir>/unit-economics.json` with `source='prototype-preview'`
 *
 * Runs BEFORE `renderExecutiveSummary`, `renderDecisionMemo`, and
 * `renderFinancialAnalysis` so the ADR-066 tier-1 manifest path fires on
 * every run.
 *
 * The module is purely additive: if it fails (unknown sector, I/O error,
 * schema validation) the renderers fall back to ADR-066 tier-3 heuristic +
 * mandatory warning banner — which is the exact behavior before this ADR.
 * Never blocks the pipeline.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { DomainAnalysis } from '../../synthesis/simulation-renderers.js';
import { UnitEconomicsSchema, type UnitEconomics } from '../types.js';
import {
  computePreRenderUnitEconomics,
  type PreRenderFinancialOutput,
} from './financial-model.js';

export interface PreRenderInput {
  readonly runDir: string;
  readonly runId: string;
  readonly query: string;
  /** Scenario artifact (already built in simulation-artifact-generator). */
  readonly scenarioArtifact?: Record<string, unknown> | null;
  /** Domain analysis from ADR-PIPELINE-041 enrichment. */
  readonly domainAnalysis?: DomainAnalysis | null;
}

export type PreRenderOutcome =
  | {
      readonly status: 'emitted';
      readonly manifestPath: string;
      readonly manifest: UnitEconomics;
      readonly metrics: PreRenderFinancialOutput['metrics'];
    }
  | {
      readonly status: 'skipped';
      readonly reason: 'unknown-sector' | 'schema-rejected' | 'io-error' | 'existing-prototype-manifest';
      readonly detail?: string;
    };

/**
 * Run the pre-render pass. Never throws. Returns an `emitted` result on
 * success or a `skipped` result with a reason when the pass can't produce
 * a preview manifest.
 */
export function executePreRender(input: PreRenderInput): PreRenderOutcome {
  const manifestPath = path.join(input.runDir, 'unit-economics.json');

  // If a prototype-sourced manifest already exists at this path (e.g. the
  // user re-ran the pipeline and an earlier prototype demo landed a real
  // manifest in the same runDir), leave it alone. Pre-render never
  // overwrites a real prototype manifest.
  if (existingPrototypeManifest(manifestPath)) {
    return {
      status: 'skipped',
      reason: 'existing-prototype-manifest',
      detail: 'A prototype-sourced unit-economics.json already exists; pre-render left it untouched.',
    };
  }

  const sectorHint = input.domainAnalysis?.domain ?? null;
  const financial = computePreRenderUnitEconomics({
    runId: input.runId,
    query: input.query,
    sectorHint,
  });

  if (!financial) {
    return {
      status: 'skipped',
      reason: 'unknown-sector',
      detail: 'classifySector returned "unknown" — no ADR-066 registry entry.',
    };
  }

  const parsed = UnitEconomicsSchema.safeParse(financial.manifest);
  if (!parsed.success) {
    return {
      status: 'skipped',
      reason: 'schema-rejected',
      detail: parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; '),
    };
  }

  try {
    fs.mkdirSync(input.runDir, { recursive: true });
    fs.writeFileSync(manifestPath, JSON.stringify(parsed.data, null, 2) + '\n', 'utf-8');
  } catch (err) {
    return {
      status: 'skipped',
      reason: 'io-error',
      detail: err instanceof Error ? err.message : String(err),
    };
  }

  return {
    status: 'emitted',
    manifestPath,
    manifest: parsed.data,
    metrics: financial.metrics,
  };
}

function existingPrototypeManifest(manifestPath: string): boolean {
  if (!fs.existsSync(manifestPath)) return false;
  try {
    const raw = fs.readFileSync(manifestPath, 'utf-8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return parsed['source'] === 'prototype';
  } catch {
    // Corrupt file — pre-render will overwrite it
    return false;
  }
}

// Exported for tests + reconciler module.
export function readManifestIfExists(manifestPath: string): UnitEconomics | null {
  if (!fs.existsSync(manifestPath)) return null;
  try {
    const raw = fs.readFileSync(manifestPath, 'utf-8');
    const parsed = UnitEconomicsSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
