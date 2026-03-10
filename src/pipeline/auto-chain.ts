/**
 * Auto-Chain Pipeline Orchestrator
 *
 * Automatically chains Phases 2-6 after enterprise simulation (Phase 1).
 * Each phase reads artifacts from prior phases in ~/.agentics/runs/<traceId>/.
 *
 * This replaces the old executePipeline() which used weak generic stages.
 * The auto-chain calls the actual phase coordinators (phase2 through phase6)
 * that produce high-fidelity artifacts:
 *   Phase 2: Deep Research (research dossier from Phase 1 documents)
 *   Phase 3: SPARC + London TDD (specification, pseudocode, architecture, refinement, completion + test plan)
 *   Phase 4: ADRs + DDDs (architecture decision records + domain-driven design models)
 *   Phase 5: Build (code generation + deployable service from ADRs/DDDs)
 *   Phase 6: ERP Surface Push (registration + project materialization)
 */

import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { executePhase2Command, formatPhase2ForDisplay } from '../commands/phase2.js';
import { executePhase3Command, formatPhase3ForDisplay } from '../commands/phase3.js';
import { executePhase4Command, formatPhase4ForDisplay } from '../commands/phase4.js';
import { executePhase5Command, formatPhase5ForDisplay } from '../commands/phase5.js';
import { executePhase6Command, formatPhase6ForDisplay, copyTreeForOutput } from '../commands/phase6.js';
import {
  detectExecutionMode,
  validateCleanWorkingTree,
  generateScenarioBranchName,
  createScenarioBranch,
  commitScenarioFiles,
  checkoutBranch,
  type ExecutionMode,
  type ExecutionContext,
} from './execution-context.js';
import {
  initSwarm,
  dispatchPhaseAgents,
  storePhaseArtifacts,
  reviewPhaseOutput,
  recordPhaseFailure,
  shutdownSwarm,
  invokeRufloCodingSwarm,
  PHASE_AGENTS,
  type AgenticsServiceResult,
} from './swarm-orchestrator.js';
import {
  executeRufloPhaseSwarm,
  buildPhase2Tasks,
  buildPhase3Tasks,
  buildPhase4Tasks,
  buildPhase5Tasks,
  buildPhase6Tasks,
  collectPhase2Artifacts,
  collectPhase3Artifacts,
  collectPhase4Artifacts,
  collectPhase5Artifacts,
  collectPhase6Artifacts,
  extractPhase1AgentCode,
} from './ruflo-phase-executor.js';

// ============================================================================
// Types
// ============================================================================

export interface AutoChainOptions {
  readonly verbose?: boolean;
  readonly outputDir?: string;
  readonly executionMode?: ExecutionMode;
}

interface PhaseResult {
  phase: number;
  label: string;
  status: 'completed' | 'failed' | 'skipped';
  timing: number;
  artifacts: string[];
  outputDir: string;
  error?: string;
}

export interface AutoChainResult {
  traceId: string;
  runDir: string;
  phases: PhaseResult[];
  totalTiming: number;
  success: boolean;
  executionMode: ExecutionMode;
  scenarioBranch?: string;
  commitHash?: string;
  githubUrl?: string;
}

/** Extract path strings from any manifest artifact array (objects with .path or plain strings). */
function extractArtifactPaths(artifacts: ReadonlyArray<string | { path: string }>): string[] {
  return artifacts.map(a => typeof a === 'string' ? a : a.path);
}

/**
 * Merge ruflo swarm output from .ruflo-cache/phaseN/ into the phase directory.
 * Ruflo-produced files supplement the template generator output. Markdown files
 * from ruflo are written alongside (not overwriting) template-generated files
 * to ensure agent-produced research and SPARC content is preserved.
 */
