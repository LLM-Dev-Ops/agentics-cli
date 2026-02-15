/**
 * Meta-Simulation Detector — Thin Passthrough
 *
 * ARCHITECTURE:
 *   The CLI does NOT classify whether a request is a meta-simulation.
 *   That is platform-side intent classification. The CLI sends the raw
 *   description to the platform, which returns tier routing decisions.
 *
 * REMOVED (moved to platform):
 *   - META_SIMULATION_PHRASES / phrase matching
 *   - META_SIMULATION_KEYWORDS / keyword matching
 *   - isMetaSimulation() / local classification logic
 *   - buildTier1Route() / confidence scoring + tier routing
 *   - getMetaSimulationTier() / local tier assignment
 *
 * WHAT REMAINS:
 *   - Type definitions (for contract compatibility)
 *   - Exit code constant
 *   - Deprecated stubs for callers that haven't migrated
 */

export const META_SIMULATION_EXIT_CODE = 142;

/** Tier-1 routing configuration returned by platform */
export interface Tier1Route {
  tier: 'tier-1';
  endpoint: '/v1/simulate';
  adapter: 'simulation-engine';
  metaSimulation: true;
  confidence: number;
  detectedSignals: string[];
  originalDescription: string;
}

/**
 * @deprecated Meta-simulation detection is now platform-side.
 * The CLI sends the raw description; the platform classifies it.
 * Always returns false — the platform will route appropriately.
 */
export function isMetaSimulation(_description: string): boolean {
  return false;
}

/**
 * @deprecated Tier routing is now platform-side.
 * Always returns null — the platform determines the tier.
 */
export function getMetaSimulationTier(
  _description: string,
): 'tier-1' | null {
  return null;
}

/**
 * @deprecated Tier-1 route construction is now platform-side.
 * This stub should not be called — the platform returns routing info.
 */
export function buildTier1Route(
  _description: string,
  _correlationId: string,
): never {
  throw new Error(
    'buildTier1Route() removed: meta-simulation routing is now platform-side. ' +
    'Send the description to the platform and use its routing response.'
  );
}
