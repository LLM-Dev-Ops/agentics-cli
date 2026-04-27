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
import { fileURLToPath } from 'node:url';

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
  /**
   * Extra CLI arguments appended when the task is dispatched to the Ruflo
   * binary. ADR-PIPELINE-091 requires every engineering task to carry
   * `--local-only` so the local swarm does not re-call the same remote
   * backends it is supposed to be independent of. Task builders populate
   * this field; the executor forwards it as argv to `ruflo task create`.
   */
  readonly argv?: readonly string[];
}

/**
 * Minimal Phase 1 dossier shape accepted by `runPrimaryPhaseExecution`.
 *
 * This is an anti-corruption layer around the real Phase 1 output — the
 * canonical `ResearchDossier` in `phase2/types.ts` is richer but
 * consumer-unfriendly for the new primary-executor entry point. The primary
 * executor only needs the user's scenario query + pointers to on-disk
 * artifacts so it can build Ruflo tasks with embedded context; anything
 * else flows through as `extras`.
 */
export interface Phase1Dossier {
  /** The user's original natural-language query. */
  readonly scenarioQuery: string;
  /** Trace id for the current pipeline run. */
  readonly traceId: string;
  /** Absolute path to the run directory (~/.agentics/runs/<traceId>). */
  readonly runDir: string;
  /** Optional artifact-label → absolute path map (same shape the existing task builders consume). */
  readonly artifacts?: Record<string, string>;
  /** Optional free-form extras (enrichment agent output, remote diligence findings). */
  readonly extras?: Record<string, unknown>;
}

/**
 * Execution context passed by auto-chain / the ADR-093 dependency gate when
 * invoking the Ruflo primary executor. Keeps the invocation side-effect-free
 * wrt. cwd — callers supply explicit output locations.
 */
export interface RufloExecutionContext {
  /** Absolute path the Ruflo swarm should write under (typically runDir/.ruflo-cache/<phase>). */
  readonly outputDir: string;
  /** Detected target language (used by the Phase 5 coverage / impl builders). Default: typescript. */
  readonly language?: string;
  /** Any upstream agentics-dev diligence results that should be woven into the task descriptions. */
  readonly agenticsResults?: AgenticsServiceResult[];
  /** Max agents in the local swarm (defaults to DEFAULT_MAX_AGENTS). */
  readonly maxAgents?: number;
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
const DEFAULT_SWARM_TIMEOUT = 900_000; // 15 min — SPARC generation takes ~10 min via ruflo
const DEFAULT_MAX_AGENTS = 8;
const MAX_ARTIFACT_CONTENT_BYTES = 32_000;

/**
 * Per-phase wall-clock budget for `runPrimaryPhaseExecution` (ADR-PIPELINE-091 §6).
 * Read once at module scope; overridable via `AGENTICS_RUFLO_PHASE_TIMEOUT` env var.
 * Default 600000 ms (10 min) matches the ADR.
 */
const DEFAULT_PHASE_TIMEOUT: number = (() => {
  const raw = process.env['AGENTICS_RUFLO_PHASE_TIMEOUT'];
  if (!raw) return 600_000;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 600_000;
})();

/** True when the operator has explicitly disabled the Ruflo primary executor. */
function isRufloDisabledByEnv(): boolean {
  const raw = process.env['AGENTICS_DISABLE_RUFLO'];
  if (!raw) return false;
  return /^(1|true|yes|on)$/i.test(raw.trim());
}

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
  // Only use positive cache (found binary). Negative cache (null) prevents retry.
  if (_cachedBinary) return _cachedBinary;

  // Priority 0: Explicit env var override
  const envBin = process.env['RUFLO_BIN'];
  if (envBin && fs.existsSync(envBin)) { _cachedBinary = envBin; return _cachedBinary; }

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

  // Priority 3: NVM current bin (common in Codespaces)
  const nvmBin = path.join(process.env['HOME'] ?? '/root', 'nvm', 'current', 'bin', 'ruflo');
  if (fs.existsSync(nvmBin)) { _cachedBinary = nvmBin; return _cachedBinary; }

  // Priority 4: Global binary via PATH
  try {
    const global = execSync('which ruflo', { stdio: 'pipe', encoding: 'utf-8', timeout: CHECK_TIMEOUT }).trim();
    if (global && fs.existsSync(global)) { _cachedBinary = global; return _cachedBinary; }
  } catch { /* not found globally */ }

  // Don't cache null — allow retry on next call
  return null;
  return null;
}

/**
 * Check ruflo is installed and has swarm support.
 *
 * Adds an optional `reason` field when Ruflo is unavailable so callers
 * (notably `runPrimaryPhaseExecution`) can distinguish operator-disabled
 * from binary-missing from swarm-unsupported. Per ADR-PIPELINE-091 §6,
 * `AGENTICS_DISABLE_RUFLO=true` short-circuits this check before any binary
 * resolution so CI environments never attempt Ruflo at all.
 */
/**
 * ADR-094 optimization — cache the result so repeated calls within the same
 * process (e.g. multiple gate invocations during a fanout) don't re-probe
 * the binary. The probe involves two `execSync` calls (`--version` and
 * `swarm --help`) which together are ~hundreds of ms; caching collapses N
 * gate calls' Ruflo overhead to a single probe per process.
 *
 * Tests can call `_resetCheckRufloAvailableCache()` to force a re-probe.
 */
let _checkRufloAvailableCache: ReturnType<typeof checkRufloAvailableUncached> | null = null;

export function checkRufloAvailable(): {
  available: boolean;
  version: string;
  binary: string;
  reason?: 'disabled-by-env' | 'binary-not-found' | 'version-probe-failed' | 'swarm-unsupported';
} {
  if (_checkRufloAvailableCache) return _checkRufloAvailableCache;
  _checkRufloAvailableCache = checkRufloAvailableUncached();
  return _checkRufloAvailableCache;
}

