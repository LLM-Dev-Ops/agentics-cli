/**
 * ADR-PIPELINE-062 tests: competitive analysis section in executive summary.
 *
 * Verifies:
 *  - buildFallbackCompetitiveAnalysis returns a valid non-empty structure
 *    for every supported scenario type
 *  - peer_firms are sorted alphabetically
 *  - capability_maturity rows are sorted by current_level severity (worst first)
 *  - gap_to_close has one entry per capability, non-negative level jumps,
 *    and valid vs_top_peer strings
 *  - regulation-driven risks appear for regulated scenarios
 *  - post_pilot_level >= current_level for every row
 *  - deterministic output for same query
 *  - renderExecutiveSummary ALWAYS emits "## Competitive Position"
 *  - simulate_create prompt contains the new section 10 spec
 *  - source-level regression: old competitive paragraph is gone
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  buildFallbackCompetitiveAnalysis,
  renderExecutiveSummary,
  type CompetitiveAnalysis,
  type MaturityLevel,
  type PeerFirm,
} from '../../../src/synthesis/simulation-renderers.js';

// ============================================================================
// Fixtures
// ============================================================================

function fakeExtracted(overrides: Record<string, unknown> = {}): unknown {
  return {
    scenario_type: 'sustainability-esg',
    stakeholders: ['Sustainability Officer', 'CTO'],
    constraints: [],
    success_criteria: [],
    systems: ['SAP S/4HANA'],
    domain_entities: ['Building', 'Zone'],
    capabilities: [],
    ...overrides,
  };
}

const RANK: Record<MaturityLevel, number> = {
  none: 0, manual: 1, rule_based: 2, automated: 3, ai_optimized: 4,
};

// ============================================================================
// buildFallbackCompetitiveAnalysis — framework tests
// ============================================================================

describe('ADR-PIPELINE-062 — buildFallbackCompetitiveAnalysis()', () => {
  it('returns at least 3 peer firms, 4 capability rows, 2 risks', () => {
    const ca = buildFallbackCompetitiveAnalysis(
      'We need sustainability reporting across our enterprise.',
      fakeExtracted() as never,
    );
    expect(ca.peer_firms.length).toBeGreaterThanOrEqual(3);
    expect(ca.capability_maturity.length).toBeGreaterThanOrEqual(4);
    expect(ca.risks_of_inaction.length).toBeGreaterThanOrEqual(2);
    expect(ca.sources.length).toBeGreaterThan(0);
  });

  it('peer_firms are sorted alphabetically', () => {
    const ca = buildFallbackCompetitiveAnalysis(
      'sustainability analysis',
      fakeExtracted() as never,
    );
    const names = ca.peer_firms.map((p: PeerFirm) => p.name);
    const sorted = [...names].sort((a, b) => a.localeCompare(b));
    expect(names).toEqual(sorted);
  });

  it('capability_maturity rows are sorted by worst current_level first', () => {
    const ca = buildFallbackCompetitiveAnalysis(
      'sustainability analysis',
      fakeExtracted() as never,
    );
    const ranks = ca.capability_maturity.map(r => RANK[r.current_level]);
    for (let i = 1; i < ranks.length; i++) {
      expect(ranks[i]!).toBeGreaterThanOrEqual(ranks[i - 1]!);
    }
  });

  it('gap_to_close has one entry per capability row', () => {
    const ca = buildFallbackCompetitiveAnalysis(
      'sustainability analysis',
      fakeExtracted() as never,
    );
    expect(ca.gap_to_close.length).toBe(ca.capability_maturity.length);
  });

  it('every post_pilot_level is >= current_level (no downgrades)', () => {
    const ca = buildFallbackCompetitiveAnalysis(
      'supply chain analysis',
      fakeExtracted({ scenario_type: 'supply-chain-management' }) as never,
    );
    for (const row of ca.capability_maturity) {
      expect(RANK[row.post_pilot_level]).toBeGreaterThanOrEqual(RANK[row.current_level]);
    }
  });

  it('levels_jumped is non-negative and matches post - current', () => {
    const ca = buildFallbackCompetitiveAnalysis(
      'finance compliance',
      fakeExtracted({ scenario_type: 'financial-operations' }) as never,
    );
    for (const gap of ca.gap_to_close) {
      expect(gap.levels_jumped).toBeGreaterThanOrEqual(0);
      const expected = RANK[gap.to] - RANK[gap.from];
      expect(gap.levels_jumped).toBe(Math.max(0, expected));
    }
  });

  it('vs_top_peer is one of the three allowed strings', () => {
    const allowed = new Set([
      'Matches or exceeds top peer',
      'Reaches peer median',
      'Closes gap to trailing peer',
    ]);
    const ca = buildFallbackCompetitiveAnalysis(
      'healthcare analysis',
      fakeExtracted({ scenario_type: 'healthcare-operations' }) as never,
    );
    for (const gap of ca.gap_to_close) {
      expect(allowed.has(gap.vs_top_peer)).toBe(true);
    }
  });

  it('every peer_levels map has all peers from peer_firms', () => {
    const ca = buildFallbackCompetitiveAnalysis(
      'sustainability analysis',
      fakeExtracted() as never,
    );
    const peerNames = ca.peer_firms.map((p: PeerFirm) => p.name);
    for (const row of ca.capability_maturity) {
      for (const name of peerNames) {
        expect(row.peer_levels[name]).toBeDefined();
      }
    }
  });

  it('is deterministic for the same query and scenario', () => {
    const a = buildFallbackCompetitiveAnalysis('sustainability', fakeExtracted() as never);
    const b = buildFallbackCompetitiveAnalysis('sustainability', fakeExtracted() as never);
    expect(a).toEqual(b);
  });
});

// ============================================================================
// Domain routing — peer sets per scenario type
// ============================================================================

describe('ADR-PIPELINE-062 — domain-specific peer inference', () => {
  function peerNamesFor(scenarioType: string, queryWord: string): string[] {
    const ca = buildFallbackCompetitiveAnalysis(
      `${queryWord} strategy analysis`,
      fakeExtracted({ scenario_type: scenarioType }) as never,
    );
    return ca.peer_firms.map((p: PeerFirm) => p.name);
  }

  it('sustainability scenario uses Google, Salesforce, Siemens', () => {
    const peers = peerNamesFor('sustainability-esg', 'sustainability');
    expect(peers).toContain('Google');
    expect(peers).toContain('Salesforce');
    expect(peers).toContain('Siemens');
  });

  it('supply-chain scenario uses Amazon, DHL, Maersk', () => {
    const peers = peerNamesFor('supply-chain-management', 'supply chain');
    expect(peers).toContain('Amazon');
    expect(peers).toContain('DHL');
    expect(peers).toContain('Maersk');
  });

  it('financial-operations scenario uses investment banks', () => {
    const peers = peerNamesFor('financial-operations', 'finance');
    expect(peers).toContain('Goldman Sachs');
    expect(peers).toContain('JPMorgan Chase');
    expect(peers).toContain('Morgan Stanley');
  });

  it('hr-workforce scenario uses IBM, SAP, Workday', () => {
    const peers = peerNamesFor('hr-workforce-analytics', 'workforce');
    expect(peers).toContain('IBM');
    expect(peers).toContain('SAP SuccessFactors');
    expect(peers).toContain('Workday');
  });

  it('manufacturing scenario uses industrial firms', () => {
    const peers = peerNamesFor('manufacturing-operations', 'manufacturing');
    expect(peers).toContain('GE');
    expect(peers).toContain('Rockwell Automation');
    expect(peers).toContain('Siemens');
  });

  it('healthcare scenario uses healthcare-specific peers', () => {
    const peers = peerNamesFor('healthcare-operations', 'healthcare');
    expect(peers).toContain('Epic Systems');
    expect(peers).toContain('Kaiser Permanente');
    expect(peers).toContain('Mayo Clinic');
  });

  it('unknown scenario type falls through to generic peers', () => {
    const peers = peerNamesFor('some-unknown-scenario-type-xyz', 'analysis');
    expect(peers.length).toBe(3);
    // Generic fallback should be one of Deloitte, IBM, McKinsey
    expect(peers).toContain('Deloitte');
    expect(peers).toContain('IBM');
    expect(peers).toContain('McKinsey');
  });
});

// ============================================================================
// Domain-specific capabilities
// ============================================================================

describe('ADR-PIPELINE-062 — domain-specific capability rows', () => {
  it('sustainability adds ESG Reporting and Carbon Tracking', () => {
    const ca = buildFallbackCompetitiveAnalysis(
      'sustainability strategy',
      fakeExtracted({ scenario_type: 'sustainability-esg' }) as never,
    );
    const caps = ca.capability_maturity.map(r => r.capability);
    expect(caps).toContain('ESG Reporting (Scope 2)');
    expect(caps).toContain('Carbon Tracking');
  });

  it('supply-chain adds Supplier Visibility and Logistics Optimization', () => {
    const ca = buildFallbackCompetitiveAnalysis(
      'supply chain',
      fakeExtracted({ scenario_type: 'supply-chain-management' }) as never,
    );
    const caps = ca.capability_maturity.map(r => r.capability);
    expect(caps).toContain('Supplier Visibility');
    expect(caps).toContain('Logistics Optimization');
  });

  it('every scenario has the 3 domain-neutral base capabilities', () => {
    const ca = buildFallbackCompetitiveAnalysis(
      'healthcare analytics',
      fakeExtracted({ scenario_type: 'healthcare-operations' }) as never,
    );
    const caps = ca.capability_maturity.map(r => r.capability);
    expect(caps).toContain('Data Integration');
    expect(caps).toContain('Predictive Analytics');
    expect(caps).toContain('Decision Governance');
  });
});

// ============================================================================
// Regulation-driven risks of inaction
// ============================================================================

describe('ADR-PIPELINE-062 — regulation-driven risks of inaction', () => {
  it('pharma query adds FDA regulatory risk', () => {
    const ca = buildFallbackCompetitiveAnalysis(
      'Pharmaceutical batch release system with GxP compliance and cold chain monitoring.',
      fakeExtracted({ scenario_type: 'pharma-life-sciences' }) as never,
    );
    const hasReg = ca.risks_of_inaction.some(r =>
      /regulatory non-compliance/i.test(r.risk) && /FDA/i.test(r.risk),
    );
    expect(hasReg).toBe(true);
  });

  it('non-regulated scenario still emits risks (cost disadvantage)', () => {
    const ca = buildFallbackCompetitiveAnalysis(
      'Improve internal analytics dashboards.',
      fakeExtracted({ scenario_type: 'data-analytics' }) as never,
    );
    const hasCost = ca.risks_of_inaction.some(r => /cost disadvantage/i.test(r.risk));
    expect(hasCost).toBe(true);
  });

  it('every risk has risk, driver, and timeframe fields populated', () => {
    const ca = buildFallbackCompetitiveAnalysis(
      'sustainability strategy',
      fakeExtracted() as never,
    );
    for (const r of ca.risks_of_inaction) {
      expect(r.risk.length).toBeGreaterThan(0);
      expect(r.driver.length).toBeGreaterThan(0);
      expect(r.timeframe.length).toBeGreaterThan(0);
    }
  });
});

// ============================================================================
// Sources
// ============================================================================

describe('ADR-PIPELINE-062 — sources', () => {
  it('includes a public evidence source for every peer firm', () => {
    const ca = buildFallbackCompetitiveAnalysis('sustainability', fakeExtracted() as never);
    for (const peer of ca.peer_firms) {
      expect(peer.public_evidence_source.length).toBeGreaterThan(5);
    }
    expect(ca.sources.length).toBeGreaterThanOrEqual(ca.peer_firms.length);
  });
});

// ============================================================================
// renderExecutiveSummary integration
// ============================================================================

describe('ADR-PIPELINE-062 — renderExecutiveSummary integration', () => {
  it('emits "## Competitive Position" heading for every query', () => {
    const output = renderExecutiveSummary(
      'sustainability analysis across 100 buildings',
      null,
      [],
    );
    expect(output).toContain('## Competitive Position');
  });

  it('emits the capability maturity comparison heading', () => {
    const output = renderExecutiveSummary(
      'supply chain risk analysis',
      null,
      [],
    );
    expect(output).toContain('### Capability Maturity Comparison');
  });

  it('emits the Gap-to-Close Summary subsection', () => {
    const output = renderExecutiveSummary(
      'healthcare clinical decision support',
      null,
      [],
    );
    expect(output).toContain('### Gap-to-Close Summary');
  });

  it('emits the Cost of Inaction subsection', () => {
    const output = renderExecutiveSummary(
      'finance compliance automation',
      null,
      [],
    );
    expect(output).toContain('### Cost of Inaction');
  });

  it('emits at least one capability table row with maturity labels', () => {
    const output = renderExecutiveSummary(
      'sustainability strategy',
      null,
      [],
    );
    // Labels from maturityLabel(): None, Manual, Rule-Based, Automated, AI-Optimized
    expect(output).toMatch(/\| (Manual|Rule-Based|Automated|AI-Optimized) \|/);
  });

  it('works for unknown scenario types via fallback', () => {
    const output = renderExecutiveSummary(
      'a totally unusual query that has no domain keywords',
      null,
      [],
    );
    expect(output).toContain('## Competitive Position');
    expect(output).toContain('Deloitte');
  });
});

// ============================================================================
// simulate_create prompt extension
// ============================================================================

describe('ADR-PIPELINE-062 — simulate_create prompt extension', () => {
  it('prompts/index.ts source contains section 10 competitive_analysis spec', () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), 'src/synthesis/prompts/index.ts'),
      'utf-8',
    );
    expect(source).toContain('10. competitive_analysis:');
    expect(source).toContain('peer_firms[]');
    expect(source).toContain('capability_maturity[]');
    expect(source).toContain('gap_to_close[]');
    expect(source).toContain('risks_of_inaction[]');
    // Must reference the maturity level enum
    expect(source).toContain('ai_optimized');
    expect(source).toContain('rule_based');
  });

  it('prompts/index.ts requires peers to be real companies with cited sources', () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), 'src/synthesis/prompts/index.ts'),
      'utf-8',
    );
    expect(source).toMatch(/REAL companies/);
    expect(source).toContain('public_evidence_source');
  });
});

// ============================================================================
// Source regression
// ============================================================================

describe('ADR-PIPELINE-062 — simulation-renderers.ts regression', () => {
  it('exports the competitive analysis public API', () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), 'src/synthesis/simulation-renderers.ts'),
      'utf-8',
    );
    expect(source).toContain('export function buildFallbackCompetitiveAnalysis');
    expect(source).toContain('export interface CompetitiveAnalysis');
    expect(source).toContain('export interface PeerFirm');
    expect(source).toContain('export interface CapabilityMaturityRow');
    expect(source).toContain('export interface RiskOfInaction');
    expect(source).toContain('export type MaturityLevel');
  });

  it('renderExecutiveSummary calls getOrBuildCompetitiveAnalysis', () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), 'src/synthesis/simulation-renderers.ts'),
      'utf-8',
    );
    expect(source).toContain('getOrBuildCompetitiveAnalysis(query, simData, extracted)');
    expect(source).toContain('renderCompetitiveSection(competitiveAnalysis)');
  });

  // Suppress unused-import lint for MaturityLevel and CompetitiveAnalysis imports
  it('imports MaturityLevel and CompetitiveAnalysis type exports (for type-only usage)', () => {
    const m: MaturityLevel = 'automated';
    const c: CompetitiveAnalysis = buildFallbackCompetitiveAnalysis('x', fakeExtracted() as never);
    expect(m).toBe('automated');
    expect(c.peer_firms.length).toBeGreaterThan(0);
  });
});
