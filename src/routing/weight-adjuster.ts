/**
 * Weight Adjuster (ADR-031 Phase 2)
 *
 * Calculates adjusted agent weights from telemetry outcome records.
 * Uses exponential moving average (EMA) for gradual weight adaptation.
 *
 * Weight adjustments are written to a separate overlay file
 * (docs/ecosystem.graph.weights.json) that does not modify the
 * curated base graph.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { OutcomeRecord } from './outcome-recorder.js';
import type { WeightedAgent } from './weighted-resolver.js';

// ============================================================================
// Types
// ============================================================================

export interface WeightOverlay {
  readonly generated_at: string;
  readonly total_outcomes: number;
  readonly adjustments: readonly WeightAdjustment[];
}

export interface WeightAdjustment {
  readonly capability: string;
  readonly agent: string;
  readonly original_weight: number;
  readonly adjusted_weight: number;
  readonly success_rate: number;
  readonly usage_rate: number;
  readonly sample_count: number;
}

// ============================================================================
// Constants
// ============================================================================

const MIN_SAMPLES = 20;
const ALPHA = 0.1; // EMA smoothing factor (slow adaptation)
const MIN_WEIGHT = 0.05;
const MAX_WEIGHT = 1.0;
const WEIGHT_OVERLAY_FILE = 'ecosystem.graph.weights.json';

// ============================================================================
// Weight Calculation
// ============================================================================

/**
 * Calculate adjusted weights for agents in a capability based on outcomes.
 *
 * Uses exponential moving average:
 *   new_weight = old_weight * (1 - alpha) + observed_score * alpha
 *
 * Requires minimum sample count before adjusting.
 */
export function calculateAdjustedWeights(
  capability: string,
  agents: readonly WeightedAgent[],
  outcomes: readonly OutcomeRecord[],
): WeightAdjustment[] {
  // Filter outcomes that used this capability
  const relevantOutcomes = outcomes.filter(o =>
    o.capabilities_used.includes(capability),
  );

  if (relevantOutcomes.length < MIN_SAMPLES) {
    return []; // Not enough data
  }

  const adjustments: WeightAdjustment[] = [];

  for (const agent of agents) {
    // Count how many times this agent was selected
    const selections = relevantOutcomes.filter(o =>
      o.agents_selected.includes(agent.name),
    );

    if (selections.length === 0) continue;

    // Calculate success rate
    const successes = selections.filter(o => o.outcome === 'success').length;
    const successRate = successes / selections.length;

    // Calculate usage rate (output was actually consumed)
    const usages = selections.filter(o => {
      const contrib = o.agent_contributions[agent.name];
      return contrib?.output_used === true;
    }).length;
    const usageRate = usages / selections.length;

    // Combined score (equal weight to success and usage)
    const observedScore = successRate * 0.5 + usageRate * 0.5;

    // EMA adjustment
    const adjustedWeight = clampWeight(
      agent.weight * (1 - ALPHA) + observedScore * ALPHA,
    );

    adjustments.push({
      capability,
      agent: agent.name,
      original_weight: agent.weight,
      adjusted_weight: adjustedWeight,
      success_rate: round(successRate, 4),
      usage_rate: round(usageRate, 4),
      sample_count: selections.length,
    });
  }

  return adjustments;
}

// ============================================================================
// Overlay File Management
// ============================================================================

/**
 * Write weight adjustments to the overlay file.
 * Does NOT modify the base ecosystem.graph.json.
 */
export function writeWeightOverlay(
  adjustments: readonly WeightAdjustment[],
  totalOutcomes: number,
  options?: { basePath?: string },
): string {
  const basePath = options?.basePath ?? process.cwd();
  const filePath = path.join(basePath, 'docs', WEIGHT_OVERLAY_FILE);

  const overlay: WeightOverlay = {
    generated_at: new Date().toISOString(),
    total_outcomes: totalOutcomes,
    adjustments: [...adjustments],
  };

  fs.writeFileSync(filePath, JSON.stringify(overlay, null, 2) + '\n', 'utf-8');
  return filePath;
}

/**
 * Load weight adjustments from the overlay file.
 * Returns null if the file doesn't exist.
 */
export function loadWeightOverlay(
  options?: { basePath?: string },
): WeightOverlay | null {
  const basePath = options?.basePath ?? process.cwd();
  const filePath = path.join(basePath, 'docs', WEIGHT_OVERLAY_FILE);

  if (!fs.existsSync(filePath)) {
    return null;
  }

  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(content) as WeightOverlay;
  } catch {
    return null;
  }
}

/**
 * Apply weight overlay adjustments to a set of agents.
 * Returns agents with updated weights from the overlay.
 */
export function applyWeightOverlay(
  capability: string,
  agents: readonly WeightedAgent[],
  overlay: WeightOverlay,
): WeightedAgent[] {
  const adjustmentMap = new Map<string, number>();

  for (const adj of overlay.adjustments) {
    if (adj.capability === capability) {
      adjustmentMap.set(adj.agent, adj.adjusted_weight);
    }
  }

  if (adjustmentMap.size === 0) {
    return [...agents];
  }

  return agents.map(agent => {
    const adjustedWeight = adjustmentMap.get(agent.name);
    if (adjustedWeight !== undefined) {
      return { ...agent, weight: adjustedWeight };
    }
    return agent;
  });
}

/**
 * Format weight adjustments as a human-readable report.
 */
export function formatAdjustmentReport(adjustments: readonly WeightAdjustment[]): string {
  if (adjustments.length === 0) {
    return 'No weight adjustments calculated (insufficient data or no changes).';
  }

  const lines: string[] = ['Weight Adjustment Report', '='.repeat(50)];

  // Group by capability
  const byCapability = new Map<string, WeightAdjustment[]>();
  for (const adj of adjustments) {
    const existing = byCapability.get(adj.capability);
    if (existing) {
      existing.push(adj);
    } else {
      byCapability.set(adj.capability, [adj]);
    }
  }

  for (const [capability, adjs] of byCapability) {
    lines.push(`\n  ${capability}:`);
    for (const adj of adjs) {
      const delta = adj.adjusted_weight - adj.original_weight;
      const direction = delta >= 0 ? '+' : '';
      lines.push(
        `    ${adj.agent}: ${adj.original_weight.toFixed(2)} → ${adj.adjusted_weight.toFixed(2)} (${direction}${delta.toFixed(3)})` +
        `  [success=${(adj.success_rate * 100).toFixed(0)}%, usage=${(adj.usage_rate * 100).toFixed(0)}%, n=${adj.sample_count}]`,
      );
    }
  }

  return lines.join('\n');
}

// ============================================================================
// Utilities
// ============================================================================

function clampWeight(w: number): number {
  return Math.max(MIN_WEIGHT, Math.min(MAX_WEIGHT, w));
}

function round(n: number, decimals: number): number {
  const factor = Math.pow(10, decimals);
  return Math.round(n * factor) / factor;
}
