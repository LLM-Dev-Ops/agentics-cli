/**
 * Phase 7 — Template-Family Field Mappers (ADR-PIPELINE-111 D4)
 *
 * The 87 deliverables collapse to 33 `templateId` families. Rather than a
 * hand-coded projection per report (87×) or a single generic synthesizer
 * (which produced undifferentiated prose), each family carries a small,
 * data-only spec: what that document type is *for* and which agent outputs
 * inform it. The LLM field-writer (`field-writer.ts`) consumes the spec to
 * produce report-type-specific, grounded field values.
 *
 * This file is pure data + lookups — no I/O, no LLM calls, no template logic.
 */

export interface FamilySpec {
  /** templateId this spec covers (matches DeliverableSpec.templateId). */
  readonly templateId: string;
  /** Human label for the document family. */
  readonly label: string;
  /**
   * One-paragraph instruction describing what THIS document type must deliver.
   * Fed verbatim into the field-writer prompt so the LLM fills placeholders in
   * a way appropriate to the family (a Risk Register reads differently from a
   * Market Research Report even when both draw on the same run artifacts).
   */
  readonly focus: string;
  /**
   * Domain/agent kinds whose structured output is most relevant to this
   * family. Used to (a) prioritise which `sourceAgents` outputs to surface to
   * the writer first and (b) document the intended data lineage. These are
   * matched against the row's `sourceAgents` (substring match on `domain` or
   * `domain/agent`).
   */
  readonly emphasizeAgents: ReadonlyArray<string>;
}

/**
 * Generic fallback used when a templateId has no explicit spec. Keeps the
 * writer functional for any future template without a registry edit.
 */
export const GENERIC_FAMILY_SPEC: FamilySpec = {
  templateId: '__generic__',
  label: 'Consulting Deliverable',
  focus:
    'Produce a clear, decision-grade consulting document. Fill each field with ' +
    'specific, evidence-backed content derived from the run artifacts and agent ' +
    'analysis. Be concrete and tied to the business context; never invent dollar ' +
    'figures — reuse the figures already provided in the document.',
  emphasizeAgents: ['platform', 'analytics-hub', 'copilot'],
};