function mergeRufloCacheIntoPhase(runDir: string, phaseNum: number): number {
  const cacheDir = path.join(runDir, '.ruflo-cache', `phase${phaseNum}`);
  const phaseDir = path.join(runDir, `phase${phaseNum}`);

  if (!fs.existsSync(cacheDir)) return 0;
  if (!fs.existsSync(phaseDir)) fs.mkdirSync(phaseDir, { recursive: true });

  let merged = 0;

  function copyRecursive(src: string, dest: string): void {
    const entries = fs.readdirSync(src, { withFileTypes: true });
    for (const entry of entries) {
      const srcPath = path.join(src, entry.name);
      const destPath = path.join(dest, entry.name);

      if (entry.isDirectory()) {
        if (!fs.existsSync(destPath)) fs.mkdirSync(destPath, { recursive: true });
        copyRecursive(srcPath, destPath);
      } else {
        // Skip swarm metadata files — they're coordination artifacts, not content
        if (entry.name === 'state.json' && srcPath.includes('.swarm')) continue;
        if (entry.name === 'store.json' && srcPath.includes('.claude-flow')) continue;
        // Ruflo swarm output is PRIMARY when it produces real content.
        // Always overwrite template-generated files so agent output takes priority.
        fs.copyFileSync(srcPath, destPath);
        merged++;
      }
    }
  }

  try {
    copyRecursive(cacheDir, phaseDir);
    if (merged > 0) {
      console.error(`  [MERGE] Copied ${merged} ruflo swarm files into phase${phaseNum}/`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`  [MERGE] Warning: ${msg}`);
  }

  return merged;
}

// ============================================================================
// Main Orchestrator
// ============================================================================

/**
 * Execute the full auto-chain pipeline (Phases 2-6) for a given trace ID.
 *
 * Phase 1 artifacts must already exist at ~/.agentics/runs/<traceId>/.
 * Each subsequent phase reads the prior phase's output from the same run directory.
 */
export async function executeAutoChain(
  traceId: string,
  options: AutoChainOptions = {},
): Promise<AutoChainResult> {
  const pipelineStart = Date.now();
  const homeDir = process.env['HOME'] ?? '/tmp';
  const runDir = path.join(homeDir, '.agentics', 'runs', traceId);
  const phases: PhaseResult[] = [];

  // ── Detect execution mode ──
  const execCtx: ExecutionContext = detectExecutionMode();
  const mode = options.executionMode ?? execCtx.mode;
  let scenarioBranch: string | undefined;
  let originalBranch: string | undefined;
  let scenarioQuery = '';

  // Read scenario query from Phase 1 manifest (needed for branch naming)
  try {
    const manifestPath = path.join(runDir, 'manifest.json');
    if (fs.existsSync(manifestPath)) {
      const raw = fs.readFileSync(manifestPath, 'utf-8');
      const manifest = JSON.parse(raw) as { query?: string };
      scenarioQuery = manifest.query ?? '';
    }
  } catch {
    // Best-effort
  }

  console.error('');
  console.error('='.repeat(72));
  console.error('  ENTERPRISE PROTOTYPE PIPELINE');
  console.error(`  Mode: ${mode === 'development' ? 'DEVELOPMENT (sandbox — no repo mutation)' : 'PROJECT (branch-per-simulation GitOps)'}`);
  console.error('  Auto-chaining Phases 2-6 from simulation artifacts');
  console.error('='.repeat(72));
  console.error('');

  // ── Ensure ruflo is installed before any phase uses it ──
  {
    let rufloAvailable = false;
    try {
      execSync('ruflo --version', { stdio: 'pipe', timeout: 5000 });
      rufloAvailable = true;
    } catch { /* not found */ }
    if (!rufloAvailable) {
      console.error('  Installing ruflo@latest for swarm agent support...');
      try {
        execSync('npm install -g ruflo@latest', { stdio: 'pipe', timeout: 120000 });
        console.error('  ruflo installed successfully.');
      } catch (installErr) {
        const msg = installErr instanceof Error ? installErr.message : String(installErr);
        console.error(`  [WARN] ruflo installation failed: ${msg}. Phases will continue without coding swarm.`);
      }
    }
  }

  // ── Initialize Ruflo swarm orchestration ──
  const swarmActive = initSwarm({
    topology: 'hierarchical',
    maxAgents: 8,
    strategy: 'specialized',
    traceId,
    runDir,
  });
  if (swarmActive) {
    console.error('  Ruflo swarm active — agents will coordinate each phase');
    console.error('');
  }

  // ── Project mode: ensure clean tree and create scenario branch ──
  if (mode === 'project') {
    originalBranch = execCtx.currentBranch ?? 'main';

    // Auto-stash dirty tree so we can create a branch without losing user's work
    let didStash = false;
    try {
      validateCleanWorkingTree();
    } catch {
      console.error('  Working tree has uncommitted changes — auto-stashing...');
      try {
        execSync('git stash push -m "agentics-auto-chain: auto-stash before pipeline"', {
          stdio: 'pipe', timeout: 10000,
        });
        didStash = true;
        console.error('  Stashed successfully. Will restore after pipeline completes.');
      } catch {
        console.error('  [WARN] Could not auto-stash. Proceeding anyway — commit may include extra files.');
      }
    }

    scenarioBranch = generateScenarioBranchName(scenarioQuery || traceId);
    console.error(`  Creating scenario branch: ${scenarioBranch}`);
    console.error(`  Will return to: ${originalBranch}`);
    console.error('');
    createScenarioBranch(scenarioBranch);

    // Store stash flag for later restore
    (globalThis as Record<string, unknown>).__agenticsDidStash = didStash;
  }

  // ── Print Phase 1 artifact summary ──
  printPhase1Summary(runDir, traceId);

  // ── Phase 2: Deep Research ──
  {
    const phaseStart = Date.now();
    const phaseDir = path.join(runDir, 'phase2');
    console.error('');
    console.error('-'.repeat(72));
    console.error('  >> Phase 2: Deep Research');
    console.error('-'.repeat(72));

    if (fs.existsSync(phaseDir)) {
      console.error('  [SKIP] Phase 2 already exists — using existing artifacts');
      phases.push({ phase: 2, label: 'Deep Research', status: 'skipped', timing: 0, artifacts: [], outputDir: phaseDir });
    } else {
      const agentResults = await dispatchPhaseAgents(PHASE_AGENTS[2]!, traceId, runDir, scenarioQuery);

      // Ruflo swarm + agentics agents: write deep research cooperatively
      // Output to .ruflo-cache/ so we don't pre-create phaseDir (append-only guard in executePhaseNCommand)
      const rufloOutputDir = path.join(runDir, '.ruflo-cache', 'phase2');
      const rufloResult = executeRufloPhaseSwarm({
        phase: 2, label: 'Deep Research', scenarioQuery,
        runDir, traceId, outputDir: rufloOutputDir,
        tasks: buildPhase2Tasks(scenarioQuery, collectPhase2Artifacts(runDir)),
        agenticsResults: agentResults,
        priorArtifacts: collectPhase2Artifacts(runDir),
      });
      if (rufloResult.filesModified > 0) {
        console.error(`  [RUFLO-P2] ${rufloResult.filesModified} files generated (swarm+agents) in ${rufloResult.timing}ms`);
      }

      // Persist agent results BEFORE phase command so the research dossier
      // generator can incorporate research-lab/hypothesis and other agent output
      persistAgenticsResults(path.join(runDir, '.pre-phase2'), agentResults);

      try {
        const result = await executePhase2Command({ trace: traceId });
        mergeRufloCacheIntoPhase(runDir, 2);
        const timing = Date.now() - phaseStart;
        const artifactPaths = extractArtifactPaths(result.manifest.artifacts);
        console.error(formatPhase2ForDisplay(result));
        printArtifactLinks(phaseDir, artifactPaths);
        storePhaseArtifacts(PHASE_AGENTS[2]!, traceId, runDir, artifactPaths, timing);
        await reviewPhaseOutput(PHASE_AGENTS[2]!, traceId, runDir);
        persistAgenticsResults(phaseDir, agentResults);
        phases.push({ phase: 2, label: 'Deep Research', status: 'completed', timing, artifacts: artifactPaths, outputDir: phaseDir });
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.error(`  [FAIL] Phase 2 failed: ${errMsg}`);
        recordPhaseFailure(PHASE_AGENTS[2]!, traceId, errMsg);
        phases.push({ phase: 2, label: 'Deep Research', status: 'failed', timing: Date.now() - phaseStart, artifacts: [], outputDir: phaseDir, error: errMsg });
        return buildResult(traceId, runDir, phases, pipelineStart, mode);
      }
    }
  }

  // ── Phase 3: SPARC + London TDD ──
  {
    const phaseStart = Date.now();
    const phaseDir = path.join(runDir, 'phase3');
    console.error('');
    console.error('-'.repeat(72));
    console.error('  >> Phase 3: SPARC + London School TDD');
    console.error('-'.repeat(72));

    if (fs.existsSync(phaseDir)) {
      console.error('  [SKIP] Phase 3 already exists — using existing artifacts');
      phases.push({ phase: 3, label: 'SPARC + London TDD', status: 'skipped', timing: 0, artifacts: [], outputDir: phaseDir });
    } else {
      const agentResults = await dispatchPhaseAgents(PHASE_AGENTS[3]!, traceId, runDir, scenarioQuery);

      // Ruflo swarm + agentics agents: write SPARC specs + TDD plans cooperatively
      const rufloP3Dir = path.join(runDir, '.ruflo-cache', 'phase3');
      const rufloResult = executeRufloPhaseSwarm({
        phase: 3, label: 'SPARC + London TDD', scenarioQuery,
        runDir, traceId, outputDir: rufloP3Dir,
        tasks: buildPhase3Tasks(scenarioQuery, collectPhase3Artifacts(runDir)),
        agenticsResults: agentResults,
        priorArtifacts: collectPhase3Artifacts(runDir),
      });
      if (rufloResult.filesModified > 0) {
        console.error(`  [RUFLO-P3] ${rufloResult.filesModified} files generated (swarm+agents) in ${rufloResult.timing}ms`);
      }

      try {
        const result = await executePhase3Command({ trace: traceId });
        mergeRufloCacheIntoPhase(runDir, 3);
        const timing = Date.now() - phaseStart;
        const artifactPaths = extractArtifactPaths(result.manifest.artifacts);
        console.error(formatPhase3ForDisplay(result));
        printArtifactLinks(phaseDir, artifactPaths);
        storePhaseArtifacts(PHASE_AGENTS[3]!, traceId, runDir, artifactPaths, timing);
        await reviewPhaseOutput(PHASE_AGENTS[3]!, traceId, runDir);
        persistAgenticsResults(phaseDir, agentResults);
        phases.push({ phase: 3, label: 'SPARC + London TDD', status: 'completed', timing, artifacts: artifactPaths, outputDir: phaseDir });
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.error(`  [FAIL] Phase 3 failed: ${errMsg}`);
        recordPhaseFailure(PHASE_AGENTS[3]!, traceId, errMsg);
        phases.push({ phase: 3, label: 'SPARC + London TDD', status: 'failed', timing: Date.now() - phaseStart, artifacts: [], outputDir: phaseDir, error: errMsg });
        return buildResult(traceId, runDir, phases, pipelineStart, mode);
      }
    }
  }

  // ── Phase 4: ADRs + DDDs ──
  {
    const phaseStart = Date.now();
    const phaseDir = path.join(runDir, 'phase4');
    console.error('');
    console.error('-'.repeat(72));
    console.error('  >> Phase 4: Architecture Decision Records + Domain-Driven Design');
    console.error('-'.repeat(72));

    if (fs.existsSync(phaseDir)) {
      console.error('  [SKIP] Phase 4 already exists — using existing artifacts');
      phases.push({ phase: 4, label: 'ADRs + DDDs', status: 'skipped', timing: 0, artifacts: [], outputDir: phaseDir });
    } else {
      const agentResults = await dispatchPhaseAgents(PHASE_AGENTS[4]!, traceId, runDir, scenarioQuery);

      // Ruflo swarm + agentics agents: write ADRs + DDDs cooperatively
      const rufloP4Dir = path.join(runDir, '.ruflo-cache', 'phase4');
      const rufloResult = executeRufloPhaseSwarm({
        phase: 4, label: 'ADRs + DDDs', scenarioQuery,
        runDir, traceId, outputDir: rufloP4Dir,
        tasks: buildPhase4Tasks(scenarioQuery, collectPhase4Artifacts(runDir)),
        agenticsResults: agentResults,
        priorArtifacts: collectPhase4Artifacts(runDir),
      });
      if (rufloResult.filesModified > 0) {
        console.error(`  [RUFLO-P4] ${rufloResult.filesModified} files generated (swarm+agents) in ${rufloResult.timing}ms`);
      }

      try {
        const result = await executePhase4Command({ trace: traceId });
        mergeRufloCacheIntoPhase(runDir, 4);
        const timing = Date.now() - phaseStart;
        const artifactPaths = extractArtifactPaths(result.manifest.artifacts);
        console.error(formatPhase4ForDisplay(result));
        printArtifactLinks(phaseDir, artifactPaths);
        storePhaseArtifacts(PHASE_AGENTS[4]!, traceId, runDir, artifactPaths, timing);
        await reviewPhaseOutput(PHASE_AGENTS[4]!, traceId, runDir);
        persistAgenticsResults(phaseDir, agentResults);
        phases.push({ phase: 4, label: 'ADRs + DDDs', status: 'completed', timing, artifacts: artifactPaths, outputDir: phaseDir });
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.error(`  [FAIL] Phase 4 failed: ${errMsg}`);
        recordPhaseFailure(PHASE_AGENTS[4]!, traceId, errMsg);
        phases.push({ phase: 4, label: 'ADRs + DDDs', status: 'failed', timing: Date.now() - phaseStart, artifacts: [], outputDir: phaseDir, error: errMsg });
        return buildResult(traceId, runDir, phases, pipelineStart, mode);
      }
    }
  }

  // (ruflo already installed at pipeline start — see above)

  // ── Pre-Phase 5: Detect implementation language from prior artifacts ──
  let detectedLanguage = 'typescript';
  try {
    const phase3ManifestPath = path.join(runDir, 'phase3', 'phase3-manifest.json');
    const sparc3Path = path.join(runDir, 'phase3', 'sparc', 'sparc-combined.json');
    if (fs.existsSync(phase3ManifestPath)) {
      const m = JSON.parse(fs.readFileSync(phase3ManifestPath, 'utf-8'));
      if (m.implementation_language) detectedLanguage = m.implementation_language;
    } else if (fs.existsSync(sparc3Path)) {
      const sparc = JSON.parse(fs.readFileSync(sparc3Path, 'utf-8'));
      if (sparc?.architecture?.language) detectedLanguage = sparc.architecture.language;
    }
    // Also check if the user mentioned a language in the scenario query
    const langPatterns: Array<[RegExp, string]> = [
      [/\bpython\b/i, 'python'], [/\bjava\b(?!\s*script)/i, 'java'],
      [/\bc\s*#\b|\bcsharp\b|\b\.net\b/i, 'csharp'], [/\bc\+\+\b|\bcpp\b/i, 'cpp'],
      [/\bgolang\b|\bgo\s+(?:lang|service)\b/i, 'go'], [/\brust\b/i, 'rust'],
      [/\bswift\b/i, 'swift'], [/\bkotlin\b/i, 'kotlin'],
      [/\btypescript\b/i, 'typescript'], [/\bjavascript\b/i, 'javascript'],
      [/\bterraform\b|\bhcl\b/i, 'terraform'], [/\bbash\b|\bshell\s*script\b/i, 'bash'],
    ];
    for (const [re, lang] of langPatterns) {
      if (re.test(scenarioQuery)) { detectedLanguage = lang; break; }
    }
  } catch { /* best-effort language detection */ }

  // ── Phase 5: Build (Code Gen + Deployable Service) ──
  {
    const phaseStart = Date.now();
    const phaseDir = path.join(runDir, 'phase5');
    console.error('');
    console.error('-'.repeat(72));
    console.error(`  >> Phase 5: Build (Code Generation + Deployable Service) [${detectedLanguage}]`);
    console.error('-'.repeat(72));

    if (fs.existsSync(phaseDir)) {
      console.error('  [SKIP] Phase 5 already exists — using existing artifacts');
      phases.push({ phase: 5, label: 'Build', status: 'skipped', timing: 0, artifacts: [], outputDir: phaseDir });
    } else {
      const agentResults = await dispatchPhaseAgents(PHASE_AGENTS[5]!, traceId, runDir, scenarioQuery);

      // Ruflo swarm: build production-ready application in cooperation with agentics agents
      const rufloP5Dir = path.join(runDir, '.ruflo-cache', 'phase5');
      const rufloResult = executeRufloPhaseSwarm({
        phase: 5, label: 'Build (Production Code)', scenarioQuery,
        runDir, traceId, outputDir: rufloP5Dir,
        tasks: buildPhase5Tasks(scenarioQuery, detectedLanguage, collectPhase5Artifacts(runDir)),
        agenticsResults: agentResults,
        priorArtifacts: collectPhase5Artifacts(runDir),
      });
      if (rufloResult.invoked) {
        console.error(`  [RUFLO-P5] ${rufloResult.filesModified} files generated in ${rufloResult.timing}ms`);
      }

      try {
        // Domain code generation — template generators produce the domain-specific structure
        // (bounded contexts, aggregates, events, commands, queries) from SPARC/TDD/ADR/DDD artifacts.
        // Ruflo swarm enhances them when it has an LLM backend.
        const result = await executePhase5Command({ trace: traceId });
        mergeRufloCacheIntoPhase(runDir, 5);
        const timing = Date.now() - phaseStart;
        const artifactPaths = extractArtifactPaths(result.manifest.artifacts);
        console.error(formatPhase5ForDisplay(result));
        printArtifactLinks(phaseDir, artifactPaths);
        storePhaseArtifacts(PHASE_AGENTS[5]!, traceId, runDir, artifactPaths, timing);

        // Ruflo coding swarm: enhance generated code with real business logic
        console.error('');
        console.error('  >> Ruflo Coding Swarm: Enhancing generated MVP...');
        const codingSwarm = invokeRufloCodingSwarm(traceId, runDir);
        if (codingSwarm.invoked) {
          console.error(`  [RUFLO-SWARM] ${codingSwarm.filesModified} files enhanced in ${codingSwarm.timing}ms`);
        }

        // Write agent-produced SDK/CLI code as supplementary artifacts alongside the domain code
        const phase1Code = extractPhase1AgentCode(runDir);
        if (phase1Code.length > 0) {
          const sdkDir = path.join(phaseDir, 'sdk');
          fs.mkdirSync(sdkDir, { recursive: true });
          let written = 0;
          for (const cf of phase1Code) {
            const fullPath = path.join(sdkDir, cf.filePath);
            fs.mkdirSync(path.dirname(fullPath), { recursive: true });
            fs.writeFileSync(fullPath, cf.content, 'utf-8');
            written++;
          }
          if (written > 0) {
            console.error(`  [P5] Wrote ${written} supplementary SDK/CLI files from agentics agents`);
          }
        }

        await reviewPhaseOutput(PHASE_AGENTS[5]!, traceId, runDir);
        persistAgenticsResults(phaseDir, agentResults);
        phases.push({ phase: 5, label: 'Build', status: 'completed', timing, artifacts: artifactPaths, outputDir: phaseDir });
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.error(`  [FAIL] Phase 5 failed: ${errMsg}`);
        recordPhaseFailure(PHASE_AGENTS[5]!, traceId, errMsg);
        phases.push({ phase: 5, label: 'Build', status: 'failed', timing: Date.now() - phaseStart, artifacts: [], outputDir: phaseDir, error: errMsg });
        // Check if phase5-manifest.json exists on disk — if so, allow Phase 6 to attempt degraded mode
        const phase5ManifestPath = path.join(phaseDir, 'phase5-manifest.json');
        if (!fs.existsSync(phase5ManifestPath)) {
          return buildResult(traceId, runDir, phases, pipelineStart, mode);
        }
        console.error('  [INFO] Phase 5 manifest written — Phase 6 will attempt degraded mode.');
      }
    }
  }

  // ── Phase 6: ERP Surface Push ──
  {
    const phaseStart = Date.now();
    const phaseDir = path.join(runDir, 'phase6');
    console.error('');
    console.error('-'.repeat(72));
    console.error('  >> Phase 6: ERP Surface Push + Project Materialization');
    console.error('-'.repeat(72));

    if (fs.existsSync(phaseDir)) {
      console.error('  [SKIP] Phase 6 already exists — using existing artifacts');
      phases.push({ phase: 6, label: 'ERP Surface Push', status: 'skipped', timing: 0, artifacts: [], outputDir: phaseDir });
    } else {
      const agentResults = await dispatchPhaseAgents(PHASE_AGENTS[6]!, traceId, runDir, scenarioQuery);

      // Ruflo swarm + agentics agents: ERP surface push cooperatively
      const rufloP6Dir = path.join(runDir, '.ruflo-cache', 'phase6');
      const rufloResult = executeRufloPhaseSwarm({
        phase: 6, label: 'ERP Surface Push', scenarioQuery,
        runDir, traceId, outputDir: rufloP6Dir,
        tasks: buildPhase6Tasks(scenarioQuery, collectPhase6Artifacts(runDir)),
        agenticsResults: agentResults,
        priorArtifacts: collectPhase6Artifacts(runDir),
      });
      if (rufloResult.filesModified > 0) {
        console.error(`  [RUFLO-P6] ${rufloResult.filesModified} files generated (swarm+agents) in ${rufloResult.timing}ms`);
      }

      try {
        const result = await executePhase6Command({ trace: traceId, outputDir: options.outputDir });
        mergeRufloCacheIntoPhase(runDir, 6);
        const timing = Date.now() - phaseStart;
        const artifactPaths = extractArtifactPaths(result.manifest.artifacts);
        console.error(formatPhase6ForDisplay(result, options.outputDir));
        printArtifactLinks(phaseDir, artifactPaths);
        storePhaseArtifacts(PHASE_AGENTS[6]!, traceId, runDir, artifactPaths, timing);
        persistAgenticsResults(phaseDir, agentResults);
        phases.push({ phase: 6, label: 'ERP Surface Push', status: 'completed', timing, artifacts: artifactPaths, outputDir: phaseDir });
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.error(`  [FAIL] Phase 6 failed: ${errMsg}`);
        recordPhaseFailure(PHASE_AGENTS[6]!, traceId, errMsg);
        phases.push({ phase: 6, label: 'ERP Surface Push', status: 'failed', timing: Date.now() - phaseStart, artifacts: [], outputDir: phaseDir, error: errMsg });
        return buildResult(traceId, runDir, phases, pipelineStart, mode);
      }
    }
  }

  // ── Project mode: materialize to repo root and commit ──
  let commitHash: string | undefined;
  if (mode === 'project' && scenarioBranch) {
    console.error('');
    console.error('-'.repeat(72));
    console.error('  >> Materializing MVP to repository root');
    console.error('-'.repeat(72));

    try {
      // Locate the Phase 6 project output (or Phase 5 fallback)
      const phase6ProjectDir = path.join(runDir, 'phase6', 'project');
      const phase5ProjectDir = path.join(runDir, 'phase5', 'deploy', 'project');
      const sourceDir = fs.existsSync(phase6ProjectDir) ? phase6ProjectDir : phase5ProjectDir;

      if (fs.existsSync(sourceDir) && execCtx.repoRoot) {
        copyTreeForOutput(sourceDir, execCtx.repoRoot);
        console.error(`  Copied project files to: ${execCtx.repoRoot}`);

        commitHash = commitScenarioFiles(scenarioQuery);
        console.error(`  Committed: ${commitHash.slice(0, 8)}`);
      } else {
        console.error('  [WARN] No project directory found to materialize');
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`  [WARN] Materialization failed: ${errMsg}`);
    }

    // Return to original branch
    if (originalBranch) {
      checkoutBranch(originalBranch);
      console.error(`  Returned to branch: ${originalBranch}`);
    }

    // Restore auto-stashed changes if we stashed earlier
    const didStash = (globalThis as Record<string, unknown>).__agenticsDidStash;
    if (didStash) {
      try {
        execSync('git stash pop', { stdio: 'pipe', timeout: 10000 });
        console.error('  Restored auto-stashed changes.');
      } catch {
        console.error('  [WARN] Could not restore stash. Run `git stash pop` manually.');
      }
      (globalThis as Record<string, unknown>).__agenticsDidStash = false;
    }
  }

  // ── Shutdown swarm and persist metrics ──
  const totalTiming = Date.now() - pipelineStart;
  const pipelineSuccess = phases.every(p => p.status === 'completed' || p.status === 'skipped');
  shutdownSwarm(traceId, pipelineSuccess, totalTiming);

  // ── Final Summary ──
  const result = buildResult(traceId, runDir, phases, pipelineStart, mode, scenarioBranch, commitHash, execCtx.remoteUrl);
  printFinalSummary(result);
  return result;
}

// ============================================================================
// Phase 1 Summary
// ============================================================================

function printPhase1Summary(runDir: string, traceId: string): void {
  console.error('  Phase 1: Simulation (completed)');
  console.error(`  Trace ID: ${traceId}`);
  console.error(`  Run dir:  ${runDir}`);
  console.error('');

  const manifestPath = path.join(runDir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    console.error('  [WARN] Phase 1 manifest not found — pipeline may fail');
    return;
  }

  try {
    const raw = fs.readFileSync(manifestPath, 'utf-8');
    const manifest = JSON.parse(raw) as { query?: string; artifacts?: string[]; agents_invoked?: Array<{ domain: string; agent: string; status: string }> };

    if (manifest.query) {
      console.error(`  Query: ${manifest.query}`);
      console.error('');
    }

    console.error('  Phase 1 Artifacts:');
    const phase1Files = manifest.artifacts ?? [];
    for (const f of phase1Files) {
      const fullPath = path.join(runDir, f);
      const exists = fs.existsSync(fullPath);
      const icon = exists ? '[OK]' : '[--]';
      console.error(`    ${icon} ${fullPath}`);
    }

    if (manifest.agents_invoked && manifest.agents_invoked.length > 0) {
      console.error('');
      console.error('  Agents invoked:');
      for (const agent of manifest.agents_invoked) {
        const icon = agent.status === 'success' || agent.status === 'invoked' ? '[OK]' : '[!!]';
        console.error(`    ${icon} ${agent.domain}/${agent.agent}`);
      }
    }
  } catch {
    console.error('  [WARN] Could not parse Phase 1 manifest');
  }
}

// ============================================================================
// Artifact Link Printing
// ============================================================================

function printArtifactLinks(phaseDir: string, artifacts: string[]): void {
  if (artifacts.length === 0) return;

  console.error('');
  console.error('  Artifacts:');
  for (const artifact of artifacts) {
    const fullPath = path.join(phaseDir, artifact);
    if (fs.existsSync(fullPath)) {
      console.error(`    ${fullPath}`);
    } else {
      const nested = findArtifact(phaseDir, artifact);
      if (nested) {
        console.error(`    ${nested}`);
      } else {
        console.error(`    ${fullPath} (not found)`);
      }
    }
  }
}

function findArtifact(baseDir: string, filename: string): string | null {
  if (!fs.existsSync(baseDir)) return null;

  const directPath = path.join(baseDir, filename);
  if (fs.existsSync(directPath)) return directPath;

  try {
    for (const entry of fs.readdirSync(baseDir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        const nested = path.join(baseDir, entry.name, filename);
        if (fs.existsSync(nested)) return nested;

        const subDir = path.join(baseDir, entry.name);
        for (const sub of fs.readdirSync(subDir, { withFileTypes: true })) {
          if (sub.isDirectory()) {
            const deep = path.join(subDir, sub.name, filename);
            if (fs.existsSync(deep)) return deep;
          }
        }
      }
    }
  } catch {
    // Best-effort search
  }

  return null;
}

// ============================================================================
// Final Summary
// ============================================================================

function printFinalSummary(result: AutoChainResult): void {
  console.error('');
  console.error('='.repeat(72));
  console.error('  PIPELINE COMPLETE');
  console.error('='.repeat(72));
  console.error('');
  console.error(`  Trace ID:    ${result.traceId}`);
  console.error(`  Run dir:     ${result.runDir}`);
  console.error(`  Mode:        ${result.executionMode === 'development' ? 'Development (sandbox)' : 'Project (GitOps)'}`);
  console.error(`  Orchestration: Ruflo swarm + Agentics platform agents (hierarchical, specialized)`);
  console.error(`  Duration:    ${(result.totalTiming / 1000).toFixed(1)}s`);
  console.error(`  Success:     ${result.success}`);

  // Project mode: show branch, commit, and GitHub URL
  if (result.executionMode === 'project' && result.scenarioBranch) {
    console.error('');
    console.error('  Scenario Branch:');
    console.error(`    Branch:    ${result.scenarioBranch}`);
    if (result.commitHash) {
      console.error(`    Commit:    ${result.commitHash}`);
    }
    if (result.githubUrl) {
      console.error('');
      console.error(`  View on GitHub:`);
      console.error(`    ${result.githubUrl}`);
    }
  }
  console.error('');

  console.error('  Phase Summary:');
  console.error('  ' + '-'.repeat(60));
  for (const phase of result.phases) {
    const icon = phase.status === 'completed' ? '[OK]' : phase.status === 'skipped' ? '[--]' : '[!!]';
    const timingStr = phase.timing > 0 ? `${(phase.timing / 1000).toFixed(1)}s` : 'cached';
    console.error(`    ${icon} Phase ${phase.phase}: ${phase.label.padEnd(25)} ${timingStr.padStart(8)}  (${phase.artifacts.length} artifacts)`);
  }
  console.error('');

  console.error('  Key Artifact Locations:');
  console.error(`    Phase 1 (Simulation):    ${result.runDir}/`);
  console.error(`      - manifest.json        ${result.runDir}/manifest.json`);
  console.error(`      - executive-summary    ${result.runDir}/executive-summary.md`);
  console.error(`      - decision-memo        ${result.runDir}/decision-memo.md`);
  console.error(`      - roadmap              ${result.runDir}/roadmap.json`);
  console.error(`      - risk-assessment      ${result.runDir}/risk-assessment.json`);
  console.error(`      - scenario             ${result.runDir}/scenario.json`);
  console.error(`    Phase 2 (Deep Research): ${result.runDir}/phase2/`);
  console.error(`    Phase 3 (SPARC + TDD):   ${result.runDir}/phase3/`);
  console.error(`    Phase 4 (ADRs + DDDs):   ${result.runDir}/phase4/`);
  console.error(`    Phase 5 (Build):         ${result.runDir}/phase5/`);
  console.error(`    Phase 6 (ERP Push):      ${result.runDir}/phase6/`);
  console.error('');

  // Mode-specific next steps
  if (result.executionMode === 'project' && result.scenarioBranch) {
    console.error('  Next steps (Project Mode):');
    console.error(`    git checkout ${result.scenarioBranch}`);
    console.error('    npm install');
    console.error('    npm run dev');
    console.error('');
    console.error('  To inspect the generated code:');
    console.error(`    git log ${result.scenarioBranch} --oneline -5`);
    console.error(`    git diff main...${result.scenarioBranch} --stat`);
    if (result.githubUrl) {
      console.error('');
      console.error(`  GitHub: ${result.githubUrl}`);
    }
  } else {
    console.error('  To inspect artifacts:');
    console.error(`    cat ${result.runDir}/executive-summary.md`);
    console.error(`    cat ${result.runDir}/decision-memo.md`);
    console.error(`    ls ${result.runDir}/phase2/`);
    console.error(`    ls ${result.runDir}/phase5/deploy/project/src/`);
  }
  console.error('');

  console.error('  To re-run individual phases:');
  console.error(`    agentics phase2 --trace ${result.traceId}`);
  console.error(`    agentics phase3 --trace ${result.traceId}`);
  console.error(`    agentics phase4 --trace ${result.traceId}`);
  console.error(`    agentics phase5 --trace ${result.traceId}`);
  console.error(`    agentics phase6 --trace ${result.traceId}`);
  console.error('');
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Persist agentics agent results alongside phase artifacts.
 * Writes a JSON file with all agent responses for auditability.
 */
function persistAgenticsResults(phaseDir: string, results: AgenticsServiceResult[]): void {
  if (results.length === 0) return;

  try {
    if (!fs.existsSync(phaseDir)) fs.mkdirSync(phaseDir, { recursive: true });

    const report = {
      timestamp: new Date().toISOString(),
      agentsInvoked: results.length,
      results: results.map(r => ({
        domain: r.domain,
        agent: r.agent,
        role: r.role,
        status: r.status,
        timing: r.timing,
        response: r.response,
      })),
    };

    fs.writeFileSync(
      path.join(phaseDir, 'agentics-agents-report.json'),
      JSON.stringify(report, null, 2),
    );
  } catch {
    // Non-fatal — agent result persistence should never block the pipeline
  }
}

// ============================================================================
// Stdout Display Formatter
// ============================================================================

/**
 * Format the auto-chain result for stdout display.
 * This is the consolidated pipeline summary that surfaces Phase 2-6 details
 * to callers who only see stdout (e.g., Claude Code rendering `agentics ask`).
 */
export function formatAutoChainForDisplay(result: AutoChainResult): string {
  const lines: string[] = [];

  lines.push('');
  lines.push('='.repeat(72));
  lines.push('  ENTERPRISE PROTOTYPE PIPELINE — PHASES 2-6');
  lines.push('='.repeat(72));
  lines.push('');
  lines.push(`  Trace ID:       ${result.traceId}`);
  lines.push(`  Run Directory:  ${result.runDir}`);
  lines.push(`  Mode:           ${result.executionMode === 'development' ? 'Development (sandbox)' : 'Project (GitOps)'}`);
  lines.push(`  Duration:       ${(result.totalTiming / 1000).toFixed(1)}s`);
  lines.push(`  Overall:        ${result.success ? 'SUCCESS' : 'FAILED'}`);
  lines.push('');

  // Phase-by-phase summary
  lines.push('  Phase Results:');
  lines.push('  ' + '-'.repeat(68));
  for (const phase of result.phases) {
    const icon = phase.status === 'completed' ? '[OK]' : phase.status === 'skipped' ? '[--]' : '[!!]';
    const timingStr = phase.timing > 0 ? `${(phase.timing / 1000).toFixed(1)}s` : 'cached';
    lines.push(`    ${icon} Phase ${phase.phase}: ${phase.label.padEnd(30)} ${timingStr.padStart(8)}  (${phase.artifacts.length} artifacts)`);
    if (phase.error) {
      lines.push(`         Error: ${phase.error}`);
    }
  }
  lines.push('');

  // Artifact locations
  const totalArtifacts = result.phases.reduce((sum, p) => sum + p.artifacts.length, 0);
  lines.push(`  Total Artifacts: ${totalArtifacts} files across ${result.phases.length} phases`);
  lines.push('');
  lines.push('  Key Locations:');
  for (const phase of result.phases) {
    if (phase.status !== 'skipped') {
      lines.push(`    Phase ${phase.phase} (${phase.label}): ${phase.outputDir}`);
    }
  }
  lines.push('');

  // Project mode branch info
  if (result.executionMode === 'project' && result.scenarioBranch) {
    lines.push(`  Scenario Branch: ${result.scenarioBranch}`);
    if (result.commitHash) {
      lines.push(`  Commit:          ${result.commitHash}`);
    }
    if (result.githubUrl) {
      lines.push(`  GitHub:          ${result.githubUrl}`);
    }
    lines.push('');
  }

  // Next steps
  lines.push('  To inspect artifacts:');
  lines.push(`    agentics inspect run ${result.traceId}`);
  lines.push('');

  return lines.join('\n');
}

function buildResult(
  traceId: string,
  runDir: string,
  phases: PhaseResult[],
  startTime: number,
  executionMode: ExecutionMode = 'development',
  scenarioBranch?: string,
  commitHash?: string,
  remoteUrl?: string | null,
): AutoChainResult {
  const success = phases.every(p => p.status === 'completed' || p.status === 'skipped');

  // Build GitHub URL if we have a remote and a branch
  let githubUrl: string | undefined;
  if (remoteUrl && scenarioBranch) {
    const match = remoteUrl.match(/github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?$/);
    if (match) {
      githubUrl = `https://github.com/${match[1]}/${match[2]}/tree/${scenarioBranch}`;
    }
  }

  return {
    traceId,
    runDir,
    phases,
    totalTiming: Date.now() - startTime,
    success,
    executionMode,
    scenarioBranch,
    commitHash,
    githubUrl,
  };
}
