/**
 * Meta-Simulation Detector
 *
 * PURPOSE: Detect when a simulation request is a meta-simulation
 * (simulation of simulations, meta-analysis, recursive scenario)
 * and route it to the Tier-1 simulator rather than the standard path.
 *
 * DETECTION SIGNALS:
 * - Keywords: "meta-simulation", "simulate simulation", "recursive", "meta-analysis"
 * - Category: request that analyzes or simulates the simulation pipeline itself
 * - Structure: nested simulation references
 *
 * ROUTING:
 * - Meta-simulation requests → Tier-1 simulator endpoint
 * - Standard simulation requests → unchanged (Tier-2/3)
 * - No fallback: if Tier-1 is unavailable, the command fails
 *
 * EXIT CODE: 142 (META_SIMULATION_ROUTING_FAILED)
 */

import { CLIError } from '../errors/index.js';

// ============================================================================
// Constants
// ============================================================================

export const META_SIMULATION_EXIT_CODE = 142;

/**
 * High-confidence phrases that indicate a meta-simulation request.
 * Matched as complete phrases in the lowercased description.
 */
const META_SIMULATION_PHRASES: string[] = [
  'meta-simulation',
  'meta simulation',
  'simulate simulation',
  'simulation-of-simulations',
  'simulation of simulations',
  'recursive simulation',
  'simulate the simulator',
  'meta-analysis of simulations',
  'simulation pipeline analysis',
  'simulation infrastructure simulation',
];

/**
 * Medium-confidence keywords that contribute to meta-simulation scoring.
 * Two or more must be present together with a structural signal.
 */
const META_SIMULATION_KEYWORDS: string[] = [
  'meta',
  'recursive',
  'self-referential',
  'simulation pipeline',
  'simulation engine',
  'simulation runner',
  'simulation infrastructure',
];

// ============================================================================
// Detection Functions
// ============================================================================

/**
 * Detect whether a simulation description is a meta-simulation request.
 * Meta-simulations are simulations that analyze, model, or simulate
 * the simulation pipeline itself.
 *
 * @returns true if the description matches meta-simulation patterns
 */
export function isMetaSimulation(description: string): boolean {
  const lower = description.toLowerCase();

  // High-confidence: any phrase match is sufficient
  for (const phrase of META_SIMULATION_PHRASES) {
    if (lower.includes(phrase)) {
      return true;
    }
  }

  // Medium-confidence: need 2+ keyword matches
  let keywordHits = 0;
  for (const keyword of META_SIMULATION_KEYWORDS) {
    if (lower.includes(keyword)) {
      keywordHits++;
    }
  }

  return keywordHits >= 2;
}

/**
 * Get the routing tier for a simulation request.
 *
 * @returns 'tier-1' for meta-simulations, null for standard simulations
 */
export function getMetaSimulationTier(
  description: string,
): 'tier-1' | null {
  return isMetaSimulation(description) ? 'tier-1' : null;
}

// ============================================================================
// Tier-1 Routing
// ============================================================================

/** Tier-1 routing configuration returned by buildTier1Route */
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
 * Build a Tier-1 routing configuration for a meta-simulation request.
 * Meta-simulations route to the simulation engine with a Tier-1 marker
 * so downstream services can apply meta-simulation logic.
 *
 * @throws CLIError (ECLI-METASIM-001) if Tier-1 routing cannot be established
 */
export function buildTier1Route(
  description: string,
  correlationId: string,
): Tier1Route {
  const lower = description.toLowerCase();

  // Collect detected signals for traceability
  const detectedSignals: string[] = [];
  for (const phrase of META_SIMULATION_PHRASES) {
    if (lower.includes(phrase)) {
      detectedSignals.push(`phrase:${phrase}`);
    }
  }
  for (const keyword of META_SIMULATION_KEYWORDS) {
    if (lower.includes(keyword)) {
      detectedSignals.push(`keyword:${keyword}`);
    }
  }

  if (detectedSignals.length === 0) {
    throw new CLIError({
      code: 'ECLI-METASIM-001',
      category: 'INPUT_ERROR',
      message: 'Meta-simulation detection invoked but no signals found in description',
      details: {
        description: description.slice(0, 200),
        gate: 'meta-simulation-detector',
      },
      module: 'meta-sim-detector',
      correlationId,
      recoverable: false,
      exitCode: META_SIMULATION_EXIT_CODE,
    });
  }

  // Calculate confidence based on signal density
  const phraseHits = detectedSignals.filter(s => s.startsWith('phrase:')).length;
  const keywordHits = detectedSignals.filter(s => s.startsWith('keyword:')).length;
  const confidence = Math.min(
    (phraseHits * 0.4 + keywordHits * 0.15),
    1.0,
  );

  return {
    tier: 'tier-1',
    endpoint: '/v1/simulate',
    adapter: 'simulation-engine',
    metaSimulation: true,
    confidence,
    detectedSignals,
    originalDescription: description,
  };
}
