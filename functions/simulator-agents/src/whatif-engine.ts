/**
 * What-If Analysis Engine
 *
 * Analyzes platform impact of hypothetical changes by detecting variables
 * (cost, latency, reliability, agent count) and generating multi-outcome
 * scenarios with quantified platform metrics.
 */

import type {
  WhatIfInput,
  WhatIfResult,
  OutcomeScenario,
  ImpactSummary,
  EvidenceItem,
  PlatformMetrics,
} from './types.js';

// ─── Variable Detection ────────────────────────────────────────────────────────

interface DetectedVariable {
  name: string;
  dimension: 'cost' | 'latency' | 'reliability' | 'throughput' | 'agent-count' | 'quality';
  direction: 'increase' | 'decrease' | 'change' | 'unknown';
  magnitude: 'small' | 'medium' | 'large';
  evidence: string;
}

const VARIABLE_PATTERNS: {
  pattern: RegExp;
  dimension: DetectedVariable['dimension'];
  direction: DetectedVariable['direction'];
  magnitude: DetectedVariable['magnitude'];
}[] = [
  // Cost
  { pattern: /(?:reduce|cut|lower|decrease)\s+(?:cost|spending|budget|price)/i, dimension: 'cost', direction: 'decrease', magnitude: 'medium' },
  { pattern: /(?:increase|raise|grow)\s+(?:cost|spending|budget)/i, dimension: 'cost', direction: 'increase', magnitude: 'medium' },
  { pattern: /(?:cheaper|less expensive|cost.?effective)/i, dimension: 'cost', direction: 'decrease', magnitude: 'small' },
  { pattern: /(?:expensive|premium|enterprise.?tier)/i, dimension: 'cost', direction: 'increase', magnitude: 'medium' },
  { pattern: /\$[\d,]+|[\d]+\s*(?:dollars|usd|%\s*(?:cost|budget))/i, dimension: 'cost', direction: 'change', magnitude: 'medium' },

  // Latency
  { pattern: /(?:reduce|cut|lower|decrease|improve)\s+(?:latency|response time|p\d+)/i, dimension: 'latency', direction: 'decrease', magnitude: 'medium' },
  { pattern: /(?:increase|higher|worse)\s+(?:latency|response time)/i, dimension: 'latency', direction: 'increase', magnitude: 'medium' },
  { pattern: /(?:faster|quicker|speed up)/i, dimension: 'latency', direction: 'decrease', magnitude: 'small' },
  { pattern: /(?:slower|add.*latency)/i, dimension: 'latency', direction: 'increase', magnitude: 'small' },
  { pattern: /(?:cold start|warm up|spin up)/i, dimension: 'latency', direction: 'increase', magnitude: 'medium' },

  // Reliability
  { pattern: /(?:improve|increase|boost)\s+(?:reliability|uptime|availability|slo)/i, dimension: 'reliability', direction: 'increase', magnitude: 'medium' },
  { pattern: /(?:reduce|decrease)\s+(?:failures|errors|downtime)/i, dimension: 'reliability', direction: 'increase', magnitude: 'medium' },
  { pattern: /(?:failover|redundan|circuit.?break|retry)/i, dimension: 'reliability', direction: 'increase', magnitude: 'medium' },
  { pattern: /(?:single point of failure|no redundancy|remove backup)/i, dimension: 'reliability', direction: 'decrease', magnitude: 'large' },

  // Throughput
  { pattern: /(?:increase|boost|improve)\s+(?:throughput|capacity|concurrency|qps|rps)/i, dimension: 'throughput', direction: 'increase', magnitude: 'medium' },
  { pattern: /(?:scale|horizontal|more instance|add instance)/i, dimension: 'throughput', direction: 'increase', magnitude: 'medium' },
  { pattern: /(?:reduce|limit|throttle)\s+(?:throughput|capacity|concurrency)/i, dimension: 'throughput', direction: 'decrease', magnitude: 'medium' },

  // Agent count
  { pattern: /(?:add|deploy|register|create)\s+(?:\d+\s+)?(?:new\s+)?agent/i, dimension: 'agent-count', direction: 'increase', magnitude: 'medium' },
  { pattern: /(?:remove|deprecate|decommission|retire)\s+agent/i, dimension: 'agent-count', direction: 'decrease', magnitude: 'medium' },
  { pattern: /(?:new domain|new agent domain|add domain)/i, dimension: 'agent-count', direction: 'increase', magnitude: 'large' },

  // Quality
  { pattern: /(?:improve|increase|boost)\s+(?:quality|accuracy|faithfulness)/i, dimension: 'quality', direction: 'increase', magnitude: 'medium' },
  { pattern: /(?:reduce|decrease)\s+(?:hallucination|bias|error rate)/i, dimension: 'quality', direction: 'increase', magnitude: 'medium' },
  { pattern: /(?:switch.*(?:haiku|sonnet|opus)|model.*(?:upgrade|downgrade))/i, dimension: 'quality', direction: 'change', magnitude: 'large' },
];

