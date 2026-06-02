/**
 * Fleet dispatch bounds — shared timeout / circuit-breaker primitives.
 *
 * ADR-PIPELINE-108: the Phase 1 full-fleet dispatch (109 agents) and the
 * Phase 2–6 phase fanouts must share ONE bounding discipline:
 *   - a per-agent timeout so no single agent can stall the batch, and
 *   - a per-fanout cloud circuit breaker so a dead backend short-circuits
 *     the remaining cloud calls instead of each eating its full timeout.
 *
 * These primitives previously lived inside `swarm-orchestrator.ts`, but
 * `swarm-orchestrator.ts` imports `executeAgentsInvokeCommand` from
 * `commands/agents.ts`. Having `agents.ts` import the breaker back from the
 * orchestrator would create an import cycle, so the shared pieces live here
 * in a leaf module that neither imports from. `swarm-orchestrator.ts`
 * re-exports `CloudCircuitBreaker` / `CloudBreakerState` for back-compat
 * (existing tests import them from there).
 */

// ============================================================================
// Cloud circuit breaker (ADR-094 D7, generalised by ADR-108)
// ============================================================================

/** Default consecutive cloud-failure threshold before the breaker trips. */
export const DEFAULT_CLOUD_BREAKER_THRESHOLD = 3;

/** State exposed by `CloudCircuitBreaker.state()`. */
export interface CloudBreakerState {
  readonly tripped: boolean;
  readonly after_n_timeouts: number;
  readonly agents: ReadonlyArray<string>;
}

/**
 * Per-fanout circuit breaker that trips after N consecutive cloud-tier
 * failures and short-circuits remaining cloud invocations. Local-tier
 * successes do not reset the streak; they bypass the breaker.
 *
 * Cloud-tier successes DO reset the streak — if even one cloud call works,
 * we trust the cloud is alive again. This matches the originating-run
 * failure mode where an entire backend fleet was down at once.
 *
 * Resets per fanout. Exported for unit tests.
 */
export class CloudCircuitBreaker {
  private consecutiveCloudFailures = 0;
  private trippedFlag = false;
  private trippedAfterN = 0;
  private readonly trippedAgents: string[] = [];
  private readonly threshold: number;

  constructor(threshold = DEFAULT_CLOUD_BREAKER_THRESHOLD) {
    this.threshold = Math.max(1, threshold);
  }

  /**
   * Record an invocation outcome. `tier` is the tier the call was dispatched
   * on. `failed=true` AND `tier='cloud'` increments the consecutive-failure
   * counter; a cloud success resets it.
   */
  record(failed: boolean, tier: 'cloud' | 'local' | 'unknown', agentLabel: string): void {
    if (this.trippedFlag) return; // already tripped — record-only mode
    if (tier === 'cloud') {
      if (failed) {
        this.consecutiveCloudFailures++;
        this.trippedAgents.push(agentLabel);
        if (this.consecutiveCloudFailures >= this.threshold) {
          this.trippedFlag = true;
          this.trippedAfterN = this.consecutiveCloudFailures;
          process.stderr.write(
            `[BREAKER] cloud breaker tripped after ${this.trippedAfterN} timeouts (${this.trippedAgents.slice(0, 5).join(', ')}${this.trippedAgents.length > 5 ? ', …' : ''})\n`,
          );
        }
      } else {
        // Cloud success — clear the streak. Cloud is alive.
        this.consecutiveCloudFailures = 0;
      }
    }
    // local-tier outcomes don't move the breaker state.
  }

  /** Returns true once the breaker has tripped. */
  shouldSkip(): boolean { return this.trippedFlag; }

  /** Snapshot of the breaker state for status.json / gate-decision-log. */
  state(): CloudBreakerState {
    return {
      tripped: this.trippedFlag,
      after_n_timeouts: this.trippedAfterN,
      agents: [...this.trippedAgents],
    };
  }
}

/**
 * Resolve the cloud-breaker threshold from env (`AGENTICS_CLOUD_BREAKER_THRESHOLD`).
 * Falls back to the default constant.
 */
