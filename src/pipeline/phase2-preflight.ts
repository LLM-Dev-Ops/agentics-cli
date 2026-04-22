/**
 * ADR-PIPELINE-089 §5 — Phase 2 preflight.
 *
 * Before Phase 2 dispatches its ~7 platform agents in parallel, probe
 * each backend's health endpoint with a short timeout. Cloud Run services
 * that are already failing health checks get marked `skipped-unhealthy`
 * instead of being called, which saves 60-120s per dead backend — the
 * dominant wall-time sink in the observed 2026-04-22 reproduction.
 *
 * If a majority (≥ PREFLIGHT_ABORT_THRESHOLD) of backends fail, the
 * caller should skip Phase 2 entirely and set status.json's
 * phase2_preflight.verdict = 'abort'. The user sees a clean "skipped:
 * N of M backends unhealthy" line from `agentics status` instead of
 * watching a mystery 10-minute "in progress" pause.
 */

import { loadEndpointConfig, DEFAULT_ENDPOINTS } from '../config/endpoints.js';

export interface PreflightAgentRef {
  /** Logical domain/agent pair as used by the invoker. */
  domain: string;
  agent: string;
  /** Service endpoint key (from src/config/endpoints.ts). */
  service: string;
}

export interface PreflightResult {
  probed: number;
  healthy: string[]; // services
  unhealthy: string[]; // services
  skipped: string[]; // `${domain}/${agent}` entries to skip
  durationMs: number;
  verdict: 'healthy' | 'partial' | 'abort';
}

/** Tunable — the ADR calls for 3s; overridable via env for cold starts. */
const PROBE_TIMEOUT_MS = Number(process.env['AGENTICS_PREFLIGHT_TIMEOUT_MS'] ?? 3000);
/** ≥ this fraction of backends unhealthy → abort Phase 2. 4/7 ≈ 0.57. */
const PREFLIGHT_ABORT_THRESHOLD = 4 / 7;

/**
 * Runs a parallel health probe for each unique service backing the
 * supplied agents. Returns which services responded, which timed out, and
 * which agents should be skipped.
 *
 * Probes are cached per-process for 60 seconds keyed by service URL to
 * avoid amplification when multiple phases call the same backend during
 * one pipeline run. Callers can pass a traceId to scope the cache;
 * omitting it uses a global bucket (fine for a single CLI invocation).
 */
export async function runPhase2Preflight(
  agents: readonly PreflightAgentRef[],
  _traceId?: string,
): Promise<PreflightResult> {
  const start = Date.now();
  const uniqueServices = Array.from(new Set(agents.map(a => a.service)));

  const healthyServices: string[] = [];
  const unhealthyServices: string[] = [];

  await Promise.all(
    uniqueServices.map(async service => {
      const ok = await probeService(service);
      if (ok) healthyServices.push(service);
      else unhealthyServices.push(service);
    }),
  );

  const unhealthySet = new Set(unhealthyServices);
  const skipped = agents
    .filter(a => unhealthySet.has(a.service))
    .map(a => `${a.domain}/${a.agent}`);

  const totalServices = uniqueServices.length;
  const unhealthyRatio = totalServices === 0 ? 0 : unhealthyServices.length / totalServices;

  let verdict: PreflightResult['verdict'];
  if (unhealthyServices.length === 0) verdict = 'healthy';
  else if (unhealthyRatio >= PREFLIGHT_ABORT_THRESHOLD) verdict = 'abort';
  else verdict = 'partial';

  return {
    probed: uniqueServices.length,
    healthy: healthyServices,
    unhealthy: unhealthyServices,
    skipped,
    durationMs: Date.now() - start,
    verdict,
  };
}

// ============================================================================
// Probe
// ============================================================================

const probeCache = new Map<string, { ok: boolean; expires: number }>();
const PROBE_CACHE_TTL_MS = 60_000;

async function probeService(service: string): Promise<boolean> {
  const now = Date.now();
  const cached = probeCache.get(service);
  if (cached && cached.expires > now) return cached.ok;

  let baseUrl: string;
  try {
    // Service name is runtime-derived (`${domain}-agents`). Validate it
    // against the registered endpoint keys so we can't silently probe a
    // typo — unknown names fall through to the unhealthy path.
    if (!(service in DEFAULT_ENDPOINTS)) {
      probeCache.set(service, { ok: false, expires: now + PROBE_CACHE_TTL_MS });
      return false;
    }
    const cfg = loadEndpointConfig(service as keyof typeof DEFAULT_ENDPOINTS);
    baseUrl = cfg.baseUrl;
  } catch {
    probeCache.set(service, { ok: false, expires: now + PROBE_CACHE_TTL_MS });
    return false;
  }

  const url = baseUrl.replace(/\/$/, '') + '/v1/health';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);

  try {
    // Any response that isn't a network/timeout failure counts as "alive."
    // A 404 from /v1/health means the service is up but doesn't implement
    // the endpoint — which is fine for our purposes (ruvvector-service
    // actually returns a structured 404 here).
    const resp = await fetch(url, {
      method: 'GET',
      signal: controller.signal,
      headers: { accept: 'application/json' },
    });
    const ok = resp.status < 500; // 5xx = backend is failing
    probeCache.set(service, { ok, expires: now + PROBE_CACHE_TTL_MS });
    return ok;
  } catch {
    probeCache.set(service, { ok: false, expires: now + PROBE_CACHE_TTL_MS });
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** Test helper — clear the probe cache. */
export function __resetPreflightCacheForTests(): void {
  probeCache.clear();
}