function detectVariables(input: string): DetectedVariable[] {
  const variables: DetectedVariable[] = [];
  const seenDimensions = new Set<string>();

  for (const { pattern, dimension, direction, magnitude } of VARIABLE_PATTERNS) {
    const match = input.match(pattern);
    if (match) {
      const key = `${dimension}-${direction}`;
      if (!seenDimensions.has(key)) {
        seenDimensions.add(key);
        variables.push({
          name: match[0].trim(),
          dimension,
          direction,
          magnitude,
          evidence: `Matched pattern: "${match[0]}"`,
        });
      }
    }
  }

  return variables;
}

// ─── Impact Calculation ────────────────────────────────────────────────────────

const MAGNITUDE_MULTIPLIER: Record<string, number> = {
  small: 0.05,
  medium: 0.15,
  large: 0.35,
};

function calculateMetrics(
  variables: DetectedVariable[],
  scenario: 'best_case' | 'expected' | 'worst_case',
): PlatformMetrics {
  const base: PlatformMetrics = {
    cost_change_pct: 0,
    latency_change_pct: 0,
    reliability_change_pct: 0,
    throughput_change_pct: 0,
  };

  const scenarioMultiplier = {
    best_case: 1.5,
    expected: 1.0,
    worst_case: 0.4,
  }[scenario];

  const inverseMultiplier = {
    best_case: 0.4,
    expected: 1.0,
    worst_case: 1.8,
  }[scenario];

  for (const v of variables) {
    const mag = MAGNITUDE_MULTIPLIER[v.magnitude];
    const sign = v.direction === 'decrease' ? -1 : v.direction === 'increase' ? 1 : 0;

    switch (v.dimension) {
      case 'cost':
        // Decreasing cost is good → best case amplifies, worst case reduces
        base.cost_change_pct += sign * mag * 100 * (sign < 0 ? scenarioMultiplier : inverseMultiplier);
        break;
      case 'latency':
        // Decreasing latency is good
        base.latency_change_pct += sign * mag * 100 * (sign < 0 ? scenarioMultiplier : inverseMultiplier);
        break;
      case 'reliability':
        // Increasing reliability is good
        base.reliability_change_pct += sign * mag * 100 * (sign > 0 ? scenarioMultiplier : inverseMultiplier);
        break;
      case 'throughput':
        // Increasing throughput is good
        base.throughput_change_pct += sign * mag * 100 * (sign > 0 ? scenarioMultiplier : inverseMultiplier);
        break;
      case 'agent-count':
        // More agents → slight latency cost, throughput gain
        base.latency_change_pct += sign * 2 * inverseMultiplier;
        base.throughput_change_pct += sign * 10 * scenarioMultiplier;
        base.cost_change_pct += sign * 5 * inverseMultiplier;
        break;
      case 'quality':
        // Quality changes mainly affect cost and latency
        if (sign > 0) {
          base.cost_change_pct += 8 * inverseMultiplier;
          base.latency_change_pct += 5 * inverseMultiplier;
        } else {
          base.cost_change_pct -= 10 * scenarioMultiplier;
          base.latency_change_pct -= 3 * scenarioMultiplier;
        }
        break;
    }
  }

  // Round all values
  return {
    cost_change_pct: Math.round(base.cost_change_pct * 10) / 10,
    latency_change_pct: Math.round(base.latency_change_pct * 10) / 10,
    reliability_change_pct: Math.round(base.reliability_change_pct * 10) / 10,
    throughput_change_pct: Math.round(base.throughput_change_pct * 10) / 10,
  };
}

