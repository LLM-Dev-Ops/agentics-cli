/**
 * Artifact Assembler — Deterministic Enterprise Decision Package (ADR-034)
 *
 * Assembles the 15 deterministic enterprise artifacts from DecisionGraph
 * nodes using per-artifact structured renderers. Writes:
 *   1. Individual .md files (one per artifact)
 *   2. DecisionGraph nodes (each artifact stored as a graph node)
 *   3. DECISION_PACKAGE.md index with links and status
 *
 * Handles partial pipelines and degraded artifacts per the ADR spec.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import type {
  PassNumber,
  ArtifactNumber,
  ArtifactEntry,
  ArtifactStatus,
  DecisionPackage,
  DecisionNodeType,
  PassOutput,
} from './types.js';
import { DecisionGraph } from './decision-graph.js';
import { ProvenanceTracker } from './provenance-tracker.js';
import { ARTIFACT_RENDERERS } from './artifact-renderers.js';
import type { RenderContext } from './artifact-renderers.js';

// ============================================================================
// Artifact Definitions (ADR-034 — 15 deterministic artifacts)
// ============================================================================

/** Full artifact definition with ADR-034 metadata. */
export interface ArtifactDefinition {
  readonly number: ArtifactNumber;
  readonly name: string;
  readonly filename: string;
  readonly producingPass: PassNumber;
  readonly producingAgent: string;
  readonly consultingAnalogy: string;
  readonly nodeTypes: readonly DecisionNodeType[];
  /** Required passes — artifact requires at least one of these passes to have completed. */
  readonly requiredPasses: readonly PassNumber[];
  /** The DecisionGraph node type used to store this artifact's content. */
  readonly graphNodeType: DecisionNodeType;
  /** Quality criteria from ADR-034. */
  readonly qualityCriteria: string;
}