/** Test-only: clear the availability cache so the next call re-probes. */
export function _resetCheckRufloAvailableCache(): void {
  _checkRufloAvailableCache = null;
}

function checkRufloAvailableUncached(): {
  available: boolean;
  version: string;
  binary: string;
  reason?: 'disabled-by-env' | 'binary-not-found' | 'version-probe-failed' | 'swarm-unsupported';
} {
  if (isRufloDisabledByEnv()) {
    return { available: false, version: 'N/A', binary: '', reason: 'disabled-by-env' };
  }

  const binary = resolveRufloBinary();
  if (!binary) return { available: false, version: 'N/A', binary: '', reason: 'binary-not-found' };

  try {
    const output = execSync(`${binary} --version`, {
      encoding: 'utf-8', timeout: CHECK_TIMEOUT, stdio: 'pipe',
    });
    const version = output.trim() || 'unknown';

    // Verify swarm subcommand
    try {
      execSync(`${binary} swarm --help`, { encoding: 'utf-8', timeout: CHECK_TIMEOUT, stdio: 'pipe' });
    } catch {
      return { available: false, version: `${version} (swarm not supported)`, binary, reason: 'swarm-unsupported' };
    }

    return { available: true, version, binary };
  } catch {
    return { available: false, version: 'N/A', binary, reason: 'version-probe-failed' };
  }
}

// ============================================================================
// Helpers
// ============================================================================

