/**
 * Ask Artifact Writer — Dual-Mode Output Persistence for `agentics ask`
 *
 * Persists multi-agent results from `agentics ask` as browsable artifacts.
 *
 * Two modes (auto-detected):
 *   Development mode:  Writes to ~/.agentics/runs/<trace-id>/
 *                      Prints clickable Codespace / file link
 *   Project mode:      Creates git branch agentics/<slug>-<YYYYMMDD>,
 *                      commits artifacts to .agentics/runs/<trace-id>/,
 *                      returns to original branch, prints GitHub URL
 *
 * All persistence is NON-FATAL — errors warn but never block result display.
 */

import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import { createRequire } from 'node:module';

// ADR-PIPELINE-102 §1: ESM-safe require shim. The package is "type": "module";
// bare require() throws ReferenceError at runtime.
const esmRequire = createRequire(import.meta.url);

import {
  detectExecutionMode,
  generateAskBranchName,
  createScenarioBranch,
  commitScenarioFiles,
  checkoutBranch,
  type ExecutionContext,
} from '../pipeline/execution-context.js';

import type {
  RouteResult,
  AgentsInvokeResult,
} from '../commands/agents.js';

import { buildPhase2ADRs, renderADRsAsDocument } from '../pipeline/phase2/phases/adr-generator.js';
import type { Phase2SPARCOutput, ResearchDossier } from '../pipeline/phase2/types.js';

// ============================================================================
// Constants
// ============================================================================

const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

// ============================================================================
// Types
// ============================================================================

export interface AskPersistInput {
  query: string;
  routeResult: RouteResult;
  traceId: string;
  timing: number;
}

export interface AskPersistOutput {
  runDir: string;
  filesWritten: string[];
  mode: 'development' | 'project';
  branch?: string;
  commitHash?: string;
  githubUrl?: string;
}

// ============================================================================
// I/O Helpers (match simulation-artifact-generator.ts patterns)
// ============================================================================

function atomicWriteFile(filePath: string, content: string): void {
  const tmpPath = `${filePath}.tmp.${crypto.randomUUID()}`;
  fs.writeFileSync(tmpPath, content, { mode: FILE_MODE, encoding: 'utf-8' });
  fs.renameSync(tmpPath, filePath);
}

function ensureDir(dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true, mode: DIR_MODE });
  }
}

// ============================================================================
// Artifact Builders
// ============================================================================

function buildManifest(input: AskPersistInput): Record<string, unknown> {
  const agents = extractAgents(input.routeResult);
  const isEng = isEngineeringPipeline(input);
  const baseArtifacts = ['manifest.json', 'results.json', 'summary.md', 'prompt.txt'];
  const engArtifacts = isEng ? [
    'engineering/sparc-specification.md',
    'engineering/tdd-test-plan.md',
    'engineering/architecture-decisions.md',
    'engineering/domain-model.md',
    'engineering/implementation-roadmap.md',
  ] : [];
  return {
    run_id: input.traceId,
    query: input.query,
    created_at: new Date().toISOString(),
    timing_ms: input.timing,
    kind: input.routeResult.kind,
    pipeline: isEng ? 'engineering' : 'analysis',
    agent_count: agents.length,
    agents_invoked: agents.map(a => ({
      domain: a.domain,
      agent: a.agent,
      status: a.succeeded ? 'success' : 'error',
    })),
    artifacts: [...baseArtifacts, ...engArtifacts],
    // ADR-PIPELINE-096 D2 — runtime lineage block. Populated from the route
    // result + a fresh Ruflo availability probe. Backwards-compatible: every
    // existing consumer ignores the new top-level key per ADR-088. Surface
    // points: `agentics status`, the `agentics-status` MCP tool, and
    // `agent-fleet-report.md`.
    runtime: buildRuntimeLineage(input, agents),
    schema_version: '1.1.0',
  };
}

/**
 * ADR-096 D2 — assemble the `runtime` block. Best-effort: if any sub-probe
 * fails (Ruflo unreachable, etc.), the offending field is null/undefined and
 * the rest still populates. Never throws.
 */