export const ARTIFACT_DEFINITIONS: readonly ArtifactDefinition[] = [
  {
    number: 1, name: 'Executive Decision Memo', filename: '01-executive-decision-memo.md',
    producingPass: 5, producingAgent: 'Decision Memo Agent',
    consultingAnalogy: 'McKinsey decision document',
    nodeTypes: ['executive_memo'],
    requiredPasses: [5], graphNodeType: 'executive_memo',
    qualityCriteria: 'Must reference specific outputs from Passes 2-4. No generic boilerplate.',
  },
  {
    number: 2, name: 'Executive Summary', filename: '02-executive-summary.md',
    producingPass: 5, producingAgent: 'Executive Summary Agent',
    consultingAnalogy: 'Board briefing document',
    nodeTypes: ['executive_summary'],
    requiredPasses: [5], graphNodeType: 'executive_summary',
    qualityCriteria: 'Max 2 pages. Written for non-technical executive audience.',
  },
  {
    number: 3, name: 'Architecture & Prototype Specification', filename: '03-architecture-prototype-spec.md',
    producingPass: 3, producingAgent: 'Orchestrator + Forge Agents',
    consultingAnalogy: 'Accenture technology blueprint',
    nodeTypes: ['system_architecture', 'prototype', 'integration_map', 'service_boundary'],
    requiredPasses: [3], graphNodeType: 'system_architecture',
    qualityCriteria: 'Architecture must reflect detected ERP system and domain model. Prototype must have at least one functional endpoint.',
  },
  {
    number: 4, name: 'Simulation & Scenario Analysis', filename: '04-simulation-scenario-analysis.md',
    producingPass: 2, producingAgent: 'Simulator Agents',
    consultingAnalogy: 'CGI scenario modeling report',
    nodeTypes: ['scenario', 'reliability_report', 'risk_signal'],
    requiredPasses: [2], graphNodeType: 'scenario',
    qualityCriteria: '3+ distinct scenarios. Each scenario has quantified probability and impact.',
  },
  {
    number: 5, name: 'Risk Assessment', filename: '05-risk-assessment.md',
    producingPass: 5, producingAgent: 'Risk Scoring Agent',
    consultingAnalogy: 'Deloitte risk register',
    nodeTypes: ['risk_assessment', 'risk_signal'],
    requiredPasses: [2, 4], graphNodeType: 'risk_assessment',
    qualityCriteria: 'Risks sourced from Sentinel (Pass 2) and Shield/Policy (Pass 4). No invented risks.',
  },
  {
    number: 6, name: 'CostOps Financial Model', filename: '06-costops-financial-model.md',
    producingPass: 4, producingAgent: 'CostOps Agents',
    consultingAnalogy: 'Capgemini TCO/ROI financial model',
    nodeTypes: ['cost_model'],
    requiredPasses: [4], graphNodeType: 'cost_model',
    qualityCriteria: 'Costs derived from architecture (Pass 3) and simulation (Pass 2). ROI includes sensitivity analysis.',
  },
  {
    number: 7, name: 'Compliance & Policy Analysis', filename: '07-compliance-policy-analysis.md',
    producingPass: 4, producingAgent: 'Shield + Policy Engine Agents',
    consultingAnalogy: 'PwC regulatory assessment',
    nodeTypes: ['compliance_report', 'policy_analysis', 'security_analysis'],
    requiredPasses: [4], graphNodeType: 'compliance_report',
    qualityCriteria: 'Regulatory frameworks detected from business context and geography, not hardcoded.',
  },
  {
    number: 8, name: 'Implementation Roadmap', filename: '08-implementation-roadmap.md',
    producingPass: 5, producingAgent: 'Documentation Generator Agent',
    consultingAnalogy: 'Accenture delivery plan / Capgemini implementation roadmap',
    nodeTypes: ['implementation_roadmap'],
    requiredPasses: [3, 5], graphNodeType: 'implementation_roadmap',
    qualityCriteria: 'Phases reference specific architecture components. Durations grounded in complexity analysis.',
  },
  {
    number: 9, name: 'Organizational Impact Analysis', filename: '09-organizational-impact.md',
    producingPass: 5, producingAgent: 'Documentation Generator Agent',
    consultingAnalogy: 'McKinsey change management assessment',
    nodeTypes: ['org_impact'],
    requiredPasses: [3, 5], graphNodeType: 'org_impact',
    qualityCriteria: 'Teams and processes derived from architecture and integration map, not generic templates.',
  },
  {
    number: 10, name: 'Stakeholder Map', filename: '10-stakeholder-map.md',
    producingPass: 5, producingAgent: 'Documentation Generator Agent',
    consultingAnalogy: 'RACI matrix / governance stakeholder map',
    nodeTypes: ['stakeholder_map'],
    requiredPasses: [1, 5], graphNodeType: 'stakeholder_map',
    qualityCriteria: 'Roles mapped to actual organizational functions identified in the problem context.',
  },
  {
    number: 11, name: 'Success Metrics & KPIs', filename: '11-success-metrics-kpis.md',
    producingPass: 5, producingAgent: 'Documentation Generator Agent',
    consultingAnalogy: 'Balanced scorecard / KPI framework',
    nodeTypes: ['kpi_definition'],
    requiredPasses: [4, 5], graphNodeType: 'kpi_definition',
    qualityCriteria: 'KPIs linked to architecture components and CostOps projections. Baselines require current-state data or stated assumptions.',
  },
  {
    number: 12, name: 'Decision Confidence Score', filename: '12-decision-confidence-score.md',
    producingPass: 5, producingAgent: 'Decision + Risk Agents',
    consultingAnalogy: 'Unique to Agentics',
    nodeTypes: ['confidence_score'],
    requiredPasses: [2, 3, 4, 5], graphNodeType: 'confidence_score',
    qualityCriteria: 'Score computed from actual pass outputs, not estimated. Degraded passes explicitly reduce the score.',
  },
  {
    number: 13, name: 'OKRs & Strategic Alignment', filename: '13-okrs-strategic-alignment.md',
    producingPass: 5, producingAgent: 'Documentation Generator Agent',
    consultingAnalogy: 'McKinsey/Capgemini strategic transformation deliverable',
    nodeTypes: ['okr_alignment'],
    requiredPasses: [1, 5], graphNodeType: 'okr_alignment',
    qualityCriteria: 'Objectives derived from business context in Pass 1. Key results quantified and traceable to KPIs and CostOps.',
  },
  {
    number: 14, name: 'RAID Log', filename: '14-raid-log.md',
    producingPass: 5, producingAgent: 'Documentation Generator Agent',
    consultingAnalogy: 'CGI/Accenture PMO standard deliverable',
    nodeTypes: ['raid_log'],
    requiredPasses: [2, 4, 5], graphNodeType: 'raid_log',
    qualityCriteria: 'Every entry traced to a specific pipeline pass and agent output. Assumptions falsifiable. Dependencies have owners.',
  },
  {
    number: 15, name: 'Agent & Code Provenance Manifest', filename: '15-provenance-manifest.md',
    producingPass: 5, producingAgent: 'Pipeline Orchestrator (auto)',
    consultingAnalogy: 'Engagement methodology & tools appendix',
    nodeTypes: ['provenance_manifest'],
    requiredPasses: [], graphNodeType: 'provenance_manifest',
    qualityCriteria: 'Auto-generated from runtime tracing (ADR-039). Not manually authored.',
  },
];