function rufloExec(binary: string, args: string[], cwd: string, timeout = CHECK_TIMEOUT): string {
  // stdio: 'pipe' (the original setting). The 2.7.25 attempt to inherit
  // stderr for live progress was reverted in 2.7.26 because it caused some
  // ruflo binaries to detect a parent TTY and behave interactively (waiting
  // for input that never came), producing 3+ minute silent hangs at startup.
  // Live progress is now provided per-row at the coordinator layer instead
  // (Phase 7), and via Ruflo's own captured stdout being logged after each
  // call returns. Tradeoff: long ruflo invocations (up to 10 min) appear
  // silent between bracket markers, but the bracketing is reliable.
  const result = spawnSync(binary, args, {
    cwd,
    timeout,
    encoding: 'utf-8',
    stdio: 'pipe',
    env: {
      ...process.env,
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

/**
 * Read key planning artifacts (ADRs, DDD model, SPARC spec) and return them
 * as inline content so coding agents have the full project context — not just
 * file paths or truncated summaries.
 */
function buildInlineProjectContext(artifacts: Record<string, string>, scenarioQuery: string): string {
  const sections: string[] = [];

  // Full scenario query — never truncated
  sections.push('## Project Requirements (End-User Prompt)\n');
  sections.push(scenarioQuery);
  sections.push('');

  // Read ADR content (prefer markdown files over JSON index)
  const adrIndexPath = artifacts['ADRs'] ?? artifacts['adrs'] ?? '';
  if (adrIndexPath && fs.existsSync(adrIndexPath)) {
    const adrDir = path.dirname(adrIndexPath);
    try {
      const adrFiles = fs.readdirSync(adrDir).filter(f => f.endsWith('.md')).slice(0, 12);
      if (adrFiles.length > 0) {
        sections.push(`## Architecture Decision Records (${adrFiles.length} ADRs)\n`);
        for (const f of adrFiles) {
          try {
            const content = fs.readFileSync(path.join(adrDir, f), 'utf-8');
            sections.push(content.slice(0, 2000)); // Each ADR up to 2K
            sections.push('\n---\n');
          } catch { /* skip */ }
        }
      }
    } catch { /* skip */ }
  }

  // Read DDD model
  const dddPath = artifacts['DDD'] ?? artifacts['ddd'] ?? '';
  if (dddPath && fs.existsSync(dddPath)) {
    try {
      const content = fs.readFileSync(dddPath, 'utf-8');
      sections.push('## Domain-Driven Design Model\n');
      sections.push(content.slice(0, 8000));
      sections.push('');
    } catch { /* skip */ }
  }

  // Read SPARC specification
  const sparcPath = artifacts['SPARC'] ?? artifacts['sparc'] ?? '';
  if (sparcPath && fs.existsSync(sparcPath)) {
    try {
      const content = fs.readFileSync(sparcPath, 'utf-8');
      sections.push('## SPARC Specification\n');
      sections.push(content.slice(0, 5000));
      sections.push('');
    } catch { /* skip */ }
  }

  // Read SPARC architecture markdown if available
  for (const key of ['sparc-architecture-md', 'sparc-specification-md']) {
    const p = artifacts[key] ?? '';
    if (p && fs.existsSync(p)) {
      try {
        const content = fs.readFileSync(p, 'utf-8');
        sections.push(`## ${key.replace(/-/g, ' ')}\n`);
        sections.push(content.slice(0, 3000));
        sections.push('');
      } catch { /* skip */ }
      break; // Only include one SPARC markdown
    }
  }

  return sections.join('\n');
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
        argv: ['--local-only'],
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
        argv: ['--local-only'],
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
        argv: ['--local-only'],
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
        argv: ['--local-only'],
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
        argv: ['--local-only'],
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
        argv: ['--local-only'],
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
          `Implement bounded context "${ctx.name}" in ${language}. ` +
          `Write REAL business logic CUSTOM to the project requirements below -- not stubs or generic CRUD.\n\n` +
          `## Project Requirements\n\n${scenarioQuery}\n\n` +
          `## This Context: ${ctx.name}\n` +
          `${promptSection}\n` +
          `Source files: ${artifactCtx}`,
        targetDir: `src/${ctxSlug}`,
        wave: wave.wave,
        dependsOn: taskDependsOn.length > 0 ? taskDependsOn : undefined,
        argv: ['--local-only'],
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

  lines.push(`## Project Requirements (Full End-User Prompt)`);
  lines.push('');
  lines.push(scenarioQuery);
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
  _artifacts: Record<string, string>,
): RufloTask[] {
  return [
    {
      label: 'SPARC Specification + London School TDD',
      description: `${scenarioQuery}

Write the SPARC specification created by Reuven Cohen + London School TDD. Remember SPARC is: Specification, Pseudocode, Architecture, Refinement, Completion.

CRITICAL: The Pseudocode section must contain REAL algorithms — not generic validate/process/persist templates. Write the actual domain-specific algorithms this system needs (e.g., time-series calculations, optimization solvers, scoring functions, simulation logic). Include typed data structures with real field names and types specific to this domain.

The Architecture section must define actual API contracts with typed request/response schemas, database table definitions with domain-specific columns, and clear service boundaries with integration points.

Write all output to the ./plans folder as markdown files:
- plans/SPARC_SPECIFICATION.md
- plans/SPARC_PSEUDOCODE.md
- plans/SPARC_ARCHITECTURE.md
- plans/SPARC_REFINEMENT.md
- plans/SPARC_COMPLETION.md
- plans/TDD_PLAN.md

The implementation must be enterprise grade, commercially viable, production ready, bug and error free with no compilation issues.`,
      targetDir: 'plans',
      argv: ['--local-only'],
    },
  ];
}

/**
 * Build Ruflo tasks for Phase 3: SPARC + TDD.
 * Ruflo writes complete SPARC specs and TDD plans from research.
 */
export function buildPhase3Tasks(
  scenarioQuery: string,
  _artifacts: Record<string, string>,
): RufloTask[] {
  const exemplarBlock = loadAdrExemplarForRuflo();

  return [
    {
      label: 'ADRs + DDDs',
      description: `${scenarioQuery}

Create the ADRs and DDDs based on the SPARC files in the ./plans folder. The implementation must be enterprise grade, commercially viable, production ready, with no bugs or errors, and no compilation issues.

## Quality bar (ADR-PIPELINE-100 §D1)

Each ADR is a full markdown document — not a paragraph, not a bullet list. Match the structural depth shown in the exemplar below for the user's domain. The exemplar's subject (a vector database) is unrelated to the user's domain — copy the **structure** (sections, tables, code samples, diagrams, alternatives with rejection reasons), not the content.

Required structural elements per ADR:
- Header block: \`# ADR-NNN: <specific decision title>\`, \`**Status:** Proposed\`, \`**Date:** <ISO date>\`, \`**Implementation Phase:** <foundation|domain|integration|api|deployment|operations|cross-cutting>\`
- \`## Context\` with sub-sections and at least one comparison table
- \`## Decision\` with an architecture diagram (ASCII art or mermaid block)
- Per-component subsections with code samples (typed signatures, struct/class definitions) and real source-file paths
- \`## Configuration\` table (param / default / description) where applicable
- \`## Alternatives Considered\` — numbered, each with a multi-line "Rejected because:" rationale (not strawmen)
- \`## Consequences\` split into Benefits, Risks (table with Probability/Impact/Mitigation columns), Performance Targets where measurable
- \`## Implementation Status\` table (module / status / notes)
- \`## Related Decisions\` cross-links to other ADRs

CRITICAL for ADRs: Each ADR must be a REAL implementation decision that tells a developer what to build and how. Not "Build X as modular service with clear interfaces." Instead: specify the actual algorithm, data source, API, library, or approach to use, with concrete file paths and typed signatures. Example: "Use WattTime API for real-time grid carbon intensity data, polled every 5 minutes per grid region, cached in PostgreSQL with 1-hour TTL."

The Implementation Phase tag drives phase-aware ADR injection in the implementation prompts (ADR-PIPELINE-100 §D4). Use \`foundation\` for repo scaffolding and core types, \`domain\` for domain models and business logic, \`integration\` for adapters / connectors / anti-corruption layers, \`api\` for HTTP/RPC surfaces, \`deployment\` for infrastructure / CI / Docker, \`operations\` for observability / logging / metrics, \`cross-cutting\` for decisions that apply across all phases (security, governance, audit).

CRITICAL for DDDs: Each bounded context must have domain-specific typed fields (not Record<string, unknown>), domain-specific commands (not just Create/Update/Query), and real business invariants with invariant codes (e.g. PV-3, FS-4, RF-7). Entity interfaces must include the actual data fields this system needs to function. Aggregate roots must enforce their invariants in the constructor.

Write all output to the ./plans folder:
- plans/adrs/ (one .md file per ADR — \`ADR-NNN-<slug>.md\`)
- plans/ddd/ (domain-model.md + context-map.md)
- engineering/architecture-decisions.md (single concatenated file for downstream Phase 4 refinement; ADRs separated by horizontal rules)
- engineering/domain-model.md

Coverage: emit 8-14 ADRs (more for technology-rich projects, fewer for narrow scopes). Cover BOTH categories:
A) Domain-specific (at least 5) — core business logic, algorithms, scoring, routing, factor sourcing, threshold models, audit/lineage patterns. Each non-obvious algorithmic choice gets its own ADR.
B) Infrastructure (3-5) — data persistence, ERP integration approach, deployment, security/compliance.${exemplarBlock}`,
      targetDir: 'plans',
      argv: ['--local-only'],
    },
  ];
}

/**
 * Load `docs/templates/ADR-Good-Example.md` to embed as the structural
 * exemplar in the Ruflo writer task. Returns an empty string when the file
 * is unavailable (the task still works without an exemplar but quality is
 * lower). Mirrors `loadGoodAdrExemplar` in adr-generator.ts; kept separate
 * here to avoid an import cycle through phase2/phases.
 */
function loadAdrExemplarForRuflo(): string {
  const candidates: string[] = [];
  candidates.push(path.resolve(process.cwd(), 'docs/templates/ADR-Good-Example.md'));
  try {
    const here = fileURLToPath(import.meta.url);
    let dir = path.dirname(here);
    for (let i = 0; i < 8 && dir !== path.dirname(dir); i++) {
      candidates.push(path.join(dir, 'docs', 'templates', 'ADR-Good-Example.md'));
      dir = path.dirname(dir);
    }
  } catch { /* import.meta.url unavailable in some test contexts */ }

  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) {
        const exemplar = fs.readFileSync(p, 'utf-8');
        return `

## Structural exemplar (ADR-PIPELINE-100 §D1)

The following is a canonical "good" ADR from a different domain (vector database). **Match its structure, depth, and rigour for the user's domain above.** Do NOT reuse its subject matter — your input is the scenario query, not the exemplar.

<EXEMPLAR>
${exemplar}
</EXEMPLAR>`;
      }
    } catch { /* unreadable */ }
  }
  return '';
}

/**
 * Build Ruflo tasks for Phase 4: ADRs + DDDs.
 * Ruflo writes complete architecture decisions and domain models.
 */
export function buildPhase4Tasks(
  scenarioQuery: string,
  _artifacts: Record<string, string>,
): RufloTask[] {
  return [
    {
      label: 'Implementation Prompts',
      description: `${scenarioQuery}

Create a series of implementation prompts based on the SPARC, TDD, ADRs, DDDs in the ./plans folder. Remember, the implementation prompts must be dependency coherent for what needs to be built first for the platform. Be sure to refer to the relevant file paths for the combination of ADRs and DDDs required in the various phases of development for the solution. The implementation prompts must prepare the outcome to be enterprise grade, commercially viable, production ready, bug and error free with no compilation issues.

CRITICAL: Each implementation prompt must specify exactly what REAL code to write — not scaffolding or stubs. Include:
- The actual typed interfaces with domain-specific fields (not Record<string, unknown>)
- The actual algorithms and business logic to implement (not SELECT * FROM table WHERE 1=1)
- The actual database CREATE TABLE statements with domain-specific columns
- The actual test cases that validate domain behavior (not just "id is defined")
- If the user specified Rust, include prompts for Rust crate implementation with Cargo.toml

The output of executing these prompts must be a working system that engineers can plug into the ERP with light configuration — not empty shells they'd need to rewrite from scratch.

Write all output to the ./plans/prompts/ folder:
- plans/prompts/impl-001-*.md (first phase to build)
- plans/prompts/impl-002-*.md (second phase)
- ... (continue for all phases, typically 10-30 depending on complexity)
- plans/prompts/execution-plan.json (ordered list of all prompts with dependencies)`,
      targetDir: 'plans/prompts',
      argv: ['--local-only'],
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
  _language: string,
  _artifacts: Record<string, string>,
): RufloTask[] {
  return [
    {
      label: 'Code Generation — Implement All Prompts',
      description: `${scenarioQuery}

Implement the implementation prompts one by one in sequential order. The implementation prompts are located in the ./plans/prompts/ folder. Remember, implement the implementation prompts one at a time. The implementation must be enterprise grade, commercially viable, production ready, bug and error free with no compilation issues.

Read the implementation prompts in order (impl-001, impl-002, etc.) and implement each one fully before moving to the next. Each prompt references the specific ADRs and DDDs in ./plans/ that govern that phase of development.

CRITICAL — DO NOT generate scaffolding or stubs. This is a REAL implementation:
- Every interface must have REAL typed fields specific to this domain (not Record<string, unknown>, not generic id + status + created_at)
- Every adapter must contain REAL business logic (not SELECT * FROM table WHERE 1=1 cast to unknown)
- Every algorithm described in the SPARC pseudocode must be IMPLEMENTED — real calculations, real data transformations, real optimization logic
- Database migrations must CREATE TABLE with domain-specific columns, proper types, indexes, and constraints
- Tests must validate REAL domain behavior with domain-specific assertions (not just "id is defined")
- If the user specified Rust, create a rust/ directory with Cargo.toml and implement the Rust components with real algorithms
- The end result must be a system that engineers can deploy and connect to their ERP with minimal configuration — not empty shells

Engineers on the client's team should be able to plug this into their ERP using the ERP surface endpoints that are already established, with light massaging only.`,
      targetDir: 'src',
      wave: 1,
      argv: ['--local-only'],
    },
  ];
}

/**
 * Legacy Phase 5 task builder -- used when no DDD domain model exists.
 * Produces the original flat task list for backward compatibility.
 */
// @ts-expect-error Retained for backward compatibility — may be re-enabled
function buildPhase5TasksLegacy(
  scenarioQuery: string,
  language: string,
  artifacts: Record<string, string>,
): RufloTask[] {
  // Read the actual ADR/DDD/SPARC content so each task has full project context
  const projectContext = buildInlineProjectContext(artifacts, scenarioQuery);
  const artifactCtx = buildArtifactContext(artifacts);

  return [
    {
      label: 'Backend Implementation',
      description: `Build a complete, production-ready ${language} backend service that solves the SPECIFIC problem described below. ` +
        `Read the full project requirements, ADRs, and DDD model carefully — your implementation must be CUSTOM to this project, not generic boilerplate.\n\n` +
        `${projectContext}\n\n` +
        `## Implementation Instructions\n` +
        `Implement ALL command handlers, query handlers, domain logic, aggregate roots, and domain events ` +
        `from the DDD model above. Include real business logic specific to this domain -- not stubs. Wire all integration points with ` +
        `actual API calls (not mock clients). Include connection pooling, retry logic, circuit breakers, ` +
        `and comprehensive error handling. Follow the technology decisions in the ADRs. Source files: ${artifactCtx}`,
      targetDir: 'src',
      wave: 1,
      argv: ['--local-only'],
    },
    {
      label: 'Frontend Application',
      description: `Build a production-ready frontend application for the SPECIFIC system described below.\n\n` +
        `${projectContext}\n\n` +
        `## Implementation Instructions\n` +
        `Build a dashboard that reflects the actual bounded contexts and domain operations above. ` +
        `Include data tables for each query, command forms for each command, typed API client matching the backend, ` +
        `authentication flow, error boundaries, loading states, and responsive layout. Source files: ${artifactCtx}`,
      targetDir: 'ui',
      wave: 2,
      dependsOn: ['Backend Implementation'],
      argv: ['--local-only'],
    },
    {
      label: 'Infrastructure & Integration',
      description: `Build production infrastructure and integration layer for the SPECIFIC system described below.\n\n` +
        `${projectContext}\n\n` +
        `## Implementation Instructions\n` +
        `Include: HTTP middleware (auth, CORS, logging, rate limiting, error handling), ` +
        `ERP client adapters with real API endpoints for the ERP system specified in the requirements (not stubs), database connection management, ` +
        `integration modules for the external systems mentioned in the requirements, health checks, and metrics endpoints. Source files: ${artifactCtx}`,
      targetDir: 'src/infra',
      wave: 2,
      dependsOn: ['Backend Implementation'],
      argv: ['--local-only'],
    },
    {
      label: 'Database & SQL',
      description: `Generate production SQL schemas for the SPECIFIC domain model described below.\n\n` +
        `${projectContext}\n\n` +
        `## Implementation Instructions\n` +
        `Include: CREATE TABLE per DDD aggregate root from the domain model above, indexes for the query patterns defined above, foreign keys, ` +
        `constraint checks, migration scripts (up/down), seed data that reflects the actual domain entities, and ` +
        `database-specific optimizations for the database engine specified in the ADRs. Source files: ${artifactCtx}`,
      targetDir: 'sql',
      wave: 1,
      argv: ['--local-only'],
    },
    {
      label: 'Test Suite',
      description: `Build a comprehensive test suite for the SPECIFIC system described below.\n\n` +
        `${projectContext}\n\n` +
        `## Implementation Instructions\n` +
        `IMPORTANT: This task runs AFTER domain code is generated. ` +
        `Import modules from the ACTUAL generated domain code — do NOT guess import paths. ` +
        `Read the generated source files in src/ to discover what modules, classes, and functions exist, ` +
        `then write tests that import and test those REAL exports. ` +
        `Write London School TDD tests: mock collaborator interfaces at aggregate boundaries, ` +
        `test command handlers in isolation, test query handlers with in-memory adapters. ` +
        `Tests must validate the SPECIFIC business logic described in the requirements — not generic CRUD tests. ` +
        `NAMING CONVENTION: Port interfaces are named {ContextName}Port (no "I" prefix). ` +
        `Adapters are {Implementation}{ContextName}Adapter. Source files: ${artifactCtx}`,
      targetDir: 'tests',
      wave: 4,
      dependsOn: ['Backend Implementation', 'Database & SQL'],
      argv: ['--local-only'],
    },
    {
      label: 'Deployment Configuration',
      description: `Generate production deployment configuration for the SPECIFIC system described below.\n\n` +
        `${projectContext}\n\n` +
        `## Implementation Instructions\n` +
        `Read the requirements above to determine the correct cloud provider and deployment target. ` +
        `Include: Dockerfile (multi-stage, optimized), Docker Compose for local dev, ` +
        `cloud deployment configs matching the cloud provider specified in requirements, CI/CD pipeline, ` +
        `environment variable templates matching the ERP and database config from the ADRs, ` +
        `and IaC (Terraform/YAML) for the specified cloud platform. Source files: ${artifactCtx}`,
      targetDir: 'deploy',
      wave: 2,
      dependsOn: ['Backend Implementation'],
      argv: ['--local-only'],
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
      description: `Build the production ERP integration layer for the SPECIFIC system described below.\n\n` +
        `## Project Requirements\n\n${scenarioQuery}\n\n` +
        `## ERP Integration Instructions\n` +
        `Generate: ERP surface mapping (service endpoints to ERP operations matching the domain model), authentication configuration ` +
        `(OAuth2/SAML/certificate-based per the ERP system specified in requirements), webhook receivers for ERP events, ` +
        `data transformation adapters specific to this domain, and health monitoring for ERP connectivity. ` +
        `Source files: ${artifactCtx}`,
      targetDir: 'erp',
      argv: ['--local-only'],
    },
  ];
}

// ============================================================================
// Phase 5/5a task builders — ADR-PIPELINE-091
// ============================================================================

/**
 * Canonical SPARC section ordering. `buildImplPromptsTasks` emits one Ruflo
 * task per section so downstream tests can assert `task count ===
 * SPARC_SECTIONS.length` on the default path.
 */
const SPARC_SECTIONS = ['specification', 'pseudocode', 'architecture', 'refinement', 'completion'] as const;
type SparcSection = typeof SPARC_SECTIONS[number];

/**
 * Build Ruflo tasks for the coverage-gap slot (normally handled by the remote
 * `quality-engineering/coverage-gap-detect` agent). Under ADR-PIPELINE-091
 * the local swarm produces the same output so remote 503s do not gate the
 * pipeline. The task writes a `coverage-gaps.json` under the phase-5
 * coverage directory.
 */
export function buildCoverageGapTasks(
  dossier: Phase1Dossier,
  context: RufloExecutionContext,
): RufloTask[] {
  const language = context.language ?? 'typescript';
  const sparcRef = dossier.artifacts?.['SPARC'] ?? dossier.artifacts?.['sparc-combined'] ?? '';
  const tddRef = dossier.artifacts?.['TDD'] ?? dossier.artifacts?.['tdd'] ?? '';
  const adrRef = dossier.artifacts?.['ADRs'] ?? dossier.artifacts?.['adrs'] ?? '';
  const dddRef = dossier.artifacts?.['DDD'] ?? dossier.artifacts?.['ddd'] ?? '';

  const sources = [
    sparcRef ? `SPARC=${sparcRef}` : '',
    tddRef ? `TDD=${tddRef}` : '',
    adrRef ? `ADRs=${adrRef}` : '',
    dddRef ? `DDD=${dddRef}` : '',
  ].filter(Boolean).join(', ') || '(none yet — infer gaps from scenario query alone)';

  return [
    {
      label: 'Coverage Gap Detection',
      description: [
        `Task: emit the coverage-gap list the remote quality-engineering/coverage-gap-detect agent would normally produce.`,
        ``,
        `## Project scenario`,
        dossier.scenarioQuery,
        ``,
        `## Target language`,
        language,
        ``,
        `## Source artifacts`,
        sources,
        ``,
        `## Required output (write exactly these files under ./coverage/)`,
        `- coverage/coverage-gaps.json`,
        `  Shape: { "traceId": "${dossier.traceId}", "gaps": [{ "area": string, "file": string, "severity": "high"|"medium"|"low", "reason": string, "suggestedTests": string[] }], "summary": { "high": number, "medium": number, "low": number } }`,
        `- coverage/coverage-gaps.md (human-readable companion report).`,
        ``,
        `Rules:`,
        `1. Every gap must cite the SPARC or DDD element it comes from (command, query, aggregate, or domain event).`,
        `2. Severity uses "high" for unvalidated domain invariants, "medium" for missing command-handler integration tests, "low" for style/docstring gaps.`,
        `3. Do NOT invent files that are not in the SPARC/DDD/ADR set above — if no source is available, emit an empty gaps array and a summary with zeroes.`,
        `4. This is a LOCAL-ONLY run. Do not call any remote diligence agent; the primary executor has already marked this pass as local-only via --local-only.`,
      ].join('\n'),
      targetDir: 'coverage',
      argv: ['--local-only'],
    },
  ];
}

/**
 * Build Ruflo tasks for the implementation-prompts slot (normally produced
 * from SPARC + ADRs + DDD). Emits one Ruflo task per canonical SPARC section
 * so the combined output populates `plans/prompts/impl-NNN-<slug>.md` plus
 * `plans/prompts/execution-plan.json`. Matches the filename format auto-chain
 * consumes: `impl-${String(order).padStart(3, '0')}-${phase.slug}.md`.
 */
export function buildImplPromptsTasks(
  dossier: Phase1Dossier,
  context: RufloExecutionContext,
  adrs: readonly { id: string; title: string; decision?: string }[] = [],
  ddd: readonly { name: string; aggregates?: readonly string[] }[] = [],
): RufloTask[] {
  const language = context.language ?? 'typescript';

  const adrSummary: string = adrs.length
    ? adrs.slice(0, 24).map(a => `  - ${a.id}: ${a.title}${a.decision ? ' — ' + a.decision.slice(0, 160) : ''}`).join('\n')
    : '  (no ADRs supplied — infer from SPARC alone)';

  const dddSummary: string = ddd.length
    ? ddd.slice(0, 24).map(c => `  - ${c.name}${c.aggregates?.length ? ' (' + c.aggregates.slice(0, 6).join(', ') + ')' : ''}`).join('\n')
    : '  (no DDD contexts supplied — infer from SPARC alone)';

  const sparcRef = dossier.artifacts?.['SPARC'] ?? dossier.artifacts?.['sparc-combined'] ?? '';

  return SPARC_SECTIONS.map((section: SparcSection, idx: number): RufloTask => {
    const order = idx + 1;
    const slug = section;
    const filename = `impl-${String(order).padStart(3, '0')}-${slug}.md`;

    return {
      label: `Impl Prompt — ${section}`,
      description: [
        `Task: produce the implementation prompt for the SPARC "${section}" section.`,
        ``,
        `## Scenario`,
        dossier.scenarioQuery,
        ``,
        `## Target language`,
        language,
        ``,
        `## ADRs in scope`,
        adrSummary,
        ``,
        `## Bounded contexts in scope`,
        dddSummary,
        ``,
        `## Source SPARC artifact`,
        sparcRef || '(none — use scenario query alone)',
        ``,
        `## Required output`,
        `Write exactly one file: plans/prompts/${filename}`,
        `The prompt must be dependency-coherent with its predecessors (prompts 001..${String(order - 1).padStart(3, '0')}).`,
        `Include:`,
        `- Exact typed interfaces with domain-specific fields (no Record<string, unknown>).`,
        `- The algorithms or database DDL this step implements.`,
        `- Test cases validating domain behavior (not "id is defined").`,
        `- A clear "Prerequisites" block that references prior prompts by filename.`,
        ``,
        `After writing the ${filename} file, append an entry to plans/prompts/execution-plan.json (create if missing) with shape: `,
        `  { "order": ${order}, "file": "${filename}", "section": "${section}", "dependsOn": [${order > 1 ? `"impl-${String(order - 1).padStart(3, '0')}-${SPARC_SECTIONS[idx - 1]}.md"` : ''}] }.`,
        ``,
        `This is a LOCAL-ONLY run. --local-only is already set on the task; do not invoke remote diligence agents.`,
      ].join('\n'),
      targetDir: 'plans/prompts',
      wave: order === 1 ? 1 : 2,
      dependsOn: order === 1 ? undefined : [`Impl Prompt — ${SPARC_SECTIONS[idx - 1]}`],
      argv: ['--local-only'],
    };
  });
}

// ============================================================================
// Canonical Primary-Executor Entry Point — ADR-PIPELINE-091
// ============================================================================

/** Phase ids accepted by `runPrimaryPhaseExecution`. */
export type PrimaryPhaseId =
  | 'phase3-sparc'
  | 'phase4-adrs-ddd'
  | 'phase5a-prompts'
  | 'phase5-coverage';

/**
 * Result of `runPrimaryPhaseExecution`. Tags the output with an explicit
 * execution tier so auto-chain / the ADR-093 gate can decide whether to fall
 * through to deterministic templates. Extends `RufloPhaseResult` with the
 * tier + reason, while keeping the raw inner result for observability.
 */
export interface PrimaryPhaseExecutionResult {
  /** Phase id the execution was requested for. */
  readonly phaseId: PrimaryPhaseId;
  /** Whether the invocation produced usable artifacts. */
  readonly success: boolean;
  /**
   * Which executor produced the output.
   *  - `ruflo-local`   : local Ruflo swarm ran (may still have timed out — check swarmCompleted)
   *  - `local-fallback`: ADR-094 D8 deterministic local generator ran (Ruflo unavailable, but
   *                     Phase-1 consensus was usable). Output tagged `quality: degraded`.
   *  - `unavailable`   : neither Ruflo NOR the local fallback could produce output; caller exits.
   */
  readonly executionTier: 'ruflo-local' | 'local-fallback' | 'unavailable';
  /** Machine-readable reason when `success === false`. */
  readonly reason?:
    | 'ruflo-not-available'
    | 'ruflo-disabled-by-env'
    | 'ruflo-timeout'
    | 'no-tasks-built'
    | 'swarm-error'
    | 'local-fallback-no-consensus'
    | 'local-fallback-write-error';
  /** Underlying Ruflo swarm result when actually invoked; undefined on the unavailable path. */
  readonly rufloResult?: RufloPhaseResult;
  /** Convenience mirror of `rufloResult?.filesModified` (0 on the unavailable path). */
  readonly filesModified: number;
  /** Wall-clock time in ms. */
  readonly timing: number;
  /** Human-readable summary. */
  readonly message: string;
}

/**
 * Map a canonical phase id onto the matching task builder + label + output
 * slot. Centralised here so both auto-chain and the ADR-093 dependency gate
 * see the same mapping.
 */
function buildTasksForPrimaryPhase(
  phaseId: PrimaryPhaseId,
  dossier: Phase1Dossier,
  context: RufloExecutionContext,
): { tasks: RufloTask[]; label: string; phaseNumber: number } {
  const artifacts = dossier.artifacts ?? {};

  switch (phaseId) {
    case 'phase3-sparc':
      return {
        tasks: buildPhase3Tasks(dossier.scenarioQuery, artifacts),
        label: 'SPARC + London TDD (primary)',
        phaseNumber: 3,
      };
    case 'phase4-adrs-ddd':
      return {
        tasks: buildPhase4Tasks(dossier.scenarioQuery, artifacts),
        label: 'ADRs + DDD (primary)',
        phaseNumber: 4,
      };
    case 'phase5a-prompts': {
      // Try to extract ADR + DDD summaries from dossier artifacts if present.
      const adrSummaries = artifacts['ADRs']
        ? extractADRSummary(artifacts['ADRs']).map(a => ({ id: a.id, title: a.title, decision: a.decision }))
        : [];
      const dddSummaries = artifacts['DDD']
        ? extractDDDSummary(artifacts['DDD']).contexts.map(c => ({ name: c.name, aggregates: c.aggregates }))
        : [];
      return {
        tasks: buildImplPromptsTasks(dossier, context, adrSummaries, dddSummaries),
        label: 'Implementation Prompts (primary)',
        phaseNumber: 5,
      };
    }
    case 'phase5-coverage':
      return {
        tasks: buildCoverageGapTasks(dossier, context),
        label: 'Coverage Gap Detection (primary)',
        phaseNumber: 5,
      };
  }
}

/**
 * Canonical primary-executor entry point per ADR-PIPELINE-091.
 *
 * Invariants:
 *  1. Never throws. Returns `{ success: false, executionTier: 'unavailable' }`
 *     when Ruflo is not runnable — the caller decides fallback.
 *  2. Honors `AGENTICS_DISABLE_RUFLO=true` (short-circuits without touching
 *     the binary; reason is `ruflo-disabled-by-env`).
 *  3. Timeout defaults to `DEFAULT_PHASE_TIMEOUT`, overridable per-call. When
 *     the Ruflo swarm exceeds the budget, tier stays `ruflo-local` but
 *     `success` flips to false with reason `ruflo-timeout` so the gate can
 *     trigger template fallback.
 *  4. Every dispatched task carries `--local-only` (enforced both in builders
 *     and defensively by the executor loop).
 */
/**
 * ADR-094 Decision 8 — local fallback delegate. When Ruflo is unavailable,
 * try to produce the requested phase's artifacts deterministically from
 * Phase-1 consensus. Returns a `local-fallback`-tier result on success, or
 * `undefined` if no fallback exists for this phase or Phase-1 consensus is
 * unrecoverable (in which case the caller returns the original `unavailable`
 * result).
 *
 * No `phase5-coverage` fallback: coverage analysis is a Ruflo-only
 * capability for now, so that path keeps its old behaviour.
 */
async function tryLocalFallback(
  phaseId: PrimaryPhaseId,
  dossier: Phase1Dossier,
  startTime: number,
): Promise<PrimaryPhaseExecutionResult | undefined> {
  // Lazy-load to avoid circular imports — local-fallback files import only
  // from `local-fallback/` and `node:fs`/`node:path`, so this is safe.
  let result: { success: boolean; filesWritten: string[]; reason?: string; message: string };
  switch (phaseId) {
    case 'phase3-sparc': {
      const { runPhase3LocalFallback } = await import('./local-fallback/phase3-local-fallback.js');
      result = runPhase3LocalFallback(dossier.runDir);
      break;
    }
    case 'phase4-adrs-ddd': {
      const { runPhase4LocalFallback } = await import('./local-fallback/phase4-local-fallback.js');
      result = runPhase4LocalFallback(dossier.runDir);
      break;
    }
    case 'phase5a-prompts': {
      const { runPhase5aLocalFallback } = await import('./local-fallback/phase5a-local-fallback.js');
      result = runPhase5aLocalFallback(dossier.runDir);
      break;
    }
    default:
      // No fallback for this phase id — caller continues with `unavailable`.
      return undefined;
  }

  if (!result.success) {
    // Map fallback reasons onto the typed reason union; unrecognized strings
    // collapse to `local-fallback-write-error`.
    const reason: PrimaryPhaseExecutionResult['reason'] =
      result.reason === 'no-phase1-consensus' ? 'local-fallback-no-consensus' : 'local-fallback-write-error';
    return {
      phaseId,
      success: false,
      executionTier: 'unavailable',
      reason,
      filesModified: result.filesWritten.length,
      timing: Date.now() - startTime,
      message: result.message,
    };
  }

  return {
    phaseId,
    success: true,
    executionTier: 'local-fallback',
    filesModified: result.filesWritten.length,
    timing: Date.now() - startTime,
    message: result.message,
  };
}

export async function runPrimaryPhaseExecution(
  phaseId: PrimaryPhaseId,
  dossier: Phase1Dossier,
  context: RufloExecutionContext,
  timeout?: number,
): Promise<PrimaryPhaseExecutionResult> {
  const startTime = Date.now();
  const effectiveTimeout = typeof timeout === 'number' && timeout > 0 ? timeout : DEFAULT_PHASE_TIMEOUT;

  const check = checkRufloAvailable();
  if (!check.available) {
    // ADR-094 Decision 8 — when Ruflo is unavailable, delegate to the
    // deterministic local fallback for phases 3, 4, 5a. This removes Ruflo
    // as a single point of failure for the engineering chain. The fallback
    // consumes Phase-1 consensus and produces minimal-but-non-empty artifacts
    // tagged `quality: degraded`. Phases that have no fallback (phase5-coverage)
    // still return `unavailable` for upstream handling.
    const fallbackResult = await tryLocalFallback(phaseId, dossier, startTime);
    if (fallbackResult) return fallbackResult;

    const reason: PrimaryPhaseExecutionResult['reason'] =
      check.reason === 'disabled-by-env' ? 'ruflo-disabled-by-env' : 'ruflo-not-available';
    return {
      phaseId,
      success: false,
      executionTier: 'unavailable',
      reason,
      filesModified: 0,
      timing: Date.now() - startTime,
      message:
        check.reason === 'disabled-by-env'
          ? `Ruflo disabled via AGENTICS_DISABLE_RUFLO; caller should fall through to templates for ${phaseId}`
          : `Ruflo not available (${check.version || 'no binary'}); caller should fall through to templates for ${phaseId}`,
    };
  }

  const { tasks, label, phaseNumber } = buildTasksForPrimaryPhase(phaseId, dossier, context);
  if (tasks.length === 0) {
    return {
      phaseId,
      success: false,
      executionTier: 'ruflo-local',
      reason: 'no-tasks-built',
      filesModified: 0,
      timing: Date.now() - startTime,
      message: `No Ruflo tasks built for ${phaseId}`,
    };
  }

  // Ensure output dir exists before dispatch — executeRufloPhaseSwarm does
  // this too but the caller expects the directory to exist on success.
  try {
    fs.mkdirSync(context.outputDir, { recursive: true, mode: 0o700 });
  } catch {
    // non-fatal; downstream will surface any permission problems
  }

  let result: RufloPhaseResult | undefined;
  try {
    result = executeRufloPhaseSwarm({
      phase: phaseNumber,
      label,
      scenarioQuery: dossier.scenarioQuery,
      runDir: dossier.runDir,
      traceId: dossier.traceId,
      outputDir: context.outputDir,
      tasks,
      agenticsResults: context.agenticsResults ?? [],
      priorArtifacts: dossier.artifacts ?? {},
      maxAgents: context.maxAgents ?? DEFAULT_MAX_AGENTS,
      timeoutMs: effectiveTimeout,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      phaseId,
      success: false,
      executionTier: 'ruflo-local',
      reason: 'swarm-error',
      filesModified: 0,
      timing: Date.now() - startTime,
      message: `Ruflo swarm errored for ${phaseId}: ${msg.slice(0, 200)}`,
    };
  }

  const timing = Date.now() - startTime;
  const success = result.filesModified > 0;
  const timedOut = timing >= effectiveTimeout && !result.swarmCompleted;

  return {
    phaseId,
    success,
    executionTier: 'ruflo-local',
    reason: success ? undefined : (timedOut ? 'ruflo-timeout' : 'swarm-error'),
    rufloResult: result,
    filesModified: result.filesModified,
    timing,
    message: success
      ? `Ruflo primary executor produced ${result.filesModified} files for ${phaseId} in ${timing}ms`
      : `Ruflo primary executor produced no files for ${phaseId} in ${timing}ms`,
  };
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

    // Per ADR-PIPELINE-091: every engineering task is dispatched `--local-only`
    // so the local swarm does not round-trip to the remote fleet it is meant
    // to be independent of. Task builders normalize this; if a legacy task
    // slipped through without argv, we defensively inject it here too.
    const extraArgs: string[] = Array.from(task.argv ?? []);
    if (!extraArgs.includes('--local-only')) extraArgs.push('--local-only');

    try {
      rufloExec(check.binary, [
        'task', 'create',
        '--type', 'implementation',
        '--description', fullDescription,
        ...extraArgs,
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