export function resolveCloudBreakerThreshold(): number {
  const env = process.env['AGENTICS_CLOUD_BREAKER_THRESHOLD'];
  if (env) {
    const parsed = parseInt(env, 10);
    if (!Number.isNaN(parsed) && parsed >= 1) return parsed;
  }
  return DEFAULT_CLOUD_BREAKER_THRESHOLD;
}

// ============================================================================
// Per-agent + fleet timeouts (ADR-108 D1, D2, D5)
// ============================================================================

/** Default per-agent invocation timeout for the Phase 1 fleet (matches the
 *  Phase 2–6 path's 30s). Env override: `AGENTICS_FLEET_AGENT_TIMEOUT_MS`. */
export const DEFAULT_FLEET_AGENT_TIMEOUT_MS = 30_000;

/** Default fleet-wide deadline. Larger than a phase fanout (the fleet is
 *  ~109 agents). Env override: `AGENTICS_FLEET_TIMEOUT_MS`. */
export const DEFAULT_FLEET_TIMEOUT_MS = 60_000;

function resolvePositiveIntEnv(name: string, fallback: number): number {
  const env = process.env[name];
  if (env) {
    const parsed = parseInt(env, 10);
    if (!Number.isNaN(parsed) && parsed >= 1) return parsed;
  }
  return fallback;
}

/** Per-agent timeout for the fleet (D1). */
export function resolveFleetAgentTimeoutMs(): number {
  return resolvePositiveIntEnv('AGENTICS_FLEET_AGENT_TIMEOUT_MS', DEFAULT_FLEET_AGENT_TIMEOUT_MS);
}

/** Fleet-wide deadline (D2). */
export function resolveFleetTimeoutMs(): number {
  return resolvePositiveIntEnv('AGENTICS_FLEET_TIMEOUT_MS', DEFAULT_FLEET_TIMEOUT_MS);
}

/** The effective bounds, for recording into manifest.json (D5). */
export interface FleetDispatchConfig {
  readonly agent_timeout_ms: number;
  readonly fleet_timeout_ms: number;
  readonly cloud_breaker_threshold: number;
}

export function resolveFleetDispatchConfig(): FleetDispatchConfig {
  return {
    agent_timeout_ms: resolveFleetAgentTimeoutMs(),
    fleet_timeout_ms: resolveFleetTimeoutMs(),
    cloud_breaker_threshold: resolveCloudBreakerThreshold(),
  };
}

/** Sentinel returned by {@link withAgentTimeout} when the deadline wins. */
export const AGENT_TIMED_OUT = Symbol('agent-timed-out');

/**
 * Race a promise against a timeout. Resolves to {@link AGENT_TIMED_OUT} when
 * the deadline fires first. The underlying promise is NOT cancelled (Node has
 * no cancellation), but the caller stops waiting on it — the key property the
 * Phase 1 fleet needs so one slow agent cannot stall the batch.
 *
 * The timer is cleared on settle so it never keeps the event loop alive.
 */
export async function withAgentTimeout<T>(
  promise: Promise<T>,
  ms: number,
): Promise<T | typeof AGENT_TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<typeof AGENT_TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(AGENT_TIMED_OUT), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Sentinel returned by {@link raceFleetDeadline} when the fleet deadline wins. */
export const FLEET_TIMED_OUT = 'TIMEOUT' as const;

/**
 * ADR-PIPELINE-108 D2: race the whole agent batch against a wall-clock fleet
 * deadline. Returns the settled batch if it finishes first, else
 * {@link FLEET_TIMED_OUT}. The deadline timer is cleared on settle so a normal
 * (non-timeout) completion never leaves a dangling timer holding the event loop
 * open — important for long-lived (daemon/server) callers.
 */
export async function raceFleetDeadline<T>(
  batch: Promise<T>,
  ms: number,
): Promise<T | typeof FLEET_TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<typeof FLEET_TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(FLEET_TIMED_OUT), ms);
  });
  try {
    return await Promise.race([batch, deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