const SPECS: ReadonlyArray<FamilySpec> = [
  {
    templateId: 'executive-summary',
    label: 'Executive Summary / Decision Memo',
    focus:
      'A board-level summary: the recommendation, the opportunity, key findings, ' +
      'financial impact, risk profile, and recommended next steps. Lead with the ' +
      'decision requested. Every claim ties to agent evidence; figures reuse the ' +
      'provided fcv values.',
    emphasizeAgents: ['platform/executive-summary', 'platform/decision-memo', 'analytics-hub/recommendation', 'platform/risk-score'],
  },
  {
    templateId: 'recommendation-paper',
    label: 'Recommendation Paper',
    focus:
      'A structured recommendation: the options considered, the chosen option and ' +
      'why, expected outcomes, and the implementation ask. Make the rationale and ' +
      'trade-offs explicit.',
    emphasizeAgents: ['analytics-hub/recommendation', 'analytics-hub/consensus', 'platform/decision'],
  },
  {
    templateId: 'board-deck',
    label: 'Board / Steering Committee Deck',
    focus:
      'Slide-style talking points for a board: situation, complication, ' +
      'recommendation, financials, risks, ask. Each field is a tight, presentable ' +
      'bullet block, not prose paragraphs.',
    emphasizeAgents: ['platform/executive-summary', 'platform/decision', 'analytics-hub/recommendation'],
  },
  {
    templateId: 'scenario-analysis',
    label: 'Scenario Analysis & Sensitivity',
    focus:
      'Scenario and sensitivity analysis: the variables driving outcomes, their ' +
      'ranges, decision trees / sensitivity tables, and which assumptions are ' +
      'load-bearing. Distinguish ranges from point estimates.',
    emphasizeAgents: ['simulator/what-if', 'simulator/scenario', 'platform/risk-score'],
  },
  {
    templateId: 'business-case-scenario',
    label: 'Business Case (Base / Best / Worst)',
    focus:
      'A scenario-weighted business case: assumptions, the investment, the ' +
      'expected benefits, and the net outcome for this scenario. Numbers are ' +
      'derived views of the canonical figures — never new origins.',
    emphasizeAgents: ['costops/roi', 'costops/forecast', 'simulator/scenario'],
  },
  {
    templateId: 'financial-model',
    label: 'Financial Model / ROI / Cost-Benefit / Unit Economics',
    focus:
      'A financial model view: cost-benefit breakdown, ROI / IRR / NPV / payback, ' +
      'and unit economics. ALL monetary values come from the provided canonical ' +
      'figures; show derivation, never invent. Narrate what the numbers mean.',
    emphasizeAgents: ['costops/roi', 'costops/attribution', 'costops/forecast', 'costops/tradeoff'],
  },
  {
    templateId: 'tco',
    label: 'Total Cost of Ownership',
    focus:
      'A TCO analysis: cost categories over the horizon, one-time vs recurring, ' +
      'and the cumulative total. Reuse canonical cost figures.',
    emphasizeAgents: ['costops/attribution', 'costops/forecast'],
  },
  {
    templateId: 'value-capture',
    label: 'Value Capture / Benefits Realization',
    focus:
      'A value-capture plan: the benefit streams, how each is measured, owners, ' +
      'and the realization timeline. Tie benefits to the canonical savings figures.',
    emphasizeAgents: ['costops/roi', 'research-lab/metrics', 'observatory/slo'],
  },
  {
    templateId: 'cost-reduction-plan',
    label: 'Cost Reduction / Optimization Plan',
    focus:
      'A cost-optimization plan: where cost is today, the optimization levers, the ' +
      'expected savings per lever, and the sequencing.',
    emphasizeAgents: ['costops/attribution', 'costops/tradeoff', 'auto-optimizer/token', 'auto-optimizer/model-select'],
  },
  {
    templateId: 'strategy-doc',
    label: 'Strategy Document',
    focus:
      'A strategy document for the specific strategy kind: the strategic context, ' +
      'objectives, the chosen approach, and the execution implications. Be ' +
      'specific to the strategy kind named in the title.',
    emphasizeAgents: ['platform/decision', 'research-lab/hypothesis', 'analytics-hub/recommendation'],
  },
  {
    templateId: 'transformation-blueprint',
    label: 'Transformation / Roadmap Blueprint',
    focus:
      'A transformation roadmap: the target state, the phased path to it, ' +
      'milestones with absolute dates, and dependencies. Anchor dates to the ' +
      'pilot-start anchor in the roadmap artifact.',
    emphasizeAgents: ['orchestrator/workflow', 'orchestrator/dependencies', 'platform/decision'],
  },
  {
    templateId: 'operating-model-design',
    label: 'Operating Model Design',
    focus:
      'A target operating model: capabilities, the org-and-process shape, ' +
      'governance, and the operating rhythm.',
    emphasizeAgents: ['orchestrator/workflow', 'governance-dashboard/oversight'],
  },
  {
    templateId: 'capability-maturity',
    label: 'Capability Maturity Assessment',
    focus:
      'A maturity assessment: the capability dimensions, current vs target level ' +
      'per dimension, and the gaps to close.',
    emphasizeAgents: ['observatory/health-check', 'research-lab/metrics'],
  },
  {
    templateId: 'target-state-architecture',
    label: 'Target-State / Integration Architecture',
    focus:
      'A target architecture: the component blueprint, integration points, and the ' +
      'current→target delta. Ground in the integration assessment.',
    emphasizeAgents: ['connector-hub/event-normalize', 'connector-hub/erp-surface', 'edge/tool-invoke'],
  },
  {
    templateId: 'org-structure',
    label: 'Org Structure / Workforce / Resource Plan',
    focus:
      'An org and resourcing plan: roles and reporting lines, the workforce/talent ' +
      'needs, and the resource plan to staff the initiative.',
    emphasizeAgents: ['orchestrator/scheduler', 'orchestrator/parallel'],
  },
  {
    templateId: 'raci',
    label: 'RACI Matrix',
    focus:
      'A RACI matrix: the key activities, and Responsible/Accountable/Consulted/' +
      'Informed assignments per activity. Output a clean table.',
    emphasizeAgents: ['orchestrator/workflow', 'governance-dashboard/oversight'],
  },
  {
    templateId: 'process-maps',
    label: 'Process Maps (L2–L5) / Service Delivery',
    focus:
      'Process maps: the end-to-end process steps at the requested level, hand-offs, ' +
      'and the service-delivery model.',
    emphasizeAgents: ['orchestrator/workflow', 'orchestrator/state-machine'],
  },
  {
    templateId: 'performance-dashboard',
    label: 'KPI / OKR / Performance Dashboard / Scorecards',
    focus:
      'A performance measurement design: the KPIs/OKRs, their definitions and ' +
      'targets, the SLA/KPI thresholds, and the dashboard/scorecard layout.',
    emphasizeAgents: ['observatory/slo', 'observatory/telemetry', 'research-lab/metrics'],
  },
  {
    templateId: 'vendor-strategy',
    label: 'Vendor / Partner Strategy & Scorecards',
    focus:
      'A vendor/partner strategy: selection criteria, the evaluation scorecard, and ' +
      'the partnering recommendation.',
    emphasizeAgents: ['platform/decision', 'analytics-hub/recommendation'],
  },
  {
    templateId: 'platform-selection',
    label: 'Platform Selection / Build-vs-Buy / ML Eval',
    focus:
      'A platform/option evaluation: the options, the weighted scoring against ' +
      'criteria, build-vs-buy-vs-partner, and the selection with rationale.',
    emphasizeAgents: ['inference-gateway/route', 'test-bench/compare', 'platform/decision'],
  },
  {
    templateId: 'data-strategy',
    label: 'Data Strategy & Data Model',
    focus:
      'A data strategy: the data domains, the target data model, governance, and ' +
      'the data quality / lineage approach.',
    emphasizeAgents: ['memory-graph/knowledge-graph', 'memory-graph/lineage', 'connector-hub/database-query'],
  },
  {
    templateId: 'risk-register',
    label: 'Risk Register / Mitigation / Cyber Risk',
    focus:
      'A risk register: enumerated risks with likelihood × impact, scoring, the ' +
      'mitigation plan and owner per risk. Output a structured risk table.',
    emphasizeAgents: ['platform/risk-score', 'sentinel/anomaly', 'shield/safety-boundary'],
  },
  {
    templateId: 'regulatory-impact',
    label: 'Regulatory / Compliance / Audit / Responsible-AI',
    focus:
      'A compliance assessment: the applicable obligations, the impact, the control ' +
      'framework, audit-readiness, and any responsible-AI considerations.',
    emphasizeAgents: ['governance-dashboard/audit', 'policy-engine/enforce', 'shield/pii', 'data-vault/access-control'],
  },
  {
    templateId: 'research-report',
    label: 'Market Research / Segmentation / VoC / Benchmarking / SWOT-RCA',
    focus:
      'A research report for the specific research kind: the method, the findings, ' +
      'the segments/competitors/benchmarks/SWOT as applicable, and the implications.',
    emphasizeAgents: ['research-lab/hypothesis', 'research-lab/metrics', 'analytics-hub/recommendation'],
  },
  {
    templateId: 'internal-diagnostic',
    label: 'Internal Diagnostic Assessment',
    focus:
      'An internal diagnostic: current-state health across dimensions, the issues ' +
      'found, and the prioritised gaps.',
    emphasizeAgents: ['observatory/health-check', 'observatory/failures', 'sentinel/rca'],
  },
  {
    templateId: 'program-charter',
    label: 'Program Charter',
    focus:
      'A program charter: objectives, scope, governance, stakeholders, and success ' +
      'criteria.',
    emphasizeAgents: ['orchestrator/workflow', 'governance-dashboard/oversight'],
  },
  {
    templateId: 'pmo-framework',
    label: 'PMO / Milestone / Dependency / Budget / Comms',
    focus:
      'A program-management artifact: the PMO operating framework, milestones with ' +
      'dates, the dependency map, budget plan, or communication plan as the slug ' +
      'indicates.',
    emphasizeAgents: ['orchestrator/scheduler', 'orchestrator/dependencies', 'incident-manager/hitl'],
  },
  {
    templateId: 'implementation-roadmap',
    label: 'Implementation Roadmap / Backlog / Delivery',
    focus:
      'An implementation plan: the roadmap, the initiative backlog/WBS, and the ' +
      'delivery sequencing with dependencies.',
    emphasizeAgents: ['orchestrator/workflow', 'orchestrator/dependencies', 'orchestrator/parallel'],
  },
  {
    templateId: 'deployment-plan',
    label: 'Delivery / Release / Pilot / Deployment / Hypercare',
    focus:
      'A delivery/deployment artifact: the release plan, pilot/MVP definition, ' +
      'deployment steps, and hypercare/support as the slug indicates.',
    emphasizeAgents: ['edge/failover', 'edge/circuit-breaker', 'incident-manager/escalation'],
  },
  {
    templateId: 'testing-strategy',
    label: 'Testing Strategy',
    focus:
      'A testing strategy: the test levels, coverage targets, environments, and the ' +
      'quality gates.',
    emphasizeAgents: ['test-bench/benchmark', 'test-bench/regression', 'test-bench/quality'],
  },
  {
    templateId: 'continuous-improvement',
    label: 'Continuous Improvement / Post-Implementation Review',
    focus:
      'A continuous-improvement artifact: the improvement loop, the metrics ' +
      'reviewed, lessons learned, and the post-implementation review findings.',
    emphasizeAgents: ['observatory/usage-patterns', 'research-lab/metrics', 'auto-optimizer/self-optimize'],
  },
  {
    templateId: 'rfp-response',
    label: 'RFP/RFQ/RFI Response / Commercial Model',
    focus:
      'A commercial response: the requirement responses, the commercial/pricing ' +
      'model, and the contracting position.',
    emphasizeAgents: ['costops/tradeoff', 'platform/decision'],
  },
  {
    templateId: 'digital-twin',
    label: 'Digital Twin / Experimentation Framework',
    focus:
      'A digital-twin / experimentation artifact: the model of the system, the ' +
      'experiments to run, and the metrics that decide them.',
    emphasizeAgents: ['simulator/what-if', 'simulator/scenario', 'research-lab/hypothesis'],
  },
];

const BY_TEMPLATE_ID: ReadonlyMap<string, FamilySpec> = new Map(
  SPECS.map((s) => [s.templateId, s]),
);

/** Resolve the family spec for a templateId, falling back to the generic spec. */
export function getFamilySpec(templateId: string): FamilySpec {
  return BY_TEMPLATE_ID.get(templateId) ?? GENERIC_FAMILY_SPEC;
}

/** All explicitly-registered template families (excludes the generic fallback). */
export function registeredFamilyIds(): string[] {
  return [...BY_TEMPLATE_ID.keys()];
}
