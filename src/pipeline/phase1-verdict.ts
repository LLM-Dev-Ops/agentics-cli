/**
 * ADR-PIPELINE-089 §2 — Phase 1 Health Gate.
 *
 * Classifies the outcome of `executeNaturalLanguageRoute` (Phase 1) into
 * one of three verdicts:
 *
 *   - 'failed'   — auto-chain must be skipped; user sees the specific cause.
 *   - 'degraded' — auto-chain proceeds, but we warn loudly about what is
 *                  missing so the user can judge the output.
 *   - 'healthy'  — all inputs intact; auto-chain proceeds silently.
 *
 * Inputs:
 *   - invocations: the per-agent dispatch results (from RouteResult)
 *   - degradations: the list drained from the degradation sink (tag
 *                   survival, consensus, sector-classifier, local
 *                   fallbacks, etc.)
 *   - artifactFiles: the list of files the artifact generator wrote
 *
 * The verdict is computed structurally — no stderr parsing, no global
 * state. Same inputs always produce the same verdict.
 */

import { classifyFailure } from '../errors/transient.js';
import type { Degradation } from '../observability/degradations.js';

export type Phase1Verdict = 'healthy' | 'degraded' | 'failed';

export interface Phase1VerdictResult {
  verdict: Phase1Verdict;
  degradations: Degradation[];
  /** Concise reason string for the banner — single sentence. */
  reason: string;
  /** Counts used by the classifier, preserved for status.json consumers. */
  stats: {
    totalAgents: number;
    succeededAgents: number;
    erroredAgents: number;
    artifactCount: number;
    simulatorStatus: 'succeeded' | 'failed-transient' | 'failed-terminal' | 'failed-unknown' | 'not-invoked';
  };
}

interface InvocationLike {
  intent: { domain: string; agent: string };
  result: unknown;
}

// ============================================================================
// Classifier
// ============================================================================

const DEGRADED_MAX_AGENT_ERROR_RATIO = 0.5; // >50% agent errors → failed
const HEALTHY_REQUIRES_ZERO_DEGRADATIONS = true;

/**
 * Compute the Phase 1 verdict from structural dispatch results plus the
 * drained degradation list.
 *
 * @param invocations Per-agent invocation results (as `multi.result.invocations`)
 * @param degradations Collected degradation entries for this trace
 * @param artifactFiles Files the artifact generator produced on disk
 */
