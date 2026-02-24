/**
 * Scenario Analysis Engine
 *
 * Analyzes platform-level scenarios by parsing description text for
 * complexity indicators, platform-relevant keywords, and risk patterns.
 * Falls back to rule-based analysis when no API key is provided.
 */

import type {
  ScenarioInput,
  ScenarioResult,
  RiskFactor,
  TimelineEstimate,
  EvidenceItem,
} from './types.js';

// ─── Keyword Categories ────────────────────────────────────────────────────────

const PLATFORM_KEYWORDS: Record<string, { weight: number; category: string }> = {
  // Model operations
  'model switch':    { weight: 0.8, category: 'model-change' },
  'model migration': { weight: 0.85, category: 'model-change' },
  'switch provider': { weight: 0.8, category: 'model-change' },
  'switch from':     { weight: 0.75, category: 'model-change' },
  'switch to':       { weight: 0.7, category: 'model-change' },
  'swap model':      { weight: 0.75, category: 'model-change' },
  'new model':       { weight: 0.6, category: 'model-change' },
  'replace model':   { weight: 0.8, category: 'model-change' },
  'upgrade model':   { weight: 0.7, category: 'model-change' },
  'gpt-4':           { weight: 0.65, category: 'model-change' },
  'gpt-3':           { weight: 0.65, category: 'model-change' },
  'claude':          { weight: 0.6, category: 'model-change' },
  'sonnet':          { weight: 0.6, category: 'model-change' },
  'opus':            { weight: 0.6, category: 'model-change' },
  'haiku':           { weight: 0.6, category: 'model-change' },
  'gemini':          { weight: 0.6, category: 'model-change' },
  'llama':           { weight: 0.6, category: 'model-change' },

  // Agent operations
  'deploy agent':     { weight: 0.7, category: 'agent-deployment' },
  'new agent':        { weight: 0.65, category: 'agent-deployment' },
  'add agent':        { weight: 0.6, category: 'agent-deployment' },
  'remove agent':     { weight: 0.7, category: 'agent-deployment' },
  'agent domain':     { weight: 0.65, category: 'agent-deployment' },
  'register agent':   { weight: 0.6, category: 'agent-deployment' },

  // Scaling
  'scale up':       { weight: 0.6, category: 'scaling' },
  'scale down':     { weight: 0.55, category: 'scaling' },
  'auto-scale':     { weight: 0.65, category: 'scaling' },
  'increase capacity': { weight: 0.6, category: 'scaling' },
  'horizontal scale':  { weight: 0.7, category: 'scaling' },
  'vertical scale':    { weight: 0.65, category: 'scaling' },

  // Configuration
  'config change':     { weight: 0.5, category: 'configuration' },
  'configuration':     { weight: 0.45, category: 'configuration' },
  'update setting':    { weight: 0.45, category: 'configuration' },
  'change parameter':  { weight: 0.5, category: 'configuration' },
  'environment variable': { weight: 0.4, category: 'configuration' },
  'feature flag':      { weight: 0.45, category: 'configuration' },

  // Infrastructure
  'region change':     { weight: 0.75, category: 'infrastructure' },
  'migrate region':    { weight: 0.8, category: 'infrastructure' },
  'new region':        { weight: 0.7, category: 'infrastructure' },
  'cloud function':    { weight: 0.55, category: 'infrastructure' },
  'cloud run':         { weight: 0.55, category: 'infrastructure' },
  'database':          { weight: 0.65, category: 'infrastructure' },
  'redis':             { weight: 0.55, category: 'infrastructure' },

  // Security
  'api key':           { weight: 0.6, category: 'security' },
  'authentication':    { weight: 0.7, category: 'security' },
  'authorization':     { weight: 0.7, category: 'security' },
  'rotate key':        { weight: 0.65, category: 'security' },
  'access control':    { weight: 0.7, category: 'security' },

  // Cost
  'reduce cost':       { weight: 0.55, category: 'cost-optimization' },
  'cut spending':      { weight: 0.55, category: 'cost-optimization' },
  'budget':            { weight: 0.5, category: 'cost-optimization' },
  'cheaper':           { weight: 0.5, category: 'cost-optimization' },
};

const COMPLEXITY_INDICATORS: Record<string, number> = {
  // High complexity
  'migration':     0.3,
  'breaking change': 0.35,
  'downtime':      0.3,
  'rollback':      0.2,
  'backward compat': 0.25,
  'multi-region':  0.3,
  'zero downtime': 0.25,

  // Medium complexity
  'gradual':       -0.1,
  'canary':        -0.1,
  'blue-green':    -0.1,
  'phased':        -0.1,
  'incremental':   -0.1,

  // Low complexity
  'toggle':        -0.15,
  'flag':          -0.1,
  'simple':        -0.2,
  'minor':         -0.15,
};

// ─── Analysis Functions ────────────────────────────────────────────────────────

