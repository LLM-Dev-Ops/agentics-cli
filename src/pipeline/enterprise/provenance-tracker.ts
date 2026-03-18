/**
 * Provenance Tracker — Runtime Tracing System (ADR-039)
 *
 * Records every agent invocation during a pipeline execution as a
 * structured TraceRecord. Produces the Provenance Manifest (Artifact #15).
 *
 * Features:
 *   - Structured trace recording with code provenance
 *   - DecisionGraph namespace storage (provenance:{executionId}:{traceId})
 *   - Audit query helpers (who/what/when/how/reproducibility)
 *   - Rich manifest generation with all ADR-039 sections
 *   - Load/rehydrate from persisted records
 *   - Filtering by agent, pass, workstream, status
 *   - Privacy-safe: metadata only, no payload duplication
 *   - Version discrepancy detection
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import type {
  TraceRecord,
  PassNumber,
  AgentRef,
  AgentInvocationResult,
} from './types.js';
import { resolveCodeProvenance, resolveGitCommit } from './code-resolver.js';

// ============================================================================
// Provenance Key Format (ADR-039)
// ============================================================================

/** Generate the provenance namespace key for a trace record. */
export function provenanceKey(executionId: string, traceId: string): string {
  return `provenance:${executionId}:${traceId}`;
}

/** Generate tags for a trace record's memory entry. */
export function provenanceTags(record: TraceRecord): readonly string[] {
  return [
    `agent:${record.agent.domain}/${record.agent.agent}`,
    `pass:${record.pass}`,
    `execution:${record.executionId}`,
    `status:${record.outputs.status}`,
    `workstream:${record.workstream}`,
  ];
}

// ============================================================================
// Audit Query Result Types
// ============================================================================

/** Who made a decision. */
export interface AuditWho {
  readonly agentDomain: string;
  readonly agentName: string;
  readonly agentId: string;
  readonly role: string;
}

/** What code was used. */
export interface AuditWhat {
  readonly package: string;
  readonly version: string;
  readonly entryPoint: string;
  readonly commitHash: string;
}

/** Reproducibility information for re-execution. */
export interface AuditReproducibility {
  readonly commitHash: string;
  readonly parameters: Record<string, unknown>;
  readonly inputNodeIds: readonly string[];
  readonly codePackage: string;
  readonly codeVersion: string;
}

// ============================================================================
// Provenance Statistics
// ============================================================================

export interface ProvenanceStatistics {
  readonly totalRecords: number;
  readonly uniqueAgents: number;
  readonly uniquePackages: number;
  readonly totalTokens: number;
  readonly totalCost: number;
  readonly totalDurationMs: number;
  readonly byPass: Readonly<Record<number, number>>;
  readonly byStatus: Readonly<Record<string, number>>;
  readonly byWorkstream: Readonly<Record<string, number>>;
  readonly longestAgent: { agentId: string; durationMs: number } | undefined;
}

// ============================================================================
// Provenance Tracker
// ============================================================================

export class ProvenanceTracker {
  private readonly records: TraceRecord[] = [];
  private readonly executionId: string;
  private sequenceCounter: number = 0;

  constructor(executionId: string) {
    this.executionId = executionId;
  }

  /** Get the execution ID. */
  getExecutionId(): string {
    return this.executionId;
  }

  // --------------------------------------------------------------------------
  // Recording
  // --------------------------------------------------------------------------