export function computePhase1Verdict(
  invocations: readonly InvocationLike[],
  degradations: readonly Degradation[],
  artifactFiles: readonly string[],
): Phase1VerdictResult {
  const simInvocation = invocations.find(
    i => i.intent.domain === 'simulator' && i.intent.agent === 'enterprise',
  );
  const simStatus = classifySimulator(simInvocation);

  const agentInvocations = invocations.filter(
    i => !(i.intent.domain === 'simulator' && i.intent.agent === 'enterprise'),
  );
  const erroredAgents = agentInvocations.filter(i => isErrorResult(i.result)).length;
  const totalAgents = agentInvocations.length;
  const succeededAgents = totalAgents - erroredAgents;
  const agentErrorRatio = totalAgents === 0 ? 0 : erroredAgents / totalAgents;

  const degSnapshot = degradations.slice();
  const stats = {
    totalAgents,
    succeededAgents,
    erroredAgents,
    artifactCount: artifactFiles.length,
    simulatorStatus: simStatus,
  };

  // ── failed cases ────────────────────────────────────────────────────────
  if (simStatus === 'failed-terminal' || simStatus === 'failed-unknown') {
    return {
      verdict: 'failed',
      degradations: [
        ...degSnapshot,
        {
          code: 'simulator-terminal',
          message: extractErrorMessage(simInvocation?.result) ??
            'Enterprise simulation failed with a non-retryable error',
          phase: 1,
          source: 'simulator/enterprise',
        },
      ],
      reason: `Enterprise simulation failed terminally: ${extractErrorMessage(simInvocation?.result) ?? 'unknown error'}`,
      stats,
    };
  }

  if (simStatus === 'failed-transient') {
    // Retry loop already gave up. Treat as failed for gating purposes but
    // tag the degradation distinctly so the user knows a re-run is likely
    // to succeed.
    return {
      verdict: 'failed',
      degradations: [
        ...degSnapshot,
        {
          code: 'simulator-transient',
          message: extractErrorMessage(simInvocation?.result) ??
            'Enterprise simulation exhausted retries on transient errors',
          phase: 1,
          source: 'simulator/enterprise',
        },
      ],
      reason: `Enterprise simulation exhausted retries: ${extractErrorMessage(simInvocation?.result) ?? 'transient errors'} — re-run recommended`,
      stats,
    };
  }

  if (artifactFiles.length === 0) {
    return {
      verdict: 'failed',
      degradations: [
        ...degSnapshot,
        {
          code: 'artifact-missing',
          message: 'Phase 1 artifact generator produced zero files',
          phase: 1,
          source: 'artifact-generator',
        },
      ],
      reason: 'Phase 1 produced no artifacts on disk',
      stats,
    };
  }

  if (agentErrorRatio > DEGRADED_MAX_AGENT_ERROR_RATIO) {
    return {
      verdict: 'failed',
      degradations: degSnapshot,
      reason: `${erroredAgents} of ${totalAgents} graph-routed agents errored (>${Math.round(DEGRADED_MAX_AGENT_ERROR_RATIO * 100)}% threshold)`,
      stats,
    };
  }

  // ── degraded cases ──────────────────────────────────────────────────────
  if (erroredAgents > 0 || degSnapshot.length > 0) {
    return {
      verdict: 'degraded',
      degradations: degSnapshot,
      reason: buildDegradedReason(erroredAgents, totalAgents, degSnapshot),
      stats,
    };
  }

  // ── healthy ────────────────────────────────────────────────────────────
  if (HEALTHY_REQUIRES_ZERO_DEGRADATIONS && degSnapshot.length > 0) {
    // Defensive: theoretically unreachable given the branch above, but keep
    // the invariant visible.
    return {
      verdict: 'degraded',
      degradations: degSnapshot,
      reason: buildDegradedReason(0, totalAgents, degSnapshot),
      stats,
    };
  }
  return {
    verdict: 'healthy',
    degradations: [],
    reason: `${succeededAgents}/${totalAgents} agents succeeded, ${artifactFiles.length} artifacts written`,
    stats,
  };
}

// ============================================================================
// Helpers
// ============================================================================

function classifySimulator(
  inv: InvocationLike | undefined,
): Phase1VerdictResult['stats']['simulatorStatus'] {
  if (!inv) return 'not-invoked';
  if (!isErrorResult(inv.result)) return 'succeeded';
  const msg = extractErrorMessage(inv.result) ?? '';
  const kind = classifyFailure(msg);
  if (kind === 'terminal') return 'failed-terminal';
  if (kind === 'transient') return 'failed-transient';
  return 'failed-unknown';
}

function isErrorResult(r: unknown): boolean {
  return typeof r === 'object' && r !== null && 'error' in r;
}

function extractErrorMessage(r: unknown): string | undefined {
  if (typeof r !== 'object' || r === null) return undefined;
  const err = (r as { error?: unknown }).error;
  if (typeof err === 'string') return err;
  if (typeof err === 'object' && err !== null && 'message' in err &&
      typeof (err as { message: unknown }).message === 'string') {
    return (err as { message: string }).message;
  }
  return undefined;
}

function buildDegradedReason(
  erroredAgents: number,
  totalAgents: number,
  degradations: readonly Degradation[],
): string {
  const parts: string[] = [];
  if (erroredAgents > 0) {
    parts.push(`${erroredAgents} of ${totalAgents} agents errored`);
  }
  const codeCounts = new Map<string, number>();
  for (const d of degradations) {
    codeCounts.set(d.code, (codeCounts.get(d.code) ?? 0) + 1);
  }
  for (const [code, count] of codeCounts) {
    parts.push(count > 1 ? `${code} × ${count}` : code);
  }
  return parts.length > 0 ? parts.join('; ') : 'one or more degradations recorded';
}
