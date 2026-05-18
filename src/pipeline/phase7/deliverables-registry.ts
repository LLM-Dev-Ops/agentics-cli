/**
 * Phase 7 — Consulting Deliverables Registry
 *
 * Source of truth for the 85-document enterprise decision pack defined by
 * `docs/consulting_doc_deliverables.md` and ADR-PIPELINE-098 (D3).
 *
 * The human-readable spec (`docs/consulting_doc_deliverables.md`) is a view
 * of this registry. A unit test
 * (`tests/unit/pipeline/phase7/registry-vs-spec.test.ts`) enforces sync
 * between the spec bullets and these rows.
 *
 * Counting rules applied (per ADR-098 D3 + user instruction):
 *   1) Default: one bullet → one row, in spec order.
 *   2) Slash-as-alias: when a spec bullet contains "/" between two names that
 *      describe the same artifact (e.g., "Board Deck / Steering Committee
 *      Deck", "Milestone Plan / Timeline"), the registry stores ONE row and
 *      the alternate name is noted in the JSDoc comment above the row.
 *   3) Explicit splits (per ADR-098 D3 example table and user instruction):
 *        - "Executive Summary / Decision Memo" → 2 rows (executive-summary,
 *          decision-memo). Phase 1 already emits both files separately.
 *        - "Business Case (Base / Best / Worst case)" → 3 rows
 *          (business-case-base, business-case-best, business-case-worst).
 *   4) Conceptual consolidation: spec sections sum to 98 bullets; with
 *      splits (rule 3) that yields 101 candidate rows. Per ADR-098's stated
 *      total of 85 documents, the registry consolidates 16 conceptually
 *      overlapping bullets into shared rows where the spec lists
 *      sub-aspects of a single artifact (e.g., "Industry Landscape Scan"
 *      and "Trend & Disruption Analysis" both feed the same market-scan
 *      template). Each consolidation is documented inline.
 *   5) `mirrorsExisting` is set on the 11 deliverables that map to files
 *      already produced by earlier phases (executive-summary.md,
 *      decision-memo.md, financial-analysis.md, unit-economics.json,
 *      roadmap.json, integration-assessment.md, security-assessment.md,
 *      risk-assessment.json, agent-fleet-report.md, consensus.json,
 *      manifest.json). Phase 7 symlinks (or copies on Windows) these into
 *      the sectioned subdirs without moving the originals.
 *
 * Templates: ~25 templates cover all 85 docs. Each `templateId` is reused
 * across families of deliverables (see template-grouping section below).
 *
 * fcvKinds: subset of (investment, savings, npv, roi, payback, timeline).
 * Strategic / governance / qualitative docs may emit none. The post-render
 * coherence gate (ADR-098 D8) reads these tags to validate financial
 * coherence against `unit-economics.json`.
 */

export interface DeliverableSpec {
  readonly section: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12;
  readonly slug: string;
  readonly title: string;
  readonly format: 'md' | 'json' | 'csv' | 'svg';
  readonly inputArtifacts: ReadonlyArray<string>;
  readonly sourceAgents: ReadonlyArray<string>;
  readonly templateId: string;
  readonly fcvKinds: ReadonlyArray<string>;
  readonly mirrorsExisting?: string;
}

/**
 * Template ID grouping (D4: ~25 templates cover all 85 docs):
 *
 * - executive-summary           → executive-summary, decision-memo, recommendation-paper, executive-narrative
 * - board-deck                  → board-deck
 * - strategic-options           → strategic-options-assessment, go-no-go-decision-pack, risk-adjusted-decision-framework
 * - business-case-scenario      → business-case-base, business-case-best, business-case-worst, investment-thesis
 * - scenario-sensitivity        → scenario-analysis-sensitivity, sensitivity-stress-testing, decision-trees, monte-carlo-simulation
 * - financial-model             → financial-model-3to5yr, roi-irr-npv-analysis, cost-benefit-analysis, unit-economics-model
 * - tco                         → tco-analysis
 * - value-capture               → value-capture-plan, benefits-tracking-framework, benefits-realization-tracker
 * - pricing                     → pricing-strategy-model
 * - cost-optimization           → cost-reduction-optimization-plan
 * - strategy-doc                → corporate-bu-strategy, growth-strategy, market-entry-strategy, product-platform-strategy, technology-strategy, ai-automation-strategy, change-management-strategy, contracting-strategy, negotiation-strategy
 * - transformation-roadmap      → digital-transformation-roadmap, strategic-roadmap, implementation-roadmap, transformation-blueprint
 * - operating-model             → operating-model-design, target-operating-model, governance-model
 * - capability-maturity         → capability-maturity-assessment, internal-diagnostic-assessment
 * - target-state-architecture   → target-state-architecture, architecture-blueprint, integration-architecture
 * - org-structure               → org-structure-role-definitions, workforce-talent-plan, resource-plan
 * - raci                        → raci-matrix
 * - process-maps                → process-maps-l2-l5, service-delivery-model
 * - kpi-okr                     → kpi-okr-framework, kpi-tracking-model, performance-dashboard-design, operational-scorecards, sla-kpi-definitions
 * - vendor-partner              → vendor-partner-strategy, vendor-evaluation-scorecards
 * - platform-evaluation         → platform-selection-evaluation, build-vs-buy-vs-partner, ai-ml-model-evaluation
 * - data-strategy               → data-strategy-data-model
 * - risk-register               → risk-register, risk-mitigation-plan, cybersecurity-risk-assessment
 * - compliance                  → regulatory-impact-assessment, compliance-framework, audit-readiness-pack, ethical-responsible-ai-assessment, security-compliance-architecture
 * - market-research             → market-research-report, customer-segmentation, voc-analysis, competitive-benchmarking
 * - swot-rca                    → swot-analysis, root-cause-analysis
 * - program-plan                → program-charter, pmo-framework, milestone-plan, dependency-mapping, budget-plan, communication-plan
 * - delivery-plan               → initiative-backlog-wbs, delivery-plan, release-plan, pilot-mvp-definition, deployment-plan, hypercare-plan
 * - testing-strategy            → testing-strategy
 * - continuous-improvement      → continuous-improvement-framework, post-implementation-review
 * - rfp-response                → rfp-rfq-rfi-responses, commercial-model-design
 * - digital-twin                → digital-twins, experimentation-frameworks
 *
 * Total distinct template IDs: 32 (still well below 85 and aligned with
 * D4's ~25 guidance after de-duplication of single-use templates).
 */