function generateOutcomes(variables: DetectedVariable[], query: string): OutcomeScenario[] {
  const scenarios: ('best_case' | 'expected' | 'worst_case')[] = ['best_case', 'expected', 'worst_case'];

  return scenarios.map((label) => {
    const metrics = calculateMetrics(variables, label);

    const descriptions: Record<string, string> = {
      best_case: buildDescription(variables, 'best_case', query),
      expected: buildDescription(variables, 'expected', query),
      worst_case: buildDescription(variables, 'worst_case', query),
    };

    const probabilities: Record<string, number> = {
      best_case: variables.length > 0 ? 0.2 : 0.15,
      expected: variables.length > 0 ? 0.6 : 0.5,
      worst_case: variables.length > 0 ? 0.2 : 0.35,
    };

    return {
      label,
      probability: probabilities[label],
      description: descriptions[label],
      platform_impact: metrics,
    };
  });
}

function buildDescription(
  variables: DetectedVariable[],
  scenario: string,
  query: string,
): string {
  if (variables.length === 0) {
    const fallbacks: Record<string, string> = {
      best_case: 'Change executes smoothly with no unintended side effects; platform metrics remain stable or improve.',
      expected: 'Change completes with minor adjustments needed; some metrics shift within acceptable bounds.',
      worst_case: 'Change introduces unexpected interactions requiring rollback or significant remediation.',
    };
    return fallbacks[scenario] ?? '';
  }

  const dims = variables.map((v) => v.dimension).join(', ');

  const templates: Record<string, string> = {
    best_case: `Targeted changes to ${dims} achieve maximum intended effect. All affected platform metrics improve beyond expectations. No regressions detected.`,
    expected: `Changes to ${dims} produce anticipated results. Some secondary metrics shift within acceptable ranges. Standard monitoring catches any drift.`,
    worst_case: `Changes to ${dims} trigger cascading effects across dependent services. Some metrics degrade beyond SLO thresholds, requiring intervention.`,
  };

  return templates[scenario] ?? '';
}

