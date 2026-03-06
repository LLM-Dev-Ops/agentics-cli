/**
 * Generalized Ruflo Phase Executor
 *
 * A single, shared executor that runs Ruflo agent swarms for ANY pipeline phase.
 * Each phase passes its own task definitions, artifact context, and agentics
 * agent results — the executor handles swarm init, task creation, and execution.
 *
 * CRITICAL: When Ruflo swarm produces 0 files (no LLM backend in this env),
 * the executor falls back to extracting actual code files from agentics agent
 * responses (forge/sdk, forge/cli return real TypeScript files in their responses)
 * and writing them to disk. This is the cooperation path — agentics agents
 * produce real code, not templates.
 *
 * Supports all 17 target languages — Ruflo is language-agnostic.
 */

import { execSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

import type { AgenticsServiceResult } from './swarm-orchestrator.js';

// ============================================================================
// Types
// ============================================================================

/** A task to dispatch to the Ruflo swarm. */
export interface RufloTask {
  /** Human-readable label for the task. */
  readonly label: string;
  /** Full task description including what to build and quality expectations. */
  readonly description: string;
  /** Target directory for this task's output (relative to project root). */
  readonly targetDir: string;
}

/** Phase-specific configuration for the Ruflo swarm. */
export interface RufloPhaseConfig {
  /** Pipeline phase number (2-6). */
  readonly phase: number;
  /** Human-readable phase label. */
  readonly label: string;
  /** The user's original natural language query. */
  readonly scenarioQuery: string;
  /** Run directory (~/.agentics/runs/<traceId>). */
  readonly runDir: string;
  /** Trace ID for this pipeline run. */
  readonly traceId: string;
  /** Tasks to dispatch to the swarm. */
  readonly tasks: RufloTask[];
  /** Agentics agent results from this phase's dispatch. */
  readonly agenticsResults: AgenticsServiceResult[];
  /** Artifact file paths from prior phases (key=label, value=absolute path). */
  readonly priorArtifacts: Record<string, string>;
  /** Target directory for swarm output. */
  readonly outputDir: string;
  /** Maximum agents in the swarm (default: 8). */
  readonly maxAgents?: number;
  /** Swarm timeout in ms (default: 600000 = 10 min). */
  readonly timeoutMs?: number;
}

/** Result of a Ruflo phase execution. */
export interface RufloPhaseResult {
  /** Whether the swarm was invoked at all. */
  readonly invoked: boolean;
  /** Whether ruflo was available. */
  readonly rufloAvailable: boolean;
  /** Number of files generated/modified. */
  readonly filesModified: number;
  /** Number of tasks created. */
  readonly tasksCreated: number;
  /** Whether the swarm completed successfully. */
  readonly swarmCompleted: boolean;
  /** Wall-clock time in ms. */
  readonly timing: number;
  /** Ruflo version string. */
  readonly version: string;
  /** Number of code files extracted from agentics agent responses. */
  readonly agentCodeFilesWritten: number;
}

/** A code file extracted from an agentics agent response. */
interface AgentCodeFile {
  readonly sourceDomain: string;
  readonly sourceAgent: string;
  readonly filePath: string;
  readonly content: string;
  readonly sizeBytes: number;
}

// ============================================================================
// Constants
// ============================================================================

const CHECK_TIMEOUT = 30_000;
const DEFAULT_SWARM_TIMEOUT = 600_000;
const DEFAULT_MAX_AGENTS = 8;
const MAX_ARTIFACT_CONTENT_BYTES = 32_000;

// ============================================================================
// Binary Resolution (shared — no duplication)
// ============================================================================

let _cachedBinary: string | null | undefined;

/**
 * Resolve the ruflo binary. Checks local node_modules, walks up, then global.
 * Result is cached for the process lifetime.
 */
export function resolveRufloBinary(): string | null {
  if (_cachedBinary !== undefined) return _cachedBinary;

  // Priority 1: Local node_modules binary
  const localBin = path.resolve(process.cwd(), 'node_modules', '.bin', 'ruflo');
  if (fs.existsSync(localBin)) { _cachedBinary = localBin; return _cachedBinary; }

  // Priority 2: Walk up from CWD
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, 'node_modules', '.bin', 'ruflo');
    if (fs.existsSync(candidate)) { _cachedBinary = candidate; return _cachedBinary; }
    dir = path.dirname(dir);
  }

  // Priority 3: Global binary
  try {
    const global = execSync('which ruflo', { stdio: 'pipe', encoding: 'utf-8', timeout: CHECK_TIMEOUT }).trim();
    if (global) { _cachedBinary = global; return _cachedBinary; }
  } catch { /* not found globally */ }

  _cachedBinary = null;
  return null;
}

/** Check ruflo is installed and has swarm support. */
export function checkRufloAvailable(): { available: boolean; version: string; binary: string } {
  const binary = resolveRufloBinary();
  if (!binary) return { available: false, version: 'N/A', binary: '' };

  try {
    const output = execSync(`${binary} --version`, {
      encoding: 'utf-8', timeout: CHECK_TIMEOUT, stdio: 'pipe',
    });
    const version = output.trim() || 'unknown';

    // Verify swarm subcommand
    try {
      execSync(`${binary} swarm --help`, { encoding: 'utf-8', timeout: CHECK_TIMEOUT, stdio: 'pipe' });
    } catch {
      return { available: false, version: `${version} (swarm not supported)`, binary };
    }

    return { available: true, version, binary };
  } catch {
    return { available: false, version: 'N/A', binary };
  }
}

// ============================================================================
// Helpers
// ============================================================================

function rufloExec(binary: string, args: string[], cwd: string, timeout = CHECK_TIMEOUT): string {
  const result = spawnSync(binary, args, {
    cwd, timeout, encoding: 'utf-8', stdio: 'pipe',
  });
  if (result.status !== 0) {
    const stderr = (result.stderr ?? '').trim();
    throw new Error(`ruflo ${args[0]} failed (exit ${result.status}): ${stderr.slice(0, 300)}`);
  }
  return (result.stdout ?? '').trim();
}

