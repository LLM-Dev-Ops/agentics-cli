/**
 * ADR-PIPELINE-071 tests: consensus tier classifier + tier-driven renderers.
 *
 * Verifies:
 *  - classifyConsensus returns correct tier at boundaries (70/70, 40/50, 0/0)
 *  - populateConsensusSnapshot reads agent results, dissenters, assumptions
 *  - consensusBanner / consensusOpeningParagraph / whyNotMoreConfidentSection
 *    return content for directional + contested but not aligned
 *  - consensusGate fires only on contested
 *  - analyticalUncertaintyRisk returns High/High row for contested
 *  - findForbiddenSpinPhrases catches the 7 phrases
 *  - FCR-010 fires on contested runs containing forbidden phrases, no-op
 *    on aligned runs
 *  - renderConsensusSvg produces a valid SVG document with per-dimension bars
 *  - Renderer integration: contested fixture → contested header in
 *    executive summary AND decision memo, "Why we are not more confident"
 *    section in both, Week-4 consensus gate in roadmap, analytical
 *    uncertainty risk in risk register
 *  - Aligned fixture renders unchanged (no banner, no why-section, no gate)
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  classifyConsensus,
  buildConsensusSnapshot,
  populateConsensusSnapshot,
  consensusBanner,
  consensusOpeningParagraph,
  whyNotMoreConfidentSection,
  consensusGate,
  analyticalUncertaintyRisk,
  type ConsensusSnapshot,
} from '../../../src/synthesis/consensus-tiers.js';
import {
  findForbiddenSpinPhrases,
  FORBIDDEN_SPIN_PHRASES,
} from '../../../src/synthesis/forbidden-spin-phrases.js';
import { renderConsensusSvg } from '../../../src/synthesis/consensus-svg.js';
import {
  __internal as fcrInternal,
} from '../../../src/synthesis/financial-consistency-rules.js';
import { runConsistencyCheck } from '../../../src/synthesis/financial-consistency-runner.js';
import {
  renderExecutiveSummary,
  renderDecisionMemo,
  buildRiskAssessment,
  buildRoadmapArtifact,
  type AgentResult,
} from '../../../src/synthesis/simulation-renderers.js';

// ============================================================================
// Fixtures
// ============================================================================

function mkTemp(label: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `adr071-${label}-`));
}

function consensusAgentResult(
  agreementLevelPct: number,
  precisionConfidencePct: number,
): AgentResult {
  return {
    domain: 'analytics-hub',
    agent: 'consensus',
    status: 200,
    response: {
      signal: {
        payload: {
          data: {
            agreement_level_pct: agreementLevelPct,
            precision_confidence_pct: precisionConfidencePct,
            confidence: precisionConfidencePct / 100,
            consensusAchieved: agreementLevelPct >= 70 && precisionConfidencePct >= 70,
            dissenting_agents: [
              { domain: 'costops', agent: 'roi', dimension: 'financial', summary: 'ROI estimate ranges 60–300%.' },
              { domain: 'shield', agent: 'pii', dimension: 'compliance', summary: 'Cross-region PII flow unresolved.' },
            ],
            load_bearing_assumptions: [
              'Pilot data reflects production conditions',
              'Adoption rate matches analogous deployments',
              'No regulatory scope changes during the pilot window',
            ],
            per_dimension: {
              financial: 0.42,
              operational: 0.55,
              compliance: 0.30,
              workforce: 0.45,
              technical: 0.70,
            },
          },
        },
      },
    },
  };
}

const HOSPITALITY_QUERY =
  'I lead sustainability and housekeeping operations for a global hotel group with approximately 91,000 employees across NA, EMEA, and APAC. Oracle Hospitality OPERA manages cleaning frequency.';

const SAAS_QUERY =
  'Build an internal dashboard SaaS to track engineering velocity. Pure software project.';

// ============================================================================
// classifyConsensus
// ============================================================================

describe('ADR-071 — classifyConsensus', () => {
  it('returns aligned at the 70/70 threshold', () => {
    expect(classifyConsensus(70, 70)).toBe('aligned');
    expect(classifyConsensus(80, 75)).toBe('aligned');
  });

  it('returns directional when only one of the two clears', () => {
    expect(classifyConsensus(50, 30)).toBe('directional');
    expect(classifyConsensus(30, 60)).toBe('directional');
  });

  it('returns contested when both are below the floor', () => {
    expect(classifyConsensus(0, 42)).toBe('contested');
    expect(classifyConsensus(20, 30)).toBe('contested');
  });

  it('returns aligned when one is just above and the other is well above', () => {
    expect(classifyConsensus(70, 95)).toBe('aligned');
  });
});

// ============================================================================
// populateConsensusSnapshot
// ============================================================================

describe('ADR-071 — populateConsensusSnapshot', () => {
  it('extracts agreement, precision, dissenters, and assumptions from an agent', () => {
    const snapshot = populateConsensusSnapshot(null, [consensusAgentResult(0, 42)]);
    expect(snapshot.agreementLevelPct).toBe(0);
    expect(snapshot.precisionConfidencePct).toBe(42);
    expect(snapshot.tier).toBe('contested');
    expect(snapshot.dissentingAgents.length).toBeGreaterThanOrEqual(2);
    expect(snapshot.loadBearingAssumptions.length).toBe(3);
  });

  it('falls back to a defaulted snapshot when no consensus agent is present', () => {
    const snapshot = populateConsensusSnapshot(null, []);
    expect(snapshot.agreementLevelPct).toBeGreaterThanOrEqual(0);
    expect(snapshot.tier).toMatch(/aligned|directional|contested/);
  });

  it('classifies a high-agreement / high-precision agent as aligned', () => {
    const snapshot = populateConsensusSnapshot(null, [consensusAgentResult(85, 80)]);
    expect(snapshot.tier).toBe('aligned');
  });

  it('records error-status agents as dissenters', () => {
    const snapshot = populateConsensusSnapshot(null, [
      consensusAgentResult(0, 42),
      { domain: 'sentinel', agent: 'anomaly', status: 500, response: null },
    ]);
    expect(snapshot.dissentingAgents.some(d => d.domain === 'sentinel')).toBe(true);
  });
});

// ============================================================================
// Tier-driven content blocks
// ============================================================================

describe('ADR-071 — tier-driven content blocks', () => {
  const aligned: ConsensusSnapshot = buildConsensusSnapshot({
    agreementLevelPct: 85,
    precisionConfidencePct: 78,
  });
  const directional: ConsensusSnapshot = buildConsensusSnapshot({
    agreementLevelPct: 52,
    precisionConfidencePct: 45,
  });
  const contested: ConsensusSnapshot = buildConsensusSnapshot({
    agreementLevelPct: 0,
    precisionConfidencePct: 42,
    dissentingAgents: [
      { domain: 'costops', agent: 'roi', dimension: 'financial', summary: 'wide ROI variance' },
    ],
    loadBearingAssumptions: ['adoption rate', 'data coverage', 'integration complexity'],
  });

  it('aligned tier → no banner, no opening, no why-section, no gate, no analytical risk', () => {
    expect(consensusBanner(aligned)).toBeNull();
    expect(consensusOpeningParagraph(aligned)).toBeNull();
    expect(whyNotMoreConfidentSection(aligned)).toEqual([]);
    expect(consensusGate(aligned)).toBeNull();
    expect(analyticalUncertaintyRisk(aligned)).toBeNull();
  });

  it('directional tier → banner + opening + why-section, no gate', () => {
    expect(consensusBanner(directional)).toContain('directional');
    expect(consensusOpeningParagraph(directional)).toMatch(/directional/i);
    expect(whyNotMoreConfidentSection(directional).length).toBeGreaterThan(0);
    expect(consensusGate(directional)).toBeNull();
    expect(analyticalUncertaintyRisk(directional)).toBeNull();
  });

  it('contested tier → loud banner + headline opening + why-section + Week-4 gate + analytical risk', () => {
    expect(consensusBanner(contested)).toMatch(/contested/);
    expect(consensusOpeningParagraph(contested)).toMatch(/contested/i);
    const why = whyNotMoreConfidentSection(contested);
    expect(why.some(l => /Why We Are Not More Confident/.test(l))).toBe(true);
    expect(why.some(l => /costops\/roi/.test(l))).toBe(true);
    const gate = consensusGate(contested);
    expect(gate?.week).toBe(4);
    expect(gate?.threshold_pct).toBe(60);
    expect(gate?.default_action).toBe('STOP');
    expect(analyticalUncertaintyRisk(contested)?.score).toBe(9);
  });
});

// ============================================================================
// findForbiddenSpinPhrases
// ============================================================================

describe('ADR-071 — findForbiddenSpinPhrases', () => {
  it('catches every documented forbidden phrase', () => {
    for (const p of FORBIDDEN_SPIN_PHRASES) {
      // Build a sentence that should match the pattern.
      const samples: Record<string, string> = {
        'no-meaningful-dissent': 'There was no meaningful dissent across agents.',
        'direction-not-disputed': 'The direction is not disputed by any agent.',
        'broad-agreement': 'There is broad agreement across the panel.',
        'agents-aligned': 'All agents aligned on the recommendation.',
        'unanimous': 'The recommendation is unanimous.',
        'high-confidence': 'We have high confidence in the model.',
        'no-significant-uncertainty': 'There is no significant uncertainty in the result.',
      };
      const text = samples[p.id]!;
      const findings = findForbiddenSpinPhrases(text);
      expect(findings.some(f => f.id === p.id)).toBe(true);
    }
  });

  it('does NOT match prose without forbidden phrases', () => {
    expect(findForbiddenSpinPhrases('Agents disagreed on the magnitude.').length).toBe(0);
  });

  it('skips fenced code blocks', () => {
    const text = '```\nno meaningful dissent\n```\nReal text.';
    expect(findForbiddenSpinPhrases(text).length).toBe(0);
  });
});

// ============================================================================
// FCR-010
// ============================================================================

describe('ADR-071 — FCR-010', () => {
  const contestedSnapshot = buildConsensusSnapshot({
    agreementLevelPct: 0,
    precisionConfidencePct: 42,
  });
  const alignedSnapshot = buildConsensusSnapshot({
    agreementLevelPct: 85,
    precisionConfidencePct: 80,
  });

  it('fires when contested run contains a forbidden phrase', () => {
    const violations = fcrInternal.ruleFcr010(
      [{ document: 'executive-summary', content: 'There was no meaningful dissent in the analysis.' }],
      contestedSnapshot,
    );
    expect(violations.length).toBeGreaterThanOrEqual(1);
    expect(violations[0]!.ruleId).toBe('FCR-010');
    expect(violations[0]!.severity).toBe('error');
  });

  it('does NOT fire when run is aligned', () => {
    const violations = fcrInternal.ruleFcr010(
      [{ document: 'executive-summary', content: 'There was no meaningful dissent in the analysis.' }],
      alignedSnapshot,
    );
    expect(violations).toEqual([]);
  });

  it('does NOT fire when no consensus snapshot is supplied', () => {
    const violations = fcrInternal.ruleFcr010(
      [{ document: 'executive-summary', content: 'There was no meaningful dissent in the analysis.' }],
      null,
    );
    expect(violations).toEqual([]);
  });

  it('runs end-to-end through runConsistencyCheck on a contested run', () => {
    const dir = mkTemp('runner-contested');
    try {
      const execPath = path.join(dir, 'executive-summary.md');
      const content = '# Executive Summary\n\nThere was no meaningful dissent in the analysis.';
      fs.writeFileSync(execPath, content, 'utf-8');
      const result = runConsistencyCheck({
        runDir: dir,
        documents: [{ kind: 'executive-summary', path: execPath, content }],
        consensus: contestedSnapshot,
        annotateDocuments: false,
      });
      expect(result.violations.some(v => v.ruleId === 'FCR-010')).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ============================================================================
// renderConsensusSvg
// ============================================================================

describe('ADR-071 — renderConsensusSvg', () => {
  it('produces a valid SVG document with all dimensions', () => {
    const snapshot = buildConsensusSnapshot({
      agreementLevelPct: 0,
      precisionConfidencePct: 42,
      perDimension: { financial: 0.4, operational: 0.5, compliance: 0.3, workforce: 0.45, technical: 0.7 },
    });
    const svg = renderConsensusSvg(snapshot);
    expect(svg).toMatch(/^<svg/);
    expect(svg).toContain('Financial');
    expect(svg).toContain('Operational');
    expect(svg).toContain('Compliance');
    expect(svg).toContain('Workforce');
    expect(svg).toContain('Technical');
    expect(svg).toContain('contested');
  });

  it('uses the green color scheme for aligned tier', () => {
    const snapshot = buildConsensusSnapshot({ agreementLevelPct: 85, precisionConfidencePct: 80 });
    const svg = renderConsensusSvg(snapshot);
    expect(svg).toContain('#16a34a'); // green
    expect(svg).not.toContain('#dc2626'); // red
  });
});

// ============================================================================
// Renderer integration — executive summary, decision memo, risk, roadmap
// ============================================================================

describe('ADR-071 — renderer integration on contested runs', () => {
  const contestedAgents: AgentResult[] = [consensusAgentResult(0, 42)];

  it('executive summary leads with contested banner + opening', () => {
    const out = renderExecutiveSummary(HOSPITALITY_QUERY, null, contestedAgents);
    expect(out).toMatch(/Consensus: contested/);
    expect(out).toMatch(/Why We Are Not More Confident/);
  });

  it('decision memo includes contested banner and Why-section', () => {
    const out = renderDecisionMemo(HOSPITALITY_QUERY, null, contestedAgents);
    expect(out).toMatch(/Consensus: contested/);
    expect(out).toMatch(/Why We Are Not More Confident/);
    expect(out).toMatch(/Dissenting agents/);
  });

  it('risk register adds the analytical-uncertainty risk with score 9', () => {
    const risk = buildRiskAssessment(HOSPITALITY_QUERY, null, contestedAgents);
    const register = risk['risk_register'] as Array<{ description: string; score: number; category: string }>;
    const analytical = register.find(r => /Analytical uncertainty/.test(r.description));
    expect(analytical).toBeDefined();
    expect(analytical!.score).toBe(9);
    expect(analytical!.category).toBe('Analytical');
  });

  it('roadmap includes a Week-4 consensus gate on contested runs', () => {
    const roadmap = buildRoadmapArtifact(HOSPITALITY_QUERY, null, contestedAgents);
    const gate = roadmap['consensus_gate'] as { week: number; default_action: string } | null;
    expect(gate).not.toBeNull();
    expect(gate!.week).toBe(4);
    expect(gate!.default_action).toBe('STOP');
  });

  it('risk_assessment exposes consensus_tier metadata', () => {
    const risk = buildRiskAssessment(HOSPITALITY_QUERY, null, contestedAgents);
    const ct = risk['consensus_tier'] as { tier: string; agreement_pct: number; precision_pct: number };
    expect(ct.tier).toBe('contested');
    expect(ct.agreement_pct).toBe(0);
    expect(ct.precision_pct).toBe(42);
  });
});

describe('ADR-071 — renderer integration on aligned runs', () => {
  const alignedAgents: AgentResult[] = [consensusAgentResult(85, 80)];

  it('executive summary has NO contested/directional banner', () => {
    const out = renderExecutiveSummary(SAAS_QUERY, null, alignedAgents);
    expect(out).not.toMatch(/Consensus: contested/);
    expect(out).not.toMatch(/Consensus: directional/);
    expect(out).not.toMatch(/Why We Are Not More Confident/);
  });

  it('decision memo renders without the Why-section', () => {
    const out = renderDecisionMemo(SAAS_QUERY, null, alignedAgents);
    expect(out).not.toMatch(/Why We Are Not More Confident/);
  });

  it('roadmap consensus_gate is null on aligned runs', () => {
    const roadmap = buildRoadmapArtifact(SAAS_QUERY, null, alignedAgents);
    expect(roadmap['consensus_gate']).toBeNull();
  });

  it('risk register does NOT contain the analytical-uncertainty row on aligned runs', () => {
    const risk = buildRiskAssessment(SAAS_QUERY, null, alignedAgents);
    const register = risk['risk_register'] as Array<{ description: string }>;
    expect(register.some(r => /Analytical uncertainty/.test(r.description))).toBe(false);
  });
});

describe('ADR-071 — renderer integration on directional runs', () => {
  const directionalAgents: AgentResult[] = [consensusAgentResult(50, 45)];

  it('executive summary contains the directional banner + opening', () => {
    const out = renderExecutiveSummary(HOSPITALITY_QUERY, null, directionalAgents);
    expect(out).toMatch(/Consensus: directional/);
    expect(out).toMatch(/directional/i);
  });

  it('roadmap consensus_gate stays null on directional runs (gate is contested-only)', () => {
    const roadmap = buildRoadmapArtifact(HOSPITALITY_QUERY, null, directionalAgents);
    expect(roadmap['consensus_gate']).toBeNull();
  });
});
