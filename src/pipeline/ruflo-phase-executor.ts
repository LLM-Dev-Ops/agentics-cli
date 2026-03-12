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
import { loadTechStack, formatTechStackForPrompt } from './phase2/phases/tech-stack-detector.js';

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
  /** Implementation wave (1=foundation, 2=core, 3=dependent, 4=cross-cutting). */
  readonly wave?: number;
  /** Labels of tasks this depends on (must complete before this task starts). */
  readonly dependsOn?: string[];
}

/** A single implementation wave containing ordered tasks and a focused prompt. */
export interface ImplementationWave {
  /** Wave number (1=foundation, 2=core, 3=dependent, 4=cross-cutting). */
  readonly wave: number;
  /** Human-readable wave label. */
  readonly label: string;
  /** Bounded context names included in this wave. */
  readonly contexts: string[];
  /** Focused implementation prompt for this wave. */
  readonly prompt: string;
  /** Tasks belonging to this wave. */
  readonly tasks: RufloTask[];
  /** Prior wave numbers that must complete before this wave. */
  readonly dependsOn: number[];
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

/**
 * Naming convention rules embedded in implementation prompts to prevent
 * double-prefix bugs like "IIbudgetManagementPort".
 */
const NAMING_CONVENTION_RULES = [
  'Port interfaces: {ContextName}Port (e.g., BudgetManagementPort) — NO "I" prefix',
  'Adapters: {Implementation}{ContextName}Adapter (e.g., PostgresBudgetManagementAdapter)',
  'Never use double-prefix like "II*" or "IInterface*"',
  'Domain types: PascalCase with no prefix (e.g., BudgetOrder, not IBudgetOrder)',
].join('\n');

// ============================================================================
// Interface Naming Sanitization (ADR-029 Fix 5)
// ============================================================================

/**
 * Sanitize generated interface names to prevent double-prefix bugs.
 *
 * Convention:
 *   Port interfaces: {ContextName}Port (no "I" prefix)
 *   Adapters: {Implementation}{ContextName}Adapter
 *   Never double-prefix (II*, IInterface*)
 */
export function sanitizeInterfaceName(name: string, kind: 'port' | 'adapter' | 'interface'): string {
  // Strip any leading "I" prefix(es) — handles II, III, IInterface, etc.
  let stripped = name;
  while (/^I[A-Z]/.test(stripped)) {
    stripped = stripped.slice(1);
  }

  // Apply convention based on kind
  switch (kind) {
    case 'port':
      // Ensure it ends with "Port" and has no "I" prefix
      if (!stripped.endsWith('Port')) stripped = `${stripped}Port`;
      return stripped;
    case 'adapter':
      // Ensure it ends with "Adapter" and has no "I" prefix
      if (!stripped.endsWith('Adapter')) stripped = `${stripped}Adapter`;
      return stripped;
    case 'interface':
      // Just strip double-prefixes, no convention enforcement
      return stripped;
  }
}

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
    env: {
      ...process.env,
      // Tell ruflo to use Claude Code's logged-in session for LLM work
      // instead of requiring a separate ANTHROPIC_API_KEY
      CLAUDECODE: '1',
      CLAUDE_FLOW_PROVIDER: 'claude-code',
    },
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

// ============================================================================
// Dependency Graph & Wave Ordering (ADR-028 Changes 2 & 4)
// ============================================================================

/**
 * Analyze the DDD context map to determine bounded context dependencies.
 * Returns a map of context name -> list of context names it depends on.
 *
 * Dependency direction: if A is upstream of B (A -> B), then B depends on A.
 * Relationships like "customer-supplier", "conformist", and "anticorruption-layer"
 * mean the downstream context depends on the upstream context.
 * "shared-kernel" means mutual dependency — both go in the same wave.
 */
export function buildContextDependencyGraph(
  contextMap: { from: string; to: string; relationship: string }[],
  contextNames: string[],
): Map<string, string[]> {
  const deps = new Map<string, string[]>();

  // Initialize all contexts with empty dependency lists
  for (const name of contextNames) {
    deps.set(name, []);
  }

  for (const rel of contextMap) {
    const relType = rel.relationship.toLowerCase();

    if (relType.includes('shared-kernel') || relType.includes('shared kernel')) {
      // Shared kernel: mutual dependency — neither depends on the other
      // They will naturally land in the same wave since neither blocks the other
      continue;
    }

    // For all directional relationships, the downstream (to) depends on upstream (from)
    const downstream = rel.to;
    const upstream = rel.from;

    if (deps.has(downstream) && contextNames.includes(upstream)) {
      const existing = deps.get(downstream)!;
      if (!existing.includes(upstream)) {
        existing.push(upstream);
      }
    }
  }

  return deps;
}

/**
 * Topologically sort bounded contexts by dependency order.
 * Contexts with no dependencies come first (foundations), then contexts
 * that depend only on already-sorted contexts, and so on.
 *
 * Returns contexts grouped by depth level (0 = no deps, 1 = depends on level 0, etc.).
 * Handles cycles by placing cyclic contexts at the deepest level encountered.
 */
export function topologicalSort(
  deps: Map<string, string[]>,
): string[][] {
  const levels: string[][] = [];
  const assigned = new Set<string>();
  const contextNames = Array.from(deps.keys());

  // Iteratively find contexts whose dependencies are all assigned
  let maxIterations = contextNames.length + 1;
  while (assigned.size < contextNames.length && maxIterations > 0) {
    maxIterations--;
    const currentLevel: string[] = [];

    for (const name of contextNames) {
      if (assigned.has(name)) continue;

      const contextDeps = deps.get(name) ?? [];
      const allDepsAssigned = contextDeps.every(d => assigned.has(d));

      if (allDepsAssigned) {
        currentLevel.push(name);
      }
    }

    if (currentLevel.length === 0) {
      // Remaining contexts have circular dependencies — assign them all now
      const remaining = contextNames.filter(n => !assigned.has(n));
      if (remaining.length > 0) {
        levels.push(remaining);
        for (const name of remaining) assigned.add(name);
      }
      break;
    }

    levels.push(currentLevel);
    for (const name of currentLevel) assigned.add(name);
  }

  return levels;
}

/**
 * Group topologically sorted contexts into implementation waves.
 *
 * - Wave 1 (Foundation): Database schemas, shared infrastructure, contexts with zero dependencies
 * - Wave 2 (Core): Contexts that depend only on Wave 1 contexts
 * - Wave 3 (Dependent): Contexts that depend on Wave 2 contexts
 * - Wave 4 (Cross-cutting): Frontend, tests, deployment — built AFTER domain code exists
 *
 * If there are more than 3 dependency levels, intermediate levels are merged
 * into Waves 2 and 3 proportionally.
 */
export function groupIntoWaves(
  sortedLevels: string[][],
  _language: string,
  scenarioQuery: string,
  artifacts: Record<string, string>,
): ImplementationWave[] {
  const artifactCtx = buildArtifactContext(artifacts);

  // Map dependency levels to waves 1-3
  const domainWaves: ImplementationWave[] = [];

  if (sortedLevels.length === 0) {
    // No DDD contexts — single foundation wave
    domainWaves.push({
      wave: 1,
      label: 'Foundation',
      contexts: [],
      prompt: '',
      tasks: [],
      dependsOn: [],
    });
  } else if (sortedLevels.length === 1) {
    // All contexts are independent — put them all in Wave 2 (core)
    domainWaves.push({
      wave: 1,
      label: 'Foundation',
      contexts: [],
      prompt: '',
      tasks: [{
        label: 'Database & Shared Infrastructure',
        description: `Generate database schemas, shared types, and infrastructure adapters for: ${scenarioQuery.slice(0, 200)}. ` +
          `Include: CREATE TABLE per aggregate root, connection management, shared value objects, ` +
          `base repository interfaces, and ERP client stubs. Source: ${artifactCtx}`,
        targetDir: 'src/shared',
        wave: 1,
      }],
      dependsOn: [],
    });
    domainWaves.push({
      wave: 2,
      label: 'Core Bounded Contexts',
      contexts: sortedLevels[0] ?? [],
      prompt: '',
      tasks: [],
      dependsOn: [1],
    });
  } else {
    // Multiple dependency levels
    // Level 0 -> Wave 1 (Foundation)
    domainWaves.push({
      wave: 1,
      label: 'Foundation',
      contexts: sortedLevels[0] ?? [],
      prompt: '',
      tasks: [{
        label: 'Database & Shared Infrastructure',
        description: `Generate database schemas, shared types, and infrastructure adapters for: ${scenarioQuery.slice(0, 200)}. ` +
          `Include: CREATE TABLE per aggregate root, connection management, shared value objects, ` +
          `base repository interfaces, and ERP client stubs. Source: ${artifactCtx}`,
        targetDir: 'src/shared',
        wave: 1,
      }],
      dependsOn: [],
    });

    // Level 1 -> Wave 2 (Core)
    domainWaves.push({
      wave: 2,
      label: 'Core Bounded Contexts',
      contexts: sortedLevels[1] ?? [],
      prompt: '',
      tasks: [],
      dependsOn: [1],
    });

    // Levels 2+ -> Wave 3 (Dependent)
    const dependentContexts = sortedLevels.slice(2).flat();
    if (dependentContexts.length > 0) {
      domainWaves.push({
        wave: 3,
        label: 'Dependent Bounded Contexts',
        contexts: dependentContexts,
        prompt: '',
        tasks: [],
        dependsOn: [1, 2],
      });
    }
  }

  // Collect all domain context task labels for cross-cutting dependency tracking
  const allDomainContextNames = sortedLevels.flat();
  const domainTaskLabels = allDomainContextNames.map(name => `Context: ${name}`);
  const testDependsOn = ['Database & Shared Infrastructure', ...domainTaskLabels];

  // Wave 4: Cross-cutting (always last)
  domainWaves.push({
    wave: 4,
    label: 'Cross-Cutting Concerns',
    contexts: [],
    prompt: '',
    tasks: [
      {
        label: 'Frontend Application',
        description: `Build a production-ready frontend application for: ${scenarioQuery.slice(0, 300)}. ` +
          `Build a complete dashboard with per-bounded-context pages, data tables for queries, ` +
          `command forms, typed API client, authentication flow, error boundaries, loading states, ` +
          `and responsive layout. Source: ${artifactCtx}`,
        targetDir: 'ui',
        wave: 4,
        dependsOn: ['Database & Shared Infrastructure'],
      },
      {
        label: 'Infrastructure & Integration',
        description: `Build production infrastructure and integration layer for: ${scenarioQuery.slice(0, 300)}. ` +
          `Include: HTTP middleware (auth, CORS, logging, rate limiting, error handling), ` +
          `ERP client adapters with real API endpoints (not stubs), database connection management, ` +
          `integration modules for detected external systems, health checks, and metrics endpoints. ` +
          `Source: ${artifactCtx}`,
        targetDir: 'src/infra',
        wave: 4,
        dependsOn: ['Database & Shared Infrastructure'],
      },
      {
        label: 'Test Suite',
        description: `Build a comprehensive test suite for: ${scenarioQuery.slice(0, 300)}. ` +
          `IMPORTANT: This task runs AFTER domain code is generated. ` +
          `Import modules from the ACTUAL generated domain code — do NOT guess import paths. ` +
          `Read the generated source files in src/ to discover what modules, classes, and functions exist, ` +
          `then write tests that import and test those REAL exports. ` +
          `Write London School TDD tests: mock collaborator interfaces at aggregate boundaries, ` +
          `test command handlers in isolation, test query handlers with in-memory adapters. ` +
          `Every test must compile and import modules that actually exist. ` +
          `NAMING CONVENTION: Port interfaces are named {ContextName}Port (no "I" prefix). ` +
          `Adapters are {Implementation}{ContextName}Adapter. Never use "II*" double-prefix. ` +
          `Source: ${artifactCtx}`,
        targetDir: 'tests',
        wave: 4,
        dependsOn: testDependsOn,
      },
      {
        label: 'Deployment Configuration',
        description: `Generate production deployment configuration for: ${scenarioQuery.slice(0, 300)}. ` +
          `Include: Dockerfile (multi-stage, optimized), Docker Compose for local dev, ` +
          `cloud deployment configs (Cloud Run / ECS / K8s manifests), CI/CD pipeline, ` +
          `environment variable templates, and IaC (Terraform/YAML) for detected cloud provider. ` +
          `Source: ${artifactCtx}`,
        targetDir: 'deploy',
        wave: 4,
        dependsOn: ['Database & Shared Infrastructure'],
      },
    ],
    dependsOn: [1, 2, 3],
  });

  return domainWaves;
}

/**
 * Build a focused, 20-40 line implementation prompt for a single wave.
 * Each prompt tells the LLM exactly:
 *   - What to implement (specific contexts, specific ADRs)
 *   - Why this order (dependency rationale)
 *   - What's already built (prior wave output)
 *   - Concrete fields and types (from DDD aggregates)
 */
export function buildWavePrompt(
  wave: ImplementationWave,
  ddd: { contexts: { name: string; aggregates: string[]; commands: string[]; queries: string[]; events: string[] }[] },
  adrs: { id: string; title: string; decision: string }[],
  tdd: { suites: { name: string; testCount: number; strategy: string }[]; approach: string },
  language: string,
  priorWaveLabels: string[],
): string {
  const lines: string[] = [];

  lines.push(`# Wave ${wave.wave}: ${wave.label}`);
  lines.push('');

  // Why this order
  if (wave.dependsOn.length > 0) {
    lines.push(`## Prerequisites`);
    lines.push(`This wave depends on: ${priorWaveLabels.join(', ')}. Those modules are already built and available for import.`);
    lines.push('');
  } else {
    lines.push(`## Foundation Wave`);
    lines.push(`This wave has no dependencies. Build foundational types, schemas, and shared infrastructure first.`);
    lines.push('');
  }

  // What to implement — only the contexts in THIS wave
  if (wave.contexts.length > 0) {
    lines.push(`## Bounded Contexts to Implement`);
    lines.push('');
    for (const ctxName of wave.contexts) {
      const ctxData = ddd.contexts.find(c => c.name === ctxName);
      if (ctxData) {
        lines.push(`### ${ctxData.name}`);
        if (ctxData.aggregates.length > 0) lines.push(`- Aggregates: ${ctxData.aggregates.join(', ')}`);
        if (ctxData.commands.length > 0) lines.push(`- Commands: ${ctxData.commands.join(', ')}`);
        if (ctxData.queries.length > 0) lines.push(`- Queries: ${ctxData.queries.join(', ')}`);
        if (ctxData.events.length > 0) lines.push(`- Domain Events: ${ctxData.events.join(', ')}`);
        lines.push('');
      }
    }
  }

  // Relevant ADRs only — filter to ones mentioning this wave's contexts
  const relevantAdrs = wave.contexts.length > 0
    ? adrs.filter(a => {
        const text = `${a.title} ${a.decision}`.toLowerCase();
        return wave.contexts.some(c => text.includes(c.toLowerCase())) || text.includes('all') || text.includes('general');
      })
    : adrs;

  if (relevantAdrs.length > 0) {
    lines.push(`## Applicable ADRs`);
    for (const adr of relevantAdrs.slice(0, 8)) {
      lines.push(`- **${adr.id}**: ${adr.title}${adr.decision ? ' -- ' + adr.decision.slice(0, 120) : ''}`);
    }
    lines.push('');
  }

  // Relevant test suites only
  const relevantSuites = wave.contexts.length > 0
    ? tdd.suites.filter(s => {
        const suiteName = s.name.toLowerCase();
        return wave.contexts.some(c => suiteName.includes(c.toLowerCase()));
      })
    : tdd.suites;

  if (relevantSuites.length > 0) {
    lines.push(`## Test Suites for This Wave`);
    for (const suite of relevantSuites) {
      lines.push(`- ${suite.name}: ${suite.testCount} tests (${suite.strategy})`);
    }
    lines.push('');
  }

  // Implementation mandate
  lines.push(`## Rules`);
  lines.push(`- Language: ${language}`);
  lines.push(`- Write REAL business logic with concrete types -- no Record<string, unknown>, no TODO stubs`);
  lines.push(`- London School TDD: test first, mock collaborators at seam boundaries`);
  lines.push(`- Ports/adapters: domain logic has ZERO infrastructure imports`);
  lines.push('');
  lines.push(`## Naming Convention`);
  lines.push(NAMING_CONVENTION_RULES);
  lines.push('');

  return lines.join('\n');
}

/**
 * ADR-029: Try to load tech-stack.json from a run directory inferred from
 * artifact paths, and return formatted prompt context if found.
 */
function loadTechStackContext(artifacts: Record<string, string>): string {
  // Infer run directory from any artifact path (go up from phase2/adrs/)
  const anyPath = Object.values(artifacts).find(p => p && fs.existsSync(p));
  if (!anyPath) return '';

  // Try several candidate directories
  const candidates = [
    path.resolve(path.dirname(anyPath), '..'),        // parent of artifact
    path.resolve(path.dirname(anyPath), '..', '..'),   // grandparent
    path.resolve(path.dirname(anyPath)),                // same dir
  ];

  for (const dir of candidates) {
    const ts = loadTechStack(dir);
    if (ts) {
      return '\n' + formatTechStackForPrompt(ts) + '\n';
    }
  }
  return '';
}

/**
 * Build iterative, dependency-ordered implementation prompts.
 *
 * Instead of one monolithic prompt dumping ALL contexts, ADRs, and TDD suites,
 * this function produces a sequence of focused wave prompts. Each wave prompt
 * references only the contexts, ADRs, and tests relevant to that wave, and
 * explicitly states what prior waves have already built.
 *
 * Exported for direct use by Phase 5 wave-ordered execution.
 */
export function buildIterativeImplementationPrompts(
  artifacts: Record<string, string>,
  scenarioQuery: string,
  language: string,
): ImplementationWave[] {
  const dddPath = artifacts['DDD'] ?? artifacts['ddd'] ?? '';
  const adrPath = artifacts['ADRs'] ?? artifacts['adrs'] ?? artifacts['adr-index'] ?? '';
  const tddPath = artifacts['TDD'] ?? artifacts['tdd'] ?? '';

  const ddd = extractDDDSummary(dddPath);
  const adrs = extractADRSummary(adrPath);
  const tdd = extractTDDSummary(tddPath);

  // If no DDD model, return a single wave with the full prompt (backward compat)
  if (ddd.contexts.length === 0) {
    const fallbackPrompt = buildLegacyImplementationPrompt(artifacts, scenarioQuery, language);
    return [{
      wave: 1,
      label: 'Full Implementation (no DDD model)',
      contexts: [],
      prompt: fallbackPrompt,
      tasks: [],
      dependsOn: [],
    }];
  }

  // Build dependency graph from context map
  const contextNames = ddd.contexts.map(c => c.name);
  const depGraph = buildContextDependencyGraph(ddd.contextMap, contextNames);

  // Topological sort
  const sortedLevels = topologicalSort(depGraph);

  // Group into waves
  const waves = groupIntoWaves(sortedLevels, language, scenarioQuery, artifacts);

  // Generate focused prompts per wave
  const priorLabels: string[] = [];
  const promptedWaves: ImplementationWave[] = [];

  for (const wave of waves) {
    const prompt = buildWavePrompt(wave, ddd, adrs, tdd, language, [...priorLabels]);

    // Build per-context tasks for this wave's bounded contexts
    const dddPath2 = artifacts['DDD'] ?? artifacts['ddd'] ?? '';
    const contexts = readBoundedContextNames(dddPath2);
    const artifactCtx = buildArtifactContext(artifacts);
    const inferredRunDir = dddPath2 ? path.resolve(path.dirname(dddPath2), '..', '..') : '';

    const contextTasks: RufloTask[] = [];
    for (const ctxName of wave.contexts) {
      const ctx = contexts.find(c => c.name === ctxName);
      if (!ctx) continue;

      const ctxSlug = ctx.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      const promptFileName = `${ctxSlug}-implementation.md`;

      // Try to read per-context prompt file
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
        } catch { /* continue */ }
      }

      const promptSection = promptContent
        ? `\n\n--- IMPLEMENTATION PROMPT ---\n${promptContent.slice(0, 4000)}\n--- END PROMPT ---\n`
        : `Aggregates: ${ctx.aggregates.join(', ')}. Commands: ${ctx.commands.join(', ')}. Queries: ${ctx.queries.join(', ')}. `;

      // Determine which prior context labels this task depends on
      const depGraph2 = buildContextDependencyGraph(
        extractDDDSummary(dddPath2).contextMap,
        contexts.map(c => c.name),
      );
      const ctxDeps = depGraph2.get(ctx.name) ?? [];
      const taskDependsOn = ctxDeps.map(d => `Context: ${d}`);
      if (wave.wave > 1) {
        taskDependsOn.push('Database & Shared Infrastructure');
      }

      contextTasks.push({
        label: `Context: ${ctx.name}`,
        description:
          `Implement bounded context "${ctx.name}" in ${language} for: ${scenarioQuery.slice(0, 200)}. ` +
          `Write REAL business logic -- not stubs. ` +
          `${promptSection}` +
          `Source: ${artifactCtx}`,
        targetDir: `src/${ctxSlug}`,
        wave: wave.wave,
        dependsOn: taskDependsOn.length > 0 ? taskDependsOn : undefined,
      });
    }