function countFiles(dir: string): number {
  if (!fs.existsSync(dir)) return 0;
  let count = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory() && !['node_modules', '.git', '.claude-flow', '.swarm'].includes(entry.name)) {
      count += countFiles(path.join(dir, entry.name));
    } else if (entry.isFile() && entry.name !== '.gitkeep') {
      count++;
    }
  }
  return count;
}

// ============================================================================
// Artifact Content Reader (reads ACTUAL FILE CONTENT, not just paths)
// ============================================================================

/**
 * Read the actual content of prior-phase artifacts from disk.
 * This is the critical difference from before — we pass CONTENT to the swarm,
 * not just file paths that the swarm can't access.
 */
function readArtifactContent(artifacts: Record<string, string>): string {
  const parts: string[] = [];
  for (const [label, filePath] of Object.entries(artifacts)) {
    if (!fs.existsSync(filePath)) continue;
    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      // Truncate very large artifacts but keep enough for meaningful context
      const content = raw.length > MAX_ARTIFACT_CONTENT_BYTES
        ? raw.slice(0, MAX_ARTIFACT_CONTENT_BYTES) + '\n... [truncated]'
        : raw;
      parts.push(`\n=== ARTIFACT: ${label} (${filePath}) ===\n${content}\n=== END ${label} ===`);
    } catch {
      // Non-fatal
    }
  }
  return parts.join('\n');
}

/**
 * Build artifact context string from prior phase artifacts (paths only — for task labels).
 */
function buildArtifactContext(artifacts: Record<string, string>): string {
  const parts: string[] = [];
  for (const [label, filePath] of Object.entries(artifacts)) {
    if (fs.existsSync(filePath)) {
      parts.push(`${label}=${filePath}`);
    }
  }
  return parts.join(', ');
}

// ============================================================================
// Implementation Prompt Builder
// ============================================================================

/**
 * Extract a concise list of bounded contexts from the DDD domain-model.json.
 * Returns structured data for the implementation prompt.
 */
function extractDDDSummary(dddPath: string): {
  contexts: { name: string; aggregates: string[]; commands: string[]; queries: string[]; events: string[] }[];
  contextMap: { from: string; to: string; relationship: string }[];
} {
  if (!fs.existsSync(dddPath)) return { contexts: [], contextMap: [] };
  try {
    const model = JSON.parse(fs.readFileSync(dddPath, 'utf-8'));
    const contexts = (model?.contexts ?? []).map((ctx: any) => ({
      name: ctx.name ?? 'unknown',
      aggregates: (ctx.aggregates ?? []).map((a: any) => a.name ?? a.root ?? 'unknown'),
      commands: (ctx.commands ?? []).map((c: any) => c.name ?? 'unknown'),
      queries: (ctx.queries ?? []).map((q: any) => q.name ?? 'unknown'),
      events: (ctx.domainEvents ?? []).map((e: any) => e.name ?? 'unknown'),
    }));
    const contextMap = (model?.contextMap ?? []).map((r: any) => ({
      from: r.from ?? r.upstream ?? 'unknown',
      to: r.to ?? r.downstream ?? 'unknown',
      relationship: r.relationship ?? r.type ?? 'unknown',
    }));
    return { contexts, contextMap };
  } catch { return { contexts: [], contextMap: [] }; }
}

/**
 * Extract ADR titles and decisions from adr-index.json.
 */
function extractADRSummary(adrPath: string): { id: string; title: string; decision: string }[] {
  if (!fs.existsSync(adrPath)) return [];
  try {
    const data = JSON.parse(fs.readFileSync(adrPath, 'utf-8'));
    const adrs = Array.isArray(data) ? data : (data?.adrs ?? data?.decisions ?? []);
    return adrs.map((a: any) => ({
      id: a.id ?? a.adr_id ?? 'unknown',
      title: a.title ?? a.name ?? 'unknown',
      decision: (a.decision ?? a.status ?? '').slice(0, 200),
    }));
  } catch { return []; }
}

/**
 * Extract TDD test suites from tdd-plan.json.
 */
function extractTDDSummary(tddPath: string): { suites: { name: string; testCount: number; strategy: string }[]; approach: string } {
  if (!fs.existsSync(tddPath)) return { suites: [], approach: '' };
  try {
    const data = JSON.parse(fs.readFileSync(tddPath, 'utf-8'));
    const suites = (data?.testSuites ?? []).map((s: any) => ({
      name: s.name ?? s.context ?? 'unknown',
      testCount: (s.tests ?? s.cases ?? []).length,
      strategy: s.strategy ?? s.type ?? 'unit',
    }));
    const approach = data?.approach ?? data?.methodology ?? '';
    return { suites, approach };
  } catch { return { suites: [], approach: '' }; }
}

/**
 * Extract SPARC architecture summary from sparc-combined.json.
 */
function extractSPARCSummary(sparcPath: string): { services: string[]; integrations: string[]; pseudocodeModules: string[] } {
  if (!fs.existsSync(sparcPath)) return { services: [], integrations: [], pseudocodeModules: [] };
  try {
    const data = JSON.parse(fs.readFileSync(sparcPath, 'utf-8'));
    const services = (data?.architecture?.services ?? []).map((s: any) => s.name ?? s.service ?? String(s)).slice(0, 20);
    const integrations = (data?.architecture?.integrations ?? data?.architecture?.externalSystems ?? [])
      .map((i: any) => i.name ?? i.system ?? String(i)).slice(0, 10);
    const pseudocodeModules = (data?.pseudocode?.modules ?? []).map((m: any) => m.name ?? m.module ?? String(m)).slice(0, 20);
    return { services, integrations, pseudocodeModules };
  } catch { return { services: [], integrations: [], pseudocodeModules: [] }; }
}

/**
 * Build a structured implementation prompt from pipeline artifacts.
 *
 * This prompt is fed to Ruflo swarms AND the 110 agentics.dev agent fleet.
 * It directs them to implement the ADRs + DDDs with high-level SPARC guidance
 * using London School TDD (outside-in, mock collaborators at seam boundaries).
 *
 * The prompt is written to disk as `implementation-prompt.md` and used as the
 * swarm objective across all phases.
 */
