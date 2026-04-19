/**
 * Tier-specific timeout caps (ADR-PIPELINE-081 §5).
 *
 * Every MCP call is wrapped in an AbortController using one of these caps.
 * Timeout exceeded → handler returns 502 with error "TIMEOUT_CAP_EXCEEDED".
 * Partial results are NOT returned on timeout.
 */

export type Tier = 'observational' | 'advisory' | 'gating';

export const TIMEOUT_CAPS_MS: Record<Tier, number> = {
  observational: 60_000,
  advisory: 120_000,
  gating: 300_000,
};

export function tierOrDefault(value: unknown): Tier {
  if (value === 'observational' || value === 'advisory' || value === 'gating') {
    return value;
  }
  return 'advisory';
}

/**
 * Run `fn` with a tier-appropriate timeout. The returned promise either
 * resolves with fn's result or rejects with a typed timeout error.
 */
export async function withTierTimeout<T>(
  tier: Tier,
  fn: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const capMs = TIMEOUT_CAPS_MS[tier];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), capMs);

  try {
    return await fn(controller.signal);
  } catch (err) {
    if (controller.signal.aborted) {
      const timeoutErr = new Error('TIMEOUT_CAP_EXCEEDED');
      (timeoutErr as Error & { code?: string; tier?: Tier; cap_ms?: number }).code = 'TIMEOUT_CAP_EXCEEDED';
      (timeoutErr as Error & { tier?: Tier }).tier = tier;
      (timeoutErr as Error & { cap_ms?: number }).cap_ms = capMs;
      throw timeoutErr;
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export function isTimeoutError(err: unknown): err is Error & { code: 'TIMEOUT_CAP_EXCEEDED'; tier: Tier; cap_ms: number } {
  return err instanceof Error && (err as Error & { code?: string }).code === 'TIMEOUT_CAP_EXCEEDED';
}