function detectKeywords(description: string): { keyword: string; weight: number; category: string }[] {
  const lower = description.toLowerCase();
  const matches: { keyword: string; weight: number; category: string }[] = [];

  for (const [keyword, meta] of Object.entries(PLATFORM_KEYWORDS)) {
    if (lower.includes(keyword)) {
      matches.push({ keyword, ...meta });
    }
  }

  return matches;
}

function estimateComplexity(description: string): { score: number; evidence: EvidenceItem[] } {
  const lower = description.toLowerCase();
  let score = 0.5; // baseline
  const evidence: EvidenceItem[] = [];

  for (const [indicator, delta] of Object.entries(COMPLEXITY_INDICATORS)) {
    if (lower.includes(indicator)) {
      score += delta;
      evidence.push({
        type: 'keyword',
        source: 'complexity-detector',
        detail: `"${indicator}" → complexity ${delta > 0 ? '+' : ''}${delta}`,
        weight: Math.abs(delta),
      });
    }
  }

  // Word count heuristic: longer descriptions suggest more complex scenarios
  const wordCount = description.split(/\s+/).length;
  if (wordCount > 50) {
    score += 0.1;
    evidence.push({
      type: 'heuristic',
      source: 'description-length',
      detail: `${wordCount} words suggests multi-faceted scenario`,
      weight: 0.1,
    });
  }

  return { score: Math.max(0, Math.min(1, score)), evidence };
}

function computeSuccessProbability(
  keywordMatches: { keyword: string; weight: number; category: string }[],
  complexityScore: number,
): number {
  // Base probability inversely related to complexity
  let probability = 1 - complexityScore * 0.6;

  // Recognized platform keywords increase predictability → higher success
  if (keywordMatches.length > 0) {
    const avgWeight = keywordMatches.reduce((s, m) => s + m.weight, 0) / keywordMatches.length;
    // Well-understood operations have higher success rates
    probability = probability * (1 - avgWeight * 0.3) + 0.15;
  } else {
    // Unknown/unrecognized scenario — lower confidence, reduce probability
    probability *= 0.7;
  }

  return Math.round(Math.max(0.1, Math.min(0.95, probability)) * 100) / 100;
}

function deriveRiskFactors(
  keywordMatches: { keyword: string; weight: number; category: string }[],
  description: string,
): RiskFactor[] {
  const lower = description.toLowerCase();
  const risks: RiskFactor[] = [];
  const categories = new Set(keywordMatches.map((m) => m.category));

  if (categories.has('model-change')) {
    risks.push({
      factor: 'Model compatibility regression',
      severity: 'high',
      mitigation: 'Run benchmark suite on new model before full switch; maintain rollback path',
    });
    risks.push({
      factor: 'Prompt template incompatibility',
      severity: 'medium',
      mitigation: 'Validate all prompt templates against new model with golden dataset',
    });
  }

  if (categories.has('agent-deployment')) {
    risks.push({
      factor: 'Agent routing conflicts',
      severity: 'medium',
      mitigation: 'Verify no keyword overlap with existing agent domains in routing table',
    });
    risks.push({
      factor: 'Schema validation mismatch',
      severity: 'medium',
      mitigation: 'Run contract tests against Zod schemas before deployment',
    });
  }

  if (categories.has('scaling')) {
    risks.push({
      factor: 'Cold start latency increase',
      severity: 'medium',
      mitigation: 'Set minimum instances > 0 for critical paths; monitor p99 latency',
    });
    risks.push({
      factor: 'Cost overrun during scale-up',
      severity: 'low',
      mitigation: 'Set budget alerts and max-instances caps',
    });
  }

  if (categories.has('infrastructure')) {
    risks.push({
      factor: 'Data residency / compliance exposure',
      severity: 'high',
      mitigation: 'Verify region supports required compliance frameworks before migration',
    });
    risks.push({
      factor: 'Network latency between services',
      severity: 'medium',
      mitigation: 'Benchmark cross-region latency; co-locate dependent services',
    });
  }

  if (categories.has('security')) {
    risks.push({
      factor: 'Credential rotation window vulnerability',
      severity: 'high',
      mitigation: 'Use dual-key rotation pattern; verify old keys remain valid during transition',
    });
  }

  if (categories.has('cost-optimization')) {
    risks.push({
      factor: 'Quality degradation from cost cuts',
      severity: 'medium',
      mitigation: 'Run quality benchmarks (hallucination, faithfulness) before and after changes',
    });
  }

  // Generic risks for unrecognized scenarios
  if (risks.length === 0) {
    if (lower.includes('production') || lower.includes('prod')) {
      risks.push({
        factor: 'Production environment impact',
        severity: 'high',
        mitigation: 'Test in staging first; implement canary deployment',
      });
    }
    risks.push({
      factor: 'Insufficient rollback plan',
      severity: 'medium',
      mitigation: 'Document rollback steps; verify they can execute within SLO window',
    });
    risks.push({
      factor: 'Unidentified dependencies',
      severity: 'low',
      mitigation: 'Map upstream/downstream dependencies before execution',
    });
  }

  return risks;
}

