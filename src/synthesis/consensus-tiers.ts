/**
 * ADR-PIPELINE-071: Consensus Tier Classifier
 *
 * Classifies an engagement's analytical consensus into one of three tiers:
 *
 *   - aligned     — agreement ≥70% AND precision ≥70% → footnote OK
 *   - directional — partial agreement (40–69 / 50–69) → opening-paragraph
 *                   acknowledgement + ranges instead of point estimates
 *   - contested   — agreement <40 AND precision <50    → headline-level
 *                   treatment, drives document structure, "Why we are not
 *                   more confident" section, Week-4 consensus gate, etc.
 *
 * Pure functions over a `ConsensusSnapshot`. The snapshot is populated from
 * agent results by `populateConsensusSnapshot`.
 */

import type { AgentResult } from './simulation-renderers.js';

// ============================================================================
// Public types
// ============================================================================

export type ConsensusTier = 'aligned' | 'directional' | 'contested';

export type ConsensusDimension =
  | 'financial'
  | 'operational'
  | 'compliance'
  | 'workforce'
  | 'technical';

export interface DissentingAgent {
  readonly domain: string;
  readonly agent: string;
  readonly dimension: ConsensusDimension;
  readonly summary: string;
}

export interface ConsensusSnapshot {
  /** Cross-agent agreement level, 0–100. */
  readonly agreementLevelPct: number;
  /** Precision confidence — how tight the magnitude estimate is, 0–100. */
  readonly precisionConfidencePct: number;
  /** Directional confidence — how confident the answer is, 0–100. */
  readonly directionalConfidencePct: number;
  /** Tier derived from the two confidence numbers. */
  readonly tier: ConsensusTier;
  readonly dissentingAgents: readonly DissentingAgent[];
  /** Top-3 variables the result depends on most. */
  readonly loadBearingAssumptions: readonly string[];
  /** Per-dimension agreement breakdown (0..1). Used by the SVG generator. */
  readonly perDimension: Readonly<Record<ConsensusDimension, number>>;
}

// ============================================================================
// Classification
// ============================================================================

/**
 * ADR-PIPELINE-071 §1: tier thresholds.
 *
 * The classifier intentionally biases toward `contested` for ambiguous cases —
 * a low-consensus run rendered as if it were aligned is the failure mode the
 * ADR is trying to eliminate.
 */
export function classifyConsensus(
  agreementLevelPct: number,
  precisionConfidencePct: number,
): ConsensusTier {
  if (agreementLevelPct >= 70 && precisionConfidencePct >= 70) return 'aligned';
  if (agreementLevelPct < 40 && precisionConfidencePct < 50) return 'contested';
  if (agreementLevelPct >= 40 || precisionConfidencePct >= 50) return 'directional';
  return 'contested';
}

// ============================================================================
// Snapshot population
// ============================================================================

const DEFAULT_PER_DIMENSION: Readonly<Record<ConsensusDimension, number>> = {
  financial: 0.5,
  operational: 0.5,
  compliance: 0.5,
  workforce: 0.5,
  technical: 0.5,
};

interface ConsensusInputs {
  readonly agreementLevelPct?: number;
  readonly precisionConfidencePct?: number;
  readonly directionalConfidencePct?: number;
  readonly dissentingAgents?: readonly DissentingAgent[];
  readonly loadBearingAssumptions?: readonly string[];
  readonly perDimension?: Partial<Record<ConsensusDimension, number>>;
}

/**
 * Build a ConsensusSnapshot from explicit inputs. All fields default to a
 * conservative middle-ground when omitted, except `tier` which is always
 * recomputed from the two confidence numbers.
 */
export function buildConsensusSnapshot(inputs: ConsensusInputs = {}): ConsensusSnapshot {
  const agreementLevelPct = clampPct(inputs.agreementLevelPct ?? 50);
  const precisionConfidencePct = clampPct(inputs.precisionConfidencePct ?? 50);
  const directionalConfidencePct = clampPct(
    inputs.directionalConfidencePct ?? Math.max(agreementLevelPct, precisionConfidencePct + 20),
  );
  const tier = classifyConsensus(agreementLevelPct, precisionConfidencePct);
  return {
    agreementLevelPct,
    precisionConfidencePct,
    directionalConfidencePct,
    tier,
    dissentingAgents: inputs.dissentingAgents ?? [],
    loadBearingAssumptions: inputs.loadBearingAssumptions ?? [],
    perDimension: { ...DEFAULT_PER_DIMENSION, ...(inputs.perDimension ?? {}) },
  };
}

/**
 * ADR-PIPELINE-071 §3: populate the snapshot from raw agent results.
 *
 * Reads:
 *   - `analytics-hub/consensus`     → agreement, precision, dissenting agents
 *   - `simulator/enterprise`        → success_probability fallback for direction
 *   - all `*` agent error responses → dissent dimension
 *
 * Returns a snapshot that's safe for renderers to consume — never throws.
 */