export function buildImplementationPrompt(
  artifacts: Record<string, string>,
  scenarioQuery: string,
  language: string,
): string {
  // Resolve artifact paths
  const dddPath = artifacts['DDD'] ?? artifacts['ddd'] ?? '';
  const adrPath = artifacts['ADRs'] ?? artifacts['adrs'] ?? artifacts['adr-index'] ?? '';
  const tddPath = artifacts['TDD'] ?? artifacts['tdd'] ?? '';
  const sparcPath = artifacts['SPARC'] ?? artifacts['sparc'] ?? artifacts['sparc-combined'] ?? '';

  // Extract structured data from artifacts
  const ddd = extractDDDSummary(dddPath);
  const adrs = extractADRSummary(adrPath);
  const tdd = extractTDDSummary(tddPath);
  const sparc = extractSPARCSummary(sparcPath);

  const lines: string[] = [];

  // Header
  lines.push(`# Implementation Directive`);
  lines.push('');
  lines.push(`Implement the following system in ${language} using London School TDD (outside-in, mock collaborators at seam boundaries).`);
  lines.push(`Ruflo swarm agents and the 110 agentics.dev agent fleet work TOGETHER: agents provide deep analysis (security, quality, governance, ERP integration), Ruflo agents write production code.`);
  lines.push('');

  // Scenario
  lines.push(`## Scenario`);
  lines.push(scenarioQuery.slice(0, 600));
  lines.push('');

  // DDD Bounded Contexts
  if (ddd.contexts.length > 0) {
    lines.push(`## Bounded Contexts (${ddd.contexts.length} from DDD Model)`);
    lines.push('');
    for (const ctx of ddd.contexts) {
      lines.push(`### ${ctx.name}`);
      if (ctx.aggregates.length > 0) lines.push(`- Aggregates: ${ctx.aggregates.join(', ')}`);
      if (ctx.commands.length > 0) lines.push(`- Commands: ${ctx.commands.join(', ')}`);
      if (ctx.queries.length > 0) lines.push(`- Queries: ${ctx.queries.join(', ')}`);
      if (ctx.events.length > 0) lines.push(`- Domain Events: ${ctx.events.join(', ')}`);
      lines.push('');
    }
    if (ddd.contextMap.length > 0) {
      lines.push(`### Context Map`);
      for (const rel of ddd.contextMap) {
        lines.push(`- ${rel.from} -> ${rel.to} (${rel.relationship})`);
      }
      lines.push('');
    }
  }

  // ADR Decisions
  if (adrs.length > 0) {
    lines.push(`## Architectural Decisions (${adrs.length} ADRs)`);
    lines.push('');
    for (const adr of adrs) {
      lines.push(`- **${adr.id}**: ${adr.title}${adr.decision ? ' — ' + adr.decision : ''}`);
    }
    lines.push('');
  }

  // TDD Strategy
  lines.push(`## Test Strategy: London School TDD`);
  lines.push('');
  lines.push('1. Write the test FIRST — define the expected behavior');
  lines.push('2. Mock all collaborator interfaces at aggregate/seam boundaries');
  lines.push('3. Test command handlers in isolation with stubbed repositories and event publishers');
  lines.push('4. Test query handlers with in-memory adapters');
  lines.push('5. Integration tests at seam boundaries verify adapter contracts');
  lines.push('6. Red-green-refactor: minimal code to pass, then clean up');
  lines.push('');
  if (tdd.suites.length > 0) {
    lines.push(`### Test Suites (${tdd.suites.length} from TDD Plan)`);
    for (const suite of tdd.suites) {
      lines.push(`- ${suite.name}: ${suite.testCount} tests (${suite.strategy})`);
    }
    lines.push('');
  }

  // SPARC Architecture Guidance
  if (sparc.services.length > 0 || sparc.integrations.length > 0) {
    lines.push(`## Architecture Guidance (from SPARC Specification)`);
    lines.push('');
    if (sparc.services.length > 0) lines.push(`- Services: ${sparc.services.join(', ')}`);
    if (sparc.integrations.length > 0) lines.push(`- External Integrations: ${sparc.integrations.join(', ')}`);
    if (sparc.pseudocodeModules.length > 0) lines.push(`- Pseudocode Modules: ${sparc.pseudocodeModules.join(', ')}`);
    lines.push('');
  }

  // Implementation Rules
  lines.push(`## Implementation Rules`);
  lines.push('');
  lines.push('1. Every command handler gets a unit test FIRST (London School: mock deps, verify interactions)');
  lines.push('2. Aggregates enforce invariants — throw on violation, never allow invalid state');
  lines.push('3. Domain events emitted on every state change — events are the source of truth');
  lines.push('4. Ports/adapters pattern: domain logic has ZERO infrastructure imports');
  lines.push('5. All ERP calls go through adapter interfaces — never call ERP directly from domain');
  lines.push('6. Use the agentics agent fleet analysis for: security constraints (shield), quality baselines (test-bench), ERP surface mapping (connector-hub), governance requirements (governance-dashboard)');
  lines.push('7. Write REAL business logic — not stubs, not TODOs, not placeholder comments');
  lines.push('8. Each bounded context is a separate module with its own aggregate, commands, queries, events, and ports');
  lines.push('');

  // Artifact file paths for reference
  const pathLines: string[] = [];
  for (const [label, filePath] of Object.entries(artifacts)) {
    if (fs.existsSync(filePath)) pathLines.push(`- ${label}: ${filePath}`);
  }
  if (pathLines.length > 0) {
    lines.push(`## Artifact Paths`);
    lines.push('');
    lines.push(...pathLines);
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Build and persist the implementation prompt to disk.
 * Returns the prompt text and the file path where it was written.
 */
export function writeImplementationPrompt(
  runDir: string,
  artifacts: Record<string, string>,
  scenarioQuery: string,
  language: string,
): { prompt: string; promptPath: string } {
  const prompt = buildImplementationPrompt(artifacts, scenarioQuery, language);
  const promptPath = path.join(runDir, 'implementation-prompt.md');
  try {
    fs.writeFileSync(promptPath, prompt, 'utf-8');
  } catch {
    // Non-fatal — the prompt is still returned in-memory
  }
  return { prompt, promptPath };
}

// ============================================================================
// Agentics Agent Code Extraction
// ============================================================================

/**
 * Extract actual code files from agentics agent responses.
 *
 * Agentics agents like forge/sdk and forge/cli return real code files in their
 * response payloads. This function parses those responses and extracts every
 * file with content, ready to be written to disk.
 *
 * Response structures handled:
 *   forge/sdk:  response.artifacts[].content.sdk_artifacts[].files[].{path, content}
 *   forge/cli:  response.artifacts[].content.files[].{path, content}
 *   generic:    response.data.files[].{path, content}
 *   generic:    response.files[].{path, content}
 */
function extractCodeFromAgentResults(results: AgenticsServiceResult[]): AgentCodeFile[] {
  const files: AgentCodeFile[] = [];

  for (const r of results) {
    if (r.status !== 200) continue;
    const resp = r.response as Record<string, unknown> | undefined;
    if (!resp || typeof resp !== 'object') continue;

    // Try multiple known response structures
    extractFromResponse(resp, r.domain, r.agent, files);
  }

  return files;
}

function extractFromResponse(
  resp: Record<string, unknown>,
  domain: string,
  agent: string,
  out: AgentCodeFile[],
): void {
  // Structure 1: response.artifacts[].content.sdk_artifacts[].files[]
  // Structure 2: response.artifacts[].content.files[]
  const artifacts = resp['artifacts'] as unknown[];
  if (Array.isArray(artifacts)) {
    for (const art of artifacts) {
      if (!art || typeof art !== 'object') continue;
      const artObj = art as Record<string, unknown>;
      const content = artObj['content'] as Record<string, unknown>;
      if (!content || typeof content !== 'object') continue;

      // sdk_artifacts path (forge/sdk)
      const sdkArtifacts = content['sdk_artifacts'] as unknown[];
      if (Array.isArray(sdkArtifacts)) {
        for (const sa of sdkArtifacts) {
          if (!sa || typeof sa !== 'object') continue;
          const saObj = sa as Record<string, unknown>;
          const saFiles = saObj['files'] as unknown[];
          if (Array.isArray(saFiles)) {
            extractFilesArray(saFiles, domain, agent, out);
          }
        }
      }

      // Direct files path (forge/cli)
      const contentFiles = content['files'] as unknown[];
      if (Array.isArray(contentFiles)) {
        extractFilesArray(contentFiles, domain, agent, out);
      }
    }
  }

  // Structure 3: response.data.files[]
  const data = resp['data'] as Record<string, unknown>;
  if (data && typeof data === 'object') {
    const dataFiles = data['files'] as unknown[];
    if (Array.isArray(dataFiles)) {
      extractFilesArray(dataFiles, domain, agent, out);
    }
  }

  // Structure 4: response.files[] (direct)
  const directFiles = resp['files'] as unknown[];
  if (Array.isArray(directFiles)) {
    extractFilesArray(directFiles, domain, agent, out);
  }
}

function extractFilesArray(
  files: unknown[],
  domain: string,
  agent: string,
  out: AgentCodeFile[],
): void {
  for (const f of files) {
    if (!f || typeof f !== 'object') continue;
    const fObj = f as Record<string, unknown>;
    const filePath = fObj['path'] as string;
    const content = fObj['content'] as string;
    if (typeof filePath !== 'string' || !filePath) continue;
    if (typeof content !== 'string' || content.length === 0) continue;

    // Deduplicate by path
    if (out.some(existing => existing.filePath === filePath)) continue;

    out.push({
      sourceDomain: domain,
      sourceAgent: agent,
      filePath,
      content,
      sizeBytes: fObj['sizeBytes'] as number ?? content.length,
    });
  }
}

/**
 * Write extracted agent code files to a target directory.
 * Returns the number of files successfully written.
 */
function writeAgentCodeFiles(codeFiles: AgentCodeFile[], targetDir: string): number {
  if (codeFiles.length === 0) return 0;

  let written = 0;
  for (const cf of codeFiles) {
    try {
      const fullPath = path.join(targetDir, cf.filePath);
      const dir = path.dirname(fullPath);
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(fullPath, cf.content, 'utf-8');
      written++;
    } catch {
      // Non-fatal — individual file write failures don't block the pipeline
    }
  }
  return written;
}

// ============================================================================
// Agentics Cooperation Context Builder
// ============================================================================

/**
 * Build a context string from agentics agent results that Ruflo tasks
 * can consume. This is the cooperation point — agentics agents' domain
 * expertise (security scans, ERP surface maps, quality evaluations,
 * schema validations, etc.) becomes available to Ruflo during generation.
 *
 * IMPORTANT: Includes FULL response content for code-producing agents
 * (forge/sdk, forge/cli) and meaningful summaries for analysis agents.
 */
function buildAgenticsCooperationContext(results: AgenticsServiceResult[]): string {
  if (results.length === 0) return '';

  const lines: string[] = [
    '\n--- AGENTICS AGENT FLEET ANALYSIS (use this context during generation) ---',
  ];

  for (const r of results) {
    if (r.status !== 200) continue;

    // For code-producing agents, include full response
    const isCodeProducer = r.domain === 'forge' || r.domain === 'connector-hub';
    const maxLen = isCodeProducer ? 4000 : 1200;

    const response = typeof r.response === 'string'
      ? r.response.slice(0, maxLen)
      : JSON.stringify(r.response).slice(0, maxLen);

    lines.push(`\n[${r.domain}/${r.agent}] (${r.role}):`);
    lines.push(response);
  }

  lines.push('\n--- END AGENTICS ANALYSIS ---');
  return lines.join('\n');
}

// ============================================================================
// Phase-Specific Task Factories
// ============================================================================

/**
 * Build Ruflo tasks for Phase 2: Deep Research.
 * Ruflo writes complete research dossier, not just extracts.
 */
export function buildPhase2Tasks(
  scenarioQuery: string,
  artifacts: Record<string, string>,
): RufloTask[] {
  const artifactCtx = buildArtifactContext(artifacts);
  return [
    {
      label: 'Research Dossier',
      description: `Conduct deep research analysis for: ${scenarioQuery.slice(0, 500)}. ` +
        `Produce a comprehensive research dossier covering: problem domain analysis, stakeholder identification, ` +
        `technology landscape, competitive analysis, risk factors, regulatory requirements, and implementation constraints. ` +
        `This must be production-grade research, not a summary — include specific data points, vendor comparisons, ` +
        `API specifications, and architectural precedents. Source artifacts: ${artifactCtx}`,
      targetDir: 'research',
    },
  ];
}

/**
 * Build Ruflo tasks for Phase 3: SPARC + TDD.
 * Ruflo writes complete SPARC specs and TDD plans from research.
 */
export function buildPhase3Tasks(
  scenarioQuery: string,
  artifacts: Record<string, string>,
): RufloTask[] {
  const artifactCtx = buildArtifactContext(artifacts);
  return [
    {
      label: 'SPARC Specification',
      description: `Write a complete SPARC specification for: ${scenarioQuery.slice(0, 400)}. ` +
        `Cover all 5 SPARC phases: Specification (functional requirements, edge cases, constraints), ` +
        `Pseudocode (algorithms, data flow, state transitions), Architecture (services, boundaries, protocols), ` +
        `Refinement (optimization, error handling, security hardening), Completion (deployment, monitoring, SLAs). ` +
        `This is a production specification — every service endpoint, data model, and integration point must be defined. ` +
        `Source: ${artifactCtx}`,
      targetDir: 'sparc',
    },
    {
      label: 'London School TDD Plan',
      description: `Write a London School TDD test plan for: ${scenarioQuery.slice(0, 400)}. ` +
        `Define: test pyramid distribution (unit/integration/acceptance/e2e), mock contracts per seam boundary, ` +
        `outside-in test strategy, test fixtures, golden datasets, performance benchmarks, and security test cases. ` +
        `Every bounded context must have test coverage defined. Every external integration must have mock contracts. ` +
        `Source: ${artifactCtx}`,
      targetDir: 'tdd',
    },
  ];
}

/**
 * Build Ruflo tasks for Phase 4: ADRs + DDDs.
 * Ruflo writes complete architecture decisions and domain models.
 */
export function buildPhase4Tasks(
  scenarioQuery: string,
  artifacts: Record<string, string>,
): RufloTask[] {
  const artifactCtx = buildArtifactContext(artifacts);
  return [
    {
      label: 'Architecture Decision Records',
      description: `Write Architecture Decision Records (ADRs) for: ${scenarioQuery.slice(0, 400)}. ` +
        `Each ADR must include: context, decision, consequences, alternatives considered, and SPARC citations. ` +
        `Cover: language/framework selection, database engine, authentication strategy, API design, ` +
        `deployment topology, ERP integration pattern, caching strategy, and error handling policy. ` +
        `These are binding architectural decisions — they directly inform code generation. Source: ${artifactCtx}`,
      targetDir: 'adrs',
    },
    {
      label: 'Domain-Driven Design Model',
      description: `Write a complete DDD domain model for: ${scenarioQuery.slice(0, 400)}. ` +
        `Define: bounded contexts with ubiquitous language, aggregate roots with invariants, entities, ` +
        `value objects, domain events, commands, queries, and a context map with relationship types ` +
        `(shared kernel, customer-supplier, conformist, anticorruption layer). ` +
        `Each bounded context must specify its integration seams, persistence strategy, and API surface. ` +
        `This model drives code generation — it must be complete and unambiguous. Source: ${artifactCtx}`,
      targetDir: 'ddd',
    },
  ];
}

/**
 * Build Ruflo tasks for Phase 5: Production Build.
 * Ruflo writes the complete production-ready application.
 */
export function buildPhase5Tasks(
  scenarioQuery: string,
  language: string,
  artifacts: Record<string, string>,
): RufloTask[] {
  const artifactCtx = buildArtifactContext(artifacts);
  const tasks: RufloTask[] = [];

  // --- Per-context tasks (ADR-004) ---
  // Read bounded contexts from the DDD domain model and generate one Ruflo
  // task per context. Each task references its implementation prompt file
  // so the swarm receives focused instructions with invariants, commands,
  // queries, events, ports, ADR constraints, and TDD test cases.
  const dddPath = artifacts['DDD'] ?? artifacts['ddd'] ?? '';
  const contexts = readBoundedContextNames(dddPath);

  if (contexts.length > 0) {
    // Derive runDir from DDD artifact path (ADR-015)
    const dddDir = dddPath ? path.dirname(dddPath) : '';
    // runDir is typically the grandparent of the DDD file (runDir/phase2/ddd/domain-model.json)
    const inferredRunDir = dddDir ? path.resolve(dddDir, '..', '..') : '';

    for (const ctx of contexts) {
      const ctxSlug = ctx.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      const promptFileName = `${ctxSlug}-implementation.md`;

      // ADR-015: Try to read prompt content and embed it in the task description
      let promptContent = '';
      const promptPaths = [
        inferredRunDir ? path.join(inferredRunDir, 'prompts', promptFileName) : '',
        inferredRunDir ? path.join(inferredRunDir, 'phase3', 'project', 'prompts', promptFileName) : '',
      ].filter(Boolean);

      for (const pp of promptPaths) {
        try {
          if (fs.existsSync(pp)) {
            promptContent = fs.readFileSync(pp, 'utf-8');
            break;
          }
        } catch { /* continue to next path */ }
      }

      // Build task description: embed prompt content if available, otherwise fall back to summary
      const promptSection = promptContent
        ? `\n\n--- IMPLEMENTATION PROMPT ---\n${promptContent.slice(0, 4000)}\n--- END PROMPT ---\n`
        : `Aggregates: ${ctx.aggregates.join(', ')}. ` +
          `Commands: ${ctx.commands.join(', ')}. ` +
          `Queries: ${ctx.queries.join(', ')}. `;

      tasks.push({
        label: `Context: ${ctx.name}`,
        description:
          `Implement bounded context "${ctx.name}" in ${language} for: ${scenarioQuery.slice(0, 200)}. ` +
          `Write REAL business logic — not stubs. ` +
          `${promptSection}` +
          `Source: ${artifactCtx}`,
        targetDir: `src/${ctxSlug}`,
      });
    }
  }

  // --- Cross-cutting tasks (kept as supplementary) ---
  tasks.push(
    {
      label: 'Frontend Application',
      description: `Build a production-ready frontend application for: ${scenarioQuery.slice(0, 300)}. ` +
        `Build a complete dashboard with per-bounded-context pages, data tables for queries, ` +
        `command forms, typed API client, authentication flow, error boundaries, loading states, ` +
        `and responsive layout. Source: ${artifactCtx}`,
      targetDir: 'ui',
    },
    {
      label: 'Infrastructure & Integration',
      description: `Build production infrastructure and integration layer for: ${scenarioQuery.slice(0, 300)}. ` +
        `Include: HTTP middleware (auth, CORS, logging, rate limiting, error handling), ` +
        `ERP client adapters with real API endpoints (not stubs), database connection management, ` +
        `integration modules for detected external systems, health checks, and metrics endpoints. ` +
        `Source: ${artifactCtx}`,
      targetDir: 'src/infra',
    },
    {
      label: 'Database & SQL',
      description: `Generate production SQL schemas for: ${scenarioQuery.slice(0, 300)}. ` +
        `Include: CREATE TABLE per DDD aggregate root, indexes for query patterns, foreign keys, ` +
        `constraint checks, migration scripts (up/down), seed data for development, and ` +
        `database-specific optimizations for the detected engine. Source: ${artifactCtx}`,
      targetDir: 'sql',
    },
    {
      label: 'Test Suite',
      description: `Build a comprehensive test suite for: ${scenarioQuery.slice(0, 300)}. ` +
        `Implement ALL tests from the TDD plan: unit tests per aggregate, integration tests per seam, ` +
        `acceptance tests per bounded context, and e2e tests for critical user flows. ` +
        `Include mock contracts, test fixtures, and golden datasets. Tests must PASS. ` +
        `Source: ${artifactCtx}`,
      targetDir: 'tests',
    },
    {
      label: 'Deployment Configuration',
      description: `Generate production deployment configuration for: ${scenarioQuery.slice(0, 300)}. ` +
        `Include: Dockerfile (multi-stage, optimized), Docker Compose for local dev, ` +
        `cloud deployment configs (Cloud Run / ECS / K8s manifests), CI/CD pipeline, ` +
        `environment variable templates, and IaC (Terraform/YAML) for detected cloud provider. ` +
        `Source: ${artifactCtx}`,
      targetDir: 'deploy',
    },
  );

  // If no per-context tasks were created (no DDD model), add the generic backend task as fallback
  if (contexts.length === 0) {
    tasks.unshift({
      label: 'Backend Implementation',
      description: `Build a complete, production-ready ${language} backend service for: ${scenarioQuery.slice(0, 300)}. ` +
        `Implement ALL command handlers, query handlers, domain logic, aggregate roots, and domain events ` +
        `from the DDD model. Include real business logic — not stubs. Wire all integration points with ` +
        `actual API calls (not mock clients). Include connection pooling, retry logic, circuit breakers, ` +
        `and comprehensive error handling. Source: ${artifactCtx}`,
      targetDir: 'src',
    });
  }

  return tasks;
}

/**
 * Read bounded context names from the DDD domain-model.json.
 * Returns a lightweight summary for task generation — not the full model.
 */
function readBoundedContextNames(dddPath: string): {
  name: string; aggregates: string[]; commands: string[]; queries: string[];
}[] {
  if (!dddPath || !fs.existsSync(dddPath)) return [];
  try {
    const model = JSON.parse(fs.readFileSync(dddPath, 'utf-8'));
    return (model?.contexts ?? []).map((ctx: any) => ({
      name: ctx.name ?? 'unknown',
      aggregates: (ctx.aggregates ?? []).map((a: any) => a.name ?? a.root ?? 'unknown'),
      commands: (ctx.commands ?? []).map((c: any) => c.name ?? 'unknown'),
      queries: (ctx.queries ?? []).map((q: any) => q.name ?? 'unknown'),
    }));
  } catch { return []; }
}

/**
 * Build Ruflo tasks for Phase 6: ERP Surface + Final Assembly.
 * Ruflo writes the ERP integration layer and deployment package.
 */
export function buildPhase6Tasks(
  scenarioQuery: string,
  artifacts: Record<string, string>,
): RufloTask[] {
  const artifactCtx = buildArtifactContext(artifacts);
  return [
    {
      label: 'ERP Integration Layer',
      description: `Build the production ERP integration layer for: ${scenarioQuery.slice(0, 400)}. ` +
        `Generate: ERP surface mapping (service endpoints to ERP operations), authentication configuration ` +
        `(OAuth2/SAML/certificate-based per ERP system), webhook receivers for ERP events, ` +
        `data transformation adapters, and health monitoring for ERP connectivity. ` +
        `Use the connector-hub/erp-surface and connector-hub/auth-identity agent analysis. ` +
        `Source: ${artifactCtx}`,
      targetDir: 'erp',
    },
  ];
}

// ============================================================================
// Main Executor
// ============================================================================

/**
 * Execute a Ruflo agent swarm for any pipeline phase.
 *
 * This is the single entry point for Ruflo delegation across ALL phases.
 * It handles:
 *   1. Ruflo binary resolution and availability check
 *   2. Swarm initialization with anti-drift config
 *   3. Task creation with agentics agent results embedded as context
 *   4. Swarm execution with configurable timeout
 *   5. FALLBACK: When Ruflo produces 0 files, extract code from agentics
 *      agent responses and write them to disk
 *   6. File count tracking and result reporting
 *
 * The agentics agent results are injected INTO each task description,
 * giving Ruflo access to the fleet's domain expertise during generation.
 * When Ruflo can't produce code (no LLM backend), the agents' own code
 * output is extracted and used directly.
 */
export function executeRufloPhaseSwarm(config: RufloPhaseConfig): RufloPhaseResult {
  const startTime = Date.now();
  const maxAgents = config.maxAgents ?? DEFAULT_MAX_AGENTS;
  const timeoutMs = config.timeoutMs ?? DEFAULT_SWARM_TIMEOUT;

  // ── Read actual artifact content for context injection ──
  const artifactContent = readArtifactContent(config.priorArtifacts);

  // ── Check ruflo availability ──
  const check = checkRufloAvailable();
  if (!check.available) {
    console.error(`  [RUFLO-P${config.phase}] ruflo not available: ${check.version}`);
    // Even without ruflo, extract code from agent responses
    const agentCode = extractCodeFromAgentResults(config.agenticsResults);
    let agentFilesWritten = 0;
    if (agentCode.length > 0) {
      console.error(`  [RUFLO-P${config.phase}] Extracting ${agentCode.length} code files from agentics agent responses`);
      fs.mkdirSync(config.outputDir, { recursive: true, mode: 0o700 });
      agentFilesWritten = writeAgentCodeFiles(agentCode, config.outputDir);
      console.error(`  [RUFLO-P${config.phase}] Wrote ${agentFilesWritten} agent code files`);
    }
    return {
      invoked: false, rufloAvailable: false, filesModified: agentFilesWritten,
      tasksCreated: 0, swarmCompleted: false, timing: Date.now() - startTime,
      version: check.version, agentCodeFilesWritten: agentFilesWritten,
    };
  }

  console.error(`  [RUFLO-P${config.phase}] ${check.version} — executing ${config.tasks.length} tasks for: ${config.label}`);

  // ── Ensure output directory exists ──
  fs.mkdirSync(config.outputDir, { recursive: true, mode: 0o700 });

  // ── Count files before ──
  const filesBefore = countFiles(config.outputDir);

  // ── Build cooperation context from agentics agents ──
  const agenticsContext = buildAgenticsCooperationContext(config.agenticsResults);

  // ── Step 1: Initialize swarm ──
  try {
    rufloExec(check.binary, [
      'swarm', 'init',
      '--topology', 'hierarchical',
      '--max-agents', String(maxAgents),
      '--strategy', 'specialized',
    ], config.outputDir);
    console.error(`  [RUFLO-P${config.phase}] Swarm initialized`);
  } catch (err) {
    console.error(`  [RUFLO-P${config.phase}] Swarm init warning: ${err instanceof Error ? err.message : String(err)}`);
  }

  // ── Step 2: Create tasks with agentics context + artifact CONTENT embedded ──
  let tasksCreated = 0;
  for (const task of config.tasks) {
    // Embed agentics agent analysis AND artifact content directly in the task description
    const fullDescription = [
      task.description,
      agenticsContext,
      artifactContent.length > 0 ? `\n--- PRIOR PHASE ARTIFACTS (actual content) ---${artifactContent}\n--- END PRIOR PHASE ARTIFACTS ---` : '',
    ].join('\n');

    try {
      rufloExec(check.binary, [
        'task', 'create',
        '--type', 'implementation',
        '--description', fullDescription,
      ], config.outputDir, CHECK_TIMEOUT);
      tasksCreated++;
    } catch {
      // Task creation failure is non-fatal
    }
  }

  console.error(`  [RUFLO-P${config.phase}] Created ${tasksCreated}/${config.tasks.length} tasks`);

  // ── Step 3: Build implementation prompt and start swarm ──
  const implPrompt = buildImplementationPrompt(config.priorArtifacts, config.scenarioQuery, 'typescript');
  // Persist the implementation prompt so agents and swarm can reference it
  const implPromptPath = path.join(config.runDir, 'implementation-prompt.md');
  try { fs.writeFileSync(implPromptPath, implPrompt, 'utf-8'); } catch { /* non-fatal */ }

  const objective = [
    `Phase ${config.phase} (${config.label}):`,
    implPrompt.slice(0, 3000),
    `Tasks: ${config.tasks.map(t => t.label).join(', ')}.`,
    `Target: ${config.outputDir}.`,
  ].join('\n');

  let swarmCompleted = false;
  try {
    rufloExec(check.binary, [
      'swarm', 'start',
      '--objective', objective,
      '-s', 'development',
    ], config.outputDir, timeoutMs);
    swarmCompleted = true;
    console.error(`  [RUFLO-P${config.phase}] Swarm completed`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`  [RUFLO-P${config.phase}] Swarm execution note: ${msg.slice(0, 200)}`);
  }

  // ── Count files after swarm ──
  const filesAfterSwarm = countFiles(config.outputDir);
  const swarmFilesProduced = Math.max(0, filesAfterSwarm - filesBefore);

  // ── Step 4: FALLBACK — If swarm produced 0 code files, extract from agent responses ──
  let agentCodeFilesWritten = 0;
  if (swarmFilesProduced === 0) {
    const agentCode = extractCodeFromAgentResults(config.agenticsResults);
    if (agentCode.length > 0) {
      console.error(`  [RUFLO-P${config.phase}] Swarm produced 0 files — extracting ${agentCode.length} code files from agentics agents`);
      agentCodeFilesWritten = writeAgentCodeFiles(agentCode, config.outputDir);
      console.error(`  [RUFLO-P${config.phase}] Wrote ${agentCodeFilesWritten} agent code files to ${config.outputDir}`);
    }
  }

  const totalFilesModified = swarmFilesProduced + agentCodeFilesWritten;
  const timing = Date.now() - startTime;

  console.error(`  [RUFLO-P${config.phase}] Result: ${totalFilesModified} files (swarm: ${swarmFilesProduced}, agents: ${agentCodeFilesWritten}), ${tasksCreated} tasks, ${timing}ms`);

  return {
    invoked: true,
    rufloAvailable: true,
    filesModified: totalFilesModified,
    tasksCreated,
    swarmCompleted,
    timing,
    version: check.version,
    agentCodeFilesWritten,
  };
}

// ============================================================================
// Prior Artifact Collectors (per phase)
// ============================================================================

/** Collect artifact paths available for Phase 2 (from Phase 1). */
export function collectPhase2Artifacts(runDir: string): Record<string, string> {
  const artifacts: Record<string, string> = {};
  const candidates: Record<string, string> = {
    'manifest': 'manifest.json',
    'scenario': 'scenario.json',
    'executive-summary': 'executive-summary.md',
    'risk-assessment': 'risk-assessment.json',
    'decision-memo': 'decision-memo.md',
    'results': 'results.json',
    'roadmap': 'roadmap.json',
  };
  for (const [label, file] of Object.entries(candidates)) {
    const p = path.join(runDir, file);
    if (fs.existsSync(p)) artifacts[label] = p;
  }
  return artifacts;
}

/** Collect artifact paths available for Phase 3 (from Phase 1 + 2). */
export function collectPhase3Artifacts(runDir: string): Record<string, string> {
  const artifacts = collectPhase2Artifacts(runDir);
  const phase2Candidates: Record<string, string> = {
    'research-dossier': 'phase2/research-dossier.json',
    'phase2-agents': 'phase2/agentics-agents-report.json',
  };
  for (const [label, file] of Object.entries(phase2Candidates)) {
    const p = path.join(runDir, file);
    if (fs.existsSync(p)) artifacts[label] = p;
  }
  return artifacts;
}

/** Collect artifact paths available for Phase 4 (from Phases 1-3). */
export function collectPhase4Artifacts(runDir: string): Record<string, string> {
  const artifacts = collectPhase3Artifacts(runDir);
  const phase3Candidates: Record<string, string> = {
    'SPARC': 'phase3/sparc/sparc-combined.json',
    'TDD': 'phase3/tdd/tdd-plan.json',
    'phase3-agents': 'phase3/agentics-agents-report.json',
    'sparc-specification': 'engineering/sparc-specification.md',
    'tdd-test-plan': 'engineering/tdd-test-plan.md',
  };
  for (const [label, file] of Object.entries(phase3Candidates)) {
    const p = path.join(runDir, file);
    if (fs.existsSync(p)) artifacts[label] = p;
  }
  // Also check phase2 for SPARC/TDD (they might be generated there)
  if (!artifacts['SPARC']) {
    const alt = path.join(runDir, 'phase2', 'sparc', 'sparc-combined.json');
    if (fs.existsSync(alt)) artifacts['SPARC'] = alt;
  }
  if (!artifacts['TDD']) {
    const alt = path.join(runDir, 'phase2', 'tdd', 'tdd-plan.json');
    if (fs.existsSync(alt)) artifacts['TDD'] = alt;
  }
  return artifacts;
}

/** Collect artifact paths available for Phase 5 (from Phases 1-4). */
export function collectPhase5Artifacts(runDir: string): Record<string, string> {
  const artifacts = collectPhase4Artifacts(runDir);
  const phase4Candidates: Record<string, string> = {
    'ADRs': 'phase4/adrs/adr-index.json',
    'DDD': 'phase4/ddd/domain-model.json',
    'context-map': 'phase4/ddd/context-map.json',
    'phase4-agents': 'phase4/agentics-agents-report.json',
    'architecture-decisions': 'engineering/architecture-decisions.md',
    'domain-model': 'engineering/domain-model.md',
    'implementation-roadmap': 'engineering/implementation-roadmap.md',
  };
  for (const [label, file] of Object.entries(phase4Candidates)) {
    const p = path.join(runDir, file);
    if (fs.existsSync(p)) artifacts[label] = p;
  }
  return artifacts;
}

/** Collect artifact paths available for Phase 6 (from Phases 1-5). */
export function collectPhase6Artifacts(runDir: string): Record<string, string> {
  const artifacts = collectPhase5Artifacts(runDir);
  const phase5Candidates: Record<string, string> = {
    'phase5-manifest': 'phase5/phase5-manifest.json',
    'phase5-agents': 'phase5/agentics-agents-report.json',
  };
  for (const [label, file] of Object.entries(phase5Candidates)) {
    const p = path.join(runDir, file);
    if (fs.existsSync(p)) artifacts[label] = p;
  }
  return artifacts;
}

// ============================================================================
// Phase 1 Agent Code Extraction (from results.json)
// ============================================================================

/**
 * Load code files from Phase 1 results.json.
 * Phase 1 invokes the full 110-agent fleet, and agents like forge/sdk and
 * forge/cli return actual code files in their response payloads. This function
 * extracts those files so they can be written to disk during later phases.
 *
 * Response structure in results.json:
 *   agents[].result.response.artifacts[].content.sdk_artifacts[].files[]
 *   agents[].result.response.artifacts[].content.files[]
 */
export function extractPhase1AgentCode(runDir: string): AgentCodeFile[] {
  const resultsPath = path.join(runDir, 'results.json');
  if (!fs.existsSync(resultsPath)) return [];

  try {
    const raw = fs.readFileSync(resultsPath, 'utf-8');
    const data = JSON.parse(raw) as {
      agents?: Array<{
        domain: string;
        agent: string;
        result?: {
          response?: Record<string, unknown>;
        };
      }>;
    };

    if (!Array.isArray(data.agents)) return [];

    const files: AgentCodeFile[] = [];
    for (const a of data.agents) {
      const resp = a.result?.response;
      if (!resp || typeof resp !== 'object') continue;
      extractFromResponse(resp, a.domain, a.agent, files);
    }
    return files;
  } catch {
    return [];
  }
}

// ============================================================================
// Code Production Check (for auto-chain to skip templates)
// ============================================================================

/**
 * Check if real code files were produced in a directory.
 * "Real" means actual source files with content — not .gitkeep, metadata, etc.
 * Used by auto-chain to decide whether to skip template generators.
 */
export function hasRealCodeFiles(dir: string): boolean {
  if (!fs.existsSync(dir)) return false;
  return countFiles(dir) > 0;
}