function estimateTimeline(
  categories: Set<string>,
  complexityScore: number,
): TimelineEstimate {
  // Base hours by category
  const categoryHours: Record<string, number> = {
    'model-change': 16,
    'agent-deployment': 8,
    'scaling': 4,
    'configuration': 2,
    'infrastructure': 24,
    'security': 12,
    'cost-optimization': 6,
  };

  let baseHours = 4; // default
  const phases: { name: string; hours: number }[] = [];

  for (const cat of categories) {
    baseHours = Math.max(baseHours, categoryHours[cat] ?? 4);
  }

  // Scale by complexity
  const expectedHours = Math.round(baseHours * (0.5 + complexityScore));

  if (categories.has('model-change') || categories.has('infrastructure')) {
    phases.push({ name: 'Planning & risk assessment', hours: Math.round(expectedHours * 0.2) });
    phases.push({ name: 'Staging validation', hours: Math.round(expectedHours * 0.3) });
    phases.push({ name: 'Gradual rollout', hours: Math.round(expectedHours * 0.35) });
    phases.push({ name: 'Monitoring & verification', hours: Math.round(expectedHours * 0.15) });
  } else {
    phases.push({ name: 'Implementation', hours: Math.round(expectedHours * 0.5) });
    phases.push({ name: 'Testing', hours: Math.round(expectedHours * 0.3) });
    phases.push({ name: 'Deployment & verification', hours: Math.round(expectedHours * 0.2) });
  }

  return {
    optimistic_hours: Math.max(1, Math.round(expectedHours * 0.6)),
    expected_hours: Math.max(2, expectedHours),
    pessimistic_hours: Math.round(expectedHours * 1.8),
    phases,
  };
}

function classifyComplexity(score: number): 'low' | 'medium' | 'high' | 'critical' {
  if (score < 0.3) return 'low';
  if (score < 0.55) return 'medium';
  if (score < 0.8) return 'high';
  return 'critical';
}

function generateRecommendations(
  categories: Set<string>,
  complexityLevel: string,
  successProb: number,
): string[] {
  const recs: string[] = [];

  if (successProb < 0.5) {
    recs.push('Consider breaking this into smaller, incremental changes');
  }

  if (categories.has('model-change')) {
    recs.push('Run test-bench/benchmark + test-bench/compare before committing to switch');
    recs.push('Use canary deployment: route 5% traffic to new model, monitor for 24h');
  }

  if (categories.has('agent-deployment')) {
    recs.push('Register in agent registry and validate schema before enabling routing');
  }

  if (categories.has('infrastructure')) {
    recs.push('Execute during low-traffic window; have rollback script ready');
  }

  if (categories.has('security')) {
    recs.push('Run shield/secrets + shield/credential-exposure scan after changes');
  }

  if (complexityLevel === 'high' || complexityLevel === 'critical') {
    recs.push('Create a decision memo via platform/decision-memo before proceeding');
    recs.push('Get go/no-go approval via platform/decision');
  }

  if (recs.length === 0) {
    recs.push('Standard deployment process should be sufficient');
    recs.push('Monitor observatory/health-check after deployment');
  }

  return recs;
}

// ─── Main Export ────────────────────────────────────────────────────────────────

export function analyzeScenario(input: ScenarioInput): ScenarioResult {
  const description = input.parameters.description;
  const keywordMatches = detectKeywords(description);
  const { score: complexityScore, evidence: complexityEvidence } = estimateComplexity(description);
  const successProbability = computeSuccessProbability(keywordMatches, complexityScore);
  const categories = new Set(keywordMatches.map((m) => m.category));
  const complexityLevel = classifyComplexity(complexityScore);

  // Build evidence list
  const evidence: EvidenceItem[] = [
    ...keywordMatches.map((m) => ({
      type: 'keyword' as const,
      source: 'platform-keyword-detector',
      detail: `Matched "${m.keyword}" → category: ${m.category}, weight: ${m.weight}`,
      weight: m.weight,
    })),
    ...complexityEvidence,
  ];

  if (evidence.length === 0) {
    evidence.push({
      type: 'heuristic',
      source: 'fallback-analyzer',
      detail: 'No platform-specific keywords detected; analysis based on general heuristics',
      weight: 0.3,
    });
  }

  // Determine primary category
  const categoryCounts: Record<string, number> = {};
  for (const m of keywordMatches) {
    categoryCounts[m.category] = (categoryCounts[m.category] ?? 0) + 1;
  }
  const primaryCategory = Object.entries(categoryCounts).sort((a, b) => b[1] - a[1])[0]?.[0]
    ?? 'general-platform';

  return {
    scenario_id: input.scenario_id,
    description,
    success_probability: successProbability,
    confidence: Math.min(0.95, 0.3 + keywordMatches.length * 0.1 + complexityEvidence.length * 0.05),
    risk_factors: deriveRiskFactors(keywordMatches, description),
    timeline: estimateTimeline(categories, complexityScore),
    evidence_items: evidence,
    category: primaryCategory,
    complexity: complexityLevel,
    recommendations: generateRecommendations(categories, complexityLevel, successProbability),
  };
}
