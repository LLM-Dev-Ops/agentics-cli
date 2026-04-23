/**
 * Artifact Renderers — Per-Artifact Structured Content Generators (ADR-034)
 *
 * Each of the 15 deterministic enterprise artifacts has a dedicated renderer
 * that produces markdown following the exact structure specified in ADR-034.
 *
 * Renderers read from DecisionGraph nodes and produce structured content
 * matching enterprise consulting deliverables (McKinsey, Accenture, etc.).
 */

import type { DecisionGraphNode, PassNumber } from './types.js';

// ============================================================================
// Renderer Interface
// ============================================================================

/**
 * Engineering tier — which executor produced the engineering artifacts
 * (SPARC spec, ADRs, DDD, TDD plan, implementation prompts).
 *
 * Per ADR-PIPELINE-091, this is reported independently from
 * `enrichment_depth_pct`. DO NOT combine these into a single "precision"
 * or "confidence" number — that was the dacf7975 misreport.
 */
export type EngineeringTier = 'ruflo-local' | 'template';

/** Enrichment block from manifest.execution (ADR-PIPELINE-091 §5). */
export interface ExecutionEnrichmentInfo {
  readonly remote_agents_available: readonly string[];
  readonly remote_agents_errored: readonly string[];
  /** Null when the run had no remote enrichment agents at all. */
  readonly enrichment_depth_pct: number | null;
}

/** Execution block from `manifest.json` (ADR-PIPELINE-091 §5). */
export interface ExecutionInfo {
  readonly engineering_tier: EngineeringTier;
  readonly tier_counts?: Readonly<Record<EngineeringTier, number>>;
  readonly enrichment: ExecutionEnrichmentInfo;
}

/** Context passed to every artifact renderer. */
export interface RenderContext {
  readonly executionId: string;
  readonly prompt: string;
  readonly timestamp: string;
  /** All graph nodes available for cross-referencing. */
  readonly allNodes: readonly DecisionGraphNode[];
  /** Nodes specifically relevant to this artifact (matched by type). */
  readonly relevantNodes: readonly DecisionGraphNode[];
  /** Whether any source data was degraded. */
  readonly isDegraded: boolean;
  /** Passes that completed in degraded mode. */
  readonly passesDegraded: readonly PassNumber[];
  /**
   * Optional execution block mirrored from `manifest.json` (ADR-PIPELINE-091 §5).
   * When present, `renderExecutiveSummary` and `renderExecutiveDecisionMemo`
   * report `engineering_tier` and `enrichment_depth_pct` as TWO INDEPENDENT
   * signals. When absent (pre-ADR-091 runs), the new prose is skipped and
   * output remains backwards-compatible.
   */
  readonly execution?: ExecutionInfo;
}

/** A function that renders a single artifact to markdown. */
export type ArtifactRenderer = (ctx: RenderContext) => string;

// ============================================================================
// Shared Helpers
// ============================================================================

function header(title: string, number: number, agent: string, pass: number, analogy: string, timestamp: string): string {
  return [
    `# ${title}`,
    `**Artifact #${number}** | **Pass:** ${pass} | **Producing Agent:** ${agent}`,
    `**Consulting Analogy:** ${analogy}`,
    `**Generated:** ${timestamp}`,
    '',
  ].join('\n');
}

function degradedBanner(reason?: string): string {
  const msg = reason ?? 'Some source data was unavailable or unreliable.';
  return `> **\u26a0\ufe0f DEGRADED** \u2014 ${msg}\n`;
}

function contentSection(title: string, value: unknown): string {
  const lines: string[] = [`### ${title}`, ''];
  if (typeof value === 'string') {
    lines.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) {
      lines.push(typeof item === 'string' ? `- ${item}` : `- ${JSON.stringify(item)}`);
    }
  } else if (typeof value === 'object' && value !== null) {
    lines.push('```json');
    lines.push(JSON.stringify(value, null, 2));
    lines.push('```');
  } else if (value !== undefined && value !== null) {
    lines.push(String(value));
  } else {
    lines.push('*No data available.*');
  }
  lines.push('');
  return lines.join('\n');
}

function getContentField(nodes: readonly DecisionGraphNode[], field: string): unknown {
  for (const n of nodes) {
    const val = n.content[field];
    if (val !== undefined && val !== null) return val;
  }
  return undefined;
}

function allContentMerged(nodes: readonly DecisionGraphNode[]): Record<string, unknown> {
  const merged: Record<string, unknown> = {};
  for (const n of nodes) {
    for (const [k, v] of Object.entries(n.content)) {
      if (merged[k] === undefined) {
        merged[k] = v;
      }
    }
  }
  return merged;
}

function summaryBlock(nodes: readonly DecisionGraphNode[]): string {
  if (nodes.length === 0) return '';
  return nodes.map(n => n.summary).filter(Boolean).join('\n\n') + '\n';
}

function confidenceFooter(nodes: readonly DecisionGraphNode[]): string {
  if (nodes.length === 0) return '';
  const avg = nodes.reduce((s, n) => s + n.confidence, 0) / nodes.length;
  // Framed as "Phase 1 consensus quality" per ADR-PIPELINE-091 §5 to avoid
  // conflation with remote-fleet availability or engineering-tier signals.
  return `\n**Phase 1 Consensus Quality:** ${(avg * 100).toFixed(0)}% (source-node confidence average)\n`;
}