export function populateConsensusSnapshot(
  simulationResult: unknown,
  platformResults: readonly AgentResult[],
): ConsensusSnapshot {
  const consensusAgent = platformResults.find(
    r => r.domain === 'analytics-hub' && r.agent === 'consensus',
  );

  const data = consensusAgent ? extractConsensusData(consensusAgent) : null;
  const agreementLevelPct = clampPct(
    data?.agreementLevelPct ?? Math.round((extractSimSuccess(simulationResult) ?? 0.5) * 100),
  );
  const precisionConfidencePct = clampPct(
    data?.precisionConfidencePct ?? data?.confidencePct ?? 50,
  );
  const directionalConfidencePct = clampPct(
    data?.directionalConfidencePct ??
      Math.min(99, Math.max(agreementLevelPct, precisionConfidencePct + 20)),
  );

  const dissentingAgents: DissentingAgent[] = [];
  for (const r of platformResults) {
    if (r.status >= 200 && r.status < 300) continue;
    dissentingAgents.push({
      domain: r.domain,
      agent: r.agent,
      dimension: dimensionFromDomain(r.domain),
      summary: `Agent returned status ${r.status}.`,
    });
  }
  if (data?.dissentingAgents) {
    dissentingAgents.push(...data.dissentingAgents);
  }

  const loadBearingAssumptions = data?.loadBearingAssumptions ?? [
    'Pilot data reflects production conditions',
    'Adoption rate matches analogous deployments',
    'No regulatory scope changes during the pilot window',
  ];

  const perDimension = data?.perDimension ?? {
    financial: precisionConfidencePct / 100,
    operational: precisionConfidencePct / 100,
    compliance: agreementLevelPct / 100,
    workforce: Math.max(0.3, (agreementLevelPct - 10) / 100),
    technical: Math.min(0.95, (precisionConfidencePct + 20) / 100),
  };

  return buildConsensusSnapshot({
    agreementLevelPct,
    precisionConfidencePct,
    directionalConfidencePct,
    dissentingAgents,
    loadBearingAssumptions,
    perDimension,
  });
}

// ============================================================================
// Helpers
// ============================================================================

function clampPct(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n <= 0) return 0;
  if (n >= 100) return 100;
  return Math.round(n);
}

interface ParsedConsensusData {
  agreementLevelPct?: number;
  precisionConfidencePct?: number;
  confidencePct?: number;
  directionalConfidencePct?: number;
  dissentingAgents?: DissentingAgent[];
  loadBearingAssumptions?: string[];
  perDimension?: Partial<Record<ConsensusDimension, number>>;
}

function extractConsensusData(agent: AgentResult): ParsedConsensusData {
  const response = agent.response as Record<string, unknown> | null;
  if (!response || typeof response !== 'object') return {};
  const signal = response['signal'] as Record<string, unknown> | undefined;
  const payloadOuter = signal ? (signal['payload'] as Record<string, unknown> | undefined) : undefined;
  const payload = payloadOuter ? (payloadOuter['data'] as Record<string, unknown> | undefined) : undefined;
  const data: Record<string, unknown> = payload ?? response;

  const out: ParsedConsensusData = {};
  if (typeof data['agreement_level_pct'] === 'number') {
    out.agreementLevelPct = data['agreement_level_pct'] as number;
  } else if (typeof data['agreementLevelPct'] === 'number') {
    out.agreementLevelPct = data['agreementLevelPct'] as number;
  }

  if (typeof data['precision_confidence_pct'] === 'number') {
    out.precisionConfidencePct = data['precision_confidence_pct'] as number;
  } else if (typeof data['precisionConfidencePct'] === 'number') {
    out.precisionConfidencePct = data['precisionConfidencePct'] as number;
  }

  if (typeof data['confidence'] === 'number') {
    out.confidencePct = (data['confidence'] as number) * 100;
  } else if (typeof data['overallConfidence'] === 'number') {
    out.confidencePct = (data['overallConfidence'] as number) * 100;
  }

  if (typeof data['directional_confidence_pct'] === 'number') {
    out.directionalConfidencePct = data['directional_confidence_pct'] as number;
  }

  if (Array.isArray(data['dissenting_agents'])) {
    out.dissentingAgents = (data['dissenting_agents'] as Array<Record<string, unknown>>).map(d => ({
      domain: String(d['domain'] ?? 'unknown'),
      agent: String(d['agent'] ?? 'unknown'),
      dimension: (typeof d['dimension'] === 'string'
        ? (d['dimension'] as ConsensusDimension)
        : 'operational'),
      summary: String(d['summary'] ?? d['reason'] ?? ''),
    }));
  }

  if (Array.isArray(data['load_bearing_assumptions'])) {
    out.loadBearingAssumptions = (data['load_bearing_assumptions'] as unknown[])
      .filter(x => typeof x === 'string')
      .slice(0, 3) as string[];
  }

  if (data['per_dimension'] && typeof data['per_dimension'] === 'object') {
    out.perDimension = data['per_dimension'] as Partial<Record<ConsensusDimension, number>>;
  }

  return out;
}

function dimensionFromDomain(domain: string): ConsensusDimension {
  const d = domain.toLowerCase();
  if (/cost|finan|roi|npv/.test(d)) return 'financial';
  if (/governance|policy|compliance|shield|legal/.test(d)) return 'compliance';
  if (/work\s*force|hr/.test(d)) return 'workforce';
  if (/sec|engineer|tech|integration|architect/.test(d)) return 'technical';
  return 'operational';
}

