/**
 * ADR-PIPELINE-094 Decision 8 — Phase-1 consensus reader for local fallback
 * generators. Reads Phase-1 simulator outputs (which Phase 1 writes flat to
 * `<runDir>/`) and exposes them as a typed, normalized shape.
 *
 * Consumed by the phase3/4/5a local fallback generators. Resilient to
 * partial Phase-1 output: any file may be missing; missing fields are left
 * undefined and the caller decides what to synthesize from what's present.
 *
 * Honours both layouts:
 *   - flat (production):   <runDir>/manifest.json
 *   - subdir (test fixture): <runDir>/phase1/manifest.json
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

/** Normalized snapshot of Phase-1 simulator consensus. All fields are optional. */
export interface Phase1Consensus {
  readonly runDir: string;
  readonly manifest?: Record<string, unknown>;
  readonly executiveSummary?: string;
  readonly decisionMemo?: string;
  readonly riskAssessment?: Record<string, unknown>;
  readonly scenario?: Record<string, unknown>;
  readonly architectureDecisions?: string;
  readonly projectLanguage?: string;
}

/**
 * Read Phase-1 outputs from `runDir`. Tries flat layout first (production),
 * then subdir (legacy/test). Returns `undefined` only when nothing
 * Phase-1-shaped exists; otherwise populates whichever fields were found.
 */
export function readPhase1Consensus(runDir: string): Phase1Consensus | undefined {
  const tryRead = (rel: string): string | undefined => {
    for (const candidate of [path.join(runDir, rel), path.join(runDir, 'phase1', rel)]) {
      try {
        const stat = fs.statSync(candidate);
        if (stat.isFile() && stat.size > 0) return fs.readFileSync(candidate, 'utf8');
      } catch { /* try next */ }
    }
    return undefined;
  };
  const tryReadJson = (rel: string): Record<string, unknown> | undefined => {
    const raw = tryRead(rel);
    if (!raw) return undefined;
    try {
      const parsed = JSON.parse(raw) as unknown;
      return (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
        ? parsed as Record<string, unknown>
        : undefined;
    } catch { return undefined; }
  };

  const manifest = tryReadJson('manifest.json');
  const executiveSummary = tryRead('executive-summary.md');
  const decisionMemo = tryRead('decision-memo.md');
  const riskAssessment = tryReadJson('risk-assessment.json');
  const scenario = tryReadJson('scenario.json');
  // engineering/architecture-decisions.md is the consensus output written by
  // some Phase-1 paths; the local fallback uses it when present to seed ADRs.
  let architectureDecisions: string | undefined;
  try {
    architectureDecisions = fs.readFileSync(
      path.join(runDir, 'engineering', 'architecture-decisions.md'),
      'utf8',
    );
  } catch { /* missing is fine */ }

  // Detect language from manifest.project.language; default to typescript.
  let projectLanguage: string | undefined;
  if (manifest && typeof manifest === 'object') {
    const project = (manifest as Record<string, unknown>)['project'];
    if (project && typeof project === 'object') {
      const lang = (project as Record<string, unknown>)['language'];
      if (typeof lang === 'string' && lang.trim().length > 0) {
        projectLanguage = lang.trim();
      }
    }
  }

  // Return undefined only if NOTHING phase-1-shaped was found.
  if (
    !manifest && !executiveSummary && !decisionMemo &&
    !riskAssessment && !scenario && !architectureDecisions
  ) {
    return undefined;
  }

  return {
    runDir,
    manifest,
    executiveSummary,
    decisionMemo,
    riskAssessment,
    scenario,
    architectureDecisions,
    projectLanguage,
  };
}

/** Extract the user-facing scenario query from a Phase-1 consensus. */
export function extractScenarioQuery(c: Phase1Consensus): string {
  if (c.scenario && typeof c.scenario['summary'] === 'string') {
    return (c.scenario['summary'] as string);
  }
  if (c.scenario && typeof c.scenario['query'] === 'string') {
    return (c.scenario['query'] as string);
  }
  if (c.manifest && typeof c.manifest['scenario'] === 'string') {
    return (c.manifest['scenario'] as string);
  }
  return '';
}