    // Merge context tasks with any pre-existing wave tasks (e.g., infrastructure, cross-cutting)
    const allTasks = [...wave.tasks, ...contextTasks];

    promptedWaves.push({
      ...wave,
      prompt,
      tasks: allTasks,
    });

    priorLabels.push(`Wave ${wave.wave} (${wave.label})`);
  }

  return promptedWaves;
}

/**
 * Legacy implementation prompt builder — used as fallback when no DDD model exists.
 * This preserves the original monolithic prompt for backward compatibility.
 */
function buildLegacyImplementationPrompt(
  artifacts: Record<string, string>,
  scenarioQuery: string,
  language: string,
): string {
  const adrPath = artifacts['ADRs'] ?? artifacts['adrs'] ?? artifacts['adr-index'] ?? '';
  const tddPath = artifacts['TDD'] ?? artifacts['tdd'] ?? '';
  const sparcPath = artifacts['SPARC'] ?? artifacts['sparc'] ?? artifacts['sparc-combined'] ?? '';

  // DDD summary intentionally omitted in legacy fallback (no DDD model available)
  const adrs = extractADRSummary(adrPath);
  const tdd = extractTDDSummary(tddPath);
  const sparc = extractSPARCSummary(sparcPath);

  const lines: string[] = [];

  lines.push(`# Implementation Directive`);
  lines.push('');
  lines.push(`Implement the following system in ${language} using London School TDD (outside-in, mock collaborators at seam boundaries).`);
  lines.push('');

  lines.push(`## Scenario`);
  lines.push(scenarioQuery.slice(0, 600));
  lines.push('');

  if (adrs.length > 0) {
    lines.push(`## Architectural Decisions (${adrs.length} ADRs)`);
    lines.push('');
    for (const adr of adrs) {
      lines.push(`- **${adr.id}**: ${adr.title}${adr.decision ? ' -- ' + adr.decision : ''}`);
    }
    lines.push('');
  }

  if (tdd.suites.length > 0) {
    lines.push(`## Test Suites (${tdd.suites.length})`);
    for (const suite of tdd.suites) {
      lines.push(`- ${suite.name}: ${suite.testCount} tests (${suite.strategy})`);
    }
    lines.push('');
  }

  if (sparc.services.length > 0 || sparc.integrations.length > 0) {
    lines.push(`## Architecture Guidance`);
    if (sparc.services.length > 0) lines.push(`- Services: ${sparc.services.join(', ')}`);
    if (sparc.integrations.length > 0) lines.push(`- Integrations: ${sparc.integrations.join(', ')}`);
    lines.push('');
  }

  lines.push(`## Rules`);
  lines.push(`- Write REAL business logic -- no stubs, no TODOs`);
  lines.push(`- Ports/adapters: domain has ZERO infrastructure imports`);
  lines.push(`- London School TDD: test first, mock at seams`);
  lines.push('');
  lines.push(`## Naming Convention`);
  lines.push(NAMING_CONVENTION_RULES);
  lines.push('');

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
 * Build a structured implementation prompt from pipeline artifacts.
 *
 * This prompt is fed to Ruflo swarms AND the 110 agentics.dev agent fleet.
 * It directs them to implement the ADRs + DDDs with high-level SPARC guidance
 * using London School TDD (outside-in, mock collaborators at seam boundaries).
 *
 * The prompt is written to disk as `implementation-prompt.md` and used as the
 * swarm objective across all phases.
 *
 * ADR-028: Now internally uses iterative wave-ordered prompts. The output is
 * a single string with clear wave boundaries for backward compatibility.
 */
export function buildImplementationPrompt(
  artifacts: Record<string, string>,
  scenarioQuery: string,
  language: string,
): string {
  // ADR-028: Use iterative wave-ordered prompts instead of monolithic dump
  const waves = buildIterativeImplementationPrompts(artifacts, scenarioQuery, language);

  // Join wave prompts into a single document with clear wave boundaries
  const sections: string[] = [];

  sections.push(`# Implementation Directive`);
  sections.push('');
  sections.push(`Implement the following system in ${language} using London School TDD (outside-in, mock collaborators at seam boundaries).`);
  sections.push(`Implementation is organized into ${waves.length} sequential waves based on dependency order.`);
  sections.push('');

  sections.push(`## Scenario`);
  sections.push(scenarioQuery.slice(0, 600));
  sections.push('');

  // ADR-029: Embed detected tech stack so all waves use the correct ERP API
  const techCtx = loadTechStackContext(artifacts);
  if (techCtx) {
    sections.push(techCtx);
    sections.push('');
  }

  // Emit each wave as a clearly delimited section
  for (const wave of waves) {
    sections.push(`${'='.repeat(72)}`);
    sections.push(wave.prompt);
    if (wave.tasks.length > 0) {
      sections.push(`### Tasks in this wave`);
      for (const task of wave.tasks) {
        const deps = task.dependsOn && task.dependsOn.length > 0
          ? ` (depends on: ${task.dependsOn.join(', ')})`
          : '';
        sections.push(`- ${task.label} -> ${task.targetDir}${deps}`);
      }
      sections.push('');
    }
  }

  // Artifact file paths for reference
  const pathLines: string[] = [];
  for (const [label, filePath] of Object.entries(artifacts)) {
    if (fs.existsSync(filePath)) pathLines.push(`- ${label}: ${filePath}`);
  }
  if (pathLines.length > 0) {
    sections.push(`## Artifact Paths`);
    sections.push('');
    sections.push(...pathLines);
    sections.push('');
  }

  return sections.join('\n');
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
  // Read actual artifact content to embed in the prompt
  const artifactContent = readArtifactContent(artifacts);

  return [
    {
      label: 'Deep Research',
      description: `# Deep Research — Complete the following research based on the initial simulation artifacts below.

## Objective
${scenarioQuery}

## Instructions
You are 110 Agentics.dev agents + a Ruflo coding swarm. Your job is to complete deep research on this project.

Write a comprehensive research dossier in **markdown** covering:

1. **Problem Domain Analysis** — What exactly is the business problem? What domain concepts exist? What are the key entities, processes, and workflows?
2. **Stakeholder Analysis** — Who are the users, operators, administrators? What are their goals and pain points?
3. **Technology Landscape** — What technologies, APIs, protocols, and standards are relevant? What are the integration points?
4. **Competitive & Industry Analysis** — What similar solutions exist? What design patterns do they use? What are industry best practices?
5. **Risk Factors** — What can go wrong? Technology risks, compliance risks, operational risks, vendor lock-in risks.
6. **Regulatory & Compliance Requirements** — What laws, standards, or frameworks apply? (SOX, GDPR, HIPAA, revenue recognition, etc.)
7. **Implementation Constraints** — What must the solution integrate with? What are the performance, security, and scalability requirements?
8. **Data Architecture** — What data sources exist? What schemas, formats, and volumes are expected?
9. **Cross-References** — How do risks relate to constraints? How do requirements depend on each other?

**Output format:** Write everything as structured markdown (.md files). NOT JSON.

## Initial Artifacts (from Phase 1 simulation)
${artifactContent}
`,
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
  // Read actual artifact content to embed in the prompt
  const artifactContent = readArtifactContent(artifacts);

  return [
    {
      label: 'SPARC Specification',
      description: `# SPARC — Complete the full SPARC methodology for this project.

## Objective
${scenarioQuery}

## Instructions
You are 110 Agentics.dev agents + a Ruflo coding swarm. Your job is to complete all 5 SPARC phases.

Write each phase as a detailed **markdown** document. Each phase must be thorough, production-grade, and directly actionable.

### Phase 1: Specification
Write a complete specification document covering:
- **Functional Requirements** — Every feature, capability, and user story. Be specific. Include acceptance criteria.
- **Non-Functional Requirements** — Performance targets (p95 latency, throughput), scalability, availability (SLA), security posture.
- **Stakeholders & Actors** — Who uses the system? What are their roles and permissions?
- **Edge Cases** — What happens when things go wrong? Invalid input, network failures, data inconsistencies, race conditions.
- **Constraints** — Integration constraints, regulatory constraints, technology constraints, budget constraints.
- **Success Criteria** — How do we know this project succeeded? Measurable KPIs.

### Phase 2: Pseudocode
Write pseudocode for every core algorithm and workflow:
- **Data Flow** — How data moves through the system end-to-end. Every transform, validation, and enrichment step.
- **State Machines** — State transitions for key domain objects (orders, promotions, contracts, etc.).
- **Algorithms** — Core business logic pseudocode. Not generic — specific to THIS domain.
- **Error Handling** — How each failure mode is detected, logged, retried, or escalated.
- **TDD Anchors** — Each pseudocode module has a corresponding test anchor.

### Phase 3: Architecture
Design the complete system architecture:
- **Services** — Every bounded context becomes a service. Name them with proper domain terms (NOT sentence fragments).
- **APIs** — Every endpoint: method, path, request/response types, authentication, rate limits.
- **Data Models** — Every entity, aggregate, value object with typed fields. No \`[key: string]: unknown\`.
- **Integration Points** — How external systems (ERP, databases, cloud services) connect. Adapter patterns, circuit breakers.
- **Security Boundaries** — Authentication, authorization, data encryption, API keys, mTLS.
- **Infrastructure** — Database engines, message queues, caching layers, deployment topology.

### Phase 4: Refinement
Iterate and harden the architecture:
- **Security Hardening** — OWASP top 10 mitigations, input validation, SQL injection prevention, XSS prevention.
- **Performance Optimization** — Connection pooling, query optimization, caching strategy, CDN.
- **Error Handling** — Domain-specific exceptions, error codes, retry policies, dead letter queues.
- **Observability** — Structured logging, distributed tracing, metrics, health checks, alerting.
- **Test Strategy** — London School TDD, test pyramid (unit 70% / integration 20% / e2e 10%), mock contracts per seam.

### Phase 5: Completion
Finalize for production deployment:
- **Integration Plan** — How bounded contexts wire together. Event-driven messaging. API contracts.
- **Testing Checklist** — All test types that must pass before deployment.
- **Deployment Plan** — CI/CD pipeline, infrastructure-as-code, environment management, rollback procedures.
- **Monitoring & SLAs** — Health checks, SLO definitions, alerting rules, dashboards.
- **Documentation** — API docs, ADRs, domain model docs, runbook.

**Output format:** Write everything as structured markdown (.md files). NOT JSON.
**Quality mandate:** The implementation must be production ready, enterprise grade, commercially viable, bug and error free, without compilation errors.

## Prior Artifacts (from Phase 1 simulation + Phase 2 research)
${artifactContent}
`,
      targetDir: 'sparc',
    },
    {
      label: 'London School TDD Plan',
      description: `# London School TDD Plan

## Objective
${scenarioQuery}

## Instructions
Write a complete London School TDD test plan for this project.

1. **Test Pyramid** — Define the distribution: unit (70%), integration (20%), acceptance (5%), e2e (5%).
2. **Outside-In Strategy** — Start from acceptance tests, derive integration tests, derive unit tests.
3. **Mock Contracts** — Every service boundary and external integration gets a mock contract.
4. **Seam Definitions** — Every point where a test double can be injected.
5. **Test Fixtures** — Sample data for each bounded context. Golden datasets for regression.
6. **Performance Tests** — Benchmarks for critical paths with target latencies.
7. **Security Tests** — Authentication, authorization, input validation, injection prevention.

**Output format:** Write as structured markdown (.md files).

## Prior Artifacts
${artifactContent}
`,
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
 *
 * ADR-028 Change 4: Instead of creating all tasks in a flat list dispatched
 * simultaneously, tasks are now organized into dependency-ordered waves.
 * Each task carries a `wave` property and `dependsOn` references so the
 * executor can run them sequentially (wave 1 first, then 2, etc.).
 *
 * Wave structure:
 *   Wave 1 (Foundation): Database schemas, shared infra, contexts with no deps
 *   Wave 2 (Core): Independent bounded contexts
 *   Wave 3 (Dependent): Contexts that reference Wave 2 contexts
 *   Wave 4 (Cross-cutting): Frontend, tests, deployment -- AFTER domain code
 */
export function buildPhase5Tasks(
  scenarioQuery: string,
  language: string,
  artifacts: Record<string, string>,
): RufloTask[] {
  const dddPath = artifacts['DDD'] ?? artifacts['ddd'] ?? '';
  const contexts = readBoundedContextNames(dddPath);

  // If no DDD model, fall back to the legacy flat list (single wave)
  if (contexts.length === 0) {
    return buildPhase5TasksLegacy(scenarioQuery, language, artifacts);
  }

  // ADR-028: Use iterative wave-ordered prompts for task generation
  const waves = buildIterativeImplementationPrompts(artifacts, scenarioQuery, language);

  // Flatten waves into a single task list, preserving wave and dependency metadata
  const tasks: RufloTask[] = [];
  for (const wave of waves) {
    for (const task of wave.tasks) {
      tasks.push(task);
    }
  }

  return tasks;
}

/**
 * Legacy Phase 5 task builder -- used when no DDD domain model exists.
 * Produces the original flat task list for backward compatibility.
 */
function buildPhase5TasksLegacy(
  scenarioQuery: string,
  language: string,
  artifacts: Record<string, string>,
): RufloTask[] {
  const artifactCtx = buildArtifactContext(artifacts);

  return [
    {
      label: 'Backend Implementation',
      description: `Build a complete, production-ready ${language} backend service for: ${scenarioQuery.slice(0, 300)}. ` +
        `Implement ALL command handlers, query handlers, domain logic, aggregate roots, and domain events ` +
        `from the DDD model. Include real business logic -- not stubs. Wire all integration points with ` +
        `actual API calls (not mock clients). Include connection pooling, retry logic, circuit breakers, ` +
        `and comprehensive error handling. Source: ${artifactCtx}`,
      targetDir: 'src',
      wave: 1,
    },
    {
      label: 'Frontend Application',
      description: `Build a production-ready frontend application for: ${scenarioQuery.slice(0, 300)}. ` +
        `Build a complete dashboard with data tables for queries, ` +
        `command forms, typed API client, authentication flow, error boundaries, loading states, ` +
        `and responsive layout. Source: ${artifactCtx}`,
      targetDir: 'ui',
      wave: 2,
      dependsOn: ['Backend Implementation'],
    },
    {
      label: 'Infrastructure & Integration',
      description: `Build production infrastructure and integration layer for: ${scenarioQuery.slice(0, 300)}. ` +
        `Include: HTTP middleware (auth, CORS, logging, rate limiting, error handling), ` +
        `ERP client adapters with real API endpoints (not stubs), database connection management, ` +
        `integration modules for detected external systems, health checks, and metrics endpoints. ` +
        `Source: ${artifactCtx}`,
      targetDir: 'src/infra',
      wave: 2,
      dependsOn: ['Backend Implementation'],
    },
    {
      label: 'Database & SQL',
      description: `Generate production SQL schemas for: ${scenarioQuery.slice(0, 300)}. ` +
        `Include: CREATE TABLE per DDD aggregate root, indexes for query patterns, foreign keys, ` +
        `constraint checks, migration scripts (up/down), seed data for development, and ` +
        `database-specific optimizations for the detected engine. Source: ${artifactCtx}`,
      targetDir: 'sql',
      wave: 1,
    },
    {
      label: 'Test Suite',
      description: `Build a comprehensive test suite for: ${scenarioQuery.slice(0, 300)}. ` +
        `IMPORTANT: This task runs AFTER domain code is generated. ` +
        `Import modules from the ACTUAL generated domain code — do NOT guess import paths. ` +
        `Read the generated source files in src/ to discover what modules, classes, and functions exist, ` +
        `then write tests that import and test those REAL exports. ` +
        `Write London School TDD tests: mock collaborator interfaces at aggregate boundaries, ` +
        `test command handlers in isolation, test query handlers with in-memory adapters. ` +
        `Every test must compile and import modules that actually exist. ` +
        `NAMING CONVENTION: Port interfaces are named {ContextName}Port (no "I" prefix). ` +
        `Adapters are {Implementation}{ContextName}Adapter. Never use "II*" double-prefix. ` +
        `Source: ${artifactCtx}`,
      targetDir: 'tests',
      wave: 4,
      dependsOn: ['Backend Implementation', 'Database & SQL'],
    },
    {
      label: 'Deployment Configuration',
      description: `Generate production deployment configuration for: ${scenarioQuery.slice(0, 300)}. ` +
        `Include: Dockerfile (multi-stage, optimized), Docker Compose for local dev, ` +
        `cloud deployment configs (Cloud Run / ECS / K8s manifests), CI/CD pipeline, ` +
        `environment variable templates, and IaC (Terraform/YAML) for detected cloud provider. ` +
        `Source: ${artifactCtx}`,
      targetDir: 'deploy',
      wave: 2,
      dependsOn: ['Backend Implementation'],
    },
  ];
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
    'sparc-specification-md': 'phase3/sparc/specification.md',
    'sparc-architecture-md': 'phase3/sparc/architecture.md',
    'sparc-pseudocode-md': 'phase3/sparc/pseudocode.md',
    'sparc-refinement-md': 'phase3/sparc/refinement.md',
    'sparc-completion-md': 'phase3/sparc/completion.md',
    'tdd-test-plan': 'engineering/tdd-test-plan.md',
    'tdd-plan-md': 'phase3/tdd/tdd-plan.md',
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
