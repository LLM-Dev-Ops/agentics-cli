/**
 * Generalized Ruflo Phase Executor
 *
 * A single, shared executor that runs Ruflo agent swarms for ANY pipeline phase.
 * Each phase passes its own task definitions, artifact context, and agentics
 * agent results — the executor handles swarm init, task creation, and execution.
 *
 * This replaces per-phase Ruflo invocation with one unified entry point.
 * The key innovation: agentics agent results are embedded IN the Ruflo task
 * descriptions so the swarm can leverage the full 110-agent fleet mid-generation.
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
}

// ============================================================================
// Constants
// ============================================================================

const CHECK_TIMEOUT = 30_000;
const DEFAULT_SWARM_TIMEOUT = 600_000;
const DEFAULT_MAX_AGENTS = 8;

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
    if (entry.isDirectory() && !['node_modules', '.git'].includes(entry.name)) {
      count += countFiles(path.join(dir, entry.name));
    } else if (entry.isFile()) {
      count++;
    }
  }
  return count;
}

// ============================================================================
// Agentics Cooperation Context Builder
// ============================================================================

/**
 * Build a context string from agentics agent results that Ruflo tasks
 * can consume. This is the cooperation point — agentics agents' domain
 * expertise (security scans, ERP surface maps, quality evaluations,
 * schema validations, etc.) becomes available to Ruflo during generation.
 */
function buildAgenticsCooperationContext(results: AgenticsServiceResult[]): string {
  if (results.length === 0) return '';

  const lines: string[] = [
    '\n--- AGENTICS AGENT FLEET ANALYSIS (use this context during generation) ---',
  ];

  for (const r of results) {
    if (r.status !== 200) continue;

    const response = typeof r.response === 'string'
      ? r.response.slice(0, 800)
      : JSON.stringify(r.response).slice(0, 800);

    lines.push(`\n[${r.domain}/${r.agent}] (${r.role}):`);
    lines.push(response);
  }

  lines.push('\n--- END AGENTICS ANALYSIS ---');
  return lines.join('\n');
}

/**
 * Build artifact context string from prior phase artifacts.
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
  return [
    {
      label: 'Backend Implementation',
      description: `Build a complete, production-ready ${language} backend service for: ${scenarioQuery.slice(0, 300)}. ` +
        `Implement ALL command handlers, query handlers, domain logic, aggregate roots, and domain events ` +
        `from the DDD model. Include real business logic — not stubs. Wire all integration points with ` +
        `actual API calls (not mock clients). Include connection pooling, retry logic, circuit breakers, ` +
        `and comprehensive error handling. Source: ${artifactCtx}`,
      targetDir: 'src',
    },
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
  ];
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
 *   5. File count tracking and result reporting
 *
 * The agentics agent results are injected INTO each task description,
 * giving Ruflo access to the fleet's domain expertise during generation.
 */
export function executeRufloPhaseSwarm(config: RufloPhaseConfig): RufloPhaseResult {
  const startTime = Date.now();
  const maxAgents = config.maxAgents ?? DEFAULT_MAX_AGENTS;
  const timeoutMs = config.timeoutMs ?? DEFAULT_SWARM_TIMEOUT;

  // ── Check ruflo availability ──
  const check = checkRufloAvailable();
  if (!check.available) {
    console.error(`  [RUFLO-P${config.phase}] ruflo not available: ${check.version}`);
    return {
      invoked: false, rufloAvailable: false, filesModified: 0,
      tasksCreated: 0, swarmCompleted: false, timing: Date.now() - startTime,
      version: check.version,
    };
  }

  console.error(`  [RUFLO-P${config.phase}] ${check.version} — executing ${config.tasks.length} tasks for: ${config.label}`);

  // ── Ensure output directory exists ──
  fs.mkdirSync(config.outputDir, { recursive: true, mode: 0o700 });

  // ── Count files before ──
  const filesBefore = countFiles(config.outputDir);

  // ── Build cooperation context from agentics agents ──
  const agenticsContext = buildAgenticsCooperationContext(config.agenticsResults);
  const artifactContext = buildArtifactContext(config.priorArtifacts);

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

  // ── Step 2: Create tasks with agentics context embedded ──
  let tasksCreated = 0;
  for (const task of config.tasks) {
    // Embed agentics agent analysis directly in the task description
    const fullDescription = task.description + agenticsContext;

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

  // ── Step 3: Start the swarm ──
  const objectiveParts = [
    `Phase ${config.phase} (${config.label}): Build production-grade artifacts for: ${config.scenarioQuery.slice(0, 400)}.`,
    `Tasks: ${config.tasks.map(t => t.label).join(', ')}.`,
    `Artifacts: ${artifactContext.slice(0, 400)}.`,
    `Target: ${config.outputDir}.`,
    'IMPORTANT: Output must be enterprise-grade, production-ready, and commercially viable.',
    'Use the agentics.dev agent fleet analysis included in each task description.',
  ];

  let swarmCompleted = false;
  try {
    rufloExec(check.binary, [
      'swarm', 'start',
      '-o', objectiveParts.join(' '),
      '-s', 'development',
    ], config.outputDir, timeoutMs);
    swarmCompleted = true;
    console.error(`  [RUFLO-P${config.phase}] Swarm completed`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`  [RUFLO-P${config.phase}] Swarm execution note: ${msg.slice(0, 200)}`);
  }

  // ── Count files after ──
  const filesAfter = countFiles(config.outputDir);
  const filesModified = Math.max(0, filesAfter - filesBefore);
  const timing = Date.now() - startTime;

  console.error(`  [RUFLO-P${config.phase}] Result: ${filesModified} files, ${tasksCreated} tasks, ${timing}ms`);

  return {
    invoked: true,
    rufloAvailable: true,
    filesModified,
    tasksCreated,
    swarmCompleted,
    timing,
    version: check.version,
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
    'roadmap': 'roadmap.json',
    'results': 'results.json',
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