  /** Record an agent invocation as a trace record with full code provenance. */
  recordInvocation(params: {
    agent: AgentRef;
    pass: PassNumber;
    passName: string;
    workstream: string;
    startedAt: string;
    completedAt: string;
    durationMs: number;
    inputNodeIds: readonly string[];
    outputNodeIds: readonly string[];
    artifactNumbers: readonly number[];
    status: 'success' | 'partial' | 'failed';
    confidence: number;
    tokensUsed?: number;
    modelUsed?: string;
    estimatedCost?: number;
  }): TraceRecord {
    this.sequenceCounter++;
    const codeProv = resolveCodeProvenance(params.agent);

    const record: TraceRecord = {
      traceId: `trace-${this.sequenceCounter}-${Date.now()}`,
      executionId: this.executionId,
      agent: {
        ...params.agent,
        agentId: `${params.agent.domain}/${params.agent.agent}`,
        version: codeProv.version,
      },
      pass: params.pass,
      passName: params.passName,
      workstream: params.workstream,
      startedAt: params.startedAt,
      completedAt: params.completedAt,
      durationMs: params.durationMs,
      codeProvenance: codeProv,
      inputs: {
        decisionGraphNodes: [...params.inputNodeIds],
        parameters: {},
      },
      outputs: {
        decisionGraphNodes: [...params.outputNodeIds],
        artifactNumbers: [...params.artifactNumbers],
        status: params.status,
        confidence: params.confidence,
      },
      resources: {
        tokensUsed: params.tokensUsed ?? 0,
        modelUsed: params.modelUsed ?? 'unknown',
        estimatedCost: params.estimatedCost ?? 0,
      },
    };

    this.records.push(record);
    return record;
  }

  /** Convenience: record from an AgentInvocationResult. */
  recordFromResult(
    result: AgentInvocationResult,
    passName: string,
    workstream: string,
    outputNodeIds: readonly string[] = [],
  ): TraceRecord {
    return this.recordInvocation({
      agent: result.agent,
      pass: result.pass,
      passName,
      workstream,
      startedAt: result.timestamp,
      completedAt: new Date(new Date(result.timestamp).getTime() + result.durationMs).toISOString(),
      durationMs: result.durationMs,
      inputNodeIds: [],
      outputNodeIds,
      artifactNumbers: [],
      status: result.status >= 200 && result.status < 300 ? 'success' : 'failed',
      confidence: result.status >= 200 && result.status < 300 ? 0.85 : 0,
    });
  }

  // --------------------------------------------------------------------------
  // Querying
  // --------------------------------------------------------------------------

  /** Get all trace records. */
  getAllRecords(): readonly TraceRecord[] {
    return this.records;
  }

  /** Get records for a specific pass. */
  getRecordsByPass(pass: PassNumber): readonly TraceRecord[] {
    return this.records.filter(r => r.pass === pass);
  }

  /** Get records for a specific agent (domain/agent). */
  getRecordsByAgent(domain: string, agent: string): readonly TraceRecord[] {
    return this.records.filter(r => r.agent.domain === domain && r.agent.agent === agent);
  }

  /** Get records for a specific workstream. */
  getRecordsByWorkstream(workstream: string): readonly TraceRecord[] {
    return this.records.filter(r => r.workstream === workstream);
  }

  /** Get records by status. */
  getRecordsByStatus(status: 'success' | 'partial' | 'failed'): readonly TraceRecord[] {
    return this.records.filter(r => r.outputs.status === status);
  }

  /** Get a specific record by trace ID. */
  getRecordByTraceId(traceId: string): TraceRecord | undefined {
    return this.records.find(r => r.traceId === traceId);
  }

  /** Get total number of unique agents invoked. */
  getUniqueAgentCount(): number {
    const seen = new Set<string>();
    for (const r of this.records) {
      seen.add(r.agent.agentId);
    }
    return seen.size;
  }

  /** Get total tokens used. */
  getTotalTokens(): number {
    let total = 0;
    for (const r of this.records) {
      total += r.resources.tokensUsed;
    }
    return total;
  }

  /** Get total estimated cost. */
  getTotalCost(): number {
    let total = 0;
    for (const r of this.records) {
      total += r.resources.estimatedCost;
    }
    return total;
  }

  /** Get total pipeline duration (sum of all agent durations). */
  getTotalDuration(): number {
    let total = 0;
    for (const r of this.records) {
      total += r.durationMs;
    }
    return total;
  }

