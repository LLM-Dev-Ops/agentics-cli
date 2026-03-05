/**
 * Phase 3 Ruflo Executor
 *
 * Orchestrates ruflo's agent swarm to build a complete prototype from
 * SPARC/ADR/DDD/TDD artifacts. Instead of calling a phantom `ruflo fill`
 * command, this uses ruflo's actual working commands:
 *
 *   1. `ruflo swarm init` — initialize an agent swarm
 *   2. `ruflo task create` — create implementation tasks with artifact context
 *   3. `ruflo swarm start` — launch the swarm to execute all tasks
 *
 * The ruflo agents (coder, tester, architect) receive the full SPARC spec,
 * ADR decisions, DDD model, and TDD plan — they generate frontend, backend,
 * middleware, SQL, and tests.
 *
 * Export:
 *   - executeRuflo() — pipeline stage entry returning Phase3StageOutput
 */

import type {
  Phase3Context,
  Phase3StageOutput,
  RufloResult,
  LanguageResolution,
} from '../types.js';
import { createSpan, endSpan, emitSpan } from '../../phase2/telemetry.js';
import { execSync, spawnSync } from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs';

// ============================================================================
// Constants
// ============================================================================

/** Maximum time (ms) to wait for swarm execution. */
const SWARM_TIMEOUT = 600_000; // 10 minutes

/** Timeout for installation/init checks. */
const CHECK_TIMEOUT = 30_000;

/** Max agents in the coding swarm. */
const MAX_AGENTS = 8;

// ============================================================================
// Helpers
// ============================================================================

/**
 * Resolve the ruflo binary from local node_modules or global install.
 */
function resolveRufloBinary(): string | null {
  // Priority 1: Local node_modules binary
  const localBin = path.resolve(process.cwd(), 'node_modules', '.bin', 'ruflo');
  if (fs.existsSync(localBin)) return localBin;

  // Priority 2: Walk up from this file's directory
  let dir = path.dirname(new URL(import.meta.url).pathname);
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, 'node_modules', '.bin', 'ruflo');
    if (fs.existsSync(candidate)) return candidate;
    dir = path.dirname(dir);
  }

  // Priority 3: Global binary
  try {
    const global = execSync('which ruflo', { stdio: 'pipe', encoding: 'utf-8', timeout: CHECK_TIMEOUT }).trim();
    if (global) return global;
  } catch { /* not found globally */ }

  return null;
}

/**
 * Check whether ruflo is installed and has swarm support.
 */
function checkRufloInstalled(): { installed: boolean; version: string; binary: string } {
  const binary = resolveRufloBinary();
  if (!binary) return { installed: false, version: 'N/A', binary: '' };

  try {
    const output = execSync(`${binary} --version`, {
      encoding: 'utf-8',
      timeout: CHECK_TIMEOUT,
      stdio: 'pipe',
    });
    const version = output.trim() || 'unknown';

    // Verify swarm subcommand is available (the actual working command)
    try {
      execSync(`${binary} swarm --help`, { encoding: 'utf-8', timeout: CHECK_TIMEOUT, stdio: 'pipe' });
    } catch {
      return { installed: false, version: `${version} (swarm command not supported)`, binary };
    }

    return { installed: true, version, binary };
  } catch {
    return { installed: false, version: 'N/A', binary };
  }
}

/**
 * Run a ruflo command, returning stdout. Throws on failure.
 */
function rufloExec(binary: string, args: string[], cwd: string, timeout = CHECK_TIMEOUT): string {
  const result = spawnSync(binary, args, {
    cwd,
    timeout,
    encoding: 'utf-8',
    stdio: 'pipe',
  });

  if (result.status !== 0) {
    const stderr = (result.stderr ?? '').trim();
    throw new Error(`ruflo ${args[0]} failed (exit ${result.status}): ${stderr.slice(0, 300)}`);
  }

  return (result.stdout ?? '').trim();
}

/**
 * Read a JSON artifact file, returning its content as a string summary
 * suitable for passing as task context to ruflo agents.
 */
function summarizeArtifact(filePath: string, label: string): string {
  if (!fs.existsSync(filePath)) return `${label}: not found`;
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(content);

    if (label === 'SPARC') {
      const services = parsed?.architecture?.services ?? [];
      const modules = parsed?.pseudocode?.modules ?? [];
      return `${label}: ${services.length} services, ${modules.length} pseudocode modules`;
    }
    if (label === 'ADRs') {
      const count = Array.isArray(parsed) ? parsed.length : 0;
      return `${label}: ${count} architecture decisions`;
    }
    if (label === 'DDD') {
      const contexts = parsed?.contexts ?? [];
      const relations = parsed?.contextMap ?? [];
      return `${label}: ${contexts.length} bounded contexts, ${relations.length} relations`;
    }
    if (label === 'TDD') {
      const suites = parsed?.testSuites ?? [];
      return `${label}: ${suites.length} test suites`;
    }
    return `${label}: loaded`;
  } catch {
    return `${label}: parse error`;
  }
}