function extractSimSuccess(simulationResult: unknown): number | null {
  if (!simulationResult || typeof simulationResult !== 'object') return null;
  const sig = (simulationResult as Record<string, unknown>)['signal'] as Record<string, unknown> | undefined;
  const payload = sig?.['payload'] as Record<string, unknown> | undefined;
  const data = (payload?.['data'] ?? simulationResult) as Record<string, unknown>;
  const val = data['success_probability'] ?? data['confidence'];
  if (typeof val === 'number') return val;
  return null;
}

// ============================================================================
// Tier-driven content blocks
// ============================================================================

/** Used by renderers as a top-of-document banner. */
export function consensusBanner(snapshot: ConsensusSnapshot): string | null {
  if (snapshot.tier === 'aligned') return null;
  if (snapshot.tier === 'directional') {
    return [
      `> 📊 **Consensus: directional** — agreement ${snapshot.agreementLevelPct}%, precision ${snapshot.precisionConfidencePct}%.`,
      '> Direction is supported, magnitude has meaningful variance. Treat headline figures as ranges.',
    ].join('\n');
  }
  return [
    `> 📊 **Consensus: contested** — agreement ${snapshot.agreementLevelPct}%, precision ${snapshot.precisionConfidencePct}%.`,
    '> See "Why we are not more confident" before interpreting figures.',
  ].join('\n');
}

/** Required opening paragraph for the executive summary on directional / contested tiers. */
export function consensusOpeningParagraph(snapshot: ConsensusSnapshot): string | null {
  if (snapshot.tier === 'aligned') return null;
  if (snapshot.tier === 'directional') {
    return (
      `**Agent consensus: directional (${snapshot.agreementLevelPct}%)** — direction is supported, ` +
      'magnitude has meaningful variance. Headline figures should be read as ranges, not point estimates.'
    );
  }
  return (
    `**Agent consensus is contested (agreement ${snapshot.agreementLevelPct}%, precision ${snapshot.precisionConfidencePct}%).** ` +
    'This is why the recommendation is a bounded pilot, not full deployment — the pilot is designed ' +
    'to resolve the disagreement with measured data before any broader commitment.'
  );
}

/** "Why we are not more confident" section body for the decision memo. */
export function whyNotMoreConfidentSection(snapshot: ConsensusSnapshot): string[] {
  if (snapshot.tier === 'aligned') return [];
  const lines: string[] = ['## Why We Are Not More Confident', ''];
  lines.push(
    `Agent consensus reached **agreement ${snapshot.agreementLevelPct}%** with **precision ${snapshot.precisionConfidencePct}%**. ` +
    `Directional confidence is **${snapshot.directionalConfidencePct}%** — we are confident in the direction of the answer, ` +
    'but the magnitude carries meaningful uncertainty.',
    '',
  );

  if (snapshot.dissentingAgents.length > 0) {
    lines.push('**Dissenting agents:**', '');
    for (const d of snapshot.dissentingAgents.slice(0, 6)) {
      lines.push(`- \`${d.domain}/${d.agent}\` (${d.dimension}) — ${d.summary}`);
    }
    lines.push('');
  }

  if (snapshot.loadBearingAssumptions.length > 0) {
    lines.push('**Load-bearing assumptions:**', '');
    for (const a of snapshot.loadBearingAssumptions.slice(0, 3)) {
      lines.push(`- ${a}`);
    }
    lines.push('');
  }

  return lines;
}

/** Week-4 consensus gate for the roadmap on contested runs. */
export function consensusGate(snapshot: ConsensusSnapshot): {
  readonly week: number;
  readonly threshold_pct: number;
  readonly default_action: 'STOP' | 'PROCEED';
  readonly description: string;
} | null {
  if (snapshot.tier !== 'contested') return null;
  return {
    week: 4,
    threshold_pct: 60,
    default_action: 'STOP',
    description:
      'If measured pilot data has not moved precision confidence above 60% by Week 4, the Week 8 scale ' +
      'decision defaults to STOP. Resume only after a follow-up consensus check confirms the direction.',
  };
}

/**
 * Risk-register row injected on contested runs so analytical uncertainty is
 * a named, owned risk rather than a tone-of-voice.
 */
export function analyticalUncertaintyRisk(snapshot: ConsensusSnapshot): {
  readonly risk: string;
  readonly category: 'Analytical';
  readonly likelihood: 'High';
  readonly impact: 'High';
  readonly score: number;
  readonly mitigation: string;
} | null {
  if (snapshot.tier !== 'contested') return null;
  return {
    risk: `Analytical uncertainty: agent consensus contested (agreement ${snapshot.agreementLevelPct}%, precision ${snapshot.precisionConfidencePct}%)`,
    category: 'Analytical',
    likelihood: 'High',
    impact: 'High',
    score: 9,
    mitigation:
      'Week-4 consensus gate (default STOP if precision <60%); pilot scope locked at one region; ' +
      'load-bearing assumptions tracked weekly with named owners.',
  };
}