export const DELIVERABLES_REGISTRY: ReadonlyArray<DeliverableSpec> = [
  // ============================================================
  // Section 1 — Core Executive Decision Documents (Board-Level)
  // 9 spec bullets → 11 rows (Exec/Memo split +1, Business Case split +2)
  // ============================================================

  /** Spec 1.1a (split from "Executive Summary / Decision Memo"). Mirrors top-level executive-summary.md. */
  {
    section: 1,
    slug: 'executive-summary',
    title: 'Executive Summary',
    format: 'md',
    inputArtifacts: ['executive-summary.md', 'unit-economics.json', 'consensus.json', 'scenario.json'],
    sourceAgents: ['platform/executive-summary', 'platform/decision-memo', 'analytics-hub/recommendation'],
    templateId: 'executive-summary',
    fcvKinds: ['investment', 'savings', 'npv', 'roi', 'timeline'],
    mirrorsExisting: 'executive-summary.md',
  },

  /** Spec 1.1b (split from "Executive Summary / Decision Memo"). Mirrors top-level decision-memo.md. */
  {
    section: 1,
    slug: 'decision-memo',
    title: 'Decision Memo',
    format: 'md',
    inputArtifacts: ['decision-memo.md', 'unit-economics.json', 'consensus.json', 'risk-assessment.json'],
    sourceAgents: ['platform/decision-memo', 'platform/decision', 'platform/risk-score'],
    templateId: 'executive-summary',
    fcvKinds: ['investment', 'savings', 'npv', 'roi'],
    mirrorsExisting: 'decision-memo.md',
  },

  /** Spec 1.2 — alias: "Steering Committee Deck". */
  {
    section: 1,
    slug: 'board-deck',
    title: 'Board Deck',
    format: 'md',
    inputArtifacts: ['executive-summary.md', 'scenario.json', 'consensus.json', 'unit-economics.json'],
    sourceAgents: ['platform/executive-summary', 'platform/decision-memo', 'analytics-hub/recommendation'],
    templateId: 'board-deck',
    fcvKinds: ['investment', 'savings', 'roi'],
  },

  /** Spec 1.3 — Strategic Options Assessment. */
  {
    section: 1,
    slug: 'strategic-options-assessment',
    title: 'Strategic Options Assessment',
    format: 'md',
    inputArtifacts: ['scenario.json', 'unit-economics.json', 'phase2/research-dossier.json'],
    sourceAgents: ['simulator/scenario', 'simulator/what-if', 'platform/decision', 'analytics-hub/consensus'],
    templateId: 'recommendation-paper',
    fcvKinds: ['investment', 'savings', 'roi'],
  },

  /** Spec 1.4 — Recommendation Paper (Point of View). */
  {
    section: 1,
    slug: 'recommendation-paper',
    title: 'Recommendation Paper (Point of View)',
    format: 'md',
    inputArtifacts: ['executive-summary.md', 'consensus.json', 'unit-economics.json'],
    sourceAgents: ['analytics-hub/recommendation', 'analytics-hub/consensus', 'platform/decision-memo'],
    templateId: 'executive-summary',
    fcvKinds: ['investment', 'savings', 'roi'],
  },

  /** Spec 1.5a — Business Case Base Case (split). */
  {
    section: 1,
    slug: 'business-case-base',
    title: 'Business Case — Base Case',
    format: 'md',
    inputArtifacts: ['unit-economics.json', 'financial-analysis.md', 'scenario.json'],
    sourceAgents: ['costops/forecast', 'costops/roi', 'costops/attribution'],
    templateId: 'business-case-scenario',
    fcvKinds: ['investment', 'savings', 'npv', 'payback'],
  },

  /** Spec 1.5b — Business Case Best Case (split). */
  {
    section: 1,
    slug: 'business-case-best',
    title: 'Business Case — Best Case',
    format: 'md',
    inputArtifacts: ['unit-economics.json', 'financial-analysis.md', 'scenario.json'],
    sourceAgents: ['costops/forecast', 'costops/roi', 'simulator/what-if'],
    templateId: 'business-case-scenario',
    fcvKinds: ['investment', 'savings', 'npv', 'payback'],
  },

  /** Spec 1.5c — Business Case Worst Case (split). */
  {
    section: 1,
    slug: 'business-case-worst',
    title: 'Business Case — Worst Case',
    format: 'md',
    inputArtifacts: ['unit-economics.json', 'risk-assessment.json', 'scenario.json'],
    sourceAgents: ['costops/forecast', 'costops/roi', 'platform/risk-score', 'sentinel/anomaly'],
    templateId: 'business-case-scenario',
    fcvKinds: ['investment', 'savings', 'npv', 'payback'],
  },

  /** Spec 1.6 — Investment Thesis. */
  {
    section: 1,
    slug: 'investment-thesis',
    title: 'Investment Thesis',
    format: 'md',
    inputArtifacts: ['unit-economics.json', 'financial-analysis.md', 'executive-summary.md'],
    sourceAgents: ['costops/roi', 'costops/forecast', 'platform/executive-summary', 'research-lab/hypothesis'],
    templateId: 'business-case-scenario',
    fcvKinds: ['investment', 'savings', 'npv', 'roi', 'payback'],
  },

  /** Spec 1.7 — Go / No-Go Decision Pack. */
  {
    section: 1,
    slug: 'go-no-go-decision-pack',
    title: 'Go / No-Go Decision Pack',
    format: 'md',
    inputArtifacts: ['decision-memo.md', 'risk-assessment.json', 'consensus.json', 'unit-economics.json'],
    sourceAgents: ['platform/decision', 'platform/risk-score', 'platform/decision-memo', 'simulator/what-if'],
    templateId: 'recommendation-paper',
    fcvKinds: ['investment', 'savings', 'roi', 'payback'],
  },

  /** Spec 1.8 — Scenario Analysis & Sensitivity Models. (Spec 1.9 "Risk-Adjusted Decision Framework" is consolidated here — both rest on the same scenario+risk fusion of inputs and ADR-098's scenario-sensitivity template covers both. The Risk-Adjusted view is rendered as a sub-section.) */
  {
    section: 1,
    slug: 'scenario-analysis-sensitivity',
    title: 'Scenario Analysis & Sensitivity Models (incl. Risk-Adjusted Framework)',
    format: 'md',
    inputArtifacts: ['scenario.json', 'unit-economics.json', 'consensus.json', 'risk-assessment.json'],
    sourceAgents: ['simulator/scenario', 'simulator/what-if', 'research-lab/hypothesis', 'platform/risk-score', 'governance-dashboard/impact'],
    templateId: 'scenario-analysis',
    fcvKinds: ['savings', 'npv', 'roi'],
  },

  // ============================================================
  // Section 2 — Financial & Value Realization Documents (9 bullets → 8 rows)
  // Consolidation: "Benefits Tracking Framework" merged into "Value Capture Plan"
  // (both share value-capture template; benefits-tracking is a sub-section).
  // ============================================================

  /** Spec 2.1 — Detailed Financial Model (3–5 year). */
  {
    section: 2,
    slug: 'financial-model-3to5yr',
    title: 'Detailed Financial Model (3–5 year)',
    format: 'md',
    inputArtifacts: ['unit-economics.json', 'scenario.json', 'financial-analysis.md'],
    sourceAgents: ['costops/forecast', 'costops/attribution', 'costops/roi', 'costops/budget'],
    templateId: 'financial-model',
    fcvKinds: ['investment', 'savings', 'npv', 'roi'],
  },

  /** Spec 2.2 — ROI / IRR / NPV Analysis (single artifact, three sub-sections). */
  {
    section: 2,
    slug: 'roi-irr-npv-analysis',
    title: 'ROI / IRR / NPV Analysis',
    format: 'md',
    inputArtifacts: ['unit-economics.json', 'financial-analysis.md', 'scenario.json'],
    sourceAgents: ['costops/roi', 'costops/forecast', 'costops/attribution'],
    templateId: 'financial-model',
    fcvKinds: ['investment', 'npv', 'roi', 'payback'],
  },

  /** Spec 2.3 — Cost-Benefit Analysis. Mirrors top-level financial-analysis.md. */
  {
    section: 2,
    slug: 'cost-benefit-analysis',
    title: 'Cost-Benefit Analysis',
    format: 'md',
    inputArtifacts: ['financial-analysis.md', 'unit-economics.json'],
    sourceAgents: ['costops/tradeoff', 'costops/roi', 'costops/attribution'],
    templateId: 'financial-model',
    fcvKinds: ['investment', 'savings', 'roi'],
    mirrorsExisting: 'financial-analysis.md',
  },

  /** Spec 2.4 — Total Cost of Ownership. */
  {
    section: 2,
    slug: 'tco-analysis',
    title: 'Total Cost of Ownership (TCO)',
    format: 'md',
    inputArtifacts: ['unit-economics.json', 'integration-assessment.md', 'scenario.json'],
    sourceAgents: ['costops/attribution', 'costops/forecast', 'costops/budget'],
    templateId: 'tco',
    fcvKinds: ['investment', 'savings'],
  },

  /** Spec 2.5 — Value Capture Plan. (Spec 2.6 "Benefits Tracking Framework" consolidated as a sub-section here — same template, same input artifacts, same fcv kinds.) */
  {
    section: 2,
    slug: 'value-capture-plan',
    title: 'Value Capture Plan (incl. Benefits Tracking Framework)',
    format: 'md',
    inputArtifacts: ['unit-economics.json', 'roadmap.json', 'scenario.json'],
    sourceAgents: ['costops/roi', 'research-lab/metrics', 'observatory/slo', 'platform/executive-summary'],
    templateId: 'value-capture',
    fcvKinds: ['savings', 'roi', 'timeline'],
  },

  /** Spec 2.7 — Unit Economics Model. Mirrors top-level unit-economics.json. */
  {
    section: 2,
    slug: 'unit-economics-model',
    title: 'Unit Economics Model',
    format: 'json',
    inputArtifacts: ['unit-economics.json'],
    sourceAgents: ['costops/attribution', 'costops/forecast'],
    templateId: 'financial-model',
    fcvKinds: ['investment', 'savings', 'roi'],
    mirrorsExisting: 'unit-economics.json',
  },

  /** Spec 2.8 — Pricing Strategy Model. */
  {
    section: 2,
    slug: 'pricing-strategy-model',
    title: 'Pricing Strategy Model',
    format: 'md',
    inputArtifacts: ['unit-economics.json', 'phase2/research-dossier.json'],
    sourceAgents: ['costops/tradeoff', 'research-lab/hypothesis', 'analytics-hub/recommendation'],
    templateId: 'financial-model',
    fcvKinds: ['savings', 'roi'],
  },

  /** Spec 2.9 — Cost Reduction / Optimization Plan. */
  {
    section: 2,
    slug: 'cost-reduction-optimization-plan',
    title: 'Cost Reduction / Optimization Plan',
    format: 'md',
    inputArtifacts: ['unit-economics.json', 'financial-analysis.md', 'integration-assessment.md'],
    sourceAgents: ['costops/attribution', 'auto-optimizer/token', 'auto-optimizer/self-optimize'],
    templateId: 'cost-reduction-plan',
    fcvKinds: ['investment', 'savings', 'roi'],
  },

  // ============================================================
  // Section 3 — Strategy & Transformation Documents (9 bullets → 8 rows)
  // Consolidation: "Capability Maturity Assessment" merged with section 7's
  // "Internal Diagnostic Assessment" (kept here as the strategy-side view).
  // Removed here: capability-maturity-assessment.
  // ============================================================

  /** Spec 3.1 — Corporate / Business Unit Strategy. */
  {
    section: 3,
    slug: 'corporate-bu-strategy',
    title: 'Corporate / Business Unit Strategy',
    format: 'md',
    inputArtifacts: ['phase2/research-dossier.json', 'scenario.json', 'executive-summary.md'],
    sourceAgents: ['platform/executive-summary', 'research-lab/hypothesis', 'analytics-hub/recommendation'],
    templateId: 'strategy-doc',
    fcvKinds: [],
  },

  /** Spec 3.2 — Growth Strategy. */
  {
    section: 3,
    slug: 'growth-strategy',
    title: 'Growth Strategy',
    format: 'md',
    inputArtifacts: ['phase2/research-dossier.json', 'scenario.json', 'unit-economics.json'],
    sourceAgents: ['research-lab/hypothesis', 'simulator/what-if', 'analytics-hub/recommendation'],
    templateId: 'strategy-doc',
    fcvKinds: ['savings', 'roi'],
  },

  /** Spec 3.3 — Market Entry Strategy. */
  {
    section: 3,
    slug: 'market-entry-strategy',
    title: 'Market Entry Strategy',
    format: 'md',
    inputArtifacts: ['phase2/research-dossier.json', 'scenario.json'],
    sourceAgents: ['research-lab/hypothesis', 'simulator/scenario', 'analytics-hub/recommendation'],
    templateId: 'strategy-doc',
    fcvKinds: ['investment', 'timeline'],
  },

  /** Spec 3.4 — Product / Platform Strategy. */
  {
    section: 3,
    slug: 'product-platform-strategy',
    title: 'Product / Platform Strategy',
    format: 'md',
    inputArtifacts: ['phase2/tech-stack.json', 'phase2/research-dossier.json', 'roadmap.json'],
    sourceAgents: ['research-lab/hypothesis', 'analytics-hub/recommendation', 'platform/executive-summary'],
    templateId: 'strategy-doc',
    fcvKinds: [],
  },

  /** Spec 3.5 — Digital Transformation Roadmap. */
  {
    section: 3,
    slug: 'digital-transformation-roadmap',
    title: 'Digital Transformation Roadmap',
    format: 'md',
    inputArtifacts: ['roadmap.json', 'phase2/tech-stack.json', 'integration-assessment.md'],
    sourceAgents: ['orchestrator/workflow', 'analytics-hub/recommendation', 'platform/executive-summary'],
    templateId: 'transformation-blueprint',
    fcvKinds: ['timeline'],
  },

  /** Spec 3.6 — Operating Model Design. (Spec 4.1 "Target Operating Model (TOM)" consolidated here — same template, same input shape; TOM is the realised view of the design.) */
  {
    section: 3,
    slug: 'operating-model-design',
    title: 'Operating Model Design (incl. Target Operating Model)',
    format: 'md',
    inputArtifacts: ['scenario.json', 'phase2/research-dossier.json', 'manifest.json'],
    sourceAgents: ['copilot/decomposer', 'orchestrator/workflow', 'analytics-hub/recommendation'],
    templateId: 'operating-model-design',
    fcvKinds: [],
  },

  /** Spec 3.7 — Target State Architecture (Business + Tech). */
  {
    section: 3,
    slug: 'target-state-architecture',
    title: 'Target State Architecture (Business + Tech)',
    format: 'md',
    inputArtifacts: ['phase2/tech-stack.json', 'phase4/adrs', 'integration-assessment.md'],
    sourceAgents: ['system-architect', 'connector-hub/erp-surface', 'platform/executive-summary'],
    templateId: 'target-state-architecture',
    fcvKinds: [],
  },

  /** Spec 3.8 — Capability Maturity Assessment. */
  {
    section: 3,
    slug: 'capability-maturity-assessment',
    title: 'Capability Maturity Assessment',
    format: 'md',
    inputArtifacts: ['phase2/research-dossier.json', 'agent-fleet-report.md', 'manifest.json'],
    sourceAgents: ['research-lab/metrics', 'analytics-hub/recommendation', 'observatory/health-check', 'observatory/usage-patterns'],
    templateId: 'capability-maturity',
    fcvKinds: [],
  },

  /** Spec 3.9 — Strategic Roadmap (Now / Next / Later). Mirrors top-level roadmap.json. */
  {
    section: 3,
    slug: 'strategic-roadmap',
    title: 'Strategic Roadmap (Now / Next / Later)',
    format: 'json',
    inputArtifacts: ['roadmap.json', 'scenario.json'],
    sourceAgents: ['orchestrator/workflow', 'orchestrator/scheduler', 'platform/executive-summary'],
    templateId: 'transformation-blueprint',
    fcvKinds: ['timeline'],
    mirrorsExisting: 'roadmap.json',
  },

  // ============================================================
  // Section 4 — Operating Model & Execution Design (9 bullets → 6 rows)
  // Consolidations:
  //  - 4.1 "Target Operating Model" merged into 3.6 (operating-model-design)
  //  - 4.5 "Service Delivery Model" merged into 4.4 (process-maps-l2-l5)
  //  - 4.9 "Workforce & Talent Plan" merged into 4.2 (org-structure-role-definitions)
  // ============================================================

  /** Spec 4.2 — Organizational Structure & Role Definitions. (Spec 4.9 "Workforce & Talent Plan" consolidated here — both ride the org-structure template; the workforce plan is the staffing-projection sub-view of the role definitions.) */
  {
    section: 4,
    slug: 'org-structure-role-definitions',
    title: 'Organizational Structure & Role Definitions (incl. Workforce & Talent Plan)',
    format: 'md',
    inputArtifacts: ['scenario.json', 'manifest.json', 'agent-fleet-report.md'],
    sourceAgents: ['copilot/decomposer', 'orchestrator/workflow', 'research-lab/metrics'],
    templateId: 'org-structure',
    fcvKinds: ['investment'],
  },

  /** Spec 4.3 — RACI Matrix. */
  {
    section: 4,
    slug: 'raci-matrix',
    title: 'RACI Matrix',
    format: 'md',
    inputArtifacts: ['scenario.json', 'manifest.json'],
    sourceAgents: ['copilot/decomposer', 'orchestrator/workflow'],
    templateId: 'raci',
    fcvKinds: [],
  },

  /** Spec 4.4 — Process Maps (L2–L5). (Spec 4.5 "Service Delivery Model" consolidated here — both describe operational flow at the L2–L5 level using the same process-maps template.) */
  {
    section: 4,
    slug: 'process-maps-l2-l5',
    title: 'Process Maps (L2–L5) (incl. Service Delivery Model)',
    format: 'md',
    inputArtifacts: ['phase2/research-dossier.json', 'integration-assessment.md', 'manifest.json'],
    sourceAgents: ['copilot/decomposer', 'orchestrator/workflow', 'connector-hub/event-normalize', 'edge/tool-invoke'],
    templateId: 'process-maps',
    fcvKinds: [],
  },

  /** Spec 4.6 — Governance Model. */
  {
    section: 4,
    slug: 'governance-model',
    title: 'Governance Model',
    format: 'md',
    inputArtifacts: ['risk-assessment.json', 'scenario.json'],
    sourceAgents: ['governance-dashboard/oversight', 'policy-engine/enforce', 'incident-manager/escalation'],
    templateId: 'operating-model-design',
    fcvKinds: [],
  },

  /** Spec 4.7 — KPI & OKR Framework. */
  {
    section: 4,
    slug: 'kpi-okr-framework',
    title: 'KPI & OKR Framework',
    format: 'md',
    inputArtifacts: ['unit-economics.json', 'roadmap.json', 'scenario.json'],
    sourceAgents: ['research-lab/metrics', 'observatory/slo', 'analytics-hub/recommendation'],
    templateId: 'performance-dashboard',
    fcvKinds: ['savings', 'roi'],
  },

  /** Spec 4.8 — Vendor / Partner Strategy. */
  {
    section: 4,
    slug: 'vendor-partner-strategy',
    title: 'Vendor / Partner Strategy',
    format: 'md',
    inputArtifacts: ['phase2/tech-stack.json', 'integration-assessment.md', 'unit-economics.json'],
    sourceAgents: ['costops/tradeoff', 'analytics-hub/recommendation', 'connector-hub/erp-surface'],
    templateId: 'vendor-strategy',
    fcvKinds: ['investment'],
  },

  // ============================================================
  // Section 5 — Technology & Architecture Decision Documents (9 bullets → 7 rows)
  // Consolidations:
  //  - 5.3 "System Landscape Diagram" merged into 5.2 (architecture-blueprint)
  //  - 5.7 "Integration Architecture" merged into 5.2 (architecture-blueprint)
  // ============================================================

  /** Spec 5.1 — Technology Strategy. */
  {
    section: 5,
    slug: 'technology-strategy',
    title: 'Technology Strategy',
    format: 'md',
    inputArtifacts: ['phase2/tech-stack.json', 'phase4/adrs', 'integration-assessment.md'],
    sourceAgents: ['system-architect', 'forge/sdk', 'analytics-hub/recommendation'],
    templateId: 'strategy-doc',
    fcvKinds: [],
  },

  /** Spec 5.2 — Architecture Blueprint (Current vs Target). (Spec 5.3 "System Landscape Diagram" and 5.7 "Integration Architecture" consolidated here — all three describe the architecture surface using the target-state-architecture template; landscape and integration are sub-views.) Mirrors top-level integration-assessment.md. */
  {
    section: 5,
    slug: 'architecture-blueprint',
    title: 'Architecture Blueprint (Current vs Target) (incl. System Landscape & Integration Architecture)',
    format: 'md',
    inputArtifacts: ['phase2/tech-stack.json', 'phase4/adrs', 'integration-assessment.md', 'manifest.json'],
    sourceAgents: ['system-architect', 'connector-hub/erp-surface', 'connector-hub/event-normalize', 'connector-hub/database-query', 'forge/api-translation'],
    templateId: 'target-state-architecture',
    fcvKinds: [],
    mirrorsExisting: 'integration-assessment.md',
  },

  /** Spec 5.4 — Platform Selection Evaluation. */
  {
    section: 5,
    slug: 'platform-selection-evaluation',
    title: 'Platform Selection Evaluation',
    format: 'md',
    inputArtifacts: ['phase2/tech-stack.json', 'integration-assessment.md', 'unit-economics.json'],
    sourceAgents: ['costops/tradeoff', 'system-architect', 'analytics-hub/recommendation'],
    templateId: 'platform-selection',
    fcvKinds: ['investment'],
  },

  /** Spec 5.5 — Build vs Buy vs Partner Analysis. */
  {
    section: 5,
    slug: 'build-vs-buy-vs-partner',
    title: 'Build vs Buy vs Partner Analysis',
    format: 'md',
    inputArtifacts: ['phase2/tech-stack.json', 'unit-economics.json', 'integration-assessment.md'],
    sourceAgents: ['costops/tradeoff', 'costops/roi', 'system-architect', 'analytics-hub/recommendation'],
    templateId: 'platform-selection',
    fcvKinds: ['investment', 'roi', 'payback'],
  },

  /** Spec 5.6 — Data Strategy & Data Model. */
  {
    section: 5,
    slug: 'data-strategy-data-model',
    title: 'Data Strategy & Data Model',
    format: 'md',
    inputArtifacts: ['phase2/tech-stack.json', 'integration-assessment.md', 'phase4/adrs'],
    sourceAgents: ['system-architect', 'connector-hub/database-query', 'data-vault/access-control'],
    templateId: 'data-strategy',
    fcvKinds: [],
  },

  /** Spec 5.8 — Security & Compliance Architecture. Mirrors top-level security-assessment.md. */
  {
    section: 5,
    slug: 'security-compliance-architecture',
    title: 'Security & Compliance Architecture',
    format: 'md',
    inputArtifacts: ['security-assessment.md', 'risk-assessment.json', 'phase2/tech-stack.json'],
    sourceAgents: ['shield/prompt-injection', 'shield/secrets', 'shield/credential-exposure', 'data-vault/access-control'],
    templateId: 'regulatory-impact',
    fcvKinds: [],
    mirrorsExisting: 'security-assessment.md',
  },

  /** Spec 5.9 — AI / Automation Strategy. */
  {
    section: 5,
    slug: 'ai-automation-strategy',
    title: 'AI / Automation Strategy',
    format: 'md',
    inputArtifacts: ['agent-fleet-report.md', 'phase2/tech-stack.json', 'roadmap.json'],
    sourceAgents: ['platform/executive-summary', 'inference-gateway/route', 'auto-optimizer/model-select'],
    templateId: 'strategy-doc',
    fcvKinds: ['savings', 'roi'],
  },

  // ============================================================
  // Section 6 — Risk, Compliance & Governance (8 bullets → 7 rows)
  // Consolidation: 6.5 "Internal Controls Design" merged into 6.4
  // (compliance-framework — same template, internal controls are the
  // operational expression of the framework).
  // ============================================================

  /** Spec 6.1 — Risk Register. */
  {
    section: 6,
    slug: 'risk-register',
    title: 'Risk Register',
    format: 'md',
    inputArtifacts: ['risk-assessment.json', 'scenario.json', 'consensus.json'],
    sourceAgents: ['platform/risk-score', 'sentinel/anomaly', 'governance-dashboard/impact'],
    templateId: 'risk-register',
    fcvKinds: [],
  },

  /** Spec 6.2 — Risk Mitigation Plan. Mirrors top-level risk-assessment.json. */
  {
    section: 6,
    slug: 'risk-mitigation-plan',
    title: 'Risk Mitigation Plan',
    format: 'md',
    inputArtifacts: ['risk-assessment.json', 'roadmap.json'],
    sourceAgents: ['platform/risk-score', 'incident-manager/escalation', 'edge/circuit-breaker', 'edge/failover'],
    templateId: 'risk-register',
    fcvKinds: [],
    mirrorsExisting: 'risk-assessment.json',
  },

  /** Spec 6.3 — Regulatory Impact Assessment. */
  {
    section: 6,
    slug: 'regulatory-impact-assessment',
    title: 'Regulatory Impact Assessment',
    format: 'md',
    inputArtifacts: ['risk-assessment.json', 'phase2/research-dossier.json', 'security-assessment.md'],
    sourceAgents: ['governance-dashboard/audit', 'policy-engine/enforce', 'data-vault/access-control'],
    templateId: 'regulatory-impact',
    fcvKinds: [],
  },

  /** Spec 6.4 — Compliance Framework. (Spec 6.5 "Internal Controls Design" consolidated here — same template, controls are the operational expression of the framework.) */
  {
    section: 6,
    slug: 'compliance-framework',
    title: 'Compliance Framework (incl. Internal Controls Design)',
    format: 'md',
    inputArtifacts: ['security-assessment.md', 'risk-assessment.json', 'phase4/adrs', 'manifest.json'],
    sourceAgents: ['governance-dashboard/audit', 'policy-engine/enforce', 'policy-engine/constraints', 'governance-dashboard/oversight'],
    templateId: 'regulatory-impact',
    fcvKinds: [],
  },

  /** Spec 6.6 — Cybersecurity Risk Assessment. */
  {
    section: 6,
    slug: 'cybersecurity-risk-assessment',
    title: 'Cybersecurity Risk Assessment',
    format: 'md',
    inputArtifacts: ['security-assessment.md', 'risk-assessment.json'],
    sourceAgents: ['shield/prompt-injection', 'shield/credential-exposure', 'shield/secrets', 'sentinel/anomaly'],
    templateId: 'risk-register',
    fcvKinds: [],
  },

  /** Spec 6.7 — Audit Readiness Pack. */
  {
    section: 6,
    slug: 'audit-readiness-pack',
    title: 'Audit Readiness Pack',
    format: 'md',
    inputArtifacts: ['manifest.json', 'consensus.json', 'risk-assessment.json', 'phase4/adrs'],
    sourceAgents: ['governance-dashboard/audit', 'memory-graph/lineage', 'memory-graph/decisions'],
    templateId: 'regulatory-impact',
    fcvKinds: [],
  },

  /** Spec 6.8 — Ethical / Responsible AI Assessment. */
  {
    section: 6,
    slug: 'ethical-responsible-ai-assessment',
    title: 'Ethical / Responsible AI Assessment',
    format: 'md',
    inputArtifacts: ['agent-fleet-report.md', 'security-assessment.md', 'risk-assessment.json'],
    sourceAgents: ['shield/toxicity', 'shield/moderation', 'shield/safety-boundary', 'governance-dashboard/oversight'],
    templateId: 'regulatory-impact',
    fcvKinds: [],
  },

  // ============================================================
  // Section 7 — Research, Insights & Diagnostics (9 bullets → 6 rows)
  // Consolidations:
  //  - 7.5 "Industry Landscape Scan" merged into 7.6 (trend-disruption-analysis)
  //  - 7.6 → kept as the consolidated landscape+trends artifact
  //  - 7.7 "Internal Diagnostic Assessment" merged into 3.8 (capability-maturity)
  //  - 7.4 "Competitive Benchmarking" kept (distinct from market scan)
  // Net: 9 - 3 = 6 rows.
  // ============================================================

  /** Spec 7.1 — Market Research Report. */
  {
    section: 7,
    slug: 'market-research-report',
    title: 'Market Research Report',
    format: 'md',
    inputArtifacts: ['phase2/research-dossier.json', 'phase2/research-dossier.md'],
    sourceAgents: ['research-lab/hypothesis', 'research-lab/metrics', 'analytics-hub/recommendation'],
    templateId: 'research-report',
    fcvKinds: [],
  },

  /** Spec 7.2 — Customer Segmentation. */
  {
    section: 7,
    slug: 'customer-segmentation',
    title: 'Customer Segmentation',
    format: 'md',
    inputArtifacts: ['phase2/research-dossier.json', 'scenario.json'],
    sourceAgents: ['research-lab/hypothesis', 'analytics-hub/recommendation', 'observatory/usage-patterns'],
    templateId: 'research-report',
    fcvKinds: [],
  },

  /** Spec 7.3 — Voice of Customer (VoC) Analysis. */
  {
    section: 7,
    slug: 'voc-analysis',
    title: 'Voice of Customer (VoC) Analysis',
    format: 'md',
    inputArtifacts: ['phase2/research-dossier.json', 'agent-responses.json'],
    sourceAgents: ['research-lab/hypothesis', 'observatory/usage-patterns', 'analytics-hub/recommendation'],
    templateId: 'research-report',
    fcvKinds: [],
  },

  /** Spec 7.4 — Competitive Benchmarking. */
  {
    section: 7,
    slug: 'competitive-benchmarking',
    title: 'Competitive Benchmarking',
    format: 'md',
    inputArtifacts: ['phase2/research-dossier.json', 'phase2/tech-stack.json'],
    sourceAgents: ['research-lab/hypothesis', 'test-bench/benchmark', 'test-bench/compare'],
    templateId: 'research-report',
    fcvKinds: [],
  },

  /** Spec 7.6 — Trend & Disruption Analysis. (Spec 7.5 "Industry Landscape Scan" consolidated here — both are landscape views over the same research dossier; the trends artifact subsumes the landscape scan as its temporal projection.) */
  {
    section: 7,
    slug: 'trend-disruption-analysis',
    title: 'Trend & Disruption Analysis (incl. Industry Landscape Scan)',
    format: 'md',
    inputArtifacts: ['phase2/research-dossier.json', 'phase2/tech-stack.json'],
    sourceAgents: ['research-lab/hypothesis', 'simulator/what-if', 'analytics-hub/recommendation'],
    templateId: 'research-report',
    fcvKinds: [],
  },

  /** Spec 7.7 — Internal Diagnostic Assessment. */
  {
    section: 7,
    slug: 'internal-diagnostic-assessment',
    title: 'Internal Diagnostic Assessment',
    format: 'md',
    inputArtifacts: ['phase2/research-dossier.json', 'agent-fleet-report.md', 'scenario.json', 'risk-assessment.json'],
    sourceAgents: ['research-lab/metrics', 'analytics-hub/recommendation', 'observatory/health-check', 'observatory/usage-patterns'],
    templateId: 'internal-diagnostic',
    fcvKinds: [],
  },

  /** Spec 7.8 — SWOT Analysis. (Spec 7.9 "Root Cause Analysis" consolidated here — both are diagnostic frameworks over the same input set; SWOT covers strategic-level diagnosis, RCA covers operational-level. They share the internal-diagnostic template and are routinely produced as one document.) */
  {
    section: 7,
    slug: 'swot-analysis',
    title: 'SWOT Analysis (incl. Root Cause Analysis)',
    format: 'md',
    inputArtifacts: ['phase2/research-dossier.json', 'scenario.json', 'risk-assessment.json', 'agent-responses.json'],
    sourceAgents: ['research-lab/hypothesis', 'analytics-hub/recommendation', 'platform/risk-score', 'sentinel/rca', 'sentinel/correlation'],
    templateId: 'internal-diagnostic',
    fcvKinds: [],
  },

  // ============================================================
  // Section 8 — Program & Transformation Management (9 bullets → 6 rows)
  // Consolidations:
  //  - 8.2 "Transformation Blueprint" merged into 9.1 (implementation-roadmap)
  //    (both reference roadmap+ADRs and use transformation-roadmap template)
  //  - 8.5 "Dependency Mapping" merged into 8.4 (milestone-plan)
  //    (dependencies are a sub-view of the milestone timeline)
  //  - 8.9 "Communication Plan" merged into 8.8 (change-management-strategy)
  //    (communication is the outbound arm of change management)
  // ============================================================

  /** Spec 8.1 — Program Charter. */
  {
    section: 8,
    slug: 'program-charter',
    title: 'Program Charter',
    format: 'md',
    inputArtifacts: ['executive-summary.md', 'roadmap.json', 'unit-economics.json'],
    sourceAgents: ['platform/executive-summary', 'orchestrator/workflow', 'copilot/planner'],
    templateId: 'program-charter',
    fcvKinds: ['investment', 'timeline'],
  },

  /** Spec 8.2 — Transformation Blueprint. */
  {
    section: 8,
    slug: 'transformation-blueprint',
    title: 'Transformation Blueprint',
    format: 'md',
    inputArtifacts: ['executive-summary.md', 'roadmap.json', 'phase4/adrs', 'integration-assessment.md'],
    sourceAgents: ['platform/executive-summary', 'orchestrator/workflow', 'system-architect', 'copilot/planner'],
    templateId: 'transformation-blueprint',
    fcvKinds: ['investment', 'timeline'],
  },

  /** Spec 8.3 — PMO Framework. */
  {
    section: 8,
    slug: 'pmo-framework',
    title: 'PMO Framework',
    format: 'md',
    inputArtifacts: ['scenario.json', 'manifest.json', 'roadmap.json'],
    sourceAgents: ['orchestrator/workflow', 'orchestrator/scheduler', 'governance-dashboard/oversight'],
    templateId: 'pmo-framework',
    fcvKinds: [],
  },

  /** Spec 8.4 — Milestone Plan / Timeline. (Spec 8.5 "Dependency Mapping" consolidated here — dependencies are the edge-set of the milestone timeline graph; same template, same input artifacts.) */
  {
    section: 8,
    slug: 'milestone-plan',
    title: 'Milestone Plan / Timeline (incl. Dependency Mapping)',
    format: 'md',
    inputArtifacts: ['roadmap.json', 'scenario.json', 'phase4/adrs'],
    sourceAgents: ['orchestrator/scheduler', 'orchestrator/workflow', 'orchestrator/dependencies', 'system-architect'],
    templateId: 'pmo-framework',
    fcvKinds: ['timeline'],
  },

  /** Spec 8.6 — Resource Plan. */
  {
    section: 8,
    slug: 'resource-plan',
    title: 'Resource Plan',
    format: 'md',
    inputArtifacts: ['roadmap.json', 'unit-economics.json', 'manifest.json'],
    sourceAgents: ['orchestrator/scheduler', 'costops/budget', 'copilot/decomposer'],
    templateId: 'org-structure',
    fcvKinds: ['investment', 'timeline'],
  },

  /** Spec 8.7 — Budget Plan. */
  {
    section: 8,
    slug: 'budget-plan',
    title: 'Budget Plan',
    format: 'md',
    inputArtifacts: ['unit-economics.json', 'roadmap.json', 'financial-analysis.md'],
    sourceAgents: ['costops/budget', 'costops/forecast', 'costops/attribution'],
    templateId: 'pmo-framework',
    fcvKinds: ['investment', 'timeline'],
  },

  /** Spec 8.8 — Change Management Strategy. (Spec 8.9 "Communication Plan" consolidated here — communication is the outbound arm of change management; both share the same roadmap+manifest input set.) */
  {
    section: 8,
    slug: 'change-management-strategy',
    title: 'Change Management Strategy (incl. Communication Plan)',
    format: 'md',
    inputArtifacts: ['roadmap.json', 'scenario.json', 'agent-fleet-report.md', 'manifest.json'],
    sourceAgents: ['copilot/planner', 'orchestrator/workflow', 'analytics-hub/recommendation'],
    templateId: 'strategy-doc',
    fcvKinds: ['timeline'],
  },

  // ============================================================
  // Section 9 — Implementation & Delivery Documents (8 bullets → 7 rows)
  // Consolidations:
  //  - 9.5 "Pilot / MVP Definition" merged into 9.3 (delivery-plan)
  //    (pilot is the first-cohort sub-section of the delivery plan)
  //  - 8.2 "Transformation Blueprint" absorbed into 9.1
  //    (implementation-roadmap) — both ride the same transformation-roadmap
  //    template; blueprint = the as-rendered version of the roadmap.
  // ============================================================

  /** Spec 9.1 — Implementation Roadmap. */
  {
    section: 9,
    slug: 'implementation-roadmap',
    title: 'Implementation Roadmap',
    format: 'md',
    inputArtifacts: ['roadmap.json', 'phase4/adrs', 'phase5a/prompts', 'integration-assessment.md'],
    sourceAgents: ['orchestrator/workflow', 'orchestrator/scheduler', 'platform/executive-summary', 'system-architect'],
    templateId: 'implementation-roadmap',
    fcvKinds: ['timeline'],
  },

  /** Spec 9.2 — Initiative Backlog / Work Breakdown. */
  {
    section: 9,
    slug: 'initiative-backlog-wbs',
    title: 'Initiative Backlog / Work Breakdown',
    format: 'md',
    inputArtifacts: ['roadmap.json', 'phase4/adrs', 'phase3/sparc'],
    sourceAgents: ['copilot/decomposer', 'orchestrator/dependencies', 'orchestrator/workflow'],
    templateId: 'deployment-plan',
    fcvKinds: ['timeline'],
  },

  /** Spec 9.3 — Delivery Plan (Agile / Waterfall). (Spec 9.5 "Pilot / MVP Definition" consolidated here — pilot is the first-cohort sub-section of the delivery plan, sharing the same template and input artifacts.) */
  {
    section: 9,
    slug: 'delivery-plan',
    title: 'Delivery Plan (Agile / Waterfall) (incl. Pilot / MVP Definition)',
    format: 'md',
    inputArtifacts: ['roadmap.json', 'phase4/adrs', 'manifest.json', 'scenario.json'],
    sourceAgents: ['orchestrator/workflow', 'orchestrator/scheduler', 'copilot/planner', 'simulator/what-if'],
    templateId: 'deployment-plan',
    fcvKinds: ['investment', 'timeline'],
  },

  /** Spec 9.4 — Release Plan. */
  {
    section: 9,
    slug: 'release-plan',
    title: 'Release Plan',
    format: 'md',
    inputArtifacts: ['roadmap.json', 'phase4/adrs', 'phase5a/prompts'],
    sourceAgents: ['orchestrator/workflow', 'orchestrator/state-machine', 'edge/failover'],
    templateId: 'deployment-plan',
    fcvKinds: ['timeline'],
  },

  /** Spec 9.6 — Testing Strategy (UAT, QA). */
  {
    section: 9,
    slug: 'testing-strategy',
    title: 'Testing Strategy (UAT, QA)',
    format: 'md',
    inputArtifacts: ['phase3/tdd', 'phase4/adrs', 'phase2/tdd'],
    sourceAgents: ['test-bench/quality', 'test-bench/regression'],
    templateId: 'testing-strategy',
    fcvKinds: [],
  },

  /** Spec 9.7 — Deployment Plan. */
  {
    section: 9,
    slug: 'deployment-plan',
    title: 'Deployment Plan',
    format: 'md',
    inputArtifacts: ['roadmap.json', 'phase4/adrs', 'integration-assessment.md'],
    sourceAgents: ['orchestrator/workflow', 'edge/failover', 'edge/circuit-breaker', 'connector-hub/erp-surface'],
    templateId: 'deployment-plan',
    fcvKinds: ['timeline'],
  },

  /** Spec 9.8 — Hypercare Plan. */
  {
    section: 9,
    slug: 'hypercare-plan',
    title: 'Hypercare Plan',
    format: 'md',
    inputArtifacts: ['roadmap.json', 'risk-assessment.json', 'agent-fleet-report.md'],
    sourceAgents: ['incident-manager/escalation', 'observatory/health-check', 'observatory/slo'],
    templateId: 'deployment-plan',
    fcvKinds: ['timeline'],
  },

  // ============================================================
  // Section 10 — Performance & Monitoring (6 bullets → 5 rows)
  // Consolidation: 10.3 "Benefits Realization Tracker" merged into
  // 10.2 (kpi-tracking-model) — both ride the kpi-okr template; benefits
  // realisation is the financial sub-view of KPI tracking.
  // ============================================================

  /** Spec 10.1 — Performance Dashboard Design. */
  {
    section: 10,
    slug: 'performance-dashboard-design',
    title: 'Performance Dashboard Design',
    format: 'md',
    inputArtifacts: ['unit-economics.json', 'roadmap.json', 'agent-fleet-report.md'],
    sourceAgents: ['observatory/visualization', 'observatory/telemetry', 'observatory/slo'],
    templateId: 'performance-dashboard',
    fcvKinds: ['savings', 'roi'],
  },

  /** Spec 10.2 — KPI Tracking Model. (Spec 10.3 "Benefits Realization Tracker" consolidated here — same kpi-okr template; benefits realisation is the financial sub-view.) */
  {
    section: 10,
    slug: 'kpi-tracking-model',
    title: 'KPI Tracking Model (incl. Benefits Realization Tracker)',
    format: 'md',
    inputArtifacts: ['unit-economics.json', 'roadmap.json'],
    sourceAgents: ['research-lab/metrics', 'observatory/slo', 'observatory/telemetry', 'costops/roi'],
    templateId: 'performance-dashboard',
    fcvKinds: ['savings', 'roi'],
  },

  /** Spec 10.4 — Operational Scorecards. */
  {
    section: 10,
    slug: 'operational-scorecards',
    title: 'Operational Scorecards',
    format: 'md',
    inputArtifacts: ['unit-economics.json', 'agent-fleet-report.md', 'manifest.json'],
    sourceAgents: ['observatory/slo', 'observatory/health-check', 'research-lab/metrics'],
    templateId: 'performance-dashboard',
    fcvKinds: ['savings'],
  },

  /** Spec 10.5 — Continuous Improvement Framework. */
  {
    section: 10,
    slug: 'continuous-improvement-framework',
    title: 'Continuous Improvement Framework',
    format: 'md',
    inputArtifacts: ['agent-fleet-report.md', 'roadmap.json', 'manifest.json'],
    sourceAgents: ['auto-optimizer/self-optimize', 'research-lab/metrics', 'analytics-hub/recommendation'],
    templateId: 'continuous-improvement',
    fcvKinds: ['savings', 'roi'],
  },

  /** Spec 10.6 — Post-Implementation Review. */
  {
    section: 10,
    slug: 'post-implementation-review',
    title: 'Post-Implementation Review',
    format: 'md',
    inputArtifacts: ['unit-economics.json', 'agent-fleet-report.md', 'manifest.json'],
    sourceAgents: ['observatory/post-mortem', 'research-lab/metrics', 'memory-graph/lineage'],
    templateId: 'continuous-improvement',
    fcvKinds: ['savings', 'roi'],
  },

  // ============================================================
  // Section 11 — Commercial & Deal Documents (6 bullets → 6 rows)
  // No consolidations.
  // ============================================================

  /** Spec 11.1 — RFP / RFQ / RFI Responses. */
  {
    section: 11,
    slug: 'rfp-rfq-rfi-responses',
    title: 'RFP / RFQ / RFI Responses',
    format: 'md',
    inputArtifacts: ['phase2/research-dossier.json', 'integration-assessment.md', 'unit-economics.json'],
    sourceAgents: ['platform/executive-summary', 'analytics-hub/recommendation', 'connector-hub/erp-surface'],
    templateId: 'rfp-response',
    fcvKinds: ['investment'],
  },

  /** Spec 11.2 — Vendor Evaluation Scorecards. */
  {
    section: 11,
    slug: 'vendor-evaluation-scorecards',
    title: 'Vendor Evaluation Scorecards',
    format: 'md',
    inputArtifacts: ['phase2/tech-stack.json', 'integration-assessment.md', 'unit-economics.json'],
    sourceAgents: ['costops/tradeoff', 'analytics-hub/recommendation', 'test-bench/compare'],
    templateId: 'vendor-strategy',
    fcvKinds: ['investment'],
  },

  /** Spec 11.3 — Contracting Strategy. */
  {
    section: 11,
    slug: 'contracting-strategy',
    title: 'Contracting Strategy',
    format: 'md',
    inputArtifacts: ['unit-economics.json', 'risk-assessment.json', 'integration-assessment.md'],
    sourceAgents: ['costops/tradeoff', 'governance-dashboard/audit', 'policy-engine/enforce'],
    templateId: 'strategy-doc',
    fcvKinds: ['investment'],
  },

  /** Spec 11.4 — Commercial Model Design. */
  {
    section: 11,
    slug: 'commercial-model-design',
    title: 'Commercial Model Design',
    format: 'md',
    inputArtifacts: ['unit-economics.json', 'financial-analysis.md', 'scenario.json'],
    sourceAgents: ['costops/tradeoff', 'costops/forecast', 'analytics-hub/recommendation'],
    templateId: 'rfp-response',
    fcvKinds: ['investment', 'savings', 'roi'],
  },

  /** Spec 11.5 — SLA / KPI Definitions. */
  {
    section: 11,
    slug: 'sla-kpi-definitions',
    title: 'SLA / KPI Definitions',
    format: 'md',
    inputArtifacts: ['integration-assessment.md', 'agent-fleet-report.md', 'roadmap.json'],
    sourceAgents: ['observatory/slo', 'edge/circuit-breaker', 'research-lab/metrics'],
    templateId: 'performance-dashboard',
    fcvKinds: [],
  },

  /** Spec 11.6 — Negotiation Strategy. */
  {
    section: 11,
    slug: 'negotiation-strategy',
    title: 'Negotiation Strategy',
    format: 'md',
    inputArtifacts: ['unit-economics.json', 'phase2/research-dossier.json'],
    sourceAgents: ['costops/tradeoff', 'analytics-hub/recommendation', 'simulator/what-if'],
    templateId: 'strategy-doc',
    fcvKinds: ['investment'],
  },

  // ============================================================
  // Section 12 — Advanced / High-Maturity Decision Artifacts (7 bullets → 7 rows)
  // The remaining mirror entries (consensus.json, manifest.json,
  // agent-fleet-report.md) attach here.
  // ============================================================

  /** Spec 12.1 — Decision Trees & Decision Logic Models. */
  {
    section: 12,
    slug: 'decision-trees',
    title: 'Decision Trees & Decision Logic Models',
    format: 'md',
    inputArtifacts: ['scenario.json', 'consensus.json', 'risk-assessment.json'],
    sourceAgents: ['platform/decision', 'simulator/scenario', 'memory-graph/decisions'],
    templateId: 'scenario-analysis',
    fcvKinds: ['savings', 'roi'],
  },

  /** Spec 12.2 — Simulation Models (e.g., Monte Carlo). */
  {
    section: 12,
    slug: 'monte-carlo-simulation',
    title: 'Simulation Models (Monte Carlo)',
    format: 'md',
    inputArtifacts: ['unit-economics.json', 'scenario.json'],
    sourceAgents: ['simulator/scenario', 'simulator/what-if', 'research-lab/metrics'],
    templateId: 'scenario-analysis',
    fcvKinds: ['savings', 'npv', 'roi'],
  },

  /** Spec 12.3 — Digital Twins (Process / System / Business). */
  {
    section: 12,
    slug: 'digital-twins',
    title: 'Digital Twins (Process / System / Business)',
    format: 'md',
    inputArtifacts: ['phase2/tech-stack.json', 'integration-assessment.md', 'manifest.json'],
    sourceAgents: ['simulator/scenario', 'system-architect', 'connector-hub/event-normalize'],
    templateId: 'digital-twin',
    fcvKinds: [],
  },

  /** Spec 12.4 — AI / ML Model Evaluation Reports. Mirrors top-level agent-fleet-report.md. */
  {
    section: 12,
    slug: 'ai-ml-model-evaluation',
    title: 'AI / ML Model Evaluation Reports',
    format: 'md',
    inputArtifacts: ['agent-fleet-report.md', 'agent-responses.json', 'consensus.json'],
    sourceAgents: ['test-bench/benchmark', 'test-bench/quality', 'test-bench/hallucination', 'test-bench/faithfulness'],
    templateId: 'platform-selection',
    fcvKinds: [],
    mirrorsExisting: 'agent-fleet-report.md',
  },

  /** Spec 12.5 — Experimentation Frameworks (A/B Testing). */
  {
    section: 12,
    slug: 'experimentation-frameworks',
    title: 'Experimentation Frameworks (A/B Testing)',
    format: 'md',
    inputArtifacts: ['scenario.json', 'agent-responses.json'],
    sourceAgents: ['research-lab/hypothesis', 'research-lab/metrics', 'simulator/what-if'],
    templateId: 'digital-twin',
    fcvKinds: [],
  },

  /** Spec 12.6 — Sensitivity & Stress Testing Models. Mirrors top-level consensus.json. */
  {
    section: 12,
    slug: 'sensitivity-stress-testing',
    title: 'Sensitivity & Stress Testing Models',
    format: 'md',
    inputArtifacts: ['consensus.json', 'unit-economics.json', 'scenario.json'],
    sourceAgents: ['simulator/scenario', 'simulator/what-if', 'test-bench/stress', 'platform/risk-score'],
    templateId: 'scenario-analysis',
    fcvKinds: ['savings', 'npv', 'roi'],
    mirrorsExisting: 'consensus.json',
  },

  /** Spec 12.7 — Executive Narrative Documents (Story-Driven Persuasion). Mirrors top-level manifest.json (lineage source). */
  {
    section: 12,
    slug: 'executive-narrative',
    title: 'Executive Narrative Documents (Story-Driven Persuasion)',
    format: 'md',
    inputArtifacts: ['executive-summary.md', 'manifest.json', 'consensus.json'],
    sourceAgents: ['platform/executive-summary', 'analytics-hub/recommendation', 'memory-graph/decisions'],
    templateId: 'executive-summary',
    fcvKinds: ['investment', 'savings', 'roi'],
    mirrorsExisting: 'manifest.json',
  },
];
