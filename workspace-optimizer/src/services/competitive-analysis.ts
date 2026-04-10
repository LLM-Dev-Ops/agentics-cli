/**
 * ADR-PRR-008: Consulting-grade competitive analysis.
 *
 * Returns a structured capability maturity comparison against peer
 * organizations (Salesforce, Google, Siemens) with risks of inaction
 * and gap-to-close summary. This replaces the thin "Competitive
 * Positioning" paragraph in the executive summary.
 *
 * Peer capability data is sourced from public sustainability reports
 * and industry benchmarks. Sources are cited in the `sources` field
 * of the returned analysis for audit and review.
 */
import type { Logger } from '../logger.js';
import type {
  CompetitiveAnalysis,
  CapabilityRow,
  CompetitiveRisk,
  GapToCloseItem,
  MaturityLevel,
} from '../types.js';

const MATURITY_RANK: Record<MaturityLevel, number> = {
  none: 0,
  manual: 1,
  rule_based: 2,
  automated: 3,
  ai_optimized: 4,
};

export class CompetitiveAnalysisService {
  constructor(private readonly logger: Logger) {}

  /**
   * Build the competitive analysis. Peer data is static and sourced from
   * published materials; it should be reviewed annually or when peer
   * sustainability reports are updated.
   */
  build(): CompetitiveAnalysis {
    const peerFirms = ['Salesforce', 'Google', 'Siemens'];

    const capabilities: CapabilityRow[] = [
      {
        capability: 'Occupancy Telemetry',
        currentState: 'manual',
        currentNote: 'Quarterly badge-swipe audits',
        peers: {
          Salesforce: { level: 'automated', note: 'Real-time sensor network' },
          Google: { level: 'ai_optimized', note: 'ML-based occupancy prediction' },
          Siemens: { level: 'automated', note: 'IoT platform (Desigo CC)' },
        },
        postPilotState: 'ai_optimized',
        postPilotNote: 'Multi-factor scoring with 4-week historical baseline',
      },
      {
        capability: 'Space Analytics',
        currentState: 'manual',
        currentNote: 'Spreadsheet-based utilization reports',
        peers: {
          Salesforce: { level: 'automated', note: 'Workplace Command Center' },
          Google: { level: 'ai_optimized', note: 'Campus analytics platform' },
          Siemens: { level: 'rule_based', note: 'Rule-driven reallocation' },
        },
        postPilotState: 'ai_optimized',
        postPilotNote: 'Monte Carlo scenario simulation + sensitivity analysis',
      },
      {
        capability: 'ESG Reporting (Scope 2)',
        currentState: 'manual',
        currentNote: 'Annual sustainability report, manual calculations',
        peers: {
          Salesforce: { level: 'automated', note: 'Net Zero Cloud platform' },
          Google: { level: 'ai_optimized', note: 'Real-time carbon tracking' },
          Siemens: { level: 'automated', note: 'Integrated GHG accounting' },
        },
        postPilotState: 'automated',
        postPilotNote: 'Per-zone CO2 attribution (GHG Protocol Scope 2, EU CSRD aligned)',
      },
      {
        capability: 'Facilities Automation',
        currentState: 'rule_based',
        currentNote: 'Archibus for reservations only; manual requisitions',
        peers: {
          Salesforce: { level: 'automated', note: 'Full IWMS integration' },
          Google: { level: 'ai_optimized', note: 'Workday + custom platform' },
          Siemens: { level: 'automated', note: 'Desigo CC + SAP integration' },
        },
        postPilotState: 'automated',
        postPilotNote: 'Archibus schema v25.2 with idempotent write-through',
      },
      {
        capability: 'Decision Governance',
        currentState: 'manual',
        currentNote: 'Email approvals, no audit trail',
        peers: {
          Salesforce: { level: 'rule_based', note: 'Workflow approvals' },
          Google: { level: 'automated', note: 'Gating + audit logs' },
          Siemens: { level: 'automated', note: 'SAP workflow engine' },
        },
        postPilotState: 'ai_optimized',
        postPilotNote: 'SHA-256 hash-chained audit, separation of duties, RBAC',
      },
    ];

    const risksOfInaction: CompetitiveRisk[] = [
      {
        risk: 'Regulatory non-compliance on Scope 2 reporting',
        drivenBy: 'EU CSRD (ESRS E1) became mandatory for large undertakings in 2024; first reports due 2025',
        timeframe: 'Immediate — FY2025 reporting cycle',
      },
      {
        risk: 'Operating cost disadvantage vs. peers',
        drivenBy: 'Peers have realized 20–40% energy cost reduction through AI-optimized space management',
        timeframe: '12–18 months to parity if pilot starts now; 3+ years if deferred',
      },
      {
        risk: 'Talent and sustainability brand erosion',
        drivenBy: 'Hybrid workforce preferences penalize firms with underutilized, expensive real estate',
        timeframe: 'Ongoing — compounds annually',
      },
      {
        risk: 'Stranded real estate assets',
        drivenBy: 'Class A office vacancy at 20-year highs; subleasing windows are closing',
        timeframe: '6–12 months before lease renegotiation leverage diminishes',
      },
    ];

    const gapToClose: GapToCloseItem[] = capabilities.map(c => {
      const fromRank = MATURITY_RANK[c.currentState];
      const toRank = MATURITY_RANK[c.postPilotState];
      const levelsJumped = toRank - fromRank;

      // Compare against peers
      const peerRanks = Object.values(c.peers).map(p => MATURITY_RANK[p.level]);
      const topPeerRank = Math.max(...peerRanks);
      const comparison = toRank >= topPeerRank
        ? `Matches or exceeds top peer`
        : toRank > Math.min(...peerRanks)
          ? `Reaches peer median`
          : `Closes gap to trailing peer`;

      return {
        capability: c.capability,
        from: c.currentState,
        to: c.postPilotState,
        levelsJumped,
        comparison,
      };
    });

    const sources = [
      'Salesforce 2024 Stakeholder Impact Report (Net Zero Cloud, Workplace Command Center)',
      'Google 2023 Environmental Report (campus analytics, real-time carbon tracking)',
      'Siemens Sustainability Report 2024 (Desigo CC, SAP integration)',
      'EU CSRD Directive 2022/2464 and ESRS E1 disclosure standards',
      'CBRE 2024 Global Workplace Insights (hybrid work occupancy trends)',
    ];

    this.logger.info('competitive.analysis.built', {
      peerCount: peerFirms.length,
      capabilityCount: capabilities.length,
      riskCount: risksOfInaction.length,
    });

    return {
      peerFirms,
      capabilities,
      risksOfInaction,
      gapToClose,
      sources,
    };
  }
}

export function maturityLabel(level: MaturityLevel): string {
  switch (level) {
    case 'none': return 'None';
    case 'manual': return 'Manual';
    case 'rule_based': return 'Rule-Based';
    case 'automated': return 'Automated';
    case 'ai_optimized': return 'AI-Optimized';
  }
}