  /** Get the longest-running agent. */
  getLongestAgent(): { agentId: string; durationMs: number } | undefined {
    if (this.records.length === 0) return undefined;
    let longest = this.records[0]!;
    for (const r of this.records) {
      if (r.durationMs > longest.durationMs) {
        longest = r;
      }
    }
    return { agentId: longest.agent.agentId, durationMs: longest.durationMs };
  }

  // --------------------------------------------------------------------------
  // Audit Queries (ADR-039 Auditability)
  // --------------------------------------------------------------------------

  /** Who made a decision (for a specific trace). */
  auditWho(traceId: string): AuditWho | undefined {
    const r = this.getRecordByTraceId(traceId);
    if (!r) return undefined;
    return {
      agentDomain: r.agent.domain,
      agentName: r.agent.agent,
      agentId: r.agent.agentId,
      role: r.agent.role,
    };
  }

  /** What code was used (for a specific trace). */
  auditWhat(traceId: string): AuditWhat | undefined {
    const r = this.getRecordByTraceId(traceId);
    if (!r) return undefined;
    return {
      package: r.codeProvenance.package,
      version: r.codeProvenance.version,
      entryPoint: r.codeProvenance.entryPoint,
      commitHash: r.codeProvenance.commitHash,
    };
  }

  /** Reproducibility info (for a specific trace). */
  auditReproducibility(traceId: string): AuditReproducibility | undefined {
    const r = this.getRecordByTraceId(traceId);
    if (!r) return undefined;
    return {
      commitHash: r.codeProvenance.commitHash,
      parameters: r.inputs.parameters,
      inputNodeIds: r.inputs.decisionGraphNodes,
      codePackage: r.codeProvenance.package,
      codeVersion: r.codeProvenance.version,
    };
  }

  // --------------------------------------------------------------------------
  // Statistics
  // --------------------------------------------------------------------------

  /** Compute aggregate provenance statistics. */
  getStatistics(): ProvenanceStatistics {
    const byPass: Record<number, number> = {};
    const byStatus: Record<string, number> = {};
    const byWorkstream: Record<string, number> = {};
    const packages = new Set<string>();

    for (const r of this.records) {
      byPass[r.pass] = (byPass[r.pass] ?? 0) + 1;
      byStatus[r.outputs.status] = (byStatus[r.outputs.status] ?? 0) + 1;
      byWorkstream[r.workstream] = (byWorkstream[r.workstream] ?? 0) + 1;
      packages.add(r.codeProvenance.package);
    }

    return {
      totalRecords: this.records.length,
      uniqueAgents: this.getUniqueAgentCount(),
      uniquePackages: packages.size,
      totalTokens: this.getTotalTokens(),
      totalCost: this.getTotalCost(),
      totalDurationMs: this.getTotalDuration(),
      byPass,
      byStatus,
      byWorkstream,
      longestAgent: this.getLongestAgent(),
    };
  }

  // --------------------------------------------------------------------------
  // Manifest Generation (Artifact #15 — ADR-039)
  // --------------------------------------------------------------------------

