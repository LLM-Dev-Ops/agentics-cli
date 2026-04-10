/**
 * ADR-PIPELINE-061: Phase gate threshold defaults.
 *
 * Single source of truth for the quantified thresholds used in
 * `buildPhaseGates()`. Consulting defaults — tune here without
 * touching business logic.
 *
 * These are NOT environment variables. They are compile-time defaults
 * chosen to match industry benchmarks for enterprise pilot programs.
 * If a specific engagement needs different values, fork this file per
 * deployment or inject via a future configuration layer.
 */

export const PHASE_GATE_THRESHOLDS = {
  // Gate 1 — Technical Validation
  erpFieldCoveragePct: 0.80,         // 80% of required fields validated
  scoringAccuracyPct: 0.75,          // 75% agreement with manual baseline
  systemUptimePct: 0.99,             // 99% uptime during business hours
  auditIntegrityPct: 1.00,           // 100% hash chain verification
  // Gate 2 — Business Validation
  savingsVariancePct: 0.30,          // Realized within ±30% of projection
  userAdoptionPct: 0.60,             // 60% of pilot department active users
  falsePositiveRatePct: 0.10,        // <10% of recommendations flagged as wrong
  erpTransactionSuccessPct: 0.95,    // 95% ERP writeback success
  // Gate 3 — Scale Readiness
  projectedRoiMultiplier: 1.50,      // 150% projected enterprise ROI
  securityCriticalFindings: 0,       // Zero critical/high findings
  changeManagementReadinessPct: 0.80, // 80% of target users trained
  dbLatencyP95Ms: 200,               // <200ms p95 at projected scale
} as const;

export type PhaseGateThresholds = typeof PHASE_GATE_THRESHOLDS;

/** Format a percentage threshold as a readable string (e.g., 0.80 → "80%"). */
export function pct(value: number): string {
  return `${Math.round(value * 100)}%`;
}