function computeImpactSummary(
  variables: DetectedVariable[],
  outcomes: OutcomeScenario[],
): ImpactSummary {
  const expected = outcomes.find((o) => o.label === 'expected');
  const metrics = expected?.platform_impact ?? { cost_change_pct: 0, latency_change_pct: 0, reliability_change_pct: 0, throughput_change_pct: 0 };

  // Find the most impacted dimension
  const dims = [
    { name: 'cost', value: Math.abs(metrics.cost_change_pct) },
    { name: 'latency', value: Math.abs(metrics.latency_change_pct) },
    { name: 'reliability', value: Math.abs(metrics.reliability_change_pct) },
    { name: 'throughput', value: Math.abs(metrics.throughput_change_pct) },
  ].sort((a, b) => b.value - a.value);

  const primaryDimension = dims[0].name;
  const maxImpact = dims[0].value;

  // Compute net benefit: positive changes good, negative bad (context-dependent)
  const costBenefit = -metrics.cost_change_pct / 100;   // lower cost = positive
  const latencyBenefit = -metrics.latency_change_pct / 100;  // lower latency = positive
  const reliabilityBenefit = metrics.reliability_change_pct / 100;  // higher = positive
  const throughputBenefit = metrics.throughput_change_pct / 100;  // higher = positive
  const netBenefit = Math.round((costBenefit + latencyBenefit + reliabilityBenefit + throughputBenefit) / 4 * 100) / 100;

  // Overall risk based on worst case severity
  const worstCase = outcomes.find((o) => o.label === 'worst_case')?.platform_impact;
  const worstImpact = worstCase
    ? Math.max(
        Math.abs(worstCase.cost_change_pct),
        Math.abs(worstCase.latency_change_pct),
        Math.abs(worstCase.reliability_change_pct),
        Math.abs(worstCase.throughput_change_pct),
      )
    : 0;

  let overallRisk: 'low' | 'medium' | 'high' | 'critical';
  if (worstImpact < 5) overallRisk = 'low';
  else if (worstImpact < 20) overallRisk = 'medium';
  else if (worstImpact < 40) overallRisk = 'high';
  else overallRisk = 'critical';

  let recommendation: string;
  if (netBenefit > 0.1 && overallRisk !== 'critical') {
    recommendation = 'Net positive impact expected. Proceed with standard deployment safeguards.';
  } else if (netBenefit > 0 && overallRisk === 'high') {
    recommendation = 'Marginal benefit with significant downside risk. Consider phased rollout with circuit breakers.';
  } else if (overallRisk === 'critical') {
    recommendation = 'High-risk change. Require decision-memo approval and staged canary deployment.';
  } else if (variables.length === 0) {
    recommendation = 'Unable to detect specific platform variables. Run with closer monitoring or provide more detail.';
  } else {
    recommendation = 'Mixed impact profile. Validate with test-bench benchmarks before production deployment.';
  }

  return {
    overall_risk: overallRisk,
    primary_dimension: primaryDimension,
    net_benefit_score: Math.max(-1, Math.min(1, netBenefit)),
    recommendation,
  };
}

function buildEvidence(variables: DetectedVariable[], query: string): EvidenceItem[] {
  const evidence: EvidenceItem[] = [];

  for (const v of variables) {
    evidence.push({
      type: 'pattern',
      source: 'variable-detector',
      detail: `Detected ${v.dimension} ${v.direction} (${v.magnitude}): "${v.name}"`,
      weight: MAGNITUDE_MULTIPLIER[v.magnitude] * 2,
    });
  }

  // Add heuristic evidence
  const wordCount = query.split(/\s+/).length;
  if (wordCount > 30) {
    evidence.push({
      type: 'heuristic',
      source: 'query-complexity',
      detail: `Multi-faceted query (${wordCount} words) suggests complex impact surface`,
      weight: 0.2,
    });
  }

  if (variables.length === 0) {
    evidence.push({
      type: 'heuristic',
      source: 'fallback-analyzer',
      detail: 'No platform-specific variables detected; analysis based on general patterns',
      weight: 0.15,
    });
  }

  if (variables.length >= 3) {
    evidence.push({
      type: 'heuristic',
      source: 'multi-variable-interaction',
      detail: `${variables.length} variables detected — cross-dimensional interactions increase uncertainty`,
      weight: 0.25,
    });
  }

  return evidence;
}

// ─── Main Export ────────────────────────────────────────────────────────────────

export function analyzeWhatIf(input: WhatIfInput): WhatIfResult {
  const query = input.input;
  const variables = detectVariables(query);
  const outcomes = generateOutcomes(variables, query);
  const impactSummary = computeImpactSummary(variables, outcomes);
  const evidence = buildEvidence(variables, query);

  return {
    query,
    variables_detected: variables.map((v) => `${v.dimension}:${v.direction}:${v.magnitude}`),
    outcomes,
    impact_summary: impactSummary,
    evidence_items: evidence,
    analysis_method: 'rule-based',
  };
}