/**
 * Format a short, comma-separated preview of errored agent names.
 * Shows up to 4; if more, appends "and N more".
 */
function formatErroredAgents(names: readonly string[]): string {
  if (names.length === 0) return '';
  const shown = names.slice(0, 4).map(n => `\`${n}\``);
  if (names.length <= 4) return shown.join(', ');
  return `${shown.join(', ')} and ${names.length - 4} more`;
}

/**
 * Executive-summary prose for the `execution` block (ADR-PIPELINE-091 §5).
 *
 * Reports `engineering_tier` and `enrichment_depth_pct` as TWO INDEPENDENT
 * signals. Never combines them into a single "precision" / "confidence"
 * / "consensus" number. When `execution` is absent, returns an empty
 * string so older runs render unchanged.
 */
function executionSummarySection(execution: ExecutionInfo | undefined): string {
  if (!execution) return '';

  const lines: string[] = ['### Pipeline Execution Provenance', ''];

  // Signal 1 — engineering tier (which executor produced the artifacts).
  if (execution.engineering_tier === 'ruflo-local') {
    lines.push(
      '**Engineering artifact production:** All engineering artifacts ' +
      '(SPARC specification, ADRs, DDD bounded contexts, implementation ' +
      'prompts) were produced via the local Ruflo swarm against your own ' +
      'Claude Code session.',
    );
  } else {
    lines.push(
      '**Engineering artifact production:** Engineering artifacts produced ' +
      'via deterministic templates because the local Ruflo swarm was ' +
      'unavailable (no LLM session / `AGENTICS_DISABLE_RUFLO=true`). ' +
      'Template-tier output has lower fidelity; consider rerunning in an ' +
      'environment with Ruflo available.',
    );
  }
  lines.push('');

  // Signal 2 — remote enrichment depth (independent of tier above).
  const { enrichment } = execution;
  const depth = enrichment.enrichment_depth_pct;
  const total =
    enrichment.remote_agents_available.length +
    enrichment.remote_agents_errored.length;

  let enrichmentLineRendered = false;

  if (depth === null) {
    // Explicitly skip the enrichment line when the run had no remote
    // enrichment agents at all — don't cite enrichment in that case.
  } else if (depth === 100) {
    lines.push(
      `**Remote enrichment depth:** 100% — all ${total} remote ` +
      'enrichment agents returned successfully; Ruflo received full ' +
      'supplementary context.',
    );
    lines.push('');
    enrichmentLineRendered = true;
  } else if (depth === 0) {
    lines.push(
      '**Remote enrichment depth:** 0% — no remote enrichment agents ' +
      'returned; Ruflo proceeded with Phase 1 dossier and project ' +
      'context only.',
    );
    lines.push('');
    enrichmentLineRendered = true;
  } else {
    const available = enrichment.remote_agents_available.length;
    const errored = enrichment.remote_agents_errored;
    const erroredPreview = formatErroredAgents(errored);
    lines.push(
      `**Remote enrichment depth:** ${depth}% — ${available} of ${total} ` +
      'remote context-enrichment agents returned successfully. ' +
      `The remaining ${errored.length} (${erroredPreview}) were ` +
      'unavailable; Ruflo proceeded without their supplementary ' +
      'industry / regulatory context.',
    );
    lines.push('');
    enrichmentLineRendered = true;
  }

  // Independence framer only relevant when BOTH signals are reported.
  // When the enrichment line is suppressed, suppress this framer too so
  // the word "enrichment" doesn't leak back in.
  if (enrichmentLineRendered) {
    lines.push(
      '_These two signals are independent: the engineering tier describes ' +
      'which executor produced the artifacts; the enrichment depth describes ' +
      'how much supplementary remote context was layered in. Neither should ' +
      'be conflated with pipeline-quality or consensus-precision numbers._',
    );
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Decision-memo prose for the `execution` block (ADR-PIPELINE-091 §5).
 * One or two sentences, referencing the engineering tier and enrichment
 * depth. Added to the memo without rewriting existing structure.
 */
function executionMemoNote(execution: ExecutionInfo | undefined): string {
  if (!execution) return '';

  const tierSentence =
    execution.engineering_tier === 'ruflo-local'
      ? 'Engineering artifacts (SPARC spec, ADRs, DDD, implementation prompts) were produced via the local Ruflo swarm against the user\'s own Claude Code session.'
      : 'Engineering artifacts were produced via deterministic templates because the local Ruflo swarm was unavailable; template-tier output has lower fidelity than Ruflo-tier.';

  const depth = execution.enrichment.enrichment_depth_pct;
  let enrichmentSentence = '';
  if (depth !== null) {
    const total =
      execution.enrichment.remote_agents_available.length +
      execution.enrichment.remote_agents_errored.length;
    const available = execution.enrichment.remote_agents_available.length;
    enrichmentSentence =
      ` Remote enrichment depth was ${depth}% (${available} of ${total} optional context-enrichment agents returned); this is reported separately from engineering tier and is not a pipeline-quality score.`;
  }

  const lines: string[] = [];
  lines.push('### How these artifacts were produced');
  lines.push('');
  lines.push(tierSentence + enrichmentSentence);
  lines.push('');
  return lines.join('\n');
}

// ============================================================================
// Artifact 1: Executive Decision Memo
// ============================================================================

export const renderExecutiveDecisionMemo: ArtifactRenderer = (ctx) => {
  const lines: string[] = [];
  lines.push(header('Executive Decision Memo', 1, 'Decision Memo Agent', 5, 'McKinsey decision document', ctx.timestamp));
  if (ctx.isDegraded) lines.push(degradedBanner());

  const c = allContentMerged(ctx.relevantNodes);

  lines.push(contentSection('Decision Requested', c['decision'] ?? c['decision_requested'] ?? 'Approve / Reject / Investigate Further'));
  lines.push(contentSection('Problem Statement', c['problem'] ?? c['problem_statement'] ?? getContentField(ctx.allNodes, 'problem') ?? '*Derived from Pass 1 Problem Intelligence.*'));
  lines.push(contentSection('Strategic Importance & Business Justification', c['strategic_importance'] ?? c['business_justification'] ?? '*Derived from business context analysis.*'));
  lines.push(contentSection('Recommended Solution', c['recommended_solution'] ?? c['architecture_summary'] ?? '*Architecture summary from Pass 3.*'));
  lines.push(contentSection('Financial Impact', c['financial_impact'] ?? c['roi'] ?? '*ROI projections from CostOps (Pass 4).*'));
  lines.push(contentSection('Top Risks', c['risks'] ?? c['top_risks'] ?? '*From Risk Assessment (Artifact #5).*'));
  lines.push(contentSection('Recommendation', c['recommendation'] ?? '*Proceed with Phase 1 implementation.*'));

  // ADR-PIPELINE-091 §5 — brief provenance note when the execution block is
  // present in the manifest. Added, not merged into other sections, to keep
  // engineering-tier and enrichment-depth as independent signals.
  const execNote = executionMemoNote(ctx.execution);
  if (execNote) lines.push(execNote);

  lines.push(summaryBlock(ctx.relevantNodes));
  lines.push(confidenceFooter(ctx.relevantNodes));
  lines.push('\n**Quality Criteria:** Must reference specific outputs from Passes 2-4. No generic boilerplate.');
  return lines.join('\n');
};

// ============================================================================
// Artifact 2: Executive Summary
// ============================================================================

export const renderExecutiveSummary: ArtifactRenderer = (ctx) => {
  const lines: string[] = [];
  lines.push(header('Executive Summary', 2, 'Executive Summary Agent', 5, 'Board briefing document', ctx.timestamp));
  if (ctx.isDegraded) lines.push(degradedBanner());

  const c = allContentMerged(ctx.relevantNodes);

  lines.push(contentSection('Strategic Context', c['context'] ?? c['strategic_context'] ?? '*Organizational strategy context.*'));
  lines.push(contentSection('Problem Description', c['problem'] ?? c['problem_description'] ?? getContentField(ctx.allNodes, 'problem') ?? '*From Pass 1 Problem Intelligence.*'));
  lines.push(contentSection('Recommended Architecture', c['architecture'] ?? c['recommended_architecture'] ?? '*Summary from Pass 3 Architecture.*'));
  lines.push(contentSection('Expected Outcomes', c['outcomes'] ?? c['expected_outcomes'] ?? '*Quantified outcomes from simulation.*'));
  lines.push(contentSection('Key Risks', c['risks'] ?? c['key_risks'] ?? '*Top 3-5 risks from Risk Assessment.*'));
  lines.push(contentSection('Timeline Summary', c['timeline'] ?? c['timeline_summary'] ?? '*From Implementation Roadmap.*'));

  // ADR-PIPELINE-091 \u00a75 \u2014 report engineering_tier and enrichment_depth_pct
  // as TWO INDEPENDENT signals. Ends the dacf7975-class failure where
  // "75% remote availability" was conflated with "50% pipeline precision".
  const execSection = executionSummarySection(ctx.execution);
  if (execSection) lines.push(execSection);

  lines.push(confidenceFooter(ctx.relevantNodes));
  lines.push('\n**Quality Criteria:** \u22642 pages. Written for non-technical executive audience.');
  return lines.join('\n');
};

// ============================================================================
// Artifact 3: Architecture & Prototype Specification
// ============================================================================

export const renderArchitectureSpec: ArtifactRenderer = (ctx) => {
  const lines: string[] = [];
  lines.push(header('Architecture & Prototype Specification', 3, 'Orchestrator + Forge Agents', 3, 'Accenture technology blueprint', ctx.timestamp));
  if (ctx.isDegraded) lines.push(degradedBanner());

  const c = allContentMerged(ctx.relevantNodes);

  lines.push(contentSection('System Architecture', c['architecture'] ?? c['system_architecture'] ?? c['components'] ?? '*Components, boundaries, and interfaces.*'));
  lines.push(contentSection('Integration Map', c['integration_map'] ?? c['integrations'] ?? '*External systems and data flows.*'));
  lines.push(contentSection('Service Boundaries', c['service_boundaries'] ?? c['bounded_contexts'] ?? '*DDD bounded contexts.*'));
  lines.push(contentSection('Data Model', c['data_model'] ?? c['entities'] ?? '*Entities, aggregates, value objects.*'));
  lines.push(contentSection('Generated Prototype', c['prototype'] ?? c['endpoints'] ?? '*Endpoint listing and tech stack.*'));
  lines.push(contentSection('ERP Integration Points', c['erp_integration'] ?? c['erp'] ?? '*ERP system integration mapping.*'));

  lines.push(confidenceFooter(ctx.relevantNodes));
  lines.push('\n**Quality Criteria:** Architecture must reflect detected ERP system and domain model. Prototype must have at least one functional endpoint.');
  return lines.join('\n');
};

// ============================================================================
// Artifact 4: Simulation & Scenario Analysis
// ============================================================================

export const renderSimulationAnalysis: ArtifactRenderer = (ctx) => {
  const lines: string[] = [];
  lines.push(header('Simulation & Scenario Analysis', 4, 'Simulator Agents', 2, 'CGI scenario modeling report', ctx.timestamp));
  if (ctx.isDegraded) lines.push(degradedBanner());

  const c = allContentMerged(ctx.relevantNodes);

  lines.push(contentSection('Deployment Scenarios', c['deployment_scenarios'] ?? c['deployment'] ?? '*Best case, expected, worst case.*'));
  lines.push(contentSection('Failure Scenarios', c['failure_scenarios'] ?? c['failures'] ?? '*Integration failures, scaling limits.*'));
  lines.push(contentSection('Scaling Scenarios', c['scaling_scenarios'] ?? c['scaling'] ?? '*Load projections.*'));
  lines.push(contentSection('Integration Edge Cases', c['edge_cases'] ?? c['integration_edge_cases'] ?? '*Unusual but plausible conditions.*'));
  lines.push(contentSection('Per-Scenario Metrics', c['metrics'] ?? c['scenario_metrics'] ?? '*Reliability, failure, and deployment success probabilities.*'));

  lines.push(confidenceFooter(ctx.relevantNodes));
  lines.push('\n**Quality Criteria:** \u22653 distinct scenarios. Each scenario has quantified probability and impact.');
  return lines.join('\n');
};

// ============================================================================
// Artifact 5: Risk Assessment
// ============================================================================

export const renderRiskAssessment: ArtifactRenderer = (ctx) => {
  const lines: string[] = [];
  lines.push(header('Risk Assessment', 5, 'Risk Scoring Agent', 5, 'Deloitte risk register', ctx.timestamp));
  if (ctx.isDegraded) lines.push(degradedBanner());

  const c = allContentMerged(ctx.relevantNodes);

  lines.push('### Risk Register\n');
  lines.push('| Risk | Category | Probability | Impact | Mitigation Strategy |');
  lines.push('|------|----------|-------------|--------|---------------------|');

  const risks = c['risks'] ?? c['risk_register'] ?? c['data'];
  if (Array.isArray(risks)) {
    for (const r of risks) {
      if (typeof r === 'object' && r !== null) {
        const ro = r as Record<string, unknown>;
        lines.push(`| ${ro['risk'] ?? ro['name'] ?? 'N/A'} | ${ro['category'] ?? 'N/A'} | ${ro['probability'] ?? 'N/A'} | ${ro['impact'] ?? 'N/A'} | ${ro['mitigation'] ?? ro['mitigation_strategy'] ?? 'N/A'} |`);
      } else {
        lines.push(`| ${String(r)} | - | - | - | - |`);
      }
    }
  } else {
    lines.push('| *No risks identified from Passes 2 & 4* | - | - | - | - |');
  }
  lines.push('');

  lines.push(contentSection('Risk Heat Map', c['heat_map'] ?? '*Probability \u00d7 Impact matrix.*'));
  lines.push(contentSection('Top 5 Risks with Mitigation Plans', c['top_risks'] ?? c['top_5'] ?? '*Detailed mitigation for highest-severity risks.*'));
  lines.push(contentSection('Residual Risk', c['residual_risk'] ?? '*Risk remaining after mitigations applied.*'));

  lines.push(confidenceFooter(ctx.relevantNodes));
  lines.push('\n**Quality Criteria:** Risks sourced from Sentinel agents (Pass 2) and Shield/Policy agents (Pass 4). No invented risks.');
  return lines.join('\n');
};

// ============================================================================
// Artifact 6: CostOps Financial Model
// ============================================================================

export const renderCostOpsFinancialModel: ArtifactRenderer = (ctx) => {
  const lines: string[] = [];
  lines.push(header('CostOps Financial Model', 6, 'CostOps Agents', 4, 'Capgemini TCO/ROI financial model', ctx.timestamp));
  if (ctx.isDegraded) lines.push(degradedBanner());

  const c = allContentMerged(ctx.relevantNodes);

  lines.push(contentSection('Infrastructure Cost Breakdown', c['infrastructure'] ?? c['infrastructure_costs'] ?? '*Compute, storage, network, licensing.*'));
  lines.push(contentSection('Cloud Usage Projections', c['cloud_usage'] ?? c['cloud_projections'] ?? '*Monthly/annual cloud spend.*'));
  lines.push(contentSection('Integration Costs', c['integration_costs'] ?? c['integrations'] ?? '*Third-party APIs, ERP connectors.*'));
  lines.push(contentSection('Operational Staffing Requirements', c['staffing'] ?? c['operational_staffing'] ?? '*FTE and role requirements.*'));

  lines.push('### Total Cost of Ownership\n');
  lines.push('| Period | Cost |');
  lines.push('|--------|------|');
  lines.push(`| Year 1 | ${c['year1'] ?? c['tco_year1'] ?? '*TBD*'} |`);
  lines.push(`| Year 3 | ${c['year3'] ?? c['tco_year3'] ?? '*TBD*'} |`);
  lines.push(`| Year 5 | ${c['year5'] ?? c['tco_year5'] ?? '*TBD*'} |`);
  lines.push('');

  lines.push(contentSection('ROI Projection', c['roi'] ?? c['roi_projection'] ?? '*Expected return and payback period.*'));
  lines.push(contentSection('Budget Risk Assessment', c['budget_risk'] ?? c['risk'] ?? '*Contingency and exceedance probability.*'));

  lines.push(confidenceFooter(ctx.relevantNodes));
  lines.push('\n**Quality Criteria:** Costs derived from architecture spec (Pass 3) and simulation data (Pass 2). ROI includes sensitivity analysis.');
  return lines.join('\n');
};

// ============================================================================
// Artifact 7: Compliance & Policy Analysis
// ============================================================================

export const renderComplianceAnalysis: ArtifactRenderer = (ctx) => {
  const lines: string[] = [];
  lines.push(header('Compliance & Policy Analysis', 7, 'Shield + Policy Engine Agents', 4, 'PwC regulatory assessment', ctx.timestamp));
  if (ctx.isDegraded) lines.push(degradedBanner());

  const c = allContentMerged(ctx.relevantNodes);

  lines.push(contentSection('Regulatory Landscape', c['regulatory'] ?? c['frameworks'] ?? c['regulatory_landscape'] ?? '*Applicable frameworks: SOC2, GDPR, HIPAA, PIPEDA, etc.*'));
  lines.push(contentSection('Data Governance Requirements', c['data_governance'] ?? c['data_requirements'] ?? '*Data residency, classification, retention.*'));
  lines.push(contentSection('Security Implications', c['security'] ?? c['security_implications'] ?? '*Prompt injection, PII exposure, credential risks.*'));
  lines.push(contentSection('AI Governance Compliance', c['ai_governance'] ?? c['model_governance'] ?? '*Model bias, explainability, fairness.*'));
  lines.push(contentSection('Policy Gaps', c['gaps'] ?? c['policy_gaps'] ?? '*Areas where current policies are insufficient.*'));
  lines.push(contentSection('Remediation Recommendations', c['remediation'] ?? c['recommendations'] ?? '*Prioritized remediation steps.*'));

  lines.push(confidenceFooter(ctx.relevantNodes));
  lines.push('\n**Quality Criteria:** Regulatory frameworks detected from business context and geography, not hardcoded.');
  return lines.join('\n');
};

// ============================================================================
// Artifact 8: Implementation Roadmap
// ============================================================================

export const renderImplementationRoadmap: ArtifactRenderer = (ctx) => {
  const lines: string[] = [];
  lines.push(header('Implementation Roadmap', 8, 'Documentation Generator Agent', 5, 'Accenture delivery plan / Capgemini implementation roadmap', ctx.timestamp));
  if (ctx.isDegraded) lines.push(degradedBanner());

  const c = allContentMerged(ctx.relevantNodes);

  lines.push(contentSection('Phase 1 \u2014 Pilot', c['phase1'] ?? c['pilot'] ?? '*Scope, duration, success criteria.*'));
  lines.push(contentSection('Phase 2 \u2014 Department Rollout', c['phase2'] ?? c['rollout'] ?? '*Expansion plan, prerequisites.*'));
  lines.push(contentSection('Phase 3 \u2014 Enterprise Deployment', c['phase3'] ?? c['enterprise'] ?? '*Full scale, operational handoff.*'));
  lines.push(contentSection('Milestones & Deliverables', c['milestones'] ?? '*Per-phase milestones.*'));
  lines.push(contentSection('Dependencies & Prerequisites', c['dependencies'] ?? c['prerequisites'] ?? '*Cross-workstream dependencies.*'));
  lines.push(contentSection('Resource Requirements', c['resources'] ?? c['resource_requirements'] ?? '*Per-phase resource needs.*'));
  lines.push(contentSection('Go/No-Go Criteria', c['go_no_go'] ?? c['criteria'] ?? '*Measurable criteria between phases.*'));

  lines.push(confidenceFooter(ctx.relevantNodes));
  lines.push('\n**Quality Criteria:** Phases reference specific architecture components. Durations grounded in complexity analysis.');
  return lines.join('\n');
};

// ============================================================================
// Artifact 9: Organizational Impact Analysis
// ============================================================================

export const renderOrganizationalImpact: ArtifactRenderer = (ctx) => {
  const lines: string[] = [];
  lines.push(header('Organizational Impact Analysis', 9, 'Documentation Generator Agent', 5, 'McKinsey change management assessment', ctx.timestamp));
  if (ctx.isDegraded) lines.push(degradedBanner());

  const c = allContentMerged(ctx.relevantNodes);

  lines.push(contentSection('Teams Affected', c['teams'] ?? c['teams_affected'] ?? '*IT, data engineering, operations, compliance, business units.*'));
  lines.push(contentSection('Process Changes Required', c['process_changes'] ?? c['changes'] ?? '*Workflow modifications and new processes.*'));
  lines.push(contentSection('Training Requirements', c['training'] ?? c['training_requirements'] ?? '*New tools, governance workflows, monitoring.*'));
  lines.push(contentSection('Change Management Risks', c['change_risks'] ?? c['risks'] ?? '*Adoption barriers and resistance factors.*'));
  lines.push(contentSection('Communication Plan Outline', c['communication'] ?? c['communication_plan'] ?? '*Stakeholder communication strategy.*'));
  lines.push(contentSection('Organizational Readiness Score', c['readiness_score'] ?? c['readiness'] ?? '*0-100 based on change magnitude vs. capacity.*'));

  lines.push(confidenceFooter(ctx.relevantNodes));
  lines.push('\n**Quality Criteria:** Teams and processes derived from architecture and integration map, not generic templates.');
  return lines.join('\n');
};

// ============================================================================
// Artifact 10: Stakeholder Map
// ============================================================================

export const renderStakeholderMap: ArtifactRenderer = (ctx) => {
  const lines: string[] = [];
  lines.push(header('Stakeholder Map', 10, 'Documentation Generator Agent', 5, 'RACI matrix / governance stakeholder map', ctx.timestamp));
  if (ctx.isDegraded) lines.push(degradedBanner());

  const c = allContentMerged(ctx.relevantNodes);

  lines.push('### RACI Matrix\n');
  lines.push('| Activity | Responsible | Accountable | Consulted | Informed |');
  lines.push('|----------|------------|-------------|-----------|----------|');
  const raci = c['raci'] ?? c['raci_matrix'];
  if (Array.isArray(raci)) {
    for (const row of raci) {
      if (typeof row === 'object' && row !== null) {
        const r = row as Record<string, unknown>;
        lines.push(`| ${r['activity'] ?? '-'} | ${r['responsible'] ?? '-'} | ${r['accountable'] ?? '-'} | ${r['consulted'] ?? '-'} | ${r['informed'] ?? '-'} |`);
      }
    }
  } else {
    lines.push('| *To be determined from organizational analysis* | - | - | - | - |');
  }
  lines.push('');

  lines.push(contentSection('Executive Sponsor', c['executive_sponsor'] ?? '*CIO/CTO identification.*'));
  lines.push(contentSection('Technical Owners', c['technical_owners'] ?? '*Platform engineering leads.*'));
  lines.push(contentSection('Governance & Compliance', c['governance'] ?? c['compliance_stakeholders'] ?? '*Security, compliance, legal.*'));
  lines.push(contentSection('Business Stakeholders', c['business'] ?? c['business_stakeholders'] ?? '*Operations leadership.*'));
  lines.push(contentSection('External Partners / Vendors', c['external'] ?? c['vendors'] ?? '*Third-party dependencies.*'));
  lines.push(contentSection('Decision Authority Chain', c['authority'] ?? c['decision_chain'] ?? '*Approval hierarchy.*'));

  lines.push(confidenceFooter(ctx.relevantNodes));
  lines.push('\n**Quality Criteria:** Roles mapped to actual organizational functions identified in the problem context.');
  return lines.join('\n');
};

// ============================================================================
// Artifact 11: Success Metrics & KPIs
// ============================================================================

export const renderSuccessMetrics: ArtifactRenderer = (ctx) => {
  const lines: string[] = [];
  lines.push(header('Success Metrics & KPIs', 11, 'Documentation Generator Agent', 5, 'Balanced scorecard / KPI framework', ctx.timestamp));
  if (ctx.isDegraded) lines.push(degradedBanner());

  const c = allContentMerged(ctx.relevantNodes);

  lines.push('### KPI Dashboard\n');
  lines.push('| Category | KPI | Baseline | Target | Measurement |');
  lines.push('|----------|-----|----------|--------|-------------|');
  const kpis = c['kpis'] ?? c['metrics'];
  if (Array.isArray(kpis)) {
    for (const k of kpis) {
      if (typeof k === 'object' && k !== null) {
        const kpi = k as Record<string, unknown>;
        lines.push(`| ${kpi['category'] ?? '-'} | ${kpi['name'] ?? kpi['kpi'] ?? '-'} | ${kpi['baseline'] ?? '-'} | ${kpi['target'] ?? '-'} | ${kpi['measurement'] ?? '-'} |`);
      }
    }
  } else {
    lines.push('| *To be defined* | - | - | - | - |');
  }
  lines.push('');

  lines.push(contentSection('Operational KPIs', c['operational'] ?? c['operational_kpis'] ?? '*Efficiency improvement %, system uptime, latency targets.*'));
  lines.push(contentSection('Financial KPIs', c['financial'] ?? c['financial_kpis'] ?? '*Cost reduction, revenue impact, ROI realization.*'));
  lines.push(contentSection('Quality KPIs', c['quality'] ?? c['quality_kpis'] ?? '*Error rates, customer satisfaction, SLA adherence.*'));
  lines.push(contentSection('Adoption KPIs', c['adoption'] ?? c['adoption_kpis'] ?? '*User onboarding, feature utilization.*'));

  lines.push(confidenceFooter(ctx.relevantNodes));
  lines.push('\n**Quality Criteria:** KPIs linked to specific architecture components and CostOps projections. Baselines require current-state data or clearly stated assumptions.');
  return lines.join('\n');
};

// ============================================================================
// Artifact 12: Decision Confidence Score
// ============================================================================

export const renderConfidenceScore: ArtifactRenderer = (ctx) => {
  const lines: string[] = [];
  lines.push(header('Decision Confidence Score', 12, 'Decision + Risk Agents', 5, 'Unique to Agentics', ctx.timestamp));
  if (ctx.isDegraded) lines.push(degradedBanner());

  const c = allContentMerged(ctx.relevantNodes);

  const overall = c['overall'] ?? c['score'] ?? '*Computed from pass outputs.*';
  lines.push(`## Overall Confidence Score: ${overall}%\n`);

  lines.push('### Component Scores\n');
  lines.push('| Component | Score | Source |');
  lines.push('|-----------|-------|--------|');
  lines.push(`| Financial Outcome Stability | ${c['financial'] ?? '-'} | CostOps (Pass 4) |`);
  lines.push(`| Operational Risk Level | ${c['operational'] ?? '-'} | Sentinel + Risk Assessment |`);
  lines.push(`| Compliance Exposure | ${c['compliance'] ?? '-'} | Shield + Policy Engine |`);
  lines.push(`| Architecture Feasibility | ${c['architecture'] ?? '-'} | Simulation + Prototype |`);
  lines.push(`| Organizational Readiness | ${c['organizational'] ?? '-'} | Impact Analysis |`);
  lines.push('');

  lines.push(contentSection('Score Methodology', c['methodology'] ?? '*Weighted aggregation: Financial 25%, Operational 20%, Compliance 20%, Architecture 20%, Organizational 15%.*'));

  if (ctx.passesDegraded.length > 0) {
    lines.push(`### Degradation Notes\n\nThe following passes completed in degraded mode, reducing the confidence score:\n`);
    for (const p of ctx.passesDegraded) {
      lines.push(`- Pass ${p}: -10% penalty applied`);
    }
    lines.push('');
  }

  const rec = c['recommendation'] ?? c['final_recommendation'] ?? '*See DECISION_PACKAGE.md.*';
  lines.push(contentSection('Final Recommendation', rec));

  lines.push('\n**Quality Criteria:** Score computed from actual pass outputs, not estimated. Degraded passes explicitly reduce the score.');
  return lines.join('\n');
};

// ============================================================================
// Artifact 13: OKRs & Strategic Alignment
// ============================================================================

export const renderOKRs: ArtifactRenderer = (ctx) => {
  const lines: string[] = [];
  lines.push(header('OKRs & Strategic Alignment', 13, 'Documentation Generator Agent', 5, 'McKinsey/Capgemini strategic transformation deliverable', ctx.timestamp));
  if (ctx.isDegraded) lines.push(degradedBanner());

  const c = allContentMerged(ctx.relevantNodes);

  lines.push(contentSection('Strategic Objectives', c['objectives'] ?? c['strategic_objectives'] ?? '*3-5 high-level objectives aligned to organizational strategy.*'));

  lines.push('### Key Results\n');
  const keyResults = c['key_results'] ?? c['results'];
  if (Array.isArray(keyResults)) {
    for (const kr of keyResults) {
      if (typeof kr === 'object' && kr !== null) {
        const r = kr as Record<string, unknown>;
        lines.push(`- **${r['objective'] ?? 'Objective'}:** ${r['key_result'] ?? r['result'] ?? '-'} (Target: ${r['target'] ?? '-'}, Due: ${r['due'] ?? '-'})`);
      } else {
        lines.push(`- ${String(kr)}`);
      }
    }
  } else {
    lines.push('*Key results to be defined per strategic objective.*');
  }
  lines.push('');

  lines.push(contentSection('Quarterly Milestones', c['milestones'] ?? c['quarterly_milestones'] ?? '*Q1-Q4 targets mapped to implementation roadmap phases.*'));
  lines.push(contentSection('Strategic Initiative Mapping', c['initiative_mapping'] ?? c['strategic_mapping'] ?? '*How this project connects to broader organizational initiatives.*'));
  lines.push(contentSection('Alignment Score', c['alignment_score'] ?? c['alignment'] ?? '*Percentage of strategic priorities addressed.*'));
  lines.push(contentSection('Cross-Program Dependencies', c['dependencies'] ?? c['cross_program'] ?? '*Dependencies on other organizational initiatives.*'));

  lines.push(confidenceFooter(ctx.relevantNodes));
  lines.push('\n**Quality Criteria:** Objectives derived from business context in Pass 1. Key results quantified and traceable to KPIs and CostOps projections.');
  return lines.join('\n');
};

// ============================================================================
// Artifact 14: RAID Log
// ============================================================================

export const renderRAIDLog: ArtifactRenderer = (ctx) => {
  const lines: string[] = [];
  lines.push(header('RAID Log', 14, 'Documentation Generator Agent', 5, 'CGI/Accenture PMO standard deliverable', ctx.timestamp));
  if (ctx.isDegraded) lines.push(degradedBanner());

  const c = allContentMerged(ctx.relevantNodes);

  // Risks
  lines.push('## Risks\n');
  lines.push('| ID | Risk | Category | Severity | Phase | Status | Mitigation |');
  lines.push('|----|------|----------|----------|-------|--------|------------|');
  const risks = c['risks'] ?? [];
  if (Array.isArray(risks)) {
    for (let i = 0; i < risks.length; i++) {
      const r = risks[i] as Record<string, unknown> | string;
      if (typeof r === 'object' && r !== null) {
        lines.push(`| R${i + 1} | ${r['risk'] ?? r['name'] ?? '-'} | ${r['category'] ?? '-'} | ${r['severity'] ?? '-'} | ${r['phase'] ?? '-'} | ${r['status'] ?? 'Open'} | ${r['mitigation'] ?? '-'} |`);
      } else {
        lines.push(`| R${i + 1} | ${String(r)} | - | - | - | Open | - |`);
      }
    }
  }
  lines.push('');

  // Assumptions
  lines.push('## Assumptions\n');
  lines.push('| ID | Assumption | Source Pass | Falsifiable | Status |');
  lines.push('|----|-----------|------------|-------------|--------|');
  const assumptions = c['assumptions'] ?? [];
  if (Array.isArray(assumptions)) {
    for (let i = 0; i < assumptions.length; i++) {
      const a = assumptions[i] as Record<string, unknown> | string;
      if (typeof a === 'object' && a !== null) {
        lines.push(`| A${i + 1} | ${a['assumption'] ?? a['name'] ?? '-'} | ${a['source_pass'] ?? a['pass'] ?? '-'} | ${a['falsifiable'] ?? 'Yes'} | ${a['status'] ?? 'Open'} |`);
      } else {
        lines.push(`| A${i + 1} | ${String(a)} | - | Yes | Open |`);
      }
    }
  }
  lines.push('');

  // Issues
  lines.push('## Issues\n');
  lines.push('| ID | Issue | Priority | Owner | Status |');
  lines.push('|----|-------|----------|-------|--------|');
  const issues = c['issues'] ?? [];
  if (Array.isArray(issues)) {
    for (let i = 0; i < issues.length; i++) {
      const issue = issues[i] as Record<string, unknown> | string;
      if (typeof issue === 'object' && issue !== null) {
        lines.push(`| I${i + 1} | ${issue['issue'] ?? issue['name'] ?? '-'} | ${issue['priority'] ?? '-'} | ${issue['owner'] ?? '-'} | ${issue['status'] ?? 'Open'} |`);
      } else {
        lines.push(`| I${i + 1} | ${String(issue)} | - | - | Open |`);
      }
    }
  }
  lines.push('');

  // Dependencies
  lines.push('## Dependencies\n');
  lines.push('| ID | Dependency | Type | Owner | Due Date | Status |');
  lines.push('|----|-----------|------|-------|----------|--------|');
  const deps = c['dependencies'] ?? [];
  if (Array.isArray(deps)) {
    for (let i = 0; i < deps.length; i++) {
      const d = deps[i] as Record<string, unknown> | string;
      if (typeof d === 'object' && d !== null) {
        lines.push(`| D${i + 1} | ${d['dependency'] ?? d['name'] ?? '-'} | ${d['type'] ?? '-'} | ${d['owner'] ?? '-'} | ${d['due_date'] ?? d['due'] ?? '-'} | ${d['status'] ?? 'Open'} |`);
      } else {
        lines.push(`| D${i + 1} | ${String(d)} | - | - | - | Open |`);
      }
    }
  }
  lines.push('');

  lines.push(confidenceFooter(ctx.relevantNodes));
  lines.push('\n**Quality Criteria:** Every entry traced to a specific pipeline pass and agent output. Assumptions are falsifiable. Dependencies have identified owners.');
  return lines.join('\n');
};

// ============================================================================
// Registry: Artifact Number → Renderer
// ============================================================================

export const ARTIFACT_RENDERERS: Readonly<Record<number, ArtifactRenderer>> = {
  1: renderExecutiveDecisionMemo,
  2: renderExecutiveSummary,
  3: renderArchitectureSpec,
  4: renderSimulationAnalysis,
  5: renderRiskAssessment,
  6: renderCostOpsFinancialModel,
  7: renderComplianceAnalysis,
  8: renderImplementationRoadmap,
  9: renderOrganizationalImpact,
  10: renderStakeholderMap,
  11: renderSuccessMetrics,
  12: renderConfidenceScore,
  13: renderOKRs,
  14: renderRAIDLog,
  // 15 = Provenance Manifest — handled by ProvenanceTracker, not a renderer
};
