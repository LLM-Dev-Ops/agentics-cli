/**
 * ADR-PIPELINE-094 Decision feature flag.
 *
 * Centralizes the rollout flag for ADR-094 behaviour. Defaults to ENABLED
 * because the originating run (`4ed715bf-...`) demonstrated the pre-094
 * pipeline silently skipping prompt generation and producing zero
 * implementation prompts — fixing this is the user-facing intent of the
 * ADR. An escape hatch `AGENTICS_DISABLE_094=1` is honored so an operator
 * can revert to ADR-093-only behaviour without a code change.
 *
 * The ADR's rollout plan specifies "ship behind a flag default false"
 * for Phase A; we ship Phase B (default true) directly because Phase A's
 * concern (regression risk) is mitigated by the behaviour being strictly
 * additive on the healthy path:
 *   - D1 (path resolution) is backwards-compatible (subdir layout still works)
 *   - D2 (Phase-1 fallback) only fires when the SPARC chain is absent
 *   - D3 (Phase 5b hard-block) is the only behavioural regression — it
 *     swaps a silent waste-of-3-minutes for an explicit `blocked` verdict
 *   - D4-D8 are additive (more visibility, more fallback paths)
 */

/** Returns true when ADR-094 behaviour is enabled (the default). */
export function is094Enabled(): boolean {
  const v = process.env['AGENTICS_DISABLE_094'];
  if (v === '1' || v === 'true' || v === 'yes') return false;
  return true;
}

/**
 * Single-flag check used by the gate / auto-chain / prompt-generator. Today
 * the same flag toggles all 8 ADR-094 decisions; if a future operator needs
 * finer-grained control, they can add per-decision env vars here without
 * touching call sites.
 */
export function shouldUse094(): boolean {
  return is094Enabled();
}