// ============================================================================
// Assembler Options
// ============================================================================

/** Options for the assemble method. */
export interface AssembleOptions {
  readonly prompt: string;
  readonly passOutputs: readonly PassOutput[];
  readonly passesDegraded: readonly PassNumber[];
  /** Passes that were actually executed (for partial pipeline tracking). */
  readonly passesExecuted?: readonly PassNumber[];
}

// ============================================================================
// Artifact Assembler
// ============================================================================

export class ArtifactAssembler {
  private readonly graph: DecisionGraph;
  private readonly tracker: ProvenanceTracker;
  private readonly outputDir: string;
  private readonly executionId: string;

  constructor(
    graph: DecisionGraph,
    tracker: ProvenanceTracker,
    outputDir: string,
    executionId: string,
  ) {
    this.graph = graph;
    this.tracker = tracker;
    this.outputDir = outputDir;
    this.executionId = executionId;
  }

  /**
   * Assemble all 15 artifacts and write to outputDir.
   * Returns the decision package metadata.
   */
  assemble(params: AssembleOptions): DecisionPackage {
    const artifactDir = path.join(this.outputDir, this.executionId);
    fs.mkdirSync(artifactDir, { recursive: true });

    const timestamp = new Date().toISOString();
    const allNodes = this.graph.getAllNodes();

    // Determine which passes were actually executed
    const executedPasses = new Set<PassNumber>(
      params.passesExecuted ?? params.passOutputs.map(p => p.passNumber),
    );

    const entries: ArtifactEntry[] = [];

    for (const def of ARTIFACT_DEFINITIONS) {
      const entry = this.assembleArtifact(def, artifactDir, timestamp, allNodes, params.passesDegraded, executedPasses, params.prompt);
      entries.push(entry);
    }

    // Compute confidence score
    const confidenceScore = this.computeConfidenceScore(params.passOutputs, params.passesDegraded);

    // Determine recommendation
    const recommendation = this.computeRecommendation(confidenceScore);

    // Build and write DECISION_PACKAGE.md index
    const pkg: DecisionPackage = {
      executionId: this.executionId,
      timestamp,
      prompt: params.prompt,
      confidenceScore,
      recommendation,
      artifacts: entries,
      passesExecuted: params.passOutputs.length,
      passesDegraded: params.passesDegraded,
      totalAgentsInvoked: this.tracker.getAllRecords().length,
      totalDurationMs: this.tracker.getTotalDuration(),
    };

    this.writePackageIndex(pkg, artifactDir);

    return pkg;
  }