/**
 * Count files in a directory tree recursively.
 */
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
// Pipeline Stage Entry
// ============================================================================

/**
 * Pipeline stage: Ruflo swarm execution.
 *
 * Initializes a ruflo agent swarm, creates implementation tasks with
 * full SPARC/ADR/DDD/TDD artifact context, and launches the swarm
 * to build a complete prototype (frontend + backend + middleware + SQL).
 *
 * If ruflo is not installed, the stage completes with a skip warning.
 */
export function executeRuflo(context: Phase3Context): Phase3StageOutput {
  const span = createSpan('ruflo-execution', 'execute-ruflo');
  const startTime = Date.now();

  try {
    // ---- Check ruflo installation ----
    const rufloCheck = checkRufloInstalled();

    if (!rufloCheck.installed) {
      const timing = Date.now() - startTime;
      const skippedSpan = endSpan(span, 'ok', { rufloInstalled: false, skipped: true, timingMs: timing });
      emitSpan(skippedSpan);
      context.telemetrySpans.push(skippedSpan);

      return {
        stage: 'ruflo-execution',
        status: 'completed',
        data: { skipped: true, reason: `ruflo not available: ${rufloCheck.version}` },
        artifacts: [],
        timing,
        summary: `Ruflo execution skipped: ${rufloCheck.version}. Install ruflo@latest globally to enable agent swarm coding.`,
      };
    }

    console.error(`  [RUFLO] Found ${rufloCheck.version} at ${rufloCheck.binary}`);

    // ---- Resolve language from prior stage ----
    const langStageOutput = context.stageOutputs.get('language-resolution');
    if (!langStageOutput || langStageOutput.status === 'failed') {
      const timing = Date.now() - startTime;
      const failedSpan = endSpan(span, 'error', { reason: 'language-resolution not available' });
      emitSpan(failedSpan);
      context.telemetrySpans.push(failedSpan);

      return {
        stage: 'ruflo-execution',
        status: 'failed',
        data: { error: 'ECLI-P3-003: language-resolution stage output not available' },
        artifacts: [],
        timing,
        summary: 'Ruflo execution failed: language resolution not available.',
      };
    }

    const langResolution = langStageOutput.data as LanguageResolution;
    const language = langResolution.language;

    // ---- Locate artifacts ----
    const phase2Dir = context.phase2Dir;
    const phase3Dir = context.phase3Dir;
    const projectDir = path.join(phase3Dir, 'project');

    const sparcPath = path.join(phase2Dir, 'sparc', 'sparc-combined.json');
    const sparcAlt = path.join(phase2Dir, 'sparc-combined.json');
    const sparcFile = fs.existsSync(sparcPath) ? sparcPath : fs.existsSync(sparcAlt) ? sparcAlt : null;
    const adrIndexPath = path.join(phase2Dir, 'adrs', 'adr-index.json');
    const dddModelPath = path.join(phase2Dir, 'ddd', 'domain-model.json');
    const tddPlanPath = path.join(phase2Dir, 'tdd', 'tdd-plan.json');

    const artifactSummary = [
      summarizeArtifact(sparcFile ?? '', 'SPARC'),
      summarizeArtifact(adrIndexPath, 'ADRs'),
      summarizeArtifact(dddModelPath, 'DDD'),
      summarizeArtifact(tddPlanPath, 'TDD'),
    ].join('; ');

    console.error(`  [RUFLO] Artifacts: ${artifactSummary}`);
    console.error(`  [RUFLO] Language: ${language}, Target: ${projectDir}`);

    // ---- Count files before swarm ----
    const filesBefore = countFiles(projectDir);

    // ---- Step 1: Initialize ruflo swarm ----
    console.error('  [RUFLO] Step 1: Initializing agent swarm...');
    let swarmId = 'unknown';
    try {
      const initOutput = rufloExec(rufloCheck.binary, [
        'swarm', 'init',
        '--topology', 'hierarchical',
        '--max-agents', String(MAX_AGENTS),
        '--strategy', 'specialized',
      ], projectDir);

      // Extract swarm ID from output
      const idMatch = initOutput.match(/(?:swarm|id)[:\s]+([a-f0-9-]+)/i);
      swarmId = idMatch?.[1] ?? `swarm-${Date.now()}`;
      console.error(`  [RUFLO] Swarm initialized: ${swarmId}`);
    } catch (err) {
      // Swarm init failure is non-fatal — continue with task creation
      console.error(`  [RUFLO] Swarm init warning: ${err instanceof Error ? err.message : String(err)}`);
    }

    // ---- Step 2: Create implementation tasks with artifact context ----
    console.error('  [RUFLO] Step 2: Creating implementation tasks...');

    // Build the objective from scenario + artifacts
    const scenario = context.scenarioQuery || 'enterprise prototype';

    // Collect artifact paths that exist
    const artifactFlags: string[] = [];
    if (sparcFile) artifactFlags.push(`SPARC=${sparcFile}`);
    if (fs.existsSync(adrIndexPath)) artifactFlags.push(`ADRs=${adrIndexPath}`);
    if (fs.existsSync(dddModelPath)) artifactFlags.push(`DDD=${dddModelPath}`);
    if (fs.existsSync(tddPlanPath)) artifactFlags.push(`TDD=${tddPlanPath}`);
    const artifactContext = artifactFlags.join(', ');

    // Create tasks for each major component
    const taskDescriptions = [
      `Backend service implementation in ${language}: Build complete command handlers, query handlers, and domain logic from DDD bounded contexts. Use SPARC pseudocode for algorithms. Wire aggregates, entities, value objects, and domain events. Target: ${projectDir}/src. Artifacts: ${artifactContext}`,
      `Frontend React+Vite application: Build dashboard with pages per bounded context from DDD model. Include data tables for queries, command forms for commands, API client for backend endpoints. Target: ${projectDir}/ui. Artifacts: ${artifactContext}`,
      `Middleware and integration layer: Build HTTP middleware (auth, CORS, logging, error handling), ERP client adapters, database connection pooling, and integration modules. Follow ADR decisions. Target: ${projectDir}/src. Artifacts: ${artifactContext}`,
      `SQL schema and database layer: Generate CREATE TABLE statements for each aggregate root, indexes, foreign keys, and seed data. Support the ERP system detected in SPARC spec. Target: ${projectDir}/sql. Artifacts: ${artifactContext}`,
      `Test suite from TDD plan: Implement unit tests, integration tests, and e2e tests following the TDD plan. Mock contracts per seam definition. Target: ${projectDir}/tests. Artifacts: ${artifactContext}`,
    ];

    const createdTasks: string[] = [];
    for (const desc of taskDescriptions) {
      try {
        const taskOutput = rufloExec(rufloCheck.binary, [
          'task', 'create',
          '--type', 'implementation',
          '--description', desc,
        ], projectDir, CHECK_TIMEOUT);

        const taskIdMatch = taskOutput.match(/(?:task|id)[:\s]+([a-f0-9-]+)/i);
        if (taskIdMatch?.[1]) createdTasks.push(taskIdMatch[1]);
      } catch {
        // Task creation failures are logged but don't stop the pipeline
      }
    }

    console.error(`  [RUFLO] Created ${createdTasks.length} implementation tasks`);

    // ---- Step 3: Start the swarm with full objective ----
    console.error('  [RUFLO] Step 3: Starting coding swarm...');
    const objective = `Build a complete ${language} prototype for: ${scenario}. ` +
      `Generate frontend (React+Vite+Tailwind), backend (domain handlers + HTTP server), ` +
      `middleware (auth, CORS, error handling), SQL schemas, and tests. ` +
      `Use SPARC specification for architecture, ADRs for decisions, DDD model for domain structure, TDD plan for test strategy. ` +
      `Artifact paths: ${artifactContext}. Target directory: ${projectDir}`;

    let swarmStarted = false;
    try {
      rufloExec(rufloCheck.binary, [
        'swarm', 'start',
        '-o', objective,
        '-s', 'development',
      ], projectDir, SWARM_TIMEOUT);
      swarmStarted = true;
      console.error('  [RUFLO] Coding swarm completed');
    } catch (err) {
      // Swarm start may time out or fail — log but continue
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  [RUFLO] Swarm execution note: ${msg.slice(0, 200)}`);
      // Even if swarm "fails", ruflo may have created files
    }

    // ---- Count files after swarm ----
    const filesAfter = countFiles(projectDir);
    const filesModified = Math.max(0, filesAfter - filesBefore);

    const rufloResult: RufloResult = {
      exitCode: swarmStarted ? 0 : 1,
      stdout: `Swarm ${swarmId}: ${createdTasks.length} tasks, ${filesModified} new files`,
      stderr: '',
      version: rufloCheck.version,
      filesModified,
      timingMs: Date.now() - startTime,
    };

    const timing = Date.now() - startTime;

    const completedSpan = endSpan(span, 'ok', {
      rufloVersion: rufloCheck.version,
      swarmId,
      tasksCreated: createdTasks.length,
      filesModified,
      swarmStarted,
      timingMs: timing,
    });
    emitSpan(completedSpan);
    context.telemetrySpans.push(completedSpan);

    return {
      stage: 'ruflo-execution',
      status: 'completed',
      data: rufloResult,
      artifacts: [],
      timing,
      summary: `Ruflo ${rufloCheck.version} swarm: ${createdTasks.length} tasks dispatched, ${filesModified} files generated in ${timing}ms.`,
    };
  } catch (err: unknown) {
    const timing = Date.now() - startTime;
    const message = err instanceof Error ? err.message : String(err);

    const errorSpan = endSpan(span, 'error', { error: message });
    emitSpan(errorSpan);
    context.telemetrySpans.push(errorSpan);

    return {
      stage: 'ruflo-execution',
      status: 'failed',
      data: { error: `ECLI-P3-003: ${message}` },
      artifacts: [],
      timing,
      summary: `Ruflo execution failed: ${message}`,
    };
  }
}