  /** Generate the Provenance Manifest as a markdown string. */
  generateManifest(params: {
    passesCompleted: number;
    passesDegraded: readonly PassNumber[];
    artifactOwnership: readonly { number: number; name: string; agent: string; pass: PassNumber }[];
  }): string {
    const now = new Date().toISOString();
    const stats = this.getStatistics();
    const longest = stats.longestAgent;

    // Collect unique packages
    const packages = new Map<string, { version: string; repository: string; agents: Set<string> }>();
    for (const r of this.records) {
      const pkg = r.codeProvenance.package;
      const existing = packages.get(pkg);
      if (existing) {
        existing.agents.add(r.agent.agent);
      } else {
        packages.set(pkg, {
          version: r.codeProvenance.version,
          repository: r.codeProvenance.repository,
          agents: new Set([r.agent.agent]),
        });
      }
    }

    const lines: string[] = [];

    // Header
    lines.push('# Agent & Code Provenance Manifest');
    lines.push(`**Execution ID:** ${this.executionId}`);
    lines.push(`**Date:** ${now}`);
    lines.push(`**Pipeline Duration:** ${formatDuration(stats.totalDurationMs)}`);
    lines.push(`**Total Agents Invoked:** ${this.records.length}`);
    lines.push(`**Unique Agent Types:** ${stats.uniqueAgents}`);
    lines.push(`**Total LLM Tokens Used:** ${stats.totalTokens.toLocaleString()}`);
    lines.push(`**Estimated Pipeline Cost:** $${stats.totalCost.toFixed(4)}`);
    lines.push('');

    // Agent Inventory
    lines.push('## Agent Inventory');
    lines.push('');
    lines.push('| # | Agent | Domain | Pass | Duration | Tokens | Model | Status |');
    lines.push('|---|-------|--------|------|----------|--------|-------|--------|');
    for (let i = 0; i < this.records.length; i++) {
      const r = this.records[i]!;
      const statusIcon = r.outputs.status === 'success' ? '\u2705' : r.outputs.status === 'partial' ? '\u26a0\ufe0f' : '\u274c';
      lines.push(`| ${i + 1} | ${r.agent.agent} | ${r.agent.domain} | Pass ${r.pass} | ${formatDuration(r.durationMs)} | ${r.resources.tokensUsed.toLocaleString()} | ${r.resources.modelUsed} | ${statusIcon} |`);
    }
    lines.push('');

    // Code Inventory
    lines.push('## Code Inventory');
    lines.push('');
    lines.push('| Package | Version | Repository | Agents Using |');
    lines.push('|---------|---------|------------|-------------|');
    for (const [pkg, info] of packages.entries()) {
      lines.push(`| ${pkg} | ${info.version} | ${info.repository} | ${Array.from(info.agents).join(', ')} |`);
    }
    lines.push('');
    lines.push(`**Git Commit:** ${this.records[0]?.codeProvenance.commitHash ?? resolveGitCommit()}`);
    lines.push('');

    // Execution Flow by Pass
    lines.push('## Execution Flow');
    lines.push('');
    const passNames: Record<number, string> = {
      1: 'Problem Intelligence',
      2: 'Simulation & Scenario Modeling',
      3: 'Architecture & Prototype Generation',
      4: 'Governance, Compliance & CostOps',
      5: 'Decision Artifacts',
      6: 'ERP Prototype Deployment',
      7: 'Observability & Continuous Learning',
    };
    for (let pass = 1; pass <= 7; pass++) {
      const passRecords = this.records.filter(r => r.pass === pass);
      if (passRecords.length === 0) continue;
      lines.push(`### Pass ${pass} \u2014 ${passNames[pass] ?? `Pass ${pass}`}`);
      lines.push('```');
      for (const r of passRecords) {
        const statusIcon = r.outputs.status === 'success' ? '\u2705' : '\u274c';
        lines.push(`[${r.startedAt}] ${r.agent.agent} (${r.agent.domain}) - ${formatDuration(r.durationMs)} ${statusIcon}`);
      }
      lines.push('```');
      lines.push('');
    }

    // Artifact Ownership
    lines.push('## Artifact Ownership');
    lines.push('');
    lines.push('| # | Artifact | Producing Agent(s) | Pass |');
    lines.push('|---|----------|-------------------|------|');
    for (const a of params.artifactOwnership) {
      lines.push(`| ${a.number} | ${a.name} | ${a.agent} | ${a.pass} |`);
    }
    lines.push('');

    // Quality Scores
    lines.push('## Quality Scores');
    lines.push('');
    lines.push('| Agent | Domain | Confidence | Status | Notes |');
    lines.push('|-------|--------|-----------|--------|-------|');
    for (const r of this.records) {
      const notes = r.outputs.status !== 'success' ? r.outputs.status : '\u2014';
      lines.push(`| ${r.agent.agent} | ${r.agent.domain} | ${r.outputs.confidence.toFixed(2)} | ${r.outputs.status} | ${notes} |`);
    }
    lines.push('');

    // Resource Summary
    lines.push('## Resource Summary');
    lines.push('');
    lines.push('| Resource | Value |');
    lines.push('|----------|-------|');
    lines.push(`| Total agents invoked | ${this.records.length} |`);
    lines.push(`| Unique agent types | ${stats.uniqueAgents} |`);
    lines.push(`| Unique code packages | ${packages.size} |`);
    lines.push(`| Total LLM tokens | ${stats.totalTokens.toLocaleString()} |`);
    lines.push(`| Total estimated cost | $${stats.totalCost.toFixed(4)} |`);
    lines.push(`| Pipeline wall-clock time | ${formatDuration(stats.totalDurationMs)} |`);
    if (longest) {
      lines.push(`| Longest agent execution | ${longest.agentId} (${formatDuration(longest.durationMs)}) |`);
    }
    lines.push(`| Passes completed | ${params.passesCompleted}/7 |`);
    lines.push(`| Passes degraded | ${params.passesDegraded.length > 0 ? params.passesDegraded.join(', ') : 'None'} |`);
    lines.push('');

    // Auditability (ADR-039)
    lines.push('## Auditability');
    lines.push('');
    lines.push('| Requirement | How It\'s Met |');
    lines.push('|-------------|-------------|');
    lines.push('| **Who** made each decision | `agent.domain` + `agent.agent` in every TraceRecord |');
    lines.push('| **What** code was used | `codeProvenance.package` + `commitHash` |');
    lines.push('| **When** it happened | `startedAt` / `completedAt` timestamps |');
    lines.push('| **What** data was used | `inputs.decisionGraphNodes` — exact node IDs read |');
    lines.push('| **What** was produced | `outputs.decisionGraphNodes` + `outputs.artifactNumbers` |');
    lines.push('| **How** confident | `outputs.confidence` per agent |');
    lines.push('| **How much** it cost | `resources.tokensUsed` + `resources.estimatedCost` |');
    lines.push('| **Reproducibility** | `commitHash` + `inputs.parameters` enable re-execution |');
    lines.push('');

    // Privacy note
    lines.push('## Privacy & Redaction');
    lines.push('');
    lines.push('TraceRecords contain **metadata only** — no agent input/output payloads are stored.');
    lines.push('DecisionGraph node IDs (pointers) are recorded, not content.');
    lines.push('Access control on DecisionGraph nodes governs who can see actual data.');
    lines.push('');

    // Schema version
    lines.push('---');
    lines.push('*Provenance Schema v1.0 (ADR-039)*');

    return lines.join('\n');
  }

  // --------------------------------------------------------------------------
  // Persistence
  // --------------------------------------------------------------------------

  /** Persist trace records to the output directory. */
  persist(outputDir: string): string {
    const traceDir = path.join(outputDir, 'provenance');
    fs.mkdirSync(traceDir, { recursive: true });

    const filePath = path.join(traceDir, 'trace-records.json');
    fs.writeFileSync(filePath, JSON.stringify(this.records, null, 2), 'utf-8');
    return filePath;
  }

  /** Load trace records from a previously persisted file. */
  static load(executionId: string, outputDir: string): ProvenanceTracker {
    const tracker = new ProvenanceTracker(executionId);
    const filePath = path.join(outputDir, 'provenance', 'trace-records.json');

    if (!fs.existsSync(filePath)) return tracker;

    try {
      const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      if (Array.isArray(raw)) {
        for (const record of raw) {
          tracker.records.push(record as TraceRecord);
        }
        tracker.sequenceCounter = tracker.records.length;
      }
    } catch {
      // Corrupted file — return empty tracker
    }

    return tracker;
  }
}

// ============================================================================
// Helpers
// ============================================================================

/** Format milliseconds as human-readable duration. */
function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}