function buildRuntimeLineage(input: AskPersistInput, agents: AgentInfo[]): Record<string, unknown> {
  // Ruflo availability — uses ADR-094's cached probe so this is a microsecond
  // lookup after the first call, NOT a fresh subprocess.
  let ruflo: Record<string, unknown>;
  try {
    const rufloMod = esmRequire('../pipeline/ruflo-phase-executor.js') as { checkRufloAvailable?: () => unknown };
    const probe = typeof rufloMod.checkRufloAvailable === 'function' ? rufloMod.checkRufloAvailable() : null;
    if (probe && typeof probe === 'object') {
      const p = probe as Record<string, unknown>;
      ruflo = {
        available: Boolean(p['available']),
        version: typeof p['version'] === 'string' ? p['version'] : 'N/A',
        binary: typeof p['binary'] === 'string' ? p['binary'] : '',
        reason: typeof p['reason'] === 'string' ? p['reason'] : (p['available'] ? 'ok' : 'unknown'),
      };
    } else {
      ruflo = { available: false, version: 'N/A', binary: '', reason: 'probe-failed' };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[ruflo-probe] threw: ${msg}\n`);
    ruflo = { available: false, version: 'N/A', binary: '', reason: `probe-threw: ${msg}` };
  }

  // Ruvector / hyperbolic simulation — `simulator/enterprise` invocations
  // and graph-routing calls (the simulation-tier branch of
  // executeAgentsInvokeCommand) all flow through ruvector. We surface the
  // count and the per-call latency that we already track in the route result.
  const simulatorAgents = agents.filter(a => a.domain === 'simulator');
  const ruvector = {
    hyperbolic_simulations: simulatorAgents.map(a => ({
      agent: `${a.domain}/${a.agent}`,
      status: a.succeeded ? 'success' : 'error',
    })),
    embedding_lookups: 0,  // populated by D2.1 follow-up when graph-router exposes a counter
    graph_routing_invocations: input.routeResult.kind === 'multi' ? 1 : 0,  // capability-graph route attempt; 0 on consultancy bypass
  };

  // Fleet metadata — depth + per-domain success/fail counts.
  const byDomain: Record<string, { dispatched: number; succeeded: number; failed: number }> = {};
  for (const a of agents) {
    const slot = byDomain[a.domain] ?? { dispatched: 0, succeeded: 0, failed: 0 };
    slot.dispatched++;
    if (a.succeeded) slot.succeeded++;
    else slot.failed++;
    byDomain[a.domain] = slot;
  }
  const dispatched = agents.length;
  const succeeded = agents.filter(a => a.succeeded).length;
  const failed = dispatched - succeeded;
  // Depth is read from the route result (set by the caller via
  // `executeNaturalLanguageRoute(query, { depth })`). Fallback heuristic when
  // the value isn't carried through: 100+ agents is consultancy, 20+ is
  // standard, otherwise lite.
  const inferredDepth = dispatched >= 100 ? 'consultancy' : dispatched >= 20 ? 'standard' : 'lite';
  const fleet = {
    depth: inferredDepth,
    dispatched,
    succeeded,
    failed,
    by_domain: byDomain,
    cloud_breaker: { tripped: false },  // populated by D2.2 when cloud-breaker state surfaces from agents.ts
  };

  return { ruflo, ruvector, fleet };
}

function buildResultsJson(input: AskPersistInput): unknown {
  if (input.routeResult.kind === 'multi') {
    return {
      kind: 'multi',
      query: input.routeResult.result.query,
      agents: input.routeResult.result.invocations.map(inv => ({
        domain: inv.intent.domain,
        agent: inv.intent.agent,
        confidence: inv.intent.confidence,
        reasoning: inv.intent.reasoning,
        result: 'error' in inv.result ? { error: inv.result.error } : inv.result,
      })),
      timing: input.routeResult.result.timing,
    };
  }
  return {
    kind: 'single',
    query: input.query,
    intent: input.routeResult.result.intent,
    result: input.routeResult.result.invocation,
    timing: input.routeResult.result.timing,
  };
}

function buildSummaryMarkdown(input: AskPersistInput): string {
  const lines: string[] = [];
  const timestamp = new Date().toISOString();

  lines.push(`# Agentics Run: ${input.query}`);
  lines.push('');
  lines.push(`**Trace ID:** \`${input.traceId}\``);
  lines.push(`**Timestamp:** ${timestamp}`);
  lines.push(`**Duration:** ${input.timing}ms`);
  lines.push('');

  if (input.routeResult.kind === 'multi') {
    const r = input.routeResult.result;
    const succeeded = r.invocations.filter(i => !('error' in i.result)).length;
    const failed = r.invocations.length - succeeded;

    lines.push(`## Multi-Agent Results`);
    lines.push('');
    lines.push(`**Agents:** ${r.invocations.length} (${succeeded} succeeded${failed > 0 ? `, ${failed} failed` : ''})`);
    lines.push('');

    for (const inv of r.invocations) {
      const label = `${inv.intent.domain}/${inv.intent.agent}`;
      lines.push(`### ${label}`);
      lines.push('');

      if ('error' in inv.result) {
        lines.push(`**Status:** Error`);
        lines.push(`\`\`\`\n${inv.result.error}\n\`\`\``);
      } else {
        const agentResult = inv.result as AgentsInvokeResult;
        lines.push(`**Status:** ${agentResult.status} (${agentResult.timing}ms)`);
        lines.push('');
        lines.push('```json');
        lines.push(JSON.stringify(agentResult.response, null, 2));
        lines.push('```');
      }
      lines.push('');
    }
  } else {
    const r = input.routeResult.result;
    lines.push(`## Agent: ${r.intent.domain}/${r.intent.agent}`);
    lines.push('');
    lines.push(`**Confidence:** ${(r.intent.confidence * 100).toFixed(0)}%`);
    if (r.intent.reasoning) {
      lines.push(`**Reasoning:** ${r.intent.reasoning}`);
    }
    lines.push(`**Status:** ${r.invocation.status} (${r.invocation.timing}ms)`);
    lines.push('');
    lines.push('```json');
    lines.push(JSON.stringify(r.invocation.response, null, 2));
    lines.push('```');
  }

  lines.push('');
  lines.push('---');
  lines.push(`*Generated by [Agentics CLI](https://github.com/ruvnet/agentics-cli)*`);

  return lines.join('\n');
}

interface AgentInfo {
  domain: string;
  agent: string;
  succeeded: boolean;
}

function extractAgents(routeResult: RouteResult): AgentInfo[] {
  if (routeResult.kind === 'multi') {
    return routeResult.result.invocations.map(inv => ({
      domain: inv.intent.domain,
      agent: inv.intent.agent,
      succeeded: !('error' in inv.result),
    }));
  }
  return [{
    domain: routeResult.result.intent.domain,
    agent: routeResult.result.intent.agent,
    succeeded: true,
  }];
}

// ============================================================================
// Write Artifacts to a Directory
// ============================================================================

async function writeArtifacts(runDir: string, input: AskPersistInput): Promise<string[]> {
  ensureDir(runDir);
  const filesWritten: string[] = [];

  // 1. manifest.json
  const manifest = buildManifest(input);
  atomicWriteFile(path.join(runDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  filesWritten.push('manifest.json');

  // 2. results.json
  const results = buildResultsJson(input);
  atomicWriteFile(path.join(runDir, 'results.json'), JSON.stringify(results, null, 2));
  filesWritten.push('results.json');

  // 3. summary.md
  const summary = buildSummaryMarkdown(input);
  atomicWriteFile(path.join(runDir, 'summary.md'), summary);
  filesWritten.push('summary.md');

  // 4. prompt.txt
  atomicWriteFile(path.join(runDir, 'prompt.txt'), input.query);
  filesWritten.push('prompt.txt');

  // 5. Engineering artifacts (SPARC, TDD, ADR, DDD) for engineering pipeline combos
  if (isEngineeringPipeline(input)) {
    const engDir = path.join(runDir, 'engineering');
    ensureDir(engDir);

    const agentData = extractAgentData(input);

    // 5a. SPARC Specification
    const sparc = buildSparcSpec(input.query, agentData);
    atomicWriteFile(path.join(engDir, 'sparc-specification.md'), sparc);
    filesWritten.push('engineering/sparc-specification.md');

    // 5b. TDD Test Plan
    const tdd = buildTddPlan(input.query, agentData);
    atomicWriteFile(path.join(engDir, 'tdd-test-plan.md'), tdd);
    filesWritten.push('engineering/tdd-test-plan.md');

    // 5c. Architecture Decision Records — derived from SPARC specification
    const { sparc: sparcOutput, dossier: dossierOutput } = buildSPARCFromAgentData(input.query, agentData);
    const adrRecords = await buildPhase2ADRs(sparcOutput, dossierOutput, input.query);
    const adr = renderADRsAsDocument(adrRecords, input.query);
    atomicWriteFile(path.join(engDir, 'architecture-decisions.md'), adr);
    filesWritten.push('engineering/architecture-decisions.md');

    // 5c-ii. Also write ADRs in Phase 2 format so auto-chain Phase 4.5 can find them
    if (adrRecords.length > 0) {
      const phase2AdrDir = path.join(runDir, 'phase2', 'adrs');
      ensureDir(phase2AdrDir);
      atomicWriteFile(path.join(phase2AdrDir, 'adr-index.json'), JSON.stringify(adrRecords, null, 2));
      for (const rec of adrRecords) {
        const slug = (rec.title || 'untitled').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 60);
        const md = [
          `# ${rec.id}: ${rec.title}`,
          `\n**Status:** ${rec.status}`,
          `**Date:** ${rec.date}`,
          `\n## Context\n${rec.context}`,
          `\n## Decision\n${rec.decision}`,
        ].join('\n');
        atomicWriteFile(path.join(phase2AdrDir, `${rec.id}-${slug}.md`), md);
      }
      filesWritten.push('phase2/adrs/adr-index.json');
    }

    // 5d. Domain-Driven Design Model
    const ddd = buildDddModel(input.query, agentData);
    atomicWriteFile(path.join(engDir, 'domain-model.md'), ddd);
    filesWritten.push('engineering/domain-model.md');

    // 5d-ii. Also write DDD markdown in Phase 2 format for auto-chain
    {
      const phase2DddDir = path.join(runDir, 'phase2', 'ddd');
      ensureDir(phase2DddDir);
      atomicWriteFile(path.join(phase2DddDir, 'domain-model.md'), ddd);
      filesWritten.push('phase2/ddd/domain-model.md');
    }

    // 5e. Implementation Roadmap (derived from decomposer + planner outputs)
    const roadmap = buildEngineeringRoadmap(input.query, agentData);
    atomicWriteFile(path.join(engDir, 'implementation-roadmap.md'), roadmap);
    filesWritten.push('engineering/implementation-roadmap.md');

    // Update manifest with engineering artifacts
    manifest['artifacts'] = filesWritten;
    manifest['pipeline'] = 'engineering';
    atomicWriteFile(path.join(runDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  }

  return filesWritten;
}

// ============================================================================
// Engineering Pipeline Detection
// ============================================================================

/**
 * Detect if this ask result came from the full-fleet engineering pipeline.
 * Simple check: if we have 10+ agents dispatched, it's the full fleet.
 */
function isEngineeringPipeline(input: AskPersistInput): boolean {
  if (input.routeResult.kind !== 'multi') return false;
  return input.routeResult.result.invocations.length >= 10;
}

interface AgentData {
  // All agent outputs keyed by "domain/agent"
  byKey: Record<string, Record<string, unknown>>;
  // Shortcut accessors for artifact builders
  decomposition: Record<string, unknown> | null;
  plan: Record<string, unknown> | null;
  risk: Record<string, unknown> | null;
  executiveSummary: Record<string, unknown> | null;
  decisionMemo: Record<string, unknown> | null;
  audit: Record<string, unknown> | null;
  policyEnforce: Record<string, unknown> | null;
  workflow: Record<string, unknown> | null;
  dependencies: Record<string, unknown> | null;
  erp: Record<string, unknown> | null;
  hypothesis: Record<string, unknown> | null;
  scenario: Record<string, unknown> | null;
  roi: Record<string, unknown> | null;
  tradeoff: Record<string, unknown> | null;
  quality: Record<string, unknown> | null;
  simulation: Record<string, unknown> | null;
  // All results
  allResults: Array<{ domain: string; agent: string; data: unknown }>;
}

function extractAgentData(input: AskPersistInput): AgentData {
  const data: AgentData = {
    byKey: {},
    decomposition: null, plan: null, risk: null, executiveSummary: null,
    decisionMemo: null, audit: null, policyEnforce: null,
    workflow: null, dependencies: null, erp: null,
    hypothesis: null, scenario: null,
    roi: null, tradeoff: null, quality: null, simulation: null,
    allResults: [],
  };
  if (input.routeResult.kind !== 'multi') return data;

  for (const inv of input.routeResult.result.invocations) {
    if ('error' in inv.result) continue;
    const result = inv.result as AgentsInvokeResult;
    const response = result.response as Record<string, unknown> | undefined;
    const responseData = (response?.['data'] ?? response) as Record<string, unknown>;
    const key = `${inv.intent.domain}/${inv.intent.agent}`;
    data.byKey[key] = responseData;
    data.allResults.push({ domain: inv.intent.domain, agent: inv.intent.agent, data: responseData });
  }

  // Shortcut accessors — artifact builders use these directly
  data.decomposition = data.byKey['copilot/decomposer'] ?? null;
  data.plan = data.byKey['copilot/planner'] ?? null;
  data.risk = data.byKey['platform/risk-score'] ?? null;
  data.executiveSummary = data.byKey['platform/executive-summary'] ?? null;
  data.decisionMemo = data.byKey['platform/decision-memo'] ?? null;
  data.audit = data.byKey['governance-dashboard/audit'] ?? null;
  data.policyEnforce = data.byKey['policy-engine/enforce'] ?? null;
  data.workflow = data.byKey['orchestrator/workflow'] ?? null;
  data.dependencies = data.byKey['orchestrator/dependencies'] ?? null;
  data.erp = data.byKey['connector-hub/erp-surface'] ?? null;
  data.hypothesis = data.byKey['research-lab/hypothesis'] ?? null;
  data.scenario = data.byKey['simulator/scenario'] ?? null;
  data.roi = data.byKey['costops/roi'] ?? null;
  data.tradeoff = data.byKey['costops/tradeoff'] ?? null;
  data.quality = data.byKey['test-bench/quality'] ?? null;
  data.simulation = data.byKey['simulator/enterprise'] ?? null;
  return data;
}

// ============================================================================
// Engineering Artifact Builders
// ============================================================================

function buildSparcSpec(query: string, data: AgentData): string {
  const lines: string[] = [];
  const now = new Date().toISOString();
  const subobjectives = extractSubobjectives(data.decomposition);
  const planSteps = extractPlanSteps(data.plan);
  const riskFactors = extractRiskFactors(data.risk);

  lines.push('# SPARC Specification');
  lines.push('');
  lines.push(`> Generated: ${now}`);
  lines.push('');
  lines.push('## S — Specification');
  lines.push('');
  lines.push(`### Objective`);
  lines.push('');
  lines.push(query);
  lines.push('');

  lines.push('### Functional Requirements');
  lines.push('');
  for (const obj of subobjectives) {
    lines.push(`- **${obj.title}** (${obj.complexity}): ${obj.criteria}`);
  }
  if (subobjectives.length === 0) {
    lines.push('- Requirements to be derived from deep research phase');
  }
  lines.push('');

  lines.push('### Non-Functional Requirements');
  lines.push('');
  for (const risk of riskFactors) {
    lines.push(`- **${risk.factor}** (score: ${risk.score}/100): ${risk.description}`);
  }
  lines.push('');

  // Research Hypotheses (from research-lab/hypothesis)
  if (data.hypothesis) {
    lines.push('### Research Hypotheses');
    lines.push('');
    const hypotheses = (data.hypothesis['hypotheses'] ?? data.hypothesis['results'] ?? []) as Array<Record<string, unknown>>;
    if (hypotheses.length > 0) {
      for (const h of hypotheses) {
        lines.push(`- **${h['title'] ?? h['hypothesis'] ?? 'Hypothesis'}**: ${h['description'] ?? h['rationale'] ?? JSON.stringify(h)}`);
      }
    } else {
      lines.push(`- Research analysis: ${JSON.stringify(data.hypothesis).slice(0, 200)}`);
    }
    lines.push('');
  }

  // Ambiguities & Clarifications (from copilot/clarifier)
  if (data.byKey['copilot/clarifier']) {
    lines.push('### Ambiguities & Clarifications');
    lines.push('');
    const questions = (data.byKey['copilot/clarifier']['questions'] ?? data.byKey['copilot/clarifier']['clarifications'] ?? data.byKey['copilot/clarifier']['ambiguities'] ?? []) as Array<Record<string, unknown>>;
    if (questions.length > 0) {
      for (const q of questions) {
        lines.push(`- ${q['question'] ?? q['text'] ?? JSON.stringify(q)}`);
      }
    } else {
      lines.push(`- Clarification analysis: ${JSON.stringify(data.byKey['copilot/clarifier']).slice(0, 200)}`);
    }
    lines.push('');
  }

  // Meta-Reasoning (from copilot/meta-reasoner)
  if (data.byKey['copilot/meta-reasoner']) {
    lines.push('### Meta-Reasoning Analysis');
    lines.push('');
    lines.push(`${JSON.stringify(data.byKey['copilot/meta-reasoner']).slice(0, 300)}`);
    lines.push('');
  }

  lines.push('### Constraints');
  lines.push('');
  lines.push('- [ ] Security: All data in transit must be encrypted (TLS 1.3+)');
  lines.push('- [ ] Compliance: Must meet regulatory requirements identified in risk assessment');
  lines.push('- [ ] Performance: API response time < 500ms p95');
  lines.push('- [ ] Availability: 99.9% uptime SLA');

  // Policy constraints (from policy-engine/enforce)
  if (data.policyEnforce) {
    const policies = (data.policyEnforce['policies_evaluated'] ?? data.policyEnforce['policies'] ?? []) as Array<Record<string, unknown>>;
    for (const p of policies) {
      lines.push(`- [ ] Policy: ${p['name'] ?? p['policy_name'] ?? 'Policy'} — ${p['description'] ?? p['status'] ?? ''}`);
    }
  }

  // Cost constraints (from costops/tradeoff)
  if (data.tradeoff) {
    lines.push(`- [ ] Cost: Budget within ROI parameters (see costops analysis)`);
  }
  lines.push('');

  lines.push('## P — Pseudocode');
  lines.push('');
  lines.push('### Core Flow');
  lines.push('');
  lines.push('```');
  lines.push('PROGRAM main');
  for (const step of planSteps) {
    lines.push(`  STEP ${step.id}: ${step.name}`);
    lines.push(`    // ${step.description}`);
    if (step.dependencies.length > 0) {
      lines.push(`    DEPENDS_ON: ${step.dependencies.join(', ')}`);
    }
  }
  lines.push('END PROGRAM');
  lines.push('```');
  lines.push('');

  lines.push('## A — Architecture');
  lines.push('');
  lines.push('### Component Diagram');
  lines.push('');
  lines.push('```');
  lines.push('┌─────────────┐     ┌──────────────┐     ┌─────────────┐');
  lines.push('│   Client    │────▶│  API Gateway  │────▶│  Services   │');
  lines.push('└─────────────┘     └──────────────┘     └──────┬──────┘');
  lines.push('                                                │');
  lines.push('                    ┌──────────────┐     ┌──────▼──────┐');
  lines.push('                    │  Event Bus   │◀───▶│  Data Layer │');
  lines.push('                    └──────────────┘     └─────────────┘');
  lines.push('```');
  lines.push('');

  lines.push('### Key Decisions (see architecture-decisions.md)');
  lines.push('');

  // Dependency analysis (from orchestrator/dependencies)
  if (data.dependencies) {
    lines.push('### Dependency Analysis');
    lines.push('');
    const graph = data.dependencies['dependency_graph'] as Record<string, unknown> | undefined;
    if (graph) {
      const nodes = (graph['nodes'] ?? []) as string[];
      const edges = (graph['edges'] ?? []) as Array<Record<string, unknown>>;
      lines.push(`Components: ${nodes.join(', ')}`);
      lines.push('');
      for (const edge of edges) {
        lines.push(`- ${edge['from']} → ${edge['to']}`);
      }
    } else {
      lines.push(`Dependency data: ${JSON.stringify(data.dependencies).slice(0, 200)}`);
    }
    lines.push('');
  }

  // Quality assessment (from test-bench/quality)
  if (data.quality) {
    lines.push('### Quality Assessment');
    lines.push('');
    lines.push(`Quality analysis: ${JSON.stringify(data.quality).slice(0, 300)}`);
    lines.push('');
  }

  // ROI analysis (from costops/roi)
  if (data.roi) {
    lines.push('### ROI Analysis');
    lines.push('');
    lines.push(`ROI data: ${JSON.stringify(data.roi).slice(0, 300)}`);
    lines.push('');
  }

  // Simulation results (from ruvector-service)
  if (data.simulation) {
    lines.push('### Hyperbolic Simulation (ruvector)');
    lines.push('');
    lines.push(`Simulation results: ${JSON.stringify(data.simulation).slice(0, 400)}`);
    lines.push('');
  }

  lines.push('## R — Refinement');
  lines.push('');
  lines.push('### Iteration Plan');
  lines.push('');
  lines.push('| Phase | Focus | Validation |');
  lines.push('|-------|-------|------------|');
  for (let i = 0; i < subobjectives.length; i++) {
    const obj = subobjectives[i]!;
    lines.push(`| ${i + 1} | ${obj.title} | ${obj.criteria} |`);
  }
  lines.push('');

  lines.push('## C — Completion');
  lines.push('');
  lines.push('### Definition of Done');
  lines.push('');
  lines.push('- [ ] All TDD tests passing (see tdd-test-plan.md)');
  lines.push('- [ ] ADRs reviewed and approved (see architecture-decisions.md)');
  lines.push('- [ ] Domain model validated (see domain-model.md)');
  lines.push('- [ ] Security scan clean');
  lines.push('- [ ] Performance benchmarks met');
  lines.push('- [ ] Documentation complete');

  return lines.join('\n');
}

function buildTddPlan(query: string, data: AgentData): string {
  const lines: string[] = [];
  const now = new Date().toISOString();
  const subobjectives = extractSubobjectives(data.decomposition);

  lines.push('# TDD Test Plan (London School)');
  lines.push('');
  lines.push(`> Generated: ${now}`);
  lines.push(`> Methodology: Outside-In, Mock-Driven`);
  lines.push('');
  lines.push(`## Project: ${query}`);
  lines.push('');

  lines.push('## Test Strategy');
  lines.push('');
  lines.push('### Layer 1: Acceptance Tests (outermost)');
  lines.push('');
  lines.push('```');
  lines.push('DESCRIBE "System Integration"');
  lines.push(`  IT "should fulfill the core objective: ${query.slice(0, 60)}"`);
  lines.push('    GIVEN the system is configured');
  lines.push('    WHEN the primary workflow is triggered');
  lines.push('    THEN all acceptance criteria are met');
  lines.push('```');
  lines.push('');

  lines.push('### Layer 2: Service Tests');
  lines.push('');
  for (const obj of subobjectives) {
    lines.push(`#### ${obj.title}`);
    lines.push('');
    lines.push('```');
    lines.push(`DESCRIBE "${obj.title}"`);
    lines.push(`  IT "should ${obj.criteria.toLowerCase()}"`);
    lines.push(`    GIVEN prerequisites are met`);
    lines.push(`    WHEN ${obj.title.toLowerCase()} is executed`);
    lines.push(`    THEN ${obj.criteria.toLowerCase()}`);
    lines.push(`  `);
    lines.push(`  IT "should handle error conditions gracefully"`);
    lines.push(`    GIVEN an error condition exists`);
    lines.push(`    WHEN ${obj.title.toLowerCase()} encounters the error`);
    lines.push(`    THEN it fails with a clear error message`);
    lines.push('```');
    lines.push('');
  }

  lines.push('### Layer 3: Unit Tests (innermost)');
  lines.push('');
  lines.push('- Each domain entity has isolated unit tests');
  lines.push('- All external dependencies mocked (London School)');
  lines.push('- Test doubles: Stubs for queries, Mocks for commands, Fakes for repositories');
  lines.push('');

  lines.push('### Test Execution Order');
  lines.push('');
  lines.push('1. Write acceptance test (RED)');
  lines.push('2. Write service test (RED)');
  lines.push('3. Write unit test (RED)');
  lines.push('4. Implement unit (GREEN)');
  lines.push('5. Verify service test (GREEN)');
  lines.push('6. Verify acceptance test (GREEN)');
  lines.push('7. Refactor (REFACTOR)');
  lines.push('');

  lines.push('### Coverage Targets');
  lines.push('');
  lines.push('| Layer | Target | Metric |');
  lines.push('|-------|--------|--------|');
  lines.push('| Unit | 90%+ | Line coverage |');
  lines.push('| Service | 80%+ | Branch coverage |');
  lines.push('| Acceptance | 100% | Requirements coverage |');

  return lines.join('\n');
}

/**
 * Build a Phase2SPARCOutput + ResearchDossier from multi-agent `agentics ask` results.
 * This bridges the ask flow into the shared ADR generator in adr-generator.ts,
 * ensuring ONE ADR generation path for the entire platform.
 */
function buildSPARCFromAgentData(query: string, data: AgentData): { sparc: Phase2SPARCOutput; dossier: ResearchDossier } {
  const subobjectives = extractSubobjectives(data.decomposition);
  const planSteps = extractPlanSteps(data.plan);
  const riskFactors = extractRiskFactors(data.risk);

  // S — Specification: from copilot/decomposer
  const requirements = subobjectives.map((obj, i) => ({
    id: `SPEC-REQ-${String(i + 1).padStart(3, '0')}`,
    text: `${obj.title}: ${obj.criteria}`,
    priority: 'must' as const,
    dossierItemRefs: [`RD-${String(i + 1).padStart(3, '0')}`],
  }));
  const constraints = riskFactors.map((r, i) => ({
    id: `CON-${String(i + 1).padStart(3, '0')}`,
    text: `${r.factor}: ${r.description}`,
    dossierItemRefs: [] as string[],
  }));

  // A — Architecture: from copilot/planner + decomposer
  const services = subobjectives.map((obj, i) => ({
    id: `SVC-${String(i + 1).padStart(3, '0')}`,
    name: obj.title,
    responsibility: obj.criteria,
    api: [] as string[],
    dependencies: [] as string[],
    dossierItemRefs: [`RD-${String(i + 1).padStart(3, '0')}`],
  }));

  // R — Refinement: security and performance from risk-score + query analysis
  const securityItems: Array<{ id: string; text: string; dossierItemRefs: string[] }> = riskFactors
    .filter(r => /secur|auth|access|encrypt|privacy|credential/i.test(r.factor + ' ' + r.description))
    .map((r, i) => ({ id: `sec-${i + 1}`, text: `${r.factor}: ${r.description}`, dossierItemRefs: [] as string[] }));
  if (securityItems.length === 0 && /audit|compliance|regulatory|governance|security/i.test(query)) {
    securityItems.push({ id: 'sec-1', text: 'Auditability and regulatory compliance for all state-changing operations', dossierItemRefs: [] });
  }

  const perfItems = riskFactors
    .filter(r => /perform|latenc|throughput|scal|speed|optimi/i.test(r.factor + ' ' + r.description))
    .map((r, i) => ({ id: `perf-${i + 1}`, text: `${r.factor}: ${r.description}`, dossierItemRefs: [] as string[] }));

  // C — Completion: from orchestrator/workflow + copilot/planner
  const integrationSteps = planSteps.map(s => s.name).join('; ');

  const sparc: Phase2SPARCOutput = {
    specification: {
      requirements,
      constraints,
      successCriteria: subobjectives.map((obj, i) => ({
        id: `SC-${String(i + 1).padStart(3, '0')}`,
        text: obj.criteria,
        dossierItemRefs: [] as string[],
        measurable: true,
      })),
      scope: query.slice(0, 500),
      dossierCoverage: 0.8,
    },
    pseudocode: {
      modules: subobjectives.map((obj, i) => ({
        id: `PC-MOD-${String(i + 1).padStart(3, '0')}`,
        name: obj.title,
        algorithms: [obj.title],
        markdown: `// ${obj.title}\n${obj.criteria}`,
        tddAnchors: [`test_${obj.title.toLowerCase().replace(/\s+/g, '_')}`],
        dataStructures: [],
        dossierItemRefs: [`RD-${String(i + 1).padStart(3, '0')}`],
      })),
    },
    architecture: {
      services,
      boundaries: subobjectives.map((obj, i) => ({
        id: `BC-${String(i + 1).padStart(3, '0')}`,
        name: obj.title,
        description: obj.criteria,
        dossierItemRefs: [] as string[],
      })),
      dataFlow: integrationSteps || 'Event-driven communication between bounded contexts',
      apiContracts: services.map(s => `${s.name} API`),
      securityBoundaries: securityItems.map(s => s.text),
    },
    refinement: {
      securityConsiderations: securityItems,
      performanceTargets: perfItems,
      testStrategy: 'TDD with London School mocking for service boundaries',
    },
    completion: {
      integrationPlan: integrationSteps || 'Phased delivery with prototype at each stage',
      documentation: ['Architecture decisions', 'API contracts', 'Domain model'],
      monitoringSetup: ['Health checks', 'Audit logging', 'Performance metrics'],
    },
  };

  // Build research dossier from all agent results
  // Use valid DossierItemSource values: 'scenario' | 'roadmap' | 'executive-summary' | 'risk-assessment' | 'decision-memo'
  const dossierItems: ResearchDossier['items'] = [];
  let itemIdx = 1;

  // Requirements from decomposer → mapped to 'scenario' source (closest match)
  for (const obj of subobjectives) {
    dossierItems.push({
      id: `RD-${String(itemIdx++).padStart(3, '0')}`,
      title: obj.title,
      content: obj.criteria,
      source: 'scenario',
      category: 'requirement',
    });
  }

  // Risks from risk-score
  for (const r of riskFactors) {
    dossierItems.push({
      id: `RD-${String(itemIdx++).padStart(3, '0')}`,
      title: r.factor,
      content: r.description,
      source: 'risk-assessment',
      category: 'risk',
      severity: r.score >= 70 ? 'high' : r.score >= 40 ? 'medium' : 'low',
    });
  }

  // Compliance items from query keywords
  if (/audit|compliance|regulatory|governance/i.test(query)) {
    dossierItems.push({
      id: `RD-${String(itemIdx++).padStart(3, '0')}`,
      title: 'Compliance and Auditability',
      content: 'System requires strict audit trail, human-in-the-loop governance, and regulatory compliance',
      source: 'decision-memo',
      category: 'constraint',
    });
  }

  // Data items from query
  if (/data|database|storage|persistence/i.test(query)) {
    dossierItems.push({
      id: `RD-${String(itemIdx++).padStart(3, '0')}`,
      title: 'Data Persistence Requirements',
      content: 'System requires structured data storage, analytics capability, and audit log persistence',
      source: 'scenario',
      category: 'requirement',
    });
  }

  // ERP integration from connector-hub/erp-surface
  if (data.erp) {
    dossierItems.push({
      id: `RD-${String(itemIdx++).padStart(3, '0')}`,
      title: 'ERP Integration Surface',
      content: JSON.stringify(data.erp).slice(0, 300),
      source: 'roadmap',
      category: 'constraint',
    });
  }

  // Scenario data
  if (data.scenario) {
    dossierItems.push({
      id: `RD-${String(itemIdx++).padStart(3, '0')}`,
      title: 'Scenario Analysis',
      content: JSON.stringify(data.scenario).slice(0, 300),
      source: 'scenario',
      category: 'decision-rationale',
    });
  }

  // Executive summary data
  if (data.executiveSummary) {
    dossierItems.push({
      id: `RD-${String(itemIdx++).padStart(3, '0')}`,
      title: 'Executive Summary',
      content: JSON.stringify(data.executiveSummary).slice(0, 300),
      source: 'executive-summary',
      category: 'recommendation',
    });
  }

  // ADR-PIPELINE-036 §4: Deduplicate dossier items before finalizing
  const deduped = deduplicateDossierItems(dossierItems);
  // Renumber after dedup — create new objects since id may be readonly
  const deduplicatedItems = deduped.map((item, i) => ({
    ...item,
    id: `RD-${String(i + 1).padStart(3, '0')}`,
  }));

  const byCategory: Record<string, number> = {};
  const bySource: Record<string, number> = {};
  for (const item of deduplicatedItems) {
    byCategory[item.category] = (byCategory[item.category] ?? 0) + 1;
    bySource[item.source] = (bySource[item.source] ?? 0) + 1;
  }

  const dossier: ResearchDossier = {
    id: `ask-dossier-${Date.now()}`,
    traceId: `ask-${Date.now()}`,
    generatedFrom: 'agentics-ask-multi-agent',
    items: deduplicatedItems,
    crossReferences: [],
    summary: {
      totalItems: dossierItems.length,
      bySource,
      byCategory,
      keyRisks: riskFactors.filter(r => r.score >= 60).map(r => r.factor),
      criticalConstraints: constraints.map(c => c.text).slice(0, 3),
    },
  };

  return { sparc, dossier };
}

function buildDddModel(query: string, data: AgentData): string {
  const lines: string[] = [];
  const now = new Date().toISOString();
  const subobjectives = extractSubobjectives(data.decomposition);

  lines.push('# Domain-Driven Design Model');
  lines.push('');
  lines.push(`> Generated: ${now}`);
  lines.push(`> Project: ${query}`);
  lines.push('');

  lines.push('## Ubiquitous Language');
  lines.push('');
  lines.push('| Term | Definition | Context |');
  lines.push('|------|-----------|---------|');
  for (const obj of subobjectives) {
    const term = obj.title.replace(/^(Analyze|Design|Implement|Plan|Define|Review|Set Up)\s+/i, '');
    lines.push(`| ${term} | ${obj.criteria} | Core Domain |`);
  }
  lines.push('');

  lines.push('## Bounded Contexts');
  lines.push('');
  lines.push('```');
  lines.push('┌─────────────────────────────────────────────────────┐');
  lines.push('│                    System Boundary                   │');
  lines.push('│                                                     │');
  lines.push('│  ┌─────────────┐  ┌──────────────┐  ┌───────────┐  │');
  lines.push('│  │   Core      │  │  Integration │  │  Support   │  │');
  lines.push('│  │   Domain    │  │  Context     │  │  Context   │  │');
  lines.push('│  │             │  │              │  │            │  │');
  lines.push('│  │ - Entities  │  │ - Adapters   │  │ - Auth     │  │');
  lines.push('│  │ - Services  │  │ - Events     │  │ - Logging  │  │');
  lines.push('│  │ - Repos     │  │ - Transforms │  │ - Config   │  │');
  lines.push('│  └─────────────┘  └──────────────┘  └───────────┘  │');
  lines.push('│                                                     │');
  lines.push('└─────────────────────────────────────────────────────┘');
  lines.push('```');
  lines.push('');

  lines.push('## Aggregates');
  lines.push('');
  for (let i = 0; i < Math.min(subobjectives.length, 5); i++) {
    const obj = subobjectives[i]!;
    const name = obj.title.replace(/^(Analyze|Design|Implement|Plan|Define|Review|Set Up)\s+/i, '');
    lines.push(`### ${name} Aggregate`);
    lines.push('');
    lines.push(`- **Root Entity:** ${name}`);
    lines.push(`- **Invariants:** ${obj.criteria}`);
    lines.push(`- **Commands:** Create${name.replace(/\s/g, '')}, Update${name.replace(/\s/g, '')}, Delete${name.replace(/\s/g, '')}`);
    lines.push(`- **Events:** ${name.replace(/\s/g, '')}Created, ${name.replace(/\s/g, '')}Updated`);
    lines.push('');
  }

  lines.push('## Context Map');
  lines.push('');
  lines.push('| Upstream | Downstream | Relationship |');
  lines.push('|----------|-----------|-------------|');
  lines.push('| Core Domain | Integration Context | Published Language |');
  lines.push('| Integration Context | Support Context | Conformist |');
  if (data.erp) {
    lines.push('| ERP System (external) | Integration Context | Anti-Corruption Layer |');
  }
  lines.push('');

  lines.push('## Domain Events');
  lines.push('');
  lines.push('```');
  for (const obj of subobjectives.slice(0, 5)) {
    const name = obj.title.replace(/^(Analyze|Design|Implement|Plan|Define|Review|Set Up)\s+/i, '').replace(/\s/g, '');
    lines.push(`EVENT ${name}Completed {`);
    lines.push(`  aggregate_id: UUID`);
    lines.push(`  timestamp: DateTime`);
    lines.push(`  payload: ${name}Data`);
    lines.push(`}`);
    lines.push('');
  }
  lines.push('```');

  return lines.join('\n');
}

function buildEngineeringRoadmap(query: string, data: AgentData): string {
  const lines: string[] = [];
  const now = new Date().toISOString();
  const subobjectives = extractSubobjectives(data.decomposition);
  const planSteps = extractPlanSteps(data.plan);
  const riskFactors = extractRiskFactors(data.risk);

  lines.push('# Implementation Roadmap');
  lines.push('');
  lines.push(`> Generated: ${now}`);
  lines.push(`> Project: ${query}`);
  lines.push('');

  lines.push('## Phase 0: Deep Research');
  lines.push('');
  lines.push('- [ ] Domain research and competitive analysis');
  lines.push('- [ ] Technology stack evaluation');
  lines.push('- [ ] Stakeholder interviews and requirements validation');
  lines.push('- [ ] Proof of concept for high-risk components');
  lines.push('');

  lines.push('## Phase 1: Foundation (SPARC: Specification + Architecture)');
  lines.push('');
  lines.push('- [ ] Finalize SPARC specification (see sparc-specification.md)');
  lines.push('- [ ] Review and approve ADRs (see architecture-decisions.md)');
  lines.push('- [ ] Validate domain model (see domain-model.md)');
  lines.push('- [ ] Set up project scaffolding and CI/CD');
  lines.push('');

  lines.push('## Phase 2: Core Implementation (SPARC: Pseudocode + Refinement)');
  lines.push('');
  for (const obj of subobjectives.filter(o => o.complexity === 'Complex' || o.complexity === 'Moderate')) {
    lines.push(`- [ ] ${obj.title}: ${obj.criteria}`);
  }
  lines.push('');

  lines.push('## Phase 3: Integration & Testing (TDD)');
  lines.push('');
  lines.push('- [ ] Execute TDD test plan (see tdd-test-plan.md)');
  for (const obj of subobjectives.filter(o => o.complexity === 'Simple')) {
    lines.push(`- [ ] ${obj.title}: ${obj.criteria}`);
  }
  lines.push('');

  lines.push('## Phase 4: Completion (SPARC: Completion)');
  lines.push('');
  lines.push('- [ ] End-to-end testing');
  lines.push('- [ ] Security audit');
  lines.push('- [ ] Performance benchmarking');
  lines.push('- [ ] Documentation');
  lines.push('- [ ] Deployment');
  lines.push('');

  if (riskFactors.length > 0) {
    lines.push('## Risk Mitigations');
    lines.push('');
    lines.push('| Risk | Score | Mitigation |');
    lines.push('|------|-------|-----------|');
    for (const risk of riskFactors) {
      lines.push(`| ${risk.factor} | ${risk.score}/100 | ${risk.description} |`);
    }
    lines.push('');
  }

  if (planSteps.length > 0) {
    lines.push('## Dependency Graph');
    lines.push('');
    for (const step of planSteps) {
      const deps = step.dependencies.length > 0 ? ` (depends on: ${step.dependencies.join(', ')})` : '';
      lines.push(`- ${step.id}. **${step.name}**: ${step.description}${deps}`);
    }
    lines.push('');
  }

  // Full fleet agent coverage — auto-generated from all results
  lines.push('## Agent Fleet Coverage');
  lines.push('');
  lines.push(`**Total agents dispatched:** ${data.allResults.length}`);
  lines.push('');
  lines.push('| Domain/Agent | Status |');
  lines.push('|-------------|--------|');
  for (const r of data.allResults) {
    lines.push(`| ${r.domain}/${r.agent} | Data received |`);
  }
  if (data.simulation) {
    lines.push('| ruvector/simulation | Data received |');
  }

  return lines.join('\n');
}

// ============================================================================
// Data Extraction Helpers for Engineering Artifacts
// ============================================================================

interface Subobjective { title: string; complexity: string; criteria: string }
interface PlanStep { id: string; name: string; description: string; dependencies: string[] }
interface RiskFactor { factor: string; score: number; description: string }

function extractSubobjectives(decomposition: Record<string, unknown> | null): Subobjective[] {
  if (!decomposition) return [];
  // copilot/decomposer returns { sub_objectives: [...] } or { data: { sub_objectives: [...] } }
  const subs = (decomposition['sub_objectives'] ?? decomposition['subobjectives'] ?? []) as Array<Record<string, unknown>>;
  return subs.map(s => ({
    title: sanitizeTitle((s['title'] ?? s['name'] ?? 'Untitled') as string),
    complexity: (s['complexity'] ?? 'Moderate') as string,
    criteria: sanitizeCriteria((s['acceptance_criteria'] ?? s['criteria'] ?? s['description'] ?? '') as string),
  }));
}

/**
 * Clean up titles extracted from agent decomposition output.
 * Prevents truncated sentence fragments (e.g., "Capability: and fix issues. While we have some")
 * from being used as requirement names.
 */
function sanitizeTitle(raw: string): string {
  let title = raw.trim();

  // Strip common prefixes that leak from query extraction
  title = title.replace(/^(Capability|Requirement|Feature|Task|Objective|Goal|Area|System):\s*/i, '');

  // If it looks like a sentence fragment (starts lowercase, contains mid-sentence text),
  // try to extract the meaningful noun phrase
  if (title.length > 0 && title[0] === title[0]!.toLowerCase() && /^(and|or|but|with|for|to|the|that|which|where|when|while|if)\s/i.test(title)) {
    // This is a fragment — truncated from a longer sentence
    title = 'Untitled Objective';
  }

  // Truncate at sentence boundary if the title is unreasonably long (>100 chars)
  if (title.length > 100) {
    const sentenceEnd = title.indexOf('. ');
    if (sentenceEnd > 10 && sentenceEnd < 100) {
      title = title.slice(0, sentenceEnd);
    } else {
      // Hard truncate at word boundary
      const truncated = title.slice(0, 100);
      const lastSpace = truncated.lastIndexOf(' ');
      title = lastSpace > 50 ? truncated.slice(0, lastSpace) : truncated;
    }
  }

  // Capitalize first letter
  if (title.length > 0) {
    title = title[0]!.toUpperCase() + title.slice(1);
  }

  return title || 'Untitled Objective';
}

/**
 * Clean up acceptance criteria / description text from agent output.
 * Prevents raw query text from leaking into structured dossier items.
 */
function sanitizeCriteria(raw: string): string {
  let text = raw.trim();

  // If the criteria is suspiciously long (>500 chars), it's likely the raw query leaked in
  if (text.length > 500) {
    // Try to extract just the first meaningful sentence
    const firstSentence = text.match(/^[^.!?]+[.!?]/);
    if (firstSentence && firstSentence[0]!.length > 20) {
      text = firstSentence[0]!;
    } else {
      text = text.slice(0, 300);
      const lastSpace = text.lastIndexOf(' ');
      if (lastSpace > 200) text = text.slice(0, lastSpace);
    }
  }

  return text || 'Criteria to be defined during requirements analysis';
}

/**
 * ADR-PIPELINE-036 §4: Dossier-level deduplication.
 * Removes items with identical content or title, and filters raw query leakage.
 */
function deduplicateDossierItems(items: ResearchDossier['items']): ResearchDossier['items'] {
  const seenContent = new Set<string>();
  const seenTitles = new Set<string>();

  return items.filter(item => {
    const normalizedContent = item.content.toLowerCase().replace(/\s+/g, ' ').trim();
    const normalizedTitle = item.title.toLowerCase().trim();

    // Duplicate content
    if (normalizedContent.length > 10 && seenContent.has(normalizedContent)) return false;

    // Duplicate title within same category
    const titleKey = `${item.category}:${normalizedTitle}`;
    if (seenTitles.has(titleKey)) return false;

    // Raw query leakage — biographical content in dossier items
    if (normalizedContent.length > 500 && /^i lead|^we are|^our company|^i manage/i.test(item.content.trim())) return false;

    // Sentence-fragment titles
    if (item.title.length > 5 && /^(and|or|but|with|for|the|that|which|while|if)\s/i.test(item.title)) return false;

    seenContent.add(normalizedContent);
    seenTitles.add(titleKey);
    return true;
  });
}

function extractPlanSteps(plan: Record<string, unknown> | null): PlanStep[] {
  if (!plan) return [];
  const steps = (plan['steps'] ?? plan['plan'] ?? []) as Array<Record<string, unknown>>;
  return steps.map((s, i) => ({
    id: String(s['step_number'] ?? s['id'] ?? i),
    name: (s['name'] ?? s['title'] ?? `Step ${i + 1}`) as string,
    description: (s['description'] ?? '') as string,
    dependencies: ((s['dependencies'] ?? []) as Array<Record<string, unknown>>).map(
      d => (d['step'] ?? d['name'] ?? String(d)) as string,
    ),
  }));
}

function extractRiskFactors(risk: Record<string, unknown> | null): RiskFactor[] {
  if (!risk) return [];
  const factors = (risk['risk_factors'] ?? risk['factors'] ?? []) as Array<Record<string, unknown>>;
  return factors.map(f => ({
    factor: (f['factor'] ?? f['name'] ?? 'Unknown') as string,
    score: (f['score'] ?? 50) as number,
    description: (f['description'] ?? f['mitigation'] ?? '') as string,
  }));
}

// ============================================================================
// Main: Persist Ask Results
// ============================================================================

/**
 * Persist `agentics ask` results to disk.
 *
 * - Development mode: writes to ~/.agentics/runs/<traceId>/
 * - Project mode: creates branch, writes to .agentics/runs/<traceId>/ in repo, commits
 *
 * NON-FATAL: all errors are caught and logged as warnings. Returns null on failure.
 */
export async function persistAskResults(input: AskPersistInput): Promise<AskPersistOutput | null> {
  try {
    const execCtx = detectExecutionMode();

    if (execCtx.mode === 'project' && execCtx.isGitRepo && execCtx.isCleanTree) {
      return await persistProjectMode(input, execCtx);
    }

    // Dev mode, or project mode with dirty tree (graceful fallback)
    if (execCtx.mode === 'project' && !execCtx.isCleanTree) {
      console.error('  [WARN] Working tree has uncommitted changes — writing artifacts to ~/.agentics/runs/ instead');
    }

    return await persistDevMode(input, execCtx);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`  [WARN] Could not persist ask results: ${msg}`);
    return null;
  }
}

async function persistDevMode(input: AskPersistInput, _execCtx: ExecutionContext): Promise<AskPersistOutput> {
  const baseDir = path.join(os.homedir(), '.agentics', 'runs');
  const runDir = path.join(baseDir, input.traceId);

  const filesWritten = await writeArtifacts(runDir, input);

  return {
    runDir,
    filesWritten,
    mode: 'development',
  };
}

async function persistProjectMode(input: AskPersistInput, execCtx: ExecutionContext): Promise<AskPersistOutput> {
  const originalBranch = execCtx.currentBranch ?? 'main';
  const branch = generateAskBranchName(input.query);

  createScenarioBranch(branch);

  // Write artifacts to .agentics/runs/<traceId>/ within the repo
  const repoRoot = execCtx.repoRoot ?? process.cwd();
  const runDir = path.join(repoRoot, '.agentics', 'runs', input.traceId);
  const filesWritten = await writeArtifacts(runDir, input);

  // Commit
  let commitHash: string | undefined;
  try {
    commitHash = commitScenarioFiles(input.query);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`  [WARN] Failed to commit artifacts: ${msg}`);
  }

  // Push the branch to remote so the GitHub URL is valid
  try {
    execSync(`git push -u origin ${branch}`, { stdio: 'pipe', timeout: 30000 });
  } catch {
    console.error('  [WARN] Could not push artifacts branch to remote');
  }

  // Return to original branch
  checkoutBranch(originalBranch);

  // Build GitHub URL
  let githubUrl: string | undefined;
  if (execCtx.remoteUrl) {
    const ghInfo = parseGitHubRemote(execCtx.remoteUrl);
    if (ghInfo) {
      githubUrl = `https://github.com/${ghInfo.owner}/${ghInfo.repo}/tree/${branch}/.agentics/runs/${input.traceId}`;
    }
  }

  return {
    runDir,
    filesWritten,
    mode: 'project',
    branch,
    commitHash,
    githubUrl,
  };
}

// ============================================================================
// Link Printing
// ============================================================================

/**
 * Print a clickable output link based on execution mode and environment.
 */
export function printOutputLink(output: AskPersistOutput): void {
  console.error('');
  console.error('  ' + '─'.repeat(60));

  if (output.mode === 'project' && output.branch) {
    console.error('  Run artifacts committed to branch:');
    console.error('');

    // Print GitHub URL as an OSC 8 clickable link if available
    if (output.githubUrl) {
      const osc8Link = formatOsc8Link(output.githubUrl, `  View on GitHub: ${output.githubUrl}`);
      console.error(osc8Link);
    }

    console.error('');
    console.error(`  Branch:  ${output.branch}`);
    if (output.commitHash) {
      console.error(`  Commit:  ${output.commitHash.slice(0, 8)}`);
    }
    console.error('');
    console.error('  To browse:');
    console.error(`    git checkout ${output.branch}`);
    console.error(`    ls .agentics/runs/${path.basename(output.runDir)}/`);
    console.error('');
    console.error('  To compare with main:');
    console.error(`    git diff main...${output.branch} --stat`);
  } else {
    // Dev mode
    console.error('  Run artifacts saved:');
    console.error('');

    const isCodespace = process.env['CODESPACES'] === 'true';

    if (isCodespace) {
      // In Codespace, use vscode://file/ URI for clickable link
      const vscodeUri = `vscode://file${output.runDir}`;
      const osc8Link = formatOsc8Link(vscodeUri, `  Open in editor: ${output.runDir}`);
      console.error(osc8Link);
    } else {
      console.error(`  ${output.runDir}`);
    }

    console.error('');

    const engFiles = output.filesWritten.filter(f => f.startsWith('engineering/'));
    const baseFiles = output.filesWritten.filter(f => !f.startsWith('engineering/'));

    console.error('  Files:');
    for (const f of baseFiles) {
      const fullPath = path.join(output.runDir, f);
      console.error(`    ${fullPath}`);
    }

    if (engFiles.length > 0) {
      console.error('');
      console.error('  Engineering Artifacts:');
      for (const f of engFiles) {
        const fullPath = path.join(output.runDir, f);
        const label = f.replace('engineering/', '').replace('.md', '');
        console.error(`    ${label}: ${fullPath}`);
      }
    }

    console.error('');
    console.error('  To inspect:');
    console.error(`    cat ${path.join(output.runDir, 'summary.md')}`);
    if (engFiles.length > 0) {
      console.error(`    cat ${path.join(output.runDir, 'engineering', 'sparc-specification.md')}`);
      console.error(`    cat ${path.join(output.runDir, 'engineering', 'implementation-roadmap.md')}`);
    }
    console.error(`    agentics inspect run ${path.basename(output.runDir)}`);
  }

  console.error('  ' + '─'.repeat(60));
  console.error('');
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Format an OSC 8 terminal hyperlink.
 * Supported by VS Code terminal, iTerm2, Windows Terminal, etc.
 * Falls back to plain text in unsupported terminals.
 */
function formatOsc8Link(url: string, label: string): string {
  // OSC 8 format: \e]8;;URL\e\\LABEL\e]8;;\e\\
  return `\x1b]8;;${url}\x1b\\${label}\x1b]8;;\x1b\\`;
}

/**
 * Parse GitHub owner/repo from a remote URL.
 * Handles both HTTPS and SSH formats.
 */
function parseGitHubRemote(remoteUrl: string): { owner: string; repo: string } | null {
  // HTTPS: https://github.com/owner/repo.git
  const httpsMatch = remoteUrl.match(/github\.com[/:]([^/]+)\/([^/.]+)/);
  if (httpsMatch) {
    return { owner: httpsMatch[1]!, repo: httpsMatch[2]! };
  }
  return null;
}