  // --------------------------------------------------------------------------
  // Individual Artifact Assembly
  // --------------------------------------------------------------------------

  private assembleArtifact(
    def: ArtifactDefinition,
    artifactDir: string,
    timestamp: string,
    allNodes: readonly import('./types.js').DecisionGraphNode[],
    passesDegraded: readonly PassNumber[],
    executedPasses: ReadonlySet<PassNumber>,
    prompt: string,
  ): ArtifactEntry {
    // Special case: Provenance Manifest (auto-generated by tracker)
    if (def.number === 15) {
      return this.assembleProvenanceManifest(def, artifactDir, passesDegraded);
    }

    // Check if required passes were executed (partial pipeline handling)
    const missingPasses = def.requiredPasses.filter(p => !executedPasses.has(p));
    if (missingPasses.length > 0 && def.requiredPasses.length > 0) {
      // Check if at least one required pass ran
      const anyRequiredRan = def.requiredPasses.some(p => executedPasses.has(p));
      if (!anyRequiredRan) {
        const reason = `Requires ${missingPasses.length > 1 ? 'Passes' : 'Pass'} ${missingPasses.join(', ')} which ${missingPasses.length > 1 ? 'were' : 'was'} not executed`;
        this.writeArtifactFile(artifactDir, def.filename, this.buildNotGeneratedContent(def, reason));
        return {
          number: def.number,
          name: def.name,
          filename: def.filename,
          status: 'not_generated',
          producingPass: def.producingPass,
          producingAgent: def.producingAgent,
          degradationReason: reason,
        };
      }
    }

    // Find relevant nodes in the graph
    const relevantNodes = def.nodeTypes.flatMap(t =>
      this.graph.getNodesByType(t),
    );

    // Check if producing pass was degraded
    const producingPassDegraded = passesDegraded.includes(def.producingPass);

    if (relevantNodes.length === 0) {
      const status: ArtifactStatus = producingPassDegraded ? 'degraded' : 'not_generated';
      const reason = producingPassDegraded
        ? `Pass ${def.producingPass} completed in degraded mode — insufficient data for ${def.name}`
        : `Pass ${def.producingPass} did not produce ${def.nodeTypes.join(', ')} nodes`;

      this.writeArtifactFile(artifactDir, def.filename,
        status === 'degraded'
          ? this.buildDegradedContent(def, reason, timestamp)
          : this.buildNotGeneratedContent(def, reason),
      );

      return {
        number: def.number,
        name: def.name,
        filename: def.filename,
        status,
        producingPass: def.producingPass,
        producingAgent: def.producingAgent,
        degradationReason: reason,
      };
    }

    // Build content using per-artifact renderer
    const anyDegraded = relevantNodes.some(n => n.status === 'degraded') || producingPassDegraded;

    const renderCtx: RenderContext = {
      executionId: this.executionId,
      prompt,
      timestamp,
      allNodes,
      relevantNodes,
      isDegraded: anyDegraded,
      passesDegraded,
    };

    const renderer = ARTIFACT_RENDERERS[def.number];
    let content: string;
    if (renderer) {
      content = renderer(renderCtx);
    } else {
      // Fallback for artifacts without a dedicated renderer
      content = this.buildGenericContent(def, relevantNodes, timestamp, anyDegraded);
    }

    this.writeArtifactFile(artifactDir, def.filename, content);

    // Write artifact as a DecisionGraph node (ADR-034: "each artifact is a node")
    if (this.graph.isWritable()) {
      this.graph.createNode({
        type: def.graphNodeType,
        name: `Artifact #${def.number}: ${def.name}`,
        content: { artifactNumber: def.number, filename: def.filename, nodeCount: relevantNodes.length },
        summary: `${def.name} — ${def.consultingAnalogy}. ${relevantNodes.length} source node(s).`,
        producedBy: { domain: 'pipeline', agent: 'artifact-assembler', role: 'Artifact Assembler' },
        pass: def.producingPass,
        derivedFrom: relevantNodes.map(n => n.id).slice(0, 10),
        confidence: anyDegraded ? 0.5 : 0.9,
        status: anyDegraded ? 'degraded' : 'complete',
        tags: [`artifact:${def.number}`, `consulting:${def.consultingAnalogy.split(' ')[0]!.toLowerCase()}`],
      });
    }

    return {
      number: def.number,
      name: def.name,
      filename: def.filename,
      status: anyDegraded ? 'degraded' : 'complete',
      producingPass: def.producingPass,
      producingAgent: def.producingAgent,
      degradationReason: anyDegraded ? 'Some source data was degraded' : undefined,
    };
  }

