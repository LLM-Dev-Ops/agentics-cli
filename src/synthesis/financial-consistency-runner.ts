/**
 * ADR-PIPELINE-067: Financial Consistency Runner
 *
 * Orchestrates the extract → rules → report pipeline. Writes a structured
 * violations report to the run directory, prepends a warning header to any
 * affected markdown document, and escalates to a hard failure under
 * AGENTICS_STRICT_FCV=true.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  extractClaims,
  type FinancialClaim,
  type FinancialClaimDocument,
} from './financial-claim-extractor.js';
import {
  runConsistencyRules,
  countViolations,
  type Violation,
} from './financial-consistency-rules.js';
import { loadUnitEconomics } from './unit-economics-loader.js';
import type { UnitEconomics } from '../pipeline/types.js';
import type { ConsensusSnapshot } from './consensus-tiers.js';

export interface InputDocument {
  readonly kind: FinancialClaimDocument;
  readonly path: string;
  readonly content: string;
}

export interface ConsistencyReport {
  readonly run_id: string;
  readonly generated_at: string;
  readonly passed: boolean;
  readonly strict: boolean;
  readonly totals: { errors: number; warnings: number };
  readonly violations: readonly ReportViolation[];
  readonly documents_scanned: number;
  readonly claims_extracted: number;
}

export interface ReportViolation {
  readonly rule_id: string;
  readonly severity: 'error' | 'warn';
  readonly message: string;
  readonly suggested_fix?: string;
  readonly claims: readonly ReportClaim[];
}

export interface ReportClaim {
  readonly document: FinancialClaimDocument;
  readonly section: string;
  readonly kind: string;
  readonly scope: string;
  readonly line: number;
  readonly rawText: string;
}

export class FinancialConsistencyError extends Error {
  constructor(message: string, public readonly code = 'ECLI-SYN-067') {
    super(`${code}: ${message}`);
    this.name = 'FinancialConsistencyError';
  }
}

export interface RunOptions {
  readonly documents: readonly InputDocument[];
  readonly runDir: string;
  readonly runId?: string;
  readonly manifest?: UnitEconomics | null;
  /** Optional consensus snapshot — required for FCR-010 (ADR-PIPELINE-071). */
  readonly consensus?: ConsensusSnapshot | null;
  /** Override for testing. Defaults to AGENTICS_STRICT_FCV env check. */
  readonly strict?: boolean;
  /** When true, write affected documents back with a warning header. */
  readonly annotateDocuments?: boolean;
}

export interface RunResult {
  readonly report: ConsistencyReport;
  readonly reportPath: string;
  readonly violations: readonly Violation[];
  readonly claims: readonly FinancialClaim[];
}

function toReportViolation(v: Violation): ReportViolation {
  return {
    rule_id: v.ruleId,
    severity: v.severity,
    message: v.message,
    ...(v.suggestedFix ? { suggested_fix: v.suggestedFix } : {}),
    claims: v.claims.map(c => ({
      document: c.document,
      section: c.section,
      kind: c.kind,
      scope: c.scope,
      line: c.line,
      rawText: c.rawText,
    })),
  };
}

function buildWarningHeader(docViolations: readonly Violation[]): string {
  const totals = countViolations(docViolations);
  if (totals.errors === 0 && totals.warnings === 0) return '';
  const lines: string[] = [
    `> ⚠️ **Financial consistency:** ${totals.errors} error${totals.errors === 1 ? '' : 's'}, ${totals.warnings} warning${totals.warnings === 1 ? '' : 's'} — see \`financial-consistency.report.json\`.`,
  ];
  for (const v of docViolations.slice(0, 3)) {
    lines.push(`> - ${v.ruleId} (${v.severity}): ${v.message}`);
  }
  if (docViolations.length > 3) {
    lines.push(`> - …and ${docViolations.length - 3} more`);
  }
  lines.push('');
  return lines.join('\n');
}

/**
 * Run the extractor + rules against a set of documents and write the report.
 * Returns the structured result so callers can log, annotate, or branch.
 */
export function runConsistencyCheck(options: RunOptions): RunResult {
  const {
    documents,
    runDir,
    runId = path.basename(runDir),
    manifest = null,
    annotateDocuments = true,
  } = options;

  const strict =
    options.strict ?? process.env['AGENTICS_STRICT_FCV'] === 'true';

  // 1. Extract claims across all documents.
  const claims: FinancialClaim[] = [];
  for (const doc of documents) {
    claims.push(...extractClaims(doc.content, doc.kind));
  }

  // 2. Load the manifest if the caller didn't pre-supply one.
  const resolvedManifest = manifest ?? loadUnitEconomics(runDir).manifest;

  // 3. Run rules. Pass through consensus + raw document bodies so FCR-010
  //    (ADR-PIPELINE-071) can scan for forbidden spin phrases on contested
  //    runs without re-reading the markdown.
  const ruleDocuments = documents.map(d => ({ document: d.kind, content: d.content }));
  const violations = runConsistencyRules({
    claims,
    manifest: resolvedManifest,
    documents: ruleDocuments,
    consensus: options.consensus ?? null,
  });
  const totals = countViolations(violations);
  const passed = totals.errors === 0;

  // 4. Build and write the report.
  const report: ConsistencyReport = {
    run_id: runId,
    generated_at: new Date().toISOString(),
    passed,
    strict,
    totals,
    violations: violations.map(toReportViolation),
    documents_scanned: documents.length,
    claims_extracted: claims.length,
  };

  const reportPath = path.join(runDir, 'financial-consistency.report.json');
  try {
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n', 'utf-8');
  } catch {
    // Report write is best-effort; don't block the pipeline on an I/O failure.
  }

  // 5. Optionally annotate affected documents in place.
  if (annotateDocuments && violations.length > 0) {
    const byDoc = new Map<string, Violation[]>();
    for (const v of violations) {
      for (const c of v.claims) {
        const list = byDoc.get(c.document) ?? [];
        if (!list.includes(v)) list.push(v);
        byDoc.set(c.document, list);
      }
    }
    for (const doc of documents) {
      const docViolations = byDoc.get(doc.kind);
      if (!docViolations || docViolations.length === 0) continue;
      const header = buildWarningHeader(docViolations);
      if (!header) continue;
      try {
        fs.writeFileSync(doc.path, header + '\n' + doc.content, 'utf-8');
      } catch {
        // annotate is best-effort
      }
    }
  }

  // 6. Escalate on errors when strict.
  if (!passed && strict) {
    throw new FinancialConsistencyError(
      `${totals.errors} error-severity violation${totals.errors === 1 ? '' : 's'} across ${documents.length} documents`,
    );
  }

  return { report, reportPath, violations, claims };
}
