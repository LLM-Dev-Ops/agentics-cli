/**
 * ADR-PIPELINE-089 §2 — Trace-scoped degradation sink.
 *
 * The Phase 1 Health Gate needs to know which degradations occurred during
 * a run in order to classify the verdict as `healthy | degraded | failed`.
 * Degradation signals come from multiple modules that do not share a call
 * stack: the agent dispatcher (local-compute fallbacks), the consensus
 * validator (`[pipeline-017]`), the pre-render pass (`[pipeline-072]`),
 * and the LLM synthesis tag-survival check (`[exec-docs]`).
 *
 * Rather than thread a collector through every signature, this module
 * exposes a process-local Map keyed by the correlation/trace id. Each
 * emission site makes a one-line call:
 *
 *   recordDegradation(traceId, { code: 'local-fallback',
 *                                 message: 'costops/attribution using local compute',
 *                                 source: 'agents-dispatcher' });
 *
 * The verdict compute step at the end of `executeNaturalLanguageRoute`
 * calls `drainDegradations(traceId)` to collect all entries and clear the
 * bucket. Clearing is important so subsequent runs in the same process
 * (tests, long-lived daemons) do not leak state.
 *
 * This is intentionally NOT a general-purpose telemetry channel. It
 * captures pipeline-health-relevant signals only. High-volume logs keep
 * going to stderr as before.
 */

export interface Degradation {
  /** Short stable identifier. Used by UIs and tests to key off the failure class. */
  code: DegradationCode;
  /** Human-readable one-liner. Shown in the Phase 1 banner verbatim. */
  message: string;
  /** Which phase emitted the signal. `1` covers everything inside Phase 1. */
  phase?: 1 | 2 | 3 | 4 | 5 | 6;
  /** Optional module/domain that produced the signal — diagnosis aid. */
  source?: string;
}

export type DegradationCode =
  | 'local-fallback'
  | 'agent-error'
  | 'agent-preflight-unhealthy'
  | 'consensus-low'
  | 'sector-unknown'
  | 'tag-survival-failed'
  | 'artifact-missing'
  | 'simulator-transient'
  | 'simulator-terminal'
  | 'synthesis-unavailable';

// ============================================================================
// Storage — process-local, trace-keyed.
// ============================================================================

const buckets = new Map<string, Degradation[]>();

/**
 * Record a degradation against a trace. Safe to call with an empty trace
 * id — the call silently no-ops rather than binding to a shared ''
 * bucket that would cross-contaminate runs.
 */
export function recordDegradation(traceId: string | undefined, d: Degradation): void {
  if (!traceId) return;
  let bucket = buckets.get(traceId);
  if (!bucket) {
    bucket = [];
    buckets.set(traceId, bucket);
  }
  bucket.push(d);
}

/**
 * Return all degradations recorded against `traceId` (in insertion order)
 * and clear the bucket. Returns an empty array if the trace has no entries.
 */
export function drainDegradations(traceId: string | undefined): Degradation[] {
  if (!traceId) return [];
  const bucket = buckets.get(traceId);
  if (!bucket) return [];
  buckets.delete(traceId);
  return bucket;
}

/**
 * Non-destructive read — for tests and for cases where the caller wants to
 * inspect the bucket without draining (e.g. a post-phase snapshot without
 * clearing state that later phases will add to).
 */
export function peekDegradations(traceId: string | undefined): readonly Degradation[] {
  if (!traceId) return [];
  return buckets.get(traceId) ?? [];
}

/** Test helper — clears ALL trace buckets. Do not use in production paths. */
export function __resetDegradationsForTests(): void {
  buckets.clear();
}