  private assembleProvenanceManifest(
    def: ArtifactDefinition,
    artifactDir: string,
    passesDegraded: readonly PassNumber[],
  ): ArtifactEntry {
    const artifactOwnership = ARTIFACT_DEFINITIONS.map(d => ({
      number: d.number,
      name: d.name,
      agent: d.producingAgent,
      pass: d.producingPass,
    }));

    const manifest = this.tracker.generateManifest({
      passesCompleted: 7 - passesDegraded.length,
      passesDegraded,
      artifactOwnership,
    });

    this.writeArtifactFile(artifactDir, def.filename, manifest);

    return {
      number: def.number,
      name: def.name,
      filename: def.filename,
      status: 'complete',
      producingPass: def.producingPass,
      producingAgent: def.producingAgent,
    };
  }

  // --------------------------------------------------------------------------
  // Content Builders (fallback + degraded/not-generated)
  // --------------------------------------------------------------------------

  /** Generic fallback content for artifacts without a dedicated renderer. */
  private buildGenericContent(
    def: ArtifactDefinition,
    nodes: readonly import('./types.js').DecisionGraphNode[],
    timestamp: string,
    isDegraded: boolean,
  ): string {
    const lines: string[] = [];
    lines.push(`# ${def.name}`);
    lines.push(`**Artifact #${def.number}** | **Pass:** ${def.producingPass} | **Producing Agent:** ${def.producingAgent}`);
    lines.push(`**Consulting Analogy:** ${def.consultingAnalogy}`);
    lines.push(`**Generated:** ${timestamp}`);
    lines.push('');

    if (isDegraded) {
      lines.push('> **\u26a0\ufe0f DEGRADED** \u2014 Some source data was unavailable or unreliable.\n');
    }

    for (const node of nodes) {
      lines.push(`## ${node.name}`);
      lines.push('');
      if (node.summary) lines.push(node.summary + '\n');

      for (const [key, value] of Object.entries(node.content)) {
        lines.push(`### ${formatKey(key)}`);
        lines.push('');
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
        } else {
          lines.push(String(value));
        }
        lines.push('');
      }

      lines.push(`**Confidence:** ${(node.confidence * 100).toFixed(0)}%`);
      lines.push('\n---\n');
    }

    lines.push(`\n**Quality Criteria:** ${def.qualityCriteria}`);
    return lines.join('\n');
  }

  /** Content for degraded artifacts (pass ran but data insufficient). */
  private buildDegradedContent(def: ArtifactDefinition, reason: string, timestamp: string): string {
    return [
      `# ${def.name}`,
      `**Artifact #${def.number}** | **Pass:** ${def.producingPass} | **Producing Agent:** ${def.producingAgent}`,
      `**Consulting Analogy:** ${def.consultingAnalogy}`,
      `**Generated:** ${timestamp}`,
      `**Status:** DEGRADED`,
      '',
      `> **\u26a0\ufe0f DEGRADED** \u2014 ${reason}`,
      '',
      'This artifact was generated with incomplete data. The producing pass completed',
      'in degraded mode, meaning some agents failed or returned insufficient results.',
      '',
      `**Quality Criteria:** ${def.qualityCriteria}`,
      '',
      `To regenerate with full data, re-run Pass ${def.producingPass} with all agents operational.`,
    ].join('\n');
  }

  /** Content for artifacts that could not be generated (pass not run). */
  private buildNotGeneratedContent(def: ArtifactDefinition, reason: string): string {
    return [
      `# ${def.name}`,
      `**Artifact #${def.number}** | **Pass:** ${def.producingPass} | **Producing Agent:** ${def.producingAgent}`,
      `**Consulting Analogy:** ${def.consultingAnalogy}`,
      `**Status:** NOT GENERATED`,
      '',
      `> **\u274c NOT GENERATED** \u2014 ${reason}`,
      '',
      'This artifact requires specific pipeline passes to complete successfully.',
      `Required passes: ${def.requiredPasses.join(', ') || 'None'}`,
      '',
      `To generate this artifact, run: \`agentics ask "<prompt>" --passes ${def.requiredPasses.join(',') || '1-7'}\``,
    ].join('\n');
  }

  // --------------------------------------------------------------------------
  // Confidence Score (ADR-034 / ADR-037)
  // --------------------------------------------------------------------------

  private computeConfidenceScore(
    passOutputs: readonly PassOutput[],
    passesDegraded: readonly PassNumber[],
  ): number {
    // Weighted components per ADR-037
    const weights = {
      financial: 0.25,
      operational: 0.20,
      compliance: 0.20,
      architecture: 0.20,
      organizational: 0.15,
    };

    const getPassScore = (pass: PassNumber): number => {
      const output = passOutputs.find(p => p.passNumber === pass);
      if (!output) return 0;
      if (output.status === 'completed') return 1.0;
      if (output.status === 'degraded') return 0.5;
      return 0;
    };

    const financialScore = getPassScore(4);
    const operationalScore = getPassScore(2);
    const complianceScore = getPassScore(4);
    const architectureScore = (getPassScore(2) + getPassScore(3)) / 2;
    const organizationalScore = getPassScore(5);

    const raw =
      financialScore * weights.financial +
      operationalScore * weights.operational +
      complianceScore * weights.compliance +
      architectureScore * weights.architecture +
      organizationalScore * weights.organizational;

    // -10% per degraded pass
    const penalty = passesDegraded.length * 0.10;
    const score = Math.max(0, Math.min(1, raw - penalty));

    return Math.round(score * 100);
  }

  private computeRecommendation(score: number): DecisionPackage['recommendation'] {
    if (score >= 80) return 'proceed';
    if (score >= 60) return 'proceed-with-conditions';
    if (score >= 40) return 'investigate-further';
    return 'do-not-proceed';
  }

  // --------------------------------------------------------------------------
  // Package Index (DECISION_PACKAGE.md)
  // --------------------------------------------------------------------------

  private writePackageIndex(pkg: DecisionPackage, artifactDir: string): void {
    const lines: string[] = [];

    lines.push('# Agentics Decision Package');
    lines.push('');
    lines.push(`**Execution ID:** ${pkg.executionId}`);
    lines.push(`**Date:** ${pkg.timestamp}`);
    lines.push(`**Prompt:** ${pkg.prompt}`);
    lines.push(`**Decision Confidence Score:** ${pkg.confidenceScore}%`);
    lines.push(`**Recommendation:** ${formatRecommendation(pkg.recommendation)}`);
    lines.push('');

    // Artifact table
    lines.push('## Artifacts');
    lines.push('');
    lines.push('| # | Artifact | Status | Consulting Analogy | File |');
    lines.push('|---|----------|--------|--------------------|------|');

    for (const a of pkg.artifacts) {
      const def = ARTIFACT_DEFINITIONS.find(d => d.number === a.number);
      const analogy = def?.consultingAnalogy ?? '';
      const statusIcon = a.status === 'complete' ? '\u2705 Complete'
        : a.status === 'degraded' ? '\u26a0\ufe0f Degraded'
        : '\u274c Not Generated';
      lines.push(`| ${a.number} | ${a.name} | ${statusIcon} | ${analogy} | [${a.filename}](./${a.filename}) |`);
    }
    lines.push('');

    // Degradation details
    const degradedArtifacts = pkg.artifacts.filter(a => a.status === 'degraded');
    const notGeneratedArtifacts = pkg.artifacts.filter(a => a.status === 'not_generated');

    if (degradedArtifacts.length > 0) {
      lines.push('## Degraded Artifacts');
      lines.push('');
      for (const a of degradedArtifacts) {
        lines.push(`- **#${a.number} ${a.name}:** ${a.degradationReason ?? 'Source data degraded'}`);
      }
      lines.push('');
    }

    if (notGeneratedArtifacts.length > 0) {
      lines.push('## Not Generated');
      lines.push('');
      for (const a of notGeneratedArtifacts) {
        lines.push(`- **#${a.number} ${a.name}:** ${a.degradationReason ?? 'Required pass not executed'}`);
      }
      lines.push('');
    }

    // Pipeline summary
    lines.push('## Pipeline Summary');
    lines.push('');
    lines.push(`- **Passes Executed:** ${pkg.passesExecuted}/7`);
    lines.push(`- **Total Agents Invoked:** ${pkg.totalAgentsInvoked}`);
    lines.push(`- **Execution Duration:** ${formatDurationMs(pkg.totalDurationMs)}`);
    lines.push(`- **Degraded Passes:** ${pkg.passesDegraded.length > 0 ? pkg.passesDegraded.join(', ') : 'None'}`);
    lines.push(`- **Artifacts Complete:** ${pkg.artifacts.filter(a => a.status === 'complete').length}/15`);
    lines.push(`- **Artifacts Degraded:** ${degradedArtifacts.length}/15`);
    lines.push(`- **Artifacts Not Generated:** ${notGeneratedArtifacts.length}/15`);
    lines.push('');

    // Confidence breakdown
    lines.push('## Confidence Score Breakdown');
    lines.push('');
    lines.push('| Component | Weight | Source |');
    lines.push('|-----------|--------|--------|');
    lines.push('| Financial Outcome Stability | 25% | CostOps (Pass 4) |');
    lines.push('| Operational Risk Level | 20% | Simulation (Pass 2) |');
    lines.push('| Compliance Exposure | 20% | Shield + Policy (Pass 4) |');
    lines.push('| Architecture Feasibility | 20% | Simulation (Pass 2) + Architecture (Pass 3) |');
    lines.push('| Organizational Readiness | 15% | Decision Artifacts (Pass 5) |');
    lines.push('');
    if (pkg.passesDegraded.length > 0) {
      lines.push(`**Degradation Penalty:** -${pkg.passesDegraded.length * 10}% (${pkg.passesDegraded.length} degraded pass${pkg.passesDegraded.length > 1 ? 'es' : ''})`);
      lines.push('');
    }

    // Schema version
    lines.push('---');
    lines.push('*Artifact Package Schema v1.0 (ADR-034)*');

    const indexPath = path.join(artifactDir, 'DECISION_PACKAGE.md');
    fs.writeFileSync(indexPath, lines.join('\n'), 'utf-8');
  }

  // --------------------------------------------------------------------------
  // File I/O
  // --------------------------------------------------------------------------

  private writeArtifactFile(dir: string, filename: string, content: string): void {
    const filePath = path.join(dir, filename);
    fs.writeFileSync(filePath, content, 'utf-8');
  }
}

// ============================================================================
// Formatting Helpers
// ============================================================================

function formatKey(key: string): string {
  return key
    .replace(/_/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase());
}

function formatRecommendation(rec: DecisionPackage['recommendation']): string {
  switch (rec) {
    case 'proceed': return 'Proceed';
    case 'proceed-with-conditions': return 'Proceed with Conditions';
    case 'investigate-further': return 'Investigate Further';
    case 'do-not-proceed': return 'Do Not Proceed';
  }
}

function formatDurationMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}
